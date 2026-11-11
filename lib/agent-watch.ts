import "server-only";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentPolicy, AgentRevisions, AgentTelemetryError } from "./agent-protocol";
import { canonicalStateRoot, checkedPath, configRoot, digest, readPolicy, readPresence, readRegistry, telemetry, type PresenceProjection } from "./agent-projection";

type Listener = (revisions: AgentRevisions) => void;
export interface AgentObserver {
  root: string;
  presence: PresenceProjection;
  policy: AgentPolicy;
  errors: AgentTelemetryError[];
  revisions: AgentRevisions;
  refresh: () => void;
  subscribe: (listener: Listener) => () => void;
  observeHistory: (parts: string[][]) => void;
  pages: Map<string, { revision: string; value: unknown }>;
}
interface Entry { observer: AgentObserver; refs: number; start: () => void; stop: () => void }
const KEY = Symbol.for("scotty.agentWorkspace.observers.v1");
function registry(): Map<string, Entry> {
  const globals = globalThis as unknown as Record<symbol, Map<string, Entry> | undefined>;
  return globals[KEY] ?? (globals[KEY] = new Map());
}

/** All route bundles share this aggregate. Timers reconcile presence/settings only;
 * history recovery emits a signal without loading any message or retained index.
 */
function create(root: string): Entry {
  const epoch = randomUUID();
  let history = 0;
  let lastRefresh = 0;
  let active = false;
  let pendingHistory = false;
  let presenceTimer: ReturnType<typeof setInterval> | undefined;
  let historyTimer: ReturnType<typeof setInterval> | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<Listener>();
  const watchers = new Map<string, fs.FSWatcher>();
  const historyPaths = new Map<string, string[]>();
  let registryRevision = "";
  const observer: AgentObserver = {
    root, presence: { availability: "unavailable", agents: [], errors: [] },
    policy: { autoWake: null, revision: null, error: "Runtime settings have not been read" },
    errors: [], revisions: { presence: "", history: `${epoch}:0`, policy: "" }, pages: new Map(),
    refresh: () => refresh(false),
    subscribe: (listener) => { listeners.add(listener); listener({ ...observer.revisions }); return () => { listeners.delete(listener); }; },
    observeHistory: (parts) => {
      for (const item of parts) {
        const key = item.join("/");
        historyPaths.delete(key); historyPaths.set(key, item);
      }
      while (historyPaths.size > 256) historyPaths.delete(historyPaths.keys().next().value!);
      if (active) syncWatches();
    },
  };
  function notify() { for (const listener of listeners) listener({ ...observer.revisions }); }
  function changedHistory() {
    history += 1; observer.revisions.history = `${epoch}:${history}`;
    observer.pages.clear(); notify();
  }
  function hint(filename: string | Buffer | null, kind: "presence" | "history" | "config" | "root") {
    const name = filename === null ? null : String(filename);
    // Atomic-write temporaries and producer locks are not committed history.
    if (name?.startsWith(".tmp-") || (kind === "root" && name?.startsWith(".") && name.endsWith(".lock"))) return;
    if (kind === "history" || (kind === "root" && (!filename || !["presence", "installation.json"].includes(String(filename))))) pendingHistory = true;
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      if (pendingHistory) { pendingHistory = false; changedHistory(); }
      refresh(true);
    }, 150);
  }
  function syncWatches() {
    if (!active) return;
    const wanted = new Map<string, { root: string; parts: string[]; kind: "presence" | "history" | "config" | "root" }>();
    function add(base: string, parts: string[], kind: "presence" | "history" | "config" | "root") {
      wanted.set(path.join(base, ...parts), { root: base, parts, kind });
    }
    // Watch existing ancestors as well, so an initially absent state/settings
    // directory can recover. Polling remains the backstop for missed hints.
    add(path.dirname(root), [], "root");
    add(root, [], "root"); add(root, ["presence"], "presence");
    add(root, ["messages"], "history"); add(root, ["receipts"], "history"); add(root, ["processing"], "history");
    const now = new Date().toISOString();
    add(root, ["messages", now.slice(0, 10)], "history");
    add(root, ["messages", now.slice(0, 10), now.slice(11, 13)], "history");
    const problems = new Map<string, AgentTelemetryError>();
    const problem = (error: AgentTelemetryError) => { problems.set(`${error.source}:${error.code}`, error); };
    try {
      const config = configRoot();
      add(config, [], "config"); add(config, ["pi-quality-runtime"], "config"); add(config, ["bead-me-up-scotty"], "config");
    } catch (error) { problem(telemetry("state", error)); }
    // Reserve live watch capacity for current instances before retained history.
    // Ended/stale snapshots are still read by the 10-second presence poll. Watching
    // the presence parent discovers new agent directories without watching all old ones.
    const timestamp = Date.now();
    for (const agent of observer.presence.agents) {
      if (agent.liveness !== "ended" && Math.abs(timestamp - Date.parse(agent.observedAt)) <= 45_000) add(root, ["presence", agent.agentId], "presence");
    }
    for (const parts of [...historyPaths.values()].reverse()) add(root, parts, "history");
    const selected = new Map<string, { safe: string; kind: "presence" | "history" | "config" | "root" }>();
    for (const [name, spec] of wanted) {
      try {
        const safe = checkedPath(spec.root, spec.parts);
        if (!fs.lstatSync(safe).isDirectory()) continue;
        if (selected.size >= 512) {
          problem({ source: "state", code: "watch_limit", message: "Live watch capacity reached; presence polling every 10 seconds and history recovery every 60 seconds remain active" });
          break;
        }
        selected.set(name, { safe, kind: spec.kind });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") problem(telemetry("state", error));
      }
    }
    // Reconcile the selected set before allocating: old low-priority watches must
    // not keep a newly current agent from obtaining a slot.
    for (const [name, watcher] of watchers) { if (!selected.has(name)) { watcher.close(); watchers.delete(name); } }
    for (const [name, spec] of selected) {
      if (watchers.has(name)) continue;
      try {
        const watcher = fs.watch(spec.safe, { persistent: false, recursive: false }, (_event, filename) => hint(filename, spec.kind));
        watcher.on("error", () => {
          watcher.close(); watchers.delete(name);
          changedHistory(); refresh(true);
        });
        watchers.set(name, watcher);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        problem({ source: "state", code: "watch_unavailable", message: "An agent filesystem watch could not be established; periodic presence and history refresh remain active" });
      }
    }
    // Diagnostics describe this reconciliation, not any past transient failure.
    observer.errors = [...problems.values()];
  }
  function refresh(force: boolean) {
    if (!force && Date.now() - lastRefresh < 1000) return;
    lastRefresh = Date.now();
    const old = { ...observer.revisions };
    observer.presence = readPresence(root);
    observer.policy = readPolicy();
    observer.revisions.presence = digest(observer.presence);
    observer.revisions.policy = digest(observer.policy);
    try {
      const current = readRegistry().revision;
      if (current !== registryRevision) {
        registryRevision = current;
        observer.revisions.presence = digest([observer.presence, current]);
        history += 1; observer.revisions.history = `${epoch}:${history}`; observer.pages.clear();
      } else { observer.revisions.presence = digest([observer.presence, current]); }
    } catch (error) {
      const problem = telemetry("registry", error);
      observer.revisions.presence = digest([observer.presence, problem]);
    }
    if (active) syncWatches();
    // Freshness can cross the stale boundary even without a new snapshot.
    const freshness = observer.presence.agents.map((agent) => Math.floor((Date.now() - Date.parse(agent.observedAt)) / 45_000) > 0 ? "stale" : Date.parse(agent.observedAt) > Date.now() + 45_000 ? "unknown" : "fresh");
    observer.revisions.presence = digest([observer.revisions.presence, observer.errors, freshness]);
    if (old.presence !== observer.revisions.presence || old.policy !== observer.revisions.policy || old.history !== observer.revisions.history) notify();
  }
  return {
    observer, refs: 0,
    start: () => {
      if (active) return;
      active = true;
      // A zero-reference interval was not observed. Force history recovery on
      // reacquisition instead of claiming unchanged mail from the old cache.
      history += 1; observer.revisions.history = `${epoch}:${history}`;
      refresh(true);
      presenceTimer = setInterval(() => refresh(true), 10_000);
      // Independent from heartbeats: repair dropped history/receipt hints without
      // scanning pending mail, hourly indexes, message bodies or Beads data.
      historyTimer = setInterval(() => { changedHistory(); syncWatches(); }, 60_000);
      presenceTimer.unref(); historyTimer.unref();
    },
    stop: () => {
      active = false; pendingHistory = false; clearInterval(presenceTimer); clearInterval(historyTimer); clearTimeout(debounce);
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear(); historyPaths.clear(); listeners.clear(); observer.pages.clear();
    },
  };
}

export function acquireAgentObserver(): { observer: AgentObserver; release: () => void } {
  const root = canonicalStateRoot();
  const entries = registry();
  let entry = entries.get(root);
  if (!entry) { entry = create(root); entries.set(root, entry); }
  entry.refs += 1;
  if (entry.refs === 1) entry.start(); else entry.observer.refresh();
  let released = false;
  return { observer: entry.observer, release: () => {
    if (released) return;
    released = true; entry.refs -= 1;
    if (!entry.refs) {
      entry.stop();
      // Keep a bounded number of inert canonical-root cache objects across short
      // API requests; no watcher/timer survives the last reference.
      if (entries.size > 8) entries.delete(root);
    }
  } };
}

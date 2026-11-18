import "server-only";
import fs from "node:fs";
import path from "node:path";
import type { Bead } from "./schema";
import { originOf, type Origin } from "./attribution";

/**
 * Reader for beads' append-only interaction log
 * (`<repo>/.beads/interactions.jsonl`) plus helpers that turn it — together with
 * the bead list — into a human-readable activity feed.
 *
 * The SSE stream (app/api/p/[projectId]/beads/stream) is signal-only, so feeds
 * are built by re-reading this log on each change ping. Shared by the activity
 * feed (Mission Control), Insights, and Gamification beads.
 */

export interface RawInteraction {
  id?: string;
  kind?: string;
  created_at?: string;
  actor?: string;
  issue_id?: string;
  extra?: { field?: string; old_value?: string; new_value?: string };
}

export interface ActivityItem {
  id: string;
  issueId: string;
  title: string;
  actor: string;
  origin: Origin;
  /** Verb phrase, e.g. "closed", "claimed · In Progress", "commented". */
  action: string;
  /** Optional secondary text (comment snippet, priority label). */
  detail?: string;
  at: string;
}

/** Read & parse the interactions log. Missing/unreadable file → []. */
export function readInteractions(repoPath: string): RawInteraction[] {
  const file = path.join(repoPath, ".beads", "interactions.jsonl");
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: RawInteraction[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as RawInteraction);
    } catch {
      /* skip a malformed line rather than failing the whole feed */
    }
  }
  return out;
}

/**
 * Dashboard source re-resolution must distinguish an absent optional log from
 * an unreadable or corrupt one. Keep the permissive reader above unchanged for
 * existing Activity, Insights, and Gamification callers.
 */
export function readInteractionsStrict(repoPath: string): RawInteraction[] {
  const file = path.join(repoPath, ".beads", "interactions.jsonl");
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  try {
    const stat = fs.fstatSync(fd);
    const maxBytes = 32 * 1024 * 1024;
    if (!stat.isFile() || stat.size > maxBytes || stat.nlink !== 1) throw new Error("Invalid Beads interaction log file");
    const chunks: Buffer[] = [];
    const chunk = Buffer.alloc(64 * 1024);
    let length = 0;
    for (;;) {
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      length += count;
      if (length > maxBytes) throw new Error("Beads interaction log exceeds its read limit");
      chunks.push(Buffer.from(chunk.subarray(0, count)));
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, length));
    const out: RawInteraction[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const value: unknown = JSON.parse(trimmed);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Beads interaction record");
      const record = value as Record<string, unknown>;
      for (const key of ["id", "kind", "created_at", "actor", "issue_id"]) {
        if (record[key] !== undefined && record[key] !== null && typeof record[key] !== "string") throw new Error("Invalid Beads interaction field");
      }
      if (record.extra !== undefined && record.extra !== null && (typeof record.extra !== "object" || Array.isArray(record.extra))) throw new Error("Invalid Beads interaction change");
      if (record.extra && typeof record.extra === "object") {
        const extra = record.extra as Record<string, unknown>;
        for (const key of ["field", "old_value", "new_value"]) {
          if (extra[key] !== undefined && extra[key] !== null && !["string", "number", "boolean"].includes(typeof extra[key])) throw new Error("Invalid Beads interaction change field");
        }
      }
      out.push(record as RawInteraction);
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

const PRIORITY_LABELS = ["Critical", "High", "Medium", "Low", "Backlog"];

function statusAction(v?: string): string {
  switch (v) {
    case "in_progress":
      return "claimed · In Progress";
    case "closed":
      return "closed";
    case "blocked":
      return "marked Blocked";
    case "deferred":
      return "moved to Backlog";
    case "open":
      return "moved to Ready";
    default:
      return `set status → ${v ?? "?"}`;
  }
}

function mapFieldChange(ev: RawInteraction, title: string, origin: Origin): ActivityItem | null {
  const field = ev.extra?.field;
  let action: string;
  let detail: string | undefined;
  if (field === "status") {
    action = statusAction(ev.extra?.new_value);
  } else if (field === "priority") {
    const p = Number(ev.extra?.new_value);
    action = `changed priority → P${Number.isFinite(p) ? p : "?"}`;
    if (Number.isFinite(p) && PRIORITY_LABELS[p]) detail = PRIORITY_LABELS[p];
  } else if (field) {
    action = `updated ${field}`;
  } else {
    return null;
  }
  return {
    id: ev.id ?? `${ev.issue_id}-${ev.created_at}`,
    issueId: ev.issue_id ?? "",
    title,
    actor: ev.actor ?? "unknown",
    origin,
    action,
    detail,
    at: ev.created_at ?? "",
  };
}

/**
 * Build a newest-first activity feed. Status/priority transitions come from
 * interactions.jsonl; creations and comments come from the beads themselves
 * (the log does not record them). When there are no interaction events (e.g.
 * the demo project), status changes are synthesized from bead timestamps so the
 * feed is not empty.
 */
export function buildActivity(
  beads: Bead[],
  events: RawInteraction[],
  humanAllowlist: string[],
): ActivityItem[] {
  const byId = new Map(beads.map((b) => [b.id, b]));
  const items: ActivityItem[] = [];

  // 1. Transitions from the interaction log (field_change only).
  for (const ev of events) {
    if (ev.kind !== "field_change" || !ev.issue_id) continue;
    const b = byId.get(ev.issue_id);
    const item = mapFieldChange(ev, b?.title ?? ev.issue_id, originOf(ev.actor, humanAllowlist));
    if (item) items.push(item);
  }
  const hasEvents = items.length > 0;

  // 2. Creations + comments from the beads (+ closes when we have no log).
  for (const b of beads) {
    if (b.created_at) {
      items.push({
        id: `${b.id}-created`,
        issueId: b.id,
        title: b.title,
        actor: b.created_by || "unknown",
        origin: originOf(b.created_by, humanAllowlist),
        action: "created",
        at: b.created_at,
      });
    }
    (b.comments ?? []).forEach((c, i) => {
      if (!c.created_at) return;
      items.push({
        id: `${b.id}-comment-${i}`,
        issueId: b.id,
        title: b.title,
        actor: c.author || "unknown",
        origin: originOf(c.author, humanAllowlist),
        action: "commented",
        detail: c.text?.slice(0, 120),
        at: c.created_at,
      });
    });
    if (!hasEvents && b.closed_at) {
      items.push({
        id: `${b.id}-closed`,
        issueId: b.id,
        title: b.title,
        actor: b.assignee || b.created_by || "unknown",
        origin: originOf(b.assignee || b.created_by, humanAllowlist),
        action: "closed",
        at: b.closed_at,
      });
    }
  }

  // newest first
  items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return items;
}

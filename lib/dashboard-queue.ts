import "server-only";
import { spawn } from "node:child_process";
import path from "node:path";

export type DashboardQueuePriority = "retry" | "visible" | "prefetch";
export type DashboardQueueState =
  | "waiting"
  | "running"
  | "retrying"
  | "blocked"
  | "done"
  | "obsolete"
  | "failed"
  | "not_accepted";
export type DashboardQueueScope = "shared" | "route";
export type DashboardQueueEffort = "low" | "medium" | "high" | "xhigh";

export interface DashboardQueueSettings {
  /** One or two distinct chat model IDs, sorted by the caller. */
  providers: [string] | [string, string];
  reasoningEffort: DashboardQueueEffort;
  prompt: string;
}
export interface DashboardQueueRef { id: string; key: string }
export interface DashboardQueueEntry {
  id: string;
  ref: DashboardQueueRef;
  settings: DashboardQueueSettings;
  priority: DashboardQueuePriority;
}
export interface DashboardQueueItem {
  id: string;
  state: DashboardQueueState;
  reason?: string;
  retryAt?: number;
  text?: string;
  route?: string;
  model?: string;
  scope?: DashboardQueueScope;
  replayable?: boolean;
}
export interface DashboardQueueClaim {
  token: string;
  route: string;
  deadlineAt: number;
  items: Array<{ id: string; ref: DashboardQueueRef; settings: DashboardQueueSettings }>;
}
export type DashboardQueueOutcomeKind =
  | "result"
  | "obsolete"
  | "source_retry"
  | "malformed"
  | "split"
  | "invalid"
  | "route_transient"
  | "route_blocked"
  | "shared_transient"
  | "shared_blocked";
export interface DashboardQueueOutcome {
  id: string;
  kind: DashboardQueueOutcomeKind;
  reason?: string;
  text?: string;
  model?: string;
  retryAfterMs?: number;
}

export interface DashboardQueueInputs {
  admit: { entries: DashboardQueueEntry[]; replayIds?: string[] };
  status: { ids: string[] };
  invite: Record<string, never>;
  claim: { invitation: string };
  resolve: { token: string };
  complete: { token: string; outcomes: DashboardQueueOutcome[] };
  recheck: { scope: "shared" } | { scope: "route"; route: string };
}
export interface DashboardQueueResults {
  admit: { items: DashboardQueueItem[] };
  status: { items: DashboardQueueItem[] };
  invite: { invitations: string[] };
  claim: { claim: DashboardQueueClaim | null };
  resolve: { claim: DashboardQueueClaim | null };
  complete: { status: "committed" | "stale" };
  recheck: { ok: true };
}
export type DashboardQueueAction = keyof DashboardQueueInputs;

const MAX_REQUEST_BYTES = 1_048_576;
const MAX_ADMIT_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8_388_608;
const PROCESS_TIMEOUT_MS = 15_000;

export class DashboardQueueError extends Error {
  constructor(public readonly code: "invalid_request" | "queue_unavailable" | "invalid_response" | "timeout") {
    super(`Dashboard queue ${code.replaceAll("_", " ")}`);
    this.name = "DashboardQueueError";
  }
}

function queueEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH || "/usr/bin:/bin",
    NODE_ENV: process.env.NODE_ENV || "production",
    HOME: process.env.HOME || undefined,
    LANG: process.env.LANG || "C.UTF-8",
  };
  for (const name of ["XDG_STATE_HOME", "BMUS_DASHBOARD_QUEUE_STATE_DIR"] as const) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

async function invoke(action: string, input: unknown): Promise<unknown> {
  let body: string;
  try {
    const serialized = JSON.stringify({ action, input });
    if (typeof serialized !== "string") throw new Error();
    body = serialized;
  } catch { throw new DashboardQueueError("invalid_request"); }
  const requestLimit = action === "admit" ? MAX_ADMIT_REQUEST_BYTES : MAX_REQUEST_BYTES;
  if (Buffer.byteLength(body, "utf8") > requestLimit) throw new DashboardQueueError("invalid_request");

  const script = path.resolve(process.cwd(), "scripts", "dashboard-queue.py");
  return await new Promise((resolve, reject) => {
    const child = spawn("python3", [script], {
      cwd: process.cwd(),
      env: queueEnvironment(),
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });

    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (error?: DashboardQueueError, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new DashboardQueueError("timeout"));
    }, PROCESS_TIMEOUT_MS);
    timer.unref();

    child.stdout.on("data", (chunk: Buffer | string) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += data.length;
      if (outputBytes > MAX_RESPONSE_BYTES) {
        child.kill("SIGKILL");
        finish(new DashboardQueueError("invalid_response"));
        return;
      }
      chunks.push(data);
    });
    child.on("error", () => finish(new DashboardQueueError("queue_unavailable")));
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(new DashboardQueueError("queue_unavailable"));
        return;
      }
      try {
        const response = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { error?: unknown };
        if (response && typeof response === "object" && typeof response.error === "string") {
          finish(new DashboardQueueError(response.error === "invalid_request" ? "invalid_request" : "queue_unavailable"));
          return;
        }
        finish(undefined, response);
      } catch {
        finish(new DashboardQueueError("invalid_response"));
      }
    });
    child.stdin.on("error", () => {
      if (!settled) child.kill("SIGKILL");
    });
    child.stdin.end(body);
  });
}

/**
 * Run one bounded SQLite queue operation. The worker script is shipped as
 * `scripts/dashboard-queue.py`; persistent state defaults to
 * `$XDG_STATE_HOME/bead-me-up-scotty` (or `~/.local/state/...`). Set
 * `BMUS_DASHBOARD_QUEUE_STATE_DIR` to an absolute state base directory to
 * override it; the queue uses that directory's `bead-me-up-scotty` child.
 * Python 3 with stdlib sqlite3 is required at runtime.
 */
export function dashboardQueue<A extends DashboardQueueAction>(
  action: A,
  input: DashboardQueueInputs[A],
): Promise<DashboardQueueResults[A]>;
export function dashboardQueue<T>(action: string, input: unknown): Promise<T>;
export async function dashboardQueue<T>(action: string, input: unknown): Promise<T> {
  return await invoke(action, input) as T;
}

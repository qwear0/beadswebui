import "server-only";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { dashboardQueue } from "./dashboard-queue";
import type { DashboardSettings } from "./dashboard-types";
import { digest as projectDigest } from "./agent-projection";

export interface DashboardExecutorSettings {
  providers: string[];
  reasoningEffort: DashboardSettings["reasoningEffort"];
  prompt: string;
}

/** Canonical logical settings: provider order never chooses a queue identity. */
export function dashboardExecutorSettings(settings: DashboardSettings): DashboardExecutorSettings {
  const providers = [...new Set([settings.model, settings.peerModel].filter((model): model is string => typeof model === "string" && model.length > 0))].sort();
  return { providers, reasoningEffort: settings.reasoningEffort, prompt: settings.prompt };
}

/** v3 separates durable executor work from the legacy per-model cache digest. */
export function dashboardGenerationDigest(key: string, settings: DashboardExecutorSettings): string {
  return projectDigest({ version: 3, key, settings });
}

async function readWorkerToken(): Promise<string | null> {
  const envToken = process.env.SCOTTY_DASHBOARD_WORKER_TOKEN?.trim();
  if (envToken) return envToken.length <= 4096 ? envToken : null;
  const file = process.env.SCOTTY_DASHBOARD_WORKER_TOKEN_FILE;
  if (!file) return null;
  let handle: FileHandle | undefined;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > 4096) return null;
    const bytes = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 4096) return null;
    const token = bytes.subarray(0, bytesRead).toString("utf8").trim();
    return token.length > 0 && token.length <= 4096 ? token : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Resolve credentials afresh so rotation takes effect without a process restart. */
export function dashboardWorkerToken(): Promise<string | null> {
  return readWorkerToken();
}

export async function dashboardWorkerAdmissionEnabled(): Promise<boolean> {
  if (process.env.SCOTTY_DASHBOARD_DURABLE_ADMISSION !== "1") return false;
  return (await dashboardWorkerToken()) !== null;
}

export async function authorizeDashboardWorker(request: Request): Promise<"ok" | "unconfigured" | "unauthorized"> {
  const expected = await dashboardWorkerToken();
  if (!expected) return "unconfigured";
  const match = /^Bearer ([^\s]{1,4096})$/.exec(request.headers.get("authorization") ?? "");
  if (!match) return "unauthorized";
  const supplied = Buffer.from(match[1], "utf8");
  const configured = Buffer.from(expected, "utf8");
  if (supplied.length !== configured.length || !timingSafeEqual(supplied, configured)) return "unauthorized";
  return "ok";
}

export async function callDashboardQueue<T>(action: string, input: unknown): Promise<T> {
  return dashboardQueue<T>(action, input);
}

import "server-only";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { digest as digestLegacy } from "./agent-projection";
import { summarySources, DashboardSourceError } from "./dashboard-activity";
import { getDashboardSettings } from "./dashboard-settings";
import { DashboardQueueError } from "./dashboard-queue";
import type { DashboardEventRef, DashboardSettings } from "./dashboard-types";
import {
  callDashboardQueue,
  dashboardExecutorSettings,
  dashboardGenerationDigest,
  dashboardWorkerAdmissionEnabled,
  type DashboardExecutorSettings,
} from "./dashboard-worker";

const SHA256 = /^[a-f0-9]{64}$/;
const PROJECT = /^[a-z0-9][a-z0-9-]{0,127}$/;
const MESSAGE = /^msg_[0-9]{13}_[a-f0-9]{32}$/;
const eventId = new RegExp(`^(?:${MESSAGE.source.slice(1, -1)}|${PROJECT.source.slice(1, -1)}\\/[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,895})$`);
const refSchema = z.object({ id: z.string().min(1).max(1024).regex(eventId), key: z.string().regex(SHA256) }).strict();
const statusRefList = z.array(refSchema.extend({ generation: z.string().regex(SHA256).optional() })).min(1).max(40);
const browserRequestSchema = z.union([
  z.object({
    action: z.literal("admit"), entries: z.array(z.object({ ref: refSchema, priority: z.enum(["retry", "visible", "prefetch"]) }).strict()).min(1).max(40), replay: z.boolean().optional(),
  }).strict(),
  z.object({ action: z.literal("status"), refs: statusRefList }).strict(),
  z.object({ action: z.literal("recheck"), scope: z.literal("shared") }).strict(),
  z.object({ action: z.literal("recheck"), scope: z.literal("route"), route: z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:/-]+$/) }).strict(),
]);

const safeCode = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/);
const providerSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:/-]+$/);
const retainedSettingsSchema = z.object({
  providers: z.array(providerSchema).min(1).max(2),
  reasoningEffort: z.enum(["low", "medium", "high", "xhigh"]),
  prompt: z.string().min(20).max(16000),
}).strict();
const queueItemSchema = z.object({
  id: z.string().regex(SHA256).optional(),
  state: z.enum(["waiting", "running", "retrying", "blocked", "done", "obsolete", "failed", "not_accepted"]),
  reason: safeCode.optional(),
  retryAt: z.number().int().nonnegative().optional(),
  text: z.string().min(1).max(16384).refine(text => text.trim().length > 0 && !text.includes("\0")).optional(),
  route: providerSchema.optional(),
  model: providerSchema.optional(),
  scope: z.enum(["shared", "route"]).optional(),
  replayable: z.boolean().optional(),
}).strict();
type QueueItem = z.infer<typeof queueItemSchema>;
const queueItemsSchema = z.object({ items: z.array(queueItemSchema).max(40) }).strict();
const statusItemsSchema = z.object({ items: z.array(queueItemSchema.extend({
  requestId: z.string().regex(SHA256).optional(),
  retainedSettings: retainedSettingsSchema.optional(),
})).max(40) }).strict();

export class DashboardSummaryUnavailable extends Error {
  constructor() { super("Dashboard summary service is temporarily unavailable"); this.name = "DashboardSummaryUnavailable"; }
}

export type DashboardSummaryActionResult = { items: Record<string, QueueItem>; status: 200 | 202 } | { ok: true; status: 200 };

function uniqueRefs(refs: DashboardEventRef[]): DashboardEventRef[] {
  const pairs = new Map<string, DashboardEventRef>();
  const byKey = new Map<string, string>();
  for (const ref of refs) {
    const previousId = byKey.get(ref.key);
    if (previousId !== undefined && previousId !== ref.id) throw new z.ZodError([]);
    byKey.set(ref.key, ref.id);
    pairs.set(`${ref.key}\n${ref.id}`, ref);
  }
  return [...pairs.values()];
}

function parseQueueItems(value: unknown): QueueItem[] {
  const parsed = queueItemsSchema.safeParse(value);
  if (!parsed.success) throw new DashboardSummaryUnavailable();
  return parsed.data.items;
}

/** Associate queue results by durable ID; positional id-less refusals are bound to their submitted entry. */
function associateQueueItems(items: QueueItem[], ids: string[], allowMissing: boolean): Map<string, QueueItem> {
  const result = new Map<string, QueueItem>();
  const unresolved = new Set(ids);
  for (const [index, item] of items.entries()) {
    let id = item.id;
    if (id) {
      if (!unresolved.has(id)) throw new DashboardSummaryUnavailable();
    } else {
      if (items.length !== ids.length) throw new DashboardSummaryUnavailable();
      id = ids[index];
      if (!id || !unresolved.has(id)) throw new DashboardSummaryUnavailable();
    }
    unresolved.delete(id);
    result.set(id, item);
  }
  if (unresolved.size && !allowMissing) throw new DashboardSummaryUnavailable();
  return result;
}

async function readStatus(ids: string[], refs: DashboardEventRef[], generations: (string | null)[] | undefined) {
  try {
    const raw = await callDashboardQueue<unknown>("status", { ids, refs, generations });
    const { items } = statusItemsSchema.parse(raw);
    const associated = new Map<string, QueueItem>();
    const retained = new Map<string, DashboardExecutorSettings>();
    const requested = new Map(ids.map((id, index) => [id, refs[index]]));
    for (const { requestId, retainedSettings, ...item } of items) {
      const id = requestId ?? item.id;
      const ref = id && requested.get(id);
      if (!id || !ref || !item.id || associated.has(id)) throw new DashboardSummaryUnavailable();
      if (requestId !== undefined || retainedSettings !== undefined) {
        if (!requestId || !retainedSettings || dashboardGenerationDigest(ref.key, retainedSettings) !== item.id) throw new DashboardSummaryUnavailable();
        retained.set(id, retainedSettings);
      }
      associated.set(id, item);
    }
    for (const id of ids) if (!associated.has(id)) associated.set(id, { state: "not_accepted", reason: "not_found" });
    return { current: associated, retained };
  } catch (error) {
    if (error instanceof DashboardSummaryUnavailable) throw error;
    throw new DashboardSummaryUnavailable();
  }
}

function sourceOutcome(value: unknown): "ok" | "source_obsolete" | "source_retry" {
  if (value && typeof value === "object" && "source" in value) return "ok";
  if (value && typeof value === "object" && "code" in value) {
    const code = (value as { code?: unknown }).code;
    if (code === "source_obsolete" || code === "source_retry") return code;
  }
  throw new DashboardSummaryUnavailable();
}

async function validateSources(refs: DashboardEventRef[]): Promise<Map<string, "ok" | "source_obsolete" | "source_retry">> {
  if (!refs.length) return new Map();
  try {
    const results = await summarySources(refs);
    if (!(results instanceof Map)) throw new DashboardSummaryUnavailable();
    const outcomes = new Map<string, "ok" | "source_obsolete" | "source_retry">();
    for (const ref of refs) {
      const value = results.get(ref.key);
      if (value === undefined) throw new DashboardSummaryUnavailable();
      outcomes.set(ref.key, sourceOutcome(value));
    }
    return outcomes;
  } catch (error) {
    if (error instanceof DashboardSummaryUnavailable) throw error;
    if (error instanceof DashboardSourceError) {
      const code = (error as Error & { code?: unknown }).code;
      if (code === "source_obsolete" || code === "source_retry") {
        return new Map(refs.map(ref => [ref.key, code]));
      }
    }
    throw new DashboardSummaryUnavailable();
  }
}

function sourceFailure(item: QueueItem | undefined, code: "source_obsolete" | "source_retry"): QueueItem {
  if (code === "source_obsolete") return { ...(item?.id ? { id: item.id } : {}), state: "obsolete", reason: code };
  if (item && item.state !== "not_accepted") {
    const preserved = { ...item };
    delete preserved.text;
    return item.state === "done"
      ? { id: item.id, state: "retrying", reason: code, retryAt: Date.now() + 5_000 }
      : { ...preserved, reason: code };
  }
  return { ...(item?.id ? { id: item.id } : {}), state: "not_accepted", reason: code, retryAt: Date.now() + 5_000 };
}

function legacyCacheDirectory() {
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "bead-me-up-scotty", "dashboard-summaries");
}

async function readLegacyCache(key: string, settings: DashboardSettings, executor: DashboardExecutorSettings): Promise<QueueItem | null> {
  for (const model of executor.providers) {
    const cacheKey = digestLegacy({ version: 2, key, settings: { model, reasoningEffort: settings.reasoningEffort, prompt: settings.prompt } });
    const file = path.join(legacyCacheDirectory(), `${cacheKey}.json`);
    let handle: FileHandle | undefined;
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size < 2 || stat.size > 16384) continue;
      const raw = await handle.readFile("utf8");
      const value: unknown = JSON.parse(raw);
      if (typeof value === "string" && value.trim().length > 0 && value.length <= 16384 && !value.includes("\0")) {
        return { state: "done", text: value, model };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw new DashboardSummaryUnavailable();
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
  return null;
}

function wantsReplay(item: QueueItem | undefined, replay: boolean | undefined) {
  return Boolean(replay && item?.replayable && item.state !== "done" && item.state !== "obsolete");
}
function durableAccepted(item: QueueItem) {
  return item.state === "waiting" || item.state === "running" || item.state === "retrying" || item.state === "blocked";
}

export async function dashboardSummaryAction(raw: unknown): Promise<DashboardSummaryActionResult> {
  const input = browserRequestSchema.parse(raw);
  if (input.action === "recheck") {
    try {
      const result = await callDashboardQueue<unknown>("recheck", input.scope === "shared" ? { scope: "shared" } : {
        scope: "route", route: input.route,
        configured: dashboardExecutorSettings(await getDashboardSettings()).providers.includes(input.route),
      });
      if (!result || typeof result !== "object" || (result as { ok?: unknown }).ok !== true) throw new DashboardSummaryUnavailable();
      return { ok: true, status: 200 };
    } catch (error) {
      if (error instanceof DashboardQueueError && error.code === "invalid_request") throw new z.ZodError([]);
      throw new DashboardSummaryUnavailable();
    }
  }

  const generations = input.action === "status" ? new Map(input.refs.map(ref => [ref.key, ref.generation])) : undefined;
  const refs = uniqueRefs(input.action === "status" ? input.refs.map(({ id, key }) => ({ id, key })) : input.entries.map(entry => entry.ref));
  const settings = await getDashboardSettings();
  const executor = dashboardExecutorSettings(settings);
  const ids = refs.map(ref => dashboardGenerationDigest(ref.key, executor));
  const { current, retained } = await readStatus(ids, refs, generations && refs.map(ref => generations.get(ref.key) ?? null));
  const itemsByKey: Record<string, QueueItem> = {};

  if (input.action === "status") {
    const needsSource = refs.filter((_ref, index) => {
      const item = current.get(ids[index]);
      return Boolean(item?.text) || item?.state === "not_accepted" && item.reason === "not_found";
    });
    const sources = await validateSources(needsSource);
    for (const [index, ref] of refs.entries()) {
      let item: QueueItem = current.get(ids[index]) ?? { state: "not_accepted", reason: "not_found" };
      const source = sources.get(ref.key);
      if (source && source !== "ok") item = sourceFailure(item, source);
      else if (item.state === "not_accepted" && item.reason === "not_found" && source === "ok") {
        item = await readLegacyCache(ref.key, settings, executor) ?? item;
      }
      itemsByKey[ref.key] = item;
    }
    return { items: itemsByKey, status: 200 };
  }

  const priorityByPair = new Map<string, "retry" | "visible" | "prefetch">();
  const rank = { retry: 0, visible: 1, prefetch: 2 };
  for (const entry of input.entries) {
    const pair = `${entry.ref.key}\n${entry.ref.id}`;
    const old = priorityByPair.get(pair);
    if (!old || rank[entry.priority] < rank[old]) priorityByPair.set(pair, entry.priority);
  }
  const replay = input.replay === true;
  const sourceRefs = refs.filter((_ref, index) => {
    const item = current.get(ids[index]);
    return Boolean(item?.text) || item?.state === "not_accepted" && item.reason === "not_found" || wantsReplay(item, replay);
  });
  const sourceMap = await validateSources(sourceRefs);
  type Candidate = { ref: DashboardEventRef; id: string; settings: DashboardExecutorSettings; priority: "retry" | "visible" | "prefetch"; replay: boolean; promote: boolean; previous?: QueueItem };
  const admissionCandidates: Candidate[] = [];

  for (const [index, ref] of refs.entries()) {
    const id = ids[index];
    const item = current.get(id);
    const shouldReplay = wantsReplay(item, replay);
    const source = sourceMap.get(ref.key);
    const priority = priorityByPair.get(`${ref.key}\n${ref.id}`) ?? "visible";
    if (item?.id && durableAccepted(item) && priority !== "prefetch") {
      admissionCandidates.push({ ref, id: item.id, settings: retained.get(id) ?? executor, priority, replay: false, promote: true, previous: item });
      continue;
    }

    if (item && (item.state !== "not_accepted" || item.reason !== "not_found") && !shouldReplay) {
      if (item.text && source !== "ok") itemsByKey[ref.key] = sourceFailure(item, source ?? "source_retry");
      else itemsByKey[ref.key] = item;
      continue;
    }
    if (source !== "ok") {
      itemsByKey[ref.key] = sourceFailure(item, source ?? "source_retry");
      continue;
    }
    const legacy = shouldReplay ? null : await readLegacyCache(ref.key, settings, executor);
    if (legacy) {
      itemsByKey[ref.key] = legacy;
      continue;
    }
    admissionCandidates.push({
      ref,
      id: item?.id ?? id,
      settings: retained.get(id) ?? executor,
      priority,
      replay: shouldReplay,
      promote: false,
      previous: item,
    });
  }

  if (!admissionCandidates.length) return { items: itemsByKey, status: 200 };
  if (!(await dashboardWorkerAdmissionEnabled())) {
    for (const candidate of admissionCandidates) {
      const previous = candidate.previous;
      itemsByKey[candidate.ref.key] = candidate.promote && previous ? previous
        : previous && previous.state !== "not_accepted" ? { ...previous, reason: "executor_unavailable" }
        : { state: "not_accepted", reason: "executor_unavailable" };
    }
    return { items: itemsByKey, status: 200 };
  }

  let accepted = false;
  const returnedText: DashboardEventRef[] = [];
  try {
    // Each prompt can escape to six bytes per UTF-16 code unit. Eight entries
    // fit the queue's 1 MiB input cap even with maximal refs and settings.
    for (let offset = 0; offset < admissionCandidates.length; offset += 8) {
      const batch = admissionCandidates.slice(offset, offset + 8);
      const result = await callDashboardQueue<unknown>("admit", {
        entries: batch.map(({ id, ref, settings, priority }) => ({ id, ref, settings, priority })),
        replayIds: batch.filter(candidate => candidate.replay).map(candidate => candidate.id),
        existingIds: batch.filter(candidate => candidate.promote).map(candidate => candidate.id),
      });
      const queueItems = parseQueueItems(result);
      if (queueItems.some(item => item.state !== "not_accepted" && !item.id)) throw new DashboardSummaryUnavailable();
      const admitted = associateQueueItems(queueItems, batch.map(candidate => candidate.id), false);
      for (const candidate of batch) {
        const item = admitted.get(candidate.id);
        if (!item || candidate.promote && item.state === "not_accepted") throw new DashboardSummaryUnavailable();
        itemsByKey[candidate.ref.key] = item.state === "not_accepted" && item.reason === "queue_capacity"
          ? { ...item, reason: "capacity" } : item;
        accepted ||= durableAccepted(item);
        if (item.text) returnedText.push(candidate.ref);
      }
    }
  } catch {
    throw new DashboardSummaryUnavailable();
  }
  // A worker may finish between the status read and admission/promotion.
  const refreshed = await validateSources(returnedText);
  for (const ref of returnedText) {
    const source = refreshed.get(ref.key);
    if (source !== "ok") itemsByKey[ref.key] = sourceFailure(itemsByKey[ref.key], source ?? "source_retry");
  }
  return { items: itemsByKey, status: accepted ? 202 : 200 };
}

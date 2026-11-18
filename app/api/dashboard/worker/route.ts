import { ZodError, z } from "zod";
import { isDashboardEventId, summarySources, DashboardSourceError } from "@/lib/dashboard-activity";
import {
  authorizeDashboardWorker,
  callDashboardQueue,
  dashboardGenerationDigest,
} from "@/lib/dashboard-worker";
import type { DashboardEventRef } from "@/lib/dashboard-types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const MAX_BODY_BYTES = 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const tokenSchema = z.string().length(32).regex(/^[a-f0-9]{32}$/);
const MAX_BATCH = 4;
const MAX_INVITATIONS = 6;
const MAX_TEXT = 8_000;
// Match Python str.strip(), including its extra ASCII separators but not BOM.
const nonWhitespace = /[^\p{White_Space}\u001c-\u001f]/u;
const refSchema = z.object({ id: z.string().refine(isDashboardEventId), key: z.string().regex(SHA256) }).strict();
const modelSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:/-]+$/);
const executorSettingsSchema = z.object({
  providers: z.array(modelSchema).min(1).max(2).refine(providers => new Set(providers).size === providers.length && providers.every((provider, index) => index === 0 || providers[index - 1] < provider)),
  reasoningEffort: z.enum(["low", "medium", "high", "xhigh"]),
  prompt: z.string().min(20).max(16000),
}).strict();
const claimItemSchema = z.object({ id: z.string().regex(SHA256), ref: refSchema, settings: executorSettingsSchema }).strict();
const claimSchema = z.object({
  token: tokenSchema,
  route: modelSchema,
  deadlineAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  items: z.array(claimItemSchema).min(1).max(MAX_BATCH),
}).strict();
const claimResultSchema = z.object({ claim: claimSchema.nullable() }).strict();
const completeOutcomeSchema = z.object({
  id: z.string().regex(SHA256),
  kind: z.enum(["result", "obsolete", "source_retry", "malformed", "split", "invalid", "route_transient", "route_blocked", "shared_transient", "shared_blocked"]),
  reason: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).optional(),
  text: z.string().max(MAX_TEXT * 2).refine(text =>
    [...text].length <= MAX_TEXT && nonWhitespace.test(text) && !text.includes("\0") && !/[\uD800-\uDFFF]/u.test(text)
  ).optional(),
  model: modelSchema.optional(),
  retryAfterMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict().refine(outcome => outcome.kind !== "result" || outcome.text !== undefined);
const requestSchema = z.union([
  z.object({ action: z.literal("invite") }).strict(),
  z.object({ action: z.literal("claim"), invitation: tokenSchema }).strict(),
  z.object({ action: z.literal("resolve"), token: tokenSchema }).strict(),
  z.object({ action: z.literal("complete"), token: tokenSchema, outcomes: z.array(completeOutcomeSchema).min(1).max(MAX_BATCH).refine(outcomes => new Set(outcomes.map(outcome => outcome.id)).size === outcomes.length) }).strict(),
  z.object({ action: z.literal("recheck"), scope: z.literal("shared") }).strict(),
  z.object({ action: z.literal("recheck"), scope: z.literal("route"), route: modelSchema }).strict(),
]);

const noStore = { "Cache-Control": "no-store" };
class WorkerUnavailable extends Error {}

async function readBody(request: Request): Promise<unknown> {
  const length = request.headers.get("content-length");
  if (length && Number(length) > MAX_BODY_BYTES) throw new RangeError();
  if (!request.body) throw new SyntaxError();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new RangeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new SyntaxError(); }
}

function validateClaim(value: unknown) {
  const parsed = claimResultSchema.safeParse(value);
  if (!parsed.success) throw new WorkerUnavailable();
  const claim = parsed.data.claim;
  if (claim) {
    const ids = new Set<string>();
    for (const item of claim.items) {
      if (!item.settings.providers.includes(claim.route) || item.id !== dashboardGenerationDigest(item.ref.key, item.settings) || ids.has(item.id)) throw new WorkerUnavailable();
      ids.add(item.id);
    }
  }
  return parsed.data.claim;
}

function uniqueClaimRefs(items: z.infer<typeof claimItemSchema>[]): DashboardEventRef[] {
  const refs = new Map<string, DashboardEventRef>();
  for (const item of items) refs.set(`${item.ref.key}\n${item.ref.id}`, item.ref);
  return [...refs.values()];
}

function sourceCode(value: unknown): "source_obsolete" | "source_retry" | null {
  if (!value || typeof value !== "object") return null;
  if ("source" in value) return null;
  if ("code" in value && ((value as { code?: unknown }).code === "source_obsolete" || (value as { code?: unknown }).code === "source_retry")) {
    return (value as { code: "source_obsolete" | "source_retry" }).code;
  }
  return null;
}

async function resolveSources(claim: NonNullable<ReturnType<typeof validateClaim>>) {
  try {
    const idByKey = new Map<string, string>();
    const conflictingKeys = new Set<string>();
    for (const item of claim.items) {
      const previousId = idByKey.get(item.ref.key);
      if (previousId !== undefined && previousId !== item.ref.id) conflictingKeys.add(item.ref.key);
      else idByKey.set(item.ref.key, item.ref.id);
    }
    const refs = uniqueClaimRefs(claim.items.filter(item => !conflictingKeys.has(item.ref.key)));
    const resolved = await summarySources(refs);
    if (!(resolved instanceof Map)) throw new WorkerUnavailable();
    return claim.items.map(item => {
      if (conflictingKeys.has(item.ref.key)) {
        return { ...item, outcome: { id: item.id, kind: "obsolete" as const, reason: "source_obsolete" } };
      }
      const value = resolved.get(item.ref.key);
      if (value === undefined) throw new WorkerUnavailable();
      const code = sourceCode(value);
      return code ? { ...item, outcome: { id: item.id, kind: code === "source_obsolete" ? "obsolete" as const : "source_retry" as const, reason: code } }
        : value && typeof value === "object" && "source" in value
          ? { ...item, source: (value as { source: unknown }).source }
          : (() => { throw new WorkerUnavailable(); })();
    });
  } catch (error) {
    if (error instanceof WorkerUnavailable) throw error;
    if (error instanceof DashboardSourceError) {
      const code = (error as Error & { code?: unknown }).code;
      if (code === "source_obsolete" || code === "source_retry") {
        return claim.items.map(item => ({ ...item, outcome: { id: item.id, kind: code === "source_obsolete" ? "obsolete" as const : "source_retry" as const, reason: code } }));
      }
    }
    throw new WorkerUnavailable();
  }
}

function sameClaim(a: NonNullable<ReturnType<typeof validateClaim>>, b: NonNullable<ReturnType<typeof validateClaim>>) {
  return a.token === b.token && a.route === b.route && a.deadlineAt === b.deadlineAt
    && a.items.length === b.items.length
    && a.items.every((item, index) => item.id === b.items[index]?.id && item.ref.id === b.items[index]?.ref.id
      && item.ref.key === b.items[index]?.ref.key && JSON.stringify(item.settings) === JSON.stringify(b.items[index]?.settings));
}

export async function POST(request: Request) {
  const auth = await authorizeDashboardWorker(request);
  if (auth === "unconfigured") return Response.json({ error: "Worker API is not configured", code: "worker_unconfigured" }, { status: 503, headers: noStore });
  if (auth !== "ok") return Response.json({ error: "Unauthorized", code: "unauthorized" }, { status: 401, headers: noStore });

  let input: z.infer<typeof requestSchema>;
  try { input = requestSchema.parse(await readBody(request)); }
  catch (error) {
    if (error instanceof ZodError || error instanceof SyntaxError || error instanceof RangeError) {
      return Response.json({ error: "Invalid input", code: "invalid_input" }, { status: 400, headers: noStore });
    }
    return Response.json({ error: "Worker service is temporarily unavailable", code: "service_unavailable", retryAfterMs: 5000 }, { status: 503, headers: { ...noStore, "Retry-After": "5" } });
  }

  try {
    if (input.action === "invite") {
      const result: unknown = await callDashboardQueue("invite", {});
      const parsed = z.object({ invitations: z.array(tokenSchema).max(MAX_INVITATIONS).refine(tokens => new Set(tokens).size === tokens.length) }).strict().safeParse(result);
      if (!parsed.success) throw new WorkerUnavailable();
      return Response.json(parsed.data, { headers: noStore });
    }
    if (input.action === "claim") {
      const result: unknown = await callDashboardQueue("claim", { invitation: input.invitation });
      const claim = validateClaim(result);
      return Response.json({ claim }, { headers: noStore });
    }
    if (input.action === "complete") {
      const result: unknown = await callDashboardQueue("complete", { token: input.token, outcomes: input.outcomes });
      const parsed = z.object({ status: z.enum(["committed", "stale"]) }).strict().safeParse(result);
      if (!parsed.success) throw new WorkerUnavailable();
      return Response.json(parsed.data, { headers: noStore });
    }
    if (input.action === "recheck") {
      const result: unknown = await callDashboardQueue("recheck", input.scope === "shared" ? { scope: "shared" } : { scope: "route", route: input.route });
      const parsed = z.object({ ok: z.literal(true) }).strict().safeParse(result);
      if (!parsed.success) throw new WorkerUnavailable();
      return Response.json(parsed.data, { headers: noStore });
    }

    const firstRaw: unknown = await callDashboardQueue("resolve", { token: input.token });
    const first = validateClaim(firstRaw);
    if (!first || first.token !== input.token || first.deadlineAt <= Date.now()) return Response.json({ claim: null }, { headers: noStore });
    const items = await resolveSources(first);
    const secondRaw: unknown = await callDashboardQueue("resolve", { token: input.token });
    const second = validateClaim(secondRaw);
    if (!second || !sameClaim(first, second) || second.deadlineAt <= Date.now()) return Response.json({ claim: null }, { headers: noStore });
    return Response.json({ claim: { ...second, items } }, { headers: noStore });
  } catch {
    return Response.json({ error: "Worker service is temporarily unavailable", code: "service_unavailable", retryAfterMs: 5000 }, { status: 503, headers: { ...noStore, "Retry-After": "5" } });
  }
}

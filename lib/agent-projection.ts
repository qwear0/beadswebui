import "server-only";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { AgentSnapshot, AgentPolicy, AgentTelemetryError, AgentMessage, AgentReceipt, AgentConversation, AgentAvailability } from "./agent-protocol";

// This is a data-only copy of pi_qr's v1 contract, not an import of its executable code.
const AGENT = /^agt_[a-f0-9]{64}$/;
const INSTANCE = /^ins_[a-f0-9]{32}$/;
export const MESSAGE = /^msg_[0-9]{13}_[a-f0-9]{32}$/;
export const PROJECT = /^[a-z0-9][a-z0-9-]{0,127}$/;
const NATIVE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const OPERATION = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MAX_RECORD = 65536;
const MAX_ENTRIES = 4096;
const id = z.string().regex(NATIVE);
const displayName = z.string().max(1024);
const project = z.string().regex(PROJECT).refine((s) => s !== "demo");
const address = z.object({ agentId: z.string().regex(AGENT), instanceId: z.string().regex(INSTANCE) });
const messageId = z.string().regex(MESSAGE);
const timestamp = z.string().max(40).refine((s) => Number.isFinite(Date.parse(s)) && /^\d{4}-\d{2}-\d{2}T/.test(s));
const canonicalPath = z.string().max(4096).refine((s) => path.isAbsolute(s) && path.normalize(s) === s && !s.includes("\0"));
const bead = z.object({ projectId: project, beadId: id });
const native = z.object({ bindingId: id, dispatchId: id, taskId: id, messageId: id.nullable(), questionId: id.nullable(), deliveryId: id.nullable(), kind: id });
const parent = z.object({ agentId: z.string().regex(AGENT), instanceId: z.string().regex(INSTANCE).nullable(), sessionId: id, bindingId: id, dispatchId: id, taskId: id });
const snapshotSchema = z.object({
  version: z.literal(1), address, installationId: z.uuid(), sessionId: id,
  label: z.string().max(120), projectId: project.nullable(), cwd: canonicalPath,
  worktree: canonicalPath.nullable(), commonDir: canonicalPath.nullable(), bead: bead.nullable(),
  summary: z.string().max(500).nullable(), model: z.object({ provider: displayName, id: displayName }).nullable(),
  role: z.enum(["coordinator", "worker", "unverified"]), parent: parent.nullable(),
  provenance: z.enum(["native_session", "admitted_worker", "historical_worker", "unverified"]),
  liveness: z.enum(["online", "ended", "unknown"]), activity: z.enum(["idle", "working", "waiting", "error", "unknown"]),
  currentTools: z.array(z.object({ id: displayName, name: displayName, startedAt: timestamp })).max(256),
  activatedAt: timestamp, observedAt: timestamp, lastWorkAt: timestamp.nullable(), suspended: z.boolean(),
  capabilities: z.object({ coordinatorMail: z.boolean(), nativeOwnerChannel: z.boolean() }),
  diagnostics: z.array(z.string().max(2000)).max(100),
});
const envelopeSchema = z.object({
  version: z.literal(1), messageId, operationKey: z.string().regex(OPERATION), requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  sender: address, recipient: address, senderProjectId: project, recipientProjectId: project,
  bead: bead.nullable(), threadId: messageId, inReplyTo: messageId.nullable(), kind: z.enum(["note", "question", "reply"]),
  body: z.string().refine((s) => Buffer.byteLength(s, "utf8") <= 16384), acceptedAt: timestamp,
  transport: z.enum(["coordinator_mail", "native_projection"]), native: native.nullable(),
});
type Envelope = z.infer<typeof envelopeSchema>;
const receiptBase = { version: z.literal(1), messageId, factId: id, address, observedAt: timestamp };
const receiptSchema = z.discriminatedUnion("kind", [
  z.object({ ...receiptBase, kind: z.literal("received"), settingsRevision: z.string().max(256).nullable(), wakeEligible: z.boolean(), nativeDeliveryId: id.optional() }),
  z.object({ ...receiptBase, kind: z.literal("attempt"), attemptId: id, messageIds: z.array(messageId).max(8), settingsRevision: z.string().max(256), outcome: z.literal("unconfirmed") }),
  z.object({ ...receiptBase, kind: z.literal("in_context"), entryId: id, sessionId: id, durability: z.enum(["memory", "persisted"]) }),
  z.object({ ...receiptBase, kind: z.literal("tool_read"), factId: z.literal("tool_read") }),
  z.object({ ...receiptBase, kind: z.literal("answered"), replyMessageId: messageId }),
  z.object({ ...receiptBase, kind: z.literal("acknowledged") }),
  z.object({ ...receiptBase, kind: z.literal("native_ack"), deliveryId: id }),
  z.object({ ...receiptBase, kind: z.literal("outcome"), outcome: z.enum(["expired", "rejected", "unconfirmed"]), code: id }),
]);

export class AgentReadError extends Error {
  constructor(public code: string, message: string, public status = 503) { super(message); this.name = "AgentReadError"; }
}
function missing(error: unknown) { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }
export function telemetry(source: AgentTelemetryError["source"], error: unknown, recordId?: string): AgentTelemetryError {
  return { source, code: error instanceof AgentReadError ? error.code : "agent_read_error", message: error instanceof AgentReadError ? error.message : "Cannot read or validate sanitized agent data", ...(recordId ? { recordId } : {}) };
}
export function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function stateRoot(): string {
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  if (!path.isAbsolute(base)) throw new AgentReadError("invalid_state_root", "Agent state root must be absolute");
  return path.join(base, "pi-quality-runtime", "agents", "v1");
}
export function configRoot(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  if (!path.isAbsolute(base)) throw new AgentReadError("invalid_config_root", "Agent configuration root must be absolute");
  return path.normalize(base);
}

/** Check every component, not just the leaf. O_NOFOLLOW fences a replaced leaf.
 * Same-user local publication is the trust boundary; these reads never create state.
 */
export function checkedPath(root: string, parts: string[] = []): string {
  if (!path.isAbsolute(root) || root.includes("\0") || root.length > 4096) throw new AgentReadError("unsafe_path", "Expected a bounded absolute protocol root");
  for (const part of parts) {
    if (!part || part === "." || part === ".." || part.includes("/") || part.includes("\\") || part.includes("\0")) throw new AgentReadError("unsafe_path", "Unsafe protocol path component", 400);
  }
  const target = path.join(root, ...parts);
  if (target.length > 4096) throw new AgentReadError("unsafe_path", "Protocol path exceeds its bound");
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new AgentReadError("unsafe_path", "Protocol path escapes root", 400);
  const segments = target.split(path.sep).filter(Boolean);
  let current = path.parse(target).root;
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new AgentReadError("unsafe_symlink", "Symlinks are not permitted in agent protocol paths");
    if (current !== target && !stat.isDirectory()) throw new AgentReadError("unsafe_path", "Protocol parent is not a directory");
  }
  return target;
}
export function canonicalStateRoot(): string {
  const root = stateRoot();
  try { return fs.realpathSync(checkedPath(root)); } catch (error) { if (missing(error)) return path.resolve(root); throw error; }
}
export function readJson(root: string, parts: string[], maxBytes = MAX_RECORD): unknown {
  const file = checkedPath(root, parts);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes || stat.nlink !== 1) throw new AgentReadError("invalid_record", "Agent JSON must be a bounded regular non-linked file");
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > maxBytes) throw new AgentReadError("record_too_large", "Agent JSON exceeds the protocol bound");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
  } finally { fs.closeSync(fd); }
}
export function directory(root: string, parts: string[], optional = false, max = MAX_ENTRIES): fs.Dirent[] {
  let dir: fs.Dir;
  try { dir = fs.opendirSync(checkedPath(root, parts)); } catch (error) { if (optional && missing(error)) return []; throw error; }
  const entries: fs.Dirent[] = [];
  try {
    for (;;) {
      const entry = dir.readSync();
      if (!entry) break;
      if (entries.length === max) throw new AgentReadError("directory_limit", "Agent protocol directory exceeds the bounded read limit");
      entries.push(entry);
    }
  } finally { dir.closeSync(); }
  return entries;
}
function committed(entry: fs.Dirent, pattern: RegExp): string | null {
  if (entry.name.startsWith(".tmp-")) return null;
  if (!entry.name.endsWith(".json")) throw new AgentReadError("invalid_record_path", "Unexpected committed agent record filename");
  const name = entry.name.slice(0, -5);
  if (!entry.isFile() || entry.isSymbolicLink() || !pattern.test(name)) throw new AgentReadError("invalid_record_path", "Invalid committed agent record name or file type");
  return name;
}

export interface Registry { ids: string[]; revision: string }
/** Read current registry rather than getConfig's cached, permissively sanitized view. */
export function readRegistry(): Registry {
  try {
    const parsed = z.object({ projects: z.array(z.object({ id: project, path: canonicalPath })).max(4096) }).parse(readJson(configRoot(), ["bead-me-up-scotty", "config.json"], 1024 * 1024));
    const ids = new Set<string>();
    const paths = new Set<string>();
    for (const item of parsed.projects) {
      if (ids.has(item.id)) throw new AgentReadError("invalid_registry", "Project registration has duplicate IDs");
      const canonical = fs.realpathSync(item.path);
      if (paths.has(canonical)) throw new AgentReadError("ambiguous_registry", "Project registration has ambiguous canonical paths");
      ids.add(item.id); paths.add(canonical);
    }
    return { ids: [...ids].sort(), revision: digest(parsed.projects) };
  } catch (error) {
    if (error instanceof AgentReadError) throw error;
    throw new AgentReadError("registry_unavailable", "Current project registration is missing, unreadable or invalid");
  }
}
export function requireProject(registry: Registry, projectId?: string) {
  if (projectId && !registry.ids.includes(projectId)) throw new AgentReadError("unknown_project", "Project is not registered", 404);
}
export function readPolicy(): AgentPolicy {
  try {
    const parsed = z.object({ version: z.literal(1), revision: z.uuid(), agentMessaging: z.object({ autoWake: z.boolean() }) }).parse(readJson(configRoot(), ["pi-quality-runtime", "agent-workspace.json"]));
    return { autoWake: parsed.agentMessaging.autoWake, revision: parsed.revision, error: null };
  } catch (error) {
    // Only absence means default-on. The runtime must persist its unique revision
    // before auto-wake; this read-only consumer cannot initialize that revision.
    if (missing(error)) return { autoWake: true, revision: null, error: "Runtime messaging settings are uninitialized; runtime must persist a revision before auto-wake" };
    return { autoWake: null, revision: null, error: "Runtime messaging settings are unreadable or invalid" };
  }
}
export interface PresenceProjection { availability: AgentAvailability; agents: AgentSnapshot[]; errors: AgentTelemetryError[] }
export function readPresence(root: string): PresenceProjection {
  const agents: AgentSnapshot[] = [];
  const errors: AgentTelemetryError[] = [];
  let remaining = 4096;
  try {
    checkedPath(root);
    const installation = z.object({ version: z.literal(1), installationId: z.uuid() }).parse(readJson(root, ["installation.json"]));
    for (const agentDir of directory(root, ["presence"], true)) {
      try {
        if (!agentDir.isDirectory() || !AGENT.test(agentDir.name)) throw new AgentReadError("invalid_presence_path", "Invalid presence agent directory");
        for (const instance of directory(root, ["presence", agentDir.name])) {
          if (--remaining < 0) throw new AgentReadError("presence_read_limit", "Aggregate presence read limit exceeded");
          let recordId: string | null = null;
          try {
            recordId = committed(instance, INSTANCE);
            if (!recordId) continue;
            const raw = snapshotSchema.parse(readJson(root, ["presence", agentDir.name, instance.name]));
            if (raw.address.agentId !== agentDir.name || raw.address.instanceId !== recordId || raw.installationId !== installation.installationId || raw.address.agentId !== `agt_${createHash("sha256").update(`${raw.installationId}\n${raw.sessionId}`).digest("hex")}`) throw new AgentReadError("identity_mismatch", "Presence identity does not match its committed location or installation/session");
            const { address: exact, activity, provenance, version: _version, ...rest } = raw;
            void _version;
            agents.push({ ...rest, ...exact, source: provenance, workState: activity, linkage: raw.projectId ? "linked" : "unlinked", conflict: false });
          } catch (error) { if (!missing(error)) errors.push(telemetry("presence", error, recordId ?? undefined)); }
        }
      } catch (error) { if (!missing(error)) errors.push(telemetry("presence", error)); }
      if (remaining < 0) break;
    }
    return { availability: "available", agents, errors };
  } catch (error) {
    return { availability: "unavailable", agents: [], errors: [telemetry("state", missing(error) ? new AgentReadError("state_unavailable", "Shared agent state has not been published or is unavailable") : error)] };
  }
}
export function visiblePresence(presence: PresenceProjection, registry: Registry, projectId?: string): PresenceProjection {
  const now = Date.now();
  const activeCounts = new Map<string, number>();
  for (const item of presence.agents) {
    if (item.liveness === "online" && Math.abs(now - Date.parse(item.observedAt)) <= 45_000) activeCounts.set(item.agentId, (activeCounts.get(item.agentId) ?? 0) + 1);
  }
  const agents = presence.agents.filter((item) => item.projectId !== null && registry.ids.includes(item.projectId) && (!projectId || item.projectId === projectId)).map((item): AgentSnapshot => ({
    ...item,
    liveness: Date.parse(item.observedAt) > now + 45_000 ? "unknown" : item.liveness === "online" && now - Date.parse(item.observedAt) > 45_000 ? "stale" : item.liveness,
    diagnostics: [...item.diagnostics, ...(Date.parse(item.observedAt) > now + 45_000 ? ["Presence timestamp is ahead of the server clock; freshness is unknown"] : [])],
    conflict: (activeCounts.get(item.agentId) ?? 0) > 1,
    // Never expose a link into a project no longer registered to this app.
    bead: item.bead && registry.ids.includes(item.bead.projectId) ? item.bead : null,
  }));
  const unlinked = presence.agents.filter((item) => item.projectId === null || !registry.ids.includes(item.projectId)).length;
  return { ...presence, agents, errors: [...presence.errors, ...(!projectId && unlinked ? [{ source: "presence" as const, code: "unlinked_agents", message: `${unlinked} agent instance(s) have no current registered project; their details are not exposed` }] : [])] };
}

// A web cursor is intentionally stronger than the raw runtime project cursor:
// bind the registered scope, selected thread, immutable highwater and position.
const cursorSchema = z.object({
  version: z.literal(1), scope: z.string().regex(/^[a-f0-9]{64}$/), threadId: messageId.nullable(),
  highwater: messageId, day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), hour: z.string().regex(/^(0\d|1\d|2[0-3])$/), after: messageId.nullable(),
});
type Cursor = z.infer<typeof cursorSchema>;
function dateParts(id: string): [string, string] {
  if (!MESSAGE.test(id)) throw new AgentReadError("invalid_id", "Invalid message ID", 400);
  const date = new Date(Number(id.slice(4, 17)));
  if (!Number.isFinite(date.getTime())) throw new AgentReadError("invalid_id", "Invalid message timestamp", 400);
  const iso = date.toISOString();
  return [iso.slice(0, 10), iso.slice(11, 13)];
}
function validDay(day: string) {
  const date = new Date(`${day}T00:00:00.000Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day;
}
function encodeCursor(cursor: Cursor) { return Buffer.from(JSON.stringify(cursor)).toString("base64url"); }
function pageCursor(raw: string | null | undefined, registry: Registry, projectId?: string, threadId?: string): Cursor {
  const scope = digest({ projects: registry.ids, registry: registry.revision, projectId: projectId ?? null });
  if (raw !== undefined && raw !== null) {
    try {
      if (raw.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
      const cursor = cursorSchema.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
      const [topDay, topHour] = dateParts(cursor.highwater);
      if (cursor.scope !== scope || cursor.threadId !== (threadId ?? null) || !validDay(cursor.day) || `${cursor.day}/${cursor.hour}` > `${topDay}/${topHour}` || (cursor.after && (dateParts(cursor.after).join("/") !== `${cursor.day}/${cursor.hour}` || cursor.after > cursor.highwater))) throw new Error();
      return cursor;
    } catch { throw new AgentReadError("invalid_cursor", "History cursor is invalid or belongs to another scope/thread/registration", 400); }
  }
  const highwater = `msg_${String(Date.now()).padStart(13, "0")}_${"f".repeat(32)}`;
  const [day, hour] = dateParts(highwater);
  return { version: 1, scope, threadId: threadId ?? null, highwater, day, hour, after: null };
}
function canonicalEnvelope(root: string, message: string): Envelope | null {
  const [day, hour] = dateParts(message);
  let raw: unknown;
  try { raw = readJson(root, ["messages", day, hour, `${message}.json`]); } catch (error) { if (missing(error)) return null; throw error; }
  const envelope = envelopeSchema.parse(raw);
  if (envelope.messageId !== message) throw new AgentReadError("identity_mismatch", "Canonical message identity differs from its filename");
  if (envelope.bead && envelope.bead.projectId !== envelope.senderProjectId && envelope.bead.projectId !== envelope.recipientProjectId) throw new AgentReadError("invalid_attribution", "Message bead is outside participant projects");
  if ((envelope.transport === "native_projection") !== (envelope.native !== null)) throw new AgentReadError("invalid_transport", "Message transport and native provenance disagree");
  return envelope;
}
function allowed(envelope: Envelope, registry: Registry, projectId?: string) {
  // Both participants must still be registered. A project request can see only
  // messages actually attributed to it, even when a pointer was malformed.
  return registry.ids.includes(envelope.senderProjectId) && registry.ids.includes(envelope.recipientProjectId) && (!projectId || envelope.senderProjectId === projectId || envelope.recipientProjectId === projectId);
}
function isReplyTo(reply: Envelope, parent: Envelope) {
  return reply.kind === "reply" && reply.inReplyTo === parent.messageId && reply.threadId === parent.threadId &&
    reply.transport === parent.transport && reply.sender.agentId === parent.recipient.agentId &&
    reply.sender.instanceId === parent.recipient.instanceId && reply.recipient.agentId === parent.sender.agentId &&
    reply.recipient.instanceId === parent.sender.instanceId && reply.senderProjectId === parent.recipientProjectId &&
    reply.recipientProjectId === parent.senderProjectId;
}
function readReceipts(root: string, envelope: Envelope, errors: AgentTelemetryError[], budget: { remaining: number }): AgentReceipt[] {
  const facts: AgentReceipt[] = [];
  for (const source of ["receipts", "processing"]) try {
    for (const entry of directory(root, [source, envelope.messageId], true)) {
      let fact: string | null = null;
      try {
        fact = committed(entry, NATIVE);
        if (!fact) continue;
        if (--budget.remaining < 0) throw new AgentReadError("receipt_read_limit", "Receipt read budget exceeded; some independent facts are not loaded");
        const parsed = receiptSchema.parse(readJson(root, [source, envelope.messageId, entry.name]));
        const processing = parsed.kind === "tool_read" || parsed.kind === "answered";
        if (parsed.messageId !== envelope.messageId || parsed.factId !== fact || ![envelope.sender, envelope.recipient].some((a) => a.agentId === parsed.address.agentId && a.instanceId === parsed.address.instanceId) || (parsed.kind === "attempt" && !parsed.messageIds.includes(envelope.messageId)) || processing !== (source === "processing")) throw new AgentReadError("receipt_mismatch", "Receipt identity does not match the message, participants or fact directory");
        if (processing && (envelope.transport !== "coordinator_mail" || parsed.address.agentId !== envelope.recipient.agentId || parsed.address.instanceId !== envelope.recipient.instanceId)) throw new AgentReadError("processing_mismatch", "Processing fact must belong to the exact coordinator recipient");
        if (parsed.kind === "answered") {
          if (--budget.remaining < 0) throw new AgentReadError("receipt_read_limit", "Answer correlation read budget exceeded");
          const reply = canonicalEnvelope(root, parsed.replyMessageId);
          if (!reply || !isReplyTo(reply, envelope) || parsed.factId !== `answered_${createHash("sha256").update(parsed.replyMessageId).digest("hex").slice(0, 32)}`) throw new AgentReadError("answer_mismatch", "Answer fact lacks a matching committed linked reply");
        }
        facts.push(parsed);
      } catch (error) {
        errors.push(telemetry("history", error, envelope.messageId));
        if (budget.remaining < 0) break;
      }
    }
  } catch (error) { errors.push(telemetry("history", error, envelope.messageId)); }
  return facts.sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.factId.localeCompare(b.factId));
}

/** Enumerate bounded directory metadata, then read at most 256 canonical records
 * in at most four hourly partitions. Presence reconciliation never calls this.
 */
export function readHistory(root: string, registry: Registry, projectId: string | undefined, threadId: string | undefined, rawCursor: string | null | undefined, limit: number) {
  if (threadId && !MESSAGE.test(threadId)) throw new AgentReadError("invalid_thread", "Invalid conversation thread ID", 400);
  const cursor = pageCursor(rawCursor, registry, projectId, threadId);
  const projects = projectId ? [projectId] : registry.ids;
  const errors: AgentTelemetryError[] = [];
  const envelopes: Envelope[] = [];
  const partitions = new Set<string>();
  const days = new Set<string>();
  const watchPaths: string[][] = [["history"]];
  let directoryBudget = 8192;
  try {
    for (const participant of projects) {
      watchPaths.push(["history", participant]);
      for (const day of directory(root, ["history", participant], true)) {
        if (--directoryBudget < 0) throw new AgentReadError("history_directory_limit", "History metadata read budget exceeded");
        if (!day.isDirectory() || !validDay(day.name)) throw new AgentReadError("invalid_history_path", "Invalid history day directory");
        if (day.name <= cursor.day) days.add(day.name);
      }
    }
    // Read hours only for the newest relevant days. Five partitions are enough
    // for four bounded reads plus a continuation; older hours are not scanned.
    for (const day of [...days].sort().reverse()) {
      for (const participant of projects) {
        watchPaths.push(["history", participant, day]);
        for (const hour of directory(root, ["history", participant, day], true, 24)) {
          if (--directoryBudget < 0) throw new AgentReadError("history_directory_limit", "History metadata read budget exceeded");
          if (!hour.isDirectory() || !/^(0\d|1\d|2[0-3])$/.test(hour.name)) throw new AgentReadError("invalid_history_path", "Invalid history hour directory");
          const key = `${day}/${hour.name}`;
          if (key <= `${cursor.day}/${cursor.hour}`) partitions.add(key);
        }
      }
      if (partitions.size >= 5) break;
    }
  } catch (error) { errors.push(telemetry("history", error)); }
  // An incomplete metadata listing must not issue a cursor that silently skips
  // the unread portion. Refuse the page rather than present fabricated emptiness.
  if (errors.length) return { messages: [] as AgentMessage[], conversations: [] as AgentConversation[], errors, nextCursor: null as string | null, watchPaths };
  const ordered = [...partitions].sort().reverse();
  let examined = 0;
  let visited = 0;
  let nextCursor: string | null = null;
  const receiptsBudget = { remaining: 4096 };
  let pointerBudget = 16384;
  outer: for (let index = 0; index < ordered.length; index++) {
    const key = ordered[index];
    const [day, hour] = key.split("/");
    if (visited++ === 4 || examined >= 256 || envelopes.length >= limit) {
      nextCursor = encodeCursor({ ...cursor, day, hour, after: null }); break;
    }
    const ids = new Map<string, string[]>();
    watchPaths.push(["messages", day, hour]);
    for (const participant of projects) {
      try {
        watchPaths.push(["history", participant, day, hour]);
        for (const entry of directory(root, ["history", participant, day, hour], true)) {
          if (--pointerBudget < 0) throw new AgentReadError("history_pointer_limit", "Aggregate history pointer read limit exceeded");
          const message = committed(entry, MESSAGE);
          if (!message || message > cursor.highwater || (key === `${cursor.day}/${cursor.hour}` && cursor.after && message <= cursor.after)) continue;
          if (dateParts(message).join("/") !== key) throw new AgentReadError("history_partition_mismatch", "Message pointer is in the wrong UTC partition");
          ids.set(message, [...(ids.get(message) ?? []), participant]);
        }
      } catch (error) { errors.push(telemetry("history", error)); break; }
    }
    if (errors.length) break;
    const sorted = [...ids.keys()].sort();
    for (let position = 0; position < sorted.length; position++) {
      const message = sorted[position];
      examined++;
      try {
        for (const participant of ids.get(message)!) {
          const pointer = z.object({ version: z.literal(1), messageId }).parse(readJson(root, ["history", participant, day, hour, `${message}.json`]));
          if (pointer.messageId !== message) throw new AgentReadError("pointer_mismatch", "History pointer identity mismatch");
        }
        const envelope = canonicalEnvelope(root, message);
        // Precommit pointers are intentional; only a canonical envelope is accepted.
        if (envelope && allowed(envelope, registry, projectId)) {
          if (ids.get(message)!.some((p) => p !== envelope.senderProjectId && p !== envelope.recipientProjectId)) throw new AgentReadError("history_attribution_mismatch", "History pointer is outside message participant projects");
          // Replies can introduce bead context absent from the root. Keep each
          // bounded envelope observation; the UI filters before thread deduplication.
          if (!threadId || envelope.threadId === threadId) envelopes.push(envelope);
        }
      } catch (error) { errors.push(telemetry("history", error, message)); }
      if (envelopes.length >= limit || examined >= 256) {
        if (position + 1 < sorted.length) nextCursor = encodeCursor({ ...cursor, day, hour, after: message });
        else if (index + 1 < ordered.length) { const [nextDay, nextHour] = ordered[index + 1].split("/"); nextCursor = encodeCursor({ ...cursor, day: nextDay, hour: nextHour, after: null }); }
        break outer;
      }
    }
  }
  const messages: AgentMessage[] = threadId ? envelopes.map((raw) => {
    const { version: _version, operationKey: _operationKey, requestHash: _requestHash, ...envelope } = raw;
    void _version; void _operationKey; void _requestHash;
    watchPaths.push(["receipts", envelope.messageId], ["processing", envelope.messageId]);
    const receipts = readReceipts(root, raw, errors, receiptsBudget);
    return { ...envelope, receipts, answeredBy: [...new Set([
      ...receipts.filter((fact): fact is Extract<AgentReceipt, { kind: "answered" }> => fact.kind === "answered").map(fact => fact.replyMessageId),
      ...envelopes.filter(reply => isReplyTo(reply, raw)).map(reply => reply.messageId),
    ])] };
  }) : [];
  const conversations: AgentConversation[] = envelopes.map((envelope) => ({
    threadId: envelope.threadId, participantProjects: [...new Set([envelope.senderProjectId, envelope.recipientProjectId])],
    participants: [envelope.sender, envelope.recipient], bead: envelope.bead, kind: envelope.kind,
    preview: envelope.body.slice(0, 200), startedAt: envelope.messageId === envelope.threadId ? envelope.acceptedAt : null, updatedAt: envelope.acceptedAt, transport: envelope.transport,
  }));
  return { messages, conversations, errors, nextCursor, watchPaths };
}

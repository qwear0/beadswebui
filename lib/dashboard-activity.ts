import "server-only";
import { readDashboardRegistration } from "./config";
import { readDashboardBeadComments, readDashboardBeads } from "./bd";
import { buildActivity, readInteractionsStrict, type ActivityItem, type RawInteraction } from "./interactions";
import type { Bead } from "./schema";
import { AgentReadError, canonicalStateRoot, digest, directory, readHistory, readMessage, readPresence, MESSAGE, type Registry } from "./agent-projection";
import { compareDashboardEvents, type DashboardActivityResponse, type DashboardEvent, type DashboardEventRef } from "./dashboard-types";
import type { AgentMessage, AgentSnapshot } from "./agent-protocol";

type EventDraft = Omit<Extract<DashboardEvent, { source: "bead" }>, "key"> | Omit<Extract<DashboardEvent, { source: "message" }>, "key">;
type SourceCode = "source_obsolete" | "source_retry";
type SourceResult = { source: unknown } | { code: SourceCode };
const SOURCE_OBSOLETE_MESSAGE = "Событие изменилось или больше недоступно. Обновите Dashboard.";
const SOURCE_RETRY_MESSAGE = "Источник события временно недоступен. Повторите запрос.";
const DASHBOARD_SOURCE_BATCH_LIMIT = 40;

/** Validate opaque dashboard feed identities without changing their exact spelling. */
export function isDashboardEventId(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 1024 || value.includes("\0")) return false;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return false;
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export class DashboardSourceError extends Error {
  constructor(public readonly code: SourceCode) {
    super(code === "source_obsolete" ? SOURCE_OBSOLETE_MESSAGE : SOURCE_RETRY_MESSAGE);
    this.name = "DashboardSourceError";
  }
}

function sourceKey(id: string, projects: string[], input: unknown) {
  // Keep this serialization identical to the legacy Dashboard cache digest.
  return digest({ id, projects, input });
}
function remember(event: EventDraft, input: unknown, projects: string[]): DashboardEvent {
  return { ...event, key: sourceKey(event.id, projects, input) };
}

function beadSummaryInput(projectName: string, item: ActivityItem, bead: Bead | undefined, rawById: Map<string, RawInteraction>) {
  const commentIndex = item.id.startsWith(`${item.issueId}-comment-`) ? Number(item.id.slice(`${item.issueId}-comment-`.length)) : -1;
  const comment = commentIndex >= 0 ? bead?.comments?.[commentIndex] : undefined;
  return {
    type: "beads_activity", project: projectName, actor: item.actor, origin: item.origin,
    action: item.action, issueId: item.issueId, title: item.title, at: item.at,
    detail: comment?.text?.slice(0, 16000) ?? item.detail,
    change: rawById.get(item.id)?.extra,
    // Current issue prose is context, not proof of a historical cause.
    currentTaskDescription: bead?.description?.slice(0, 8000),
    closeReason: item.action === "closed" && bead?.closed_at === item.at ? bead.close_reason : undefined,
  };
}

// Keep the dashboard feed's per-project 15-second cache independent from the
// authoritative source resolver, which deliberately performs fresh reads.
type BeadActivity = { items: DashboardEvent[]; errors: string[] };
const beadCaches = new Map<string, { scope: string; until: number; promise: Promise<BeadActivity> }>();
async function beadActivity(config: DashboardRegistration) {
  const projects = config.projects;
  const registered = new Set(projects.map(project => project.id));
  for (const id of beadCaches.keys()) if (!registered.has(id)) beadCaches.delete(id);
  const readProject = (project: typeof projects[number]) => {
    const scope = digest({ project: [project.id, project.path, project.name], allowlist: config.humanAllowlist });
    const cached = beadCaches.get(project.id);
    if (cached?.scope === scope && cached.until > Date.now()) return cached.promise;
    const promise = (async (): Promise<BeadActivity> => {
      const items: DashboardEvent[] = [];
      const errors: string[] = [];
      try {
        const beads = await readDashboardBeads(project.path);
        const interactions = readInteractionsStrict(project.path);
        const byId = new Map(beads.map(bead => [bead.id, bead]));
        const rawById = new Map(interactions.map(event => [event.id ?? `${event.issue_id}-${event.created_at}`, event]));
        for (const item of buildActivity(beads, interactions, config.humanAllowlist).sort(compareDashboardEvents).slice(0, 150)) {
          const input = beadSummaryInput(project.name, item, byId.get(item.issueId), rawById);
          items.push(remember({ id: `${project.id}/${item.id}`, source: "bead", projectId: project.id, projectName: project.name, issueId: item.issueId, actor: item.actor, title: item.title, at: item.at }, input, [project.id]));
        }
      } catch { errors.push(`Не удалось загрузить события проекта ${project.name}.`); }
      return { items, errors };
    })();
    const entry = { scope, until: Infinity, promise };
    beadCaches.set(project.id, entry);
    // Start the TTL at completion, so a read longer than the TTL is still shared.
    void promise.then(() => { entry.until = Date.now() + 15_000; });
    return promise;
  };
  const items: DashboardEvent[] = [];
  const errors: string[] = [];
  // Two independent repositories at a time; each store still serializes its CLI.
  for (let offset = 0; offset < projects.length; offset += 2) {
    const results = await Promise.all(projects.slice(offset, offset + 2).map(readProject));
    for (const result of results) { items.push(...result.items); errors.push(...result.errors); }
  }
  return { items, errors };
}

function mailSummary(message: AgentMessage, names: Map<string, string>, agents: AgentSnapshot[]) {
  const participantName = (address: AgentMessage["sender"], frozen: string | undefined, projectId: string) => {
    if (frozen) return frozen;
    const agent = agents.find(a => a.agentId === address.agentId && a.instanceId === address.instanceId);
    return agent?.name ?? (agent ? `${names.get(projectId) ?? projectId}:${agent.label}:${agent.sessionId.slice(0, 4)}`
      : `${names.get(projectId) ?? projectId} · ${address.agentId.slice(0, 12)}`);
  };
  const senderName = participantName(message.sender, message.senderName, message.senderProjectId);
  const recipientName = participantName(message.recipient, message.recipientName, message.recipientProjectId);
  const from = names.get(message.senderProjectId) ?? message.senderProjectId;
  const to = names.get(message.recipientProjectId) ?? message.recipientProjectId;
  const input = {
    type: "agent_message", kind: message.kind, transport: message.transport, nativeKind: message.native?.kind,
    sender: senderName, senderProject: from, recipient: recipientName, recipientProject: to,
    task: message.bead, body: message.body, at: message.acceptedAt,
  };
  return {
    senderName, recipientName, from, to, input,
    event: remember({ id: message.messageId, source: "message", messageId: message.messageId, threadId: message.threadId,
      projectId: message.senderProjectId, projectName: from === to ? from : `${from} → ${to}`,
      senderName, recipientName, actor: senderName, title: message.body.slice(0, 180), at: message.acceptedAt,
    }, input, [message.senderProjectId, message.recipientProjectId]),
  };
}
function mailEvent(message: AgentMessage, names: Map<string, string>, agents: AgentSnapshot[]) {
  return mailSummary(message, names, agents).event;
}

type DashboardRegistration = ReturnType<typeof readDashboardRegistration>;
type RegistrationSnapshot = { registry: Registry; config: DashboardRegistration };
function currentRegistration(requireCanonicalPaths: boolean): RegistrationSnapshot {
  const config = readDashboardRegistration(requireCanonicalPaths);
  const projects = config.projects.map(({ id, path }) => ({ id, path }));
  return { registry: { ids: projects.map(({ id }) => id).sort(), revision: digest(projects) }, config };
}
function mark(results: Map<string, SourceResult>, refs: DashboardEventRef[], code: SourceCode) {
  for (const ref of refs) results.set(ref.key, { code });
}
function projectSnapshot(config: DashboardRegistration, projectId: string) {
  const project = config.projects.find(item => item.id === projectId);
  return project ? { id: project.id, name: project.name, path: project.path } : undefined;
}

async function resolveBeadProject(projectId: string, refs: DashboardEventRef[], results: Map<string, SourceResult>) {
  let before: RegistrationSnapshot;
  try { before = currentRegistration(false); }
  catch { mark(results, refs, "source_retry"); return; }
  if (!before.registry.ids.includes(projectId)) { mark(results, refs, "source_obsolete"); return; }
  const project = projectSnapshot(before.config, projectId);
  if (!project) { mark(results, refs, "source_retry"); return; }
  const allowlist = [...before.config.humanAllowlist];

  let beads: Bead[];
  let interactions: RawInteraction[];
  try {
    beads = await readDashboardBeads(project.path);
    // ENOENT is the legitimate no-log case; all other I/O and parse failures
    // must remain retryable for Dashboard source authority.
    interactions = readInteractionsStrict(project.path);
  } catch { mark(results, refs, "source_retry"); return; }

  const byId = new Map(beads.map(bead => [bead.id, bead]));
  const rawById = new Map(interactions.map(event => [event.id ?? `${event.issue_id}-${event.created_at}`, event]));
  let currentItems: ActivityItem[];
  try { currentItems = buildActivity(beads, interactions, allowlist); }
  catch { mark(results, refs, "source_retry"); return; }
  const targetIds = new Set(refs.map(ref => ref.id.slice(projectId.length + 1)));
  const matchingItemsById = new Map<string, ActivityItem[]>();
  for (const item of currentItems) {
    if (!targetIds.has(item.id)) continue;
    matchingItemsById.set(item.id, [...(matchingItemsById.get(item.id) ?? []), item]);
  }
  const projectResults = new Map<string, SourceResult>();
  const checkedComments = new Map<string, Bead | null>();
  const match = (ref: DashboardEventRef, item: ActivityItem, bead: Bead | undefined) => {
    const source = beadSummaryInput(project.name, item, bead, rawById);
    return sourceKey(ref.id, [projectId], source) === ref.key ? { source } : undefined;
  };
  for (const ref of refs) {
    const itemId = ref.id.slice(projectId.length + 1);
    let found: SourceResult | undefined;
    for (const item of matchingItemsById.get(itemId) ?? []) {
      found = match(ref, item, byId.get(item.issueId));
      if (found) break;
    }
    // Embedded bd can report success after a failed bulk comment lookup.
    // Before interpreting an unmatched comment as obsolete, check its issue's
    // comments via the exact CLI command, which propagates read failures.
    const issueId = !found ? /^(.*)-comment-[0-9]+$/.exec(itemId)?.[1] : undefined;
    const bead = issueId ? byId.get(issueId) : undefined;
    if (bead) {
      if (!checkedComments.has(bead.id)) {
        try {
          checkedComments.set(bead.id, { ...bead, comments: await readDashboardBeadComments(project.path, bead.id) });
        } catch { checkedComments.set(bead.id, null); }
      }
      const verified = checkedComments.get(bead.id);
      if (!verified) found = { code: "source_retry" };
      else {
        const item = buildActivity([verified], [], allowlist).find(candidate => candidate.id === itemId);
        if (item) found = match(ref, item, verified);
      }
    }
    projectResults.set(ref.key, found ?? { code: "source_obsolete" });
  }

  let after: RegistrationSnapshot;
  try { after = currentRegistration(false); }
  catch { mark(results, refs, "source_retry"); return; }
  const currentProject = projectSnapshot(after.config, projectId);
  if (!currentProject || currentProject.path !== project.path || currentProject.name !== project.name) {
    mark(results, refs, "source_obsolete"); return;
  }
  if (after.registry.revision !== before.registry.revision) { mark(results, refs, "source_retry"); return; }
  if (JSON.stringify(after.config.humanAllowlist) !== JSON.stringify(allowlist)) { mark(results, refs, "source_obsolete"); return; }
  for (const [key, result] of projectResults) results.set(key, result);
}

function sameAddress(a: AgentMessage["sender"], agent: AgentSnapshot) {
  return a.agentId === agent.agentId && a.instanceId === agent.instanceId;
}
function hasInstance(presence: ReturnType<typeof readPresence>, address: AgentMessage["sender"]) {
  return presence.agents.some(agent => sameAddress(address, agent));
}

async function resolveMailBatch(refs: DashboardEventRef[], results: Map<string, SourceResult>) {
  let before: RegistrationSnapshot;
  let root: string;
  try {
    before = currentRegistration(true);
    root = canonicalStateRoot();
    // A missing/unreadable projection directory is not evidence that an exact
    // message was removed. This bounded listing establishes a usable projection.
    directory(root, ["messages"]);
  } catch { mark(results, refs, "source_retry"); return; }

  const messages = new Map<string, AgentMessage | null>();
  const readFailures = new Map<string, SourceCode>();
  for (const ref of refs) {
    if (messages.has(ref.id) || readFailures.has(ref.id)) continue;
    try { messages.set(ref.id, readMessage(root, before.registry, ref.id, false).message); }
    catch (error) {
      if (error instanceof AgentReadError && error.status === 404 && error.code === "message_not_found") messages.set(ref.id, null);
      else readFailures.set(ref.id, "source_retry");
    }
  }

  // Read the projection directly on every request. Legacy names may use only
  // an available fresh presence record; frozen names do not depend on it.
  const presence = readPresence(root);
  let after: RegistrationSnapshot;
  try { after = currentRegistration(true); }
  catch { mark(results, refs, "source_retry"); return; }
  const registrationChanged = after.registry.revision !== before.registry.revision;

  const names = new Map(after.config.projects.filter(project => after.registry.ids.includes(project.id)).map(project => [project.id, project.name]));
  for (const ref of refs) {
    if (readFailures.has(ref.id)) { results.set(ref.key, { code: "source_retry" }); continue; }
    const message = messages.get(ref.id);
    if (!message) {
      // An exact 404 is authoritative only when registration and projection
      // stayed available throughout the targeted read.
      results.set(ref.key, presence.availability === "unavailable" || registrationChanged ? { code: "source_retry" } : { code: "source_obsolete" });
      continue;
    }
    const participantProjects = [message.senderProjectId, message.recipientProjectId];
    const participantChanged = participantProjects.some(projectId => {
      const beforeProject = projectSnapshot(before.config, projectId);
      const afterProject = projectSnapshot(after.config, projectId);
      return !after.registry.ids.includes(projectId) || !beforeProject || !afterProject || beforeProject.path !== afterProject.path || beforeProject.name !== afterProject.name;
    });
    if (participantChanged) { results.set(ref.key, { code: "source_obsolete" }); continue; }
    if (registrationChanged) { results.set(ref.key, { code: "source_retry" }); continue; }
    const needsNames = !message.senderName || !message.recipientName;
    if (needsNames && (presence.availability === "unavailable" || (
      ((!message.senderName && !hasInstance(presence, message.sender)) || (!message.recipientName && !hasInstance(presence, message.recipient))) && presence.errors.length > 0
    ))) {
      results.set(ref.key, { code: "source_retry" });
      continue;
    }
    const summary = mailSummary(message, names, presence.availability === "available" ? presence.agents : []);
    results.set(ref.key, summary.event.key === ref.key ? { source: summary.input } : { code: "source_obsolete" });
  }
}

export async function summarySources(refs: DashboardEventRef[]): Promise<Map<string, SourceResult>> {
  const results = new Map<string, SourceResult>();
  const unique = new Map<string, DashboardEventRef | null>();
  for (const ref of refs) {
    if (!ref || typeof ref.key !== "string") continue;
    if (!/^[a-f0-9]{64}$/.test(ref.key)) {
      results.set(ref.key, { code: "source_obsolete" });
      continue;
    }
    if (!isDashboardEventId(ref.id)) {
      unique.set(ref.key, null);
      continue;
    }
    if (!unique.has(ref.key)) unique.set(ref.key, ref);
    else if (unique.get(ref.key)?.id !== ref.id) unique.set(ref.key, null);
  }
  const valid = [...unique.entries()].flatMap(([key, ref]) => {
    if (ref === null) { results.set(key, { code: "source_obsolete" }); return []; }
    return [ref];
  });
  if (valid.length > DASHBOARD_SOURCE_BATCH_LIMIT) {
    mark(results, valid, "source_retry");
    return results;
  }

  const beads = new Map<string, DashboardEventRef[]>();
  const mail: DashboardEventRef[] = [];
  for (const ref of valid) {
    if (MESSAGE.test(ref.id)) { mail.push(ref); continue; }
    const slash = ref.id.indexOf("/");
    if (slash <= 0) { results.set(ref.key, { code: "source_obsolete" }); continue; }
    const projectId = ref.id.slice(0, slash);
    beads.set(projectId, [...(beads.get(projectId) ?? []), ref]);
  }
  const beadGroups = [...beads];
  for (let offset = 0; offset < beadGroups.length; offset += 2) {
    await Promise.all(beadGroups.slice(offset, offset + 2).map(([projectId, group]) => resolveBeadProject(projectId, group, results)));
  }
  if (mail.length) await resolveMailBatch(mail, results);
  return results;
}

export async function summarySource(ref: DashboardEventRef): Promise<unknown> {
  const result = (await summarySources([ref])).get(ref.key);
  if (result && "source" in result) return result.source;
  throw new DashboardSourceError(result?.code ?? "source_retry");
}

export async function dashboardActivity(cursor?: string | null): Promise<DashboardActivityResponse> {
  const config = readDashboardRegistration(false);
  const beads = cursor ? { items: [], errors: [] } : await beadActivity(config);
  const errors = [...beads.errors];
  const items = [...beads.items];
  let nextCursor: string | null = null;
  try {
    const { registry, config: mailConfig } = currentRegistration(true);
    const names = new Map(mailConfig.projects.map(project => [project.id, project.name]));
    const root = canonicalStateRoot();
    const presence = readPresence(root);
    if (presence.availability === "unavailable") errors.push("История сообщений агентов недоступна.");
    else {
      const history = readHistory(root, registry, undefined, undefined, cursor, 100, true);
      items.push(...history.messages.map(message => mailEvent(message, names, presence.agents)));
      nextCursor = history.nextCursor;
      if (history.errors.length) errors.push("Часть истории сообщений агентов не удалось прочитать.");
    }
  } catch (error) {
    if (error instanceof AgentReadError && error.status < 500) throw error;
    errors.push("История сообщений агентов недоступна.");
  }
  items.sort(compareDashboardEvents);
  return { items, nextCursor, errors };
}

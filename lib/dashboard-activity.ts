import "server-only";
import { getConfig } from "./config";
import { getStore } from "./store";
import { buildActivity, readInteractions } from "./interactions";
import { AgentReadError, canonicalStateRoot, digest, readHistory, readMessage, readProjectRegistry, readRegistry, readPresence, MESSAGE, type Registry } from "./agent-projection";
import { compareDashboardEvents, type DashboardActivityResponse, type DashboardEvent, type DashboardEventRef } from "./dashboard-types";
import type { AgentMessage, AgentSnapshot } from "./agent-protocol";

type EventDraft = Omit<Extract<DashboardEvent, { source: "bead" }>, "key"> | Omit<Extract<DashboardEvent, { source: "message" }>, "key">;
interface SummarySource { id: string; input: unknown; projects: string[] }
const sources = new Map<string, SummarySource>();
export async function summarySource(ref: DashboardEventRef) {
  // Beads use the same project registry as their individual Activity views.
  // Mail still requires strict canonical-path attribution across all projects.
  const registry = MESSAGE.test(ref.id) ? readRegistry() : readProjectRegistry();
  // Route bundles and server restarts need not share this short-lived map.
  // Reconstruct from server-owned records, never from client-supplied prose.
  if (!sources.has(ref.key)) {
    if (MESSAGE.test(ref.id)) {
      const root = canonicalStateRoot();
      const { message } = readMessage(root, registry, ref.id, false);
      const names = new Map(getConfig().projects.map(project => [project.id, project.name]));
      mailEvent(message, names, readPresence(root).agents);
    } else {
      const projectId = ref.id.split("/")[0];
      if (!registry.ids.includes(projectId)) throw new Error("Проект события больше не зарегистрирован.");
      await beadActivity({ ids: [projectId], revision: registry.revision });
    }
  }
  const source = sources.get(ref.key);
  if (!source || source.id !== ref.id || !source.projects.every(id => registry.ids.includes(id))) throw new Error("Событие изменилось или больше недоступно. Обновите Dashboard.");
  return source.input;
}
function remember(event: EventDraft, input: unknown, projects: string[]): DashboardEvent {
  const key = digest({ id: event.id, projects, input });
  sources.set(key, { id: event.id, input, projects });
  while (sources.size > 20000) sources.delete(sources.keys().next().value!);
  return { ...event, key };
}

// Do not run bd on presence heartbeats or once per summary/card. Project list
// reads share a short-lived promise; individual unavailable projects stay explicit.
let beadCache: { scope: string; until: number; promise: Promise<{ items: DashboardEvent[]; errors: string[] }> } | undefined;
async function beadActivity(registry: Registry) {
  const config = getConfig();
  const projects = config.projects.filter(project => registry.ids.includes(project.id));
  const scope = digest({ registry: registry.revision, projects: projects.map(p => [p.id, p.path, p.name]), allowlist: config.humanAllowlist });
  if (beadCache?.scope === scope && beadCache.until > Date.now()) return beadCache.promise;
  const promise = (async () => {
    const items: DashboardEvent[] = [];
    const errors: string[] = [];
    // Keep CLI pressure bounded across repositories as well as within each store.
    for (const project of projects) {
      try {
        const beads = await (await getStore(project.id)).list();
        const interactions = readInteractions(project.path);
        const byId = new Map(beads.map(bead => [bead.id, bead]));
        const rawById = new Map(interactions.map(event => [event.id ?? `${event.issue_id}-${event.created_at}`, event]));
        for (const item of buildActivity(beads, interactions, config.humanAllowlist).sort(compareDashboardEvents).slice(0, 150)) {
          const bead = byId.get(item.issueId);
          const commentIndex = item.id.startsWith(`${item.issueId}-comment-`) ? Number(item.id.slice(`${item.issueId}-comment-`.length)) : -1;
          const comment = commentIndex >= 0 ? bead?.comments?.[commentIndex] : undefined;
          const input = {
            type: "beads_activity", project: project.name, actor: item.actor, origin: item.origin,
            action: item.action, issueId: item.issueId, title: item.title, at: item.at,
            detail: comment?.text?.slice(0, 16000) ?? item.detail,
            change: rawById.get(item.id)?.extra,
            // Current issue prose is context, not proof of a historical cause.
            currentTaskDescription: bead?.description?.slice(0, 8000),
            closeReason: item.action === "closed" && bead?.closed_at === item.at ? bead.close_reason : undefined,
          };
          items.push(remember({ id: `${project.id}/${item.id}`, source: "bead", projectId: project.id, projectName: project.name, issueId: item.issueId, actor: item.actor, title: item.title, at: item.at }, input, [project.id]));
        }
      } catch { errors.push(`Не удалось загрузить события проекта ${project.name}.`); }
    }
    return { items, errors };
  })();
  beadCache = { scope, until: Date.now() + 15_000, promise };
  return promise;
}

function mailEvent(message: AgentMessage, names: Map<string, string>, agents: AgentSnapshot[]) {
  const label = (address: AgentMessage["sender"]) => agents.find(a => a.agentId === address.agentId && a.instanceId === address.instanceId)?.label ?? "Agent";
  const from = names.get(message.senderProjectId) ?? message.senderProjectId;
  const to = names.get(message.recipientProjectId) ?? message.recipientProjectId;
  const input = {
    type: "agent_message", kind: message.kind, transport: message.transport, nativeKind: message.native?.kind,
    sender: label(message.sender), senderProject: from, recipient: label(message.recipient), recipientProject: to,
    task: message.bead, body: message.body, at: message.acceptedAt,
  };
  return remember({ id: message.messageId, source: "message", messageId: message.messageId, threadId: message.threadId,
    projectId: message.senderProjectId, projectName: from === to ? from : `${from} → ${to}`,
    actor: label(message.sender), title: message.body.slice(0, 180), at: message.acceptedAt,
  }, input, [message.senderProjectId, message.recipientProjectId]);
}

export async function dashboardActivity(cursor?: string | null): Promise<DashboardActivityResponse> {
  const projectRegistry = readProjectRegistry();
  const names = new Map(getConfig().projects.filter(project => projectRegistry.ids.includes(project.id)).map(project => [project.id, project.name]));
  const beads = cursor ? { items: [], errors: [] } : await beadActivity(projectRegistry);
  const errors = [...beads.errors];
  const items = [...beads.items];
  let nextCursor: string | null = null;
  try {
    const registry = readRegistry();
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
    if (!(error instanceof AgentReadError) || error.status < 500) throw error;
    errors.push(`История сообщений агентов недоступна: ${error.message}`);
  }
  items.sort(compareDashboardEvents);
  return { items, nextCursor, errors };
}

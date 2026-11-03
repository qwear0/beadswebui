import { BEAD_STATUSES, type Bead } from "@/lib/schema";
import { buildEpicGraphScope } from "@/lib/graph-epic";
import type { AgentAddress, AgentSnapshot } from "@/lib/agent-protocol";
import type { AgentFilters } from "@/hooks/use-agent-filters";

export function agentKey(agent: AgentAddress): string {
  return `${agent.agentId}/${agent.instanceId}`;
}

export function matchesAgent(agent: AgentAddress, filters: Pick<AgentFilters, "agentId" | "instanceId">): boolean {
  return (!filters.agentId || agent.agentId === filters.agentId) &&
    (!filters.instanceId || agent.instanceId === filters.instanceId);
}

export function filterAgentBeads(beads: Bead[], agents: AgentSnapshot[], projectId: string, filters: AgentFilters): Bead[] {
  const inside = epicInsideIds(beads, filters.epicId);
  const linkedIds = filters.agentId || filters.instanceId ? new Set(agents
    .filter(agent => matchesAgent(agent, filters) && agent.bead?.projectId === projectId)
    .map(agent => agent.bead!.beadId)) : null;
  return beads.filter(bead => (!inside || inside.has(bead.id)) &&
    (!filters.issueId || bead.id === filters.issueId) && (!linkedIds || linkedIds.has(bead.id)));
}

export function groupAgents(agents: AgentSnapshot[], allAgents: AgentSnapshot[]) {
  const groups = new Map<string, { label: string; agents: AgentSnapshot[] }>();
  const roles = ["coordinator", "worker", "unverified"] as const;
  for (const role of roles) {
    for (const agent of agents.filter(item => item.role === role)) {
      const parent = agent.parent;
      const owner = parent?.instanceId ? allAgents.find(item => item.agentId === parent.agentId && item.instanceId === parent.instanceId) : undefined;
      const key = role === "worker" ? `${role}/${parent?.agentId ?? "unknown"}/${parent?.instanceId ?? "unknown"}` : role;
      const label = role === "worker" ? `Workers · parent ${owner?.label ?? (parent ? parent.agentId : "unknown")} · instance ${parent?.instanceId ?? "unknown"}` : role === "coordinator" ? "Coordinators" : "Unverified role";
      const group = groups.get(key) ?? { label, agents: [] };
      group.agents.push(agent);
      groups.set(key, group);
    }
  }
  return [...groups.entries()].map(([key, group]) => ({ key, ...group }));
}

export function pipelineCounts(beads: Bead[]) {
  const statuses = new Map<string, number>();
  for (const bead of beads) statuses.set(bead.status, (statuses.get(bead.status) ?? 0) + 1);
  const known = new Set<string>(BEAD_STATUSES);
  return {
    total: beads.length,
    statuses: [...statuses].sort(([a], [b]) => a.localeCompare(b)),
    unknown: beads.reduce((n, bead) => n + Number(!known.has(bead.status)), 0),
  };
}

export function epicInsideIds(beads: Bead[], epicId: string | null): Set<string> | null {
  // Graph neighbors provide visual context, not membership in an epic's work.
  return epicId ? buildEpicGraphScope(beads, epicId).insideIds : null;
}

export function elapsedTime(start: string | null | undefined, now: number): string {
  const timestamp = start ? Date.parse(start) : NaN;
  if (!Number.isFinite(timestamp) || timestamp > now) return "elapsed unknown";
  const seconds = Math.floor((now - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}

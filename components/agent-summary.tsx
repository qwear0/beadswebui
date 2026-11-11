"use client";

import { useApp } from "@/components/app-context";
import { useAgents } from "@/hooks/use-agents";
import { useAgentFilters } from "@/hooks/use-agent-filters";
import { agentKey, pipelineCounts } from "@/lib/agent-ui";
import type { AgentSnapshot, AgentsResponse } from "@/lib/agent-protocol";
import type { Bead } from "@/lib/schema";

export const agentControlClass = "min-h-9 max-w-full rounded-md border border-border bg-[var(--surface-2)] px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]";

export function AgentStatusNotice({ data, isLoading, error }: { data?: AgentsResponse; isLoading: boolean; error: Error | null }) {
  if (isLoading && !data) return <p role="status" className="p-3 text-xs text-muted-foreground">Loading runtime agents…</p>;
  if (data?.availability === "demo") return <p className="p-3 text-xs text-muted-foreground">Demo has no real agents or conversations. No runtime connection or messages are created.</p>;
  if (!error && data?.availability !== "unavailable" && !data?.errors.length) return null;
  const pollingWarnings = data?.errors.filter(item => item.source === "state" && ["watch_limit", "watch_unavailable"].includes(item.code)) ?? [];
  const projectionErrors = data?.errors.filter(item => !pollingWarnings.includes(item)) ?? [];
  return <div role="status" className="space-y-1 p-3 text-xs">
    {(error || data?.availability === "unavailable") && <p className="text-destructive">Agent runtime unavailable. {error?.message} Last observed data, if present, is not proof of a live session.</p>}
    {!!projectionErrors.length && <div className="space-y-1 text-destructive">
      <p>Projection errors may leave the observed fleet incomplete.</p>
      {projectionErrors.map((item, i) => <p key={`${item.code}/${i}`} className="break-words">{item.source}: {item.code} · {item.message}{item.recordId ? ` · ${item.recordId}` : ""}</p>)}
    </div>}
    {!!pollingWarnings.length && <div className="space-y-1 text-amber-600 dark:text-amber-400">
      <p>Some live updates may be delayed. Periodic refresh remains active; this warning alone does not mean agents are missing.</p>
      {pollingWarnings.map((item, i) => <p key={`${item.code}/${i}`} className="break-words">{item.source}: {item.code} · {item.message}</p>)}
    </div>}
  </div>;
}

export function AgentFleetSummary({ agents }: { agents: AgentSnapshot[] }) {
  return <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Runtime fleet summary">
    <span>{agents.length} instances</span>
    {(["online", "stale", "ended", "unknown"] as const).map(state => <span key={state}>{agents.filter(agent => agent.liveness === state).length} {state === "online" ? "live" : state}</span>)}
    <span>{agents.filter(agent => agent.conflict).length} conflicts</span>
    <span>{agents.filter(agent => agent.linkage === "unlinked").length} unlinked</span>
    <span className="basis-full">Work: {(["working", "idle", "waiting", "error", "unknown"] as const).map(state => `${agents.filter(agent => agent.workState === state).length} ${state}`).join(" · ")}</span>
  </div>;
}

export function PipelineSummary({ beads, loading = false, error }: { beads: Bead[]; loading?: boolean; error?: string }) {
  const counts = pipelineCounts(beads);
  return <div aria-label="Beads pipeline counts" className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
    {loading ? <span>Loading Beads pipeline…</span> : error ? <span>Beads pipeline unavailable: {error}</span> : <>
      <strong className="font-medium text-foreground">{counts.total} total beads</strong>
      {counts.statuses.map(([status, count]) => <span key={status}>{status || "(empty status)"}: {count}</span>)}
      <span>Unknown statuses: {counts.unknown} (included in total)</span>
    </>}
  </div>;
}

export function AgentCrossFilters({ agents, unavailable = false }: { agents: AgentSnapshot[]; unavailable?: boolean }) {
  const { beads, openEpic } = useApp();
  const { filters, setFilters, clearFilters } = useAgentFilters();
  const selected = agents.find(agent => agent.agentId === filters.agentId && (!filters.instanceId || agent.instanceId === filters.instanceId));
  const selectedKey = selected ? agentKey(selected) : filters.agentId ? "missing" : "";
  const epics = beads.filter(bead => bead.issue_type === "epic");
  const hasFilters = !!(filters.agentId || filters.instanceId || filters.epicId || filters.issueId || filters.threadId);
  return <div className="flex flex-wrap items-end gap-2 border-b border-border px-4 py-3" aria-label="Agent, issue and epic filters">
    <label className="flex min-w-0 flex-col gap-1 text-xs">Runtime instance
      <select className={agentControlClass} value={selectedKey} onChange={event => {
        const agent = agents.find(item => agentKey(item) === event.target.value);
        setFilters({ agentId: agent?.agentId ?? null, instanceId: agent?.instanceId ?? null });
      }}>
        <option value="">All instances</option>
        {selectedKey === "missing" && <option value="missing">Selected instance unavailable: {filters.agentId}</option>}
        {agents.map(agent => <option key={agentKey(agent)} value={agentKey(agent)}>{agent.label} · {agent.instanceId} · {agent.liveness}{agent.conflict ? " · conflict" : ""}</option>)}
      </select>
    </label>
    <label className="flex min-w-0 flex-col gap-1 text-xs">Epic (current project)
      <select className={agentControlClass} value={filters.epicId ?? ""} onChange={event => setFilters({ epicId: event.target.value || null })}>
        <option value="">All epics</option>
        {filters.epicId && !epics.some(bead => bead.id === filters.epicId) && <option value={filters.epicId}>{filters.epicId} (not loaded)</option>}
        {epics.map(bead => <option key={bead.id} value={bead.id}>{bead.id} · {bead.title}</option>)}
      </select>
    </label>
    <label className="flex min-w-0 flex-col gap-1 text-xs">Issue (current project)
      <select className={agentControlClass} value={filters.issueId ?? ""} onChange={event => setFilters({ issueId: event.target.value || null })}>
        <option value="">All issues</option>
        {filters.issueId && !beads.some(bead => bead.id === filters.issueId) && <option value={filters.issueId}>{filters.issueId} (not loaded)</option>}
        {beads.map(bead => <option key={bead.id} value={bead.id}>{bead.id} · {bead.title}</option>)}
      </select>
    </label>
    {filters.epicId && <button className={agentControlClass} onClick={() => openEpic(filters.epicId!)}>Open epic</button>}
    {filters.agentId && <button className={agentControlClass} onClick={() => setFilters({}, "agents")}>View runtime agent</button>}
    {hasFilters && <button className={agentControlClass} onClick={clearFilters}>Clear cross-filters</button>}
    {unavailable && <p className="basis-full text-xs text-muted-foreground">Runtime linkage unavailable. Historical Beads actors do not establish an agent identity or liveness.</p>}
    {filters.threadId && <p className="basis-full break-all text-xs text-muted-foreground">Conversation filter: {filters.threadId} (conversation history only)</p>}
  </div>;
}

export function BeadAgentLinks({ beadId, onNavigate }: { beadId: string; onNavigate: () => void }) {
  const { projectId } = useApp();
  const query = useAgents(projectId);
  const { setFilters } = useAgentFilters();
  const agents = query.data?.agents.filter(agent => agent.bead?.projectId === projectId && agent.bead.beadId === beadId) ?? [];
  return <section className="my-4 rounded-lg border border-border p-3" aria-label="Associated runtime agents">
    <h3 className="mb-2 text-xs font-semibold">Runtime agents · explicit project/bead linkage</h3>
    <AgentStatusNotice data={query.data} isLoading={query.isLoading} error={query.error} />
    {!query.isLoading && !query.error && query.data?.availability === "available" && agents.length === 0 && <p className="text-xs text-muted-foreground">No explicit runtime links to this bead were found in readable snapshots. Assignees and historical actors are not live-session evidence.</p>}
    <div className="flex flex-wrap gap-2">{agents.map(agent => <button key={agentKey(agent)} className={agentControlClass} onClick={() => {
      onNavigate();
      setFilters({ agentId: agent.agentId, instanceId: agent.instanceId, issueId: beadId, epicId: null, threadId: null }, "agents");
    }}>{agent.label} · {agent.liveness} · {agent.workState}{agent.conflict ? " · conflict" : ""}</button>)}</div>
  </section>;
}

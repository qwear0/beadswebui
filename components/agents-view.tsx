"use client";

import * as React from "react";
import Link from "next/link";
import { useApp } from "@/components/app-context";
import { useAgents } from "@/hooks/use-agents";
import { useAgentFilters } from "@/hooks/use-agent-filters";
import { Icon } from "@/components/icons";
import { AgentConversation } from "@/components/agent-conversation";
import { AgentTopology } from "@/components/agent-topology";
import { AgentCrossFilters, AgentFleetSummary, AgentStatusNotice, agentControlClass } from "@/components/agent-summary";
import { agentKey, elapsedTime, epicInsideIds, groupAgents, matchesAgent } from "@/lib/agent-ui";
import type { AgentSnapshot } from "@/lib/agent-protocol";

export function AgentsView() {
  const { projectId, beads } = useApp();
  const { filters, setFilters } = useAgentFilters();
  const query = useAgents(projectId);
  const agents = query.data?.agents ?? [];
  const insideIds = React.useMemo(() => epicInsideIds(beads, filters.epicId), [beads, filters.epicId]);
  const visible = agents.filter(agent => matchesAgent(agent, filters) &&
    (!insideIds || agent.bead?.projectId === projectId && insideIds.has(agent.bead.beadId)) &&
    (!filters.issueId || agent.bead?.projectId === projectId && agent.bead.beadId === filters.issueId));
  const groups = groupAgents(visible, agents);
  const [now, setNow] = React.useState(0);
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const time = now || Date.parse(query.data?.observedAt ?? "");

  return <div className="flex h-full min-h-0 flex-col">
    <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-6 py-4">
      <Icon name="user" size={18} className="text-[var(--text-2)]" />
      <h1 className="text-[15px] font-[650]">Agents</h1>
      <span className="text-[12px] text-[var(--text-3)]">· runtime presence and read-only conversations · not inferred from Beads activity</span>
    </header>
    <div className="max-h-[35vh] shrink-0 overflow-y-auto"><AgentCrossFilters agents={agents} unavailable={!!query.error || query.data?.availability === "unavailable"} /></div>
    <div className="bd-scroll min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
      <AgentStatusNotice data={query.data} isLoading={query.isLoading} error={query.error} />
      {query.data && <AgentTopology key={projectId ?? "global"} agents={agents} visible={visible} projectId={projectId} now={time} unavailable={!!query.error || query.data.availability === "unavailable"} />}
      {query.data && <div className="mb-4 space-y-3 rounded-lg border border-border bg-[var(--surface-2)] p-3">
        <p className="text-xs font-medium">{query.error || query.data.availability === "unavailable" ? "Last observed fleet · runtime unavailable" : "Observed fleet in selected scope"}</p>
        <AgentFleetSummary agents={agents} />
        <p className="text-xs text-muted-foreground">{query.error || query.data.availability === "unavailable" ? "Last observed global mail auto-wake" : "Global mail auto-wake"}: {query.data.policy.autoWake === false ? "off" : query.data.policy.autoWake === true && query.data.policy.revision ? "on · per-instance pauses still apply" : "unknown"}</p>
        {query.data.policy.error && <p className="text-xs text-destructive">Policy diagnostic: {query.data.policy.error}</p>}
      </div>}
      {filters.agentId && <div className="mb-4 flex flex-wrap gap-2"><button className={agentControlClass} onClick={() => setFilters({}, "focus")}>Focus linked work</button><button className={agentControlClass} onClick={() => setFilters({}, "activity")}>Beads activity for linked work</button></div>}
      {!query.isLoading && !query.error && query.data?.availability === "available" && visible.length === 0 && <p className="mb-4 rounded-lg border border-border p-4 text-sm text-muted-foreground">{agents.length === 0 ? "No runtime agents observed in this registered scope." : "No runtime instances match the current explicit filters."} Historical issue actors are not used to create agents.</p>}
      <div className="space-y-5">{groups.map(group => <section key={group.key} aria-label={group.label}>
        <h2 className="mb-2 break-words text-sm font-semibold">{group.label} <span className="font-normal text-muted-foreground">· {group.agents.length}</span></h2>
        <div className="grid min-w-0 gap-3 xl:grid-cols-2">{group.agents.map(agent => <AgentCard key={agentKey(agent)} agent={agent} now={time} allAgents={agents} unavailable={!!query.error || query.data?.availability === "unavailable"} />)}</div>
      </section>)}</div>
      <div className="mt-6"><AgentConversation projectId={projectId} contextProjectId={projectId} insideIds={insideIds} issueId={filters.issueId} agents={agents} /></div>
    </div>
  </div>;
}

function AgentCard({ agent, now, allAgents, unavailable }: { agent: AgentSnapshot; now: number; allAgents: AgentSnapshot[]; unavailable: boolean }) {
  const { projectId, beads, openDetail, openEpic } = useApp();
  const { filters, setFilters } = useAgentFilters();
  const selected = !!filters.agentId && matchesAgent(agent, filters);
  const live = !unavailable && agent.liveness === "online" && !agent.conflict;
  const mailWakePaused = agent.role === "coordinator" && agent.capabilities.coordinatorMail && agent.suspended;
  const bead = agent.bead?.projectId === projectId ? beads.find(item => item.id === agent.bead?.beadId) : undefined;
  const relatedEpics = bead ? beads.filter(item => item.issue_type === "epic" && epicInsideIds(beads, item.id)?.has(bead.id)) : [];
  const parent = agent.parent?.instanceId ? allAgents.find(item => item.agentId === agent.parent!.agentId && item.instanceId === agent.parent!.instanceId) : undefined;
  return <article className={`min-w-0 rounded-lg border bg-[var(--surface)] p-4 ${selected ? "border-[var(--brand)] ring-1 ring-[var(--brand)]" : "border-border"}`} aria-label={`Agent ${agent.label}, instance ${agent.instanceId}`}>
    <div className="flex flex-wrap items-start gap-2"><h3 className="min-w-0 flex-1 break-words text-sm font-semibold">{agent.label}</h3><button aria-pressed={selected} className={agentControlClass} onClick={() => setFilters({ agentId: selected ? null : agent.agentId, instanceId: selected ? null : agent.instanceId })}>{selected ? "Clear instance filter" : "Filter instance"}</button></div>
    <div className="my-2 flex flex-wrap gap-2 text-xs"><span className="rounded border border-border px-2 py-1">Presence: {unavailable ? `last observed ${agent.liveness} · current freshness unknown` : agent.liveness === "online" ? "live (fresh)" : agent.liveness}</span><span className="rounded border border-border px-2 py-1">Work: {agent.workState}</span>{agent.conflict && <strong className="rounded border border-destructive px-2 py-1 text-destructive">Concurrent instance conflict · no unique live target</strong>}{mailWakePaused && <span className="rounded border border-border px-2 py-1" title="Mail-triggered automatic starts are paused. Agent execution is not blocked. Resume in Pi with a new user run or /agent-workspace resume."><span aria-hidden="true" className="line-through">auto-wake</span><span className="sr-only">Mail auto-wake paused. Agent execution is not blocked.</span></span>}</div>
    <p className="mb-2 break-words text-sm">{agent.summary ?? "Work summary unknown · no explicit context published"}</p>
    <dl className="space-y-1 break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">
      <Field label="Role" value={agent.role} />
      <Field label="Project" value={agent.projectId ?? "unlinked · no proven registered mapping"} />
      <Field label="Linkage" value={agent.linkage} />
      <Field label="Model" value={agent.model ? `${agent.model.provider} / ${agent.model.id}` : "unknown"} />
      <Field label="Source" value={agent.source} />
      <Field label="Observed" value={agent.observedAt} />
      <Field label="Last work" value={agent.lastWorkAt ?? "unknown"} />
      <Field label="Coordinator mail capability" value={agent.capabilities.coordinatorMail ? "yes" : "no"} />
      <Field label="Native owner channel capability" value={agent.capabilities.nativeOwnerChannel ? "yes" : "no"} />
      <Field label="Current tools" value={agent.currentTools.length === 0 ? "none observed" : `${agent.currentTools.length} ${live ? "currently observed" : "at last observation; not proof of continued execution"}`} />
      {agent.currentTools.map(tool => <Field key={tool.id} label={tool.name} value={`${elapsedTime(tool.startedAt, live ? now : Date.parse(agent.observedAt))}${live ? " elapsed" : " at last observation"} · since ${tool.startedAt}`} />)}
      <Field label="Parent session" value={agent.parent?.sessionId ?? "unknown"} />
      <Field label="Parent instance" value={agent.parent?.instanceId ?? "unknown · no correlation proven"} />
      <Field label="Root session" value="unknown · not inferred from missing parent" />
    </dl>
    {parent && <button className={`${agentControlClass} mt-2`} onClick={() => setFilters({ agentId: parent.agentId, instanceId: parent.instanceId })}>View parent {parent.label}</button>}
    <div className="mt-3 flex flex-wrap gap-2">
      {agent.projectId && agent.projectId !== projectId && <Link className={agentControlClass} href={`/p/${encodeURIComponent(agent.projectId)}?view=agents&agent=${encodeURIComponent(agent.agentId)}&instance=${encodeURIComponent(agent.instanceId)}`}>Open linked project</Link>}
      {agent.bead && (agent.bead.projectId === projectId ? <button className={agentControlClass} onClick={() => openDetail(agent.bead!.beadId)}>Open bead {agent.bead.beadId}</button> : <Link className={agentControlClass} href={`/p/${encodeURIComponent(agent.bead.projectId)}?bead=${encodeURIComponent(agent.bead.beadId)}`}>Bead {agent.bead.projectId} / {agent.bead.beadId}</Link>)}
      {!agent.bead && <span className="text-xs text-muted-foreground">Bead: unknown · no explicit link</span>}
      {relatedEpics.map(epic => <React.Fragment key={epic.id}><button className={agentControlClass} onClick={() => setFilters({ epicId: epic.id })}>Filter epic {epic.id}</button><button className={agentControlClass} onClick={() => openEpic(epic.id)}>Open epic {epic.id}</button></React.Fragment>)}
    </div>
    <details className="mt-3 text-xs"><summary className="cursor-pointer rounded focus-visible:outline focus-visible:outline-2">Exact identity and provenance</summary><dl className="mt-2 space-y-1 break-all text-muted-foreground">
      <Field label="Agent ID" value={agent.agentId} /><Field label="Instance ID" value={agent.instanceId} /><Field label="Native session ID" value={agent.sessionId || "unknown"} /><Field label="Host installation ID" value={agent.installationId || "unknown"} /><Field label="Activated" value={agent.activatedAt} /><Field label="Working directory" value={agent.cwd || "unknown"} /><Field label="Worktree" value={agent.worktree ?? "unknown"} /><Field label="Git common directory" value={agent.commonDir ?? "unknown"} /><Field label="Parent agent ID" value={agent.parent?.agentId ?? "unknown"} /><Field label="Binding ID" value={agent.parent?.bindingId ?? "unknown"} /><Field label="Dispatch ID" value={agent.parent?.dispatchId ?? "unknown"} /><Field label="Task ID" value={agent.parent?.taskId ?? "unknown"} />
    </dl></details>
    {agent.diagnostics.length > 0 && <div className="mt-3 space-y-1 text-xs text-destructive" role="status">{agent.diagnostics.map((diagnostic, i) => <p key={i} className="break-words">{diagnostic}</p>)}</div>}
  </article>;
}

function Field({ label, value }: { label: string; value: string }) {
  return <div><dt className="inline font-medium">{label}: </dt><dd className="inline">{value}</dd></div>;
}

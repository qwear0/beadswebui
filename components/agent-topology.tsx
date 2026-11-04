"use client";

import * as React from "react";
import { useAgentConversations } from "@/hooks/use-agents";
import { useAgentFilters } from "@/hooks/use-agent-filters";
import { agentKey, elapsedTime, matchesAgent } from "@/lib/agent-ui";
import type { AgentConversation, AgentSnapshot } from "@/lib/agent-protocol";
import styles from "./agent-topology.module.css";

type Group = { key: string; owner?: AgentSnapshot; workers: AgentSnapshot[]; label: string };
type Trace = { key: string; path: string };

function topologyGroups(visible: AgentSnapshot[], agents: AgentSnapshot[]): Group[] {
  const groups = new Map<string, Group>();
  const byAddress = new Map(agents.map(agent => [agentKey(agent), agent]));
  const active = visible.filter(agent => agent.liveness === "online");
  for (const owner of active.filter(agent => agent.role === "coordinator")) {
    groups.set(agentKey(owner), { key: agentKey(owner), owner, workers: [], label: owner.label });
  }
  for (const worker of active.filter(agent => agent.role !== "coordinator")) {
    const parent = worker.role === "worker" ? worker.parent : null;
    const key = parent?.instanceId ? agentKey({ agentId: parent.agentId, instanceId: parent.instanceId }) : "unlinked";
    const candidate = byAddress.get(key);
    const owner = candidate?.role === "coordinator" ? candidate : undefined;
    const group = groups.get(key) ?? {
      key, owner, workers: [],
      label: owner?.label ?? (key === "unlinked" ? "Unconfirmed ownership" : "Coordinator outside observed scope"),
    };
    group.workers.push(worker);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function pairKey(a: string, b: string) { return [a, b].sort().join("|"); }

export function AgentTopology({ agents, visible, projectId, now, unavailable }: {
  agents: AgentSnapshot[]; visible: AgentSnapshot[]; projectId?: string; now: number; unavailable: boolean;
}) {
  // Shares the conversation cache/stream; presence never fetches message bodies.
  const history = useAgentConversations(projectId);
  const groups = topologyGroups(visible, agents);
  const events = React.useMemo(() => {
    const latest = new Map<string, AgentConversation>();
    for (const page of history.data?.pages ?? []) {
      for (const event of page.conversations) {
        if (event.transport !== "native_projection" || event.participants.length !== 2) continue;
        const key = pairKey(...event.participants.map(agentKey) as [string, string]);
        if (!latest.has(key) || event.updatedAt > latest.get(key)!.updatedAt) latest.set(key, event);
      }
    }
    return latest;
  }, [history.data]);
  const historyUnavailable = !!history.error || history.data?.pages.some(page => page.availability !== "available" || page.errors.length > 0);
  const ready = history.streamContinuity !== null && !!history.data && !historyUnavailable && !unavailable;
  const visibleKeys = new Set(visible.map(agentKey));

  return <section className={styles.topology} aria-label="Active agent topology">
    <div className={styles.heading}>
      <div><h2>{unavailable ? "Last observed topology" : "Active agent topology"}</h2><p>Coordinator → workers · exact runtime ownership</p></div>
      <span>{groups.length} {groups.length === 1 ? "group" : "groups"} · {visible.filter(agent => agent.liveness === "online").length} {unavailable ? "last observed online" : "online in filter"}</span>
    </div>
    {!groups.length && <p className={styles.empty}>{unavailable ? "No last-observed online instances available." : "No online agents match the selected scope and filters."} Stale and ended instances remain in the fleet below.</p>}
    {groups.map(group => <TopologyGroup key={group.key} group={group} events={events} ready={ready} continuity={history.streamContinuity} now={now} unavailable={unavailable} visibleKeys={visibleKeys} />)}
    <div className={styles.legend}>
      <span><i /> Confirmed ownership</span><span><i className={styles.uncertainKey} /> Last observed / conflict</span><span><i className={styles.signalKey} /> New observed message</span>
      <span>{historyUnavailable ? "Message activity unavailable" : history.isLoading ? "Loading message activity…" : "Latest loaded native messages · not delivery / ACK confirmation"}</span>
      <span>Heartbeat ≠ message · select a card to filter</span>
    </div>
  </section>;
}

function TopologyGroup({ group, events, ready, continuity, now, unavailable, visibleKeys }: {
  group: Group; events: Map<string, AgentConversation>; ready: boolean; continuity: number | null; now: number; unavailable: boolean; visibleKeys: Set<string>;
}) {
  const canvas = React.useRef<HTMLDivElement>(null);
  const [traces, setTraces] = React.useState<Trace[]>([]);
  const previous = React.useRef<{ since: number; latest: Map<string, string> } | null>(null);
  const ownerKey = group.owner ? agentKey(group.owner) : null;
  const workerKeys = group.workers.map(agentKey).join("|");
  const uncertain = unavailable || !!group.owner?.conflict || group.owner?.liveness !== "online";

  React.useEffect(() => {
    const element = canvas.current;
    if (!element || !ownerKey) return;
    const measure = () => {
      const origin = element.getBoundingClientRect();
      const owner = element.querySelector<HTMLElement>("[data-owner]")?.getBoundingClientRect();
      if (!owner) return;
      const x = owner.right - origin.left;
      const y = owner.top + owner.height / 2 - origin.top;
      const next = [...element.querySelectorAll<HTMLElement>("[data-worker]")].map(node => {
        const target = node.getBoundingClientRect();
        const endX = target.left + target.width / 2 - origin.left;
        const endY = target.top - origin.top;
        // Route through the gutter above each row, never across another card.
        return { key: node.dataset.worker!, path: `M ${x} ${y} H ${x + 18} V ${endY - 14} H ${endX} V ${endY}` };
      });
      setTraces(current => JSON.stringify(current) === JSON.stringify(next) ? current : next);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    element.querySelectorAll<HTMLElement>("[data-owner], [data-worker]").forEach(node => observer.observe(node));
    return () => observer.disconnect();
  }, [ownerKey, workerKeys]);

  React.useEffect(() => {
    const element = canvas.current;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const reset = () => {
      previous.current = null;
      element?.querySelectorAll("[data-signal]").forEach(path => path.getAnimations().forEach(animation => animation.cancel()));
    };
    document.addEventListener("visibilitychange", reset);
    window.addEventListener("offline", reset);
    window.addEventListener("online", reset);
    motion.addEventListener("change", reset);
    // Cleanup also resets batched disconnect/recovery transitions to a new baseline.
    return () => {
      reset();
      document.removeEventListener("visibilitychange", reset);
      window.removeEventListener("offline", reset);
      window.removeEventListener("online", reset);
      motion.removeEventListener("change", reset);
    };
  }, [continuity]);

  React.useEffect(() => {
    const paths = canvas.current?.querySelectorAll<SVGPathElement>("[data-signal]");
    if (!ready || uncertain || document.hidden || !navigator.onLine || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      previous.current = null;
      paths?.forEach(path => path.getAnimations().forEach(animation => animation.cancel()));
      return;
    }
    if (!ownerKey || !paths?.length) return;
    const next = new Map(previous.current?.latest);
    const since = previous.current?.since ?? Date.now();
    paths?.forEach(path => {
      const key = path.dataset.signal!;
      const event = events.get(pairKey(ownerKey, key));
      const conflict = group.workers.some(agent => agentKey(agent) === key && agent.conflict);
      if (conflict) path.getAnimations().forEach(animation => animation.cancel());
      if (!event) return;
      // Summaries have no message ID: coalesce to the latest envelope per link,
      // rather than pretending this is an exhaustive event count or ACK stream.
      const last = next.get(key);
      if (last && event.updatedAt <= last) return;
      next.set(key, event.updatedAt);
      const age = Date.now() - Date.parse(event.updatedAt);
      if (!previous.current || conflict || Date.parse(event.updatedAt) <= since || age < 0 || age > 65_000) return;
      // The consumer projects participants in sender, recipient order.
      const reverse = agentKey(event.participants[0]) !== ownerKey;
      path.getAnimations().forEach(animation => animation.cancel());
      path.animate([
        { strokeDashoffset: reverse ? -100 : 100, opacity: 0 },
        { strokeDashoffset: reverse ? -90 : 90, opacity: 1, offset: 0.1 },
        { strokeDashoffset: 0, opacity: 0 },
      ], { duration: 1800, easing: "linear" });
    });
    previous.current = { since, latest: next };
  }, [events, ready, continuity, uncertain, ownerKey, traces, group.workers]);

  return <article className={styles.group} aria-label={`Agent group: ${group.label}`}>
    <header className={styles.groupHeading}><strong>{group.label}</strong><span>{group.workers.length} {group.owner ? (group.workers.length === 1 ? "worker" : "workers") : (group.workers.length === 1 ? "unattached agent" : "unattached agents")}{uncertain && group.owner ? " · last observed / uncertain" : ""}</span></header>
    <div className={styles.scroll}>
      <div className={styles.canvas} ref={canvas}>
        <svg className={styles.connections} aria-hidden="true">
          {ownerKey && traces.map(trace => <g key={trace.key}>
            <path d={trace.path} className={styles.trace} strokeDasharray={uncertain || group.workers.find(agent => agentKey(agent) === trace.key)?.conflict ? "4 4" : undefined} />
            <path d={trace.path} className={styles.signal} data-signal={trace.key} pathLength={100} strokeDasharray="8 92" />
          </g>)}
        </svg>
        <div className={styles.owner}>
          {group.owner ? <CompactAgent agent={group.owner} now={now} unavailable={unavailable} context={!visibleKeys.has(agentKey(group.owner)) || group.owner.liveness !== "online"} owner /> : <div className={styles.missing}><span>NO CONFIRMED COORDINATOR</span><p>{group.label}</p><small>Ownership is not inferred from labels or working directories.</small></div>}
        </div>
        <div className={styles.workers}>
          {group.workers.map(worker => <CompactAgent key={agentKey(worker)} agent={worker} now={now} unavailable={unavailable} event={ownerKey ? events.get(pairKey(ownerKey, agentKey(worker))) : undefined} />)}
          {!group.workers.length && <p className={styles.noWorkers}>No online workers in the current filter</p>}
        </div>
      </div>
    </div>
  </article>;
}

function CompactAgent({ agent, now, unavailable, context, owner, event }: {
  agent: AgentSnapshot; now: number; unavailable: boolean; context?: boolean; owner?: boolean; event?: AgentConversation;
}) {
  const { filters, setFilters } = useAgentFilters();
  const selected = !!filters.agentId && matchesAgent(agent, filters);
  const live = !unavailable && agent.liveness === "online" && !agent.conflict;
  const mailWakePaused = agent.role === "coordinator" && agent.capabilities.coordinatorMail && agent.suspended;
  const status = unavailable ? "freshness unknown" : agent.conflict ? "instance conflict" : agent.liveness;
  const tool = agent.currentTools[0];
  const title = `${agent.label}\n${agentKey(agent)}\n${agent.summary ?? "No published work summary"}`;
  return <button type="button" className={styles.agent} data-owner={owner ? "true" : undefined} data-worker={!owner ? agentKey(agent) : undefined} data-selected={selected} data-role={agent.role} aria-pressed={selected} aria-label={`${selected ? "Clear filter for" : "Filter by"} ${agent.label}, ${agent.role}, ${status}, ${agent.workState}${mailWakePaused ? ", mail auto-wake paused; agent execution is not blocked" : ""}`} title={title}
    onClick={() => setFilters({ agentId: selected ? null : agent.agentId, instanceId: selected ? null : agent.instanceId })}>
    <span className={styles.cardTop}><span>{agent.role}{context ? " · context" : ""}</span><span className={styles.status} data-live={live} data-error={agent.conflict || agent.workState === "error"}><i />{status}</span></span>
    <strong className={styles.name}>{agent.label} <code>{agent.instanceId.slice(-6)}</code></strong>
    <span className={styles.model} title={agent.model ? `${agent.model.provider} / ${agent.model.id}` : undefined}>{agent.model?.id ?? "Model unknown"}</span>
    <span className={styles.summary}>{agent.summary ?? "No published work summary"}</span>
    <span className={styles.work}><b>{agent.workState}</b>{mailWakePaused && <span className="line-through" title="Mail-triggered automatic starts are paused. Agent execution is not blocked. Resume in Pi with a new user run or /agent-workspace resume.">auto-wake</span>}<span title={tool?.name}>{tool ? `${tool.name} · ${elapsedTime(tool.startedAt, live ? now : Date.parse(agent.observedAt))}${agent.currentTools.length > 1 ? ` +${agent.currentTools.length - 1}` : ""}` : "No observed tool"}</span></span>
    <span className={styles.cardBottom}><span title={agent.projectId ?? undefined}>{agent.projectId ?? "Unlinked project"}</span><code>{agent.bead?.beadId ?? "No bead"}</code></span>
    {!owner && <span className={styles.event} title={event ? `${event.kind} · ${event.updatedAt} · observed native projection, not delivery confirmation` : undefined}>{event ? `${event.kind} · ${elapsedTime(event.updatedAt, now)} ago · observed` : "No loaded native message"}</span>}
  </button>;
}

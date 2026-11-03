"use client";
import * as React from "react";
import { useApp } from "@/components/app-context";
import { useActivity } from "@/hooks/use-beads";
import { OriginBadge } from "@/components/board/bead-card";
import { Icon } from "@/components/icons";
import { avatarColor, initials, relTime, fmtDateTime } from "@/lib/beads-view";
import { useAgents } from "@/hooks/use-agents";
import { useAgentFilters } from "@/hooks/use-agent-filters";
import { filterAgentBeads } from "@/lib/agent-ui";
import { AgentCrossFilters, AgentStatusNotice, PipelineSummary } from "@/components/agent-summary";

/**
 * Mission Control — live activity feed. A newest-first stream of what humans and
 * agents did (created / claimed / closed / re-prioritized / commented), each
 * stamped 👤/🤖 and linking to the bead. Data comes from /activity, refreshed
 * live by the SSE change stream (see useBeadsStream).
 */
export function ActivityView() {
  const { projectId, beads, loading, error: beadsError, openDetail, selectedBeadId, selectBead } = useApp();
  const { data, isLoading, error } = useActivity(projectId);
  const agents = useAgents(projectId === "all" ? undefined : projectId);
  const { filters } = useAgentFilters();
  const scopedBeads = filterAgentBeads(beads, agents.data?.agents ?? [], projectId, filters);
  const ids = new Set(scopedBeads.map(bead => bead.id));
  const filtered = !!(filters.agentId || filters.instanceId || filters.epicId || filters.issueId);
  const items = (data?.items ?? []).filter(item => !filtered || ids.has(item.issueId));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-6 py-4">
        <Icon name="comment" size={18} className="text-[var(--text-2)]" />
        <h1 className="text-[15px] font-[650]">Activity</h1>
        <span className="text-[12px] text-[var(--text-3)]">
          · what humans and agents did, newest first
        </span>
      </div>
      <div className="max-h-[40vh] shrink-0 overflow-y-auto border-b border-border">
        <AgentCrossFilters agents={agents.data?.agents ?? []} unavailable={!!agents.error || agents.data?.availability === "unavailable"} />
        {(filters.agentId || filters.instanceId) && <AgentStatusNotice data={agents.data} isLoading={agents.isLoading} error={agents.error} />}
        <div className="space-y-1 px-4 py-2"><PipelineSummary beads={scopedBeads} loading={loading} error={beadsError} /><p className="text-[11px] text-muted-foreground">Beads issue changes only. Agent filter selects explicitly linked work, not historical actor names. Runtime events and conversations remain separate.</p></div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {error ? <p role="alert" className="p-8 text-center text-sm text-destructive">Activity unavailable: {error.message}</p> : isLoading && items.length === 0 ? (
          <div className="p-8 text-center text-[13px] text-[var(--text-3)]">Loading activity…</div>
        ) : items.length === 0 ? (
          <div className="p-8 text-center text-[13px] text-[var(--text-3)]">{filtered ? "No Beads activity matches the explicit context filters." : "No activity yet."}</div>
        ) : (
          <ol className="mx-auto flex max-w-3xl flex-col">
            {items.map((it) => (
              <li key={it.id}>
                <button
                  data-keyboard-bead-id={it.issueId}
                  aria-current={selectedBeadId === it.issueId ? "true" : undefined}
                  onFocus={() => selectBead(it.issueId)}
                  onClick={() => {
                    selectBead(it.issueId);
                    openDetail(it.issueId);
                  }}
                  className={`flex w-full items-start gap-3 rounded-[10px] px-3 py-[10px] text-left hover:bg-[var(--surface-2)] focus-visible:outline-none ${
                    selectedBeadId === it.issueId ? "ring-2 ring-inset ring-[var(--brand)]" : ""
                  }`}
                >
                  <span
                    className="mt-[1px] flex h-[26px] w-[26px] flex-shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white"
                    style={{ background: avatarColor(it.actor) }}
                  >
                    {initials(it.actor)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-[6px] gap-y-1 text-[13px]">
                      <span className="font-semibold">{it.actor}</span>
                      <OriginBadge origin={it.origin} title={it.origin === "human" ? "Human" : "Agent"} />
                      <span className="text-[var(--text-2)]">{it.action}</span>
                      <span className="font-mono text-[11px] text-[var(--text-3)]">{it.issueId}</span>
                    </div>
                    <div className="truncate text-[12.5px] text-[var(--text-2)]">{it.title}</div>
                    {it.detail && (
                      <div className="truncate text-[12px] text-[var(--text-3)]">{it.detail}</div>
                    )}
                  </div>
                  <span
                    title={fmtDateTime(it.at)}
                    className="flex-shrink-0 whitespace-nowrap text-[11px] text-[var(--text-3)]"
                  >
                    {relTime(it.at)}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { useBeads } from "@/hooks/use-beads";
import { AppProvider } from "@/components/app-context";
import { BeadDetailDrawer } from "@/components/bead-detail-drawer";
import { MessageCard } from "@/components/agent-conversation";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { makeIndex } from "@/lib/beads-view";
import type { DashboardEvent } from "@/lib/dashboard-types";
import type { AgentSnapshot } from "@/lib/agent-protocol";

export function DashboardEventDetail({ event, agents, onClose }: { event: DashboardEvent; agents: AgentSnapshot[]; onClose: () => void }) {
  return event.source === "bead"
    ? <DashboardBeadDetail key={event.id} projectId={event.projectId} issueId={event.issueId} onClose={onClose} />
    : <DashboardMessageDetail messageId={event.messageId} agents={agents} onClose={onClose} />;
}

function LoadingDetail({ error, onClose }: { error?: string; onClose: () => void }) {
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent><DialogTitle className="sr-only">Событие</DialogTitle><p role={error ? "alert" : "status"}>{error || "Загрузка…"}</p></DialogContent></Dialog>;
}
function DashboardBeadDetail({ projectId, issueId, onClose }: { projectId: string; issueId: string; onClose: () => void }) {
  const query = useBeads(projectId);
  const router = useRouter();
  const [trail, setTrail] = React.useState([issueId]);
  const beads = query.data?.beads ?? [];
  const index = makeIndex(beads);
  const openId = trail[trail.length - 1];
  const pushDetail = (id: string) => setTrail(current => current[current.length - 1] === id ? current : [...current.slice(-24), id]);
  if (query.error || !query.data) return <LoadingDetail error={query.error?.message} onClose={onClose} />;
  if (!index.has(openId)) return <LoadingDetail error={`Задача ${openId} больше недоступна.`} onClose={onClose} />;
  return <AppProvider value={{
    projectId, beads, index, meta: query.data.meta, humanAllowlist: query.data.meta.humanAllowlist,
    readOnly: true, loading: false, selectedBeadId: openId, selectBead: () => {},
    openDetail: pushDetail, pushDetail, openCreate: () => {}, openEpic: pushDetail,
  }}><BeadDetailDrawer centered openId={openId} canGoBack={trail.length > 1} backTo={trail[trail.length - 2]} onBack={() => setTrail(current => current.slice(0, -1))} onClose={onClose} onNavigateAgent={agent => {
    const params = new URLSearchParams({ view: "agents", agent: agent.agentId, instance: agent.instanceId, issue: openId });
    router.push(`/p/${encodeURIComponent(projectId)}?${params}`);
    onClose();
  }} /></AppProvider>;
}

function DashboardMessageDetail({ messageId, agents, onClose }: { messageId: string; agents: AgentSnapshot[]; onClose: () => void }) {
  const query = useQuery({ queryKey: ["dashboard", "message", messageId], queryFn: () => api.dashboardMessage(messageId), refetchInterval: 20_000 });
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="max-h-[90dvh] overflow-y-auto pt-10 sm:max-w-4xl">
      <DialogTitle className="sr-only">Сообщение агента</DialogTitle>
      {query.error && <p role="alert" className="text-destructive">{query.error.message}</p>}
      {query.isLoading && <p role="status">Загрузка…</p>}
      {query.data?.errors.map((error, i) => <p key={i} role="alert" className="text-destructive">{error.message}</p>)}
      {query.data && <MessageCard message={query.data.message} agents={agents} interactive={false} />}
    </DialogContent>
  </Dialog>;
}

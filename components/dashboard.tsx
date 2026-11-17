"use client";
import * as React from "react";
import { useQueries } from "@tanstack/react-query";
import { Loader2, Settings } from "lucide-react";
import { api } from "@/lib/api-client";
import { avatarColor, initials, relTime } from "@/lib/beads-view";
import { useAgents } from "@/hooks/use-agents";
import { useDashboardActivity, useDashboardSettings } from "@/hooks/use-dashboard";
import { AgentTopology } from "@/components/agent-topology";
import { DashboardSettingsDialog } from "@/components/dashboard-settings";
import { DashboardEventDetail } from "@/components/dashboard-event-detail";
import { compareDashboardEvents, type DashboardEvent, type DashboardEventRef, type DashboardSettings } from "@/lib/dashboard-types";

export function Dashboard() {
  const agents = useAgents();
  const settings = useDashboardSettings();
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [selected, setSelected] = React.useState<DashboardEvent | null>(null);
  const [now, setNow] = React.useState(0);
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const observedNow = now || Date.parse(agents.data?.observedAt ?? "");
  const active = (agents.data?.agents ?? []).filter(agent => agent.liveness === "online" && observedNow - Date.parse(agent.observedAt) <= 45_000);
  const unavailable = !!agents.error || agents.data?.availability === "unavailable";
  const partialPresence = agents.data?.errors.some(error => error.code !== "unlinked_agents" && ["presence", "state", "registry"].includes(error.source));
  return <main className="relative flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground lg:flex-row" aria-label="Dashboard">
    <button aria-label="Settings" onClick={() => setSettingsOpen(true)} className="absolute right-4 top-3 z-10 flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-[var(--surface)] text-[var(--text-2)] hover:bg-[var(--surface-2)]"><Settings size={18} /></button>
    <section aria-label="Активные агенты" className="bd-scroll min-h-0 flex-1 overflow-y-auto p-4 pr-16 lg:pr-4">
      {agents.isLoading && <Loader2 className="animate-spin text-muted-foreground" aria-label="Загрузка агентов" size={18} />}
      {unavailable && <p role="alert" className="mb-3 text-sm text-destructive">Данные агентов недоступны.{agents.error ? ` ${agents.error.message}` : ""}</p>}
      {!unavailable && partialPresence && <p role="alert" className="mb-3 text-sm text-destructive">Часть сведений об агентах недоступна.</p>}
      {agents.data && <AgentTopology agents={active} visible={active} now={observedNow} unavailable={unavailable} interactive={false} />}
    </section>
    <aside aria-label="Активность всех проектов" className="flex min-h-0 h-1/2 flex-col border-t border-border bg-[var(--surface)] lg:h-full lg:w-[420px] lg:shrink-0 lg:border-l lg:border-t-0 xl:w-[460px]">
      <div className="h-14 shrink-0" aria-hidden="true" />
      {settings.error && <p role="alert" className="p-4 text-sm text-destructive">{settings.error.message}</p>}
      {settings.data && <DashboardFeed key={JSON.stringify(settings.data)} settings={settings.data} onSelect={setSelected} />}
    </aside>
    {settingsOpen && settings.data && <DashboardSettingsDialog settings={settings.data} onClose={() => setSettingsOpen(false)} />}
    {selected && <DashboardEventDetail event={selected} agents={agents.data?.agents ?? []} onClose={() => setSelected(null)} />}
  </main>;
}

function DashboardFeed({ settings, onSelect }: { settings: DashboardSettings; onSelect: (event: DashboardEvent) => void }) {
  const query = useDashboardActivity();
  const root = React.useRef<HTMLDivElement>(null);
  const sentinel = React.useRef<HTMLDivElement>(null);
  const [limit, setLimit] = React.useState(40);
  const [batches, setBatches] = React.useState<DashboardEventRef[][]>([]);
  const byId = new Map<string, DashboardEvent>();
  for (const page of query.data?.pages ?? []) for (const item of page.items) if (!byId.has(item.id)) byId.set(item.id, item);
  const items = [...byId.values()].sort(compareDashboardEvents);
  const displayed = items.slice(0, limit);
  const signature = displayed.map(item => item.key).join("/");
  const results = useQueries({ queries: batches.map(batch => ({
    queryKey: ["dashboard", "summary", settings, batch], queryFn: () => api.dashboardSummaries(batch),
    staleTime: Infinity, retry: false, refetchOnWindowFocus: false,
  })) });
  const summaries: Record<string, string> = {};
  const failures: Record<string, string> = {};
  results.forEach((result, index) => {
    Object.assign(summaries, result.data?.summaries);
    Object.assign(failures, result.data?.errors);
    if (result.error) for (const event of batches[index]) failures[event.key] = result.error.message;
  });

  React.useEffect(() => {
    const observer = new IntersectionObserver(entries => {
      const incoming = entries.filter(entry => entry.isIntersecting).map(entry => {
        const data = (entry.target as HTMLElement).dataset;
        return { key: data.eventKey!, id: data.eventId! };
      });
      if (!incoming.length) return;
      // Never extend an already submitted partial batch: changing its query key
      // would detach its in-flight result and unnecessarily queue it again.
      setBatches(current => {
        const known = new Set(current.flat().map(event => event.key));
        const added = incoming.filter(event => !known.has(event.key));
        if (!added.length) return current;
        return [...current, ...Array.from({ length: Math.ceil(added.length / 4) }, (_, index) => added.slice(index * 4, index * 4 + 4))];
      });
    }, { root: root.current, rootMargin: "80px" });
    root.current?.querySelectorAll("[data-event-key]").forEach(element => observer.observe(element));
    return () => observer.disconnect();
  }, [signature]);

  // Read enough mail history to cover the displayed time range before presenting
  // older issue activity as though there were no intervening messages.
  const oldestMail = items.filter(item => item.source === "message").at(-1)?.at;
  const cutoff = displayed.at(-1)?.at;
  const { isFetching, error, hasNextPage, fetchNextPage } = query;
  const needsMail = !!hasNextPage && (!oldestMail || !cutoff || Date.parse(oldestMail) >= Date.parse(cutoff));
  React.useEffect(() => {
    if (needsMail && !isFetching && !error) void fetchNextPage();
  }, [needsMail, isFetching, error, fetchNextPage]);

  React.useEffect(() => {
    const target = sentinel.current;
    if (!target) return;
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting) || isFetching || error) return;
      if (limit < items.length) setLimit(current => current + 30);
      else if (hasNextPage) void fetchNextPage();
    }, { root: root.current, rootMargin: "160px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [limit, items.length, isFetching, error, hasNextPage, fetchNextPage]);

  const errors = [...new Set(query.data?.pages.flatMap(page => page.errors))];
  return <div ref={root} className="bd-scroll min-h-0 flex-1 overflow-y-auto px-3 pb-3">
    {query.error && <p role="alert" className="p-3 text-sm text-destructive">{query.error.message}</p>}
    {errors.map(error => <p role="alert" key={error} className="p-3 text-sm text-destructive">{error}</p>)}
    <ol className="space-y-2">{displayed.map(item => <li key={item.id} data-event-key={item.key} data-event-id={item.id}>
      <button aria-label={summaries[item.key] ? undefined : `${item.source === "message" ? `${item.senderName} → ${item.recipientName}` : item.projectName}: ${item.title}`} onClick={() => onSelect(item)} className="flex w-full items-start gap-3 rounded-xl border border-border bg-background p-3 text-left transition-colors hover:bg-[var(--surface-2)] focus-visible:outline-2 focus-visible:outline-[var(--brand)]">
        <span aria-hidden="true" className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white" style={{ background: avatarColor(item.actor) }}>{initials(item.actor)}</span>
        <span className="min-w-0 flex-1">
          <span className="mb-1 flex items-start justify-between gap-2"><span className="break-words text-[11px] font-semibold text-[var(--text-2)] [overflow-wrap:anywhere]">{item.source === "message" ? `${item.senderName} → ${item.recipientName}` : item.projectName}</span><time dateTime={item.at} className="shrink-0 text-[10px] text-[var(--text-3)]">{relTime(item.at)}</time></span>
          {summaries[item.key] ? <span className="block break-words text-[13px] leading-relaxed [overflow-wrap:anywhere]">{summaries[item.key]}</span> : failures[item.key] ? <span className="block text-xs text-destructive">{failures[item.key]}</span> : <span aria-label="Создание описания" className="block space-y-2 py-1"><span className="block h-3 animate-pulse rounded bg-[var(--surface-3)]" /><span className="block h-3 w-4/5 animate-pulse rounded bg-[var(--surface-3)]" /></span>}
        </span>
      </button>
    </li>)}</ol>
    <div ref={sentinel} className="flex h-8 justify-center p-2">{query.isFetching && <Loader2 size={16} className="animate-spin text-muted-foreground" aria-label="Загрузка событий" />}</div>
  </div>;
}

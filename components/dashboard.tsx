"use client";
import * as React from "react";
import { Loader2, Settings } from "lucide-react";
import type { AgentsResponse } from "@/lib/api-client";
import { avatarColor, initials, relTime } from "@/lib/beads-view";
import { useAgents } from "@/hooks/use-agents";
import { useDashboardActivity, useDashboardSettings, useDashboardSummaries } from "@/hooks/use-dashboard";
import { AgentTopology } from "@/components/agent-topology";
import { DashboardSettingsDialog } from "@/components/dashboard-settings";
import { DashboardEventDetail } from "@/components/dashboard-event-detail";
import { compareDashboardEvents, dashboardSummaryIdentity, type DashboardEvent, type DashboardEventRef, type DashboardSummaryItem } from "@/lib/dashboard-types";

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
  const [lastPresence, setLastPresence] = React.useState<{ data: AgentsResponse; receivedAt: number } | null>(null);
  if (agents.data?.availability === "available" && (lastPresence?.data !== agents.data || lastPresence.receivedAt !== agents.dataUpdatedAt)) {
    setLastPresence({ data: agents.data, receivedAt: agents.dataUpdatedAt });
  }
  const snapshot = agents.data?.availability === "available" ? agents.data : lastPresence?.data;
  const receivedAt = agents.data?.availability === "available" ? agents.dataUpdatedAt : lastPresence?.receivedAt ?? 0;
  // Age the server's observation using local elapsed time, not the browser's
  // wall clock offset. A delayed fetch must not silently erase the topology.
  const elapsed = Math.max(0, (now || receivedAt) - receivedAt);
  const observedNow = Date.parse(snapshot?.observedAt ?? "") + elapsed;
  const active = (snapshot?.agents ?? []).filter(agent => agent.liveness === "online");
  const delayed = !!snapshot && (elapsed > 45_000 || active.some(agent => observedNow - Date.parse(agent.observedAt) > 45_000));
  const unavailable = !!agents.error || agents.data?.availability === "unavailable";
  const partialPresence = snapshot?.errors.some(error => error.code !== "unlinked_agents" && ["presence", "state", "registry"].includes(error.source));
  return <main className="relative flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground lg:flex-row" aria-label="Dashboard">
    <button aria-label="Settings" onClick={() => setSettingsOpen(true)} className="absolute right-4 top-3 z-10 flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-[var(--surface)] text-[var(--text-2)] hover:bg-[var(--surface-2)]"><Settings size={18} /></button>
    <section aria-label="Активные агенты" className="bd-scroll min-h-0 flex-1 overflow-y-auto p-4 pr-16 lg:pr-4">
      {agents.isLoading && <Loader2 className="animate-spin text-muted-foreground" aria-label="Загрузка агентов" size={18} />}
      {unavailable && <p role="alert" className="mb-3 text-sm text-destructive">Данные агентов недоступны.{snapshot ? " Показан последний полученный снимок; текущая активность не подтверждена." : ""}{agents.error ? ` ${agents.error.message}` : ""}</p>}
      {!unavailable && delayed && <p role="alert" className="mb-3 text-sm text-destructive">Обновление сведений об агентах задерживается. Показан последний полученный снимок; текущая активность не подтверждена.</p>}
      {!unavailable && partialPresence && <p role="alert" className="mb-3 text-sm text-destructive">Часть сведений об агентах недоступна.</p>}
      {snapshot && <AgentTopology agents={active} visible={active} now={observedNow} unavailable={unavailable || delayed} interactive={false} />}
    </section>
    <aside aria-label="Активность всех проектов" className="flex min-h-0 h-1/2 flex-col border-t border-border bg-[var(--surface)] lg:h-full lg:w-[420px] lg:shrink-0 lg:border-l lg:border-t-0 xl:w-[460px]">
      <div className="h-14 shrink-0" aria-hidden="true" />
      {settings.error && <p role="alert" className="p-4 text-sm text-destructive">{settings.error.message}</p>}
      {settings.data && <DashboardFeed key={JSON.stringify(settings.data)} now={now || settings.dataUpdatedAt} onSelect={setSelected} />}
    </aside>
    {settingsOpen && settings.data && <DashboardSettingsDialog settings={settings.data} onClose={() => setSettingsOpen(false)} />}
    {selected && <DashboardEventDetail event={selected} agents={agents.data?.agents ?? []} onClose={() => setSelected(null)} />}
  </main>;
}

function dashboardReasonText(reason: DashboardSummaryItem["reason"]): string | undefined {
  switch (reason) {
    case "capacity": return "Очередь временно заполнена; запрос не принят.";
    case "storage_unavailable": return "Не удалось сохранить состояние обработки.";
    case "executor_unavailable": return "Исполнитель описаний сейчас недоступен.";
    case "source_unavailable": return "Исходное событие пока недоступно.";
    case "source_obsolete": return "Источник события изменился или устарел.";
    case "route_blocked": return "Маршрут модели заблокирован или не имеет доступа. Исправьте настройки и перепроверьте маршрут.";
    case "shared_blocked": return "Общий маршрут заблокирован. Исправьте настройки и перепроверьте его.";
    case "malformed": return "Запрос отклонён из-за неверного формата.";
    case "invalid": return "Параметры запроса недопустимы.";
    case "not_found": return "Для события ещё нет принятого задания.";
    case "source_retry": return "Источник временно не готов; повторите проверку позже.";
    default: return reason ? "Обработчик вернул неизвестную причину отказа; проверьте настройки маршрута." : undefined;
  }
}

function dashboardSummaryStateText(item: DashboardSummaryItem | undefined, checking: boolean, now: number): string {
  if (!item) return checking ? "Проверяем сохранённое состояние…" : "Описание будет запрошено, когда карточка приблизится к области просмотра.";
  const retrySeconds = Math.max(0, Math.ceil(((item.retryAt ?? 0) - now) / 1000));
  if (retrySeconds > 0) return `Повтор запланирован через ${retrySeconds} с.`;
  switch (item.state) {
    case "waiting": return "Задание принято и ожидает обработки.";
    case "running": return "Описание сейчас создаётся.";
    case "retrying": return "Повторная попытка ожидает запуска.";
    case "blocked": return "Задание сохранено, но заблокировано до исправления или проверки.";
    case "done": return item.text ? "Описание готово." : "Обработчик отметил готовность, но не вернул текст описания.";
    case "obsolete": return "Задание устарело; описание не показывается.";
    case "failed": return "Обработка завершилась с ошибкой.";
    case "not_accepted": return "Запрос не принят; новая генерация не запущена.";
  }
}

function DashboardFeed({ now, onSelect }: { now: number; onSelect: (event: DashboardEvent) => void }) {
  const query = useDashboardActivity();
  const root = React.useRef<HTMLDivElement>(null);
  const sentinel = React.useRef<HTMLDivElement>(null);
  const [limit, setLimit] = React.useState(40);
  const [nearViewport, setNearViewport] = React.useState<{ ref: DashboardEventRef; priority: "visible" | "prefetch" }[]>([]);
  const byId = new Map<string, DashboardEvent>();
  for (const page of query.data?.pages ?? []) for (const item of page.items) if (!byId.has(item.id)) byId.set(item.id, item);
  const items = [...byId.values()].sort(compareDashboardEvents);
  const displayed = items.slice(0, limit);
  const signature = displayed.map(item => `${item.key}:${item.id}`).join("/");
  const { descriptions, checkStatus, retry, retryAdmission, recheck } = useDashboardSummaries(nearViewport, query.dataUpdatedAt);

  React.useEffect(() => {
    const nearby = new Map<string, { ref: DashboardEventRef; priority: "visible" | "prefetch" }>();
    const visible = new Map<string, DashboardEventRef>();
    const publish = () => {
      const entries = new Map(nearby);
      for (const [identity, ref] of visible) entries.set(identity, { ref, priority: "visible" });
      setNearViewport([...entries.values()]);
    };
    const readRef = (target: Element) => {
      const data = (target as HTMLElement).dataset;
      return { key: data.eventKey!, id: data.eventId! };
    };
    const prefetchObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const ref = readRef(entry.target);
        const identity = dashboardSummaryIdentity(ref);
        if (entry.isIntersecting) nearby.set(identity, { ref, priority: "prefetch" });
        else nearby.delete(identity);
      }
      publish();
    }, { root: root.current, rootMargin: "80px", threshold: 0 });
    const visibilityObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const ref = readRef(entry.target);
        const identity = dashboardSummaryIdentity(ref);
        if (entry.isIntersecting && entry.intersectionRatio > 0) visible.set(identity, ref);
        else visible.delete(identity);
      }
      publish();
    }, { root: root.current, rootMargin: "0px", threshold: 0 });
    root.current?.querySelectorAll("[data-event-key]").forEach(element => {
      prefetchObserver.observe(element);
      visibilityObserver.observe(element);
    });
    return () => {
      prefetchObserver.disconnect();
      visibilityObserver.disconnect();
    };
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
    <ol className="space-y-2">{displayed.map(item => {
      const ref = { key: item.key, id: item.id };
      const description = descriptions[dashboardSummaryIdentity(ref)];
      const status = description?.item;
      const summary = status?.state === "done" ? status.text : undefined;
      const retrySeconds = Math.max(0, Math.ceil(((status?.retryAt ?? 0) - now) / 1000));
      const reason = dashboardReasonText(status?.reason);
      const canReplay = !!status?.replayable && !(status.state === "not_accepted" && status.reason === "capacity") && ["failed", "obsolete", "not_accepted"].includes(status.state) && retrySeconds === 0;
      const recheckScope = status?.scope ?? (status?.reason === "route_blocked" ? "route" : status?.reason === "shared_blocked" ? "shared" : undefined);
      const canRecheck = status?.state === "blocked" && (recheckScope === "shared" || (recheckScope === "route" && !!status.route));
      return <li key={item.id} data-event-key={item.key} data-event-id={item.id}>
      <button aria-label={summary ? undefined : `${item.source === "message" ? `${item.senderName} → ${item.recipientName}` : item.projectName}: ${item.title}`} onClick={() => onSelect(item)} className="flex w-full items-start gap-3 rounded-xl border border-border bg-background p-3 text-left transition-colors hover:bg-[var(--surface-2)] focus-visible:outline-2 focus-visible:outline-[var(--brand)]">
        <span aria-hidden="true" className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white" style={{ background: avatarColor(item.actor) }}>{initials(item.actor)}</span>
        <span className="min-w-0 flex-1">
          <span className="mb-1 flex items-start justify-between gap-2"><span className="break-words text-[11px] font-semibold text-[var(--text-2)] [overflow-wrap:anywhere]">{item.source === "message" ? `${item.senderName} → ${item.recipientName}` : item.projectName}</span><time dateTime={item.at} className="shrink-0 text-[10px] text-[var(--text-3)]">{relTime(item.at)}</time></span>
          {summary ? <span className="block break-words text-[13px] leading-relaxed [overflow-wrap:anywhere]">{summary}</span> : <>
            <span className="block break-words text-[13px] leading-relaxed [overflow-wrap:anywhere]">{item.title}</span>
            <span className="mt-1 block text-xs text-muted-foreground" role="status">{dashboardSummaryStateText(status, !!description?.checking, now)}</span>
            {reason && <span className="mt-1 block text-xs text-destructive">{reason}</span>}
            {description?.error && <span role="alert" className="mt-1 block text-xs text-destructive">{description.error}</span>}
            {description?.note && <span role="status" className="mt-1 block text-xs text-muted-foreground">{description.note}</span>}
          </>}
          {status && (status.route || status.model || status.scope) && <span className="mt-1 block text-[11px] text-muted-foreground">{status.route ? `Маршрут: ${status.route}` : status.scope === "shared" ? "Маршрут: общий" : "Маршрут: scoped"}{status.model ? ` · Модель: ${status.model}` : ""}</span>}
        </span>
      </button>
      {!summary && description?.error && <button type="button" disabled={description.checking} onClick={() => checkStatus(ref)} className="mt-1 rounded px-2 py-1 text-xs text-muted-foreground underline hover:text-foreground disabled:opacity-50">{description.checking ? "Проверка…" : "Проверить состояние"}</button>}
      {!summary && status?.state === "not_accepted" && status.reason === "capacity" && <button type="button" disabled={description?.checking} onClick={() => retryAdmission(ref, status)} className="mt-1 rounded px-2 py-1 text-xs text-muted-foreground underline hover:text-foreground disabled:opacity-50">{description?.checking ? "Отправка…" : "Повторить запрос в очередь"}</button>}
      {!summary && canReplay && <button type="button" disabled={description?.checking} onClick={() => retry(ref, status!)} className="mt-1 rounded px-2 py-1 text-xs text-muted-foreground underline hover:text-foreground disabled:opacity-50">{description?.checking ? "Повтор…" : "Повторить обработку"}</button>}
      {!summary && canRecheck && <button type="button" disabled={description?.rechecking} onClick={() => recheck(ref, status!)} className="mt-1 rounded px-2 py-1 text-xs text-muted-foreground underline hover:text-foreground disabled:opacity-50">{description?.rechecking ? "Проверка…" : `Перепроверить ${recheckScope === "route" ? "маршрут" : "общий исполнитель"}`}</button>}
    </li>;
    })}</ol>
    <div ref={sentinel} className="flex h-8 justify-center p-2">{query.isFetching && <Loader2 size={16} className="animate-spin text-muted-foreground" aria-label="Загрузка событий" />}</div>
  </div>;
}

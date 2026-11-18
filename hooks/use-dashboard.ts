"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type {
  DashboardEventRef,
  DashboardSummaryAdmitEntry,
  DashboardSummaryItem,
  DashboardSummaryPriority,
  DashboardSummaryScope,
} from "@/lib/dashboard-types";
import { dashboardSummaryIdentity } from "@/lib/dashboard-types";

export function useDashboardActivity() {
  return useInfiniteQuery({
    queryKey: ["dashboard", "activity"],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => api.dashboardActivity(pageParam, AbortSignal.any([signal, AbortSignal.timeout(60_000)])),
    getNextPageParam: page => page.nextCursor ?? undefined,
    refetchInterval: 20_000,
  });
}

export function useDashboardSettings() {
  return useQuery({ queryKey: ["dashboard", "settings"], queryFn: api.dashboardSettings, staleTime: 30_000 });
}

type RelevantEntry = { ref: DashboardEventRef; priority: Exclude<DashboardSummaryPriority, "retry"> };
type StoredItem = { item: DashboardSummaryItem; revision: number };
export interface DashboardSummaryView {
  item?: DashboardSummaryItem;
  checking: boolean;
  error?: string;
  rechecking?: boolean;
  note?: string;
}
type AdmissionJob = { entry: DashboardSummaryAdmitEntry; revision: number };
const ACTIVE_STATES = new Set(["waiting", "running", "retrying"]);
const ACCEPTED_STATES = new Set([...ACTIVE_STATES, "blocked"]);
const shouldPoll = (item: DashboardSummaryItem) => ACTIVE_STATES.has(item.state) || item.reason === "source_retry";
const due = (item: DashboardSummaryItem) => item.reason !== "source_retry" || (item.retryAt ?? 0) <= Date.now();
const MAX_BATCH = 40;
const IDLE_REQUEST_ERROR = "Не удалось подтвердить состояние описания. Проверьте соединение и запросите состояние ещё раз.";
const chunks = <T,>(values: T[], size: number): T[][] => {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
};

/**
 * The browser only admits cards close to the viewport. Status reads are safe to
 * repeat; admission is idempotent and never used as a polling mechanism.
 */
export function useDashboardSummaries(entries: RelevantEntry[], activityRevision: number) {
  const [stored, setStored] = useState<Record<string, StoredItem>>({});
  const [checking, setChecking] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [rechecking, setRechecking] = useState<Record<string, boolean>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const currentEntries = useRef(entries);
  const currentStored = useRef(stored);
  const currentRevision = useRef(activityRevision);
  const checked = useRef(new Set<string>());
  const checkedRevision = useRef(activityRevision);
  const statusLocks = useRef(new Set<string>());
  const admissionLocks = useRef(new Set<string>());
  const autoAdmissionAttempts = useRef(new Set<string>());
  const prefetchAccepted = useRef(new Set<string>());
  const promoted = useRef(new Set<string>());
  const missingWhileHidden = useRef(new Map<string, DashboardEventRef>());
  const mounted = useRef(false);
  const statusReader = useRef<((refs: DashboardEventRef[], revision: number, admitMissing: boolean) => Promise<void>) | null>(null);
  const admissionSender = useRef<((jobs: AdmissionJob[], replay?: boolean) => Promise<void>) | null>(null);
  const promoter = useRef<((refs: DashboardEventRef[]) => void) | null>(null);

  const setItems = useCallback((refs: DashboardEventRef[], response: { items: Record<string, DashboardSummaryItem> }, revision: number) => {
    if (!mounted.current || currentRevision.current !== revision) return;
    const received = refs.map(ref => {
      const item = response.items[ref.key];
      if (!item || (!ACCEPTED_STATES.has(item.state) && !["done", "failed", "obsolete", "not_accepted"].includes(item.state))) {
        throw new Error("Missing Dashboard summary status");
      }
      return [dashboardSummaryIdentity(ref), { item: { ...item, id: item.id ?? ref.id }, revision }] as const;
    });
    setStored(current => ({ ...current, ...Object.fromEntries(received) }));
    setChecking(current => {
      const next = { ...current };
      for (const ref of refs) delete next[dashboardSummaryIdentity(ref)];
      return next;
    });
    setErrors(current => {
      const next = { ...current };
      for (const ref of refs) delete next[dashboardSummaryIdentity(ref)];
      return next;
    });
  }, []);

  const setRequestFailure = useCallback((refs: DashboardEventRef[], revision: number) => {
    if (!mounted.current || currentRevision.current !== revision) return;
    setChecking(current => {
      const next = { ...current };
      for (const ref of refs) delete next[dashboardSummaryIdentity(ref)];
      return next;
    });
    setErrors(current => ({ ...current, ...Object.fromEntries(refs.map(ref => [dashboardSummaryIdentity(ref), IDLE_REQUEST_ERROR])) }));
    const retryAt = Date.now() + 5_000;
    setStored(current => {
      const next = { ...current };
      for (const ref of refs) {
        const identity = dashboardSummaryIdentity(ref);
        const saved = next[identity];
        if (saved?.revision === revision && saved.item.state === "done") {
          next[identity] = { revision, item: { id: saved.item.id, state: "retrying", reason: "source_retry", retryAt } };
        }
      }
      return next;
    });
  }, []);

  const readStatuses = useCallback(async (refs: DashboardEventRef[], revision: number, admitMissing: boolean) => {
    for (const batch of chunks([...new Map(refs.map(ref => [dashboardSummaryIdentity(ref), ref])).values()], MAX_BATCH)) {
      if (!mounted.current || currentRevision.current !== revision) return;
      const statusLock = (ref: DashboardEventRef) => JSON.stringify([revision, dashboardSummaryIdentity(ref)]);
      const fresh = batch.filter(ref => !statusLocks.current.has(statusLock(ref)));
      if (!fresh.length) continue;
      fresh.forEach(ref => {
        statusLocks.current.add(statusLock(ref));
        setChecking(current => ({ ...current, [dashboardSummaryIdentity(ref)]: true }));
      });
      try {
        const requested = fresh.map(ref => {
          const generation = currentStored.current[dashboardSummaryIdentity(ref)]?.item.id;
          return generation && /^[a-f0-9]{64}$/.test(generation) ? { ...ref, generation } : ref;
        });
        const response = await api.dashboardSummaryStatus(requested);
        if (!mounted.current || currentRevision.current !== revision) continue;
        setItems(fresh, response, revision);
        const missing = fresh.filter(ref => {
          const item = response.items[ref.key];
          return item?.state === "not_accepted" && item.reason === "not_found";
        });
        const current = new Map(currentEntries.current.map(entry => [dashboardSummaryIdentity(entry.ref), entry]));
        const admissions: AdmissionJob[] = [];
        for (const ref of missing) {
          const identity = dashboardSummaryIdentity(ref);
          const entry = current.get(identity);
          if (!admitMissing || !entry) continue;
          if (document.visibilityState === "hidden") {
            missingWhileHidden.current.set(identity, ref);
            continue;
          }
          missingWhileHidden.current.delete(identity);
          if (autoAdmissionAttempts.current.has(identity)) continue;
          autoAdmissionAttempts.current.add(identity);
          admissions.push({ entry, revision });
        }
        if (admissions.length) admissionSender.current?.(admissions);
        for (const ref of fresh) {
          const item = response.items[ref.key];
          if (item && !(item.state === "not_accepted" && item.reason === "not_found")) {
            missingWhileHidden.current.delete(dashboardSummaryIdentity(ref));
          }
        }
      } catch {
        setRequestFailure(fresh, revision);
      } finally {
        fresh.forEach(ref => statusLocks.current.delete(statusLock(ref)));
      }
    }
  }, [setItems, setRequestFailure]);

  const sendAdmissions = useCallback(async (jobs: AdmissionJob[], replay = false) => {
    const unique = [...new Map(jobs
      .filter(job => job.revision === currentRevision.current && !admissionLocks.current.has(dashboardSummaryIdentity(job.entry.ref)))
      .map(job => [dashboardSummaryIdentity(job.entry.ref), job])).values()];
    for (const batch of chunks(unique, MAX_BATCH)) {
      if (!mounted.current) return;
      const revision = batch[0]?.revision;
      if (revision === undefined || revision !== currentRevision.current) continue;
      batch.forEach(job => {
        admissionLocks.current.add(dashboardSummaryIdentity(job.entry.ref));
        setChecking(current => ({ ...current, [dashboardSummaryIdentity(job.entry.ref)]: true }));
      });
      const refs = batch.map(job => job.entry.ref);
      try {
        const response = await api.dashboardSummaryAdmit(batch.map(job => ({ ref: job.entry.ref, priority: replay ? "retry" : job.entry.priority })), replay);
        if (!mounted.current || currentRevision.current !== revision) continue;
        setItems(refs, response, revision);
        for (const job of batch) {
          const item = response.items[job.entry.ref.key];
          const identity = dashboardSummaryIdentity(job.entry.ref);
          if (!replay && item?.state === "not_accepted" && item.reason === "source_retry") {
            // A typed refusal proves no commit. Recheck source before retrying.
            autoAdmissionAttempts.current.delete(identity);
          }
          if (!replay && job.entry.priority === "prefetch" && item && ACCEPTED_STATES.has(item.state)) {
            prefetchAccepted.current.add(identity);
          }
        }
      } catch {
        setRequestFailure(refs, revision);
        queueMicrotask(() => statusReader.current?.(refs, revision, false));
      } finally {
        batch.forEach(job => admissionLocks.current.delete(dashboardSummaryIdentity(job.entry.ref)));
      }
      const promoteNow = batch
        .filter(job => !replay && job.entry.priority === "prefetch" && prefetchAccepted.current.has(dashboardSummaryIdentity(job.entry.ref)))
        .map(job => job.entry.ref);
      if (promoteNow.length) promoter.current?.(promoteNow);
    }
  }, [setItems, setRequestFailure]);

  const promoteAccepted = useCallback((refs: DashboardEventRef[]) => {
    const visible = new Map(currentEntries.current
      .filter(entry => entry.priority === "visible")
      .map(entry => [dashboardSummaryIdentity(entry.ref), entry]));
    const jobs: AdmissionJob[] = [];
    for (const ref of refs) {
      const identity = dashboardSummaryIdentity(ref);
      const entry = visible.get(identity);
      if (!entry || !prefetchAccepted.current.has(identity) || promoted.current.has(identity)) continue;
      promoted.current.add(identity);
      jobs.push({ entry, revision: currentRevision.current });
    }
    if (jobs.length) admissionSender.current?.(jobs);
  }, []);
  const entriesSignature = entries
    .map(entry => `${dashboardSummaryIdentity(entry.ref)}:${entry.priority}`)
    .sort().join("|");
  useEffect(() => {
    currentEntries.current = entries;
    currentRevision.current = activityRevision;
    currentStored.current = stored;
    statusReader.current = readStatuses;
    admissionSender.current = sendAdmissions;
    promoter.current = promoteAccepted;
  }, [entries, activityRevision, stored, readStatuses, sendAdmissions, promoteAccepted]);

  useEffect(() => {
    mounted.current = true;
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      const revision = currentRevision.current;
      const active = currentEntries.current.filter(entry => {
        const saved = currentStored.current[dashboardSummaryIdentity(entry.ref)];
        return saved?.revision === revision && shouldPoll(saved.item) && due(saved.item);
      });
      const pendingSource = active.filter(entry => currentStored.current[dashboardSummaryIdentity(entry.ref)].item.state === "not_accepted");
      const accepted = active.filter(entry => currentStored.current[dashboardSummaryIdentity(entry.ref)].item.state !== "not_accepted");
      if (accepted.length) void statusReader.current?.(accepted.map(entry => entry.ref), revision, false);
      if (pendingSource.length) void statusReader.current?.(pendingSource.map(entry => entry.ref), revision, true);
      const missing = [...missingWhileHidden.current.values()];
      if (missing.length) void statusReader.current?.(missing, revision, true);
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onVisibility);
    return () => {
      mounted.current = false;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onVisibility);
    };
  }, []);

  useEffect(() => {
    const visiblePrefetches = currentEntries.current
      .filter(entry => entry.priority === "visible" && prefetchAccepted.current.has(dashboardSummaryIdentity(entry.ref)))
      .map(entry => entry.ref);
    if (visiblePrefetches.length) promoter.current?.(visiblePrefetches);
  }, [entriesSignature]);

  useEffect(() => {
    if (checkedRevision.current !== activityRevision) {
      checkedRevision.current = activityRevision;
      checked.current.clear();
      missingWhileHidden.current.clear();
    }
    const active = new Set(currentEntries.current.map(entry => dashboardSummaryIdentity(entry.ref)));
    for (const identity of checked.current) if (!active.has(identity)) checked.current.delete(identity);
    const fresh = currentEntries.current.filter(entry => {
      const identity = dashboardSummaryIdentity(entry.ref);
      if (checked.current.has(identity)) return false;
      checked.current.add(identity);
      return true;
    });
    if (fresh.length) void readStatuses(fresh.map(entry => entry.ref), activityRevision, true);
  }, [entriesSignature, activityRevision, readStatuses]);

  const activeSignature = entries.filter(entry => {
    const saved = stored[dashboardSummaryIdentity(entry.ref)];
    return saved?.revision === activityRevision && shouldPoll(saved.item);
  }).map(entry => dashboardSummaryIdentity(entry.ref)).sort().join("|");
  useEffect(() => {
    if (!activeSignature) return;
    const poll = () => {
      if (document.visibilityState !== "visible") return;
      const pendingSource: DashboardEventRef[] = [];
      const accepted: DashboardEventRef[] = [];
      for (const { ref } of currentEntries.current) {
        const saved = currentStored.current[dashboardSummaryIdentity(ref)];
        if (saved?.revision !== currentRevision.current || !shouldPoll(saved.item) || !due(saved.item)) continue;
        (saved.item.state === "not_accepted" ? pendingSource : accepted).push(ref);
      }
      if (accepted.length) void statusReader.current?.(accepted, currentRevision.current, false);
      if (pendingSource.length) void statusReader.current?.(pendingSource, currentRevision.current, true);
    };
    const timer = window.setInterval(poll, 5_000);
    return () => window.clearInterval(timer);
  }, [activeSignature]);

  const checkStatus = useCallback((ref: DashboardEventRef) => {
    void readStatuses([ref], currentRevision.current, false);
  }, [readStatuses]);

  const retry = useCallback((ref: DashboardEventRef, item: DashboardSummaryItem) => {
    if (!item.replayable || (item.retryAt ?? 0) > Date.now()) return;
    const entry = currentEntries.current.find(candidate => dashboardSummaryIdentity(candidate.ref) === dashboardSummaryIdentity(ref));
    if (!entry) return;
    void sendAdmissions([{ entry: { ...entry, priority: "retry" }, revision: currentRevision.current }], true);
  }, [sendAdmissions]);

  const recheck = useCallback(async (ref: DashboardEventRef, item: DashboardSummaryItem) => {
    const identity = dashboardSummaryIdentity(ref);
    const scope: DashboardSummaryScope | undefined = item.scope ?? (item.reason === "route_blocked" ? "route" : item.reason === "shared_blocked" ? "shared" : undefined);
    if (!scope || (scope === "route" && !item.route)) return;
    setRechecking(current => ({ ...current, [identity]: true }));
    setNotes(current => ({ ...current, [identity]: "" }));
    try {
      const response = await api.dashboardSummaryRecheck(scope, scope === "route" ? item.route : undefined);
      if (response.ok !== true) throw new Error("Dashboard recheck was not confirmed");
      if (mounted.current) setNotes(current => ({ ...current, [identity]: "Проверка запрошена; карточка не отправлялась повторно." }));
      await readStatuses([ref], currentRevision.current, false);
    } catch {
      if (mounted.current) setNotes(current => ({ ...current, [identity]: IDLE_REQUEST_ERROR }));
    } finally {
      if (mounted.current) setRechecking(current => ({ ...current, [identity]: false }));
    }
  }, [readStatuses]);

  const descriptions: Record<string, DashboardSummaryView> = {};
  for (const entry of entries) {
    const identity = dashboardSummaryIdentity(entry.ref);
    const saved = stored[identity];
    descriptions[identity] = {
      ...(saved?.revision === activityRevision ? { item: saved.item } : {}),
      checking: !!checking[identity],
      ...(errors[identity] ? { error: errors[identity] } : {}),
      ...(rechecking[identity] ? { rechecking: true } : {}),
      ...(notes[identity] ? { note: notes[identity] } : {}),
    };
  }
  return { descriptions, checkStatus, retry, recheck };
}

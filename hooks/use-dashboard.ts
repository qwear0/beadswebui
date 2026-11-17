"use client";
import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { DashboardEventRef } from "@/lib/dashboard-types";

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

type Description = { summary?: string; error?: string; retryAt?: number };

/** Only near-viewport cards enter the next batch. Scrolling never starts another
 * request while one is running, and failures require an explicit, cooled retry. */
export function useDashboardSummaries(events: DashboardEventRef[]) {
  const [descriptions, setDescriptions] = useState<Record<string, Description>>({});
  const inFlight = useRef(false);
  const { mutate, isPending } = useMutation({
    mutationFn: api.dashboardSummaries,
    retry: false,
    onSuccess: (response, batch) => {
      setDescriptions(current => {
        const next = { ...current };
        for (const event of batch) {
          const summary = response.summaries[event.key];
          next[event.key] = summary ? { summary } : {
            error: response.errors[event.key] ?? "Модель не вернула описание события.",
            retryAt: Date.now() + (response.retryAfterMs[event.key] ?? 0),
          };
        }
        return next;
      });
    },
    onError: (error, batch) => {
      setDescriptions(current => ({ ...current, ...Object.fromEntries(batch.map(event => [event.key, {
        error: error.message, retryAt: Date.now() + 30_000,
      }])) }));
    },
    onSettled: () => { inFlight.current = false; },
  });
  useEffect(() => {
    if (inFlight.current || isPending) return;
    const batch = events.filter(event => !descriptions[event.key]).slice(0, 4);
    if (!batch.length) return;
    inFlight.current = true;
    mutate(batch);
  }, [events, descriptions, isPending, mutate]);

  const retry = (key: string) => setDescriptions(current => {
    const description = current[key];
    if (!description?.error || (description.retryAt ?? 0) > Date.now()) return current;
    const next = { ...current };
    delete next[key];
    return next;
  });
  return { descriptions, retry };
}

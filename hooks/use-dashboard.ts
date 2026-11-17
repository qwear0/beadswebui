"use client";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";

export function useDashboardActivity() {
  return useInfiniteQuery({
    queryKey: ["dashboard", "activity"],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api.dashboardActivity(pageParam),
    getNextPageParam: page => page.nextCursor ?? undefined,
    refetchInterval: 20_000,
  });
}

export function useDashboardSettings() {
  return useQuery({ queryKey: ["dashboard", "settings"], queryFn: api.dashboardSettings, staleTime: 30_000 });
}

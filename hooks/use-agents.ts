"use client";
import { useEffect, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api, agentsBase } from "@/lib/api-client";
import type { AgentRevisions } from "@/lib/agent-protocol";

export const agentsKey = (projectId?: string) => ["agents", projectId ?? null, "snapshot"] as const;
export const agentConversationsKey = (projectId?: string) => ["agents", projectId ?? null, "conversations"] as const;
export const agentMessagesKey = (threadId: string | null, projectId?: string) => ["agents", projectId ?? null, "messages", threadId] as const;

type LiveSubscription = { listeners: Set<(live: boolean) => void>; live: boolean; close: () => void };
const clients = new WeakMap<QueryClient, Map<string, LiveSubscription>>();

function subscribe(qc: QueryClient, projectId: string | undefined, listener: (live: boolean) => void) {
  if (projectId === "demo") return () => {};
  let scopes = clients.get(qc);
  if (!scopes) { scopes = new Map(); clients.set(qc, scopes); }
  const key = projectId === undefined ? "global" : `project:${projectId}`;
  let entry = scopes.get(key);
  if (!entry) {
    const listeners = new Set<(live: boolean) => void>();
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let failures = 0;
    let revisions: Partial<AgentRevisions> = {};
    const created: LiveSubscription = { listeners, live: false, close: () => {} };
    const setLive = (live: boolean) => { created.live = live; listeners.forEach((fn) => fn(live)); };
    const connect = () => {
      if (stopped || typeof EventSource === "undefined") return;
      source = new EventSource(`${agentsBase(projectId)}/stream`);
      source.onopen = () => { failures = 0; setLive(true); };
      source.addEventListener("revisions", (event) => {
        try {
          const next = JSON.parse((event as MessageEvent<string>).data) as AgentRevisions;
          if (typeof next.presence !== "string" || typeof next.history !== "string" || typeof next.policy !== "string") { setLive(false); return; }
          if (next.presence !== revisions.presence || next.policy !== revisions.policy) {
            void qc.invalidateQueries({ queryKey: agentsKey(projectId) });
          }
          if (next.history !== revisions.history) {
            void qc.invalidateQueries({ queryKey: agentConversationsKey(projectId) });
            void qc.invalidateQueries({ queryKey: ["agents", projectId ?? null, "messages"] });
          }
          revisions = next;
        } catch {
          // A malformed signal is not data. Keep the bounded polling recovery active.
          setLive(false);
        }
      });
      source.onerror = () => {
        setLive(false);
        source?.close();
        failures += 1;
        timer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)));
      };
    };
    created.close = () => { stopped = true; clearTimeout(timer); source?.close(); };
    scopes.set(key, created);
    entry = created;
    connect();
  }
  entry.listeners.add(listener);
  listener(entry.live);
  return () => {
    entry.listeners.delete(listener);
    if (!entry.listeners.size) { entry.close(); scopes.delete(key); }
  };
}

function useAgentStream(projectId?: string) {
  const qc = useQueryClient();
  const [live, setLive] = useState(false);
  useEffect(() => subscribe(qc, projectId, setLive), [qc, projectId]);
  return live;
}

export function useAgents(projectId?: string) {
  const live = useAgentStream(projectId);
  return useQuery({
    queryKey: agentsKey(projectId), queryFn: () => api.agents(projectId),
    refetchInterval: projectId === "demo" ? false : live ? 45_000 : 15_000,
  });
}

export function useAgentConversations(projectId?: string) {
  const live = useAgentStream(projectId);
  return useInfiniteQuery({
    queryKey: agentConversationsKey(projectId),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api.agentConversations(projectId, { cursor: pageParam }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: projectId === "demo" || live ? false : 60_000,
  });
}

export function useAgentMessages(threadId: string | null, projectId?: string) {
  const live = useAgentStream(projectId);
  return useInfiniteQuery({
    queryKey: agentMessagesKey(threadId, projectId), enabled: threadId !== null,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api.agentMessages(threadId!, projectId, { cursor: pageParam }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: projectId === "demo" || live ? false : 60_000,
  });
}

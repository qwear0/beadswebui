"use client";
import { useEffect, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api, agentsBase } from "@/lib/api-client";
import type { AgentRevisions } from "@/lib/agent-protocol";

export const agentsKey = (projectId?: string) => ["agents", projectId ?? null, "snapshot"] as const;
export const agentConversationsKey = (projectId?: string) => ["agents", projectId ?? null, "conversations"] as const;
export const agentMessagesKey = (threadId: string | null, projectId?: string) => ["agents", projectId ?? null, "messages", threadId] as const;

type StreamState = { live: boolean; continuity: number | null };
const disconnected: StreamState = { live: false, continuity: null };
type LiveSubscription = { listeners: Set<(state: StreamState) => void>; state: StreamState; close: () => void };
const clients = new WeakMap<QueryClient, Map<string, LiveSubscription>>();
let nextContinuity = 0;

function subscribe(qc: QueryClient, projectId: string | undefined, listener: (state: StreamState) => void) {
  if (projectId === "demo") return () => {};
  let scopes = clients.get(qc);
  if (!scopes) { scopes = new Map(); clients.set(qc, scopes); }
  const key = projectId === undefined ? "global" : `project:${projectId}`;
  let entry = scopes.get(key);
  if (!entry) {
    const listeners = new Set<(state: StreamState) => void>();
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let failures = 0;
    let revisions: Partial<AgentRevisions> = {};
    let recoveryAttempt = 0;
    let recoveryPending = false;
    const created: LiveSubscription = { listeners, state: disconnected, close: () => {} };
    const setState = (state: StreamState) => { created.state = state; listeners.forEach((fn) => fn(state)); };
    const disconnect = () => {
      recoveryAttempt += 1;
      recoveryPending = false;
      setState(disconnected);
    };
    const connect = () => {
      if (stopped || typeof EventSource === "undefined") return;
      source = new EventSource(`${agentsBase(projectId)}/stream`);
      source.onopen = () => { failures = 0; setState({ ...created.state, live: true }); };
      source.addEventListener("revisions", (event) => {
        try {
          const next = JSON.parse((event as MessageEvent<string>).data) as AgentRevisions;
          if (typeof next.presence !== "string" || typeof next.history !== "string" || typeof next.policy !== "string") { disconnect(); return; }
          if (next.presence !== revisions.presence || next.policy !== revisions.policy) {
            void qc.invalidateQueries({ queryKey: agentsKey(projectId) });
          }
          const recovering = created.state.continuity === null;
          if (next.history !== revisions.history || (recovering && !recoveryPending)) {
            const refreshed = qc.invalidateQueries({ queryKey: agentConversationsKey(projectId) });
            void qc.invalidateQueries({ queryKey: ["agents", projectId ?? null, "messages"] });
            if (recovering) {
              recoveryPending = true;
              const attempt = ++recoveryAttempt;
              // The recovered snapshot is a baseline, even if the revision is unchanged.
              // Only the latest refresh on this connection may restore continuity.
              void refreshed.then(() => {
                if (stopped || attempt !== recoveryAttempt) return;
                recoveryPending = false;
                setState({ live: true, continuity: ++nextContinuity });
              });
            }
          }
          revisions = next;
        } catch {
          // A malformed signal is not data. Keep the bounded polling recovery active.
          disconnect();
        }
      });
      source.onerror = () => {
        disconnect();
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
  listener(entry.state);
  return () => {
    entry.listeners.delete(listener);
    if (!entry.listeners.size) { entry.close(); scopes.delete(key); }
  };
}

function useAgentStream(projectId?: string) {
  const qc = useQueryClient();
  const [state, setState] = useState(disconnected);
  useEffect(() => subscribe(qc, projectId, setState), [qc, projectId]);
  return state;
}

export function useAgents(projectId?: string) {
  const { live } = useAgentStream(projectId);
  return useQuery({
    queryKey: agentsKey(projectId), queryFn: () => api.agents(projectId),
    refetchInterval: projectId === "demo" ? false : live ? 45_000 : 15_000,
  });
}

export function useAgentConversations(projectId?: string) {
  const { live, continuity } = useAgentStream(projectId);
  const query = useInfiniteQuery({
    queryKey: agentConversationsKey(projectId),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api.agentConversations(projectId, { cursor: pageParam }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: projectId === "demo" || live ? false : 60_000,
  });
  return { ...query, streamContinuity: continuity };
}

export function useAgentMessages(threadId: string | null, projectId?: string) {
  const { live } = useAgentStream(projectId);
  return useInfiniteQuery({
    queryKey: agentMessagesKey(threadId, projectId), enabled: threadId !== null,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api.agentMessages(threadId!, projectId, { cursor: pageParam }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: projectId === "demo" || live ? false : 60_000,
  });
}

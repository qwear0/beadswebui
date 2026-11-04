"use client";

import * as React from "react";
import { useUrlState } from "@/hooks/use-url-state";

export interface AgentFilters {
  agentId: string | null;
  instanceId: string | null;
  epicId: string | null;
  issueId: string | null;
  threadId: string | null;
}

const keys = {
  agentId: "agent", instanceId: "instance", epicId: "epic",
  issueId: "issue", threadId: "thread",
} as const;

/** Agent filters are explicit runtime context, never Beads assignees or actors. */
export function useAgentFilters() {
  const { searchParams, updateUrl } = useUrlState();
  const filters: AgentFilters = {
    agentId: searchParams.get("agent") || null,
    instanceId: searchParams.get("instance") || null,
    epicId: searchParams.get("epic") || null,
    issueId: searchParams.get("issue") || null,
    threadId: searchParams.get("thread") || null,
  };
  const setFilters = React.useCallback((patch: Partial<AgentFilters>, view?: "agents" | "activity" | "focus") => {
    updateUrl(params => {
      for (const key of Object.keys(keys) as (keyof AgentFilters)[]) {
        if (!(key in patch)) continue;
        const value = patch[key];
        if (value) params.set(keys[key], value);
        else params.delete(keys[key]);
      }
      if (view) params.set("view", view);
    });
  }, [updateUrl]);
  const clearFilters = React.useCallback(() => setFilters({
    agentId: null, instanceId: null, epicId: null, issueId: null, threadId: null,
  }), [setFilters]);
  return { filters, setFilters, clearFilters };
}

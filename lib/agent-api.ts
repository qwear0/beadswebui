import "server-only";
import type { AgentConversationsResponse, AgentMessagesResponse, AgentsResponse, AgentRevisions, AgentTelemetryError } from "./agent-protocol";
import { AgentReadError, MESSAGE, digest, readHistory, readRegistry, requireProject, telemetry, visiblePresence } from "./agent-projection";
import { acquireAgentObserver, type AgentObserver } from "./agent-watch";
import { registerSseStream } from "./sse-registry";

function json(data: unknown, status = 200) { return Response.json(data, { status, headers: { "Cache-Control": "no-store" } }); }
function errorResponse(error: unknown) {
  return json({ error: error instanceof AgentReadError ? error.message : "Agent workspace read failed", code: error instanceof AgentReadError ? error.code : "agent_read_error" }, error instanceof AgentReadError ? error.status : 503);
}
const demoPolicy = { autoWake: null, revision: null, error: null };
const demoRevisions = { presence: "demo", history: "demo", policy: "demo" };
function policyErrors(observer: AgentObserver): AgentTelemetryError[] {
  return observer.policy.error ? [{ source: "policy", code: "settings_unavailable", message: observer.policy.error }] : [];
}
export async function agentsSnapshot(projectId?: string): Promise<Response> {
  if (projectId === "demo") return json({ availability: "demo", agents: [], policy: demoPolicy, revisions: demoRevisions, errors: [], observedAt: new Date().toISOString() } satisfies AgentsResponse);
  let release = () => {};
  try {
    const registry = readRegistry();
    requireProject(registry, projectId);
    const acquired = acquireAgentObserver(); release = acquired.release;
    const observer = acquired.observer;
    const projection = visiblePresence(observer.presence, registry, projectId);
    return json({ ...projection, policy: observer.policy, revisions: observer.revisions, errors: [...projection.errors, ...observer.errors, ...policyErrors(observer)], observedAt: new Date().toISOString() } satisfies AgentsResponse);
  } catch (error) {
    if (error instanceof AgentReadError && error.status < 500) return errorResponse(error);
    return json({ availability: "unavailable", agents: [], policy: { autoWake: null, revision: null, error: "Runtime messaging policy could not be read" }, revisions: { presence: "unavailable", history: "unavailable", policy: "unavailable" }, errors: [telemetry("state", error)], observedAt: new Date().toISOString() } satisfies AgentsResponse);
  } finally { release(); }
}

export async function agentsHistory(request: Request, projectId?: string, threadId?: string): Promise<Response> {
  const messages = threadId !== undefined;
  if (messages && !MESSAGE.test(threadId)) return errorResponse(new AgentReadError("invalid_thread", "Invalid conversation thread ID", 400));
  if (projectId === "demo") return json(messages ? { availability: "demo", messages: [], nextCursor: null, errors: [] } satisfies AgentMessagesResponse : { availability: "demo", conversations: [], nextCursor: null, errors: [] } satisfies AgentConversationsResponse);
  let release = () => {};
  try {
    const params = new URL(request.url).searchParams;
    const rawLimit = params.get("limit");
    if ((rawLimit !== null && !/^[1-9][0-9]{0,2}$/.test(rawLimit)) || params.getAll("cursor").length > 1 || params.getAll("limit").length > 1) throw new AgentReadError("invalid_page", "Invalid history paging arguments", 400);
    const limit = rawLimit === null ? 30 : Number(rawLimit);
    if (limit > 100) throw new AgentReadError("invalid_page", "History limit must be between 1 and 100", 400);
    const cursor = params.get("cursor");
    if (cursor !== null && (cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor))) throw new AgentReadError("invalid_cursor", "Invalid history cursor encoding", 400);
    const registry = readRegistry(); requireProject(registry, projectId);
    const acquired = acquireAgentObserver(); release = acquired.release;
    const { observer } = acquired;
    if (observer.presence.availability === "unavailable") return json({ availability: "unavailable", ...(messages ? { messages: [] } : { conversations: [] }), nextCursor: null, errors: observer.presence.errors });
    const key = digest({ registry: registry.revision, projectId, threadId, cursor, limit });
    let page = observer.pages.get(key)?.revision === observer.revisions.history ? observer.pages.get(key)!.value as ReturnType<typeof readHistory> : undefined;
    if (!page) {
      page = readHistory(observer.root, registry, projectId, threadId, cursor, limit);
      observer.pages.set(key, { revision: observer.revisions.history, value: page });
      while (observer.pages.size > 32) observer.pages.delete(observer.pages.keys().next().value!);
      observer.observeHistory(page.watchPaths);
    }
    return json({ availability: "available", ...(messages ? { messages: page.messages } : { conversations: page.conversations }), nextCursor: page.nextCursor, errors: page.errors });
  } catch (error) {
    if (error instanceof AgentReadError && error.status < 500) return errorResponse(error);
    return json({ availability: "unavailable", ...(messages ? { messages: [] } : { conversations: [] }), nextCursor: null, errors: [telemetry("history", error)] });
  } finally { release(); }
}

export async function agentsStream(request: Request, projectId?: string): Promise<Response> {
  if (projectId === "demo") return new Response(null, { status: 204 });
  let acquired: ReturnType<typeof acquireAgentObserver>;
  try { const registry = readRegistry(); requireProject(registry, projectId); acquired = acquireAgentObserver(); }
  catch (error) { return errorResponse(error); }
  const encoder = new TextEncoder();
  let close = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let unsubscribe = () => {};
      let unregister = () => {};
      const heartbeat: { current?: ReturnType<typeof setInterval> } = {};
      const send = (chunk: string) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(chunk)); } catch { close(); }
      };
      close = () => {
        if (closed) return;
        closed = true; clearInterval(heartbeat.current); unsubscribe(); unregister(); acquired.release();
        request.signal.removeEventListener("abort", close);
        try { controller.close(); } catch { /* Cancellation may already have closed the controller. */ }
      };
      unregister = registerSseStream(close);
      unsubscribe = acquired.observer.subscribe((revisions: AgentRevisions) => send(`event: revisions\ndata: ${JSON.stringify(revisions)}\n\n`));
      if (closed) { unsubscribe(); return; }
      heartbeat.current = setInterval(() => send(": ping\n\n"), 25_000);
      request.signal.addEventListener("abort", close, { once: true });
      if (request.signal.aborted) close();
    },
    cancel() { close(); },
  });
  return new Response(body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" } });
}

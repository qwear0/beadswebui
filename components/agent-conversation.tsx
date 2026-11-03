"use client";

import Link from "next/link";
import { useAgentConversations, useAgentMessages } from "@/hooks/use-agents";
import { useAgentFilters } from "@/hooks/use-agent-filters";
import { agentKey, matchesAgent } from "@/lib/agent-ui";
import type { AgentAddress, AgentConversation as Conversation, AgentMessage, AgentReceipt, AgentSnapshot } from "@/lib/agent-protocol";
import { agentControlClass } from "@/components/agent-summary";

export function AgentConversation({ projectId, contextProjectId, insideIds, issueId, agents }: {
  projectId?: string; contextProjectId: string; insideIds: Set<string> | null; issueId: string | null; agents: AgentSnapshot[];
}) {
  const { filters, setFilters } = useAgentFilters();
  const conversations = useAgentConversations(projectId);
  const pages = conversations.data?.pages ?? [];
  const records = pages.flatMap(page => page.conversations);
  const matchesContext = (record: Pick<Conversation, "participants" | "bead">) =>
    (!filters.agentId && !filters.instanceId || record.participants.some(address => matchesAgent(address, filters))) &&
    (!insideIds || !!record.bead && record.bead.projectId === contextProjectId && insideIds.has(record.bead.beadId)) &&
    (!issueId || record.bead?.projectId === contextProjectId && record.bead.beadId === issueId);
  // A thread can have multiple explicit bead contexts. Filter records before
  // deduplicating, or an unrelated newest record would hide matching history.
  const byThread = new Map<string, Conversation>();
  for (const conversation of records.filter(matchesContext).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    const previous = byThread.get(conversation.threadId);
    byThread.set(conversation.threadId, previous ? { ...previous, participantProjects: [...new Set([...previous.participantProjects, ...conversation.participantProjects])] } : conversation);
  }
  const visible = [...byThread.values()];
  const selected = records.find(record => record.threadId === filters.threadId);
  const selectedThread = filters.threadId;
  const messages = useAgentMessages(selectedThread, projectId);
  const messagePages = messages.data?.pages ?? [];
  const byMessage = new Map<string, AgentMessage>();
  for (const page of messagePages) for (const message of page.messages) byMessage.set(message.messageId, message);
  const allMessages = [...byMessage.values()];
  const visibleMessages = allMessages.filter(message => matchesContext({ participants: [message.sender, message.recipient], bead: message.bead })).map(message => ({
    ...message,
    // A linked reply proves an answer without requiring an acknowledgement.
    answeredBy: [...new Set([...message.answeredBy, ...allMessages.filter(reply =>
      reply.kind === "reply" && reply.inReplyTo === message.messageId && reply.threadId === message.threadId &&
      agentKey(reply.sender) === agentKey(message.recipient) && agentKey(reply.recipient) === agentKey(message.sender) &&
      reply.senderProjectId === message.recipientProjectId && reply.recipientProjectId === message.senderProjectId).map(reply => reply.messageId)])],
  }));
  const availability = pages[0]?.availability;
  return <section aria-label="Read-only agent conversations" className="min-w-0 border-t border-border pt-4">
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <h2 className="text-sm font-semibold">Conversations</h2>
      <span className="text-xs text-muted-foreground">Read-only · send messages and change wake settings in pi_qr, not this browser.</span>
    </div>
    <p className="mb-3 text-xs text-muted-foreground">Agent/epic/issue filters apply to loaded thread records and messages with explicit context. No runtime events are added to Beads issue history.</p>
    {conversations.isLoading && <p role="status" className="p-3 text-xs">Loading conversations…</p>}
    {conversations.error && <p role="alert" className="p-3 text-xs text-destructive">Conversation history unavailable: {conversations.error.message}</p>}
    {availability === "unavailable" && <p className="p-3 text-xs text-destructive">Conversation storage is unavailable, not empty.</p>}
    {availability === "demo" && <p className="p-3 text-xs text-muted-foreground">Demo has no real conversation history.</p>}
    {pages.flatMap(page => page.errors).map((error, i) => <p key={`${error.code}/${i}`} className="p-2 text-xs text-destructive">{error.source}: {error.code} · {error.message}</p>)}
    <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(200px,1fr)_minmax(0,2fr)]">
      <div className="min-w-0">
        <ul className="space-y-2">{visible.map(thread => <li key={thread.threadId}>
          <button className={`${agentControlClass} w-full break-words p-3 text-left ${filters.threadId === thread.threadId ? "ring-2 ring-[var(--brand)]" : ""}`} aria-current={filters.threadId === thread.threadId ? "true" : undefined} onClick={() => setFilters({ threadId: thread.threadId })}>
            <span className="block break-all font-mono">{thread.threadId}</span>
            <span className="mt-1 block">{thread.preview || "No preview"}</span>
            <span className="mt-1 block text-muted-foreground">Participant projects: {thread.participantProjects.join(" ↔ ") || "unknown"}</span>
            <span className="block text-muted-foreground">{thread.transport === "native_projection" ? "Native owner-worker projection" : "Coordinator mailbox"}</span>
            <time className="block text-muted-foreground">Latest matching message (loaded pages): {thread.updatedAt}</time>
          </button>
        </li>)}</ul>
        {!conversations.isLoading && !conversations.error && availability === "available" && visible.length === 0 && <p className="p-3 text-xs text-muted-foreground">No matching conversations in loaded pages.{conversations.hasNextPage ? " More history is available." : ""}</p>}
        {conversations.hasNextPage && <button className={`${agentControlClass} mt-3`} disabled={conversations.isFetchingNextPage} onClick={() => void conversations.fetchNextPage()}>{conversations.isFetchingNextPage ? "Loading…" : "Load more conversations"}</button>}
      </div>
      <div className="min-w-0 rounded-lg border border-border p-3">
        {!selectedThread ? <p className="text-xs text-muted-foreground">Choose a conversation. Receipt, context durability, linked replies and native Delivery ACK are independent facts.</p> : <>
          <div className="mb-3 flex flex-wrap items-center gap-2"><h3 className="min-w-0 break-all font-mono text-xs">{selectedThread}</h3><button className={agentControlClass} onClick={() => setFilters({ threadId: null })}>Close conversation</button></div>
          {!selected && <p className="mb-2 text-xs text-muted-foreground">Bookmarked thread is not in the loaded conversation pages. Only server-authorized messages for this scope are requested.</p>}
          {messages.isLoading && <p role="status" className="text-xs">Loading messages…</p>}
          {messages.error && <p role="alert" className="text-xs text-destructive">Message history unavailable: {messages.error.message}</p>}
          {messagePages[0]?.availability === "unavailable" && <p className="text-xs text-destructive">Message history storage unavailable.</p>}
          {messagePages.flatMap(page => page.errors).map((error, i) => <p key={`${error.code}/${i}`} className="text-xs text-destructive">{error.source}: {error.code} · {error.message}</p>)}
          <ol className="space-y-3">{visibleMessages.map(message => <li key={message.messageId}><MessageCard message={message} agents={agents} /></li>)}</ol>
          {!messages.isLoading && !messages.error && messagePages[0]?.availability === "available" && visibleMessages.length === 0 && <p className="text-xs text-muted-foreground">No matching messages in the loaded, authorized thread pages.{messages.hasNextPage ? " More messages are available." : ""}</p>}
          {messages.hasNextPage && <button className={`${agentControlClass} mt-3`} disabled={messages.isFetchingNextPage} onClick={() => void messages.fetchNextPage()}>{messages.isFetchingNextPage ? "Loading…" : "Load more messages"}</button>}
        </>}
      </div>
    </div>
  </section>;
}

function Address({ address, agents }: { address: AgentAddress; agents: AgentSnapshot[] }) {
  const { setFilters } = useAgentFilters();
  const agent = agents.find(item => agentKey(item) === agentKey(address));
  return <button className="break-all text-left text-[var(--brand)] underline focus-visible:outline focus-visible:outline-2" onClick={() => setFilters({ agentId: address.agentId, instanceId: address.instanceId })}>{agent?.label ?? "Agent"} · {address.agentId} / {address.instanceId}</button>;
}

function MessageCard({ message, agents }: { message: AgentMessage; agents: AgentSnapshot[] }) {
  return <article className="min-w-0 rounded-lg border border-border bg-[var(--surface)] p-3 text-xs">
    <h4 className="mb-2 break-all font-mono font-medium">{message.kind} · {message.messageId}</h4>
    <dl className="space-y-1 text-muted-foreground">
      <div><dt className="inline font-medium">From: </dt><dd className="inline"><Address address={message.sender} agents={agents} /> · sender project <ProjectIdentity projectId={message.senderProjectId} /></dd></div>
      <div><dt className="inline font-medium">To: </dt><dd className="inline"><Address address={message.recipient} agents={agents} /> · recipient project <ProjectIdentity projectId={message.recipientProjectId} /></dd></div>
      <div><dt className="inline font-medium">Transport: </dt><dd className="inline">{message.transport}</dd></div>
      <div><dt className="inline font-medium">{message.transport === "coordinator_mail" ? "Durably accepted" : "Native fact projected"}: </dt><dd className="inline">{message.acceptedAt}</dd></div>
      <div><dt className="inline font-medium">Reply to: </dt><dd className="inline break-all">{message.inReplyTo ?? "none"}</dd></div>
      {message.bead && <div><dt className="inline font-medium">Bead: </dt><dd className="inline"><Link className="text-[var(--brand)] underline" href={`/p/${encodeURIComponent(message.bead.projectId)}?bead=${encodeURIComponent(message.bead.beadId)}`}>{message.bead.projectId} / {message.bead.beadId}</Link></dd></div>}
    </dl>
    <p className="my-3 whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{message.body}</p>
    <div className="border-t border-border pt-2">
      <p className="mb-2 text-muted-foreground">Independent facts · no missing delivery stage is inferred.</p>
      <ul className="space-y-1">{message.receipts.map(receipt => <li key={receipt.factId} className="break-words"><ReceiptFact receipt={receipt} /></li>)}</ul>
      {(["received", "in_context", "acknowledged", "native_ack"] as const).filter(kind => !message.receipts.some(receipt => receipt.kind === kind)).map(kind => <p key={kind} className="text-muted-foreground">{({ received: "Receipt", in_context: "Context entry / durability", acknowledged: "Explicit acknowledgement", native_ack: "Native Delivery ACK" })[kind]}: not observed</p>)}
      <p className="mt-2 break-all">Answered by linked reply (observed pages): {message.answeredBy.length ? message.answeredBy.join(", ") : "not observed"}</p>
      {message.native && <details className="mt-2"><summary className="cursor-pointer">Native correlation (not lifecycle authority)</summary><dl className="mt-2 break-all">{Object.entries(message.native).map(([key, value]) => <div key={key}><dt className="inline font-medium">{key}: </dt><dd className="inline">{value ?? "unknown"}</dd></div>)}</dl></details>}
    </div>
  </article>;
}

function ProjectIdentity({ projectId }: { projectId: string }) {
  return <Link href={`/p/${encodeURIComponent(projectId)}?view=agents`} className="break-all text-[var(--brand)] underline">{projectId}</Link>;
}

function ReceiptFact({ receipt }: { receipt: AgentReceipt }) {
  let text: string;
  switch (receipt.kind) {
    case "received": text = `Received by exact instance · wake eligible: ${receipt.wakeEligible ? "yes" : "no"} · settings revision ${receipt.settingsRevision ?? "unknown"}${receipt.nativeDeliveryId ? ` · native Delivery observed: ${receipt.nativeDeliveryId} (correlation only; not ACK)` : ""}`; break;
    case "in_context": text = `Context entry observed · ${receipt.durability === "persisted" ? "persisted durability evidenced" : "in memory only; persistence not established"} · entry ${receipt.entryId} · session ${receipt.sessionId}`; break;
    case "native_ack": text = `Native Delivery ACK · ${receipt.deliveryId} (not a generic receipt)`; break;
    case "acknowledged": text = "Explicit message-ID acknowledgement"; break;
    case "attempt": text = `Injection attempt · unconfirmed · ${receipt.attemptId} · settings revision ${receipt.settingsRevision}`; break;
    case "outcome": text = `Outcome: ${receipt.outcome} · ${receipt.code}`; break;
  }
  return <span className="[overflow-wrap:anywhere]">{text} · {receipt.observedAt} · observer {agentKey(receipt.address)}</span>;
}

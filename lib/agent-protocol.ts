/** Browser projection of the sanitized pi_qr v1 data contract; no runtime imports. */
export interface AgentAddress { agentId: string; instanceId: string }
export interface AgentBeadRef { projectId: string; beadId: string }
export interface AgentTelemetryError { code: string; message: string; source: "presence" | "history" | "policy" | "registry" | "state"; recordId?: string }
export interface AgentParent { agentId: string; instanceId: string | null; sessionId: string; bindingId: string; dispatchId: string; taskId: string }
export interface AgentTool { id: string; name: string; startedAt: string }
export interface AgentSnapshot extends AgentAddress {
  label: string;
  role: "coordinator" | "worker" | "unverified";
  parent: AgentParent | null;
  projectId: string | null;
  linkage: "linked" | "unlinked";
  bead: AgentBeadRef | null;
  summary: string | null;
  model: { provider: string; id: string } | null;
  cwd: string;
  worktree: string | null;
  commonDir: string | null;
  sessionId: string;
  installationId: string;
  source: "native_session" | "admitted_worker" | "historical_worker" | "unverified";
  capabilities: { coordinatorMail: boolean; nativeOwnerChannel: boolean };
  observedAt: string;
  activatedAt: string;
  lastWorkAt: string | null;
  liveness: "online" | "stale" | "ended" | "unknown";
  workState: "idle" | "working" | "waiting" | "error" | "unknown";
  currentTools: AgentTool[];
  suspended: boolean;
  conflict: boolean;
  diagnostics: string[];
}
export interface AgentPolicy { autoWake: boolean | null; revision: string | null; error: string | null }
export interface AgentRevisions { presence: string; history: string; policy: string }
export type AgentAvailability = "available" | "unavailable" | "demo";
export interface AgentsResponse {
  availability: AgentAvailability;
  agents: AgentSnapshot[];
  policy: AgentPolicy;
  revisions: AgentRevisions;
  errors: AgentTelemetryError[];
  observedAt: string;
}
export interface AgentConversation {
  threadId: string;
  participantProjects: string[];
  participants: AgentAddress[];
  bead: AgentBeadRef | null;
  kind: "note" | "question" | "reply";
  preview: string;
  /** Root acceptance time only for a root-envelope summary; otherwise unknown. */
  startedAt: string | null;
  /** This envelope's acceptance/projection time, not a whole-thread update time. */
  updatedAt: string;
  transport: "coordinator_mail" | "native_projection";
}
export type AgentReceipt = {
  version: 1; messageId: string; factId: string; address: AgentAddress; observedAt: string;
} & (
  | { kind: "received"; settingsRevision: string | null; wakeEligible: boolean; nativeDeliveryId?: string }
  | { kind: "attempt"; attemptId: string; messageIds: string[]; settingsRevision: string; outcome: "unconfirmed" }
  | { kind: "in_context"; entryId: string; sessionId: string; durability: "memory" | "persisted" }
  | { kind: "acknowledged" }
  | { kind: "native_ack"; deliveryId: string }
  | { kind: "outcome"; outcome: "expired" | "rejected" | "unconfirmed"; code: string }
);
export interface AgentMessage {
  messageId: string;
  threadId: string;
  sender: AgentAddress;
  recipient: AgentAddress;
  senderProjectId: string;
  recipientProjectId: string;
  bead: AgentBeadRef | null;
  inReplyTo: string | null;
  kind: "note" | "question" | "reply";
  body: string;
  acceptedAt: string;
  transport: "coordinator_mail" | "native_projection";
  native: { bindingId: string; dispatchId: string; taskId: string; messageId: string | null; questionId: string | null; deliveryId: string | null; kind: string } | null;
  /** Independent observations; neither order nor absence implies a delivery stage. */
  receipts: AgentReceipt[];
  /** Linked replies observed in this page; more may occur in other pages. */
  answeredBy: string[];
}
export interface AgentConversationsResponse {
  availability: AgentAvailability;
  conversations: AgentConversation[];
  nextCursor: string | null;
  errors: AgentTelemetryError[];
}
export interface AgentMessagesResponse {
  availability: AgentAvailability;
  messages: AgentMessage[];
  nextCursor: string | null;
  errors: AgentTelemetryError[];
}
export interface AgentPageOptions { cursor?: string | null; limit?: number }

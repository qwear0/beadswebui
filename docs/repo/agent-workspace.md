# Agent Workspace: local runtime and browser contract

> Read this for the v1 Agent Workspace producer/consumer contract: ownership, identity, messaging and read-side boundaries. Source integration and fresh-process activation are separate checkpoints; this document establishes neither product acceptance nor loaded runtime state. See [the repository map](repo_structure.md).

## 1. Scope and owner

- owner: The existing pi_qr extension in `/apps/pi_quality_runtime`, registered by its `src/index.ts`, is the sole Pi extension owner of presence, exact identity, coordinator mail, settings and native owner-worker projection. Beadswebui is a read-only consumer, not another extension, scheduler or mailbox writer.
- contract: Passive root-session presence and coordinator mail do not require QO readiness, a Dispatch or Orca. Managed workers keep native binding restrictions; presence/messages never grant lifecycle authority.
- contract: Beads owns issues, claims and dependencies. QO/Orca owns managed scope, questions, Delivery ACK, continuation and cleanup. Needs You remains the existing human-decision surface, not an agent attention inbox.

## 2. Entry points and key paths

- contract: Runtime wire types and layout are maintained externally in `/apps/pi_quality_runtime/src/agent-protocol.ts` and `/apps/pi_quality_runtime/docs/agent-workspace.md`; no mutable runtime code is imported by the app.
- code: `lib/agent-protocol.ts` defines browser-safe projection types; `lib/agent-projection.ts` validates and reads sanitized local records.
- code: `lib/agent-watch.ts` and `lib/agent-api.ts` share server observation and HTTP/SSE handling; `lib/api-client.ts` and `hooks/use-agents.ts` own browser reads.
- doc: [Configuration](configuration.md), [API](api-and-beads.md), [UI state](ui-state.md) and [operations](operations.md) cover the corresponding application boundaries.

## 3. Presence and communication flow

- step: pi_qr publishes per-instance snapshots on a 10-second heartbeat. The consumer derives stale after 45 seconds; stale is not process death, completion or last-work time.
- contract: Liveness and work state are separate. Only declared summary/bead, model, tool name/start time and sanitized diagnostics are projected, not prompts, reasoning, command arguments, output, terminal history or private lifecycle stores.
- contract: Exact addresses contain both agentId and instanceId. Agent identity derives from the installation UUID and native Pi session ID; each activation gets a fresh instance. Rename is not an address change, resume does not transfer old-instance mail, and concurrent live instances are an explicit conflict.
- contract: Role and parent derive from native session/admitted binding facts, reusing runtime tracking lineage. Labels, cwd and terminal names cannot promote a worker or prove ownership. An unproven parent instance stays null; unverified observations are not addressable.
- contract: Coordinators can address other coordinators across registered projects. Workers communicate only through their current owning coordinator's native channel; no peer-worker mailbox, foreign-coordinator route or browser worker continuation exists.
- contract: Native messages/receipts are sanitized mirrors, not a second Delivery consumer. Native success survives mirror failure; surface the projection gap and never repeat the native effect to repair history. A generic mail acknowledgement is not native Delivery ACK.

## 4. Storage, wake and read-side contracts

- contract: Runtime state is `$XDG_STATE_HOME/pi-quality-runtime/agents/v1`, default `~/.local/state/pi-quality-runtime/agents/v1`; settings are `$XDG_CONFIG_HOME/pi-quality-runtime/agent-workspace.json`, default `~/.config/pi-quality-runtime/agent-workspace.json`. Same-user local access is the trust boundary, not an adversarial sandbox.
- contract: Replaceable presence, exact-instance pending lookup and immutable retained messages/receipts are separate. Bounded hourly history uses paged reads; heartbeat and inbox reconciliation must not scan retained history. Accepted mail survives web-app downtime; delivery expiry is not history deletion.
- contract: The app registry in `lib/config.ts` remains project authority. Runtime reads only its stored project IDs/paths, using canonical paths and Git common-directory evidence or registered non-Git folders. Missing/ambiguous mapping stays unlinked or blocks routing, never creates another registry. Bead references are `(projectId, beadId)`; actor/assignee history is not rewritten.
- contract: Envelopes retain exact participants, both participant project IDs, thread/reply correlation and bodies bounded to 16 KiB UTF-8. Attribution is fixed at acceptance. Sender-scoped operationKey retries preserve the original request/instance; after uncertainty inspect/retry that key, never mint a new send or retarget on resume.
- contract: Durable acceptance, received, attempted injection, in-context memory/persisted evidence, optional acknowledgement and native ACK are independent facts. A linked reply establishes answered without a prior ACK. Missing facts or a void host return prove neither non-delivery nor durable execution; no exactly-once claim is made.
- contract: `agentMessaging.autoWake` defaults to true; runtime initializes a unique persisted revision before wake eligibility. Missing settings mean default-on with an uninitialized/null web revision, not proof of active wake. Invalid/unreadable settings suppress wake with an error. Runtime user commands own mutations; the browser cannot initialize settings or invent a revision.
- contract: Busy mail remains durable. Only an eligible idle coordinator may start a distinct labelled custom run, never followUp, steering or generic nextTurn injection. Recheck exact instance, role, current idle/lifetime, suspension and current settings revision immediately before submission.
- contract: Receipt eligibility is revision-bound. Disable or a revision change cannot promote already-received backlog; re-enable is not replay. Cancellation/provider errors suspend automatic processing until user resumption; ambiguous attempts are not automatically reinjected. Custom-trigger worker-launch restrictions remain intact and workers never auto-wake through this setting.
- contract: Global/project browser reads enforce current registration server-side. Cross-project threads retain both project identities and deduplicate globally; project history must exclude unrelated messages. Cursors bind scope, thread where applicable and a high-water boundary; they are not authorization.
- contract: Presence, conversation history and Beads queries/invalidation are separate. A heartbeat must not invoke bd or refetch message bodies. Demo has no real agents or mail; empty, unavailable, unlinked, stale and conflicting observations must remain distinguishable.

## 5. Verification and activation limits

- check: Follow [verification policy](verification.md). The doc audit checks anchors and structure, not runtime mail delivery, UI reconnect or settings propagation.
- check: Verify producer and consumer source together. Source/types/docs do not establish a fresh loaded extension, worker snapshot or deployed web app. Activation belongs to the owning integration process, not this documentation workflow; never reload or stop unrelated workers.
- failure-clue: Unavailable state can mean missing publication, permissions, malformed records or a different OS user/container home. Do not create a disconnected second bus or silently fall back to demo.
- contract: Host/origin guards and viewer mode are not authentication. Browser sending/settings/control require a separate access-boundary decision. Local spool storage does not make model processing offline: mail inserted into context may reach the recipient's configured provider.

## 6. Update triggers

Update this document when runtime ownership, sanitized protocol/layout, exact identity, native topology, registry mapping, settings revisions, wake eligibility, history pagination, API/query isolation or activation boundaries change. Keep the narrow guides and repository map aligned; never infer activation from a source change.

# Global Dashboard and activity descriptions

> Read this for the project-independent dashboard. See [the repository map](repo_structure.md), [Agent Workspace](agent-workspace.md), and [configuration](configuration.md) for its existing data owners.

## 1. Scope and owner

- owner: The web application aggregates registered projects' existing Beads activity and sanitized runtime message history. It does not change pi_quality_runtime or create another mailbox.
- contract: `/dashboard` is independent of the selected project and project URL filters. Demo and unregistered projects do not contribute activity.
- contract: Neuro-gate mediates model requests server-side. Event text sent for descriptions can reach the selected external provider; local cache storage does not make inference offline.

## 2. Entry points and key paths

- entrypoint: `app/dashboard/page.tsx` and `components/dashboard.tsx` — standalone agent cards and right-hand activity feed; launcher/sidebar links open this route.
- code: `components/agent-topology.tsx` — shared `AgentPresenceCard`; Dashboard renders it as a non-interactive article with the project display name.
- code: `components/dashboard-event-detail.tsx` — centered read-only issue details and exact-message details, reusing `components/bead-detail-drawer.tsx` and `components/agent-conversation.tsx`.
- code: `components/dashboard-settings.tsx`, `hooks/use-dashboard.ts`, and `lib/api-client.ts` — settings modal and browser queries.
- code: `lib/dashboard-activity.ts`, `lib/dashboard-settings.ts`, `lib/dashboard-summaries.ts`, and `lib/dashboard-types.ts` — aggregation, durable settings, inference/cache, and shared DTO/default prompt.
- entrypoint: `app/api/dashboard/activity/route.ts`, `app/api/dashboard/settings/route.ts`, `app/api/dashboard/summaries/route.ts`, and `app/api/dashboard/messages/[messageId]/route.ts` — HTTP wiring.

## 3. Main flow

1. Dashboard subscribes to the existing global agent snapshot/stream. Only fresh online instances appear; a heartbeat does not query Beads or generate descriptions.
2. The activity request reuses `buildActivity` and the existing store for each registered real project, retaining the same newest 150 issue events per project as Activity. Collection reads share a 15-second promise cache; project failures remain visible instead of becoming sample data.
3. Sanitized coordinator mail and native owner-worker projections are merged newest-first by canonical message ID, without per-card receipt scans. Each page reads at most 100 messages within the existing bounded history scan. Its cursor binds registration, a fixed high-water boundary, and descending order, separately from existing conversation cursors.
4. The browser polls activity every 20 seconds; global history revision signals also invalidate it. Scroll loads older message pages and reveals additional cards. Issue and message IDs are deduplicated before sorting.
5. Visible event keys are submitted in batches of up to four. The server resolves event references to observed source data, rechecks project registration, and generates only uncached descriptions. Missing in-memory sources are reconstructed from the exact message or current issue activity; route bundles/restarts need not share memory. Generation is serialized with a bounded queue so concurrent views reuse completed cache entries.
6. Clicking an issue opens the existing issue information centrally, in a read-only project context with an internal detail trail. Clicking mail loads that exact authorized message plus independent receipt facts centrally. Neither action selects another project or records a runtime tool-read receipt.

## 4. Contracts and persistence

| Endpoint | Method | Contract |
| --- | --- | --- |
| `/api/dashboard/activity` | GET | `{ items, nextCursor, errors }`; first page includes project issue activity, continuation pages contain older mail. Optional `cursor` is opaque and scope-bound. |
| `/api/dashboard/messages/{messageId}` | GET | `{ message, errors }`; both participant projects must still be registered. No whole-thread scan. |
| `/api/dashboard/settings` | GET, PUT | Model, reasoning effort, and prompt only. PUT atomically persists the full validated object; no gateway credentials in the DTO. |
| `/api/dashboard/summaries` | POST | `{ events: [{ key, id }] }`, one to four observed SHA-256 keys with project-qualified event/canonical message IDs; returns `{ summaries, errors }` keyed by event. Source content is reconstructed server-side and checked against the key, never accepted as client prose. |

- contract: Defaults are `subshare_api/gpt-6-luna` through Neuro-gate, reasoning effort `xhigh`, and the manager-oriented Russian prompt in `lib/dashboard-types.ts`.
- contract: Descriptions target 150–170 characters with a small natural overrun allowed. There is exactly one generation request per uncached batch, no corrective request, length rejection, truncation, or padding. Malformed/empty output and transport failures are surfaced, never replaced by invented descriptions or a different model.
- contract: The prompt treats event text as untrusted data, distinguishes requests/plans from completed work, preserves useful concrete details, and forbids inventing reasons or delivery/consent. Current issue prose is labelled as current context, not historical proof.
- contract: Settings are stored in `dashboard.json` under the app config directory, separately from general settings and runtime wake policy. Writes use a mode-0600 temporary file and atomic rename; write failures are reported.
- contract: `NEURO_GATE_URL` defaults to `http://127.0.0.1:8080/v1`. A server-only consumer token comes from `NEURO_GATE_TOKEN`, or the file selected by `NEURO_GATE_TOKEN_FILE`, defaulting to `neuro-gate-token` in the app config directory. Provision a restricted file; never use an admin/upstream key or expose it to browser code.
- contract: Descriptions persist under `$XDG_CACHE_HOME/bead-me-up-scotty/dashboard-summaries`, default `~/.cache/bead-me-up-scotty/dashboard-summaries`, in atomic mode-0600 JSON files keyed by project-qualified event identity/source content, model, effort, prompt, and cache version. Cache files contain generated text, not raw source bodies or credentials. They can still contain private task/message information and must remain local.
- contract: Changed source/settings use a new cache key; refresh does not regenerate unchanged cached descriptions. An in-memory five-minute failure cooldown prevents repeated failing submissions; the browser does not automatically retry summary queries.
- contract: The gear is the only Dashboard control outside event cards. Settings has model/effort/prompt fields. Existing project Agents and Activity retain their navigation/filtering behavior; Dashboard is not another shell view.

## 5. Verification and limits

- check: Follow [verification policy](verification.md). Prompt evaluation was explicitly requested; it does not authorize restoring application test infrastructure.
- check: Evaluate model output for factual meaning, plain Russian, length distribution, and prompt-injection resistance within the authorized request budget. A good sample does not guarantee every future description's length or factuality.
- check: Direct API reads can invoke local Beads exports. Model requests are billable/provider operations, not ordinary polling. Keep retained evaluation evidence in ignored task artifacts and never publish local tracker/mail content.
- failure-clue: Missing server credentials, unavailable projects, invalid runtime records, model/ACL errors, and cache/settings I/O errors must not appear as a healthy empty feed. Model latency may leave visible cards waiting while the single generation queue is busy.

## 6. Update triggers

Update this document when aggregation/paging, visible-card generation, settings/credential/cache locations, default model/prompt, centered details, or existing runtime ownership boundaries change.

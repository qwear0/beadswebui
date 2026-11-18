# Global Dashboard and activity descriptions

> Read this for the project-independent dashboard. See [the repository map](repo_structure.md), [Agent Workspace](agent-workspace.md), [configuration](configuration.md), and [operations](operations.md).

## 1. Scope and owner

- owner: The app aggregates registered projects' Beads activity and sanitized runtime message history; the app resolves authoritative source text. The durable SQLite queue owns accepted summary work, not a second issue/source database.
- contract: `/dashboard` is independent of selected project and URL filters. Demo/unregistered projects do not contribute activity.
- contract: Neuro-gate mediates external model requests. Event text may reach the provider; local state/cache does not make inference offline.

## 2. Entry points and key paths

- entrypoint: `app/dashboard/page.tsx`, `components/dashboard.tsx` — global agent topology and activity feed.
- code: `components/agent-topology.tsx`, `components/dashboard-event-detail.tsx`, `components/dashboard-settings.tsx` — topology, read-only details, settings UI.
- code: `lib/dashboard-activity.ts`, `lib/dashboard-settings.ts`, `lib/dashboard-summaries.ts`, `lib/dashboard-queue.ts`, `lib/dashboard-worker.ts`, `scripts/dashboard-queue.py` — activity/source resolution, settings/admission, worker authorization, and durable SQLite queue.
- entrypoint: `app/api/dashboard/activity/route.ts`, `app/api/dashboard/messages/[messageId]/route.ts`, `app/api/dashboard/settings/route.ts`, `app/api/dashboard/summaries/route.ts`, `app/api/dashboard/worker/route.ts` — browser and private executor HTTP contracts.

## 3. Main flow

1. Dashboard uses the global sanitized agent projection/stream and merges registered real-project activity with authorized mail. Project failures remain visible; Demo is excluded. Mail attribution and message detail remain read-only.
2. Activity retains the newest 150 issue events per project, reads up to two repositories concurrently per collection, and caches collection reads for 15 seconds. Browser refresh is 20 seconds; activity request timeout is 60 seconds.
3. The browser submits observed event references (key and ID), never source prose. The server re-resolves authoritative source data, verifies current registration and content identity, checks durable queue status, and reads compatible legacy cache entries only.
4. Durable admission is disabled unless `SCOTTY_DASHBOARD_DURABLE_ADMISSION=1` and a valid private worker token is configured. HTTP 202 denotes durable acceptance. Once enabled, the private executor receives opaque invitations; the app authenticates it, resolves sources for claims, and validates a claim again before returning resolved content. Completion is lease/token checked by SQLite. No raw app payload, credentials, or database is to be mounted into the control plane.
5. Worker request deadline is nominally 180 seconds with a 30-second lease margin. Timeout/lost completion is not an exact-once billing guarantee. Admission-off/capacity refusals are not accepted work; the UI must not suggest otherwise.
6. Clicking issue/mail opens centrally in read-only details; this does not select another project or record a runtime tool-read receipt. AI Assist remains the separate existing Claude CLI flow and is unaffected by summary worker admission.

## 4. Contracts and persistence

| Endpoint | Method | Contract |
| --- | --- | --- |
| `/api/dashboard/activity` | GET | `{ items, nextCursor, errors }`; cursor is opaque and scope-bound. |
| `/api/dashboard/messages/{messageId}` | GET | Exact authorized message; both participant projects must remain registered. |
| `/api/dashboard/settings` | GET, PUT | Model, optional peer model, reasoning effort, and prompt only; no gateway credentials. |
| `/api/dashboard/summaries` | POST | One to 40 event references on server; browser submits at most four. Returns `{ items }` keyed by source key and uses 202 when at least one item is durably waiting/running/retrying. HTTP 200 alone does not mean admission. |
| `/api/dashboard/worker` | POST | Authenticated private actions: invite, claim, resolve, complete, and recheck. Invites are opaque; resolved claims carry only required source and settings. No browser-facing executor controls. |

- contract: Defaults are `subshare_api/gpt-6-luna`, effort `xhigh`, and the manager-oriented Russian prompt in `lib/dashboard-types.ts`. Provider fallback is not an app-side promise.
- contract: Settings live in `dashboard.json` under app config; atomic mode-0600 write. Neuro-gate uses `NEURO_GATE_URL` (default `http://127.0.0.1:8080/v1`) and `NEURO_GATE_TOKEN` or `NEURO_GATE_TOKEN_FILE` (default `neuro-gate-token` under app config). Never expose consumer credentials to browser code.
- contract: Queue DB is `$XDG_STATE_HOME/bead-me-up-scotty/dashboard-queue.sqlite3`, default `~/.local/state/bead-me-up-scotty/dashboard-queue.sqlite3`. `BMUS_DASHBOARD_QUEUE_STATE_DIR` overrides the state base; the app-owned child directory is `bead-me-up-scotty`. SQLite is authoritative for accepted work and status; private directory/database/WAL modes are 0700/0600.
- contract: Queue bounds in `scripts/dashboard-queue.py`: 2,000 outstanding, with 250 reserved for visible work; admit/status request max 200; worker batches max four; at most two invitations per call, invitation TTL 30 seconds; active attempts max three per route; nominal deadline 180 seconds plus 30-second lease margin. These are fixed queue bounds, not a mandate to change shared limits or retry policy.
- contract: Legacy v2 generated JSON cache under `$XDG_CACHE_HOME/bead-me-up-scotty/dashboard-summaries` (default `~/.cache/bead-me-up-scotty/dashboard-summaries`) is read-only compatibility input. No new legacy cache writes. Never treat it as accepted durable queue state.
- contract: Production executor is a project-owned external stage image built from `automation/Dockerfile` (future child implementations may add further stages); pin Dagster 1.13.17 and use Enigma code location `beadswebui_automation:4000`. Stable Neuro-gate consumer configuration must set `allow_provider_fallback: false` and restrict access to the two approved routes. This describes the intended architecture, not a verified deployment.

## 5. Verification and limits

- check: Source inspected for route contracts, token-based admission gate, queue implementation, state path/modes, and constants above. Not checked: preflight, external image/code location, network isolation/deny policy, credential provisioning/ACL, sensor state, provider behavior, deployment, or billable generation.
- check: Preflight must be read-only and cover unauthenticated, invalid-auth, and valid-auth cases before intentional activation; label each result as checked or not checked. Do not activate sensor/admission without preflight and stage evidence.
- failure-clue: Missing credentials, unavailable projects, source changes, queue errors, and provider/ACL errors must remain explicit rather than appearing as a healthy empty feed. Keep generated task/message text and SQLite local/private.

## 6. Update triggers

Update this document when dashboard aggregation, source resolution, queue limits, admission/authentication, settings/cache/state locations, or executor boundaries change. Keep [operations](operations.md), [API and Beads](api-and-beads.md), and [configuration](configuration.md) synchronized.

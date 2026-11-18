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
5. Worker claim deadline is nominally 180 seconds with a 30-second lease margin. Source resolution has a separate deadline-aware request budget of up to 60 seconds and reserves at least 60 seconds of the claim for inference; other worker control requests retain a 10-second cap. Timeout/lost completion is not an exact-once billing guarantee. Admission-off/capacity refusals are not accepted work; the UI must not suggest otherwise.
6. Activity cards show the generated description or event title. Only errors and applicable recovery actions appear alongside the event; progress, retry countdowns, and route/model labels are hidden.
7. Clicking issue/mail opens centrally in read-only details; this does not select another project or record a runtime tool-read receipt. AI Assist remains the separate existing Claude CLI flow and is unaffected by summary worker admission.

## 4. Contracts and persistence

| Endpoint | Method | Contract |
| --- | --- | --- |
| `/api/dashboard/activity` | GET | `{ items, nextCursor, errors }`; cursor is opaque and scope-bound. |
| `/api/dashboard/messages/{messageId}` | GET | Exact authorized message; both participant projects must remain registered. |
| `/api/dashboard/settings` | GET, PUT | Primary model, optional peer model, reasoning effort, and prompt only; no gateway credentials. |
| `/api/dashboard/summaries` | POST | One to 40 event references on server; browser bulk size is independently controlled by the UI. Body cap is 256 KiB: at 40 IDs of 1,024 UTF-16 units, worst-case JSON escaping is bounded by `40 × (6 × 1,024 + 256) + 256 = 256,256` bytes, below 262,144 bytes. Feed and UI omit IDs failing the same browser-safe predicate used by HTTP schemas. The server submits all admission candidates together in one queue transaction. Returns `{ items }` keyed by source key and uses 202 when at least one item is durably waiting/running/retrying. HTTP 200 alone does not mean admission. |
| `/api/dashboard/worker` | POST | Authenticated private actions: invite, claim, resolve, complete, and recheck. Invites are opaque; resolved claims carry only required source and settings. No browser-facing executor controls. |

- contract: Settings include a primary and optional peer model, reasoning effort, and prompt. Defaults are `subshare_api/gpt-6-luna`, effort `xhigh`, and the manager-oriented Russian prompt in `lib/dashboard-types.ts`. Provider fallback is not an app-side promise; peer-model selection is distinct from queue retry/fallback guarantees.
- contract: Settings live in `dashboard.json` under app config; atomic mode-0600 write. The app uses `SCOTTY_DASHBOARD_DURABLE_ADMISSION=1` plus its separate `SCOTTY_DASHBOARD_WORKER_TOKEN` or `SCOTTY_DASHBOARD_WORKER_TOKEN_FILE` for admission/private worker API. The isolated worker requires an explicitly configured `NEURO_GATE_URL` ending in `/v1` and a consumer credential via `NEURO_GATE_TOKEN` or `NEURO_GATE_TOKEN_FILE` (worker-readable UTF-8 file, at most 8 KiB); when set, `NEURO_GATE_TOKEN_FILE` must be an absolute worker-side path and takes precedence over `NEURO_GATE_TOKEN`. Source provides no URL, token, or token-file default/fallback. Never expose either secret to browser code.
- contract: Queue DB is `$XDG_STATE_HOME/bead-me-up-scotty/dashboard-queue.sqlite3`, default `~/.local/state/bead-me-up-scotty/dashboard-queue.sqlite3`. `BMUS_DASHBOARD_QUEUE_STATE_DIR` overrides the state base; the app-owned child directory is `bead-me-up-scotty`. SQLite is authoritative for accepted work and status; private directory/database/WAL modes are 0700/0600.
- contract: Queue bounds in `scripts/dashboard-queue.py`: 2,000 outstanding, with 250 reserved for visible work; admit/status request max 200; worker batches max four; at most six live invitations and six invitations issued per call, each expiring after 30 seconds; active attempts max three per provider and six globally; nominal deadline 180 seconds plus a 30-second lease margin. Browser and worker bulk sizes are separate limits. Treat event identities as opaque and preserve conservative matching; an uncertain explicit retry is reconciled by status only, without automatic re-admission. These are fixed queue bounds, not a mandate to change shared limits or retry policy.
- contract: Legacy v2 generated JSON cache under `$XDG_CACHE_HOME/bead-me-up-scotty/dashboard-summaries` (default `~/.cache/bead-me-up-scotty/dashboard-summaries`) is read-only compatibility input. No new legacy cache writes. Never treat it as accepted durable queue state.
- contract: The executor source is in `automation/Dockerfile` and `automation/beadswebui_automation/definitions.py` / `worker.py`; pin Dagster 1.13.17 and `dagster-postgres==0.29.17` for Enigma's Postgres-backed `DefaultRunLauncher`, and use code location `beadswebui_automation:4000`. Its sensor defaults STOPPED (5-second minimum interval in source). Worker URLs are base URLs; the worker appends `/api/dashboard/worker`, and appends `/chat/completions` to a Neuro-gate base ending `/v1`. Stable Neuro-gate consumer configuration must set `allow_provider_fallback: false` and restrict access to the two approved routes. This describes source contracts, not a verified deployment.

## 5. Verification and limits

- check: Source anchors include `app/api/dashboard/summaries/route.ts`, `lib/dashboard-settings.ts`, `lib/dashboard-summaries.ts`, `scripts/dashboard-queue.py`, and `automation/beadswebui_automation/{definitions.py,worker.py}`. Not checked: preflight, external image/code location, network isolation/deny policy, credential provisioning/ACL, live sensor state, provider behavior, deployment, or billable generation.
- check: Before intentional activation, verify configuration and health: the app endpoint URL/token, the worker's explicit Neuro-gate URL/consumer credential, the expected service/code-location health, and network restrictions. Keep admission off and the sensor stopped until these preconditions are confirmed; do not infer deployment readiness from source alone.
- failure-clue: Missing credentials, unavailable projects, source changes, queue errors, and provider/ACL errors must remain explicit rather than appearing as a healthy empty feed. Keep generated task/message text and SQLite local/private.

## 6. Update triggers

Update this document when dashboard aggregation, source resolution, queue limits, admission/authentication, settings/cache/state locations, or executor boundaries change. Keep [operations](operations.md), [API and Beads](api-and-beads.md), and [configuration](configuration.md) synchronized.

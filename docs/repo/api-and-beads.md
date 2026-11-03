# HTTP API and Beads integration

> A contract-oriented guide to the browser/API/CLI boundary, not a second schema definition. Read with [runtime flow](runtime-flow.md).

## 1. Scope and owner

- owner: `lib/api-client.ts` owns the typed browser request surface; `app/api/` owns HTTP routing and validation.
- owner: `lib/schema.ts` owns shared issue/input shapes; `lib/store.ts` chooses the real or demo implementation; `lib/bd.ts` adapts Beads CLI behavior.
- contract: Beads remains authoritative. The HTTP layer does not introduce another issue database or synchronize this repository's local tracker.

## 2. Entry points and key paths

- code: `hooks/use-beads.ts` — project-scoped queries, mutations, cache updates, and invalidation.
- code: `lib/api.ts` — JSON success responses and shared error-to-status mapping.
- entrypoint: `app/api/p/[projectId]/beads/route.ts` and `app/api/p/[projectId]/beads/[id]/route.ts` — collection and item operations.
- entrypoint: `app/api/p/[projectId]/beads/[id]/status/route.ts` — status transition and close actor/reason.
- code: `proxy.ts` and `lib/request-guard.ts` — host/origin checks and viewer-mode project mutation restrictions.
- doc: [Configuration](configuration.md) covers app-level routes and persistence; [operations](operations.md) covers update/publish side effects.

## 3. Main flow and route families

1. A hook calls the browser API client with a project ID; path segments are URL-encoded.
2. The request guard checks the addressed host and write origin. Effective viewer mode additionally refuses project-scoped mutations.
3. The handler resolves asynchronous route parameters, validates the applicable input, and selects the project's store.
4. The real store serializes CLI work for that repository, executes argument arrays without a shell, and normalizes results with shared schemas.
5. The handler returns JSON; the client preserves machine-readable failures as `ApiError`. Hooks update/invalidate the affected project cache.

The following paths are relative to `/api/p/{projectId}`. This is a route-family index; consult the named route and `lib/api-client.ts` for exact request/response fields.

| Path | Methods | Purpose |
| --- | --- | --- |
| `/beads` | GET, POST | List issues plus metadata; create an issue. |
| `/beads/{id}` | GET, PATCH, DELETE | Read, edit, or permanently delete an issue. |
| `/beads/{id}/status` | POST | Transition status, including an optional close reason. |
| `/beads/{id}/comments` | POST | Add a comment. |
| `/beads/{id}/deps` | POST, DELETE | Add or remove a dependency. |
| `/beads/{id}/archive` | POST | Archive separately from permanent deletion. |
| `/beads/{id}/gate` | POST | Create a human approval gate blocking the issue. |
| `/beads/{id}/human` | POST | Respond to or dismiss a human-attention request. |
| `/beads/{id}/assist` | POST | Ask the optional Claude CLI for suggestions; does not itself apply them. |
| `/beads/stream` | GET | Signal-only SSE change notifications, not issue snapshots. |
| `/doctor` | GET | Project/store diagnostic information. |
| `/activity`, `/insights`, `/gamification` | GET | Derived activity and dashboard data. |
| `/order` | GET, PUT | Read or replace a column's saved manual ordering. |
| `/attachments` | POST, PUT | Multipart image upload; finalize a draft folder to a real issue ID. |
| `/attachments/{...path}` | GET | Serve a stored attachment. |
| `/publish` | POST | Generate, open, or explicitly deploy a showcase. |

App-level routes are `/api/projects` (GET/POST), `/api/projects/{id}` (PATCH/DELETE), `/api/config` (GET/PUT), `/api/fs` (GET), `/api/viewer-mode` (GET/PUT), `/api/update/check` (GET), `/api/update/run` (POST), and `/api/telemetry` (GET/PUT/POST). Viewer mode is not a blanket block on these app-level operations.

## 4. Contracts and data shape

### Issue reads and writes

- contract: The collection GET returns `{ beads, meta }`; metadata includes store kind, actor, human allowlist, fallback polling interval, gamification flag, effective read-only mode, and optional lane prefix.
- contract: Read schemas accept unknown status/type strings for forward compatibility. Write schemas restrict supported statuses/types, priority 0–4, and required fields; do not infer write acceptance from a readable unknown value.
- contract: Omitted PATCH fields mean unchanged. `labels: []` clears all labels; omitted `labels` preserves them. `parent: ""` detaches a parent; omitted `parent` preserves it.
- contract: Dependencies from flat export records and expanded show results normalize to a single dependency-link shape. Expanded issue timestamps must not become link timestamps.
- contract: Backlog creation maps to Beads `deferred`. Closing uses the dedicated CLI close path so a reason is recorded at close time, not as an unrelated later update.
- contract: Image uploads use multipart fields `file` and `beadId`, accept image MIME types up to 15 MiB, and return an `attachment://` reference plus a project-scoped URL. Demo has no attachment folder.

### CLI boundary

- contract: Commands run with the selected repository as `cwd`, `BD_JSON_ENVELOPE=1`, and the supplied `BEADS_ACTOR`. JSON responses are unwrapped; exports are parsed as JSONL issue records.
- contract: Issue-data CLI operations, including reads, serialize per repository inside the application process because embedded Dolt reads can rewrite database state. This queue does not coordinate unrelated external CLI processes.
- contract: Concurrent list requests share one in-flight export. Preserve serialization when adding store methods; do not parallelize same-repository reads as a cosmetic optimization.
- contract: Missing/invalid real-project stores return errors. Only the explicit Demo project uses the in-memory implementation.

### Errors

| HTTP status | Typical code / meaning |
| --- | --- |
| 400 | `invalid_input`, configuration problems other than unknown project, or ordinary CLI failures. |
| 403 | `host_not_allowed`, `cross_origin`, or `read_only` at the proxy boundary. |
| 404 | `unknown_project` or a CLI/item `not_found` result. |
| 409 | `schema_migration_required`; includes raw technical `detail` for the UI. |
| 500 | CLI `parse_error` integration drift or an unclassified server exception. |

- contract: Shared failures generally return `{ error, code?, detail? }`; validation failures also include `issues`. Not every endpoint uses every field or the shared mapper. Publish deployment can return HTTP 200 with `deployed: false`; inspect its payload.
- contract: `ApiError` retains status/code/detail. User-facing recovery should key on stable codes rather than matching CLI prose.

## 5. Verification and failure clues

- check: For a changed contract, inspect the hook/client, handler, schema, and store method together; choose checks from [verification policy](verification.md).
- check: Read-only API inspection can use `GET /api/projects`, `GET /api/config`, and a selected project's `/doctor` or `/beads`. Even nominal reads can touch local configuration/Dolt state; scope them deliberately.
- failure-clue: A migration conflict is not repaired by repeated UI writes. Inspect the project's Beads compatibility and technical detail; do not automatically authorize remote migration or synchronization.
- failure-clue: A parse failure is an integration problem, not evidence that the browser sent invalid input. Verify actual CLI output against `lib/schema.ts`.
- check: This document is source-grounded; no live CLI compatibility, HTTP interaction, upload, or mutation is established by the documentation audit.

## 6. Update triggers

Update this document when routes, payloads, error mappings, status/label/parent semantics, CLI flags, serialization, or attachment handling change. Update [the repository map](repo_structure.md) when source anchors or document ownership move.

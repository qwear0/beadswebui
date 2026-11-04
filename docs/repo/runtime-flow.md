# Runtime flow and ownership

> Read with [the repository map](repo_structure.md) when a change crosses UI, API, configuration, Beads storage, or launcher boundaries.

## 1. Scope and owner

- The repository is one Next.js application, not separate frontend/backend services.
- Components and hooks own browser interaction; route handlers own HTTP wiring; server-only libraries own CLI/filesystem integrations.
- Beads remains the issue-data authority. Demo issues use an in-memory store rather than the local tracker.
- Agent presence/mail is a separate sanitized local read model produced only by the existing pi_qr runtime extension; the app neither executes Pi nor owns native worker lifecycle. See [Agent Workspace](agent-workspace.md).

## 2. Entry points and key paths

- `app/page.tsx` renders `components/launcher.tsx`; `app/p/[projectId]/page.tsx` renders `components/app-shell.tsx`.
- `components/providers.tsx` provides browser query/theme context; `hooks/use-beads.ts` owns issue queries and mutations.
- `lib/api-client.ts` is the typed browser request surface; `app/api/p/[projectId]/beads/route.ts` is a representative server route.
- `lib/schema.ts` defines data/input schemas. `lib/api.ts` centralizes API response helpers.
- `lib/store.ts` selects a store; `lib/bd.ts` implements the local CLI adapter; `lib/demo-store.ts` implements demo behavior.
- `lib/config.ts` owns application configuration and project lookup, separate from Beads issue data.
- doc: [Configuration](configuration.md), [API and Beads](api-and-beads.md), [browser state](ui-state.md), and [operations](operations.md) provide the narrow contracts behind this overview.

## 3. Main flow

1. The launcher/project page selects a project; components consume query/mutation hooks.
2. Hooks call the browser API client, which addresses project-scoped route handlers.
3. Routes resolve request parameters, apply relevant input/read-only checks, and select the store.
4. The explicitly selected Demo project resolves to the shared in-memory store. A real project resolves through configuration, CLI availability, and a cached per-project Beads store; unavailable real stores return errors, never sample-data fallback.
5. The CLI adapter invokes `BD_BIN` (default `bd`) with argument arrays and the selected repository as its working directory. It handles JSON envelopes and parses exported records using the shared schema.
6. Server change notifications travel through the SSE route to browser query invalidation; interval refetching remains a fallback.

Live refresh anchors:

- `lib/beads-watch.ts`: a shared, reference-counted, non-recursive watch of the project's Beads directory. Recursive watching would observe nested Dolt rewrites caused by reads and create a refetch loop.
- `app/api/p/[projectId]/beads/stream/route.ts`: SSE route subscription.
- `hooks/use-beads-stream.ts`: EventSource connection and invalidation of issue/activity queries; demo skips the stream.
- `lib/sse-registry.ts` and `instrumentation-node.ts`: registered stream closure on shutdown so indefinitely open requests do not prevent server exit.
- `lib/agent-projection.ts`, `lib/agent-watch.ts` and `hooks/use-agents.ts`: separate agent snapshot/history observation and browser invalidation. Presence changes must not invoke Beads or reload conversation bodies; agent streams share the shutdown registry.

## 4. Contracts and data shape

- Browser -> API: keep `lib/api-client.ts`, hook expectations, route responses, and `lib/schema.ts` aligned.
- API -> Beads: preserve project working directory, actor propagation, error codes, and JSON parsing. `lib/bd.ts` serializes CLI operations per repository, including reads that can rewrite embedded Dolt state.
- Configuration: `lib/config.ts` stores app settings under `XDG_CONFIG_HOME`, falling back to the user's config directory, in a `bead-me-up-scotty` subdirectory. Manual board order is app configuration, not issue metadata. Browser themes/display preferences are localStorage state; viewer mode is session-cookie state.
- Project lookup: the registry and request URL choose the real project. `BEADS_REPO` only participates in initial legacy-registry migration, not a runtime override of registered entries.
- Request boundary: `proxy.ts` uses `lib/request-guard.ts`; do not infer that browser viewer state alone enforces server mutation restrictions.
- Local tracker policy: this repository's issue data must remain local. Application publishing/update features do not authorize tracker synchronization.

Launcher/build contracts:

- `package.json`: development runs Next dev; build runs Next build; start runs Next start; serve runs the supervisor.
- `build.sh`: local deployment of clean `main` to the existing user `beadswebui.service`; stops before replacing dependencies/build output, then starts and checks HTTP readiness. This is separate from Docker and application self-update; see [operations](operations.md).
- `scripts/serve.mjs`: starts Next with `PORT`/`HOST`, sets `BMUS_SUPERVISED`, and relaunches on the update restart exit code 75. Signal handling waits for child exit. No test command override is supported.
- `bin/bead-me-up-scotty.mjs`: packaged command-line launcher; consult it before changing install/start behavior.
- `next.config.ts`: standalone output is opt-in through `NEXT_STANDALONE`; normal local launchers use Next start.
- `Dockerfile`: enables standalone output for the container, supplies the Beads binary, and copies a separate Eleventy dependency tree for publishing. Local launch mode and container mode must not be conflated.

## 5. Verification and failure clues

- Follow [verification policy](verification.md). Types/lint/doc audit do not establish live CLI or browser behavior.
- For project resolution failures, inspect project registration, selected path, CLI availability, and the store error before changing browser fallbacks.
- For refresh loops or shutdown hangs, inspect watcher depth, subscription cleanup, query invalidation, and stream registration together.
- For update restart failures, inspect the update service and supervisor exit-code contract; do not restart a live app solely to validate documentation.
- A direct observation against real projects can touch local Dolt data even on a nominal read; keep checks scoped and do not trigger remote synchronization.

## 6. Update triggers

Update this document when entrypoints, client/server ownership, shared schemas, store selection, CLI serialization, configuration location, SSE lifecycle, or launch/build contracts change. Keep the repository map synchronized when anchors move.

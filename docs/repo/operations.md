# Launch modes, updates, and optional integrations

> Operational guidance grounded in the checked-out launchers and runtime code. This describes supported behavior, not authorization to restart, update, deploy, or publish data.

## 1. Scope and owner

- owner: `package.json`, `bin/bead-me-up-scotty.mjs`, and `scripts/serve.mjs` define local development/production launch modes.
- owner: `next.config.ts` and `Dockerfile` define normal versus standalone build packaging.
- owner: Server integrations perform optional AI assistance, static showcase generation/deployment, usage reporting, and application self-update.
- contract: This is a local single-user application. Viewer mode and host/origin guards are not a user authentication system. See [configuration](configuration.md) and the policy in `AGENTS.md`.

## 2. Entry points and key paths

- code: `package.json` and `package-lock.json` — scripts, runtime/contributor engine declarations, and locked dependencies.
- entrypoint: `bin/bead-me-up-scotty.mjs` — `scotty` / `bead-me-up-scotty` launcher.
- entrypoint: `scripts/serve.mjs` — production supervisor; `instrumentation.ts`, `instrumentation-node.ts`, and `lib/sse-registry.ts` — runtime hooks and stream shutdown.
- code: `lib/update-service.ts`, `lib/self-update.ts`, `lib/update-types.ts`, and `app/api/update/` — update discovery, exact target contracts, execution, and restart signaling.
- code: `lib/ai.ts` and `components/ai-assist-panel.tsx` — optional Claude CLI assistance and applying suggestions.
- code: `lib/showcase/generate.ts`, `lib/showcase/report.ts`, and `app/api/p/[projectId]/publish/route.ts` — static reports/showcases.
- code: `lib/telemetry.ts`, `app/api/telemetry/route.ts`, and `components/usage-statistics.tsx` — usage-statistics preference and delivery.

## 3. Launch and shutdown flow

### Local source checkout

1. Install locked dependencies with `npm ci`. `package.json` declares Node >=20 as the package engine, with contributor recommendations Node >=26.4 and npm >=11.9 configured as warnings. Docker currently defaults to Node 26.4.0; the broad package engine floor alone is not proof of compatibility with every installed dependency.
2. For development, run `npm run dev`. For production, build with `npm run build`, then choose `npm start` or `npm run serve`.
3. `npm start` invokes Next start directly. `npm run serve` launches it under a supervisor using `PORT` (default 3000), `HOST` (default localhost), and `BMUS_SUPERVISED=1`.
4. The supervisor relaunches only when the child exits with the update restart code 75. Other exits end the supervisor. SIGINT/SIGTERM forward to the child and wait for exit with a five-second parent deadline.
5. Runtime shutdown closes registered SSE streams so Next can drain long-lived requests. Preserve this integration when changing stream lifecycle.

```bash
npm ci
npm run dev
# Alternatively, for a production source checkout:
npm run build
npm run serve
```

These commands describe alternatives; they do not require running both servers together. Do not rebuild or restart a live app merely because documentation changed.

### Packaged launcher and container

- contract: `scotty` requires an existing production `.next` build in its package root and never builds at startup. See [README installation instructions](../../README.md#install-globally).
- contract: The launcher resolves Next relative to the installed package, not the invoking project's working directory. Default binding is localhost:3000; a busy implicit port can advance up to 50 ports, but an explicit `--port` fails rather than moving.
- contract: The launcher supports `--host`, `--port`, and `--no-open`. With browser opening enabled, invocation from a `.beads` directory attempts to register it and opens its project URL; `--no-open` skips that auto-registration step.
- contract: The packaged launcher is not the update supervisor. It forwards stop signals and force-kills a stuck child after four seconds or a repeated stop signal.
- contract: Normal local builds use Next start. `NEXT_STANDALONE=1` opts into standalone output for the Docker build; container startup is `node server.js`, not the local supervisor.
- contract: The image includes a prebuilt `bd`, runs as a non-root user, and supplies a separate complete Eleventy dependency tree because static CLI lookup is not covered by standalone tracing.
- contract: Mounted projects must be writable by the container user and registered using container-visible paths. Preserve the configured home/config directory if app settings must survive container replacement. See [README Docker guidance](../../README.md#docker).

## 4. Update and external side-effect contracts

### Application self-update

1. Stable discovery uses the latest non-prerelease GitHub release; development discovery resolves `main`. Discovery is network activity, and development checks may fetch Git objects, so it is not a purely local/status-only operation.
2. Automatic updates require a Git checkout on `main` or a detached checkout, no uncommitted changes, and a fast-forward target. Other installations require manual update; no local work is forcibly overwritten.
3. Execution accepts an exact channel/SHA and stable tag when applicable. It revalidates the remote target and checkout; stable tag/package identity and version must match.
4. The updater fast-forwards source, runs locked `npm ci --include=dev --no-audit --no-fund`, then `npm run build`. A later failure can leave source already advanced: this is not an atomic rollback transaction.
5. A supervised successful update schedules exit code 75 and relaunch. Without supervision, the result does not promise an automatic restart.

- contract: Update capabilities in the app do not authorize an agent to invoke them. Follow the active Git and restart authorization in `AGENTS.md` and the current task.

### Optional integrations and data exposure

| Feature | Trigger and effect | Important boundary |
| --- | --- | --- |
| AI assist | The assist endpoint invokes `CLAUDE_BIN` (default `claude`) with a prompt containing issue details and up to 80 other issue IDs/titles. | Requires the CLI and its authentication. Suggestions do not change the issue until explicitly applied; a local CLI invocation is not a promise of offline processing. |
| Showcase build | The publish endpoint gathers issues and invokes Eleventy to generate a static site. | A real single-project build uses that project's `.beads/showcase`; Demo/all-project builds use an OS temporary location. The response provides output/index paths. |
| Showcase open/deploy | Explicit publish actions open a generated path on the server machine or invoke `vercel deploy ... --yes`. | Deployment can publish issue content externally. All-project scope aggregates reachable registered real projects and skips unavailable ones; do not assume completeness or permission to publish. |
| Usage statistics | UI activity can request delivery of an `app_active` event. New installations enable the preference and use a bundled ingestion token by default. | Explicitly empty `POSTHOG_KEY` disables sending; Settings can persist opt-out independently of issue data. |

- contract: Usage events contain random installation/event IDs, app version, timestamp, and profile/GeoIP-disabling flags, not issue content, project paths, or browser request headers. The receiver still observes the server's network IP.
- contract: Telemetry retries keep the day's event identity, at most three attempts spaced at least ten minutes apart; no backfill of earlier days. Failures must not interrupt app use. See [README usage-statistics details](../../README.md#basic-usage-statistics).
- contract: This repository's own Beads data is local-only. Showcase/publish features and CLI advisories do not authorize deploying it, adding a Dolt remote, or pushing tracker data.

### Agent Workspace runtime boundary

- contract: The existing pi_qr extension in `/apps/pi_quality_runtime` alone publishes presence, owns coordinator mail and settings, and mirrors native owner-worker facts. Beadswebui adds no Pi extension installation, daemon, network mailbox listener or worker scheduler. See [Agent Workspace](agent-workspace.md).
- contract: Coordinator mail is local runtime storage, independent of a running browser/web app. Containers or different OS users need deliberate access to the same sanitized state root and registry; do not create a disconnected second bus to mask unavailable data.
- contract: Source integration/builds do not activate existing Pi processes or managed worker snapshots. Use the runtime's owning-process release/activation procedure; never reload or stop unrelated live workers to verify web documentation.
- contract: Agent history is browser-read-only. Existing host/origin checks are not authentication and do not authorize browser send, wake-settings mutation or execution controls. Mail inserted into Pi context can reach its configured model provider; local storage is not a guarantee of offline processing.

### Network binding

- contract: Local launchers default to localhost. A named LAN/reverse-proxy host must be explicitly allowed through `SCOTTY_ALLOWED_HOSTS`; use the actual required names, not `*` as a routine workaround.
- contract: The guard accepts localhost names and IP literals by default, rejects disallowed addressed hosts, and checks unsafe-request origins. `*` relaxes the host check, not the foreign-origin write check.
- recommendation: Keep binding local unless remote access is deliberately configured. A remote-access deployment needs its own appropriate access controls; the app's browser-session viewer toggle is not one.

## 5. Verification and failure clues

- check: Use [verification policy](verification.md). For documentation-only edits, the read-only documentation auditor is sufficient; do not run updates, AI calls, deployments, or a production build merely to verify prose.
- failure-clue: A missing production build prevents packaged launch. An occupied explicit port is an error by design; the supervisor does not auto-select another port.
- failure-clue: A 403 with `host_not_allowed` or `cross_origin` points to addressed host/origin configuration, not missing issue data. Do not weaken checks without verifying the intended binding/proxy setup.
- failure-clue: An update blocked by a dirty/diverged checkout is protective. A failed install/build after source advancement requires inspecting the reported step and actual checkout; do not assume a rollback or restart occurred.
- failure-clue: A showcase deployment can return HTTP success with `deployed: false` and manual instructions. A generated path belongs to the server filesystem, not necessarily the browser's machine.
- check: This documentation does not establish a successful build, Docker startup, live shutdown/restart, CLI compatibility, AI request, deployment, or analytics delivery.

## 6. Update triggers

Update this document when launch flags, engine/build requirements, Docker packaging, signal/restart behavior, update preconditions/steps, external CLI dependencies, generated output locations, network binding, or telemetry exposure changes. Keep [configuration](configuration.md), [verification](verification.md), and [the repository map](repo_structure.md) synchronized.

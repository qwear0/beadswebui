# Beadswebui repository structure

> Read this map before deep source inspection. The application is named Bead Me Up, Scotty in the package and UI; beadswebui is this repository's name.

## 1. Scope and ownership

- owner: One Next.js App Router application serving a browser UI and local HTTP API for Beads projects.
- owner: Browser interaction, project registration, CLI adaptation, live refresh, publishing, and launch/update integration.
- owner-rule: Beads owns issue data; the UI calls the installed CLI rather than implementing a separate issue database.
- owner-rule: This repository's own Beads tracker is local-only under the policy in `AGENTS.md`; app features do not authorize publishing that tracker.

## 2. Read first

- reads-after: `AGENTS.md` — operational rules, local-only data, verification, and conservative Git policy.
- reads-after: `README.md` — installation, user-facing features, configuration, and launch modes.
- reads-after: `docs/repo/runtime-flow.md` — browser/API/store/CLI flow and runtime boundaries.
- reads-after: Choose the relevant narrow guide below: configuration, API/CLI contracts, browser state, or operations. Do not read every implementation file to answer a bounded question.
- reads-after: `docs/repo/verification.md` — available checks, retired tests, and verification limits.
- reads-after: `.agents/skills/beadswebui-doc-maintainer/SKILL.md` — documentation impact and audit workflow.
- reads-after: Installed Next.js guides under `node_modules/next/dist/docs/` before framework code edits.

## 3. Verified anchors

- entrypoint: `app/layout.tsx` and `components/providers.tsx` — root layout and browser providers.
- entrypoint: `app/page.tsx` — project launcher via `components/launcher.tsx`.
- entrypoint: `app/p/[projectId]/page.tsx` — project page and `components/app-shell.tsx`.
- entrypoint: `app/api/` — route handlers; project issue operations live under `app/api/p/[projectId]/`.
- entrypoint: `proxy.ts` — request guard and viewer-mode request handling.
- entrypoint: `instrumentation.ts` and `instrumentation-node.ts` — Node runtime startup and shutdown hooks.
- entrypoint: `bin/bead-me-up-scotty.mjs` — packaged CLI launcher.
- entrypoint: `scripts/serve.mjs` — supervised server with update restart handling.
- code: `package.json` and `package-lock.json` — scripts, dependency declarations, and pinned dependency tree.
- code: `next.config.ts` and `Dockerfile` — build configuration and opt-in standalone container output.
- contract: `lib/schema.ts` — Beads and mutation schemas; `lib/api-client.ts` — browser API shapes.
- contract: `lib/store.ts` — store interface/selection; `lib/bd.ts` — local CLI adapter; `lib/demo-store.ts` — in-memory demo store.

## 4. Responsibility boundaries

- zone: `app/` owns framework route/layout wiring; `components/` owns views, dialogs, board interactions, and reusable UI.
- zone: `hooks/` owns query/mutation hooks, live subscriptions, keyboard, URL, and view preferences.
- zone: `lib/` mixes browser-safe domain helpers and server-only integrations; inspect imports rather than treating the whole directory as shared browser code.
- zone: `lib/config.ts` owns application/project configuration; `lib/bd.ts` invokes Beads in the selected repository.
- zone: `lib/beads-watch.ts` and `lib/sse-registry.ts` own server stream notification/lifecycle; `hooks/use-beads-stream.ts` owns browser invalidation.
- zone: `lib/showcase/` owns generated report/publishing support; `lib/ai.ts` owns AI-assist integration.
- zone: `lib/update-service.ts`, `lib/self-update.ts`, and `lib/update-types.ts` own update coordination and contracts.
- zone: `lib/themes.ts`, `components/theme-provider.tsx`, and `app/globals.css` own theme registry, selection, and palettes.
- zone: `public/` holds static assets; `design/` holds reference exports, not current runtime implementation.
- zone: `docs/releases/` holds release history; `docs/superpowers/` holds historical plans/specifications, not current execution rules.
- owner-rule: Keep application behavior in its current responsibility area; do not introduce separate service/container maps without an actual split.

## 5. Documentation map

- doc: `docs/repo/repo_structure.md` - repository navigation, ownership, and update triggers
- doc: `docs/repo/runtime-flow.md` - UI/API/Beads flow, live refresh, configuration, and launchers
- doc: `docs/repo/configuration.md` - project registration, settings, actor defaults, environment, and persistence locations
- doc: `docs/repo/api-and-beads.md` - HTTP route families, data/error contracts, attachments, and CLI serialization
- doc: `docs/repo/ui-state.md` - URL navigation, filters, detail trail, preferences, query caches, and themes
- doc: `docs/repo/operations.md` - local/container launch modes, shutdown, self-update, and optional external integrations
- doc: `docs/repo/verification.md` - retired test infrastructure, supported checks, and limitations

## 6. Verification and limits

- check: Follow `docs/repo/verification.md`; use static checks or bounded direct observations, not replacement test scripts.
- check: Run `python3 .agents/skills/beadswebui-doc-maintainer/scripts/audit_beadswebui_docs.py .` after doc changes.
- check: The audit checks current-doc structure, links and anchors plus skill Markdown references; it does not verify application behavior.
- check: Historical docs and root README/instruction files are not forced into the current-doc template; inspect edits to them directly.
- check: GitHub Actions are not part of the workspace verification workflow. Remote settings are not inferred from local files.

## 7. Update triggers

- update-when: Routes, source areas, launchers, configuration, shared contracts, or ownership change.
- update-when: A current narrow document is added, moved, or removed; update section 5 in the same diff.
- update-when: Agent instruction/skill locations or verification policy change.
- skip-when: A local implementation fix or cosmetic UI edit leaves this map and its contracts correct.
- skip-when: Task-specific findings belong in ignored artifacts rather than durable documentation.

## 8. Completion checks

- check: Map paths and reading order still match the source tree.
- check: Both ends of changed UI/API/CLI contracts were inspected; graph edges alone are not proof.
- check: Current docs remain concise and the documentation audit passes.
- check: Report checks actually run, results, and unverified behavior; do not equate type/lint/audit success with runtime correctness.
- check: Preserve existing generated agent blocks and the local-only Beads policy; do not commit or push without authorization.

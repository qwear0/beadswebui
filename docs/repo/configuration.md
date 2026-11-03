# Project registration, configuration, and persistence

> Read this before changing project selection, actor attribution, settings, or data locations. See [the repository map](repo_structure.md) for ownership.

## 1. Scope and owner

- owner: `lib/config.ts` owns the server's project registry, global settings, and manual board order; Beads owns issue records.
- owner: Browser preferences belong to the browser, not to the Beads database. See [UI state](ui-state.md).
- contract: Project identity comes from the URL/request, not a global active-project setting.

## 2. Entry points and key paths

- entrypoint: `components/launcher.tsx` and `hooks/use-projects.ts` — list and register projects.
- entrypoint: `app/api/projects/route.ts` — GET registry plus Demo; POST an existing project folder.
- entrypoint: `app/api/projects/[id]/route.ts` — PATCH display name; DELETE registration.
- entrypoint: `app/api/config/route.ts` — GET settings; PUT validated global settings and reset cached stores.
- code: `lib/config.ts`, `lib/store.ts`, and `app/api/p/[projectId]/order/route.ts` — configuration, store lifetime, and ordering.
- code: `app/api/viewer-mode/route.ts` and `proxy.ts` — effective browser-session viewing mode and request enforcement.

## 3. Main flow

1. The launcher lists registered project entries plus the built-in `demo` project, whose path is null.
2. Registering a folder resolves its path and requires a `.beads` directory. It does not initialize a new Beads database. The server interprets the path on its own filesystem, including inside Docker.
3. Registration reuses an existing entry for the same directory or creates an ID, name, path, and timestamps. API results also annotate whether the Beads directory still exists.
4. Requests to a real project resolve its registry entry, check CLI availability, and cache a store per project ID. Demo always uses the shared process-local in-memory store.
5. Renaming changes the display name, not the directory. Removing a registration removes saved ordering and the cached store, not the project folder or its issues.
6. On initial configuration migration only, a missing project registry can be populated from the old `repoPath`, then `BEADS_REPO`, then the server's working directory, if that folder contains `.beads`.

## 4. Contracts and data locations

### Persistence boundaries

| State | Location / scope | Owner |
| --- | --- | --- |
| Project registry, actor/allowlist, polling interval, gamification flag, board order | `config.json` in the app config directory | `lib/config.ts` |
| Issues, dependencies, comments, workflow state | Selected repository's `.beads` data, accessed through `bd` | `lib/bd.ts` |
| Images | Selected repository's `.beads/attachments` directory | `app/api/p/[projectId]/attachments/route.ts` |
| Activity input | Selected repository's `.beads/interactions.jsonl`, read alongside issue data | `lib/interactions.ts` |
| Themes, default view, board display/update preferences | Browser localStorage | [UI state](ui-state.md) |
| Effective viewer mode | HTTP-only session cookie `scotty-viewer-mode`, overriding the environment default | `app/api/viewer-mode/route.ts` |
| Usage-statistics preference, installation ID, daily delivery records | Separate telemetry files in the app config directory | `app/api/telemetry/route.ts` and `lib/telemetry.ts` |

- contract: The app config directory is `$XDG_CONFIG_HOME/bead-me-up-scotty`, or `~/.config/bead-me-up-scotty` when the variable is unset.
- contract: Configuration is cached in the server process. Its writes are best-effort: a failed disk write can still leave a setting effective for the current process. A successful settings response is not proof of durable storage.
- contract: Manual column order is a project/column-to-issue-ID mapping in app configuration, not an issue field.
- contract: Global settings PUT accepts `humanActor`, `humanAllowlist`, `pollIntervalMs` (1,000–300,000), and `gamification`; registry/order use their own endpoints.
- contract: Defaults are a 30,000 ms fallback poll and gamification disabled. Actor defaults follow `BEADS_ACTOR`, Git `user.name`, then OS username; the initial human allowlist contains that actor. Explicitly saved actor choices are retained.
- contract: The human allowlist classifies human-versus-agent attribution; it is not an authorization list. Closing an issue has a narrow legacy OS-username compatibility rule in `closeActor`; it must not impersonate arbitrary assignees.

### Runtime environment

| Variable | Meaning |
| --- | --- |
| `BD_BIN` | Beads executable; default `bd`. |
| `BEADS_ACTOR` | Default actor candidate; a saved actor choice takes precedence. |
| `BEADS_REPO` | Legacy initial registry migration input, not a per-request project override. |
| `XDG_CONFIG_HOME` | Base directory for server settings and telemetry state. |
| `SCOTTY_READ_ONLY` | `1` or `true` defaults new browser sessions to viewer mode; their session cookie can override it. |
| `SCOTTY_ALLOWED_HOSTS` | Comma-separated allowed hostnames; see [operations](operations.md) before exposing the server. |
| `SCOTTY_LANE_PREFIX` | Optional Focus-view label prefix, for example `ctx:`. |
| `CLAUDE_BIN` | Optional AI-assist executable; default `claude`. |
| `POSTHOG_KEY`, `POSTHOG_HOST` | Usage-statistics ingestion settings; an explicitly empty key disables sending. |
| `PORT`, `HOST` | Local launcher/supervisor binding; defaults are 3000 and localhost. |

- contract: Select Demo explicitly in the launcher. A real project's unavailable CLI is an error, not a switch to sample data. `BEADS_DEMO` is not an active store-selection setting.

## 5. Verification and failure clues

- check: Follow [verification policy](verification.md); inspect the registry and corresponding route/store before changing lookup behavior.
- failure-clue: `no_beads` means the registered server-side folder lacks `.beads`; `unknown_project` means the requested ID is not registered; `bd_unavailable` means the real store could not be opened.
- failure-clue: A setting lost after restart can indicate unwritable configuration storage. Browser-only preferences cannot be recovered by editing server configuration.
- failure-clue: Viewer mode blocks project mutations but permits app settings, project registration, and updates. It is a viewing preference, not access control or a guarantee of zero filesystem activity during reads.
- check: Do not use publishing, remote tracker sync, or real issue mutations to validate this document. This repository's own tracker stays local under `AGENTS.md`.

## 6. Update triggers

Update this document when project identity/migration, configuration fields or defaults, actor selection, persistence locations, environment interpretation, or viewer-mode scope changes. Keep [runtime flow](runtime-flow.md) and [the repository map](repo_structure.md) aligned.

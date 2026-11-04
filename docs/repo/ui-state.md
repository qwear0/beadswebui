# Browser navigation, preferences, and live state

> Read this before changing URL behavior, drawers, query caches, board ordering, or themes. See [runtime flow](runtime-flow.md) for the server-side handoff.

## 1. Scope and owner

- owner: `components/app-shell.tsx` coordinates a project's views, selected issue, detail trail, and create dialog.
- owner: Hooks own query subscriptions and viewing preferences; route/store code owns persistent issue mutations.
- contract: URL state, browser preferences, server configuration, and Beads records are different state domains. Do not persist one in another merely because both affect a view.

## 2. Entry points and key paths

- entrypoint: `app/layout.tsx` and `components/providers.tsx` — query client, theme provider, notifications, and usage activity.
- entrypoint: `app/p/[projectId]/page.tsx`, `components/app-shell.tsx`, and `components/app-context.tsx` — project view and shared interaction callbacks.
- code: `lib/views.ts`, `hooks/use-last-view.ts`, and `hooks/use-default-view.ts` — view selection/defaults.
- code: `hooks/use-url-state.ts`, `hooks/use-url-filters.ts`, and `lib/filters.ts` — bookmarkable state and shared Board/List filters.
- code: `hooks/use-beads.ts`, `hooks/use-beads-stream.ts`, and `hooks/use-order.ts` — queries, live invalidation, and manual ordering.
- code: `hooks/use-agents.ts`, `hooks/use-agent-filters.ts`, and `lib/agent-ui.ts` — isolated runtime queries, URL cross-filters and explicit project/bead linkage.
- entrypoint: `components/agents-view.tsx` and `components/agent-conversation.tsx` — fleet and read-only paged mail; `components/agent-summary.tsx` — shared pipeline, cross-filters and detail links.
- code: `components/board/board.tsx`, `hooks/use-board-prefs.ts`, and `components/theme-provider.tsx` — board interaction/preferences and per-project themes.

## 3. Main flow

1. The project page mounts the app shell under the shared providers. Issue and activity query keys include the project ID so different project tabs do not share the wrong cache.
2. View selection honors a valid `view` query parameter first, then the browser's default-Focus preference, otherwise Board. Despite its name, `useLastView` does not restore a separately persisted last-view value.
3. View/filter changes update browser history without a page navigation. Filter updates preserve unrelated query parameters and the URL hash; browser Back/Forward restores URL state.
4. Opening a detail from outside the drawer starts a fresh trail. Following a link inside it pushes onto the drawer's own trail, capped at 25 entries; drawer Back skips issues no longer in the current index.
5. The current drawer issue is reflected in `bead` using history replacement, not a new browser-history entry per drawer step. Initial links and browser navigation can restore it.
6. The browser subscribes to the project SSE endpoint; a `change` signal invalidates issue/activity queries. EventSource reconnects automatically, and polling remains a fallback. Demo does not connect to a filesystem stream.

## 4. Contracts and state shape

### Navigation and filters

- contract: Views are defined in `lib/views.ts`: Board, Focus, List, Epics, Graph, Insights, Activity, Agents, Needs You, Achievements, Publish, and Settings. Achievements navigation is gated by the gamification setting.
- contract: Board/List facets use repeated `status`, `type`, `priority`, `origin`, `label`, and `assignee` parameters; free text uses `q`. Values are OR within a facet and AND across facets.
- contract: Empty facet arrays mean unrestricted. An explicitly empty `assignee` query value means Unassigned; it must not be discarded as an absent value.
- contract: `archived=1` is the dedicated archived-state toggle. The `archived` label is not offered as an ordinary label facet.
- contract: A requested issue is declared missing only after a successful issue load. Loading/network failure must not erase a valid bookmarked `bead`.
- contract: Effective viewer mode is queried separately; the shell disables editing while that mode is not yet known. The server also rejects project writes. See [configuration](configuration.md).

Example bookmark using a registered project ID:

```text
/p/{projectId}?view=list&status=open&priority=1&assignee=&q=release
```

### Agent Workspace navigation and live state

- contract: Agent cross-filters use `agent`, `instance`, `epic`, `issue` and `thread` URL parameters. Runtime identity filters are not assignees/historical actors; project-qualified explicit bead linkage connects the fleet to Activity/Focus and issue detail. Epic membership uses descendants, not dependency-graph neighbors.
- contract: Agents presence and conversations follow the globally selected project in the shell, with no separate project selector or URL scope override. Demo stays isolated. Epic/issue filters use that same project; Beads pipeline counts appear in Focus/Activity, not Agents.
- contract: Fleet liveness, work state, conflict and parent-instance uncertainty remain separate. Pipeline totals include every observed Beads status, including unknown values. Agent telemetry/messages do not become issue Activity events or Needs You requests.
- contract: Conversations are read-only and paged. Filters apply to loaded thread context, not an exhaustive history search; message facts and linked replies are observations, not a mandatory linear delivery progression. See [Agent Workspace](agent-workspace.md).
- contract: Query keys begin with `agents` and include project/global scope, then snapshot, conversations or messages/thread. They do not share issue/activity keys. Hooks share a reference-counted EventSource per query client/scope; presence/policy revisions invalidate snapshots, history revisions invalidate conversations/messages, never Beads.
- contract: Browser agent snapshots poll every 15 seconds without a live stream and 45 seconds with one; browser history interval polling is 60 seconds only while disconnected. Separately, server history recovery emits a revision signal every 60 seconds without scanning retained bodies/indexes; it is not driven by presence heartbeats. Reconnect backs off to 30 seconds. Demo opens no agent stream and shows no real mail; connected transport alone is not proof of healthy publication.

### Preference and ordering locations

| State | Storage | Scope |
| --- | --- | --- |
| Default to Focus | localStorage `bmus.default-focus` | Browser-wide, across projects. |
| Board blocked-column mode, sort mode, update checks/channel | localStorage `bmus.board` | Browser-wide; defaults: automatic blocked column, manual sort, checks on, stable channel. |
| Theme | localStorage `bmus.theme.{projectId}`; launcher uses `bmus.theme` | Browser/project; reads can fall back to legacy `bmus-theme`. |
| Manual issue order | App config through the order endpoint | Server/project/column; not localStorage or issue metadata. |
| Detail trail, selection, create dialog | React state; current issue also represented in URL | Current project shell. |

- contract: The theme provider's server snapshot is Light. Hydration first matches that snapshot, then applies the saved theme through `data-theme` and the `dark` class. Do not read browser storage unguarded during server rendering.
- contract: Preference hooks use local/custom storage notifications so changes can reach consumers in the current and other browser tabs; these are not Beads/SSE events.
- contract: Board/List reorder requests contain the visible IDs in their desired order. Server persistence and optimistic cache updates replace only those IDs' slots in the saved column order, preserving hidden ranks across facets, archived visibility, and the Done time window. Newly ranked IDs receive appended slots before reordering.
- contract: Order mutations optimistically update the project order cache, restore the previous value on failure, show an error, then invalidate the order query.
- contract: Beads SSE is signal-only and invalidates issue/activity data, not every query. Issues poll using response metadata (5 seconds before metadata); activity uses its own 20-second interval. The configured default issue fallback is 30 seconds.
- contract: The server's Beads watch is shared and non-recursive, with a 200 ms debounce. Nested Dolt rewrites from a read must not trigger another fetch loop. A connected stream alone does not prove its filesystem watch is working.

## 5. Verification and failure clues

- check: Follow [verification policy](verification.md). Source inspection and the doc audit do not exercise hydration, browser history, drag interactions, or stream reconnects.
- failure-clue: Unexpected project data suggests a missing project ID in a query key or callback; inspect the hook and app context together.
- failure-clue: Lost filters suggest a URL update overwrote unrelated parameters. Lost drawer bookmarks after a failed fetch suggest the successful-load guard was bypassed.
- failure-clue: Repeated CLI exports can be a recursive-watch/refetch loop. Delayed activity can also be fallback polling, not necessarily a disconnected browser.
- failure-clue: A theme/default changed only in one browser can be correct: localStorage is intentionally device/browser-local. Server-side ordering has a different scope.
- check: Any direct UI observation should disable usage reporting with an explicitly empty `POSTHOG_KEY`; avoid real issue writes solely to validate documentation.

## 6. Update triggers

Update this document when view precedence, URL keys/history behavior, drawer lifecycle, filter semantics, preference scope, theme hydration, query keys/intervals, ordering, or stream invalidation changes. Keep [configuration](configuration.md) aligned on storage ownership.

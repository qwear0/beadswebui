---
name: beadswebui-doc-maintainer
description: Maintain concise, source-grounded documentation for beadswebui (Bead Me Up, Scotty). Use for repository orientation, documentation impact checks, and changes to Next.js routes, components, hooks, UI/API/storage contracts, Beads CLI integration, streaming, launchers, dependencies, verification policy, docs, skills, or agent instructions. Keep the repository map and narrow feature docs synchronized without creating tests or duplicating historical release notes and plans.
---

# Beadswebui documentation maintainer

Adapted from QSD's documentation-maintenance workflow for this single Next.js application. Keep documentation short, navigable, and useful to the next agent.

## Mission

Help agents find the right source, understand ownership and contract direction, and choose the smallest correct documentation update. Curated docs own stable navigation; a code graph owns high-churn symbol discovery.

## Read first

- Read root `AGENTS.md` and any nearer instruction files.
- Read `docs/repo/repo_structure.md` before deep implementation files.
- Read `docs/repo/runtime-flow.md` for UI/API/Beads or launcher work; read `docs/repo/verification.md` for check policy and limits.
- If repository shape is unclear or the task spans areas, run `python3 .agents/skills/beadswebui-doc-maintainer/scripts/beadswebui_repo_scan.py . --format markdown` from the repository root.
- Read the installed Next.js guide under `node_modules/next/dist/docs/` before framework code changes. Do not substitute remembered conventions for the installed version.

Load references selectively:

- [Documentation principles](references/agent-doc-principles.md): large rewrites and compression decisions.
- [Semantic retrieval policy](references/semantic-retrieval-policy.md): CodeGraph use and evidence boundaries.
- [Update policy](references/update-policy.md): classify scope.
- [Structure template](references/structure-template.md): create or reshape the map.
- [Narrow document template](references/narrow-doc-template.md): document a durable feature flow.
- [Completion checklist](references/update-checklist.md): final impact and audit pass.

## Workflow

### 1. Verify repository shape

This checkout uses `app/`, `components/`, `hooks/`, and `lib/`, plus `bin/` and `scripts/` launchers. These are responsibility areas in one application, not QSD backend/automation containers. Verify actual paths and wiring; do not import external database, deployment, or logging assumptions.

The scanner is read-only and reports paths, not behavioral proof. It skips dependencies, build output, local tracker data, task artifacts, and code indexes. Its output is bounded; use direct reads or `rg` for exhaustive checks.

### 2. Retrieve context selectively

- After reading the map, use a fresh code graph for non-trivial cross-file flows or impact discovery, starting with 1–3 files.
- Treat fresh verbatim source as already read. Do not re-read it without a conflict or staleness signal.
- Treat relationships as candidates, never as proof of completeness or dead code.
- Verify decision-critical route wiring, client/server imports, persistence, CLI subprocesses, callbacks, SSE lifecycle, configuration, and deletions against source, types, runtime configuration, or targeted `rg`.
- Skip graph lookup for exact text, Markdown/configuration, or small known-file changes.
- If the graph is stale or unavailable, use the scanner, `rg`, and direct reads. Do not install or rebuild a provider merely to maintain docs.
- After a non-trivial source edit that used the graph, make one bounded missed-impact query and inspect only new critical candidates.

### 3. Classify the change

Use the smallest adequate class from the update policy: `no-doc`, `map-only`, `feature-doc`, `contract-flow`, `ownership-boundary`, or `convention-or-agent-instructions`.

### 4. Update the minimum correct doc set

- Keep `docs/repo/repo_structure.md` as the navigation map: ownership, reading order, anchors, documentation map, and update triggers.
- Keep narrow docs focused on one durable flow, contract, or verification policy.
- List every Markdown document under `docs/repo/` in section 5 of the structure map with `- doc: ` followed by a backticked repo-relative path and ` - purpose`.
- Keep historical `docs/releases/` and `docs/superpowers/` documents separate from current operational guidance. Do not rewrite historical commands as though the old work had followed today's policy.
- Create additional area maps only when the repository actually needs them; update the audit scope and navigation in the same change.
- Do not place reports, plans, generated graph dumps, or temporary evidence in maintained docs. Use the artifact locations in `AGENTS.md` and Beads for task tracking.

### 5. Compress and ground claims

- Prefer short bullets, one claim each, explicit paths, ownership, and contract direction.
- Target roughly 60–180 lines for a structure map and 30–140 for a narrow doc; do not pad to hit a quota.
- Use English, stable numbered sections, and labels such as `code:`, `entrypoint:`, `contract:`, `owner:`, `check:`, and `doc:`.
- Label recommendations and unverified behavior as such. Source and configuration establish facts; graph summaries alone do not.
- Keep documentation separate from application test infrastructure. Do not introduce tests or temporary test scripts, and do not request test coverage simply because none exists.

### 6. Audit

Run from the repository root:

```bash
python3 .agents/skills/beadswebui-doc-maintainer/scripts/audit_beadswebui_docs.py .
```

A nonzero exit means unresolved documentation work. Fix claims, not just the audit output.

The auditor checks the current `docs/repo/` map and narrow docs, plus local Markdown links/path anchors in this skill. It does not impose current templates on release history, design plans, generated Beads instructions, or README. Inspect any edits to those files directly.

- Map section: 5; required ordered sections: 1–8 for the structure map, 1–6 for narrow docs.
- Markdown links resolve relative to the document; inline source anchors are repository-relative.
- Dependency/build paths and absolute runtime/API paths are not filesystem assertions.
- To document intentional absence, use `absent-path:` with the absent path as its first code span. Other references still require verification.
- Ordinary inline code uses single backticks. Multiple backticks are only for code containing literal backticks.
- The auditor is read-only. Do not guess replacement paths or append generic sections merely to pass it.
- No auditor regression suite is installed; run the tool itself and inspect affected claims. A pass does not prove application behavior or external deployment state.

## Completion summary

State which structure/narrow docs and agent files changed, whether ownership or contracts changed, whether semantic retrieval was used and critical conclusions checked independently, whether the documentation audit passed, and any significant verification limits.

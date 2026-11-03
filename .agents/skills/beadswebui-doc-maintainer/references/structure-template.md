# Repository structure template

Use for `docs/repo/repo_structure.md`. Keep the map concise, generally 60–180 lines. The auditor requires sections 1–8 in order and checks section 5 as the documentation map.

```markdown
# Beadswebui repository structure

> Reading order and stable ownership; implementation detail belongs in narrow docs.

## 1. Scope and ownership
- owner: What this repository owns and does not own.

## 2. Read first
- reads-after: `AGENTS.md` — execution policy.
- reads-after: The relevant narrow document.

## 3. Verified anchors
- entrypoint: A verified repo-relative runtime path.
- code: A verified source path and its purpose.
- contract: Producer -> consumer, with source anchors.

## 4. Responsibility boundaries
- zone: A stable responsibility slice with source anchors.
- owner-rule: A boundary that must remain explicit.

## 5. Documentation map
- doc: `docs/repo/repo_structure.md` - navigation and ownership

## 6. Verification and limits
- check: Available existing check and its limitations.

## 7. Update triggers
- update-when: A structural or contract change.
- skip-when: Local implementation change with unchanged map.

## 8. Completion checks
- check: Map complete, paths valid, ownership still correct.
- check: Audit run and significant verification gaps reported.
```

List every Markdown file under `docs/repo/` with a backticked path and purpose in section 5. Link historical doc directories elsewhere; do not force historical files into the current template.

Use one fact per bullet. Labels include `owner:`, `owner-rule:`, `reads-after:`, `entrypoint:`, `code:`, `contract:`, `zone:`, `doc:`, `check:`, `update-when:`, and `skip-when:`. Do not pad the map with generic filler or deep implementation narratives.

Only verified facts belong under anchors. To state that a path is intentionally absent, use `absent-path:` and put that path in the first code span. Do not exempt unrelated references on the same line.

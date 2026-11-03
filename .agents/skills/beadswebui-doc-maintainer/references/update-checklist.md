# Documentation completion checklist

## 1. Read guidance

Read applicable `AGENTS.md`, the repository structure map, and only the narrow docs needed for this change. Follow installed Next.js docs for framework edits.

## 2. Verify shape and evidence

For unclear or cross-area work, run:

```bash
python3 .agents/skills/beadswebui-doc-maintainer/scripts/beadswebui_repo_scan.py . --format markdown
```

Use fresh semantic retrieval for bounded impact discovery when useful. Verify critical, negative, dynamic, and exhaustive conclusions outside graph summaries. Fall back without blocking on unavailable providers.

## 3. Classify and update

Choose the smallest class in [update-policy.md](update-policy.md). Update changed paths, entrypoints, contracts, ownership, commands, and agent rules. Add every current repo doc to the structure map. Keep history and task artifacts separate.

## 4. Check missed impact

For a non-trivial code edit that used the graph, make one bounded follow-up query and verify new critical candidates. Skip it for docs-only work or unavailable indexes.

## 5. Audit and report

```bash
python3 .agents/skills/beadswebui-doc-maintainer/scripts/audit_beadswebui_docs.py .
```

Fix real drift. Inspect edited README, historical documents, or generated instruction blocks directly; the current-doc audit does not enforce their structure.

State changed structure/narrow docs and agent files, ownership/contract impact, semantic retrieval and independent evidence, audit result, other checks actually run, and significant gaps. Do not create tests or claim runtime verification from a documentation audit.

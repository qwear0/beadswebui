# Semantic retrieval policy

## Core rule

Fresh verbatim source is already read. Graph relationships are navigation candidates, never proof of completeness. Source, types, runtime configuration, and maintained contracts remain authoritative.

## Bounded discovery

| Task | Retrieval |
| --- | --- |
| Unknown implementation or cross-file UI/API/CLI flow | Graph after the structure map; start with 1–3 files |
| Shared API or deletion | Callers/impact candidates, then verify consumers directly |
| Known local file, exact text, Markdown, configuration | Direct read or targeted `rg` |
| Missing/stale index or unindexed path | Local scanner, `rg`, direct reads |

Do not repeat broad queries. Refine only when a concrete missing hop matters. A direct read is sufficient when relationships are not needed.

## Evidence ladder

1. Fresh verbatim source proves only the returned lines.
2. Positive edges guide inspection; they do not prove exhaustive coverage.
3. Summaries and inferred ownership remain hypotheses until critical anchors are verified.
4. Missing edges do not establish “unused,” “no consumers,” or “safe to delete.”

Always verify critical relationships for:

- Next.js route discovery and client/server boundaries;
- API input validation, host/origin and read-only guards;
- project config, filesystem writes, Beads subprocess execution and working directory;
- React callbacks, query invalidation, SSE subscription and shutdown;
- launcher commands, environment wiring and Docker output;
- deletions and test-only dependency classification.

Use the narrowest adequate source, compiler output, configuration, or targeted literal search. Do not create tests or a diagnostic harness for documentation work.

## Freshness and completion

Check provider freshness before relying on output. Read named pending files directly; do not wait indefinitely for an index. Recheck after large moves or deletions. Do not install/rebuild providers unless authorized.

After non-trivial source changes that used semantic retrieval, make one missed-impact query, verify only new critical candidates, then run the normal documentation audit. Skip that query for documentation-only changes or unavailable providers.

Never paste graph output or index snapshots into maintained docs.

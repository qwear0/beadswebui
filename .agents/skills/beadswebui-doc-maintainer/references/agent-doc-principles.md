# Agent-friendly documentation principles

## Layer navigation, do not dump implementation

A future agent should quickly find where to start, who owns a behavior, what contract crosses a boundary, what evidence supports it, and which document changes next.

- `AGENTS.md`: execution rules.
- `docs/repo/repo_structure.md`: stable navigation, ownership, and reading order.
- Narrow docs: durable feature flows expensive to rediscover.
- Skill scripts: read-only repository discovery and documentation audit.
- Semantic index: volatile symbols, callers, and impact candidates.

Keep one source of truth. Tool-specific agent files should remain thin adapters, not divergent copies of the same instructions.

## Keep claims small and verifiable

- Prefer one fact per bullet and repo-relative paths in backticks.
- Use stable labels: `owner:`, `entrypoint:`, `code:`, `contract:`, `check:`, `doc:`, `reads-after:`.
- Prefer “read this next” over repeating a function's implementation.
- Confirm claims with source, types, runtime configuration, and maintained contracts.
- Label assumptions and recommendations instead of presenting them as implemented behavior.
- No tests are required as documentation evidence; follow the retired-test policy in `AGENTS.md`.

## Keep boundaries explicit

Beadswebui is one Next.js application, with browser components and hooks, HTTP route handlers, server-only modules, and local CLI/filesystem integration. Explain producer-to-consumer direction where it matters. Do not invent separate backend services or import QSD deployment assumptions.

## Preserve freshness without rewriting history

Keep entrypoints, configuration, UI/API shapes, Beads storage ownership, launchers, documentation maps, and verification commands current. Update agent instructions only when operational rules change.

Historical release notes and design plans explain past work, not current policy. Link them as history rather than rewriting them into current implementation guarantees.

Prefer a short map and a few narrow documents over generated inventories. Do not copy graph dumps, task transcripts, or model-specific prompting advice into maintained docs.

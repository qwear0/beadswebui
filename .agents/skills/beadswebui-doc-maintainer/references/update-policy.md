# Documentation update policy

Choose the smallest class that keeps navigation and contracts correct.

| Class | Trigger | Minimum scope |
| --- | --- | --- |
| `no-doc` | Local implementation/cosmetic change; paths, behavior contracts and commands unchanged | No doc update |
| `map-only` | Paths, routes, entrypoints or docs added/moved without a deeper contract change | Structure map and stale links |
| `feature-doc` | Durable behavior, state transitions, persistence or external client behavior changes | Narrow doc; map only if anchors change |
| `contract-flow` | UI/hook/API/store/CLI handoff changes | Related narrow docs, affected map anchors and explicit direction |
| `ownership-boundary` | Responsibility moves between client, server, configuration or Beads | Ownership statements, all affected contracts and navigation |
| `convention-or-agent-instructions` | Verification, audit, skill, approval, artifact or agent workflow changes | `AGENTS.md`, skill references, verification doc and map as needed |

## When to create a narrow doc

Create one for repeated rediscovery cost, a multi-step lifecycle, a durable cross-area contract, a dedicated persistence/external-client boundary, or detail that would overwhelm the map.

Do not create one for every cosmetic change, local fix, unchanged refactor, or task-only investigation. Reports belong in ignored task artifacts, not maintained docs.

Merge or delete a narrow doc when its feature disappears, it duplicates the map, or its responsibilities collapse into a simpler flow. Remove stale map links in the same change.

## Ownership defaults to verify

- `app/`: Next.js pages, layout, and HTTP route wiring.
- `components/` and `hooks/`: browser interaction, query state, subscriptions, and view state.
- `lib/schema.ts` and `lib/api-client.ts`: shared data shapes and browser API surface.
- Server-only modules in `lib/`: Beads adapter, store selection, config, filesystem work, publishing, and update services.
- `bin/`, `scripts/`, `Dockerfile`: launch/install/build paths, not business state ownership.

Do not assume all of `lib/` is browser-safe. Verify import boundaries before documenting a shared contract.

## Instruction synchronization

Root `AGENTS.md` owns common operational rules; nearer instructions narrow them; tool adapters should reference rather than duplicate them. Preserve generated Next.js/Beads blocks. Put project-owned overrides outside generated blocks.

No coverage requirement follows from a documentation change. Automated tests remain retired unless the user explicitly requests them.

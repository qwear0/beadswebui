# Verification policy and retired tests

> Current verification workflow for this workspace. `AGENTS.md` owns the policy; this document lists concrete checks and their limits.

## 1. Scope and owner

- Automated tests are retired by explicit project policy. Do not add, restore, extend, or modify tests/test infrastructure without an explicit user request, including temporary or delegated scripts.
- Do not recreate a suite under “diagnostics” or “smoke checks,” or request coverage solely because tests are absent.
- GitHub Actions are disabled for the workspace workflow; do not add, enable, or rely on CI. No tracked workflow files exist here; local inspection does not verify the hosting service's Actions setting.

## 2. Available entry points

Run existing tools from the repository root, choosing only checks relevant to the change:

```bash
npm run lint
./node_modules/.bin/tsc --noEmit --incremental false
node --check scripts/serve.mjs
python3 .agents/skills/beadswebui-doc-maintainer/scripts/audit_beadswebui_docs.py .
```

- `eslint.config.mjs` defines lint scope; reference design exports and generated Next output are excluded.
- `tsconfig.json` defines type-check scope and includes generated Next types when present.
- The documentation auditor checks `docs/repo/` and local skill Markdown; it is not an application test runner.
- `npm run build` is available when build/package integration matters. It writes generated output and is not required merely for doc edits. Next build does not replace the explicit lint command.

## 3. Retirement and retained functionality

- Removed the 36 standalone automated test scripts formerly in the scripts directory.
- Removed the direct Playwright development dependency and its test-only lockfile packages. Next's optional peer metadata may still mention its supported test tooling; that is not an installed project test suite.
- Removed the supervisor's test-only command-injection override. Normal Next launch, exit-code restart, and signal forwarding remain.
- Removed stale test commands from README and the retired-script comment in the request guard. Request guard behavior was not changed.
- There was no package test command or tracked CI workflow to disable.
- Runtime demo mode and sample data remain application features, not test fixtures to delete.
- Historical design plans and release notes are retained as history. Their old verification text does not override current policy.

## 4. Verification method

- Inspect changed behavior and both ends of affected contracts first.
- Use the least costly adequate existing static check or direct application CLI/API/UI observation.
- Do not modify real issue data, invoke update/publish actions, or restart a live server just to validate documentation.
- Report the exact checks run and their outcomes. Compare observations with the requested behavior, not just success output.
- Keep retained evidence under the ignored repository task-artifact directory, not maintained docs or the local tracker export.

## 5. Limits and failure clues

- Lint checks configured static rules, not runtime behavior. Existing unrelated failures must be reported rather than silently waived or fixed out of scope.
- Type checking checks the current source/configuration and available generated types; it does not validate a browser session, installed Beads CLI compatibility, or Docker startup.
- A JavaScript syntax check does not exercise the supervisor lifecycle.
- A documentation audit checks paths, maps, links, and section syntax; it cannot validate an external deployment or prove prose claims true.
- Read `package.json` for engine constraints: the runtime package floor and contributor `devEngines` recommendation differ. Report local engine warnings rather than editing version policy just to suppress them.
- If behavior was not exercised directly, say so. Absence of new tests is intentional, not an unreported verification pass.

## 6. Update triggers

Update this document when check commands, engine constraints, lint/type scope, documentation audit scope, launcher verification boundaries, or the explicit test policy change. A future user-authorized test restoration must update both this document and `AGENTS.md`.

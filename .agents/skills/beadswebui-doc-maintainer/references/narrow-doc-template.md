# Narrow feature document template

Use for one durable flow or contract under `docs/repo/`. Target roughly 30–140 lines; keep sections 1–6 in order.

```markdown
# Feature name

> What this explains and when to read it.

## 1. Scope and owner
- owner: Primary responsibility area and its boundary.
- doc: Link back to the structure map.

## 2. Entry points and key paths
- entrypoint: Verified path.
- code: Relevant source anchors.

## 3. Main flow
- step: Input or trigger.
- step: State transition.
- step: Output or side effect.

## 4. Contracts and data shape
- contract: Producer -> consumer rule.
- contract: Validation or serialization boundary.

## 5. Verification and failure clues
- check: Existing static check or direct CLI/API/UI observation.
- failure-clue: What to inspect first and what is not verified.

## 6. Update triggers
- update-when: Entry point, contract, ownership, or verification policy changes.
```

Adapt titles to the feature while keeping numbered order. Prefer explicit repo-relative paths and one fact per bullet. Link to the structure map instead of repeating its inventory. Include no logging-pipeline assumptions or test-coverage requirements.

Add the document to section 5 of the structure map in the same change. Task-specific reports and plans do not belong here.

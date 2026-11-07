---
phase: 2
plan: 4
requirements: []
files:
  - cadence-core/config.schema.json
  - cadence-core/bin/lib/retired-keys.mjs
  - cadence-core/bin/lib/rung-agent.mjs
  - cadence-core/bin/self-verify.mjs
  - cadence-core/references/config-reach.md
  - cadence-core/workflows/config.md
  - cadence-core/bin/weight-budgets.json
  - docs/guide/configuration/roles.md
  - docs/guide/configuration/index.md
  - tests/config.test.mjs
  - tests/retired-keys.test.mjs
  - tests/rung-agent.test.mjs
  - tests/self-verify.test.mjs
  - tests/config-groups.test.mjs
  - .github/tests-pin
---
- **Files:** cadence-core/config.schema.json (the twelve rows, the `roles.<role>.*` purposes), cadence-core/bin/lib/retired-keys.mjs (`RETIRED_KEYS`, `legacyTestSwitch`), cadence-core/bin/lib/rung-agent.mjs (`EFFORT_PREFIX`, `effortKeyNames`, `effortKeyRole`, `effortEnumIssues`), cadence-core/bin/self-verify.mjs (check 8b's comment), cadence-core/references/config-reach.md, cadence-core/workflows/config.md (the walk's opening paragraph), cadence-core/bin/weight-budgets.json (lease), docs/guide/configuration/roles.md, docs/guide/configuration/index.md, tests/config.test.mjs (`NOT_ASKED`, the `model.effort.<role>` section), tests/retired-keys.test.mjs (`RETIRED_KEYS_SHA256`), tests/rung-agent.test.mjs, tests/self-verify.test.mjs (the fixture's reader line, check 1, check 8b), .github/tests-pin
- **Files:** cadence-core/config.schema.json (`section`, `position`, `_meta.note`, `workflow.max_plan_bytes`), tests/config.test.mjs (`NOT_ASKED`), tests/config-groups.test.mjs, .github/tests-pin

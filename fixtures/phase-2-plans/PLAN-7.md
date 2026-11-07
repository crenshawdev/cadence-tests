---
phase: 2
plan: 7
requirements: []
files:
  - cadence-core/bin/route.mjs
  - cadence-core/bin/lib/arg-contract.mjs
  - cadence-core/bin/lib/config-preview.mjs
  - cadence-core/bin/config.mjs
  - cadence-core/workflows/config.md
  - cadence-core/workflows/config-menu.md
  - cadence-core/bin/weight-budgets.json
  - tests/route.test.mjs
  - tests/arg-contract.test.mjs
  - tests/self-verify.test.mjs
  - tests/config-preview.test.mjs
  - tests/config-menu.test.mjs
  - .github/tests-pin
---
- **Files:** cadence-core/bin/route.mjs (`resolve`, `SYNOPSIS`, `RESOLVE_FLAGS`, `parseArgs`), cadence-core/bin/lib/arg-contract.mjs (`route.mjs` `resolve`), tests/route.test.mjs, tests/arg-contract.test.mjs (`arg-contract-flag-entries`), tests/self-verify.test.mjs (lease), .github/tests-pin
- **Files:** cadence-core/bin/lib/config-preview.mjs, cadence-core/bin/config.mjs, cadence-core/bin/lib/arg-contract.mjs (the `config.mjs` row), tests/config-preview.test.mjs, tests/arg-contract.test.mjs (lease), tests/self-verify.test.mjs (lease), .github/tests-pin
- **Files:** cadence-core/workflows/config-menu.md, cadence-core/workflows/config.md (`### The walk` step 4, the Validation seam's single-`set` sentence, `## Direct set`), cadence-core/bin/weight-budgets.json, tests/config-menu.test.mjs, .github/tests-pin

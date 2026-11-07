---
phase: 2
plan: 1
requirements: []
files:
  - cadence-core/workflows/context.md
  - skills/cad-context/SKILL.md
  - cadence-core/bin/weight-budgets.json
  - tests/seam-calls.test.mjs
  - tests/workflow-scripts.test.mjs
  - workflows/analyzer.js
  - cadence-core/bin/lib/workflow-run.mjs
  - cadence-core/bin/planning/workflow-run.mjs
  - cadence-core/bin/lib/workflow-claim.mjs
  - cadence-core/bin/planning/workflow-claim.mjs
  - cadence-core/bin/lib/arg-contract.mjs
  - INTERNALS.md
  - tests/arg-contract.test.mjs
  - tests/planning-workflow-run.test.mjs
  - tests/planning-workflow-claim.test.mjs
  - tests/trace.test.mjs
  - tests/planning-lease-check.test.mjs
  - tests/phase-spelling.test.mjs
  - tests/config.test.mjs
  - .github/tests-pin
---
- **Files:** cadence-core/workflows/context.md (`analyze`), skills/cad-context/SKILL.md, cadence-core/bin/weight-budgets.json (lease), tests/seam-calls.test.mjs (`CENSUS`), tests/workflow-scripts.test.mjs (the `workflow-run --analyzer` line test), .github/tests-pin
- **Files:** workflows/analyzer.js, cadence-core/bin/lib/workflow-run.mjs (`ANALYZER_FILE`, `ANALYZER_ROLE`, `parseAnalyzerRun`, `agentBrackets`), cadence-core/bin/planning/workflow-run.mjs (`cmdWorkflowRun`, the header), cadence-core/bin/lib/arg-contract.mjs (the `workflow-run` and `workflow-claim take` rows), cadence-core/bin/lib/workflow-claim.mjs, cadence-core/bin/planning/workflow-claim.mjs, INTERNALS.md (the `workflows/` paragraph), tests/workflow-scripts.test.mjs, tests/planning-workflow-run.test.mjs, tests/planning-workflow-claim.test.mjs, tests/arg-contract.test.mjs (`arg-contract-flag-entries`), tests/trace.test.mjs (lease), tests/planning-lease-check.test.mjs (lease), tests/phase-spelling.test.mjs (lease), .github/tests-pin

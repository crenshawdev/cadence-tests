// Pins for how /cad-execute reads plan-overlap's `waves` (Phase 4, plan 1) and the planning.workflow_plans switch (plan 2). choose_path is prose a model follows, so
// these hold what a rewrite could quietly lose; the seam half is in planning-plans.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXECUTE = readFileSync(join(ROOT, 'cadence-core', 'workflows', 'execute.md'), 'utf8');
const CHOOSE = /<step name="choose_path">([\s\S]*?)<\/step>/.exec(EXECUTE)?.[1] ?? '';
const flat = CHOOSE.replace(/\s+/g, ' ');

test('choose_path keeps the judgment clause and names depends_on', () => {
  assert.ok(CHOOSE.length > 0, 'choose_path step found');
  assert.match(flat, /no plan builds on another's output \(your judgment/);
  assert.match(flat, /valid `depends_on` entry/);
});

test('choose_path routes more than one wave to sequential', () => {
  assert.match(flat, /More than one entry in `waves` -> sequential/);
});

test('choose_path makes one plan-overlap call and no second', () => {
  assert.equal((CHOOSE.match(/planning\.mjs" plan-overlap/g) || []).length, 1);
});

// --- the switch -------------------------------------------------------------

// An ordinary boolean read through `get`, so the fixture proves both layers count.
function readSwitch(repo, global) {
  const root = mkdtempSync(join(tmpdir(), 'cad-wfplans-'));
  try {
    mkdirSync(join(root, '.planning'));
    if (repo !== undefined) writeFileSync(join(root, '.planning', 'config.json'), JSON.stringify(repo));
    const g = join(root, 'g.json');
    if (global !== undefined) writeFileSync(g, JSON.stringify(global));
    const out = execFileSync('node', [join(ROOT, 'cadence-core', 'bin', 'config.mjs'), 'get', 'planning.workflow_plans'],
      { encoding: 'utf8', cwd: root, env: { ...process.env, CADENCE_GLOBAL_CONFIG: g } });
    return JSON.parse(out).values['planning.workflow_plans'];
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('planning.workflow_plans reads false when unset and true when the repo or the global layer alone sets it', () => {
  assert.equal(readSwitch({}), false);
  assert.equal(readSwitch({ planning: { workflow_plans: true } }), true);
  assert.equal(readSwitch({}, { planning: { workflow_plans: true } }), true);
});

test('the shipped schema adds no parallelization.waves key', () => {
  assert.doesNotMatch(readFileSync(join(ROOT, 'cadence-core', 'config.schema.json'), 'utf8'), /parallelization\.waves/);
});

// --- the planner's reference ------------------------------------------------

const GRAPH = readFileSync(join(ROOT, 'cadence-core', 'references', 'plan-graph.md'), 'utf8').replace(/\s+/g, ' ');

test('plan-graph.md names the three markers and depends_on, and Reads is no lease and takes path#symbol', () => {
  for (const m of ['**Reads:**', '**Decisions:**', '**Pins:**', '`depends_on`']) assert.ok(GRAPH.includes(m), `${m} is not named`);
  assert.match(GRAPH, /comma-separated `path#symbol` entries/);
  assert.match(GRAPH, /It is not a lease/);
});

test('plan-graph.md puts anchors on Reads and not Files, and a task with nothing leaves the field out and never writes none', () => {
  assert.match(GRAPH, /any anchor your contract would carry onto a path goes on `Reads:` instead/);
  assert.match(GRAPH, /leaves that field out and never writes `none`/);
});

test('plan-graph.md holds the shared-file rule and the one-last-plan rule', () => {
  assert.match(GRAPH, /"more plans, sequential where they share files" wins over "if two slices touch the same file, they are one plan"/);
  assert.match(GRAPH, /in one last plan/);
});

test('plan-graph.md has the planner run plan-overlap and state the width, with a reason at 1, as no gate', () => {
  assert.match(GRAPH, /planning\.mjs" plan-overlap --phase <N>/);
  assert.match(GRAPH, /return states the width, plus one line of reason when it is 1/);
  assert.match(GRAPH, /information and no gate/);
});

test('plan-graph.md names no Cadence-only file, and an inline plan can read the task fields section alone', () => {
  assert.doesNotMatch(GRAPH, /tests-pin|weight-budgets\.json/);
  assert.match(GRAPH, /An inline plan reads only `## The task fields`/);
});

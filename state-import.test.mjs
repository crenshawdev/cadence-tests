// Zero-dep tests for planning/state-import.mjs - a project state built from what `status` derives.
// Run: node --test tests/state-import.test.mjs
// Every readable fixture is also checked against `planning.mjs status` for the same directory, which is what keeps the
// importer and the derivation from drifting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTree, run } from './planning.test.mjs';
import { importState } from '../cadence-core/bin/planning/state-import.mjs';
import { writeState } from '../cadence-core/bin/lib/project-state.mjs';
import { phaseReportsDir } from '../cadence-core/bin/lib/planning-store.mjs';

const report = (dir, phase, k, first) => {
  const rd = phaseReportsDir(join(dir, 'phases', String(phase)));
  mkdirSync(rd, { recursive: true });
  writeFileSync(join(rd, `plan-${k}.md`), `${first}\nPlan: x\n`);
};
const cursor = (phase, total, name, status, next) =>
  ({ phase, total, name, status, next, updated: '2026-02-03' });
const imported = (dir) => {
  const r = importState(dir);
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.state;
};
/** The unfinished plans per phase, the way `status` reports them as `outstanding`. */
const unfinished = (state) => state.phases
  .map((p) => ({ phase: p.n, plans: p.plans.filter((pl) => !pl.finished).map((pl) => pl.file) }))
  .filter((o) => o.plans.length);

/** What `status` answers for the same directory must match the state, field for field it carries. */
function assertMatchesStatus(dir, state, { skipOutstanding = false } = {}) {
  const s = run(['status'], dir);
  assert.equal(s.ok, true);
  assert.deepEqual(state.phases.map((p) => [p.n, p.name, p.status]), s.phases.map((p) => [p.n, p.name, p.status]));
  if (!skipOutstanding) assert.deepEqual(unfinished(state), s.outstanding);
  assert.equal(state.cycleOpen, s.cycle !== 'none');
  if (state.cursor) {
    assert.deepEqual([state.cursor.phase, state.cursor.status, state.cursor.next, state.cursor.updated],
      [s.cursor.phase, s.cursor.status, s.cursor.next, s.cursor.updated]);
  }
}

test('a mid-plan project: finished plans come from reports, the open ones are outstanding', () => {
  const dir = makeTree({
    roadmap: [{ n: 1, name: 'Base', checked: true, desc: 'lay it' }, { n: 2, name: 'Auth', desc: 'sign in' }],
    phases: { 1: { plan: true, summary: true, uat: [{ status: 'pass' }] }, 2: { plan: ['PLAN-1.md', 'PLAN-2.md'] } },
    reqs: [['REQ-1', 1, 'Complete'], ['REQ-2', 2, 'Pending'], ['REQ-3', null, 'Deferred']],
    cursor: cursor(2, 2, 'Auth', 'planned', '/cad-execute 2'),
  });
  report(dir, 1, 1, 'PLAN COMPLETE');
  report(dir, 2, 1, 'PLAN COMPLETE');
  const state = imported(dir);
  assert.equal(state.cycleOpen, true);
  assert.deepEqual(state.phases[1].plans, [{ file: 'PLAN-1.md', finished: true }, { file: 'PLAN-2.md', finished: false }]);
  assert.deepEqual([state.phases[0].description, state.phases[1].description], ['lay it', 'sign in']);
  assert.deepEqual(state.requirements, [
    { id: 'REQ-1', phase: 1, status: 'Complete' }, { id: 'REQ-2', phase: 2, status: 'Pending' },
    { id: 'REQ-3', phase: null, status: 'Deferred' },
  ]);
  assert.deepEqual(state.cursor, { phase: 2, status: 'planned', next: '/cad-execute 2', updated: '2026-02-03' });
  assertMatchesStatus(dir, state);
});

test('a mid-phase project: executed and unplanned phases carry their derived status', () => {
  const dir = makeTree({
    roadmap: [{ n: 1, name: 'Base' }, { n: 2, name: 'Auth' }],
    phases: { 1: { plan: true, summary: true } },
    cursor: cursor(1, 2, 'Base', 'executed', '/cad-verify 1'),
  });
  report(dir, 1, 1, 'PLAN COMPLETE');
  const state = imported(dir);
  assert.deepEqual(state.phases.map((p) => p.status), ['executed', 'unplanned']);
  assert.deepEqual(state.phases[0].plans, [{ file: 'PLAN.md', finished: true }]);
  assert.deepEqual(state.phases[1].plans, []);
  assert.deepEqual(state.requirements, []);
  assertMatchesStatus(dir, state);
});

test('a plan whose report says PARTIAL or is missing is not finished, and only the first line counts', () => {
  const dir = makeTree({
    roadmap: [{ n: 1, name: 'Base' }],
    phases: { 1: { plan: ['PLAN-1.md', 'PLAN-2.md', 'PLAN-3.md'] } },
  });
  report(dir, 1, 1, 'PLAN PARTIAL');
  report(dir, 1, 2, 'PLAN COMPLETE');
  writeFileSync(join(phaseReportsDir(join(dir, 'phases', '1')), 'plan-3.md'), 'Tasks 3 of 3\nPLAN COMPLETE\n');
  const state = imported(dir);
  assert.deepEqual(state.phases[0].plans.map((p) => p.finished), [false, true, false]);
  assertMatchesStatus(dir, state);
});

test('every plan of a phase derived complete is finished, even with no report, and status (which reads the state) lists none as outstanding', () => {
  const dir = makeTree({
    roadmap: [{ n: 1, name: 'Base', checked: true }],
    phases: { 1: { plan: ['PLAN-1.md', 'PLAN-2.md'], summary: true, uat: [{ status: 'pass' }] } },
  });
  const state = imported(dir);
  assert.equal(state.phases[0].status, 'complete');
  assert.deepEqual(state.phases[0].plans.map((p) => p.finished), [true, true]);
  // status reads the state now, so the migration's rule and what status answers are one rule
  assertMatchesStatus(dir, state);
  assert.deepEqual(run(['status'], dir).outstanding, []);
});

test('a workflow run file never decides whether a plan finished', () => {
  const dir = makeTree({ roadmap: [{ n: 1, name: 'Base' }], phases: { 1: { plan: true } } });
  mkdirSync(join(dir, 'records', 'workflow-runs'), { recursive: true });
  writeFileSync(join(dir, 'records', 'workflow-runs', 'run.json'), JSON.stringify({ state: 'complete', plan: 'PLAN.md' }));
  assert.deepEqual(imported(dir).phases[0].plans, [{ file: 'PLAN.md', finished: false }]);
});

test('a closed roadmap imports as no cycle open, with its requirements and cursor kept', () => {
  const dir = makeTree({
    reqs: [['REQ-1', 1, 'Complete']],
    cursor: cursor(0, 0, 'no active cycle', 'phase complete', '/cad-new-milestone'),
  });
  writeFileSync(join(dir, 'ROADMAP.md'), '# Roadmap\n\n## Phases\n\n');
  const state = imported(dir);
  assert.equal(state.cycleOpen, false);
  assert.deepEqual(state.phases, []);
  assert.equal(state.cursor.next, '/cad-new-milestone');
  assert.equal(state.requirements.length, 1);
  assertMatchesStatus(dir, state);
});

test('a roadmap status refuses is refused with the same reason, detail and issues', () => {
  const dir = makeTree({});
  writeFileSync(join(dir, 'ROADMAP.md'), '# Roadmap\n\n## Phases\n\n- Phase 1: Ship auth\n');
  const r = importState(dir);
  const s = run(['status'], dir);
  assert.equal(r.ok, false);
  assert.deepEqual([r.reason, r.detail, r.issues], [s.reason, s.detail, s.issues]);
  assert.ok(r.hint);
  const noSection = makeTree({});
  writeFileSync(join(noSection, 'ROADMAP.md'), '# Roadmap\n\nnothing here\n');
  const n = importState(noSection);
  assert.deepEqual([n.ok, n.reason, n.detail], [false, 'unparseable-roadmap', run(['status'], noSection).detail]);
});

test('no ROADMAP.md: a planning directory with nothing in it is a project not set up, with an empty state and no cycle open', () => {
  const empty = makeTree({});
  assert.deepEqual(imported(empty), { cycleOpen: false, cursor: null, phases: [], requirements: [] });
  // config and records alone are not work
  const setup = makeTree({ config: { memory: { backend: 'none' } } });
  mkdirSync(join(setup, 'records'));
  mkdirSync(join(setup, 'phases'));
  assert.equal(importState(setup).ok, true);
});

test('no ROADMAP.md beside a phases entry, an archive folder or STATE.md is a refusal', () => {
  const withPhase = makeTree({ phases: { 1: { plan: true } }, roadmap: false });
  const withArchive = makeTree({});
  mkdirSync(join(withArchive, '_archive-v1.0.0'));
  const withState = makeTree({ cursor: cursor(1, 1, 'Base', 'planned', 'x') });
  for (const dir of [withPhase, withArchive, withState]) {
    const r = importState(dir);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-roadmap');
    assert.ok(r.hint);
  }
});

test('a cursor status outside the six lifecycle words is left out; the rest of the state is intact', () => {
  const dir = makeTree({
    roadmap: [{ n: 1, name: 'Base' }], phases: { 1: { plan: true } },
    cursor: cursor(1, 1, 'Base', 'in progress', '/cad-execute 1'),
  });
  const state = imported(dir);
  assert.equal(state.cursor, null);
  assert.equal(state.phases.length, 1);
});

test('a paused cursor carries its Next text word for word at any length', () => {
  const long = `${'wait for the vendor to answer, then pick it up again. '.repeat(12)}done.`;
  assert.ok(long.length > 500);
  const dir = makeTree({
    roadmap: [{ n: 1, name: 'Base' }], phases: { 1: { plan: true } },
    cursor: cursor(1, 1, 'Base', 'paused', long),
  });
  const state = imported(dir);
  assert.equal(state.cursor.status, 'paused');
  assert.equal(state.cursor.next, long);
});

test('the importer writes nothing and never opens .planning/state.json', () => {
  const dir = makeTree({ roadmap: [{ n: 1, name: 'Base' }], phases: { 1: { plan: true } } });
  const rust = '{"version":1,"generation":2}';
  writeFileSync(join(dir, 'state.json'), rust);
  const before = readdirSync(dir).sort();
  imported(dir);
  assert.deepEqual(readdirSync(dir).sort(), before);
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), rust);
});

test('a `Plan: 0 of 2` line is dropped from the cursor, and what is imported is a state the writer accepts', () => {
  const dir = makeTree({
    roadmap: [{ n: 1, name: 'Base' }], phases: { 1: { plan: ['PLAN-0.md', 'PLAN-1.md'] } },
    cursor: cursor(1, 1, 'Base', 'planned', '/cad-execute 1'),
  });
  appendFileSync(join(dir, 'STATE.md'), 'Plan: 0 of 2\n');
  assert.equal(run(['status'], dir).ok, true);
  const state = imported(dir);
  assert.equal(state.cursor.status, 'planned');
  assert.equal('plan' in state.cursor, false);
  assert.equal(writeState(dir, state).ok, true);
  // the first seam stamps it, and the next one still answers
  assert.equal(run(['cursor', 'get'], dir).ok, true);
});

test('a phase whose name parses blank is named by its number, and the state is one the writer accepts', () => {
  const dir = makeTree({ roadmap: [{ n: 1, name: ' ' }], phases: { 1: { plan: true } } });
  const state = imported(dir);
  assert.equal(state.phases[0].name, 'Phase 1');
  assert.equal(writeState(dir, state).ok, true);
  assert.equal(run(['status'], dir).ok, true);
  assert.equal(run(['status'], dir).ok, true);
});

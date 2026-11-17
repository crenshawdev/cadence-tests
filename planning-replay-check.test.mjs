// Zero-dep tests for `planning.mjs replay-check`. Run:
// node --test 'tests/*.test.mjs'
//
// These are the fixture tests phase 2's acceptance criteria could not have.
// While the replay decision was prose in `workflows/execute.md`, AC1-AC5 were
// observable only by running `/cad-execute` for real and reading
// `.planning/trace.jsonl` afterwards, so each one shipped unverified. The
// criterion each test settles is named on the test, because that link is the
// reason this file exists.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { PLANNING, ensureRoadmap, isEntryFile, scratch } from './planning.test.mjs';

const test = isEntryFile(import.meta.url) ? nodeTest : () => {};

/**
 * A `.planning` tree for one phase.
 * `plans` names the plan files; `reports` maps plan number -> that report's
 * whole body, and a number left out has NO report file, which is the state a
 * genuine continuation is in. `headings` maps a plan filename to its H1 line.
 * Its mkdtemp root goes when test `t` ends.
 */
function tree(t, { phase = 2, plans = ['PLAN.md'], reports = {}, headings = {} } = {}) {
  const dir = join(scratch('cad-replay-', t), '.planning');
  const pdir = join(dir, 'phases', String(phase));
  mkdirSync(pdir, { recursive: true });
  ensureRoadmap(dir);
  for (const p of plans) {
    writeFileSync(join(pdir, p), `---\nphase: ${phase}\nfiles: []\n---\n${headings[p] ?? '# plan'}\n`);
  }
  if (Object.keys(reports).length) mkdirSync(join(pdir, 'records', 'reports'), { recursive: true });
  for (const [k, body] of Object.entries(reports)) {
    writeFileSync(join(pdir, 'records', 'reports', `plan-${k}.md`), body);
  }
  return dir;
}

function check(dir, args = []) {
  let stdout;
  let code = 0;
  try {
    stdout = execFileSync('node', [PLANNING, 'replay-check', ...args, '--dir', dir], { encoding: 'utf8' });
  } catch (e) { stdout = e.stdout; code = e.status; }
  return { ...JSON.parse(stdout), _exit: code };
}

// --- AC1: the replay is recognised ------------------------------------------

test('AC1: every plan reporting PLAN COMPLETE is a replay, and nothing is dispatched', (t) => {
  const dir = tree(t, { reports: { 1: 'PLAN COMPLETE\nTasks: 3 of 3\n' } });
  const r = check(dir, ['--phase', '2']);

  assert.equal(r.ok, true);
  assert.equal(r.replay, true);
  assert.deepEqual(r.dispatch_set, []);
  // The caller composes its stop text from what was READ, so the paths it must
  // name come back rather than being re-derived at the message.
  assert.deepEqual(r.reports_read, ['phases/2/records/reports/plan-1.md']);
});

test('AC1: a multi-plan phase is a replay only when EVERY plan reports complete', (t) => {
  const dir = tree(t, {
    plans: ['PLAN-1.md', 'PLAN-2.md'],
    reports: { 1: 'PLAN COMPLETE\n', 2: 'PLAN COMPLETE\n' },
  });
  const r = check(dir, ['--phase', '2']);

  assert.equal(r.replay, true);
  assert.deepEqual(r.dispatch_set, []);
  assert.deepEqual(r.reports_read,
    ['phases/2/records/reports/plan-1.md', 'phases/2/records/reports/plan-2.md']);
});

// --- AC2: a genuine continuation still dispatches ---------------------------

test('AC2: no reports directory at all is not a replay', (t) => {
  const r = check(tree(t), ['--phase', '2']);

  assert.equal(r.replay, false);
  assert.deepEqual(r.dispatch_set, ['PLAN.md']);
  assert.deepEqual(r.reports_read, []);
  assert.equal(r.reports[0].exists, false);
});

test('AC2: PLAN PARTIAL is a continuation, not a replay', (t) => {
  const dir = tree(t, { reports: { 1: 'PLAN PARTIAL\nTasks: 2 of 5\n' } });
  const r = check(dir, ['--phase', '2']);

  assert.equal(r.replay, false);
  assert.deepEqual(r.dispatch_set, ['PLAN.md']);
});

test('AC2: PLAN CHECKPOINT is a continuation, not a replay', (t) => {
  const dir = tree(t, { reports: { 1: 'PLAN CHECKPOINT: decision\n' } });
  assert.equal(check(dir, ['--phase', '2']).replay, false);
});

test('AC2: the status word is the FIRST LINE ONLY - a quoted one in the body cannot fire it', (t) => {
  // The exact shape the prose test could not pin: a genuine continuation whose
  // open items happen to quote the words. A whole-file search reads this as a
  // replay and refuses a run that has real work left.
  const dir = tree(t, {
    reports: { 1: 'PLAN PARTIAL\nTasks: 2 of 5\n\nOpen items:\n- the last run said PLAN COMPLETE too early\n' },
  });
  const r = check(dir, ['--phase', '2']);

  assert.equal(r.replay, false, 'a PLAN COMPLETE quoted in the body is prose about a status, not a claim of one');
  assert.deepEqual(r.dispatch_set, ['PLAN.md']);
});

test('AC2: the first line must match EXACTLY - a suffixed status is not complete', (t) => {
  const dir = tree(t, { reports: { 1: 'PLAN COMPLETE - archived\n' } });
  assert.equal(check(dir, ['--phase', '2']).replay, false);
});

// --- AC3: the per-plan skip -------------------------------------------------

test('AC3: plan 1 complete and plan 2 unreported dispatches ONLY plan 2', (t) => {
  const dir = tree(t, {
    plans: ['PLAN-1.md', 'PLAN-2.md'],
    reports: { 1: 'PLAN COMPLETE\nTasks: 4 of 4\n' },
  });
  const r = check(dir, ['--phase', '2']);

  assert.equal(r.replay, false, 'one plan still has work, so the run proceeds');
  assert.deepEqual(r.dispatch_set, ['PLAN-2.md'], 'plan 1 is not re-dispatched');
});

test('AC3: a partially reported phase skips only the plans that finished', (t) => {
  const dir = tree(t, {
    plans: ['PLAN-1.md', 'PLAN-2.md', 'PLAN-3.md'],
    reports: { 1: 'PLAN COMPLETE\n', 2: 'PLAN PARTIAL\n', 3: 'PLAN COMPLETE\n' },
  });
  const r = check(dir, ['--phase', '2']);

  assert.equal(r.replay, false);
  assert.deepEqual(r.dispatch_set, ['PLAN-2.md']);
});

// --- AC4: --rerun -----------------------------------------------------------

test('a phase past nine plans lists and dispatches PLAN-10 after PLAN-9, in number order', (t) => {
  const plans = ['PLAN-1.md', 'PLAN-2.md', 'PLAN-9.md', 'PLAN-10.md', 'PLAN-11.md'];
  const r = check(tree(t, { plans }), ['--phase', '2']);

  assert.deepEqual(r.reports.map((p) => p.plan), plans);
  assert.deepEqual(r.dispatch_set, plans);
});

test('AC4: --rerun clears the replay and widens the dispatch set to every plan', (t) => {
  const dir = tree(t, {
    plans: ['PLAN-1.md', 'PLAN-2.md'],
    reports: { 1: 'PLAN COMPLETE\n', 2: 'PLAN COMPLETE\n' },
  });
  const r = check(dir, ['--phase', '2', '--rerun']);

  assert.equal(r.rerun, true);
  assert.equal(r.replay, false);
  assert.deepEqual(r.dispatch_set, ['PLAN-1.md', 'PLAN-2.md']);
  // The reports are still READ under --rerun, so the run can say what it is
  // running over rather than pretending it did not look.
  assert.equal(r.reports_read.length, 2);
});

// --- the report path the executor actually writes ---------------------------

test('a bare PLAN.md is keyed k=1 and PLAN-<k>.md by its own number', (t) => {
  const dir = tree(t, { plans: ['PLAN-3.md'], reports: { 3: 'PLAN COMPLETE\n' } });
  const r = check(dir, ['--phase', '2']);

  assert.equal(r.reports[0].k, 3);
  assert.equal(r.reports[0].report, 'phases/2/records/reports/plan-3.md');
  assert.equal(r.replay, true);
});

test('a rotated sibling plan-<k>.<n>.md never decides the answer', (t) => {
  // report-rotation.mjs mints these when an executor rotates a prior run's
  // report aside. A glob would let the OLD run's report answer for this one.
  const dir = tree(t, { reports: { '1.1': 'PLAN COMPLETE\n' } });
  const r = check(dir, ['--phase', '2']);

  assert.equal(r.replay, false, 'plan-1.1.md is not plan-1.md');
  assert.deepEqual(r.dispatch_set, ['PLAN.md']);
});

// --- plan position: the count and each plan's name ---------------------------

const named = {
  'PLAN-1.md': '# Phase 2: X - Plan 1: Alpha',
  'PLAN-2.md': '# Phase 2: X - Plan 2: Beta',
  'PLAN-3.md': '# Phase 2: X - Plan 3: Gamma',
};

test('plan_count is every plan, each row carries k and its name, dispatch_set unchanged', (t) => {
  const dir = tree(t, {
    plans: ['PLAN-1.md', 'PLAN-2.md', 'PLAN-3.md'],
    headings: named,
    reports: { 1: 'PLAN COMPLETE\n' },
  });
  const r = check(dir, ['--phase', '2']);

  assert.equal(r.plan_count, 3);
  assert.deepEqual(r.reports.map((x) => [x.k, x.name]), [[1, 'Alpha'], [2, 'Beta'], [3, 'Gamma']]);
  assert.deepEqual(r.dispatch_set, ['PLAN-2.md', 'PLAN-3.md']);
});

test('plan_count under --rerun is still every plan', (t) => {
  const dir = tree(t, {
    plans: ['PLAN-1.md', 'PLAN-2.md', 'PLAN-3.md'],
    headings: named,
    reports: { 1: 'PLAN COMPLETE\n' },
  });
  const r = check(dir, ['--phase', '2', '--rerun']);

  assert.equal(r.plan_count, 3);
  assert.deepEqual(r.dispatch_set, ['PLAN-1.md', 'PLAN-2.md', 'PLAN-3.md']);
});

test('a plan headed "- Plan 2" has no name field on its row', (t) => {
  const dir = tree(t, {
    plans: ['PLAN-1.md', 'PLAN-2.md'],
    headings: { 'PLAN-1.md': named['PLAN-1.md'], 'PLAN-2.md': '# Phase 2: X - Plan 2' },
  });
  const r = check(dir, ['--phase', '2']);

  assert.equal(r.reports[0].name, 'Alpha');
  assert.equal('name' in r.reports[1], false);
});

test('a lone PLAN.md is plan 1 of 1 with its name', (t) => {
  const dir = tree(t, { plans: ['PLAN.md'], headings: { 'PLAN.md': '# Phase 2: X - Plan 1: Y' } });
  const r = check(dir, ['--phase', '2']);

  assert.equal(r.plan_count, 1);
  assert.equal(r.reports.length, 1);
  assert.equal(r.reports[0].k, 1);
  assert.equal(r.reports[0].name, 'Y');
});

// --- refusals ---------------------------------------------------------------

test('a phase with no plan files is not a replay - that is the unplanned state', (t) => {
  // `[].every(...)` is true, so without the length guard an unplanned phase
  // reports as already executed and its first real run is refused.
  const dir = tree(t, { plans: [] });
  const r = check(dir, ['--phase', '2']);

  assert.equal(r.replay, false);
  assert.deepEqual(r.dispatch_set, []);
});

test('a missing phase directory refuses by name and exits non-zero', (t) => {
  const r = check(tree(t), ['--phase', '9']);

  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-phase-dir');
  assert.equal(r._exit, 1);
});

test('no --phase refuses by name rather than guessing a phase', (t) => {
  const r = check(tree(t), []);

  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad-args');
  assert.match(r.detail, /replay-check needs --phase/);
  assert.equal(r._exit, 1);
});

// AC3 (phase 1, retire the legacy test switches): a project with no
// `testing.scope` and the four old keys still true gets no replacement step.
// A plan's legacy `## Evidence map` and `## Tests` are inert text, and a report
// with no `Test evidence:` section completes as it stands.
test('a no-policy plan with legacy sections and no evidence section completes, report untouched', (t) => {
  const phase = 3;
  const legacy = '---\nphase: 3\nfiles: []\n---\n# Plan\n\n## Evidence map\n\n| Check | Task |\n|---|---|\n| AC1 | 1 |\n\n## Tests\n\n| Test | Task |\n|---|---|\n| a | 1 |\n';
  const roadmap = '# Roadmap: Fixture\n\n## Overview\n\nx\n\n## Phases\n\n- [ ] **Phase 3: Three** - desc\n\n## Phase Details\n\n### Phase 3: Three\n**Goal:** goal 3\n**Depends on:** Nothing\n';
  const settle = (body) => {
    const dir = tree(t, { phase, reports: { 1: body } });
    writeFileSync(join(dir, 'phases', String(phase), 'PLAN.md'), legacy);
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      workflow: { test_attack: true, test_evidence: true, check_inspection: true, independent_rerun: true },
    }));
    writeFileSync(join(dir, 'ROADMAP.md'), roadmap);
    const replay = check(dir, ['--phase', String(phase)]);
    const status = JSON.parse(execFileSync('node', [PLANNING, 'status', '--dir', dir], { encoding: 'utf8' }));
    return { dir, replay, status };
  };

  const body = 'PLAN COMPLETE\nTasks: 2 of 2\n\nDeviations: none\n';
  const done = settle(body);
  assert.equal(done.replay.replay, true);
  assert.deepEqual(done.replay.dispatch_set, []);
  assert.deepEqual(done.status.outstanding, []);
  assert.equal(readFileSync(join(done.dir, 'phases', '3', 'records', 'reports', 'plan-1.md'), 'utf8'), body);

  // Without this, an empty `outstanding` would pass on a phase `status` never saw.
  const partial = settle(body.replace('PLAN COMPLETE', 'PLAN PARTIAL'));
  assert.deepEqual(partial.status.outstanding, [{ phase, plans: ['PLAN.md'] }]);
});

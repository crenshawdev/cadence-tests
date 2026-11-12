// Zero-dep tests for `planning.mjs status`. Run:
// node --test 'tests/*.test.mjs'
//
// Split out of planning.test.mjs in phase 4, verbatim: the arms and their
// comments are unchanged, only their home is. The fixture harness stays in
// planning.test.mjs and is imported, never copied - two copies of `makeTree`
// is how two fixtures drift apart.
//
// The `test` binding below is a no-op unless this module IS the entry file,
// so a sibling that imports a fixture from here registers nothing twice.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTree, run, isEntryFile, verifyChecked } from './planning.test.mjs';
import { phaseReviewPath, phaseReturnPath } from '../cadence-core/bin/lib/planning-store.mjs';
import { readState, writeState } from '../cadence-core/bin/lib/project-state.mjs';

/** `node:test`'s `test` when run directly, a no-op when imported (see header). */
const test = isEntryFile(import.meta.url) ? nodeTest : () => {};

// --- status: failure shapes --------------------------------------------------

test('status: missing .planning degrades with a recovery hint', () => {
  const r = run(['status'], join(tmpdir(), 'cad-does-not-exist'));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-planning-dir');
  assert.equal(r.hint, '/cad-new-project');
  assert.equal(r._exit, 1);
});

test('status: missing ROADMAP.md is no-roadmap', () => {
  const dir = makeTree({});
  const r = run(['status'], dir);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-roadmap');
});

// The phase-list grammar reaches the seam here; its breadth is pinned at
// parser level in planning-files.test.mjs (each of these pays a node spawn).

test('status: a ## Phases section holding no phase token is a closed milestone, not a parse failure', () => {
  const dir = makeTree({});
  writeFileSync(join(dir, 'ROADMAP.md'), '# Roadmap\n\n## Phases\n\n(nothing)\n');
  const r = run(['status'], dir);
  assert.equal(r.ok, true);
  assert.equal(r.cycle, 'none');
  assert.equal(r.current, null);
  assert.equal(r.total, 0);
  assert.equal(r._exit, 0);
});

test('status: a non-canonical phase-shaped line is unparseable-roadmap with a per-line diagnostic', () => {
  const dir = makeTree({});
  writeFileSync(join(dir, 'ROADMAP.md'), '# Roadmap\n\n## Phases\n\n- Phase 1: Ship auth\n');
  const r = run(['status'], dir);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unparseable-roadmap');
  assert.equal(r.issues[0].code, 'phase-bullet');
  assert.equal(r.issues[0].line, 5);
  assert.equal(r.detail, 'line 5: - Phase 1: Ship auth');
});

test('status: a wiped checkbox list whose ### Phase N: details survive is NOT a closed milestone', () => {
  const dir = makeTree({});
  writeFileSync(join(dir, 'ROADMAP.md'),
    '# Roadmap\n\n## Phases\n\n\n## Phase Details\n\n### Phase 1: Auth\n**Goal:** ship it\n');
  const r = run(['status'], dir);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unparseable-roadmap');
  assert.equal(r.issues[0].code, 'phase-heading');
  assert.equal(r.issues[0].text, '### Phase 1: Auth');
});

test('status: no ## Phases section at all is still unparseable-roadmap', () => {
  const dir = makeTree({});
  writeFileSync(join(dir, 'ROADMAP.md'), '# Roadmap\n\n## Overview\n\nx\n');
  const r = run(['status'], dir);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unparseable-roadmap');
  assert.equal(r.detail, 'no `## Phases` section in ROADMAP.md');
});

test('status: an interrupted close reports the closed state AND a phase-dir drift entry', () => {
  const dir = makeTree({ roadmap: [], phases: { 2: { plan: true } } });
  const r = run(['status'], dir);
  assert.equal(r.ok, true);
  assert.equal(r.cycle, 'none');
  assert.deepEqual(r.drift, [{
    kind: 'phase-dir', phase: 2, dir: '2',
    detail: 'phases/2/ survives the milestone close (1 plan files)',
  }]);
});

test('status: a closed cycle is the state having no phases, and a cursor of that cycle agrees', () => {
  const dir = makeTree({ roadmap: [1, 2].map((n) => ({ n, name: `P${n}` })) });
  assert.equal(run(['cursor', 'set', '--phase', '2', '--status', 'phase complete', '--next', '/cad-milestone'], dir).ok, true);
  const held = readState(dir).state;
  assert.equal(writeState(dir, { ...held, phases: [], cycleOpen: false }).ok, true);
  const r = run(['status'], dir);
  assert.equal(r.ok, true);
  assert.equal(r.cycle, 'none');
  assert.equal(r.cursor.agrees, true);
  assert.equal(r.drift, undefined);
});

test('status: a finished close (cursor of 0) reports no drift at all', () => {
  const dir = makeTree({
    roadmap: [],
    cursor: { phase: 1, total: 0, name: 'no active cycle', status: 'ready to plan', next: '/cad-phase add', updated: '2026-01-01' },
  });
  const r = run(['status'], dir);
  assert.equal(r.ok, true);
  assert.equal(r.cycle, 'none');
  assert.equal(r.cursor.agrees, true);
  assert.equal(r.drift, undefined);
});

// Against an empty phase list the cursor is the only surviving evidence, so
// the agreement mapping is what keeps drift detection alive (D-09).
const CLOSED_AGREEMENT = [
  { status: 'phase complete', agrees: true },
  { status: 'ready to plan', agrees: true },
  { status: 'paused', agrees: true },
  { status: 'planned', agrees: false },
  { status: 'executed', agrees: false },
  { status: 'context gathered', agrees: false },
];

for (const row of CLOSED_AGREEMENT) {
  test(`status: closed milestone, cursor "${row.status}" agrees=${row.agrees}`, () => {
    const dir = makeTree({
      roadmap: [],
      cursor: { phase: 1, total: 0, name: 'no active cycle', status: row.status, next: '/cad-phase add', updated: '2026-01-01' },
    });
    const r = run(['status'], dir);
    assert.equal(r.ok, true);
    assert.equal(r.cycle, 'none');
    assert.equal(r.cursor.agrees, row.agrees);
    if (row.agrees) {
      assert.equal(r.drift, undefined);
    } else {
      assert.equal(r.drift[0].kind, 'cursor');
      assert.match(r.drift[0].detail, /derived closed milestone \(no phases in ROADMAP\)/);
    }
  });
}

test('status: a file at the reviews-area and returns-area paths leaves status ok with the same phases', () => {
  const dir = makeTree({
    roadmap: [{ n: 1, name: 'One' }],
    phases: { 1: { plan: true, summary: true } },
  });
  const before = run(['status'], dir);
  assert.equal(before.ok, true, JSON.stringify(before));
  const phaseDir = join(dir, 'phases', '1');
  for (const p of [phaseReviewPath(phaseDir, 'a-review.md'), phaseReturnPath(phaseDir, 'a-return.json')]) {
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, 'x\n');
  }
  const after = run(['status'], dir);
  assert.equal(after.ok, true, JSON.stringify(after));
  assert.deepEqual(after.phases, before.phases);
});

// --- status: derivation ------------------------------------------------------

test('status: derives unplanned/planned/executed/complete from artifacts', () => {
  const dir = makeTree({
    roadmap: [
      { n: 1, name: 'Done', checked: true },
      { n: 2, name: 'Built' },
      { n: 3, name: 'Planned' },
      { n: 4, name: 'Future' },
    ],
    phases: {
      1: { plan: true, summary: true, uat: [{ status: 'pass' }, { status: 'skipped', reason: 'n/a here' }] },
      2: { plan: true, summary: true, uat: [{ status: 'pass' }, { status: 'fail' }, { status: 'pending' }] },
      3: { plan: true },
    },
  });
  verifyChecked(dir);
  const r = run(['status'], dir);
  assert.equal(r.ok, true);
  assert.deepEqual(r.phases.map((p) => p.status), ['complete', 'executed', 'planned', 'unplanned']);
  assert.equal(r.current, 2); // lowest non-complete
  assert.equal(r.total, 4);
  assert.deepEqual(r.phases[1].uat, { pass: 1, fail: 1, pending: 1, skipped: 0, blocked: 0 });
  assert.equal(r.phases[0].plans, undefined); // single PLAN.md is the default - omitted
  assert.equal(r.drift, undefined); // boxes all agree with derivation - omitted
});

test('status: SUMMARY without UAT is executed, not complete', () => {
  const dir = makeTree({
    roadmap: [{ n: 1, name: 'Only' }],
    phases: { 1: { plan: true, summary: true } },
  });
  const r = run(['status'], dir);
  assert.equal(r.phases[0].status, 'executed');
});

test('status: all complete -> current null; multi-plan files listed', () => {
  const dir = makeTree({
    roadmap: [{ n: 1, name: 'Only', checked: true }],
    phases: { 1: { plan: ['PLAN-1.md', 'PLAN-2.md'], summary: true, uat: [{ status: 'pass' }] } },
  });
  verifyChecked(dir);
  const r = run(['status'], dir);
  assert.equal(r.current, null);
  assert.deepEqual(r.phases[0].plans, ['PLAN-1.md', 'PLAN-2.md']);
});

test('status: skipped without a reason blocks completeness', () => {
  const dir = makeTree({
    roadmap: [{ n: 1, name: 'Only' }],
    phases: { 1: { plan: true, summary: true, uat: [{ status: 'pass' }, { status: 'skipped' }] } },
  });
  const r = run(['status'], dir);
  assert.equal(r.phases[0].status, 'executed');
});

// --- status: drift -----------------------------------------------------------

test('status: roadmap-box drift both directions, judged by the state against what the artifacts derive', () => {
  const dir = makeTree({
    roadmap: [{ n: 1, name: 'DoneUnchecked' }, { n: 2, name: 'OpenChecked' }],
    phases: { 1: { plan: true }, 2: { plan: true } },
  });
  assert.equal(run(['status'], dir).drift, undefined, 'a freshly imported project agrees with its artifacts');
  // phase 1's artifacts now derive complete while the state says planned; phase 2 is recorded complete with no summary
  const p1 = join(dir, 'phases', '1');
  writeFileSync(join(p1, 'SUMMARY.md'), '---\nphase: 1\nstatus: complete\n---\n');
  writeFileSync(join(p1, 'UAT.md'), '---\nstatus: complete\nphase: 1\n---\n\n## Items\n\n### 1. x\nexpected: y\nstatus: pass\n\n## Summary\n\ntotal: 1\n');
  const held = readState(dir).state;
  assert.equal(writeState(dir, { ...held, phases: held.phases.map((p) => (p.n === 2 ? { ...p, status: 'complete' } : p)) }).ok, true);
  const r = run(['status'], dir);
  const kinds = r.drift.map((d) => `${d.kind}:${d.phase}`);
  assert.ok(kinds.includes('roadmap-box:1'));
  assert.ok(kinds.includes('roadmap-box:2'));
  assert.equal(r.phases.find((p) => p.n === 2).status, 'complete', 'the state\'s status is the one reported');
});

test('status: hand-checking a box, adding a phase line or breaking a line in the list changes nothing it answers', () => {
  const dir = makeTree({ roadmap: [{ n: 1, name: 'One' }, { n: 2, name: 'Two' }], phases: { 1: { plan: true } } });
  const before = run(['status'], dir);
  const file = join(dir, 'ROADMAP.md');
  const text = readFileSync(file, 'utf8');
  for (const edited of [
    text.replace('- [ ] **Phase 1: One**', '- [x] **Phase 1: One**'),
    text.replace('- [ ] **Phase 2: Two** - desc\n', '- [ ] **Phase 2: Two** - desc\n- [ ] **Phase 3: Invented** - desc\n'),
    text.replace('- [ ] **Phase 2: Two** - desc\n', '- Phase 3: X\n'),
  ]) {
    writeFileSync(file, edited);
    const r = run(['status'], dir);
    assert.equal(r.ok, true);
    assert.deepEqual(r, before);
  }
});

test('status: a roadmap with no ## Phases heading is still refused', () => {
  const dir = makeTree({ roadmap: [{ n: 1, name: 'One' }] });
  assert.equal(run(['status'], dir).ok, true);
  writeFileSync(join(dir, 'ROADMAP.md'), '# Roadmap\n\nnothing listed\n');
  const r = run(['status'], dir);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unparseable-roadmap');
});

test('status: req-status drift; Deferred and unmapped rows exempt', () => {
  const dir = makeTree({
    roadmap: [{ n: 1, name: 'Done', checked: true }, { n: 2, name: 'Open' }],
    phases: {
      1: { plan: true, summary: true, uat: [{ status: 'pass' }] },
      2: { plan: true },
    },
    reqs: [
      ['REQ-1', 1, 'Pending'],   // phase complete, row Pending -> drift
      ['REQ-2', 2, 'Complete'],  // phase planned, row Complete -> drift
      ['REQ-3', 2, 'Deferred'],  // exempt
      ['REQ-4', null, 'Pending'],// unmapped: audit's concern, not drift
    ],
  });
  verifyChecked(dir);
  const r = run(['status'], dir);
  const reqDrift = r.drift.filter((d) => d.kind === 'req-status');
  assert.equal(reqDrift.length, 2);
  assert.match(reqDrift[0].detail, /REQ-1/);
  assert.match(reqDrift[1].detail, /REQ-2/);
});

test('status: cursor agreement and disagreement', () => {
  const spec = {
    roadmap: [{ n: 1, name: 'Only' }],
    phases: { 1: { plan: true } },
    cursor: { phase: 1, total: 1, name: 'Only', status: 'planned', next: '/cad-execute 1', updated: '2026-01-01' },
  };
  const agree = run(['status'], makeTree(spec));
  assert.equal(agree.cursor.agrees, true);
  assert.equal(agree.drift, undefined);

  const stale = run(['status'], makeTree({
    ...spec,
    cursor: { ...spec.cursor, status: 'executed' }, // derivation says planned
  }));
  assert.equal(stale.cursor.agrees, false);
  assert.equal(stale.drift[0].kind, 'cursor');
});

test('status: decimal insertion phases sort and derive like integers', () => {
  const dir = makeTree({
    roadmap: [{ n: 1, name: 'One', checked: true }, { n: 2.1, name: 'Hotfix' }, { n: 3, name: 'Three' }],
    phases: {
      1: { plan: true, summary: true, uat: [{ status: 'pass' }] },
      '2.1': { plan: true },
    },
  });
  verifyChecked(dir);
  const r = run(['status'], dir);
  assert.equal(r.ok, true);
  assert.deepEqual(r.phases.map((p) => p.n), [1, 2.1, 3]); // numeric sort, 2.1 between
  assert.deepEqual(r.phases.map((p) => p.status), ['complete', 'planned', 'unplanned']);
  assert.equal(r.current, 2.1); // lowest non-complete, decimals included
  assert.equal(r.total, 3);
});

test('status: paused cursor always agrees (legal at any point)', () => {
  const r = run(['status'], makeTree({
    roadmap: [{ n: 1, name: 'Only' }],
    phases: { 1: { plan: true } },
    cursor: { phase: 1, total: 1, name: 'Only', status: 'paused', next: 'resume: finish task 2', updated: '2026-01-01' },
  }));
  assert.equal(r.cursor.agrees, true);
});

// --- status: the phase-directory grammar, reported and never resolved --------
//
// D-01: Cadence states numeric-only as the grammar and REPORTS what violates it.
// It does not learn to resolve `08-meteogram-legend`, ship a `<N>-<slug>` second
// form, or migrate anything - so these rows assert a diagnostic, never a lookup.

/** `phases/<name>/` directories on a tree, created empty. */
function phaseDirs(dir, names) {
  for (const name of names) mkdirSync(join(dir, 'phases', name), { recursive: true });
  return dir;
}

const grammarDrift = (r) => (r.drift || []).filter((d) => d.kind === 'phase-dir-grammar');

test('status: named and zero-padded phase dirs are reported, grouped by prefix', () => {
  const dir = makeTree({ roadmap: [{ n: 1, name: 'One' }], phases: { 1: { plan: true } } });
  phaseDirs(dir, ['08-meteogram-legend', '08', '14-data-depth-x', '14-shared-derivation']);
  const r = run(['status'], dir);
  assert.equal(r.ok, true, JSON.stringify(r));
  const g = grammarDrift(r);
  assert.equal(g.length, 2, JSON.stringify(g));
  assert.deepEqual(g[0].entries, ['08', '08-meteogram-legend']);
  assert.match(g[0].detail, /share numeric prefix 8/);
  assert.deepEqual(g[1].entries, ['14-data-depth-x', '14-shared-derivation']);
  assert.match(g[1].detail, /share numeric prefix 14/);
  // The legal directory is never itself an entry, and the kind carries no
  // `phase` key - there is no phase number to report.
  assert.equal(g.some((d) => d.entries.includes('1')), false);
  assert.equal('phase' in g[0], false);
});

test('status: a tree of legal phase dirs reports no drift at all', () => {
  const dir = makeTree({
    roadmap: [{ n: 1, name: 'One' }, { n: 2, name: 'Two' }, { n: 10, name: 'Ten' }],
    phases: { 1: { plan: true }, 2: { plan: true }, 10: { plan: true } },
  });
  phaseDirs(dir, ['2.1']);
  const r = run(['status'], dir);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.drift, undefined, JSON.stringify(r.drift));
});

test('status: a stray FILE under phases/ is not a phase directory and is not reported', () => {
  const dir = makeTree({ roadmap: [{ n: 1, name: 'One' }], phases: { 1: { plan: true } } });
  writeFileSync(join(dir, 'phases', '.DS_Store'), 'junk');
  writeFileSync(join(dir, 'phases', 'notes.md'), '# scratch\n');
  const r = run(['status'], dir);
  assert.equal(r.ok, true);
  assert.deepEqual(grammarDrift(r), []);
});

test('status: 08 beside a legal 8 names the phase it collides with', () => {
  const dir = makeTree({ roadmap: [{ n: 8, name: 'Eight' }], phases: { 8: { plan: true } } });
  phaseDirs(dir, ['08']);
  const r = run(['status'], dir);
  const g = grammarDrift(r);
  assert.equal(g.length, 1, JSON.stringify(g));
  assert.deepEqual(g[0].entries, ['08']);   // exactly the illegal one
  assert.match(g[0].detail, /phases[/\\]?8 is the phase they collide with/);
  assert.match(g[0].detail, /is not a phase directory name/);
});

// The FRACTION obeys the same no-padding rule as the integer part (phase 4
// D-01/D-02): `1.01` and `1.00` are padded spellings that would normalize onto
// phase 1, and `2.0` is not a fraction at all rather than a second spelling of
// phase 2. `1.10` is NOT padded - it is sub-phase ten - and stays legal, which
// is why the rule cannot be `String(Number(x)) === x`: that round trip accepts
// `1.01` and refuses `1.10`, exactly backwards.
test('status: a zero-padded fraction is reported and 1.10 is not', () => {
  const dir = makeTree({
    roadmap: [{ n: 1, name: 'One' }, { n: 2, name: 'Two' }],
    phases: { 1: { plan: true }, 2: { plan: true } },
  });
  phaseDirs(dir, ['1.00', '1.01', '1.1', '1.10', '2.0', '8']);
  const r = run(['status'], dir);
  assert.equal(r.ok, true, JSON.stringify(r));
  const g = grammarDrift(r);
  assert.equal(g.length, 2, JSON.stringify(g));
  assert.deepEqual(g[0].entries, ['1.00', '1.01']);
  assert.match(g[0].detail, /phases[/\\]?1(,|\s)/);
  assert.deepEqual(g[1].entries, ['2.0']);
  assert.match(g[1].detail, /phases[/\\]?2 is the phase they collide with/);
  // The legal names never earn an entry of their own.
  assert.equal(g.some((d) => d.entries.some((e) => ['1.1', '1.10', '8'].includes(e))), false);
  // The parenthetical states the fraction rule, not just the integer one.
  assert.match(g[0].detail, /neither part zero-padded/);
});

// The surviving-directory filter reads the GRAMMAR, not a looser numeric shape
// (D-04). With `/^\d+(\.\d+)?$/` there, `phases/08` beside `phases/8` passed the
// filter and `Number('08')` collapsed it onto 8, so the close reported the same
// phase twice.
test('status: 08 beside 8 survives the close as ONE phase-dir entry, on the legal name', () => {
  const dir = makeTree({ roadmap: [], phases: { 8: { plan: true }, '08': { plan: true } } });
  const r = run(['status'], dir);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.cycle, 'none');
  const survivors = (r.drift || []).filter((d) => d.kind === 'phase-dir');
  assert.equal(survivors.length, 1, JSON.stringify(survivors));
  assert.equal(survivors[0].phase, 8);
  assert.match(survivors[0].detail, /phases[/\\]?8[/\\] survives/);
  // `08` is still REPORTED - under the grammar kind, which is where it belongs.
  assert.deepEqual(grammarDrift(r).map((d) => d.entries), [['08']]);
});

// `phases/1.10/` is a legal sub-phase name and the tightened filter keeps it.
// `phase` is the number the name parses to and `dir` is the name: `Number` maps
// `1.10` onto `1.1`, so the record has to carry the spelling to say which
// directory it describes.
test('status: a legal sub-phase directory still survives the close', () => {
  const dir = makeTree({ roadmap: [], phases: { '1.10': { plan: true } } });
  const r = run(['status'], dir);
  assert.equal(r.ok, true, JSON.stringify(r));
  const survivors = (r.drift || []).filter((d) => d.kind === 'phase-dir');
  assert.equal(survivors.length, 1, JSON.stringify(survivors));
  assert.equal(survivors[0].phase, 1.1);
  assert.equal(survivors[0].dir, '1.10');
  assert.deepEqual(grammarDrift(r), []);
});

// Two LEGAL names that parse to one number. Neither is grammar drift and
// neither is preferable, so the collision is reported under its own kind rather
// than resolved - the same answer an illegal name gets, one step over.
test('status: two legal sub-phases that parse to one number are reported', () => {
  const dir = makeTree({
    roadmap: [], phases: { 1.1: { plan: true }, '1.10': { plan: true } },
  });
  const r = run(['status'], dir);
  assert.equal(r.ok, true, JSON.stringify(r));
  const survivors = (r.drift || []).filter((d) => d.kind === 'phase-dir');
  assert.deepEqual(survivors.map((d) => d.dir), ['1.1', '1.10'], JSON.stringify(survivors));
  const collisions = (r.drift || []).filter((d) => d.kind === 'phase-dir-collision');
  assert.equal(collisions.length, 1, JSON.stringify(collisions));
  assert.equal(collisions[0].phase, 1.1);
  assert.deepEqual(collisions[0].entries, ['1.1', '1.10']);
  assert.match(collisions[0].detail, /both parse to 1\.1/);
  // Every name here is legal, so the grammar walk stays silent.
  assert.deepEqual(grammarDrift(r), []);
});

// A tree with no collision produces no entry of that kind at all.
test('status: distinct sub-phase numbers report no collision', () => {
  const dir = makeTree({
    roadmap: [], phases: { 1.1: { plan: true }, 1.2: { plan: true }, 8: { plan: true } },
  });
  const r = run(['status'], dir);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual((r.drift || []).filter((d) => d.kind === 'phase-dir-collision'), []);
});

// --- the outstanding set: a SUMMARY is the end of a run, not of the work -----
//
// The defect these pin: /cad-progress read "this phase has a SUMMARY" as "this
// phase is executed, go verify it", so a gap plan written after that SUMMARY
// was named by nothing. `status` now carries the same fact `replay-check`
// dispatches on, off ONE definition (`readPlanReports`), and the third row
// below is that one-definition claim made observable rather than asserted.

/** Executor reports under `phases/<n>/records/reports/`, keyed by plan number. */
function writeReports(dir, n, byPlan) {
  const rdir = join(dir, 'phases', String(n), 'records', 'reports');
  mkdirSync(rdir, { recursive: true });
  for (const [k, body] of Object.entries(byPlan)) {
    writeFileSync(join(rdir, `plan-${k}.md`), body);
  }
  return dir;
}

/** A phase 1 holding a SUMMARY, `PLAN.md` and `PLAN-2.md`. */
const gapPlanTree = () => makeTree({
  roadmap: [{ n: 1, name: 'One' }],
  phases: { 1: { plan: ['PLAN.md', 'PLAN-2.md'], summary: true } },
});

test('status: an unexecuted gap plan beside a SUMMARY is executed AND outstanding', () => {
  const dir = writeReports(gapPlanTree(), 1, { 1: 'PLAN COMPLETE\nTasks: 2 of 2\n' });
  const r = run(['status'], dir);
  assert.equal(r.ok, true, JSON.stringify(r));
  // The derived status is untouched - this narrows what `executed` MEANS to a
  // router, it does not mint a status or invert the row.
  assert.equal(r.phases[0].status, 'executed', JSON.stringify(r.phases));
  assert.deepEqual(r.outstanding, [{ phase: 1, plans: ['PLAN-2.md'] }], JSON.stringify(r.outstanding));
});

test('status: a PLAN COMPLETE report at the old reports/ path no longer counts', () => {
  const dir = gapPlanTree();
  const old = join(dir, 'phases', '1', 'reports');
  mkdirSync(old, { recursive: true });
  for (const k of [1, 2]) writeFileSync(join(old, `plan-${k}.md`), 'PLAN COMPLETE\nTasks: 1 of 1\n');
  const r = run(['status'], dir);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.outstanding, [{ phase: 1, plans: ['PLAN.md', 'PLAN-2.md'] }], JSON.stringify(r.outstanding));
});

test('status: every plan reporting complete lists the phase nowhere, and the key is still there', () => {
  const dir = writeReports(gapPlanTree(), 1, {
    1: 'PLAN COMPLETE\nTasks: 2 of 2\n', 2: 'PLAN COMPLETE\nTasks: 1 of 1\n',
  });
  const r = run(['status'], dir);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.phases[0].status, 'executed', JSON.stringify(r.phases));
  // PRESENT and empty, never absent: a caller has to be able to tell "nothing
  // is outstanding" from "this seam predates the field", and only a key that
  // survives the empty state separates them.
  assert.ok(Object.prototype.hasOwnProperty.call(r, 'outstanding'), JSON.stringify(r));
  assert.deepEqual(r.outstanding, []);
});

test('status: the outstanding plan list IS replay-check\'s dispatch_set, from one definition', () => {
  const dir = writeReports(gapPlanTree(), 1, {
    1: 'PLAN COMPLETE\nTasks: 2 of 2\n', 2: 'PLAN PARTIAL\nTasks: 1 of 3\n',
  });
  const status = run(['status'], dir);
  const replay = run(['replay-check', '--phase', '1'], dir);
  assert.equal(status.ok, true, JSON.stringify(status));
  assert.equal(replay.ok, true, JSON.stringify(replay));
  const listed = (status.outstanding.find((e) => e.phase === 1) || {}).plans;
  assert.deepEqual(listed, replay.dispatch_set, JSON.stringify({ listed, dispatch_set: replay.dispatch_set }));
  assert.deepEqual(listed, ['PLAN-2.md']);
});

test('status: a planned phase that has run nothing is outstanding in full', () => {
  const dir = makeTree({
    roadmap: [{ n: 1, name: 'One' }], phases: { 1: { plan: ['PLAN.md', 'PLAN-2.md'] } },
  });
  const r = run(['status'], dir);
  assert.equal(r.phases[0].status, 'planned', JSON.stringify(r.phases));
  // Plan-number order, so the bare `PLAN.md` (plan 1) precedes `PLAN-2.md`: the
  // one comparator both `derivePhases` and `listPlanFiles` apply, which is why
  // this list and `replay-check`'s dispatch set stay deep-equal above.
  assert.deepEqual(r.outstanding, [{ phase: 1, plans: ['PLAN.md', 'PLAN-2.md'] }]);
});

test('status: a phase past nine plans lists and leaves outstanding PLAN-10 after PLAN-9, in number order', () => {
  const names = ['PLAN-1.md', 'PLAN-2.md', 'PLAN-9.md', 'PLAN-10.md', 'PLAN-11.md'];
  const dir = makeTree({ roadmap: [{ n: 1, name: 'One' }], phases: { 1: { plan: names } } });
  const r = run(['status'], dir);
  assert.deepEqual(r.phases[0].plans, names, JSON.stringify(r.phases[0].plans));
  assert.deepEqual(r.outstanding, [{ phase: 1, plans: names }], JSON.stringify(r.outstanding));
});

test('status: an unplanned phase has no plans and so takes no entry', () => {
  const r = run(['status'], makeTree({ roadmap: [{ n: 1, name: 'One' }] }));
  assert.equal(r.phases[0].status, 'unplanned');
  assert.deepEqual(r.outstanding, []);
});

// --- status: the plan position (phase 1, D-03, D-06, D-08, D-12) -----------------

/** Phase 2 of a two-phase roadmap holding the named plan files, `# Phase 2: Auth - Plan K: Name K`. */
function positionTree(files, complete = [], stateExtra = '') {
  const dir = makeTree({ roadmap: [{ n: 1, name: 'One', checked: true }, { n: 2, name: 'Auth' }],
    phases: { 1: { plan: true, summary: true, uat: [{ status: 'pass' }] } } });
  const pdir = join(dir, 'phases', '2');
  mkdirSync(join(pdir, 'records', 'reports'), { recursive: true });
  mkdirSync(join(dir, 'phases', '1', 'records', 'reports'), { recursive: true });
  writeFileSync(join(dir, 'phases', '1', 'records', 'reports', 'plan-1.md'), 'PLAN COMPLETE\n');
  for (const f of files) {
    const k = Number(/PLAN-(\d+)\.md/.exec(f)?.[1] ?? 1);
    writeFileSync(join(pdir, f), `# Phase 2: Auth - Plan ${k}: Name ${k}\n`);
  }
  for (const k of complete) writeFileSync(join(pdir, 'records', 'reports', `plan-${k}.md`), 'PLAN COMPLETE\n');
  writeFileSync(join(dir, 'STATE.md'),
    `# State\n\nPhase: 2 of 2 (Auth)\n${stateExtra}Status: planned\nNext: /cad-execute 2\nUpdated: 2026-01-01\n`);
  return dir;
}
const phase2 = (r) => r.phases.find((p) => p.n === 2);

test('status: a phase with an unfinished plan carries its derived position, and only then', () => {
  const part = run(['status'], positionTree(['PLAN-1.md', 'PLAN-2.md', 'PLAN-3.md'], [1]));
  assert.deepEqual(phase2(part).plan, { k: 2, j: 3, name: 'Name 2' });
  assert.ok(!('plan' in part.phases.find((p) => p.n === 1)));

  const done = run(['status'], positionTree(['PLAN-1.md', 'PLAN-2.md'], [1, 2]));
  assert.ok(!('plan' in phase2(done)));

  const unplanned = run(['status'], positionTree([]));
  assert.ok(!('plan' in phase2(unplanned)));

  const ten = run(['status'], positionTree(Array.from({ length: 10 }, (_, i) => `PLAN-${i + 1}.md`), [1]));
  assert.equal(phase2(ten).plan.k, 2);
});

test('status: the cursor block carries its Plan: line as written, and a mismatch with disk is not drift', () => {
  const r = run(['status'], positionTree(['PLAN-1.md', 'PLAN-2.md', 'PLAN-3.md'], [1], 'Plan: 1 of 3 (x)\n'));
  assert.deepEqual(r.cursor.plan, { k: 1, j: 3, name: 'x' });
  assert.deepEqual(phase2(r).plan, { k: 2, j: 3, name: 'Name 2' });
  assert.equal(r.cursor.agrees, true);
  assert.ok(!(r.drift || []).some((d) => d.kind === 'cursor'));
});

test('status: a four-line cursor block has exactly its five keys', () => {
  const r = run(['status'], positionTree(['PLAN-1.md']));
  assert.deepEqual(Object.keys(r.cursor).sort(), ['agrees', 'next', 'phase', 'status', 'updated']);
});

// --- status: plan completion is the state's (plan 7, task 4) --------------------------------------------

const planStates = (dir, n) => readState(dir).state.phases.find((p) => p.n === n).plans.map((p) => `${p.file}:${p.finished}`);
const writeReport = (dir, n, k, first = 'PLAN COMPLETE') => {
  mkdirSync(join(dir, 'phases', String(n), 'records', 'reports'), { recursive: true });
  writeFileSync(join(dir, 'phases', String(n), 'records', 'reports', `plan-${k}.md`), `${first}\nPlan: x\n`);
};

test('status: a PLAN COMPLETE report is drift until a seam folds it, then the plan is finished in the state and the position moves', () => {
  const dir = positionTree(['PLAN-1.md', 'PLAN-2.md']);
  const before = run(['status'], dir);
  assert.deepEqual(phase2(before).plan, { k: 1, j: 2, name: 'Name 1' });
  assert.deepEqual(before.outstanding, [{ phase: 2, plans: ['PLAN-1.md', 'PLAN-2.md'] }]);
  assert.equal(before.drift, undefined);

  writeReport(dir, 2, 1);
  const drifted = run(['status'], dir);
  const entries = drifted.drift.filter((d) => d.kind === 'plan-report');
  assert.equal(entries.length, 1);
  assert.deepEqual([entries[0].phase, entries[0].plan], [2, 1]);
  assert.equal(typeof entries[0].detail, 'string');
  assert.deepEqual(phase2(drifted).plan, { k: 1, j: 2, name: 'Name 1' }, 'status answers from the state and writes nothing');
  assert.deepEqual(planStates(dir, 2), ['PLAN-1.md:false', 'PLAN-2.md:false']);

  const replay = run(['replay-check', '--phase', '2'], dir);
  assert.equal(replay.ok, true);
  assert.deepEqual(planStates(dir, 2), ['PLAN-1.md:true', 'PLAN-2.md:false']);
  const after = run(['status'], dir);
  assert.equal((after.drift || []).filter((d) => d.kind === 'plan-report').length, 0);
  assert.deepEqual(after.outstanding, [{ phase: 2, plans: ['PLAN-2.md'] }]);
  assert.deepEqual(phase2(after).plan, { k: 2, j: 2, name: 'Name 2' });
});

test('cursor set folds a PLAN COMPLETE report into the state, and a first line that only quotes it does not count', () => {
  const dir = positionTree(['PLAN-1.md', 'PLAN-2.md']);
  assert.equal(run(['status'], dir).ok, true);
  writeReport(dir, 2, 1);
  writeReport(dir, 2, 2, 'PLAN PARTIAL - was PLAN COMPLETE');
  const set = run(['cursor', 'set', '--phase', '2', '--status', 'planned', '--next', '/cad-execute 2'], dir);
  assert.deepEqual(set.cursor.plan, { k: 2, j: 2, name: 'Name 2' });
  assert.deepEqual(planStates(dir, 2), ['PLAN-1.md:true', 'PLAN-2.md:false']);
});

test('status: a phase held complete reads every plan finished even with no report (D-23)', () => {
  const dir = positionTree(['PLAN-1.md', 'PLAN-2.md']);
  assert.equal(run(['status'], dir).ok, true);
  assert.equal(run(['phase-done', '--n', '2'], dir).ok, true);
  assert.equal(run(['replay-check', '--phase', '2'], dir).ok, true);
  assert.deepEqual(planStates(dir, 2), ['PLAN-1.md:true', 'PLAN-2.md:true']);
  const r = run(['status'], dir);
  assert.deepEqual(r.outstanding, []);
  assert.ok(!('plan' in phase2(r)));
  const replay = run(['replay-check', '--phase', '2'], dir);
  assert.equal(replay.replay, true);
  assert.deepEqual(replay.dispatch_set, []);
});

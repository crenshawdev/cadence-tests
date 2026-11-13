// Zero-dep tests for `planning.mjs phase-entry add|edit`. Run:
// node --test tests/planning-phase-entry.test.mjs
//
// The seam that writes a phase's number, name and one-line description into the
// state, where the `## Phases` line is rendered from. The shared harness lives
// in planning.test.mjs and is imported, never copied.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseReachTable } from '../cadence-core/bin/lib/config-reach.mjs';
import { parseRoadmapPhases } from '../cadence-core/bin/lib/planning-files.mjs';
import { readState, statePath, writeState } from '../cadence-core/bin/lib/project-state.mjs';
import { renderStateMd } from '../cadence-core/bin/lib/state-views.mjs';
import { CYCLE, appendEvent, tracePath } from '../cadence-core/bin/lib/trace.mjs';
import { makeTree, run, isEntryFile, today, verifyChecked } from './planning.test.mjs';
import { renumberTree } from './planning-renumber.test.mjs';

/** `node:test`'s `test` when run directly, a no-op when imported. */
const test = isEntryFile(import.meta.url) ? nodeTest : () => {};

const roadmapOf = (dir) => readFileSync(join(dir, 'ROADMAP.md'), 'utf8');
const stateBytes = (dir) => readFileSync(statePath(dir), 'utf8');
const listOf = (dir) => parseRoadmapPhases(roadmapOf(dir)).map((p) => [p.n, p.name, p.desc]);

/** A stamped three-phase project, so a refusal's "nothing written" is measured against a state that exists. */
function threePhases() {
  const dir = renumberTree();
  assert.equal(run(['status'], dir).ok, true);
  return dir;
}

test('phase-entry add: the phase lands in the state as unplanned, and its generated line reads back as sent, name by file', () => {
  const dir = threePhases();
  const nameFile = join(mkdtempSync(join(tmpdir(), 'cad-entry-')), 'name.txt');
  writeFileSync(nameFile, 'Reports & exports\n');
  const r = run(['phase-entry', 'add', '--phase', '4', '--name-file', nameFile, '--description', 'CSV and PDF out'], dir);
  assert.equal(r.ok, true);
  assert.deepEqual([r.phase, r.name, r.description], [4, 'Reports & exports', 'CSV and PDF out']);
  assert.deepEqual(readState(dir).state.phases.at(-1),
    { n: 4, name: 'Reports & exports', description: 'CSV and PDF out', status: 'unplanned', plans: [] });
  assert.deepEqual(listOf(dir).at(-1), [4, 'Reports & exports', 'CSV and PDF out']);
  assert.match(roadmapOf(dir), /^### Phase 3: Three$/m, 'the hand-written detail sections stay');
  assert.doesNotMatch(roadmapOf(dir), /### Phase 4/, 'no detail section is invented');
});

test('phase-entry add: a held number, a newline, an unreadable line and a bad phase spelling are refused, state and roadmap byte-identical', () => {
  const dir = threePhases();
  const state = stateBytes(dir);
  const roadmap = roadmapOf(dir);
  const cases = [
    [['--phase', '2', '--name', 'Dup', '--description', 'd'], 'phase-exists'],
    [['--phase', '4', '--name', 'Two\nlines', '--description', 'd'], 'bad-args'],
    [['--phase', '4', '--name', 'Four', '--description', 'one\r\ntwo'], 'bad-args'],
    [['--phase', '4', '--name', 'A** - B', '--description', 'd'], 'bad-args'],
    [['--phase', 'four', '--name', 'Four', '--description', 'd'], 'bad-args'],
    [['--phase', '1.10', '--name', 'Four', '--description', 'd'], 'bad-args'],
  ];
  for (const [args, reason] of cases) {
    const r = run(['phase-entry', 'add', ...args], dir);
    assert.deepEqual([r.ok, r.reason, typeof r.hint], [false, reason, 'string'], JSON.stringify(args));
    assert.equal(stateBytes(dir), state, `state untouched: ${JSON.stringify(args)}`);
    assert.equal(roadmapOf(dir), roadmap, `roadmap untouched: ${JSON.stringify(args)}`);
  }
});

test('phase-entry add refuses 0, 0.5 and 1.05, which no phase directory carries, while edit still reaches a held phase 0', () => {
  const dir = threePhases();
  const state = stateBytes(dir);
  const roadmap = roadmapOf(dir);
  for (const n of ['0', '0.5', '1.05']) {
    const r = run(['phase-entry', 'add', '--phase', n, '--name', 'Odd', '--description', 'd'], dir);
    assert.deepEqual([r.ok, r.reason, typeof r.hint], [false, 'bad-args', 'string'], n);
    assert.match(r.hint, /nothing was written/, n);
    assert.equal(stateBytes(dir), state, `state untouched: ${n}`);
    assert.equal(roadmapOf(dir), roadmap, `roadmap untouched: ${n}`);
  }
  // a project may already hold a 0 from before the gate, and edit is how it gets renamed
  const held = readState(dir).state;
  const zero = { n: 0, name: 'Zero', description: 'd', status: 'unplanned', plans: [] };
  assert.equal(writeState(dir, { ...held, phases: [zero, ...held.phases] }).ok, true);
  const edit = run(['phase-entry', 'edit', '--phase', '0', '--name', 'Groundwork'], dir);
  assert.deepEqual([edit.ok, edit.phase, edit.name], [true, 0, 'Groundwork']);
});

test('phase-entry add fills the slot renumber insert freed, and the list reads 1 to 4 in order', () => {
  const dir = threePhases();
  assert.equal(run(['renumber', 'insert', '--at', '2'], dir).ok, true);
  const r = run(['phase-entry', 'add', '--phase', '2', '--name', 'Inserted', '--description', 'new work'], dir);
  assert.equal(r.ok, true);
  assert.deepEqual(listOf(dir), [[1, 'One', 'desc'], [2, 'Inserted', 'new work'], [3, 'Two', 'desc'], [4, 'Three', 'desc']]);
  assert.deepEqual(readState(dir).state.phases.map((p) => p.n), [1, 2, 3, 4]);
});

test('phase-entry add: the first phase into a state with no cycle open opens it, and status stops answering cycle: none', () => {
  const dir = makeTree({ roadmap: [] });
  assert.equal(run(['status'], dir).cycle, 'none');
  const r = run(['phase-entry', 'add', '--phase', '1', '--name', 'Start', '--description', 'the first phase'], dir);
  assert.deepEqual([r.ok, r.opened_cycle], [true, true]);
  assert.equal(readState(dir).state.cycleOpen, true);
  const status = run(['status'], dir);
  assert.equal(status.ok, true);
  assert.equal('cycle' in status, false);
  assert.deepEqual(listOf(dir), [[1, 'Start', 'the first phase']]);
});

test('phase-entry add on an open cycle renders STATE.md from the state, so its total follows the list', () => {
  const dir = threePhases();
  assert.equal(run(['phase-entry', 'add', '--phase', '4', '--name', 'Four', '--description', 'd'], dir).ok, true);
  const stateMd = readFileSync(join(dir, 'STATE.md'), 'utf8');
  assert.equal(stateMd, renderStateMd(readState(dir).state));
  assert.match(stateMd, /^Phase: 2 of 4 \(Two\)$/m);
});

// --- the cursor an add writes ----------------------------------------------------
// the global layer is pointed at nothing, so a skip_discuss set on this machine can't steer the next step
const NO_GLOBAL = { CADENCE_GLOBAL_CONFIG: join(tmpdir(), 'cad-no-such-global.json') };
const add = (dir, n) => run(['phase-entry', 'add', '--phase', String(n), '--name', `P${n}`, '--description', 'd'], dir, undefined, NO_GLOBAL);
// status leaves `drift` off when there is none
const cursorDrift = (dir) => {
  const status = run(['status'], dir, undefined, NO_GLOBAL);
  assert.equal(status.ok, true);
  return (status.drift ?? []).filter((d) => d.kind === 'cursor');
};

/** An open cycle whose two phases are both complete, the cursor at `status`. */
function allComplete(status) {
  const dir = makeTree({
    roadmap: [{ n: 1, name: 'One', checked: true }, { n: 2, name: 'Two', checked: true }],
    phases: { 1: { plan: true, summary: true }, 2: { plan: true, summary: true } },
    cursor: { phase: 2, total: 2, name: 'Two', status, next: '/cad-milestone', updated: '2026-01-01' },
  });
  verifyChecked(dir);
  return dir;
}

test('phase-entry add with no cycle open points the cursor at the new phase, ready to plan, and status finds no cursor drift', () => {
  const dir = makeTree({ roadmap: [] });
  assert.equal(add(dir, 1).ok, true);
  assert.deepEqual(readState(dir).state.cursor, { phase: 1, status: 'ready to plan', next: '/cad-context 1', updated: today() });
  assert.deepEqual(cursorDrift(dir), []);
});

test('phase-entry add with workflow.skip_discuss true names /cad-plan N as the next step', () => {
  const dir = makeTree({ roadmap: [], config: { workflow: { skip_discuss: true } } });
  assert.equal(add(dir, 1).ok, true);
  assert.deepEqual(readState(dir).state.cursor, { phase: 1, status: 'ready to plan', next: '/cad-plan 1', updated: today() });
});

test('phase-entry add into an open cycle whose phases are all complete moves the cursor to the new phase, no drift', () => {
  const dir = allComplete('phase complete');
  assert.equal(add(dir, 3).ok, true);
  assert.deepEqual(readState(dir).state.cursor, { phase: 3, status: 'ready to plan', next: '/cad-context 3', updated: today() });
  assert.deepEqual(cursorDrift(dir), []);
});

test('phase-entry add leaves the cursor as it was beside an unfinished phase, and on a paused cursor', () => {
  for (const dir of [threePhases(), allComplete('paused')]) {
    const before = readState(dir).state.cursor;
    assert.ok(before, 'the fixture has a cursor to keep');
    assert.equal(add(dir, 4).ok, true);
    assert.deepEqual(readState(dir).state.cursor, before);
  }
});

test('the reach table names phase-entry.mjs as a reader of workflow.skip_discuss, since the add\'s cursor reads it', () => {
  const { rows } = parseReachTable(readFileSync(new URL('../cadence-core/references/config-reach.md', import.meta.url), 'utf8'));
  const row = rows?.find((r) => r.key === 'workflow.skip_discuss');
  assert.ok(row, 'the key has a reach row');
  assert.match(row.honouredBy, /bin\/planning\/phase-entry\.mjs/);
});

test('phase-entry edit changes the phase\'s line and nothing else in ROADMAP.md', () => {
  const dir = threePhases();
  const before = roadmapOf(dir).split('\n');
  const r = run(['phase-entry', 'edit', '--phase', '2', '--description', 'rewritten'], dir);
  assert.deepEqual([r.ok, r.name, r.description], [true, 'Two', 'rewritten']);
  const after = roadmapOf(dir).split('\n');
  assert.equal(after.length, before.length);
  const changed = after.flatMap((l, i) => (l === before[i] ? [] : [[before[i], l]]));
  assert.deepEqual(changed, [['- [ ] **Phase 2: Two** - desc', '- [ ] **Phase 2: Two** - rewritten']]);
  assert.equal(readState(dir).state.phases[1].description, 'rewritten');
  const renamed = run(['phase-entry', 'edit', '--phase', '2', '--name', 'Second'], dir);
  assert.deepEqual([renamed.ok, renamed.description], [true, 'rewritten']);
  assert.match(roadmapOf(dir), /^- \[ \] \*\*Phase 2: Second\*\* - rewritten$/m);
  assert.match(roadmapOf(dir), /^### Phase 2: Two$/m, 'the detail section stays hand-written');
});

test('phase-entry edit refuses a phase the state does not hold, and an edit naming nothing', () => {
  const dir = threePhases();
  const state = stateBytes(dir);
  const unknown = run(['phase-entry', 'edit', '--phase', '9', '--name', 'Nine'], dir);
  assert.deepEqual([unknown.ok, unknown.reason], [false, 'unknown-phase']);
  const empty = run(['phase-entry', 'edit', '--phase', '2'], dir);
  assert.deepEqual([empty.ok, empty.reason], [false, 'bad-args']);
  assert.equal(stateBytes(dir), state);
});

test('phase-entry add and edit refuse, writing nothing, when ROADMAP.md has no ## Phases heading', () => {
  const dir = threePhases();
  writeFileSync(join(dir, 'ROADMAP.md'), roadmapOf(dir).replace('## Phases\n', '## Plan\n'));
  const state = stateBytes(dir);
  const roadmap = roadmapOf(dir);
  for (const args of [['add', '--phase', '4', '--name', 'Four', '--description', 'd'], ['edit', '--phase', '2', '--name', 'Second']]) {
    const r = run(['phase-entry', ...args], dir);
    assert.deepEqual([r.ok, r.reason, typeof r.hint], [false, 'no-phases-heading', 'string'], args[0]);
    assert.equal(stateBytes(dir), state);
    assert.equal(roadmapOf(dir), roadmap);
  }
});

// --- the cycle marker the close and the cycle-opening add write -------------------------------
const markers = (dir) => (existsSync(tracePath(dir)) ? readFileSync(tracePath(dir), 'utf8') : '').split('\n')
  .filter(Boolean).filter((l) => JSON.parse(l).event === CYCLE).length;
const prune = (dir) => run(['milestone-prune', '--label', 'v1', '--mode', 'delete'], dir, undefined, NO_GLOBAL);

test('cycle marker: a close, a phase-less event, then the cycle-opening add leave exactly one', () => {
  const dir = allComplete('phase complete');
  const closed = prune(dir);
  assert.deepEqual([closed.ok, closed.action], [true, 'pruned']);
  assert.deepEqual((closed.warnings ?? []).filter((w) => /cycle boundary/.test(w)), []);
  assert.equal(markers(dir), 1);
  assert.equal(appendEvent(dir, { family: 'lifecycle', event: 'coordinator', step: 'suggest' }).written, true);
  const opened = add(dir, 1);
  assert.deepEqual([opened.ok, opened.opened_cycle, 'warnings' in opened], [true, true, false]);
  assert.equal(markers(dir), 1);
});

test('cycle marker: a cycle-opening add writes one onto a record with none, and a second when a phase event follows the last', () => {
  const bare = makeTree({ roadmap: [] });
  assert.equal(run(['status'], bare).ok, true);
  assert.equal(appendEvent(bare, { phase: 1, family: 'lifecycle', event: 'phase_start', sha: 'aaa1111' }).written, true);
  assert.equal(add(bare, 1).opened_cycle, true);
  assert.equal(markers(bare), 1);

  const followed = makeTree({ roadmap: [] });
  assert.equal(run(['status'], followed).ok, true);
  assert.equal(appendEvent(followed, { family: 'lifecycle', event: CYCLE }).written, true);
  assert.equal(appendEvent(followed, { phase: 1, family: 'lifecycle', event: 'phase_start', sha: 'aaa1111' }).written, true);
  assert.equal(add(followed, 1).opened_cycle, true);
  assert.equal(markers(followed), 2);
});

test('cycle marker: an add into an open cycle writes none, the every-phase-complete form included', () => {
  for (const [dir, n] of [[threePhases(), 4], [allComplete('phase complete'), 3]]) {
    assert.equal(appendEvent(dir, { phase: 1, family: 'lifecycle', event: 'phase_start', sha: 'aaa1111' }).written, true);
    const r = add(dir, n);
    assert.deepEqual([r.ok, 'opened_cycle' in r], [true, false]);
    assert.equal(markers(dir), 0);
  }
});

test('cycle marker: two cycles\' phase 1 through real adds and a close, and trace render --phase 1 counts the second alone', () => {
  const dir = makeTree({ roadmap: [] });
  assert.equal(run(['status'], dir).ok, true);
  const cycle = (sha, role) => {
    assert.equal(add(dir, 1).opened_cycle, true);
    for (const e of [{ event: 'phase_start', sha }, { event: 'dispatch', plan: '1', role }, { event: 'return', plan: '1', tokens: 10 }]) {
      assert.equal(appendEvent(dir, { phase: 1, family: 'lifecycle', ...e }).written, true);
    }
  };
  cycle('aaa1111', 'cad-executor');
  const held = readState(dir).state;
  assert.equal(writeState(dir, { ...held, phases: held.phases.map((p) => ({ ...p, status: 'complete' })) }).ok, true);
  assert.equal(prune(dir).action, 'pruned');
  cycle('bbb2222', 'cad-planner');
  assert.equal(markers(dir), 2, 'the first add and the close; the second add found the close already the boundary');
  const r = run(['trace', 'render', '--phase', '1'], dir, undefined, NO_GLOBAL);
  assert.equal(r.corr, '1-bbb2222');
  assert.deepEqual(r.counts, { routing: 0, provider: 0, lifecycle: 3, outcome: 0 });
  assert.deepEqual(r.roles, { 'cad-planner': { dispatches: 1, tokens: 10 } });
});

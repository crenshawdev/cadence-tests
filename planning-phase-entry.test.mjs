// Zero-dep tests for `planning.mjs phase-entry add|edit`. Run:
// node --test tests/planning-phase-entry.test.mjs
//
// The seam that writes a phase's number, name and one-line description into the
// state, where the `## Phases` line is rendered from. The shared harness lives
// in planning.test.mjs and is imported, never copied.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRoadmapPhases } from '../cadence-core/bin/lib/planning-files.mjs';
import { readState, statePath } from '../cadence-core/bin/lib/project-state.mjs';
import { renderStateMd } from '../cadence-core/bin/lib/state-views.mjs';
import { makeTree, run, isEntryFile } from './planning.test.mjs';
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

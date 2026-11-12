// Zero-dep tests for `planning.mjs req-row`. Run:
// node --test tests/planning-req-row.test.mjs
//
// The seam that re-points one requirement row at a phase, or defers a Pending
// one, in the state the `## Traceability` table is rendered from. The shared
// harness lives in planning.test.mjs and is imported, never copied.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readState, statePath } from '../cadence-core/bin/lib/project-state.mjs';
import { makeTree, run, isEntryFile } from './planning.test.mjs';
import { renumberTree } from './planning-renumber.test.mjs';

/** `node:test`'s `test` when run directly, a no-op when imported. */
const test = isEntryFile(import.meta.url) ? nodeTest : () => {};

const reqsOf = (dir) => readFileSync(join(dir, 'REQUIREMENTS.md'), 'utf8');
const stateBytes = (dir) => readFileSync(statePath(dir), 'utf8');
const rowOf = (dir, id) => readState(dir).state.requirements.find((r) => r.id === id);

/** Three phases, with a Pending, a Complete and a Deferred row; stamped, so "nothing written" has a state to measure. */
function reqTree() {
  const dir = makeTree({
    roadmap: [{ n: 1, name: 'One' }, { n: 2, name: 'Two' }, { n: 3, name: 'Three' }],
    phases: { 1: { plan: true }, 2: { plan: true }, 3: { plan: true } },
    reqs: [['REQ-1', 1, 'Pending'], ['REQ-2', 2, 'Complete'], ['REQ-3', 2, 'Deferred'], ['REQ-4', 1, 'Pending']],
  });
  assert.equal(run(['status'], dir).ok, true);
  return dir;
}

test('req-row --phase re-points a row in the state, Complete included, and the regenerated row agrees', () => {
  const dir = reqTree();
  const r = run(['req-row', '--id', 'REQ-1', '--phase', '3'], dir);
  assert.deepEqual([r.ok, r.id, r.phase, r.status], [true, 'REQ-1', 3, 'Pending']);
  assert.deepEqual(rowOf(dir, 'REQ-1'), { id: 'REQ-1', phase: 3, status: 'Pending' });
  assert.match(reqsOf(dir), /^\| REQ-1 \| Phase 3 \| Pending \|$/m);
  const done = run(['req-row', '--id', 'REQ-2', '--phase', '1'], dir);
  assert.deepEqual([done.ok, done.phase, done.status], [true, 1, 'Complete']);
  assert.match(reqsOf(dir), /^\| REQ-2 \| Phase 1 \| Complete \|$/m);
  assert.match(reqsOf(dir), /^\| REQ-4 \| Phase 1 \| Pending \|$/m, 'the other rows stay');
});

test('req-row --phase gives an orphan renumber remove blanked a phase, and audit stops reporting it no-phase', () => {
  const dir = renumberTree();
  assert.deepEqual(run(['renumber', 'remove', '--n', '2'], dir).orphaned_reqs, ['REQ-2']);
  const breakOf = () => run(['audit'], dir).requirements.find((q) => q.id === 'REQ-2').break;
  assert.equal(breakOf(), 'no-phase');
  assert.equal(run(['req-row', '--id', 'REQ-2', '--phase', '1'], dir).ok, true);
  assert.notEqual(breakOf(), 'no-phase');
  assert.deepEqual(rowOf(dir, 'REQ-2'), { id: 'REQ-2', phase: 1, status: 'Pending' });
  assert.match(reqsOf(dir), /^\| REQ-2 \| Phase 1 \| Pending \|$/m);
});

test('req-row --defer sets a Pending row Deferred, and phase-done then leaves it Deferred', () => {
  const dir = reqTree();
  const r = run(['req-row', '--id', 'REQ-1', '--defer'], dir);
  assert.deepEqual([r.ok, r.phase, r.status], [true, 1, 'Deferred']);
  assert.match(reqsOf(dir), /^\| REQ-1 \| Phase 1 \| Deferred \|$/m);
  const closed = run(['phase-done', '--n', '1'], dir);
  assert.equal(closed.ok, true);
  assert.deepEqual(closed.reqs, ['REQ-4']);
  assert.equal(rowOf(dir, 'REQ-1').status, 'Deferred');
  assert.equal(rowOf(dir, 'REQ-4').status, 'Complete');
});

test('req-row refuses, leaving the state and REQUIREMENTS.md byte-identical', () => {
  const dir = reqTree();
  const state = stateBytes(dir);
  const reqs = reqsOf(dir);
  const cases = [
    [['--id', 'REQ-9', '--phase', '1'], 'unknown-requirement'],
    [['--id', 'REQ-1', '--phase', '7'], 'unknown-phase'],
    [['--id', 'REQ-1', '--phase', 'two'], 'bad-args'],
    [['--id', 'REQ-1', '--phase', '1.10'], 'bad-args'],
    [['--id', 'REQ-1'], 'bad-args'],
    [['--id', 'REQ-1', '--phase', '2', '--defer'], 'bad-args'],
    [['--id', 'REQ-2', '--defer'], 'not-pending'],
    [['--id', 'REQ-3', '--defer'], 'not-pending'],
  ];
  for (const [args, reason] of cases) {
    const r = run(['req-row', ...args], dir);
    assert.deepEqual([r.ok, r.reason, typeof r.hint], [false, reason, 'string'], JSON.stringify(args));
    assert.equal(stateBytes(dir), state, `state untouched: ${JSON.stringify(args)}`);
    assert.equal(reqsOf(dir), reqs, `REQUIREMENTS.md untouched: ${JSON.stringify(args)}`);
  }
});

test('req-row refuses no-traceability-table, as seed-reqs does, when REQUIREMENTS.md has no table to render into', () => {
  const dir = reqTree();
  writeFileSync(join(dir, 'REQUIREMENTS.md'), '# Requirements: Fixture\n\n## Active\n\n- **REQ-1**: desc\n');
  const state = stateBytes(dir);
  const reqs = reqsOf(dir);
  for (const args of [['--phase', '3'], ['--defer']]) {
    const r = run(['req-row', '--id', 'REQ-1', ...args], dir);
    assert.deepEqual([r.ok, r.reason, typeof r.hint], [false, 'no-traceability-table', 'string'], args[0]);
    assert.equal(stateBytes(dir), state);
    assert.equal(reqsOf(dir), reqs);
  }
});

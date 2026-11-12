// Zero-dep tests for `planning.mjs seed-reqs`. Run:
// node --test 'tests/*.test.mjs'
//
// Split out of planning.test.mjs in phase 4, verbatim: the arms, their fixture
// builders and their comments are unchanged, only their home is. The shared
// harness stays in planning.test.mjs and is imported, never copied - two copies
// of `makeTree` is how two fixtures drift apart.
//
// The `test` binding below is a no-op unless this module IS the entry file, so
// a sibling that imports a fixture from here registers nothing twice.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { makeTree, run, isEntryFile, PLANNING } from './planning.test.mjs';
import { readState, statePath } from '../cadence-core/bin/lib/project-state.mjs';

/** `node:test`'s `test` when run directly, a no-op when imported (see header). */
const test = isEntryFile(import.meta.url) ? nodeTest : () => {};

// --- seed-reqs: /cad-plan's Traceability row-insert seam ------------------------

// A .planning tree for seed-reqs tests: REQUIREMENTS.md written raw with an
// `## Active` section (bullets) plus an empty `## Traceability` table -
// `active: null` omits the heading entirely (the no_active_section case),
// makeTree's `reqs` shape cannot express either.
function seedTree({ roadmap, phases, active }) {
  const dir = makeTree({ roadmap, phases });
  const activeSection = active === null ? ''
    : `## Active\n\n${active.map((id) => `- **${id}**: desc\n`).join('')}\n`;
  writeFileSync(join(dir, 'REQUIREMENTS.md'),
    `# Requirements: Fixture\n\n${activeSection}## Traceability\n\n` +
    '| Requirement | Phase | Status |\n|---|---|---|\n\nEmpty note.\n');
  return dir;
}

test('seed-reqs: a declared id with an ## Active bullet is seeded at Pending; a second run reports it skipped, file byte-identical', () => {
  const dir = seedTree({
    roadmap: [{ n: 1, name: 'One' }],
    phases: { 1: { plan: true, planReqs: ['X'] } },
    active: ['X'],
  });
  const r1 = run(['seed-reqs', '--phase', '1'], dir);
  assert.equal(r1.ok, true);
  assert.deepEqual(r1.seeded, ['X']);
  assert.deepEqual(r1.skipped, []);
  const after1 = readFileSync(join(dir, 'REQUIREMENTS.md'), 'utf8');
  assert.match(after1, /\| X \| Phase 1 \| Pending \|/);

  const r2 = run(['seed-reqs', '--phase', '1'], dir);
  assert.equal(r2.ok, true);
  assert.deepEqual(r2.seeded, []);
  assert.deepEqual(r2.skipped, ['X']);
  assert.equal(readFileSync(join(dir, 'REQUIREMENTS.md'), 'utf8'), after1);
});

test('seed-reqs: an id with no ## Active bullet is reported under orphan_ids, no row written, and audit still lists it under orphans.plan_ids', () => {
  const dir = seedTree({
    roadmap: [{ n: 1, name: 'One' }],
    phases: { 1: { plan: true, planReqs: ['Y'] } },
    active: [],
  });
  const r = run(['seed-reqs', '--phase', '1'], dir);
  assert.equal(r.ok, true);
  assert.deepEqual(r.seeded, []);
  assert.deepEqual(r.orphan_ids, ['Y']);
  const after = readFileSync(join(dir, 'REQUIREMENTS.md'), 'utf8');
  assert.equal(after.includes('| Y |'), false);
  const audit = run(['audit'], dir);
  assert.deepEqual(audit.orphans.plan_ids, [{ file: 'phases/1/PLAN.md', ids: ['Y'] }]);
});

test('seed-reqs: a missing ## Active heading returns no_active_section: true', () => {
  const dir = seedTree({
    roadmap: [{ n: 1, name: 'One' }],
    phases: { 1: { plan: true, planReqs: ['Z'] } },
    active: null,
  });
  const r = run(['seed-reqs', '--phase', '1'], dir);
  assert.equal(r.ok, true);
  assert.equal(r.no_active_section, true);
  assert.deepEqual(r.orphan_ids, ['Z']);
});

test('seed-reqs: --phase absent/non-numeric/negative all return bad-args, nothing written', () => {
  const dir = seedTree({
    roadmap: [{ n: 1, name: 'One' }],
    phases: { 1: { plan: true, planReqs: ['X'] } },
    active: ['X'],
  });
  const before = readFileSync(join(dir, 'REQUIREMENTS.md'), 'utf8');
  for (const args of [['seed-reqs'], ['seed-reqs', '--phase', 'abc'], ['seed-reqs', '--phase', '-1']]) {
    assert.equal(run(args, dir).reason, 'bad-args');
  }
  assert.equal(readFileSync(join(dir, 'REQUIREMENTS.md'), 'utf8'), before);
});

test('seed-reqs: a --phase spelling that cannot round-trip is refused before any read (D-07)', () => {
  // The fixture holds BOTH sub-phases, which is what makes the old answer
  // wrong rather than merely odd: `--phase 1.10` used to seed `| B | Phase 1.1
  // | Pending |` - the OTHER phase's row - with ok:true.
  const dir = seedTree({
    roadmap: [{ n: 1, name: 'One' }],
    phases: {
      '1.1': { plan: true, planReqs: ['A'] },
      '1.10': { plan: true, planReqs: ['B'] },
      2: { plan: true, planReqs: ['C'] },
      '2.1': { plan: true, planReqs: ['D'] },
    },
    active: ['A', 'B', 'C', 'D'],
  });
  const before = readFileSync(join(dir, 'REQUIREMENTS.md'), 'utf8');
  for (const bad of ['1.10', '1.0', '01']) {
    const r = run(['seed-reqs', '--phase', bad], dir);
    assert.equal(r.ok, false, bad);
    assert.equal(r.reason, 'bad-args', bad);
    assert.equal(r._exit, 1, bad);
    // Both spellings: the caller's fix is retype the flag OR rename the dir.
    assert.ok(r.detail.includes(`"${bad}"`), `${bad}: detail quotes what was sent`);
    assert.ok(r.detail.includes(`"${String(Number(bad))}"`), `${bad}: detail quotes what is accepted`);
  }
  assert.equal(readFileSync(join(dir, 'REQUIREMENTS.md'), 'utf8'), before, 'nothing written');

  // The spellings that DO round-trip are untouched, sub-phases included.
  for (const [good, id] of [['1.1', 'A'], ['2', 'C'], ['2.1', 'D']]) {
    const r = run(['seed-reqs', '--phase', good], dir);
    assert.equal(r.ok, true, good);
    assert.deepEqual(r.seeded, [id], good);
  }
});

test('seed-reqs: a malformed requirements: line surfaces frontmatter_issues', () => {
  const dir = seedTree({
    roadmap: [{ n: 1, name: 'One' }],
    phases: { 1: { plan: true } },
    active: ['X'],
  });
  writeFileSync(join(dir, 'phases', '1', 'PLAN.md'),
    '---\nphase: 1\nrequirements:["X"]\nfiles: []\n---\n# Plan 1\n');
  const r = run(['seed-reqs', '--phase', '1'], dir);
  assert.equal(r.ok, true);
  assert.deepEqual(r.frontmatter_issues, [{
    file: 'phases/1/PLAN.md',
    issues: [{ line: 3, code: 'malformed-key-line', text: 'requirements:["X"]' }],
  }]);
});

test('seed-reqs: absent REQUIREMENTS.md / absent phase dir / no conforming plan file degrade with named reasons', () => {
  const noReqs = makeTree({ roadmap: [{ n: 1, name: 'One' }], phases: { 1: { plan: true } } });
  assert.equal(run(['seed-reqs', '--phase', '1'], noReqs).reason, 'no-requirements');

  const noPhaseDir = seedTree({ roadmap: [{ n: 1, name: 'One' }], active: ['X'] });
  assert.equal(run(['seed-reqs', '--phase', '1'], noPhaseDir).reason, 'no-phase-dir');

  const noPlans = seedTree({ roadmap: [{ n: 1, name: 'One' }], active: ['X'] });
  mkdirSync(join(noPlans, 'phases', '1'), { recursive: true });
  const rNoPlans = run(['seed-reqs', '--phase', '1'], noPlans);
  assert.equal(rNoPlans.reason, 'no-plans');
  assert.equal(rNoPlans.hint, '/cad-plan 1');
});

test('seed-reqs: a seeded row survives renumber insert, reading Phase 2', () => {
  const dir = seedTree({
    roadmap: [{ n: 1, name: 'One' }],
    phases: { 1: { plan: true, planReqs: ['X'] } },
    active: ['X'],
  });
  assert.equal(run(['seed-reqs', '--phase', '1'], dir).ok, true);
  assert.equal(run(['renumber', 'insert', '--at', '1'], dir).ok, true);
  const after = readFileSync(join(dir, 'REQUIREMENTS.md'), 'utf8');
  assert.match(after, /\| X \| Phase 2 \| Pending \|/);
});

// --- the table is output the state renders ------------------------------------------------------------

test('seed-reqs: the rows land in the state, the table agrees, a hand edit changes nothing reported and the next write undoes it', () => {
  const dir = seedTree({
    roadmap: [{ n: 1, name: 'One' }],
    phases: { 1: { plan: true, planReqs: ['X', 'Y'] } },
    active: ['X', 'Y'],
  });
  assert.deepEqual(run(['seed-reqs', '--phase', '1'], dir).seeded, ['X', 'Y']);
  assert.deepEqual(readState(dir).state.requirements, [
    { id: 'X', phase: 1, status: 'Pending' }, { id: 'Y', phase: 1, status: 'Pending' }]);
  const file = join(dir, 'REQUIREMENTS.md');
  const generated = readFileSync(file, 'utf8');
  assert.match(generated, /\n\nEmpty note\.\n$/, 'the prose under the table survives regeneration');

  const statusBefore = run(['status'], dir);
  const auditBefore = run(['audit'], dir);
  writeFileSync(file, generated.replace('| X | Phase 1 | Pending |', '| X | Phase 1 | Complete |')
    .replace('| Y | Phase 1 | Pending |\n', ''));
  assert.deepEqual(run(['status'], dir), statusBefore);
  assert.deepEqual(run(['audit'], dir), auditBefore);

  const again = run(['seed-reqs', '--phase', '1'], dir);
  assert.deepEqual([again.seeded, again.skipped], [[], ['X', 'Y']]);
  assert.equal(readFileSync(file, 'utf8'), generated, 'the next state-writing seam puts the generated rows back');
});

test('seed-reqs: a missing traceability table is still refused and nothing is written', () => {
  const dir = seedTree({ roadmap: [{ n: 1, name: 'One' }], phases: { 1: { plan: true, planReqs: ['X'] } }, active: ['X'] });
  assert.equal(run(['status'], dir).ok, true);
  writeFileSync(join(dir, 'REQUIREMENTS.md'), '# Requirements\n\n## Active\n\n- **X**: desc\n');
  const before = readState(dir).state;
  const r = run(['seed-reqs', '--phase', '1'], dir);
  assert.equal(r.reason, 'no-traceability-table');
  assert.deepEqual(readState(dir).state, before);
});

test('seed-reqs: an id another seed adds while this one waits on the lock is skipped, not stored twice', async () => {
  const dir = seedTree({ roadmap: [{ n: 1, name: 'One' }], phases: { 1: { plan: true, planReqs: ['X'] } }, active: ['X'] });
  assert.equal(run(['status'], dir).ok, true);
  const lock = `${statePath(dir)}.lock`;
  writeFileSync(lock, ''); // the other seed holds the state file
  const child = spawn('node', [PLANNING, 'seed-reqs', '--phase', '1', '--dir', dir], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  await new Promise((r) => setTimeout(r, 600)); // it has read the state and is polling for the lock
  // written around the lock, the way the other seed's commit would land
  const raw = JSON.parse(readFileSync(statePath(dir), 'utf8'));
  writeFileSync(statePath(dir), `${JSON.stringify({ ...raw, requirements: [{ id: 'X', phase: 1, status: 'Pending' }] }, null, 2)}\n`);
  rmSync(lock);
  await new Promise((r) => child.on('close', r));
  const res = JSON.parse(out);
  assert.equal(res.ok, true);
  assert.deepEqual([res.seeded, res.skipped], [[], ['X']]);
  assert.deepEqual(readState(dir).state.requirements, [{ id: 'X', phase: 1, status: 'Pending' }]);
});

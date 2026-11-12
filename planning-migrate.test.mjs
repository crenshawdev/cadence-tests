// Zero-dep tests for the state-file step every seam runs first (planning/migrate.mjs). Run:
// node --test tests/planning-migrate.test.mjs
// Driven through `node cadence-core/bin/planning.mjs status --dir <fixture>`, the way a user's seam call meets it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTree, run } from './planning.test.mjs';
import { importState } from '../cadence-core/bin/planning/state-import.mjs';
import { readState, statePath, STAMP_KEY, STATE_LAYOUT } from '../cadence-core/bin/lib/project-state.mjs';

/** Every file outside records/, as path -> bytes, for the byte-identical checks. */
function snapshot(dir, rel = '') {
  const out = {};
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const p = join(rel, e.name);
    if (e.isDirectory()) { if (p !== 'records') Object.assign(out, snapshot(dir, p)); }
    else out[p] = readFileSync(join(dir, p), 'utf8');
  }
  return out;
}

const v40 = () => makeTree({
  roadmap: [{ n: 1, name: 'Base', checked: true, desc: 'lay it' }, { n: 2, name: 'Auth', desc: 'sign in' }],
  phases: { 1: { plan: true, summary: true, uat: [{ status: 'pass' }] }, 2: { plan: ['PLAN-1.md', 'PLAN-2.md'] } },
  reqs: [['REQ-1', 1, 'Complete'], ['REQ-2', 2, 'Pending']],
  cursor: { phase: 2, total: 2, name: 'Auth', status: 'planned', next: '/cad-execute 2', updated: '2026-02-03' },
});

test('a first seam call on a v4.0 project leaves a valid stamped state equal to the importer\'s, and the Markdown untouched', () => {
  const dir = v40();
  const before = snapshot(dir);
  const want = importState(dir).state;
  const r = run(['status'], dir);
  assert.equal(r.ok, true);
  const got = readState(dir);
  assert.equal(got.kind, 'valid');
  assert.deepEqual(got.state, want);
  assert.equal(JSON.parse(readFileSync(statePath(dir), 'utf8'))[STAMP_KEY], STATE_LAYOUT);
  assert.deepEqual(snapshot(dir), before);
  // the records folder holds exactly the state file and its ignore file
  assert.deepEqual(readdirSync(join(dir, 'records')).sort(), ['.gitignore', 'state.json']);
});

test('a second call rewrites nothing: same bytes, same mtime', () => {
  const dir = v40();
  run(['status'], dir);
  const bytes = readFileSync(statePath(dir), 'utf8');
  const mtime = statSync(statePath(dir)).mtimeMs;
  const again = run(['status'], dir);
  assert.equal(again.ok, true);
  assert.equal(readFileSync(statePath(dir), 'utf8'), bytes);
  assert.equal(statSync(statePath(dir)).mtimeMs, mtime);
});

test('an out-of-grammar roadmap is refused with unparseable-roadmap, no handler runs, and no state file is left', () => {
  const dir = makeTree({});
  writeFileSync(join(dir, 'ROADMAP.md'), '# Roadmap\n\n## Phases\n\n- Phase 1: Ship auth\n');
  const before = snapshot(dir);
  // a seam that would otherwise have answered ok:true on its own
  const r = run(['cursor', 'get'], dir);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unparseable-roadmap');
  assert.equal(r.issues[0].code, 'phase-bullet');
  assert.ok(r.hint);
  assert.equal(existsSync(statePath(dir)), false);
  assert.deepEqual(snapshot(dir), before);
});

test('a roadmap with no phases section is refused the same way', () => {
  const dir = makeTree({});
  writeFileSync(join(dir, 'ROADMAP.md'), '# Roadmap\n\nno list\n');
  const r = run(['cursor', 'get'], dir);
  assert.deepEqual([r.ok, r.reason], [false, 'unparseable-roadmap']);
  assert.equal(existsSync(statePath(dir)), false);
});

test('a state file that does not parse is refused naming the file and the reason, and stays byte-identical', () => {
  const dir = v40();
  mkdirSync(join(dir, 'records'));
  writeFileSync(statePath(dir), '{torn');
  const before = snapshot(dir);
  const r = run(['status'], dir);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid-state');
  assert.ok(r.detail.includes(statePath(dir)));
  assert.match(r.detail, /not-json/);
  assert.match(r.hint, /\/cad-progress/);
  assert.equal(readFileSync(statePath(dir), 'utf8'), '{torn');
  assert.deepEqual(snapshot(dir), before);
});

test('a state file of a newer layout is refused with its own hint and left alone', () => {
  const dir = v40();
  mkdirSync(join(dir, 'records'));
  const newer = JSON.stringify({ [STAMP_KEY]: STATE_LAYOUT + 1 });
  writeFileSync(statePath(dir), newer);
  const r = run(['status'], dir);
  assert.equal(r.reason, 'invalid-state');
  assert.match(r.detail, /newer-layout/);
  assert.match(r.hint, /update the plugin/);
  assert.equal(readFileSync(statePath(dir), 'utf8'), newer);
});

test('a Rust-era .planning/state.json is never read as a stamp and is byte-identical afterward', () => {
  const dir = v40();
  const rust = '{"version":1,"generation":3,"phase":{"layout":99}}';
  writeFileSync(join(dir, 'state.json'), rust);
  const r = run(['status'], dir);
  assert.equal(r.ok, true);
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), rust);
  assert.equal(readState(dir).kind, 'valid');
});

test('an empty planning directory is stamped with no cycle open, and the handler still answers for itself', () => {
  const dir = makeTree({});
  const r = run(['status'], dir);
  assert.deepEqual([r.ok, r.reason], [false, 'no-roadmap']);
  assert.deepEqual(readState(dir), { kind: 'valid', state: { cycleOpen: false, cursor: null, phases: [], requirements: [] } });
});

test('a missing roadmap beside phase folders is refused and leaves no state file', () => {
  const dir = makeTree({ phases: { 1: { plan: true } }, roadmap: false });
  const before = snapshot(dir);
  const r = run(['cursor', 'get'], dir);
  assert.deepEqual([r.ok, r.reason], [false, 'no-roadmap']);
  assert.ok(r.hint);
  assert.equal(existsSync(statePath(dir)), false);
  assert.deepEqual(snapshot(dir), before);
});

test('no planning directory and an unknown subcommand create nothing', () => {
  const gone = join(tmpdir(), 'cad-migrate-does-not-exist');
  assert.equal(run(['status'], gone).reason, 'no-planning-dir');
  assert.equal(existsSync(gone), false);
  const dir = v40();
  assert.equal(run(['no-such-subcommand'], dir).reason, 'usage');
  assert.equal(existsSync(join(dir, 'records')), false);
});

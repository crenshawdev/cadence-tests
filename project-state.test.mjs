// Zero-dep tests for lib/project-state.mjs - the one reader and writer of .planning/records/state.json.
// Run: node --test tests/project-state.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CURSOR_WORDS, STAMP_KEY, STATE_LAYOUT, readState, statePath, updateState, writeState,
} from '../cadence-core/bin/lib/project-state.mjs';
import { CURSOR_STATUSES } from '../cadence-core/bin/lib/planning-files.mjs';

const LIB = join(dirname(fileURLToPath(import.meta.url)), '..', 'cadence-core', 'bin', 'lib', 'project-state.mjs');
const TEXT_UTIL = join(dirname(LIB), 'text-util.mjs');
const tmp = () => mkdtempSync(join(tmpdir(), 'cad-pstate-'));

const NEXT = `${'a long next step, word for word. '.repeat(20)}end`;
const sample = () => ({
  cycleOpen: true,
  cursor: { phase: 2.1, status: 'paused', next: NEXT, updated: '2026-11-12', plan: { k: 2, j: 3, name: 'The thing' } },
  phases: [
    { n: 1, name: 'First', description: 'does one', status: 'complete', plans: [{ file: 'PLAN.md', finished: true }] },
    { n: 2.1, name: 'Inserted', description: '', status: 'planned',
      plans: [{ file: 'PLAN-1.md', finished: true }, { file: 'PLAN-2.md', finished: false }] },
  ],
  requirements: [{ id: 'REQ-1', phase: 1, status: 'Complete' }, { id: 'REQ-2', phase: null, status: 'Deferred' }],
});

test('the lifecycle words are the ones planning-files names', () => {
  assert.deepEqual([...CURSOR_WORDS], CURSOR_STATUSES);
});

test('an unwritten project reads as absent, with or without a records folder', () => {
  const root = tmp();
  assert.deepEqual(readState(root), { kind: 'absent' });
  mkdirSync(join(root, 'records'));
  assert.deepEqual(readState(root), { kind: 'absent' });
});

test('a written state reads back with every field, under a stamp that is neither version nor generation', () => {
  const root = tmp();
  assert.deepEqual(writeState(root, sample()), { ok: true, changed: true });
  const got = readState(root);
  assert.equal(got.kind, 'valid');
  assert.deepEqual(got.state, sample());
  const onDisk = JSON.parse(readFileSync(statePath(root), 'utf8'));
  assert.equal(onDisk[STAMP_KEY], STATE_LAYOUT);
  assert.ok(!['version', 'generation'].includes(STAMP_KEY));
  assert.ok(!('version' in onDisk) && !('generation' in onDisk));
});

test('a cycle with no cursor and no phases round-trips, and says no cycle is open', () => {
  const root = tmp();
  const empty = { cycleOpen: false, cursor: null, phases: [], requirements: [] };
  assert.equal(writeState(root, empty).ok, true);
  assert.deepEqual(readState(root), { kind: 'valid', state: empty });
});

test('an unchanged state rewrites to the same bytes and touches nothing; key order does not matter to the caller', () => {
  const root = tmp();
  writeState(root, sample());
  const before = readFileSync(statePath(root), 'utf8');
  const mtime = statSync(statePath(root)).mtimeMs;
  assert.ok(before.endsWith('}\n'));
  // the same facts in another key order
  const s = sample();
  const shuffled = { requirements: s.requirements, phases: s.phases, cursor: s.cursor, cycleOpen: s.cycleOpen };
  assert.deepEqual(writeState(root, shuffled), { ok: true, changed: false });
  assert.equal(readFileSync(statePath(root), 'utf8'), before);
  assert.equal(statSync(statePath(root)).mtimeMs, mtime);
});

test('the four invalid-file reasons are each answered as a value', () => {
  const root = tmp();
  mkdirSync(join(root, 'records'));
  const put = (text) => writeFileSync(statePath(root), text);
  const reason = () => { const r = readState(root); assert.equal(r.kind, 'invalid'); return r.reason; };

  put('{not json');
  assert.equal(reason(), 'not-json');
  // the Rust-era shape
  put('{"version":1,"generation":7}');
  assert.equal(reason(), 'no-stamp');
  put('[1]');
  assert.equal(reason(), 'no-stamp');
  put(JSON.stringify({ [STAMP_KEY]: STATE_LAYOUT + 1, cycleOpen: true }));
  assert.equal(reason(), 'newer-layout');
  put(JSON.stringify({ ...sample(), [STAMP_KEY]: STATE_LAYOUT, phases: 'none' }));
  assert.equal(reason(), 'bad-shape');
  put(JSON.stringify({ ...sample(), [STAMP_KEY]: 'one' }));
  assert.equal(reason(), 'bad-shape');
  const wrongCursor = sample();
  wrongCursor.cursor.status = 'thinking';
  put(JSON.stringify({ [STAMP_KEY]: STATE_LAYOUT, ...wrongCursor }));
  const r = readState(root);
  assert.match(r.detail, /cursor\.status/);
});

test('an unreadable file is a value, not a throw', { skip: process.getuid?.() === 0 }, () => {
  const root = tmp();
  mkdirSync(join(root, 'records'));
  writeFileSync(statePath(root), '{}');
  chmodSync(statePath(root), 0o000);
  assert.equal(readState(root).reason, 'unreadable');
});

test('a bad-shaped state is refused on write and nothing is created', () => {
  const root = tmp();
  const r = writeState(root, { ...sample(), cycleOpen: 'yes' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad-shape');
  assert.ok(!existsSync(join(root, 'records')));
});

test('a state file of a newer layout is refused and left byte-identical', () => {
  const root = tmp();
  mkdirSync(join(root, 'records'));
  const newer = JSON.stringify({ [STAMP_KEY]: STATE_LAYOUT + 1, future: true });
  writeFileSync(statePath(root), newer);
  const r = writeState(root, sample());
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'newer-layout');
  assert.equal(readFileSync(statePath(root), 'utf8'), newer);
  assert.equal(updateState(root, (s) => s).reason, 'state-invalid');
  assert.equal(readFileSync(statePath(root), 'utf8'), newer);
});

test('a damaged file is replaced by a write, which is how it is rebuilt', () => {
  const root = tmp();
  mkdirSync(join(root, 'records'));
  writeFileSync(statePath(root), '{torn');
  assert.deepEqual(writeState(root, sample()), { ok: true, changed: true });
  assert.equal(readState(root).kind, 'valid');
});

test('the lock excludes a second writer: a held lock is a refusal with its own reason, and the file is untouched', () => {
  const root = tmp();
  writeState(root, sample());
  const before = readFileSync(statePath(root), 'utf8');
  writeFileSync(`${statePath(root)}.lock`, '');
  const other = sample();
  other.cycleOpen = false;
  const r = writeState(root, other);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'state-locked');
  assert.equal(readFileSync(statePath(root), 'utf8'), before);
});

test('update on a project with no state is a refusal and creates nothing', () => {
  const root = tmp();
  const r = updateState(root, (s) => s);
  assert.equal(r.reason, 'state-absent');
  assert.ok(!existsSync(join(root, 'records')));
});

test('two interleaved updates of different facts both land', async () => {
  const root = tmp();
  writeState(root, sample());
  // each child holds its read for 150ms before writing: without the lock held across read and write, one erases the other
  const child = (code) => new Promise((resolve) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', code, LIB, root], { stdio: 'inherit' });
    c.on('close', resolve);
  });
  const body = (change) => `
    import { updateState } from ${JSON.stringify(LIB)};
    import { sleep } from ${JSON.stringify(TEXT_UTIL)};
    const root = ${JSON.stringify(root)};
    const r = updateState(root, (s) => { sleep(150); ${change}; return s; });
    process.exit(r.ok ? 0 : 3);
  `;
  const codes = await Promise.all([
    child(body("s.phases[0].status = 'executed'")),
    child(body("s.requirements[0].status = 'Pending'")),
  ]);
  assert.deepEqual(codes, [0, 0]);
  const got = readState(root).state;
  assert.equal(got.phases[0].status, 'executed');
  assert.equal(got.requirements[0].status, 'Pending');
});

test('a file at .planning/state.json is never opened or changed', () => {
  const root = tmp();
  const rust = '{"version":1,"generation":4,"state":"leftover"}';
  writeFileSync(join(root, 'state.json'), rust);
  assert.deepEqual(readState(root), { kind: 'absent' });
  writeState(root, sample());
  updateState(root, (s) => s);
  assert.equal(readFileSync(join(root, 'state.json'), 'utf8'), rust);
  assert.equal(statePath(root), join(root, 'records', 'state.json'));
});

test('the lib imports node: builtins and the write module and nothing else', () => {
  const src = readFileSync(LIB, 'utf8');
  const specs = [...src.matchAll(/^import[^;]*?from '([^']+)';/gms)].map((m) => m[1]);
  assert.ok(specs.length >= 2);
  for (const s of specs) assert.ok(s.startsWith('node:') || s === './planning-store.mjs', `unexpected import ${s}`);
});

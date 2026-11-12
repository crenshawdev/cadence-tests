// Zero-dep tests for the state-file step every seam runs first (planning/migrate.mjs). Run:
// node --test tests/planning-migrate.test.mjs
// Driven through `node cadence-core/bin/planning.mjs status --dir <fixture>`, the way a user's seam call meets it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PLANNING, makeTree, run, stampState } from './planning.test.mjs';
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

/** `trace ignore` the way the workflows call it: from the project root, no --dir. */
function traceIgnoreFromRoot(root, extra = []) {
  const bin = join(import.meta.dirname, '..', 'cadence-core', 'bin', 'planning.mjs');
  try {
    return JSON.parse(execFileSync('node', [bin, 'trace', 'ignore', '--root', '.', ...extra], { cwd: root, encoding: 'utf8' }));
  } catch (e) { return JSON.parse(e.stdout); }
}

test('trace ignore answers what the project had before the stamp, then stamps it; --check writes nothing', () => {
  for (const extra of [[], ['--check']]) {
    const root = mkdtempSync(join(tmpdir(), 'cad-migrate-ignore-'));
    mkdirSync(join(root, '.planning'));
    const r = traceIgnoreFromRoot(root, extra);
    assert.equal(r.ok, true);
    assert.equal(r.ignored, false);
    assert.equal(r.written, extra.length === 0);
    assert.notEqual(r.reason, 'already-ignored');
    if (extra.length === 0) assert.equal(readState(join(root, '.planning')).kind, 'valid');
    else assert.deepEqual(readdirSync(join(root, '.planning')), []);
  }
});

test('trace ignore on a symlinked records folder keeps its own refusal, not state-write-failed', () => {
  const root = mkdtempSync(join(tmpdir(), 'cad-migrate-ignore-'));
  mkdirSync(join(root, '.planning'));
  symlinkSync(mkdtempSync(join(tmpdir(), 'cad-migrate-elsewhere-')), join(root, '.planning', 'records'));
  const r = traceIgnoreFromRoot(root);
  assert.deepEqual([r.ok, r.reason], [false, 'symlinked-records']);
});

// --- the conversion into the layout (Plan 8) ---------------------------------

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** Every path under `dir` (folders included) as path -> sha of the bytes, for the byte-identical checks. */
function deep(dir, rel = '', out = {}) {
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const p = join(rel, e.name);
    if (e.isDirectory()) { out[p] = 'dir'; deep(dir, p, out); }
    else out[p] = createHash('sha256').update(readFileSync(join(dir, p))).digest('hex');
  }
  return out;
}

/** planning.mjs from `cwd`, with --dir only when given: the way a session in a worktree calls it. */
function runIn(cwd, args, dir) {
  let stdout;
  try {
    stdout = execFileSync('node', [PLANNING, ...args, ...(dir ? ['--dir', dir] : [])], { cwd, encoding: 'utf8' });
  } catch (e) { stdout = e.stdout; }
  return JSON.parse(stdout);
}

/** Make the project's root a git repository that tracks everything in it. Returns the root. */
function track(dir, extra = {}) {
  const root = dirname(dir);
  for (const [name, text] of Object.entries(extra)) writeFileSync(join(root, name), text);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 't@example.com');
  git(root, 'config', 'user.name', 'T');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'add', '-A', '.');
  git(root, 'commit', '-q', '-m', 'init');
  return root;
}

const put = (dir, rel, text = `bytes of ${rel}\n`) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
};

// a refused conversion changes nothing, so the whole tree is compared, records/ included
test('a held workflow claim and a live plan worktree each refuse the conversion, and releasing them lets it through', () => {
  const dir = v40();
  const root = track(dir);
  const other = join(root, 'other', '.planning');
  mkdirSync(other, { recursive: true });
  stampState(other);
  const taken = runIn(root, ['workflow-claim', 'take', '--fire', 'review-1'], other);
  assert.equal(taken.launch, true);
  const before = deep(dir);
  const held = runIn(root, ['status'], dir);
  assert.deepEqual([held.ok, held.reason], [false, 'workflow-claim-held']);
  assert.match(held.detail, /review-1/);
  assert.ok(held.hint);
  assert.equal(existsSync(statePath(dir)), false);
  assert.deepEqual(deep(dir), before);
  runIn(root, ['workflow-claim', 'release', '--fire', 'review-1', '--id', taken.id], other);

  const wt = join(root, '..', `${root.split('/').pop()}-wt`);
  git(root, 'worktree', 'add', '-q', '-b', 'cadence/phase-1-plan-2', wt);
  const live = runIn(root, ['status'], dir);
  assert.deepEqual([live.ok, live.reason], [false, 'plan-worktree-live']);
  assert.match(live.detail, /cadence\/phase-1-plan-2/);
  assert.ok(live.detail.includes(wt));
  assert.equal(existsSync(statePath(dir)), false);
  assert.deepEqual(deep(dir), before);
  git(root, 'worktree', 'remove', '--force', wt);
  assert.equal(runIn(root, ['status'], dir).ok, true);
  assert.equal(readState(dir).kind, 'valid');
});


// Zero-dep tests for the state-file step every seam runs first (planning/migrate.mjs). Run:
// node --test tests/planning-migrate.test.mjs
// Driven through `node cadence-core/bin/planning.mjs status --dir <fixture>`, the way a user's seam call meets it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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
  assert.match(r.hint, /`planning\.mjs state-rebuild`/);
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
    else if (e.isSymbolicLink()) out[p] = `link ${readlinkSync(join(dir, p))}`;
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
  assert.ok(held.detail.includes(taken.id));
  assert.equal(existsSync(statePath(dir)), false);
  assert.deepEqual(deep(dir), before);
  // the hint's own command, run against the refused project itself, frees the claim and still converts nothing
  const hinted = held.hint.match(/`planning\.mjs (workflow-claim release [^`]+)`/);
  assert.deepEqual(hinted[1].split(' '), ['workflow-claim', 'release', '--fire', 'review-1', '--id', taken.id]);
  assert.equal(runIn(root, hinted[1].split(' '), dir).released, true);
  assert.equal(existsSync(statePath(dir)), false);
  assert.deepEqual(deep(dir), before);

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

test('a held claim with no id is refused with a --stale release that works on the unstamped project', () => {
  const dir = v40();
  const root = track(dir);
  const claimFile = join(root, '.git', 'cadence-workflow-claim');
  writeFileSync(claimFile, 'not json');
  const held = runIn(root, ['status'], dir);
  assert.equal(held.reason, 'workflow-claim-held');
  const hinted = held.hint.match(/`planning\.mjs (workflow-claim release [^`]+)`/);
  assert.deepEqual(hinted[1].split(' ').slice(-1), ['--stale']);
  assert.equal(runIn(root, hinted[1].split(' '), dir).released, true);
  assert.equal(existsSync(claimFile), false);
  assert.equal(runIn(root, ['status'], dir).ok, true);
});

/** A v4.0 project built file by file: what scripts keep sits at the old places, plus things Cadence does not own. */
function layoutFixture() {
  const dir = makeTree({
    roadmap: [{ n: 1, name: 'Base', checked: true }, { n: 2, name: 'Auth' }],
    phases: { 1: { plan: true, summary: true, uat: [{ status: 'pass' }] }, 2: { plan: ['PLAN-1.md', 'PLAN-2.md'] } },
    reqs: [['REQ-1', 1, 'Complete'], ['REQ-2', 2, 'Pending']],
    cursor: { phase: 2, total: 2, name: 'Auth', status: 'planned', next: '/cad-execute 2', updated: '2026-02-03' },
    capture: [{ section: 'Notes', text: 'a note' }],
    config: { planning: { commit_docs: true } },
  });
  const moved = [
    'trace.jsonl', 'trace.1.jsonl', 'trace.1.jsonl.claim', 'reads.jsonl', 'reads.1.jsonl', 'reads.jsonl.rotate.42.ab',
    'ARCHIVE.md', 'FILED.md', 'DECLINED.md', 'deferred/DEFERRED-diff-plan-1.json', 'risk-carry/ruling.json', 'codemap/map.json',
  ];
  for (const f of moved) put(dir, f);
  const inPhase = ['reports/plan-1.md', 'reports/plan-1.1.md', 'REVIEW-diff-plan-1.md', 'REVIEW-diff-plan-1.json',
    'ADJUDICATION-diff-plan-1.json', 'DEFERRED-diff-plan-1.json', 'FINDINGS.json', 'verifier-findings.json'];
  for (const f of inPhase) {
    put(dir, `phases/1/${f}`);
    put(dir, `_archive-v1.0/1/${f}`);
  }
  put(dir, 'phases/2/reports/plan-1.md', 'PLAN COMPLETE\nPlan: PLAN-1.md\n');
  put(dir, '_archive-v1.0/1/PLAN.md', '# old plan\n');
  const kept = ['tasks/slug/PLAN.md', 'tasks/slug/REVIEW-diff-slug.md', 'spikes/s.md', 'debug/d.md', 'research/r.md', 'PROJECT.md',
    'state.json', 'drafts/draft.md', 'phases/1/notes.txt'];
  for (const f of kept) put(dir, f);
  return { dir, moved, inPhase, kept };
}

test('a first seam call moves the records into the layout, byte for byte, and leaves what Cadence does not own in place', () => {
  const { dir, moved, inPhase, kept } = layoutFixture();
  const root = track(dir);
  const was = deep(dir);
  const commits = git(root, 'rev-list', '--count', 'HEAD');
  const r = runIn(root, ['status'], dir);
  assert.equal(r.ok, true);
  assert.deepEqual(r.phases.map((p) => [p.n, p.status]), [[1, 'complete'], [2, 'planned']]);
  assert.equal(git(root, 'rev-list', '--count', 'HEAD'), commits);

  // the top of .planning: AC3's entries, the archive folder and what Cadence does not own
  assert.deepEqual(readdirSync(dir).sort(), ['CAPTURE.md', 'PROJECT.md', 'REQUIREMENTS.md', 'ROADMAP.md', 'STATE.md', '_archive-v1.0',
    'config.json', 'debug', 'drafts', 'phases', 'records', 'research', 'spikes', 'state.json', 'tasks'].sort());
  assert.deepEqual(readdirSync(join(dir, 'phases', '1')).sort(), ['PLAN.md', 'SUMMARY.md', 'UAT.md', 'notes.txt', 'records']);
  assert.deepEqual(readdirSync(join(dir, '_archive-v1.0', '1')).sort(), ['PLAN.md', 'records']);
  assert.deepEqual(readdirSync(join(dir, 'phases', '1', 'records')).sort(), [...inPhase.map((f) => f.split('/')[0])].filter((n, i, a) => a.indexOf(n) === i).sort());
  // every moved file is the same bytes at its new place
  const at = (f) => (f.includes('/') && !f.startsWith('deferred/') && !f.startsWith('risk-carry/') && !f.startsWith('codemap/') ? f : `records/${f}`);
  for (const f of moved) assert.equal(deep(dir)[at(f)], was[f], f);
  for (const base of ['phases/1', '_archive-v1.0/1']) {
    for (const f of inPhase) assert.equal(deep(dir)[`${base}/records/${f}`], was[`${base}/${f}`], `${base}/${f}`);
  }
  assert.equal(deep(dir)['phases/2/records/reports/plan-1.md'], was['phases/2/reports/plan-1.md']);
  // nothing else moved or changed
  const now = deep(dir);
  for (const f of kept) assert.equal(now[f], was[f], f);
  assert.equal(readState(dir).kind, 'valid');
  assert.equal(JSON.parse(readFileSync(statePath(dir), 'utf8'))[STAMP_KEY], STATE_LAYOUT);

  // one commit leaves the tree clean, and the carried risk rulings are not tracked
  git(root, 'add', '-A', '.');
  git(root, 'commit', '-q', '-m', 'convert');
  assert.equal(git(root, 'status', '--porcelain'), '');
  assert.equal(git(root, 'ls-files', '--', '.planning/records/risk-carry'), '');

  // a second call changes no byte, and files in the review and return areas leave the layout alone
  const settled = deep(dir);
  assert.equal(runIn(root, ['status'], dir).ok, true);
  assert.deepEqual(deep(dir), settled);
  put(dir, 'phases/1/records/reviews/x.json', '{}');
  put(dir, 'phases/1/records/returns/y.json', '{}');
  assert.equal(runIn(root, ['status'], dir).ok, true);
  assert.equal(JSON.parse(readFileSync(statePath(dir), 'utf8'))[STAMP_KEY], STATE_LAYOUT);
});

test('a destination already taken with other bytes refuses the whole conversion; a run that stopped part way is finished', () => {
  const dir = v40();
  put(dir, 'trace.jsonl', 'one\n');
  put(dir, 'ARCHIVE.md', 'ledger\n');
  put(dir, 'records/trace.jsonl', 'two\n');
  const before = deep(dir);
  const r = run(['status'], dir);
  assert.deepEqual([r.ok, r.reason], [false, 'layout-destination-exists']);
  assert.ok(r.detail.includes(join(dir, 'records', 'trace.jsonl')));
  assert.ok(r.hint);
  assert.deepEqual(deep(dir), before);

  // as if an earlier run stopped after its first move: one log is already home, the ledger is not
  rmSync(join(dir, 'records'), { recursive: true });
  mkdirSync(join(dir, 'records'));
  renameSync(join(dir, 'trace.jsonl'), join(dir, 'records', 'trace.jsonl'));
  put(dir, 'FILED.md', 'filed\n');
  put(dir, 'records/FILED.md', 'filed\n');
  assert.equal(run(['status'], dir).ok, true);
  assert.deepEqual(readdirSync(join(dir, 'records')).sort(), ['.gitignore', 'ARCHIVE.md', 'FILED.md', 'state.json', 'trace.jsonl']);
  assert.equal(readFileSync(join(dir, 'records', 'trace.jsonl'), 'utf8'), 'one\n');
  assert.equal(readFileSync(join(dir, 'records', 'ARCHIVE.md'), 'utf8'), 'ledger\n');
  // the twin at the old place is gone, so the top holds only what AC3 lists
  assert.equal(existsSync(join(dir, 'FILED.md')), false);
});

const asRoot = process.getuid?.() === 0;

test('a linked phase folder, a linked archive group and a folder that cannot be read each refuse; nothing moves', () => {
  const elsewhere = mkdtempSync(join(tmpdir(), 'cad-migrate-elsewhere-'));
  put(elsewhere, 'phase-2/reports/plan-1.md', 'PLAN COMPLETE\n');
  put(elsewhere, 'archive/1/REVIEW-diff-plan-1.md');
  const cases = [
    ['layout-symlink', (dir) => { rmSync(join(dir, 'phases', '2'), { recursive: true }); symlinkSync(join(elsewhere, 'phase-2'), join(dir, 'phases', '2')); return join(dir, 'phases', '2'); }],
    ['layout-symlink', (dir) => { symlinkSync(join(elsewhere, 'archive'), join(dir, '_archive-v1.0')); return join(dir, '_archive-v1.0'); }],
  ];
  // permissions do not stop root, so the unreadable case means nothing there
  if (!asRoot) cases.push(['layout-unreadable', (dir) => { put(dir, 'phases/2/REVIEW-diff-plan-1.md'); chmodSync(join(dir, 'phases', '2'), 0o000); return join(dir, 'phases', '2'); }]);
  for (const [reason, shape] of cases) {
    const dir = v40();
    put(dir, 'phases/1/REVIEW-diff-plan-1.md');
    const named = shape(dir);
    const before = reason === 'layout-unreadable' ? null : deep(dir, 'phases', {});
    const r = run(['status'], dir);
    if (reason === 'layout-unreadable') chmodSync(named, 0o755);
    assert.deepEqual([r.ok, r.reason], [false, reason]);
    assert.ok(r.detail.includes(named), r.detail);
    assert.match(r.hint, /nothing was changed/);
    assert.equal(existsSync(statePath(dir)), false);
    assert.equal(existsSync(join(dir, 'phases', '1', 'records')), false);
    if (before) assert.deepEqual(deep(dir, 'phases', {}), before);
  }
});

test('a top records folder that is not a real folder refuses before a phase file moves; a state write that fails after says so', () => {
  const dir = v40();
  put(dir, 'phases/1/REVIEW-diff-plan-1.md');
  symlinkSync(mkdtempSync(join(tmpdir(), 'cad-migrate-elsewhere-')), join(dir, 'records'));
  const before = deep(dir);
  const r = run(['status'], dir);
  assert.deepEqual([r.ok, r.reason], [false, 'layout-records-not-dir']);
  assert.ok(r.detail.includes(join(dir, 'records')));
  assert.deepEqual(deep(dir), before);

  // a real records folder whose state lock can't be made passes every check, so the phase file moves before the write fails
  if (asRoot) return;
  rmSync(join(dir, 'records'));
  mkdirSync(join(dir, 'records'), { mode: 0o555 });
  const late = run(['status'], dir);
  chmodSync(join(dir, 'records'), 0o755);
  assert.deepEqual([late.ok, late.reason], [false, 'state-write-failed']);
  assert.doesNotMatch(late.hint, /not changed/);
  assert.match(late.hint, /already moved/);
  assert.equal(existsSync(join(dir, 'phases', '1', 'records', 'REVIEW-diff-plan-1.md')), true);
  // the next run finishes it
  assert.equal(run(['status'], dir).ok, true);
  assert.equal(readState(dir).kind, 'valid');
});

// --- who converts ------------------------------------------------------------

test('a call from a linked worktree aimed at the main tree never converts; a --worktree main session converts its own project', () => {
  const dir = v40();
  const root = track(dir);
  const exec = join(root, '..', `${root.split('/').pop()}-exec`);
  git(root, 'worktree', 'add', '-q', '-b', 'side', exec);
  const before = deep(dir);
  const refused = runIn(exec, ['lease-check', '--phase', '1', '--plan', '1'], dir);
  assert.deepEqual([refused.ok, refused.reason], [false, 'executor-cannot-convert']);
  assert.match(refused.hint, /main session/);
  assert.deepEqual(deep(dir), before);

  // the worktree's own .planning is its own project, called with no --dir: the session is the main session there
  const mine = join(exec, '.planning');
  assert.equal(runIn(exec, ['status']).ok, true);
  assert.equal(readState(mine).kind, 'valid');
  assert.deepEqual(deep(dir), before);

  // once the main session has converted the project, the same executor call runs as any call does
  assert.equal(runIn(root, ['status'], dir).ok, true);
  const again = runIn(exec, ['lease-check', '--phase', '1', '--plan', '1'], dir);
  assert.notEqual(again.reason, 'executor-cannot-convert');
});

test('no hook script reaches the conversion', () => {
  const bin = join(import.meta.dirname, '..', 'cadence-core', 'bin');
  for (const f of ['read-trace.mjs', 'subagent-trace.mjs', 'git-guard.mjs']) {
    assert.doesNotMatch(readFileSync(join(bin, f), 'utf8'), /migrate\.mjs/, f);
  }
});

// --- the answer of the call that converted -----------------------------------

test('the converting call says a commit is due, or not, and no other call carries the field', () => {
  // due: commit_docs on, .planning tracked
  const due = layoutFixture().dir;
  const root = track(due);
  const first = runIn(root, ['status'], due);
  assert.equal(first.migration.converted, true);
  assert.equal(first.migration.commit_due, true);
  assert.match(first.migration.hint, /commit/);
  const second = runIn(root, ['status'], due);
  assert.equal('migration' in second, false);
  const { migration, ...rest } = first;
  assert.deepEqual(rest, second);

  // not due: commit_docs off
  const off = v40();
  writeFileSync(join(off, 'config.json'), JSON.stringify({ planning: { commit_docs: false } }));
  const offRoot = track(off);
  const offRun = runIn(offRoot, ['status'], off);
  assert.deepEqual([offRun.migration.converted, offRun.migration.commit_due, 'hint' in offRun.migration], [true, false, false]);

  // not due: git ignores the planning directory
  const ignored = v40();
  const ignRoot = track(ignored, { '.gitignore': '.planning/\n' });
  assert.equal(runIn(ignRoot, ['status'], ignored).migration.commit_due, false);

  // not due outside a repository
  assert.equal(run(['status'], v40()).migration.commit_due, false);
});

// --- rebuilding a state file that does not parse -----------------------------

/** A converted v4.0 project whose state file was cut off half way. */
function truncated() {
  const dir = v40();
  assert.equal(run(['status'], dir).ok, true);
  const text = readFileSync(statePath(dir), 'utf8');
  writeFileSync(statePath(dir), text.slice(0, Math.floor(text.length / 2)));
  return dir;
}

test('a truncated state file makes every other seam refuse naming state-rebuild, and leaves the file as it was', () => {
  const dir = truncated();
  const torn = readFileSync(statePath(dir), 'utf8');
  for (const args of [['status'], ['cursor', 'get'], ['audit'], ['criteria-coverage'], ['deferred', 'list'], ['trace', 'render', '--phase', '1']]) {
    const r = run(args, dir);
    assert.deepEqual([r.ok, r.reason], [false, 'invalid-state'], args.join(' '));
    assert.match(r.hint, /`planning\.mjs state-rebuild`/, args.join(' '));
  }
  assert.equal(readFileSync(statePath(dir), 'utf8'), torn);
});

test('state-rebuild restores a state equal to a fresh import, moves no file, and status then answers ok:true', () => {
  const dir = truncated();
  const paths = Object.keys(deep(dir)).sort();
  const r = run(['state-rebuild'], dir);
  assert.equal(r.ok, true);
  assert.deepEqual([r.rebuilt, r.was, r.layout], [true, 'not-json', STATE_LAYOUT]);
  const got = readState(dir);
  assert.equal(got.kind, 'valid');
  assert.deepEqual(got.state, importState(dir).state);
  assert.equal(JSON.parse(readFileSync(statePath(dir), 'utf8'))[STAMP_KEY], STATE_LAYOUT);
  assert.deepEqual(Object.keys(deep(dir)).sort(), paths);
  assert.equal(run(['status'], dir).ok, true);
  // a valid state is never rebuilt over
  const bytes = readFileSync(statePath(dir), 'utf8');
  assert.equal(run(['state-rebuild'], dir).rebuilt, false);
  assert.equal(readFileSync(statePath(dir), 'utf8'), bytes);
});

test('state-rebuild on a project the importer refuses answers that refusal and leaves the damaged file byte-identical', () => {
  const dir = truncated();
  writeFileSync(join(dir, 'ROADMAP.md'), '# Roadmap\n\n## Phases\n\n- Phase 1: Ship auth\n');
  const before = deep(dir);
  const r = run(['state-rebuild'], dir);
  assert.deepEqual([r.ok, r.reason], [false, 'unparseable-roadmap']);
  assert.ok(r.hint);
  assert.deepEqual(deep(dir), before);
});

test('state-rebuild refuses a state file of a newer layout and leaves it alone', () => {
  const dir = v40();
  mkdirSync(join(dir, 'records'));
  const newer = JSON.stringify({ [STAMP_KEY]: STATE_LAYOUT + 1 });
  writeFileSync(statePath(dir), newer);
  const r = run(['state-rebuild'], dir);
  assert.deepEqual([r.ok, r.reason], [false, 'invalid-state']);
  assert.match(r.detail, /newer-layout/);
  assert.match(r.hint, /update the plugin/);
  assert.equal(readFileSync(statePath(dir), 'utf8'), newer);
});

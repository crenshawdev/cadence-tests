// Zero-dep tests for moving an old-path project to the agile path: what agile.mjs check says moves, and what it refuses.
// Run: node --test tests/agile-switch.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerSetup, scratch } from './planning.test.mjs';
import { writeState } from '../cadence-core/bin/lib/project-state.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGILE = join(HERE, '..', 'cadence-core', 'bin', 'agile.mjs');
const FIXTURE = join(HERE, 'fixtures', 'seldon-design');
const WHO = { GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@b.c', GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@b.c' };

/** One agile.mjs call with no user-global config and none of this machine's git settings. */
function run(dir, args) {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', CADENCE_GLOBAL_CONFIG: join(dirname(dir), 'no-global.json'), ...WHO };
  const r = spawnSync('node', [AGILE, ...args, '--dir', dir], { encoding: 'utf8', env });
  return { ...JSON.parse(r.stdout), _exit: r.status };
}
const check = (dir, design = FIXTURE) => run(dir, ['check', '--design', design]);
const start = (dir, design = FIXTURE) => run(dir, ['start', '--design', design]);
const next = (dir) => run(dir, ['next']);

/** Every path under `root` with its bytes, a link as its target. */
function tree(root, rel = '') {
  const out = {};
  for (const name of readdirSync(join(root, rel)).sort()) {
    const p = rel ? `${rel}/${name}` : name;
    const st = lstatSync(join(root, p));
    if (st.isSymbolicLink()) out[p] = `-> ${readlinkSync(join(root, p))}`;
    else if (st.isDirectory()) Object.assign(out, { [`${p}/`]: '' }, tree(root, p));
    else out[p] = readFileSync(join(root, p), 'utf8');
  }
  return out;
}

const put = (dir, rel, text = 'x\n') => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };
const CLOSED = { cycleOpen: false, cursor: { phase: 1, status: 'ready to plan', next: '/cad-phase add', updated: '2026-11-25' }, phases: [], requirements: [] };

/** An old-path project whose last release closed and landed, with the setup a start asks for already answered. */
function landedProject(t, state = CLOSED) {
  const dir = answerSetup(join(scratch('cad-agile-switch-', t), '.planning'));
  assert.equal(writeState(dir, state).ok, true);
  put(dir, 'PROJECT.md', '# Toolshed\n');
  put(dir, 'ROADMAP.md', '# Roadmap: Toolshed\n\n## Phases\n');
  return dir;
}

/** A queue member as `deferred record` writes one, in the carried queue's home. */
function deferredMember(dir) {
  put(dir, 'records/deferred/2/DEFERRED-diff-plan-1.json', `${JSON.stringify({ phase: '2', trigger: 'diff', discriminator: 'plan-1', round: 1,
    base: 'abc1234', head: 'HEAD', base_id: 'a'.repeat(40), head_id: 'b'.repeat(40), findings: [] })}\n`);
}

test('an old-path project whose release has landed is one a start may move: check answers the switch, start and next still refuse, nothing is written', (t) => {
  const dir = landedProject(t);
  const before = tree(dirname(dir));
  const r = check(dir);
  assert.deepEqual([r.ok, r._exit, r.release], [true, 0, 'Toolshed'], JSON.stringify(r));
  assert.ok(r.switch, JSON.stringify(r));
  const s = start(dir);
  assert.deepEqual([s.ok, s._exit, s.reason], [false, 1, 'switch'], JSON.stringify(s));
  assert.match(s.hint, /nothing was written/);
  const n = next(dir);
  assert.deepEqual([n.ok, n.reason], [false, 'switch'], JSON.stringify(n));
  // no command moves it yet, so the hint mustn't send the user to one that stops on this same answer
  assert.match(n.hint, /agile\.mjs check --design <folder>, and doesn't move it yet/);
  assert.deepEqual(tree(dirname(dir)), before);
});

test('an old-path project whose release hasn\'t landed is refused naming what to clear, by check and start alike, with nothing written', (t) => {
  /** @type {[string, (dir: string) => void, RegExp, RegExp][]} */
  const cases = [
    ['a cycle open', (d) => assert.equal(writeState(d, { ...CLOSED, cycleOpen: true }).ok, true), /PROJECT\.md/, /\/cad-milestone.*\/cad-land/],
    ['a deferred finding unruled', deferredMember, /1 deferred finding file unruled: .*records\/deferred\/2\/DEFERRED-diff-plan-1\.json/, /\/cad-land; if that release was landed by hand, remove those files/],
    ['a queue that can\'t be read', (d) => { mkdirSync(join(d, 'phases'), { recursive: true }); symlinkSync('/tmp', join(d, 'phases', '3')); }, /can't all be read.*phases\/3/, /make them readable/],
    ['risk rulings carried', (d) => mkdirSync(join(d, 'records', 'risk-carry'), { recursive: true }), /records\/risk-carry holds risk rulings/, /\/cad-land; if it was landed by hand, remove that folder/],
    ['a folder named agile', (d) => mkdirSync(join(d, 'agile')), /agile is there/, /move that folder aside/],
    ['a records folder that is a link', (d) => { renameSync(join(d, 'records'), join(d, 'real-records')); symlinkSync(join(d, 'real-records'), join(d, 'records')); },
      /records is not a real folder \(symlinked-records\)/, /put the records folder back as a real folder/],
  ];
  for (const [name, make, detail, hint] of cases) {
    const dir = landedProject(t);
    make(dir);
    const before = tree(dirname(dir));
    for (const r of [check(dir), start(dir)]) {
      assert.deepEqual([r.ok, r._exit, r.reason], [false, 1, 'old-path'], `${name}: ${JSON.stringify(r)}`);
      assert.match(r.detail, detail, name);
      assert.match(r.hint, hint, name);
      assert.match(r.hint, /nothing was written$/, name);
    }
    assert.deepEqual(tree(dirname(dir)), before, name);
  }
});

test('old-path files with no state file yet are refused naming the command that writes one', (t) => {
  const dir = answerSetup(join(scratch('cad-agile-switch-', t), '.planning'));
  put(dir, 'PROJECT.md', '# Toolshed\n');
  const before = tree(dirname(dir));
  for (const r of [check(dir), start(dir)]) {
    assert.deepEqual([r.ok, r.reason], [false, 'old-path'], JSON.stringify(r));
    assert.match(r.detail, /no state file yet: PROJECT\.md/);
    assert.match(r.hint, /\/cad-progress once/);
  }
  assert.deepEqual(tree(dirname(dir)), before);
});

/** The test design with every requirement ID renamed, so it reuses none the old project used. @param {string} to */
function freshDesign(to) {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(FIXTURE)) {
    writeFileSync(join(to, name), readFileSync(join(FIXTURE, name), 'utf8').replaceAll('CAT-', 'TOOL-').replaceAll('LOAN-', 'LEND-').replaceAll('NFR-', 'QUAL-'));
  }
  return to;
}

const OLD_REQUIREMENTS = '# Requirements: Toolshed\n\n## Shipped\n\n| CAT-01 (a catalog) | 1 | Complete | v1.0.0 |\n\n## v2 Requirements\n\n- **MOD-01**: later, after LOAN-02 lands\n';

test('check names what a switch archives, what it copies open work from and what it leaves, the user\'s own files and an open design among the left', (t) => {
  const dir = landedProject(t);
  for (const rel of ['REQUIREMENTS.md', 'STATE.md', 'CAPTURE.md', 'CAPTURE.md.lock', 'ARCHIVE.md', 'state.json', 'tasks/fix-typo/RECORD.md',
    'spikes/probe/SPIKE.md', 'debug/hang.md', 'research/RESEARCH.md', '_archive-v1.0.0/1/PLAN-1.md', 'REVIEW-risk_surface-v1.0.0.md',
    'trace.jsonl', 'reads.1.jsonl.claim.123', 'records/ARCHIVE.md', 'records/DECLINED.md', 'records/FILED.md', 'records/FILED.md.lock',
    'records/trace.jsonl', 'records/reads.jsonl', 'records/deferred/1/ADJUDICATION-diff-plan-1.json', 'records/codemap/index.json',
    'records/.gitignore', 'drafts/notes.md', 'notes.txt', 'config.json.bak']) put(dir, rel, rel === 'REQUIREMENTS.md' ? OLD_REQUIREMENTS : 'x\n');
  mkdirSync(join(dir, 'phases'));
  // the design the old release started from, at the top, and one no release has, in a folder of its own
  cpSync(FIXTURE, join(dir, 'seldon'), { recursive: true });
  put(dir, 'seldon/architecture.md');
  const open = freshDesign(join(dir, 'seldon', 'next'));
  const before = tree(dirname(dir));
  const r = check(dir, open);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.switch.archive, ['ARCHIVE.md', 'CAPTURE.md', 'CAPTURE.md.lock', 'PROJECT.md', 'REQUIREMENTS.md', 'REVIEW-risk_surface-v1.0.0.md',
    'ROADMAP.md', 'STATE.md', '_archive-v1.0.0', 'debug', 'phases', 'reads.1.jsonl.claim.123', 'records/.gitignore', 'records/ARCHIVE.md', 'records/DECLINED.md',
    'records/FILED.md', 'records/FILED.md.lock', 'records/deferred', 'records/reads.jsonl', 'records/state.json', 'records/trace.jsonl', 'research',
    'seldon/brief.md', 'seldon/prd.md', 'seldon/spine.md', 'seldon/epics.md', 'seldon/architecture.md', 'spikes', 'state.json', 'tasks', 'trace.jsonl']);
  assert.deepEqual(r.switch.copy, ['PROJECT.md', 'REQUIREMENTS.md', 'CAPTURE.md', 'records/DECLINED.md', 'records/FILED.md']);
  // the ignore file goes with the logs it ignores: its rules are anchored to its folder, so left behind they'd ignore nothing
  assert.deepEqual(r.switch.leave, ['config.json', 'config.json.bak', 'drafts', 'notes.txt', 'records/codemap', 'seldon/next']);
  assert.deepEqual(tree(dirname(dir)), before);
});

test('a design whose IDs the old REQUIREMENTS.md holds anywhere is refused, as the old path refuses it, and so is one that can\'t be read', (t) => {
  const dir = landedProject(t);
  put(dir, 'REQUIREMENTS.md', OLD_REQUIREMENTS);
  const before = tree(dirname(dir));
  for (const r of [check(dir), start(dir)]) {
    assert.deepEqual([r.ok, r._exit, r.reason], [false, 1, 'requirement-ids-used'], JSON.stringify(r));
    assert.match(r.detail, /^CAT-01, LOAN-02 are already in .*REQUIREMENTS\.md/);
    assert.match(r.hint, /prd\.md.*epics\.md.*nothing was written$/);
  }
  assert.deepEqual(tree(dirname(dir)), before);
  // the same design with fresh IDs goes through
  assert.equal(check(dir, freshDesign(join(scratch('cad-agile-fresh-', t), 'design'))).ok, true);

  const linked = landedProject(t);
  symlinkSync(join(dir, 'REQUIREMENTS.md'), join(linked, 'REQUIREMENTS.md'));
  const r = check(linked);
  assert.deepEqual([r.ok, r.reason], [false, 'old-requirements'], JSON.stringify(r));
  assert.match(r.detail, /not a plain file/);
});

test('an old REQUIREMENTS.md or a folder the switch lists that can\'t be read is refused by name, not as an internal error', (t) => {
  const cases = [
    ['REQUIREMENTS.md', 'old-requirements', /REQUIREMENTS\.md can't be read \(EACCES\)/, (d) => { put(d, 'REQUIREMENTS.md', OLD_REQUIREMENTS); chmodSync(join(d, 'REQUIREMENTS.md'), 0o000); }],
    ['seldon', 'old-path', /can't be read: .*seldon/, (d) => { mkdirSync(join(d, 'seldon')); chmodSync(join(d, 'seldon'), 0o000); }],
  ];
  for (const [name, reason, detail, make] of cases) {
    const dir = landedProject(t);
    make(dir);
    const r = check(dir);
    // put back before the scratch folder is removed, which can't list a folder no one may read
    chmodSync(join(dir, name), 0o755);
    assert.deepEqual([r.ok, r._exit, r.reason], [false, 1, reason], `${name}: ${JSON.stringify(r)}`);
    assert.match(r.detail, detail, name);
    assert.match(r.hint, /make it readable, then re-run; nothing was written$/, name);
  }
});

// Zero-dep tests for moving an old-path project to the agile path: what agile.mjs check says moves, and what it refuses.
// Run: node --test tests/agile-switch.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
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
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', CADENCE_GLOBAL_CONFIG: join(dir, 'no-global.json'), ...WHO };
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
  assert.match(n.hint, /\/cad-agile --brief/);
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

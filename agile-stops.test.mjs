// Zero-dep tests for the old path's start commands stopping on a project the agile path owns.
// Run: node --test tests/agile-stops.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerSetup, scratch } from './planning.test.mjs';
import { markAgile, readState, statePath } from '../cadence-core/bin/lib/project-state.mjs';
import { appendRead } from '../cadence-core/bin/lib/read-trace.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE = join(HERE, '..', 'cadence-core');
const CHECK = 'trace ignore --check --root .';
const workflow = (name) => readFileSync(join(CORE, 'workflows', name), 'utf8');

const check = (root) => {
  const r = spawnSync('node', [join(CORE, 'bin', 'planning.mjs'), ...CHECK.split(' ')], { cwd: root, encoding: 'utf8' });
  return JSON.parse(r.stdout);
};
const tree = (root) => readdirSync(root, { recursive: true }).map(String).sort()
  .map((p) => [p, statSync(join(root, p)).mtimeMs, statSync(join(root, p)).isFile() ? readFileSync(join(root, p), 'utf8') : '']);

test('the check refuses a marked project naming /cad-agile, passes any other, and writes nothing in either', (t) => {
  const marked = scratch('cad-stop-marked-', t);
  mkdirSync(join(marked, '.planning'));
  assert.equal(markAgile(join(marked, '.planning')).ok, true);
  const seldon = scratch('cad-stop-seldon-', t);
  mkdirSync(join(seldon, '.planning', 'seldon'), { recursive: true });
  for (const [root, reason] of [[marked, 'agile-path'], [seldon, undefined], [scratch('cad-stop-empty-', t), undefined]]) {
    const before = tree(root);
    const r = check(root);
    assert.deepEqual([r.ok, r.reason], [reason === undefined, reason], JSON.stringify(r));
    if (reason) assert.match(r.hint, /\/cad-agile/);
    assert.deepEqual(tree(root), before);
  }
});

test('/cad-new-project and /cad-adopt run the check in their first stop, before anything they write', () => {
  for (const [name, writes] of [['new-project.md', ['run `git init`', '3. `mkdir -p .planning`']], ['adopt.md', ['mkdir -p .planning\n']]]) {
    const prose = workflow(name);
    const at = prose.indexOf(CHECK);
    const stop = prose.slice(prose.lastIndexOf('1. If `.planning/PROJECT.md` exists, stop', at), at).replace(/\s+/g, ' ');
    assert.match(stop, /when `\.planning\/agile\/` exists or the call below, which writes nothing, answers reason `agile-path`, stop:.*\/cad-agile/, name);
    for (const write of writes) {
      assert.ok(prose.indexOf(write) > at, `${name}: ${JSON.stringify(write)} comes before the check, or is gone`);
    }
  }
  const design = workflow('new-project-design.md').replace(/\s+/g, ' ');
  const item = design.indexOf("Run `new-project.md`'s `setup` item 1 and stop where it stops.");
  assert.ok(item > 0 && item < design.indexOf('design-read --design'), 'the design route reads the design before that stop');
});

test('each old command opens its process with the stop, before it can read or write anything', () => {
  for (const name of ['audit', 'context', 'coverage', 'execute', 'health', 'milestone', 'pause', 'phase', 'plan', 'progress', 'report', 'suggest', 'undo', 'verify']) {
    const process = readFileSync(join(HERE, '..', 'skills', `cad-${name}`, 'SKILL.md'), 'utf8').split('<process>')[1].replace(/\s+/g, ' ');
    assert.ok(process.startsWith(' On an agile project (`.planning/agile/` exists and `.planning/PROJECT.md` doesn\'t), stop before anything else, '
      + 'with this line and nothing after it: "This project is on the agile path. /cad-agile shows what comes next."'), name);
  }
});

const FIXTURE = join(HERE, 'fixtures', 'seldon-design');
const seam = (script, ...args) => JSON.parse(spawnSync('node', [join(CORE, 'bin', script), ...args], { encoding: 'utf8' }).stdout);

test('an agile project whose marker is gone or unreadable is neither stamped nor rebuilt by an old-path call', (t) => {
  const damage = (dir) => writeFileSync(statePath(dir), '<<<<\n');
  /** @type {[string, (dir: string) => void][]} */
  const cases = [
    ['the marker is gone', (d) => rmSync(statePath(d))],
    ['the records folder is gone', (d) => rmSync(dirname(statePath(d)), { recursive: true })],
    ['the marker is damaged', damage],
    ['the marker is damaged and release.md is gone', (d) => { damage(d); rmSync(join(d, 'agile', 'release.md')); }],
  ];
  for (const [name, spoil] of cases) {
    const dir = join(scratch('cad-stray-', t), '.planning');
    assert.equal(seam('agile.mjs', 'start', '--design', FIXTURE, '--dir', answerSetup(dir)).ok, true);
    spoil(dir);
    const link = join(scratch('cad-stray-link-', t), '.planning');
    symlinkSync(dir, link);
    const before = tree(dir);
    const append = ['trace', 'append', '--phase', '0', '--family', 'lifecycle', '--event', 'phase_start', '--sha', 'abc1234'];
    for (const args of [['status'], ['cursor', 'get'], ['state-rebuild'], ['recall', 'tool'], append]) {
      for (const at of [dir, link]) {
        const r = seam('planning.mjs', ...args, '--dir', at);
        assert.deepEqual([r.ok, r.reason], [false, 'agile-path'], `${name}: ${args.join(' ')} at ${at}: ${JSON.stringify(r)}`);
        assert.match(r.hint, /\/cad-agile/);
      }
    }
    // the hooks write past the gate, and a marker they can't read is no stamp
    assert.equal(appendRead(dir, { ts: '2026-01-01T00:00:00.000Z', tool: 'Read', target: '/a' }).written, false, name);
    assert.deepEqual(tree(dir), before, name);
  }
});

test('an old-path project that keeps its own agile folder is still stamped and still rebuilt', (t) => {
  const dir = join(scratch('cad-own-agile-', t), '.planning');
  mkdirSync(join(dir, 'agile'), { recursive: true });
  writeFileSync(join(dir, 'agile', 'release.md'), 'mine\n');
  writeFileSync(join(dir, 'PROJECT.md'), '# Old\n');
  assert.notEqual(seam('planning.mjs', 'status', '--dir', dir).reason, 'agile-path');
  assert.equal(readState(dir).kind, 'valid');
  writeFileSync(statePath(dir), '<<<<\n');
  assert.equal(seam('planning.mjs', 'state-rebuild', '--dir', dir).rebuilt, true);
  assert.equal(readState(dir).kind, 'valid');
});

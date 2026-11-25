// Zero-dep tests for the old path's start commands stopping on a project the agile path owns.
// Run: node --test tests/agile-stops.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratch } from './planning.test.mjs';
import { markAgile } from '../cadence-core/bin/lib/project-state.mjs';

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
    assert.match(stop, /on `ok:false` with reason `agile-path`, print its `hint` and stop/, name);
    for (const write of writes) {
      assert.ok(prose.indexOf(write) > at, `${name}: ${JSON.stringify(write)} comes before the check, or is gone`);
    }
  }
  const design = workflow('new-project-design.md').replace(/\s+/g, ' ');
  const item = design.indexOf("Run `new-project.md`'s `setup` item 1 and stop where it stops.");
  assert.ok(item > 0 && item < design.indexOf('design-read --design'), 'the design route reads the design before that stop');
});

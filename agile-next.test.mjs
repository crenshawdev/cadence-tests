// Zero-dep tests for agile.mjs next - what the project's agile release does next, read from its files and changing none.
// Run: node --test tests/agile-next.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratch } from './planning.test.mjs';
import { markAgile, statePath } from '../cadence-core/bin/lib/project-state.mjs';
import { epicFile, releaseFile } from '../cadence-core/bin/lib/agile-paths.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGILE = join(HERE, '..', 'cadence-core', 'bin', 'agile.mjs');
const FIXTURE = join(HERE, 'fixtures', 'seldon-design');

const run = (dir, ...args) => {
  const r = spawnSync('node', [AGILE, ...args, '--dir', dir], { encoding: 'utf8' });
  return { ...JSON.parse(r.stdout), _exit: r.status };
};
const planning = (t) => join(scratch('cad-agile-next-', t), '.planning');
const agile = (dir) => join(dir, 'agile');
const status = (dir, epic, word) => {
  const file = epicFile(agile(dir), epic);
  writeFileSync(file, readFileSync(file, 'utf8').replace(/^status: .*$/m, `status: ${word}`));
};

/** Every file under `root` with its bytes and when it last changed. */
const tree = (root) => readdirSync(root, { recursive: true }).map(String).sort()
  .map((p) => [p, statSync(join(root, p)).mtimeMs, statSync(join(root, p)).isFile() ? readFileSync(join(root, p), 'utf8') : '']);

test('with no release, next says so and makes nothing, and a start cut short before its files reads the same', (t) => {
  const dir = planning(t);
  const none = { ok: true, release: null, next: null, _exit: 0 };
  assert.deepEqual(run(dir, 'next'), none);
  assert.deepEqual(readdirSync(dirname(dir)), []);
  mkdirSync(dir);
  assert.equal(markAgile(dir).ok, true);
  const before = tree(dir);
  assert.deepEqual(run(dir, 'next'), none);
  assert.deepEqual(tree(dir), before);
});

test('next is the first epic in build order that is not done, which a start already answers', (t) => {
  const dir = planning(t);
  const first = { id: 'E-01', name: 'Catalog', status: 'backlog' };
  assert.deepEqual(run(dir, 'start', '--design', FIXTURE).next, first);
  const before = tree(dir);
  assert.deepEqual(run(dir, 'next'), { ok: true, release: 'Toolshed', next: first, _exit: 0 });
  assert.deepEqual(tree(dir), before);
  status(dir, 'E-01', 'done');
  status(dir, 'E-02', 'in-progress');
  assert.deepEqual(run(dir, 'next').next, { id: 'E-02', name: 'Lending', status: 'in-progress' });
  status(dir, 'E-02', 'done');
  status(dir, 'E-03', 'done');
  assert.deepEqual(run(dir, 'next'), { ok: true, release: 'Toolshed', next: null, _exit: 0 });
});

test('next refuses an old-path project as a start does, and changes nothing in it', (t) => {
  const dir = planning(t);
  mkdirSync(dir);
  writeFileSync(join(dir, 'PROJECT.md'), '# Old\n');
  const before = tree(dir);
  const r = run(dir, 'next');
  assert.deepEqual([r.ok, r.reason, r._exit], [false, 'old-path', 1]);
  assert.match(r.hint, /\/cad-milestone/);
  assert.deepEqual(tree(dir), before);
});

test('a release file that does not read back is refused naming the file, and no epic is skipped over', (t) => {
  const edit = (file, from, to) => writeFileSync(file, readFileSync(file, 'utf8').replace(from, to));
  const release = (dir) => releaseFile(agile(dir));
  const epic = (dir) => epicFile(agile(dir), 'E-01');
  /** @type {[string, (dir: string) => string, (dir: string) => void][]} */
  const breaks = [
    ['a release with no title', release, (d) => edit(release(d), /^# Release: .*$/m, '# Toolshed')],
    ['a release with no epic list', release, (d) => edit(release(d), /^## Epics$/m, '## Epic list')],
    ['an epic line that lost its ID', release, (d) => edit(release(d), /^- E-01: .*$/m, '- Catalog')],
    ['a release that lists no epic', release, (d) => edit(release(d), /^- E-.*$/gm, '')],
    ['no release file', release, (d) => rmSync(release(d))],
    ['an epic with a status that is not one', epic, (d) => status(d, 'E-01', 'started')],
    ['an epic whose frontmatter is gone', epic, (d) => edit(epic(d), /^---$/gm, '')],
    ['no epic file', epic, (d) => rmSync(epic(d))],
  ];
  for (const [name, file, spoil] of breaks) {
    const dir = planning(t);
    assert.equal(run(dir, 'start', '--design', FIXTURE).ok, true);
    spoil(dir);
    const before = tree(dir);
    const r = run(dir, 'next');
    assert.deepEqual([r.ok, r.reason, r._exit], [false, 'release-damaged', 1], name);
    assert.ok(r.detail.includes(file(dir)), `${name}: ${r.detail}`);
    assert.ok(r.hint, name);
    assert.deepEqual(tree(dir), before, name);
  }
});

test('a marker too damaged to read is refused as this path\'s own, and state-rebuild leaves it alone', (t) => {
  for (const text of ['<<<<\n', '{"path":"agile"}\n', '{"layout":1,"path":"agile"}\n']) {
    const dir = planning(t);
    assert.equal(run(dir, 'start', '--design', FIXTURE).ok, true);
    writeFileSync(statePath(dir), text);
    const before = tree(dir);
    for (const args of [['next'], ['start', '--design', FIXTURE]]) {
      const r = run(dir, ...args);
      assert.deepEqual([r.ok, r.reason], [false, 'unmarked'], `${text}${args[0]}`);
      assert.match(r.hint, /git or your backup/);
      assert.doesNotMatch(r.hint, /state-rebuild/);
    }
    const rebuilt = spawnSync('node', [join(dirname(AGILE), 'planning.mjs'), 'state-rebuild', '--dir', dir], { encoding: 'utf8' });
    assert.equal(JSON.parse(rebuilt.stdout).reason, 'agile-path', rebuilt.stdout);
    assert.deepEqual(tree(dir), before);
  }
});

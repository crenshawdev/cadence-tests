// Zero-dep tests for agile.mjs close - a finished release moved into releases/<version>/, or refused with nothing written.
// Run: node --test tests/agile-close.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerSetup, scratch } from './planning.test.mjs';
import { closingDir, epicFile, releasesDir, storyFile } from '../cadence-core/bin/lib/agile-paths.mjs';
import { readEpicFile, readRequirementsFile } from '../cadence-core/bin/lib/agile-read.mjs';
import { renderStoryFile } from '../cadence-core/bin/lib/agile-render.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGILE = join(HERE, '..', 'cadence-core', 'bin', 'agile.mjs');
const FIXTURE = join(HERE, 'fixtures', 'seldon-design');

const run = (dir, ...args) => {
  const r = spawnSync('node', [AGILE, ...args, '--dir', dir], { encoding: 'utf8' });
  return { ...JSON.parse(r.stdout), _exit: r.status };
};
const agile = (dir) => join(dir, 'agile');
const tree = (root) => readdirSync(root, { recursive: true }).map(String).filter((p) => !p.startsWith('.git')).sort()
  .map((p) => [p, statSync(join(root, p)).mtimeMs, statSync(join(root, p)).isFile() ? readFileSync(join(root, p), 'utf8') : '']);
const send = (dir, payload) => {
  const file = join(dirname(dir), '..', 'close.json');
  writeFileSync(file, typeof payload === 'string' ? payload : JSON.stringify(payload));
  return run(dir, 'close', '--payload', file);
};
const edit = (file, from, to) => writeFileSync(file, readFileSync(file, 'utf8').replace(from, to));

/** A release whose every epic is accepted, each with one done story carrying all its requirements but those `left`. */
function finished(t, left = ['CAT-02']) {
  const root = join(scratch('cad-agile-close-', t), 'repo');
  mkdirSync(root, { recursive: true });
  const dir = answerSetup(join(root, '.planning'));
  assert.equal(run(dir, 'start', '--design', FIXTURE).ok, true);
  for (const id of ['E-01', 'E-02', 'E-03']) {
    edit(epicFile(agile(dir), id), /^status: .*$/m, 'status: done');
    const requirements = readEpicFile(readFileSync(epicFile(agile(dir), id), 'utf8')).requirements.filter((q) => !left.includes(q));
    writeFileSync(storyFile(agile(dir), `${id}-1`), renderStoryFile({ id: `${id}-1`, title: `All of ${id}`, size: 'S', status: 'done', builds_on: [],
      requirements, delivers: 'Everything the epic asks.', accepted_when: ['Running it shows it.'] }));
  }
  return { root, dir };
}
const MOVED = ['REQUIREMENTS.md', 'epics', 'release.md'];

test('a close moves the release into releases/<version>/, leaves the rest, and then no release is open and a start is refused', (t) => {
  const { dir } = finished(t);
  writeFileSync(join(agile(dir), 'backlog.md'), '## Todos\n\n- [ ] a later one\n');
  const before = Object.fromEntries(tree(agile(dir)).map(([p, , text]) => [p, text]));
  const r = send(dir, { version: '0.10.0', defer: ['CAT-02'] });
  assert.deepEqual([r.ok, r.version, r.deferred], [true, '0.10.0', ['CAT-02']], JSON.stringify(r));
  assert.deepEqual(readdirSync(agile(dir)).sort(), ['backlog.md', 'project.md', 'releases']);
  const home = join(releasesDir(agile(dir)), '0.10.0');
  assert.deepEqual(readdirSync(home).sort(), MOVED);
  for (const [p, text] of Object.entries(before)) {
    if (p === 'REQUIREMENTS.md') continue;
    const now = MOVED.some((m) => p === m || p.startsWith(`${m}/`)) ? join(home, p) : join(agile(dir), p);
    assert.equal(statSync(now).isFile() ? readFileSync(now, 'utf8') : '', text, p);
  }
  // the one deferred moved under Deferred, and every other line kept
  const read = readRequirementsFile(readFileSync(join(home, 'REQUIREMENTS.md'), 'utf8'));
  assert.deepEqual(read.deferred.map((q) => q.id), ['CAT-02']);
  assert.equal(read.requirements.some((q) => q.id === 'CAT-02'), false);
  assert.deepEqual(run(dir, 'next'), { ok: true, release: null, next: null, _exit: 0 });
  const start = run(dir, 'start', '--design', FIXTURE);
  assert.equal(start.reason, 'release-closed');
  assert.match(start.detail, /closed as 0\.10\.0/);
  assert.equal(run(dir, 'close').reason, 'not-closing');
});

test('a close with nothing open takes no defer and leaves REQUIREMENTS.md as it was', (t) => {
  const { dir } = finished(t, []);
  const text = readFileSync(join(agile(dir), 'REQUIREMENTS.md'), 'utf8');
  assert.equal(send(dir, { version: 'v2.0.0' }).ok, true);
  assert.equal(readFileSync(join(releasesDir(agile(dir)), 'v2.0.0', 'REQUIREMENTS.md'), 'utf8'), text);
});

test('a close that can\'t be made is refused naming why, with nothing written', (t) => {
  const { dir } = finished(t);
  const before = tree(dir);
  for (const [payload, words] of [
    [{ version: '0.10.0' }, /CAT-02 is open, so the release can't close without it/],
    [{ version: '0.10.0', defer: ['CAT-01', 'CAT-02'] }, /names CAT-01, which isn't open - those are CAT-02/],
    [{ version: '0.10.0', defer: ['CAT-02', 'CAT-02'] }, /each once/],
    [{ version: '../x', defer: ['CAT-02'] }, /letters, digits and \._\+- only/], [{ version: '-rc', defer: ['CAT-02'] }, /starting with a letter or digit/],
    [{ version: 'a b', defer: ['CAT-02'] }, /letters, digits/], [{ defer: ['CAT-02'] }, /letters, digits/],
    [{ version: '1.0.0', defer: ['CAT-02'], tag: 'x' }, /is not a field/], ['[]', /is an object with version and defer/],
  ]) {
    const r = send(dir, payload);
    assert.equal(r.reason, 'close-refused', JSON.stringify(payload));
    assert.ok(r.issues.some((i) => words.test(i.problem)), JSON.stringify(r.issues));
  }
  assert.equal(run(dir, 'close').reason, 'not-closing');
  assert.deepEqual(tree(dir), before);
  // nor before every epic is done, nor a version closed already
  const early = finished(t);
  edit(epicFile(agile(early.dir), 'E-03'), /^status: .*$/m, 'status: in-progress');
  assert.equal(send(early.dir, { version: '1.0.0', defer: ['CAT-02'] }).reason, 'not-closing');
  const again = finished(t);
  mkdirSync(join(releasesDir(agile(again.dir)), '1.0.0'), { recursive: true });
  assert.match(send(again.dir, { version: '1.0.0', defer: ['CAT-02'] }).issues[0].problem, /1\.0\.0 is closed already/);
});

test('a close stopped while its files moved is named by next and finished by close with no payload, asking nothing', (t) => {
  for (const moved of [[], ['epics'], ['epics', 'REQUIREMENTS.md'], MOVED]) {
    const { dir } = finished(t);
    const staging = closingDir(agile(dir), '0.10.0');
    mkdirSync(staging, { recursive: true });
    for (const name of moved) renameSync(join(agile(dir), name), join(staging, name));
    const next = run(dir, 'next');
    assert.deepEqual([next.release, next.next.step, next.next.closing], ['Toolshed', 'close', '0.10.0'], JSON.stringify(next));
    assert.equal(send(dir, { version: '0.11.0', defer: ['CAT-02'] }).reason, 'not-closing');
    const r = run(dir, 'close');
    assert.deepEqual([r.ok, r.version, r.finished], [true, '0.10.0', true], JSON.stringify(r));
    assert.deepEqual(readdirSync(join(releasesDir(agile(dir)), '0.10.0')).sort(), MOVED);
    assert.deepEqual(readdirSync(releasesDir(agile(dir))), ['0.10.0']);
    assert.equal(run(dir, 'next').release, null);
  }
});

test('a close stopped after the deferred ones moved reads them deferred and asks only the version', (t) => {
  const { dir } = finished(t);
  const file = join(agile(dir), 'REQUIREMENTS.md');
  const text = readFileSync(file, 'utf8');
  const line = text.match(/^- \*\*CAT-02\*\*: .*$/m)[0];
  writeFileSync(file, text.replace(`${line}\n`, '').replace('## Deferred\n\nNone.', `## Deferred\n\n${line}`));
  assert.equal(run(dir, 'next').next.requirements.find((q) => q.id === 'CAT-02').status, 'deferred');
  assert.equal(send(dir, { version: '0.10.0', defer: ['CAT-02'] }).reason, 'close-refused');
  assert.equal(send(dir, { version: '0.10.0' }).ok, true);
});

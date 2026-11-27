// Zero-dep tests for agile.mjs next - what the project's agile release does next, read from its files and changing none.
// Run: node --test tests/agile-next.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerSetup, scratch } from './planning.test.mjs';
import { markAgile, statePath } from '../cadence-core/bin/lib/project-state.mjs';
import { epicFile, releaseFile, storyFile } from '../cadence-core/bin/lib/agile-paths.mjs';
import { readEpicFile } from '../cadence-core/bin/lib/agile-read.mjs';
import { renderStoryFile } from '../cadence-core/bin/lib/agile-render.mjs';

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
  const dir = answerSetup(planning(t));
  const first = { id: 'E-01', name: 'Catalog', status: 'backlog', step: 'refine' };
  assert.deepEqual(run(dir, 'start', '--design', FIXTURE).next, first);
  const before = tree(dir);
  assert.deepEqual(run(dir, 'next'), { ok: true, release: 'Toolshed', next: first, _exit: 0 });
  assert.deepEqual(tree(dir), before);
  status(dir, 'E-01', 'done');
  assert.deepEqual(run(dir, 'next').next, { id: 'E-02', name: 'Lending', status: 'backlog', step: 'refine' });
  status(dir, 'E-02', 'review');
  assert.deepEqual(run(dir, 'next').next, { id: 'E-02', name: 'Lending', status: 'review', step: 'accept' });
  status(dir, 'E-02', 'done');
  status(dir, 'E-03', 'done');
  // every epic done is the close, and with no story on any of them nothing is done
  const close = run(dir, 'next');
  assert.equal(close.next.step, 'close');
  assert.deepEqual([...new Set(close.next.requirements.map((q) => q.status))], ['open']);
  assert.deepEqual(tree(dir).filter(([p]) => !p.startsWith('agile/epics')), before.filter(([p]) => !p.startsWith('agile/epics')));
});

/** A release whose every epic is accepted, each with one done story carrying all its requirements. */
function finished(t) {
  const dir = answerSetup(planning(t));
  assert.equal(run(dir, 'start', '--design', FIXTURE).ok, true);
  for (const id of ['E-01', 'E-02', 'E-03']) {
    status(dir, id, 'done');
    const requirements = readEpicFile(readFileSync(epicFile(agile(dir), id), 'utf8')).requirements;
    writeFileSync(storyFile(agile(dir), `${id}-1`), renderStoryFile({ id: `${id}-1`, title: `All of ${id}`, size: 'S', status: 'done', builds_on: [],
      requirements, delivers: 'Everything the epic asks.', accepted_when: ['Running it shows it.'] }));
  }
  return dir;
}
const statuses = (dir) => Object.fromEntries(run(dir, 'next').next.requirements.map((q) => [q.id, q.status]));

test('once every epic is done, next answers close with each requirement done, deferred or open, and writes nothing', (t) => {
  const dir = finished(t);
  const before = tree(dir);
  const r = run(dir, 'next');
  assert.equal(r.next.step, 'close');
  const requirements = readFileSync(join(agile(dir), 'REQUIREMENTS.md'), 'utf8').match(/^- \*\*[^*]+\*\*/gm).map((l) => l.slice(4, -2));
  assert.deepEqual(r.next.requirements.map((q) => [q.id, q.status]), requirements.map((id) => [id, 'done']));
  assert.deepEqual(r.next.requirements[0], { id: 'CAT-01', text: r.next.requirements[0].text, status: 'done', stories: ['E-01-1'] });
  assert.deepEqual(tree(dir), before);
  // one under Deferred is deferred, one on no story and one on a story not done are open, though their epics read done
  const file = join(agile(dir), 'REQUIREMENTS.md');
  const text = readFileSync(file, 'utf8');
  const line = text.match(/^- \*\*LOAN-02\*\*: .*$/m)[0];
  writeFileSync(file, text.replace(`${line}\n`, '').replace('## Deferred\n\nNone.', `## Deferred\n\n${line}`));
  const story = storyFile(agile(dir), 'E-01-1');
  writeFileSync(story, readFileSync(story, 'utf8').replace('requirements: CAT-01, CAT-02', 'requirements: CAT-01'));
  const e3 = storyFile(agile(dir), 'E-03-1');
  writeFileSync(e3, readFileSync(e3, 'utf8').replace('status: done', 'status: in-progress'));
  const got = statuses(dir);
  assert.equal(got['LOAN-02'], 'deferred');
  assert.equal(got['CAT-02'], 'open');
  for (const id of readEpicFile(readFileSync(epicFile(agile(dir), 'E-03'), 'utf8')).requirements) assert.equal(got[id], 'open', id);
  assert.equal(got['CAT-01'], 'done');
});

test('a requirements file the close can\'t count whole, or an ID it lists nowhere, is refused naming the file', (t) => {
  const file = (dir) => join(agile(dir), 'REQUIREMENTS.md');
  const story = (dir) => storyFile(agile(dir), 'E-02-1');
  for (const [damage, words] of [
    [(dir) => writeFileSync(file(dir), readFileSync(file(dir), 'utf8').replace(/^# Requirements: .*\n/, '')), /REQUIREMENTS\.md does not hold only its writer's lines/],
    [(dir) => writeFileSync(file(dir), readFileSync(file(dir), 'utf8').replace('## Requirements', '## Requirement')), /REQUIREMENTS\.md does not hold only its writer's lines/],
    [(dir) => writeFileSync(file(dir), readFileSync(file(dir), 'utf8').replace('- **LOAN-01**', '  - **LOAN-01**')), /REQUIREMENTS\.md does not hold only its writer's lines/],
    [(dir) => writeFileSync(story(dir), readFileSync(story(dir), 'utf8').replace(/^requirements: (.*)$/m, 'requirements: $1, ZZZ-09')), /E-02-1\.md names ZZZ-09, which .*REQUIREMENTS\.md lists nowhere/],
    [(dir) => { const e = epicFile(agile(dir), 'E-03'); writeFileSync(e, readFileSync(e, 'utf8').replace(/^requirements: (.*)$/m, 'requirements: $1, ZZZ-09')); }, /E-03\/epic\.md names ZZZ-09/],
  ]) {
    const dir = finished(t);
    damage(dir);
    const before = tree(dir);
    const r = run(dir, 'next');
    assert.equal(r.reason, 'release-damaged', JSON.stringify(r));
    assert.match(r.detail, words);
    assert.deepEqual(tree(dir), before);
  }
});


test('next refuses an old-path project as a start does, and changes nothing in it', (t) => {
  const dir = planning(t);
  mkdirSync(dir);
  writeFileSync(join(dir, 'PROJECT.md'), '# Old\n');
  const before = tree(dir);
  const r = run(dir, 'next');
  assert.deepEqual([r.ok, r.reason, r._exit], [false, 'old-path', 1]);
  assert.match(r.hint, /\/cad-progress once/);
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
    assert.equal(run(answerSetup(dir), 'start', '--design', FIXTURE).ok, true);
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
    assert.equal(run(answerSetup(dir), 'start', '--design', FIXTURE).ok, true);
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

test('the reports name the close and show each requirement still open', () => {
  const workflow = (name) => readFileSync(join(HERE, '..', 'cadence-core', 'workflows', name), 'utf8').replace(/\s+/g, ' ');
  assert.ok(workflow('agile-close.md').includes('Show `Requirements: {N} done, {N} deferred, {N} open` from `next.requirements`, then `Open: {id}: {text}` for each one open'));
  for (const name of ['agile-close.md', 'agile-accept.md']) assert.ok(workflow(name).includes('"Next: close the release, with /cad-agile"'), name);
});

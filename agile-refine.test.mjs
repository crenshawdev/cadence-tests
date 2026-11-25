// Zero-dep tests for agile.mjs refine - an epic's approved stories written whole, or refused with nothing written.
// Run: node --test tests/agile-refine.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerSetup, scratch } from './planning.test.mjs';
import { epicFile, storyFile } from '../cadence-core/bin/lib/agile-paths.mjs';
import { readStoryFile } from '../cadence-core/bin/lib/agile-read.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGILE = join(HERE, '..', 'cadence-core', 'bin', 'agile.mjs');
const FIXTURE = join(HERE, 'fixtures', 'seldon-design');

const run = (dir, ...args) => {
  const r = spawnSync('node', [AGILE, ...args, '--dir', dir], { encoding: 'utf8' });
  return { ...JSON.parse(r.stdout), _exit: r.status };
};
const agile = (dir) => join(dir, 'agile');
const folder = (dir, epic = 'E-01') => dirname(epicFile(agile(dir), epic));
const tree = (root) => readdirSync(root, { recursive: true }).map(String).sort()
  .map((p) => [p, statSync(join(root, p)).mtimeMs, statSync(join(root, p)).isFile() ? readFileSync(join(root, p), 'utf8') : '']);
const edit = (file, from, to) => writeFileSync(file, readFileSync(file, 'utf8').replace(from, to));
const status = (file, word) => edit(file, /^status: .*$/m, `status: ${word}`);

/** A started release: E-01 names CAT-01 and CAT-02, E-02 builds on it. */
function started(t) {
  const dir = answerSetup(join(scratch('cad-agile-refine-', t), '.planning'));
  assert.equal(run(dir, 'start', '--design', FIXTURE).ok, true);
  return dir;
}

const story = (over = {}) => ({ title: 'Add a tool', size: 'S', builds_on: [], requirements: ['CAT-01'],
  delivers: 'A volunteer adds a tool with a name, a category and a photo.', accepted_when: ['Adding a tool with a photo shows it in the list.'], ...over });
const list = () => ({ decisions: ['Photos are kept on disk beside the database.'], stories: [story(),
  story({ title: 'Search: by name or category', size: 'M', builds_on: ['E-01-1'], requirements: ['CAT-02', 'CAT-01'], accepted_when: ['Searching "drill" finds it.', 'A category lists its tools.'] })] });
function refine(dir, payload, epic = 'E-01') {
  const file = join(scratch('cad-agile-payload-'), 'payload.json');
  writeFileSync(file, typeof payload === 'string' ? payload : JSON.stringify({ epic, ...payload }));
  return run(dir, 'refine', '--payload', file);
}

test('an approved list is written as stories that read back, turns the epic and adds its decisions, and touches nothing else', (t) => {
  const dir = started(t);
  const others = () => tree(dir).filter(([p]) => !p.startsWith('agile/epics/E-01'));
  const before = others();
  const epic = readFileSync(epicFile(agile(dir), 'E-01'), 'utf8');
  const r = refine(dir, list());
  const first = { id: 'E-01-1', title: 'Add a tool', size: 'S', status: 'backlog' };
  const next = { id: 'E-01', name: 'Catalog', status: 'in-progress', step: 'build', story: first };
  assert.deepEqual(r, { ok: true, release: 'Toolshed', epic: 'E-01', stories: [{ id: 'E-01-1', title: 'Add a tool', size: 'S' },
    { id: 'E-01-2', title: 'Search: by name or category', size: 'M' }], next, _exit: 0 });
  assert.deepEqual(readdirSync(folder(dir)).sort(), ['E-01-1.md', 'E-01-2.md', 'epic.md']);
  list().stories.forEach((s, i) => assert.deepEqual(readStoryFile(readFileSync(storyFile(agile(dir), `E-01-${i + 1}`), 'utf8')),
    { id: `E-01-${i + 1}`, title: s.title, size: s.size, status: 'backlog', builds_on: s.builds_on, requirements: s.requirements, delivers: s.delivers, accepted_when: s.accepted_when }));
  // an S is built without a written plan
  assert.deepEqual([1, 2].map((n) => /^## Plan$/m.test(readFileSync(storyFile(agile(dir), `E-01-${n}`), 'utf8'))), [false, true]);
  assert.equal(readFileSync(epicFile(agile(dir), 'E-01'), 'utf8'),
    epic.replace('status: backlog', 'status: in-progress').replace('## Decisions\n\nNone yet.\n', '## Decisions\n\n- Photos are kept on disk beside the database.\n'));
  assert.deepEqual(others(), before);
  assert.deepEqual(run(dir, 'next').next, next);
});

test('decisions go under what the epic already holds, and an epic with none says so', (t) => {
  const dir = started(t);
  edit(epicFile(agile(dir), 'E-01'), 'None yet.', '- The counter comes first.');
  writeFileSync(epicFile(agile(dir), 'E-01'), `${readFileSync(epicFile(agile(dir), 'E-01'), 'utf8')}\n## Notes\n\nMine.\n`);
  assert.equal(refine(dir, list()).ok, true);
  const text = readFileSync(epicFile(agile(dir), 'E-01'), 'utf8');
  assert.ok(text.endsWith('## Decisions\n\n- The counter comes first.\n- Photos are kept on disk beside the database.\n\n## Notes\n\nMine.\n'), text);
  const none = started(t);
  assert.equal(refine(none, { ...list(), decisions: [] }).ok, true);
  assert.ok(readFileSync(epicFile(agile(none), 'E-01'), 'utf8').endsWith('## Decisions\n\nNone yet.\n'));
});

test('an epic file with Windows line endings keeps them, and every line but its status and decisions', (t) => {
  const dir = started(t);
  const file = epicFile(agile(dir), 'E-01');
  const text = readFileSync(file, 'utf8').replace('## Done when', '```sql\nselect 1\n```\n\n## Done when').replaceAll('\n', '\r\n');
  writeFileSync(file, text);
  assert.equal(refine(dir, list()).ok, true);
  assert.equal(readFileSync(file, 'utf8'), text.replace('status: backlog', 'status: in-progress')
    .replace('## Decisions\r\n\r\nNone yet.', '## Decisions\r\n\r\n- Photos are kept on disk beside the database.'));
});

test('a list that breaks a rule is refused naming the story and the field, with nothing written', (t) => {
  const dir = started(t);
  const before = tree(dir);
  const one = (over) => ({ decisions: [], stories: [story({ requirements: ['CAT-01', 'CAT-02'], ...over })] });
  /** @type {[string, unknown, string | undefined, string, RegExp][]} */
  const cases = [
    ['a requirement on no story', { decisions: [], stories: [story()] }, undefined, 'requirements', /CAT-02 is on no story/],
    ['an L', one({ size: 'L' }), 'E-01-1', 'size', /never built/],
    ['a size that is not one', one({ size: 'XS' }), 'E-01-1', 'size', /S or M/],
    ['a story that builds on a later one', { decisions: [], stories: [story({ builds_on: ['E-01-2'] }), story({ requirements: ['CAT-02'] })] }, 'E-01-1', 'builds_on', /E-01-2/],
    ['a story that builds on itself', one({ builds_on: ['E-01-1'] }), 'E-01-1', 'builds_on', /E-01-1/],
    ['a story that builds on a later epic', one({ builds_on: ['E-02'] }), 'E-01-1', 'builds_on', /E-02/],
    ['another epic\'s requirement', one({ requirements: ['CAT-01', 'CAT-02', 'LOAN-01'] }), 'E-01-1', 'requirements', /LOAN-01/],
    ['no requirement', { decisions: [], stories: [story({ requirements: ['CAT-01', 'CAT-02'] }), story({ requirements: [] })] }, 'E-01-2', 'requirements', /at least one/],
    ['no check', one({ accepted_when: [] }), 'E-01-1', 'accepted_when', /at least one/],
    ['a check on two lines', one({ accepted_when: ['a\nb'] }), 'E-01-1', 'accepted_when', /one line/],
    ['a title on two lines', one({ title: 'a\nstatus: done' }), 'E-01-1', 'title', /one line/],
    ['no delivers', one({ delivers: ' ' }), 'E-01-1', 'delivers', /one line/],
    ['delivers that reads as a heading', one({ delivers: '## Result' }), 'E-01-1', 'stories', /read back/],
    ['half an emoji', one({ delivers: 'x \ud83d y' }), 'E-01-1', 'delivers', /one line/],
    ['no epic', { epic: undefined, ...one({}) }, undefined, 'epic', /E-01/],
    ['delivers that opens a fence', one({ delivers: '```' }), 'E-01-1', 'stories', /read back/],
    ['a field that is not one', one({ plan: 'x' }), 'E-01-1', 'plan', /not a story's field/],
    ['a story that is not one', { decisions: [], stories: [story({ requirements: ['CAT-01', 'CAT-02'] }), 'x'] }, 'E-01-2', 'stories', /not a story/],
    ['no story', { decisions: [], stories: [] }, undefined, 'stories', /at least one/],
    ['a decision on two lines', { ...one({}), decisions: ['a\n## Result'] }, undefined, 'decisions', /one line/],
    ['a payload field that is not one', { ...one({}), notes: 'x' }, undefined, 'notes', /not a field/],
  ];
  for (const [name, payload, id, field, problem] of cases) {
    const r = refine(dir, payload);
    assert.deepEqual([r.ok, r.reason, r._exit], [false, 'stories-refused', 1], `${name}: ${JSON.stringify(r)}`);
    assert.ok(r.issues.some((i) => i.story === id && i.field === field && problem.test(i.problem)), `${name}: ${JSON.stringify(r.issues)}`);
    assert.match(r.hint, /nothing was written/, name);
    assert.deepEqual(tree(dir), before, name);
  }
});

test('a later epic\'s story may build on an earlier epic and on its stories', (t) => {
  const dir = started(t);
  assert.equal(refine(dir, list()).ok, true);
  for (const n of [1, 2]) status(storyFile(agile(dir), `E-01-${n}`), 'done');
  status(epicFile(agile(dir), 'E-01'), 'done');
  const wanted = /^requirements: (.*)$/m.exec(readFileSync(epicFile(agile(dir), 'E-02'), 'utf8'))[1].split(', ');
  const r = refine(dir, { decisions: [], stories: [story({ requirements: wanted, builds_on: ['E-01', 'E-01-2'] })] }, 'E-02');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.stories[0].id, 'E-02-1');
});

test('a refinement killed before its epic turned is finished by the next, which leaves only its own list', (t) => {
  const dir = started(t);
  assert.equal(refine(dir, { decisions: [], stories: [...list().stories, story({ title: 'A third' })] }).ok, true);
  // where the dead run stopped: its three stories are there, the epic hasn't turned, and two writes were in the air
  status(epicFile(agile(dir), 'E-01'), 'backlog');
  writeFileSync(storyFile(agile(dir), 'E-01-2'), '');
  for (const name of ['E-01-3.md.4242.2.tmp', 'epic.md.4242.3.tmp', 'E-01-9.md']) {
    writeFileSync(join(folder(dir), name), name.endsWith('.tmp') ? 'half' : readFileSync(storyFile(agile(dir), 'E-01-3'), 'utf8').replaceAll('E-01-3', 'E-01-9'));
  }
  writeFileSync(join(folder(dir), 'notes.md'), 'mine\n');
  assert.deepEqual(run(dir, 'next').next.step, 'refine');
  assert.equal(refine(dir, list()).ok, true);
  assert.deepEqual(readdirSync(folder(dir)).sort(), ['E-01-1.md', 'E-01-2.md', 'epic.md', 'notes.md']);
  assert.equal(run(dir, 'next').next.story.id, 'E-01-1');
});

test('refine takes only the epic the release is up to, and leaves one already begun alone', (t) => {
  const dir = started(t);
  const refused = (r, reason, detail) => {
    assert.deepEqual([r.ok, r.reason, r._exit], [false, reason, 1], JSON.stringify(r));
    assert.match(r.detail, detail);
    assert.ok(r.hint);
  };
  const unchanged = (call) => { const before = tree(dir); call(); assert.deepEqual(tree(dir), before); };
  unchanged(() => refused(refine(dir, list(), 'E-02'), 'not-refinable', /E-02.*E-01/));
  for (const payload of ['null', '[]', '"E-01"']) unchanged(() => refused(refine(dir, payload), 'stories-refused', /E-01/));
  unchanged(() => refused(refine(dir, 'not json'), 'bad-payload', /./));
  unchanged(() => refused(run(dir, 'refine', '--payload', join(dir, 'nowhere.json')), 'no-payload', /nowhere/));
  edit(epicFile(agile(dir), 'E-01'), '## Decisions', '## Picked');
  unchanged(() => refused(refine(dir, list()), 'release-damaged', /Decisions/));
  edit(epicFile(agile(dir), 'E-01'), '## Picked', '## Decisions');
  assert.equal(refine(dir, list()).ok, true);
  unchanged(() => refused(refine(dir, list()), 'not-refinable', /build E-01-1/));
  status(storyFile(agile(dir), 'E-01-1'), 'done');
  status(epicFile(agile(dir), 'E-01'), 'backlog');
  unchanged(() => refused(refine(dir, list()), 'stories-begun', /E-01-1 is done/));
  const none = join(scratch('cad-agile-none-', t), '.planning');
  refused(refine(none, list()), 'not-refinable', /start a release/);
  mkdirSync(none);
  writeFileSync(join(none, 'PROJECT.md'), '# Old\n');
  refused(refine(none, list()), 'old-path', /PROJECT/);
});

test('next is the first story not done in number order, then the epic\'s acceptance', (t) => {
  const dir = started(t);
  assert.equal(refine(dir, list()).ok, true);
  const step = () => { const { next } = run(dir, 'next'); return [next.step, next.story?.id, next.story?.status]; };
  status(storyFile(agile(dir), 'E-01-1'), 'in-progress');
  assert.deepEqual(step(), ['build', 'E-01-1', 'in-progress']);
  status(storyFile(agile(dir), 'E-01-1'), 'done');
  assert.deepEqual(step(), ['build', 'E-01-2', 'backlog']);
  // ten sorts after two
  writeFileSync(storyFile(agile(dir), 'E-01-10'), readFileSync(storyFile(agile(dir), 'E-01-2'), 'utf8').replaceAll('E-01-2', 'E-01-10'));
  assert.deepEqual(step(), ['build', 'E-01-2', 'backlog']);
  for (const n of [2, 10]) status(storyFile(agile(dir), `E-01-${n}`), 'done');
  assert.deepEqual(step(), ['accept', undefined, undefined]);
});

test('an epic in progress whose stories don\'t read back is refused naming the file, and no story is skipped over', (t) => {
  /** @type {[string, (file: string) => void, RegExp][]} */
  const breaks = [
    ['a status that is not one', (f) => status(f, 'started'), /E-01-1\.md/],
    ['a size that is not one', (f) => edit(f, 'size: S', 'size: XL'), /E-01-1\.md/],
    ['another story\'s ID', (f) => edit(f, 'story: E-01-1', 'story: E-01-7'), /E-01-1\.md/],
    ['no checks', (f) => edit(f, '## Accepted when', '## Accepted'), /E-01-1\.md/],
    ['no result', (f) => edit(f, '## Result', '## Outcome'), /E-01-1\.md/],
    ['a field twice', (f) => edit(f, 'status: backlog', 'status: backlog\nstatus: done'), /E-01-1\.md/],
    ['no story left', (f) => { rmSync(f); rmSync(f.replace('E-01-1.md', 'E-01-2.md')); }, /holds no story/],
  ];
  for (const [name, spoil, detail] of breaks) {
    const dir = started(t);
    assert.equal(refine(dir, list()).ok, true);
    spoil(storyFile(agile(dir), 'E-01-1'));
    const before = tree(dir);
    const r = run(dir, 'next');
    assert.deepEqual([r.ok, r.reason, r._exit], [false, 'release-damaged', 1], name);
    assert.match(r.detail, detail, name);
    assert.deepEqual(tree(dir), before, name);
  }
});

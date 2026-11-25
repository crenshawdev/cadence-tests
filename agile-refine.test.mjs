// Zero-dep tests for agile.mjs refine - an epic's approved stories written whole, or refused with nothing written.
// Run: node --test tests/agile-refine.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerSetup, scratch } from './planning.test.mjs';
import { agileBacklogFile, epicFile, requirementsFile, storyFile } from '../cadence-core/bin/lib/agile-paths.mjs';
import { readEpicFile, readStoryFile } from '../cadence-core/bin/lib/agile-read.mjs';

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
function send(dir, call, payload, epic = 'E-01') {
  const file = join(dirname(dir), 'payload.json');
  writeFileSync(file, typeof payload === 'string' ? payload : JSON.stringify({ epic, ...payload }));
  return run(dir, call, '--payload', file);
}
const refine = (dir, payload, epic) => send(dir, 'refine', payload, epic);
const decisions = (dir, epic = 'E-01') => readFileSync(epicFile(agile(dir), epic), 'utf8').split('## Decisions\n\n')[1];

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
    for (const call of ['propose', 'refine']) {
      const r = send(dir, call, payload);
      assert.deepEqual([r.ok, r.reason, r._exit], [false, 'stories-refused', 1], `${name}: ${JSON.stringify(r)}`);
      assert.ok(r.issues.some((i) => i.story === id && i.field === field && problem.test(i.problem)), `${name}: ${JSON.stringify(r.issues)}`);
      assert.match(r.hint, /nothing was written/, name);
      assert.deepEqual(tree(dir), before, name);
    }
  }
});

test('propose answers what refine would name, and writes nothing', (t) => {
  const dir = started(t);
  const before = tree(dir);
  const r = send(dir, 'propose', list());
  assert.deepEqual(tree(dir), before);
  assert.deepEqual(r, { ok: true, epic: 'E-01', stories: refine(dir, list()).stories, _exit: 0 });
});

test('an answer is saved under its question as it\'s given, over an earlier one, and the picks go under it', (t) => {
  const dir = started(t);
  const others = () => tree(dir).filter(([p]) => !p.startsWith('agile/epics/E-01'));
  const before = others();
  const epic = readFileSync(epicFile(agile(dir), 'E-01'), 'utf8');
  const save = (...answers) => send(dir, 'answer', { answers });
  assert.deepEqual(save({ question: 'Where do photos go?', answer: 'On disk' }, { question: 'Who adds a tool?', answer: 'Any volunteer' }), { ok: true, epic: 'E-01', saved: 2, _exit: 0 });
  assert.equal(save({ question: 'Where do photos go?', answer: 'In the database' }).ok, true);
  assert.equal(decisions(dir), '- **Where do photos go?** In the database\n- **Who adds a tool?** Any volunteer\n');
  assert.equal(readFileSync(epicFile(agile(dir), 'E-01'), 'utf8').split('## Decisions')[0], epic.split('## Decisions')[0]);
  assert.deepEqual(others(), before);
  assert.equal(run(dir, 'next').next.step, 'refine');
  assert.equal(refine(dir, list()).ok, true);
  assert.equal(decisions(dir), '- **Where do photos go?** In the database\n- **Who adds a tool?** Any volunteer\n- Photos are kept on disk beside the database.\n');
});

test('answers that can\'t be saved are refused with nothing written', (t) => {
  const dir = started(t);
  const before = tree(dir);
  const good = { question: 'Q?', answer: 'A' };
  for (const answers of [[], 'x', ['x'], [{ question: 'Q?' }], [{ ...good, answer: 'a\n## Result' }], [{ ...good, why: 'x' }], [good, null], [good, { ...good, answer: 'B' }], [{ ...good, question: 'Which **/ paths?' }]]) {
    const r = send(dir, 'answer', { answers });
    assert.deepEqual([r.ok, r.reason, r._exit], [false, 'answers-refused', 1], JSON.stringify(answers));
    assert.ok(r.issues.some((i) => i.field === 'answers'), JSON.stringify(r));
  }
  assert.equal(send(dir, 'answer', { answers: [good], notes: 'x' }).issues[0].field, 'notes');
  assert.equal(send(dir, 'answer', { answers: [good] }, 'E-02').reason, 'not-refinable');
  assert.deepEqual(tree(dir), before);
  assert.equal(refine(dir, list()).ok, true);
  const after = tree(dir);
  for (const call of ['answer', 'propose']) assert.equal(send(dir, call, { ...list(), answers: [good] }).reason, 'not-refinable');
  assert.deepEqual(tree(dir), after);
});

test('the backlog items a list takes are gone once it\'s written, and one that isn\'t there is refused', (t) => {
  const dir = started(t);
  const file = agileBacklogFile(agile(dir));
  const text = '## Todos\n\n- [ ] search by photo\n- [ ] print a label\n  on the counter printer\n\n  one per drill\n- [ ] tab\there\n\n## Seeds\n\n- lend to other libraries\n';
  writeFileSync(file, text);
  const taking = (...backlog) => ({ ...list(), backlog });
  for (const line of ['- [ ] print labels', '  on the counter printer', '## Seeds', '- [ ] search']) {
    const r = refine(dir, taking(line));
    assert.deepEqual([r.reason, r.issues[0].field], ['stories-refused', 'backlog'], line);
    assert.equal(readFileSync(file, 'utf8'), text);
  }
  assert.equal(send(dir, 'propose', taking('- [ ] print a label')).ok, true);
  assert.equal(readFileSync(file, 'utf8'), text);
  assert.equal(refine(dir, taking('- [ ] print a label', '- lend to other libraries', '- [ ] tab\there')).ok, true);
  assert.equal(readFileSync(file, 'utf8'), '## Todos\n\n- [ ] search by photo\n\n## Seeds\n\n');
});

test('a backlog that can\'t be written leaves the stories standing and says which file still holds the items', (t) => {
  const dir = started(t);
  const file = agileBacklogFile(agile(dir));
  writeFileSync(file, '## Todos\n\n- [ ] print a label\n');
  // a live writer's lock, the one refusal a test can hold still
  writeFileSync(`${file}.lock`, '');
  const r = refine(dir, { ...list(), backlog: ['- [ ] print a label'] });
  assert.deepEqual([r.ok, r.next.step, r.warnings?.length], [true, 'build', 1], JSON.stringify(r));
  assert.ok(r.warnings[0].includes(file), r.warnings[0]);
  assert.equal(run(dir, 'next').next.story.id, 'E-01-1');
});

test('the refinement\'s commit holds its own files and no others, from the same lines the workflow gives', (t) => {
  const dir = started(t);
  const root = dirname(dir);
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b.c', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b.c' } });
  const prose = readFileSync(join(HERE, '..', 'cadence-core', 'workflows', 'agile-refine.md'), 'utf8');
  const block = /```\n(set -- [\s\S]*?git commit [^\n]*)\n```/.exec(prose)[1].replaceAll('{id}', 'E-01');
  const commit = () => {
    const r = spawnSync('sh', ['-c', block], { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b.c', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b.c' } });
    assert.equal(r.status, 0, r.stderr);
    return git('show', '--name-only', '--format=').stdout.trim().split('\n').map((p) => p.replace('.planning/agile/', ''));
  };
  const own = ['epics/E-01/E-01-1.md', 'epics/E-01/E-01-2.md', 'epics/E-01/epic.md'];
  const backlog = agileBacklogFile(agile(dir));
  writeFileSync(backlog, '## Todos\n\n- [ ] print a label\n- [ ] search by photo\n');
  git('init', '-q');
  git('add', '-A');
  assert.equal(git('commit', '-q', '-m', 'start').status, 0);
  writeFileSync(join(folder(dir), 'notes.md'), 'mine\n');
  writeFileSync(join(root, 'staged.txt'), 'mine\n');
  git('add', 'staged.txt', '.planning/agile/epics/E-01/notes.md');
  assert.equal(refine(dir, { ...list(), backlog: ['- [ ] print a label'] }).ok, true);
  assert.deepEqual(commit(), ['backlog.md', ...own]);
  assert.deepEqual(git('diff', '--cached', '--name-only').stdout.trim().split('\n'), ['.planning/agile/epics/E-01/notes.md', 'staged.txt']);
  // a capture not yet committed stays the user's, and a project with no backlog has none to name
  git('reset', '-q', '--soft', 'HEAD~1');
  git('reset', '-q');
  writeFileSync(backlog, '## Todos\n\n- [ ] search by photo\n- [ ] a new one\n');
  assert.deepEqual(commit(), own);
});

const asked = (dir) => readFileSync(requirementsFile(agile(dir)), 'utf8');
const LABEL = 'A volunteer prints a label for a tool.';
const labels = story({ title: 'Labels', requirements: ['CAT-03'] });

test('a deferred requirement moves under Deferred and off the epic and what its stories carry', (t) => {
  const dir = started(t);
  const only = { decisions: [], stories: [story()] };
  assert.match(JSON.stringify(send(dir, 'propose', only).issues), /CAT-02 is on no story/);
  const r = refine(dir, { ...only, defer: ['CAT-02'] });
  assert.equal(r.ok, true, JSON.stringify(r));
  const [held, deferred] = asked(dir).split('## Deferred\n\n');
  assert.doesNotMatch(held, /CAT-02/);
  assert.equal(deferred, '- **CAT-02**: A member searches the catalog by name or category.\n');
  assert.match(readFileSync(epicFile(agile(dir), 'E-01'), 'utf8'), /^requirements: CAT-01$/m);
});

test('an added requirement takes the next number of its prefix, deferred ones counted, and goes on the epic', (t) => {
  const dir = started(t);
  assert.match(JSON.stringify(send(dir, 'propose', { ...list(), add: [{ id: 'CAT-03', text: LABEL }] }).issues), /CAT-03 is on no story/);
  const r = refine(dir, { ...list(), add: [{ id: 'CAT-03', text: LABEL }], stories: [...list().stories, labels] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(asked(dir).includes(`category.\n- **CAT-03**: ${LABEL}\n\n### Loans`), asked(dir));
  assert.match(readFileSync(epicFile(agile(dir), 'E-01'), 'utf8'), /^requirements: CAT-01, CAT-02, CAT-03$/m);

  // a later epic counts a deferred one, and an added one whose prefix has none left gets a heading of its own
  const two = started(t);
  assert.equal(refine(two, { decisions: [], stories: [story()], defer: ['CAT-02'] }).ok, true);
  status(storyFile(agile(two), 'E-01-1'), 'done');
  status(epicFile(agile(two), 'E-01'), 'done');
  const wanted = ['LOAN-01', 'LOAN-02', 'NFR-01', 'NFR-02'];
  const carry = (...add) => ({ decisions: [], add, stories: [story({ requirements: [...wanted, ...add.map((a) => a.id)] })] });
  assert.match(JSON.stringify(send(two, 'propose', carry({ id: 'CAT-02', text: LABEL }), 'E-02').issues), /is CAT-02, and the next CAT is CAT-03/);
  assert.equal(refine(two, carry({ id: 'CAT-03', text: LABEL }, { id: 'CAT-04', text: 'A member sees who has a tool.' }), 'E-02').ok, true);
  assert.ok(asked(two).includes(`- **CAT-01**: A volunteer adds a tool with a name, a category and a photo. [ASSUMPTION]\n- **CAT-03**: ${LABEL}\n- **CAT-04**: A member sees who has a tool.\n\n### Loans`), asked(two));
  assert.match(readFileSync(epicFile(agile(two), 'E-02'), 'utf8'), /^requirements: LOAN-01, LOAN-02, NFR-01, NFR-02, CAT-03, CAT-04$/m);
  const three = started(t);
  assert.equal(refine(three, { decisions: [], defer: ['CAT-02'], add: [{ id: 'CAT-03', text: LABEL }], stories: [story({ requirements: ['CAT-01', 'CAT-03'] })] }).ok, true);
  assert.ok(asked(three).includes(`- **CAT-01**: A volunteer adds a tool with a name, a category and a photo. [ASSUMPTION]\n- **CAT-03**: ${LABEL}\n\n### Loans`), asked(three));
});

test('a defer or an add that can\'t be applied is refused with nothing written', (t) => {
  const dir = started(t);
  const all = [...list().stories, labels];
  /** @type {[string, Record<string, unknown>, string, RegExp][]} */
  const bad = [
    ['another epic\'s', { defer: ['LOAN-01'] }, 'defer', /names LOAN-01, which isn't one of the epic's/],
    ['not a list', { defer: 'CAT-02' }, 'defer', /is a list/],
    ['every one', { defer: ['CAT-01', 'CAT-02'], add: [] }, 'defer', /leaves the epic no requirement/],
    ['a number past the next', { add: [{ id: 'CAT-04', text: LABEL }] }, 'add', /is CAT-04, and the next CAT is CAT-03/],
    ['the next without its width', { add: [{ id: 'CAT-3', text: LABEL }] }, 'add', /the next CAT is CAT-03/],
    ['a prefix the file doesn\'t use', { add: [{ id: 'TAG-01', text: LABEL }] }, 'add', /no prefix REQUIREMENTS\.md uses/],
    ['one an epic already has', { add: [{ id: 'CAT-01', text: 'A volunteer adds a tool with a name, a category and a photo. [ASSUMPTION]' }] }, 'add', /is CAT-01, and the next CAT is CAT-03/],
    ['two lines', { add: [{ id: 'CAT-03', text: 'a\nb' }] }, 'add', /each on one line/],
    ['another field', { add: [{ id: 'CAT-03', text: LABEL, size: 'S' }] }, 'add', /"id" and a "text"/],
    ['given twice', { add: [{ id: 'CAT-03', text: LABEL }, { id: 'CAT-03', text: LABEL }] }, 'add', /given once/],
    ['not a list', { add: { id: 'CAT-03', text: LABEL } }, 'add', /is a list/],
  ];
  for (const [name, change, field, problem] of bad) {
    for (const call of ['propose', 'refine']) {
      const before = tree(dir);
      const r = send(dir, call, { decisions: [], stories: all, add: [{ id: 'CAT-03', text: LABEL }], ...change });
      assert.deepEqual([r.ok, r.reason], [false, 'stories-refused'], `${name}: ${JSON.stringify(r)}`);
      assert.ok(r.issues.some((i) => i.field === field && problem.test(i.problem)), `${name}: ${JSON.stringify(r.issues)}`);
      assert.deepEqual(tree(dir), before, name);
    }
  }
  // a line its writer wouldn't write blocks only a change to the ask, which would rewrite the file without it
  writeFileSync(requirementsFile(agile(dir)), asked(dir).replace('### Loans', '### '));
  assert.equal(send(dir, 'propose', { ...list(), defer: ['CAT-02'], stories: [story()] }).ok, true);
  writeFileSync(requirementsFile(agile(dir)), asked(dir).replace('## Deferred', 'A note of mine.\n\n## Deferred'));
  assert.equal(send(dir, 'propose', list()).ok, true);
  const before = tree(dir);
  const r = refine(dir, { ...list(), defer: ['CAT-02'], stories: [story()] });
  assert.deepEqual([r.ok, r.reason], [false, 'release-damaged'], JSON.stringify(r));
  assert.match(r.detail, /REQUIREMENTS\.md holds a line/);
  assert.deepEqual(tree(dir), before);
  assert.equal(refine(dir, list()).ok, true);
});

test('a #41 kind of ID is added at its next number, and one whose prefix has none left gets a heading of its own', (t) => {
  const dir = started(t);
  for (const file of [requirementsFile(agile(dir)), epicFile(agile(dir), 'E-01')]) edit(file, /CAT-0(\d)/g, '#4$1');
  assert.match(JSON.stringify(send(dir, 'propose', { ...list(), add: [{ id: '#44', text: LABEL }] }).issues), /is #44, and the next # is #43/);
  const stories = [story({ requirements: ['#41'] }), story({ title: 'Search', requirements: ['#42'] }), story({ title: 'Labels', requirements: ['#43'] })];
  assert.equal(refine(dir, { decisions: [], add: [{ id: '#43', text: LABEL }], stories }).ok, true);
  assert.ok(asked(dir).includes(`category.\n- **#43**: ${LABEL}\n\n### Loans`), asked(dir));

  const two = started(t);
  assert.equal(refine(two, list()).ok, true);
  const finish = (epic, n) => { for (let i = 1; i <= n; i++) status(storyFile(agile(two), `${epic}-${i}`), 'done'); status(epicFile(agile(two), epic), 'done'); };
  finish('E-01', 2);
  assert.equal(refine(two, { decisions: [], defer: ['NFR-01', 'NFR-02'], stories: [story({ requirements: ['LOAN-01', 'LOAN-02'] })] }, 'E-02').ok, true);
  finish('E-02', 1);
  assert.equal(refine(two, { decisions: [], add: [{ id: 'NFR-03', text: 'A reminder never shows a member\'s address.' }], stories: [story({ requirements: ['LOAN-03', 'NFR-03'] })] }, 'E-03').ok, true);
  assert.ok(asked(two).includes('- **LOAN-03**: A member gets an email reminder the day before a loan is due.\n\n### NFR\n\n- **NFR-03**: A reminder never shows a member\'s address.\n\n## Deferred'), asked(two));
});

test('a refinement killed after REQUIREMENTS.md and before its epic turned is finished by the same list', (t) => {
  const contents = (dir) => tree(agile(dir)).map(([p, , text]) => [p, text]);
  const payload = { decisions: [], defer: ['CAT-02'], add: [{ id: 'CAT-03', text: LABEL }], stories: [story(), labels] };
  const clean = started(t);
  assert.equal(refine(clean, payload).ok, true);
  const dir = started(t);
  const epic = readFileSync(epicFile(agile(dir), 'E-01'), 'utf8');
  assert.equal(refine(dir, payload).ok, true);
  // where the dead run stopped: the stories and REQUIREMENTS.md written, the epic as it was, and a write in the air
  writeFileSync(epicFile(agile(dir), 'E-01'), epic);
  writeFileSync(join(agile(dir), 'REQUIREMENTS.md.4242.7.tmp'), 'half');
  assert.equal(run(dir, 'next').next.step, 'refine');
  // the deferred one is off the epic, and the added one is on none, which propose lists
  const r = send(dir, 'propose', { decisions: [], stories: [story()] });
  assert.deepEqual([r.ok, r.unplaced], [true, [{ id: 'CAT-03', text: LABEL }]], JSON.stringify(r));
  assert.equal(refine(dir, payload).ok, true);
  assert.deepEqual(contents(dir), contents(clean));
});

test('the refinement\'s commit holds REQUIREMENTS.md only when the ask changed it, and a split\'s holds release.md and the rest', (t) => {
  const prose = readFileSync(join(HERE, '..', 'cadence-core', 'workflows', 'agile-refine.md'), 'utf8');
  const block = /```\n(set -- [\s\S]*?git commit [^\n]*)\n```/.exec(prose)[1].replaceAll('{id}', 'E-01');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b.c', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b.c' };
  for (const [payload, held, split] of [[list(), false, false], [{ decisions: [], stories: [story()], defer: ['CAT-02'] }, true, false], [cut(), false, true]]) {
    const dir = started(t);
    const root = dirname(dir);
    const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', env });
    git('init', '-q');
    // settings that change what git diff prints, which the check mustn't read through
    git('config', 'color.ui', 'always');
    git('config', 'diff.external', 'false');
    git('add', '-A');
    assert.equal(git('commit', '-q', '-m', 'start').status, 0);
    // the user's own edits, which only a change to the ask or a split takes along
    writeFileSync(requirementsFile(agile(dir)), asked(dir).replace('under three seconds', 'under two seconds'));
    edit(join(agile(dir), 'release.md'), 'under a minute', 'under two minutes');
    assert.equal(refine(dir, payload).ok, true);
    assert.equal(spawnSync('sh', ['-c', block], { cwd: root, encoding: 'utf8', env }).status, 0);
    const files = git('show', '--name-only', '--format=').stdout.trim().split('\n');
    assert.equal(files.includes('.planning/agile/REQUIREMENTS.md'), held, files.join(', '));
    assert.deepEqual(['.planning/agile/release.md', '.planning/agile/epics/E-04/epic.md'].map((f) => files.includes(f)), [split, split], files.join(', '));
  }
});

const E2E = 'Everything built so far, this epic included, works end to end, with every test passing and nothing half-built showing.';
const FIND = 'A member can find that tool by name or by category.';
const SEARCH = { name: 'Search', outcome: 'Members search the catalog from home.', requirements: ['CAT-02'], moves: [FIND], done_when: [E2E] };
const cut = (over = {}) => ({ decisions: [], split: { ...SEARCH, ...over }, stories: [story()] });
const epics = (dir) => readFileSync(join(agile(dir), 'release.md'), 'utf8').split('## Epics\n\n')[1].trim().split('\n');

test('a split makes the rest the next epic, every requirement on one of the two, and next reaches it after the first', (t) => {
  const dir = started(t);
  const first = readEpicFile(readFileSync(epicFile(agile(dir), 'E-01'), 'utf8'));
  const shown = [{ id: 'E-04', name: 'Search', requirements: ['CAT-02'], done_when: [FIND, E2E] }];
  assert.deepEqual(send(dir, 'propose', cut()).splits, shown);
  const r = refine(dir, cut());
  assert.deepEqual([r.ok, r.splits], [true, shown], JSON.stringify(r));
  assert.deepEqual(epics(dir), ['- E-01: Catalog', '- E-04: Search', '- E-02: Lending', '- E-03: Reminders']);
  const one = readEpicFile(readFileSync(epicFile(agile(dir), 'E-01'), 'utf8'));
  const rest = readFileSync(epicFile(agile(dir), 'E-04'), 'utf8');
  assert.deepEqual([one.requirements, one.done_when], [['CAT-01'], ['A volunteer can add a tool with a name, a category and a photo.', E2E]]);
  assert.ok(rest.startsWith('---\nepic: E-04\ntitle: Search\nstatus: backlog\nbuilds_on: E-01\nrequirements: CAT-02\nsplit_from: E-01\n---\n\n# E-04: Search\n'), rest);
  assert.deepEqual(readEpicFile(rest), { requirements: ['CAT-02'], title: 'Search', split_from: 'E-01', outcome: SEARCH.outcome,
    boundaries: first.boundaries, spine: first.spine, done_when: [FIND, E2E] });
  assert.ok(rest.endsWith('## Decisions\n\nNone yet.\n'));
  status(storyFile(agile(dir), 'E-01-1'), 'done');
  status(epicFile(agile(dir), 'E-01'), 'done');
  assert.deepEqual(run(dir, 'next').next, { id: 'E-04', name: 'Search', status: 'backlog', step: 'refine' });
  assert.equal(refine(dir, { decisions: [], stories: [story({ title: 'Search', requirements: ['CAT-02'], builds_on: ['E-01-1'] })] }, 'E-04').ok, true);
});

test('a split that can\'t be made is refused with nothing written', (t) => {
  const dir = started(t);
  /** @type {[string, Record<string, unknown>, RegExp][]} */
  const bad = [
    ['not an object', { split: 'Search' }, /is \{"name"/],
    ['another field', cut({ size: 'M' }), /holds size/],
    ['no name', cut({ name: '' }), /name is one line/],
    ['no requirement', cut({ requirements: [] }), /requirements is a list/],
    ['another epic\'s', cut({ requirements: ['LOAN-01'] }), /names LOAN-01, which isn't one of the epic's/],
    ['every one', { ...cut({ requirements: ['CAT-01', 'CAT-02'] }), stories: [story()] }, /takes every one/],
    ['one this refinement adds', { ...cut({ requirements: ['CAT-03'] }), add: [{ id: 'CAT-03', text: LABEL }], stories: [story({ requirements: ['CAT-01', 'CAT-02'] })] }, /which this refinement adds/],
    ['no line moved', cut({ moves: [] }), /moves is a list/],
    ['a line it doesn\'t hold', cut({ moves: ['A member can find it.'] }), /isn't one of the epic's Done when lines/],
    ['every line', cut({ moves: [FIND, E2E, 'A volunteer can add a tool with a name, a category and a photo.'], done_when: [] }), /takes every Done when line/],
    ['a moved line again', cut({ done_when: [FIND] }), /none of them in moves/],
    ['a heading for an outcome', cut({ outcome: '## Decisions' }), /would not read back/],
    ['a fence for an outcome', cut({ outcome: '```' }), /would not read back/],
  ];
  for (const [name, payload, problem] of bad) {
    for (const call of ['propose', 'refine']) {
      const before = tree(dir);
      const r = send(dir, call, payload);
      assert.deepEqual([r.ok, r.reason], [false, 'stories-refused'], `${name}: ${JSON.stringify(r)}`);
      assert.ok(r.issues.some((i) => i.field === 'split' && problem.test(i.problem)), `${name}: ${JSON.stringify(r.issues)}`);
      assert.deepEqual(tree(dir), before, name);
    }
  }
  // what leaves with the rest isn't this epic's to carry
  assert.match(JSON.stringify(send(dir, 'propose', { ...cut(), stories: [story({ requirements: ['CAT-01', 'CAT-02'] })] }).issues), /names CAT-02, which isn't one of the epic's/);
});

test('a split stopped before its epic turned is finished by the same list, and a list without it leaves the rest\'s requirements there', (t) => {
  const contents = (dir) => tree(agile(dir)).map(([p, , text]) => [p, text]);
  const clean = started(t);
  assert.equal(refine(clean, cut()).ok, true);
  for (const stop of ['the rest written', 'the rest listed']) {
    const dir = started(t);
    const epic = readFileSync(epicFile(agile(dir), 'E-01'), 'utf8');
    const release = readFileSync(join(agile(dir), 'release.md'), 'utf8');
    assert.equal(refine(dir, cut()).ok, true);
    writeFileSync(epicFile(agile(dir), 'E-01'), epic);
    if (stop === 'the rest written') writeFileSync(join(agile(dir), 'release.md'), release);
    writeFileSync(join(folder(dir, 'E-04'), 'epic.md.4242.1.tmp'), 'half');
    writeFileSync(join(agile(dir), 'release.md.4242.2.tmp'), 'half');
    assert.equal(run(dir, 'next').next.id, 'E-01', stop);
    assert.equal(refine(dir, cut()).ok, true, stop);
    assert.deepEqual(contents(dir), contents(clean), stop);
  }
  const dir = started(t);
  const epic = readFileSync(epicFile(agile(dir), 'E-01'), 'utf8');
  assert.equal(refine(dir, cut()).ok, true);
  writeFileSync(epicFile(agile(dir), 'E-01'), epic);
  const r = refine(dir, { decisions: [], stories: [story()] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(epics(dir), ['- E-01: Catalog', '- E-04: Search', '- E-02: Lending', '- E-03: Reminders']);
  assert.match(readFileSync(epicFile(agile(dir), 'E-01'), 'utf8'), /^requirements: CAT-01$/m);
  assert.match(r.warnings.join(), /E-04 was split off E-01 by a run cut short.*"A member can find that tool by name or by category\.".* - remove from E-01 the ones only E-04 needs/);
});

test('a stopped run\'s rest is shown before approval, and a finished split\'s rest is never written over', (t) => {
  const dir = started(t);
  const epic = readFileSync(epicFile(agile(dir), 'E-01'), 'utf8');
  assert.equal(refine(dir, cut()).ok, true);
  writeFileSync(epicFile(agile(dir), 'E-01'), epic);
  // a list that still carries what the rest took is told why it can't
  const refused = send(dir, 'propose', { decisions: [], stories: [story({ requirements: ['CAT-01', 'CAT-02'] })] });
  assert.ok(refused.issues.some((i) => /E-04 Search was split off E-01 by a run cut short and carries CAT-02/.test(i.problem)), JSON.stringify(refused.issues));
  const p = send(dir, 'propose', { decisions: [], stories: [story()] });
  assert.deepEqual(p.splits, [{ id: 'E-04', name: 'Search', requirements: ['CAT-02'], done_when: [FIND, E2E], cut_short: true }]);
  assert.match(p.warnings.join(), /remove from E-01 the ones only E-04 needs/);

  // refined whole, sent back to refinement and split again by the same name: a new rest, and the first keeps its own
  const two = started(t);
  const ADD = 'A volunteer marks a tool broken.';
  assert.equal(refine(two, { ...cut(), add: [{ id: 'CAT-03', text: ADD }], stories: [story({ requirements: ['CAT-01', 'CAT-03'] })] }).ok, true);
  const rest = readFileSync(epicFile(agile(two), 'E-04'), 'utf8');
  status(epicFile(agile(two), 'E-01'), 'backlog');
  const again = cut({ requirements: ['CAT-03'], moves: ['A volunteer can add a tool with a name, a category and a photo.'], done_when: [] });
  const r = refine(two, { ...again, stories: [story()] });
  assert.deepEqual([r.ok, r.splits?.[0].id], [true, 'E-05'], JSON.stringify(r));
  assert.equal(readFileSync(epicFile(agile(two), 'E-04'), 'utf8'), rest);
  const lines = ['E-01', 'E-04', 'E-05'].map((id) => readEpicFile(readFileSync(epicFile(agile(two), id), 'utf8')).requirements);
  assert.deepEqual(lines, [['CAT-01'], ['CAT-02'], ['CAT-03']]);
});

test('a Done when line written with a trailing space or a star moves like any other', (t) => {
  const dir = started(t);
  edit(epicFile(agile(dir), 'E-01'), `- ${FIND}`, `* ${FIND} `);
  assert.equal(refine(dir, cut()).ok, true);
  assert.deepEqual(readEpicFile(readFileSync(epicFile(agile(dir), 'E-01'), 'utf8')).done_when, ['A volunteer can add a tool with a name, a category and a photo.', E2E]);
});

const toL = (dir, id) => edit(storyFile(agile(dir), id), /^size: .*$/m, 'size: L');
const halves = () => ({ decisions: [], stories: [story({ title: 'Search by name', requirements: ['CAT-02'], builds_on: ['E-01-1'] }),
  story({ title: 'Search by category', requirements: ['CAT-02'], builds_on: ['E-01-3'] })] });
/** A refined E-01 whose first story is done and whose second is an L. */
function withL(t) {
  const dir = started(t);
  assert.equal(refine(dir, list()).ok, true);
  status(storyFile(agile(dir), 'E-01-1'), 'done');
  toL(dir, 'E-01-2');
  return dir;
}

test('an epic holding an L is cut again: done stories keep their bytes, and the new list numbers past every ID used', (t) => {
  const dir = withL(t);
  const done = readFileSync(storyFile(agile(dir), 'E-01-1'), 'utf8');
  assert.deepEqual(run(dir, 'next').next, { id: 'E-01', name: 'Catalog', status: 'in-progress', step: 'refine', first: 'E-01-3' });
  // what the done story carries counts, and what the L carried has to be carried again
  assert.match(JSON.stringify(send(dir, 'propose', { decisions: [], stories: [story()] }).issues), /CAT-02 is on no story/);
  const p = send(dir, 'propose', halves());
  assert.deepEqual([p.ok, p.stories.map((s) => s.id), p.replaces], [true, ['E-01-3', 'E-01-4'], ['E-01-2']], JSON.stringify(p));
  const r = refine(dir, halves());
  assert.deepEqual([r.ok, r.next.story.id, 'first' in r.next], [true, 'E-01-3', false], JSON.stringify(r));
  assert.deepEqual(readdirSync(folder(dir)).sort(), ['E-01-1.md', 'E-01-3.md', 'E-01-4.md', 'epic.md']);
  assert.equal(readFileSync(storyFile(agile(dir), 'E-01-1'), 'utf8'), done);
  assert.match(decisions(dir), /^- Cut again: E-01-2 became E-01-3 to E-01-4\.$/m);
  assert.equal(run(dir, 'next').next.story.id, 'E-01-3');
  // a story file gone by hand still counts as used, since the epic's own file names it
  toL(dir, 'E-01-3');
  rmSync(storyFile(agile(dir), 'E-01-4'));
  assert.equal(run(dir, 'next').next.first, 'E-01-5');
  assert.equal(refine(dir, { decisions: [], stories: [story({ title: 'Search', requirements: ['CAT-02'] })] }).ok, true);
  assert.deepEqual(readdirSync(folder(dir)).sort(), ['E-01-1.md', 'E-01-5.md', 'epic.md']);
  assert.equal(readFileSync(storyFile(agile(dir), 'E-01-1'), 'utf8'), done);
});

test('cut again, a story in progress or in review is refused with nothing written', (t) => {
  for (const word of ['in-progress', 'review']) {
    const dir = withL(t);
    status(storyFile(agile(dir), 'E-01-1'), word);
    const before = tree(dir);
    for (const call of ['propose', 'refine']) {
      const r = send(dir, call, halves());
      assert.deepEqual([r.ok, r.reason], [false, 'stories-begun'], JSON.stringify(r));
      assert.match(r.detail, new RegExp(`E-01-1 is ${word}`));
    }
    assert.deepEqual(tree(dir), before);
  }
});

test('cut again and stopped before the L was removed, the next run replaces both and numbers past them', (t) => {
  const dir = withL(t);
  const large = readFileSync(storyFile(agile(dir), 'E-01-2'), 'utf8');
  const done = readFileSync(storyFile(agile(dir), 'E-01-1'), 'utf8');
  assert.equal(refine(dir, halves()).ok, true);
  writeFileSync(storyFile(agile(dir), 'E-01-2'), large);
  assert.deepEqual(run(dir, 'next').next, { id: 'E-01', name: 'Catalog', status: 'in-progress', step: 'refine', first: 'E-01-5' });
  const again = { decisions: [], stories: [story({ title: 'Search by name', requirements: ['CAT-02'], builds_on: ['E-01-1'] }),
    story({ title: 'Search by category', requirements: ['CAT-02'], builds_on: ['E-01-5'] })] };
  assert.deepEqual(send(dir, 'propose', again).replaces, ['E-01-2', 'E-01-3', 'E-01-4']);
  assert.equal(refine(dir, again).ok, true);
  assert.deepEqual(readdirSync(folder(dir)).sort(), ['E-01-1.md', 'E-01-5.md', 'E-01-6.md', 'epic.md']);
  assert.equal(readFileSync(storyFile(agile(dir), 'E-01-1'), 'utf8'), done);
  assert.equal(run(dir, 'next').next.story.id, 'E-01-5');
});

test('cut again, the commit takes the replaced stories\' removal with the new ones', (t) => {
  const prose = readFileSync(join(HERE, '..', 'cadence-core', 'workflows', 'agile-refine.md'), 'utf8');
  const block = /```\n(set -- [\s\S]*?git commit [^\n]*)\n```/.exec(prose)[1].replaceAll('{id}', 'E-01');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b.c', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b.c' };
  const dir = withL(t);
  const root = dirname(dir);
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', env });
  git('init', '-q');
  git('add', '-A');
  assert.equal(git('commit', '-q', '-m', 'built').status, 0);
  assert.equal(refine(dir, halves()).ok, true);
  assert.equal(spawnSync('sh', ['-c', block], { cwd: root, encoding: 'utf8', env }).status, 0);
  const changed = git('show', '--name-status', '--format=').stdout.trim().split('\n').map((l) => l.replace('.planning/agile/epics/E-01/', ''));
  assert.deepEqual(changed.sort(), ['A\tE-01-3.md', 'A\tE-01-4.md', 'D\tE-01-2.md', 'M\tepic.md']);
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

test('the conversation settles its branch, asks and has the list checked before it shows or writes one, and commits by path', () => {
  const workflow = (name) => readFileSync(join(HERE, '..', 'cadence-core', 'workflows', name), 'utf8');
  const prose = workflow('agile-refine.md');
  const at = (words) => {
    assert.equal(prose.split(words).length, 2, `${words} is there once`);
    return prose.indexOf(words);
  };
  const order = ['apply section 1', 'mktemp -d', '## 2. Ask', 'workflows/agile-unknown.md', '**Then the choices.**', 'agile.mjs" answer', '## 3. Cut', 'agile.mjs" propose', 'Do you want {id} built from these stories?', '## 5. Write', 'agile.mjs" refine', 'git add -A -- "$@"', 'git commit -m "docs: refine {id}" -- "$@"'];
  assert.deepEqual(order.map(at), order.map(at).sort((a, b) => a - b));
  // the one agent is offered in the file read only for an unknown, and on phase 0, where an agile project's calls are recorded
  const unknown = workflow('agile-unknown.md');
  const agent = unknown.indexOf('resolve --role cad-assumptions-analyzer --phase 0 --bracket-read ".planning/agile/epics/{id}/epic.md" --bracket-plan {id}\n');
  assert.ok(unknown.indexOf('header: "Unknown"') > 0 && agent > unknown.indexOf('header: "Unknown"') && unknown.indexOf('trace close --phase 0 --plan {id} --role cad-assumptions-analyzer') > agent);
  // only a Confident finding settles an unknown, and a guess stays one after a clear
  assert.match(unknown, /answered by an assumption about it rated Confident/);
  assert.match(unknown, /The answer saved is "Guess: " and the guess/);
  assert.ok(at('opens with "Guess:" isn\'t asked') < at('**Then the choices.**') && at('Resting on a guess') > at('Picked for you'));
  assert.match(prose, /a validated or invalidated spike's verdict/);
  assert.doesNotMatch(prose, /resolve --role|subagent/);
  // the late commit of a refinement cut short is the same one
  const command = workflow('agile.md');
  const late = command.indexOf('<step name="refine">');
  assert.ok(late > command.indexOf('<step name="commit">') && late < command.indexOf('<step name="report">'));
  assert.ok(command.slice(late).includes('workflows/agile-refine.md'));
});

// Zero-dep tests for a story's build on the agile path: agile.mjs move, size and note, answer on a build step, and the build's prose.
// Run: node --test tests/agile-build.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerSetup, scratch } from './planning.test.mjs';
import { epicFile, storyFile } from '../cadence-core/bin/lib/agile-paths.mjs';
import { readStoryChecks, readStoryFile, readStoryPlan, readStoryResult } from '../cadence-core/bin/lib/agile-read.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGILE = join(HERE, '..', 'cadence-core', 'bin', 'agile.mjs');
const FIXTURE = join(HERE, 'fixtures', 'seldon-design');

const run = (dir, ...args) => {
  const r = spawnSync('node', [AGILE, ...args, '--dir', dir], { encoding: 'utf8' });
  return { ...JSON.parse(r.stdout), _exit: r.status };
};
const send = (dir, call, payload) => {
  const file = join(dirname(dir), '..', 'payload.json');
  writeFileSync(file, JSON.stringify(payload));
  return run(dir, call, '--payload', file);
};
const git = (root, ...args) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
const tree = (root) => readdirSync(root, { recursive: true }).map(String).filter((p) => !p.startsWith('.git')).sort()
  .map((p) => [p, statSync(join(root, p)).mtimeMs, statSync(join(root, p)).isFile() ? readFileSync(join(root, p), 'utf8') : '']);

/** A refined release in a repository, its first story E-01-1 an S with two checks unless `first` says otherwise, committed. */
function refined(t, first = {}) {
  const root = join(scratch('cad-agile-build-', t), 'repo');
  execFileSync('git', ['init', '-q', '-b', 'work', root]);
  const dir = answerSetup(join(root, '.planning'));
  assert.equal(run(dir, 'start', '--design', FIXTURE).ok, true);
  const story = (over) => ({ title: 'Add a tool', size: 'S', builds_on: [], requirements: ['CAT-01'],
    delivers: 'A volunteer adds a tool.', accepted_when: ['Adding a tool shows it in the list.', 'A tool with no name is refused.'], ...over });
  assert.equal(send(dir, 'refine', { epic: 'E-01', decisions: [], stories: [story(first), story({ title: 'Search', size: 'M', builds_on: ['E-01-1'], requirements: ['CAT-02'] })] }).ok, true);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'refined');
  return { root, dir, file: storyFile(join(dir, 'agile'), 'E-01-1') };
}
const story = (file) => readFileSync(file, 'utf8');

test('a story is begun from backlog with its base, and reviewed only once every check has a command', (t) => {
  const { root, dir, file } = refined(t);
  const head = git(root, 'rev-parse', '--short', 'HEAD');
  assert.deepEqual(run(dir, 'move', '--to', 'in-progress'), { ok: true, story: 'E-01-1', status: 'in-progress', base: head, _exit: 0 });
  assert.equal(readStoryFile(story(file))?.status, 'in-progress');
  assert.equal(readStoryResult(story(file)).base, head);
  assert.equal(run(dir, 'move', '--to', 'in-progress').already, true);
  const before = tree(root);
  assert.equal(run(dir, 'move', '--to', 'review').reason, 'checks-missing');
  assert.deepEqual(tree(root), before);
  assert.equal(send(dir, 'check-commands', { story: 'E-01-1', commands: ['true', 'true'] }).ok, true);
  assert.deepEqual(run(dir, 'move', '--to', 'review'), { ok: true, story: 'E-01-1', status: 'review', _exit: 0 });
  assert.equal(readStoryFile(story(file))?.status, 'review');
  // a reviewed story isn't begun again, and nothing moves it anywhere else
  const reviewed = tree(root);
  for (const to of ['in-progress', 'done', 'backlog', '']) {
    const r = run(dir, 'move', '--to', to);
    assert.equal(r.ok, false, to);
    assert.deepEqual(tree(root), reviewed, to);
  }
});

test('a note writes the commits since the base and its lines, keeping the checks, and is refused before the story is begun', (t) => {
  const { root, dir, file } = refined(t);
  const before = tree(root);
  assert.equal(send(dir, 'note', { story: 'E-01-1', review: 'one reviewer' }).reason, 'not-begun');
  assert.deepEqual(tree(root), before);
  run(dir, 'move', '--to', 'in-progress');
  writeFileSync(join(root, 'tool.mjs'), 'export const tool = 1;\n');
  git(root, 'add', 'tool.mjs');
  git(root, 'commit', '-q', '-m', 'feat(E-01-1): add a tool');
  const made = git(root, 'rev-parse', '--short', 'HEAD');
  send(dir, 'check-commands', { story: 'E-01-1', commands: ['true', 'true'] });
  assert.deepEqual(send(dir, 'note', { story: 'E-01-1', review: 'one reviewer, nothing raised', differently: 'nothing' }),
    { ok: true, story: 'E-01-1', commits: [made], _exit: 0 });
  const said = readStoryResult(story(file));
  assert.deepEqual([said.commits, said.review, said.differently, said.fix_round], [made, 'one reviewer, nothing raised', 'nothing', null]);
  assert.equal(readStoryChecks(story(file)).length, 2);
  assert.match(story(file), /## Result\n\n- Base: \w+\n- Commits: \w+\n- Review: one reviewer, nothing raised\n- Done differently: nothing\n- Check 1: `true` - not run\n- Check 2: `true` - not run\n/);
  // a later note replaces its own lines and keeps the rest, and a fix round's sets checks that ran back to not run
  writeFileSync(file, story(file).replace('- Check 2: `true` - not run', '- Check 2: `true` - exit 1, failed'));
  send(dir, 'note', { story: 'E-01-1', fix_round: 'check 2 fixed in abc' });
  assert.deepEqual([readStoryResult(story(file)).review, readStoryResult(story(file)).fix_round], ['one reviewer, nothing raised', 'check 2 fixed in abc']);
  assert.deepEqual(readStoryChecks(story(file)).map((c) => [c.command, c.result]), [['true', 'not run'], ['true', 'not run']]);
  const at = tree(root);
  for (const payload of [{ story: 'E-01-1', review: 'two\nlines' }, { story: 'E-01-1', review: 7 }, { review: 'x' }, { story: 'E-01-2', review: 'x' }]) {
    assert.equal(send(dir, 'note', payload).ok, false, JSON.stringify(payload));
    assert.deepEqual(tree(root), at, JSON.stringify(payload));
  }
});

test("an M's plan is written once it's begun and only once, and every payload that can't be is refused with nothing written", (t) => {
  const { root, dir, file } = refined(t, { size: 'M' });
  const fresh = tree(root);
  assert.equal(send(dir, 'size', { story: 'E-01-1', size: 'M', plan: ['the list'] }).reason, 'not-sizable');
  assert.deepEqual(tree(root), fresh);
  run(dir, 'move', '--to', 'in-progress');
  const begun = tree(root);
  for (const payload of [{ story: 'E-01-1', size: 'M' }, { story: 'E-01-1', size: 'M', plan: [] }, { story: 'E-01-1', size: 'M', plan: ['a', 'b', 'c', 'd'] },
    { story: 'E-01-1', size: 'M', plan: ['two\nlines'] }, { story: 'E-01-1', size: 'M', plan: ['a'], why: 'it was cut as one' },
    { story: 'E-01-1', size: 'S', plan: ['a'] }, { size: 'M', plan: ['a'] }, { story: 'E-01-2', size: 'M', plan: ['a'] }]) {
    assert.equal(send(dir, 'size', payload).ok, false, JSON.stringify(payload));
    assert.deepEqual(tree(root), begun, JSON.stringify(payload));
  }
  assert.deepEqual(send(dir, 'size', { story: 'E-01-1', size: 'M', plan: ['the list', ' the form '] }), { ok: true, story: 'E-01-1', size: 'M', tasks: 2, _exit: 0 });
  assert.match(story(file), /\n## Plan\n\n- Task 1: the list\n- Task 2: the form\n\n## Result\n\n- Base: \w+\n$/);
  assert.deepEqual([readStoryFile(story(file))?.size, readStoryResult(story(file)).resized], ['M', null]);
  const planned = tree(root);
  assert.equal(send(dir, 'size', { story: 'E-01-1', size: 'M', plan: ['another'] }).reason, 'not-sizable');
  assert.deepEqual(tree(root), planned);
});

test('an S takes no plan, and an M takes none once its commands are recorded', (t) => {
  const { root, dir } = refined(t);
  run(dir, 'move', '--to', 'in-progress');
  const begun = tree(root);
  for (const payload of [{ story: 'E-01-1', size: 'M', plan: ['the list', 'the form'] }, { story: 'E-01-1', size: 'M', plan: ['the list', 'the form'], why: 'two changes' }]) {
    assert.equal(send(dir, 'size', payload).reason, 'size-refused', JSON.stringify(payload));
    assert.deepEqual(tree(root), begun, JSON.stringify(payload));
  }
  const m = refined(t, { size: 'M' });
  run(m.dir, 'move', '--to', 'in-progress');
  send(m.dir, 'check-commands', { story: 'E-01-1', commands: ['true', 'true'] });
  const recorded = tree(m.root);
  assert.equal(send(m.dir, 'size', { story: 'E-01-1', size: 'M', plan: ['a', 'b'] }).reason, 'not-sizable');
  assert.deepEqual(tree(m.root), recorded);
});

test('one bigger than an M goes back to backlog as an L and the epic is refined again, but not once its work is begun', (t) => {
  const { root, dir, file } = refined(t, { size: 'M' });
  const fresh = tree(root);
  for (const payload of [{ story: 'E-01-1', size: 'L' }, { story: 'E-01-1', size: 'L', why: 'three stories', plan: ['a'] }]) {
    assert.equal(send(dir, 'size', payload).reason, 'size-refused', JSON.stringify(payload));
    assert.deepEqual(tree(root), fresh, JSON.stringify(payload));
  }
  const r = send(dir, 'size', { story: 'E-01-1', size: 'L', why: 'the list, the form and the search are three stories' });
  assert.deepEqual([r.ok, r.size, r.status, r.next?.step, r.next?.first], [true, 'L', 'backlog', 'refine', 'E-01-3']);
  assert.deepEqual([readStoryFile(story(file))?.size, readStoryFile(story(file))?.status], ['L', 'backlog']);
  assert.equal(readStoryResult(story(file)).resized, 'M to L - the list, the form and the search are three stories');
  assert.equal(run(dir, 'next').next.step, 'refine');
  const begun = refined(t);
  run(begun.dir, 'move', '--to', 'in-progress');
  assert.equal(send(begun.dir, 'size', { story: 'E-01-1', size: 'L', why: 'three stories' }).status, 'backlog');
  assert.deepEqual([readStoryResult(story(begun.file)).base, readStoryResult(story(begun.file)).resized], [null, 'S to L - three stories']);
  const made = refined(t);
  run(made.dir, 'move', '--to', 'in-progress');
  writeFileSync(join(made.root, 'tool.mjs'), 'export const tool = 1;\n');
  git(made.root, 'add', 'tool.mjs');
  git(made.root, 'commit', '-q', '-m', 'feat(E-01-1): add a tool');
  const committed = tree(made.root);
  assert.equal(send(made.dir, 'size', { story: 'E-01-1', size: 'L', why: 'three stories' }).reason, 'not-sizable');
  assert.deepEqual(tree(made.root), committed);
  // half made and not committed is the same: no story would own it
  const half = refined(t);
  run(half.dir, 'move', '--to', 'in-progress');
  writeFileSync(join(half.root, 'half.mjs'), 'export const half = 1;\n');
  const dirty = tree(half.root);
  assert.equal(send(half.dir, 'size', { story: 'E-01-1', size: 'L', why: 'three stories' }).reason, 'not-sizable');
  assert.deepEqual(tree(half.root), dirty);
});

test("the findings rule is saved under the epic's Decisions while its stories are built, and no other answer is", (t) => {
  const { root, dir } = refined(t);
  run(dir, 'move', '--to', 'in-progress');
  const before = tree(root);
  for (const answers of [[{ question: 'q', answer: 'a' }], [{ question: 'How are review findings handled?', answer: 'Fix everything' }],
    [{ question: 'How are review findings handled?', answer: 'Ask me each time' }, { question: 'q', answer: 'a' }]]) {
    assert.equal(send(dir, 'answer', { epic: 'E-01', answers }).reason, 'answers-refused', JSON.stringify(answers));
    assert.deepEqual(tree(root), before, JSON.stringify(answers));
  }
  const r = send(dir, 'answer', { epic: 'E-01', answers: [{ question: 'How are review findings handled?', answer: 'Fix them, ask about lows' }] });
  assert.deepEqual([r.ok, r.saved], [true, 1]);
  assert.match(readFileSync(epicFile(join(dir, 'agile'), 'E-01'), 'utf8'), /- \*\*How are review findings handled\?\*\* Fix them, ask about lows\n/);
  assert.equal(send(dir, 'answer', { epic: 'E-02', answers: [{ question: 'q', answer: 'a' }] }).reason, 'not-refinable');
});

const workflow = (name) => readFileSync(join(HERE, '..', 'cadence-core', 'workflows', name), 'utf8');

test('an executor agent builds the story and makes its fixes, and the session builds nothing', () => {
  const prose = workflow('agile-build.md').replace(/\s+/g, ' ');
  const at = (words) => { const i = prose.indexOf(words); assert.ok(i >= 0, `${words} is there`); return i; };
  const build = prose.slice(at('## 3. Build'), at('## 4. The commands'));
  // the resolve, its bracket and its close all come before the work it hands over
  assert.ok(build.startsWith('## 3. Build The session builds nothing. One `cad-executor` builds the story'));
  const order = ['route.mjs" resolve --role cad-executor --phase 0', '--event dispatch --plan {story}-build --role cad-executor',
    'Build story {story} {title} of epic {id}.', 'trace close --phase 0 --plan {story}-build --role cad-executor', '**Its size**, before anything is changed'];
  order.reduce((last, words) => { const i = build.indexOf(words); assert.ok(i > last, `${words} comes after what precedes it`); return i; }, -1);
  // the session reads no code to build it, and the review's fixes and the fix round go to an executor too
  assert.ok(!prose.includes('the code its Delivers changes'));
  assert.ok(prose.includes('The session builds nothing, so it reads no code'));
  assert.ok(!prose.includes('Each fix is committed as section 3 commits'));
  assert.ok(!prose.includes('Otherwise fix the code'));
  assert.equal(prose.split('dispatched and closed as section 3 dispatches one').length - 1, 2);
});

test("the build asks the findings rule first, sizes the story before it's built, records the commands before the review, and runs the checks after it", () => {
  const prose = workflow('agile-build.md').replace(/\s+/g, ' ');
  const at = (words) => { const i = prose.indexOf(words); assert.ok(i >= 0, `${words} is there`); return i; };
  const order = ['How are review findings handled?', 'agile.mjs" move --to in-progress', 'agile.mjs" size --payload', 'planning.mjs" capture --kind todo',
    'agile.mjs" check-commands', 'agile.mjs" move --to review', 'risk-check run --phase 0 --base {Base} --head HEAD',
    'route.mjs" resolve --role cad-reviewer --phase 0', 'planning.mjs" adjudication --phase 0 --trigger diff', 'agile.mjs" run-checks',
    '"fix_round"', 'issue-filing.mjs unfixed', 'git commit -m "docs({story}): record its build"', 'trace close --phase 0 --plan {story} --role cad-agile'];
  order.reduce((last, words) => { const i = at(words); assert.ok(i > last, `${words} comes after what precedes it`); return i; }, -1);
  // an M is built, its plan written before anything is changed, and one too big goes back without being built
  assert.ok(!prose.includes('An M stops here'));
  assert.ok(at('agile.mjs" size --payload') < at('Then make it, an M task by task'));
  assert.ok(prose.includes('sends it back to backlog for the next run to cut again: section 8, with nothing built'));
  // a risk match runs no checker here, and every gate is followed: deferred queues under the story, off takes the reviewers below
  assert.ok(prose.includes('carry `checkers: false`'));
  assert.ok(prose.includes('its `deferred record` takes `--task {story}` too'));
  assert.ok(at('**No match**, or the gate `off`: every reviewer the resolve below prints under `reviewers.diff`')
    > at('risk-check run --phase 0 --base {Base} --head HEAD'));
  // a cross-model reviewer runs through its provider's procedure, and a story is never left with none
  assert.ok(at('references/review-cross-model.md` (one consult site - this step)') < at('route.mjs" resolve --role cad-reviewer --phase 0'));
  assert.ok(prose.includes('with none left `claude-subagent` runs'));
  // the resolve fires for a set with no claude-subagent too, so only a claude-subagent that runs opens a bracket
  assert.ok(!prose.includes('--bracket-plan {story}-review'));
  assert.ok(prose.includes('--plan {story}-review --role cad-reviewer --reviewer claude-subagent --read-file'));
  // a name filter that matches nothing exits 0, so a check built on one passes after its test is renamed
  assert.ok(prose.includes('A filter that matches no test still passes'));
  // a done story takes no more notes, so what was done differently is noted before the checks can make it done
  assert.ok(at('with `differently`') < at('agile.mjs" run-checks'));
  // each review's payload outlives a clear, named for the heads it was read at and recorded at, so the lows can still be put to the user
  assert.ok(prose.includes('write `.planning/agile/tasks/{story}/payload-{reviewed}-{HEAD}.json`'));
  assert.ok(prose.includes("over each `payload-*.json` in `.planning/agile/tasks/{story}/`"));
  // an unpicked blocker or high is the user's override, or its record is refused
  assert.ok(prose.includes('carries `overridden: true`'));
  // the story's own record commits and the checks' writes aren't a fix, or a run's one round goes by with nothing fixed
  assert.ok(prose.includes('touches something outside `.planning/` is a fix already made'));
  assert.ok(prose.includes('With none, when the command is what\'s wrong'));
  // a done story with no record is picked up there, and the branch guard is agile.md's alone
  assert.ok(prose.includes('`done`: section 8'));
  assert.ok(!prose.includes('apply section 1'));
  // agile.md hands a build step to it, after finishing a done story's record and a refinement cut short
  const main = workflow('agile.md');
  assert.ok(main.lastIndexOf('workflows/agile-build.md') > main.indexOf('REFINED'));
  assert.ok(main.indexOf('UNRECORDED') < main.indexOf('REFINED'));
});

test("the record's commit takes the story, its review files and a ledger it changed, and nothing else that's staged", (t) => {
  const { root, file } = refined(t);
  const block = /```\n(set -- '\.planning\/agile\/epics\/\{id\}\/\{story\}\.md'[\s\S]*?git commit [^\n]*)\n```/.exec(workflow('agile-build.md'))[1]
    .replaceAll('{id}', 'E-01').replaceAll('{story}', 'E-01-1');
  writeFileSync(file, story(file).replace('None yet.', '- Base: abc1234'));
  execFileSync('mkdir', ['-p', join(root, '.planning', 'agile', 'tasks', 'E-01-1')]);
  writeFileSync(join(root, '.planning', 'agile', 'tasks', 'E-01-1', 'ADJUDICATION-diff-a-b.json'), '{}\n');
  writeFileSync(join(root, '.planning', 'agile', 'declined.md'), '# Declined\n');
  const epic = epicFile(join(root, '.planning', 'agile'), 'E-01');
  writeFileSync(epic, readFileSync(epic, 'utf8').concat('- **How are review findings handled?** Ask me each time\n'));
  writeFileSync(join(root, 'other.txt'), 'the user\'s\n');
  git(root, 'add', 'other.txt');
  execFileSync('bash', ['-c', block], { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false' } });
  assert.deepEqual(git(root, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(),
    ['.planning/agile/declined.md', '.planning/agile/epics/E-01/E-01-1.md', '.planning/agile/epics/E-01/epic.md', '.planning/agile/tasks/E-01-1/ADJUDICATION-diff-a-b.json']);
  assert.equal(git(root, 'diff', '--cached', '--name-only'), 'other.txt');
});

test('agile.md finds a done story whose record was never made, by its payload left or its file changed, and no other', (t) => {
  const { root, file } = refined(t);
  const block = /```\n(for f in '\.planning\/agile\/epics\/\{next\.id\}[^\n]*)\n```/.exec(workflow('agile.md'))[1].replaceAll('{next.id}', 'E-01');
  const found = () => execFileSync('bash', ['-c', block], { cwd: root, encoding: 'utf8' }).trim();
  const done = story(file).replace(/^status: .*$/m, 'status: done');
  writeFileSync(file, story(file).replace('None yet.', '- Base: abc1234'));
  assert.equal(found(), '');
  writeFileSync(file, done);
  assert.equal(found(), 'UNRECORDED E-01-1');
  git(root, 'commit', '-q', '-am', 'docs(E-01-1): record its build');
  assert.equal(found(), '');
  const tasks = join(root, '.planning', 'agile', 'tasks', 'E-01-1');
  execFileSync('mkdir', ['-p', tasks]);
  writeFileSync(join(tasks, 'payload-abc1234-def5678.json'), '{}\n');
  assert.equal(found(), 'UNRECORDED E-01-1');
});

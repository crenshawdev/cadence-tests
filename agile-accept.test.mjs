// Zero-dep tests for accepting an epic on the agile path: agile.mjs accept, and the prose that asks for it.
// Run: node --test tests/agile-accept.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerSetup, scratch } from './planning.test.mjs';
import { epicFile, storyFile } from '../cadence-core/bin/lib/agile-paths.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGILE = join(HERE, '..', 'cadence-core', 'bin', 'agile.mjs');
const FIXTURE = join(HERE, 'fixtures', 'seldon-design');
const workflow = (name) => readFileSync(join(HERE, '..', 'cadence-core', 'workflows', name), 'utf8');

const run = (dir, ...args) => {
  const r = spawnSync('node', [AGILE, ...args, '--dir', dir], { encoding: 'utf8' });
  return { ...JSON.parse(r.stdout), _exit: r.status };
};
const git = (root, ...args) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
const tree = (root) => readdirSync(root, { recursive: true }).map(String).filter((p) => !p.startsWith('.git')).sort()
  .map((p) => [p, statSync(join(root, p)).mtimeMs, statSync(join(root, p)).isFile() ? readFileSync(join(root, p), 'utf8') : '']);
const setStatus = (file, status) => writeFileSync(file, readFileSync(file, 'utf8').replace(/^status: .*$/m, `status: ${status}`));

/** A release whose E-01 is refined to two stories, each set to `statuses`, all committed. */
function finished(t, statuses = ['done', 'done']) {
  const root = join(scratch('cad-agile-accept-', t), 'repo');
  execFileSync('git', ['init', '-q', '-b', 'work', root]);
  const dir = answerSetup(join(root, '.planning'));
  assert.equal(run(dir, 'start', '--design', FIXTURE).ok, true);
  const story = (over) => ({ size: 'S', builds_on: [], delivers: 'A volunteer adds a tool.', accepted_when: ['Adding a tool shows it in the list.'], ...over });
  const payload = join(root, '..', 'payload.json');
  writeFileSync(payload, JSON.stringify({ epic: 'E-01', decisions: [], stories: [
    story({ title: 'Add a tool', requirements: ['CAT-01'] }), story({ title: 'Search', builds_on: ['E-01-1'], requirements: ['CAT-02'] })] }));
  assert.equal(run(dir, 'refine', '--payload', payload).ok, true);
  const agile = join(dir, 'agile');
  statuses.forEach((s, i) => setStatus(storyFile(agile, `E-01-${i + 1}`), s));
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'built');
  return { root, dir, agile };
}

test('an epic whose stories are all done is accepted, its status the one line changed, and next moves to the epic after it', (t) => {
  const { dir, agile } = finished(t);
  assert.deepEqual(run(dir, 'next').next, { id: 'E-01', name: 'Catalog', status: 'in-progress', step: 'accept' });
  const before = readFileSync(epicFile(agile, 'E-01'), 'utf8');
  const r = run(dir, 'accept');
  assert.deepEqual([r.ok, r.epic, r.status, r.next?.id, r.next?.step], [true, 'E-01', 'done', 'E-02', 'refine'], JSON.stringify(r));
  assert.equal(readFileSync(epicFile(agile, 'E-01'), 'utf8'), before.replace('status: in-progress', 'status: done'));
  assert.equal(run(dir, 'next').next.id, 'E-02');
});

test('an epic with a story not done, one already accepted, and one marked review by hand are each refused with nothing written', (t) => {
  for (const [name, statuses, epic, detail] of [
    ['a story still in backlog', ['done', 'backlog'], 'in-progress', /^E-01 is at build, not accept$/],
    ['marked review by hand', ['done', 'in-progress'], 'review', /^E-01-2 of E-01 isn't done$/],
    ['marked review by hand, neither done', ['review', 'backlog'], 'review', /^E-01-1, E-01-2 of E-01 aren't done$/],
  ]) {
    const { root, dir, agile } = finished(t, statuses);
    setStatus(epicFile(agile, 'E-01'), epic);
    const before = tree(root);
    const r = run(dir, 'accept');
    assert.deepEqual([r.ok, r.reason, r._exit], [false, 'not-accepting', 1], `${name}: ${JSON.stringify(r)}`);
    assert.match(r.detail, detail, name);
    assert.deepEqual(tree(root), before, name);
  }
  const { root, dir, agile } = finished(t);
  assert.equal(run(dir, 'accept').ok, true);
  const before = tree(root);
  const again = run(dir, 'accept');
  assert.deepEqual([again.ok, again.reason, again.detail], [false, 'not-accepting', 'E-02 is at refine, not accept']);
  assert.deepEqual(tree(root), before);
  // marked review by hand before it was ever cut, nothing of it was built
  setStatus(epicFile(agile, 'E-02'), 'review');
  const uncut = tree(root);
  const none = run(dir, 'accept');
  assert.deepEqual([none.ok, none.reason, none.detail], [false, 'not-accepting', 'E-02 has no story, so nothing of it was built']);
  assert.deepEqual(tree(root), uncut);
});

test('an acceptance that finds the epic after it damaged says so, and never reads as the end of the release', (t) => {
  const { dir, agile } = finished(t);
  rmSync(epicFile(agile, 'E-02'));
  const r = run(dir, 'accept');
  assert.deepEqual([r.ok, r.epic, r.next, r.next_refusal?.reason], [true, 'E-01', null, 'release-damaged'], JSON.stringify(r));
  assert.equal(run(dir, 'next').reason, 'release-damaged');
  assert.ok(workflow('agile-accept.md').replace(/\s+/g, ' ').includes('With `next_refusal`, its `detail` and `hint` take the `Next:` line\'s place'));
});

test('an acceptance cut short before its commit is named by agile.md, and a committed one is not', (t) => {
  const { root, dir } = finished(t);
  const prose = workflow('agile.md');
  const loop = /```\n(st\(\) \{[^\n]*\nfor f in \.planning\/agile\/epics\/E-\*\/epic\.md;[^\n]*)\n```/.exec(prose)?.[1];
  assert.ok(loop, 'the late commit check is there');
  const unaccepted = () => execFileSync('sh', ['-c', loop], { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(unaccepted(), '');
  assert.equal(run(dir, 'accept').ok, true);
  assert.equal(unaccepted(), 'UNACCEPTED E-01');
  // the commit is agile.md's own, since that's the file in hand when the check names one
  const step = prose.slice(prose.indexOf('<step name="refine">'), prose.indexOf('On `build` and `accept`'));
  for (const line of ["git add -- '.planning/agile/epics/{e}/epic.md'", 'git commit -m "docs: accept {e}" -- \'.planning/agile/epics/{e}/epic.md\'']) {
    assert.ok(step.includes(line), line);
    execFileSync('sh', ['-c', line.replaceAll('{e}', 'E-01')], { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e.c', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e.c', GIT_CONFIG_GLOBAL: '/dev/null' } });
  }
  assert.doesNotMatch(step, /section 3/);
  assert.equal(git(root, 'show', '--name-only', '--format=%s', 'HEAD'), 'docs: accept E-01\n\n.planning/agile/epics/E-01/epic.md');
  assert.equal(unaccepted(), '');
});

test('the late commit reads only the frontmatter\'s status, whatever the body says or how lines end', (t) => {
  const { root, dir, agile } = finished(t);
  const loop = /```\n(st\(\) \{[^\n]*\nfor f in [^\n]*)\n```/.exec(workflow('agile.md'))?.[1];
  const unaccepted = () => execFileSync('sh', ['-c', loop], { cwd: root, encoding: 'utf8' }).trim();
  // a body line that reads as a done status, committed with E-01 in progress and E-03 never committed
  for (const id of ['E-01', 'E-03']) {
    const file = epicFile(agile, id);
    writeFileSync(file, readFileSync(file, 'utf8').replace('## Outcome\n', '## Outcome\n\nstatus: done\n'));
  }
  git(root, 'add', '--', '.planning/agile/epics/E-01/epic.md');
  git(root, 'commit', '-q', '-m', 'outcome', '--', '.planning/agile/epics/E-01/epic.md');
  git(root, 'rm', '-q', '--cached', '--', '.planning/agile/epics/E-03/epic.md');
  git(root, 'commit', '-q', '-m', 'gone');
  assert.equal(unaccepted(), '');
  assert.equal(run(dir, 'accept').ok, true);
  const file = epicFile(agile, 'E-01');
  writeFileSync(file, readFileSync(file, 'utf8').replace(/\n/g, '\r\n'));
  assert.equal(unaccepted(), 'UNACCEPTED E-01');
});

test('the accept shows the Done when and the checks, asks, writes, then commits the epic file alone, and Not yet writes nothing', () => {
  const prose = workflow('agile-accept.md').replace(/\s+/g, ' ');
  const at = (words) => { const i = prose.indexOf(words); assert.ok(i >= 0, `${words} is there`); return i; };
  const order = ['each item under the epic\'s Done when', '`- Check` lines', 'header: "Accept"', '"Accept - {id} is done',
    '"Not yet - nothing is written', 'agile.mjs" accept', 'git add -- \'.planning/agile/epics/{id}/epic.md\'',
    'git commit -m "docs: accept {id}" -- \'.planning/agile/epics/{id}/epic.md\''];
  order.reduce((last, words) => { const i = at(words); assert.ok(i > last, `${words} comes after what precedes it`); return i; }, -1);
  assert.ok(at('"Not yet" ends the run: go to section 4.') < at('agile.mjs" accept'));
  // agile.md finishes a cut-short acceptance before any arm, and hands an accept step to this file
  const main = workflow('agile.md');
  const step = main.slice(main.indexOf('<step name="refine">'), main.indexOf('<step name="report">'));
  assert.ok(step.indexOf('UNACCEPTED') > 0 && step.indexOf('UNACCEPTED') < step.indexOf('On `build` and `accept`'));
  assert.ok(step.indexOf('workflows/agile-accept.md') > step.indexOf('`next.step` is `accept`'));
});

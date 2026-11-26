// Zero-dep tests for accepting an epic on the agile path: agile.mjs accept, and the prose that asks for it.
// Run: node --test tests/agile-accept.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerSetup, scratch } from './planning.test.mjs';
import { epicFile, retroFile, storyFile } from '../cadence-core/bin/lib/agile-paths.mjs';

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
const send = (dir, call, payload) => {
  const file = join(dirname(dir), '..', `${call}.json`);
  writeFileSync(file, JSON.stringify(payload));
  return run(dir, call, '--payload', file);
};
const RETRO = { went_well: ['Every check was a command.'], do_better: [], change_next: ['Read the review rulings first.', 'Open the bracket before the first change.'] };
const accept = (dir) => send(dir, 'accept', RETRO);

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
  const r = accept(dir);
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
  assert.equal(accept(dir).ok, true);
  const before = tree(root);
  const again = accept(dir);
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
  const r = accept(dir);
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
  assert.equal(accept(dir).ok, true);
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
  assert.equal(accept(dir).ok, true);
  const file = epicFile(agile, 'E-01');
  writeFileSync(file, readFileSync(file, 'utf8').replace(/\n/g, '\r\n'));
  assert.equal(unaccepted(), 'UNACCEPTED E-01');
});

test('the accept shows the Done when and the checks, asks, writes, then commits the epic file alone, and Not yet saves what is missing and commits it', () => {
  const prose = workflow('agile-accept.md').replace(/\s+/g, ' ');
  const at = (words) => { const i = prose.indexOf(words); assert.ok(i >= 0, `${words} is there`); return i; };
  const order = ['each item under the epic\'s Done when', '`- Check` lines', 'header: "Accept"', '"Accept - {id} is done',
    '"Not yet - say what\'s missing', 'ask in plain words what\'s missing from {id}', 'agile.mjs" accept', 'git add -- \'.planning/agile/epics/{id}/epic.md\'',
    'git commit -m "docs: accept {id}" -- \'.planning/agile/epics/{id}/epic.md\'', 'agile.mjs" not-yet --payload', 'with the message `docs: not yet {id}`'];
  order.reduce((last, words) => { const i = at(words); assert.ok(i > last, `${words} comes after what precedes it`); return i; }, -1);
  // a refinement knows why an epic in progress with every story done is back
  assert.ok(workflow('agile-refine.md').replace(/\s+/g, ' ').includes('After a Not yet, open with what\'s missing, and the list adds the stories that deliver it.'));
  // agile.md finishes a cut-short acceptance before any arm, and hands an accept step to this file
  const main = workflow('agile.md');
  const step = main.slice(main.indexOf('<step name="refine">'), main.indexOf('<step name="report">'));
  assert.ok(step.indexOf('UNACCEPTED') > 0 && step.indexOf('UNACCEPTED') < step.indexOf('On `build` and `accept`'));
  assert.ok(step.indexOf('workflows/agile-accept.md') > step.indexOf('`next.step` is `accept`'));
});

const decisions = (text) => text.slice(text.indexOf('## Decisions')).trim().split('\n').filter((l) => l.startsWith('- '));

test('Not yet saves what is missing, sends the epic back to a cut again that adds after the done stories, and the cut closes it', (t) => {
  const { dir, agile } = finished(t);
  const done = ['E-01-1', 'E-01-2'].map((id) => readFileSync(storyFile(agile, id), 'utf8'));
  const r = send(dir, 'not-yet', { epic: 'E-01', missing: 'Nothing adds a tool yet' });
  assert.deepEqual([r.ok, r.epic, r.missing, r.next], [true, 'E-01', 'Nothing adds a tool yet', { id: 'E-01', name: 'Catalog', status: 'in-progress', step: 'refine', first: 'E-01-3' }], JSON.stringify(r));
  assert.equal(decisions(readFileSync(epicFile(agile, 'E-01'), 'utf8')).at(-1), '- Not yet: Nothing adds a tool yet');
  assert.equal(run(dir, 'accept').reason, 'not-accepting');
  const cut = send(dir, 'refine', { epic: 'E-01', decisions: [], stories: [{ title: 'Add a tool', size: 'S', builds_on: ['E-01-1'], requirements: ['CAT-01'],
    delivers: 'node add.mjs <name> adds a tool.', accepted_when: ['Adding a drill lists it.'] }] });
  assert.equal(cut.ok, true, JSON.stringify(cut));
  assert.deepEqual(['E-01-1', 'E-01-2'].map((id) => readFileSync(storyFile(agile, id), 'utf8')), done);
  assert.deepEqual(decisions(readFileSync(epicFile(agile, 'E-01'), 'utf8')).slice(-2), ['- Not yet: Nothing adds a tool yet', '- Cut again for what was missing: E-01-3.']);
  assert.deepEqual([run(dir, 'next').next.step, run(dir, 'next').next.story?.id], ['build', 'E-01-3']);
});

test('a cut again for what was missing may add nothing, and the epic is asked about again', (t) => {
  const { dir, agile } = finished(t);
  assert.equal(send(dir, 'not-yet', { missing: 'A photo for each tool' }).ok, true);
  assert.equal(send(dir, 'refine', { epic: 'E-01', decisions: ['The photo waits for the next release.'], stories: [] }).ok, true);
  assert.deepEqual(decisions(readFileSync(epicFile(agile, 'E-01'), 'utf8')).slice(-3),
    ['- Not yet: A photo for each tool', '- The photo waits for the next release.', '- Cut again for what was missing: no story.']);
  assert.equal(run(dir, 'next').next.step, 'accept');
});

test('a Not yet off accept, a bad payload, and a decision that reads as the script\'s own line are each refused with nothing written', (t) => {
  const { root, dir } = finished(t, ['done', 'backlog']);
  let before = tree(root);
  const off = send(dir, 'not-yet', { epic: 'E-01', missing: 'More' });
  assert.deepEqual([off.ok, off.reason, off.detail], [false, 'not-accepting', 'E-01 is at build, not accept']);
  assert.deepEqual(tree(root), before);
  const ready = finished(t);
  before = tree(ready.root);
  for (const [name, payload, field] of [
    ['no words', { missing: '  ' }, 'missing'], ['two lines', { missing: 'one\ntwo' }, 'missing'], ['not text', { missing: 3 }, 'missing'],
    ['another epic', { epic: 'E-02', missing: 'More' }, 'epic'], ['an extra field', { missing: 'More', size: 'S' }, 'size'], ['not an object', ['More'], 'payload'],
  ]) {
    const r = send(ready.dir, 'not-yet', payload);
    assert.deepEqual([r.ok, r.reason, r.issues?.[0]?.field], [false, 'not-yet-refused', field], `${name}: ${JSON.stringify(r)}`);
    assert.deepEqual(tree(ready.root), before, name);
  }
  assert.equal(send(ready.dir, 'not-yet', { missing: 'More' }).ok, true);
  before = tree(ready.root);
  for (const d of ['Not yet: nothing', 'Cut again for what was missing: no story.']) {
    const r = send(ready.dir, 'refine', { epic: 'E-01', decisions: [d], stories: [] });
    assert.deepEqual([r.ok, r.reason], [false, 'stories-refused'], d);
    assert.match(JSON.stringify(r.issues), /starts the way a line the script writes does/, d);
    assert.deepEqual(tree(ready.root), before, d);
  }
});

test('a cut for what was missing stopped before the epic\'s file turned is cut again, its stray story replaced and never built', (t) => {
  const { dir, agile } = finished(t);
  assert.equal(send(dir, 'not-yet', { missing: 'Nothing adds a tool yet' }).ok, true);
  const said = readFileSync(epicFile(agile, 'E-01'), 'utf8');
  const done = ['E-01-1', 'E-01-2'].map((id) => readFileSync(storyFile(agile, id), 'utf8'));
  const story = { title: 'Add a tool', size: 'S', builds_on: ['E-01-1'], requirements: ['CAT-01'], delivers: 'node add.mjs <name> adds a tool.', accepted_when: ['Adding a drill lists it.'] };
  assert.equal(send(dir, 'refine', { epic: 'E-01', decisions: [], stories: [story] }).ok, true);
  // the stop: the story file is written and the epic's own file never turned
  writeFileSync(epicFile(agile, 'E-01'), said);
  assert.deepEqual(run(dir, 'next').next, { id: 'E-01', name: 'Catalog', status: 'in-progress', step: 'refine', first: 'E-01-4' });
  assert.equal(send(dir, 'refine', { epic: 'E-01', decisions: [], stories: [story] }).ok, true);
  assert.deepEqual(['E-01-1', 'E-01-2'].map((id) => readFileSync(storyFile(agile, id), 'utf8')), done);
  assert.throws(() => readFileSync(storyFile(agile, 'E-01-3'), 'utf8'), /ENOENT/);
  assert.equal(decisions(readFileSync(epicFile(agile, 'E-01'), 'utf8')).at(-1), '- Cut again: E-01-3 became E-01-4.');
  assert.deepEqual([run(dir, 'next').next.step, run(dir, 'next').next.story?.id], ['build', 'E-01-4']);
});

test('a Not yet on an epic marked review by hand is refused with nothing written, since it would be asked again', (t) => {
  const { root, dir, agile } = finished(t);
  setStatus(epicFile(agile, 'E-01'), 'review');
  const before = tree(root);
  const r = send(dir, 'not-yet', { missing: 'More' });
  assert.deepEqual([r.ok, r.reason, r.detail], [false, 'not-accepting', 'E-01 is marked review, which only a hand edit sets']);
  assert.deepEqual(tree(root), before);
});

test('Accept writes retro.md first, with the Evidence and the three approved sections, then turns the epic done', (t) => {
  const { dir, agile } = finished(t);
  const evidence = run(dir, 'evidence');
  assert.equal(evidence.ok, true, JSON.stringify(evidence));
  const r = send(dir, 'accept', { epic: 'E-01', went_well: ['  Every check was a command.  '], do_better: [], change_next: ['Read the review rulings first.', 'Open the bracket before the first change.'] });
  assert.deepEqual([r.ok, r.status, r.retro], [true, 'done', retroFile(agile, 'E-01')], JSON.stringify(r));
  const text = readFileSync(retroFile(agile, 'E-01'), 'utf8');
  assert.match(text, /^# E-01 Catalog retrospective\n\nAccepted \d{4}-\d{2}-\d{2}\.\n\n## Evidence\n\n/);
  assert.ok(text.endsWith(['## Evidence', evidence.text.join('\n'), '## What went well', '- Every check was a command.', '## What could we do better', 'None.',
    '## Change next', '1. Read the review rulings first.\n2. Open the bracket before the first change.'].join('\n\n') + '\n'), text);
});

test('with no payload, an epic with no retro.md is refused, and one whose retro.md was written before a stop is finished as it stands', (t) => {
  const { root, dir, agile } = finished(t);
  let before = tree(root);
  const none = run(dir, 'accept');
  assert.deepEqual([none.ok, none.reason, none._exit], [false, 'no-retrospective', 1], JSON.stringify(none));
  assert.deepEqual(tree(root), before);
  // the stop: retro.md is written and the status line never turned
  assert.equal(accept(dir).ok, true);
  git(root, 'checkout', '-q', '--', '.planning/agile/epics/E-01/epic.md');
  const written = readFileSync(retroFile(agile, 'E-01'), 'utf8');
  assert.equal(run(dir, 'next').next.step, 'accept');
  // a Not yet there would be asked after the user approved, so it's refused and the acceptance finished
  before = tree(root);
  const notYet = send(dir, 'not-yet', { missing: 'More' });
  assert.deepEqual([notYet.ok, notYet.reason], [false, 'not-accepting'], JSON.stringify(notYet));
  assert.match(notYet.detail, /^E-01's retrospective is written/);
  assert.deepEqual(tree(root), before);
  const r = run(dir, 'accept');
  assert.deepEqual([r.ok, r.status, r.next?.id], [true, 'done', 'E-02'], JSON.stringify(r));
  assert.equal(readFileSync(retroFile(agile, 'E-01'), 'utf8'), written);
});

test('a retrospective that isn\'t three lists of one-line text is refused with nothing written', (t) => {
  const { root, dir, agile } = finished(t);
  const before = tree(root);
  for (const [name, payload, field] of [
    ['not an object', [RETRO], 'payload'], ['another epic', { ...RETRO, epic: 'E-02' }, 'epic'], ['an extra field', { ...RETRO, missing: 'x' }, 'missing'],
    ['a section left out', { went_well: [], do_better: [] }, 'change_next'], ['a section as text', { ...RETRO, do_better: 'Slower' }, 'do_better'],
    ['two lines in one', { ...RETRO, went_well: ['one\ntwo'] }, 'went_well[0]'], ['an empty line', { ...RETRO, change_next: ['  '] }, 'change_next[0]'],
    ['not text', { ...RETRO, went_well: [3] }, 'went_well[0]'],
  ]) {
    const r = send(dir, 'accept', payload);
    assert.deepEqual([r.ok, r.reason, r.issues?.[0]?.field], [false, 'retro-refused', field], `${name}: ${JSON.stringify(r)}`);
    assert.deepEqual(tree(root), before, name);
  }
  assert.equal(existsSync(retroFile(agile, 'E-01')), false);
});

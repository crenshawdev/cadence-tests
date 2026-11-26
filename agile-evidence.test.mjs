// Zero-dep tests for a finished epic's Evidence on the agile path: agile.mjs evidence and lib/agile-evidence.mjs.
// Run: node --test tests/agile-evidence.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerSetup, scratch } from './planning.test.mjs';
import { agileDeclinedFile, agileFiledFile, agileTasksDir } from '../cadence-core/bin/lib/agile-paths.mjs';
import { fingerprint } from '../cadence-core/bin/lib/filing-decision.mjs';
import { AGILE_DECLINED_PREAMBLE, AGILE_FILED_PREAMBLE, appendDeclinedRow, appendFiledRow } from '../cadence-core/bin/lib/planning-files.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGILE = join(HERE, '..', 'cadence-core', 'bin', 'agile.mjs');
const FIXTURE = join(HERE, 'fixtures', 'seldon-design');

const run = (dir, ...args) => {
  const r = spawnSync('node', [AGILE, ...args, '--dir', dir], { encoding: 'utf8' });
  return { ...JSON.parse(r.stdout), _exit: r.status };
};
const git = (root, ...args) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
const tree = (root) => readdirSync(root, { recursive: true }).map(String).filter((p) => !p.startsWith('.git')).sort()
  .map((p) => [p, statSync(join(root, p)).mtimeMs, statSync(join(root, p)).isFile() ? readFileSync(join(root, p), 'utf8') : '']);

/** A release whose E-01 holds an S and an M, each built through its own calls to done, its records written after. */
function built(t) {
  const root = join(scratch('cad-agile-evidence-', t), 'repo');
  execFileSync('git', ['init', '-q', '-b', 'work', root]);
  const dir = answerSetup(join(root, '.planning'));
  assert.equal(run(dir, 'start', '--design', FIXTURE).ok, true);
  const send = (call, payload) => { const f = join(root, '..', 'p.json'); writeFileSync(f, JSON.stringify(payload)); return run(dir, call, '--payload', f); };
  const story = (over) => ({ builds_on: [], delivers: 'A volunteer lists the tools.', accepted_when: ['Listing shows nothing with no catalog.'], ...over });
  assert.equal(send('refine', { epic: 'E-01', decisions: [], stories: [story({ title: 'List the tools', size: 'S', requirements: ['CAT-01'] }),
    story({ title: 'Find a tool', size: 'M', builds_on: ['E-01-1'], requirements: ['CAT-02'] })] }).ok, true);
  assert.equal(send('answer', { epic: 'E-01', answers: [{ question: 'How are review findings handled?', answer: 'Fix them, ask about lows' }] }).ok, true);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'refined');
  for (const [id, name] of [['E-01-1', 'list'], ['E-01-2', 'find']]) {
    assert.equal(run(dir, 'move', '--to', 'in-progress').ok, true);
    if (id === 'E-01-2') assert.equal(send('size', { story: id, size: 'M', plan: ['Write find.mjs.', 'Test it.'] }).ok, true);
    writeFileSync(join(root, `${name}.mjs`), `console.log(${JSON.stringify(name)});\n`.repeat(id === 'E-01-1' ? 3 : 5));
    git(root, 'add', `${name}.mjs`);
    git(root, 'commit', '-q', '-m', `feat(${id}): ${name}`);
    assert.equal(send('check-commands', { story: id, commands: ['true'] }).ok, true);
    assert.equal(run(dir, 'move', '--to', 'review').ok, true);
    assert.equal(send('note', { story: id, review: 'one reviewer' }).ok, true);
    assert.equal(run(dir, 'run-checks').status, 'done');
    git(root, 'add', '-A', '.planning');
    git(root, 'commit', '-q', '-m', `docs(${id}): record its build`);
  }
  return { root, dir, agile: join(dir, 'agile') };
}

/** Six findings in E-01-1's review record, one for each way a finding ends, and the two ledgers that hold two of them. */
function findings(agile) {
  const f = (claim, severity, more) => ({ voice: 'claude-subagent', file: 'list.mjs', line: 1, severity, claim, failure_scenario: 'x', ...more });
  const entries = [f('fixed', 'medium', { ruling: 'survived', fix_commit: 'abc1234' }), f('refuted', 'medium', { ruling: 'refuted' }),
    f('let stand', 'high', { ruling: 'survived', overridden: true }), f('declined', 'low', { ruling: 'survived' }),
    f('filed', 'low', { ruling: 'downgraded' }), f('open', 'medium', { ruling: 'survived' })];
  const home = join(agileTasksDir(agile), 'E-01-1');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'ADJUDICATION-diff-a-b.json'), JSON.stringify({ phase: '0', task: 'E-01-1', entries }));
  const row = (claim) => ({ date: '2026-11-26', provider: 'github', slug: 'octo/toolshed', fingerprint: fingerprint({ file: 'list.mjs', claim }), title: claim });
  writeFileSync(agileDeclinedFile(agile), appendDeclinedRow('', row('declined'), AGILE_DECLINED_PREAMBLE));
  writeFileSync(agileFiledFile(agile), appendFiledRow('', row('filed'), AGILE_FILED_PREAMBLE));
}

/** The run record: each story's build its own run, the epic's unknown read, another epic's run, a row with no tokens, and the rotated half. */
function record(dir) {
  const rows = (list) => list.map((r) => JSON.stringify({ phase: '0', ts: '2026-11-26T00:00:00Z', family: 'lifecycle', ...r })).join('\n') + '\n';
  mkdirSync(join(dir, 'records'), { recursive: true });
  writeFileSync(join(dir, 'records', 'trace.1.jsonl'), rows([
    { corr: 'A', event: 'dispatch', plan: 'E-01-1', role: 'cad-agile' },
    { corr: 'A', event: 'return', plan: 'E-01-1-review', role: 'cad-reviewer', tokens: 5 },
  ]));
  writeFileSync(join(dir, 'records', 'trace.jsonl'), `${rows([
    { corr: 'A', event: 'return', plan: 'E-01-1-review', role: 'cad-reviewer', tokens: 100 },
    { corr: 'A', event: 'return', plan: 'E-01-1-review', role: 'cad-reviewer', agent_id: 'x', cache_read_input_tokens: 9000 },
    { corr: 'B', event: 'dispatch', plan: 'E-01-2', role: 'cad-agile' },
    { corr: 'B', event: 'return', plan: 'E-01-2-review', role: 'cad-reviewer', tokens: 200 },
    { corr: 'B', event: 'return', plan: 'wf-1', role: 'review-checker', tokens: 50 },
    { corr: 'B', event: 'dispatch', plan: 'E-01-2-review', role: 'cad-reviewer', tokens: 7777 },
    { corr: 'C', event: 'return', plan: 'E-01', role: 'cad-assumptions-analyzer', tokens: 30 },
    { corr: 'D', event: 'dispatch', plan: 'E-02-1', role: 'cad-agile' },
    { corr: 'D', event: 'return', plan: 'E-02-1-review', role: 'cad-reviewer', tokens: 999 },
  ])}not a row\n`);
}

test('a finished epic\'s Evidence matches git over its span, each finding by how it ended, and the record\'s rows for its own runs', (t) => {
  const { root, dir, agile } = built(t);
  findings(agile);
  record(dir);
  const base = /- Base: (\S+)/.exec(readFileSync(join(agile, 'epics', 'E-01', 'E-01-1.md'), 'utf8'))[1];
  const commits = Number(git(root, 'rev-list', '--count', `${base}..HEAD`));
  const stat = git(root, 'diff', '--shortstat', `${base}..HEAD`);
  const [files, plus, minus] = [/(\d+) files? changed/, /(\d+) insertions?/, /(\d+) deletions?/].map((re) => Number(re.exec(stat)?.[1] ?? 0));
  const before = tree(root);
  const r = run(dir, 'evidence');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.evidence, {
    stories: [{ id: 'E-01-1', title: 'List the tools', size: 'S' }, { id: 'E-01-2', title: 'Find a tool', size: 'M' }],
    since: base, commits, files, insertions: plus, deletions: minus,
    findings: { raised: 6, severity: { medium: 3, high: 1, low: 2 }, outcome: { fixed: 1, refuted: 1, 'let stand': 1, declined: 1, filed: 1, open: 1 } },
    tokens: { total: 385, role: { 'cad-reviewer': 305, 'review-checker': 50, 'cad-assumptions-analyzer': 30 } }, unread: [],
  });
  assert.ok(commits >= 4 && files >= 2 && plus > 0, stat);
  assert.deepEqual(r.text, [
    '- 2 stories (1 M, 1 S): E-01-1 List the tools, E-01-2 Find a tool.',
    `- ${commits} commits since ${base}; ${files} files, +${plus} and -${minus}.`,
    '- 6 findings raised: 1 high, 3 medium, 2 low. 1 fixed, 1 refuted, 1 let stand, 1 declined, 1 filed, 1 open.',
    '- Recorded agent tokens 385: cad-reviewer 305, review-checker 50, cad-assumptions-analyzer 30. The session\'s own tokens aren\'t recorded.',
  ]);
  assert.deepEqual(tree(root), before);
});

test('with no review record and no run recorded, the Evidence says so rather than counting zero as a figure', (t) => {
  const { dir } = built(t);
  const r = run(dir, 'evidence');
  assert.deepEqual([r.ok, r.evidence.findings.raised, r.evidence.tokens.total], [true, 0, 0]);
  assert.deepEqual(r.text.slice(2), ['- No findings raised.', '- No agent tokens recorded. The session\'s own tokens aren\'t recorded.']);
});

test('the Evidence is only of an epic at its acceptance, and asking off it writes nothing', (t) => {
  const root = join(scratch('cad-agile-evidence-', t), 'repo');
  execFileSync('git', ['init', '-q', '-b', 'work', root]);
  const dir = answerSetup(join(root, '.planning'));
  assert.equal(run(dir, 'start', '--design', FIXTURE).ok, true);
  const before = tree(root);
  const r = run(dir, 'evidence');
  assert.deepEqual([r.ok, r.reason, r.detail, r._exit], [false, 'not-accepting', 'E-01 is at refine, not accept', 1]);
  assert.deepEqual(tree(root), before);
});

const setBase = (agile, id, base) => {
  const file = join(agile, 'epics', 'E-01', `${id}.md`);
  writeFileSync(file, readFileSync(file, 'utf8').replace(/^- Base: .*$/m, `- Base: ${base}`));
};

test('a Base that is not a commit is named and left out, and nothing in it reaches git as an option', (t) => {
  const { root, dir, agile } = built(t);
  const outside = join(root, '..', 'outside');
  setBase(agile, 'E-01-2', `--output=${outside}`);
  const r = run(dir, 'evidence');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(existsSync(`${outside}..HEAD`), false);
  assert.match(r.text.at(-1), /^- Left out, since they couldn't be read: Base "--output=.*", not a commit here\.$/);
  setBase(agile, 'E-01-1', 'deadbeefdeadbeef');
  const none = run(dir, 'evidence');
  assert.deepEqual([none.ok, none.evidence.since, none.evidence.commits], [true, null, 0]);
  assert.equal(none.text[1], '- No story recorded where it began, so no commits are counted.');
  assert.equal(none.evidence.unread.length, 2);
});

test('a damaged review record is named and left out while the rest is counted, and odd entries and keys stay plain counts', (t) => {
  const { dir, agile } = built(t);
  const home = join(agileTasksDir(agile), 'E-01-1');
  mkdirSync(join(home, 'ADJUDICATION-dir.json'), { recursive: true });
  writeFileSync(join(home, 'ADJUDICATION-cut.json'), '{"entries": [ trunc');
  writeFileSync(join(home, 'ADJUDICATION-odd.json'), JSON.stringify({ entries: [null, 3, { severity: '__proto__', ruling: 'refuted' },
    { severity: 'constructor', fix_commit: 'abc1234' }, { ruling: 'survived' }, { severity: 'low', ruling: 'survived' }] }));
  writeFileSync(join(agileTasksDir(agile), 'E-01-2'), 'a file where a folder goes');
  const r = run(dir, 'evidence');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.evidence.findings, { raised: 4, severity: { unrated: 3, low: 1 }, outcome: { refuted: 1, fixed: 1, open: 2 } });
  assert.deepEqual(r.evidence.unread, ["E-01-1's ADJUDICATION-cut.json", "E-01-1's ADJUDICATION-dir.json", "E-01-2's review folder"]);
  assert.equal(r.text[2], '- 4 findings raised: 1 low, 3 unrated. 1 fixed, 1 refuted, 2 open.');
});

test('a repeated close counts once, as the record\'s renderer counts it, and only whole non-negative tokens count', (t) => {
  const { dir } = built(t);
  mkdirSync(join(dir, 'records'), { recursive: true });
  const close = JSON.stringify({ corr: 'A', phase: '0', ts: 'T1', family: 'lifecycle', event: 'return', plan: 'E-01-1-review', role: 'cad-reviewer', tokens: 100, turns: 4 });
  writeFileSync(join(dir, 'records', 'trace.jsonl'), [
    JSON.stringify({ corr: 'A', event: 'dispatch', plan: 'E-01-1', role: 'cad-agile' }), close, close,
    JSON.stringify({ corr: 'A', ts: 'T2', event: 'return', plan: 'E-01-1-review', role: 'cad-reviewer', tokens: 100, turns: 4 }),
    '{"corr":"A","ts":"T3","event":"return","plan":"x","role":"cad-executor","tokens":1e999}',
    JSON.stringify({ corr: 'A', ts: 'T4', event: 'return', plan: 'x', role: 'cad-executor', tokens: -50 }),
    JSON.stringify({ corr: 'A', ts: 'T5', event: 'return', plan: 'x', role: 'cad-executor', tokens: 1.5 }),
    JSON.stringify({ corr: 'A', ts: 'T6', event: 'return', plan: 'x', role: '__proto__', tokens: 7 }),
    JSON.stringify({ corr: 'A', ts: 'T7', event: 'return', plan: 'x', role: 'constructor', tokens: 3 }),
  ].join('\n') + '\n');
  const r = run(dir, 'evidence');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.evidence.tokens.total, 210);
  assert.deepEqual(Object.entries(r.evidence.tokens.role), [['cad-reviewer', 200], ['__proto__', 7], ['constructor', 3]]);
});

test('the record is read as far as its own reader reads it, the first 1 MiB of each file', (t) => {
  const { dir } = built(t);
  mkdirSync(join(dir, 'records'), { recursive: true });
  const pad = JSON.stringify({ corr: 'Z', event: 'note', pad: 'x'.repeat(1000) });
  writeFileSync(join(dir, 'records', 'trace.jsonl'), [
    JSON.stringify({ corr: 'A', event: 'dispatch', plan: 'E-01-1', role: 'cad-agile' }),
    JSON.stringify({ corr: 'A', ts: 'T1', event: 'return', plan: 'p', role: 'cad-reviewer', tokens: 10 }),
    ...Array(1100).fill(pad),
    JSON.stringify({ corr: 'A', ts: 'T2', event: 'return', plan: 'p', role: 'cad-reviewer', tokens: 5000 }),
  ].join('\n') + '\n');
  assert.equal(run(dir, 'evidence').evidence.tokens.total, 10);
});

test('an epic marked review by hand with a story not done, or with none, gives no Evidence, as it gets no acceptance', (t) => {
  const { root, dir, agile } = built(t);
  const epic = join(agile, 'epics', 'E-01', 'epic.md');
  writeFileSync(epic, readFileSync(epic, 'utf8').replace(/^status: .*$/m, 'status: review'));
  const story = join(agile, 'epics', 'E-01', 'E-01-2.md');
  writeFileSync(story, readFileSync(story, 'utf8').replace(/^status: .*$/m, 'status: in-progress'));
  const before = tree(root);
  const r = run(dir, 'evidence');
  assert.deepEqual([r.ok, r.reason, r.detail], [false, 'not-accepting', "E-01-2 of E-01 isn't done"]);
  assert.deepEqual(tree(root), before);
});

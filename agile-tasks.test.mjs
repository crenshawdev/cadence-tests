// Zero-dep tests for a /cad-task run on an agile project: where its record, review and rulings land, and who reads them back.
// Run: node --test tests/agile-tasks.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerSetup, scratch } from './planning.test.mjs';
import { markAgile, statePath } from '../cadence-core/bin/lib/project-state.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', 'cadence-core', 'bin');
const FIXTURE = join(HERE, 'fixtures', 'seldon-design');

const call = (cwd, script, args, env = {}) => {
  const r = spawnSync('node', [join(BIN, script), ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  return JSON.parse(r.stdout);
};
const planning = (cwd, ...args) => call(cwd, 'planning.mjs', args);
const git = (root, ...args) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' }).trim();

/** A started release and one task commit, with the task's folder made as `--plan` makes it. */
function taskRun(t) {
  const root = scratch('cad-agile-tasks-', t);
  git(root, 'init', '-q', '-b', 'work');
  const dir = answerSetup(join(root, '.planning'));
  assert.equal(call(root, 'agile.mjs', ['start', '--design', FIXTURE]).ok, true);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'start');
  const base = git(root, 'rev-parse', 'HEAD');
  writeFileSync(join(root, 'ladder.txt'), 'a ladder\n');
  git(root, 'add', 'ladder.txt');
  git(root, 'commit', '-q', '-m', 'feat: lend a ladder');
  return { root, dir, base, head: git(root, 'rev-parse', 'HEAD'), top: readdirSync(dir).sort() };
}

const record = (root, base, slug = 'lend-ladder') =>
  planning(root, 'task-record', '--slug', slug, '--base', base, '--head', 'HEAD', '--text', 'Members can borrow a stepladder.');

const file = (root, name, value) => {
  writeFileSync(join(root, name), JSON.stringify(value));
  return join(root, name);
};

test('a task\'s record lands in the release\'s folder, recall and why find it there, and the top of .planning gains nothing', (t) => {
  const { root, dir, base, head, top } = taskRun(t);
  const marker = readFileSync(statePath(dir), 'utf8');
  const r = record(root, base);
  assert.deepEqual([r.ok, r.written, r.record, r.commits], [true, true, join('.planning', 'agile', 'tasks', 'lend-ladder', 'RECORD.md'), 1], JSON.stringify(r));
  const bytes = readFileSync(join(root, r.record), 'utf8');
  assert.ok(bytes.includes(head));
  assert.equal(record(root, base).ok, true);
  assert.equal(readFileSync(join(root, r.record), 'utf8'), bytes);

  const found = planning(root, 'recall', 'stepladder');
  assert.deepEqual(found.results.map((h) => h.source), ['agile/tasks/lend-ladder/RECORD.md']);
  const why = call(root, 'why.mjs', ['ladder.txt']);
  assert.deepEqual([why.entries[0].join.state, why.entries[0].join.slug, why.entries[0].join.label], ['resolved', 'lend-ladder', 'agile/tasks/lend-ladder']);
  assert.deepEqual(readdirSync(dir).sort(), top);
  assert.equal(readFileSync(statePath(dir), 'utf8'), marker);
  assert.equal(call(root, 'agile.mjs', ['next']).next.id, 'E-01', 'the release still reads');
});

test('a task\'s review and rulings land beside its plan, and a receipt is counted against the rulings there', (t) => {
  const { root, dir, base, head, top } = taskRun(t);
  const fire = ['--phase', '0', '--task', 'lend-ladder', '--trigger', 'risk_surface', '--discriminator', `${base.slice(0, 7)}-${head.slice(0, 7)}`,
    '--base', base, '--head', head];
  const rulings = file(root, 'rulings.json', { voices: [{ voice: 'claude-subagent', model: 'opus', returned: { findings: [
    { file: 'ladder.txt', line: 1, severity: 'low', claim: 'the ladder has no id', failure_scenario: 'two ladders read the same' }] },
  rulings: [{ finding: 0, ruling: 'survived', claim: 'the ladder has no id', failure_scenario: 'two ladders read the same' }] }] });
  const review = file(root, 'review.json', { raised: 1, survivors: [{ file: 'ladder.txt', line: 1, severity: 'low', voices: ['opus'],
    what_breaks: 'Two ladders read the same.', why_care: 'A wrong loan.', what_triggers: 'A second ladder.', what_proves: 'Add one.',
    what_uncertain: 'Nothing.', recommendation: 'Number it.' }] });
  // no folder for the task yet, which is the inline path
  for (const [cmd, payload] of [['adjudication', rulings], ['review-file', review]]) {
    const r = planning(root, cmd, ...fire, '--payload', payload);
    assert.deepEqual([r.ok, r.reason], [false, 'no-task-dir'], JSON.stringify(r));
    assert.match(r.detail, /agile\/tasks\/lend-ladder\//);
  }
  for (const [name, args] of [['no task', []], ['a bad one', ['--task', 'a/b']]]) {
    const r = planning(root, 'adjudication', '--phase', '0', ...args, ...fire.slice(4), '--payload', rulings);
    assert.deepEqual([r.ok, /\.planning\/agile\/tasks\/<slug>\//.test(`${r.detail} ${r.hint}`)], [false, true], `${name}: ${JSON.stringify(r)}`);
  }
  mkdirSync(join(dir, 'agile', 'tasks', 'lend-ladder'), { recursive: true });
  const ruled = planning(root, 'adjudication', ...fire, '--payload', rulings);
  assert.equal(ruled.ok, true, JSON.stringify(ruled));
  const reviewed = planning(root, 'review-file', ...fire, '--payload', review);
  assert.equal(reviewed.ok, true, JSON.stringify(reviewed));
  for (const path of [ruled.record, reviewed.review]) {
    assert.ok(path.split(/[/\\]/).join('/').startsWith('agile/tasks/lend-ladder/'), path);
    assert.ok(existsSync(join(dir, path)), path);
  }
  const receipt = (survivors) => planning(root, 'trace', 'append', '--phase', '0', '--family', 'outcome', '--event', 'gate_pass',
    '--trigger', 'risk_surface', '--base', base, '--sha', head, '--survivors', survivors, '--downgraded', '0', '--refuted', '0');
  const wrong = receipt('9');
  assert.deepEqual([wrong.ok, wrong.reason], [false, 'count-disagreement'], JSON.stringify(wrong));
  assert.match(wrong.detail, /agile\/tasks\/lend-ladder\//);
  assert.equal(receipt('1').ok, true);
  assert.deepEqual(readdirSync(dir).sort(), top);
});

test('an on-demand review opens no run on an agile project, so a task in flight beside it keeps its bracket', (t) => {
  const { root } = taskRun(t);
  for (const path of [['cadence-core', 'workflows', 'decision-review.md'], ['cadence-core', 'workflows', 'minimalism-review.md'], ['skills', 'cad-plan-review', 'SKILL.md']]) {
    assert.equal(readFileSync(join(HERE, '..', ...path), 'utf8').includes('phase_start'), false, path.at(-1));
  }
  const trace = (...args) => planning(root, 'trace', ...args);
  const open = (plan, role) => trace('append', '--phase', '0', '--family', 'lifecycle', '--event', 'dispatch', '--plan', plan, '--role', role, '--read', 'ladder.txt');
  const close = (plan, role) => trace('close', '--phase', '0', '--plan', plan, '--role', role);
  trace('append', '--phase', '0', '--family', 'lifecycle', '--event', 'phase_start', '--sha', 'abc1234-one');
  open('lend-ladder', 'cad-task');
  for (const step of [open, open, close, close]) assert.equal(step('cad-reviewer', 'cad-reviewer').written, true);
  close('lend-ladder', 'cad-task');
  const seen = trace('render', '--phase', '0');
  assert.deepEqual([seen.unpaired, seen.brackets.map((b) => [b.corr, b.role])],
    [[], [['0-abc1234-one', 'cad-reviewer'], ['0-abc1234-one', 'cad-reviewer'], ['0-abc1234-one', 'cad-task']]]);
});

test('each debug fix opens its own run before its risk check, so one session can\'t spend another\'s re-arm', () => {
  const prose = readFileSync(join(HERE, '..', 'cadence-core', 'workflows', 'debug.md'), 'utf8');
  const anchor = prose.indexOf('--event phase_start');
  assert.ok(anchor > prose.indexOf('## Resolve') && anchor < prose.indexOf('risk-check run'));
});

test('a debug session\'s staged fix is reviewed under its slug, and its receipt is counted there', (t) => {
  const { root, dir } = taskRun(t);
  writeFileSync(join(root, 'login.mjs'), 'export function login(password) { return password === process.env.SECRET; }\n');
  git(root, 'add', 'login.mjs');
  const staged = planning(root, 'risk-check', 'run', '--phase', '0', '--base', 'HEAD', '--staged');
  assert.ok(staged.matches.length > 0, JSON.stringify(staged));
  const head = git(root, 'rev-parse', 'HEAD');
  mkdirSync(join(dir, 'agile', 'tasks', 'login-fails'), { recursive: true });
  const fire = ['--phase', '0', '--task', 'login-fails', '--trigger', 'risk_surface', '--discriminator', `debug-${head.slice(0, 7)}`, '--base', head, '--head', head];
  const rulings = file(root, 'rulings.json', { voices: [{ voice: 'claude-subagent', model: 'opus', returned: { findings: [
    { file: 'login.mjs', line: 1, severity: 'low', claim: 'plain compare', failure_scenario: 'a timing guess' }] },
  rulings: [{ finding: 0, ruling: 'survived', claim: 'plain compare', failure_scenario: 'a timing guess' }] }] });
  const ruled = planning(root, 'adjudication', ...fire, '--payload', rulings);
  assert.equal(ruled.record.split(/[/\\]/).join('/'), `agile/tasks/login-fails/ADJUDICATION-risk_surface-debug-${head.slice(0, 7)}.json`, JSON.stringify(ruled));
  const receipt = (survivors) => planning(root, 'trace', 'append', '--phase', '0', '--family', 'outcome', '--event', 'gate_pass',
    '--trigger', 'risk_surface', '--sha', head, '--survivors', survivors, '--downgraded', '0', '--refuted', '0');
  assert.equal(receipt('9').reason, 'count-disagreement');
  assert.equal(receipt('1').ok, true);
});

/** A `gh` that says the repository is public and creates whatever it's asked to. */
function fakeForge(root) {
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), ['#!/bin/sh', 'echo "$*" | tr "\\n" " " >> "$CAD_LOG"', 'case "$2" in',
    'list) echo "[]" ;;', 'view) echo \'{"visibility":"PUBLIC"}\' ;;', 'create) echo "https://tracker.test/octo/toolshed/issues/1" ;;', 'esac', 'exit 0'].join('\n'));
  chmodSync(join(bin, 'gh'), 0o755);
  const log = join(root, 'gh.log');
  writeFileSync(log, '');
  return { env: { PATH: `${bin}${delimiter}${process.env.PATH}`, CAD_LOG: log, CADENCE_GLOBAL_CONFIG: join(root, 'no-global.json') }, log };
}

const finding = (claim) => ({ file: 'ladder.txt', line: 1, severity: 'low', claim, failure_scenario: `what breaks: ${claim}` });
const NO = finding('the ladder has no id');
const YES = finding('the ladder is not listed');

test('a finding said no to lands in declined.md and one filed in filed.md, and neither is asked about or filed again', (t) => {
  const { root, dir, top } = taskRun(t);
  const { env, log } = fakeForge(root);
  const filing = (sub, payload) => call(root, 'issue-filing.mjs', [sub, '--payload', payload], env);
  const answers = file(root, 'answers.json', { entries: [{ finding: NO, disposition: 'decline' }, { finding: YES, disposition: 'accept' }] });
  const raised = file(root, 'raised.json', { voices: [{ voice: 'claude-subagent', model: 'opus', returned: { findings: [NO] },
    rulings: [{ finding: 0, ruling: 'survived', claim: NO.claim, failure_scenario: NO.failure_scenario }] }] });
  assert.equal(filing('unfixed', raised).findings.length, 1);
  const r = filing('file', answers);
  assert.deepEqual([r.ok, r.declined, r.accepted], [true, 1, 1], JSON.stringify(r));

  const text = (name) => readFileSync(join(dir, 'agile', name), 'utf8');
  assert.ok(text('declined.md').includes(NO.claim) && !text('declined.md').includes(YES.claim));
  assert.ok(text('filed.md').includes(YES.claim) && !text('filed.md').includes(NO.claim));
  assert.doesNotMatch(text('declined.md') + text('filed.md'), /CAPTURE\.md|ARCHIVE\.md|FILED\.md|DECLINED\.md/);
  const again = filing('unfixed', raised);
  assert.deepEqual([again.findings, again.already_declined], [[], 1]);
  const creates = () => readFileSync(log, 'utf8').split('issue create').length - 1;
  assert.equal(creates(), 1);
  assert.deepEqual(planning(root, 'recall', 'listed').results.map((h) => h.source), ['agile/filed.md']);
  assert.deepEqual(planning(root, 'recall', 'id').results, []);
  assert.deepEqual(readdirSync(dir).sort(), top);
  for (const name of ['DECLINED.md', 'FILED.md']) assert.equal(existsSync(join(dir, 'records', name)), false, name);
});

test('a todo, a seed and a note land in the backlog under their own headings with no phase, and recall finds them', (t) => {
  const { root, dir, top } = taskRun(t);
  const capture = (...args) => planning(root, 'capture', ...args);
  for (const [kind, text] of [['todo', 'weigh the marquee poles'], ['seed', 'lend a marquee'], ['note', 'the marquee is in the shed']]) {
    const r = capture('--kind', kind, '--text', text);
    assert.deepEqual([r.ok, r.file], [true, join('.planning', 'agile', 'backlog.md')], JSON.stringify(r));
  }
  const text = readFileSync(join(dir, 'agile', 'backlog.md'), 'utf8');
  const under = (heading) => text.slice(text.indexOf(heading)).split('\n## ')[0];
  assert.match(under('## Todos'), /^- \[ \] weigh the marquee poles$/m);
  assert.match(under('## Seeds'), /^- lend a marquee$/m);
  assert.match(under('## Notes'), /^- \d{4}-\d\d-\d\d the marquee is in the shed$/m);
  const found = planning(root, 'recall', 'marquee').results;
  assert.deepEqual([found.length, new Set(found.map((h) => h.source))], [3, new Set(['agile/backlog.md'])]);
  for (const kind of ['todo', 'seed', 'note']) {
    const phased = capture('--kind', kind, '--text', 'x', '--phase', '2');
    assert.deepEqual([phased.ok, phased.reason, /backlog/.test(phased.hint)], [false, 'bad-args', true], JSON.stringify(phased));
  }
  assert.equal(readFileSync(join(dir, 'agile', 'backlog.md'), 'utf8'), text);
  // the --cadence queue is nobody's project
  const queue = join(root, 'queue', 'CAPTURE.md');
  assert.equal(capture('--kind', 'note', '--text', 'a Cadence note', '--file', queue).ok, true);
  assert.ok(existsSync(queue));
  assert.deepEqual(readdirSync(dir).sort(), top);
});

test('a project marked with no release refuses each write and makes nothing, so the next start still finishes', (t) => {
  const { root, dir, base } = taskRun(t);
  rmSync(join(dir, 'agile'), { recursive: true });
  const top = readdirSync(dir).sort();
  const r = record(root, base);
  assert.deepEqual([r.ok, r.written], [true, false], JSON.stringify(r));
  assert.match(r.reason, /\/cad-agile/);
  const captured = planning(root, 'capture', '--kind', 'todo', '--text', 'x');
  assert.deepEqual([captured.ok, captured.reason], [false, 'no-release'], JSON.stringify(captured));
  const { env, log } = fakeForge(root);
  const answers = file(root, 'answers.json', { entries: [{ finding: YES, disposition: 'accept' }] });
  for (const sub of ['file', 'unfixed']) {
    const refused = call(root, 'issue-filing.mjs', [sub, '--payload', answers], env);
    assert.deepEqual([refused.ok, refused.reason], [false, 'no-release'], JSON.stringify(refused));
  }
  assert.equal(readFileSync(log, 'utf8'), '', 'the tracker was asked for something');
  assert.deepEqual(readdirSync(dir).sort(), top);
  assert.equal(call(root, 'agile.mjs', ['start', '--design', FIXTURE]).ok, true);
});

test('a linked release folder or tasks folder is written through by nothing', (t) => {
  for (const build of [
    (dir, outside) => { rmSync(join(dir, 'agile'), { recursive: true }); symlinkSync(outside, join(dir, 'agile')); },
    (dir, outside) => { symlinkSync(outside, join(dir, 'agile', 'tasks')); },
  ]) {
    const { root, dir, base } = taskRun(t);
    const outside = scratch('cad-agile-outside-', t);
    build(dir, outside);
    const r = record(root, base);
    assert.equal(r.written, false, JSON.stringify(r));
    assert.equal(existsSync(join(outside, 'lend-ladder', 'RECORD.md')), false);
    assert.equal(existsSync(join(outside, 'tasks', 'lend-ladder', 'RECORD.md')), false);
    assert.equal(planning(root, 'recall', 'stepladder').total, 0);
  }
});

test('a project marked by a start that died is agile, and an old-path one keeps its own folders', (t) => {
  const root = scratch('cad-agile-old-', t);
  git(root, 'init', '-q');
  git(root, 'commit', '--allow-empty', '-q', '-m', 'root');
  const base = git(root, 'rev-parse', 'HEAD');
  writeFileSync(join(root, 'a.txt'), 'a\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'a');
  mkdirSync(join(root, '.planning'));
  assert.equal(record(root, base, 'old').record, join('.planning', 'tasks', 'old', 'RECORD.md'));
  const half = scratch('cad-agile-half-', t);
  mkdirSync(join(half, '.planning'));
  assert.equal(markAgile(join(half, '.planning')).ok, true);
  assert.equal(planning(half, 'recall', 'anything').total, 0);
});

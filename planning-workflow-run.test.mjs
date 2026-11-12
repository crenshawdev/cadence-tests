// Tests for `planning.mjs workflow-run` - a finished review-panel run becomes the record's payload and the review input.
// Run: node --test tests/planning-workflow-run.test.mjs
//
// Driven through the CLI on a scratch git repo, because the outcomes are what the REAL `adjudication` and `review-file`
// seams accept. The fixture is the spike's real run file trimmed (script, paths and previews removed, result replaced).
// Its three agent rows keep that run's figures, with labels and agent types set as workflows/review-panel.js sets them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { recordsDir } from '../cadence-core/bin/lib/planning-store.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLANNING = join(ROOT, 'cadence-core', 'bin', 'planning.mjs');
const FIXTURE = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'workflow-run.completed.json'), 'utf8'));
const { unfixedFindings } = await import(pathToFileURL(join(ROOT, 'cadence-core', 'bin', 'lib', 'filing-decision.mjs')));

const clone = (v) => JSON.parse(JSON.stringify(v));
const SIX = ['what_breaks', 'why_care', 'what_triggers', 'what_proves', 'what_uncertain', 'recommendation'];
const HEADINGS = ['What breaks', 'Why I should care', 'What triggers it', 'What proves it', 'What is still uncertain', 'Your recommendation'];
// the keys a record entry may carry today, from lib/adjudication-record.mjs and the seam that stores it
const ENTRY_KEYS = new Set(['voice', 'model', 'file', 'line', 'severity', 'claim', 'failure_scenario', 'ruling', 'convergent',
  'counter_evidence', 'fix_commit', 'fix_file', 'overridden', 'citation_missing', 'base_id', 'head_id']);

/** A scratch repo with two commits, a phase 1 directory and an empty out directory for the seam. */
function tree() {
  const repo = mkdtempSync(join(tmpdir(), 'cad-wfr-'));
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T');
  const dir = join(repo, '.planning');
  mkdirSync(join(dir, 'phases', '1'), { recursive: true });
  writeFileSync(join(repo, 'src.js'), 'let x = 1;\n'); git('add', '-A'); git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'src.js'), 'let x = 2;\n'); git('add', '-A'); git('commit', '-q', '-m', 'head');
  const head = git('rev-parse', 'HEAD');
  const out = join(repo, 'scratch'); mkdirSync(out);
  return { repo, dir, base, head, out };
}

function cli(t, args) {
  let stdout; let code = 0;
  try { stdout = execFileSync('node', [PLANNING, '--dir', t.dir, ...args], { encoding: 'utf8', cwd: t.repo }); } catch (e) { stdout = e.stdout; code = e.status; }
  return { ...JSON.parse(stdout), _exit: code };
}

/** Write a run (object or raw text) and call the seam on it; `answers` is written to its own file when given. */
function seam(t, run, answers) {
  const runFile = join(t.repo, 'run.json');
  writeFileSync(runFile, typeof run === 'string' ? run : JSON.stringify(run));
  const args = ['workflow-run', '--phase', '1', '--run-file', runFile, '--out-dir', t.out, '--payload-ref', `${t.base}..${t.head}`];
  if (answers) {
    const af = join(t.repo, `answers-${readdirSync(t.repo).length}.json`);
    writeFileSync(af, JSON.stringify({ answers }));
    args.push('--answers-file', af);
  }
  return cli(t, args);
}

const adjudicate = (t, payload) => cli(t, ['adjudication', '--phase', '1', '--trigger', 'diff', '--discriminator', 'abc1234',
  '--base', t.base, '--head', t.head, '--payload', payload]);
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));

/** The fixture with its one voice's findings and checker verdicts replaced. */
function runWith(findings, verdicts) {
  const run = clone(FIXTURE);
  run.result.voices[0].result = { findings };
  run.result.voices[0].rulings = verdicts.map((ruling, index) => ({ index, finding: findings[index], ruling }));
  return run;
}
const finding = (claim, severity = 'high') => ({ file: 'src/a.js', line: 3, severity, claim, failure_scenario: `${claim} breaks` });
const verdict = (ruling, more = {}) => ({
  ruling, severity: 'high', what_breaks: 'It breaks.', why_care: 'A user loses a row.', what_triggers: 'One row in.',
  what_proves: 'Line 3.', what_uncertain: 'Supported by inspection.', recommendation: 'Fix it.', ...more,
});
const texts = (more = {}) => ({ what_breaks: 'It breaks.', why_care: 'A user loses a row.', what_triggers: 'One row in.',
  what_proves: 'Line 3.', what_uncertain: 'Supported by inspection.', recommendation: 'Fix it.', ...more });
const emptyOut = (t) => readdirSync(t.out);

test('workflow-run: proved, refuted, neither and a null checker map as stated and the null is listed apart', () => {
  const t = tree();
  const r = seam(t, FIXTURE);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.counts, { raised: 4, survived: 2, downgraded: 0, refuted: 1, unruled: 1 });
  assert.deepEqual(r.voices, ['claude-subagent']);
  assert.equal(r.run_id, 'wf_9d70aeab-5d0');
  assert.equal(r.unruled.length, 1);
  assert.deepEqual([r.unruled[0].voice, r.unruled[0].index], ['claude-subagent', 3]);
  assert.match(r.unruled[0].reason, /returned nothing/);
  const rulings = readJson(r.payload).voices[0].rulings;
  assert.deepEqual(rulings.map((x) => [x.finding, x.ruling]), [[0, 'survived'], [1, 'refuted'], [2, 'survived']]);
  assert.deepEqual(rulings[1].counter_evidence, { file: 'src/b.js', line: 9, note: 'The bound is checked there.' });
  assert.equal(rulings[0].claim, 'proved claim');
  assert.equal(rulings[0].failure_scenario, 'proved claim breaks');
  // the model comes from the reviewer's own row in the run file
  assert.equal(readJson(r.payload).voices[0].model, 'claude-sonnet-5-5');
  const review = readJson(r.review_input);
  assert.equal(review.raised, 4);
  assert.equal(review.survivors.length, 2);
  const suspected = review.survivors[1];
  assert.match(suspected.what_uncertain, /^Suspected, not proved\. The next check: Run it with a one-row input\./);
  assert.doesNotMatch(review.survivors[0].what_uncertain, /Suspected/);
  assert.equal(r.ready, false);
});

test('workflow-run: proved below the raised severity is downgraded and shown lower; proved above stands at the raised one', () => {
  const t = tree();
  const run = runWith([finding('lower'), finding('higher', 'medium')], [verdict('proved', { severity: 'low' }), verdict('proved', { severity: 'blocker' })]);
  const r = seam(t, run);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.counts, { raised: 2, survived: 1, downgraded: 1, refuted: 0, unruled: 0 });
  assert.deepEqual(readJson(r.payload).voices[0].rulings.map((x) => x.ruling), ['downgraded', 'survived']);
  assert.deepEqual(readJson(r.review_input).survivors.map((s) => s.severity), ['blocker', 'low']);
  assert.equal(r.ready, false, 'the one proved up to blocker is open');
  const settled = seam(t, run, [{ voice: 'claude-subagent', index: 1, fix_commit: 'abc1234' }]);
  assert.equal(settled.ready, true, settled.not_ready);
  assert.equal(adjudicate(t, settled.payload).ok, true);
});

test('workflow-run: a medium its checker proves high shows high and is listed as needing an answer', () => {
  const t = tree();
  const r = seam(t, runWith([finding('rerank', 'medium')], [verdict('proved', { severity: 'high' })]));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(readJson(r.review_input).survivors.map((s) => s.severity), ['high']);
  assert.deepEqual(r.needs_answer.map((n) => [n.index, n.severity]), [[0, 'high']]);
  // the record's verbatim half keeps the raised severity
  assert.equal(readJson(r.payload).voices[0].returned.findings[0].severity, 'medium');
  const fixed = seam(t, runWith([finding('rerank', 'medium')], [verdict('proved', { severity: 'high' })]),
    [{ voice: 'claude-subagent', index: 0, fix_commit: 'abc1234' }]);
  assert.deepEqual(fixed.needs_answer, []);
});

test('workflow-run: a proved high needs an answer, and adjudication and unfixedFindings both refuse until it settles', () => {
  const t = tree();
  const run = runWith([finding('one')], [verdict('proved')]);
  const r = seam(t, run);
  assert.deepEqual(r.needs_answer.map((n) => [n.voice, n.index, n.severity, n.suspected]), [['claude-subagent', 0, 'high', false]]);
  assert.equal(r.ready, false);
  assert.match(r.not_ready, /none of a usable fix_commit, a fix_file or overridden/);
  assert.equal(adjudicate(t, r.payload).ok, false);
  assert.equal(unfixedFindings(readJson(r.payload)).ok, false);

  const fixed = seam(t, run, [{ voice: 'claude-subagent', index: 0, fix_commit: 'abc1234' }]);
  assert.equal(fixed.ready, true, fixed.not_ready);
  assert.deepEqual(fixed.needs_answer, []);
  assert.equal(adjudicate(t, fixed.payload).ok, true);
});

test('workflow-run: a blocker its checker proves high still needs an answer, and a fix or an override re-ruled survived settles it', () => {
  const t = tree();
  const run = runWith([finding('one', 'blocker')], [verdict('proved', { severity: 'high' })]);
  const r = seam(t, run);
  assert.deepEqual(r.counts, { raised: 1, survived: 0, downgraded: 1, refuted: 0, unruled: 0 });
  assert.deepEqual(r.needs_answer.map((n) => [n.index, n.severity]), [[0, 'high']]);
  assert.equal(r.ready, false);
  assert.match(r.not_ready, /blocker or high/);

  const fixed = seam(t, run, [{ voice: 'claude-subagent', index: 0, fix_commit: 'abc1234' }]);
  assert.equal(fixed.ready, true, fixed.not_ready);
  assert.deepEqual(fixed.needs_answer, []);
  assert.equal(adjudicate(t, fixed.payload).ok, true);

  const t2 = tree();
  const over = seam(t2, run, [{ voice: 'claude-subagent', index: 0, ruling: 'survived', overridden: true }]);
  assert.equal(over.ready, true, over.not_ready);
  assert.deepEqual(over.needs_answer, []);
  const adj = adjudicate(t2, over.payload);
  assert.equal(adj.ok, true, JSON.stringify(adj));
  const [entry] = readJson(join(t2.dir, 'phases', '1', 'ADJUDICATION-diff-abc1234.json')).entries;
  assert.deepEqual([entry.ruling, entry.overridden], ['survived', true]);

  // a blocker proved only medium leaves the halting severities and asks for nothing
  const low = seam(tree(), runWith([finding('two', 'blocker')], [verdict('proved', { severity: 'medium' })]));
  assert.deepEqual(low.needs_answer, []);
  assert.equal(low.ready, true, low.not_ready);
});

test('workflow-run: a fix_commit, overridden: true and a refuted ruling with counter_evidence each settle a high', () => {
  const run = runWith([finding('p'), finding('q'), finding('s')], [verdict('proved'), verdict('proved'), verdict('neither')]);
  const answers = [
    { voice: 'claude-subagent', index: 0, fix_commit: 'abc1234' },
    { voice: 'claude-subagent', index: 1, overridden: true },
    { voice: 'claude-subagent', index: 2, ruling: 'refuted', counter_evidence: { file: 'src/b.js', line: 4, note: 'The check ran and the bound holds.' } },
  ];
  const t = tree();
  const r = seam(t, run, answers);
  assert.equal(r.ready, true, r.not_ready);
  assert.deepEqual(r.counts, { raised: 3, survived: 2, downgraded: 0, refuted: 1, unruled: 0 });
  const adj = adjudicate(t, r.payload);
  assert.equal(adj.ok, true, JSON.stringify(adj));
  assert.equal(unfixedFindings(readJson(r.payload)).ok, true);
  const record = readJson(join(t.dir, 'phases', '1', 'ADJUDICATION-diff-abc1234.json'));
  for (const e of record.entries) for (const k of Object.keys(e)) assert.ok(ENTRY_KEYS.has(k), `a new record key: ${k}`);
  assert.deepEqual(record.entries.map((e) => e.ruling), ['survived', 'survived', 'refuted']);
  assert.equal(record.entries[1].overridden, true);

  // the same refuted answer with no counter_evidence is refused: the finding lands with the nulls and the record won't take it
  const t2 = tree();
  const bare = seam(t2, run, [...answers.slice(0, 2), { voice: 'claude-subagent', index: 2, ruling: 'refuted' }]);
  assert.equal(bare.ready, false);
  assert.match(bare.unruled[0].reason, /counter_evidence\.file/);
  assert.equal(adjudicate(t2, bare.payload).ok, false);
});

test('workflow-run: a fix_file answer reaches the payload and settles a high', () => {
  const t = tree();
  const run = runWith([finding('one')], [verdict('proved')]);
  const r = seam(t, run, [{ voice: 'claude-subagent', index: 0, fix_file: 'local.cfg' }]);
  assert.equal(r.ready, true, r.not_ready);
  assert.deepEqual(r.needs_answer, []);
  assert.equal(readJson(r.payload).voices[0].rulings[0].fix_file, 'local.cfg');
  assert.equal(adjudicate(t, r.payload).ok, true);
  const bad = seam(tree(), run, [{ voice: 'claude-subagent', index: 0, fix_file: 7 }]);
  assert.match(bad.detail || bad.reason || JSON.stringify(bad), /fix_file must be text/);
});

test('workflow-run: a null is ruled in one round and settled in the next, and a later settlement replaces the earlier', () => {
  const t = tree();
  const run = runWith([finding('lost')], [null]);
  const first = seam(t, run, [{ voice: 'claude-subagent', index: 0, ruling: 'survived', ...texts() }]);
  assert.equal(first.counts.unruled, 0);
  assert.equal(first.ready, false, 'a survived high is still unsettled');
  assert.deepEqual(first.needs_answer.map((n) => n.index), [0]);

  const second = seam(t, run, [{ voice: 'claude-subagent', index: 0, fix_commit: 'abc1234' }]);
  assert.equal(second.ready, true, second.not_ready);
  assert.deepEqual(readJson(second.payload).voices[0].rulings[0].fix_commit, 'abc1234');
  assert.equal(readJson(second.review_input).survivors[0].what_breaks, 'It breaks.', 'round one\'s ruling survived round two');

  const third = seam(t, run, [{ voice: 'claude-subagent', index: 0, overridden: true }]);
  const entry = readJson(third.payload).voices[0].rulings[0];
  assert.equal(entry.overridden, true);
  assert.equal('fix_commit' in entry, false, 'the later settlement replaced the earlier one');
  assert.deepEqual(readJson(third.answers).answers.length, 1);
});

test('workflow-run: a refuted with no counter_evidence, a neither with no next check and a blank heading are listed with the nulls', () => {
  const t = tree();
  const run = runWith([finding('r', 'medium'), finding('n', 'medium'), finding('b', 'medium')], [
    verdict('refuted'), verdict('neither', { what_proves: '  ' }), verdict('proved', { why_care: '   ' }),
  ]);
  const r = seam(t, run);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.counts, { raised: 3, survived: 0, downgraded: 0, refuted: 0, unruled: 3 });
  assert.match(r.unruled[0].reason, /counter_evidence\.file/);
  assert.match(r.unruled[1].reason, /no next check/);
  assert.match(r.unruled[2].reason, /"Why I should care"/);
  assert.equal(adjudicate(t, r.payload).ok, false);

  const fixed = seam(t, run, [
    { voice: 'claude-subagent', index: 0, ruling: 'refuted', counter_evidence: { file: 'src/b.js' } },
    { voice: 'claude-subagent', index: 1, ruling: 'survived', what_proves: 'Run it with one row.', fix_commit: 'abc1234' },
    { voice: 'claude-subagent', index: 2, ruling: 'survived', why_care: 'A user loses a row.', fix_commit: 'abc1234' },
  ]);
  assert.equal(fixed.counts.unruled, 0, JSON.stringify(fixed.unruled));
  assert.equal(fixed.ready, true, fixed.not_ready);
  assert.equal(adjudicate(t, fixed.payload).ok, true);
});

test('workflow-run: the survivors file passes the review-file seam and yields six headings per survivor', () => {
  const t = tree();
  const r = seam(t, FIXTURE, [
    { voice: 'claude-subagent', index: 3, ruling: 'survived', ...texts() },
  ]);
  assert.equal(r.counts.survived, 3);
  const rf = cli(t, ['review-file', '--phase', '1', '--trigger', 'diff', '--discriminator', 'abc1234', '--base', t.base, '--head', t.head, '--payload', r.review_input]);
  assert.equal(rf.ok, true, JSON.stringify(rf));
  assert.deepEqual([rf.raised, rf.survivors], [4, 3]);
  const text = readFileSync(join(t.dir, rf.review), 'utf8');
  for (const h of HEADINGS) assert.equal(text.split('\n').filter((l) => l === `### ${h}`).length, 3, h);
});

test('workflow-run: a voice that did not run is named and dropped, and one that all failed is a refusal', () => {
  const t = tree();
  const run = clone(FIXTURE);
  run.result.voices.push({ voice: 'openai', ran: false, reason: 'no provider arm in this script yet', result: null, rulings: [] });
  const r = seam(t, run);
  assert.deepEqual(r.dropped, [{ voice: 'openai', reason: 'no provider arm in this script yet' }]);
  assert.deepEqual(r.voices, ['claude-subagent']);

  const t2 = tree();
  run.result.voices[0] = { voice: 'claude-subagent', ran: false, reason: 'the reviewer returned nothing', result: null, rulings: [] };
  const none = seam(t2, run);
  assert.equal(none.ok, false);
  assert.equal(none.reason, 'run-no-voice');
  assert.deepEqual(emptyOut(t2), []);
});

test('workflow-run: each refusal gives its own reason and writes no payload or review input', () => {
  const big = ' '.repeat(8 * 1024 * 1024 + 1);
  const cases = [
    ['run-unreadable', (t) => cli(t, ['workflow-run', '--phase', '1', '--run-file', join(t.repo, 'nope.json'), '--out-dir', t.out, '--payload-ref', 'a..b'])],
    ['run-too-large', (t) => seam(t, big)],
    ['run-not-json', (t) => seam(t, '{ not json')],
    ['run-not-completed', (t) => seam(t, { ...clone(FIXTURE), status: 'killed', result: null })],
    ['run-not-completed', (t) => seam(t, { ...clone(FIXTURE), status: 'running' })],
    ['run-no-result', (t) => seam(t, { ...clone(FIXTURE), result: null })],
    ['run-no-result', (t) => { const r = clone(FIXTURE); delete r.result; return seam(t, r); }],
    ['run-bad-result', (t) => seam(t, { ...clone(FIXTURE), result: 'review-panel runs the reviewers and started no agent.' })],
    ['run-bad-result', (t) => seam(t, { ...clone(FIXTURE), result: { voices: [{ voice: 'claude-subagent', ran: true, result: { findings: 'x' }, rulings: [] }] } })],
    ['run-no-voice', (t) => seam(t, { ...clone(FIXTURE), result: { voices: [] } })],
  ];
  for (const [reason, go] of cases) {
    const t = tree();
    const r = go(t);
    assert.equal(r.ok, false, reason);
    assert.equal(r.reason, reason, JSON.stringify(r));
    assert.ok(r.detail, reason);
    assert.deepEqual(emptyOut(t), [], `${reason} wrote a file`);
  }
});

test('workflow-run: bad answers are refused naming what is wrong, and nothing is written', () => {
  const run = runWith([finding('one', 'low')], [verdict('proved')]);
  for (const [answers, match] of [
    [[{ voice: 'claude-subagent', index: 0, ruling: 'fixed' }], /ruling must be one of/],
    [[{ voice: 'claude-subagent', index: 0, fix_comit: 'abc1234' }], /unknown key: fix_comit/],
    [[{ voice: 'claude-subagent', index: 0, overridden: 'yes' }], /overridden must be the boolean true/],
    [[{ index: 0 }], /voice must name/],
  ]) {
    const t = tree();
    const r = seam(t, run, answers);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'bad-answers');
    assert.match(r.detail, match);
    assert.deepEqual(emptyOut(t), []);
  }
});

test('workflow-run: flags it needs are refused at the door', () => {
  const t = tree();
  const all = ['--phase', '1', '--run-file', 'x', '--out-dir', t.out, '--payload-ref', 'a..b'];
  const without = (flag) => { const i = all.indexOf(flag); return all.filter((_, j) => j !== i && j !== i + 1); };
  for (const flag of ['--phase', '--run-file', '--out-dir', '--payload-ref']) {
    assert.equal(cli(t, ['workflow-run', ...without(flag)]).reason, 'bad-args', flag);
  }
  assert.equal(cli(t, ['workflow-run', ...all, '--out-dir', join(t.repo, 'missing')]).reason, 'bad-args');
  assert.equal(cli(t, ['workflow-run', ...all, '--notice-tokens', '-5']).reason, 'bad-args');
  assert.equal(cli(t, ['workflow-run', ...all, '--notice-turns', '1.5']).reason, 'bad-args');
  assert.equal(existsSync(join(recordsDir(t.dir), 'trace.jsonl')), false, 'a refused call wrote no bracket');
});

// --- the brackets: one per workflow agent, billed from the run file ---------------------------------

const KILLED = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'workflow-run.killed.json'), 'utf8'));
const REF = 'abc1234..def5678';
const render = (t) => cli(t, ['trace', 'render', '--phase', '1']);
const rawEvents = (t) => cli(t, ['trace', 'render', '--phase', '1', '--events']).events;
const rowsOf = (run) => run.workflowProgress.filter((r) => r.type === 'workflow_agent');

test('workflow-run: three agents of three kinds, one not done, bill three brackets and leave nothing unpaired', () => {
  const t = tree();
  const run = clone(FIXTURE);
  const [wrapper, reviewer, checker] = rowsOf(run);
  wrapper.state = 'progress';
  const r = seam(t, run);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([r.brackets.source, r.brackets.written, r.brackets.already, r.brackets.failed], ['run-file', 3, 0, []]);

  const out = render(t);
  assert.deepEqual(out.unpaired, []);
  const by = Object.fromEntries(out.brackets.map((b) => [b.role, b]));
  assert.deepEqual(Object.keys(by).sort(), ['cad-reviewer', 'review-checker', 'review-provider-wrapper']);
  for (const [role, row] of [['cad-reviewer', reviewer], ['review-checker', checker], ['review-provider-wrapper', wrapper]]) {
    assert.equal(by[role].tokens, row.tokens, role);
    assert.equal(by[role].turns, row.toolCalls, role);
    assert.equal(by[role].duration_ms, row.durationMs, role);
    assert.equal(by[role].agent_id, row.agentId, role);
  }
  // the checker's spend is apart from the reviewer's, so the reviewer role's total still means the reviewers
  assert.deepEqual(out.roles['cad-reviewer'], { dispatches: 1, tokens: reviewer.tokens, turns: reviewer.toolCalls });
  assert.equal(out.roles['review-checker'].tokens, checker.tokens);
  assert.equal(by['review-provider-wrapper'].event, 'checkpoint', 'a not-done agent closes as a checkpoint');
  assert.equal(by['cad-reviewer'].event, 'return');
  assert.equal(by['review-checker'].event, 'return');

  const events = rawEvents(t).filter((e) => e.family === 'lifecycle');
  const dispatches = events.filter((e) => e.event === 'dispatch');
  assert.equal(dispatches.length, 3);
  assert.ok(dispatches.every((e) => e.plan.startsWith('wf_9d70aeab-5d0-') && e.read.length === 1 && e.read[0] === `${t.base}..${t.head}`), 'every key carries the run id and every read set is the payload reference');
  assert.equal(new Set(dispatches.map((e) => e.plan)).size, 3);
  assert.match(events.find((e) => e.event === 'checkpoint').detail, /state "progress"/);
  assert.equal(dispatches.find((e) => e.role === 'cad-reviewer').reviewer, 'claude-subagent');
});

test('workflow-run: a second call for the same run writes no second set, and a later answers round adds none either', () => {
  const t = tree();
  assert.equal(seam(t, FIXTURE).brackets.written, 3);
  const before = rawEvents(t).length;
  const again = seam(t, FIXTURE, [{ voice: 'claude-subagent', index: 3, fix_commit: 'abc1234' }]);
  assert.deepEqual([again.brackets.written, again.brackets.already], [0, 3]);
  assert.equal(rawEvents(t).length, before);
  assert.equal(render(t).brackets.length, 3);
});

test('workflow-run: an unreadable run file with the notice\'s totals bills exactly one bracket carrying them', () => {
  const t = tree();
  const call = () => cli(t, ['workflow-run', '--phase', '1', '--run-file', join(t.repo, 'wf_gone.json'), '--out-dir', t.out,
    '--payload-ref', REF, '--notice-tokens', '54242', '--notice-turns', '11', '--notice-duration-ms', '6072']);
  const r = call();
  assert.equal(r.reason, 'run-unreadable');
  assert.deepEqual([r.brackets.source, r.brackets.written], ['notice-totals', 1]);
  assert.deepEqual(emptyOut(t), []);
  const out = render(t);
  assert.equal(out.brackets.length, 1);
  assert.deepEqual([out.brackets[0].role, out.brackets[0].tokens, out.brackets[0].turns, out.brackets[0].duration_ms], ['review-workflow', 54242, 11, 6072]);
  assert.deepEqual(out.unpaired, []);
  assert.match(rawEvents(t).find((e) => e.event === 'return').detail, /completion notice/);
  assert.equal(rawEvents(t).find((e) => e.event === 'dispatch').plan, 'wf_gone-notice', 'the run id comes from the file name');
  assert.equal(call().brackets.written, 0, 'a retry bills it once');
  assert.equal(render(t).brackets.length, 1);

  // a readable file with no agent rows takes the same arm, and no totals means a bracket that says it is unrecorded
  const t2 = tree();
  const empty = { ...clone(FIXTURE), workflowProgress: [] };
  const r2 = seam(t2, empty);
  assert.equal(r2.ok, true);
  assert.deepEqual([r2.brackets.source, r2.brackets.written], ['notice-totals', 1]);
  const b = render(t2);
  assert.equal(b.brackets[0].tokens, null);
  assert.deepEqual(b.roles['review-workflow'], { dispatches: 1, unrecorded: 1 });
});

test('workflow-run: a retry with the run file gone writes no notice bracket on top of agents already billed', () => {
  const t = tree();
  assert.equal(seam(t, FIXTURE).brackets.written, 3);
  const r = cli(t, ['workflow-run', '--phase', '1', '--run-file', join(t.repo, 'wf_9d70aeab-5d0.json'), '--out-dir', t.out,
    '--payload-ref', REF, '--notice-tokens', '54242', '--notice-turns', '11', '--notice-duration-ms', '6072']);
  assert.equal(r.reason, 'run-unreadable');
  assert.deepEqual([r.brackets.source, r.brackets.written, r.brackets.already], ['notice-totals', 0, 1]);
  assert.equal(render(t).brackets.length, 3, 'the run is still billed per agent, once');
  assert.ok(!rawEvents(t).some((e) => String(e.plan).endsWith('-notice')));
});

test('workflow-run: a killed run is refused and still bills every agent row, its unfinished one as a checkpoint', () => {
  const t = tree();
  const rows = rowsOf(KILLED);
  assert.equal(rows.length, 7);
  const r = seam(t, KILLED);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'run-not-completed');
  assert.deepEqual([r.brackets.source, r.brackets.written], ['run-file', 7]);
  assert.deepEqual(emptyOut(t), []);

  const out = render(t);
  assert.equal(out.brackets.length, 7);
  assert.deepEqual(out.unpaired, []);
  assert.deepEqual(out.brackets.filter((b) => b.event === 'checkpoint').map((b) => b.agent_id), [rows[6].agentId]);
  // the figures are the run file's, so they sum to its own totals
  assert.equal(out.roles['cad-assumptions-analyzer'].tokens, KILLED.totalTokens);
  assert.equal(out.roles['cad-assumptions-analyzer'].turns, KILLED.totalToolCalls);
  const unfinished = out.brackets.find((b) => b.agent_id === rows[6].agentId);
  assert.equal('duration_ms' in unfinished, false, 'a figure the row lacks is left off, never 0');
  assert.equal(seam(t, KILLED).brackets.written, 0);
  assert.equal(render(t).brackets.length, 7);
});

test('workflow-run: trace suggest and the window report run on that record and count the new labels unbudgeted', () => {
  const t = tree();
  seam(t, FIXTURE);
  const suggest = cli(t, ['trace', 'suggest', '--phase', '1']);
  assert.equal(suggest.ok, true, JSON.stringify(suggest));
  const w = cli(t, ['trace', 'window', '--phase', '1']);
  assert.equal(w.ok, true, JSON.stringify(w));
  assert.equal(w.unbudgeted['review-checker'], 1);
  assert.equal(w.unbudgeted['review-provider-wrapper'], 1);
  assert.equal(w.unbudgeted['cad-reviewer'], undefined, 'the reviewer keeps its ceiling');
  assert.equal(w.compared, 1);
});

// --- a provider voice: the envelope on disk wins over the wrapper's retyping ---------------------------------

/** The fixture's local voice replaced by one proved finding, plus an `openai` voice whose envelope is written (or not) beside the run. */
function providerRun(t, retyped, env, verdicts, extra = {}) {
  const run = runWith([finding('local one', 'medium')], [verdict('proved', { severity: 'medium' })]);
  const envelope = join(t.repo, 'openai.envelope.json');
  if (env !== null) writeFileSync(envelope, typeof env === 'string' ? env : JSON.stringify(env));
  run.result.voices.push({ voice: 'openai', ran: true, model: 'gpt-5', result: { findings: retyped }, rulings: verdicts.map((ruling, index) => ({ index, finding: retyped[index], ruling })), envelope, ...extra });
  return run;
}
const mine = (claim) => finding(claim, 'medium');
const openaiRulings = (r) => readJson(r.payload).voices.find((v) => v.voice === 'openai').rulings;

test('workflow-run: a retyped claim one character off loses to the envelope, lands unruled, and the record stores the envelope\'s claim once answered', () => {
  const t = tree();
  const real = mine('the bound is off by one');
  const off = { ...real, claim: 'the bound is off by onE' };
  const run = providerRun(t, [off, mine('second')], { ok: true, findings: [real, mine('second')] }, [verdict('proved', { severity: 'medium' }), verdict('proved', { severity: 'medium' })]);
  const r = seam(t, run);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.counts, { raised: 3, survived: 2, downgraded: 0, refuted: 0, unruled: 1 });
  assert.deepEqual([r.unruled[0].voice, r.unruled[0].index], ['openai', 0]);
  assert.match(r.unruled[0].reason, /differs from the copy its checker read/);
  assert.deepEqual(r.providers, [{ voice: 'openai', source: 'envelope' }]);
  assert.equal(r.ready, false);
  assert.equal(adjudicate(t, r.payload).ok, false, 'the record refuses the payload while the finding is unruled');
  assert.equal(readJson(r.payload).voices[1].returned.findings[0].claim, 'the bound is off by one', 'returned is the envelope\'s');

  const answered = seam(t, run, [{ voice: 'openai', index: 0, ruling: 'survived', ...texts() }]);
  assert.equal(answered.ready, true, answered.not_ready);
  assert.equal(adjudicate(t, answered.payload).ok, true);
  const record = readJson(join(t.dir, 'phases', '1', 'ADJUDICATION-diff-abc1234.json'));
  assert.equal(record.entries.find((e) => e.voice === 'openai' && e.claim.startsWith('the bound')).claim, 'the bound is off by one');
});

test('workflow-run: a finding the agent left out lands unruled, and a retyped one the envelope lacks is dropped and named', () => {
  const t = tree();
  const run = providerRun(t, [mine('kept'), mine('invented')], { ok: true, findings: [mine('kept'), mine('left out')] },
    [verdict('proved', { severity: 'medium' }), verdict('proved', { severity: 'medium' })]);
  const r = seam(t, run);
  assert.deepEqual(r.counts, { raised: 3, survived: 2, downgraded: 0, refuted: 0, unruled: 1 });
  assert.deepEqual([r.unruled[0].voice, r.unruled[0].index], ['openai', 1]);
  assert.deepEqual(openaiRulings(r).map((x) => x.claim), ['kept']);
  assert.equal(r.notes.length, 1);
  assert.match(r.notes[0], /openai: the agent returned a finding the provider's own output does not hold, so it was dropped \(src\/a\.js:3\)/);
});

test('workflow-run: a missing or unreadable envelope uses the agent\'s return and says so; redactions and warnings reach the envelope', () => {
  for (const env of [null, '{ torn', JSON.stringify({ ok: true, findings: 'x' })]) {
    const t = tree();
    const run = providerRun(t, [mine('only')], env, [verdict('proved', { severity: 'medium' })], { redactions: 3, warnings: ['key file is group-readable'] });
    const r = seam(t, run);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.counts, { raised: 2, survived: 2, downgraded: 0, refuted: 0, unruled: 0 });
    assert.deepEqual(r.providers, [{ voice: 'openai', source: 'agent-return', redactions: 3, warnings: ['key file is group-readable'] }]);
    assert.match(r.notes[0], /openai: no readable envelope at .*openai\.envelope\.json, so the agent's own return was used/);
  }
  const t = tree();
  const run = providerRun(t, [mine('only')], { ok: true, findings: [mine('only')], redactions: 2, warnings: ['from disk'] }, [verdict('proved', { severity: 'medium' })], { redactions: 9 });
  assert.deepEqual(seam(t, run).providers, [{ voice: 'openai', source: 'envelope', redactions: 2, warnings: ['from disk'] }], 'the file\'s figures win');
});

test('workflow-run: an envelope that says ok:false drops the voice whatever the agent claimed', () => {
  const t = tree();
  const run = providerRun(t, [mine('claimed')], { ok: false, reason: 'transport' }, [verdict('proved', { severity: 'medium' })]);
  const r = seam(t, run);
  assert.deepEqual(r.voices, ['claude-subagent']);
  assert.deepEqual(r.dropped, [{ voice: 'openai', reason: 'the provider\'s own output says transport' }]);
  assert.deepEqual(r.counts, { raised: 1, survived: 1, downgraded: 0, refuted: 0, unruled: 0 });
});

test('workflow-run: a voice whose wrapper returned nothing but whose envelope holds a high finding lands it unruled, and the review is not clean', () => {
  const t = tree();
  const run = runWith([], []);
  const high = finding('saved before the wrapper died', 'high');
  const env = join(t.repo, 'openai.envelope.json');
  writeFileSync(env, JSON.stringify({ ok: true, findings: [high] }));
  run.result.voices.push({ voice: 'openai', ran: false, reason: 'the provider wrapper returned nothing', result: null, rulings: [], envelope: env, model: 'gpt-5' });
  const r = seam(t, run);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.dropped, []);
  assert.deepEqual(r.voices, ['claude-subagent', 'openai']);
  assert.deepEqual(r.counts, { raised: 1, survived: 0, downgraded: 0, refuted: 0, unruled: 1 });
  assert.deepEqual([r.unruled[0].voice, r.unruled[0].index, r.unruled[0].severity === undefined], ['openai', 0, true]);
  assert.match(r.unruled[0].reason, /no checker ruled/);
  assert.match(r.notes[0], /openai: the wrapper did not answer \(the provider wrapper returned nothing\)/);
  assert.equal(r.ready, false, 'a sibling\'s empty findings do not make the review clean');
  assert.equal(adjudicate(t, r.payload).ok, false);

  const answered = seam(t, run, [{ voice: 'openai', index: 0, ruling: 'survived', overridden: true, ...texts() }]);
  assert.equal(answered.ready, true, answered.not_ready);
  assert.equal(answered.needs_answer.length, 0);
});

test('workflow-run: a voice that did not run keeps today\'s named drop when its envelope is missing, torn or ok:false', () => {
  for (const env of [null, '{ torn', { ok: false, reason: 'transport' }, { ok: true, findings: 'x' }]) {
    const t = tree();
    const run = runWith([finding('local one', 'medium')], [verdict('proved', { severity: 'medium' })]);
    const file = join(t.repo, 'openai.envelope.json');
    if (env !== null) writeFileSync(file, typeof env === 'string' ? env : JSON.stringify(env));
    run.result.voices.push({ voice: 'openai', ran: false, reason: 'the provider wrapper returned nothing', result: null, rulings: [], envelope: file, model: 'gpt-5' });
    const r = seam(t, run);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.voices, ['claude-subagent']);
    assert.deepEqual(r.dropped, [{ voice: 'openai', reason: 'the provider wrapper returned nothing' }]);
    assert.deepEqual(r.counts, { raised: 1, survived: 1, downgraded: 0, refuted: 0, unruled: 0 });
  }
});

// --- Plan 4's three confirmed defects ----------------------------------------------------------------------------

test('workflow-run: a finding whose severity is not one of the four is refused run-bad-result, never a crash', () => {
  for (const severity of [{ toString: null }, 'critical', 3, null]) {
    const t = tree();
    const run = runWith([{ ...finding('x'), severity }], [verdict('proved')]);
    const r = seam(t, run);
    assert.equal(r.ok, false, JSON.stringify(severity));
    assert.equal(r.reason, 'run-bad-result');
    assert.match(r.detail, /severity that is not one of/);
    assert.deepEqual(emptyOut(t), []);
  }
  // the same door guards an envelope's findings: one with a bad severity makes the envelope unusable, not the call a crash
  const t = tree();
  const run = providerRun(t, [mine('only')], { ok: true, findings: [{ ...mine('only'), severity: { toString: null } }] }, [verdict('proved', { severity: 'medium' })]);
  const r = seam(t, run);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.providers[0].source, 'agent-return');
});

test('workflow-run: a retry after a dispatch landed and its terminal did not writes only that terminal', () => {
  const t = tree();
  assert.equal(seam(t, FIXTURE).brackets.written, 3);
  // lose one worker's terminal, the way a crash between the two appends would
  const file = join(recordsDir(t.dir), 'trace.jsonl');
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const victim = lines.map((l) => JSON.parse(l)).filter((e) => e.family === 'lifecycle' && e.event === 'return').pop();
  writeFileSync(file, `${lines.filter((l) => { const e = JSON.parse(l); return !(e.family === 'lifecycle' && e.event === 'return' && e.plan === victim.plan); }).join('\n')}\n`);
  assert.equal(render(t).unpaired.length, 1, 'the cut left one bracket open');

  const again = seam(t, FIXTURE);
  assert.deepEqual([again.brackets.written, again.brackets.already, again.brackets.failed], [1, 2, []]);
  const out = render(t);
  assert.deepEqual(out.unpaired, []);
  assert.equal(out.brackets.length, 3);
  assert.equal(rawEvents(t).filter((e) => e.family === 'lifecycle' && e.event === 'dispatch').length, 3, 'no second dispatch');
});

test('workflow-run: once the notice\'s totals are on the record, a retry with a readable file bills no agents on top', () => {
  const t = tree();
  const runFile = join(t.repo, 'wf_9d70aeab-5d0.json');
  const args = ['workflow-run', '--phase', '1', '--run-file', runFile, '--out-dir', t.out, '--payload-ref', REF, '--notice-tokens', '54242', '--notice-turns', '11', '--notice-duration-ms', '6072'];
  assert.equal(cli(t, args).reason, 'run-unreadable');
  assert.equal(render(t).brackets.length, 1);

  writeFileSync(runFile, JSON.stringify(FIXTURE));
  const retry = cli(t, args);
  assert.equal(retry.ok, true, JSON.stringify(retry));
  assert.deepEqual([retry.brackets.source, retry.brackets.written, retry.brackets.already], ['run-file', 0, 3]);
  const out = render(t);
  assert.equal(out.brackets.length, 1, 'only the notice\'s bracket');
  assert.equal(out.brackets[0].tokens, 54242);
  assert.deepEqual(out.unpaired, []);
});

// --- the analyzer arm is gone ---------------------------------------------------------------------------------------------

test('workflow-run: a run holding the analyzer\'s result shape is refused run-bad-result even with --analyzer passed, and writes no payload', () => {
  // the contract never refuses an undeclared flag at runtime, so the review arm has to be the one that says no
  const t = tree();
  const run = clone(FIXTURE);
  run.workflowName = 'analyzer';
  run.result = { report: '## Assumptions\n\nNone.\n', nulls: [] };
  const runFile = join(t.repo, 'run.json');
  writeFileSync(runFile, JSON.stringify(run));
  const r = cli(t, ['workflow-run', '--phase', '1', '--analyzer', '--run-file', runFile, '--out-dir', t.out, '--payload-ref', '.planning/ROADMAP.md']);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'run-bad-result', JSON.stringify(r));
  assert.deepEqual(emptyOut(t), [], 'no payload, no review input and no report');
});

// --- the code map has no arm here (Phase 3, D-16): `codemap write` reads its runs --------------------------------------------

test('workflow-run: a code map run is refused run-bad-result and bills its agents like any other run', () => {
  const t = tree();
  const run = clone(FIXTURE);
  run.workflowName = 'code-map';
  run.result = { modules: [{ name: 'src', built_from: {}, entry: null }] };
  const r = seam(t, run);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'run-bad-result', JSON.stringify(r));
  assert.equal(r.brackets.written, 3);
  assert.deepEqual(emptyOut(t), [], 'no payload and no review input');
});

// --- two runs of one trigger in one phase keep their records apart (D-02) ---------------------------------

test('workflow-run: two overlapping runs of one trigger keep scratch files, brackets, records and review files apart', () => {
  const t = tree();
  const out2 = join(t.repo, 'scratch-2'); mkdirSync(out2);
  // the same agent ids in both runs, so only the run id in the bracket key tells their brackets apart
  const mk = (runId, claim, extra) => {
    const run = runWith([finding(claim, 'low')], [verdict('proved', { severity: 'low', what_breaks: `${claim} breaks the row.` })]);
    run.runId = runId;
    for (const row of rowsOf(run)) { row.tokens += extra; row.toolCalls += extra / 100; row.durationMs += extra; }
    return run;
  };
  const runs = [
    { name: 'plan-1', out: t.out, run: mk('wf_first-run-0001', 'alpha claim', 0) },
    { name: 'plan-2', out: out2, run: mk('wf_second-run-0002', 'beta claim', 1000) },
  ];
  for (const r of runs) {
    const file = join(t.repo, `${r.name}.run.json`);
    writeFileSync(file, JSON.stringify(r.run));
    r.seam = cli(t, ['workflow-run', '--phase', '1', '--run-file', file, '--out-dir', r.out, '--payload-ref', `${t.base}..${t.head}`]);
    assert.equal(r.seam.ok, true, JSON.stringify(r.seam));
    assert.equal(r.seam.brackets.written, 3, 'the second run is not mistaken for the first\'s brackets');
    assert.equal(r.seam.ready, true, r.seam.not_ready);
  }
  for (const r of runs) {
    const common = ['--phase', '1', '--trigger', 'diff', '--discriminator', r.name, '--base', t.base, '--head', t.head];
    assert.equal(cli(t, ['adjudication', ...common, '--payload', r.seam.payload]).ok, true);
    assert.equal(cli(t, ['review-file', ...common, '--payload', r.seam.review_input]).ok, true);
  }

  // each fire has its own record and review file holding only its own finding
  const phaseDir = join(t.dir, 'phases', '1');
  const [a, b] = runs;
  for (const [mine, other] of [[a, b], [b, a]]) {
    const claim = mine === a ? 'alpha claim' : 'beta claim';
    const otherClaim = mine === a ? 'beta claim' : 'alpha claim';
    const record = readFileSync(join(phaseDir, `ADJUDICATION-diff-${mine.name}.json`), 'utf8');
    const review = readFileSync(join(phaseDir, `REVIEW-diff-${mine.name}.md`), 'utf8');
    for (const text of [record, review]) { assert.match(text, new RegExp(claim)); assert.doesNotMatch(text, new RegExp(otherClaim)); }
    // neither scratch directory holds the other's files
    for (const f of readdirSync(mine.out)) {
      const text = readFileSync(join(mine.out, f), 'utf8');
      assert.doesNotMatch(text, new RegExp(otherClaim), `${f} holds the other run's finding`);
      assert.equal(text.includes(other.run.runId), false, `${f} names the other run`);
    }
  }

  // the render shows a bracket per agent of both runs with each run's own figures, none unpaired, and the roles sum both
  const out = render(t);
  assert.deepEqual(out.unpaired, []);
  assert.equal(out.brackets.length, 6);
  for (const r of runs) {
    for (const row of rowsOf(r.run)) {
      const hits = out.brackets.filter((x) => x.agent_id === row.agentId && x.tokens === row.tokens);
      assert.equal(hits.length, 1, `${row.agentId} has no bracket of its own at ${row.tokens} tokens`);
      assert.equal(hits[0].turns, row.toolCalls);
      assert.equal(hits[0].duration_ms, row.durationMs);
    }
  }
  const reviewerRows = runs.flatMap((r) => rowsOf(r.run)).filter((row) => row.label.startsWith('reviewer '));
  assert.deepEqual(out.roles['cad-reviewer'], { dispatches: 2, tokens: reviewerRows.reduce((n, x) => n + x.tokens, 0), turns: reviewerRows.reduce((n, x) => n + x.toolCalls, 0) });

  // a second write under the same discriminator without --round is refused, not overwritten
  const again = ['--phase', '1', '--trigger', 'diff', '--discriminator', a.name, '--base', t.base, '--head', t.head];
  const before = readFileSync(join(phaseDir, `REVIEW-diff-${a.name}.md`), 'utf8');
  assert.equal(cli(t, ['review-file', ...again, '--payload', b.seam.review_input]).reason, 'review-exists');
  assert.equal(cli(t, ['adjudication', ...again, '--payload', b.seam.payload]).ok, false);
  assert.equal(readFileSync(join(phaseDir, `REVIEW-diff-${a.name}.md`), 'utf8'), before);
});

// --- a wave's run: each executor is billed under its plan number (Phase 5, D-19) ---------------------------------------------

/** One executor row as the host leaves it, labelled the way workflows/execute-wave.js labels its agents. */
const execRow = (plan, over = {}) => ({
  type: 'workflow_agent', index: plan, label: `plan ${plan}`, agentId: `agent-plan-${plan}`, agentType: 'cadence:cad-executor-high',
  model: 'claude-sonnet-5-5', state: 'done', attempt: 1, tokens: 1000 * plan + 7, toolCalls: 10 * plan + 1, durationMs: 100 * plan + 3, ...over,
});
const completeDigest = (more = {}) => ({ status: 'PLAN COMPLETE', tasks: '2 of 2', commits: 'abc1234..def5678', deviations: '0', open_items: '0', ...more });
/** A wave's run file: two executors by default, the result the script returns. */
const waveRun = (over = {}) => ({
  runId: 'wf_wave-0001', status: 'completed', defaultModel: 'claude-sonnet-5-5',
  result: { plans: [{ plan: 1, digest: completeDigest() }, { plan: 2, digest: completeDigest() }] },
  workflowProgress: [execRow(1), execRow(2)], ...over,
});
/** The dispatch a plan's own resolve would have written, so the wave's close has something to pair with. */
function dispatchPlan(t, plan) {
  const readSet = join(t.repo, `read-${plan}.txt`);
  writeFileSync(readSet, `.planning/phases/1/PLAN-${plan}.md\n`);
  const r = cli(t, ['trace', 'append', '--phase', '1', '--family', 'lifecycle', '--event', 'dispatch', '--plan', String(plan), '--role', 'cad-executor', '--read-file', readSet]);
  assert.equal(r.written, true, JSON.stringify(r));
}
const lifecycle = (t) => rawEvents(t).filter((e) => e.family === 'lifecycle');
const closesOf = (t) => lifecycle(t).filter((e) => e.event !== 'dispatch');

test('workflow-run: a wave bills one close per executor under its plan number with its own figures, and writes no dispatch', () => {
  const t = tree();
  dispatchPlan(t, 1); dispatchPlan(t, 2);
  const run = waveRun();
  run.result.plans[1].digest = completeDigest({ tasks: '1 of 1' });
  seam(t, run);
  const events = lifecycle(t);
  assert.equal(events.filter((e) => e.event === 'dispatch').length, 2, 'no dispatch was added to the two the resolves wrote');
  const closes = closesOf(t);
  assert.deepEqual(closes.map((e) => [e.plan, e.role, e.event]), [['1', 'cad-executor', 'return'], ['2', 'cad-executor', 'return']]);
  for (const [i, c] of closes.entries()) {
    const row = run.workflowProgress[i];
    assert.deepEqual([c.tokens, c.turns, c.duration_ms, c.agent_id], [row.tokens, row.toolCalls, row.durationMs, row.agentId]);
  }
  const out = render(t);
  assert.deepEqual(out.unpaired, []);
  assert.deepEqual(out.brackets.map((b) => [b.plan, b.tokens]).sort(), [['1', 1007], ['2', 2007]]);
  assert.deepEqual(out.roles['cad-executor'], { dispatches: 2, tokens: 3014, turns: 11 + 21 });
});

test('workflow-run: a checkpoint digest closes as a checkpoint naming its type, and a replay closes as a return with the replay flag', () => {
  const t = tree();
  dispatchPlan(t, 1); dispatchPlan(t, 2);
  const run = waveRun();
  run.result.plans[0].digest = completeDigest({ status: 'PLAN PARTIAL', checkpoint: 'structural', current_task: '2 - x', need: 'a decision' });
  run.result.plans[1].digest = completeDigest({ commits: 'none (already applied)' });
  seam(t, run);
  const [one, two] = closesOf(t);
  assert.deepEqual([one.event, one.replay], ['checkpoint', undefined]);
  assert.match(one.detail, /structural/);
  assert.deepEqual([two.event, two.replay], ['return', true]);
  assert.equal(closesOf(t).filter((e) => e.event === 'return' && !e.replay).length, 0, 'a plain return carries no replay flag');
});

test('workflow-run: a row that is not done, and a plan whose slot is null, close as checkpoints naming the state', () => {
  const t = tree();
  dispatchPlan(t, 1); dispatchPlan(t, 2); dispatchPlan(t, 3);
  const run = waveRun();
  run.result.plans = [{ plan: 1, digest: completeDigest() }, { plan: 2, digest: null }, { plan: 3, digest: completeDigest() }];
  run.workflowProgress = [execRow(1, { state: 'progress' }), execRow(2), execRow(3)];
  seam(t, run);
  const [one, two, three] = closesOf(t);
  assert.deepEqual([one.event, two.event, three.event], ['checkpoint', 'checkpoint', 'return']);
  assert.match(one.detail, /state "progress"/);
  assert.match(two.detail, /null/);
});

test('workflow-run: a second call for the same wave writes nothing, but a new dispatch of plan 1 and a new run bill plan 1 again', () => {
  const t = tree();
  dispatchPlan(t, 1); dispatchPlan(t, 2);
  const first = seam(t, waveRun());
  assert.deepEqual([first.brackets.source, first.brackets.written, first.brackets.already], ['run-file', 2, 0]);
  const before = rawEvents(t).length;
  const again = seam(t, waveRun());
  assert.deepEqual([again.brackets.written, again.brackets.already], [0, 2]);
  assert.equal(rawEvents(t).length, before);

  // plan 1 runs again by hand on today's path, and its close is not mistaken for the first run's
  dispatchPlan(t, 1);
  const hand = cli(t, ['trace', 'close', '--phase', '1', '--plan', '1', '--role', 'cad-executor', '--agent-id', 'by-hand', '--tokens', '500']);
  assert.equal(hand.written, true, JSON.stringify(hand));
  assert.equal(seam(t, waveRun()).brackets.written, 0, 'the hand close does not make the wave bill twice either');

  // a second wave run over the same plan, with a new run id and a new agent id, bills plan 1 again
  dispatchPlan(t, 1);
  const second = waveRun({ runId: 'wf_wave-0002', workflowProgress: [execRow(1, { agentId: 'agent-second-1', tokens: 9999 })] });
  second.result.plans = [{ plan: 1, digest: completeDigest() }];
  const r = seam(t, second);
  assert.deepEqual([r.brackets.written, r.brackets.already], [1, 0]);
  assert.deepEqual(closesOf(t).filter((e) => e.agent_id === 'agent-second-1').map((e) => [e.plan, e.tokens]), [['1', 9999]]);
});

test('workflow-run: a row with no agent id still bills once, and a stray unlabelled row bills as an agent of the run', () => {
  const t = tree();
  dispatchPlan(t, 1);
  const run = waveRun();
  run.result.plans = [{ plan: 1, digest: completeDigest() }];
  const noId = execRow(1); delete noId.agentId;
  run.workflowProgress = [noId, execRow(2, { label: 'something else', agentId: 'stray-1' })];
  const first = seam(t, run);
  assert.deepEqual([first.brackets.written, first.brackets.already], [2, 0]);
  assert.equal(closesOf(t).find((e) => e.plan === '1').agent_id, 'wf_wave-0001-agent1');
  const again = seam(t, run);
  assert.deepEqual([again.brackets.written, again.brackets.already], [0, 2]);
  assert.ok(lifecycle(t).some((e) => e.plan === 'wf_wave-0001-stray-1'), 'the stray row keeps the run-keyed worker');
});

test('workflow-run: risk-check status for plan 1 accepts its record only once plan 2, which the run also closed, has a skip', () => {
  const t = tree();
  dispatchPlan(t, 1); dispatchPlan(t, 2);
  seam(t, waveRun());
  const ran = cli(t, ['risk-check', 'run', '--phase', '1', '--plan', '1', '--base', t.base, '--head', t.head, '--surfaces', 'auth']);
  assert.equal(ran.ok, true, JSON.stringify(ran));
  const status = () => cli(t, ['risk-check', 'status', '--phase', '1', '--plan', '1', '--base', t.base, '--head', t.head]);
  const without = status();
  assert.equal(without.ok, false, JSON.stringify(without));
  assert.equal(without.reason, 'risk-record-missing');
  assert.match(JSON.stringify(without), /"plan":"2"/);
  const skip = cli(t, ['trace', 'append', '--phase', '1', '--family', 'outcome', '--event', 'risk_check_skipped', '--plan', '2', '--sha', t.base]);
  assert.equal(skip.written, true, JSON.stringify(skip));
  const withSkip = status();
  assert.equal(withSkip.ok, true, JSON.stringify(withSkip));
});

test('workflow-run: a readable wave result with no agent rows bills one notice bracket under cad-executor', () => {
  const t = tree();
  const r = seam(t, waveRun({ workflowProgress: [] }));
  assert.deepEqual([r.brackets.source, r.brackets.written], ['notice-totals', 1]);
  const out = render(t);
  assert.equal(out.brackets.length, 1);
  assert.equal(out.brackets[0].role, 'cad-executor');
  assert.equal(rawEvents(t).find((e) => e.event === 'dispatch').plan, 'wf_wave-0001-notice');
});

test('workflow-run: a wave answers ok with each plan\'s outcome in the script\'s order, a dead slot kept as null, and writes no payload', () => {
  const t = tree();
  const run = waveRun({ workflowProgress: [execRow(1), execRow(2), execRow(3)] });
  const cp = completeDigest({ status: 'PLAN PARTIAL', checkpoint: 'decision', current_task: '1 - x', need: 'a call' });
  run.result.plans = [{ plan: 2, digest: cp }, { plan: 1, digest: completeDigest() }, { plan: 3, digest: null }];
  const r = seam(t, run);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.plans, [{ plan: 2, digest: cp }, { plan: 1, digest: completeDigest() }, { plan: 3, digest: null }]);
  assert.deepEqual(r.restarted, []);
  assert.deepEqual([r.brackets.source, r.brackets.written], ['run-file', 3]);
  assert.deepEqual(emptyOut(t), [], 'no payload, review input or answers file');
  for (const k of ['payload', 'review_input', 'answers', 'counts']) assert.equal(k in r, false, k);
});

test('workflow-run: a row the host restarted is named, and a row with no attempt key or attempt 1 is not', () => {
  const t = tree();
  const noKey = execRow(3); delete noKey.attempt;
  const run = waveRun({ workflowProgress: [execRow(1, { attempt: 2 }), execRow(2), noKey] });
  run.result.plans.push({ plan: 3, digest: completeDigest() });
  const r = seam(t, run);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.restarted, [{ plan: '1', agent_id: 'agent-plan-1', attempt: 2 }]);
});

test('workflow-run: a wave whose result lacks its plan list is refused with its own reason, and its executors are still billed', () => {
  const t = tree();
  dispatchPlan(t, 1); dispatchPlan(t, 2);
  for (const result of [{}, { plans: 'x' }, { plans: [{ plan: 1, digest: 'text' }] }, { plans: [{ digest: null }] },
    { plans: [{ plan: 1, digest: null }, { plan: '1', digest: null }] }]) {
    const r = seam(t, waveRun({ result }));
    assert.equal(r.ok, false, JSON.stringify(result));
    assert.equal(r.reason, 'run-bad-wave');
    assert.match(r.detail, /result/);
    assert.ok(r.brackets.written + r.brackets.already === 2, 'both executors billed, once');
  }
  assert.equal(closesOf(t).length, 2);
  assert.deepEqual(emptyOut(t), []);
  const killed = seam(t, waveRun({ status: 'killed' }));
  assert.equal(killed.reason, 'run-not-completed');
});

// --- a wave named by --plans: the seam knows the wave from its caller, not from what the run file still holds (Phase 5 fix pass) ---

const NOTICE = ['--notice-tokens', '4000', '--notice-turns', '30', '--notice-duration-ms', '9000'];
const GONE = 'gone/wf_wave-0001.json';
/** The wave seam with --plans; `run` null leaves the file unwritten so `file` names one that does not exist. */
function waveCall(t, run, { plans = '1,2', notice = [], file = 'wf_wave-0001.json' } = {}) {
  const runFile = join(t.repo, file);
  if (run !== null) writeFileSync(runFile, typeof run === 'string' ? run : JSON.stringify(run));
  return cli(t, ['workflow-run', '--phase', '1', '--run-file', runFile, '--out-dir', t.out, '--payload-ref', `${t.base}..${t.head}`, '--plans', plans, ...notice]);
}
/** A wave of two dispatched plans. */
function waveTree() { const t = tree(); dispatchPlan(t, 1); dispatchPlan(t, 2); return t; }
/** The trace has no open dispatch and no worker key a plan does not own, and risk-check status takes plan 1's good record. */
function assertGateClean(t, plan = '1') {
  assert.deepEqual(render(t).unpaired, []);
  assert.deepEqual([...new Set(lifecycle(t).map((e) => e.plan))].sort(), ['1', '2'], 'every worker key is a plan of the wave');
  const ran = cli(t, ['risk-check', 'run', '--phase', '1', '--plan', plan, '--base', t.base, '--head', t.head, '--surfaces', 'auth']);
  assert.equal(ran.ok, true, JSON.stringify(ran));
  // status counts every executor the run returned, so a returned wave-mate owes its own record or skip first
  if (closesOf(t).some((e) => e.plan === '2' && e.event === 'return')) {
    const skip = cli(t, ['trace', 'append', '--phase', '1', '--family', 'outcome', '--event', 'risk_check_skipped', '--plan', '2', '--sha', t.base]);
    assert.equal(skip.written, true, JSON.stringify(skip));
  }
  const status = cli(t, ['risk-check', 'status', '--phase', '1', '--plan', plan, '--base', t.base, '--head', t.head]);
  assert.equal(status.ok, true, JSON.stringify(status));
}
const cadTokens = (t) => render(t).roles['cad-executor'].tokens;

test('workflow-run --plans: a plan with no agent row closes as a checkpoint under its own key, saying why, and the other plan bills from its row', () => {
  const t = waveTree();
  const r = waveCall(t, waveRun({ workflowProgress: [execRow(1)] }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([r.brackets.source, r.brackets.written], ['run-file', 2]);
  const [one, two] = closesOf(t);
  assert.deepEqual([one.plan, one.event, one.agent_id, one.tokens], ['1', 'return', 'agent-plan-1', 1007]);
  assert.deepEqual([two.plan, two.role, two.event, two.agent_id], ['2', 'cad-executor', 'checkpoint', 'wf_wave-0001-plan-2']);
  assert.match(two.detail, /no agent row labelled "plan 2"/);
  assert.equal(two.tokens, undefined);
  assertGateClean(t);
  const again = waveCall(t, waveRun({ workflowProgress: [execRow(1)] }));
  assert.deepEqual([again.brackets.written, again.brackets.already], [0, 2]);
});

test('workflow-run --plans: a wave with no agent rows bills the notice\'s totals as cad-executor on the first plan, closes the rest, and writes no -notice key', () => {
  const t = waveTree();
  const r = waveCall(t, waveRun({ workflowProgress: [] }), { notice: NOTICE });
  assert.deepEqual([r.ok, r.brackets.source, r.brackets.written], [true, 'notice-totals', 2]);
  const [one, two] = closesOf(t);
  assert.deepEqual([one.plan, one.role, one.event, one.tokens, one.turns, one.duration_ms], ['1', 'cad-executor', 'checkpoint', 4000, 30, 9000]);
  assert.match(one.detail, /totals from the completion notice, because the run file holds no agent rows/);
  assert.deepEqual([two.plan, two.event, two.tokens], ['2', 'checkpoint', undefined]);
  assert.match(two.detail, /no agent row bills this plan/);
  assert.equal(lifecycle(t).some((e) => String(e.plan).endsWith('-notice')), false);
  assert.equal(render(t).roles['review-workflow'], undefined);
  assert.equal(cadTokens(t), 4000);
  assertGateClean(t);
});

test('workflow-run --plans: an unreadable or non-JSON run file is still a wave, billed as cad-executor and closed per plan, then refused as a run file', () => {
  for (const [run, file, reason] of [[null, GONE, 'run-unreadable'], ['not json {', 'wf_wave-0001.json', 'run-not-json']]) {
    const t = waveTree();
    const r = waveCall(t, run, { notice: NOTICE, file });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.reason, reason);
    assert.doesNotMatch(r.hint || '', /one bracket/);
    assert.deepEqual([r.brackets.source, r.brackets.written], ['notice-totals', 2]);
    assert.deepEqual(closesOf(t).map((e) => [e.plan, e.role, e.event]), [['1', 'cad-executor', 'checkpoint'], ['2', 'cad-executor', 'checkpoint']]);
    assert.equal(render(t).roles['review-workflow'], undefined);
    assert.equal(cadTokens(t), 4000);
    assertGateClean(t);
  }
});

test('workflow-run --plans: the script\'s string result is a wave that started no executor, not a bad review', () => {
  const t = waveTree();
  const message = 'execute-wave runs one executor per plan for /cad-execute. It needs args and started no agent.';
  const r = waveCall(t, waveRun({ workflowProgress: [], result: message }), { notice: NOTICE });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.reason, 'run-bad-wave');
  assert.match(r.detail, /started no executor/);
  assert.ok(r.detail.includes(message));
  assert.doesNotMatch(`${r.detail} ${r.hint}`, /review|voices/);
  assert.deepEqual(closesOf(t).map((e) => [e.plan, e.role, e.event]), [['1', 'cad-executor', 'checkpoint'], ['2', 'cad-executor', 'checkpoint']]);
  assert.equal(render(t).roles['review-workflow'], undefined);
  assertGateClean(t);
});

test('workflow-run --plans: the rows and then the notice\'s totals on a retry bill the wave once', () => {
  const t = waveTree();
  assert.equal(waveCall(t, waveRun()).brackets.written, 2);
  const retry = waveCall(t, null, { notice: NOTICE, file: GONE });
  assert.deepEqual([retry.brackets.written, retry.brackets.already], [0, 2]);
  assert.equal(closesOf(t).length, 2);
  assert.equal(cadTokens(t), 1007 + 2007, 'the rows\' spend only, never the notice\'s 4000 on top');
  assertGateClean(t);
});

test('workflow-run --plans: the notice\'s totals and then the rows on a retry bill the wave once', () => {
  const t = waveTree();
  assert.equal(waveCall(t, null, { notice: NOTICE, file: GONE }).brackets.written, 2);
  const retry = waveCall(t, waveRun());
  assert.deepEqual([retry.brackets.written, retry.brackets.already], [0, 2]);
  assert.equal(closesOf(t).length, 2);
  assert.equal(cadTokens(t), 4000, 'the notice\'s spend only, never the rows\' on top');
  assertGateClean(t);
});

test('workflow-run --plans: a later run of the same plan bills again, and a bad plan list is refused before anything is written', () => {
  const t = waveTree();
  waveCall(t, waveRun());
  dispatchPlan(t, 1);
  const second = waveRun({ runId: 'wf_wave-0002', workflowProgress: [execRow(1, { agentId: 'agent-second-1', tokens: 9999 })] });
  second.result.plans = [{ plan: 1, digest: completeDigest() }];
  const r = waveCall(t, second, { plans: '1', file: 'wf_wave-0002.json' });
  assert.deepEqual([r.brackets.written, r.brackets.already], [1, 0]);
  const before = rawEvents(t).length;
  for (const plans of ['1,,2', '1, 2', '1,1', ' 1']) {
    const bad = waveCall(t, waveRun(), { plans });
    assert.deepEqual([bad.ok, bad.reason], [false, 'bad-args'], plans);
  }
  assert.equal(rawEvents(t).length, before);
});

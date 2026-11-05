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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLANNING = join(ROOT, 'cadence-core', 'bin', 'planning.mjs');
const FIXTURE = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'workflow-run.completed.json'), 'utf8'));
const { unfixedFindings } = await import(pathToFileURL(join(ROOT, 'cadence-core', 'bin', 'lib', 'filing-decision.mjs')));

const clone = (v) => JSON.parse(JSON.stringify(v));
const SIX = ['what_breaks', 'why_care', 'what_triggers', 'what_proves', 'what_uncertain', 'recommendation'];
const HEADINGS = ['What breaks', 'Why I should care', 'What triggers it', 'What proves it', 'What is still uncertain', 'Your recommendation'];
// the keys a record entry may carry today, from lib/adjudication-record.mjs and the seam that stores it
const ENTRY_KEYS = new Set(['voice', 'model', 'file', 'line', 'severity', 'claim', 'failure_scenario', 'ruling', 'convergent',
  'counter_evidence', 'fix_commit', 'overridden', 'citation_missing', 'base_id', 'head_id']);

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
  assert.deepEqual(readJson(r.review_input).survivors.map((s) => s.severity), ['medium', 'low']);
  assert.equal(r.ready, true, r.not_ready);
  assert.equal(adjudicate(t, r.payload).ok, true);
});

test('workflow-run: a proved high needs an answer, and adjudication and unfixedFindings both refuse until it settles', () => {
  const t = tree();
  const run = runWith([finding('one')], [verdict('proved')]);
  const r = seam(t, run);
  assert.deepEqual(r.needs_answer.map((n) => [n.voice, n.index, n.severity, n.suspected]), [['claude-subagent', 0, 'high', false]]);
  assert.equal(r.ready, false);
  assert.match(r.not_ready, /neither a usable fix_commit nor overridden/);
  assert.equal(adjudicate(t, r.payload).ok, false);
  assert.equal(unfixedFindings(readJson(r.payload)).ok, false);

  const fixed = seam(t, run, [{ voice: 'claude-subagent', index: 0, fix_commit: 'abc1234' }]);
  assert.equal(fixed.ready, true, fixed.not_ready);
  assert.deepEqual(fixed.needs_answer, []);
  assert.equal(adjudicate(t, fixed.payload).ok, true);
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
    { voice: 'claude-subagent', index: 1, ruling: 'survived', what_proves: 'Run it with one row.' },
    { voice: 'claude-subagent', index: 2, ruling: 'survived', why_care: 'A user loses a row.' },
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
  assert.equal(existsSync(join(t.dir, 'trace.jsonl')), false, 'a refused call wrote no bracket');
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

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
  const file = join(t.dir, 'trace.jsonl');
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

// --- the analyzer arm: a finished analyzer run to its report on disk -----------------------------------------------------------

const REPORT = '## Assumptions\n\n### Area: Storage\n\n- **Decision:** Rows live in the run record, é\n  **Certainty:** Confident\n  **Evidence:** `a.js`\n  **If wrong:** a plan is rebuilt\n\n## Needs external research\n\nNone.\n';
/** The fixture's run with three analyzer readers in place of its review rows, and the analyzer script's result. */
function analyzerRun(result = { report: REPORT, nulls: [] }) {
  const run = clone(FIXTURE);
  const [first, second, third] = rowsOf(run);
  for (const [row, label] of [[first, 'reader similar'], [second, 'reader flow'], [third, 'reader keep']]) {
    row.label = label;
    row.agentType = 'cadence:cad-assumptions-analyzer-high';
  }
  run.workflowName = 'analyzer';
  run.result = result;
  return run;
}
const analyze = (t, run, ...more) => {
  const runFile = join(t.repo, 'run.json');
  writeFileSync(runFile, typeof run === 'string' ? run : JSON.stringify(run));
  return cli(t, ['workflow-run', '--phase', '1', '--analyzer', '--run-file', runFile, '--out-dir', t.out, '--payload-ref', '.planning/ROADMAP.md', ...more]);
};

test('workflow-run --analyzer: a run with a report writes it byte-identical to the file\'s result and prints its path and the readers that returned nothing', () => {
  const t = tree();
  const r = analyze(t, analyzerRun({ report: REPORT, nulls: ['behavior'] }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(readFileSync(r.report, 'utf8'), REPORT);
  assert.deepEqual(r.nulls, ['behavior']);
  assert.equal(r.run_id, 'wf_9d70aeab-5d0');
  assert.deepEqual(emptyOut(t), ['analysis.md'], 'the report is the only file, and no review payload is written');
  // the flag works wherever it sits on the line
  const t2 = tree();
  const runFile = join(t2.repo, 'run.json');
  writeFileSync(runFile, JSON.stringify(analyzerRun()));
  const last = cli(t2, ['workflow-run', '--phase', '1', '--run-file', runFile, '--out-dir', t2.out, '--payload-ref', 'x', '--analyzer']);
  assert.deepEqual([last.ok, readFileSync(last.report, 'utf8')], [true, REPORT]);
});

test('workflow-run --analyzer: a run with no report is ok:false under its own reason, names the readers, and writes no report', () => {
  const t = tree();
  const r = analyze(t, analyzerRun({ report: null, nulls: ['similar features', 'behavior', 'what must stay intact'] }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'analyzer-no-report');
  assert.match(r.detail, /similar features, behavior, what must stay intact/);
  assert.deepEqual(emptyOut(t), []);
  // nothing in the report slot of any other shape reads as a report either
  for (const result of [{ report: '  \n', nulls: [] }, { report: null, nulls: [] }]) {
    assert.equal(analyze(tree(), analyzerRun(result)).reason, 'analyzer-no-report', JSON.stringify(result));
  }
});

test('workflow-run --analyzer: a run that is not a finished analyzer run is refused with the reason the review arm gives', () => {
  for (const [run, reason] of [
    [KILLED, 'run-not-completed'],
    [FIXTURE, 'run-bad-result'],
    [analyzerRun('the analyzer started no agent'), 'run-bad-result'],
    [analyzerRun({ report: 7, nulls: [] }), 'run-bad-result'],
    [analyzerRun({ report: REPORT }), 'run-bad-result'],
    ['{', 'run-not-json'],
  ]) {
    const t = tree();
    const r = analyze(t, run);
    assert.equal(r.ok, false);
    assert.equal(r.reason, reason, JSON.stringify(r));
    assert.deepEqual(emptyOut(t), []);
  }
  // without the flag the same analyzer run is still judged as a review panel's
  const t = tree();
  const runFile = join(t.repo, 'run.json');
  writeFileSync(runFile, JSON.stringify(analyzerRun()));
  assert.equal(cli(t, ['workflow-run', '--phase', '1', '--run-file', runFile, '--out-dir', t.out, '--payload-ref', 'x']).reason, 'run-bad-result');
});

test('workflow-run --analyzer: the door asks for the same flags the review arm does', () => {
  const t = tree();
  assert.equal(cli(t, ['workflow-run', '--phase', '1', '--analyzer', '--run-file', 'x', '--out-dir', t.out]).reason, 'bad-args', 'no --payload-ref');
  assert.equal(cli(t, ['workflow-run', '--analyzer', '--run-file', 'x', '--out-dir', t.out, '--payload-ref', 'y']).reason, 'bad-args', 'no --phase');
});

// --- the analyzer's readers are billed ------------------------------------------------------------------------------------

test('workflow-run --analyzer: three readers bill three brackets under the analyzer\'s role with their figures, none unpaired, whatever their rows say', () => {
  const t = tree();
  const run = analyzerRun({ report: REPORT, nulls: [] });
  const rows = rowsOf(run);
  delete rows[1].agentType;                  // a row the host gave no type: still the analyzer's
  rows[2].agentType = 'cadence:cad-reviewer-low';
  const r = analyze(t, run);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([r.brackets.source, r.brackets.written, r.brackets.already, r.brackets.failed], ['run-file', 3, 0, []]);
  const out = render(t);
  assert.deepEqual(out.unpaired, []);
  assert.equal(out.brackets.length, 3);
  assert.ok(out.brackets.every((b) => b.role === 'cad-assumptions-analyzer'), JSON.stringify(out.brackets.map((b) => b.role)));
  for (const row of rows) {
    const b = out.brackets.find((x) => x.agent_id === row.agentId);
    assert.deepEqual([b.tokens, b.turns, b.duration_ms, b.event], [row.tokens, row.toolCalls, row.durationMs, 'return']);
  }
  assert.deepEqual(out.roles['cad-assumptions-analyzer'], { dispatches: 3, tokens: rows.reduce((n, x) => n + x.tokens, 0), turns: rows.reduce((n, x) => n + x.toolCalls, 0) });
  assert.equal(rawEvents(t).filter((e) => e.family === 'lifecycle' && e.event === 'dispatch').every((e) => e.read.length === 1 && e.read[0] === '.planning/ROADMAP.md' && !('reviewer' in e)), true);
  // the ceiling for the analyzer's role is read against each reader, not against the sum
  const w = cli(t, ['trace', 'window', '--phase', '1']);
  assert.ok(JSON.stringify(w).includes('cad-assumptions-analyzer'), JSON.stringify(w));
  // a second call bills nothing more
  assert.deepEqual([analyze(t, run).brackets.written, render(t).brackets.length], [0, 3]);
});

test('workflow-run --analyzer: a run with no report is refused and still bills every reader, an unfinished one as a checkpoint', () => {
  const t = tree();
  const run = analyzerRun({ report: null, nulls: ['behavior'] });
  rowsOf(run)[1].state = 'progress';
  const r = analyze(t, run);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'analyzer-no-report');
  assert.deepEqual([r.brackets.source, r.brackets.written], ['run-file', 3]);
  const out = render(t);
  assert.deepEqual(out.unpaired, []);
  assert.deepEqual(out.brackets.map((b) => [b.role, b.event]).sort(), [['cad-assumptions-analyzer', 'checkpoint'], ['cad-assumptions-analyzer', 'return'], ['cad-assumptions-analyzer', 'return']]);
  assert.deepEqual(emptyOut(t), []);
});

test('workflow-run --analyzer: with no readable rows the notice\'s totals bill one bracket under the analyzer\'s role', () => {
  const t = tree();
  const r = analyze(t, '{', '--notice-tokens', '900', '--notice-turns', '9', '--notice-duration-ms', '90');
  assert.equal(r.reason, 'run-not-json');
  assert.deepEqual([r.brackets.source, r.brackets.written], ['notice-totals', 1]);
  const out = render(t);
  assert.deepEqual([out.brackets[0].role, out.brackets[0].tokens], ['cad-assumptions-analyzer', 900]);
  assert.deepEqual(out.unpaired, []);
});

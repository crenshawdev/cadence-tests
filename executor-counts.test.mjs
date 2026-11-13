// Tests for executor-counts.mjs - one executor's LSP calls, grep calls, turns and tokens (D-13).
// Run: node --test tests/executor-counts.test.mjs
// The count rows run the real script on a transcript and trace built in a temp dir, in the host's and trace.jsonl's
// shapes; the command-word rows ask runsSearch directly, on shell lines shaped after real executor transcripts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runsSearch } from '../cadence-core/bin/executor-counts.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(REPO, 'cadence-core', 'bin', 'executor-counts.mjs');
const AGENT = 'a0123456789abcdef';

/** One assistant line per tool call, the way the host writes a content block. */
function toolLine(n, name, input) {
  return JSON.stringify({
    parentUuid: `p${n}`, isSidechain: true, agentId: AGENT, type: 'assistant', timestamp: '2026-11-12T16:00:00.000Z',
    message: {
      model: 'claude-sonnet-5-5', id: `msg_${n}`, type: 'message', role: 'assistant',
      content: [{ type: 'tool_use', id: `toolu_${n}`, name, input, caller: { type: 'direct' } }],
      stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 2, output_tokens: 50 },
    },
  });
}

const CALLS = [
  ['Grep', { pattern: 'foo', path: 'src' }],
  ['Grep', { pattern: 'bar' }],
  ['Bash', { command: 'grep -n "x" a.mjs' }],
  ['Bash', { command: 'git ls-files | rg "\\.mjs$"' }],
  ['Bash', { command: 'grep -n a f.mjs; cd tests && grep -c b g.mjs' }],
  ['Bash', { command: 'cat notes/grep-notes.txt' }],
  ['LSP', { operation: 'findReferences', filePath: 'a.mjs', line: 1, character: 1 }],
  ['Read', { file_path: '/repo/a.mjs' }],
];

const RETURN = {
  corr: '1-abcd1234', phase: '1', ts: '2026-11-12T16:59:49.400Z', family: 'lifecycle', event: 'return',
  plan: '6', role: 'cad-executor', tokens: 4321, turns: 8, duration_ms: 1000, agent_id: AGENT,
};

/** A temp dir holding the transcript and a trace whose events are `events`. */
function fixture(events) {
  const dir = mkdtempSync(join(tmpdir(), 'cad-executor-counts-'));
  const lines = [JSON.stringify({ type: 'user', agentId: AGENT, message: { role: 'user', content: 'Phase 1' } })];
  CALLS.forEach(([name, input], i) => {
    lines.push(toolLine(i, name, input));
    lines.push(JSON.stringify({ type: 'user', agentId: AGENT,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${i}`, content: 'ok' }] } }));
  });
  const transcript = join(dir, `agent-${AGENT}.jsonl`);
  const trace = join(dir, 'trace.jsonl');
  writeFileSync(transcript, lines.join('\n') + '\n');
  writeFileSync(trace, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return { transcript, trace };
}

/** @param {string[]} argv */
function run(argv) {
  const r = spawnSync(process.execPath, [SCRIPT, ...argv], { encoding: 'utf8' });
  return { status: r.status, out: JSON.parse(r.stdout) };
}

test('the four counts: Grep calls and Bash calls running grep or rg, each Bash call once, and the return\'s figures', () => {
  const { transcript, trace } = fixture([
    { ...RETURN, event: 'worker_cache', tokens: undefined, turns: undefined },
    { ...RETURN, agent_id: 'someone-else', tokens: 1, turns: 1 },
    RETURN,
  ]);
  const { status, out } = run(['--transcript', transcript, '--trace', trace]);
  assert.equal(status, 0);
  assert.equal(out.lsp, 1);
  assert.equal(out.grep, 5, 'two Grep calls, three Bash calls; the grep-notes.txt path is not a grep');
  assert.equal(out.turns, 8);
  assert.equal(out.tokens, 4321);
});

test('a trace with no return for the agent exits non-zero naming the missing return', () => {
  const { transcript, trace } = fixture([{ ...RETURN, agent_id: 'someone-else' }]);
  const { status, out } = run(['--transcript', transcript, '--trace', trace]);
  assert.notEqual(status, 0);
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'no-return');
  assert.match(out.detail, new RegExp(`cad-executor return .*${AGENT}`));
  assert.equal(out.lsp, undefined, 'no partial set of counts');
});

test('the stored before record holds plan 6\'s four figures as the script counted them on 2026-11-13', () => {
  const before = JSON.parse(readFileSync(join(REPO, 'cadence-core', 'bin', 'executor-counts.before.json'), 'utf8'));
  // the script's count matched the hand count of 0 and 74, so the record carries no second figure
  assert.equal(before.lsp, 0);
  assert.equal(before.grep, 74);
  assert.equal(before.turns, 126);
  assert.equal(before.tokens, 263959);
});

// text an executor writes, not runs: each mentions grep where the old split read it as a command word
const NOT_SEARCHES = [
  ['an inline node -e whose source mentions grep',
    'cd /code/cadence; T=agent-x.jsonl; node -e \'\nconst fs=require("fs");\nlet n=0;\n'
    + 'for(const l of lines){ if(/grep|\\brg\\b/.test(cmd)) n++ }\nconsole.log(n)\' "$T"'],
  ['a python heredoc whose text holds "| grep of ..."',
    'cd /code/cadence && python3 - <<\'EOF\'\np=\'.planning/phases/2/reports/plan-7.md\'\ns=open(p).read()\n'
    + 's=s.replace("x","| grep of .planning/trace.jsonl, PHASE_START as fallback)",1)\nopen(p,\'w\').write(s)\nEOF'],
  ['a cat > file heredoc whose body has a table cell "| grep for ..."',
    'cd /code/cadence; cat > .planning/phases/2/reports/plan-1.md <<\'EOF\'\nPLAN PARTIAL\n| Task | Commit | Note |\n'
    + '|---|---|---|\n| 1 - guard | 30681a58 | grep for the two direct calls over the nine files empty |\nEOF'],
  ['a commit message heredoc that mentions grep',
    'git add a.mjs && git commit -q -m "$(cat <<\'EOF\'\nfeat: count calls that run `grep` or `rg`\n\n| grep | rg |\nEOF\n)"'],
];

const WRAPPED_SEARCHES = [
  ['command grep', 'cd /code/cadence/tests && command grep -rn "parseCursor" --include=\'*.mjs\' . | head -50'],
  ['timeout 60 rg', 'timeout 60 rg -n "parseCursor" cadence-core'],
  ['xargs grep', 'find . -name "*.mjs" | xargs grep -l parseCursor'],
];

// D-17: a substitution inside double quotes runs; single quotes and plain double-quoted prose run nothing
const QUOTED_SUBSTITUTIONS = [
  ['a grep inside $(...) inside double quotes', 'echo "found $(grep -c "parseCursor" a.mjs) hits"', true],
  ['an rg inside backticks inside double quotes', 'echo "files: `rg -l parseCursor cadence-core`"', true],
  ['a grep inside $(...) inside single quotes', 'echo \'found $(grep -c parseCursor a.mjs) hits\'', false],
  ['an rg inside backticks inside single quotes', 'echo \'files: `rg -l parseCursor cadence-core`\'', false],
  ['a double-quoted sentence naming grep', 'git commit -q -m "fix: grep the trace before the summary"', false],
];

for (const [name, command, runs] of QUOTED_SUBSTITUTIONS) {
  test(`quoted substitution: ${name}`, () => assert.equal(runsSearch(command), runs));
}

for (const [name, command] of NOT_SEARCHES) {
  test(`not a grep: ${name}`, () => assert.equal(runsSearch(command), false));
}

for (const [name, command] of WRAPPED_SEARCHES) {
  test(`a grep behind a wrapper: ${name}`, () => assert.equal(runsSearch(command), true));
}

// D-16: the after record the /cad-execute session writes, one row per cad-executor dispatch and one totals row
const AFTER = join(REPO, 'cadence-core', 'bin', 'executor-counts.after.json');
const COUNT_KEYS = ['tool_calls', 'lsp', 'grep', 'turns', 'tokens'];
const ROW_KEYS = ['agent_id', 'plan', 'language'];

/** Every way `record` falls short of the after record's shape; empty when it holds. @returns {string[]} */
function afterProblems(record) {
  const rows = record && Array.isArray(record.rows) ? record.rows : [];
  // no rows would read as a measurement of nothing
  if (!rows.length) return ['rows is missing or empty'];
  const problems = [];
  rows.forEach((row, n) => {
    for (const key of ROW_KEYS) if (typeof row[key] !== 'string' || !row[key]) problems.push(`row ${n} lacks ${key}`);
    for (const key of COUNT_KEYS) if (!Number.isSafeInteger(row[key])) problems.push(`row ${n} lacks ${key}`);
  });
  const totals = record.totals || {};
  for (const key of COUNT_KEYS) {
    const sum = rows.reduce((s, row) => s + (Number.isSafeInteger(row[key]) ? row[key] : 0), 0);
    if (totals[key] !== sum) problems.push(`totals.${key} is ${totals[key]}, the rows sum to ${sum}`);
  }
  return problems;
}

const GOOD_AFTER = {
  rows: [
    { agent_id: 'a1', plan: '1', language: 'mjs', tool_calls: 40, lsp: 6, grep: 9, turns: 41, tokens: 90000 },
    { agent_id: 'a2', plan: '2', language: 'md', tool_calls: 30, lsp: 0, grep: 12, turns: 31, tokens: 70000 },
  ],
  totals: { tool_calls: 70, lsp: 6, grep: 21, turns: 72, tokens: 160000 },
};

test('the after-record judge passes a record of two rows and their totals', () => {
  assert.deepEqual(afterProblems(GOOD_AFTER), []);
});

test('the after-record judge refuses a row missing a key, naming it', () => {
  const { language, ...short } = GOOD_AFTER.rows[1];
  assert.deepEqual(afterProblems({ ...GOOD_AFTER, rows: [GOOD_AFTER.rows[0], short] }), ['row 1 lacks language']);
});

test('the after-record judge refuses a total off by one, naming it', () => {
  const totals = { ...GOOD_AFTER.totals, grep: 22 };
  assert.deepEqual(afterProblems({ ...GOOD_AFTER, totals }), ['totals.grep is 22, the rows sum to 21']);
});

test('the stored after record holds its rows and totals', { skip: !existsSync(AFTER) && 'not written yet' }, () => {
  assert.deepEqual(afterProblems(JSON.parse(readFileSync(AFTER, 'utf8'))), []);
});

test('an unreadable transcript path exits non-zero', () => {
  const { trace } = fixture([RETURN]);
  const { status, out } = run(['--transcript', join(tmpdir(), 'no-such-dir-cad', 'agent-x.jsonl'), '--trace', trace]);
  assert.notEqual(status, 0);
  assert.equal(out.ok, false);
  assert.match(out.detail, /--transcript/);
});

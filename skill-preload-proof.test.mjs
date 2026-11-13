// Zero-dep tests for skill-preload-proof.mjs, the stored proof that the host preloads an agent's second skill (D-02).
// Run: node --test tests/skill-preload-proof.test.mjs
//
// Harness: a stand-in `claude` alone on the child's PATH. Each call records what it was handed (argv, the fixture's
// agent file) and prints the canned stream-json run for that call: the first run's, then the second's. The records below are cut down from a real Claude Code 2.1.323 stream
// captured on 2026-11-13 with --verbose and --forward-subagent-text: same types, keys and nesting, usage noise dropped.
// No test runs the real host; the script always writes to a temp --out here, never to the stored file.
// The last test reads the stored file the real host wrote, both runs judged by the script's own judge() and judgeSecond().
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MARKERS, AGENT_TYPE, SKILLS, STORED_RESULT, SECOND_AGENT, SECOND_AGENT_TYPE, SECOND_PROMPT, judge,
  judgeSecond, writeFixture } from '../cadence-core/bin/skill-preload-proof.mjs';
import { FRONTMATTER_RE, parseSkillsField } from '../cadence-core/bin/lib/frontmatter.mjs';
import { SHARED_RULE, carriesSharedRule } from '../cadence-core/bin/lib/shared-rule.mjs';
import { RUNG_FILES } from '../cadence-core/bin/lib/rung-agent.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'cadence-core', 'bin', 'skill-preload-proof.mjs');
const ID = 'toolu_01TiUZwgm1n35yihEuMCB8mh';
const SESSION = '555e4c5a-00fd-434d-a7db-4d5b36dfc4be';
const BOTH = `- proof-first: ${MARKERS.first}\n- proof-second: ${MARKERS.second}`;
const FIRST_ONLY = `- proof-first: ${MARKERS.first}`;

// Absolute shebang, so the child's PATH can hold the stand-in and nothing else
const STUB = `#!${process.execPath}
const fs = require('fs'), path = require('path');
const argv = process.argv.slice(2);
const proof = path.join(argv[argv.indexOf('--plugin-dir') + 1], 'agents', 'preload-proof.md');
const calls = fs.existsSync(process.env.STUB_CAPTURE) ? JSON.parse(fs.readFileSync(process.env.STUB_CAPTURE, 'utf8')) : [];
calls.push({ argv, agent: fs.existsSync(proof) ? fs.readFileSync(proof, 'utf8') : null });
fs.writeFileSync(process.env.STUB_CAPTURE, JSON.stringify(calls));
process.stdout.write(fs.readFileSync(process.env.STUB_STREAM + '.' + (calls.length - 1), 'utf8'));
process.exitCode = Number(process.env.STUB_EXIT || 0);
`;

const assistant = (content, parent = null) => ({
  type: 'assistant', message: { model: 'claude-fable-5-2', type: 'message', role: 'assistant', content },
  parent_tool_use_id: parent, session_id: SESSION,
});
const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input, caller: { type: 'direct' } });

/**
 * One run's stream, shaped as the captured one.
 * @param {{returned: string, finalText?: string, subagentReads?: number, parentReads?: number,
 *   dispatchPrompt?: string, nested?: boolean, agentType?: string}} o
 */
function stream(o) {
  const agentType = o.agentType || AGENT_TYPE;
  const reads = o.subagentReads || 0;
  const prompt = o.dispatchPrompt || 'Reply with the line each of your preloaded skills holds, verbatim.';
  const recs = [
    { type: 'system', subtype: 'init', cwd: '/tmp/x', session_id: SESSION, tools: ['Task'],
      claude_code_version: '2.1.323', agents: ['general-purpose', agentType] },
    assistant([{ type: 'text', text: 'Dispatching the preload-proof agent.' }]),
    assistant([toolUse(ID, 'Agent', { description: 'Report preloaded skill lines', subagent_type: agentType,
      prompt, run_in_background: false })]),
  ];
  for (let i = 0; i < (o.parentReads || 0); i++) {
    recs.push(assistant([toolUse(`toolu_parent_read_${i}`, 'Read', { file_path: '/tmp/x/SKILL.md' })]));
  }
  recs.push({ type: 'system', subtype: 'task_started', task_id: 'a5ec3c505042bba18', tool_use_id: ID,
    subagent_type: agentType, prompt, session_id: SESSION });
  recs.push({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] },
    parent_tool_use_id: ID, agent_id: 'a5ec3c505042bba18', session_id: SESSION });
  if (o.nested !== false) {
    for (let i = 0; i < reads; i++) {
      recs.push(assistant([toolUse(`toolu_sub_read_${i}`, 'Read', { file_path: '/tmp/x/SKILL.md' })], ID));
    }
    recs.push(assistant([{ type: 'text', text: o.returned }], ID));
  }
  recs.push({ type: 'system', subtype: 'task_notification', task_id: 'a5ec3c505042bba18', tool_use_id: ID,
    status: 'completed', summary: o.returned, usage: { total_tokens: 1251, tool_uses: reads, duration_ms: 1448 } });
  recs.push({
    type: 'user',
    message: { role: 'user', content: [{ tool_use_id: ID, type: 'tool_result', content: [{ type: 'text',
      text: `[Subagent hand-back] The report follows:\n  ${o.returned.split('\n').join('\n  ')}\nagentId: a5ec3c505042bba18` }] }] },
    parent_tool_use_id: null, session_id: SESSION,
    tool_use_result: { status: 'completed', agentId: 'a5ec3c505042bba18', agentType,
      content: [{ type: 'text', text: o.returned }] },
  });
  const finalText = o.finalText || `The preload-proof agent returned:\n\n${o.returned}`;
  recs.push(assistant([{ type: 'text', text: finalText }]));
  recs.push({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, result: finalText, session_id: SESSION });
  return recs.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

/** A second run whose agent returned `returned`, read `subagentReads` files, and was dispatched as the script asks. */
const second = (returned, subagentReads = 0) => stream({ returned, subagentReads, agentType: SECOND_AGENT_TYPE,
  dispatchPrompt: 'Answer from your context, use no tool, and reply with your shared rule about the LSP tool, verbatim.' });
const SECOND_OK = second(SHARED_RULE);

/**
 * Run the script against a stand-in, or against no `claude` at all when `firstText` is null.
 * @param {string|null} firstText @param {string} [secondText] @param {number} [exitCode]
 */
function run(firstText, secondText = SECOND_OK, exitCode = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'cad-spp-'));
  const bin = join(dir, 'bin');
  const env = { ...process.env, PATH: bin, STUB_CAPTURE: join(dir, 'capture.json'),
    STUB_STREAM: join(dir, 'stream.jsonl'), STUB_EXIT: String(exitCode) };
  mkdirSync(bin);
  if (firstText !== null) {
    writeFileSync(join(bin, 'claude'), STUB);
    chmodSync(join(bin, 'claude'), 0o755);
    writeFileSync(`${env.STUB_STREAM}.0`, firstText);
    writeFileSync(`${env.STUB_STREAM}.1`, secondText);
  }
  const out = join(dir, 'result.json');
  const r = spawnSync(process.execPath, [SCRIPT, '--out', out], { env, encoding: 'utf8' });
  return {
    status: r.status, stdout: r.stdout, out,
    capture: existsSync(env.STUB_CAPTURE) ? JSON.parse(readFileSync(env.STUB_CAPTURE, 'utf8')) : null,
  };
}

test('both markers back with the counts at 0 passes and stores both runs', () => {
  const r = run(stream({ returned: BOTH }));
  assert.equal(r.status, 0, r.stdout);
  const { first, second: two } = JSON.parse(readFileSync(r.out, 'utf8'));
  assert.ok(first.returned.includes(MARKERS.second));
  assert.equal(first.came_back.second, true);
  assert.equal(first.subagent_tool_calls, 0);
  assert.equal(first.parent_other_calls, 0);
  assert.equal(first.host_version, '2.1.323');
  assert.equal(first.agent, AGENT_TYPE);
  assert.equal(two.agent, SECOND_AGENT_TYPE);
  assert.equal(two.marker, SHARED_RULE);
  assert.equal(two.came_back, true);
  assert.equal(two.subagent_tool_calls, 0);
  assert.equal(two.host_version, '2.1.323');
});

test('the first marker back and the rule missing from the second fails naming the second run', () => {
  const r = run(stream({ returned: BOTH }), second('I have no such rule.'));
  assert.notEqual(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.run, 'second');
  assert.equal(out.reason, 'shared-rule-missing');
  assert.equal(existsSync(r.out), false);
});

test('the rule back with its line breaks and spacing changed passes', () => {
  const rewrapped = SHARED_RULE.replace(/ (?=definitions)/, '\n').replace(/ (?=If it errors)/, '\n\n  ');
  const r = run(stream({ returned: BOTH }), second(`Here it is:\n${rewrapped}`));
  assert.equal(r.status, 0, r.stdout);
});

test('the rule back with one word changed fails', () => {
  const r = run(stream({ returned: BOTH }), second(SHARED_RULE.replace('references', 'usages')));
  assert.notEqual(r.status, 0);
  assert.equal(JSON.parse(r.stdout).run, 'second');
});

test('a Read inside the second run\'s agent fails naming the count, though the rule came back', () => {
  const r = run(stream({ returned: BOTH }), second(SHARED_RULE, 1));
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /second run: subagent_tool_calls is 1/);
});

test('the second run: the executor\'s unsuffixed file, no rule text in the prompt, and a parent not held by --tools Agent', () => {
  const { capture } = run(stream({ returned: BOTH }));
  assert.equal(SECOND_AGENT, 'cad-executor');
  assert.equal(SECOND_AGENT, RUNG_FILES['cad-executor'].rungs.high);
  const { argv } = capture[1];
  const prompt = argv[argv.indexOf('-p') + 1];
  assert.equal(prompt, SECOND_PROMPT);
  assert.ok(prompt.includes(SECOND_AGENT_TYPE), prompt);
  assert.equal(carriesSharedRule(prompt), false, 'an echo would pass');
  assert.ok(!argv.includes('--tools'), argv.join(' '));
});

test('writeFixture puts each marker only in its own skill\'s body, and neither in frontmatter', () => {
  const plugin = writeFixture(mkdtempSync(join(tmpdir(), 'cad-spp-fixture-')));
  const [one, two] = SKILLS.map((s) => readFileSync(join(plugin, 'skills', s, 'SKILL.md'), 'utf8'));
  const parts = (t) => { const fm = t.match(FRONTMATTER_RE); return { fm: fm[0], body: t.slice(fm[0].length) }; };
  assert.ok(parts(one).body.includes(MARKERS.first) && !parts(one).body.includes(MARKERS.second));
  assert.ok(parts(two).body.includes(MARKERS.second) && !parts(two).body.includes(MARKERS.first));
  const agent = readFileSync(join(plugin, 'agents', 'preload-proof.md'), 'utf8');
  for (const text of [parts(one).fm, parts(two).fm, agent]) {
    assert.ok(!text.includes(MARKERS.first) && !text.includes(MARKERS.second), text);
  }
});

test('what the stand-in was handed: a tool-less agent with both skills in order, a dispatch-only parent, no marker', () => {
  const { capture: [capture] } = run(stream({ returned: BOTH }));
  const fm = capture.agent.match(FRONTMATTER_RE)[1];
  assert.match(fm, /^tools:[ \t]*\[\][ \t]*$/m, 'the key present and empty - left out it grants every tool');
  assert.deepEqual(parseSkillsField(fm), [...SKILLS]);
  const { argv } = capture;
  assert.equal(argv[argv.indexOf('--tools') + 1], 'Agent');
  assert.equal(argv[argv.indexOf('--allowedTools') + 1], 'Agent');
  assert.equal(argv.filter((a) => a === '--tools' || a === '--allowedTools').length, 2, 'one of each, no widening');
  const prompt = argv[argv.indexOf('-p') + 1];
  assert.ok(!prompt.includes(MARKERS.first) && !prompt.includes(MARKERS.second), 'an echo would pass');
});

test('only the first skill\'s line back fails naming the second marker', () => {
  const r = run(stream({ returned: FIRST_ONLY }));
  assert.notEqual(r.status, 0);
  assert.ok(r.stdout.includes(MARKERS.second), r.stdout);
});

test('a Read inside the subagent fails naming the count, though the marker came back', () => {
  const r = run(stream({ returned: BOTH, subagentReads: 1 }));
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /subagent_tool_calls is 1/);
});

test('a parent Read beside the dispatch fails naming the count', () => {
  const r = run(stream({ returned: BOTH, parentReads: 1 }));
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /parent_other_calls is 1/);
});

test('the marker only in the parent\'s final text fails', () => {
  const r = run(stream({ returned: FIRST_ONLY, finalText: BOTH }));
  assert.notEqual(r.status, 0);
  assert.ok(r.stdout.includes(MARKERS.second), r.stdout);
});

test('a dispatch input carrying the second marker fails naming the dispatch input', () => {
  const r = run(stream({ returned: BOTH, dispatchPrompt: `Reply with ${MARKERS.second}.` }));
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /dispatch-input-carries-marker/);
  assert.equal(existsSync(r.out), false, 'a failed run must not leave a file that reads as a pass');
});

test('a stream with no record from inside the subagent fails naming that cause', () => {
  const r = run(stream({ returned: BOTH, nested: false }));
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /no-subagent-record/);
  assert.equal(existsSync(r.out), false, 'an unchecked 0 must never be stored');
});

test('a host that exits non-zero, and no host on PATH, fail and write no result', () => {
  for (const r of [run(stream({ returned: BOTH }), SECOND_OK, 1), run(null)]) {
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /host-did-not-run/);
    assert.equal(existsSync(r.out), false, 'a check that did not run records nothing');
  }
});

/** What the stored result fails on, run by run, through the script's own judges, so a mutated copy meets the same assertions. */
const storedFailures = (stored) => [
  ...judge({ returned: stored.first.returned, subagentToolCalls: stored.first.subagent_tool_calls,
    parentOtherCalls: stored.first.parent_other_calls }).map((f) => `first:${f.reason}`),
  ...judgeSecond({ returned: stored.second.returned, subagentToolCalls: stored.second.subagent_tool_calls })
    .map((f) => `second:${f.reason}`),
];

test('the stored result holds both runs\' markers, every count at 0, the agents dispatched and the host version', () => {
  const stored = JSON.parse(readFileSync(STORED_RESULT, 'utf8'));
  assert.deepEqual(storedFailures(stored), []);
  assert.equal(stored.first.agent, AGENT_TYPE);
  assert.equal(stored.second.agent, SECOND_AGENT_TYPE);
  for (const run of [stored.first, stored.second]) assert.match(String(run.host_version), /^\d+\.\d+\.\d+/);
  // the same assertions refuse a copy with either marker line gone, and one with any count at 1
  const without = (run, keep) => ({ ...stored, [run]: { ...stored[run],
    returned: stored[run].returned.split('\n').filter(keep).join('\n') } });
  assert.deepEqual(storedFailures(without('first', (l) => !l.includes(MARKERS.second))), ['first:second-marker-missing']);
  assert.deepEqual(storedFailures(without('second', (l) => !carriesSharedRule(l))), ['second:shared-rule-missing']);
  const withCount = (run, key) => ({ ...stored, [run]: { ...stored[run], [key]: 1 } });
  assert.deepEqual(storedFailures(withCount('first', 'subagent_tool_calls')), ['first:subagent-tool-calls']);
  assert.deepEqual(storedFailures(withCount('first', 'parent_other_calls')), ['first:parent-other-calls']);
  assert.deepEqual(storedFailures(withCount('second', 'subagent_tool_calls')), ['second:subagent-tool-calls']);
});

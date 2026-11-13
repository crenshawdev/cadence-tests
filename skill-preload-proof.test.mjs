// Zero-dep tests for skill-preload-proof.mjs, the stored proof that the host preloads an agent's second skill (D-02).
// Run: node --test tests/skill-preload-proof.test.mjs
//
// Harness: a stand-in `claude` alone on the child's PATH. It records what it was handed (argv, the fixture's agent
// file) and prints a canned stream-json run. The records below are cut down from a real Claude Code 2.1.323 stream
// captured on 2026-11-13 with --verbose and --forward-subagent-text: same types, keys and nesting, usage noise dropped.
// No test runs the real host; the script always writes to a temp --out here, never to the stored file.
// The last test reads the stored file the real host wrote, judged by the script's own judge() and markers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MARKERS, AGENT_TYPE, SKILLS, STORED_RESULT, judge } from '../cadence-core/bin/skill-preload-proof.mjs';
import { FRONTMATTER_RE, parseSkillsField } from '../cadence-core/bin/lib/frontmatter.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'cadence-core', 'bin', 'skill-preload-proof.mjs');
const ID = 'toolu_01TiUZwgm1n35yihEuMCB8mh';
const SESSION = '555e4c5a-00fd-434d-a7db-4d5b36dfc4be';
const BOTH = `- proof-first: ${MARKERS.first}\n- proof-second: ${MARKERS.second}`;
const FIRST_ONLY = `- proof-first: ${MARKERS.first}`;

// Absolute shebang, so the child's PATH can hold the stand-in and nothing else
const STUB = `#!${process.execPath}
const fs = require('fs'), path = require('path');
const argv = process.argv.slice(2);
const agents = path.join(argv[argv.indexOf('--plugin-dir') + 1], 'agents');
const agent = fs.readFileSync(path.join(agents, fs.readdirSync(agents)[0]), 'utf8');
fs.writeFileSync(process.env.STUB_CAPTURE, JSON.stringify({ argv, agent }));
process.stdout.write(fs.readFileSync(process.env.STUB_STREAM, 'utf8'));
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
 *   dispatchPrompt?: string, nested?: boolean}} o
 */
function stream(o) {
  const reads = o.subagentReads || 0;
  const prompt = o.dispatchPrompt || 'Reply with the line each of your preloaded skills holds, verbatim.';
  const recs = [
    { type: 'system', subtype: 'init', cwd: '/tmp/x', session_id: SESSION, tools: ['Task'],
      claude_code_version: '2.1.323', agents: ['general-purpose', AGENT_TYPE] },
    assistant([{ type: 'text', text: 'Dispatching the preload-proof agent.' }]),
    assistant([toolUse(ID, 'Agent', { description: 'Report preloaded skill lines', subagent_type: AGENT_TYPE,
      prompt, run_in_background: false })]),
  ];
  for (let i = 0; i < (o.parentReads || 0); i++) {
    recs.push(assistant([toolUse(`toolu_parent_read_${i}`, 'Read', { file_path: '/tmp/x/SKILL.md' })]));
  }
  recs.push({ type: 'system', subtype: 'task_started', task_id: 'a5ec3c505042bba18', tool_use_id: ID,
    subagent_type: AGENT_TYPE, prompt, session_id: SESSION });
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
    tool_use_result: { status: 'completed', agentId: 'a5ec3c505042bba18', agentType: AGENT_TYPE,
      content: [{ type: 'text', text: o.returned }] },
  });
  const finalText = o.finalText || `The preload-proof agent returned:\n\n${o.returned}`;
  recs.push(assistant([{ type: 'text', text: finalText }]));
  recs.push({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, result: finalText, session_id: SESSION });
  return recs.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

/**
 * Run the script against a stand-in, or against no `claude` at all when `streamText` is null.
 * @param {string|null} streamText @param {number} [exitCode]
 */
function run(streamText, exitCode = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'cad-spp-'));
  const bin = join(dir, 'bin');
  const env = { ...process.env, PATH: bin, STUB_CAPTURE: join(dir, 'capture.json'),
    STUB_STREAM: join(dir, 'stream.jsonl'), STUB_EXIT: String(exitCode) };
  mkdirSync(bin);
  if (streamText !== null) {
    writeFileSync(join(bin, 'claude'), STUB);
    chmodSync(join(bin, 'claude'), 0o755);
    writeFileSync(env.STUB_STREAM, streamText);
  }
  const out = join(dir, 'result.json');
  const r = spawnSync(process.execPath, [SCRIPT, '--out', out], { env, encoding: 'utf8' });
  return {
    status: r.status, stdout: r.stdout, out,
    capture: existsSync(env.STUB_CAPTURE) ? JSON.parse(readFileSync(env.STUB_CAPTURE, 'utf8')) : null,
  };
}

test('the second marker back with both counts 0 passes and stores the marker and the counts', () => {
  const r = run(stream({ returned: BOTH }));
  assert.equal(r.status, 0, r.stdout);
  const stored = JSON.parse(readFileSync(r.out, 'utf8'));
  assert.ok(stored.returned.includes(MARKERS.second));
  assert.equal(stored.came_back.second, true);
  assert.equal(stored.subagent_tool_calls, 0);
  assert.equal(stored.parent_other_calls, 0);
  assert.equal(stored.host_version, '2.1.323');
});

test('what the stand-in was handed: a tool-less agent with both skills in order, a dispatch-only parent, no marker', () => {
  const { capture } = run(stream({ returned: BOTH }));
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
});

test('a stream with no record from inside the subagent fails naming that cause', () => {
  const r = run(stream({ returned: BOTH, nested: false }));
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /no-subagent-record/);
});

test('a host that exits non-zero, and no host on PATH, fail and write no result', () => {
  for (const r of [run(stream({ returned: BOTH }), 1), run(null)]) {
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /host-did-not-run/);
    assert.equal(existsSync(r.out), false, 'a check that did not run records nothing');
  }
});

/** What the stored result fails on, through the script's own judge, so a mutated copy meets the same assertions. */
const storedFailures = (stored) => judge({ returned: stored.returned,
  subagentToolCalls: stored.subagent_tool_calls, parentOtherCalls: stored.parent_other_calls }).map((f) => f.reason);

test('the stored result holds the second marker, both counts at 0, and the host version it ran on', () => {
  const stored = JSON.parse(readFileSync(STORED_RESULT, 'utf8'));
  assert.deepEqual(storedFailures(stored), []);
  assert.match(String(stored.host_version), /^\d+\.\d+\.\d+/);
  // the same assertions refuse a copy with the marker line gone, and one with either count at 1
  const noLine = stored.returned.split('\n').filter((l) => !l.includes(MARKERS.second)).join('\n');
  assert.deepEqual(storedFailures({ ...stored, returned: noLine }), ['second-marker-missing']);
  assert.deepEqual(storedFailures({ ...stored, subagent_tool_calls: 1 }), ['subagent-tool-calls']);
  assert.deepEqual(storedFailures({ ...stored, parent_other_calls: 1 }), ['parent-other-calls']);
});

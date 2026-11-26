// Zero-dep tests for runs on an agile project: every piece of work is phase 0 there, so a close follows its own dispatch.
// Run: node --test tests/agile-runs.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerSetup, scratch } from './planning.test.mjs';
import { recordsDir } from '../cadence-core/bin/lib/planning-store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', 'cadence-core', 'bin');
const FIXTURE = join(HERE, 'fixtures', 'seldon-design');

const call = (cwd, script, ...args) => {
  const r = spawnSync('node', [join(BIN, script), ...args], { cwd, encoding: 'utf8', input: '{}', env: { ...process.env, OPENAI_API_KEY: '' } });
  return JSON.parse(r.stdout);
};
const planning = (cwd, ...args) => call(cwd, 'planning.mjs', ...args);

/** A repository with a started release. */
function started(t) {
  const root = scratch('cad-agile-runs-', t);
  execFileSync('git', ['-C', root, 'init', '-q', '-b', 'work']);
  const dir = answerSetup(join(root, '.planning'));
  assert.equal(call(root, 'agile.mjs', 'start', '--design', FIXTURE).ok, true);
  return { root, dir };
}

const events = (dir) => readFileSync(join(recordsDir(dir), 'trace.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const open = (root, sha) => planning(root, 'trace', 'append', '--phase', '0', '--family', 'lifecycle', '--event', 'phase_start', '--sha', sha).corr;
const dispatch = (root, plan, role) => planning(root, 'trace', 'append', '--phase', '0', '--family', 'lifecycle', '--event', 'dispatch', '--plan', plan, '--role', role);
const close = (root, plan, role, ...more) => planning(root, 'trace', 'close', '--phase', '0', '--plan', plan, '--role', role, ...more);
// the SubagentStop hook itself, for a worker that stopped with no transcript to read
const stop = (root, id) => spawnSync('node', [join(BIN, 'subagent-trace.mjs')],
  { input: JSON.stringify({ cwd: root, agent_type: 'cadence:cad-reviewer', agent_id: id }), encoding: 'utf8' });

test('two pieces of work open at once each close under their own run, and nothing is left unpaired', (t) => {
  const { root } = started(t);
  const first = open(root, 'aaaaaaa-1');
  dispatch(root, 'e-01-1', 'cad-task');
  dispatch(root, 'e-01-1-review', 'cad-reviewer');
  const second = open(root, 'bbbbbbb-2');
  dispatch(root, 'fix-typo', 'cad-task');
  assert.equal(close(root, 'e-01-1-review', 'cad-reviewer', '--tokens', '100').corr, first);
  assert.equal(close(root, 'e-01-1', 'cad-task').corr, first);
  assert.equal(close(root, 'fix-typo', 'cad-task').corr, second);
  const render = planning(root, 'trace', 'render', '--phase', '0');
  assert.deepEqual(render.unpaired, []);
  assert.equal(render.roles['cad-reviewer'].tokens, 100);
});

test('two live runs each sending a reviewer: the real stop hook and the hand-written closes give each its own bracket', (t) => {
  const { root, dir } = started(t);
  const first = open(root, 'aaaaaaa-1');
  dispatch(root, 'e-01-1-review', 'cad-reviewer');
  const second = open(root, 'bbbbbbb-2');
  dispatch(root, 'e-01-2-review', 'cad-reviewer');
  stop(root, 'a1');
  assert.equal(close(root, 'e-01-1-review', 'cad-reviewer', '--agent-id', 'a1', '--tokens', '100').corr, first);
  stop(root, 'b2');
  assert.equal(close(root, 'e-01-2-review', 'cad-reviewer', '--agent-id', 'b2', '--tokens', '200').corr, second);
  const render = planning(root, 'trace', 'render', '--phase', '0');
  assert.deepEqual(render.unpaired, []);
  assert.deepEqual(render.brackets.map((b) => [b.corr, b.plan, b.agent_id, b.tokens]),
    [[first, 'e-01-1-review', 'a1', 100], [second, 'e-01-2-review', 'b2', 200]]);
  // the hook stayed out of the first stop, where two runs each held an open reviewer, and closed the second
  assert.deepEqual(events(dir).filter((e) => e.event === 'return' && e.tokens === undefined).map((e) => e.agent_id), ['b2']);
});

test("a close whose own dispatch never landed stays on its own run, leaving an earlier run's finished bracket alone", (t) => {
  const { root } = started(t);
  const first = open(root, 'aaaaaaa-1');
  dispatch(root, 'cad-reviewer', 'cad-reviewer');
  close(root, 'cad-reviewer', 'cad-reviewer', '--agent-id', 'a1', '--tokens', '100');
  const before = planning(root, 'trace', 'render', '--phase', '0').brackets;
  const second = open(root, 'bbbbbbb-2');
  assert.equal(close(root, 'cad-reviewer', 'cad-reviewer', '--agent-id', 'b2', '--tokens', '200').corr, second);
  const after = planning(root, 'trace', 'render', '--phase', '0').brackets.filter((b) => b.corr === first);
  assert.deepEqual(after.map((b) => [b.end, b.tokens]), before.map((b) => [b.end, b.tokens]));
});

test('a close with no dispatch of its plan, or with --anchor, takes the run it took before', (t) => {
  const { root } = started(t);
  const first = open(root, 'aaaaaaa-1');
  const second = open(root, 'bbbbbbb-2');
  assert.equal(close(root, 'never-sent', 'cad-task').corr, second);
  dispatch(root, 'later', 'cad-task');
  assert.equal(close(root, 'later', 'cad-task', '--anchor', 'aaaaaaa-1').corr, first);
});

test('the router and an outside reviewer record under phase 0 on an agile project with no --phase', (t) => {
  const { root, dir } = started(t);
  const run = open(root, 'aaaaaaa-1');
  assert.equal(call(root, 'route.mjs', 'resolve', '--role', 'cad-reviewer', '--bracket-read', 'a.diff', '--bracket-plan', 'e-01-1-review').ok, true);
  const out = call(root, 'review-provider.mjs', 'review', '--provider', 'openai', '--model', 'gpt-5', '--key-file', join(root, 'absent.env'));
  assert.equal(out.reason, 'no-key');
  const got = events(dir).filter((e) => ['routing/resolve', 'lifecycle/dispatch', 'provider/request'].includes(`${e.family}/${e.event}`));
  assert.deepEqual(got.map((e) => [`${e.family}/${e.event}`, String(e.phase), e.corr]), [
    ['lifecycle/dispatch', '0', run], ['routing/resolve', '0', run], ['provider/request', '0', run]]);
});

test("an agent id seen only before this close's own dispatch is a reused one, and doesn't move the close", (t) => {
  const { root } = started(t);
  const first = open(root, 'aaaaaaa-1');
  dispatch(root, 'e-01-1-review', 'cad-reviewer');
  close(root, 'e-01-1-review', 'cad-reviewer', '--agent-id', 'a1', '--tokens', '100');
  const second = open(root, 'bbbbbbb-2');
  dispatch(root, 'e-01-1-review', 'cad-reviewer');
  assert.notEqual(first, second);
  assert.equal(close(root, 'e-01-1-review', 'cad-reviewer', '--agent-id', 'a1', '--tokens', '200').corr, second);
  assert.deepEqual(planning(root, 'trace', 'render', '--phase', '0').unpaired, []);
});

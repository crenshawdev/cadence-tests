// Zero-dep tests for the planning.mjs calls an agile project runs too, each driven on a started release.
// Run: node --test tests/agile-calls.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerSetup, scratch } from './planning.test.mjs';
import { markAgile, statePath } from '../cadence-core/bin/lib/project-state.mjs';
import { appendRead } from '../cadence-core/bin/lib/read-trace.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', 'cadence-core', 'bin');
const FIXTURE = join(HERE, 'fixtures', 'seldon-design');

const call = (cwd, script, ...args) => {
  const r = spawnSync('node', [join(BIN, script), ...args], { cwd, encoding: 'utf8' });
  return JSON.parse(r.stdout);
};
const git = (root, ...args) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' }).trim();

/** A repository with a started release and two commits, and the two commits' ids. */
function started(t) {
  const root = scratch('cad-agile-calls-', t);
  git(root, 'init', '-q', '-b', 'work');
  const dir = answerSetup(join(root, '.planning'));
  assert.equal(call(root, 'agile.mjs', 'start', '--design', FIXTURE).ok, true);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'start');
  const base = git(root, 'rev-parse', 'HEAD');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'login.mjs'), 'export function login(password) { return password === process.env.SECRET; }\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'login');
  return { root, dir, base, head: git(root, 'rev-parse', 'HEAD') };
}

test('every shared call runs on a started release, the run is recorded, and the marker keeps its bytes', (t) => {
  const { root, dir, base, head } = started(t);
  const marker = readFileSync(statePath(dir), 'utf8');
  const missing = join(root, 'no-run.json');
  const trace = (...args) => ['trace', ...args];
  /** @type {[string[], (r: any) => void][]} */
  const calls = [
    [trace('append', '--phase', '0', '--family', 'lifecycle', '--event', 'phase_start', '--sha', 'abc1234-1'), (r) => assert.equal(r.written, true)],
    [trace('append', '--phase', '0', '--family', 'lifecycle', '--event', 'dispatch', '--plan', 'one', '--role', 'cad-task'), (r) => assert.equal(r.written, true)],
    [trace('close', '--phase', '0', '--plan', 'one', '--role', 'cad-task'), (r) => assert.equal(r.written, true)],
    [['risk-check', 'run', '--phase', '0', '--base', base, '--head', head], (r) => {
      assert.equal(r.trace.written, true);
      assert.deepEqual(r.categories, ['auth', 'secrets']);
      assert.ok(r.matches.length > 0);
    }],
    [['risk-check', 'status', '--phase', '0'], (r) => assert.equal(r.ok, true)],
    [['test-policy', 'render', '--root', '.'], (r) => assert.equal(r.policy.scope, 'focused')],
    // the fixture has no workflow file, so the check disagrees, which is its own answer
    [['test-policy', 'check', '--root', '.'], (r) => assert.deepEqual([r.reason, r.accepted], ['policy-disagrees', true])],
    [['test-policy', 'ci-status', '--root', '.', '--commit', head], (r) => assert.deepEqual([r.ok, r.answer], [true, 'pending'])],
    [['detect-surfaces', '--root', '.', '--answered', 'auth,secrets'], (r) => assert.ok(r.options.length > 0)],
    [['detect-commands', '--root', '.'], (r) => assert.equal(r.ok, true)],
    [['codemap', 'scan'], (r) => assert.ok(r.files > 0)],
    [['codemap', 'status'], (r) => assert.ok(r.modules > 0)],
    [['codemap', 'slice', '--files', 'src/login.mjs'], (r) => assert.equal(r.ok, true)],
    // a run file that isn't there is refused by the handler, after it billed the run
    [['codemap', 'write', '--run-file', missing, '--notice-tokens', '5'], (r) => assert.deepEqual([r.reason, r.brackets.written], ['run-unreadable', 1])],
    [['recall', 'login'], (r) => assert.deepEqual([r.ok, r.total], [true, 0])],
    [trace('suggest'), (r) => assert.equal(r.ok, true)],
    [trace('window'), (r) => assert.equal(r.ok, true)],
  ];
  for (const [args, holds] of calls) {
    const r = call(root, 'planning.mjs', ...args);
    assert.notEqual(r.reason, 'agile-path', args.join(' '));
    holds(r);
    assert.equal(readFileSync(statePath(dir), 'utf8'), marker, args.join(' '));
  }
  // what writes past the gate: the router's own event and the read hook's record
  assert.equal(call(root, 'route.mjs', 'resolve', '--role', 'cad-mapper', '--attempt', '1', '--phase', '0').ok, true);
  assert.equal(appendRead(dir, { ts: '2026-01-01T00:00:00.000Z', tool: 'Read', target: '/a' }).written, true);

  const seen = call(root, 'planning.mjs', 'trace', 'render', '--events').events.map((e) => `${e.family}/${e.event}`);
  for (const event of ['lifecycle/phase_start', 'lifecycle/dispatch', 'lifecycle/return', 'outcome/risk_check', 'routing/resolve']) {
    assert.ok(seen.includes(event), event);
  }
  const { brackets } = call(root, 'planning.mjs', 'trace', 'render', '--phase', '0');
  assert.deepEqual(brackets.map((b) => b.role), ['cad-task', 'cad-mapper']);
  assert.equal(readFileSync(statePath(dir), 'utf8'), marker);
  assert.equal(git(root, 'status', '--porcelain', '--', '.planning'), '');
});

test("a story's deferred fire queues its findings in the story's folder, and the queue's readers stay the old path's", (t) => {
  const { root, dir, base, head } = started(t);
  const tasks = join(dir, 'agile', 'tasks', 'E-01-1');
  mkdirSync(tasks, { recursive: true });
  const payload = join(root, 'payload.json');
  writeFileSync(payload, JSON.stringify({ findings: [{ file: 'src/login.mjs', line: 1, severity: 'high', claim: 'a plain compare', failure_scenario: 'timing tells' }] }));
  const r = call(root, 'planning.mjs', 'deferred', 'record', '--phase', '0', '--trigger', 'risk_surface', '--discriminator', `${base.slice(0, 7)}-${head.slice(0, 7)}`,
    '--base', base, '--head', head, '--payload', payload, '--task', 'E-01-1');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.record, `agile/tasks/E-01-1/DEFERRED-risk_surface-${base.slice(0, 7)}-${head.slice(0, 7)}.json`);
  assert.equal(JSON.parse(readFileSync(join(dir, r.record), 'utf8')).findings.length, 1);
  for (const args of [['deferred', 'list'], ['deferred', 'carry', '--phase', '1']]) {
    assert.equal(call(root, 'planning.mjs', ...args).reason, 'agile-path', args.join(' '));
  }
});

test('a shared call on a project whose start died after its marker is recorded, and the next start finishes', (t) => {
  const root = scratch('cad-agile-half-', t);
  const dir = answerSetup(join(root, '.planning'));
  assert.equal(markAgile(dir).ok, true);
  const marker = readFileSync(statePath(dir), 'utf8');
  const append = ['trace', 'append', '--phase', '0', '--family', 'lifecycle', '--event', 'phase_start', '--sha', 'abc1234-1'];
  assert.equal(call(root, 'planning.mjs', ...append).written, true);
  assert.equal(readFileSync(statePath(dir), 'utf8'), marker);
  assert.equal(call(root, 'agile.mjs', 'start', '--design', FIXTURE).ok, true);
  assert.equal(readFileSync(statePath(dir), 'utf8'), marker);
  assert.equal(call(root, 'planning.mjs', 'trace', 'render', '--phase', '0').corr, '0-abc1234-1');
});

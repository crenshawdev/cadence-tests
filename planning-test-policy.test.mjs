// Zero-dep tests for `planning.mjs test-policy`. Run:
// node --test tests/planning-test-policy.test.mjs
//
// Fixtures are a project root holding a `.planning/config.json` and, where a
// check needs them, workflow files and a git repository. Nothing here runs an
// accepted command (D-03) or reaches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLANNING, ensureRoadmap } from './planning.test.mjs';
import { stub } from './issue-check.test.mjs';

const POLICY = join('.github', 'cadence', 'coverage-policy.json');

/** A project root whose repo config holds `testing` (and `git`, when given). */
function project(testing, git) {
  const root = mkdtempSync(join(tmpdir(), 'cad-testpolicy-'));
  mkdirSync(join(root, '.planning'));
  writeFileSync(join(root, '.planning', 'config.json'),
    JSON.stringify({ ...(testing ? { testing } : {}), ...(git ? { git } : {}) }));
  return root;
}

/** One seam call, parsed. The user-global layer is pointed at a file that
 *  does not exist, so no machine's own config reaches the fixture. */
function policy(args, root, env) {
  let stdout;
  let code = 0;
  try {
    stdout = execFileSync('node', [PLANNING, 'test-policy', ...args, '--root', root], {
      encoding: 'utf8',
      env: { ...process.env, CADENCE_GLOBAL_CONFIG: join(root, 'no-global.json'), ...env },
    });
  } catch (e) { stdout = e.stdout; code = e.status; }
  return { ...JSON.parse(stdout), _exit: code };
}

test('render writes the config\'s values with the schema defaults filled, byte-identically on a re-render', () => {
  const root = project({ scope: 'integrated', coverage: { lines: 90, commands: ['npm run cov -- --lines={lines}'] }, required_jobs: ['test'] });
  const r = policy(['render'], root);
  assert.equal(r.ok, true);
  assert.equal(r.file, POLICY);
  const first = readFileSync(join(root, POLICY), 'utf8');
  assert.deepEqual(JSON.parse(first), {
    scope: 'integrated',
    coverage: { lines: 90, branches: 85, statements: 0, include: [], exclude: [], commands: ['npm run cov -- --lines={lines}'] },
    strong_areas: [],
    required_jobs: ['test'],
  });
  assert.ok(first.endsWith('}\n'));
  policy(['render'], root);
  assert.equal(readFileSync(join(root, POLICY), 'utf8'), first);
});

test('render refuses with a hint when no policy was accepted, and writes nothing', () => {
  const root = project({ coverage: { lines: 90 } });
  const r = policy(['render'], root);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-policy');
  assert.match(r.hint, /\/cad-config --testing/);
  assert.equal(existsSync(join(root, POLICY)), false);
  assert.equal(policy(['bogus'], root).reason, 'usage');
});

// --- check: the config, the committed file and the workflow files ----------

const COMMAND = 'node --test --test-coverage-lines={lines} --test-coverage-branches={branches}';

/** The workflow step that runs COMMAND at 90 and 80, folded over three lines
 *  the way a YAML `>` scalar is, so normalization is exercised by every arm. */
const WORKFLOW = `jobs:
  coverage:
    steps:
      - run: >
          node --test
          --test-coverage-lines=90
          --test-coverage-branches=80
`;

/** A rendered project whose config, file and workflow agree. `workflow` and
 *  `git` override the defaults; `src/a.js` is tracked so the include glob matches. */
function agreeing({ workflow = WORKFLOW, git = { forge_provider: 'github' }, tracked = true } = {}) {
  const root = project({
    scope: 'focused',
    coverage: { lines: 90, branches: 80, include: ['src/**'], commands: [COMMAND] },
    required_jobs: ['coverage'],
  }, git);
  execFileSync('git', ['-C', root, 'init', '-q']);
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'a.js'), '');
  execFileSync('git', ['-C', root, 'add', 'src/a.js']);
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(root, '.github', 'workflows', 'test.yml'), workflow);
  assert.equal(policy(['render'], root).ok, true);
  if (tracked) execFileSync('git', ['-C', root, 'add', POLICY]);
  return root;
}

test('check passes on an agreeing project and reports whether publishing is authorized here', () => {
  const root = agreeing();
  const r = policy(['check'], root);
  assert.deepEqual([r.ok, r.accepted, r.enforcement, r.gate_found, r.problems, r.publish_authorized],
    [true, true, 'available', true, [], false]);

  execFileSync('git', ['-C', root, 'config', '--local', 'cadence.publishForVerification', 'true']);
  assert.equal(policy(['check'], root).publish_authorized, true);

  // Another repository's setting never speaks for this one, even when the
  // environment points git at it (D-02).
  const other = agreeing();
  execFileSync('git', ['-C', other, 'config', '--local', 'cadence.publishForVerification', 'true']);
  execFileSync('git', ['-C', root, 'config', '--local', '--unset', 'cadence.publishForVerification']);
  assert.equal(policy(['check'], root, { GIT_DIR: join(other, '.git') }).publish_authorized, false);
});

test('check fails on a threshold mismatch between the config and the file', () => {
  const root = agreeing();
  const config = join(root, '.planning', 'config.json');
  const edited = JSON.parse(readFileSync(config, 'utf8'));
  edited.testing.coverage.lines = 95;
  writeFileSync(config, JSON.stringify(edited));
  const r = policy(['check'], root);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'policy-disagrees');
  assert.match(r.detail, /testing\.coverage\.lines is 95 in the config and 90 in/);
});

test('check fails on an accepted command that only a comment holds, and the gate is not found', () => {
  const root = agreeing({ workflow: WORKFLOW.replace(/^( {10}.*)$/gm, '#$1').replace('- run: >', '- run: echo') });
  const r = policy(['check'], root);
  assert.equal(r.ok, false);
  assert.equal(r.gate_found, false);
  assert.match(r.detail, /accepted command "node --test/);
});

test('check fails when GitHub enforcement has no coverage command while a threshold is above 0', () => {
  const root = agreeing();
  const config = join(root, '.planning', 'config.json');
  const edited = JSON.parse(readFileSync(config, 'utf8'));
  edited.testing.coverage.commands = [];
  writeFileSync(config, JSON.stringify(edited));
  assert.equal(policy(['render'], root).ok, true);
  const r = policy(['check'], root);
  assert.equal(r.ok, false);
  assert.equal(r.gate_found, false);
  assert.match(r.detail, /testing\.coverage\.commands is empty/);
});

test('check reports enforcement unavailable off GitHub, and names a missing file', () => {
  const root = agreeing({ git: { forge_provider: 'gitlab' }, workflow: 'jobs: {}\n', tracked: false });
  const r = policy(['check'], root);
  assert.deepEqual([r.ok, r.enforcement, r.gate_found], [true, 'unavailable', null]);
  assert.match(r.note, /"gitlab"/);
  rmSync(join(root, POLICY));
  const gone = policy(['check'], root);
  assert.equal(gone.ok, false);
  assert.match(gone.detail, /coverage-policy\.json is missing/);
});

test('check fails on a policy file git does not track, because CI and --base cannot read it', () => {
  const r = policy(['check'], agreeing({ tracked: false }));
  assert.deepEqual([r.ok, r.gate_found], [false, false]);
  assert.match(r.detail, /not tracked by git/);
});

test('check on a project with no accepted policy says so and points at /cad-config --testing', () => {
  const r = policy(['check'], project(null));
  assert.deepEqual([r.ok, r.accepted, r.publish_authorized], [true, false, false]);
  assert.match(r.hint, /\/cad-config --testing/);
});

test('an unset forge is unanswered, not another forge: check fails and ci-status says what to set', () => {
  const root = agreeing({ git: { forge_repo: 'o/r' }, workflow: 'jobs: {}\n' });
  const r = policy(['check'], root);
  assert.deepEqual([r.ok, r.enforcement, r.gate_found], [false, 'unavailable', null]);
  assert.match(r.detail, /git\.forge_provider is unset/);
  const ci = policy(['ci-status', '--commit', 'ace48e6c1f0d'], root);
  assert.equal(ci.answer, 'pending');
  assert.match(ci.reason, /git\.forge_provider is unset/);
});

// --- check --base: weakening against a ref ----------------------------------

test('check --base names a lowered threshold, a disabled metric and a new exclude, and fails on none of them', () => {
  const root = agreeing({ tracked: false });
  const git = (...a) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a]);
  git('commit', '-q', '--allow-empty', '-m', 'before the policy');
  git('tag', 'empty');
  git('add', POLICY);
  git('commit', '-q', '-m', 'policy');

  const config = join(root, '.planning', 'config.json');
  const edited = JSON.parse(readFileSync(config, 'utf8'));
  Object.assign(edited.testing.coverage, { lines: 85, branches: 0, exclude: ['gen/**'] });
  writeFileSync(config, JSON.stringify(edited));
  writeFileSync(join(root, '.github', 'workflows', 'test.yml'),
    WORKFLOW.replace('lines=90', 'lines=85').replace('branches=80', 'branches=0'));
  assert.equal(policy(['render'], root).ok, true);

  const r = policy(['check', '--base', 'HEAD'], root);
  assert.equal(r.ok, true);
  assert.deepEqual(r.base.changes, [
    { kind: 'lowered', name: 'lines', from: 90, to: 85 },
    { kind: 'disabled', name: 'branches', from: 80, to: 0 },
    { kind: 'exclude_added', name: 'gen/**' },
  ]);

  const none = policy(['check', '--base', 'empty'], root);
  assert.deepEqual([none.ok, none.base.found, none.base.changes], [true, false, []]);
  assert.match(none.base.note, /absent or unreadable at empty/);

  const bad = policy(['check', '--base', 'no-such-ref'], root);
  assert.deepEqual([bad.ok, bad.reason], [false, 'bad-ref']);
  assert.ok(bad.hint);
});

// --- ci-status: required jobs for one commit, on recorded gh output ----------

const SHA = 'ace48e6c1f0d';

/** Recorded `gh api --paginate --jq` output: one compact object per check run. */
const runs = (...rs) => rs.map(([name, status, conclusion]) => JSON.stringify({ name, status, conclusion })).join('\n');

/** A GitHub project with a phase 1 checklist, and `gh` stubbed on PATH to print `body`. */
function ciProject(body) {
  const root = project({ scope: 'focused', required_jobs: ['node-test', 'self-verify'] },
    { forge_provider: 'github', forge_repo: 'o/r' });
  mkdirSync(join(root, '.planning', 'phases', '1'), { recursive: true });
  ensureRoadmap(join(root, '.planning'));
  writeFileSync(join(root, '.planning', 'phases', '1', 'UAT.md'),
    '---\nstatus: testing\nphase: 1\nupdated: 2026-11-03\n---\n\n## Items\n\n'
    + '### 1. Gate\nexpected: green\nstatus: pending_ci\njob: node-test\ncommit: ace48e6\n\n## Summary\n\ntotal: 1\n');
  const bin = mkdtempSync(join(tmpdir(), 'cad-ci-bin-'));
  stub(bin, 'gh', { body });
  const log = join(bin, 'argv.log');
  return { root, log, env: { PATH: `${bin}:${process.env.PATH}`, CAD_ARGV_LOG: log } };
}

function ciStatus({ root, env }, extra = []) {
  return policy(['ci-status', '--commit', SHA, '--dir', join(root, '.planning'), ...extra], root, env);
}

const uatStatus = (root) => JSON.parse(execFileSync('node', [PLANNING, 'uat', 'status', '--phase', '1',
  '--dir', join(root, '.planning')], { encoding: 'utf8' }));

test('ci-status passes when every required job succeeded, matrix names included, and the phase records the commit', () => {
  const p = ciProject(runs(['node-test (22, a)', 'completed', 'success'], ['node-test (24, b)', 'completed', 'success'],
    ['self-verify', 'completed', 'success'], ['node-testing', 'completed', 'failure']));
  const r = ciStatus(p, ['--phase', '1']);
  assert.equal(r.answer, 'pass');
  assert.equal(r.recorded, true);
  assert.deepEqual(r.jobs.map((j) => [j.job, j.answer]), [['node-test', 'pass'], ['self-verify', 'pass']]);
  const argv = readFileSync(p.log, 'utf8');
  assert.match(argv, new RegExp(`repos/o/r/commits/${SHA}/check-runs`));
  const after = uatStatus(p.root);
  assert.equal(after.ci, SHA);
  assert.equal(after.result, 'partial', 'recording the commit does not settle the pending_ci item');
});

test('ci-status fails when a required job failed, and records no commit', () => {
  const p = ciProject(runs(['node-test (22, a)', 'completed', 'success'], ['node-test (24, b)', 'completed', 'failure'],
    ['self-verify', 'completed', 'success']));
  const r = ciStatus(p, ['--phase', '1']);
  assert.equal(r.answer, 'fail');
  assert.equal(r.recorded, undefined);
  assert.equal(uatStatus(p.root).ci, undefined);
});

test('ci-status stays pending while a job has no finished run, re-reading under --wait', () => {
  const p = ciProject(runs(['node-test (22, a)', 'completed', 'success'], ['self-verify', 'in_progress', null]));
  const r = ciStatus(p, ['--wait', '1']);
  assert.equal(r.answer, 'pending');
  assert.equal(r.ok, true);
  assert.equal(readFileSync(p.log, 'utf8').trim().split('\n').length, 2, 'one read, then one re-read after the bound');
  assert.equal(ciStatus(ciProject(runs(['self-verify', 'completed', 'success']))).answer, 'pending', 'no run for node-test is not a pass');
});

// --- a config that can't answer is not "no policy" ---------------------------

test('a torn config or an invalid scope fails instead of reading as no policy', () => {
  const torn = project(null);
  writeFileSync(join(torn, '.planning', 'config.json'), '{"testing":{"scope":"focused"');
  const t = policy(['check'], torn);
  assert.deepEqual([t.ok, t.reason, t.accepted, t.gate_found], [false, 'config-unreadable', null, null]);
  assert.deepEqual(t.problems, [t.detail]);
  assert.equal(policy(['render'], torn).reason, 'config-unreadable');

  const bogus = project({ scope: 'bogus' });
  const b = policy(['check'], bogus);
  assert.deepEqual([b.ok, b.reason], [false, 'invalid-scope']);
  assert.match(b.detail, /"bogus"/);
  assert.equal(policy(['ci-status', '--commit', SHA], bogus).reason, 'invalid-scope');
  const read = JSON.parse(execFileSync('node', [join(PLANNING, '..', 'config.mjs'), 'get', 'testing.scope'], {
    cwd: bogus, encoding: 'utf8', env: { ...process.env, CADENCE_GLOBAL_CONFIG: join(bogus, 'no-global.json') },
  }));
  assert.match(read.warnings.join(' '), /testing\.scope.*"bogus"/);
});

// --- check: a tracked set past git's 1 MiB default read buffer ---------------

/** Stage `count` long paths under `dir/` in `root`'s index with no working files: one blob, many index entries. */
function bigIndex(root, dir, count) {
  const blob = execFileSync('git', ['-C', root, 'hash-object', '-w', '--stdin'], { input: 'x', encoding: 'utf8' }).trim();
  const pad = 'p'.repeat(180);
  const lines = [];
  for (let i = 0; i < count; i++) lines.push(`100644 ${blob}\t${dir}/${pad}${i}.js\n`);
  execFileSync('git', ['-C', root, 'update-index', '--add', '--index-info'], { input: lines.join('') });
}

test('check does not report a glob matching nothing when the tracked list is over 1 MiB', () => {
  const root = agreeing();
  bigIndex(root, 'big', 6000);
  const listed = execFileSync('git', ['-C', root, 'ls-files'], { maxBuffer: 64 << 20 }).length;
  assert.ok(listed > 1024 * 1024, `fixture must pass 1 MiB, got ${listed}`);
  const config = join(root, '.planning', 'config.json');
  const edited = JSON.parse(readFileSync(config, 'utf8'));
  edited.testing.coverage.include = ['big/**'];
  writeFileSync(config, JSON.stringify(edited));
  assert.equal(policy(['render'], root).ok, true);
  execFileSync('git', ['-C', root, 'add', POLICY]);
  const r = policy(['check'], root);
  assert.deepEqual(r.problems, [], JSON.stringify(r));
  assert.equal(r.ok, true);
});

test('check still reports an include glob that no tracked file matches', () => {
  const root = agreeing();
  const config = join(root, '.planning', 'config.json');
  const edited = JSON.parse(readFileSync(config, 'utf8'));
  edited.testing.coverage.include = ['src/**', 'nowhere/**'];
  writeFileSync(config, JSON.stringify(edited));
  assert.equal(policy(['render'], root).ok, true);
  execFileSync('git', ['-C', root, 'add', POLICY]);
  const r = policy(['check'], root);
  assert.equal(r.ok, false);
  assert.deepEqual(r.problems, ['coverage.include "nowhere/**" matches no tracked file']);
});

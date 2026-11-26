// Zero-dep tests for /cad-land's reads on the agile path - the deferred queue in each task's folder, and the branch the
// release was built on, named from its release.md.
// Run: node --test tests/agile-land.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { answerSetup, scratch } from './planning.test.mjs';
import { closingDir, releasesDir } from '../cadence-core/bin/lib/agile-paths.mjs';

const HERE = import.meta.dirname;
const AGILE = join(HERE, '..', 'cadence-core', 'bin', 'agile.mjs');
const PLANNING = join(HERE, '..', 'cadence-core', 'bin', 'planning.mjs');
const LAND = join(HERE, '..', 'cadence-core', 'bin', 'land-cleanup.mjs');
const FIXTURE = join(HERE, 'fixtures', 'seldon-design');
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b.c', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b.c' };
const json = (cmd, args, cwd) => {
  const r = spawnSync('node', [cmd, ...args], { cwd, encoding: 'utf8', env });
  return { ...JSON.parse(r.stdout), _exit: r.status };
};

/** A started release in a repository on its work branch, with main at the same commit. */
function started(t) {
  const root = join(scratch('cad-agile-land-', t), 'repo');
  mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'cadence/toolshed', root], { env });
  const dir = answerSetup(join(root, '.planning'));
  assert.equal(json(AGILE, ['start', '--design', FIXTURE, '--dir', dir], root).ok, true);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env });
  git('add', '-A');
  git('commit', '-q', '-m', 'docs: start the release');
  git('branch', 'main');
  return { root, dir, git };
}

test('deferred list on an agile project names a story\'s queued findings in its task folder, and none once a ruling sits beside them', (t) => {
  const { root, dir, git } = started(t);
  const task = join(dir, 'agile', 'tasks', 'e-01-1');
  mkdirSync(task, { recursive: true });
  const payload = join(root, '..', 'payload.json');
  writeFileSync(payload, JSON.stringify({ findings: [{ file: 'src.js', line: 1, severity: 'high', claim: 'x', failure_scenario: 'y' }] }));
  const base = git('rev-parse', '--short', 'HEAD').trim();
  const recorded = json(PLANNING, ['--dir', dir, 'deferred', 'record', '--phase', '0', '--trigger', 'risk_surface', '--discriminator', 'a-b',
    '--base', base, '--head', 'HEAD', '--payload', payload, '--task', 'e-01-1'], root);
  assert.equal(recorded.ok, true, JSON.stringify(recorded));
  const listed = json(PLANNING, ['--dir', dir, 'deferred', 'list'], root);
  assert.deepEqual([listed.ok, listed.findings, listed.members.map((m) => [m.phase, m.trigger, m.discriminator])],
    [true, 1, [['0', 'risk_surface', 'a-b']]], JSON.stringify(listed));
  assert.match(listed.members[0].path, /^agile\/tasks\/e-01-1\//);
  writeFileSync(join(task, 'ADJUDICATION-risk_surface-a-b.json'), '{}\n');
  assert.deepEqual(json(PLANNING, ['--dir', dir, 'deferred', 'list'], root).members, []);
});

test('land-cleanup names the branch from the open release, and after a close from the release it moved', (t) => {
  const { root, dir } = started(t);
  const branch = () => json(LAND, ['cleanup', '--base', 'main'], root).branch;
  assert.equal(branch(), 'cadence/toolshed');
  const agile = join(dir, 'agile');
  mkdirSync(closingDir(agile, '1.0.0'), { recursive: true });
  for (const name of ['epics', 'REQUIREMENTS.md', 'release.md']) renameSync(join(agile, name), join(closingDir(agile, '1.0.0'), name));
  renameSync(closingDir(agile, '1.0.0'), join(releasesDir(agile), '1.0.0'));
  assert.equal(branch(), 'cadence/toolshed');
  // a configured name still wins, as on the old path
  const config = join(dir, 'config.json');
  const c = JSON.parse(readFileSync(config, 'utf8'));
  writeFileSync(config, JSON.stringify({ ...c, git: { ...(c.git ?? {}), integration_branch_name: 'cadence/mine' } }));
  execFileSync('git', ['branch', 'cadence/mine'], { cwd: root, env });
  assert.equal(branch(), 'cadence/mine');
});

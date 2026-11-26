// Zero-dep tests for /cad-land's reads on the agile path - the deferred queue in each task's folder, and the branch the
// release was built on, named from its release.md.
// Run: node --test tests/agile-land.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, utimesSync, writeFileSync } from 'node:fs';
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

/** Close the started release as `version`, the moves agile.mjs close makes. */
function close(dir, version) {
  const agile = join(dir, 'agile');
  mkdirSync(closingDir(agile, version), { recursive: true });
  for (const name of ['epics', 'REQUIREMENTS.md', 'release.md']) renameSync(join(agile, name), join(closingDir(agile, version), name));
  renameSync(closingDir(agile, version), join(releasesDir(agile), version));
}

test('land-cleanup names the branch from the open release, and after a close from the release it moved', (t) => {
  const { root, dir, git } = started(t);
  // a second merged cadence/* branch, so the one-branch fallback can't name toolshed for it
  git('branch', 'cadence/other');
  const branch = () => json(LAND, ['cleanup', '--base', 'main'], root).branch;
  assert.equal(branch(), 'cadence/toolshed');
  close(dir, '1.0.0');
  assert.equal(branch(), 'cadence/toolshed');
  // a configured name still wins, as on the old path
  const config = join(dir, 'config.json');
  const c = JSON.parse(readFileSync(config, 'utf8'));
  writeFileSync(config, JSON.stringify({ ...c, git: { ...(c.git ?? {}), integration_branch_name: 'cadence/mine' } }));
  execFileSync('git', ['branch', 'cadence/mine'], { cwd: root, env });
  assert.equal(branch(), 'cadence/mine');
});

test('land-cleanup prints the newest closed release for the tag: the highest version, and never a folder git would refuse as a tag', (t) => {
  const { root, dir } = started(t);
  const cleanup = () => json(LAND, ['cleanup', '--base', 'main'], root);
  assert.equal(cleanup().release, null);
  close(dir, '0.10.0');
  const releases = releasesDir(join(dir, 'agile'));
  utimesSync(join(releases, '0.10.0'), 1e9, 1e9);
  // newer than 0.10.0, so a newest-by-mtime pick would take one of them
  for (const name of ['0.9.0', 'notes', '9.9.9;touch pwned', '-f']) {
    mkdirSync(join(releases, name));
    writeFileSync(join(releases, name, 'release.md'), '# Release: Hostile\n\n## Epics\n\n- E-01: x\n');
  }
  const out = cleanup();
  assert.deepEqual(out.release, { version: '0.10.0', title: 'Toolshed' }, JSON.stringify(out));
  assert.equal(out.warnings.filter((w) => w.includes('9.9.9;touch pwned') || w.includes('"-f"')).length, 2, JSON.stringify(out.warnings));
});

test('land-cleanup on the old path prints no release', (t) => {
  const root = join(scratch('cad-land-old-', t), 'repo');
  mkdirSync(join(root, '.planning'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', root], { env });
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'x'], { cwd: root, env });
  assert.equal('release' in json(LAND, ['cleanup', '--base', 'main'], root), false);
});

test('the land\'s merge gate reads each task\'s rulings on an agile project, and its tag takes the newest closed release', () => {
  const land = readFileSync(join(HERE, '..', 'skills', 'cad-land', 'SKILL.md'), 'utf8').replace(/\s+/g, ' ');
  assert.ok(land.includes('and on an agile project (`.planning/agile/` there) its one root, each task\'s folder `.planning/agile/tasks/*/`'));
  assert.ok(land.includes('Then name on `unruled` every `REVIEW-risk_surface*.md` nothing ruled - from those roots'));
  assert.ok(land.includes('shipped version - on an agile project the `release.version` the `cleanup` call above printed'));
  assert.ok(land.includes('else the manifest\'s `version`'));
  assert.ok(land.includes('or that call\'s `release.title` on an agile project'));
  const skill = readFileSync(join(HERE, '..', 'skills', 'cad-agile', 'SKILL.md'), 'utf8');
  assert.match(skill, /^ {2}- SlashCommand$/m);
});

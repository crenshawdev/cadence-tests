// Zero-dep tests for git-branch.mjs (the branch-decision seam). Run:
// node --test 'tests/*.test.mjs'. Fixture style mirrors
// git-guard.test.mjs: a temp .planning dir with config/PROJECT/ROADMAP, driven
// through the seam with an explicit --branch so no live git repo is needed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agileDir, releaseFile } from '../cadence-core/bin/lib/agile-paths.mjs';
import { markAgile } from '../cadence-core/bin/lib/project-state.mjs';

const SEAM = join(dirname(fileURLToPath(import.meta.url)), '..', 'cadence-core', 'bin', 'git-branch.mjs');
// Hermetic global config (never read the dev's real ~/.claude one).
const NO_GLOBAL_ROOT = mkdtempSync(join(tmpdir(), 'cad-gb-'));
const NO_GLOBAL = join(NO_GLOBAL_ROOT, 'no-global.json');
after(() => rmSync(NO_GLOBAL_ROOT, { recursive: true, force: true }));

/** A mkdtemp root that goes when test `t` ends. */
function tmp(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Plant a .planning fixture at `dir`, whatever built the directory. */
function plant(dir, gitConfig, version) {
  mkdirSync(join(dir, '.planning'), { recursive: true });
  writeFileSync(join(dir, '.planning', 'config.json'), JSON.stringify({ git: gitConfig }));
  writeFileSync(join(dir, '.planning', 'PROJECT.md'),
    `## Requirements\n### Active\n\n\`${version}\` - the round\n\n### Out of Scope\n`);
  writeFileSync(join(dir, '.planning', 'ROADMAP.md'), `# Roadmap: Cadence ${version}\n`);
  return dir;
}

/** A .planning fixture with the given git config block. */
function fixture(t, gitConfig, version = 'v1.1.0-rc.2') {
  return plant(tmp(t, 'cad-gb-repo-'), gitConfig, version);
}

/**
 * The same fixture, made a REAL git repo carrying `tags`. The published-version
 * guard reads `git tag --list`, so this one clause cannot be proved on the
 * live-git-free fixtures above. Identity and signing are forced off in the env
 * so the empty commit works on any machine, including one with commit.gpgsign
 * set globally.
 */
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'cad', GIT_AUTHOR_EMAIL: 'cad@example.invalid',
  GIT_COMMITTER_NAME: 'cad', GIT_COMMITTER_EMAIL: 'cad@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
};

function taggedFixture(t, gitConfig, version, tags) {
  const dir = fixture(t, gitConfig, version);
  const env = GIT_ENV;
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore', env });
  git('init', '-q');
  git('commit', '--allow-empty', '-q', '-m', 'root');
  for (const tag of tags) git('tag', tag);
  return dir;
}

/** Run `git-branch.mjs decide` against a fixture with an explicit branch. */
function decide(dir, branch) {
  const env = { ...process.env, CADENCE_GLOBAL_CONFIG: NO_GLOBAL };
  try {
    return JSON.parse(execFileSync('node',
      [SEAM, 'decide', '--dir', dir, '--branch', branch], { encoding: 'utf8', env }));
  } catch (e) {
    return JSON.parse(e.stdout);
  }
}

test('milestone + auto on a protected base: create the named integration branch', (t) => {
  const r = decide(fixture(t, { integration_branch: 'milestone', auto_branch: 'auto' }), 'main');
  assert.equal(r.ok, true);
  assert.equal(r.action, 'create');
  assert.equal(r.branch, 'cadence/v1.1.0-rc.2');
  assert.equal(r.mode, 'milestone');
  assert.equal(r.currentBranch, 'main');
});

test('milestone + ask on a protected base: ask, naming the integration branch', (t) => {
  const r = decide(fixture(t, { integration_branch: 'milestone', auto_branch: 'ask' }), 'main');
  assert.equal(r.action, 'ask');
  assert.equal(r.branch, 'cadence/v1.1.0-rc.2');
});

test('milestone + off on a protected base: stay', (t) => {
  const r = decide(fixture(t, { integration_branch: 'milestone', auto_branch: 'off' }), 'main');
  assert.equal(r.action, 'stay');
});

test('milestone already on a work branch: stay (lazy, once per cycle)', (t) => {
  const r = decide(fixture(t, { integration_branch: 'milestone', auto_branch: 'auto' }), 'feat/thing');
  assert.equal(r.action, 'stay');
  assert.equal(r.currentBranch, 'feat/thing');
});

test('trunk on a protected base: stay, no integration branch (branch null)', (t) => {
  const r = decide(fixture(t, { integration_branch: 'trunk' }), 'main');
  assert.equal(r.action, 'stay');
  assert.equal(r.branch, null);
});

test('defaults (no git block set): milestone + ask on a protected base -> ask', (t) => {
  const r = decide(fixture(t, {}), 'main');
  assert.equal(r.mode, 'milestone');
  assert.equal(r.action, 'ask');
  assert.equal(r.branch, 'cadence/v1.1.0-rc.2');
});

test('a STRING protected_branches is honored here too, not dropped (#38, COR-01)', (t) => {
  // This seam's own per-consumer proof of the shared coercion
  // (lib/protected-branches.mjs). Before it, a lone string fell to
  // ['main','master'] HERE while git-guard already honored it: "release" read
  // as an ordinary work branch, so the seam advised `stay` on the very branch
  // the user had protected, and the default list protected `main` nobody named.
  const cfg = { integration_branch: 'milestone', auto_branch: 'ask', protected_branches: 'release' };
  const onProtected = decide(fixture(t, cfg), 'release');
  assert.equal(onProtected.action, 'ask');
  assert.equal(onProtected.branch, 'cadence/v1.1.0-rc.2');
  // and the swapped-in default is gone: main is now an ordinary branch.
  assert.equal(decide(fixture(t, cfg), 'main').action, 'stay');
});

test('published: a milestone the repo has ALREADY TAGGED asks, naming both numbers (AC8)', (t) => {
  // The #87 collision at the seam: `### Active` still names v0.1.0 while the
  // repo carries v0.1.0 and v0.2.0, so `create cadence/v0.1.0` would name a
  // branch after a shipped release. The tag list is what answers - no manifest.
  const dir = taggedFixture(t, { integration_branch: 'milestone', auto_branch: 'auto' },
    'v0.1.0', ['v0.1.0', 'v0.2.0']);
  const r = decide(dir, 'main');
  assert.equal(r.ok, true);
  assert.equal(r.action, 'ask');
  assert.equal(r.branch, null);
  // Both numbers are the milestone version and the TAG SPELLING that carries
  // it, which under membership is the tag it collided with. v0.2.0 is merely
  // the highest tag in the repo, has nothing to do with this refusal, and
  // naming it was the sort-order guard talking about the wrong release.
  assert.match(r.reason, /0\.1\.0/);
  assert.match(r.reason, /v0\.1\.0/, 'the tag spelling, so the user can go look at it');
  assert.doesNotMatch(r.reason, /0\.2\.0/, 'not the highest tag: it did not cause this');
});

test('published: an untagged maintenance milestone below a higher tag still creates (AC8)', (t) => {
  // The live-git half of the sort-order defect: v1.9.1 is published nowhere,
  // and the repo's newest tag is v2.0.0. Sorting refused it as "already
  // published"; membership creates it.
  const dir = taggedFixture(t, { integration_branch: 'milestone', auto_branch: 'auto' },
    'v1.9.1', ['v1.9.0', 'v2.0.0']);
  const r = decide(dir, 'main');
  assert.equal(r.ok, true);
  assert.equal(r.action, 'create');
  assert.equal(r.branch, 'cadence/v1.9.1');
});

test('published: a milestone above every tag still creates - the guard refuses no new cycle', (t) => {
  const dir = taggedFixture(t, { integration_branch: 'milestone', auto_branch: 'auto' },
    'v0.3.0', ['v0.1.0', 'v0.2.0']);
  const r = decide(dir, 'main');
  assert.equal(r.action, 'create');
  assert.equal(r.branch, 'cadence/v0.3.0');
});

test('published: a non-semver tag is skipped, not guessed at', (t) => {
  // `nightly` parses as no version, so it can carry no milestone: membership is
  // what counts, and an out-of-grammar tag matches nothing rather than being
  // ranked or guessed at.
  const dir = taggedFixture(t, { integration_branch: 'milestone', auto_branch: 'auto' },
    'v0.2.0', ['nightly', '2024-06-release', 'v0.2.0']);
  assert.equal(decide(dir, 'main').action, 'ask');
  const clean = taggedFixture(t, { integration_branch: 'milestone', auto_branch: 'auto' },
    'v0.2.0', ['nightly', '2024-06-release']);
  assert.equal(decide(clean, 'main').action, 'create', 'no tag carries it: nothing to refuse');
});

// --- TAG-01: the tags have to belong to THIS project ------------------------
//
// WATCHED FAILING AT 487e150, the branch tip before this fix - the audit-side
// half of the same bound carries the full watch recipe in
// planning.test.mjs's `version_drift` block.

test('published: an enclosing repository\'s tags are not this project\'s (TAG-01)', (t) => {
  // `git -C` discovers the repository UPWARD, so a project that is not itself a
  // repository read the tag list of whatever repository happened to CONTAIN it
  // - a checkout under an umbrella repo, a vendored copy, a monorepo sibling -
  // and was refused an integration branch over a version it never published.
  // The umbrella's v0.1.0 says nothing about the project below it.
  const umbrella = tmp(t, 'cad-gb-umbrella-');
  const git = (...args) => execFileSync('git', ['-C', umbrella, ...args],
    { stdio: 'ignore', env: GIT_ENV });
  git('init', '-q');
  git('commit', '--allow-empty', '-q', '-m', 'root');
  git('tag', 'v0.1.0');

  const sub = plant(join(umbrella, 'project'),
    { integration_branch: 'milestone', auto_branch: 'auto' }, 'v0.1.0');
  const r = decide(sub, 'main');
  assert.equal(r.ok, true);
  assert.equal(r.action, 'create', 'the umbrella published v0.1.0; this project published nothing');
  assert.equal(r.branch, 'cadence/v0.1.0');
});

// --- git.integration_branch_name: the configured name (AC7, D-23, D-24) -----

const THEMED = { integration_branch: 'milestone', auto_branch: 'auto', integration_branch_name: 'seldon/hardin' };

test('branch name: the key set to a themed name creates that branch; unset keeps cadence/<version>', (t) => {
  const themed = decide(fixture(t, THEMED, 'v4.0.0'), 'main');
  assert.equal(themed.action, 'create');
  assert.equal(themed.branch, 'seldon/hardin');
  const { integration_branch_name: _drop, ...unset } = THEMED;
  const plain = decide(fixture(t, unset, 'v4.0.0'), 'main');
  assert.equal(plain.action, 'create');
  assert.equal(plain.branch, 'cadence/v4.0.0');
});

test('branch name: a version already tagged asks under either name, never a create', (t) => {
  const { integration_branch_name: _drop, ...unset } = THEMED;
  for (const cfg of [THEMED, unset]) {
    const r = decide(taggedFixture(t, cfg, 'v4.0.0', ['v4.0.0']), 'main');
    assert.equal(r.action, 'ask', JSON.stringify(cfg));
    assert.equal(r.branch, null);
    assert.match(r.reason, /already-published/);
  }
});

test('branch name: a hand-edited bad value asks, names the key and never creates under it', (t) => {
  for (const bad of ['--x', 'a b', '$(id)', 'a..b', 5]) {
    const r = decide(fixture(t, { ...THEMED, integration_branch_name: bad }, 'v4.0.0'), 'main');
    assert.equal(r.action, 'ask', String(bad));
    assert.equal(r.branch, null, String(bad));
    assert.match(r.reason, /naming-problem.*git\.integration_branch_name/, String(bad));
  }
});

test('branch name: a themed name with no version in the prose still creates under that name', (t) => {
  const dir = fixture(t, THEMED);
  writeFileSync(join(dir, '.planning', 'PROJECT.md'), '### Active\n\nnothing yet\n');
  writeFileSync(join(dir, '.planning', 'ROADMAP.md'), '# Roadmap\n');
  const r = decide(dir, 'main');
  assert.equal(r.action, 'create');
  assert.equal(r.branch, 'seldon/hardin');
});

test('branch name: off a protected base the themed key still stays', (t) => {
  assert.equal(decide(fixture(t, THEMED, 'v4.0.0'), 'seldon/hardin').action, 'stay');
});

// --- the read-only tags arm (REL-01) ----------------------------------------
//
// `workflows/milestone.md` step 2 asks "has this project ever tagged" to tell a
// release close from a non-release one, and it used to ask it with a bare `git
// tag`, which discovers the repository UPWARD. This arm is that question
// bounded to the project the caller names, which is why the same TAG-01 shape
// the `decide` test above builds is what proves it.

/** Run `git-branch.mjs tags` against a directory. */
function tags(dir) {
  const env = { ...process.env, CADENCE_GLOBAL_CONFIG: NO_GLOBAL };
  return JSON.parse(execFileSync('node', [SEAM, 'tags', '--dir', dir],
    { encoding: 'utf8', env }));
}

/** A marked project whose release.md holds `release`, or which has no release at all. */
function agileFixture(t, gitConfig, release = '# Release: Tool Shed\n\n## Goal\n\nLend tools.\n\n## Epics\n\n- E-01: Catalog\n') {
  const dir = tmp(t, 'cad-gb-agile-');
  const planning = join(dir, '.planning');
  mkdirSync(planning);
  writeFileSync(join(planning, 'config.json'), JSON.stringify({ git: gitConfig }));
  assert.equal(markAgile(planning).ok, true);
  if (release !== null) {
    mkdirSync(agileDir(planning));
    writeFileSync(releaseFile(agileDir(planning)), release);
  }
  return dir;
}

test('agile: on a protected base the release names the branch, and every setting acts on it as on the old path', (t) => {
  for (const [gitConfig, action, branch] of [
    [{}, 'ask', 'cadence/tool-shed'],
    [{ auto_branch: 'auto' }, 'create', 'cadence/tool-shed'],
    [{ auto_branch: 'off' }, 'stay', 'cadence/tool-shed'],
    [{ integration_branch: 'trunk' }, 'stay', null],
    [{ integration_branch_name: 'seldon/hardin' }, 'ask', 'seldon/hardin'],
    [{ auto_branch: 'auto', integration_branch_name: 'seldon/hardin' }, 'create', 'seldon/hardin'],
    [{ auto_branch: 'auto', integration_branch_name: '-D' }, 'ask', null],
  ]) {
    const r = decide(agileFixture(t, gitConfig), 'main');
    assert.deepEqual([r.ok, r.action, r.branch], [true, action, branch], JSON.stringify([gitConfig, r]));
  }
  const off = decide(agileFixture(t, { auto_branch: 'auto' }), 'feat/thing');
  assert.deepEqual([off.action, off.branch], ['stay', 'feat/thing']);
});

test('agile: on the branch the start was told to commit on anyway nothing is asked, and every other answer keeps its shape', (t) => {
  const kept = '# Release: Tool Shed\n\n## Goal\n\nLend tools.\n\n## Epics\n\n- E-01: Catalog\n\n## Branch\n\n- Commit here anyway: main\n';
  for (const gitConfig of [{}, { auto_branch: 'auto' }, { integration_branch: 'trunk' }, { integration_branch_name: 'seldon/hardin' }]) {
    assert.deepEqual(decide(agileFixture(t, gitConfig, kept), 'main'), { ok: true, action: 'stay', branch: 'main', mode: gitConfig.integration_branch ?? 'milestone',
      currentBranch: 'main', reason: 'commit-here: the start was told to commit this release on main', kept: true, warnings: [] }, JSON.stringify(gitConfig));
  }
  const other = decide(agileFixture(t, {}, kept), 'master');
  assert.deepEqual([other.action, other.branch, 'kept' in other], ['ask', 'cadence/tool-shed', false]);
  const plain = decide(agileFixture(t, {}), 'main');
  assert.deepEqual([plain.action, plain.branch, 'kept' in plain], ['ask', 'cadence/tool-shed', false]);
  const edited = decide(agileFixture(t, {}, kept.replace('anyway: main', 'anyway: main\n- Commit here anyway: dev')), 'main');
  assert.deepEqual([edited.action, 'kept' in edited], ['ask', false]);
});

test('agile: through a linked .planning the release still names the branch', (t) => {
  const real = agileFixture(t, {});
  const dir = tmp(t, 'cad-gb-link-');
  symlinkSync(join(real, '.planning'), join(dir, '.planning'));
  assert.equal(decide(dir, 'main').branch, 'cadence/tool-shed');
});

test('agile: a release that gives no name asks without one, whatever old-path files are left beside it', (t) => {
  for (const [name, release, gitConfig, branch] of [
    ['a start killed after its marker', null, {}, null],
    ['a release file that does not read back', '# Release: Tool Shed\n\n## Epics\n\nE-01 Catalog\n', {}, null],
    ['a title with no letter or digit', '# Release: --\n\n## Epics\n\n- E-01: Catalog\n', {}, null],
    ['no release, under a configured name', null, { integration_branch_name: 'seldon/hardin' }, 'seldon/hardin'],
  ]) {
    const dir = agileFixture(t, { auto_branch: 'auto', ...gitConfig }, release);
    writeFileSync(join(dir, '.planning', 'PROJECT.md'), '### Active\n\n`v1.0.0` - the round\n');
    writeFileSync(join(dir, '.planning', 'ROADMAP.md'), '# Roadmap: v1.0.0\n');
    const r = decide(dir, 'main');
    assert.deepEqual([r.action, r.branch], [branch ? 'create' : 'ask', branch], name);
    if (branch) continue;
    assert.match(r.reason, /^naming-problem: the release .*git\.integration_branch_name.*stay on the base \/ abort$/, name);
    assert.doesNotMatch(r.reason, /PROJECT|ROADMAP/, name);
  }
});

test('agile: a tag for the version a leftover PROJECT.md names says nothing about the release', (t) => {
  const dir = agileFixture(t, { auto_branch: 'auto' });
  writeFileSync(join(dir, '.planning', 'PROJECT.md'), '### Active\n\n`v1.0.0` - the round\n');
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore', env: GIT_ENV });
  git('init', '-q');
  git('commit', '--allow-empty', '-q', '-m', 'root');
  git('tag', 'v1.0.0');
  const r = decide(dir, 'main');
  assert.deepEqual([r.action, r.branch], ['create', 'cadence/tool-shed']);
});

test('tags: the repository at --dir answers with its own tag list', (t) => {
  const dir = taggedFixture(t, {}, 'v9.9.0', ['v9.9.0']);
  const r = tags(dir);
  assert.equal(r.ok, true);
  assert.deepEqual(r.tags, ['v9.9.0']);
});

test('tags: a non-repository project inside a tagged repository has published nothing (TAG-01)', (t) => {
  // The defect this arm exists to stop carrying into the release-mode
  // decision: `sub/` is not a repository, so a bare probe there reads the
  // umbrella's v9.9.0 and the close reads as a RELEASE close for a project
  // that has never published anything.
  const umbrella = taggedFixture(t, {}, 'v9.9.0', ['v9.9.0']);
  const sub = plant(join(umbrella, 'project'), {}, 'v9.9.0');
  const r = tags(sub);
  assert.equal(r.ok, true, 'a non-repository is an answer, never a failure');
  assert.deepEqual(r.tags, [], "the umbrella's release is not this project's");
});

test('tags: a directory that is no repository at all reads as no tags, not an error', (t) => {
  const r = tags(tmp(t, 'cad-gb-bare-'));
  assert.equal(r.ok, true);
  assert.deepEqual(r.tags, []);
});

test('an unknown subcommand names BOTH arms, so the new one is reachable from the usage line', () => {
  // `ok:false` mirrors into exit 1 (lib/seam-io.mjs), so the usage line comes
  // back on the thrown error's stdout exactly as `decide` above reads it.
  let out;
  try { out = execFileSync('node', [SEAM, 'nope'], { encoding: 'utf8' }); }
  catch (e) { out = e.stdout; }
  const r = JSON.parse(out);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'usage');
  assert.match(r.detail, /decide/);
  assert.match(r.detail, /tags/);
});

test('warnings[] rides the envelope, and a torn layer puts the parse failure on it', (t) => {
  // Pins the EMISSION, not just the binding: every value this seam decides with
  // - mode, auto_branch, protected_branches - comes off that one merge, so a
  // torn layer means the advice was computed from DEFAULTS. Stripping
  // `, warnings })` off the emit fails here and nowhere else.
  const clean = decide(fixture(t, { integration_branch: 'milestone', auto_branch: 'auto' }), 'main');
  assert.deepEqual(clean.warnings, [], 'present as an empty array, not omitted');

  const dir = fixture(t, { integration_branch: 'milestone', auto_branch: 'auto' });
  const torn = join(tmp(t, 'cad-gb-torn-'), 'g.json');
  writeFileSync(torn, '{"git":{"auto_branch":"off"');
  const r = JSON.parse(execFileSync('node', [SEAM, 'decide', '--dir', dir, '--branch', 'main'],
    { encoding: 'utf8', env: { ...process.env, CADENCE_GLOBAL_CONFIG: torn } }));
  assert.equal(r.ok, true, 'advisory seam: a torn layer never blocks the advice');
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /failed to parse/);
});

// --- --dir refuses rather than answering about the process cwd (D-01) --------

/** Run the seam raw, keeping the JSON line AND the exit status: a refusal's
 * whole contract is ok:false mirrored into exit 1 (lib/seam-io.mjs). */
function seamStatus(args) {
  const env = { ...process.env, CADENCE_GLOBAL_CONFIG: NO_GLOBAL };
  const r = spawnSync('node', [SEAM, ...args], { encoding: 'utf8', env });
  return { json: JSON.parse(r.stdout), status: r.status };
}

// This seam is ADVISORY - it mutates nothing - and it is in scope on purpose.
// Measured 2026-08-18 before the fix, `tags --dir ''` printed THIS repository's
// 33 tags, so a caller asking about another tree got a confident answer about
// the one the process happened to stand in. An ABSENT --dir still means the
// cwd; the empty, valueless and flag-shaped spellings refuse.
for (const [sub, rest] of [['decide', ['--branch', 'main']], ['tags', []]]) {
  for (const [label, dirArgs] of [['an EMPTY', ['--dir', '']], ['a VALUELESS', ['--dir']]]) {
    test(`${sub}: ${label} --dir refuses by name, exit 1, no tree read`, () => {
      const { json, status } = seamStatus([sub, ...dirArgs, ...rest]);
      assert.equal(json.ok, false);
      // The e.seam catch arm, not the generic one: the thrown refusal object
      // carries no `message`, so without it this reads internal/"[object Object]".
      assert.equal(json.reason, 'missing-flag-value', JSON.stringify(json));
      assert.equal(json.detail, '--dir');
      assert.equal(status, 1);
      assert.equal(json.tags, undefined, 'no tag list rides a refusal');
    });
  }
}

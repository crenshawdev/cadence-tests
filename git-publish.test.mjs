// Zero-dep tests for git-publish.mjs (the ONE publishing seam). Run:
// node --test 'tests/*.test.mjs'. Hermetic: a local bare origin, no
// network, and GIT_CONFIG_GLOBAL/SYSTEM=/dev/null so the dev's git config never
// leaks into the fixtures (same discipline as git-guard.test.mjs).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// The two-layer git fixture, imported rather than copied (D-19). That file's
// own arms are bound to a no-op unless it is the entry file, so importing it
// registers nothing here.
import { gitLayers } from './config-seams.test.mjs';
// The PATH-injected forge-CLI stub writer and its $CAD_SPAWN_MARKER convention,
// imported for the same reason and under the same no-op binding: every stub
// appends its own name to the marker file, which is what turns "no forge CLI
// ran" into an assertion about the filesystem.
import { stub } from './issue-check.test.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'cadence-core', 'bin');
const SEAM = join(dirname(fileURLToPath(import.meta.url)), '..', 'cadence-core', 'bin', 'git-publish.mjs');
const NO_GLOBAL_ROOT = mkdtempSync(join(tmpdir(), 'cad-pub-'));
const NO_GLOBAL = join(NO_GLOBAL_ROOT, 'no-global.json');
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
// The user-global half of the opt-in (D-02). Every arm that expects a push or
// `repo-authorized`, and every refusal arm that has to get PAST gate 1 to reach
// its own gate, passes it beside the repo's `auto_close: true`.
const GLOBAL_ON_ROOT = mkdtempSync(join(tmpdir(), 'cad-pub-on-'));
const GLOBAL_ON_FILE = join(GLOBAL_ON_ROOT, 'global.json');
writeFileSync(GLOBAL_ON_FILE, '{"git":{"auto_close":true}}');
after(() => {
  rmSync(NO_GLOBAL_ROOT, { recursive: true, force: true });
  rmSync(GLOBAL_ON_ROOT, { recursive: true, force: true });
});

/** A mkdtemp root that goes when test `t` ends. */
function tmp(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Run a git command against a fixture dir, hermetically. */
function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: GIT_ENV, ...opts });
}

/** Run the seam; return the parsed JSON line. `globalCfg` sets CADENCE_GLOBAL_CONFIG.
 * The seam mirrors ok into the exit code (ok:false -> exit 1, lib/seam-io.mjs),
 * so a refuse makes execFileSync throw with the JSON still on e.stdout. */
function seam(args, globalCfg = NO_GLOBAL, extraEnv = {}) {
  const opts = { encoding: 'utf8', env: { ...GIT_ENV, CADENCE_GLOBAL_CONFIG: globalCfg, ...extraEnv } };
  let out;
  try { out = execFileSync('node', [SEAM, ...args], opts); }
  catch (e) { out = e.stdout; }
  return JSON.parse(String(out).trim());
}

/** True iff `ref` exists in the bare repo `bare`. */
function refExists(bare, ref) {
  try { git(['-C', bare, 'rev-parse', '--verify', ref]); return true; }
  catch { return false; }
}

/**
 * A work repo with an initial commit. Options:
 *   branch   - branch to check out (default 'cadence/v1.1.0-rc.2'); null = detach.
 *   origin   - add a bare origin remote (default true); returns { dir, bare }.
 *   config   - repo .planning/config.json contents (default {git:{auto_close:true}}).
 */
function repo(t, { branch = 'cadence/v1.1.0-rc.2', origin = true, config = { git: { auto_close: true } } } = {}) {
  const dir = tmp(t, 'cad-pub-repo-');
  git(['-C', dir, 'init', '-q', '-b', 'main']);
  writeFileSync(join(dir, 'f.txt'), 'x');
  git(['-C', dir, 'add', '.']);
  git(['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init']);
  let bare = null;
  if (origin) {
    bare = tmp(t, 'cad-pub-bare-');
    git(['-C', bare, 'init', '-q', '--bare']);
    git(['-C', dir, 'remote', 'add', 'origin', bare]);
  }
  if (branch === null) {
    git(['-C', dir, 'checkout', '-q', '--detach']);
  } else if (branch !== 'main') {
    git(['-C', dir, 'checkout', '-q', '-b', branch]);
  }
  mkdirSync(join(dir, '.planning'), { recursive: true });
  if (config) writeFileSync(join(dir, '.planning', 'config.json'), JSON.stringify(config));
  return { dir, bare };
}

const INT_REF = 'refs/heads/cadence/v1.1.0-rc.2';

// --- the publish path -------------------------------------------------------

test('publish: auto_close true in BOTH layers on a non-protected branch pushes exactly that ref', (t) => {
  const { dir, bare } = repo(t);
  const d = seam(['publish', '--dir', dir], GLOBAL_ON_FILE);
  assert.equal(d.ok, true);
  assert.equal(d.action, 'published');
  assert.equal(d.branch, 'cadence/v1.1.0-rc.2');
  assert.equal(d.remote, 'origin');
  assert.equal(refExists(bare, INT_REF), true, 'the integration ref landed in the bare origin');
  // Nothing else moved: the bare has only the one branch ref.
  const heads = git(['-C', bare, 'for-each-ref', '--format=%(refname)', 'refs/heads/']).trim();
  assert.equal(heads, INT_REF);
});

// --- refuse paths: each pushes nothing --------------------------------------

test('refuse: auto_close false -> auto-close-off, bare gains no branch', (t) => {
  const { dir, bare } = repo(t, { config: { git: { auto_close: false } } });
  const d = seam(['publish', '--dir', dir]);
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'auto-close-off');
  assert.equal(refExists(bare, INT_REF), false);
});

test('refuse: HEAD on a protected branch -> protected-branch, no push', (t) => {
  const { dir, bare } = repo(t, { branch: 'main' });
  const d = seam(['publish', '--dir', dir], GLOBAL_ON_FILE);
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'protected-branch');
  assert.equal(refExists(bare, 'refs/heads/main'), false);
});

test('refuse: a STRING protected_branches protects that branch too (#38, COR-01)', (t) => {
  // The seam's own per-consumer proof of the shared coercion
  // (lib/protected-branches.mjs): before it, this file had no string-form arm
  // at all. On the array-only code `"release"` resolved to ['main','master'],
  // so the ONE mutating seam pushed off a branch the user had named.
  const { dir, bare } = repo(t, { branch: 'release', config: { git: { auto_close: true, protected_branches: 'release' } } });
  const d = seam(['publish', '--dir', dir], GLOBAL_ON_FILE);
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'protected-branch');
  assert.equal(refExists(bare, 'refs/heads/release'), false, 'nothing was pushed');
});

test('refuse: no origin remote configured -> remote-not-configured', (t) => {
  const { dir } = repo(t, { origin: false });
  const d = seam(['publish', '--dir', dir], GLOBAL_ON_FILE);
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'remote-not-configured');
});

test('refuse: detached HEAD -> no-branch, no push', (t) => {
  const { dir, bare } = repo(t, { branch: null });
  const d = seam(['publish', '--dir', dir], GLOBAL_ON_FILE);
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'no-branch');
  assert.equal(refExists(bare, INT_REF), false);
});

test('refuse: auto_close ONLY in the global layer (repo omits) -> auto-close-off (D-08)', (t) => {
  // Repo config has no auto_close; a global auto_close must never enable a
  // publish in an unrelated project. The detail names the repo's own file.
  const { dir, bare } = repo(t, { config: { git: {} } });
  const d = seam(['publish', '--dir', dir], GLOBAL_ON_FILE);
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'auto-close-off');
  assert.match(d.detail, /this repository's \.planning\/config\.json does not/);
  assert.equal(refExists(bare, INT_REF), false);
});

test('refuse: auto_close ONLY in the repo layer -> auto-close-off, detail names the user-global file (D-02)', (t) => {
  // The cloned-repository case: a committed config cannot turn on an
  // unattended push on a machine whose user never opted in.
  const { dir, bare } = repo(t);
  const d = seam(['publish', '--dir', dir]);
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'auto-close-off');
  assert.match(d.detail, /~\/\.claude\/cadence\/config\.json/);
  assert.match(d.detail, /does not: a committed repository setting cannot authorize/);
  assert.equal(refExists(bare, INT_REF), false, 'the bare origin gained no branch');
});

test('auto-close-off hint: one remedy for every off-state, naming no config.mjs command', (t) => {
  const repoOnly = seam(['publish', '--dir', repo(t).dir]);
  const globalOnly = seam(['publish', '--dir', repo(t, { config: { git: {} } }).dir], GLOBAL_ON_FILE);
  for (const d of [repoOnly, globalOnly]) {
    assert.equal(d.reason, 'auto-close-off');
    assert.match(d.hint, /BOTH/);
    assert.doesNotMatch(d.hint, /config\.mjs/);
    assert.doesNotMatch(d.hint, /does not speak for it/);
  }
  assert.notEqual(repoOnly.detail, globalOnly.detail, 'the detail is what names the file');
});

test('usage: an unknown subcommand -> ok:false reason usage', () => {
  const d = seam(['frobnicate']);
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'usage');
});

// --- the reap path ----------------------------------------------------------

const REAP_REF = 'refs/heads/cadence/v2.2.0';

/** Run the seam and return the parsed JSON line AND the exit status, so ok/exit
 * parity is asserted rather than assumed (an `already-absent` skip is ok:true
 * and must therefore exit 0, or an autonomous close reads it as a failure). */
function seamStatus(args, globalCfg = NO_GLOBAL) {
  const opts = { encoding: 'utf8', env: { ...GIT_ENV, CADENCE_GLOBAL_CONFIG: globalCfg } };
  try { return { d: JSON.parse(execFileSync('node', [SEAM, ...args], opts).trim()), status: 0 }; }
  catch (e) { return { d: JSON.parse(String(e.stdout).trim()), status: e.status }; }
}

test('reap: a merged integration branch is actually deleted', (t) => {
  const { dir } = repo(t, { branch: 'main' });
  git(['-C', dir, 'branch', 'cadence/v2.2.0']);
  assert.equal(refExists(dir, REAP_REF), true);
  const { d, status } = seamStatus(['reap', '--dir', dir, '--branch', 'cadence/v2.2.0']);
  assert.equal(d.ok, true);
  assert.equal(d.action, 'reaped');
  assert.equal(d.branch, 'cadence/v2.2.0');
  assert.equal(status, 0);
  assert.equal(refExists(dir, REAP_REF), false, 'the local branch is gone');
});

test('reap: an UNMERGED branch is deleted too - land-cleanup owns the merged verdict', (t) => {
  // Deliberate: the auto_close arm's merge lands on the PLATFORM, so a local
  // merged check would refuse exactly the case the seam exists for. Pinned so
  // the omission reads as a decision rather than a missing gate.
  const { dir } = repo(t, { branch: 'main' });
  git(['-C', dir, 'checkout', '-q', '-b', 'cadence/v2.2.0']);
  writeFileSync(join(dir, 'g.txt'), 'y');
  git(['-C', dir, 'add', '.']);
  git(['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'ahead']);
  git(['-C', dir, 'checkout', '-q', 'main']);
  const d = seam(['reap', '--dir', dir, '--branch', 'cadence/v2.2.0']);
  assert.equal(d.ok, true);
  assert.equal(d.action, 'reaped');
  assert.equal(refExists(dir, REAP_REF), false);
});

test('reap: an already-absent branch SKIPS with ok:true and exit 0 (idempotent close)', (t) => {
  const { dir } = repo(t, { branch: 'main' });
  const { d, status } = seamStatus(['reap', '--dir', dir, '--branch', 'cadence/v2.2.0']);
  assert.equal(d.ok, true);
  assert.equal(d.action, 'already-absent');
  assert.equal(d.branch, 'cadence/v2.2.0');
  assert.equal(status, 0, 'ok:true must exit 0 - the platform may already have deleted it');
});

test('reap refuse: a protected branch, and it is still there afterwards', (t) => {
  const { dir } = repo(t, { branch: 'cadence/v2.2.0' });
  const { d, status } = seamStatus(['reap', '--dir', dir, '--branch', 'main']);
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'protected-branch');
  assert.equal(status, 1);
  assert.equal(refExists(dir, 'refs/heads/main'), true, 'main survives');
});

test('reap refuse: the CHECKED-OUT branch, named rather than left to a git error', (t) => {
  const { dir } = repo(t, { branch: 'cadence/v2.2.0' });
  const d = seam(['reap', '--dir', dir, '--branch', 'cadence/v2.2.0']);
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'current-branch');
  assert.equal(refExists(dir, REAP_REF), true);
});

test('reap refuse: an option-shaped branch name never reaches git', (t) => {
  // `--branch` declares the `fallback` disposition (D-12), so a value that is
  // itself a flag reads as ABSENT and the refusal is `no-branch` - one layer
  // EARLIER than it used to be. The old answer was `bad-branch`, because the
  // permissive reader handed `'--force'` on to decideReap's SAFE_BRANCH arm.
  // Nothing about the safety property moved: ok:false, exit 1, no argv built,
  // and the branch still there. Only the reason names the earlier stop, and the
  // SAFE_BRANCH rule itself keeps its own test at the core -
  // publish-decision.test.mjs pins `'--force'` (and eight more) at `bad-branch`
  // against decideReap directly. What changed is the seam-level ROUTE into the
  // decision, not the decision.
  const { dir } = repo(t, { branch: 'main' });
  git(['-C', dir, 'branch', 'cadence/v2.2.0']);
  const { d, status } = seamStatus(['reap', '--dir', dir, '--branch', '--force']);
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'no-branch');
  assert.equal(status, 1);
  assert.equal(refExists(dir, REAP_REF), true, 'nothing else was deleted');
});

test('reap refuse: no --branch at all -> no-branch, and no git ran', (t) => {
  const { dir } = repo(t, { branch: 'main' });
  git(['-C', dir, 'branch', 'cadence/v2.2.0']);
  const d = seam(['reap', '--dir', dir]);
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'no-branch');
  assert.equal(refExists(dir, REAP_REF), true);
});

test('reap needs no auto_close: a close-off repo still reaps its local branch', (t) => {
  // Deleting a local branch publishes nothing, so unlike publish it carries no
  // authorization gate.
  const { dir } = repo(t, { branch: 'main', config: { git: { auto_close: false } } });
  git(['-C', dir, 'branch', 'cadence/v2.2.0']);
  const d = seam(['reap', '--dir', dir, '--branch', 'cadence/v2.2.0']);
  assert.equal(d.ok, true);
  assert.equal(d.action, 'reaped');
  assert.equal(refExists(dir, REAP_REF), false);
});

test('usage: the detail names all three subcommands', () => {
  const d = seam(['frobnicate']);
  assert.equal(d.ok, false);
  assert.match(d.detail, /publish/);
  assert.match(d.detail, /reap/);
  assert.match(d.detail, /authorized/);
});

// --- the verification publish: local Git config is the only authorization (D-02) ---

/** Set cadence.publishForVerification=true in the work repo's own .git/config. */
const authorizeLocally = (dir) => git(['-C', dir, 'config', '--local', 'cadence.publishForVerification', 'true']);

test('verify-publish: a local true pushes a non-protected branch, whatever git.auto_close says', (t) => {
  const { dir, bare } = repo(t, { config: { git: { auto_close: false } } });
  authorizeLocally(dir);
  const d = seam(['verify-publish', '--dir', dir]);
  assert.equal(d.ok, true);
  assert.equal(d.action, 'published');
  assert.equal(refExists(bare, INT_REF), true);
});

test('verify-publish: unset pushes nothing even with git.auto_close true in both layers', (t) => {
  const { dir, bare } = repo(t);
  const d = seam(['verify-publish', '--dir', dir], GLOBAL_ON_FILE);
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'publish-not-authorized');
  assert.match(d.hint, /\/cad-config --testing/);
  assert.match(d.hint, /\/cad-land/);
  assert.equal(refExists(bare, INT_REF), false);
});

test('verify-publish: a protected branch is refused even when authorized', (t) => {
  const { dir, bare } = repo(t, { branch: 'main' });
  authorizeLocally(dir);
  const d = seam(['verify-publish', '--dir', dir]);
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'protected-branch');
  assert.equal(refExists(bare, 'refs/heads/main'), false);
});

test('verify-publish: GIT_DIR naming a repository that holds true authorizes nothing here', (t) => {
  const unset = repo(t);
  const holder = repo(t);
  authorizeLocally(holder.dir);
  const d = seam(['verify-publish', '--dir', unset.dir], NO_GLOBAL, { GIT_DIR: join(holder.dir, '.git') });
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'publish-not-authorized');
  assert.equal(refExists(unset.bare, INT_REF), false);
  assert.equal(refExists(holder.bare, INT_REF), false);
});

// --- the two halves of the opt-in, and the sentence that names the missing one (D-02)

/** A user-global layer file holding `obj`. */
function globalJson(t, obj) { return globalText(t, JSON.stringify(obj)); }

/** The config pair this phase exists for: `git.auto_close` true in the user's
 * own home directory, and this repository never setting it. */
const GLOBAL_ON = { git: { auto_close: true } };

test('publish refuse: off-everywhere and requested-globally read DIFFERENTLY', (t) => {
  // Same `reason` token on both - it is asserted by equality across this file
  // and config-seams.test.mjs - so the state the user has to act on can only
  // reach them through the detail.
  const off = seam(['publish', '--dir', repo(t, { config: { git: { auto_close: false } } }).dir]);
  const requested = seam(['publish', '--dir', repo(t, { config: { git: {} } }).dir], globalJson(t, GLOBAL_ON));
  assert.equal(off.reason, 'auto-close-off');
  assert.equal(requested.reason, 'auto-close-off');
  assert.match(requested.detail, /user-global setting cannot authorize/);
  assert.match(requested.detail, /\.planning\/config\.json/);
  assert.notEqual(off.detail, requested.detail);
  assert.ok(off.detail, 'the off-everywhere arm says which authorization was missing too');
});

test('authorized: a user-global true is refused - the repository never opted in', (t) => {
  // The GitLab arm's gate. On GitHub/Forgejo the chain dies at `publish`
  // because the branch has to reach the remote through it; `glab mr create`
  // pushes the source branch itself, so this is the only thing between a
  // user-global setting and an unattended merge.
  const { dir, bare } = repo(t, { config: { git: {} } });
  const { d, status } = seamStatus(['authorized', '--dir', dir], globalJson(t, GLOBAL_ON));
  assert.equal(status, 1);
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'auto-close-off');
  assert.equal(d.requested, true, 'the merged value is reported, and did not authorize');
  assert.match(d.detail, /user-global setting cannot authorize/);
  assert.match(d.detail, /\.planning\/config\.json/);
  assert.equal(refExists(bare, INT_REF), false, 'the read-only arm published nothing');
});

test('authorized: both layers opting in answers ok:true, and needs no git', (t) => {
  const { d, status } = seamStatus(['authorized', '--dir', repo(t).dir], GLOBAL_ON_FILE);
  assert.equal(status, 0);
  assert.equal(d.ok, true);
  assert.equal(d.action, 'repo-authorized');
  assert.equal(d.detail, undefined, 'nothing was missing, so nothing is said');

  // A directory that is not a git repository at all still gets an answer: this
  // arm reads config layers and runs no git (the marker-file proof that it
  // spawns nothing lives beside the forge-CLI stubs).
  const plain = tmp(t, 'cad-pub-plain-');
  mkdirSync(join(plain, '.planning'));
  writeFileSync(join(plain, '.planning', 'config.json'), JSON.stringify(GLOBAL_ON));
  const bare = seamStatus(['authorized', '--dir', plain], GLOBAL_ON_FILE);
  assert.equal(bare.status, 0);
  assert.equal(bare.d.ok, true);
});

test('authorized: the GitLab arm refuses with NO forge CLI spawned at all', (t) => {
  // AC3. On GitLab `glab mr create` publishes the source branch itself, so the
  // publish seam is never called and this answer is the only thing between a
  // user-global setting and an unattended merge. Two things are proved here:
  // the refusal, and that reaching it needed no forge CLI - a seam that shelled
  // out to `glab` would put a network CLI's failure modes on the same envelope
  // as a merge authorization. `glab` is not installed on this machine, so a
  // stub on PATH is the only way the arm is provable either way.
  const stubDir = tmp(t, 'cad-pub-stub-');
  for (const name of ['gh', 'glab', 'tea']) stub(stubDir, name, { body: '[]' });
  const marker = join(tmp(t, 'cad-pub-mark-'), 'spawned.txt');
  const { dir } = repo(t, { config: { git: {} } });

  const env = { ...GIT_ENV, CADENCE_GLOBAL_CONFIG: globalJson(t, GLOBAL_ON),
    PATH: `${stubDir}:${process.env.PATH}`, CAD_SPAWN_MARKER: marker };
  let out; let status = 0;
  try { out = execFileSync('node', [SEAM, 'authorized', '--dir', dir], { encoding: 'utf8', env }); }
  catch (e) { out = e.stdout; status = e.status; }
  const d = JSON.parse(String(out).trim());

  assert.equal(status, 1);
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'auto-close-off');
  assert.match(d.detail, /user-global setting cannot authorize/);
  assert.equal(existsSync(marker), false, 'a forge CLI was spawned to answer an authorization question');

  // The marker is not vacuously absent: running one of the stubs writes it.
  execFileSync(join(stubDir, 'glab'), ['mr', 'create'], { encoding: 'utf8', env });
  assert.equal(readFileSync(marker, 'utf8').trim(), 'glab');
});

test('authorized: off in BOTH layers refuses with the other sentence', (t) => {
  const d = seam(['authorized', '--dir', repo(t, { config: { git: { auto_close: false } } }).dir]);
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'auto-close-off');
  assert.equal(d.requested, false);
  assert.match(d.detail, /set in neither layer/);
});

test('authorized: repo true with a TORN user-global file names that file as unreadable', (t) => {
  // Fails closed - the torn file cannot prove the user's opt-in - but the
  // detail names the real cause rather than calling it the missing half.
  const torn = globalText(t, TORN_GLOBAL);
  const { d, status } = seamStatus(['authorized', '--dir', repo(t).dir], torn);
  assert.equal(status, 1);
  assert.equal(d.reason, 'auto-close-off');
  assert.ok(d.detail.includes(torn), d.detail);
  assert.match(d.detail, /could not be read/);
  assert.doesNotMatch(d.detail, /does not:|Set "git"/);
});

// --- the torn-layer mutation gate -------------------------------------------

/** A user-global layer file holding raw TEXT - so a truncated JSON body can be
 * written verbatim and the merge reports the parse failure the gate keys on. */
function globalText(t, text) {
  const file = join(tmp(t, 'cad-pub-glob-'), 'g.json');
  writeFileSync(file, text);
  return file;
}

// A global layer that WOULD have protected the branch, truncated mid-array.
const TORN_GLOBAL = '{"git":{"protected_branches":["cadence/v1.1.0-rc.2","cadence/v2.2.0"]';

test('publish refuse: a TORN layer that could carry protected_branches pushes NOTHING', (t) => {
  // The list `decidePublish` refused with fell back to ["main","master"] because
  // the layer holding the user's did not parse, so the protected-branch gate ran
  // on the wrong list. No push while that is unprovable.
  const { dir, bare } = repo(t);
  const { d, status } = seamStatus(['publish', '--dir', dir], globalText(t, TORN_GLOBAL));
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'config-parse-failed');
  assert.match(d.detail, /failed to parse/);
  assert.equal(d.warnings.length, 1);
  assert.equal(status, 1);
  assert.equal(refExists(bare, INT_REF), false, 'the ref never reached the remote');
});

test('reap refuse: a TORN layer leaves the branch it would have protected in place', (t) => {
  // The reproduction: with the layer intact this same command answers
  // {"ok":false,"reason":"protected-branch"}; torn, it used to answer
  // {"ok":true,"action":"reaped"} and the branch was already gone.
  const { dir } = repo(t, { branch: 'main' });
  git(['-C', dir, 'branch', 'cadence/v2.2.0']);
  const { d, status } = seamStatus(['reap', '--dir', dir, '--branch', 'cadence/v2.2.0'],
    globalText(t, TORN_GLOBAL));
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'config-parse-failed');
  assert.match(d.detail, /failed to parse/);
  assert.equal(status, 1);
  assert.equal(refExists(dir, REAP_REF), true, 'the branch survives the torn layer');
});

test('warnings[] rides the git-publish envelope on the acting AND the skip arms', (t) => {
  // Pins the emission itself: stripping `, warnings })` off the emits leaves the
  // gate above passing on its refusals but fails here.
  const { dir } = repo(t, { branch: 'main' });
  git(['-C', dir, 'branch', 'cadence/v2.2.0']);
  const clean = seam(['reap', '--dir', dir, '--branch', 'cadence/v2.2.0']);
  assert.equal(clean.action, 'reaped');
  assert.deepEqual(clean.warnings, [], 'present as an empty array, not omitted');
  // The idempotent skip stays ok:true under a torn layer - it mutates nothing -
  // and carries the diagnostic rather than swallowing it.
  const skipped = seamStatus(['reap', '--dir', dir, '--branch', 'cadence/v2.2.0'],
    globalText(t, TORN_GLOBAL));
  assert.equal(skipped.d.ok, true);
  assert.equal(skipped.d.action, 'already-absent');
  assert.equal(skipped.status, 0);
  assert.match(skipped.d.warnings[0], /failed to parse/);
});

// --- no failure detail carries a credential (EXP-01, AC8) --------------------
//
// The fixture is `gitLayers` imported from config-seams.test.mjs (D-19) rather
// than this file's own `repo()`: the hostile-repo scaffolding phase 1 built is
// what these arms reuse, and a copy of it here is the drift the shared fixture
// exists to prevent.
//
// Both arms point `origin` at a remote whose URL carries userinfo on a
// transport git does NOT anonymize, measured 2026-08-13 on git 2.55.0 (D-15).
// The `https://x-access-token:TOKEN@host` form the requirement cites is
// anonymized by git before the error is emitted, so an arm built on it is green
// against unpatched code - which is the defect, not the test.

/** The credential planted in the fixture remotes below. */
const LEAK_USER = 'cad';
const LEAK_SECRET = 's3cr3t-tok';

/**
 * A publish fixture on a non-protected branch whose `origin` is `url`.
 * Both layers opt in (D-02) and neither carries anything else, so the seam's
 * merge stays clean and the only thing under test is what the push failure
 * carries.
 * @param {string} url
 */
function leakyOrigin(t, url) {
  const fx = gitLayers({ branch: 'cadence/v9.9.9', repo: { git: { auto_close: true } },
    global: { git: { auto_close: true } } }, t);
  git(['-C', fx.root, 'remote', 'add', 'origin', url]);
  return fx;
}

/** @param {{ok:boolean, reason?:string, detail?:string}} d @param {string} label */
function assertNoCredential(d, label) {
  assert.equal(d.ok, false, `${label}: ${JSON.stringify(d)}`);
  assert.equal(d.reason, 'push-failed', `${label}: ${JSON.stringify(d)}`);
  assert.ok(d.detail && d.detail.length > 0, `${label}: empty detail`);
  assert.equal(d.detail.includes(LEAK_SECRET), false, `${label}: the secret survived: ${d.detail}`);
  assert.equal(d.detail.includes(`${LEAK_USER}:`), false, `${label}: the userinfo survived: ${d.detail}`);
  assert.ok(d.detail.includes('host.invalid'), `${label}: the host was lost too: ${d.detail}`);
}

test('publish: a git:// remote carrying userinfo fails without leaking it', (t) => {
  // Measured leak: `fatal: unable to look up cad:s3cr3t-tok@host.invalid (port
  // 9418)`. No network - `.invalid` is reserved and never resolves.
  const fx = leakyOrigin(t, `git://${LEAK_USER}:${LEAK_SECRET}@host.invalid/r.git`);
  assertNoCredential(seam(['publish', '--dir', fx.root], fx.globalFile), 'git://');
});

test('publish: a PATH-shaped remote carrying userinfo fails without leaking it', (t) => {
  // The second transport measured to leak, and the one AC8 names beside git://:
  // git quotes the whole path back (`fatal: '/nonexistent/cad:s3cr3t-tok@
  // host.invalid/r.git' does not appear to be a git repository`). An scp-shaped
  // remote is NOT usable here - git hands it straight to ssh, whose stderr
  // names neither the URL nor the host, so there is nothing for this arm to
  // assert and the ssh it spawns would read the developer's own ~/.ssh/config.
  const fx = leakyOrigin(t, `/nonexistent/${LEAK_USER}:${LEAK_SECRET}@host.invalid/r.git`);
  const d = seam(['publish', '--dir', fx.root], fx.globalFile);
  assertNoCredential(d, 'path-shaped');
  assert.ok(d.detail.includes('/nonexistent/'), d.detail);
});

test('publish: a credential-named pair in a path-shaped remote is redacted and the detail capped at 1024 bytes', (t) => {
  // D-13, gap 13. `redactUrl` reads URL POSITION only, so a `token=<value>` pair
  // in a path-shaped origin passed through it untouched and git's push error
  // carried the value into the envelope - and uncapped, since the remote path
  // is the caller's. The space after the pair ends its value, so the long tail
  // is what the cap has to cut (a pair running to the tail would be redacted
  // down to under the cap, and the cap would go unexercised).
  const tail = Array.from({ length: 6 }, () => 'p'.repeat(200)).join('/');
  const fx = leakyOrigin(t, `/nonexistent/token=${LEAK_SECRET} dir/${tail}/r.git`);
  const d = seam(['publish', '--dir', fx.root], fx.globalFile);
  assert.equal(d.ok, false, JSON.stringify(d));
  assert.equal(d.reason, 'push-failed', JSON.stringify(d));
  assert.equal(d.detail.includes(LEAK_SECRET), false, `the secret survived: ${d.detail}`);
  assert.ok(d.detail.includes('/nonexistent/'), `the remote was lost too: ${d.detail}`);
  assert.ok(Buffer.byteLength(d.detail) <= 1024, `${Buffer.byteLength(d.detail)} bytes`);
  assert.ok(d.detail.endsWith(' ...[truncated]'), d.detail.slice(-40));
});

test('source: push-failed goes through redactAndCap, the other details through redactUrl', () => {
  // The census, so a FOURTH site added to this file fails here rather than
  // shipping a credential: three of EXP-01's four sites live in git-publish.mjs
  // (push-failed, reap-failed, and the dispatch-level internal catch), and each
  // is named so a rename cannot quietly drop one. The fourth site is
  // planning.mjs's no-staged-set, censused by planning.test.mjs beside its own
  // end-to-end arm - one census per file, so the two cannot drift apart.
  //
  // The split is D-13: push-failed carries git's push error, whose remote is the
  // caller's, so it goes through the shared redact-and-cap helper; reap-failed
  // and internal keep redactUrl only.
  const IDIOM = /e && e\.message \? e\.message : String\(e\)/g;
  const CAPPED = /redactAndCap\(e && e\.message \? e\.message : String\(e\)\)/g;
  const WRAPPED = /redactUrl\(e && e\.message \? e\.message : String\(e\)\)/g;
  // E-03-1 added a fourth: open-failed and merge-failed carry the forge CLI's error, which can name the remote's URL,
  // so it's capped like push-failed.
  const pub = readFileSync(join(BIN, 'git-publish.mjs'), 'utf8');
  assert.equal((pub.match(IDIOM) || []).length, 4, 'git-publish.mjs gained or lost a detail site');
  assert.equal((pub.match(CAPPED) || []).length, 2, 'push-failed and the request failure are not the two capped sites');
  assert.equal((pub.match(WRAPPED) || []).length, 2, 'a git-publish.mjs detail site is unredacted');
  assert.match(pub, /reason: 'push-failed'[\s\S]{0,120}?detail: redactAndCap\(/, 'push-failed');
  assert.match(pub, /reason: `\$\{op\}-failed`[\s\S]{0,120}?detail: redactAndCap\(/, 'open-failed and merge-failed');
  for (const reason of ['reap-failed', 'internal']) {
    assert.match(pub, new RegExp(`reason: '${reason}'[\\s\\S]{0,120}?detail: redactUrl\\(`), reason);
  }
});

// --- --dir refuses rather than acting on the process cwd (phase 2 D-01) ------

// This seam PUSHES and DELETES, and `--dir` is what names the tree it does that
// in. Measured 2026-08-18 before the fix, `reap --dir '' --branch
// nosuchbranch-xyz` answered {"ok":true,"action":"already-absent"} - a
// confident answer about whatever tree the process happened to be standing in.
// An ABSENT --dir still means the cwd (every fixture-driven arm above passes
// one explicitly, and they all still pass); only the empty, valueless and
// flag-shaped spellings refuse.
for (const [sub, rest] of [['publish', []], ['reap', ['--branch', 'cadence/v2.2.0']],
  ['authorized', []], ['open', ['--forge', 'github', '--base', 'main']], ['merge', ['--forge', 'github']]]) {
  for (const [label, dirArgs] of [['an EMPTY', ['--dir', '']], ['a VALUELESS', ['--dir']]]) {
    test(`${sub}: ${label} --dir refuses by name, exit 1, nothing run`, () => {
      const { d, status } = seamStatus([sub, ...dirArgs, ...rest]);
      assert.equal(d.ok, false);
      // The e.seam catch arm, not the generic one: without it the thrown
      // refusal object (no `message`) reads as internal/"[object Object]".
      assert.equal(d.reason, 'missing-flag-value', JSON.stringify(d));
      assert.equal(d.detail, '--dir');
      assert.equal(status, 1);
    });
  }
}

// --- open and merge: the unattended land's request calls (E-03-1) -------------

// /cad-land 3(b) ran gh, glab and tea in Bash, where git-guard's request rail now asks. These two run them as a
// subprocess under publish's own gates, so each test reads the stub's argv log: what ran, or that nothing did.

/** Run `open` or `merge` with stub gh, glab and tea first on PATH; the argv log lines, or [] when none ran. */
function requestRun(t, args, globalCfg, stubOpts = {}) {
  const stubDir = tmp(t, 'cad-pub-req-stub-');
  for (const name of ['gh', 'glab', 'tea']) stub(stubDir, name, { body: 'https://forge.test/req/7', ...stubOpts });
  const log = join(tmp(t, 'cad-pub-req-log-'), 'argv.log');
  const env = { ...GIT_ENV, CADENCE_GLOBAL_CONFIG: globalCfg, PATH: `${stubDir}:${process.env.PATH}`, CAD_ARGV_LOG: log };
  let out; let status = 0;
  try { out = execFileSync('node', [SEAM, ...args], { encoding: 'utf8', env }); }
  catch (e) { out = e.stdout; status = e.status; }
  const ran = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
  return { d: JSON.parse(String(out).trim()), status, ran };
}

const BRANCH = 'cadence/v1.1.0-rc.2';

test('open and merge: each forge runs its own CLI with the argv cad-land ran in Bash', (t) => {
  const { dir } = repo(t);
  const rows = [
    [['open', '--forge', 'github', '--base', 'main'], `gh pr create --base main --head ${BRANCH} --fill`, 'opened'],
    [['open', '--forge', 'gitlab', '--base', 'main'],
      `glab mr create --source-branch ${BRANCH} --target-branch main --fill`, 'opened'],
    [['open', '--forge', 'forgejo', '--base', 'main'], `tea pr create --base main --head ${BRANCH}`, 'opened'],
    [['merge', '--forge', 'github'], `gh pr merge ${BRANCH} --merge --delete-branch`, 'merged'],
    [['merge', '--forge', 'github', '--sha', 'abc1234'],
      `gh pr merge ${BRANCH} --merge --delete-branch --match-head-commit abc1234`, 'merged'],
    [['merge', '--forge', 'gitlab'], `glab mr merge ${BRANCH} --yes --remove-source-branch --auto-merge=false`, 'merged'],
    [['merge', '--forge', 'forgejo', '--index', '12'], 'tea pr merge --style merge 12', 'merged'],
  ];
  for (const [args, argv, action] of rows) {
    const { d, status, ran } = requestRun(t, [...args, '--dir', dir], GLOBAL_ON_FILE);
    assert.equal(status, 0, JSON.stringify(d));
    assert.equal(d.action, action);
    assert.equal(d.branch, BRANCH);
    assert.equal(d.output, 'https://forge.test/req/7', 'the forge CLI printed the request, and the envelope carries it');
    assert.deepEqual(ran, [argv]);
  }
});

test('open and merge refuse with nothing run: auto_close in one layer, or a protected head', (t) => {
  const repoOnly = repo(t).dir;
  const globalOnly = repo(t, { config: { git: {} } }).dir;
  const onMain = repo(t, { branch: 'main' }).dir;
  for (const args of [['open', '--forge', 'github', '--base', 'main'], ['merge', '--forge', 'gitlab']]) {
    for (const [dir, cfg, reason] of [[repoOnly, NO_GLOBAL, 'auto-close-off'],
      [globalOnly, GLOBAL_ON_FILE, 'auto-close-off'], [onMain, GLOBAL_ON_FILE, 'protected-branch']]) {
      const { d, status, ran } = requestRun(t, [...args, '--dir', dir], cfg);
      assert.equal(status, 1);
      assert.equal(d.reason, reason, JSON.stringify(d));
      assert.deepEqual(ran, [], `${args[0]} ran a forge CLI past ${reason}`);
    }
  }
});

test('open and merge refuse with nothing run: a torn layer that could carry protected_branches', (t) => {
  const { dir } = repo(t);
  const { d, status, ran } = requestRun(t, ['merge', '--forge', 'github', '--dir', dir], globalText(t, '{"git":'));
  assert.equal(status, 1);
  assert.equal(d.reason, 'config-parse-failed', JSON.stringify(d));
  assert.match(d.hint, /nothing is merged/);
  assert.deepEqual(ran, []);
});

test('merge refuses a flag its forge does not take, so a head check is never dropped', (t) => {
  const { dir } = repo(t);
  for (const [args, reason] of [[['--forge', 'gitlab', '--sha', 'abc1234'], 'bad-sha'],
    [['--forge', 'github', '--sha', 'HEAD~1'], 'bad-sha'], [['--forge', 'github', '--index', '3'], 'bad-index'],
    [['--forge', 'forgejo'], 'bad-index'], [['--forge', 'bitbucket'], 'bad-forge']]) {
    const { d, ran } = requestRun(t, ['merge', ...args, '--dir', dir], GLOBAL_ON_FILE);
    assert.equal(d.reason, reason, JSON.stringify(args));
    assert.deepEqual(ran, []);
  }
  const { d } = requestRun(t, ['open', '--forge', 'github', '--base', 'a:b', '--dir', dir], GLOBAL_ON_FILE);
  assert.equal(d.reason, 'bad-base');
});

test('merge: a forge CLI that fails says merge-failed, with its URL credentials redacted', (t) => {
  const { dir } = repo(t);
  const { d, status } = requestRun(t, ['merge', '--forge', 'github', '--dir', dir], GLOBAL_ON_FILE,
    { body: '', code: 1, stderr: 'not mergeable: https://bot:s3cr3t@forge.test/o/r' });
  assert.equal(status, 1);
  assert.equal(d.reason, 'merge-failed');
  assert.match(d.detail, /not mergeable/);
  assert.doesNotMatch(d.detail, /s3cr3t/);
});

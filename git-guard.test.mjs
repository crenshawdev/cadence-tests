// Zero-dep tests for git-guard.mjs (the PreToolUse hook). Run:
// node --test 'tests/*.test.mjs'
//
// What a command IS, is read by lib/git-segments.mjs and pinned in
// git-segments.test.mjs. This file tests the HOOK: that a reading reaches the
// permission prompt, which is the guard's only observable (D-09). A defect
// proven only at the reader level is not proven to reach a decision.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { treeOf, v40Project } from './planning.test.mjs';

const GUARD = join(dirname(fileURLToPath(import.meta.url)), '..', 'cadence-core', 'bin', 'git-guard.mjs');

// Hermetic global config (never read the dev's real one).
const NO_GLOBAL_ROOT = mkdtempSync(join(tmpdir(), 'cad-guard-'));
const NO_GLOBAL = join(NO_GLOBAL_ROOT, 'no-global.json');
after(() => rmSync(NO_GLOBAL_ROOT, { recursive: true, force: true }));

/** A mkdtemp root that goes when test `t` ends. */
function tmp(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Fixture git calls must never read the dev's global/system git config
// (commit.gpgsign, init.defaultBranch hooks, ... would break the fixtures).
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

/** Run a git command against a fixture dir, hermetically. */
function git(args, opts = {}) {
  execFileSync('git', args, { stdio: 'ignore', env: GIT_ENV, ...opts });
}

/** Feed the hook a raw stdin payload; return trimmed stdout. */
function guardRaw(input) {
  return execFileSync('node', [GUARD], {
    encoding: 'utf8',
    input,
    // the push rail reads git config, so the dev's own ~/.gitconfig stays out of it
    env: { ...process.env, CADENCE_GLOBAL_CONFIG: NO_GLOBAL, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  }).trim();
}

/** Feed the hook a PreToolUse payload; return the parsed decision or null. */
function guard(command, cwd) {
  const stdout = guardRaw(JSON.stringify({ tool_input: { command }, cwd }));
  return stdout ? JSON.parse(stdout).hookSpecificOutput : null;
}

/** A Cadence project fixture: git repo on `branch` with a .planning dir. */
function project(t, branch, config) {
  const dir = tmp(t, 'cad-guard-repo-');
  git(['-C', dir, 'init', '-q', '-b', branch]);
  writeFileSync(join(dir, 'f.txt'), 'x');
  git(['-C', dir, 'add', '.']);
  git(['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t',
    'commit', '-q', '-m', 'init']);
  mkdirSync(join(dir, '.planning'), { recursive: true });
  if (config) writeFileSync(join(dir, '.planning', 'config.json'), JSON.stringify(config));
  return dir;
}

// --- Scope. -----------------------------------------------------------------

test('run against an unstamped v4.0 project it leaves .planning byte-identical and exits 0', (t) => {
  const dir = v40Project(t);
  const root = dirname(dir);
  git(['-C', root, 'init', '-q', '-b', 'main']);
  const before = treeOf(dir);
  for (const command of ['git commit -m x', 'git push origin main', 'ls']) {
    const r = spawnSync('node', [GUARD], {
      encoding: 'utf8',
      input: JSON.stringify({ tool_input: { command }, cwd: root }),
      env: { ...process.env, CADENCE_GLOBAL_CONFIG: NO_GLOBAL },
    });
    assert.equal(r.status, 0, command);
  }
  assert.deepEqual(treeOf(dir), before);
});

test('silent outside a Cadence project', (t) => {
  const dir = tmp(t, 'cad-guard-plain-');
  assert.equal(guard('git push origin main', dir), null);
});

test('silent for non-git commands inside a project', (t) => {
  assert.equal(guard('ls -la', project(t, 'main')), null);
});

test('guard applies from a subdirectory of the project (walk-up)', (t) => {
  const dir = project(t, 'main');
  const sub = join(dir, 'src', 'deep');
  mkdirSync(sub, { recursive: true });
  const d = guard('git commit -m "x"', sub);
  assert.equal(d.permissionDecision, 'ask');
  assert.match(d.permissionDecisionReason, /protected/);
});

test('walk-up stops at a repo root without .planning (still not policed)', (t) => {
  // A plain repo whose PARENT happens to contain .planning must not be policed.
  const outer = tmp(t, 'cad-guard-outer-');
  mkdirSync(join(outer, '.planning'));
  const inner = join(outer, 'other-repo');
  mkdirSync(inner);
  git(['-C', inner, 'init', '-q', '-b', 'main']);
  assert.equal(guard('git push origin main', inner), null);
});

// --- Rail 3: never auto-push. -----------------------------------------------

// A linked worktree's and a submodule's `.git` is a FILE. The push rail walks
// past it to the owning project (phase 1 D-02, D-03); an independent clone's
// `.git` is a DIRECTORY and still ends the walk. `project()` creates its
// `.planning/` after the commit, so it is untracked and no checkout of the
// project carries it - the walk has to climb to find it.

test('git push from a linked worktree beneath the project asks', (t) => {
  const dir = project(t, 'main');
  const wt = join(dir, '.claude', 'worktrees', 'agent-x');
  git(['-C', dir, 'worktree', 'add', '-q', '-b', 'agent-x', wt]);
  const d = guard('git push origin agent-x:main', wt);
  assert.notEqual(d, null);
  assert.equal(d.permissionDecision, 'ask');
  assert.match(d.permissionDecisionReason, /cad-land/);
  assert.equal(guard('git push origin agent-x', wt), null);
});

test('git push from a submodule beneath the project asks', (t) => {
  const dir = project(t, 'main');
  const sub = tmp(t, 'cad-guard-sub-');
  git(['-C', sub, 'init', '-q', '-b', 'main']);
  writeFileSync(join(sub, 's.txt'), 's');
  git(['-C', sub, 'add', '.']);
  git(['-C', sub, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init']);
  // git 2.38.1+ refuses a local-path submodule clone unless the file transport
  // is allowed for this one call.
  git(['-C', dir, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor/sub']);
  // a submodule's checkout is a detached HEAD, so the push names the protected branch it reaches
  const d = guard('git push origin x:main', join(dir, 'vendor', 'sub'));
  assert.notEqual(d, null);
  assert.equal(d.permissionDecision, 'ask');
});

test('a worktree created OUTSIDE the project stays unguarded (D-03)', (t) => {
  const dir = project(t, 'main');
  const wt = join(tmp(t, 'cad-guard-away-'), 'wt');
  git(['-C', dir, 'worktree', 'add', '-q', '-b', 'away', wt]);
  assert.equal(guard('git push origin x', wt), null);
});

test('a commit from a linked worktree is judged exactly as before: silent', (t) => {
  // The commit rail keeps its own lookup, so it does not start judging worktree
  // commits even on a branch the project lists as protected.
  const dir = project(t, 'main', { git: { protected_branches: ['agent-x'] } });
  const wt = join(dir, '.claude', 'worktrees', 'agent-x');
  git(['-C', dir, 'worktree', 'add', '-q', '-b', 'agent-x', wt]);
  assert.equal(guard('git commit -m x', wt), null);
});

test('a push asks only when it reaches a protected branch (publishing is /cad-land\'s call)', (t) => {
  const dir = project(t, 'feature');
  assert.equal(guard('git push origin feature', dir), null);
  const d = guard('git push origin feature:main', dir);
  assert.equal(d.hookEventName, 'PreToolUse'); // the harness routes on this
  assert.equal(d.permissionDecision, 'ask');
  assert.match(d.permissionDecisionReason, /cad-land/);
});

test('auto_close true exempts no push that reaches a protected branch', (t) => {
  // auto_close is no push exemption: cad-land's sanctioned publish runs through
  // the git-publish seam as a subprocess argv push this Bash hook never sees.
  const dir = project(t, 'main', { git: { auto_close: true } });
  const d = guard('git push -u origin main', dir);
  assert.notEqual(d, null);
  assert.equal(d.permissionDecision, 'ask');
});

test('compound command still catches the push half', (t) => {
  const d = guard('git add . && git push', project(t, 'main'));
  assert.equal(d.permissionDecision, 'ask');
});

test('global git options are skipped when finding the subcommand', (t) => {
  const d = guard('git -C . -c user.name=t push origin x:main', project(t, 'feature'));
  assert.equal(d.permissionDecision, 'ask');
});

test('git stash push is not a publish (the verb is stash)', (t) => {
  assert.equal(guard('git stash push -m wip', project(t, 'main')), null);
});

test('push as an argument or inside quotes never fires the rail', (t) => {
  const p = project(t, 'main');
  assert.equal(guard('git log --grep "push"', p), null);
  assert.equal(guard('git log --grep push', p), null);
  assert.equal(guard('echo "git push"', p), null);
});

// --- Rail 1: the protected-branch commit guard, the only deny surface. ------

test('commit on a protected branch asks by default, silent on a task branch', (t) => {
  const d = guard('git commit -m "x"', project(t, 'main'));
  assert.equal(d.permissionDecision, 'ask');
  assert.match(d.permissionDecisionReason, /protected/);
  assert.equal(guard('git commit -m "x"', project(t, 'improve/thing')), null);
});

test('git.on_protected=refuse denies; =allow stays silent', (t) => {
  const refuse = guard('git commit -m "x"',
    project(t, 'main', { git: { on_protected: 'refuse' } }));
  assert.equal(refuse.permissionDecision, 'deny');
  assert.equal(guard('git commit -m "x"',
    project(t, 'main', { git: { on_protected: 'allow' } })), null);
});

test('on_protected "deny" is an alias of refuse, not a silent soft-ask (#38)', (t) => {
  const d = guard('git commit -m "x"',
    project(t, 'main', { git: { on_protected: 'deny' } }));
  assert.equal(d.permissionDecision, 'deny');
});

test('a string protected_branches guards THAT branch, not the default list (#38)', (t) => {
  // "release" (string, not array) is an easy hand-edit; honor it instead of
  // silently reverting to ['main','master'].
  const d = guard('git commit -m "x"',
    project(t, 'release', { git: { protected_branches: 'release' } }));
  assert.equal(d.permissionDecision, 'ask');
  assert.equal(guard('git commit -m "x"',
    project(t, 'main', { git: { protected_branches: 'release' } })), null);
});

test('an EMPTY protected_branches list still means nothing is protected (D-09)', (t) => {
  // `[]` is the user saying "protect nothing"; it must never fall through to
  // the default ['main','master'], which would re-protect main behind their
  // back. A commit on main under it is unguarded.
  assert.equal(guard('git commit -m "x"',
    project(t, 'main', { git: { protected_branches: [] } })), null);
  assert.equal(guard('git commit -m "x"',
    project(t, 'main', { git: { protected_branches: [], on_protected: 'refuse' } })), null);
});

test('a protected_branches naming NO branch guards the default list (GRD-01)', (t) => {
  // The hole this closes: `""` used to resolve to [""], a list that reads as
  // configured and matches no branch, so a commit on main came back null -
  // setting the key REMOVED the protection it names. A value naming no branch
  // is a typo (D-02), so the default list applies and main is guarded again.
  const ask = guard('git commit -m "x"',
    project(t, 'main', { git: { protected_branches: '' } }));
  assert.equal(ask.permissionDecision, 'ask');
  assert.match(ask.permissionDecisionReason, /"main" is a protected branch/);
  const deny = guard('git commit -m "x"',
    project(t, 'main', { git: { protected_branches: '', on_protected: 'refuse' } }));
  assert.equal(deny.permissionDecision, 'deny');
  // The array spelling of the same hole: one grammar reached two ways (D-01).
  const arr = guard('git commit -m "x"',
    project(t, 'main', { git: { protected_branches: [''] } }));
  assert.equal(arr.permissionDecision, 'ask');
  assert.match(arr.permissionDecisionReason, /"main" is a protected branch/);
});

test('custom protected_branches list is honored', (t) => {
  const d = guard('git commit -m "x"',
    project(t, 'release', { git: { protected_branches: ['release'] } }));
  assert.equal(d.permissionDecision, 'ask');
  assert.equal(guard('git commit -m "x"',
    project(t, 'main', { git: { protected_branches: ['release'] } })), null);
});

test('a commit message naming the push rail is a commit, not a push', (t) => {
  // Only the verb is read, so `push` as message content cannot reach rail 3.
  const d = guard('git commit -m "fix the push rail"',
    project(t, 'main', { git: { on_protected: 'refuse' } }));
  assert.equal(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /protected branch/);
});

// The deny gate is GONE, and this is the suite that replaces it. Detection used
// to be any-position - a wide reader saw `rg -t sh "git commit"` as a commit -
// so a SECOND rule had to narrow refusal back to command position, and that
// rule had an enumerated prefix set three review rounds kept finding new
// members of. Anchoring detection to the command word makes every row below
// silent up front, so there is one rule where there were two and no
// enumeration to maintain.
test('a mention or a read-only search is silent, so no deny gate is needed', (t) => {
  const p = project(t, 'main', { git: { on_protected: 'refuse' } });
  for (const command of [
    'rg -n "git push" .',
    'rg -t sh "git commit"',
    'grep git commit',
    'command -v git commit',
    'echo "git commit"',
    'echo git commit',
  ]) {
    assert.equal(guard(command, p), null, command);
  }
});

// --- The accepted cost of deleting the tokenizer. ---------------------------

// Each row below REALLY CAN run git and is now silent. They are here as a
// pinned, deliberate list rather than as an absence, so the trade stays visible
// and a future reader does not mistake any of them for an oversight. The
// tokenizer that saw them cost 840 lines, an escape surface that never stopped
// producing findings, and a hook OOM that failed OPEN. references/git-publish.md rail 3
// and the docs/history/CHANGELOG-v1-v2.md entry that removed the parser carry the same list.
test('shapes the anchored reader declines to see (stated cost, not an oversight)', (t) => {
  const p = project(t, 'feature', { git: { on_protected: 'refuse' } });
  for (const command of [
    'bash -c "git push origin main"',           // shell wrapper
    'sh -c \'git push origin main\'',
    'eval git push origin main',
    '$(git push origin main)',                  // command substitution
    '`git push origin main`',
    '(git push origin main)',                   // subshell
    'sudo git push origin main',                // transparent prefix
    'timeout 60 git push origin main',
    'xargs git push',
    'env -S "git push origin main"',
    'ssh host "git push origin main"',          // always was out of grammar
    'git -C "my repo" push origin main',        // quoted path with a space
    'git \\\n  push origin main',               // line continuation
  ]) {
    assert.equal(guard(command, p), null, command);
  }
});

// --- Failure posture: a broken or overloaded guard never blocks work. -------

test('malformed stdin exits 0 with no output (guard never blocks work)', () => {
  assert.equal(guardRaw('not json {'), '');
});

test('payload without a command stays silent inside a project', (t) => {
  const dir = project(t, 'main');
  assert.equal(guardRaw(JSON.stringify({ tool_input: {}, cwd: dir })), '');
});

test('commit guard degrades silently when .planning has no git repo', (t) => {
  // planningRoot finds the project, but `git rev-parse` fails - the guard
  // must swallow that and never block (a broken guard blocks nothing).
  const dir = tmp(t, 'cad-guard-norepo-');
  mkdirSync(join(dir, '.planning'));
  assert.equal(guard('git commit -m "x"', dir), null);
});

test('detached HEAD is not a protected branch (rev-parse says HEAD)', (t) => {
  const dir = project(t, 'main');
  git(['-C', dir, 'checkout', '-q', '--detach']);
  assert.equal(guard('git commit -m "x"', dir), null);
});

test('the payload size that OOMed the deleted reader still decides', (t) => {
  // The deleted reader was O(K x N) in memory and aborted (SIGABRT, no stdout)
  // at 280KB. This hook FAILS OPEN, so that abort let a real push run
  // unprompted - the guard's worst failure mode reached by its own input. Here
  // the same size decides normally, through the real hook.
  const p = project(t, 'feature');
  const big = 'git clean -fd; '.repeat(24000) + 'git push origin main';
  assert.ok(big.length > 280_000, 'fixture must exceed the measured OOM point');
  const d = guard(big, p);
  assert.notEqual(d, null);
  assert.equal(d.permissionDecision, 'ask');
});

// --- the torn-layer diagnostic (QW-02, D-17) --------------------------------
// A config layer that failed to parse is the layer whose protected_branches and
// on_protected this rail was about to decide with. Before this, a torn file was
// read as "no config" and the guard decided from defaults in silence.

/** A project whose repo config layer is RAW text - here, unparseable. */
function tornProject(t, branch, raw = '{') {
  const dir = project(t, branch);
  writeFileSync(join(dir, '.planning', 'config.json'), raw);
  return dir;
}

test('a torn config asks on a NON-protected branch, naming the parse failure', (t) => {
  // The case worth catching: keying this to a protected-branch hit would miss
  // exactly the user whose own custom list is what was lost.
  const dir = tornProject(t, 'feature/x');
  const d = guard('git commit -m x', dir);
  assert.equal(d.permissionDecision, 'ask');
  assert.match(d.permissionDecisionReason, /failed to parse/);
  assert.match(d.permissionDecisionReason, /config\.json/);
  // ...and it names the REPO layer specifically, now that a torn GLOBAL layer
  // asks with the same decision word.
  assert.ok(d.permissionDecisionReason
    .includes(`config layer ${join(dir, '.planning', 'config.json')} failed to parse`),
  `reason must name the repo layer: ${d.permissionDecisionReason}`);
});

test('a torn config asks ONCE on a protected branch, not twice', (t) => {
  const dir = tornProject(t, 'main');
  const stdout = guardRaw(JSON.stringify({ tool_input: { command: 'git commit -m x' }, cwd: dir }));
  assert.equal(stdout.split('\n').filter(Boolean).length, 1);
  const d = JSON.parse(stdout).hookSpecificOutput;
  assert.equal(d.permissionDecision, 'ask');
  assert.match(d.permissionDecisionReason, /failed to parse/);
});

test('on_protected: allow with a torn layer still asks - the value was not read', (t) => {
  // `allow` here can only come from the DEFAULTS, since the layer carrying it
  // is the one that did not parse. Silence would be asserting a setting nobody
  // could read.
  const dir = tornProject(t, 'main', '{ "git": { "on_protected": "allow" ');
  const d = guard('git commit -m x', dir);
  assert.equal(d.permissionDecision, 'ask');
  assert.match(d.permissionDecisionReason, /failed to parse/);
});

test('a torn layer never DENIES - fail-open stands', (t) => {
  const dir = tornProject(t, 'main', '{ "git": { "on_protected": "refuse" ');
  assert.equal(guard('git commit -m x', dir).permissionDecision, 'ask');
});

test('a well-formed config on a non-protected branch is still silent', (t) => {
  assert.equal(guard('git commit -m x', project(t, 'feature/x', { git: {} })), null);
  assert.equal(guard('git commit -m x', project(t, 'feature/x')), null);
});

test('the push rail is unchanged by a torn layer', (t) => {
  const dir = tornProject(t, 'feature/x');
  const d = guard('git push', dir);
  assert.equal(d.permissionDecision, 'ask');
  assert.match(d.permissionDecisionReason, /publishing is/);
});

/** Feed the hook a commit payload with a chosen user-global config layer. */
function guardWithGlobal(command, cwd, gpath) {
  const stdout = execFileSync('node', [GUARD], {
    encoding: 'utf8',
    input: JSON.stringify({ tool_input: { command }, cwd }),
    env: { ...process.env, CADENCE_GLOBAL_CONFIG: gpath },
  }).trim();
  return stdout ? JSON.parse(stdout).hookSpecificOutput : null;
}

test('a torn USER-GLOBAL layer asks too, naming that layer - it carries the same keys', (t) => {
  // The live defect: the arm matched the REPO layer's path only, so a torn
  // ~/.claude/cadence/config.json - the layer that most often carries
  // protected_branches and on_protected - decided from DEFAULTS in silence.
  // The path here shares nothing with the repo layer, which is the only shape
  // that separates the two implementations: a conflating
  // `includes(repoLayer)` matches nothing and stays silent.
  const dir = project(t, 'feature/x', { git: { protected_branches: ['main'] } });
  const repoLayer = join(dir, '.planning', 'config.json');
  const gpath = join(tmp(t, 'cad-guard-elsewhere-'), 'global.json');
  assert.ok(!gpath.includes(repoLayer) && !repoLayer.includes(gpath)); // premise, stated
  writeFileSync(gpath, '{ "git": { "protected_branches": ');
  const d = guardWithGlobal('git commit -m x', dir, gpath);
  assert.equal(d.permissionDecision, 'ask');
  assert.match(d.permissionDecisionReason, /failed to parse/);
  assert.ok(d.permissionDecisionReason.includes(gpath),
    `reason must name the torn GLOBAL layer: ${d.permissionDecisionReason}`);
});

test('a torn global layer asks on `release` too - the list that would have named it is gone', (t) => {
  // No repo layer at all, so `release` is non-protected under the DEFAULTS -
  // and the file that could have protected it is the unreadable one. Silence
  // here is the commit landing unguarded.
  const dir = project(t, 'release');
  const gpath = join(tmp(t, 'cad-guard-elsewhere2-'), 'global.json');
  writeFileSync(gpath, '{');
  const d = guardWithGlobal('git commit -m x', dir, gpath);
  assert.equal(d.permissionDecision, 'ask');
  assert.ok(d.permissionDecisionReason.includes(gpath),
    `reason must name the torn GLOBAL layer: ${d.permissionDecisionReason}`);
});

test('a torn GLOBAL layer whose path merely PREFIXES the repo layer asks as itself', (t) => {
  // The ANTI-CONFLATION case, kept from when this arm was repo-only. mergeLayers
  // warnings are flat strings with no layer field, so a bare
  // `includes(repoLayer)` reads THIS global-layer warning as a torn REPO layer.
  // Both layers now ask, so the decision no longer separates them - the REASON
  // does: it must name `config.json.global`, the file that actually tore, and
  // must not diagnose the repo layer, which is absent and parsed nothing.
  const dir = project(t, 'feature/x');
  const repoLayer = join(dir, '.planning', 'config.json');
  const gpath = `${repoLayer}.global`;
  assert.ok(gpath.startsWith(repoLayer)); // the premise, stated not assumed
  writeFileSync(gpath, '{');
  const d = guardWithGlobal('git commit -m x', dir, gpath);
  assert.equal(d.permissionDecision, 'ask');
  assert.ok(d.permissionDecisionReason.includes(`config layer ${gpath} failed to parse`),
    `reason must diagnose the .global file: ${d.permissionDecisionReason}`);
  assert.ok(!d.permissionDecisionReason.includes(`config layer ${repoLayer} failed to parse`),
    `reason must not claim the repo layer tore: ${d.permissionDecisionReason}`);
});

test('a torn repo layer never CANCELS a deny the global layer configured', (t) => {
  // The ordering hazard: the torn arm returns `ask`, so putting it in front of
  // the protected-branch decision would turn a configured hard block into a
  // soft ask exactly when the repo layer is the unreadable one. The decision
  // stays `deny` and gains the parse reason.
  const gpath = join(tmp(t, 'cad-guard-g-'), 'global.json');
  writeFileSync(gpath, JSON.stringify({ git: { on_protected: 'refuse' } }));
  const dir = tornProject(t, 'main');
  const stdout = execFileSync('node', [GUARD], {
    encoding: 'utf8',
    input: JSON.stringify({ tool_input: { command: 'git commit -m x' }, cwd: dir }),
    env: { ...process.env, CADENCE_GLOBAL_CONFIG: gpath },
  }).trim();
  const d = JSON.parse(stdout).hookSpecificOutput;
  assert.equal(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /failed to parse/);
  assert.match(d.permissionDecisionReason, /protected branch/);
});

// --- No gate value reaches this rail (phase 2, D-11). -----------------------
//
// Phase 2 makes a `deferred` gate defer a blocking finding to the LAND. The
// criterion the phase is written against is that the protected-branch guard did
// NOT move: it answers where commits go, never what a review found, so it must
// stay reachable by no gate value at all. A change made to give this pin
// something to observe - a routing import, a resolved gate threaded near
// branchDecision - is the failure it exists to detect, not a way to pass it.
//
// The census is LEXICAL over git-guard.mjs's own source. Every pattern is built
// from an escaped string through `new RegExp`, the discipline
// helper-census.test.mjs declares - but the read set here is ONE NAMED FILE,
// the file-scoped `redactUrl` precedent rather than the tree-wide walk, so a
// rule that states its own subject in this file is out of its own read set by
// construction and needs no exemption. Widening any of these to the whole tree
// would need that discipline honoured for real.

const GUARD_SRC = readFileSync(GUARD, 'utf8');

test('census: no gate value reaches the protected-branch guard (D-11)', () => {
  // The five names `review.triggers.<t>.gate` accepts. Matched as STRING
  // LITERALS, not as English: the source comments legitimately say "taken off
  // the call" and "the old deny gate", and a gate a hook could act on is a
  // quoted value or nothing.
  for (const gate of ['off', 'advisory', 'deferred', 'blocking', 'adjudicated']) {
    const re = new RegExp("['\"]" + gate + "['\"]", 'g');
    assert.equal(GUARD_SRC.match(re), null,
      `git-guard.mjs names the gate value "${gate}". The guard decides where a `
      + 'commit may land, not what a review found: no gate value may reach it '
      + '(D-11). If a rail genuinely needs one, that is a phase decision, not '
      + 'a plumbing change.');
  }

  // What branchDecision consults from the merged config, as the dotted paths
  // the source spells. `config.json` is the layer FILENAME, not a key, so the
  // config arm excludes it by name rather than by a second allowlist.
  const gitKeys = GUARD_SRC.match(new RegExp("\\bgit\\.[a-z_]+", 'g')) || [];
  assert.deepEqual([...new Set(gitKeys)].sort(), ['git.guard_bypass', 'git.on_protected', 'git.protected_branches'],
    'git-guard.mjs reads a git.* config key beyond guard_bypass, on_protected and '
    + 'protected_branches. protected_branches is read through '
    + 'lib/protected-branches.mjs, which reads that one key and nothing else.');
  const configKeys = GUARD_SRC.match(new RegExp("\\bconfig\\.(?!json\\b)[a-z_]+", 'g')) || [];
  assert.deepEqual([...new Set(configKeys)].sort(), ['config.git'],
    'git-guard.mjs reads a second branch of the merged config. `git` is the '
    + 'whole of what this hook consults (D-11).');

  // The bypass the two rules above cannot see: importing the resolver and
  // handing it a config, so no gate name and no config path is ever spelled
  // here. The import set is pinned whole - a new dependency in this file is
  // the rail moving, whatever it is for. It counts the commit rail's
  // `import('...')` loads as well as the static `from '...'` ones.
  const imports = (GUARD_SRC.match(new RegExp("(?:from |import\\()'[^']+'", 'g')) || [])
    .map((m) => m.slice(m.indexOf("'") + 1, -1));
  assert.deepEqual([...new Set(imports)].sort(), [
    './lib/config-merge.mjs',
    './lib/git-head.mjs',
    './lib/git-segments.mjs',
    './lib/protected-branches.mjs',
    'node:fs',
    'node:path',
  ], 'git-guard.mjs gained an import. The guard is frozen at the rails it '
    + 'already holds; a routing seam imported here is exactly the plumbing '
    + 'D-11 forbids.');
});

test('a deferred gate in the config layer changes no guard decision', (t) => {
  // The behavioural half: the same protected-branch commit, once under a bare
  // config and once under a config that ALSO pins a deferred gate on the
  // trigger whose findings this phase queues. The guard reads the same merged
  // layer both times, so "unreached" has to be observable in the decision.
  const bare = guard('git commit -m "x"', project(t, 'main', { git: {} }));
  const withGate = guard('git commit -m "x"', project(t, 'main', {
    git: {},
    review: { triggers: { risk_surface: { gate: 'deferred' } } },
  }));
  assert.equal(JSON.stringify(withGate), JSON.stringify(bare),
    'a deferred gate moved the protected-branch decision');
  assert.equal(bare.permissionDecision, 'ask');

  // And the silent arm stays silent: a gate value cannot manufacture a rail on
  // a task branch either.
  assert.equal(guard('git commit -m "x"', project(t, 'improve/thing', {
    review: { triggers: { risk_surface: { gate: 'deferred' } } },
  })), null);
});

// --- The commit rail follows `-C` to the repository the commit lands in. ----

/** A plain git repo, not a Cadence project, on `branch`. */
function scratch(t, branch) {
  const dir = tmp(t, 'cad-guard-scratch-');
  git(['-C', dir, 'init', '-q', '-b', branch]);
  return dir;
}

test('-C into a scratch repo on main is silent, even from a project on main', (t) => {
  const s = scratch(t, 'main');
  assert.equal(guard(`git -C ${s} commit -q --allow-empty -m base`, project(t, 'main')), null);
  assert.equal(guard(`git -C "${s}" commit -m x`, project(t, 'main')), null);
  assert.equal(guard(`git -C '${s}' commit -m x`, project(t, 'main')), null);
});

test('-C into a Cadence project on main asks, from a project on a task branch', (t) => {
  const target = project(t, 'main');
  const d = guard(`git -C ${target} commit -m x`, project(t, 'improve/thing'));
  assert.equal(d.permissionDecision, 'ask');
  assert.match(d.permissionDecisionReason, /"main" is a protected branch/);
});

test('-C into a project on a task branch is silent, from a project on main', (t) => {
  const target = project(t, 'improve/thing');
  assert.equal(guard(`git -C ${target} commit -m x`, project(t, 'main')), null);
});

test('-C applies cumulatively, as git applies it', (t) => {
  const target = project(t, 'main');
  const d = guard(`git -C ${dirname(target)} -C ${target.slice(dirname(target).length + 1)} commit -m x`,
    project(t, 'improve/thing'));
  assert.equal(d.permissionDecision, 'ask');
});

test('an unresolvable -C keeps reading the session directory, and says so', (t) => {
  const d = guard('git -C "$S" commit -m x', project(t, 'main'));
  assert.equal(d.permissionDecision, 'ask');
  assert.match(d.permissionDecisionReason, /cannot tell which repository `git -C "\$S"` commits in/);
  assert.match(d.permissionDecisionReason, /"main" is a protected branch/);
  // No new prompt: the same command from a task branch stays silent, as before.
  assert.equal(guard('git -C "$S" commit -m x', project(t, 'improve/thing')), null);
  assert.equal(guard('git -C ~/x commit -m x', project(t, 'improve/thing')), null);
});

test('-C into a Cadence project is policed even from outside any project', (t) => {
  const target = project(t, 'main');
  const outside = tmp(t, 'cad-guard-outside-');
  const d = guard(`git -C ${target} commit -m x`, outside);
  assert.equal(d.permissionDecision, 'ask');
  // and a push into it is judged there too, the way the commit rail follows -C
  assert.equal(guard(`git -C ${target} push`, outside).permissionDecision, 'ask');
});

test('several commits in one command: a deny beats an ask', (t) => {
  const refuse = project(t, 'main', { git: { on_protected: 'refuse' } });
  const d = guard(`git commit -m a && git -C ${refuse} commit -m b`, project(t, 'main'));
  assert.equal(d.permissionDecision, 'deny');
});

// --- The bypass: git.guard_bypass in both config layers turns the push and commit rails off. ---

/** A user-global config file holding `text`, gone when test `t` ends. */
function globalFile(t, text) {
  const file = join(tmp(t, 'cad-guard-global-'), 'config.json');
  writeFileSync(file, text);
  return file;
}

const BYPASS = JSON.stringify({ git: { guard_bypass: true } });

test('bypass in both layers: no decision on a push or on a refused protected-branch commit', (t) => {
  const dir = project(t, 'main', { git: { guard_bypass: true, on_protected: 'refuse' } });
  const g = globalFile(t, BYPASS);
  assert.equal(guardWithGlobal('git push origin main', dir, g), null);
  assert.equal(guardWithGlobal('git commit -m x', dir, g), null);
});

test('bypass in one layer only: both rails decide as before', (t) => {
  const repoOnly = project(t, 'main', { git: { guard_bypass: true } });
  const empty = globalFile(t, '{}');
  assert.equal(guardWithGlobal('git push origin main', repoOnly, empty).permissionDecision, 'ask');
  assert.equal(guardWithGlobal('git commit -m x', repoOnly, empty).permissionDecision, 'ask');
  const globalOnly = project(t, 'main', { git: {} });
  const g = globalFile(t, BYPASS);
  assert.equal(guardWithGlobal('git push origin main', globalOnly, g).permissionDecision, 'ask');
  assert.equal(guardWithGlobal('git commit -m x', globalOnly, g).permissionDecision, 'ask');
});

test('bypass with a torn global layer: the hook decides as before', (t) => {
  const dir = project(t, 'main', { git: { guard_bypass: true } });
  const torn = globalFile(t, '{ nope');
  assert.equal(guardWithGlobal('git push origin main', dir, torn).permissionDecision, 'ask');
  assert.equal(guardWithGlobal('git commit -m x', dir, torn).permissionDecision, 'ask');
});

// --- The request and merge rails: what the bypass leaves on (E-03-2). ---------

const OPENS_AND_MERGES = ['gh pr create --fill', 'gh pr merge 5', 'glab mr create', 'glab mr merge 5',
  'tea pr create', 'tea pulls merge 3'];

test('a request opened or merged from Bash asks, with the bypass in both layers and without it', (t) => {
  const dir = project(t, 'feat', { git: { guard_bypass: true } });
  const bypassed = globalFile(t, BYPASS);
  const off = globalFile(t, '{}');
  for (const command of OPENS_AND_MERGES) {
    for (const g of [bypassed, off]) {
      const d = guardWithGlobal(command, dir, g);
      assert.equal(d && d.permissionDecision, 'ask', `${command} (${g === bypassed ? 'bypass' : 'no bypass'})`);
      assert.match(d.permissionDecisionReason, /pull or merge request/);
    }
  }
});

test('a request rail stays silent on a view, a mention, the seam, and outside a project', (t) => {
  const dir = project(t, 'main');
  for (const command of ['gh pr view 5', 'gh pr list', 'glab mr view 5', 'echo "gh pr merge"',
    'node cadence-core/bin/git-publish.mjs merge --dir . --forge github']) {
    assert.equal(guard(command, dir), null, command);
  }
  assert.equal(guard('gh pr merge 5', tmp(t, 'cad-guard-plain-')), null);
});

test('git merge onto a protected branch asks, and onto a task branch is silent', (t) => {
  const onMain = project(t, 'main');
  const d = guard('git merge feat', onMain);
  assert.equal(d.permissionDecision, 'ask');
  assert.match(d.permissionDecisionReason, /"main" is a protected branch[\s\S]*approve to merge here/);
  assert.equal(guard('git merge feat', project(t, 'feat2')), null);
});

test('git merge follows on_protected, and the bypass does not reach it while it still silences a commit', (t) => {
  const refused = project(t, 'main', { git: { on_protected: 'refuse' } });
  assert.equal(guard('git merge feat', refused).permissionDecision, 'deny');
  assert.equal(guard('git merge feat', project(t, 'main', { git: { on_protected: 'allow' } })), null);
  const dir = project(t, 'main', { git: { guard_bypass: true } });
  const g = globalFile(t, BYPASS);
  assert.equal(guardWithGlobal('git merge feat', dir, g).permissionDecision, 'ask');
  assert.equal(guardWithGlobal('git commit -m x', dir, g), null);
});

test('across the rails a deny beats an ask: a request ask does not hide a refused commit', (t) => {
  const dir = project(t, 'main', { git: { on_protected: 'refuse' } });
  assert.equal(guard('gh pr create --fill && git commit -m x', dir).permissionDecision, 'deny');
  assert.equal(guard('git push origin feat && git merge feat', dir).permissionDecision, 'deny');
});

test('git merge --abort and --quit land nothing, so a refused protected branch still lets them run; --continue is judged', (t) => {
  const dir = project(t, 'main', { git: { guard_bypass: true, on_protected: 'refuse' } });
  const g = globalFile(t, BYPASS);
  assert.equal(guardWithGlobal('git merge --abort', dir, g), null);
  assert.equal(guardWithGlobal('git merge --quit', dir, g), null);
  assert.equal(guardWithGlobal('git merge --continue', dir, g).permissionDecision, 'deny');
});

// --- The push rail asks only where a protected branch can be reached (E-03-3). ---

test('a push of a work branch or a tag is silent; one that can reach a protected branch asks', (t) => {
  const feat = project(t, 'feat');
  for (const command of ['git push -u origin feat', 'git push origin v4.5.0', 'git push origin HEAD', 'git push --tags']) {
    assert.equal(guard(command, feat), null, command);
  }
  for (const command of ['git push origin feat:main', 'git push --all', 'git push origin +feat:refs/heads/main',
    'git push origin --delete main', 'git push -o ci.skip origin feat:main']) {
    assert.equal(guard(command, feat)?.permissionDecision, 'ask', command);
  }
  const main = project(t, 'main');
  for (const command of ['git push', 'git push origin', 'git push origin HEAD']) {
    assert.equal(guard(command, main)?.permissionDecision, 'ask', command);
  }
  assert.equal(guard('git push origin feat', main), null);
});

test('a push stays quiet only on plain words: a quote, an expansion, a glob or @ in a refspec asks', (t) => {
  const feat = project(t, 'feat');
  for (const command of ['git push origin "feat:main"', "git push origin 'HEAD:main'", 'git push origin "main"',
    'git push origin refs/heads/*:refs/heads/*', 'git push origin :', 'git push origin "feat:$B"', 'git push origin $R:feat',
    'git push "--all" origin', 'git push origin "feat"', 'git push --branches', 'git push --mirr', 'git push --al origin',
    'git push origin feat:heads/main', 'git push origin heads/main', 'git push origin @:main']) {
    assert.equal(guard(command, feat)?.permissionDecision, 'ask', command);
  }
  for (const command of ['git push --no-all origin feat', 'git push origin @', 'git push --force-with-lease=feat:abc origin feat']) {
    assert.equal(guard(command, feat), null, command);
  }
});

test('a push asks when an earlier command, a global option or a -C it cannot follow can move where it lands', (t) => {
  const feat = project(t, 'feat');
  const main = project(t, 'main');
  for (const command of ['git checkout main && git push', 'git switch main && git push origin HEAD',
    'git config remote.origin.push HEAD:main && git push origin', `cd ${main} && git push`, 'npm test && git push',
    'git -C $R push origin', `git --git-dir=${main}/.git push origin HEAD`, `git --git-dir ${main}/.git push origin HEAD`,
    'git -c user.name=x push origin feat:other']) {
    assert.equal(guard(command, feat)?.permissionDecision, 'ask', command);
  }
  for (const command of ['git add -A && git commit -m "fix it" && git push', 'git pull --rebase && git push origin feat',
    `git -C ${feat} push origin feat`, 'git status; git push -u origin feat']) {
    assert.equal(guard(command, feat), null, command);
  }
});

test('a push whose destination git config picks asks when the config can send it to a protected branch', (t) => {
  const upstream = project(t, 'feat');
  git(['-C', upstream, 'config', 'push.default', 'upstream']);
  assert.match(guard('git push origin feat', upstream)?.permissionDecisionReason ?? '', /push\.default=upstream/);
  assert.equal(guard('git push', upstream)?.permissionDecision, 'ask');
  assert.equal(guard('git push origin feat:feat', upstream), null);
  const mapped = project(t, 'feat');
  git(['-C', mapped, 'config', 'remote.origin.push', 'refs/heads/feat:refs/heads/main']);
  assert.match(guard('git push -u origin feat', mapped)?.permissionDecisionReason ?? '', /remote\.origin\.push/);
  const mirror = project(t, 'feat');
  git(['-C', mirror, 'config', 'remote.origin.mirror', 'true']);
  assert.match(guard('git push origin', mirror)?.permissionDecisionReason ?? '', /remote\.origin\.mirror/);
  assert.equal(guard('git push origin feat:feat', mirror), null);
  const current = project(t, 'feat');
  git(['-C', current, 'config', 'push.default', 'current']);
  assert.equal(guard('git push', current), null);
  const plain = project(t, 'feat');
  assert.match(guard('git -c push.default=matching push origin', plain)?.permissionDecisionReason ?? '', /carries git -c/);
});

// --- The commit and merge rails read what runs before them (E-03-4). ----------

test('a commit or merge after a command that can move the branch or the repository asks', (t) => {
  const feat = project(t, 'feat');
  const main = project(t, 'main');
  for (const command of ['git switch main && git merge feat', 'git switch main && git commit -m x',
    'git checkout main; git merge feat', `cd ${main} && git commit -m x`, 'cd && git commit -m x', 'cd - && git commit -m x',
    'cd $D && git commit -m x', 'pushd x && git commit -m x', 'gh pr checkout 5 && git commit -m x']) {
    assert.equal(guard(command, feat)?.permissionDecision, 'ask', command);
  }
  assert.match(guard('git switch main && git commit -m x', feat).permissionDecisionReason, /comes after a command/);
});

test('a commit or merge after a plain cd, a stage or a read, or any other command lands where it is judged', (t) => {
  const feat = project(t, 'feat');
  const main = project(t, 'main');
  assert.equal(guard(`cd ${feat} && git commit -m x`, main), null);
  for (const command of ['set -- a && git add -A -- "$@" && git commit -m x -- "$@"', 'npm test && git merge feat2',
    'git add -A && git rm x && git commit -m y', 'git status; git diff && git commit -m x']) {
    assert.equal(guard(command, feat), null, command);
  }
  // Cadence's own record commit, shaped as agile-build.md section 8 runs it
  const record = "set -- 'a.md'\n[ -d 'b' ] && set -- \"$@\" 'b'\nfor f in c d; do [ -f \"$f\" ] && set -- \"$@\" \"$f\"; done\n"
    + 'git add -A -- "$@"\ngit commit -m "docs: record" -- "$@"';
  assert.equal(guard(record, feat), null);
  assert.equal(guard(record, main)?.permissionDecision, 'ask');
});

test('the bypass and on_protected allow turn the moved-branch ask off where they turn the rail off', (t) => {
  const dir = project(t, 'feat', { git: { guard_bypass: true } });
  const g = globalFile(t, BYPASS);
  assert.equal(guardWithGlobal('git switch main && git commit -m x', dir, g), null);
  assert.equal(guardWithGlobal('git switch main && git merge feat', dir, g)?.permissionDecision, 'ask');
  const allow = project(t, 'feat', { git: { on_protected: 'allow' } });
  assert.equal(guard('git switch main && git merge feat', allow), null);
  assert.equal(guard('git switch main && git commit -m x', tmp(t, 'cad-guard-plain-')), null);
});

test('a commit on a protected branch still asks after the push rail narrowed', (t) => {
  assert.equal(guard('git commit -m x', project(t, 'main')).permissionDecision, 'ask');
  assert.equal(guard('git commit -m x', project(t, 'feat')), null);
});

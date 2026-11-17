// Unit tests for lib/git-head.mjs (COR-01, AC4) - the ONE reader of "what
// branch is this repo on". Real git repos, hermetically configured
// (GIT_CONFIG_GLOBAL/SYSTEM=/dev/null, identity forced in the env) so the arms
// cannot depend on the developer's own git config.
//
// The load-bearing arm is the DEGRADATION one: git-guard.mjs is a PreToolUse
// hook whose last line swallows every throw, so a reader that threw would make
// the guard stop guarding in silence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCurrentBranch } from '../cadence-core/bin/lib/git-head.mjs';

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'cad', GIT_AUTHOR_EMAIL: 'cad@example.invalid',
  GIT_COMMITTER_NAME: 'cad', GIT_COMMITTER_EMAIL: 'cad@example.invalid',
};

/** A repo on `branch` with one commit, gone when test `t` ends. */
function repo(t, branch) {
  const dir = mkdtempSync(join(tmpdir(), 'cad-head-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore', env: GIT_ENV });
  git('init', '-q', '-b', branch);
  writeFileSync(join(dir, 'f.txt'), 'x');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return dir;
}

test('the checked-out branch, trimmed', (t) => {
  assert.equal(readCurrentBranch(repo(t, 'main')), 'main');
  assert.equal(readCurrentBranch(repo(t, 'cadence/v3.3.0')), 'cadence/v3.3.0');
});

test('a SUBDIRECTORY of the repo answers the same (git -C discovers upward)', (t) => {
  const dir = repo(t, 'release');
  const sub = join(dir, 'src');
  mkdirSync(sub, { recursive: true });
  assert.equal(readCurrentBranch(sub), 'release');
});

test('a directory that is NOT a git repo is "" - never a throw', (t) => {
  // The whole reason this degrades: git-guard.mjs swallows every throw, so a
  // reader that threw would make the hook silently stop guarding.
  const plain = mkdtempSync(join(tmpdir(), 'cad-head-plain-'));
  t.after(() => rmSync(plain, { recursive: true, force: true }));
  assert.equal(readCurrentBranch(plain), '');
});

test('an absent path and a repo with NO COMMITS are both ""', (t) => {
  assert.equal(readCurrentBranch('/nonexistent/cadence/definitely-not-here'), '');
  const empty = mkdtempSync(join(tmpdir(), 'cad-head-empty-'));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  execFileSync('git', ['-C', empty, 'init', '-q', '-b', 'main'], { stdio: 'ignore', env: GIT_ENV });
  assert.equal(readCurrentBranch(empty), '');
});

test('a detached HEAD answers git\'s own "HEAD", not a reinterpretation', (t) => {
  const dir = repo(t, 'main');
  execFileSync('git', ['-C', dir, 'checkout', '-q', '--detach'], { stdio: 'ignore', env: GIT_ENV });
  assert.equal(readCurrentBranch(dir), 'HEAD');
});

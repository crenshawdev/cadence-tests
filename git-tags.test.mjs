// Zero-dep tests for lib/git-tags.mjs (readTags). Run: node --test tests/git-tags.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTags } from '../cadence-core/bin/lib/git-tags.mjs';

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'cad', GIT_AUTHOR_EMAIL: 'cad@example.invalid',
  GIT_COMMITTER_NAME: 'cad', GIT_COMMITTER_EMAIL: 'cad@example.invalid',
};

/** A repo with one commit. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'cad-tags-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: GIT_ENV, maxBuffer: 64 << 20 }).trim();
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'seed');
  return { dir, git };
}

test('readTags returns every tag when the list is over 1 MiB', () => {
  const { dir, git } = repo();
  const head = git('rev-parse', 'HEAD');
  // packed-refs lines, not 6,000 `git tag` calls: long names are what pass 1 MiB
  const names = [];
  for (let i = 0; i < 6000; i++) names.push(`v${String(i).padStart(5, '0')}-${'t'.repeat(180)}`);
  appendFileSync(join(dir, '.git', 'packed-refs'), `${names.map((n) => `${head} refs/tags/${n}\n`).join('')}`);
  const listed = Buffer.byteLength(git('tag', '--list'));
  assert.ok(listed > 1024 * 1024, `fixture must pass 1 MiB, got ${listed}`);

  const tags = readTags(dir, dir);
  assert.equal(tags.length, names.length);
  assert.deepEqual(tags.slice().sort(), names.slice().sort());
});

test('readTags reads a small repo, and answers [] for a repo outside the stated root', () => {
  const { dir, git } = repo();
  git('tag', 'v1.0.0');
  assert.deepEqual(readTags(dir, dir), ['v1.0.0']);

  const inner = join(dir, 'sub');
  mkdirSync(inner);
  assert.deepEqual(readTags(inner, inner), [], 'the enclosing repo is not the project root, so its tags are not ours');
});

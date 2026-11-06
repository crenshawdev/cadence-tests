// Tests for `planning.mjs codemap scan`: every tracked path one row with its working-tree hash, and nothing the map
// writes ever reaching a commit or leaving the repository.
// Run: node --test tests/codemap-scan.test.mjs
//
// Driven through the CLI on scratch git repositories, with real git making the hashes the rows are compared against.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLANNING = join(ROOT, 'cadence-core', 'bin', 'planning.mjs');

/** A scratch repository holding `files` (path -> text), committed. */
function repo(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cad-map-'));
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', stdio: 'pipe' });
  git('init', '-q'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T');
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  return { root, git };
}

/** Runs the CLI against `dir` (default the repository's .planning) and parses its one JSON line. */
function codemap(root, sub, dir = join(root, '.planning')) {
  let stdout;
  try {
    stdout = execFileSync('node', [PLANNING, '--dir', dir, 'codemap', sub], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  } catch (e) { stdout = e.stdout; }
  return JSON.parse(stdout);
}

const index = (root) => JSON.parse(readFileSync(join(root, '.planning', 'codemap', 'index.json'), 'utf8'));
const rowOf = (root, path) => index(root).rows.filter((r) => r.path === path);
const hashOf = (text) => execFileSync('git', ['hash-object', '--stdin'], { input: text, encoding: 'utf8' }).trim();

test('every tracked path gets exactly one row, a space and non-UTF-8 bytes included', () => {
  const { root, git } = repo({ 'a.js': 'a\n', 'dir/with space.txt': 'x\n', 'dir/b.md': '# b\n' });
  writeFileSync(Buffer.concat([Buffer.from(root + '/caf'), Buffer.from([0xe9]), Buffer.from('.txt')]), 'latin\n');
  git('add', '-A');
  const r = codemap(root, 'scan');
  assert.equal(r.ok, true);
  const tracked = git('ls-files', '-z').split('\0').filter(Boolean).length;
  const rows = index(root).rows;
  assert.equal(tracked, 4);
  assert.equal(rows.length, tracked);
  assert.equal(r.files, tracked);
  assert.equal(new Set(rows.map((x) => x.path)).size, tracked, 'no spelling repeats');
  assert.equal(rowOf(root, 'dir/with space.txt').length, 1);
  const odd = rows.filter((x) => x.quoted);
  assert.deepEqual(odd.map((x) => x.path), ['"caf\\351.txt"']);
  assert.match(odd[0].hash, /^[0-9a-f]{40}/);
});

test('an unstaged edit takes the working-tree hash, not the index hash', () => {
  const { root, git } = repo({ 'a.js': 'one\n', 'b.js': 'two\n' });
  writeFileSync(join(root, 'a.js'), 'one edited\n');
  codemap(root, 'scan');
  const [a] = rowOf(root, 'a.js');
  const indexHash = git('ls-files', '-s', 'a.js').split(/\s+/)[1];
  assert.equal(a.hash, git('hash-object', 'a.js').trim());
  assert.notEqual(a.hash, indexHash);
  assert.equal(rowOf(root, 'b.js')[0].hash, git('ls-files', '-s', 'b.js').split(/\s+/)[1], 'a clean path keeps its index hash');
});

test('a path with a merge conflict is listed once, with the hash of what is on disk', () => {
  const { root, git } = repo({ 'c.txt': 'base\n' });
  const base = git('branch', '--show-current').trim();
  git('checkout', '-q', '-b', 'other'); writeFileSync(join(root, 'c.txt'), 'theirs\n'); git('commit', '-qam', 'theirs');
  git('checkout', '-q', base); writeFileSync(join(root, 'c.txt'), 'ours\n'); git('commit', '-qam', 'ours');
  assert.throws(() => git('merge', 'other'));
  assert.match(git('ls-files', '-u'), /c\.txt/);
  codemap(root, 'scan');
  const rows = rowOf(root, 'c.txt');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hash, git('hash-object', 'c.txt').trim());
});

test('a symlink gets a hash of its link text, and what it points at is never opened', () => {
  const { root, git } = repo({ 'a.js': 'a\n' });
  const fifo = join(mkdtempSync(join(tmpdir(), 'cad-map-out-')), 'pipe');
  execFileSync('mkfifo', [fifo]);
  symlinkSync('/etc/hostname', join(root, 'link'));
  git('add', 'link'); git('commit', '-qm', 'link');
  // dirty it: now it points at a pipe, and opening that would block this test until it timed out
  execFileSync('rm', [join(root, 'link')]);
  symlinkSync(fifo, join(root, 'link'));
  codemap(root, 'scan');
  const [row] = rowOf(root, 'link');
  assert.equal(row.kind, 'symlink');
  assert.equal(row.hash, hashOf(fifo));
  assert.equal(row.bytes, fifo.length);
});

test('a tracked path whose file is gone keeps its row with no hash', () => {
  const { root } = repo({ 'a.js': 'a\n', 'b.js': 'b\n' });
  execFileSync('rm', [join(root, 'b.js')]);
  const r = codemap(root, 'scan');
  assert.equal(r.missing, 1);
  assert.deepEqual(rowOf(root, 'b.js').map((x) => [x.kind, x.hash]), [['missing', null]]);
});

test('binary and over-cap files hold a hash and bytes, and the kind says why', () => {
  const { root } = repo({ 'a.js': 'a\n' });
  writeFileSync(join(root, 'img.bin'), Buffer.from([1, 2, 0, 3]));
  writeFileSync(join(root, 'big.txt'), 'x'.repeat(1024 * 1024 + 1));
  execFileSync('git', ['-C', root, 'add', '-A']);
  codemap(root, 'scan');
  const [bin] = rowOf(root, 'img.bin');
  const [big] = rowOf(root, 'big.txt');
  assert.deepEqual([bin.kind, bin.bytes], ['binary', 4]);
  assert.deepEqual([big.kind, big.bytes], ['over_cap', 1024 * 1024 + 1]);
  assert.match(big.hash, /^[0-9a-f]{40}$/);
});

test('a tracked .planning/codemap symlink is refused and its target stays empty', () => {
  const out = mkdtempSync(join(tmpdir(), 'cad-map-target-'));
  const { root } = repo({ 'a.js': 'a\n' });
  mkdirSync(join(root, '.planning'));
  symlinkSync(out, join(root, '.planning', 'codemap'));
  execFileSync('git', ['-C', root, 'add', '-f', '.planning/codemap']);
  const r = codemap(root, 'scan');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unsafe-dir');
  assert.deepEqual(readdirSync(out), []);
});

test('a directory that is not a repository answers ok:false', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cad-map-nogit-'));
  const r = codemap(dir, 'scan');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-git');
  assert.equal(existsSync(join(dir, '.planning')), false, 'nothing was written');
});

test('git add .planning never stages the map, and a nested rule is what ignores it', () => {
  const { root, git } = repo({ 'a.js': 'a\n', '.planning/STATE.md': 'state\n' });
  assert.equal(codemap(root, 'scan').ok, true);
  git('add', '.planning');
  assert.equal(git('status', '--short').split('\n').filter((l) => l.includes('.planning/codemap')).length, 0);
  assert.match(git('check-ignore', '-v', '.planning/codemap/index.json'), /\.planning\/codemap\/\.gitignore/);
  assert.equal(readFileSync(join(root, '.planning', 'codemap', '.gitignore'), 'utf8'), '*\n');
});

test('a root below the repository top level lists paths relative to itself', () => {
  const { root } = repo({ 'top.js': 't\n', 'sub/in.js': 'i\n', 'sub/deep/d.js': 'd\n' });
  const sub = join(root, 'sub');
  const r = codemap(sub, 'scan', join(sub, '.planning'));
  assert.equal(r.ok, true);
  const rows = JSON.parse(readFileSync(join(sub, '.planning', 'codemap', 'index.json'), 'utf8')).rows;
  assert.deepEqual(rows.map((x) => x.path), ['deep/d.js', 'in.js']);
});

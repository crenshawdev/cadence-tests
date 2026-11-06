// Tests for the code map's edges: a symbol's callers, a file's imports, what a test pins.
// Run: node --test tests/codemap-edges.test.mjs
//
// Driven through the CLI on scratch git repositories; the edges are read back out of index.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLANNING = join(ROOT, 'cadence-core', 'bin', 'planning.mjs');

/** A scratch repository holding `files` (path -> text), committed. */
function repo(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cad-edges-'));
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', stdio: 'pipe' });
  git('init', '-q'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T');
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  return { root, git };
}

function scan(root) {
  let stdout;
  try {
    stdout = execFileSync('node', [PLANNING, '--dir', join(root, '.planning'), 'codemap', 'scan'], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  } catch (e) { stdout = e.stdout; }
  return JSON.parse(stdout);
}

const rows = (root) => JSON.parse(readFileSync(join(root, '.planning', 'codemap', 'index.json'), 'utf8')).rows;
const rowOf = (root, path) => rows(root).find((r) => r.path === path);
const symOf = (root, path, name) => rowOf(root, path).symbols.find((s) => s.name === name);

test('a symbol used in two other files names both, never its own file, and the list is approximate', () => {
  const { root } = repo({
    'src/lib.js': 'export function shared() { return shared; }\n',
    'src/a.js': 'import { shared } from "./lib.js";\nshared();\n',
    'src/b.js': 'const x = shared;\n',
    'src/c.js': 'const unrelated = 1;\n',
  });
  assert.equal(scan(root).ok, true);
  assert.deepEqual(symOf(root, 'src/lib.js', 'shared').callers, { files: ['src/a.js', 'src/b.js'], total: 2, approximate: true });
});

test('a word inside a longer word is no caller, and a symbol nobody uses has no callers', () => {
  const { root } = repo({
    'src/lib.js': 'export function foo() {}\nexport function lonely() {}\n',
    'src/a.js': 'const foobar = 1; const barfoo = 2; foo_ = 3;\n',
  });
  scan(root);
  assert.equal(symOf(root, 'src/lib.js', 'foo').callers, undefined);
  assert.equal(symOf(root, 'src/lib.js', 'lonely').callers, undefined);
  writeFileSync(join(root, 'src/a.js'), 'foo(1);\n');
  scan(root);
  assert.deepEqual(symOf(root, 'src/lib.js', 'foo').callers.files, ['src/a.js']);
});

test('a symbol used in 12 files keeps 10 and the count 12', () => {
  const files = { 'src/lib.js': 'export function popular() {}\n' };
  for (let i = 0; i < 12; i++) files[`src/u${String(i).padStart(2, '0')}.js`] = 'popular();\n';
  const { root } = repo(files);
  scan(root);
  const c = symOf(root, 'src/lib.js', 'popular').callers;
  assert.equal(c.files.length, 10);
  assert.equal(c.total, 12);
  assert.deepEqual(c.files, Object.keys(files).filter((p) => p !== 'src/lib.js').slice(0, 10));
});

test('twelve .planning files do not crowd the one source file out of the ten, and all thirteen are counted', () => {
  const files = { 'src/lib.js': 'export function tracked() {}\n', 'src/user.js': 'tracked();\n' };
  for (let i = 0; i < 12; i++) files[`.planning/notes/n${String(i).padStart(2, '0')}.md`] = 'the tracked call\n';
  const { root } = repo(files);
  scan(root);
  const c = symOf(root, 'src/lib.js', 'tracked').callers;
  assert.equal(c.total, 13);
  assert.equal(c.files.length, 10);
  assert.equal(c.files[0], 'src/user.js', 'code comes first');
  assert.ok(c.files.slice(1).every((p) => p.startsWith('.planning/')));
});

test('code files come before other text, each in path order', () => {
  const { root } = repo({
    'src/lib.js': 'export function ranked() {}\n',
    'a.txt': 'ranked\n', 'docs/z.md': 'ranked\n', 'src/z.py': 'ranked = 1\n', 'src/b.js': 'ranked();\n',
  });
  scan(root);
  assert.deepEqual(symOf(root, 'src/lib.js', 'ranked').callers.files, ['src/b.js', 'src/z.py', 'a.txt', 'docs/z.md']);
});

test('a quoted (non-UTF-8) path is read as a caller', () => {
  const { root, git } = repo({ 'src/lib.js': 'export function viaOdd() {}\n' });
  writeFileSync(Buffer.concat([Buffer.from(`${root}/caf`), Buffer.from([0xe9]), Buffer.from('.js')]), 'viaOdd();\n');
  git('add', '-A');
  scan(root);
  assert.deepEqual(symOf(root, 'src/lib.js', 'viaOdd').callers.files, ['"caf\\351.js"']);
});

test('the edges file spawns no search process, and a fresh clone of this repository scans in under 5 s', () => {
  const src = readFileSync(join(ROOT, 'cadence-core', 'bin', 'lib', 'codemap-edges.mjs'), 'utf8');
  assert.equal(src.split('\n').filter((l) => /git.*grep/.test(l)).length, 0);
  assert.doesNotMatch(src, /child_process/);
  const dest = mkdtempSync(join(tmpdir(), 'cad-edges-clone-'));
  execFileSync('git', ['clone', '-q', ROOT, join(dest, 'c')], { stdio: 'pipe' });
  const t = Date.now();
  const r = scan(join(dest, 'c'));
  assert.equal(r.ok, true);
  assert.ok(Date.now() - t < 5000, `scan took ${Date.now() - t} ms`);
});

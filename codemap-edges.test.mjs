// Tests for the code map's edges: a symbol's callers, a file's imports, what a test pins.
// Run: node --test tests/codemap-edges.test.mjs
//
// Driven through the CLI on scratch git repositories; the edges are read back out of index.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
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

const importsOf = (root, path) => rowOf(root, path).imports;

test('a JS relative import resolves to its tracked path, a bare package keeps its text, and both are approximate', () => {
  const { root } = repo({
    'src/main.js': [
      "import { a } from './lib/a.js';",
      "import b from './lib';",
      "import './side';",
      "import ts from './typed.js';",
      "import fs from 'node:fs';",
      "import gone from './gone.js';",
      "import { c,",
      "  d } from",
      "  '../up.js';",
      "} from '../multi.js';",
      "const e = require('./lib/a.js');",
      "const f = await import('lodash');",
      "const out = require('../../outside.js');",
    ].join('\n'),
    'src/lib/a.js': 'export const a = 1;\n',
    'src/lib/index.js': 'export const idx = 1;\n',
    'src/side.js': 'export const s = 1;\n',
    'src/typed.ts': 'export const t = 1;\n',
    'up.js': 'export const u = 1;\n',
  });
  scan(root);
  const imp = importsOf(root, 'src/main.js');
  assert.equal(imp.approximate, true);
  assert.deepEqual(imp.items, [
    { path: 'src/lib/a.js' }, { path: 'src/lib/index.js' }, { path: 'src/side.js' }, { path: 'src/typed.ts' },
    { text: 'node:fs' }, { text: './gone.js' }, { text: '../multi.js' }, { text: 'lodash' }, { text: '../../outside.js' },
  ]);
});

test('a Rust use, a Python from-import and a Go import block each give a row', () => {
  const { root } = repo({
    'src/lib.rs': 'use std::collections::HashMap;\npub(crate) use crate::util::{a, b};\nuse serde::\n',
    'app/main.py': 'from pkg.mod import thing\nimport os, sys as system\nfrom . import sibling\n# import commented\n',
    'cmd/main.go': 'package main\n\nimport "fmt"\nimport (\n\t"os"\n\tlog "github.com/x/log"\n\t_ "embed"\n)\n\nfunc main() {}\n',
  });
  scan(root);
  assert.deepEqual(importsOf(root, 'src/lib.rs'), { items: [{ text: 'std::collections::HashMap' }, { text: 'crate::util' }, { text: 'serde' }], approximate: true });
  assert.deepEqual(importsOf(root, 'app/main.py'), { items: [{ text: 'pkg.mod' }, { text: 'os' }, { text: 'sys' }, { text: '.' }], approximate: true });
  assert.deepEqual(importsOf(root, 'cmd/main.go'), { items: [{ text: 'fmt' }, { text: 'os' }, { text: 'github.com/x/log' }, { text: 'embed' }], approximate: true });
});

test('a file with no import has no imports key, and a long whitespace run or colon run costs a scan no extra time', () => {
  const pad = ' '.repeat(1900);
  const bad = [];
  for (let i = 0; i < 400; i++) bad.push(`import${pad}x `, `from${pad}import${pad}`, `use ${':'.repeat(1900)}`, `require${pad}(${pad}`, `export ${pad}from${pad}x`);
  const { root } = repo({ 'a.js': 'const x = 1;\n', 'b.js': bad.join('\n'), 'c.py': bad.join('\n'), 'd.rs': bad.join('\n'), 'e.go': `import (\n${bad.join('\n')}\n)\n` });
  const t = Date.now();
  assert.equal(scan(root).ok, true);
  assert.ok(Date.now() - t < 5000, `scan took ${Date.now() - t} ms`);
  assert.equal(rowOf(root, 'a.js').imports, undefined);
});

const { isTestPath } = await import(join(ROOT, 'cadence-core', 'bin', 'lib', 'codemap-edges.mjs'));

test('the test-path rule: its directories and its name forms, and a name that only ends like one', () => {
  const yes = ['tests/a.js', 'test/a.js', 'src/__tests__/a.js', 'pkg/spec/a.rb', 'a.test.js', 'a.spec.ts', 'x/a_test.go',
    'test_a.py', 'x/a_test.py', 'x/b.test.d.ts', '"tests/caf\\351.js"'];
  const no = ['contest.py', 'src/latest.js', 'src/testing/a.js', 'src/a_test.rs', 'testfile.py', 'src/spec.js', 'a.test', 'src/inspect/a.js', 'tests.js'];
  for (const p of yes) assert.equal(isTestPath(p), true, p);
  for (const p of no) assert.equal(isTestPath(p), false, p);
});

/** An outer repository with `tests/` gitignored and a real clone in it. */
function withClone(outer, clone) {
  const src = repo(clone);
  const { root, git } = repo({ '.gitignore': 'tests/\n', ...outer });
  execFileSync('git', ['clone', '-q', src.root, join(root, 'tests')], { stdio: 'pipe' });
  return { root, git, clone: join(root, 'tests') };
}
const idx = (root) => JSON.parse(readFileSync(join(root, '.planning', 'codemap', 'index.json'), 'utf8'));

test('a test in the nested clone pins the file whose hyphenated stem it names and the symbol it holds', () => {
  const { root, clone } = withClone(
    { 'src/some-seam.mjs': 'export function seamFn() {}\nexport function other() {}\n', 'src/plain.mjs': 'export function plainFn() {}\n' },
    { 'some-seam.test.mjs': "import '../src/some-seam.mjs';\n", 'calls.test.mjs': 'seamFn();\n', 'unrelated.test.mjs': 'const x = 1;\n' });
  writeFileSync(join(clone, 'untracked.test.mjs'), "import '../src/some-seam.mjs'; seamFn();\n");
  assert.equal(scan(root).ok, true);
  assert.deepEqual(rowOf(root, 'src/some-seam.mjs').pinned_by,
    { files: ['tests/some-seam.test.mjs'], total: 1, approximate: true });
  assert.deepEqual(symOf(root, 'src/some-seam.mjs', 'seamFn').pinned_by, { files: ['tests/calls.test.mjs'], total: 1, approximate: true });
  assert.equal(symOf(root, 'src/some-seam.mjs', 'other').pinned_by, undefined);
  assert.equal(symOf(root, 'src/some-seam.mjs', 'seamFn').callers, undefined, 'a test is never a caller');
  assert.equal(rowOf(root, 'src/plain.mjs').pinned_by, undefined);
  const i = idx(root);
  assert.deepEqual(i.nested_paths, ['tests/calls.test.mjs', 'tests/some-seam.test.mjs', 'tests/unrelated.test.mjs']);
  assert.ok(i.modules.every((m) => m.paths.every((p) => !p.startsWith('tests/'))), 'no clone path is in any module');
  assert.ok(i.rows.every((r) => !r.path.startsWith('tests/')));
});

test('a symlink named tests is not followed, and a nested .git git cannot read still scans', () => {
  const src = repo({ 'a.test.mjs': 'seamFn();\n' });
  const a = repo({ '.gitignore': 'tests/\n', 'src/x.mjs': 'export function seamFn() {}\n' });
  symlinkSync(src.root, join(a.root, 'tests'));
  assert.equal(scan(a.root).ok, true);
  assert.deepEqual(idx(a.root).nested_paths, []);
  assert.equal(symOf(a.root, 'src/x.mjs', 'seamFn').pinned_by, undefined);

  const b = repo({ '.gitignore': 'tests/\n', 'src/x.mjs': 'export function seamFn() {}\n' });
  mkdirSync(join(b.root, 'tests'));
  writeFileSync(join(b.root, 'tests', 'a.test.mjs'), 'seamFn();\n');
  writeFileSync(join(b.root, 'tests', '.git'), 'not a gitdir pointer\n');
  assert.equal(scan(b.root).ok, true);
  assert.deepEqual(idx(b.root).nested_paths, []);
  assert.equal(symOf(b.root, 'src/x.mjs', 'seamFn').pinned_by, undefined);
});

test('a tests directory the outer repository tracks is a fact of its own, and no clone', () => {
  const { root } = repo({ 'src/x.mjs': 'export function seamFn() {}\n', 'tests/a.test.mjs': 'seamFn();\n' });
  execFileSync('git', ['-C', join(root, 'tests'), 'init', '-q']);
  assert.equal(scan(root).ok, true);
  assert.deepEqual(idx(root).nested_paths, []);
  assert.deepEqual(symOf(root, 'src/x.mjs', 'seamFn').pinned_by, { files: ['tests/a.test.mjs'], total: 1, approximate: true });
});

test('a tracked foo.test.mjs pins and is no caller, and a Rust file holding cfg(test) pins itself', () => {
  const { root } = repo({
    'src/foo.mjs': 'export function fooFn() {}\n',
    'src/foo.test.mjs': "import { fooFn } from './foo.mjs';\nfooFn();\n",
    'src/user.mjs': 'fooFn();\n',
    'src/lib.rs': 'pub fn run() {}\n#[cfg(test)]\nmod tests {}\n',
    'src/plain.rs': 'pub fn quiet() {}\n',
  });
  scan(root);
  assert.deepEqual(symOf(root, 'src/foo.mjs', 'fooFn').callers.files, ['src/user.mjs']);
  assert.deepEqual(symOf(root, 'src/foo.mjs', 'fooFn').pinned_by.files, ['src/foo.test.mjs']);
  assert.deepEqual(rowOf(root, 'src/foo.mjs').pinned_by.files, ['src/foo.test.mjs']);
  assert.deepEqual(rowOf(root, 'src/lib.rs').pinned_by, { files: ['src/lib.rs'], total: 1, approximate: true });
  assert.equal(rowOf(root, 'src/plain.rs').pinned_by, undefined);
});

test('a generic stem named by more tests than the cap comes back approximate with the true count', () => {
  const files = { 'src/index.js': 'export const x = 1;\n' };
  for (let i = 0; i < 12; i++) files[`spec/t${String(i).padStart(2, '0')}.test.js`] = 'run the index here\n';
  const { root } = repo(files);
  scan(root);
  const p = rowOf(root, 'src/index.js').pinned_by;
  assert.equal(p.approximate, true);
  assert.equal(p.total, 12);
  assert.equal(p.files.length, 10);
});

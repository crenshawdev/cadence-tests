// Tests for the code map's edges: a symbol's callers, a file's imports, what a test pins.
// Run: node --test tests/codemap-edges.test.mjs
//
// Driven through the CLI on scratch git repositories; the edges are read back out of index.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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

const rows = (root) => JSON.parse(readFileSync(join(root, '.planning', 'records', 'codemap', 'index.json'), 'utf8')).rows;
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
const idx = (root) => JSON.parse(readFileSync(join(root, '.planning', 'records', 'codemap', 'index.json'), 'utf8'));

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

/** One CLI call on `codemap`, parsed; `env` adds to the environment. */
function cli(root, args, env = {}) {
  let out;
  try {
    out = execFileSync('node', [PLANNING, '--dir', join(root, '.planning'), 'codemap', ...args], { cwd: root, encoding: 'utf8', stdio: 'pipe', maxBuffer: 1 << 28, env: { ...process.env, ...env } });
  } catch (e) { out = e.stdout; }
  return JSON.parse(out);
}

test('an index that would pass 128 MiB sheds its edges, says so, and status and slice still answer', () => {
  // 16 files declare the same names, 10 callers and 10 specs sit under ~3,200 B paths: ten of each per symbol is 64 KB a symbol
  const names = Array.from({ length: 140 }, (_, i) => `sym${i}`);
  const deep = (tag) => [`${tag}${'d'.repeat(250 - tag.length)}`, ...'efghijklmno'.split('').map((c) => c.repeat(250)), 'p'.repeat(200)].join('/');
  const files = {};
  for (let i = 0; i < 16; i++) files[`def${i}.js`] = `${names.map((n) => `export function ${n}() {}`).join('\n')}\n`;
  for (let i = 0; i < 10; i++) files[`${deep(`a${i}`)}/c.js`] = `${names.join(';')};\n`;
  for (let i = 0; i < 10; i++) files[`spec/${deep(`b${i}`)}/s.test.js`] = `${names.join(';')};\n`;
  const { root } = repo(files);
  const r = cli(root, ['scan']);
  assert.equal(r.ok, true);
  assert.equal(r.edges_shed, true);
  assert.equal(r.symbols_shed, undefined);
  const file = join(root, '.planning', 'records', 'codemap', 'index.json');
  assert.ok(statSync(file).size < 128 * 1024 * 1024);
  const i = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(i.edges_shed, true);
  assert.ok(i.rows.every((x) => !x.pinned_by && !x.imports && (x.symbols || []).every((s) => !s.callers && !s.pinned_by)));
  assert.equal(rowOf(root, 'def0.js').symbols.length, 140, 'the symbols stayed');
  assert.equal(cli(root, ['status']).ok, true);
  const s = cli(root, ['slice', '--files', 'def0.js']);
  assert.equal(s.ok, true);
  assert.equal(s.edges_shed, true, 'a row with no callers is not read as unused');
  assert.equal(s.rows[0].path, 'def0.js');
});

test('a name or stem held by more than 100 files keeps its edges, with its own file out of each list', () => {
  const mk = (n) => {
    const files = { 'src/user.js': 'run();\n', 'spec/index.test.js': 'run();\n// index\n' };
    for (let i = 0; i < n; i++) files[`pkg${String(i).padStart(3, '0')}/index.js`] = 'export function run() {}\n';
    const { root } = repo(files);
    assert.equal(scan(root).ok, true);
    return root;
  };
  const many = mk(101);
  for (const [pkg, listed] of [['pkg000', 9], ['pkg050', 10]]) {
    const c = symOf(many, `${pkg}/index.js`, 'run').callers;
    assert.equal(c.approximate, true);
    assert.equal(c.total, 101, '100 other holders and src/user.js');
    assert.equal(c.files.length, listed);
    assert.ok(!c.files.includes(`${pkg}/index.js`), 'never its own caller');
    assert.deepEqual(symOf(many, `${pkg}/index.js`, 'run').pinned_by, { files: ['spec/index.test.js'], total: 1, approximate: true });
    assert.deepEqual(rowOf(many, `${pkg}/index.js`).pinned_by, { files: ['spec/index.test.js'], total: 1, approximate: true });
  }
  const few = mk(100);
  assert.equal(symOf(few, 'pkg000/index.js', 'run').callers.total, 100);
  assert.deepEqual(rowOf(few, 'pkg000/index.js').pinned_by.files, ['spec/index.test.js']);
  // a name is counted by files: one file declaring `handle` 101 times does not take it from an unrelated file
  const gen = repo({ 'gen/x.py': 'def handle():\n  pass\n'.repeat(101), 'src/real.py': 'def handle():\n  pass\n', 'src/c.py': 'handle()\n' });
  scan(gen.root);
  assert.equal(symOf(gen.root, 'src/real.py', 'handle').callers.total, 2);
});

test('a nested clone of 400 text files of 1,000,000 B scans within a 256 MiB heap', () => {
  const { root } = repo({ '.gitignore': 'tests/\n', 'src/a.mjs': 'export function a() {}\n' });
  const clone = join(root, 'tests');
  mkdirSync(clone);
  execFileSync('git', ['-C', clone, 'init', '-q']);
  const one = join(clone, 'f000.test.mjs');
  writeFileSync(one, 'abcdefghi '.repeat(100000));
  const sha = execFileSync('git', ['-C', clone, 'hash-object', '-w', one], { encoding: 'utf8' }).trim();
  const lines = [];
  for (let i = 0; i < 400; i++) {
    const name = `f${String(i).padStart(3, '0')}.test.mjs`;
    if (i) linkSync(one, join(clone, name));
    lines.push(`100644 ${sha}\t${name}`);
  }
  execFileSync('git', ['-C', clone, 'update-index', '--add', '--index-info'], { input: `${lines.join('\n')}\n` });
  const r = cli(root, ['scan'], { NODE_OPTIONS: '--max-old-space-size=256' });
  assert.equal(r.ok, true);
  assert.equal(JSON.parse(readFileSync(join(root, '.planning', 'records', 'codemap', 'index.json'), 'utf8')).nested_paths.length, 400);
});

test('. .. ./ ../ and a trailing slash resolve to the directory\'s index', () => {
  const { root } = repo({
    'a/index.js': 'export const a = 1;\n', 'lib/index.ts': 'export const l = 1;\n', 'index.js': 'export const top = 1;\n',
    'a/b.js': "import x from '.';\n", 'a/b2.js': "import x from './';\n",
    'a/c/d.ts': "import x from '..';\n", 'a/c/d2.ts': "import x from '../';\n",
    'e.js': "import x from './lib/';\nimport y from './lib';\n", 'f.js': "import x from '.';\n", 'g.js': "import x from '..';\nimport y from 'lib/';\n",
  });
  scan(root);
  for (const p of ['a/b.js', 'a/b2.js']) assert.deepEqual(importsOf(root, p).items, [{ path: 'a/index.js' }], p);
  for (const p of ['a/c/d.ts', 'a/c/d2.ts']) assert.deepEqual(importsOf(root, p).items, [{ path: 'a/index.js' }], p);
  assert.deepEqual(importsOf(root, 'e.js').items, [{ path: 'lib/index.ts' }]);
  assert.deepEqual(importsOf(root, 'f.js').items, [{ path: 'index.js' }]);
  assert.deepEqual(importsOf(root, 'g.js').items, [{ text: '..' }, { text: 'lib/' }], 'out of the repository, and not relative');
});

test('a non-ASCII letter makes a word, so fooébar is no caller of foo and a test naming ../données.py pins it', () => {
  const { root } = repo({
    'src/lib.mjs': 'export function foo() {}\n', 'src/other.mjs': 'const fooébar = 1;\n', 'src/données.py': 'x = 1\n',
    'spec/a.test.mjs': "import '../données.py';\n", 'spec/b.test.mjs': 'const fooébar = 2;\n',
  });
  scan(root);
  assert.equal(symOf(root, 'src/lib.mjs', 'foo').callers, undefined);
  assert.equal(symOf(root, 'src/lib.mjs', 'foo').pinned_by, undefined);
  assert.deepEqual(rowOf(root, 'src/données.py').pinned_by, { files: ['spec/a.test.mjs'], total: 1, approximate: true });
});

test('an importer whose name is quoted still resolves its relative import, in a quoted directory too', () => {
  const { root, git } = repo({ 'src/dep.mjs': 'export const d = 1;\n' });
  const put = (name, text) => {
    const rel = Buffer.from(name, 'latin1');
    mkdirSync(Buffer.concat([Buffer.from(`${root}/`), rel.subarray(0, rel.lastIndexOf('/'))]), { recursive: true });
    writeFileSync(Buffer.concat([Buffer.from(`${root}/`), rel]), text);
  };
  put('src/\xff.mjs', "import './dep.mjs';\n");
  put('d\xe9/x.mjs', "import './dep.mjs';\n");
  put('d\xe9/dep.mjs', 'export const e = 1;\n');
  git('add', '-A');
  scan(root);
  assert.deepEqual(importsOf(root, '"src/\\377.mjs"').items, [{ path: 'src/dep.mjs' }]);
  assert.deepEqual(importsOf(root, '"d\\351/x.mjs"').items, [{ path: '"d\\351/dep.mjs"' }]);
});

test('a name with a non-ASCII letter is held whole, with its caller and its pin', () => {
  const { root } = repo({
    'src/a.js': 'export function créer() {}\nconst alpha = 1;\nexport { alpha as ünï };\n', 'src/b.js': 'créer();\n', 'spec/a.test.js': 'créer; ünï;\n',
    'src/c.py': 'def défaut():\n  pass\n', 'src/d.py': 'défaut()\n',
  });
  scan(root);
  assert.ok(rowOf(root, 'src/a.js').symbols.some((s) => s.name === 'créer'));
  assert.ok(!rowOf(root, 'src/a.js').symbols.some((s) => s.name === 'cr'));
  assert.deepEqual(symOf(root, 'src/a.js', 'créer').callers, { files: ['src/b.js'], total: 1, approximate: true });
  assert.deepEqual(symOf(root, 'src/a.js', 'créer').pinned_by, { files: ['spec/a.test.js'], total: 1, approximate: true });
  assert.deepEqual(symOf(root, 'src/a.js', 'ünï').pinned_by, { files: ['spec/a.test.js'], total: 1, approximate: true });
  assert.deepEqual(symOf(root, 'src/c.py', 'défaut').callers, { files: ['src/d.py'], total: 1, approximate: true });
});

test('101 files declaring créer give every holder a total of the other 100 and the one caller', () => {
  const files = { 'src/user.js': 'créer();\n' };
  for (let i = 0; i < 101; i++) files[`pkg${String(i).padStart(3, '0')}/x.js`] = 'export function créer() {}\n';
  const { root } = repo(files);
  assert.equal(scan(root).ok, true);
  for (const pkg of ['pkg000', 'pkg100']) {
    const c = symOf(root, `${pkg}/x.js`, 'créer').callers;
    assert.equal(c.total, 101);
    assert.ok(!c.files.includes(`${pkg}/x.js`));
  }
});

test('101 files declaring a 250-character name give no negative total and no empty list', () => {
  const name = 'n'.repeat(250);
  const files = {};
  for (let i = 0; i < 101; i++) files[`pkg${String(i).padStart(3, '0')}/x.js`] = `export function ${name}() {}\n`;
  const { root } = repo(files);
  assert.equal(scan(root).ok, true);
  for (const pkg of ['pkg000', 'pkg100']) {
    const s = symOf(root, `${pkg}/x.js`, name);
    assert.ok(s, 'the symbol is kept');
    assert.equal(s.callers, undefined);
    assert.equal(s.pinned_by, undefined);
  }
});

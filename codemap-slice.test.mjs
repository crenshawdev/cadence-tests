// Tests for `planning.mjs codemap slice`: only the rows asked for, within 10,000 bytes, with the stale ones marked.
// Run: node --test tests/codemap-slice.test.mjs
//
// Driven through the CLI on scratch git repositories, scanned first; entries are written the way Plan 4's write will.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLANNING = join(ROOT, 'cadence-core', 'bin', 'planning.mjs');
const { entryFile } = await import(join(ROOT, 'cadence-core', 'bin', 'lib', 'codemap-partition.mjs'));
const { slice: sliceOf } = await import(join(ROOT, 'cadence-core', 'bin', 'lib', 'codemap-slice.mjs'));

function repo(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cad-slice-'));
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', stdio: 'pipe' });
  git('init', '-q'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T');
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  return { root, git };
}

/** One CLI call: the raw stdout and its parse. */
function run(root, ...args) {
  let out;
  try {
    out = execFileSync('node', [PLANNING, '--dir', join(root, '.planning'), 'codemap', ...args], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  } catch (e) { out = e.stdout; }
  return { out, json: JSON.parse(out) };
}
const slice = (root, ...args) => run(root, 'slice', ...args);
const scan = (root) => run(root, 'scan').json;
const index = (root) => JSON.parse(readFileSync(join(root, '.planning', 'codemap', 'index.json'), 'utf8'));
const size = (out) => Buffer.byteLength(out);

/** Writes `entry` for the module holding `path`, built from the hashes the index holds now. */
function build(root, path, entry = {}) {
  const i = index(root);
  const m = i.modules.find((x) => x.paths.includes(path));
  const built_from = Object.fromEntries(m.paths.map((p) => [p, i.rows.find((r) => r.path === p).hash]));
  const file = join(root, '.planning', 'codemap', entryFile(m.name));
  writeFileSync(file, JSON.stringify({ built_from, ...entry }));
  return m.name;
}
const big = (n = 130 * 1024) => `${'x'.repeat(80)}\n`.repeat(Math.ceil(n / 81));

test('--files returns that row and no other, with total and truncated', () => {
  const { root } = repo({ 'a.js': 'export function alpha() {}\n', 'b.js': 'export function beta() {}\n', 'c.md': '# c\n' });
  scan(root);
  const r = slice(root, '--files', 'a.js').json;
  assert.equal(r.ok, true);
  assert.deepEqual(r.rows.map((x) => x.path), ['a.js']);
  assert.equal(r.total, 1);
  assert.equal(r.truncated, false);
  assert.equal(r.rows[0].kind, 'text');
  assert.equal(r.rows[0].symbols[0].name, 'alpha');
  assert.equal(slice(root, '--files', 'a.js,c.md').json.total, 2);
  assert.equal(slice(root, '--files', 'nothing.js').json.total, 0);
  assert.equal(slice(root, '--files', 'a').json.total, 0, 'a file name matches exactly');
});

test('--symbols returns the files holding the symbol, exactly', () => {
  const { root } = repo({ 'a.js': 'export function shared() {}\n', 'b.py': 'def shared():\n  pass\n', 'c.js': 'export function sharedX() {}\n' });
  scan(root);
  assert.deepEqual(slice(root, '--symbols', 'shared').json.rows.map((x) => x.path), ['a.js', 'b.py']);
});

test('--terms finds a word in a path, a symbol name, and a built module entry, in any case', () => {
  const { root } = repo({ 'src/Widget.js': 'export function render() {}\n', 'lib/other.js': 'export function Gadget() {}\n', 'lib/quiet.js': 'const q = 1;\n', 'big/x.txt': big() });
  scan(root);
  build(root, 'big/x.txt', { summary: 'Holds the Zebra table' });
  assert.deepEqual(slice(root, '--terms', 'widget').json.rows.map((x) => x.path), ['src/Widget.js']);
  assert.deepEqual(slice(root, '--terms', 'GADGET').json.rows.map((x) => x.path), ['lib/other.js']);
  const e = slice(root, '--terms', 'zebra').json;
  assert.deepEqual(e.rows.map((x) => x.path), ['big/x.txt']);
  assert.equal(e.entries[e.rows[0].module].summary, 'Holds the Zebra table');
  assert.equal('built_from' in e.entries[e.rows[0].module], false);
});

test('a call naming no selector is refused, and so is a missing map', () => {
  const { root } = repo({ 'a.js': 'x\n' });
  scan(root);
  for (const args of [[], ['--files', ',']]) {
    const r = slice(root, ...args).json;
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'usage');
  }
  assert.equal(slice(root, '--terms', ' ').json.ok, false, 'a blank list is refused at the door');
  assert.equal(slice(root, '--files').json.ok, false, 'a bare flag is no list');
  const bare = repo({ 'a.js': 'x\n' });
  const none = slice(bare.root, '--files', 'a.js').json;
  assert.equal(none.ok, false);
  assert.equal(none.reason, 'no-index');
  assert.match(none.hint, /codemap scan/);
});

test('a stale module marks its rows and a built one does not, and an entry rides once', () => {
  const { root } = repo({ 'small/a.js': 'export function a() {}\n', 'small/b.js': 'export function b() {}\n', 'big/x.txt': big() });
  scan(root);
  const small = build(root, 'small/a.js', { summary: 'small module' });
  build(root, 'big/x.txt', { summary: 'big module' });
  const fresh = slice(root, '--files', 'small/a.js,small/b.js,big/x.txt').json;
  assert.ok(fresh.rows.every((x) => !('stale' in x)));
  assert.equal(Object.keys(fresh.entries).length, 2);
  assert.equal(Object.entries(fresh.entries).filter(([name]) => name === small).length, 1, 'once for two rows');
  writeFileSync(join(root, 'small', 'b.js'), 'export function b() { return 1; }\n');
  const r = slice(root, '--files', 'small/a.js,small/b.js,big/x.txt').json;
  assert.deepEqual(r.rows.map((x) => [x.path, x.stale === true]), [['big/x.txt', false], ['small/a.js', true], ['small/b.js', true]]);
});

test('500 matching rows print at or under 10,000 bytes, truncated, with the true total', () => {
  const files = {};
  for (let i = 0; i < 500; i++) files[`pkg/row-${String(i).padStart(3, '0')}.js`] = `export function fn${i}() {}\n`;
  const { root } = repo(files);
  scan(root);
  const { out, json } = slice(root, '--terms', 'row-');
  assert.ok(size(out) <= 10000, `${size(out)} B`);
  assert.equal(json.total, 500);
  assert.equal(json.truncated, true);
  assert.ok(json.rows.length > 0 && json.rows.length < 500);
  assert.equal(json.rows[0].path, 'pkg/row-000.js');
});

test('a row past D-20\'s 22,998 B keeps its path and sheds callers before symbols', () => {
  const names = Array.from({ length: 100 }, (_, i) => `symbolNumber${String(i).padStart(3, '0')}`);
  const files = { 'src/heavy.js': names.map((n) => `export function ${n}() {}`).join('\n') + '\n' };
  for (let u = 0; u < 12; u++) files[`src/user${String(u).padStart(2, '0')}.js`] = `${names.join(';')};\n`;
  const { root } = repo(files);
  scan(root);
  const full = index(root).rows.find((r) => r.path === 'src/heavy.js');
  assert.ok(Buffer.byteLength(JSON.stringify(full)) > 22998, 'the fixture row is past the measured maximum');
  const { out, json } = slice(root, '--files', 'src/heavy.js');
  assert.ok(size(out) <= 10000, `${size(out)} B`);
  assert.equal(json.truncated, true);
  assert.equal(json.total, 1);
  const row = json.rows[0];
  assert.equal(row.path, 'src/heavy.js');
  assert.equal(row.symbols.length, 100, 'every symbol survived');
  assert.ok(row.symbols.every((s) => !('callers' in s)), 'callers went first');
});

test('multi-byte paths are counted in bytes', () => {
  const files = {};
  for (let i = 0; i < 300; i++) files[`日本語のディレクトリ/ファイル名${String(i).padStart(3, '0')}.txt`] = 'x\n';
  const { root } = repo(files);
  scan(root);
  const { out, json } = slice(root, '--terms', 'ファイル名');
  assert.ok(size(out) <= 10000, `${size(out)} B`);
  assert.ok(out.length < size(out), 'the fixture really has characters wider than a byte');
  assert.equal(json.truncated, true);
  assert.equal(json.total, 300);
});

test('an entry past the bound is left out whole and named, and so are those that do not fit together', () => {
  const { root } = repo({ 'one/a.txt': big(), 'two/b.txt': big(), 'three/c.txt': big(), 'four/d.txt': big() });
  scan(root);
  build(root, 'one/a.txt', { summary: 'y'.repeat(11000) });
  const one = slice(root, '--files', 'one/a.txt');
  assert.ok(size(one.out) <= 10000);
  assert.equal(one.json.truncated, true);
  assert.deepEqual(one.json.rows.map((x) => x.path), ['one/a.txt']);
  assert.equal(one.json.entries, undefined);
  assert.equal(one.json.entries_omitted.length, 1);
  assert.ok(existsSync(join(root, one.json.entries_omitted[0].file)), 'the named file exists');

  for (const p of ['two/b.txt', 'three/c.txt', 'four/d.txt']) build(root, p, { summary: p[0].repeat(4000) });
  const three = slice(root, '--files', 'two/b.txt,three/c.txt,four/d.txt');
  assert.ok(size(three.out) <= 10000, `${size(three.out)} B`);
  assert.equal(three.json.truncated, true);
  assert.equal(three.json.rows.length, 3, 'rows keep their paths');
  const kept = Object.keys(three.json.entries || {});
  assert.equal(kept.length + three.json.entries_omitted.length, 3);
  assert.ok(three.json.entries_omitted.length >= 1);
  for (const o of three.json.entries_omitted) assert.ok(existsSync(join(root, o.file)));
});

test('two calls print identical bytes', () => {
  const files = {};
  for (let i = 0; i < 80; i++) files[`pkg/m${String(i).padStart(2, '0')}.js`] = `export function f${i}() {}\nf${(i + 1) % 80}();\n`;
  const { root } = repo(files);
  scan(root);
  assert.equal(slice(root, '--terms', 'm').out, slice(root, '--terms', 'm').out);
});

test('twenty entries with 600 B module names still print at or under 10,000 bytes', () => {
  const files = {};
  for (let i = 0; i < 20; i++) files[`mod${String(i).padStart(2, '0')}${'a'.repeat(245)}/${'b'.repeat(250)}/${'c'.repeat(90)}/x.txt`] = big();
  const { root } = repo(files);
  scan(root);
  for (const p of Object.keys(files)) build(root, p, { summary: 'y'.repeat(12000) });
  const { out, json } = slice(root, '--terms', 'mod');
  assert.ok(size(out) <= 10000, `${size(out)} B`);
  assert.equal(json.total, 20);
  assert.equal(json.truncated, true);
  assert.equal(json.entries, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(json.entries_omitted)) <= 4000, 'the list has a byte budget');
  assert.ok(json.entries_omitted.length < 20);
  assert.equal(json.entries_omitted.length + json.entries_omitted_more, 20, 'every other one is counted');
  for (const o of json.entries_omitted) assert.ok(existsSync(join(root, o.file)));
});

test('a row whose file left the repository is stale, though its module is gone with it', () => {
  const { root, git } = repo({ 'one/a.txt': big(), 'two/b.txt': big() });
  scan(root);
  build(root, 'two/b.txt', { summary: 'two' });
  assert.equal(slice(root, '--files', 'two/b.txt').json.rows[0].stale, undefined);
  git('rm', '-q', 'two/b.txt'); git('commit', '-q', '-m', 'drop');
  const r = slice(root, '--files', 'two/b.txt').json;
  assert.equal(r.total, 1);
  assert.equal(r.rows[0].stale, true);
  assert.equal(r.entries, undefined);
  assert.equal(slice(root, '--files', 'one/a.txt').json.rows[0].stale, undefined, 'a file still there is not marked');
});

test('50,000 matched rows are cut after the first that fit, with the true total', () => {
  const rows = [];
  const symbols = Array.from({ length: 5 }, (_, i) => ({ name: `s${i}`, kind: 'function', line: i + 1, approximate: true }));
  for (let i = 0; i < 50000; i++) rows.push({ path: `pkg/f${String(i).padStart(5, '0')}.js`, kind: 'text', hash: 'a'.repeat(40), bytes: 10, symbols });
  const t = Date.now();
  const body = sliceOf({
    rows, modules: [{ name: 'pkg', paths: rows.map((r) => r.path) }], states: new Map([['pkg', 'unbuilt']]), entries: new Map(),
    select: { files: [], symbols: [], terms: ['pkg'] }, entryPath: (m) => m, current: new Set(rows.map((r) => r.path)),
  });
  assert.ok(Date.now() - t < 3000, `took ${Date.now() - t} ms`);
  assert.equal(body.total, 50000);
  assert.equal(body.truncated, true);
  assert.ok(body.rows.length > 0 && body.rows.length < 50000);
  assert.equal(body.rows[0].path, 'pkg/f00000.js');
  assert.ok(Buffer.byteLength(JSON.stringify({ ok: true, ...body })) + 1 <= 10000);
});

test('--terms searches an entry\'s string values and not its field names or its JSON escapes', () => {
  const { root } = repo({ 'one/a.txt': big(), 'two/b.txt': big() });
  scan(root);
  build(root, 'one/a.txt', { summary: 'say "hello there" to C:\\temp\nnext line' });
  build(root, 'two/b.txt', { summary: 'nothing' });
  const paths = (term) => slice(root, '--terms', term).json.rows.map((x) => x.path);
  assert.deepEqual(paths('summary'), [], 'a field name is no text');
  assert.deepEqual(paths('say "hello'), ['one/a.txt']);
  assert.deepEqual(paths('c:\\temp'), ['one/a.txt']);
  assert.deepEqual(paths('nnext'), [], 'an escape is no text');
  assert.deepEqual(paths('NEXT line'), ['one/a.txt']);
  assert.deepEqual(paths('nothing'), ['two/b.txt']);
});

test('an index whose rows or symbols are not objects with a path answers no-index', () => {
  const { root } = repo({ 'a.mjs': 'export function a() {}\n' });
  scan(root);
  const file = join(root, '.planning', 'codemap', 'index.json');
  const good = index(root);
  for (const bad of [{ rows: [null], modules: [] }, { rows: [{ path: 1 }], modules: [] }, { rows: [{ path: 'a.mjs', symbols: 'x' }], modules: [] },
    { rows: [{ path: 'a.mjs', symbols: [null] }], modules: [] }, { rows: [[]], modules: [] }]) {
    writeFileSync(file, JSON.stringify(bad));
    const r = slice(root, '--files', 'a.mjs').json;
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(r.reason, 'no-index');
  }
  writeFileSync(file, JSON.stringify(good));
  assert.equal(slice(root, '--files', 'a.mjs').json.ok, true);
});

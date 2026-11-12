// Tests for `planning.mjs codemap scan`: every tracked path one row with its working-tree hash, and nothing the map
// writes ever reaching a commit or leaving the repository.
// Run: node --test tests/codemap-scan.test.mjs
//
// Driven through the CLI on scratch git repositories, with real git making the hashes the rows are compared against.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLANNING = join(ROOT, 'cadence-core', 'bin', 'planning.mjs');
const { cut, partition, entryFile, ENTRY_FILE, startsNoReader } = await import(
  join(ROOT, 'cadence-core', 'bin', 'lib', 'codemap-partition.mjs'));

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

const index = (root) => JSON.parse(readFileSync(join(root, '.planning', 'records', 'codemap', 'index.json'), 'utf8'));
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

test('a tracked .planning/records/codemap symlink is refused and its target stays empty', () => {
  const out = mkdtempSync(join(tmpdir(), 'cad-map-target-'));
  const { root } = repo({ 'a.js': 'a\n' });
  mkdirSync(join(root, '.planning', 'records'), { recursive: true });
  symlinkSync(out, join(root, '.planning', 'records', 'codemap'));
  execFileSync('git', ['-C', root, 'add', '-f', '.planning/records/codemap']);
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
  const { root, git } = repo({ 'a.js': 'a\n', '.planning/ROADMAP.md': '# Roadmap\n\n## Phases\n\n' });
  assert.equal(codemap(root, 'scan').ok, true);
  git('add', '.planning');
  assert.equal(git('status', '--short').split('\n').filter((l) => l.includes('.planning/records/codemap')).length, 0);
  assert.match(git('check-ignore', '-v', '.planning/records/codemap/index.json'), /\.planning\/records\/codemap\/\.gitignore/);
  assert.equal(readFileSync(join(root, '.planning', 'records', 'codemap', '.gitignore'), 'utf8'), '*\n');
});

test('a root below the repository top level lists paths relative to itself', () => {
  const { root } = repo({ 'top.js': 't\n', 'sub/in.js': 'i\n', 'sub/deep/d.js': 'd\n' });
  const sub = join(root, 'sub');
  const r = codemap(sub, 'scan', join(sub, '.planning'));
  assert.equal(r.ok, true);
  const rows = JSON.parse(readFileSync(join(sub, '.planning', 'records', 'codemap', 'index.json'), 'utf8')).rows;
  assert.deepEqual(rows.map((x) => x.path), ['deep/d.js', 'in.js']);
});

// --- the module list: the pure cut and reuse, on a lowered ceiling -------------------------------------------------

const row = (path, bytes, kind = 'text') => ({ path, bytes, kind, hash: 'h' });
const C = 100;
const where = (mods) => Object.fromEntries(mods.flatMap((m) => m.paths.map((p) => [p, m.name])));

test('the cut puts every path in exactly one module, and a file over the ceiling stands alone', () => {
  const rows = [row('a.js', 30), row('big.js', 250), row('src/x.js', 60), row('src/y.js', 60), row('src/z/q.js', 90),
    row('docs/d.md', 40), row('docs/e.md', 40), row('.planning/STATE.md', 20)];
  const mods = cut(rows, C);
  const all = mods.flatMap((m) => m.paths);
  assert.deepEqual([...all].sort(), rows.map((r) => r.path).sort());
  assert.equal(new Set(all).size, rows.length);
  assert.deepEqual(mods.find((m) => m.paths.includes('big.js')).paths, ['big.js']);
  assert.equal(new Set(mods.map((m) => m.name)).size, mods.length, 'names are unique');
});

test('adding bytes to a file and rescanning leaves the module list identical', () => {
  const rows = [row('a/1.js', 40), row('a/2.js', 40), row('b/1.js', 60), row('b/2.js', 60)];
  const first = partition(rows, null, C).modules;
  const edited = rows.map((r) => (r.path === 'a/1.js' ? { ...r, bytes: r.bytes + 2048 } : r));
  assert.deepEqual(partition(edited, first, C).modules, first);
  assert.equal(partition(rows, null, C).modules.length, first.length);
});

test('a new file joins the module in its own directory, else the deepest shared ancestor, else the first name', () => {
  const stored = [
    { name: 'm1', paths: ['src/a.js'] }, { name: 'm2', paths: ['src/sub/b.js'] },
    { name: 'm3', paths: ['lib/c.js'] }, { name: 'm4', paths: ['lib/d.js'] },
    { name: 'a-first', paths: ['x/1.js'] }, { name: 'b-second', paths: ['y/2.js'] },
  ];
  const rows = [row('src/a.js', 5), row('src/sub/b.js', 5), row('lib/c.js', 5), row('lib/d.js', 5), row('x/1.js', 5), row('y/2.js', 5)];
  const add = (path) => where(partition([...rows, row(path, 5)], stored, C).modules)[path];
  assert.equal(add('src/e.js'), 'm1', 'own directory');
  assert.equal(add('src/sub/deeper/f.js'), 'm2', 'deepest shared ancestor beats a shallower one');
  assert.equal(add('lib/g.js'), 'm3', 'two modules in the directory: the first name');
  assert.equal(add('zzz/h.js'), 'a-first', 'nothing nearer than the root: the first name');
});

test('a new file over the ceiling stands alone, and one past twice the ceiling starts a module the next joins', () => {
  const stored = [{ name: 'full', paths: ['d/a.js', 'd/b.js'] }, { name: 'other', paths: ['o/z.js'] }];
  const base = [row('d/a.js', 95), row('d/b.js', 95), row('o/z.js', 5)];
  const alone = partition([...base, row('d/huge.js', 150)], stored, C).modules;
  assert.deepEqual(alone.find((m) => m.paths.includes('d/huge.js')).paths, ['d/huge.js']);
  const out = partition([...base, row('d/n1.js', 50), row('d/n2.js', 20)], stored, C).modules;
  const w = where(out);
  assert.notEqual(w['d/n1.js'], 'full', '190 + 50 is past 200');
  assert.equal(w['d/n2.js'], w['d/n1.js'], '190 + 20 is past 200 too, so it joins the module n1 started');
  assert.deepEqual(out.find((m) => m.name === 'full').paths, ['d/a.js', 'd/b.js'], 'no existing file moved');
});

test('a module pushed past the limit by edits stays put and is named oversized', () => {
  const stored = [{ name: 'grown', paths: ['g/a.js', 'g/b.js'] }, { name: 'one', paths: ['h/solo.js'] }];
  const rows = [row('g/a.js', 150), row('g/b.js', 150), row('h/solo.js', 500)];
  const r = partition(rows, stored, C);
  assert.deepEqual(r.modules.map((m) => m.paths), [['g/a.js', 'g/b.js'], ['h/solo.js']]);
  assert.deepEqual(r.oversized, ['grown'], 'one file past the limit is no re-cut candidate');
});

test('a removed file leaves its module and an emptied module goes', () => {
  const stored = [{ name: 'm1', paths: ['a/1.js', 'a/2.js'] }, { name: 'm2', paths: ['b/1.js'] }];
  const r = partition([row('a/1.js', 5)], stored, C);
  assert.deepEqual(r.modules, [{ name: 'm1', paths: ['a/1.js'] }]);
});

test('an unusable stored list is a fresh cut', () => {
  const rows = [row('a.js', 5), row('b.js', 5)];
  const fresh = partition(rows, null, C).modules;
  for (const bad of ['x', [{ name: 'm', paths: 'nope' }], [{ name: 'm', paths: ['a.js'] }, { name: 'n', paths: ['a.js'] }]]) {
    assert.deepEqual(partition(rows, bad, C).modules, fresh);
  }
});

test('.planning files hold facts but never share a module with code, and start no reader', () => {
  const rows = [row('src/a.js', 5), row('.planning/STATE.md', 5), row('img.png', 5, 'binary')];
  const byPath = new Map(rows.map((r) => [r.path, r]));
  const fresh = cut(rows, 5);
  assert.equal(fresh.length, 3, 'code, planning and the picture');
  const planning = fresh.find((m) => m.paths.includes('.planning/STATE.md'));
  assert.deepEqual(planning.paths, ['.planning/STATE.md']);
  assert.equal(startsNoReader(planning, byPath), true);
  assert.equal(startsNoReader(fresh.find((m) => m.paths.includes('img.png')), byPath), true, 'all binary');
  assert.equal(startsNoReader(fresh.find((m) => m.paths.includes('src/a.js')), byPath), false);
  // a repository with none: the first .planning file stays out of every code module, and a second joins the first
  const stored = [{ name: 'code', paths: ['src/a.js'] }];
  const withNew = partition([row('src/a.js', 5), row('.planning/x.md', 5), row('.planning/y.md', 5)], stored, C).modules;
  assert.deepEqual(withNew.find((m) => m.name === 'code').paths, ['src/a.js']);
  assert.deepEqual(withNew.find((m) => m.paths.includes('.planning/x.md')).paths, ['.planning/x.md', '.planning/y.md']);
});

test('an entry file name is derived by hash, so no module name can reach index.json or leave the directory', () => {
  for (const name of ['index', 'index.json', '.gitignore', '../../x', 'a/b', '', '.']) {
    const f = entryFile(name);
    assert.match(f, ENTRY_FILE);
    assert.ok(!f.includes('/') && f !== 'index.json' && f !== '.gitignore');
  }
  assert.notEqual(entryFile('a'), entryFile('b'));
  const mods = cut([row('index/x.js', 5), row('../up/y.js', 5)], C);
  for (const m of mods) assert.match(entryFile(m.name), ENTRY_FILE);
});

// --- the same, through the CLI --------------------------------------------------------------------------------------

const modulesOf = (root) => index(root).modules;
const mapFile = (root, f) => join(root, '.planning', 'records', 'codemap', f);

test('scan stores the module list, and a removed last file removes its module and its entry file', () => {
  // 100 KiB each, so the two directories cannot share one 128 KiB module
  const big = 'x'.repeat(100 * 1024);
  const { root, git } = repo({ 'a/1.js': big, 'b/2.js': big, '.planning/ROADMAP.md': '# Roadmap\n\n## Phases\n\n' });
  const first = codemap(root, 'scan');
  assert.equal(first.modules, 3);
  assert.equal(first.no_reader, 1);
  const gone = modulesOf(root).find((m) => m.paths.includes('b/2.js'));
  writeFileSync(mapFile(root, gone.entry), '{}');
  const keep = join(root, '.planning', 'records', 'codemap', 'notes.txt');
  writeFileSync(keep, 'mine');
  git('rm', '-q', 'b/2.js');
  const second = codemap(root, 'scan');
  assert.equal(second.modules, 2);
  assert.equal(existsSync(mapFile(root, gone.entry)), false);
  assert.equal(existsSync(keep), true, 'only an entry-shaped name is ever deleted');
  assert.equal(modulesOf(root).some((m) => m.name === gone.name), false);
});

test('deleting index.json re-cuts, and an entry file no module names is gone after the scan', () => {
  const { root } = repo({ 'a/1.js': 'a\n', 'b/2.js': 'b\n' });
  codemap(root, 'scan');
  const before = modulesOf(root);
  const orphan = mapFile(root, entryFile('no such module'));
  writeFileSync(orphan, '{}');
  execFileSync('rm', [mapFile(root, 'index.json')]);
  codemap(root, 'scan');
  assert.deepEqual(modulesOf(root), before, 'the same tree cuts the same way');
  assert.equal(existsSync(orphan), false);
});

test('a torn index.json is a fresh cut, not a failure', () => {
  const { root } = repo({ 'a/1.js': 'a\n' });
  codemap(root, 'scan');
  writeFileSync(mapFile(root, 'index.json'), '{"modules": [');
  assert.equal(codemap(root, 'scan').modules, 1);
});

// --- status: built, stale, unbuilt, and no reader --------------------------------------------------------------------

const KB = (n) => 'x'.repeat(n * 1024);
/** a/ holds 80 KiB of text and a binary file, b/ holds 100 KiB, so the two are separate modules; .planning has its own */
function mapped() {
  const t = repo({ 'a/1.js': KB(50), 'a/2.js': KB(30), 'b/3.js': KB(100), '.planning/ROADMAP.md': '# Roadmap\n\n## Phases\n\n' });
  writeFileSync(join(t.root, 'a', 'img.bin'), Buffer.from([0, 1, 2]));
  t.git('add', '-A'); t.git('commit', '-q', '-m', 'more');
  assert.equal(codemap(t.root, 'scan').modules, 3);
  return t;
}
const moduleHolding = (root, path) => modulesOf(root).find((m) => m.paths.includes(path));
/** Writes an entry for each named module (default all) from the hashes the last scan recorded. */
function build(root, names = modulesOf(root).map((m) => m.name)) {
  const hashes = Object.fromEntries(index(root).rows.map((r) => [r.path, r.hash]));
  for (const m of modulesOf(root).filter((x) => names.includes(x.name))) {
    writeFileSync(mapFile(root, m.entry), JSON.stringify({ built_from: Object.fromEntries(m.paths.map((p) => [p, hashes[p]])) }));
  }
}

test('status reads only the edited file\'s module as stale, and undoing the edit returns it to built', () => {
  const { root } = mapped();
  build(root);
  const clean = codemap(root, 'status');
  assert.deepEqual([clean.built, clean.stale, clean.unbuilt, clean.no_reader], [2, 0, 0, 1]);
  writeFileSync(join(root, 'a', '1.js'), KB(50) + 'y');
  const edited = codemap(root, 'status');
  assert.deepEqual([edited.built, edited.stale, edited.stale_modules], [1, 1, [moduleHolding(root, 'a/1.js').name]]);
  writeFileSync(join(root, 'a', '1.js'), KB(50));
  assert.equal(codemap(root, 'status').stale, 0);
});

test('a committed edit with an entry built from the new hash reads built', () => {
  const { root, git } = mapped();
  writeFileSync(join(root, 'a', '1.js'), KB(50) + 'z');
  git('commit', '-qam', 'edit');
  codemap(root, 'scan');
  assert.equal(codemap(root, 'status').unbuilt, 2, 'no entries yet');
  build(root);
  const r = codemap(root, 'status');
  assert.deepEqual([r.built, r.stale], [2, 0]);
});

test('a file added to a built module and one removed from it both read stale', () => {
  const { root, git } = mapped();
  build(root);
  writeFileSync(join(root, 'a', 'new.js'), 'n\n');
  git('add', 'a/new.js');
  assert.deepEqual(codemap(root, 'status').stale_modules, [moduleHolding(root, 'a/1.js').name]);
  git('reset', '-q', 'a/new.js'); execFileSync('rm', [join(root, 'a', 'new.js')]);
  assert.equal(codemap(root, 'status').stale, 0);
  git('rm', '-q', 'a/2.js');
  assert.deepEqual(codemap(root, 'status').stale_modules, [moduleHolding(root, 'a/1.js').name]);
});

test('a module with no entry or a torn one reads unbuilt, never stale, and a no-reader module is in neither list', () => {
  const { root } = mapped();
  build(root, [moduleHolding(root, 'a/1.js').name]);
  let r = codemap(root, 'status');
  assert.deepEqual([r.built, r.stale, r.unbuilt, r.unbuilt_modules], [1, 0, 1, [moduleHolding(root, 'b/3.js').name]]);
  writeFileSync(mapFile(root, moduleHolding(root, 'a/1.js').entry), '{"built_from": {');
  r = codemap(root, 'status');
  assert.deepEqual([r.stale, r.unbuilt, r.no_reader], [0, 2, 1]);
  const planning = moduleHolding(root, '.planning/ROADMAP.md').name;
  assert.ok(!r.unbuilt_modules.includes(planning) && !r.stale_modules.includes(planning));
});

test('scan prices a launch by the stale and unbuilt modules and the text bytes a reader would open', () => {
  const { root } = mapped();
  let r = codemap(root, 'scan');
  assert.deepEqual([r.modules, r.readers, r.reader_bytes], [3, 2, (50 + 30 + 100) * 1024], 'no entries: every reader module, text only');
  assert.equal(r.bytes, (50 + 30 + 100) * 1024 + 3 + 22, 'the total counts every byte, the picture and ROADMAP.md too');
  build(root);
  assert.deepEqual([codemap(root, 'scan').readers, codemap(root, 'scan').reader_bytes], [0, 0]);
  writeFileSync(join(root, 'a', '2.js'), KB(30) + 'y');
  r = codemap(root, 'scan');
  assert.deepEqual([r.readers, r.reader_bytes], [1, (50 + 30) * 1024 + 1], 'the binary file in that module is not counted');
});

test('status with no index answers ok:false, names codemap scan, and writes nothing', () => {
  const { root } = repo({ 'a.js': 'a\n' });
  const r = codemap(root, 'status');
  assert.equal(r.ok, false);
  assert.match(r.hint, /codemap scan/);
  assert.equal(existsSync(join(root, '.planning')), false);
});

// --- symbols: what each text file declares ---------------------------------------------------------------------------

const { symbolsFor } = await import(join(ROOT, 'cadence-core', 'bin', 'lib', 'codemap-symbols.mjs'));
const names = (row) => (row.symbols || []).map((s) => s.name);

const FIXTURE = {
  'lib.js': [
    '// function ghost() {}', '/* export const phantom = 1; */',
    'export function alpha() {}', 'export const beta = () => {};', 'function gamma() {}',
    'export {', '  gamma as delta,', '  zeta,', '};', 'class Eta {}', '',
  ].join('\n'),
  'main.rs': ['pub fn top() {}', 'struct Thing;', 'impl Thing {', '    fn inner(&self) {}', '    pub async fn spaced() {}', '}', ''].join('\n'),
  'tool.py': ['def top():', '    pass', 'class K:', '    def method(self):', '        pass', '    async def later(self):', '        pass', ''].join('\n'),
  'srv.go': ['package srv', 'func Plain() {}', 'func (r *T) Method() {}', 'type T struct{}', ''].join('\n'),
  'doc.md': ['# Title', '', '## Sub heading ##', '', '```', '# not a heading', '```', ''].join('\n'),
  'data.json': JSON.stringify({ name: 'x', version: 1 }),
  'torn.json': '{"a":',
};

test('scan places every file of five languages in one module and each text file holds its names', () => {
  const { root, git } = repo(FIXTURE);
  writeFileSync(join(root, 'blob.bin'), Buffer.from([0, 1, 2, 3]));
  symlinkSync('lib.js', join(root, 'link.js'));
  git('add', '-A'); git('commit', '-q', '-m', 'more');
  const r = codemap(root, 'scan');
  assert.equal(r.ok, true);
  const rows = index(root).rows;
  const tracked = git('ls-files').trim().split('\n');
  assert.deepEqual(rows.map((x) => x.path).sort(), [...tracked].sort());
  const modulesOfPath = modulesOf(root).flatMap((m) => m.paths);
  assert.deepEqual([...modulesOfPath].sort(), [...tracked].sort(), 'each path in exactly one module');
  // hash-object follows a link, which is exactly what the row must not do, so the link is compared by its text
  for (const x of rows) assert.equal(x.hash, x.kind === 'symlink' ? hashOf('lib.js') : git('hash-object', x.path).trim(), x.path);

  const of = (p) => rows.find((x) => x.path === p);
  assert.deepEqual(names(of('lib.js')).sort(), ['Eta', 'alpha', 'beta', 'delta', 'gamma', 'zeta'].sort());
  assert.ok(!names(of('lib.js')).includes('ghost') && !names(of('lib.js')).includes('phantom'), 'comments hold no symbols');
  const rust = of('main.rs').symbols;
  assert.deepEqual(rust.map((s) => s.name), ['top', 'Thing', 'inner', 'spaced']);
  assert.ok(rust.every((s) => s.approximate === true), 'indented fn and column-0 pub fn are both approximate');
  assert.deepEqual(names(of('tool.py')), ['top', 'K', 'method', 'later']);
  assert.deepEqual(names(of('srv.go')), ['Plain', 'Method', 'T']);
  assert.deepEqual(names(of('doc.md')), ['Title', 'Sub heading']);
  assert.deepEqual(of('data.json').symbols, [{ name: 'name', kind: 'key', line: 0 }, { name: 'version', kind: 'key', line: 0 }]);
  assert.equal(of('torn.json').symbols, undefined);
  assert.equal(of('blob.bin').symbols, undefined);
  assert.equal(of('link.js').symbols, undefined, 'a symlink holds none');
});

test('every name lib/rung-agent.mjs exports appears on its row', async () => {
  const real = join(ROOT, 'cadence-core', 'bin', 'lib', 'rung-agent.mjs');
  const { root } = repo({ 'lib/rung-agent.mjs': readFileSync(real, 'utf8') });
  codemap(root, 'scan');
  const held = new Set(names(rowOf(root, 'lib/rung-agent.mjs')[0]));
  const exported = Object.keys(await import(real));
  assert.ok(exported.length > 10);
  assert.deepEqual(exported.filter((n) => !held.has(n)), []);
});

test('a megabyte of hostile text finishes quickly in every reader', () => {
  const lines = {
    '.rs': 'fn '.repeat(350000), '.py': 'def '.repeat(260000), '.md': '# '.repeat(520000),
    '.js': 'export {\n'.repeat(120000), '.go': `func ${' '.repeat(1 << 20)}`, '.json': '['.repeat(1 << 20),
  };
  for (const [ext, text] of Object.entries(lines)) {
    const start = Date.now();
    symbolsFor(`big${ext}`, text);
    assert.ok(Date.now() - start < 5000, `${ext} took ${Date.now() - start} ms`);
  }
});

test('skim.mjs is untouched: it still refuses a .rs file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cad-map-skim-'));
  writeFileSync(join(dir, 'x.rs'), 'fn main() {}\n');
  let out;
  try { out = execFileSync('node', [join(ROOT, 'cadence-core', 'bin', 'skim.mjs'), join(dir, 'x.rs')], { encoding: 'utf8', stdio: 'pipe' }); } catch (e) { out = e.stdout; }
  assert.equal(JSON.parse(out).reason, 'unsupported-extension');
});

// --- the risk review's fixes -------------------------------------------------------------------------------------------

test('a dirty file under a clean filter is hashed on its raw bytes and no filter program runs', () => {
  const marker = join(mkdtempSync(join(tmpdir(), 'cad-map-ran-')), 'ran');
  const { root, git } = repo({ 'a.js': 'one\n', '.gitattributes': '*.js filter=pwn\n' });
  git('config', 'filter.pwn.clean', `touch ${marker}; cat`);
  writeFileSync(join(root, 'a.js'), 'one edited\n');
  codemap(root, 'scan');
  assert.equal(existsSync(marker), false, 'the clean filter never ran');
  assert.equal(rowOf(root, 'a.js')[0].hash, git('hash-object', '--no-filters', 'a.js').trim());
});

test('a dirty file under a root below the top level gets its own hash, not a same-named top-level file\'s', () => {
  const { root } = repo({ 'a.txt': 'top\n', 'sub/a.txt': 'sub\n', 'sub/b.txt': 'b\n' });
  const sub = join(root, 'sub');
  writeFileSync(join(sub, 'a.txt'), 'sub edited\n');
  writeFileSync(join(sub, 'b.txt'), 'b edited\n');
  codemap(sub, 'scan', join(sub, '.planning'));
  const rows = JSON.parse(readFileSync(join(sub, '.planning', 'records', 'codemap', 'index.json'), 'utf8')).rows;
  const real = (f) => execFileSync('git', ['-C', sub, 'hash-object', f], { encoding: 'utf8' }).trim();
  assert.equal(rows.find((x) => x.path === 'a.txt').hash, real('a.txt'));
  assert.equal(rows.find((x) => x.path === 'b.txt').hash, real('b.txt'), 'with no same-named file at the top it is not null');
});

test('a symlink where the map\'s .gitignore goes is replaced and never read through', () => {
  const { root } = repo({ 'a.js': 'a\n' });
  assert.equal(codemap(root, 'scan').ok, true);
  const target = join(root, '.planning', 'x');
  writeFileSync(target, '*\n');
  const ignore = mapFile(root, '.gitignore');
  execFileSync('rm', [ignore]);
  symlinkSync('../x', ignore);
  assert.equal(codemap(root, 'scan').ok, true);
  assert.equal(lstatSync(ignore).isFile(), true, 'the link is gone');
  assert.equal(readFileSync(ignore, 'utf8'), '*\n');
});

test('a whitespace run of a megabyte inside one JS line finishes quickly', () => {
  const start = Date.now();
  symbolsFor('big.js', `a${' '.repeat(1048570)}b\nexport function after() {}\n`);
  assert.ok(Date.now() - start < 5000, `took ${Date.now() - start} ms`);
});

test('an assume-unchanged or skip-worktree file that was edited takes its working-tree hash', () => {
  const { root, git } = repo({ 'a.js': 'a\n', 'b.js': 'b\n' });
  git('update-index', '--assume-unchanged', 'a.js');
  git('update-index', '--skip-worktree', 'b.js');
  writeFileSync(join(root, 'a.js'), 'a edited\n');
  writeFileSync(join(root, 'b.js'), 'b edited\n');
  codemap(root, 'scan');
  assert.equal(rowOf(root, 'a.js')[0].hash, git('hash-object', 'a.js').trim());
  assert.equal(rowOf(root, 'b.js')[0].hash, git('hash-object', 'b.js').trim());
});

test('a non-UTF-8 .planning path stays out of code modules, and a non-UTF-8 .js path still holds its symbols', () => {
  const { root, git } = repo({ 'a.js': 'a\n', '.planning/ROADMAP.md': '# Roadmap\n\n## Phases\n\n' });
  const odd = (dir, ext) => Buffer.concat([Buffer.from(`${root}/${dir}caf`), Buffer.from([0xe9]), Buffer.from(ext)]);
  writeFileSync(odd('.planning/', '.md'), '# note\n');
  writeFileSync(odd('', '.js'), 'export const beta = 1;\n');
  git('add', '-A');
  codemap(root, 'scan');
  const planning = modulesOf(root).find((m) => m.paths.includes('".planning/caf\\351.md"'));
  assert.ok(planning.paths.every((p) => p.startsWith('.planning/') || p.startsWith('".planning/')), 'no code file shares it');
  assert.equal(planning.no_reader, true);
  assert.deepEqual(names(rowOf(root, '"caf\\351.js"')[0]), ['beta']);
});

test('a trailing slash on --dir does not follow a tracked .planning symlink out of the repository', () => {
  const out = mkdtempSync(join(tmpdir(), 'cad-map-target-'));
  const { root, git } = repo({ 'a.js': 'a\n' });
  symlinkSync(out, join(root, '.planning'));
  git('add', '.planning'); git('commit', '-qm', 'link');
  const r = codemap(root, 'scan', `${join(root, '.planning')}/`);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unsafe-dir');
  assert.deepEqual(readdirSync(out), []);
});

test('a module whose files are all gone from the working tree reads stale', () => {
  const big = 'x'.repeat(100 * 1024);
  const { root } = repo({ 'a/1.js': big, 'b/2.js': big });
  codemap(root, 'scan');
  build(root);
  execFileSync('rm', [join(root, 'b', '2.js')]);
  const r = codemap(root, 'status');
  assert.deepEqual([r.built, r.stale, r.no_reader, r.stale_modules], [1, 1, 0, [moduleHolding(root, 'b/2.js').name]]);
});

test('a markdown file with CRLF line endings holds its headings', () => {
  assert.deepEqual(symbolsFor('x.md', '# Title\r\n\r\n## Sub\r\ntext\r\n').map((s) => s.name), ['Title', 'Sub']);
});

test('an index just past 64 MiB is still read by status', () => {
  const { root } = repo({ 'a.js': 'a\n' });
  codemap(root, 'scan');
  const file = mapFile(root, 'index.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), pad: 'x'.repeat(64 * 1024 * 1024 + 1) }));
  const r = codemap(root, 'status');
  assert.equal(r.ok, true);
  assert.equal(r.unbuilt, 1);
});

test('scan refuses when the repository tracks files under the map and writes nothing', () => {
  const { root, git } = repo({ 'a.js': 'a\n', '.planning/records/codemap/index.json': '{"mine": true}\n' });
  const r = codemap(root, 'scan');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'tracked-map');
  assert.match(r.hint, /git rm -r --cached \.planning\/records\/codemap/);
  assert.equal(readFileSync(mapFile(root, 'index.json'), 'utf8'), '{"mine": true}\n');
  assert.equal(existsSync(mapFile(root, '.gitignore')), false);
  // the quoted spelling of a non-UTF-8 name under the map is caught too
  writeFileSync(Buffer.concat([Buffer.from(`${root}/.planning/records/codemap/caf`), Buffer.from([0xe9])]), 'x');
  git('rm', '-q', '--cached', '.planning/records/codemap/index.json'); git('add', '-A');
  assert.equal(codemap(root, 'scan').reason, 'tracked-map');
});

test('a new file does not join a module that is one file over the ceiling', () => {
  const stored = [{ name: '.', paths: ['huge.md'] }, { name: 'z', paths: ['src/a.js'] }];
  const rows = [row('huge.md', 150), row('src/a.js', 5)];
  const out = partition([...rows, row('NEW.md', 5)], stored, C).modules;
  assert.deepEqual(out.find((m) => m.name === '.').paths, ['huge.md']);
  assert.equal(where(out)['NEW.md'], 'z');
});

// --- the second risk review's fixes ------------------------------------------------------------------------------------

test('no clean filter runs on a scan or a status, unedited or after a same-size edit, and a clean row equals its index hash', () => {
  const marker = join(mkdtempSync(join(tmpdir(), 'cad-map-ran-')), 'ran');
  const { root, git } = repo({ 'a.js': 'one\n', 'b.js': 'bee\n', '.gitattributes': '*.js filter=pwn\n' });
  git('config', 'filter.pwn.clean', `touch ${marker}; cat`);
  for (const sub of ['scan', 'status']) {
    assert.equal(codemap(root, sub).ok, true);
    assert.equal(existsSync(marker), false, `${sub} on an unedited file ran the filter`);
  }
  for (const f of ['a.js', 'b.js']) assert.equal(rowOf(root, f)[0].hash, git('ls-files', '-s', f).split(/\s+/)[1]);
  writeFileSync(join(root, 'a.js'), 'two\n');
  for (const sub of ['scan', 'status']) {
    assert.equal(codemap(root, sub).ok, true);
    assert.equal(existsSync(marker), false, `${sub} after a same-size edit ran the filter`);
  }
  assert.equal(rowOf(root, 'a.js')[0].hash, git('hash-object', '--no-filters', 'a.js').trim());
});

test('an unreadable file keeps a null hash and the files after it in the batch are still hashed', (t) => {
  if (process.getuid && process.getuid() === 0) return t.skip('root reads a chmod 000 file');
  const { root, git } = repo({ 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' });
  chmodSync(join(root, 'b.txt'), 0);
  try {
    codemap(root, 'scan');
    assert.equal(rowOf(root, 'b.txt')[0].hash, null);
    for (const f of ['a.txt', 'c.txt']) assert.equal(rowOf(root, f)[0].hash, git('ls-files', '-s', f).split(/\s+/)[1], f);
  } finally { chmodSync(join(root, 'b.txt'), 0o644); }
});

test('a clean symlink hashes its link text to the index hash, and a dirty one to the hash of its new text', () => {
  const { root, git } = repo({ 'a.js': 'a\n' });
  symlinkSync('a.js', join(root, 'ok')); symlinkSync('a.js', join(root, 'moved'));
  git('add', '-A'); git('commit', '-qm', 'links');
  execFileSync('rm', [join(root, 'moved')]);
  symlinkSync('elsewhere/b.js', join(root, 'moved'));
  codemap(root, 'scan');
  assert.equal(rowOf(root, 'ok')[0].hash, git('ls-files', '-s', 'ok').split(/\s+/)[1]);
  assert.equal(rowOf(root, 'moved')[0].hash, hashOf('elsewhere/b.js'));
});

test('a long comment or string line does not change what skim sees below it', () => {
  const pad = 'x'.repeat(2100);
  const of = (src) => symbolsFor('f.js', src).map((s) => s.name);
  assert.deepEqual(of(`/* ${pad} */\nexport function after() {}\n/* second */\nexport function last() {}\n`), ['after', 'last']);
  assert.deepEqual(of(`const a = '${pad}';\nexport function one() {}\nconst g = '/*';\nexport function two() {}\nconst h = '*/';\nexport function three() {}\n`),
    ['a', 'one', 'g', 'two', 'h', 'three']);
  assert.deepEqual(of(`const a = '${pad}'; /* a real\nexport function fake() {}\n*/\nexport function real() {}\n`), ['a', 'real']);
  // a comment opened past the old cap on a line of its own text still hides the declaration it wraps
  assert.ok(!of(`const n = 0;${' '.repeat(2001)}/*\nexport function phantom() {}\n*/\n`).includes('phantom'));
});

test('an index over 128 MiB is named by status and is a fresh cut for scan', () => {
  const { root } = repo({ 'a.js': 'a\n' });
  codemap(root, 'scan');
  truncateSync(mapFile(root, 'index.json'), 128 * 1024 * 1024 + 1);
  const r = codemap(root, 'status');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'index-too-large');
  assert.match(r.hint, /codemap scan/);
  const s = codemap(root, 'scan');
  assert.equal(s.ok, true);
  assert.equal(codemap(root, 'status').ok, true, 'the scan wrote a readable index over it');
});

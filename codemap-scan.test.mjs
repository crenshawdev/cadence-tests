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
const mapFile = (root, f) => join(root, '.planning', 'codemap', f);

test('scan stores the module list, and a removed last file removes its module and its entry file', () => {
  // 100 KiB each, so the two directories cannot share one 128 KiB module
  const big = 'x'.repeat(100 * 1024);
  const { root, git } = repo({ 'a/1.js': big, 'b/2.js': big, '.planning/STATE.md': 's\n' });
  const first = codemap(root, 'scan');
  assert.equal(first.modules, 3);
  assert.equal(first.no_reader, 1);
  const gone = modulesOf(root).find((m) => m.paths.includes('b/2.js'));
  writeFileSync(mapFile(root, gone.entry), '{}');
  const keep = join(root, '.planning', 'codemap', 'notes.txt');
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

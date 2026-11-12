// Zero-dep tests for lib/planning-store.mjs - the one module script writes under .planning go through.
// Run: node --test tests/planning-store.test.mjs
// atomicWrite is pinned by planning-files.test.mjs and the lock by capture-file.test.mjs, both through the module;
// what is here is one case per added primitive, and the builtins-only rule that keeps the hook path cheap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync, symlinkSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendFile, makeDir, movePath, copyFile, unlinkFile, removeTree, writeFile, writeFileNew, linkFile,
  recordsDir, recordsPath, ensureRecordsDir, ensureRecordsIgnore,
  phaseRecordsDir, phaseReportsDir, phaseReviewsDir, phaseReturnsDir, phaseReviewPath, phaseReturnPath,
} from '../cadence-core/bin/lib/planning-store.mjs';

const STORE = join(dirname(fileURLToPath(import.meta.url)), '..', 'cadence-core', 'bin', 'lib', 'planning-store.mjs');
const tmp = () => mkdtempSync(join(tmpdir(), 'cad-store-'));

test('appendFile creates the file and then appends', () => {
  const f = join(tmp(), 'a.jsonl');
  appendFile(f, 'one\n');
  appendFile(f, 'two\n');
  assert.equal(readFileSync(f, 'utf8'), 'one\ntwo\n');
});

test('makeDir creates parents and accepts an existing directory', () => {
  const d = join(tmp(), 'x', 'y', 'z');
  makeDir(d);
  makeDir(d);
  assert.ok(existsSync(d));
});

test('movePath renames, and throws ENOENT for a missing source', () => {
  const root = tmp();
  writeFileSync(join(root, 'from'), 'body');
  movePath(join(root, 'from'), join(root, 'to'));
  assert.equal(readFileSync(join(root, 'to'), 'utf8'), 'body');
  assert.ok(!existsSync(join(root, 'from')));
  assert.throws(() => movePath(join(root, 'from'), join(root, 'again')), { code: 'ENOENT' });
});

test('copyFile leaves the source in place', () => {
  const root = tmp();
  writeFileSync(join(root, 'from'), 'body');
  copyFile(join(root, 'from'), join(root, 'to'));
  assert.equal(readFileSync(join(root, 'to'), 'utf8'), 'body');
  assert.ok(existsSync(join(root, 'from')));
});

test('unlinkFile removes one file, and throws ENOENT when it is gone', () => {
  const f = join(tmp(), 'gone');
  writeFileSync(f, '');
  unlinkFile(f);
  assert.ok(!existsSync(f));
  assert.throws(() => unlinkFile(f), { code: 'ENOENT' });
});

test('removeTree removes a directory with contents', () => {
  const d = join(tmp(), 'tree');
  mkdirSync(join(d, 'inner'), { recursive: true });
  writeFileSync(join(d, 'inner', 'f'), 'x');
  removeTree(d);
  assert.ok(!existsSync(d));
});

test('writeFile overwrites, and writeFileNew refuses a file already there', () => {
  const f = join(tmp(), 'w');
  writeFile(f, 'one');
  writeFile(f, 'two');
  assert.equal(readFileSync(f, 'utf8'), 'two');
  assert.throws(() => writeFileNew(f, 'three'), { code: 'EEXIST' });
  assert.equal(readFileSync(f, 'utf8'), 'two');
  const g = join(tmp(), 'g');
  writeFileNew(g, 'fresh');
  assert.equal(readFileSync(g, 'utf8'), 'fresh');
});

test('linkFile hard-links, and throws EEXIST when the path is taken', () => {
  const root = tmp();
  writeFileSync(join(root, 'live'), 'body');
  linkFile(join(root, 'live'), join(root, 'sibling'));
  assert.equal(readFileSync(join(root, 'sibling'), 'utf8'), 'body');
  assert.throws(() => linkFile(join(root, 'live'), join(root, 'sibling')), { code: 'EEXIST' });
});

test('recordsDir and recordsPath resolve inside one folder under the planning root', () => {
  const root = tmp();
  assert.equal(dirname(recordsDir(root)), root);
  assert.equal(relative(recordsDir(root), recordsPath(root, 'trace.jsonl')), 'trace.jsonl');
  assert.equal(relative(recordsDir(root), recordsPath(root, 'deferred', '3')), join('deferred', '3'));
});

test('a phase\'s review and return paths sit in their own area of its records folder, live or archived', () => {
  const root = tmp();
  for (const phaseDir of [join(root, 'phases', '3'), join(root, 'phases', '_archive-v1', '3')]) {
    assert.equal(phaseRecordsDir(phaseDir), join(phaseDir, 'records'));
    assert.equal(phaseReportsDir(phaseDir), join(phaseDir, 'records', 'reports'));
    assert.equal(phaseReviewPath(phaseDir, 'r.md'), join(phaseDir, 'records', 'reviews', 'r.md'));
    assert.equal(phaseReturnPath(phaseDir, 'r.json'), join(phaseDir, 'records', 'returns', 'r.json'));
    assert.equal(phaseReviewsDir(phaseDir), join(phaseDir, 'records', 'reviews'));
    assert.equal(phaseReturnsDir(phaseDir), join(phaseDir, 'records', 'returns'));
  }
  // resolving creates nothing
  assert.equal(existsSync(join(root, 'phases')), false);
});

test('a review or return name that would leave its area is refused with a throw', () => {
  const phaseDir = join(tmp(), 'phases', '1');
  for (const bad of ['', '.', '..', 'a/b', '../x', 'a\\b', '/abs', 'a\0b']) {
    assert.throws(() => phaseReviewPath(phaseDir, bad), /not a file name/, JSON.stringify(bad));
    assert.throws(() => phaseReturnPath(phaseDir, bad), /not a file name/, JSON.stringify(bad));
  }
});

test('ensureRecordsDir creates the folder once, refuses a link, and never creates the planning root', () => {
  const root = tmp();
  assert.deepEqual(ensureRecordsDir(root), { ok: true });
  assert.equal(lstatSync(recordsDir(root)).isDirectory(), true);
  assert.deepEqual(ensureRecordsDir(root), { ok: true });

  const linked = tmp();
  symlinkSync(tmp(), recordsDir(linked));
  assert.deepEqual(ensureRecordsDir(linked), { ok: false, reason: 'symlinked-records' });

  const missing = join(tmp(), 'no-such-planning-root');
  assert.deepEqual(ensureRecordsDir(missing), { ok: false, reason: 'ENOENT' });
  assert.equal(existsSync(missing), false);
});

test('the records folder gets its .gitignore when created, once, and a hand-edited one is never overwritten', () => {
  const root = tmp();
  const ignore = recordsPath(root, '.gitignore');
  ensureRecordsDir(root);
  const written = readFileSync(ignore, 'utf8');
  assert.match(written, /^\/trace\.jsonl$/m);
  assert.match(written, /^\/risk-carry\/$/m);

  writeFileSync(ignore, '# mine\n');
  assert.equal(ensureRecordsIgnore(root), false);
  assert.deepEqual(ensureRecordsDir(root), { ok: true });
  assert.equal(readFileSync(ignore, 'utf8'), '# mine\n');

  // a folder that already exists is not given a file on a later call, only a creation writes one
  const old = tmp();
  mkdirSync(recordsDir(old));
  ensureRecordsDir(old);
  assert.equal(existsSync(recordsPath(old, '.gitignore')), false);
});

test('the module imports node: builtins and the one text-util leaf only', () => {
  const src = readFileSync(STORE, 'utf8');
  const specs = [...src.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]/gms)].map((m) => m[1]);
  const bare = [...src.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  const all = [...specs, ...bare];
  assert.ok(all.length > 0, 'the walk found no import, so it checks nothing');
  // './text-util.mjs' carries the one shared sleep (the helper census allows no second copy) and itself imports nothing
  assert.deepEqual(all.filter((s) => !s.startsWith('node:') && s !== './text-util.mjs'), []);
  assert.doesNotMatch(readFileSync(join(dirname(STORE), 'text-util.mjs'), 'utf8'), /^\s*import\b/m);
});

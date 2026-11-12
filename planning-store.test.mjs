// Zero-dep tests for lib/planning-store.mjs - the one module script writes under .planning go through.
// Run: node --test tests/planning-store.test.mjs
// atomicWrite and the lock are pinned by planning-files.test.mjs and capture-file.test.mjs through their re-exports;
// what is here is one case per added primitive, and the builtins-only rule that keeps the hook path cheap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendFile, makeDir, movePath, copyFile, unlinkFile, removeTree,
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

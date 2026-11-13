// Test for the memory bound on `codemap status` and `codemap scan`: a module's entry is classified as it is read and
// dropped, so entries that are each under the cap never add up to an out-of-memory abort.
// Run: node --test tests/codemap-entry-memory.test.mjs
//
// Driven through the CLI under a small V8 heap on a scratch repository whose entries are padded with empty objects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLANNING = join(ROOT, 'cadence-core', 'bin', 'planning.mjs');
const MODULES = 8;
// each pad parses to roughly 160 MiB of heap, so the eight together overrun a 450 MiB heap and any one fits
const PAD = '{},'.repeat(5 * 1024 * 1024 / 3);

function cli(root, heapMiB, ...args) {
  return JSON.parse(execFileSync('node', [`--max-old-space-size=${heapMiB}`, PLANNING, '--dir', join(root, '.planning'), 'codemap', ...args],
    { cwd: root, encoding: 'utf8', stdio: 'pipe' }));
}

/** A repository of MODULES directories, each its own module, scanned, with a stale padded entry written for every one. */
function padded() {
  const root = mkdtempSync(join(tmpdir(), 'cad-mem-'));
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', stdio: 'pipe' });
  git('init', '-q'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T');
  for (let i = 0; i < MODULES; i++) {
    mkdirSync(join(root, `d${i}`));
    writeFileSync(join(root, `d${i}`, 'f.js'), 'x'.repeat(100 * 1024));
  }
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  assert.equal(cli(root, 4096, 'scan').modules, MODULES);
  const map = join(root, '.planning', 'records', 'codemap');
  const { modules } = JSON.parse(readFileSync(join(map, 'index.json'), 'utf8'));
  for (const m of modules) writeFileSync(join(map, m.entry), `{"built_from":{},"pad":[${PAD}{}]}`);
  return root;
}

test('status and scan classify padded entries one at a time and survive a heap that cannot hold them all', () => {
  const root = padded();
  const status = cli(root, 450, 'status');
  assert.equal(status.ok, true);
  assert.equal(status.stale, MODULES);
  const scan = cli(root, 450, 'scan');
  assert.equal(scan.ok, true);
  assert.equal(scan.stale, MODULES);
});

// test.mjs's leftover check, proven by running a copy of it over one planted test.
'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), 'test.mjs');

const PREAMBLE = `import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
`;

function temp(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Runs the current runner over a suite of one planted test, with an empty dir as its TMPDIR. */
function runPlanted(t, body) {
  const suite = temp(t, 'cad-leftovers-suite-');
  const handed = temp(t, 'cad-leftovers-tmp-');
  copyFileSync(RUNNER, join(suite, 'test.mjs'));
  writeFileSync(join(suite, 'planted.test.mjs'), PREAMBLE + body);
  const env = { ...process.env, TMPDIR: handed };
  // Inherited NODE_TEST_CONTEXT makes the nested `node --test` print nothing and exit 0 on a failure.
  delete env.NODE_TEST_CONTEXT;
  // Unpinned, so the copy makes its own cad-test-global- dir and has to clean it up.
  delete env.CADENCE_GLOBAL_CONFIG;
  const r = spawnSync(process.execPath, [join(suite, 'test.mjs')], { env, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, left: readdirSync(handed) };
}

test('leftovers: a test that leaves a temp folder fails the run, which names it and still cleans up', (t) => {
  const { status, out, left } = runPlanted(t,
    "test('leaks', () => { mkdtempSync(join(tmpdir(), 'cad-zz-planted-leak-')); });\n");
  assert.notEqual(status, 0, out);
  assert.match(out, /cad-zz-planted-leak-/);
  assert.deepEqual(left, []);
});

test('leftovers: a test that removes its own fixture passes and leaves nothing', (t) => {
  const { status, out, left } = runPlanted(t,
    "test('tidy', (t) => { const d = mkdtempSync(join(tmpdir(), 'cad-zz-planted-tidy-')); t.after(() => rmSync(d, { recursive: true, force: true })); });\n");
  assert.equal(status, 0, out);
  assert.deepEqual(left, []);
});

test('leftovers: a failing test still fails the run, and nothing is left', (t) => {
  const { status, out, left } = runPlanted(t,
    "test('fails', () => { throw new Error('planted failure'); });\n");
  assert.notEqual(status, 0, out);
  assert.match(out, /planted failure/);
  assert.deepEqual(left, []);
});

// Zero-dep tests for `planning.mjs records-dir` - the folder an advisory reviewer's heredoc needs to exist. Run:
// node --test tests/planning-records-dir.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLANNING = join(dirname(fileURLToPath(import.meta.url)), '..', 'cadence-core', 'bin', 'planning.mjs');

function run(dir, args) {
  let stdout;
  try { stdout = execFileSync('node', [PLANNING, ...args, '--dir', dir], { encoding: 'utf8' }); } catch (e) { stdout = e.stdout; }
  return JSON.parse(stdout);
}

function tree() {
  const root = mkdtempSync(join(tmpdir(), 'cad-rd-'));
  const dir = join(root, '.planning');
  mkdirSync(join(dir, 'phases', '1'), { recursive: true });
  return { root, dir };
}

test('records-dir: a first-plan phase gets its records folder, and a second run changes nothing', () => {
  const { dir } = tree();
  const r = run(dir, ['records-dir', '--phase', '1']);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.records, join('phases', '1', 'records'));
  assert.ok(lstatSync(join(dir, 'phases', '1', 'records')).isDirectory());
  assert.equal(run(dir, ['records-dir', '--phase', '1']).ok, true);
});

test('records-dir: a phase with no directory is refused and nothing is made', () => {
  const { dir } = tree();
  const r = run(dir, ['records-dir', '--phase', '7']);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-phase-dir');
  assert.equal(existsSync(join(dir, 'phases', '7')), false);
});

test('records-dir: a linked records folder is refused, never written through', () => {
  const { root, dir } = tree();
  const elsewhere = join(root, 'elsewhere');
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, join(dir, 'phases', '1', 'records'));
  const r = run(dir, ['records-dir', '--phase', '1']);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'records-unusable');
});

test('records-dir: no --phase is a bad-args refusal', () => {
  const { dir } = tree();
  const r = run(dir, ['records-dir']);
  assert.equal(r.ok, false);
});

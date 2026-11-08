// Zero-dep tests for the workflow arm of references/worktree-executor.md. Run: node --test tests/execute-workflow.test.mjs
// The defects are today's worktree executor reading changed rules, an executor committing its report or marking it
// complete before the merge, and an executor deleting a branch that holds earlier work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const text = readFileSync(join(REPO, 'cadence-core', 'references', 'worktree-executor.md'), 'utf8');
const MARK = '\n## Workflow arm\n';
const at = text.indexOf(MARK);
const today = text.slice(0, at);
const arm = text.slice(at + 1);
const flat = (s) => s.replace(/\s+/g, ' ');

test('workflow arm: the file above the new section is today\'s text byte for byte, its five bullets included', () => {
  assert.ok(at > 0, 'the section exists');
  assert.equal(today.split('\n').filter((l) => l.startsWith('- ')).length, 5);
  // the sha-256 of worktree-executor.md as it stood before the arm was added
  assert.equal(createHash('sha256').update(today).digest('hex'),
    '5ba9daf22cb1101330d50a781850acb95e75fffa82a59291e31e8d05eb2f90ee');
});

test('workflow arm: its mode line differs from today\'s, says worktree, and names the branch', () => {
  const m = flat(arm).match(/mode line reads exactly "([^"]+)"/);
  assert.ok(m, 'the section writes its mode line out');
  assert.notEqual(m[1], 'Worktree executor on branch {branch} - worktree rules apply.');
  assert.match(m[1], /worktree mode/);
  assert.ok(m[1].includes('`cadence/phase-<N>-plan-<k>`'));
});

test('workflow arm: the branch is created first, an existing non-current one halts untouched, and the lease reads the main tree', () => {
  const a = flat(arm);
  assert.match(a, /create `cadence\/phase-<N>-plan-<k>` from the worktree's HEAD/);
  assert.match(a, /before anything else/);
  assert.match(a, /Already the current branch -> the host restarted you/);
  assert.match(a, /Exists but is not current -> HALT `blocked` naming it and its head; never delete, reset or force it/);
  assert.match(a, /`lease-check` with `--dir <main tree>\/\.planning`/);
});

test('workflow arm: the report goes to the scratch path the prompt names, nothing is written into the main tree, and it is never committed', () => {
  const a = flat(arm);
  assert.match(a, /in the run's scratch directory\. Never write into the main tree/);
  assert.match(a, /goes to the path the prompt names, in place of `<plandir>\/reports\/plan-<k>\.md`, and you NEVER commit it/);
  assert.match(a, /only after it has merged your branch/);
  assert.match(a, /ABSOLUTE paths outside the worktree, never relative to it/);
});

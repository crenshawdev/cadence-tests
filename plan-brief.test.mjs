// Zero-dep tests for `planning.mjs brief`. Run: node --test tests/plan-brief.test.mjs
// Everything goes through the real CLI on a fixture phase, because the defects are a section lost or reworded,
// bytes that vary between runs, and brief text landing in the transcript.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './planning.test.mjs';

const PROJECT = `# Proj

## What This Is

SECRET-WHAT-THIS-IS

## Constraints

- **Dependencies**: no npm runtime dependencies, ever
- **Seams**: judgment stays prose

## Key Decisions

KEY-DECISIONS-TEXT
`;

const planText = ({ files = ['src/a.mjs', 'tests/a.test.mjs (lease)'], tasks = '### Task 1: Do it\n\n- **Files:** src/a.mjs\n- **Action:** Make `x` true: with a colon.\n- **Verify:** run it\n', notes = 'NOTES-ONLY-TEXT' } = {}) => `---
phase: 4
plan: 3
files:
${files.map((f) => `  - ${f}\n`).join('')}---

# Phase 4: Thing - Plan 3: Name

## Goal

GOAL-SENTENCE

## Must be true when done

- truth one
- truth two

## Context

- Locked: D-02.

${tasks === null ? '' : `## Tasks\n\n${tasks}\n`}## Notes

${notes}
`;

/** A scratch project: .planning with PROJECT.md, one phase and its plans. */
function project({ plans = { 'PLAN-3.md': planText() }, projectMd = PROJECT, context = null, phase = '4' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cad-brief-'));
  const dir = join(root, '.planning');
  const pdir = join(dir, 'phases', phase);
  mkdirSync(pdir, { recursive: true });
  if (projectMd !== null) writeFileSync(join(dir, 'PROJECT.md'), projectMd);
  if (context !== null) writeFileSync(join(pdir, 'CONTEXT.md'), context);
  for (const [name, text] of Object.entries(plans)) writeFileSync(join(pdir, name), text);
  return { root, dir, pdir };
}

const scratch = () => mkdtempSync(join(tmpdir(), 'cad-brief-out-'));
const brief = (dir, args = ['--phase', '4', '--plan', '3']) => run(['brief', ...args], dir);
const listing = (d) => readdirSync(d).sort();

test('brief: the same inputs give the same bytes into two directories', () => {
  const { dir } = project();
  const a = scratch();
  const b = scratch();
  const ra = brief(dir, ['--phase', '4', '--plan', '3', '--out-dir', a]);
  const rb = brief(dir, ['--phase', '4', '--plan', '3', '--out-dir', b]);
  assert.equal(ra.ok, true, JSON.stringify(ra));
  assert.equal(rb.ok, true, JSON.stringify(rb));
  const fa = readFileSync(ra.path);
  assert.deepEqual(fa, readFileSync(rb.path));
  assert.equal(ra.bytes, fa.length);
});

test('brief: the lease and the four plan sections appear whole, and Notes does not', () => {
  const text = planText();
  const { dir } = project({ plans: { 'PLAN-3.md': text } });
  const out = scratch();
  const r = brief(dir, ['--phase', '4', '--plan', '3', '--out-dir', out]);
  const got = readFileSync(r.path, 'utf8');
  assert.ok(got.includes('files:\n  - src/a.mjs\n  - tests/a.test.mjs (lease)'), 'the files: lines as written');
  for (const h of ['## Goal', '## Must be true when done', '## Context', '## Tasks']) {
    const section = text.slice(text.indexOf(h)).split(/\n(?=## )/)[0].trimEnd();
    assert.ok(got.includes(section), `${h} appears word for word`);
  }
  assert.ok(got.startsWith('# Phase 4: Thing - Plan 3: Name\n'));
  assert.ok(!got.includes('NOTES-ONLY-TEXT'));
  assert.ok(!got.includes('## Notes'));
});

test('brief: the Constraints ride along and no other PROJECT.md section does', () => {
  const { dir } = project();
  const out = scratch();
  const got = readFileSync(brief(dir, ['--phase', '4', '--plan', '3', '--out-dir', out]).path, 'utf8');
  assert.ok(got.includes('## Constraints\n\n- **Dependencies**: no npm runtime dependencies, ever\n- **Seams**: judgment stays prose'));
  assert.ok(!got.includes('SECRET-WHAT-THIS-IS'));
  assert.ok(!got.includes('KEY-DECISIONS-TEXT'));
});

test('brief: the head names the plan by its repository path', () => {
  const { dir } = project();
  const out = scratch();
  const got = readFileSync(brief(dir, ['--phase', '4', '--plan', '3', '--out-dir', out]).path, 'utf8');
  assert.ok(got.includes('`.planning/phases/4/PLAN-3.md`'));
  assert.ok(got.includes('`.planning/PROJECT.md`'));
  assert.ok(got.includes('`.planning/phases/4/CONTEXT.md`'));
  assert.ok(!got.includes(dir), 'no absolute path in the brief');
});

test('brief: a project with no PROJECT.md still composes, without Constraints', () => {
  const { dir } = project({ projectMd: null });
  const out = scratch();
  const r = brief(dir, ['--phase', '4', '--plan', '3', '--out-dir', out]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(!readFileSync(r.path, 'utf8').includes('## Constraints'));
});

test('brief: a plan with no files: key composes without the lease part', () => {
  const { dir } = project({ plans: { 'PLAN-3.md': planText().replace(/files:\n(  - .*\n)+/, '') } });
  const out = scratch();
  const r = brief(dir, ['--phase', '4', '--plan', '3', '--out-dir', out]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(!readFileSync(r.path, 'utf8').includes("The plan's lease"));
});

test('brief: with no --out-dir nothing is written and the answer is a byte count', () => {
  const { dir, pdir } = project();
  const before = listing(pdir);
  const r = brief(dir);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(typeof r.bytes, 'number');
  assert.ok(r.bytes > 0);
  assert.equal(r.path, undefined);
  assert.deepEqual(listing(pdir), before);
});

test('brief: the envelope holds no sentence from the tasks', () => {
  const { dir } = project();
  const out = scratch();
  const r = brief(dir, ['--phase', '4', '--plan', '3', '--out-dir', out]);
  const line = JSON.stringify(r);
  assert.ok(!line.includes('Make `x` true'));
  assert.ok(!line.includes('GOAL-SENTENCE'));
  assert.ok(line.length < 400, line);
});

test('brief: an --out-dir that is not a directory is refused and nothing is written', () => {
  const { dir, pdir } = project();
  const gone = join(scratch(), 'missing');
  const r = brief(dir, ['--phase', '4', '--plan', '3', '--out-dir', gone]);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad-args');
  assert.deepEqual(listing(pdir), ['PLAN-3.md']);
});

test('brief: a plan that does not exist, and a plan with no Tasks, are refused by name', () => {
  const { dir } = project({ plans: { 'PLAN-3.md': planText(), 'PLAN-2.md': planText({ tasks: null }) } });
  const none = brief(dir, ['--phase', '4', '--plan', '9']);
  assert.equal(none.ok, false);
  assert.match(none.detail, /PLAN-9/);
  const bare = brief(dir, ['--phase', '4', '--plan', '2']);
  assert.equal(bare.ok, false);
  assert.match(bare.detail, /PLAN-2\.md/);
});

test('brief: bad --phase and --plan are refused at the door', () => {
  const { dir } = project();
  assert.equal(brief(dir, ['--plan', '3']).reason, 'bad-args');
  assert.equal(brief(dir, ['--phase', '4']).reason, 'bad-args');
  assert.equal(brief(dir, ['--phase', '4', '--plan', 'x']).reason, 'bad-args');
});

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

// --- Decisions: a task's named ids pull their lines from the phase's CONTEXT.md ---

const CONTEXT = `# Phase 4: Thing - Context

## Durable decisions

- D-01 (shared files): \`waves\` counts every declared file: John picked "Count every file".

## Decisions

- D-06 (choose_path): routes the phase sequential. Evidence: \`execute.md:177\`.
- D-10 (budget): the ceiling is held by the seam.
- D-11 (unnamed): no task names this one.
`;

const withDecisions = (...fields) => planText({
  tasks: fields.map((f, i) => `### Task ${i + 1}: T${i + 1}\n\n${f}- **Action:** a\n- **Verify:** v\n`).join('\n'),
});
const field = (value) => `- **Decisions:** ${value}\n`;
const make = (plans, context = CONTEXT) => project({ plans, context });
const compose = (dir, plan = '3') => {
  const out = scratch();
  return { out, r: brief(dir, ['--phase', '4', '--plan', plan, '--out-dir', out]) };
};

test('brief decisions: a named id gives its line whole and once, and an unnamed line is absent', () => {
  const { dir } = make({ 'PLAN-3.md': withDecisions(field('D-01, D-10'), field('D-10')) });
  const { r } = compose(dir);
  assert.equal(r.ok, true, JSON.stringify(r));
  const got = readFileSync(r.path, 'utf8');
  const d01 = CONTEXT.split('\n').find((l) => l.startsWith('- D-01'));
  const d10 = CONTEXT.split('\n').find((l) => l.startsWith('- D-10'));
  assert.ok(got.includes(`${d01}\n${d10}\n`), 'both lines whole, in the order first named');
  assert.equal(got.split(d10).length - 1, 1, 'D-10 once though two tasks name it');
  assert.ok(!got.includes('D-11 (unnamed)'));
  assert.ok(!got.includes('No decision was carried'));
});

test('brief decisions: a missing id is refused naming plan, task and id, and nothing is written', () => {
  const { dir } = make({ 'PLAN-2.md': withDecisions(field('D-01'), field('D-99')) });
  const { out, r } = compose(dir, '2');
  assert.equal(r.ok, false);
  assert.match(r.detail, /PLAN-2\.md/);
  assert.match(r.detail, /Task 2/);
  assert.match(r.detail, /D-99/);
  assert.deepEqual(listing(out), []);
});

test('brief decisions: every bad entry across tasks is named in one answer', () => {
  const { dir } = make({ 'PLAN-3.md': withDecisions(field('D-98'), field('D-01'), field('D-99')) });
  const { r } = compose(dir);
  assert.equal(r.ok, false);
  assert.match(r.detail, /Task 1 names D-98/);
  assert.match(r.detail, /Task 3 names D-99/);
  assert.doesNotMatch(r.detail, /Task 2/);
});

test('brief decisions: ids compare whole, so D-1 never finds D-10', () => {
  const { dir } = make({ 'PLAN-3.md': withDecisions(field('D-1')) });
  const { r } = compose(dir);
  assert.equal(r.ok, false);
  assert.match(r.detail, /D-1,/);
});

test('brief decisions: an entry that is not an id refuses the brief', () => {
  const { dir } = make({ 'PLAN-3.md': withDecisions(field('see D-01')) });
  const { r } = compose(dir);
  assert.equal(r.ok, false);
  assert.match(r.detail, /see D-01.*not a decision id/);
});

test('brief decisions: a value wrapped onto a second line keeps every id', () => {
  const { dir } = make({ 'PLAN-3.md': withDecisions('- **Decisions:** D-01,\n  D-06, D-10\n') });
  const { r } = compose(dir);
  assert.equal(r.ok, true, JSON.stringify(r));
  const got = readFileSync(r.path, 'utf8');
  for (const id of ['- D-01 (shared', '- D-06 (choose_path)', '- D-10 (budget)']) assert.ok(got.includes(id), id);
});

const SHAPED = `# Phase 4: Thing - Context

## Decisions

- D-02 (wrapped): the first line ends mid-sentence and
  the sentence finishes here, with John's ruling.
- D-03 (nested): requires:
  - the first requirement
    - a sub-point of it

  - the second requirement, after a blank line inside the decision

- D-04 (plain): one line.
- D-10a (draft): WRONG
- D-10 (budget): RIGHT

## Notes

- D-05 (elsewhere): not in a decision section.
`;

test('brief decisions: a wrapped decision and a nested-bullet decision ride whole, to the next column-0 line', () => {
  const { dir } = make({ 'PLAN-3.md': withDecisions(field('D-02, D-03')) }, SHAPED);
  const { r } = compose(dir);
  assert.equal(r.ok, true, JSON.stringify(r));
  const got = readFileSync(r.path, 'utf8');
  const wrapped = '- D-02 (wrapped): the first line ends mid-sentence and\n  the sentence finishes here, with John\'s ruling.';
  const nested = '- D-03 (nested): requires:\n  - the first requirement\n    - a sub-point of it\n\n  - the second requirement, after a blank line inside the decision';
  assert.ok(got.includes(`## Decisions the tasks name\n\n${wrapped}\n${nested}\n`), 'both whole, trailing blank dropped');
  assert.ok(!got.includes('D-04 (plain)'), 'the next column-0 line ends the decision');
});

test('brief decisions: a suffixed id is not the bare id, in either order', () => {
  const { dir } = make({ 'PLAN-3.md': withDecisions(field('D-10')) }, SHAPED);
  const { r } = compose(dir);
  assert.equal(r.ok, true, JSON.stringify(r));
  const got = readFileSync(r.path, 'utf8');
  assert.ok(got.includes('- D-10 (budget): RIGHT'));
  assert.ok(!got.includes('WRONG'));
  const only = make({ 'PLAN-3.md': withDecisions(field('D-10')) }, '## Decisions\n\n- D-10a (draft): WRONG\n');
  assert.equal(compose(only.dir).r.ok, false);
});

test('brief: the head does not claim a file the project lacks, and still names the paths', () => {
  const { dir } = project({ projectMd: null });
  const got = readFileSync(compose(dir).r.path, 'utf8');
  assert.ok(!got.includes('All three are still there'));
  assert.ok(got.includes('Any of these the project has are still there to open'));
});

test('brief decisions: an empty value refuses nothing and does not take in the next field', () => {
  const { dir } = make({ 'PLAN-3.md': withDecisions('- **Decisions:**\n') });
  const { r } = compose(dir);
  assert.equal(r.ok, true, JSON.stringify(r));
  const got = readFileSync(r.path, 'utf8');
  assert.ok(!got.includes('## Decisions the tasks name'));
  assert.ok(got.includes('No decision was carried'));
});

test('brief decisions: with no CONTEXT.md a named id is refused', () => {
  const { dir } = project({ plans: { 'PLAN-3.md': withDecisions(field('D-01')) } });
  const { r } = compose(dir);
  assert.equal(r.ok, false);
  assert.match(r.detail, /D-01/);
});

test('brief decisions: no Decisions field against a CONTEXT.md that holds some names its path in the head', () => {
  const { dir } = make({ 'PLAN-3.md': planText() });
  const { r } = compose(dir);
  const got = readFileSync(r.path, 'utf8');
  assert.match(got, /No decision was carried: no task names one\. `\.planning\/phases\/4\/CONTEXT\.md` holds/);
  assert.ok(!got.includes('## Decisions the tasks name'));
});

test('brief decisions: with no CONTEXT.md and no field the head carries no such line', () => {
  const { dir } = project();
  const { r } = compose(dir);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(!readFileSync(r.path, 'utf8').includes('No decision was carried'));
});

// --- the ceiling: 32 KiB of the file's bytes, never characters ---

const CEILING = 32 * 1024;
const padded = (pad) => planText({ tasks: `### Task 1: Pad\n\n- **Action:** ${pad}\n- **Verify:** v\n` });
const sizeWith = (pad) => {
  const { dir } = project({ plans: { 'PLAN-3.md': padded(pad) } });
  return brief(dir).bytes;
};

test('brief ceiling: a plan whose parts pad past it is refused naming the plan and both numbers', () => {
  const { dir } = project({ plans: { 'PLAN-3.md': padded('x'.repeat(CEILING)) } });
  const out = scratch();
  const r = brief(dir, ['--phase', '4', '--plan', '3', '--out-dir', out]);
  assert.equal(r.ok, false);
  assert.match(r.detail, /PLAN-3\.md/);
  assert.match(r.detail, new RegExp(`\\b${CEILING}\\b`));
  assert.match(r.detail, /brief is (\d+) bytes/);
  assert.ok(Number(/brief is (\d+) bytes/.exec(r.detail)[1]) > CEILING);
  assert.match(r.hint, /split/);
  assert.deepEqual(listing(out), []);
});

test('brief ceiling: a brief exactly at it passes and its file is that size, one byte over is refused', () => {
  const base = sizeWith('');
  const { dir } = project({ plans: { 'PLAN-3.md': padded('x'.repeat(CEILING - base)) } });
  const out = scratch();
  const r = brief(dir, ['--phase', '4', '--plan', '3', '--out-dir', out]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.bytes, CEILING);
  assert.equal(readFileSync(r.path).length, CEILING);
  const over = project({ plans: { 'PLAN-3.md': padded('x'.repeat(CEILING - base + 1)) } });
  assert.equal(brief(over.dir).ok, false);
});

test('brief ceiling: multi-byte text counts in bytes', () => {
  // 12,000 characters of 3-byte text: under the ceiling by characters, over it by bytes
  const { dir } = project({ plans: { 'PLAN-3.md': padded('€'.repeat(12000)) } });
  const r = brief(dir);
  assert.equal(r.ok, false);
  assert.match(r.detail, /PLAN-3\.md/);
});

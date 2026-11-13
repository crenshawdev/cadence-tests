// Zero-dep tests for review.triggers.diff.when. Run: node --test tests/diff-when.test.mjs
// One key, per_plan (today) or phase_end. Under phase_end the per-plan diff reviews stop on their own and one review
// fires over PHASE_START..HEAD, never twice: each assert below reads only its own slice of the prose it pins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(join(REPO, ...p), 'utf8');
const flat = (s) => s.replace(/\s+/g, ' ');
// the text from one marker up to the next one, flattened; a missing marker fails here and not as a silent empty slice
const slice = (text, from, to) => {
  const a = text.indexOf(from);
  assert.notEqual(a, -1, `no ${from}`);
  const b = to === undefined ? text.length : text.indexOf(to, a + from.length);
  assert.notEqual(b, -1, `no ${to}`);
  return flat(text.slice(a, b));
};

const KEY = 'review.triggers.diff.when';
const SCHEMA = JSON.parse(read('cadence-core', 'config.schema.json'));
const EXEC = read('cadence-core', 'workflows', 'execute.md');
const PARALLEL = read('cadence-core', 'references', 'execute-parallel.md');
const WORKFLOW = read('cadence-core', 'references', 'execute-workflow.md');
const TRIGGERS = read('cadence-core', 'references', 'review-triggers.md');
const step = (name) => slice(EXEC, `<step name="${name}">`, '</step>');

test('the key takes per_plan or phase_end, defaults to per_plan, and is Advanced: no question and no position', () => {
  const k = SCHEMA.keys[KEY];
  assert.ok(k, 'the schema carries the key');
  assert.equal(k.type, 'enum');
  assert.deepEqual(k.values, ['per_plan', 'phase_end']);
  assert.equal(k.default, 'per_plan');
  assert.equal(k.question, undefined);
  assert.equal(k.position, undefined);
});

test('config.mjs accepts phase_end and refuses any other string', () => {
  const dir = mkdtempSync(join(tmpdir(), 'diff-when-'));
  try {
    const check = (v) => JSON.parse(spawnSync(process.execPath, [join(REPO, 'cadence-core', 'bin', 'config.mjs'), 'check', `${KEY}=${v}`],
      { cwd: dir, encoding: 'utf8', env: { ...process.env, CADENCE_GLOBAL_CONFIG: join(dir, 'none.json') } }).stdout);
    assert.equal(check('phase_end').ok, true);
    assert.equal(check('per_plan').ok, true);
    assert.equal(check('sometimes').ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('locate reads the key and says phase_end is the only answer that moves the review', () => {
  const locate = step('locate');
  assert.ok(locate.includes(KEY));
  assert.match(locate, /answering `phase_end` means one diff review at phase end; any other answer, `null` included, means `per_plan`/);
});

test('execute_sequential skips the per-plan fire under phase_end and fires once after the last plan, before goal_check', () => {
  const seq = step('execute_sequential');
  const fire = seq.indexOf('Then fire the `diff` review trigger');
  const arm = seq.indexOf('`phase_end`', fire);
  assert.ok(fire > 0 && arm > fire, 'the phase_end arm sits inside the existing fire');
  const body = seq.slice(arm);
  assert.match(body, /this fire is not made per plan/);
  assert.match(body, /after the last plan of the dispatch set is reported done and before `goal_check`/);
  assert.match(body, /\{base_ref: PHASE_BASE, head_ref: HEAD\}/);
  // finding 1: the base is the phase's OLDEST phase_start anchor, so an earlier run's plans are inside the range
  assert.match(body, /PHASE_BASE is the phase's OLDEST `phase_start` anchor/);
  assert.match(body, /the `sha` on the first line of `grep '"event":"phase_start"' \.planning\/records\/trace\.jsonl` that carries `"phase":"<N>"`, and PHASE_START when there is none/);
  // finding 2: the fix has its own worker key and discriminator, so a plan's record, receipts and re-arm count are untouched
  assert.match(body, /under worker key `phase`, never a plan's/);
  assert.match(body, /\(`--plan phase`\)/);
  assert.match(body, /\(named by its own range, review-triggers\.md step 5, a re-arm counted on its own\)/);
  assert.match(body, /that fix's range gets its own `risk-check run` and `risk-check status`/);
});

test('execute-parallel.md: step 5 skips the per-plan diff fires and step 6 states phase_diff-else-diff, never both', () => {
  const five = slice(PARALLEL, '\n5. After all batches', '\n6. Fire the `phase_diff` trigger');
  const six = slice(PARALLEL, '\n6. Fire the `phase_diff` trigger', '\nThe lifecycle bracket');
  assert.match(five, /`phase_end`.* none of these per-plan `diff` fires is made/);
  assert.match(six, /`phase_end`, one review of `PHASE_BASE\.\.HEAD` fires here/);
  assert.match(six, /oldest `phase_start`\s+anchor as `execute_sequential` states it: `phase_diff` when its gate is not `off`, else `diff` with the same refs, never both/);
  // finding 3: the same worker key and the same risk-check run and status the sequential arm states
  assert.match(six, /fixed in the main tree by the continuation `cad-executor` under worker key `phase`, never a plan's/);
  assert.match(six, /gets its own `risk-check run`, any `risk_surface` fire \(named by its own range, step 5 of `references\/review-triggers\.md`\) and `risk-check status --plan phase`, before `goal_check`/);
});

test('review-triggers.md: the diff row names the phase_end fire and the phase_diff row says it stands in', () => {
  const row = (name) => flat(TRIGGERS.split('\n').find((l) => l.startsWith(`| \`${name}\` |`)));
  assert.match(row('diff'), /once at phase end over `<PHASE_BASE>\.\.HEAD` \(the phase's oldest `phase_start` anchor\) with `review\.triggers\.diff\.when: phase_end`/);
  assert.match(row('phase_diff'), /with `review\.triggers\.diff\.when: phase_end` it stands in for the `diff` fire/);
});

test('execute-workflow.md: the Step 5 bullet, the one-plan wave and Then each carry their own phase_end arm', () => {
  const bullet = slice(WORKFLOW, '- **Step 5, the suite and the risk sequence.**', '\n\nThe report on this path');
  assert.match(bullet, /Under `review\.triggers\.diff\.when` `phase_end`, those fires leave out each plan's `diff` trigger, and the `risk_surface` fires and each plan's `status` run as above/);
  const one = slice(WORKFLOW, '### A wave of one plan', '### Then');
  assert.match(one, /`phase_end` it takes `execute_sequential`'s skip of the per-plan `diff` fire and does not make its phase-end fire/);
  const then = slice(WORKFLOW, '### Then', '\n## 3.');
  assert.match(then, /`phase_end`, step 6 of `execute-parallel\.md` states the rule, and its review is the only phase-end `diff` review on this path whatever the width of the last wave/);
  assert.match(then, /the line above is not printed, because with `phase_diff` `off` step 6 fires `diff` over `PHASE_BASE\.\.HEAD`/);
});

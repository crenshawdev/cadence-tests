// Tests for lib/state-cursor.mjs, the STATE.md cursor parser planning-files
// re-exports. Run: node --test tests/state-cursor.test.mjs
//
// Not named planning-*: test-groups.test.mjs pins the `planning` group to
// exactly those files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCursor } from '../cadence-core/bin/lib/state-cursor.mjs';
import * as planningFiles from '../cadence-core/bin/lib/planning-files.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'cadence-core', 'bin');

const LINES = [
  'Phase: 2.1 of 4 (Fixture phase)',
  'Status: planned',
  'Next: /cad-execute 2.1',
  'Updated: 2026-10-04',
];
const STATE = `# State\n\n${LINES.join('\n')}\n`;

test('planning-files re-exports this parseCursor, not a copy', () => {
  assert.equal(planningFiles.parseCursor, parseCursor);
});

test('parses the canonical four lines, decimal phase included', () => {
  assert.deepEqual(parseCursor(STATE), {
    phase: 2.1, total: 4, name: 'Fixture phase',
    status: 'planned', next: '/cad-execute 2.1', updated: '2026-10-04',
  });
});

test('answers null when any one of the four lines is missing', () => {
  for (let i = 0; i < LINES.length; i++) {
    const text = `# State\n\n${LINES.filter((_, j) => j !== i).join('\n')}\n`;
    assert.equal(parseCursor(text), null, `without ${LINES[i]}`);
  }
});

test('agrees with planning.mjs cursor get on a fixture STATE.md', () => {
  const root = mkdtempSync(join(tmpdir(), 'state-cursor-'));
  try {
    mkdirSync(join(root, '.planning'));
    writeFileSync(join(root, '.planning', 'STATE.md'), STATE);
    const out = execFileSync(process.execPath,
      [join(BIN, 'planning.mjs'), '--dir', join(root, '.planning'), 'cursor', 'get'],
      { encoding: 'utf8' });
    const got = JSON.parse(out);
    const parsed = parseCursor(STATE);
    assert.ok(parsed);
    for (const key of /** @type {const} */ (['phase', 'total', 'status', 'next'])) {
      assert.equal(parsed[key], got[key], key);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a Status line with a long run of inner spaces parses in linear time', () => {
  const status = `a${' '.repeat(200000)}b`;
  const text = STATE.replace('Status: planned', `Status: ${status}`);
  const t0 = performance.now();
  const cursor = parseCursor(text);
  const ms = performance.now() - t0;
  assert.ok(ms < 250, `parseCursor took ${ms.toFixed(1)} ms`);
  assert.ok(cursor);
  assert.equal(cursor.status, `Status: ${status}  `.slice('Status:'.length).trim());
  assert.equal(cursor.next, '/cad-execute 2.1');
});

test('a Next value led by a line separator parses as it did before the linear rewrite', () => {
  for (const sep of ['\u2028', '\u2029']) {
    const cursor = parseCursor(STATE.replace('Next: /cad-execute 2.1', `Next: ${sep}/cad-execute 1`));
    assert.ok(cursor);
    assert.equal(cursor.next, '/cad-execute 1');
    assert.equal(parseCursor(STATE.replace('Status: planned', `Status: ${sep}planned`))?.status, 'planned');
  }
});

// --- the optional Plan: line (phase 1, D-01, D-06) -----------------------------

const BALEY = '# State\n\n'
  + "Phase: 8 of 8 (Plan grammar, evidence map and the planner's rules)\n"
  + 'Status: planned\nNext: /cad-execute 8\nUpdated: 2026-10-23\n';
const BALEY_FIELDS = {
  phase: 8, total: 8, name: "Plan grammar, evidence map and the planner's rules",
  status: 'planned', next: '/cad-execute 8', updated: '2026-10-23',
};
const withPlan = (line) => BALEY.replace(/(Phase: .*\n)/, `$1${line}\n`);

test('a four-line cursor written by 3.9.3 parses to exactly its six fields, and cursor get adds no key', () => {
  assert.deepEqual(parseCursor(BALEY), BALEY_FIELDS);
  assert.ok(!('plan' in parseCursor(BALEY)));
  const dir = mkdtempSync(join(tmpdir(), 'cad-cursor-'));
  try {
    mkdirSync(join(dir, '.planning'));
    writeFileSync(join(dir, '.planning', 'STATE.md'), BALEY);
    const out = JSON.parse(execFileSync(process.execPath,
      [join(BIN, 'planning.mjs'), 'cursor', 'get', '--dir', join(dir, '.planning')], { encoding: 'utf8' }));
    const { ok, ...fields } = out;
    assert.equal(ok, true);
    assert.deepEqual(fields, BALEY_FIELDS);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a Plan: line adds the plan field and changes no other field', () => {
  const named = parseCursor(withPlan('Plan: 2 of 3 (The cursor seams)'));
  assert.deepEqual(named, { ...BALEY_FIELDS, plan: { k: 2, j: 3, name: 'The cursor seams' } });
  const bare = parseCursor(withPlan('Plan: 2 of 3'));
  assert.deepEqual(bare, { ...BALEY_FIELDS, plan: { k: 2, j: 3 } });
  assert.ok(!('name' in bare.plan));
});

test('renderCursor reproduces a five-line cursor, and a plan-less one is the 3.9.3 text', () => {
  const five = withPlan('Plan: 2 of 3 (The cursor seams)');
  assert.equal(planningFiles.renderCursor(parseCursor(five)), five);
  const bare = withPlan('Plan: 2 of 3');
  assert.equal(planningFiles.renderCursor(parseCursor(bare)), bare);
  assert.equal(planningFiles.renderCursor(BALEY_FIELDS), BALEY);
});

test('a Plan: line outside the grammar is ignored, not a null cursor', () => {
  for (const line of ['Plan: banana', 'Plan: 2 of', 'Plan: 2 of 3 ()x', ' Plan: 2 of 3']) {
    assert.deepEqual(parseCursor(withPlan(line)), BALEY_FIELDS, line);
  }
});

test('a phase name containing Plan never reads as a Plan: line', () => {
  const text = BALEY.replace(/^Phase: .*$/m, 'Phase: 8 of 8 (Plan: 2 of 3 (x))');
  assert.ok(!('plan' in parseCursor(text)));
});

// Tests that every shipped config key sits in one of the six /cad-config groups. Run: node --test tests/config-groups.test.mjs
// Only node: builtins, no subprocess - it reads the shipped schema.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'cadence-core', 'config.schema.json'), 'utf8')).keys;

const GROUPS = ['Models and effort', 'When reviews run', 'Who reviews', 'Testing', 'Git and landing', 'How work runs'];
const shown = (k) => typeof SCHEMA[k].question === 'string';

// sha256 of the sorted [key, question] pairs of the walked keys at 4e90e431 (the end of Phase 1), leaving out the two
// keys whose question moved or left: workflow.use_workflows (lost " and the analyzer") and workflow.max_plan_bytes.
const WALK_QUESTIONS_SHA256 = '768cc4912e21daba574535a658905100796df566258df27ce273eec34674e7d9';
const LEFT_OUT = new Set(['workflow.use_workflows', 'workflow.max_plan_bytes']);

test('every key sits in exactly one of the six groups', () => {
  const stray = Object.keys(SCHEMA).filter((k) => !GROUPS.includes(SCHEMA[k].section));
  assert.deepEqual(stray, []);
});

test('no group shows more than 16 settings', () => {
  for (const group of GROUPS) {
    const n = Object.keys(SCHEMA).filter((k) => SCHEMA[k].section === group && shown(k)).length;
    assert.ok(n > 0 && n <= 16, `${group} shows ${n}`);
  }
});

test('a key with no question is Advanced and takes no position, and a key with one takes a position', () => {
  for (const k of Object.keys(SCHEMA)) {
    assert.equal(SCHEMA[k].position !== undefined, shown(k), k);
  }
});

test('the surviving walked questions are byte-identical to the end of Phase 1', () => {
  const pairs = Object.keys(SCHEMA).filter((k) => shown(k) && !LEFT_OUT.has(k)).sort()
    .map((k) => [k, SCHEMA[k].question]);
  assert.equal(createHash('sha256').update(JSON.stringify(pairs)).digest('hex'), WALK_QUESTIONS_SHA256);
});

test('workflow.use_workflows asks about reviews alone, its old text minus " and the analyzer"', () => {
  assert.equal(SCHEMA['workflow.use_workflows'].question,
    'Run reviews as workflows? One agent per reviewer and per finding burns usage fast. It runs only when this '
    + "repository's config and your user-global config both set it");
});

test('workflow.max_plan_bytes is Advanced under How work runs and keeps its purpose', () => {
  const spec = SCHEMA['workflow.max_plan_bytes'];
  assert.equal(spec.section, 'How work runs');
  assert.equal(shown('workflow.max_plan_bytes'), false);
  assert.ok(typeof spec.purpose === 'string' && spec.purpose.length > 0);
});

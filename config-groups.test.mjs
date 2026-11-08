// Tests that every shipped config key sits in one of the six /cad-config groups. Run: node --test tests/config-groups.test.mjs
// Only node: builtins, no subprocess - it reads the shipped schema.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'cadence-core', 'config.schema.json'), 'utf8')).keys;

const GROUPS = ['Models and effort', 'When reviews run', 'Who reviews', 'Testing', 'Git and landing', 'How work runs'];
const shown = (k) => typeof SCHEMA[k].question === 'string';

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

test('workflow.max_plan_bytes is Advanced under How work runs and keeps its purpose', () => {
  const spec = SCHEMA['workflow.max_plan_bytes'];
  assert.equal(spec.section, 'How work runs');
  assert.equal(shown('workflow.max_plan_bytes'), false);
  assert.ok(typeof spec.purpose === 'string' && spec.purpose.length > 0);
});

test('every key has a plain label', () => {
  const bare = Object.keys(SCHEMA).filter((k) => typeof SCHEMA[k].label !== 'string' || SCHEMA[k].label.trim() === '');
  assert.deepEqual(bare, []);
});

test('no two keys in one group share a label, ignoring case and spacing', () => {
  const seen = new Map();
  for (const k of Object.keys(SCHEMA)) {
    const id = `${SCHEMA[k].section}|${String(SCHEMA[k].label).toLowerCase().replace(/\s+/g, '')}`;
    assert.equal(seen.get(id), undefined, `${k} repeats the label of ${seen.get(id)}`);
    seen.set(id, k);
  }
});

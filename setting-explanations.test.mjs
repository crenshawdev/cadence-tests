// Tests for lib/setting-explanations.mjs - the two rules holding a schema key's
// `explain` entries to the key (D-13): an explained value the key refuses, and a
// `values` member of a walk key with no entry.
// Run: node --test tests/setting-explanations.test.mjs
//
// ONE test() per row, so a row that never ran cannot hide behind a loop's count.
// The expectations are stated here from what each key type accepts, not read
// back from config-value.mjs. Only node: builtins, no subprocess, no disk.
// The LIVE tree is asserted from the CLI in self-verify.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settingExplanationIssues } from '../cadence-core/bin/lib/setting-explanations.mjs';

/** Issue codes of a one-key schema. */
const codes = (spec) => settingExplanationIssues({ k: spec }).map((i) => i.code);
const e = (...values) => values.map((value) => ({ value }));

const ENUM = { type: 'enum', values: ['a', 'b', null], default: 'a' };
const LIST = { type: 'array_enum', values: ['x', 'y'], default: ['x'] };

// --- refused ---------------------------------------------------------------

test('refused: a non-member on an enum', () => {
  const i = settingExplanationIssues({ k: { ...ENUM, explain: e('a', 'c') } });
  assert.deepEqual(i.map((x) => x.code), ['explained-value-refused']);
  assert.match(i[0].detail, /^k:/);
  assert.match(i[0].detail, /"c"/);
});

test('refused: the string "true" on a bool', () => {
  assert.deepEqual(codes({ type: 'bool', default: false, explain: e('true') }), ['explained-value-refused']);
});

test('refused: a non-member on an array_enum', () => {
  assert.deepEqual(codes({ ...LIST, explain: e('x', 'z') }), ['explained-value-refused']);
});

test('refused: a string failing the grammar on a string_or_null key', () => {
  const spec = { type: 'string_or_null', grammar: 'model_id', default: null };
  assert.deepEqual(codes({ ...spec, explain: e('has space') }), ['explained-value-refused']);
  assert.deepEqual(codes({ ...spec, explain: e('gpt-5', null) }), []);
});

test('refused: null on a list key whose default is not null', () => {
  assert.deepEqual(codes({ ...LIST, explain: e(null) }), ['explained-value-refused']);
});

test('refused: an enum entry equal to a default that values no longer holds', () => {
  const spec = { type: 'enum', values: ['a', 'b'], default: 'gone', explain: e('a', 'b', 'gone') };
  const i = settingExplanationIssues({ k: spec });
  assert.deepEqual(i.map((x) => x.code), ['explained-value-refused']);
  assert.match(i[0].detail, /"gone"/);
});

// --- accepted --------------------------------------------------------------

test('accepted: null on a list key whose default is null', () => {
  assert.deepEqual(codes({ ...LIST, default: null, explain: e(null, 'x') }), []);
});

test('accepted: a bare entry with no text', () => {
  assert.deepEqual(codes({ ...ENUM, explain: [{ value: 'a' }] }), []);
});

test('accepted: a member of an array_enum is tested as a one-member list', () => {
  assert.deepEqual(codes({ ...LIST, explain: [{ value: 'x', text: 't' }, { value: 'y' }] }), []);
});

// --- missing ---------------------------------------------------------------

test('missing: a dropped values member on a question-bearing key', () => {
  const i = settingExplanationIssues({ k: { ...ENUM, question: 'q?', explain: e('a', null) } });
  assert.deepEqual(i.map((x) => x.code), ['explained-value-missing']);
  assert.match(i[0].detail, /^k:/);
  assert.match(i[0].detail, /"b"/);
});

test('missing: a dropped null on a question-bearing key', () => {
  const i = settingExplanationIssues({ k: { ...ENUM, question: 'q?', explain: e('a', 'b') } });
  assert.deepEqual(i.map((x) => x.code), ['explained-value-missing']);
  assert.match(i[0].detail, /null/);
});

test('missing: a dropped false on a question-bearing bool', () => {
  const i = settingExplanationIssues({ k: { type: 'bool', default: true, question: 'q?', explain: e(true) } });
  assert.deepEqual(i.map((x) => x.code), ['explained-value-missing']);
  assert.match(i[0].detail, /false/);
});

test('missing: a question-bearing bool with both entries is complete', () => {
  assert.deepEqual(codes({ type: 'bool', default: true, question: 'q?', explain: e(true, false) }), []);
});

// --- clean -----------------------------------------------------------------

test('clean: a key with values, no question and no entries', () => {
  assert.deepEqual(codes(ENUM), []);
});

// Tests for lib/plain-words.mjs - the mechanical plain-words rules over config.schema.json (phase 6, D-06):
// a walked key with no label, two labels in one section that match, an option with no text, and a question or
// label holding a dotted key, a backtick or an internal term. Voice is judged at the diff review, not here.
// Run: node --test tests/plain-words.test.mjs
//
// The rules are stated from the plan, each on the smallest schema that breaks it. The last test reads the shipped
// schema and wants no issue at all; self-verify runs the same lib as check 30.
// Only node: builtins, no subprocess.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { plainWordsIssues, internalTermIn, INTERNAL_TERMS } from '../cadence-core/bin/lib/plain-words.mjs';

const CLEAN = { type: 'bool', default: false, section: 'One', position: 1, label: 'Research step',
  question: 'Run a research pass first?', explain: [{ value: true, text: 'scout first' }, { value: false, text: 'skip' }] };

/** Issues of a schema built from key -> spec pairs. */
const issues = (keys) => plainWordsIssues(keys);
const only = (keys, code, key) => {
  const got = issues(keys);
  assert.deepEqual(got.map((i) => i.code), [code], JSON.stringify(got));
  assert.match(got[0].detail, new RegExp(`^${key.replace(/\./g, '\\.')}: `));
  return got[0];
};

// --- the four rules --------------------------------------------------------

test('label: a walked key with no label is filed, naming the key', () => {
  const { label, ...bare } = CLEAN;
  only({ 'demo.a': bare }, 'label-missing', 'demo.a');
  only({ 'demo.a': { ...CLEAN, label: '  ' } }, 'label-missing', 'demo.a');
});

test('label: an Advanced key with no label is not filed', () => {
  assert.deepEqual(issues({ 'demo.a': { type: 'bool', default: false, section: 'One' } }), []);
});

test('label: two labels in one section differing only in case or spacing are filed on the second', () => {
  const i = only({ 'demo.a': CLEAN, 'demo.b': { ...CLEAN, label: 'research  STEP' } }, 'label-duplicate', 'demo.b');
  assert.match(i.detail, /demo\.a/);
});

test('label: Advanced keys count toward a duplicate, and another section does not', () => {
  only({ 'demo.a': CLEAN, 'demo.b': { type: 'bool', default: false, section: 'One', label: 'Research step' } },
    'label-duplicate', 'demo.b');
  assert.deepEqual(issues({ 'demo.a': CLEAN, 'demo.b': { ...CLEAN, section: 'Two' } }), []);
});

test('option text: an explain entry with no text is filed, the null entry included', () => {
  only({ 'demo.a': { ...CLEAN, explain: [{ value: true, text: 'scout first' }, { value: false }] } },
    'option-text-missing', 'demo.a');
  const i = only({ 'demo.a': { ...CLEAN, explain: [{ value: null, text: '' }] } }, 'option-text-missing', 'demo.a');
  assert.match(i.detail, /null/);
});

test('option text: an Advanced key is outside the rule', () => {
  const { question, ...advanced } = CLEAN;
  assert.deepEqual(issues({ 'demo.a': { ...advanced, explain: [{ value: true }] } }), []);
});

test('words: a question holding a dotted key is filed', () => {
  const i = only({ 'demo.a': { ...CLEAN, question: 'Does demo.other matter here?' } }, 'plain-words-dotted-key', 'demo.a');
  assert.match(i.detail, /question/);
  assert.match(i.detail, /demo\.other/);
});

test('words: a label holding backticks is filed', () => {
  const i = only({ 'demo.a': { ...CLEAN, label: 'The `x` step' } }, 'plain-words-backtick', 'demo.a');
  assert.match(i.detail, /label/);
});

test('words: a question holding "dispatched" is filed', () => {
  const i = only({ 'demo.a': { ...CLEAN, question: 'Should work be dispatched in parallel?' } }, 'plain-words-internal-term', 'demo.a');
  assert.match(i.detail, /dispatched/);
});

test('words: a key with no question still has its label held', () => {
  only({ 'demo.a': { type: 'bool', default: false, section: 'One', label: 'Uses the orchestrator' } },
    'plain-words-internal-term', 'demo.a');
});

test('words: "e.g." is prose and a version number is not a key', () => {
  assert.deepEqual(issues({ 'demo.a': { ...CLEAN, question: 'Pick one, e.g. 3, or the v3.8 way, i.e. the old one?' } }), []);
});

test('a clean schema, and a schema that is not an object, give none', () => {
  assert.deepEqual(issues({ 'demo.a': CLEAN, 'demo.b': { ...CLEAN, label: 'Another step' }, 'demo.c': 'not a spec' }), []);
  assert.deepEqual(issues(null), []);
});

// --- the line matcher ------------------------------------------------------

test('terms: inflections are caught and a longer ordinary word is not', () => {
  assert.equal(internalTermIn('Do not re-dispatch it'), 'dispatch');
  assert.equal(internalTermIn('Two RUNGS apart'), 'RUNGS');
  assert.equal(internalTermIn('It was triaged twice'), 'triaged');
  assert.equal(internalTermIn('Used for adjudication'), 'adjudication');
  assert.equal(internalTermIn('A deep-pass check'), 'deep-pass');
  assert.equal(internalTermIn('Leave it to the cross model reviewers'), 'cross model');
  assert.equal(internalTermIn('A seamless fit'), null);
  assert.equal(internalTermIn('The reaper and the dispatcher'), null);
  assert.equal(internalTermIn('Branches Cadence will not commit to'), null);
});

test('terms: every listed term is caught as itself', () => {
  for (const t of INTERNAL_TERMS) assert.equal(internalTermIn(`about ${t} here`)?.toLowerCase(), t, t);
});

// --- the shipped schema ----------------------------------------------------

test('the shipped schema: no plain-words issue anywhere', () => {
  const schema = JSON.parse(readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'cadence-core', 'config.schema.json'), 'utf8')).keys;
  assert.deepEqual(plainWordsIssues(schema), []);
});

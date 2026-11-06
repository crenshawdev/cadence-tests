// Zero-dep tests for lib/setting-conditions.mjs: the evaluator that says whether a setting applies, and the rule
// self-verify files against `applies_when`. Every expectation is hand-computed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appliesAnswer, dependentsOf } from '../cadence-core/bin/lib/setting-conditions.mjs';

const values = { 'g.gate': 'off', 'g.list': ['a', 'b'], 'g.none': null, 'g.n': 3 };

test('not: equal fails, different holds', () => {
  assert.deepEqual(appliesAnswer([{ key: 'g.gate', not: 'off' }], values), { applies: false, why: ['g.gate is off'] });
  assert.deepEqual(appliesAnswer([{ key: 'g.gate', not: 'on' }], values), { applies: true, why: [] });
});

test('is: different fails and says what it wanted, equal holds', () => {
  assert.deepEqual(appliesAnswer([{ key: 'g.gate', is: 'on' }], values), { applies: false, why: ['g.gate is off, not on'] });
  assert.equal(appliesAnswer([{ key: 'g.gate', is: 'off' }], values).applies, true);
});

test('includes: a list holding the member holds, one without it or a non-list fails', () => {
  assert.equal(appliesAnswer([{ key: 'g.list', includes: 'b' }], values).applies, true);
  assert.deepEqual(appliesAnswer([{ key: 'g.list', includes: 'z' }], values),
    { applies: false, why: ['g.list is ["a","b"], which doesn\'t include z'] });
  assert.equal(appliesAnswer([{ key: 'g.gate', includes: 'off' }], values).applies, false);
});

test('not and is compare lists by deep equality, and not: null is a real condition', () => {
  assert.equal(appliesAnswer([{ key: 'g.list', not: ['a', 'b'] }], values).applies, false);
  assert.equal(appliesAnswer([{ key: 'g.list', not: ['b', 'a'] }], values).applies, true);
  assert.deepEqual(appliesAnswer([{ key: 'g.none', not: null }], values), { applies: false, why: ['g.none is null'] });
  assert.equal(appliesAnswer([{ key: 'g.n', not: null }], values).applies, true);
});

test('two failed conditions name both, and one that holds adds nothing', () => {
  const r = appliesAnswer([{ key: 'g.gate', not: 'off' }, { key: 'g.n', not: 5 }, { key: 'g.list', not: ['a', 'b'] }], values);
  assert.deepEqual(r, { applies: false, why: ['g.gate is off', 'g.list is ["a","b"]'] });
});

test('no field applies', () => {
  assert.deepEqual(appliesAnswer(undefined, values), { applies: true, why: [] });
});

test('a condition it cannot read never claims no effect', () => {
  assert.equal(appliesAnswer([{ key: 'g.gone', not: 'off' }], values).applies, true);
  assert.equal(appliesAnswer([{ key: 'g.gate', nott: 'off' }], values).applies, true);
  assert.equal(appliesAnswer([{ key: 'g.gate', not: 'off', is: 'off' }], values).applies, true);
  assert.equal(appliesAnswer(['g.gate'], values).applies, true);
  assert.equal(appliesAnswer({ key: 'g.gate', not: 'off' }, values).applies, true);
});

test('dependentsOf lists the keys whose conditions name this one', () => {
  const keys = { a: {}, b: { applies_when: [{ key: 'a', not: 1 }] }, c: { applies_when: [{ key: 'z', is: 1 }, { key: 'a', is: 2 }] }, d: { applies_when: 'a' } };
  assert.deepEqual(dependentsOf(keys, 'a'), ['b', 'c']);
});

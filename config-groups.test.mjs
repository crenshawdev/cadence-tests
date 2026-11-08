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

// The four reviews each get their own plain name, and no name holds another, so a question that names the wrong review shows.
const REVIEWS = { plan: 'plan review', diff: 'commit review', risk_surface: 'risky code review', phase_diff: 'phase review' };

test('the 12 review gate, tier and effort questions are 12 different texts, each naming only its own review', () => {
  const all = [];
  for (const [t, name] of Object.entries(REVIEWS)) {
    for (const field of ['gate', 'tier', 'effort']) {
      const q = SCHEMA[`review.triggers.${t}.${field}`].question.toLowerCase();
      all.push(q);
      assert.ok(q.includes(name), `${t}.${field} does not name the ${name}`);
      for (const other of Object.values(REVIEWS).filter((n) => n !== name)) {
        assert.ok(!q.includes(other), `${t}.${field} names the ${other}`);
      }
    }
  }
  assert.equal(new Set(all).size, 12);
});

// D-13: the roles interview /cad-new-project runs asks the schema's 13 questions, so an edit to one copy alone shows here.
test('the roles interview in config.md asks the schema\'s 13 roles questions word for word', () => {
  const md = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'cadence-core', 'workflows', 'config.md'), 'utf8');
  const interview = md.slice(md.indexOf('## Roles interview'), md.indexOf('## Stakes migration')).replace(/\s+/g, ' ');
  const roles = ['cad-planner', 'cad-assumptions-analyzer', 'cad-verifier', 'cad-reviewer', 'cad-executor', 'cad-plan-checker'];
  const keys = [...roles.flatMap((r) => [`roles.${r}.model`, `roles.${r}.effort`]), 'review.triggers.risk_surface.waive_routing_floor'];
  assert.equal(keys.length, 13);
  for (const k of keys) {
    assert.ok(interview.includes(SCHEMA[k].question.replace(/\s+/g, ' ')), `${k}: the interview does not ask the schema's question`);
  }
});

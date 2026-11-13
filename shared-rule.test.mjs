// Zero-dep tests for lib/shared-rule.mjs, the LSP-then-grep rule held once. Run:
// node --test tests/shared-rule.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHARED_RULE, SHARED_SKILL, carriesSharedRule } from '../cadence-core/bin/lib/shared-rule.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

test('a text carrying the rule, rewrapped, carries it', () => {
  const wrapped = SHARED_RULE.replace(/ (?=definitions)/, '\n').replace(/ (?=If it errors)/, '\n\n   ');
  assert.equal(carriesSharedRule(`intro\n${wrapped}\nmore`), true);
});

test('a text with one word of the rule changed does not carry it', () => {
  assert.equal(carriesSharedRule(SHARED_RULE.replace('before grep', 'after grep')), false);
});

test('the rule says "the LSP tool" in those words, so the tools lint reads it as naming LSP', () => {
  assert.ok(SHARED_RULE.includes('the LSP tool'), SHARED_RULE);
});

test('the live shared skill carries the rule and none of the seven role contracts does', () => {
  assert.equal(carriesSharedRule(readFileSync(join(REPO, 'skills', SHARED_SKILL, 'SKILL.md'), 'utf8')), true);
  const contracts = readdirSync(join(REPO, 'skills')).filter((d) => d.endsWith('-contract'));
  assert.equal(contracts.length, 7, contracts.join(', '));
  for (const c of contracts) {
    assert.equal(carriesSharedRule(readFileSync(join(REPO, 'skills', c, 'SKILL.md'), 'utf8')), false, c);
  }
});

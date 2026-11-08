// Who Cadence is for: the front page and the guide share one opening sentence, and the old audience claim stays gone.
// Run: node --test tests/audience.test.mjs. Only node: builtins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(`${root}${rel}`, 'utf8');
const OLD_AUDIENCE = /single[- ]developer/i;

// the first sentence of the first paragraph that follows the bold tagline
function openingSentence(rel) {
  const lines = read(rel).split('\n');
  const tagline = lines.findIndex((l) => l.startsWith('**'));
  assert.notEqual(tagline, -1, `${rel} has no tagline line`);
  const first = lines.slice(tagline + 1).find((l) => l.trim() !== '');
  assert.ok(first, `${rel} has no paragraph after the tagline`);
  return first.match(/^.*?\.(?=\s|$)/)[0];
}

test('README and the guide open with the same sentence', () => {
  assert.equal(openingSentence('README.md'), openingSentence('docs/guide/index.md'));
});

test('the front page, the guide and the contributing page drop the old audience claim', () => {
  for (const rel of ['README.md', 'docs/guide/index.md', 'docs/guide/contributing.md']) {
    assert.doesNotMatch(read(rel), OLD_AUDIENCE, rel);
  }
});

test('contributing keeps its scope point in the feature paragraph, without an audience claim', () => {
  const para = read('docs/guide/contributing.md').split(/\n\s*\n/).find((p) => p.startsWith('For a feature'));
  assert.ok(para, 'no paragraph begins "For a feature"');
  assert.match(para, /issue/);
  assert.match(para, /scope/);
  assert.doesNotMatch(para, OLD_AUDIENCE);
});

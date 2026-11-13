// Zero-dep tests for lib/frontmatter.mjs - the one reader of an agent file's `skills:` value.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FRONTMATTER_RE, parseSkillsField } from '../cadence-core/bin/lib/frontmatter.mjs';

const block = ['---', 'name: a', 'skills:', '  - one', '  - two', 'model: x', '---', 'body', ''].join('\n');
const inline = ['---', 'name: a', 'skills: [one, two]', 'model: x', '---', 'body', ''].join('\n');

for (const [label, lf] of [['block-list', block], ['inline', inline]]) {
  test(`a CRLF agent file with ${label} skills: matches FRONTMATTER_RE and reads its LF twin's names`, () => {
    const crlf = lf.replace(/\n/g, '\r\n');
    const m = crlf.match(FRONTMATTER_RE);
    assert.ok(m, 'the CRLF block matched');
    assert.deepEqual(parseSkillsField(m[1]), ['one', 'two']);
    assert.deepEqual(parseSkillsField(m[1]), parseSkillsField(lf.match(FRONTMATTER_RE)[1]));
  });
}

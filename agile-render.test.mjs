// Zero-dep tests for lib/agile-render.mjs - a read Seldon design as the agile path's files.
// Run: node --test tests/agile-render.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDesignFolder } from '../cadence-core/bin/planning/design-read.mjs';
import {
  renderEpicFile, renderProjectFile, renderReleaseFile, renderRequirementsFile,
} from '../cadence-core/bin/lib/agile-render.mjs';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'seldon-design');
const design = () => {
  const { read, issues } = readDesignFolder(FIXTURE);
  assert.deepEqual(issues, []);
  return read.design;
};

test('each epic file holds its own epic: fields, done-when items, what it builds on and its spine decisions', () => {
  const d = design();
  const texts = d.phases.map(renderEpicFile);
  for (const [i, e] of d.phases.entries()) {
    const text = texts[i];
    assert.match(text, new RegExp(`^---\\nepic: ${e.epic}\\ntitle: ${e.name}\\nstatus: backlog\\n`));
    assert.ok(text.includes(`requirements: ${e.requirements.join(', ')}\n---`));
    assert.ok(text.includes(`## Outcome\n\n${e.description}\n`));
    for (const c of e.success_criteria) assert.ok(text.includes(`- ${c}\n`), c);
    for (const s of e.spine_decisions) assert.ok(text.includes(`- **${s.id}: ${s.title}** (${s.kind}): ${s.text}`), s.id);
    for (const [j, other] of d.phases.entries()) if (j !== i) assert.ok(!text.includes(`# ${other.epic}:`));
  }
  assert.match(texts[0], /\nbuilds_on: None\n/);
  assert.match(texts[1], /\nbuilds_on: E-01\n/);
  // boundaries alone, without the old path's "It's epic E-01 of the Seldon design" tail
  assert.match(texts[0], /## Boundaries\n\nTools and their categories only\. No loans and no member records\.\n\n## Done when/);
});

test('an epic with no spine decision says None', () => {
  const [e] = design().phases;
  assert.match(renderEpicFile({ ...e, spine_decisions: [] }), /## Spine decisions\n\nNone\.\n/);
});

test('requirements are the design\'s, in Seldon\'s bullet, each once under its category, with nothing deferred', () => {
  const d = design();
  const text = renderRequirementsFile(d.title, d.requirements);
  for (const q of d.requirements) assert.equal(text.split(`- **${q.id}**: ${q.text}\n`).length, 2, q.id);
  assert.ok(text.endsWith('## Deferred\n\nNone.\n'));
  assert.equal(text.match(/^### /gm).length, new Set(d.requirements.map((q) => q.category)).size);
});

test('the release lists its epics in order under the brief\'s goal, and the project holds the brief\'s words', () => {
  const d = design();
  const release = renderReleaseFile(d.title, d.brief, d.phases);
  assert.ok(release.includes(`## Goal\n\n${d.brief['Success criteria']}\n`));
  assert.ok(release.endsWith(`## Epics\n\n${d.phases.map((e) => `- ${e.epic}: ${e.name}`).join('\n')}\n`));
  const project = renderProjectFile(d.title, d.brief, d.phases);
  for (const section of Object.values(d.brief)) assert.ok(project.includes(section));
  const limits = [...new Set(d.phases.flatMap((e) => e.spine_decisions).filter((s) => ['stack', 'hosting'].includes(s.kind)).map((s) => s.id))];
  for (const s of d.phases.flatMap((e) => e.spine_decisions).filter((x) => limits.includes(x.id))) {
    assert.equal(project.split(`- **${s.kind}**: ${s.title} - ${s.text}`).length, 2, s.id);
  }
});

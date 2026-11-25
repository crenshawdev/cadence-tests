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
const read = () => {
  const got = readDesignFolder(FIXTURE);
  assert.deepEqual(got.issues, []);
  return got.read;
};
const design = () => read().design;

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
  const project = renderProjectFile(d.title, d.brief, d.phases, [...read().decisions.values()]);
  for (const section of Object.values(d.brief)) assert.ok(project.includes(section));
});

test('every spine decision is in some file, the one no epic names included', () => {
  const { design: d, decisions } = read();
  const [first] = decisions.values();
  const extra = [
    { id: 'S-90', title: 'Nightly backups', kind: 'hosting', text: 'Copied each night.' },
    { id: 'S-91', title: 'One clock', kind: 'design approach', text: 'All times are UTC.' },
  ];
  const all = [...decisions.values(), ...extra];
  const project = renderProjectFile(d.title, d.brief, d.phases, all);
  const limits = project.slice(project.indexOf('## Constraints'), project.indexOf('## Key decisions'));
  const key = project.slice(project.indexOf('## Key decisions'));
  for (const s of all.filter((x) => ['stack', 'hosting'].includes(x.kind))) {
    assert.equal(limits.split(`- **${s.id}: ${s.title}** (${s.kind}): ${s.text}`).length, 2, s.id);
  }
  assert.ok(key.includes('- **S-91: One clock** (design approach): All times are UTC.'));
  assert.ok(!key.includes(`**${first.id}:`));
  const epics = d.phases.map(renderEpicFile).join('\n');
  for (const s of all) assert.ok((project + epics).includes(`- **${s.id}: ${s.title}** (${s.kind}): ${s.text}`), s.id);
});

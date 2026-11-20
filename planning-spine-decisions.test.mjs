// Zero-dep tests for the spine decision reader and `planning.mjs spine-decisions`. Run:
// node --test tests/planning-spine-decisions.test.mjs
//
// Every ROADMAP here is the fixture design under fixtures/seldon-design/,
// rendered from phase 3 the way design-read renders it. Expected values are
// typed from the fixture's spine.md, never taken from the renderer.
//
// The `test` binding below is a no-op unless this module IS the entry file, so
// a sibling that imports from here registers nothing twice.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryFile } from './planning.test.mjs';
import { renderSections } from '../cadence-core/bin/lib/design-render.mjs';
import { phaseSpineDecisions } from '../cadence-core/bin/lib/planning-files.mjs';
import { DESIGN_FILES, readDesign } from '../cadence-core/bin/lib/seldon-design.mjs';

/** `node:test`'s `test` when run directly, a no-op when imported (see header). */
const test = isEntryFile(import.meta.url) ? nodeTest : () => {};

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'seldon-design');

// the fixture's six decisions as spine.md has them, the S-03 quote dropped and its two paragraphs joined
const SPINE = {
  'S-01': { title: 'Loans are an append-only event log', kind: 'how state changes',
    text: 'Checkouts and returns are stored as events and never edited. Who has a tool, and whether it\'s overdue, is computed from the log.' },
  'S-02': { title: 'One server-rendered web app', kind: 'design approach',
    text: 'The counter screens and the public catalog are pages of one app. There\'s no separate API.' },
  'S-03': { title: 'Reminders run from a daily scheduled job', kind: 'boundaries',
    text: 'A job runs once a day, reads the loan log and sends that day\'s reminders. Nothing sends email while a request is being handled.'
      + ' When a run fails, the counter screen shows the volunteers a notice naming the reminders that didn\'t go out,'
      + ' until a volunteer dismisses it. [ASSUMPTION]' },
  'S-04': { title: 'Node with one SQLite database', kind: 'stack',
    text: 'The app runs on Node and keeps the catalog, the members and the loan log in one SQLite database file. [ASSUMPTION]' },
  'S-05': { title: 'One small rented server', kind: 'hosting',
    text: 'The app and its database file run on one small rented virtual server. [ASSUMPTION]' },
  'S-06': { title: 'Members reach only the catalog', kind: 'boundaries',
    text: 'The catalog pages are the only part members and the public reach from outside, and what they type there is only'
      + ' ever read as search text. Member emails and addresses sit behind the volunteer login, and no catalog page shows them. [ASSUMPTION]' },
};

/**
 * A ROADMAP holding the fixture design's sections from phase 3, each named document passed through its edit first.
 * @param {Record<string, (text: string) => string>} [edits]
 */
function roadmap(edits = {}) {
  const texts = Object.fromEntries(DESIGN_FILES.map((f) => {
    const raw = readFileSync(join(FIXTURE, f), 'utf8');
    return [f, edits[f] ? edits[f](raw) : raw];
  }));
  return `# Roadmap\n\n## Phase Details\n\n${renderSections(readDesign(texts, 3).design.phases)}`;
}

/** The index of the first line from `from` that starts with `prefix`. @param {string[]} lines */
const indexFrom = (lines, from, prefix) => lines.findIndex((l, i) => i >= from && l.startsWith(prefix));

const NONE = { found: false, title: null, decisions: [], problems: [] };

// --- the reader ----------------------------------------------------------------

test('phaseSpineDecisions: phase 4 gives S-01 to S-06 in order, byte for byte, with the design title', () => {
  const text = roadmap();
  const r = phaseSpineDecisions(text, 4);
  assert.equal(r.found, true);
  assert.equal(r.title, 'Toolshed');
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.decisions.map(({ id, title, kind, text: said }) => ({ id, title, kind, text: said })),
    Object.entries(SPINE).map(([id, d]) => ({ id, ...d })));
  const s03 = r.decisions[2];
  assert.equal(s03.kind, 'boundaries');
  assert.equal(s03.title, 'Reminders run from a daily scheduled job');
  assert.ok(s03.text.endsWith(' [ASSUMPTION]'));
  const lines = text.split('\n');
  r.decisions.forEach((d, k) => assert.ok(lines[d.line - 1].startsWith(`- **S-0${k + 1}: `), `${d.id} at line ${d.line}`));
});

test('phaseSpineDecisions: phase 3 gives only the decisions its epic names', () => {
  assert.deepEqual(phaseSpineDecisions(roadmap(), 3).decisions.map((d) => d.id), ['S-02', 'S-04', 'S-05', 'S-06']);
});

test('phaseSpineDecisions: a design title holding quotes comes back whole', () => {
  const r = phaseSpineDecisions(roadmap({ 'brief.md': (s) => s.replace('# Toolshed\n', '# The "Toolshed" library\n') }), 4);
  assert.equal(r.title, 'The "Toolshed" library');
  assert.deepEqual(r.problems, []);
});

test('phaseSpineDecisions: no field, no section, or a field only inside a fence is the no-field answer', () => {
  const hand = '# Roadmap\n\n## Phase Details\n\n### Phase 7: Hand\n**Goal:** Ship it.\n**Requirements:** CAT-01\n'
    + '**Success Criteria:**\n1. It ships.\n';
  assert.deepEqual(phaseSpineDecisions(hand, 7), NONE);
  assert.deepEqual(phaseSpineDecisions(roadmap(), 9), NONE);
  const fenced = '# Roadmap\n\n## Phase Details\n\n### Phase 7: Hand\n'
    + '**Goal:** Ship it. It\'s epic E-01 of the Seldon design "Toolshed".\n```\n**Spine decisions:**\n'
    + '- **S-01: Loans are an append-only event log** (how state changes): Checkouts are events.\n```\n';
  assert.deepEqual(phaseSpineDecisions(fenced, 7), NONE);
});

test('phaseSpineDecisions: every bad line is one problem in line order, beside the decisions that parsed', () => {
  const lines = roadmap().split('\n');
  const head = lines.indexOf('### Phase 4: Lending');
  const s02 = indexFrom(lines, head, '- **S-02: ');
  lines[s02] = '- S-02: One server-rendered web app';
  const prose = indexFrom(lines, head, '- **S-06: ') + 1;
  lines.splice(prose, 0, 'A stray line of prose.');
  const r = phaseSpineDecisions(lines.join('\n'), 4);
  assert.deepEqual(r.problems, [
    { line: s02 + 1, text: '- S-02: One server-rendered web app' },
    { line: prose + 1, text: 'A stray line of prose.' },
  ]);
  assert.deepEqual(r.decisions.map((d) => d.id), ['S-01', 'S-03', 'S-04', 'S-05', 'S-06']);
  assert.equal(r.title, 'Toolshed');
});

test('phaseSpineDecisions: a Goal without its closing sentence is one problem, and the decisions still come back', () => {
  const text = roadmap().replace(' It\'s epic E-02 of the Seldon design "Toolshed".', '');
  const goal = text.split('\n').indexOf(
    '**Goal:** Volunteers check tools out and in at the counter. Members, checkouts and returns. Reminders are not part of it.');
  assert.ok(goal > 0);
  const r = phaseSpineDecisions(text, 4);
  assert.deepEqual(r.problems, [{ line: goal + 1,
    text: '**Goal:** Volunteers check tools out and in at the counter. Members, checkouts and returns. Reminders are not part of it.' }]);
  assert.equal(r.title, null);
  assert.equal(r.decisions.length, 6);
});

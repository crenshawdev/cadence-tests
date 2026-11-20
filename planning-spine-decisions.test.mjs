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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryFile, run, scratch, stampState, treeOf } from './planning.test.mjs';
import { renderSections } from '../cadence-core/bin/lib/design-render.mjs';
import { parseContextDecisions, phaseSpineDecisions } from '../cadence-core/bin/lib/planning-files.mjs';
import { DESIGN_FILES, readDesign } from '../cadence-core/bin/lib/seldon-design.mjs';
import { contextDecisions } from '../cadence-core/bin/lib/why-record.mjs';

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

// --- the seam: planning.mjs spine-decisions --------------------------------------

/**
 * A stamped scratch project whose ROADMAP.md holds design-read's sections for the fixture from phase 3, passed through
 * `edit` first, or no ROADMAP.md at all when `edit` answers null.
 * @param {any} t @param {(text: string) => string|null} [edit]
 */
function project(t, edit = (s) => s) {
  const read = run(['design-read', '--design', FIXTURE, '--first-phase', '3'], scratch('spine-design-dir-', t));
  assert.equal(read.ok, true, JSON.stringify(read));
  const dir = join(scratch('spine-decisions-', t), '.planning');
  mkdirSync(dir, { recursive: true });
  stampState(dir);
  const text = edit(`# Roadmap\n\n## Phase Details\n\n${read.sections_text}`);
  if (text !== null) writeFileSync(join(dir, 'ROADMAP.md'), text);
  return dir;
}

const LOCKED = [
  '- D-01 (how state changes): Loans are an append-only event log. Checkouts and returns are stored as events and never edited.'
    + ' Who has a tool, and whether it\'s overdue, is computed from the log. Evidence: S-01 of the Seldon design "Toolshed".',
  '- D-02 (design approach): One server-rendered web app. The counter screens and the public catalog are pages of one app.'
    + ' There\'s no separate API. Evidence: S-02 of the Seldon design "Toolshed".',
  '- D-03 (boundaries): Reminders run from a daily scheduled job. A job runs once a day, reads the loan log and sends that day\'s'
    + ' reminders. Nothing sends email while a request is being handled. When a run fails, the counter screen shows the'
    + ' volunteers a notice naming the reminders that didn\'t go out, until a volunteer dismisses it. [ASSUMPTION]'
    + ' Evidence: S-03 of the Seldon design "Toolshed".',
  '- D-04 (stack): Node with one SQLite database. The app runs on Node and keeps the catalog, the members and the loan log in'
    + ' one SQLite database file. [ASSUMPTION] Evidence: S-04 of the Seldon design "Toolshed".',
  '- D-05 (hosting): One small rented server. The app and its database file run on one small rented virtual server.'
    + ' [ASSUMPTION] Evidence: S-05 of the Seldon design "Toolshed".',
  '- D-06 (boundaries): Members reach only the catalog. The catalog pages are the only part members and the public reach from'
    + ' outside, and what they type there is only ever read as search text. Member emails and addresses sit behind the'
    + ' volunteer login, and no catalog page shows them. [ASSUMPTION] Evidence: S-06 of the Seldon design "Toolshed".',
].map((l) => `${l}\n`).join('');

test('spine-decisions: phase 4 answers D-01 to D-06 for S-01 to S-06, as the text to lock', (t) => {
  const dir = project(t);
  const r = run(['spine-decisions', '--phase', '4'], dir);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r._exit, 0);
  assert.equal(r.design_title, 'Toolshed');
  assert.equal(r.count, 6);
  assert.deepEqual(r.decisions.map((d) => [d.id, d.spine_id]),
    [['D-01', 'S-01'], ['D-02', 'S-02'], ['D-03', 'S-03'], ['D-04', 'S-04'], ['D-05', 'S-05'], ['D-06', 'S-06']]);
  const lines = readFileSync(join(dir, 'ROADMAP.md'), 'utf8').split('\n');
  for (const d of r.decisions) assert.ok(lines[d.line - 1].startsWith(`- **${d.spine_id}: `), `${d.id} at line ${d.line}`);
  assert.equal(r.text, LOCKED);
  const locked = r.text.split('\n');
  assert.ok(locked[2].endsWith('dismisses it. [ASSUMPTION] Evidence: S-03 of the Seldon design "Toolshed".'));
  assert.ok(locked[0].startsWith('- D-01 (how state changes): Loans are an append-only event log. Checkouts'));
});

test('spine-decisions: phase 3 numbers its four decisions by roadmap order, not by S- number', (t) => {
  const r = run(['spine-decisions', '--phase', '3'], project(t));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.decisions.map((d) => [d.id, d.spine_id]),
    [['D-01', 'S-02'], ['D-02', 'S-04'], ['D-03', 'S-05'], ['D-04', 'S-06']]);
  assert.ok(r.text.startsWith('- D-01 (design approach): One server-rendered web app. '));
});

test('spine-decisions: a section with no field answers none, never a refusal', (t) => {
  const hand = '\n### Phase 6: Hand\n**Goal:** Ship it.\n**Requirements:** CAT-01\n**Success Criteria:**\n1. It ships.\n';
  const r = run(['spine-decisions', '--phase', '6'], project(t, (s) => s + hand));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.count, 0);
  assert.deepEqual(r.decisions, []);
  assert.equal(r.text, '');
});

test('spine-decisions: a bad line, a Goal without its sentence, no ROADMAP and a bad --phase refuse and write nothing', (t) => {
  const mangled = '- S-02: One server-rendered web app';
  const goal = '**Goal:** Volunteers check tools out and in at the counter. Members, checkouts and returns. Reminders are not part of it.';
  /** @param {string} s */
  const inPhase4 = (s, from, to) => {
    const at = s.indexOf('### Phase 4:');
    return s.slice(0, at) + s.slice(at).replace(from, to);
  };
  const cases = [
    { label: 'mangled line', edit: (s) => inPhase4(s, /^- \*\*S-02: .*$/m, mangled), argv: ['--phase', '4'], names: mangled },
    { label: 'goal', edit: (s) => s.replace(' It\'s epic E-02 of the Seldon design "Toolshed".', ''), argv: ['--phase', '4'], names: goal },
    { label: 'no roadmap', edit: () => null, argv: ['--phase', '4'], names: 'ROADMAP.md' },
    { label: 'no --phase', edit: undefined, argv: [], names: '--phase' },
    { label: '--phase x', edit: undefined, argv: ['--phase', 'x'], names: '--phase' },
  ];
  for (const c of cases) {
    const dir = project(t, c.edit);
    const before = treeOf(dir);
    const r = run(['spine-decisions', ...c.argv], dir);
    assert.equal(r.ok, false, `${c.label}: ${JSON.stringify(r)}`);
    assert.equal(r._exit, 1, c.label);
    assert.ok(r.hint, c.label);
    assert.ok(r.detail.includes(c.names), `${c.label}: ${r.detail}`);
    if (c.label === 'mangled line' || c.label === 'goal') {
      const n = readFileSync(join(dir, 'ROADMAP.md'), 'utf8').split('\n').indexOf(c.names) + 1;
      assert.ok(n > 0 && r.detail.includes('ROADMAP.md') && r.detail.includes(`line ${n}: `), `${c.label}: ${r.detail}`);
    }
    assert.deepEqual(treeOf(dir), before, c.label);
  }
});

test('spine-decisions: Cadence\'s CONTEXT readers take the answer\'s lines as decisions D-01 onward', (t) => {
  const r = run(['spine-decisions', '--phase', '4'], project(t));
  assert.equal(r.ok, true, JSON.stringify(r));
  const context = `# Phase 4: Context\n\n## Durable decisions\n\n${r.text}- D-07 (storage): A later decision. Evidence: x.\n\n`
    + '## Decisions\n\n- D-08 (local): A phase-local decision.\n';
  const durable = parseContextDecisions(context);
  assert.equal(durable.length, 7);
  assert.ok(durable[0].startsWith('D-01 (how state changes): Loans are an append-only event log. '));
  assert.deepEqual(contextDecisions(context).map((d) => d.slice(0, 4)),
    ['D-01', 'D-02', 'D-03', 'D-04', 'D-05', 'D-06', 'D-07', 'D-08']);
});

// --- /cad-context: where the workflow reads them and where it writes them ----------
//
// The session runs the read and does the Write, and no test can run a session, so these arms pin the prose that
// tells it to.

const CONTEXT_MD = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'cadence-core', 'workflows', 'context.md'), 'utf8');

/** One step of context.md, from its `<step name="...">` to its `</step>`. @param {string} name */
function stepOf(name) {
  const start = CONTEXT_MD.indexOf(`<step name="${name}">`);
  assert.notEqual(start, -1, `context.md has no ${name} step`);
  return CONTEXT_MD.slice(start, CONTEXT_MD.indexOf('</step>', start));
}

const READ_CALL = 'planning.mjs" spine-decisions --phase';

test('context.md: resolve_phase makes the one spine-decisions read, above spend_gate', () => {
  assert.equal(CONTEXT_MD.split(READ_CALL).length - 1, 1);
  const at = CONTEXT_MD.indexOf(READ_CALL);
  const resolve = CONTEXT_MD.indexOf('<step name="resolve_phase">');
  assert.ok(resolve < at && at < resolve + stepOf('resolve_phase').length, 'the read sits outside resolve_phase');
  assert.ok(at < CONTEXT_MD.indexOf('<step name="spend_gate">'), 'the read comes after the spend question');
});

test('context.md: after the read, ok:false stops before writing and a phase with none carries on unchanged', () => {
  const step = stepOf('resolve_phase');
  const after = step.slice(step.indexOf(READ_CALL)).replace(/\s+/g, ' ');
  assert.match(after, /On `ok:false`[^.]*\bstop\. Nothing is written, CONTEXT\.md included\./);
  assert.match(after, /With `count` 0, carry on exactly as below, with no question, section or remark\./);
});

test('context.md: write_context opens ## Durable decisions with the spine decisions, ahead of every other', () => {
  const flat = stepOf('write_context').replace(/\s+/g, ' ');
  assert.match(flat, /spine decisions, `## Durable decisions` opens with that `text`, inserted unchanged/);
  assert.match(flat, /The spine decisions go ahead of every other decision and skip the durability filter\./);
});

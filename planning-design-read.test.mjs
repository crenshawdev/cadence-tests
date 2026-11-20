// Zero-dep tests for `planning.mjs design-read`, the Seldon design reader. Run:
// node --test tests/planning-design-read.test.mjs
//
// The design under fixtures/seldon-design/ is Seldon's samples/ copied byte
// for byte (D-16), so nothing here reads /code/seldon. Every arm that changes
// a document does it to a scratch copy.
//
// The `test` binding below is a no-op unless this module IS the entry file, so
// a sibling that imports from here registers nothing twice.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureRoadmap, isEntryFile, makeTree, run, scratch, stampState, treeOf, verifyChecked } from './planning.test.mjs';
import { readDesign } from '../cadence-core/bin/lib/seldon-design.mjs';
import { classifyActiveSection, parseActiveIds, phaseCriteria, phaseDetailSpans, phaseRequirements, sectionSpan } from '../cadence-core/bin/lib/planning-files.mjs';

/** `node:test`'s `test` when run directly, a no-op when imported (see header). */
const test = isEntryFile(import.meta.url) ? nodeTest : () => {};

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'seldon-design');
const BRIEF_SECTIONS = ['Problem', 'Solution', 'Who it serves', "What's different", 'Success criteria', 'Scope',
  'What it refuses', 'Vision'];

/**
 * A scratch copy of the fixture design, each named document passed through its edit first.
 * @param {any} t @param {Record<string, (text: string) => string>} [edits]
 */
function designCopy(t, edits = {}) {
  const dir = join(scratch('design-read-', t), 'design');
  cpSync(FIXTURE, dir, { recursive: true });
  for (const [file, edit] of Object.entries(edits)) {
    const path = join(dir, file);
    writeFileSync(path, edit(readFileSync(path, 'utf8')));
  }
  return dir;
}

/** design-read on `design`, with a scratch --dir nothing reads. */
function read(t, design, first = '1') {
  return run(['design-read', '--design', design, '--first-phase', first], scratch('design-read-dir-', t));
}

// --- the door, the four-file read, the brief ----------------------------------

test('design-read: the fixture design is accepted with its title and the brief sections by exact name', (t) => {
  const r = read(t, FIXTURE);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r._exit, 0);
  assert.equal(r.title, 'Toolshed');
  assert.deepEqual(Object.keys(r.brief), BRIEF_SECTIONS);
  assert.equal(r.brief.Vision, 'Any volunteer-run lending library can track what it lends without a logbook. [ASSUMPTION]');
});

test('design-read: an empty folder is refused with one issue per missing document', (t) => {
  const r = read(t, scratch('design-read-empty-', t));
  assert.equal(r.ok, false);
  assert.equal(r._exit, 1);
  assert.ok(r.hint);
  assert.deepEqual(r.issues, ['brief.md', 'prd.md', 'spine.md', 'epics.md']
    .map((file) => ({ file, problem: 'missing file' })));
});

test('design-read: a brief missing one section and holding only the tag in another is refused for both', (t) => {
  const design = designCopy(t, {
    'brief.md': (s) => s.replace(/\n## Vision\n[^]*$/, '\n')
      .replace(/## Scope\n[^]*?\n## /, '## Scope\n[ASSUMPTION]\n\n## '),
  });
  const r = read(t, design);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.ok(r.hint);
  assert.deepEqual(r.issues, [
    { file: 'brief.md', section: 'Scope', problem: 'empty section' },
    { file: 'brief.md', section: 'Vision', problem: 'missing section' },
  ]);
});

test('design-read: a --design naming a file, no --first-phase and --first-phase 0 are refused with a hint', (t) => {
  const dir = scratch('design-read-dir-', t);
  for (const args of [
    ['--design', join(FIXTURE, 'brief.md'), '--first-phase', '1'],
    ['--design', FIXTURE],
    ['--design', FIXTURE, '--first-phase', '0'],
  ]) {
    const r = run(['design-read', ...args], dir);
    assert.equal(r.ok, false, `${args.join(' ')}: ${JSON.stringify(r)}`);
    assert.equal(r._exit, 1);
    assert.ok(r.hint, `${args.join(' ')} carries no hint`);
  }
});

test('design-read: an accepted and a refused read change no file and create none, stamped or not', (t) => {
  for (const stamped of [true, false]) {
    const root = scratch('design-read-project-', t);
    const planning = join(root, '.planning');
    mkdirSync(planning);
    ensureRoadmap(planning);
    if (stamped) stampState(planning);
    cpSync(FIXTURE, join(planning, 'seldon'), { recursive: true });
    cpSync(FIXTURE, join(planning, 'seldon-broken'), { recursive: true });
    rmSync(join(planning, 'seldon-broken', 'brief.md'));
    const before = treeOf(root);
    for (const [name, accepted] of [['seldon', true], ['seldon-broken', false]]) {
      const r = run(['design-read', '--design', join(planning, name), '--first-phase', '1'], planning);
      assert.equal(r.ok, accepted, `${stamped ? 'stamped' : 'unstamped'} ${name}: ${JSON.stringify(r)}`);
      assert.deepEqual(treeOf(root), before, `${stamped ? 'stamped' : 'unstamped'} ${name} changed the project`);
    }
  }
});

// --- requirements and spine decisions -----------------------------------------

const S03 = "A job runs once a day, reads the loan log and sends that day's reminders. Nothing sends email while a"
  + ' request is being handled. When a run fails, the counter screen shows the volunteers a notice naming the'
  + " reminders that didn't go out, until a volunteer dismisses it. [ASSUMPTION]";

test('design-read: the PRD requirements come back in file order with their category and one-line text', (t) => {
  const r = read(t, FIXTURE);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.requirements.map((q) => q.id),
    ['CAT-01', 'CAT-02', 'LOAN-01', 'LOAN-02', 'LOAN-03', 'NFR-01', 'NFR-02']);
  assert.deepEqual(r.requirements[0],
    { id: 'CAT-01', category: 'Catalog', text: 'A volunteer adds a tool with a name, a category and a photo. [ASSUMPTION]' });
  assert.equal(r.requirements[1].text, 'A member searches the catalog by name or category.');
  assert.equal(r.requirements[6].category, 'Non-functional');
});

// each edit breaks one D-02 class; all four together are one answer
const PRD_BREAKS = {
  'a bold colon': (s) => s.replace('- **CAT-02**', '- **CAT-03:** text\n- **CAT-02**'),
  'a second CAT-01': (s) => s.replace('### Loans\n', '### Loans\n- **CAT-01**: again\n'),
  'a bullet above its category': (s) => s.replace('### Catalog\n- **CAT-01**: A volunteer adds a tool with a name, a category and a photo. [ASSUMPTION]\n',
    '- **CAT-01**: A volunteer adds a tool with a name, a category and a photo. [ASSUMPTION]\n### Catalog\n'),
  'no MVP scope': (s) => s.replace(/\n## MVP scope\n[^]*$/, '\n'),
};

test('design-read: each broken PRD is refused with one issue naming prd.md, and all four at once with four', (t) => {
  for (const [name, edit] of Object.entries(PRD_BREAKS)) {
    const r = read(t, designCopy(t, { 'prd.md': edit }));
    assert.equal(r.ok, false, `${name}: ${JSON.stringify(r)}`);
    assert.equal(r.issues.length, 1, `${name}: ${JSON.stringify(r.issues)}`);
    assert.equal(r.issues[0].file, 'prd.md');
    assert.ok(r.issues[0].section, `${name} names no section`);
  }
  const all = read(t, designCopy(t, { 'prd.md': (s) => Object.values(PRD_BREAKS).reduce((acc, edit) => edit(acc), s) }));
  assert.equal(all.ok, false);
  assert.ok(all.hint);
  assert.equal(all.issues.length, 4, JSON.stringify(all.issues));
  assert.ok(all.issues.every((i) => i.file === 'prd.md'));
  assert.deepEqual(all.issues.filter((i) => i.id).map((i) => i.id), ['CAT-01', 'CAT-01']);
});

test('design-read: a spine decision reads as its kind and one-line text, quotes and source lines dropped', () => {
  const texts = { 'brief.md': null, 'prd.md': null, 'epics.md': null };
  const fixture = readDesign({ ...texts, 'spine.md': readFileSync(join(FIXTURE, 'spine.md'), 'utf8') });
  assert.deepEqual(fixture.issues, []);
  const s03 = fixture.decisions.get('S-03');
  assert.equal(s03.kind, 'boundaries');
  assert.equal(s03.text, S03);
  const sourced = readDesign({ ...texts,
    'spine.md': '# x\n\n## S-01: One file\nKind: stack\nThe data sits in one file.\n> a quote\n(src/db.js)\n' });
  assert.equal(sourced.decisions.get('S-01').text, 'The data sits in one file.');
});

test('design-read: a malformed, a repeated and an empty spine decision are three issues naming spine.md', (t) => {
  const design = designCopy(t, {
    'spine.md': (s) => s.replace(/(## S-05: One small rented server\nKind: hosting\n)[^\n]*\n/, '$1')
      + '\n## S-1: x\nKind: stack\nSomething.\n\n## S-02: again\nKind: stack\nSomething else.\n',
  });
  const r = read(t, design);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.issues.length, 3, JSON.stringify(r.issues));
  assert.ok(r.issues.every((i) => i.file === 'spine.md'));
});

// --- epics onto phases ---------------------------------------------------------

test('design-read: each epic is one phase numbered from --first-phase, with its goal, criteria and decisions', (t) => {
  const r = read(t, FIXTURE, '4');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.phases.map((p) => [p.number, p.name]), [[4, 'Catalog'], [5, 'Lending'], [6, 'Reminders']]);
  const [catalog, lending, reminders] = r.phases;
  assert.equal(catalog.goal, 'Volunteers keep a catalog of tools, and members can search it. Tools and their categories'
    + ' only. No loans and no member records. It\'s epic E-01 of the Seldon design "Toolshed".');
  assert.equal(catalog.description, 'Volunteers keep a catalog of tools, and members can search it.');
  assert.equal(catalog.depends_on, 'Nothing');
  assert.deepEqual(lending.success_criteria, [
    'A checkout records the member, the tool and a due date.',
    'A return closes the open loan for that tool.',
    'Member contact details are hidden from anyone who isn\'t a volunteer.',
    'Everything built so far, this epic included, works end to end, with every test passing and nothing half-built showing.',
  ]);
  assert.equal(lending.depends_on, 'Phase 4');
  assert.deepEqual(lending.requirements, ['LOAN-01', 'LOAN-02', 'NFR-01', 'NFR-02']);
  assert.deepEqual(lending.spine_decisions.map((d) => d.id), ['S-01', 'S-02', 'S-03', 'S-04', 'S-05', 'S-06']);
  assert.equal(lending.spine_decisions[2].text, S03);
  assert.equal(reminders.depends_on, 'Phase 5');
  assert.deepEqual(r.uncovered, []);
});

test('design-read: phases follow file order, never the E- number', (t) => {
  const design = designCopy(t, {
    'epics.md': (s) => s.replace('## E-01:', '## E-07:').replace('## E-02:', '## E-03:').replace('## E-03: Reminders', '## E-05: Reminders')
      .replace('**Depends on:** E-01', '**Depends on:** E-07').replace('**Depends on:** E-02', '**Depends on:** E-03'),
  });
  const r = read(t, design);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.phases.map((p) => [p.number, p.name, p.depends_on]),
    [[1, 'Catalog', 'Nothing'], [2, 'Lending', 'Phase 1'], [3, 'Reminders', 'Phase 2']]);
});

test('design-read: broken epic fields are one issue each, and an unread PRD is not checked against', (t) => {
  const r = read(t, designCopy(t, {
    'epics.md': (s) => s.replace('**Depends on:** None', '**Depends on:** E-02')
      .replace('**Requirements:** LOAN-01,', '**Requirements:** LOAN-09,')
      .replace('**Spine decisions:** S-01, S-02, S-03, S-04, S-05, S-06', '**Spine decisions:** S-01, S-09')
      .replace('**Boundaries:** The daily job and its emails. It only reads the loan log.\n', '')
      .replace('**Requirements:** LOAN-03', '**Requirements:** loan-3'),
  }));
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.deepEqual(r.issues.map((i) => [i.file, i.id, i.field]), [
    ['epics.md', 'E-01', 'Depends on'],
    ['epics.md', 'E-02', 'Requirements'],
    ['epics.md', 'E-02', 'Spine decisions'],
    ['epics.md', 'E-03', 'Boundaries'],
    ['epics.md', 'E-03', 'Requirements'],
  ]);
  const unread = designCopy(t, { 'epics.md': (s) => s.replace('**Requirements:** LOAN-01,', '**Requirements:** LOAN-09,') });
  rmSync(join(unread, 'prd.md'));
  assert.deepEqual(read(t, unread).issues, [{ file: 'prd.md', problem: 'missing file' }]);
});

test('design-read: a requirement no epic names is accepted and listed as uncovered', (t) => {
  const r = read(t, designCopy(t, { 'epics.md': (s) => s.replace('**Requirements:** LOAN-03', '**Requirements:** LOAN-02') }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.uncovered, ['LOAN-03']);
});

test('design-read: multi-line values come back as one line, and a name or Outcome holding ** is refused once', (t) => {
  const joined = read(t, designCopy(t, {
    'epics.md': (s) => s.replace('**Outcome:** Volunteers keep a catalog of tools, and members',
      '**Outcome:** Volunteers keep a catalog of tools,\nand members')
      .replace('- A volunteer can add a tool with a name, a category', '- A volunteer can add a tool with a name,\n  a category'),
  }));
  assert.equal(joined.ok, true, JSON.stringify(joined));
  assert.equal(joined.phases[0].description, 'Volunteers keep a catalog of tools, and members can search it.');
  assert.deepEqual(joined.phases[0].success_criteria.slice(0, 2),
    ['A volunteer can add a tool with a name, a category and a photo.', 'A member can find that tool by name or by category.']);
  for (const [name, edit, where] of [
    ['a bold name', (s) => s.replace('## E-01: Catalog', '## E-01: **Bold** name'), 'section'],
    ['a bold Outcome', (s) => s.replace('**Outcome:** Volunteers keep a catalog of tools, and members can search it.',
      '**Outcome:** a **b** c'), 'field'],
    ['a name the judge refuses', (s) => s.replace('## E-01: Catalog', '## E-01: A** - B'), 'section'],
  ]) {
    const r = read(t, designCopy(t, { 'epics.md': edit }));
    assert.equal(r.ok, false, `${name}: ${JSON.stringify(r)}`);
    assert.equal(r.issues.length, 1, `${name}: ${JSON.stringify(r.issues)}`);
    assert.equal(r.issues[0].file, 'epics.md');
    assert.equal(r.issues[0].id, 'E-01');
    assert.ok(r.issues[0][where], `${name} names no ${where}`);
  }
});

// --- content the reader would otherwise drop -----------------------------------

test('design-read: a repeated or unlisted section and a repeated epic field are refused, never read past', (t) => {
  for (const [name, file, edit, issue] of [
    ['a second ## Requirements', 'prd.md', (s) => s + '\n## Requirements\n### Extra\n- **EXT-01**: An extra requirement.\n',
      { file: 'prd.md', section: 'Requirements', problem: 'section appears more than once' }],
    ['a second ## Non-functional requirements', 'prd.md', (s) => s + '\n## Non-functional requirements\n- **NFR-03**: Another one.\n',
      { file: 'prd.md', section: 'Non-functional requirements', problem: 'section appears more than once' }],
    ['an unlisted prd section', 'prd.md', (s) => s + '\n## Security requirements\n- **SEC-01**: A security requirement.\n',
      { file: 'prd.md', section: 'Security requirements', problem: 'not a section prd.md has' }],
    ['a second ## Vision', 'brief.md', (s) => s + '\n## Vision\nA second vision.\n',
      { file: 'brief.md', section: 'Vision', problem: 'section appears more than once' }],
    ['an unlisted brief section', 'brief.md', (s) => s + '\n## Roadmap\nLater.\n',
      { file: 'brief.md', section: 'Roadmap', problem: 'not a section brief.md has' }],
    ['a second Requirements field', 'epics.md', (s) => s.replace('**Requirements:** CAT-01, CAT-02\n',
      '**Requirements:** CAT-01, CAT-02\n**Requirements:** LOAN-03\n'),
      { file: 'epics.md', id: 'E-01', field: 'Requirements', problem: 'field appears more than once' }],
  ]) {
    const design = designCopy(t, { [file]: edit });
    assert.notEqual(readFileSync(join(design, file), 'utf8'), readFileSync(join(FIXTURE, file), 'utf8'), `${name} edited nothing`);
    const r = read(t, design);
    assert.equal(r.ok, false, `${name}: ${JSON.stringify(r)}`);
    assert.deepEqual(r.issues, [issue], name);
  }
});

// --- design-read --add: the project a design joins ----------------------------

const ACTIVE = '# Requirements: Fixture\n\n## Active\n\n### Old\n\n- [ ] **OLD-01**: An old requirement.\n';

/**
 * A scratch project holding the roadmap phases named, stamped from them, with `requirements` as its REQUIREMENTS.md.
 * @param {any} t @param {number[]} phases @param {string} [requirements]
 */
function project(t, phases, requirements = ACTIVE) {
  const planning = makeTree({ roadmap: phases.map((n) => ({ n, name: `Old ${n}` })) }, t);
  verifyChecked(planning);
  writeFileSync(join(planning, 'REQUIREMENTS.md'), requirements);
  return { planning, root: dirname(planning) };
}

/** design-read --add on `design` against `planning`, which it must leave byte-identical. */
function add(t, planning, design = FIXTURE, extra = []) {
  const root = dirname(planning);
  const before = treeOf(root);
  const r = run(['design-read', '--add', '--design', design, ...extra], planning);
  assert.deepEqual(treeOf(root), before, `design-read --add changed the project: ${JSON.stringify(r)}`);
  return r;
}

test('design-read --add: the new phases number from the highest phase in the state, never its count', (t) => {
  const r = add(t, project(t, [1, 2, 2.1]).planning);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.phases.map((p) => p.number), [3, 4, 5]);
  assert.equal(r.phases[1].depends_on, 'Phase 3');
  const empty = add(t, project(t, []).planning);
  assert.equal(empty.ok, true, JSON.stringify(empty));
  assert.deepEqual(empty.phases.map((p) => p.number), [1, 2, 3]);
});

// every place an ID can sit in REQUIREMENTS.md, and three near misses that must not clash
const CLASHING = `${ACTIVE}
Old notes name CAT-2, XLOAN-03 and LOAN-031 in passing.

## Shipped

The first release shipped LOAN-02 with the counter screen.

## v2 Requirements

- **NFR-01**: A requirement put off to later.

## Traceability

| Requirement | Phase | Status |
|---|---|---|
| CAT-01 | Phase 1 | Complete |

\`\`\`
LOAN-01
\`\`\`
`;

test('design-read --add: an ID anywhere in REQUIREMENTS.md clashes, in one answer beside the design issues', (t) => {
  const { planning } = project(t, [1], CLASHING);
  const r = add(t, planning);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.reason, 'design-refused');
  assert.deepEqual(r.issues.map((i) => [i.file, i.id]),
    [['prd.md', 'CAT-01'], ['prd.md', 'LOAN-01'], ['prd.md', 'LOAN-02'], ['prd.md', 'NFR-01']]);
  assert.match(r.hint, /prd\.md/);
  assert.match(r.hint, /epics\.md/);
  const broken = designCopy(t, {
    'epics.md': (s) => s.replace('**Boundaries:** The daily job and its emails. It only reads the loan log.\n', ''),
  });
  const both = add(t, planning, broken);
  assert.equal(both.ok, false, JSON.stringify(both));
  assert.deepEqual(both.issues.map((i) => [i.file, i.id, i.field]), [
    ['epics.md', 'E-03', 'Boundaries'],
    ['prd.md', 'CAT-01', undefined], ['prd.md', 'LOAN-01', undefined],
    ['prd.md', 'LOAN-02', undefined], ['prd.md', 'NFR-01', undefined],
  ]);
});

test('design-read --add: a file, an empty path, a project missing a file or heading, and --first-phase are refused', (t) => {
  /** @type {[string, () => {planning: string, design?: string, extra?: string[]}][]} */
  const cases = [
    ['a file as --design', () => ({ planning: project(t, [1]).planning, design: join(FIXTURE, 'brief.md') })],
    ['an empty --design', () => ({ planning: project(t, [1]).planning, design: '' })],
    ['no REQUIREMENTS.md', () => {
      const { planning } = project(t, [1]);
      rmSync(join(planning, 'REQUIREMENTS.md'));
      return { planning };
    }],
    ['a fenced ## Active', () => ({ planning: project(t, [1], '# Requirements\n\n```\n## Active\n```\n').planning })],
    ['no ROADMAP.md', () => {
      const { planning } = project(t, [1]);
      rmSync(join(planning, 'ROADMAP.md'));
      return { planning };
    }],
    ['a fenced ## Phase Details', () => {
      const { planning } = project(t, [1]);
      const file = join(planning, 'ROADMAP.md');
      writeFileSync(file, readFileSync(file, 'utf8').replace('## Phase Details', '```\n## Phase Details\n```'));
      return { planning };
    }],
    ['no state file', () => {
      const planning = makeTree({ roadmap: [{ n: 1, name: 'Old 1' }] }, t);
      writeFileSync(join(planning, 'REQUIREMENTS.md'), ACTIVE);
      return { planning };
    }],
    ['--first-phase beside --add', () => ({ planning: project(t, [1]).planning, extra: ['--first-phase', '3'] })],
  ];
  for (const [name, build] of cases) {
    const { planning, design = FIXTURE, extra = [] } = build();
    const r = add(t, planning, design, extra);
    assert.equal(r.ok, false, `${name}: ${JSON.stringify(r)}`);
    assert.equal(r._exit, 1);
    assert.ok(r.hint, `${name} carries no hint`);
    if (name === 'no state file') assert.equal(existsSync(join(planning, 'records', 'state.json')), false);
  }
});

// --- the rendered ## Active bullets and ### Phase N: sections -------------------

// typed from the fixture's lines, never taken from the renderer
const ACTIVE_TEXT = [
  '### Catalog',
  '',
  '- [ ] **CAT-01**: A volunteer adds a tool with a name, a category and a photo. [ASSUMPTION]',
  '- [ ] **CAT-02**: A member searches the catalog by name or category.',
  '',
  '### Loans',
  '',
  '- [ ] **LOAN-01**: A volunteer checks a tool out to a member with a due date.',
  '- [ ] **LOAN-02**: A volunteer checks a tool back in.',
  '- [ ] **LOAN-03**: A member gets an email reminder the day before a loan is due.',
  '',
  '### Non-functional',
  '',
  '- [ ] **NFR-01**: A checkout takes under three seconds on a phone over a slow connection. [ASSUMPTION]',
  '- [ ] **NFR-02**: Member emails and addresses are visible only to volunteers. [ASSUMPTION]',
].map((l) => `${l}\n`).join('');

const CATALOG_SECTION = [
  '### Phase 3: Catalog',
  '**Goal:** Volunteers keep a catalog of tools, and members can search it. Tools and their categories only. No loans and'
    + ' no member records. It\'s epic E-01 of the Seldon design "Toolshed".',
  '**Depends on:** Nothing',
  '**Requirements:** CAT-01, CAT-02',
  '**Success Criteria:**',
  '1. A volunteer can add a tool with a name, a category and a photo.',
  '2. A member can find that tool by name or by category.',
  '3. Everything built so far, this epic included, works end to end, with every test passing and nothing half-built showing.',
  '**Spine decisions:**',
  '- **S-02: One server-rendered web app** (design approach): The counter screens and the public catalog are pages of'
    + ' one app. There\'s no separate API.',
  '- **S-04: Node with one SQLite database** (stack): The app runs on Node and keeps the catalog, the members and the'
    + ' loan log in one SQLite database file. [ASSUMPTION]',
  '- **S-05: One small rented server** (hosting): The app and its database file run on one small rented virtual server.'
    + ' [ASSUMPTION]',
  '- **S-06: Members reach only the catalog** (boundaries): The catalog pages are the only part members and the public'
    + ' reach from outside, and what they type there is only ever read as search text. Member emails and addresses sit'
    + ' behind the volunteer login, and no catalog page shows them. [ASSUMPTION]',
].map((l) => `${l}\n`).join('');

/** The `### Phase N:` sections in `text`, by number. @param {string} text */
const sectionsOf = (text) => Object.fromEntries(text.split(/\n(?=### Phase )/)
  .map((s) => [Number(/^### Phase (\d+):/.exec(s)?.[1]), s.endsWith('\n') ? s : `${s}\n`]));

test('design-read: the ## Active text and the phase sections carry every value byte for byte', (t) => {
  const r = add(t, project(t, [1, 2]).planning);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.active_text, ACTIVE_TEXT);
  assert.deepEqual([...r.sections_text.matchAll(/^### Phase .*$/gm)].map((m) => m[0]),
    ['### Phase 3: Catalog', '### Phase 4: Lending', '### Phase 5: Reminders']);
  const sections = sectionsOf(r.sections_text);
  assert.equal(sections[3], CATALOG_SECTION);
  assert.ok(sections[4].split('\n').includes(`- **S-03: Reminders run from a daily scheduled job** (boundaries): ${S03}`));
});

test('design-read: each Goal names its own epic, and an epic with no decisions has no Spine decisions line', (t) => {
  const renamed = read(t, designCopy(t, {
    'epics.md': (s) => s.replace('## E-01:', '## E-07:').replace('## E-02:', '## E-03:').replace('## E-03: Reminders', '## E-05: Reminders')
      .replace('**Depends on:** E-01', '**Depends on:** E-07').replace('**Depends on:** E-02', '**Depends on:** E-03'),
  }), '3');
  assert.equal(renamed.ok, true, JSON.stringify(renamed));
  assert.deepEqual([...renamed.sections_text.matchAll(/^\*\*Goal:\*\* .*It's epic (E-\d+) of the Seldon design "Toolshed"\.$/gm)]
    .map((m) => m[1]), ['E-07', 'E-03', 'E-05']);
  const none = read(t, designCopy(t, {
    'epics.md': (s) => s.replace('**Spine decisions:** S-01, S-02, S-03, S-04, S-05\n', '**Spine decisions:** None\n'),
  }), '3');
  assert.equal(none.ok, true, JSON.stringify(none));
  const sections = sectionsOf(none.sections_text);
  assert.ok(sections[3].includes('**Spine decisions:**\n'));
  assert.ok(sections[4].includes('**Spine decisions:**\n'));
  assert.ok(!sections[5].includes('**Spine decisions:**'), sections[5]);
});

test('design-read: Cadence\'s own readers parse the rendered sections and ## Active bullets', (t) => {
  const r = read(t, FIXTURE, '3');
  assert.equal(r.ok, true, JSON.stringify(r));
  const roadmap = `# Roadmap: Fixture\n\n## Phases\n\n## Phase Details\n\n${r.sections_text}`;
  assert.deepEqual(phaseRequirements(roadmap, 4).ids, ['LOAN-01', 'LOAN-02', 'NFR-01', 'NFR-02']);
  assert.equal(phaseCriteria(roadmap, 4).count, 4);
  const lines = roadmap.split('\n');
  for (const n of [3, 4, 5]) assert.equal(phaseDetailSpans(lines, n).length, 1, `phase ${n}`);
  const requirements = `# Requirements: Fixture\n\n## Active\n\n${r.active_text}\n## v2 Requirements\n`;
  assert.deepEqual(classifyActiveSection(requirements),
    { ids: ['CAT-01', 'CAT-02', 'LOAN-01', 'LOAN-02', 'LOAN-03', 'NFR-01', 'NFR-02'], issues: [] });
});

// --- the add end to end at the seams --------------------------------------------

const PROJECT_MD = '# Fixture\n\nWhat this project is, which the add never touches.\n\n## Requirements\n\n### Active\n\nNo cycle open.\n';

/** `insert` placed after the last non-blank line of `heading`'s section, one blank line before it, as the workflow's step 3 says. */
function spliceInto(text, heading, insert) {
  const lines = text.split('\n');
  const { start, end } = sectionSpan(lines, heading);
  let last = end - 1;
  while (last > start && lines[last].trim() === '') last--;
  return `${lines.slice(0, last + 1).join('\n')}\n\n${insert}${lines.slice(last + 1).join('\n')}`;
}

/** Are `before`'s lines all in `after`, byte-identical and in order? */
function keepsLines(before, after) {
  const rest = after.split('\n');
  let i = 0;
  for (const line of before.split('\n')) {
    while (i < rest.length && rest[i] !== line) i++;
    if (i === rest.length) return false;
    i++;
  }
  return true;
}

test('design-read --add then phase-entry add per phase and the two texts keep every line already there', (t) => {
  const open = makeTree({ roadmap: [{ n: 1, name: 'Old 1' }, { n: 2, name: 'Old 2' }] }, t);
  verifyChecked(open);
  const closed = makeTree({ roadmap: [] }, t);
  stampState(closed);
  for (const [label, planning] of [['open', open], ['closed', closed]]) {
    writeFileSync(join(planning, 'REQUIREMENTS.md'), `${ACTIVE}\n## v2 Requirements\n\n- **LATER-01**: Put off.\n`);
    writeFileSync(join(planning, 'PROJECT.md'), PROJECT_MD);
    const before = Object.fromEntries(['REQUIREMENTS.md', 'ROADMAP.md', 'PROJECT.md']
      .map((f) => [f, readFileSync(join(planning, f), 'utf8')]));
    const design = run(['design-read', '--add', '--design', FIXTURE], planning);
    assert.equal(design.ok, true, `${label}: ${JSON.stringify(design)}`);
    const scratchDir = scratch('design-add-', t);
    const adds = design.phases.map((p) => {
      const name = join(scratchDir, `name-${p.number}.txt`);
      const description = join(scratchDir, `description-${p.number}.txt`);
      writeFileSync(name, p.name);
      writeFileSync(description, p.description);
      return run(['phase-entry', 'add', '--phase', String(p.number), '--name-file', name, '--description-file', description],
        planning);
    });
    for (const a of adds) assert.equal(a.ok, true, `${label}: ${JSON.stringify(a)}`);
    assert.deepEqual(adds.map((a) => a.opened_cycle === true), label === 'closed' ? [true, false, false] : [false, false, false]);
    const reqFile = join(planning, 'REQUIREMENTS.md');
    const roadmapFile = join(planning, 'ROADMAP.md');
    writeFileSync(reqFile, spliceInto(readFileSync(reqFile, 'utf8'), '## Active', design.active_text));
    writeFileSync(roadmapFile, spliceInto(readFileSync(roadmapFile, 'utf8'), '## Phase Details', design.sections_text));

    const status = run(['status'], planning);
    const added = design.phases.map((p) => [p.number, p.name]);
    assert.deepEqual(status.phases.map((p) => [p.n, p.name]).slice(-3), added, label);
    assert.deepEqual(added, label === 'open' ? [[3, 'Catalog'], [4, 'Lending'], [5, 'Reminders']]
      : [[1, 'Catalog'], [2, 'Lending'], [3, 'Reminders']]);
    for (const [file, text] of Object.entries(before)) {
      const now = readFileSync(join(planning, file), 'utf8');
      assert.ok(keepsLines(text, now), `${label}: ${file} lost or reordered a line it held\n${now}`);
    }
    assert.equal(readFileSync(join(planning, 'PROJECT.md'), 'utf8'), PROJECT_MD);
    const requirements = readFileSync(reqFile, 'utf8');
    assert.deepEqual(parseActiveIds(requirements),
      ['OLD-01', 'CAT-01', 'CAT-02', 'LOAN-01', 'LOAN-02', 'LOAN-03', 'NFR-01', 'NFR-02']);
    const roadmap = readFileSync(roadmapFile, 'utf8');
    const epicIds = [['CAT-01', 'CAT-02'], ['LOAN-01', 'LOAN-02', 'NFR-01', 'NFR-02'], ['LOAN-03']];
    for (const [i, p] of design.phases.entries()) {
      assert.deepEqual(phaseRequirements(roadmap, p.number).ids, epicIds[i], `${label} phase ${p.number}`);
    }
  }
});

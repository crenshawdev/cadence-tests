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
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureRoadmap, isEntryFile, run, scratch, stampState, treeOf } from './planning.test.mjs';
import { readDesign } from '../cadence-core/bin/lib/seldon-design.mjs';

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

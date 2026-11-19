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

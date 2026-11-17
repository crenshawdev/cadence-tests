// Tests for lib/task-record.mjs - where a `/cad-task` run's record lives and
// what its bytes are.
// Run: node --test tests/task-record.test.mjs
//
// ONE test() per row (the route-cells.test.mjs convention), and every fixture is
// built in its own mkdtempSync directory so no row can see another's tree.
//
// The render rows assert the record READS BACK through the shipped parsers -
// `parseCommitRows` and `taskDeclaredFiles` - rather than against a golden
// string. A golden string pins the bytes and proves nothing about the join,
// which is the whole reason the record is written in the corpus's own grammar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_SLUG_LENGTH, RECORD_FILE, TASKS_DIR, isTaskSlug, renderTaskRecord, taskRecordsIn,
} from '../cadence-core/bin/lib/task-record.mjs';
import { parseCommitRows, taskDeclaredFiles } from '../cadence-core/bin/lib/why-record.mjs';

/** A temp directory under `prefix`, gone when test `t` ends. */
function scratch(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A fresh planning root holding a record per slug, gone when test `t` ends. */
function planningRoot(t, records = {}) {
  const root = scratch(t, 'cad-task-record-');
  for (const [slug, text] of Object.entries(records)) {
    const dir = join(root, TASKS_DIR, slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, RECORD_FILE), text);
  }
  return root;
}

const SHA_A = '093408c9d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0';
const SHA_B = '2c2b1eefd0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0';

/** A record with the fields every row here varies from. */
const rec = (over = {}) => renderTaskRecord({
  slug: 'bound-plan-size',
  title: 'Bound plan size',
  body: 'Added a plan-size ceiling.\nRouted TOO BIG to smaller phases.',
  commits: [
    { commit: SHA_A, description: 'feat: declare the ceiling' },
    { commit: SHA_B, description: 'feat: route TOO BIG' },
  ],
  files: ['cadence-core/config.schema.json', 'cadence-core/templates/config.json'],
  ...over,
});

// --- isTaskSlug --------------------------------------------------------------

test('a slug is one path segment of lowercase letters, digits and single hyphens', () => {
  assert.equal(isTaskSlug('bound-plan-size'), true);
  assert.equal(isTaskSlug('task1'), true);
});

test('`..` is refused, never resolved', () => {
  // The VAL-01 lesson: `milestone-prune --label` was only TRIMMED before being
  // joined onto a directory path, and escaped the tree.
  assert.equal(isTaskSlug('..'), false);
  assert.equal(isTaskSlug('.'), false);
  assert.equal(isTaskSlug('../escape'), false);
});

test('a separator is refused on both spellings', () => {
  assert.equal(isTaskSlug('a/b'), false);
  assert.equal(isTaskSlug('a\\b'), false);
});

test('an absolute form is refused', () => {
  assert.equal(isTaskSlug('/abs'), false);
  assert.equal(isTaskSlug('/etc/passwd'), false);
});

test('an empty string is refused', () => {
  assert.equal(isTaskSlug(''), false);
});

test('an over-long slug is refused at the bound', () => {
  assert.equal(isTaskSlug('a'.repeat(MAX_SLUG_LENGTH)), true);
  assert.equal(isTaskSlug('a'.repeat(MAX_SLUG_LENGTH + 1)), false);
});

test('a non-string is refused - parseArgs mints `true` for a valueless flag', () => {
  assert.equal(isTaskSlug(true), false);
  assert.equal(isTaskSlug(undefined), false);
  assert.equal(isTaskSlug(7), false);
});

test('a NUL or a newline is refused', () => {
  assert.equal(isTaskSlug('a\0b'), false);
  assert.equal(isTaskSlug('a\nb'), false);
});

// --- taskRecordsIn -----------------------------------------------------------

test('an absent planning root is an empty list, never a throw', () => {
  assert.deepEqual(taskRecordsIn(join(tmpdir(), 'cad-task-record-nope-does-not-exist')), []);
});

test('a planning root with no tasks/ at all is an empty list', (t) => {
  assert.deepEqual(taskRecordsIn(planningRoot(t)), []);
});

test('a slug directory holding no RECORD.md contributes nothing', (t) => {
  const root = planningRoot(t);
  mkdirSync(join(root, TASKS_DIR, 'planned-only'), { recursive: true });
  writeFileSync(join(root, TASKS_DIR, 'planned-only', 'PLAN.md'), '# Plan\n');
  assert.deepEqual(taskRecordsIn(root), []);
});

test('the records come back sorted by slug', (t) => {
  const root = planningRoot(t, { zebra: rec(), alpha: rec(), middle: rec() });
  assert.deepEqual(taskRecordsIn(root).map((r) => r.slug), ['alpha', 'middle', 'zebra']);
  assert.equal(taskRecordsIn(root)[0].path, join(root, TASKS_DIR, 'alpha', RECORD_FILE));
});

test('a slug DIRECTORY that is a symlink out of the planning root is skipped', (t) => {
  // `readdirSync` FOLLOWS a symlinked directory, so this walk would otherwise
  // land in another tree entirely - `phaseDirsIn`'s case, one level out.
  const outside = scratch(t, 'cad-task-record-outside-');
  mkdirSync(join(outside, 'stolen'), { recursive: true });
  writeFileSync(join(outside, 'stolen', RECORD_FILE), rec());
  const root = planningRoot(t, { real: rec() });
  symlinkSync(join(outside, 'stolen'), join(root, TASKS_DIR, 'linked'));
  assert.deepEqual(taskRecordsIn(root).map((r) => r.slug), ['real']);
});

test('an in-root slug directory whose RECORD.md is a symlink OUT is skipped', (t) => {
  // The directory case passing does not imply the file case does, and this is
  // the one the recall tier reads THROUGH: a cloned repository carrying such a
  // link would surface an arbitrary readable file through `planning.mjs recall`.
  const outside = scratch(t, 'cad-task-record-secret-');
  const secret = join(outside, 'id_rsa');
  writeFileSync(secret, 'PRIVATE KEY\n');
  const root = planningRoot(t, { real: rec() });
  const dir = join(root, TASKS_DIR, 'leaky');
  mkdirSync(dir, { recursive: true });
  symlinkSync(secret, join(dir, RECORD_FILE));
  assert.deepEqual(taskRecordsIn(root).map((r) => r.slug), ['real']);
});

test('a RECORD.md symlink that stays INSIDE the planning root is still a record', (t) => {
  const root = planningRoot(t, { real: rec() });
  const dir = join(root, TASKS_DIR, 'aliased');
  mkdirSync(dir, { recursive: true });
  symlinkSync(join(root, TASKS_DIR, 'real', RECORD_FILE), join(dir, RECORD_FILE));
  assert.deepEqual(taskRecordsIn(root).map((r) => r.slug), ['aliased', 'real']);
});

test('a RECORD.md that is a DIRECTORY is not a record', (t) => {
  const root = planningRoot(t);
  mkdirSync(join(root, TASKS_DIR, 'odd', RECORD_FILE), { recursive: true });
  assert.deepEqual(taskRecordsIn(root), []);
});

test('an entry name the writer would refuse is not listed back', (t) => {
  // Containment passes on every one of these - they resolve inside the root -
  // so the slug grammar is the only thing that stops the name reaching
  // `/cad-why`'s rendered output and the recall index verbatim.
  const root = planningRoot(t, { real: rec() });
  for (const name of ['Upper', 'has space', 'trailing-', '-leading', 'double--hyphen', '.hidden']) {
    const dir = join(root, TASKS_DIR, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, RECORD_FILE), rec());
  }
  assert.deepEqual(taskRecordsIn(root).map((r) => r.slug), ['real']);
});

test('an entry name carrying a newline or a terminal escape is not listed back', (t) => {
  // The forging shape: a name that closes one section and opens another, or
  // one that repaints the line, printed straight into a diagnostic.
  const root = planningRoot(t, { real: rec() });
  for (const name of ['a\n## Commits', 'a\u001b[31mred']) {
    const dir = join(root, TASKS_DIR, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, RECORD_FILE), rec());
  }
  assert.deepEqual(taskRecordsIn(root).map((r) => r.slug), ['real']);
});

test('a name longer than MAX_SLUG_LENGTH is not listed back', (t) => {
  const root = planningRoot(t, { real: rec() });
  const dir = join(root, TASKS_DIR, 'a'.repeat(MAX_SLUG_LENGTH + 1));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, RECORD_FILE), rec());
  assert.deepEqual(taskRecordsIn(root).map((r) => r.slug), ['real']);
});

test('every slug the lister returns satisfies isTaskSlug', (t) => {
  const root = planningRoot(t, { zebra: rec(), alpha: rec(), 'two-words': rec(), 'v2': rec() });
  const slugs = taskRecordsIn(root).map((r) => r.slug);
  assert.deepEqual(slugs, ['alpha', 'two-words', 'v2', 'zebra']);
  for (const slug of slugs) assert.equal(isTaskSlug(slug), true);
});

// --- renderTaskRecord --------------------------------------------------------

test('the same inputs render byte-identical text', () => {
  assert.equal(rec(), rec());
});

test('the `## Commits` table reads back through parseCommitRows', () => {
  const rows = parseCommitRows(rec());
  assert.deepEqual(rows.map((r) => r.commit), [SHA_A, SHA_B]);
  assert.deepEqual(rows.map((r) => r.task), ['1', '1']);
  assert.deepEqual(rows.map((r) => r.description),
    ['feat: declare the ceiling', 'feat: route TOO BIG']);
});

test('the `- **Files:**` line reads back through taskDeclaredFiles', () => {
  const tasks = taskDeclaredFiles(rec());
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].ordinal, 1);
  assert.equal(tasks[0].title, 'Bound plan size');
  assert.deepEqual(tasks[0].files,
    ['cadence-core/config.schema.json', 'cadence-core/templates/config.json']);
});

test('a subject carrying a `|` survives as ONE cell', () => {
  // Unescaped, the row splits and the tail attaches to the wrong commit.
  const text = rec({
    commits: [{ commit: SHA_A, description: 'fix: a|b rails, both halves' }],
  });
  const rows = parseCommitRows(text);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].commit, SHA_A);
  assert.equal(rows[0].description, 'fix: a|b rails, both halves');
});

test('the body becomes one `- ` bullet per non-empty line, under `## What shipped`', () => {
  const text = rec({ body: 'first line\n\n  second line  \n' });
  assert.match(text, /^## What shipped$/m);
  assert.match(text, /^- first line$/m);
  assert.match(text, /^- second line$/m);
});

test("a body line the caller already bulleted does not render `- - `", () => {
  const text = rec({ body: '- already a bullet' });
  assert.match(text, /^- already a bullet$/m);
  assert.doesNotMatch(text, /^- - /m);
});

test('the record opens with `# Task: <slug>` and ends with the Files section', () => {
  const text = rec();
  assert.match(text, /^# Task: bound-plan-size$/m);
  // LAST, so `sectionBound` lets the task body run to end of file.
  assert.ok(text.indexOf('## Files') > text.indexOf('## Commits'));
  assert.ok(text.indexOf('## Commits') > text.indexOf('## What shipped'));
});

test('an empty commit list and an empty file list still render a readable record', () => {
  const text = rec({ commits: [], files: [], body: '' });
  assert.deepEqual(parseCommitRows(text), []);
  assert.deepEqual(taskDeclaredFiles(text).map((t) => t.files), [[]]);
});

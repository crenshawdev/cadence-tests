// Zero-dep tests for agile.mjs start - a Seldon design written as the agile path's release, or refused with nothing written.
// Run: node --test tests/agile-start.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerSetup, scratch } from './planning.test.mjs';
import { markAgile, readState, statePath, writeState } from '../cadence-core/bin/lib/project-state.mjs';
import { buildDir } from '../cadence-core/bin/lib/agile-paths.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGILE = join(HERE, '..', 'cadence-core', 'bin', 'agile.mjs');
const FIXTURE = join(HERE, 'fixtures', 'seldon-design');
const FILES = ['agile/REQUIREMENTS.md', 'agile/epics/E-01/epic.md', 'agile/epics/E-02/epic.md', 'agile/epics/E-03/epic.md',
  'agile/project.md', 'agile/release.md', 'config.json', 'records/.gitignore', 'records/state.json'];

const parse = (r) => ({ ...JSON.parse(r.stdout), _exit: r.status });
const start = (dir, design = FIXTURE) =>
  parse(spawnSync('node', [AGILE, 'start', '--design', design, '--dir', dir], { encoding: 'utf8' }));
const planning = (t) => join(scratch('cad-agile-', t), '.planning');

/** Every path under `root` with its bytes, a link as its target; null when there's nothing there. */
function tree(root, rel = '') {
  if (!lstatSync(root, { throwIfNoEntry: false })) return null;
  const out = {};
  for (const name of readdirSync(join(root, rel)).sort()) {
    const p = rel ? `${rel}/${name}` : name;
    const st = lstatSync(join(root, p));
    if (st.isDirectory()) Object.assign(out, { [`${p}/`]: '' }, tree(root, p));
    else out[p] = st.isSymbolicLink() ? `-> ${readlinkSync(join(root, p))}` : readFileSync(join(root, p), 'utf8');
  }
  return out;
}
const files = (root) => Object.keys(tree(root)).filter((p) => !p.endsWith('/'));

test('a start on a new project writes the release whole, marks the project and changes nothing in the design', (t) => {
  const dir = planning(t);
  const design = join(scratch('cad-agile-design-', t), 'design');
  cpSync(FIXTURE, design, { recursive: true });
  const before = tree(design);
  const r = start(answerSetup(dir), design);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.epics, [{ id: 'E-01', name: 'Catalog' }, { id: 'E-02', name: 'Lending' }, { id: 'E-03', name: 'Reminders' }]);
  assert.deepEqual(r.uncovered, []);
  assert.deepEqual(files(dir), FILES);
  assert.equal(readState(dir).reason, 'agile-path');
  assert.deepEqual(tree(design), before);
});

test('a start leaves what the user already keeps in .planning alone', (t) => {
  const dir = planning(t);
  mkdirSync(join(dir, 'seldon'), { recursive: true });
  cpSync(FIXTURE, join(dir, 'seldon'), { recursive: true });
  answerSetup(dir);
  const before = tree(dir);
  assert.equal(start(dir, join(dir, 'seldon')).ok, true);
  const after = tree(dir);
  for (const [p, bytes] of Object.entries(before)) assert.equal(after[p], bytes, p);
});

test('every refusal names its next step and leaves the tree exactly as it was', (t) => {
  const broken = join(scratch('cad-agile-broken-', t), 'design');
  cpSync(FIXTURE, broken, { recursive: true });
  const epics = join(broken, 'epics.md');
  writeFileSync(epics, readFileSync(epics, 'utf8').replace('**Boundaries:** Tools and their categories only. No loans and no member records.\n', ''));
  rmSync(join(broken, 'brief.md'));
  const put = (dir, name, text = 'x\n') => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, name), text); };
  const old = { cycleOpen: true, cursor: null, phases: [], requirements: [] };
  /** @type {[string, string, (dir: string) => void, string?, string?][]} */
  const cases = [
    ['a bad design', 'design-refused', () => {}, broken],
    ['no design folder', 'no-design-dir', () => {}, join(broken, 'nowhere')],
    ['a file as the design', 'no-design-dir', () => {}, epics],
    ['PROJECT.md', 'old-path', (d) => put(d, 'PROJECT.md')],
    ['REQUIREMENTS.md', 'old-path', (d) => put(d, 'REQUIREMENTS.md')],
    ['ROADMAP.md', 'old-path', (d) => put(d, 'ROADMAP.md')],
    ['STATE.md', 'old-path', (d) => put(d, 'STATE.md')],
    ['phases', 'old-path', (d) => mkdirSync(join(d, 'phases'), { recursive: true })],
    ['an old archive', 'old-path', (d) => mkdirSync(join(d, '_archive-v1.0.0'), { recursive: true })],
    ['an old state file', 'old-path', (d) => { mkdirSync(d); assert.equal(writeState(d, old).ok, true); }],
    ['a torn state file', 'old-path', (d) => { put(join(d, 'records'), 'state.json', '{torn'); }],
    ['an old file in a marked project', 'old-path', (d) => { mkdirSync(d); markAgile(d); put(d, 'PROJECT.md'); }],
    ['a release already open', 'release-open', (d) => { assert.equal(start(answerSetup(d)).ok, true); }],
    ['a release folder with no marker', 'unmarked', (d) => { start(answerSetup(d)); rmSync(statePath(d)); }],
    ['a file where .planning goes', 'planning-dir', (d) => writeFileSync(d, 'x')],
    ['a linked .planning', 'planning-dir', (d) => symlinkSync(scratch('cad-agile-elsewhere-', t), d)],
  ];
  for (const name of ['a release already open', 'a linked .planning']) {
    const found = cases.find((c) => c[0] === name);
    cases.push([`${name}, spelled with a trailing slash`, found[1], found[2], FIXTURE, '/']);
  }
  for (const [name, reason, build, design = FIXTURE, slash = ''] of cases) {
    const dir = planning(t);
    build(dir);
    const root = dirname(dir);
    const before = tree(root);
    const r = start(dir + slash, design);
    assert.deepEqual([r.ok, r._exit, r.reason], [false, 1, reason], `${name}: ${JSON.stringify(r)}`);
    assert.ok(r.hint, name);
    assert.deepEqual(tree(root), before, name);
  }
  const bad = start(planning(t), broken);
  assert.deepEqual(bad.issues.map((i) => i.file).sort(), ['brief.md', 'epics.md']);
});

test('words that would not read back from the agile path\'s files are refused naming where they are, and nothing is written', (t) => {
  const boundaries = '**Boundaries:** Tools and their categories only. No loans and no member records.';
  const item = '- A volunteer can add a tool with a name, a category and a photo.';
  /** @type {[string, string, string, string, string, string][]} */
  const cases = [
    ['a starred item', 'epics.md', item, `* ${item.slice(2)}`, 'E-01', 'Done when'],
    ['an item cut by an unindented line', 'epics.md', item, '- A volunteer can add\na tool.', 'E-01', 'Done when'],
    ['text on the Done when line', 'epics.md', '**Done when:**', '**Done when:** it works', 'E-01', 'Done when'],
    ['six items', 'epics.md', item, `${item}\n- two\n- three\n- four`, 'E-01', 'Done when'],
    ['an Outcome that opens a section', 'epics.md', '**Outcome:** Volunteers keep', '**Outcome:** ## Done when Volunteers keep', 'E-01', 'Outcome'],
    ['a Boundaries that opens a fence', 'epics.md', boundaries, '**Boundaries:** ```', 'E-01', 'Boundaries'],
    ['a fence that never closes', 'brief.md', '- Overdue tools', '```\n- Overdue tools', '', 'Success criteria'],
    ['a fence closed too far in to close it', 'brief.md', '- Overdue tools', '   ```sh\n   npm test\n    ```\n- Overdue tools', '', 'Success criteria'],
    ['a line that reads as a heading', 'brief.md', '- Overdue tools', '  ## Epics\n- Overdue tools', '', 'Success criteria'],
  ];
  for (const [name, file, from, to, id, where] of cases) {
    const design = join(scratch('cad-agile-words-', t), 'design');
    cpSync(FIXTURE, design, { recursive: true });
    const text = readFileSync(join(design, file), 'utf8');
    assert.ok(text.includes(from), name);
    writeFileSync(join(design, file), text.replace(from, to));
    const dir = planning(t);
    const r = start(dir, design);
    assert.equal(r.reason, 'design-refused', `${name}: ${JSON.stringify(r)}`);
    assert.ok(r.issues.some((i) => i.file === file && (i.id ?? '') === id && (i.field ?? i.section) === where), `${name}: ${JSON.stringify(r.issues)}`);
    assert.equal(tree(dir), null, name);
  }
});

test('a brief section may hold its own subheadings and closed fences', (t) => {
  const design = join(scratch('cad-agile-sub-', t), 'design');
  cpSync(FIXTURE, design, { recursive: true });
  const brief = join(design, 'brief.md');
  writeFileSync(brief, readFileSync(brief, 'utf8').replace('- Overdue tools', '### Later\n```\n# a comment\n```\n- Overdue tools'));
  assert.equal(start(answerSetup(planning(t)), design).ok, true);
});

test('a .planning that only an earlier seam call stamped is a new project', (t) => {
  const dir = planning(t);
  mkdirSync(join(dir, 'seldon'), { recursive: true });
  spawnSync('node', [join(dirname(AGILE), 'planning.mjs'), 'status', '--dir', dir]);
  assert.equal(readState(dir).kind, 'valid');
  assert.equal(start(answerSetup(dir)).ok, true);
  assert.equal(readState(dir).reason, 'agile-path');
});

test('a start killed as it made the records folder still leaves its ignore file', (t) => {
  const dir = planning(t);
  mkdirSync(join(dir, 'records'), { recursive: true });
  assert.equal(start(answerSetup(dir)).ok, true);
  assert.deepEqual(files(dir), FILES);
});

test('a start killed halfway is finished by the next one, which clears the dead run\'s folder and not a live one\'s', (t) => {
  const dir = planning(t);
  mkdirSync(dir);
  assert.equal(markAgile(dir).ok, true);
  const dead = spawnSync('node', ['-e', '']).pid;
  for (const pid of [dead, process.pid]) {
    mkdirSync(join(buildDir(dir, pid), 'epics', 'E-01'), { recursive: true });
    writeFileSync(join(buildDir(dir, pid), 'epics', 'E-01', 'epic.md'), 'half');
  }
  assert.equal(start(answerSetup(dir)).ok, true);
  assert.equal(existsSync(buildDir(dir, dead)), false);
  assert.equal(existsSync(buildDir(dir, process.pid)), true);
  rmSync(buildDir(dir, process.pid), { recursive: true });
  assert.deepEqual(files(dir), FILES);
});

test('of two starts at once one writes the release and the other finds it open', async (t) => {
  const dir = answerSetup(planning(t));
  const one = () => new Promise((res) => {
    const c = spawn('node', [AGILE, 'start', '--design', FIXTURE, '--dir', dir], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    c.stdout.on('data', (b) => { out += b; });
    c.on('close', () => res(JSON.parse(out)));
  });
  const both = await Promise.all([one(), one()]);
  assert.deepEqual(both.map((r) => (r.ok ? 'ok' : r.reason)).sort(), ['ok', 'release-open']);
  assert.deepEqual(files(dir), FILES);
  assert.deepEqual(readdirSync(dir).sort(), ['agile', 'config.json', 'records']);
});

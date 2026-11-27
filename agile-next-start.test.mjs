// Zero-dep tests for agile.mjs start after a close - the next release written beside the closed one, or refused with nothing written.
// Run: node --test tests/agile-next-start.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerSetup, scratch } from './planning.test.mjs';
import { buildDir, epicFile, storyFile } from '../cadence-core/bin/lib/agile-paths.mjs';
import { readEpicFile, readReleaseFile, readRequirementsFile } from '../cadence-core/bin/lib/agile-read.mjs';
import { judgeAsk } from '../cadence-core/bin/lib/agile-refine.mjs';
import { renderAskChanged, renderRequirementsFile, renderStoryFile } from '../cadence-core/bin/lib/agile-render.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGILE = join(HERE, '..', 'cadence-core', 'bin', 'agile.mjs');
const FIXTURE = join(HERE, 'fixtures', 'seldon-design');

const run = (dir, ...args) => {
  const r = spawnSync('node', [AGILE, ...args, '--dir', dir], { encoding: 'utf8' });
  return { ...JSON.parse(r.stdout), _exit: r.status };
};
const agile = (dir) => join(dir, 'agile');
const edit = (file, from, to) => writeFileSync(file, readFileSync(file, 'utf8').replace(from, to));
const tree = (root) => readdirSync(root, { recursive: true }).map(String).sort()
  .map((p) => [p, statSync(join(root, p)).mtimeMs, statSync(join(root, p)).isFile() ? readFileSync(join(root, p), 'utf8') : '']);
const RULES = '- Test the commit line on a removed file. (E-01, Change next 1)\n- Read a closed release as untrusted. (E-02, Change next 2)';
const STAYS = ['backlog.md', 'declined.md', 'filed.md', 'tasks', 'releases'];
const NEW = ['epics', 'REQUIREMENTS.md', 'project.md', 'release.md'];

/** The fixture as the next release's design: a new title, and IDs the closed release never used but the one it deferred. */
function second(t, more = {}) {
  const folder = join(scratch('cad-agile-next-design-', t), 'design');
  mkdirSync(folder, { recursive: true });
  const ids = { 'CAT-01': 'CAT-03', 'LOAN-01': 'LOAN-04', 'LOAN-02': 'LOAN-05', 'LOAN-03': 'LOAN-06', 'NFR-01': 'NFR-03', 'NFR-02': 'NFR-04', ...more };
  for (const name of readdirSync(FIXTURE)) {
    const text = readFileSync(join(FIXTURE, name), 'utf8').replaceAll('Toolshed', 'Toolshed Lending')
      .replace(/\b(?:CAT|LOAN|NFR)-\d{2}\b/g, (id) => ids[id] ?? id);
    writeFileSync(join(folder, name), text);
  }
  return folder;
}

/** A release closed as 0.10.0 with CAT-02 deferred, its project.md holding Standing rules, and a ledger, a backlog and a task's records beside it. */
function closed(t) {
  const root = join(scratch('cad-agile-next-', t), 'repo');
  mkdirSync(root, { recursive: true });
  const dir = answerSetup(join(root, '.planning'));
  assert.equal(run(dir, 'start', '--design', FIXTURE).ok, true);
  for (const id of ['E-01', 'E-02', 'E-03']) {
    edit(epicFile(agile(dir), id), /^status: .*$/m, 'status: done');
    const requirements = readEpicFile(readFileSync(epicFile(agile(dir), id), 'utf8')).requirements.filter((q) => q !== 'CAT-02');
    writeFileSync(storyFile(agile(dir), `${id}-1`), renderStoryFile({ id: `${id}-1`, title: `All of ${id}`, size: 'S', status: 'done', builds_on: [],
      requirements, delivers: 'Everything the epic asks.', accepted_when: ['Running it shows it.'] }));
  }
  writeFileSync(join(root, 'close.json'), JSON.stringify({ version: '0.10.0', defer: ['CAT-02'] }));
  assert.equal(run(dir, 'close', '--payload', join(root, 'close.json')).ok, true);
  const project = join(agile(dir), 'project.md');
  writeFileSync(project, `${readFileSync(project, 'utf8').trimEnd()}\n\n## Standing rules\n\n${RULES}\n`);
  writeFileSync(join(agile(dir), 'backlog.md'), '## Todos\n\n- [ ] a later one\n');
  writeFileSync(join(agile(dir), 'declined.md'), '# Declined\n\n- one ruled low\n');
  writeFileSync(join(agile(dir), 'filed.md'), '# Filed\n\n- #12\n');
  mkdirSync(join(agile(dir), 'tasks', 'e-01-1'), { recursive: true });
  writeFileSync(join(agile(dir), 'tasks', 'e-01-1', 'REVIEW-risk_surface-ab12cd3-ef45678.md'), '# Review\n');
  return { root, dir };
}
const kept = (dir) => STAYS.map((name) => {
  const path = join(agile(dir), name);
  return [name, statSync(path).mtimeMs, statSync(path).isFile() ? readFileSync(path, 'utf8') : tree(path)];
});

test('a start after a close writes the next release beside the closed one, its epics after E-03 and the Standing rules kept', (t) => {
  const { dir } = closed(t);
  const before = kept(dir);
  const r = run(dir, 'start', '--design', second(t));
  assert.deepEqual([r.ok, r.release, r.epics.map((e) => e.id), r.next.id], [true, 'Toolshed Lending', ['E-04', 'E-05', 'E-06'], 'E-04'], JSON.stringify(r));
  assert.deepEqual(kept(dir), before);
  assert.deepEqual(readdirSync(agile(dir)).sort(), [...STAYS, ...NEW].sort());
  assert.deepEqual(readdirSync(join(agile(dir), 'epics')).sort(), ['E-04', 'E-05', 'E-06']);
  const buildsOn = (id) => /^builds_on: (.*)$/m.exec(readFileSync(epicFile(agile(dir), id), 'utf8'))[1];
  assert.deepEqual(['E-04', 'E-05', 'E-06'].map(buildsOn), ['None', 'E-04', 'E-05']);
  const release = readReleaseFile(readFileSync(join(agile(dir), 'release.md'), 'utf8'));
  assert.deepEqual([release.title, release.epics.map((e) => e.id)], ['Toolshed Lending', ['E-04', 'E-05', 'E-06']]);
  const project = readFileSync(join(agile(dir), 'project.md'), 'utf8');
  assert.match(project, /^# Toolshed Lending\n/);
  assert.ok(project.endsWith(`\n## Standing rules\n\n${RULES}\n`), project);
  assert.equal(project.split('## Standing rules').length, 2);
  const next = run(dir, 'next');
  assert.deepEqual([next.release, next.next.id, next.next.step], ['Toolshed Lending', 'E-04', 'refine'], JSON.stringify(next));
  assert.equal(run(dir, 'start', '--design', second(t)).reason, 'release-open');
});

test('a start after a close stopped after each move is finished by the next, which clears the dead run\'s folder', (t) => {
  const design = second(t);
  const want = closed(t);
  run(want.dir, 'start', '--design', design);
  for (const moved of [['epics'], ['epics', 'REQUIREMENTS.md'], ['epics', 'REQUIREMENTS.md', 'project.md']]) {
    const { dir } = closed(t);
    const before = kept(dir);
    const dead = buildDir(dir, spawnSync('node', ['-e', '']).pid);
    mkdirSync(dead, { recursive: true });
    for (const name of NEW) cpSync(join(agile(want.dir), name), join(moved.includes(name) ? agile(dir) : dead, name), { recursive: true });
    assert.equal(run(dir, 'next').release, null);
    const r = run(dir, 'start', '--design', design);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(existsSync(dead), false);
    assert.deepEqual(kept(dir), before);
    for (const name of NEW) {
      assert.deepEqual(tree(join(agile(dir), name === 'epics' ? 'epics' : '.')).filter(([p]) => name === 'epics' || p === name).map(([p, , text]) => [p, text]),
        tree(join(agile(want.dir), name === 'epics' ? 'epics' : '.')).filter(([p]) => name === 'epics' || p === name).map(([p, , text]) => [p, text]), `${moved}: ${name}`);
    }
  }
});

test('a start after a close stopped by a move that fails leaves no release open, and the next start finishes it', (t) => {
  const { dir } = closed(t);
  const before = kept(dir);
  // a folder where REQUIREMENTS.md goes stops the start after its epics moved, so whatever moved before release.md shows
  mkdirSync(join(agile(dir), 'REQUIREMENTS.md', 'blocker'), { recursive: true });
  const stopped = run(dir, 'start', '--design', second(t));
  assert.equal(stopped.ok, false, JSON.stringify(stopped));
  assert.deepEqual(readdirSync(join(agile(dir), 'epics')).sort(), ['E-04', 'E-05', 'E-06']);
  assert.equal(existsSync(join(agile(dir), 'release.md')), false);
  assert.match(readFileSync(join(agile(dir), 'project.md'), 'utf8'), /^# Toolshed\n/);
  assert.equal(run(dir, 'next').release, null);
  rmSync(join(agile(dir), 'REQUIREMENTS.md'), { recursive: true });
  const r = run(dir, 'start', '--design', second(t));
  assert.deepEqual([r.ok, r.epics.map((e) => e.id)], [true, ['E-04', 'E-05', 'E-06']], JSON.stringify(r));
  assert.deepEqual(readdirSync(dirname(agile(dir))).filter((n) => n.startsWith('agile.new.')), []);
  assert.deepEqual(kept(dir), before);
});

test('a start after a close passes over an empty build folder, whatever its pid, and clears it', (t) => {
  const { dir } = closed(t);
  mkdirSync(buildDir(dir, process.pid), { recursive: true });
  assert.equal(run(dir, 'start', '--design', second(t)).ok, true);
  assert.equal(existsSync(buildDir(dir, process.pid)), false);
});

test('a start after a close that can\'t be made is refused before anything is written', (t) => {
  const cases = [
    ['design-refused', (dir, design) => rmSync(join(design, 'epics.md'))],
    ['project-file', (dir) => { rmSync(join(agile(dir), 'project.md')); symlinkSync(join(agile(dir), 'backlog.md'), join(agile(dir), 'project.md')); }],
    ['start-running', (dir) => { mkdirSync(join(buildDir(dir, process.pid), 'epics'), { recursive: true }); }],
    // two IDs that are one number would land on one folder once moved past E-03
    ['epic-numbers', (dir, design) => {
      edit(join(design, 'epics.md'), '## E-02:', '## E-001:');
      edit(join(design, 'epics.md'), '**Depends on:** E-02', '**Depends on:** E-001');
    }],
    ['epic-numbers', (dir) => mkdirSync(join(agile(dir), 'releases', '0.10.0', 'epics', 'E-9007199254740990'))],
    // the closed release's own design again: CAT-01 and the rest are done there
    ['requirement-ids-used', (dir, design) => cpSync(FIXTURE, design, { recursive: true })],
    ['closed-requirements', (dir) => writeFileSync(join(agile(dir), 'releases', '0.10.0', 'REQUIREMENTS.md'), 'a line no close writes\n', { flag: 'a' })],
    ['closed-requirements', (dir) => {
      rmSync(join(agile(dir), 'releases', '0.10.0', 'REQUIREMENTS.md'));
      symlinkSync(join(agile(dir), 'backlog.md'), join(agile(dir), 'releases', '0.10.0', 'REQUIREMENTS.md'));
    }],
    ['closed-release', (dir) => writeFileSync(join(agile(dir), 'releases', 'notes.txt'), 'not a release\n')],
    // CAT-1 is CAT-01's number however it's padded
    ['requirement-ids-used', (dir, design) => {
      for (const name of ['prd.md', 'epics.md']) edit(join(design, name), /CAT-03/g, 'CAT-1');
    }],
  ];
  for (const [reason, set] of cases) {
    const { root, dir } = closed(t);
    const design = second(t);
    set(dir, design);
    const before = tree(root);
    const r = run(dir, 'start', '--design', design);
    assert.deepEqual([r.ok, r.reason], [false, reason], JSON.stringify(r));
    assert.deepEqual(tree(root), before, reason);
    if (reason === 'start-running') assert.ok(r.hint.includes(buildDir(dir, process.pid)), r.hint);
    if (reason === 'requirement-ids-used') assert.match(r.hint, /CAT-02, LOAN-03, NFR-02/);
  }
});

const requirements = (dir) => readRequirementsFile(readFileSync(join(agile(dir), 'REQUIREMENTS.md'), 'utf8'));

test('the next release carries what the closed one deferred and the highest ID each prefix used', (t) => {
  const { dir } = closed(t);
  assert.equal(run(dir, 'start', '--design', second(t, { 'CAT-02': 'CAT-04' })).ok, true);
  const read = requirements(dir);
  assert.equal(read.whole, true);
  assert.deepEqual(read.deferred, [{ id: 'CAT-02', text: 'A member searches the catalog by name or category.' }]);
  assert.deepEqual(read.earlier, ['CAT-02', 'LOAN-03', 'NFR-02']);
  assert.equal(read.requirements.some((q) => q.id === 'CAT-02'), false);
  assert.equal(run(dir, 'next').next.step, 'refine');
});

test('a design naming a deferred requirement takes it up with its own words', (t) => {
  const { dir } = closed(t);
  const design = second(t);
  edit(join(design, 'prd.md'), 'searches the catalog by name or category.', 'searches the catalog by name.');
  assert.equal(run(dir, 'start', '--design', design).ok, true);
  const read = requirements(dir);
  assert.deepEqual([read.whole, read.deferred], [true, []]);
  assert.equal(read.requirements.find((q) => q.id === 'CAT-02').text, 'A member searches the catalog by name.');
});

test('every closed release counts: what a later one finished is no longer deferred, and its IDs and epics are passed', (t) => {
  const { dir } = closed(t);
  const home = join(agile(dir), 'releases', '0.11.0');
  mkdirSync(join(home, 'epics', 'E-05'), { recursive: true });
  writeFileSync(join(home, 'REQUIREMENTS.md'), renderRequirementsFile('Toolshed More',
    [{ id: 'CAT-02', category: 'Catalog', text: 'A member searches the catalog.' }, { id: 'CAT-05', category: 'Catalog', text: 'A tool has a condition.' }],
    [{ id: 'LOAN-07', text: 'A loan renews once.' }], ['CAT-02', 'LOAN-03', 'NFR-02']));
  const r = run(dir, 'start', '--design', second(t, { 'CAT-02': 'CAT-06' }));
  assert.deepEqual([r.ok, r.epics.map((e) => e.id)], [true, ['E-06', 'E-07', 'E-08']], JSON.stringify(r));
  const read = requirements(dir);
  assert.deepEqual(read.deferred, [{ id: 'LOAN-07', text: 'A loan renews once.' }]);
  assert.deepEqual(read.earlier, ['CAT-05', 'LOAN-07', 'NFR-02']);
});

test('the earlier releases\' highest IDs are read back only whole, kept through a defer, and counted by a refinement\'s next ID', () => {
  const text = renderRequirementsFile('T', [{ id: 'LOAN-04', category: 'Lending', text: 'a' }, { id: 'LOAN-05', category: 'Lending', text: 'b' }], [], ['LOAN-09', 'NFR-02']);
  const read = readRequirementsFile(text);
  assert.deepEqual([read.whole, read.earlier], [true, ['LOAN-09', 'NFR-02']]);
  const deferred = readRequirementsFile(renderAskChanged(text, read, ['LOAN-05'], []));
  assert.deepEqual([deferred.whole, deferred.earlier, deferred.deferred.map((q) => q.id)], [true, ['LOAN-09', 'NFR-02'], ['LOAN-05']]);
  assert.equal(readRequirementsFile(text.replace('- NFR-02', '- LOAN-10')).whole, false);
  assert.equal(readRequirementsFile(text.replace('- LOAN-09\n- NFR-02\n', '')).whole, false);
  const ask = (id) => judgeAsk({ defer: [], add: [{ id, text: 'c' }] }, { own: ['LOAN-04'], file: read, named: new Set(['LOAN-04', 'LOAN-05']) });
  assert.deepEqual(ask('LOAN-06').issues.map((i) => i.problem), ['is LOAN-06, and the next LOAN is LOAN-10']);
  assert.deepEqual([ask('LOAN-10').issues, ask('NFR-03').issues], [[], []]);
});

/** A closed release made by hand, deferring CAT-02 in its own words, with its folder's mtime set. */
function handClosed(dir, version, words, at) {
  const home = join(agile(dir), 'releases', version);
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'REQUIREMENTS.md'), renderRequirementsFile(version, [], [{ id: 'CAT-02', text: words }]));
  utimesSync(home, at, at);
}

test('the newest closed release\'s words for a requirement deferred again are carried: semver by version and above the rest, the rest by mtime', (t) => {
  const words = (dir) => run(dir, 'start', '--design', second(t, { 'CAT-02': 'CAT-04' })).ok && requirements(dir).deferred.find((q) => q.id === 'CAT-02').text;
  const mixed = closed(t).dir;
  handClosed(mixed, '1.10.0', 'Words of 1.10.0.', 1000);
  handClosed(mixed, '1.9.0', 'Words of 1.9.0.', 3000);
  handClosed(mixed, 'release-x', 'Words of release-x.', 5000);
  assert.equal(words(mixed), 'Words of 1.10.0.');
  const named = closed(t).dir;
  renameSync(join(agile(named), 'releases', '0.10.0'), join(agile(named), 'releases', 'release-9'));
  utimesSync(join(agile(named), 'releases', 'release-9'), 1000, 1000);
  handClosed(named, 'release-10', 'Words of release-10.', 3000);
  assert.equal(words(named), 'Words of release-10.');
});

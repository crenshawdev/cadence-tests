// Zero-dep tests for agile.mjs start after a close - the next release written beside the closed one, or refused with nothing written.
// Run: node --test tests/agile-next-start.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerSetup, scratch } from './planning.test.mjs';
import { buildDir, epicFile, storyFile } from '../cadence-core/bin/lib/agile-paths.mjs';
import { readEpicFile, readReleaseFile } from '../cadence-core/bin/lib/agile-read.mjs';
import { renderStoryFile } from '../cadence-core/bin/lib/agile-render.mjs';

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
function second(t) {
  const folder = join(scratch('cad-agile-next-design-', t), 'design');
  mkdirSync(folder, { recursive: true });
  const ids = { 'CAT-01': 'CAT-03', 'LOAN-01': 'LOAN-04', 'LOAN-02': 'LOAN-05', 'LOAN-03': 'LOAN-06', 'NFR-01': 'NFR-03', 'NFR-02': 'NFR-04' };
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

test('a start after a close that can\'t be made is refused before anything is written', (t) => {
  const cases = [
    ['design-refused', (dir, design) => rmSync(join(design, 'epics.md'))],
    ['project-file', (dir) => { rmSync(join(agile(dir), 'project.md')); symlinkSync(join(agile(dir), 'backlog.md'), join(agile(dir), 'project.md')); }],
    ['start-running', (dir) => mkdirSync(buildDir(dir, process.pid), { recursive: true })],
  ];
  for (const [reason, set] of cases) {
    const { root, dir } = closed(t);
    const design = second(t);
    set(dir, design);
    const before = tree(root);
    const r = run(dir, 'start', '--design', design);
    assert.deepEqual([r.ok, r.reason], [false, reason], JSON.stringify(r));
    assert.deepEqual(tree(root), before, reason);
  }
});

// Zero-dep tests for a start without a design: agile.mjs design-folder, which names where the design goes or refuses.
// Run: node --test tests/agile-design.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerSetup, scratch } from './planning.test.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGILE = join(HERE, '..', 'cadence-core', 'bin', 'agile.mjs');
const FIXTURE = join(HERE, 'fixtures', 'seldon-design');

const run = (dir, ...args) => {
  const r = spawnSync('node', [AGILE, ...args, '--dir', dir], { encoding: 'utf8' });
  return { ...JSON.parse(r.stdout), _exit: r.status };
};
const tree = (root) => readdirSync(root, { recursive: true }).map(String).sort()
  .map((p) => [p, statSync(join(root, p)).mtimeMs, statSync(join(root, p)).isFile() ? readFileSync(join(root, p), 'utf8') : '']);
const project = (t) => {
  const root = join(scratch('cad-agile-design-', t), 'repo');
  mkdirSync(root, { recursive: true });
  return { root, dir: join(root, '.planning') };
};

test('design-folder names the top of .planning/seldon/ for a first design, and a folder named for the title once the top holds one', (t) => {
  const { root, dir } = project(t);
  assert.deepEqual(run(dir, 'design-folder', '--title', 'Toolshed Lending'), { ok: true, folder: join(dir, 'seldon'), slug: 'toolshed-lending', _exit: 0 });
  assert.deepEqual(readdirSync(root), []);
  mkdirSync(join(dir, 'seldon'), { recursive: true });
  writeFileSync(join(dir, 'seldon', 'brief.md'), '# Toolshed\n');
  const r = run(dir, 'design-folder', '--title', 'Toolshed: Lending, again!');
  assert.deepEqual([r.ok, r.folder, r.slug], [true, join(dir, 'seldon', 'toolshed-lending-again'), 'toolshed-lending-again']);
});

test('design-folder answers after a close, as a start after one does', (t) => {
  const { root, dir } = project(t);
  answerSetup(dir);
  assert.equal(run(dir, 'start', '--design', FIXTURE).ok, true);
  for (const id of ['E-01', 'E-02', 'E-03']) {
    const file = join(dir, 'agile', 'epics', id, 'epic.md');
    writeFileSync(file, readFileSync(file, 'utf8').replace(/^status: .*$/m, 'status: done'));
  }
  writeFileSync(join(root, 'close.json'), JSON.stringify({ version: '0.10.0', defer: ['CAT-01', 'CAT-02', 'LOAN-01', 'LOAN-02', 'LOAN-03', 'NFR-01', 'NFR-02'] }));
  assert.equal(run(dir, 'close', '--payload', join(root, 'close.json')).ok, true);
  assert.equal(run(dir, 'design-folder', '--title', 'Toolshed Lending').ok, true);
});

test('design-folder refuses a folder that holds a design, a title with nothing to name it by, a link, an open release and an old-path project, writing nothing', (t) => {
  const cases = [
    ['design-there', 'Toolshed Lending', (dir) => {
      mkdirSync(join(dir, 'seldon', 'toolshed-lending'), { recursive: true });
      writeFileSync(join(dir, 'seldon', 'brief.md'), '# Toolshed\n');
      writeFileSync(join(dir, 'seldon', 'toolshed-lending', 'prd.md'), '# Toolshed Lending - PRD\n');
    }],
    ['title-slug', '!!! ---', () => {}],
    ['design-folder', 'Toolshed', (dir, root) => {
      mkdirSync(join(root, 'elsewhere'), { recursive: true });
      mkdirSync(dir, { recursive: true });
      symlinkSync(join(root, 'elsewhere'), join(dir, 'seldon'));
    }],
    ['release-open', 'Toolshed', (dir) => { answerSetup(dir); assert.equal(run(dir, 'start', '--design', FIXTURE).ok, true); }],
    ['old-path', 'Toolshed', (dir) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'PROJECT.md'), '# Toolshed\n'); }],
  ];
  for (const [reason, title, set] of cases) {
    const { root, dir } = project(t);
    set(dir, root);
    const before = tree(root);
    const r = run(dir, 'design-folder', '--title', title);
    assert.deepEqual([r.ok, r.reason], [false, reason], JSON.stringify(r));
    assert.deepEqual(tree(root), before, reason);
    if (reason === 'design-there') assert.ok(r.hint.includes(`/cad-agile --brief '${join(dir, 'seldon', 'toolshed-lending')}'`), r.hint);
  }
});

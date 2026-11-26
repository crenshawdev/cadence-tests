// Zero-dep tests for a start without a design: agile.mjs design-folder, which names where the design goes or refuses.
// Run: node --test tests/agile-design.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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
  assert.deepEqual(run(dir, 'design-folder', '--title', 'Toolshed Lending'), { ok: true, folder: join(dir, 'seldon'), slug: 'toolshed-lending', earlier: [], deferred: [], _exit: 0 });
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
  const r = run(dir, 'design-folder', '--title', 'Toolshed Lending');
  // the draft numbers past these, and takes a deferred one back by its own ID
  assert.deepEqual([r.ok, r.earlier, r.deferred.map((q) => q.id)], [true, ['CAT-02', 'LOAN-03', 'NFR-02'], ['CAT-01', 'CAT-02', 'LOAN-01', 'LOAN-02', 'LOAN-03', 'NFR-01', 'NFR-02']]);
});

test('design-folder with no title lists the designs no release has started from, and no closed release\'s own', (t) => {
  const { root, dir } = project(t);
  assert.deepEqual(run(dir, 'design-folder'), { ok: true, waiting: [], _exit: 0 });
  mkdirSync(join(dir, 'seldon', 'seed-swap'), { recursive: true });
  writeFileSync(join(dir, 'seldon', 'brief.md'), '# Toolshed\n');
  writeFileSync(join(dir, 'seldon', 'seed-swap', 'brief.md'), '# Seed Swap\n');
  assert.deepEqual(run(dir, 'design-folder').waiting.map((d) => d.title), ['Toolshed', 'Seed Swap']);
  answerSetup(dir);
  assert.equal(run(dir, 'start', '--design', FIXTURE).ok, true);
  for (const id of ['E-01', 'E-02', 'E-03']) {
    const file = join(dir, 'agile', 'epics', id, 'epic.md');
    writeFileSync(file, readFileSync(file, 'utf8').replace(/^status: .*$/m, 'status: done'));
  }
  writeFileSync(join(root, 'close.json'), JSON.stringify({ version: '0.10.0', defer: ['CAT-01', 'CAT-02', 'LOAN-01', 'LOAN-02', 'LOAN-03', 'NFR-01', 'NFR-02'] }));
  assert.equal(run(dir, 'close', '--payload', join(root, 'close.json')).ok, true);
  assert.deepEqual(run(dir, 'design-folder').waiting, [{ folder: join(dir, 'seldon', 'seed-swap'), title: 'Seed Swap' }]);
});

test('design-folder refuses a folder that holds a design, a title with nothing to name it by, a link, an open release and an old-path project, writing nothing', (t) => {
  const cases = [
    ['design-there', 'Toolshed Lending', (dir) => {
      mkdirSync(join(dir, 'seldon', 'toolshed-lending'), { recursive: true });
      writeFileSync(join(dir, 'seldon', 'brief.md'), '# Toolshed\n');
      writeFileSync(join(dir, 'seldon', 'toolshed-lending', 'brief.md'), '# Toolshed Lending\n');
    }],
    // anything in the named folder takes the name, an architecture.md left from another design included
    ['design-there', 'Toolshed Lending', (dir) => {
      mkdirSync(join(dir, 'seldon', 'toolshed-lending'), { recursive: true });
      writeFileSync(join(dir, 'seldon', 'brief.md'), '# Toolshed\n');
      writeFileSync(join(dir, 'seldon', 'toolshed-lending', 'architecture.md'), '# Toolshed Lending - architecture\n');
    }],
    ['design-started', 'Toolshed Lending', (dir) => {
      mkdirSync(join(dir, 'seldon'), { recursive: true });
      writeFileSync(join(dir, 'seldon', 'prd.md'), '# Toolshed - PRD\n');
    }],
    ['title-slug', '!!! ---', () => {}],
    ['title-slug', 'Architecture', (dir) => { mkdirSync(join(dir, 'seldon'), { recursive: true }); writeFileSync(join(dir, 'seldon', 'brief.md'), '# Toolshed\n'); }],
    ['title-slug', 'a'.repeat(65), () => {}],
    ['design-folder', 'Toolshed', (dir, root) => {
      mkdirSync(join(root, 'elsewhere'), { recursive: true });
      mkdirSync(join(dir, 'seldon'), { recursive: true });
      writeFileSync(join(dir, 'seldon', 'brief.md'), '# Toolshed\n');
      symlinkSync(join(root, 'elsewhere'), join(dir, 'seldon', 'toolshed'));
    }],
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
    if (reason === 'design-there') {
      const named = existsSync(join(dir, 'seldon', 'toolshed-lending', 'brief.md'));
      assert.equal(r.hint.includes(`/cad-agile --brief '${join(dir, 'seldon', 'toolshed-lending')}'`), named, r.hint);
    }
  }
});

test('design-folder answers the top while no brief.md is there, whatever sits at the named path, and refuses a path /cad-agile --brief would', (t) => {
  const { dir } = project(t);
  mkdirSync(join(dir, 'seldon'), { recursive: true });
  writeFileSync(join(dir, 'seldon', 'toolshed'), 'a file where a named design could go\n');
  assert.deepEqual([run(dir, 'design-folder', '--title', 'Toolshed').folder], [join(dir, 'seldon')]);
  const quoted = join(scratch('cad-agile-design-', t), "o'b x", '.planning');
  const r = run(quoted, 'design-folder', '--title', 'Toolshed');
  assert.deepEqual([r.ok, r.reason], [false, 'design-path'], JSON.stringify(r));
});

const WORKFLOWS = join(HERE, '..', 'cadence-core', 'workflows');
const SKELETONS = join(HERE, '..', 'cadence-core', 'templates', 'design.md');
const prose = (name) => readFileSync(join(WORKFLOWS, name), 'utf8');

/** The four skeletons filled with plain words, into a folder of their own. */
function filled(root) {
  const design = join(root, 'design');
  mkdirSync(design, { recursive: true });
  const blocks = [...readFileSync(SKELETONS, 'utf8').matchAll(/^## (\S+\.md)\n\n```markdown\n([\s\S]*?)```$/gm)];
  assert.deepEqual(blocks.map((m) => m[1]), ['brief.md', 'prd.md', 'spine.md', 'epics.md']);
  for (const [, name, skeleton] of blocks) {
    const text = skeleton.replaceAll('<Title>', 'Lending Shelf').replaceAll('<PREFIX>', 'SHELF').replaceAll('<NFR>', 'NFR')
      .replace(/^Kind: <[^>]+>$/m, 'Kind: stack').replace(/<[^>]+>/g, 'Plain words');
    writeFileSync(join(design, name), text);
  }
  return design;
}

test('the four skeletons, filled with plain words, are a design the start takes', (t) => {
  const { root, dir } = project(t);
  const design = filled(root);
  answerSetup(dir);
  const r = run(dir, 'start', '--design', design);
  assert.deepEqual([r.ok, r.release, r.epics.map((e) => e.id)], [true, 'Lending Shelf', ['E-01']], JSON.stringify(r));
});

test('a design Seldon\'s own check would refuse is refused: a kind it hasn\'t, the tag on a heading, six requirements on an epic, sections out of order', (t) => {
  const slips = [
    ['spine.md', /^Kind: stack$/m, 'Kind: nothing decided yet', /is not one of Seldon's kinds/],
    ['spine.md', /^(## S-01: .*)$/m, '$1 [ASSUMPTION]', /heading carries \[ASSUMPTION\]/],
    ['epics.md', /^\*\*Requirements:\*\* .*$/m, '**Requirements:** SHELF-01, SHELF-02, SHELF-03, SHELF-04, SHELF-05, NFR-01', /takes at most 5/],
    ['brief.md', /^## Vision\n.*\n?/m, '', null],
  ];
  for (const [file, from, to, why] of slips) {
    const { root, dir } = project(t);
    const design = filled(root);
    if (why === null) {
      const text = readFileSync(join(design, file), 'utf8');
      const vision = /## Vision\n[^#]*/.exec(text)[0];
      writeFileSync(join(design, file), text.replace(vision, '').replace('## Problem', `${vision.trimEnd()}\n\n## Problem`));
    } else writeFileSync(join(design, file), readFileSync(join(design, file), 'utf8').replace(from, to));
    if (file === 'epics.md') {
      const prd = join(design, 'prd.md');
      writeFileSync(prd, readFileSync(prd, 'utf8').replace('- **SHELF-02**', '- **SHELF-03**: c\n- **SHELF-04**: d\n- **SHELF-05**: e\n- **SHELF-02**'));
    }
    answerSetup(dir);
    const r = run(dir, 'start', '--design', design);
    assert.deepEqual([r.ok, r.reason], [false, 'design-refused'], `${file}: ${JSON.stringify(r)}`);
    assert.ok(r.issues.some((i) => (why ?? /Seldon's order/).test(i.problem)), JSON.stringify(r.issues));
  }
});

test('agile.md sends /cad-agile with no release and no --brief to the interview, which asks once, writes after a yes and checks before the start', () => {
  assert.match(prose('agile.md'), /- `release` is null, without it -> Read\n  `\$\{CLAUDE_PLUGIN_ROOT\}\/cadence-core\/workflows\/agile-design\.md` and follow it,\n  then go to `commit` unless it stopped\./);
  assert.doesNotMatch(prose('agile.md'), /No release is open here/);
  const text = prose('agile-design.md');
  assert.match(text, /One message, every question at once/);
  assert.equal((text.match(/^\d\. /gm) ?? []).length, 6);
  assert.match(text, /The turn ends there\. Nothing is written\./);
  const folder = 'node "${CLAUDE_PLUGIN_ROOT}/cadence-core/bin/agile.mjs" design-folder --title \'<the short name>\'';
  const at = (s) => { const i = text.indexOf(s); assert.ok(i >= 0, s); return i; };
  // the folder is asked before the draft is shown, again just before the write, then the check, then the start
  assert.ok(at(folder) < at('question: "Write this design and start the release from it?"'));
  assert.ok(at('agile.mjs" design-folder\n```') < at('## 2. Ask'));
  assert.ok(at('run the last `design-folder` line again') < at('Write the four files there with\nthe Write tool'));
  assert.ok(at('Write the four files there') < at('agile.mjs" check --design \'<folder>\''));
  assert.match(text, /On `design-refused`, fix each of `issues` in the files, and on\n`requirement-ids-used`/);
  assert.match(text, /at most twice in all/);
  assert.match(text, /On "Change it", take what the user says, redraft, ask `design-folder` again/);
  assert.match(text, /On "Stop", the run ends with nothing written and no commit\./);
  // section 1 starts a waiting design; a written one starts only after its check
  assert.ok(at('agile.mjs" check --design') < text.lastIndexOf('cadence-core/workflows/agile-start.md'));
  assert.ok(at('agile.mjs" design-folder\n```') < at('cadence-core/workflows/agile-start.md'));
  assert.match(text, /The design isn't committed, as on `--brief`\./);
});

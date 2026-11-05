// Tests for `planning.mjs workflow-claim take|release` - may a workflow launch now, with multi-workflow off or on.
// Run: node --test tests/planning-workflow-claim.test.mjs
//
// Driven through the CLI on a scratch git repo with real config layers: the repo's .planning/config.json and a
// CADENCE_GLOBAL_CONFIG file. The setting counts only when both layers set it, so the off shapes are all three ways to miss.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLANNING = join(ROOT, 'cadence-core', 'bin', 'planning.mjs');
const run = promisify(execFile);
const ON = { workflow: { multi_workflow: true } };

/** A scratch repo whose committed tree holds the repo layer; `repo`/`global` are config objects or null for no file. */
function tree(repo, global) {
  const root = mkdtempSync(join(tmpdir(), 'cad-wfc-'));
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T');
  mkdirSync(join(root, '.planning'));
  writeFileSync(join(root, 'a.txt'), 'a\n');
  if (repo) writeFileSync(join(root, '.planning', 'config.json'), JSON.stringify(repo));
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  const globalFile = join(root, '..', `${root.split('/').pop()}-global.json`);
  if (global) writeFileSync(globalFile, JSON.stringify(global));
  return { root, git, dir: join(root, '.planning'), env: { ...process.env, CADENCE_GLOBAL_CONFIG: globalFile } };
}

async function cli(t, sub, label, dir = t.dir) {
  let stdout;
  try { ({ stdout } = await run('node', [PLANNING, '--dir', dir, 'workflow-claim', sub, '--fire', label], { env: t.env, cwd: t.root })); } catch (e) { stdout = e.stdout; }
  return JSON.parse(stdout);
}

const claimFiles = (t) => readdirSync(join(t.root, '.git')).filter((f) => f.startsWith('cadence-workflow-claim'));

const OFF_SHAPES = [
  ['neither layer', null, null],
  ['repo only', ON, null],
  ['global only', null, ON],
];

for (const [name, repo, global] of OFF_SHAPES) {
  test(`off (${name}): the second claim waits, a wrong release frees nothing, the right one does`, async () => {
    const t = tree(repo, global);
    // repo-only leaves the committed layer in the tree; status stays clean because the claim is under .git
    assert.equal(t.git('status', '--porcelain'), '');
    const a = await cli(t, 'take', 'diff-plan-1');
    assert.equal(a.ok, true); assert.equal(a.launch, true);
    const b = await cli(t, 'take', 'diff-plan-2');
    assert.equal(b.launch, false);
    assert.equal(b.holder, 'diff-plan-1');
    assert.equal(typeof b.age_seconds, 'number');
    assert.equal((await cli(t, 'release', 'diff-plan-2')).released, false);
    assert.equal((await cli(t, 'take', 'diff-plan-2')).launch, false, 'the wrong label freed nothing');
    assert.equal((await cli(t, 'release', 'diff-plan-1')).released, true);
    assert.equal((await cli(t, 'release', 'diff-plan-1')).released, false, 'a retried release is fine');
    assert.equal((await cli(t, 'take', 'diff-plan-2')).launch, true);
    assert.equal(t.git('status', '--porcelain'), '');
    assert.deepEqual(claimFiles(t), ['cadence-workflow-claim'], 'no temp file is left beside the claim');
  });
}

test('on in both layers: two claims both launch and no file exists', async () => {
  const t = tree(ON, ON);
  assert.equal((await cli(t, 'take', 'diff-plan-1')).launch, true);
  assert.equal((await cli(t, 'take', 'diff-plan-2')).launch, true);
  assert.deepEqual(claimFiles(t), []);
  assert.equal(t.git('status', '--porcelain'), '');
});

test('off: eight processes claiming at once yield exactly one launch', async () => {
  const t = tree(null, null);
  const all = await Promise.all(Array.from({ length: 8 }, (_, i) => cli(t, 'take', `diff-plan-${i}`)));
  assert.equal(all.filter((r) => r.launch).length, 1);
  assert.equal(all.filter((r) => !r.launch).every((r) => /^diff-plan-\d$/.test(r.holder)), true);
});

test('off: an executor worktree sees the same claim', async () => {
  const t = tree(null, null);
  const wt = join(t.root, '..', `${t.root.split('/').pop()}-wt`);
  t.git('worktree', 'add', '-q', wt, '-b', 'side');
  mkdirSync(join(wt, '.planning'), { recursive: true });
  assert.equal((await cli(t, 'take', 'diff-plan-1')).launch, true);
  const r = await cli(t, 'take', 'diff-plan-2', join(wt, '.planning'));
  assert.equal(r.launch, false); assert.equal(r.holder, 'diff-plan-1');
});

test('a missing label is refused, and outside a repository nothing is claimed', async () => {
  const t = tree(null, null);
  const none = JSON.parse((await run('node', [PLANNING, '--dir', t.dir, 'workflow-claim', 'take'], { env: t.env, cwd: t.root }).catch((e) => e)).stdout || '{}');
  assert.equal(none.ok, false);
  const bare = mkdtempSync(join(tmpdir(), 'cad-wfc-nogit-'));
  mkdirSync(join(bare, '.planning'));
  const r = await cli({ ...t, root: bare }, 'take', 'x', join(bare, '.planning'));
  assert.equal(r.ok, false); assert.equal(r.reason, 'no-git');
});

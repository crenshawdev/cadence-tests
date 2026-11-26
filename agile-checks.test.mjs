// Zero-dep tests for agile.mjs check-commands and run-checks - a story's checks recorded, run, and the story done only
// when every one exits 0.
// Run: node --test tests/agile-checks.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerSetup, scratch } from './planning.test.mjs';
import { storyFile } from '../cadence-core/bin/lib/agile-paths.mjs';
import { readStoryChecks, readStoryFile } from '../cadence-core/bin/lib/agile-read.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGILE = join(HERE, '..', 'cadence-core', 'bin', 'agile.mjs');
const FIXTURE = join(HERE, 'fixtures', 'seldon-design');

const run = (dir, ...args) => {
  const r = spawnSync('node', [AGILE, ...args, '--dir', dir], { encoding: 'utf8' });
  return { ...JSON.parse(r.stdout), _exit: r.status };
};
const tree = (root) => readdirSync(root, { recursive: true }).map(String).sort()
  .map((p) => [p, statSync(join(root, p)).mtimeMs, statSync(join(root, p)).isFile() ? readFileSync(join(root, p), 'utf8') : '']);
const send = (dir, call, payload) => {
  const file = join(dirname(dir), 'payload.json');
  writeFileSync(file, JSON.stringify(payload));
  return run(dir, call, '--payload', file);
};
const node = (code) => `node -e ${JSON.stringify(code)}`;
const status = (file, word) => writeFileSync(file, readFileSync(file, 'utf8').replace(/^status: .*$/m, `status: ${word}`));

/** A refined release whose first story, E-01-1, has two checks and is being built. */
function building(t, status = 'in-progress') {
  const root = scratch('cad-agile-checks-', t);
  const dir = answerSetup(join(root, '.planning'));
  assert.equal(run(dir, 'start', '--design', FIXTURE).ok, true);
  const story = (over) => ({ title: 'Add a tool', size: 'S', builds_on: [], requirements: ['CAT-01'],
    delivers: 'A volunteer adds a tool.', accepted_when: ['Adding a tool shows it in the list.', 'A tool with no name is refused.'], ...over });
  const r = send(dir, 'refine', { epic: 'E-01', decisions: [], stories: [story(), story({ title: 'Search', builds_on: ['E-01-1'], requirements: ['CAT-02'] })] });
  assert.equal(r.ok, true, JSON.stringify(r));
  const file = storyFile(join(dir, 'agile'), 'E-01-1');
  writeFileSync(file, readFileSync(file, 'utf8').replace(/^status: .*$/m, `status: ${status}`).replace('## Result\n\nNone yet.', '## Result\n\n- Commits: abc1234'));
  return { root, dir, file };
}

// reviewed: in review, with the note the review leaves
const reviewed = (file) => writeFileSync(file, readFileSync(file, 'utf8').replace(/^status: .*$/m, 'status: review')
  .replace('- Commits: abc1234', '- Commits: abc1234\n- Review: one reviewer, nothing raised'));
const record = (dir, commands) => send(dir, 'check-commands', { story: 'E-01-1', commands });

test('recorded commands keep the rest of Result, and all passing turns a reviewed story done with each one written', (t) => {
  const { dir, file } = building(t);
  assert.deepEqual(record(dir, [node("console.log('listed')"), `  ${node("console.log('refused')")}  `]),
    { ok: true, story: 'E-01-1', commands: 2, _exit: 0 });
  assert.deepEqual(readStoryChecks(readFileSync(file, 'utf8')).map((c) => c.result), ['not run', 'not run']);
  reviewed(file);
  const r = run(dir, 'run-checks');
  assert.deepEqual([r.ok, r.status, r.passed, r.failed], [true, 'done', 2, []]);
  const text = readFileSync(file, 'utf8');
  assert.match(text, /## Result\n\n- Commits: abc1234\n- Review: one reviewer, nothing raised\n- Check 1: `node -e "console\.log\('listed'\)"` - exit 0, listed\n- Check 2: `node -e "console\.log\('refused'\)"` - exit 0, refused\n/);
  assert.equal(readStoryFile(text)?.status, 'done');
  assert.equal(run(dir, 'next').next.story.id, 'E-01-2');
});

test('one failing check sends the story back to in-progress and names it, and a command recorded again owes a new review', (t) => {
  const { dir, file } = building(t);
  record(dir, [node("console.log('fine')"), node("console.log('trying'); console.error('\\u001b[31mno name check\\u001b[0m'); process.exit(3)")]);
  reviewed(file);
  const r = run(dir, 'run-checks');
  assert.deepEqual([r.ok, r.status, r.passed], [true, 'in-progress', 1]);
  assert.deepEqual(r.failed, [{ check: 2, line: 'A tool with no name is refused.', result: 'exit 3, no name check' }]);
  assert.equal(readStoryFile(readFileSync(file, 'utf8'))?.status, 'in-progress');
  assert.equal(run(dir, 'next').next.story.id, 'E-01-1');
  writeFileSync(file, readFileSync(file, 'utf8').replace('- Review: one reviewer, nothing raised', '- Review: one reviewer, nothing raised\n- Fix round: check 2 tried'));
  assert.deepEqual(record(dir, [node('1'), node('1')]), { ok: true, story: 'E-01-1', commands: 2, review_cleared: true, _exit: 0 });
  const text = readFileSync(file, 'utf8');
  assert.doesNotMatch(text, /- Review: |- Fix round: /);
  assert.deepEqual(readStoryChecks(text).map((c) => c.result), ['not run', 'not run']);
  // put back in review by hand, it still waits for the review's note
  status(file, 'review');
  assert.equal(run(dir, 'run-checks').reason, 'not-reviewed');
});

test('commands are refused unless the story is being built, and checks run only once it is reviewed', (t) => {
  const { dir, file } = building(t, 'backlog');
  const before = tree(dir);
  assert.equal(record(dir, [node('1'), node('1')]).reason, 'commands-closed');
  status(file, 'in-progress');
  record(dir, [node('1'), node('1')]);
  const recorded = tree(dir);
  for (const word of ['backlog', 'in-progress']) {
    status(file, word);
    const at = tree(dir);
    assert.equal(run(dir, 'run-checks').reason, 'not-reviewed', word);
    assert.deepEqual(tree(dir), at);
  }
  reviewed(file);
  assert.equal(record(dir, [node('2'), node('2')]).reason, 'commands-closed');
  assert.notDeepEqual(recorded, before);
});

test('a missing, blank, multi-line, backticked or control-character command, a wrong count or another story is refused with nothing written', (t) => {
  const { dir } = building(t);
  const before = tree(dir);
  const ok = node('1');
  for (const [payload, reason] of [
    [{ story: 'E-01-1', commands: [ok] }, 'commands-refused'],
    [{ story: 'E-01-1', commands: [ok, ok, ok] }, 'commands-refused'],
    [{ story: 'E-01-1', commands: [ok, '  '] }, 'commands-refused'],
    [{ story: 'E-01-1', commands: [ok, 'echo a\necho b'] }, 'commands-refused'],
    [{ story: 'E-01-1', commands: [ok, 'echo `date`'] }, 'commands-refused'],
    [{ story: 'E-01-1', commands: [ok, 'echo a\u0000b'] }, 'commands-refused'],
    [{ story: 'E-01-1', commands: 'echo' }, 'commands-refused'],
    [{ commands: [ok, ok] }, 'commands-refused'],
    [{ story: 'E-01-2', commands: [ok, ok] }, 'not-building'],
  ]) {
    const r = send(dir, 'check-commands', payload);
    assert.deepEqual([r.ok, r.reason], [false, reason], JSON.stringify(payload));
  }
  assert.deepEqual(tree(dir), before);
});

test('a reviewed story with nothing recorded is refused, and its status is set in its frontmatter however it is spaced', (t) => {
  const { dir, file } = building(t);
  const said = readFileSync(file, 'utf8');
  writeFileSync(file, said.replace(/^status: .*$/m, 'status:review').replace('A volunteer adds a tool.', 'A volunteer adds a tool.\nstatus: kept')
    .replace('- Commits: abc1234', '- Commits: abc1234\n- Review: one reviewer, nothing raised'));
  const before = tree(dir);
  assert.equal(run(dir, 'run-checks').reason, 'checks-missing');
  assert.deepEqual(tree(dir), before);
  writeFileSync(file, readFileSync(file, 'utf8').replace('status:review', 'status: in-progress'));
  record(dir, [node('1'), node('1')]);
  writeFileSync(file, readFileSync(file, 'utf8').replace('status: in-progress', 'status:review'));
  assert.equal(run(dir, 'run-checks').status, 'done');
  const text = readFileSync(file, 'utf8');
  assert.equal(readStoryFile(text)?.status, 'done');
  assert.match(text, /\nstatus: kept\n/);
});

test("a check whose own process exits passes though something it started holds its output, and that's stopped", (t) => {
  const { root, dir, file } = building(t);
  record(dir, [node("require('fs').writeFileSync('bg.pid', String(process.pid)); setInterval(() => {}, 1000)")
    + ' & while [ ! -s bg.pid ]; do sleep 0.05; done; echo started', node('1')]);
  reviewed(file);
  const began = Date.now();
  const r = run(dir, 'run-checks');
  assert.deepEqual([r.status, r.passed], ['done', 2]);
  assert.ok(Date.now() - began < 30000, 'it did not wait for the background process');
  const pid = Number(readFileSync(join(root, 'bg.pid'), 'utf8'));
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test('a run stopped while a check runs leaves the story as it was, and the next run finishes it', async (t) => {
  const { root, dir, file } = building(t);
  // the second check waits while "slow" is there, so the first has run when the run is stopped
  record(dir, [node("require('fs').writeFileSync('started', '')"),
    node("const f = require('fs'); setInterval(() => { if (!f.existsSync('slow')) process.exit(0); }, 20)")]);
  reviewed(file);
  writeFileSync(join(root, 'slow'), '');
  const before = readFileSync(file, 'utf8');
  const child = spawn('node', [AGILE, 'run-checks', '--dir', dir], { stdio: 'ignore' });
  while (!existsSync(join(root, 'started'))) await new Promise((r) => setTimeout(r, 20));
  child.kill('SIGKILL');
  await new Promise((r) => child.on('exit', r));
  assert.equal(readFileSync(file, 'utf8'), before);
  rmSync(join(root, 'slow'));
  const r = run(dir, 'run-checks');
  assert.deepEqual([r.ok, r.status, r.passed], [true, 'done', 2]);
});

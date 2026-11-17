// Pins for /cad-map (Phase 3, plan 7). The workflow file is prose a model follows, so these hold what a rewrite could
// quietly lose: the order of the steps and the stops. The seams themselves are proved in plans 4 and 6, and
// the live run is checked at /cad-verify.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { relayIssues } from '../cadence-core/bin/lib/route-relay.mjs';
import { scratchPathIssues } from '../cadence-core/bin/lib/scratch-path.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILL = readFileSync(join(ROOT, 'skills', 'cad-map', 'SKILL.md'), 'utf8');
const RAW = readFileSync(join(ROOT, 'cadence-core', 'workflows', 'map.md'), 'utf8');
const MAP = RAW.replace(/\s+/g, ' ');
const CONFIG_MJS = join(ROOT, 'cadence-core', 'bin', 'config.mjs');
const PLANNING = join(ROOT, 'cadence-core', 'bin', 'planning.mjs');

/** Offsets of each needle in order, failing on the first that is missing or earlier than the one before. */
function inOrder(text, needles, from = 0) {
  let at = from;
  for (const n of needles) {
    const i = text.indexOf(n, at);
    assert.ok(i >= 0, `"${n}" does not follow the step before it`);
    at = i + n.length;
  }
}

// --- the skill ---------------------------------------------------------------

test('the skill lists both Workflow entries and no AskUserQuestion, and no Bash', () => {
  const tools = SKILL.slice(SKILL.indexOf('allowed-tools:'), SKILL.indexOf('---', SKILL.indexOf('allowed-tools:')));
  for (const t of ['Read', 'Write', 'Workflow', 'Workflow(cadence:code-map)']) assert.ok(tools.includes(`- ${t}\n`), `${t} is not listed`);
  assert.ok(!/AskUserQuestion/.test(SKILL), 'a typed yes is the ask, since AskUserQuestion has no headless answer');
  assert.ok(!/- Bash/.test(tools));
  assert.match(SKILL, /@\$\{CLAUDE_PLUGIN_ROOT\}\/cadence-core\/workflows\/map\.md/);
});

// --- the question ------------------------------------------------------------

test('the switch is read and the off stop comes before any scan', () => {
  inOrder(MAP, ['config.mjs" get planning.code_map parallelization.max_concurrent_agents', '`/cad-config planning.code_map=true`', 'and stop. Run nothing else', 'codemap scan']);
});

test('the order holds: switch, scan, the no-tool stop, the count and bytes, the yes', () => {
  inOrder(MAP, ['config.mjs" get planning.code_map', 'codemap scan', 'The `Workflow` tool is not in this session', 'print the count of modules and `bytes`', 'End the turn in plain text asking for a yes']);
});

test('the no-tool arm reports the scan\'s facts and has no single-agent fallback', () => {
  assert.match(MAP, /report `modules`, `bytes`, `stale` and `unbuilt`, say the build needs that tool, and stop\. There is no single-agent fallback/);
});

test('a current map starts nothing and asks nothing', () => {
  assert.match(MAP, /`readers` is 0: say the map is current and stop\. Start nothing and ask nothing/);
});

test('it names oversized and the line that re-cuts, and says the first build\'s cost is not measured', () => {
  assert.match(MAP, /Name each module in `oversized`[^.]*`rm \.planning\/records\/codemap\/index\.json`/);
  assert.match(MAP, /first build's token cost isn't measured/);
});

test('a refresh asks too, and only a typed yes goes on', () => {
  assert.match(MAP, /ask on a refresh too/);
  assert.match(MAP, /Only a typed yes in the next message goes on\. Any other reply starts nothing/);
});

// --- the launch --------------------------------------------------------------

test('the steps appear in order: resolve, status --out-dir, launch, end of turn, codemap write', () => {
  const after = MAP.indexOf('## 3. After a yes');
  inOrder(MAP, [
    'route.mjs" resolve --role cad-mapper --attempt 1',
    'codemap status --out-dir',
    'Launch the `Workflow` tool by its named entry `cadence:code-map`',
    'Otherwise end the turn',
    'codemap write --run-file',
  ], after);
});

test('the scratch directory made after the yes carries the guard', () => {
  const step = RAW.slice(RAW.indexOf('## 3. After a yes'));
  assert.match(step, /mktemp -d "\$\{TMPDIR:-\/tmp\}\/cad-XXXXXX"\)" && case "\$D" in \(\*\[!A-Za-z0-9\._\/-\]\*\) echo "scratch-unsafe: \$D" >&2; exit 1;; esac && echo "scratch dir: \$D"/);
});

test('the resolve line carries no --bracket-read, and the agent type comes from its answer', () => {
  const line = RAW.split('\n').find((l) => l.includes('route.mjs" resolve'));
  assert.ok(line && !line.includes('--bracket-read'), line);
  assert.match(MAP, /Take `agent_type` and `model` from the answer, never an agent name of your own/);
  assert.match(MAP, /An answer of `ok:false` takes the spawn-agent seam's arm: the base agent `cadence:cad-mapper` and `model` null/);
});

test('status --out-dir runs only after the yes', () => {
  assert.ok(MAP.indexOf('codemap status --out-dir') > MAP.indexOf('## 3. After a yes'));
  assert.match(MAP, /Only now pin the hashes, so they are the launch's and not the question's/);
  assert.equal(RAW.split('codemap status --out-dir').length, 2, 'status --out-dir appears once');
});

test('args retypes name, built_from and item exactly, with the resolve\'s agent_type and model and the batch size', () => {
  assert.match(MAP, /`args` is that file whole, retyped exactly: `root`, then `items`, each with its `name`, `built_from` and `item`/);
  assert.match(MAP, /Add the resolve's `agent_type` and `model` \(null when it answered none\) and `batch_size`, the `parallelization\.max_concurrent_agents` read in step 1/);
});

test('scriptPath names a file that exists', () => {
  const m = RAW.match(/`scriptPath` set to `\$\{CLAUDE_PLUGIN_ROOT\}\/(workflows\/code-map\.js)`/);
  assert.ok(m, 'scriptPath is not named');
  assert.ok(existsSync(join(ROOT, m[1])));
});

test('a refused compose, zero items, a refused launch and a launch never issued each stop the run', () => {
  assert.match(MAP, /A refusal is named in one line\./);
  assert.match(MAP, /With `items` 0 the map went current since the question: say so and start nothing/);
  assert.match(MAP, /A launch the host refuses: name it in one line, and say nothing was spent/);
  assert.match(MAP, /A launch call that never issues: name it in one line, without saying nothing was spent/);
});

// --- the notice --------------------------------------------------------------

test('codemap write carries --launch-file and the notice\'s totals', () => {
  assert.match(MAP, /codemap write --run-file <run file> --launch-file <the launch file status printed> \[--notice-tokens <n> --notice-turns <n> --notice-duration-ms <n>\]/);
});

test('the end names what was written, each refused module, each dead reader, and that only those rebuild', () => {
  assert.match(MAP, /Print `written`, each `refused` module with the reason it names, each `dead` reader, and each `missing` module/);
  assert.match(MAP, /stay stale and that `\/cad-map` again rebuilds only them/);
  assert.match(MAP, /A refusal of the call is named in one line\. One carrying `brackets` has billed its agents, and a `bad-args` one has billed nothing/);
});

test('a bad-args refusal is corrected and the same call run again before the run stops', () => {
  const i = MAP.indexOf('A `bad-args` refusal has billed and written nothing');
  assert.ok(i > 0, 'the bad-args arm is not stated');
  assert.match(MAP, /A `bad-args` refusal has billed and written nothing and the run file is still good, so correct the flag it names and run the same call again before you stop/);
});

test('a partial view of the launch file is read whole, or the run stops and never launches from it', () => {
  assert.match(MAP, /If `Read` answers a partial view, follow its instruction to read the whole file; if the whole file can't be had, name that in one line and start nothing, and never launch from a partial view/);
  assert.ok(!/allow_large/.test(MAP), 'a host parameter is named');
});

// --- the rules the lints hold ------------------------------------------------

test('the workflow file relays the resolve\'s warnings and keeps its scratch path per run', () => {
  assert.deepEqual(relayIssues(RAW), []);
  assert.match(MAP, /Relay every `warnings\[\]` entry to the user before you launch/);
  assert.deepEqual(scratchPathIssues('cadence-core/workflows/map.md', RAW), []);
});

// --- through the real seams on a scratch repository --------------------------

function scratchRepo() {
  const root = mkdtempSync(join(tmpdir(), 'cad-map-cmd-'));
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', stdio: 'pipe' });
  git('init', '-q'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T');
  mkdirSync(join(root, '.planning'));
  writeFileSync(join(root, 'a.js'), 'export function a() { return 1; }\n');
  writeFileSync(join(root, 'README.md'), '# r\n');
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  return root;
}

test('the first arm\'s switch reads false with no config, and a scan answers the counts the prose names', () => {
  const root = scratchRepo();
  try {
    const env = { ...process.env, CADENCE_GLOBAL_CONFIG: join(root, 'none.json') };
    const got = JSON.parse(execFileSync('node', [CONFIG_MJS, 'get', 'planning.code_map', 'parallelization.max_concurrent_agents'], { cwd: root, env, encoding: 'utf8' }));
    assert.equal(got.values['planning.code_map'], false);
    assert.equal(typeof got.values['parallelization.max_concurrent_agents'], 'number');
    const scan = JSON.parse(execFileSync('node', [PLANNING, '--dir', join(root, '.planning'), 'codemap', 'scan'], { cwd: root, encoding: 'utf8' }));
    assert.equal(scan.ok, true);
    for (const k of ['modules', 'bytes', 'built', 'stale', 'unbuilt', 'readers', 'reader_bytes', 'oversized']) assert.ok(k in scan, `${k} is missing from scan`);
    assert.equal(scan.readers, scan.unbuilt + scan.stale);
    assert.ok(scan.readers >= 1 && scan.reader_bytes > 0);
    assert.deepEqual(scan.oversized, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('scan outside a repository is refused with a reason and a hint to relay', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cad-map-none-'));
  try {
    mkdirSync(join(dir, '.planning'));
    let out;
    try { out = execFileSync('node', [PLANNING, '--dir', join(dir, '.planning'), 'codemap', 'scan'], { cwd: dir, encoding: 'utf8', stdio: 'pipe' }); } catch (e) { out = e.stdout; }
    const r = JSON.parse(out);
    assert.equal(r.ok, false);
    assert.ok(r.reason && r.hint);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

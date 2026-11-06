// Pins for /cad-map (Phase 3, plan 7). The workflow file is prose a model follows, so these hold what a rewrite could
// quietly lose: the order of the steps, the stops, and the releases. The seams themselves are proved in plans 4 and 6, and
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
  assert.match(MAP, /Name each module in `oversized`[^.]*`rm \.planning\/codemap\/index\.json`/);
  assert.match(MAP, /first build's token cost isn't measured/);
});

test('a refresh asks too, and only a typed yes goes on', () => {
  assert.match(MAP, /ask on a refresh too/);
  assert.match(MAP, /Only a typed yes in the next message goes on\. Any other reply starts nothing/);
});

test('it reads no workflow switch and names no layered-workflow reader', () => {
  assert.ok(!/use_workflows|workflow-layers/.test(RAW + SKILL));
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

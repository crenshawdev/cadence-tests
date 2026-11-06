// Tests for `planning.mjs codemap write` and `codemap status --out-dir`: a reader's answer becomes the map, and a launch is given what it needs.
// Run: node --test tests/codemap-write.test.mjs
//
// Driven through the CLI on scratch git repositories with run files this file composes. The entry's schema and its worst
// case are held here too, since workflows/code-map.js spells the same schema and a script can't import it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLANNING = join(ROOT, 'cadence-core', 'bin', 'planning.mjs');
const { entryFile, ENTRY_FILE } = await import(join(ROOT, 'cadence-core', 'bin', 'lib', 'codemap-partition.mjs'));
const { ENTRY_SCHEMA } = await import(join(ROOT, 'cadence-core', 'bin', 'lib', 'codemap-entry.mjs'));
const { writeLaunch, scratchNames } = await import(join(ROOT, 'cadence-core', 'bin', 'lib', 'codemap-launch.mjs'));
const { MAX_RUN_BYTES } = await import(join(ROOT, 'cadence-core', 'bin', 'lib', 'workflow-run.mjs'));

const pad = (n = 90 * 1024) => `${'x'.repeat(80)}\n`.repeat(Math.ceil(n / 81));
const gitIn = (root, ...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', stdio: 'pipe' });

/** Three modules, `m1`, `m2` and `m3`, and `blob`, each a small source file with a name of its own and a pad that keeps the three apart. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cad-write-'));
  gitIn(root, 'init', '-q'); gitIn(root, 'config', 'user.email', 't@example.com'); gitIn(root, 'config', 'user.name', 'T');
  for (const [dir, fn] of [['m1', 'alpha'], ['m2', 'gamma'], ['m3', 'delta']]) {
    mkdirSync(join(root, dir));
    writeFileSync(join(root, dir, 'main.js'), `export function ${fn}() {}\n`);
    writeFileSync(join(root, dir, 'pad.txt'), pad());
  }
  // a binary over the ceiling is a module of its own, and one that starts no reader
  mkdirSync(join(root, 'blob'));
  writeFileSync(join(root, 'blob', 'x.bin'), Buffer.alloc(130 * 1024));
  gitIn(root, 'add', '-A'); gitIn(root, 'commit', '-q', '-m', 'base');
  return root;
}

/** The nested tests clone the facts layer reads as a source (D-11): not tracked by the outer repository. */
function nestedTests(root) {
  mkdirSync(join(root, 'tests'));
  gitIn(join(root, 'tests'), 'init', '-q');
  gitIn(join(root, 'tests'), 'config', 'user.email', 't@example.com'); gitIn(join(root, 'tests'), 'config', 'user.name', 'T');
  writeFileSync(join(root, 'tests', 'foo.test.mjs'), "import { alpha } from '../m1/main.js';\nalpha();\n");
  gitIn(join(root, 'tests'), 'add', '-A'); gitIn(join(root, 'tests'), 'commit', '-q', '-m', 'tests');
}

/** One CLI call: the parsed answer and the exit code. */
function planning(root, ...args) { return planningWith({}, root, ...args); }
function planningWith(env, root, ...args) {
  let out; let code = 0;
  try {
    out = execFileSync('node', [PLANNING, '--dir', join(root, '.planning'), ...args], { cwd: root, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, ...env } });
  } catch (e) { out = e.stdout; code = e.status; }
  return { ...JSON.parse(out), _exit: code };
}
const scan = (root) => planning(root, 'codemap', 'scan');
const status = (root, ...args) => planning(root, 'codemap', 'status', ...args);
const index = (root) => JSON.parse(readFileSync(join(root, '.planning', 'codemap', 'index.json'), 'utf8'));
const entryPath = (root, name) => join(root, '.planning', 'codemap', entryFile(name));
const entryOf = (root, name) => JSON.parse(readFileSync(entryPath(root, name), 'utf8'));
const entryFiles = (root) => readdirSync(join(root, '.planning', 'codemap')).filter((f) => ENTRY_FILE.test(f));

/** The hashes the index holds now for a module's paths, which is what a launch pins. */
function builtFrom(root, name) {
  const i = index(root);
  const m = i.modules.find((x) => x.name === name);
  return Object.fromEntries(m.paths.map((p) => [p, i.rows.find((r) => r.path === p).hash]));
}

/** A valid entry for a module whose source is `<dir>/main.js` holding `fn`. */
function entry(dir, fn, over = {}) {
  return {
    purpose: `${dir} holds ${fn}`,
    invariants: [{ claim: `${fn} stays exported`, evidence: [{ path: `${dir}/main.js`, symbol: fn }] }],
    change_together: [],
    pinned_by: [],
    ...over,
  };
}
const FN = { m1: 'alpha', m2: 'gamma', m3: 'delta' };

/** A scratch directory outside the repository for run files and launch files. */
const scratch = () => mkdtempSync(join(tmpdir(), 'cad-write-run-'));
const row = (i, over = {}) => ({
  type: 'workflow_agent', index: i, label: `reader m${i}`, agentId: `agent${i}`, agentType: 'cadence:cad-mapper', model: 'claude-haiku-4-5', state: 'done',
  tokens: 1000 * i, toolCalls: 10 + i, durationMs: 5000 * i, ...over,
});

/** Write a run file; `modules` is the result's list and `over` replaces any top-level key. */
function runFile(modules, over = {}, name = 'wf_test') {
  const file = join(scratch(), `${name}.json`);
  writeFileSync(file, JSON.stringify({
    runId: name, status: 'completed', result: { modules }, workflowProgress: modules.map((_, i) => row(i + 1)), ...over,
  }));
  return file;
}
const write = (root, file, ...rest) => planning(root, 'codemap', 'write', '--run-file', file, ...rest);
/** A module as the script returns it: its name, the hashes pinned at launch and the entry. */
const mod = (root, name, e) => ({ name, built_from: builtFrom(root, name), entry: e });
/** Write one module's entry through the seam and answer the verdict on it. */
function tryEntry(root, name, e) {
  const r = write(root, runFile([mod(root, name, e)]));
  return { r, wrote: r.written === 1, why: r.refused_modules?.[0]?.why };
}

test('one bad module among three is refused and named, the other two are written, and it stays stale or unbuilt', () => {
  const root = fixture();
  scan(root);
  // m3 has no entry: a refusal leaves it unbuilt
  const bad = entry('m3', 'delta', { change_together: [{ path: 'm3/nothing.js', why: 'invented' }] });
  const r = write(root, runFile([mod(root, 'm1', entry('m1', 'alpha')), mod(root, 'm2', entry('m2', 'gamma')), mod(root, 'm3', bad)]));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([r.written, r.written_modules, r.refused, r.refused_modules.map((x) => x.name)], [2, ['m1', 'm2'], 1, ['m3']]);
  assert.match(r.refused_modules[0].why, /m3\/nothing\.js/);
  assert.deepEqual(entryFiles(root).sort(), [entryFile('m1'), entryFile('m2')].sort());
  const s = status(root);
  assert.deepEqual([s.built, s.unbuilt_modules, s.stale], [2, ['m3'], 0]);

  // m3 now has an entry, is edited, and a refused refresh leaves the old entry as it was and the module stale
  assert.equal(write(root, runFile([mod(root, 'm3', entry('m3', 'delta'))])).written, 1);
  const before = readFileSync(entryPath(root, 'm3'), 'utf8');
  writeFileSync(join(root, 'm3', 'main.js'), 'export function delta() { return 1; }\n');
  const again = write(root, runFile([mod(root, 'm3', bad)]));
  assert.deepEqual(again.refused_modules.map((x) => x.name), ['m3']);
  assert.equal(readFileSync(entryPath(root, 'm3'), 'utf8'), before, 'a refused module keeps its old entry');
  assert.deepEqual(status(root).stale_modules, ['m3']);
});

test('a path or symbol the facts do not hold refuses its module: an invented symbol, evidence in another module, a path outside the root', () => {
  const root = fixture();
  nestedTests(root);
  scan(root);
  const invented = tryEntry(root, 'm1', entry('m1', 'alpha', { invariants: [{ claim: 'c', evidence: [{ path: 'm1/main.js', symbol: 'nothere' }] }] }));
  assert.equal(invented.wrote, false);
  assert.match(invented.why, /nothere/);
  const foreign = tryEntry(root, 'm1', entry('m1', 'alpha', { invariants: [{ claim: 'c', evidence: [{ path: 'm2/main.js' }] }] }));
  assert.equal(foreign.wrote, false);
  assert.match(foreign.why, /outside this module/);
  const outside = tryEntry(root, 'm1', entry('m1', 'alpha', { invariants: [{ claim: 'c', evidence: [{ path: '/etc/passwd' }] }] }));
  assert.equal(outside.wrote, false);
  assert.match(outside.why, /not a path under the project root/);
  const climb = tryEntry(root, 'm1', entry('m1', 'alpha', { change_together: [{ path: '../elsewhere.js', why: 'w' }] }));
  assert.equal(climb.wrote, false);
  // the clone's files hold no symbols, so a pair naming one is refused and a path alone is not
  const pair = tryEntry(root, 'm1', entry('m1', 'alpha', { pinned_by: [{ behavior: 'b', tests: [{ path: 'tests/foo.test.mjs', symbol: 'alpha' }] }] }));
  assert.equal(pair.wrote, false);
  assert.equal(entryFiles(root).length, 0, 'nothing was written by any refusal');
  const shape = tryEntry(root, 'm1', { ...entry('m1', 'alpha'), extra: 'x' });
  assert.match(shape.why, /unknown key/);
});

test('what is accepted: a path alone, an absolute path under the root stored relative, a nested test in either form, and free text that is false', () => {
  const root = fixture();
  nestedTests(root);
  scan(root);
  const e = entry('m1', 'alpha', {
    purpose: 'Calls the moon and wraps nothing, which no scan checks',
    invariants: [
      { claim: 'a path alone is evidence', evidence: [{ path: 'm1/main.js' }] },
      { claim: 'an absolute path is converted', evidence: [{ path: join(root, 'm1', 'main.js'), symbol: 'alpha' }] },
      { claim: 'tests are exempt from the module rule', evidence: [{ path: 'tests/foo.test.mjs' }, { path: join(root, 'tests', 'foo.test.mjs') }] },
    ],
    change_together: [{ path: 'm2/main.js', why: 'anywhere tracked' }],
    pinned_by: [{ behavior: 'alpha runs', tests: [{ path: 'tests/foo.test.mjs' }] }],
  });
  const r = tryEntry(root, 'm1', e);
  assert.equal(r.wrote, true, JSON.stringify(r.r));
  const stored = entryOf(root, 'm1');
  assert.equal(stored.purpose, e.purpose);
  assert.deepEqual(stored.invariants[1].evidence[0], { path: 'm1/main.js', symbol: 'alpha' }, 'stored root-relative');
  assert.deepEqual(stored.invariants[2].evidence.map((x) => x.path), ['tests/foo.test.mjs', 'tests/foo.test.mjs']);
  assert.deepEqual(stored.built_from, builtFrom(root, 'm1'));
});

test('a dead reader is named, a name that is a path never becomes one, and a module that starts no reader is refused', () => {
  const root = fixture();
  scan(root);
  const evil = { name: '../../evil', built_from: builtFrom(root, 'm1'), entry: entry('m1', 'alpha') };
  const r = write(root, runFile([{ name: 'm2', built_from: builtFrom(root, 'm2'), entry: null }, evil, mod(root, 'm1', entry('m1', 'alpha'))]));
  assert.deepEqual([r.dead_modules, r.written_modules], [['m2'], ['m1']]);
  assert.deepEqual(r.refused_modules.map((x) => x.name), ['../../evil']);
  assert.match(r.refused_modules[0].why, /not a module the facts hold/);
  const none = write(root, runFile([{ name: 'blob', built_from: builtFrom(root, 'blob'), entry: entry('m1', 'alpha') }]));
  assert.match(none.refused_modules[0].why, /starts no reader/);
  assert.deepEqual(entryFiles(root), [entryFile('m1')], 'the only file written is the one the stored name derives');
  assert.equal(existsSync(join(root, '.planning', 'evil.json')) || existsSync(join(root, 'evil.json')), false);
  const dup = write(root, runFile([mod(root, 'm1', entry('m1', 'alpha')), mod(root, 'm1', entry('m1', 'alpha'))]));
  assert.equal(dup.written, 1);
  assert.match(dup.refused_modules[0].why, /twice/);
});

test('a killed run, a file that is not JSON and a result with no modules list answer ok:false and write nothing', () => {
  const root = fixture();
  scan(root);
  const good = [mod(root, 'm1', entry('m1', 'alpha'))];
  const killed = write(root, runFile(good, { status: 'killed' }));
  assert.deepEqual([killed.ok, killed.reason], [false, 'run-not-completed']);
  const junk = join(scratch(), 'junk.json');
  writeFileSync(junk, 'not json');
  assert.deepEqual([write(root, junk).ok, write(root, junk).reason], [false, 'run-not-json']);
  const none = write(root, runFile(good, { result: { other: 1 } }));
  assert.deepEqual([none.ok, none.reason], [false, 'run-bad-result']);
  assert.equal(write(root, join(scratch(), 'gone.json')).reason, 'run-unreadable');
  assert.equal(entryFiles(root).length, 0);
});

test('built_from comes from the run and not from the files now, so an edit during the run leaves the module stale', () => {
  const root = fixture();
  scan(root);
  const pinned = builtFrom(root, 'm1');
  writeFileSync(join(root, 'm1', 'main.js'), 'export function alpha() { return 2; }\n');
  assert.equal(write(root, runFile([{ name: 'm1', built_from: pinned, entry: entry('m1', 'alpha') }])).written, 1);
  assert.deepEqual(entryOf(root, 'm1').built_from, pinned);
  assert.deepEqual(status(root).stale_modules, ['m1']);
});

test('the launch file is checked: a changed hash, a dropped module and an extra one are named, and an unreadable file costs no entry', () => {
  const root = fixture();
  scan(root);
  const launch = (items) => { const f = join(scratch(), 'launch.json'); writeFileSync(f, JSON.stringify({ root, items })); return f; };
  const item = (name) => ({ name, built_from: builtFrom(root, name), item: '/x' });
  const typo = item('m2');
  typo.built_from = { ...typo.built_from, 'm2/main.js': '0'.repeat(40) };
  const run = runFile([mod(root, 'm1', entry('m1', 'alpha')), mod(root, 'm2', entry('m2', 'gamma')), mod(root, 'm3', entry('m3', 'delta'))]);

  // m2's hash was retyped wrong, m3 is not in the launch file, and m4 is in it and not in the run
  const r = write(root, run, '--launch-file', launch([item('m1'), typo, { name: 'm4', built_from: {}, item: '/x' }]));
  assert.equal(r.launch_check, 'ran');
  assert.deepEqual(r.written_modules, ['m1']);
  assert.deepEqual(r.refused_modules.map((x) => x.name).sort(), ['m2', 'm3']);
  assert.match(r.refused_modules.find((x) => x.name === 'm2').why, /differs from the launch file/);
  assert.match(r.refused_modules.find((x) => x.name === 'm3').why, /does not name this module/);
  assert.deepEqual(r.missing_modules, ['m4']);
  assert.deepEqual(entryFiles(root), [entryFile('m1')]);

  const broken = join(scratch(), 'launch.json');
  writeFileSync(broken, '{not json');
  const blind = write(root, run, '--launch-file', broken);
  assert.deepEqual([blind.ok, blind.launch_check, blind.written], [true, 'not-run', 3]);
  assert.match(blind.launch_note, /not compared/);
});

test('an entry is bounded so a Baley-sized build fits the run file: the worst case is under 52 KiB and 148 of them fit MAX_RUN_BYTES', () => {
  // every string and list carries its bound, so a reader can't return an unbounded one
  const walk = (s, at) => {
    if (s.type === 'string') { assert.ok(Number.isSafeInteger(s.maxLength), `${at} has no maxLength`); return 'x'.repeat(s.maxLength); }
    if (s.type === 'array') { assert.ok(Number.isSafeInteger(s.maxItems), `${at} has no maxItems`); return Array.from({ length: s.maxItems }, () => walk(s.items, `${at}[]`)); }
    assert.equal(s.additionalProperties, false, `${at} allows extra keys`);
    return Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, walk(v, `${at}.${k}`)]));
  };
  const worst = walk(ENTRY_SCHEMA, 'entry');
  const entryBytes = Buffer.byteLength(JSON.stringify(worst));
  assert.ok(entryBytes <= 52 * 1024, `the worst case is ${entryBytes} bytes`);

  // 148 modules and 837 paths, pinned in the result and again in args, 148 agent rows shaped like real ones and a script the size of review-panel's
  const paths = Array.from({ length: 837 }, (_, i) => `crates/some-crate-${i % 40}/src/module_${i}/file_${i}.rs`);
  const hash = 'a'.repeat(40);
  const names = Array.from({ length: 148 }, (_, i) => `crates/some-crate-${i % 40}/src/module_${i}`);
  const pins = names.map((name, i) => ({ name, built_from: Object.fromEntries(paths.filter((_, k) => k % 148 === i).map((p) => [p, hash])) }));
  const run = {
    runId: 'wf_ab21133c-183', status: 'completed', script: readFileSync(join(ROOT, 'workflows', 'review-panel.js'), 'utf8'),
    args: JSON.stringify({ root: '/home/user/code/project', items: pins.map((p) => ({ ...p, item: `/tmp/scratch/m-${'b'.repeat(32)}.item.json` })) }),
    result: { modules: pins.map((p) => ({ ...p, entry: worst })) },
    workflowProgress: names.map((_, i) => row(i + 1, { promptPreview: 'p'.repeat(401), resultPreview: 'r'.repeat(401), lastToolName: 'StructuredOutput' })),
  };
  const bytes = Buffer.byteLength(JSON.stringify(run));
  assert.ok(bytes <= MAX_RUN_BYTES, `the composed run is ${bytes} bytes against ${MAX_RUN_BYTES}`);
});

test('the map is not recalled and not in the why corpus', () => {
  const root = fixture();
  scan(root);
  assert.equal(write(root, runFile([mod(root, 'm1', entry('m1', 'alpha', { purpose: 'a quizzical xylophonist lives here' }))])).written, 1);
  const out = execFileSync('node', [PLANNING, 'recall', 'xylophonist', '--dir', join(root, '.planning')], {
    cwd: root, encoding: 'utf8', env: { ...process.env, CADENCE_GLOBAL_CONFIG: join(tmpdir(), 'cad-no-such-global.json') },
  });
  assert.equal(JSON.parse(out).total, 0);
  for (const f of ['planning/recall.mjs', 'lib/why-corpus.mjs']) {
    assert.equal(readFileSync(join(ROOT, 'cadence-core', 'bin', f), 'utf8').split('\n').filter((l) => l.includes('codemap')).length, 0, f);
  }
});

// --- the run is billed before it is judged (D-16) ---------------------------------------------------------------------

const render0 = (root) => planning(root, 'trace', 'render', '--phase', '0');
const events0 = (root) => planning(root, 'trace', 'render', '--phase', '0', '--events').events.filter((e) => e.family === 'lifecycle');

test('a run with two agent rows bills two brackets under phase 0 with each row\'s figures, and a second call bills none and rewrites the same entries', () => {
  const root = fixture();
  scan(root);
  const file = runFile([mod(root, 'm1', entry('m1', 'alpha')), mod(root, 'm2', entry('m2', 'gamma'))]);
  const first = write(root, file);
  assert.deepEqual([first.brackets.source, first.brackets.written, first.brackets.already, first.brackets.failed], ['run-file', 2, 0, []]);
  const out = render0(root);
  assert.deepEqual(out.unpaired, []);
  assert.equal(out.brackets.length, 2);
  for (const [i, b] of [...out.brackets].sort((a, c) => a.tokens - c.tokens).entries()) {
    assert.deepEqual([b.tokens, b.turns, b.duration_ms, b.agent_id], [1000 * (i + 1), 10 + i + 1, 5000 * (i + 1), `agent${i + 1}`]);
  }
  const dispatches = events0(root).filter((e) => e.event === 'dispatch');
  assert.ok(dispatches.every((e) => e.plan.startsWith('wf_test-') && e.read.length === 1 && e.read[0] === '.planning/codemap/index.json'), 'the worker key carries the run id and the read set is the index');
  const written = readFileSync(entryPath(root, 'm1'), 'utf8');

  const before = events0(root).length;
  const again = write(root, file);
  assert.deepEqual([again.brackets.written, again.brackets.already], [0, 2]);
  assert.equal(events0(root).length, before, 'a retry writes no second set');
  assert.equal(readFileSync(entryPath(root, 'm1'), 'utf8'), written, 'and the same entries');
});

test('a killed run is still billed and writes no entry, and an agent that was not done closes as a checkpoint', () => {
  const root = fixture();
  scan(root);
  const modules = [mod(root, 'm1', entry('m1', 'alpha'))];
  const r = write(root, runFile(modules, { status: 'killed', workflowProgress: [row(1, { state: 'killed' })] }));
  assert.deepEqual([r.ok, r.reason, r.brackets.written], [false, 'run-not-completed', 1]);
  assert.equal(entryFiles(root).length, 0);
  const b = events0(root).find((e) => e.event === 'checkpoint');
  assert.match(b.detail, /state "killed"/);
  assert.equal(render0(root).unpaired.length, 0);
  // a refusal further on says what was billed too
  const bad = write(root, runFile(modules, { result: { nothing: 1 }, workflowProgress: [row(1)] }, 'wf_other'));
  assert.deepEqual([bad.reason, bad.brackets.written], ['run-bad-result', 1]);
});

test('an unreadable run file with the notice\'s totals bills one cad-mapper bracket, and a bad total is refused before anything is billed', () => {
  const root = fixture();
  scan(root);
  const gone = join(scratch(), 'wf_gone.json');
  const r = write(root, gone, '--notice-tokens', '54242', '--notice-turns', '11', '--notice-duration-ms', '6072');
  assert.deepEqual([r.ok, r.reason, r.brackets.source, r.brackets.written], [false, 'run-unreadable', 'notice-totals', 1]);
  const out = render0(root);
  assert.equal(out.brackets.length, 1);
  assert.deepEqual([out.brackets[0].role, out.brackets[0].tokens, out.brackets[0].turns, out.brackets[0].duration_ms], ['cad-mapper', 54242, 11, 6072]);
  const bad = write(root, gone, '--notice-tokens', '1.5');
  assert.deepEqual([bad.ok, bad.reason], [false, 'bad-args']);
  assert.equal(render0(root).brackets.length, 1, 'a refused call billed nothing more');
});

// --- codemap status --out-dir: what a launch needs (D-03, D-14) ---------------------------------------------------------

/** Scan, then write a valid entry for the three source modules, so each is built from the content the repository holds now. */
function built(root) {
  scan(root);
  const r = write(root, runFile(['m1', 'm2', 'm3'].map((n) => mod(root, n, entry(n, FN[n])))));
  assert.equal(r.written, 3, JSON.stringify(r));
}
const launchOf = (out) => JSON.parse(readFileSync(join(out, 'launch.json'), 'utf8'));
const itemOf = (item) => JSON.parse(readFileSync(item, 'utf8'));
const statBytes = (f) => statSync(f).size;
const hashNow = (root, p) => gitIn(root, 'hash-object', '--no-filters', p).trim();

test('one module edited after its entry was built: the launch file holds that module only, small, with its hashes pinned now and a diff of the change', () => {
  const root = fixture();
  built(root);
  writeFileSync(join(root, 'm2', 'main.js'), 'export function gamma() { return 1; }\n');
  const out = scratch();
  const objects = gitIn(root, 'count-objects', '-v');
  const s = status(root, '--out-dir', out);
  assert.equal(s.ok, true, JSON.stringify(s));
  assert.equal(gitIn(root, 'count-objects', '-v'), objects, 'the call stored no object');

  const launch = launchOf(out);
  assert.equal(launch.root, root);
  assert.equal(launch.items.length, 1);
  const [it] = launch.items;
  assert.deepEqual(Object.keys(it).sort(), ['built_from', 'item', 'name']);
  assert.equal(it.name, 'm2');
  assert.equal(it.built_from['m2/main.js'], hashNow(root, 'm2/main.js'), 'pinned now, not at the build');
  assert.equal(it.built_from['m2/pad.txt'], hashNow(root, 'm2/pad.txt'));
  assert.deepEqual([s.launch.file, s.launch.items, s.launch.bytes], [join(out, 'launch.json'), 1, statBytes(join(out, 'launch.json'))]);
  assert.equal(s.launch.reader_bytes, s.reader_bytes);
  assert.equal(JSON.stringify(s).includes('built_from'), false, 'the envelope never carries the items');

  const item = itemOf(it.item);
  assert.equal(item.refresh, 'diff');
  assert.deepEqual(item.read, [join(root, 'm2', 'main.js'), join(root, 'm2', 'pad.txt')]);
  assert.deepEqual(item.changed, [join(root, 'm2', 'main.js')]);
  assert.equal(itemOf(item.old_entry).purpose, 'm2 holds gamma', 'the old entry is copied beside it');
  const diff = readFileSync(item.diff, 'utf8');
  assert.match(diff, /^-export function gamma\(\) \{\}$/m);
  assert.match(diff, /^\+export function gamma\(\) \{ return 1; \}$/m);
  assert.match(diff, /^### m2\/main\.js$/m);
  assert.equal(diff.includes('pad'), false, 'an unchanged file is not in the diff');
});

test('an unbuilt module carries no old entry, a module starting no reader never appears, and a missing out-dir is refused with nothing written', () => {
  const root = fixture();
  nestedTests(root);
  scan(root);
  const out = scratch();
  const s = status(root, '--out-dir', out);
  const launch = launchOf(out);
  assert.deepEqual(launch.items.map((x) => x.name), ['m1', 'm2', 'm3'], 'blob is binary-only and starts no reader');
  const item = itemOf(launch.items[0].item);
  assert.equal('old_entry' in item || 'refresh' in item || 'diff' in item, false);
  assert.equal(s.readers, 3);
  // the nested clone's test that names alpha pins m1, as an absolute path
  assert.deepEqual(item.tests, [join(root, 'tests', 'foo.test.mjs')]);

  const gone = join(scratch(), 'nowhere');
  const refused = status(root, '--out-dir', gone);
  assert.deepEqual([refused.ok, refused.reason], [false, 'bad-args']);
  assert.equal(existsSync(gone), false);
});

test('a reader is told only what it may open and cite: a symlink and a binary are pinned and not read, a changed symlink is named and never diffed', () => {
  const root = mkdtempSync(join(tmpdir(), 'cad-write-mix-'));
  gitIn(root, 'init', '-q'); gitIn(root, 'config', 'user.email', 't@example.com'); gitIn(root, 'config', 'user.name', 'T');
  mkdirSync(join(root, 'mix'));
  writeFileSync(join(root, 'mix', 'a.js'), 'export function alpha() {\n  function inner() {}\n  return inner;\n}\n');
  writeFileSync(join(root, 'mix', 'b.bin'), Buffer.from([1, 0, 2, 0]));
  symlinkSync('/etc/hostname', join(root, 'mix', 'link'));
  gitIn(root, 'add', '-A'); gitIn(root, 'commit', '-q', '-m', 'base');
  scan(root);
  const out = scratch();
  status(root, '--out-dir', out);
  const first = itemOf(launchOf(out).items[0].item);
  assert.deepEqual(first.read, [join(root, 'mix', 'a.js')], 'only the regular text file is opened');
  assert.deepEqual(Object.keys(launchOf(out).items[0].built_from).sort(), ['mix/a.js', 'mix/b.bin', 'mix/link'], 'all three are pinned');
  // alpha is held, and the helper nested inside it is not, so a reader that cites it would sink its whole module
  assert.deepEqual(first.symbols, { [join(root, 'mix', 'a.js')]: ['alpha'] });
  const cited = (symbol) => write(root, runFile([mod(root, 'mix', entry('mix', 'alpha', { invariants: [{ claim: 'c', evidence: [{ path: join(root, 'mix', 'a.js'), symbol }] }] }))]));
  assert.equal(cited('inner').refused, 1);
  assert.equal(cited('alpha').written, 1);

  rmSync(join(root, 'mix', 'link'));
  symlinkSync('/etc/passwd', join(root, 'mix', 'link'));
  status(root, '--out-dir', out);
  const item = itemOf(launchOf(out).items[0].item);
  assert.deepEqual(item.changed, [join(root, 'mix', 'link')]);
  assert.equal(item.refresh, 'diff');
  assert.equal(readFileSync(item.diff, 'utf8').includes('passwd'), false, 'the link is named and not diffed');
});

test('a diff is only offered where the old blob still resolves: on top of an uncommitted edit, and after the blob is garbage collected, the reader reads the whole module', () => {
  const root = fixture();
  // an uncommitted edit is what the entry is built from, so its hash is one nothing stored
  scan(root);
  writeFileSync(join(root, 'm2', 'main.js'), 'export function gamma() { return 1; }\n');
  scan(root);
  assert.equal(write(root, runFile([mod(root, 'm2', entry('m2', 'gamma'))])).written, 1);
  writeFileSync(join(root, 'm2', 'main.js'), 'export function gamma() { return 2; }\n');
  const out = scratch();
  status(root, '--out-dir', out);
  const item = itemOf(launchOf(out).items.find((x) => x.name === 'm2').item);
  assert.deepEqual([item.refresh, 'diff' in item, item.changed], ['whole', false, [join(root, 'm2', 'main.js')]]);
  assert.ok(item.old_entry);

  // a committed edit built from, then the commit thrown away and its objects pruned
  const lost = fixture();
  writeFileSync(join(lost, 'm2', 'main.js'), 'export function gamma() { return 3; }\n');
  gitIn(lost, 'commit', '-q', '-am', 'edit');
  scan(lost);
  const old = builtFrom(lost, 'm2')['m2/main.js'];
  assert.equal(write(lost, runFile([mod(lost, 'm2', entry('m2', 'gamma'))])).written, 1);
  gitIn(lost, 'reset', '-q', '--hard', 'HEAD~1');
  gitIn(lost, 'reflog', 'expire', '--expire=now', '--all');
  gitIn(lost, 'gc', '-q', '--prune=now');
  assert.throws(() => gitIn(lost, 'cat-file', '-e', old), 'the blob is gone, and git diff alone would answer fatal: bad object');
  const out2 = scratch();
  const s = status(lost, '--out-dir', out2);
  assert.equal(s.ok, true, JSON.stringify(s));
  const gone = itemOf(launchOf(out2).items.find((x) => x.name === 'm2').item);
  assert.deepEqual([gone.refresh, 'diff' in gone], ['whole', false]);
  assert.equal(existsSync(join(out2, `${entryFile('m2').slice(0, -5)}.diff`)), false);
});

// --- fix pass: one row never sinks the rest, and a read runs no program and opens nothing it should not ---------------

/** An entry with an own key spelled as JSON text, since `__proto__` set on an object literal is no key at all. */
const withKey = (e, key, valueText) => JSON.parse(`${JSON.stringify(e).slice(0, -1)},${JSON.stringify(key)}:${valueText}}`);

test('a key named like an inherited property refuses its module and no other, and an unprintable name in the launch file is cut', () => {
  const root = fixture();
  scan(root);
  const good = entry('m3', 'delta');
  const evidenceKey = entry('m2', 'gamma');
  evidenceKey.invariants[0].evidence[0] = JSON.parse('{"path":"m2/main.js","hasOwnProperty":{}}');
  const bads = [withKey(entry('m2', 'gamma'), 'constructor', '{}'), withKey(entry('m2', 'gamma'), 'toString', '{"a":1}'),
    withKey(entry('m2', 'gamma'), '__proto__', '{}'), evidenceKey];
  for (const bad of bads) {
    const r = write(root, runFile([mod(root, 'm1', entry('m1', 'alpha')), mod(root, 'm2', bad), mod(root, 'm3', good)]));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual([r.written_modules, r.refused_modules.map((x) => x.name)], [['m1', 'm3'], ['m2']]);
    assert.match(r.refused_modules[0].why, /unknown key|lacks/);
    assert.equal(r.brackets.source, 'run-file');
  }
  assert.deepEqual(status(root).stale_modules, [], 'the others were written');

  const launch = join(scratch(), 'launch.json');
  writeFileSync(launch, JSON.stringify({ items: [{ name: 'z'.repeat(5000), built_from: {} }] }));
  const r = write(root, runFile([mod(root, 'm1', entry('m1', 'alpha'))]), '--launch-file', launch);
  assert.equal(r.missing, 1);
  assert.equal(r.missing_modules[0].length, 200, 'a name from the launch file is cut like a refused one');
});

test('a missing --run-file is bad-args and bills nothing', () => {
  const root = fixture();
  scan(root);
  const r = planning(root, 'codemap', 'write', '--notice-tokens', '54242');
  assert.deepEqual([r.ok, r.reason], [false, 'bad-args']);
  assert.equal(render0(root).brackets.length, 0);
});

/** A git program that records that it ran, and a path to look for the record at. A clean filter passes its input through; a transport just fails. */
function probe(name) {
  const dir = scratch();
  const marker = join(dir, 'ran');
  const prog = join(dir, `${name}.sh`);
  writeFileSync(prog, `#!/bin/sh\necho ran >> "${marker}"\n${name === 'clean' ? 'cat' : 'exit 1'}\n`);
  chmodSync(prog, 0o755);
  return { prog, marker };
}

test('the diff runs no clean filter a tracked .gitattributes and the config name, and still carries the hunks', () => {
  const root = fixture();
  writeFileSync(join(root, 'm2', '.gitattributes'), '* filter=probe\n');
  gitIn(root, 'add', 'm2/.gitattributes'); gitIn(root, 'commit', '-q', '-m', 'attributes');
  built(root);
  const { prog, marker } = probe('clean');
  gitIn(root, 'config', 'filter.probe.clean', prog);
  writeFileSync(join(root, 'm2', 'main.js'), 'export function gamma() { return 1; }\n');
  const out = scratch();
  assert.equal(status(root, '--out-dir', out).ok, true);
  const item = itemOf(launchOf(out).items.find((x) => x.name === 'm2').item);
  assert.equal(item.refresh, 'diff');
  assert.match(readFileSync(item.diff, 'utf8'), /^\+export function gamma\(\) \{ return 1; \}$/m);
  assert.equal(existsSync(marker), false, 'the configured filter program never ran');
});

/** The filter scenario of the test above, run with `env` in the launch's environment; the marker says whether the program ran. */
function filterRun(env) {
  const root = fixture();
  writeFileSync(join(root, 'm2', '.gitattributes'), '* filter=probe\n');
  gitIn(root, 'add', 'm2/.gitattributes'); gitIn(root, 'commit', '-q', '-m', 'attributes');
  built(root);
  const { prog, marker } = probe('clean');
  gitIn(root, 'config', 'filter.probe.clean', prog);
  mkdirSync(join(root, 'tmp'));
  writeFileSync(join(root, 'm2', 'main.js'), 'export function gamma() { return 1; }\n');
  const out = scratch();
  const s = planningWith(env(root), root, 'codemap', 'status', '--out-dir', out);
  assert.equal(s.ok, true, JSON.stringify(s));
  const item = itemOf(launchOf(out).items.find((x) => x.name === 'm2').item);
  assert.equal(item.refresh, 'diff');
  assert.match(readFileSync(item.diff, 'utf8'), /^\+export function gamma\(\) \{ return 1; \}$/m);
  return existsSync(marker);
}

test('the diff runs no clean filter when TMPDIR is relative and names a directory inside the repository', () => {
  assert.equal(filterRun(() => ({ TMPDIR: 'tmp' })), false, 'the configured filter program never ran');
});

test('the diff runs no clean filter when the environment aims git at the repository with an absolute GIT_DIR', () => {
  assert.equal(filterRun((root) => ({ GIT_DIR: join(root, '.git') })), false, 'the configured filter program never ran');
});

test('looking for a missing old blob runs no transport program a promisor remote names', () => {
  const root = fixture();
  scan(root);
  writeFileSync(join(root, 'm2', 'main.js'), 'export function gamma() { return 1; }\n');
  scan(root);
  assert.equal(write(root, runFile([mod(root, 'm2', entry('m2', 'gamma'))])).written, 1);
  writeFileSync(join(root, 'm2', 'main.js'), 'export function gamma() { return 2; }\n');
  const { prog, marker } = probe('ssh');
  gitIn(root, 'config', 'core.repositoryformatversion', '1');
  gitIn(root, 'config', 'extensions.partialclone', 'lazyprobe');
  gitIn(root, 'config', 'remote.lazyprobe.promisor', 'true');
  gitIn(root, 'config', 'remote.lazyprobe.url', 'ssh://example.invalid/x.git');
  gitIn(root, 'config', 'core.sshCommand', prog);
  const out = scratch();
  assert.equal(status(root, '--out-dir', out).ok, true);
  const item = itemOf(launchOf(out).items.find((x) => x.name === 'm2').item);
  assert.equal(item.refresh, 'whole', 'the hash nothing stored is not found');
  assert.equal(existsSync(marker), false, 'the configured transport never ran');
});

test('a launch item names only what is safe to open: tests that are regular files under the root, and added and removed paths that cannot lead out', () => {
  const root = fixture();
  nestedTests(root);
  writeFileSync(join(root, 'tests', 'bar.test.mjs'), "import { alpha } from '../m1/main.js';\nalpha();\n");
  gitIn(join(root, 'tests'), 'add', '-A'); gitIn(join(root, 'tests'), 'commit', '-q', '-m', 'bar');
  built(root);
  // a stored index a clone supplies: a climb, an absolute path, a missing file, a quoted spelling, a file behind a linked directory
  const outside = scratch();
  writeFileSync(join(outside, 'x.test.mjs'), 'x\n');
  symlinkSync(outside, join(root, 'tests', 'linked'));
  const idx = index(root);
  const m1row = idx.rows.find((r) => r.path === 'm1/main.js');
  m1row.pinned_by = { files: [...(m1row.pinned_by?.files || []), '../../etc/hostname', '/etc/hostname', 'tests/../../x', 'tests/gone.test.mjs', '"q.test.mjs', 'tests/linked/x.test.mjs'] };
  writeFileSync(join(root, '.planning', 'codemap', 'index.json'), JSON.stringify(idx));
  // foo.test.mjs was a regular file when scanned and is a link now
  rmSync(join(root, 'tests', 'foo.test.mjs'));
  symlinkSync('/etc/hostname', join(root, 'tests', 'foo.test.mjs'));
  writeFileSync(join(root, 'm1', 'main.js'), 'export function alpha() { return 1; }\n');
  const out = scratch();
  assert.equal(status(root, '--out-dir', out).ok, true);
  const item = itemOf(launchOf(out).items.find((x) => x.name === 'm1').item);
  assert.deepEqual(item.tests, [join(root, 'tests', 'bar.test.mjs')]);

  // m2 gains a tracked symlink and a regular file; its stored entry names a key that climbs and one that is gone
  symlinkSync('/etc/hostname', join(root, 'm2', 'leak'));
  writeFileSync(join(root, 'm2', 'new.js'), 'export function fresh() {}\n');
  gitIn(root, 'add', '-A'); gitIn(root, 'commit', '-q', '-m', 'more');
  const file = entryPath(root, 'm2');
  const old = JSON.parse(readFileSync(file, 'utf8'));
  old.built_from['../../x'] = 'a'.repeat(40);
  old.built_from['m2/gone.js'] = 'b'.repeat(40);
  writeFileSync(file, JSON.stringify(old));
  assert.equal(status(root, '--out-dir', out).ok, true);
  const m2 = itemOf(launchOf(out).items.find((x) => x.name === 'm2').item);
  assert.deepEqual(m2.added, [join(root, 'm2', 'new.js')], 'a symlink is pinned and not named');
  assert.deepEqual(m2.removed, ['m2/gone.js'], 'root-relative, and the climbing key is dropped');
  assert.equal(m2.read.some((p) => p.endsWith('leak')), false);
});

/** The tests list of m1's item after its stored row names `files` as pins, with one real test file beside them. */
function testsFor(files) {
  const root = fixture();
  nestedTests(root);
  built(root);
  writeFileSync(join(root, '.env'), 'TOKEN=secret\n');
  writeFileSync(join(root, 'a\\b.test.mjs'), 'x\n');
  writeFileSync(join(root, 'm1', 'notes.txt'), 'x\n');
  const idx = index(root);
  const m1row = idx.rows.find((r) => r.path === 'm1/main.js');
  m1row.pinned_by = { files: [...(m1row.pinned_by?.files || []), ...files] };
  writeFileSync(join(root, '.planning', 'codemap', 'index.json'), JSON.stringify(idx));
  writeFileSync(join(root, 'm1', 'main.js'), 'export function alpha() { return 1; }\n');
  const out = scratch();
  const st = status(root, '--out-dir', out);
  assert.equal(st.ok, true, JSON.stringify(st));
  return itemOf(launchOf(out).items.find((x) => x.name === 'm1').item).tests;
}

test('a stored pin is listed only when it is a test file: .git/config, .env, a source file and anything under a .git directory are dropped', () => {
  const tests = testsFor(['.git/config', 'tests/../.git/config', '.git/HEAD', '.env', 'm1/notes.txt', 'tests/.git/config']);
  assert.deepEqual(tests.map((t) => t.slice(t.indexOf('/tests/') + 1)).filter((t) => t.startsWith('tests/')), ['tests/foo.test.mjs']);
  assert.equal(tests.length, 1);
});

test('a stored pin holding a backslash is dropped, since a native join could read it as a separator', () => {
  const tests = testsFor(['a\\b.test.mjs', '..\\private\\x.test.mjs']);
  assert.equal(tests.length, 1);
  assert.match(tests[0], /foo\.test\.mjs$/);
});

test('a quoted spelling of a path is pinned and never listed to open, whether it is read or added', () => {
  const root = scratch();
  const quoted = '"m/caf\\351.js"';
  const hash = 'c'.repeat(40);
  const rows = [{ path: 'm/a.js', kind: 'text', hash, bytes: 5 }, { path: quoted, kind: 'text', hash, bytes: 5 }];
  const out = scratch();
  writeLaunch({ root, outDir: out, rows, indexRows: [], modules: [{ name: 'm', paths: ['m/a.js', quoted], entry: { built_from: { 'm/a.js': 'd'.repeat(40) } } }] });
  const item = itemOf(join(out, scratchNames('m').item));
  assert.deepEqual([item.read, item.added], [[join(root, 'm', 'a.js')], []]);
  assert.deepEqual(Object.keys(item.built_from).sort(), [quoted, 'm/a.js'].sort());
});

test('a symbol over the schema bound is not offered as citable', () => {
  const root = fixture();
  const long = 'a'.repeat(130);
  writeFileSync(join(root, 'm1', 'main.js'), `export function ${long}() {}\nexport function alpha() {}\n`);
  gitIn(root, 'add', '-A'); gitIn(root, 'commit', '-q', '-m', 'long');
  scan(root);
  const out = scratch();
  status(root, '--out-dir', out);
  const item = itemOf(launchOf(out).items.find((x) => x.name === 'm1').item);
  assert.deepEqual(item.symbols, { [join(root, 'm1', 'main.js')]: ['alpha'] });
});

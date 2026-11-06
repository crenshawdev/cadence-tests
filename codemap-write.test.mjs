// Tests for `planning.mjs codemap write` and `codemap status --out-dir`: a reader's answer becomes the map, and a launch is given what it needs.
// Run: node --test tests/codemap-write.test.mjs
//
// Driven through the CLI on scratch git repositories with run files this file composes. The entry's schema and its worst
// case are held here too, since workflows/code-map.js spells the same schema and a script can't import it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLANNING = join(ROOT, 'cadence-core', 'bin', 'planning.mjs');
const { entryFile, ENTRY_FILE } = await import(join(ROOT, 'cadence-core', 'bin', 'lib', 'codemap-partition.mjs'));
const { ENTRY_SCHEMA } = await import(join(ROOT, 'cadence-core', 'bin', 'lib', 'codemap-entry.mjs'));
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
function planning(root, ...args) {
  let out; let code = 0;
  try {
    out = execFileSync('node', [PLANNING, '--dir', join(root, '.planning'), ...args], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
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

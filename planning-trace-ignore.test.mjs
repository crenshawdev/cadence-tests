// Zero-dep tests for `planning.mjs trace ignore`. Run:
// node --test 'tests/*.test.mjs'
//
// Split out of planning.test.mjs in phase 4, verbatim: the arms, their fixture
// builders and their comments are unchanged, only their home is. The shared
// harness stays in planning.test.mjs and is imported, never copied - two copies
// of `makeTree` is how two fixtures drift apart.
//
// The `test` binding below is a no-op unless this module IS the entry file, so
// a sibling that imports a fixture from here registers nothing twice.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLANNING, run, isEntryFile, stampState } from './planning.test.mjs';
import {
  READS_CLAIM_FILE, READS_EVICT_TEMP_FILE, READS_FILE, READS_ROTATE_TEMP_FILE, MAX_READS_BYTES,
  ROTATED_READS_FILE, appendRead, readsPath, rotateReads, rotatedReadsPath,
} from '../cadence-core/bin/lib/read-trace.mjs';
import {
  ROTATED_TRACE_FILE, ROTATION_CLAIM_FILE, TRACE_FILE, appendEvent, rotateTrace, rotatedTracePath, tracePath,
} from '../cadence-core/bin/lib/trace.mjs';
import { ensureRecordsDir, recordsDir, recordsPath } from '../cadence-core/bin/lib/planning-store.mjs';

/** `node:test`'s `test` when run directly, a no-op when imported (see header). */
const test = isEntryFile(import.meta.url) ? nodeTest : () => {};

// --- trace ignore: the logs stay out of git by themselves (FLD-02) -----------
//
// The other `--root` subcommand, tested beside detect-commands for that reason.
// `--root` is the PROJECT root here, and the rules live in the records folder's
// own `.gitignore`, which the write module creates with the folder. The write
// arm is scaffold-time only: `--check` is what /cad-health runs, and it may not
// edit a file it did not create (D-03).

/** A scratch PROJECT root, a git repo unless `git:false`. */
function ignoreRoot({ git = true, gitignore = null, planning = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cad-ignore-'));
  if (git) {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: root });
  }
  if (planning) mkdirSync(join(root, '.planning'), { recursive: true });
  if (gitignore !== null) writeFileSync(join(root, '.gitignore'), gitignore);
  return root;
}

/** `trace ignore` against a project root; parse its one JSON line. */
function traceIgnore(root, extra = []) {
  const args = root === null ? ['trace', 'ignore', ...extra]
    : ['trace', 'ignore', '--root', root, ...extra];
  try {
    return JSON.parse(execFileSync('node', [PLANNING, ...args], { encoding: 'utf8', ...(root ? { cwd: root } : {}) }));
  } catch (e) {
    return JSON.parse(e.stdout);
  }
}

/** The records folder's own `.gitignore`: where the rules live now. */
const ignoreFileOf = (root) => recordsPath(join(root, '.planning'), '.gitignore');
const gitignoreOf = (root) => readFileSync(ignoreFileOf(root), 'utf8');
/** The rules in it, comments and blanks dropped. */
const rulesOf = (root) => gitignoreOf(root).split('\n').filter((l) => l && !l.startsWith('#'));

/** A path under the project root as git is asked about it. Derived from the write module, never spelled here. */
const logPath = (base) => recordsPath('.planning', base).split(sep).join('/');

/**
 * The reads record's six paths as the command states them, DERIVED here the
 * same way it derives them: a test that copied the strings would stay green on
 * the day the two spellings diverged, which is the only failure the derivation
 * exists to catch.
 */
const READS_RULES = [
  logPath(READS_FILE),
  logPath(ROTATED_READS_FILE),
  logPath(READS_CLAIM_FILE),
  `${logPath(READS_CLAIM_FILE)}.*`,
  `${logPath(READS_ROTATE_TEMP_FILE)}.*`,
  `${logPath(READS_EVICT_TEMP_FILE)}.*`,
];

/**
 * `check-ignore -v`'s SOURCE for one path - the ignore file whose rule matched,
 * relative to `cwd` - or null when nothing matched. The output field is
 * `<source>:<line>:<pattern>`, so the source is everything before its last two
 * colons, the same slice `gitIgnoreState` takes for the same reason.
 */
function ignoreSource(cwd, path) {
  try {
    const out = execFileSync('git', ['check-ignore', '--no-index', '-v', '--', path],
      { cwd, encoding: 'utf8' });
    const left = out.split('\n')[0].split('\t')[0];
    const last = left.lastIndexOf(':');
    const prev = last > 0 ? left.lastIndexOf(':', last - 1) : -1;
    return prev >= 0 ? left.slice(0, prev) : null;
  } catch { return null; }
}

test('trace ignore: a fresh repo gets the records folder and its own .gitignore written', () => {
  const root = ignoreRoot();
  const r = traceIgnore(root);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.written, true);
  assert.equal(r.ignored, false);         // the state as FOUND
  assert.equal(r.tracked, false);
  assert.equal(r.file, ignoreFileOf(root));
  assert.equal(r.line, logPath(TRACE_FILE));
  // BOTH rules on one call: the live record and the generation a rotation at
  // its size bound leaves behind, which `git add .planning` would otherwise
  // sweep into the repository.
  assert.equal(r.rotated_line, logPath(ROTATED_TRACE_FILE));
  // ...and the READ record's six, on a field of their own beside `line`.
  assert.deepEqual(r.reads_lines, READS_RULES);
  // The root file is not touched at all, and the new file now answers for every one of them.
  assert.equal(existsSync(join(root, '.gitignore')), false);
  assert.equal(traceIgnore(root, ['--check']).ignored, true);
  for (const path of [r.line, r.rotated_line, ...READS_RULES]) {
    assert.equal(ignoreSource(root, path), logPath('.gitignore'), path);
  }
});

test('trace ignore: a re-run adds no second line and touches no byte', () => {
  const root = ignoreRoot();
  assert.equal(traceIgnore(root).written, true);
  const after = gitignoreOf(root);
  const again = traceIgnore(root);
  assert.equal(again.written, false);
  assert.equal(again.reason, 'already-ignored');
  assert.equal(again.ignored, true);
  assert.equal(gitignoreOf(root), after);
});

test('trace ignore: a brownfield root .gitignore is left byte-identical', () => {
  // No trailing newline, deliberately: the old arm had to avoid gluing a line onto it. The new one never edits it.
  const root = ignoreRoot({ gitignore: 'node_modules/\ndist/\n*.log' });
  const r = traceIgnore(root);
  assert.equal(r.written, true, JSON.stringify(r));
  assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), 'node_modules/\ndist/\n*.log');
  assert.equal(traceIgnore(root, ['--check']).ignored, true);
});

test('trace ignore: the old root lines for the old paths cover nothing at the new ones', () => {
  // Cadence wrote these into the root file before the records folder existed. They stay harmless, and they are not
  // mistaken for coverage: the logs are written elsewhere now.
  const root = ignoreRoot({ gitignore: '.planning/trace.jsonl\n.planning/trace.1.jsonl\n.planning/reads.jsonl\n' });
  const check = traceIgnore(root, ['--check']);
  assert.equal(check.ignored, false, JSON.stringify(check));
  const r = traceIgnore(root);
  assert.equal(r.written, true, JSON.stringify(r));
  assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'),
    '.planning/trace.jsonl\n.planning/trace.1.jsonl\n.planning/reads.jsonl\n');
});

test('trace ignore: a project ignoring .planning/ wholesale is already correct', () => {
  const root = ignoreRoot({ gitignore: '.planning/\n' });
  const r = traceIgnore(root, ['--check']);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.ignored, true);
  assert.equal(r.method, 'git');          // only git can see a directory rule
  assert.equal(r.written, false);
  // ...and --check never writes, so the file is exactly what it was.
  assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), '.planning/\n');
  assert.equal(existsSync(recordsDir(join(root, '.planning'))), false);
  // The write arm agrees: nothing to add. The only thing under records/ is the stamp every seam leaves behind.
  assert.equal(traceIgnore(root).written, false);
  assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), '.planning/\n');
  assert.deepEqual(readdirSync(recordsDir(join(root, '.planning'))).sort(), ['.gitignore', 'state.json']);
});

test('trace ignore: --check writes nothing, not even the folder', () => {
  const root = ignoreRoot();
  const r = traceIgnore(root, ['--check']);
  assert.equal(r.written, false);
  assert.equal(r.ignored, false);
  assert.equal(existsSync(recordsDir(join(root, '.planning'))), false);
});

test('trace ignore: a non-git root falls back to the literal scan and still writes', () => {
  const root = ignoreRoot({ git: false });
  const r = traceIgnore(root);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.method, 'file');
  assert.equal(r.written, true);
  assert.equal(r.tracked, false);
  assert.ok(rulesOf(root).includes(`/${TRACE_FILE}`), gitignoreOf(root));
  // ...and the literal scan reads its own write back on the next run.
  assert.equal(traceIgnore(root).reason, 'already-ignored');
});

test('trace ignore: a tracked run record is REPORTED, never quietly ignored', () => {
  const root = ignoreRoot();
  mkdirSync(recordsDir(join(root, '.planning')), { recursive: true });
  writeFileSync(tracePath(join(root, '.planning')), '{"phase":1}\n');
  execFileSync('git', ['add', '--', r_(root)], { cwd: root });
  const r = traceIgnore(root, ['--check']);
  assert.equal(r.tracked, true, JSON.stringify(r));
  assert.equal(r.ignored, false);
});

/** The live record's path under the project root. */
function r_(root) { return logPath(TRACE_FILE); }

test('trace ignore: a TRACKED record whose rule is present reports ignored and writes nothing', () => {
  // The regression the `--no-index` flag closes. `check-ignore` answers "would
  // this path be ignored if it were untracked", so a path in the INDEX matched
  // nothing at all: `ignored` came back false with the rule sitting right there,
  // and the write arm - which keys off that value - wrote again on EVERY run.
  const root = ignoreRoot();
  assert.equal(ensureRecordsDir(join(root, '.planning')).ok, true);
  writeFileSync(tracePath(join(root, '.planning')), '{"phase":1}\n');
  execFileSync('git', ['add', '-f', '--', r_(root)], { cwd: root });
  const check = traceIgnore(root, ['--check']);
  assert.equal(check.ignored, true, JSON.stringify(check));
  assert.equal(check.tracked, true, JSON.stringify(check));
  assert.equal(check.method, 'git');
  assert.match(check.source, /\.gitignore$/);
  // Both facts survive together: the rule is there AND the file is still indexed,
  // which is the state whose remedy is `git rm --cached` and not another line.
  const before = gitignoreOf(root);
  assert.equal(traceIgnore(root).written, false);
  assert.equal(traceIgnore(root).written, false);
  assert.equal(gitignoreOf(root), before);
  assert.equal(rulesOf(root).filter((l) => l === `/${TRACE_FILE}`).length, 1);
});

test('trace ignore: a .git/info/exclude match does NOT satisfy the line', () => {
  // The reason `-v` is used instead of `-q`: neither `.git/info/exclude` nor
  // core.excludesFile is cloned, so a machine-local exclusion would report
  // ignored:true and leave the project with no rule of its own - and the
  // collaborator who clones it commits the run record.
  const root = ignoreRoot();
  writeFileSync(join(root, '.git', 'info', 'exclude'), `${logPath(TRACE_FILE)}\n`);
  const check = traceIgnore(root, ['--check']);
  assert.equal(check.ignored, false, JSON.stringify(check));
  assert.equal(check.method, 'git');
  assert.match(check.source, /exclude$/);
  const r = traceIgnore(root);
  assert.equal(r.written, true, JSON.stringify(r));
  assert.ok(rulesOf(root).includes(`/${TRACE_FILE}`));
});

test('trace ignore: a hand-edited file in the records folder survives byte-identical, and the gap is reported', () => {
  // D-07's state: the live record is ignored and the generation its rotation
  // leaves behind is not. Half-covered is not covered, and /cad-health has to
  // say so rather than stay silent. The file is the project's now, so the write
  // arm leaves it alone and says why.
  const root = ignoreRoot();
  ensureRecordsDir(join(root, '.planning'));
  const mine = `# mine\n/${TRACE_FILE}\nextra-rule\n`;
  writeFileSync(ignoreFileOf(root), mine);
  const check = traceIgnore(root, ['--check']);
  assert.equal(check.ignored, false, JSON.stringify(check));
  assert.equal(check.rotated_line, logPath(ROTATED_TRACE_FILE));
  assert.equal(gitignoreOf(root), mine);

  const r = traceIgnore(root);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.written, false);
  assert.equal(r.reason, 'records-gitignore-kept');
  assert.equal(gitignoreOf(root), mine);
});

test('trace ignore: the sibling rule names the file the writer actually creates', () => {
  // The drift this derivation exists to prevent: a path spelled by hand here
  // and a rotated path spelled in lib/trace.mjs are two statements of one fact.
  const r = traceIgnore(ignoreRoot());
  assert.equal(r.rotated_line, rotatedTracePath('.planning').split(sep).join('/'));
  assert.equal(r.line, tracePath('.planning').split(sep).join('/'));
});

test('trace ignore: the reads rules name the files the writer actually produces', () => {
  const r = traceIgnore(ignoreRoot());
  assert.equal(r.reads_lines[0], readsPath('.planning'));
  assert.equal(r.reads_lines[1], rotatedReadsPath('.planning'));
  assert.equal(r.reads_lines[2], logPath(READS_CLAIM_FILE));
  // The three paths a killed rotation strands - the stamps beside the sidecar,
  // the fresh record that never reached its rename, and the generation it
  // evicted - each carry a pid and a random suffix, so these three and only
  // these three are patterns.
  assert.equal(r.reads_lines[3], `${r.reads_lines[2]}.*`);
  assert.equal(r.reads_lines[4], `${readsPath('.planning')}.rotate.*`);
  assert.equal(r.reads_lines[5], `${rotatedReadsPath('.planning')}.evict.*`);
  assert.equal(r.reads_lines.length, 6);
});

test('records folder: a fresh one ignores every log file a rotation can leave, and only those', () => {
  // The file the write module writes holds its names as literals (it imports builtins only), so every name is
  // DERIVED here from the libs that write the files, and git is the judge. This is what keeps a rule and a file
  // from drifting.
  const root = ignoreRoot();
  const planning = join(root, '.planning');
  assert.equal(ensureRecordsDir(planning).ok, true);
  const dated = (f) => `${f}.12345.k3j2h`;
  const logs = [
    TRACE_FILE, ROTATED_TRACE_FILE, ROTATION_CLAIM_FILE, dated(ROTATION_CLAIM_FILE),
    READS_FILE, ROTATED_READS_FILE, READS_CLAIM_FILE, dated(READS_CLAIM_FILE),
    dated(READS_ROTATE_TEMP_FILE), dated(READS_EVICT_TEMP_FILE),
    join('risk-carry', '3', 'rulings.json'),
  ];
  for (const f of logs) {
    assert.equal(ignoreSource(root, logPath(f)), logPath('.gitignore'), f);
  }
  // What the project commits is not ignored.
  for (const f of ['ARCHIVE.md', 'FILED.md', 'DECLINED.md', join('deferred', '3', 'x.md'),
    join('codemap', 'index.json'), '.gitignore']) {
    assert.equal(ignoreSource(root, logPath(f)), null, f);
  }
});

test('records folder: git status shows no log after an append and a forced rotation of each', () => {
  const root = ignoreRoot();
  const planning = join(root, '.planning');
  writeFileSync(join(planning, 'STATE.md'), 'state\n');
  // stamped, or the appenders write nothing; the state file is committed, the ignore file it brought is left for the check
  stampState(planning);
  execFileSync('git', ['add', '--', '.planning/STATE.md', '.planning/records/state.json'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: root });
  assert.equal(appendEvent(planning, { phase: 1, family: 'lifecycle', event: 'phase_start', sha: 'abc1234' }).written, true);
  assert.equal(appendRead(planning, { ts: '2026-08-14T00:00:00.000Z', tool: 'Read', target: '/a' }).written, true);
  // pad both past what a rotation keeps, then rotate them, so every generation and sidecar exists
  writeFileSync(tracePath(planning), `${readFileSync(tracePath(planning), 'utf8')}${'x'.repeat(2000)}\n`);
  writeFileSync(readsPath(planning), `${readFileSync(readsPath(planning), 'utf8')}${'x'.repeat(2000)}\n`);
  assert.equal(rotateTrace(planning, 0).rotated, true);
  assert.equal(rotateReads(planning, 0).rotated, true);
  assert.equal(existsSync(rotatedTracePath(planning)), true);
  assert.equal(existsSync(rotatedReadsPath(planning)), true);
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'],
    { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  // the only thing left to commit is the ignore file itself
  assert.deepEqual(status, [`?? ${logPath('.gitignore')}`]);
  assert.ok(MAX_READS_BYTES > 0);
});

test('trace ignore: a symlinked records folder is refused and nothing is written through it', () => {
  const root = ignoreRoot();
  const outside = mkdtempSync(join(tmpdir(), 'cad-ignore-outside-'));
  symlinkSync(outside, recordsDir(join(root, '.planning')));
  const r = traceIgnore(root);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.reason, 'symlinked-records');
  assert.deepEqual(readdirSync(outside), []);
});

test('trace ignore: a --root present with nothing usable is refused, never the cwd', () => {
  const root = ignoreRoot();
  // A valueless flag: parseArgs renders it as boolean true.
  const bare = traceIgnore(null, ['--root']);
  assert.equal(bare.ok, false, JSON.stringify(bare));
  assert.equal(bare.reason, 'bad-args');
  assert.match(bare.detail, /--root/);
  const empty = traceIgnore('');
  assert.equal(empty.ok, false, JSON.stringify(empty));
  assert.equal(empty.reason, 'bad-args');
  // ...and the usable form still works, so the guard is not refusing everything.
  assert.equal(traceIgnore(root).ok, true);
});

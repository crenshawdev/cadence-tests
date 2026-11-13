// phase-spelling.test.mjs - the tree-aware `--phase` refusal, at every
// `cadence-core/bin/planning/` face that resolves a spelling to a
// `phases/<N>/` path (phase 4, SPL-02).
//
// TWO ARMS PER FACE, always, because the refusal is TREE-AWARE and one arm
// alone proves the wrong thing (CONTEXT D-07). Against a tree holding
// `phases/1.1/`, `--phase 1.10` is `ok:false` / `bad-args` with a detail
// naming BOTH spellings. Against a tree holding only `phases/1.10/`, the SAME
// argv gets past the phase check and acts on `phases/1.10/` - the sub-phase-ten
// capability `lib/require-int.mjs` deliberately built, which this phase keeps.
// A file that only proved the refusal would pass just as well if the check were
// `phaseSpellingRefusal`'s unconditional one, which is the shape D-07 rejects.
//
// The harm is the MIXED callsite (D-06), not a wholesale misread: every one of
// these commands already reads `phases/<raw>/` verbatim, and it is the envelope's
// `phase: <value>` key beside those bytes that lies. So a "does it read the right
// directory" assertion proves nothing here and none is written.
//
// No entry in test.mjs's GROUPS: the stem is deliberately not a `planning-*`
// one, so it lands in `other`, which the default run and CI both execute - the
// same disposition census-registry.test.mjs:19 states for itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// The lease-check trio, imported rather than re-declared: that face runs inside
// a real git repo, and a second copy of the repo builder is how two fixtures
// drift apart. Importing registers nothing - the sibling's own `test` binding
// is a no-op unless it IS the entry file.
import { leaseRepo, leaseCheck, stage } from './planning-lease-check.test.mjs';
import { recordsDir } from '../cadence-core/bin/lib/planning-store.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'cadence-core', 'bin');
const PLANNING = join(BIN, 'planning.mjs');

/**
 * A `.planning` tree whose `phases/` holds exactly `names`, and whose ROADMAP
 * lists phases 1 and 2 so `status`-shaped readers have something canonical to
 * reconcile against. Returns the `.planning` directory.
 */
function tree(names) {
  const dir = join(mkdtempSync(join(tmpdir(), 'cad-spelling-')), '.planning');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ROADMAP.md'),
    '# Roadmap: Fixture\n\n## Phases\n\n- [ ] **Phase 1: One** - desc\n'
    + '- [ ] **Phase 2: Two** - desc\n\n## Phase Details\n\n'
    + '### Phase 1: One\n**Goal:** goal 1\n**Depends on:** Nothing\n');
  for (const n of names) mkdirSync(join(dir, 'phases', n), { recursive: true });
  return dir;
}

/** The seam, `--dir` last the way planning.test.mjs's own runner sends it. */
function seam(args, dir, extra = {}) {
  let stdout;
  let code = 0;
  try {
    stdout = execFileSync('node', [PLANNING, ...args, '--dir', dir],
      { encoding: 'utf8', ...extra });
  } catch (e) { stdout = e.stdout; code = e.status; }
  return { ...JSON.parse(stdout), _exit: code };
}

/** The collision refusal, asserted whole: reason, both spellings, the two fixes. */
function assertRefused(r, raw, canonical) {
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.reason, 'bad-args', JSON.stringify(r));
  assert.ok(r.detail.includes(`"${raw}"`), r.detail);
  assert.ok(r.detail.includes(`phases/${canonical}/`), r.detail);
  assert.ok(r.detail.includes(`--phase "${canonical}"`), r.detail);
  assert.ok(r.detail.includes(`rename phases/${raw}/`), r.detail);
}

/** The negative: whatever this answered, it was not the collision refusal. */
function assertNotRefused(r) {
  assert.equal(typeof r.detail === 'string' && r.detail.includes('already exists on this tree'),
    false, JSON.stringify(r));
}

// --- the two fire faces: adjudication and deferred record ------------------
//
// Both reach the check through `fireIdentity`, the ONE callsite they share, and
// it fires ahead of the `--trigger`/`--discriminator` token rails and well ahead
// of `fireHome`. `fireHome`'s `no-phase-dir` is not a substitute: it names the
// right directory but neither of the two fixes, which is exactly the pre-change
// behaviour D-06 warns against mistaking for the new one.
const FIRE_FACES = [
  ['adjudication', ['adjudication']],
  ['deferred record', ['deferred', 'record']],
];

for (const [label, argv0] of FIRE_FACES) {
  test(`${label}: --phase 1.10 refuses against a tree holding phases/1.1/`, () => {
    const dir = tree(['1', '1.1']);
    const r = seam([...argv0, '--phase', '1.10', '--trigger', 'risk_surface',
      '--discriminator', 'plan-1'], dir);
    assertRefused(r, '1.10', '1.1');
    assert.ok(r.detail.startsWith(`${label} --phase`), r.detail);
  });

  test(`${label}: --phase 1.10 gets past the phase check when only phases/1.10/ exists`, () => {
    const dir = tree(['1', '1.10']);
    const r = seam([...argv0, '--phase', '1.10', '--trigger', 'risk_surface',
      '--discriminator', 'plan-1'], dir);
    assertNotRefused(r);
    // It reached the NEXT rail - both refs, neither defaulted - which is two
    // rails past the phase check.
    assert.equal(r.reason, 'bad-args', JSON.stringify(r));
    assert.match(r.detail, /--base <ref> and --head <ref>/);
  });

  test(`${label}: the token rails still fire after a clean spelling`, () => {
    const dir = tree(['1', '1.1']);
    const r = seam([...argv0, '--phase', '1.1', '--trigger', 'risk surface',
      '--discriminator', 'plan-1'], dir);
    assertNotRefused(r);
    assert.equal(r.reason, 'bad-args', JSON.stringify(r));
    assert.match(r.detail, /--trigger reaches a FILENAME/);
  });
}

test('the collision refusal is TREE-aware, not the unconditional one: 08 with no phases/8/', () => {
  const dir = tree(['08']);
  const r = seam(['adjudication', '--phase', '08', '--trigger', 'risk_surface',
    '--discriminator', 'plan-1'], dir);
  assertNotRefused(r);
});

test('a canonical spelling is never refused, whatever else is on the tree', () => {
  const dir = tree(['1', '1.1', '1.10']);
  const r = seam(['adjudication', '--phase', '1.1', '--trigger', 'risk_surface',
    '--discriminator', 'plan-1'], dir);
  assertNotRefused(r);
});

// --- the six phase-artifact readers ----------------------------------------
//
// Each row seeds `phases/<n>/` with whatever that command has to find to do
// real work, then asserts on the RESOLVE tree that the command acted on
// `phases/1.10/` - not merely that it answered ok:true, which a normalizing
// reader looking at an empty `phases/1.1/` would also do.
const READERS = [
  {
    label: 'criteria-size',
    seed: (pdir) => writeFileSync(join(pdir, 'CONTEXT.md'),
      '# Context\n\n## Acceptance criteria\n\n- [ ] AC1: one\n- [ ] AC2: two\n'),
    argv: ['criteria-size'],
    acted: (r) => {
      assert.equal(r.phases[0].context_found, true, JSON.stringify(r));
      assert.equal(r.phases[0].context_criteria, 2, JSON.stringify(r));
    },
  },
  {
    label: 'plan-size',
    seed: (pdir) => writeFileSync(join(pdir, 'PLAN.md'),
      '---\nphase: 1.10\nfiles:\n  - a.txt\n---\n# Plan\n\n## Tasks\n\n'
      + '### Task 1: x\n\n- **Files:** a.txt\n- **Action:** do\n- **Verify:** check\n'),
    argv: ['plan-size'],
    acted: (r) => assert.deepEqual(r.plans,
      [{ plan: 'PLAN.md', tasks: 1, bytes: 0, absent: 1 }], JSON.stringify(r)),
  },
  {
    label: 'plan-overlap',
    seed: (pdir) => {
      writeFileSync(join(pdir, 'PLAN-1.md'), '---\nphase: 1.10\nfiles:\n  - shared.txt\n---\n# Plan 1\n');
      writeFileSync(join(pdir, 'PLAN-2.md'), '---\nphase: 1.10\nfiles:\n  - shared.txt\n---\n# Plan 2\n');
    },
    argv: ['plan-overlap'],
    acted: (r) => assert.deepEqual(r.overlaps,
      [{ plans: ['PLAN-1.md', 'PLAN-2.md'], files: ['shared.txt'] }], JSON.stringify(r)),
  },
  {
    label: 'cite-count',
    seed: (pdir) => writeFileSync(join(pdir, 'PLAN.md'),
      '---\nphase: 1.10\nfiles:\n  - a.txt\n---\n# Plan\n'),
    argv: ['cite-count'],
    extraArgs: (dir) => {
      const payload = join(dirname(dir), 'surfaced.json');
      writeFileSync(payload, JSON.stringify({ ok: true, backend: 'builtin', results: [] }));
      return ['--payload', payload];
    },
    acted: (r) => assert.deepEqual(r.plans, ['PLAN.md'], JSON.stringify(r)),
  },
  {
    label: 'uat',
    seed: (pdir) => writeFileSync(join(pdir, 'UAT.md'),
      '---\nstatus: testing\nphase: 1.10\nstarted: 2026-01-01\nupdated: 2026-01-01\n---\n\n'
      + '## Items\n\n### 1. Item 1\nexpected: behavior 1\nstatus: pass\n\n## Summary\n\ntotal: 1\n'),
    argv: ['uat', 'status'],
    acted: (r) => assert.equal(r.counts.pass, 1, JSON.stringify(r)),
  },
];

for (const row of READERS) {
  test(`${row.label}: --phase 1.10 acts on phases/1.10/ when no phases/1.1 exists`, () => {
    const dir = tree(['1', '1.10']);
    row.seed(join(dir, 'phases', '1.10'));
    const extra = row.extraArgs ? row.extraArgs(dir) : [];
    const r = seam([...row.argv, '--phase', '1.10', ...extra], dir);
    assert.equal(r.ok, true, JSON.stringify(r));
    row.acted(r);
  });

  test(`${row.label}: --phase 1.10 refuses against a tree holding phases/1.1/`, () => {
    const dir = tree(['1', '1.1', '1.10']);
    row.seed(join(dir, 'phases', '1.10'));
    const extra = row.extraArgs ? row.extraArgs(dir) : [];
    const r = seam([...row.argv, '--phase', '1.10', ...extra], dir);
    assertRefused(r, '1.10', '1.1');
    assert.ok(r.detail.startsWith(`${row.label} --phase`), r.detail);
  });

  test(`${row.label}: --phase 08 refuses against a tree holding phases/8/`, () => {
    const dir = tree(['8', '08']);
    row.seed(join(dir, 'phases', '08'));
    const extra = row.extraArgs ? row.extraArgs(dir) : [];
    const r = seam([...row.argv, '--phase', '08', ...extra], dir);
    assertRefused(r, '08', '8');
  });
}

// lease-check is the sixth, and it runs inside a real git repo: the seam
// resolves the staged set from `git rev-parse --show-toplevel`, so `tree()`
// above cannot host it.
test('lease-check: --phase 1.10 acts on phases/1.10/ when no phases/1.1 exists', () => {
  const { repo, dir } = leaseRepo({ phase: '1.10', files: ['one-ten.txt'] });
  stage(repo, 'one-ten.txt');
  const r = leaseCheck(repo, dir, ['--phase', '1.10', '--plan', '1']);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.plan_file, '.planning/phases/1.10/PLAN.md');
});

test('lease-check: --phase 1.10 refuses against a tree holding phases/1.1/', () => {
  const { repo, dir } = leaseRepo({ phase: '1.10', files: ['one-ten.txt'] });
  mkdirSync(join(dir, 'phases', '1.1'), { recursive: true });
  stage(repo, 'one-ten.txt');
  const r = leaseCheck(repo, dir, ['--phase', '1.10', '--plan', '1']);
  assertRefused(r, '1.10', '1.1');
  assert.ok(r.detail.startsWith('lease-check --phase'), r.detail);
});

test('lease-check: --phase 08 refuses against a tree holding phases/8/', () => {
  const { repo, dir } = leaseRepo({ phase: 8, files: ['a.txt'] });
  stage(repo, 'a.txt');
  const r = leaseCheck(repo, dir, ['--phase', '08', '--plan', '1']);
  assertRefused(r, '08', '8');
});


// --- the queue and record faces -------------------------------------------
//
// Three more path-resolving callsites, each wired for a reason its own row
// states. `deferred carry` RENAMES committed artifacts out of `phases/<raw>/`;
// `deferred list` echoes nothing numeric but selects a directory under
// `phases/` by exact name inside `readQueue`; `trace append` and `trace close`
// share one body whose `.raw` reaches `recountReceipt` and then
// `recordForFire`'s `join(dir, 'phases', ...)` - on the ONE spelling `0` it
// reaches that function's task arm and the `tasks/<slug>/` walk instead, which
// changes nothing here: `0` is the number no roadmap phase carries, so it is
// the one spelling that can collide with no phase directory at all.

/** A queue member straight into `phases/<phase>/`, no repository needed - the
 * same shape planning-deferred.test.mjs's `putMember` writes. */
function putMember(dir, phase) {
  mkdirSync(join(dir, 'phases', String(phase), 'records'), { recursive: true });
  writeFileSync(join(dir, 'phases', String(phase), 'records', 'DEFERRED-diff-plan-1.json'),
    `${JSON.stringify({
      phase: String(phase),
      trigger: 'diff',
      discriminator: 'plan-1',
      round: 1,
      findings: [{
        file: 'src.js',
        line: 1,
        severity: 'high',
        claim: 'the "x" binding is reassigned',
        failure_scenario: 'a second reader sees 1 where the first saw 2',
      }],
    })}\n`);
}

test('deferred carry: --phase 1.10 carries out of phases/1.10/ when no phases/1.1 exists', () => {
  const dir = tree(['1', '1.10']);
  putMember(dir, '1.10');
  const r = seam(['deferred', 'carry', '--phase', '1.10'], dir);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.carried, 1, JSON.stringify(r));
  assert.equal(r.moved[0].from, 'phases/1.10/records/DEFERRED-diff-plan-1.json', JSON.stringify(r));
  assert.equal(r.moved[0].to, 'records/deferred/1.10/DEFERRED-diff-plan-1.json', JSON.stringify(r));
});

test('deferred carry: --phase 1.10 refuses against a tree holding phases/1.1/, moving nothing', () => {
  const dir = tree(['1', '1.1', '1.10']);
  putMember(dir, '1.10');
  const r = seam(['deferred', 'carry', '--phase', '1.10'], dir);
  assertRefused(r, '1.10', '1.1');
  assert.ok(r.detail.startsWith('deferred carry --phase'), r.detail);
  // The refusal is ahead of every rename, which is the whole reason it sits
  // where it does: this face MOVES committed artifacts.
  assert.equal(existsSync(join(dir, 'phases', '1.10', 'records', 'DEFERRED-diff-plan-1.json')), true);
  assert.equal(existsSync(join(dir, 'records', 'deferred')), false);
});

test('deferred carry: --phase 08 refuses against a tree holding phases/8/', () => {
  const dir = tree(['8', '08']);
  putMember(dir, '08');
  assertRefused(seam(['deferred', 'carry', '--phase', '08'], dir), '08', '8');
});

test('deferred list: --phase 1.10 lists phases/1.10/ when no phases/1.1 exists', () => {
  const dir = tree(['1', '1.10']);
  putMember(dir, '1.10');
  const r = seam(['deferred', 'list', '--phase', '1.10'], dir);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.members.map((m) => m.path),
    ['phases/1.10/records/DEFERRED-diff-plan-1.json'], JSON.stringify(r));
});

test('deferred list: --phase 1.10 refuses against a tree holding phases/1.1/', () => {
  const dir = tree(['1', '1.1', '1.10']);
  putMember(dir, '1.10');
  const r = seam(['deferred', 'list', '--phase', '1.10'], dir);
  assertRefused(r, '1.10', '1.1');
  assert.ok(r.detail.startsWith('deferred list --phase'), r.detail);
});

test('deferred list: --phase 08 refuses against a tree holding phases/8/', () => {
  const dir = tree(['8', '08']);
  putMember(dir, '08');
  assertRefused(seam(['deferred', 'list', '--phase', '08'], dir), '08', '8');
});

const APPEND = ['trace', 'append', '--family', 'lifecycle', '--event', 'phase_start'];

test('trace append: --phase 1.10 appends when no phases/1.1 exists', () => {
  const dir = tree(['1', '1.10']);
  const r = seam([...APPEND, '--phase', '1.10'], dir);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.written, true, JSON.stringify(r));
  assert.equal(r.corr, '1.10', JSON.stringify(r));
});

test('trace append: --phase 1.10 refuses against a tree holding phases/1.1/, appending nothing', () => {
  const dir = tree(['1', '1.1', '1.10']);
  const r = seam([...APPEND, '--phase', '1.10'], dir);
  assertRefused(r, '1.10', '1.1');
  assert.ok(r.detail.startsWith('trace append --phase'), r.detail);
  assert.equal(existsSync(join(recordsDir(dir), 'trace.jsonl')), false);
});

test('trace close: the same body, so it refuses on the same tree', () => {
  const dir = tree(['1', '1.1', '1.10']);
  const r = seam(['trace', 'close', '--phase', '1.10', '--role', 'executor'], dir);
  assertRefused(r, '1.10', '1.1');
  assert.ok(r.detail.startsWith('trace close --phase'), r.detail);
});

// --- the three exemptions, asserted rather than assumed ---------------------
//
// A wire at any of these would be a REGRESSION, so each gets an arm that goes
// red if one is added. `capture` resolves no `phases/<N>/` path at all (D-08);
// `trace render`, `suggest` and `window` scope a `.planning/trace.jsonl`
// filter and resolve no directory either.

test('capture: --phase 1.10 still writes the tag (phase 1.10) on a tree holding phases/1.1/', () => {
  const dir = tree(['1', '1.1', '1.10']);
  const r = seam(['capture', '--kind', 'todo', '--text', 'a thing', '--phase', '1.10'], dir);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.bullet, '- [ ] (phase 1.10) a thing', JSON.stringify(r));
  assert.match(readFileSync(join(dir, 'CAPTURE.md'), 'utf8'), /\(phase 1\.10\) a thing/);
});

test('trace render: --phase 1.10 still renders on a tree holding phases/1.1/', () => {
  const dir = tree(['1', '1.1', '1.10']);
  seam([...APPEND, '--phase', '1.1'], dir); // something for the filter to skip
  const r = seam(['trace', 'render', '--phase', '1.10'], dir);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.corr, '1.10', JSON.stringify(r));
});


// --- the census: every `--phase` reader under planning/, dispositioned -------
//
// WHAT IT PINS. The wire above is a property of one guard and the callsites
// that run it: `phaseGuard` in `planning/core.mjs` parses `--phase` and runs
// `phaseSpellingCollision`, and every face that resolves `phases/<N>/` from a
// caller's spelling is meant to call it. The way that stops being true is a new
// command that parses the flag on its own and never takes the check. Nothing
// else in this tree would notice, so every guard call and every direct
// `requirePhaseArg` parse is written down here and re-derived by a walk.
//
// KEYED BY FILE + ENCLOSING FUNCTION + ORDINAL, never by line. A line-keyed
// table would redden this suite on every unrelated edit to these modules - a
// rail that fires wrong gets deleted rather than tuned - while the function
// name is what a reader is actually sent to. The LINE is still reported in the
// failure message, because that is what a reader opens. The ordinal counts
// guard calls and direct parses together, in source order.
//
// `lib/arg-contract.mjs` is deliberately outside the walk and gets this
// sentence instead of a row: it is the reader that PRODUCES a parse result
// rather than a consumer that resolves a path from one. Scoping the walk to
// exactly what this census's registry subjects cover
// (`cadence-core/bin/planning/`) is what keeps the count from moving inside a
// file no lease refusal watches.
//
// THE ENCLOSING-FUNCTION SCAN is top-level `function` declarations only. A
// callsite moved inside a top-level arrow-assigned const would be attributed to
// the function above it and redden the set-equality below, which is the safe
// direction: the census reports rather than guesses.
//
// THE WALK TAKES ITS SOURCE AS AN ARGUMENT, so the non-vacuity test at the
// bottom can run the very same walk and comparisons over a synthetic module.
// The call spellings are built from parts for the same reason: this file's own
// text must carry nothing a walk would count.

const PLANNING_DIR = join(BIN, 'planning');
const GUARD = 'phaseGuard';
const PARSE = 'requirePhaseArg';

/** Every `.mjs` under `planning/`, as `{file: text}`. */
function planningSources() {
  const out = {};
  for (const file of readdirSync(PLANNING_DIR).filter((n) => n.endsWith('.mjs')).sort()) {
    out[file] = readFileSync(join(PLANNING_DIR, file), 'utf8');
  }
  return out;
}

/** Every top-level `function` in one module's lines, as `{name, start, end}`
 * 0-based half-open spans. */
function functionSpans(lines) {
  const spans = [];
  for (let i = 0; i < lines.length; i++) {
    const decl = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/.exec(lines[i]);
    if (!decl) continue;
    if (spans.length) spans[spans.length - 1].end = i;
    spans.push({ name: decl[1], start: i, end: lines.length });
  }
  return spans;
}

/** Every guard call and direct phase-argument parse in `sources` (`{file: text}`), as
 * `{file, fn, ordinal, line, callee, body}` - `callee` being `'guard'` or `'parse'` and
 * `body` its enclosing function's source, which is what the disposition assertions read. */
function phaseArgCallsites(sources) {
  const guardCall = new RegExp(`(?<![\\w$.])${GUARD}\\${'('}`);
  const parseCall = new RegExp(`(?<![\\w$.])${PARSE}\\${'('}`);
  const out = [];
  for (const file of Object.keys(sources).sort()) {
    const lines = sources[file].split('\n');
    const spans = functionSpans(lines);
    const seen = new Map();
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i].trim();
      // Comments never count: this census is over invocations, and a sentence
      // naming the function is documentation, not a callsite. A declaration is
      // not a call either.
      if (text.startsWith('//') || text.startsWith('*')) continue;
      if (/^(?:export\s+)?(?:async\s+)?function\s/.test(text)) continue;
      const callee = guardCall.test(text) ? 'guard' : parseCall.test(text) ? 'parse' : null;
      if (!callee) continue;
      const span = spans.find((sp) => i >= sp.start && i < sp.end);
      const fn = span ? span.name : '(top level)';
      const ordinal = (seen.get(fn) || 0) + 1;
      seen.set(fn, ordinal);
      out.push({
        file,
        fn,
        ordinal,
        line: i + 1,
        callee,
        body: span ? lines.slice(span.start, span.end).join('\n') : '',
      });
    }
  }
  return out;
}

/** The source of the guard's own definition in `core.mjs`, or null when it is gone. */
function guardBody(sources) {
  const lines = (sources['core.mjs'] || '').split('\n');
  const span = functionSpans(lines).find((sp) => sp.name === GUARD);
  return span ? lines.slice(span.start, span.end).join('\n') : null;
}

/**
 * The hand-written disposition of every callsite the walk finds.
 *
 * `tree-aware` takes the tree-aware check (through the guard), `unconditional`
 * calls `phaseSpellingRefusal`, and `exempt` takes neither and states why in the
 * same row. The two guarded dispositions are ASSERTED against the source below;
 * an exempt row is a claim a reader can check, which is the most a census can be
 * about a callsite that does nothing.
 */
const CALLSITES = [
  { file: 'brief.mjs', fn: 'cmdBrief', ordinal: 1, disposition: 'tree-aware',
    why: 'resolves the plan file under the phase directory and names it by the caller\'s spelling' },
  { file: 'capture.mjs', fn: 'cmdCapture', ordinal: 1, disposition: 'exempt',
    why: 'the raw spelling is a TAG appended to CAPTURE.md and no phases/<N>/ path is resolved (D-08)' },
  { file: 'cite-count.mjs', fn: 'cmdCiteCount', ordinal: 1, disposition: 'tree-aware',
    why: 'reads the phase directory plans and echoes phase: <value> beside them' },
  { file: 'core.mjs', fn: 'fireIdentity', ordinal: 1, disposition: 'tree-aware',
    why: 'the guard call adjudication and deferred record share; fireHome joins the phase directory' },
  { file: 'core.mjs', fn: 'phaseGuard', ordinal: 1, disposition: 'exempt',
    why: 'the guard\'s own parse; the census asserts its body goes on to call phaseSpellingCollision' },
  { file: 'core.mjs', fn: 'decimalRefusal', ordinal: 1, disposition: 'exempt',
    why: 'wording over a raw token - it decides whether a refusal sentence mentions the decimal form' },
  { file: 'criteria-size.mjs', fn: 'cmdCriteriaSize', ordinal: 1, disposition: 'tree-aware',
    why: 'the --phase branch reads that phase CONTEXT.md and echoes phase: <value>' },
  { file: 'cursor-set.mjs', fn: 'cmdCursorSet', ordinal: 1, disposition: 'unconditional',
    why: 'a WRITE face: the cursor it sets is read back as a phase identity, so a lossy spelling is'
      + ' refused whatever is on disk (D-07)' },
  { file: 'deferred-carry.mjs', fn: 'cmdDeferredCarry', ordinal: 1, disposition: 'tree-aware',
    why: 'renames committed queue members out of the phase directory' },
  { file: 'deferred-list.mjs', fn: 'cmdDeferredList', ordinal: 1, disposition: 'tree-aware',
    why: 'wantPhase selects a directory under phases/ by exact name inside readQueue' },
  { file: 'lease-check.mjs', fn: 'cmdLeaseCheck', ordinal: 1, disposition: 'tree-aware',
    why: 'resolves the plan file under the phase directory and echoes phase: <value>' },
  { file: 'phase-entry.mjs', fn: 'cmdPhaseEntry', ordinal: 1, disposition: 'unconditional',
    why: 'a WRITE face: the phase number it adds or edits is the state\'s phase identity, so a lossy'
      + ' spelling is refused whatever is on disk (D-07)' },
  { file: 'phase-done.mjs', fn: 'cmdPhaseDone', ordinal: 1, disposition: 'exempt',
    why: 'value only - it flips ROADMAP and STATE rows and opens no phase directory' },
  { file: 'plan-overlap.mjs', fn: 'cmdPlanOverlap', ordinal: 1, disposition: 'tree-aware',
    why: 'lists the phase directory plans and echoes phase: <value>' },
  { file: 'plan-size.mjs', fn: 'cmdPlanSize', ordinal: 1, disposition: 'tree-aware',
    why: 'lists the phase directory plans and echoes phase: <value>' },
  { file: 'records-dir.mjs', fn: 'cmdRecordsDir', ordinal: 1, disposition: 'tree-aware',
    why: 'makes the directory under the phase directory fireHome resolves, by the caller\'s spelling' },
  { file: 'replay-check.mjs', fn: 'cmdReplayCheck', ordinal: 1, disposition: 'tree-aware',
    why: "reads each plan's reports/plan-<k>.md under the phase directory and echoes phase: <value>" },
  { file: 'req-row.mjs', fn: 'cmdReqRow', ordinal: 1, disposition: 'unconditional',
    why: 'a WRITE face: the traceability row it re-points carries the phase, so a lossy spelling is'
      + ' refused whatever is on disk (D-07)' },
  { file: 'risk-carry.mjs', fn: 'cmdRiskCarry', ordinal: 1, disposition: 'tree-aware',
    why: 'copies the phase directory\'s risk_surface review and adjudication records out to'
      + ' risk-carry/<N>/ and echoes phase: <value> over them' },
  { file: 'risk-check.mjs', fn: 'cmdRiskCheckRun', ordinal: 1, disposition: 'exempt',
    why: 'the raw spelling scopes a .planning/trace.jsonl filter through renderTrace and reaches no path' },
  { file: 'risk-check.mjs', fn: 'cmdRiskCheckStatus', ordinal: 1, disposition: 'exempt',
    why: 'the raw spelling scopes a .planning/trace.jsonl filter through renderTrace and reaches no path' },
  { file: 'seed-reqs.mjs', fn: 'cmdSeedReqs', ordinal: 1, disposition: 'unconditional',
    why: 'a WRITE face: the traceability rows it seeds carry the phase, so a lossy spelling is refused'
      + ' whatever is on disk (D-07)' },
  { file: 'testing-policy.mjs', fn: 'cmdCiStatus', ordinal: 1, disposition: 'tree-aware',
    why: 'reads and rewrites the phase UAT.md to record the commit' },
  { file: 'trace.mjs', fn: 'checkpointPlanTasks', ordinal: 1, disposition: 'exempt',
    why: 'the phase comes off a RECORD line, not off a flag - there is no caller to send back to a'
      + ' different spelling' },
  { file: 'trace.mjs', fn: 'cmdTrace', ordinal: 1, disposition: 'tree-aware',
    why: 'the append/close body: its raw spelling reaches recountReceipt and then recordForFire' },
  { file: 'trace.mjs', fn: 'cmdTrace', ordinal: 2, disposition: 'exempt',
    why: 'the suggest arm scopes a .planning/trace.jsonl filter and resolves no phases/<N>/ path' },
  { file: 'trace.mjs', fn: 'cmdTrace', ordinal: 3, disposition: 'exempt',
    why: 'the render arm scopes a .planning/trace.jsonl filter and resolves no phases/<N>/ path' },
  { file: 'trace.mjs', fn: 'cmdTrace', ordinal: 4, disposition: 'exempt',
    why: 'the window arm scopes a .planning/trace.jsonl filter and resolves no phases/<N>/ path' },
  { file: 'workflow-run.mjs', fn: 'cmdWorkflowRun', ordinal: 1, disposition: 'exempt',
    why: 'the phase scopes the run record the brackets join and names no phases/<N>/ path; it writes into the --out-dir it is given' },
  { file: 'uat.mjs', fn: 'cmdUat', ordinal: 1, disposition: 'tree-aware',
    why: 'reads the phase UAT.md and echoes phase: <value>' },
];

const keyOf = (c) => `${c.file} ${c.fn} #${c.ordinal}`;

/**
 * The census's three comparisons, over any source: a callsite with no row, a row with no
 * callsite, and a callsite that does not take the check its disposition claims. The guard
 * itself is held to its half of the bargain here too - its body must call the collision check.
 * @returns {{unlisted: string[], gone: string[], unchecked: string[]}}
 */
function censusIssues(sources, rows) {
  const found = phaseArgCallsites(sources);
  const foundKeys = new Set(found.map(keyOf));
  const tableKeys = new Set(rows.map(keyOf));
  const unchecked = [];
  for (const row of rows) {
    const site = found.find((c) => keyOf(c) === keyOf(row));
    if (!site) continue;
    if (row.disposition === 'tree-aware' && site.callee !== 'guard') {
      unchecked.push(`${site.file}:${site.line} is dispositioned tree-aware, but ${site.fn} parses --phase`
        + ` itself instead of calling ${GUARD} - a phases/<N>/ path resolved from the caller's spelling`
        + ' with no check in front of it is exactly what this census exists to stop');
    }
    if (row.disposition === 'unconditional' && !site.body.includes(`phaseSpellingRefusal${'('}`)) {
      unchecked.push(`${site.file}:${site.line} is dispositioned unconditional, but ${site.fn} never calls`
        + ' phaseSpellingRefusal');
    }
  }
  const body = guardBody(sources);
  if (body === null || !body.includes(`phaseSpellingCollision${'('}`)) {
    unchecked.push(`${GUARD} in core.mjs ${body === null ? 'is gone' : 'never calls phaseSpellingCollision'}`
      + ' - every face dispositioned tree-aware relies on it for the tree-aware refusal');
  }
  return {
    unlisted: found.filter((c) => !tableKeys.has(keyOf(c))).map((c) => `${c.file}:${c.line} (${c.fn} #${c.ordinal})`),
    gone: [...tableKeys].filter((k) => !foundKeys.has(k)),
    unchecked,
  };
}

test('census: every phase-guard call and direct phase-argument parse under planning/ carries a disposition', () => {
  const sources = planningSources();
  const found = phaseArgCallsites(sources);
  const { unlisted, gone } = censusIssues(sources, CALLSITES);

  assert.deepEqual(unlisted, [],
    'a phase-guard call or a direct phase-argument parse under cadence-core/bin/planning/ has no row in'
    + ' CALLSITES. Add a row naming its disposition and why: `tree-aware` if it is a call to the guard,'
    + ' `unconditional` for a write face taking phaseSpellingRefusal, `exempt` only if it resolves no'
    + ' phase directory at all.');
  assert.deepEqual(gone, [],
    'CALLSITES names a callsite the walk no longer finds - delete the row if the callsite is gone,'
    + ' or re-key it if its enclosing function was renamed.');

  // CADENCE-CENSUS: phase-spelling-callsites | asserts: 30 phase-guard calls and direct phase-argument parses under cadence-core/bin/planning/, 15 of them tree-aware, 4 unconditional and 11 exempt
  assert.equal(found.length, 30, `callsite count moved: ${found.length}`);
  const by = (d) => CALLSITES.filter((c) => c.disposition === d).length;
  assert.equal(by('tree-aware'), 15);
  assert.equal(by('unconditional'), 4);
  assert.equal(by('exempt'), 11);
});

test('census: every path-resolving callsite actually calls its check', () => {
  const { unchecked } = censusIssues(planningSources(), CALLSITES);
  assert.deepEqual(unchecked, []);
});

test('census: the comparisons go red on a synthetic module - an unlisted callsite, a guard with no check', () => {
  const parse = `${PARSE}${'('}opts.phase${')'}`;
  const guardOk = `function ${GUARD}${'('}face, dir, phase) {\n  const parsed = ${parse};\n`
    + `  return phaseSpellingCollision${'('}dir, parsed);\n}\n`;
  const guardBare = `function ${GUARD}${'('}face, dir, phase) {\n  const parsed = ${parse};\n  return parsed;\n}\n`;
  const rows = [
    { file: 'core.mjs', fn: GUARD, ordinal: 1, disposition: 'exempt', why: 'the guard parses' },
  ];

  const clean = censusIssues({ 'core.mjs': guardOk }, rows);
  assert.deepEqual(clean, { unlisted: [], gone: [], unchecked: [] }, 'the clean module reports nothing');

  const stray = censusIssues({
    'core.mjs': guardOk,
    'newface.mjs': `function cmdNew${'('}dir, opts) {\n  const p = ${parse};\n}\n`,
  }, rows);
  assert.deepEqual(stray.unlisted, ['newface.mjs:2 (cmdNew #1)']);

  const hollow = censusIssues({ 'core.mjs': guardBare }, rows);
  assert.equal(hollow.unchecked.length, 1);
  assert.match(hollow.unchecked[0], /never calls phaseSpellingCollision/);
});

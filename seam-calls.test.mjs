// The per-workflow seam-invocation census (ENF-01, AC4). ROADMAP criterion 4
// asks that the happy-path seam-call count per workflow DROPS and that the new
// count be stated; this file is where it is stated. A prose sentence or a
// DOCS-CLAIMS.md row would be a claim nothing re-measures (D-18), and phase 5's
// whole premise is that this repo treats a stale self-claim as a defect.
//
// Two files, not every workflow. These are the two the 2026-08-14 scan measured
// unbatched round-trips in, so these are the two whose numbers were paid for; a
// row for a file nobody measured would pin whatever it happens to hold today.
// A file added here later travels with the measurement that justified it.
//
// The numbers are DERIVED, never baselined. A census that pins whatever it
// finds records the bug as correct and can never show a drop, so each row
// carries the arithmetic that produced it from the plan-time measurement:
//
//   plan.md    11 -> 9   the four close lines at its two dispatch moments
//                        collapse to two `trace close` calls (-2). seed-reqs
//                        and `cursor set` move into ONE MESSAGE, which is a
//                        round-trip saving and not a call saving - both
//                        invocations stay, and this count is not where that
//                        saving shows.
//   context.md  6 -> 6   its one dispatch moment's two alternative close lines
//                        collapse to one `trace close` (-1); folding
//                        `planning.commit_docs` into the existing `config.mjs
//                        get` adds a KEY and no call (0); and the phase's own
//                        `criteria-size` call at the end of write_context is a
//                        NEW invocation (+1).
//
// Derivations have been made FROM those figures since, and each is stated the
// same way rather than folded into them - a row that absorbed later arithmetic
// would stop showing which phase spent which call:
//
//   plan.md     9 -> 11  RBK-01's two read-back count points are NEW
//                        invocations (+2): `cite-count --point planned` at
//                        count_planned and `cite-count --point committed` at
//                        count_committed. The `--inline` path adds NEITHER - it
//                        references those two steps instead of restating their
//                        calls, which is what keeps this +2 and not +4.
//   plan.md    11 -> 12  CEN-02's plan-time census gate is a NEW invocation
//                        (+1): `lease-check --phase {N} --plan <k> --plan-time`
//                        at check_census, fired after the plan is on disk and
//                        before any executor is dispatched, so a plan whose
//                        `files:` lease would invalidate a hand-maintained
//                        count is refused while the lease is still cheap to
//                        amend. The `--inline` path adds NOTHING - it
//                        references that step instead of restating the call,
//                        which is what keeps this +1 and not +2.
//   plan.md    14 -> 15  the testing policy's `test-policy check` at parse is a
//                        NEW invocation (+1), run only when `testing.scope` is
//                        set. Adding `testing.scope` to parse's wrapped
//                        `config.mjs get` adds a KEY and no call (0), and the
//                        `--inline` path adds NOTHING - it points at the
//                        spawn_planner block instead of restating the call.
//   plan.md    15 -> 16  the code map's `codemap scan` at spawn_planner is a NEW invocation (+1), made once and only when
//                        `planning.code_map` is true. Adding `planning.code_map` to parse's wrapped `config.mjs get`
//                        adds a KEY and no call (0), and the gaps and revision modes reuse the prompt and so scan
//                        nothing a second time.
//   plan.md    16 -> 17  the brief check's `brief --phase {N} --plan <k>` at check_brief is a NEW invocation (+1), written
//                        once and run once per plan file, only when `planning.workflow_plans` is true. The key rode parse's
//                        wrapped `config.mjs get` already (0), and the `--inline` path never reaches the step, so it adds
//                        nothing.
//   plan.md    17 -> 18  the planner's phase input `brief --phase {N} --role phase --out-dir` at spawn_planner is a NEW
//                        invocation (+1), made once per run and only when `planning.workflow_plans` is true. Every later
//                        site that names the input - check_gate, review, the revision re-dispatch - references that call
//                        and never spells it again, so it adds nothing.
//   context.md  6 -> 8   the workflow branch of `analyze` (v3.12, D-01) spells two NEW invocations (+2): `config.mjs
//                        workflow-layers` for the both-layer read and `planning.mjs workflow-run --analyzer` on the
//                        notice. Both sit on a branch that is off by default; the old path's six are untouched, and the
//                        branch adds no call to it.
//   context.md  8 -> 9   the same branch claims before it launches (D-02): `planning.mjs workflow-claim take` is the
//                        ninth. Its release is named in backticks and is not a counted call.
//   context.md  9 -> 6   the analyzer runs as one agent on every path (Phase 2, D-01), so the workflow branch is gone
//                        and takes its three calls with it (-3): `config.mjs workflow-layers`, `workflow-run
//                        --analyzer` and `workflow-claim take`. What is left is the six the old path had.
//   context.md  6 -> 7   the analyzer's code map scan (Phase 3, D-23) is a NEW invocation (+1): `codemap scan` in `analyze`,
//                        made once and only when `planning.code_map` is true. Adding the key to `spend_gate`'s wrapped
//                        `config.mjs get` adds a KEY and no call (0), and the skip arm never enters `analyze`.
//
// The plan this file was written under - v3.3.0 phase 4's `PLAN-2`, task 6, at
// `.planning/_archive-v3.3.0/4/PLAN-2.md` - stated 5 for `context.md`. That
// figure omits the +1 its own task 3 mandates - the criteria-ceilings call -
// and 5 is unreachable while that call exists. 6 is not "whatever the tree
// says" either: skipping the close collapse, or reading
// `planning.commit_docs` in a second call, would each make it 7, so the row
// still reddens on every half-done version of this phase's work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

// The SHIPPED invocation spelling, and only it: a `${CLAUDE_PLUGIN_ROOT}`-rooted
// `node` call on a script under cadence-core/bin. Prose naming a subcommand in
// backticks is not a call, and counting one would make a row fail on
// documentation that is exactly right.
const INVOCATION_G = /node "\$\{CLAUDE_PLUGIN_ROOT\}\/cadence-core\/bin\/[a-z-]+\.mjs"/g;

/**
 * How many seam invocations `text` instructs.
 *
 * Shell line continuations are joined FIRST, the way trace.test.mjs's own
 * census does, so a wrapped multi-key `config.mjs get` counts as ONE call and
 * not as several - which matters here more than anywhere, because batching keys
 * onto one wrapped call is exactly the change this census measures.
 * @param {string} text @returns {number}
 */
function seamCalls(text) {
  return (text.replace(/\\\r?\n\s*/g, ' ').match(INVOCATION_G) || []).length;
}

/** Each row: the surface, its derived count, and what a failure means. */
const CENSUS = [
  {
    file: join('cadence-core', 'workflows', 'context.md'),
    calls: 7,
    note: 'cursor get, the batched config.mjs get, recall, trace close, '
      + 'criteria-size, cursor set, plus the code map\'s `codemap scan` in analyze '
      + '(+1; its `planning.code_map` key rides the spend_gate batch). An eighth means a call came back - most '
      + 'likely a second config.mjs get at the commit step, which is the '
      + 'round-trip task 4 removed by folding planning.commit_docs into the '
      + 'spend_gate batch.',
  },
  {
    file: join('cadence-core', 'workflows', 'plan.md'),
    calls: 18,
    note: 'status, config.mjs get, plan-size x2, recall, trace close x2, '
      + 'seed-reqs, cursor set (9), plus RBK-01\'s two read-back count points - '
      + '`cite-count --point planned` at count_planned and `cite-count --point '
      + 'committed` at count_committed (+2) - plus CEN-02\'s plan-time census '
      + 'gate, `lease-check --plan-time` at check_census (+1), plus the two '
      + 'dispatch-site `route.mjs resolve` calls, one at spawn_planner and one '
      + 'at spawn_checker (+2). Two read-back '
      + 'points, not one: a checker revision and an applied adjudicated '
      + 'survivor both edit the plan between them, so one count would describe '
      + 'a plan that no longer exists. And one census gate, not two: '
      + 'inline_plan REFERENCES check_census and those two count steps rather '
      + 'than restating their calls, which is what holds this at 14 and not 17. '
      + 'The fifteenth is the testing policy\'s `test-policy check` at parse, '
      + 'the one new invocation that policy adds (+1; its `testing.scope` key '
      + 'rides the existing config.mjs get). '
      + 'The resolve pair moved this row from 12 on 2026-08-25 (`08100808`) and '
      + 'added NO round-trip, which is the measurement that justifies the '
      + 're-pin: both sites already instructed the resolve in prose and already '
      + 'carried their `--bracket-read` inline, and that commit only wrote the '
      + 'four-line command form at each site so the caller stops grepping '
      + 'seams.md to recover it. This counter reads literal command blocks, so '
      + 'what moved the number is a call that became literal, not a call that '
      + 'was added. '
      + 'The sixteenth is the code map\'s `codemap scan` at spawn_planner (+1; '
      + 'its `planning.code_map` key rides the existing config.mjs get, and a '
      + 'gaps or revision dispatch scans nothing a second time). '
      + 'The seventeenth is the brief check\'s `brief` at check_brief (+1; its '
      + '`planning.workflow_plans` key rides the existing config.mjs get, and the inline path never reaches the step). '
      + 'The eighteenth is the phase input\'s `brief --role phase` at spawn_planner (+1; every later site that names '
      + 'the input references that call and never spells it again). '
      + 'A nineteenth means a call came back - most likely a restated count or '
      + 'a restated census call in inline_plan, a third resolve, a second scan, a restated compose, or a '
      + '`trace append` beside the seam\'s own in-code outcome event.',
  },
];

test('the census counter is not dead: it joins continuations and ignores prose', () => {
  // Every row below is vacuous if this is wrong - a counter that matched
  // nothing would report 0 for a file with ten calls and only ever fail loud,
  // but one that matched a WRAPPED call twice would fail on correct prose.
  const wrapped = 'node "${CLAUDE_PLUGIN_ROOT}/cadence-core/bin/config.mjs" get \\\n'
    + '  memory.backend planning.commit_docs\n';
  assert.equal(seamCalls(wrapped), 1, 'a wrapped multi-key call is ONE invocation');
  assert.equal(seamCalls(wrapped + wrapped), 2);
  assert.equal(seamCalls('Run `planning.mjs criteria-size --phase 4` at that step.'), 0,
    'a backticked mention instructs nothing and is not a call');
});

// Each row's `calls:` is a literal a human typed, so this loop is the asserting
// site of a hand-maintained census and carries the marker lib/census-registry.mjs
// joins to its row. The header's arithmetic is that number's provenance, not a
// second reading of the tree - which is what makes it a census and not the
// derived measurement the registry exempts.
// CADENCE-CENSUS: seam-call-counts | asserts: workflows/plan.md instructs exactly 18 seam invocations and workflows/context.md exactly 7
for (const row of CENSUS) {
  test(`${row.file} instructs exactly ${row.calls} seam invocations`, () => {
    const text = readFileSync(join(REPO, row.file), 'utf8');
    assert.ok(text.length > 1000, `${row.file} read as ${text.length}B - the walk found the wrong file`);
    assert.equal(seamCalls(text), row.calls,
      `${row.file} must instruct exactly ${row.calls} seam invocations on its happy path. `
      + `Expected: ${row.note} A count that moved is a round-trip added or removed, not a `
      + 'number to re-pin: re-pin this row only with the measurement that justifies it, '
      + 'the way the header derives both figures.');
  });
}

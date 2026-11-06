// Tests for lib/retired-keys.mjs - the retired-vocabulary map both config
// faces read. Run: node --test tests/retired-keys.test.mjs
//
// ONE test() per row, deliberately: a table asserted inside a single test()
// with a sequential loop reports the loop's count, not the rows', so a row that
// never ran still looks green (prior-project finding, CAPTURE.md).
// Only node: builtins. The lib is pure; the model.* rows alone call `config.mjs check` to prove `set` takes the replacement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RETIRED_KEYS, retiredKeyError, retiredKeysIn } from '../cadence-core/bin/lib/retired-keys.mjs';

// --- the retired rail, pinned byte for byte (CER-01 AC4, D-03) ---------------

const RETIRED_KEYS_FILE = fileURLToPath(new URL('../cadence-core/bin/lib/retired-keys.mjs', import.meta.url));
// sha256 of lib/retired-keys.mjs, re-cut by the v3.7.12 milestone's phase 3 under
// its D-06 and D-07. Every assertion in this file reads message CONTENT, so the
// eight `risk.override.*` rows could be edited, reworded or un-retired with the
// whole suite still green - which is exactly what CER-01 AC4's "that rail is
// byte-identical" claims nothing checks.
//
// THE DECISION BEHIND THIS PIN'S CURRENT VALUE, so a reader knows what the last
// deliberate edit was and does not mistake it for a drift: phase 3 of v3.7.12
// deleted `stakes` from config.schema.json, and D-06 pairs that deletion with a
// `stakes` row HERE - a config that skipped the migration has to meet a message
// naming the roles block, not the generic `unknown key` a silent schema gives.
// D-07 rode the same edit: `model.profile` pointed at `stakes`, so leaving it
// alone would have sent a user to `config.mjs set stakes=...`, a write this very
// map then refuses. Both rows, and the `model.auto.escalate_on_failure` detail
// that named the deleted level, are what moved the digest off
// `a9b330531fb0ce70a51879c0ca39a582de9616c9004ffa4085d8efeb49429c8a`.
//
// The digest then moved a SECOND time inside the same phase, off
// `fdfe6df6a5bf82d151f3e74829c5dd95b8a02143b0729e485b1f6c84a1aec317`, for one
// reason and no other: the milestone was relabelled from v4.0.0 to v3.7.12
// partway through, with 4.0.0 reserved for a later rewrite, so the `stakes`
// row's `since` said a version that will never ship. That edit is a version
// string, not a decision about which keys are retired - D-03 is untouched by it.
//
// And a THIRD time, off
// `ee1ac81cb37342b114a71ffc3d98d9a6cd37b2ad96bcbab35b6926e33d58ac72`, for a
// reason that is not a decision either: the same phase's prose sweep reworded
// ONE header COMMENT in lib/retired-keys.mjs - the line citing a routing data
// table that phase 3 deleted - and a comment is bytes like any other. No row,
// no `replacement`, no `since` and no `detail` moved with it. This is what the
// pin costs and what it is worth: a comment edit has to be declared here in the
// same commit, and in exchange nothing can edit a ROW without being seen.
//
// A FOURTH time, off
// `0b64617d291fa189e91c8249a46cef8b89af73adb5c9fda525c15fb2e8fffff9`, by
// decision: John dropped the Codex executor and the codex exec review transport
// before 3.9.0 shipped, and the five `roles.cad-executor.codex.*` keys and
// `review.providers.openai.transport` joined this map in the commits that took
// them out of the schema, so a config that still holds one (Baley's did) meets
// a message naming the fix instead of a key read silently for nothing.
//
// A FIFTH time, off
// `5e30c5d3da87dcf44742366e23718dabaec318f3d72049a194071eaf81718279`, by decision: TST-06 (v3.11.1, phase 1) retired
// the four legacy test switches, `workflow.test_attack`, `workflow.test_evidence`,
// `workflow.check_inspection` and `workflow.independent_rerun`, with the evidence,
// inspection and re-run steps they gated. Their four rows joined this map in the
// commit that took them out of the schema and ended the read-false override, so a
// config that still holds one meets a message naming `/cad-config --testing` and
// both `config.mjs unset` commands instead of a key read silently for nothing. The
// header comment's row count moved with them.
//
// A SIXTH time, off
// `67e92e408f0e0a6c7f22222e15462e044cfb04893d6f0f93c41ea3ee22ecf55b`, with every row's value unchanged:
// SonarCloud failed the four legacy switch rows as duplication, because they differ
// only in their key, so they now share one builder.
//
// A SEVENTH time, off
// `bf8ffa275bd8d0f990e4a99d1bac9a0ec35ce7ed9eaefc9e7125ac892823c920`, by decision: John asked for every comment in
// the plugin to be rewritten shorter and in his voice, so the header and row comments in lib/retired-keys.mjs were
// rewritten. No row's key, `replacement`, `since` or `detail` moved with them.
//
// An EIGHTH time, off
// `f3fcc60a98ad9e863160549968912302710a7b3c260add1714a32dc908e59878`, by decision: John said "shorten the comments", so
// the header comment in lib/retired-keys.mjs was cut shorter. No row's key, `replacement`, `since` or `detail` moved.
//
// A NINTH time, off
// `027bdec35a9400fe7053dc6abc045f19b211b5e4fe9a257c96316105ac1414d9`, by decision: John picked "Retire model.*, move one (Recommended)", so the twelve
// `model.overrides.<role>` and `model.effort.<role>` keys joined this map in the commit that took them out
// of the schema. Each row names its `roles.<role>.model` or `roles.<role>.effort` replacement, and all
// twelve share one builder beside the legacy switch one.
const RETIRED_KEYS_SHA256 = '6ab43ed62b3e829b53414b6ffcd72f1d1dbafe3708d8b27b6886415c67a9444a';

test('lib/retired-keys.mjs is byte-identical - the eight risk.override.* keys stay retired', () => {
  // WHAT THIS PROTECTS. D-03 keeps the retired family retired because a key
  // cannot live in config.schema.json and the retired registry at once, so
  // CER-01 gives the floor back through a NEW key - `waive_routing_floor` inside
  // `review.triggers.risk_surface` - rather than by reviving these. Un-retiring
  // one would put the same name in both places and make the write face refuse a
  // key the schema advertises. `stakes` is the same rule running the other way:
  // it left the schema in v3.7.12 and joined this map in the same commit, and it
  // may not be in both.
  //
  // WHAT TO DO WHEN THIS GOES RED: re-read D-03 before re-pinning. A deliberate
  // edit to that file is a DECISION, not a refresh, and updating the constant to
  // whatever the file now hashes to is how the decision gets reversed by
  // somebody who never read it.
  //
  // AND ONE THING THE PIN DELIBERATELY FREEZES IN A FALSE STATE: the eight
  // `detail` strings still say "there is no floor for a waiver to lower". That
  // stopped being true when the plan-time floor landed, and this milestone's
  // waiver key makes it false twice over. D-03 locks the file anyway; the
  // sentence stands, and the fix is a decision to take, not a byte to change
  // under this test. Phase 3 re-cut the digest for the `stakes` and
  // `model.profile` rows and deliberately left those eight strings untouched.
  const sha = createHash('sha256').update(readFileSync(RETIRED_KEYS_FILE)).digest('hex');
  assert.equal(sha, RETIRED_KEYS_SHA256,
    'cadence-core/bin/lib/retired-keys.mjs changed. CER-01 D-03 locks this file: '
    + 'the eight risk.override.* keys stay retired and the floor is waived '
    + 'through review.triggers.risk_surface.waive_routing_floor instead. '
    + 'Re-read D-03 before re-pinning this digest.');
});

// --- retiredKeyError: the write face ------------------------------------------

test('model.profile points at the roles block, not at a key the write face refuses', () => {
  // D-07. It used to render `use "stakes" instead`, and `stakes` is retired as
  // of v3.7.12 - so the message sent a user to `config.mjs set stakes=...`, which
  // this same map then refuses. A retirement pointer that lands on another
  // retirement is worse than no pointer: it costs the user a second round trip
  // to learn the first answer was dead.
  const e = retiredKeyError('model.profile');
  assert.doesNotMatch(e, /use "stakes"/);
  assert.doesNotMatch(e, /use "/);            // nothing one-to-one took its place
  assert.match(e, /roles\.<role>\.model/);
  assert.match(e, /roles\.<role>\.effort/);
  assert.match(e, /\/cad-config --roles/);    // the migration that writes them
});

test('stakes reads as a v3.7.12 retirement naming the roles block and the interview', () => {
  // D-06. The whole point of the entry: a config that skipped the migration
  // meets a message naming its replacement instead of the generic `unknown key`
  // the schema's silence would otherwise produce.
  const e = retiredKeyError('stakes');
  assert.match(e, /^retired in v3\.7\.12: /);
  assert.match(e, /roles\.<role>\.model/);
  assert.match(e, /roles\.<role>\.effort/);
  assert.match(e, /\/cad-config --roles/);
  // and the seam that actually removes the key from the file, named so the
  // remediation needs no lookup - workflows/config.md forbids a hand edit.
  assert.match(e, /config\.mjs unset stakes/);
  assert.doesNotMatch(e, /use "/);            // no single key replaces a level
});

test('model.auto.escalate_on_failure names the promoted key', () => {
  assert.match(retiredKeyError('model.auto.escalate_on_failure'),
    /use "model\.escalate_on_failure"/);
});

test('model.auto.ceiling reads as a removal, naming no replacement key', () => {
  const e = retiredKeyError('model.auto.ceiling');
  assert.match(e, /retired in v2\.0\.0/);
  assert.match(e, /removed with the `auto` mode/);
  assert.doesNotMatch(e, /use "/);   // nothing took its place
});

test('model.auto.max_escalations reads as a removal, naming no replacement key', () => {
  const e = retiredKeyError('model.auto.max_escalations');
  assert.match(e, /retired in v2\.0\.0/);
  assert.match(e, /retry rung its own routing cell names/); // why there is no second step to cap
  assert.doesNotMatch(e, /use "/);
});

test('a live key is not retired: granularity and workflow.research both return null', () => {
  // `stakes` was this row's first sample until v3.7.12 retired it; the row still
  // needs a key the schema DOES hold, or it stops distinguishing anything.
  assert.equal(retiredKeyError('granularity'), null);
  assert.equal(retiredKeyError('workflow.research'), null);
});

test('a non-string key never throws and is not retired', () => {
  for (const k of [undefined, null, 5, {}, ['model.profile']]) {
    // @ts-expect-error - deliberately off-grammar input
    assert.equal(retiredKeyError(k), null, String(k));
  }
});

test('RETIRED_KEYS is frozen, so a caller cannot edit the shared map', () => {
  assert.equal(Object.isFrozen(RETIRED_KEYS), true);
  assert.equal(Object.isFrozen(RETIRED_KEYS['model.profile']), true);
});

test('review.triggers.pre_ship.gate reads as a removal naming the milestone', () => {
  const e = retiredKeyError('review.triggers.pre_ship.gate');
  assert.match(e, /retired in v3\.2\.0/);
  assert.match(e, /risk_surface/);          // what still gates the close
  assert.doesNotMatch(e, /use "/);          // nothing took its place
});

test('review.triggers.pre_ship.tier and .effort each name v3.2.0 too', () => {
  for (const k of ['review.triggers.pre_ship.tier', 'review.triggers.pre_ship.effort']) {
    assert.match(retiredKeyError(k), /retired in v3\.2\.0/, k);
  }
});

// --- the four legacy test switches (v3.11.1, TST-06) --------------------------

/**
 * One row's contract: retired in v3.11.1, no replacement key, and a detail that
 * names the interview and both unset commands for that exact key.
 * @param {string} key
 */
function assertLegacySwitchRow(key) {
  const e = retiredKeyError(key);
  assert.match(e, /^retired in v3\.11\.1: /);
  assert.doesNotMatch(e, /use "/);
  assert.ok(e.includes('/cad-config --testing'));
  assert.ok(e.includes(`config.mjs unset ${key} `) || e.includes(`config.mjs unset ${key}\``));
  assert.ok(e.includes(`config.mjs unset --global ${key}`));
  const w = retiredKeysIn(Object.fromEntries([[key.split('.')[0], { [key.split('.')[1]]: false }]]));
  assert.equal(w.length, 1, JSON.stringify(w));
  assert.match(w[0], /was retired in v3\.11\.1 and is ignored/);
}

test('workflow.test_attack is retired in v3.11.1 and its detail names both unset commands', () => {
  assertLegacySwitchRow('workflow.test_attack');
});

test('workflow.test_evidence is retired in v3.11.1 and its detail names both unset commands', () => {
  assertLegacySwitchRow('workflow.test_evidence');
});

test('workflow.check_inspection is retired in v3.11.1 and its detail names both unset commands', () => {
  assertLegacySwitchRow('workflow.check_inspection');
});

test('workflow.independent_rerun is retired in v3.11.1 and its detail names both unset commands', () => {
  assertLegacySwitchRow('workflow.independent_rerun');
});

// --- the twelve per-role model.* fallbacks (v4.0.0) --------------------------

const CONFIG = fileURLToPath(new URL('../cadence-core/bin/config.mjs', import.meta.url));

/**
 * One row's contract: retired in v4.0.0, the error renders the roles replacement and both unset commands, the
 * read face warns once, and `config.mjs check` accepts the replacement, so the text never points at a refused write.
 * @param {string} key
 * @param {string} replacement
 */
function assertModelRow(key, replacement) {
  const e = retiredKeyError(key);
  assert.match(e, /^retired in v4\.0\.0: /);
  assert.ok(e.includes(`use "${replacement}" instead`), e);
  assert.ok(e.includes(`config.mjs unset ${key}`), e);
  assert.ok(e.includes(`config.mjs unset --global ${key}`), e);
  const [a, b, c] = key.split('.');
  const w = retiredKeysIn({ [a]: { [b]: { [c]: null } } });
  assert.equal(w.length, 1, JSON.stringify(w));
  assert.match(w[0], /was retired in v4\.0\.0 and is ignored/);
  const checked = JSON.parse(execFileSync('node', [CONFIG, 'check', `${replacement}=null`], { encoding: 'utf8' }));
  assert.deepEqual(checked, { ok: true }, replacement);
}

test('model.overrides.cad-planner is retired in v4.0.0 and names roles.cad-planner.model', () => {
  assertModelRow('model.overrides.cad-planner', 'roles.cad-planner.model');
});

test('model.overrides.cad-assumptions-analyzer is retired in v4.0.0 and names roles.cad-assumptions-analyzer.model', () => {
  assertModelRow('model.overrides.cad-assumptions-analyzer', 'roles.cad-assumptions-analyzer.model');
});

test('model.overrides.cad-verifier is retired in v4.0.0 and names roles.cad-verifier.model', () => {
  assertModelRow('model.overrides.cad-verifier', 'roles.cad-verifier.model');
});

test('model.overrides.cad-reviewer is retired in v4.0.0 and names roles.cad-reviewer.model', () => {
  assertModelRow('model.overrides.cad-reviewer', 'roles.cad-reviewer.model');
});

test('model.overrides.cad-executor is retired in v4.0.0 and names roles.cad-executor.model', () => {
  assertModelRow('model.overrides.cad-executor', 'roles.cad-executor.model');
});

test('model.overrides.cad-plan-checker is retired in v4.0.0 and names roles.cad-plan-checker.model', () => {
  assertModelRow('model.overrides.cad-plan-checker', 'roles.cad-plan-checker.model');
});

test('model.effort.cad-planner is retired in v4.0.0 and names roles.cad-planner.effort', () => {
  assertModelRow('model.effort.cad-planner', 'roles.cad-planner.effort');
});

test('model.effort.cad-assumptions-analyzer is retired in v4.0.0 and names roles.cad-assumptions-analyzer.effort', () => {
  assertModelRow('model.effort.cad-assumptions-analyzer', 'roles.cad-assumptions-analyzer.effort');
});

test('model.effort.cad-verifier is retired in v4.0.0 and names roles.cad-verifier.effort', () => {
  assertModelRow('model.effort.cad-verifier', 'roles.cad-verifier.effort');
});

test('model.effort.cad-reviewer is retired in v4.0.0 and names roles.cad-reviewer.effort', () => {
  assertModelRow('model.effort.cad-reviewer', 'roles.cad-reviewer.effort');
});

test('model.effort.cad-executor is retired in v4.0.0 and names roles.cad-executor.effort', () => {
  assertModelRow('model.effort.cad-executor', 'roles.cad-executor.effort');
});

test('model.effort.cad-plan-checker is retired in v4.0.0 and names roles.cad-plan-checker.effort', () => {
  assertModelRow('model.effort.cad-plan-checker', 'roles.cad-plan-checker.effort');
});

// --- retiredKeysIn: the read faces --------------------------------------------

test('a config that set the pre-ship gate gets a v3.2.0 warning, not unrecognized-key', () => {
  // This repo's own .planning/config.json carried `review.triggers.pre_ship.gate`
  // until the trigger was deleted, so the upgrade path is not hypothetical.
  const w = retiredKeysIn({ review: { triggers: { pre_ship: { gate: 'off' } } } });
  assert.equal(w.length, 1, JSON.stringify(w));
  assert.match(w[0], /review\.triggers\.pre_ship\.gate/);
  assert.match(w[0], /v3\.2\.0/);
});

test('a config still holding model.profile warns exactly once, naming the roles block', () => {
  const w = retiredKeysIn({ model: { profile: 'balanced' } });
  assert.equal(w.length, 1);
  assert.match(w[0], /model\.profile/);
  assert.match(w[0], /roles\.<role>\.model/);
  assert.match(w[0], /\/cad-config --roles/);
});

test('a config still carrying stakes warns on the read face with the same pointer', () => {
  // AC2's diagnostic half: every read face folds `retiredKeysIn` onto the
  // warnings it already carries, so a project that has not run the migration is
  // told what to do on its next command rather than at some later failure.
  const w = retiredKeysIn({ stakes: 'critical' });
  assert.equal(w.length, 1, JSON.stringify(w));
  assert.match(w[0], /^config key "stakes" was retired in v3\.7\.12 and is ignored: /);
  assert.match(w[0], /roles\.<role>\.model/);
  assert.match(w[0], /roles\.<role>\.effort/);
  assert.match(w[0], /\/cad-config --roles/);
  assert.match(w[0], /config\.mjs unset stakes/);
});

test('the presence of the key is the fault, whatever value it holds', () => {
  // D-09: a retired KEY fails worse than a retired value - it resolves at the
  // default and reports a configured layer. So the check is value-agnostic.
  for (const v of [null, false, 0, '', 'balanced']) {
    assert.equal(retiredKeysIn({ model: { profile: v } }).length, 1, JSON.stringify(v));
  }
});

test('two retired auto keys yield two warnings, one each', () => {
  const w = retiredKeysIn({ model: { auto: { ceiling: 'quality', max_escalations: 1 } } });
  assert.equal(w.length, 2, JSON.stringify(w));
  assert.match(w.join(' '), /model\.auto\.ceiling/);
  assert.match(w.join(' '), /model\.auto\.max_escalations/);
});

test('a live config warns about nothing', () => {
  // The sample moved off `stakes` when v3.7.12 retired it: a config carrying it
  // is now the warning case two rows up, so leaving it here would have asserted
  // the opposite of what this row is for.
  assert.deepEqual(retiredKeysIn({
    granularity: 'standard',
    model: { escalate_on_failure: true },
    roles: { 'cad-executor': { model: 'opus', effort: 'high' } },
  }), []);
});

test('a scalar at an intermediate segment yields no match and no throw', () => {
  assert.deepEqual(retiredKeysIn({ model: 5 }), []);
  assert.deepEqual(retiredKeysIn({ model: { auto: 'yes' } }), []);
  assert.deepEqual(retiredKeysIn({ model: null }), []);
});

test('an array at an intermediate segment yields no match and no throw', () => {
  assert.deepEqual(retiredKeysIn({ model: ['profile'] }), []);
  assert.deepEqual(retiredKeysIn({ model: { auto: ['ceiling'] } }), []);
});

test('a null or non-object config yields an empty list', () => {
  assert.deepEqual(retiredKeysIn(null), []);
  assert.deepEqual(retiredKeysIn(undefined), []);
  assert.deepEqual(retiredKeysIn([1, 2]), []);
  assert.deepEqual(retiredKeysIn(42), []);
  assert.deepEqual(retiredKeysIn('model.profile'), []);
});

// --- ARG-05: a prototype member is not a retirement ---------------------------

test('every Object.prototype member reads as not-retired, never as a v2.0.0 removal', () => {
  // RETIRED_KEYS is a plain frozen object, so a bare `RETIRED_KEYS[key]` answered
  // any of these with Object.prototype itself - truthy, with `since`,
  // `replacement` and `detail` all undefined - and `config.mjs check
  // '__proto__=1'` reported `retired in v2.0.0: undefined`. That is a WRONG
  // diagnostic rather than a missing one: it names a retirement that never
  // happened and sends the user looking for a replacement.
  //
  // The set is WALKED rather than hand-listed (D-13): `__defineGetter__` and its
  // three siblings sit beside the obvious `constructor` / `toString` / `valueOf`,
  // and a hand-list is how the next member the language adds stops being covered.
  const members = Object.getOwnPropertyNames(Object.prototype);
  assert.ok(members.length >= 12, JSON.stringify(members));
  for (const k of members) assert.equal(retiredKeyError(k), null, k);
});

test('the guard costs the vocabulary nothing: a real retirement still reports since, replacement and detail', () => {
  // CONTEXT's flagged assumption, settled: `Object.hasOwn` changes nothing for a
  // key that IS retired, because every row is an own property of the frozen
  // literal. Checked on a row carrying all three fields at once - a non-default
  // `since` would have read as v2.0.0, and a dropped `detail` as `undefined`.
  const withReplacement = retiredKeyError('model.auto.escalate_on_failure');
  assert.match(withReplacement, /^retired in v2\.0\.0: /);          // its own since
  assert.match(withReplacement, /use "model\.escalate_on_failure" instead/);
  assert.match(withReplacement, /honoured on every dispatch/);       // its own detail
  assert.doesNotMatch(withReplacement, /undefined/);

  // And a row whose `since` is NOT the v2.0.0 default, with no replacement.
  const removed = retiredKeyError('workflow.subagent_timeout');
  assert.match(removed, /^retired in v2\.7\.0: /);
  assert.match(removed, /workflow\.max_plan_tasks/);                 // its own detail
  assert.doesNotMatch(removed, /undefined/);
});

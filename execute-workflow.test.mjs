// Zero-dep tests for the workflow arm of references/worktree-executor.md. Run: node --test tests/execute-workflow.test.mjs
// The defects are today's worktree executor reading changed rules, an executor committing its report or marking it
// complete before the merge, and an executor deleting a branch that holds earlier work.
// The second half pins the main session's side of the path: references/execute-workflow.md and choose_path (Phase 5, plan 5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const text = readFileSync(join(REPO, 'cadence-core', 'references', 'worktree-executor.md'), 'utf8');
const MARK = '\n## Workflow arm\n';
const at = text.indexOf(MARK);
const today = text.slice(0, at);
const arm = text.slice(at + 1);
const flat = (s) => s.replace(/\s+/g, ' ');

test('workflow arm: the file above the new section is today\'s text byte for byte, its five bullets included', () => {
  assert.ok(at > 0, 'the section exists');
  assert.equal(today.split('\n').filter((l) => l.startsWith('- ')).length, 5);
  // the sha-256 of worktree-executor.md as it stood before the arm was added
  assert.equal(createHash('sha256').update(today).digest('hex'),
    '5ba9daf22cb1101330d50a781850acb95e75fffa82a59291e31e8d05eb2f90ee');
});

test('workflow arm: its mode line differs from today\'s, says worktree, and names the branch', () => {
  const m = flat(arm).match(/mode line reads exactly "([^"]+)"/);
  assert.ok(m, 'the section writes its mode line out');
  assert.notEqual(m[1], 'Worktree executor on branch {branch} - worktree rules apply.');
  assert.match(m[1], /worktree mode/);
  assert.ok(m[1].includes('`cadence/phase-<N>-plan-<k>`'));
});

test('workflow arm: the branch is created first, an existing non-current one halts untouched, and the lease reads the main tree', () => {
  const a = flat(arm);
  assert.match(a, /create `cadence\/phase-<N>-plan-<k>` from the worktree's HEAD/);
  assert.match(a, /before anything else/);
  assert.match(a, /Already the current branch -> the host restarted you/);
  assert.match(a, /Exists but is not current -> HALT `blocked` naming it and its head; never delete, reset or force it/);
  assert.match(a, /`lease-check` with `--dir <main tree>\/\.planning`/);
});

test('workflow arm: the report goes to the scratch path the prompt names, nothing is written into the main tree, and it is never committed', () => {
  const a = flat(arm);
  assert.match(a, /in the run's scratch directory\. Never write into the main tree/);
  assert.match(a, /goes to the path the prompt names, in place of `<plandir>\/reports\/plan-<k>\.md`, and you NEVER commit it/);
  assert.match(a, /only after it has merged your branch/);
  assert.match(a, /ABSOLUTE paths outside the worktree, never relative to it/);
});

// --- the main session's side: the reference, choose_path, the notice and the stops ----------------------------------

const REF = readFileSync(join(REPO, 'cadence-core', 'references', 'execute-workflow.md'), 'utf8');
const refFlat = flat(REF);
const EXEC = readFileSync(join(REPO, 'cadence-core', 'workflows', 'execute.md'), 'utf8');
const stepBody = (name) => EXEC.slice(EXEC.indexOf(`<step name="${name}">`), EXEC.indexOf('</step>', EXEC.indexOf(`<step name="${name}">`)));
const CHOOSE = stepBody('choose_path');
const chooseFlat = flat(CHOOSE);
const TODAY = 'Sequential (default) unless ALL of these hold:';
// a section of the reference, flattened: from its heading to the next second-level heading or the end
const section = (from) => {
  const a = REF.indexOf(from);
  assert.notEqual(a, -1, `no ${from}`);
  const b = REF.indexOf('\n## ', a + from.length);
  return flat(REF.slice(a, b === -1 ? REF.length : b));
};
const LAUNCH = section('## 1. Launch one wave');

test('the launch takes the claim before the first resolve and before the launch, and reads plan-overlap before each of them', () => {
  const take = REF.indexOf('workflow-claim take');
  const overlap = REF.indexOf('planning.mjs" plan-overlap');
  const resolve = REF.indexOf('--bracket-plan');
  const launch = REF.indexOf('cadence:execute-wave');
  assert.ok(take > 0 && take < overlap && overlap < resolve && resolve < launch, 'claim, then plan-overlap, then resolve, then launch');
  assert.match(LAUNCH, /Take it before any resolve below, so a lost claim leaves no dispatch open/);
  assert.match(LAUNCH, /Ask `plan-overlap` again, never from a list held since `choose_path`/);
  assert.match(LAUNCH, /in the dispatch set `locate` defined that are not already done in this run/);
  assert.match(LAUNCH, /A plan stopped by an earlier wave holds the next wave/);
});

test('the launch resolves each plan on its own with the bracket-read the stretch states, and falls back to the script path', () => {
  assert.match(LAUNCH, /--role cad-executor --attempt 1 --phase <N> --plan <k> --bracket-plan <k> --bracket-read "CLAUDE\.md,<the brief path>"/);
  assert.match(LAUNCH, /because the risk floor differs by plan/);
  assert.match(LAUNCH, /If the name does not resolve, launch it with `scriptPath` set to `\$\{CLAUDE_PLUGIN_ROOT\}\/workflows\/execute-wave\.js`/);
  assert.match(LAUNCH, /"batch_size": <parallelization\.max_concurrent_agents>/);
  assert.match(LAUNCH, /keep both, and end the turn/);
});

test('the launch names the main-tree flag and the scratch report path above width 1, and the pre-plan HEAD and the restart sentence in every prompt', () => {
  assert.match(LAUNCH, /Above width 1 add `--main-root <the main tree's root>`/);
  assert.match(LAUNCH, /every `\.planning\/` path the prompt names is the main tree's absolute path/);
  assert.match(LAUNCH, /`<the scratch directory>\/reports\/plan-<k>\.md`/);
  assert.match(LAUNCH, /Add the pre-plan HEAD and this sentence: the host may restart the executor with this same prompt, so any commit after that HEAD in this plan's scope is its own earlier work to continue from and never redo/);
  assert.match(LAUNCH, /At width 1 it is "Sequential executor on the normal working tree\."/);
});

test('the prompt\'s workflow mode line is the one worktree-executor.md writes, byte for byte', () => {
  const theirs = flat(arm).match(/mode line reads exactly "([^"]+)"/)[1];
  const ours = REF.match(/^ {2}"(Workflow worktree executor[^\n]*)"$/m);
  assert.ok(ours, 'the reference writes the line out on a line of its own');
  assert.equal(ours[1], theirs);
});

test('a refused launch releases the claim, closes each opened bracket as an escalation and goes to today\'s path', () => {
  assert.match(LAUNCH, /A launch the host refuses releases the claim at once/);
  assert.match(LAUNCH, /--event escalation --plan <k> --role cad-executor/);
  assert.match(LAUNCH, /run the rest of the phase on today's sequential path/);
  assert.ok(REF.indexOf('workflow-claim release --fire execute-<N>-wave-<j>') > REF.indexOf('cadence:execute-wave'));
});

test('cad-execute allows the wave script and its workflow step reads the reference by its full path', () => {
  const skill = readFileSync(join(REPO, 'skills', 'cad-execute', 'SKILL.md'), 'utf8');
  assert.match(skill, /^ {2}- Workflow\(cadence:execute-wave\)$/m);
  const step = flat(stepBody('execute_workflow'));
  assert.match(step, /Read `\$\{CLAUDE_PLUGIN_ROOT\}\/cadence-core\/references\/execute-workflow\.md`/);
  assert.match(step, /\(one consult site - this step\)/);
});

// --- choose_path -----------------------------------------------------------------------------------------------

test('choose_path reads the switch through workflow-layers and no config get in execute.md names it', () => {
  assert.match(chooseFlat, /config\.mjs" workflow-layers/);
  assert.match(chooseFlat, /`workflow\.execute_workflows` is on in BOTH config layers/);
  assert.match(chooseFlat, /never with `config\.mjs get`/);
  // a get call runs from its line to the closing fence or a blank line
  for (const m of EXEC.matchAll(/config\.mjs" get[^\n]*(?:\n(?!```|\n)[^\n]*)*/g)) {
    assert.doesNotMatch(m[0], /workflow\.execute_workflows/);
  }
});

test('choose_path names every condition of the workflow path and what stops routing to sequential', () => {
  const head = chooseFlat.slice(0, chooseFlat.indexOf(TODAY));
  for (const part of ['`planning.workflow_plans` is true', 'the `Workflow` tool is in this session\'s tool list', '`ok:true`', '`undeclared`',
    '`frontmatter_issues`', '`parallelization.enabled` and `parallelization.use_worktrees` are both true']) {
    assert.ok(head.includes(part), `${part} is not named`);
  }
  assert.match(head, /an `overlaps` entry and a second wave do not route to sequential, because `waves` already order them/);
  assert.match(head, /`parallelization\.min_plans_for_parallel` is not read/);
  assert.match(head, /declining its fix or its `ok:false` means today's path/);
  assert.match(head, /go to `execute_workflow`/);
});

test('choose_path sends an all-width-1 phase to today\'s path with a line saying why, and prints nothing with neither layer setting the switch', () => {
  const head = chooseFlat.slice(0, chooseFlat.indexOf(TODAY));
  assert.match(head, /drop every plan outside the dispatch set, and drop any wave left empty\. When every wave left holds one plan, today's path runs and one line says why/);
  assert.match(head, /when either layer sets the switch \(`repo` or `global` reads `"set"` in that answer\) one line names the missing condition\. With neither layer setting it, print nothing/);
});

test('choose_path still makes one plan-overlap call, and the part from "Sequential (default)" on is today\'s text byte for byte', () => {
  assert.equal((CHOOSE.match(/planning\.mjs" plan-overlap/g) || []).length, 1);
  const rest = CHOOSE.slice(CHOOSE.indexOf(TODAY) - 0).replace(/^\n/, '');
  // the sha-256 of choose_path's body as it stood before the workflow path was added
  assert.equal(createHash('sha256').update(CHOOSE.slice(CHOOSE.indexOf(TODAY)).replace(/^\n/, '')).digest('hex'),
    '7545544f91cbdeb888f5c8b8c0c5ead36bbab01160889fe4f37fa1408228d22c');
  assert.ok(rest.length > 2000);
});

// --- the notice ------------------------------------------------------------------------------------------------

const NOTICE = section('## 2. On the notice');

test('the notice runs workflow-run, releases the claim right after it, and writes no close for a wave executor except on notice-totals', () => {
  assert.match(NOTICE, /workflow-run --phase <N> --run-file <the run file> --out-dir <the scratch directory> --payload-ref <the scratch directory>/);
  assert.match(NOTICE, /Release the claim right after this call returns, whether it answered or refused/);
  assert.ok(REF.indexOf('workflow-claim release', REF.indexOf('## 2. On the notice')) > REF.indexOf('workflow-run --phase'));
  assert.match(NOTICE, /so no `trace close` is written for them\. One exception: when `brackets\.source` is `notice-totals`/);
  assert.match(NOTICE, /one `trace close --plan <k> --role cad-executor --detail-file <path>` call, where the file names the missing agent rows, which makes the close a `checkpoint`/);
  assert.match(NOTICE, /Relay each plan's outcome with its position line\. For each entry of `restarted`, name that plan's agent as restarted by the host/);
});

test('a wider wave Reads execute-parallel.md by its full path, follows steps 3 to 5, and merges in plan order', () => {
  assert.match(NOTICE, /Read `\$\{CLAUDE_PLUGIN_ROOT\}\/cadence-core\/references\/execute-parallel\.md` and follow steps 3 to 5 for the plans that settled/);
  assert.match(NOTICE, /Merge each plan's branch `cadence\/phase-<N>-plan-<k>` in plan order, with both HEADs recorded/);
});

test('a report moves from the scratch directory only after its branch merged, a report already there is rotated aside, and nothing in it is edited', () => {
  assert.match(NOTICE, /Once a plan's branch has merged, move its report from `<the scratch directory>\/reports\/plan-<k>\.md` into `<plandir>\/reports\/plan-<k>\.md`/);
  assert.match(NOTICE, /First rotate a report already there aside to the next free `plan-<k>\.<n>\.md`/);
  assert.match(NOTICE, /Edit nothing in the moved file/);
  assert.match(NOTICE, /A plan whose branch has not merged keeps its report in the scratch directory, so the main tree never holds a `PLAN COMPLETE` for unmerged work/);
  assert.match(NOTICE, /the `state` step's existing staging is its only commit/);
  assert.ok(NOTICE.indexOf('Once a plan\'s branch has merged') > NOTICE.indexOf('Merge each plan\'s branch'));
});

test('the suite runs after every wider wave, every plan\'s run or skip comes before any status, and a worktree is removed only if the host kept it', () => {
  assert.match(NOTICE, /The suite runs after this wave, not once at the end, because the next wave forks from this merge/);
  const risk = NOTICE.indexOf('run the skip or `risk-check run` for every settled plan first');
  assert.ok(risk > 0);
  assert.ok(risk < NOTICE.indexOf('Then each plan\'s `status`'));
  assert.ok(NOTICE.indexOf('Then the fires') > risk);
  assert.match(NOTICE, /Remove a worktree only if the host kept it/);
});

test('phase_diff fires once after the last wave with a line when it is off, and a one-plan wave follows execute_sequential', () => {
  assert.match(NOTICE, /After the last wave, fire `phase_diff` once, as step 6 of `execute-parallel\.md` states\. When its gate is `off` and a wave ran wider than 1, print one line saying the interaction of the merged plans went unreviewed/);
  assert.match(NOTICE, /### A wave of one plan It ran in the normal tree, so nothing merges/);
  assert.match(NOTICE, /The plan's range is its pre-plan HEAD to HEAD\. The risk sequence, the cursor write and the `diff` fire are `execute_sequential`'s/);
});

test('execute.md\'s writers guardrail names workflow-run, and execute-parallel.md names this reference as its second reader', () => {
  const guard = flat(EXEC.slice(EXEC.indexOf('<guardrails>')));
  assert.match(guard, /THREE writers[^]*for a wave's executors `workflow-run`'s close/);
  assert.match(flat(readFileSync(join(REPO, 'cadence-core', 'references', 'execute-parallel.md'), 'utf8')), /and a second time by `references\/execute-workflow\.md`/);
  assert.match(flat(EXEC), /ALL worktree ceremony exists inside the two opt-in branches, the parallel one and the workflow one, and nowhere else/);
});

// --- the stops -------------------------------------------------------------------------------------------------

const STOPS = section('## 3. Where a wave stops');

test('a merge conflict stops everything after it, leaves the merge in place and never runs merge --abort', () => {
  const arm = STOPS.slice(STOPS.indexOf('**A merge conflict.**'), STOPS.indexOf('**A checkpoint.**'));
  assert.match(arm, /stop with the conflicted merge left in place/);
  assert.match(arm, /Name the plan and the conflicting paths/);
  assert.match(arm, /Start no further merge, risk check, cursor write, review, SUMMARY or next wave/);
  assert.match(arm, /Headless, the run ends there and the file state is the proof/);
  const aborts = REF.match(/git merge --abort/g) || [];
  assert.equal(aborts.length, 1);
  assert.match(arm, /Never run `git merge --abort` yourself/);
});

test('a checkpoint merges the settled plans first, holds the next wave, and continues the stopped plan in the normal tree under its worker key', () => {
  const arm = STOPS.slice(STOPS.indexOf('**A checkpoint.**'), STOPS.indexOf('**A null slot'));
  assert.match(arm, /The plans that settled merge in plan order as section 2 states, and the next wave waits/);
  assert.match(arm, /Route the checkpoint as `handle_checkpoint` does/);
  assert.match(arm, /The stopped plan's branch waits for the answer and then merges, its report moving in with that merge/);
  assert.match(arm, /runs in the normal tree on today's sequential dispatch under worker key `<k>`, the way the parallel path's fix dispatch runs, never back into a worktree/);
  assert.match(arm, /replaces the closing sentence of `execute-parallel\.md`/);
});

test('a one-plan wave\'s dead slot checks git log and asks, and only a wider wave checks a branch or reads the scratch report', () => {
  const arm = STOPS.slice(STOPS.indexOf('**A null slot'), STOPS.indexOf('**A restart.**'));
  const [, one, wide] = arm.split(/ - In a wave /);
  assert.match(one, /^of one plan/);
  assert.match(one, /git log \{pre-plan HEAD\}\.\.HEAD/);
  assert.match(one, /ask whether to re-dispatch the remainder or stop/);
  assert.match(one, /under worker key `<k>`/);
  assert.doesNotMatch(one, /scratch directory|whether its branch exists/);
  assert.match(wide, /^wider than 1/);
  assert.match(wide, /read the plan's report in the scratch directory and check whether its branch exists/);
  assert.match(wide, /No branch means nothing landed and nothing merges, so its report moves in as it stands, unless it reads `PLAN COMPLETE`, which is named and left in the scratch directory/);
  assert.match(wide, /The next wave still waits for the answer/);
  assert.match(wide, /A branch is handled like a checkpoint/);
  assert.match(wide, /a remainder runs in the normal tree/);
});

test('a restarted agent is named in its plan\'s relay', () => {
  assert.match(STOPS, /\*\*A restart\.\*\* A plan whose agent the host restarted is named in that plan's relay, from `restarted` in `workflow-run`'s answer/);
});

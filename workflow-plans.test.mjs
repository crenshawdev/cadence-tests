// Pins for how /cad-execute reads plan-overlap's `waves` (Phase 4, plan 1) and the planning.workflow_plans switch (plan 2). choose_path is prose a model follows, so
// these hold what a rewrite could quietly lose; the seam half is in planning-plans.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXECUTE = readFileSync(join(ROOT, 'cadence-core', 'workflows', 'execute.md'), 'utf8');
const CHOOSE = /<step name="choose_path">([\s\S]*?)<\/step>/.exec(EXECUTE)?.[1] ?? '';
const flat = CHOOSE.replace(/\s+/g, ' ');

test('choose_path keeps the judgment clause and names depends_on', () => {
  assert.ok(CHOOSE.length > 0, 'choose_path step found');
  assert.match(flat, /no plan builds on another's output \(your judgment/);
  assert.match(flat, /valid `depends_on` entry/);
});

test('choose_path routes more than one wave to sequential', () => {
  assert.match(flat, /More than one entry in `waves` -> sequential/);
});

test('choose_path makes one plan-overlap call and no second', () => {
  assert.equal((CHOOSE.match(/planning\.mjs" plan-overlap/g) || []).length, 1);
});

// --- the switch -------------------------------------------------------------

// An ordinary boolean read through `get`, so the fixture proves both layers count.
function readSwitch(repo, global) {
  const root = mkdtempSync(join(tmpdir(), 'cad-wfplans-'));
  try {
    mkdirSync(join(root, '.planning'));
    if (repo !== undefined) writeFileSync(join(root, '.planning', 'config.json'), JSON.stringify(repo));
    const g = join(root, 'g.json');
    if (global !== undefined) writeFileSync(g, JSON.stringify(global));
    const out = execFileSync('node', [join(ROOT, 'cadence-core', 'bin', 'config.mjs'), 'get', 'planning.workflow_plans'],
      { encoding: 'utf8', cwd: root, env: { ...process.env, CADENCE_GLOBAL_CONFIG: g } });
    return JSON.parse(out).values['planning.workflow_plans'];
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('planning.workflow_plans reads false when unset and true when the repo or the global layer alone sets it', () => {
  assert.equal(readSwitch({}), false);
  assert.equal(readSwitch({ planning: { workflow_plans: true } }), true);
  assert.equal(readSwitch({}, { planning: { workflow_plans: true } }), true);
});

test('the shipped schema adds no parallelization.waves key', () => {
  assert.doesNotMatch(readFileSync(join(ROOT, 'cadence-core', 'config.schema.json'), 'utf8'), /parallelization\.waves/);
});

// --- the planner's reference ------------------------------------------------

const GRAPH = readFileSync(join(ROOT, 'cadence-core', 'references', 'plan-graph.md'), 'utf8').replace(/\s+/g, ' ');

test('plan-graph.md names the three markers and depends_on, and Reads is no lease and takes path#symbol', () => {
  for (const m of ['**Reads:**', '**Decisions:**', '**Pins:**', '`depends_on`']) assert.ok(GRAPH.includes(m), `${m} is not named`);
  assert.match(GRAPH, /comma-separated `path#symbol` entries/);
  assert.match(GRAPH, /It is not a lease/);
});

test('plan-graph.md puts anchors on Reads and not Files, and a task with nothing leaves the field out and never writes none', () => {
  assert.match(GRAPH, /any anchor your contract would carry onto a path goes on `Reads:` instead/);
  assert.match(GRAPH, /leaves that field out and never writes `none`/);
});

test('plan-graph.md holds the shared-file rule and the one-last-plan rule', () => {
  assert.match(GRAPH, /"more plans, sequential where they share files" wins over "if two slices touch the same file, they are one plan"/);
  assert.match(GRAPH, /in one last plan/);
});

test('plan-graph.md has the last plan name every earlier plan in depends_on, because waves order only on a shared file or depends_on', () => {
  assert.match(GRAPH, /That last plan names every earlier plan in `depends_on`, because `waves` orders plans only on a shared file or a `depends_on` entry/);
});

test('plan-graph.md has the planner run plan-overlap and state the width, with a reason at 1, as no gate', () => {
  assert.match(GRAPH, /planning\.mjs" plan-overlap --phase <N>/);
  assert.match(GRAPH, /return states the width, plus one line of reason when it is 1/);
  assert.match(GRAPH, /information and no gate/);
});

test('plan-graph.md has the planner fix a frontmatter_issues entry and run plan-overlap again', () => {
  assert.match(GRAPH, /A `frontmatter_issues` entry in that answer means a plan you wrote is wrong, so fix it and run it again before you return/);
});

test('plan-graph.md names no Cadence-only file, and an inline plan can read the task fields section alone', () => {
  assert.doesNotMatch(GRAPH, /tests-pin|weight-budgets\.json/);
  assert.match(GRAPH, /An inline plan reads only `## The task fields`/);
});

// --- /cad-plan: one gated block, and none of the vocabulary with the switch off ---------------------------------

const PLAN_MD = readFileSync(join(ROOT, 'cadence-core', 'workflows', 'plan.md'), 'utf8');
const OPENING = 'When `planning.workflow_plans` read in `parse` is `true`, the prompt carries a plan-graph block';
const INLINE_OPEN = 'With `planning.workflow_plans` `true`, read `references/plan-graph.md` once';
const VOCAB = /\b(?:depends_on|Pins|width|brief|wave|waves|plan-graph|workflow_plans)\b/gi; // what `grep -c -w -i` counts
const MARKERS = /\*\*(?:Reads|Decisions|Pins):\*\*/g;

const stepOf = (text, name) => {
  const start = text.indexOf(`<step name="${name}">`);
  assert.notEqual(start, -1, `no ${name} step`);
  return text.slice(start, text.indexOf('</step>', start));
};

// The gated stretch: its opening sentence to the closing fence of the block. Null when the opening sentence is gone.
function stretchOf(text) {
  const start = text.indexOf(OPENING);
  if (start === -1) return null;
  const close = '</plan_graph>\n```';
  const end = text.indexOf(close, start);
  assert.notEqual(end, -1, 'the stretch has no closing </plan_graph> fence');
  return { start, end: end + close.length };
}

// The inline sentence runs from its opening to the end of its paragraph.
function inlineOf(text) {
  const start = text.indexOf(INLINE_OPEN);
  if (start === -1) return null;
  const end = text.indexOf('\n', start);
  return { start, end };
}

// The key's own line in parse's batch is the one allowance: a switch has to be read to gate anything.
function keyLineOf(text) {
  const start = text.indexOf('planning.code_map planning.workflow_plans');
  return start === -1 ? null : { start, end: text.indexOf('\n', start) };
}

// The brief check is its own gated step: its tag to its closing tag. Null when the step is gone.
function briefStepOf(text) {
  const start = text.indexOf('<step name="check_brief">');
  return start === -1 ? null : { start, end: text.indexOf('</step>', start) + '</step>'.length };
}

// spawn_planner's phase-input stretch: its opening sentence to the paragraph that opens recall. Null when the opening is gone.
const PLANNER_OPEN = 'With `planning.workflow_plans` read in `parse` as `true`, the planner reads one composed phase input';
function plannerStretchOf(text) {
  const start = text.indexOf(PLANNER_OPEN);
  if (start === -1) return null;
  const end = text.indexOf('\n\nBefore assembling the prompt, recall', start);
  assert.notEqual(end, -1, 'the planner stretch has no end');
  return { start, end };
}

// check_gate's phase-input stretch: its opening sentence to the checker's Prompt: line. Null when the opening is gone.
const CHECKER_OPEN = 'With `planning.workflow_plans` read in `parse` as `true`, the checker reads the plan files and the phase input';
function checkerStretchOf(text) {
  const start = text.indexOf(CHECKER_OPEN);
  if (start === -1) return null;
  const end = text.indexOf('\n\nPrompt:\n', start);
  assert.notEqual(end, -1, 'the checker stretch has no end');
  return { start, end };
}

// The review step's phase-input stretch: its opening sentence to the gate paragraph. Null when the opening is gone.
const REVIEW_OPEN = 'With `planning.workflow_plans` read in `parse` as `true`, the payload is the PLAN file(s) plus the phase input';
function reviewStretchOf(text) {
  const start = text.indexOf(REVIEW_OPEN);
  if (start === -1) return null;
  const end = text.indexOf('\n\nThe gate comes from the routing bundle', start);
  assert.notEqual(end, -1, 'the review stretch has no end');
  return { start, end };
}

// Every vocabulary match outside the stretches, the brief step, the inline sentence and the key's line.
function outside(text) {
  const spans = [stretchOf(text), plannerStretchOf(text), checkerStretchOf(text), reviewStretchOf(text), briefStepOf(text), inlineOf(text), keyLineOf(text)]
    .filter(Boolean);
  return [...text.matchAll(VOCAB), ...text.matchAll(MARKERS)]
    .filter((m) => !spans.some((s) => m.index >= s.start && m.index < s.end));
}

test('parse reads the switch in its one config.mjs get, which adds a key and no call', () => {
  const parse = stepOf(PLAN_MD, 'parse');
  const get = parse.match(/config\.mjs" get \\\n((?:  .*\n)+)```/);
  assert.ok(get, 'parse has no wrapped config.mjs get');
  assert.match(get[1], /\bplanning\.workflow_plans\b/);
  assert.equal((parse.match(/config\.mjs" get/g) || []).length, 1);
});

test('the stretch names plan-graph.md, which exists, and says gaps and revision carry it', () => {
  const at = stretchOf(PLAN_MD);
  assert.ok(at, 'no gated stretch in plan.md');
  const text = PLAN_MD.slice(at.start, at.end).replace(/\s+/g, ' ');
  const named = text.match(/<plan_graph>[^<]*\$\{CLAUDE_PLUGIN_ROOT\}\/(cadence-core\/references\/plan-graph\.md)[^<]*<\/plan_graph>/);
  assert.ok(named, 'the block names no reference');
  assert.ok(existsSync(join(ROOT, named[1])));
  assert.match(text, /placed after `<testing_policy>` and `<code_map>` when those are present/);
  assert.match(text, /Gaps and revision modes reuse this prompt and so carry the block/);
  assert.match(text, /With the key not `true` the prompt carries none of it/);
});

test('the stretch sits after the code map block and before revision mode', () => {
  const at = stretchOf(PLAN_MD);
  assert.ok(PLAN_MD.indexOf('</code_map>\n```') < at.start);
  assert.ok(at.end < PLAN_MD.indexOf('Revision mode:'));
});

test('inline_plan reads the reference for the task fields only and carries no block', () => {
  const inline = stepOf(PLAN_MD, 'inline_plan').replace(/\s+/g, ' ');
  assert.match(inline, /With `planning\.workflow_plans` `true`, read `references\/plan-graph\.md` once, for its task fields section only/);
  assert.match(inline, /`depends_on` and the width don't apply, and it carries no block/);
});

test('with the switch off the new vocabulary appears in plan.md only inside the stretch, the brief step, the inline sentence and the key line', () => {
  assert.ok([...PLAN_MD.matchAll(VOCAB)].length > 0, 'plan.md holds none of the vocabulary, so this pins nothing');
  assert.deepEqual(outside(PLAN_MD).map((m) => m.index), []);
  const at = PLAN_MD.indexOf('<planning_context>\nPhase:');
  const prompt = PLAN_MD.slice(at, PLAN_MD.indexOf('</planning_context>', at));
  assert.ok(prompt.length > 500, 'the prompt fence was not found');
  assert.doesNotMatch(prompt, VOCAB);
  assert.doesNotMatch(prompt, MARKERS);
});

test('the pin fails when the stretch loses its opening sentence', () => {
  assert.ok(outside(PLAN_MD.replace(OPENING, 'x')).length > 0);
});

test('the pin fails when the brief step loses its tag', () => {
  assert.ok(outside(PLAN_MD.replace('<step name="check_brief">', '<step name="x">')).length > 0);
});

// --- /cad-plan: the planner's phase input ---------------------------------------------------------------------

// Copied from 3f3f6a3e: with the switch off the planner's dispatch is exactly these.
const PLANNER_RESOLVE = `node "\${CLAUDE_PLUGIN_ROOT}/cadence-core/bin/route.mjs" resolve --role cad-planner \\
  --attempt 1 --phase {N} \\
  --bracket-read ".planning/ROADMAP.md,.planning/REQUIREMENTS.md,.planning/PROJECT.md,.planning/phases/{N}/CONTEXT.md"`;
const PLANNER_READS = `Read before planning:
- .planning/ROADMAP.md (this phase's entry and its dependencies)
- .planning/REQUIREMENTS.md
- .planning/PROJECT.md
- .planning/phases/{N}/CONTEXT.md (locked user decisions - if present)
`;
const RECALL_BATCH = `When
recall does run, batch it with the \`route.mjs resolve\` above in one message -
both only feed the single dispatch and neither depends on the other.`;
const REVISION_READ = '`--bracket-read ".planning/ROADMAP.md,.planning/REQUIREMENTS.md,.planning/PROJECT.md,.planning/phases/{N}/CONTEXT.md"`.';
const PLANNER_STRETCH = (() => { const at = plannerStretchOf(PLAN_MD); return at ? PLAN_MD.slice(at.start, at.end) : ''; })();
const plannerFlat = PLANNER_STRETCH.replace(/\s+/g, ' ');

test('switch off: the planner\'s resolve block, its four document lines and the recall batching sentence are as at 3f3f6a3e', () => {
  assert.ok(PLAN_MD.includes(PLANNER_RESOLVE), 'the planner\'s resolve block changed');
  assert.ok(PLAN_MD.includes(PLANNER_READS), 'the Read before planning document lines changed');
  assert.ok(PLAN_MD.includes(RECALL_BATCH), 'the sentence batching recall with the resolve changed');
});

test('the planner stretch sits in spawn_planner outside the prompt fence and composes the phase input once with --out-dir', () => {
  const at = plannerStretchOf(PLAN_MD);
  assert.ok(at, 'no planner stretch in plan.md');
  assert.ok(PLAN_MD.indexOf('<step name="spawn_planner">') < at.start);
  assert.ok(at.end < PLAN_MD.indexOf('<planning_context>\nPhase:'));
  const calls = PLANNER_STRETCH.match(/planning\.mjs" brief [^\n]*/g) || [];
  assert.equal(calls.length, 1);
  assert.match(calls[0], /--phase \{N\} --role phase --out-dir <the scratch directory>/);
  assert.match(plannerFlat, /mktemp -d "\$\{TMPDIR:-\/tmp\}\/cad-XXXXXX"/);
  assert.match(plannerFlat, /before the resolve above goes out/);
});

test('the planner stretch\'s bracket value is the composed path, gaps adds its files, and it names no phase document', () => {
  const m = /`--bracket-read` value is `([^`]*)`/.exec(plannerFlat);
  assert.ok(m, 'the flag is not in backticks with its value apart');
  assert.equal(m[1], '<the phase input path>');
  assert.match(plannerFlat, /In gaps mode it is that path plus `\.planning\/phases\/\{N\}\/UAT\.md` and the existing PLAN\* and SUMMARY\* files/);
  assert.doesNotMatch(PLANNER_STRETCH, /--bracket-read\s/, 'a flag followed by whitespace is a second open to the trace census');
  assert.doesNotMatch(PLANNER_STRETCH, /ROADMAP\.md|REQUIREMENTS\.md|PROJECT\.md|CONTEXT\.md/);
  assert.match(plannerFlat, /names that file by its absolute path in place of its four document lines, and keeps the gaps line and the source-files line/);
  assert.match(plannerFlat, /\*\*A refused or unreadable answer\.\*\* Print one line with what it names, and dispatch the way this step does with the key not `true`/);
});

test('the pin fails when the planner stretch loses its opening sentence', () => {
  assert.ok(outside(PLAN_MD.replace(PLANNER_OPEN, 'x')).length > 0);
});

test('plan-revision.md step 1 keeps its read-set and names the planner stretch\'s path with the switch on', () => {
  const rev = readFileSync(join(ROOT, 'cadence-core', 'references', 'plan-revision.md'), 'utf8');
  const step1 = rev.slice(rev.indexOf('\n1. '), rev.indexOf('\n2. '));
  assert.ok(step1.includes(REVISION_READ), 'step 1\'s --bracket-read read-set changed');
  assert.match(step1.replace(/\s+/g, ' '), /With `planning\.workflow_plans` `true`[^.]*`--bracket-read` value is `<the phase input path>` `spawn_planner`'s stretch kept/);
});

// --- /cad-plan: the checker's phase input ---------------------------------------------------------------------

// Copied from 3f3f6a3e: with the switch off the checker's dispatch is exactly these.
const CHECKER_BRACKET = '--bracket-read ".planning/phases/{N}/PLAN*.md,.planning/ROADMAP.md,.planning/REQUIREMENTS.md,.planning/phases/{N}/CONTEXT.md"';
const CHECKER_READS = `Read:
- .planning/phases/{N}/PLAN*.md (the plans under review)
- .planning/ROADMAP.md and .planning/REQUIREMENTS.md
- .planning/phases/{N}/CONTEXT.md (if present)
`;
const CHECKER_STRETCH = (() => { const at = checkerStretchOf(PLAN_MD); return at ? PLAN_MD.slice(at.start, at.end) : ''; })();
const checkerFlat = CHECKER_STRETCH.replace(/\s+/g, ' ');

test('switch off: the checker\'s bracket string and Read: list are as at 3f3f6a3e', () => {
  assert.ok(PLAN_MD.includes(CHECKER_BRACKET), 'the checker\'s --bracket-read string changed');
  assert.ok(PLAN_MD.includes(CHECKER_READS), 'the checker\'s Read: list changed');
});

test('the checker stretch sits in check_gate before its prompt, brackets the plans plus the composed path and names no whole document', () => {
  const at = checkerStretchOf(PLAN_MD);
  assert.ok(at, 'no checker stretch in plan.md');
  assert.ok(PLAN_MD.indexOf('<step name="check_gate">') < at.start);
  assert.ok(at.end < PLAN_MD.indexOf('<verification_context>'));
  const m = /`--bracket-read` value is `([^`]*)`/.exec(checkerFlat);
  assert.ok(m, 'the flag is not in backticks with its value apart');
  assert.equal(m[1], '.planning/phases/{N}/PLAN*.md,<the phase input path>');
  assert.doesNotMatch(CHECKER_STRETCH, /--bracket-read\s/, 'a flag followed by whitespace is a second open to the trace census');
  assert.doesNotMatch(CHECKER_STRETCH, /ROADMAP\.md|REQUIREMENTS\.md|CONTEXT\.md/);
  assert.doesNotMatch(CHECKER_STRETCH, /node "/, 'the compose call is spawn_planner\'s, referenced and never spelled again');
  assert.match(checkerFlat, /Name the phase input `spawn_planner`'s stretch composed/);
});

// The key is this stretch's only vocabulary and it sits in the opening, so the sentence loses its anchor and keeps the key.
test('the pin fails when the checker stretch loses its opening sentence', () => {
  assert.ok(outside(PLAN_MD.replace(CHECKER_OPEN, 'With `planning.workflow_plans` read in `parse` as `true`, x')).length > 0);
});

// --- /cad-plan: the plan review's phase input ------------------------------------------------------------------

// Copied from 3f3f6a3e: with the switch off the plan fire's payload is exactly this.
const REVIEW_PAYLOAD = `<step name="review">
Fire the \`plan\` review trigger per references/review-triggers.md, payload = the
PLAN file(s) PLUS the three artifacts the reviewer is asked to check them
against: \`.planning/ROADMAP.md\`, \`.planning/REQUIREMENTS.md\` and
\`.planning/phases/{N}/CONTEXT.md\`. All four are REFERENCE PATHS the reviewer
resolves itself - never inlined text, which would keep every byte of them
resident here for the rest of the run - and all four ride the fire's \`--read\`
bracket list (review-triggers.md step 4). On the workflow path a fire over more
than one PLAN file runs one reviewer per plan and one cross-plan reviewer, and
today's path runs one reviewer over all of them.

`;
const REVIEW_STRETCH = (() => { const at = reviewStretchOf(PLAN_MD); return at ? PLAN_MD.slice(at.start, at.end) : ''; })();
const reviewFlat = REVIEW_STRETCH.replace(/\s+/g, ' ');

test('switch off: the review step\'s payload paragraph is as at 3f3f6a3e', () => {
  assert.ok(PLAN_MD.includes(REVIEW_PAYLOAD), 'the review step\'s first paragraph changed');
});

test('the review stretch names the phase input in place of the three artifacts, names none of them, and spells no call', () => {
  const at = reviewStretchOf(PLAN_MD);
  assert.ok(at, 'no review stretch in plan.md');
  assert.ok(PLAN_MD.indexOf('<step name="review">') < at.start);
  assert.match(reviewFlat, /the payload is the PLAN file\(s\) plus the phase input in place of the three artifacts/);
  assert.match(reviewFlat, /Name the phase input `spawn_planner`'s stretch composed/);
  assert.match(reviewFlat, /rides the fire's `--read` bracket list in place of the three/);
  assert.doesNotMatch(REVIEW_STRETCH, /ROADMAP\.md|REQUIREMENTS\.md|CONTEXT\.md/);
  assert.doesNotMatch(REVIEW_STRETCH, /node "/, 'the compose call is spawn_planner\'s, referenced and never spelled again');
});

// As with the checker, the key is this stretch's only vocabulary, so the sentence loses its anchor and keeps the key.
test('the pin fails when the review stretch loses its opening sentence', () => {
  assert.ok(outside(PLAN_MD.replace(REVIEW_OPEN, 'With `planning.workflow_plans` read in `parse` as `true`, x')).length > 0);
});

test('review-triggers.md\'s plan row still names the three artifacts and states the switch-on replacement', () => {
  const triggers = readFileSync(join(ROOT, 'cadence-core', 'references', 'review-triggers.md'), 'utf8');
  const row = triggers.split('\n').find((l) => l.startsWith('| `plan` |')) ?? '';
  assert.ok(row.includes('(c) the PLAN file path(s), plus `.planning/ROADMAP.md`, `.planning/REQUIREMENTS.md` and `.planning/phases/<N>/CONTEXT.md` (optional)'),
    'the plan row no longer names today\'s three artifacts');
  assert.match(row, /With `planning\.workflow_plans` `true` the three become one, the phase input `[^`]*brief --phase <N> --role phase --out-dir <dir>` composes, by its absolute path, the PLAN path\(s\) unchanged/);
  assert.match(row, /else one `config\.mjs get planning\.workflow_plans`/);
  assert.match(row, /A refused answer is named in one line and the fire takes the three/);
});

test('the plan checker contract reads the files its dispatch names and still names the CONTEXT decisions', () => {
  const contract = readFileSync(join(ROOT, 'skills', 'cad-plan-checker-contract', 'SKILL.md'), 'utf8');
  const step1 = contract.slice(contract.indexOf('<process>'), contract.indexOf('\n2. ', contract.indexOf('<process>'))).replace(/\s+/g, ' ');
  assert.match(step1, /from the files your dispatch names/);
  assert.match(step1, /CONTEXT decisions/);
});

// --- /cad-plan: the brief check ------------------------------------------------

const BRIEF_STEP = stepOf(PLAN_MD, 'check_brief');
const briefFlat = BRIEF_STEP.replace(/\s+/g, ' ');

test('the brief check sits after check_size and before check_census and check_gate', () => {
  const at = (n) => PLAN_MD.indexOf(`<step name="${n}">`);
  assert.ok(at('check_size') < at('check_brief'));
  assert.ok(at('check_brief') < at('check_census'));
  assert.ok(at('check_brief') < at('check_gate'));
  assert.ok(at('handle_return') < at('check_brief'));
});

test('the brief check makes one call, with --phase and --plan and no --out-dir, once per plan file, and none with the key not true', () => {
  const calls = BRIEF_STEP.match(/planning\.mjs" brief [^\n]*/g) || [];
  assert.equal(calls.length, 1);
  assert.match(calls[0], /--phase \{N\}/);
  assert.match(calls[0], /--plan <k>/);
  assert.doesNotMatch(calls[0], /--out-dir/);
  assert.match(briefFlat, /Once per plan file the phase has/);
  assert.match(briefFlat, /With the key not `true`, make no call and go on/);
});

test('the brief check skips an already-complete plan in a gaps run and re-dispatches nothing for it', () => {
  assert.match(briefFlat, /In a `--gaps` run, skip a plan whose `records\/reports\/plan-<k>\.md` opens `PLAN COMPLETE`/);
  assert.match(briefFlat, /re-dispatch nothing for it/);
  assert.ok(briefFlat.indexOf('skip a plan whose') < briefFlat.indexOf('re-dispatch ONCE'));
});

test('the brief check re-dispatches once on a refusal, is no hard halt, and lets /cad-execute fall back', () => {
  assert.match(briefFlat, /On `ok:false`, say what the answer names out loud, and re-dispatch ONCE/);
  assert.match(briefFlat, /bad id goes to a fresh revision-mode planner[^.]*`<checker_issues>`/);
  assert.match(briefFlat, /over its ceiling gets `check_size`'s instruction/);
  assert.match(briefFlat, /Not a hard halt\. After the one re-dispatch, or the user's word, continue/);
});

test('the brief check relays reads_missing and reads_unchecked in one line per plan and has no re-dispatch for them', () => {
  assert.match(briefFlat, /An `ok:true` answer may carry `reads_missing`[^.]*or `reads_unchecked`: relay either in one line per plan and re-dispatch nothing for it\./);
  assert.ok(briefFlat.indexOf('reads_missing') < briefFlat.indexOf('On `ok:false`'));
  assert.doesNotMatch(briefFlat, /\bmap\b/i);
});

test('inline_plan does not name the brief call', () => {
  assert.doesNotMatch(stepOf(PLAN_MD, 'inline_plan'), /planning\.mjs" brief|check_brief/);
});

test('the planner contract, executor contract, planner rungs, plan skill, template and gaps workflow hold none of it', () => {
  const rungs = readdirSync(join(ROOT, 'agents')).filter((f) => /^cad-planner(-.+)?\.md$/.test(f));
  assert.equal(rungs.length, 5);
  const files = [join('skills', 'cad-planner-contract', 'SKILL.md'), join('skills', 'cad-executor-contract', 'SKILL.md'),
    join('skills', 'cad-plan', 'SKILL.md'), join('cadence-core', 'templates', 'PLAN.md'),
    join('cadence-core', 'workflows', 'plan-gaps.md'), ...rungs.map((f) => join('agents', f))];
  for (const f of files) {
    const text = readFileSync(join(ROOT, f), 'utf8');
    assert.doesNotMatch(text, VOCAB, f);
    assert.doesNotMatch(text, MARKERS, f);
  }
});

// --- /cad-execute: the executor's brief ----------------------------------------------------------------------

const EXEC_OPEN = 'With `planning.workflow_plans` read in `locate` as `true`, a brief takes the place of the plan file';
const EXEC_CLOSE = '\n\nDo NOT restate the executor';
const SHARED_BULLET = `- Shared files to read first (identical for every plan in the phase): project
  \`CLAUDE.md\` (if present), \`.planning/PROJECT.md\` (if present),
  \`.planning/phases/<N>/CONTEXT.md\` (if present).`;
const BRACKET_LINE = '`--plan <k> --bracket-plan <k> --bracket-read "CLAUDE.md,.planning/PROJECT.md,.planning/phases/<N>/CONTEXT.md,<the plan file>"`';
const EXEC_VOCAB = /\b(?:workflow_plans|plan-graph|brief)\b/gi;

// The stretch: its opening sentence to the paragraph break before the standing-rules paragraph. Null when the opening is gone.
function execStretch(text) {
  const start = text.indexOf(EXEC_OPEN);
  if (start === -1) return null;
  const end = text.indexOf(EXEC_CLOSE, start);
  assert.notEqual(end, -1, 'the stretch has no end');
  return { start, end };
}
// Plan 5's choose_path stretch: the workflow path's conditions, up to the line that starts today's list. It names the switch's
// companion key, so it is the second allowance.
const WF_OPEN = '**The workflow path comes first.**';
const WF_CLOSE = 'Sequential (default) unless ALL of these hold:';
function wfStretch(text) {
  const start = text.indexOf(WF_OPEN);
  if (start === -1) return null;
  const end = text.indexOf(WF_CLOSE, start);
  assert.notEqual(end, -1, 'the workflow stretch has no end');
  return { start, end };
}
const execKeyLine = (text) => {
  const start = text.indexOf('testing.scope planning.workflow_plans');
  return start === -1 ? null : { start, end: text.indexOf('\n', start) };
};
function execOutside(text) {
  const spans = [execStretch(text), wfStretch(text), execKeyLine(text)].filter(Boolean);
  return [...text.matchAll(EXEC_VOCAB)].filter((m) => !spans.some((s) => m.index >= s.start && m.index < s.end));
}

const flatExec = (text) => text.replace(/\s+/g, ' ');
const STRETCH = (() => { const at = execStretch(EXECUTE); return at ? EXECUTE.slice(at.start, at.end) : ''; })();
const stretchFlat = flatExec(STRETCH);

test('execute.md keeps today\'s shared-files bullet and bracket-read string byte for byte, free of the new vocabulary', () => {
  assert.ok(EXECUTE.includes(SHARED_BULLET), 'the shared-files bullet changed');
  assert.ok(EXECUTE.includes(BRACKET_LINE), 'the lifecycle bracket\'s --bracket-read string changed');
  assert.doesNotMatch(SHARED_BULLET + BRACKET_LINE, EXEC_VOCAB);
});

test('locate has one config.mjs get, which names the key', () => {
  const locate = stepOf(EXECUTE, 'locate');
  assert.equal((locate.match(/config\.mjs" get/g) || []).length, 1);
  assert.match(locate.match(/config\.mjs" get \\\n((?:  .*\n)+)```/)?.[1] ?? '', /\bplanning\.workflow_plans\b/);
});

test('outside the stretch and the key line, execute.md holds none of the new vocabulary, and the pin fails without the opening sentence', () => {
  assert.ok(STRETCH.length > 500, 'no stretch in execute.md');
  assert.deepEqual(execOutside(EXECUTE).map((m) => m.index), []);
  assert.ok(execOutside(EXECUTE.replace(EXEC_OPEN, 'x')).length > 0);
});

test('the vocabulary pin fails when the workflow stretch loses its opening sentence, and the stretch holds only the key it needs', () => {
  assert.ok(wfStretch(EXECUTE), 'no workflow stretch in execute.md');
  assert.ok(execOutside(EXECUTE.replace(WF_OPEN, 'x')).length > 0);
  const stretch = EXECUTE.slice(wfStretch(EXECUTE).start, wfStretch(EXECUTE).end);
  assert.doesNotMatch(stretch, /\bbrief\b|plan-graph/i);
});

test('the risk_surface fix pass paragraph is unchanged', () => {
  const FIX = 'The dispatch prompt carries four things, nothing distilled by the coordinator: the plan file; the findings file\'s PATH, already persisted at `.planning/phases/<N>/records/REVIEW-risk_surface-<discriminator>.md` (references/risk-surface.md), the discriminator being that fire\'s range (references/review-triggers.md step 5); the instruction to fix the blocker/high findings only; and the instruction NOT to rotate the plan\'s report but to append its fix row to the existing `<plandir>/records/reports/plan-<k>.md`';
  assert.ok(flatExec(EXECUTE).includes(FIX));
});

test('the stretch names no PROJECT.md or CONTEXT.md, reads CLAUDE.md alone, and names the brief file in place of the plan file', () => {
  assert.doesNotMatch(STRETCH, /PROJECT\.md|CONTEXT\.md/);
  assert.ok(stretchFlat.includes('The shared files to read first are project `CLAUDE.md` alone'));
  assert.ok(stretchFlat.includes('names the brief file by that absolute path in place of the plan file'));
  assert.match(stretchFlat, /even from a worktree/);
});

test('the stretch\'s bracket value is CLAUDE.md plus the brief path and nothing else, the flag given apart from it', () => {
  const m = /`--bracket-read` value is `([^`]*)`/.exec(stretchFlat);
  assert.ok(m, 'the flag is not in backticks with its value apart');
  assert.equal(m[1], 'CLAUDE.md,<the brief path>');
  assert.doesNotMatch(STRETCH, /--bracket-read\s/, 'a flag followed by whitespace is a second open to the trace census');
  assert.match(stretchFlat, /carries its own value on its own `dispatch` event, so no member's bracket names another's brief/);
});

test('the stretch composes before each plan\'s dispatch with --out-dir, a batch composes first, and the transcript never gets the brief', () => {
  const at = stretchFlat.indexOf('Before each plan\'s dispatch');
  assert.notEqual(at, -1);
  const call = /planning\.mjs" brief --phase <N> --plan <k> --out-dir <the scratch directory>/.exec(stretchFlat.slice(at));
  assert.ok(call, 'the compose call does not follow the words');
  assert.equal((STRETCH.match(/planning\.mjs" brief/g) || []).length, 1);
  assert.match(stretchFlat, /composes all its briefs before the batch's one message/);
  assert.match(stretchFlat, /never the brief/);
  assert.match(stretchFlat, /mktemp -d "\$\{TMPDIR:-\/tmp\}\/cad-XXXXXX"/);
});

test('the stretch has a continuation name the same file, the refused arm, and the blocked arm with no report file', () => {
  assert.match(stretchFlat, /A continuation and a re-dispatched remainder name that same brief file, unless that plan's executor came back `blocked` on it/);
  assert.match(stretchFlat, /\*\*A refused or unreadable answer\.\*\* Print one line with what it names, and dispatch that plan the way this step does with the key not `true`/);
  assert.match(stretchFlat, /does no task and returns a `blocked` checkpoint naming the path/);
  assert.match(stretchFlat, /That return owes no report file/);
  assert.match(stretchFlat, /After a first dispatch, where no task has run, it starts the plan fresh and names no report path/);
  assert.match(stretchFlat, /keeps what `handle_checkpoint` carries: the report path, the checkpoint outcome, "continue from task <k>" and the same pre-plan HEAD/);
  assert.match(stretchFlat, /A `risk_surface` fix pass names that same brief file in place of the plan file, under the same `blocked` exception, and keeps the other three things its own paragraph lists/);
});

test('the stretch hands the fix pass the brief, the findings path and its two instructions, and composes again after a files: amendment', () => {
  const at = stretchFlat.indexOf('A `risk_surface` fix pass');
  assert.notEqual(at, -1, 'the stretch names no fix pass');
  const fix = stretchFlat.slice(at);
  assert.match(fix, /^A `risk_surface` fix pass names that same brief file in place of the plan file/);
  assert.match(fix, /the findings file's path, the instruction to fix the blocker and high findings only, and the instruction to append its fix row to the plan's report rather than rotate it/);
  assert.match(fix, /Its resolve carries the \*\*Bracket\*\* value above/);
  assert.match(fix, /amended `PLAN-<k>\.md`'s `files:`[^.]*runs the \*\*Compose\*\* call again into the same scratch directory before that dispatch/);
  assert.match(fix, /the lease the brief shows is the one `lease-check` reads/);
});

test('the executor contract reads what its dispatch names, with no read list that presumes CONTEXT.md or PROJECT.md', () => {
  const contract = readFileSync(join(ROOT, 'skills', 'cad-executor-contract', 'SKILL.md'), 'utf8');
  const role = contract.slice(contract.indexOf('<role>'), contract.indexOf('</role>'));
  const line = role.slice(role.indexOf('Read the files'), role.indexOf('\n\n', role.indexOf('Read the files'))).replace(/\s+/g, ' ');
  assert.match(line, /^Read the files your dispatch prompt names before touching anything\./);
  assert.doesNotMatch(line, /CONTEXT\.md|PROJECT\.md/);
  assert.match(line, /Project CLAUDE\.md directives are hard constraints/);
});

test('the parallel reference still reuses this prompt and keeps its per-worker bracket', () => {
  const par = readFileSync(join(ROOT, 'cadence-core', 'references', 'execute-parallel.md'), 'utf8').replace(/\s+/g, ' ');
  assert.match(par, /Same prompt as sequential except/);
  assert.match(par, /per worker/);
});

test('through the real seams a scratch project reads the switch false and brief --out-dir writes the file its answer names', () => {
  const root = mkdtempSync(join(tmpdir(), 'cad-wfbrief-'));
  try {
    assert.equal(readSwitch(undefined), false);
    const phase = join(root, '.planning', 'phases', '1');
    mkdirSync(phase, { recursive: true });
    // phase folders with no roadmap are refused by every seam
    writeFileSync(join(root, '.planning', 'ROADMAP.md'), '# Roadmap\n\n## Phases\n\n- [ ] **Phase 1: x** - y\n');
    writeFileSync(join(phase, 'PLAN.md'), '---\nphase: 1\nplan: 1\nfiles:\n  - a.txt\n---\n\n# Phase 1: x - Plan 1: y\n\n## Goal\n\nDo it.\n\n## Tasks\n\n### Task 1: one\n\n- **Files:** a.txt\n- **Action:** write it\n- **Verify:** cat a.txt\n');
    const out = mkdtempSync(join(tmpdir(), 'cad-wfbrief-out-'));
    try {
      const run = (...args) => JSON.parse(execFileSync('node', [join(ROOT, 'cadence-core', 'bin', 'planning.mjs'), 'brief', '--phase', '1', '--plan', '1', ...args], { encoding: 'utf8', cwd: root }));
      const bare = run();
      assert.equal(bare.ok, true);
      assert.equal(bare.path, undefined, 'no --out-dir writes nothing');
      const written = run('--out-dir', out);
      assert.equal(written.ok, true);
      assert.equal(written.path, join(out, 'plan-1-brief.md'));
      assert.ok(existsSync(written.path));
      assert.equal(readFileSync(written.path, 'utf8').length > 0, true);
    } finally { rmSync(out, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- /cad-verify --deep: the verifier's input ------------------------------------------------------------------

const DEEP = readFileSync(join(ROOT, 'cadence-core', 'workflows', 'verify-deep.md'), 'utf8');
const DEEP_OPEN = 'With `planning.workflow_plans` `true`, the verifier reads one composed input';
// Copied from 3f3f6a3e: with the switch off the verifier's dispatch is exactly these.
const DEEP_BRACKET = '`--bracket-read ".planning/phases/<N>/PLAN*.md,.planning/phases/<N>/SUMMARY*.md,.planning/ROADMAP.md,.planning/phases/<N>/UAT.md"`';
const DEEP_HAND = `Hand it the phase number, goal,
the current UAT items, the PLAN/SUMMARY/ROADMAP paths, and the path it must
write: \`.planning/phases/<N>/records/verifier-findings.json\`.`;
const DEEP_STRETCH = (() => {
  const start = DEEP.indexOf(DEEP_OPEN);
  return start === -1 ? '' : DEEP.slice(start, DEEP.indexOf('\n\nClose the bracket HERE', start));
})();
const deepFlat = DEEP_STRETCH.replace(/\s+/g, ' ');

test('switch off: the deep verifier\'s bracket string and hand-it sentence are as at 3f3f6a3e', () => {
  assert.ok(DEEP.includes(DEEP_BRACKET), 'the verifier\'s --bracket-read string changed');
  assert.ok(DEEP.includes(DEEP_HAND), 'the verifier\'s hand-it sentence changed');
});

test('the deep stretch sits in dispatch, reads the key in its one config.mjs get and composes the verifier input', () => {
  assert.ok(DEEP_STRETCH.length > 300, 'no stretch in verify-deep.md');
  const dispatch = stepOf(DEEP, 'dispatch');
  assert.ok(dispatch.includes(DEEP_STRETCH));
  const gets = DEEP.match(/config\.mjs" get [^\n]*/g) || [];
  assert.equal(gets.length, 1);
  assert.ok(DEEP_STRETCH.includes(gets[0]));
  assert.match(gets[0], /get planning\.workflow_plans$/);
  assert.match(DEEP_STRETCH, /planning\.mjs" brief --phase <N> --role verifier --out-dir <the scratch directory>/);
  assert.match(deepFlat, /mktemp -d "\$\{TMPDIR:-\/tmp\}\/cad-XXXXXX"/);
});

test('the deep stretch\'s bracket value is the composed path and it names no PLAN, SUMMARY, ROADMAP or UAT path', () => {
  const m = /`--bracket-read` value is `([^`]*)`/.exec(deepFlat);
  assert.ok(m, 'the flag is not in backticks with its value apart');
  assert.equal(m[1], '<the verifier input path>');
  assert.doesNotMatch(DEEP_STRETCH, /--bracket-read\s/, 'a flag followed by whitespace is a second open to the trace census');
  assert.doesNotMatch(DEEP_STRETCH, /\.planning\/|PLAN[^\s,]*\.md|SUMMARY[^\s,]*\.md|ROADMAP\.md|UAT\.md/);
  assert.match(deepFlat, /that file by its absolute path in place of the document paths and the UAT items it already carries, and the findings path above/);
  assert.match(deepFlat, /\*\*A refused or unreadable answer\.\*\* Print one line with what it names, and dispatch as the paragraph above does/);
});

test('verify-deep.md still holds exactly three <step name= tags', () => {
  assert.equal((DEEP.match(/<step name=/g) || []).length, 3);
});

test('the verifier contract\'s step 1 names the stand-in input, which carries the acceptance criteria, and keeps CONTEXT.md in its document list', () => {
  const contract = readFileSync(join(ROOT, 'skills', 'cad-verifier-contract', 'SKILL.md'), 'utf8');
  const step1 = contract.slice(contract.indexOf('## 1. Load context'), contract.indexOf('## 2.')).replace(/\s+/g, ' ');
  assert.match(step1, /Read what your dispatch hands you: the documents below, or the one input that stands in for them/);
  assert.match(step1, /the success criteria, CONTEXT's acceptance criteria, the UAT items, each plan's must-be-true lines and the SUMMARY's claims/);
  assert.ok(!step1.includes('carries no CONTEXT.md'));
  assert.ok(step1.includes('- Acceptance criteria: `.planning/phases/<N>/CONTEXT.md` if present.'));
});

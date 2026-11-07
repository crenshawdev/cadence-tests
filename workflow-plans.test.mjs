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

// Every vocabulary match outside the stretch, the inline sentence and the key's line.
function outside(text) {
  const spans = [stretchOf(text), inlineOf(text), keyLineOf(text)].filter(Boolean);
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

test('with the switch off the new vocabulary appears in plan.md only inside the stretch, the inline sentence and the key line', () => {
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

// Zero-dep tests for lib/config-layers.mjs and the `config.mjs layers` read behind the /cad-config menu.
// The lib cases run the real mergeLayers over fixture files, with a small hand-written schema so every
// expectation is computed by hand. The CLI cases run the shipped schema over temp repos.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = join(ROOT, 'cadence-core', 'bin', 'config.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'cad-layers-'));
const GLOBAL = join(tmp, 'global.json');
// config-merge reads this at import, so it is set before the dynamic imports below
process.env.CADENCE_GLOBAL_CONFIG = GLOBAL;

let mergeLayers;
let layerRows;
before(async () => {
  ({ mergeLayers } = await import('../cadence-core/bin/lib/config-merge.mjs'));
  ({ layerRows } = await import('../cadence-core/bin/lib/config-layers.mjs'));
});

const SCHEMA = {
  'a.x': { type: 'int', default: 1, section: 'One', position: 1, question: 'x?' },
  'a.y': { type: 'string', default: 'd', section: 'One', position: 2, question: 'y?' },
  'workflow.test_command': { type: 'string', default: null, src: 'global', section: 'One', position: 3, question: 't?' },
  'review.reviewers': { type: 'array_enum', default: ['claude-subagent'], section: 'One', position: 4, question: 'r?' },
  'git.a': { type: 'string', default: 'ga', section: 'Two', position: 5, question: 'ga?' },
  'git.b': { type: 'string', default: 'gb', section: 'Two', position: 6, question: 'gb?' },
  'testing.scope': { type: 'string', default: null, section: 'Two', position: 7, question: 's?' },
  'b.z': { type: 'bool', default: false, section: 'Two', purpose: 'hidden' },
  'workflow.use_workflows': { type: 'bool', default: false, section: 'Two', position: 8, question: 'u?' },
  'model.m': { type: 'string', default: null, grammar: 'model_id', section: 'Two', position: 9, question: 'm?' },
};

// Writes the two layers (an object is JSON, a string goes in raw, null leaves the file absent), runs the real merge
// and the rule. `answers` is the both-layer map the CLI builds from the two layer reads.
function read({ global = null, repo = null, answers = {} }) {
  const repoFile = join(tmp, 'repo.json');
  for (const [file, body] of [[GLOBAL, global], [repoFile, repo]]) {
    if (body === null) rmSync(file, { force: true });
    else writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  }
  const merged = mergeLayers(repoFile);
  return layerRows({ keys: SCHEMA, merged, files: { repo: repoFile, global: GLOBAL }, both: answers });
}
const rowOf = (r, key) => r.rows.find((x) => x.key === key);

test('ordinary keys: repo beats global beats the default, and only a differing repo value beats', () => {
  const r = read({ global: { a: { x: 7, y: 'g' } }, repo: { a: { x: 5 } } });
  assert.deepEqual([rowOf(r, 'a.x').winner, rowOf(r, 'a.x').value], ['repo', 5]);
  assert.deepEqual([rowOf(r, 'a.y').winner, rowOf(r, 'a.y').value], ['global', 'g']);
  assert.deepEqual([rowOf(r, 'git.a').winner, rowOf(r, 'git.a').value], ['default', 'ga']);
  const one = r.groups.find((g) => g.name === 'One');
  assert.deepEqual([one.repo, one.global, one.beating, one.at_default], [1, 2, 1, 0]);
});

test('equal values in both layers beat nothing', () => {
  const r = read({ global: { a: { x: 5 } }, repo: { a: { x: 5 } } });
  assert.equal(r.totals.beating, 0);
  assert.deepEqual([r.totals.repo, r.totals.global], [1, 1]);
});

test('a repo null wins the merge and the value in force falls to the schema default', () => {
  const r = read({ global: { a: { x: 7 } }, repo: { a: { x: null } } });
  assert.deepEqual([rowOf(r, 'a.x').winner, rowOf(r, 'a.x').value], ['repo', 1]);
  assert.equal(r.totals.beating, 1);
});

test('a repo {"git": null} over global git.* values reads the default and is named', () => {
  const r = read({ global: { git: { a: 'G' } }, repo: { git: null } });
  assert.deepEqual([rowOf(r, 'git.a').winner, rowOf(r, 'git.a').value], ['repo', 'ga']);
  assert.equal(rowOf(r, 'git.a').repo.state, 'unset');
  assert.equal(r.totals.repo, 0);
  assert.match(r.warnings.join('\n'), /"git" is not an object/);
});

test('a repo value for a global-only key is ignored; the global value runs', () => {
  const r = read({ global: { workflow: { test_command: 'npm t' } }, repo: { workflow: { test_command: 'rm -rf /' } } });
  const row = rowOf(r, 'workflow.test_command');
  assert.deepEqual([row.repo.state, row.repo.value], ['ignored', 'rm -rf /']);
  assert.deepEqual([row.winner, row.value], ['global', 'npm t']);
  assert.equal(r.totals.repo, 0);
});

test('a null repo value on a global-only key is the template shipping it, not an ignored value', () => {
  const r = read({ repo: { workflow: { test_command: null } } });
  assert.equal(rowOf(r, 'workflow.test_command').repo.state, 'unset');
});

test('a global testing value is ignored; the repo value is the policy', () => {
  const r = read({ global: { testing: { scope: 'thorough' } }, repo: { testing: { scope: 'focused' } } });
  const row = rowOf(r, 'testing.scope');
  assert.deepEqual([row.global.state, row.repo.state, row.winner, row.value], ['ignored', 'set', 'repo', 'focused']);
  assert.equal(read({ global: { testing: { scope: 'thorough' } } }).rows.find((x) => x.key === 'testing.scope').winner, 'default');
});

test('a both-layer key has no winner, is on only by the answer, and never beats', () => {
  const alone = read({ repo: { workflow: { use_workflows: true } }, answers: { 'workflow.use_workflows': { on: false } } });
  const row = rowOf(alone, 'workflow.use_workflows');
  assert.deepEqual([row.value, row.winner, row.repo.state, row.global.state], [false, null, 'set', 'unset']);
  const both = read({
    global: { workflow: { use_workflows: true } }, repo: { workflow: { use_workflows: false } },
    answers: { 'workflow.use_workflows': { on: true } },
  });
  assert.equal(rowOf(both, 'workflow.use_workflows').value, true);
  assert.equal(both.totals.beating, 0);
});

test('review.reviewers drops a cross-model name the global layer does not name', () => {
  let r = read({ repo: { review: { reviewers: ['claude-subagent', 'openai'] } } });
  assert.deepEqual([rowOf(r, 'review.reviewers').value, rowOf(r, 'review.reviewers').dropped], [['claude-subagent'], ['openai']]);
  r = read({ repo: { review: { reviewers: ['openai'] } } });
  assert.deepEqual(rowOf(r, 'review.reviewers').value, ['claude-subagent']);
  r = read({ global: { review: { reviewers: ['openai'] } }, repo: { review: { reviewers: ['claude-subagent', 'openai'] } } });
  assert.deepEqual([rowOf(r, 'review.reviewers').value, rowOf(r, 'review.reviewers').dropped],
    [['claude-subagent', 'openai'], undefined]);
});

test('a layer in tornLayers reads unreadable, names the file and is never counted as 0', () => {
  const r = read({ global: '{ not json', repo: { a: { x: 5 } } });
  assert.deepEqual(r.unreadable, [{ layer: 'global', file: GLOBAL }]);
  assert.deepEqual(rowOf(r, 'a.x').global, { state: 'unreadable', file: GLOBAL });
  assert.deepEqual([r.totals.global, r.totals.beating, r.totals.repo], ['unreadable', 'unreadable', 1]);
  assert.equal(rowOf(r, 'a.x').winner, 'repo');
});

test('a hostile __proto__ leaf stays inert and is named, not counted', () => {
  const r = read({ repo: '{"__proto__": {"polluted": 1}, "a": {"x": 2}}' });
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(rowOf(r, 'a.x')), Object.prototype);
  assert.equal(rowOf(r, 'a.x').value, 2);
  assert.equal(r.totals.repo, 1);
  assert.match(r.warnings.join('\n'), /__proto__\.polluted/);
});

test('retired and unknown keys stay out of every count and come back as warnings', () => {
  const r = read({ repo: { stakes: 'x', bogus: 1, a: { x: 3 } } });
  assert.equal(r.totals.repo, 1);
  assert.match(r.warnings.join('\n'), /"stakes" was retired/);
  assert.match(r.warnings.join('\n'), /"bogus" is not a setting/);
});

test('a stored value that is not a model id reads as null and is named', () => {
  const r = read({ repo: { model: { m: 'a b' } } });
  assert.equal(rowOf(r, 'model.m').value, null);
  assert.equal(rowOf(r, 'model.m').unusable, true);
  assert.match(r.warnings.join('\n'), /model\.m: the stored value is not a model id/);
});

test('groups come in walk order, shown rows by position and Advanced rows last', () => {
  const r = read({});
  assert.deepEqual(r.groups.map((g) => [g.n, g.name, g.settings, g.advanced]), [[1, 'One', 4, 0], [2, 'Two', 6, 1]]);
  assert.deepEqual(r.rows.filter((x) => x.group === 'Two').map((x) => x.key).at(-1), 'b.z');
});

test('every row carries whether it applies, and a failed condition is named from the value in force', () => {
  const keys = {
    ...SCHEMA,
    'a.gate': { type: 'enum', values: ['off', 'on'], default: 'off', section: 'One', position: 10, question: 'g?' },
    'a.tier': { type: 'string', default: 't', section: 'One', position: 11, question: 't?',
      applies_when: [{ key: 'a.gate', not: 'off' }, { key: 'review.reviewers', not: ['claude-subagent'] }, { key: 'a.gone', is: 1 }] },
  };
  const run = (repo) => {
    const repoFile = join(tmp, 'repo.json');
    rmSync(GLOBAL, { force: true });
    writeFileSync(repoFile, JSON.stringify(repo));
    return layerRows({ keys, merged: mergeLayers(repoFile), files: { repo: repoFile, global: GLOBAL }, both: {} });
  };
  const closed = rowOf(run({}), 'a.tier');
  assert.deepEqual([closed.applies, closed.no_effect], [false, ['a.gate is off', 'review.reviewers is ["claude-subagent"]']]);
  assert.equal(rowOf(run({}), 'a.x').applies, true);
  assert.equal(Object.hasOwn(rowOf(run({}), 'a.x'), 'no_effect'), false);
  // the repo alone cannot name a cross-model reviewer, so route drops it; the unknown a.gone condition is never read
  const open = rowOf(run({ a: { gate: 'on' }, review: { reviewers: ['openai'] } }), 'a.tier');
  assert.deepEqual(open.no_effect, ['review.reviewers is ["claude-subagent"]']);
});

// --- the CLI, on the shipped schema ------------------------------------------

function repoFixture(repo, global) {
  const root = mkdtempSync(join(tmp, 'cli-'));
  mkdirSync(join(root, '.planning'));
  if (repo !== undefined) {
    writeFileSync(join(root, '.planning', 'config.json'), typeof repo === 'string' ? repo : JSON.stringify(repo));
  }
  const g = join(root, 'g.json');
  if (global !== undefined) writeFileSync(g, typeof global === 'string' ? global : JSON.stringify(global));
  return { root, g };
}
function cli({ root, g }, args) {
  const env = { ...process.env, CADENCE_GLOBAL_CONFIG: g };
  let stdout;
  try { stdout = execFileSync('node', [CONFIG, ...args], { encoding: 'utf8', env, cwd: root }); }
  catch (e) { stdout = e.stdout; }
  return { raw: stdout, json: JSON.parse(stdout) };
}
const TEMPLATE = join(ROOT, 'cadence-core', 'templates', 'config.json');
function templateFixture(global) {
  const f = repoFixture(undefined, global);
  copyFileSync(TEMPLATE, join(f.root, '.planning', 'config.json'));
  return f;
}

test('layers: use_workflows set in only the repo reads off with no winner; a repo test_command reads ignored', () => {
  const f = repoFixture({ workflow: { use_workflows: true, test_command: 'make' } }, { workflow: { test_command: 'npm t' } });
  const { json } = cli(f, ['layers', '--key', 'workflow.use_workflows']);
  assert.deepEqual([json.row.value, json.row.winner], [false, null]);
  assert.equal(json.row.repo.state, 'set');
  const t = cli(f, ['layers', '--key', 'workflow.test_command']).json.row;
  assert.deepEqual([t.repo.state, t.value, t.winner], ['ignored', 'npm t', 'global']);
});

test('layers: a fresh template repo sets 43, all 43 the shipped default', () => {
  const { json } = cli(templateFixture(), ['layers']);
  assert.equal(json.totals.settings, 101);
  assert.equal(json.totals.repo, 43);
  assert.equal(json.totals.at_default, 43);
  assert.equal(json.totals.global, 0);
  assert.equal(json.groups.length, 6);
});

test('layers: a corrupt global file is named as unreadable and no global count says 0', () => {
  const f = templateFixture('{ nope');
  const { json } = cli(f, ['layers']);
  assert.deepEqual(json.unreadable, [{ layer: 'global', file: f.g }]);
  assert.equal(json.totals.global, 'unreadable');
  assert.ok(json.groups.every((g) => g.global === 'unreadable'));
  assert.equal(json.totals.repo, 43);
});

test('layers: each row value equals config.mjs get, group totals sum, and the selectors cover every key once', () => {
  const f = repoFixture(
    { granularity: 'fine', git: { create_tag: false }, review: { mode: 'adjudicated' }, workflow: { max_plan_tasks: 5 } },
    { granularity: 'coarse', git: { create_tag: true, on_land_cleanup: false }, parallelization: { enabled: false } },
  );
  const bare = cli(f, ['layers']).json;
  for (const k of ['settings', 'advanced', 'repo', 'global', 'beating', 'at_default']) {
    assert.equal(bare.groups.reduce((n, g) => n + g[k], 0), bare.totals[k], k);
  }
  const seen = [];
  let shown = 0;
  for (const g of bare.groups) {
    const a = cli(f, ['layers', '--group', g.name]).json;
    const adv = cli(f, ['layers', '--group', g.name, '--advanced']).json;
    assert.deepEqual(adv.rows.map((r) => r.key), a.advanced, g.name);
    assert.ok(adv.rows.every((r) => typeof r.purpose === 'string'), g.name);
    seen.push(...a.rows.map((r) => r.key), ...adv.rows.map((r) => r.key));
    shown += a.rows.length;
    const got = cli(f, ['get', ...a.rows.map((r) => r.key)]).json.values;
    for (const r of a.rows) {
      // review.reviewers is the one row `get` cannot match: it also drops the names global does not list
      if (r.key !== 'review.reviewers') assert.deepEqual(r.value, got[r.key], r.key);
    }
  }
  const all = Object.keys(cli(f, ['keys']).json.keys);
  assert.deepEqual([...seen].sort(), [...all].sort());
  assert.equal(new Set(seen).size, all.length);
  assert.equal(shown + bare.totals.advanced, all.length);
  assert.ok(Math.max(...bare.groups.map((g) => g.settings - g.advanced)) <= 16);
});

test('layers: the bare, group and Advanced answers stay under the 10,000 B threshold', () => {
  const f = templateFixture({ granularity: 'coarse' });
  const bare = cli(f, ['layers']);
  assert.ok(bare.raw.length < 10000, `bare ${bare.raw.length}`);
  for (const g of bare.json.groups) {
    for (const extra of [[], ['--advanced']]) {
      const r = cli(f, ['layers', '--group', g.name, ...extra]);
      assert.ok(r.raw.length < 10000, `${g.name} ${extra} ${r.raw.length}`);
    }
  }
});

test('layers: a key answer carries the setting text', () => {
  const { json } = cli(templateFixture(), ['layers', '--key', 'git.auto_close']);
  assert.deepEqual([json.row.type, json.row.src], ['bool', 'repo']);
  assert.equal(typeof json.row.question, 'string');
  assert.equal(typeof json.row.purpose, 'string');
  assert.ok(Array.isArray(json.row.explain));
});

const OPEN_DIFF = { review: { triggers: { diff: { gate: 'blocking' } } } };
const tierOf = (f) => cli(f, ['layers', '--key', 'review.triggers.diff.tier']).json.row;

test('layers: the diff tier has no effect with the gate unset, naming the gate', () => {
  const r = tierOf(repoFixture({}));
  assert.equal(r.applies, false);
  assert.deepEqual(r.no_effect, ['review.triggers.diff.gate is off', 'review.reviewers is ["claude-subagent"]']);
});

test('layers: an open gate with no reviewer named still has no effect, naming the reviewers', () => {
  const r = tierOf(repoFixture(OPEN_DIFF));
  assert.deepEqual([r.applies, r.no_effect], [false, ['review.reviewers is ["claude-subagent"]']]);
});

test('layers: an open gate with openai in both layers applies; in the repo alone it does not', () => {
  const withOpenai = { review: { ...OPEN_DIFF.review, reviewers: ['openai'] } };
  const both = tierOf(repoFixture(withOpenai, withOpenai));
  assert.deepEqual([both.applies, both.no_effect], [true, undefined]);
  const repoOnly = tierOf(repoFixture(withOpenai));
  assert.deepEqual([repoOnly.applies, repoOnly.no_effect], [false, ['review.reviewers is ["claude-subagent"]']]);
});

test('layers: the mapper keys have no effect with the code map off, apply with it on, and sit in Models and effort\'s advanced list', () => {
  for (const key of ['roles.cad-mapper.model', 'roles.cad-mapper.effort']) {
    const off = cli(repoFixture({}), ['layers', '--key', key]).json.row;
    assert.deepEqual([off.applies, off.no_effect], [false, ['planning.code_map is false, not true']], key);
    const on = cli(repoFixture({ planning: { code_map: true } }), ['layers', '--key', key]).json.row;
    assert.deepEqual([on.applies, on.no_effect], [true, undefined], key);
  }
  const adv = cli(repoFixture({}), ['layers', '--group', 'Models and effort']).json.advanced;
  assert.ok(adv.includes('roles.cad-mapper.model') && adv.includes('roles.cad-mapper.effort'), JSON.stringify(adv));
});

test('layers: workflow_plans sits in How work runs\' advanced list and applies with the code map off', () => {
  const adv = cli(repoFixture({}), ['layers', '--group', 'How work runs']).json.advanced;
  assert.ok(adv.includes('planning.workflow_plans'), JSON.stringify(adv));
  const row = cli(repoFixture({}), ['layers', '--key', 'planning.workflow_plans']).json.row;
  assert.deepEqual([row.applies, row.no_effect], [true, undefined]);
  assert.ok(adv.includes('workflow.execute_workflows'), JSON.stringify(adv));
});

test('layers: the gate works with its tier and effort, and the other trigger keys carry the same conditions', () => {
  const { json } = cli(repoFixture(OPEN_DIFF), ['layers', '--key', 'review.triggers.diff.gate']);
  assert.deepEqual(json.row.works_with, [{ key: 'review.triggers.diff.tier', value: 'cheap' },
    { key: 'review.triggers.diff.effort', value: 'minimal' }]);
  assert.match(json.row.interacts, /Who reviews decides whether this review's tier and effort are read/);
  const reviewers = cli(repoFixture({}), ['layers', '--key', 'review.reviewers']).json.row;
  assert.equal(reviewers.works_with.length, 8);
  for (const t of ['plan', 'risk_surface', 'phase_diff']) {
    assert.equal(cli(repoFixture({}), ['layers', '--key', `review.triggers.${t}.effort`]).json.row.applies, false);
  }
});

test('layers: execute_workflows set in only the repo has both true and reads off; set in both it reads on', () => {
  const alone = cli(repoFixture({ workflow: { execute_workflows: true } }), ['layers', '--key', 'workflow.execute_workflows']).json.row;
  assert.deepEqual([alone.both, alone.value], [true, false]);
  const both = cli(repoFixture({ workflow: { execute_workflows: true } }, { workflow: { execute_workflows: true } }),
    ['layers', '--key', 'workflow.execute_workflows']).json.row;
  assert.deepEqual([both.both, both.value], [true, true]);
});

test('layers: a both-layer key and the parallel keys say what they need in interacts', () => {
  const f = repoFixture({});
  for (const [key, re] of [['git.auto_close', /both set it/], ['workflow.use_workflows', /both set it/],
    ['workflow.multi_workflow', /both set it/], ['workflow.execute_workflows', /both set it/],
    ['parallelization.enabled', /worktree\.baseRef/],
    ['parallelization.use_worktrees', /worktree\.baseRef/]]) {
    assert.match(cli(f, ['layers', '--key', key]).json.row.interacts, re, key);
  }
});

test('layers: every refusal names a next step', () => {
  const f = templateFixture();
  for (const args of [['layers', '--group', 'Nope'], ['layers', '--key', 'nope.key'], ['layers', '--advanced'],
    ['layers', '--group'], ['layers', 'stray'], ['layers', '--group', 'Testing', '--key', 'granularity']]) {
    const { json } = cli(f, args);
    assert.equal(json.ok, false, args.join(' '));
    assert.equal(typeof json.hint, 'string', args.join(' '));
  }
});

test('catalog: every schema key with exactly the matching fields, values equal to the layer read, smaller than keys', () => {
  const f = repoFixture(
    { granularity: 'fine', git: { create_tag: false }, review: { mode: 'adjudicated' } },
    { granularity: 'coarse', git: { create_tag: true }, workflow: { use_workflows: true } },
  );
  const cat = cli(f, ['catalog']);
  const all = Object.keys(cli(f, ['keys']).json.keys);
  assert.deepEqual(cat.json.settings.map((r) => r.key).sort(), [...all].sort());
  for (const k of ['review.providers.openai.tiers.flagship', 'workflow.max_plan_bytes']) {
    assert.ok(cat.json.settings.some((r) => r.key === k), k);
  }
  for (const r of cat.json.settings) assert.deepEqual(Object.keys(r), ['key', 'label', 'question', 'purpose', 'explain', 'value'], r.key);
  const read = {};
  for (const g of cli(f, ['layers']).json.groups) {
    for (const extra of [[], ['--advanced']]) {
      for (const r of cli(f, ['layers', '--group', g.name, ...extra]).json.rows) read[r.key] = r.value;
    }
  }
  for (const r of cat.json.settings) assert.deepEqual(r.value, read[r.key], r.key);
  assert.equal(cat.json.settings.find((r) => r.key === 'granularity').value, 'fine');
  assert.ok(cat.raw.length < cli(f, ['keys']).raw.length, `${cat.raw.length}`);
});

test('layers: every row carries the schema label, and an Advanced row is only key, label, value, winner and purpose', () => {
  const f = repoFixture({ granularity: 'fine' }, { git: { create_tag: true } });
  const schema = cli(f, ['keys']).json.keys;
  let advanced = 0;
  for (const g of cli(f, ['layers']).json.groups) {
    for (const r of cli(f, ['layers', '--group', g.name]).json.rows) assert.equal(r.label, schema[r.key].label, r.key);
    for (const r of cli(f, ['layers', '--group', g.name, '--advanced']).json.rows) {
      assert.deepEqual(Object.keys(r), ['key', 'label', 'value', 'winner', 'purpose'], r.key);
      assert.equal(r.label, schema[r.key].label, r.key);
      advanced += 1;
    }
  }
  assert.ok(advanced > 0);
  for (const k of ['granularity', 'workflow.max_plan_bytes']) {
    assert.equal(cli(f, ['layers', '--key', k]).json.row.label, schema[k].label, k);
  }
});

test('get and keys --walk keep their output', () => {
  const f = templateFixture();
  const walk = cli(f, ['keys', '--walk']).raw;
  assert.ok(walk.length < 25000, `${walk.length}`);
  const got = cli(f, ['get', 'granularity']).json;
  assert.deepEqual(Object.keys(got).sort(), ['ok', 'source', 'values']);
});

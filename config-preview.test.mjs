// Zero-dep tests for `config.mjs preview` and lib/config-preview.mjs: what a set would do, with nothing written (AC6).
// The pure cases need no process. The CLI cases run the real command over temp repos with a phase cursor and a plan
// declaring an auth file, so route's risk floor is raised on the real tree and a scratch copy would report false changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderCursor } from '../cadence-core/bin/lib/planning-files.mjs';
import { appliesFlips, diffDecision, rolesFor, targetLayer } from '../cadence-core/bin/lib/config-preview.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = join(ROOT, 'cadence-core', 'bin', 'config.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'cad-preview-test-'));
let n = 0;

const AUTH = { review: { triggers: { risk_surface: { surfaces: ['auth'] } } } };

/** A repo with a cursor at phase 3 and a plan declaring an auth file; `repo` and `global` are config bodies or raw text. */
function fixture({ repo, global } = {}) {
  const root = join(tmp, `repo-${++n}`);
  const planning = join(root, '.planning');
  mkdirSync(join(planning, 'phases', '3'), { recursive: true });
  const body = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
  if (repo !== undefined) writeFileSync(join(planning, 'config.json'), body(repo));
  writeFileSync(join(planning, 'STATE.md'), renderCursor({
    phase: 3, total: 5, name: 'Fixture', status: 'planned', next: '/cad-execute 3', updated: '2026-01-01',
  }));
  writeFileSync(join(planning, 'phases', '3', 'PLAN-1.md'),
    '---\nphase: 3\nplan: 1\nrequirements:\n  - X-01\nfiles:\n  - src/auth/session.rs\n---\n\n# Plan\n');
  const g = join(root, 'global', 'config.json');
  if (global !== undefined) { mkdirSync(dirname(g), { recursive: true }); writeFileSync(g, body(global)); }
  return { root, g, repoFile: join(planning, 'config.json') };
}

function preview(f, ...tokens) {
  const env = { ...process.env, CADENCE_GLOBAL_CONFIG: f.g };
  let stdout;
  try { stdout = execFileSync(process.execPath, [CONFIG, 'preview', ...tokens], { encoding: 'utf8', env, cwd: f.root }); }
  catch (e) { stdout = e.stdout; }
  return JSON.parse(stdout);
}

/** Every file under the fixture, and the global file, as path -> sha256. */
function hashes(f) {
  const out = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[p] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  };
  walk(f.root);
  return out;
}

const THREE = { review: { reviewers: ['openai'], providers: { openai: { tiers: { cheap: 'gpt-x' } } } } };
const fileOf = (r, layer) => r.files.find((x) => x.layer === layer);

test('pure: a key lands in the global file only for src: global', () => {
  assert.equal(targetLayer({ src: 'global' }), 'global');
  assert.equal(targetLayer({ src: 'repo' }), 'repo');
  assert.equal(targetLayer({ repo_only: true }), 'repo');
  assert.equal(targetLayer({}), 'repo');
});

test('pure: roles.<role>.* resolves that role and any review.* resolves the reviewer, once each', () => {
  assert.deepEqual(rolesFor(['roles.cad-planner.model', 'roles.cad-planner.effort', 'git.create_tag']), ['cad-planner']);
  assert.deepEqual(rolesFor(['review.mode', 'review.request_timeout_ms']), ['cad-reviewer']);
  assert.deepEqual(rolesFor(['workflow.test_command']), []);
});

test('pure: a decision diff names the leaf under an object field and never reads reason or warnings', () => {
  const before = { ok: true, effort: 'low', review: { plan: 'advisory', diff: 'off' }, reason: ['a'], warnings: ['w'] };
  const after = { ok: true, effort: 'low', review: { plan: 'advisory', diff: 'adjudicated' }, reason: ['b'] };
  assert.deepEqual(diffDecision(before, after), [{ field: 'review.diff', before: 'off', after: 'adjudicated' }]);
});

test('pure: an applies flip names why a stop stopped and why a start had not started', () => {
  const rows = (a, why) => ({ k: { applies: a, no_effect: why } });
  assert.deepEqual(appliesFlips(['k'], rows(false, ['gate is off']), rows(true, [])), { starts: [{ key: 'k', why: ['gate is off'] }], stops: [] });
  assert.deepEqual(appliesFlips(['k'], rows(true, []), rows(false, ['gate is off'])), { starts: [], stops: [{ key: 'k', why: ['gate is off'] }] });
  assert.deepEqual(appliesFlips(['k'], rows(true, []), rows(true, [])), { starts: [], stops: [] });
});

test('a preview leaves every file, trace.jsonl included, byte-identical', () => {
  const f = fixture({ repo: { ...AUTH, ...THREE }, global: { review: { reviewers: ['openai'] } } });
  writeFileSync(join(f.root, '.planning', 'trace.jsonl'), '{"keep":1}\n');
  const before = hashes(f);
  const r = preview(f, 'review.triggers.diff.gate=adjudicated', 'workflow.test_command=x', 'roles.cad-planner.effort=low');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(hashes(f), before);
  // the negative control: a call that does record changes the trace, so the hash compare can fail
  execFileSync(process.execPath, [join(ROOT, 'cadence-core', 'bin', 'route.mjs'), 'resolve', '--role', 'cad-reviewer',
    '--file', f.repoFile], { encoding: 'utf8', env: { ...process.env, CADENCE_GLOBAL_CONFIG: f.g }, cwd: f.root });
  assert.notDeepEqual(hashes(f), before);
});

test('the diff gate to adjudicated names the repo file, the route change and the tier and effort starting', () => {
  const f = fixture({ repo: { ...AUTH, ...THREE }, global: { review: { reviewers: ['openai'] } } });
  const r = preview(f, 'review.triggers.diff.gate=adjudicated');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.files.length, 1);
  const repo = fileOf(r, 'repo');
  assert.equal(repo.file, f.repoFile);
  assert.deepEqual([repo.pairs[0].key, repo.pairs[0].before, repo.pairs[0].after], ['review.triggers.diff.gate', 'off', 'adjudicated']);
  const reviewer = r.resolves.find((x) => x.role === 'cad-reviewer');
  assert.ok(reviewer.changes.some((c) => c.field === 'review.diff' && c.before === 'off' && c.after === 'adjudicated'), JSON.stringify(reviewer));
  const started = r.starts.map((s) => s.key).sort();
  assert.deepEqual(started, ['review.triggers.diff.effort', 'review.triggers.diff.tier']);
  assert.deepEqual(r.stops, []);
});

test('use_workflows=true with no global names the global file and says it stays off; with global true it turns on', () => {
  const alone = fixture({ repo: { ...AUTH } });
  const r = preview(alone, 'workflow.use_workflows=true');
  const pair = fileOf(r, 'repo').pairs[0];
  assert.deepEqual([pair.before, pair.after], [false, false]);
  assert.deepEqual(pair.second_file, { layer: 'global', file: alone.g });
  assert.equal(pair.stays_off, true);
  const both = fixture({ repo: { ...AUTH }, global: { workflow: { use_workflows: true } } });
  const on = fileOf(preview(both, 'workflow.use_workflows=true'), 'repo').pairs[0];
  assert.deepEqual([on.before, on.after], [false, true]);
  assert.equal('second_file' in on, false);
  assert.equal('stays_off' in on, false);
});

test('git.auto_close=false over a repo true shows the file storing true then false, off in force on both sides', () => {
  const f = fixture({ repo: { ...AUTH, git: { auto_close: true } } });
  const pair = fileOf(preview(f, 'git.auto_close=false'), 'repo').pairs[0];
  assert.deepEqual([pair.before, pair.after], [false, false]);
  assert.deepEqual([pair.stored.before.value, pair.stored.after.value], [true, false]);
  assert.equal('second_file' in pair, false);
});

test('a mixed batch reports a file each: test_command to the global file, create_tag to the repo file', () => {
  const f = fixture({ repo: { ...AUTH }, global: {} });
  const r = preview(f, 'workflow.test_command=x', 'git.create_tag=false');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.files.length, 2);
  assert.deepEqual(fileOf(r, 'global').pairs.map((p) => [p.key, p.after]), [['workflow.test_command', 'x']]);
  assert.equal(fileOf(r, 'global').file, f.g);
  assert.deepEqual(fileOf(r, 'repo').pairs.map((p) => [p.key, p.after]), [['git.create_tag', false]]);
});

test('a review.* key route runs on both sides reports no change to the plan review or verify, with the floor raised', () => {
  const f = fixture({ repo: { ...AUTH } });
  const r = preview(f, 'review.request_timeout_ms=600000');
  assert.equal(r.ok, true, JSON.stringify(r));
  const reviewer = r.resolves.find((x) => x.role === 'cad-reviewer');
  assert.deepEqual(reviewer.changes, []);
  // the floor really is raised on the real tree: a read off the scratch copy would have said otherwise on one side only
  const env = { ...process.env, CADENCE_GLOBAL_CONFIG: f.g };
  const route = JSON.parse(execFileSync(process.execPath, [join(ROOT, 'cadence-core', 'bin', 'route.mjs'), 'resolve',
    '--role', 'cad-reviewer', '--file', f.repoFile, '--no-record'], { encoding: 'utf8', env, cwd: f.root }));
  assert.equal(route.review.plan, 'blocking');
  assert.equal(route.verify, 'on');
});

test('narrowing the surfaces off the declared auth file lowers the floor, read off the real plans', () => {
  const f = fixture({ repo: { ...AUTH } });
  const r = preview(f, 'review.triggers.risk_surface.surfaces=["billing"]');
  assert.equal(r.ok, true, JSON.stringify(r));
  const changes = r.resolves.find((x) => x.role === 'cad-reviewer').changes;
  assert.ok(changes.some((c) => c.field === 'review.plan' && c.before === 'blocking' && c.after === 'advisory'), JSON.stringify(changes));
  assert.ok(changes.some((c) => c.field === 'verify' && c.before === 'on' && c.after === 'off'), JSON.stringify(changes));
});

test('a retired key and a bad value are refused as set refuses them', () => {
  const f = fixture({ repo: { ...AUTH } });
  const retired = preview(f, 'model.effort.cad-planner=low');
  assert.deepEqual([retired.ok, retired.reason], [false, 'invalid']);
  assert.match(JSON.stringify(retired.detail), /retired/);
  const bad = preview(f, 'git.create_tag=maybe');
  assert.deepEqual([bad.ok, bad.reason], [false, 'invalid']);
  const none = preview(f);
  assert.deepEqual([none.ok, none.reason], [false, 'usage']);
});

test('a torn layer is refused naming the file, and a missing repo config is refused for a repo key', () => {
  const torn = fixture({ repo: { ...AUTH }, global: '{ nope' });
  const r = preview(torn, 'git.create_tag=false');
  assert.deepEqual([r.ok, r.reason], [false, 'read']);
  assert.ok(r.detail.includes(torn.g), r.detail);
  const tornRepo = fixture({ repo: '{ nope' });
  assert.ok(preview(tornRepo, 'git.create_tag=false').detail.includes(tornRepo.repoFile));
  const none = fixture({});
  const missing = preview(none, 'git.create_tag=false');
  assert.deepEqual([missing.ok, missing.reason], [false, 'read']);
  assert.ok(missing.detail.includes(none.repoFile));
  // a global-only batch needs no repo config
  assert.equal(preview(none, 'workflow.test_command=x').ok, true);
});

test('a refusal by the scratch set names the real config file, never the deleted scratch copy', () => {
  const repo = fixture({ repo: { review: 'x' } });
  const r = preview(repo, 'review.request_timeout_ms=600000');
  assert.deepEqual([r.ok, r.reason], [false, 'invalid']);
  assert.ok(r.hint.includes(repo.repoFile), r.hint);
  assert.doesNotMatch(JSON.stringify(r), /\/cad-preview-(?!test-)/);
  const glob = fixture({ repo: { ...AUTH }, global: { workflow: 'x' } });
  const g = preview(glob, 'workflow.test_command=y');
  assert.deepEqual([g.ok, g.reason], [false, 'invalid']);
  assert.ok(g.hint.includes(glob.g), g.hint);
  assert.doesNotMatch(JSON.stringify(g), /\/cad-preview-(?!test-)/);
});

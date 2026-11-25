// Zero-dep tests for what an agile start asks before it writes: agile.mjs check, and the start it holds back.
// Run: node --test tests/agile-setup.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerSetup, scratch } from './planning.test.mjs';
import { markAgile } from '../cadence-core/bin/lib/project-state.mjs';
import { namedReviewers, unanswered } from '../cadence-core/bin/lib/agile-setup.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGILE = join(HERE, '..', 'cadence-core', 'bin', 'agile.mjs');
const FIXTURE = join(HERE, 'fixtures', 'seldon-design');

const WHO = { GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@b.c', GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@b.c' };
// git would otherwise guess an identity from the machine's own name
const NOBODY = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'user.useConfigOnly', GIT_CONFIG_VALUE_0: 'true', EMAIL: '' };

/** One agile.mjs call with no user-global config unless the case writes one. */
function run(dir, args, { global = join(dir, 'no-global.json'), env = WHO, cwd = undefined } = {}) {
  const base = { ...process.env };
  for (const key of [...Object.keys(WHO), ...Object.keys(NOBODY)]) delete base[key];
  const r = spawnSync('node', [AGILE, ...args, '--dir', dir], { encoding: 'utf8', cwd, env: { ...base, CADENCE_GLOBAL_CONFIG: global, ...env } });
  return { ...JSON.parse(r.stdout), _exit: r.status };
}
const check = (dir, opts = {}) => run(dir, ['check', '--design', opts.design ?? FIXTURE], opts);
const start = (dir, opts = {}) => run(dir, ['start', '--design', FIXTURE], opts);
const planning = (t) => join(scratch('cad-agile-setup-', t), '.planning');
const tree = (root) => readdirSync(root, { recursive: true }).map(String).sort()
  .map((p) => [p, statSync(join(root, p)).mtimeMs, statSync(join(root, p)).isFile() ? readFileSync(join(root, p), 'utf8') : '']);

test('with nothing answered, check names every question with what it needs to be asked, start refuses, and neither writes', (t) => {
  const dir = planning(t);
  const r = check(dir);
  assert.deepEqual([r.ok, r._exit, r.release, r.epics], [true, 0, 'Toolshed', 3], JSON.stringify(r));
  assert.deepEqual(r.unanswered, ['forge', 'surfaces', 'testing']);
  assert.equal(r.surfaces[0].surfaces.length, 8);
  assert.deepEqual(r.constraints.map((d) => [d.id, d.kind]), [['S-04', 'stack'], ['S-05', 'hosting']]);
  const refused = start(dir);
  assert.deepEqual([refused.ok, refused._exit, refused.reason], [false, 1, 'setup-unanswered']);
  for (const name of r.unanswered) assert.ok(refused.detail.includes(name), refused.detail);
  assert.match(refused.hint, /\/cad-agile --brief/);
  assert.deepEqual(readdirSync(dirname(dir)), []);
});

test('on a Seldon project nothing is stamped by the check', (t) => {
  const dir = planning(t);
  cpSync(FIXTURE, join(dir, 'seldon'), { recursive: true });
  const before = tree(dir);
  assert.deepEqual(check(dir, { design: join(dir, 'seldon') }).unanswered, ['forge', 'surfaces', 'testing']);
  assert.deepEqual(tree(dir), before);
});

test('with everything answered, check has nothing to ask and start goes ahead', (t) => {
  const dir = answerSetup(planning(t));
  const before = tree(dir);
  const r = check(dir);
  assert.deepEqual([r.ok, r.unanswered, r.surfaces, r.constraints], [true, [], undefined, undefined], JSON.stringify(r));
  assert.deepEqual(r.reviewers, { list: ['claude-subagent'], outside: [], dropped: [], warnings: [] });
  assert.deepEqual(tree(dir), before);
  assert.equal(start(dir).ok, true);
});

test('a start cut short after its marker still checks clean, so the next one asks nothing again', (t) => {
  const dir = answerSetup(planning(t));
  assert.equal(markAgile(dir).ok, true);
  assert.deepEqual(check(dir).unanswered, []);
  assert.equal(start(dir).ok, true);
});

test('a question is answered only by the layer that may answer it, and half a forge is no forge', () => {
  /** @type {[string, any, string[]][]} */
  const cases = [
    ['no config', {}, ['forge', 'surfaces', 'testing']],
    ['a provider with no repository', { git: { forge_provider: 'github' } }, ['forge', 'surfaces', 'testing']],
    ['forgejo with no host', { git: { forge_provider: 'forgejo', forge_repo: 'a/b' } }, ['forge', 'surfaces', 'testing']],
    ['forgejo whole', { git: { forge_provider: 'forgejo', forge_repo: 'a/b', forge_host: 'f.example.com' } }, ['surfaces', 'testing']],
    ['a mistyped surface', { review: { triggers: { risk_surface: { surfaces: ['auth', 'secret'] } } } }, ['forge', 'surfaces', 'testing']],
    ['an empty surface list', { review: { triggers: { risk_surface: { surfaces: [] } } } }, ['forge', 'surfaces', 'testing']],
    ['a scope that is not one', { testing: { scope: 'some' } }, ['forge', 'surfaces', 'testing']],
    ['a scope', { testing: { scope: 'thorough' } }, ['forge', 'surfaces']],
    ['sections that are not objects', { git: 'x', review: [], testing: null }, ['forge', 'surfaces', 'testing']],
  ];
  for (const [name, config, want] of cases) assert.deepEqual(unanswered(config), want, name);
});

test('a user-global testing policy accepts nothing for a project, a user-global provider is half a forge, and user-global surfaces count', (t) => {
  const dir = planning(t);
  const global = join(scratch('cad-agile-global-', t), 'config.json');
  writeFileSync(global, JSON.stringify({ git: { forge_provider: 'github' }, testing: { scope: 'focused' },
    review: { triggers: { risk_surface: { surfaces: ['auth'] } } } }));
  assert.deepEqual(check(dir, { global }).unanswered, ['forge', 'testing']);
});

test('every refusal of a check leaves the tree exactly as it was', (t) => {
  const broken = join(scratch('cad-agile-broken-', t), 'design');
  cpSync(FIXTURE, broken, { recursive: true });
  rmSync(join(broken, 'brief.md'));
  const put = (d, name, text) => { mkdirSync(d, { recursive: true }); writeFileSync(join(d, name), text); };
  /** @type {[string, string, (dir: string) => void, object?][]} */
  const cases = [
    ['a bad design', 'design-refused', () => {}, { design: broken }],
    ['no design folder', 'no-design-dir', () => {}, { design: join(broken, 'nowhere') }],
    ['an old-path project', 'old-path', (d) => put(d, 'PROJECT.md', 'x\n')],
    ['a release already open', 'release-open', (d) => { assert.equal(start(answerSetup(d)).ok, true); }],
    ['a config that does not parse', 'config-unreadable', (d) => put(d, 'config.json', '{torn')],
    ['a git with nobody to commit as', 'no-git-identity', () => {}, { env: NOBODY }],
  ];
  for (const [name, reason, build, opts] of cases) {
    const dir = planning(t);
    build(dir);
    const root = dirname(dir);
    const before = tree(root);
    const r = check(dir, opts);
    assert.deepEqual([r.ok, r._exit, r.reason], [false, 1, reason], `${name}: ${JSON.stringify(r)}`);
    assert.ok(r.hint, name);
    assert.deepEqual(tree(root), before, name);
  }
  assert.ok(check(planning(t), { design: broken }).issues.length, 'a refused design names its issues');
  assert.match(check(planning(t), { env: NOBODY }).hint, /user\.name.*user\.email/);
});

test('an outside reviewer no firing review would run is dropped, and one a single review would run is not', (t) => {
  const dir = answerSetup(planning(t));
  const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  config.review.reviewers = ['claude-subagent', 'openai', 'gemini'];
  config.review.providers = { openai: { tiers: { flagship: 'gpt-x' } } };
  config.review.triggers.risk_surface.tier = 'flagship';
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  const global = join(scratch('cad-agile-global-', t), 'config.json');
  writeFileSync(global, JSON.stringify({ review: { reviewers: ['openai', 'gemini'] } }));
  const named = check(dir, { global }).reviewers;
  assert.deepEqual([named.list, named.outside, named.dropped], [['claude-subagent', 'openai', 'gemini'], ['openai'], ['gemini']]);
  assert.ok(named.warnings.some((w) => w.includes('gemini')), JSON.stringify(named.warnings));
  // nothing user-global names them, so the repository's own list can't run either
  assert.deepEqual(check(dir).reviewers.dropped, ['openai', 'gemini']);
  assert.deepEqual(namedReviewers({ review: { reviewers: ['openai'] } },
    { review: { plan: 'advisory', diff: 'off' }, reviewers: { plan: ['claude-subagent'], diff: ['openai'] } }).dropped, ['openai']);
});

test('a relative planning folder reads its own config, wherever the call is made from', (t) => {
  const root = scratch('cad-agile-rel-', t);
  mkdirSync(join(root, 'elsewhere'));
  answerSetup(join(root, 'project', '.planning'));
  const r = check(join('..', 'project', '.planning'), { cwd: join(root, 'elsewhere'), global: join(root, 'no-global.json') });
  assert.deepEqual([r.ok, r.unanswered, r.reviewers?.list], [true, [], ['claude-subagent']], JSON.stringify(r));
});

test('the command asks for every answer before anything it writes, and commits the settings with the release', () => {
  const workflow = (name) => readFileSync(join(HERE, '..', 'cadence-core', 'workflows', name), 'utf8');
  const prose = workflow('agile-start.md');
  const [check, ask, write] = ['## 1. Check', '## 2. Ask', '## 3. Write'].map((h) => prose.indexOf(h));
  assert.ok(check > 0 && ask > check && write > ask, 'check, ask and write in that order');
  for (const call of ['agile.mjs" check', 'forge.mjs" detect']) {
    assert.ok(prose.indexOf(call) > check && prose.indexOf(call) < ask, `${call} is not in the check`);
  }
  for (const question of ['**Outside reviewers.**', '**Forge**', '**Risk surfaces**', '**Testing policy**', '**The branch**']) {
    assert.ok(prose.indexOf(question) > ask && prose.indexOf(question) < write, `${question} is not asked before the write`);
  }
  for (const call of ['git init', 'git checkout -b', 'mkdir -p .planning', 'config.mjs" set', 'agile.mjs" start']) {
    assert.ok(prose.indexOf(call) > write, `${call} comes before the write, or is gone`);
    assert.equal(prose.indexOf(call), prose.lastIndexOf(call), `${call} is there twice`);
  }
  assert.ok(prose.indexOf('config.mjs" set') < prose.indexOf('agile.mjs" start'), 'the settings go in before the release');
  const command = workflow('agile.md');
  const read = command.indexOf('workflows/agile-start.md');
  const commit = command.slice(command.indexOf('<step name="commit">'), command.indexOf('<step name="report">'));
  assert.ok(read > 0 && read < command.indexOf('<step name="commit">'), 'the start is read before the commit');
  for (const file of ['.planning/config.json', '.github/cadence/coverage-policy.json']) assert.ok(commit.includes(file), file);
});

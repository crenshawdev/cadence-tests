// Zero-dep tests for agile.mjs close - a finished release moved into releases/<version>/, or refused with nothing written.
// Run: node --test tests/agile-close.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerSetup, scratch } from './planning.test.mjs';
import { closingDir, epicFile, releasesDir, storyFile } from '../cadence-core/bin/lib/agile-paths.mjs';
import { readEpicFile, readRequirementsFile } from '../cadence-core/bin/lib/agile-read.mjs';
import { renderStoryFile } from '../cadence-core/bin/lib/agile-render.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGILE = join(HERE, '..', 'cadence-core', 'bin', 'agile.mjs');
const FIXTURE = join(HERE, 'fixtures', 'seldon-design');

const run = (dir, ...args) => {
  const r = spawnSync('node', [AGILE, ...args, '--dir', dir], { encoding: 'utf8' });
  return { ...JSON.parse(r.stdout), _exit: r.status };
};
const agile = (dir) => join(dir, 'agile');
const tree = (root) => readdirSync(root, { recursive: true }).map(String).filter((p) => !p.startsWith('.git')).sort()
  .map((p) => [p, statSync(join(root, p)).mtimeMs, statSync(join(root, p)).isFile() ? readFileSync(join(root, p), 'utf8') : '']);
const send = (dir, payload) => {
  const file = join(dirname(dir), '..', 'close.json');
  writeFileSync(file, typeof payload === 'string' ? payload : JSON.stringify(payload));
  return run(dir, 'close', '--payload', file);
};
const edit = (file, from, to) => writeFileSync(file, readFileSync(file, 'utf8').replace(from, to));

/** A release whose every epic is accepted, each with one done story carrying all its requirements but those `left`. */
function finished(t, left = ['CAT-02']) {
  const root = join(scratch('cad-agile-close-', t), 'repo');
  mkdirSync(root, { recursive: true });
  const dir = answerSetup(join(root, '.planning'));
  assert.equal(run(dir, 'start', '--design', FIXTURE).ok, true);
  for (const id of ['E-01', 'E-02', 'E-03']) {
    edit(epicFile(agile(dir), id), /^status: .*$/m, 'status: done');
    const requirements = readEpicFile(readFileSync(epicFile(agile(dir), id), 'utf8')).requirements.filter((q) => !left.includes(q));
    writeFileSync(storyFile(agile(dir), `${id}-1`), renderStoryFile({ id: `${id}-1`, title: `All of ${id}`, size: 'S', status: 'done', builds_on: [],
      requirements, delivers: 'Everything the epic asks.', accepted_when: ['Running it shows it.'] }));
  }
  return { root, dir };
}
const MOVED = ['REQUIREMENTS.md', 'epics', 'release.md'];

test('a close moves the release into releases/<version>/, leaves the rest, and then no release is open', (t) => {
  const { dir } = finished(t);
  writeFileSync(join(agile(dir), 'backlog.md'), '## Todos\n\n- [ ] a later one\n');
  const before = Object.fromEntries(tree(agile(dir)).map(([p, , text]) => [p, text]));
  const r = send(dir, { version: '0.10.0', defer: ['CAT-02'] });
  assert.deepEqual([r.ok, r.version, r.deferred], [true, '0.10.0', ['CAT-02']], JSON.stringify(r));
  assert.deepEqual(readdirSync(agile(dir)).sort(), ['backlog.md', 'project.md', 'releases']);
  const home = join(releasesDir(agile(dir)), '0.10.0');
  assert.deepEqual(readdirSync(home).sort(), MOVED);
  for (const [p, text] of Object.entries(before)) {
    if (p === 'REQUIREMENTS.md') continue;
    const now = MOVED.some((m) => p === m || p.startsWith(`${m}/`)) ? join(home, p) : join(agile(dir), p);
    assert.equal(statSync(now).isFile() ? readFileSync(now, 'utf8') : '', text, p);
  }
  // the one deferred moved under Deferred, and every other line kept
  const read = readRequirementsFile(readFileSync(join(home, 'REQUIREMENTS.md'), 'utf8'));
  assert.deepEqual(read.deferred.map((q) => q.id), ['CAT-02']);
  assert.equal(read.requirements.some((q) => q.id === 'CAT-02'), false);
  assert.deepEqual(run(dir, 'next'), { ok: true, release: null, next: null, _exit: 0 });
  assert.equal(run(dir, 'close').reason, 'not-closing');
});

test('a close with nothing open takes no defer and leaves REQUIREMENTS.md as it was', (t) => {
  const { dir } = finished(t, []);
  const text = readFileSync(join(agile(dir), 'REQUIREMENTS.md'), 'utf8');
  assert.equal(send(dir, { version: 'v2.0.0' }).ok, true);
  assert.equal(readFileSync(join(releasesDir(agile(dir)), 'v2.0.0', 'REQUIREMENTS.md'), 'utf8'), text);
});

test('a close that can\'t be made is refused naming why, with nothing written', (t) => {
  const { dir } = finished(t);
  const before = tree(dir);
  for (const [payload, words] of [
    [{ version: '0.10.0' }, /CAT-02 is open, so the release can't close without it/],
    [{ version: '0.10.0', defer: ['CAT-01', 'CAT-02'] }, /names CAT-01, which isn't open - those are CAT-02/],
    [{ version: '0.10.0', defer: ['CAT-02', 'CAT-02'] }, /each once/],
    [{ version: '../x', defer: ['CAT-02'] }, /letters, digits and \._\+- only/], [{ version: '-rc', defer: ['CAT-02'] }, /starting with a letter or digit/],
    [{ version: 'a b', defer: ['CAT-02'] }, /letters, digits/], [{ defer: ['CAT-02'] }, /letters, digits/],
    // what git won't take as a tag, though each character is one it would
    ...['1..0', '1.0.', 'x.lock'].map((version) => [{ version, defer: ['CAT-02'] }, /git takes as a tag/]),
    [{ version: '1.0.0', defer: ['CAT-02'], tag: 'x' }, /is not a field/], ['[]', /is an object with version and defer/],
  ]) {
    const r = send(dir, payload);
    assert.equal(r.reason, 'close-refused', JSON.stringify(payload));
    assert.ok(r.issues.some((i) => words.test(i.problem)), JSON.stringify(r.issues));
  }
  assert.equal(run(dir, 'close').reason, 'not-closing');
  assert.deepEqual(tree(dir), before);
  // nor before every epic is done, nor a version closed already
  const early = finished(t);
  edit(epicFile(agile(early.dir), 'E-03'), /^status: .*$/m, 'status: in-progress');
  assert.equal(send(early.dir, { version: '1.0.0', defer: ['CAT-02'] }).reason, 'not-closing');
  const again = finished(t);
  mkdirSync(join(releasesDir(agile(again.dir)), '1.0.0'), { recursive: true });
  assert.match(send(again.dir, { version: '1.0.0', defer: ['CAT-02'] }).issues[0].problem, /1\.0\.0 is closed already/);
});

test('a close stopped while its files moved is named by next and finished by close with no payload, asking nothing', (t) => {
  for (const moved of [[], ['epics'], ['epics', 'REQUIREMENTS.md'], MOVED]) {
    const { dir } = finished(t);
    const staging = closingDir(agile(dir), '0.10.0');
    mkdirSync(staging, { recursive: true });
    for (const name of moved) renameSync(join(agile(dir), name), join(staging, name));
    const next = run(dir, 'next');
    assert.deepEqual([next.release, next.next.step, next.next.closing], ['Toolshed', 'close', '0.10.0'], JSON.stringify(next));
    assert.equal(send(dir, { version: '0.11.0', defer: ['CAT-02'] }).reason, 'not-closing');
    const r = run(dir, 'close');
    assert.deepEqual([r.ok, r.version, r.finished], [true, '0.10.0', true], JSON.stringify(r));
    assert.deepEqual(readdirSync(join(releasesDir(agile(dir)), '0.10.0')).sort(), MOVED);
    assert.deepEqual(readdirSync(releasesDir(agile(dir))), ['0.10.0']);
    assert.equal(run(dir, 'next').release, null);
  }
});

test('a close stopped after the deferred ones moved reads them deferred and asks only the version', (t) => {
  const { dir } = finished(t);
  const file = join(agile(dir), 'REQUIREMENTS.md');
  const text = readFileSync(file, 'utf8');
  const line = text.match(/^- \*\*CAT-02\*\*: .*$/m)[0];
  writeFileSync(file, text.replace(`${line}\n`, '').replace('## Deferred\n\nNone.', `## Deferred\n\n${line}`));
  assert.equal(run(dir, 'next').next.requirements.find((q) => q.id === 'CAT-02').status, 'deferred');
  assert.equal(send(dir, { version: '0.10.0', defer: ['CAT-02'] }).reason, 'close-refused');
  assert.equal(send(dir, { version: '0.10.0' }).ok, true);
});

const prose = (name) => readFileSync(join(HERE, '..', 'cadence-core', 'workflows', name), 'utf8');
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b.c', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b.c' };
const commitBlock = (version) => /```\n(b='\{version\}'; b="\$\{b#v\}"\nset -- '\.planning\/agile\/releases\/\{version\}'[\s\S]*?git commit [^\n]*)\n```/.exec(prose('agile-close.md'))[1].replaceAll('{version}', version);
const lateBlock = () => /```\n\s*node "\$\{CLAUDE_PLUGIN_ROOT\}\/cadence-core\/bin\/config\.mjs" get planning\.commit_docs\n\s*(for d in [^\n]*)\n/.exec(prose('agile.md'))[1];

test('the close\'s commit takes the moved release and a bumped manifest, and nothing the user staged or edited elsewhere', (t) => {
  for (const [untracked, version] of [[false, '0.10.0'], [true, 'v0.10.0']]) {
    const { root, dir } = finished(t);
    const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', env });
    mkdirSync(join(root, '.claude-plugin'));
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), '{\n  "name": "toolshed",\n  "version": "0.9.0"\n}\n');
    writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n');
    git('init', '-q');
    git('config', 'color.ui', 'always');
    git('add', '-A');
    // a file git never tracked has no deletion to stage, and git add mustn't be handed it
    if (untracked) git('rm', '-q', '--cached', '.planning/agile/REQUIREMENTS.md');
    assert.equal(git('commit', '-q', '-m', 'start').status, 0);
    writeFileSync(join(root, 'staged.txt'), 'mine\n');
    git('add', 'staged.txt');
    edit(join(agile(dir), 'project.md'), '## Out of scope', '## Out of scope\n\nMine.');
    // a note of the user's under no heading of the version is theirs, though the file differs from HEAD
    writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n- half written\n');
    // what the bump writes, the manifest without the tag's v
    edit(join(root, '.claude-plugin', 'plugin.json'), '0.9.0', '0.10.0');
    assert.equal(send(dir, { version, defer: ['CAT-02'] }).ok, true);
    const r = spawnSync('sh', ['-c', commitBlock(version)], { cwd: root, encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(git('log', '-1', '--format=%s').stdout.trim(), `docs: close the release ${version}`);
    // renames off, so a moved file shows on both sides
    const files = git('show', '--name-only', '--no-renames', '--format=').stdout.trim().split('\n');
    assert.ok(files.includes('.claude-plugin/plugin.json') && files.includes(`.planning/agile/releases/${version}/release.md`), files.join(', '));
    assert.equal(files.includes('.planning/agile/release.md'), true);
    assert.equal(files.includes('.planning/agile/REQUIREMENTS.md'), !untracked);
    for (const theirs of ['staged.txt', '.planning/agile/project.md', 'CHANGELOG.md']) assert.equal(files.includes(theirs), false, theirs);
    assert.deepEqual(git('diff', '--cached', '--name-only').stdout.trim().split('\n'), ['staged.txt']);
  }
});

test('the close\'s commit takes CHANGELOG.md with the version\'s heading, and a manifest HEAD already holds at the version stays out', (t) => {
  const { root, dir } = finished(t);
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', env });
  mkdirSync(join(root, '.claude-plugin'));
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), '{\n  "name": "toolshed",\n  "version": "0.10.0"\n}\n');
  writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n');
  git('init', '-q');
  git('add', '-A');
  assert.equal(git('commit', '-q', '-m', 'start').status, 0);
  // already at the version, the bump wrote nothing there, and the user's edit is theirs
  edit(join(root, '.claude-plugin', 'plugin.json'), '"name": "toolshed"', '"name": "toolshed", "description": "mine"');
  writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n\n## [0.10.0] - 2026-11-26\n');
  assert.equal(send(dir, { version: '0.10.0', defer: ['CAT-02'] }).ok, true);
  assert.equal(spawnSync('sh', ['-c', commitBlock('0.10.0')], { cwd: root, encoding: 'utf8', env }).status, 0);
  const files = git('show', '--name-only', '--no-renames', '--format=').stdout.trim().split('\n');
  assert.deepEqual([files.includes('CHANGELOG.md'), files.includes('.claude-plugin/plugin.json')], [true, false], files.join(', '));
});

test('agile.md names a close moved and not committed, and finishes it with the close\'s own commit', (t) => {
  const { root, dir } = finished(t);
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', env });
  git('init', '-q');
  git('add', '-A');
  assert.equal(git('commit', '-q', '-m', 'start').status, 0);
  const late = () => spawnSync('sh', ['-c', lateBlock()], { cwd: root, encoding: 'utf8', env }).stdout.trim();
  assert.equal(late(), '');
  assert.equal(send(dir, { version: '0.10.0', defer: ['CAT-02'] }).ok, true);
  assert.equal(late(), 'UNCOMMITTED 0.10.0');
  assert.equal(spawnSync('sh', ['-c', commitBlock('0.10.0')], { cwd: root, encoding: 'utf8', env }).status, 0);
  assert.equal(late(), '');
});

test('the close shows, asks, closes, bumps and commits in that order, and agile.md sends the close step there', () => {
  const text = prose('agile-close.md');
  const at = (words) => {
    assert.equal(text.split(words).length, 2, `${words} is there once`);
    return text.indexOf(words);
  };
  // the bump goes first, so a version the manifest won't take stops the close with nothing moved
  const order = ['agile.mjs" close\n', '## 2. Show and ask', 'git-branch.mjs" tags --dir .', 'header: "Version"', 'header: "Open"',
    'release-bump.mjs" bump --dir . --version', 'agile.mjs" close --payload', 'git add -A -- "$@"', 'git commit -m "docs: close the release {version}" -- "$@"', 'git-publish.mjs" authorized --dir .', 'through the SlashCommand tool', '## 4. Report'];
  assert.deepEqual(order.map(at), order.map(at).sort((a, b) => a - b));
  const command = prose('agile.md');
  assert.ok(command.indexOf('`next.step` is `close`') > 0 && command.slice(command.indexOf('`next.step` is `close`')).includes('workflows/agile-close.md'));
  assert.ok(command.indexOf('UNCOMMITTED') < command.indexOf('`release` is null, with `--brief`'));
  // the late commit is guarded like any other, and doesn't bump again
  const late = command.slice(command.indexOf('UNCOMMITTED'), command.indexOf('`release` is null, with `--brief`'));
  assert.ok(late.indexOf('references/git-guard.md') > 0 && late.indexOf('references/git-guard.md') < late.indexOf('workflows/agile-close.md'));
  assert.match(late, /section 3's \*\*Commit\*\*/);
});

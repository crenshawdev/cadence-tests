// Zero-dep tests for moving an old-path project to the agile path: what agile.mjs check says moves, and what it refuses.
// Run: node --test tests/agile-switch.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerSetup, scratch } from './planning.test.mjs';
import { existsSync } from 'node:fs';
import { markAgile, readState, writeState } from '../cadence-core/bin/lib/project-state.mjs';
import { OLD_PATH_ARCHIVED, epicFile, oldPathArchive, storyFile, switchListFile } from '../cadence-core/bin/lib/agile-paths.mjs';
import { readEpicFile, readRequirementsFile } from '../cadence-core/bin/lib/agile-read.mjs';
import { renderStoryFile, withKept } from '../cadence-core/bin/lib/agile-render.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGILE = join(HERE, '..', 'cadence-core', 'bin', 'agile.mjs');
const FIXTURE = join(HERE, 'fixtures', 'seldon-design');
const WHO = { GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@b.c', GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@b.c' };

/** One agile.mjs call with no user-global config and none of this machine's git settings. */
function run(dir, args) {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', CADENCE_GLOBAL_CONFIG: join(dirname(dir), 'no-global.json'), ...WHO };
  const r = spawnSync('node', [AGILE, ...args, '--dir', dir], { encoding: 'utf8', env });
  return { ...JSON.parse(r.stdout), _exit: r.status };
}
const check = (dir, design = FIXTURE) => run(dir, ['check', '--design', design]);
const start = (dir, design = FIXTURE) => run(dir, ['start', '--design', design]);
const next = (dir) => run(dir, ['next']);

/** Every path under `root` with its bytes, a link as its target. */
function tree(root, rel = '') {
  const out = {};
  for (const name of readdirSync(join(root, rel)).sort()) {
    const p = rel ? `${rel}/${name}` : name;
    const st = lstatSync(join(root, p));
    if (st.isSymbolicLink()) out[p] = `-> ${readlinkSync(join(root, p))}`;
    else if (st.isDirectory()) Object.assign(out, { [`${p}/`]: '' }, tree(root, p));
    else out[p] = readFileSync(join(root, p), 'utf8');
  }
  return out;
}

const put = (dir, rel, text = 'x\n') => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };
const CLOSED = { cycleOpen: false, cursor: { phase: 1, status: 'ready to plan', next: '/cad-phase add', updated: '2026-11-25' }, phases: [], requirements: [] };

/** An old-path project whose last release closed and landed, with the setup a start asks for already answered. */
function landedProject(t, state = CLOSED) {
  const dir = answerSetup(join(scratch('cad-agile-switch-', t), '.planning'));
  assert.equal(writeState(dir, state).ok, true);
  put(dir, 'PROJECT.md', '# Toolshed\n');
  put(dir, 'ROADMAP.md', '# Roadmap: Toolshed\n\n## Phases\n');
  return dir;
}

/** A queue member as `deferred record` writes one, in the carried queue's home. */
function deferredMember(dir) {
  put(dir, 'records/deferred/2/DEFERRED-diff-plan-1.json', `${JSON.stringify({ phase: '2', trigger: 'diff', discriminator: 'plan-1', round: 1,
    base: 'abc1234', head: 'HEAD', base_id: 'a'.repeat(40), head_id: 'b'.repeat(40), findings: [] })}\n`);
}

test('an old-path project whose release has landed is one a start may move: check answers the switch, next refuses it, neither writes', (t) => {
  const dir = landedProject(t);
  const before = tree(dirname(dir));
  const r = check(dir);
  assert.deepEqual([r.ok, r._exit, r.release], [true, 0, 'Toolshed'], JSON.stringify(r));
  assert.ok(r.switch, JSON.stringify(r));
  const n = next(dir);
  assert.deepEqual([n.ok, n.reason], [false, 'switch'], JSON.stringify(n));
  // /cad-agile routes a switch only with a design, so the hint names the command and the folder it needs
  assert.match(n.hint, /^run \/cad-agile --brief <folder> with a finished Seldon design, which shows what moves to the new path and asks first; nothing was written$/);
  assert.deepEqual(tree(dirname(dir)), before);
});

test('an old-path project whose release hasn\'t landed is refused naming what to clear, by check and start alike, with nothing written', (t) => {
  /** @type {[string, (dir: string) => void, RegExp, RegExp][]} */
  const cases = [
    ['a cycle open', (d) => assert.equal(writeState(d, { ...CLOSED, cycleOpen: true }).ok, true), /PROJECT\.md/, /\/cad-milestone.*\/cad-land/],
    ['a deferred finding unruled', deferredMember, /1 deferred finding file unruled: .*records\/deferred\/2\/DEFERRED-diff-plan-1\.json/, /\/cad-land; if that release was landed by hand, remove those files/],
    ['a queue that can\'t be read', (d) => { mkdirSync(join(d, 'phases'), { recursive: true }); symlinkSync('/tmp', join(d, 'phases', '3')); }, /can't all be read.*phases\/3/, /make them readable/],
    ['risk rulings carried', (d) => mkdirSync(join(d, 'records', 'risk-carry'), { recursive: true }), /records\/risk-carry holds risk rulings/, /\/cad-land; if it was landed by hand, remove that folder/],
    ['a folder named agile', (d) => mkdirSync(join(d, 'agile')), /agile is there/, /move that folder aside/],
    ['an archive no switch made', (d) => mkdirSync(join(d, '_archive-old-path')), /_archive-old-path is already there/, /move that folder aside/],
    ['a records folder that is a link', (d) => { renameSync(join(d, 'records'), join(d, 'real-records')); symlinkSync(join(d, 'real-records'), join(d, 'records')); },
      /records is not a real folder \(symlinked-records\)/, /put the records folder back as a real folder/],
  ];
  for (const [name, make, detail, hint] of cases) {
    const dir = landedProject(t);
    make(dir);
    const before = tree(dirname(dir));
    for (const r of [check(dir), start(dir)]) {
      assert.deepEqual([r.ok, r._exit, r.reason], [false, 1, 'old-path'], `${name}: ${JSON.stringify(r)}`);
      assert.match(r.detail, detail, name);
      assert.match(r.hint, hint, name);
      assert.match(r.hint, /nothing was written$/, name);
    }
    assert.deepEqual(tree(dirname(dir)), before, name);
  }
});

test('old-path files with no state file yet are refused naming the command that writes one', (t) => {
  const dir = answerSetup(join(scratch('cad-agile-switch-', t), '.planning'));
  put(dir, 'PROJECT.md', '# Toolshed\n');
  const before = tree(dirname(dir));
  for (const r of [check(dir), start(dir)]) {
    assert.deepEqual([r.ok, r.reason], [false, 'old-path'], JSON.stringify(r));
    assert.match(r.detail, /no state file yet: PROJECT\.md/);
    assert.match(r.hint, /\/cad-progress once/);
  }
  assert.deepEqual(tree(dirname(dir)), before);
});

/** The test design with every requirement ID renamed, so it reuses none the old project used. @param {string} to */
function freshDesign(to) {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(FIXTURE)) {
    writeFileSync(join(to, name), readFileSync(join(FIXTURE, name), 'utf8').replaceAll('CAT-', 'TOOL-').replaceAll('LOAN-', 'LEND-').replaceAll('NFR-', 'QUAL-'));
  }
  return to;
}

const OLD_REQUIREMENTS = '# Requirements: Toolshed\n\n## Shipped\n\n| CAT-01 (a catalog) | 1 | Complete | v1.0.0 |\n\n## v2 Requirements\n\n- **MOD-01**: later, after LOAN-02 lands\n';

test('check names what a switch archives, what it copies open work from and what it leaves, the user\'s own files and an open design among the left', (t) => {
  const dir = landedProject(t);
  for (const rel of ['REQUIREMENTS.md', 'STATE.md', 'CAPTURE.md', 'CAPTURE.md.lock', 'ARCHIVE.md', 'state.json', 'tasks/fix-typo/RECORD.md',
    'spikes/probe/SPIKE.md', 'debug/hang.md', 'research/RESEARCH.md', '_archive-v1.0.0/1/PLAN-1.md', 'REVIEW-risk_surface-v1.0.0.md',
    'trace.jsonl', 'reads.1.jsonl.claim.123', 'records/ARCHIVE.md', 'records/DECLINED.md', 'records/FILED.md', 'records/FILED.md.lock',
    'records/trace.jsonl', 'records/reads.jsonl', 'records/deferred/1/ADJUDICATION-diff-plan-1.json', 'records/codemap/index.json',
    'records/.gitignore', 'drafts/notes.md', 'notes.txt', 'config.json.bak']) put(dir, rel, rel === 'REQUIREMENTS.md' ? OLD_REQUIREMENTS : 'x\n');
  mkdirSync(join(dir, 'phases'));
  // the design the old release started from, at the top, and one no release has, in a folder of its own
  cpSync(FIXTURE, join(dir, 'seldon'), { recursive: true });
  put(dir, 'seldon/architecture.md');
  const open = freshDesign(join(dir, 'seldon', 'next'));
  const before = tree(dirname(dir));
  const r = check(dir, open);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.switch.archive, ['ARCHIVE.md', 'CAPTURE.md', 'CAPTURE.md.lock', 'PROJECT.md', 'REQUIREMENTS.md', 'REVIEW-risk_surface-v1.0.0.md',
    'ROADMAP.md', 'STATE.md', '_archive-v1.0.0', 'debug', 'phases', 'reads.1.jsonl.claim.123', 'records/.gitignore', 'records/ARCHIVE.md', 'records/DECLINED.md',
    'records/FILED.md', 'records/FILED.md.lock', 'records/deferred', 'records/reads.jsonl', 'records/state.json', 'records/trace.jsonl', 'research',
    'seldon/brief.md', 'seldon/prd.md', 'seldon/spine.md', 'seldon/epics.md', 'seldon/architecture.md', 'spikes', 'state.json', 'tasks', 'trace.jsonl']);
  assert.deepEqual(r.switch.copy, ['PROJECT.md', 'REQUIREMENTS.md', 'CAPTURE.md', 'records/DECLINED.md', 'records/FILED.md']);
  // the ignore file goes with the logs it ignores: its rules are anchored to its folder, so left behind they'd ignore nothing
  assert.deepEqual(r.switch.leave, ['config.json', 'config.json.bak', 'drafts', 'notes.txt', 'records/codemap', 'seldon/next']);
  assert.deepEqual(tree(dirname(dir)), before);
});

test('a design whose IDs the old REQUIREMENTS.md holds anywhere is refused, as the old path refuses it, and so is one that can\'t be read', (t) => {
  const dir = landedProject(t);
  put(dir, 'REQUIREMENTS.md', OLD_REQUIREMENTS);
  const before = tree(dirname(dir));
  for (const r of [check(dir), start(dir)]) {
    assert.deepEqual([r.ok, r._exit, r.reason], [false, 1, 'requirement-ids-used'], JSON.stringify(r));
    assert.match(r.detail, /^CAT-01, LOAN-02 are already in .*REQUIREMENTS\.md/);
    assert.match(r.hint, /prd\.md.*epics\.md.*nothing was written$/);
  }
  assert.deepEqual(tree(dirname(dir)), before);
  // the same design with fresh IDs goes through
  assert.equal(check(dir, freshDesign(join(scratch('cad-agile-fresh-', t), 'design'))).ok, true);

  const linked = landedProject(t);
  symlinkSync(join(dir, 'REQUIREMENTS.md'), join(linked, 'REQUIREMENTS.md'));
  const r = check(linked);
  assert.deepEqual([r.ok, r.reason], [false, 'old-requirements'], JSON.stringify(r));
  assert.match(r.detail, /not a plain file/);
});

test('an old REQUIREMENTS.md or a folder the switch lists that can\'t be read is refused by name, not as an internal error', (t) => {
  const cases = [
    ['REQUIREMENTS.md', 'old-requirements', /REQUIREMENTS\.md can't be read \(EACCES\)/, (d) => { put(d, 'REQUIREMENTS.md', OLD_REQUIREMENTS); chmodSync(join(d, 'REQUIREMENTS.md'), 0o000); }],
    ['seldon', 'old-path', /can't be read: .*seldon/, (d) => { mkdirSync(join(d, 'seldon')); chmodSync(join(d, 'seldon'), 0o000); }],
  ];
  for (const [name, reason, detail, make] of cases) {
    const dir = landedProject(t);
    make(dir);
    const r = check(dir);
    // put back before the scratch folder is removed, which can't list a folder no one may read
    chmodSync(join(dir, name), 0o755);
    assert.deepEqual([r.ok, r._exit, r.reason], [false, 1, reason], `${name}: ${JSON.stringify(r)}`);
    assert.match(r.detail, detail, name);
    assert.match(r.hint, /make it readable, then re-run; nothing was written$/, name);
  }
});

/** A landed old-path project holding every kind of file a switch moves or leaves, and an open design to start it from. */
function richProject(t) {
  const dir = landedProject(t);
  for (const rel of ['REQUIREMENTS.md', 'STATE.md', 'CAPTURE.md', 'ARCHIVE.md', 'state.json', 'tasks/fix-typo/RECORD.md', 'spikes/probe/SPIKE.md',
    '_archive-v1.0.0/1/PLAN-1.md', 'trace.jsonl', 'records/ARCHIVE.md', 'records/DECLINED.md', 'records/FILED.md', 'records/trace.jsonl',
    'records/reads.jsonl', 'records/codemap/index.json', 'records/.gitignore', 'drafts/notes.md', 'notes.txt']) put(dir, rel, rel === 'REQUIREMENTS.md' ? OLD_REQUIREMENTS : `${rel}\n`);
  mkdirSync(join(dir, 'phases'));
  cpSync(FIXTURE, join(dir, 'seldon'), { recursive: true });
  return { dir, design: freshDesign(join(dir, 'seldon', 'next')) };
}

const LEFT = ['config.json', 'drafts/notes.md', 'notes.txt', 'records/codemap/index.json'];

test('a start on a landed old-path project moves every listed path into the archive byte for byte, marks it, opens the release and leaves the rest', (t) => {
  const { dir, design } = richProject(t);
  const listed = check(dir, design).switch.archive;
  const before = tree(dir);
  const state = readFileSync(join(dir, 'records', 'state.json'), 'utf8');
  const r = start(dir, design);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.switched.archive, listed);
  const archive = oldPathArchive(dir);
  for (const [p, bytes] of Object.entries(before)) {
    const moved = listed.some((rel) => p === rel || p.startsWith(`${rel}/`)) && p !== 'records/state.json';
    if (moved) assert.equal(tree(archive)[p], bytes, `${p} in the archive`);
    // the records ignore file is the one path a start writes again, below
    if (moved && p !== 'records/.gitignore') assert.equal(existsSync(join(dir, p.replace(/\/$/, ''))), false, `${p} gone from the top`);
    if (LEFT.includes(p)) assert.equal(readFileSync(join(dir, p), 'utf8'), bytes, `${p} left`);
  }
  assert.equal(readFileSync(join(archive, 'records', 'state.json'), 'utf8'), state);
  assert.equal(readState(dir).reason, 'agile-path');
  for (const name of OLD_PATH_ARCHIVED) assert.equal(existsSync(join(dir, name)), false, name);
  assert.equal(existsSync(switchListFile(dir)), false);
  assert.match(readFileSync(join(dir, 'records', '.gitignore'), 'utf8'), /^\/trace\.jsonl$/m);
  assert.deepEqual([next(dir).next.id, next(dir).next.step], ['E-01', 'refine']);
  // the old path refuses it from here on
  const status = spawnSync('node', [join(HERE, '..', 'cadence-core', 'bin', 'planning.mjs'), 'status', '--dir', dir], { encoding: 'utf8' });
  assert.equal(JSON.parse(status.stdout).reason, 'agile-path', status.stdout);
});

test('a start stopped after each of its writes is finished by the next to the tree a clean start leaves', (t) => {
  const clean = richProject(t);
  const listed = check(clean.dir, clean.design).switch.archive;
  assert.equal(start(clean.dir, clean.design).ok, true);
  const want = tree(clean.dir);
  const paths = listed.filter((rel) => rel !== 'records/state.json');
  const moveBy = (dir, rels) => { for (const rel of rels) { mkdirSync(dirname(join(oldPathArchive(dir), rel)), { recursive: true }); renameSync(join(dir, rel), join(oldPathArchive(dir), rel)); } };
  const listAndCopy = (dir, copy = true) => {
    writeFileSync(switchListFile(dir), `${listed.join('\n')}\n`);
    if (!copy) return;
    mkdirSync(join(oldPathArchive(dir), 'records'), { recursive: true });
    cpSync(join(dir, 'records', 'state.json'), join(oldPathArchive(dir), 'records', 'state.json'));
  };
  const marked = (dir) => { listAndCopy(dir); assert.equal(markAgile(dir, join(oldPathArchive(dir), 'records', 'state.json')).ok, true); };
  /** @type {[string, (dir: string) => void][]} */
  const rows = [
    ['the list', (d) => listAndCopy(d, false)],
    ['the state copy', (d) => listAndCopy(d)],
    ['inside the copy\'s write', (d) => { listAndCopy(d, false); put(oldPathArchive(d), 'records/state.json.99999.0.tmp', '{"half\n'); }],
    ['the marker', marked],
    ['some moves', (d) => { marked(d); moveBy(d, paths.slice(0, 6)); }],
    ['every move', (d) => { marked(d); moveBy(d, paths); }],
    ['a dead run\'s build folder', (d) => { marked(d); moveBy(d, paths); put(d, `agile.new.${spawnSync('node', ['-e', '']).pid}/release.md`, 'half\n'); }],
  ];
  for (const [name, stop] of rows) {
    const { dir, design } = richProject(t);
    stop(dir);
    const r = start(dir, design);
    assert.equal(r.ok, true, `${name}: ${JSON.stringify(r)}`);
    assert.deepEqual(tree(dir), want, name);
  }
  // a hook writing the run record after it moved: the new log is the new path's own, and the archived one keeps its bytes
  const hooked = richProject(t);
  marked(hooked.dir);
  moveBy(hooked.dir, ['records/trace.jsonl', 'PROJECT.md']);
  put(hooked.dir, 'records/trace.jsonl', 'a new run\n');
  assert.equal(start(hooked.dir, hooked.design).ok, true);
  assert.deepEqual(tree(hooked.dir), { ...want, 'records/trace.jsonl': 'a new run\n' });
  // the rename done and the list not yet removed: the next start removes it and says the move is finished
  const late = richProject(t);
  assert.equal(start(late.dir, late.design).ok, true);
  writeFileSync(switchListFile(late.dir), `${listed.join('\n')}\n`);
  const r = start(late.dir, late.design);
  assert.deepEqual([r.ok, r.finished, r.switched.archive], [true, true, listed], JSON.stringify(r));
  assert.deepEqual(tree(late.dir), want);
});

test('a list left by a stopped move that names a path no switch moves is refused, and nothing moves', (t) => {
  for (const wrong of ['drafts', 'records/codemap', '../outside', 'seldon/a/b', 'agile.switch', 'seldon/next', '']) {
    const { dir, design } = richProject(t);
    writeFileSync(switchListFile(dir), `PROJECT.md\n${wrong}\n`);
    mkdirSync(join(oldPathArchive(dir), 'records'), { recursive: true });
    cpSync(join(dir, 'records', 'state.json'), join(oldPathArchive(dir), 'records', 'state.json'));
    assert.equal(markAgile(dir, join(oldPathArchive(dir), 'records', 'state.json')).ok, true);
    const before = tree(dirname(dir));
    const r = start(dir, design);
    if (wrong === '') { assert.equal(r.ok, true, JSON.stringify(r)); continue; }
    assert.deepEqual([r.ok, r.reason], [false, 'switch-list'], `${wrong}: ${JSON.stringify(r)}`);
    assert.match(r.detail, new RegExp(`names ${JSON.stringify(wrong).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`), wrong);
    assert.deepEqual(tree(dirname(dir)), before, wrong);
  }
});

test('the marker takes an old-path state\'s place only with a copy of its bytes beside it, and a marked project\'s copy is never written again', (t) => {
  const dir = landedProject(t);
  const copy = join(oldPathArchive(dir), 'records', 'state.json');
  const old = readFileSync(join(dir, 'records', 'state.json'), 'utf8');
  assert.equal(markAgile(dir).reason, 'state-present');
  assert.equal(readState(dir).kind, 'valid');
  mkdirSync(dirname(copy), { recursive: true });
  assert.deepEqual(markAgile(dir, copy), { ok: true, changed: true });
  assert.equal(readFileSync(copy, 'utf8'), old);
  assert.equal(readState(dir).reason, 'agile-path');
  assert.deepEqual(markAgile(dir, copy), { ok: true, changed: false });
  assert.equal(readFileSync(copy, 'utf8'), old);
});

test('an old-path state with a cycle opened since the switch judged it landed is never replaced by the marker', (t) => {
  const dir = landedProject(t, { ...CLOSED, cycleOpen: true });
  const copy = join(oldPathArchive(dir), 'records', 'state.json');
  mkdirSync(dirname(copy), { recursive: true });
  const r = markAgile(dir, copy);
  assert.deepEqual([r.ok, r.reason], [false, 'cycle-open'], JSON.stringify(r));
  assert.equal(readState(dir).kind, 'valid');
  assert.equal(existsSync(copy), false);
});

test('two starts at once switch the project once, and the archived state is always the old one', async (t) => {
  for (let i = 0; i < 10; i++) {
    const { dir, design } = richProject(t);
    const old = readFileSync(join(dir, 'records', 'state.json'), 'utf8');
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', CADENCE_GLOBAL_CONFIG: join(dirname(dir), 'no-global.json'), ...WHO };
    const both = [0, 1].map(() => spawn('node', [AGILE, 'start', '--design', design, '--dir', dir], { env }));
    const outs = both.map((c) => new Promise((done) => { let out = ''; c.stdout.on('data', (b) => { out += b; }); c.on('close', () => done(JSON.parse(out))); }));
    const rs = await Promise.all(outs);
    assert.equal(readFileSync(join(oldPathArchive(dir), 'records', 'state.json'), 'utf8'), old, `trial ${i}`);
    assert.ok(rs.some((r) => r.ok), JSON.stringify(rs));
    for (const r of rs) assert.ok(r.ok || ['release-open', 'switch-locked'].includes(r.reason), JSON.stringify(r));
    assert.equal(existsSync(switchListFile(dir)), false);
    assert.equal(readState(dir).reason, 'agile-path');
  }
});

test('a held switch lock, an archive that is a link or a file, and a path in both places are refused by name, and nothing moves', (t) => {
  const outside = scratch('cad-agile-outside-', t);
  /** @type {[string, string, (dir: string) => void, RegExp][]} */
  const cases = [
    ['another start moving it', 'switch-locked', (d) => writeFileSync(`${switchListFile(d)}.lock`, ''), /another start is moving this project/],
    ['an archive linked out of the tree', 'old-path', (d) => { writeFileSync(switchListFile(d), 'PROJECT.md\n'); symlinkSync(outside, oldPathArchive(d)); }, /move that folder aside/],
    ['an archived file the switch didn\'t put there', 'old-path', (d) => { writeFileSync(switchListFile(d), 'PROJECT.md\n'); put(oldPathArchive(d), 'PROJECT.md'); }, /move that folder aside/],
    ['a marked project with its archive\'s records linked out', 'switch-archive', (d) => {
      writeFileSync(switchListFile(d), 'PROJECT.md\nROADMAP.md\n');
      mkdirSync(oldPathArchive(d));
      assert.equal(markAgile(d, join(scratch('cad-agile-copy-', t), 'state.json')).ok, true);
      symlinkSync(outside, join(oldPathArchive(d), 'records'));
    }, /records is not a real folder/],
    ['a marked project with a path in both places', 'switch-twins', (d) => {
      writeFileSync(switchListFile(d), 'PROJECT.md\nROADMAP.md\n');
      mkdirSync(join(oldPathArchive(d), 'records'), { recursive: true });
      assert.equal(markAgile(d, join(oldPathArchive(d), 'records', 'state.json')).ok, true);
      put(oldPathArchive(d), 'PROJECT.md', '# an older copy\n');
    }, /PROJECT\.md is both at the top of .* and in .*_archive-old-path/],
  ];
  for (const [name, reason, make, hint] of cases) {
    const { dir, design } = richProject(t);
    make(dir);
    const before = tree(dirname(dir));
    const away = tree(outside);
    const r = start(dir, design);
    assert.deepEqual([r.ok, r.reason], [false, reason], `${name}: ${JSON.stringify(r)}`);
    assert.match(`${r.detail} ${r.hint}`, hint, name);
    assert.deepEqual(tree(dirname(dir)), before, name);
    assert.deepEqual(tree(outside), away, name);
  }
  // a link where the state's copy goes is replaced, never written through
  const { dir, design } = richProject(t);
  const target = join(outside, 'precious');
  writeFileSync(target, 'precious\n');
  writeFileSync(switchListFile(dir), 'PROJECT.md\n');
  mkdirSync(join(oldPathArchive(dir), 'records'), { recursive: true });
  symlinkSync(target, join(oldPathArchive(dir), 'records', 'state.json'));
  const old = readFileSync(join(dir, 'records', 'state.json'), 'utf8');
  assert.equal(start(dir, design).ok, true);
  assert.equal(readFileSync(target, 'utf8'), 'precious\n');
  assert.equal(lstatSync(join(oldPathArchive(dir), 'records', 'state.json')).isSymbolicLink(), false);
  assert.equal(readFileSync(join(oldPathArchive(dir), 'records', 'state.json'), 'utf8'), old);
});

test('a start finishing a stopped move reads the old requirements from the archive, so a reused ID is still refused', (t) => {
  const { dir } = richProject(t);
  writeFileSync(switchListFile(dir), 'REQUIREMENTS.md\nPROJECT.md\n');
  mkdirSync(join(oldPathArchive(dir), 'records'), { recursive: true });
  assert.equal(markAgile(dir, join(oldPathArchive(dir), 'records', 'state.json')).ok, true);
  renameSync(join(dir, 'REQUIREMENTS.md'), join(oldPathArchive(dir), 'REQUIREMENTS.md'));
  const r = start(dir, FIXTURE);
  assert.deepEqual([r.ok, r.reason], [false, 'requirement-ids-used'], JSON.stringify(r));
  assert.match(r.detail, /^CAT-01, LOAN-02 are already in .*_archive-old-path\/REQUIREMENTS\.md/);
});

const FENCE = '```';
const OLD_PROJECT = `# Toolshed

## What This Is

Lends tools to neighbours.

## Core Value

A borrowed drill comes back.

## Requirements

### Validated

- catalog - v1.0.0

### Out of Scope

- Payments - nobody pays

### Later

- not carried

## Context

${FENCE}
## Constraints
- fenced, not carried
${FENCE}

## Constraints

- **Stack**: Node - zero deps

## Key Decisions

| Decision | Rationale | Outcome |
|---|---|---|
| Zero deps | less to break | good |

---
*Last updated: 2026-11-01 after v1.0.0*
`;
const CARRIED_PROJECT = `## From the old path

### What This Is

Lends tools to neighbours.

### Core Value

A borrowed drill comes back.

### Out of Scope

- Payments - nobody pays

### Constraints

- **Stack**: Node - zero deps

### Key Decisions

| Decision | Rationale | Outcome |
|---|---|---|
| Zero deps | less to break | good |
`;
const OPEN_REQUIREMENTS = `# Requirements: Toolshed

## Active

- [ ] **CAT-01**: a catalog

## Shipped

| LOAN-07 (lending) | 2 | Complete | v1.0.0 |

## v2 Requirements

${FENCE}
- **FAKE-01**: a fenced example
${FENCE}

- [ ] **MOD-01**: later, after LOAN-02 lands
- **MOD-03** no colon here
- **Note**: not an ID
- **MOD-01**: a second time
- **SYNC-2**:

## Out of Scope
`;
const OLD_CAPTURE = '## Todos\n\n- [ ] (phase 2) wire the lending desk\n- [x] a closed one\n- None.\n\n## Seeds\n\n- a seed for later\n\n## Notes\n\n- 2026-11-01 a note\n\n## Debt markers\n\n- agile.mjs:12 TODO not carried\n';

/** A landed project holding open work in every file a switch copies from, and a design of its own beside it. */
function openWorkProject(t) {
  const dir = landedProject(t);
  put(dir, 'PROJECT.md', OLD_PROJECT);
  put(dir, 'REQUIREMENTS.md', OPEN_REQUIREMENTS);
  put(dir, 'CAPTURE.md', OLD_CAPTURE);
  put(dir, 'records/DECLINED.md', '# Declined\n\n| a row | kept as is |\n');
  put(dir, 'records/FILED.md', '# Filed\r\n\r\n| #12 | crlf too |\r\n');
  return { dir, design: freshDesign(join(scratch('cad-agile-switch-design-', t), 'design')) };
}

test('a switch carries the old path\'s open work: PROJECT.md\'s five sections, the v2 requirements and the highest IDs, the open captures, and the ledgers as they are', (t) => {
  const { dir, design } = openWorkProject(t);
  const r = start(dir, design);
  assert.equal(r.ok, true, JSON.stringify(r));
  const plain = answerSetup(join(scratch('cad-agile-switch-plain-', t), '.planning'));
  assert.equal(start(plain, design).ok, true);
  const agile = join(dir, 'agile');
  assert.equal(readFileSync(join(agile, 'project.md'), 'utf8'), `${readFileSync(join(plain, 'agile', 'project.md'), 'utf8').trimEnd()}\n\n${CARRIED_PROJECT}`);
  const req = readRequirementsFile(readFileSync(join(agile, 'REQUIREMENTS.md'), 'utf8'));
  assert.equal(req.whole, true);
  assert.deepEqual(req.deferred, [{ id: 'MOD-01', text: 'later, after LOAN-02 lands' }, { id: 'MOD-03', text: 'no colon here' }]);
  assert.deepEqual(req.earlier, ['CAT-01', 'LOAN-07', 'FAKE-01', 'MOD-03', 'SYNC-2']);
  assert.deepEqual(req.requirements, readRequirementsFile(readFileSync(join(plain, 'agile', 'REQUIREMENTS.md'), 'utf8')).requirements);
  assert.equal(readFileSync(join(agile, 'backlog.md'), 'utf8'), '## Todos\n\n- [ ] wire the lending desk\n\n## Seeds\n\n- a seed for later\n\n## Notes\n\n- 2026-11-01 a note\n');
  assert.equal(readFileSync(join(agile, 'declined.md'), 'utf8'), '# Declined\n\n| a row | kept as is |\n');
  assert.equal(readFileSync(join(agile, 'filed.md'), 'utf8'), '# Filed\r\n\r\n| #12 | crlf too |\r\n');
  // nothing open, nothing written: a landed project with none of these files carries no backlog and no ledger
  const bare = landedProject(t);
  assert.equal(start(bare, design).ok, true);
  assert.deepEqual(['backlog.md', 'declined.md', 'filed.md'].filter((n) => existsSync(join(bare, 'agile', n))), []);
});

test('an old file a switch copies from that isn\'t a plain file is refused by name, by check and start alike, with nothing written', (t) => {
  for (const [name, plant] of /** @type {[string, (dir: string) => void][]} */ ([
    ['CAPTURE.md', (d) => mkdirSync(join(d, 'CAPTURE.md'))],
    ['records/FILED.md', (d) => symlinkSync(join(d, 'PROJECT.md'), join(d, 'records', 'FILED.md'))],
  ])) {
    const { dir, design } = openWorkProject(t);
    rmSync(join(dir, name), { recursive: true, force: true });
    plant(dir);
    const before = tree(dirname(dir));
    for (const r of [check(dir, design), start(dir, design)]) {
      assert.deepEqual([r.ok, r.reason], [false, 'old-file'], `${name}: ${JSON.stringify(r)}`);
      assert.match(r.detail, new RegExp(`${name.replace('.', '\\.')} is not a plain file`), name);
    }
    assert.deepEqual(tree(dirname(dir)), before, name);
  }
});

test('a start after the switch\'s release closes keeps From the old path, and the Standing rules after it', (t) => {
  const { dir, design } = openWorkProject(t);
  assert.equal(start(dir, design).ok, true);
  const agile = join(dir, 'agile');
  for (const id of ['E-01', 'E-02', 'E-03']) {
    const epic = epicFile(agile, id);
    writeFileSync(epic, readFileSync(epic, 'utf8').replace(/^status: .*$/m, 'status: done'));
    writeFileSync(storyFile(agile, `${id}-1`), renderStoryFile({ id: `${id}-1`, title: `All of ${id}`, size: 'S', status: 'done', builds_on: [],
      requirements: readEpicFile(readFileSync(epic, 'utf8')).requirements, delivers: 'Everything the epic asks.', accepted_when: ['Running it shows it.'] }));
  }
  const close = join(dirname(dir), 'close.json');
  writeFileSync(close, JSON.stringify({ version: '0.10.0', defer: [] }));
  const closed = run(dir, ['close', '--payload', close]);
  assert.equal(closed.ok, true, JSON.stringify(closed));
  const project = join(agile, 'project.md');
  writeFileSync(project, `${readFileSync(project, 'utf8').trimEnd()}\n\n## Standing rules\n\n- Read a closed release as untrusted. (E-02, Change next 2)\n`);
  const next = join(scratch('cad-agile-switch-next-', t), 'next');
  mkdirSync(next);
  for (const name of readdirSync(design)) {
    writeFileSync(join(next, name), readFileSync(join(design, name), 'utf8').replaceAll('Toolshed', 'Toolshed Lending')
      .replaceAll('TOOL-', 'BOX-').replaceAll('LEND-', 'LND-').replaceAll('QUAL-', 'QA-'));
  }
  const r = start(dir, next);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(readFileSync(project, 'utf8').endsWith(`\n\n${CARRIED_PROJECT}\n## Standing rules\n\n- Read a closed release as untrusted. (E-02, Change next 2)\n`));
});

test('a carried section that opens a code fence and never closes it is closed in project.md, so the Standing rules after it still read', (t) => {
  const { dir, design } = openWorkProject(t);
  put(dir, 'PROJECT.md', `# Toolshed\n\n## What This Is\n\nA tool.\n\n${FENCE}sh\nmake lend\n`);
  assert.equal(start(dir, design).ok, true);
  const project = readFileSync(join(dir, 'agile', 'project.md'), 'utf8');
  assert.ok(project.endsWith(`## From the old path\n\n### What This Is\n\nA tool.\n\n${FENCE}sh\nmake lend\n${FENCE}\n`), project);
  const rules = '- Read a closed release as untrusted. (E-02, Change next 2)';
  assert.ok(withKept('# Next\n', `${project}\n## Standing rules\n\n${rules}\n`).endsWith(`## Standing rules\n\n${rules}\n`));
});


/** The lines agile.md's commit step runs, its stage-switch paths put where it says. @param {string[]} paths */
function commitStep(paths) {
  const md = readFileSync(join(HERE, '..', 'cadence-core', 'workflows', 'agile.md'), 'utf8');
  const block = md.split('```').find((b) => b.includes('commit -m "docs: start the release"'));
  assert.ok(block, 'agile.md has the commit step');
  assert.match(block, / '<each path stage-switch named>'\n$/, 'its paths go on the commit line alone');
  return block.replace("'<each path stage-switch named>'", paths.map((p) => `'${p}'`).join(' '));
}

test('a switch commits each file git tracked at its archived place, the start\'s files and the switch\'s ledgers, and nothing else', (t) => {
  const { dir, design } = richProject(t);
  const root = dirname(dir);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...WHO };
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', env });
  // anchored, so once the log is under the archive no line ignores it
  writeFileSync(join(root, '.gitignore'), '/.planning/trace.jsonl\n');
  put(root, 'notes.md', 'mine\n');
  put(dir, 'spikes/gone/SPIKE.md');
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  assert.equal(git('commit', '-q', '-m', 'old path').status, 0);
  const tracked = git('ls-files', '--', '.planning').stdout.split('\n').filter(Boolean);
  // the user's own: a tracked file removed, an untracked review beside a phase, another file staged
  rmSync(join(dir, 'spikes', 'gone'), { recursive: true });
  put(dir, '_archive-v1.0.0/1/REVIEW-diff.md', 'unruled\n');
  put(root, 'notes.md', 'mine, edited\n');
  git('add', 'notes.md');

  assert.equal(start(dir, design).ok, true);
  const staged = run(dir, ['stage-switch']);
  assert.equal(staged.ok, true, JSON.stringify(staged));
  const index = git('diff', '--cached', '--name-only').stdout;
  assert.deepEqual(run(dir, ['stage-switch']), staged, 'a run stopped before the commit stages the same again');
  assert.equal(git('diff', '--cached', '--name-only').stdout, index);
  assert.ok(staged.paths.includes('.planning/_archive-old-path') && staged.paths.includes('.planning/records/state.json'), JSON.stringify(staged.paths));
  assert.ok(staged.paths.includes('.planning/agile/declined.md') && staged.paths.includes('.planning/agile/filed.md'), JSON.stringify(staged.paths));
  assert.ok(!staged.paths.includes('.planning/records'), 'records/ is named by the entries that moved, never whole');

  const committed = spawnSync('sh', ['-c', commitStep(staged.paths)], { cwd: root, encoding: 'utf8', env });
  assert.equal(committed.status, 0, committed.stderr);
  const files = git('show', '--no-renames', '--name-only', '--format=', 'HEAD').stdout.split('\n').filter(Boolean);
  const moved = tracked.filter((p) => existsSync(join(oldPathArchive(dir), p.slice('.planning/'.length))));
  for (const p of moved) {
    assert.ok(files.includes(`.planning/_archive-old-path/${p.slice('.planning/'.length)}`), `${p} committed at its archived place`);
    if (p !== '.planning/records/state.json' && p !== '.planning/records/.gitignore') assert.ok(files.includes(p), `${p} committed gone`);
  }
  for (const p of ['.planning/agile/release.md', '.planning/agile/project.md', '.planning/agile/declined.md', '.planning/agile/filed.md']) assert.ok(files.includes(p), p);
  const theirs = (p) => moved.includes(p) || p === '.planning/spikes/gone/SPIKE.md' || p.startsWith('.planning/_archive-old-path/') || p.startsWith('.planning/agile/')
    || ['.planning/records/state.json', '.planning/records/.gitignore', '.planning/config.json', '.github/cadence/coverage-policy.json'].includes(p);
  assert.deepEqual(files.filter((p) => !theirs(p)), [], 'the commit holds the switch and the start alone');
  for (const p of ['.planning/_archive-old-path/trace.jsonl', '.planning/_archive-old-path/_archive-v1.0.0/1/REVIEW-diff.md']) {
    assert.ok(!files.includes(p), `${p} was never tracked, so the switch doesn't commit it`);
    assert.match(git('status', '--porcelain', '--', p).stdout, /^\?\? /, p);
  }
  assert.equal(git('diff', '--cached', '--name-only').stdout, 'notes.md\n', 'the user\'s own staged file stays staged and out of the commit');
  assert.deepEqual(git('status', '--porcelain', '--', '.planning').stdout.split('\n').filter((l) => l && !l.startsWith('??')), [], 'nothing tracked under .planning is left changed');
  assert.deepEqual(run(dir, ['stage-switch']), { ok: true, staged: 0, paths: [], _exit: 0 }, 'once committed there is nothing to stage');
});

test('a start that isn\'t a switch stages nothing, and a project whose move stopped partway names /cad-agile to finish it', (t) => {
  const plain = join(scratch('cad-agile-plain-', t), '.planning');
  spawnSync('git', ['init', '-q'], { cwd: dirname(plain) });
  assert.equal(start(answerSetup(plain)).ok, true);
  assert.deepEqual(run(plain, ['stage-switch']), { ok: true, staged: 0, paths: [], _exit: 0 });
  const { dir } = richProject(t);
  writeFileSync(switchListFile(dir), 'PROJECT.md\n');
  mkdirSync(join(oldPathArchive(dir), 'records'), { recursive: true });
  assert.equal(markAgile(dir, join(oldPathArchive(dir), 'records', 'state.json')).ok, true);
  const n = next(dir);
  assert.deepEqual([n.ok, n.reason], [false, 'switch'], JSON.stringify(n));
  assert.equal(n.hint, 'run /cad-agile --brief <folder> with the same design to finish it; nothing was written');
});

/** A landed project whose .planning git tracks, switched by a start. */
function switchedTracked(t, extra = () => {}) {
  const { dir, design } = richProject(t);
  const root = dirname(dir);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...WHO };
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', env });
  extra(dir);
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  assert.equal(git('commit', '-q', '-m', 'old path').status, 0);
  return { dir, design, root, env, git };
}

test('a switch whose staged copies the user committed by hand still commits the old places gone, and a file written later under an archived name stays the user\'s', (t) => {
  const { dir, design, root, env, git } = switchedTracked(t);
  assert.equal(start(dir, design).ok, true);
  assert.equal(run(dir, ['stage-switch']).ok, true);
  // a run stopped here, and the user's own plain commit took the staged copies with it
  assert.equal(git('commit', '-q', '-m', 'mine').status, 0);
  const again = run(dir, ['stage-switch']);
  assert.ok(again.paths.includes('.planning/PROJECT.md'), JSON.stringify(again));
  assert.equal(spawnSync('sh', ['-c', commitStep(again.paths)], { cwd: root, encoding: 'utf8', env }).status, 0);
  assert.deepEqual(git('status', '--porcelain', '--', '.planning').stdout.split('\n').filter((l) => l && !l.startsWith('??')), [], 'no old place is left deleted and uncommitted');
  // a design the user writes under a name the switch archived is theirs, not a move
  put(dir, 'PROJECT.md', '# my own notes\n');
  git('add', '.planning/PROJECT.md');
  assert.deepEqual(run(dir, ['stage-switch']), { ok: true, staged: 0, paths: [], _exit: 0 });
});

test('a tracked name holding a glob character stages that file alone, never an untracked neighbour it would match', (t) => {
  const { dir, design, root, env, git } = switchedTracked(t, (d) => put(d, 'tasks/fix-typo/NOTE*.md', 'tracked\n'));
  put(dir, 'tasks/fix-typo/NOTE-x.md', 'untracked\n');
  assert.equal(start(dir, design).ok, true);
  const staged = run(dir, ['stage-switch']);
  assert.equal(spawnSync('sh', ['-c', commitStep(staged.paths)], { cwd: root, encoding: 'utf8', env }).status, 0);
  const files = git('show', '--no-renames', '--name-only', '--format=', 'HEAD').stdout.split('\n');
  assert.ok(files.includes('.planning/_archive-old-path/tasks/fix-typo/NOTE*.md'));
  assert.ok(!files.includes('.planning/_archive-old-path/tasks/fix-typo/NOTE-x.md'));
  assert.match(git('status', '--porcelain', '--', '.planning/_archive-old-path/tasks/fix-typo/NOTE-x.md').stdout, /^\?\? /);
});

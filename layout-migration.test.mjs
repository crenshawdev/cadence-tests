// Zero-dep end-to-end test for the one-time layout migration (AC7). Run:
// node --test tests/layout-migration.test.mjs
// A v4.0 project stopped mid-plan, and one stopped mid-phase, each converts on its first main-session call and is then
// finished to phase complete through the seams, the way /cad-execute and /cad-verify drive them. No agent runs: the
// test writes what an executor and a session would write. Conversion mechanics and each seam's own refusals are
// planning-migrate.test.mjs's and the per-seam files', so nothing here repeats them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PLANNING, treeOf } from './planning.test.mjs';
import { phaseReportsDir } from '../cadence-core/bin/lib/planning-store.mjs';
import { readState, STAMP_KEY, STATE_LAYOUT, statePath } from '../cadence-core/bin/lib/project-state.mjs';
import { renderPhasesList, renderStateMd, renderTraceability } from '../cadence-core/bin/lib/state-views.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** One seam call from the project root, the way a main session makes it. */
function seam(root, dir, args, stdin) {
  let stdout;
  try {
    stdout = execFileSync('node', [PLANNING, ...args, '--dir', dir],
      { cwd: root, encoding: 'utf8', ...(stdin !== undefined ? { input: stdin } : {}) });
  } catch (e) { stdout = e.stdout; }
  return JSON.parse(stdout);
}

const put = (dir, rel, text) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
};

const PLANS = ['PLAN-1.md', 'PLAN-2.md', 'PLAN-3.md'];
const report = (k) => `PLAN COMPLETE\nPlan: .planning/phases/1/PLAN-${k}.md\nTasks: 1 of 1\n`;
const event = (ts, ev, plan) => JSON.stringify({ corr: '1-abc1234', phase: '1', ts: `2026-10-01T${ts}:00.000Z`, family: 'lifecycle',
  event: ev, ...(plan ? { plan: String(plan), role: 'cad-executor' } : { sha: 'abc1234' }) });

/**
 * A v4.0 project, written file by file, with plans `finished` reported done and plan `next` up. `open` leaves that plan
 * dispatched with no return, the way an executor killed mid-run leaves it. Returns the planning directory and its root.
 */
function v40(finished, next, open) {
  const root = mkdtempSync(join(tmpdir(), 'cad-layout-'));
  const dir = join(root, '.planning');
  put(dir, 'config.json', JSON.stringify({ planning: { commit_docs: true } }));
  put(dir, 'ROADMAP.md', '# Roadmap: Fixture\n\n## Phases\n\n- [ ] **Phase 1: Layout** - move the records\n\n'
    + '## Phase Details\n\n### Phase 1: Layout\n**Goal:** one layout\n**Depends on:** Nothing\n');
  put(dir, 'REQUIREMENTS.md', '# Requirements: Fixture\n\n## Traceability\n\n| Requirement | Phase | Status |\n|---|---|---|\n'
    + '| LAY-01 | Phase 1 | Pending |\n');
  put(dir, 'STATE.md', `# State\n\nPhase: 1 of 1 (Layout)\nPlan: ${next} of 3\nStatus: planned\nNext: /cad-execute 1\nUpdated: 2026-10-01\n`);
  put(dir, 'phases/1/CONTEXT.md', '# Phase 1 Context\n\n## Decisions\n\n- D-01 (layout): records live apart\n');
  for (const [i, f] of PLANS.entries()) put(dir, `phases/1/${f}`, `---\nphase: 1\nrequirements: [LAY-01]\nfiles: []\n---\n# Plan ${i + 1}\n`);
  for (let k = 1; k <= finished; k++) put(dir, `phases/1/reports/plan-${k}.md`, report(k));
  put(dir, 'phases/1/REVIEW-diff-plan-1.md', '# Review: diff, plan 1\n\nNo findings.\n');
  put(dir, 'phases/1/ADJUDICATION-diff-plan-1.json', '{"trigger":"diff","plan":1,"rulings":[]}\n');
  const trace = [event('09:00', 'phase_start')];
  for (let k = 1; k <= finished; k++) trace.push(event(`1${k}:00`, 'dispatch', k), event(`1${k}:30`, 'return', k));
  if (open) trace.push(event('15:00', 'dispatch', next));
  put(dir, 'trace.jsonl', `${trace.join('\n')}\n`);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 't@example.com');
  git(root, 'config', 'user.name', 'T');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'add', '-A', '.planning');
  git(root, 'commit', '-q', '-m', 'v4.0 project');
  return { root, dir };
}

/** Convert, then finish the phase with the calls and writes /cad-execute and /cad-verify make, in their order. */
function convertAndFinish({ root, dir }, outstanding) {
  const first = seam(root, dir, ['status']);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.current, 1);
  assert.deepEqual(first.outstanding, [{ phase: 1, plans: outstanding }]);
  assert.deepEqual([first.migration?.converted, first.migration?.commit_due], [true, true]);
  assert.equal(JSON.parse(readFileSync(statePath(dir), 'utf8'))[STAMP_KEY], STATE_LAYOUT);
  for (const rel of ['records/trace.jsonl', 'phases/1/records/REVIEW-diff-plan-1.md', 'phases/1/records/ADJUDICATION-diff-plan-1.json']) {
    assert.equal(existsSync(join(dir, rel)), true, rel);
  }
  for (const rel of ['trace.jsonl', 'phases/1/reports', 'phases/1/REVIEW-diff-plan-1.md', 'phases/1/ADJUDICATION-diff-plan-1.json']) {
    assert.equal(existsSync(join(dir, rel)), false, rel);
  }
  git(root, 'add', '-A', '.planning');
  git(root, 'commit', '-q', '-m', 'docs: convert the planning directory');
  assert.equal(git(root, 'status', '--porcelain'), '');

  // the executor's report lands where the write module says, then the session moves the cursor
  const pdir = join(dir, 'phases', '1');
  for (const f of outstanding) {
    const k = Number(/\d+/.exec(f)[0]);
    put(phaseReportsDir(pdir), `plan-${k}.md`, report(k));
    assert.equal(seam(root, dir, ['cursor', 'set', '--phase', '1', '--status', 'planned', '--next', '/cad-execute 1']).ok, true);
  }
  put(pdir, 'SUMMARY.md', '---\nphase: 1\nstatus: complete\n---\n\n# Phase 1 Summary\n\nEvery plan ran.\n');
  assert.equal(seam(root, dir, ['cursor', 'set', '--phase', '1', '--status', 'executed', '--next', '/cad-verify 1']).ok, true);
  const init = seam(root, dir, ['uat', 'init', '--phase', '1'], JSON.stringify([{ name: 'Records apart', expected: 'records sit under records/', criterion: 'AC1' }]));
  assert.equal(init.ok, true, JSON.stringify(init));
  assert.equal(seam(root, dir, ['uat', 'record', '--phase', '1', '--item', '1', '--result', 'pass']).ok, true);
  assert.equal(seam(root, dir, ['phase-done', '--n', '1']).ok, true);
  assert.equal(seam(root, dir, ['cursor', 'set', '--phase', '1', '--status', 'phase complete', '--next', '/cad-milestone']).ok, true);

  const done = seam(root, dir, ['status']);
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.deepEqual(done.outstanding, []);
  assert.equal(done.phases[0].status, 'complete');
  assert.equal('drift' in done, false, JSON.stringify(done.drift));

  // what a person reads is exactly what the state file renders to
  const { state } = readState(dir);
  assert.equal(readFileSync(join(dir, 'STATE.md'), 'utf8'), renderStateMd(state));
  const roadmap = readFileSync(join(dir, 'ROADMAP.md'), 'utf8');
  assert.equal(roadmap, renderPhasesList(state, roadmap).text);
  const reqs = readFileSync(join(dir, 'REQUIREMENTS.md'), 'utf8');
  assert.equal(reqs, renderTraceability(state, reqs).text);

  // converted once means once
  const settled = treeOf(dir);
  assert.equal('migration' in seam(root, dir, ['status']), false);
  assert.deepEqual(treeOf(dir), settled);
}

test('a v4.0 project stopped mid-plan converts and runs to phase complete', () => {
  convertAndFinish(v40(1, 2, true), ['PLAN-2.md', 'PLAN-3.md']);
});

test('a v4.0 project stopped between plans converts and runs to phase complete', () => {
  convertAndFinish(v40(2, 3, false), ['PLAN-3.md']);
});

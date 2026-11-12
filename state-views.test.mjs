// Zero-dep tests for lib/state-views.mjs - the three files generated from a project state.
// Run: node --test tests/state-views.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTree } from './planning.test.mjs';
import { importState } from '../cadence-core/bin/planning/state-import.mjs';
import { renderPhasesList, renderStateMd, renderTraceability } from '../cadence-core/bin/lib/state-views.mjs';
import {
  parseRequirements, parseRoadmapPhases, renderCursor,
} from '../cadence-core/bin/lib/planning-files.mjs';
import { parseCursor } from '../cadence-core/bin/lib/state-cursor.mjs';

const phase = (n, name, description, status, plans = []) => ({ n, name, description, status, plans });
const state = (over = {}) => ({
  cycleOpen: true,
  cursor: { phase: 2, status: 'planned', next: '/cad-execute 2', updated: '2026-02-03' },
  phases: [phase(1, 'Base', 'lay it', 'complete'), phase(2, 'Auth', 'sign in', 'planned')],
  requirements: [],
  ...over,
});

const ROADMAP = [
  '# Roadmap: Fixture', '', '## Overview', '', 'Prose that mentions Phase 9 in passing.', '',
  '## Phases', '',
  '```', '- [ ] **Phase 9: Example** - a fenced example the reader skips', '```', '',
  '- [ ] **Phase 1: Old name** - old', '- [ ] **Phase 3: Gone** - removed from the state', '',
  'A closing note under the list.', '',
  '## Phase Details', '', '### Phase 1: Old name', '**Goal:** goal', '',
  '```', '- [x] **Phase 8: Fenced detail** - never touched', '```', '',
].join('\n');

test('the phases list is rewritten from the state, in numeric order, and nothing else moves', () => {
  const s = state({ phases: [phase(2.1, 'Urgent', 'inserted', 'unplanned'), phase(2, 'Auth', '', 'planned'),
    phase(1, 'Base', 'lay it', 'complete')] });
  const r = renderPhasesList(s, ROADMAP);
  assert.equal(r.missing, false);
  assert.deepEqual(parseRoadmapPhases(r.text), [
    { n: 1, name: 'Base', desc: 'lay it', checked: true },
    { n: 2, name: 'Auth', desc: '', checked: false },
    { n: 2.1, name: 'Urgent', desc: 'inserted', checked: false },
  ]);
  const expected = ROADMAP
    .replace('- [ ] **Phase 1: Old name** - old\n- [ ] **Phase 3: Gone** - removed from the state\n',
      '- [x] **Phase 1: Base** - lay it\n- [ ] **Phase 2: Auth**\n- [ ] **Phase 2.1: Urgent** - inserted\n');
  assert.equal(r.text, expected);
});

test('a phases heading with no list gets the list after its blank line, and a missing heading is flagged and not invented', () => {
  const bare = '# Roadmap\n\n## Phases\n\n## Phase Details\n\n### Phase 1: Base\n';
  const r = renderPhasesList(state(), bare);
  assert.equal(r.text, '# Roadmap\n\n## Phases\n\n- [x] **Phase 1: Base** - lay it\n- [ ] **Phase 2: Auth** - sign in\n\n## Phase Details\n\n### Phase 1: Base\n');
  const noHeading = '# Roadmap\n\nNothing listed.\n';
  assert.deepEqual(renderPhasesList(state(), noHeading), { text: noHeading, missing: true });
  // a heading only inside a fence is not the heading
  const fenced = '# Roadmap\n\n```\n## Phases\n```\n';
  assert.deepEqual(renderPhasesList(state(), fenced), { text: fenced, missing: true });
});

test('an emptied state leaves a phases heading with no list, and CRLF files keep their line endings', () => {
  const closed = renderPhasesList(state({ cycleOpen: false, phases: [] }), ROADMAP);
  assert.deepEqual(parseRoadmapPhases(closed.text), []);
  const crlf = '# R\r\n\r\n## Phases\r\n\r\n- [ ] **Phase 1: Old** - x\r\n\r\n## Phase Details\r\n';
  const r = renderPhasesList(state(), crlf);
  assert.equal(r.text, '# R\r\n\r\n## Phases\r\n\r\n- [x] **Phase 1: Base** - lay it\r\n- [ ] **Phase 2: Auth** - sign in\r\n\r\n## Phase Details\r\n');
});

const REQS = [
  '# Requirements: Fixture', '', '## Active', '', '- [ ] **REQ-1**: kept as written', '',
  '## Traceability', '', '| Requirement | Phase | Status |', '|---|---|---|',
  '| REQ-1 | Phase 1 | Pending |', '| REQ-7 | Phase 9 | Pending |', '', 'Prose under the table.', '',
  '## Shipped', '', '| REQ-0 | Phase 1 | Complete |', '',
].join('\n');

test('the traceability rows are rewritten from the state; Active, Shipped, the header and the prose stay', () => {
  const s = state({ requirements: [{ id: 'REQ-1', phase: 1, status: 'Complete' },
    { id: 'REQ-2', phase: 2, status: 'Pending' }, { id: 'REQ-3', phase: null, status: 'Deferred' }] });
  const r = renderTraceability(s, REQS);
  assert.equal(r.missing, false);
  assert.deepEqual(parseRequirements(r.text), s.requirements);
  assert.equal(r.text, REQS.replace('| REQ-1 | Phase 1 | Pending |\n| REQ-7 | Phase 9 | Pending |\n',
    '| REQ-1 | Phase 1 | Complete |\n| REQ-2 | Phase 2 | Pending |\n| REQ-3 |  | Deferred |\n'));
});

test('a traceability section with no table, or no section, is flagged and left alone', () => {
  const noTable = '# R\n\n## Traceability\n\nnothing yet\n';
  assert.deepEqual(renderTraceability(state(), noTable), { text: noTable, missing: true });
  const none = '# R\n\n## Active\n';
  assert.deepEqual(renderTraceability(state(), none), { text: none, missing: true });
  const bare = '# R\n\n## Traceability\n\n| Requirement | Phase | Status |\n|---|---|---|\n\n## Shipped\n';
  const r = renderTraceability(state({ requirements: [{ id: 'REQ-1', phase: 1, status: 'Pending' }] }), bare);
  assert.equal(r.text, '# R\n\n## Traceability\n\n| Requirement | Phase | Status |\n|---|---|---|\n| REQ-1 | Phase 1 | Pending |\n\n## Shipped\n');
});

test('STATE.md with a cycle open is what renderCursor writes for the same cursor, byte for byte', () => {
  const s = state({ cursor: { phase: 2, status: 'paused', next: 'wait. '.repeat(100).trim(), updated: '2026-02-03',
    plan: { k: 1, j: 2, name: 'The plan' } } });
  assert.equal(renderStateMd(s), renderCursor({ phase: 2, total: 2, name: 'Auth', status: 'paused',
    next: s.cursor.next, updated: '2026-02-03', plan: { k: 1, j: 2, name: 'The plan' } }));
  assert.deepEqual(parseCursor(renderStateMd(s)).next, s.cursor.next);
});

test('STATE.md with no cycle open says so, keeps Next and Updated, and has no Phase line', () => {
  const text = renderStateMd(state({ cycleOpen: false, phases: [],
    cursor: { phase: 3, status: 'phase complete', next: '/cad-new-milestone', updated: '2026-02-03' } }));
  assert.match(text, /^# State\n\nNo cycle is open/);
  assert.match(text, /\nNext: \/cad-new-milestone\nUpdated: 2026-02-03\n$/);
  assert.doesNotMatch(text, /^Phase:/m);
  assert.doesNotMatch(text, /of 0/);
  // with nothing recorded, the words still stand alone
  assert.match(renderStateMd(state({ cycleOpen: false, phases: [], cursor: null })), /No cycle is open/);
});

test('a state imported from files already in step renders each of the three back unchanged', () => {
  const dir = makeTree({
    roadmap: [{ n: 1, name: 'Base', checked: true, desc: 'lay it' }, { n: 2, name: 'Auth', desc: 'sign in' },
      { n: 2.1, name: 'Urgent', desc: 'inserted' }],
    phases: { 1: { plan: true, summary: true, uat: [{ status: 'pass' }] }, 2: { plan: ['PLAN-1.md'] } },
    reqs: [['REQ-1', 1, 'Complete'], ['REQ-2', 2, 'Pending'], ['REQ-3', null, 'Deferred']],
    cursor: { phase: 2, total: 3, name: 'Auth', status: 'planned', next: '/cad-execute 2', updated: '2026-02-03' },
  });
  const imported = importState(dir);
  assert.equal(imported.ok, true);
  const at = (f) => readFileSync(join(dir, f), 'utf8');
  assert.equal(renderPhasesList(imported.state, at('ROADMAP.md')).text, at('ROADMAP.md'));
  assert.equal(renderTraceability(imported.state, at('REQUIREMENTS.md')).text, at('REQUIREMENTS.md'));
  assert.equal(renderStateMd(imported.state), at('STATE.md'));
  // and the state it renders from is not what a hand edit would break: a box flipped in the file is put back
  writeFileSync(join(dir, 'ROADMAP.md'), at('ROADMAP.md').replace('- [x] **Phase 1', '- [ ] **Phase 1'));
  assert.match(renderPhasesList(imported.state, at('ROADMAP.md')).text, /- \[x\] \*\*Phase 1: Base/);
});

test('a malformed entry inside the list is replaced with the rest of it, while a bullet merely citing a phase stays', () => {
  const text = '# R\n\n## Phases\n\n- [ ] **Phase 1: Base** - lay it\n- Phase 3: X\n| Phase 4 | table |\n- depends on Phase 2 landing\n\n## Phase Details\n';
  const r = renderPhasesList(state({ phases: [phase(1, 'Base', 'lay it', 'complete')] }), text);
  assert.equal(r.text, '# R\n\n## Phases\n\n- [x] **Phase 1: Base** - lay it\n- depends on Phase 2 landing\n\n## Phase Details\n');
});

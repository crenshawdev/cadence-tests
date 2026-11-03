// Tests for cadence-core/templates/coverage-report-check.mjs. Run the script as
// a subprocess against small inline reports; no network, no new dependency.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'cadence-core', 'templates', 'coverage-report-check.mjs');

/** A project dir holding the policy and one report; returns the run result. */
function run(format, report, coverage = {}, { files = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cad-crc-'));
  const policy = { coverage: { lines: 85, branches: 85, statements: 0, include: [], exclude: [], commands: [], ...coverage } };
  mkdirSync(join(dir, '.github', 'cadence'), { recursive: true });
  writeFileSync(join(dir, '.github', 'cadence', 'coverage-policy.json'), JSON.stringify(policy));
  if (report !== null) writeFileSync(join(dir, 'report'), report);
  if (files.length) {
    execFileSync('git', ['-C', dir, 'init', '-q']);
    for (const f of files) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), ''); }
    execFileSync('git', ['-C', dir, 'add', '.']);
  }
  const r = spawnSync('node', [SCRIPT, '--format', format, '--report', 'report'], { cwd: dir, encoding: 'utf8' });
  return { code: r.status, out: r.stdout };
}

/** A coverage.py JSON report with the totals given. */
const py = (t, branchCoverage = true, files = { 'src/a.py': {} }) => JSON.stringify({
  meta: { branch_coverage: branchCoverage }, files, totals: { covered_lines: 9, num_statements: 10, ...t },
});

test('python: every metric meeting its threshold passes', () => {
  const r = run('python', py({ covered_branches: 9, num_branches: 10 }));
  assert.equal(r.code, 0);
  assert.match(r.out, /lines: 90\.00% meets 85/);
  assert.match(r.out, /branches: 90\.00% meets 85/);
});

test('python: a lines-only miss names lines and not branches', () => {
  const r = run('python', py({ covered_lines: 5, covered_branches: 9, num_branches: 10 }));
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL lines: 50\.00% is below 85/);
  assert.doesNotMatch(r.out, /FAIL branches/);
});

test('python: a branches-only miss names branches and not lines', () => {
  const r = run('python', py({ covered_branches: 5, num_branches: 10 }));
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL branches: 50\.00% is below 85/);
  assert.doesNotMatch(r.out, /FAIL lines/);
});

test('python: a complete report with zero branches reads not applicable and passes', () => {
  const r = run('python', py({ covered_branches: 0, num_branches: 0 }));
  assert.equal(r.code, 0);
  assert.match(r.out, /branches: not applicable—zero branches/);
});

test('python: branch measurement off fails a branch threshold above 0', () => {
  const r = run('python', py({}, false));
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL branches: threshold 85 but branch measurement is off/);
});

test('python: branches 0 prints as disabled, never satisfied', () => {
  const r = run('python', py({}, false), { branches: 0 });
  assert.equal(r.code, 0);
  assert.match(r.out, /branches: disabled \(threshold 0\)/);
  assert.doesNotMatch(r.out, /branches: .*meets/);
});

test('python: a tracked in-scope file absent from the report fails and is named', () => {
  const r = run('python', py({ covered_branches: 9, num_branches: 10 }),
    { include: ['src/**'], exclude: ['src/skip.py'] },
    { files: ['src/a.py', 'src/b.py', 'src/skip.py', 'src/data.txt'] });
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL files: .*src\/b\.py/);
  assert.doesNotMatch(r.out, /skip\.py|a\.py|data\.txt/);
});

test('go: a statement miss fails, and a line threshold above 0 fails because Go reports none', () => {
  const report = 'x.go:3:\tF\t50.0%\ntotal:\t(statements)\t80.0%\n';
  const r = run('go', report, { lines: 0, branches: 0, statements: 85 });
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL statements: 80\.00% is below 85/);
  const lines = run('go', report.replace('80.0', '90.0'), { lines: 85, branches: 0, statements: 85 });
  assert.equal(lines.code, 1);
  assert.match(lines.out, /FAIL lines: threshold 85 but Go reports statements, not lines/);
});

test('lcov: a branch miss fails; zero branches pass only with --branch in an accepted command', () => {
  const miss = run('lcov', 'SF:a.rs\nLF:10\nLH:10\nBRF:10\nBRH:5\nend_of_record\n');
  assert.equal(miss.code, 1);
  assert.match(miss.out, /FAIL branches: 50\.00% is below 85/);
  assert.match(miss.out, /lines: 100\.00% meets 85/);
  const zero = 'SF:a.rs\nLF:10\nLH:10\nBRF:0\nBRH:0\nend_of_record\n';
  assert.match(run('lcov', zero, { commands: ['cargo +nightly llvm-cov --branch --lcov'] }).out, /not applicable—zero branches/);
  assert.match(run('lcov', zero).out, /FAIL branches: threshold 85 but the report holds no branches/);
});

test('a missing threshold fails and names the metric; only an explicit 0 disables it', () => {
  const r = run('python', py({ covered_branches: 9, num_branches: 10 }), { branches: undefined });
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL policy: branches threshold is missing/);
  assert.doesNotMatch(r.out, /disabled/);
});

test('lcov: a report with no BRF record is a missing measurement, not zero branches', () => {
  const r = run('lcov', 'SF:a.rs\nLF:10\nLH:10\nend_of_record\n', { commands: ['cargo +nightly llvm-cov --branch --lcov'] });
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL branches: threshold 85 but the report has no BRF branch records/);
});

test('unusable reports fail: a missing one and a malformed one', () => {
  const missing = run('python', null);
  assert.equal(missing.code, 1);
  assert.match(missing.out, /FAIL report: cannot read/);
  const bad = run('python', '{not json');
  assert.equal(bad.code, 1);
  assert.match(bad.out, /FAIL report: .* is not a coverage\.py JSON report/);
});

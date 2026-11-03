// Zero-dep tests for `planning.mjs test-policy`. Run:
// node --test tests/planning-test-policy.test.mjs
//
// Fixtures are a project root holding a `.planning/config.json` and, where a
// check needs them, workflow files and a git repository. Nothing here runs an
// accepted command (D-03) or reaches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLANNING } from './planning.test.mjs';

const POLICY = join('.github', 'cadence', 'coverage-policy.json');

/** A project root whose repo config holds `testing` (and `git`, when given). */
function project(testing, git) {
  const root = mkdtempSync(join(tmpdir(), 'cad-testpolicy-'));
  mkdirSync(join(root, '.planning'));
  writeFileSync(join(root, '.planning', 'config.json'),
    JSON.stringify({ ...(testing ? { testing } : {}), ...(git ? { git } : {}) }));
  return root;
}

/** One seam call, parsed. The user-global layer is pointed at a file that
 *  does not exist, so no machine's own config reaches the fixture. */
function policy(args, root, env) {
  let stdout;
  let code = 0;
  try {
    stdout = execFileSync('node', [PLANNING, 'test-policy', ...args, '--root', root], {
      encoding: 'utf8',
      env: { ...process.env, CADENCE_GLOBAL_CONFIG: join(root, 'no-global.json'), ...env },
    });
  } catch (e) { stdout = e.stdout; code = e.status; }
  return { ...JSON.parse(stdout), _exit: code };
}

test('render writes the config\'s values with the schema defaults filled, byte-identically on a re-render', () => {
  const root = project({ scope: 'integrated', coverage: { lines: 90, commands: ['npm run cov -- --lines={lines}'] }, required_jobs: ['test'] });
  const r = policy(['render'], root);
  assert.equal(r.ok, true);
  assert.equal(r.file, POLICY);
  const first = readFileSync(join(root, POLICY), 'utf8');
  assert.deepEqual(JSON.parse(first), {
    scope: 'integrated',
    coverage: { lines: 90, branches: 85, statements: 0, include: [], exclude: [], commands: ['npm run cov -- --lines={lines}'] },
    strong_areas: [],
    required_jobs: ['test'],
  });
  assert.ok(first.endsWith('}\n'));
  policy(['render'], root);
  assert.equal(readFileSync(join(root, POLICY), 'utf8'), first);
});

test('render refuses with a hint when no policy was accepted, and writes nothing', () => {
  const root = project({ coverage: { lines: 90 } });
  const r = policy(['render'], root);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-policy');
  assert.match(r.hint, /\/cad-config --testing/);
  assert.equal(existsSync(join(root, POLICY)), false);
  assert.equal(policy(['bogus'], root).reason, 'usage');
});

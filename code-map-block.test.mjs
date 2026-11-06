// Pins for the code map switch and the block /cad-plan and /cad-context carry (Phase 3, plan 3). The prose is followed
// by a model, so these hold what a rewrite could quietly lose; the live run is checked at /cad-verify.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_MJS = join(ROOT, 'cadence-core', 'bin', 'config.mjs');

// The switch is an ordinary boolean read through `get`, so the fixture proves both layers count.
function readSwitch(repo, global) {
  const root = mkdtempSync(join(tmpdir(), 'cad-codemap-'));
  try {
    mkdirSync(join(root, '.planning'));
    if (repo !== undefined) writeFileSync(join(root, '.planning', 'config.json'), JSON.stringify(repo));
    const g = join(root, 'g.json');
    if (global !== undefined) writeFileSync(g, JSON.stringify(global));
    const out = execFileSync('node', [CONFIG_MJS, 'get', 'planning.code_map'],
      { encoding: 'utf8', cwd: root, env: { ...process.env, CADENCE_GLOBAL_CONFIG: g } });
    return JSON.parse(out).values['planning.code_map'];
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('planning.code_map reads false when unset and true when the repo or the global layer alone sets it', () => {
  assert.equal(readSwitch({}), false);
  assert.equal(readSwitch({ planning: { code_map: true } }), true);
  assert.equal(readSwitch({}, { planning: { code_map: true } }), true);
});

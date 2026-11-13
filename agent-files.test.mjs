// Tests for agent-files.mjs - the generator that writes the table-named agent
// files from lib/rung-agent.mjs. Run: node --test tests/agent-files.test.mjs
// Every row runs the real script against a temp copy of agents/, never the live tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNG_FILES } from '../cadence-core/bin/lib/rung-agent.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(REPO, 'cadence-core', 'bin', 'agent-files.mjs');
const STEMS = Object.values(RUNG_FILES).flatMap(({ rungs }) => Object.values(rungs));

/** A temp tree holding a copy of the live agents/. */
function copyTree() {
  const root = mkdtempSync(join(tmpdir(), 'cad-agent-files-'));
  cpSync(join(REPO, 'agents'), join(root, 'agents'), { recursive: true });
  return root;
}

/** @param {string} root */
function generate(root) {
  return JSON.parse(execFileSync('node', [SCRIPT, '--root', root], { encoding: 'utf8' }));
}

const live = (stem) => readFileSync(join(REPO, 'agents', `${stem}.md`), 'utf8');

test('a run over a copy of the live agents/ leaves every table-named file byte-identical', () => {
  const root = copyTree();
  try {
    const r = generate(root);
    assert.equal(r.ok, true);
    assert.deepEqual(r.written, [], 'the live files are what the table renders');
    assert.equal(STEMS.length, 35);
    for (const stem of STEMS) {
      assert.equal(readFileSync(join(root, 'agents', `${stem}.md`), 'utf8'), live(stem), stem);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a table-named file deleted from the copy is written back', () => {
  const root = copyTree();
  try {
    unlinkSync(join(root, 'agents', 'cad-verifier-xhigh.md'));
    const r = generate(root);
    assert.deepEqual(r.written, ['agents/cad-verifier-xhigh.md']);
    assert.equal(readFileSync(join(root, 'agents', 'cad-verifier-xhigh.md'), 'utf8'), live('cad-verifier-xhigh'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a hand-written agent file the table does not name is left byte-identical', () => {
  const root = copyTree();
  const oneOff = '---\nname: cad-one-off\ntools: Read\n---\n\nSay hello, then stop.\n';
  try {
    writeFileSync(join(root, 'agents', 'cad-one-off.md'), oneOff);
    generate(root);
    assert.equal(readFileSync(join(root, 'agents', 'cad-one-off.md'), 'utf8'), oneOff);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

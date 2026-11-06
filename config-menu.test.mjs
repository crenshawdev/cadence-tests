// Pins for the /cad-config menu prose (config.md's route and config-menu.md). The prose is followed by a model, so
// these hold what a rewrite could quietly lose; the live run is checked at /cad-verify.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_MD = readFileSync(join(ROOT, 'cadence-core', 'workflows', 'config.md'), 'utf8');
const MENU_MD = readFileSync(join(ROOT, 'cadence-core', 'workflows', 'config-menu.md'), 'utf8');

// the text under one `## ` heading, up to the next one
function section(text, heading) {
  const start = text.indexOf(`\n## ${heading}`);
  assert.notEqual(start, -1, `no "## ${heading}" heading`);
  const next = text.indexOf('\n## ', start + 4);
  return text.slice(start, next === -1 ? undefined : next);
}

test('the route lists flags, then every-token key=value, then the opening screen, in that order', () => {
  const route = section(CONFIG_MD, '1. Route');
  const at = (needle) => {
    const i = route.indexOf(needle);
    assert.notEqual(i, -1, `route does not say ${needle}`);
    return i;
  };
  const order = [at('Starts with `--review`'), at('Starts with `--roles`'), at('- `--walk`'),
    at('Every token is `<key>=<value>`'), at('- Empty:')];
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test('--walk routes to the walk heading, which keeps its name', () => {
  assert.match(section(CONFIG_MD, '1. Route'), /- `--walk`: go to \*\*Interactive menu \(no args\)\*\*/);
  assert.ok(CONFIG_MD.includes('\n## Interactive menu (no args)\n'));
});

test('config.md reads config-menu.md for the menu paths, not Direct set', () => {
  assert.match(section(CONFIG_MD, '1. Route'), /Read `\$\{CLAUDE_PLUGIN_ROOT\}\/cadence-core\/workflows\/config-menu\.md`/);
  assert.ok(!section(CONFIG_MD, 'Direct set').includes('config-menu.md'));
});

test('the opening screen reads the layer read, names beaten globals and unreadable layers, and ends the turn', () => {
  const s = section(MENU_MD, 'Opening screen');
  assert.match(s, /config\.mjs" layers\n/);
  assert.doesNotMatch(s, /\.planning\/config\.json|~\/\.claude/);
  assert.match(s, /repo values beat global/);
  assert.match(s, /`unreadable`/);
  assert.match(s, /never show it as 0/);
  assert.match(s, /end the turn/);
  assert.doesNotMatch(s, /AskUserQuestion/);
  assert.match(s, /Pick a number or say what you want to change\.\n```/);
  assert.match(s, /run \/cad-config --walk/);
});

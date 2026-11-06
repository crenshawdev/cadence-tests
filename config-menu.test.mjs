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

// whitespace collapsed, so a re-wrap of the prose breaks no pin
const flat = (text) => text.replace(/\s+/g, ' ');

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

test('a group ends its list turn without a box and names each guided setup against its group', () => {
  const s = flat(section(MENU_MD, 'A group'));
  assert.doesNotMatch(s, /AskUserQuestion/);
  assert.match(s, /ends the turn, never a choice box/);
  for (const [flag, group] of [['--roles', 'Models and effort'], ['--surfaces', 'When reviews run'],
    ['--review', 'Who reviews'], ['--testing', 'Testing']]) {
    assert.ok(s.includes(`\`${flag}\` for ${group}`), `${flag} is not named for ${group}`);
  }
  assert.match(s, /Git and landing and How work runs have none/);
});

test('a pick shows the three layers, compares four keys against the target file and states the file rules', () => {
  const s = flat(section(MENU_MD, 'A group'));
  assert.match(s, /the default, global and repo values with who wins/);
  for (const key of ['git.auto_close', 'workflow.use_workflows', 'workflow.multi_workflow', 'review.reviewers']) {
    assert.ok(s.includes(`\`${key}\``), key);
  }
  assert.match(s, /equals what the target file stores/);
  assert.match(s, /repo's `\.planning\/config\.json` by default, `set --global` for `src: global`, and the repo for `repo_only`/);
  assert.match(s, /review\.triggers\.risk_surface\.surfaces` opens \*\*Risk surfaces\*\*/);
});

test('set is called only after a yes in its own turn', () => {
  const s = flat(section(MENU_MD, 'A group'));
  assert.match(s, /ask for a yes in a turn of its own\. Only after the yes, call `set`/);
  assert.ok(s.indexOf('Only after the yes') < s.indexOf('config.mjs" set'));
});

test('Advanced takes the same write path and provider keys go to provider setup', () => {
  const s = flat(section(MENU_MD, 'A group'));
  assert.match(s, /layers --group "<name>" --advanced/);
  assert.match(s, /same pick and write path/);
  assert.match(s, /`review\.providers\.\*` goes to \*\*Review provider setup\*\*/);
});

test('leaving a group runs the walk follow-ups', () => {
  const s = flat(section(MENU_MD, 'A group'));
  assert.match(s, /\*\*Worktree base ref\*\* when `parallelization\.use_worktrees` is on/);
  assert.match(s, /\*\*Wrap-up\*\*'s dangling enrollment check/);
});

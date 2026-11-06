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
    at('Every token is `<key>=<value>`'), at('- Any other text is a sentence'), at('- Empty:')];
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

test('the list and the block both name the read\'s applies answer, and the block prints the no-effect and works-with lines', () => {
  const s = flat(section(MENU_MD, 'A group'));
  assert.match(s, /`repo` and `applies`\)/);
  assert.match(s, /A row whose `applies` is false is marked `\(no effect right now\)`/);
  assert.match(s, /When `applies` is false, add `No effect right now:` with each sentence of `no_effect`/);
  assert.match(s, /Add `Works with:` with the `interacts` text and each of `works_with` as its key beside its value/);
});

test('a setting with no effect can still be picked, and the block says so', () => {
  const s = flat(section(MENU_MD, 'A group'));
  assert.match(s, /A setting with no effect can still be picked, because it may be set up ahead of its gate, so end that line with "You can still set it now\."/);
});

test('a group pick shows the preview before set, with a yes between them', () => {
  const s = flat(section(MENU_MD, 'A group'));
  const preview = s.indexOf('config.mjs" preview <key>="$(cat <D>/value.json)"');
  const yes = s.indexOf('ask for a yes in a turn of its own');
  const set = s.indexOf('config.mjs" set');
  assert.ok(preview !== -1 && yes !== -1 && set !== -1);
  assert.ok(preview < yes && yes < set, `order is ${preview}, ${yes}, ${set}`);
  assert.match(s, /If you pick <value>:/);
  assert.match(s, /it stays off until both files are set/);
});

test('walk step 4 previews the batch once before the write and says a mixed batch is two set calls', () => {
  const walk = flat(section(CONFIG_MD, 'Interactive menu (no args)'));
  const step4 = walk.slice(walk.indexOf('4. After the last page'), walk.indexOf('5. `review.providers`'));
  assert.match(step4, /Run `config\.mjs preview <key>="\$\(cat <path>\)"…` once for the whole batch/);
  assert.match(step4, /ask for a yes in a turn of its own, then write/);
  assert.ok(step4.indexOf('preview') < step4.indexOf('`config.mjs set`'));
  assert.match(step4, /a batch for both layers is two `set` calls/);
  assert.match(flat(section(CONFIG_MD, 'Interactive menu (no args)')), /one `set` call per file/);
});

test('Direct set names no preview, so key=value and the guided flags get no new prompt', () => {
  assert.doesNotMatch(section(CONFIG_MD, 'Direct set'), /preview/i);
});

test('a sentence arm reads A sentence, and an opening-screen reply that is not a number goes the same way', () => {
  const route = flat(section(CONFIG_MD, '1. Route'));
  assert.match(route, /Any other text is a sentence: Read `\$\{CLAUDE_PLUGIN_ROOT\}\/cadence-core\/workflows\/config-menu\.md` and follow its \*\*A sentence\*\*/);
  assert.match(route, /A reply to the opening screen that is not a number from 1 to 6 goes the same way/);
  assert.match(flat(section(MENU_MD, 'Opening screen')), /Any other reply is read as a sentence \(\*\*A sentence\*\*\)/);
});

test('a sentence redirects the catalog, matches, writes the value to a file, previews, asks, then sets', () => {
  const s = flat(section(MENU_MD, 'A sentence'));
  const at = (needle) => {
    const i = s.indexOf(needle);
    assert.notEqual(i, -1, `the sentence section does not say ${needle}`);
    return i;
  };
  const order = [at('config.mjs" catalog > "$D/catalog.json"'), at('terms.json'), at('scratch-stale'),
    at('Write tool (`<D>/v1.json`'), at('config.mjs" preview <key>="$(cat <D>/v1.json)"'),
    at('Ask for a yes in a turn of its own. Only after the yes, call `set`'), at('config.mjs" set [--global] <key>="$(cat <D>/v1.json)"')];
  assert.deepEqual(order, [...order].sort((a, b) => a - b), order.join());
  assert.match(s, /one call per file the preview named/);
  assert.match(s, /Nothing matched: say so, name the groups from the opening screen, and write nothing/);
});

test('a sentence value reaches the preview and set only through its scratch file', () => {
  const s = flat(section(MENU_MD, 'A sentence'));
  assert.match(s, /A value taken from the sentence is written as JSON to its own file in that directory/);
  assert.match(s, /take it as `<key>="\$\(cat <path>\)"`/);
  assert.doesNotMatch(s, /(preview|set) (\[--global\] )?<key>=<value>/);
});

test('a sentence shows now, new and the file, and leaves the way a group does', () => {
  const s = flat(section(MENU_MD, 'A sentence'));
  assert.match(s, /`Now:` the value in force, `New:` the value from the file, and the file from the preview's `files`/);
  assert.ok(s.includes('**Worktree base ref**'));
  assert.ok(s.includes("**Wrap-up**'s dangling enrollment check"));
});

test('a sentence hands a provider match to provider setup by its keys, after matching and before showing', () => {
  const s = flat(section(MENU_MD, 'A sentence'));
  assert.match(s, /When a match touches `review\.providers\.\*`, or adds a cross-model name to `review\.reviewers`, go to \*\*Review provider setup\*\*/);
  assert.match(s, /The test is the matched keys, not the words used: `set up OpenAI reviews`/);
  const handOff = s.indexOf('**Provider hand-off.**');
  assert.ok(s.indexOf('**Matching.**') < handOff && handOff < s.indexOf('**Showing.**'));
});

test('a typed value reaches the preview and set through a scratch file, in a pick and in the walk', () => {
  const s = flat(section(MENU_MD, 'A group'));
  assert.match(s, /write the new value as JSON to a file in it with the Write tool \(`<D>\/value\.json`\)/);
  assert.match(s, /config\.mjs" set \[--global\] <key>="\$\(cat <D>\/value\.json\)"/);
  assert.doesNotMatch(s, /(preview|set \[--global\]) <key>=<value>/);
  assert.ok(s.indexOf('mktemp -d') < s.indexOf('config.mjs" preview'));
  const walk = flat(section(CONFIG_MD, 'Interactive menu (no args)'));
  const step4 = walk.slice(walk.indexOf('4. After the last page'), walk.indexOf('5. `review.providers`'));
  assert.match(step4, /write each changed value as JSON to its own file in a directory this run made/);
  assert.match(step4, /pass the preview and `set` each key as `<key>="\$\(cat <path>\)"`/);
  assert.ok(step4.indexOf('mktemp -d') < step4.indexOf('config.mjs preview'));
});

// Tests that every fixed question Cadence puts to the person reads in plain words (phase 6, plan 4, AC4 and AC6).
// An ask is a block opened by a `- header:` line, then `- question:` (which may wrap), then `- options:`. The
// extractor pulls the header, the question and each option's label and description, and holds every one of those
// lines to three rules: no backtick, no dotted key, no word from the internal-terms list. It never reads text outside
// a block. The doc check holds the bold option names in docs/WORKFLOW.md to the labels of the ask they quote.
// Run: node --test tests/plain-asks.test.mjs
// Only node: builtins, no subprocess.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { internalTermIn } from '../cadence-core/bin/lib/plain-words.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

// The terms list is plain-words.mjs's. The dotted-key matcher there is private, so this is the same pattern: a
// lowercase name.name identifier, with "e.g." and "i.e." read as prose.
const DOTTED_RE = /\b[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+/g;
const dottedKeyIn = (s) => [...s.matchAll(DOTTED_RE)].map((m) => m[0]).find((d) => d !== 'e.g' && d !== 'i.e') ?? null;

const HEADER_MAX = 12;
const HEADER_LINE = /^\s*- header:\s*"([^"]*)"/;
const QUESTION_LINE = /^\s*- question:\s*"(.*)$/;
const OPTIONS_LINE = /^\s*- options:\s*(.*)$/;
const OPTION_LINE = /^\s*(?:\d+\.|-)\s+"/;

/** One option's text: its quoted label (cut at the first " - ") and its description (inside the quotes or after them). */
function optionOf(segment, line) {
  const m = /^\s*(?:(?:\d+\.|-)\s+)?"([^"]*)"(.*)$/.exec(segment);
  if (m === null) return null;
  const [label, ...inside] = m[1].split(' - ');
  const after = m[2].trim().replace(/^-\s+/, '');
  return { line, text: segment.trim(), label: label.trim(), description: (inside.join(' - ') || after).trim() };
}

/**
 * Every ask in a file's text, and what the extractor could not read.
 * @returns {{asks: Array<{line: number, header: string, question: string, questionLine: number, options: any[]}>, problems: string[]}}
 */
export function asksIn(text) {
  const lines = text.split('\n');
  const asks = [];
  const problems = [];
  for (let i = 0; i < lines.length; i++) {
    const h = HEADER_LINE.exec(lines[i]);
    if (h === null) continue;
    const ask = { line: i + 1, header: h[1], question: '', questionLine: 0, options: [] };
    let j = i + 1;
    const q = QUESTION_LINE.exec(lines[j] ?? '');
    if (q === null) {
      problems.push(`line ${i + 1}: the header has no question line under it`);
      continue;
    }
    ask.questionLine = j + 1;
    const parts = [q[1]];
    while (!parts[parts.length - 1].trimEnd().endsWith('"') && j + 1 < lines.length && !OPTIONS_LINE.test(lines[j + 1])) {
      j++;
      parts.push(lines[j].trim());
    }
    const joined = parts.map((p) => p.trim()).join(' ');
    if (!joined.endsWith('"')) {
      problems.push(`line ${i + 1}: the question never closes its quote`);
      continue;
    }
    ask.question = joined.slice(0, -1);
    j++;
    const o = OPTIONS_LINE.exec(lines[j] ?? '');
    if (o === null) {
      problems.push(`line ${i + 1}: the question has no options line under it`);
      continue;
    }
    const raw = [];
    if (/^none\b/i.test(o[1].trim())) {
      // an ask whose answer is the person's own words: no set of options, and the line still gets its checks
      ask.freeText = true;
      ask.options.push({ line: j + 1, text: o[1].trim(), label: '', description: '' });
    } else if (o[1].trim() !== '') {
      for (const seg of o[1].split(/\s+\/\s+(?=")/)) raw.push([seg, j + 1]);
    } else {
      while (j + 1 < lines.length && OPTION_LINE.test(lines[j + 1])) {
        j++;
        raw.push([lines[j], j + 1]);
      }
    }
    for (const [seg, n] of raw) {
      const opt = optionOf(seg, n);
      if (opt === null) problems.push(`line ${n}: an option is not a quoted label`);
      else ask.options.push(opt);
    }
    if (ask.options.length === 0) problems.push(`line ${i + 1}: the ask lists no options`);
    asks.push(ask);
  }
  return { asks, problems };
}

/** Each rule one ask breaks, as `line N: rule in "text"` strings. */
export function breaksIn(ask) {
  const out = [];
  const check = (line, text) => {
    if (text.includes('`')) out.push(`line ${line}: backtick in "${text}"`);
    const key = dottedKeyIn(text);
    if (key !== null) out.push(`line ${line}: dotted key ${key} in "${text}"`);
    const term = internalTermIn(text);
    if (term !== null) out.push(`line ${line}: internal term ${term} in "${text}"`);
  };
  check(ask.line, ask.header);
  if (ask.header.length > HEADER_MAX) out.push(`line ${ask.line}: header "${ask.header}" is over ${HEADER_MAX} characters`);
  check(ask.questionLine, ask.question);
  for (const opt of ask.options) check(opt.line, opt.text);
  return out;
}

/** The bold spans of a docs table row that are neither a label of the ask nor named as not an option. */
export function staleBoldIn(row, labels, notOptions = []) {
  const spans = [...row.matchAll(/\*\*([^*]+)\*\*/g)].map((m) => m[1]);
  return spans.filter((s) => !labels.includes(s) && !notOptions.includes(s));
}

/** A table row found by its first two cells. */
export function rowOf(docText, cells) {
  return docText.split('\n').find((line) => {
    if (!line.startsWith('|')) return false;
    const got = line.split('|').slice(1, 3).map((c) => c.trim());
    return got[0] === cells[0] && got[1] === cells[1];
  }) ?? null;
}

// The file table: each workflow file with the number of asks it holds, one per `- header:` line. Each task that writes
// a file's asks adds the file here with the count its own Action lists.
const ASK_FILES = [
  ['cadence-core/workflows/context.md', 8],
  ['cadence-core/workflows/new-project.md', 9],
  ['cadence-core/workflows/adopt.md', 5],
  ['cadence-core/workflows/plan.md', 3],
  ['cadence-core/workflows/execute.md', 5],
];

// The doc table: a row in a docs table that quotes an ask's option names in bold. `notOptions` names the bold spans
// in that row that are not option names.
const DOC_ROWS = [
  { doc: 'docs/WORKFLOW.md', cells: ['`/cad-context`', 'How big is this phase?'], file: 'cadence-core/workflows/context.md', header: 'Size', notOptions: [] },
];

const SLASH = [
  '- header: "Pick"',
  '- question: "Which one?"',
  '- options: "First" / "Second - the other" / "Third"',
].join('\n');
const DASHED = [
  '- header: "Ready?"',
  '- question: "Ready to go?"',
  '- options:',
  '  - "Go" - move forward',
  '  - "Wait - not yet"',
].join('\n');
const NUMBERED = [
  '- header: "Size"',
  '- question: "How big?"',
  '- options:',
  '  1. "Small - one plan"',
  '  2. "Big - many plans"',
].join('\n');

test('a block with slash-separated options gives its header, question and every label', () => {
  const { asks, problems } = asksIn(`Some prose.\n\n${SLASH}\n\nMore prose.`);
  assert.deepEqual(problems, []);
  assert.equal(asks.length, 1);
  assert.equal(asks[0].header, 'Pick');
  assert.equal(asks[0].question, 'Which one?');
  assert.deepEqual(asks[0].options.map((o) => o.label), ['First', 'Second', 'Third']);
  assert.equal(asks[0].options[1].description, 'the other');
});

test('dashed and numbered option lists give every label, with the description after the quotes or inside them', () => {
  const dashed = asksIn(DASHED).asks[0];
  assert.deepEqual(dashed.options.map((o) => [o.label, o.description]), [['Go', 'move forward'], ['Wait', 'not yet']]);
  const numbered = asksIn(NUMBERED).asks[0];
  assert.deepEqual(numbered.options.map((o) => [o.label, o.description]), [['Small', 'one plan'], ['Big', 'many plans']]);
});

test('a question wrapped over two lines reads as one, and an indented block reads the same', () => {
  const wrapped = ['- header: "Size"', '- question: "Can one plan deliver all of these,', '  or is this too big?"', '- options: "Yes" / "No"'].join('\n');
  assert.equal(asksIn(wrapped).asks[0].question, 'Can one plan deliver all of these, or is this too big?');
  const indented = SLASH.split('\n').map((l) => `   ${l}`).join('\n');
  const got = asksIn(indented).asks[0];
  assert.equal(got.header, 'Pick');
  assert.equal(got.question, 'Which one?');
  assert.deepEqual(got.options.map((o) => o.label), ['First', 'Second', 'Third']);
});

test('an options line that says none is a free-text ask, and its words are still checked', () => {
  const free = asksIn('- header: "No check"\n- question: "What now?"\n- options: none, the person answers in their own words').asks[0];
  assert.equal(free.freeText, true);
  assert.deepEqual(breaksIn(free), []);
  const dirty = asksIn('- header: "No check"\n- question: "What now?"\n- options: none, set workflow.test_command').asks[0];
  assert.match(breaksIn(dirty).join('\n'), /^line 3: dotted key workflow\.test_command/);
});

test('a block missing its question or its options is a problem, not a skipped ask', () => {
  assert.equal(asksIn('- header: "Pick"\n- options: "A" / "B"').problems.length, 1);
  assert.equal(asksIn('- header: "Pick"\n- question: "Which?"\n\nprose').problems.length, 1);
  assert.equal(asksIn('- header: "Pick"\n- question: "Which?"\n- options:\n\nprose').problems.length, 1);
});

test('a backtick in an option, a dotted key in a question and a listed term in a header are each reported with their line', () => {
  const text = [
    'prose with `ticks` and workflow.test_command outside a block',
    '- header: "Dispatch"',
    '- question: "Set workflow.use_workflows now?"',
    '- options:',
    '  - "`Fast` - quick"',
    '  - "Slow"',
  ].join('\n');
  const { asks, problems } = asksIn(text);
  assert.deepEqual(problems, []);
  const breaks = breaksIn(asks[0]);
  assert.equal(breaks.length, 3, breaks.join('\n'));
  assert.match(breaks[0], /^line 2: internal term Dispatch in "Dispatch"$/);
  assert.match(breaks[1], /^line 3: dotted key workflow\.use_workflows /);
  assert.match(breaks[2], /^line 5: backtick in /);
});

test('a plain ask has no break, and a header over 12 characters does', () => {
  for (const block of [SLASH, DASHED, NUMBERED]) assert.deepEqual(breaksIn(asksIn(block).asks[0]), []);
  const long = asksIn('- header: "A very long header"\n- question: "Fine?"\n- options: "Yes" / "No"').asks[0];
  assert.match(breaksIn(long).join('\n'), /over 12 characters/);
});

test('a bold name that is not a label of its ask fails the doc check, and a span the entry skips does not', () => {
  const labels = asksIn(NUMBERED).asks[0].options.map((o) => o.label);
  assert.deepEqual(staleBoldIn('| `/x` | q | **Small**, one. **Big**, many. |', labels), []);
  assert.deepEqual(staleBoldIn('| `/x` | q | **Small**, one. **Huge**, many. |', labels), ['Huge']);
  assert.deepEqual(staleBoldIn('| `/x` | q | **Small**, one. **Note** the rest. |', labels, ['Note']), []);
  const doc = '| a | b | c |\n|---|---|---|\n| `/x` | q | **Small** |\n| `/x` | other | **Huge** |';
  assert.equal(rowOf(doc, ['`/x`', 'q']), '| `/x` | q | **Small** |');
  assert.equal(rowOf(doc, ['`/x`', 'missing']), null);
});

for (const [file, count] of ASK_FILES) {
  test(`${file} holds ${count} asks and every header, question and option line is plain`, () => {
    const text = read(file);
    const headerLines = text.split('\n').filter((l) => HEADER_LINE.test(l)).length;
    assert.equal(headerLines, count, `${file} has ${headerLines} header lines, the table says ${count}`);
    const { asks, problems } = asksIn(text);
    assert.deepEqual(problems, []);
    assert.equal(asks.length, count);
    assert.deepEqual(asks.flatMap(breaksIn), []);
  });
}

for (const entry of DOC_ROWS) {
  test(`${entry.doc} row ${entry.cells[1]} quotes only labels of the ${entry.header} ask in ${entry.file}`, () => {
    const row = rowOf(read(entry.doc), entry.cells);
    assert.notEqual(row, null, `${entry.doc} has no row starting ${entry.cells.join(' | ')}`);
    const ask = asksIn(read(entry.file)).asks.find((a) => a.header === entry.header);
    assert.ok(ask, `${entry.file} has no ask headed ${entry.header}`);
    assert.deepEqual(staleBoldIn(row, ask.options.map((o) => o.label), entry.notOptions), []);
  });
}

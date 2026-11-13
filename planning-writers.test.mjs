// Zero-dep tests for lib/planning-writers.mjs - the write-module rule self-verify runs over cadence-core/bin
// (check 37) and the register of scripts allowed a node:fs write of their own. Run:
//   node --test tests/planning-writers.test.mjs
// One case per verdict on synthetic texts; self-verify.test.mjs owns the CLI wiring and the live tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fsWriteCalls, writeModuleIssues, FS_WRITE_EXCEPTIONS, WRITE_MODULE, CODES,
} from '../cadence-core/bin/lib/planning-writers.mjs';

const ROW = { path: 'cadence-core/bin/x.mjs', writes: 'a synthetic file', reason: 'a synthetic reason' };
const issues = (file, text, rows = [], full = false) => writeModuleIssues([{ file, text }], full, rows);

test('a direct call to a node:fs write is flagged with its line', () => {
  const src = "import { writeFileSync } from 'node:fs';\nwriteFileSync('.planning/STATE.md', 'x');\n";
  assert.deepEqual(fsWriteCalls(src), [{ name: 'writeFileSync', line: 2 }]);
  const got = issues('cadence-core/bin/seam.mjs', src);
  assert.equal(got.length, 1);
  assert.equal(got[0].kind, CODES.outside);
  assert.equal(got[0].file, 'cadence-core/bin/seam.mjs');
});

test('the same call in a comment, a string or a template is not a call', () => {
  const src = "import { writeFileSync } from 'node:fs';\n"
    + "// writeFileSync('a', 'b')\n/* writeFileSync(x) */\nconst s = \"writeFileSync('a')\";\nconst t = `writeFileSync(${1})`;\n"
    + "const r = /writeFileSync\\(/;\nconst ok = readFileSync('a');\n";
  assert.deepEqual(fsWriteCalls(src), []);
});

test('a namespace import, a renamed binding and the promises API are all calls', () => {
  assert.equal(fsWriteCalls("import * as fs from 'node:fs';\nfs.rmSync('a');\n").length, 1);
  assert.equal(fsWriteCalls("import fs from 'fs';\nfs.promises.writeFile('a', 'b');\n").length, 1);
  assert.equal(fsWriteCalls("import { rmSync as gone } from 'node:fs';\ngone('a');\n").length, 1);
  assert.equal(fsWriteCalls("import { writeFile } from 'node:fs/promises';\nawait writeFile('a', 'b');\n").length, 1);
});

test('a disposable temp directory and a write-stream constructor are calls', () => {
  assert.equal(fsWriteCalls("import { mkdtempDisposableSync } from 'node:fs';\nmkdtempDisposableSync(p);\n").length, 1);
  assert.equal(fsWriteCalls("import fs from 'node:fs';\nfs.promises.mkdtempDisposable(p);\n").length, 1);
  assert.equal(fsWriteCalls("import { WriteStream } from 'node:fs';\nnew WriteStream(p);\n").length, 1);
  assert.equal(fsWriteCalls("import * as fs from 'node:fs';\nnew fs.WriteStream(p);\n").length, 1);
});

test('a re-export of a write function is flagged, a read function is not', () => {
  assert.equal(fsWriteCalls("export { rmSync } from 'node:fs';\n").length, 1);
  assert.equal(fsWriteCalls("export * from 'node:fs';\n").length, 1);
  assert.deepEqual(fsWriteCalls("export { readFileSync } from 'node:fs';\n"), []);
});

test('a same-named function from another module is not node:fs', () => {
  assert.deepEqual(fsWriteCalls("import { writeFile } from './planning-store.mjs';\nwriteFile('a', 'b');\n"), []);
});

test('openSync counts only under a write flag', () => {
  assert.equal(fsWriteCalls("import { openSync } from 'node:fs';\nopenSync(p, 'wx');\n").length, 1);
  assert.deepEqual(fsWriteCalls("import { openSync } from 'node:fs';\nopenSync(p, 'r');\n"), []);
});

test('the write module and a registered path are silent', () => {
  const src = "import { rmSync } from 'node:fs';\nrmSync('a');\n";
  assert.deepEqual(issues(WRITE_MODULE, src), []);
  assert.deepEqual(issues(ROW.path, src, [ROW]), []);
});

test('a row whose file no longer calls a write is stale', () => {
  const got = issues(ROW.path, "import { readFileSync } from 'node:fs';\nreadFileSync('a');\n", [ROW]);
  assert.equal(got.length, 1);
  assert.equal(got[0].kind, CODES.stale);
  assert.equal(got[0].file, ROW.path);
});

test('a row whose file is gone is stale in a full tree and silent in a fixture', () => {
  assert.deepEqual(writeModuleIssues([], false, [ROW]), []);
  const got = writeModuleIssues([], true, [ROW]);
  assert.equal(got.length, 1);
  assert.equal(got[0].kind, CODES.stale);
});

test('an unreadable file gets no verdict here', () => {
  assert.deepEqual(writeModuleIssues([{ file: ROW.path, text: null }], true, [ROW]), []);
});

test('every shipped exception says what it writes and why that is not under .planning', () => {
  for (const r of FS_WRITE_EXCEPTIONS) {
    assert.ok(r.path.startsWith('cadence-core/bin/') && r.path.endsWith('.mjs'), r.path);
    assert.ok(r.writes.trim().length > 0, `${r.path}: writes`);
    assert.ok(r.reason.trim().length > 0, `${r.path}: reason`);
  }
  assert.equal(new Set(FS_WRITE_EXCEPTIONS.map((r) => r.path)).size, FS_WRITE_EXCEPTIONS.length);
});

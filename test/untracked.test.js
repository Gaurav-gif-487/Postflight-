"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { buildUntrackedDiff, looksBinary } = require("../src/untracked");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "postflight-untracked-test-"));
}

test("looksBinary: detects a NUL byte as binary", () => {
  assert.ok(looksBinary(Buffer.from([0, 1, 2, 255])));
  assert.ok(!looksBinary(Buffer.from("hello world", "utf8")));
});

test("buildUntrackedDiff: produces a diff-shaped entry for a new text file", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "new.js"), "const x = 1;\nconst y = 2;\n");
  const result = buildUntrackedDiff(["new.js"], dir);
  assert.equal(result.stats.length, 1);
  assert.equal(result.stats[0].file, "new.js");
  assert.equal(result.stats[0].insertions, 2);
  assert.equal(result.stats[0].deletions, 0);
  assert.equal(result.stats[0].binary, false);
  assert.match(result.diffText, /\+\+\+ b\/new\.js/);
  assert.match(result.diffText, /\+const x = 1;/);
  assert.match(result.diffText, /\+const y = 2;/);
});

test("buildUntrackedDiff: a file with no trailing newline does not gain a phantom empty line", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "no-newline.txt"), "one line, no trailing newline");
  const result = buildUntrackedDiff(["no-newline.txt"], dir);
  assert.equal(result.stats[0].insertions, 1);
});

test("buildUntrackedDiff: marks a binary file without emitting its content", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "img.bin"), Buffer.from([0, 1, 2, 255, 254]));
  const result = buildUntrackedDiff(["img.bin"], dir);
  assert.equal(result.stats[0].binary, true);
  assert.equal(result.stats[0].insertions, null);
  assert.doesNotMatch(result.diffText, /img\.bin/);
});

test("buildUntrackedDiff: skips a file that no longer exists rather than throwing", () => {
  const dir = tmpDir();
  const result = buildUntrackedDiff(["gone.js"], dir);
  assert.deepEqual(result.stats, []);
  assert.equal(result.diffText, "");
});

test("buildUntrackedDiff: empty input produces empty output", () => {
  const dir = tmpDir();
  const result = buildUntrackedDiff([], dir);
  assert.deepEqual(result.stats, []);
  assert.equal(result.diffText, "");
});

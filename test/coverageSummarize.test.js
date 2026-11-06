"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const coverage = require("../src/coverage");
const { parseUnifiedDiff } = require("../src/diffParse");

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "postflight-coverage-summarize-test-"));
}

function write(dir, file, text) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
}

// A tiny two-line-added diff for src/a.js, in the same shape cli.js already
// hands to coverage.summarize (a parsedDiff from src/diffParse.js).
function diffFor(file) {
  return parseUnifiedDiff(
    `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,1 +1,2 @@\n one\n+two\n`
  );
}

test("coverage.summarize: unavailable (no report found) reports why, not a fabricated ratio", () => {
  const dir = makeDir();
  const result = coverage.summarize(dir, undefined, diffFor("src/a.js"));
  assert.equal(result.available, false);
  assert.match(result.reason, /no coverage report found/);
  assert.equal(result.changedLines, undefined);
});

test("coverage.summarize: a fully-covered changed line reports ratio 1 for that file", () => {
  const dir = makeDir();
  write(dir, "coverage/lcov.info", "SF:src/a.js\nDA:1,3\nDA:2,1\nend_of_record\n");
  const result = coverage.summarize(dir, undefined, diffFor("src/a.js"));
  assert.equal(result.available, true);
  assert.equal(result.format, "lcov");
  assert.equal(result.changedLines.covered, 1);
  assert.equal(result.changedLines.executable, 1);
  assert.equal(result.changedLines.ratio, 1);
  assert.deepEqual(result.files["src/a.js"], { measured: true, covered: 1, executable: 1, ratio: 1 });
});

test("coverage.summarize: an uncovered changed line reports ratio 0, not silently dropped", () => {
  const dir = makeDir();
  write(dir, "coverage/lcov.info", "SF:src/a.js\nDA:1,3\nDA:2,0\nend_of_record\n");
  const result = coverage.summarize(dir, undefined, diffFor("src/a.js"));
  assert.equal(result.changedLines.covered, 0);
  assert.equal(result.changedLines.executable, 1);
  assert.equal(result.changedLines.ratio, 0);
});

test("coverage.summarize: a file entirely absent from the report is measured:false, not counted as uncovered", () => {
  const dir = makeDir();
  write(dir, "coverage/lcov.info", "SF:src/other.js\nDA:1,1\nend_of_record\n");
  const result = coverage.summarize(dir, undefined, diffFor("src/a.js"));
  assert.equal(result.available, true);
  assert.deepEqual(result.files["src/a.js"], { measured: false, reason: "file absent from coverage report" });
  // Absent-from-report lines must not silently count toward the ratio.
  assert.equal(result.changedLines.executable, 0);
  assert.equal(result.changedLines.ratio, null);
});

test("coverage.summarize: respects an explicit --coverage path over auto-discovery", () => {
  const dir = makeDir();
  write(dir, "custom/report.lcov", "SF:src/a.js\nDA:1,1\nDA:2,1\nend_of_record\n");
  const result = coverage.summarize(dir, "custom/report.lcov", diffFor("src/a.js"));
  assert.equal(result.available, true);
  assert.equal(result.changedLines.ratio, 1);
});

test("coverage.summarize: an unparseable report is unavailable with a reason, never throws", () => {
  const dir = makeDir();
  write(dir, "coverage/coverage-final.json", "{ not json");
  assert.doesNotThrow(() => {
    const result = coverage.summarize(dir, undefined, diffFor("src/a.js"));
    assert.equal(result.available, false);
    assert.match(result.reason, /not parseable/);
  });
});

"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { parseTestOutput, diffBehavior } = require("../src/testDiff");

function sh(cmd, cwd) {
  execFileSync("bash", ["-c", cmd], { cwd, stdio: "pipe" });
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postflight-testdiff-"));
  sh("git init -q", dir);
  sh("git config user.email a@b.com && git config user.name test", dir);
  return dir;
}

// --- parseTestOutput -------------------------------------------------------

test("parseTestOutput: recognizes TAP output", () => {
  const output = ["TAP version 13", "ok 1 - adds numbers", "not ok 2 - subtracts numbers", "1..2"].join("\n");
  const results = parseTestOutput(output);
  assert.equal(results.get("adds numbers"), "pass");
  assert.equal(results.get("subtracts numbers"), "fail");
});

test("parseTestOutput: recognizes a Jest/Vitest-style checkmark reporter", () => {
  const output = ["  ✓ renders the button (4 ms)", "  ✕ handles click"].join("\n");
  const results = parseTestOutput(output);
  assert.equal(results.get("renders the button"), "pass");
  assert.equal(results.get("handles click"), "fail");
});

test("parseTestOutput: recognizes pytest output", () => {
  const output = ["test_math.py::test_add PASSED", "test_math.py::test_sub FAILED"].join("\n");
  const results = parseTestOutput(output);
  assert.equal(results.get("test_math.py::test_add"), "pass");
  assert.equal(results.get("test_math.py::test_sub"), "fail");
});

test("parseTestOutput: recognizes go test -v output", () => {
  const output = ["--- PASS: TestAdd (0.00s)", "--- FAIL: TestSub (0.00s)"].join("\n");
  const results = parseTestOutput(output);
  assert.equal(results.get("TestAdd"), "pass");
  assert.equal(results.get("TestSub"), "fail");
});

test("parseTestOutput: unrecognized output yields an empty map, not a throw", () => {
  const results = parseTestOutput("Ran 3 tests in 0.01s\nOK\n");
  assert.equal(results.size, 0);
});

test("parseTestOutput: empty/undefined input yields an empty map", () => {
  assert.equal(parseTestOutput("").size, 0);
  assert.equal(parseTestOutput(undefined).size, 0);
});

// --- diffBehavior -----------------------------------------------------------
// Uses node's own TAP-producing test runner (`node --test`) as the
// "testCommand" under test, run against a real disposable repo + worktree.

const RUNNER = `node --test --test-reporter=tap test.js`;

function writeTestFile(dir, bodyLines) {
  fs.writeFileSync(path.join(dir, "test.js"), ["const test = require('node:test');", "const assert = require('node:assert');", ...bodyLines].join("\n"));
}

test("diffBehavior: flags a test that passed on base and now fails", () => {
  const dir = makeRepo();
  writeTestFile(dir, ["test('adds', () => { assert.equal(1 + 1, 2); });"]);
  sh("git add -A && git commit -q -m init", dir);

  writeTestFile(dir, ["test('adds', () => { assert.equal(1 + 1, 3); });"]);

  const result = diffBehavior({ testCommand: RUNNER, base: "HEAD", cwd: dir, repoRoot: dir });
  assert.equal(result.skipped, false);
  assert.deepEqual(result.regressions, ["adds"]);
  assert.equal(result.fixed.length, 0);
});

test("diffBehavior: a newly-fixed test is reported but not treated as a regression", () => {
  const dir = makeRepo();
  writeTestFile(dir, ["test('adds', () => { assert.equal(1 + 1, 3); });"]);
  sh("git add -A && git commit -q -m init", dir);

  writeTestFile(dir, ["test('adds', () => { assert.equal(1 + 1, 2); });"]);

  const result = diffBehavior({ testCommand: RUNNER, base: "HEAD", cwd: dir, repoRoot: dir });
  assert.equal(result.skipped, false);
  assert.equal(result.regressions.length, 0);
  assert.deepEqual(result.fixed, ["adds"]);
});

test("diffBehavior: a test only present at base is reported as removed, not a regression", () => {
  const dir = makeRepo();
  writeTestFile(dir, [
    "test('adds', () => { assert.equal(1 + 1, 2); });",
    "test('subtracts', () => { assert.equal(2 - 1, 1); });",
  ]);
  sh("git add -A && git commit -q -m init", dir);

  writeTestFile(dir, ["test('adds', () => { assert.equal(1 + 1, 2); });"]);

  const result = diffBehavior({ testCommand: RUNNER, base: "HEAD", cwd: dir, repoRoot: dir });
  assert.equal(result.skipped, false);
  assert.equal(result.regressions.length, 0);
  assert.deepEqual(result.removed, ["subtracts"]);
});

test("diffBehavior: a test only present on the change is reported as added, not scored", () => {
  const dir = makeRepo();
  writeTestFile(dir, ["test('adds', () => { assert.equal(1 + 1, 2); });"]);
  sh("git add -A && git commit -q -m init", dir);

  writeTestFile(dir, [
    "test('adds', () => { assert.equal(1 + 1, 2); });",
    "test('multiplies', () => { assert.equal(2 * 2, 4); });",
  ]);

  const result = diffBehavior({ testCommand: RUNNER, base: "HEAD", cwd: dir, repoRoot: dir });
  assert.equal(result.skipped, false);
  assert.deepEqual(result.added, ["multiplies"]);
  assert.equal(result.regressions.length, 0);
});

test("diffBehavior: leaves the working tree/index untouched (uses a disposable worktree)", () => {
  const dir = makeRepo();
  writeTestFile(dir, ["test('adds', () => { assert.equal(1 + 1, 2); });"]);
  sh("git add -A && git commit -q -m init", dir);
  writeTestFile(dir, ["test('adds', () => { assert.equal(1 + 1, 3); });"]);

  const before = fs.readFileSync(path.join(dir, "test.js"), "utf8");
  diffBehavior({ testCommand: RUNNER, base: "HEAD", cwd: dir, repoRoot: dir });
  const after = fs.readFileSync(path.join(dir, "test.js"), "utf8");
  assert.equal(before, after);

  const worktrees = execFileSync("git", ["worktree", "list"], { cwd: dir, encoding: "utf8" });
  assert.equal(worktrees.trim().split("\n").length, 1, "the disposable worktree should be removed afterward");
});

test("diffBehavior: an invalid base ref is reported as skipped rather than thrown", () => {
  const dir = makeRepo();
  writeTestFile(dir, ["test('adds', () => { assert.equal(1 + 1, 2); });"]);
  sh("git add -A && git commit -q -m init", dir);

  const result = diffBehavior({ testCommand: RUNNER, base: "not-a-real-ref", cwd: dir, repoRoot: dir });
  assert.equal(result.skipped, true);
  assert.match(result.reason, /could not check out base ref/);
});

test("diffBehavior: an unrecognized test reporter format is reported as skipped", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "run.sh"), "#!/bin/bash\necho 'Ran 1 test\\nOK'\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "run.sh"), "#!/bin/bash\necho 'Ran 2 tests\\nOK'\n");

  const result = diffBehavior({ testCommand: "bash run.sh", base: "HEAD", cwd: dir, repoRoot: dir });
  assert.equal(result.skipped, true);
  assert.match(result.reason, /unrecognized reporter format/);
});

test("diffBehavior: parses tests from early in a large suite, not just the tail (regression test for output truncation)", () => {
  // runCommand's *display* output is truncated to the last 4000 chars,
  // which used to also be what diffBehavior parsed from - silently
  // dropping any test near the start of a big suite and reporting it as
  // spuriously "removed". Generate enough TAP noise that a naive
  // last-4000-chars parse would lose the first test.
  const dir = makeRepo();
  const filler = Array.from({ length: 200 }, (_, i) => `test('filler ${i}', () => { assert.equal(1, 1); });`).join("\n");
  writeTestFile(dir, [`test('first test', () => { assert.equal(1 + 1, 2); });`, filler]);
  sh("git add -A && git commit -q -m init", dir);
  writeTestFile(dir, [`test('first test', () => { assert.equal(1 + 1, 2); });`, filler]);

  const result = diffBehavior({ testCommand: RUNNER, base: "HEAD", cwd: dir, repoRoot: dir });
  assert.equal(result.skipped, false);
  assert.deepEqual(result.regressions, []);
  assert.ok(!result.removed.includes("first test"), "the early test should not be spuriously reported as removed");
  assert.ok(!result.added.includes("first test"), "the early test should not be spuriously reported as added");
});


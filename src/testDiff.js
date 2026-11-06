"use strict";
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { runCommandFull } = require("./run");

// --- Parsing --------------------------------------------------------------
// Best-effort extraction of individual test outcomes from arbitrary test
// runner output. Tries a few common formats in order and stops at the
// first one that matches anything - mixing formats from different runners
// in one output is more likely to be noise than a real second signal. A
// runner postflight doesn't recognize just yields an empty map, and
// diffBehavior degrades gracefully (falls back to whole-suite pass/fail,
// same as plain `--test`).
const PARSERS = [
  // TAP (node --test, tap, prove, ...): "ok 12 - some test name"
  {
    regex: /^(ok|not ok)\s+\d+\s*(?:-\s*)?(.+)$/gm,
    toEntry: (m) => [m[2].trim(), m[1] === "ok" ? "pass" : "fail"],
  },
  // Jest / Vitest default reporter: "✓ name (3 ms)" / "✕ name"
  {
    regex: /^\s*(✓|✔|✗|✕|×)\s+(.+?)(?:\s+\(\d+\s*m?s\))?$/gm,
    toEntry: (m) => [m[2].trim(), /[✓✔]/.test(m[1]) ? "pass" : "fail"],
  },
  // pytest: "test_file.py::test_name PASSED" / "FAILED" / "ERROR"
  {
    regex: /^(\S+::\S+)\s+(PASSED|FAILED|ERROR)\b/gm,
    toEntry: (m) => [m[1].trim(), m[2] === "PASSED" ? "pass" : "fail"],
  },
  // go test -v: "--- PASS: TestName (0.00s)" / "--- FAIL: TestName"
  {
    regex: /^--- (PASS|FAIL): (\S+)/gm,
    toEntry: (m) => [m[2].trim(), m[1] === "PASS" ? "pass" : "fail"],
  },
];

// Returns a Map of testName -> "pass" | "fail".
function parseTestOutput(output) {
  const results = new Map();
  if (!output) return results;
  for (const parser of PARSERS) {
    parser.regex.lastIndex = 0;
    let match;
    let found = false;
    while ((match = parser.regex.exec(output))) {
      found = true;
      const [name, status] = parser.toEntry(match);
      if (name) results.set(name, status);
    }
    if (found) return results;
  }
  return results;
}

// --- Worktree plumbing -----------------------------------------------------
// Runs `fn(dir)` with `dir` checked out to `base` in a disposable git
// worktree, so the base-ref test run never touches the user's actual
// working tree (uncommitted changes, node_modules, build output, etc).
function withBaseWorktree(base, repoRoot, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postflight-base-"));
  try {
    execFileSync("git", ["worktree", "add", "--detach", "--force", dir, base], {
      cwd: repoRoot,
      stdio: "pipe",
    });
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`could not check out base ref "${base}" in a worktree (${err.message.split("\n")[0]})`);
  }
  try {
    return fn(dir);
  } finally {
    try {
      execFileSync("git", ["worktree", "remove", "--force", dir], { cwd: repoRoot, stdio: "pipe" });
    } catch {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

// Runs `testCommand` once against `base` and once against the current
// change, then diffs which individual tests newly pass/fail. This is what
// tells "the suite is green" apart from "the suite is green, and nothing
// it tests actually changed meaning" - a suite can stay green overall
// while individual assertions flip in ways that cancel out.
function diffBehavior({ testCommand, base, cwd, repoRoot, timeoutMs }) {
  // Parsing needs every line - a large suite's early results would
  // otherwise fall outside runCommand's display truncation. The report
  // only ever sees the truncated version (changedRun.output).
  const changedRunFull = runCommandFull(testCommand, cwd, { timeoutMs });
  const changedRun = { ...changedRunFull, output: changedRunFull.output.slice(-4000) };
  const changedResults = parseTestOutput(changedRunFull.output);

  let baseRunFull = null;
  let baseResults = new Map();
  let skipReason = null;
  try {
    baseRunFull = withBaseWorktree(base, repoRoot, (dir) => runCommandFull(testCommand, dir, { timeoutMs }));
    baseResults = parseTestOutput(baseRunFull.output);
  } catch (err) {
    skipReason = err.message;
  }

  if (!skipReason && baseResults.size === 0) {
    skipReason = "could not identify individual tests from the test command's output (unrecognized reporter format)";
  } else if (!skipReason && changedResults.size === 0) {
    skipReason = "test command produced no recognizable per-test output on the current change";
  }

  if (skipReason) {
    return { skipped: true, reason: skipReason, testResult: changedRun, regressions: [], fixed: [], removed: [], added: [] };
  }

  const regressions = [];
  const fixed = [];
  const removed = [];
  const added = [];

  for (const [name, baseStatus] of baseResults) {
    if (!changedResults.has(name)) {
      removed.push(name);
      continue;
    }
    const changedStatus = changedResults.get(name);
    if (baseStatus === "pass" && changedStatus === "fail") regressions.push(name);
    else if (baseStatus === "fail" && changedStatus === "pass") fixed.push(name);
  }
  for (const name of changedResults.keys()) {
    if (!baseResults.has(name)) added.push(name);
  }

  return { skipped: false, reason: null, testResult: changedRun, regressions, fixed, removed, added };
}

module.exports = { parseTestOutput, diffBehavior };

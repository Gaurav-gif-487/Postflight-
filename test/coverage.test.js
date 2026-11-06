"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { runAnalyzers } = require("../src/analyzers");
const { analyze } = require("../src/analyzers/coverage");
const { parseUnifiedDiff } = require("../src/diffParse");

function sh(cmd, cwd) {
  execFileSync("bash", ["-c", cmd], { cwd, stdio: "pipe" });
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postflight-coverage-test-"));
  sh("git init -q", dir);
  sh("git config user.email a@b.com && git config user.name test", dir);
  return dir;
}

function write(dir, file, text) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
}

// Same rationale as every other wired-in analyzer: real scratch git repos,
// real (often uncommitted) changes, checked through runAnalyzers wherever
// possible - not src/coverage.js's own parsing logic in isolation, which
// this task deliberately does not re-test (that's a separate library with
// its own concerns; this file is about the wiring and the two design
// decisions made when wiring it).
function parsedDiffFor(dir, base = "HEAD") {
  const out = execFileSync("git", ["diff", base, "--"], { cwd: dir, encoding: "utf8" });
  return parseUnifiedDiff(out);
}

test("coverage: a clean repo with no coverage report at all produces no findings (opt-in, silent by design)", () => {
  const dir = makeRepo();
  write(dir, "src/a.js", "const one = 1;\nconst two = 2;\nconst three = 3;\n");
  sh("git add -A && git commit -q -m init", dir);
  write(dir, "src/a.js", "const one = 1;\nconst two = 22;\nconst three = 3;\n");
  const findings = runAnalyzers({
    base: "HEAD",
    changedFiles: ["src/a.js"],
    cwd: dir,
    repoRoot: dir,
    statuses: { "src/a.js": { status: "modified" } },
    parsedDiff: parsedDiffFor(dir),
  });
  assert.deepEqual(
    findings.filter((f) => f.rule.startsWith("coverage-")),
    []
  );
});

test("coverage: a report exists but every changed line is covered - no finding", () => {
  const dir = makeRepo();
  write(dir, "src/a.js", "const one = 1;\nconst two = 2;\nconst three = 3;\n");
  sh("git add -A && git commit -q -m init", dir);
  write(dir, "src/a.js", "const one = 1;\nconst two = 22;\nconst three = 3;\n");
  write(dir, "coverage/lcov.info", "SF:src/a.js\nDA:1,1\nDA:2,1\nDA:3,1\nend_of_record\n");
  const findings = runAnalyzers({
    base: "HEAD",
    changedFiles: ["src/a.js"],
    cwd: dir,
    repoRoot: dir,
    statuses: { "src/a.js": { status: "modified" } },
    parsedDiff: parsedDiffFor(dir),
  });
  assert.deepEqual(
    findings.filter((f) => f.rule.startsWith("coverage-")),
    []
  );
});

test("coverage: an uncommitted change to a line the lcov report shows as never executed is flagged, end to end via runAnalyzers", () => {
  const dir = makeRepo();
  write(dir, "src/a.js", "const one = 1;\nconst two = 2;\nconst three = 3;\n");
  sh("git add -A && git commit -q -m init", dir);
  // Deliberately left uncommitted, mirroring the tool's core "review before
  // you commit" use case.
  write(dir, "src/a.js", "const one = 1;\nconst two = 22;\nconst three = 3;\n");
  write(dir, "coverage/lcov.info", "SF:src/a.js\nDA:1,1\nDA:2,0\nDA:3,1\nend_of_record\n");
  const findings = runAnalyzers({
    base: "HEAD",
    changedFiles: ["src/a.js"],
    cwd: dir,
    repoRoot: dir,
    statuses: { "src/a.js": { status: "modified" } },
    parsedDiff: parsedDiffFor(dir),
  });
  const flagged = findings.find((f) => f.rule === "coverage-changed-lines-uncovered");
  assert.ok(flagged, "expected a coverage-changed-lines-uncovered finding");
  assert.equal(flagged.severity, "medium"); // WARN -> medium, never FAIL/high (see analyzer's own comment)
  assert.match(flagged.snippet, /src\/a\.js/);
});

test("coverage: a report at a non-conventional path is invisible without --coverage, and picked up once the explicit path is threaded through", () => {
  const dir = makeRepo();
  write(dir, "src/a.js", "const one = 1;\nconst two = 2;\nconst three = 3;\n");
  sh("git add -A && git commit -q -m init", dir);
  write(dir, "src/a.js", "const one = 1;\nconst two = 22;\nconst three = 3;\n");
  // Not one of coverage.js's CANDIDATES conventional paths.
  write(dir, "reports/custom.lcov", "SF:src/a.js\nDA:1,1\nDA:2,0\nDA:3,1\nend_of_record\n");
  const ctxBase = {
    base: "HEAD",
    changedFiles: ["src/a.js"],
    cwd: dir,
    repoRoot: dir,
    statuses: { "src/a.js": { status: "modified" } },
    parsedDiff: parsedDiffFor(dir),
  };

  const withoutFlag = runAnalyzers(ctxBase);
  assert.deepEqual(
    withoutFlag.filter((f) => f.rule.startsWith("coverage-")),
    [],
    "a report at an unconventional path should not be auto-discovered"
  );

  const withFlag = runAnalyzers({ ...ctxBase, coveragePath: "reports/custom.lcov" });
  const flagged = withFlag.find((f) => f.rule === "coverage-changed-lines-uncovered");
  assert.ok(flagged, "expected --coverage's explicit path to be picked up end to end via runAnalyzers");
});

test("coverage: --coverage also accepts an absolute path", () => {
  const dir = makeRepo();
  write(dir, "src/a.js", "const one = 1;\nconst two = 2;\nconst three = 3;\n");
  sh("git add -A && git commit -q -m init", dir);
  write(dir, "src/a.js", "const one = 1;\nconst two = 22;\nconst three = 3;\n");
  write(dir, "elsewhere/custom.lcov", "SF:src/a.js\nDA:1,1\nDA:2,0\nDA:3,1\nend_of_record\n");
  const findings = runAnalyzers({
    base: "HEAD",
    changedFiles: ["src/a.js"],
    cwd: dir,
    repoRoot: dir,
    statuses: { "src/a.js": { status: "modified" } },
    parsedDiff: parsedDiffFor(dir),
    coveragePath: path.join(dir, "elsewhere/custom.lcov"),
  });
  const flagged = findings.find((f) => f.rule === "coverage-changed-lines-uncovered");
  assert.ok(flagged, "expected an absolute --coverage path to work");
});

test("coverage: --coverage pointing at a nonexistent file degrades to silent, not a crash", () => {
  const dir = makeRepo();
  write(dir, "src/a.js", "const one = 1;\n");
  sh("git add -A && git commit -q -m init", dir);
  write(dir, "src/a.js", "const one = 11;\n");
  const findings = runAnalyzers({
    base: "HEAD",
    changedFiles: ["src/a.js"],
    cwd: dir,
    repoRoot: dir,
    statuses: { "src/a.js": { status: "modified" } },
    parsedDiff: parsedDiffFor(dir),
    coveragePath: "does/not/exist.lcov",
  });
  assert.deepEqual(
    findings.filter((f) => f.rule.startsWith("coverage-")),
    []
  );
});

test("coverage: a file entirely absent from the coverage report is treated as unmeasured, not uncovered", () => {
  const dir = makeRepo();
  write(dir, "src/a.js", "const one = 1;\n");
  write(dir, "src/untested.js", "const x = 1;\nconst y = 2;\n");
  sh("git add -A && git commit -q -m init", dir);
  write(dir, "src/untested.js", "const x = 1;\nconst y = 22;\n");
  // The coverage report only knows about a.js - untested.js was never
  // instrumented at all (a different claim than "instrumented and
  // uncovered").
  write(dir, "coverage/lcov.info", "SF:src/a.js\nDA:1,1\nend_of_record\n");
  const findings = runAnalyzers({
    base: "HEAD",
    changedFiles: ["src/untested.js"],
    cwd: dir,
    repoRoot: dir,
    statuses: { "src/untested.js": { status: "modified" } },
    parsedDiff: parsedDiffFor(dir),
  });
  assert.deepEqual(
    findings.filter((f) => f.rule.startsWith("coverage-")),
    [],
    "a file absent from the coverage report must not be reported as uncovered"
  );
});

test("coverage: an unparseable coverage report is treated the same as no report at all (silent, not a crash)", () => {
  const dir = makeRepo();
  write(dir, "src/a.js", "const one = 1;\nconst two = 2;\n");
  sh("git add -A && git commit -q -m init", dir);
  write(dir, "src/a.js", "const one = 1;\nconst two = 22;\n");
  // Malformed JSON under the istanbul-style report name - coverage.js's
  // parse() detects the format from the leading `{` and then fails to
  // JSON.parse it, returning `{ error: ... }` - a genuinely different code
  // path from "no report found," both of which this analyzer treats as
  // "no usable coverage data" per its own documented decision.
  write(dir, "coverage/coverage-final.json", "{not valid json");
  assert.doesNotThrow(() => {
    const findings = runAnalyzers({
      base: "HEAD",
      changedFiles: ["src/a.js"],
      cwd: dir,
      repoRoot: dir,
      statuses: { "src/a.js": { status: "modified" } },
      parsedDiff: parsedDiffFor(dir),
    });
    assert.deepEqual(findings.filter((f) => f.rule.startsWith("coverage-")), []);
  });
});

test("coverage: a report older than a changed file is flagged stale, even when changed-line coverage looks clean", () => {
  const dir = makeRepo();
  write(dir, "src/a.js", "const one = 1;\nconst two = 2;\nconst three = 3;\n");
  sh("git add -A && git commit -q -m init", dir);
  // Report says every line is covered, but it predates the edit below - the
  // "clean" number can't be trusted at face value.
  write(dir, "coverage/lcov.info", "SF:src/a.js\nDA:1,1\nDA:2,1\nDA:3,1\nend_of_record\n");
  const oldMtime = new Date("2000-01-01T00:00:00Z");
  fs.utimesSync(path.join(dir, "coverage/lcov.info"), oldMtime, oldMtime);
  write(dir, "src/a.js", "const one = 1;\nconst two = 22;\nconst three = 3;\n"); // newer than the report
  const findings = runAnalyzers({
    base: "HEAD",
    changedFiles: ["src/a.js"],
    cwd: dir,
    repoRoot: dir,
    statuses: { "src/a.js": { status: "modified" } },
    parsedDiff: parsedDiffFor(dir),
  });
  const stale = findings.find((f) => f.rule === "coverage-stale-report");
  assert.ok(stale, "expected a coverage-stale-report finding when the report predates a changed file");
  assert.equal(stale.severity, "medium"); // WARN -> medium
});

test("coverage: a report newer than every changed file is not flagged stale", () => {
  const dir = makeRepo();
  write(dir, "src/a.js", "const one = 1;\nconst two = 2;\nconst three = 3;\n");
  sh("git add -A && git commit -q -m init", dir);
  write(dir, "src/a.js", "const one = 1;\nconst two = 22;\nconst three = 3;\n");
  // Report generated after the edit above - genuinely reflects it.
  write(dir, "coverage/lcov.info", "SF:src/a.js\nDA:1,1\nDA:2,1\nDA:3,1\nend_of_record\n");
  const findings = runAnalyzers({
    base: "HEAD",
    changedFiles: ["src/a.js"],
    cwd: dir,
    repoRoot: dir,
    statuses: { "src/a.js": { status: "modified" } },
    parsedDiff: parsedDiffFor(dir),
  });
  assert.deepEqual(
    findings.filter((f) => f.rule === "coverage-stale-report"),
    []
  );
});

test("coverage: a stale report with an uncovered changed line surfaces both findings, and the uncovered-lines finding notes the staleness", () => {
  const dir = makeRepo();
  write(dir, "src/a.js", "const one = 1;\nconst two = 2;\nconst three = 3;\n");
  sh("git add -A && git commit -q -m init", dir);
  write(dir, "coverage/lcov.info", "SF:src/a.js\nDA:1,1\nDA:2,0\nDA:3,1\nend_of_record\n");
  const oldMtime = new Date("2000-01-01T00:00:00Z");
  fs.utimesSync(path.join(dir, "coverage/lcov.info"), oldMtime, oldMtime);
  write(dir, "src/a.js", "const one = 1;\nconst two = 22;\nconst three = 3;\n");
  const findings = runAnalyzers({
    base: "HEAD",
    changedFiles: ["src/a.js"],
    cwd: dir,
    repoRoot: dir,
    statuses: { "src/a.js": { status: "modified" } },
    parsedDiff: parsedDiffFor(dir),
  });
  assert.ok(findings.some((f) => f.rule === "coverage-stale-report"));
  assert.ok(findings.some((f) => f.rule === "coverage-changed-lines-uncovered"));
});

test("coverage: no HEAD-vs-working-tree bug is possible here - the module never reads git-versioned file content at all", () => {
  // Unlike dependency-change/test-integrity/config-change, coverage.js
  // never calls `git show <ref>:<file>` or anything else that could be
  // blind to uncommitted changes: it reads the coverage report file
  // directly off disk (coverage reports aren't git-versioned data to begin
  // with) and cross-references it against parsedDiff's added-line numbers,
  // which cli.js already computes from `git diff base` over the working
  // tree (git.diffAll) - already correctly uncommitted-change-aware before
  // this module ever sees it. This test proves the uncommitted edit is
  // visible end to end rather than asserting it from reading the code.
  const dir = makeRepo();
  write(dir, "src/a.js", "const one = 1;\nconst two = 2;\n");
  sh("git add -A && git commit -q -m init", dir);
  write(dir, "src/a.js", "const one = 1;\nconst two = 22;\n"); // uncommitted
  write(dir, "coverage/lcov.info", "SF:src/a.js\nDA:1,1\nDA:2,0\nend_of_record\n");
  const { evidence } = analyze({ base: "HEAD", repoRoot: dir, parsedDiff: parsedDiffFor(dir) });
  assert.ok(
    evidence.some((e) => e.id === "coverage/changed-lines-uncovered"),
    "the uncommitted change to line 2 must be detected against the working-tree diff"
  );
});

test("coverage: degrades to no findings, not a crash, on a broken/non-git cwd/repoRoot", () => {
  assert.doesNotThrow(() => {
    const findings = runAnalyzers({
      base: "HEAD",
      changedFiles: ["src/a.js"],
      cwd: "/nonexistent-path-xyz",
      repoRoot: "/nonexistent-path-xyz",
      parsedDiff: [],
    });
    assert.deepEqual(findings, []);
  });
});

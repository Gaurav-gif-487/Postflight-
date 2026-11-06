"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { runAnalyzers } = require("../src/analyzers");
const { analyze } = require("../src/analyzers/testIntegrity");

function sh(cmd, cwd) {
  execFileSync("bash", ["-c", cmd], { cwd, stdio: "pipe" });
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postflight-testintegrity-test-"));
  sh("git init -q", dir);
  sh("git config user.email a@b.com && git config user.name test", dir);
  return dir;
}

function write(dir, file, text) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
}

// Same style as dependencyChange.test.js and the disabled-test
// reproduction: real scratch git repos, real (often uncommitted) changes,
// checked end to end through runAnalyzers wherever possible.

test("test-integrity: a clean repo with unrelated changes reports nothing (no false positives)", () => {
  const dir = makeRepo();
  write(dir, "src/a.js", "module.exports = 1;\n");
  sh("git add -A && git commit -q -m init", dir);
  write(dir, "src/a.js", "module.exports = 2;\n");
  const findings = runAnalyzers({ base: "HEAD", changedFiles: ["src/a.js"], cwd: dir, repoRoot: dir, statuses: { "src/a.js": { status: "modified" } } });
  assert.deepEqual(findings, []);
});

test("test-integrity: a deleted test file is flagged high severity, end to end", () => {
  const dir = makeRepo();
  write(dir, "test/math.test.js", "test('adds', () => {});\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.rmSync(path.join(dir, "test/math.test.js"));
  const findings = runAnalyzers({
    base: "HEAD",
    changedFiles: ["test/math.test.js"],
    cwd: dir,
    repoRoot: dir,
    statuses: { "test/math.test.js": { status: "deleted" } },
  });
  const flagged = findings.find((f) => f.rule === "test-integrity-deleted-test-files");
  assert.ok(flagged, "expected a test-integrity-deleted-test-files finding");
  assert.equal(flagged.severity, "high");
});

test("test-integrity: an uncommitted newly-skipped test is detected end to end via runAnalyzers", () => {
  const dir = makeRepo();
  write(dir, "test/math.test.js", "test('adds', () => { assert(add(1,2) === 3); });\n");
  sh("git add -A && git commit -q -m init", dir);
  // Deliberately left uncommitted, mirroring the tool's core "review before
  // you commit" use case.
  write(dir, "test/math.test.js", "test.skip('adds', () => { assert(add(1,2) === 3); });\n");
  const findings = runAnalyzers({
    base: "HEAD",
    changedFiles: ["test/math.test.js"],
    cwd: dir,
    repoRoot: dir,
    statuses: { "test/math.test.js": { status: "modified" } },
  });
  const flagged = findings.find((f) => f.rule === "test-integrity-newly-skipped");
  assert.ok(flagged, "expected a test-integrity-newly-skipped finding");
  assert.equal(flagged.severity, "medium");
  assert.match(flagged.snippet, /math\.test\.js/);
});

test("test-integrity: countSkips does not count conditional Python skip decorators (real CPython false positive)", () => {
  // Regression test, same root cause and same real-world evidence as
  // checks.js's disabled-test fix: countSkips independently re-implements
  // its own skip-pattern list (not shared with checks.js's RULES), so it
  // had the identical unanchored "skip" prefix bug and needed the identical
  // fix. Replaying CPython's history against the old code would have shown
  // uncommitted, perfectly ordinary conditional skips
  // (skipUnless/skipIf/skipif) inflating skipsAfter and firing
  // test-integrity-newly-skipped on commits that disabled nothing.
  const { countSkips } = require("../src/analyzers/testIntegrity");
  const conditional = [
    "@unittest.skipUnless(hasattr(os, 'lseek'), 'test needs os.lseek()')",
    "@unittest.skipIf(mswindows, \"requires the POSIX wait implementation\")",
    "@pytest.mark.skipif(sys.platform == 'win32', reason='posix only')",
  ].join("\n");
  assert.equal(countSkips(conditional), 0);
  const unconditional = ["@unittest.skip('temporarily disabled')", "@pytest.mark.skip(reason='flaky')"].join("\n");
  assert.equal(countSkips(unconditional), 2, "unconditional skip forms must still be counted");
});

test("test-integrity: an uncommitted batch of conditional Python skips is not flagged end to end (real CPython false positive)", () => {
  const dir = makeRepo();
  write(
    dir,
    "test/test_os.py",
    "def test_lseek():\n    pass\n"
  );
  sh("git add -A && git commit -q -m init", dir);
  // Mirrors the real CPython shape: adding conditional, platform-gating
  // skips to existing tests - legitimate cross-platform test design, not a
  // disabled test hiding a regression.
  write(
    dir,
    "test/test_os.py",
    "@unittest.skipUnless(hasattr(os, 'lseek'), 'test needs os.lseek()')\ndef test_lseek():\n    pass\n"
  );
  const findings = runAnalyzers({
    base: "HEAD",
    changedFiles: ["test/test_os.py"],
    cwd: dir,
    repoRoot: dir,
    statuses: { "test/test_os.py": { status: "modified" } },
  });
  assert.ok(
    !findings.some((f) => f.rule === "test-integrity-newly-skipped"),
    "expected a conditional skip decorator not to be flagged as newly-skipped"
  );
});

test("test-integrity: a shrinking test suite (fewer cases, uncommitted) is flagged", () => {
  const dir = makeRepo();
  write(
    dir,
    "test/math.test.js",
    "test('adds', () => {});\ntest('subtracts', () => {});\ntest('multiplies', () => {});\n"
  );
  sh("git add -A && git commit -q -m init", dir);
  write(dir, "test/math.test.js", "test('adds', () => {});\n");
  const findings = runAnalyzers({
    base: "HEAD",
    changedFiles: ["test/math.test.js"],
    cwd: dir,
    repoRoot: dir,
    statuses: { "test/math.test.js": { status: "modified" } },
  });
  const flagged = findings.find((f) => f.rule === "test-integrity-suite-shrank");
  assert.ok(flagged, "expected a test-integrity-suite-shrank finding");
  assert.equal(flagged.severity, "medium");
});

test("test-integrity: lowering a jest coverage threshold (uncommitted) is flagged high severity", () => {
  const dir = makeRepo();
  write(
    dir,
    "package.json",
    JSON.stringify({ name: "x", jest: { coverageThreshold: { global: { lines: 90, statements: 90 } } } })
  );
  sh("git add -A && git commit -q -m init", dir);
  write(
    dir,
    "package.json",
    JSON.stringify({ name: "x", jest: { coverageThreshold: { global: { lines: 50, statements: 90 } } } })
  );
  const findings = runAnalyzers({
    base: "HEAD",
    changedFiles: ["package.json"],
    cwd: dir,
    repoRoot: dir,
    statuses: { "package.json": { status: "modified" } },
  });
  const flagged = findings.find((f) => f.rule === "test-integrity-coverage-threshold-lowered");
  assert.ok(flagged, "expected a test-integrity-coverage-threshold-lowered finding");
  assert.equal(flagged.severity, "high");
});

test("test-integrity regression: reading HEAD instead of the working tree missed an uncommitted newly-skipped test (pre-fix bug)", () => {
  // Reproduces the bug fixed in src/analyzers/testIntegrity.js: the module
  // used to read "after" state from `git show HEAD:file`, which is blind to
  // uncommitted changes - exactly the state postflight is meant to review
  // before a commit happens. Calling analyze() directly with HEAD as both
  // "base" and the source of "after" simulates the pre-fix code path and
  // proves the working-tree read now wins.
  const dir = makeRepo();
  write(dir, "test/math.test.js", "test('adds', () => {});\n");
  sh("git add -A && git commit -q -m init", dir);
  write(dir, "test/math.test.js", "test.skip('adds', () => {});\n");
  const { evidence } = analyze({
    base: "HEAD",
    cwd: dir,
    changedFiles: ["test/math.test.js"],
    statuses: { "test/math.test.js": { status: "modified" } },
  });
  assert.ok(
    evidence.some((e) => e.id === "test-integrity/newly-skipped"),
    "an uncommitted newly-skipped test must be detected against the working tree, not HEAD"
  );
});

test("test-integrity bug fix: the coverage-threshold check no longer prints git's 'path does not exist' error to stderr when package.json isn't part of the diff", () => {
  // Reproduces the noise flagged (but explicitly left unfixed) in
  // Note: the coverage-threshold comparison used to call
  // `git.showFile(base, "package.json", cwd)` unconditionally on every
  // analyze() call, regardless of whether package.json was actually
  // touched. In a repo with no package.json at `base`, that produced a
  // real `fatal: path 'package.json' does not exist in 'HEAD'` line on
  // git's own stderr - harmless (already caught, already degraded to no
  // finding) but visible noise on every single run that didn't touch
  // package.json. Fixed by gating the check on `package.json` actually
  // being in `changedFiles`, the same way dependencyChange.js gates its
  // own manifest lookups. Runs analyze() in a real subprocess (not
  // in-process) so stderr can actually be captured and asserted on.
  const dir = makeRepo();
  write(dir, "src/a.js", "module.exports = 1;\n");
  sh("git add -A && git commit -q -m init", dir);
  write(dir, "src/a.js", "module.exports = 2;\n");
  const script = `
    const { analyze } = require(${JSON.stringify(path.join(__dirname, "..", "src", "analyzers", "testIntegrity"))});
    analyze({ base: "HEAD", cwd: process.cwd(), changedFiles: ["src/a.js"], statuses: { "src/a.js": { status: "modified" } } });
  `;
  const { spawnSync } = require("child_process");
  const spawned = spawnSync("node", ["-e", script], { cwd: dir, encoding: "utf8" });
  assert.equal(spawned.status, 0);
  assert.equal(spawned.stderr.trim(), "", `expected no stderr noise, got: ${spawned.stderr}`);
});

test("test-integrity: a tautological assertion introduced into an existing test is flagged FAIL/strong", () => {
  const dir = makeRepo();
  write(dir, "test/math.test.js", "test('adds', () => { expect(add(1,2)).toBe(3); });\n");
  sh("git add -A && git commit -q -m init", dir);
  // Same case count, same call shape (still "has an expect"), but the
  // check itself now passes unconditionally - the exact "gutted to force a
  // green" failure mode, invisible to case-counting or skip-counting alone.
  write(dir, "test/math.test.js", "test('adds', () => { expect(true).toBe(true); });\n");
  const findings = runAnalyzers({
    base: "HEAD",
    changedFiles: ["test/math.test.js"],
    cwd: dir,
    repoRoot: dir,
    statuses: { "test/math.test.js": { status: "modified" } },
  });
  const flagged = findings.find((f) => f.rule === "test-integrity-tautological-assertion-introduced");
  assert.ok(flagged, "expected a test-integrity-tautological-assertion-introduced finding");
  assert.equal(flagged.severity, "high");
});

test("test-integrity: a brand-new test file that ships with a tautological assertion is flagged too", () => {
  const dir = makeRepo();
  write(dir, "src/a.js", "module.exports = 1;\n");
  sh("git add -A && git commit -q -m init", dir);
  write(dir, "test/new.test.js", "test('placeholder', () => { assert.ok(true); });\n");
  const findings = runAnalyzers({
    base: "HEAD",
    changedFiles: ["test/new.test.js"],
    cwd: dir,
    repoRoot: dir,
    statuses: { "test/new.test.js": { status: "added" } },
  });
  const flagged = findings.find((f) => f.rule === "test-integrity-tautological-assertion-introduced");
  assert.ok(flagged, "expected a new test file's tautological assertion to be caught even with no base version to diff against");
});

test("test-integrity: python's bare 'assert True' and Java/Python's assertEqual(1, 1) are both recognized as tautological", () => {
  const { countTautologies } = require("../src/analyzers/testIntegrity");
  assert.equal(countTautologies("assert True\n"), 1);
  assert.equal(countTautologies("    assert  True\n"), 1);
  assert.equal(countTautologies("assertEquals(1, 1);\n"), 1);
  assert.equal(countTautologies("self.assertTrue(True)\n"), 1);
  // Must NOT fire on ordinary, meaningful assertions that merely mention
  // "true"/"1" as one side of a real comparison.
  assert.equal(countTautologies("assert result == True\n"), 0);
  assert.equal(countTautologies("assertEquals(1, computeTotal())\n"), 0);
  assert.equal(countTautologies("expect(isValid).toBe(true)\n"), 0);
});

test("test-integrity: assertions quietly reduced while case count stays flat is flagged WARN/medium, distinct from suite-shrank", () => {
  const dir = makeRepo();
  write(
    dir,
    "test/math.test.js",
    "test('adds', () => {\n  expect(add(1,2)).toBe(3);\n  expect(add(2,2)).toBe(4);\n  expect(add(-1,1)).toBe(0);\n});\n"
  );
  sh("git add -A && git commit -q -m init", dir);
  // Same single `it`/`test(...)` block (case count unchanged: 1 -> 1), but
  // two of the three checks inside it quietly disappear.
  write(dir, "test/math.test.js", "test('adds', () => {\n  expect(add(1,2)).toBe(3);\n});\n");
  const findings = runAnalyzers({
    base: "HEAD",
    changedFiles: ["test/math.test.js"],
    cwd: dir,
    repoRoot: dir,
    statuses: { "test/math.test.js": { status: "modified" } },
  });
  const flagged = findings.find((f) => f.rule === "test-integrity-assertions-reduced");
  assert.ok(flagged, "expected a test-integrity-assertions-reduced finding");
  assert.equal(flagged.severity, "medium");
  assert.ok(
    !findings.some((f) => f.rule === "test-integrity-suite-shrank"),
    "case count didn't drop, so suite-shrank must not also fire - these are meant to be non-overlapping signals"
  );
});

test("test-integrity: consolidating assertions is a documented confounder, not silently hidden", () => {
  // Not a behavior assertion (this genuinely does fire, correctly, per the
  // rule's own logic) - a documentation check that the known false-positive
  // shape for this specific heuristic is disclosed in its evidence, the
  // same convention `suite-shrank` already follows for its own confounder.
  const dir = makeRepo();
  write(
    dir,
    "test/math.test.js",
    "test('shape', () => {\n  expect(r.a).toBe(1);\n  expect(r.b).toBe(2);\n  expect(r.c).toBe(3);\n});\n"
  );
  sh("git add -A && git commit -q -m init", dir);
  write(dir, "test/math.test.js", "test('shape', () => {\n  expect(r).toMatchObject({ a: 1, b: 2, c: 3 });\n});\n");
  const findings = runAnalyzers({
    base: "HEAD",
    changedFiles: ["test/math.test.js"],
    cwd: dir,
    repoRoot: dir,
    statuses: { "test/math.test.js": { status: "modified" } },
  });
  const flagged = findings.find((f) => f.rule === "test-integrity-assertions-reduced");
  assert.ok(flagged);
  assert.ok(flagged.confounders && flagged.confounders.length, "expected the finding to carry a confounders list");
  assert.match(flagged.confounders.join(" "), /consolidat/i);
});

test("test-integrity: countAssertions counts expect/assert/go-t-error calls across languages", () => {
  const { countAssertions } = require("../src/analyzers/testIntegrity");
  assert.equal(countAssertions("expect(x).toBe(1);\n"), 1);
  assert.equal(countAssertions("assert x == 1\nassert y == 2\n"), 2);
  assert.equal(countAssertions("if got != want {\n  t.Errorf(\"bad\")\n}\n"), 1);
  assert.equal(countAssertions("// just a comment, no calls\n"), 0);
});

test("test-integrity: degrades to no findings (not a crash) on a broken/non-git cwd", () => {
  const findings = runAnalyzers({
    base: "HEAD",
    changedFiles: ["test/math.test.js"],
    cwd: "/nonexistent-path-xyz",
    repoRoot: "/nonexistent-path-xyz",
    statuses: { "test/math.test.js": { status: "modified" } },
  });
  assert.deepEqual(findings, []);
});

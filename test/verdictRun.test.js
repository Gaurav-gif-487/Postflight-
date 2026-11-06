"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { buildLedger, runVerdict, commandEvidence } = require("../src/verdictRun");
const { VERDICT } = require("../src/verdict");
const { STATUS, ORIGIN } = require("../src/evidence");

function sh(cmd, cwd) {
  execFileSync("bash", ["-c", cmd], { cwd, stdio: "pipe" });
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postflight-verdictrun-test-"));
  sh("git init -q", dir);
  sh("git config user.email a@b.com && git config user.name test", dir);
  return dir;
}

test("commandEvidence: no build/test given produces no evidence", () => {
  assert.deepEqual(commandEvidence({ buildResult: null, testResult: null, behaviorDiff: null }), []);
});

test("commandEvidence: a passing build is PASS/STRONG evidence in the build category", () => {
  const [ev] = commandEvidence({ buildResult: { ok: true, code: 0, command: "npm run build" }, testResult: null });
  assert.equal(ev.category, "build");
  assert.equal(ev.status, STATUS.PASS);
  assert.equal(ev.strength, "STRONG");
});

test("commandEvidence: a failing build is FAIL/UNKNOWN-origin (no base comparison was attempted)", () => {
  const [ev] = commandEvidence({ buildResult: { ok: false, code: 1, command: "npm run build" }, testResult: null });
  assert.equal(ev.status, STATUS.FAIL);
  assert.equal(ev.origin, ORIGIN.UNKNOWN);
});

test("commandEvidence: a failing plain --test (no --diff-behavior) is FAIL/UNKNOWN-origin", () => {
  const [ev] = commandEvidence({ buildResult: null, testResult: { ok: false, code: 1, command: "npm test" }, behaviorDiff: null });
  assert.equal(ev.category, "test");
  assert.equal(ev.status, STATUS.FAIL);
  assert.equal(ev.origin, ORIGIN.UNKNOWN);
});

test("commandEvidence: --diff-behavior regressions attribute a test failure as INTRODUCED", () => {
  const [ev] = commandEvidence({
    testResult: { ok: false, code: 1, command: "npm test" },
    behaviorDiff: { skipped: false, regressions: ["adds numbers"], removed: [], fixed: [], added: [] },
  });
  assert.equal(ev.origin, ORIGIN.INTRODUCED);
  assert.match(ev.detail, /adds numbers/);
});

test("commandEvidence: --diff-behavior with no per-test regressions attributes an overall failure as PRE_EXISTING", () => {
  const [ev] = commandEvidence({
    testResult: { ok: false, code: 1, command: "npm test" },
    behaviorDiff: { skipped: false, regressions: [], removed: [], fixed: [], added: [] },
  });
  assert.equal(ev.origin, ORIGIN.PRE_EXISTING);
});

test("buildLedger: a clean repo with no findings, no build/test produces no scored evidence beyond repo-state", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "hello world\n");
  const ledger = buildLedger({
    base: "HEAD",
    cwd: dir,
    analyzerCtx: { base: "HEAD", changedFiles: ["a.txt"], cwd: dir, repoRoot: dir, statuses: {} },
    patternFindings: [],
    archFindings: [],
  });
  assert.deepEqual(ledger.all, []);
});

test("buildLedger: pattern findings enter the ledger as WEAK, INTRODUCED evidence", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  sh("git add -A && git commit -q -m init", dir);
  const ledger = buildLedger({
    base: "HEAD",
    cwd: dir,
    analyzerCtx: { base: "HEAD", changedFiles: [], cwd: dir, repoRoot: dir, statuses: {} },
    patternFindings: [{ rule: "eval-exec", severity: "medium", category: "security", label: "Dynamic code execution", file: "a.js", line: 3, snippet: "eval(x)" }],
  });
  const found = ledger.all.find((e) => e.id.startsWith("pattern/eval-exec"));
  assert.ok(found);
  assert.equal(found.strength, "WEAK");
  assert.equal(found.origin, ORIGIN.INTRODUCED);
});

test("buildLedger: analyzerCtx: null (mirrors --no-analyzers) records a limitation instead of throwing", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  sh("git add -A && git commit -q -m init", dir);
  const ledger = buildLedger({ base: "HEAD", cwd: dir, analyzerCtx: null, patternFindings: [] });
  assert.ok(ledger.limitations.some((l) => l.id === "analyzers-skipped"));
});

test("runVerdict: end to end, a clean staged change under the default policy is SAFE_TO_MERGE", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "hello world\n");
  sh("git add -A", dir); // staged, so gitState sees no dirty-worktree limitation
  const result = runVerdict({
    preset: "default",
    base: "HEAD",
    cwd: dir,
    analyzerCtx: { base: "HEAD", changedFiles: ["a.txt"], cwd: dir, repoRoot: dir, statuses: {} },
    patternFindings: [],
    archFindings: [],
    changeSurface: { codeFilesChanged: 0, testFilesChanged: 0 },
  });
  assert.equal(result.verdict, VERDICT.SAFE_TO_MERGE);
  assert.equal(result.exitCode, 0);
  assert.equal(result.policy, "default");
  assert.equal(result.evidence.evidence.length, 0);
});

test("runVerdict: an uncommitted (dirty) working tree is a stated limitation, so the verdict is honestly INCONCLUSIVE rather than a false SAFE_TO_MERGE", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "hello world\n"); // left uncommitted, unstaged
  const result = runVerdict({
    preset: "default",
    base: "HEAD",
    cwd: dir,
    analyzerCtx: { base: "HEAD", changedFiles: ["a.txt"], cwd: dir, repoRoot: dir, statuses: {} },
    patternFindings: [],
    archFindings: [],
    changeSurface: { codeFilesChanged: 0, testFilesChanged: 0 },
  });
  assert.equal(result.verdict, VERDICT.INCONCLUSIVE);
  assert.equal(result.exitCode, 4);
});

test("runVerdict: end to end, a committed secret is flagged as REVIEW_REQUIRED, not BLOCK - pattern rules are WEAK evidence by design and stay below minStrengthToBlock", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  sh("git add -A && git commit -q -m init", dir);
  const result = runVerdict({
    preset: "default",
    base: "HEAD",
    cwd: dir,
    analyzerCtx: { base: "HEAD", changedFiles: [], cwd: dir, repoRoot: dir, statuses: {} },
    patternFindings: [
      { rule: "secret-aws-key", severity: "high", category: "security", label: "Possible AWS access key", file: "config.js", line: 1, snippet: "AKIA..." },
    ],
    archFindings: [],
    changeSurface: { codeFilesChanged: 1, testFilesChanged: 0 },
  });
  assert.equal(result.verdict, VERDICT.REVIEW_REQUIRED);
  assert.equal(result.exitCode, 1);
  assert.match(result.reasons[0].text, /below the blocking threshold/);
});

test("runVerdict: an unknown preset name throws (caller is expected to turn this into exit 2)", () => {
  const dir = makeRepo();
  assert.throws(() => runVerdict({ preset: "nonexistent", base: "HEAD", cwd: dir, analyzerCtx: null }), /unknown policy "nonexistent"/);
});

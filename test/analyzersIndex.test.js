"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { runAnalyzers, collectEvidence, EVIDENCE_ANALYZERS } = require("../src/analyzers");

test("runAnalyzers: returns [] immediately when disabled", () => {
  const result = runAnalyzers({ base: "HEAD", changedFiles: [], cwd: "/tmp", repoRoot: "/tmp" }, { enabled: false });
  assert.deepEqual(result, []);
});

test("runAnalyzers: returns [] for a context with no changed files, without throwing", () => {
  const result = runAnalyzers({ base: "HEAD", changedFiles: [], cwd: "/tmp", repoRoot: "/tmp" });
  assert.deepEqual(result, []);
});

test("runAnalyzers: a broken analyzer degrades to no findings instead of crashing the run", () => {
  // Point repoRoot somewhere with no git repo so the underlying git calls
  // inside the real analyzer fail - the registry must swallow that.
  const result = runAnalyzers({
    base: "HEAD",
    changedFiles: ["src/x.js"],
    cwd: "/nonexistent-path-xyz",
    repoRoot: "/nonexistent-path-xyz",
  });
  assert.deepEqual(result, []);
});

// collectEvidence (used only by the opt-in --policy verdict engine,
// src/verdictRun.js) returns the six evidence-schema analyzers' raw,
// unfiltered evidence - unlike runAnalyzers/ANALYZERS above, which only
// covers WARN/FAIL (and drops PASS/UNKNOWN for blast-radius specifically).

test("collectEvidence: returns [] for a context with no changed files, without throwing", () => {
  const result = collectEvidence({ base: "HEAD", changedFiles: [], cwd: "/tmp", repoRoot: "/tmp", statuses: {} });
  assert.deepEqual(result, []);
});

test("collectEvidence: a broken/inaccessible repo degrades to UNKNOWN evidence, never throws", () => {
  // Not "returns []" - blast-radius correctly still reports that it
  // *couldn't* measure anything (UNKNOWN), which is the honest behavior
  // (see src/analyzers/blastRadius.js and gitState.js's own design: absence
  // of evidence must be visible, not silently indistinguishable from "all
  // clear"). The contract collectEvidence itself must uphold is just that
  // no analyzer's exception escapes it.
  assert.doesNotThrow(() => {
    collectEvidence({
      base: "HEAD",
      changedFiles: ["src/x.js"],
      cwd: "/nonexistent-path-xyz",
      repoRoot: "/nonexistent-path-xyz",
      statuses: {},
    });
  });
  const result = collectEvidence({
    base: "HEAD",
    changedFiles: ["src/x.js"],
    cwd: "/nonexistent-path-xyz",
    repoRoot: "/nonexistent-path-xyz",
    statuses: {},
  });
  assert.ok(result.every((ev) => ev.status === "UNKNOWN" || ev.status === "PASS"));
});

test("collectEvidence: covers exactly the six evidence-schema analyzers (not js-import-graph)", () => {
  const names = EVIDENCE_ANALYZERS.map((a) => a.name).sort();
  assert.deepEqual(names, [
    "blast-radius",
    "config-change",
    "coverage",
    "dependency-change",
    "sensitive-paths",
    "test-integrity",
  ]);
});

test("collectEvidence: surfaces raw evidence objects with status/strength/origin, not v1 finding shape", () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const { execFileSync } = require("child_process");
  const sh = (cmd, cwd) => execFileSync("bash", ["-c", cmd], { cwd, stdio: "pipe" });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postflight-collectevidence-test-"));
  sh("git init -q", dir);
  sh("git config user.email a@b.com && git config user.name test", dir);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.0.0", dependencies: {} }));
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "x", version: "1.0.0", dependencies: { "left-pad": "^1.3.0" } })
  );

  const result = collectEvidence({ base: "HEAD", changedFiles: ["package.json"], cwd: dir, repoRoot: dir, statuses: {} });
  const ev = result.find((e) => e.id.startsWith("dependency/added"));
  assert.ok(ev, "expected raw dependency-added evidence");
  assert.equal(ev.status, "WARN");
  assert.equal(ev.origin, "INTRODUCED");
  // Not converted to a v1 finding: no "rule"/"severity" fields, unlike what
  // runAnalyzers()/evidenceToFinding produce for the same underlying data.
  assert.equal(ev.rule, undefined);
  assert.equal(ev.severity, undefined);
});

"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { runAnalyzers } = require("../src/analyzers");

function sh(cmd, cwd) {
  execFileSync("bash", ["-c", cmd], { cwd, stdio: "pipe" });
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postflight-sensitivepaths-test-"));
  sh("git init -q", dir);
  sh("git config user.email a@b.com && git config user.name test", dir);
  return dir;
}

function write(dir, file, text) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
}

// sensitivePaths.js classifies purely by file path + git status - it does
// not read file content at any revision, so it has no HEAD-vs-working-tree
// distinction to get wrong (checked explicitly). These tests
// exercise it against real scratch repos, end to end via runAnalyzers.

test("sensitive-paths: a clean repo with an unrelated change reports nothing (no false positives)", () => {
  const dir = makeRepo();
  write(dir, "src/util.js", "module.exports = () => 1;\n");
  sh("git add -A && git commit -q -m init", dir);
  write(dir, "src/util.js", "module.exports = () => 2;\n");
  const findings = runAnalyzers({
    base: "HEAD",
    changedFiles: ["src/util.js"],
    cwd: dir,
    repoRoot: dir,
    statuses: { "src/util.js": { status: "modified" } },
  });
  assert.deepEqual(findings, []);
});

test("sensitive-paths: an uncommitted auth-path change is flagged medium severity as a security finding", () => {
  const dir = makeRepo();
  write(dir, "src/auth/login.js", "function login() {}\n");
  sh("git add -A && git commit -q -m init", dir);
  write(dir, "src/auth/login.js", "function login() { /* changed */ }\n");
  const findings = runAnalyzers({
    base: "HEAD",
    changedFiles: ["src/auth/login.js"],
    cwd: dir,
    repoRoot: dir,
    statuses: { "src/auth/login.js": { status: "modified" } },
  });
  const flagged = findings.find((f) => f.rule === "surface-sensitive-auth");
  assert.ok(flagged, "expected a surface-sensitive-auth finding");
  assert.equal(flagged.severity, "medium");
  assert.equal(flagged.category, "security");
});

test("sensitive-paths: deleting a payments-path file is flagged high severity", () => {
  const dir = makeRepo();
  write(dir, "src/billing/charge.js", "function charge() {}\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.rmSync(path.join(dir, "src/billing/charge.js"));
  const findings = runAnalyzers({
    base: "HEAD",
    changedFiles: ["src/billing/charge.js"],
    cwd: dir,
    repoRoot: dir,
    statuses: { "src/billing/charge.js": { status: "deleted" } },
  });
  const flagged = findings.find((f) => f.rule === "surface-sensitive-payments");
  assert.ok(flagged, "expected a surface-sensitive-payments finding");
  assert.equal(flagged.severity, "high");
  assert.equal(flagged.category, "surface");
});

test("sensitive-paths: modifying (rewriting) an existing migration is flagged high severity", () => {
  const dir = makeRepo();
  write(dir, "migrations/001_init.sql", "CREATE TABLE users (id INT);\n");
  sh("git add -A && git commit -q -m init", dir);
  write(dir, "migrations/001_init.sql", "CREATE TABLE users (id INT, email TEXT);\n");
  const findings = runAnalyzers({
    base: "HEAD",
    changedFiles: ["migrations/001_init.sql"],
    cwd: dir,
    repoRoot: dir,
    statuses: { "migrations/001_init.sql": { status: "modified" } },
  });
  const flagged = findings.find((f) => f.rule === "surface-sensitive-migration");
  assert.ok(flagged, "expected a surface-sensitive-migration finding");
  assert.equal(flagged.severity, "high");
  assert.match(flagged.snippet, /modified rather than superseded/);
});

test("sensitive-paths: adding a new migration (not rewriting one) is flagged only medium severity", () => {
  const dir = makeRepo();
  write(dir, "migrations/001_init.sql", "CREATE TABLE users (id INT);\n");
  sh("git add -A && git commit -q -m init", dir);
  write(dir, "migrations/002_add_email.sql", "ALTER TABLE users ADD COLUMN email TEXT;\n");
  const findings = runAnalyzers({
    base: "HEAD",
    changedFiles: ["migrations/002_add_email.sql"],
    cwd: dir,
    repoRoot: dir,
    statuses: { "migrations/002_add_email.sql": { status: "added" } },
  });
  const flagged = findings.find((f) => f.rule === "surface-sensitive-migration");
  assert.ok(flagged, "expected a surface-sensitive-migration finding");
  assert.equal(flagged.severity, "medium");
});

test("sensitive-paths: does not throw on a broken/non-git cwd (path classification alone doesn't touch disk or git)", () => {
  // Unlike test-integrity/dependency-change, sensitivePaths.js classifies
  // purely by path string + the statuses map the caller passes in - it
  // never reads cwd or shells out to git, so an invalid cwd legitimately
  // does not suppress its findings the way it does for the analyzers that
  // read file content. The registry-wide "never throws" contract is what's
  // being checked here, not "no findings" (see
  // test/analyzersIndex.test.js for the registry-level guarantee, which
  // does assert empty results for an analyzer that actually depends on a
  // working cwd).
  assert.doesNotThrow(() => {
    runAnalyzers({
      base: "HEAD",
      changedFiles: ["src/auth/login.js"],
      cwd: "/nonexistent-path-xyz",
      repoRoot: "/nonexistent-path-xyz",
      statuses: { "src/auth/login.js": { status: "modified" } },
    });
  });
});

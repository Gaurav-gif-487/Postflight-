"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { runAnalyzers } = require("../src/analyzers");
const { analyze } = require("../src/analyzers/blastRadius");

function sh(cmd, cwd) {
  execFileSync("bash", ["-c", cmd], { cwd, stdio: "pipe" });
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postflight-blastradius-test-"));
  sh("git init -q", dir);
  sh("git config user.email a@b.com && git config user.name test", dir);
  return dir;
}

function write(dir, file, text) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
}

// Same rationale as the other four wired-in analyzers' tests: go through
// the real CLI/analyzer pipeline (runAnalyzers) against a real scratch git
// repo, not blastRadius.analyze() in isolation, except where a test is
// specifically about analyze()'s own working-tree-reading behavior.

test("blast-radius: a clean repo with an unrelated (non-JS) change reports nothing (no false positives)", () => {
  const dir = makeRepo();
  write(dir, "README.md", "hello\n");
  write(dir, "src/shared.js", "module.exports = { val: 1 };\n");
  write(dir, "src/a.js", "const shared = require('./shared');\nmodule.exports = shared.val;\n");
  sh("git add -A && git commit -q -m init", dir);
  write(dir, "README.md", "hello world\n");
  const findings = runAnalyzers({
    base: "HEAD",
    changedFiles: ["README.md"],
    cwd: dir,
    repoRoot: dir,
    statuses: { "README.md": { status: "modified" } },
  });
  assert.deepEqual(findings, []);
});

test("blast-radius: a small, contained JS change (low fan-in) stays under the wide threshold and produces no finding", () => {
  const dir = makeRepo();
  // 10 source files total, only one (leaf.js) is unrelated to anything -
  // the changed file (leaf.js itself) has zero dependents, well under both
  // the 25% ratio and 50-dependent thresholds.
  for (let i = 0; i < 9; i++) {
    write(dir, `src/f${i}.js`, `module.exports = ${i};\n`);
  }
  write(dir, "src/leaf.js", "module.exports = 'leaf';\n");
  sh("git add -A && git commit -q -m init", dir);
  write(dir, "src/leaf.js", "module.exports = 'leaf-changed';\n");
  const findings = runAnalyzers({
    base: "HEAD",
    changedFiles: ["src/leaf.js"],
    cwd: dir,
    repoRoot: dir,
    statuses: { "src/leaf.js": { status: "modified" } },
  });
  const flagged = findings.find((f) => f.rule === "architecture-blast-radius");
  assert.equal(flagged, undefined, "a contained (PASS-status) blast radius must not surface as a finding");
  // Confirm this isn't just "the analyzer produced nothing at all" - the
  // underlying evidence is a real PASS record, deliberately filtered.
  const { evidence } = analyze({ base: "HEAD", changedFiles: ["src/leaf.js"], repoRoot: dir });
  const main = evidence.find((e) => e.id === "architecture/blast-radius");
  assert.ok(main, "expected the module to still compute blast-radius evidence internally");
  assert.equal(main.status, "PASS");
});

test("blast-radius: a widely-imported module change crosses the wide threshold and is flagged, end to end via runAnalyzers", () => {
  const dir = makeRepo();
  write(dir, "src/shared.js", "module.exports = { val: 1 };\n");
  // Three of six total source files import shared.js -> ratio 0.5, comfortably
  // over the 0.25 "wide" threshold in this small scratch repo.
  write(dir, "src/a.js", "const shared = require('./shared');\nmodule.exports = shared.val;\n");
  write(dir, "src/b.js", "const shared = require('./shared');\nmodule.exports = shared.val + 1;\n");
  write(dir, "src/c.js", "const shared = require('./shared');\nmodule.exports = shared.val + 2;\n");
  write(dir, "src/unrelated1.js", "module.exports = 'x';\n");
  write(dir, "src/unrelated2.js", "module.exports = 'y';\n");
  sh("git add -A && git commit -q -m init", dir);
  write(dir, "src/shared.js", "module.exports = { val: 2 };\n");
  const findings = runAnalyzers({
    base: "HEAD",
    changedFiles: ["src/shared.js"],
    cwd: dir,
    repoRoot: dir,
    statuses: { "src/shared.js": { status: "modified" } },
  });
  const flagged = findings.find((f) => f.rule === "architecture-blast-radius");
  assert.ok(flagged, "expected an architecture-blast-radius finding for a wide blast radius");
  assert.equal(flagged.severity, "medium"); // WARN -> medium under STATUS_TO_SEVERITY
  assert.match(flagged.label, /Wide blast radius/);
});

test("blast-radius: reads the working tree, not HEAD, so an uncommitted new import edge widens the measured blast radius", () => {
  // Same class of bug checked for in the other three analyzers
  // (dependency-change, test-integrity, config-change), all of which used
  // to read "after" state via `git show HEAD:<file>`. This module reads
  // source files with fs.readFileSync directly against repoRoot and lists
  // them via `git ls-files --cached --others --exclude-standard`, which is
  // already working-tree-native - this test proves that explicitly rather
  // than assuming it from reading the code.
  const dir = makeRepo();
  write(dir, "src/shared.js", "module.exports = { val: 1 };\n");
  write(dir, "src/importerA.js", "module.exports = 'a';\n"); // no import yet at HEAD
  sh("git add -A && git commit -q -m init", dir);
  // Deliberately left uncommitted: importerA now imports shared.js, but
  // this edit was never committed.
  write(dir, "src/importerA.js", "const shared = require('./shared');\nmodule.exports = shared.val;\n");
  const { evidence } = analyze({ base: "HEAD", changedFiles: ["src/shared.js"], repoRoot: dir });
  const main = evidence.find((e) => e.id === "architecture/blast-radius");
  assert.ok(main, "expected blast-radius evidence");
  assert.equal(
    main.data.dependents,
    1,
    "the uncommitted import edge from importerA.js must be counted - a HEAD-based read would report 0 dependents"
  );
});

test("blast-radius: an untracked (uncommitted, unstaged) new importer file is also picked up via the working tree", () => {
  const dir = makeRepo();
  write(dir, "src/shared.js", "module.exports = { val: 1 };\n");
  sh("git add -A && git commit -q -m init", dir);
  // A brand-new file that has never been `git add`-ed at all.
  write(dir, "src/importerNew.js", "const shared = require('./shared');\nmodule.exports = shared.val;\n");
  const { evidence } = analyze({ base: "HEAD", changedFiles: ["src/shared.js"], repoRoot: dir });
  const main = evidence.find((e) => e.id === "architecture/blast-radius");
  assert.ok(main);
  assert.ok(
    main.data.perFile.some((p) => p.file === "src/shared.js"),
    "expected shared.js in the reported reach"
  );
  assert.equal(main.data.dependents, 1, "an untracked new importer must count as a dependent");
});

test("blast-radius: degrades to no findings, not a crash, on a broken/non-git cwd/repoRoot", () => {
  // Matches the registry-wide guarantee in test/analyzersIndex.test.js and
  // the individual per-analyzer checks each of the other four already-wired
  // modules do for themselves. Unlike config-change (which surfaces a
  // low-severity UNKNOWN finding on a broken cwd because that check is
  // gated on a specific file being in changedFiles), blast-radius's
  // "unavailable" evidence is deliberately filtered out at the
  // runBlastRadius adapter (see src/analyzers/index.js), so the *whole
  // pipeline* result for a broken repoRoot is genuinely empty, not merely
  // non-crashing.
  assert.doesNotThrow(() => {
    const findings = runAnalyzers({
      base: "HEAD",
      changedFiles: ["src/x.js"],
      cwd: "/nonexistent-path-xyz",
      repoRoot: "/nonexistent-path-xyz",
    });
    assert.deepEqual(findings, []);
  });
  // Confirm directly that the module itself doesn't throw and produces the
  // UNKNOWN "unavailable" evidence record (not silence, not a crash) -
  // it's the adapter, not the module, that turns this into zero findings.
  assert.doesNotThrow(() => {
    const { evidence } = analyze({
      base: "HEAD",
      changedFiles: ["src/x.js"],
      repoRoot: "/nonexistent-path-xyz",
    });
    assert.ok(evidence.some((e) => e.id === "architecture/blast-radius-unavailable"));
    assert.equal(evidence[0].status, "UNKNOWN");
  });
});

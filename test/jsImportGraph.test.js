"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { extractImports, findCycles, canonicalize } = require("../src/analyzers/jsImportGraph");

test("extractImports: pulls relative require() and import specifiers", () => {
  const src = `
    const a = require("./a");
    import b from "../b";
    import "./side-effect";
    import x from "some-package"; // not relative, ignored
  `;
  assert.deepEqual(extractImports(src).sort(), ["../b", "./a", "./side-effect"].sort());
});

test("findCycles: detects a simple two-node cycle", () => {
  const graph = { "a.js": ["b.js"], "b.js": ["a.js"] };
  const cycles = findCycles(graph).map(canonicalize);
  assert.equal(cycles.length, 1);
});

test("findCycles: reports no cycle for a DAG", () => {
  const graph = { "a.js": ["b.js"], "b.js": ["c.js"], "c.js": [] };
  assert.deepEqual(findCycles(graph), []);
});

test("canonicalize: rotations of the same cycle compare equal", () => {
  const c1 = canonicalize(["a.js", "b.js", "c.js"]);
  const c2 = canonicalize(["b.js", "c.js", "a.js"]);
  assert.equal(c1, c2);
});

// --- readFileAtRef stderr suppression -------------------------------------
//
// The `git()` helper inside jsImportGraph.js runs `git show <ref>:<file>`
// with stdio [pipe, pipe, "ignore"] specifically so a failing lookup (most
// commonly: a file that doesn't exist at that ref) doesn't leak git's own
// `fatal: path '<file>' does not exist in '<ref>'` onto postflight's
// stderr. That's checked directly here, not through analyze(): analyze()
// only ever calls readFileAtRef with paths it already confirmed exist at
// `ref` via `git ls-tree` (see the reachability note next to the git()
// function), so a real "missing at ref" failure can never occur on that
// path - forcing one through analyze() would mean fabricating a fake bug
// elsewhere in the filtering logic just to reach this line, which would
// test the fake bug, not this defensive code. readFileAtRef is exported
// for exactly this reason.
const { readFileAtRef } = require("../src/analyzers/jsImportGraph");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

function sh(cmd, cwd) {
  execFileSync("bash", ["-c", cmd], { cwd, stdio: "pipe" });
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postflight-jsimportgraph-test-"));
  sh("git init -q", dir);
  sh("git config user.email a@b.com && git config user.name test", dir);
  return dir;
}

test("readFileAtRef: a file missing at the given ref returns empty string, not a thrown error", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.js"), "module.exports = {};\n");
  sh("git add -A && git commit -q -m init", dir);
  // "b.js" was never committed, so it doesn't exist at HEAD.
  assert.doesNotThrow(() => readFileAtRef("HEAD", "b.js", dir));
  assert.equal(readFileAtRef("HEAD", "b.js", dir), "");
});

test("readFileAtRef regression: git's 'fatal: path does not exist' is never written to stderr for a missing-at-ref lookup", () => {
  // Spawn a real subprocess so we can inspect the actual OS-level stderr
  // stream postflight would produce - the bug this guards against
  // (execFileSync inheriting the child's stderr by default) is only
  // visible at that level, not by mocking anything in-process.
  const { spawnSync } = require("child_process");
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.js"), "module.exports = {};\n");
  sh("git add -A && git commit -q -m init", dir);

  const script = `
    const { readFileAtRef } = require(${JSON.stringify(path.join(__dirname, "..", "src", "analyzers", "jsImportGraph.js"))});
    const result = readFileAtRef("HEAD", "definitely-not-a-real-file.js", ${JSON.stringify(dir)});
    process.stdout.write(JSON.stringify({ result }));
  `;
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8" });
  assert.equal(proc.status, 0, `subprocess should exit cleanly; stderr: ${proc.stderr}`);
  assert.equal(proc.stderr, "", "git's fatal-path error must not reach stderr");
  const parsed = JSON.parse(proc.stdout);
  assert.equal(parsed.result, "");
});

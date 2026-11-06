"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

// Manual replay exercised the
// CLI end-to-end against three pathological diffs - a huge generated file
// (~4.5MB / 100k lines), a vendored dependency dump (3000 small files
// across 50 directories), and a monorepo-wide directory rename (git mv of
// an entire src/ tree) - and confirmed all three complete in well under a
// second with no crash. These tests codify that as an automated,
// repeatable check rather than a one-off manual run, with a generous
// timeout so the assertion is "doesn't hang or crash", not a tight
// performance SLA that would make this test flaky in CI.

function sh(cmd, cwd) {
  execFileSync("bash", ["-c", cmd], { cwd, stdio: "pipe" });
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postflight-perf-test-"));
  sh("git init -q", dir);
  sh("git config user.email a@b.com && git config user.name test", dir);
  return dir;
}

function runCli(dir, extraArgs = []) {
  const bin = path.join(__dirname, "..", "bin", "postflight.js");
  return execFileSync("node", [bin, "run", "--base", "HEAD", "--cwd", dir, "--format", "json", ...extraArgs], {
    encoding: "utf8",
    timeout: 30000,
  });
}

test("performance: a single huge generated file (100k lines) does not crash or hang", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "README.md"), "init\n");
  sh("git add -A && git commit -q -m init", dir);

  fs.mkdirSync(path.join(dir, "src"));
  const lines = [];
  for (let i = 0; i < 100000; i++) lines.push(`export const VALUE_${i} = ${i}; // generated`);
  fs.writeFileSync(path.join(dir, "src", "generated.js"), lines.join("\n") + "\n");
  sh("git add -A", dir);

  const start = Date.now();
  const out = runCli(dir);
  const elapsedMs = Date.now() - start;
  const parsed = JSON.parse(out);
  assert.ok(parsed.findings !== undefined, "expected a well-formed report, not a crash");
  assert.ok(elapsedMs < 15000, `expected well under the CLI's own default timeout, took ${elapsedMs}ms`);
});

test("performance: a vendored dependency dump (3000 small files) does not crash or hang", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "README.md"), "init\n");
  sh("git add -A && git commit -q -m init", dir);

  for (let i = 0; i < 3000; i++) {
    const pkgDir = path.join(dir, "vendor", "lib", `pkg${i % 50}`);
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, `mod${i}.js`), `module.exports = { id: ${i} };\n`.repeat(20));
  }
  sh("git add -A", dir);

  const start = Date.now();
  const out = runCli(dir);
  const elapsedMs = Date.now() - start;
  const parsed = JSON.parse(out);
  assert.ok(parsed.findings !== undefined, "expected a well-formed report, not a crash");
  assert.ok(elapsedMs < 15000, `expected well under the CLI's own default timeout, took ${elapsedMs}ms`);
});

test("performance: a monorepo-wide directory rename does not crash or hang", () => {
  const dir = makeRepo();
  fs.mkdirSync(path.join(dir, "src"));
  for (let i = 0; i < 200; i++) {
    fs.writeFileSync(path.join(dir, "src", `f${i}.js`), `module.exports = function f${i}() { return ${i}; };\n`);
  }
  sh("git add -A && git commit -q -m init", dir);

  fs.mkdirSync(path.join(dir, "packages", "core"), { recursive: true });
  sh("git mv src packages/core/src", dir);

  const start = Date.now();
  const out = runCli(dir);
  const elapsedMs = Date.now() - start;
  const parsed = JSON.parse(out);
  assert.ok(parsed.findings !== undefined, "expected a well-formed report, not a crash");
  assert.ok(elapsedMs < 15000, `expected well under the CLI's own default timeout, took ${elapsedMs}ms`);
});

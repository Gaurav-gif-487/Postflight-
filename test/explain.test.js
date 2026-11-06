"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const explain = require("../src/explain");

function sh(cmd, cwd) {
  execFileSync("bash", ["-c", cmd], { cwd, stdio: "pipe" });
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postflight-explain-test-"));
  sh("git init -q", dir);
  sh('git config user.email a@b.com && git config user.name test', dir);
  return dir;
}

test("explain: returns no findings/explanations when the rule doesn't match anything", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.js"), "const x = 1;\n");
  sh("git add -A && git commit -q -m init", dir);
  const result = explain.explain({ rule: "eval-exec", base: "HEAD", cwd: dir });
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.explanations, []);
});

test("explain: traces a finding to the commit that introduced it", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.js"), "// clean\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "a.js"), "eval('x')\n"); // postflight-ignore
  sh("git add -A && git commit -q -m 'introduce eval'", dir);
  const result = explain.explain({ rule: "eval-exec", file: "a.js", base: "HEAD~1", cwd: dir });
  assert.equal(result.findings.length, 1);
  assert.equal(result.explanations.length, 1);
  assert.ok(result.explanations[0].commit);
  assert.equal(result.explanations[0].precise, true);
  assert.match(result.explanations[0].commit.message, /introduce eval/);
});

test("explain: filters by file when both rule and file are given", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.js"), "// clean\n");
  fs.writeFileSync(path.join(dir, "b.js"), "// clean\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "a.js"), "eval('a')\n"); // postflight-ignore
  fs.writeFileSync(path.join(dir, "b.js"), "eval('b')\n"); // postflight-ignore
  const result = explain.explain({ rule: "eval-exec", file: "a.js", base: "HEAD", cwd: dir });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].file, "a.js");
});

test("explain: an uncommitted finding (pickaxe search finds nothing to attribute) is marked unconfirmed, not misattributed to an unrelated commit", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.js"), "// clean\n");
  sh("git add -A && git commit -q -m 'initial commit, unrelated to the eval below'", dir);
  // Left uncommitted - pickaxe (-S) only searches committed history, so it
  // can never find a commit that introduced this exact line.
  fs.writeFileSync(path.join(dir, "a.js"), "eval('x')\n"); // postflight-ignore
  const result = explain.explain({ rule: "eval-exec", file: "a.js", base: "HEAD", cwd: dir });
  assert.equal(result.explanations.length, 1);
  assert.equal(result.explanations[0].precise, false);
  assert.ok(result.explanations[0].commit, "still falls back to the most recent commit touching the file");
  const rendered = explain.render(result);
  assert.match(rendered, /UNCONFIRMED/);
});

test("explain.render: reports 'no matching finding' when explanations are empty", () => {
  const out = explain.render({ explanations: [] });
  assert.match(out, /no matching finding/);
});

test("explain.render: includes file, commit hash, and message when a commit is precisely confirmed", () => {
  const out = explain.render({
    explanations: [
      {
        finding: { label: "Dynamic code execution (eval/exec)", file: "a.js", snippet: "eval('x')" }, // postflight-ignore
        commit: { hash: "abcdef1234567890", author: "test", date: "2026-01-01", message: "introduce eval" },
        precise: true,
      },
    ],
  });
  assert.match(out, /Dynamic code execution/);
  assert.match(out, /a\.js/);
  assert.match(out, /abcdef1234/);
  assert.match(out, /introduce eval/);
  assert.doesNotMatch(out, /UNCONFIRMED/);
});

test("explain.render: labels a pickaxe-miss fallback as UNCONFIRMED instead of reusing the precise-match phrasing", () => {
  const out = explain.render({
    explanations: [
      {
        finding: { label: "Dynamic code execution (eval/exec)", file: "a.js", snippet: "eval('x')" }, // postflight-ignore
        commit: { hash: "abcdef1234567890", author: "test", date: "2026-01-01", message: "unrelated commit" },
        precise: false,
      },
    ],
  });
  assert.match(out, /UNCONFIRMED/);
  assert.match(out, /Most recent commit:/);
  assert.doesNotMatch(out, /^\s*Introduced by: abcdef1234/m);
});

test("explain.render: notes when a finding can't be traced to a single commit", () => {
  const out = explain.render({
    explanations: [{ finding: { label: "x", file: "a.js", snippet: null }, commit: null }],
  });
  assert.match(out, /could not be traced/);
});

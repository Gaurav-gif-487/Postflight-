"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const BIN = path.join(__dirname, "..", "bin", "postflight.js");

function sh(cmd, cwd) {
  execFileSync("bash", ["-c", cmd], { cwd, stdio: "pipe" });
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postflight-v2-cli-test-"));
  sh("git init -q", dir);
  sh("git config user.email a@b.com && git config user.name test", dir);
  return dir;
}

function runCli(args, cwd) {
  return spawnSync("node", [BIN, ...args], { cwd, encoding: "utf8" });
}

test("cli: bare 'postflight' inside a git repo behaves like 'postflight verify' (evidence-based exit codes)", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "hello world\n");
  const result = runCli([], dir);
  assert.match(result.stdout, /POLICY VERDICT/);
  assert.ok([0, 1, 3, 4].includes(result.status));
});

test("cli: bare 'postflight' outside a git repo prints help and exits 0", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "not-a-repo-bare-"));
  const result = runCli([], dir);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/);
});

test("cli: 'verify' always runs the policy engine even without --policy", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "hello world\n");
  const result = runCli(["verify", "--no-color"], dir);
  assert.match(result.stdout, /POLICY VERDICT — default/);
});

test("cli: --proof writes a valid postflight-proof.json with the expected schema fields", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "hello world\n");
  const result = runCli(["verify", "--proof", "--no-color"], dir);
  const proofPath = path.join(dir, "postflight-proof.json");
  assert.ok(fs.existsSync(proofPath));
  const proof = JSON.parse(fs.readFileSync(proofPath, "utf8"));
  assert.equal(proof.schemaVersion, "1.0.0");
  assert.ok(proof.commit);
  assert.ok(Array.isArray(proof.evidence));
  assert.ok(proof.verdict);
  assert.ok([0, 1, 3, 4].includes(result.status));
});

test("cli: --proof --coverage populates the proof artifact's coverage field with real changed-line data", () => {
  const dir = makeRepo();
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "a.js"), "const one = 1;\nconst two = 2;\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "src", "a.js"), "const one = 1;\nconst two = 22;\n");
  fs.mkdirSync(path.join(dir, "reports"), { recursive: true });
  fs.writeFileSync(path.join(dir, "reports", "custom.lcov"), "SF:src/a.js\nDA:1,1\nDA:2,0\nend_of_record\n");

  runCli(["verify", "--proof", "--coverage", "reports/custom.lcov", "--no-color"], dir);
  const proof = JSON.parse(fs.readFileSync(path.join(dir, "postflight-proof.json"), "utf8"));
  assert.equal(proof.coverage.available, true);
  assert.equal(proof.coverage.format, "lcov");
  assert.equal(proof.coverage.changedLines.covered, 0);
  assert.equal(proof.coverage.changedLines.executable, 1);
  assert.deepEqual(proof.coverage.files["src/a.js"], { measured: true, covered: 0, executable: 1, ratio: 0 });
});

test("cli: --proof with no coverage report present reports { available: false, reason }, not null", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "hello world\n");
  runCli(["verify", "--proof", "--no-color"], dir);
  const proof = JSON.parse(fs.readFileSync(path.join(dir, "postflight-proof.json"), "utf8"));
  assert.equal(proof.coverage.available, false);
  assert.match(proof.coverage.reason, /no coverage report found/);
});

test("cli: --proof works alongside --diff-behavior (tests-per-run wiring, not just plain --test)", () => {
  const dir = makeRepo();
  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "test", "a.test.js"),
    "const { test } = require('node:test');\nconst assert = require('node:assert');\ntest('ok', () => { assert.equal(1, 1); });\n"
  );
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(
    path.join(dir, "test", "a.test.js"),
    "const { test } = require('node:test');\nconst assert = require('node:assert');\ntest('ok', () => { assert.equal(1, 1); });\ntest('new', () => { assert.equal(1, 1); });\n"
  );
  const result = runCli(
    ["verify", "--proof", "--diff-behavior", "--test", "node --test test/*.test.js", "--no-color"],
    dir
  );
  const proof = JSON.parse(fs.readFileSync(path.join(dir, "postflight-proof.json"), "utf8"));
  assert.ok(proof.tests, "proof.tests should be populated from the --diff-behavior test run");
  assert.equal(proof.tests.passed, true);
  assert.ok([0, 1, 3, 4].includes(result.status));
});


test("cli: --proof-out writes to a custom path", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "hello world\n");
  runCli(["verify", "--proof-out", "custom-proof.json", "--no-color"], dir);
  assert.ok(fs.existsSync(path.join(dir, "custom-proof.json")));
  assert.ok(!fs.existsSync(path.join(dir, "postflight-proof.json")));
});

test("cli: --task-file reports requirement statuses and never claims SATISFIED from text alone", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "auth.js"), "function oauthCallback() {}\n");
  const taskFile = path.join(dir, "task.json");
  fs.writeFileSync(taskFile, JSON.stringify({ task: "Add OAuth", requirements: ["OAuth callback exists"] }));
  const result = runCli(["verify", "--task-file", taskFile, "--no-color"], dir);
  assert.match(result.stdout, /Task: Add OAuth/);
  assert.match(result.stdout, /INCONCLUSIVE/);
  assert.doesNotMatch(result.stdout, /SATISFIED\] OAuth callback exists/);
});

test("cli: --task-file with an unreadable path exits 2 with a clear error", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  sh("git add -A && git commit -q -m init", dir);
  const result = runCli(["verify", "--task-file", "does-not-exist.json"], dir);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /could not read --task-file/);
});

test("cli: --format sarif carries the task result in run-level properties when --task-file is passed", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "auth.js"), "function oauthCallback() {}\n");
  const taskFile = path.join(dir, "task.json");
  fs.writeFileSync(taskFile, JSON.stringify({ task: "Add OAuth", requirements: ["OAuth callback exists"] }));
  const result = runCli(["verify", "--task-file", taskFile, "--format", "sarif"], dir);
  const sarif = JSON.parse(result.stdout);
  assert.equal(sarif.runs[0].properties.task.task, "Add OAuth");
  assert.equal(sarif.runs[0].properties.task.requirements[0].requirement, "OAuth callback exists");
});

test("cli: --format sarif omits the task property when --task/--task-file wasn't passed", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "hello world\n");
  const result = runCli(["verify", "--format", "sarif"], dir);
  const sarif = JSON.parse(result.stdout);
  assert.equal("task" in sarif.runs[0].properties, false);
});

test("cli: --format github prints the task result alongside inline annotations", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "auth.js"), "function oauthCallback() {}\n");
  const taskFile = path.join(dir, "task.json");
  fs.writeFileSync(taskFile, JSON.stringify({ task: "Add OAuth", requirements: ["OAuth callback exists"] }));
  const result = runCli(["verify", "--task-file", taskFile, "--format", "github"], dir);
  assert.match(result.stdout, /Task: Add OAuth/);
  assert.match(result.stdout, /INCONCLUSIVE/);
});

test("cli: 'explain <evidence-id>' reads a previously written proof file", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  sh("git add -A && git commit -q -m init", dir);
  // A hardcoded-secret pattern match guarantees at least one evidence
  // record, unlike a bare text diff which can legitimately produce none.
  fs.writeFileSync(path.join(dir, "config.js"), 'const apiKey = "sk_live_1234567890abcdef1234567890";\n');
  runCli(["verify", "--proof", "--no-color"], dir);
  const proof = JSON.parse(fs.readFileSync(path.join(dir, "postflight-proof.json"), "utf8"));
  assert.ok(proof.evidence.length > 0);
  const anyId = proof.evidence[0].id;
  const result = runCli(["explain", anyId], dir);
  assert.equal(result.status, 0);
  assert.match(result.stdout, new RegExp(anyId.replace(/[/]/g, "\\/")));
});

test("cli: 'explain <evidence-id>' fails clearly when no proof file exists yet", () => {
  const dir = makeRepo();
  const result = runCli(["explain", "test/command-result"], dir);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /run "postflight verify --proof" first/);
});

test("cli: 'plugins' with none configured says so and exits 0", () => {
  const dir = makeRepo();
  const result = runCli(["plugins"], dir);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /none configured/);
});

test("cli: 'plugins validate' on a well-formed plugin exits 0", () => {
  const dir = makeRepo();
  fs.writeFileSync(
    path.join(dir, "my-plugin.js"),
    'module.exports = { metadata: { name: "p", version: "1.0.0" }, detect: () => true, analyze: () => [], evidence: () => [] };'
  );
  const result = runCli(["plugins", "validate", "./my-plugin.js"], dir);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^OK/);
});

test("cli: 'plugins validate' on a malformed plugin exits 1 and lists the errors", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "bad-plugin.js"), "module.exports = {};");
  const result = runCli(["plugins", "validate", "./bad-plugin.js"], dir);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^FAIL/);
});

test("cli: a configured plugin's evidence flows into the policy verdict end to end", () => {
  const dir = makeRepo();
  fs.writeFileSync(
    path.join(dir, "plugin.js"),
    `module.exports = {
      metadata: { name: "always-warn", version: "1.0.0" },
      detect: () => true,
      analyze: () => [{}],
      evidence: () => [{ id: "check", category: "surface", status: "WARN", summary: "plugin says review this" }],
    };`
  );
  fs.writeFileSync(path.join(dir, ".postflightrc.json"), JSON.stringify({ plugins: ["./plugin.js"] }));
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "changed\n");
  const result = runCli(["verify", "--no-color"], dir);
  assert.match(result.stdout, /plugin says review this/);
  assert.equal(result.status, 1); // REVIEW_REQUIRED
});

test("cli: 'remediation' with none configured says so and exits 0", () => {
  const dir = makeRepo();
  const result = runCli(["remediation"], dir);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /none configured/);
});

test("cli: 'remediation validate' on a well-formed provider exits 0", () => {
  const dir = makeRepo();
  fs.writeFileSync(
    path.join(dir, "my-provider.js"),
    'module.exports = { metadata: { name: "p", version: "1.0.0" }, canRemediate: () => true, remediate: () => null };'
  );
  const result = runCli(["remediation", "validate", "./my-provider.js"], dir);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^OK/);
});

test("cli: 'remediation validate' on a malformed provider exits 1 and lists the errors", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "bad-provider.js"), "module.exports = {};");
  const result = runCli(["remediation", "validate", "./bad-provider.js"], dir);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^FAIL/);
});

test("cli: a configured remediation provider's suggestion flows into text output and the proof artifact", () => {
  const dir = makeRepo();
  fs.writeFileSync(
    path.join(dir, "plugin.js"),
    `module.exports = {
      metadata: { name: "always-warn", version: "1.0.0" },
      detect: () => true,
      analyze: () => [{}],
      evidence: () => [{ id: "check", category: "surface", status: "WARN", summary: "plugin says review this" }],
    };`
  );
  fs.writeFileSync(
    path.join(dir, "provider.js"),
    `module.exports = {
      metadata: { name: "auto-fixer", version: "1.0.0" },
      canRemediate: (ev) => ev.category === "surface",
      remediate: (ev) => ({ summary: "Try reverting the surface change", kind: "command", commands: ["git checkout -- ."] }),
    };`
  );
  fs.writeFileSync(
    path.join(dir, ".postflightrc.json"),
    JSON.stringify({ plugins: ["./plugin.js"], remediationProviders: ["./provider.js"] })
  );
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "changed\n");

  const textResult = runCli(["verify", "--no-color"], dir);
  assert.match(textResult.stdout, /SUGGESTED FIXES/);
  assert.match(textResult.stdout, /Try reverting the surface change/);
  assert.match(textResult.stdout, /git checkout -- \./);

  const proofResult = runCli(["verify", "--no-color", "--proof"], dir);
  assert.equal(proofResult.status, textResult.status);
  const proof = JSON.parse(fs.readFileSync(path.join(dir, "postflight-proof.json"), "utf8"));
  assert.equal(proof.remediations.length, 1);
  assert.equal(proof.remediations[0].provider, "auto-fixer");
  assert.equal(proof.remediations[0].evidenceId, "plugin/always-warn/check");
});

test("cli: without --policy, remediation providers never run even if configured", () => {
  const dir = makeRepo();
  fs.writeFileSync(
    path.join(dir, "provider.js"),
    `let called = false;
    module.exports = {
      metadata: { name: "watcher", version: "1.0.0" },
      canRemediate: () => { throw new Error("should never run without a policy verdict"); },
      remediate: () => null,
    };`
  );
  fs.writeFileSync(path.join(dir, ".postflightrc.json"), JSON.stringify({ remediationProviders: ["./provider.js"] }));
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "changed\n");
  const result = runCli(["run", "--no-color"], dir);
  assert.equal(result.status === 1 || result.status === 0, true);
  assert.doesNotMatch(result.stderr, /should never run/);
});

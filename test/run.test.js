"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { runCommand, runCommandFull, describeFailure, DEFAULT_TIMEOUT_MS } = require("../src/run");

test("runCommand: null command returns null", () => {
  assert.equal(runCommand(null, process.cwd()), null);
  assert.equal(runCommand("", process.cwd()), null);
});

test("runCommand: reports ok:true and exit code 0 on success", () => {
  const result = runCommand("exit 0", process.cwd());
  assert.equal(result.ok, true);
  assert.equal(result.code, 0);
});

test("runCommand: reports ok:false and the real exit code on failure", () => {
  const result = runCommand("exit 3", process.cwd());
  assert.equal(result.ok, false);
  assert.equal(result.code, 3);
});

test("runCommand: captures combined stdout/stderr", () => {
  const result = runCommand("echo out; echo err 1>&2", process.cwd());
  assert.match(result.output, /out/);
  assert.match(result.output, /err/);
});

test("runCommand: truncates very large output to the last 4000 chars", () => {
  const result = runCommand("node -e \"process.stdout.write('x'.repeat(10000))\"", process.cwd());
  assert.equal(result.output.length, 4000);
});

test("runCommandFull: returns the complete output, untruncated", () => {
  const result = runCommandFull("node -e \"process.stdout.write('x'.repeat(10000))\"", process.cwd());
  assert.equal(result.output.length, 10000);
});

test("runCommand: a command that outruns timeoutMs is killed and reported as timedOut", () => {
  const result = runCommand("sleep 5", process.cwd(), { timeoutMs: 100 });
  assert.equal(result.timedOut, true);
  assert.equal(result.ok, false);
  assert.equal(result.code, null);
  assert.match(result.output, /timed out after 100ms/);
});

test("runCommand: a command that finishes well under timeoutMs is not marked timedOut", () => {
  const result = runCommand("exit 0", process.cwd(), { timeoutMs: 5000 });
  assert.equal(result.timedOut, false);
  assert.equal(result.ok, true);
});

test("runCommand: timeoutMs 0 disables the bound entirely, matching spawnSync's falsy-timeout semantics", () => {
  const result = runCommand("sleep 0.2 && exit 0", process.cwd(), { timeoutMs: 0 });
  assert.equal(result.timedOut, false);
  assert.equal(result.ok, true);
});

test("runCommand: omitting timeoutMs falls back to DEFAULT_TIMEOUT_MS (not an unbounded run)", () => {
  assert.equal(typeof DEFAULT_TIMEOUT_MS, "number");
  assert.ok(DEFAULT_TIMEOUT_MS > 0);
  // Don't actually wait out the 10-minute default in a unit test - just
  // confirm a fast command still succeeds normally when no override is given.
  const result = runCommand("exit 0", process.cwd());
  assert.equal(result.ok, true);
  assert.equal(result.timedOut, false);
});

test("describeFailure: reports 'timed out' for a timed-out result instead of 'exit null'", () => {
  const result = runCommand("sleep 5", process.cwd(), { timeoutMs: 100 });
  assert.equal(describeFailure(result), "timed out");
});

test("describeFailure: reports the real exit code for a normal failure", () => {
  const result = runCommand("exit 3", process.cwd());
  assert.equal(describeFailure(result), "exit 3");
});

test("runCommand: does not leak this process's own NODE_TEST_* vars into the child", () => {
  // This test file itself runs under `node --test`, which sets
  // NODE_TEST_CONTEXT on this process - the exact condition that used to
  // silently break any spawned command that was itself `node --test`.
  assert.ok(process.env.NODE_TEST_CONTEXT, "expected this test run to set NODE_TEST_CONTEXT");
  const result = runCommand(
    "node -e \"console.log(JSON.stringify(process.env.NODE_TEST_CONTEXT || null))\"",
    process.cwd()
  );
  assert.match(result.output, /null/);
});

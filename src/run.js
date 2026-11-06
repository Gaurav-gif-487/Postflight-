"use strict";
const { spawnSync } = require("child_process");

// Node propagates a few NODE_TEST_* vars into child processes when the
// current process was itself launched via `node --test` (e.g.
// NODE_TEST_CONTEXT). Left in place, a spawned command that happens to
// also be `node --test` (as in postflight's own test suite, or any repo
// that tests postflight-invoking-postflight) silently switches into a
// coverage-collector mode with completely different output. Strip them so
// commands postflight runs behave the same whether or not postflight
// itself is currently running under a test harness.
function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("NODE_TEST_")) delete env[key];
  }
  return env;
}

// A hung --build/--test command (watch mode, a prompt waiting on stdin, a
// genuinely stuck process) must never hang postflight itself indefinitely -
// the whole point of the tool is to sit in a CI pipeline or a post-task
// hook, both of which need a bounded worst case. 10 minutes is generous for
// a single build or test invocation while still being finite; callers
// (src/cli.js's --timeout) can override it per run.
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

// Runs a shell command string, returns { ok, code, durationMs, output,
// timedOut }. `output` is truncated to the last 4000 chars for display
// purposes (huge test logs shouldn't blow up the report/JSON output).
// Callers that need to parse *every* line of output (e.g. diffBehavior,
// which counts on seeing each individual test result) should use
// runCommandFull instead.
function runCommand(command, cwd, options = {}) {
  const full = runCommandFull(command, cwd, options);
  if (!full) return null;
  return { ...full, output: full.output.slice(-4000) };
}

// Same as runCommand, but returns the complete, untruncated output. Meant
// for internal parsing, not for putting straight into a report - a large
// suite's full output can be megabytes.
function runCommandFull(command, cwd, options = {}) {
  if (!command) return null;
  const timeoutMs = options.timeoutMs != null ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const start = Date.now();
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    env: cleanEnv(),
    // 0/negative disables the bound entirely (spawnSync treats a falsy
    // timeout as "no timeout") - kept escapable via --timeout 0 rather than
    // hardcoding a limit nobody can opt out of.
    timeout: timeoutMs > 0 ? timeoutMs : undefined,
    killSignal: "SIGKILL",
  });
  // spawnSync sets result.error to an ETIMEDOUT Error (not a thrown
  // exception - spawnSync never throws for the child's own failure) and
  // result.status to null when the timeout fires, indistinguishable from a
  // process killed some other way except via result.error.code.
  const timedOut = Boolean(result.error && result.error.code === "ETIMEDOUT");
  let output = `${result.stdout || ""}${result.stderr || ""}`;
  if (timedOut) {
    output += `\n[postflight] command timed out after ${timeoutMs}ms and was killed`;
  }
  return {
    command,
    ok: result.status === 0,
    code: result.status,
    durationMs: Date.now() - start,
    output,
    timedOut,
  };
}

// Shared phrasing for a failed command result, used anywhere a build/test
// failure gets summarized (report.js, score.js, verdictRun.js) - a timed-out
// command has `code: null`, and "exit null" reads like a bug rather than
// what actually happened.
function describeFailure(result) {
  if (result.timedOut) return "timed out";
  return `exit ${result.code}`;
}

module.exports = { runCommand, runCommandFull, describeFailure, DEFAULT_TIMEOUT_MS };

"use strict";

// Wires src/evidence.js + src/gitState.js + src/verdict.js + src/policy.js
// into an actual run - the verdict layer. Deliberately opt-in: this
// module is only ever called when the caller (src/cli.js) passes --policy,
// so it cannot change output or exit codes for anyone not asking for it.
// The default `postflight run` path (src/score.js, src/report.js's plain
// `render`) is completely untouched by this file's existence.

const { EvidenceLedger, STATUS, STRENGTH, ORIGIN, METHOD } = require("./evidence");
const gitState = require("./gitState");
const { toEvidence } = require("./checks");
const { collectEvidence } = require("./analyzers");
const { resolvePolicy } = require("./policy");
const { decide } = require("./verdict");
const { describeFailure } = require("./run");

// Turns the build/test command results (src/run.js) into evidence. Neither
// command is ever run against `base` on its own (that's what
// --diff-behavior is for), so on its own a failing build/test can only be
// attributed ORIGIN.UNKNOWN - postflight did not check whether the failure
// predates this change. When --diff-behavior did run, its per-test base
// comparison lets test evidence be attributed more precisely.
function commandEvidence({ buildResult, testResult, behaviorDiff }) {
  const evidence = [];

  if (buildResult) {
    evidence.push({
      id: "build/command-result",
      category: "build",
      status: buildResult.ok ? STATUS.PASS : STATUS.FAIL,
      strength: STRENGTH.STRONG,
      origin: ORIGIN.UNKNOWN,
      summary: buildResult.ok ? "Build command passed" : `Build command failed (${describeFailure(buildResult)})`,
      detail: buildResult.ok
        ? null
        : "The build command was not also run against the base ref, so whether this failure predates the change is unknown.",
      provenance: {
        method: METHOD.OBSERVED,
        source: "build command",
        command: buildResult.command,
        exitCode: buildResult.code,
      },
    });
  }

  if (testResult) {
    let origin = ORIGIN.UNKNOWN;
    let detail = "The test command was not also run against the base ref, so whether this failure predates the change is unknown.";
    if (behaviorDiff && !behaviorDiff.skipped) {
      if (behaviorDiff.regressions.length) {
        origin = ORIGIN.INTRODUCED;
        detail = `${behaviorDiff.regressions.length} test(s) newly fail relative to base: ${behaviorDiff.regressions.join(", ")}`;
      } else if (!testResult.ok) {
        origin = ORIGIN.PRE_EXISTING;
        detail = "No individual test newly failed relative to base (--diff-behavior), so this failure is treated as pre-existing.";
      }
    }
    evidence.push({
      id: "test/command-result",
      category: "test",
      status: testResult.ok ? STATUS.PASS : STATUS.FAIL,
      strength: STRENGTH.STRONG,
      origin,
      summary: testResult.ok ? "Test command passed" : `Test command failed (${describeFailure(testResult)})`,
      detail: testResult.ok ? null : detail,
      provenance: {
        method: METHOD.OBSERVED,
        source: "test command",
        command: testResult.command,
        exitCode: testResult.code,
      },
    });
  }

  return evidence;
}

// Assembles every observation postflight made this run into one ledger:
// repo-state (base resolvability, shallow clone, dirty worktree, ...),
// checks.js pattern findings, the JS import-cycle analyzer, the six
// evidence-schema analyzers' raw (unfiltered) evidence, and build/test
// command results. Never throws - a missing/broken input degrades to a
// limitation or an UNKNOWN record, the same "fail specifically, don't
// silently no-op at the wrong layer" discipline as the rest of postflight.
function buildLedger({
  base,
  cwd,
  analyzerCtx,
  patternFindings = [],
  archFindings = [],
  buildResult = null,
  testResult = null,
  behaviorDiff = null,
  severityOverrides = {},
  // Evidence contributed by external plugins (src/plugins.js). Already in
  // the evidence schema shape (see src/evidence.js#createEvidence) - a
  // plugin that produces something malformed is the caller's problem to
  // catch before it gets here, same as any other evidence source.
  pluginEvidence = [],
}) {
  const ledger = new EvidenceLedger();

  try {
    const state = gitState.inspect({ base, cwd });
    gitState.record(ledger, state);
  } catch (err) {
    ledger.addLimitation({
      id: "repo-state-unavailable",
      summary: `Repository state could not be inspected: ${err.message}`,
    });
  }

  for (const ev of toEvidence(patternFindings, severityOverrides)) ledger.add(ev);
  for (const ev of toEvidence(archFindings, severityOverrides)) ledger.add(ev);
  if (analyzerCtx) {
    for (const ev of collectEvidence(analyzerCtx)) ledger.add(ev);
  } else {
    ledger.addLimitation({
      id: "analyzers-skipped",
      summary: "Analyzers were skipped (--no-analyzers), so architecture/dependency/config/coverage evidence is unavailable",
    });
  }
  for (const ev of commandEvidence({ buildResult, testResult, behaviorDiff })) ledger.add(ev);
  for (const ev of pluginEvidence) ledger.add(ev);

  return ledger;
}

// preset/configPolicy/overrides -> resolvePolicy; ledger -> decide(). Throws
// only for an unknown preset name (resolvePolicy's own hard error) - the
// caller (src/cli.js) is expected to catch that and exit(2) as a usage
// error, the same way it already does for e.g. --diff-behavior without
// --test.
function runVerdict({
  preset,
  configPolicy,
  overrides,
  base,
  cwd,
  analyzerCtx,
  patternFindings,
  archFindings,
  buildResult,
  testResult,
  behaviorDiff,
  severityOverrides,
  changeSurface,
  pluginEvidence,
}) {
  const policy = resolvePolicy({ preset, configPolicy, overrides });
  const ledger = buildLedger({
    base,
    cwd,
    analyzerCtx,
    patternFindings,
    archFindings,
    buildResult,
    testResult,
    behaviorDiff,
    severityOverrides,
    pluginEvidence,
  });
  const result = decide({ ledger, policy, changeSurface });
  return { ...result, evidence: ledger.toJSON() };
}

module.exports = { buildLedger, runVerdict, commandEvidence };

"use strict";
const { describeFailure } = require("./run");

const SEVERITY_PENALTY = { high: 25, medium: 10, low: 3 };
const UNTESTED_PATH_PENALTY = 4;
const UNTESTED_PATH_PENALTY_CAP = 20; // a big refactor with no tests shouldn't zero out on this alone
// Files where no test file at all was touched in the diff get the full
// penalty above (confident signal). Files where *some* test file was
// touched, just not one matching this file's naming convention, get a
// lighter penalty - see testMapping.js's partitionUntested for why
// conflating the two overstates confidence.
const LOOSE_UNTESTED_PATH_PENALTY = 1;
const LOOSE_UNTESTED_PATH_PENALTY_CAP = 8;

// Turns findings + command results into a 0-100 confidence score and a
// pass/fail verdict. Deliberately simple and legible - every point lost is
// traceable to a specific finding, not a black-box model.
//
// `verified` answers a narrower
// question than the full findings/confidence story: was any command
// actually *executed* against this change (--build and/or --test), as
// opposed to only the always-on static/pattern checks and analyzers? A bare
// `postflight run` with no flags produces the same 100%/SAFE_TO_MERGE as a
// run that passed a real build and test suite, and that difference is worth
// surfacing. This is deliberately the narrow fix the audit recommended
// instead of adopting verdict.js's INCONCLUSIVE status wholesale: it adds
// one new boolean field to the existing return shape and does not touch
// `confidence`, `status`, or exit codes, so it can't change behavior for
// any existing consumer that isn't already looking at this new field.
function score({ findings, buildResult, testResult, untestedFiles = [], looselyUntestedFiles = [], severityOverrides = {} }) {
  let confidence = 100;
  const reasons = [];

  for (const f of findings) {
    const severity = severityOverrides[f.rule] || f.severity;
    const penalty = SEVERITY_PENALTY[severity] || 5;
    confidence -= penalty;
    reasons.push(`-${penalty} ${f.label}${f.file ? ` (${f.file})` : ""}`);
  }

  if (untestedFiles.length) {
    const penalty = Math.min(UNTESTED_PATH_PENALTY_CAP, untestedFiles.length * UNTESTED_PATH_PENALTY);
    confidence -= penalty;
    reasons.push(`-${penalty} ${untestedFiles.length} changed file(s) with no matching test touched`);
  }

  if (looselyUntestedFiles.length) {
    const penalty = Math.min(LOOSE_UNTESTED_PATH_PENALTY_CAP, looselyUntestedFiles.length * LOOSE_UNTESTED_PATH_PENALTY);
    confidence -= penalty;
    reasons.push(
      `-${penalty} ${looselyUntestedFiles.length} changed file(s) with no naming-convention test match (other test file(s) changed in this diff, so this is a weaker signal)`
    );
  }

  if (buildResult && !buildResult.ok) {
    confidence -= 40;
    reasons.push(`-40 Build command failed (${describeFailure(buildResult)})`);
  }
  if (testResult && !testResult.ok) {
    confidence -= 40;
    reasons.push(`-40 Test command failed (${describeFailure(testResult)})`);
  }

  confidence = Math.max(0, Math.min(100, confidence));

  const hasHigh = findings.some((f) => (severityOverrides[f.rule] || f.severity) === "high");
  const buildOrTestFailed = (buildResult && !buildResult.ok) || (testResult && !testResult.ok);
  const status = hasHigh || buildOrTestFailed || confidence < 70 ? "REVIEW_REQUIRED" : "SAFE_TO_MERGE";

  // buildResult/testResult are null exactly when --build/--test weren't
  // passed (src/run.js only ever returns null for "not run", never for "ran
  // and produced no result") - so this is derivable from what's already
  // passed in, no new caller-supplied flag needed.
  const verified = Boolean(buildResult || testResult);

  return { confidence, status, reasons, verified };
}

module.exports = { score };

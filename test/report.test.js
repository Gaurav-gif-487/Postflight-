"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { render } = require("../src/report");
const { makeColorizer } = require("../src/color");

const noColor = makeColorizer(false);

function baseArgs(overrides = {}) {
  return {
    diffSummary: { files: 1, insertions: 5, deletions: 2 },
    findings: [],
    buildResult: null,
    testResult: null,
    scoreResult: { confidence: 100, status: "SAFE_TO_MERGE", verified: true },
    untestedFiles: [],
    ...overrides,
  };
}

test("report: renders diff summary and a safe verdict", () => {
  const out = render(baseArgs(), { color: noColor });
  assert.match(out, /Files changed\s+1/);
  assert.match(out, /\+5 \/ -2/);
  assert.match(out, /SAFE TO MERGE/);
});

test("report: renders build/test lines only when results are provided", () => {
  const withResults = render(baseArgs({ buildResult: { ok: true }, testResult: { ok: false, code: 1 } }), {
    color: noColor,
  });
  assert.match(withResults, /Build\s+✓ passed/);
  assert.match(withResults, /Tests\s+✗ FAILED \(exit 1\)/);

  const without = render(baseArgs(), { color: noColor });
  assert.doesNotMatch(without, /Build/);
  assert.doesNotMatch(without, /Tests/);
});

test("report: lists each finding with its rule id and file", () => {
  const out = render(
    baseArgs({
      findings: [
        { rule: "secret-aws-key", severity: "high", label: "Possible AWS access key", file: "src/x.js", snippet: "AKIA..." },
      ],
      scoreResult: { confidence: 75, status: "REVIEW_REQUIRED" },
    }),
    { color: noColor }
  );
  assert.match(out, /HIGH/);
  assert.match(out, /Possible AWS access key/);
  assert.match(out, /secret-aws-key/);
  assert.match(out, /src\/x\.js — AKIA\.\.\./);
  assert.match(out, /REVIEW REQUIRED/);
});

test("report: lists untested paths in their own section when present", () => {
  const out = render(baseArgs({ untestedFiles: ["src/a.js", "src/b.js"] }), { color: noColor });
  assert.match(out, /Untested paths\s+2/);
  assert.match(out, /UNTESTED PATHS/);
  assert.match(out, /src\/a\.js/);
  assert.match(out, /src\/b\.js/);
});

test("report: lists loosely-untested paths (weak signal) in their own, distinctly-labeled section", () => {
  const out = render(baseArgs({ looselyUntestedFiles: ["src/flask/sansio/scaffold.py"] }), { color: noColor });
  assert.match(out, /No test-convention match \(weak signal\)\s+1/);
  assert.match(out, /NO TEST-CONVENTION MATCH/);
  assert.match(out, /src\/flask\/sansio\/scaffold\.py/);
  // Must not appear in the strong-signal summary row.
  assert.doesNotMatch(out, /Untested paths\s+1/);
});

test("report: omits the untested-paths section entirely when there are none", () => {
  const out = render(baseArgs(), { color: noColor });
  assert.doesNotMatch(out, /UNTESTED PATHS/);
});

test("report: defaults to a resolved colorizer when none is passed", () => {
  // Should not throw even with no explicit color option.
  const out = render(baseArgs());
  assert.match(out, /SAFE TO MERGE/);
});

test("report: shows a finding's snippet even when it has no file (e.g. a behavior regression)", () => {
  const out = render(
    baseArgs({
      findings: [{ rule: "behavior-regression", severity: "high", label: "Test passed on base, now fails", file: null, snippet: "adds numbers" }],
    }),
    { color: noColor }
  );
  assert.match(out, /adds numbers/);
});

test("report: shows a behavior-diff regression count and skip note", () => {
  const withRegression = render(
    baseArgs({ behaviorDiff: { skipped: false, regressions: ["adds"], fixed: [] } }),
    { color: noColor }
  );
  assert.match(withRegression, /Behavior regressions\s+1/);

  const withSkip = render(
    baseArgs({ behaviorDiff: { skipped: true, reason: "unrecognized reporter format", regressions: [], fixed: [] } }),
    { color: noColor }
  );
  assert.match(withSkip, /Behavior diff\s+skipped/);
  assert.match(withSkip, /--diff-behavior skipped: unrecognized reporter format/);
});

test("report: notes newly-passing tests without penalizing them", () => {
  const out = render(
    baseArgs({ behaviorDiff: { skipped: false, regressions: [], fixed: ["adds", "subtracts"] } }),
    { color: noColor }
  );
  assert.match(out, /2 test\(s\) newly passing vs base \(not penalized\)/);
});

test("report: warns when the verdict reflects no --build/--test execution", () => {
  const out = render(
    baseArgs({ scoreResult: { confidence: 100, status: "SAFE_TO_MERGE", verified: false } }),
    { color: noColor }
  );
  assert.match(out, /no --build or --test was run - this reflects static checks only/);
});

test("report: omits the no-execution note once a build or test actually ran", () => {
  const out = render(baseArgs(), { color: noColor }); // verified: true from baseArgs
  assert.doesNotMatch(out, /this reflects static checks only/);
});

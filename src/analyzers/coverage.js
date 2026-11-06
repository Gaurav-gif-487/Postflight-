"use strict";

const fs = require("fs");
const path = require("path");
const coverage = require("../coverage");
const { changedLinesByFile } = require("../diffParse");
const { STATUS, STRENGTH, ORIGIN, METHOD } = require("../evidence");

// A coverage report is a snapshot from whenever it was last generated - if
// any changed file was edited more recently than that, the report may not
// reflect the lines actually being analyzed at all (previously only a
// prose caveat below; this makes it an active, cheap check instead, since
// the mtimes are already available for free from the same fs.statSync
// coverage.load() already did).
function newerThanReport(repoRoot, changedFiles, reportMtimeMs) {
  for (const file of changedFiles) {
    let stat;
    try {
      stat = fs.statSync(path.join(repoRoot, file));
    } catch {
      continue; // deleted file, etc. - nothing to compare
    }
    if (stat.mtimeMs > reportMtimeMs) return true;
  }
  return false;
}

// src/coverage.js is a parsing/matching library (discover a report, parse
// lcov/istanbul/cobertura/clover/jacoco, match repo-relative paths against
// report paths, compute changed-line coverage) with no opinion about when a
// number should become a finding - that opinion was meant to live in
// policy.js's `coverage: { required, minChangedLineCoverage }`, which
// is not used. This module supplies that opinion directly (not left to the
// generic adapter), following two decisions:
//
//   1. No coverage report at all is silent - coverage is opt-in, and most
//      repos won't have one. This also covers a report that exists but
//      can't be parsed (`coverage.load()` returns the same
//      `{ available: false }` shape for "not found" and "unreadable/
//      unparseable" - both are treated as "no usable coverage data here,"
//      not as something to flag).
//   2. When a report *is* usable: strict - any changed line this diff
//      introduces that the report shows as never executed is worth
//      surfacing. Files entirely absent from the coverage report (i.e.
//      genuinely unmeasured, not measured-and-zero) are excluded from the
//      count rather than treated as uncovered - "unmeasured" and
//      "uncovered" are different claims and only the second one is this
//      evidence record's job to make.
//
// Deliberately WARN, never FAIL: even the abandoned policy.js only ever
// listed "coverage" in `reviewOnCategories`, never `blockOnCategories`,
// across all three presets (default/strict/advisory) - a real signal
// worth a human look, never dispositive on its own.
function analyze({ base, repoRoot, parsedDiff = [], coveragePath }) {
  // coveragePath comes from --coverage <path> (src/cli.js). When absent,
  // coverage.load falls back to its own conventional-path auto-discovery
  // (src/coverage.js:discover) - both branches were already supported by
  // load()'s signature, so this is purely a matter of threading the CLI
  // flag through,.
  const report = coverage.load(repoRoot, coveragePath);
  if (!report.available) return { evidence: [] };

  const linesByFile = changedLinesByFile(parsedDiff);
  const result = coverage.changedLineCoverage(report, linesByFile);
  const stale = newerThanReport(repoRoot, Object.keys(linesByFile), report.mtimeMs);

  const uncoveredFiles = Object.entries(result.perFile)
    .filter(([, v]) => v.measured && v.executable > 0 && v.covered < v.executable)
    .map(([file, v]) => ({
      file,
      covered: v.covered,
      executable: v.executable,
      uncovered: v.executable - v.covered,
    }));

  const evidence = [];

  // Reported regardless of whether uncoveredFiles is empty: a report that
  // predates a changed file could just as easily be hiding uncovered lines
  // as showing a clean (but stale) picture - either way the number below
  // can't be trusted at face value, so this is worth flagging even when
  // changed-line coverage otherwise looks perfect.
  if (stale) {
    evidence.push({
      id: "coverage/stale-report",
      category: "coverage",
      status: STATUS.WARN,
      strength: STRENGTH.STRONG,
      origin: ORIGIN.UNKNOWN,
      summary: `The ${report.format} coverage report predates at least one changed file, so changed-line coverage may not reflect the current diff`,
      detail: `Report last generated at ${new Date(report.mtimeMs).toISOString()}; ${report.file} is older than the file(s) it's being compared against.`,
      locations: [],
      provenance: { method: METHOD.OBSERVED, source: `coverage report (${report.format})`, ref: base },
      confounders: ["Regenerate the coverage report against the current change before trusting this number."],
      data: { reportMtimeMs: report.mtimeMs },
    });
  }

  if (uncoveredFiles.length) {
    const totalUncovered = uncoveredFiles.reduce((n, f) => n + f.uncovered, 0);
    evidence.push({
      id: "coverage/changed-lines-uncovered",
      category: "coverage",
      status: STATUS.WARN,
      strength: STRENGTH.STRONG, // real coverage instrumentation, not a heuristic
      origin: ORIGIN.INTRODUCED,
      summary: `${totalUncovered} changed line(s) across ${uncoveredFiles.length} file(s) are not covered by the ${report.format} coverage report`,
      detail: uncoveredFiles.map((f) => `${f.file}: ${f.covered}/${f.executable} changed line(s) covered`).join(", "),
      locations: uncoveredFiles.map((f) => ({ file: f.file })),
      provenance: { method: METHOD.OBSERVED, source: `coverage report (${report.format})`, ref: base },
      confounders: [
        "Only lines this diff added are checked - pre-existing uncovered code elsewhere in the file is not counted.",
        stale
          ? "This coverage report predates at least one changed file - see the stale-report finding above."
          : "The coverage report reflects whenever it was last generated, which may predate the working tree's current state.",
        "Files absent from the coverage report are treated as unmeasured, not uncovered, and are excluded from this count.",
      ],
      data: { files: uncoveredFiles, ratio: result.ratio },
    });
  }

  return { evidence };
}

module.exports = { analyze };

"use strict";
const jsImportGraph = require("./jsImportGraph");
const dependencyChange = require("./dependencyChange");
const testIntegrity = require("./testIntegrity");
const sensitivePaths = require("./sensitivePaths");
const configChange = require("./configChange");
const blastRadius = require("./blastRadius");
const coverageAnalyzer = require("./coverage");
const { STATUS } = require("../evidence");

// Each analyzer receives { base, changedFiles, cwd, repoRoot, statuses,
// parsedDiff } and returns an array of findings shaped like src/checks.js
// findings. Analyzers must never throw past this boundary - a broken/slow
// analyzer should degrade to "no architecture findings," never crash the
// whole report. Not every analyzer uses every ctx field (see each module's
// own analyze() signature); ctx is a superset, unused fields are ignored.

// dependencyChange, testIntegrity (and the rest of the v2-WIP analyzers)
// speak a richer "evidence" schema (src/evidence.js:
// STATUS/STRENGTH/ORIGIN/METHOD) that nothing else in the running pipeline
// understands yet. Per the audit's recommended path, these
// are wired in one at a time, each adapted down to the v1 finding shape
// everything else already consumes, rather than pulling in the full
// unverified verdict/evidence/policy layer in one pass.
const STATUS_TO_SEVERITY = { FAIL: "high", WARN: "medium", PASS: "low", UNKNOWN: "low" };

// Generalized (not dependency-specific) id -> rule mapping: an evidence id
// is "<category-prefix>/<name>[@location]" (e.g. "dependency/added@package.json",
// "test-integrity/deleted-test-files"). The rule is "<prefix>-<name>" with
// any "@location" suffix stripped, e.g. "dependency-added",
// "test-integrity-deleted-test-files". This replaced an earlier version of
// this function that hardcoded a "dependency-" prefix, which only happened
// to work because dependency-change was the only analyzer wired in yet.
function evidenceToFinding(ev) {
  const [prefix, rest] = ev.id.split("/");
  const rule = `${prefix}-${(rest || prefix).split("@")[0]}`;
  const finding = {
    rule,
    severity: STATUS_TO_SEVERITY[ev.status] || "medium",
    category: ev.category || prefix,
    label: ev.summary,
    file: (ev.locations && ev.locations[0] && ev.locations[0].file) || null,
    snippet: ev.detail || null,
  };
  // Carry the richer evidence detail through as optional extra fields
  //. This is additive only - src/score.js and
  // src/report.js's text renderer only ever read the fixed v1 fields above
  // and are unaffected by extra keys being present; src/formats.js's SARIF
  // writer is the one consumer that looks for them (as a result-level
  // properties bag, which the SARIF 2.1.0 spec allows on any object).
  // Pattern-rule findings from checks.js never carry these - only
  // evidence-schema analyzers wired through here do.
  if (ev.confounders && ev.confounders.length) finding.confounders = ev.confounders;
  if (ev.provenance) finding.provenance = ev.provenance;
  if (ev.data) finding.data = ev.data;
  return finding;
}

function runDependencyChange(ctx) {
  return dependencyChange.analyze(ctx).evidence.map(evidenceToFinding);
}

function runTestIntegrity(ctx) {
  return testIntegrity.analyze(ctx).evidence.map(evidenceToFinding);
}

function runSensitivePaths(ctx) {
  return sensitivePaths.analyze(ctx).evidence.map(evidenceToFinding);
}

function runConfigChange(ctx) {
  return configChange.analyze(ctx).evidence.map(evidenceToFinding);
}

// blastRadius is the first wired-in analyzer whose "good" outcome is a
// PASS-status evidence record (a contained blast radius), not merely the
// absence of one - it always emits an "architecture/blast-radius" record
// for every JS-touching diff, WARN (wide) or PASS (contained). Letting
// PASS through the generic adapter would turn "this is fine" into a -3
// penalty (score.js's SEVERITY_PENALTY.low) and a report line on nearly
// every JS change, which is exactly the silent-noise failure mode this
// task flagged. Its UNKNOWN records ("blast-radius-unavailable" when
// `git ls-files` can't be read, "blast-radius-truncated" past the file
// cap) describe a limitation of the analysis itself, not a property of
// the diff - v1's finding shape has no "limitation" concept (that's what
// the unused v2 EvidenceLedger.addLimitation is for), so forcing them
// through as low-severity penalty findings would misrepresent an
// analysis gap as a code-quality signal. Decision: only WARN/FAIL
// evidence from this module becomes a v1 finding; PASS and UNKNOWN are
// computed (visible in --format json's raw evidence if ever exposed) but
// not surfaced as score-affecting findings.
function runBlastRadius(ctx) {
  return blastRadius
    .analyze(ctx)
    .evidence.filter((ev) => ev.status === STATUS.WARN || ev.status === STATUS.FAIL)
    .map(evidenceToFinding);
}

// coverage's analyze() only ever returns evidence when it decided there's something worth flagging - no report
// found, every changed line covered by a report that isn't stale, or a
// stale report with nothing else to add all resolve to `evidence: []`
// inside the module itself. No PASS/UNKNOWN filtering is needed here the
// way it is for blastRadius; there is nothing to filter.
function runCoverage(ctx) {
  return coverageAnalyzer.analyze(ctx).evidence.map(evidenceToFinding);
}

const ANALYZERS = [
  { name: "js-import-graph", run: jsImportGraph.analyze },
  { name: "dependency-change", run: runDependencyChange },
  { name: "test-integrity", run: runTestIntegrity },
  { name: "sensitive-paths", run: runSensitivePaths },
  { name: "config-change", run: runConfigChange },
  { name: "blast-radius", run: runBlastRadius },
  { name: "coverage", run: runCoverage },
];

// The six analyzers above that speak the evidence schema, paired with their
// raw (unconverted, unfiltered) analyze() function - used only by the
// opt-in --policy verdict engine (src/verdictRun.js). That engine needs the
// full PASS/WARN/FAIL/UNKNOWN picture (e.g. blastRadius's "contained" PASS
// record, coverage's silent-when-clean records), which evidenceToFinding
// and runBlastRadius's filtering deliberately don't surface as v1 findings
// - see the comment on runBlastRadius above for why. js-import-graph isn't
// included here: it never adopted the evidence schema, so its v1 findings
// go through checks.toEvidence's generic fallback instead (src/cli.js).
const EVIDENCE_ANALYZERS = [
  { name: "dependency-change", analyze: dependencyChange.analyze },
  { name: "test-integrity", analyze: testIntegrity.analyze },
  { name: "sensitive-paths", analyze: sensitivePaths.analyze },
  { name: "config-change", analyze: configChange.analyze },
  { name: "blast-radius", analyze: blastRadius.analyze },
  { name: "coverage", analyze: coverageAnalyzer.analyze },
];

// Never throws past this boundary, for the same reason runAnalyzers doesn't
// - a broken analyzer degrades to "no evidence from it," not a crashed run.
function collectEvidence(ctx) {
  const evidence = [];
  for (const a of EVIDENCE_ANALYZERS) {
    try {
      const result = a.analyze(ctx);
      if (result && Array.isArray(result.evidence)) evidence.push(...result.evidence);
    } catch (err) {
      if (process.env.POSTFLIGHT_DEBUG) {
        console.error(`postflight: analyzer "${a.name}" failed while collecting evidence:`, err.message);
      }
    }
  }
  return evidence;
}

function runAnalyzers(ctx, { enabled = true } = {}) {
  if (!enabled) return [];
  const findings = [];
  for (const analyzer of ANALYZERS) {
    try {
      findings.push(...analyzer.run(ctx));
    } catch (err) {
      // Silently degrade - architecture analysis is best-effort and must
      // never be the reason a build fails.
      if (process.env.POSTFLIGHT_DEBUG) {
        console.error(`postflight: analyzer "${analyzer.name}" failed:`, err.message);
      }
    }
  }
  return findings;
}

module.exports = { runAnalyzers, ANALYZERS, evidenceToFinding, collectEvidence, EVIDENCE_ANALYZERS };

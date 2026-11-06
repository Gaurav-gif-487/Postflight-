"use strict";
const { resolveColor } = require("./color");
const { describeFailure } = require("./run");

const W = 60;
const line = (ch = "─") => ch.repeat(W);
const pad = (label, value) => {
  const l = String(label);
  const v = String(value);
  const gap = Math.max(1, W - l.length - v.length - 2);
  return `  ${l}${" ".repeat(gap)}${v}`;
};

function render(
  { diffSummary, findings, buildResult, testResult, scoreResult, untestedFiles = [], looselyUntestedFiles = [], behaviorDiff = null },
  opts = {}
) {
  const c = opts.color || resolveColor();
  const out = [];
  out.push(line("━"));
  out.push(c.bold("        POSTFLIGHT REPORT"));
  out.push(line("━"));
  out.push(pad("Files changed", diffSummary.files));
  out.push(pad("Lines added / removed", `+${diffSummary.insertions} / -${diffSummary.deletions}`));
  if (buildResult) out.push(pad("Build", buildResult.ok ? c.green("✓ passed") : c.red(`✗ FAILED (${describeFailure(buildResult)})`)));
  if (testResult) out.push(pad("Tests", testResult.ok ? c.green("✓ passed") : c.red(`✗ FAILED (${describeFailure(testResult)})`)));
  if (behaviorDiff && !behaviorDiff.skipped) {
    out.push(
      pad(
        "Behavior regressions",
        behaviorDiff.regressions.length ? c.red(behaviorDiff.regressions.length) : behaviorDiff.regressions.length
      )
    );
  } else if (behaviorDiff && behaviorDiff.skipped) {
    out.push(pad("Behavior diff", c.gray("skipped")));
  }

  const bySeverity = { high: 0, medium: 0, low: 0 };
  for (const f of findings) bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
  out.push(pad("High-severity findings", bySeverity.high ? c.red(bySeverity.high) : bySeverity.high));
  out.push(pad("Medium-severity findings", bySeverity.medium ? c.yellow(bySeverity.medium) : bySeverity.medium));
  out.push(pad("Low-severity findings", bySeverity.low));
  if (untestedFiles.length) out.push(pad("Untested paths", untestedFiles.length));
  if (looselyUntestedFiles.length) out.push(pad("No test-convention match (weak signal)", looselyUntestedFiles.length));
  out.push("");
  const confColor = scoreResult.confidence >= 70 ? c.green : scoreResult.confidence >= 40 ? c.yellow : c.red;
  out.push(pad("Confidence", confColor(`${scoreResult.confidence}%`)));
  // Not a calibrated probability..."). It's
  // a rule-based penalty sum (src/score.js) and is presented as one here so
  // that isn't implied.
  out.push(c.gray("  (heuristic penalty score, not a calibrated probability)"));
  if (!scoreResult.verified) {
    // No --build/--test means nothing actually
    // ran to verify the change behaves - this confidence number reflects
    // static/pattern checks and analyzers only, not execution.
    out.push(c.yellow("  (no --build or --test was run - this reflects static checks only)"));
  }
  out.push("");

  if (behaviorDiff && behaviorDiff.skipped) {
    out.push(c.gray(`  --diff-behavior skipped: ${behaviorDiff.reason}`));
    out.push("");
  } else if (behaviorDiff && behaviorDiff.fixed.length) {
    out.push(c.gray(`  ${behaviorDiff.fixed.length} test(s) newly passing vs base (not penalized)`));
    out.push("");
  }

  if (findings.length) {
    out.push(line());
    out.push(c.bold("  FINDINGS"));
    out.push(line());
    for (const f of findings) {
      const sevColor = f.severity === "high" ? c.red : f.severity === "medium" ? c.yellow : c.gray;
      const sev = sevColor(f.severity.toUpperCase().padEnd(6));
      out.push(`  [${sev}] ${f.label}  ${c.gray(`(${f.rule})`)}`);
      if (f.file) out.push(`           ${f.file}${f.snippet ? ` — ${f.snippet}` : ""}`);
      else if (f.snippet) out.push(`           ${f.snippet}`);
    }
    out.push("");
  }

  if (untestedFiles.length) {
    out.push(line());
    out.push(c.bold("  UNTESTED PATHS (heuristic — not real coverage data)"));
    out.push(line());
    for (const f of untestedFiles) out.push(`  ${f}`);
    out.push("");
  }

  if (looselyUntestedFiles.length) {
    out.push(line());
    out.push(c.bold("  NO TEST-CONVENTION MATCH (weaker signal — other test file(s)"));
    out.push(c.bold("  changed in this diff, just not one matching these by name)"));
    out.push(line());
    for (const f of looselyUntestedFiles) out.push(`  ${f}`);
    out.push("");
  }

  out.push(line("━"));
  const safe = scoreResult.status === "SAFE_TO_MERGE";
  const verdict = safe ? c.green("✓ SAFE TO MERGE") : c.red("⚠ REVIEW REQUIRED");
  out.push(c.bold(`  STATUS: ${verdict}`));
  out.push(line("━"));

  return out.join("\n");
}

const VERDICT_COLOR_KEY = {
  SAFE_TO_MERGE: "green",
  INCONCLUSIVE: "yellow",
  REVIEW_REQUIRED: "yellow",
  BLOCK: "red",
};

// Renders the opt-in --policy verdict (src/verdictRun.js) as an additional
// block after the normal report. Kept separate from render() above rather
// than folded in, since it only ever runs when --policy was passed - the
// default report is unaffected either way.
function renderVerdict(result, opts = {}) {
  const c = opts.color || resolveColor();
  const out = [];
  out.push(line("━"));
  out.push(c.bold(`  POLICY VERDICT — ${result.policy}`));
  out.push(line("━"));
  const colorFn = c[VERDICT_COLOR_KEY[result.verdict]] || c.bold;
  out.push(`  ${c.bold(colorFn(result.verdict))}  ${c.gray(`(exit ${result.exitCode})`)}`);
  out.push("");

  const es = result.evidenceScore;
  out.push(pad("Observations", es.observations));
  out.push(pad("Passing / failing / warning / unknown", `${es.passing} / ${es.failing} / ${es.warning} / ${es.unknown}`));
  if (es.limitations) out.push(pad("Stated limitations", es.limitations));
  out.push("");

  if (result.reasons.length) {
    out.push(c.bold("  REASONS"));
    for (const r of result.reasons) {
      const label = r.verdict === "BLOCK" ? c.red(r.verdict) : r.verdict === "SAFE_TO_MERGE" ? c.green(r.verdict) : c.yellow(r.verdict);
      out.push(`  [${label}] ${r.text}`);
    }
    out.push("");
  }

  // "Stated limitations" above is just a count - even when verdict.js's
  // rule 6 promotes it into a REASONS line, that line is still just "N
  // stated limitation(s)", never the actual text. Without this, a reader
  // has no way to learn *why* (dirty tree? shallow clone? detached HEAD?)
  // short of switching to --format json.
  const limitations = (result.evidence && result.evidence.limitations) || [];
  if (limitations.length) {
    out.push(c.bold("  LIMITATIONS"));
    for (const l of limitations) if (l.summary) out.push(`  - ${l.summary}`);
    out.push("");
  }

  out.push(line("━"));
  return out.join("\n");
}

function renderRemediations(remediations, opts = {}) {
  const c = opts.color || resolveColor();
  const out = [];
  out.push(line());
  out.push(c.bold("  SUGGESTED FIXES (unverified - review before applying)"));
  out.push(line());
  for (const r of remediations) {
    out.push(`  [${c.gray(r.kind)}] ${r.summary}  ${c.gray(`(${r.provider} → ${r.evidenceId})`)}`);
    if (r.kind === "command" && r.commands) {
      for (const cmd of r.commands) out.push(`           $ ${cmd}`);
    }
    if (r.kind === "diff" && r.diff) {
      out.push(`           (diff omitted from text output - see --format json)`);
    }
  }
  out.push("");
  return out.join("\n");
}

module.exports = { render, renderVerdict, renderRemediations };

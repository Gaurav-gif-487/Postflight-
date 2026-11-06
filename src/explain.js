"use strict";
const fs = require("fs");
const { execFileSync } = require("child_process");
const git = require("./git");
const { scanDiff } = require("./checks");
const { runAnalyzers } = require("./analyzers");

// Explain-by-evidence-id: traces one evidence record from a previously
// written postflight-proof.json (see src/proof.js) back through
// finding -> evidence -> policy -> verdict, per the explainability
// requirement. This is a pure read of the proof file - it never
// re-executes anything, so it works offline and after the fact (e.g. a
// reviewer reading a CI artifact days later).
function explainEvidence({ proofPath, id }) {
  if (!fs.existsSync(proofPath)) {
    return {
      ok: false,
      error: `no proof file at ${proofPath} - run "postflight verify --proof" first, or pass --proof-file <path>`,
    };
  }
  let proof;
  try {
    proof = JSON.parse(fs.readFileSync(proofPath, "utf8"));
  } catch (err) {
    return { ok: false, error: `could not parse ${proofPath}: ${err.message}` };
  }
  const ev = (proof.evidence || []).find((e) => e.id === id);
  if (!ev) {
    return {
      ok: false,
      error: `no evidence with id "${id}" in ${proofPath}`,
      knownIds: (proof.evidence || []).map((e) => e.id),
    };
  }
  const reasons = ((proof.verdict && proof.verdict.reasons) || []).filter((r) => (r.evidence || []).includes(id));
  return {
    ok: true,
    evidence: ev,
    reasons,
    verdict: proof.verdict ? proof.verdict.value : null,
    policy: proof.policies ? proof.policies.name : null,
  };
}

function renderEvidenceExplain(result) {
  if (!result.ok) {
    let out = `postflight explain: ${result.error}\n`;
    if (result.knownIds && result.knownIds.length) {
      out += `known evidence ids: ${result.knownIds.join(", ")}\n`;
    }
    return out;
  }
  const { evidence: ev, reasons, verdict, policy } = result;
  const lines = [];
  lines.push(`WHY ${verdict || "(no verdict)"}`);
  lines.push("");
  lines.push(`${ev.id}`);
  lines.push(ev.summary);
  if (ev.detail) lines.push(ev.detail);
  lines.push("");
  lines.push("Evidence:");
  lines.push(`  status=${ev.status} strength=${ev.strength} origin=${ev.origin} category=${ev.category}`);
  if (ev.provenance) {
    lines.push(`  provenance: ${ev.provenance.method} via ${ev.provenance.source || "n/a"}`);
  }
  if (ev.locations && ev.locations.length) {
    lines.push(`  locations: ${ev.locations.map((l) => l.file || JSON.stringify(l)).join(", ")}`);
  }
  if (ev.confounders && ev.confounders.length) {
    lines.push(`  caveats: ${ev.confounders.join("; ")}`);
  }
  if (policy) lines.push(`\nPolicy: ${policy}`);
  if (reasons.length) {
    lines.push("\nVerdict reasoning citing this evidence:");
    for (const r of reasons) lines.push(`  [${r.verdict}] ${r.text}`);
  }
  return lines.join("\n") + "\n";
}

function run(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8" });
  } catch (err) {
    return err.stdout || "";
  }
}

// Finds the most recent commit that introduced a line matching `needle` in
// `file`, using git's pickaxe search (-S). This is a real git history
// search, not a guess - it only reports a commit if the string actually
// appears/disappears there.
function findIntroducingCommit(file, needle, cwd) {
  if (!needle) return null;
  const out = run(
    ["log", "--diff-filter=AM", "--pretty=format:%H|%an|%ad|%s", "--date=short", "-S", needle, "--", file],
    cwd
  );
  const first = out.split("\n").find(Boolean);
  if (!first) return null;
  const [hash, author, date, ...rest] = first.split("|");
  return { hash, author, date, message: rest.join("|") };
}

// Fallback for findings with no single-line snippet (e.g. architecture
// findings that span a whole cycle): just report the most recent commit
// that touched the file at all.
function findMostRecentCommit(file, cwd) {
  const out = run(["log", "-1", "--pretty=format:%H|%an|%ad|%s", "--date=short", "--", file], cwd);
  if (!out) return null;
  const [hash, author, date, ...rest] = out.split("|");
  return { hash, author, date, message: rest.join("|") };
}

// Given a rule id (and optionally a file), re-derives findings (regex
// checks + analyzer findings, same as "run") to relocate matches, then
// walks each one back to the commit that introduced it. Returns an array
// of { finding, commit } explanations.
function explain({ rule, file, base, cwd, repoRoot, changedFiles }) {
  const resolvedBase = git.resolveBase(base, cwd);
  const diffText = git.diffAll(resolvedBase, cwd);
  let all = scanDiff(diffText);
  if (repoRoot && changedFiles) {
    all = all.concat(runAnalyzers({ base: resolvedBase, changedFiles, cwd, repoRoot }));
  }
  const findings = all.filter((f) => f.rule === rule && (!file || f.file === file));

  if (findings.length === 0) {
    return { findings: [], explanations: [] };
  }

  const explanations = findings.map((f) => {
    // Two genuinely different claims were being rendered with identical
    // phrasing: "this commit is confirmed (via git's pickaxe search) to
    // have introduced this exact line" vs. "pickaxe found nothing - here's
    // just the most recent commit that touched the file at all" (e.g. the
    // change is still uncommitted, or the line was introduced by a large
    // rewrite pickaxe can't isolate). The second case is a much weaker
    // claim and must say so, not borrow the first case's label.
    let commit = null;
    let precise = false;
    if (f.file) {
      if (f.snippet) {
        commit = findIntroducingCommit(f.file, f.snippet, cwd);
        precise = Boolean(commit);
      }
      if (!commit) {
        commit = findMostRecentCommit(f.file, cwd);
        precise = false;
      }
    }
    return { finding: f, commit, precise };
  });

  return { findings, explanations };
}

function render({ explanations }) {
  if (explanations.length === 0) {
    return "postflight: no matching finding for that rule/file in the current diff.";
  }
  const lines = [];
  for (const { finding, commit, precise } of explanations) {
    lines.push(`Finding: ${finding.label}`);
    if (finding.file) lines.push(`  File:     ${finding.file}`);
    if (finding.snippet) lines.push(`  Line:     ${finding.snippet}`);
    if (commit && precise) {
      lines.push(`  Introduced by: ${commit.hash.slice(0, 10)}  ${commit.date}  ${commit.author}`);
      lines.push(`  Commit message: ${commit.message}`);
    } else if (commit) {
      lines.push(
        `  Introduced by: UNCONFIRMED - git history search found no commit that added this exact line (likely still uncommitted, or introduced by a large rewrite). Showing the most recent commit that touched this file instead:`
      );
      lines.push(`  Most recent commit: ${commit.hash.slice(0, 10)}  ${commit.date}  ${commit.author}`);
      lines.push(`  Commit message: ${commit.message}`);
    } else {
      lines.push("  Introduced by: (could not be traced to a single commit - likely uncommitted or a large rewrite)");
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

module.exports = { explain, render, explainEvidence, renderEvidenceExplain };

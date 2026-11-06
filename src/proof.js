"use strict";

// Builds postflight-proof.json: a stable, machine-readable record of one
// verification run, suitable for storage as a CI artifact. Every claim in
// it either came from the evidence ledger (already-attributed,
// already-provenanced) or from data postflight itself observed this run
// (git refs, file/line counts, tool version). Nothing here is invented.

const SCHEMA_VERSION = "1.0.0";

function buildProof({
  pkgVersion,
  repoUrl = null,
  cwd,
  base,
  headCommit,
  baseCommit,
  changedFiles = [],
  diffSummary = { files: 0, insertions: 0, deletions: 0 },
  buildResult = null,
  testResult = null,
  coverage = null,
  policyVerdict = null,
  taskResult = null,
  remediations = [],
  environment = {},
  performance = null,
  timestamp = new Date().toISOString(),
}) {
  const evidence = policyVerdict ? [...policyVerdict.evidence.evidence].sort((a, b) => (a.id < b.id ? -1 : 1)) : [];
  const limitations = policyVerdict ? policyVerdict.evidence.limitations : [];

  return {
    schemaVersion: SCHEMA_VERSION,
    toolVersion: pkgVersion,
    repository: repoUrl,
    commit: headCommit || null,
    baseCommit: baseCommit || base || null,
    timestamp,
    changedFiles,
    changedLines: {
      insertions: diffSummary.insertions || 0,
      deletions: diffSummary.deletions || 0,
    },
    tests: testResult
      ? {
          command: testResult.command,
          passed: !!testResult.ok,
          exitCode: testResult.code,
          durationMs: testResult.durationMs ?? null,
        }
      : null,
    coverage,
    analyzers: policyVerdict
      ? Array.from(new Set(evidence.map((e) => e.category))).sort()
      : [],
    evidence,
    findings: evidence.filter((e) => e.status === "FAIL" || e.status === "WARN"),
    task: taskResult,
    policies: policyVerdict ? { name: policyVerdict.policy } : null,
    limitations,
    remediations,
    performance,
    verdict: policyVerdict
      ? {
          value: policyVerdict.verdict,
          exitCode: policyVerdict.exitCode,
          reasons: policyVerdict.reasons,
          evidenceScore: policyVerdict.evidenceScore,
        }
      : null,
    environment: {
      node: process.version,
      platform: process.platform,
      ci: !!process.env.CI,
      ...environment,
    },
  };
}

module.exports = { SCHEMA_VERSION, buildProof };

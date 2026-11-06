"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { buildProof, SCHEMA_VERSION } = require("../src/proof");
const { EvidenceLedger, STATUS, STRENGTH, ORIGIN, METHOD } = require("../src/evidence");

function samplePolicyVerdict() {
  const ledger = new EvidenceLedger();
  ledger.add({
    id: "test/command-result",
    category: "test",
    status: STATUS.PASS,
    strength: STRENGTH.STRONG,
    origin: ORIGIN.INTRODUCED,
    summary: "Test command passed",
    provenance: { method: METHOD.OBSERVED, source: "test command" },
  });
  return {
    verdict: "SAFE_TO_MERGE",
    policy: "default",
    reasons: [{ verdict: "SAFE_TO_MERGE", text: "ok", evidence: [] }],
    evidenceScore: { pass: 1, fail: 0, warn: 0, unknown: 0 },
    exitCode: 0,
    evidence: ledger.toJSON(),
  };
}

test("buildProof: has the required top-level schema fields", () => {
  const proof = buildProof({
    pkgVersion: "1.2.0",
    base: "HEAD",
    headCommit: "abc123",
    baseCommit: "def456",
    changedFiles: ["a.js"],
    diffSummary: { files: 1, insertions: 2, deletions: 0 },
    policyVerdict: samplePolicyVerdict(),
  });
  assert.equal(proof.schemaVersion, SCHEMA_VERSION);
  assert.equal(proof.toolVersion, "1.2.0");
  assert.equal(proof.commit, "abc123");
  assert.equal(proof.baseCommit, "def456");
  assert.deepEqual(proof.changedFiles, ["a.js"]);
  assert.equal(proof.changedLines.insertions, 2);
  assert.ok(Array.isArray(proof.evidence));
  assert.equal(proof.evidence.length, 1);
  assert.equal(proof.verdict.value, "SAFE_TO_MERGE");
  assert.equal(proof.verdict.exitCode, 0);
  assert.ok(proof.environment.node);
});

test("buildProof: works with no policyVerdict at all (verdict/evidence are null/empty, never throws)", () => {
  const proof = buildProof({ pkgVersion: "1.2.0", changedFiles: [] });
  assert.equal(proof.verdict, null);
  assert.deepEqual(proof.evidence, []);
  assert.deepEqual(proof.analyzers, []);
});

test("buildProof: evidence is sorted by id for deterministic diffing across runs", () => {
  const ledger = new EvidenceLedger();
  ledger.add({
    id: "z/last",
    category: "test",
    status: STATUS.PASS,
    provenance: { method: METHOD.OBSERVED, source: "x" },
    summary: "z",
  });
  ledger.add({
    id: "a/first",
    category: "test",
    status: STATUS.PASS,
    provenance: { method: METHOD.OBSERVED, source: "x" },
    summary: "a",
  });
  const proof = buildProof({
    pkgVersion: "1.2.0",
    policyVerdict: { verdict: "SAFE_TO_MERGE", policy: "default", reasons: [], evidenceScore: {}, exitCode: 0, evidence: ledger.toJSON() },
  });
  assert.deepEqual(proof.evidence.map((e) => e.id), ["a/first", "z/last"]);
});

test("buildProof: findings are the FAIL/WARN subset of evidence", () => {
  const ledger = new EvidenceLedger();
  ledger.add({ id: "e1", category: "test", status: STATUS.PASS, provenance: { method: METHOD.OBSERVED, source: "x" }, summary: "ok" });
  ledger.add({ id: "e2", category: "test", status: STATUS.FAIL, provenance: { method: METHOD.OBSERVED, source: "x" }, summary: "bad" });
  const proof = buildProof({
    pkgVersion: "1.2.0",
    policyVerdict: { verdict: "BLOCK", policy: "default", reasons: [], evidenceScore: {}, exitCode: 3, evidence: ledger.toJSON() },
  });
  assert.equal(proof.findings.length, 1);
  assert.equal(proof.findings[0].id, "e2");
});

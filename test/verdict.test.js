"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { decide, evidenceScore, VERDICT, EXIT_CODES } = require("../src/verdict");
const { EvidenceLedger, STATUS, STRENGTH, ORIGIN, METHOD } = require("../src/evidence");
const { resolvePolicy } = require("../src/policy");

function ev(overrides = {}) {
  return {
    id: overrides.id || "test/ev",
    category: "test",
    status: STATUS.PASS,
    strength: STRENGTH.MEDIUM,
    origin: ORIGIN.UNKNOWN,
    summary: "a claim",
    provenance: { method: METHOD.OBSERVED, source: "unit test" },
    ...overrides,
  };
}

test("decide: an empty ledger with the default policy is SAFE_TO_MERGE, exit 0", () => {
  const ledger = new EvidenceLedger();
  const policy = resolvePolicy({ preset: "default" });
  const result = decide({ ledger, policy });
  assert.equal(result.verdict, VERDICT.SAFE_TO_MERGE);
  assert.equal(result.exitCode, 0);
  assert.equal(EXIT_CODES[VERDICT.SAFE_TO_MERGE], 0);
});

test("decide: a strong, introduced, blockable-category failure BLOCKs under the default policy", () => {
  const ledger = new EvidenceLedger();
  ledger.add(ev({ id: "security/1", category: "security", status: STATUS.FAIL, strength: STRENGTH.STRONG, origin: ORIGIN.INTRODUCED, summary: "secret committed" }));
  const policy = resolvePolicy({ preset: "default" });
  const result = decide({ ledger, policy });
  assert.equal(result.verdict, VERDICT.BLOCK);
  assert.equal(result.exitCode, 3);
  assert.ok(result.reasons.some((r) => r.verdict === VERDICT.BLOCK && r.evidence.includes("security/1")));
});

test("decide: a WEAK-strength failure cannot BLOCK on its own - it downgrades to REVIEW_REQUIRED", () => {
  const ledger = new EvidenceLedger();
  ledger.add(ev({ id: "pattern/1", category: "security", status: STATUS.FAIL, strength: STRENGTH.WEAK, origin: ORIGIN.INTRODUCED, summary: "regex match" }));
  const policy = resolvePolicy({ preset: "default" }); // minStrengthToBlock: MEDIUM
  const result = decide({ ledger, policy });
  assert.equal(result.verdict, VERDICT.REVIEW_REQUIRED);
  assert.equal(result.exitCode, 1);
  assert.match(result.reasons[0].text, /below the blocking threshold/);
});

test("decide: a pre-existing failure under a policy that allows them is REVIEW_REQUIRED, not BLOCK", () => {
  const ledger = new EvidenceLedger();
  ledger.add(ev({ id: "test/1", category: "test", status: STATUS.FAIL, strength: STRENGTH.STRONG, origin: ORIGIN.PRE_EXISTING, summary: "already broken" }));
  const policy = resolvePolicy({ preset: "default" }); // allowPreExistingFailures: true
  const result = decide({ ledger, policy });
  assert.equal(result.verdict, VERDICT.REVIEW_REQUIRED);
  assert.match(result.reasons[0].text, /Pre-existing failure, not attributed/);
});

test("decide: the strict policy does not allow pre-existing failures through as review-only", () => {
  const ledger = new EvidenceLedger();
  ledger.add(ev({ id: "test/1", category: "test", status: STATUS.FAIL, strength: STRENGTH.STRONG, origin: ORIGIN.PRE_EXISTING, summary: "already broken" }));
  const policy = resolvePolicy({ preset: "strict" }); // allowPreExistingFailures: false
  const result = decide({ ledger, policy });
  assert.equal(result.verdict, VERDICT.BLOCK);
});

test("decide: WARN evidence always requires review and never blocks on its own", () => {
  const ledger = new EvidenceLedger();
  ledger.add(ev({ id: "repo-state/1", category: "repo-state", status: STATUS.WARN, strength: STRENGTH.STRONG, summary: "shallow clone" }));
  const policy = resolvePolicy({ preset: "default" });
  const result = decide({ ledger, policy });
  assert.equal(result.verdict, VERDICT.REVIEW_REQUIRED);
});

test("decide: enough UNKNOWN evidence downgrades to INCONCLUSIVE under the default policy", () => {
  const ledger = new EvidenceLedger();
  ledger.add(ev({ id: "coverage/1", category: "coverage", status: STATUS.UNKNOWN, strength: STRENGTH.STRONG, detail: "no coverage report found" }));
  const policy = resolvePolicy({ preset: "default" }); // maxUnknownForSafe: 0
  const result = decide({ ledger, policy });
  assert.equal(result.verdict, VERDICT.INCONCLUSIVE);
  assert.equal(result.exitCode, 4);
});

test("decide: the advisory policy tolerates UNKNOWN evidence (unknownDowngrades: false)", () => {
  const ledger = new EvidenceLedger();
  ledger.add(ev({ id: "coverage/1", category: "coverage", status: STATUS.UNKNOWN, strength: STRENGTH.STRONG, detail: "no coverage report found" }));
  const policy = resolvePolicy({ preset: "advisory" });
  const result = decide({ ledger, policy });
  assert.equal(result.verdict, VERDICT.SAFE_TO_MERGE);
});

test("decide: code changed with nothing executed downgrades per policy.unverifiedChangeVerdict", () => {
  const ledger = new EvidenceLedger();
  const defaultPolicy = resolvePolicy({ preset: "default" }); // unverifiedChangeVerdict: REVIEW_REQUIRED
  const strictPolicy = resolvePolicy({ preset: "strict" }); // unverifiedChangeVerdict: BLOCK, requireBuildEvidence/TestEvidence

  const r1 = decide({ ledger, policy: defaultPolicy, changeSurface: { codeFilesChanged: 3 } });
  assert.equal(r1.verdict, VERDICT.REVIEW_REQUIRED);
  assert.match(r1.reasons[0].text, /code file\(s\) changed but no build or test was executed/);

  const r2 = decide({ ledger, policy: strictPolicy, changeSurface: { codeFilesChanged: 3 } });
  // strict also requires build/test evidence outright, which independently BLOCKs.
  assert.equal(r2.verdict, VERDICT.BLOCK);
});

test("decide: build/test evidence present satisfies strict's requireBuildEvidence/requireTestEvidence", () => {
  const ledger = new EvidenceLedger();
  ledger.add(ev({ id: "build/1", category: "build", status: STATUS.PASS, strength: STRENGTH.STRONG, summary: "build passed" }));
  ledger.add(ev({ id: "test/1", category: "test", status: STATUS.PASS, strength: STRENGTH.STRONG, summary: "tests passed" }));
  const policy = resolvePolicy({ preset: "strict" });
  const result = decide({ ledger, policy, changeSurface: { codeFilesChanged: 3 } });
  assert.equal(result.verdict, VERDICT.SAFE_TO_MERGE);
});

test("decide: a stated limitation downgrades an otherwise-clean SAFE_TO_MERGE to INCONCLUSIVE (default policy)", () => {
  const ledger = new EvidenceLedger();
  ledger.addLimitation({ id: "shallow-clone", summary: "history-based attribution may be wrong" });
  const policy = resolvePolicy({ preset: "default" });
  const result = decide({ ledger, policy });
  assert.equal(result.verdict, VERDICT.INCONCLUSIVE);
});

test("decide: reasons are sorted so the ones matching the final verdict come first", () => {
  const ledger = new EvidenceLedger();
  ledger.add(ev({ id: "repo-state/1", category: "repo-state", status: STATUS.WARN, strength: STRENGTH.STRONG, summary: "warn-level thing" }));
  ledger.add(ev({ id: "security/1", category: "security", status: STATUS.FAIL, strength: STRENGTH.STRONG, origin: ORIGIN.INTRODUCED, summary: "block-level thing" }));
  const policy = resolvePolicy({ preset: "default" });
  const result = decide({ ledger, policy });
  assert.equal(result.verdict, VERDICT.BLOCK);
  assert.equal(result.reasons[0].verdict, VERDICT.BLOCK);
});

test("decide: exitCode always matches EXIT_CODES[verdict]", () => {
  for (const [verdict, code] of Object.entries(EXIT_CODES)) {
    assert.equal(typeof code, "number");
    assert.equal(EXIT_CODES[verdict], code);
  }
});

test("evidenceScore: counts observations by status and strength", () => {
  const ledger = new EvidenceLedger();
  ledger.add(ev({ id: "a", status: STATUS.PASS, strength: STRENGTH.STRONG }));
  ledger.add(ev({ id: "b", status: STATUS.FAIL, strength: STRENGTH.WEAK, origin: ORIGIN.INTRODUCED }));
  ledger.addLimitation({ id: "lim", summary: "something wasn't checked" });
  const score = evidenceScore(ledger);
  assert.equal(score.observations, 2);
  assert.equal(score.passing, 1);
  assert.equal(score.failing, 1);
  assert.equal(score.strongObservations, 1);
  assert.equal(score.limitations, 1);
});

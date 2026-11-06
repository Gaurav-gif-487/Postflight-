"use strict";

const { STATUS, ORIGIN, STRENGTH_RANK } = require("./evidence");

// Four verdicts, each with a distinct operational meaning:
//
//   BLOCK             - observed, attributable, policy-relevant failure
//   REVIEW_REQUIRED   - real signal that needs a human, not a machine, call
//   INCONCLUSIVE      - postflight could not gather enough evidence to judge
//   SAFE_TO_MERGE     - the checks the policy demands ran and passed
//
// INCONCLUSIVE is the verdict v1.1 lacked, and its absence was the single
// biggest source of false trust: "no findings" was reported as 100%
// confidence even when nothing had actually been executed.

const VERDICT = Object.freeze({
  BLOCK: "BLOCK",
  REVIEW_REQUIRED: "REVIEW_REQUIRED",
  INCONCLUSIVE: "INCONCLUSIVE",
  SAFE_TO_MERGE: "SAFE_TO_MERGE",
});

const SEVERITY_ORDER = [VERDICT.SAFE_TO_MERGE, VERDICT.INCONCLUSIVE, VERDICT.REVIEW_REQUIRED, VERDICT.BLOCK];

const EXIT_CODES = Object.freeze({
  SAFE_TO_MERGE: 0,
  REVIEW_REQUIRED: 1,
  BLOCK: 3,
  INCONCLUSIVE: 4,
});

function worse(a, b) {
  return SEVERITY_ORDER.indexOf(a) >= SEVERITY_ORDER.indexOf(b) ? a : b;
}

function reason(verdict, text, evidenceIds) {
  return { verdict, text, evidence: evidenceIds };
}

function canBlock(ev, policy) {
  return STRENGTH_RANK[ev.strength] >= STRENGTH_RANK[policy.minStrengthToBlock];
}

/**
 * Deterministic, rule-based verdict. Every reason cites the evidence ids it
 * rests on, so a reader can audit the decision without re-running anything.
 *
 * @param {object} args
 * @param {import('./evidence').EvidenceLedger} args.ledger
 * @param {object} args.policy resolved policy
 * @param {object} [args.changeSurface] { codeFilesChanged, testFilesChanged }
 */
function decide({ ledger, policy, changeSurface = {} }) {
  const reasons = [];
  let verdict = VERDICT.SAFE_TO_MERGE;

  const relevant = (categories, ev) => categories.includes(ev.category);

  // 1. Observed, introduced failures.
  for (const ev of ledger.byStatus(STATUS.FAIL)) {
    const preExisting = ev.origin === ORIGIN.PRE_EXISTING;
    if (preExisting && policy.allowPreExistingFailures) {
      reasons.push(
        reason(
          VERDICT.REVIEW_REQUIRED,
          `Pre-existing failure, not attributed to this change: ${ev.summary}`,
          [ev.id]
        )
      );
      verdict = worse(verdict, VERDICT.REVIEW_REQUIRED);
      continue;
    }

    const blockable =
      policy.blockOnIntroducedFailure && relevant(policy.blockOnCategories, ev) && canBlock(ev, policy);

    if (blockable) {
      verdict = worse(verdict, VERDICT.BLOCK);
      reasons.push(reason(VERDICT.BLOCK, ev.summary, [ev.id]));
    } else {
      verdict = worse(verdict, VERDICT.REVIEW_REQUIRED);
      const why = !canBlock(ev, policy)
        ? `${ev.summary} (evidence strength ${ev.strength} is below the blocking threshold ${policy.minStrengthToBlock})`
        : ev.summary;
      reasons.push(reason(VERDICT.REVIEW_REQUIRED, why, [ev.id]));
    }
  }

  // 2. Warnings always require a human, never block on their own.
  for (const ev of ledger.byStatus(STATUS.WARN)) {
    if (ev.origin === ORIGIN.PRE_EXISTING && policy.allowPreExistingFailures) continue;
    verdict = worse(verdict, VERDICT.REVIEW_REQUIRED);
    reasons.push(reason(VERDICT.REVIEW_REQUIRED, ev.summary, [ev.id]));
  }

  // 3. Missing observations. Absence of evidence is not evidence of safety.
  const unknowns = ledger.byStatus(STATUS.UNKNOWN);
  if (policy.unknownDowngrades && unknowns.length > policy.maxUnknownForSafe) {
    verdict = worse(verdict, VERDICT.INCONCLUSIVE);
    reasons.push(
      reason(
        VERDICT.INCONCLUSIVE,
        `${unknowns.length} check(s) could not be performed, so this change is unverified rather than verified-safe`,
        unknowns.map((e) => e.id)
      )
    );
  }

  // 4. Policy-mandated evidence that never arrived.
  const hasPassing = (category) => ledger.byCategory(category).some((e) => e.status === STATUS.PASS);
  if (policy.requireBuildEvidence && !hasPassing("build")) {
    verdict = worse(verdict, VERDICT.BLOCK);
    reasons.push(reason(VERDICT.BLOCK, "Policy requires a passing build, and none was observed", []));
  }
  if (policy.requireTestEvidence && !hasPassing("test")) {
    verdict = worse(verdict, VERDICT.BLOCK);
    reasons.push(reason(VERDICT.BLOCK, "Policy requires executed test evidence, and none was observed", []));
  }

  // 5. Code changed but nothing executed it.
  const touchedCode = (changeSurface.codeFilesChanged || 0) > 0;
  const executed = hasPassing("test") || hasPassing("build");
  if (touchedCode && !executed && verdict !== VERDICT.BLOCK) {
    const target = policy.unverifiedChangeVerdict;
    verdict = worse(verdict, target);
    reasons.push(
      reason(
        target,
        `${changeSurface.codeFilesChanged} code file(s) changed but no build or test was executed against them`,
        []
      )
    );
  }

  // 6. Stated limitations keep SAFE_TO_MERGE honest.
  if (verdict === VERDICT.SAFE_TO_MERGE && ledger.limitations.length && policy.unknownDowngrades) {
    verdict = VERDICT.INCONCLUSIVE;
    reasons.push(
      reason(
        VERDICT.INCONCLUSIVE,
        `Verification was incomplete: ${ledger.limitations.length} stated limitation(s)`,
        []
      )
    );
  }

  if (!reasons.length) {
    reasons.push(reason(VERDICT.SAFE_TO_MERGE, "Every check the policy requires was executed and passed", []));
  }

  return {
    verdict,
    policy: policy.name,
    reasons: reasons.filter((r) => r.verdict === verdict).concat(reasons.filter((r) => r.verdict !== verdict)),
    evidenceScore: evidenceScore(ledger),
    exitCode: EXIT_CODES[verdict],
  };
}

// NOT a probability and never rendered as a percentage. It is a census of
// what postflight actually observed, so a reader can see coverage of the
// verification itself rather than a fabricated confidence number.
function evidenceScore(ledger) {
  const counts = ledger.counts();
  const strong = ledger.all.filter((e) => e.strength === "STRONG").length;
  return {
    observations: ledger.all.length,
    passing: counts.PASS,
    failing: counts.FAIL,
    warning: counts.WARN,
    unknown: counts.UNKNOWN,
    strongObservations: strong,
    limitations: ledger.limitations.length,
  };
}

module.exports = { decide, evidenceScore, VERDICT, EXIT_CODES, worse };

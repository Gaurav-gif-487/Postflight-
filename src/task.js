"use strict";

// Task verification checks a stated task's requirements against what this
// run actually observed - never against filenames alone, and never
// against superficial text matching alone. It is deliberately
// conservative: SATISFIED is only ever returned when a requirement is
// backed by strong, attributable evidence already in the ledger (an
// executed test that passed and is attributed to this change). A textual
// match in the diff is, at most, a weak signal - it downgrades an
// otherwise-unsupported requirement to INCONCLUSIVE instead of leaving it
// completely unaddressed, but it can never promote a requirement to
// SATISFIED on its own.

const TASK_STATUS = Object.freeze({
  SATISFIED: "SATISFIED",
  UNSATISFIED: "UNSATISFIED",
  INCONCLUSIVE: "INCONCLUSIVE",
});

const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "be", "to", "of", "and", "or", "for", "on",
  "in", "with", "that", "this", "should", "must", "when", "if", "it", "its",
  "exists", "exist", "handled", "correctly", "properly", "not",
]);

function keywords(text) {
  return Array.from(
    new Set(
      String(text)
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    )
  );
}

// Only the added side of the diff counts - a requirement satisfied by code
// that already existed before this change isn't something *this* change
// can take credit for, and isn't what "verify the completed change" means.
function addedLines(diffText) {
  return String(diffText || "")
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1).toLowerCase());
}

function textualMatch(requirement, addedLinesLower) {
  const words = keywords(requirement);
  if (!words.length) return { matched: false, hits: [] };
  const hits = words.filter((w) => addedLinesLower.some((l) => l.includes(w)));
  // Require a majority of the requirement's significant words to show up
  // somewhere in the added lines before calling it a "match" at all - a
  // single shared word (e.g. "test") is noise, not signal.
  const matched = words.length > 0 && hits.length / words.length >= 0.6;
  return { matched, hits, words };
}

// A requirement mentioning tests/regressions can be tied to real evidence:
// executed, passing, INTRODUCED-origin test evidence in the ledger.
function testEvidenceFor(ledgerEvidence) {
  return (ledgerEvidence || []).filter(
    (e) => e.category === "test" && e.status === "PASS" && e.origin === "INTRODUCED"
  );
}

// The one negative signal postflight can stand behind without fabricating
// anything: executed, INTRODUCED-origin test evidence that actually FAILED.
// This is not "no evidence was found" (that stays INCONCLUSIVE) - it's "this
// change was checked, and the check came back negative," which is exactly
// what docs/task-verification.md reserves UNSATISFIED for.
function failingTestEvidenceFor(ledgerEvidence) {
  return (ledgerEvidence || []).filter(
    (e) => e.category === "test" && e.status === "FAIL" && e.origin === "INTRODUCED"
  );
}

function mentionsTests(requirement) {
  return /\b(test|tests|tested|regression|regressions)\b/i.test(requirement);
}

/**
 * @param {object} args
 * @param {string} args.task free-text task description
 * @param {string[]} [args.requirements] explicit requirement strings
 * @param {string} args.diffText the full unified diff for this change
 * @param {object[]} [args.ledgerEvidence] this run's evidence (ledger.toJSON().evidence)
 */
function verifyTask({ task, requirements = [], diffText = "", ledgerEvidence = [] }) {
  const lines = addedLines(diffText);
  const testEvidence = testEvidenceFor(ledgerEvidence);
  const failingTestEvidence = failingTestEvidenceFor(ledgerEvidence);

  const results = requirements.map((requirement, idx) => {
    const id = `T-${String(idx + 1).padStart(3, "0")}`;
    const { matched, hits } = textualMatch(requirement, lines);

    if (mentionsTests(requirement) && testEvidence.length) {
      return {
        id,
        requirement,
        status: TASK_STATUS.SATISFIED,
        evidence: testEvidence.map((e) => e.id),
        detail: "Executed, passing test evidence attributed to this change was found.",
      };
    }

    // Only fires when a test/regression requirement was actually checked and
    // that check came back negative - a passing-but-unrelated test elsewhere
    // in the ledger never triggers this, since failingTestEvidenceFor already
    // filters to INTRODUCED-origin failures.
    if (mentionsTests(requirement) && failingTestEvidence.length) {
      return {
        id,
        requirement,
        status: TASK_STATUS.UNSATISFIED,
        evidence: failingTestEvidence.map((e) => e.id),
        detail: `Test evidence attributed to this change failed (${failingTestEvidence
          .map((e) => e.summary || e.id)
          .join(", ")}), which directly contradicts this requirement.`,
      };
    }

    if (matched) {
      return {
        id,
        requirement,
        status: TASK_STATUS.INCONCLUSIVE,
        evidence: [],
        detail: `Related terms appear in the diff (${hits.slice(0, 5).join(", ")}), but postflight does not execute or semantically verify code, so this is not treated as satisfied.`,
      };
    }

    return {
      id,
      requirement,
      status: TASK_STATUS.INCONCLUSIVE,
      evidence: [],
      detail: "No direct evidence for this requirement was found in the change. Manual review recommended.",
    };
  });

  const counts = results.reduce(
    (acc, r) => {
      acc[r.status] = (acc[r.status] || 0) + 1;
      return acc;
    },
    { SATISFIED: 0, UNSATISFIED: 0, INCONCLUSIVE: 0 }
  );

  return { task: task || null, requirements: results, counts };
}

module.exports = { TASK_STATUS, verifyTask, keywords };

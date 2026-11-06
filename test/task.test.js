"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { verifyTask, TASK_STATUS } = require("../src/task");

test("verifyTask: a requirement with matching added-diff keywords is INCONCLUSIVE, never SATISFIED from text alone", () => {
  const diffText = "+function oauthCallback(req, res) {\n+  req.session.user = req.user;\n+}\n";
  const result = verifyTask({
    task: "Implement OAuth login",
    requirements: ["OAuth callback exists"],
    diffText,
    ledgerEvidence: [],
  });
  assert.equal(result.requirements[0].status, TASK_STATUS.INCONCLUSIVE);
  assert.match(result.requirements[0].detail, /not treated as satisfied/);
});

test("verifyTask: a requirement with no textual signal at all is still INCONCLUSIVE, not UNSATISFIED", () => {
  const result = verifyTask({
    task: "x",
    requirements: ["rate limiting is enforced on the login endpoint"],
    diffText: "+console.log('hi')\n",
    ledgerEvidence: [],
  });
  assert.equal(result.requirements[0].status, TASK_STATUS.INCONCLUSIVE);
  assert.equal(result.requirements[0].status, "INCONCLUSIVE");
  assert.notEqual(result.requirements[0].status, TASK_STATUS.UNSATISFIED);
});

test("verifyTask: a test-mentioning requirement backed by real INTRODUCED/PASS test evidence is SATISFIED", () => {
  const ledgerEvidence = [
    {
      id: "test/command-result",
      category: "test",
      status: "PASS",
      origin: "INTRODUCED",
      summary: "Test command passed",
    },
  ];
  const result = verifyTask({
    task: "x",
    requirements: ["regression tests exist"],
    diffText: "",
    ledgerEvidence,
  });
  assert.equal(result.requirements[0].status, TASK_STATUS.SATISFIED);
  assert.deepEqual(result.requirements[0].evidence, ["test/command-result"]);
});

test("verifyTask: a test-mentioning requirement with no attributable test evidence stays INCONCLUSIVE", () => {
  const result = verifyTask({
    task: "x",
    requirements: ["regression tests exist"],
    diffText: "",
    ledgerEvidence: [{ id: "t1", category: "test", status: "PASS", origin: "UNKNOWN" }],
  });
  assert.equal(result.requirements[0].status, TASK_STATUS.INCONCLUSIVE);
});

test("verifyTask: counts tally correctly across requirements", () => {
  const ledgerEvidence = [{ id: "test/command-result", category: "test", status: "PASS", origin: "INTRODUCED" }];
  const result = verifyTask({
    requirements: ["regression tests exist", "something unrelated entirely"],
    diffText: "",
    ledgerEvidence,
  });
  assert.equal(result.counts.SATISFIED, 1);
  assert.equal(result.counts.INCONCLUSIVE, 1);
});

test("verifyTask: a test-mentioning requirement with a real INTRODUCED/FAIL test is UNSATISFIED", () => {
  const ledgerEvidence = [
    {
      id: "test/command-result",
      category: "test",
      status: "FAIL",
      origin: "INTRODUCED",
      summary: "Test command failed (exit 1)",
    },
  ];
  const result = verifyTask({
    task: "x",
    requirements: ["regression tests pass"],
    diffText: "",
    ledgerEvidence,
  });
  assert.equal(result.requirements[0].status, TASK_STATUS.UNSATISFIED);
  assert.deepEqual(result.requirements[0].evidence, ["test/command-result"]);
  assert.match(result.requirements[0].detail, /failed/);
});

test("verifyTask: a FAIL test that is PRE_EXISTING (not INTRODUCED) never triggers UNSATISFIED", () => {
  const ledgerEvidence = [
    { id: "test/command-result", category: "test", status: "FAIL", origin: "PRE_EXISTING", summary: "pre-existing failure" },
  ];
  const result = verifyTask({
    task: "x",
    requirements: ["regression tests pass"],
    diffText: "",
    ledgerEvidence,
  });
  assert.equal(result.requirements[0].status, TASK_STATUS.INCONCLUSIVE);
});

test("verifyTask: a FAIL test on an unrelated (non-test-mentioning) requirement does not make it UNSATISFIED", () => {
  const ledgerEvidence = [
    { id: "test/command-result", category: "test", status: "FAIL", origin: "INTRODUCED", summary: "failed" },
  ];
  const result = verifyTask({
    task: "x",
    requirements: ["the login button is blue"],
    diffText: "",
    ledgerEvidence,
  });
  assert.equal(result.requirements[0].status, TASK_STATUS.INCONCLUSIVE);
});

test("verifyTask: counts tally UNSATISFIED correctly", () => {
  const ledgerEvidence = [
    { id: "test/command-result", category: "test", status: "FAIL", origin: "INTRODUCED", summary: "failed" },
  ];
  const result = verifyTask({
    requirements: ["regression tests pass", "something unrelated entirely"],
    diffText: "",
    ledgerEvidence,
  });
  assert.equal(result.counts.UNSATISFIED, 1);
  assert.equal(result.counts.INCONCLUSIVE, 1);
});

test("verifyTask: no requirements produces an empty result without throwing", () => {
  const result = verifyTask({ task: "just a description", diffText: "", ledgerEvidence: [] });
  assert.deepEqual(result.requirements, []);
  assert.equal(result.task, "just a description");
});

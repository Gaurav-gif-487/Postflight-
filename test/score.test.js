"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { score } = require("../src/score");

test("score: clean diff, no build/test given -> 100% SAFE_TO_MERGE", () => {
  const r = score({ findings: [] });
  assert.equal(r.confidence, 100);
  assert.equal(r.status, "SAFE_TO_MERGE");
});

test("score: a single high-severity finding forces REVIEW_REQUIRED", () => {
  const r = score({ findings: [{ rule: "x", severity: "high", label: "bad" }] });
  assert.equal(r.status, "REVIEW_REQUIRED");
  assert.equal(r.confidence, 75);
});

test("score: only low-severity findings can still be SAFE_TO_MERGE", () => {
  const r = score({ findings: [{ rule: "todo-added", severity: "low", label: "todo" }] });
  assert.equal(r.status, "SAFE_TO_MERGE");
  assert.equal(r.confidence, 97);
});

test("score: failing build forces REVIEW_REQUIRED even with zero findings", () => {
  const r = score({ findings: [], buildResult: { ok: false, code: 1 } });
  assert.equal(r.status, "REVIEW_REQUIRED");
  assert.equal(r.confidence, 60);
});

test("score: failing tests forces REVIEW_REQUIRED", () => {
  const r = score({ findings: [], testResult: { ok: false, code: 1 } });
  assert.equal(r.status, "REVIEW_REQUIRED");
});

test("score: confidence never goes below 0", () => {
  const findings = Array.from({ length: 10 }, () => ({ rule: "x", severity: "high", label: "bad" }));
  const r = score({ findings, buildResult: { ok: false, code: 1 }, testResult: { ok: false, code: 1 } });
  assert.equal(r.confidence, 0);
});

test("score: untested files apply a capped penalty", () => {
  const many = Array.from({ length: 50 }, (_, i) => `src/f${i}.js`);
  const r = score({ findings: [], untestedFiles: many });
  assert.equal(r.confidence, 80); // 100 - cap of 20
});

test("score: loosely-untested files (weak signal) apply a smaller capped penalty", () => {
  const many = Array.from({ length: 50 }, (_, i) => `src/f${i}.js`);
  const r = score({ findings: [], looselyUntestedFiles: many });
  assert.equal(r.confidence, 92); // 100 - cap of 8, distinctly smaller than the strong-signal cap of 20
  assert.ok(r.reasons.some((reason) => reason.includes("weaker signal")));
});

test("score: strong and weak untested penalties stack independently", () => {
  const r = score({ findings: [], untestedFiles: ["a.js"], looselyUntestedFiles: ["b.js"] });
  assert.equal(r.confidence, 95); // 100 - 4 (strong, 1 file) - 1 (weak, 1 file)
});

test("score: severityOverrides changes both penalty and status", () => {
  const findings = [{ rule: "todo-added", severity: "low", label: "todo" }];
  const r = score({ findings, severityOverrides: { "todo-added": "high" } });
  assert.equal(r.status, "REVIEW_REQUIRED");
  assert.equal(r.confidence, 75);
});

test("score: verified is false when neither build nor test was run", () => {
  const r = score({ findings: [] });
  assert.equal(r.verified, false);
  // Narrow fix.
  assert.equal(r.confidence, 100);
  assert.equal(r.status, "SAFE_TO_MERGE");
});

test("score: verified is true when only --build was run", () => {
  const r = score({ findings: [], buildResult: { ok: true, code: 0 } });
  assert.equal(r.verified, true);
});

test("score: verified is true when only --test was run", () => {
  const r = score({ findings: [], testResult: { ok: true, code: 0 } });
  assert.equal(r.verified, true);
});

test("score: verified is true when both build and test were run", () => {
  const r = score({ findings: [], buildResult: { ok: true, code: 0 }, testResult: { ok: true, code: 0 } });
  assert.equal(r.verified, true);
});

test("score: verified is false even when findings/analyzers ran, absent build/test", () => {
  const r = score({ findings: [{ rule: "todo-added", severity: "low", label: "todo" }] });
  assert.equal(r.verified, false);
});

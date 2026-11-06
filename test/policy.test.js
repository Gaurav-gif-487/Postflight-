"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { PRESETS, PRESET_NAMES, resolvePolicy } = require("../src/policy");

test("PRESET_NAMES: lists exactly the three declared presets", () => {
  assert.deepEqual([...PRESET_NAMES].sort(), ["advisory", "default", "strict"]);
});

test("resolvePolicy: defaults to the 'default' preset", () => {
  const policy = resolvePolicy();
  assert.equal(policy.name, "default");
  assert.equal(policy.blockOnIntroducedFailure, true);
});

test("resolvePolicy: an unknown preset name is a hard error, not a silent fallback", () => {
  assert.throws(() => resolvePolicy({ preset: "yolo" }), /unknown policy "yolo"/);
});

test("resolvePolicy: the error message lists the valid preset names", () => {
  assert.throws(() => resolvePolicy({ preset: "yolo" }), (err) => {
    for (const name of PRESET_NAMES) assert.match(err.message, new RegExp(name));
    return true;
  });
});

test("resolvePolicy: strict requires build and test evidence, default does not", () => {
  const strict = resolvePolicy({ preset: "strict" });
  const dflt = resolvePolicy({ preset: "default" });
  assert.equal(strict.requireBuildEvidence, true);
  assert.equal(strict.requireTestEvidence, true);
  assert.equal(dflt.requireBuildEvidence, false);
  assert.equal(dflt.requireTestEvidence, false);
});

test("resolvePolicy: advisory never blocks", () => {
  const advisory = resolvePolicy({ preset: "advisory" });
  assert.equal(advisory.blockOnIntroducedFailure, false);
  assert.deepEqual(advisory.blockOnCategories, []);
});

test("resolvePolicy: configPolicy overrides preset values", () => {
  const policy = resolvePolicy({ preset: "default", configPolicy: { minStrengthToBlock: "STRONG" } });
  assert.equal(policy.minStrengthToBlock, "STRONG");
  // Unrelated preset values still come through.
  assert.equal(policy.name, "default");
});

test("resolvePolicy: CLI overrides win over configPolicy", () => {
  const policy = resolvePolicy({
    preset: "default",
    configPolicy: { minStrengthToBlock: "STRONG" },
    overrides: { minStrengthToBlock: "WEAK" },
  });
  assert.equal(policy.minStrengthToBlock, "WEAK");
});

test("resolvePolicy: coverage sub-object merges rather than replaces wholesale", () => {
  const policy = resolvePolicy({ preset: "strict", configPolicy: { coverage: { minChangedLineCoverage: 0.9 } } });
  assert.equal(policy.coverage.minChangedLineCoverage, 0.9);
  // required: true came from the strict preset and must survive the merge.
  assert.equal(policy.coverage.required, true);
});

test("resolvePolicy: records provenance of what changed the policy", () => {
  const policy = resolvePolicy({ preset: "strict", configPolicy: { minStrengthToBlock: "STRONG" }, overrides: { allowPreExistingFailures: true } });
  assert.equal(policy.source.preset, "strict");
  assert.deepEqual(policy.source.configKeys, ["minStrengthToBlock"]);
  assert.deepEqual(policy.source.overrideKeys, ["allowPreExistingFailures"]);
});

test("resolvePolicy: the returned policy is frozen (immutable)", () => {
  const policy = resolvePolicy({ preset: "default" });
  assert.throws(() => {
    "use strict";
    policy.minStrengthToBlock = "WEAK";
  }, TypeError);
});

test("resolvePolicy: resolving twice never mutates the underlying PRESETS table", () => {
  resolvePolicy({ preset: "default", overrides: { minStrengthToBlock: "STRONG" } });
  assert.equal(PRESETS.default.minStrengthToBlock, "MEDIUM");
});

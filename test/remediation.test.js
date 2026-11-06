"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createEvidence } = require("../src/evidence");
const {
  validateProvider,
  loadProvider,
  loadProviders,
  collectRemediations,
  isRemediable,
  API_VERSION,
  KIND,
  CONFIDENCE,
} = require("../src/remediation");

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "postflight-remediation-"));
}

function makeEvidence(overrides = {}) {
  return createEvidence({
    id: "dependency-added@1",
    category: "dependency",
    status: "WARN",
    summary: "New dependency added without a lockfile update",
    provenance: { method: "observed", source: "package.json" },
    ...overrides,
  });
}

test("validateProvider: rejects a provider missing required functions", () => {
  const { valid, errors } = validateProvider({ metadata: { name: "x", version: "1.0.0" } }, "x.js");
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("canRemediate")));
  assert.ok(errors.some((e) => e.includes("remediate")));
});

test("validateProvider: rejects a provider missing metadata.name/version", () => {
  const { valid, errors } = validateProvider({ canRemediate: () => false, remediate: () => null }, "x.js");
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("metadata.name")));
  assert.ok(errors.some((e) => e.includes("metadata.version")));
});

test("validateProvider: rejects a mismatched apiVersion", () => {
  const { valid, errors } = validateProvider(
    {
      metadata: { name: "x", version: "1.0.0", apiVersion: API_VERSION + 1 },
      canRemediate: () => false,
      remediate: () => null,
    },
    "x.js"
  );
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("apiVersion")));
});

test("validateProvider: accepts a well-formed provider", () => {
  const { valid, errors } = validateProvider(
    {
      metadata: { name: "npm-installer", version: "0.1.0", apiVersion: API_VERSION },
      canRemediate: () => true,
      remediate: () => null,
    },
    "x.js"
  );
  assert.equal(valid, true);
  assert.deepEqual(errors, []);
});

test("loadProvider: loads and validates a provider from a relative repo path", () => {
  const dir = tmpdir();
  fs.writeFileSync(
    path.join(dir, "provider.js"),
    `module.exports = {
      metadata: { name: "test-provider", version: "1.0.0" },
      canRemediate: () => true,
      remediate: () => ({ summary: "fix it" }),
    };`
  );
  const result = loadProvider("./provider.js", dir);
  assert.equal(result.ok, true);
  assert.equal(result.provider.metadata.name, "test-provider");
});

test("loadProvider: a syntax error in the module degrades to a load failure, not a crash", () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "broken.js"), "this is not valid javascript {{{");
  const result = loadProvider("./broken.js", dir);
  assert.equal(result.ok, false);
  assert.ok(result.errors[0].includes("failed to load"));
});

test("loadProviders: reads config.remediationProviders, splitting loaded/failed", () => {
  const dir = tmpdir();
  fs.writeFileSync(
    path.join(dir, "good.js"),
    `module.exports = { metadata: { name: "good", version: "1.0.0" }, canRemediate: () => false, remediate: () => null };`
  );
  const { loaded, failed } = loadProviders({ remediationProviders: ["./good.js", "./missing.js"] }, dir);
  assert.equal(loaded.length, 1);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].source, "./missing.js");
});

test("isRemediable: true for FAIL/WARN, false for PASS/UNKNOWN", () => {
  assert.equal(isRemediable(makeEvidence({ status: "FAIL" })), true);
  assert.equal(isRemediable(makeEvidence({ status: "WARN" })), true);
  assert.equal(isRemediable(makeEvidence({ status: "PASS" })), false);
  assert.equal(
    isRemediable(makeEvidence({ status: "UNKNOWN", detail: "could not run" })),
    false
  );
});

test("collectRemediations: a matching provider's suggestion is collected with defaults filled in", () => {
  const provider = {
    metadata: { name: "npm-installer", version: "1.0.0" },
    canRemediate: (ev) => ev.category === "dependency",
    remediate: (ev) => ({ summary: "Run npm install to update the lockfile", kind: KIND.COMMAND, commands: ["npm install"] }),
  };
  const ev = makeEvidence();
  const { remediations, limitations } = collectRemediations([{ provider, source: "npm-installer" }], [ev], {});
  assert.deepEqual(limitations, []);
  assert.equal(remediations.length, 1);
  assert.equal(remediations[0].evidenceId, ev.id);
  assert.equal(remediations[0].provider, "npm-installer");
  assert.equal(remediations[0].kind, KIND.COMMAND);
  assert.deepEqual(remediations[0].commands, ["npm install"]);
  assert.equal(remediations[0].confidence, CONFIDENCE.SUGGESTED); // default when not specified
});

test("collectRemediations: canRemediate() returning false skips that evidence", () => {
  const provider = {
    metadata: { name: "never", version: "1.0.0" },
    canRemediate: () => false,
    remediate: () => ({ summary: "should never be called" }),
  };
  const { remediations } = collectRemediations([{ provider, source: "never" }], [makeEvidence()], {});
  assert.deepEqual(remediations, []);
});

test("collectRemediations: PASS/UNKNOWN evidence is never offered to providers", () => {
  let called = false;
  const provider = {
    metadata: { name: "watcher", version: "1.0.0" },
    canRemediate: () => {
      called = true;
      return true;
    },
    remediate: () => ({ summary: "x" }),
  };
  const passing = makeEvidence({ status: "PASS", id: "dependency-added@2" });
  collectRemediations([{ provider, source: "watcher" }], [passing], {});
  assert.equal(called, false);
});

test("collectRemediations: a throwing provider degrades to a limitation, not a crash", () => {
  const provider = {
    metadata: { name: "flaky", version: "1.0.0" },
    canRemediate: () => true,
    remediate: () => {
      throw new Error("boom");
    },
  };
  const { remediations, limitations } = collectRemediations([{ provider, source: "flaky" }], [makeEvidence()], {});
  assert.deepEqual(remediations, []);
  assert.equal(limitations.length, 1);
  assert.match(limitations[0].summary, /flaky.*boom/);
});

test("collectRemediations: a malformed suggestion (missing summary) is rejected, not silently accepted", () => {
  const provider = {
    metadata: { name: "sloppy", version: "1.0.0" },
    canRemediate: () => true,
    remediate: () => ({ kind: KIND.MANUAL }),
  };
  const { remediations, limitations } = collectRemediations([{ provider, source: "sloppy" }], [makeEvidence()], {});
  assert.deepEqual(remediations, []);
  assert.equal(limitations.length, 1);
  assert.match(limitations[0].summary, /summary is required/);
});

test("collectRemediations: kind 'diff' without a diff string is rejected", () => {
  const provider = {
    metadata: { name: "sloppy-diff", version: "1.0.0" },
    canRemediate: () => true,
    remediate: () => ({ summary: "fix", kind: KIND.DIFF }),
  };
  const { remediations, limitations } = collectRemediations([{ provider, source: "sloppy-diff" }], [makeEvidence()], {});
  assert.deepEqual(remediations, []);
  assert.equal(limitations.length, 1);
  assert.match(limitations[0].summary, /kind "diff" requires/);
});

test("collectRemediations: kind 'command' without a commands array is rejected", () => {
  const provider = {
    metadata: { name: "sloppy-cmd", version: "1.0.0" },
    canRemediate: () => true,
    remediate: () => ({ summary: "fix", kind: KIND.COMMAND }),
  };
  const { remediations, limitations } = collectRemediations([{ provider, source: "sloppy-cmd" }], [makeEvidence()], {});
  assert.deepEqual(remediations, []);
  assert.equal(limitations.length, 1);
  assert.match(limitations[0].summary, /kind "command" requires/);
});

test("collectRemediations: a provider returning an array of suggestions collects all of them", () => {
  const provider = {
    metadata: { name: "multi", version: "1.0.0" },
    canRemediate: () => true,
    remediate: () => [
      { summary: "Option A: pin the version", kind: KIND.MANUAL },
      { summary: "Option B: run npm install", kind: KIND.COMMAND, commands: ["npm install"] },
    ],
  };
  const { remediations } = collectRemediations([{ provider, source: "multi" }], [makeEvidence()], {});
  assert.equal(remediations.length, 2);
});

test("collectRemediations: a provider returning null produces no remediation and no limitation", () => {
  const provider = {
    metadata: { name: "quiet", version: "1.0.0" },
    canRemediate: () => true,
    remediate: () => null,
  };
  const { remediations, limitations } = collectRemediations([{ provider, source: "quiet" }], [makeEvidence()], {});
  assert.deepEqual(remediations, []);
  assert.deepEqual(limitations, []);
});

test("collectRemediations: never mutates the evidence record it was given", () => {
  const ev = makeEvidence();
  const frozenBefore = Object.isFrozen(ev);
  const provider = {
    metadata: { name: "npm-installer", version: "1.0.0" },
    canRemediate: () => true,
    remediate: () => ({ summary: "fix", kind: KIND.COMMAND, commands: ["npm install"] }),
  };
  collectRemediations([{ provider, source: "npm-installer" }], [ev], {});
  assert.equal(Object.isFrozen(ev), frozenBefore);
  assert.equal(ev.remediation, null); // untouched - suggestions live in a separate list
});

test("collectRemediations: multiple providers can each independently suggest a fix for the same evidence", () => {
  const providerA = {
    metadata: { name: "a", version: "1.0.0" },
    canRemediate: () => true,
    remediate: () => ({ summary: "fix via A" }),
  };
  const providerB = {
    metadata: { name: "b", version: "1.0.0" },
    canRemediate: () => true,
    remediate: () => ({ summary: "fix via B" }),
  };
  const { remediations } = collectRemediations(
    [
      { provider: providerA, source: "a" },
      { provider: providerB, source: "b" },
    ],
    [makeEvidence()],
    {}
  );
  assert.equal(remediations.length, 2);
  assert.deepEqual(
    remediations.map((r) => r.provider).sort(),
    ["a", "b"]
  );
});

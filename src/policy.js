"use strict";

// Policies are declarative and deterministic. The verdict engine reads them;
// it never invents thresholds of its own. Two runs with the same evidence and
// the same policy always produce the same verdict.

const PRESETS = {
  // Sensible default for a team adopting postflight on an existing repo.
  default: {
    name: "default",
    requireBuildEvidence: false,
    requireTestEvidence: false,
    // A change that touches code but produces no executed test evidence is
    // not "safe" - it is unverified. Default policy says review, not block.
    unverifiedChangeVerdict: "REVIEW_REQUIRED",
    blockOnIntroducedFailure: true,
    blockOnCategories: ["build", "test", "security"],
    reviewOnCategories: ["test-integrity", "config", "dependency", "architecture", "surface", "repo-state", "coverage"],
    // Evidence weaker than this can never, on its own, BLOCK a merge.
    minStrengthToBlock: "MEDIUM",
    // UNKNOWN is not PASS. It downgrades the verdict rather than being ignored.
    unknownDowngrades: true,
    maxUnknownForSafe: 0,
    allowPreExistingFailures: true,
    coverage: { required: false, minChangedLineCoverage: null },
  },

  // For repos that already have real CI signal and want postflight to enforce.
  strict: {
    name: "strict",
    requireBuildEvidence: true,
    requireTestEvidence: true,
    unverifiedChangeVerdict: "BLOCK",
    blockOnIntroducedFailure: true,
    blockOnCategories: [
      "build",
      "test",
      "test-integrity",
      "security",
      "config",
      "dependency",
      "architecture",
      "repo-state",
    ],
    reviewOnCategories: ["surface", "coverage"],
    minStrengthToBlock: "MEDIUM",
    unknownDowngrades: true,
    maxUnknownForSafe: 0,
    allowPreExistingFailures: false,
    coverage: { required: true, minChangedLineCoverage: 0.6 },
  },

  // Report-only. Never blocks; useful when first introducing postflight.
  advisory: {
    name: "advisory",
    requireBuildEvidence: false,
    requireTestEvidence: false,
    unverifiedChangeVerdict: "REVIEW_REQUIRED",
    blockOnIntroducedFailure: false,
    blockOnCategories: [],
    reviewOnCategories: [
      "build",
      "test",
      "test-integrity",
      "security",
      "config",
      "dependency",
      "architecture",
      "surface",
      "repo-state",
      "coverage",
    ],
    minStrengthToBlock: "STRONG",
    unknownDowngrades: false,
    maxUnknownForSafe: Infinity,
    allowPreExistingFailures: true,
    coverage: { required: false, minChangedLineCoverage: null },
  },
};

const PRESET_NAMES = Object.keys(PRESETS);

function clone(policy) {
  return JSON.parse(JSON.stringify(policy, (k, v) => (v === Infinity ? "Infinity" : v)), (k, v) =>
    v === "Infinity" ? Infinity : v
  );
}

// Resolves the effective policy: preset, then config file overrides, then
// CLI overrides. Unknown preset names are a hard error - silently falling
// back to a laxer policy than the operator asked for is unacceptable.
function resolvePolicy({ preset = "default", configPolicy = {}, overrides = {} } = {}) {
  if (!PRESETS[preset]) {
    throw new Error(`postflight: unknown policy "${preset}" (expected one of ${PRESET_NAMES.join(", ")})`);
  }
  const base = clone(PRESETS[preset]);
  const merged = {
    ...base,
    ...configPolicy,
    ...overrides,
    coverage: { ...base.coverage, ...(configPolicy.coverage || {}), ...(overrides.coverage || {}) },
    name: preset,
  };
  merged.source = {
    preset,
    configKeys: Object.keys(configPolicy || {}),
    overrideKeys: Object.keys(overrides || {}),
  };
  return Object.freeze(merged);
}

module.exports = { PRESETS, PRESET_NAMES, resolvePolicy };

"use strict";
const fs = require("fs");
const path = require("path");

const CONFIG_NAMES = ["postflight.config.json", ".postflightrc.json"];

const DEFAULTS = {
  ignore: [], // glob-ish prefixes/paths to exclude from findings
  testMapping: {}, // { "src/foo.js": "custom/path/to/test.js" }
  // Per-repo source-dir -> test-dir prefix pairs, for conventions that are
  // project-configured rather than language-level (e.g. Kotlin-multiplatform
  // Gradle source sets like src/jvmMain -> src/jvmTest, which no fixed regex
  // can generalize across repos - see src/testMapping.js's applyTestDirs).
  // Applied in addition to, not instead of, the built-in
  // language conventions.
  // e.g. [{ "from": "src/jvmMain", "to": "src/jvmTest" }, { "from": "src/commonMain", "to": "src/commonTest" }]
  testDirs: [],
  rules: [], // additional regex rules, same shape as src/checks.js RULES
  severityOverrides: {}, // { "todo-added": "high" }
  // Policy overrides layered onto whichever --policy <preset> is selected
  // (src/policy.js resolvePolicy's configPolicy argument). Only consulted
  // when --policy is passed; has no effect on the default score.js/report.js
  // path. e.g. { "minStrengthToBlock": "STRONG" }
  policy: {},
  // Paths (relative to repo root) or package names of external plugins
  // (src/plugins.js). Empty by default - core is fully functional with
  // zero plugins installed. e.g. ["./tools/postflight-plugins/rust.js"]
  plugins: [],
  // Paths or package names of RemediationProvider modules (src/remediation.js).
  // Empty by default. A provider turns FAIL/WARN evidence into a *suggested*
  // fix (diff/commands/manual note) - postflight never applies anything on
  // its own. e.g. ["./tools/postflight-remediations/npm-lockfile.js"]
  remediationProviders: [],
};

// Loads and merges a config file if present. Never throws for a missing
// file - config is opt-in and postflight must work with zero setup.
function loadConfig(repoRoot) {
  for (const name of CONFIG_NAMES) {
    const p = path.join(repoRoot, name);
    if (fs.existsSync(p)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
        return { ...DEFAULTS, ...parsed, _source: name };
      } catch (err) {
        console.error(`postflight: failed to parse ${name}: ${err.message}`);
        return { ...DEFAULTS, _source: null };
      }
    }
  }
  return { ...DEFAULTS, _source: null };
}

function isIgnored(file, config) {
  if (!file) return false;
  return (config.ignore || []).some((pattern) => file === pattern || file.startsWith(pattern.replace(/\*+$/, "")));
}

module.exports = { loadConfig, isIgnored, CONFIG_NAMES, DEFAULTS };

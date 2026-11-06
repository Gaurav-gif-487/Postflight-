"use strict";

const git = require("../git");
const fs = require("fs");
const path = require("path");
const { STATUS, STRENGTH, ORIGIN, METHOD } = require("../evidence");

// Configuration changes are the highest-leverage, lowest-visibility edits an
// agent can make: one line in a CI workflow or a tsconfig can disable every
// other check in this report. They are analyzed as first-class evidence, not
// as ordinary source files.

const CI_PATH = /^(\.github\/workflows\/|\.gitlab-ci\.yml|\.circleci\/|Jenkinsfile|azure-pipelines\.yml|\.buildkite\/)/;
const CONTAINER_PATH = /(^|\/)(Dockerfile[^/]*|docker-compose[^/]*\.ya?ml)$/;
const TS_CONFIG = /(^|\/)tsconfig[^/]*\.json$/;
const LINT_CONFIG = /(^|\/)(\.eslintrc[^/]*|eslint\.config\.[cm]?[jt]s|\.ruff\.toml|ruff\.toml|\.flake8|setup\.cfg)$/;
// Subset of LINT_CONFIG that's real (if comment/trailing-comma-tolerant)
// JSON we can safely parse and diff structurally, rather than falling back
// to added-line text matching. Deliberately narrow: bare ".eslintrc" (no
// extension) can be JSON, YAML, *or* JS depending on the repo, and
// eslint.config.js/mjs/cjs (ESLint's newer "flat config") is arbitrary
// executable JS that cannot be parsed generically or safely.
const LINT_CONFIG_JSON = /(^|\/)\.eslintrc\.json$/;

const STRICTNESS_FLAGS = ["strict", "noImplicitAny", "strictNullChecks", "noUnusedLocals", "noImplicitReturns"];

function readAt(ref, file, cwd) {
  return git.showFile(ref, file, cwd);
}

function readNow(cwd, file) {
  try {
    return fs.readFileSync(path.join(cwd, file), "utf8");
  } catch {
    return null;
  }
}

// tsconfig allows comments and trailing commas, so JSON.parse alone is not
// enough. Strip them conservatively; on failure return null and report the
// change as unanalyzable rather than pretending it was fine.
function parseJsonc(text) {
  if (!text) return null;
  try {
    const stripped = text
      .replace(/\\"/g, "\u0000")
      .replace(/"(?:[^"\\]|\\.)*"/g, (m) => m.replace(/\/\//g, "\u0001"))
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1")
      .replace(/,(\s*[}\]])/g, "$1")
      .replace(/\u0001/g, "//")
      .replace(/\u0000/g, '\\"');
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}

function addedLinesFor(file, parsedDiff) {
  const entry = parsedDiff.find((f) => f.file === file);
  return entry ? entry.added : [];
}

function removedLinesFor(file, parsedDiff) {
  const entry = parsedDiff.find((f) => f.file === file);
  return entry ? entry.removed : [];
}

// Collapses cosmetic differences (quote style, incidental whitespace) so a
// line that was only moved or reformatted - not changed in substance -
// compares equal before/after. Used to tell "this rule's disable line was
// newly added" apart from "this rule's disable line was already there and
// the file got reformatted/reordered around it".
function normalizeConfigLine(text) {
  return text.trim().replace(/[\s]+/g, " ").replace(/'/g, '"');
}

// ESLint's legacy rule value shape: "off" / 0 / ["off", ...] / [0, ...] all
// mean disabled; "error"/"warn"/1/2/[<level>, ...] all mean enabled at some
// level. Only the on/off distinction matters here - severity level changes
// (warn -> error) aren't a "disabled" event.
function ruleIsOff(value) {
  const level = Array.isArray(value) ? value[0] : value;
  return level === "off" || level === 0 || level === "0";
}

// Flattens an ESLint config's `rules` plus every `overrides[].rules` into a
// single list of { key, rule, value } entries, where `key` disambiguates
// the same rule name configured differently under different `overrides`
// globs (so a rule turned off only for test files isn't confused with the
// same rule turned off globally).
function collectRuleStates(parsed) {
  const out = [];
  if (!parsed || typeof parsed !== "object") return out;
  const addFrom = (obj, scope) => {
    if (!obj || typeof obj !== "object") return;
    for (const [rule, value] of Object.entries(obj)) out.push({ key: `${scope}::${rule}`, rule, value, scope });
  };
  addFrom(parsed.rules, "");
  if (Array.isArray(parsed.overrides)) {
    parsed.overrides.forEach((o, i) => {
      const scope = o && Array.isArray(o.files) ? o.files.join(",") : `overrides[${i}]`;
      addFrom(o && o.rules, scope);
    });
  }
  return out;
}

function analyze({ base, cwd, changedFiles = [], statuses = {}, parsedDiff = [] }) {
  const evidence = [];

  for (const file of changedFiles) {
    const status = (statuses[file] && statuses[file].status) || "modified";
    if (status === "deleted") continue;

    if (CI_PATH.test(file)) {
      const added = addedLinesFor(file, parsedDiff);
      // `--ignore-scripts` was removed from this pattern after adversarial
      // replay against real repos: expressjs/express's own CI workflow
      // uses `npm install --ignore-scripts --include=dev` as a security
      // hardening measure (it *prevents* a compromised dependency's
      // postinstall script from running arbitrary code during CI), which
      // is the opposite of "CI configuration weakened" - every other
      // pattern here (continue-on-error, || true, --no-verify, if: false,
      // permissions: write-all, pull_request_target) genuinely disables or
      // widens something the pipeline is supposed to guard; --ignore-scripts
      // narrows the attack surface instead.
      const risky = added.filter((a) =>
        /continue-on-error\s*:\s*true|\|\|\s*true|--no-verify|if:\s*false|permissions:\s*write-all|pull_request_target/.test(
          a.text
        )
      );
      evidence.push({
        id: `config/ci-modified@${file}`,
        category: "config",
        status: risky.length ? STATUS.FAIL : STATUS.WARN,
        strength: STRENGTH.MEDIUM,
        origin: ORIGIN.INTRODUCED,
        summary: risky.length
          ? `CI configuration weakened in ${file}`
          : `CI configuration modified in ${file}`,
        detail: risky.length
          ? risky.map((a) => `line ${a.line}: ${a.text.trim().slice(0, 120)}`).join("; ")
          : "The pipeline that gates this repository was changed by the same change it gates.",
        locations: [{ file, line: risky.length ? risky[0].line : null }],
        provenance: { method: METHOD.OBSERVED, source: "diff of CI configuration", ref: base },
        remediation: "Review pipeline changes separately from product changes.",
      });
    }

    if (CONTAINER_PATH.test(file)) {
      const added = addedLinesFor(file, parsedDiff);
      const risky = added.filter((a) => /USER\s+root|--privileged|:latest\b|ADD\s+https?:\/\//.test(a.text));
      if (risky.length) {
        evidence.push({
          id: `config/container-risk@${file}`,
          category: "config",
          status: STATUS.WARN,
          strength: STRENGTH.MEDIUM,
          origin: ORIGIN.INTRODUCED,
          summary: `Container configuration weakened in ${file}`,
          detail: risky.map((a) => `line ${a.line}: ${a.text.trim().slice(0, 120)}`).join("; "),
          locations: [{ file, line: risky[0].line }],
          provenance: { method: METHOD.OBSERVED, source: "diff of container configuration", ref: base },
        });
      }
    }

    if (TS_CONFIG.test(file)) {
      const before = parseJsonc(readAt(base, file, cwd));
      // "After" must be the working-tree content, not HEAD - same
      // HEAD-vs-working-tree bug class fixed in dependencyChange.js and
      // testIntegrity.js: postflight's whole model is base
      // commit vs whatever's on disk right now, which includes uncommitted
      // edits. `readAt("HEAD", ...)` would silently miss an uncommitted
      // tsconfig relaxation.
      const after = parseJsonc(readNow(cwd, file));
      if (!after || (!before && status !== "added")) {
        evidence.push({
          id: `config/tsconfig-unparsed@${file}`,
          category: "config",
          status: STATUS.UNKNOWN,
          strength: STRENGTH.MEDIUM,
          origin: ORIGIN.UNKNOWN,
          summary: `Could not compare compiler strictness in ${file}`,
          detail: "The file changed but could not be parsed at both revisions, so strictness changes are unverified.",
          locations: [{ file }],
          provenance: { method: METHOD.OBSERVED, source: "tsconfig parse", ref: base },
        });
      } else if (before) {
        const b = before.compilerOptions || {};
        const a = after.compilerOptions || {};
        const relaxed = STRICTNESS_FLAGS.filter((flag) => b[flag] === true && a[flag] === false);
        // `exclude` is a top-level tsconfig field, not a compilerOptions
        // field (unlike `ignoreDeprecations`, which genuinely is one) - the
        // `exclude` is a top-level tsconfig.json field, not a compilerOptions
        // field, so it is read from the parsed file objects.
        const beforeExclude = Array.isArray(before.exclude) ? before.exclude : [];
        const afterExclude = Array.isArray(after.exclude) ? after.exclude : [];
        const suppressed = a.ignoreDeprecations || afterExclude.length > beforeExclude.length;
        if (relaxed.length) {
          evidence.push({
            id: `config/tsconfig-relaxed@${file}`,
            category: "config",
            status: STATUS.FAIL,
            strength: STRENGTH.STRONG,
            origin: ORIGIN.INTRODUCED,
            summary: `TypeScript strictness reduced in ${file}: ${relaxed.join(", ")} turned off`,
            detail: "Relaxing the compiler is a way to make type errors disappear without fixing them.",
            locations: [{ file }],
            provenance: { method: METHOD.OBSERVED, source: "tsconfig at base vs head", ref: base },
            remediation: "Restore the flag and fix the underlying type errors.",
          });
        } else if (suppressed) {
          evidence.push({
            id: `config/tsconfig-scope-narrowed@${file}`,
            category: "config",
            status: STATUS.WARN,
            strength: STRENGTH.MEDIUM,
            origin: ORIGIN.INTRODUCED,
            summary: `Type-checking scope narrowed in ${file}`,
            detail: "Files were excluded from compilation, which removes them from type checking.",
            locations: [{ file }],
            provenance: { method: METHOD.OBSERVED, source: "tsconfig at base vs head", ref: base },
          });
        }
      }
    }

    if (LINT_CONFIG.test(file)) {
      let handled = false;

      // For real, parseable JSON ESLint configs, diff the actual parsed
      // rule *state* rather than added diff lines. This is what closes the
      // gap found by adversarial replay against svelte's eslint.config.js
      //: a wholesale reformat/reorder of a config makes every
      // pre-existing "off" rule show up as an "added" line under pure
      // line-diffing, false-positiving as "newly disabled" even though
      // nothing's rule state actually changed. A parsed before/after
      // comparison is immune to that by construction - reordering or
      // reformatting the file doesn't change what JSON.parse returns.
      if (LINT_CONFIG_JSON.test(file)) {
        const before = status === "added" ? {} : parseJsonc(readAt(base, file, cwd));
        const after = parseJsonc(readNow(cwd, file));
        if (after && (before || status === "added")) {
          const beforeStates = new Map(collectRuleStates(before || {}).map((s) => [s.key, s.value]));
          const newlyDisabled = collectRuleStates(after).filter((s) => {
            if (!ruleIsOff(s.value)) return false;
            const prevValue = beforeStates.get(s.key);
            // Undeclared before (including "the whole file is new") counts
            // as newly disabled, matching what a line-based diff would have
            // caught for a brand-new config; already-off before does not.
            return prevValue === undefined || !ruleIsOff(prevValue);
          });
          if (newlyDisabled.length) {
            evidence.push({
              id: `config/lint-rules-disabled@${file}`,
              category: "config",
              status: STATUS.WARN,
              strength: STRENGTH.MEDIUM,
              origin: ORIGIN.INTRODUCED,
              summary: `Lint rules disabled or scoped away in ${file}`,
              detail: newlyDisabled
                .map((s) => (s.scope ? `${s.rule} (${s.scope}): now off` : `${s.rule}: now off`))
                .join("; "),
              locations: [{ file }],
              provenance: { method: METHOD.OBSERVED, source: "parsed rule state at base vs working tree", ref: base },
            });
          }
          handled = true;
        }
        // If parsing failed at either revision, fall through to the
        // line-based heuristic below rather than silently reporting
        // nothing - the file matched LINT_CONFIG_JSON but turned out not
        // to be clean JSON (e.g. genuinely malformed), so degrade rather
        // than go blind.
      }

      if (!handled) {
        const added = addedLinesFor(file, parsedDiff);
        const removedNormalized = new Set(removedLinesFor(file, parsedDiff).map((r) => normalizeConfigLine(r.text)));
        const disabled = added.filter((a) => {
          if (!/["']off["']|:\s*0\b|--no-eslintrc|ignorePatterns|noqa|# type: ignore/.test(a.text)) return false;
          // A line whose normalized text also appears among this file's
          // removed lines is a move/reformat, not a new disablement - the
          // same false-positive class the parsed-JSON path above avoids
          // structurally, applied here as a text-level mitigation for the
          // configs (flat eslint.config.js, YAML, TOML, flake8/setup.cfg)
          // that can't be safely parsed generically. Doesn't fully close
          // the gap (a reformat that also changes line content around the
          // rule would still slip through) but catches the concrete case
          // found via replay: whole-file reformatting/reordering with the
          // rule lines otherwise unchanged.
          return !removedNormalized.has(normalizeConfigLine(a.text));
        });
        if (disabled.length) {
          evidence.push({
            id: `config/lint-rules-disabled@${file}`,
            category: "config",
            status: STATUS.WARN,
            strength: STRENGTH.MEDIUM,
            origin: ORIGIN.INTRODUCED,
            summary: `Lint rules disabled or scoped away in ${file}`,
            detail: disabled.map((a) => `line ${a.line}: ${a.text.trim().slice(0, 120)}`).join("; "),
            locations: [{ file, line: disabled[0].line }],
            provenance: { method: METHOD.OBSERVED, source: "diff of lint configuration", ref: base },
          });
        }
      }
    }
  }

  return { evidence };
}

module.exports = {
  analyze,
  parseJsonc,
  CI_PATH,
  TS_CONFIG,
  STRICTNESS_FLAGS,
  ruleIsOff,
  collectRuleStates,
  normalizeConfigLine,
};

"use strict";

const git = require("../git");
const fs = require("fs");
const path = require("path");
const { STATUS, STRENGTH, ORIGIN, METHOD } = require("../evidence");

// New dependencies are new supply-chain surface, and they arrive constantly
// in agent-authored changes. Diffing manifests at base vs head gives exact,
// observed facts - not a regex guess about an import line.

const MANIFESTS = ["package.json", "requirements.txt", "pyproject.toml", "go.mod", "Gemfile", "Cargo.toml"];
const LOCKFILES = [
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "poetry.lock",
  "Cargo.lock",
  "go.sum",
  "Gemfile.lock",
];
const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

const NON_REGISTRY = /^(git\+|github:|file:|link:|https?:|ssh:)/i;

function readNow(cwd, file) {
  try {
    return fs.readFileSync(path.join(cwd, file), "utf8");
  } catch {
    return null;
  }
}

function parsePackageJson(text) {
  if (!text) return null;
  try {
    const pkg = JSON.parse(text);
    const deps = {};
    for (const field of DEP_FIELDS) {
      for (const [name, range] of Object.entries(pkg[field] || {})) deps[name] = { range, field };
    }
    return { deps, scripts: pkg.scripts || {} };
  } catch {
    return null;
  }
}

function parseRequirements(text) {
  if (!text) return null;
  const deps = {};
  for (const raw of text.split("\n")) {
    const line = raw.split("#")[0].trim();
    if (!line) continue;
    const m = /^([A-Za-z0-9_.\-\[\]]+)\s*([=<>!~]{1,2}.*)?$/.exec(line);
    if (m) deps[m[1].toLowerCase()] = { range: (m[2] || "").trim(), field: "dependencies" };
  }
  return { deps, scripts: {} };
}

// Minimal TOML section/key-value scanning, enough for Cargo's dependency
// tables. Not a general TOML parser (no arrays-of-tables, no multi-line
// strings) - Cargo.toml dependency sections don't need those.
const CARGO_DEP_SECTIONS = /^(dependencies|dev-dependencies|build-dependencies|target\.[^.]+\.dependencies)$/;

function cargoFieldFor(section) {
  if (section === "dev-dependencies") return "devDependencies";
  if (section === "build-dependencies") return "buildDependencies";
  return "dependencies";
}

// A dependency line's value is either a bare version string ("1.0"), or an
// inline table ({ version = "1.0", git = "...", path = "...", ... }). Only
// inline tables are supported (Cargo.toml practice almost never spans a
// dependency's attributes across multiple lines); a dependency expressed as
// a full [dependencies.name] block is left unparsed for that one entry
// rather than mis-parsed.
function parseCargoInlineValue(raw) {
  const value = raw.trim();
  if (value.startsWith("{")) {
    const body = value.replace(/^\{/, "").replace(/\}\s*$/, "");
    const attrs = {};
    // Split on commas that aren't inside a quoted string.
    const parts = body.match(/(?:[^,"']+|"[^"]*"|'[^']*')+/g) || [];
    for (const part of parts) {
      const m = /^\s*([A-Za-z0-9_\-]+)\s*=\s*(.+?)\s*,?\s*$/.exec(part);
      if (!m) continue;
      const key = m[1].trim();
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      attrs[key] = val;
    }
    if (attrs.git) return `git+${attrs.git}`;
    if (attrs.path) return `file:${attrs.path}`;
    if (attrs.version) return attrs.version;
    return "";
  }
  return value.replace(/^["']|["']$/g, "");
}

function parseCargoToml(text) {
  if (!text) return null;
  const deps = {};
  let section = null;
  for (const raw of text.split("\n")) {
    const line = raw.split("#")[0];
    if (!line.trim()) continue;
    const sectionMatch = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      continue;
    }
    if (!section || !CARGO_DEP_SECTIONS.test(section)) continue;
    const kv = /^\s*([A-Za-z0-9_\-]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (!kv) continue;
    const name = kv[1].trim();
    const range = parseCargoInlineValue(kv[2]);
    deps[name] = { range, field: cargoFieldFor(section) };
  }
  return { deps, scripts: {} };
}

// go.mod: `require` appears either as a single-line directive or a
// parenthesised block. Both forms list `module/path vX.Y.Z [// indirect]`.
function parseGoMod(text) {
  if (!text) return null;
  const deps = {};
  const lines = text.split("\n");
  let inBlock = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (inBlock) {
      if (line === ")") {
        inBlock = false;
        continue;
      }
      const m = /^([^\s]+)\s+(v[^\s]+)/.exec(line);
      if (m) deps[m[1]] = { range: m[2], field: "dependencies" };
      continue;
    }
    if (/^require\s*\(\s*$/.test(line)) {
      inBlock = true;
      continue;
    }
    const single = /^require\s+([^\s]+)\s+(v[^\s]+)/.exec(line);
    if (single) deps[single[1]] = { range: single[2], field: "dependencies" };
  }
  return { deps, scripts: {} };
}

// Gemfile: Ruby DSL. Only the common `gem "name"[, "constraint"][, opts]`
// call form is parsed - enough to catch real dependency-version changes and
// non-registry sources (git:/github:/path:), without evaluating Ruby.
function parseGemfile(text) {
  if (!text) return null;
  const deps = {};
  for (const raw of text.split("\n")) {
    const line = raw.split("#")[0];
    const m = /^\s*gem\s+["']([^"']+)["']\s*(.*)$/.exec(line);
    if (!m) continue;
    const name = m[1];
    const rest = m[2];
    let range = "";
    const constraint = /^,\s*["']([^"']+)["']/.exec(rest);
    if (constraint) range = constraint[1];
    const git = /git:\s*["']([^"']+)["']/.exec(rest);
    const github = /github:\s*["']([^"']+)["']/.exec(rest);
    const path = /path:\s*["']([^"']+)["']/.exec(rest);
    if (git) range = `git+${git[1]}`;
    else if (github) range = `github:${github[1]}`;
    else if (path) range = `file:${path[1]}`;
    deps[name] = { range, field: "dependencies" };
  }
  return { deps, scripts: {} };
}

function parseManifest(file, text) {
  if (file.endsWith("package.json")) return parsePackageJson(text);
  if (file.endsWith("requirements.txt")) return parseRequirements(text);
  if (file.endsWith("Cargo.toml")) return parseCargoToml(text);
  if (file.endsWith("go.mod")) return parseGoMod(text);
  if (file.endsWith("Gemfile")) return parseGemfile(text);
  return null;
}

function majorOf(range) {
  const m = /(\d+)\./.exec(String(range || ""));
  return m ? parseInt(m[1], 10) : null;
}

// Lifecycle scripts execute on install, on every machine that installs. A new
// one is materially different from a new library.
const LIFECYCLE = ["preinstall", "install", "postinstall", "prepare"];

function analyze({ base, cwd, changedFiles = [] }) {
  const evidence = [];
  const touchedManifests = changedFiles.filter((f) => MANIFESTS.some((m) => f === m || f.endsWith(`/${m}`)));
  const touchedLocks = changedFiles.filter((f) => LOCKFILES.some((m) => f === m || f.endsWith(`/${m}`)));

  for (const file of touchedManifests) {
    const beforeText = git.showFile(base, file, cwd);
    // "After" must be the working-tree content, not HEAD: postflight's whole
    // model (see git.diffAll/`git diff base`, used everywhere else in this
    // tool) is "base commit vs whatever's on disk right now," which includes
    // uncommitted and staged-but-uncommitted changes - the exact case where
    // an agent has just edited package.json and hasn't committed yet. Reading
    // HEAD here would silently miss that (before-fix bug
    // regression test in test/dependencyChange.test.js).
    const afterText = readNow(cwd, file);
    const before = parseManifest(file, beforeText);
    const after = parseManifest(file, afterText);

    if (!after) {
      evidence.push({
        id: `dependency/unparsed@${file}`,
        category: "dependency",
        status: STATUS.UNKNOWN,
        strength: STRENGTH.MEDIUM,
        origin: ORIGIN.UNKNOWN,
        summary: `Dependency manifest ${file} changed but could not be parsed`,
        detail: "Dependency changes in this file are unverified.",
        locations: [{ file }],
        provenance: { method: METHOD.OBSERVED, source: "manifest parse", ref: base },
      });
      continue;
    }
    if (!before) continue;

    const added = Object.keys(after.deps).filter((n) => !before.deps[n]);
    const removed = Object.keys(before.deps).filter((n) => !after.deps[n]);
    const majorBumps = Object.keys(after.deps)
      .filter((n) => before.deps[n])
      .filter((n) => {
        const a = majorOf(after.deps[n].range);
        const b = majorOf(before.deps[n].range);
        return a !== null && b !== null && a > b;
      });
    const nonRegistry = added.filter((n) => NON_REGISTRY.test(after.deps[n].range));
    const movedOffRegistry = Object.keys(after.deps).filter(
      (n) => before.deps[n] && !NON_REGISTRY.test(before.deps[n].range) && NON_REGISTRY.test(after.deps[n].range)
    );

    if (added.length) {
      evidence.push({
        id: `dependency/added@${file}`,
        category: "dependency",
        status: STATUS.WARN,
        strength: STRENGTH.STRONG,
        origin: ORIGIN.INTRODUCED,
        summary: `${added.length} new dependency/dependencies added in ${file}`,
        detail: added.map((n) => `${n}@${after.deps[n].range}`).join(", "),
        locations: [{ file }],
        provenance: { method: METHOD.OBSERVED, source: "manifest at base vs head", ref: base },
        remediation: "Confirm each addition is necessary, maintained, and licensed compatibly.",
      });
    }

    if (nonRegistry.length || movedOffRegistry.length) {
      const all = [...new Set([...nonRegistry, ...movedOffRegistry])];
      evidence.push({
        id: `dependency/non-registry-source@${file}`,
        category: "dependency",
        status: STATUS.FAIL,
        strength: STRENGTH.STRONG,
        origin: ORIGIN.INTRODUCED,
        summary: `${all.length} dependency/dependencies resolve from a non-registry source`,
        detail: all.map((n) => `${n} -> ${after.deps[n].range}`).join(", "),
        locations: [{ file }],
        provenance: { method: METHOD.OBSERVED, source: "manifest at base vs head", ref: base },
        remediation: "Git/URL/file dependencies bypass registry integrity checks; pin to a published version.",
      });
    }

    if (majorBumps.length) {
      evidence.push({
        id: `dependency/major-upgrade@${file}`,
        category: "dependency",
        status: STATUS.WARN,
        strength: STRENGTH.STRONG,
        origin: ORIGIN.INTRODUCED,
        summary: `${majorBumps.length} dependency major version bump(s) in ${file}`,
        detail: majorBumps.map((n) => `${n}: ${before.deps[n].range} -> ${after.deps[n].range}`).join(", "),
        locations: [{ file }],
        provenance: { method: METHOD.OBSERVED, source: "manifest at base vs head", ref: base },
      });
    }

    if (removed.length) {
      evidence.push({
        id: `dependency/removed@${file}`,
        category: "dependency",
        status: STATUS.WARN,
        strength: STRENGTH.STRONG,
        origin: ORIGIN.INTRODUCED,
        summary: `${removed.length} dependency/dependencies removed in ${file}`,
        detail: removed.join(", "),
        locations: [{ file }],
        provenance: { method: METHOD.OBSERVED, source: "manifest at base vs head", ref: base },
      });
    }

    const newLifecycle = LIFECYCLE.filter((k) => after.scripts[k] && after.scripts[k] !== before.scripts[k]);
    if (newLifecycle.length) {
      evidence.push({
        id: `dependency/install-hook@${file}`,
        category: "dependency",
        status: STATUS.FAIL,
        strength: STRENGTH.STRONG,
        origin: ORIGIN.INTRODUCED,
        summary: `Install-time script(s) added or changed: ${newLifecycle.join(", ")}`,
        detail: newLifecycle.map((k) => `${k}: ${after.scripts[k]}`).join("; "),
        locations: [{ file }],
        provenance: { method: METHOD.OBSERVED, source: "package.json scripts at base vs head", ref: base },
        remediation: "Install hooks run automatically on every developer and CI machine.",
      });
    }

    if (added.length || removed.length || majorBumps.length) {
      const lockTouched = touchedLocks.length > 0;
      if (!lockTouched) {
        evidence.push({
          id: `dependency/lockfile-not-updated@${file}`,
          category: "dependency",
          status: STATUS.WARN,
          strength: STRENGTH.STRONG,
          origin: ORIGIN.INTRODUCED,
          summary: "Dependencies changed but no lockfile was updated",
          detail: "Installs will resolve differently across machines until the lockfile is regenerated.",
          locations: [{ file }],
          provenance: { method: METHOD.DERIVED, source: "manifest vs lockfile change set", ref: base },
        });
      }
    }
  }

  return { evidence };
}

module.exports = {
  analyze,
  parsePackageJson,
  parseRequirements,
  parseCargoToml,
  parseGoMod,
  parseGemfile,
  majorOf,
  MANIFESTS,
  LOCKFILES,
};

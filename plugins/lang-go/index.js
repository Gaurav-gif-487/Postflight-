"use strict";
const fs = require("fs");
const path = require("path");
const { diffCycles } = require("../shared/diffCycles");
const { evidenceFromCycles } = require("../shared/evidenceFromCycles");

const isSourceFile = (f) => f.endsWith(".go");

const IMPORT_BLOCK_RE = /import\s*\(([^)]*)\)/g;
const IMPORT_SINGLE_RE = /^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/gm;
const QUOTED_RE = /"([^"]+)"/g;

// Matches both grouped ("import (\n \"a\"\n _ \"b\"\n)") and single-line
// ("import \"a\"") import declarations, ignoring blank/aliased-import
// prefixes - only the import path itself matters for cycle detection.
function extractImports(source) {
  const specs = [];
  let m;
  IMPORT_BLOCK_RE.lastIndex = 0;
  while ((m = IMPORT_BLOCK_RE.exec(source))) {
    let q;
    QUOTED_RE.lastIndex = 0;
    while ((q = QUOTED_RE.exec(m[1]))) specs.push(q[1]);
  }
  IMPORT_SINGLE_RE.lastIndex = 0;
  while ((m = IMPORT_SINGLE_RE.exec(source))) specs.push(m[1]);
  return specs;
}

function readModulePrefix(repoRoot) {
  try {
    const content = fs.readFileSync(path.join(repoRoot, "go.mod"), "utf8");
    const m = content.match(/^\s*module\s+(\S+)/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// Go imports are package-directory paths, not file paths, so cycle
// detection here is really at package granularity - this resolves an
// import path to *a* representative .go file in the matching directory
// (Go's own import graph doesn't distinguish which file in a package does
// the importing; using "any known file in that directory" is exact for
// "does a cycle exist between these packages" even though it isn't exact
// about which specific file). Only imports under this repo's own module
// prefix (from go.mod) can resolve; anything else is an external/stdlib
// package and is correctly left unresolved.
function makeResolveImport(modulePrefix) {
  return function resolveImport(fromFile, spec, knownFiles) {
    if (!modulePrefix) return null;
    let dir = null;
    if (spec === modulePrefix) dir = "";
    else if (spec.startsWith(`${modulePrefix}/`)) dir = spec.slice(modulePrefix.length + 1);
    else return null;
    const target = dir || ".";
    return [...knownFiles].find((f) => path.dirname(f) === target) || null;
  };
}

function analyze(ctx) {
  const modulePrefix = readModulePrefix(ctx.repoRoot);
  if (!modulePrefix) return [];
  const cycles = diffCycles({
    base: ctx.base,
    changedFiles: ctx.changedFiles,
    repoRoot: ctx.repoRoot,
    isSourceFile,
    extractImports,
    resolveImport: makeResolveImport(modulePrefix),
  });
  return cycles.map((cycle) => ({ cycle }));
}

module.exports = {
  metadata: { name: "lang-go", version: "0.1.0", apiVersion: 1 },
  capabilities: { languages: ["go"], categories: ["architecture"] },
  detect(ctx) {
    return ctx.changedFiles.some(isSourceFile);
  },
  analyze,
  evidence(ctx, findings) {
    return evidenceFromCycles(findings, { language: "Go", pluginName: "lang-go" });
  },
  extractImports,
  makeResolveImport,
  readModulePrefix,
  isSourceFile,
};

"use strict";
const path = require("path");
const { diffCycles } = require("../shared/diffCycles");
const { evidenceFromCycles } = require("../shared/evidenceFromCycles");

const isSourceFile = (f) => f.endsWith(".py");

// Matches "from <module> import ..." (module may carry leading dots for a
// relative import: ".", "..foo", ".foo.bar") and "import a.b, c.d as e".
// Deliberately does not try to resolve names pulled out of `import` (the
// module path is what matters for cycle detection, not what's imported
// from it).
const FROM_RE = /^\s*from\s+(\.*[\w.]*)\s+import\b/gm;
const IMPORT_RE = /^\s*import\s+([^\n#;]+)/gm;

function extractImports(source) {
  const specs = [];
  let m;
  FROM_RE.lastIndex = 0;
  while ((m = FROM_RE.exec(source))) {
    if (m[1]) specs.push(m[1]);
  }
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(source))) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (name) specs.push(name);
    }
  }
  return specs;
}

// Walks `n` directories up from `dir` ("." once we've hit the top).
function up(dir, n) {
  let d = dir;
  for (let i = 0; i < n; i++) d = path.dirname(d);
  return d === "." ? "" : d;
}

// Resolves a Python import specifier to a repo-relative file, or null if it
// can't be resolved against the known file set (external package, or an
// absolute import whose project root isn't inferable from this diff alone).
function resolveImport(fromFile, spec, knownFiles) {
  const relMatch = spec.match(/^(\.+)(.*)$/);
  let targetDir;
  let rest;
  if (relMatch) {
    // "from . import x" / "from .foo import x" / "from ..foo.bar import x":
    // one dot means "this package" (the directory containing fromFile),
    // each additional dot climbs one more directory.
    const dots = relMatch[1].length;
    rest = relMatch[2];
    targetDir = up(path.dirname(fromFile), dots - 1);
  } else {
    targetDir = "";
    rest = spec;
  }
  const restPath = rest.replace(/^\.+/, "").split(".").filter(Boolean).join("/");
  const target = restPath ? (targetDir ? `${targetDir}/${restPath}` : restPath) : targetDir;
  if (!target) return null;

  const candidates = [`${target}.py`, `${target}/__init__.py`];
  const directHit = candidates.find((c) => knownFiles.has(c));
  if (directHit) return directHit;

  if (!relMatch) {
    // Absolute import ("import foo.bar") with no repo-root match: fall
    // back to a suffix search, since real projects commonly nest the
    // importable package under a src/ (or similarly named) root that this
    // diff-local view can't otherwise infer.
    const suffixHit = [...knownFiles].find(
      (f) => f.endsWith(`/${target}.py`) || f.endsWith(`/${target}/__init__.py`)
    );
    if (suffixHit) return suffixHit;
  }
  return null;
}

function analyze(ctx) {
  const cycles = diffCycles({
    base: ctx.base,
    changedFiles: ctx.changedFiles,
    repoRoot: ctx.repoRoot,
    isSourceFile,
    extractImports,
    resolveImport,
  });
  return cycles.map((cycle) => ({ cycle }));
}

module.exports = {
  metadata: { name: "lang-python", version: "0.1.0", apiVersion: 1 },
  capabilities: { languages: ["python"], categories: ["architecture"] },
  detect(ctx) {
    return ctx.changedFiles.some(isSourceFile);
  },
  analyze,
  evidence(ctx, findings) {
    return evidenceFromCycles(findings, { language: "Python", pluginName: "lang-python" });
  },
  // exported for direct unit testing
  extractImports,
  resolveImport,
  isSourceFile,
};

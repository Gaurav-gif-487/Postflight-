"use strict";
const { diffCycles } = require("../shared/diffCycles");
const { evidenceFromCycles } = require("../shared/evidenceFromCycles");

const isSourceFile = (f) => f.endsWith(".java");

// "import com.foo.Bar;" / "import static com.foo.Bar;". Wildcard imports
// ("import com.foo.*;") don't match (the trailing "*" breaks the character
// class right before the required ";") and are deliberately skipped rather
// than resolved to "every file in that package" - that would explode the
// graph's fan-out and turn one wildcard import into dozens of spurious
// edges.
const IMPORT_RE = /^\s*import\s+(?:static\s+)?([\w.]+)\s*;/gm;

function extractImports(source) {
  const specs = [];
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(source))) specs.push(m[1]);
  return specs;
}

// Resolves a fully-qualified Java import to a repo-relative file. Java's
// package-to-path mapping is exact (dots -> slashes, ".java" suffix), the
// only ambiguity is *where* the source root starts (src/main/java, src/,
// repo root, ...), so this tries an exact repo-root match first and falls
// back to a suffix search for a nested source root.
function resolveImport(fromFile, spec, knownFiles) {
  const target = `${spec.replace(/\./g, "/")}.java`;
  if (knownFiles.has(target)) return target;
  return [...knownFiles].find((f) => f.endsWith(`/${target}`)) || null;
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
  metadata: { name: "lang-java", version: "0.1.0", apiVersion: 1 },
  capabilities: { languages: ["java"], categories: ["architecture"] },
  detect(ctx) {
    return ctx.changedFiles.some(isSourceFile);
  },
  analyze,
  evidence(ctx, findings) {
    return evidenceFromCycles(findings, { language: "Java", pluginName: "lang-java" });
  },
  extractImports,
  resolveImport,
  isSourceFile,
};

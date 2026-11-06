"use strict";

const path = require("path");
const fs = require("fs");
const git = require("../git");
const { extractImports, resolveImport } = require("./jsImportGraph");
const { STATUS, STRENGTH, ORIGIN, METHOD } = require("../evidence");

// "Five lines changed" and "five lines changed in a module 200 files import"
// are different changes. Blast radius answers: how much of the repository can
// observe this edit? It is a reverse-reachability count over the import graph,
// which is a structural fact, not a guess.

const JS_EXT = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const MAX_FILES = 4000; // hard cap keeps a monorepo scan bounded and predictable

function listSourceFiles(repoRoot) {
  let out = "";
  try {
    out = git.git(["ls-files", "--cached", "--others", "--exclude-standard"], repoRoot);
  } catch {
    return [];
  }
  return out
    .split("\n")
    .filter(Boolean)
    .filter((f) => JS_EXT.includes(path.extname(f)))
    .filter((f) => !f.includes("node_modules/"))
    .slice(0, MAX_FILES);
}

// Reverse edges: importee -> [importers]
function buildReverseGraph(files, repoRoot) {
  const known = new Set(files);
  const reverse = new Map();
  let unreadable = 0;
  for (const file of files) {
    let source;
    try {
      source = fs.readFileSync(path.join(repoRoot, file), "utf8");
    } catch {
      unreadable += 1;
      continue;
    }
    for (const spec of extractImports(source)) {
      const target = resolveImport(file, spec, known);
      if (!target) continue;
      if (!reverse.has(target)) reverse.set(target, []);
      reverse.get(target).push(file);
    }
  }
  return { reverse, unreadable, total: files.length };
}

function transitiveDependents(seed, reverse) {
  const seen = new Set();
  const queue = [...seed];
  while (queue.length) {
    const node = queue.shift();
    for (const importer of reverse.get(node) || []) {
      if (seen.has(importer)) continue;
      seen.add(importer);
      queue.push(importer);
    }
  }
  for (const s of seed) seen.delete(s);
  return seen;
}

// Thresholds are declared, not learned - they are reported alongside the
// number so a reader can disagree with the bucket while trusting the count.
const THRESHOLDS = { wide: 0.25, large: 50 };

function analyze({ base, changedFiles = [], repoRoot }) {
  const jsChanged = changedFiles.filter((f) => JS_EXT.includes(path.extname(f)));
  if (!jsChanged.length) return { evidence: [], stats: null };

  const files = listSourceFiles(repoRoot);
  if (!files.length) {
    return {
      evidence: [
        {
          id: "architecture/blast-radius-unavailable",
          category: "architecture",
          status: STATUS.UNKNOWN,
          strength: STRENGTH.MEDIUM,
          origin: ORIGIN.UNKNOWN,
          summary: "Could not enumerate source files to compute blast radius",
          detail: "git ls-files returned nothing analyzable, so the reach of this change is unmeasured.",
          provenance: { method: METHOD.OBSERVED, source: "git ls-files", ref: base },
        },
      ],
      stats: null,
    };
  }

  const { reverse, total } = buildReverseGraph(files, repoRoot);
  const seed = jsChanged.filter((f) => files.includes(f));
  const dependents = transitiveDependents(seed, reverse);
  const ratio = total ? dependents.size / total : 0;

  const perFile = seed
    .map((file) => ({ file, dependents: transitiveDependents([file], reverse).size }))
    .sort((a, b) => b.dependents - a.dependents)
    .slice(0, 5);

  const wide = ratio >= THRESHOLDS.wide || dependents.size >= THRESHOLDS.large;

  const evidence = [
    {
      id: "architecture/blast-radius",
      category: "architecture",
      status: wide ? STATUS.WARN : STATUS.PASS,
      strength: STRENGTH.MEDIUM,
      origin: ORIGIN.INTRODUCED,
      summary: wide
        ? `Wide blast radius: ${dependents.size} of ${total} source file(s) transitively import the changed modules`
        : `Contained blast radius: ${dependents.size} of ${total} source file(s) transitively import the changed modules`,
      detail: perFile.length
        ? `Highest-reach files — ${perFile.map((p) => `${p.file} (${p.dependents})`).join(", ")}`
        : null,
      locations: perFile.map((p) => ({ file: p.file })),
      provenance: { method: METHOD.DERIVED, source: "reverse import graph over tracked source files", ref: base },
      confounders: [
        "Static import edges only: dynamic requires, DI containers, and runtime registries are invisible.",
        `Bucketed with declared thresholds: wide at >=${THRESHOLDS.wide * 100}% of files or >=${THRESHOLDS.large} dependents.`,
      ],
      data: { dependents: dependents.size, totalFiles: total, ratio, perFile },
    },
  ];

  if (files.length >= MAX_FILES) {
    evidence.push({
      id: "architecture/blast-radius-truncated",
      category: "architecture",
      status: STATUS.UNKNOWN,
      strength: STRENGTH.MEDIUM,
      origin: ORIGIN.UNKNOWN,
      summary: `Blast-radius scan was capped at ${MAX_FILES} files`,
      detail: "The repository is larger than the scan cap, so the reported reach is a lower bound.",
      provenance: { method: METHOD.DERIVED, source: "blast-radius scan cap" },
    });
  }

  return { evidence, stats: { dependents: dependents.size, totalFiles: total, ratio } };
}

module.exports = { analyze, buildReverseGraph, transitiveDependents, listSourceFiles, THRESHOLDS };

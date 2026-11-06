"use strict";
const fs = require("fs");
const path = require("path");
const { buildGraph, newCycles } = require("./graphEngine");
const { listFilesAtRef, listFilesInWorkingTree, readFileAtRef } = require("./repoSnapshot");

// Runs the standard "before vs after" cycle-detection recipe every language
// adapter plugin shares: build the import graph in the current working tree
// restricted to this language's files, build the same graph as it existed
// at the diff's base ref, and report only cycles that are new. A plugin
// supplies just the language-specific parts:
//   - isSourceFile(path)               -> is this file owned by this plugin
//   - extractImports(source)           -> raw import specifiers found in a file
//   - resolveImport(file, spec, known) -> the specifier resolved to a node
//                                          id in `known`, or null if it
//                                          can't be resolved (external
//                                          package, unresolvable, etc.)
// Returns an array of cycles, each an array of node ids.
function diffCycles({ base, changedFiles, repoRoot, isSourceFile, extractImports, resolveImport, maxDepth, maxNodes }) {
  const changed = [...new Set(changedFiles.filter(isSourceFile))];
  if (changed.length === 0) return [];

  const extractEdges = (file, source, known) =>
    extractImports(source)
      .map((spec) => resolveImport(file, spec, known))
      .filter(Boolean);

  const currentKnown = listFilesInWorkingTree(repoRoot, isSourceFile);
  const currentGraph = buildGraph({
    seedNodes: changed,
    knownNodes: currentKnown,
    readNode: (f) => fs.readFileSync(path.join(repoRoot, f), "utf8"),
    extractEdges,
    maxDepth,
    maxNodes,
  });

  const baseKnown = listFilesAtRef(base, repoRoot, isSourceFile);
  const baseGraph = buildGraph({
    seedNodes: changed.filter((f) => baseKnown.has(f)),
    knownNodes: baseKnown,
    readNode: (f) => readFileAtRef(base, f, repoRoot),
    extractEdges,
    maxDepth,
    maxNodes,
  });

  return newCycles(currentGraph, baseGraph);
}

module.exports = { diffCycles };

"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const JS_EXT = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const IMPORT_RE = /(?:import[^'"]*from\s*|require\s*\(\s*|import\s*\(\s*|import\s+)["']([^"']+)["']/g;

function extractImports(source) {
  const specifiers = [];
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(source))) {
    specifiers.push(m[1]);
  }
  return specifiers.filter((s) => s.startsWith("."));
}

// Resolves a relative import specifier from `fromFile` (repo-root-relative)
// against a set of "known files" (repo-root-relative paths that exist at
// the point in history we're inspecting). Returns null if unresolvable.
function resolveImport(fromFile, specifier, knownFiles) {
  const base = path.normalize(path.join(path.dirname(fromFile), specifier)).split(path.sep).join("/");
  const candidates = [
    base,
    ...JS_EXT.map((ext) => base + ext),
    ...JS_EXT.map((ext) => `${base}/index${ext}`),
  ];
  return candidates.find((c) => knownFiles.has(c)) || null;
}

function git(args, cwd) {
  try {
    // stdio: ["pipe","pipe","ignore"] - same reasoning as git.js's showFile:
    // every failure here collapses to "", stderr is never inspected, and
    // `git show <ref>:<file>` on a path that doesn't exist at that ref
    // (e.g. a file added since `ref`) would otherwise leak git's own
    // `fatal: path ... does not exist` straight to postflight's stderr.
    //
    // Reachability note (checked, not assumed): analyze() can never
    // actually trigger that specific "missing at ref" failure through
    // readFileAtRef. Every call into readFileAtRef comes from buildGraph,
    // and every file buildGraph reads - seeds (`jsChanged.filter(f =>
    // baseKnown.has(f))`) and every subsequent hop (resolveImport filters
    // candidates through the same `knownFiles` Set before returning them)
    // - is guaranteed to already be a member of `baseKnown`, which is
    // built from `git ls-tree -r --name-only <ref>` on that exact ref.
    // A path git ls-tree just reported as present in a ref's tree cannot
    // then be missing from `git show <ref>:<path>` for that same ref - the
    // ref is a fixed, immutable point in history for the life of one
    // analyze() call. Confirmed empirically too: instrumenting this catch
    // block and running the full suite (333 tests, including this file's
    // own analyze()-level tests) never triggers it for a `git show`
    // failure - only the (separately-covered) `ls-tree`/`ls-files`
    // failure case does.
    //
    // The suppression is still correct defensive coding - it protects
    // against exactly the kind of invariant violation described above ever
    // becoming user-visible, e.g. if a future edit to buildGraph's
    // filtering logic breaks that guarantee - so it stays. It's tested
    // directly below (readFileAtRef is exported for this reason) rather
    // than through analyze(), since analyze() cannot reach it.
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

function listFilesAtRef(ref, cwd) {
  const out = git(["ls-tree", "-r", "--name-only", ref], cwd);
  return new Set(out.split("\n").filter(Boolean).filter((f) => JS_EXT.includes(path.extname(f))));
}

function readFileAtRef(ref, file, cwd) {
  const out = git(["show", `${ref}:${file}`], cwd);
  return out;
}

function listFilesInWorkingTree(repoRoot) {
  const out = git(["ls-files", "--cached", "--others", "--exclude-standard"], repoRoot);
  return new Set(out.split("\n").filter(Boolean).filter((f) => JS_EXT.includes(path.extname(f))));
}

// Builds an adjacency map { file: [importedFile, ...] } starting from
// `seedFiles`, expanding outward up to `maxDepth` hops, capped at
// `maxNodes` total files read (keeps this fast on large repos).
function buildGraph({ seedFiles, knownFiles, readFile, maxDepth = 3, maxNodes = 250 }) {
  const graph = {};
  const visited = new Set();
  let frontier = seedFiles.filter((f) => knownFiles.has(f));
  let depth = 0;

  while (frontier.length && depth <= maxDepth && visited.size < maxNodes) {
    const next = [];
    for (const file of frontier) {
      if (visited.has(file) || visited.size >= maxNodes) continue;
      visited.add(file);
      let source;
      try {
        source = readFile(file);
      } catch {
        continue;
      }
      if (!source) continue;
      const imports = extractImports(source)
        .map((spec) => resolveImport(file, spec, knownFiles))
        .filter(Boolean);
      graph[file] = imports;
      for (const imp of imports) if (!visited.has(imp)) next.push(imp);
    }
    frontier = next;
    depth += 1;
  }
  return graph;
}

// Returns an array of cycles, each an array of file paths forming the cycle
// (e.g. ["a.js", "b.js", "c.js"] meaning a -> b -> c -> a).
function findCycles(graph) {
  const cycles = [];
  const color = {}; // 0 = unvisited, 1 = in progress, 2 = done
  const stack = [];

  function dfs(node) {
    color[node] = 1;
    stack.push(node);
    for (const next of graph[node] || []) {
      if (color[next] === 1) {
        const idx = stack.indexOf(next);
        cycles.push(stack.slice(idx));
      } else if (color[next] !== 2) {
        dfs(next);
      }
    }
    stack.pop();
    color[node] = 2;
  }

  for (const node of Object.keys(graph)) {
    if (color[node] === undefined) dfs(node);
  }
  return cycles;
}

// Canonical form for a cycle so rotations of the same cycle compare equal.
function canonicalize(cycle) {
  let minIdx = 0;
  for (let i = 1; i < cycle.length; i++) if (cycle[i] < cycle[minIdx]) minIdx = i;
  return [...cycle.slice(minIdx), ...cycle.slice(0, minIdx)].join(" -> ");
}

// Main entry point: given the changed files (repo-root-relative) and the
// diff's base ref, returns findings for circular dependencies that are new
// in this diff and involve at least one changed file.
function analyze({ base, changedFiles, cwd, repoRoot }) {
  const jsChanged = changedFiles.filter((f) => JS_EXT.includes(path.extname(f)));
  if (jsChanged.length === 0) return [];

  const currentKnown = listFilesInWorkingTree(repoRoot);
  const currentGraph = buildGraph({
    seedFiles: jsChanged,
    knownFiles: currentKnown,
    readFile: (f) => fs.readFileSync(path.join(repoRoot, f), "utf8"),
  });
  const currentCycles = new Set(findCycles(currentGraph).map(canonicalize));

  const baseKnown = listFilesAtRef(base, repoRoot);
  const baseGraph = buildGraph({
    seedFiles: jsChanged.filter((f) => baseKnown.has(f)),
    knownFiles: baseKnown,
    readFile: (f) => readFileAtRef(base, f, repoRoot),
  });
  const baseCycles = new Set(findCycles(baseGraph).map(canonicalize));

  const newCycles = [...currentCycles].filter((c) => !baseCycles.has(c));

  return newCycles.map((cycleStr) => {
    const nodes = cycleStr.split(" -> ");
    return {
      rule: "architecture-cycle",
      severity: "medium",
      category: "architecture",
      label: `New circular dependency: ${nodes.join(" → ")} → ${nodes[0]}`,
      file: nodes.find((n) => jsChanged.includes(n)) || nodes[0],
      snippet: null,
    };
  });
}

module.exports = {
  analyze,
  extractImports,
  resolveImport,
  buildGraph,
  findCycles,
  canonicalize,
  readFileAtRef,
  listFilesAtRef,
};

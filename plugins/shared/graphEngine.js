"use strict";

// Generic import-graph engine shared by postflight's first-party language
// adapter plugins (plugins/lang-*). This is a direct generalization of
// src/analyzers/jsImportGraph.js's graph/cycle logic: that module is left
// untouched (it's already shipped and tested against its own exports), but
// the underlying algorithm - build an adjacency map from a set of seeds,
// find cycles in it, diff two such graphs to find *new* cycles - is
// language-agnostic. Node identity is deliberately opaque: a node is
// whatever string a plugin's resolveImport() returns (a file path for
// Python/Rust/Java, since those languages import by file/module; a
// representative file for Go's directory-scoped packages - see
// plugins/lang-go). The engine itself never inspects node contents.

// Builds an adjacency map { node: [neighborNode, ...] } starting from
// `seedNodes`, expanding outward up to `maxDepth` hops, capped at
// `maxNodes` total nodes visited (keeps this bounded on large repos).
//   - readNode(node) -> source text for that node (throws/empty -> leaf)
//   - extractEdges(node, source, knownNodes) -> array of neighbor nodes
function buildGraph({ seedNodes, knownNodes, readNode, extractEdges, maxDepth = 3, maxNodes = 250 }) {
  const graph = {};
  const visited = new Set();
  let frontier = seedNodes.filter((n) => knownNodes.has(n));
  let depth = 0;

  while (frontier.length && depth <= maxDepth && visited.size < maxNodes) {
    const next = [];
    for (const node of frontier) {
      if (visited.has(node) || visited.size >= maxNodes) continue;
      visited.add(node);
      let source;
      try {
        source = readNode(node);
      } catch {
        graph[node] = [];
        continue;
      }
      if (!source) {
        graph[node] = [];
        continue;
      }
      const edges = extractEdges(node, source, knownNodes) || [];
      graph[node] = edges;
      for (const e of edges) if (!visited.has(e)) next.push(e);
    }
    frontier = next;
    depth += 1;
  }
  return graph;
}

// Returns an array of cycles, each an array of node ids forming the cycle
// (e.g. ["a", "b", "c"] meaning a -> b -> c -> a).
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

// Canonical string form for a cycle so rotations of the same cycle compare
// equal (e.g. [a,b,c] and [b,c,a] are the same cycle).
function canonicalize(cycle) {
  let minIdx = 0;
  for (let i = 1; i < cycle.length; i++) if (cycle[i] < cycle[minIdx]) minIdx = i;
  return [...cycle.slice(minIdx), ...cycle.slice(0, minIdx)].join(" -> ");
}

// Diffs cycles present in `currentGraph` against `baseGraph` and returns
// only the ones that are new - present now, absent at base - as arrays of
// node ids (deduped, order-stable). This is what lets a plugin built on
// this engine set evidence.origin honestly to ORIGIN.INTRODUCED rather than
// flagging every pre-existing cycle on every unrelated diff.
function newCycles(currentGraph, baseGraph) {
  const baseCanon = new Set(findCycles(baseGraph).map(canonicalize));
  const seen = new Set();
  const result = [];
  for (const cyc of findCycles(currentGraph)) {
    const c = canonicalize(cyc);
    if (seen.has(c) || baseCanon.has(c)) continue;
    seen.add(c);
    result.push(c.split(" -> "));
  }
  return result;
}

module.exports = { buildGraph, findCycles, canonicalize, newCycles };

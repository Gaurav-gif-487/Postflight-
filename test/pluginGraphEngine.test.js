"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildGraph, findCycles, canonicalize, newCycles } = require("../plugins/shared/graphEngine");

test("findCycles: detects a simple two-node cycle", () => {
  const graph = { a: ["b"], b: ["a"] };
  const cycles = findCycles(graph).map(canonicalize);
  assert.equal(cycles.length, 1);
});

test("findCycles: reports no cycle for a DAG", () => {
  const graph = { a: ["b"], b: ["c"], c: [] };
  assert.deepEqual(findCycles(graph), []);
});

test("canonicalize: rotations of the same cycle compare equal", () => {
  assert.equal(canonicalize(["a", "b", "c"]), canonicalize(["b", "c", "a"]));
});

test("buildGraph: expands from seeds via extractEdges, bounded by knownNodes", () => {
  const known = new Set(["a", "b", "c"]); // "external" is deliberately absent
  const source = { a: "b,external", b: "c", c: "" };
  const graph = buildGraph({
    seedNodes: ["a"],
    knownNodes: known,
    readNode: (n) => source[n],
    extractEdges: (node, src, k) => src.split(",").filter((s) => s && k.has(s)),
  });
  assert.deepEqual(graph.a, ["b"]); // "external" filtered out by extractEdges since it's unknown
  assert.deepEqual(graph.b, ["c"]);
  assert.deepEqual(graph.c, []);
});

test("buildGraph: a node outside knownNodes is never visited as a seed", () => {
  const graph = buildGraph({
    seedNodes: ["missing"],
    knownNodes: new Set(["a"]),
    readNode: () => "",
    extractEdges: () => [],
  });
  assert.deepEqual(graph, {});
});

test("buildGraph: readNode throwing degrades that node to a leaf instead of crashing", () => {
  const graph = buildGraph({
    seedNodes: ["a"],
    knownNodes: new Set(["a"]),
    readNode: () => {
      throw new Error("unreadable");
    },
    extractEdges: () => {
      throw new Error("should never be called");
    },
  });
  assert.deepEqual(graph.a, []);
});

test("buildGraph: respects maxNodes cap", () => {
  const known = new Set(["a", "b", "c", "d"]);
  const chain = { a: ["b"], b: ["c"], c: ["d"], d: [] };
  const graph = buildGraph({
    seedNodes: ["a"],
    knownNodes: known,
    readNode: (n) => n,
    extractEdges: (n) => chain[n],
    maxNodes: 2,
  });
  assert.ok(Object.keys(graph).length <= 2);
});

test("newCycles: a cycle present in both graphs is not reported (pre-existing, not introduced)", () => {
  const graph = { a: ["b"], b: ["a"] };
  assert.deepEqual(newCycles(graph, graph), []);
});

test("newCycles: a cycle absent at base but present now is reported", () => {
  const current = { a: ["b"], b: ["a"] };
  const base = { a: [], b: [] };
  const result = newCycles(current, base);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].sort(), ["a", "b"]);
});

test("newCycles: dedupes rotations of the same cycle into one result", () => {
  // findCycles can report the same cycle starting from different nodes
  // depending on traversal order; newCycles must not double-report it.
  const current = { a: ["b"], b: ["c"], c: ["a"] };
  const result = newCycles(current, {});
  assert.equal(result.length, 1);
});

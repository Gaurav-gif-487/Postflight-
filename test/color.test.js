"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveColor, makeColorizer } = require("../src/color");

test("color: makeColorizer(false) returns plain text with no ANSI codes", () => {
  const c = makeColorizer(false);
  assert.equal(c.red("x"), "x");
  assert.equal(c.bold("y"), "y");
  assert.equal(c.enabled, false);
});

test("color: makeColorizer(true) wraps text in ANSI escape codes", () => {
  const c = makeColorizer(true);
  assert.equal(c.red("x"), "\u001b[31mx\u001b[0m");
  assert.equal(c.green("y"), "\u001b[32my\u001b[0m");
  assert.equal(c.enabled, true);
});

test("color: resolveColor with noColor:true is always disabled", () => {
  const c = resolveColor({ noColor: true, stream: { isTTY: true } });
  assert.equal(c.enabled, false);
});

test("color: resolveColor honors NO_COLOR env var over a TTY stream", () => {
  const prev = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
  try {
    const c = resolveColor({ stream: { isTTY: true } });
    assert.equal(c.enabled, false);
  } finally {
    if (prev === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = prev;
  }
});

test("color: resolveColor is enabled only for a real TTY stream", () => {
  const prev = process.env.NO_COLOR;
  delete process.env.NO_COLOR;
  try {
    assert.equal(resolveColor({ stream: { isTTY: true } }).enabled, true);
    assert.equal(resolveColor({ stream: { isTTY: false } }).enabled, false);
    assert.equal(resolveColor({ stream: undefined }).enabled, false);
  } finally {
    if (prev !== undefined) process.env.NO_COLOR = prev;
  }
});

test("color: colorizer values round-trip through String() correctly for numbers", () => {
  const c = makeColorizer(true);
  assert.equal(c.red(42), "\u001b[31m42\u001b[0m");
});

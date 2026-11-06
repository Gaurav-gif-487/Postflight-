"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { PerfTracker } = require("../src/perf");

test("PerfTracker: time() records a phase's duration and returns fn's value unchanged", () => {
  const perf = new PerfTracker();
  const result = perf.time("work", () => {
    let x = 0;
    for (let i = 0; i < 1e5; i++) x += i;
    return x;
  });
  assert.equal(result, 4999950000);
  const json = perf.toJSON();
  assert.ok(json.phases.work >= 0);
  assert.ok(json.totalMs >= 0);
});

test("PerfTracker: repeated time() calls with the same label accumulate rather than overwrite", () => {
  const perf = new PerfTracker();
  perf.record("test", 10);
  perf.record("test", 15);
  assert.equal(perf.toJSON().phases.test, 25);
});

test("PerfTracker: time() still records the phase duration when fn throws", () => {
  const perf = new PerfTracker();
  assert.throws(() => {
    perf.time("boom", () => {
      throw new Error("nope");
    });
  });
  assert.ok("boom" in perf.toJSON().phases);
});

test("PerfTracker: record() with a null/undefined duration is a silent no-op", () => {
  const perf = new PerfTracker();
  perf.record("test", null);
  perf.record("test", undefined);
  assert.equal("test" in perf.toJSON().phases, false);
});

test("PerfTracker: toJSON() never throws and always has totalMs/phases", () => {
  const perf = new PerfTracker();
  const json = perf.toJSON();
  assert.ok(typeof json.totalMs === "number");
  assert.deepEqual(json.phases, {});
});

"use strict";

// Lightweight runtime instrumentation for a single postflight run. This is
// deliberately not a profiler or a metrics-collection service - just enough
// to answer "which phase of this run took the time?" and "did the coverage
// cache actually save a re-parse this run?" in --format json/--proof output,
// where a slow CI run currently has no visibility into where the time went
// beyond staring at wall-clock CI logs.
//
// Never throws, never blocks: a phase that isn't timed just doesn't appear
// in the output, same "absence, not fabrication" discipline as the rest of
// postflight (see docs/evidence-model.md).

class PerfTracker {
  constructor() {
    this._phases = {};
    this._start = Date.now();
  }

  // Times a synchronous phase and records its duration under `label`.
  // Returns whatever `fn` returns, unmodified.
  time(label, fn) {
    const start = Date.now();
    try {
      return fn();
    } finally {
      this._phases[label] = (this._phases[label] || 0) + (Date.now() - start);
    }
  }

  // For phases that already produced a { durationMs } result elsewhere
  // (e.g. src/run.js's runCommand) - records it without re-timing.
  record(label, durationMs) {
    if (durationMs == null) return;
    this._phases[label] = (this._phases[label] || 0) + durationMs;
  }

  toJSON() {
    return {
      totalMs: Date.now() - this._start,
      phases: { ...this._phases },
    };
  }
}

module.exports = { PerfTracker };

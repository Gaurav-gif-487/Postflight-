"use strict";

// Turns `{ cycle: [nodeId, ...] }` findings (what every language adapter's
// analyze() produces) into evidence-schema objects (docs/evidence-model.md).
// Shared so the four adapters report cycles identically and any future one
// gets this for free.
//
// strength/provenance.method are intentionally left as heuristic/WEAK
// (see docs/plugin-api.md's "Evidence rules"): these adapters find cycles
// with regex-based import extraction, not a real parser or compiler, so
// they are not presumed as trustworthy as an executed command. A future
// adapter that shells out to a real toolchain (e.g. `go list`, `cargo
// metadata`) could justifiably report `provenance.method: "observed"` and
// a higher strength instead.
function evidenceFromCycles(findings, { language, pluginName }) {
  return findings.map((f, i) => {
    const nodes = f.cycle;
    return {
      id: `import-cycle@${nodes[0]}#${i + 1}`,
      category: "architecture",
      status: "WARN",
      origin: "INTRODUCED",
      summary: `New ${language} import cycle: ${nodes.join(" \u2192 ")} \u2192 ${nodes[0]}`,
      detail: `Cycle detected by regex-based import extraction, not a full ${language} parser - verify manually before treating this as authoritative.`,
      locations: nodes.map((file) => ({ file })),
      provenance: { method: "heuristic", source: `plugin:${pluginName}` },
    };
  });
}

module.exports = { evidenceFromCycles };

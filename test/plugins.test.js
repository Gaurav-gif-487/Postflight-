"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { validatePlugin, loadPlugin, loadPlugins, collectPluginEvidence, API_VERSION } = require("../src/plugins");

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "postflight-plugin-"));
}

test("validatePlugin: rejects a plugin missing required functions", () => {
  const { valid, errors } = validatePlugin({ metadata: { name: "x", version: "1.0.0" } }, "x.js");
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("detect")));
  assert.ok(errors.some((e) => e.includes("analyze")));
  assert.ok(errors.some((e) => e.includes("evidence")));
});

test("validatePlugin: rejects a plugin missing metadata.name/version", () => {
  const { valid, errors } = validatePlugin(
    { detect: () => true, analyze: () => [], evidence: () => [] },
    "x.js"
  );
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("metadata.name")));
  assert.ok(errors.some((e) => e.includes("metadata.version")));
});

test("validatePlugin: rejects a mismatched apiVersion", () => {
  const { valid, errors } = validatePlugin(
    {
      metadata: { name: "x", version: "1.0.0", apiVersion: API_VERSION + 1 },
      detect: () => true,
      analyze: () => [],
      evidence: () => [],
    },
    "x.js"
  );
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("apiVersion")));
});

test("validatePlugin: accepts a well-formed plugin", () => {
  const { valid, errors } = validatePlugin(
    {
      metadata: { name: "rust-adapter", version: "0.1.0", apiVersion: API_VERSION },
      capabilities: { languages: ["rust"] },
      detect: () => true,
      analyze: () => [],
      evidence: () => [],
    },
    "x.js"
  );
  assert.equal(valid, true);
  assert.deepEqual(errors, []);
});

test("loadPlugin: loads and validates a plugin from a relative repo path", () => {
  const dir = tmpdir();
  fs.writeFileSync(
    path.join(dir, "plugin.js"),
    `module.exports = { metadata: { name: "p", version: "1.0.0" }, detect: () => true, analyze: () => [], evidence: () => [] };`
  );
  const result = loadPlugin("./plugin.js", dir);
  assert.equal(result.ok, true);
  assert.equal(result.plugin.metadata.name, "p");
});

test("loadPlugin: a nonexistent path fails to load without throwing", () => {
  const result = loadPlugin("./does-not-exist.js", tmpdir());
  assert.equal(result.ok, false);
  assert.ok(result.errors[0].includes("failed to load"));
});

test("loadPlugins: partitions configured plugins into loaded/failed", () => {
  const dir = tmpdir();
  fs.writeFileSync(
    path.join(dir, "good.js"),
    `module.exports = { metadata: { name: "good", version: "1.0.0" }, detect: () => true, analyze: () => [], evidence: () => [] };`
  );
  const { loaded, failed } = loadPlugins({ plugins: ["./good.js", "./missing.js"] }, dir);
  assert.equal(loaded.length, 1);
  assert.equal(failed.length, 1);
});

test("collectPluginEvidence: a plugin that throws produces a limitation, not a crash", () => {
  const badPlugin = {
    metadata: { name: "bad", version: "1.0.0" },
    detect: () => true,
    analyze: () => {
      throw new Error("boom");
    },
    evidence: () => [],
  };
  const { evidence, limitations } = collectPluginEvidence([{ plugin: badPlugin, source: "bad.js" }], {});
  assert.deepEqual(evidence, []);
  assert.equal(limitations.length, 1);
  assert.match(limitations[0].summary, /boom/);
});

test("collectPluginEvidence: a plugin that returns malformed evidence is skipped, not crashed on", () => {
  const plugin = {
    metadata: { name: "malformed", version: "1.0.0" },
    detect: () => true,
    analyze: () => [{}],
    evidence: () => [{ /* no category/summary/provenance */ }],
  };
  const { evidence, limitations } = collectPluginEvidence([{ plugin, source: "m.js" }], {});
  assert.deepEqual(evidence, []);
  assert.equal(limitations.length, 1);
});

test("collectPluginEvidence: valid evidence is namespaced under plugin/<name>/<id> and defaults to WEAK/HEURISTIC", () => {
  const plugin = {
    metadata: { name: "go-adapter", version: "1.0.0" },
    detect: () => true,
    analyze: () => [{ file: "main.go" }],
    evidence: () => [{ id: "unused-import", category: "architecture", status: "WARN", summary: "unused import" }],
  };
  const { evidence, limitations } = collectPluginEvidence([{ plugin, source: "go.js" }], {});
  assert.deepEqual(limitations, []);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].id, "plugin/go-adapter/unused-import");
  assert.equal(evidence[0].strength, "WEAK");
  assert.equal(evidence[0].provenance.source, "plugin:go-adapter");
});

test("collectPluginEvidence: detect() returning false skips the plugin entirely", () => {
  let analyzed = false;
  const plugin = {
    metadata: { name: "skip-me", version: "1.0.0" },
    detect: () => false,
    analyze: () => {
      analyzed = true;
      return [];
    },
    evidence: () => [],
  };
  const { evidence } = collectPluginEvidence([{ plugin, source: "s.js" }], {});
  assert.equal(analyzed, false);
  assert.deepEqual(evidence, []);
});

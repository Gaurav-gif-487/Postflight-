"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadConfig, isIgnored, DEFAULTS } = require("../src/config");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "postflight-config-test-"));
}

test("config: loadConfig returns defaults when no config file exists", () => {
  const dir = tmpDir();
  const config = loadConfig(dir);
  assert.deepEqual(config.ignore, DEFAULTS.ignore);
  assert.deepEqual(config.testMapping, DEFAULTS.testMapping);
  assert.deepEqual(config.testDirs, DEFAULTS.testDirs);
  assert.equal(config._source, null);
});

test("config: loadConfig reads a declared testDirs mapping through end to end", () => {
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, "postflight.config.json"),
    JSON.stringify({ testDirs: [{ from: "src/jvmMain", to: "src/jvmTest" }] })
  );
  const config = loadConfig(dir);
  assert.deepEqual(config.testDirs, [{ from: "src/jvmMain", to: "src/jvmTest" }]);
});

test("config: loadConfig reads and merges postflight.config.json", () => {
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, "postflight.config.json"),
    JSON.stringify({ ignore: ["vendor/"], severityOverrides: { "todo-added": "high" } })
  );
  const config = loadConfig(dir);
  assert.deepEqual(config.ignore, ["vendor/"]);
  assert.deepEqual(config.severityOverrides, { "todo-added": "high" });
  assert.equal(config._source, "postflight.config.json");
});

test("config: loadConfig falls back to .postflightrc.json", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, ".postflightrc.json"), JSON.stringify({ ignore: ["dist/"] }));
  const config = loadConfig(dir);
  assert.deepEqual(config.ignore, ["dist/"]);
  assert.equal(config._source, ".postflightrc.json");
});

test("config: loadConfig degrades to defaults on invalid JSON rather than throwing", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "postflight.config.json"), "{ not valid json");
  const config = loadConfig(dir);
  assert.deepEqual(config.ignore, DEFAULTS.ignore);
  assert.equal(config._source, null);
});

test("isIgnored: matches an exact path", () => {
  assert.ok(isIgnored("vendor/lib.js", { ignore: ["vendor/lib.js"] }));
  assert.ok(!isIgnored("src/lib.js", { ignore: ["vendor/lib.js"] }));
});

test("isIgnored: matches a directory prefix", () => {
  assert.ok(isIgnored("vendor/deep/lib.js", { ignore: ["vendor/"] }));
});

test("isIgnored: a wildcard suffix is stripped to a prefix match", () => {
  assert.ok(isIgnored("generated/x.js", { ignore: ["generated/*"] }));
});

test("isIgnored: returns false for a null/undefined file", () => {
  assert.equal(isIgnored(null, { ignore: ["vendor/"] }), false);
  assert.equal(isIgnored(undefined, { ignore: ["vendor/"] }), false);
});

test("isIgnored: an empty ignore list ignores nothing", () => {
  assert.equal(isIgnored("anything.js", { ignore: [] }), false);
});

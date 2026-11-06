"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { validatePlugin } = require("../src/plugins");
const plugin = require("../plugins/lang-go");
const { extractImports, makeResolveImport, readModulePrefix } = plugin;

test("lang-go: is a valid plugin per the plugin API contract", () => {
  const { valid, errors } = validatePlugin(plugin, "lang-go");
  assert.equal(valid, true, errors.join("; "));
});

test("extractImports: grouped import block", () => {
  const src = `
package main

import (
	"fmt"
	alias "example.com/mod/internal/util"
	_ "example.com/mod/internal/plugins"
)
`;
  assert.deepEqual(extractImports(src), ["fmt", "example.com/mod/internal/util", "example.com/mod/internal/plugins"]);
});

test("extractImports: single-line import", () => {
  const src = `import "example.com/mod/internal/util"\n`;
  assert.deepEqual(extractImports(src), ["example.com/mod/internal/util"]);
});

test("readModulePrefix: reads the module path from go.mod", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postflight-go-plugin-test-"));
  fs.writeFileSync(path.join(dir, "go.mod"), "module example.com/mod\n\ngo 1.22\n");
  assert.equal(readModulePrefix(dir), "example.com/mod");
});

test("readModulePrefix: missing go.mod returns null instead of throwing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postflight-go-plugin-test-"));
  assert.doesNotThrow(() => readModulePrefix(dir));
  assert.equal(readModulePrefix(dir), null);
});

test("resolveImport: an internal package import resolves to a file in that directory", () => {
  const resolveImport = makeResolveImport("example.com/mod");
  const known = new Set(["main.go", "internal/util/util.go", "internal/util/helpers.go"]);
  assert.equal(resolveImport("main.go", "example.com/mod/internal/util", known), "internal/util/util.go");
});

test("resolveImport: the module root itself resolves to a root-level file", () => {
  const resolveImport = makeResolveImport("example.com/mod");
  const known = new Set(["main.go", "helpers.go"]);
  assert.ok(["main.go", "helpers.go"].includes(resolveImport("main.go", "example.com/mod", known)));
});

test("resolveImport: an external/stdlib import returns null", () => {
  const resolveImport = makeResolveImport("example.com/mod");
  const known = new Set(["main.go"]);
  assert.equal(resolveImport("main.go", "fmt", known), null);
  assert.equal(resolveImport("main.go", "github.com/other/pkg", known), null);
});

test("resolveImport: without a module prefix, nothing resolves", () => {
  const resolveImport = makeResolveImport(null);
  const known = new Set(["main.go"]);
  assert.equal(resolveImport("main.go", "example.com/mod/internal/util", known), null);
});

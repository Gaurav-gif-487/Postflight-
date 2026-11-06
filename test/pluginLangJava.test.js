"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { validatePlugin } = require("../src/plugins");
const plugin = require("../plugins/lang-java");
const { extractImports, resolveImport } = plugin;

test("lang-java: is a valid plugin per the plugin API contract", () => {
  const { valid, errors } = validatePlugin(plugin, "lang-java");
  assert.equal(valid, true, errors.join("; "));
});

test("extractImports: plain and static imports, wildcard imports skipped", () => {
  const src = `
package com.example.app;

import com.example.app.model.User;
import static com.example.app.util.Constants.MAX;
import com.example.app.service.*;
`;
  assert.deepEqual(extractImports(src), ["com.example.app.model.User", "com.example.app.util.Constants.MAX"]);
});

test("resolveImport: exact repo-root match", () => {
  const known = new Set(["com/example/app/model/User.java", "com/example/app/Main.java"]);
  assert.equal(
    resolveImport("com/example/app/Main.java", "com.example.app.model.User", known),
    "com/example/app/model/User.java"
  );
});

test("resolveImport: falls back to a suffix match under a nested source root", () => {
  const known = new Set(["src/main/java/com/example/app/model/User.java", "src/main/java/com/example/app/Main.java"]);
  assert.equal(
    resolveImport("src/main/java/com/example/app/Main.java", "com.example.app.model.User", known),
    "src/main/java/com/example/app/model/User.java"
  );
});

test("resolveImport: an unresolvable import (e.g. a JDK/library class) returns null", () => {
  const known = new Set(["com/example/app/Main.java"]);
  assert.equal(resolveImport("com/example/app/Main.java", "java.util.List", known), null);
});

"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { validatePlugin } = require("../src/plugins");
const plugin = require("../plugins/lang-python");
const { extractImports, resolveImport } = plugin;

test("lang-python: is a valid plugin per the plugin API contract", () => {
  const { valid, errors } = validatePlugin(plugin, "lang-python");
  assert.equal(valid, true, errors.join("; "));
});

test("extractImports: plain and dotted absolute imports", () => {
  const src = `
import os
import a.b.c
import x.y as z, w
`;
  assert.deepEqual(extractImports(src).sort(), ["a.b.c", "os", "w", "x.y"].sort());
});

test("extractImports: from-imports including relative forms", () => {
  const src = `
from foo.bar import baz
from . import sibling
from .helpers import thing
from ..pkg import other
`;
  assert.deepEqual(extractImports(src).sort(), ["..pkg", ".", ".helpers", "foo.bar"].sort());
});

test("resolveImport: 'from . import x' resolves within the same package", () => {
  const known = new Set(["app/__init__.py", "app/models.py", "app/views.py"]);
  assert.equal(resolveImport("app/views.py", ".", known), "app/__init__.py");
});

test("resolveImport: 'from .models import X' resolves a sibling module", () => {
  const known = new Set(["app/models.py", "app/views.py"]);
  assert.equal(resolveImport("app/views.py", ".models", known), "app/models.py");
});

test("resolveImport: '..' climbs an extra directory level", () => {
  const known = new Set(["app/sub/deep.py", "app/top.py"]);
  assert.equal(resolveImport("app/sub/deep.py", "..top", known), "app/top.py");
});

test("resolveImport: absolute dotted import resolves at repo root", () => {
  const known = new Set(["app/models.py", "app/views.py"]);
  assert.equal(resolveImport("app/views.py", "app.models", known), "app/models.py");
});

test("resolveImport: absolute import falls back to a suffix match under a src/ root", () => {
  const known = new Set(["src/app/models.py", "src/app/views.py"]);
  assert.equal(resolveImport("src/app/views.py", "app.models", known), "src/app/models.py");
});

test("resolveImport: package import resolves to __init__.py", () => {
  const known = new Set(["app/sub/__init__.py", "app/views.py"]);
  assert.equal(resolveImport("app/views.py", "app.sub", known), "app/sub/__init__.py");
});

test("resolveImport: an external/unresolvable import returns null", () => {
  const known = new Set(["app/views.py"]);
  assert.equal(resolveImport("app/views.py", "numpy", known), null);
});

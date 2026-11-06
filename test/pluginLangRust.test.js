"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { validatePlugin } = require("../src/plugins");
const plugin = require("../plugins/lang-rust");
const { extractImports, resolveImport } = plugin;

test("lang-rust: is a valid plugin per the plugin API contract", () => {
  const { valid, errors } = validatePlugin(plugin, "lang-rust");
  assert.equal(valid, true, errors.join("; "));
});

test("extractImports: 'mod x;' declarations but not inline 'mod x { ... }'", () => {
  const src = `
mod foo;
pub mod bar;
mod inline { pub fn f() {} }
`;
  assert.deepEqual(extractImports(src), ["mod:foo", "mod:bar"]);
});

test("extractImports: 'use crate::...' paths", () => {
  const src = `
use crate::foo::Bar;
pub use crate::baz::qux::Thing;
use std::collections::HashMap;
`;
  assert.deepEqual(extractImports(src), ["use:crate::foo::Bar", "use:crate::baz::qux::Thing"]);
});

test("resolveImport: 'mod foo;' resolves to a sibling foo.rs", () => {
  const known = new Set(["src/lib.rs", "src/foo.rs"]);
  assert.equal(resolveImport("src/lib.rs", "mod:foo", known), "src/foo.rs");
});

test("resolveImport: 'mod foo;' resolves to foo/mod.rs when that's what exists", () => {
  const known = new Set(["src/lib.rs", "src/foo/mod.rs"]);
  assert.equal(resolveImport("src/lib.rs", "mod:foo", known), "src/foo/mod.rs");
});

test("resolveImport: 'use crate::a::b;' resolves to src/a/b.rs", () => {
  const known = new Set(["src/lib.rs", "src/a/b.rs"]);
  assert.equal(resolveImport("src/lib.rs", "use:crate::a::b", known), "src/a/b.rs");
});

test("resolveImport: trailing item name is dropped until a module file matches", () => {
  // "use crate::a::b::Thing" - Thing is a struct/fn, not a module.
  const known = new Set(["src/a/b.rs"]);
  assert.equal(resolveImport("src/lib.rs", "use:crate::a::b::Thing", known), "src/a/b.rs");
});

test("resolveImport: an unresolvable use returns null", () => {
  const known = new Set(["src/lib.rs"]);
  assert.equal(resolveImport("src/lib.rs", "use:crate::nope", known), null);
});

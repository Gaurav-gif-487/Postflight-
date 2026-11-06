"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadPlugin, collectPluginEvidence } = require("../src/plugins");

function sh(cmd, cwd) {
  execFileSync("bash", ["-c", cmd], { cwd, stdio: "pipe" });
}

function makeRepo(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  sh("git init -q", dir);
  sh("git config user.email a@b.com && git config user.name test", dir);
  return dir;
}

function write(dir, rel, content) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function commit(dir, msg) {
  sh(`git add -A && git commit -q -m "${msg}"`, dir);
}

// Runs a plugin exactly the way postflight's own pipeline does: load it
// through src/plugins.js (same require/validate path a real config entry
// takes), then feed it a ctx and collect evidence through
// collectPluginEvidence - the same function the CLI calls.
function runPlugin(pluginPath, ctx) {
  const loaded = loadPlugin(pluginPath, path.dirname(pluginPath));
  assert.equal(loaded.ok, true, (loaded.errors || []).join("; "));
  return collectPluginEvidence([{ plugin: loaded.plugin, source: pluginPath }], ctx);
}

test("lang-python: detects a circular import introduced by this diff, not a pre-existing one", () => {
  const dir = makeRepo("postflight-lang-python-");
  write(dir, "app/a.py", "def f():\n    pass\n");
  write(dir, "app/b.py", "def g():\n    pass\n");
  commit(dir, "init");
  const base = sh0(dir);

  // Introduce a genuine cycle: a imports b, b imports a.
  write(dir, "app/a.py", "from .b import g\n\ndef f():\n    pass\n");
  write(dir, "app/b.py", "from .a import f\n\ndef g():\n    pass\n");
  commit(dir, "introduce cycle");

  const ctx = { base, changedFiles: ["app/a.py", "app/b.py"], cwd: dir, repoRoot: dir };
  const { evidence, limitations } = runPlugin(path.join(__dirname, "..", "plugins", "lang-python", "index.js"), ctx);
  assert.deepEqual(limitations, []);
  assert.equal(evidence.length, 1);
  assert.match(evidence[0].id, /^plugin\/lang-python\/import-cycle@/);
  assert.equal(evidence[0].category, "architecture");
  assert.equal(evidence[0].status, "WARN");
  assert.match(evidence[0].summary, /Python import cycle/);
});

test("lang-python: a pre-existing cycle untouched by the diff is not reported", () => {
  const dir = makeRepo("postflight-lang-python-preexisting-");
  write(dir, "app/a.py", "from .b import g\n\ndef f():\n    pass\n");
  write(dir, "app/b.py", "from .a import f\n\ndef g():\n    pass\n");
  write(dir, "app/c.py", "# unrelated\n");
  commit(dir, "init with pre-existing cycle");
  const base = sh0(dir);

  write(dir, "app/c.py", "# a small unrelated change\nX = 1\n");
  commit(dir, "unrelated change");

  const ctx = { base, changedFiles: ["app/c.py"], cwd: dir, repoRoot: dir };
  const { evidence } = runPlugin(path.join(__dirname, "..", "plugins", "lang-python", "index.js"), ctx);
  assert.deepEqual(evidence, []);
});

test("lang-go: detects a circular import introduced by this diff", () => {
  const dir = makeRepo("postflight-lang-go-");
  write(dir, "go.mod", "module example.com/mod\n\ngo 1.22\n");
  write(dir, "main.go", 'package main\n\nfunc main() {}\n');
  write(dir, "internal/a/a.go", "package a\n\nfunc F() {}\n");
  write(dir, "internal/b/b.go", "package b\n\nfunc G() {}\n");
  commit(dir, "init");
  const base = sh0(dir);

  write(dir, "internal/a/a.go", 'package a\n\nimport "example.com/mod/internal/b"\n\nfunc F() { b.G() }\n');
  write(dir, "internal/b/b.go", 'package b\n\nimport "example.com/mod/internal/a"\n\nfunc G() { a.F() }\n');
  commit(dir, "introduce cycle");

  const ctx = {
    base,
    changedFiles: ["internal/a/a.go", "internal/b/b.go"],
    cwd: dir,
    repoRoot: dir,
  };
  const { evidence, limitations } = runPlugin(path.join(__dirname, "..", "plugins", "lang-go", "index.js"), ctx);
  assert.deepEqual(limitations, []);
  assert.equal(evidence.length, 1);
  assert.match(evidence[0].summary, /Go import cycle/);
});

test("lang-rust: detects a circular import introduced by this diff", () => {
  const dir = makeRepo("postflight-lang-rust-");
  write(dir, "Cargo.toml", '[package]\nname = "mod"\nversion = "0.1.0"\n');
  write(dir, "src/lib.rs", "pub mod a;\npub mod b;\n");
  write(dir, "src/a.rs", "pub fn f() {}\n");
  write(dir, "src/b.rs", "pub fn g() {}\n");
  commit(dir, "init");
  const base = sh0(dir);

  write(dir, "src/a.rs", "use crate::b::g;\n\npub fn f() { g(); }\n");
  write(dir, "src/b.rs", "use crate::a::f;\n\npub fn g() { f(); }\n");
  commit(dir, "introduce cycle");

  const ctx = { base, changedFiles: ["src/a.rs", "src/b.rs"], cwd: dir, repoRoot: dir };
  const { evidence, limitations } = runPlugin(path.join(__dirname, "..", "plugins", "lang-rust", "index.js"), ctx);
  assert.deepEqual(limitations, []);
  assert.equal(evidence.length, 1);
  assert.match(evidence[0].summary, /Rust import cycle/);
});

test("lang-java: detects a circular import introduced by this diff", () => {
  const dir = makeRepo("postflight-lang-java-");
  write(dir, "com/example/app/A.java", "package com.example.app;\n\npublic class A {}\n");
  write(dir, "com/example/app/B.java", "package com.example.app;\n\npublic class B {}\n");
  commit(dir, "init");
  const base = sh0(dir);

  write(
    dir,
    "com/example/app/A.java",
    "package com.example.app;\n\nimport com.example.app.B;\n\npublic class A { B b; }\n"
  );
  write(
    dir,
    "com/example/app/B.java",
    "package com.example.app;\n\nimport com.example.app.A;\n\npublic class B { A a; }\n"
  );
  commit(dir, "introduce cycle");

  const ctx = {
    base,
    changedFiles: ["com/example/app/A.java", "com/example/app/B.java"],
    cwd: dir,
    repoRoot: dir,
  };
  const { evidence, limitations } = runPlugin(path.join(__dirname, "..", "plugins", "lang-java", "index.js"), ctx);
  assert.deepEqual(limitations, []);
  assert.equal(evidence.length, 1);
  assert.match(evidence[0].summary, /Java import cycle/);
});

function sh0(dir) {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
}

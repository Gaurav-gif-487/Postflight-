"use strict";
const path = require("path");
const { diffCycles } = require("../shared/diffCycles");
const { evidenceFromCycles } = require("../shared/evidenceFromCycles");

const isSourceFile = (f) => f.endsWith(".rs");

// "mod foo;" declares a submodule that lives in a sibling file. Inline
// modules ("mod foo { ... }") don't reference another file, so they're
// deliberately not matched (no trailing ";" for a brace-delimited mod).
const MOD_RE = /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/gm;
// "use crate::a::b::c;" / "use crate::a::b::{c, d};" - captures the
// crate-relative path. Only crate::-rooted uses are resolvable without
// knowing every module's own re-exports; super::/self:: are intentionally
// not handled (would need full per-file module-tree state this plugin
// doesn't build).
const USE_CRATE_RE = /^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+(crate(?:::[A-Za-z_][A-Za-z0-9_]*)+)/gm;

function extractImports(source) {
  const specs = [];
  let m;
  MOD_RE.lastIndex = 0;
  while ((m = MOD_RE.exec(source))) specs.push(`mod:${m[1]}`);
  USE_CRATE_RE.lastIndex = 0;
  while ((m = USE_CRATE_RE.exec(source))) specs.push(`use:${m[1]}`);
  return specs;
}

// Resolves a Rust import specifier to a repo-relative file, or null.
// Assumes a conventional single-crate layout (crate root at "src/") -
// workspaces with multiple crates aren't disambiguated, which is a known
// limitation of a diff-local, git-only heuristic (see docs/plugin-api.md:
// this is exactly the kind of thing that stays WEAK/heuristic evidence).
function resolveImport(fromFile, spec, knownFiles) {
  if (spec.startsWith("mod:")) {
    const name = spec.slice(4);
    const dir = path.dirname(fromFile);
    const candidates = [
      dir === "." ? `${name}.rs` : `${dir}/${name}.rs`,
      dir === "." ? `${name}/mod.rs` : `${dir}/${name}/mod.rs`,
    ];
    return candidates.find((c) => knownFiles.has(c)) || null;
  }
  if (spec.startsWith("use:")) {
    // Drop the leading "crate" segment; the remaining path may end in an
    // item name (a struct/fn/const) rather than a module, so try the full
    // path first and progressively drop trailing segments until something
    // resolves to an actual file.
    const segments = spec.slice(4).split("::").slice(1);
    for (let i = segments.length; i >= 1; i--) {
      const base = ["src", ...segments.slice(0, i)].join("/");
      const candidates = [`${base}.rs`, `${base}/mod.rs`];
      const hit = candidates.find((c) => knownFiles.has(c));
      if (hit) return hit;
    }
  }
  return null;
}

function analyze(ctx) {
  const cycles = diffCycles({
    base: ctx.base,
    changedFiles: ctx.changedFiles,
    repoRoot: ctx.repoRoot,
    isSourceFile,
    extractImports,
    resolveImport,
  });
  return cycles.map((cycle) => ({ cycle }));
}

module.exports = {
  metadata: { name: "lang-rust", version: "0.1.0", apiVersion: 1 },
  capabilities: { languages: ["rust"], categories: ["architecture"] },
  detect(ctx) {
    return ctx.changedFiles.some(isSourceFile);
  },
  analyze,
  evidence(ctx, findings) {
    return evidenceFromCycles(findings, { language: "Rust", pluginName: "lang-rust" });
  },
  extractImports,
  resolveImport,
  isSourceFile,
};

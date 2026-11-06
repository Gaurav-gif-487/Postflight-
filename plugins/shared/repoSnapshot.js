"use strict";
const { execFileSync } = require("child_process");

// Generic git snapshot helpers shared by the language adapter plugins.
// Mirrors src/analyzers/jsImportGraph.js's git()/listFilesAtRef()/
// readFileAtRef()/listFilesInWorkingTree(), parameterized by a file filter
// predicate instead of a hardcoded JS extension list, so every language
// plugin gets the same "read the working tree, read the diff's base ref"
// primitives without re-implementing (and re-auditing) git subprocess
// handling four separate times.

function git(args, cwd) {
  try {
    // stdio[2] "ignore": a failing lookup (most commonly `git show
    // <ref>:<path>` for a path that doesn't exist at that ref) must never
    // leak git's own "fatal: path ... does not exist" onto postflight's
    // stderr. Every failure here collapses to "" and every caller treats
    // that as "unreadable, skip it" - see src/analyzers/jsImportGraph.js's
    // `git()` for the full reachability argument.
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

function listFilesAtRef(ref, cwd, filter) {
  const out = git(["ls-tree", "-r", "--name-only", ref], cwd);
  return new Set(out.split("\n").filter(Boolean).filter(filter));
}

function readFileAtRef(ref, file, cwd) {
  return git(["show", `${ref}:${file}`], cwd);
}

function listFilesInWorkingTree(repoRoot, filter) {
  const out = git(["ls-files", "--cached", "--others", "--exclude-standard"], repoRoot);
  return new Set(out.split("\n").filter(Boolean).filter(filter));
}

module.exports = { git, listFilesAtRef, readFileAtRef, listFilesInWorkingTree };

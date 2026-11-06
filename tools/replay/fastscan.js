#!/usr/bin/env node
"use strict";

// fastscan.js - scan a real, already-cloned git repo's tracked files
// against postflight's pattern rules (src/checks.js) and print every hit
// for manual review.
//
// This is a *review* tool, not a test: it exists to make the adversarial-
// replay methodology used to find and fix real false positives (see
// CHANGELOG.md and the "Adversarial replay" comments in src/checks.js and
// src/analyzers/configChange.js) repeatable against a new target repo,
// instead of being a one-off script that lived outside the repo for a
// single session.
//
// It deliberately checks every line of every tracked file's *current*
// content (a superset of anything any historical diff could ever have
// added), not just one commit's diff - that's what makes a handful of
// invocations enough to surface real false positives across a repo's
// whole history without replaying every commit.
//
// Usage:
//   node tools/replay/fastscan.js <repo-dir> [--rules id1,id2,...] [--json]
//
// Examples:
//   node tools/replay/fastscan.js ../some-large-repo
//   node tools/replay/fastscan.js ../some-large-repo --rules auth-bypass,secret-generic
//
// Exit code is always 0 (this is a review tool, not a pass/fail check);
// hits are printed for a human to read, not asserted against.

const path = require("path");
const { execFileSync } = require("child_process");
const { RULES, isDocFile, isFixtureFile, isSuppressed, isCommentLine } = require("../../src/checks");

function parseArgs(argv) {
  const args = { repoDir: null, rules: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--rules") args.rules = argv[++i].split(",");
    else if (a === "--json") args.json = true;
    else if (!a.startsWith("--")) args.repoDir = a;
  }
  return args;
}

function shannonEntropy(value) {
  if (!value) return 0;
  const freq = new Map();
  for (const ch of value) freq.set(ch, (freq.get(ch) || 0) + 1);
  let bits = 0;
  for (const count of freq.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}
const MIN_SECRET_ENTROPY = 3.0;
const PLACEHOLDER = /YOUR[_-]?|XXXX|EXAMPLE|CHANGE[_-]?ME|<[^>]+>|\{\{|placeholder/i;

function listFiles(repoDir) {
  // No maxBuffer here previously meant this crashed outright (ENOBUFS)
  // instead of degrading on any repo whose full `git ls-files` listing
  // exceeds Node's 1MB default child_process buffer - seen with
  // spring-projects/spring-boot (11,875 tracked files, listing > 1MB). Match the 32MB cap already
  // used below for individual file reads so a large-but-plausible repo
  // doesn't crash the whole scan the way a single huge file wouldn't.
  return execFileSync("git", ["ls-files"], { cwd: repoDir, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
    .split("\n")
    .filter(Boolean);
}

function scanRepo(repoDir, ruleIds) {
  const rules = RULES.filter((r) => !r.wholeDiff && (!ruleIds || ruleIds.includes(r.id)));
  const files = listFiles(repoDir);
  const hits = [];
  for (const file of files) {
    let text;
    try {
      text = execFileSync("git", ["show", `HEAD:${file}`], {
        cwd: repoDir,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
        maxBuffer: 32 * 1024 * 1024,
      });
    } catch {
      continue;
    }
    if (text.includes("\0")) continue; // binary
    const doc = isDocFile(file);
    const fixture = isFixtureFile(file);
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i];
      if (isSuppressed(lineText)) continue;
      const comment = isCommentLine(lineText);
      for (const rule of rules) {
        if (rule.codeOnly && (doc || comment)) continue;
        if (fixture && !rule.secret && rule.category !== "test-integrity") continue;
        const m = rule.pattern.exec(lineText);
        if (!m) continue;
        if (rule.secret) {
          const value = rule.valueGroup ? m[rule.valueGroup] : m[0];
          if (PLACEHOLDER.test(lineText)) continue;
          if (rule.valueGroup && shannonEntropy(value) < MIN_SECRET_ENTROPY) continue;
        }
        hits.push({ rule: rule.id, file, line: i + 1, text: lineText.trim().slice(0, 200) });
      }
    }
  }
  return hits;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.repoDir) {
    console.error("Usage: node tools/replay/fastscan.js <repo-dir> [--rules id1,id2,...] [--json]");
    process.exit(2);
  }
  const repoDir = path.resolve(args.repoDir);
  const hits = scanRepo(repoDir, args.rules);
  if (args.json) {
    console.log(JSON.stringify(hits, null, 2));
  } else {
    for (const h of hits) console.log(`${h.rule}\t${h.file}:${h.line}\t${h.text}`);
    console.log(`\n${hits.length} hit(s) across ${args.rules ? args.rules.join(",") : "all pattern rules"}`);
  }
}

if (require.main === module) main();

module.exports = { scanRepo };

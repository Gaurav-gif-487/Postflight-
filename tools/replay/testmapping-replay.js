#!/usr/bin/env node
"use strict";

// testmapping-replay.js - replay real commit history from an already-cloned
// repo through src/testMapping.js's untestedFiles() and report every commit
// where a source file gets flagged "untested" despite a same-commit test
// file change existing (a naming-convention miss) or where the flagged
// list looks otherwise suspicious. This is a review tool for a human to
// read, not a pass/fail check.
//
// Usage:
//   node tools/replay/testmapping-replay.js <repo-dir> [--ext rb|kt|php|...] [--commits N]
//
// Example ():
//   node tools/replay/testmapping-replay.js ../rspec-core --ext rb --commits 200
//   node tools/replay/testmapping-replay.js ../okhttp --ext kt --commits 200
//   node tools/replay/testmapping-replay.js ../monolog --ext php --commits 200

const path = require("path");
const { execFileSync } = require("child_process");
const { untestedFiles, isLikelyTestFile } = require("../../src/testMapping");

function parseArgs(argv) {
  const args = { repoDir: null, ext: null, commits: 100 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--ext") args.ext = argv[++i];
    else if (a === "--commits") args.commits = parseInt(argv[++i], 10);
    else if (!a.startsWith("--")) args.repoDir = a;
  }
  return args;
}

function changedFiles(repoDir, sha) {
  try {
    const out = execFileSync("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", sha], {
      cwd: repoDir,
      encoding: "utf8",
    });
    return out.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function recentShas(repoDir, n, ext) {
  const pathspec = ext ? [`--`, `*.${ext}`] : [];
  const out = execFileSync("git", ["log", `-${n}`, "--pretty=%H", ...pathspec], { cwd: repoDir, encoding: "utf8" });
  return out.split("\n").filter(Boolean);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.repoDir) {
    console.error("Usage: node tools/replay/testmapping-replay.js <repo-dir> [--ext rb|kt|php|...] [--commits N]");
    process.exit(2);
  }
  const repoDir = path.resolve(args.repoDir);
  const shas = recentShas(repoDir, args.commits, args.ext);

  let totalSrcTouched = 0;
  let totalFlagged = 0;
  let examples = 0;

  for (const sha of shas) {
    const files = changedFiles(repoDir, sha);
    if (files.length === 0 || files.length > 15) continue; // skip merges/huge commits for readable output
    const untested = untestedFiles(files);
    const srcFiles = files.filter((f) => !isLikelyTestFile(f));
    totalSrcTouched += srcFiles.length;
    if (untested.length) {
      totalFlagged += untested.length;
      if (examples < 15) {
        console.log(`commit ${sha.slice(0, 8)}: files=${JSON.stringify(files)}`);
        console.log(`  flagged untested: ${JSON.stringify(untested)}`);
        examples++;
      }
    }
  }

  console.log(`\nsampled ${shas.length} commits; source files touched: ${totalSrcTouched}, flagged untested: ${totalFlagged}`);
  console.log(
    "Review each flagged example above: is there really no test for that file in the commit, or does the commit's " +
      "test file just not match any of testMapping.js's naming-convention candidates (a false 'untested' claim worth fixing)?"
  );
}

if (require.main === module) main();

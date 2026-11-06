#!/usr/bin/env node
"use strict";

// Runs every case in benchmarks/cases/index.js against the real,
// checked-out postflight CLI (bin/postflight.js) in a fresh temporary git
// repository per case - no mocking of postflight's own logic. Reports
// detection results by category and writes a JSON report for CI/tracking.
//
// Usage:
//   node benchmarks/runner/run-benchmarks.js [--report]
//
// --report additionally writes benchmarks/reports/<timestamp>.json and
// updates benchmarks/reports/latest.json.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const { CASES } = require("../cases");

const REPO_ROOT = path.join(__dirname, "..", "..");
const BIN = path.join(REPO_ROOT, "bin", "postflight.js");

function sh(cmd, cwd) {
  execFileSync("bash", ["-c", cmd], { cwd, stdio: "pipe" });
}

function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

function runCase(caseDef) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `postflight-bench-${caseDef.id}-`));
  try {
    sh("git init -q", dir);
    sh("git config user.email bench@postflight.dev && git config user.name postflight-bench", dir);
    writeFiles(dir, caseDef.base || {});
    sh("git add -A && git commit -q -m base", dir);

    for (const rel of caseDef.deleteFromBase || []) {
      fs.rmSync(path.join(dir, rel), { force: true });
    }
    writeFiles(dir, caseDef.change || {});

    const args = ["verify", "--policy", caseDef.policy || "default", "--no-color", "--format", "json"];
    if (caseDef.testCommand) args.push("--test", caseDef.testCommand);

    const result = spawnSync("node", [BIN, ...args], { cwd: dir, encoding: "utf8", timeout: 60000 });
    let verdict = null;
    try {
      verdict = JSON.parse(result.stdout).policyVerdict?.verdict || null;
    } catch (err) {
      verdict = null;
    }

    const expected = caseDef.expectVerdictOneOf || [];
    const detected = verdict !== null && expected.includes(verdict);

    return {
      id: caseDef.id,
      category: caseDef.category,
      description: caseDef.description,
      expectVerdictOneOf: expected,
      actualVerdict: verdict,
      exitCode: result.status,
      detected,
      stderr: result.status === null ? result.stderr : undefined, // only surface stderr on a hard failure (e.g. timeout)
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const report = { generatedAt: new Date().toISOString(), toolVersion: require(path.join(REPO_ROOT, "package.json")).version, results: [] };

  for (const caseDef of CASES) {
    report.results.push(runCase(caseDef));
  }

  const byCategory = {};
  for (const r of report.results) {
    byCategory[r.category] = byCategory[r.category] || { total: 0, detected: 0 };
    byCategory[r.category].total += 1;
    if (r.detected) byCategory[r.category].detected += 1;
  }
  report.byCategory = byCategory;
  report.totals = {
    total: report.results.length,
    detected: report.results.filter((r) => r.detected).length,
  };

  console.log("POSTFLIGHT BENCHMARK");
  console.log("");
  for (const r of report.results) {
    const mark = r.detected ? "✓" : "✗";
    console.log(`  ${mark} [${r.category}] ${r.id}: expected one of ${r.expectVerdictOneOf.join("/")}, got ${r.actualVerdict}`);
  }
  console.log("");
  console.log("By category:");
  for (const [cat, stats] of Object.entries(byCategory)) {
    console.log(`  ${cat}: ${stats.detected}/${stats.total}`);
  }
  console.log("");
  console.log(`Total: ${report.totals.detected}/${report.totals.total}`);
  console.log("");
  console.log(
    "These are the categories postflight's shipped analyzers currently cover, run against a small,\n" +
      "hand-written fixture set - not a claim about detection rate on arbitrary real-world diffs. See\n" +
      "docs/benchmark.md for methodology and known gaps (e.g. swallowed-exception detection is not yet\n" +
      "implemented as a dedicated analyzer)."
  );

  if (process.argv.includes("--report")) {
    fs.mkdirSync(path.join(__dirname, "..", "reports"), { recursive: true });
    const stamp = report.generatedAt.replace(/[:.]/g, "-");
    fs.writeFileSync(path.join(__dirname, "..", "reports", `${stamp}.json`), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(__dirname, "..", "reports", "latest.json"), JSON.stringify(report, null, 2));
  }

  process.exit(report.totals.detected === report.totals.total ? 0 : 1);
}

main();

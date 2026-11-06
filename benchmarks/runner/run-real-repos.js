#!/usr/bin/env node
"use strict";

// Runs benchmarks/cases/real-repos.js: real commits from real public GitHub
// repositories, against the real, checked-out postflight CLI. Companion to
// run-benchmarks.js (synthetic cases) - see "Real-repository evaluation" in
// docs/benchmark.md for what this is and isn't a claim about.
//
// Why codeload.github.com tarballs instead of `git clone`: this avoids
// needing git's smart-HTTP protocol (which some sandboxed/proxied network
// setups block or gate behind auth even for public repos, while still
// allowing plain HTTPS GETs to github.com/codeload.github.com) and avoids
// downloading full repo history when only two trees are ever needed. Each
// case fetches one or two specific commit trees as tarballs, reconstructs
// the working-tree diff a real agent's change would present, commits the
// base as a real git commit (so postflight's own git-diff machinery runs
// unmodified), and leaves the "change" uncommitted - same shape
// run-benchmarks.js uses for its synthetic cases.
//
// Requires network access to codeload.github.com. If a fetch fails (no
// network, github outage, rate limit), that case is reported as SKIPPED,
// not silently dropped or hard-failed - see main()'s exit code handling.
//
// Usage:
//   node benchmarks/runner/run-real-repos.js [--report]

const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const zlib = require("zlib");
const { execFileSync, spawnSync } = require("child_process");
const { REAL_REPO_CASES } = require("../cases/real-repos");

const REPO_ROOT = path.join(__dirname, "..", "..");
const BIN = path.join(REPO_ROOT, "bin", "postflight.js");
const FETCH_TIMEOUT_MS = 30000;

function sh(cmd, cwd) {
  execFileSync("bash", ["-c", cmd], { cwd, stdio: "pipe" });
}

// Downloads a codeload tarball to disk. Returns nothing; throws on any
// non-200 or network failure so callers can turn that into a SKIPPED case
// rather than a confusing downstream file-not-found error.
function downloadTarball(owner, name, ref, destFile) {
  const url = `https://codeload.github.com/${owner}/${name}/tar.gz/${ref}`;
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destFile);
    const req = https.get(url, { timeout: FETCH_TIMEOUT_MS }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        file.close();
        reject(new Error(`GET ${url} -> HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
    });
    req.on("timeout", () => req.destroy(new Error(`GET ${url} timed out after ${FETCH_TIMEOUT_MS}ms`)));
    req.on("error", reject);
  });
}

// Extracts a codeload tarball (which contains a single top-level
// `<name>-<ref>/` directory) into destDir, stripping that top component.
function extractTarball(tarFile, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  sh(`tar xzf "${tarFile}" -C "${destDir}" --strip-components=1`, undefined);
}

async function fetchTree(owner, name, ref, workDir) {
  const tarFile = path.join(workDir, `${ref.replace(/[^a-zA-Z0-9]/g, "_")}.tar.gz`);
  const treeDir = path.join(workDir, `tree-${ref.replace(/[^a-zA-Z0-9]/g, "_")}`);
  await downloadTarball(owner, name, ref, tarFile);
  extractTarball(tarFile, treeDir);
  return treeDir;
}

// Copies every regular file under srcDir into destDir, preserving relative
// paths and creating parent directories as needed. Used to lay a full tree
// (base) or overlay a subset of files (change/overlay) onto the working repo.
function copyTree(srcDir, destDir, relPaths) {
  const paths = relPaths || listFilesRecursive(srcDir);
  for (const rel of paths) {
    const src = path.join(srcDir, rel);
    const dest = path.join(destDir, rel);
    if (!fs.existsSync(src)) continue; // a "changed" path that was actually a deletion
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

function listFilesRecursive(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listFilesRecursive(full, base, out);
    } else if (entry.isFile()) {
      out.push(path.relative(base, full));
    }
  }
  return out;
}

// Returns the set of relative paths that differ (by content or existence)
// between two real trees - i.e. exactly the files a real commit touched.
function diffPaths(treeA, treeB) {
  const a = new Set(listFilesRecursive(treeA));
  const b = new Set(listFilesRecursive(treeB));
  const changed = new Set();
  for (const p of b) {
    if (!a.has(p)) {
      changed.add(p);
    } else {
      const bufA = fs.readFileSync(path.join(treeA, p));
      const bufB = fs.readFileSync(path.join(treeB, p));
      if (!bufA.equals(bufB)) changed.add(p);
    }
  }
  for (const p of a) if (!b.has(p)) changed.add(p); // deletions
  return [...changed];
}

async function runCase(caseDef) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `postflight-realrepo-${caseDef.id}-`));
  const repoDir = path.join(workDir, "repo");
  try {
    const { owner, name } = caseDef.repo;
    const baseTree = await fetchTree(owner, name, caseDef.baseRef, workDir);

    fs.mkdirSync(repoDir, { recursive: true });
    copyTree(baseTree, repoDir);
    sh("git init -q", repoDir);
    sh("git config user.email bench@postflight.dev && git config user.name postflight-bench", repoDir);
    sh("git add -A && git commit -q -m base", repoDir);

    if (caseDef.kind === "diff") {
      const changeTree = await fetchTree(owner, name, caseDef.changeRef, workDir);
      const changed = diffPaths(baseTree, changeTree);
      copyTree(changeTree, repoDir, changed);
      for (const rel of changed) {
        if (!fs.existsSync(path.join(changeTree, rel))) {
          fs.rmSync(path.join(repoDir, rel), { force: true }); // real deletion, replay it
        }
      }
    } else if (caseDef.kind === "overlay") {
      for (const { path: rel, fromRef } of caseDef.overlayFiles) {
        const overlayTree = await fetchTree(owner, name, fromRef, workDir);
        copyTree(overlayTree, repoDir, [rel]);
      }
    } else {
      throw new Error(`unknown case kind "${caseDef.kind}" for ${caseDef.id}`);
    }

    const args = ["verify", "--policy", caseDef.policy || "default", "--no-color", "--format", "json"];
    const result = spawnSync("node", [BIN, ...args], { cwd: repoDir, encoding: "utf8", timeout: 60000 });
    let verdict = null;
    let proof = null;
    try {
      proof = JSON.parse(result.stdout);
      verdict = proof.policyVerdict?.verdict || null;
    } catch (err) {
      verdict = null;
    }

    const expected = caseDef.expected?.verdictOneOf || [];
    const matched = verdict !== null && expected.includes(verdict);

    return {
      id: caseDef.id,
      category: caseDef.category,
      repo: `${owner}/${name}`,
      refs: caseDef.kind === "diff" ? `${caseDef.baseRef}..${caseDef.changeRef}` : `${caseDef.baseRef} (overlay)`,
      description: caseDef.description,
      expectVerdictOneOf: expected,
      because: caseDef.expected?.because || null,
      actualVerdict: verdict,
      evidenceCount: Array.isArray(proof?.policyVerdict?.evidence?.evidence)
        ? proof.policyVerdict.evidence.evidence.length
        : null,
      exitCode: result.status,
      matched,
      status: "ran",
      stderr: result.status === null ? result.stderr : undefined,
    };
  } catch (err) {
    return {
      id: caseDef.id,
      category: caseDef.category,
      repo: `${caseDef.repo.owner}/${caseDef.repo.name}`,
      description: caseDef.description,
      expectVerdictOneOf: caseDef.expected?.verdictOneOf || [],
      actualVerdict: null,
      matched: false,
      status: "skipped",
      skipReason: err.message,
    };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

async function main() {
  const report = {
    generatedAt: new Date().toISOString(),
    toolVersion: require(path.join(REPO_ROOT, "package.json")).version,
    results: [],
  };

  for (const caseDef of REAL_REPO_CASES) {
    report.results.push(await runCase(caseDef));
  }

  const ran = report.results.filter((r) => r.status === "ran");
  const skipped = report.results.filter((r) => r.status === "skipped");

  console.log("POSTFLIGHT REAL-REPOSITORY EVALUATION");
  console.log("");
  for (const r of report.results) {
    if (r.status === "skipped") {
      console.log(`  ⚠ [${r.category}] ${r.id} (${r.repo}): SKIPPED - ${r.skipReason}`);
      continue;
    }
    const mark = r.matched ? "✓" : "✗";
    console.log(
      `  ${mark} [${r.category}] ${r.id} (${r.repo}, ${r.refs}): expected one of ` +
        `${r.expectVerdictOneOf.join("/")}, got ${r.actualVerdict}`
    );
  }
  console.log("");
  console.log(`Ran: ${ran.length}/${report.results.length}  Matched expectation: ${ran.filter((r) => r.matched).length}/${ran.length}  Skipped: ${skipped.length}`);
  console.log("");
  console.log(
    "This is a small, hand-picked, hand-verified set of real commits, not a claim about\n" +
      "detection rate on arbitrary real-world diffs - see 'Real-repository evaluation' in\n" +
      "docs/benchmark.md for how cases are chosen and how to add more."
  );

  if (process.argv.includes("--report")) {
    fs.mkdirSync(path.join(__dirname, "..", "reports"), { recursive: true });
    const stamp = report.generatedAt.replace(/[:.]/g, "-");
    fs.writeFileSync(path.join(__dirname, "..", "reports", `real-repos-${stamp}.json`), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(__dirname, "..", "reports", "real-repos-latest.json"), JSON.stringify(report, null, 2));
  }

  // A skip (network unavailable) is not a failure of postflight - only an
  // actual mismatch on a case that ran should fail CI.
  process.exit(ran.some((r) => !r.matched) ? 1 : 0);
}

main();

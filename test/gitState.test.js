"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const gitState = require("../src/gitState");
const { EvidenceLedger, STATUS } = require("../src/evidence");

function sh(cmd, cwd) {
  execFileSync("bash", ["-c", cmd], { cwd, stdio: "pipe" });
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postflight-gitstate-test-"));
  sh("git init -q", dir);
  sh("git config user.email a@b.com && git config user.name test", dir);
  return dir;
}

test("inspect: a clean repo on a resolvable base has no repo-state problems", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  sh("git add -A && git commit -q -m init", dir);
  const state = gitState.inspect({ base: "HEAD", cwd: dir });
  assert.equal(state.baseResolved, true);
  assert.equal(state.shallow, false);
  assert.equal(state.detachedHead, false);
  assert.deepEqual(state.dirtyFiles, []);
  assert.deepEqual(state.partiallyStaged, []);

  const ledger = new EvidenceLedger();
  gitState.record(ledger, state);
  assert.deepEqual(ledger.all, []);
  assert.deepEqual(ledger.limitations, []);
});

test("record: an unresolvable base ref becomes UNKNOWN evidence plus a limitation", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  sh("git add -A && git commit -q -m init", dir);
  const state = gitState.inspect({ base: "not-a-real-ref-xyz", cwd: dir });
  assert.equal(state.baseResolved, false);

  const ledger = new EvidenceLedger();
  gitState.record(ledger, state);
  const found = ledger.find("repo-state/base-unresolved");
  assert.ok(found);
  assert.equal(found.status, STATUS.UNKNOWN);
  assert.equal(ledger.limitations.length, 1);
  assert.equal(ledger.limitations[0].id, "no-base");
});

test("record: the empty-tree sentinel counts as a resolved base (first-commit case)", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  sh("git add -A && git commit -q -m init", dir);
  const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  const state = gitState.inspect({ base: emptyTree, cwd: dir });
  assert.equal(state.baseResolved, true);
  const ledger = new EvidenceLedger();
  gitState.record(ledger, state);
  assert.equal(ledger.find("repo-state/base-unresolved"), null);
});

test("record: a detached HEAD is a WARN, not a failure", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  sh("git add -A && git commit -q -m init", dir);
  sh("git checkout -q --detach HEAD", dir);
  const state = gitState.inspect({ base: "HEAD", cwd: dir });
  assert.equal(state.detachedHead, true);
  const ledger = new EvidenceLedger();
  gitState.record(ledger, state);
  const found = ledger.find("repo-state/detached-head");
  assert.ok(found);
  assert.equal(found.status, STATUS.WARN);
});

test("record: a partially staged file is WARN and INTRODUCED (the commit would differ from what was analyzed)", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "line1\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "line1\nline2\n");
  sh("git add a.txt", dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "line1\nline2\nline3\n");
  const state = gitState.inspect({ base: "HEAD", cwd: dir });
  assert.deepEqual(state.partiallyStaged, ["a.txt"]);
  const ledger = new EvidenceLedger();
  gitState.record(ledger, state);
  const found = ledger.find("repo-state/partially-staged");
  assert.ok(found);
  assert.equal(found.status, STATUS.WARN);
  assert.equal(found.origin, "INTRODUCED");
});

test("record: a dirty (unstaged) file is recorded as a limitation, not a scored finding", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "line1\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "line1\nline2\n");
  const state = gitState.inspect({ base: "HEAD", cwd: dir });
  assert.deepEqual(state.dirtyFiles, ["a.txt"]);
  const ledger = new EvidenceLedger();
  gitState.record(ledger, state);
  assert.ok(ledger.limitations.some((l) => l.id === "dirty-worktree"));
});

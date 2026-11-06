"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const git = require("../src/git");

function sh(cmd, cwd) {
  execFileSync("bash", ["-c", cmd], { cwd, stdio: "pipe" });
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postflight-test-"));
  sh("git init -q", dir);
  sh('git config user.email a@b.com && git config user.name test', dir);
  return dir;
}

test("git: isGitRepo is false outside a repo", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "not-a-repo-"));
  assert.equal(git.isGitRepo(dir), false);
});

test("git: resolveBase returns the empty tree hash when there are no commits yet", () => {
  const dir = makeRepo();
  const base = git.resolveBase(undefined, dir);
  assert.equal(base, "4b825dc642cb6eb9a060e54bf8d69288fbee4904");
});

test("git: resolveBase returns HEAD once a commit exists", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  sh("git add -A && git commit -q -m init", dir);
  assert.equal(git.resolveBase(undefined, dir), "HEAD");
});

test("git: diffStat is empty for a diff with zero changes", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  sh("git add -A && git commit -q -m init", dir);
  assert.deepEqual(git.diffStat("HEAD", dir), []);
});

test("git: diffStat reports insertions/deletions for a modified file", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "one\nTWO\nthree\n");
  const stats = git.diffStat("HEAD", dir);
  assert.equal(stats.length, 1);
  assert.equal(stats[0].file, "a.txt");
  assert.equal(stats[0].insertions, 2);
  assert.equal(stats[0].deletions, 1);
});

test("git: diffStat handles a renamed file", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "old.txt"), "content that is long enough to count as a rename\n");
  sh("git add -A && git commit -q -m init", dir);
  sh("git mv old.txt new.txt", dir);
  const stats = git.diffStat("HEAD", dir);
  assert.equal(stats.length, 1);
  assert.equal(stats[0].file, "new.txt");
  assert.equal(stats[0].renamedFrom, "old.txt");
});

test("git: diffStat marks binary files with null insertions/deletions", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "x\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "img.bin"), Buffer.from([0, 1, 2, 255, 254]));
  sh("git add -A", dir);
  const stats = git.diffStat("HEAD", dir);
  const bin = stats.find((s) => s.file === "img.bin");
  assert.ok(bin);
  assert.equal(bin.binary, true);
  assert.equal(bin.insertions, null);
});

test("git: works when invoked from a subdirectory (repoRoot is stable)", () => {
  const dir = makeRepo();
  fs.mkdirSync(path.join(dir, "sub"));
  fs.writeFileSync(path.join(dir, "sub", "a.txt"), "x\n");
  sh("git add -A && git commit -q -m init", dir);
  const root = git.repoRoot(path.join(dir, "sub"));
  assert.equal(fs.realpathSync(root), fs.realpathSync(dir));
});

test("git: remoteSlug returns null when there is no 'origin' remote", () => {
  const dir = makeRepo();
  assert.equal(git.remoteSlug(dir), null);
});

test("git: remoteSlug doesn't leak git's raw stderr when there's no 'origin' remote", () => {
  // execFileSync's default stdio writes a failing child's stderr straight
  // through to the *current* process's stderr - not just into the thrown
  // error's .stderr field - so this has to run in a subprocess to observe
  // it the way a real CI log would. A repo with no "origin" remote is an
  // expected, already-handled case (see the test above); it must not also
  // print git's own "error: No such remote 'origin'" line, which every
  // `postflight run --proof` or `--format sarif` invocation would
  // otherwise show on a repo that simply doesn't happen to have a remote
  // named "origin".
  const dir = makeRepo();
  const script = `
    const git = require(${JSON.stringify(path.join(__dirname, "..", "src", "git.js"))});
    console.log(JSON.stringify(git.remoteSlug(${JSON.stringify(dir)})));
  `;
  const child = require("child_process").spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
  assert.equal(child.stdout.trim(), "null");
  assert.equal(child.stderr, "");
});

test("git: remoteSlug parses an https GitHub origin", () => {
  const dir = makeRepo();
  sh("git remote add origin https://github.com/acme/widgets.git", dir);
  assert.equal(git.remoteSlug(dir), "acme/widgets");
});

test("git: remoteSlug parses an https GitHub origin without a .git suffix", () => {
  const dir = makeRepo();
  sh("git remote add origin https://github.com/acme/widgets", dir);
  assert.equal(git.remoteSlug(dir), "acme/widgets");
});

test("git: remoteSlug parses an ssh-style GitHub origin", () => {
  const dir = makeRepo();
  sh("git remote add origin git@github.com:acme/widgets.git", dir);
  assert.equal(git.remoteSlug(dir), "acme/widgets");
});

test("git: remoteSlug returns null for a non-GitHub remote", () => {
  const dir = makeRepo();
  sh("git remote add origin https://gitlab.com/acme/widgets.git", dir);
  assert.equal(git.remoteSlug(dir), null);
});

test("git: showFile returns null (not throw) for a file that doesn't exist at the given ref", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  sh("git add a.txt && git commit -q -m init", dir);
  assert.equal(git.showFile("HEAD", "brand-new-file-not-in-history.txt", dir), null);
});

test("git: showFile does not leak git's own stderr to the parent process when the file is missing at ref", () => {
  // Regression test: execFileSync's default stdio inherits the child's
  // stderr straight through to postflight's own stderr. showFile already
  // collapses every failure to `null` and never inspects the error, so
  // that stderr ("fatal: path '...' does not exist in '...'") was pure
  // noise printed on completely ordinary runs - specifically, on every new
  // file (the single most common way this branch is hit). Spawn a real
  // subprocess (in-process stderr can't be reliably captured/asserted on)
  // and confirm nothing lands on its stderr. Fails against the pre-fix
  // code (bare execFileSync with no stdio override), passes after.
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  sh("git add a.txt && git commit -q -m init", dir);
  const result = require("child_process").spawnSync(
    process.execPath,
    [
      "-e",
      `const git = require(${JSON.stringify(require.resolve("../src/git"))}); ` +
        `const r = git.showFile("HEAD", "brand-new-file-not-in-history.txt", ${JSON.stringify(dir)}); ` +
        `process.exit(r === null ? 0 : 1);`,
    ],
    { encoding: "utf8" }
  );
  assert.equal(result.stderr, "");
  assert.equal(result.status, 0);
});

test("git: resolveRenamedPath handles plain and braced rename forms", () => {
  assert.deepEqual(git.resolveRenamedPath("a.js"), { file: "a.js", renamedFrom: null });
  assert.deepEqual(git.resolveRenamedPath("old.js => new.js"), { file: "new.js", renamedFrom: "old.js" });
  assert.deepEqual(git.resolveRenamedPath("src/{old => new}/x.js"), {
    file: "src/new/x.js",
    renamedFrom: "src/old/x.js",
  });
});

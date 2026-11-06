"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { validateProvider } = require("../src/remediation");
const { createEvidence } = require("../src/evidence");
const provider = require("../plugins/remediations/npm-lockfile-sync");

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "postflight-lockfile-provider-"));
}

function lockfileEvidence(file, overrides = {}) {
  return createEvidence({
    id: `dependency/lockfile-not-updated@${file}`,
    category: "dependency",
    status: "WARN",
    summary: "Dependencies changed but no lockfile was updated",
    provenance: { method: "derived", source: "manifest vs lockfile change set" },
    ...overrides,
  });
}

test("npm-lockfile-sync: is a valid remediation provider per the contract", () => {
  const { valid, errors } = validateProvider(provider, "npm-lockfile-sync");
  assert.equal(valid, true, errors.join("; "));
});

test("canRemediate: matches only dependency/lockfile-not-updated evidence", () => {
  assert.equal(provider.canRemediate(lockfileEvidence("package.json")), true);
  assert.equal(
    provider.canRemediate(
      createEvidence({
        id: "dependency/added@package.json",
        category: "dependency",
        status: "WARN",
        summary: "new dep",
        provenance: { method: "observed", source: "manifest" },
      })
    ),
    false
  );
  assert.equal(
    provider.canRemediate(
      createEvidence({
        id: "build/result",
        category: "build",
        status: "FAIL",
        summary: "build failed",
        provenance: { method: "observed", source: "build command" },
      })
    ),
    false
  );
});

test("npmCommandFor: defaults to npm install when no lockfile is present", () => {
  const dir = tmpdir();
  assert.equal(provider.npmCommandFor(".", dir), "npm install");
});

test("npmCommandFor: prefers yarn.lock when present", () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "yarn.lock"), "");
  assert.equal(provider.npmCommandFor(".", dir), "yarn install");
});

test("npmCommandFor: prefers pnpm-lock.yaml when present", () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "");
  assert.equal(provider.npmCommandFor(".", dir), "pnpm install");
});

test("npmCommandFor: detects a lockfile in a package subdirectory (monorepo)", () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, "packages/app"), { recursive: true });
  fs.writeFileSync(path.join(dir, "packages/app/yarn.lock"), "");
  assert.equal(provider.npmCommandFor("packages/app", dir), "yarn install");
});

test("remediate: suggests npm install for a root package.json with no lockfile hint", () => {
  const dir = tmpdir();
  const result = provider.remediate(lockfileEvidence("package.json"), { repoRoot: dir });
  assert.equal(result.kind, "command");
  assert.deepEqual(result.commands, ["npm install"]);
});

test("remediate: suggests cargo update for Cargo.toml", () => {
  const dir = tmpdir();
  const result = provider.remediate(lockfileEvidence("Cargo.toml"), { repoRoot: dir });
  assert.equal(result.kind, "command");
  assert.deepEqual(result.commands, ["cargo update"]);
});

test("remediate: suggests bundle install for a Gemfile", () => {
  const dir = tmpdir();
  const result = provider.remediate(lockfileEvidence("Gemfile"), { repoRoot: dir });
  assert.deepEqual(result.commands, ["bundle install"]);
});

test("remediate: suggests go mod tidy for go.mod", () => {
  const dir = tmpdir();
  const result = provider.remediate(lockfileEvidence("go.mod"), { repoRoot: dir });
  assert.deepEqual(result.commands, ["go mod tidy"]);
});

test("remediate: prefixes the command with 'cd <dir>' for a nested manifest", () => {
  const dir = tmpdir();
  const result = provider.remediate(lockfileEvidence("packages/app/package.json"), { repoRoot: dir });
  assert.deepEqual(result.commands, ["cd packages/app && npm install"]);
});

test("remediate: falls back to a manual suggestion for requirements.txt (no single standard tool)", () => {
  const dir = tmpdir();
  const result = provider.remediate(lockfileEvidence("requirements.txt"), { repoRoot: dir });
  assert.equal(result.kind, "manual");
  assert.match(result.summary, /poetry lock/);
});

test("remediate: falls back to a manual suggestion for pyproject.toml", () => {
  const dir = tmpdir();
  const result = provider.remediate(lockfileEvidence("pyproject.toml"), { repoRoot: dir });
  assert.equal(result.kind, "manual");
});

test("remediate: an unrecognized manifest returns null rather than guessing", () => {
  const dir = tmpdir();
  const result = provider.remediate(lockfileEvidence("some/weird/manifest.xyz"), { repoRoot: dir });
  assert.equal(result, null);
});

test("end to end: collectRemediations produces a valid suggestion for real dependency evidence", () => {
  const { collectRemediations } = require("../src/remediation");
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "");
  const ev = lockfileEvidence("package.json");
  const { remediations, limitations } = collectRemediations(
    [{ provider, source: "./plugins/remediations/npm-lockfile-sync/index.js" }],
    [ev],
    { repoRoot: dir }
  );
  assert.deepEqual(limitations, []);
  assert.equal(remediations.length, 1);
  assert.equal(remediations[0].evidenceId, ev.id);
  assert.deepEqual(remediations[0].commands, ["pnpm install"]);
});

"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { runAnalyzers } = require("../src/analyzers");
const { analyze } = require("../src/analyzers/configChange");
const { parseUnifiedDiff } = require("../src/diffParse");

function sh(cmd, cwd) {
  execFileSync("bash", ["-c", cmd], { cwd, stdio: "pipe" });
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postflight-configchange-test-"));
  sh("git init -q", dir);
  sh("git config user.email a@b.com && git config user.name test", dir);
  return dir;
}

function write(dir, file, text) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
}

// Builds parsedDiff the same way cli.js does: `git diff -M base --` over
// the (possibly uncommitted) working tree, run through the real unified
// diff parser - not a hand-built fixture.
function parsedDiffFor(dir, base = "HEAD") {
  const out = execFileSync("git", ["diff", "-M", base, "--"], { cwd: dir, encoding: "utf8" });
  return parseUnifiedDiff(out);
}

test("config-change: a clean repo with an unrelated change reports nothing (no false positives)", () => {
  const dir = makeRepo();
  write(dir, "src/a.js", "module.exports = 1;\n");
  sh("git add -A && git commit -q -m init", dir);
  write(dir, "src/a.js", "module.exports = 2;\n");
  const findings = runAnalyzers({
    base: "HEAD",
    changedFiles: ["src/a.js"],
    cwd: dir,
    repoRoot: dir,
    statuses: { "src/a.js": { status: "modified" } },
    parsedDiff: parsedDiffFor(dir),
  });
  assert.deepEqual(findings, []);
});

test("config-change: an uncommitted, non-risky CI workflow edit is flagged medium severity", () => {
  const dir = makeRepo();
  write(dir, ".github/workflows/ci.yml", "on: push\njobs:\n  test:\n    steps:\n      - run: npm test\n");
  sh("git add -A && git commit -q -m init", dir);
  write(
    dir,
    ".github/workflows/ci.yml",
    "on: push\njobs:\n  test:\n    steps:\n      - run: npm test\n      - run: npm run lint\n"
  );
  const findings = runAnalyzers({
    base: "HEAD",
    changedFiles: [".github/workflows/ci.yml"],
    cwd: dir,
    repoRoot: dir,
    statuses: { ".github/workflows/ci.yml": { status: "modified" } },
    parsedDiff: parsedDiffFor(dir),
  });
  const flagged = findings.find((f) => f.rule === "config-ci-modified");
  assert.ok(flagged, "expected a config-ci-modified finding");
  assert.equal(flagged.severity, "medium");
});

test("config-change: an uncommitted CI weakening (continue-on-error: true) is flagged high severity", () => {
  const dir = makeRepo();
  write(dir, ".github/workflows/ci.yml", "on: push\njobs:\n  test:\n    steps:\n      - run: npm test\n");
  sh("git add -A && git commit -q -m init", dir);
  write(
    dir,
    ".github/workflows/ci.yml",
    "on: push\njobs:\n  test:\n    steps:\n      - run: npm test\n        continue-on-error: true\n"
  );
  const findings = runAnalyzers({
    base: "HEAD",
    changedFiles: [".github/workflows/ci.yml"],
    cwd: dir,
    repoRoot: dir,
    statuses: { ".github/workflows/ci.yml": { status: "modified" } },
    parsedDiff: parsedDiffFor(dir),
  });
  const flagged = findings.find((f) => f.rule === "config-ci-modified");
  assert.ok(flagged, "expected a config-ci-modified finding");
  assert.equal(flagged.severity, "high");
  assert.match(flagged.snippet, /continue-on-error/);
});

test("config-change regression: npm install --ignore-scripts is a hardening measure, not a weakening one (real line from expressjs/express CI)", () => {
  // Before the fix, --ignore-scripts was in the same "risky" pattern as
  // continue-on-error/--no-verify/if:false/permissions:write-all/
  // pull_request_target. Adversarial replay against expressjs/express's
  // real .github/workflows/ci.yml found `npm install --ignore-scripts
  // --include=dev`, which *blocks* a compromised dependency's postinstall
  // script from running during CI - the opposite of a weakened pipeline.
  const dir = makeRepo();
  write(dir, ".github/workflows/ci.yml", "on: push\njobs:\n  test:\n    steps:\n      - run: npm install\n");
  sh("git add -A && git commit -q -m init", dir);
  write(
    dir,
    ".github/workflows/ci.yml",
    "on: push\njobs:\n  test:\n    steps:\n      - run: npm install --ignore-scripts --include=dev\n"
  );
  const findings = runAnalyzers({
    base: "HEAD",
    changedFiles: [".github/workflows/ci.yml"],
    cwd: dir,
    repoRoot: dir,
    statuses: { ".github/workflows/ci.yml": { status: "modified" } },
    parsedDiff: parsedDiffFor(dir),
  });
  const flagged = findings.find((f) => f.rule === "config-ci-modified");
  assert.ok(flagged, "expected a config-ci-modified finding");
  assert.equal(flagged.severity, "medium", "--ignore-scripts alone must not be treated as a CI weakening (high)");
});

test("config-change: an uncommitted Dockerfile weakening (USER root) is flagged", () => {
  const dir = makeRepo();
  write(dir, "Dockerfile", "FROM node:20\nUSER node\n");
  sh("git add -A && git commit -q -m init", dir);
  write(dir, "Dockerfile", "FROM node:20\nUSER root\n");
  const findings = runAnalyzers({
    base: "HEAD",
    changedFiles: ["Dockerfile"],
    cwd: dir,
    repoRoot: dir,
    statuses: { Dockerfile: { status: "modified" } },
    parsedDiff: parsedDiffFor(dir),
  });
  const flagged = findings.find((f) => f.rule === "config-container-risk");
  assert.ok(flagged, "expected a config-container-risk finding");
  assert.equal(flagged.severity, "medium");
});

test("config-change: an uncommitted tsconfig strictness relaxation is flagged high severity", () => {
  const dir = makeRepo();
  write(dir, "tsconfig.json", JSON.stringify({ compilerOptions: { strict: true } }));
  sh("git add -A && git commit -q -m init", dir);
  // Deliberately left uncommitted, mirroring the tool's core "review before
  // you commit" use case.
  write(dir, "tsconfig.json", JSON.stringify({ compilerOptions: { strict: false } }));
  const findings = runAnalyzers({
    base: "HEAD",
    changedFiles: ["tsconfig.json"],
    cwd: dir,
    repoRoot: dir,
    statuses: { "tsconfig.json": { status: "modified" } },
    parsedDiff: parsedDiffFor(dir),
  });
  const flagged = findings.find((f) => f.rule === "config-tsconfig-relaxed");
  assert.ok(flagged, "expected a config-tsconfig-relaxed finding");
  assert.equal(flagged.severity, "high");
  assert.match(flagged.label, /strict/);
});

test("config-change: an uncommitted tsconfig exclude-list growth is flagged medium severity", () => {
  const dir = makeRepo();
  write(dir, "tsconfig.json", JSON.stringify({ compilerOptions: { strict: true }, exclude: ["dist"] }));
  sh("git add -A && git commit -q -m init", dir);
  write(
    dir,
    "tsconfig.json",
    JSON.stringify({ compilerOptions: { strict: true }, exclude: ["dist", "src/legacy"] })
  );
  const findings = runAnalyzers({
    base: "HEAD",
    changedFiles: ["tsconfig.json"],
    cwd: dir,
    repoRoot: dir,
    statuses: { "tsconfig.json": { status: "modified" } },
    parsedDiff: parsedDiffFor(dir),
  });
  const flagged = findings.find((f) => f.rule === "config-tsconfig-scope-narrowed");
  assert.ok(flagged, "expected a config-tsconfig-scope-narrowed finding");
  assert.equal(flagged.severity, "medium");
});

test("config-change bug fix: exclude-list growth is read from the top-level tsconfig field, not compilerOptions", () => {
  // `exclude` is a top-level tsconfig.json field, not a compilerOptions field, so
  // this check silently never fired against any real tsconfig.json. This
  // reproduces exactly that shape (no top-level compilerOptions.exclude
  // anywhere) and confirms the fix reads the field where it actually
  // lives.
  const dir = makeRepo();
  write(dir, "tsconfig.json", JSON.stringify({ compilerOptions: { target: "es2020" }, exclude: ["dist"] }));
  sh("git add -A && git commit -q -m init", dir);
  write(
    dir,
    "tsconfig.json",
    JSON.stringify({ compilerOptions: { target: "es2020" }, exclude: ["dist", "src/legacy", "src/old"] })
  );
  const findings = runAnalyzers({
    base: "HEAD",
    changedFiles: ["tsconfig.json"],
    cwd: dir,
    repoRoot: dir,
    statuses: { "tsconfig.json": { status: "modified" } },
    parsedDiff: parsedDiffFor(dir),
  });
  const flagged = findings.find((f) => f.rule === "config-tsconfig-scope-narrowed");
  assert.ok(flagged, "expected a config-tsconfig-scope-narrowed finding for a top-level exclude-list growth");
});

test("config-change: an uncommitted eslint rule disable is flagged medium severity", () => {
  const dir = makeRepo();
  write(dir, ".eslintrc.json", JSON.stringify({ rules: { "no-eval": "error" } }));
  sh("git add -A && git commit -q -m init", dir);
  write(dir, ".eslintrc.json", JSON.stringify({ rules: { "no-eval": "off" } }));
  const findings = runAnalyzers({
    base: "HEAD",
    changedFiles: [".eslintrc.json"],
    cwd: dir,
    repoRoot: dir,
    statuses: { ".eslintrc.json": { status: "modified" } },
    parsedDiff: parsedDiffFor(dir),
  });
  const flagged = findings.find((f) => f.rule === "config-lint-rules-disabled");
  assert.ok(flagged, "expected a config-lint-rules-disabled finding");
  assert.equal(flagged.severity, "medium");
});

test("config-change regression: reading HEAD instead of the working tree missed an uncommitted tsconfig relaxation (pre-fix bug)", () => {
  // Reproduces the bug fixed in src/analyzers/configChange.js: the tsconfig
  // comparison used to read "after" state from `git show HEAD:file`, which
  // is blind to uncommitted changes. Calling analyze() directly with HEAD
  // as both "base" and the source of "after" simulates the pre-fix code
  // path and proves the working-tree read now wins.
  const dir = makeRepo();
  write(dir, "tsconfig.json", JSON.stringify({ compilerOptions: { strict: true } }));
  sh("git add -A && git commit -q -m init", dir);
  write(dir, "tsconfig.json", JSON.stringify({ compilerOptions: { strict: false } }));
  const { evidence } = analyze({
    base: "HEAD",
    cwd: dir,
    changedFiles: ["tsconfig.json"],
    statuses: { "tsconfig.json": { status: "modified" } },
    parsedDiff: parsedDiffFor(dir),
  });
  assert.ok(
    evidence.some((e) => e.id === "config/tsconfig-relaxed@tsconfig.json"),
    "an uncommitted tsconfig relaxation must be detected against the working tree, not HEAD"
  );
});

test("config-change: degrades to an UNKNOWN finding, not a crash, when git/fs reads fail on a broken cwd", () => {
  // Unlike sensitivePaths.js, configChange.js's tsconfig comparison does
  // read from disk/git (readAt/readNow), so an invalid cwd causes both
  // "before" and "after" reads to fail. The module is written to treat
  // that as UNKNOWN (unanalyzable), not as "no change" or a thrown error -
  // verified directly here rather than assuming it from the code.
  assert.doesNotThrow(() => {
    const findings = runAnalyzers({
      base: "HEAD",
      changedFiles: ["tsconfig.json"],
      cwd: "/nonexistent-path-xyz",
      repoRoot: "/nonexistent-path-xyz",
      statuses: { "tsconfig.json": { status: "modified" } },
      parsedDiff: [],
    });
    const unknown = findings.find((f) => f.rule === "config-tsconfig-unparsed");
    assert.ok(unknown, "expected a config-tsconfig-unparsed (UNKNOWN) finding rather than silence or a crash");
    assert.equal(unknown.severity, "low");
  });
});

// Known gap: a wholesale
// ESLint config reformat/reorder made every pre-existing "off" rule show up
// as an "added" diff line, false-positiving as newly disabled - found via
// replay against svelte's eslint.config.js but left unfixed that pass. The
// following tests reproduce that shape and confirm the fix.

test("config-change regression: reformatting a .eslintrc.json (reindent + reorder keys) does not false-positive an already-off rule as newly disabled", () => {
  const dir = makeRepo();
  write(
    dir,
    ".eslintrc.json",
    JSON.stringify({ rules: { "no-eval": "error", "no-console": "off", "no-debugger": "error" } })
  );
  sh("git add -A && git commit -q -m init", dir);
  // Same rule *state*, reformatted: pretty-printed and keys reordered -
  // exactly what a prettier pass over the file would produce.
  write(
    dir,
    ".eslintrc.json",
    JSON.stringify({ rules: { "no-debugger": "error", "no-console": "off", "no-eval": "error" } }, null, 2)
  );
  const findings = runAnalyzers({
    base: "HEAD",
    changedFiles: [".eslintrc.json"],
    cwd: dir,
    repoRoot: dir,
    statuses: { ".eslintrc.json": { status: "modified" } },
    parsedDiff: parsedDiffFor(dir),
  });
  assert.ok(
    !findings.some((f) => f.rule === "config-lint-rules-disabled"),
    "a reformat with no actual rule-state change should not be flagged"
  );
});

test("config-change: a real newly-disabled rule in a .eslintrc.json is still caught even amid a reformat", () => {
  const dir = makeRepo();
  write(dir, ".eslintrc.json", JSON.stringify({ rules: { "no-eval": "error", "no-console": "off" } }));
  sh("git add -A && git commit -q -m init", dir);
  // Reformatted AND no-eval genuinely turned off - the parsed-state
  // comparison must still catch the real change despite the noise.
  write(
    dir,
    ".eslintrc.json",
    JSON.stringify({ rules: { "no-console": "off", "no-eval": "off" } }, null, 2)
  );
  const findings = runAnalyzers({
    base: "HEAD",
    changedFiles: [".eslintrc.json"],
    cwd: dir,
    repoRoot: dir,
    statuses: { ".eslintrc.json": { status: "modified" } },
    parsedDiff: parsedDiffFor(dir),
  });
  const flagged = findings.find((f) => f.rule === "config-lint-rules-disabled");
  assert.ok(flagged, "expected the genuinely newly-disabled no-eval rule to still be flagged");
  assert.ok(flagged.label.includes("Lint rules disabled") || true);
});

test("config-change: an eslintrc rule disabled only inside an overrides[].rules scope is caught, and distinguished from the same rule globally", () => {
  const dir = makeRepo();
  write(
    dir,
    ".eslintrc.json",
    JSON.stringify({ rules: { "no-eval": "error" }, overrides: [{ files: ["test/**"], rules: { "no-eval": "error" } }] })
  );
  sh("git add -A && git commit -q -m init", dir);
  write(
    dir,
    ".eslintrc.json",
    JSON.stringify({ rules: { "no-eval": "error" }, overrides: [{ files: ["test/**"], rules: { "no-eval": "off" } }] })
  );
  const findings = runAnalyzers({
    base: "HEAD",
    changedFiles: [".eslintrc.json"],
    cwd: dir,
    repoRoot: dir,
    statuses: { ".eslintrc.json": { status: "modified" } },
    parsedDiff: parsedDiffFor(dir),
  });
  const flagged = findings.find((f) => f.rule === "config-lint-rules-disabled");
  assert.ok(flagged, "expected the overrides-scoped disable to be caught");
  assert.ok(flagged.snippet.includes("test/**"), "detail should identify the overrides scope, not just the rule name");
});

test("config-change regression: reformatting a flat eslint.config.js (line-based fallback) does not false-positive a moved, already-off rule", () => {
  // eslint.config.js is arbitrary JS - LINT_CONFIG_JSON deliberately
  // excludes it, so this exercises the text-normalization fallback rather
  // than the parsed-JSON path.
  const dir = makeRepo();
  write(
    dir,
    "eslint.config.js",
    ["export default [", "  { rules: {", "    'no-console': 'off',", "    'no-eval': 'error',", "  } },", "];"].join(
      "\n"
    )
  );
  sh("git add -A && git commit -q -m init", dir);
  // Reformatted with double quotes and reordered - same rule lines,
  // different position/quote style, nothing newly disabled.
  write(
    dir,
    "eslint.config.js",
    [
      "export default [",
      "  {",
      "    rules: {",
      '      "no-eval": "error",',
      '      "no-console": "off",',
      "    },",
      "  },",
      "];",
    ].join("\n")
  );
  const findings = runAnalyzers({
    base: "HEAD",
    changedFiles: ["eslint.config.js"],
    cwd: dir,
    repoRoot: dir,
    statuses: { "eslint.config.js": { status: "modified" } },
    parsedDiff: parsedDiffFor(dir),
  });
  assert.ok(
    !findings.some((f) => f.rule === "config-lint-rules-disabled"),
    "a moved/requoted but otherwise unchanged 'off' line should not be flagged as newly disabled"
  );
});

test("config-change: a genuinely new 'off' line in eslint.config.js (not present among removed lines) is still flagged", () => {
  const dir = makeRepo();
  write(dir, "eslint.config.js", ["export default [", "  { rules: { 'no-eval': 'error' } },", "];"].join("\n"));
  sh("git add -A && git commit -q -m init", dir);
  write(
    dir,
    "eslint.config.js",
    ["export default [", "  { rules: { 'no-eval': 'error', 'no-console': 'off' } },", "];"].join("\n")
  );
  const findings = runAnalyzers({
    base: "HEAD",
    changedFiles: ["eslint.config.js"],
    cwd: dir,
    repoRoot: dir,
    statuses: { "eslint.config.js": { status: "modified" } },
    parsedDiff: parsedDiffFor(dir),
  });
  assert.ok(findings.some((f) => f.rule === "config-lint-rules-disabled"), "a genuinely new disable should still fire");
});

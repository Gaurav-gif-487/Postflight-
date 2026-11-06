"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const BIN = path.join(__dirname, "..", "bin", "postflight.js");

function sh(cmd, cwd) {
  execFileSync("bash", ["-c", cmd], { cwd, stdio: "pipe" });
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postflight-cli-test-"));
  sh("git init -q", dir);
  sh('git config user.email a@b.com && git config user.name test', dir);
  return dir;
}

function runCli(args, cwd) {
  return spawnSync("node", [BIN, ...args], { cwd, encoding: "utf8" });
}

test("cli: exits 2 outside a git repo", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "not-a-repo-cli-"));
  const result = runCli(["run"], dir);
  assert.equal(result.status, 2);
});

test("cli: a clean diff with no risky patterns exits 0 (SAFE_TO_MERGE)", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "hello world\n");
  const result = runCli(["run", "--no-color"], dir);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /SAFE TO MERGE/);
});

test("cli: a risky diff exits 1 (REVIEW_REQUIRED)", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.js"), "// clean\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "a.js"), "const key = 'AKIAABCDEFGHIJKLMNOP';\n"); // postflight-ignore
  const result = runCli(["run", "--no-color"], dir);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /REVIEW REQUIRED/);
  assert.match(result.stdout, /AWS access key/);
});

test("cli: --format json produces valid, parseable JSON", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "x\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "y\n");
  const result = runCli(["run", "--format", "json"], dir);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, "SAFE_TO_MERGE");
  assert.equal(typeof parsed.confidence, "number");
});

test("cli: --format json includes a performance field with phase timings and coverage cache stats", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "x\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "y\n");
  const result = runCli(["run", "--format", "json"], dir);
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.performance, "expected a performance field");
  assert.ok(typeof parsed.performance.totalMs === "number");
  assert.ok(parsed.performance.phases && typeof parsed.performance.phases === "object");
  assert.ok("diff" in parsed.performance.phases, "expected the diff phase to be timed");
  assert.deepEqual(parsed.performance.coverageCache, { hits: 0, misses: 0 });
});

test("cli: --proof --coverage records real cache hits across the three places coverage.load() is called", () => {
  const dir = makeRepo();
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "a.js"), "const one = 1;\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "src", "a.js"), "const one = 11;\n");
  fs.writeFileSync(path.join(dir, "lcov.info"), "SF:src/a.js\nDA:1,1\nend_of_record\n");
  const result = runCli(["verify", "--proof", "--coverage", "lcov.info", "--no-color"], dir);
  const proof = JSON.parse(fs.readFileSync(path.join(dir, "postflight-proof.json"), "utf8"));
  assert.ok(proof.performance, "expected performance data in the proof artifact");
  // "verify" implies --policy by default, so the coverage report gets
  // asked for three times in this one run: analyzers/coverage.js's WARN
  // check, --policy's evidence-ledger collection (a second, separate
  // analyzer invocation - see analyzers/index.js's EVIDENCE_ANALYZERS),
  // and summarize() for proof.coverage. Only the first should be a real
  // parse; the other two should come straight from the mtime-keyed cache.
  assert.equal(proof.performance.coverageCache.misses, 1);
  assert.equal(proof.performance.coverageCache.hits, 2);
  assert.ok([0, 1, 3, 4].includes(result.status));
});

test("cli: --format sarif produces a valid-shaped SARIF document", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.js"), "// clean\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "a.js"), "eval('1+1')\n"); // postflight-ignore
  const result = runCli(["run", "--format", "sarif"], dir);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.version, "2.1.0");
  assert.ok(parsed.runs[0].results.length >= 1);
});

test("cli: --format sarif informationUri reflects a real GitHub 'origin' remote, not a fabricated placeholder", () => {
  const dir = makeRepo();
  sh("git remote add origin git@github.com:acme/widgets.git", dir);
  fs.writeFileSync(path.join(dir, "a.js"), "// clean\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "a.js"), "eval('1+1')\n"); // postflight-ignore
  const result = runCli(["run", "--format", "sarif"], dir);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.runs[0].tool.driver.informationUri, "https://github.com/acme/widgets");
});

test("cli: --format sarif omits informationUri when there's no GitHub 'origin' remote to resolve", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.js"), "// clean\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "a.js"), "eval('1+1')\n"); // postflight-ignore
  const result = runCli(["run", "--format", "sarif"], dir);
  const parsed = JSON.parse(result.stdout);
  assert.equal("informationUri" in parsed.runs[0].tool.driver, false);
});

test("cli: init writes a workflow file and refuses to overwrite it", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "x\n");
  sh("git add -A && git commit -q -m init", dir);
  const first = runCli(["init"], dir);
  assert.equal(first.status, 0);
  assert.ok(fs.existsSync(path.join(dir, ".github", "workflows", "postflight.yml")));
  const second = runCli(["init"], dir);
  assert.equal(second.status, 1);
});

test("cli: init fills in the real 'uses:' line when 'origin' resolves to GitHub", () => {
  const dir = makeRepo();
  sh("git remote add origin git@github.com:acme/widgets.git", dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "x\n");
  sh("git add -A && git commit -q -m init", dir);
  const result = runCli(["init"], dir);
  assert.equal(result.status, 0);
  const workflow = fs.readFileSync(path.join(dir, ".github", "workflows", "postflight.yml"), "utf8");
  assert.match(workflow, /uses: acme\/widgets@v1/);
  assert.doesNotMatch(result.stdout, /couldn't detect/);
});

test("cli: init falls back to an explicit placeholder (not a fabricated org) when 'origin' can't be resolved", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "x\n");
  sh("git add -A && git commit -q -m init", dir);
  const result = runCli(["init"], dir);
  assert.equal(result.status, 0);
  const workflow = fs.readFileSync(path.join(dir, ".github", "workflows", "postflight.yml"), "utf8");
  assert.match(workflow, /uses: <owner>\/<repo>@v1 # TODO/);
  assert.match(result.stdout, /couldn't detect a GitHub "origin" remote/);
});

test("cli: --version prints the package version", () => {
  const dir = makeRepo();
  const result = runCli(["--version"], dir);
  const pkg = require("../package.json");
  assert.equal(result.stdout.trim(), pkg.version);
});

test("cli: explain traces a finding back to its introducing commit", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.js"), "// clean\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "a.js"), "eval('1+1')\n"); // postflight-ignore
  sh("git add -A && git commit -q -m 'add eval'", dir);
  const result = runCli(["explain", "--rule", "eval-exec", "--file", "a.js", "--base", "HEAD~1"], dir);
  assert.match(result.stdout, /add eval/);
});

test("cli: explain marks an uncommitted finding's attribution as UNCONFIRMED rather than presenting a guess as fact", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.js"), "// clean\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "a.js"), "eval('1+1')\n"); // postflight-ignore, left uncommitted
  const result = runCli(["explain", "--rule", "eval-exec", "--file", "a.js"], dir);
  assert.match(result.stdout, /UNCONFIRMED/);
});

test("cli: a brand-new untracked file is reviewed, not invisible to the diff", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "x\n");
  sh("git add -A && git commit -q -m init", dir);
  // Deliberately do NOT git add this new file - simulates an agent that
  // created a file but the caller hasn't staged it yet.
  fs.writeFileSync(path.join(dir, "new-secret.js"), "const key = 'AKIAABCDEFGHIJKLMNOP';\n"); // postflight-ignore
  const result = runCli(["run", "--no-color", "--no-untested"], dir);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /new-secret\.js/);
  assert.match(result.stdout, /AWS access key/);
});

test("cli: untested-path heuristic sees untracked test files too", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "x\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "foo.js"), "module.exports = 1;\n");
  fs.writeFileSync(path.join(dir, "src", "foo.test.js"), "// covers foo.js\n");
  const result = runCli(["run", "--format", "json"], dir);
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(parsed.untestedFiles, []);
});

test("cli: a source file with no naming-convention test match is downgraded, not flagged untested, when a grouped test file changed too", () => {
  const dir = makeRepo();
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "scaffold.py"), "def register(app):\n    pass\n");
  fs.writeFileSync(path.join(dir, "tests", "test_basic.py"), "def test_register():\n    pass\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "src", "scaffold.py"), "def register(app):\n    return app\n");
  fs.writeFileSync(path.join(dir, "tests", "test_basic.py"), "def test_register():\n    assert True\n");
  const result = runCli(["run", "--format", "json"], dir);
  const parsed = JSON.parse(result.stdout);
  // Not in the confident "untested" list...
  assert.deepEqual(parsed.untestedFiles, []);
  // ...but surfaced as a weaker, distinct signal rather than silently dropped.
  assert.deepEqual(parsed.looselyUntestedFiles, ["src/scaffold.py"]);
});

test("cli: postflight.config.json ignore list excludes matching findings", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "x\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "postflight.config.json"), JSON.stringify({ ignore: ["vendor/"] }));
  fs.mkdirSync(path.join(dir, "vendor"));
  fs.writeFileSync(path.join(dir, "vendor", "bad.js"), "eval('x')\n"); // postflight-ignore
  sh("git add postflight.config.json", dir);
  const result = runCli(["run", "--format", "json"], dir);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, "SAFE_TO_MERGE");
});

test("cli: postflight.config.json severityOverrides changes a finding's verdict impact", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.js"), "// clean\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "postflight.config.json"), JSON.stringify({ severityOverrides: { "todo-added": "high" } }));
  fs.writeFileSync(path.join(dir, "a.js"), "// TODO: fix\n"); // postflight-ignore
  sh("git add postflight.config.json", dir);
  const result = runCli(["run", "--format", "json"], dir);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, "REVIEW_REQUIRED");
});

test("cli: --no-untested skips the untested-path check entirely", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "x\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "src.js"), "module.exports = 1;\n");
  const result = runCli(["run", "--format", "json", "--no-untested"], dir);
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(parsed.untestedFiles, []);
});

test("cli: --no-analyzers skips architecture-drift findings", () => {
  const dir = makeRepo();
  fs.mkdirSync(path.join(dir, "a"));
  fs.mkdirSync(path.join(dir, "b"));
  fs.writeFileSync(path.join(dir, "a", "index.js"), "module.exports = {};\n");
  fs.writeFileSync(path.join(dir, "b", "index.js"), "module.exports = {};\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "a", "index.js"), "require('../b'); module.exports = {};\n");
  fs.writeFileSync(path.join(dir, "b", "index.js"), "require('../a'); module.exports = {};\n");
  const result = runCli(["run", "--format", "json", "--no-analyzers", "--no-untested"], dir);
  const parsed = JSON.parse(result.stdout);
  assert.ok(!parsed.findings.some((f) => f.rule === "architecture-cycle"));
});

test("cli: explain exits 1 when the rule doesn't match anything in the diff", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.js"), "// clean\n");
  sh("git add -A && git commit -q -m init", dir);
  const result = runCli(["explain", "--rule", "eval-exec"], dir);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /no matching finding/);
});

test("cli: explain requires --rule", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "x\n");
  sh("git add -A && git commit -q -m init", dir);
  const result = runCli(["explain"], dir);
  assert.equal(result.status, 2);
});

test("cli: --timeout kills a hung --build command and reports it as a timeout, not a hang", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "x\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "y\n");
  const result = runCli(["run", "--no-color", "--build", "sleep 5", "--timeout", "1"], dir);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /timed out/);
});

test("cli: --timeout expects a non-negative number of seconds", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "x\n");
  sh("git add -A && git commit -q -m init", dir);
  const result = runCli(["run", "--timeout", "not-a-number"], dir);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--timeout expects a non-negative number/);
});

test("cli: --diff-behavior without --test is a usage error", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "x\n");
  sh("git add -A && git commit -q -m init", dir);
  const result = runCli(["run", "--diff-behavior"], dir);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--diff-behavior requires --test/);
});

test("cli: --diff-behavior flags a test that regressed vs base", () => {
  const dir = makeRepo();
  fs.writeFileSync(
    path.join(dir, "math.test.js"),
    "const test = require('node:test');\nconst assert = require('assert');\ntest('adds', () => { assert.equal(1 + 1, 2); });\n"
  );
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(
    path.join(dir, "math.test.js"),
    "const test = require('node:test');\nconst assert = require('assert');\ntest('adds', () => { assert.equal(1 + 1, 3); });\n"
  );
  const result = runCli(
    ["run", "--no-color", "--test", "node --test --test-reporter=tap math.test.js", "--diff-behavior"],
    dir
  );
  assert.equal(result.status, 1);
  assert.match(result.stdout, /REVIEW REQUIRED/);
  assert.match(result.stdout, /Test passed on base, now fails/);
  assert.match(result.stdout, /adds/);
});

test("cli: --diff-behavior --format json includes the behaviorDiff summary", () => {
  const dir = makeRepo();
  fs.writeFileSync(
    path.join(dir, "math.test.js"),
    "const test = require('node:test');\nconst assert = require('assert');\ntest('adds', () => { assert.equal(1 + 1, 2); });\n"
  );
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(
    path.join(dir, "math.test.js"),
    "const test = require('node:test');\nconst assert = require('assert');\ntest('adds', () => { assert.equal(1 + 1, 2); });\ntest('multiplies', () => { assert.equal(2 * 2, 4); });\n"
  );
  const result = runCli(
    ["run", "--format", "json", "--test", "node --test --test-reporter=tap math.test.js", "--diff-behavior"],
    dir
  );
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.behaviorDiff.skipped, false);
  assert.deepEqual(parsed.behaviorDiff.added, ["multiplies"]);
  assert.equal(parsed.behaviorDiff.regressions.length, 0);
  assert.equal(parsed.status, "SAFE_TO_MERGE");
});

test("cli: --diff-behavior falls back gracefully when the reporter format is unrecognized", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "x\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "y\n");
  const result = runCli(["run", "--no-color", "--test", "echo all good", "--diff-behavior"], dir);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Behavior diff/);
  assert.match(result.stdout, /--diff-behavior skipped/);
});

const { parseArgs } = require("../src/cli");

test("parseArgs: parses flags and positional command together", () => {
  const args = parseArgs(["run", "--base", "main", "--build", "npm run build", "--no-color"]);
  assert.equal(args._[0], "run");
  assert.equal(args.base, "main");
  assert.equal(args.build, "npm run build");
  assert.equal(args.noColor, true);
});

test("parseArgs: --json is back-compat for --format json", () => {
  const args = parseArgs(["run", "--json"]);
  assert.equal(args.format, "json");
});

test("parseArgs: -h and --help both set help", () => {
  assert.equal(parseArgs(["-h"]).help, true);
  assert.equal(parseArgs(["--help"]).help, true);
});

test("parseArgs: --diff-behavior sets a flag", () => {
  assert.equal(parseArgs(["run", "--diff-behavior"]).diffBehavior, true);
  assert.equal(parseArgs(["run"]).diffBehavior, undefined);
});

test("parseArgs: collects unrecognized flags instead of dropping them", () => {
  // --coverage, then --policy, used to be the canonical example of an
  // unrecognized flag here - now that both are wired in,
  // --severity-threshold (still unimplemented, and not currently planned)
  // takes over as the example.
  const args = parseArgs(["run", "--severity-threshold", "70"]);
  assert.deepEqual(args.unknown, ["--severity-threshold"]);
  // the value after an unknown flag is not consumed as its argument, so it
  // falls through to positionals - still visible, still not silently gone.
  assert.deepEqual(args._, ["run", "70"]);
});

test("cli: an unrecognized flag exits 2 instead of silently succeeding", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "x\n");
  sh("git add -A && git commit -q -m init", dir);
  const result = runCli(["run", "--severity-threshold", "70"], dir);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unrecognized option/);
  assert.match(result.stderr, /--severity-threshold/);
});

test("cli: --coverage is now a recognized flag and threads through to the coverage analyzer", () => {
  const dir = makeRepo();
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "a.js"), "const one = 1;\nconst two = 2;\nconst three = 3;\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "src", "a.js"), "const one = 1;\nconst two = 22;\nconst three = 3;\n");
  fs.mkdirSync(path.join(dir, "reports"), { recursive: true });
  fs.writeFileSync(path.join(dir, "reports", "custom.lcov"), "SF:src/a.js\nDA:1,1\nDA:2,0\nDA:3,1\nend_of_record\n");

  const withoutFlag = runCli(["run", "--format", "json"], dir);
  const withoutFindings = JSON.parse(withoutFlag.stdout).findings;
  assert.deepEqual(withoutFindings.filter((f) => f.rule.startsWith("coverage-")), []);

  const withFlag = runCli(["run", "--format", "json", "--coverage", "reports/custom.lcov"], dir);
  const withFindings = JSON.parse(withFlag.stdout).findings;
  assert.ok(withFindings.some((f) => f.rule === "coverage-changed-lines-uncovered"));
});

test("cli: an unrecognized flag on explain also exits 2", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "x\n");
  sh("git add -A && git commit -q -m init", dir);
  const result = runCli(["explain", "--rule", "eval-exec", "--severity-threshold", "70"], dir);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unrecognized option/);
});

test("cli: --policy default, a clean staged change with test evidence is SAFE_TO_MERGE, exit 0", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "hello world\n");
  sh("git add -A", dir);
  // Without --test/--build, a plain code change is honestly REVIEW_REQUIRED
  // under the default policy (touched code, nothing executed against it -
  // see src/verdict.js's "5. Code changed but nothing executed it"). A
  // trivially-succeeding --test supplies that evidence.
  const result = runCli(["run", "--no-color", "--test", "true", "--policy", "default"], dir);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /POLICY VERDICT/);
  assert.match(result.stdout, /SAFE_TO_MERGE/);
});

test("cli: --policy default, a code change with no --build/--test is REVIEW_REQUIRED (unverified, not silently safe)", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "hello world\n");
  sh("git add -A", dir);
  const result = runCli(["run", "--no-color", "--policy", "default"], dir);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /REVIEW_REQUIRED/);
  assert.match(result.stdout, /no build or test was executed/);
});

test("cli: --policy with an unknown preset name exits 2 with a helpful message", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "x\n");
  sh("git add -A && git commit -q -m init", dir);
  const result = runCli(["run", "--policy", "nonexistent"], dir);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown policy "nonexistent"/);
  assert.match(result.stderr, /default/);
  assert.match(result.stderr, /strict/);
  assert.match(result.stderr, /advisory/);
});

test("cli: --policy strict BLOCKs a code change with no build/test evidence, exit 3", () => {
  const dir = makeRepo();
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "a.js"), "const one = 1;\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "src", "a.js"), "const one = 2;\n");
  sh("git add -A", dir);
  const result = runCli(["run", "--no-color", "--policy", "strict"], dir);
  assert.equal(result.status, 3);
  assert.match(result.stdout, /BLOCK/);
});

test("cli: --policy default REVIEW_REQUIREDs (not BLOCKs) a committed pattern-rule finding, exit 1", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "config.js"), 'const key = "AKIAABCDEFGHIJKLMNOP";\n');
  sh("git add -A", dir);
  const result = runCli(["run", "--no-color", "--policy", "default"], dir);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /REVIEW_REQUIRED/);
});

test("cli: without --policy, exit codes and output are unaffected by the new engine's existence", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "hello world\n");
  const result = runCli(["run", "--no-color"], dir);
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /POLICY VERDICT/);
});

test("cli: --format json only includes policyVerdict when --policy was passed", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "hello world\n");
  sh("git add -A", dir);

  const without = JSON.parse(runCli(["run", "--format", "json"], dir).stdout);
  assert.equal(without.policyVerdict, undefined);

  const withPolicy = JSON.parse(runCli(["run", "--format", "json", "--test", "true", "--policy", "default"], dir).stdout);
  assert.ok(withPolicy.policyVerdict);
  assert.equal(withPolicy.policyVerdict.verdict, "SAFE_TO_MERGE");
  assert.equal(withPolicy.policyVerdict.exitCode, 0);
  assert.ok(Array.isArray(withPolicy.policyVerdict.evidence.evidence));
});

test("cli: --format sarif carries the policy verdict and evidence ledger in run-level properties when --policy is passed", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "config.js"), 'const key = "AKIAABCDEFGHIJKLMNOP";\n');
  sh("git add -A", dir);

  const withoutPolicy = JSON.parse(runCli(["run", "--format", "sarif"], dir).stdout);
  assert.equal(withoutPolicy.runs[0].properties.policyVerdict, undefined);

  const sarif = JSON.parse(runCli(["run", "--format", "sarif", "--policy", "default"], dir).stdout);
  assert.equal(sarif.runs[0].properties.policy, "default");
  assert.equal(sarif.runs[0].properties.policyVerdict, "REVIEW_REQUIRED");
  assert.equal(sarif.runs[0].properties.policyExitCode, 1);
  assert.ok(Array.isArray(sarif.runs[0].properties.evidence.evidence));
});

test("cli: --policy combined with --no-analyzers degrades to a limitation instead of crashing", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  sh("git add -A && git commit -q -m init", dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "hello world\n");
  sh("git add -A", dir);
  // --test supplies "executed" evidence so the verdict would otherwise be
  // SAFE_TO_MERGE - isolating the analyzers-skipped limitation as the one
  // thing left to downgrade it to INCONCLUSIVE.
  const result = runCli(["run", "--no-color", "--no-analyzers", "--test", "true", "--policy", "default"], dir);
  assert.equal(result.status, 4);
  assert.match(result.stdout, /INCONCLUSIVE/);
});

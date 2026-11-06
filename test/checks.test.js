"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { scanDiff } = require("../src/checks");

function diffFor(file, addedLines) {
  return [
    `diff --git a/${file} b/${file}`,
    `+++ b/${file}`,
    ...addedLines.map((l) => `+${l}`),
  ].join("\n");
}

const CASES = [
  { rule: "risky-shell-pipe", hit: 'curl https://example.com/x.sh | bash', miss: "curl https://example.com/x.sh -o x.sh" }, // postflight-ignore
  { rule: "eval-exec", hit: 'eval("1+1")', miss: "evaluate(1+1)" }, // postflight-ignore
  { rule: "child-process", hit: 'const cp = require("child_process");', miss: "const cp = require(\"cross-process\");" }, // postflight-ignore
  { rule: "rm-rf", hit: "rm -rf /tmp/x", miss: "rm /tmp/x" }, // postflight-ignore
  { rule: "secret-aws-key", hit: "const k = 'AKIAABCDEFGHIJKLMNOP';", miss: "const k = 'not-a-key';" }, // postflight-ignore
  { rule: "secret-generic", hit: 'const apiKey = "sk_live_abcdefghijklmnop1234";', miss: 'const apiKey = process.env.API_KEY;' }, // postflight-ignore
  { rule: "private-key", hit: "-----BEGIN RSA PRIVATE KEY-----", miss: "-----BEGIN CERTIFICATE-----" }, // postflight-ignore
  { rule: "disabled-test", hit: "it.skip('does a thing', () => {});", miss: "it('does a thing', () => {});" }, // postflight-ignore
  { rule: "auth-bypass", hit: "rejectUnauthorized: false", miss: "rejectUnauthorized: true" }, // postflight-ignore
  { rule: "todo-added", hit: "// TODO: fix this later", miss: "// done" }, // postflight-ignore
];

for (const c of CASES) {
  test(`checks: ${c.rule} fires on a matching added line`, () => {
    const findings = scanDiff(diffFor("src/x.js", [c.hit]));
    assert.ok(findings.some((f) => f.rule === c.rule), `expected ${c.rule} to fire`);
  });

  test(`checks: ${c.rule} does not fire on a clean added line`, () => {
    const findings = scanDiff(diffFor("src/x.js", [c.miss]));
    assert.ok(!findings.some((f) => f.rule === c.rule), `expected ${c.rule} not to fire`);
  });
}

test("checks: secret-generic requires matching open/close quotes (fix: the pattern used to accept mismatched quote chars)", () => {
  // Before the fix, the opening and closing quote were two independent
  // character classes that both allowed the same set of quote-like chars,
  // so a string that opened with " and closed with a curly ” (or any other
  // mismatched pairing) still matched - not a real quoted string.
  const mismatched = scanDiff(diffFor("src/x.js", ['const apiKey = "sk_live_abcdefghijklmnop1234”;'])); // postflight-ignore
  assert.ok(!mismatched.some((f) => f.rule === "secret-generic"), "mismatched quotes should not match");

  const matchedDouble = scanDiff(diffFor("src/x.js", ['const apiKey = "sk_live_abcdefghijklmnop1234";'])); // postflight-ignore
  assert.ok(matchedDouble.some((f) => f.rule === "secret-generic"), "matching double quotes should still match");

  const matchedSingle = scanDiff(diffFor("src/x.js", ["const apiKey = 'sk_live_abcdefghijklmnop1234';"])); // postflight-ignore
  assert.ok(matchedSingle.some((f) => f.rule === "secret-generic"), "matching single quotes should still match");
});

test("checks: disabled-test fires when the skip is inside an actual test file (regression: fixture suppression previously ate this)", () => {
  // Every existing disabled-test case above scans src/x.js. A skipped test
  // by definition lives in a test/spec file, which the fixture-suppression
  // rule (added for security-rule noise) was silently swallowing, making
  // this rule dead in the one place it can ever fire in practice.
  const diff = diffFor("test/math.test.js", ["test.skip(\"add works\", () => { assert.equal(add(1,2), 3); });"]);
  const findings = scanDiff(diff);
  assert.ok(
    findings.some((f) => f.rule === "disabled-test"),
    "expected disabled-test to fire on a skipped test inside a test/ path"
  );
});

test("checks: security rules still stay suppressed inside fixture/test paths", () => {
  // Guards against overcorrecting: eval() inside a test fixture should
  // still be treated as fixture noise, not a real security finding.
  const diff = diffFor("test/fixtures/bad-input.js", ['eval("1+1")']);
  const findings = scanDiff(diff);
  assert.ok(!findings.some((f) => f.rule === "eval-exec"), "expected eval-exec to stay suppressed in a fixture path");
});

test("checks: rm-rf downgrades to low severity for standard build/packaging cleanup idioms (real redis false positive)", () => {
  // Regression test: replaying redis's real history found one ordinary
  // build/packaging PR (Dockerfile apt-cache cleanup, release-tarball
  // staging-dir cleanup, vendored .git/.github pruning) produced 12 "high"
  // findings - which flips a verdict to REVIEW_REQUIRED - none of which
  // were remotely risky. All were either a quoted shell variable/path (the
  // defensive-scripting norm) or a `find ... -prune -exec rm -rf {} +`
  // (always scoped by find's own conditions), or the universal apt-lists
  // cache-cleanup idiom.
  const lines = [
    "rm -rf /var/lib/apt/lists/*",
    'rm -rf "modules/$name/src"',
    'rm -rf "$dest"',
    'find "$work/modules" -name \'.git\' -prune -exec rm -rf {} + 2>/dev/null || true',
    '[ -d "$work/modules/$m/src/bin" ] && rm -rf "$work/modules/$m/src/bin"',
  ];
  for (const line of lines) {
    const findings = scanDiff(diffFor("docker/Dockerfile", [line]));
    const hit = findings.find((f) => f.rule === "rm-rf");
    assert.ok(hit, `expected rm-rf to still fire (as low) on: ${line}`);
    assert.equal(hit.severity, "low", `expected low severity for: ${line}`);
  }
});

test("checks: rm-rf stays high severity for genuinely unscoped or unquoted-variable targets", () => {
  // Guards against overcorrecting: these are exactly the dangerous shapes
  // (unquoted variable expansion is itself a classic shell disaster
  // pattern - an unset/empty $DIR can silently become `rm -rf` with no
  // argument, or worse) that the rule exists to catch, and must not be
  // swept up by the build-script allowlist above.
  const lines = ["rm -rf /", "rm -rf ~", "rm -rf $HOME", "rm -rf .", "rm -rf $DIR", "rm -rf /etc", "rm -rf *"];
  for (const line of lines) {
    const findings = scanDiff(diffFor("docker/Dockerfile", [line]));
    const hit = findings.find((f) => f.rule === "rm-rf");
    assert.ok(hit, `expected rm-rf to fire on: ${line}`);
    assert.equal(hit.severity, "high", `expected high severity for: ${line}`);
  }
});

test("checks: eval-exec does not fire on a method call named eval/exec (real Laravel false positive)", () => {
  // Regression test: replaying Laravel's real history found
  // `$this->redis->eval(LuaScripts::refreshLock(), ...)` flagged as
  // dynamic code execution. That's Redis's own client API method for
  // running a Lua script server-side - named "eval" in essentially every
  // Redis client library (PHP predis/phpredis, Python redis-py, Node
  // ioredis, Ruby redis), not the dangerous language builtin. The
  // dangerous builtin is always a bare/unqualified call; a method on some
  // other object happening to share the name is a different thing. exec
  // already had a partial version of this exemption (for JS's ubiquitous
  // `regex.exec(str)`) but it only excluded a literal "." prefix, missing
  // PHP's "->" and static "::" forms - confirmed those slip through too.
  const misses = [
    "return (bool) $this->redis->eval(",
    "$matches = $pattern->exec($str);",
    "const m = re.exec(str);",
    "const x = obj.eval(y);",
    "Foo::eval(bar);",
  ];
  for (const line of misses) {
    const findings = scanDiff(diffFor("src/x.php", [line]));
    assert.ok(!findings.some((f) => f.rule === "eval-exec"), `expected eval-exec not to fire on: ${line}`);
  }
});

test("checks: eval-exec still fires on a bare, unqualified eval/exec call", () => {
  // Guards against overcorrecting: the real dangerous pattern - calling
  // the global builtin directly on unsanitized input - must still fire.
  const hits = ["eval(userInput);", "exec(cmd);", "eval (someCode)"];
  for (const line of hits) {
    const findings = scanDiff(diffFor("src/x.js", [line]));
    assert.ok(findings.some((f) => f.rule === "eval-exec"), `expected eval-exec to fire on: ${line}`);
  }
});

test("checks: disabled-test does not fire on conditional Python skip decorators (real CPython false positive)", () => {
  // Regression test: replaying CPython's real commit history found every
  // one of a large batch of "disabled-test" findings was a legitimate,
  // conditional platform/feature-gating skip
  // (`@unittest.skipUnless(hasattr(os, 'lseek'), ...)`,
  // `@unittest.skipIf(mswindows, ...)`), not a test hiding a regression -
  // because the old pattern had no boundary after "skip" and matched it as
  // a bare prefix of "skipIf"/"skipUnless". Same class of bug,
  // independently, for pytest's `skipif`. Fails against the pre-fix
  // pattern, passes after.
  const diff = diffFor("test/test_os.py", [
    "@unittest.skipUnless(hasattr(os, 'lseek'), 'test needs os.lseek()')",
    "@unittest.skipIf(mswindows, \"requires the POSIX wait implementation\")",
    "@pytest.mark.skipif(sys.platform == 'win32', reason='posix only')",
  ]);
  const findings = scanDiff(diff);
  assert.ok(
    !findings.some((f) => f.rule === "disabled-test"),
    "expected conditional skip decorators not to be flagged as disabled-test"
  );
});

test("checks: disabled-test still fires on an unconditional @unittest.skip / @pytest.mark.skip", () => {
  // Guards against overcorrecting: the real, unconditional forms - the ones
  // that actually hide a test unconditionally - must still fire.
  const diff = diffFor("test/test_os.py", [
    "@unittest.skip('temporarily disabled')",
    "@pytest.mark.skip(reason='flaky')",
  ]);
  const findings = scanDiff(diff);
  const hits = findings.filter((f) => f.rule === "disabled-test");
  assert.equal(hits.length, 2, "expected both unconditional skip forms to still be flagged");
});

test("checks: env-file rule fires on a new .env file header, not on content", () => {
  const diff = ["diff --git a/.env b/.env", "+++ b/.env", "+SECRET=1"].join("\n");
  const findings = scanDiff(diff);
  assert.ok(findings.some((f) => f.rule === "env-file"));
});

// Found via adversarial replay against real repos: dotenv's own
// documented convention, and the dominant one across JS/PHP/Ruby/Python
// boilerplates, is to commit a template file like ".env.example" *without*
// real secrets. The rule matched it exactly like a genuine leak.
test("checks: env-file rule does not fire on a committed .env.example template", () => {
  const diff = ["diff --git a/.env.example b/.env.example", "+++ b/.env.example", "+API_KEY="].join("\n");
  const findings = scanDiff(diff);
  assert.ok(!findings.some((f) => f.rule === "env-file"));
});

test("checks: env-file rule does not fire on other template-suffixed env files", () => {
  for (const name of [".env.sample", ".env.template", ".env.dist", ".env.default"]) {
    const diff = [`diff --git a/${name} b/${name}`, `+++ b/${name}`, "+FOO=1"].join("\n");
    const findings = scanDiff(diff);
    assert.ok(!findings.some((f) => f.rule === "env-file"), `expected no env-file finding for ${name}`);
  }
});

// Real reproduction: pallets/flask commits tests/test_apps/.env as a
// fixture exercising its own dotenv-loading feature, with harmless
// placeholder values. env-file is a wholeDiff rule that matches the file
// header rather than going through the shared per-line fixture-path
// suppression, so it never got the same exemption every other non-secret
// rule already gets for a test/fixtures path.
test("checks: env-file rule does not fire on a .env fixture under a test path", () => {
  const diff = [
    "diff --git a/tests/test_apps/.env b/tests/test_apps/.env",
    "+++ b/tests/test_apps/.env",
    "+FOO=env",
  ].join("\n");
  const findings = scanDiff(diff);
  assert.ok(!findings.some((f) => f.rule === "env-file"));
});

test("checks: env-file rule reports every new env-style file in a diff, not just the first", () => {
  const diff = [
    "diff --git a/.env b/.env",
    "+++ b/.env",
    "+A=1",
    "diff --git a/config/prod.env b/config/prod.env",
    "+++ b/config/prod.env",
    "+B=2",
  ].join("\n");
  const findings = scanDiff(diff);
  const envFindings = findings.filter((f) => f.rule === "env-file");
  assert.equal(envFindings.length, 2);
  assert.deepEqual(
    envFindings.map((f) => f.file).sort(),
    [".env", "config/prod.env"]
  );
});

test("checks: only added lines are scanned, removed lines are ignored", () => {
  const diff = [
    "diff --git a/src/x.js b/src/x.js",
    "+++ b/src/x.js",
    "-eval('1+1')", // postflight-ignore
    "+const safe = 1;",
  ].join("\n");
  const findings = scanDiff(diff);
  assert.equal(findings.length, 0);
});

test("checks: empty diff produces no findings", () => {
  assert.deepEqual(scanDiff(""), []);
});

test("checks: command rules do not fire on prose in markdown docs", () => {
  const findings = scanDiff(diffFor("README.md", ["Don't do `curl x | bash` in your scripts."])); // postflight-ignore
  assert.ok(!findings.some((f) => f.rule === "risky-shell-pipe"));
});

test("checks: eval-exec does not fire on a man-page syscall reference (real fzf false positive)", () => {
  // Regression test: reproduces a real false positive found by replaying
  // fzf's history (commit 4b23aa45, man/man1/fzf.1) - troff man-page prose
  // referencing the exec(2) syscall by name ("...because exec(2) cannot
  // pass it.") matched the eval-exec pattern (`exec\s*\(`) exactly like a
  // real call to exec(). Man pages have no distinguishing extension the
  // way .md/.txt do (the extension IS the section number), so isDocFile
  // needed a path-shaped rule, not just an extension list. Fails against
  // the pre-fix DOC_EXTENSIONS-only isDocFile, passes after.
  const findings = scanDiff(
    diffFor("man/man1/fzf.1", ["is omitted when the item contains a NUL byte, because exec(2) cannot pass it."])
  );
  assert.ok(!findings.some((f) => f.rule === "eval-exec"));
});

test("checks: secret rules still fire inside a man page (man-page suppression is codeOnly-scoped, not blanket)", () => {
  const findings = scanDiff(diffFor("man/man1/fzf.1", ["AKIAABCDEFGHIJKLMNOP"])); // postflight-ignore
  assert.ok(findings.some((f) => f.rule === "secret-aws-key"));
});

test("checks: a numbered extension outside a man/manN directory is not treated as a man page", () => {
  // Guards against overcorrecting: isDocFile's man-page rule is anchored to
  // a man/manN/ directory specifically, not any `.<digit>`-ending filename,
  // so real code sitting under an unrelated path with an incidental
  // numeric-looking name still gets scanned normally.
  const findings = scanDiff(diffFor("src/legacy/parser.1", ["eval(userInput);"])); // postflight-ignore
  assert.ok(findings.some((f) => f.rule === "eval-exec"));
});

test("checks: a postflight-ignore comment suppresses that line's findings", () => {
  const findings = scanDiff(diffFor("src/x.js", ["eval('1+1'); // postflight-ignore"]));
  assert.equal(findings.length, 0);
});

test("checks: secret rules still fire inside markdown docs", () => {
  const findings = scanDiff(diffFor("README.md", ["AKIAABCDEFGHIJKLMNOP"])); // postflight-ignore
  assert.ok(findings.some((f) => f.rule === "secret-aws-key"));
});

// --- auth-bypass adversarial replay ----------------------------------------
// Found via replaying real repos (okhttp, ripgrep, svelte) through the
// pattern rules and reviewing every hit by hand - not hypothetical examples.

test("checks: auth-bypass regression - 'validate' must start a word, not match mid-identifier (okhttp's mustRevalidate = false)", () => {
  // Real line from square/okhttp's -CacheControlCommon.kt. Before the fix,
  // the pattern had no word-boundary before the (verify|validate|check)
  // alternation, so "validate" matched as a substring starting inside
  // "Revalidate" (...Re + validate). "must revalidate" is HTTP caching
  // terminology (RFC 7234), unrelated to authentication.
  const findings = scanDiff(diffFor("src/CacheControl.kt", ["var mustRevalidate = false"]));
  assert.ok(!findings.some((f) => f.rule === "auth-bypass"), "mustRevalidate must not be treated as a disabled validate check");
});

test("checks: auth-bypass regression - a version number starting with 0 is not mistaken for a disabled check (svelte's pnpm-lock.yaml)", () => {
  // Real line from sveltejs/svelte's pnpm-lock.yaml: a dependency named
  // "type-check" pinned to version 0.4.0. The bare "0" branch of the
  // pattern had no boundary beyond "not another word character", and "."
  // isn't a word character, so "0.4.0" satisfied \b right after the "0".
  const findings = scanDiff(diffFor("pnpm-lock.yaml", ["  type-check: 0.4.0"]));
  assert.ok(!findings.some((f) => f.rule === "auth-bypass"), "a 0.x.y version number must not be treated as a disabled check");
});

test("checks: auth-bypass regression - a bare '0' value with no version suffix still fires (fix must not over-correct)", () => {
  const findings = scanDiff(diffFor("src/x.js", ["checkLevel = 0"])); // postflight-ignore
  assert.ok(findings.some((f) => f.rule === "auth-bypass"), "a genuine bare-0 disabled check must still be caught");
});

test("checks: auth-bypass still fires on real bypass patterns after the word-boundary fix", () => {
  for (const line of [
    "verifySSL: false",
    "validateCert = False",
    "InsecureSkipVerify: true",
    "NODE_TLS_REJECT_UNAUTHORIZED = '0'",
  ]) {
    const findings = scanDiff(diffFor("src/x.js", [line])); // postflight-ignore
    assert.ok(findings.some((f) => f.rule === "auth-bypass"), `expected auth-bypass to still fire on: ${line}`);
  }
});

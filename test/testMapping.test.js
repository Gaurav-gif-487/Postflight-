"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { untestedFiles, isLikelyTestFile, partitionUntested, applyTestDirs, candidateTestPaths } = require("../src/testMapping");

test("testMapping: flags a source file with no touched test file", () => {
  const result = untestedFiles(["src/foo.js"]);
  assert.deepEqual(result, ["src/foo.js"]);
});

test("testMapping: does not flag when the matching test file was also touched", () => {
  const result = untestedFiles(["src/foo.js", "src/foo.test.js"]);
  assert.deepEqual(result, []);
});

test("testMapping: does not flag test files themselves", () => {
  const result = untestedFiles(["src/foo.test.js"]);
  assert.deepEqual(result, []);
});

test("testMapping: python test_ convention is recognized", () => {
  const result = untestedFiles(["pkg/mod.py", "pkg/test_mod.py"]);
  assert.deepEqual(result, []);
});

// --- Real-repo replay: Ruby, Java/Kotlin, PHP conventions below reproduce
// actual file pairings from real commits (see comments in src/testMapping.js
// for the specific commit shas), not hypothetical examples. Rust
// deliberately gets no convention, also backed by real-repo evidence.

test("testMapping (Ruby): the lib/ -> spec/ directory-mirroring convention is recognized (rspec-core commit 9d54bbb)", () => {
  const result = untestedFiles(["lib/rspec/core/hooks.rb", "spec/rspec/core/hooks_spec.rb"]);
  assert.deepEqual(result, []);
});

test("testMapping (Ruby): a lib/ file with no spec/ mirror and no other test file touched is still flagged", () => {
  const result = untestedFiles(["lib/rspec/core/hooks.rb"]);
  assert.deepEqual(result, ["lib/rspec/core/hooks.rb"]);
});

test("testMapping (Java/Kotlin): a mixed-language module's test dir (src/test/java) is recognized for a Kotlin source file (okhttp commit 870872d)", () => {
  const result = untestedFiles([
    "okhttp-logging-interceptor/src/main/kotlin/okhttp3/logging/HttpLoggingInterceptor.kt",
    "okhttp-logging-interceptor/src/test/java/okhttp3/logging/HttpLoggingInterceptorTest.kt",
  ]);
  assert.deepEqual(result, []);
});

test("testMapping (Java/Kotlin): the classic same-language src/test/kotlin mirror still matches too", () => {
  const result = untestedFiles([
    "module/src/main/kotlin/pkg/Widget.kt",
    "module/src/test/kotlin/pkg/WidgetTest.kt",
  ]);
  assert.deepEqual(result, []);
});

test("testMapping (PHP): the src/ -> tests/ directory-mirroring convention is recognized (monolog commit 3ba77d1)", () => {
  const result = untestedFiles([
    "src/Monolog/Processor/WebProcessor.php",
    "tests/Monolog/Processor/WebProcessorTest.php",
  ]);
  assert.deepEqual(result, []);
});

test("testMapping (PHP): a same-directory FooTest.php also matches", () => {
  const result = untestedFiles(["lib/Widget.php", "lib/WidgetTest.php"]);
  assert.deepEqual(result, []);
});

test("testMapping (PHP): a .php source file with no matching test is flagged, and FooTest.php files are recognized as tests themselves", () => {
  const result = untestedFiles(["src/Monolog/Processor/WebProcessor.php"]);
  assert.deepEqual(result, ["src/Monolog/Processor/WebProcessor.php"]);
  assert.equal(isLikelyTestFile("tests/Monolog/Processor/WebProcessorTest.php"), true);
});

test("testMapping (Rust): source files get no naming-convention opinion (ripgrep/serde use inline #[cfg(test)] and behavior-named integration tests, not per-file names)", () => {
  // Verified against BurntSushi/ripgrep and serde-rs/serde: neither project
  // has a single case of foo.rs paired with a foo-named test file. Adding a
  // guessed convention here would only produce false "untested" claims, so
  // .rs is intentionally treated like an unknown extension.
  const result = untestedFiles(["src/searcher/json.rs"]);
  assert.deepEqual(result, []);
});

test("testMapping: honors a custom mapping override", () => {
  const result = untestedFiles(["src/weird.js", "custom/tests/weird_check.js"], {
    "src/weird.js": "custom/tests/weird_check.js",
  });
  assert.deepEqual(result, []);
});

test("testMapping: files with unknown extensions are not opined on", () => {
  const result = untestedFiles(["README.md"]);
  assert.deepEqual(result, []);
});

test("isLikelyTestFile: recognizes common conventions", () => {
  assert.ok(isLikelyTestFile("src/foo.test.js"));
  assert.ok(isLikelyTestFile("test/foo.js"));
  assert.ok(isLikelyTestFile("pkg/test_foo.py"));
  assert.ok(!isLikelyTestFile("src/foo.js"));
});

test("testMapping: candidateTestPaths always uses forward slashes, never backslashes (Windows regression: path.join used to emit OS-native separators, which never matched git's always-forward-slash paths)", () => {
  const { candidateTestPaths } = require("../src/testMapping");
  const cases = [
    "src/nested/deep/foo.js",
    "pkg/sub/mod.py",
    "com/acme/pkg/Foo.java",
    "internal/pkg/foo.go",
    "app/models/foo.rb",
  ];
  for (const file of cases) {
    for (const candidate of candidateTestPaths(file)) {
      assert.ok(!candidate.includes("\\"), `expected no backslashes in candidate "${candidate}" for ${file}`);
    }
  }
});

// Regression tests: confirmed on real commits in
// flask, got, and express - a source file gets flagged "untested" even
// though the diff genuinely added tests, just under a grouped/shared test
// file name that doesn't match the 1:1 naming convention (e.g. Flask's
// tests/test_basic.py covering many source files at once).
test("partitionUntested: downgrades to noConventionMatch when some other test file was touched in the diff", () => {
  // Mirrors the real flask case: src/flask/sansio/scaffold.py changed,
  // tests/test_basic.py changed too, but scaffold.py has no
  // tests/test_scaffold.py match by naming convention.
  const changedFiles = ["src/flask/sansio/scaffold.py", "tests/test_basic.py"];
  const raw = untestedFiles(changedFiles);
  assert.deepEqual(raw, ["src/flask/sansio/scaffold.py"]);
  const { untested, noConventionMatch } = partitionUntested(raw, changedFiles);
  assert.deepEqual(untested, []);
  assert.deepEqual(noConventionMatch, ["src/flask/sansio/scaffold.py"]);
});

test("partitionUntested: keeps the full-strength untested signal when no test file was touched at all", () => {
  const changedFiles = ["src/foo.js"];
  const raw = untestedFiles(changedFiles);
  const { untested, noConventionMatch } = partitionUntested(raw, changedFiles);
  assert.deepEqual(untested, ["src/foo.js"]);
  assert.deepEqual(noConventionMatch, []);
});

test("partitionUntested: a real matching test file still clears the file entirely (no downgrade needed)", () => {
  const changedFiles = ["src/foo.js", "src/foo.test.js"];
  const raw = untestedFiles(changedFiles);
  const { untested, noConventionMatch } = partitionUntested(raw, changedFiles);
  assert.deepEqual(raw, []);
  assert.deepEqual(untested, []);
  assert.deepEqual(noConventionMatch, []);
});

test("partitionUntested: empty input stays empty", () => {
  const { untested, noConventionMatch } = partitionUntested([], ["src/foo.js"]);
  assert.deepEqual(untested, []);
  assert.deepEqual(noConventionMatch, []);
});

test("testMapping: a nested source file's untested-ness is still correctly resolved against a nested, forward-slash test path", () => {
  // This is the exact case that would silently break on Windows before the
  // fix: a nested directory means path.join actually has more than one
  // segment to join, so path.sep divergence has something to bite on.
  const result = untestedFiles(["src/nested/deep/foo.js", "src/nested/deep/foo.test.js"]);
  assert.deepEqual(result, []);
});

// Known gap: okhttp's Kotlin-multiplatform source
// sets (src/commonMain, src/jvmMain, ...) map to test source sets
// (src/commonTest, src/jvmTest, ...) by a project-configured convention with
// no fixed language-level pattern. testDirs lets a repo declare that mapping
// via postflight.config.json instead.
test("testDirs: a declared source-dir -> test-dir mapping resolves an okhttp-style multiplatform layout", () => {
  const testDirs = [{ from: "src/jvmMain", to: "src/jvmTest" }];
  const changedFiles = [
    "src/jvmMain/kotlin/okhttp3/internal/Util.kt",
    "src/jvmTest/kotlin/okhttp3/internal/UtilTest.kt",
  ];
  const result = untestedFiles(changedFiles, undefined, testDirs);
  assert.deepEqual(result, []);
});

test("testDirs: without the mapping declared, the same multiplatform layout is (correctly, per the documented gap) flagged untested", () => {
  const changedFiles = [
    "src/jvmMain/kotlin/okhttp3/internal/Util.kt",
    "src/jvmTest/kotlin/okhttp3/internal/UtilTest.kt",
  ];
  const result = untestedFiles(changedFiles);
  assert.deepEqual(result, ["src/jvmMain/kotlin/okhttp3/internal/Util.kt"]);
});

test("testDirs: multiple declared mappings can coexist (commonMain/commonTest and jvmMain/jvmTest)", () => {
  const testDirs = [
    { from: "src/commonMain", to: "src/commonTest" },
    { from: "src/jvmMain", to: "src/jvmTest" },
  ];
  const changedFiles = [
    "src/commonMain/kotlin/okhttp3/Call.kt",
    "src/commonTest/kotlin/okhttp3/CallTest.kt",
    "src/jvmMain/kotlin/okhttp3/internal/Util.kt",
    "src/jvmTest/kotlin/okhttp3/internal/UtilTest.kt",
  ];
  const result = untestedFiles(changedFiles, undefined, testDirs);
  assert.deepEqual(result, []);
});

test("testDirs: an unrelated directory is unaffected by a declared mapping for a different prefix", () => {
  const testDirs = [{ from: "src/jvmMain", to: "src/jvmTest" }];
  const result = untestedFiles(["other/foo.js"], undefined, testDirs);
  assert.deepEqual(result, ["other/foo.js"]);
});

test("applyTestDirs: builtin language conventions still combine with a mapped directory (e.g. Java's FooTest.java suffix)", () => {
  const candidates = candidateTestPaths("src/main/java/com/example/Foo.java", [
    { from: "src/main", to: "src/alt-test" },
  ]);
  assert.ok(candidates.includes("src/alt-test/java/com/example/FooTest.java"));
  // The built-in src/main -> src/test convention still applies alongside it.
  assert.ok(candidates.includes("src/test/java/com/example/FooTest.java"));
});

test("applyTestDirs: malformed entries (missing from/to) are ignored rather than throwing", () => {
  assert.deepEqual(applyTestDirs("src/foo", [{ from: "src/foo" }, null, {}]), ["src/foo"]);
});

"use strict";
const path = require("path");

// candidateTestPaths builds paths purely to compare against changedFiles
// (git-reported paths, which are always POSIX-style, e.g. "src/foo.js" -
// git never emits backslashes regardless of host OS). `path.join` is
// OS-aware and would join with "\" on Windows, so a candidate like
// "src\\foo.test.js" would never match a real changed file reported as
// "src/foo.test.js" - every source file would silently look untested on
// Windows. jsImportGraph.js already guards against exactly this (see its
// own posix-join at the top of the file) - this module needs the same
// treatment. dirname/extname/basename are fine as-is: Node's path module
// accepts "/" as a separator on every platform for those, it's only
// `.join`'s *output* separator that's OS-dependent.
function posixJoin(...parts) {
  return parts
    .filter((p) => p !== "" && p !== ".")
    .join("/")
    .replace(/\/+/g, "/");
}

// Per-repo main->test directory conventions that don't follow any
// generalizable, language-level naming rule - e.g. Kotlin-multiplatform
// Gradle source sets, where a source set's test counterpart is a sibling
// name chosen by whoever configured the build (src/commonMain -> src/commonTest,
// src/jvmMain -> src/jvmTest, ...), not a fixed suffix or mirrored segment
// this module could ever guess generically. Verified as a real gap against
// square/okhttp's newer multiplatform modules:
// files under those source sets were incorrectly flagged untested with no
// fix possible via regex, because the convention is project-configured, not
// language-configured. `testDirs` (from postflight.config.json) lets a repo
// declare its own source-dir -> test-dir prefix pairs; every declared
// mapping whose `from` prefix matches the file's directory contributes an
// extra directory to search alongside the built-in language conventions
// below, so e.g. { "from": "src/jvmMain", "to": "src/jvmTest" } combines
// with the existing Java/Kotlin "Foo.kt -> FooTest.kt" suffix rule to
// produce "src/jvmTest/.../FooTest.kt" without this module needing to know
// anything about Gradle source sets itself.
function applyTestDirs(dir, testDirs) {
  const dirs = [dir];
  if (!Array.isArray(testDirs)) return dirs;
  for (const mapping of testDirs) {
    if (!mapping || !mapping.from || !mapping.to) continue;
    const from = String(mapping.from).replace(/\/+$/, "");
    const to = String(mapping.to).replace(/\/+$/, "");
    if (dir === from) dirs.push(to);
    else if (dir.startsWith(`${from}/`)) dirs.push(to + dir.slice(from.length));
  }
  return dirs;
}

// Best-effort convention mapping, not real coverage data. We generate a set
// of plausible test-file paths for a given source file and check whether any
// of them were touched in the same diff. False negatives (a real test file
// under an unconventional name) are expected and documented.
function candidateTestPaths(file, testDirs) {
  const dir = path.dirname(file);
  const ext = path.extname(file);
  const base = path.basename(file, ext);
  if (!ext) return [];

  const candidates = new Set();
  const dirs = applyTestDirs(dir, testDirs);

  // JS/TS: foo.js -> foo.test.js, foo.spec.js, __tests__/foo.js, test/foo.js
  if ([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"].includes(ext)) {
    for (const d of dirs) {
      for (const suffix of [".test", ".spec"]) {
        candidates.add(posixJoin(d, `${base}${suffix}${ext}`));
      }
      candidates.add(posixJoin(d, "__tests__", `${base}${ext}`));
    }
    candidates.add(posixJoin("test", `${base}.test${ext}`));
    candidates.add(posixJoin("tests", `${base}.test${ext}`));
  }

  // Python: foo.py -> test_foo.py, foo_test.py, tests/test_foo.py
  if (ext === ".py") {
    for (const d of dirs) {
      candidates.add(posixJoin(d, `test_${base}.py`));
      candidates.add(posixJoin(d, `${base}_test.py`));
    }
    candidates.add(posixJoin("tests", `test_${base}.py`));
    candidates.add(posixJoin("test", `test_${base}.py`));
  }

  // Java/Kotlin: Foo.java -> FooTest.java, under a src/test/... mirror of
  // src/main/.... The mirrored test source set's language directory doesn't
  // always match the main source set's: verified against square/okhttp,
  // where okhttp-logging-interceptor's main code lives under
  // src/main/kotlin/... but its test (touched in the same real commit,
  // e.g. #9184) lives under src/test/java/..., not src/test/kotlin/... -
  // a mixed Java/Kotlin Gradle module is a common, not exotic, layout.
  // Try both test language directories rather than assuming the mirror
  // keeps the source extension's language name.
  if ([".java", ".kt"].includes(ext)) {
    for (const d of dirs) {
      candidates.add(posixJoin(d, `${base}Test${ext}`));
      const testDir = d.replace(/(^|\/)src\/main(\/|$)/, "$1src/test$2");
      candidates.add(posixJoin(testDir, `${base}Test${ext}`));
      candidates.add(posixJoin(testDir.replace(/(^|\/)(java|kotlin)(\/|$)/, "$1java$3"), `${base}Test${ext}`));
      candidates.add(posixJoin(testDir.replace(/(^|\/)(java|kotlin)(\/|$)/, "$1kotlin$3"), `${base}Test${ext}`));
    }
  }

  // Go: foo.go -> foo_test.go
  if (ext === ".go") {
    for (const d of dirs) candidates.add(posixJoin(d, `${base}_test.go`));
  }

  // Ruby: foo.rb -> foo_spec.rb, test_foo.rb, plus the lib/ -> spec/
  // directory-mirroring convention RSpec itself uses (lib/rspec/core/hooks.rb
  // -> spec/rspec/core/hooks_spec.rb). Verified against rspec/rspec-core:
  // real commit 9d54bbb touches lib/rspec/core/hooks.rb and
  // spec/rspec/core/hooks_spec.rb together, but neither of the two
  // pre-existing candidates (same-dir, or flat "spec/<base>_spec.rb") ever
  // matched that pairing - the mirrored-subdirectory form is the dominant
  // convention in mature RSpec codebases, not an edge case.
  if (ext === ".rb") {
    for (const d of dirs) {
      candidates.add(posixJoin(d, `${base}_spec.rb`));
      candidates.add(posixJoin(d, `test_${base}.rb`));
      candidates.add(posixJoin(d.replace(/(^|\/)lib(\/|$)/, "$1spec$2"), `${base}_spec.rb`));
    }
    candidates.add(posixJoin("spec", `${base}_spec.rb`));
  }

  // PHP: PHPUnit convention is Foo.php -> FooTest.php, either alongside the
  // source file or under a tests/ tree that mirrors src/. Verified against
  // Seldaek/monolog: real commit 3ba77d1 touches
  // src/Monolog/Processor/WebProcessor.php and
  // tests/Monolog/Processor/WebProcessorTest.php together, which is the
  // src/ -> tests/ mirror form specifically (not same-dir, and not a flat
  // tests/ dump) - .php previously had no candidates at all, so every PHP
  // source change was silently exempted ("unknown extension - no opinion").
  if (ext === ".php") {
    for (const d of dirs) {
      candidates.add(posixJoin(d, `${base}Test.php`));
      candidates.add(posixJoin(d.replace(/(^|\/)src(\/|$)/, "$1tests$2"), `${base}Test.php`));
    }
    candidates.add(posixJoin("tests", `${base}Test.php`));
  }

  // Rust deliberately has NO naming-convention candidates. Checked against
  // two major idiomatic Rust codebases (BurntSushi/ripgrep,
  // serde-rs/serde): both put unit tests inline in the same file via
  // `#[cfg(test)] mod tests { ... }` (which this file-to-file mapping can
  // never see - the "test file" IS the source file) and integration tests
  // in a tests/ directory named after the *behavior* being tested
  // (tests/multiline.rs, tests/json.rs, test_suite/tests/test_ignored_any.rs),
  // not after any single source file. A foo.rs -> tests/foo.rs style
  // candidate would false-positive constantly on real Rust repos with no
  // corresponding gain, so - matching this module's "unknown extension, no
  // opinion" philosophy - .rs is left unmapped rather than guessed wrong.

  return [...candidates];
}

function isLikelyTestFile(file) {
  return (
    /(^|\/)(__tests__|tests?)\//.test(file) ||
    /\.(test|spec)\./.test(file) ||
    /(^|\/)test_[^/]+\.py$/.test(file) ||
    /_test\.(go|py)$/.test(file) ||
    /Test\.(java|kt|php)$/.test(file) ||
    /_spec\.rb$/.test(file)
  );
}

// Given the diff's changed files, returns the subset of *source* files
// (i.e. not already test files themselves) that have no plausible matching
// test file among the other changed files.
function untestedFiles(changedFiles, customMapping, testDirs) {
  const changedSet = new Set(changedFiles);
  const untested = [];

  for (const file of changedFiles) {
    if (isLikelyTestFile(file)) continue;

    const candidates = candidateTestPaths(file, testDirs).concat(
      customMapping && customMapping[file] ? [customMapping[file]] : []
    );
    if (candidates.length === 0) continue; // unknown extension - no opinion

    const covered = candidates.some((c) => changedSet.has(c));
    if (!covered) untested.push(file);
  }

  return untested;
}

// untestedFiles() flags a source file the moment none of its *specific*
// naming-convention candidates (foo.js -> foo.test.js, etc.) appear in the
// diff - even if other test files were touched in that same diff. That's a
// real false-positive class on mature codebases that group tests by
// feature/behavior rather than 1:1 per source file (e.g. Flask's
// tests/test_basic.py covering many source files, or got's test/redirects.ts)
// - confirmed against real commits in flask, got, and express, where files
// with genuine new test coverage in the same diff were still flagged
// "untested".
//
// This doesn't try to correlate *which* test covers *which* source file
// (that would need real coverage data, which this heuristic explicitly
// doesn't have - see the module comment above). It draws a coarser but
// honest line: if the diff touched no test files at all, "untested" is a
// confident claim. If it touched some test files just not one matching
// this file's naming convention, that's a materially weaker claim and
// callers should treat it, and penalize it, differently.
function partitionUntested(untested, changedFiles) {
  if (untested.length === 0) return { untested, noConventionMatch: [] };
  const anyTestFileTouched = changedFiles.some((f) => isLikelyTestFile(f));
  if (!anyTestFileTouched) return { untested, noConventionMatch: [] };
  return { untested: [], noConventionMatch: untested };
}

module.exports = { candidateTestPaths, isLikelyTestFile, untestedFiles, partitionUntested, applyTestDirs };

"use strict";

const git = require("../git");
const { STATUS, STRENGTH, ORIGIN, METHOD } = require("../evidence");

// An agent that cannot make the tests pass can always make the tests go away.
// This analyzer compares the test surface at base against the test surface
// now, so weakening the safety net is itself reportable evidence.

const TEST_FILE = /(^|\/)(test|tests|spec|__tests__)\/|\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py|rb)$/i;

const CASE_PATTERNS = [
  /\b(?:it|test)\s*(?:\.\w+)?\s*\(\s*["'`]/g, // js/ts
  /\bdef\s+test_\w+\s*\(/g, // python
  /\bfunc\s+Test\w+\s*\(/g, // go
  /@Test\b/g, // java/kotlin
  /\bit\s+["']/g, // ruby rspec
];

// Assertion *count* (not just test-case count) at base vs head. A test file
// can keep the same number of `it(...)`/`def test_...` blocks while an agent
// guts what's actually being checked inside them - fewer, weaker assertions
// per case is invisible to case-counting alone, so it needs its own signal.
const ASSERTION_PATTERNS = [
  /\bexpect\s*\(/g, // jest/jasmine/chai
  /\bassert\w*\s*\(/g, // node assert(), python assert*(), java Assert.assertX(), etc.
  /\bassert\s+(?!\()\S/g, // python's bare "assert <expr>" statement form (no call parens)
  /\bt\.(?:Error|Errorf|Fatal|Fatalf)\s*\(/g, // go
];

// Assertions that are trivially, unconditionally true regardless of what the
// code under test does - `expect(true).toBe(true)`, `assert True`,
// `assertEquals(1, 1)`. Unlike most of this analyzer's heuristics (which are
// syntactic proxies with real false-positive rates, documented via
// `confounders` below), a literal tautological assertion has essentially no
// legitimate use in production test code - if it's new in this diff, it was
// put there to make a check disappear while leaving the call present, so
// linters/reviewers skimming for "still has an assert" don't notice. That
// makes this the one pattern in this file precise enough to report at FAIL/
// STRONG without a confounders list.
const TAUTOLOGY_PATTERNS = [
  /\bexpect\s*\(\s*true\s*\)\s*\.\s*toBe(?:Truthy)?\s*\(\s*(?:true\s*)?\)/g, // js
  /\bexpect\s*\(\s*false\s*\)\s*\.\s*toBe(?:Falsy)?\s*\(\s*(?:false\s*)?\)/g, // js
  /\bexpect\s*\(\s*(true|false|\d+|'[^']*'|"[^"]*")\s*\)\s*\.\s*to(?:Be|Equal|StrictEqual)\s*\(\s*\1\s*\)/g, // js: expect(X).toBe(X)
  /\bassert\s*\(\s*true\s*\)/g, // node assert(true) / python assert(True)
  /\bassert\s+True\b(?!\w)/g, // python bare "assert True"
  /\bassert\.(?:ok|equal|strictEqual)\s*\(\s*true\s*(?:,.*)?\)/g, // node assert.ok(true)/assert.equal(true, ...)
  /\bassert\.equal\s*\(\s*(\d+)\s*,\s*\1\s*\)/g, // node assert.equal(1, 1)
  /\bassertTrue\s*\(\s*[Tt]rue\s*\)/g, // java assertTrue(true) / python unittest assertTrue(True)
  /\bassertEquals?\s*\(\s*(\d+)\s*,\s*\1\s*\)/g, // java/python assertEqual(1, 1)
];

const SKIP_PATTERNS = [
  /\b(?:it|test|describe|context)\s*\.\s*skip\s*\(/g,
  /\bx(?:it|describe)\s*\(/g,
  // Must NOT match @pytest.mark.skipif(...)/@unittest.skipIf|skipUnless(...)
  // - conditional platform/feature-gating decorators, not a test being
  // hidden. Same false-positive class as checks.js's disabled-test rule
  // (see its comment for the CPython-history evidence); this counter has
  // the identical unanchored "skip" prefix bug independently, since it's a
  // separate pattern list, not a shared one.
  /@pytest\.mark\.skip(?![a-zA-Z])/g,
  /@unittest\.skip(?![a-zA-Z])/g,
  /\bt\.Skip\(/g,
  /\.only\s*\(/g, // .only silently disables every other test in the file
];

function isTestFile(file) {
  return Boolean(file && TEST_FILE.test(file));
}

function countMatches(text, patterns) {
  if (!text) return 0;
  let total = 0;
  for (const re of patterns) {
    re.lastIndex = 0;
    const m = text.match(re);
    if (m) total += m.length;
  }
  return total;
}

function countCases(text) {
  return countMatches(text, CASE_PATTERNS);
}

function countAssertions(text) {
  return countMatches(text, ASSERTION_PATTERNS);
}

function countTautologies(text) {
  return countMatches(text, TAUTOLOGY_PATTERNS);
}

function countSkips(text) {
  return countMatches(text, SKIP_PATTERNS);
}

// package.json coverage thresholds are a declared safety floor; lowering one
// in the same change that adds code is a classic way to make CI pass.
function coverageThresholds(pkgText) {
  if (!pkgText) return null;
  try {
    const pkg = JSON.parse(pkgText);
    const jest = pkg.jest && pkg.jest.coverageThreshold && pkg.jest.coverageThreshold.global;
    const nyc = pkg.nyc;
    const out = {};
    for (const key of ["lines", "statements", "branches", "functions"]) {
      if (jest && typeof jest[key] === "number") out[key] = jest[key];
      else if (nyc && typeof nyc[key] === "number") out[key] = nyc[key];
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

/**
 * @param {object} ctx { base, cwd, changedFiles, statuses }
 * @returns {Array} evidence specs
 */
function analyze({ base, cwd, changedFiles = [], statuses = {} }) {
  const evidence = [];
  const testFiles = changedFiles.filter(isTestFile);

  const deleted = testFiles.filter((f) => statuses[f] && statuses[f].status === "deleted");
  if (deleted.length) {
    evidence.push({
      id: "test-integrity/deleted-test-files",
      category: "test-integrity",
      status: STATUS.FAIL,
      strength: STRENGTH.MEDIUM,
      origin: ORIGIN.INTRODUCED,
      summary: `${deleted.length} test file(s) deleted by this change`,
      detail: deleted.join(", "),
      locations: deleted.map((file) => ({ file })),
      provenance: { method: METHOD.OBSERVED, source: "git diff --name-status", ref: base },
      remediation: "Confirm the removed cases are genuinely obsolete, or restore them.",
    });
  }

  let casesBefore = 0;
  let casesAfter = 0;
  const shrunk = [];
  const newlySkipped = [];
  const assertionsGutted = [];
  const newTautologies = [];

  for (const file of testFiles) {
    const status = (statuses[file] && statuses[file].status) || "modified";
    const beforeText = status === "added" ? null : git.showFile(base, (statuses[file] && statuses[file].from) || file, cwd);
    // "After" must be the working-tree content, not HEAD: postflight's whole
    // model (git.diffAll / `git diff base`, used everywhere else in this
    // tool) is "base commit vs whatever's on disk right now," which includes
    // uncommitted and staged-but-uncommitted changes - exactly the case
    // where an agent has just skipped a test and hasn't committed yet.
    // Reading HEAD here would silently miss that, the same class of bug
    // fixed in dependencyChange.js.
    const afterText = status === "deleted" ? null : readWorktree(cwd, file);

    const before = countCases(beforeText);
    const after = countCases(afterText);
    casesBefore += before;
    casesAfter += after;

    if (beforeText && afterText && after < before) shrunk.push({ file, before, after });

    const skipsBefore = countSkips(beforeText);
    const skipsAfter = countSkips(afterText);
    if (skipsAfter > skipsBefore) newlySkipped.push({ file, added: skipsAfter - skipsBefore });

    // Same test count, fewer assertions: the case block is still there and
    // still "passes," but it checks less than it used to. Only fires when
    // the case count did NOT drop (a drop there is already the "suite
    // shrank" finding above) so this stays a distinct, non-overlapping
    // signal for "same shape, weaker inside."
    if (beforeText && afterText && after >= before) {
      const assertionsBefore = countAssertions(beforeText);
      const assertionsAfter = countAssertions(afterText);
      if (assertionsAfter < assertionsBefore) {
        assertionsGutted.push({ file, before: assertionsBefore, after: assertionsAfter });
      }
    }

    if (beforeText && afterText) {
      const tautBefore = countTautologies(beforeText);
      const tautAfter = countTautologies(afterText);
      if (tautAfter > tautBefore) newTautologies.push({ file, added: tautAfter - tautBefore });
    } else if (!beforeText && afterText) {
      // A brand-new test file that ships with a tautological assertion
      // already in it is the same failure mode - it just has no "before"
      // to diff against.
      const taut = countTautologies(afterText);
      if (taut > 0) newTautologies.push({ file, added: taut });
    }
  }

  if (shrunk.length) {
    const lost = shrunk.reduce((n, s) => n + (s.before - s.after), 0);
    evidence.push({
      id: "test-integrity/suite-shrank",
      category: "test-integrity",
      status: STATUS.WARN,
      strength: STRENGTH.MEDIUM,
      origin: ORIGIN.INTRODUCED,
      summary: `Test suite shrank by ~${lost} case(s) across ${shrunk.length} file(s)`,
      detail: shrunk.map((s) => `${s.file}: ${s.before} -> ${s.after}`).join(", "),
      locations: shrunk.map((s) => ({ file: s.file })),
      provenance: { method: METHOD.DERIVED, source: "test-case counting at base vs head", ref: base },
      confounders: ["Case counting is syntactic; a refactor into table-driven tests can look like shrinkage."],
    });
  }

  if (newlySkipped.length) {
    evidence.push({
      id: "test-integrity/newly-skipped",
      category: "test-integrity",
      status: STATUS.WARN,
      strength: STRENGTH.MEDIUM,
      origin: ORIGIN.INTRODUCED,
      summary: `${newlySkipped.reduce((n, s) => n + s.added, 0)} test(s) newly skipped or narrowed with .only`,
      detail: newlySkipped.map((s) => `${s.file} (+${s.added})`).join(", "),
      locations: newlySkipped.map((s) => ({ file: s.file })),
      provenance: { method: METHOD.DERIVED, source: "skip-marker counting at base vs head", ref: base },
    });
  }

  if (assertionsGutted.length) {
    const lost = assertionsGutted.reduce((n, s) => n + (s.before - s.after), 0);
    evidence.push({
      id: "test-integrity/assertions-reduced",
      category: "test-integrity",
      status: STATUS.WARN,
      strength: STRENGTH.MEDIUM,
      origin: ORIGIN.INTRODUCED,
      summary: `~${lost} assertion(s) removed across ${assertionsGutted.length} file(s) with the same or more test cases`,
      detail: assertionsGutted.map((s) => `${s.file}: ${s.before} -> ${s.after} assertions`).join(", "),
      locations: assertionsGutted.map((s) => ({ file: s.file })),
      provenance: { method: METHOD.DERIVED, source: "assertion-call counting at base vs head", ref: base },
      confounders: [
        "Assertion counting is syntactic; consolidating several narrow assertions into one broader matcher (e.g. several toBe() calls into one toMatchObject()) can look like a reduction without weakening coverage.",
      ],
      remediation: "Confirm the surviving assertions still cover what the removed ones checked.",
    });
  }

  if (newTautologies.length) {
    const added = newTautologies.reduce((n, s) => n + s.added, 0);
    evidence.push({
      id: "test-integrity/tautological-assertion-introduced",
      category: "test-integrity",
      status: STATUS.FAIL,
      strength: STRENGTH.STRONG,
      origin: ORIGIN.INTRODUCED,
      summary: `${added} unconditionally-true assertion(s) introduced (e.g. expect(true).toBe(true), assert True)`,
      detail: newTautologies.map((s) => `${s.file} (+${s.added})`).join(", "),
      locations: newTautologies.map((s) => ({ file: s.file })),
      provenance: { method: METHOD.OBSERVED, source: "tautological-assertion pattern match at base vs head", ref: base },
      remediation: "Replace the tautological assertion with one that actually checks the code's behavior, or restore the original check.",
    });
  }

  // Only look at package.json's coverage thresholds when package.json is
  // actually part of this diff. Previously this ran unconditionally on
  // every invocation - in a repo with no package.json at the given `base`
  // (or any run where package.json simply isn't part of the changeset),
  // `git.showFile(base, "package.json", cwd)`'s underlying `git show`
  // still printed `fatal: path 'package.json' does not exist in 'HEAD'`
  // to stderr before its failure was caught and turned into `null`. The
  // failure was always harmless (no finding, no crash - already true
  // before this fix), but the stderr noise was real and visible in every
  // CLI run, not just ones touching package.json. Guarded the same way
  // dependencyChange.js already guards its own manifest lookups.
  if (changedFiles.includes("package.json")) {
    const beforePkg = git.showFile(base, "package.json", cwd);
    // Same working-tree-not-HEAD fix as above: an uncommitted coverage
    // threshold edit must be visible.
    const afterPkg = readWorktree(cwd, "package.json");
    const beforeThresholds = coverageThresholds(beforePkg);
    const afterThresholds = coverageThresholds(afterPkg);
    if (beforeThresholds && afterThresholds) {
      const lowered = Object.keys(beforeThresholds).filter(
        (k) => typeof afterThresholds[k] === "number" && afterThresholds[k] < beforeThresholds[k]
      );
      if (lowered.length) {
        evidence.push({
          id: "test-integrity/coverage-threshold-lowered",
          category: "test-integrity",
          status: STATUS.FAIL,
          strength: STRENGTH.STRONG,
          origin: ORIGIN.INTRODUCED,
          summary: `Coverage threshold lowered for ${lowered.join(", ")}`,
          detail: lowered.map((k) => `${k}: ${beforeThresholds[k]} -> ${afterThresholds[k]}`).join(", "),
          locations: [{ file: "package.json" }],
          provenance: { method: METHOD.OBSERVED, source: "package.json at base vs head", ref: base },
          remediation: "Restore the threshold, or justify the reduction explicitly in review.",
        });
      }
    }
  }

  return { evidence, stats: { testFilesChanged: testFiles.length, casesBefore, casesAfter } };
}

function readWorktree(cwd, file) {
  try {
    return require("fs").readFileSync(require("path").join(cwd, file), "utf8");
  } catch {
    return null;
  }
}

module.exports = { analyze, isTestFile, countCases, countSkips, countAssertions, countTautologies, coverageThresholds };

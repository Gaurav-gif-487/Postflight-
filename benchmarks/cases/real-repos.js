"use strict";

// Real-repository evaluation cases (see "Real-repository evaluation" in
// docs/benchmark.md). Unlike benchmarks/cases/index.js, these are not
// synthetic - every repo/sha pair below is a real commit in a real public
// GitHub repository, verified by hand (diffed and read) before being added
// here. `run-real-repos.js` downloads the actual trees via
// codeload.github.com (no git history needed - see the runner for why) and
// runs the real, checked-out `bin/postflight.js verify` against the result.
//
// Two shapes of case:
//
//  - "diff": base is one real commit, change is the file-level diff another
//    real, later commit actually made (the files that commit touched are
//    copied from its tree onto the base tree, uncommitted - the same
//    "uncommitted working-tree change" shape benchmarks/cases/index.js
//    uses). This replays a real, unmodified commit as the candidate change.
//
//  - "overlay": base is one real commit's full tree; `overlayFiles` replaces
//    specific paths with that same path's content from a *different* real
//    ref. Used for the CVE-revert case below, where the interesting
//    scenario is a real repo's fix being silently undone - which is not
//    itself a commit that exists in the repo's history, but every byte of
//    both file versions involved is real, unmodified source from the repo.
//
// `expected` is a human judgment call (this is evaluation, not a pass/fail
// assertion suite) with a `because` explaining the reasoning, so a reader
// can disagree with the label without having to re-derive it.

const REAL_REPO_CASES = [
  {
    id: "express-cve-2024-51999-revert",
    kind: "overlay",
    category: "security",
    repo: { owner: "expressjs", name: "express" },
    description:
      "Reintroduces express's real prototype-pollution fix for CVE-2024-51999 " +
      "(GHSA-pj86-cfqh-vqx6): lib/utils.js's parseExtendedQueryString reverts from " +
      "`plainObjects: true` back to the pre-fix `allowPrototypes: true`. The test file " +
      "(test/req.query.js) is left exactly as the fixed commit left it - it is not " +
      "updated to match the reverted code, mirroring an agent that edits application " +
      "code but doesn't notice or update the tests that exercise it.",
    baseRef: "2f64f68", // express@master, the commit that fixed CVE-2024-51999
    overlayFiles: [{ path: "lib/utils.js", fromRef: "ed0ba3f" }], // pre-fix version of that one file
    policy: "default",
    expected: {
      verdictOneOf: ["REVIEW_REQUIRED", "BLOCK"],
      because:
        "Security-sensitive code (query-string parsing feeding object construction) " +
        "changed with no corresponding test update - under the default policy that is " +
        "at minimum an unverified change, and if postflight's security-pattern checks " +
        "or test-integrity heuristics fire on this specific edit, BLOCK. A silent " +
        "SAFE_TO_MERGE here would mean postflight missed a real, previously-CVE'd class " +
        "of change.",
    },
  },

  {
    id: "express-body-parser-bump",
    kind: "diff",
    category: "dependency",
    repo: { owner: "expressjs", name: "express" },
    description:
      "express's real `deps: body-parser@^2.2.1 (#6922)` commit - a routine dependency " +
      "version bump touching package.json and History.md only, no source or test files.",
    baseRef: "77bcd52",
    changeRef: "758d435",
    policy: "default",
    expected: {
      verdictOneOf: ["REVIEW_REQUIRED", "SAFE_TO_MERGE"],
      because:
        "Matches the synthetic dependency-change case's expectation: a dependency " +
        "version bump is routine, not inherently dangerous, so either an explicit " +
        "review nudge or a pass is reasonable. BLOCK here would be a false positive - " +
        "this is a real commit a maintainer merged as-is.",
    },
  },

  {
    id: "express-app-listen-microrefactor",
    kind: "diff",
    category: "surface",
    repo: { owner: "expressjs", name: "express" },
    description:
      "express's real `refactor: use cached slice in app.listen (#6897)` commit - " +
      "`Array.prototype.slice.call(arguments)` becomes a call through a module-level " +
      "cached `slice` reference. Behaviorally a no-op; touches lib/application.js only, " +
      "no test file.",
    baseRef: "2551a7d",
    changeRef: "54af593",
    policy: "default",
    expected: {
      verdictOneOf: ["SAFE_TO_MERGE", "REVIEW_REQUIRED"],
      because:
        "A false-positive check, same role as the synthetic clean-refactor control " +
        "case: this is a genuinely safe, real, merged micro-refactor with no behavior " +
        "change. It has no accompanying test change, so under the default policy a " +
        "REVIEW_REQUIRED nudge is defensible (unverified change), but BLOCK would be a " +
        "false positive on a change a real maintainer shipped without controversy.",
    },
  },
  {
    id: "express-v5.0.0-to-v5.0.1-bail-and-cookie",
    kind: "diff",
    category: "config",
    repo: { owner: "expressjs", name: "express" },
    description:
      "express's real v5.0.0 -> v5.0.1 release diff. Three real, distinct changes land " +
      "together: `--bail` is removed from the mocha `test` script in package.json (so " +
      "the suite no longer stops at the first failing test), the `cookie` dependency is " +
      "bumped from 0.6.0 to 0.7.1 (addressing CVE-2024-47764), and docs/changelog files " +
      "are updated. No test files are touched by this diff.",
    baseRef: "refs/tags/v5.0.0",
    changeRef: "refs/tags/v5.0.1",
    policy: "default",
    expected: {
      verdictOneOf: ["REVIEW_REQUIRED", "BLOCK"],
      because:
        "Two independently review-worthy signals land in one diff: a CI/test-config " +
        "change that weakens test-run strictness (matches the synthetic " +
        "disabled-security-check case's category), and a dependency bump that happens " +
        "to be a real CVE fix but isn't labeled as one anywhere postflight would see " +
        "without commit-message context. A bare SAFE_TO_MERGE would mean postflight " +
        "let a test-strictness reduction through unremarked; this is a real, maintainer" +
        "-merged release, so REVIEW_REQUIRED (a nudge, not a hard stop) is the more " +
        "defensible outcome, though BLOCK on the config signal alone wouldn't be a " +
        "false positive either.",
    },
  },
  {
    id: "itsdangerous-timed-unsign-overflow",
    kind: "diff",
    category: "security",
    repo: { owner: "pallets", name: "itsdangerous" },
    description:
      "itsdangerous's real `2.1.1 -> 2.1.2` release: `src/itsdangerous/timed.py`'s " +
      "`unsign` no longer lets an unhandled `OverflowError` (from a malformed/overflowed " +
      "timestamp on 32-bit systems) escape the signature-verification path - it's now " +
      "caught alongside `ValueError`/`OSError` and turned into the library's own " +
      "`BadTimeSignature`. Confirmed by hand: `diff -rq` between the two tags' full " +
      "trees shows exactly three files differ - `timed.py` (the fix, one added exception " +
      "type + a one-line comment), `src/itsdangerous/__init__.py` (version bump only), " +
      "and `CHANGES.rst` (changelog entry) - no test file is touched by this diff.",
    baseRef: "refs/tags/2.1.1",
    changeRef: "refs/tags/2.1.2",
    policy: "default",
    expected: {
      verdictOneOf: ["REVIEW_REQUIRED", "BLOCK"],
      because:
        "This is exception-handling logic in a signature-verification path in a " +
        "security-focused library (itsdangerous exists specifically to sign/verify " +
        "trusted data), changed with zero test evidence in the diff itself - the same " +
        "shape as the synthetic security case and the express CVE-revert real case, " +
        "just via an added except-clause rather than a removed check. A silent " +
        "SAFE_TO_MERGE would mean postflight let a security-path change through with no " +
        "signal that it needs a human or a test to confirm the new branch is exercised.",
    },
  },

  {
    id: "anyhow-downcast-ptr-ref-ptr-fix",
    kind: "diff",
    category: "security",
    repo: { owner: "dtolnay", name: "anyhow" },
    description:
      "anyhow's real `Eliminate pointer->reference->pointer during downcast` commit " +
      "(6e8c0006, parent 67c4abd7, merged via PR #452 fixing issue #451) - a real, " +
      "second-language-plugin-exercising Rust case. `src/error.rs`'s type-erased " +
      "downcast helpers stop materializing a `&ErrorImpl<...>` reference from a raw " +
      "pointer (`unerased_ref.deref()`) purely to take its address back into a raw " +
      "field pointer - a pattern that can construct references with weaker provenance " +
      "guarantees than the raw pointer arithmetic (`ptr::addr_of!` + `NonNull`) it's " +
      "replaced with. Confirmed by hand: `diff -rq` between the two commits' full trees " +
      "(fetched as tarballs) shows exactly one file differs, `src/error.rs` - no test " +
      "file is touched by this diff (the regression test for #451, in tests/test_context.rs, " +
      "was added by the *parent* commit 67c4abd7, so it's present in both trees unchanged).",
    baseRef: "67c4abd7718b6191768193993270abe8dcdd66bb",
    changeRef: "6e8c000690151cba99305092024535905b2be162",
    policy: "default",
    expected: {
      verdictOneOf: ["REVIEW_REQUIRED", "BLOCK"],
      because:
        "unsafe-block pointer/reference conversion logic changed in a widely-depended-on " +
        "error-handling crate, with zero test evidence in the diff itself (the diff's own " +
        "content, not the base tree's pre-existing coverage, is what postflight's " +
        "test-integrity heuristics see) - same shape as the itsdangerous overflow-handling " +
        "case, just in `unsafe` Rust rather than Python exception handling. A silent " +
        "SAFE_TO_MERGE would mean postflight let an unsafe-code memory-provenance change " +
        "through with no signal that it needs a human (or miri) to confirm.",
    },
  },

  {
    id: "gson-inetaddress-dns-hardening",
    kind: "diff",
    category: "security",
    repo: { owner: "google", name: "gson" },
    description:
      "gson's real `Only deserialize InetAddress from numeric IP addresses` commit " +
      "(169bb7a3, parent 4b46b6ce, PR #3075) - a real, first-language-plugin-exercising " +
      "Java case (broadens the real-repo suite past JS/Python/Go for the first time). " +
      "`TypeAdapters.INET_ADDRESS.read()` previously passed any JSON string straight to " +
      "`InetAddress.getByName()`, which silently performs a DNS lookup for non-IP-literal " +
      "strings - an SSRF-shaped hazard when the JSON is attacker-controlled. The fix adds " +
      "an IP-literal regex gate and throws `JsonSyntaxException` on non-numeric input " +
      "unless an explicit opt-out system property is set. Confirmed by hand: `diff -rq` " +
      "between the two commits' full trees shows exactly two files differ - " +
      "`TypeAdapters.java` (the fix) and `DefaultInetAddressTypeAdapterTest.java` (three " +
      "new tests covering the IPv6, rejection, and opt-out paths) - a real maintainer " +
      "landed the source change and its test coverage together, in the same commit.",
    baseRef: "4b46b6ce6c175d0742a6f9f813219053fb5e36c3",
    changeRef: "169bb7a34b30611996d893b7c6a779180109cf78",
    policy: "default",
    expected: {
      verdictOneOf: ["SAFE_TO_MERGE", "REVIEW_REQUIRED"],
      because:
        "This is the well-tested counterpart to the itsdangerous and anyhow security " +
        "cases above: a real security-hardening fix (closing an SSRF-shaped DNS-lookup " +
        "path) that *does* land with matching test coverage in the same diff. It exists " +
        "so the real-repo suite also exercises the false-positive direction on the " +
        "security category specifically, not just architecture/refactor categories - " +
        "postflight should recognize the test evidence and not BLOCK a change a real " +
        "maintainer shipped with tests attached; REVIEW_REQUIRED (a nudge given the " +
        "security-sensitive surface) is still defensible, but BLOCK would be a false " +
        "positive.",
    },
  },

  {
    id: "google-uuid-equalfold-urn-parse",
    kind: "diff",
    category: "surface",
    repo: { owner: "google", name: "uuid" },
    description:
      "google/uuid's real `fix: Use .EqualFold() to parse urn prefixed UUIDs (#118)` " +
      "commit (574e687, parent c91929c) - a real, first-language-plugin-exercising Go " +
      "case (broadens the real-repo suite past pure-JS for the first time). " +
      "`strings.ToLower(s[:9]) != \"urn:uuid:\"` becomes `!strings.EqualFold(s[:9], " +
      "\"urn:uuid:\")` in both the string- and byte-slice URL parsing paths in `uuid.go`, " +
      "plus two cosmetic trailing-comma formatting changes to nearby composite literals. " +
      "Confirmed by hand: `diff -rq` between the two commits' trees shows exactly one " +
      "file differs, `uuid.go` - no test file (`uuid_test.go` or otherwise) is touched.",
    baseRef: "c91929c",
    changeRef: "574e687",
    policy: "default",
    expected: {
      verdictOneOf: ["SAFE_TO_MERGE", "REVIEW_REQUIRED"],
      because:
        "Same role as the express app.listen micro-refactor real case and the synthetic " +
        "clean-refactor control: a real, maintainer-merged, behaviorally near-identical " +
        "parsing tweak (EqualFold is Unicode-case-fold-aware where ToLower+compare isn't, " +
        "but the compared literal is a fixed ASCII string, so this is effectively a " +
        "performance/robustness change, not a behavior change) in a widely-used library. " +
        "No test file is touched, so under the default policy a REVIEW_REQUIRED nudge is " +
        "defensible (unverified change), but BLOCK on this specific diff would be a false " +
        "positive on a change that shipped without controversy.",
    },
  },
];

module.exports = { REAL_REPO_CASES };

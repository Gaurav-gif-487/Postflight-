# Changelog

All notable changes to this project are documented here.

## [Unreleased]

### Fixed

- `action.yml`: hyphenated inputs (`diff-behavior`, `no-analyzers`,
  `proof-out`, `task-file`) were accessed as `inputs.diff-behavior`, which
  is invalid GitHub Actions expression syntax - the `-` is parsed as
  subtraction (`inputs.diff - behavior`), and `behavior` isn't a
  recognized named-value, so GitHub rejects the workflow at parse time
  ("Unrecognized named-value: 'behavior'"). This broke the action
  entirely, not just when those specific inputs were set. Fixed by
  switching to bracket notation (`inputs['diff-behavior']`, etc.), which
  is required for any input/context property name containing a hyphen.

### Added

- `--task`/`--task-file` requirements mentioning tests/regressions can
  now be reported as `UNSATISFIED`, not just `SATISFIED`/`INCONCLUSIVE` -
  specifically when the ledger has executed, `INTRODUCED`-origin test
  evidence that actually `FAIL`ed. An absent requirement with no evidence
  either way still stays `INCONCLUSIVE`; see `docs/task-verification.md`.
- The `--proof` artifact's `coverage` field is now populated with real
  changed-line coverage data (`src/coverage.js#summarize`) whenever a
  coverage report is discovered or `--coverage` points at one, instead of
  always being `null`. See `docs/proof-schema.md`.
- Basic performance instrumentation (`src/perf.js`): both `--format json`
  and `--proof` now include a `performance` field with per-phase wall-clock
  timings (diff, analyzers, build, test, policy, coverage, ...) and
  coverage-report cache hit/miss counts. See `docs/proof-schema.md`.

### Fixed (cont.)

- `src/coverage.js#load` now caches a parsed report in-process (keyed by
  resolved path + mtime, reset per run). A single `verify --proof
  --coverage` run can ask for the same report up to three times
  (the `coverage/*` evidence check, `--policy`'s evidence-ledger
  collection, and `coverage.summarize()` for the proof artifact); before
  this change each of those re-read and re-parsed the file from scratch.

## 1.3.0 - 2026-08-20

Adds the pieces needed to go from "a verdict engine you can opt into" to
"a proof-of-change layer with task verification, an offline-readable
audit trail, and a plugin extension point" - built additively on top of
1.2.0's evidence/verdict engine rather than replacing it. Every item
below is real, tested code (`npm test`: 395/395), not scaffolding.

- **`postflight verify`** - a new command that always uses the evidence/
  verdict engine (default policy unless `--policy` overrides it), and is
  what a bare `postflight` (no subcommand, inside a git repo) now
  delegates to. `postflight run` is completely unchanged unless you pass
  `--policy`, `--proof`, `--task`, or `--task-file`.
- **Proof artifact** (`src/proof.js`) - `--proof` / `--proof-out <file>`
  writes `postflight-proof.json`: a versioned (`schemaVersion: "1.0.0"`),
  deterministic (aside from `timestamp`) serialization of the evidence
  ledger, verdict, policy, limitations, and environment. JSON Schema at
  `docs/proof-schema.json`.
- **`postflight explain <evidence-id>`** - reads a proof file back
  offline (no repo re-scan) and renders one evidence record plus the
  verdict reasons that cite it. The existing `explain --rule <id>`
  (live-diff, commit-tracing) flow is unchanged.
- **Task verification** (`src/task.js`) - `--task <text>` /
  `--task-file <path>` checks stated requirements against this run's
  evidence. Deliberately conservative: a requirement is only ever
  `SATISFIED` when backed by real, attributable test evidence; a keyword
  match in the diff downgrades an otherwise-silent requirement to
  `INCONCLUSIVE` but never promotes one to `SATISFIED`. See
  `docs/task-verification.md` for the full rationale.
- **Plugin system** (`src/plugins.js`) - `.postflightrc.json`'s new
  `"plugins"` array loads external analyzers that emit the same evidence
  schema core analyzers do. `postflight plugins` / `plugins validate
  <path>` list/validate them. Plugin evidence flows into the real
  verdict engine (a plugin WARN can produce `REVIEW_REQUIRED`, verified
  end-to-end in `test/verifyCli.test.js`). Core remains fully functional
  with zero plugins configured - this was a hard requirement, not just a
  default.
- **Benchmark suite** (`benchmarks/`) - `npm run benchmark` builds a real
  temporary git repo per case and runs the actual CLI against it (no
  mocking). Seven cases including a control (a safe, tested change) so
  false positives are measured too, not just detection. Current result:
  7/7, documented honestly in `docs/benchmark.md` alongside the
  categories that are *not* covered yet (no fabricated "detection rate"
  claim).
- **GitHub Actions** - `action.yml` now accepts `proof`, `proof-out`,
  `task`, and `task-file` inputs. `docs/github.md` adds a PR-comment
  workflow with dedup (edits its own previous comment via a hidden
  marker instead of spamming the thread on every push) and a proof-
  artifact upload step; `postflight init`'s generated workflow now
  mentions `proof: "true"` alongside the existing `policy: "default"`
  hint.
- **Docs** - new `docs/architecture.md`, `docs/evidence-model.md`,
  `docs/proof-schema.md` (+ JSON Schema), `docs/plugin-api.md`,
  `docs/task-verification.md`, `docs/benchmark.md`, `docs/github.md`.
  README rewritten around "AI writes the code. postflight proves the
  change." with the pipeline diagram from the product brief.

Scope notes (what this release deliberately does not do, rather than
faking it):

- No first-party language adapters beyond the existing JS/TS analyzers
  (Go/Rust/Java/Python are the plugin system's job now, not shallow
  built-in analyzers added just to raise a language count).
- No auto-fix / `RemediationProvider` implementation. Designing a
  finding → suggested-change → user-approval → re-verify interface for
  real would be its own project; a stub interface here would just be
  unearned scaffolding, so it's left for a future release instead of
  faked.
- The `postflight` name is already taken on the npm registry, so the
  install instructions do not work as literally written until the package is
  published under a different name.
- `action.yml`'s hyphenated input references (`inputs.diff-behavior`
  etc.) use the same (pre-existing, from 1.1.0/1.2.0) expression syntax
  as before this release; not verified against a live GitHub Actions run
  in this environment (no network access here) and not newly introduced
  by this changeset.

## 1.2.0 - 2026-08-15

Closes out the four gaps left open in 1.1.0.

### Added

- `testMapping.js`: new `testDirs` config option (`postflight.config.json`)
  for declaring project-specific source-dir -> test-dir prefix mappings
  (e.g. `{ "from": "src/jvmMain", "to": "src/jvmTest" }`). Closes the
  documented okhttp Kotlin-multiplatform gap: those source sets don't
  follow any fixed language-level naming convention, so a generic regex
  fix was never possible - this makes it configurable per repo instead.
  Combines with, doesn't replace, the built-in per-language conventions.

### Fixed

- `configChange.js`'s `lint-rules-disabled` check no longer false-positives
  on a wholesale config reformat/reorder:
  - `.eslintrc.json` (real, parseable JSON) is now compared by parsed rule
    *state* at base vs. working tree, not by added diff lines - reordering
    or reformatting the file no longer changes the result, and a rule
    disabled only inside an `overrides[].rules` scope is now distinguished
    from the same rule disabled globally.
  - Flat configs that can't be safely parsed generically (`eslint.config.js`
    and friends, which are arbitrary executable JS) get a text-level
    mitigation instead: an added "off" line is only flagged if its
    normalized text doesn't also appear among that file's removed lines
    in the same diff (i.e. it wasn't just moved/requoted). Verified
    against a reproduction of the exact case found during the 1.1.0 pass's
    replay (a reformat of sveltejs/svelte's real `eslint.config.js`).
- `env-file` rule (found via this pass's own adversarial replay, not
  previously known): as a `wholeDiff` rule it never went through the
  fixture-path suppression or placeholder filtering every other rule gets,
  so it false-positived on (a) committed `.env.example`/`.env.sample`/
  `.env.template`/`.env.dist` template files - the standard, intentional
  convention for checking in shape-without-secrets across JS/PHP/Ruby/
  Python boilerplates - and (b) real test fixtures under a `test`/`tests`
  path, reproduced exactly against pallets/flask's own
  `tests/test_apps/.env`. Also fixed: it only ever reported the first new
  env-style file in a diff, silently dropping any others.
- `tools/replay/fastscan.js`: `git ls-files` had no `maxBuffer`, so the
  tool crashed outright (`ENOBUFS`) on any repo whose full file listing
  exceeds Node's 1MB default - found while replaying against
  spring-projects/spring-boot (11,875 tracked files). Now capped at 32MB,
  matching the per-file read limit already used elsewhere in the tool.

### Replay

Adversarially replayed the four pattern rules the 1.1.0 pass had left
unreplayed (`risky-shell-pipe`, `child-process`, `broad-exception-swallow`,
`env-file`) plus `todo-added`, against five freshly cloned repos not used
in any prior pass (psf/requests, pallets/flask, fastify/fastify,
actix-web/actix-web, spring-projects/spring-boot) via `fastscan.js`. Found
and fixed the `env-file` bug above; `risky-shell-pipe` (one true positive:
fastify's own CI legitimately pipes `yarnpkg.com/install.sh` into `bash`),
`child-process`, `broad-exception-swallow` (true positives only, all in
vendored third-party JS under spring-boot's smoke-test resources), and
`todo-added` produced no false positives across this batch.

## 1.1.0 - 2026-08-15

### Added

- `dependencyChange.js` now actually parses `Cargo.toml`, `go.mod`, and
  `Gemfile` dependency sections - previously these three manifest types
  were listed as recognized manifests but never parsed, so every real
  dependency change in a Rust, Go, or Ruby project only ever produced a
  blanket "unparsed" low-severity finding, never a real
  added/major-upgrade/non-registry-source finding. Added `Gemfile.lock`
  to the recognized lockfiles list (was missing).
- `testMapping.js`'s untested-file heuristic gained real conventions for
  three ecosystems, each verified against real commit history from a
  major, actively-maintained repo in that ecosystem (see
  `tools/replay/README.md` for the replay methodology):
  - Ruby: the `lib/` -> `spec/` directory-mirroring convention (verified
    against rspec/rspec-core's own commit history).
  - Java/Kotlin: a mixed-language test source set (`src/test/java` even
    when the main source lives under `src/test/kotlin`, and vice versa -
    verified against square/okhttp).
  - PHP: the `src/` -> `tests/` directory-mirroring convention plus
    same-directory `FooTest.php` (PHP previously had no candidates at
    all; verified against Seldaek/monolog).
  Rust deliberately still has no naming-convention candidates - checked
  against BurntSushi/ripgrep and serde-rs/serde, both of which put unit
  tests inline (`#[cfg(test)] mod tests`) and integration tests under
  behavior-named files, not per-source-file names, so guessing a
  convention would only produce false "untested" claims.
- `tools/replay/fastscan.js` and `tools/replay/testmapping-replay.js`,
  checked in as `npm run replay:fastscan` / `npm run replay:testmapping`:
  the adversarial-replay-against-real-repos methodology used to find the
  false positives fixed in this release and in the previous audit pass,
  now a repeatable tool instead of an ad hoc script that lived outside
  the repo for one session. See `tools/replay/README.md`.
- `test/performance.test.js`: automated regression coverage for three
  pathological diffs (a single ~100k-line generated file, a 3000-file
  vendored dependency dump, and a monorepo-wide directory rename),
  confirming the CLI completes in well under a second on all three with
  no crash.

### Fixed

- `auth-bypass`'s pattern rule had no word-boundary before its
  `(verify|validate|check)` alternation, so it could match mid-identifier:
  square/okhttp's `mustRevalidate = false` (HTTP caching, RFC 7234 -
  unrelated to auth) matched because "validate" appears as a substring of
  "Revalidate". It also matched the leading "0" of any version number
  starting with "0." (sveltejs/svelte's `pnpm-lock.yaml` has a dependency
  literally named `type-check` pinned to `0.4.0`, which matched as a
  "disabled check"). Both fixed; both were found via adversarial replay,
  not written as hypothetical test cases - see `src/checks.js` for the
  full writeup, including the still-open, deliberately-accepted noise
  class (`check_ancestors`, `overflow-checks`, `checkJs` - "check" as an
  ordinary English word, which has no generic regex fix without risking
  new false negatives on real bypass flags).
- `config-change`'s CI-risk detection no longer treats
  `npm install --ignore-scripts` as a "weakened" pipeline. It's a supply-
  chain hardening measure (blocks a compromised dependency's postinstall
  script from running), not a skipped verification step - confirmed via
  expressjs/express's own CI workflow, which uses exactly this flag.
- `jsImportGraph.js`'s `git()` helper (stderr suppression for a `git show`
  lookup that fails because the file doesn't exist at the given ref) now
  has a direct regression test. Confirmed by instrumenting the failure
  branch and running the full suite that this specific failure is
  structurally unreachable through the public `analyze()` API (every file
  `buildGraph` ever reads for a given ref is filtered through that same
  ref's `knownFiles` set first), so the underlying function
  (`readFileAtRef`) is now exported and tested directly instead.

### Fixed (earlier)

- SARIF output's `informationUri` no longer hardcodes a placeholder
  `postflight/postflight` org that doesn't exist. It's now resolved from
  the repository's `origin` git remote (same mechanism `postflight init`
  already used for its workflow template), falling back to
  `package.json`'s `repository` field, and omitted entirely - never
  another fabricated placeholder - when neither is available.
- `explain`'s "Introduced by" line no longer presents an unconfirmed
  fallback (the most recent commit touching a file, used when git's
  pickaxe search finds no commit that introduced the exact line - e.g.
  an uncommitted change) with the same phrasing as a real, confirmed
  match. The fallback case is now labeled `UNCONFIRMED` and says so
  explicitly.
- `secret-generic`'s pattern rule now requires the opening and closing
  quote character to match, instead of two independent character classes
  that both happened to accept the same set of quote-like characters
  (harmless in practice, but a regex modeling "a quoted string" should
  enforce that the quotes actually match).
- Fixed a Windows-only bug in the untested-file heuristic
  (`src/testMapping.js`): candidate test-file paths were built with
  `path.join`, which emits OS-native separators (`\` on Windows), then
  compared against git-reported changed-file paths, which are always
  forward-slash. On Windows this meant the comparison could never match,
  silently making every source file look untested. `jsImportGraph.js`
  already guarded against this exact class of bug in one place; this
  extends the same treatment to `testMapping.js`.

### Documentation

- Noted in `README.md` that the plain `postflight` name is already taken
  on the npm registry (an unrelated, inactive package) and that
  publishing under the current name as documented won't work as-is.
- Added this file, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, and
  `SECURITY.md`, plus GitHub issue/PR templates and a CI workflow that
  runs this repo's own test suite (see `.github/workflows/ci.yml`).

## 1.0.0

Initial tagged version.

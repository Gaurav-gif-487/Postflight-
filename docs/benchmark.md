# Benchmark

```bash
npm run benchmark          # run once, print results
npm run benchmark:report   # also write benchmarks/reports/latest.json
```

## What it does

`benchmarks/runner/run-benchmarks.js` builds a fresh, real, temporary git
repository for each case in `benchmarks/cases/index.js`, commits a "base"
state, applies an adversarial (or, for the control case, benign) change on
top, and runs the actual checked-out `bin/postflight.js verify` against it
— the same binary a user would run. Nothing about postflight's own logic
is mocked. A case "passes" when the resulting verdict is in that case's
`expectVerdictOneOf` set.

## Current cases

| id | category | what it plants |
|---|---|---|
| `deleted-tests` | test-integrity | Deletes the test file for changed code |
| `weakened-assertions` | test-integrity | Rewrites a real assertion into `assert.ok(true)` |
| `secret-introduction` | security | Adds a hardcoded API key |
| `disabled-security-check` | config | Comments out the test step in a CI workflow |
| `dependency-change` | dependency | Adds a new runtime dependency |
| `auth-change-untested` | surface | Changes session-creation logic with no test evidence |
| `clean-refactor` | control | A genuinely safe, tested, no-op-equivalent change |

The `control` case exists so this benchmark also reports **false
positives** (flagging a safe change), not only detection rate — a
detector graded purely on catching bad changes can trivially "win" by
flagging everything.

## What "detected" means

For every adversarial case, `expectVerdictOneOf` includes `REVIEW_REQUIRED`,
`BLOCK`, and — for the weakened-assertions case specifically —
`INCONCLUSIVE`. All three mean the same thing from a merge-safety
standpoint: **the change was not silently reported as safe to merge.**
`weakened-assertions` currently lands on `INCONCLUSIVE` rather than a more
specific `REVIEW_REQUIRED`, because postflight has no dedicated assertion-
strength analyzer yet (see Known gaps) — it's included as a pass because
the important property (not a false `SAFE_TO_MERGE`) still holds, not
because the specific verdict is the one you'd design for by hand.

## Known gaps (not benchmarked, not claimed)

- **Swallowed exceptions**, **weakened assertions beyond the pattern
  above**, and several other categories from the original adversarial
  list (disabled security *code* checks as opposed to CI config, API
  contract changes, dangerous shell commands beyond `checks.js`'s
  existing patterns) do not have a dedicated analyzer yet. They are not
  included as cases because a case that can't actually exercise real
  detection logic would just be a hardcoded expectation, not a benchmark.
- Detection rate on this 7-case, hand-written fixture set is **not** a
  claim about detection rate on arbitrary real-world diffs. Treat it as
  a regression guard (did a change to the verdict engine or an analyzer
  break something it used to catch), not a product metric.

## Real-repository evaluation

```bash
npm run benchmark:real          # run once, print results
npm run benchmark:real:report   # also write benchmarks/reports/real-repos-latest.json
```

`benchmarks/cases/index.js`'s cases are synthetic and self-contained by
design (fast, deterministic, no network). `benchmarks/cases/real-repos.js`
is the real-repository counterpart: a small, hand-picked, hand-verified set
of actual commits in actual public GitHub repositories, run through the
same real `bin/postflight.js verify --policy <preset> --format json`
invocation via `benchmarks/runner/run-real-repos.js`.

**How it fetches without `git clone`:** rather than cloning full repo
history, the runner downloads specific commit trees as tarballs from
`codeload.github.com/<owner>/<repo>/tar.gz/<sha>` — plain HTTPS GETs, no
git smart-HTTP protocol, no auth. This matters because some sandboxed or
proxied environments (for example corporate or CI sandboxes) allow plain HTTPS to `codeload.github.com` while blocking or gating
`git clone`'s protocol behind auth even for public repos — A normal
developer machine or CI runner with unrestricted internet can use either;
the tarball approach was chosen so the evaluation isn't accidentally
narrower than it needs to be. If a fetch fails for any reason (no network,
GitHub outage, a stale/wrong sha), that case is reported as **SKIPPED**,
not silently dropped or hard-failed, and a skip does not fail the run —
see `run-real-repos.js`'s exit code handling.

Each case reconstructs the same "real git commit as base, uncommitted
working-tree change on top" shape the synthetic cases use, sourced from
real file content:
- **`diff` cases** replay a real commit's actual file-level changes: the
  files a later real commit touched are copied onto an earlier real
  commit's tree, uncommitted.
- **`overlay` cases** replace specific paths on a real commit's tree with
  that same path's content from a *different* real ref — used for the
  CVE-revert case below, where the interesting scenario (a fix being
  silently undone) isn't itself a commit that exists in the repo's
  history, even though every byte of both file versions involved is real,
  unverified-by-nobody source straight from the repo.

### Current cases

Eight cases across five repositories and four languages, verified by diffing
the actual trees before being added here (see `benchmarks/cases/real-repos.js`
for the exact shas/tags and the `because` field explaining each expectation):

| id | repo | category | what it replays |
|---|---|---|---|
| `express-cve-2024-51999-revert` | expressjs/express (JS) | security | Reverts express's real one-line fix for CVE-2024-51999 (prototype pollution in query-string parsing) back to the pre-fix code, leaving the fix's own tests untouched — an agent that edits code without noticing the tests that cover it |
| `express-body-parser-bump` | expressjs/express (JS) | dependency | A real, merged `body-parser` version-bump commit — routine, package.json + changelog only |
| `express-app-listen-microrefactor` | expressjs/express (JS) | surface | A real, merged, behaviorally-inert micro-refactor with no test change — a false-positive check, same role as the synthetic `clean-refactor` case |
| `express-v5.0.0-to-v5.0.1-bail-and-cookie` | expressjs/express (JS) | config | The real v5.0.0 → v5.0.1 release diff: `--bail` removed from the test script (weakens test-run strictness) bundled with a real CVE-2024-47764 dependency fix and doc updates — two review-worthy signals landing in one real, merged diff |
| `itsdangerous-timed-unsign-overflow` | pallets/itsdangerous (Python) | security | The real 2.1.1 → 2.1.2 release: an uncaught `OverflowError` on malformed timestamps is now caught and turned into `BadTimeSignature` — a signature-verification-path change in a security-focused library, with zero test evidence in the diff |
| `google-uuid-equalfold-urn-parse` | google/uuid (Go) | surface | A real, merged commit swapping `ToLower`+compare for `EqualFold` when parsing `urn:uuid:`-prefixed UUIDs — a behaviorally near-identical robustness/perf tweak, untested, same role as the express micro-refactor case. First non-JS real-repo case |
| `anyhow-downcast-ptr-ref-ptr-fix` | dtolnay/anyhow (Rust) | security | A real, merged fix (#452, closing #451) replacing a pointer→reference→pointer round-trip with direct raw-pointer arithmetic in `unsafe` type-erased downcast code — a memory-provenance hardening change, untested in the diff itself (the regression test landed in the prior commit). First Rust real-repo case |
| `gson-inetaddress-dns-hardening` | google/gson (Java) | security | A real, merged fix (#3075) that stops `InetAddress` deserialization from silently performing a DNS lookup on non-IP-literal JSON strings (an SSRF-shaped hazard), landed together with its own test coverage in the same commit — the well-tested counterpart to the other `security`-category cases, exercising the false-positive direction on that category specifically. First Java real-repo case |

Last run: all 8 matched their stated expectation (`REVIEW_REQUIRED` in seven
of eight; every case's expected set also allows at least one other verdict —
see `benchmarks/cases/real-repos.js` for exactly which) — see
`benchmarks/reports/real-repos-latest.json` for the full JSON record,
including evidence counts.

### Adding a case

Pick a real commit, actually download and diff both trees by hand first
(`curl` the two `codeload.github.com` tarballs, `tar xzf`, `diff -rq`) to
confirm what it touches before writing the case — a case whose description
doesn't match what the commit actually did is worse than no case, since it
would misrepresent what got evaluated. Then add an entry to
`benchmarks/cases/real-repos.js` with the verified shas and an honest
`because` for the expected verdict set.

### What this is not

Eight cases, four languages, five repositories, is still a start, not a
benchmark suite — it does not support a claim about detection rate on
arbitrary real-world diffs any more than the seven synthetic cases do.
Treat both the same way: a regression guard and a worked example of the
methodology, not a product metric. All eight shipped plugins' languages
(JS, Python, Go, Rust, Java — `lang-*` covers those five; Rust and Java
are now exercised for the first time) still skew toward `security` and
`surface`/`config`/`dependency`: `test-integrity` and `control` have no
real-repo case yet, only synthetic ones, because a genuine, well-verified
real-world instance of "a maintained repo merged a commit that silently
deleted or weakened its own test coverage" turned out to be hard to find
honestly — the closest hits found in a real search were low-quality/bot-like
forks, not the kind of hand-verifiable, reputable-repo commit the rest of
this suite requires, so none was added rather than lower the bar. Still
open — see the Roadmap in `README.md`.

# postflight

**AI writes the code. postflight proves the change.**

The deterministic verification layer between AI-generated code and merge.

Claude Code, Codex, Cursor, and every agent after them can edit 100 files,
run tests, and say "done." None of that tells you whether the change is
actually *trustworthy*. postflight runs after the agent finishes and gives
you a pass/fail verdict backed by an auditable evidence ledger, so you stop
reviewing agent diffs by vibes.

```
Agent / Developer
      ↓
Changed Code
      ↓
postflight
      ↓
Acquisition + Analysis
      ↓
Evidence Ledger
      ↓
Policy Evaluation
      ↓
VERIFIED / REVIEW_REQUIRED / BLOCK / INCONCLUSIVE
      ↓
Proof Artifact + CI/PR Output
```

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        POSTFLIGHT REPORT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Files changed                                            1
  Lines added / removed                              +7 / -0
  High-severity findings                                   2
  Medium-severity findings                                 2
  Low-severity findings                                    1
  Untested paths                                           1

  Confidence                                             23%
  (heuristic penalty score, not a calibrated probability)

────────────────────────────────────────────────────────────
  FINDINGS
────────────────────────────────────────────────────────────
  [HIGH  ] Piping a remote download straight into a shell  (risky-shell-pipe)
           src/run.js — curl https://example.com/setup.sh | bash
  [HIGH  ] Possible AWS access key  (secret-aws-key)
           src/run.js — const AWS_KEY = "AKIA..."
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  STATUS: ⚠ REVIEW REQUIRED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## Why this and not another agent framework


The market doesn't need another way to orchestrate agents — worktrees,
fleets, and cost routers are converging fast and getting eaten by the
model vendors themselves. What nothing owns yet is the trust layer
underneath: **can I trust what my agent just did, regardless of which
agent or model produced it.** That job grows automatically as agents get
more capable and more autonomous, instead of getting commoditized by
them.

### Why not [Dogwood](https://github.com/aws/dogwood) / AgentCheck / NodeProof / HORKOS?

Those are real, and worth knowing about — the space is validating itself
fast. The distinction: most of them are **runtime** governance — watching
an agent's actions *as it works* (tool calls, file access, shell commands)
and intercepting or logging in-flight. postflight is deliberately
**post-hoc and structural** — it doesn't need a hook into your agent's
runtime, a daemon, or a specific harness at all. It reads the diff the
agent left behind, the same way a human reviewer would, so it works with
any agent (including ones that don't exist yet) and any CI system on day
one. The two approaches are complementary, not competitive — a runtime
governor stops an agent mid-task; postflight is the gate before merge.

## Install

```bash
npm install -g postflight
# or, without installing:
npx postflight run
```

> **Before publishing:** the plain `postflight` name is already taken on
> the npm registry (an unrelated package, last published 2022 -
> [registry entry](https://registry.npmjs.org/postflight)). The commands
> above, `action.yml`'s `run: npx postflight ...`, and every other doc
> example in this repo assume the name publishes as-is; that assumption
> is currently false and would need to be resolved (e.g. by publishing
> under a different name such as `postflight-cli` or the scoped
> `@postflight/cli` - both confirmed unclaimed as of this check) before
> any of these install instructions work.

Zero runtime dependencies. Works on any language, any repo, any agent —
it reads `git diff`, not agent-specific logs.

## Usage

```bash
# Diff working tree vs last commit, no build/test wiring
postflight run

# Wire in your real build/test commands
postflight run --build "npm run build" --test "npm test"

# Point at a coverage report outside the auto-discovered conventional
# paths (coverage/lcov.info, coverage/coverage-final.json, etc.)
postflight run --coverage path/to/report.info

# Diff against a specific ref (e.g. the commit before the agent started)
postflight run --base origin/main

# Machine-readable output
postflight run --format json    # full structured report
postflight run --format sarif   # GitHub code-scanning
postflight run --format github  # inline PR annotations (workflow commands)

# Diff test *behavior*, not just pass/fail: run --test once against
# --base and once against the change, and flag individual tests that
# newly fail (a suite can stay green overall while a specific test
# quietly flips)
postflight run --test "npm test" --diff-behavior

# Trace a finding back to the commit that introduced it
postflight explain --rule secret-aws-key --file src/config.js

# Opt into the evidence/verdict engine instead of the default score
postflight run --policy default    # or: strict | advisory

# Bound how long a hung --build/--test can run before it's killed
# (default: 600s; 0 disables the limit)
postflight run --test "npm test" --timeout 120

# Scaffold a GitHub Actions workflow
postflight init

# Verify with the evidence engine, tie it to a task, and emit a proof
# artifact - the shape a CI post-task hook actually wants
postflight verify --task "Implement OAuth login" --test "npm test" --proof
```

Exit code is `0` for `SAFE_TO_MERGE`, `1` for `REVIEW_REQUIRED`, `2` for a
usage/environment error — drop it straight into a pre-merge CI job or a
Claude Code / Codex post-task hook. Pass `--policy` and the exit code comes
from the verdict engine instead (`0`/`1`/`3`/`4` — see
[Verdicts](#verdicts---policy) below).

### GitHub Actions

`postflight init` writes this for you, filling in `uses:` from your `origin`
remote automatically:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
- uses: <owner>/<repo>@v1   # this repository, once you've published it
  with:
    base: origin/${{ github.base_ref }}
    build: "npm run build"
    test: "npm test"
    # policy: "default"    # opt into the verdict engine - see below
```

`action.yml` (at the root of this repo) also accepts `policy`,
`diff-behavior`, `coverage`, `no-analyzers`, and `timeout` inputs, mirroring
the CLI flags of the same name.

Posting the verdict as a PR comment (not just a check run) is one more
step, shown with dedup logic in
[`docs/github.md`](docs/github.md#pr-comment-with-dedup).

## Task verification

Tell postflight what the change was supposed to do, and it checks each
stated requirement against what it actually observed this run — never
against filenames or text alone:

```bash
postflight verify --task-file task.json
```

```json
{
  "task": "Implement OAuth login",
  "requirements": [
    "OAuth callback exists",
    "session is created",
    "authentication failures are handled",
    "regression tests exist"
  ]
}
```

Each requirement comes back `SATISFIED`, `UNSATISFIED`, or `INCONCLUSIVE`.
`SATISFIED` is only ever returned when a requirement is backed by real,
attributable evidence (an executed, passing, introduced test) — a keyword
match in the diff can, at most, downgrade an otherwise-silent requirement
to `INCONCLUSIVE`. It never promotes one to `SATISFIED` on its own. See
[`docs/task-verification.md`](docs/task-verification.md).

## Proof artifact

`--proof` (or `--proof-out <file>`) writes `postflight-proof.json`: a
stable, machine-readable record of the run — evidence, findings, verdict,
policy, limitations, environment — suitable for storing as a CI artifact
or attaching to a PR. Schema in
[`docs/proof-schema.md`](docs/proof-schema.md).

Read it back later with an evidence id, offline, without re-running
anything:

```bash
postflight explain test/command-result
```

## Plugins

Core ships with JS/TS analyzers and stays fully functional with zero
plugins installed. To extend it (e.g. a language postflight doesn't
natively cover), add plugin paths to `.postflightrc.json`:

```json
{ "plugins": ["./tools/postflight-plugins/rust-clippy.js"] }
```

```bash
postflight plugins            # list configured plugins
postflight plugins validate ./my-plugin.js
```

Every plugin emits the same evidence schema core analyzers use. See
[`docs/plugin-api.md`](docs/plugin-api.md).

## Benchmark

```bash
npm run benchmark          # run the adversarial fixture suite
npm run benchmark:report   # same, plus write benchmarks/reports/latest.json
```

Each case builds a real temporary git repo and runs the actual `bin/postflight.js`
against it — nothing about postflight itself is mocked. Methodology,
current results, and known gaps are in
[`docs/benchmark.md`](docs/benchmark.md); postflight does not publish a
headline detection-rate number because a 7-case hand-written fixture set
is not a claim about arbitrary real-world diffs.

## What it checks

- **Build/test pass-fail** — your own commands, captured and scored
- **Risky commands** introduced in the diff: `curl | bash`, `eval`/`exec`,
  new shell-outs, `rm -rf`
- **Hardcoded secrets**: AWS keys, generic API-key/token/password
  patterns, private key material, new `.env` files
- **Test integrity**: newly `.skip`'d or disabled tests, deleted test
  files, a test suite that shrinks in case count, a lowered Jest/nyc
  coverage threshold, assertion counts quietly reduced within a test whose
  case count didn't change, and unconditionally-true ("tautological")
  assertions introduced (`expect(true).toBe(true)`, `assert True`,
  `assertEquals(1, 1)`) — the "same test still passes, checks nothing"
  failure mode — all compared against the base revision, including
  uncommitted changes
- **Untested paths** (heuristic) — changed source files with no matching
  test file touched in the same diff, using common naming conventions
  across JS/TS, Python, Java/Kotlin, Go, and Ruby. This is a convention
  check, not real coverage instrumentation — it's flagged as such in the
  report.
- **Architecture drift** — new circular dependencies introduced between
  modules (JS/TS today, via a pluggable analyzer interface so more
  languages can be added without touching the core)
- **Sensitive-area changes** — files touched in auth/authz, payments/
  billing, database migrations, cryptography, infrastructure-as-code,
  access policy, or public API contracts, with deletions and migration
  rewrites flagged more strongly than ordinary edits
- **Configuration drift** — CI workflows weakened (`continue-on-error`,
  `|| true`, `--no-verify`, `pull_request_target`, etc.), risky Dockerfile
  changes (`USER root`, `--privileged`, `:latest`), TypeScript strictness
  flags turned off or the type-checked scope narrowed via `exclude`, and
  lint rules disabled or scoped away
- **Dependency changes** (`package.json`/`requirements.txt` today) — new
  packages, git/URL/file (non-registry) dependency sources, major version
  bumps, removed packages, new install-time lifecycle scripts
  (`postinstall` etc.), and a manifest changed without its lockfile
- **Blast radius** — how much of the repository transitively imports a
  changed JS/TS module (reverse reachability over the import graph), flagged
  when the reach crosses a declared width threshold (≥25% of source files
  or ≥50 dependents); a contained blast radius isn't reported as a finding
- **Changed-line coverage** — cross-references a `lcov`/Istanbul/Cobertura/
  Clover/JaCoCo coverage report (auto-discovered at conventional paths, or
  pointed at explicitly with `--coverage <path>`) against the lines this
  diff actually adds; flags any changed line the report shows as never
  executed. Silent when no coverage report exists — this check is opt-in,
  not a requirement
- **Behavioral regression detection** (`--diff-behavior`, requires `--test`)
  — runs your test command once against `--base` and once against the
  change, in a disposable git worktree so your working tree is never
  touched, and diffs which individual tests newly pass/fail. Recognizes
  TAP (`node --test`, tap, prove), Jest/Vitest's checkmark reporter,
  pytest, and `go test -v` output out of the box. If it can't identify
  individual tests from your runner's output, it skips gracefully and
  falls back to whole-suite pass/fail — it never guesses.

Every point of the confidence score is traceable to a specific finding —
no black-box model, no LLM call required to produce the verdict.

A bare `postflight run` with no `--build`/`--test` still produces a
confidence score and verdict from pattern checks and analyzers alone — it
just hasn't actually *executed* anything to verify the change behaves.
The text report flags this directly (`no --build or --test was run - this
reflects static checks only`), and `--format json`/`--format sarif` carry
the same signal as a `verified: false` field, so a CI consumer can tell
"checked and clean" apart from "nothing was actually run" without parsing
report text.

## Verdicts (`--policy`)

`postflight run` on its own produces the confidence score above — a
heuristic penalty score, useful, but it can't tell "checked and clean"
apart from "nothing was actually checked" as cleanly as a deterministic
policy can. Pass `--policy <preset>` to opt into a second, independent
engine instead: every check postflight ran (pattern rules, analyzers,
build/test commands, repo-state checks like a dirty tree or shallow clone)
is recorded as one auditable observation — PASS, FAIL, WARN, or UNKNOWN —
in an evidence ledger, and a small set of declarative rules turns that
ledger into one of four verdicts:

| Verdict | Meaning | Exit code |
|---|---|---|
| `SAFE_TO_MERGE` | Every check the policy requires ran and passed | `0` |
| `REVIEW_REQUIRED` | Real signal a human should look at | `1` |
| `BLOCK` | An observed, attributable, policy-relevant failure | `3` |
| `INCONCLUSIVE` | Not enough evidence to judge either way | `4` |

(`SAFE_TO_MERGE` is `VERIFIED` in the pipeline diagram above and in the
proof artifact's prose — the internal constant name and exit-code mapping
are unchanged for backward compatibility with existing `--policy` users.)

`INCONCLUSIVE` is the important one: a plain `postflight run` with no
findings looks identical to "verified safe," even if nothing was actually
executed. Under `--policy`, an unresolvable base ref, a shallow clone, or
code changed with no build/test evidence against it downgrades the verdict
instead of silently reporting 100% confidence.

Three presets ship out of the box:

- **`default`** — sensible for an existing repo adopting postflight for the
  first time. Doesn't require a build/test command to have been run, but
  flags code changes with no executed evidence as `REVIEW_REQUIRED`.
- **`strict`** — for repos with real CI signal already in place. Requires
  passing build *and* test evidence, requires ≥60% changed-line coverage
  when a coverage report is available, and blocks on a wider set of
  categories.
- **`advisory`** — report-only; never blocks. Useful for introducing
  postflight into a team's workflow without breaking anyone's PRs on day
  one.

Every reason a verdict cites points back to the specific evidence id(s) it
rests on — `--format json`'s `policyVerdict.evidence` is the full ledger,
so a verdict can be audited without re-running anything. Override any
preset field per-repo via `postflight.config.json`'s `"policy"` key (see
Configuration below) — e.g. `{ "policy": { "minStrengthToBlock": "STRONG" } }`.

Omit `--policy` entirely and nothing changes — behavior is identical to
before the flag existed.

### Suppressing a specific line

Add a trailing `// postflight-ignore` (any comment syntax works, it's
just matched as text) to an added line to exclude it from every rule —
the standard escape hatch, most useful for test fixtures that
deliberately contain the exact strings a rule looks for:

```js
const key = "AKIAABCDEFGHIJKLMNOP"; // postflight-ignore — test fixture
```

## Configuration (optional, never required)

Drop a `postflight.config.json` in your repo root to extend the defaults.
Its absence changes nothing — the zero-setup path is the default path.

```json
{
  "ignore": ["vendor/", "generated/"],
  "testMapping": { "src/weird.js": "custom/tests/weird_check.js" },
  "testDirs": [{ "from": "src/jvmMain", "to": "src/jvmTest" }],
  "severityOverrides": { "todo-added": "high" }
}
```

`testMapping` maps one specific source file to one specific test file.
`testDirs` is broader: it maps a whole source-directory *prefix* to a
test-directory prefix, for conventions a fixed naming rule can't capture on
its own — e.g. Kotlin-multiplatform Gradle source sets, where
`src/jvmMain` pairs with `src/jvmTest` by project configuration, not by any
language-level pattern. It combines with, rather than replaces, postflight's
built-in per-language conventions (so `src/jvmMain/.../Foo.kt` still also
tries `FooTest.kt` in the mapped directory).

## Commands

| Command | What it does |
|---|---|
| `postflight` / `postflight verify` | Diff, analyze, and score with the evidence/verdict engine (default policy) |
| `postflight run` | Diff, analyze, and score; `--policy` is opt-in |
| `postflight explain --rule <id> [--file <path>]` | Trace a finding to the commit that introduced it |
| `postflight explain <evidence-id>` | Trace one evidence id from a `--proof` file, offline |
| `postflight plugins [list\|validate <path>]` | List or validate configured plugins |
| `postflight init` | Write a starter GitHub Actions workflow |

Run `postflight --help` for the full flag reference.

## Architecture & docs

- [`docs/architecture.md`](docs/architecture.md) — the pipeline, module map, and design invariants
- [`docs/evidence-model.md`](docs/evidence-model.md) — the evidence/limitation schema and ledger
- [`docs/proof-schema.md`](docs/proof-schema.md) — `postflight-proof.json` field reference
- [`docs/plugin-api.md`](docs/plugin-api.md) — writing and validating plugins
- [`docs/remediation-api.md`](docs/remediation-api.md) — writing and validating RemediationProviders (suggested fixes, never auto-applied)
- [`docs/task-verification.md`](docs/task-verification.md) — requirement checking rules
- [`docs/benchmark.md`](docs/benchmark.md) — benchmark methodology and current results
- [`docs/github.md`](docs/github.md) — Actions integration, SARIF, and PR-comment dedup

## Supported environments

Node.js ≥18, any OS with `git` on `PATH` (Windows is exercised in CI but
marked non-blocking). Any language works for the
diff-level checks (secrets, config drift, dependency changes); build/test
execution and untested-path heuristics support JS/TS, Python, Java/Kotlin,
Go, and Ruby out of the box, extensible via [plugins](#plugins).

## Roadmap

- ~~More language analyzers for architecture drift (Python, Go, Java)~~ —
  done: first-party import-cycle adapters for Python, Go, Rust, and Java
  now ship in [`plugins/`](plugins/) (opt-in, same plugin interface any
  third-party plugin uses — see [`docs/plugin-api.md`](docs/plugin-api.md)
  for how to enable them and their per-language resolution limits)
- `postflight explain` improvements for multi-hunk/rewrite cases
- ~~Auto-fix: a `RemediationProvider` interface (finding → suggested
  change → explicit user approval → re-run)~~ — the interface and
  suggestion side are done: `src/remediation.js` /
  [`docs/remediation-api.md`](docs/remediation-api.md), opt-in via
  `config.remediationProviders`, wired into `verify`'s text/JSON/proof
  output, with a reference provider in
  [`plugins/remediations/npm-lockfile-sync`](plugins/remediations/npm-lockfile-sync).
  The "explicit user approval → re-run" apply step is still deliberately
  absent — postflight only ever suggests a fix (diff/commands/manual
  note), never applies one, on its own or otherwise, today
- ~~Real-repository evaluation (§10 / `docs/benchmark.md`)~~ — a first,
  small slice is done: `benchmarks/cases/real-repos.js` +
  `npm run benchmark:real` run the real CLI against eight real,
  hand-verified commits from `expressjs/express` (JS: a CVE revert, a
  dependency bump, a false-positive-check refactor, and a release diff
  bundling a test-strictness config change with a real CVE dependency
  fix), `pallets/itsdangerous` (Python: a real signature-verification
  robustness fix, untested), `google/uuid` (Go: a real, merged, untested
  parsing tweak), `dtolnay/anyhow` (Rust: a real `unsafe`-code
  memory-provenance fix, untested), and `google/gson` (Java: a real
  SSRF-shaped DNS-lookup hardening fix, landed *with* its own tests —
  the suite's first well-tested security-category case) fetched via
  `codeload.github.com` tarballs rather than `git clone`, so it works
  even where the network allows plain HTTPS but not git's smart-HTTP
  protocol. All five `lang-*` plugins (JS, Python, Go, Rust, Java) are
  now exercised by at least one real-repo case. Still genuinely narrow —
  five repositories, four languages, eight cases, and the
  `test-integrity`/`control` categories still have no real-repo case
  (only synthetic ones) — a real search for a genuine, reputable-repo
  instance of "silently deleted/weakened test coverage" didn't turn up
  anything hand-verifiable enough to add; broadening this further
  remains open; see
  "Real-repository evaluation" in
  [`docs/benchmark.md`](docs/benchmark.md)
- ~~The GitHub Action correctness check~~ — a live GitHub Actions run is
  still out of reach here (no Docker/`act`, nothing to push to), but a
  static/local check of `action.yml` itself (`test/actionYml.test.js`)
  caught two real bugs no unit test had exercised: the composite step
  shelled out via `npx --yes postflight`, but the npm name `postflight`
  belongs to an unrelated, unmaintained package with no `bin` field, so
  every single run would have failed with "could not determine executable
  to run" the first time the action was actually used; and a best-effort
  git-remote lookup (used to fill in `repository`/`informationUri` on
  `--proof`/`--format sarif` runs) leaked git's raw
  `error: No such remote 'origin'` to stderr on any repo without one,
  even though the code already handled that case gracefully. Both are
  fixed (`action.yml` now calls its own bundled
  `$GITHUB_ACTION_PATH/bin/postflight.js` directly — zero runtime
  deps, so no `npm install` needed either — and `src/git.js`'s
  `remoteSlug` suppresses stderr the same way `readFileAtRef` already
  did) and covered by tests. What's still open: exercising the
  PR-comment-dedup and SARIF-upload workflows in `docs/github.md`
  against a real PR, which needs an actual repo and Actions run

Contributions and issues welcome once this is public.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Every existing test
(`npm test`) must still pass, and new behavior needs new tests in the
same style — real git repos in a temp dir, real CLI invocations, no
mocking of postflight's own logic.

## License

MIT

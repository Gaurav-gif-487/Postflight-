# Proof artifact schema

`postflight verify --proof` (or `--proof-out <file>`) writes a
`postflight-proof.json` matching `src/proof.js#buildProof`. Current
`schemaVersion`: `1.0.0`.

| Field | Type | Notes |
|---|---|---|
| `schemaVersion` | string | Semver; bump on any breaking field change |
| `toolVersion` | string | postflight's own `package.json` version |
| `repository` | string \| null | Best-effort remote URL, `null` if undetectable |
| `commit` | string \| null | `git rev-parse HEAD` at run time |
| `baseCommit` | string \| null | Resolved `--base` |
| `timestamp` | string | ISO 8601. The only field expected to differ between two otherwise-identical runs |
| `changedFiles` | string[] | Tracked + untracked changed files |
| `changedLines` | `{ insertions, deletions }` | |
| `tests` | `{ command, passed, exitCode, durationMs } \| null` | Present only if `--test` was passed |
| `coverage` | object \| null | Populated whenever a coverage report was found and readable this run (see below); `{ available: false, reason }` when none was found or it couldn't be parsed |
| `analyzers` | string[] | Evidence categories that produced at least one record this run |
| `evidence` | Evidence[] | The full ledger, sorted by `id` (see `docs/evidence-model.md`) |
| `findings` | Evidence[] | Subset of `evidence` where `status` is `FAIL` or `WARN` |
| `task` | object \| null | Output of `--task`/`--task-file` (see `docs/task-verification.md`) |
| `policies` | `{ name } \| null` | Which preset resolved the verdict |
| `limitations` | Limitation[] | What postflight could not check this run |
| `verdict` | `{ value, exitCode, reasons, evidenceScore } \| null` | |
| `performance` | object \| null | Phase timings and coverage-cache stats for this run (see below) |
| `environment` | `{ node, platform, ci, ... }` | |

## `coverage`

When a coverage report is discovered (or `--coverage <path>` points at
one) and it parses, `coverage` reports changed-line coverage for the
diff, computed by `src/coverage.js#summarize`:

```json
{
  "available": true,
  "format": "lcov",
  "file": "/repo/coverage/lcov.info",
  "generatedAt": "2026-08-19T10:00:00.000Z",
  "changedLines": { "covered": 12, "executable": 14, "ratio": 0.857 },
  "files": {
    "src/foo.js": { "measured": true, "covered": 5, "executable": 5, "ratio": 1 },
    "src/bar.js": { "measured": false, "reason": "file absent from coverage report" }
  }
}
```

This is a straight report of what was observed, present or not - it is
separate from `analyzers/coverage.js`'s opinionated `coverage/*` WARN
evidence (only emitted when the report is stale or something is actually
uncovered). A file with `measured: false` was outside the coverage
report entirely (unmeasured), which is a different claim from "measured
and uncovered."

## `performance`

Wall-clock milliseconds per phase for this run (`src/perf.js`), plus how
often the in-process coverage-report cache paid off:

```json
{
  "totalMs": 842,
  "phases": { "diff": 12, "patternScan": 4, "analyzers": 38, "untested": 2, "build": 610, "test": 140, "policy": 21, "coverage": 3 },
  "coverageCache": { "hits": 2, "misses": 1 }
}
```

A phase key is only present if it actually ran (`--no-analyzers` means
no `analyzers` key; no `--build` means no `build` key) - nothing is
padded in to make the shape look complete. `coverageCache` counts calls
to `coverage.load()` across the whole run: `--policy`, the standalone
`coverage/*` evidence check, and `coverage.summarize()` for the
`coverage` field above can all end up asking for the same report in one
run, so the cache (keyed by resolved path + mtime, reset at the start of
every run) turns the 2nd+ ask into a hit instead of a re-parse.

## Determinism

Every field except `timestamp` is a pure function of the repository state,
config, and commands passed — running `postflight verify --proof` twice
against the same commit and base with no other changes produces the same
`evidence`, `findings`, `verdict`, and `changedFiles`, in the same sorted
order. `evidence` is explicitly sorted by `id` for this reason (unsorted
ledger insertion order can vary with analyzer scheduling).

## Reading it later

```bash
postflight explain <evidence-id>          # reads ./postflight-proof.json
postflight explain <evidence-id> --proof-file path/to/proof.json
```

This never re-runs postflight or touches the repository — it's a pure
read of the artifact, so it works in a later CI job, a different machine,
or a PR review days after the run that produced it.

## JSON Schema

A machine-checkable JSON Schema mirroring this table lives at
[`docs/proof-schema.json`](proof-schema.json).

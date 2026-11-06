# Architecture

## Pipeline

```
Agent / Developer
      ↓
Changed Code                (git diff vs --base, including untracked files)
      ↓
postflight
      ↓
Acquisition + Analysis      (src/git.js, src/checks.js, src/analyzers/*)
      ↓
Evidence Ledger             (src/evidence.js, src/verdictRun.js)
      ↓
Policy Evaluation           (src/policy.js, src/verdict.js)
      ↓
VERIFIED / REVIEW_REQUIRED / BLOCK / INCONCLUSIVE
      ↓
Proof Artifact + CI/PR Output   (src/proof.js, src/formats.js)
```

Every stage is deterministic and local: no network calls, no LLM calls, no
telemetry. The same inputs (repo state, commands, config) always produce
the same evidence and the same verdict.

## Module map

| Module | Responsibility |
|---|---|
| `src/cli.js` | Argument parsing and command dispatch (`run`, `verify`, `explain`, `plugins`, `init`) |
| `src/git.js` | Diff/status/untracked-file acquisition |
| `src/checks.js` | Regex/pattern-based findings (secrets, risky shell commands) |
| `src/analyzers/*` | Evidence-schema analyzers: test-integrity, sensitive-paths, config-change, dependency-change, blast-radius, coverage, JS import-graph |
| `src/evidence.js` | The `EvidenceLedger` — the canonical internal model everything else feeds |
| `src/policy.js` | Declarative presets (`default`, `strict`, `advisory`) and per-repo overrides |
| `src/verdict.js` | Deterministic evidence → verdict rules |
| `src/verdictRun.js` | Wires acquisition + analyzers + plugins into one ledger, then a verdict |
| `src/task.js` | Task requirement checking against a run's evidence |
| `src/proof.js` | `postflight-proof.json` serialization |
| `src/plugins.js` | External plugin discovery, validation, and evidence collection |
| `src/explain.js` | Traces a rule/evidence id back to the introducing commit, or reads it from a proof file |
| `src/formats.js` | SARIF and GitHub Actions annotation output |

## Two engines, one CLI

`postflight run` predates the evidence ledger and, without `--policy`,
still uses the original heuristic confidence score (`src/score.js`) for
backward compatibility. `postflight verify` (and `run --policy <preset>`,
`--proof`, `--task`/`--task-file`) always uses the evidence ledger and
verdict engine described above. Nothing about `run`'s default behavior
changes unless one of those flags is passed.

## Design invariants

- **No fabrication.** Evidence always carries a `provenance.method`
  (`observed` | `derived` | `heuristic` | `declared`); a heuristic can
  never be reported as `STRONG` evidence (`src/evidence.js#clampStrength`).
- **UNKNOWN is not silence.** An analyzer that fails to run records an
  `UNKNOWN` evidence entry or a limitation — it never just disappears.
- **Absence of evidence is not evidence of safety.** `INCONCLUSIVE`
  exists specifically so "nothing was checked" is never reported the same
  way as "checked and clean" (`src/verdict.js`).
- **Everything is attributable.** Every verdict reason cites the
  evidence id(s) it rests on; `postflight explain <id>` (from a proof
  file) or `--rule <id>` (from a live diff) traces it back further, to
  the commit that introduced it.

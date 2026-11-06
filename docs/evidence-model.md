# Evidence model

Defined in `src/evidence.js`. This is the canonical internal model —
findings, verdicts, and the proof artifact are all views over it.

## Evidence record

```json
{
  "id": "test/command-result",
  "category": "test",
  "status": "PASS",
  "strength": "STRONG",
  "origin": "INTRODUCED",
  "summary": "Test command passed",
  "detail": null,
  "locations": [],
  "provenance": { "method": "observed", "source": "test command", "command": "npm test", "exitCode": 0 },
  "confounders": [],
  "remediation": null,
  "data": null
}
```

| Field | Values | Meaning |
|---|---|---|
| `status` | `PASS` \| `FAIL` \| `WARN` \| `UNKNOWN` | What was observed, and which way it points |
| `strength` | `WEAK` \| `MEDIUM` \| `STRONG` | How much to trust the observation |
| `origin` | `INTRODUCED` \| `PRE_EXISTING` \| `UNKNOWN` | Did this change cause it, or does it predate the change |
| `category` | `build` \| `test` \| `test-integrity` \| `security` \| `config` \| `dependency` \| `architecture` \| `surface` \| `repo-state` \| `coverage` | What kind of check produced it |
| `provenance.method` | `observed` \| `derived` \| `heuristic` \| `declared` | How it was obtained |

`strength` is clamped by `provenance.method`: a `heuristic` observation
(regex/naming-convention match) can never be reported stronger than
`WEAK`, and a `declared` one (taken from user config) never stronger than
`MEDIUM`. Only `observed` (executed) or `derived` (computed from executed/
authoritative data) evidence can be `STRONG`. This is enforced in code
(`clampStrength`), not by convention — a plugin producing a `heuristic`
finding with `strength: "STRONG"` is silently corrected to `WEAK`.

`remediation` is a free-text hint an evidence producer can optionally set
inline (e.g. `src/gitState.js`'s "Pass --base with a ref that exists
locally, or fetch it first."). It's distinct from the structured
`remediations` array a `RemediationProvider` produces post-hoc against any
evidence — see `docs/remediation-api.md` — which supports diffs and
runnable commands, not just a string, and is collected separately so
"observed" and "suggested" never blur together.

## Limitations

A limitation is postflight stating what it did *not* check (unresolvable
base ref, shallow clone, dirty working tree, `--no-analyzers`, a plugin
that failed to run). Limitations downgrade a verdict under policies where
`unknownDowngrades` is true (the default and `strict` presets) — an
otherwise-clean run with unstated limitations is never silently reported
as fully verified.

## Ledger → finding → policy → verdict

1. Every check (pattern rule, analyzer, build/test command, plugin,
   repo-state inspection) adds evidence and/or limitations to one
   `EvidenceLedger` per run (`src/verdictRun.js#buildLedger`).
2. `src/verdict.js#decide` walks the ledger against the resolved policy
   (`src/policy.js#resolvePolicy`) and produces a verdict plus a list of
   `reason` objects, each citing the evidence id(s) behind it.
3. `src/proof.js#buildProof` serializes the ledger, verdict, and policy
   into `postflight-proof.json`.
4. `postflight explain <evidence-id>` reads that proof file back and
   renders one evidence record plus the verdict reasons that cite it.

No step in this chain invents a confidence percentage. `evidenceScore`
(in `--format json`) is a plain census (counts of PASS/FAIL/WARN/UNKNOWN),
not a probability — see `src/verdict.js`'s comment on `evidenceScore`.

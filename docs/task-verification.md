# Task verification

`postflight verify --task <text>` or `--task-file <path>` checks whether a
stated task was actually accomplished — as far as postflight can tell
*deterministically*, without executing an LLM and without semantically
understanding the code.

## Input

```bash
postflight verify --task "Implement OAuth login"          # description only, no requirements to check
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

## How each requirement is judged

Implemented in `src/task.js#verifyTask`. For each requirement:

1. **Test-backed requirements.** If the requirement's text mentions
   test(s)/regression(s) *and* this run's evidence ledger contains
   executed, passing, `INTRODUCED`-origin test evidence, the requirement
   is `SATISFIED`, citing that evidence id.
2. **Everything else defaults to `INCONCLUSIVE`.** postflight does not
   execute or semantically understand your code, so it cannot confirm an
   arbitrary requirement like "authentication failures are handled" is
   actually true. Claiming `SATISFIED` here would be exactly the
   fabricated-confidence failure mode this project exists to avoid.
3. **A textual match is a downgrade, not an upgrade.** If a majority of
   the requirement's significant words appear in the diff's added lines,
   the requirement stays `INCONCLUSIVE` but its `detail` notes the match
   — useful context for a reviewer, never treated as proof.
4. **`UNSATISFIED` requires a specific negative signal** — it is never
   inferred from an absence of evidence (that stays `INCONCLUSIVE`). The
   one case that currently qualifies: the requirement mentions
   test(s)/regression(s), *and* this run's evidence ledger contains
   executed, `INTRODUCED`-origin test evidence with `status: FAIL` (i.e.
   a test tied to this change actually ran and failed). That's a real,
   attributable negative observation, not a guess, and it cites the
   failing evidence id(s) directly. A requirement that simply has no
   supporting evidence at all is `INCONCLUSIVE`, not `UNSATISFIED` -
   postflight would rather under-claim than accuse a change of failing a
   requirement it never actually checked.

## Why not smarter (semantic) matching

An LLM-based checker could confidently claim "OAuth callback exists ✓"
by reading the code — but that confidence wouldn't be grounded in
anything postflight can audit or reproduce deterministically, which
breaks the project's core invariant (see `docs/architecture.md`'s "no
fabrication"). The tradeoff is explicit: `--task` output is intentionally
conservative rather than impressive. Treat `INCONCLUSIVE` requirements as
"needs a human," not "probably fine."

## Output

Task results appear in `--format json`'s `taskResult` field, in the
`text`/`github` report, and in the `task` field of a `--proof` proof
artifact (see `docs/proof-schema.md`).

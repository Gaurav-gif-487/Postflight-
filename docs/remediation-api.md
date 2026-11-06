# Remediation API

Core postflight works fully with **zero remediation providers installed**
— nothing here is required. A `RemediationProvider` turns evidence
postflight already collected (a FAIL or WARN) into a *suggested* fix.

**postflight never modifies your code.** A provider proposes a diff, a
shell command, or a manual note; a human decides whether to act on it.
There is no "apply" step in this version — that is an explicit, deliberate
absence, not an oversight (see "Roadmap" in README.md). Auto-fix uplift is
the same reason plugins can't submit code changes either: an LLM-authored
static-analysis suggestion sitting in your CI logs is fine; an LLM-authored
change silently applied to your tree is a different risk entirely.

Current API version: `1` (`src/remediation.js#API_VERSION`).

## Shape

```js
module.exports = {
  metadata: {
    name: "npm-lockfile-sync",  // required, unique within your config
    version: "0.1.0",           // required, your own provider's version
    apiVersion: 1,               // optional; validated against postflight's API version if present
  },
  canRemediate(evidenceRecord, ctx) {
    // required. Return false to skip this piece of evidence.
    return evidenceRecord.category === "dependency" && evidenceRecord.status === "WARN";
  },
  remediate(evidenceRecord, ctx) {
    // required. Return one suggestion, an array of suggestions, or
    // null/undefined for "I looked, nothing to suggest".
    return {
      summary: "Run npm install to bring package-lock.json back in sync",
      kind: "command",
      commands: ["npm install"],
    };
  },
};
```

`evidenceRecord` is one entry from the evidence ledger (see
`docs/evidence-model.md`) — the same object shape `postflight verify
--proof`'s `evidence` array contains. `ctx` is the same context object
postflight's own analyzers and plugins receive: `{ base, changedFiles,
cwd, repoRoot, statuses, parsedDiff, coveragePath }`. Only `FAIL`/`WARN`
evidence is ever offered to a provider — `PASS` and `UNKNOWN` have
nothing to remediate.

## Suggestion shape

| field        | required           | notes |
|--------------|--------------------|-------|
| `summary`    | yes                | one-line human-readable description of the fix |
| `kind`       | no (default `"manual"`) | `"diff"`, `"command"`, or `"manual"` |
| `diff`       | yes, if `kind: "diff"`    | a unified-diff-style string |
| `commands`   | yes, if `kind: "command"` | a non-empty array of shell command strings |
| `confidence` | no (default `"suggested"`) | `"suggested"` or `"safe"` — `"safe"` is a claim the provider makes, not something postflight verifies |

## Configuration

```json
{ "remediationProviders": ["./tools/postflight-remediations/npm-lockfile-sync.js", "some-npm-package"] }
```

in `.postflightrc.json` / `postflight.config.json`. Relative paths (`./`
or `/`) resolve against the repo root. Suggestions only run as part of
`postflight verify` (or `run --policy ...`) — remediation targets evidence,
and evidence only exists once the policy engine has run.

## Suggestion rules

- A malformed suggestion (missing `summary`, `kind: "diff"` without a
  `diff` string, `kind: "command"` without a non-empty `commands` array)
  is dropped with a limitation recorded, not a crash.
- A provider that throws in `canRemediate`/`remediate` produces a
  limitation (`remediation-<name>-error`), never crashes the run.
- Evidence is never mutated — a provider's output lives in a separate
  `remediations` array (in `--format json` output and the proof
  artifact), each entry carrying the `evidenceId` it addresses. This keeps
  "observed" (evidence) and "suggested" (remediation) from blurring
  together.
- Multiple providers can each independently suggest a fix for the same
  evidence; all suggestions are kept, not deduplicated to one.

## Validating a provider

```bash
postflight remediation validate ./my-provider.js
postflight remediation            # list + validate everything in config.remediationProviders
```

## Versioning

`metadata.apiVersion`, if present, must match postflight's own
`API_VERSION`. A mismatch fails validation with a clear message rather
than running against an API the provider wasn't written for. Omit it
during development; set it once your provider is stable.

## Relationship to the plugin API

`RemediationProvider` is a deliberately separate interface from
`docs/plugin-api.md`'s plugins, not a generalization of it: plugins
*produce* evidence, providers *consume* it. A provider can suggest fixes
for evidence from anywhere — core analyzers, a plugin, another provider's
own evidence-independent data — without needing to know how that evidence
was produced.

## Reference implementation

`plugins/remediations/npm-lockfile-sync` is a first-party provider shipped
in this repo, built entirely on the API above. It targets exactly the
`dependency/lockfile-not-updated@<file>` evidence
`src/analyzers/dependencyChange.js` already emits (manifest changed, no
matching lockfile did) and suggests the regenerating command — inspecting
the working tree to pick `yarn install` vs `pnpm install` vs `npm install`
for `package.json` (whichever lockfile already exists there), and the
single standard tool for ecosystems that have one (`cargo update`,
`bundle install`, `go mod tidy`). For `requirements.txt`/`pyproject.toml`
it deliberately falls back to a `kind: "manual"` suggestion rather than
guessing a Python lock tool, since more than one is in common use and
picking wrong would be actively misleading. Enable it the same way as any
other provider:

```json
{ "remediationProviders": ["./plugins/remediations/npm-lockfile-sync/index.js"] }
```

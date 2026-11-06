# GitHub integration

## Composite action

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
- uses: <owner>/<repo>@v1
  with:
    base: origin/${{ github.base_ref }}
    build: "npm run build"
    test: "npm test"
    policy: "default"
    proof: "true"
    task: "Implement OAuth login"       # optional
```

`action.yml` inputs mirror the CLI flags of the same name: `base`,
`build`, `test`, `format`, `policy`, `diff-behavior`, `coverage`,
`no-analyzers`, `timeout`, `proof`, `proof-out`, `task`, `task-file`.
Leaving `policy`/`proof`/`task` empty keeps the original confidence-score
behavior unchanged (0/1 exit codes) — nothing here is required.

`postflight init` scaffolds a starter workflow using this action,
detecting the correct `uses:` slug from your `origin` remote.

## Check output: `--format github`

`--format github` (the action's default) emits GitHub Actions workflow
commands (`::warning file=...::...`) so findings show up as inline
annotations on the diff in the PR's "Files changed" tab, followed by the
same text report and verdict a terminal run would show — no extra setup.

## SARIF (code scanning)

```bash
postflight run --format sarif > postflight.sarif
```

```yaml
- run: node bin/postflight.js run --format sarif --base origin/${{ github.base_ref }} > postflight.sarif
- uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: postflight.sarif
```

Findings show up in the repo's Security tab, with a stable `rule.id` per
finding type (`src/formats.js#toSarif`) — the same ids `postflight
explain --rule <id>` accepts.

## PR comment with dedup

A check run and inline annotations don't give reviewers one place to see
the full verdict + evidence summary. Posting it as a PR comment does —
but naively posting a new comment on every push spams the thread. This
workflow finds and edits its own previous comment instead, using a hidden
HTML marker to identify it:

```yaml
name: postflight
on:
  pull_request:

permissions:
  pull-requests: write
  contents: read

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Run postflight
        id: postflight
        run: |
          git fetch --no-tags --depth=1 origin "${{ github.event.pull_request.base.sha }}"
          set +e
          node bin/postflight.js verify \
            --base "${{ github.event.pull_request.base.sha }}" \
            --test "npm test" \
            --proof \
            --format text > postflight-report.txt
          echo "exit_code=$?" >> "$GITHUB_OUTPUT"
          set -e

      - name: Post or update PR comment
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const marker = '<!-- postflight-verdict -->';
            const report = fs.readFileSync('postflight-report.txt', 'utf8');
            const body = `${marker}\n### postflight verdict\n\n\`\`\`\n${report}\n\`\`\`\n`;

            const { data: comments } = await github.rest.issues.listComments({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
            });
            const existing = comments.find((c) => c.body.startsWith(marker));

            if (existing) {
              await github.rest.issues.updateComment({
                owner: context.repo.owner,
                repo: context.repo.repo,
                comment_id: existing.id,
                body,
              });
            } else {
              await github.rest.issues.createComment({
                owner: context.repo.owner,
                repo: context.repo.repo,
                issue_number: context.issue.number,
                body,
              });
            }

      - name: Fail the check on BLOCK/REVIEW_REQUIRED/INCONCLUSIVE
        if: steps.postflight.outputs.exit_code != '0'
        run: exit 1
```

The marker (`<!-- postflight-verdict -->`) is what makes this idempotent:
every run either edits the one comment it owns or creates it once, so a
PR with 20 pushes still has exactly one postflight comment, always
showing the latest verdict. Swap the `--test`/`--base` values and the
report format (`--format github` also works here, though the raw text
report reads better inside a comment's code fence) for your repo.

## Proof artifacts in CI

```yaml
      - name: Upload proof artifact
        uses: actions/upload-artifact@v4
        with:
          name: postflight-proof
          path: postflight-proof.json
```

Keeps the full evidence ledger + verdict attached to the workflow run,
independent of the PR comment, for later audit (`postflight explain
<evidence-id>` reads it directly, on any machine, without re-running
anything).

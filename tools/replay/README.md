# Adversarial replay tools

These scripts check postflight's heuristics against real, unmodified
open-source repositories instead of hand-written examples. Several real
false positives and false negatives in this codebase (see CHANGELOG.md)
were found this way, not by reasoning about the regexes in the abstract.

They are review tools, not automated tests: they print candidate findings
for a human to read and judge, one at a time. A confirmed real bug found
this way should get a proper regression test in `test/` (with a comment
citing the real commit/line that exposed it) and a fix - these scripts
don't assert anything themselves.

## Setup

Clone one or more real repos anywhere outside this repo, e.g.:

```sh
git clone --depth 300 https://github.com/rspec/rspec-core.git ../rspec-core
git clone --depth 300 https://github.com/square/okhttp.git ../okhttp
git clone --depth 300 https://github.com/Seldaek/monolog.git ../monolog
git clone --depth 300 https://github.com/BurntSushi/ripgrep.git ../ripgrep
git clone --depth 1   https://github.com/expressjs/express.git ../express
```

Pick repos that are large, actively maintained, and idiomatic for the
language/ecosystem you're checking - a small or unusual repo won't
surface the same breadth of real-world phrasing.

## fastscan.js - pattern rules (src/checks.js)

Scans every tracked file's *current* content in a target repo against
postflight's pattern rules (auth-bypass, secret-generic, eval-exec, etc.)
and prints every hit. Checking current file content (not one commit's
diff) is a superset of what any historical diff could have added, so a
handful of repos is enough to surface real phrasing without replaying
every commit.

```sh
npm run replay:fastscan -- ../okhttp --rules auth-bypass,secret-generic
npm run replay:fastscan -- ../ripgrep                    # all rules
npm run replay:fastscan -- ../svelte --rules auth-bypass --json
```

Read every hit. Most will be true positives or expected noise (pattern
rules are intentionally WEAK, non-blocking evidence - see evidence.js);
the ones worth fixing are the ones where the matched line has nothing to
do with what the rule claims to detect (e.g. `auth-bypass` firing on
`overflow-checks = false`, a Rust compiler flag, not a disabled auth
check - see CHANGELOG.md for the fixed cases of this kind).

## testmapping-replay.js - test-coverage conventions (src/testMapping.js)

Replays a repo's recent commit history through `untestedFiles()` and
prints every commit where a source-file change gets flagged "untested".

```sh
npm run replay:testmapping -- ../rspec-core --ext rb  --commits 200
npm run replay:testmapping -- ../okhttp     --ext kt  --commits 200
npm run replay:testmapping -- ../monolog    --ext php --commits 200
```

For each flagged commit, check by hand (`git show <sha>` in the target
repo) whether there really is no test for that file, or whether a test
file *was* touched in the same commit but under a name/path
`candidateTestPaths()` doesn't generate yet - that's the bug worth fixing
(see the Ruby lib/->spec/, Java/Kotlin mixed-language-dir, and PHP
src/->tests/ fixes in CHANGELOG.md, all found this way).

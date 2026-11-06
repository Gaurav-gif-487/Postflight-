# Contributing to postflight

Thanks for considering a contribution. postflight is a zero-dependency
Node CLI, so the bar for a change is simple: it should be verified by
running it against a real scratch git repo, not just read and assumed
correct.

## Getting set up

```bash
git clone <this repository>
cd postflight
npm install   # no runtime dependencies; this only pulls dev tooling, if any
npm test
```

Requires Node 18+ (see `package.json`'s `engines` field) and `git` on
`PATH`. The test suite spins up real temporary git repositories under
your OS temp dir for every test that needs one — it doesn't run against
this repository itself.

## Before you open a PR

- **Run the full suite**: `npm test`. Every test file under `test/*.test.js`
  runs with Node's built-in test runner — no separate test framework to
  install.
- **New behavior needs a new test.** Code without a test is
  where shipped bugs have come from. A fix or feature
  without a test that would fail on the old code and pass on the new one
  isn't done yet.
- **Reproduce the bug before fixing it, when there is one.** The
  expected workflow: reproduce against a real scratch repo, confirm the
  failure, fix it, confirm the fix, write a regression test.
- **Keep the zero-runtime-dependency property.** `package.json`'s
  `dependencies` is `{}` on purpose — it's part of what lets `npx
  postflight` work instantly in any CI environment. If a change seems to
  need a new runtime dependency, that's worth raising as a design
  question in the PR description before writing the code.
- **Match the existing module shape.** Analyzers live in
  `src/analyzers/*.js` and export an `analyze(ctx)` function; pattern
  rules live in `src/checks.js`'s `RULES` array; output formats live in
  `src/formats.js`. Look at a sibling file before adding a new one.

## Reporting a bug

Open an issue using the bug report template. The most useful bug reports
include a minimal repro: the exact `postflight` command, and either a
small scratch repo (or the diff/files needed to build one) that
reproduces the problem. "It didn't catch X" or "it flagged Y that
shouldn't be flagged" are both useful — false negatives matter just as
much as false positives for a tool whose entire job is trustworthy
verification.

## Reporting a security issue

Please don't open a public issue for a security vulnerability (e.g. a
way to make postflight itself execute untrusted content, or a check that
can be trivially bypassed in a way that matters for the tool's core
promise). See `SECURITY.md` for how to report privately instead.

## Code of conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). By
participating, you're expected to uphold it.

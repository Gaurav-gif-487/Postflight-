# Security Policy

## Reporting a Vulnerability

Please do **not** open a public GitHub issue for a security
vulnerability.

Instead, use GitHub's private vulnerability reporting for this
repository: go to the **Security** tab → **Report a vulnerability**.
That opens a private advisory visible only to maintainers, so the report
doesn't get triaged in public before a fix is available.

(This repo doesn't have a maintainer email address configured in its
docs, and this file deliberately doesn't invent one. If GitHub's private reporting isn't available for some reason,
open a regular issue asking for a private contact channel rather than
describing the vulnerability itself.)

## What counts as a security issue here

postflight is a static, read-only analysis tool — it reads a git diff
and (optionally) runs build/test commands you explicitly configure. The
things most worth a private report:

- A way for a crafted diff or repository to make postflight itself
  execute unintended code beyond the `--build`/`--test` commands you
  configured (i.e. something other than "you told it to run a shell
  command and it ran the shell command you gave it").
- A way to make a genuinely risky change (a committed secret, an
  `eval`/`rm -rf`/pipe-to-shell pattern, a disabled test hiding a real
  regression) reliably invisible to every check, in a way that
  undermines the tool's core promise rather than being an already-known,
  documented limitation (see README's "What it checks" for what's already known).

## Supported Versions

This project does not yet maintain multiple supported release branches.
Security fixes land on the latest release.

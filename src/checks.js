"use strict";

const { parseUnifiedDiff } = require("./diffParse");
const { STATUS, STRENGTH, ORIGIN, METHOD } = require("./evidence");

// Pattern rules are WEAK evidence by construction: they read added lines and
// nothing else. v2 keeps them (they are cheap and language-agnostic) but
// makes three things true that were not true in v1.1:
//
//   1. every match carries a file AND a line number, so it is citable;
//   2. secret-shaped matches are redacted before they ever reach output;
//   3. matches inside comments, docs, fixtures, and obvious placeholders are
//      suppressed, because a scanner that cries wolf gets switched off.

const RULES = [
  {
    id: "risky-shell-pipe",
    severity: "high",
    category: "security",
    label: "Piping a remote download straight into a shell",
    pattern: /(curl|wget)\s+[^\n]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/,
    codeOnly: true,
  },
  {
    id: "eval-exec",
    severity: "medium",
    category: "security",
    label: "Dynamic code execution (eval/exec)",
    // Both eval and exec exclude member-access/static-call forms
    // (`.eval(`, `->eval(`, `::eval(` and the exec equivalents): the
    // dangerous pattern is the bare, global builtin (JS/Python `eval()`,
    // PHP's `eval` language construct - which is never itself an object
    // method) called directly on unsanitized input, not a same-named
    // method on some other object. `.exec(`/`->exec(` already had a
    // partial exemption (for JS's ubiquitous `regex.exec(str)`), but it
    // only excluded a literal "." immediately before, missing PHP's "->"
    // and static "::" forms. `eval` had no exemption at all: replaying
    // Laravel's real history found `$this->redis->eval(luaScript, ...)` -
    // Redis's own client API method for running a Lua script server-side,
    // identically named "eval" in essentially every Redis client library
    // (PHP predis/phpredis, Python redis-py, Node ioredis, Ruby redis) -
    // flagged as dynamic code execution on unsanitized input, which it
    // is not.
    pattern: /(?<!\.)(?<!->)(?<!::)\beval\s*\(|(?<!\.)(?<!->)(?<!::)\bexec\s*\(/,
    codeOnly: true,
  },
  {
    id: "child-process",
    severity: "low",
    category: "security",
    label: "New shell-out via child_process/subprocess",
    pattern: /\b(child_process|subprocess|os\.system|Runtime\.getRuntime\(\)\.exec)\b/,
    codeOnly: true,
  },
  {
    id: "rm-rf",
    severity: "high",
    category: "security",
    label: "Recursive force-delete",
    pattern: /\brm\s+-[a-z]*r[a-z]*f[a-z]*\b|\brm\s+-[a-z]*f[a-z]*r[a-z]*\b/,
    codeOnly: true,
    // Downgrades to "low" (still reported, just no longer flips the
    // verdict) when the delete target is one of the two overwhelmingly
    // common, purpose-built, essentially risk-free shapes: a quoted shell
    // variable/path ("$staging", "${work}/modules/$m/src") or a `find
    // ... -exec rm -rf {} +` prune (always scoped by the find expression's
    // own -name/-path/-prune conditions before it). Stays "high" for
    // anything else - bare/unquoted variables, literal `/`, `~`, `$HOME`,
    // `.`, `*` - which is exactly the shape of a real accident or a
    // genuinely unscoped delete.
    //
    // Found by replaying redis's real history: a single ordinary
    // build/packaging PR (Dockerfile apt-cache cleanup, release tarball
    // staging-dir cleanup, vendored .git/.github pruning before packaging)
    // produced 12 "high" findings that would flip every one of those
    // completely routine commits to REVIEW_REQUIRED. None were remotely
    // risky; all matched one of the two shapes above.
    severityFor(text) {
      // 1) rm -rf "$var", rm -rf '$var', rm -rf "$var/sub/path" - the quotes
      // matter: an unquoted `rm -rf $VAR` is itself the classic dangerous
      // shell anti-pattern (word-splitting/empty-variable disasters, e.g.
      // $VAR unset expanding to `rm -rf` with no target, or worse), so
      // that must stay "high" - only the quoted, defensive form is safe.
      const QUOTED_TARGET = /rm\s+-[a-z]+\s+(?:"[^"]*"|'[^']*')\s*$/;
      // 2) find ... -prune -exec rm -rf {} + - always scoped by find's own
      // -name/-path/-prune conditions, one of the most common release-
      // packaging idioms there is (strip .git/.github before tarballing).
      const FIND_EXEC_TARGET = /-exec\s+rm\s+-[a-z]+\s+\{\}/;
      // 3) A short allowlist of universally-standard, purpose-built cache
      // directories that package managers themselves recommend clearing
      // in the same layer as the install (Docker's own docs use this
      // exact apt-lists idiom).
      const KNOWN_SAFE_PATH = /rm\s+-[a-z]+\s+(?:"|')?(?:\/var\/lib\/apt\/lists|\/var\/cache\/(?:apk|yum|dnf)|~?\/(?:root|home\/[^/]+)\/\.cache)\S*(?:"|')?\s*$/;
      const isSafe = QUOTED_TARGET.test(text) || FIND_EXEC_TARGET.test(text) || KNOWN_SAFE_PATH.test(text);
      return isSafe ? "low" : "high";
    },
  },
  {
    id: "secret-aws-key",
    severity: "high",
    category: "security",
    label: "Possible AWS access key",
    pattern: /AKIA[0-9A-Z]{16}/,
    secret: true,
  },
  {
    id: "secret-generic",
    severity: "high",
    category: "security",
    label: "Possible hardcoded secret/API key",
    // Quote char is captured (group 2) and required to match on close via
    // a backreference, rather than two independent character classes that
    // both happened to allow the same set - which let a match open with
    // `"` and close with `”` (or any other mismatched pairing) and still
    // fire. Harmless in practice (the value itself was always captured
    // correctly), but sloppy: a regex modeling "a quoted string" should
    // actually enforce that the quotes match.
    pattern: /(api[_-]?key|secret|token|password)\s*[:=]\s*(["'”'])([A-Za-z0-9+/_\-.]{16,})\2/i,
    secret: true,
    valueGroup: 3,
  },
  {
    id: "private-key",
    severity: "high",
    category: "security",
    label: "Embedded private key material",
    pattern: /-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
    secret: true,
  },
  {
    id: "disabled-test",
    severity: "medium",
    category: "test-integrity",
    label: "Test disabled or skipped",
    // Must NOT match @unittest.skipIf(...)/@unittest.skipUnless(...) or
    // @pytest.mark.skipif(...) - those are conditional, platform/feature
    // gating decorators, an extremely common and completely legitimate
    // part of real cross-platform test suites (skip on Windows, skip if a
    // module/syscall isn't available, etc.), not a test hiding a
    // regression. Without the negative lookahead below, "@unittest.skip"
    // matches as a bare substring of "@unittest.skipIf"/"@unittest.skipUnless"
    // too, since the pattern had no boundary after "skip" - confirmed as a
    // real, high-volume false positive by replaying CPython's own history:
    // 29 findings across 250 commits were *every single one* a legitimate
    // conditional skip (`skipUnless(hasattr(...))`, `skipIf(mswindows, ...)`,
    // etc.), none an actual test-hiding disable. The negative lookahead
    // requires "skip" be followed by punctuation/whitespace (an actual
    // unconditional `.skip(`/`@unittest.skip` call/decorator), not more
    // identifier characters.
    pattern: /\b(it|test|describe|context)\.skip\s*\(|\bxit\s*\(|\bxdescribe\s*\(|@pytest\.mark\.skip(?![a-zA-Z])|@unittest\.skip(?![a-zA-Z])|\bt\.Skip\(/,
  },
  {
    id: "auth-bypass",
    severity: "high",
    category: "security",
    label: "Authentication or verification check turned off",
    // Adversarial replay against real repos (okhttp, ripgrep, svelte, this
    // repo's own history) found two concrete regex bugs, both fixed below:
    //
    // 1. No word-boundary before the alternation meant "verify"/"validate"
    //    could match mid-identifier, not just as a token of its own.
    //    okhttp's `-CacheControlCommon.kt` has `mustRevalidate = false` -
    //    "Revalidate" contains the substring "validate" starting right
    //    after "Re", which isn't a token boundary but matched anyway.
    //    Added a `\b` before the group so the keyword has to actually
    //    start a word.
    // 2. The bare "0" branch (`(false|False|0)\b`) matches the leading "0"
    //    of any semver-ish version string with no boundary check beyond
    //    "not immediately followed by another word character" - and "."
    //    isn't a word character, so "0.4.0" satisfies `\b` right after the
    //    first "0". svelte's pnpm-lock.yaml has `type-check: 0.4.0` (a
    //    dependency's version number, not a disabled check) and matched.
    //    Added a negative lookahead so a literal "0" doesn't count if it's
    //    the start of an "0.<digit>" version number.
    //
    // Still-open, deliberately NOT "fixed" false-positive class: "check"/
    // "checks" as an ordinary English word in an unrelated compound
    // identifier (rspec-core's `check_ancestors = false`, ripgrep's
    // Cargo.toml `overflow-checks = false`, svelte's `checkJs: false`).
    // There's no generic regex fix for "is this identifier about auth" vs.
    // "this identifier happens to contain the word check" without an
    // allowlist/denylist that would itself need its own adversarial
    // testing and would risk new false negatives on real bypass flags
    // (e.g. a custom `checkAuth`/`checkPermissions` flag). This class is
    // accepted as expected noise for a WEAK-strength, non-blocking pattern
    // rule (see evidence.js: pattern rules can never reach STRONG and stay
    // below minStrengthToBlock) - the same tradeoff this codebase already
    // makes for rm-rf and eval-exec.
    pattern:
      /\b(verify|validate|check)[_A-Za-z]*\s*[:=]\s*(false|False|0(?!\.\d))\b|rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0|InsecureSkipVerify\s*:\s*true/,
    codeOnly: true,
  },
  {
    id: "broad-exception-swallow",
    severity: "medium",
    category: "quality",
    label: "Error swallowed without handling",
    pattern: /catch\s*\([^)]*\)\s*\{\s*\}|except\s+Exception\s*:\s*pass\b/,
    codeOnly: true,
  },
  {
    id: "env-file",
    severity: "medium",
    category: "security",
    label: "New .env-style file committed",
    // "g" so scanDiff's wholeDiff handling can report every new env-style
    // file in the diff, not just the first (previously a diff adding two
    // new .env files only ever surfaced one finding).
    pattern: /^\+\+\+ b\/(.*\.env(\..*)?)\s*$/gm,
    wholeDiff: true,
    // See ENV_TEMPLATE_SUFFIX / applies below - env-file gets its own
    // fixture/template filtering because it's not a per-line rule (it
    // matches on the file header, not on file content), so the generic
    // per-line fixture-suppression and PLACEHOLDER checks never run for
    // it at all.
    excludeFixture: true,
  },
  {
    id: "todo-added",
    severity: "low",
    category: "quality",
    label: "Unfinished-work marker left in code", // postflight-ignore
    pattern: /\b(TODO|FIXME|XXX|HACK)\b/,
  },
];

const DOC_EXTENSIONS = /\.(md|mdx|txt|rst|adoc)$/i;
// Man pages: troff/nroff source under a `man`/`manN` directory, extension
// is the man section number (optionally with a language/library suffix
// like `.3pm`, `.1ssl`). These are pure prose - `.PP`/`.B`/etc. are troff
// formatting macros, not code - but their extension gives no textual hint
// the way `.md`/`.txt` do, so a syscall reference like "exec(2) cannot
// pass it" (a real line from fzf's man/man1/fzf.1) reads to a regex-based
// scanner exactly like a call to exec(). Confirmed as a real false
// positive against that exact file/commit, not a hypothetical one.
const MAN_PAGE_PATH = /(^|\/)man\d*\/[^/]+\.[1-9][a-zA-Z]*$/;
const FIXTURE_PATH = /(^|\/)(test|tests|spec|__tests__|__fixtures__|fixtures|examples?|testdata|mocks?)(\/|$)/i;
// Committed *template* env files (".env.example", ".env.sample", etc.) are
// the documented, intended way to check environment-variable shape into a
// repo without real values - dotenv's own docs recommend ".env.example",
// and it's the dominant convention across JS/PHP/Ruby/Python boilerplates.
// Found as a real false-positive class via replay: the
// env-file rule previously matched these exactly like a genuine secrets
// leak, with no way to tell them apart, because it runs once over the raw
// diff text (a file-header match, not a per-line content match) and so
// never went through the per-line PLACEHOLDER check that other rules get.
const ENV_TEMPLATE_SUFFIX = /\.(example|sample|template|dist|defaults?)$/i;
const SUPPRESS_MARKER = "postflight-ignore";
const LINE_COMMENT = /^\s*(\/\/|#|--|;|\*|\/\*)/;

// Well-known non-secrets. A scanner that flags "password: example" trains
// people to ignore it, which is strictly worse than not scanning.
const PLACEHOLDER = /(example|placeholder|changeme|change_me|dummy|sample|your[_-]?|xxxx|<[^>]+>|\$\{|\{\{|process\.env|os\.environ|redacted|fake|test[_-]?key|not[_-]?a[_-]?real)/i;

function isDocFile(file) {
  return Boolean(file && (DOC_EXTENSIONS.test(file) || MAN_PAGE_PATH.test(file)));
}

function isFixtureFile(file) {
  return Boolean(file && FIXTURE_PATH.test(file));
}

function isSuppressed(line) {
  return line.includes(SUPPRESS_MARKER);
}

function isCommentLine(text) {
  return LINE_COMMENT.test(text);
}

// Shannon entropy over the candidate value. Real credentials are dense;
// "password = 'aaaaaaaaaaaaaaaaaa'" and slugs are not.
function shannonEntropy(value) {
  if (!value) return 0;
  const freq = new Map();
  for (const ch of value) freq.set(ch, (freq.get(ch) || 0) + 1);
  let bits = 0;
  for (const count of freq.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

const MIN_SECRET_ENTROPY = 3.0;

// Never echo a candidate credential. Findings travel into CI logs, PR
// comments, and SARIF artifacts - all of which outlive the run.
function redact(text, value) {
  if (!value) return text;
  const keep = value.length > 8 ? 4 : 0;
  const mask = `${value.slice(0, keep)}${"*".repeat(Math.max(4, Math.min(16, value.length - keep)))}`;
  return text.split(value).join(mask);
}

function snippetFor(rule, text, match) {
  const trimmed = text.trim().slice(0, 160);
  if (!rule.secret) return trimmed;
  const value = rule.valueGroup ? match[rule.valueGroup] : match[0];
  return redact(trimmed, value);
}

/**
 * Scans a unified diff. Returns findings with file + line, deduplicated per
 * (rule, file, line).
 */
function scanDiff(diffText, options = {}) {
  const findings = [];
  const seen = new Set();
  const includeFixtures = options.includeFixtures === true;

  for (const rule of RULES.filter((r) => r.wholeDiff)) {
    // Iterate every match (rule.pattern carries the "g" flag), not just the
    // first - a diff can legitimately introduce more than one new env-style
    // file, and only reporting the first silently dropped the rest.
    for (const m of (diffText || "").matchAll(rule.pattern)) {
      const file = m[1] || null;
      if (rule.excludeFixture && file) {
        // Same policy other non-secret rules already get from the per-line
        // fixture-path suppression below (isFixtureFile) - a wholeDiff rule
        // matches on the file header rather than a line, so it never passes
        // through that shared path and needs the same check applied here.
        if (isFixtureFile(file)) continue;
        if (ENV_TEMPLATE_SUFFIX.test(file)) continue;
      }
      findings.push({
        rule: rule.id,
        severity: rule.severity,
        category: rule.category,
        label: rule.label,
        file,
        line: null,
        snippet: null,
      });
    }
  }

  for (const fileDiff of parseUnifiedDiff(diffText)) {
    const file = fileDiff.file;
    if (!file || fileDiff.binary) continue;
    const doc = isDocFile(file);
    const fixture = isFixtureFile(file);

    for (const added of fileDiff.added) {
      const text = added.text;
      if (isSuppressed(text)) continue;
      const comment = isCommentLine(text);

      for (const rule of RULES) {
        if (rule.wholeDiff) continue;
        if (rule.codeOnly && doc) continue;
        // Command/security patterns inside a comment are documentation, not
        // behavior. Secret patterns still apply - a key pasted into a comment
        // is a leaked key.
        if (rule.codeOnly && comment) continue;
        // Fixture-path suppression exists so that eval()/rm -rf/etc. inside
        // a test fixture reads as fixture noise, not a real security
        // finding. It must NOT apply to test-integrity rules: a disabled
        // test can only ever appear inside a test/spec path, so suppressing
        // findings there makes the rule permanently dead in practice.
        if (fixture && !includeFixtures && !rule.secret && rule.category !== "test-integrity") continue;

        const match = rule.pattern.exec(text);
        if (!match) continue;

        if (rule.secret) {
          const value = rule.valueGroup ? match[rule.valueGroup] : match[0];
          if (PLACEHOLDER.test(text)) continue;
          if (rule.valueGroup && shannonEntropy(value) < MIN_SECRET_ENTROPY) continue;
        }

        const key = `${rule.id}:${file}:${added.line}`;
        if (seen.has(key)) continue;
        seen.add(key);

        findings.push({
          rule: rule.id,
          severity: rule.severityFor ? rule.severityFor(text, match) : rule.severity,
          category: rule.category,
          label: rule.label,
          file,
          line: added.line,
          hunk: added.hunk,
          snippet: snippetFor(rule, text, match),
        });
      }
    }
  }
  return findings;
}

const SEVERITY_STATUS = { high: STATUS.FAIL, medium: STATUS.WARN, low: STATUS.WARN };

// Pattern findings enter the ledger as WEAK, INTRODUCED evidence: they were
// seen on lines this change added, but a regex is not an observation of
// behavior, and the policy's minStrengthToBlock keeps them out of BLOCK.
function toEvidence(findings, severityOverrides = {}) {
  return findings.map((f) => {
    const severity = severityOverrides[f.rule] || f.severity;
    return {
      id: `pattern/${f.rule}${f.file ? `@${f.file}:${f.line ?? 0}` : ""}`,
      category: f.category === "quality" ? "surface" : f.category,
      status: SEVERITY_STATUS[severity] || STATUS.WARN,
      strength: STRENGTH.WEAK,
      origin: ORIGIN.INTRODUCED,
      summary: `${f.label}${f.file ? ` in ${f.file}${f.line ? `:${f.line}` : ""}` : ""}`,
      detail: f.snippet,
      locations: f.file ? [{ file: f.file, line: f.line || null }] : [],
      provenance: { method: METHOD.HEURISTIC, source: `checks:${f.rule}`, ref: "added lines only" },
      confounders: ["Pattern match on added lines; no execution or semantic analysis was performed."],
      data: { rule: f.rule, severity },
    };
  });
}

module.exports = {
  scanDiff,
  toEvidence,
  RULES,
  isSuppressed,
  isDocFile,
  isFixtureFile,
  isCommentLine,
  shannonEntropy,
  redact,
  SUPPRESS_MARKER,
  MIN_SECRET_ENTROPY,
};

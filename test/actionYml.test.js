"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const actionPath = path.join(__dirname, "..", "action.yml");
const actionSrc = fs.readFileSync(actionPath, "utf8");

// The npm package name "postflight" is not owned by this project - it's an
// unrelated, unmaintained package from 2020 (a DB-to-JS-object mapper) with
// no `bin` field at all. `npx --yes postflight run ...` would therefore
// fail on every single invocation with "could not determine executable to
// run" - this was never exercised because it needs a live Actions run to
// surface. The action must instead invoke its own bundled CLI directly via
// $GITHUB_ACTION_PATH, which the runner sets for every composite action
// step, so it never depends on what (if anything) is published on npm
// under that name.
test("action.yml: doesn't shell out through `npx .. postflight`", () => {
  assert.doesNotMatch(
    actionSrc,
    /npx[^\n]*postflight/,
    "action.yml must not invoke postflight via npx - the npm package name " +
      "'postflight' belongs to an unrelated package with no bin field"
  );
});

test("action.yml: invokes its own bundled bin/postflight.js via $GITHUB_ACTION_PATH", () => {
  assert.match(actionSrc, /\$\{?GITHUB_ACTION_PATH\}?\/bin\/postflight\.js/);
});

test("action.yml: bin/postflight.js it points at actually exists in this repo", () => {
  assert.equal(fs.existsSync(path.join(__dirname, "..", "bin", "postflight.js")), true);
});

// bin/postflight.js must run with zero npm install step, since the
// composite action never runs `npm install` before invoking it.
test("action.yml: the bundled CLI has no runtime dependencies (composite action never runs npm install)", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  assert.deepEqual(pkg.dependencies || {}, {});
});

// Every action.yml input that maps to a CLI flag must actually be a flag
// src/cli.js recognizes - a typo'd or renamed flag here would silently
// no-op (or, since v1.3.0, hard-fail via "unrecognized option(s)") on every
// Actions run, and only a live Actions run would ever surface it.
function runStepBody() {
  const m = actionSrc.match(/- name: Run postflight[\s\S]*?run: \|\n([\s\S]*)$/);
  assert.ok(m, "couldn't locate the 'Run postflight' step body");
  return m[1];
}

test("action.yml: every --flag passed to postflight is one src/cli.js actually parses", () => {
  const flagsInAction = [...runStepBody().matchAll(/--[a-z-]+/g)].map((m) => m[0]);
  const cliSrc = fs.readFileSync(path.join(__dirname, "..", "src", "cli.js"), "utf8");
  const uniqueFlags = [...new Set(flagsInAction)];
  const unrecognized = uniqueFlags.filter((flag) => !cliSrc.includes(`"${flag}"`));
  assert.deepEqual(unrecognized, []);
});

// Sanity-check the generated bash is always syntactically valid regardless
// of which inputs are set, by substituting the same conditional expression
// shapes action.yml uses (inputs.x && '--x "value"' || '') for both the
// "nothing set" and "everything set" cases and running `bash -n` on the
// result - the closest thing to a real Actions run this sandbox can do.
test("action.yml: the composite run step is valid bash for both empty and fully-populated inputs", () => {
  const template = runStepBody();

  for (const populated of [false, true]) {
    const rendered = template.replace(
      /\$\{\{ inputs(?:\[.'([a-z-]+)'.\]|\.([a-z-]+)) && format\('([^']+)', [^)]+\) \|\| '' \}\}|\$\{\{ inputs(?:\[.'([a-z-]+)'.\]|\.([a-z-]+)) == 'true' && '([^']+)' \|\| '' \}\}/g,
      (whole, kFmt1, kFmt2, fmt, kBool1, kBool2, boolFlag) => {
        if (!populated) return "";
        if (fmt) return fmt.replace("{0}", "x");
        return boolFlag;
      }
    );
    const script = `set -e\n${rendered.replace(/\$\{\{ inputs\.format \}\}/, "text").replace(/\$\{\{[^}]*\}\}/g, "x")}`;
    fs.writeFileSync("/tmp/__action_render.sh", script);
    execFileSync("bash", ["-n", "/tmp/__action_render.sh"]);
  }
});

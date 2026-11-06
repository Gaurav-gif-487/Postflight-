# Plugin API

Core postflight ships JS/TS analyzers and works fully with **zero plugins
installed** — nothing here is required. Plugins extend analysis (e.g. a
language postflight doesn't natively cover) without modifying core.

Current API version: `1` (`src/plugins.js#API_VERSION`).

## Shape

```js
module.exports = {
  metadata: {
    name: "rust-clippy",       // required, unique within your config
    version: "0.1.0",          // required, your own plugin's version
    apiVersion: 1,             // optional; validated against postflight's API version if present
  },
  capabilities: {               // optional, informational
    languages: ["rust"],
    categories: ["build", "architecture"],
  },
  detect(ctx) {
    // required. Return false to skip this plugin entirely this run.
    return ctx.changedFiles.some((f) => f.endsWith(".rs"));
  },
  analyze(ctx) {
    // required. Return your own plugin-defined findings (any shape).
    return [];
  },
  evidence(ctx, findings) {
    // required. Turn `findings` into evidence-schema objects (see
    // docs/evidence-model.md). id/category/status/summary are required;
    // strength/origin/provenance.method are optional and will be
    // defaulted (and clamped - see below) if omitted.
    return findings.map((f) => ({
      id: f.id,
      category: "architecture",
      status: "WARN",
      summary: f.summary,
    }));
  },
};
```

`ctx` is the same context object postflight's own analyzers receive:
`{ base, changedFiles, cwd, repoRoot, statuses, parsedDiff, coveragePath }`.

## Configuration

```json
{ "plugins": ["./tools/postflight-plugins/rust-clippy.js", "some-npm-package"] }
```

in `.postflightrc.json` / `postflight.config.json`. Relative paths (`./`
or `/`) resolve against the repo root, so they're portable across
machines and CI. Anything else is `require()`d as a package name.

## Evidence rules

Plugin evidence goes through the same `createEvidence` validation as
every other evidence source:

- IDs are namespaced automatically: `plugin/<name>/<your-id>`.
- `strength` defaults to `WEAK` and `provenance.method` defaults to
  `heuristic` if you don't set them — matching the honesty rule that a
  plugin's output is not presumed to be as trustworthy as an executed
  command until proven otherwise. If you *do* set `provenance.method:
  "observed"` (because your plugin actually ran a compiler/linter), you
  can report `STRONG` strength.
- Malformed evidence (missing `category`/`summary`/etc.) is dropped with
  a limitation recorded, not a crash.
- A plugin that throws in `detect`/`analyze`/`evidence` produces a
  limitation (`plugin-<name>-error`), never crashes the run.

## Validating a plugin

```bash
postflight plugins validate ./my-plugin.js
postflight plugins            # list + validate everything in config.plugins
```

## Versioning

`metadata.apiVersion`, if present, must match postflight's own
`API_VERSION`. A mismatch fails validation with a clear message rather
than running against an API the plugin wasn't written for. Omit it
during development; set it once your plugin is stable.

## First-party language adapters

`plugins/lang-{python,go,rust,java}` are first-party plugins shipped in
this repo, built entirely on the public API above - they get no special
access core analyzers don't. Each detects new *architecture-drift*
findings the same way `src/analyzers/jsImportGraph.js` does for JS/TS:
build an import graph from the diff's base ref, build it again from the
current working tree, and report import cycles that are new in this diff
(not ones that already existed). They're opt-in like any other plugin:

```json
{ "plugins": ["./plugins/lang-python/index.js", "./plugins/lang-go/index.js"] }
```

Each is regex-based import extraction, not a real parser or compiler, so
their evidence is `strength: "WEAK"` / `provenance.method: "heuristic"` -
same honesty rule as any other plugin (see "Evidence rules" above). Known
resolution limits, by language:

- **Python** - absolute imports (`import foo.bar`) fall back to a suffix
  search when there's no exact repo-root match, to cope with a `src/`
  layout; this can occasionally match the wrong package in a repo with
  duplicate module names under different roots.
- **Go** - resolves via the module path declared in `go.mod`; cycles are
  really package-level (Go's own import graph is per-package, not
  per-file), so a cycle is reported against *a* representative file in
  each package, not necessarily the one that changed. No `go.mod` at the
  repo root means no findings.
- **Rust** - assumes a conventional single-crate layout (`src/` at the
  crate root); `use crate::...` paths are resolved by progressively
  dropping trailing segments until a module file matches, since the path
  may end in an item name rather than a module. `super::`/`self::` uses
  and multi-crate workspaces aren't resolved.
- **Java** - fully-qualified `import a.b.C;` resolves exactly (package
  dots map onto directory slashes); wildcard imports (`import a.b.*;`)
  are skipped rather than expanded, to avoid one wildcard fanning out
  into dozens of spurious edges.

They're a template for writing your own adapter for a language postflight
doesn't cover: `plugins/shared/{graphEngine,repoSnapshot,diffCycles,
evidenceFromCycles}.js` factor out the git/graph/evidence plumbing so a
new language only needs to supply `isSourceFile`, `extractImports`, and
`resolveImport`.

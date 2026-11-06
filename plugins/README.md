# First-party plugins

These are ordinary postflight plugins (see `docs/plugin-api.md`) that ship
in this repo but are **not loaded by default** - core stays fully
functional with zero plugins installed. Enable the ones you want in
`.postflightrc.json`:

```json
{
  "plugins": [
    "./plugins/lang-python/index.js",
    "./plugins/lang-go/index.js",
    "./plugins/lang-rust/index.js",
    "./plugins/lang-java/index.js"
  ],
  "remediationProviders": [
    "./plugins/remediations/npm-lockfile-sync/index.js"
  ]
}
```

## Layout

- `lang-python/`, `lang-go/`, `lang-rust/`, `lang-java/` - language
  adapters that extend architecture-drift analysis (new import cycles) to
  languages beyond the JS/TS core analyzer.
- `remediations/npm-lockfile-sync/` - a `RemediationProvider` (see
  `docs/remediation-api.md`) that suggests the right lockfile-regenerating
  command for `dependency/lockfile-not-updated` evidence.
- `shared/` - the plumbing every language adapter above is built on:
  - `graphEngine.js` - generic adjacency-map building, cycle detection,
    and before/after cycle diffing. Language-agnostic; a "node" is
    whatever string a plugin's `resolveImport()` returns.
  - `repoSnapshot.js` - git helpers for reading the working tree and a
    diff's base ref, parameterized by a file filter.
  - `diffCycles.js` - the shared "build the graph now, build it at base,
    report what's new" recipe every adapter's `analyze()` calls into.
  - `evidenceFromCycles.js` - turns cycle findings into evidence-schema
    objects consistently across adapters.

Writing a new language adapter means supplying three things to
`diffCycles`: `isSourceFile(path)`, `extractImports(source)`, and
`resolveImport(file, spec, knownFiles)`. See any `lang-*/index.js` for the
pattern.

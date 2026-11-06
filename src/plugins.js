"use strict";

// A postflight plugin extends analysis without modifying core. Core stays
// fully functional with zero plugins installed - nothing in this file is
// on the hot path unless config.plugins is non-empty.
//
// Plugin shape (see docs/plugin-api.md):
//   module.exports = {
//     metadata: { name, version, apiVersion },
//     capabilities: { languages: [...], categories: [...] },
//     detect(ctx)  -> boolean            // should this plugin run at all?
//     analyze(ctx) -> array | Promise    // raw findings, plugin-defined shape
//     evidence(ctx, findings) -> array   // findings -> evidence-schema objects
//   }
//
// ctx is the same analyzerCtx postflight's own analyzers receive: { base,
// changedFiles, cwd, repoRoot, statuses, parsedDiff, coveragePath }.

const path = require("path");
const { createEvidence, METHOD, STRENGTH } = require("./evidence");

const API_VERSION = 1;
const REQUIRED_FNS = ["detect", "analyze", "evidence"];

function validatePlugin(plugin, sourceLabel) {
  const errors = [];
  if (!plugin || typeof plugin !== "object") {
    return { valid: false, errors: [`${sourceLabel}: module.exports must be an object`] };
  }
  if (!plugin.metadata || !plugin.metadata.name) {
    errors.push(`${sourceLabel}: metadata.name is required`);
  }
  if (!plugin.metadata || !plugin.metadata.version) {
    errors.push(`${sourceLabel}: metadata.version is required`);
  }
  if (plugin.metadata && plugin.metadata.apiVersion !== undefined && plugin.metadata.apiVersion !== API_VERSION) {
    errors.push(
      `${sourceLabel}: metadata.apiVersion ${plugin.metadata.apiVersion} does not match the plugin API this postflight speaks (${API_VERSION})`
    );
  }
  for (const fn of REQUIRED_FNS) {
    if (typeof plugin[fn] !== "function") {
      errors.push(`${sourceLabel}: ${fn}() must be a function`);
    }
  }
  if (plugin.capabilities && typeof plugin.capabilities !== "object") {
    errors.push(`${sourceLabel}: capabilities, if present, must be an object`);
  }
  return { valid: errors.length === 0, errors };
}

// Resolves a plugin entry from config (a require-able path or package
// name) relative to the repo root, so ".postflightrc.json" plugin entries
// are portable across machines/CI without an absolute path.
function loadPlugin(entry, repoRoot) {
  const sourceLabel = entry;
  let resolved = entry;
  if (entry.startsWith(".") || entry.startsWith("/")) {
    resolved = path.resolve(repoRoot, entry);
  }
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const mod = require(resolved);
    const { valid, errors } = validatePlugin(mod, sourceLabel);
    if (!valid) return { ok: false, source: entry, errors };
    return { ok: true, source: entry, plugin: mod };
  } catch (err) {
    return { ok: false, source: entry, errors: [`${sourceLabel}: failed to load (${err.message})`] };
  }
}

function loadPlugins(config, repoRoot) {
  const entries = (config && config.plugins) || [];
  const loaded = [];
  const failed = [];
  for (const entry of entries) {
    const result = loadPlugin(entry, repoRoot);
    if (result.ok) loaded.push(result);
    else failed.push(result);
  }
  return { loaded, failed };
}

// Runs every loaded plugin against ctx and returns evidence-schema objects
// plus limitation entries for plugins that errored or produced malformed
// evidence. A misbehaving plugin degrades to UNKNOWN evidence, never a
// crash - the same discipline postflight's own analyzers follow.
function collectPluginEvidence(loadedPlugins, ctx) {
  const evidence = [];
  const limitations = [];

  for (const { plugin, source } of loadedPlugins) {
    const name = plugin.metadata.name;
    try {
      if (typeof plugin.detect === "function" && !plugin.detect(ctx)) continue;
      const findings = plugin.analyze(ctx) || [];
      const rawEvidence = plugin.evidence(ctx, findings) || [];
      for (const spec of rawEvidence) {
        try {
          evidence.push(
            createEvidence({
              ...spec,
              id: spec.id ? `plugin/${name}/${spec.id}` : `plugin/${name}/${evidence.length + 1}`,
              provenance: {
                method: spec.provenance?.method || METHOD.HEURISTIC,
                source: `plugin:${name}`,
                ...spec.provenance,
              },
              strength: spec.strength || STRENGTH.WEAK,
            })
          );
        } catch (err) {
          limitations.push({
            id: `plugin-${name}-malformed-evidence`,
            summary: `Plugin "${name}" produced evidence postflight could not accept: ${err.message}`,
          });
        }
      }
    } catch (err) {
      limitations.push({
        id: `plugin-${name}-error`,
        summary: `Plugin "${name}" failed to run: ${err.message}`,
      });
    }
  }

  return { evidence, limitations };
}

module.exports = { API_VERSION, validatePlugin, loadPlugin, loadPlugins, collectPluginEvidence };

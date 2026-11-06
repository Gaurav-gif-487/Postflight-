"use strict";

// A RemediationProvider turns evidence postflight already collected into a
// *suggested* fix. It is read-only by contract: postflight never modifies
// code on its own (see README.md's "Auto-fix" roadmap note) - a provider
// proposes a diff, a command, or manual instructions, and a human (or a
// future explicit "apply" step this module does not implement) decides
// whether to act on it. Nothing in this file writes to the working tree.
//
// Provider shape (see docs/remediation-api.md):
//   module.exports = {
//     metadata: { name, version, apiVersion },
//     canRemediate(evidenceRecord, ctx) -> boolean   // should this run at all?
//     remediate(evidenceRecord, ctx) -> Suggestion | Suggestion[] | null
//   }
//
// A Suggestion is a plain object: { summary, kind, diff?, commands?,
// confidence? }. kind is one of KIND.* below and determines which of
// diff/commands is expected. ctx is the same analyzerCtx postflight's own
// analyzers and plugins receive: { base, changedFiles, cwd, repoRoot,
// statuses, parsedDiff, coveragePath }.
//
// This is deliberately a sibling system to src/plugins.js, not a
// generalization of it: plugins produce evidence, providers consume it.
// Folding them into one loader would force every plugin to also implement
// canRemediate/remediate (or vice versa), which is the wrong shape for
// either kind of extension.

const path = require("path");

const API_VERSION = 1;
const REQUIRED_FNS = ["canRemediate", "remediate"];

const KIND = Object.freeze({
  DIFF: "diff", // a unified-diff-style patch the caller could review and apply
  COMMAND: "command", // one or more shell commands that would fix it (e.g. "npm install")
  MANUAL: "manual", // no automatable fix - summary/detail is the whole suggestion
});
const KINDS = Object.values(KIND);

const CONFIDENCE = Object.freeze({
  SUGGESTED: "suggested", // plausible, unverified - the default and the honest floor
  SAFE: "safe", // provider claims this is mechanically safe to apply as-is
});
const CONFIDENCES = Object.values(CONFIDENCE);

function validateProvider(provider, sourceLabel) {
  const errors = [];
  if (!provider || typeof provider !== "object") {
    return { valid: false, errors: [`${sourceLabel}: module.exports must be an object`] };
  }
  if (!provider.metadata || !provider.metadata.name) {
    errors.push(`${sourceLabel}: metadata.name is required`);
  }
  if (!provider.metadata || !provider.metadata.version) {
    errors.push(`${sourceLabel}: metadata.version is required`);
  }
  if (provider.metadata && provider.metadata.apiVersion !== undefined && provider.metadata.apiVersion !== API_VERSION) {
    errors.push(
      `${sourceLabel}: metadata.apiVersion ${provider.metadata.apiVersion} does not match the remediation API this postflight speaks (${API_VERSION})`
    );
  }
  for (const fn of REQUIRED_FNS) {
    if (typeof provider[fn] !== "function") {
      errors.push(`${sourceLabel}: ${fn}() must be a function`);
    }
  }
  return { valid: errors.length === 0, errors };
}

function validateSuggestion(s, sourceLabel) {
  const errors = [];
  if (!s || typeof s !== "object") return [`${sourceLabel}: suggestion must be an object`];
  if (!s.summary) errors.push(`${sourceLabel}: suggestion.summary is required`);
  const kind = s.kind || KIND.MANUAL;
  if (!KINDS.includes(kind)) errors.push(`${sourceLabel}: suggestion.kind ${JSON.stringify(kind)} is not one of ${KINDS.join(", ")}`);
  if (kind === KIND.DIFF && typeof s.diff !== "string") errors.push(`${sourceLabel}: kind "diff" requires a string diff`);
  if (kind === KIND.COMMAND && (!Array.isArray(s.commands) || !s.commands.length)) {
    errors.push(`${sourceLabel}: kind "command" requires a non-empty commands array`);
  }
  if (s.confidence !== undefined && !CONFIDENCES.includes(s.confidence)) {
    errors.push(`${sourceLabel}: suggestion.confidence ${JSON.stringify(s.confidence)} is not one of ${CONFIDENCES.join(", ")}`);
  }
  return errors;
}

// Resolves a provider entry from config the same way loadPlugin resolves a
// plugin entry: require-able path or package name, relative paths resolved
// against repoRoot so ".postflightrc.json" entries are portable.
function loadProvider(entry, repoRoot) {
  const sourceLabel = entry;
  let resolved = entry;
  if (entry.startsWith(".") || entry.startsWith("/")) {
    resolved = path.resolve(repoRoot, entry);
  }
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const mod = require(resolved);
    const { valid, errors } = validateProvider(mod, sourceLabel);
    if (!valid) return { ok: false, source: entry, errors };
    return { ok: true, source: entry, provider: mod };
  } catch (err) {
    return { ok: false, source: entry, errors: [`${sourceLabel}: failed to load (${err.message})`] };
  }
}

function loadProviders(config, repoRoot) {
  const entries = (config && config.remediationProviders) || [];
  const loaded = [];
  const failed = [];
  for (const entry of entries) {
    const result = loadProvider(entry, repoRoot);
    if (result.ok) loaded.push(result);
    else failed.push(result);
  }
  return { loaded, failed };
}

// Evidence worth suggesting a fix for: FAIL and WARN are the only statuses
// that argue against merging or need a look (see src/evidence.js's STATUS
// doc comments) - PASS and UNKNOWN have nothing to remediate.
function isRemediable(evidenceRecord) {
  return evidenceRecord.status === "FAIL" || evidenceRecord.status === "WARN";
}

// Runs every loaded provider against every remediable piece of evidence and
// returns suggestion records plus limitation entries for providers that
// errored or produced malformed suggestions. A misbehaving provider is
// dropped with a limitation, never a crash - the same discipline
// src/plugins.js's collectPluginEvidence follows. Evidence itself is never
// mutated (it's frozen, and doing so would blur "observed" from
// "suggested").
function collectRemediations(loadedProviders, evidenceList, ctx) {
  const remediations = [];
  const limitations = [];
  const candidates = evidenceList.filter(isRemediable);

  for (const { provider, source } of loadedProviders) {
    const name = provider.metadata.name;
    for (const ev of candidates) {
      let result;
      try {
        if (!provider.canRemediate(ev, ctx)) continue;
        result = provider.remediate(ev, ctx);
      } catch (err) {
        limitations.push({
          id: `remediation-${name}-error`,
          summary: `Remediation provider "${name}" failed on evidence "${ev.id}": ${err.message}`,
        });
        continue;
      }
      if (!result) continue;
      const suggestions = Array.isArray(result) ? result : [result];
      for (const s of suggestions) {
        const sourceLabel = `${name} (${ev.id})`;
        const errors = validateSuggestion(s, sourceLabel);
        if (errors.length) {
          limitations.push({
            id: `remediation-${name}-malformed-suggestion`,
            summary: `Remediation provider "${name}" produced a suggestion postflight could not accept: ${errors.join("; ")}`,
          });
          continue;
        }
        remediations.push({
          evidenceId: ev.id,
          provider: name,
          source,
          summary: s.summary,
          kind: s.kind || KIND.MANUAL,
          diff: s.diff ?? null,
          commands: s.commands ?? null,
          confidence: s.confidence || CONFIDENCE.SUGGESTED,
        });
      }
    }
  }

  return { remediations, limitations };
}

module.exports = {
  API_VERSION,
  KIND,
  CONFIDENCE,
  validateProvider,
  validateSuggestion,
  loadProvider,
  loadProviders,
  isRemediable,
  collectRemediations,
};

"use strict";

// The evidence model is the heart of postflight v2.
//
// v1.1 produced "findings" and a single confidence percentage. That was a
// probability-shaped number with no probability behind it. v2 replaces it
// with explicit, auditable evidence: every claim carries what was observed,
// how it was observed, how strong that observation is, and whether the
// change introduced it or merely inherited it.

const STATUS = Object.freeze({
  PASS: "PASS", // observed, and the observation supports merging
  FAIL: "FAIL", // observed, and the observation argues against merging
  WARN: "WARN", // observed, needs a human look but is not dispositive
  UNKNOWN: "UNKNOWN", // could not be observed - absence of evidence
});

const STRENGTH = Object.freeze({
  STRONG: "STRONG", // direct execution / exact parse of authoritative data
  MEDIUM: "MEDIUM", // structural analysis of real files (AST-ish, manifests)
  WEAK: "WEAK", // regex, naming conventions, heuristics
});

const ORIGIN = Object.freeze({
  INTRODUCED: "INTRODUCED", // this change created it
  PRE_EXISTING: "PRE_EXISTING", // already true at base
  UNKNOWN: "UNKNOWN", // could not attribute
});

const METHOD = Object.freeze({
  OBSERVED: "observed", // postflight ran it / parsed authoritative output
  DERIVED: "derived", // computed from observed data
  HEURISTIC: "heuristic", // pattern matching, naming conventions
  DECLARED: "declared", // taken from user config on trust
});

const STATUSES = Object.values(STATUS);
const STRENGTHS = Object.values(STRENGTH);
const ORIGINS = Object.values(ORIGIN);
const METHODS = Object.values(METHOD);

const STRENGTH_RANK = { WEAK: 1, MEDIUM: 2, STRONG: 3 };

function assertOneOf(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw new Error(`evidence: invalid ${field} ${JSON.stringify(value)} (expected one of ${allowed.join(", ")})`);
  }
}

// A heuristic can never be strong evidence. This invariant is what stops
// v1.1's core failure mode - a regex match presented with the same weight
// as a failing test run - from coming back.
function clampStrength(strength, method) {
  if (method === METHOD.HEURISTIC && STRENGTH_RANK[strength] > STRENGTH_RANK.WEAK) return STRENGTH.WEAK;
  if (method === METHOD.DECLARED && STRENGTH_RANK[strength] > STRENGTH_RANK.MEDIUM) return STRENGTH.MEDIUM;
  return strength;
}

/**
 * @param {object} spec
 * @param {string} spec.id            stable, machine-readable evidence id
 * @param {string} spec.category      build | test | test-integrity | security | config |
 *                                    dependency | architecture | surface | repo-state | coverage
 * @param {string} spec.status        STATUS.*
 * @param {string} spec.strength      STRENGTH.*
 * @param {string} spec.summary       one-line human claim
 * @param {object} spec.provenance    { method, source, command?, ref?, exitCode? }
 */
function createEvidence(spec) {
  const {
    id,
    category,
    status,
    strength = STRENGTH.WEAK,
    origin = ORIGIN.UNKNOWN,
    summary,
    detail = null,
    locations = [],
    provenance,
    confounders = [],
    remediation = null,
    data = null,
  } = spec;

  if (!id) throw new Error("evidence: id is required");
  if (!category) throw new Error(`evidence(${id}): category is required`);
  if (!summary) throw new Error(`evidence(${id}): summary is required`);
  if (!provenance || !provenance.method) {
    throw new Error(`evidence(${id}): provenance.method is required - unattributable claims are not evidence`);
  }

  assertOneOf(status, STATUSES, "status");
  assertOneOf(strength, STRENGTHS, "strength");
  assertOneOf(origin, ORIGINS, "origin");
  assertOneOf(provenance.method, METHODS, "provenance.method");

  if (status === STATUS.UNKNOWN && !detail) {
    throw new Error(`evidence(${id}): UNKNOWN status must explain why the observation could not be made`);
  }

  return Object.freeze({
    id,
    category,
    status,
    strength: clampStrength(strength, provenance.method),
    origin,
    summary,
    detail,
    locations: Object.freeze(locations.map((l) => Object.freeze({ ...l }))),
    provenance: Object.freeze({ ...provenance }),
    confounders: Object.freeze([...confounders]),
    remediation,
    data,
  });
}

// A limitation is postflight admitting what it did NOT check. Every run
// reports these; a verdict computed with limitations present can never be an
// unqualified SAFE_TO_MERGE under a strict policy.
function createLimitation({ id, summary, impact = "reduces-confidence", remediation = null }) {
  if (!id || !summary) throw new Error("limitation: id and summary are required");
  return Object.freeze({ id, summary, impact, remediation });
}

class EvidenceLedger {
  constructor() {
    this._evidence = [];
    this._limitations = [];
    this._seen = new Set();
  }

  add(spec) {
    const ev = spec && spec.id && spec.provenance && Object.isFrozen(spec) ? spec : createEvidence(spec);
    // Ids must be unique per run so a verdict reason can cite exactly one
    // observation. Repeated ids get a deterministic suffix.
    let id = ev.id;
    if (this._seen.has(id)) {
      let n = 2;
      while (this._seen.has(`${ev.id}#${n}`)) n++;
      id = `${ev.id}#${n}`;
    }
    this._seen.add(id);
    const stored = id === ev.id ? ev : Object.freeze({ ...ev, id });
    this._evidence.push(stored);
    return stored;
  }

  addLimitation(spec) {
    const lim = createLimitation(spec);
    if (!this._limitations.some((l) => l.id === lim.id)) this._limitations.push(lim);
    return lim;
  }

  get all() {
    return [...this._evidence];
  }

  get limitations() {
    return [...this._limitations];
  }

  byStatus(status) {
    return this._evidence.filter((e) => e.status === status);
  }

  byCategory(category) {
    return this._evidence.filter((e) => e.category === category);
  }

  find(id) {
    return this._evidence.find((e) => e.id === id) || null;
  }

  // Blocking-relevant evidence: a failure this change actually introduced.
  introducedFailures() {
    return this._evidence.filter((e) => e.status === STATUS.FAIL && e.origin !== ORIGIN.PRE_EXISTING);
  }

  counts() {
    const out = { PASS: 0, FAIL: 0, WARN: 0, UNKNOWN: 0 };
    for (const e of this._evidence) out[e.status] += 1;
    return out;
  }

  toJSON() {
    return {
      evidence: this.all,
      limitations: this.limitations,
      counts: this.counts(),
    };
  }
}

module.exports = {
  STATUS,
  STRENGTH,
  ORIGIN,
  METHOD,
  STRENGTH_RANK,
  createEvidence,
  createLimitation,
  EvidenceLedger,
};

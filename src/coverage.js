"use strict";

const fs = require("fs");
const path = require("path");
const { changedLinesByFile } = require("./diffParse");

// Real coverage data, when the repo produces it, is the only non-heuristic
// answer to "was the changed code actually executed?". v1.1 guessed from file
// names; v2 parses whatever the repo already emits, and clearly reports
// UNKNOWN when nothing is available rather than inventing a number.

const CANDIDATES = [
  "coverage/lcov.info",
  "lcov.info",
  "coverage/coverage-final.json",
  "coverage/cobertura-coverage.xml",
  "coverage/clover.xml",
  "target/site/jacoco/jacoco.xml",
  "build/reports/jacoco/test/jacocoTestReport.xml",
];

function discover(repoRoot) {
  for (const rel of CANDIDATES) {
    const p = path.join(repoRoot, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function detectFormat(file, text) {
  if (/^\s*</.test(text)) {
    if (/<coverage[^>]*\bline-rate=/.test(text)) return "cobertura";
    if (/<report[^>]*>|<\/report>/.test(text) && /counter/i.test(text)) return "jacoco";
    if (/<coverage[^>]*generated=/.test(text)) return "clover";
    return "xml-unknown";
  }
  if (/^\s*\{/.test(text)) return "istanbul-json";
  if (/^SF:/m.test(text)) return "lcov";
  return path.basename(file).endsWith(".info") ? "lcov" : "unknown";
}

// --- parsers ---------------------------------------------------------------
// Each parser returns { files: { [relPath]: Map(line -> hits) } }.

function parseLcov(text) {
  const files = {};
  let current = null;
  for (const raw of text.split("\n")) {
    const lineText = raw.trim();
    if (lineText.startsWith("SF:")) {
      current = lineText.slice(3).trim();
      files[current] = files[current] || new Map();
    } else if (lineText.startsWith("DA:") && current) {
      const [lineNo, hits] = lineText.slice(3).split(",");
      const n = parseInt(lineNo, 10);
      const h = parseInt(hits, 10);
      if (Number.isFinite(n)) files[current].set(n, (files[current].get(n) || 0) + (Number.isFinite(h) ? h : 0));
    } else if (lineText === "end_of_record") {
      current = null;
    }
  }
  return { files };
}

function parseIstanbulJson(text) {
  const files = {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { files, error: "coverage JSON is not parseable" };
  }
  for (const [file, entry] of Object.entries(parsed)) {
    if (!entry || typeof entry !== "object") continue;
    const map = new Map();
    const statementMap = entry.statementMap || {};
    const counts = entry.s || {};
    for (const [id, loc] of Object.entries(statementMap)) {
      const line = loc && loc.start && loc.start.line;
      if (!Number.isFinite(line)) continue;
      map.set(line, (map.get(line) || 0) + (counts[id] || 0));
    }
    files[file] = map;
  }
  return { files };
}

// Deliberately a tolerant tag scanner rather than a real XML parser: adding a
// parser dependency to a zero-dependency tool is a worse trade than accepting
// slightly loose matching on two well-known report shapes.
function parseCobertura(text) {
  const files = {};
  const classRe = /<class\b[^>]*filename="([^"]+)"[^>]*>([\s\S]*?)<\/class>/g;
  let m;
  while ((m = classRe.exec(text))) {
    const file = m[1];
    const body = m[2];
    const map = files[file] || new Map();
    const lineRe = /<line\b[^>]*number="(\d+)"[^>]*hits="(\d+)"/g;
    let lm;
    while ((lm = lineRe.exec(body))) map.set(parseInt(lm[1], 10), parseInt(lm[2], 10));
    files[file] = map;
  }
  return { files };
}

function parseJacoco(text) {
  const files = {};
  const sourceRe = /<sourcefile\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/sourcefile>/g;
  const packageRe = /<package\b[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/package>/g;
  let pm;
  while ((pm = packageRe.exec(text))) {
    const pkg = pm[1];
    let sm;
    sourceRe.lastIndex = 0;
    while ((sm = sourceRe.exec(pm[2]))) {
      const file = pkg ? `${pkg}/${sm[1]}` : sm[1];
      const map = new Map();
      const lineRe = /<line\b[^>]*nr="(\d+)"[^>]*ci="(\d+)"/g;
      let lm;
      while ((lm = lineRe.exec(sm[2]))) map.set(parseInt(lm[1], 10), parseInt(lm[2], 10));
      files[file] = map;
    }
  }
  return { files };
}

function parse(file, text) {
  const format = detectFormat(file, text);
  switch (format) {
    case "lcov":
      return { format, ...parseLcov(text) };
    case "istanbul-json":
      return { format, ...parseIstanbulJson(text) };
    case "cobertura":
    case "clover":
      return { format, ...parseCobertura(text) };
    case "jacoco":
      return { format, ...parseJacoco(text) };
    default:
      return { format, files: {}, error: `unrecognized coverage format in ${path.basename(file)}` };
  }
}

// In-process cache for load() results, keyed by resolved absolute path and
// invalidated by mtime. A single `postflight verify --proof` run can end up
// calling load() twice for the exact same report - once from
// analyzers/coverage.js's WARN-finding check, once from summarize() for the
// proof artifact - and a large lcov/jacoco report is real, avoidable I/O and
// parsing work to redo. Scoped to the process (never persisted to disk), so
// it's invisible to any caller except through timing and the stats below.
const _cache = new Map(); // resolvedPath -> { mtimeMs, result }
let _stats = { hits: 0, misses: 0 };

function resetCache() {
  _cache.clear();
  _stats = { hits: 0, misses: 0 };
}

function cacheStats() {
  return { ..._stats };
}

function load(repoRoot, explicitPath) {
  const file = explicitPath ? path.resolve(repoRoot, explicitPath) : discover(repoRoot);
  if (!file) return { available: false, reason: "no coverage report found" };
  if (!fs.existsSync(file)) return { available: false, reason: `coverage report not found at ${explicitPath}` };
  let mtimeMs;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch (err) {
    return { available: false, reason: `coverage report unreadable: ${err.message}` };
  }
  const cached = _cache.get(file);
  if (cached && cached.mtimeMs === mtimeMs) {
    _stats.hits += 1;
    return cached.result;
  }
  _stats.misses += 1;
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    const result = { available: false, reason: `coverage report unreadable: ${err.message}` };
    return result; // not cached - a transient read failure shouldn't stick
  }
  const parsed = parse(file, text);
  const result = parsed.error
    ? { available: false, reason: parsed.error, format: parsed.format, file }
    : { available: true, file, format: parsed.format, files: parsed.files, mtimeMs };
  _cache.set(file, { mtimeMs, result });
  return result;
}

// Coverage reports use absolute or build-relative paths; changed files are
// repo-relative. Match on the longest common suffix so both line up without
// guessing a project layout.
function matchFile(coverageFiles, repoRelPath) {
  if (coverageFiles[repoRelPath]) return repoRelPath;
  const normalized = repoRelPath.replace(/\\/g, "/");
  let best = null;
  for (const key of Object.keys(coverageFiles)) {
    const k = key.replace(/\\/g, "/");
    if (k === normalized || k.endsWith(`/${normalized}`) || normalized.endsWith(`/${k}`)) {
      if (!best || k.length > best.length) best = key;
    }
  }
  return best;
}

// Coverage of the lines this change actually added - the only coverage number
// that speaks to the change rather than to the repo's history.
function changedLineCoverage(coverage, changedLinesByFile) {
  const perFile = {};
  let covered = 0;
  let total = 0;
  for (const [file, lines] of Object.entries(changedLinesByFile)) {
    const key = matchFile(coverage.files, file);
    if (!key) {
      perFile[file] = { measured: false, reason: "file absent from coverage report" };
      continue;
    }
    const map = coverage.files[key];
    let c = 0;
    let t = 0;
    for (const line of lines) {
      if (!map.has(line)) continue; // non-executable line (blank, comment, brace)
      t += 1;
      if (map.get(line) > 0) c += 1;
    }
    perFile[file] = { measured: true, covered: c, executable: t, ratio: t ? c / t : null };
    covered += c;
    total += t;
  }
  return { perFile, covered, executable: total, ratio: total ? covered / total : null };
}

// One-shot summary for the proof artifact (src/proof.js's `coverage`
// field). Distinct from analyzers/coverage.js, which decides when a
// coverage observation is worth an evidence *finding* (WARN, only when
// something's stale or uncovered) - this just reports the number
// postflight actually observed, present or not, for the proof to record
// verbatim. Never invents a ratio: an unavailable report reports why.
function summarize(repoRoot, explicitPath, parsedDiff) {
  const report = load(repoRoot, explicitPath);
  if (!report.available) {
    return { available: false, reason: report.reason };
  }
  const linesByFile = changedLinesByFile(parsedDiff || []);
  const result = changedLineCoverage(report, linesByFile);
  return {
    available: true,
    format: report.format,
    file: report.file,
    generatedAt: new Date(report.mtimeMs).toISOString(),
    changedLines: {
      covered: result.covered,
      executable: result.executable,
      ratio: result.ratio,
    },
    files: result.perFile,
  };
}

module.exports = {
  discover,
  detectFormat,
  parse,
  parseLcov,
  parseIstanbulJson,
  parseCobertura,
  parseJacoco,
  load,
  resetCache,
  cacheStats,
  matchFile,
  changedLineCoverage,
  summarize,
  CANDIDATES,
};

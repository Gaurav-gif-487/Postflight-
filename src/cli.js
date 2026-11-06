"use strict";
const fs = require("fs");
const path = require("path");
const git = require("./git");
const { scanDiff } = require("./checks");
const { runCommand } = require("./run");
const { score } = require("./score");
const { render, renderVerdict, renderRemediations } = require("./report");
const { loadConfig, isIgnored } = require("./config");
const { untestedFiles: computeUntestedFiles, partitionUntested } = require("./testMapping");
const { runAnalyzers } = require("./analyzers");
const { parseUnifiedDiff } = require("./diffParse");
const { toSarif, toGithubAnnotations } = require("./formats");
const { resolveColor } = require("./color");
const { buildUntrackedDiff } = require("./untracked");
const { diffBehavior } = require("./testDiff");
const explainMod = require("./explain");
const { runVerdict } = require("./verdictRun");
const { PRESET_NAMES } = require("./policy");
const { isTestFile } = require("./analyzers/testIntegrity");
const { buildProof } = require("./proof");
const coverageLib = require("./coverage");
const { PerfTracker } = require("./perf");
const { verifyTask } = require("./task");
const plugins = require("./plugins");
const remediation = require("./remediation");
const pkg = require("../package.json");

const HELP = `postflight v${pkg.version} - the CI layer for AI coding agents

Usage:
  postflight [options]                       (same as "postflight verify")
  postflight run [options]
  postflight verify [options]                run + the evidence/verdict engine
  postflight explain --rule <id> [--file <path>] [--base <ref>]
  postflight explain <evidence-id>           trace one evidence id from a proof file
  postflight plugins [list|validate <path>]
  postflight remediation [list|validate <path>]
  postflight init

Commands:
  run       Diff, analyze, and score the current change
  verify    Same as "run", but always uses the evidence/verdict engine
            (default policy unless --policy overrides it) and accepts --task
  explain   Trace a finding, or an evidence id from a proof file, back to
            the commit/reasoning that produced it
  plugins   List or validate configured plugins (see docs/plugin-api.md)
  remediation
            List or validate configured RemediationProviders (see
            docs/remediation-api.md). Suggestions run automatically as
            part of "verify" when config.remediationProviders is set -
            postflight only ever suggests a fix, never applies one.
  init      Write a starter GitHub Actions workflow

Task verification (with "verify"):
  --task <text>        Free-text description of what the change was meant
                        to do. Recorded in the proof artifact.
  --task-file <path>   JSON file: { "task": "...", "requirements": ["..."] }.
                        Each requirement is checked against this run's
                        evidence and reported as SATISFIED, UNSATISFIED, or
                        INCONCLUSIVE. Requirements are never marked
                        satisfied from filename or text matching alone -
                        see docs/task-verification.md.

Proof artifact:
  --proof               Emit postflight-proof.json in the current directory
  --proof-out <file>     Emit the proof artifact to a specific path (implies
                        --proof)
  --proof-file <file>   (explain only) proof file to read evidence ids from,
                        default ./postflight-proof.json

Options for "run":
  --base <ref>       Git ref to diff against (default: HEAD, or the empty
                      tree if this is the repo's first commit)
  --build <cmd>       Command to run as the build check
  --test <cmd>        Command to run as the test check
  --coverage <path>   Explicit coverage report path (lcov, istanbul JSON,
                       cobertura, clover, or jacoco XML). If omitted, a
                       report at a conventional path is auto-discovered;
                       if neither is found, coverage evidence is silently
                       skipped.
  --timeout <seconds> Kill --build/--test (and each --diff-behavior run)
                       if it hasn't finished after this many seconds
                       (default: 600). 0 disables the limit.
  --diff-behavior     Run --test once against --base and once against the
                       change, and flag individual tests that newly fail
                       (requires --test)
  --policy <preset>   Opt into the evidence/verdict engine instead of the
                       default confidence score (presets: ${PRESET_NAMES.join(", ")}).
                       Adds a BLOCK/REVIEW_REQUIRED/INCONCLUSIVE/SAFE_TO_MERGE
                       verdict backed by an auditable evidence ledger, and
                       switches exit codes to 0/1/3/4 (see below). Omit this
                       flag and behavior is unchanged from before it existed.
  --format <fmt>      text | json | sarif | github  (default: text)
  --no-analyzers      Skip architecture-drift analysis (faster)
  --no-untested       Skip untested-path heuristic
  --no-color          Disable ANSI colors
  --cwd <dir>         Repo directory (default: current directory)

  -h, --help          Show this help
  -v, --version       Show version

Exit code is 0 when the verdict is SAFE_TO_MERGE, 1 for REVIEW_REQUIRED,
2 for a usage/environment error - so "postflight run" drops straight into
CI or a post-task hook after any agent (Claude Code, Codex, Cursor, ...)
finishes its turn.

With --policy <preset>, the exit code instead comes from the evidence-based
verdict: 0 SAFE_TO_MERGE, 1 REVIEW_REQUIRED, 3 BLOCK, 4 INCONCLUSIVE (2 is
still reserved for usage/environment errors, e.g. an unknown preset name).
`;

function parseArgs(argv) {
  const args = { _: [], unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base") args.base = argv[++i];
    else if (a === "--build") args.build = argv[++i];
    else if (a === "--test") args.test = argv[++i];
    else if (a === "--coverage") args.coverage = argv[++i];
    else if (a === "--timeout") args.timeout = argv[++i];
    else if (a === "--cwd") args.cwd = argv[++i];
    else if (a === "--format") args.format = argv[++i];
    else if (a === "--rule") args.rule = argv[++i];
    else if (a === "--file") args.file = argv[++i];
    else if (a === "--json") args.format = "json"; // back-compat with v0.1
    else if (a === "--diff-behavior") args.diffBehavior = true;
    else if (a === "--policy") args.policy = argv[++i];
    else if (a === "--task") args.task = argv[++i];
    else if (a === "--task-file") args.taskFile = argv[++i];
    else if (a === "--proof") args.proof = true;
    else if (a === "--proof-out") {
      args.proof = true;
      args.proofOut = argv[++i];
    }
    else if (a === "--proof-file") args.proofFile = argv[++i];
    else if (a === "--no-analyzers") args.noAnalyzers = true;
    else if (a === "--no-untested") args.noUntested = true;
    else if (a === "--no-color") args.noColor = true;
    else if (a === "-h" || a === "--help") args.help = true;
    else if (a === "-v" || a === "--version") args.version = true;
    // Anything else starting with "-" is an unrecognized flag: a typo'd or
    // stale/future flag (e.g. --coverage) should fail loudly rather than
    // silently no-op into a "successful" run. Positional
    // arguments (the command name, explain's bare rule id, etc.) don't
    // start with "-" and still fall through to `_` as before.
    else if (a.startsWith("-")) args.unknown.push(a);
    else args._.push(a);
  }
  return args;
}

function resolveRepoContext(args) {
  const cwd = path.resolve(args.cwd || process.cwd());
  if (!git.isGitRepo(cwd)) {
    console.error("postflight: not a git repository:", cwd);
    process.exit(2);
  }
  const repoRoot = git.repoRoot(cwd);
  const config = loadConfig(repoRoot);
  return { cwd, repoRoot, config };
}

function resolveTimeoutMs(args) {
  if (args.timeout === undefined) return undefined; // let run.js apply its own default
  const seconds = Number(args.timeout);
  if (!Number.isFinite(seconds) || seconds < 0) {
    console.error(`postflight run: --timeout expects a non-negative number of seconds, got "${args.timeout}"`);
    process.exit(2);
  }
  return seconds * 1000;
}

function renderTaskResult(taskResult) {
  const lines = [];
  lines.push("");
  lines.push(`Task: ${taskResult.task || "(no description given)"}`);
  if (!taskResult.requirements.length) {
    lines.push("  no requirements specified (pass --task-file with a requirements[] array)");
    return lines.join("\n");
  }
  for (const r of taskResult.requirements) {
    const mark = r.status === "SATISFIED" ? "✓" : r.status === "UNSATISFIED" ? "✗" : "?";
    lines.push(`  ${mark} [${r.status}] ${r.requirement}`);
    lines.push(`      ${r.detail}`);
  }
  lines.push(
    `  ${taskResult.counts.SATISFIED} satisfied, ${taskResult.counts.UNSATISFIED} unsatisfied, ${taskResult.counts.INCONCLUSIVE} inconclusive`
  );
  return lines.join("\n");
}

function runCmd(args) {
  if (args.diffBehavior && !args.test) {
    console.error("postflight run: --diff-behavior requires --test <cmd>");
    process.exit(2);
  }
  const timeoutMs = resolveTimeoutMs(args);
  const { cwd, repoRoot, config } = resolveRepoContext(args);
  const base = git.resolveBase(args.base, cwd);
  const perf = new PerfTracker();
  // Scoped to this run: a concurrent postflight process's cache hits should
  // never be attributed to this run's telemetry.
  coverageLib.resetCache();

  const trackedStats = perf.time("diff", () => git.diffStat(base, cwd));
  // Untracked files (an agent's brand-new files that haven't been `git
  // add`-ed) are invisible to `git diff` by default - and are exactly the
  // files most worth reviewing, so merge them in as if they were part of
  // the diff.
  const untrackedPaths = git.untrackedFiles(cwd).filter((f) => !isIgnored(f, config));
  const untrackedDiff = buildUntrackedDiff(untrackedPaths, repoRoot);
  const stats = trackedStats.concat(untrackedDiff.stats);

  // Per-file add/modify/delete/rename status, extended to cover untracked
  // files too (git.diffStatus alone only sees tracked changes) - analyzers
  // that need to distinguish "added" from "modified" (test-integrity,
  // sensitive-paths, config-change) share this rather than each
  // recomputing it.
  const statuses = git.diffStatus(base, cwd);
  for (const f of untrackedPaths) statuses[f] = { status: "added" };

  const diffSummary = stats.reduce(
    (acc, s) => {
      acc.files += 1;
      acc.insertions += s.insertions || 0;
      acc.deletions += s.deletions || 0;
      return acc;
    },
    { files: 0, insertions: 0, deletions: 0 }
  );

  const trackedDiffText = perf.time("diff", () => git.diffAll(base, cwd));
  const diffText = untrackedDiff.diffText ? `${trackedDiffText}\n${untrackedDiff.diffText}` : trackedDiffText;
  const patternFindings = perf.time("patternScan", () => scanDiff(diffText)).filter((f) => !isIgnored(f.file, config));
  let findings = patternFindings;

  // Shared with the --policy verdict engine (src/verdictRun.js), which
  // re-invokes the evidence-schema analyzers directly to get their raw
  // PASS/WARN/FAIL/UNKNOWN evidence rather than the v1-finding-shaped,
  // lossily-filtered view runAnalyzers() below produces - so this ctx object
  // must stay in sync with what's passed to runAnalyzers.
  const analyzerCtx = {
    base,
    changedFiles: stats.map((s) => s.file),
    cwd,
    repoRoot,
    statuses,
    parsedDiff: null,
    coveragePath: args.coverage,
  };
  let archFindings = [];

  if (!args.noAnalyzers) {
    // configChange.js wants line-level added-line data (parsedDiff) to spot
    // risky CI/container/lint lines, not just which files changed - reuse
    // the same unified-diff parser checks.js already relies on, over the
    // same base-vs-working-tree diffText computed above.
    analyzerCtx.parsedDiff = parseUnifiedDiff(diffText);
    archFindings = perf.time("analyzers", () => runAnalyzers(analyzerCtx)).filter((f) => !isIgnored(f.file, config));
    findings = findings.concat(archFindings);
  }

  // js-import-graph is the one analyzer that never adopted the evidence
  // schema (see analyzers/index.js), so it's the only one whose v1 findings
  // the --policy ledger needs via checks.toEvidence's generic fallback - the
  // other five (and blast-radius/coverage) are re-collected raw from
  // analyzerCtx below so they aren't double-counted here.
  const jsImportGraphFindings = archFindings.filter((f) => f.rule === "architecture-cycle");

  let untested = [];
  let looselyUntested = [];
  if (!args.noUntested) {
    const changedFiles = stats.map((s) => s.file);
    perf.time("untested", () => {
      const rawUntested = computeUntestedFiles(changedFiles, config.testMapping, config.testDirs).filter(
        (f) => !isIgnored(f, config)
      );
      // Split into "no test file touched at all" (confident) vs. "some test
      // file touched, just not one matching this file's naming convention"
      // (weaker - see testMapping.js's partitionUntested).
      ({ untested, noConventionMatch: looselyUntested } = partitionUntested(rawUntested, changedFiles));
    });
  }

  const buildResult = args.build ? runCommand(args.build, cwd, { timeoutMs }) : null;
  perf.record("build", buildResult && buildResult.durationMs);

  let testResult = null;
  let behaviorDiff = null;
  // Kept separate from `findings` (which may or may not be a fresh array
  // depending on --no-analyzers - see the patternFindings/archFindings
  // split above) so the --policy ledger always sees these regardless of
  // that flag, instead of only when analyzers happen to run.
  const behaviorFindings = [];
  if (args.diffBehavior) {
    behaviorDiff = diffBehavior({ testCommand: args.test, base, cwd, repoRoot, timeoutMs });
    testResult = behaviorDiff.testResult;
    perf.record("test", testResult && testResult.durationMs);
    if (!behaviorDiff.skipped) {
      for (const name of behaviorDiff.regressions) {
        behaviorFindings.push({
          rule: "behavior-regression",
          severity: "high",
          category: "test",
          label: "Test passed on base, now fails",
          file: null,
          snippet: name,
        });
      }
      for (const name of behaviorDiff.removed) {
        behaviorFindings.push({
          rule: "test-removed",
          severity: "low",
          category: "test",
          label: "Test present on base no longer found (heuristic — may just be a rename)",
          file: null,
          snippet: name,
        });
      }
    }
    findings = findings.concat(behaviorFindings);
  } else if (args.test) {
    testResult = runCommand(args.test, cwd, { timeoutMs });
    perf.record("test", testResult && testResult.durationMs);
  }

  const scoreResult = score({
    findings,
    buildResult,
    testResult,
    untestedFiles: untested,
    looselyUntestedFiles: looselyUntested,
    severityOverrides: config.severityOverrides,
  });

  // A proof artifact is a serialization of the evidence ledger + verdict,
  // so requesting one (or running "verify") implies the policy engine even
  // if the caller didn't pass --policy explicitly. Never silently changes
  // exit codes for plain "postflight run" - only when --proof/--task/
  // verify are involved does this kick in.
  if ((args.proof || args.task || args.taskFile || args.forcePolicy) && !args.policy) {
    args.policy = "default";
  }

  const changedFiles = stats.map((s) => s.file);
  const pluginContext = { loaded: [], failed: [] };
  let pluginEvidence = [];
  if (config.plugins && config.plugins.length) {
    const { loaded, failed } = plugins.loadPlugins(config, repoRoot);
    pluginContext.loaded = loaded;
    pluginContext.failed = failed;
    const collected = plugins.collectPluginEvidence(loaded, analyzerCtx);
    pluginEvidence = collected.evidence;
  }

  let policyVerdict = null;
  if (args.policy) {
    if (!PRESET_NAMES.includes(args.policy)) {
      console.error(`postflight run: unknown policy "${args.policy}" (expected one of ${PRESET_NAMES.join(", ")})`);
      process.exit(2);
    }
    const testFilesChanged = changedFiles.filter(isTestFile).length;
    const codeFilesChanged = changedFiles.length - testFilesChanged;
    policyVerdict = perf.time("policy", () =>
      runVerdict({
        preset: args.policy,
        configPolicy: config.policy,
        base,
        cwd,
        analyzerCtx: args.noAnalyzers ? null : analyzerCtx,
        patternFindings,
        archFindings: jsImportGraphFindings.concat(behaviorFindings),
        buildResult,
        testResult,
        behaviorDiff,
        severityOverrides: config.severityOverrides,
        changeSurface: { codeFilesChanged, testFilesChanged },
        pluginEvidence,
      })
    );
    for (const f of pluginContext.failed) {
      console.error(`postflight: plugin "${f.source}" not loaded: ${f.errors.join("; ")}`);
    }
  }

  // Remediation suggestions are derived from evidence, so they only make
  // sense once the evidence ledger exists (i.e. --policy ran). Like
  // plugins, this is entirely opt-in - zero remediationProviders configured
  // means this block never runs.
  let remediationResult = { remediations: [], limitations: [] };
  if (policyVerdict && config.remediationProviders && config.remediationProviders.length) {
    const { loaded, failed } = remediation.loadProviders(config, repoRoot);
    for (const f of failed) {
      console.error(`postflight: remediation provider "${f.source}" not loaded: ${f.errors.join("; ")}`);
    }
    remediationResult = perf.time("remediation", () =>
      remediation.collectRemediations(loaded, policyVerdict.evidence.evidence, analyzerCtx)
    );
  }

  let taskResult = null;
  if (args.task || args.taskFile) {
    let taskSpec = { task: args.task || null, requirements: [] };
    if (args.taskFile) {
      try {
        const parsed = JSON.parse(fs.readFileSync(args.taskFile, "utf8"));
        taskSpec = { task: parsed.task || args.task || null, requirements: parsed.requirements || [] };
      } catch (err) {
        console.error(`postflight run: could not read --task-file ${args.taskFile}: ${err.message}`);
        process.exit(2);
      }
    }
    taskResult = verifyTask({
      task: taskSpec.task,
      requirements: taskSpec.requirements,
      diffText,
      ledgerEvidence: policyVerdict ? policyVerdict.evidence.evidence : [],
    });
  }

  if (args.proof) {
    // Real coverage, when available, is worth recording verbatim in the
    // proof artifact - not just as a WARN finding (analyzers/coverage.js's
    // job) when something's uncovered. Reuses the same parsed diff the
    // analyzers already computed when available; falls back to parsing it
    // fresh (--no-analyzers skips analyzerCtx.parsedDiff, but coverage is
    // still worth reporting on its own).
    const parsedDiffForCoverage = analyzerCtx.parsedDiff || parseUnifiedDiff(diffText);
    const coverage = perf.time("coverage", () => coverageLib.summarize(repoRoot, args.coverage, parsedDiffForCoverage));
    const proof = buildProof({
      pkgVersion: pkg.version,
      repoUrl: resolveRepoUrl(repoRoot),
      cwd,
      base,
      headCommit: git.revParse("HEAD", cwd),
      baseCommit: git.revParse(base, cwd),
      changedFiles,
      diffSummary,
      buildResult,
      testResult,
      coverage,
      policyVerdict,
      taskResult,
      remediations: remediationResult.remediations,
      performance: { ...perf.toJSON(), coverageCache: coverageLib.cacheStats() },
    });
    const proofPath = path.resolve(cwd, args.proofOut || "postflight-proof.json");
    fs.writeFileSync(proofPath, JSON.stringify(proof, null, 2) + "\n");
    if ((args.format || "text") === "text") {
      console.error(`postflight: wrote proof artifact to ${path.relative(cwd, proofPath) || proofPath}`);
    }
  }

  const format = args.format || "text";
  if (format === "json") {
    console.log(
      JSON.stringify(
        {
          base,
          diffSummary,
          findings,
          untestedFiles: untested,
          looselyUntestedFiles: looselyUntested,
          buildResult,
          testResult,
          behaviorDiff,
          ...scoreResult,
          ...(policyVerdict ? { policyVerdict } : {}),
          ...(taskResult ? { taskResult } : {}),
          ...(remediationResult.remediations.length ? { remediations: remediationResult.remediations } : {}),
          performance: { ...perf.toJSON(), coverageCache: coverageLib.cacheStats() },
        },
        null,
        2
      )
    );
  } else if (format === "sarif") {
    console.log(JSON.stringify(toSarif({ findings, scoreResult, policyVerdict, taskResult, repoUrl: resolveRepoUrl(repoRoot) }), null, 2));
  } else if (format === "github") {
    const annotations = toGithubAnnotations({ findings });
    if (annotations) console.log(annotations);
    console.log(render({ diffSummary, findings, buildResult, testResult, scoreResult, untestedFiles: untested, looselyUntestedFiles: looselyUntested, behaviorDiff }, { color: resolveColor({ noColor: true }) }));
    if (policyVerdict) console.log(renderVerdict(policyVerdict, { color: resolveColor({ noColor: true }) }));
    if (taskResult) console.log(renderTaskResult(taskResult));
    if (remediationResult.remediations.length) console.log(renderRemediations(remediationResult.remediations, { color: resolveColor({ noColor: true }) }));
  } else {
    console.log(render({ diffSummary, findings, buildResult, testResult, scoreResult, untestedFiles: untested, looselyUntestedFiles: looselyUntested, behaviorDiff }, { color: resolveColor({ noColor: args.noColor }) }));
    if (policyVerdict) console.log(renderVerdict(policyVerdict, { color: resolveColor({ noColor: args.noColor }) }));
    if (taskResult) console.log(renderTaskResult(taskResult));
    if (remediationResult.remediations.length) console.log(renderRemediations(remediationResult.remediations, { color: resolveColor({ noColor: args.noColor }) }));
  }

  // Without --policy, behavior is exactly what it was before that flag
  // existed: 0/1 off scoreResult.status. With --policy, the exit code comes
  // from the evidence-based verdict instead (0/1/3/4 - see HELP above).
  process.exit(policyVerdict ? policyVerdict.exitCode : scoreResult.status === "SAFE_TO_MERGE" ? 0 : 1);
}

// "verify" is "run" with the evidence/verdict engine mandatory rather than
// opt-in - it is what "postflight verify --task ..." uses, and what a bare
// "postflight" (no subcommand, inside a git repo) delegates to.
function verifyCmd(args) {
  args.forcePolicy = true;
  return runCmd(args);
}

function pluginsCmd(args) {
  const { repoRoot, config } = resolveRepoContext(args);
  const sub = args._[1];

  if (sub === "validate") {
    const target = args._[2];
    if (!target) {
      console.error("postflight plugins validate: a plugin path is required");
      process.exit(2);
    }
    const result = plugins.loadPlugin(target, repoRoot);
    if (result.ok) {
      console.log(`OK  ${target} (${result.plugin.metadata.name}@${result.plugin.metadata.version})`);
      process.exit(0);
    } else {
      console.log(`FAIL  ${target}`);
      for (const e of result.errors) console.log(`  - ${e}`);
      process.exit(1);
    }
  }

  // Bare "postflight plugins" and "postflight plugins list" both list what
  // config.plugins currently configures.
  const entries = config.plugins || [];
  if (!entries.length) {
    console.log('postflight plugins: none configured (add a "plugins" array to .postflightrc.json)');
    process.exit(0);
  }
  const { loaded, failed } = plugins.loadPlugins(config, repoRoot);
  for (const { plugin, source } of loaded) {
    console.log(`OK    ${source}  ${plugin.metadata.name}@${plugin.metadata.version}`);
  }
  for (const { source, errors } of failed) {
    console.log(`FAIL  ${source}`);
    for (const e of errors) console.log(`        ${e}`);
  }
  process.exit(failed.length ? 1 : 0);
}

function remediationCmd(args) {
  const { repoRoot, config } = resolveRepoContext(args);
  const sub = args._[1];

  if (sub === "validate") {
    const target = args._[2];
    if (!target) {
      console.error("postflight remediation validate: a provider path is required");
      process.exit(2);
    }
    const result = remediation.loadProvider(target, repoRoot);
    if (result.ok) {
      console.log(`OK  ${target} (${result.provider.metadata.name}@${result.provider.metadata.version})`);
      process.exit(0);
    } else {
      console.log(`FAIL  ${target}`);
      for (const e of result.errors) console.log(`  - ${e}`);
      process.exit(1);
    }
  }

  // Bare "postflight remediation" and "postflight remediation list" both
  // list what config.remediationProviders currently configures.
  const entries = config.remediationProviders || [];
  if (!entries.length) {
    console.log(
      'postflight remediation: none configured (add a "remediationProviders" array to .postflightrc.json)'
    );
    process.exit(0);
  }
  const { loaded, failed } = remediation.loadProviders(config, repoRoot);
  for (const { provider, source } of loaded) {
    console.log(`OK    ${source}  ${provider.metadata.name}@${provider.metadata.version}`);
  }
  for (const { source, errors } of failed) {
    console.log(`FAIL  ${source}`);
    for (const e of errors) console.log(`        ${e}`);
  }
  process.exit(failed.length ? 1 : 0);
}

function explainCmd(args) {
  const { cwd, repoRoot } = resolveRepoContext(args);
  // "postflight explain <evidence-id>" (e.g. "test/command-result" or a
  // plugin id "plugin/foo/1") reads a previously written proof artifact
  // rather than re-scanning the repo - see src/explain.js#explainEvidence.
  // Distinguished from the --rule flow by shape: rule ids from checks.js
  // are short slugs like "hardcoded-secret", evidence ids always contain
  // a "/" (category/name).
  const evidenceId = args._[1];
  if (evidenceId && !args.rule) {
    const proofPath = path.resolve(cwd, args.proofFile || "postflight-proof.json");
    const result = explainMod.explainEvidence({ proofPath, id: evidenceId });
    console.log(explainMod.renderEvidenceExplain(result));
    process.exit(result.ok ? 0 : 1);
  }
  if (!args.rule) {
    console.error('postflight explain: --rule <id> is required (see "postflight run --format json" for rule ids)');
    process.exit(2);
  }
  const base = git.resolveBase(args.base, cwd);
  const changedFiles = git.diffStat(base, cwd).map((s) => s.file).concat(git.untrackedFiles(cwd));
  const result = explainMod.explain({ rule: args.rule, file: args.file, base, cwd, repoRoot, changedFiles });
  console.log(explainMod.render(result));
  process.exit(result.findings.length ? 0 : 1);
}

// action.yml lives at the root of *this* repository, so the correct `uses:`
// once it's checked out in CI is "<owner>/<this-repo>@<ref>" - never a
// separately-published "postflight/postflight-action" (no such repo is
// part of this project). initCmd fills in the real slug when it can detect
// it from the `origin` remote (see git.remoteSlug) and falls back to an
// explicit, impossible-to-miss placeholder otherwise.
// Same fallback chain as initCmd's `uses:` slug resolution, applied to
// SARIF's `informationUri` (src/formats.js), which used to hardcode a
// placeholder "postflight/postflight" org that doesn't exist. Prefers the
// `origin` remote (most likely to be accurate for the repo actually being
// scanned) and falls back to package.json's `repository` field. Returns
// null - never a fabricated placeholder - when neither is available.
function resolveRepoUrl(repoRoot) {
  const slug = git.remoteSlug(repoRoot);
  if (slug) return `https://github.com/${slug}`;
  const repository = pkg.repository;
  const repoField = typeof repository === "string" ? repository : repository && repository.url;
  if (!repoField) return null;
  return repoField
    .replace(/^git\+/, "")
    .replace(/\.git$/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^git@github\.com:/, "https://github.com/");
}

function workflowTemplate(usesLine) {
  return `name: postflight
on:
  pull_request:

jobs:
  postflight:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - ${usesLine}
        with:
          base: origin/\${{ github.base_ref }}
          # build: "npm run build"
          # test: "npm test"
          # Opt into the evidence/verdict engine (BLOCK/REVIEW_REQUIRED/
          # INCONCLUSIVE/SAFE_TO_MERGE) instead of the default confidence
          # score - see "postflight run --help" for preset details.
          # policy: "default"
          # Emit postflight-proof.json as an auditable CI artifact -
          # see docs/proof-schema.md
          # proof: "true"
`;
}

function initCmd(args) {
  const { repoRoot } = resolveRepoContext(args);
  const dir = path.join(repoRoot, ".github", "workflows");
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, "postflight.yml");
  if (fs.existsSync(target)) {
    console.error(`postflight init: ${target} already exists, not overwriting.`);
    process.exit(1);
  }
  const slug = git.remoteSlug(repoRoot);
  const usesLine = slug
    ? `uses: ${slug}@v1`
    : `uses: <owner>/<repo>@v1 # TODO: replace with this repository (couldn't detect it from 'origin')`;
  fs.writeFileSync(target, workflowTemplate(usesLine));
  console.log(`postflight init: wrote ${path.relative(repoRoot, target)}`);
  if (!slug) {
    console.log(
      `postflight init: couldn't detect a GitHub "origin" remote - edit the "uses:" line in the workflow before committing it.`
    );
  }
}

function main(argv) {
  const args = parseArgs(argv);

  if (args.version) {
    console.log(pkg.version);
    process.exit(0);
  }

  const cmd = args._[0];

  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }

  if (args.unknown.length) {
    console.error(`postflight: unrecognized option(s): ${args.unknown.join(", ")}`);
    console.error('Run "postflight --help" for a list of supported options.');
    process.exit(2);
  }

  // A bare "postflight" with no subcommand behaves like "postflight
  // verify" when run inside a git repository (see README's "problem"
  // section - a single command an agent hook can call with no
  // memorization required). Outside a git repo there is nothing to
  // verify, so it falls back to help instead of a confusing git error.
  if (!cmd) {
    if (git.isGitRepo(path.resolve(args.cwd || process.cwd()))) return verifyCmd(args);
    console.log(HELP);
    process.exit(0);
  }

  if (cmd === "run") return runCmd(args);
  if (cmd === "verify") return verifyCmd(args);
  if (cmd === "explain") return explainCmd(args);
  if (cmd === "plugins") return pluginsCmd(args);
  if (cmd === "remediation") return remediationCmd(args);
  if (cmd === "init") return initCmd(args);

  console.error(`postflight: unknown command "${cmd}"\n`);
  console.log(HELP);
  process.exit(1);
}

module.exports = { main, parseArgs };

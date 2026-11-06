"use strict";

const RULE_META = {
  "risky-shell-pipe": "Piping a remote download straight into a shell",
  "eval-exec": "Dynamic code execution",
  "child-process": "Executes an external process directly", // postflight-ignore
  "rm-rf": "Recursive force-delete",
  "secret-aws-key": "Possible AWS access key",
  "secret-generic": "Possible hardcoded secret/API key",
  "private-key": "Embedded private key material",
  "disabled-test": "Test disabled or skipped",
  "env-file": "New .env-style file committed",
  "todo-added": "Unfinished-work marker left in code", // postflight-ignore
  "architecture-cycle": "New circular dependency introduced",
  "behavior-regression": "Test passed on base, now fails",
  "test-removed": "Test present on base no longer found (heuristic)", // postflight-ignore
};

function severityToSarifLevel(severity) {
  return { high: "error", medium: "warning", low: "note" }[severity] || "note";
}

function toSarif({ findings, scoreResult, policyVerdict, taskResult, repoUrl }) {
  const rules = [...new Set(findings.map((f) => f.rule))].map((id) => ({
    id,
    shortDescription: { text: RULE_META[id] || id },
  }));

  const results = findings.map((f) => {
    const result = {
      ruleId: f.rule,
      level: severityToSarifLevel(f.severity),
      message: { text: f.snippet ? `${f.label}: ${f.snippet}` : f.label },
      locations: f.file
        ? [
            {
              physicalLocation: {
                artifactLocation: { uri: f.file },
                region: { startLine: 1 },
              },
            },
          ]
        : [],
    };
    // SARIF carries the confounders /
    // provenance / data an evidence-schema finding (src/evidence.js, via
    // src/analyzers/index.js's evidenceToFinding) already computes. The
    // SARIF 2.1.0 spec's `result` object allows an arbitrary `properties`
    // bag for exactly this kind of tool-specific extra detail, so this adds
    // one rather than extending the schema-defined fields above. Only
    // populated when the finding actually carries evidence detail -
    // v1 pattern-rule findings from checks.js don't, and get no
    // `properties` key at all rather than an empty one.
    const props = {};
    if (f.confounders) props.confounders = f.confounders;
    if (f.provenance) props.provenance = f.provenance;
    if (f.data) props.data = f.data;
    if (Object.keys(props).length) result.properties = props;
    return result;
  });

  return {
    $schema: "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/Schemata/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "postflight",
            // Previously hardcoded to a placeholder "postflight/postflight"
            // org that doesn't exist (same class of bug as the dead
            // action.yml reference `postflight init` fixes - see
            // git.remoteSlug there). The caller (src/cli.js) resolves the
            // real URL the same way: the `origin` remote first, then
            // package.json's `repository` field. When neither is
            // available, omit the field entirely rather than fabricate
            // another placeholder - `informationUri` is optional in the
            // SARIF 2.1.0 spec.
            ...(repoUrl ? { informationUri: repoUrl } : {}),
            rules,
          },
        },
        results,
        properties: {
          confidence: scoreResult.confidence,
          status: scoreResult.status,
          // See src/score.js's `verified` field. Optional since scoreResult historically didn't
          // carry it and some callers may still pass a bare { confidence,
          // status } (e.g. existing tests).
          ...(scoreResult.verified !== undefined ? { verified: scoreResult.verified } : {}),
          // Evidence records. Only present when --policy was passed
          // (src/cli.js) - the opt-in verdict/evidence layer (src/verdict.js,
          // src/policy.js, src/evidence.js) that computes this.
          ...(policyVerdict
            ? {
                policy: policyVerdict.policy,
                policyVerdict: policyVerdict.verdict,
                policyExitCode: policyVerdict.exitCode,
                evidence: policyVerdict.evidence,
              }
            : {}),
          // --task/--task-file (src/task.js) results, same rationale as
          // policyVerdict above: SARIF's run-level properties bag is the
          // only place a code-scanning consumer (or a later `postflight
          // explain`) can find this without a separate --proof artifact.
          // Only present when task verification actually ran.
          ...(taskResult ? { task: taskResult } : {}),
        },
      },
    ],
  };
}

function severityToGithubCommand(severity) {
  return { high: "error", medium: "warning", low: "notice" }[severity] || "notice";
}

// GitHub Actions workflow commands - printed to stdout, picked up by the
// runner and turned into inline PR annotations without needing SARIF
// upload permissions.
function toGithubAnnotations({ findings }) {
  return findings
    .map((f) => {
      const cmd = severityToGithubCommand(f.severity);
      const fileArg = f.file ? `file=${f.file},` : "";
      const message = f.snippet ? `${f.label}: ${f.snippet}` : f.label;
      return `::${cmd} ${fileArg}title=postflight:${f.rule}::${message}`;
    })
    .join("\n");
}

module.exports = { toSarif, toGithubAnnotations };

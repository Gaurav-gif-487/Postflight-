"use strict";

const { STATUS, STRENGTH, ORIGIN, METHOD } = require("../evidence");

// Not all files are equal. A change to a payment path or a database migration
// carries consequences that no amount of green CI removes. This analyzer does
// not claim the change is wrong - it claims a human with domain context must
// look, and says exactly why.

const CATEGORIES = [
  { id: "auth", label: "authentication / authorization", pattern: /(^|\/)(auth|authn|authz|login|session|permission|rbac|acl|oauth|jwt|password|credential)[^/]*(\/|\.|$)/i },
  { id: "payments", label: "payments / billing", pattern: /(^|\/)(payment|billing|invoice|charge|checkout|stripe|paddle|subscription|refund|price|pricing)[^/]*(\/|\.|$)/i },
  { id: "migration", label: "database migration", pattern: /(^|\/)(migrations?|migrate|schema|alembic|flyway|liquibase)(\/|_|\.|$)|\.sql$/i },
  { id: "crypto", label: "cryptography", pattern: /(^|\/)(crypto|encrypt|decrypt|cipher|hash|signature|signing|kms|keystore)[^/]*(\/|\.|$)/i },
  { id: "infra", label: "infrastructure as code", pattern: /(^|\/)(terraform|\.tf$|helm|k8s|kubernetes|deploy|infra|ansible)(\/|\.|$)|\.tf$/i },
  { id: "policy", label: "access policy", pattern: /(^|\/)(policies|policy|iam|rls|firewall|cors|csp)[^/]*(\/|\.|$)/i },
  { id: "public-api", label: "public API contract", pattern: /(^|\/)(api|routes?|controllers?|handlers?|graphql|openapi|swagger|proto)(\/|\.|$)|\.proto$/i },
];

// Deleting a migration or rewriting one already applied in production is a
// different, worse thing than adding one.
function classify(file) {
  return CATEGORIES.filter((c) => c.pattern.test(file)).map((c) => c.id);
}

function analyze({ base, changedFiles = [], statuses = {} }) {
  const evidence = [];
  const byCategory = new Map();

  for (const file of changedFiles) {
    for (const id of classify(file)) {
      if (!byCategory.has(id)) byCategory.set(id, []);
      byCategory.get(id).push(file);
    }
  }

  for (const [id, files] of byCategory) {
    const meta = CATEGORIES.find((c) => c.id === id);
    const destructive = files.filter((f) => statuses[f] && (statuses[f].status === "deleted" || statuses[f].status === "renamed"));
    const isMigrationRewrite = id === "migration" && files.some((f) => statuses[f] && statuses[f].status === "modified");

    evidence.push({
      id: `surface/sensitive-${id}`,
      category: id === "auth" || id === "crypto" || id === "policy" ? "security" : "surface",
      status: destructive.length || isMigrationRewrite ? STATUS.FAIL : STATUS.WARN,
      strength: STRENGTH.MEDIUM,
      origin: ORIGIN.INTRODUCED,
      summary: `${files.length} file(s) changed in a sensitive area: ${meta.label}`,
      detail: isMigrationRewrite
        ? `An existing migration was modified rather than superseded: ${files.join(", ")}`
        : destructive.length
          ? `Files were deleted or renamed here: ${destructive.join(", ")}`
          : files.join(", "),
      locations: files.map((file) => ({ file })),
      provenance: { method: METHOD.HEURISTIC, source: "path classification", ref: base },
      confounders: ["Classification is by file path; a match does not prove the change is behaviorally sensitive."],
      remediation: "Route this change to a reviewer who owns this area.",
    });
  }

  return { evidence };
}

module.exports = { analyze, classify, CATEGORIES };

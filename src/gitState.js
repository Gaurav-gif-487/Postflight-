"use strict";

const git = require("./git");
const { STATUS, STRENGTH, ORIGIN, METHOD } = require("./evidence");

// Establishes exactly what range was analyzed, and records evidence when the
// repository state makes that range untrustworthy. Every downstream claim is
// only as good as this.
function inspect({ base, cwd }) {
  const baseSha = git.revParse(base, cwd);
  const headSha = git.revParse("HEAD", cwd);
  const shallow = git.isShallow(cwd);
  const branch = git.currentBranch(cwd);
  const status = git.statusPorcelain(cwd);

  const partiallyStaged = status.filter((s) => s.index !== " " && s.index !== "?" && s.worktree !== " ").map((s) => s.file);
  const staged = status.filter((s) => s.index !== " " && s.index !== "?").map((s) => s.file);
  const dirty = status.filter((s) => s.worktree !== " " && s.worktree !== "?").map((s) => s.file);
  const untracked = status.filter((s) => s.index === "?").map((s) => s.file);

  return {
    base,
    baseSha,
    headSha,
    shallow,
    detachedHead: branch === null && Boolean(headSha),
    branch,
    partiallyStaged,
    stagedFiles: staged,
    dirtyFiles: dirty,
    untrackedFiles: untracked,
    baseResolved: Boolean(baseSha) || base === "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  };
}

// Turns the state above into ledger entries. Repo-state problems are WARN or
// UNKNOWN, never PASS-by-omission: if postflight cannot tell what it compared
// against, it says so instead of scoring the change.
function record(ledger, state) {
  if (!state.baseResolved) {
    ledger.add({
      id: "repo-state/base-unresolved",
      category: "repo-state",
      status: STATUS.UNKNOWN,
      strength: STRENGTH.STRONG,
      origin: ORIGIN.UNKNOWN,
      summary: `Base ref "${state.base}" does not resolve to a commit in this repository`,
      detail: "Without a resolvable base, no before/after comparison is possible.",
      provenance: { method: METHOD.OBSERVED, source: "git rev-parse" },
      remediation: "Pass --base with a ref that exists locally, or fetch it first.",
    });
    ledger.addLimitation({
      id: "no-base",
      summary: "No comparable base revision; all origin attribution is unavailable",
      impact: "blocks-attribution",
    });
    return;
  }

  if (state.shallow) {
    ledger.add({
      id: "repo-state/shallow-clone",
      category: "repo-state",
      status: STATUS.WARN,
      strength: STRENGTH.STRONG,
      origin: ORIGIN.UNKNOWN,
      summary: "Repository is a shallow clone, so history-based attribution may be wrong",
      detail: "Commits outside the fetched depth are invisible; a change may look introduced when it is not.",
      provenance: { method: METHOD.OBSERVED, source: "git rev-parse --is-shallow-repository" },
      remediation: "Check out with fetch-depth: 0 in CI.",
    });
    ledger.addLimitation({
      id: "shallow-clone",
      summary: "Shallow clone limits pre-existing vs introduced attribution",
    });
  }

  if (state.detachedHead) {
    ledger.add({
      id: "repo-state/detached-head",
      category: "repo-state",
      status: STATUS.WARN,
      strength: STRENGTH.STRONG,
      origin: ORIGIN.UNKNOWN,
      summary: "HEAD is detached; the analyzed range may not match the branch under review",
      detail: `HEAD is at ${state.headSha ? state.headSha.slice(0, 12) : "an unknown commit"} with no branch.`,
      provenance: { method: METHOD.OBSERVED, source: "git rev-parse --abbrev-ref HEAD" },
    });
  }

  if (state.partiallyStaged.length) {
    ledger.add({
      id: "repo-state/partially-staged",
      category: "repo-state",
      status: STATUS.WARN,
      strength: STRENGTH.STRONG,
      origin: ORIGIN.INTRODUCED,
      summary: `${state.partiallyStaged.length} file(s) are partially staged, so the committed change will differ from what was analyzed`,
      detail: state.partiallyStaged.join(", "),
      locations: state.partiallyStaged.map((file) => ({ file })),
      provenance: { method: METHOD.OBSERVED, source: "git status --porcelain" },
      remediation: "Stage or stash the remaining hunks before relying on this verdict.",
    });
  }

  if (state.dirtyFiles.length) {
    ledger.addLimitation({
      id: "dirty-worktree",
      summary: `${state.dirtyFiles.length} file(s) have unstaged modifications; executed checks ran against the worktree, not the commit`,
    });
  }
}

module.exports = { inspect, record };

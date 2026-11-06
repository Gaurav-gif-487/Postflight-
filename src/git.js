"use strict";
const { execFileSync } = require("child_process");

function git(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8" });
  } catch (err) {
    // Some callers (diffStatus, etc.) want to treat "ran but produced
    // nothing interesting" as fine. But an empty/undefined stdout means
    // the command genuinely failed (e.g. not a git repo at all) - that
    // must propagate so isGitRepo/resolveBase/hasCommits work correctly.
    if (err.stdout) return err.stdout;
    throw err;
  }
}

function isGitRepo(cwd) {
  try {
    git(["rev-parse", "--is-inside-work-tree"], cwd);
    return true;
  } catch {
    return false;
  }
}

// Absolute path to the repo root, so results are stable regardless of which
// subdirectory postflight was invoked from.
function repoRoot(cwd) {
  return git(["rev-parse", "--show-toplevel"], cwd).trim();
}

// Resolve a sensible "before" ref: prefer the given base, else the last
// commit, else the empty tree (covers a repo's very first change, before
// any commit exists).
function resolveBase(base, cwd) {
  if (base) return base;
  try {
    git(["rev-parse", "--verify", "HEAD"], cwd);
    return "HEAD";
  } catch {
    return "4b825dc642cb6eb9a060e54bf8d69288fbee4904"; // git's empty tree hash
  }
}

// `git diff --numstat` reports renames as "old => new" (or, for partial
// path renames, "common/{old => new}/tail"). Reduce either form down to the
// resulting (new) path so downstream code always sees a real file path.
function resolveRenamedPath(field) {
  if (!field.includes("=>")) return { file: field, renamedFrom: null };

  const braceMatch = field.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (braceMatch) {
    const [, prefix, from, to, suffix] = braceMatch;
    return {
      file: `${prefix}${to}${suffix}`,
      renamedFrom: `${prefix}${from}${suffix}`,
    };
  }

  const plainMatch = field.match(/^(.*) => (.*)$/);
  if (plainMatch) {
    return { file: plainMatch[2], renamedFrom: plainMatch[1] };
  }

  return { file: field, renamedFrom: null };
}

// Returns array of { file, renamedFrom, insertions, deletions, binary }.
// Empty diff -> empty array. Binary files report null insertions/deletions.
function diffStat(base, cwd) {
  const out = git(["diff", "--numstat", "-M", base, "--"], cwd);
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [ins, del, rawFile] = line.split("\t");
      const { file, renamedFrom } = resolveRenamedPath(rawFile);
      return {
        file,
        renamedFrom,
        insertions: ins === "-" ? null : parseInt(ins, 10),
        deletions: del === "-" ? null : parseInt(del, 10),
        binary: ins === "-",
      };
    });
}

// Per-file add/modify/delete/rename status, keyed by (new) file path.
// Useful for phases that care whether a file is new vs modified.
function diffStatus(base, cwd) {
  const out = git(["diff", "--name-status", "-M", base, "--"], cwd);
  const statuses = {};
  for (const line of out.split("\n").filter(Boolean)) {
    const parts = line.split("\t");
    const code = parts[0][0]; // A, M, D, R100, etc -> first char
    if (code === "R" && parts.length === 3) {
      statuses[parts[2]] = { status: "renamed", from: parts[1] };
    } else if (parts.length >= 2) {
      statuses[parts[1]] = { status: { A: "added", M: "modified", D: "deleted" }[code] || code };
    }
  }
  return statuses;
}

// Returns the unified diff text for a single file vs base.
function diffFile(base, file, cwd) {
  return git(["diff", "-M", base, "--", file], cwd);
}

// Returns full unified diff vs base (used for pattern scanning).
function diffAll(base, cwd) {
  return git(["diff", "-M", base, "--"], cwd);
}

// True if HEAD resolves to a real commit (vs the repo having none yet).
function hasCommits(cwd) {
  try {
    git(["rev-parse", "--verify", "HEAD"], cwd);
    return true;
  } catch {
    return false;
  }
}

// Repo-root-relative paths of untracked files, respecting .gitignore.
// `git diff` alone never sees these - and an agent's newly created files
// are exactly the ones most worth reviewing, so callers must merge this in.
function untrackedFiles(cwd) {
  const out = git(["ls-files", "--others", "--exclude-standard"], cwd);
  return out.split("\n").filter(Boolean);
}

// --- v2 additions: repo-state introspection -------------------------------
// The verdict engine has to know whether the range it analyzed is the range
// the operator thinks it analyzed. A shallow clone, a detached HEAD, a dirty
// worktree, or a partially staged file all silently change what "the change"
// means - and v1.1 reported on them as if nothing were amiss.

function revParse(ref, cwd) {
  try {
    return git(["rev-parse", "--verify", `${ref}^{commit}`], cwd).trim();
  } catch {
    return null;
  }
}

function isShallow(cwd) {
  try {
    return git(["rev-parse", "--is-shallow-repository"], cwd).trim() === "true";
  } catch {
    return false;
  }
}

function currentBranch(cwd) {
  try {
    const name = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd).trim();
    return name === "HEAD" ? null : name; // null => detached
  } catch {
    return null;
  }
}

// Porcelain v1 lines: "XY path". X is the index status, Y the worktree
// status - a file with both set is partially staged.
function statusPorcelain(cwd) {
  const out = git(["status", "--porcelain"], cwd);
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => ({
      index: line[0],
      worktree: line[1],
      file: line.slice(3).replace(/^.* -> /, "").trim(),
    }));
}

function mergeBase(a, b, cwd) {
  try {
    return git(["merge-base", a, b], cwd).trim();
  } catch {
    return null;
  }
}

// File contents at a ref, or null when the file did not exist there. Used by
// every "was this true before the change?" comparison.
function showFile(ref, file, cwd) {
  try {
    // stdio: ["pipe","pipe","ignore"] - this function already collapses
    // every failure (file not found at ref, ref doesn't exist, not a git
    // repo, etc.) into the same `null` and never inspects the error at
    // all, so there is no diagnostic value in letting git's stderr through.
    // Without this, execFileSync's default stdio inherits the child's
    // stderr straight to postflight's own stderr - and the single most
    // common reason this call fails is the single most common case this
    // tool exists to handle: a file that's new at `ref` (doesn't exist yet
    // at base, only in the working tree/head). Every analyzer that calls
    // showFile (dependencyChange, configChange, testIntegrity) hit this on
    // any new manifest/config/test file, in any language, printing a
    // scary-looking `fatal: path '<file>' does not exist in '<ref>'` (or
    // `... exists on disk, but not in '<ref>'`) on what is otherwise a
    // completely clean, successful run - confirmed live against a real
    // commit adding a new Cargo.toml (ripgrep be739c79).
    return execFileSync("git", ["show", `${ref}:${file}`], {
      cwd,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["pipe", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

function listFilesAtRef(ref, cwd) {
  try {
    return git(["ls-tree", "-r", "--name-only", ref], cwd).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

// Best-effort "owner/repo" slug for the `origin` remote, used only to
// prefill the GitHub Actions template (postflight init) with a `uses:`
// line that actually points at this repository instead of a placeholder.
// Returns null for anything that isn't recognizably GitHub (no remote, a
// non-GitHub host, SSH aliases postflight doesn't try to resolve) - the
// caller falls back to a clearly-marked placeholder in that case.
function remoteSlug(cwd) {
  let url;
  try {
    // Not having an "origin" remote at all is an entirely expected,
    // already-handled outcome here (see callers) - unlike git() above,
    // this deliberately doesn't let git's raw stderr ("error: No such
    // remote 'origin'") leak to the user's terminal/CI logs on that path,
    // for the same reason readFileAtRef below suppresses stderr on its
    // own expected-failure lookups.
    url = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
  if (!url) return null;
  // Matches both "git@github.com:owner/repo.git" and
  // "https://github.com/owner/repo(.git)?".
  const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(\.git)?\/?$/);
  if (!m) return null;
  return `${m[1]}/${m[2]}`;
}

module.exports = {
  git,
  isGitRepo,
  repoRoot,
  resolveBase,
  resolveRenamedPath,
  diffStat,
  diffStatus,
  diffFile,
  diffAll,
  hasCommits,
  untrackedFiles,
  revParse,
  isShallow,
  currentBranch,
  statusPorcelain,
  mergeBase,
  showFile,
  listFilesAtRef,
  remoteSlug,
};


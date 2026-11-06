"use strict";
const fs = require("fs");
const path = require("path");

// Heuristic binary sniff: a NUL byte in the first chunk is a reliable
// enough signal without pulling in a dependency.
function looksBinary(buf) {
  const sample = buf.subarray(0, 8000);
  return sample.includes(0);
}

// Builds { stats, diffText } for a set of untracked (repo-root-relative)
// file paths, shaped exactly like the output of git.diffStat/diffAll for
// tracked changes - so scanDiff() and the analyzers can treat "new file
// nobody `git add`-ed yet" identically to "tracked file with changes."
function buildUntrackedDiff(files, repoRoot) {
  const stats = [];
  const diffChunks = [];

  for (const file of files) {
    let buf;
    try {
      buf = fs.readFileSync(path.join(repoRoot, file));
    } catch {
      continue; // e.g. broken symlink - skip rather than crash the report
    }

    if (looksBinary(buf)) {
      stats.push({ file, renamedFrom: null, insertions: null, deletions: null, binary: true });
      continue;
    }

    const text = buf.toString("utf8");
    const lines = text.length ? text.split("\n") : [];
    // A trailing empty string from a final newline shouldn't count as a line.
    const contentLines = lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;

    stats.push({ file, renamedFrom: null, insertions: contentLines.length, deletions: 0, binary: false });

    diffChunks.push(
      [
        `diff --git a/${file} b/${file}`,
        "new file mode 100644",
        "--- /dev/null",
        `+++ b/${file}`,
        `@@ -0,0 +1,${contentLines.length} @@`,
        ...contentLines.map((l) => `+${l}`),
      ].join("\n")
    );
  }

  return { stats, diffText: diffChunks.join("\n") };
}

module.exports = { buildUntrackedDiff, looksBinary };

"use strict";

// A real (if small) unified-diff parser. v1.1 scanned the diff line by line
// with no notion of hunks, so every finding was reported without a line
// number and could not be cited, deduplicated, or suppressed precisely.

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * @returns {Array<{file:string, oldFile:string|null, binary:boolean,
 *   added:Array<{line:number, text:string, hunk:number}>,
 *   removed:Array<{line:number, text:string, hunk:number}>}>}
 */
function parseUnifiedDiff(diffText) {
  const files = [];
  let current = null;
  let newLine = 0;
  let oldLine = 0;
  let hunkIndex = 0;

  const lines = String(diffText || "").split("\n");
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      current = null;
      continue;
    }
    if (line.startsWith("--- ")) {
      const p = line.slice(4).trim();
      current = { file: null, oldFile: p === "/dev/null" ? null : p.replace(/^a\//, ""), binary: false, added: [], removed: [] };
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      if (!current) current = { oldFile: null, binary: false, added: [], removed: [] };
      current.file = p === "/dev/null" ? null : p.replace(/^b\//, "");
      files.push(current);
      hunkIndex = 0;
      continue;
    }
    if (!current) continue;
    if (line.startsWith("Binary files ")) {
      current.binary = true;
      continue;
    }
    const hunk = HUNK_RE.exec(line);
    if (hunk) {
      oldLine = parseInt(hunk[1], 10);
      newLine = parseInt(hunk[3], 10);
      hunkIndex += 1;
      continue;
    }
    if (line.startsWith("+")) {
      current.added.push({ line: newLine, text: line.slice(1), hunk: hunkIndex });
      newLine += 1;
    } else if (line.startsWith("-")) {
      current.removed.push({ line: oldLine, text: line.slice(1), hunk: hunkIndex });
      oldLine += 1;
    } else if (line.startsWith(" ")) {
      newLine += 1;
      oldLine += 1;
    }
  }
  return files.filter((f) => f.file || f.oldFile);
}

function changedLinesByFile(parsedFiles) {
  const out = {};
  for (const f of parsedFiles) {
    if (!f.file || f.binary) continue;
    out[f.file] = f.added.map((a) => a.line);
  }
  return out;
}

module.exports = { parseUnifiedDiff, changedLinesByFile };

"use strict";

const CODES = { red: "31", yellow: "33", green: "32", gray: "90", bold: "1" };

function makeColorizer(enabled) {
  const wrap = (code) => (text) => (enabled ? `\u001b[${code}m${text}\u001b[0m` : String(text));
  return {
    red: wrap(CODES.red),
    yellow: wrap(CODES.yellow),
    green: wrap(CODES.green),
    gray: wrap(CODES.gray),
    bold: wrap(CODES.bold),
    enabled,
  };
}

// Colors are on only for an interactive TTY, unless explicitly forced off
// with --no-color or the NO_COLOR env var (https://no-color.org).
function resolveColor({ noColor, stream = process.stdout } = {}) {
  if (noColor || process.env.NO_COLOR) return makeColorizer(false);
  return makeColorizer(Boolean(stream && stream.isTTY));
}

module.exports = { resolveColor, makeColorizer };

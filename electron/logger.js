"use strict";

// A small append-only log in <userData>/logs (main process). Never throws, never logs business data.
const fs = require("node:fs");
const path = require("node:path");

const MAX_BYTES = 1024 * 1024;

function createLogger(dir) {
  const file = path.join(dir, "invoisy.log");
  const write = (level, parts) => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      try {
        if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, file + ".1");
      } catch { /* no log yet */ }
      const text = parts.map((p) => (p instanceof Error ? `${p.name}: ${p.message}` : typeof p === "string" ? p : JSON.stringify(p))).join(" ");
      fs.appendFileSync(file, `${new Date().toISOString()} ${level} ${text}\n`);
    } catch { /* logging must never break the application */ }
  };
  return {
    file,
    info: (...p) => write("INFO", p),
    warn: (...p) => write("WARN", p),
    error: (...p) => write("ERROR", p),
  };
}

module.exports = { createLogger };

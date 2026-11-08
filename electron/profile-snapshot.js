"use strict";

/* ==========================================================================
   Start-up copy of the raw database folder (main process, plain Node).

   Chromium keeps the IndexedDB database as files in <userData>/IndexedDB. If those files were ever damaged (a power cut,
   a failing disk), Chromium can decide to discard what it cannot read and start with an empty database. To make sure the
   original files are never the only copy, a copy of that folder is made at start-up, BEFORE the window (and so the
   database) is opened, which is the one moment the files are complete and not in use.

   - A copy is made only when the data files changed since the newest copy (a start-up without changes copies nothing,
     so repeated starts can never push an older good copy out).
   - The newest three copies are kept; an older one is removed only after a new one was copied completely.
   - Copies are in <userData>/backups/profile-snapshots/IndexedDB-<time>. To use one, close Invoisy and put its contents
     back in <userData>/IndexedDB (docs/electron-desktop.md explains it).
   - It never fails the start-up: any problem is logged and the application starts anyway.
   ========================================================================== */

const nodeFs = require("node:fs");
const path = require("node:path");

const KEEP = 3;
const IGNORED = new Set(["LOCK", "LOG", "LOG.old", "CURRENT.bak"]);
const MAX_BYTES = 3 * 1024 * 1024 * 1024;

// Names and sizes of the files that hold the data (not the logs and locks that change at every start).
async function signatureOf(dir, fs) {
  const parts = [];
  let bytes = 0;
  async function walk(current, prefix) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { await walk(full, rel); continue; }
      if (IGNORED.has(entry.name) || entry.name.endsWith(".tmp") || entry.name.startsWith("MANIFEST") || entry.name === "CURRENT") continue;
      const size = (await fs.stat(full)).size;
      bytes += size;
      parts.push(`${rel}:${size}`);
    }
  }
  await walk(dir, "");
  return { signature: parts.sort().join("\n"), bytes, files: parts.length };
}

// Resolves { copied, name?, reason? }. Never rejects.
async function snapshotProfile(options) {
  const { userData, log } = options;
  const fs = options.fs || nodeFs.promises;
  const keep = options.keep || KEEP;
  const stamp = (options.now ? options.now() : new Date()).toISOString().replace(/[:.]/g, "-");
  const source = path.join(userData, "IndexedDB");
  const root = path.join(userData, "backups", "profile-snapshots");
  try {
    try { await fs.stat(source); } catch { return { copied: false, reason: "no database yet" }; }
    const now = await signatureOf(source, fs);
    if (now.files === 0) return { copied: false, reason: "empty" };
    if (now.bytes > MAX_BYTES) { log && log.warn("the database folder is too large to copy at start-up", now.bytes); return { copied: false, reason: "too large" }; }
    await fs.mkdir(root, { recursive: true });
    const existing = (await fs.readdir(root)).filter((n) => /^IndexedDB-/.test(n) && !n.endsWith(".partial")).sort();
    if (existing.length) {
      try {
        const last = await fs.readFile(path.join(root, existing[existing.length - 1], "signature.txt"), "utf8");
        if (last === now.signature) return { copied: false, reason: "unchanged" };
      } catch { /* the newest copy has no signature: copy again */ }
    }
    const name = `IndexedDB-${stamp}`;
    const partial = path.join(root, `${name}.partial`);
    await fs.rm(partial, { recursive: true, force: true });
    await fs.cp(source, path.join(partial, "IndexedDB"), { recursive: true });
    await fs.writeFile(path.join(partial, "signature.txt"), now.signature);
    await fs.rename(partial, path.join(root, name));
    const all = (await fs.readdir(root)).filter((n) => /^IndexedDB-/.test(n) && !n.endsWith(".partial")).sort();
    for (const old of all.slice(0, Math.max(0, all.length - keep))) await fs.rm(path.join(root, old), { recursive: true, force: true });
    for (const n of (await fs.readdir(root)).filter((n) => n.endsWith(".partial"))) await fs.rm(path.join(root, n), { recursive: true, force: true });
    log && log.info("copied the database folder", name, now.bytes);
    return { copied: true, name, bytes: now.bytes };
  } catch (e) {
    log && log.warn("could not copy the database folder at start-up", e && e.message);
    return { copied: false, reason: "error", error: e && e.message };
  }
}

module.exports = { snapshotProfile, signatureOf, KEEP };

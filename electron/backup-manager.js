"use strict";

/* ==========================================================================
   BackupManager - the files Invoisy keeps next to its database (main process, plain Node, no Electron).

   The business database stays in IndexedDB (inside the Chromium profile in the user-data folder). This module only
   handles COPIES of it, as JSON text made and checked by the page (Validation.prepareBackupFile, the same format as
   Export Backup). It never reads, changes or deletes the database.

   Folder layout (dir = <userData>/backups):
     invoisy-data.json            the CURRENT backup
     invoisy-data.previous.json   the previous successful backup (the one the current file replaced)
     daily/   invoisy-daily-YYYY-MM-DD.json   last state of each day that had changes (newest 7 kept)
     weekly/  invoisy-weekly-YYYY-Www.json    last state of each ISO week that had changes (newest 4 kept)
     safety/  copies made before a restore or an import (never deleted automatically)
     archive/ a file that was replaced although it was newer or damaged (never deleted automatically)
     .tmp/    files being written (leftovers from an interrupted write are removed at the next start)

   Rules
     - One write at a time (a promise queue), whoever asks.
     - The text is checked first (it must be an Invoisy backup). Then it is written to a temporary file, flushed to disk
       and read back; only a file that reads back identical is allowed to replace anything.
     - The previous valid backup is only replaced after the new one is verified. The swap is a rename, which is atomic
       on the same volume, so there is never a moment without a valid current file.
     - If the file being replaced holds a NEWER database revision than the new one, or is damaged, it is copied to
       archive/ first. Nothing is ever deleted because of a failed or older write.
     - Old daily / weekly files are pruned only after a write succeeded, and only those beyond the retention counts.
   ========================================================================== */

const nodeFs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const APP_NAME = "Invoisy";
const CURRENT_NAME = "invoisy-data.json";
const PREVIOUS_NAME = "invoisy-data.previous.json";
const DAILY_KEEP = 7;
const WEEKLY_KEEP = 4;
const MAX_TEXT_BYTES = 400 * 1024 * 1024;
const RENAME_RETRIES = 6;
const RENAME_RETRY_MS = 80;

class BackupError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = "BackupError";
    this.code = code;
    if (cause) this.cause = cause;
  }
}

const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
const pad = (n) => String(n).padStart(2, "0");
const localDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// ISO 8601 week of a local date: { year, week }.
function isoWeek(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return { year: date.getUTCFullYear(), week: Math.ceil(((date - yearStart) / 86400000 + 1) / 7) };
}
const weekKey = (d) => { const w = isoWeek(d); return `${w.year}-W${pad(w.week)}`; };

// What a backup text is, without checking every record (the page already did that with the code a restore uses).
function inspectBackupText(text) {
  if (typeof text !== "string" || !text.trim()) return { ok: false, error: "The backup is empty." };
  if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) return { ok: false, error: "The backup is too large." };
  let raw;
  try { raw = JSON.parse(text); } catch { return { ok: false, error: "The backup is not valid JSON." }; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "The backup has no data." };
  if (raw.application !== APP_NAME) return { ok: false, error: "This is not an Invoisy backup." };
  if (!Number.isInteger(raw.formatVersion) || raw.formatVersion < 1) return { ok: false, error: "The backup has no format version." };
  const data = raw.data;
  if (!data || typeof data !== "object" || !Array.isArray(data.products) || !Array.isArray(data.invoices)) {
    return { ok: false, error: "The backup does not hold the products and invoices lists." };
  }
  const exportedAt = typeof raw.exportedAt === "string" && !Number.isNaN(Date.parse(raw.exportedAt)) ? raw.exportedAt : "";
  const counts = raw.counts && typeof raw.counts === "object" ? raw.counts : {};
  const total = Object.values(counts).reduce((sum, n) => sum + (Number.isFinite(n) ? n : 0), 0);
  return {
    ok: true,
    revision: Number.isInteger(raw.revision) && raw.revision >= 0 ? raw.revision : null,
    exportedAt,
    counts,
    meaningful: total > 0 || data.products.length > 0 || data.invoices.length > 0,
  };
}

class BackupManager {
  // options: { dir, fs?, now?, log?, dailyKeep?, weeklyKeep? }
  constructor(options) {
    const opts = options || {};
    if (!opts.dir) throw new Error("BackupManager needs a folder.");
    this.dir = opts.dir;
    this.fs = opts.fs || nodeFs.promises;
    this.now = opts.now || (() => new Date());
    this.log = opts.log || { info() {}, warn() {}, error() {} };
    this.dailyKeep = opts.dailyKeep || DAILY_KEEP;
    this.weeklyKeep = opts.weeklyKeep || WEEKLY_KEEP;
    this.retryMs = opts.renameRetryMs === undefined ? RENAME_RETRY_MS : opts.renameRetryMs;
    this.currentPath = path.join(this.dir, CURRENT_NAME);
    this.previousPath = path.join(this.dir, PREVIOUS_NAME);
    this.dirs = {
      daily: path.join(this.dir, "daily"),
      weekly: path.join(this.dir, "weekly"),
      safety: path.join(this.dir, "safety"),
      archive: path.join(this.dir, "archive"),
      tmp: path.join(this.dir, ".tmp"),
    };
    this.queue = Promise.resolve();
    this.lastError = null;
    this.lastSuccess = null;
  }

  /* -- helpers -- */

  _serial(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  async ensureDirs() {
    await this.fs.mkdir(this.dir, { recursive: true });
    for (const d of Object.values(this.dirs)) await this.fs.mkdir(d, { recursive: true });
  }

  _tmpName(label) {
    return path.join(this.dirs.tmp, `${label}-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.tmp`);
  }

  async _unlinkQuiet(file) {
    try { await this.fs.unlink(file); } catch { /* already gone */ }
  }

  async _readText(file) {
    try {
      return await this.fs.readFile(file, "utf8");
    } catch (e) {
      if (e && e.code === "ENOENT") return null;
      throw e;
    }
  }

  // Writes bytes to `file`, flushed to disk. The file is created new (flag "w" on a temporary name).
  async _writeSynced(file, buffer) {
    const handle = await this.fs.open(file, "w");
    try {
      await handle.writeFile(buffer);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  // rename() replaces an existing file atomically. On Windows a virus scanner or indexer can hold a file for a moment
  // (EPERM / EBUSY / EACCES), so a few short retries are made before giving up.
  async _rename(from, to) {
    let lastError;
    for (let attempt = 0; attempt <= RENAME_RETRIES; attempt++) {
      try {
        await this.fs.rename(from, to);
        return;
      } catch (e) {
        lastError = e;
        if (!e || !["EPERM", "EBUSY", "EACCES"].includes(e.code) || attempt === RENAME_RETRIES) break;
        await new Promise((resolve) => setTimeout(resolve, this.retryMs * (attempt + 1)));
      }
    }
    throw lastError;
  }

  // A copy that appears under its final name only when complete.
  async _copyAtomic(from, to) {
    const tmp = this._tmpName("copy");
    try {
      await this.fs.copyFile(from, tmp);
      const [a, b] = await Promise.all([this.fs.readFile(from), this.fs.readFile(tmp)]);
      if (sha256(a) !== sha256(b)) throw new BackupError("VERIFY", "A copy did not read back the same.");
      await this._rename(tmp, to);
    } catch (e) {
      await this._unlinkQuiet(tmp);
      throw e;
    }
  }

  _wrap(e, code) {
    if (e instanceof BackupError) return e;
    const err = new BackupError(code || "WRITE", (e && e.message) || String(e), e);
    err.errno = e && e.code;
    return err;
  }

  /* -- the current backup -- */

  readCurrent() {
    return this._serial(async () => this._readText(this.currentPath));
  }

  // Replaces the current backup with `text` (see the rules at the top). Resolves with a short report.
  writeCurrent(text) {
    return this._serial(async () => {
      try {
        const result = await this._writeCurrent(text);
        this.lastError = null;
        this.lastSuccess = { at: this.now().toISOString(), revision: result.revision, bytes: result.bytes };
        return result;
      } catch (e) {
        const err = this._wrap(e);
        this.lastError = { at: this.now().toISOString(), code: err.code, message: err.message };
        this.log.error("backup write failed", err.code, err.message);
        throw err;
      }
    });
  }

  async _writeCurrent(text) {
    const info = inspectBackupText(text);
    if (!info.ok) throw new BackupError("INVALID", info.error);
    await this.ensureDirs();
    const buffer = Buffer.from(text, "utf8");
    const hash = sha256(buffer);

    const existing = await this._readText(this.currentPath);
    if (existing !== null && existing === text) {
      return { unchanged: true, bytes: buffer.length, sha256: hash, revision: info.revision };
    }

    const tmp = this._tmpName("current");
    try {
      await this._writeSynced(tmp, buffer);
      const back = await this.fs.readFile(tmp);
      if (back.length !== buffer.length || sha256(back) !== hash) {
        throw new BackupError("VERIFY", "The temporary backup did not read back the same, so nothing was replaced.");
      }
      const rotated = await this._rotate(existing, info);
      await this._rename(tmp, this.currentPath);
      await this._prune();
      return { unchanged: false, bytes: buffer.length, sha256: hash, revision: info.revision, rotated };
    } catch (e) {
      await this._unlinkQuiet(tmp);
      throw e;
    }
  }

  // Keeps what is about to be replaced: previous / daily / weekly copies, or archive/ when it is newer or damaged.
  async _rotate(existingText, next) {
    const done = { previous: false, daily: null, weekly: null, archived: null };
    if (existingText === null) return done;
    const old = inspectBackupText(existingText);
    const stamp = this.now().toISOString().replace(/[:.]/g, "-");
    if (!old.ok) {
      const name = path.join(this.dirs.archive, `invoisy-damaged-${stamp}.json`);
      await this._copyAtomic(this.currentPath, name);
      done.archived = path.basename(name);
      return done;
    }
    if (old.revision !== null && next.revision !== null && old.revision > next.revision) {
      const name = path.join(this.dirs.archive, `invoisy-newer-r${old.revision}-${stamp}.json`);
      await this._copyAtomic(this.currentPath, name);
      done.archived = path.basename(name);
    } else {
      await this._copyAtomic(this.currentPath, this.previousPath);
      done.previous = true;
    }
    // Snapshots of the state being replaced, when it belongs to an earlier day / week than now.
    const when = old.exportedAt ? new Date(old.exportedAt) : null;
    const today = this.now();
    if (when && !Number.isNaN(when.getTime())) {
      if (localDay(when) < localDay(today)) {
        const file = path.join(this.dirs.daily, `invoisy-daily-${localDay(when)}.json`);
        if (!(await this._exists(file))) { await this._copyAtomic(this.currentPath, file); done.daily = path.basename(file); }
      }
      if (weekKey(when) < weekKey(today)) {
        const file = path.join(this.dirs.weekly, `invoisy-weekly-${weekKey(when)}.json`);
        if (!(await this._exists(file))) { await this._copyAtomic(this.currentPath, file); done.weekly = path.basename(file); }
      }
    }
    return done;
  }

  async _exists(file) {
    try { await this.fs.stat(file); return true; } catch { return false; }
  }

  async _prune() {
    const rules = [
      [this.dirs.daily, /^invoisy-daily-\d{4}-\d{2}-\d{2}\.json$/, this.dailyKeep],
      [this.dirs.weekly, /^invoisy-weekly-\d{4}-W\d{2}\.json$/, this.weeklyKeep],
    ];
    for (const [dir, pattern, keep] of rules) {
      try {
        const names = (await this.fs.readdir(dir)).filter((n) => pattern.test(n)).sort().reverse();
        for (const name of names.slice(keep)) await this._unlinkQuiet(path.join(dir, name));
      } catch (e) {
        this.log.warn("could not prune", dir, e && e.message);   // keeping an extra copy is harmless
      }
    }
  }

  // Removes leftovers of an interrupted write. Called once at start-up.
  async cleanTemp() {
    try {
      await this.ensureDirs();
      for (const name of await this.fs.readdir(this.dirs.tmp)) await this._unlinkQuiet(path.join(this.dirs.tmp, name));
    } catch (e) {
      this.log.warn("could not clean the temporary folder", e && e.message);
    }
  }

  /* -- other copies -- */

  // A copy of the data made before a restore. Written like any backup, and never deleted by this module.
  saveSafety(text, name) {
    return this._serial(async () => {
      const info = inspectBackupText(text);
      if (!info.ok) throw new BackupError("INVALID", info.error);
      await this.ensureDirs();
      const base = path.basename(String(name || "invoisy-before-restore.json")).replace(/[^\w.\- ]+/g, "_").replace(/\.json$/i, "") || "invoisy-before-restore";
      const stamp = this.now().toISOString().replace(/[:.]/g, "-");
      const file = path.join(this.dirs.safety, `${base}-${stamp}.json`);
      await this._writeFileVerified(file, Buffer.from(text, "utf8"));
      return { name: path.basename(file), bytes: Buffer.byteLength(text, "utf8"), folder: this.dirs.safety };
    });
  }

  // Writes `buffer` to `target` through a temporary file next to it, verifies it, then swaps it in.
  async _writeFileVerified(target, buffer) {
    const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomBytes(4).toString("hex")}.tmp`);
    try {
      await this._writeSynced(tmp, buffer);
      const back = await this.fs.readFile(tmp);
      if (back.length !== buffer.length || sha256(back) !== sha256(buffer)) throw new BackupError("VERIFY", "The file did not read back the same.");
      await this._rename(tmp, target);
    } catch (e) {
      await this._unlinkQuiet(tmp);
      throw this._wrap(e);
    }
  }

  // For a file the person chose in a Save dialog (Export Backup, CSV). Nothing is validated beyond JSON for .json.
  saveTo(target, text) {
    return this._serial(async () => {
      if (typeof text !== "string") throw new BackupError("INVALID", "There is nothing to save.");
      if (/\.json$/i.test(target)) {
        try { JSON.parse(text); } catch { throw new BackupError("INVALID", "The content is not valid JSON."); }
      }
      await this._writeFileVerified(target, Buffer.from(text, "utf8"));
      return { bytes: Buffer.byteLength(text, "utf8") };
    });
  }

  /* -- what is there -- */

  async _entry(kind, file) {
    let stat;
    try { stat = await this.fs.stat(file); } catch { return null; }
    if (!stat.isFile()) return null;
    let info = { ok: false };
    try {
      const text = await this.fs.readFile(file, "utf8");
      info = inspectBackupText(text);
    } catch { /* unreadable: listed as not valid */ }
    return {
      kind, name: path.basename(file), bytes: stat.size, modifiedAt: stat.mtime.toISOString(),
      valid: !!info.ok, revision: info.ok ? info.revision : null, exportedAt: info.ok ? info.exportedAt : "",
      counts: info.ok ? info.counts : null, meaningful: !!info.ok && info.meaningful,
    };
  }

  async list() {
    const entries = [];
    const add = async (kind, file) => { const e = await this._entry(kind, file); if (e) entries.push(e); };
    await add("current", this.currentPath);
    await add("previous", this.previousPath);
    for (const [kind, dir] of [["daily", this.dirs.daily], ["weekly", this.dirs.weekly], ["safety", this.dirs.safety], ["archive", this.dirs.archive]]) {
      let names = [];
      try { names = (await this.fs.readdir(dir)).filter((n) => n.endsWith(".json")).sort().reverse(); } catch { /* folder not made yet */ }
      for (const name of names) await add(kind, path.join(dir, name));
    }
    return entries;
  }

  async status() {
    const files = await this.list();
    return {
      folder: this.dir,
      currentName: CURRENT_NAME,
      files,
      lastError: this.lastError,
      lastSuccess: this.lastSuccess,
    };
  }

  // The newest valid backup that holds data, from the automatic copies (not safety/ or archive/). Used to offer a
  // restore when the database is empty. Resolves null when there is none.
  latestValid() {
    return this._serial(async () => {
      const files = (await this.list()).filter((e) => ["current", "previous", "daily", "weekly"].includes(e.kind) && e.valid && e.meaningful);
      if (!files.length) return null;
      files.sort((a, b) => (b.exportedAt || "").localeCompare(a.exportedAt || "") || (b.revision || 0) - (a.revision || 0));
      const best = files[0];
      const folder = { current: this.dir, previous: this.dir, daily: this.dirs.daily, weekly: this.dirs.weekly }[best.kind];
      const text = await this._readText(path.join(folder, best.name));
      return text === null ? null : { text, name: best.name, kind: best.kind, exportedAt: best.exportedAt, revision: best.revision };
    });
  }
}

module.exports = {
  BackupManager, BackupError, inspectBackupText, localDay, weekKey, sha256,
  APP_NAME, CURRENT_NAME, PREVIOUS_NAME, DAILY_KEEP, WEEKLY_KEEP, MAX_TEXT_BYTES,
};

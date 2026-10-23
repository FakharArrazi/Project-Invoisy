"use strict";

/* ==========================================================================
   AutoBackup - keeps ONE local JSON file (invoisy-data.json) up to date after every committed change.

   Plain script (no modules, so index.html still works when opened directly). No DOM: script.js draws the
   Settings section and runs the dialogs. Loaded after database.js and before script.js.

   The IndexedDB database stays the only source of truth. The file is a copy of it:
     - It is written ONLY after database.js reports "commit" (a transaction that really committed and moved the
       revision on). Aborted transactions, reads and bookkeeping writes never reach this file.
     - Every write reads the whole database again in ONE transaction at the moment it runs, so a queued write can
       never put older data over newer data. Changes that arrive while a write is running or waiting are folded
       into the next one (a short wait gathers quick changes; one write at a time, across windows too where the
       browser has Web Locks).
     - The file content is built by Validation.prepareBackupFile(): the same format as Export Backup, checked by
       reading it back with the code a restore uses. It carries the database revision it holds.
     - The browser writes to a temporary copy and swaps it in when the write is closed, so a failed write leaves the
       previous file as it was. After closing, the file is read back and compared before anything is called saved.
     - A failed write never touches the database. The backup stays "pending", is retried a few times with growing
       pauses, then waits for the next change, the window coming back to the front, or the Retry button.
     - A file is never restored over the database from here. Restoring is Import / Restore Backup, nothing else.

   What is remembered (in the existing "meta" store, so there is no schema change):
     autoBackupHandle  the file handle the person chose (browsers keep a handle across restarts, but access to it
                       may have to be granted again, so it is checked on every start and before every write)
     autoBackup        { fileName, lastSuccessAt, lastRevision }: what was last written and verified
   ========================================================================== */

(function () {
  const V = globalThis.Validation;
  const t = (key, params) => I18n.t(key, params);

  const FILE_NAME = "invoisy-data.json";
  const HANDLE_KEY = "autoBackupHandle";
  const INFO_KEY = "autoBackup";
  const LOCK_NAME = "invoisy-autobackup-write";
  const DEFAULT_WAIT_MS = 400;                     // gathers quick successive changes into one write
  const DEFAULT_RETRY_MS = [3000, 15000, 60000];   // after the last one it stops until something new happens

  const errorText = (e) => (e && e.message) || String(e || "");

  class BackupError extends Error {
    constructor(code, message, retry) {
      super(message);
      this.name = "BackupError";
      this.code = code;
      this.retry = retry !== false;
    }
  }

  // Turns whatever the file system threw into { code, message, retry }.
  function classify(e) {
    if (e instanceof BackupError) return { code: e.code, message: e.message, retry: e.retry };
    const name = e && e.name;
    if (name === "NotFoundError") return { code: "NOT_FOUND", message: t("auto.notFound"), retry: false };
    if (name === "NotAllowedError" || name === "SecurityError") return { code: "PERMISSION", message: t("auto.permissionDenied"), retry: false };
    return { code: "WRITE", message: t("auto.writeFailed", { error: errorText(e) }), retry: true };
  }

  const isHandle = (h) => !!h && typeof h === "object" && h.kind === "file" && typeof h.getFile === "function" && typeof h.createWritable === "function";

  // Looks at a file's text without checking all of it: what is it, and (for an Invoisy backup) which database
  // revision does it hold?
  function peek(text) {
    if (!text || !text.trim()) return { kind: "empty" };
    let raw;
    try { raw = JSON.parse(text); } catch { return { kind: "invalid" }; }
    if (!raw || raw.application !== V.APP_NAME) return { kind: "other" };
    return {
      kind: "invoisy",
      revision: Number.isInteger(raw.revision) && raw.revision >= 0 ? raw.revision : null,
      exportedAt: V.isDate(raw.exportedAt) ? raw.exportedAt : "",
    };
  }

  async function queryPerm(h) {
    try {
      if (typeof h.queryPermission !== "function") return "granted";   // no permission API: let the write itself say
      return await h.queryPermission({ mode: "readwrite" });
    } catch {
      return "prompt";
    }
  }

  // Needs a click or key press (the browser refuses otherwise). Never call it on start-up.
  async function requestPerm(h) {
    try {
      if (typeof h.requestPermission !== "function") return "denied";
      return await h.requestPermission({ mode: "readwrite" });
    } catch {
      return "denied";
    }
  }

  // create() makes one automatic backup. The app makes one; tests make as many as they like.
  //   options.db            the database from database.js (required)
  //   options.supported     true / false to override the browser check (tests)
  //   options.pickFile      () => handle | throws AbortError: the file chooser (default: showSaveFilePicker)
  //   options.handleStore   { get(), set(handle) }: where the handle is kept (default: the database's meta store)
  //   options.now           () => Date
  //   options.timers        { set(fn, ms), clear(id) }
  //   options.locks         navigator.locks, or null for none
  //   options.waitMs, options.retryMs   pacing of writes and retries
  //   options.hold          () => true while a write should wait because the person is in the middle of something a
  //                         reload of the page would interrupt (a dialog waiting for an answer, work not saved yet).
  //                         Only the automatic writes wait; a click on Retry or on Allow access still writes at once.
  //                         The page calls resume() when that moment is over.
  function create(options) {
    const opts = options || {};
    const db = opts.db;
    const nowDate = () => (opts.now ? opts.now() : new Date());
    const nowIso = () => nowDate().toISOString();
    const timers = opts.timers || { set: (fn, ms) => globalThis.setTimeout(fn, ms), clear: (id) => globalThis.clearTimeout(id) };
    const waitMs = opts.waitMs !== undefined ? opts.waitMs : DEFAULT_WAIT_MS;
    const retryMs = opts.retryMs || DEFAULT_RETRY_MS;
    const listeners = [];

    // True while an automatic write should wait (see options.hold). A hold that throws never blocks a backup.
    const held = () => {
      try { return typeof opts.hold === "function" && Boolean(opts.hold()); } catch { return false; }
    };

    const supported = () => (opts.supported !== undefined ? !!opts.supported : typeof globalThis.showSaveFilePicker === "function");
    const handleStore = opts.handleStore || {
      async get() { const h = await db.getMeta(HANDLE_KEY); return isHandle(h) ? h : null; },
      set(h) { return db.setMeta(HANDLE_KEY, h); },
    };

    let handle = null;
    let permission = null;          // "granted" | "prompt" | "denied" | null (no file)
    let info = { fileName: "", lastSuccessAt: null, lastRevision: null };
    let latestRevision = null;      // newest committed database revision this window knows of
    let verified = false;           // the file has been read and found current (or just written) in this session
    let error = null;               // { code, message, at } of the last failed attempt, until one succeeds
    let fileNewer = null;           // { file, db }: the file holds a newer revision than the database
    let phase = "idle";             // idle | writing
    let dirty = false;              // something is waiting to be written
    let forceNext = false;          // the person confirmed replacing the file's content: skip the "newer" check
    let running = null;
    let waitTimer = null;
    let retryTimer = null;
    let retryCount = 0;

    function emit() {
      const status = getStatus();
      listeners.forEach((fn) => { try { fn(status); } catch { /* a listener must not break the backup */ } });
    }

    function noteRevision(revision) {
      if (Number.isInteger(revision) && (latestRevision === null || revision > latestRevision)) latestRevision = revision;
    }

    function getStatus() {
      const connected = !!handle;
      const current = verified && info.lastRevision !== null && latestRevision !== null && info.lastRevision >= latestRevision;
      let state;
      if (!connected) state = supported() ? "not-connected" : "unsupported";
      else if (permission !== "granted") state = "needs-permission";
      else if (fileNewer) state = "file-newer";
      else if (phase === "writing") state = "writing";
      else if (error) state = "error";
      else if (current) state = "current";
      else state = "pending";
      return {
        supported: supported(),
        connected,
        fileName: handle ? handle.name || info.fileName : "",
        state,
        permission,
        lastSuccessAt: info.lastSuccessAt,
        lastRevision: info.lastRevision,
        latestRevision,
        error: fileNewer && !error ? t("auto.fileNewer", { file: fileNewer.file, db: fileNewer.db }) : error ? error.message : "",
        attention: connected && (state === "needs-permission" || state === "error" || state === "file-newer"),
      };
    }

    /* -- Reading and writing the file -- */

    async function readText(h) {
      const file = await h.getFile();
      return file.text();
    }

    // Replaces the file's content. The browser writes a temporary copy and swaps it in on close(), so if anything
    // fails before that the file keeps its old content. The content is then read back and compared.
    async function writeFile(h, text) {
      const writable = await h.createWritable();
      try {
        await writable.write(text);
        await writable.close();
      } catch (e) {
        try { await writable.abort(); } catch { /* already closed or aborted */ }
        throw e;
      }
      if ((await readText(h)) !== text) throw new BackupError("VERIFY", t("auto.verifyFailed"), true);
    }

    function withLock(fn) {
      const locks = opts.locks !== undefined ? opts.locks : (globalThis.navigator && globalThis.navigator.locks);
      if (locks && typeof locks.request === "function") return locks.request(LOCK_NAME, fn);
      return fn();
    }

    async function saveInfo() {
      await db.setMeta(INFO_KEY, { fileName: info.fileName, lastSuccessAt: info.lastSuccessAt, lastRevision: info.lastRevision });
    }

    // The file now holds `revision` and that has been checked. Only called after reading the file.
    async function succeeded(revision, at) {
      info = { fileName: handle.name || info.fileName, lastSuccessAt: at, lastRevision: revision };
      error = null;
      fileNewer = null;
      verified = true;
      retryCount = 0;
      forceNext = false;
      try { await saveInfo(); } catch { /* the file is right; the next start checks the file itself */ }
    }

    // One attempt. Returns "ok" | "permission" | "newer" | "retry" | "stop".
    async function writeOnce() {
      const h = handle;
      permission = await queryPerm(h);
      if (permission !== "granted") { verified = false; return "permission"; }
      phase = "writing";
      fileNewer = null;   // looked at again below
      emit();
      try {
        return await withLock(async () => {
          const snapshot = await db.loadAll({ withAttachments: true });   // everything (including attached supplier invoices), in one transaction, as it is right now
          noteRevision(snapshot.revision);
          if (!forceNext) {
            const seen = peek(await readText(h));
            if (seen.kind === "invoisy" && seen.revision !== null) {
              if (seen.revision > snapshot.revision) {
                fileNewer = { file: seen.revision, db: snapshot.revision };
                return "newer";
              }
              if (seen.revision === snapshot.revision) {   // already current (for example another window wrote it)
                await succeeded(snapshot.revision, seen.exportedAt || nowIso());
                return "ok";
              }
            }
          }
          const file = V.prepareBackupFile(snapshot, nowDate());
          if (file.error) throw new BackupError("INVALID", t("auto.writeFailed", { error: file.error }), false);
          await writeFile(h, file.text);
          await succeeded(snapshot.revision, nowIso());
          return "ok";
        });
      } catch (e) {
        const c = classify(e);
        if (c.code === "PERMISSION") {
          permission = await queryPerm(h);
          if (permission !== "granted") { verified = false; return "permission"; }
        }
        error = { code: c.code, message: c.message, at: nowIso() };
        return c.retry ? "retry" : "stop";
      } finally {
        phase = "idle";
      }
    }

    // The one write loop. Everything that arrives while it runs sets `dirty` and is picked up by the next pass.
    function run(respectHold) {
      if (running) return running;
      // The first await matters: without it a loop with nothing to do would finish (and clear `running`) before
      // `running` below was assigned, leaving it stuck on a finished promise so that no later write ever ran.
      running = (async () => {
        await Promise.resolve();
        try {
          while (dirty && handle) {
            // An automatic write waits while the person is mid-task. It stays pending (dirty) and resume() starts it again.
            if (respectHold && held()) break;
            dirty = false;
            const outcome = await writeOnce();
            if (outcome === "ok") continue;
            dirty = true;   // still pending: a change, the window coming back, or Retry tries again
            if (outcome === "retry") scheduleRetry();
            break;
          }
        } finally {
          running = null;
          phase = "idle";
          emit();
        }
      })();
      return running;
    }

    function scheduleRetry() {
      if (retryCount >= retryMs.length) return;   // enough: no endless loop, no endless disk writes
      clearRetry();
      retryTimer = timers.set(() => { retryTimer = null; run(true); }, retryMs[retryCount++]);
    }

    function clearRetry() {
      if (retryTimer !== null) { timers.clear(retryTimer); retryTimer = null; }
    }

    function clearWait() {
      if (waitTimer !== null) { timers.clear(waitTimer); waitTimer = null; }
    }

    // Marks the file as out of date and writes soon (a short wait folds quick changes into one write).
    function schedule() {
      dirty = true;
      if (!handle || permission !== "granted") return;
      clearWait();
      waitTimer = timers.set(() => { waitTimer = null; run(true); }, waitMs);
    }

    /* -- What the app calls -- */

    // database.js says a change committed here ("commit") or in another window ("change").
    function notifyCommitted(revision) {
      try {
        noteRevision(revision);
        if (handle) { retryCount = 0; clearRetry(); schedule(); }
        emit();
      } catch { /* never let the backup disturb a saved change */ }
    }

    // Writes now instead of after the short wait. Resolves when nothing is waiting any more.
    function flushNow() {
      clearWait();
      clearRetry();
      return run();
    }

    // After the database is open: remembers nothing in this module, so everything is read again. Reconnects to the
    // file chosen earlier (without any prompt: permission may have to be granted again, see grant()), and if the
    // database is ahead of the file, brings the file up to date. Resolves when that first check is finished.
    async function start() {
      clearWait();
      clearRetry();
      if (running) await running;
      error = null;
      fileNewer = null;
      verified = false;
      retryCount = 0;
      forceNext = false;
      dirty = false;
      handle = null;
      let saved = null;
      try {
        handle = await handleStore.get();
        saved = await db.getMeta(INFO_KEY);
      } catch { /* nothing remembered: the same as no file */ }
      info = { fileName: "", lastSuccessAt: null, lastRevision: null, ...(saved && typeof saved === "object" ? saved : {}) };
      try { noteRevision(await db.getRevision()); } catch { /* shown as unknown */ }
      permission = handle ? await queryPerm(handle) : null;
      emit();
      if (handle && permission === "granted") {
        dirty = true;   // compares the file with the database even if the notes say it is current
        return run(true);   // waits (still pending) while a dialog is open or work is unsaved; resume() writes it afterwards
      }
      return undefined;
    }

    // Opens the browser's save dialog (it can create a new file or pick an existing one). Needs a click.
    // Resolves to a handle, or null when the person cancels.
    async function pickFile() {
      const picker = opts.pickFile || (() => globalThis.showSaveFilePicker({
        suggestedName: FILE_NAME,
        types: [{ description: t("auto.fileType"), accept: { "application/json": [".json"] } }],
      }));
      try {
        return await picker();
      } catch (e) {
        if (e && e.name === "AbortError") return null;
        throw e;
      }
    }

    // What the chosen file holds, before anything is written to it:
    //   { kind: "empty" }                          nothing in it
    //   { kind: "invoisy", parsed, text, revision } a valid Invoisy backup (or the older data file)
    //   { kind: "foreign", error }                  something else: it must not be replaced
    //   { kind: "unreadable", error }               it could not be read
    async function inspect(h) {
      let text;
      try {
        text = await readText(h);
      } catch (e) {
        return { kind: "unreadable", error: t("auto.readFailed", { error: errorText(e) }) };
      }
      if (!text.trim()) return { kind: "empty", text };
      const parsed = V.parseBackup(text);
      if (parsed.error) return { kind: "foreign", error: parsed.error, text };
      return { kind: "invoisy", parsed, text, revision: parsed.revision };
    }

    // Makes `chosen` the backup file: checks it can be written, remembers it, and writes the first complete copy.
    // The caller has already decided (and, where the file held data, confirmed) that the file may be replaced.
    // Resolves to { status, remembered }. If the first write fails the file stays connected and pending.
    async function attach(chosen) {
      if (!isHandle(chosen)) throw new BackupError("INVALID", t("auto.writeFailed", { error: "?" }), false);
      let perm = await queryPerm(chosen);
      if (perm !== "granted") perm = await requestPerm(chosen);
      if (perm !== "granted") throw new BackupError("PERMISSION", t("auto.permissionDenied"), false);
      if (running) await running;
      let remembered = true;
      try { await handleStore.set(chosen); } catch { remembered = false; }
      clearWait();
      clearRetry();
      handle = chosen;
      permission = "granted";
      info = { fileName: chosen.name || "", lastSuccessAt: null, lastRevision: null };
      error = null;
      fileNewer = null;
      verified = false;
      retryCount = 0;
      forceNext = true;
      dirty = true;
      try { noteRevision(await db.getRevision()); } catch { /* shown as unknown */ }
      try { await saveInfo(); } catch { /* written again after the first successful backup */ }
      emit();
      await run();
      return { status: getStatus(), remembered };
    }

    // Asks the browser for write access again. Needs a click. Writes the pending backup if it is granted.
    async function grant() {
      if (!handle) return getStatus();
      permission = await requestPerm(handle);
      emit();
      if (permission === "granted") { dirty = true; await flushNow(); }
      return getStatus();
    }

    // The Retry button (a click, so access can be asked for again when it was lost).
    async function retry() {
      if (!handle) return getStatus();
      permission = await queryPerm(handle);
      if (permission !== "granted") permission = await requestPerm(handle);
      retryCount = 0;
      dirty = true;
      emit();
      if (permission === "granted") await flushNow();
      return getStatus();
    }

    // The moment the write was waiting for is over (a dialog was answered, the sale was saved or cleared): write the pending
    // backup now, after the usual short wait. Does nothing when nothing is waiting, when a write is already under way or
    // planned, or when the person is still busy (the next resume() call then tries again).
    function resume() {
      if (!dirty || !handle || permission !== "granted" || running || waitTimer !== null || held()) return;
      schedule();
    }

    // The window came back to the front: if something is waiting (for example a drive was plugged back in), try once.
    function nudge() {
      if (!handle || running || waitTimer !== null || held()) return Promise.resolve();
      const s = getStatus();
      if (s.state === "current" || s.state === "writing") return Promise.resolve();
      retryCount = 0;
      dirty = true;
      return queryPerm(handle).then((p) => {
        permission = p;
        if (p === "granted") return flushNow();
        emit();
        return undefined;
      });
    }

    return {
      supported, getStatus, notifyCommitted, flushNow, start, pickFile, inspect, attach, grant, retry, nudge, resume,
      on(fn) { listeners.push(fn); },
    };
  }

  globalThis.AutoBackup = { FILE_NAME, HANDLE_KEY, INFO_KEY, BackupError, create, peek };
})();

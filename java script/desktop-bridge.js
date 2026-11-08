"use strict";

/* ==========================================================================
   DesktopBridge - the small layer between the page and the Invoisy desktop application (Electron).

   Plain script, no modules. Loaded after autobackup.js and before script.js. In an ordinary browser (index.html opened
   directly, or served by any web server) there is no window.invoisyDesktop, so this file only publishes
   { isDesktop: false } and the page behaves exactly as before.

   In the desktop application the page gets window.invoisyDesktop from electron/preload.js (a few fixed requests to the
   main process, no Node.js). This file turns those into what the page already knows how to use:

     - A file "handle" for the automatic backup (autobackup.js works with browser file handles). It always points to the
       current backup in the application's own folder, so there is nothing to choose and no permission to grant.
       Writing through it asks the main process to write a temporary file, check it, and swap it in (see
       electron/backup-manager.js); reading it gives back what is there, so autobackup.js can verify every write.
     - Native "Save as" and "Open" dialogs for Export Backup / Import Backup, and a safety-copy folder for restores.
     - Opening a supplier invoice attachment with the program Windows uses for it.

   The database itself is untouched: it is still IndexedDB, opened by database.js exactly as in the browser.
   ========================================================================== */

(function () {
  const api = globalThis.invoisyDesktop;
  if (!api || api.isDesktop !== true) {
    globalThis.DesktopBridge = { isDesktop: false };
    return;
  }

  const FILE_NAME = "invoisy-data.json";
  const info = { backupFolder: "", version: "", platform: "" };
  const ready = Promise.resolve()
    .then(() => api.info())
    .then((r) => { if (r && r.ok) { info.backupFolder = r.backupFolder; info.version = r.version; info.platform = r.platform; } })
    .catch(() => {});

  // An error the page can show. `invoisyMessage` is picked up by autobackup.js (see its classify()).
  function failure(result, fallback) {
    const err = new Error((result && result.message) || fallback || "Unexpected error.");
    err.name = "DesktopError";
    err.invoisyCode = (result && result.code) === "INVALID" ? "INVALID" : "WRITE";
    err.invoisyRetry = !(result && result.code === "INVALID");
    return err;
  }

  /* -- The automatic backup file -- */

  const handle = {
    kind: "file",
    name: FILE_NAME,
    async getFile() {
      const r = await api.backup.read();
      if (!r || !r.ok) throw failure(r, "The backup could not be read.");
      const text = typeof r.text === "string" ? r.text : "";
      return { text: async () => text };
    },
    async createWritable() {
      let chunks = [];
      return {
        async write(chunk) { chunks.push(String(chunk)); },
        async close() {
          const text = chunks.join("");
          chunks = [];
          const r = await api.backup.write(text);
          if (!r || !r.ok) throw failure(r, "The backup could not be written.");
        },
        async abort() { chunks = []; },
      };
    },
    async queryPermission() { return "granted"; },
    async requestPermission() { return "granted"; },
  };

  // Options for AutoBackup.create(): always connected to the file above; nothing to choose, nothing to remember.
  function autoBackupOptions() {
    return {
      supported: true,
      handleStore: { async get() { return handle; }, async set() { /* fixed location: nothing to remember */ } },
      pickFile: async () => handle,
    };
  }

  /* -- Files the person chooses -- */

  // Resolves true when the file was saved, false when the person closed the dialog. Throws when saving failed.
  async function saveText(text, suggestedName) {
    const r = await api.files.saveText(text, suggestedName);
    if (!r || !r.ok) throw failure(r, "The file could not be saved.");
    return !r.canceled;
  }

  // Resolves null when the person closed the dialog, or an object that works like a File for importBackup().
  async function openBackupFile() {
    const r = await api.files.openBackup();
    if (!r || !r.ok) throw failure(r, "The file could not be opened.");
    if (r.canceled) return null;
    return { name: r.name, text: async () => r.text };
  }

  // A copy of the data made before a restore, kept in the application's folder. Resolves the file name.
  async function saveSafetyCopy(text, name) {
    const r = await api.backup.saveSafety(text, name);
    if (!r || !r.ok) throw failure(r, "The safety copy could not be saved.");
    return r.name;
  }

  // The newest valid automatic backup that holds data, or null.
  async function latestBackup() {
    const r = await api.backup.latest();
    if (!r || !r.ok) throw failure(r, "The backups could not be read.");
    return r.latest || null;
  }

  async function openBackupFolder() {
    const r = await api.backup.openFolder();
    if (!r || !r.ok) throw failure(r, "The folder could not be opened.");
  }

  // A scanned supplier invoice: opened with the program Windows uses for that kind of file.
  async function openAttachment(record) {
    const url = String(record && record.dataUrl || "");
    const comma = url.indexOf(",");
    if (comma < 0 || !/;base64$/i.test(url.slice(0, comma))) throw new Error("The attachment can not be opened.");
    const r = await api.files.openAttachment(record.name || "attachment", url.slice(comma + 1));
    if (!r || !r.ok) throw failure(r, "The attachment could not be opened.");
  }

  // A scanned supplier invoice saved through a Save dialog. Resolves true when saved.
  async function saveAttachment(record) {
    const url = String(record && record.dataUrl || "");
    const comma = url.indexOf(",");
    if (comma < 0 || !/;base64$/i.test(url.slice(0, comma))) throw new Error("The attachment can not be saved.");
    const r = await api.files.saveAttachment(record.name || "attachment", url.slice(comma + 1));
    if (!r || !r.ok) throw failure(r, "The attachment could not be saved.");
    return !r.canceled;
  }

  // The page as a PDF, laid out like the printed page, through a Save dialog. Resolves true when saved.
  async function savePdf(suggestedName) {
    const r = await api.print.toPdf(suggestedName);
    if (!r || !r.ok) throw failure(r, "The PDF could not be saved.");
    return !r.canceled;
  }

  globalThis.DesktopBridge = {
    isDesktop: true,
    FILE_NAME,
    ready,
    get backupFolder() { return info.backupFolder; },
    get version() { return info.version; },
    handle, autoBackupOptions,
    saveText, openBackupFile, saveSafetyCopy, latestBackup, openBackupFolder, openAttachment, saveAttachment, savePdf,
    onBeforeClose: (fn) => api.onBeforeClose(fn),
  };
})();

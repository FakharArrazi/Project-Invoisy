"use strict";

/* ==========================================================================
   IPC handlers (main process). The page can only do what is listed here, through the preload bridge.

   Every call is checked: it must come from the application's own page (app://invoisy), the arguments must be of the
   expected type and size, and the page never gives a file path: paths come only from the Windows dialogs the person
   answers, or from fixed folders inside the user-data folder.
   ========================================================================== */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { isAppUrl } = require("./app-protocol");
const { MAX_TEXT_BYTES } = require("./backup-manager");

const CH = {
  backupWrite: "invoisy:backup:write",
  backupRead: "invoisy:backup:read",
  backupStatus: "invoisy:backup:status",
  backupLatest: "invoisy:backup:latest",
  backupSafety: "invoisy:backup:safety",
  openFolder: "invoisy:backup:open-folder",
  saveText: "invoisy:file:save-text",
  openBackup: "invoisy:file:open-backup",
  openAttachment: "invoisy:file:open-attachment",
  saveAttachment: "invoisy:file:save-attachment",
  printPdf: "invoisy:print:pdf",
  flushReady: "invoisy:app:flush-ready",
  flushDone: "invoisy:app:flush-done",
  flushRequest: "invoisy:app:flush-request",
  info: "invoisy:app:info",
};

const MAX_ATTACHMENT_BYTES = 60 * 1024 * 1024;
const SAFE_NAME = /[^\w.\-() ]+/g;

const cleanName = (name, fallback) => {
  const base = path.basename(String(name || "")).replace(SAFE_NAME, "_").slice(0, 120);
  return base || fallback;
};

class IpcError extends Error {}

function register(deps) {
  const { ipcMain, dialog, shell, app, getWindow, backup, log, paths } = deps;

  // Only the application's own page may call. (A page of another origin can not even load, but this is the second lock.)
  const trusted = (event) => {
    const frame = event.senderFrame;
    return !!frame && isAppUrl(frame.url);
  };

  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!trusted(event)) { log.warn("refused a call from an untrusted page", channel); throw new IpcError("Not allowed."); }
      try {
        return await fn(event, ...args);
      } catch (e) {
        // The page gets a plain { ok:false, code, message } instead of a stack trace.
        log.error(channel, e);
        return { ok: false, code: (e && e.code) || "ERROR", message: (e && e.message) || "Unexpected error." };
      }
    });
  };

  const text = (value, limit) => {
    if (typeof value !== "string") throw new IpcError("A text was expected.");
    if (Buffer.byteLength(value, "utf8") > (limit || MAX_TEXT_BYTES)) throw new IpcError("The text is too large.");
    return value;
  };

  /* -- automatic backup -- */

  handle(CH.backupWrite, async (_e, content) => {
    const r = await backup.writeCurrent(text(content));
    return { ok: true, bytes: r.bytes, revision: r.revision, unchanged: !!r.unchanged };
  });

  handle(CH.backupRead, async () => ({ ok: true, text: await backup.readCurrent() }));

  handle(CH.backupStatus, async () => ({ ok: true, status: await backup.status() }));

  handle(CH.backupLatest, async () => ({ ok: true, latest: await backup.latestValid() }));

  handle(CH.backupSafety, async (_e, content, name) => ({ ok: true, ...(await backup.saveSafety(text(content), cleanName(name, "invoisy-before-restore.json"))) }));

  handle(CH.openFolder, async () => {
    await backup.ensureDirs();
    const failure = await shell.openPath(paths.backups);
    return failure ? { ok: false, code: "OPEN", message: failure } : { ok: true };
  });

  /* -- Windows dialogs -- */

  // Export Backup, CSV and similar: the person chooses where the file goes.
  handle(CH.saveText, async (_e, content, suggestedName) => {
    const body = text(content);
    const name = cleanName(suggestedName, "invoisy-export.json");
    const ext = path.extname(name).replace(".", "").toLowerCase() || "json";
    const win = getWindow();
    const filters = [{ name: ext === "csv" ? "CSV" : ext === "json" ? "JSON" : ext.toUpperCase(), extensions: [ext] }, { name: "All files", extensions: ["*"] }];
    const picked = await dialog.showSaveDialog(win, { title: "Invoisy", defaultPath: path.join(paths.documents, name), filters });
    if (picked.canceled || !picked.filePath) return { ok: true, canceled: true };
    const r = await backup.saveTo(picked.filePath, body);
    return { ok: true, canceled: false, name: path.basename(picked.filePath), bytes: r.bytes };
  });

  // Import / Restore Backup: the person chooses the file; its text goes to the page, which validates it.
  handle(CH.openBackup, async () => {
    const win = getWindow();
    const picked = await dialog.showOpenDialog(win, {
      title: "Invoisy",
      defaultPath: paths.documents,
      properties: ["openFile"],
      filters: [{ name: "Invoisy backup (JSON)", extensions: ["json"] }, { name: "All files", extensions: ["*"] }],
    });
    if (picked.canceled || !picked.filePaths || !picked.filePaths.length) return { ok: true, canceled: true };
    const file = picked.filePaths[0];
    const stat = await fs.promises.stat(file);
    if (!stat.isFile()) return { ok: false, code: "NOT_FILE", message: "That is not a file." };
    if (stat.size > MAX_TEXT_BYTES) return { ok: false, code: "TOO_LARGE", message: "That file is too large to be an Invoisy backup." };
    const content = await fs.promises.readFile(file, "utf8");
    return { ok: true, canceled: false, name: path.basename(file), text: content };
  });

  // A scanned supplier invoice (PDF or image): written to a temporary file and opened with the program Windows uses for it.
  handle(CH.openAttachment, async (_e, name, base64) => {
    if (typeof base64 !== "string" || base64.length > Math.ceil(MAX_ATTACHMENT_BYTES * 4 / 3) + 16) throw new IpcError("The attachment is too large.");
    const safe = cleanName(name, "attachment");
    const dir = path.join(os.tmpdir(), "invoisy-attachments");
    await fs.promises.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${safe}`);
    await fs.promises.writeFile(file, Buffer.from(base64, "base64"));
    const failure = await shell.openPath(file);
    return failure ? { ok: false, code: "OPEN", message: failure } : { ok: true };
  });

  // A scanned supplier invoice saved through a Save dialog.
  handle(CH.saveAttachment, async (_e, name, base64) => {
    if (typeof base64 !== "string" || base64.length > Math.ceil(MAX_ATTACHMENT_BYTES * 4 / 3) + 16) throw new IpcError("The attachment is too large.");
    const safe = cleanName(name, "attachment");
    const ext = path.extname(safe).replace(".", "").toLowerCase();
    const picked = await dialog.showSaveDialog(getWindow(), {
      title: "Invoisy", defaultPath: path.join(paths.documents, safe),
      filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }, { name: "All files", extensions: ["*"] }] : [{ name: "All files", extensions: ["*"] }],
    });
    if (picked.canceled || !picked.filePath) return { ok: true, canceled: true };
    const tmp = picked.filePath + ".tmp";
    await fs.promises.writeFile(tmp, Buffer.from(base64, "base64"));
    await fs.promises.rename(tmp, picked.filePath);
    return { ok: true, canceled: false, name: path.basename(picked.filePath) };
  });

  // Save the page as a PDF (what the print layout shows) through a Save dialog.
  handle(CH.printPdf, async (_e, suggestedName) => {
    const win = getWindow();
    let name = cleanName(suggestedName, "invoice.pdf");
    if (!/\.pdf$/i.test(name)) name += ".pdf";
    const picked = await dialog.showSaveDialog(win, { title: "Invoisy", defaultPath: path.join(paths.documents, name), filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (picked.canceled || !picked.filePath) return { ok: true, canceled: true };
    const data = await win.webContents.printToPDF({ preferCSSPageSize: true, printBackground: true });
    const tmp = picked.filePath + ".tmp";
    await fs.promises.writeFile(tmp, data);
    await fs.promises.rename(tmp, picked.filePath);
    return { ok: true, canceled: false, name: path.basename(picked.filePath), bytes: data.length };
  });

  /* -- closing the window -- */

  handle(CH.info, async () => ({
    ok: true, version: app.getVersion(), platform: process.platform, packaged: app.isPackaged, backupFolder: paths.backups,
  }));

  return { CH };
}

module.exports = { register, CH, cleanName };

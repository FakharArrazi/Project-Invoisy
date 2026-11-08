"use strict";

// The only thing the page can use of Electron. contextIsolation is on, Node is off and the page is sandboxed, so this
// small object (window.invoisyDesktop) is all there is: each method sends one named, fixed request to the main process.
const { contextBridge, ipcRenderer } = require("electron");

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

const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld("invoisyDesktop", Object.freeze({
  isDesktop: true,
  info: () => call(CH.info),
  backup: Object.freeze({
    write: (text) => call(CH.backupWrite, String(text)),
    read: () => call(CH.backupRead),
    status: () => call(CH.backupStatus),
    latest: () => call(CH.backupLatest),
    saveSafety: (text, name) => call(CH.backupSafety, String(text), String(name || "")),
    openFolder: () => call(CH.openFolder),
  }),
  files: Object.freeze({
    saveText: (text, suggestedName) => call(CH.saveText, String(text), String(suggestedName || "")),
    openBackup: () => call(CH.openBackup),
    openAttachment: (name, base64) => call(CH.openAttachment, String(name || ""), String(base64 || "")),
    saveAttachment: (name, base64) => call(CH.saveAttachment, String(name || ""), String(base64 || "")),
  }),
  print: Object.freeze({
    toPdf: (suggestedName) => call(CH.printPdf, String(suggestedName || "")),
  }),
  // The window is about to close: the page writes any waiting backup, then answers with done().
  onBeforeClose: (handler) => {
    if (typeof handler !== "function") return;
    ipcRenderer.on(CH.flushRequest, async () => {
      let proceed = true;
      try { proceed = (await handler()) !== false; } catch { /* closing must go on */ }
      ipcRenderer.send(CH.flushDone, proceed);
    });
    ipcRenderer.send(CH.flushReady);
  },
}));

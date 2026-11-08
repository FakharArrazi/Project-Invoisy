"use strict";

/* ==========================================================================
   Invoisy desktop - main process.

   The application is the existing web application (index.html, css/, "java script/"), loaded unchanged from
   app://invoisy/. Its database is still IndexedDB: Chromium keeps it inside the user-data folder, which is outside the
   installation folder and is not touched by updates or by uninstalling.

   This file: start-up, the app:// origin, the window and its security settings, the lifecycle (single instance,
   closing after the last backup is written) and error handling. Files and backups are in backup-manager.js and
   ipc-handlers.js.
   ========================================================================== */

const { app, BrowserWindow, protocol, session, shell, Menu, dialog, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { SCHEME, ORIGIN, isAppUrl, createHandler } = require("./app-protocol");
const { BackupManager } = require("./backup-manager");
const { snapshotProfile } = require("./profile-snapshot");
const { createLogger } = require("./logger");
const ipc = require("./ipc-handlers");

const IS_DEV = !app.isPackaged;
const OPEN_DEVTOOLS = IS_DEV && process.argv.includes("--dev");
const APP_ROOT = path.join(__dirname, "..");
const FLUSH_TIMEOUT_MS = 10000;

/* ---------- Where everything is kept ---------- */

// The user-data folder is chosen BEFORE anything else touches the profile. The installed app always uses
// %APPDATA%\Invoisy (the same folder in every version, so the database is always found). Development uses a separate
// folder (Invoisy-Dev) so trying things out can never touch real business data. INVOISY_USER_DATA overrides both.
function chooseUserData() {
  const override = process.env.INVOISY_USER_DATA;
  if (override && path.isAbsolute(override)) return override;
  return path.join(app.getPath("appData"), IS_DEV ? "Invoisy-Dev" : "Invoisy");
}

app.setName("Invoisy");
app.setPath("userData", chooseUserData());
const USER_DATA = app.getPath("userData");
const PATHS = {
  userData: USER_DATA,
  backups: path.join(USER_DATA, "backups"),
  logs: path.join(USER_DATA, "logs"),
  documents: (() => { try { return app.getPath("documents"); } catch { return USER_DATA; } })(),
};
const log = createLogger(PATHS.logs);
const backup = new BackupManager({ dir: PATHS.backups, log });

// Must happen before the app is ready.
protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let mainWindow = null;
let rendererReady = false;     // the page has said it can write a waiting backup before closing
let closeApproved = false;
let closing = false;

/* ---------- Window ---------- */

function iconPath() {
  const file = path.join(APP_ROOT, "build", process.platform === "win32" ? "icon.ico" : "icon.png");
  return fs.existsSync(file) ? file : undefined;
}

function isExternalUrl(url) {
  try { return ["https:", "http:", "mailto:"].includes(new URL(url).protocol); } catch { return false; }
}

function showFatal(title, detail) {
  log.error(title, detail);
  try {
    dialog.showMessageBoxSync({
      type: "error", title: "Invoisy", message: title,
      detail: `${detail}\n\nYour data has not been changed or deleted. It is kept in:\n${PATHS.userData}`,
      buttons: ["OK"],
    });
  } catch { /* nothing more can be done */ }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1366,
    height: 860,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    title: "Invoisy",
    backgroundColor: "#ffffff",
    icon: iconPath(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: IS_DEV,
      spellcheck: false,
      navigateOnDragDrop: false,
    },
  });
  mainWindow = win;
  rendererReady = false;
  closeApproved = false;
  closing = false;

  win.once("ready-to-show", () => {
    win.show();
    if (OPEN_DEVTOOLS) win.webContents.openDevTools({ mode: "detach" });
  });

  // Links and new windows: the page never opens another Electron window. A web link goes to the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) shell.openExternal(url).catch((e) => log.warn("openExternal failed", e));
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    if (isExternalUrl(url)) shell.openExternal(url).catch((e) => log.warn("openExternal failed", e));
  });
  if (IS_DEV) {
    win.webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") return;
      if (input.key === "F12" || (input.control && input.shift && input.key.toLowerCase() === "i")) win.webContents.toggleDevTools();
    });
  }

  // The page asks before it is left with typed work that is not saved (beforeunload). On a normal close the page has
  // already asked and the person agreed, so that second question is skipped; on a reload it is asked here.
  win.webContents.on("will-prevent-unload", (event) => {
    if (closeApproved) { event.preventDefault(); return; }
    const choice = dialog.showMessageBoxSync(win, {
      type: "question", title: "Invoisy", buttons: ["OK", "Cancel"], defaultId: 1, cancelId: 1,
      message: "Leave this page? / Quitter cette page ?",
      detail: "Work you typed and did not save will be lost. / Le travail non enregistré sera perdu.",
    });
    if (choice === 0) event.preventDefault();
  });

  win.webContents.on("did-fail-load", (_e, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;   // -3: a load that was cancelled by another navigation
    showFatal("Invoisy could not load its window.", `${description} (${code}) ${url}`);
    app.quit();
  });
  win.webContents.on("render-process-gone", (_e, details) => {
    log.error("render-process-gone", details);
    const choice = dialog.showMessageBoxSync(win, {
      type: "error", title: "Invoisy", message: "Invoisy stopped working.",
      detail: `The window closed unexpectedly (${details.reason}). Your data is kept in the application's storage and was not changed.`,
      buttons: ["Reopen Invoisy", "Quit"], defaultId: 0, cancelId: 1,
    });
    if (choice === 0) win.reload(); else { closeApproved = true; app.quit(); }
  });

  // Closing: let the page write a backup that is still waiting (a change made a moment ago), then close.
  win.on("close", (event) => {
    if (closeApproved) return;
    if (!rendererReady || win.webContents.isCrashed() || win.webContents.isDestroyed()) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    const finish = () => { closeApproved = true; if (!win.isDestroyed()) win.close(); };
    const onDone = (_e, proceed) => {
      clearTimeout(timer);
      ipcMain.removeListener(ipc.CH.flushDone, onDone);
      if (proceed === false) { closing = false; return; }   // the person chose to stay (unsaved work on screen)
      finish();
    };
    const timer = setTimeout(() => {
      ipcMain.removeListener(ipc.CH.flushDone, onDone);
      log.warn("closing without waiting for the last backup (time limit)");
      finish();
    }, FLUSH_TIMEOUT_MS);
    ipcMain.on(ipc.CH.flushDone, onDone);
    win.webContents.send(ipc.CH.flushRequest);
  });
  win.on("closed", () => { if (mainWindow === win) mainWindow = null; });

  win.loadURL(`${ORIGIN}/index.html`).catch((e) => { if (e && e.code !== "ERR_ABORTED") log.error("loadURL failed", e); });
  return win;
}

/* ---------- Start ---------- */

if (!app.requestSingleInstanceLock()) {
  // Two copies on the same profile could damage the database, so a second launch only brings the first one forward.
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.on("web-contents-created", (_e, contents) => {
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });

  app.whenReady().then(async () => {
    try {
      app.setAppUserModelId("com.invoisy.desktop");
      Menu.setApplicationMenu(null);

      protocol.handle(SCHEME, createHandler({ root: APP_ROOT }));

      // The page asks for nothing but its own storage. Everything else (camera, location, notifications...) is refused.
      const allowed = new Set(["persistent-storage"]);
      session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)));
      session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));

      await backup.cleanTemp();
      // A copy of the raw database files, made before the window opens them (see profile-snapshot.js).
      await snapshotProfile({ userData: USER_DATA, log });
      ipc.register({
        ipcMain, dialog, shell, app, backup, log, paths: PATHS,
        getWindow: () => mainWindow,
      });
      ipcMain.on(ipc.CH.flushReady, (event) => { if (mainWindow && event.sender === mainWindow.webContents) rendererReady = true; });

      log.info("starting", { version: app.getVersion(), packaged: app.isPackaged, userData: USER_DATA });
      createWindow();
    } catch (e) {
      showFatal("Invoisy could not start.", (e && e.stack) || String(e));
      app.quit();
    }
  });

  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0 && app.isReady()) createWindow(); });
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
}

process.on("uncaughtException", (e) => log.error("uncaughtException", e));
process.on("unhandledRejection", (e) => log.error("unhandledRejection", e));

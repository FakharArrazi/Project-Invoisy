"use strict";

// The Electron integration's configuration: security settings, the installer, and the promises made about data.
// These read the real files, so a later edit that weakens one of them fails here.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const pkg = JSON.parse(read("package.json"));
const main = read("electron", "main.js");
const preload = read("electron", "preload.js");
const ipc = read("electron", "ipc-handlers.js");

test("the window is locked down: context isolation, no Node in the page, sandbox, no dev tools in the installed app", () => {
  assert.match(main, /contextIsolation: true/);
  assert.match(main, /nodeIntegration: false/);
  assert.match(main, /sandbox: true/);
  assert.match(main, /webSecurity: true/);
  assert.match(main, /devTools: IS_DEV/);
  assert.match(main, /const IS_DEV = !app\.isPackaged/);
  assert.doesNotMatch(main, /nodeIntegration: true|contextIsolation: false|sandbox: false|webSecurity: false|enableRemoteModule/);
  assert.match(main, /setWindowOpenHandler/);
  assert.match(main, /will-navigate/);
  assert.match(main, /requestSingleInstanceLock/);
  assert.match(main, /Menu\.setApplicationMenu\(null\)/);
  assert.match(main, /registerSchemesAsPrivileged/);
  assert.match(main, /standard: true, secure: true/);
});

test("the page gets only a small, frozen list of operations: no Node, no file paths, no generic IPC", () => {
  assert.match(preload, /contextBridge\.exposeInMainWorld\("invoisyDesktop"/);
  assert.match(preload, /Object\.freeze/);
  assert.doesNotMatch(preload, /require\((?!"electron")/, "the preload only needs electron");
  assert.doesNotMatch(preload, /exposeInMainWorld\([^)]*ipcRenderer/, "ipcRenderer itself is never handed to the page");
  assert.doesNotMatch(preload, /(?<![\w.])fs\b|child_process|shell\./);
  // every channel the preload can call is handled by the main process, and every handler checks who is calling
  const channels = [...preload.matchAll(/"(invoisy:[a-z:-]+)"/g)].map((m) => m[1]);
  assert.ok(channels.length >= 10);
  for (const c of new Set(channels)) assert.ok(ipc.includes(`"${c}"`), `${c} is known to ipc-handlers.js`);
  assert.match(ipc, /isAppUrl\(frame\.url\)/);
  assert.match(ipc, /refused a call from an untrusted page/);
});

test("package.json: start / dev / build / test scripts, and the existing test script is kept", () => {
  assert.equal(pkg.main, "electron/main.js");
  assert.equal(pkg.scripts.start, "electron .");
  assert.match(pkg.scripts.dev, /^electron \./);
  assert.match(pkg.scripts.build, /electron-builder/);
  assert.match(pkg.scripts.build, /--win/);
  assert.match(pkg.scripts.build, /nsis/);
  assert.match(pkg.scripts.build, /x64/);
  assert.equal(pkg.scripts.test, 'node --test "tests/*.test.js"');
  assert.ok(pkg.devDependencies.electron && pkg.devDependencies["electron-builder"] && pkg.devDependencies["fake-indexeddb"]);
  assert.equal(pkg.dependencies, undefined, "nothing but Electron's own runtime is shipped");
  assert.ok(fs.existsSync(path.join(ROOT, pkg.main)));
});

test("installer: a traditional NSIS wizard, a stable app id, shortcuts, and an uninstaller that keeps the data", () => {
  const b = pkg.build;
  assert.equal(b.appId, "com.invoisy.desktop", "the app id must never change (updates and the uninstall entry depend on it)");
  assert.equal(b.productName, "Invoisy");
  assert.equal(b.directories.output, "release");
  assert.deepEqual(b.win.target, [{ target: "nsis", arch: ["x64"] }]);
  assert.equal(b.nsis.oneClick, false);
  assert.equal(b.nsis.allowToChangeInstallationDirectory, true);
  assert.equal(b.nsis.createDesktopShortcut, true);
  assert.equal(b.nsis.createStartMenuShortcut, true);
  assert.equal(b.nsis.deleteAppDataOnUninstall, false);
  assert.equal(b.nsis.artifactName, "Invoisy Setup ${version}.${ext}");
  assert.equal(b.publish, null, "building never uploads anything");
  assert.ok(pkg.author && pkg.author.name);
  for (const icon of [b.win.icon, b.nsis.installerIcon, b.nsis.uninstallerIcon]) assert.ok(fs.existsSync(path.join(ROOT, icon)), icon);
  assert.ok(fs.statSync(path.join(ROOT, "build", "icon.ico")).size > 1000);
});

test("packaging includes the application and excludes tests, docs, git files and development files", () => {
  const files = pkg.build.files;
  for (const needed of ["electron/**/*", "index.html", "css/**/*", "java script/**/*", "package.json"]) assert.ok(files.includes(needed), needed);
  for (const f of files) assert.doesNotMatch(f, /tests|docs|\.git|node_modules|release/);
  assert.equal(pkg.build.asar, true);
  // every file index.html loads is covered by the packaged file list
  const html = read("index.html");
  for (const m of html.matchAll(/(?:src|href)="((?:java script|css)\/[^"]+)"/g)) {
    assert.ok(fs.existsSync(path.join(ROOT, m[1])), m[1]);
    assert.ok(/^java script\/|^css\//.test(m[1]));
  }
});

test("user data lives outside the installation: %APPDATA%\\Invoisy, a separate development folder, never the app folder", () => {
  assert.match(main, /app\.getPath\("appData"\)/);
  assert.match(main, /IS_DEV \? "Invoisy-Dev" : "Invoisy"/);
  assert.match(main, /app\.setPath\("userData"/);
  assert.match(main, /path\.join\(USER_DATA, "backups"\)/);
  assert.doesNotMatch(main, /process\.resourcesPath|app\.getAppPath\(\)[^;]*userData|__dirname[^;]*backups/);
  // the profile folder is chosen before anything else uses it
  assert.ok(main.indexOf('app.setPath("userData"') < main.indexOf("app.whenReady"));
  assert.ok(main.indexOf("registerSchemesAsPrivileged") < main.indexOf("app.whenReady"));
});

test("the page still works in a browser: the bridge is optional and index.html loads it before script.js", () => {
  const html = read("index.html");
  const order = ["java script/database.js", "java script/autobackup.js", "java script/desktop-bridge.js", "java script/script.js"].map((s) => html.indexOf(`src="${s}"`));
  assert.ok(order.every((i) => i > 0) && order.every((v, i) => i === 0 || v > order[i - 1]), "database.js, autobackup.js, desktop-bridge.js, script.js in that order");
  const bridge = read("java script", "desktop-bridge.js");
  assert.match(bridge, /isDesktop: false/);
  assert.doesNotMatch(bridge, /require\(|process\./);
});

test("the database is untouched: same name and version, and no second database or SQLite anywhere", () => {
  const db = read("java script", "database.js");
  assert.match(db, /const DB_NAME = "invoisy";/);
  assert.match(db, /const DB_VERSION = 6;/);
  for (const dir of ["electron", "java script"]) {
    for (const f of fs.readdirSync(path.join(ROOT, dir))) {
      if (!f.endsWith(".js")) continue;
      assert.doesNotMatch(read(dir, f), /sqlite|better-sqlite3|\bsql\.js\b|mysql|postgres|mongodb|\bnedb\b|\blowdb\b/i, `${dir}/${f}`);
    }
  }
});

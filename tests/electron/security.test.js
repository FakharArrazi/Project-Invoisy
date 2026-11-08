"use strict";

// The real desktop application's boundary: what the page can reach, what it can not, and that it works with no network.

const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { tempDir, remove, launch, closeAll, goTo, until, sleep, waitForReady, ROOT } = require("./helpers");

afterEach(closeAll);

test("the page is isolated: no Node.js, no Electron, one frozen bridge with only the listed operations", async () => {
  const userData = tempDir("sec1");
  try {
    const run = await launch(userData);
    const seen = await run.page.evaluate(() => ({
      require: typeof require, process: typeof process, Buffer: typeof Buffer, module: typeof module, electron: typeof electron, ipc: typeof ipcRenderer,
      top: Object.keys(window.invoisyDesktop).sort(),
      frozen: Object.isFrozen(window.invoisyDesktop) && Object.isFrozen(window.invoisyDesktop.backup) && Object.isFrozen(window.invoisyDesktop.files),
      backup: Object.keys(window.invoisyDesktop.backup).sort(),
      files: Object.keys(window.invoisyDesktop.files).sort(),
      url: location.href,
    }));
    assert.deepEqual([seen.require, seen.process, seen.Buffer, seen.module, seen.electron, seen.ipc], ["undefined", "undefined", "undefined", "undefined", "undefined", "undefined"]);
    assert.deepEqual(seen.top, ["backup", "files", "info", "isDesktop", "onBeforeClose", "print"]);
    assert.deepEqual(seen.backup, ["latest", "openFolder", "read", "saveSafety", "status", "write"]);
    assert.deepEqual(seen.files, ["openAttachment", "openBackup", "saveAttachment", "saveText"]);
    assert.equal(seen.frozen, true);
    assert.equal(seen.url, "app://invoisy/index.html");
    const prefs = await run.app.evaluate(({ BrowserWindow }) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      const p = wc.getLastWebPreferences();
      return { contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration, sandbox: p.sandbox, webSecurity: p.webSecurity, nodeIntegrationInWorker: !!p.nodeIntegrationInWorker, nodeIntegrationInSubFrames: !!p.nodeIntegrationInSubFrames };
    });
    assert.deepEqual(prefs, { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false });
    assert.equal(run.pageErrors.length, 0, run.pageErrors.join("; "));
  } finally { await closeAll(); remove(userData); }
});

test("only the application's pages are served: its own source is reachable, nothing else in the project or on the network is", async () => {
  const userData = tempDir("sec2");
  try {
    const run = await launch(userData);
    const results = await run.page.evaluate(async () => {
      const status = async (u) => { try { return (await fetch(u)).status; } catch { return "blocked"; } };
      return {
        script: await status("app://invoisy/java%20script/script.js"),
        main: await status("app://invoisy/electron/main.js"),
        pkg: await status("app://invoisy/package.json"),
        traversal: await status("app://invoisy/css/..%2f..%2fpackage.json"),
        tests: await status("app://invoisy/tests/helpers/app.js"),
        remote: await status("https://example.com/"),
        file: await status("file:///etc/hostname"),
      };
    });
    assert.equal(results.script, 200);
    for (const k of ["main", "pkg", "traversal", "tests"]) assert.ok(results[k] === 404 || results[k] === 403 || results[k] === "blocked", `${k}: ${results[k]}`);
    assert.equal(results.remote, "blocked", "the page can not talk to the internet");
    assert.equal(results.file, "blocked");
  } finally { await closeAll(); remove(userData); }
});

test("the Content-Security-Policy is enforced: no string-eval, no injected inline script, no remote image", async () => {
  const userData = tempDir("sec3");
  try {
    const run = await launch(userData);
    const r = await run.page.evaluate(async () => {
      const violations = [];
      document.addEventListener("securitypolicyviolation", (e) => violations.push(e.violatedDirective));
      window.__t = 0;
      window.__injected = false;
      setTimeout("window.__t = 1", 0);                      // code from a string: eval
      const s = document.createElement("script");           // an inline script added after load
      s.textContent = "window.__injected = true";
      document.body.appendChild(s);
      const img = new Image();                              // a remote image
      img.src = "https://example.com/x.png";
      await new Promise((r) => setTimeout(r, 300));
      const csp = (await fetch(location.href)).headers.get("content-security-policy");
      return { timerRan: window.__t, injected: window.__injected, violations, csp };
    });
    assert.equal(r.timerRan, 0);
    assert.equal(r.injected, false);
    for (const d of ["script-src", "script-src-elem", "img-src"]) assert.ok(r.violations.includes(d), `${d} was enforced: ${r.violations}`);
    assert.match(r.csp, /default-src 'none'/);
    assert.doesNotMatch(r.csp, /unsafe-eval/);
  } finally { await closeAll(); remove(userData); }
});

test("links never open another application window: a web address goes to the default browser, and the page itself never leaves app://invoisy", async () => {
  const userData = tempDir("sec4");
  try {
    const run = await launch(userData);
    await run.app.evaluate(({ shell }) => { globalThis.__opened = []; shell.openExternal = async (u) => { globalThis.__opened.push(u); }; });
    const opened = await run.page.evaluate(() => window.open("https://example.com/docs", "_blank"));
    assert.equal(opened, null, "window.open gives the page no window");
    await run.page.evaluate(() => { location.href = "https://example.org/away"; });
    await sleep(500);
    await run.page.evaluate(() => window.open("javascript:alert(1)"));
    await run.page.evaluate(() => window.open("file:///etc/passwd"));
    await sleep(300);
    const calls = await run.app.evaluate(() => globalThis.__opened);
    assert.deepEqual(calls.sort(), ["https://example.com/docs", "https://example.org/away"].sort(), "only web addresses were handed to the browser");
    assert.equal(run.app.windows().length, 1);
    assert.equal(await run.page.evaluate(() => location.href), "app://invoisy/index.html");
  } finally { await closeAll(); remove(userData); }
});

test("a page from anywhere else can not use the bridge: calls from outside app://invoisy are refused", async () => {
  const userData = tempDir("sec5");
  try {
    const run = await launch(userData);
    // A second window with the same preload but another origin.
    await run.app.evaluate(async ({ BrowserWindow }, preload) => {
      const w = new BrowserWindow({ show: false, webPreferences: { preload, contextIsolation: true, sandbox: true } });
      globalThis.__other = w;
      await w.loadURL("data:text/html,<title>other</title><p>not the app</p>");
    }, path.join(ROOT, "electron", "preload.js"));
    const other = await until(() => run.app.windows().find((w) => w.url().startsWith("data:")), 10000, "the second window");
    const outcome = await other.evaluate(async () => {
      try { await window.invoisyDesktop.backup.write("{}"); return "allowed"; } catch (e) { return "refused: " + e.message; }
    });
    assert.match(outcome, /^refused/);
    const read = await other.evaluate(async () => { try { return await window.invoisyDesktop.backup.read(); } catch (e) { return "refused"; } });
    assert.equal(read, "refused");
    // and the real page still can
    assert.equal((await run.page.evaluate(() => window.invoisyDesktop.backup.read())).ok, true);
  } finally { await closeAll(); remove(userData); }
});

test("offline: every request while using the application is local (app://), none goes to the network, and no permission is granted", async () => {
  const userData = tempDir("sec6");
  try {
    const run = await launch(userData);
    await run.app.evaluate(({ session }) => {
      globalThis.__requests = [];
      session.defaultSession.webRequest.onBeforeRequest((details, cb) => { globalThis.__requests.push(details.url); cb({}); });
    });
    await run.page.reload();
    await waitForReady(run.page);
    for (const view of ["sell", "stock", "purchases", "dashboard", "settings"]) { try { await goTo(run.page, view); } catch { /* a view this build does not have */ } }
    const urls = await run.app.evaluate(() => globalThis.__requests);
    assert.ok(urls.length > 10, "the page loaded its files");
    const foreign = urls.filter((u) => !/^(app:\/\/invoisy\/|data:|blob:|devtools:)/.test(u));
    assert.deepEqual(foreign, [], "nothing outside the application was requested");
    const perms = await run.page.evaluate(async () => ({
      notification: await Notification.requestPermission(),
      geo: await new Promise((res) => navigator.geolocation.getCurrentPosition(() => res("granted"), () => res("denied"))),
      persisted: await navigator.storage.persisted(),
    }));
    assert.equal(perms.notification, "denied");
    assert.equal(perms.geo, "denied");
    assert.equal(perms.persisted, true, "the browser may not evict the database");
  } finally { await closeAll(); remove(userData); }
});

test("a second copy of Invoisy only brings the first one forward: two copies can never open the same database", async () => {
  const userData = tempDir("sec7");
  try {
    const run = await launch(userData);
    const electronPath = require("electron");
    const second = spawn(electronPath, [ROOT, ...(process.getuid && process.getuid() === 0 ? ["--no-sandbox"] : [])], { env: { ...process.env, INVOISY_USER_DATA: userData }, stdio: "ignore" });
    const code = await new Promise((resolve) => { second.on("exit", resolve); setTimeout(() => { second.kill("SIGKILL"); resolve("still running"); }, 30000); });
    assert.equal(code, 0, "the second copy exited by itself");
    assert.equal(run.app.windows().length, 1);
    await waitForReady(run.page);
  } finally { await closeAll(); remove(userData); }
});

test("the user-data folder is the one chosen, outside the application's own folder", async () => {
  const userData = tempDir("sec8");
  try {
    const run = await launch(userData);
    const info = await run.app.evaluate(({ app }) => ({ userData: app.getPath("userData"), name: app.getName(), packaged: app.isPackaged }));
    assert.equal(info.userData, userData);
    assert.equal(info.name, "Invoisy");
    assert.ok(!info.userData.startsWith(ROOT));
    assert.equal(await run.page.title(), "Invoisy");
  } finally { await closeAll(); remove(userData); }
});

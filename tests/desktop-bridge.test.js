"use strict";

// The desktop application as far as it can be tested without a window: the real page scripts (script.js, database.js,
// autobackup.js), the real java script/desktop-bridge.js, and the real electron/backup-manager.js writing to a real
// temporary folder, connected the way preload.js and ipc-handlers.js connect them. Windows dialogs are replaced by
// stand-ins. A running Electron window is covered by tests/electron/ (npm run test:electron).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { loadApp } = require("./helpers/app");
const { addTile } = require("./helpers/edit");
const { populate, summarize } = require("./helpers/sample-business");
const { BackupManager } = require("../electron/backup-manager");

const BRIDGE_SOURCE = fs.readFileSync(path.join(__dirname, "..", "java script", "desktop-bridge.js"), "utf8");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "invoisy-desk-"));
const listDir = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);   // a folder is made by the first write

// What preload.js + ipc-handlers.js give the page, on top of a real BackupManager.
function makeDesktop(dir) {
  const manager = new BackupManager({ dir: path.join(dir, "backups") });
  const control = { failWrite: null, saved: [], nextOpen: null, saveCanceled: false, writes: 0 };
  const asResult = async (fn) => { try { return { ok: true, ...(await fn()) }; } catch (e) { return { ok: false, code: e.code || "ERROR", message: e.message }; } };
  const api = {
    isDesktop: true,
    info: async () => ({ ok: true, backupFolder: manager.dir, version: "1.0.0", platform: "test", packaged: false }),
    backup: {
      write: (text) => asResult(async () => {
        control.writes++;
        if (control.failWrite) throw Object.assign(new Error(control.failWrite), { code: "WRITE" });
        const r = await manager.writeCurrent(text);
        return { bytes: r.bytes, revision: r.revision, unchanged: !!r.unchanged };
      }),
      read: () => asResult(async () => ({ text: await manager.readCurrent() })),
      latest: () => asResult(async () => ({ latest: await manager.latestValid() })),
      saveSafety: (text, name) => asResult(() => manager.saveSafety(text, name)),
      status: () => asResult(async () => ({ status: await manager.status() })),
      openFolder: async () => ({ ok: true }),
    },
    files: {
      saveText: async (text, name) => { control.saved.push({ text, name }); return control.saveCanceled ? { ok: true, canceled: true } : { ok: true, canceled: false, name }; },
      openBackup: async () => (control.nextOpen ? { ok: true, canceled: false, ...control.nextOpen } : { ok: true, canceled: true }),
      openAttachment: async () => ({ ok: true }),
      saveAttachment: async () => ({ ok: true, canceled: false }),
    },
    print: { toPdf: async () => ({ ok: true, canceled: true }) },
    onBeforeClose() {},
  };
  const context = vm.createContext({ invoisyDesktop: api, console });
  vm.runInContext(BRIDGE_SOURCE, context, { filename: "desktop-bridge.js" });
  return { bridge: context.DesktopBridge, manager, control };
}

// The page, started in the desktop way (the bridge present). `indexedDB` lets a test reopen the same database.
async function startPage(desktop, options) {
  const app = loadApp({ globals: { DesktopBridge: desktop.bridge, window: { print() {}, addEventListener() {} } }, ...(options || {}) });
  const storage = await app.start();
  assert.equal(storage.mode, "ready", storage.reason);
  return app;
}

const settle = async (check, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return true; await new Promise((r) => setTimeout(r, 10)); }
  return false;
};

test("in a browser the bridge does nothing: isDesktop is false and the page keeps its own file-picker backup", () => {
  const context = vm.createContext({});
  vm.runInContext(BRIDGE_SOURCE, context);
  assert.deepEqual({ ...context.DesktopBridge }, { isDesktop: false });
});

test("the bridge's file handle is a handle autobackup.js accepts, with nothing to choose or grant", async () => {
  const dir = tmp();
  try {
    const { bridge } = makeDesktop(dir);
    const h = bridge.handle;
    assert.equal(h.kind, "file");
    assert.equal(h.name, "invoisy-data.json");
    assert.equal(typeof h.getFile, "function");
    assert.equal(typeof h.createWritable, "function");
    assert.equal(await h.queryPermission(), "granted");
    assert.equal(await h.requestPermission(), "granted");
    const o = bridge.autoBackupOptions();
    assert.equal(o.supported, true);
    assert.equal(await o.handleStore.get(), h);
    assert.equal(await o.pickFile(), h);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("first launch: the backup folder is created, the first backup is written and verified, and the settings panel says so", async () => {
  const dir = tmp();
  try {
    const desktop = makeDesktop(dir);
    const app = await startPage(desktop);
    await app.api.autoBackup.start();   // the page starts it without waiting; the test waits for the first check to finish
    await app.api.autoBackup.flushNow();
    const status = app.api.autoBackup.getStatus();
    assert.equal(status.connected, true);
    assert.equal(status.state, "current");
    assert.equal(status.fileName, "invoisy-data.json");
    assert.equal(fs.existsSync(path.join(dir, "backups", "invoisy-data.json")), true);
    for (const sub of ["daily", "weekly", "safety", "archive"]) assert.equal(fs.existsSync(path.join(dir, "backups", sub)), true, sub);
    await desktop.bridge.ready;
    app.api.renderAutoBackup();
    assert.match(app.field("autoNote").textContent, new RegExp(path.join(dir, "backups").replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")));
    assert.equal(app.field("autoChoose").textContent, "Open backup folder");
    assert.equal(app.field("autoReplace").hidden, true);
    assert.equal(app.field("autoGrant").hidden, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("every committed change reaches the backup file, which holds the whole database, with its revision", async () => {
  const dir = tmp();
  try {
    const desktop = makeDesktop(dir);
    const app = await startPage(desktop);
    await populate({ api: app.api });
    const onDisk = await desktop.manager.readCurrent();
    const snapshot = await app.api.db.loadAll({ withAttachments: true });
    const parsed = app.api.autoBackup && require("vm").runInThisContext("Validation").parseBackup(onDisk);
    assert.equal(parsed.error, undefined, parsed.error);
    const s = summarize(onDisk);
    assert.equal(JSON.parse(onDisk).revision, snapshot.revision);
    assert.deepEqual(s.counts, { products: 2, invoices: 2, suppliers: 2, purchases: 2, supplierPayments: 1, attachments: 0, supplierDeposits: 1, advanceAllocations: 1, workers: 1, workerTransactions: 2 });
    assert.equal(s.paidOnInvoices, 22000);
    assert.equal(s.remainingOnInvoices, 15000);
    assert.equal(s.deposits, 50000);
    assert.equal(s.advanceAllocations, 30000);
    assert.equal(s.workerPayments, 40000);
    assert.equal(app.api.autoBackup.getStatus().state, "current");
    // the previous backup is one state behind
    assert.ok(fs.existsSync(path.join(dir, "backups", "invoisy-data.previous.json")));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the backup starts only after a transaction commits: a refused change is never written", async () => {
  const dir = tmp();
  try {
    const desktop = makeDesktop(dir);
    const app = await startPage(desktop);
    await app.api.autoBackup.flushNow();
    const writesBefore = desktop.control.writes;
    const refused = await app.api.commit(() => ({ error: "nothing may be saved" }));
    assert.equal(refused.error, "nothing may be saved");
    await app.api.autoBackup.flushNow();
    assert.equal(desktop.control.writes, writesBefore, "an aborted change did not cause a backup");
    await addTile({ api: app.api }, { name: "Committed" });
    await app.api.autoBackup.flushNow();
    assert.ok(desktop.control.writes > writesBefore);
    assert.match(await desktop.manager.readCurrent(), /Committed/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a failing backup never damages the database or the last valid backup, says what happened, and recovers by itself", async () => {
  const dir = tmp();
  try {
    const desktop = makeDesktop(dir);
    const app = await startPage(desktop);
    await addTile({ api: app.api }, { name: "Before" });
    await app.api.autoBackup.flushNow();
    const good = await desktop.manager.readCurrent();
    assert.match(good, /Before/);

    desktop.control.failWrite = "There is not enough space on the disk.";
    await addTile({ api: app.api }, { name: "During" });
    await app.api.autoBackup.flushNow();
    const s = app.api.autoBackup.getStatus();
    assert.equal(s.state, "error");
    assert.match(s.error, /backup folder/);
    assert.match(s.error, /not enough space/);
    assert.match(s.error, /safe in Invoisy's database/);
    assert.equal(await desktop.manager.readCurrent(), good, "the last valid backup is untouched");
    const inDb = (await app.api.db.loadAll()).products.map((p) => p.name).sort();
    assert.deepEqual(inDb, ["Before", "During"], "the database kept the change");
    assert.equal(app.api.autoBackup.getStatus().attention, true, "the top-bar reminder asks for attention");

    desktop.control.failWrite = null;
    const after = await app.api.autoBackup.retry();
    assert.equal(after.state, "current");
    assert.match(await desktop.manager.readCurrent(), /During/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("Export Backup: a native Save dialog; closing it records nothing, saving it records the backup date and writes a complete file", async () => {
  const dir = tmp();
  try {
    const desktop = makeDesktop(dir);
    const app = await startPage(desktop);
    await populate({ api: app.api });
    desktop.control.saveCanceled = true;
    await app.api.exportBackup();
    assert.equal(desktop.control.saved.length, 1);
    assert.equal(app.api.getStorage().backup.lastBackupAt, null, "a closed dialog is not a backup");
    desktop.control.saveCanceled = false;
    await app.api.exportBackup();
    assert.equal(desktop.control.saved.length, 2);
    assert.match(desktop.control.saved[1].name, /^invoisy-backup-\d{4}-\d{2}-\d{2}\.json$/);
    assert.ok(app.api.getStorage().backup.lastBackupAt);
    const s = summarize(desktop.control.saved[1].text);
    assert.equal(s.counts.invoices, 2);
    assert.equal(s.counts.workerTransactions, 2);
    assert.equal(s.paidToSuppliers, 15000);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("restore: a backup made on one computer restores into an empty desktop database with the same counts, totals and invoice numbers", async () => {
  const dir = tmp();
  const dir2 = tmp();
  try {
    const a = makeDesktop(dir);
    const first = await startPage(a);
    await populate({ api: first.api });
    const original = await a.manager.readCurrent();
    const expected = summarize(original);

    const b = makeDesktop(dir2);
    const second = await startPage(b);
    // The picked file reaches the page through the Open dialog stand-in; no safety copy is needed for an empty database.
    b.control.nextOpen = { name: "from-another-pc.json", text: original };
    await second.api.chooseBackupToImport();
    assert.equal(await settle(() => second.api.getState().products.length === 2), true, second.errorText("dataError") || second.toast());
    await second.api.autoBackup.flushNow();
    const got = summarize(await b.manager.readCurrent());
    for (const key of ["counts", "invoiceNumbers", "invoiceCounter", "purchaseCounter", "stockTotal", "paidOnInvoices", "remainingOnInvoices", "paidToSuppliers", "deposits", "advanceAllocations", "workerPayments"]) {
      assert.deepEqual(got[key], expected[key], key);
    }
    assert.deepEqual(got.data.invoices, expected.data.invoices, "invoices are restored exactly, line for line");
    assert.deepEqual(got.data.products, expected.data.products);
    assert.deepEqual(got.data.workerTransactions, expected.data.workerTransactions);
    assert.deepEqual(listDir(path.join(dir2, "backups", "safety")), [], "an empty database needs no safety copy");
    assert.equal(await settle(() => second.api.autoBackup.getStatus().state === "current", 5000), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(dir2, { recursive: true, force: true }); }
});

test("restore over existing data: a safety copy of the current data is saved first in the safety folder, and the data is then replaced", async () => {
  const dir = tmp();
  const dir2 = tmp();
  try {
    const a = makeDesktop(dir);
    const first = await startPage(a);
    await populate({ api: first.api });
    const source = await a.manager.readCurrent();

    const b = makeDesktop(dir2);
    const second = await startPage(b);
    await addTile({ api: second.api }, { name: "My existing tile", stock: 7 });
    const before = summarize((await (async () => { await second.api.autoBackup.flushNow(); return b.manager.readCurrent(); })()));
    b.control.nextOpen = { name: "older.json", text: source };
    await second.api.chooseBackupToImport();
    assert.equal(await settle(() => second.api.getState().products.length === 2), true, second.errorText("dataError"));
    const safety = listDir(path.join(dir2, "backups", "safety"));
    assert.equal(safety.length, 1);
    assert.match(safety[0], /^invoisy-before-restore-\d{4}-\d{2}-\d{2}-.*\.json$/);
    const kept = summarize(fs.readFileSync(path.join(dir2, "backups", "safety", safety[0]), "utf8"));
    assert.deepEqual(kept.counts, before.counts, "the safety copy holds the data that was replaced");
    assert.equal(kept.data.products[0].name, "My existing tile");
    assert.match(second.toast(), /Restore completed/);
    assert.match(second.toast(), /safety|saved as/i);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(dir2, { recursive: true, force: true }); }
});

test("restore refuses an invalid, foreign or damaged file and changes nothing: no safety copy, no data change, no backup written", async () => {
  const dir = tmp();
  try {
    const desktop = makeDesktop(dir);
    const app = await startPage(desktop);
    await addTile({ api: app.api }, { name: "Keep me", stock: 5 });
    await app.api.autoBackup.flushNow();
    const before = await desktop.manager.readCurrent();
    const revision = (await app.api.db.loadAll()).revision;
    const good = summarize(before);
    const bad = [
      "this is not json", "", "{}", JSON.stringify({ application: "Other", formatVersion: 2, data: {} }),
      before.slice(0, Math.floor(before.length / 2)),
      JSON.stringify({ ...JSON.parse(before), formatVersion: 99 }),
      JSON.stringify({ ...JSON.parse(before), data: { ...JSON.parse(before).data, invoices: [{ id: "x", invoiceNumber: "INV-000001", total: "lots" }] } }),
    ];
    for (const text of bad) {
      desktop.control.nextOpen = { name: "bad.json", text };
      app.answer(true);
      await app.api.chooseBackupToImport();
      await settle(() => app.errorText("dataError") !== "", 500);
      assert.equal((await app.api.db.loadAll()).revision, revision, "the database did not change");
      assert.deepEqual((await app.api.db.loadAll()).products.map((p) => p.name), ["Keep me"]);
      assert.deepEqual(listDir(path.join(dir, "backups", "safety")), []);
    }
    await app.api.autoBackup.flushNow();
    assert.deepEqual(summarize(await desktop.manager.readCurrent()).counts, good.counts);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a cancelled confirmation changes nothing", async () => {
  const dir = tmp();
  const dir2 = tmp();
  try {
    const a = makeDesktop(dir);
    const first = await startPage(a);
    await populate({ api: first.api });
    const source = await a.manager.readCurrent();
    const b = makeDesktop(dir2);
    const second = await startPage(b);
    await addTile({ api: second.api }, { name: "Mine" });
    b.control.nextOpen = { name: "x.json", text: source };
    second.answer(false);
    await second.api.chooseBackupToImport();
    await settle(() => second.confirms.length > 0, 500);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual((await second.api.db.loadAll()).products.map((p) => p.name), ["Mine"]);
    assert.deepEqual(listDir(path.join(dir2, "backups", "safety")), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(dir2, { recursive: true, force: true }); }
});

test("an empty database with a valid backup in the folder is offered the restore at start; agreeing restores it, and a database with data is never offered", async () => {
  const dir = tmp();
  try {
    const desktop = makeDesktop(dir);
    const first = await startPage(desktop);
    await populate({ api: first.api });
    const saved = await desktop.manager.readCurrent();
    const expected = summarize(saved);

    // The data store was lost (a brand new, empty database) but the backup folder survived.
    const second = await startPage(desktop);
    assert.equal(await settle(() => second.api.getState().products.length === 2), true, second.errorText("dataError"));
    assert.ok(second.confirms.some((m) => /database is empty/.test(m) && /automatic backup was found/.test(m)), "the person was asked, with the reason");
    assert.ok(second.confirms.some((m) => /REPLACE all the data/.test(m)));
    // the page brings the backup file in line with the restored data by itself (importBackup does not wait for it)
    assert.equal(await settle(() => second.api.autoBackup.getStatus().state === "current", 5000), true, "the backup is not stuck 'newer than the database' after a restore: " + second.api.autoBackup.getStatus().state);
    await second.api.autoBackup.flushNow();
    assert.deepEqual(summarize(await desktop.manager.readCurrent()).counts, expected.counts);
    assert.ok(listDir(path.join(dir, "backups", "archive")).some((f) => /^invoisy-newer-/.test(f)), "the older-numbered file was archived, not lost");

    // Same database reopened: it has data, so there is no offer.
    const third = await startPage(desktop, { indexedDB: second.indexedDB });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(third.confirms.length, 0);
    assert.equal(third.api.getState().products.length, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("declining the offer restores nothing and never overwrites the newer backup; 'Replace the newer backup' archives it first", async () => {
  const dir = tmp();
  try {
    const desktop = makeDesktop(dir);
    const first = await startPage(desktop);
    await populate({ api: first.api });
    const saved = await desktop.manager.readCurrent();

    const second = loadApp({ globals: { DesktopBridge: desktop.bridge, window: { print() {}, addEventListener() {} } } });
    second.answer(false);   // "No" to the restore offer
    await second.start();
    await settle(() => second.confirms.length > 0, 1000);
    await second.api.autoBackup.flushNow();
    assert.equal(second.api.getState().products.length, 0);
    assert.equal(await desktop.manager.readCurrent(), saved, "the newer backup was not overwritten by the empty database");
    const status = second.api.autoBackup.getStatus();
    assert.equal(status.state, "file-newer");
    assert.equal(status.attention, true);
    second.api.renderAutoBackup();
    assert.equal(second.field("autoReplace").hidden, false, "the Replace button is offered");

    second.answer(true);
    await second.api.replaceNewerBackup();
    assert.equal(second.api.autoBackup.getStatus().state, "current");
    const archived = listDir(path.join(dir, "backups", "archive"));
    assert.equal(archived.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, "backups", "archive", archived[0]), "utf8"), saved, "the newer backup is kept in the archive, byte for byte");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("Save as PDF is only offered by the desktop application and the Print button is unchanged", async () => {
  const dir = tmp();
  try {
    const app = await startPage(makeDesktop(dir));
    assert.equal(typeof app.api.saveInvoicePdf, "function");
    const browser = loadApp({ globals: { window: { print() {}, addEventListener() {} } } });
    await browser.start();
    assert.equal(browser.api.saveInvoicePdf(), undefined, "no PDF button logic runs in a browser");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

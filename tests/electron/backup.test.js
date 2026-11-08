"use strict";

// The real desktop application's backups: automatic copies after every change, a failing or unavailable backup folder,
// Export / Import through the Windows dialogs, invalid and older backups, closing right after a change, and the offer to
// restore when the database is found empty.

const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const { buildSampleBackup, summarize } = require("../helpers/sample-business");
const { tempDir, remove, launch, closeAll, addProduct, stubDialogs, snapshot, goTo, until, sleep } = require("./helpers");

afterEach(closeAll);

const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const names = (run) => run.page.evaluate(async () => (await db.loadAll()).products.map((p) => p.name).sort());
const autoState = (run) => run.page.evaluate(() => document.getElementById("autoStatus").className);

test("after every change the backup file in the application's folder is updated, with the previous one kept", async () => {
  const userData = tempDir("auto");
  try {
    const run = await launch(userData);
    const current = path.join(userData, "backups", "invoisy-data.json");
    const previous = path.join(userData, "backups", "invoisy-data.previous.json");
    await addProduct(run.page, "First", 10);
    await until(() => fs.existsSync(current) && /First/.test(fs.readFileSync(current, "utf8")), 10000, "the first backup");
    await addProduct(run.page, "Second", 10);
    await until(() => /Second/.test(fs.readFileSync(current, "utf8")), 10000, "the second backup");
    const cur = JSON.parse(fs.readFileSync(current, "utf8"));
    assert.equal(cur.application, "Invoisy");
    assert.equal(cur.counts.products, 2);
    assert.equal(cur.revision, (await snapshot(run.page)).revision, "the file carries the database revision");
    assert.equal(fs.existsSync(previous), true);
    assert.equal(JSON.parse(fs.readFileSync(previous, "utf8")).counts.products >= 1, true);
    assert.deepEqual(fs.readdirSync(path.join(userData, "backups", ".tmp")), [], "no temporary file is left behind");
    await goTo(run.page, "settings");
    await until(async () => (await autoState(run)) === "state-current", 5000, "status 'current'");
    assert.match(await run.page.textContent("#autoFile"), /invoisy-data\.json/);
  } finally { await closeAll(); remove(userData); }
});

test("an unavailable backup folder is reported, never touches the database or the last valid backup, and the backup catches up when it returns", async () => {
  const userData = tempDir("gone");
  try {
    const run = await launch(userData);
    const dir = path.join(userData, "backups");
    await addProduct(run.page, "Safe", 10);
    const current = path.join(dir, "invoisy-data.json");
    await until(() => fs.existsSync(current) && /Safe/.test(fs.readFileSync(current, "utf8")), 10000, "the first backup");
    const lastGood = sha(current);

    // The backup location disappears (a drive removed, a folder replaced by a file).
    fs.renameSync(dir, dir + "-away");
    fs.writeFileSync(dir, "this used to be the backup folder");
    await addProduct(run.page, "While away", 10);
    await goTo(run.page, "settings");
    await until(async () => (await autoState(run)) === "state-error", 20000, "the backup error");
    assert.deepEqual(await names(run), ["Safe", "While away"], "the database kept the change");
    assert.equal(sha(path.join(dir + "-away", "invoisy-data.json")), lastGood, "the last valid backup was not touched");
    const reminder = await run.page.evaluate(() => document.getElementById("backupReminder").textContent);
    assert.ok(reminder.length > 0);
    assert.match(fs.readFileSync(path.join(userData, "logs", "invoisy.log"), "utf8"), /ERROR invoisy:backup:(read|write)/, "the failure is in the log");

    // The folder is back: the pending backup is written.
    fs.rmSync(dir);
    fs.renameSync(dir + "-away", dir);
    await run.page.evaluate(() => autoBackup.retry());
    await until(() => /While away/.test(fs.readFileSync(current, "utf8")), 20000, "the pending backup");
    await until(async () => (await autoState(run)) === "state-current", 5000, "status 'current' again");
    assert.deepEqual(await names(run), ["Safe", "While away"]);
  } finally { await closeAll(); remove(userData); }
});

test("Export Backup: the Windows Save dialog; cancelling writes nothing, saving writes a complete portable file", async () => {
  const userData = tempDir("export");
  const out = tempDir("export-out");
  try {
    const sample = await buildSampleBackup();
    const input = path.join(out, "in.json");
    fs.writeFileSync(input, sample);
    const run = await launch(userData);
    await stubDialogs(run.app, { open: input });
    await goTo(run.page, "settings");
    await run.page.click("#importBackup");
    await until(async () => (await names(run)).length === 2, 20000, "the restore");

    const target = path.join(out, "my-export.json");
    await stubDialogs(run.app, { save: null });
    await run.page.click("#exportBackup");
    await sleep(500);
    assert.equal(fs.existsSync(target), false);
    assert.equal((await run.page.evaluate(() => db.getBackupInfo())).lastBackupAt, null, "a cancelled Save dialog is not a backup");

    await stubDialogs(run.app, { save: target });
    await run.page.click("#exportBackup");
    await until(() => fs.existsSync(target), 15000, "the exported file");
    const exported = fs.readFileSync(target, "utf8");
    const a = summarize(sample);
    const b = summarize(exported);
    assert.deepEqual(b.counts, a.counts);
    assert.deepEqual(b.invoiceNumbers, a.invoiceNumbers);
    assert.equal(b.paidOnInvoices, a.paidOnInvoices);
    assert.equal(b.remainingOnInvoices, a.remainingOnInvoices);
    assert.deepEqual(b.data.invoices, a.data.invoices);
    assert.ok((await run.page.evaluate(() => db.getBackupInfo())).lastBackupAt, "the backup date is recorded only now");
    assert.deepEqual(fs.readdirSync(out).filter((f) => f.endsWith(".tmp")), []);
  } finally { await closeAll(); remove(userData); remove(out); }
});

test("Import: an older backup replaces the data after a safety copy is saved, and an invalid or damaged file is refused without any change", async () => {
  const userData = tempDir("import");
  const work = tempDir("import-files");
  try {
    const run = await launch(userData);
    await addProduct(run.page, "Alpha", 5);
    await until(() => fs.existsSync(path.join(userData, "backups", "invoisy-data.json")), 10000, "backup");
    // an older state, exported by the page itself
    const older = path.join(work, "older.json");
    fs.writeFileSync(older, await run.page.evaluate(async () => Validation.prepareBackupFile(await db.loadAll({ withAttachments: true }), new Date()).text));
    await addProduct(run.page, "Beta", 5);
    await addProduct(run.page, "Gamma", 5);
    const before = await snapshot(run.page);

    // invalid / damaged files: refused, nothing changes
    const good = fs.readFileSync(older, "utf8");
    const bad = {
      "not-json.json": "this is not a backup",
      "empty.json": "",
      "foreign.json": JSON.stringify({ application: "Other", formatVersion: 2, data: {} }),
      "truncated.json": good.slice(0, Math.floor(good.length / 2)),
      "future.json": JSON.stringify({ ...JSON.parse(good), formatVersion: 99 }),
    };
    await goTo(run.page, "settings");
    for (const [name, text] of Object.entries(bad)) {
      const file = path.join(work, name);
      fs.writeFileSync(file, text);
      await stubDialogs(run.app, { open: file });
      await run.page.click("#importBackup");
      await until(async () => (await run.page.textContent("#dataError")).trim().length > 0, 10000, `the error for ${name}`);
      assert.deepEqual(await snapshot(run.page), before, `${name} changed nothing`);
      await run.page.evaluate(() => { document.getElementById("dataError").textContent = ""; });
    }
    assert.deepEqual(fs.readdirSync(path.join(userData, "backups", "safety")), [], "refused files cost no safety copy");

    // the older backup is valid: restored after a safety copy of the current data
    await stubDialogs(run.app, { open: older });
    await run.page.click("#importBackup");
    await until(async () => (await names(run)).length === 1, 20000, "the restore");
    assert.deepEqual(await names(run), ["Alpha"]);
    const safety = fs.readdirSync(path.join(userData, "backups", "safety"));
    assert.equal(safety.length, 1);
    const kept = summarize(fs.readFileSync(path.join(userData, "backups", "safety", safety[0]), "utf8"));
    assert.deepEqual(kept.data.products.map((p) => p.name).sort(), ["Alpha", "Beta", "Gamma"], "the safety copy holds what was replaced");
    // invoice numbers never go back, and the backup file follows the restored data
    await until(async () => (await autoState(run)) === "state-current", 15000, "backup in line with the restored data");
    assert.equal(JSON.parse(fs.readFileSync(path.join(userData, "backups", "invoisy-data.json"), "utf8")).counts.products, 1);
  } finally { await closeAll(); remove(userData); remove(work); }
});

test("closing the window right after a change still writes that change to the backup first", async () => {
  const userData = tempDir("close");
  try {
    const run = await launch(userData);
    await addProduct(run.page, "Just before closing", 3);
    const closed = run.app.waitForEvent("close", { timeout: 30000 });
    const started = Date.now();
    await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());   // well inside the 0.4 s wait before a backup
    await closed;
    assert.ok(Date.now() - started < 6000, "the window closed as soon as the backup was written, not after a time limit");
    const text = fs.readFileSync(path.join(userData, "backups", "invoisy-data.json"), "utf8");
    assert.match(text, /Just before closing/);
    const reopened = await launch(userData);
    assert.deepEqual(await names(reopened), ["Just before closing"]);
  } finally { await closeAll(); remove(userData); }
});

test("if the database is found empty while backups exist (its storage was lost), the application offers to restore the newest backup, and never does it by itself", async () => {
  const userData = tempDir("lost");
  const work = tempDir("lost-file");
  try {
    const sample = await buildSampleBackup();
    const expected = summarize(sample);
    const file = path.join(work, "sample.json");
    fs.writeFileSync(file, sample);
    let run = await launch(userData);
    await stubDialogs(run.app, { open: file });
    await goTo(run.page, "settings");
    await run.page.click("#importBackup");
    await until(async () => (await names(run)).length === 2, 20000, "the restore");
    await until(async () => (await autoState(run)) === "state-current", 15000, "backup written");
    await run.close();

    // The raw database is lost; the backup folder survived. The person says NO to the offer first.
    fs.rmSync(path.join(userData, "IndexedDB"), { recursive: true, force: true });
    const current = path.join(userData, "backups", "invoisy-data.json");
    const before = sha(current);
    run = await launch(userData, { confirm: false });
    await until(() => run.dialogs.length > 0, 15000, "the offer");
    assert.match(run.dialogs[0].message, /database is empty/);
    assert.match(run.dialogs[0].message, /automatic backup was found/);
    await sleep(500);
    assert.deepEqual(await names(run), [], "nothing was restored without agreement");
    assert.equal(sha(current), before, "the newer backup was not overwritten by the empty database");
    await goTo(run.page, "settings");
    await until(async () => (await autoState(run)) === "state-file-newer", 10000, "the 'newer backup' status");
    assert.equal(await run.page.isVisible("#autoReplace"), true);
    await run.close();

    // Next start: the person says YES.
    run = await launch(userData, { confirm: true });
    await until(async () => (await names(run)).length === 2, 20000, "the restored data");
    const after = summarize(await run.page.evaluate(async () => Validation.prepareBackupFile(await db.loadAll({ withAttachments: true }), new Date()).text));
    assert.deepEqual(after.counts, expected.counts);
    assert.deepEqual(after.data.invoices, expected.data.invoices);
    assert.equal(after.paidToSuppliers, expected.paidToSuppliers);
    await goTo(run.page, "settings");
    await until(async () => (await autoState(run)) === "state-current", 15000, "status 'current'");
    assert.deepEqual(summarize(fs.readFileSync(current, "utf8")).counts, expected.counts, "the backup file still holds everything");
  } finally { await closeAll(); remove(userData); remove(work); }
});

test("a start-up copy of the raw database files is kept, outside the database itself", async () => {
  const userData = tempDir("profile");
  try {
    let run = await launch(userData);
    await addProduct(run.page, "Raw", 5);
    await run.close();
    run = await launch(userData);
    await run.close();
    const root = path.join(userData, "backups", "profile-snapshots");
    const copies = fs.readdirSync(root).filter((n) => n.startsWith("IndexedDB-"));
    assert.ok(copies.length >= 1 && copies.length <= 3);
    const inside = path.join(root, copies[copies.length - 1], "IndexedDB", "app_invoisy_0.indexeddb.leveldb");
    assert.ok(fs.readdirSync(inside).length > 0);
  } finally { await closeAll(); remove(userData); }
});

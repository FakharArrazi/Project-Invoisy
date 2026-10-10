"use strict";

// Export, validation of backup files, restore, and the backup reminder.
// Database-level tests use a disposable in-memory IndexedDB; app-level tests run the real page scripts.

const test = require("node:test");
const assert = require("node:assert/strict");
const { fake, V, DB, newDb, iso, sampleProduct, sampleInvoice, dump, failPutWith } = require("./helpers/modules");
const { loadApp } = require("./helpers/app");

/* ---------- helpers ---------- */

async function opened(options) {
  const db = newDb(options);
  await db.initDatabase();
  return db;
}

async function seed(db, data) {
  const changes = {};
  if (data.products) changes.products = { put: data.products, remove: [] };
  if (data.invoices) changes.invoices = { put: data.invoices, remove: [] };
  if (data.settings) changes.settings = data.settings;
  if (data.counter !== undefined) changes.counter = { next: data.counter };
  return db.commitChanges(changes);
}

// A small realistic business: two products, two invoices (one paid in full, one partly paid), custom settings.
function business() {
  const p1 = sampleProduct({ id: "p-1", name: "Everton Grey", sku: "EV-1", stock: 18 });
  const p2 = sampleProduct({ id: "p-2", name: "Cement", manufacturer: "", tileSize: "", coveragePerBox: null, sku: "CM-1", sellingPrice: 300, priceUnit: "kg", stock: 90 });
  const i1 = sampleInvoice({ number: 1, payments: [{ amount: 1900, timestamp: iso(1) }] });
  const i2 = sampleInvoice({ number: 2, payments: [{ amount: 500, timestamp: iso(2) }, { amount: 250.5, timestamp: iso(3) }] });
  return { products: [p1, p2], invoices: [i1, i2], settings: { ...V.DEFAULT_SETTINGS, businessName: "Timgad Tiles", currency: "DZD", paper: "A5" }, counter: 2 };
}

// A valid backup file made from the dataset above.
function backupText(data, overrides) {
  const file = V.buildBackup(data || business(), new Date(Date.UTC(2026, 9, 9, 12)));
  return JSON.stringify({ ...file, ...overrides });
}

const strip = (invoice) => V.stripDerived(invoice);

/* ---------- 8. Export ---------- */

test("export writes the documented envelope and every kind of data", async () => {
  const db = await opened();
  const data = business();
  await seed(db, data);

  const snapshot = await db.loadAll();
  const when = new Date(2026, 9, 9, 15, 30);
  const file = V.prepareBackupFile(snapshot, when);
  assert.equal(file.error, undefined);
  assert.equal(file.name, "invoisy-backup-2026-10-09.json");
  assert.deepEqual(file.counts, { products: 2, invoices: 2 });

  const parsed = JSON.parse(file.text);
  assert.equal(parsed.application, "Invoisy");
  assert.equal(parsed.formatVersion, 1);
  assert.equal(parsed.exportedAt, when.toISOString());
  assert.deepEqual(Object.keys(parsed.data).sort(), ["invoiceCounter", "invoices", "products", "settings"]);
  assert.equal(parsed.data.products.length, 2);
  assert.equal(parsed.data.invoices.length, 2);
  assert.equal(parsed.data.invoiceCounter, 2);
  assert.equal(parsed.data.settings.businessName, "Timgad Tiles");

  // payments and customers travel inside each invoice, exactly as saved
  assert.deepEqual(parsed.data.invoices[1].payments, [{ amount: 500, timestamp: iso(2) }, { amount: 250.5, timestamp: iso(3) }]);
  assert.equal(parsed.data.invoices[1].customer.name, "Walk-in Customer");
  // the figures a reader wants are included for convenience
  assert.equal(parsed.data.invoices[1].amountPaid, 750.5);
  assert.equal(parsed.data.invoices[1].remaining, 1149.5);
  assert.equal(parsed.data.invoices[1].status, "partial");
});

test("the file name follows invoisy-backup-YYYY-MM-DD.json", () => {
  assert.equal(V.backupFileName(new Date(2026, 0, 5)), "invoisy-backup-2026-01-05.json");
  assert.equal(V.backupFileName(new Date(2026, 11, 31), "invoisy-before-restore"), "invoisy-before-restore-2026-12-31.json");
});

test("an empty database exports a valid file that restores to an empty database", async () => {
  const db = await opened();
  const file = V.prepareBackupFile(await db.loadAll(), new Date());
  assert.equal(file.error, undefined);
  const parsed = V.parseBackup(file.text);
  assert.equal(parsed.error, undefined);
  assert.deepEqual([parsed.data.products.length, parsed.data.invoices.length, parsed.data.counter], [0, 0, 0]);
});

test("the backup is checked before it is offered: a damaged record means no file at all", async () => {
  const db = await opened();
  await seed(db, business());
  const snapshot = await db.loadAll();
  snapshot.invoices[0].total = NaN;
  const file = V.prepareBackupFile(snapshot, new Date());
  assert.match(file.error, /safety check/);
  assert.equal(file.text, undefined, "no text to download");
  assert.equal(file.name, undefined);
});

test("exporting never changes the data: not the stores, not the revision, not the objects it was given", async () => {
  const db = await opened();
  await seed(db, business());
  const before = await dump(db);
  const snapshot = await db.loadAll();
  const copy = JSON.parse(JSON.stringify(snapshot));

  const file = V.prepareBackupFile(snapshot, new Date());
  assert.equal(file.error, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), copy, "the snapshot is untouched (no derived fields leaked into it)");
  assert.equal(snapshot.invoices[0].amountPaid, undefined);

  await db.recordBackup({ at: new Date().toISOString(), fileName: file.name, counts: file.counts });
  assert.deepEqual(await dump(db), before, "recording the backup date does not touch products, invoices, settings, counter or revision");
});

test("derived invoice fields are never saved into the database, only into backup files", async () => {
  const db = await opened();
  const withDerived = { ...sampleInvoice({ number: 1 }), amountPaid: 999, remaining: 1, status: "paid" };
  await seed(db, { invoices: [withDerived], counter: 1 });
  const stored = (await db.loadAll()).invoices[0];
  assert.equal(stored.amountPaid, undefined);
  assert.equal(stored.remaining, undefined);
  assert.equal(stored.status, undefined);
});

/* ---------- 9. Backup reminder ---------- */

test("reminder: nothing is shown for an empty install, 'No backup yet' for data never backed up", () => {
  const now = new Date("2026-10-09T12:00:00Z");
  assert.equal(V.backupReminder({ lastBackupAt: null, intervalDays: 7 }, false, now).level, "none");
  const never = V.backupReminder({ lastBackupAt: null, intervalDays: 7 }, true, now);
  assert.equal(never.level, "never");
  assert.equal(never.text, "No backup yet");
});

test("reminder: due after the interval, quiet before it, and the interval is configurable", () => {
  const now = new Date("2026-10-09T12:00:00Z");
  const daysAgo = (n) => new Date(now - n * 86400000).toISOString();
  assert.equal(V.backupReminder({ lastBackupAt: daysAgo(2), intervalDays: 7 }, true, now).level, "ok");
  assert.equal(V.backupReminder({ lastBackupAt: daysAgo(6), intervalDays: 7 }, true, now).level, "ok");
  const due = V.backupReminder({ lastBackupAt: daysAgo(7), intervalDays: 7 }, true, now);
  assert.equal(due.level, "overdue");
  assert.equal(due.text, "Last backup 7 days ago");
  assert.equal(V.backupReminder({ lastBackupAt: daysAgo(1), intervalDays: 1 }, true, now).text, "Last backup 1 day ago");
  assert.equal(V.backupReminder({ lastBackupAt: daysAgo(10), intervalDays: 30 }, true, now).level, "ok", "a longer interval is respected");
  assert.equal(V.backupReminder({ lastBackupAt: daysAgo(10) }, true, now).level, "overdue", "default interval is 7 days");
  assert.equal(V.backupReminder({ lastBackupAt: "not a date", intervalDays: 7 }, true, now).level, "never", "a damaged date is not trusted");
});

test("the reminder interval is validated and stored with the database", async () => {
  const db = await opened();
  assert.equal((await db.getBackupInfo()).intervalDays, 7);
  await db.setBackupInterval(14);
  assert.equal((await db.getBackupInfo()).intervalDays, 14);
  for (const bad of [0, -3, 1.5, 366, "7", NaN, null]) {
    await assert.rejects(db.setBackupInterval(bad), (e) => e.code === "INVALID", `interval ${String(bad)} is refused`);
  }
  assert.equal((await db.getBackupInfo()).intervalDays, 14, "a refused value changes nothing");
  await assert.rejects(db.recordBackup({ at: "yesterday-ish" }), (e) => e.code === "INVALID");
  assert.equal((await db.getBackupInfo()).lastBackupAt, null, "an invalid date is never recorded");
});

/* ---------- App: Export Backup button ---------- */

async function runningApp(data, options) {
  const app = loadApp(options);
  if (data) {
    await app.api.db.initDatabase();
    await seed(app.api.db, data);
  }
  const storage = await app.start();
  assert.equal(storage.mode, "ready", storage.reason);
  return app;
}

test("Export Backup downloads a valid file, then records the date; the reminder disappears; the object URL is released", async () => {
  const app = await runningApp(business());
  assert.equal(app.field("backupReminder").hidden, false, "data that was never backed up shows the reminder");
  assert.match(app.field("backupReminder").textContent, /No backup yet/);
  assert.equal(app.api.getStorage().backup.lastBackupAt, null);

  await app.api.exportBackup();

  assert.equal(app.downloads.length, 1);
  assert.match(app.downloads[0].name, /^invoisy-backup-\d{4}-\d{2}-\d{2}\.json$/);
  const parsed = V.parseBackup(await app.downloadedText());
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.data.products.length, 2);
  assert.equal(parsed.data.invoices.length, 2);

  const info = await app.api.db.getBackupInfo();
  assert.ok(info.lastBackupAt, "the date was recorded");
  assert.equal(info.lastBackupFile, app.downloads[0].name);
  assert.deepEqual(info.lastBackupCounts, { products: 2, invoices: 2 });
  assert.equal(app.field("backupReminder").hidden, true, "the reminder is gone after a successful export");
  assert.match(app.toast(), /Backup exported/);

  assert.equal(app.revoked.length, 0, "the address is still needed while the browser starts the download");
  app.flushTimers();
  assert.equal(app.revoked.length, 1, "the temporary object URL is revoked");
});

test("Export Backup does not change the data or its revision", async () => {
  const app = await runningApp(business());
  const before = await dump(app.api.db);
  await app.api.exportBackup();
  await app.api.exportBackup();
  assert.deepEqual(await dump(app.api.db), before);
  assert.equal(app.api.getState().revision, before.revision);
});

test("if the browser blocks the download, no backup date is recorded and the reminder stays", async () => {
  const app = await runningApp(business());
  app.control.failDownload = true;
  await app.api.exportBackup();
  assert.equal(app.downloads.length, 0);
  assert.equal((await app.api.db.getBackupInfo()).lastBackupAt, null, "the date is NOT updated");
  assert.equal(app.field("backupReminder").hidden, false);
  assert.match(app.errorText("dataError"), /could not be downloaded/);
  assert.match(app.errorText("dataError"), /No backup date was recorded/);
});

test("a damaged record in the database stops the export: no download, no backup date", async () => {
  const app = loadApp();
  await app.api.db.initDatabase();
  await seed(app.api.db, business());
  // Damage a record behind the app's back, the way a bug or another tool could.
  await new Promise((resolve, reject) => {
    const open = app.indexedDB.open("invoisy");
    open.onsuccess = () => {
      const raw = open.result;
      const tx = raw.transaction(["invoices"], "readwrite");
      tx.objectStore("invoices").put({ ...sampleInvoice({ number: 2 }), total: "not a number" });
      tx.oncomplete = () => { raw.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
    open.onerror = () => reject(open.error);
  });
  const storage = await app.start();
  assert.equal(storage.mode, "ready");
  await app.api.exportBackup();
  assert.equal(app.downloads.length, 0, "a backup that would fail its own check is never offered");
  assert.equal((await app.api.db.getBackupInfo()).lastBackupAt, null);
  assert.match(app.errorText("dataError"), /safety check/);
});

test("the export and import buttons are disabled while an operation runs and enabled again afterwards", async () => {
  const app = await runningApp(business());
  assert.equal(app.field("exportBackup").disabled, false);
  const running = app.api.exportBackup();
  assert.equal(app.field("exportBackup").disabled, true, "disabled while exporting");
  assert.equal(app.field("importBackup").disabled, true);
  await running;
  assert.equal(app.field("exportBackup").disabled, false);
  assert.equal(app.field("importBackup").disabled, false);
});

test("a second click while exporting is ignored: one file, not two", async () => {
  const app = await runningApp(business());
  await Promise.all([app.api.exportBackup(), app.api.exportBackup()]);
  assert.equal(app.downloads.length, 1);
});

/* ---------- 10-14. Import validation ---------- */

test("a valid backup parses back to exactly the data that was exported", async () => {
  const db = await opened();
  await seed(db, business());
  const snapshot = await db.loadAll();
  const file = V.prepareBackupFile(snapshot, new Date());
  const parsed = V.parseBackup(file.text);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.format, "backup");
  assert.deepEqual(parsed.warnings, []);
  assert.deepEqual(parsed.data.products, snapshot.products);
  assert.deepEqual(parsed.data.invoices.map(strip), snapshot.invoices.map(strip));
  assert.deepEqual(parsed.data.settings, snapshot.settings);
  assert.equal(parsed.data.counter, snapshot.counter);
});

const badFiles = [
  ["an empty file", "", /empty/i],
  ["only spaces", "   \n  ", /empty/i],
  ["text that is not JSON", "this is not json {", /not valid JSON/],
  ["truncated JSON", backupText().slice(0, 200), /not valid JSON/],
  ["a JSON list", "[1,2,3]", /not an Invoisy backup/],
  ["a JSON number", "42", /not an Invoisy backup/],
  ["JSON null", "null", /not an Invoisy backup/],
  ["some other JSON object", JSON.stringify({ hello: "world" }), /not an Invoisy backup/],
  ["a file made by another application", backupText(null, { application: "Other App" }), /not made by Invoisy/],
  ["a missing format version", backupText(null, { formatVersion: undefined }), /format version/],
  ["a format version of zero", backupText(null, { formatVersion: 0 }), /format version/],
  ["a text format version", backupText(null, { formatVersion: "1" }), /format version/],
  ["a newer format version", backupText(null, { formatVersion: 2 }), /newer version of Invoisy/],
  ["a missing data section", backupText(null, { data: undefined }), /no data section/],
  ["a data section that is a list", backupText(null, { data: [] }), /no data section/],
  ["counts that do not match the content", backupText(null, { counts: { products: 99, invoices: 2 } }), /counts .* do not match/i],
];
for (const [label, text, expected] of badFiles) {
  test(`rejects ${label}`, () => {
    const result = V.parseBackup(text);
    assert.ok(result.error, "must be rejected");
    assert.match(result.error, expected);
    assert.equal(result.data, undefined, "no data is handed back");
  });
}

function withInvoice(change) {
  const data = business();
  data.invoices = data.invoices.map((i, n) => (n === 1 ? change(i) : i));
  return backupText(data);
}
function withProduct(change) {
  const data = business();
  data.products = data.products.map((p, n) => (n === 0 ? change(p) : p));
  return backupText(data);
}

const invalidRecords = [
  ["a negative invoice total", withInvoice((i) => ({ ...i, total: -5 }))],
  ["a text invoice total", withInvoice((i) => ({ ...i, total: "1900" }))],
  ["a missing subtotal", withInvoice((i) => ({ ...i, subtotal: null }))],
  ["a negative discount", withInvoice((i) => ({ ...i, discount: -1 }))],
  ["a payment of zero", withInvoice((i) => ({ ...i, payments: [{ amount: 0, timestamp: iso(1) }] }))],
  ["a negative payment", withInvoice((i) => ({ ...i, payments: [{ amount: -50, timestamp: iso(1) }] }))],
  ["a payment without a date", withInvoice((i) => ({ ...i, payments: [{ amount: 50 }] }))],
  ["an invoice without a payment list", withInvoice((i) => ({ ...i, payments: undefined }))],
  ["an item with quantity zero", withInvoice((i) => ({ ...i, items: [{ ...i.items[0], qty: 0 }] }))],
  ["an item with a negative price", withInvoice((i) => ({ ...i, items: [{ ...i.items[0], unitPrice: -1 }] }))],
  ["an item with a text quantity", withInvoice((i) => ({ ...i, items: [{ ...i.items[0], qty: "2" }] }))],
  ["an invoice without items", withInvoice((i) => ({ ...i, items: "none" }))],
  ["an invoice number in the wrong format", withInvoice((i) => ({ ...i, invoiceNumber: "2" }))],
  ["an invoice without an id", withInvoice((i) => ({ ...i, id: "" }))],
  ["an invoice with an impossible date", withInvoice((i) => ({ ...i, date: "31/02/2026" }))],
  ["a product without a name", withProduct((p) => ({ ...p, name: "" }))],
  ["a product with a negative price", withProduct((p) => ({ ...p, sellingPrice: -1 }))],
  ["a product with negative stock", withProduct((p) => ({ ...p, stock: -4 }))],
  ["a product with a text stock quantity", withProduct((p) => ({ ...p, stock: "5" }))],
  ["a product with an unknown stock unit", withProduct((p) => ({ ...p, stockUnit: "pallet" }))],
  ["a product with an unknown price unit", withProduct((p) => ({ ...p, priceUnit: "bogus" }))],
  ["a product with a text price", withProduct((p) => ({ ...p, sellingPrice: "abc" }))],
];
for (const [label, text] of invalidRecords) {
  test(`rejects a backup with ${label}`, () => {
    const result = V.parseBackup(text);
    assert.ok(result.error, "must be rejected, nothing repaired or guessed");
    assert.equal(result.data, undefined);
  });
}

test("fractional stock is accepted for a product whose stock unit is known, and restored exactly", () => {
  const data = business();
  data.products[0] = { ...data.products[0], stockUnit: "box", stock: 19.25 };
  const result = V.parseBackup(backupText(data));
  assert.equal(result.error, undefined);
  assert.equal(result.data.products[0].stock, 19.25);
  assert.equal(result.data.products[0].stockUnit, "box");
});

test("rejects repeated product ids, repeated invoice ids and repeated invoice numbers", () => {
  const data = business();
  const sameProduct = { ...data, products: [data.products[0], { ...data.products[1], id: data.products[0].id }] };
  assert.match(V.parseBackup(backupText(sameProduct)).error, /share the id/);
  const sameId = { ...data, invoices: [data.invoices[0], { ...data.invoices[1], id: data.invoices[0].id }] };
  assert.match(V.parseBackup(backupText(sameId)).error, /share the id/);
  const sameNumber = { ...data, invoices: [data.invoices[0], { ...data.invoices[1], invoiceNumber: data.invoices[0].invoiceNumber }] };
  assert.match(V.parseBackup(backupText(sameNumber)).error, /share the number/);
});

test("rejects invalid settings", () => {
  const data = business();
  for (const settings of [{ ...data.settings, paper: "A3" }, { ...data.settings, currency: "  " }, { ...data.settings, logo: "http://example.com/x.png" }, { ...data.settings, businessName: 5 }]) {
    assert.ok(V.parseBackup(backupText({ ...data, settings })).error, JSON.stringify(settings).slice(0, 60));
  }
});

test("a problem is reported with enough detail to find it", () => {
  const result = V.parseBackup(withInvoice((i) => ({ ...i, total: -5 })));
  assert.match(result.error, /Invoice 2 \(INV-000002\) has an invalid total/);
  const product = V.parseBackup(withProduct((p) => ({ ...p, stock: -4 })));
  assert.match(product.error, /Product 1 \(Everton Grey\)/);
});

test("payments larger than the total, or totals that do not add up, are restored as stored but flagged", () => {
  const data = business();
  data.invoices[1] = { ...data.invoices[1], payments: [{ amount: 5000, timestamp: iso(1) }] };
  data.invoices[0] = { ...data.invoices[0], total: 1800 };
  const result = V.parseBackup(backupText(data));
  assert.equal(result.error, undefined, "not blocked: older data may not follow today's arithmetic");
  assert.ok(result.warnings.some((w) => /INV-000002.*more than the invoice total/.test(w)));
  assert.ok(result.warnings.some((w) => /INV-000001.*does not match/.test(w)));
  assert.equal(result.data.invoices[1].payments[0].amount, 5000, "the stored figure is not altered to make it fit");
  assert.equal(result.data.invoices[0].total, 1800);
});

test("a lower counter than the highest invoice is raised, never left to reuse a number", () => {
  const data = { ...business(), counter: 0 };
  const result = V.parseBackup(backupText(data));
  assert.equal(result.error, undefined);
  assert.equal(result.data.counter, 2);
  assert.ok(result.warnings.some((w) => /counter/i.test(w)));
});

test("the file the previous version wrote (invoisy-data.json) can still be restored", () => {
  const legacy = {
    version: 1, lastSaved: iso(5),
    products: [{ id: "a", name: "Old Tile", sellingPrice: 10, priceUnit: "piece", stock: 3 }],
    invoices: [], settings: { ...V.DEFAULT_SETTINGS }, invoiceCounter: 4,
  };
  const result = V.parseBackup(JSON.stringify(legacy));
  assert.equal(result.error, undefined);
  assert.equal(result.format, "legacy-file");
  assert.equal(result.data.products[0].name, "Old Tile");
  assert.equal(result.data.counter, 4);
});

/* ---------- 11-13. Restore (database level) ---------- */

test("restore replaces everything: records missing from the backup are gone, settings and counter come from it", async () => {
  const db = await opened();
  await seed(db, { products: [sampleProduct({ id: "old-only", name: "Only here" })], invoices: [sampleInvoice({ number: 7, id: "old-7" })], counter: 7 });

  const incoming = V.parseBackup(backupText()).data;
  const result = await db.restore(incoming);
  assert.deepEqual(result.counts, { products: 2, invoices: 2 });

  const after = await db.loadAll();
  assert.deepEqual(after.products.map((p) => p.id).sort(), ["p-1", "p-2"]);
  assert.deepEqual(after.invoices.map((i) => i.invoiceNumber), ["INV-000001", "INV-000002"]);
  assert.equal(after.settings.businessName, "Timgad Tiles");
  assert.equal(after.invoices[1].payments.length, 2);
  assert.equal(after.products[0].stock + after.products[1].stock, 108);
});

test("restore never moves the invoice counter backwards", async () => {
  const cases = [
    { current: 10, backup: 2, expected: 10 },   // the database has issued more numbers than the backup knows
    { current: 2, backup: 20, expected: 20 },   // the backup is further ahead
    { current: 0, backup: 2, expected: 2 },
  ];
  for (const c of cases) {
    const db = await opened();
    if (c.current) await db.commitChanges({ counter: { next: c.current } });
    const incoming = V.parseBackup(backupText({ ...business(), counter: c.backup })).data;
    await db.restore(incoming);
    assert.equal((await db.loadAll()).counter, c.expected, JSON.stringify(c));
    assert.equal(await db.getNextInvoiceNumber(), V.formatInvoiceNumber(c.expected + 1));
  }
});

test("a failure part-way through a restore leaves the database exactly as it was (no partial restore)", async () => {
  // Every position of the write sequence is tried: the first product, the second product, the invoices, the settings...
  for (let failAt = 1; failAt <= 7; failAt++) {
    const db = await opened();
    await seed(db, { products: [sampleProduct({ id: "keep-me", stock: 5 })], invoices: [sampleInvoice({ number: 3, id: "keep-3" })], counter: 3 });
    const before = await dump(db);
    const incoming = V.parseBackup(backupText()).data;

    const restoreFake = failPutWith("QuotaExceededError", failAt);
    let error;
    try {
      await db.restore(incoming);
    } catch (e) {
      error = e;
    } finally {
      restoreFake();
    }
    assert.ok(error, `write ${failAt} failed, so the restore must fail`);
    assert.equal(error.code, "QUOTA", `write ${failAt}: ${error.message}`);
    assert.deepEqual(await dump(db), before, `write ${failAt}: nothing changed, including the revision`);
  }
});

test("the restore works again after a failed one (nothing is left locked or half-written)", async () => {
  const db = await opened();
  await seed(db, { products: [sampleProduct({ id: "keep-me" })], counter: 0 });
  const incoming = V.parseBackup(backupText()).data;
  const undo = failPutWith("QuotaExceededError", 2);
  await assert.rejects(db.restore(incoming));
  undo();
  const result = await db.restore(incoming);
  assert.deepEqual(result.counts, { products: 2, invoices: 2 });
  assert.deepEqual((await db.loadAll()).products.map((p) => p.id).sort(), ["p-1", "p-2"]);
});

test("a restore based on stale data is refused: another window saved first", async () => {
  const db = await opened();
  await seed(db, { products: [sampleProduct({ id: "a" })] });
  const stale = (await db.loadAll()).revision;
  await seed(db, { products: [sampleProduct({ id: "b" })] });   // someone else saves
  const before = await dump(db);
  await assert.rejects(db.restore(V.parseBackup(backupText()).data, { expectedRevision: stale }), (e) => e.code === "CONFLICT");
  assert.deepEqual(await dump(db), before);
});

test("the database refuses a dataset that was not validated (the persistence layer checks too)", async () => {
  const db = await opened();
  await seed(db, business());
  const before = await dump(db);
  const incoming = V.parseBackup(backupText()).data;
  incoming.invoices[0] = { ...incoming.invoices[0], total: -1 };
  await assert.rejects(db.restore(incoming), (e) => e.code === "INVALID");
  incoming.invoices[0] = { ...incoming.invoices[0], total: 1900 };
  incoming.invoices[1] = { ...incoming.invoices[1], invoiceNumber: incoming.invoices[0].invoiceNumber };
  await assert.rejects(db.restore(incoming), (e) => e.code === "INVALID" || e.code === "CONSTRAINT");
  assert.deepEqual(await dump(db), before);
});

test("restoring the same file twice gives the same data (idempotent)", async () => {
  const db = await opened();
  const incoming = V.parseBackup(backupText()).data;
  await db.restore(incoming);
  const first = await dump(db);
  await db.restore(incoming);
  const second = await dump(db);
  assert.deepEqual({ ...second, revision: 0 }, { ...first, revision: 0 });
  assert.equal(second.revision, first.revision + 1, "each restore is one new revision");
});

test("a restore announces itself so other open windows reload", async () => {
  const factory = new fake.IDBFactory();
  const channels = new Map();
  class FakeChannel {
    constructor(name) { this.name = name; (channels.get(name) || channels.set(name, new Set()).get(name)).add(this); }
    postMessage(data) { for (const other of channels.get(this.name)) if (other !== this) setTimeout(() => other.onmessage({ data })); }
    close() { channels.get(this.name).delete(this); }
  }
  globalThis.BroadcastChannel = FakeChannel;
  try {
    const first = DB.create({ indexedDB: factory, name: "restore-chan" });
    const second = DB.create({ indexedDB: factory, name: "restore-chan" });
    await first.initDatabase();
    await second.initDatabase();
    const seen = [];
    second.on("change", (m) => seen.push(m.revision));
    await first.restore(V.parseBackup(backupText()).data);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(seen, [(await first.loadAll()).revision]);
    first.close();
    second.close();
  } finally {
    delete globalThis.BroadcastChannel;
  }
});

/* ---------- App: Import / Restore button ---------- */

test("cancelling the confirmation changes nothing and downloads nothing", async () => {
  const app = await runningApp(business());
  const before = await dump(app.api.db);
  app.answer(false);
  await app.api.importBackup(app.file(backupText({ ...business(), products: [], invoices: [] })));
  assert.equal(app.confirms.length, 1, "the person was asked");
  assert.deepEqual(await dump(app.api.db), before);
  assert.equal(app.downloads.length, 0, "no safety copy is made when nothing will be replaced");
  assert.match(app.toast(), /cancelled/i);
  assert.equal(app.api.getState().products.length, 2);
});

test("the confirmation says what will be replaced, with counts, and the next invoice number", async () => {
  const app = await runningApp(business());
  app.answer(false);
  const incoming = { ...business(), products: [business().products[0]], counter: 40 };
  incoming.invoices = [];
  await app.api.importBackup(app.file(backupText(incoming)));
  const message = app.confirms[0];
  assert.match(message, /REPLACE all the data/);
  assert.match(message, /Backup: 1 product, 0 invoices/);
  assert.match(message, /Current: 2 products, 2 invoices/);
  assert.match(message, /next one will be INV-000041/);
  assert.match(message, /safety copy/);
});

test("a confirmed restore downloads a safety copy first, then replaces everything and refreshes from the database", async () => {
  const app = await runningApp(business());
  const incomingData = {
    products: [sampleProduct({ id: "r-1", name: "Restored Tile", stock: 4 })],
    invoices: [sampleInvoice({ number: 9, id: "r-i9", payments: [{ amount: 1900, timestamp: iso(1) }] })],
    settings: { ...V.DEFAULT_SETTINGS, businessName: "Restored Shop" }, counter: 9,
  };
  const current = await dump(app.api.db);

  await app.api.importBackup(app.file(backupText(incomingData)));

  // the safety copy holds the data that was replaced
  assert.equal(app.downloads.length, 1);
  assert.match(app.downloads[0].name, /^invoisy-before-restore-\d{4}-\d{2}-\d{2}\.json$/);
  const safety = V.parseBackup(await app.downloadedText());
  assert.equal(safety.error, undefined);
  assert.deepEqual(safety.data.products, current.products);
  assert.deepEqual(safety.data.invoices.map(strip), current.invoices.map(strip));

  // the database and the screen hold the restored data
  const stored = await app.api.db.loadAll();
  assert.deepEqual(Array.from(stored.products, (p) => p.id), ["r-1"]);
  assert.deepEqual(Array.from(stored.invoices, (i) => i.invoiceNumber), ["INV-000009"]);
  assert.equal(stored.settings.businessName, "Restored Shop");
  assert.equal(app.api.getState().products[0].name, "Restored Tile");
  assert.equal(app.api.getState().revision, stored.revision, "the page is on the new revision");
  assert.match(app.toast(), /Restore completed/);
  assert.match(app.toast(), /previous data was saved as invoisy-before-restore/);

  // the next sale continues after the restored numbers, even though the old counter was lower
  assert.equal(await app.api.db.getNextInvoiceNumber(), "INV-000010");

  app.flushTimers();
  assert.equal(app.revoked.length, 1, "the safety copy's object URL is released");
});

test("restoring into an empty database makes no safety copy (there is nothing to protect)", async () => {
  const app = await runningApp();
  await app.api.importBackup(app.file(backupText()));
  assert.equal(app.downloads.length, 0);
  assert.equal(app.api.getState().products.length, 2);
  assert.equal(app.api.getState().invoices.length, 2);
});

test("a bad file is rejected before anything is asked or changed", async () => {
  const app = await runningApp(business());
  const before = await dump(app.api.db);
  for (const [, text] of [["json", "not json"], ["version", backupText(null, { formatVersion: 7 })], ["financial", withInvoice((i) => ({ ...i, total: -1 }))]]) {
    await app.api.importBackup(app.file(text));
    assert.match(app.errorText("dataError"), /not a valid Invoisy backup, so nothing was changed/);
  }
  assert.equal(app.confirms.length, 0, "no confirmation for a file that can not be restored");
  assert.equal(app.downloads.length, 0);
  assert.deepEqual(await dump(app.api.db), before);
});

test("a file that can not be read is reported and nothing changes", async () => {
  const app = await runningApp(business());
  const before = await dump(app.api.db);
  await app.api.importBackup({ text: async () => { throw new Error("disk error"); } });
  assert.match(app.errorText("dataError"), /could not be read/);
  assert.deepEqual(await dump(app.api.db), before);
});

test("a restore that fails in the database keeps the old data, in the database and on screen", async () => {
  const app = await runningApp(business());
  const before = await dump(app.api.db);
  const screenBefore = JSON.stringify(app.api.getState().products);
  const undo = failPutWith("QuotaExceededError", 2);
  try {
    await app.api.importBackup(app.file(backupText({ ...business(), products: [sampleProduct({ id: "x1" }), sampleProduct({ id: "x2" })] })));
  } finally {
    undo();
  }
  assert.match(app.errorText("dataError"), /no storage space left/i);
  assert.deepEqual(await dump(app.api.db), before);
  assert.equal(JSON.stringify(app.api.getState().products), screenBefore);
  assert.equal(app.downloads.length, 1, "only the safety copy was downloaded; it holds the unchanged data");
});

test("if the safety copy can not be downloaded, the restore is cancelled and nothing changes", async () => {
  const app = await runningApp(business());
  const before = await dump(app.api.db);
  app.control.failDownload = true;
  await app.api.importBackup(app.file(backupText({ ...business(), products: [], invoices: [] })));
  assert.match(app.errorText("dataError"), /safety copy .* could not be downloaded/);
  assert.deepEqual(await dump(app.api.db), before);
});

test("the Import button is disabled while a restore runs", async () => {
  const app = await runningApp(business());
  const running = app.api.importBackup(app.file(backupText()));
  assert.equal(app.field("importBackup").disabled, true);
  await running;
  assert.equal(app.field("importBackup").disabled, false);
});

test("Export then Restore round-trips a business exactly, including payments and stock", async () => {
  const source = await runningApp(business());
  await source.api.exportBackup();
  const text = await source.downloadedText();

  const target = await runningApp();   // a different, empty browser
  await target.api.importBackup(target.file(text));

  const a = await dump(source.api.db);
  const b = await dump(target.api.db);
  assert.deepEqual(b.products, a.products);
  assert.deepEqual(b.invoices, a.invoices);
  assert.deepEqual(b.settings, a.settings);
  assert.equal(b.counter, a.counter);
});

/* ---------- French: the same checks speak French ---------- */

test("backup errors, warnings and the reminder are worded in the current language", () => {
  const I18n = globalThis.I18n;
  try {
    I18n.setLanguage("fr");
    assert.equal(V.parseBackup("not json").error, "Le fichier n’est pas un JSON valide.");
    assert.equal(V.parseBackup("").error, "Le fichier est vide.");
    assert.match(V.parseBackup(backupText(null, { formatVersion: 9 })).error, /version plus récente d’Invoisy/);
    assert.match(V.parseBackup(withInvoice((i) => ({ ...i, total: -5 }))).error, /^Facture 2 \(INV-000002\) : total non valide\.$/);
    const data = business();
    data.invoices[1] = { ...data.invoices[1], payments: [{ amount: 5000, timestamp: iso(1) }] };
    assert.match(V.parseBackup(backupText(data)).warnings[0], /INV-000002 : les paiements dépassent le total/);

    const now = new Date("2026-10-09T12:00:00Z");
    assert.equal(V.backupReminder({ lastBackupAt: null }, true, now).text, "Aucune sauvegarde");
    assert.equal(V.backupReminder({ lastBackupAt: new Date(now - 7 * 86400000).toISOString(), intervalDays: 7 }, true, now).text, "Dernière sauvegarde il y a 7 jours");
    assert.equal(V.backupReminder({ lastBackupAt: new Date(now - 86400000).toISOString(), intervalDays: 1 }, true, now).text, "Dernière sauvegarde il y a 1 jour");
  } finally {
    I18n.setLanguage("en");
  }
  assert.equal(V.parseBackup("not json").error, "The file is not valid JSON.");
});

test("database errors are worded in the current language", async () => {
  const I18n = globalThis.I18n;
  const db = await opened();
  try {
    I18n.setLanguage("fr");
    const undo = failPutWith("QuotaExceededError", 1);
    try {
      await assert.rejects(db.commitChanges({ products: { put: [sampleProduct()], remove: [] } }), (e) => {
        assert.equal(e.code, "QUOTA");
        assert.match(e.message, /plus d’espace de stockage/);
        return true;
      });
    } finally {
      undo();
    }
    await assert.rejects(db.setBackupInterval(0), (e) => /nombre entier de jours/.test(e.message));
  } finally {
    I18n.setLanguage("en");
  }
});

test("the app speaks French when the language setting is French: a bad backup is rejected in French and nothing changes", async () => {
  const app = await runningApp(business());   // the app has its own copy of the language layer, so no reset is needed
  await app.api.commit((d) => { d.settings.language = "fr"; });
  const before = await dump(app.api.db);
  await app.api.importBackup(app.file("not json"));
  assert.equal(app.errorText("dataError"), "Ce fichier n’est pas une sauvegarde Invoisy valide\u00a0: rien n’a été modifié. (Le fichier n’est pas un JSON valide.)");
  assert.deepEqual(await dump(app.api.db), before);

  app.answer(false);
  await app.api.importBackup(app.file(backupText()));
  assert.match(app.confirms[0], /va REMPLACER toutes les données/);
  assert.match(app.confirms[0], /le prochain sera INV-000003/);
  assert.match(app.toast(), /Restauration annulée/);
});

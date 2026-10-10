"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { fake, V, DB, newDb, iso, sampleProduct, sampleInvoice, fakeLocalStorage, dump, failPutWith } = require("./helpers/modules");

/* ---------- What the older versions left in localStorage ---------- */

const legacyProduct = (i, overrides) => ({ id: "lp" + i, name: "Legacy " + i, description: "", sku: "L" + i, category: "Old", sellingPrice: 100 * i, priceUnit: "piece", purchasePrice: 60 * i, stock: 10 * i, ...overrides });
const withDerived = (inv) => { const p = V.paymentSummary(inv); return { ...inv, amountPaid: p.paid, remaining: p.remaining, status: p.cls }; };
const legacyInvoices = () => [
  sampleInvoice({ number: 1, id: "li1", total: 1900, payments: [{ amount: 1900, timestamp: iso(1) }] }),
  sampleInvoice({ number: 2, id: "li2", total: 1900, payments: [{ amount: 500, timestamp: iso(2) }, { amount: 100.5, timestamp: iso(3) }] }),
];
const legacySettings = () => ({ ...V.DEFAULT_SETTINGS, businessName: "Old Shop", address: "1 Old Road", currency: "DZD", paper: "A5" });

// The previous version's browser copy of its data file.
const mirrorOf = (overrides) => JSON.stringify({
  version: 1, lastSaved: iso(10),
  products: [legacyProduct(1), legacyProduct(2)],
  invoices: legacyInvoices().map(withDerived),
  settings: legacySettings(),
  invoiceCounter: 5,
  ...overrides,
});

// The oldest layout: separate localStorage keys.
const separateKeys = (overrides) => ({
  products: JSON.stringify([legacyProduct(1), legacyProduct(2)]),
  invoices: JSON.stringify(legacyInvoices()),
  settings: JSON.stringify(legacySettings()),
  invoiceCounter: "9",
  ...overrides,
});

async function opened(options) {
  const db = newDb(options);
  await db.initDatabase();
  return db;
}

/* ---------- 7. Migration from existing localStorage data ---------- */

test("migrates the previous version's browser copy: products, invoices, payments, settings and the counter", async () => {
  const ls = fakeLocalStorage({ "invoisy-data": mirrorOf() });
  const db = await opened();
  const result = await db.migrateLegacy(ls);

  assert.equal(result.status, "migrated");
  assert.deepEqual(result.record.counts, { products: 2, invoices: 2 });
  const after = await db.loadAll();
  assert.deepEqual(after.products.map((p) => p.id), ["lp1", "lp2"], "product ids are kept");
  assert.equal(after.products[1].stock, 20);
  assert.deepEqual(after.invoices.map((i) => i.invoiceNumber), ["INV-000001", "INV-000002"], "invoice numbers are kept");
  assert.deepEqual(after.invoices[1].payments, [{ amount: 500, timestamp: iso(2) }, { amount: 100.5, timestamp: iso(3) }], "payment history is kept exactly");
  assert.deepEqual([after.invoices[1].subtotal, after.invoices[1].discount, after.invoices[1].tax, after.invoices[1].total], [2000, 100, 0, 1900]);
  assert.equal(after.counter, 5, "the counter is NOT reset to the highest invoice number: it stays 5");
  assert.equal(after.settings.businessName, "Old Shop");
  assert.equal(after.settings.paper, "A5");
  assert.equal(await db.getNextInvoiceNumber(), "INV-000006");
});

test("migrates the oldest layout (separate keys), treating invoices from before payments existed as paid in full", async () => {
  const oldInvoice = { id: "x1", invoiceNumber: "INV-000001", date: iso(1), items: [{ productId: "lp1", name: "Legacy 1", qty: 3, unitPrice: 100 }] };   // no totals, no payments
  const ls = fakeLocalStorage(separateKeys({ invoices: JSON.stringify([oldInvoice]), invoiceCounter: "1", products: JSON.stringify([{ id: "o1", name: "Plain old product", sellingPrice: 15, stock: 7 }]) }));
  const db = await opened();
  const result = await db.migrateLegacy(ls);
  assert.equal(result.status, "migrated");
  assert.equal(result.record.source, "separate-entries");
  const after = await db.loadAll();
  assert.equal(after.products[0].id, "o1");
  assert.equal(after.products[0].stock, 7);
  assert.equal(after.products[0].manufacturer, "", "fields the old version did not have get defaults");
  const inv = after.invoices[0];
  assert.deepEqual([inv.subtotal, inv.total], [300, 300], "missing totals are derived from the items");
  assert.deepEqual(inv.payments, [{ amount: 300, timestamp: iso(1) }], "paid in full at the sale date");
});

test("when both the browser copy and the separate keys exist, the newer browser copy is used", async () => {
  const ls = fakeLocalStorage({ "invoisy-data": mirrorOf(), ...separateKeys({ products: JSON.stringify([legacyProduct(9)]) }) });
  const db = await opened();
  const result = await db.migrateLegacy(ls);
  assert.equal(result.record.source, "browser-copy");
  assert.deepEqual((await db.loadAll()).products.map((p) => p.id), ["lp1", "lp2"]);
  assert.ok(result.record.notes.some((n) => /separate/.test(n)), "the choice is recorded");
});

test("migration only reads localStorage: nothing is written, changed or removed", async () => {
  const initial = { "invoisy-data": mirrorOf(), ...separateKeys() };
  const ls = fakeLocalStorage(initial);
  const db = await opened();
  await db.migrateLegacy(ls);
  assert.deepEqual(ls.calls, { set: [], remove: [] });
  assert.deepEqual(Object.fromEntries(ls.values), initial);
});

test("records the data file the previous version was using, so the person can be told", async () => {
  const factory = new fake.IDBFactory();
  const old = await new Promise((resolve, reject) => {
    const r = factory.open("invoisy-handle", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  await new Promise((resolve) => { const tx = old.transaction("kv", "readwrite"); tx.objectStore("kv").put({ name: "my-shop-data.json" }, "dataFile"); tx.oncomplete = resolve; });
  old.close();
  const db = await opened({ indexedDB: factory, name: "invoisy-handle" });
  const result = await db.migrateLegacy(fakeLocalStorage());
  assert.equal(result.record.legacyDataFile, "my-shop-data.json");
});

/* ---------- 8. Idempotency ---------- */

test("migration runs once: later launches change nothing, even if the old storage has new content", async () => {
  const factory = new fake.IDBFactory();
  const ls = fakeLocalStorage({ "invoisy-data": mirrorOf() });
  const first = await opened({ indexedDB: factory, name: "again" });
  assert.equal((await first.migrateLegacy(ls)).status, "migrated");
  const settled = await dump(first);
  first.close();

  // simulate closing the page and starting the app again, twice, with the old storage now different
  ls.values.set("invoisy-data", mirrorOf({ products: [legacyProduct(7)], invoiceCounter: 99 }));
  for (let launch = 0; launch < 2; launch++) {
    const next = await opened({ indexedDB: factory, name: "again" });
    const result = await next.migrateLegacy(ls);
    assert.equal(result.status, "already");
    assert.deepEqual(await dump(next), settled, "records, counter and revision are unchanged");
    next.close();
  }
});

test("two windows starting at the same moment migrate exactly once", async () => {
  const factory = new fake.IDBFactory();
  const ls = fakeLocalStorage({ "invoisy-data": mirrorOf() });
  const a = await opened({ indexedDB: factory, name: "race" });
  const b = await opened({ indexedDB: factory, name: "race" });
  const results = await Promise.all([a.migrateLegacy(ls), b.migrateLegacy(ls)]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["already", "migrated"]);
  const after = await dump(a);
  assert.equal(after.products.length, 2);
  assert.equal(after.invoices.length, 2);
});

/* ---------- 9. Malformed legacy data ---------- */

test("a value that is present but unusable is set aside, never silently turned into 0", async () => {
  const bad = [
    legacyProduct(3, { sellingPrice: "abc" }),         // would have become 0
    legacyProduct(4, { stock: 12.5, priceUnit: undefined }),   // no unit known: would have become 12
    legacyProduct(5, { stock: -4 }),
    legacyProduct(6, { purchasePrice: "n/a" }),        // would have lost the cost
    legacyProduct(7, { priceUnit: "pallet" }),
    { id: "noname", sellingPrice: 5, stock: 1 },
    "not even an object",
  ];
  const good = [legacyProduct(1), legacyProduct(2)];
  const ls = fakeLocalStorage({ "invoisy-data": mirrorOf({ products: [good[0], ...bad, good[1]] }) });
  const db = await opened();
  const result = await db.migrateLegacy(ls);

  const after = await db.loadAll();
  assert.deepEqual(after.products.map((p) => p.id), ["lp1", "lp2"], "only the usable products are imported");
  assert.equal(result.record.rejectedCount, bad.length);
  assert.equal(result.record.rejected.length, bad.length);
  const priceCase = result.record.rejected.find((r) => r.raw && r.raw.id === "lp3");
  assert.equal(priceCase.raw.sellingPrice, "abc", "the entry is kept exactly as it was stored");
  assert.match(priceCase.reason, /selling price/);
  assert.equal(ls.calls.set.length + ls.calls.remove.length, 0);
});

test("fractional stock is kept exactly when the stock unit is known (3 pieces out of 20 four-piece boxes leaves 19.25 boxes)", async () => {
  const ls = fakeLocalStorage({ "invoisy-data": mirrorOf({ products: [legacyProduct(1, { priceUnit: "m2", stockUnit: "box", stock: 19.25, tileSize: "60*60", coveragePerBox: 1.44 })] }) });
  const db = await opened();
  const result = await db.migrateLegacy(ls);
  assert.equal(result.status, "migrated");
  assert.equal(result.record.rejectedCount, 0);
  const [product] = (await db.loadAll()).products;
  assert.equal(product.stock, 19.25, "not rounded");
  assert.equal(product.stockUnit, "box");
});

test("an invoice with an unreadable payment or total is set aside; its payments are never silently dropped", async () => {
  const goodInvoice = legacyInvoices()[0];
  const badPayment = sampleInvoice({ number: 2, id: "li2", payments: [{ amount: 500, timestamp: iso(2) }, { amount: "oops", timestamp: iso(3) }] });
  const badTotal = sampleInvoice({ number: 3, id: "li3", total: "lots" });
  const badDate = sampleInvoice({ number: 4, id: "li4", date: "yesterday-ish" });
  const ls = fakeLocalStorage({ "invoisy-data": mirrorOf({ invoices: [goodInvoice, badPayment, badTotal, badDate] }) });
  const db = await opened();
  const result = await db.migrateLegacy(ls);

  assert.deepEqual((await db.loadAll()).invoices.map((i) => i.invoiceNumber), ["INV-000001"]);
  assert.equal(result.record.rejectedCount, 3);
  const kept = result.record.rejected.find((r) => r.raw.id === "li2");
  assert.equal(kept.raw.payments.length, 2, "the whole invoice, with both payments, is preserved in the record");
  assert.equal((await db.loadAll()).counter, 5, "the counter still covers numbers that were set aside");
});

test("repeated ids and invoice numbers: the first one is kept and the repeat is set aside, never merged", async () => {
  const [one] = legacyInvoices();
  const ls = fakeLocalStorage({
    "invoisy-data": mirrorOf({
      products: [legacyProduct(1), legacyProduct(1, { name: "Second copy", stock: 999 })],
      invoices: [
        one,
        { ...one, id: "different-id" },                          // same invoice number, other id -> set aside
        { ...one, id: "li-nine", invoiceNumber: "INV-000009" },  // genuinely different -> kept
        { ...one, invoiceNumber: "INV-000010" },                 // same id, other number -> set aside
      ],
    }),
  });
  const db = await opened();
  const result = await db.migrateLegacy(ls);
  const after = await db.loadAll();
  assert.equal(after.products.length, 1);
  assert.equal(after.products[0].name, "Legacy 1");
  assert.deepEqual(after.invoices.map((i) => i.invoiceNumber).sort(), ["INV-000001", "INV-000009"]);
  assert.equal(result.record.rejectedCount, 3, "the repeated product, the repeated number and the repeated id");
  assert.ok(result.record.rejected.some((r) => r.raw && r.raw.name === "Second copy"));
});

test("a damaged key is recorded as set aside, the readable keys are still migrated", async () => {
  const ls = fakeLocalStorage(separateKeys({ products: "[{broken json", invoiceCounter: "9" }));
  const db = await opened();
  const result = await db.migrateLegacy(ls);
  assert.equal(result.status, "migrated");
  assert.equal((await db.loadAll()).invoices.length, 2);
  assert.equal(result.record.rejectedCount, 1);
  assert.equal(result.record.rejected[0].kind, "stored-products");
  assert.equal(result.record.rejected[0].raw, "[{broken json", "the damaged text is kept as it was");
  assert.equal(ls.values.get("products"), "[{broken json", "and still in localStorage");
});

test("when nothing in the old storage can be read, migration fails safely and can be retried", async () => {
  const ls = fakeLocalStorage({ "invoisy-data": "{{{ not json", products: "also broken", invoices: "[", settings: "}", invoiceCounter: "x" });
  const db = await opened();
  await assert.rejects(db.migrateLegacy(ls), (e) => e.code === "MIGRATION" && /could not read any of it/i.test(e.message));
  assert.equal(await db.getMigrationRecord(), null, "no completion marker, so the next start tries again");
  assert.equal((await dump(db)).revision, 0, "nothing was written");
  assert.deepEqual(ls.calls, { set: [], remove: [] });

  // the person repairs it (here: a valid browser copy appears) and the retry succeeds
  ls.values.set("invoisy-data", mirrorOf());
  assert.equal((await db.migrateLegacy(ls)).status, "migrated");
});

test("starting with empty data after unreadable old data is an explicit choice and leaves the old data alone", async () => {
  const ls = fakeLocalStorage({ products: "broken" });
  const db = await opened();
  await assert.rejects(db.migrateLegacy(ls), (e) => e.code === "MIGRATION");
  await db.skipMigration("test");
  assert.equal((await db.migrateLegacy(ls)).status, "already");
  assert.equal((await db.getMigrationRecord()).status, "skipped");
  assert.equal(ls.values.get("products"), "broken");
});

test("an empty install (nothing worth keeping) just records that the migration is done", async () => {
  const empty = JSON.stringify({ version: 1, lastSaved: iso(1), products: [], invoices: [], settings: V.DEFAULT_SETTINGS, invoiceCounter: 0 });
  for (const ls of [fakeLocalStorage(), fakeLocalStorage({ "invoisy-data": empty })]) {
    const db = await opened();
    const result = await db.migrateLegacy(ls);
    assert.equal(result.status, "nothing-to-migrate");
    assert.equal((await dump(db)).revision, 0);
    assert.equal((await db.migrateLegacy(ls)).status, "already");
  }
});

/* ---------- 18. Conflicting datasets ---------- */

test("when the database already has data and so does the old storage, the database wins and nothing is merged", async () => {
  const initial = { "invoisy-data": mirrorOf() };
  const ls = fakeLocalStorage(initial);
  const db = await opened();
  await db.add("products", sampleProduct({ id: "already-here", name: "Entered in the new version" }));
  const before = await dump(db);

  const result = await db.migrateLegacy(ls);
  assert.equal(result.status, "conflict");
  assert.deepEqual(result.record.legacyCounts, { products: 2, invoices: 2 });
  assert.deepEqual(result.record.counts, { products: 1, invoices: 0 });
  assert.deepEqual(await dump(db), before, "the database is exactly as it was");
  assert.deepEqual(Object.fromEntries(ls.values), initial, "the old data is untouched");
  assert.equal((await db.migrateLegacy(ls)).status, "already", "and it is not looked at again on later launches");
});

test("a copy of the old data can be downloaded after a conflict and restored later", async () => {
  const ls = fakeLocalStorage({ "invoisy-data": mirrorOf({ products: [legacyProduct(1), legacyProduct(2, { stock: -1 })] }) });
  const copy = V.prepareLegacyCopy(ls, new Date(2026, 9, 9));
  assert.equal(copy.restorable, true);
  assert.equal(copy.name, "invoisy-old-browser-data-2026-10-09.json");
  const parsed = V.parseBackup(copy.text);
  assert.equal(parsed.error, undefined, "the copy is a normal backup the person can restore");
  assert.equal(parsed.data.products.length, 1);
  const file = JSON.parse(copy.text);
  assert.equal(file.legacyCopy.unreadableEntries.length, 1, "entries that were set aside travel with the copy");
  assert.equal(typeof file.legacyCopy.rawStoredText["invoisy-data"], "string", "and so does the exact stored text");

  const unreadable = V.prepareLegacyCopy(fakeLocalStorage({ products: "broken" }), new Date());
  assert.equal(unreadable.restorable, false);
  assert.equal(V.prepareLegacyCopy(fakeLocalStorage(), new Date()).error, "No older browser data was found.");
});

/* ---------- Cleaning up the old copy is guarded ---------- */

test("the old browser copy can only be removed once the data is safe elsewhere", async () => {
  const ls = fakeLocalStorage({ "invoisy-data": mirrorOf(), ...separateKeys() });
  const db = await opened();
  await db.migrateLegacy(ls);
  const before = await dump(db);

  await assert.rejects(db.removeLegacyData(ls), (e) => e.code === "INVALID", "refused: no backup has been exported yet");
  assert.deepEqual(ls.calls.remove, []);

  await db.recordBackup({ at: iso(30), fileName: "invoisy-backup-2026-10-01.json", counts: { products: 2, invoices: 2 } });
  await db.removeLegacyData(ls);
  assert.deepEqual(ls.calls.remove.sort(), ["invoice-placeholder"].filter(() => false).concat(["invoiceCounter", "invoices", "invoisy-data", "products", "settings"]).sort());
  assert.equal((await db.getMigrationRecord()).legacyRetained, false);
  assert.deepEqual(await dump(db), before, "the database is not affected");
});

test("after a conflict the old data can only be removed once a copy of it has been downloaded", async () => {
  const ls = fakeLocalStorage({ "invoisy-data": mirrorOf() });
  const db = await opened();
  await db.add("products", sampleProduct({ id: "mine" }));
  await db.migrateLegacy(ls);
  await db.recordBackup({ at: iso(30), fileName: "x.json", counts: null });   // a backup of the NEW data is not enough
  await assert.rejects(db.removeLegacyData(ls), (e) => e.code === "INVALID");
  await db.updateMigrationRecord({ legacyCopyDownloadedAt: iso(31) });
  await db.removeLegacyData(ls);
  assert.equal(ls.values.size, 0);
});

/* ---------- Failure and verification ---------- */

test("a write failure during migration leaves no data, no marker and the old data untouched; the retry works", async () => {
  const ls = fakeLocalStorage({ "invoisy-data": mirrorOf() });
  const db = await opened();
  const restore = failPutWith("QuotaExceededError", 2);
  try {
    await assert.rejects(db.migrateLegacy(ls), (e) => e.code === "QUOTA");
  } finally {
    restore();
  }
  assert.equal(await db.getMigrationRecord(), null);
  const empty = await dump(db);
  assert.deepEqual([empty.products.length, empty.invoices.length, empty.revision], [0, 0, 0], "no half-migrated data");
  assert.deepEqual(ls.calls, { set: [], remove: [] });

  assert.equal((await db.migrateLegacy(ls)).status, "migrated");
  assert.equal((await dump(db)).products.length, 2);
});

test("if what was written does not read back identically, the migration is aborted before it commits", async () => {
  const ls = fakeLocalStorage({ "invoisy-data": mirrorOf() });
  const db = await opened();
  const original = V.sameValue;
  V.sameValue = () => false;                   // every comparison "differs"
  try {
    await assert.rejects(db.migrateLegacy(ls), (e) => e.code === "VERIFY");
  } finally {
    V.sameValue = original;
  }
  assert.equal(await db.getMigrationRecord(), null);
  assert.equal((await dump(db)).products.length, 0);
});

test("the notice about a migration is recorded as shown so it is not repeated", async () => {
  const db = await opened();
  const result = await db.migrateLegacy(fakeLocalStorage({ "invoisy-data": mirrorOf() }));
  assert.equal(result.record.noticeShown, false);
  await db.updateMigrationRecord({ noticeShown: true });
  assert.equal((await db.getMigrationRecord()).noticeShown, true);
  assert.equal((await db.migrateLegacy(fakeLocalStorage())).record.noticeShown, true);
});

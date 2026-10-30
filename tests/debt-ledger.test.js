"use strict";

// The debt-transfer ledger at the database level: the migration from version 2, the invariant that keeps every
// debt collectible once, and the cascade rules. Disposable in-memory IndexedDB only.

const test = require("node:test");
const assert = require("node:assert/strict");
const { fake, V, DB, newDb, sampleProduct, sampleInvoice } = require("./helpers/modules");

const plain = (x) => JSON.parse(JSON.stringify(x));
const opened = (factory, name, version, upgrade) => new Promise((resolve, reject) => {
  const request = factory.open(name, version);
  if (upgrade) request.onupgradeneeded = () => upgrade(request.result);
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

// Two invoices of one customer: INV-1 (total 1,000, nothing paid) and a newer INV-2 (total 500).
const customer = { name: "Karim Benali", phone: "0555112233", address: "" };
const older = () => sampleInvoice({ number: 1, id: "i-1", customer, total: 1000, subtotal: 1000, discount: 0, payments: [], items: [{ ...sampleInvoice().items[0], qty: 1, total: 1000 }] });
const newer = (carriedAmount) => sampleInvoice({
  number: 2, id: "i-2", customer, total: 500, subtotal: 500, discount: 0, payments: [],
  items: [{ ...sampleInvoice().items[0], qty: 1, unitPrice: 500, total: 500 }],
  ...(carriedAmount ? { carriedForward: [{ transferId: "t-1", sourceInvoiceId: "i-1", sourceInvoiceNumber: "INV-000001", sourceDate: older().date, amount: carriedAmount }] } : {}),
});
const transfer = (amount, extra) => ({
  id: "t-1", sourceInvoiceId: "i-1", sourceInvoiceNumber: "INV-000001", targetInvoiceId: "i-2", targetInvoiceNumber: "INV-000002",
  amount, createdAt: new Date().toISOString(), sourceTotal: 1000, sourcePaid: 0, availableBefore: 1000, availableAfter: 1000 - amount, ...extra,
});

async function readyDb() {
  const db = newDb();
  await db.initDatabase();
  await db.commitChanges({ products: { put: [sampleProduct({ id: "p-1" })], remove: [] }, invoices: { put: [older()], remove: [] } });
  return db;
}

test("migration: a version 2 database upgrades to the current version without changing any record", async () => {
  const factory = new fake.IDBFactory();
  const v2 = await opened(factory, "old", 2, (d) => {
    d.createObjectStore("kv");
    const p = d.createObjectStore("products", { keyPath: "id" }); p.createIndex("sku", "sku"); p.createIndex("name", "name");
    const i = d.createObjectStore("invoices", { keyPath: "id" }); i.createIndex("invoiceNumber", "invoiceNumber", { unique: true }); i.createIndex("date", "date");
    d.createObjectStore("settings", { keyPath: "key" });
    d.createObjectStore("counters", { keyPath: "name" });
    d.createObjectStore("meta", { keyPath: "key" });
  });
  const stored = older();
  await new Promise((resolve, reject) => {
    const tx = v2.transaction(["invoices", "counters"], "readwrite");
    tx.objectStore("invoices").put(stored);
    tx.objectStore("counters").put({ name: "invoice", value: 1 });
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
  v2.close();

  const db = newDb({ indexedDB: factory, name: "old" });
  const info = await db.initDatabase();
  assert.equal(info.version, DB.DB_VERSION);
  assert.equal(info.version, 5);
  const all = await db.loadAll();
  for (const field of ["id", "invoiceNumber", "date", "total", "subtotal", "discount", "tax"]) assert.deepEqual(plain(all.invoices[0][field]), plain(stored[field]), field);
  assert.deepEqual(plain(all.invoices[0].customer), plain(stored.customer));
  assert.equal(all.invoices[0].carriedForward, undefined);
  assert.equal(all.invoices[0].id, "i-1");
  assert.deepEqual(plain(all.invoices[0].payments), []);
  assert.deepEqual(all.debtTransfers, []);
  assert.equal(all.counter, 1);
});

test("a transfer is saved with the new invoice in one commit and read back", async () => {
  const db = await readyDb();
  await db.commitChanges({ invoices: { put: [newer(400)], remove: [] }, debtTransfers: { put: [transfer(400)], remove: [] } });
  const all = await db.loadAll();
  assert.equal(all.debtTransfers.length, 1);
  assert.equal(all.debtTransfers[0].amount, 400);
  assert.equal(all.invoices.length, 2);
});

test("the ledger can never move more than is still owed (paid + transferred out <= amount due)", async () => {
  const db = await readyDb();
  await assert.rejects(db.commitChanges({ invoices: { put: [newer(1200)], remove: [] }, debtTransfers: { put: [transfer(1200)], remove: [] } }), (e) => e.code === "INVALID");
  // a payment recorded after a 400 transfer may not take the invoice past what is still collectible there
  await db.commitChanges({ invoices: { put: [newer(400)], remove: [] }, debtTransfers: { put: [transfer(400)], remove: [] } });
  const source = (await db.loadAll()).invoices.find((i) => i.id === "i-1");
  await assert.rejects(db.commitChanges({ invoices: { put: [{ ...source, payments: [{ amount: 700, timestamp: new Date().toISOString() }] }], remove: [] } }), (e) => e.code === "INVALID");
  await db.commitChanges({ invoices: { put: [{ ...source, payments: [{ amount: 600, timestamp: new Date().toISOString() }] }], remove: [] } });
  assert.equal((await db.loadAll()).invoices.find((i) => i.id === "i-1").payments[0].amount, 600);
});

test("a transfer without the matching line on the new invoice, or to an older invoice, is refused and nothing is written", async () => {
  const db = await readyDb();
  const before = plain(await db.loadAll());
  await assert.rejects(db.commitChanges({ invoices: { put: [newer(0)], remove: [] }, debtTransfers: { put: [transfer(400)], remove: [] } }), (e) => e.code === "INVALID");
  await assert.rejects(db.commitChanges({ invoices: { put: [newer(300)], remove: [] }, debtTransfers: { put: [transfer(400)], remove: [] } }), (e) => e.code === "INVALID");
  await assert.rejects(db.commitChanges({ invoices: { put: [newer(400)], remove: [] }, debtTransfers: { put: [transfer(400, { targetInvoiceId: "i-1", targetInvoiceNumber: "INV-000001" })], remove: [] } }), (e) => e.code === "INVALID");
  assert.deepEqual(plain(await db.loadAll()), before);
});

test("an invoice for another customer can not receive the debt", async () => {
  const db = await readyDb();
  const stranger = { ...newer(400), customer: { name: "Someone Else", phone: "0777000000", address: "" } };
  await assert.rejects(db.commitChanges({ invoices: { put: [stranger], remove: [] }, debtTransfers: { put: [transfer(400)], remove: [] } }), (e) => e.code === "INVALID");
});

test("removing the carrying invoice removes its ledger records; removing a source that has transfers is refused", async () => {
  const db = await readyDb();
  await db.commitChanges({ invoices: { put: [newer(400)], remove: [] }, debtTransfers: { put: [transfer(400)], remove: [] } });
  await assert.rejects(db.commitChanges({ invoices: { put: [], remove: ["i-1"] } }), (e) => e.code === "INVALID");
  await db.commitChanges({ invoices: { put: [], remove: ["i-2"] } });
  const all = await db.loadAll();
  assert.deepEqual(all.debtTransfers, [], "the cascade restores the balance on the old invoice");
  assert.deepEqual(all.invoices.map((i) => i.id), ["i-1"]);
});

test("a backup with ledger records restores in full and an inconsistent one is refused", async () => {
  const db = await readyDb();
  await db.commitChanges({ invoices: { put: [newer(400)], remove: [] }, debtTransfers: { put: [transfer(400)], remove: [] } });
  const all = await db.loadAll();
  const backup = V.buildBackup({ ...all, lastSaved: "" });
  const text = JSON.stringify(backup);
  assert.equal(JSON.parse(text).data.debtTransfers.length, 1);
  const parsed = V.parseBackup(text);
  assert.equal(parsed.error, undefined, parsed.error);
  assert.equal(parsed.data.debtTransfers.length, 1);

  const target = newDb();
  await target.initDatabase();
  await target.restore(parsed.data);
  assert.equal((await target.loadAll()).debtTransfers.length, 1);

  const forged = JSON.parse(text);
  forged.data.debtTransfers[0].amount = 5000;
  assert.ok(V.parseBackup(JSON.stringify(forged)).error);
  const orphan = JSON.parse(text);
  orphan.data.invoices = orphan.data.invoices.filter((i) => i.id !== "i-2");
  assert.ok(V.parseBackup(JSON.stringify(orphan)).error);
});

test("a database without any transfer writes backups exactly as before (no new field)", async () => {
  const db = await readyDb();
  const backup = V.buildBackup({ ...(await db.loadAll()), lastSaved: "" });
  assert.equal("debtTransfers" in backup.data, false);
  assert.equal(backup.formatVersion, V.BACKUP_FORMAT_VERSION, "the backup format version is not changed by the debt feature");
});

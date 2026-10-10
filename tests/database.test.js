"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { fake, V, DB, newDb, sampleProduct, sampleInvoice, dump, failPutWith } = require("./helpers/modules");

const names = (list) => Array.from(list).sort();
const rawOpen = (factory, name, version, upgrade) => new Promise((resolve, reject) => {
  const request = factory.open(name, version);
  if (upgrade) request.onupgradeneeded = () => upgrade(request.result, request.transaction);
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

async function rejectsWithCode(promise, code) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    assert.ok(e.message.length > 20, "the message should explain what happened");
    return true;
  });
}

/* ---------- 1. Initialization ---------- */

test("initDatabase creates the versioned schema with its stores and indexes", async () => {
  const factory = new fake.IDBFactory();
  const db = newDb({ indexedDB: factory, name: "schema" });
  const info = await db.initDatabase();
  assert.equal(info.version, DB.DB_VERSION);
  assert.equal((await db.initDatabase()).version, DB.DB_VERSION, "calling it twice is harmless");

  const raw = await rawOpen(factory, "schema");
  assert.deepEqual(names(raw.objectStoreNames), ["counters", "invoices", "meta", "products", "settings"]);
  const tx = raw.transaction(["invoices", "products"]);
  assert.equal(tx.objectStore("invoices").index("invoiceNumber").unique, true, "invoice numbers must be unique");
  assert.ok(tx.objectStore("invoices").indexNames.contains("date"));
  assert.ok(tx.objectStore("products").indexNames.contains("sku"));
  raw.close();
});

test("a fresh database starts empty with counter 0 and default settings", async () => {
  const db = newDb();
  await db.initDatabase();
  const all = await db.loadAll();
  assert.deepEqual([all.products.length, all.invoices.length, all.counter, all.revision], [0, 0, 0, 0]);
  assert.deepEqual(all.settings, V.DEFAULT_SETTINGS);
  assert.equal(await db.getNextInvoiceNumber(), "INV-000001");
});

test("upgrading the version 1 database keeps the old file-handle store and its content untouched", async () => {
  const factory = new fake.IDBFactory();
  const old = await rawOpen(factory, "legacy", 1, (d) => d.createObjectStore("kv"));
  await new Promise((resolve, reject) => {
    const tx = old.transaction("kv", "readwrite");
    tx.objectStore("kv").put({ name: "invoisy-data.json" }, "dataFile");
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  old.close();

  const db = newDb({ indexedDB: factory, name: "legacy" });
  await db.initDatabase();
  assert.deepEqual(await db.getById("kv", "dataFile"), { name: "invoisy-data.json" });
  assert.equal((await db.loadAll()).products.length, 0);
});

test("using the database before it is opened fails with a clear error and writes nothing", async () => {
  const db = newDb();
  await rejectsWithCode(db.loadAll(), "CLOSED");
  await rejectsWithCode(db.commitChanges({ settings: V.DEFAULT_SETTINGS }), "CLOSED");
});

/* ---------- 2-4. Create, read, update, delete; products; invoices ---------- */

test("create, read, update and delete a product", async () => {
  const db = newDb();
  await db.initDatabase();
  const p = sampleProduct({ id: "p1" });
  const added = await db.add("products", p);
  assert.equal(added.revision, 1);
  assert.deepEqual(await db.getById("products", "p1"), p);
  assert.equal((await db.getAll("products")).length, 1);

  await db.update("products", { ...p, stock: 7, name: "Everton Grey 2" });
  const updated = await db.getById("products", "p1");
  assert.equal(updated.stock, 7);
  assert.equal(updated.name, "Everton Grey 2");

  await db.remove("products", "p1");
  assert.equal(await db.getById("products", "p1"), undefined);
  assert.equal(await db.count("products"), 0);
});

test("add refuses an id that exists, update refuses a missing record, and neither changes anything", async () => {
  const db = newDb();
  await db.initDatabase();
  const p = sampleProduct({ id: "p1" });
  await db.add("products", p);
  const before = await dump(db);
  await rejectsWithCode(db.add("products", { ...p, stock: 99 }), "CONSTRAINT");
  await rejectsWithCode(db.update("products", sampleProduct({ id: "ghost" })), "INVALID");
  assert.deepEqual(await dump(db), before);
});

test("products keep every field, including ones this version does not know about", async () => {
  const db = newDb();
  await db.initDatabase();
  const p = sampleProduct({ id: "p1", notes: "keep me", supplierCode: 42, priceUnit: null, purchasePrice: null, coveragePerBox: null });
  await db.add("products", p);
  const back = await db.getById("products", "p1");
  assert.equal(back.notes, "keep me");
  assert.equal(back.supplierCode, 42);
  assert.equal(back.priceUnit, null);
  assert.equal(back.purchasePrice, null);
  assert.deepEqual(back, p);
});

test("invoices are saved and read back exactly, without the derived paid/remaining/status fields", async () => {
  const db = newDb();
  await db.initDatabase();
  const inv = sampleInvoice({ number: 1 });
  await db.add("invoices", { ...inv, amountPaid: 123, remaining: 456, status: "unpaid" });   // derived fields must never be trusted
  const [stored] = await db.getAll("invoices");
  assert.deepEqual(stored, inv);
  assert.equal("amountPaid" in stored, false);
  assert.equal(V.paymentSummary(stored).cls, "partial");
});

test("loadAll returns invoices in the order they were issued, not in id order", async () => {
  const db = newDb();
  await db.initDatabase();
  await db.commitChanges({ invoices: { put: [sampleInvoice({ number: 3, id: "a-3" }), sampleInvoice({ number: 1, id: "z-1" }), sampleInvoice({ number: 2, id: "m-2" })], remove: [] } });
  assert.deepEqual((await db.loadAll()).invoices.map((i) => i.invoiceNumber), ["INV-000001", "INV-000002", "INV-000003"]);
});

/* ---------- 5. Invoice numbers and payment histories ---------- */

test("invoice numbers and payment histories are preserved exactly", async () => {
  const db = newDb();
  await db.initDatabase();
  const inv = sampleInvoice({
    number: 41,
    total: 1900,
    payments: [{ amount: 500, timestamp: "2026-10-01T10:00:00.000Z" }, { amount: 100.005, timestamp: "2026-10-02T10:00:00.000Z" }, { amount: 1299.995, timestamp: "2026-10-03T10:00:00.000Z" }],
  });
  await db.commitChanges({ invoices: { put: [inv], remove: [] } });
  const back = (await db.loadAll()).invoices[0];
  assert.equal(back.invoiceNumber, "INV-000041");
  assert.deepEqual(back.payments, inv.payments, "no payment amount may be rounded or reordered");
  assert.equal(await db.getNextInvoiceNumber(), "INV-000042");
});

test("the invoice counter follows the invoices and never goes backwards", async () => {
  const db = newDb();
  await db.initDatabase();
  await db.commitChanges({ invoices: { put: [sampleInvoice({ number: 7 })], remove: [] } });
  assert.equal(await db.getInvoiceCounter(), 7, "saving invoice 7 raises the counter to 7");
  await rejectsWithCode(db.commitChanges({ counter: { next: 3 } }), "INVALID");
  assert.equal(await db.getInvoiceCounter(), 7);
  await db.remove("invoices", "i-7");
  assert.equal(await db.getInvoiceCounter(), 7, "deleting an invoice never frees its number");
  assert.equal(await db.getNextInvoiceNumber(), "INV-000008");
});

test("settings are saved and validated", async () => {
  const db = newDb();
  await db.initDatabase();
  await db.saveSettings({ ...V.DEFAULT_SETTINGS, businessName: "Tiles & Co", currency: "EUR", paper: "A5" });
  const settings = await db.getSettings();
  assert.deepEqual([settings.businessName, settings.currency, settings.paper], ["Tiles & Co", "EUR", "A5"]);
  await rejectsWithCode(db.saveSettings({ ...V.DEFAULT_SETTINGS, paper: "Letter" }), "INVALID");
  await rejectsWithCode(db.saveSettings({ ...V.DEFAULT_SETTINGS, currency: "  " }), "INVALID");
  await rejectsWithCode(db.saveSettings({ ...V.DEFAULT_SETTINGS, logo: "javascript:alert(1)" }), "INVALID");
  assert.equal((await db.getSettings()).paper, "A5");
});

/* ---------- 6. Atomic stock and invoice updates ---------- */

async function dbWithStock(stock) {
  const db = newDb();
  await db.initDatabase();
  const p = sampleProduct({ id: "p-1", stock });
  await db.commitChanges({ products: { put: [p], remove: [] } });
  return { db, p };
}

function saleChanges(p, number, qty) {
  return {
    products: { put: [{ ...p, stock: p.stock - qty }], remove: [] },
    invoices: { put: [sampleInvoice({ number })], remove: [] },
    counter: { next: number },
  };
}

test("a sale saves the invoice, the lower stock and the counter together", async () => {
  const { db, p } = await dbWithStock(20);
  const result = await db.commitChanges(saleChanges(p, 1, 2), { expectedRevision: 1 });
  assert.equal(result.revision, 2);
  const after = await db.loadAll();
  assert.equal(after.products[0].stock, 18);
  assert.equal(after.invoices.length, 1);
  assert.equal(after.counter, 1);
});

test("a sale whose invoice number is already used saves nothing, not even the stock change", async () => {
  const { db, p } = await dbWithStock(20);
  await db.commitChanges(saleChanges(p, 1, 2), { expectedRevision: 1 });
  const before = await dump(db);
  const duplicate = { ...saleChanges({ ...p, stock: 18 }, 1, 3), invoices: { put: [sampleInvoice({ number: 1, id: "other-id" })], remove: [] } };
  await rejectsWithCode(db.commitChanges(duplicate, { expectedRevision: 2 }), "CONSTRAINT");
  assert.deepEqual(await dump(db), before, "stock, invoices, counter and revision are all untouched");
});

test("a sale with an invalid invoice or negative stock is refused before anything is written", async () => {
  const { db, p } = await dbWithStock(20);
  const before = await dump(db);
  await rejectsWithCode(db.commitChanges({ ...saleChanges(p, 1, 2), invoices: { put: [sampleInvoice({ number: 1, total: -5 })], remove: [] } }), "INVALID");
  await rejectsWithCode(db.commitChanges({ ...saleChanges(p, 1, 2), products: { put: [{ ...p, stock: -3 }], remove: [] } }), "INVALID");
  await rejectsWithCode(db.commitChanges({ ...saleChanges(p, 1, 2), products: { put: [{ ...p, stock: NaN }], remove: [] } }), "INVALID");
  await rejectsWithCode(db.commitChanges({ ...saleChanges(p, 1, 2), products: { put: [{ ...p, stock: "5" }], remove: [] } }), "INVALID");
  assert.deepEqual(await dump(db), before);
});

test("a window with out-of-date data can not overwrite newer data", async () => {
  const { db, p } = await dbWithStock(20);                                  // revision 1
  await db.commitChanges(saleChanges(p, 1, 2), { expectedRevision: 1 });  // another window saved: revision 2
  const before = await dump(db);
  await rejectsWithCode(db.commitChanges(saleChanges(p, 1, 5), { expectedRevision: 1 }), "CONFLICT");
  assert.deepEqual(await dump(db), before);
});

/* ---------- 16. Transaction failures ---------- */

test("a write failure at ANY point of a sale rolls the whole sale back and reports the real reason", async () => {
  // A sale does: product put (1), invoice put (2), counter put (3), revision put (4).
  for (const failingCall of [1, 2, 3, 4]) {
    const { db, p } = await dbWithStock(20);
    const before = await dump(db);
    const restore = failPutWith("QuotaExceededError", failingCall);
    try {
      await rejectsWithCode(db.commitChanges(saleChanges(p, 1, 2), { expectedRevision: 1 }), "QUOTA");
    } finally {
      restore();
    }
    assert.deepEqual(await dump(db), before, `nothing may be saved when write #${failingCall} fails`);
    // and the database is still usable afterwards
    const retry = await db.commitChanges(saleChanges(p, 1, 2), { expectedRevision: 1 });
    assert.equal(retry.revision, 2);
  }
});

test("the quota message tells the person what to do", async () => {
  const { db, p } = await dbWithStock(20);
  const restore = failPutWith("QuotaExceededError", 1);
  try {
    await assert.rejects(db.commitChanges(saleChanges(p, 1, 2)), (e) => /no storage space/i.test(e.message) && /backup/i.test(e.message));
  } finally {
    restore();
  }
});

/* ---------- 18. Duplicates inside one change ---------- */

test("two records with the same id or invoice number in one change are refused", async () => {
  const db = newDb();
  await db.initDatabase();
  const p = sampleProduct({ id: "dup" });
  await rejectsWithCode(db.commitChanges({ products: { put: [p, { ...p, name: "Other" }], remove: [] } }), "INVALID");
  await rejectsWithCode(db.commitChanges({ invoices: { put: [sampleInvoice({ number: 1, id: "a" }), sampleInvoice({ number: 1, id: "b" })], remove: [] } }), "INVALID");
  await rejectsWithCode(db.commitChanges({ invoices: { put: [sampleInvoice({ number: 1, id: "a" }), sampleInvoice({ number: 2, id: "a" })], remove: [] } }), "INVALID");
  assert.equal((await dump(db)).revision, 0, "nothing was written");
});

/* ---------- 19. Database unavailable ---------- */

test("no IndexedDB at all is reported as unavailable", async () => {
  const db = DB.create({ indexedDB: null, channel: false });
  assert.equal(typeof globalThis.indexedDB, "undefined", "this test needs a process without IndexedDB");
  await rejectsWithCode(db.initDatabase(), "UNAVAILABLE");
  await rejectsWithCode(db.commitChanges({ settings: V.DEFAULT_SETTINGS }), "UNAVAILABLE");
});

test("a browser that refuses to open the database (security / private mode / backing store) is unavailable", async () => {
  const throwing = { open() { throw new DOMException("denied", "SecurityError"); } };
  await rejectsWithCode(newDb({ indexedDB: throwing }).initDatabase(), "UNAVAILABLE");

  const failing = {
    open() {
      const request = {};
      setTimeout(() => { request.error = new DOMException("Internal error opening backing store", "UnknownError"); request.onerror(); });
      return request;
    },
  };
  await rejectsWithCode(newDb({ indexedDB: failing }).initDatabase(), "UNAVAILABLE");
});

test("a database made by a newer version is refused without touching it", async () => {
  const factory = new fake.IDBFactory();
  const future = await rawOpen(factory, "future", 9, (d) => d.createObjectStore("something"));
  future.close();
  await rejectsWithCode(newDb({ indexedDB: factory, name: "future" }).initDatabase(), "VERSION");
  const again = await rawOpen(factory, "future");
  assert.equal(again.version, 9);
  assert.deepEqual(names(again.objectStoreNames), ["something"]);
  again.close();
});

test("another window upgrading the database closes this connection and further saves are refused", async () => {
  const factory = new fake.IDBFactory();
  const db = newDb({ indexedDB: factory, name: "shared" });
  await db.initDatabase();
  let versionChange = 0;
  db.on("versionchange", () => versionChange++);
  const newer = await rawOpen(factory, "shared", DB.DB_VERSION + 1, () => {});
  newer.close();
  assert.equal(versionChange, 1);
  await rejectsWithCode(db.commitChanges({ settings: V.DEFAULT_SETTINGS }), "CLOSED");
});

test("an update that is blocked by another open window is announced so the person can close it", async () => {
  const factory = new fake.IDBFactory();
  const holder = await rawOpen(factory, "blocked", 1, (d) => d.createObjectStore("kv"));   // never closes itself
  const db = newDb({ indexedDB: factory, name: "blocked" });
  let blocked = 0;
  db.on("blocked", () => blocked++);
  const opening = db.initDatabase();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(blocked, 1);
  holder.close();
  assert.equal((await opening).version, DB.DB_VERSION);
});

/* ---------- Diffs: only what changed is written ---------- */

test("diff reports only the records that changed", () => {
  const a = sampleProduct({ id: "a" });
  const b = sampleProduct({ id: "b" });
  const c = sampleProduct({ id: "c" });
  const before = { products: [a, b, c], invoices: [], settings: V.DEFAULT_SETTINGS, counter: 4 };
  const after = { products: [a, { ...b, stock: b.stock - 1 }], invoices: [sampleInvoice({ number: 5 })], settings: V.DEFAULT_SETTINGS, counter: 5 };
  const changes = DB.diff(before, after);
  assert.deepEqual(changes.products.put.map((p) => p.id), ["b"]);
  assert.deepEqual(changes.products.remove, ["c"]);
  assert.deepEqual(changes.invoices.put.map((i) => i.invoiceNumber), ["INV-000005"]);
  assert.deepEqual(changes.counter, { next: 5 });
  assert.equal(changes.settings, null);
  assert.equal(DB.isEmptyChange(DB.diff(before, structuredClone(before))), true);
});

/* ---------- Events ---------- */

test("a save in one connection is announced to the other windows", async () => {
  const factory = new fake.IDBFactory();
  const messages = [];
  const channels = new Map();
  class FakeChannel {
    constructor(name) { this.name = name; (channels.get(name) || channels.set(name, new Set()).get(name)).add(this); }
    postMessage(data) { for (const other of channels.get(this.name)) if (other !== this) setTimeout(() => other.onmessage({ data })); }
    close() { channels.get(this.name).delete(this); }
  }
  globalThis.BroadcastChannel = FakeChannel;
  try {
    const first = DB.create({ indexedDB: factory, name: "chan" });
    const second = DB.create({ indexedDB: factory, name: "chan" });
    await first.initDatabase();
    await second.initDatabase();
    second.on("change", (m) => messages.push(m.revision));
    first.on("change", () => assert.fail("a window must not be told about its own save"));
    await first.commitChanges({ settings: { ...V.DEFAULT_SETTINGS, businessName: "Changed" } });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(messages, [1]);
    first.close();
    second.close();
  } finally {
    delete globalThis.BroadcastChannel;
  }
});

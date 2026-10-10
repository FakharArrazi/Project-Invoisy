"use strict";

// The real page scripts running against a disposable in-memory IndexedDB:
// a complete business day, atomic sales, two windows at once, and storage that is missing or full.

const test = require("node:test");
const assert = require("node:assert/strict");
const { fake, V, iso, sampleProduct, sampleInvoice, fakeLocalStorage, dump, failPutWith } = require("./helpers/modules");
const { loadApp } = require("./helpers/app");

const plain = (x) => JSON.parse(JSON.stringify(x));

async function startedApp(options) {
  const app = loadApp(options);
  const storage = await app.start();
  assert.equal(storage.mode, "ready", storage.reason);
  return app;
}

const tileValues = (overrides) => {
  const { id, ...values } = sampleProduct({ name: "Everton Grey", tileSize: "60*60", coveragePerBox: 1.44, sku: "EV-60", sellingPrice: 800, priceUnit: "m2", purchasePrice: 600, stock: 10, ...overrides });
  return values;
};

// Puts a product on the sale screen the way a click would, then completes the sale.
async function sell(app, productId, qty, unit, { paid, customer } = {}) {
  const added = app.api.addToSale(productId, String(qty), unit);
  assert.equal(added.ok, true, added.error);
  const sale = app.api.getSale();
  if (paid !== undefined) sale.paidValue = String(paid);
  if (customer) sale.customer.name = customer;
  await app.api.completeSale();
}

/* ---------- 20. A complete, realistic workflow ---------- */

test("realistic workflow: product, stock, sale, partial and final payment, export, restore into a new database", async () => {
  const app = await startedApp();
  const state = app.api.getState();
  assert.deepEqual([state.products.length, state.invoices.length, state.counter], [0, 0, 0]);

  // 1. create a product (800 DA per m², 1.44 m² per box, so a box costs 1,152 DA) with 10 boxes
  await app.api.addProduct(tileValues());
  assert.equal(state.products.length, 1);
  const id = state.products[0].id;
  assert.equal((await app.api.db.loadAll()).products[0].stock, 10, "saved in IndexedDB");

  // 2. add stock: 10 + 5
  const restock = await app.api.addStock(id, "5");
  assert.equal(restock.error, undefined);
  assert.equal(state.products[0].stock, 15);

  // 3. sell 2 boxes, 1,000 DA paid now: one transaction creates the invoice, deducts the stock, advances the counter
  await sell(app, id, 2, "box", { paid: 1000, customer: "Karim" });
  assert.equal(state.invoices.length, 1);
  const first = state.invoices[0];
  assert.equal(first.invoiceNumber, "INV-000001");
  assert.equal(first.total, 2304);
  assert.equal(first.customer.name, "Karim");
  assert.deepEqual(plain(first.payments).map((p) => p.amount), [1000]);
  assert.equal(state.products[0].stock, 13);
  assert.equal(state.counter, 1);
  let stored = await app.api.db.loadAll();
  assert.equal(stored.products[0].stock, 13, "the database agrees with the screen");
  assert.equal(stored.invoices.length, 1);
  assert.equal(stored.counter, 1);

  // 4. a payment larger than what is left is refused and changes nothing
  const before = await dump(app.api.db);
  const tooMuch = await app.api.addPayment(first.id, "5000");
  assert.match(tooMuch.error, /greater than the remaining balance/);
  assert.deepEqual(await dump(app.api.db), before);

  // 5. partial payment, then the final payment
  assert.equal((await app.api.addPayment(first.id, "500")).error, undefined);
  assert.equal(V.paymentSummary(state.invoices[0]).remaining, 804);
  assert.equal(V.paymentSummary(state.invoices[0]).cls, "partial");
  assert.equal((await app.api.addPayment(first.id, "804")).error, undefined);
  const settled = V.paymentSummary(state.invoices[0]);
  assert.deepEqual([settled.paid, settled.remaining, settled.cls], [2304, 0, "paid"]);
  assert.match((await app.api.addPayment(first.id, "1")).error, /already fully paid/);

  // 6. a second sale, paid in full
  await sell(app, id, 1, "box", { paid: 1152 });
  assert.equal(state.invoices[1].invoiceNumber, "INV-000002");
  assert.equal(state.products[0].stock, 12);

  // 7. a settings change
  const saved = await app.api.commit((d) => { d.settings.businessName = "Timgad Tiles"; d.settings.currency = "DZD"; });
  assert.equal(saved.error, undefined);

  // nothing was written anywhere but IndexedDB
  assert.deepEqual(app.localStorage.writes, [], "no localStorage writes at all");

  // 8. a reload (a new page on the same database) sees all of it
  const reloaded = await startedApp({ indexedDB: app.indexedDB });
  assert.equal(reloaded.api.getState().products[0].stock, 12);
  assert.equal(reloaded.api.getState().invoices.length, 2);
  assert.equal(reloaded.api.getState().settings.businessName, "Timgad Tiles");

  // 9. export
  await app.api.exportBackup();
  assert.equal(app.downloads.length, 1);
  const backup = JSON.parse(await app.downloadedText());
  assert.equal(backup.application, "Invoisy");
  assert.equal(backup.data.invoices[0].status, "paid");
  assert.equal(backup.data.invoices[1].amountPaid, 1152);

  // 10. restore into a brand new, empty database
  const target = await startedApp();
  await target.api.importBackup(target.file(await app.downloadedText()));
  assert.equal(target.downloads.length, 0, "an empty database needs no safety copy");

  const a = await dump(app.api.db);
  const b = await dump(target.api.db);
  assert.deepEqual(b.products, a.products, "stock");
  assert.deepEqual(b.invoices, a.invoices, "invoices, items, customers and payment history");
  assert.deepEqual(b.settings, a.settings, "settings");
  assert.equal(b.counter, a.counter, "invoice counter");
  assert.equal(b.products[0].stock, 12);
  assert.deepEqual(b.invoices[0].payments.map((p) => p.amount), [1000, 500, 804]);

  // 11. invoice numbering continues without a gap or a repeat after the restore
  const restoredId = target.api.getState().products[0].id;
  await sell(target, restoredId, 1, "box");
  assert.equal(target.api.getState().invoices[2].invoiceNumber, "INV-000003");
  assert.equal(target.api.getState().products[0].stock, 11);
  assert.equal((await target.api.db.loadAll()).counter, 3);
});

/* ---------- 3-4. Atomic sale: all of it or none of it ---------- */

test("a failed write during a sale saves nothing: no invoice, no stock change, no counter change, and the sale stays on screen", async () => {
  // The sale makes 3 writes: the invoice, the product's new stock, the counter. Each one is made to fail in turn.
  for (const failAt of [1, 2, 3]) {
    const app = await startedApp();
    await app.api.addProduct(tileValues());
    const id = app.api.getState().products[0].id;
    const before = await dump(app.api.db);

    app.api.addToSale(id, "2", "box");
    const undo = failPutWith("QuotaExceededError", failAt);
    try {
      await app.api.completeSale();
    } finally {
      undo();
    }
    assert.deepEqual(await dump(app.api.db), before, `write ${failAt}: the database is unchanged`);
    assert.equal(app.api.getState().invoices.length, 0, `write ${failAt}: the screen shows no invoice`);
    assert.equal(app.api.getState().products[0].stock, 10, `write ${failAt}: and the old stock`);
    assert.equal(app.api.getState().counter, 0);
    assert.equal(app.api.getSale().items.length, 1, "the sale is still there so it can be repeated");
    assert.match(app.errorText("saleError"), /no storage space left/);

    // repeating the same sale now works and uses the first number
    await app.api.completeSale();
    assert.equal(app.api.getState().invoices[0].invoiceNumber, "INV-000001");
    assert.equal(app.api.getState().products[0].stock, 8);
  }
});

test("a sale of more than the stock is refused before anything is written", async () => {
  const app = await startedApp();
  await app.api.addProduct(tileValues({ stock: 3 }));
  const id = app.api.getState().products[0].id;
  const before = await dump(app.api.db);
  const refused = app.api.addToSale(id, "4", "box");
  assert.match(refused.error, /Not enough stock/);
  assert.deepEqual(await dump(app.api.db), before);
});

test("two windows selling at once: the second is told to repeat, nothing is sold twice, numbers stay unique", async () => {
  const first = await startedApp();
  await first.api.addProduct(tileValues({ stock: 3 }));
  const id = first.api.getState().products[0].id;

  const second = await startedApp({ indexedDB: first.indexedDB });   // same database, opened in another window
  assert.equal(second.api.getState().products[0].stock, 3);

  await sell(first, id, 2, "box");                 // window 1 sells 2 of the 3 boxes
  assert.equal(first.api.getState().invoices[0].invoiceNumber, "INV-000001");

  // window 2 still believes 3 boxes are in stock and tries to sell 2
  second.api.addToSale(id, "2", "box");
  await second.api.completeSale();
  assert.match(second.errorText("saleError"), /another window|changed|latest data/i);
  assert.equal(second.api.getState().invoices.length, 1, "window 2 has now loaded window 1's invoice");
  assert.equal(second.api.getState().products[0].stock, 1, "and the stock that is really left");

  let stored = await first.api.db.loadAll();
  assert.equal(stored.invoices.length, 1, "the second sale was not saved");
  assert.equal(stored.products[0].stock, 1);

  // the sale in window 2 was brought in line with the stock that is really left (2 boxes became 1) and the person was told
  assert.equal(second.api.getSale().items.length, 1);
  assert.equal(second.api.getSale().items[0].qty, 1);
  assert.match(second.toast(), /reduced to the available stock \(1\)|latest data/);
  assert.match(second.api.addToSale(id, "1", "box").error || "", /Not enough stock/, "nothing more can be added");
  await second.api.completeSale();
  stored = await first.api.db.loadAll();
  assert.deepEqual(Array.from(stored.invoices, (i) => i.invoiceNumber).sort(), ["INV-000001", "INV-000002"]);
  assert.equal(stored.products[0].stock, 0);
});

test("two windows adding stock to the same product: the second one is not allowed to overwrite the first", async () => {
  const first = await startedApp();
  await first.api.addProduct(tileValues({ stock: 10 }));
  const id = first.api.getState().products[0].id;
  const second = await startedApp({ indexedDB: first.indexedDB });

  assert.equal((await first.api.addStock(id, "5")).error, undefined);      // 15
  const lost = await second.api.addStock(id, "7");                          // would have made 17 and lost the 5
  assert.match(lost.error, /Please repeat/);
  assert.equal((await first.api.db.loadAll()).products[0].stock, 15, "window 1's change is intact");
  assert.equal(second.api.getState().products[0].stock, 15, "window 2 now shows the real stock");
  assert.equal((await second.api.addStock(id, "7")).error, undefined);
  assert.equal((await second.api.db.loadAll()).products[0].stock, 22, "the repeated change is applied on top");
});

/* ---------- 16-17. Storage unavailable, full or broken ---------- */

test("without IndexedDB the app says so and refuses to save, instead of pretending or using another place", async () => {
  const app = loadApp({ indexedDB: null });
  const storage = await app.start();
  assert.equal(storage.mode, "unavailable");
  assert.match(storage.reason, /IndexedDB|database/i);
  assert.equal(app.field("storageBanner").hidden, false, "the problem is shown, not hidden");
  assert.equal(app.field("exportBackup").disabled, true);
  assert.equal(app.field("importBackup").disabled, true);

  await app.api.addProduct(tileValues());
  assert.equal(app.api.getState().products.length, 0, "nothing was added in memory either");
  assert.match(app.errorText("productError"), /Nothing was changed/);
  assert.deepEqual(app.localStorage.writes, [], "and nothing leaked into localStorage");
});

test("a full disk while saving a product is reported and the product list is unchanged", async () => {
  const app = await startedApp();
  const undo = failPutWith("QuotaExceededError", 1);
  try {
    await app.api.addProduct(tileValues());
  } finally {
    undo();
  }
  assert.equal(app.api.getState().products.length, 0);
  assert.equal((await app.api.db.loadAll()).products.length, 0);
  assert.match(app.errorText("productError"), /no storage space left/);
  await app.api.addProduct(tileValues());   // and it works as soon as there is room
  assert.equal(app.api.getState().products.length, 1);
});

test("a duplicate invoice number can never be saved, even if the counter was wrong", async () => {
  const app = await startedApp();
  await app.api.addProduct(tileValues());
  const id = app.api.getState().products[0].id;
  await sell(app, id, 1, "box");
  assert.equal(app.api.getState().invoices[0].invoiceNumber, "INV-000001");
  // Force the in-memory counter back, as a bug might. The database must refuse INV-000001 a second time.
  app.api.getState().counter = 0;
  const before = await dump(app.api.db);
  app.api.addToSale(id, "1", "box");
  await app.api.completeSale();
  assert.deepEqual(await dump(app.api.db), before, "nothing changed");
  assert.match(app.errorText("saleError"), /already|duplicate|number/i);
});

/* ---------- 7. Migration at start-up, through the real app ---------- */

const olderVersionsData = () => JSON.stringify({
  version: 1, lastSaved: iso(10),
  products: [{ id: "lp1", name: "Old Tile", description: "", sku: "OT", category: "Old", sellingPrice: 100, priceUnit: "piece", purchasePrice: 60, stock: 12 }],
  invoices: [sampleInvoice({ number: 1, id: "li1", payments: [{ amount: 1900, timestamp: iso(1) }] })],
  settings: { ...V.DEFAULT_SETTINGS, businessName: "Old Shop" },
  invoiceCounter: 3,
});

test("starting the app with data from the previous version moves it into IndexedDB once and leaves localStorage alone", async () => {
  const legacy = { "invoisy-data": olderVersionsData() };
  const first = loadApp({ localStorage: legacy });
  await first.start();
  const state = first.api.getState();
  assert.deepEqual([state.products.length, state.invoices.length, state.counter], [1, 1, 3]);
  assert.equal(state.settings.businessName, "Old Shop");
  assert.equal(first.api.getStorage().migration.status, "migrated");
  assert.deepEqual(first.localStorage.writes, [], "the old copy was only read");
  assert.equal(first.localStorage.getItem("invoisy-data"), legacy["invoisy-data"]);
  assert.match(first.toast(), /moved to the new browser database/);

  // launching again (same database, same old localStorage) does not migrate or duplicate anything
  const second = loadApp({ localStorage: legacy, indexedDB: first.indexedDB });
  await second.start();
  assert.equal(second.api.getState().products.length, 1);
  assert.equal(second.api.getState().invoices.length, 1);
  assert.equal((await second.api.db.getMigrationRecord()).status, "migrated");

  // new work continues on the right number
  await sell(second, "lp1", 1, "piece");
  assert.equal(second.api.getState().invoices[1].invoiceNumber, "INV-000004");
});

test("when both IndexedDB and the old storage hold data, IndexedDB wins and nothing is merged or deleted", async () => {
  // The database holds data but has never been through the first-run check (so there is no migration marker).
  const first = loadApp();
  await first.api.db.initDatabase();
  await first.api.db.commitChanges({ products: { put: [sampleProduct({ name: "Already In The Database" })], remove: [] } });
  const legacy = { "invoisy-data": olderVersionsData() };
  const second = loadApp({ localStorage: legacy, indexedDB: first.indexedDB });
  await second.start();
  const names = second.api.getState().products.map((p) => p.name);
  assert.deepEqual(names, ["Already In The Database"]);
  assert.equal(second.api.getStorage().migration.status, "conflict");
  assert.equal(second.localStorage.getItem("invoisy-data"), legacy["invoisy-data"], "the old data is still there");
  assert.deepEqual(second.localStorage.writes, []);
});

test("old data that can not be read at all stops the app from starting empty, so nothing is overwritten", async () => {
  const app = loadApp({ localStorage: { "invoisy-data": "{ this is damaged" } });
  const storage = await app.start();
  assert.equal(storage.mode, "failed");
  assert.equal(storage.migrationUnreadable, true);
  await app.api.addProduct(tileValues());
  assert.equal(app.api.getState().products.length, 0, "saving is blocked until the person decides");
  assert.equal(app.localStorage.getItem("invoisy-data"), "{ this is damaged");
});

/* ---------- The code that is left in the page ---------- */

test("the page no longer has a second place to save: no localStorage writes through any normal action", async () => {
  const app = await startedApp();
  await app.api.addProduct(tileValues());
  const id = app.api.getState().products[0].id;
  await app.api.addStock(id, "2");
  await sell(app, id, 1, "box");
  await app.api.exportBackup();
  assert.deepEqual(app.localStorage.writes, []);
});

/* ---------- Stock units (calc.js): fractional stock is saved, exported and restored exactly ---------- */

test("selling pieces from box-counted stock leaves fractional stock that is saved, exported and restored exactly", async () => {
  const app = await startedApp();
  // 1,500 DA/m², 60*60 tile, 1.44 m² per box, 4 pieces per box, stock counted in boxes
  await app.api.addProduct(tileValues({ sellingPrice: 1500, stockUnit: "box", stock: 20 }));
  const id = app.api.getState().products[0].id;
  await sell(app, id, 3, "piece");

  assert.equal(app.api.getState().products[0].stock, 19.25);
  assert.equal((await app.api.db.loadAll()).products[0].stock, 19.25, "the database holds the exact value");
  const invoice = app.api.getState().invoices[0];
  assert.equal(invoice.items[0].stockDeducted, 0.75, "the invoice remembers what it took from stock");

  await app.api.exportBackup();
  const target = await startedApp();
  await target.api.importBackup(target.file(await app.downloadedText()));
  const restored = await target.api.db.loadAll();
  assert.equal(restored.products[0].stock, 19.25);
  assert.equal(restored.products[0].stockUnit, "box");
  assert.equal(restored.invoices[0].items[0].stockDeducted, 0.75);
});

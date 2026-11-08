"use strict";

// The real desktop application: the existing IndexedDB database must survive closing and reopening the application, for
// every kind of record, and the same data must be found at the same origin every time.

const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { buildSampleBackup, summarize } = require("../helpers/sample-business");
const { tempDir, remove, launch, closeAll, stubDialogs, snapshot, goTo, until } = require("./helpers");

afterEach(closeAll);

const addTile = (page, name, stock) => page.evaluate(async ({ name, stock }) => {
  const v = Validation.normalizeProduct({ name, manufacturer: "Timgad Ceramic", tileSize: "60*60", coveragePerBox: 1.44, sku: "PT-" + name, category: "Tiles", sellingPrice: 2000, priceUnit: "box", purchasePrice: 1200, stock });
  delete v.id;
  return addProduct(v);
}, { name, stock });

test("a product, an invoice with a partial payment, a supplier, a purchase, a deposit and a worker are all still there after the application is closed and opened again", async () => {
  const userData = tempDir("persist");
  try {
    let run = await launch(userData);
    assert.equal(run.pageErrors.length, 0, run.pageErrors.join("; "));
    assert.equal(await run.page.evaluate(() => location.href), "app://invoisy/index.html");
    await addTile(run.page, "Persisted Tile", 40);
    // a sale with a partial payment, through the page's own sale functions
    await run.page.evaluate(async () => {
      const p = state.products.find((x) => x.name === "Persisted Tile");
      addToSale(p.id, "3", "box");
      state.sale.customer.name = "Karim Boudiaf";
      state.sale.customer.phone = "0550 11 22 33";
      state.sale.paidValue = "1500";
      await completeSale();
    });
    // a supplier, a purchase with its first payment, a deposit, a worker with an advance
    await run.page.evaluate(async () => {
      const P = Purchases, W = Workers;
      const day = P.toDay(new Date());
      const ok = async (fn) => { const r = await commit(fn); if (r && r.error) throw new Error(r.error); };
      await ok((d) => P.saveSupplier(d, { name: "Timgad Ceramic", phone: "0555 12 34 56", paymentTermsDays: "30" }));
      const supplierId = state.suppliers[0].id;
      const productId = state.products[0].id;
      await ok((d) => {
        const saved = P.saveDraft(d, { supplierId, supplierInvoiceNumber: "TC-1", invoiceDate: day, lines: [{ productId, unit: "box", qty: "10", unitPrice: "1000" }] });
        if (saved.error) return saved;
        return P.confirmPurchase(d, saved.purchase.id, { initialPayment: { amount: "4000", date: day } });
      });
      await ok((d) => P.recordDeposit(d, { supplierId, amount: "9000", date: day, method: "cash" }));
      const ctx = { today: day, now: new Date() };
      await ok((d) => W.addWorker(d, { name: "Ali Benali", startDate: P.addDays(day, -40), salary: "40000" }, ctx));
      const workerId = state.workers[0].id;
      await ok((d) => W.addTransaction(d, { workerId, type: "advance", amount: "5000", date: day }, ctx));
    });
    const before = await snapshot(run.page);
    assert.equal(before.products.length, 1);
    assert.equal(before.invoices.length, 1);
    assert.equal(before.suppliers.length, 1);
    assert.equal(before.purchases.length, 1);
    assert.equal(before.supplierPayments.length, 1);
    assert.equal(before.supplierDeposits.length, 1);
    assert.equal(before.workers.length, 1);
    assert.equal(before.workerTransactions.length, 1);
    assert.equal(before.products[0].stock, 40 + 10 - 3, "stock: 40 bought into stock, 10 purchased, 3 sold");
    await run.close();

    run = await launch(userData);
    const after = await snapshot(run.page);
    assert.deepEqual(after, before, "everything is exactly as it was, record for record");
    assert.equal(run.dialogs.length, 0, "a database with data is never offered a restore");
    await addTile(run.page, "Second Session Tile", 5);
    await run.close();

    run = await launch(userData);
    const names = (await snapshot(run.page)).products.map((p) => p.name).sort();
    assert.deepEqual(names, ["Persisted Tile", "Second Session Tile"]);
    // the invoice number keeps counting from where it was
    await run.page.evaluate(async () => {
      const p = state.products.find((x) => x.name === "Second Session Tile");
      addToSale(p.id, "1", "box");
      state.sale.customer.name = "Walk-in";
      state.sale.paidValue = "2000";
      await completeSale();
    });
    assert.deepEqual((await snapshot(run.page)).invoices.map((i) => i.invoiceNumber).sort(), ["INV-000001", "INV-000002"]);
    await run.close();
  } finally { await closeAll(); remove(userData); }
});

test("the whole database lives in the user-data folder (outside the installation) and the application never creates a second one", async () => {
  const userData = tempDir("where");
  try {
    const run = await launch(userData);
    await addTile(run.page, "Where Tile", 3);
    await run.close();
    const idb = path.join(userData, "IndexedDB");
    const dirs = fs.readdirSync(idb);
    assert.deepEqual(dirs, ["app_invoisy_0.indexeddb.leveldb"], "one IndexedDB, for the one origin app://invoisy");
    assert.ok(fs.readdirSync(path.join(idb, dirs[0])).length > 0);
    assert.ok(fs.existsSync(path.join(userData, "backups", "invoisy-data.json")));
    assert.ok(fs.existsSync(path.join(userData, "logs", "invoisy.log")));
    // nothing was written next to the application's own files
    const rootFiles = fs.readdirSync(path.join(__dirname, "..", "..")).filter((f) => /\.(json|leveldb|sqlite|db)$/i.test(f) && f !== "package.json" && f !== "package-lock.json");
    assert.deepEqual(rootFiles, []);
  } finally { await closeAll(); remove(userData); }
});

test("a backup file from the browser version restores through the real Open dialog, survives a restart, and matches in counts, totals and invoice numbers", async () => {
  const userData = tempDir("restore");
  const work = tempDir("restore-file");
  try {
    const text = await buildSampleBackup();
    const expected = summarize(text);
    const file = path.join(work, "from-the-browser-version.json");
    fs.writeFileSync(file, text);

    let run = await launch(userData);
    await stubDialogs(run.app, { open: file });
    await goTo(run.page, "settings");
    await run.page.click("#importBackup");
    await until(async () => (await run.page.evaluate(() => state.products.length)) === 2, 20000, "the restore");
    assert.ok(run.dialogs.some((d) => /REPLACE all the data/.test(d.message)), "the person confirmed first");
    const restored = await snapshot(run.page);
    await run.close();

    run = await launch(userData);
    const after = await snapshot(run.page);
    assert.deepEqual(after, restored, "the restored data is still there, unchanged, after a restart");
    // export it again from the page and compare with the file that came in
    const exported = await run.page.evaluate(async () => {
      const snap = await db.loadAll({ withAttachments: true });
      return Validation.prepareBackupFile(snap, new Date()).text;
    });
    const got = summarize(exported);
    for (const key of ["counts", "invoiceNumbers", "invoiceCounter", "purchaseCounter", "stockTotal", "paidOnInvoices", "remainingOnInvoices", "paidToSuppliers", "deposits", "advanceAllocations", "workerPayments"]) {
      assert.deepEqual(got[key], expected[key], key);
    }
    assert.deepEqual(got.data.invoices, expected.data.invoices);
    assert.deepEqual(got.data.products, expected.data.products);
    assert.deepEqual(got.data.suppliers, expected.data.suppliers);
    assert.deepEqual(got.data.purchases, expected.data.purchases);
    assert.deepEqual(got.data.workers, expected.data.workers);
    assert.deepEqual(got.data.workerTransactions, expected.data.workerTransactions);
    await run.close();
  } finally { await closeAll(); remove(userData); remove(work); }
});

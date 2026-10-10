"use strict";

// Amount Paid and later payments, run through the real page scripts against a disposable in-memory IndexedDB.
// The rule under test: an empty Amount Paid means NOTHING was paid, never "paid in full".

const test = require("node:test");
const assert = require("node:assert/strict");
const { sampleProduct } = require("./helpers/modules");
const { loadApp } = require("./helpers/app");

const plain = (x) => JSON.parse(JSON.stringify(x));

async function startedApp(options) {
  const app = loadApp(options);
  const storage = await app.start();
  assert.equal(storage.mode, "ready", storage.reason);
  return app;
}

// A product at 10,000 DA per piece, so 2 pieces make the 20,000 DA invoice used in the examples.
async function appWithProduct() {
  const app = await startedApp();
  const { id, ...values } = sampleProduct({ name: "Marble slab", sellingPrice: 10000, priceUnit: "piece", stockUnit: "piece", tileSize: "", coveragePerBox: null, purchasePrice: null, sku: "MS-1", stock: 50 });
  await app.api.addProduct(values);
  return { app, productId: app.api.getState().products[0].id };
}

// Puts 2 pieces on the sale screen; `paid` is exactly what would be typed in Amount Paid (undefined = left untouched).
async function sellTwo(app, productId, paid) {
  const added = app.api.addToSale(productId, "2", "piece");
  assert.equal(added.ok, true, added.error);
  if (paid !== undefined) app.api.getSale().paidValue = paid;
  await app.api.completeSale();
  return app.api.getState().invoices[app.api.getState().invoices.length - 1];
}

const summary = (app, invoice) => {
  const { paid, remaining, cls } = app.api.Validation.paymentSummary(invoice);
  return { paid, remaining, status: cls };
};

test("an empty Amount Paid is NOT full payment: the invoice is saved unpaid with the whole total outstanding", async () => {
  const { app, productId } = await appWithProduct();
  const invoice = await sellTwo(app, productId);                      // field never touched
  assert.ok(invoice, "the invoice is saved normally");
  assert.equal(invoice.total, 20000);
  assert.deepEqual(plain(invoice.payments), []);
  assert.deepEqual(summary(app, invoice), { paid: 0, remaining: 20000, status: "unpaid" });
  assert.equal(app.api.paymentInfo(invoice).status, "UNPAID");

  const blank = await sellTwo(app, productId, "   ");                 // blank text, as if typed and cleared
  assert.deepEqual(summary(app, blank), { paid: 0, remaining: 20000, status: "unpaid" });
});

test("an explicit 0 is also unpaid", async () => {
  const { app, productId } = await appWithProduct();
  const invoice = await sellTwo(app, productId, "0");
  assert.deepEqual(plain(invoice.payments), []);
  assert.deepEqual(summary(app, invoice), { paid: 0, remaining: 20000, status: "unpaid" });
});

test("a part payment records exactly that amount; paying everything records the full amount", async () => {
  const { app, productId } = await appWithProduct();
  const part = await sellTwo(app, productId, "7500");
  assert.deepEqual(plain(part.payments.map((p) => p.amount)), [7500]);
  assert.deepEqual(summary(app, part), { paid: 7500, remaining: 12500, status: "partial" });

  const full = await sellTwo(app, productId, "20000");
  assert.deepEqual(plain(full.payments.map((p) => p.amount)), [20000]);
  assert.deepEqual(summary(app, full), { paid: 20000, remaining: 0, status: "paid" });
});

test("the Sell screen shows the whole total as remaining while Amount Paid is empty, and the field no longer suggests the total", async () => {
  const { app, productId } = await appWithProduct();
  app.api.addToSale(productId, "2", "piece");
  app.api.getSale().paidValue = "";
  app.api.renderTotals();
  assert.equal(app.field("tRemaining").textContent, "20,000 DA");
  assert.equal(app.field("amountPaid").placeholder, "0");
  app.api.getSale().paidValue = "5000";
  app.api.renderTotals();
  assert.equal(app.field("tRemaining").textContent, "15,000 DA");
});

test("Amount Paid is checked: negative and non-numeric values are refused, so is more than the total, and nothing is saved", async () => {
  const { app, productId } = await appWithProduct();
  const state = app.api.getState();
  for (const bad of ["-1", "abc", "20000.01", "999999"]) {
    app.api.addToSale(productId, "2", "piece");
    app.api.getSale().paidValue = bad;
    assert.notEqual(app.api.validateSale().length, 0, `"${bad}" must be refused`);
    await app.api.completeSale();
    assert.equal(state.invoices.length, 0, `"${bad}": no invoice saved`);
    assert.equal(state.products[0].stock, 50, `"${bad}": stock untouched`);
    assert.equal(state.counter, 0);
    state.sale.items = [];
  }
});

test("later payments on the SAME invoice: 0 -> 5,000 -> 15,000 -> 20,000, each saved and still there after a reload", async () => {
  const { app, productId } = await appWithProduct();
  const invoice = await sellTwo(app, productId);                      // 20,000 owed, nothing paid
  const id = invoice.id;
  const state = app.api.getState();
  const read = (a) => summary(a, a.api.getState().invoices.find((i) => i.id === id));
  assert.deepEqual(read(app), { paid: 0, remaining: 20000, status: "unpaid" });

  const steps = [
    ["5000", { paid: 5000, remaining: 15000, status: "partial" }],
    ["10000", { paid: 15000, remaining: 5000, status: "partial" }],
    ["5000", { paid: 20000, remaining: 0, status: "paid" }],
  ];
  let reloaded = app;
  for (const [amount, expected] of steps) {
    const result = await reloaded.api.addPayment(id, amount);
    assert.equal(result.error, undefined, result.error);
    assert.deepEqual(read(reloaded), expected, `after paying ${amount}`);
    // a brand new page on the same database (a refresh / reopening the application) sees the same thing
    reloaded = await startedApp({ indexedDB: app.indexedDB });
    assert.deepEqual(read(reloaded), expected, `after reload, following ${amount}`);
  }

  const final = reloaded.api.getState().invoices.find((i) => i.id === id);
  assert.deepEqual(plain(final.payments.map((p) => p.amount)), [5000, 10000, 5000], "the history lists every payment");
  assert.ok(final.payments.every((p) => typeof p.timestamp === "string" && p.timestamp));
  assert.equal(reloaded.api.getState().invoices.length, 1, "no new invoice was created");
  assert.equal(final.total, 20000, "the total is untouched by payments");
  assert.equal(reloaded.api.getState().products[0].stock, 48, "stock is untouched by payments");
  assert.equal(state.counter, 1);
  assert.match((await reloaded.api.addPayment(id, "1")).error, /already fully paid/);
});

test("a later payment is validated: zero, negative, text, empty and overpayment are refused and change nothing", async () => {
  const { app, productId } = await appWithProduct();
  const invoice = await sellTwo(app, productId, "5000");
  const before = JSON.stringify(await app.api.db.loadAll());
  for (const bad of ["", "0", "-100", "abc", "15000.01", "99999"]) {
    const result = await app.api.addPayment(invoice.id, bad);
    assert.ok(result.error, `"${bad}" must be refused`);
  }
  assert.equal(JSON.stringify(await app.api.db.loadAll()), before, "nothing was written");
  assert.deepEqual(summary(app, app.api.getState().invoices[0]), { paid: 5000, remaining: 15000, status: "partial" });
});

test("totals, balances and statuses agree in the invoice list rows, the printed invoice and the backup file", async () => {
  const { app, productId } = await appWithProduct();
  const invoice = await sellTwo(app, productId);
  await app.api.addPayment(invoice.id, "5000");
  const saved = app.api.getState().invoices[0];

  const html = app.api.invoiceHtml(saved);
  assert.match(html, /STATUS: PARTIALLY PAID/);
  assert.match(html, /Total Paid[^]*?5,000 DA/);
  assert.match(html, /15,000 DA/);

  await app.api.exportBackup();
  const backup = JSON.parse(await app.downloadedText());
  assert.deepEqual([backup.data.invoices[0].amountPaid, backup.data.invoices[0].remaining, backup.data.invoices[0].status], [5000, 15000, "partial"]);

  // restoring that backup into an empty database keeps the unpaid part outstanding
  const target = await startedApp();
  await target.api.importBackup(target.file(JSON.stringify(backup)));
  const restored = target.api.getState().invoices;
  assert.equal(restored.length, 1, "the invoice was restored");
  assert.deepEqual(summary(target, restored[0]), { paid: 5000, remaining: 15000, status: "partial" });
  const reopened = await startedApp({ indexedDB: target.indexedDB });
  assert.deepEqual(summary(reopened, reopened.api.getState().invoices[0]), { paid: 5000, remaining: 15000, status: "partial" });
});

test("an unpaid invoice (no payments at all) survives export, restore and reload without becoming paid", async () => {
  const { app, productId } = await appWithProduct();
  await sellTwo(app, productId);
  const reloaded = await startedApp({ indexedDB: app.indexedDB });
  const inv = reloaded.api.getState().invoices[0];
  assert.deepEqual(plain(inv.payments), []);
  assert.deepEqual(summary(reloaded, inv), { paid: 0, remaining: 20000, status: "unpaid" });

  await reloaded.api.exportBackup();
  const backup = JSON.parse(await reloaded.downloadedText());
  assert.equal(backup.data.invoices[0].status, "unpaid");
  assert.equal(backup.data.invoices[0].amountPaid, 0);
  assert.equal(backup.data.invoices[0].remaining, 20000);
  const parsed = reloaded.api.Validation.parseBackup(JSON.stringify(backup));
  assert.equal(parsed.error, undefined, parsed.error);
  assert.deepEqual(plain(parsed.data.invoices[0].payments), []);
});

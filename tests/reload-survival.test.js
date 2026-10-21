"use strict";

// When something outside Invoisy reloads the page (a live-reload development server that watches the folder holding the
// backup file, for example), the saved invoice must stay printable, typed work must not be lost without asking, and the
// reload is explained. A "reload" here is a second copy of the app started on the SAME database and the SAME
// sessionStorage, which is exactly what a browser reload of one tab does.

const test = require("node:test");
const assert = require("node:assert/strict");
const { sampleProduct } = require("./helpers/modules");
const { loadApp } = require("./helpers/app");

const plain = (x) => JSON.parse(JSON.stringify(x));

// sessionStorage of one browser tab: it survives a reload of that tab.
function tabStorage() {
  const values = new Map();
  return {
    values,
    getItem: (k) => (values.has(k) ? values.get(k) : null),
    setItem: (k, v) => values.set(k, String(v)),
    removeItem: (k) => values.delete(k),
  };
}

// One page load. Pass the previous load's `indexedDB` and `tab` to reload it.
async function load({ indexedDB, tab = tabStorage(), navigation = "navigate" } = {}) {
  const print = { calls: 0 };
  const opts = {
    globals: {
      sessionStorage: tab,
      performance: { getEntriesByType: () => [{ type: navigation }] },
      window: { print() { print.calls++; }, addEventListener() {} },
    },
  };
  if (indexedDB) opts.indexedDB = indexedDB;
  const app = loadApp(opts);
  await app.start();
  return { app, api: app.api, print, tab, indexedDB: app.indexedDB };
}

const tileValues = () => {
  const { id, ...values } = sampleProduct({ name: "Everton Grey", tileSize: "60*60", coveragePerBox: 1.44, sku: "EV-60", sellingPrice: 800, priceUnit: "m2", purchasePrice: 600, stock: 10 });
  return values;
};

async function addTile(ctx) {
  await ctx.api.addProduct(tileValues());
  return ctx.api.getState().products[0];
}

async function sell(ctx, product, { name = "Alex", paid = "500" } = {}) {
  const { api } = ctx;
  assert.equal(api.addToSale(product.id, "2", "box").ok, true);
  api.getSale().customer.name = name;
  api.getSale().paidValue = paid;
  await api.completeSale();
  return api.getInvoices()[api.getInvoices().length - 1];
}

test("reload: the open Sale completed dialog is remembered for the tab, and forgotten as soon as it is answered", async () => {
  for (const action of ["print", "new", "later"]) {
    const ctx = await load();
    const tile = await addTile(ctx);
    const inv = await sell(ctx, tile);
    assert.deepEqual(plain(ctx.api.rememberedSaleDone()), { id: inv.id, number: inv.invoiceNumber }, "remembered while it waits");
    await ctx.api.saleDoneAction(action);
    assert.equal(ctx.api.rememberedSaleDone(), null, `forgotten after ${action}`);
  }
});

test("reload: a page reload right after Save Invoice brings the dialog back and Print Invoice prints the saved invoice, once", async () => {
  const first = await load();
  const tile = await addTile(first);
  const inv = await sell(first, tile, { name: "Alex", paid: "500" });
  const stockAfterSale = first.api.getState().products[0].stock;
  assert.equal(first.print.calls, 0);

  // ... the tool reloads the page here: the dialog on the screen is gone, the data is not.
  const second = await load({ indexedDB: first.indexedDB, tab: first.tab, navigation: "reload" });
  assert.deepEqual(plain(second.api.getSaleDone()), { id: inv.id, number: inv.invoiceNumber }, "the dialog is open again for the same invoice");
  assert.match(second.app.field("saleDoneNumber").textContent, new RegExp(inv.invoiceNumber));
  assert.equal(second.api.getState().previewInvoice.id, inv.id, "the saved invoice is the one shown");

  await Promise.all([second.api.saleDoneAction("print"), second.api.saleDoneAction("print")]);
  assert.equal(second.print.calls, 1, "printed once");
  assert.equal(second.api.getInvoices().length, 1, "no second invoice");
  assert.equal(second.api.getState().products[0].stock, stockAfterSale, "stock was deducted once, by the sale");
  assert.match(second.app.field("invoice").innerHTML, new RegExp(inv.invoiceNumber));
});

test("reload: closing the dialog without printing keeps the invoice saved, and a later reload does not ask again", async () => {
  const first = await load();
  const tile = await addTile(first);
  const inv = await sell(first, tile);
  const second = await load({ indexedDB: first.indexedDB, tab: first.tab, navigation: "reload" });
  assert.ok(second.api.getSaleDone());
  await second.api.saleDoneAction("later");
  assert.equal(second.api.getInvoices().some((i) => i.id === inv.id), true, "still saved");

  const third = await load({ indexedDB: first.indexedDB, tab: first.tab, navigation: "reload" });
  assert.equal(third.api.getSaleDone(), null, "answered once, never asked again");
  assert.equal(third.api.getInvoices().length, 1);
});

test("reload: a remembered dialog whose invoice no longer exists is dropped quietly (nothing invented, no error)", async () => {
  const tab = tabStorage();
  tab.setItem("invoisy-sale-done", JSON.stringify({ id: "gone", number: "INV-000099" }));
  const ctx = await load({ tab, navigation: "reload" });
  assert.equal(ctx.api.getSaleDone(), null);
  assert.equal(ctx.api.rememberedSaleDone(), null);
  assert.equal(ctx.app.toast().includes("INV-000099"), false);
});

test("reload: a damaged remembered value is ignored", async () => {
  const tab = tabStorage();
  tab.setItem("invoisy-sale-done", "{not json");
  const ctx = await load({ tab });
  assert.equal(ctx.api.getSaleDone(), null);
  tab.setItem("invoisy-sale-done", "42");
  assert.equal(ctx.api.rememberedSaleDone(), null);
});

test("reload: nothing is remembered, and nothing breaks, in a browser that blocks sessionStorage", async () => {
  const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
  const ctx = await load({ tab: blocked });
  const tile = await addTile(ctx);
  const inv = await sell(ctx, tile);
  assert.deepEqual(plain(ctx.api.getSaleDone()), { id: inv.id, number: inv.invoiceNumber }, "the dialog still works");
  await ctx.api.saleDoneAction("later");
  assert.equal(ctx.api.getInvoices().length, 1);
});

test("reload notice: a reload within seconds of a save is explained once; a normal start, an old save or a plain visit is not", async () => {
  const first = await load();
  await addTile(first);                                    // a save: marks the time of the last commit
  assert.equal(first.tab.getItem("invoisy-last-commit") !== null, true);

  const reloaded = await load({ indexedDB: first.indexedDB, tab: first.tab, navigation: "reload" });
  assert.match(reloaded.app.toast(), /reloaded right after your data was saved/);
  assert.match(reloaded.app.toast(), /invoisy-data\.json/);
  assert.equal(reloaded.tab.getItem("invoisy-last-commit"), null, "said once");

  const visit = tabStorage();
  visit.setItem("invoisy-last-commit", String(Date.now()));
  assert.equal((await load({ tab: visit, navigation: "navigate" })).app.toast().includes("reloaded"), false, "not a reload: no notice");

  const old = tabStorage();
  old.setItem("invoisy-last-commit", String(Date.now() - 60000));
  assert.equal((await load({ tab: old, navigation: "reload" })).app.toast().includes("reloaded"), false, "an old save: no notice");

  assert.equal((await load({ navigation: "reload" })).app.toast().includes("reloaded"), false, "no save at all: no notice");
});

test("reload notice: the wording exists in English, French and Arabic", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  for (const file of ["en.js", "fr.js", "ar.js"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", "java script", "lang", file), "utf8");
    assert.match(source, /"app\.reloadedAfterSave"/, file);
  }
});

test("unsaved work: a sale in preparation or a product being typed makes a reload ask first; saving clears it", async () => {
  const ctx = await load();
  assert.equal(ctx.api.hasUnsavedWork(), false, "a fresh page has nothing to lose");

  ctx.api.touchProductForm();
  assert.equal(ctx.api.hasUnsavedWork(), true, "a product being typed");
  await ctx.api.addProduct(tileValues());               // saving the product clears the form
  assert.equal(ctx.api.hasUnsavedWork(), false, "saved product: nothing left unsaved");

  const tile = ctx.api.getState().products[0];
  assert.equal(ctx.api.addToSale(tile.id, "1", "box").ok, true);
  assert.equal(ctx.api.hasUnsavedWork(), true, "a sale with a line");
  ctx.api.getSale().customer.name = "Alex";
  await ctx.api.completeSale();
  assert.equal(ctx.api.hasUnsavedWork(), false, "saved sale: nothing left unsaved");

  ctx.api.getSale().customer.phone = "0550";
  assert.equal(ctx.api.hasUnsavedWork(), true, "a customer typed on an empty sale");
});

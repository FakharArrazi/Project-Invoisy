"use strict";

// Shared by the invoice-edit tests. Editing a saved invoice happens on the Sell page, so these helpers drive it the way a person
// does: open the invoice, then change it with the Sell page's own functions (quantity, unit, price, add, remove) and save.
// Everything runs against a disposable in-memory IndexedDB; no real data is ever touched.

const assert = require("node:assert/strict");
const { V, sampleProduct } = require("./modules");
const { loadApp } = require("./app");
const { FakeHandle } = require("./fake-handle");

const plain = (x) => JSON.parse(JSON.stringify(x));
const round2 = (n) => Math.round(n * 100) / 100;

// A started app with a connected (fake) backup file and a print counter.
async function boot(options) {
  const handle = new FakeHandle();
  const print = { calls: 0, fail: false };
  const app = loadApp({
    globals: {
      showSaveFilePicker: async () => handle,
      window: { print() { print.calls++; if (print.fail) throw new Error("The printer is not available."); }, addEventListener() {} },
    },
    ...options,
  });
  const storage = await app.start();
  assert.equal(storage.mode, "ready", storage.reason);
  await app.api.connectBackupFile();
  return { app, api: app.api, handle, print };
}

// 60x60 tile, 1.44 m² per box (4 pieces per box), stock counted in boxes. Default price: 2,000 DA per box (15 boxes = 30,000 DA).
const tileValues = (overrides) => {
  const { id, ...values } = sampleProduct({ name: "Everton Grey", tileSize: "60*60", coveragePerBox: 1.44, sku: "EV-60", sellingPrice: 2000, priceUnit: "box", purchasePrice: 1200, stock: 20, ...overrides });
  return values;
};

async function addTile(ctx, overrides) {
  const before = ctx.api.getState().products.map((p) => p.id);
  await ctx.api.addProduct(tileValues(overrides));
  return ctx.api.getState().products.find((p) => !before.includes(p.id));
}

// Sells lines the way the Sell page does. lines: [{ product, qty, unit }]. Returns the saved invoice.
async function sellLines(ctx, lines, { name = "Alex", phone = "", paid = "", discount, tax } = {}) {
  const { api } = ctx;
  for (const l of lines) assert.equal(api.addToSale(l.product.id, l.qty, l.unit || "box").ok, true);
  const sale = api.getSale();
  sale.customer.name = name;
  sale.customer.phone = phone;
  sale.paidValue = paid;
  if (discount) { sale.discountType = discount.type; sale.discountValue = discount.value; }
  if (tax) { sale.taxType = tax.type; sale.taxValue = tax.value; }
  await api.completeSale();
  const all = api.getInvoices();
  return all[all.length - 1];
}

const stockOf = (api, id) => api.getState().products.find((p) => p.id === id).stock;
const invoiceById = (api, id) => api.getState().invoices.find((i) => i.id === id);

const snapshot = async (ctx) => {
  const all = await ctx.api.db.loadAll();
  return plain({ products: all.products, invoices: all.invoices, counter: all.counter, revision: all.revision });
};

// Opens the invoice for editing and returns the sale on screen (the invoice, loaded as a Sell page sale).
function openEdit(ctx, inv) {
  const r = ctx.api.startEditInvoice(inv.id);
  assert.equal(r.error, undefined, r.error);
  return ctx.api.getSale();
}

// Types a quantity / a price on line `index` the way the Sell page does. Returns the Sell page's own answer ({ error } when refused).
const typeQty = (api, index, qty) => api.updateSaleQuantity(api.getSale().items[index].lineId, String(qty));
const typePrice = (api, index, price) => api.updateSalePrice(api.getSale().items[index].lineId, String(price));
const removeLine = (api, index) => api.removeFromSale(api.getSale().items[index].lineId);

// The whole edit in one go: open, set the quantity of line `index`, save. Returns the plan that was saved.
// `force` writes the quantity straight into the sale (what a stale screen could hold), bypassing the Sell page's own limits.
async function setQty(ctx, inv, qty, index = 0, { force = false } = {}) {
  openEdit(ctx, inv);
  if (force) ctx.api.getSale().items[index].qty = Number(qty);
  else typeQty(ctx.api, index, qty);
  const plan = ctx.api.editPlan();
  await ctx.api.saveInvoiceEdit();
  return plan;
}

module.exports = {
  V, plain, round2, boot, tileValues, addTile, sellLines, stockOf, invoiceById, snapshot,
  openEdit, typeQty, typePrice, removeLine, setQty,
};

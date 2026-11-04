"use strict";

// The Sell page shows what a product was last bought for, read from the supplier purchase records (Purchases.latestPurchasePrice).
// It is one real record in the unit it was bought in, with its supplier: never typed on the Sell page, never converted, never
// averaged between suppliers, and it never touches selling prices, sales or stock. Everything runs through the application's own
// functions against a disposable in-memory database.

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./helpers/app");
const { loadProductApi, openDatabase } = require("./helpers");

require("./helpers/modules");   // loads calc.js, validation.js, purchases.js and the languages into this process
const P = globalThis.Purchases;
const plain = (x) => JSON.parse(JSON.stringify(x));

const tile = (extra) => ({ id: "p-tile", name: "Tile A", tileSize: "60*60", coveragePerBox: 1.44, sku: "TA-1", sellingPrice: 800, priceUnit: "m2", stockUnit: "box", stock: 20, ...extra });
const grout = (extra) => ({ id: "p-grout", name: "Grout", sku: "GR-1", sellingPrice: 300, priceUnit: "piece", stockUnit: "piece", stock: 10, ...extra });

// Plain data with two suppliers, built with the real purchase rules.
function data() {
  const d = {
    products: [tile(), grout()], invoices: [], settings: { currency: "DA", language: "en" }, counter: 0,
    suppliers: [], purchases: [], supplierPayments: [], purchaseCounter: 0, attachments: { put: [], remove: [] },
  };
  const a = P.saveSupplier(d, { name: "Timgad Ceramic" }).supplier;
  const b = P.saveSupplier(d, { name: "Sétif Céram" }).supplier;
  return { d, a, b };
}

function buy(d, supplier, { date, unit, qty, price, product, invoiceNo, confirm }) {
  const r = P.saveDraft(d, {
    supplierId: supplier.id, supplierInvoiceNumber: invoiceNo, invoiceDate: date,
    lines: [{ productId: product || "p-tile", unit: unit || "box", qty: String(qty || 10), unitPrice: String(price) }],
  });
  assert.ok(r.purchase, r.error);
  if (confirm !== false) { const c = P.confirmPurchase(d, r.purchase.id); assert.ok(c.purchase, c.error); }
  return r.purchase;
}

function sellApp(d) {
  const app = loadApp();
  app.api.applyData({ ...d, products: d.products.map((p) => app.api.normalizeProduct(p)) });
  return app;
}

const selectedText = (app, id) => { app.api.selectProduct(id); return app.field("selectedInfo").innerHTML; };

test("1. the price shown is the newest purchase record, in the unit it was bought in, with its supplier", () => {
  const { d, a, b } = data();
  buy(d, a, { date: "2026-09-01", unit: "m2", qty: 28.8, price: 450, invoiceNo: "A-1" });
  buy(d, b, { date: "2026-10-15", unit: "box", qty: 20, price: 1200, invoiceNo: "B-1" });
  const last = P.latestPurchasePrice(d, "p-tile");
  assert.equal(last.unitPrice, 1200);
  assert.equal(last.unit, "box", "the unit of the record, not converted to m²");
  assert.equal(last.supplierName, "Sétif Céram");
  assert.equal(last.date, "2026-10-15");

  const html = selectedText(sellApp(d), "p-tile");
  assert.match(html, /Purchase price: 1,200 DA \/ Box/);
  assert.match(html, /Supplier: Sétif Céram/);
  assert.doesNotMatch(html, /450/, "the older supplier's price is not shown or mixed in");
});

test("2. the newest is chosen by invoice date, not by the order the purchases were entered", () => {
  const { d, a, b } = data();
  buy(d, b, { date: "2026-10-20", unit: "m2", qty: 28.8, price: 470, invoiceNo: "B-1" });   // entered first, dated later
  buy(d, a, { date: "2026-08-01", unit: "box", qty: 10, price: 700, invoiceNo: "A-1" });  // entered last, dated earlier
  const last = P.latestPurchasePrice(d, "p-tile");
  assert.deepEqual([last.unitPrice, last.unit, last.supplierName], [470, "m2", "Sétif Céram"]);
  assert.match(selectedText(sellApp(d), "p-tile"), /Purchase price: 470 DA \/ m²/);
});

test("3. each unit is shown as bought: per piece, per box, per m²", () => {
  const { d, a } = data();
  buy(d, a, { date: "2026-10-01", unit: "piece", qty: 24, price: 90, product: "p-grout", invoiceNo: "A-1" });
  assert.match(selectedText(sellApp(d), "p-grout"), /Purchase price: 90 DA \/ Piece/);
  const { d: d2, a: a2 } = data();
  buy(d2, a2, { date: "2026-10-01", unit: "m2", qty: 28.8, price: 450, invoiceNo: "A-1" });
  assert.match(selectedText(sellApp(d2), "p-tile"), /Purchase price: 450 DA \/ m²/);
});

test("4. drafts and cancelled purchases are ignored: the next real record is used", () => {
  const { d, a, b } = data();
  buy(d, a, { date: "2026-09-01", unit: "box", qty: 10, price: 700, invoiceNo: "A-1" });
  buy(d, b, { date: "2026-10-01", unit: "box", qty: 10, price: 999, invoiceNo: "B-1", confirm: false });   // draft
  assert.equal(P.latestPurchasePrice(d, "p-tile").unitPrice, 700, "a draft is not a purchase yet");
  const cancelled = buy(d, b, { date: "2026-10-05", unit: "box", qty: 10, price: 888, invoiceNo: "B-2" });
  const c = P.cancelPurchase(d, cancelled.id, "entered twice");
  assert.ok(!c.error, c.error);
  assert.equal(P.latestPurchasePrice(d, "p-tile").unitPrice, 700, "a cancelled purchase does not count");
});

test("5. a line without a usable price is skipped for the next older real record", () => {
  const { d, a } = data();
  buy(d, a, { date: "2026-09-01", unit: "box", qty: 10, price: 700, invoiceNo: "A-1" });
  const free = buy(d, a, { date: "2026-10-01", unit: "box", qty: 1, price: 1, invoiceNo: "A-2" });
  d.purchases.find((p) => p.id === free.id).lines[0].unitPrice = 0;   // a free sample recorded at 0
  assert.equal(P.latestPurchasePrice(d, "p-tile").unitPrice, 700);
});

test("6. a product that was never bought shows a quiet message, no input", () => {
  const { d, a } = data();
  buy(d, a, { date: "2026-10-01", unit: "box", qty: 10, price: 700, invoiceNo: "A-1" });
  const html = selectedText(sellApp(d), "p-grout");
  assert.match(html, /No purchase price recorded/);
  assert.doesNotMatch(html, /<input|<select|<textarea/i, "never an editable control");
  assert.equal(P.latestPurchasePrice(d, "p-grout"), null);
  assert.equal(P.latestPurchasePrice(d, "does-not-exist"), null);
  assert.doesNotMatch(selectedText(sellApp(d), "p-tile"), /<input|<select|<textarea/i, "nor when a purchase price is shown");
});

test("7. nothing is written: purchases, products and suppliers are identical after showing the price", () => {
  const { d, a, b } = data();
  buy(d, a, { date: "2026-09-01", unit: "m2", qty: 28.8, price: 450, invoiceNo: "A-1" });
  buy(d, b, { date: "2026-10-15", unit: "box", qty: 20, price: 1200, invoiceNo: "B-1" });
  const app = sellApp(d);
  const before = plain({ products: d.products, purchases: d.purchases, suppliers: d.suppliers });
  selectedText(app, "p-tile");
  selectedText(app, "p-grout");
  P.latestPurchasePrice(d, "p-tile");
  assert.deepEqual(plain({ products: d.products, purchases: d.purchases, suppliers: d.suppliers }), before);
});

test("8. the selling price shown and used is unchanged by purchase records", () => {
  const { d, a } = data();
  const app0 = sellApp(d);
  const without = selectedText(app0, "p-tile");
  buy(d, a, { date: "2026-10-01", unit: "box", qty: 10, price: 5, invoiceNo: "A-1" });   // an absurdly low purchase price
  const app1 = sellApp(d);
  const withPurchase = selectedText(app1, "p-tile");
  const sellingPart = (html) => html.match(/Price: [^<]*/)[0];
  assert.equal(sellingPart(withPurchase), sellingPart(without), "the selling price line is identical");
  assert.match(sellingPart(withPurchase), /800/);
});

test("9. French and Arabic have their own wording", () => {
  const { d, a } = data();
  buy(d, a, { date: "2026-10-01", unit: "box", qty: 10, price: 700, invoiceNo: "A-1" });
  for (const [language, word, none] of [["fr", /Prix d’achat/, /Aucun prix d’achat enregistré/], ["ar", /سعر الشراء/, /لا يوجد سعر شراء مسجّل/]]) {
    const app = loadApp();
    app.api.applyData({ ...d, products: d.products.map((p) => app.api.normalizeProduct(p)), settings: { ...d.settings, language } });
    assert.match(selectedText(app, "p-tile"), word);
    assert.match(selectedText(app, "p-grout"), none);
  }
});

// A sale of the same two products, once with no purchase records at all and once after purchases were recorded (at prices
// far from the selling prices). The invoices and the stock left must be identical: purchase prices never reach a sale.
async function sellBoth(withPurchases) {
  const { api } = loadProductApi();
  const { d, a, b } = data();
  if (withPurchases) {
    buy(d, a, { date: "2026-09-01", unit: "m2", qty: 28.8, price: 1, invoiceNo: "A-1" });
    buy(d, b, { date: "2026-10-15", unit: "box", qty: 20, price: 99999, invoiceNo: "B-1" });
  }
  const stockBefore = Object.fromEntries(d.products.map((p) => [p.id, p.stock]));
  api.applyData({ ...d, products: d.products.map((p) => api.normalizeProduct(p)) });
  await openDatabase(api);
  assert.equal(api.addToSale("p-tile", "2", "box").ok, true);
  assert.equal(api.addToSale("p-grout", "3", "piece").ok, true);   // never bought from a supplier
  const totals = plain(api.calculateTotals(api.getSale()));
  const result = await api.commit((draft) => api.applySale(draft, api.getSale()));
  assert.equal(result.error, undefined, result.error);
  const stock = Object.fromEntries(api.getProducts().map((p) => [p.id, stockBefore[p.id] - p.stock]));
  const items = plain(result.invoice.items).map(({ productName, sellingUnit, qty, unitPrice, total, stockDeducted }) => ({ productName, sellingUnit, qty, unitPrice, total, stockDeducted }));
  return { totals, items, total: result.invoice.total, stock };
}

test("10. selling prices, invoice totals and stock deduction are identical with or without purchase records; a never-bought product sells normally", async () => {
  const none = await sellBoth(false);
  const some = await sellBoth(true);
  assert.deepEqual(some, none);
  assert.equal(none.total, 800 * 2 * 1.44 + 3 * 300, "2 boxes of 800 DA/m² (1.44 m² each) + 3 pieces at 300 DA");
  assert.deepEqual(none.stock, { "p-tile": 2, "p-grout": 3 });
});

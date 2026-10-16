"use strict";

// Buying is "pick a product, type the quantity and the unit it was bought in, type the price, confirm".
// What goes into stock is worked out from the product's own saved tile size, coverage per box and stock unit:
// it is never typed on the purchase and never hardcoded. These tests follow the ten scenarios of the request, on
// the business rules (purchases.js) and through a real (in-memory) database for what must survive a restart.

const test = require("node:test");
const assert = require("node:assert/strict");
const { V, DB, newDb, sampleProduct } = require("./helpers/modules");

const P = globalThis.Purchases;
const day = (offset) => P.addDays(P.toDay(new Date()), offset || 0);

// A 60 × 60 tile kept in boxes of 1.44 m² (4 pieces), SOLD per m². 10 boxes in stock.
const tile = (overrides) => sampleProduct({
  id: "p-tile", name: "Floor 60x60", tileSize: "60*60", coveragePerBox: 1.44, sellingPrice: 1200, priceUnit: "m2", stockUnit: "box",
  sku: "F-6060", stock: 10, ...overrides,
});

function draft(products) {
  return {
    products: products || [tile()], invoices: [], settings: { ...V.DEFAULT_SETTINGS, currency: "DA" }, counter: 0,
    suppliers: [], purchases: [], supplierPayments: [], purchaseCounter: 0, attachments: { put: [], remove: [] },
  };
}

function withSupplier(products) {
  const d = draft(products);
  const r = P.saveSupplier(d, { name: "Timgad Ceramic", paymentTermsDays: "30" });
  assert.ok(r.supplier, r.error);
  return d;
}

let invoiceSerial = 0;
const input = (d, line, overrides) => ({
  supplierId: d.suppliers[0].id, supplierInvoiceNumber: "FA-" + ++invoiceSerial, invoiceDate: day(0),
  lines: [{ productId: "p-tile", ...line }], ...overrides,
});
const stockOf = (d, id) => d.products.find((p) => p.id === (id || "p-tile")).stock;

function confirmLine(d, line, overrides) {
  const saved = P.saveDraft(d, input(d, line, overrides));
  assert.ok(saved.purchase, saved.error);
  const done = P.confirmPurchase(d, saved.purchase.id);
  assert.ok(done.purchase, done.error);
  return done.purchase;
}

/* 1. Tiles bought by m² become boxes */

test("207.36 m² of a product counted in boxes of 1.44 m² adds exactly 144 boxes, priced per m²", () => {
  const d = withSupplier();
  const sold = JSON.stringify(d.products[0]);
  const purchase = confirmLine(d, { unit: "m2", qty: "207.36", unitPrice: "1000" });
  const line = purchase.lines[0];
  assert.equal(line.baseQty, 144);
  assert.equal(line.stockUnit, "box");
  assert.equal(stockOf(d), 154, "10 boxes + 144 boxes");
  assert.equal(line.qty, 207.36, "the quantity bought stays as typed");
  assert.equal(line.unit, "m2");
  assert.equal(line.unitPrice, 1000, "the price stays a price per m², not per box");
  assert.equal(line.lineTotal, 207360, "207.36 m² × 1,000 DA");
  assert.equal(purchase.total, 207360);
  assert.equal(P.deliveryState(purchase).lines[0].receivedBase, 144);
  assert.notEqual(JSON.stringify(d.products[0]), sold, "only the stock moved");
});

test("the conversion follows the product's own saved coverage: nothing is hardcoded to 1.44 or to 60 × 60", () => {
  const d = withSupplier([tile({ id: "p-a", coveragePerBox: 1.44, sku: "A" }), tile({ id: "p-b", name: "Floor B", coveragePerBox: 1.08, sku: "B" })]);
  const a = confirmLine(d, { productId: "p-a", unit: "m2", qty: "14.4", unitPrice: "1000" });
  assert.equal(a.lines[0].baseQty, 10, "14.4 ÷ 1.44");
  const b = confirmLine(d, { productId: "p-b", unit: "m2", qty: "10.8", unitPrice: "1000" });
  assert.equal(b.lines[0].baseQty, 10, "10.8 ÷ 1.08: the other product's own coverage");
  assert.ok(P.saveDraft(d, input(d, { productId: "p-b", unit: "m2", qty: "14.4", unitPrice: "1000" })).error, "14.4 ÷ 1.08 is not a whole number of boxes");
});

test("an area that is not a whole number of boxes is refused, with the nearest quantities that are", () => {
  const d = withSupplier();
  const r = P.saveDraft(d, input(d, { unit: "m2", qty: "200", unitPrice: "1000" }));
  assert.ok(r.error, "200 m² ÷ 1.44 = 138.88… boxes is not guessed or rounded");
  assert.match(r.error, /138/);
  assert.match(r.error, /139/);
  assert.equal(r.field, "line.0.qty");
  assert.equal(stockOf(d), 10);
});

test("a large purchase has no floating-point drift: 10,368 m² is exactly 7,200 boxes", () => {
  const d = withSupplier();
  const purchase = confirmLine(d, { unit: "m2", qty: "10368", unitPrice: "900" });
  assert.equal(purchase.lines[0].baseQty, 7200);
  assert.equal(stockOf(d), 7210);
});

/* 2. Tiles bought by the box */

test("20 boxes add 20 boxes, and the price stays a price per box", () => {
  const d = withSupplier();
  const purchase = confirmLine(d, { unit: "box", qty: "20", unitPrice: "1440" });
  assert.equal(purchase.lines[0].baseQty, 20);
  assert.equal(purchase.lines[0].factor, 1);
  assert.equal(purchase.lines[0].unit, "box");
  assert.equal(purchase.lines[0].unitPrice, 1440);
  assert.equal(purchase.total, 28800);
  assert.equal(stockOf(d), 30);
  assert.deepEqual(P.saveDraft(d, input(d, { unit: "box", qty: "2.5", unitPrice: "1" })).error && "refused", "refused", "half a box is not a purchase quantity");
});

/* 3. Pieces */

test("100 pieces of a 60 × 60 tile in boxes of 1.44 m² (4 pieces) add 25 boxes when the product allows it", () => {
  const d = withSupplier();
  const purchase = confirmLine(d, { unit: "piece", qty: "100", unitPrice: "360" });
  assert.equal(purchase.lines[0].baseQty, 25);
  assert.equal(purchase.lines[0].qty, 100, "still recorded as 100 pieces");
  assert.equal(purchase.lines[0].unit, "piece");
  assert.equal(purchase.lines[0].lineTotal, 36000);
  assert.equal(stockOf(d), 35);
});

test("pieces that do not fill whole boxes are refused, not rounded", () => {
  const d = withSupplier();
  const r = P.saveDraft(d, input(d, { unit: "piece", qty: "10", unitPrice: "360" }));
  assert.match(r.error, /whole/i, "10 pieces = 2.5 boxes");
  assert.equal(stockOf(d), 10);
});

/* 4. Missing conversion information */

test("a product with no coverage per box can not be bought by m²: the message says what is missing", () => {
  const d = withSupplier([tile({ coveragePerBox: null, priceUnit: "box" })]);
  for (const unit of ["m2", "piece"]) {
    const r = P.saveDraft(d, input(d, { unit, qty: "10", unitPrice: "1000" }));
    assert.ok(r.error, unit + " is refused");
    assert.match(r.error, /coverage per box/i);
    assert.match(r.error, /Floor 60x60/);
    assert.equal(r.field, "line.0.unit");
  }
  const byBox = P.saveDraft(d, input(d, { unit: "box", qty: "5", unitPrice: "1000" }));
  assert.ok(byBox.purchase, "buying in the stock unit needs no conversion");
  assert.equal(stockOf(d), 10, "nothing was added by the refused attempts");
});

test("a product with no tile size can not be bought by the piece, but can by m²", () => {
  const d = withSupplier([tile({ tileSize: "" })]);
  assert.match(P.saveDraft(d, input(d, { unit: "piece", qty: "8", unitPrice: "300" })).error, /tile size/i);
  assert.equal(P.saveDraft(d, input(d, { unit: "m2", qty: "14.4", unitPrice: "1000" })).purchase.lines[0].baseQty, 10);
});

test("a conversion typed by hand is ignored: the product decides", () => {
  const d = withSupplier();
  const r = P.saveDraft(d, input(d, { unit: "m2", qty: "14.4", factor: "99", unitPrice: "1000" }));
  assert.equal(r.purchase.lines[0].baseQty, 10);
});

test("a draft is converted again with the product's current information when it is confirmed", () => {
  const d = withSupplier();
  const saved = P.saveDraft(d, input(d, { unit: "m2", qty: "14.4", unitPrice: "1000" }));
  assert.equal(saved.purchase.lines[0].baseQty, 10);
  d.products[0].coveragePerBox = 2.88;   // the product was corrected before the purchase was confirmed
  const done = P.confirmPurchase(d, saved.purchase.id);
  assert.equal(done.purchase.lines[0].baseQty, 5, "14.4 ÷ 2.88, not the factor saved with the draft");
  assert.equal(stockOf(d), 15);
});

test("a draft whose product lost its coverage can not be confirmed on an old conversion", () => {
  const d = withSupplier();
  const saved = P.saveDraft(d, input(d, { unit: "m2", qty: "14.4", unitPrice: "1000" }));
  d.products[0].coveragePerBox = null;
  const done = P.confirmPurchase(d, saved.purchase.id);
  assert.match(done.error, /coverage per box/i);
  assert.equal(d.purchases[0].status, "draft");
  assert.equal(stockOf(d), 10);
});

/* 5. A new product made from the purchase */

test("a product made from the purchase page is the Stock page's product: same rules, found by the same checks", () => {
  const typed = { name: "Everton Grey", manufacturer: "Timgad", tileSize: "60 x 120", coveragePerBox: "2.88", prices: [{ unit: "m2", price: "1900" }], stockUnit: "box", sku: "EV", stock: "0" };
  const fromStock = V.readProductInput(typed, { products: [] });
  const fromPurchase = V.readProductInput(typed, { products: [], stockFromPurchase: true });
  assert.deepEqual(fromPurchase.values, fromStock.values, "the same fields and the same values (stock starts at 0)");
  const d = withSupplier();
  const again = V.readProductInput({ ...typed, name: "floor 60x60", manufacturer: "Timgad Ceramic", tileSize: "60*60", sku: "" }, { products: d.products, stockFromPurchase: true });
  assert.match(again.error, /already exists/i, "an exact repeat is refused by the shared rules");
});

test("a likely match is found before a new product is added: same name, or one name inside the other", () => {
  const products = [tile(), tile({ id: "p-2", name: "Everton Grey", tileSize: "60*120", sku: "EV", coveragePerBox: 2.88 })];
  const names = (candidate) => V.findSimilarProducts(candidate, products).map((p) => p.name);
  assert.deepEqual(names({ name: "FLOOR 60X60", tileSize: "60*60" }), ["Floor 60x60"], "case and spaces do not matter");
  assert.deepEqual(names({ name: "Évertón-Grey", tileSize: "" }), ["Everton Grey"], "accents and punctuation do not matter");
  assert.deepEqual(names({ name: "Everton", tileSize: "60*120" }), ["Everton Grey"], "one name inside the other");
  assert.deepEqual(names({ name: "Everton", tileSize: "30*30" }), [], "a different tile size tells them apart");
  assert.deepEqual(names({ name: "Marble", tileSize: "60*60" }), []);
});

test("a new product bought straight away is stored once, with stock from the goods received only", async () => {
  const d = withSupplier([]);
  const created = V.readProductInput({ name: "Granite", manufacturer: "Timgad", tileSize: "60*60", coveragePerBox: "1.44", prices: [{ unit: "m2", price: "2000" }], stockUnit: "box", sku: "GR" }, { products: [], stockFromPurchase: true });
  d.products.push({ id: "p-new", manufacturer: "", ...created.values });
  assert.equal(d.products[0].stock, 0);
  const purchase = confirmLine(d, { productId: "p-new", unit: "m2", qty: "28.8", unitPrice: "1500" });
  assert.equal(purchase.lines[0].baseQty, 20);
  assert.equal(stockOf(d, "p-new"), 20, "available to sell, and to buy again");
  confirmLine(d, { productId: "p-new", unit: "box", qty: "5", unitPrice: "2100" });
  assert.equal(stockOf(d, "p-new"), 25);
});

/* 6. + 7. Confirming, stock and totals */

test("confirming adds stock once: a second confirmation does nothing", () => {
  const d = withSupplier();
  const saved = P.saveDraft(d, input(d, { unit: "m2", qty: "207.36", unitPrice: "1000" }));
  const first = P.confirmPurchase(d, saved.purchase.id);
  assert.ok(first.purchase);
  assert.equal(stockOf(d), 154);
  const second = P.confirmPurchase(d, saved.purchase.id);
  assert.equal(second.skip, true);
  assert.equal(second.already, true);
  assert.equal(stockOf(d), 154, "not 298");
  assert.equal(d.purchases[0].receipts.length, 1);
});

test("line discounts and invoice totals are right and the history keeps the original figures", () => {
  const d = withSupplier();
  const purchase = confirmLine(d, { unit: "m2", qty: "207.36", unitPrice: "1000", discount: "7360" }, { delivery: "2000" });
  const line = purchase.lines[0];
  assert.equal(line.lineTotal, 200000, "207,360 - 7,360 line discount");
  assert.equal(purchase.subtotal, 200000);
  assert.equal(purchase.total, 202000, "plus 2,000 delivery");
  assert.deepEqual({ qty: line.qty, unit: line.unit, unitPrice: line.unitPrice, discount: line.discount, baseQty: line.baseQty }, { qty: 207.36, unit: "m2", unitPrice: 1000, discount: 7360, baseQty: 144 });
  assert.match(P.saveDraft(d, input(d, { unit: "m2", qty: "14.4", unitPrice: "1000", discount: "99999" })).error, /discount/i, "a discount over the line is refused");
});

test("zero, negative and unreadable quantities and prices are refused", () => {
  const d = withSupplier();
  for (const qty of ["0", "-5", "abc", "1e999", ""]) {
    const r = P.previewPurchase(d, input(d, { unit: "m2", qty, unitPrice: "1000" }), "confirm");
    assert.ok(r.errors.some((e) => e.field === "line.0.qty"), `quantity "${qty}"`);
  }
  for (const unitPrice of ["-1", "abc", ""]) {
    const r = P.previewPurchase(d, input(d, { unit: "m2", qty: "14.4", unitPrice }), "confirm");
    assert.ok(r.errors.some((e) => e.field === "line.0.unitPrice"), `price "${unitPrice}"`);
  }
  assert.equal(stockOf(d), 10);
});

/* 8. Selling price and its basis */

test("buying never touches the selling price, its unit, its other prices or the product's own cost", () => {
  const product = tile({ sellingPrices: [{ unit: "m2", price: 1200 }, { unit: "box", price: 1728 }], purchasePrice: 800 });
  const d = withSupplier([product]);
  const before = JSON.stringify({ ...d.products[0], stock: 0 });
  confirmLine(d, { unit: "m2", qty: "207.36", unitPrice: "1000" });
  confirmLine(d, { unit: "box", qty: "20", unitPrice: "1440" });
  confirmLine(d, { unit: "piece", qty: "100", unitPrice: "360" });
  const after = d.products[0];
  assert.equal(JSON.stringify({ ...after, stock: 0 }), before);
  assert.equal(after.priceUnit, "m2");
  assert.equal(after.sellingPrice, 1200);
  assert.equal(after.stock, 10 + 144 + 20 + 25);
});

/* 9. Drafts */

test("a draft never changes stock, and neither does editing it", () => {
  const d = withSupplier();
  const saved = P.saveDraft(d, input(d, { unit: "m2", qty: "207.36", unitPrice: "1000" }));
  assert.equal(saved.purchase.status, "draft");
  assert.equal(stockOf(d), 10);
  const again = P.saveDraft(d, { ...input(d, { unit: "m2", qty: "14.4", unitPrice: "1000" }), id: saved.purchase.id });
  assert.equal(again.purchase.lines[0].baseQty, 10);
  assert.equal(stockOf(d), 10);
  assert.deepEqual(P.previewPurchase(d, input(d, { unit: "m2", qty: "207.36", unitPrice: "1000" }), "confirm").errors, [], "a live preview saves nothing");
  assert.equal(stockOf(d), 10);
});

/* 10. Persistence */

test("the purchase and the stock survive a restart of the database", async () => {
  const db = newDb();
  await db.initDatabase();
  const seed = await db.loadAll();
  const start = structuredClone(seed);
  start.products = [tile()];
  await db.commitChanges(DB.diff(seed, start), { expectedRevision: seed.revision });

  const before = await db.loadAll();
  const d = structuredClone(before);
  d.attachments = { put: [], remove: [] };
  P.saveSupplier(d, { name: "Timgad Ceramic", paymentTermsDays: "30" });
  const saved = P.saveDraft(d, input(d, { unit: "m2", qty: "207.36", unitPrice: "1000" }));
  assert.ok(saved.purchase, saved.error);
  assert.ok(P.confirmPurchase(d, saved.purchase.id).purchase);
  await db.commitChanges(DB.diff(before, d), { expectedRevision: before.revision });

  const after = await db.loadAll();
  assert.equal(after.products[0].stock, 154);
  assert.equal(after.purchases.length, 1);
  const line = after.purchases[0].lines[0];
  assert.deepEqual({ qty: line.qty, unit: line.unit, unitPrice: line.unitPrice, baseQty: line.baseQty, lineTotal: line.lineTotal }, { qty: 207.36, unit: "m2", unitPrice: 1000, baseQty: 144, lineTotal: 207360 });
  assert.equal(after.products[0].priceUnit, "m2");
  assert.equal(after.products[0].sellingPrice, 1200);
});

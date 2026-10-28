"use strict";

// Partial fulfilment: an invoice that is paid in full can still have goods waiting in the warehouse.
// A sale may deliver only part of a line now; the rest is collected later, in one or several pick-ups.
// Tested through the application functions in script.js and the rules in validation.js / database.js.
const assert = require("node:assert/strict");
const test = require("node:test");
const { loadProductApi, openDatabase } = require("./helpers");
const { V, sampleInvoice } = require("./helpers/modules");
const { loadApp } = require("./helpers/app");

const plain = (value) => JSON.parse(JSON.stringify(value));

// The example of the feature: 10 boxes in the warehouse, a customer buys 15 boxes at 1,000 DA and pays everything.
function load(overrides = {}, extraProducts = []) {
  const { api, field } = loadProductApi();
  const tile = api.normalizeProduct({
    id: "t1", name: "Golden Era", sku: "GE-1", tileSize: "60*120", coveragePerBox: 2.88,
    sellingPrice: 1000, priceUnit: "box", stockUnit: "box", stock: 10, ...overrides,
  });
  api.applyData({
    products: [tile, ...extraProducts.map((p) => api.normalizeProduct(p))], invoices: [],
    settings: { ...api.DEFAULT_SETTINGS }, counter: 0, lastSaved: "",
  });
  return { api, field };
}

const product = (api, id = "t1") => api.getProducts().find((p) => p.id === id);
const invoiceOf = (api, n = 0) => api.getInvoices()[n];

// Puts `qty` of the product on the sale, marks the line "deliver only part now" and makes it `sold` in total.
function startPartialSale(api, { sold = 15, unit = "box", id = "t1", paid = "" } = {}) {
  const added = api.addToSale(id, "1", unit);
  assert.equal(added.ok, true, added.error);
  const line = api.getSale().items.find((i) => i.productId === id && i.sellingUnit === unit);
  assert.deepEqual(plain(api.setSalePartial(line.lineId, true)), {});
  const changed = api.updateSaleQuantity(line.lineId, String(sold));
  assert.equal(changed.error, undefined, changed.error);
  api.getSale().paidValue = String(paid);
  return line;
}

async function complete(api) {
  await openDatabase(api);   // saving goes to a disposable in-memory IndexedDB
  const result = await api.commit((d) => api.applySale(d, api.getSale()));
  assert.equal(result.error, undefined, result.error);
  return result.invoice;
}

// The reference invoice: 15 boxes sold, 10 delivered, fully paid (15,000 DA).
async function paidPartialInvoice(overrides) {
  const app = load(overrides);
  startPartialSale(app.api, { paid: 15000 });
  const invoice = await complete(app.api);
  return { ...app, invoice };
}

const collect = (api, invoice, qty, note) => api.recordCollection(invoice.id, [{ lineId: invoice.items[0].lineId, qty: String(qty) }], note);

/* ---------- Selling more than the stock: the line is delivered in part ---------- */

test("selling more than the stock is still refused unless the line is marked 'deliver only part now'", () => {
  const { api } = load();
  const refused = api.addToSale("t1", "15", "box");
  assert.match(refused.error, /^Not enough stock/);
  assert.equal(refused.lowStock, true, "the screen can then point at the partial delivery option");
  assert.equal(api.getSale().items.length, 0);

  assert.equal(api.addToSale("t1", "10", "box").ok, true);
  const line = api.getSale().items[0];
  const clamped = api.updateSaleQuantity(line.lineId, "15");
  assert.equal(clamped.clamped, true, "a line that delivers everything now is still held to the stock");
  assert.equal(line.qty, 10);
});

test("the example: 15 boxes sold and paid, 10 delivered now, 5 left to collect, total and payment untouched", async () => {
  const { api, invoice } = await paidPartialInvoice();
  assert.equal(invoice.items[0].qty, 15);
  assert.equal(invoice.items[0].total, 15000);
  assert.equal(invoice.total, 15000);
  assert.deepEqual(plain(invoice.payments).map((p) => p.amount), [15000]);
  assert.equal(product(api).stock, 0, "only the 10 delivered boxes left the warehouse");
  assert.equal(invoice.items[0].stockDeducted, 10);

  assert.equal(invoice.deliveries.length, 1);
  assert.equal(invoice.deliveries[0].type, "sale");
  assert.deepEqual(plain(invoice.deliveries[0].lines), [{ lineId: invoice.items[0].lineId, qty: 10, stockDeducted: 10 }]);

  const detail = V.deliveryDetail(invoice);
  assert.deepEqual([detail.tracked, detail.status], [true, "partial"]);
  assert.deepEqual([detail.lines[0].qty, detail.lines[0].delivered, detail.lines[0].remaining], [15, 10, 5]);

  // payment and delivery are two different statuses
  assert.equal(api.paymentInfo(invoice).cls, "paid");
  assert.equal(api.paymentInfo(invoice).remaining, 0);
  assert.equal(detail.status === "complete", false);
});

test("a sale delivered in full has no delivery log at all, exactly like before", async () => {
  const { api } = load();
  api.addToSale("t1", "4", "box");
  const invoice = await complete(api);
  assert.equal("deliveries" in invoice, false);
  assert.equal("lineId" in invoice.items[0], false);
  assert.equal(V.deliveryDetail(invoice).status, "complete");
  assert.equal(product(api).stock, 6);
});

test("a line marked partial but delivered in full is saved as an ordinary sale", async () => {
  const { api } = load();
  const line = startPartialSale(api, { sold: 4 });
  assert.equal(line.deliverNow, 4, "delivers everything it can by default");
  const invoice = await complete(api);
  assert.equal("deliveries" in invoice, false);
  assert.equal(product(api).stock, 6);
});

test("'deliver now' follows the stock until the person types a number, and never exceeds the quantity sold or the stock", () => {
  const { api } = load();
  const line = startPartialSale(api, { sold: 15 });
  assert.equal(line.deliverNow, 10, "all that is available");
  api.updateSaleQuantity(line.lineId, "12");
  assert.equal(line.deliverNow, 10);
  api.updateSaleQuantity(line.lineId, "8");
  assert.equal(line.deliverNow, 8, "never more than the quantity sold");

  const typed = api.updateSaleDeliverNow(line.lineId, "5");
  assert.equal(typed.error, undefined);
  assert.equal(line.deliverNow, 5);
  api.updateSaleQuantity(line.lineId, "15");
  assert.equal(line.deliverNow, 5, "a typed number is kept");

  const tooMuch = api.updateSaleDeliverNow(line.lineId, "11");
  assert.equal(tooMuch.clamped, true);
  assert.match(tooMuch.error, /Not enough stock/);
  assert.equal(line.deliverNow, 10);
  const beyondSale = api.updateSaleDeliverNow(line.lineId, "16");
  assert.equal(beyondSale.clamped, true);
  assert.equal(line.deliverNow, 10, "brought back to a valid number: the stock can only deliver 10");
  api.updateSaleQuantity(line.lineId, "8");
  api.updateSaleDeliverNow(line.lineId, "9");
  assert.equal(line.deliverNow, 8, "never more than the quantity sold when the stock could deliver more");
});

test("delivering 0 now is allowed: everything is collected later and no stock moves", async () => {
  const { api } = load();
  const line = startPartialSale(api, { sold: 15 });
  assert.equal(api.updateSaleDeliverNow(line.lineId, "0").error, undefined);
  assert.equal(api.validateSale().length, 0);
  const invoice = await complete(api);
  assert.deepEqual(plain(invoice.deliveries), []);
  assert.equal(product(api).stock, 10);
  const detail = V.deliveryDetail(invoice);
  assert.deepEqual([detail.status, detail.lines[0].delivered, detail.lines[0].remaining], ["pending", 0, 15]);
});

test("a delivered-now quantity that is blank, negative, fractional (boxes) or beyond the stock is refused", () => {
  const { api } = load();
  const line = startPartialSale(api, { sold: 15 });
  assert.match(api.updateSaleDeliverNow(line.lineId, "").error, /deliver now/i);
  assert.match(api.updateSaleDeliverNow(line.lineId, "-1").error, /deliver now/i);
  assert.match(api.updateSaleDeliverNow(line.lineId, "2.5").error, /whole number/);
  line.deliverNow = 11;   // a screen that got out of step with the stock
  assert.ok(api.validateSale().some((e) => /Not enough stock/.test(e)), "checked again when the sale is completed");
});

test("applySale checks the delivered quantity against the stock again, so stock can not go negative from a sale", async () => {
  const { api } = load();
  const line = startPartialSale(api, { sold: 15 });
  await openDatabase(api);
  line.deliverNow = 11;
  const result = await api.commit((d) => api.applySale(d, api.getSale()));
  assert.match(result.error, /Not enough stock/);
  assert.equal(product(api).stock, 10);
  assert.equal(api.getInvoices().length, 0);

  line.deliverNow = 16;   // more than was sold
  const over = await api.commit((d) => api.applySale(d, api.getSale()));
  assert.ok(over.error);
  assert.equal(api.getInvoices().length, 0);
});

test("unticking 'deliver only part now' on a line beyond the stock brings its quantity back to the stock", () => {
  const { api } = load();
  const line = startPartialSale(api, { sold: 15 });
  const result = api.setSalePartial(line.lineId, false);
  assert.equal(result.clamped, true);
  assert.equal(line.qty, 10);
  assert.equal(line.partial, false);
  assert.equal("deliverNow" in line, false);
});

test("stock lowered elsewhere lowers what a partial line delivers now, never the quantity sold", () => {
  const { api } = load();
  const line = startPartialSale(api, { sold: 15 });
  product(api).stock = 6;
  const notes = api.syncSaleWithProducts();
  assert.equal(api.getSale().items[0].qty, 15);
  assert.equal(api.getSale().items[0].deliverNow, 6);
  assert.equal(notes.length, 1);
  assert.equal(api.validateSale().length, 0);
  product(api).stock = 12;
  api.syncSaleWithProducts();
  assert.equal(line.deliverNow, 12, "untouched deliveries follow the stock back up");
});

/* ---------- Units: boxes, pieces and square metres ---------- */

test("square metres (stock counted in m²): 20 m² sold, 10.08 m² delivered now, the remaining 9.92 m² collected later", async () => {
  const { api } = load({ stockUnit: "m2", stock: 10.08, coveragePerBox: 1.44, tileSize: "60*60", sellingPrice: 1500, priceUnit: "m2" });
  const line = startPartialSale(api, { sold: 20, unit: "m2" });
  assert.equal(line.sellingUnit, "m2");
  assert.equal(line.deliverNow, 10.08);
  const invoice = await complete(api);
  assert.equal(invoice.items[0].sellingUnit, "m2");
  assert.equal(invoice.items[0].qty, 20);
  assert.equal(invoice.items[0].total, 30000);
  assert.equal(invoice.items[0].stockDeducted, 10.08);
  assert.equal(product(api).stock, 0);
  assert.equal(V.deliveryDetail(invoice).lines[0].remaining, 9.92);

  product(api).stock = 10;   // goods arrive
  const first = await collect(api, invoice, "5");
  assert.equal(first.error, undefined, first.error);
  assert.equal(product(api).stock, 5);
  assert.match((await collect(api, invoiceOf(api), "5")).error, /only 4.92 m² left to collect/, "over-delivery in m² is refused too");
  const rest = await collect(api, invoiceOf(api), "4.92");
  assert.equal(rest.error, undefined, rest.error);
  assert.equal(V.deliveryDetail(invoiceOf(api)).status, "complete");
  assert.equal(product(api).stock, 0.08);
});

test("a box-counted product typed in m² becomes whole boxes first, and that box line can be delivered in part", async () => {
  const { api } = load({ stock: 10, coveragePerBox: 1.44, tileSize: "60*60", sellingPrice: 1500, priceUnit: "m2" });
  const refused = api.addToSale("t1", "25", "m2");   // 25 m² = 17.36 boxes -> 18 boxes: more than the 10 in stock
  assert.equal(refused.lowStock, true);
  const added = api.addToSale("t1", "10", "m2");     // 10 m² = 6.94 boxes -> 7 boxes
  assert.equal(added.ok, true, added.error);
  assert.equal(added.converted.boxes, 7);
  const line = api.getSale().items[0];
  assert.equal(line.sellingUnit, "box");
  api.setSalePartial(line.lineId, true);
  api.updateSaleQuantity(line.lineId, "18");
  assert.equal(line.deliverNow, 10);
  const invoice = await complete(api);
  assert.equal(invoice.items[0].qty, 18);
  assert.equal(V.deliveryDetail(invoice).lines[0].remaining, 8);
  assert.equal(product(api).stock, 0);
});

test("pieces: delivered pieces are taken out of box-counted stock as fractions of a box", async () => {
  const { api } = load({ stock: 3, tileSize: "60*60", coveragePerBox: 1.44, sellingPrice: 1500, priceUnit: "m2" });   // 4 pieces per box
  const line = startPartialSale(api, { sold: 20, unit: "piece" });
  assert.equal(line.deliverNow, 12, "3 boxes = 12 pieces");
  const invoice = await complete(api);
  assert.equal(product(api).stock, 0);
  assert.equal(V.deliveryDetail(invoice).lines[0].remaining, 8);

  product(api).stock = 5;
  assert.match((await collect(api, invoice, "2.5")).error, /whole number/, "pieces are whole");
  const ok = await collect(api, invoice, "3");
  assert.equal(ok.error, undefined, ok.error);
  assert.equal(product(api).stock, 4.25, "3 pieces = 0.75 box");
  assert.equal(V.deliveryDetail(invoiceOf(api)).lines[0].remaining, 5);
});

/* ---------- Recording a collection ---------- */

test("a collection takes the delivered quantity out of stock, shows what is still outstanding and never edits the invoice", async () => {
  const { api, invoice } = await paidPartialInvoice();
  const before = plain({ ...invoice, deliveries: undefined });
  product(api).stock = 10;   // new goods arrive

  const first = await collect(api, invoice, "3", "  collected by Ali ");
  assert.equal(first.error, undefined, first.error);
  assert.equal(product(api).stock, 7);
  let saved = invoiceOf(api);
  assert.equal(V.deliveryDetail(saved).lines[0].remaining, 2);
  assert.equal(V.deliveryDetail(saved).status, "partial");
  assert.equal(saved.deliveries.length, 2);
  assert.equal(saved.deliveries[1].type, "collection");
  assert.equal(saved.deliveries[1].note, "collected by Ali");
  assert.deepEqual(plain(saved.deliveries[1].lines), [{ lineId: saved.items[0].lineId, qty: 3, stockDeducted: 3 }]);

  const rest = await collect(api, saved, "2");
  assert.equal(rest.error, undefined, rest.error);
  assert.equal(product(api).stock, 5);
  saved = invoiceOf(api);
  assert.equal(V.deliveryDetail(saved).status, "complete");
  assert.equal(V.deliveryDetail(saved).lines[0].delivered, 15);
  assert.deepEqual(V.collectionReceipts(saved).map((r) => r.number), ["COL-000001-1", "COL-000001-2"]);

  // the original invoice, its prices, total and payments are exactly as issued
  assert.deepEqual(plain({ ...saved, deliveries: undefined }), before);
  assert.equal(api.paymentInfo(saved).cls, "paid");

  // nothing is left to collect any more
  assert.match((await collect(api, saved, "1")).error, /nothing left to collect/i);
  assert.equal(product(api).stock, 5);
});

test("over-delivery is refused: a collection can never exceed what is left to collect", async () => {
  const { api, invoice } = await paidPartialInvoice();
  product(api).stock = 20;
  const result = await collect(api, invoice, "6");
  assert.match(result.error, /only 5 Boxes left to collect/);
  assert.equal(product(api).stock, 20, "no stock moved");
  assert.equal(invoiceOf(api).deliveries.length, 1, "nothing was recorded");

  assert.equal((await collect(api, invoice, "5")).error, undefined);
  assert.match((await collect(api, invoiceOf(api), "1")).error, /nothing left/i);
  assert.equal(product(api).stock, 15);
});

test("a collection needs a real quantity: blank, zero, negative, text and fractional boxes are refused", async () => {
  const { api, invoice } = await paidPartialInvoice();
  product(api).stock = 20;
  for (const bad of ["", "0", "-2", "abc"]) {
    const result = await collect(api, invoice, bad);
    assert.ok(result.error, `"${bad}" must be refused`);
  }
  assert.match((await collect(api, invoice, "1.5")).error, /whole number/);
  assert.match((await api.recordCollection(invoice.id, [{ lineId: "not-a-line", qty: "1" }])).error, /does not belong/);
  assert.equal(product(api).stock, 20);
  assert.equal(invoiceOf(api).deliveries.length, 1);
});

test("stock can never go negative through a collection: it is refused, nothing is recorded, then the available part can be delivered", async () => {
  const { api, invoice } = await paidPartialInvoice();   // 0 boxes in stock, 5 to collect
  const none = await collect(api, invoice, "2");
  assert.match(none.error, /not enough stock/i);
  assert.equal(product(api).stock, 0);
  assert.equal(invoiceOf(api).deliveries.length, 1);

  product(api).stock = 3;
  const tooMany = await collect(api, invoice, "5");
  assert.match(tooMany.error, /not enough stock/i);
  assert.equal(product(api).stock, 3);

  assert.equal((await collect(api, invoice, "3")).error, undefined);
  assert.equal(product(api).stock, 0);
  assert.equal(V.deliveryDetail(invoiceOf(api)).lines[0].remaining, 2);
  assert.match((await collect(api, invoiceOf(api), "2")).error, /not enough stock/i);
  assert.equal(product(api).stock, 0, "never below zero");
});

test("two lines of the same product share one stock pool when they are collected together", async () => {
  const { api } = load({ stock: 4, tileSize: "60*60", coveragePerBox: 1.44, sellingPrice: 1500, priceUnit: "m2" });
  assert.equal(api.addToSale("t1", "2", "box").ok, true);
  assert.equal(api.addToSale("t1", "2", "piece").ok, true);
  const [boxes, pieces] = api.getSale().items;
  for (const [line, sold] of [[boxes, "8"], [pieces, "16"]]) {
    api.setSalePartial(line.lineId, true);
    api.updateSaleQuantity(line.lineId, sold);
  }
  assert.equal(api.updateSaleDeliverNow(pieces.lineId, "0").error, undefined);
  assert.equal(api.updateSaleDeliverNow(boxes.lineId, "4").error, undefined);   // the whole stock goes to the boxes
  const invoice = await complete(api);
  assert.equal(product(api).stock, 0);
  product(api).stock = 5;
  const entries = [{ lineId: invoice.items[0].lineId, qty: "4" }, { lineId: invoice.items[1].lineId, qty: "16" }];   // 4 boxes + 16 pieces = 8 boxes
  const refused = await api.recordCollection(invoice.id, entries);
  assert.match(refused.error, /not enough stock/i);
  assert.equal(product(api).stock, 5);
  assert.equal(invoiceOf(api).deliveries.length, 1);

  const ok = await api.recordCollection(invoice.id, [entries[0], { lineId: entries[1].lineId, qty: "4" }]);   // 4 boxes + 4 pieces = 5 boxes
  assert.equal(ok.error, undefined, ok.error);
  assert.equal(product(api).stock, 0);
});

test("one collection can deliver several lines at once and is recorded as one entry", async () => {
  const { api } = load({ stock: 2 }, [{ id: "t2", name: "Marble", tileSize: "60*60", coveragePerBox: 1.44, sellingPrice: 2000, priceUnit: "box", stockUnit: "box", stock: 1 }]);
  startPartialSale(api, { sold: 5, id: "t1" });
  startPartialSale(api, { sold: 3, id: "t2" });
  const invoice = await complete(api);
  assert.equal(invoice.deliveries[0].lines.length, 2);
  product(api).stock = 4;
  product(api, "t2").stock = 5;
  const result = await api.recordCollection(invoice.id, [{ lineId: invoice.items[0].lineId, qty: "3" }, { lineId: invoice.items[1].lineId, qty: "2" }]);
  assert.equal(result.error, undefined, result.error);
  assert.equal(invoiceOf(api).deliveries.length, 2);
  assert.equal(invoiceOf(api).deliveries[1].lines.length, 2);
  assert.deepEqual([product(api).stock, product(api, "t2").stock], [1, 3]);
});

test("a product that was deleted from Stock can not be collected: nothing is recorded", async () => {
  const { api, invoice } = await paidPartialInvoice();
  api.getState().products.length = 0;
  const result = await collect(api, invoice, "1");
  assert.match(result.error, /no longer exists/);
  assert.equal(invoiceOf(api).deliveries.length, 1);
});

test("payment and delivery are independent: an unpaid invoice can be collected and a payment never changes the deliveries", async () => {
  const app = load();
  startPartialSale(app.api, { paid: "" });   // nothing paid
  const invoice = await complete(app.api);
  assert.equal(app.api.paymentInfo(invoice).cls, "unpaid");
  app.api.getProducts()[0].stock = 5;
  assert.equal((await collect(app.api, invoice, "5")).error, undefined);
  assert.equal(app.api.paymentInfo(invoiceOf(app.api)).cls, "unpaid", "collecting goods did not pay anything");
  assert.equal(V.deliveryDetail(invoiceOf(app.api)).status, "complete");

  const deliveriesBefore = plain(invoiceOf(app.api).deliveries);
  const paid = await app.api.addPayment(invoice.id, "15000");
  assert.equal(paid.error, undefined, paid.error);
  assert.equal(app.api.paymentInfo(invoiceOf(app.api)).cls, "paid");
  assert.deepEqual(plain(invoiceOf(app.api).deliveries), deliveriesBefore);
});

/* ---------- The data rules: audit trail and refusals at the database ---------- */

test("legacy invoices (no delivery log) are fully delivered, valid, and can not be 'collected'", async () => {
  const legacy = sampleInvoice({ number: 1 });
  assert.equal(V.invoiceProblem(legacy), "");
  const detail = V.deliveryDetail(legacy);
  assert.deepEqual([detail.tracked, detail.status, detail.toCollect.length], [false, "complete", 0]);
  const { api } = load();
  api.applyData({ ...api.getState(), invoices: [legacy] });
  await openDatabase(api);
  assert.match((await api.recordCollection(legacy.id, [{ lineId: "x", qty: "1" }])).error, /nothing left/i);
});

test("the delivery log is validated: over-delivery, unknown lines, duplicates and fractional boxes are rejected", async () => {
  const { invoice } = await paidPartialInvoice();
  const good = plain(invoice);
  assert.equal(V.invoiceProblem(good), "");
  const lineId = good.items[0].lineId;
  const mutate = (change) => { const copy = plain(good); change(copy); return V.invoiceProblem(copy); };
  const entry = (extra) => ({ id: "d-x", type: "collection", date: good.date, lines: [{ lineId, qty: 1, stockDeducted: 1 }], ...extra });

  assert.match(mutate((i) => i.deliveries.push(entry({ lines: [{ lineId, qty: 6, stockDeducted: 6 }] }))), /more than was sold/);
  assert.match(mutate((i) => i.deliveries.push(entry({ lines: [{ lineId: "ghost", qty: 1, stockDeducted: 1 }] }))), /invalid delivery/);
  assert.match(mutate((i) => i.deliveries.push(entry({ id: i.deliveries[0].id }))), /invalid delivery/);
  assert.match(mutate((i) => i.deliveries.push(entry({ type: "refund" }))), /invalid delivery/);
  assert.match(mutate((i) => i.deliveries.push(entry({ lines: [{ lineId, qty: 1.5, stockDeducted: 1.5 }] }))), /invalid delivery/);
  assert.match(mutate((i) => i.deliveries.push(entry({ lines: [{ lineId, qty: 0, stockDeducted: 0 }] }))), /invalid delivery/);
  assert.match(mutate((i) => i.deliveries.push(entry({ lines: [] }))), /invalid delivery/);
  assert.match(mutate((i) => { i.deliveries[0].type = "sale"; i.deliveries.push(entry({ type: "sale" })); }), /invalid delivery/);
  assert.match(mutate((i) => { delete i.items[0].lineId; }), /invalid delivery/);
  assert.match(mutate((i) => { i.deliveries = "none"; }), /invalid delivery/);
  assert.equal(mutate((i) => i.deliveries.push(entry({ lines: [{ lineId, qty: 5, stockDeducted: 5 }] }))), "", "exactly what is left is fine");
});

test("the database refuses a delivery log that would deliver more than was sold, even if a screen tried", async () => {
  const { api, invoice } = await paidPartialInvoice();
  const tampered = plain(invoice);
  tampered.deliveries.push({ id: "d-evil", type: "collection", date: new Date().toISOString(), lines: [{ lineId: tampered.items[0].lineId, qty: 9, stockDeducted: 9 }] });
  await assert.rejects(api.db.commitChanges({ invoices: { put: [tampered], remove: [] } }), (e) => e.code === "INVALID");
  const stored = (await api.db.loadAll()).invoices[0];
  assert.equal(stored.deliveries.length, 1);
});

test("the delivery log is append-only at the database: a saved delivery can not be edited or removed", async () => {
  const { api, invoice } = await paidPartialInvoice();
  product(api).stock = 10;
  assert.equal((await collect(api, invoice, "2")).error, undefined);
  const stored = (await api.db.loadAll()).invoices[0];

  const lowered = plain(stored);
  lowered.deliveries[1].lines[0].qty = 1;
  await assert.rejects(api.db.commitChanges({ invoices: { put: [lowered], remove: [] } }), (e) => e.code === "INVALID");

  const trimmed = plain(stored);
  trimmed.deliveries.pop();
  await assert.rejects(api.db.commitChanges({ invoices: { put: [trimmed], remove: [] } }), (e) => e.code === "INVALID");

  const reduced = plain(stored);
  reduced.items[0].qty = 12;
  await assert.rejects(api.db.commitChanges({ invoices: { put: [reduced], remove: [] } }), (e) => e.code === "INVALID");

  const untracked = plain(stored);
  delete untracked.deliveries;
  await assert.rejects(api.db.commitChanges({ invoices: { put: [untracked], remove: [] } }), (e) => e.code === "INVALID");

  assert.deepEqual(plain((await api.db.loadAll()).invoices[0]), plain(stored), "nothing changed");
});

test("an invoice saved without a delivery log can not be turned into a partly delivered one afterwards", async () => {
  const { api } = load();
  api.addToSale("t1", "2", "box");
  const invoice = await complete(api);
  const forged = plain(invoice);
  forged.items[0].lineId = "l-1";
  forged.deliveries = [];
  await assert.rejects(api.db.commitChanges({ invoices: { put: [forged], remove: [] } }), (e) => e.code === "INVALID");
});

test("an invoice with delivery records can be deleted: only the goods that were really handed over go back to stock", async () => {
  // 15 boxes sold and paid (15,000 DA), 10 delivered, 5 still to collect. Stock went 10 -> 0.
  const { api, invoice } = await paidPartialInvoice();
  assert.equal(product(api).stock, 0);
  const plan = api.planInvoiceRollback(api.getState(), invoice.id, { reason: "delete" });
  assert.equal(plan.error, undefined, plan.error);
  assert.equal(plan.refund, 15000, "everything collected is refunded");
  assert.deepEqual(plain(plan.stock.map((s) => [s.productId, s.qty])), [["t1", 10]], "10 delivered boxes go back, not the 5 never taken");

  const r = await api.commit((d) => api.applyInvoiceRollback(d, invoice.id, { reason: "delete" }));
  assert.equal(r.error, undefined, r.error);
  assert.equal(api.getInvoices().length, 0);
  assert.equal(product(api).stock, 10, "back to what the shop had before the sale, not 15");
  const stored = await api.db.loadAll();
  assert.equal(stored.invoices.length, 0, "removed from the database too");
  assert.equal(stored.products[0].stock, 10);
  assert.equal(stored.settings.rollbackLog.length, 1);
  assert.equal(stored.settings.rollbackLog[0].refund, 15000);
});

/* ---------- Two windows at once ---------- */

test("two windows can not collect the same goods twice: the second, stale window is refused and stock is deducted once", async () => {
  const first = loadApp();
  await first.start();
  const values = { name: "Golden Era", tileSize: "60*120", coveragePerBox: 2.88, sku: "GE", category: "", description: "", manufacturer: "", sellingPrice: 1000, priceUnit: "box", stockUnit: "box", purchasePrice: null, stock: 10 };
  await first.api.addProduct(values);
  const id = first.api.getState().products[0].id;
  first.api.addToSale(id, "1", "box");
  const line = first.api.getSale().items[0];
  first.api.setSalePartial(line.lineId, true);
  first.api.updateSaleQuantity(line.lineId, "15");
  first.api.getSale().paidValue = "15000";
  await first.api.completeSale();
  await first.api.addStock(id, "10");   // 10 boxes arrive

  const second = loadApp({ indexedDB: first.indexedDB });
  await second.start();
  const invoiceId = first.api.getInvoices()[0].id;
  const lineId = first.api.getInvoices()[0].items[0].lineId;

  const done = await first.api.recordCollection(invoiceId, [{ lineId, qty: "5" }]);
  assert.equal(done.error, undefined, done.error);
  const stale = await second.api.recordCollection(invoiceId, [{ lineId, qty: "5" }]);
  assert.match(stale.error, /changed in another Invoisy window/);

  const stored = await first.api.db.loadAll();
  assert.equal(stored.invoices[0].deliveries.length, 2, "recorded once");
  assert.equal(stored.products[0].stock, 5, "10 arrived, 5 collected once");
});

/* ---------- Documents ---------- */

test("the invoice shows what was delivered and what is still to collect, with the same quantity, price and total", async () => {
  const { api, invoice } = await paidPartialInvoice();
  const html = api.invoiceHtml(invoice);
  assert.match(html, /15 Boxes/);
  assert.match(html, /Delivered 10 Boxes · To collect 5 Boxes/);
  assert.match(html, /15,000 DA/);
  assert.match(html, /DELIVERY: PARTLY DELIVERED/);
  assert.match(html, /PAID/, "payment status is shown separately");
  assert.match(html, /Delivered with the sale/);
  assert.equal(api.invoiceHtml(sampleInvoice()).includes("DELIVERY"), false, "an ordinary invoice is printed as before");
});

test("the collection document lists the remaining quantities only, is linked to the invoice and carries no price or amount", async () => {
  const { api, invoice } = await paidPartialInvoice();
  const html = api.collectionHtml(invoice);
  assert.match(html, /REMAINING-QUANTITY COLLECTION DOCUMENT/);
  assert.match(html, /COL-000001/);
  assert.match(html, /Original invoice:<\/span> INV-000001/);
  assert.match(html, /not an invoice/i);
  assert.match(html, /already invoiced on INV-000001/);
  assert.match(html, /5 Boxes/);
  assert.match(html, /Payment for these goods is recorded on INV-000001 only/);
  assert.doesNotMatch(html, /\bDA\b/, "no currency");
  assert.doesNotMatch(html, /15,000|1,000/, "no price, no total");
  assert.doesNotMatch(html, /TOTAL|Subtotal|Discount|Tax/i);
  assert.match(html, /collect-qty">5 Boxes</, "the quantity to collect is the remainder, not the quantity sold");
  assert.doesNotMatch(html, /collect-qty">15/);

  // after a pick-up it shows only what is left, and the history of what was delivered
  product(api).stock = 10;
  await collect(api, invoice, "2");
  const later = api.collectionHtml(invoiceOf(api));
  assert.match(later, /3 Boxes/);
  assert.match(later, /COL-000001-1/);
  // once everything is collected there is nothing to print
  await collect(api, invoiceOf(api), "3");
  assert.match(api.collectionHtml(invoiceOf(api)), /Nothing left to collect/);
});

test("the collection document follows the language of the app", async () => {
  const { api, invoice } = await paidPartialInvoice();
  api.getState().settings.language = "fr";
  api.applyData({ ...api.getState() });
  const html = api.collectionHtml(invoice);
  assert.match(html, /BON DE RETRAIT DES QUANTITÉS RESTANTES/);
  assert.match(html, /Ceci n’est pas une facture/);
});

/* ---------- Screens ---------- */

test("the sale line shows the deliver-now control and what is left to collect; the delivery box shows both statuses", async () => {
  const { api, field } = load();
  startPartialSale(api, { sold: 15, paid: 15000 });
  api.renderSale();
  const rows = field("saleBody").innerHTML;
  assert.match(rows, /data-field="partial" checked/);
  assert.match(rows, /data-field="deliver"/);
  assert.match(rows, /5 Boxes to collect later/);

  const invoice = await complete(api);
  api.viewInvoice(invoice.id);
  api.renderInvoice();
  assert.equal(field("deliveryBox").hidden, false);
  assert.equal(field("delPayment").textContent, "PAID");
  assert.equal(field("delStatus").textContent, "PARTLY DELIVERED");
  assert.match(field("delBody").innerHTML, /Sold 15 Boxes · Delivered 10 Boxes · To collect 5 Boxes/);
  assert.match(field("delBody").innerHTML, /data-collect-qty/);
  assert.equal(field("collectBtn").disabled, false);

  product(api).stock = 5;
  await collect(api, invoice, "5");
  api.renderInvoice();
  assert.equal(field("collectBtn").disabled, true, "nothing left to collect");
  assert.equal(field("collectPrint").disabled, true);
  assert.equal(field("delStatus").textContent, "DELIVERED IN FULL");

  // an ordinary invoice has no delivery box
  const plainApp = load();
  plainApp.api.addToSale("t1", "1", "box");
  const ordinary = await complete(plainApp.api);
  plainApp.api.viewInvoice(ordinary.id);
  plainApp.api.renderInvoice();
  assert.equal(plainApp.field("deliveryBox").hidden, true);
});

/* ---------- Backup and restore ---------- */

test("partial deliveries survive a backup and a restore into a new database, with the derived status written for readers", async () => {
  const app = loadApp();
  await app.start();
  const values = { name: "Golden Era", tileSize: "60*120", coveragePerBox: 2.88, sku: "GE", category: "", description: "", manufacturer: "", sellingPrice: 1000, priceUnit: "box", stockUnit: "box", purchasePrice: null, stock: 10 };
  await app.api.addProduct(values);
  const id = app.api.getState().products[0].id;
  app.api.addToSale(id, "1", "box");
  const line = app.api.getSale().items[0];
  app.api.setSalePartial(line.lineId, true);
  app.api.updateSaleQuantity(line.lineId, "15");
  app.api.getSale().paidValue = "15000";
  await app.api.completeSale();
  await app.api.addStock(id, "3");
  const invoice = app.api.getInvoices()[0];
  assert.equal((await app.api.recordCollection(invoice.id, [{ lineId: invoice.items[0].lineId, qty: "3", note: "x" }], "Ali")).error, undefined);

  await app.api.exportBackup();
  const text = await app.downloadedText();
  const file = JSON.parse(text);
  assert.equal(file.data.invoices[0].deliveryStatus, "partial", "2 boxes are still to collect");
  assert.equal(file.data.invoices[0].deliveries.length, 2);

  const target = loadApp();
  await target.start();
  await target.api.importBackup(target.file(text));
  const restored = await target.api.db.loadAll();
  assert.equal("deliveryStatus" in restored.invoices[0], false, "calculated fields are not stored");
  assert.deepEqual(plain(restored.invoices[0].deliveries), plain(app.api.getInvoices()[0].deliveries));
  assert.equal(restored.invoices[0].deliveries[1].note, "Ali");
  assert.equal(V.deliveryDetail(restored.invoices[0]).lines[0].remaining, 2);
  assert.equal(restored.products[0].stock, 0);
});

test("a backup whose delivery log hands over more than was sold is refused", async () => {
  const { api, invoice } = await paidPartialInvoice();
  const snapshot = { ...(await api.db.loadAll()) };
  const text = JSON.stringify(V.buildBackup(snapshot));
  assert.equal(V.parseBackup(text).error, undefined);
  const file = JSON.parse(text);
  file.data.invoices[0].deliveries.push({ id: "d-x", type: "collection", date: invoice.date, lines: [{ lineId: invoice.items[0].lineId, qty: 6, stockDeducted: 6 }] });
  assert.ok(V.parseBackup(JSON.stringify(file)).error, "refused, never repaired");
});

"use strict";

// Suppliers, purchases, stock from purchases, supplier payments, reports, the database rules behind them,
// the move from database version 2 to 3, and backups. Numbers match the scenarios in the specification:
// for example 200 boxes of 1.44 m² each = 288 m² added to stock.
//
// Three levels, all against disposable in-memory IndexedDB databases (nothing touches real data):
//   - the business rules in purchases.js on a plain copy of the data,
//   - the real page scripts (script.js) saving through commit(),
//   - the database layer (database.js) and backups (validation.js).

const test = require("node:test");
const assert = require("node:assert/strict");
const { fake, V, DB, newDb, iso, sampleProduct, sampleInvoice, dump, failPutWith } = require("./helpers/modules");
const { loadApp } = require("./helpers/app");

const P = globalThis.Purchases;
const day = (offset) => P.addDays(P.toDay(new Date()), offset || 0);
const plain = (x) => JSON.parse(JSON.stringify(x));

/* ---------- helpers ---------- */

// A tile that is sold and counted in m², bought by the box (1 box = 1.44 m²). 10 m² in stock.
const tile = (overrides) => sampleProduct({
  id: "p-tile", name: "Tile A", tileSize: "60*60", coveragePerBox: 1.44, sellingPrice: 800, priceUnit: "m2", stockUnit: "m2",
  purchasePrice: null, sku: "TA-1", stock: 10, ...overrides,
});

// A plain copy of the data, shaped like the draft commit() hands to a change.
function draft(overrides) {
  return {
    products: [tile()], invoices: [], settings: { ...V.DEFAULT_SETTINGS, currency: "DZD" }, counter: 0,
    suppliers: [], purchases: [], supplierPayments: [], purchaseCounter: 0, attachments: { put: [], remove: [] },
    ...overrides,
  };
}

const supplierInput = (overrides) => ({ name: "Timgad Ceramic", phone: "0555 12 34 56", paymentTermsDays: "30", ...overrides });

// A purchase of 200 boxes at 900 DA = 180,000 DA from the first supplier.
function purchaseInput(d, overrides) {
  return {
    supplierId: d.suppliers[0].id, supplierInvoiceNumber: "FA-001", invoiceDate: day(0),
    lines: [{ productId: "p-tile", unit: "box", qty: "200", unitPrice: "900" }], ...overrides,
  };
}

function withSupplier() {
  const d = draft();
  const r = P.saveSupplier(d, supplierInput());
  assert.ok(r.supplier, r.error);
  return d;
}

function draftPurchase(d, overrides) {
  const r = P.saveDraft(d, purchaseInput(d, overrides));
  assert.ok(r.purchase, r.error);
  return r.purchase;
}

function confirmed(d, overrides, options) {
  const p = draftPurchase(d, overrides);
  const r = P.confirmPurchase(d, p.id, options);
  assert.ok(r.purchase, r.error);
  return p;
}

const stockOf = (d, id) => d.products.find((p) => p.id === (id || "p-tile")).stock;

// Runs one change through a real database exactly as the page does: load, change a copy, save only what changed.
async function change(db, mutate) {
  const before = await db.loadAll();
  const d = structuredClone(before);
  d.attachments = { put: [], remove: [] };
  const result = mutate(d) || {};
  if (result.error || result.skip) return result;
  const saved = await db.commitChanges(DB.diff(before, d), { expectedRevision: before.revision });
  return { ...result, saved };
}

async function openedDb(options) {
  const db = newDb(options);
  await db.initDatabase();
  return db;
}

async function startedApp(options) {
  const app = loadApp(options);
  const storage = await app.start();
  assert.equal(storage.mode, "ready", storage.reason);
  return app;
}

// An app with the m² tile in stock and one supplier, saved in the database.
async function shop(options) {
  const app = await startedApp(options);
  const r1 = await app.api.commit((d) => { d.products.push(tile()); });
  assert.equal(r1.error, undefined);
  const r2 = await app.api.commit((d) => P.saveSupplier(d, supplierInput()));
  assert.equal(r2.error, undefined);
  return app;
}

const state = (app) => app.api.getState();
const supplierId = (app) => state(app).suppliers[0].id;
const reload = (app) => startedApp({ indexedDB: app.indexedDB });

/* ==========================================================================
   1. Suppliers: create, edit, duplicates, archive, delete
   ========================================================================== */

test("a supplier needs a name, and an email, terms or credit limit that make sense", () => {
  const d = draft();
  assert.match(P.saveSupplier(d, supplierInput({ name: "  " })).error, /name/i);
  assert.match(P.saveSupplier(d, supplierInput({ email: "not-an-email" })).error, /email/i);
  assert.match(P.saveSupplier(d, supplierInput({ paymentTermsDays: "-3" })).error, /days/);
  assert.match(P.saveSupplier(d, supplierInput({ paymentTermsDays: "2.5" })).error, /days/);
  assert.match(P.saveSupplier(d, supplierInput({ creditLimit: "-1" })).error, /credit/i);
  assert.equal(d.suppliers.length, 0, "nothing was saved by the refused attempts");
});

test("a supplier keeps every field of the specification, with the currency taken from the settings", () => {
  const d = draft();
  const { supplier } = P.saveSupplier(d, {
    name: "Timgad Ceramic", contactName: "Karim", phone: "0555", email: "a@b.dz", address: "Zone industrielle", city: "Batna", country: "Algeria",
    taxId: "RC-1", website: "timgad.dz", paymentTermsDays: "15", creditLimit: "250000", notes: "Pays by transfer",
  });
  assert.equal(supplier.contactName, "Karim");
  assert.equal(supplier.paymentTermsDays, 15);
  assert.equal(supplier.creditLimit, 250000);
  assert.equal(supplier.currency, "DZD");
  assert.equal(supplier.archived, false);
  assert.equal(supplier.revision, 1);
  const edited = P.saveSupplier(d, { ...supplierInput(), id: supplier.id, name: "Timgad Ceramic SPA", paymentTermsDays: "custom-not-a-number-ignored-below" });
  assert.match(edited.error, /days/, "custom terms must be a number of days");
  const ok = P.saveSupplier(d, { id: supplier.id, name: "Timgad Ceramic SPA", paymentTermsDays: "45" });
  assert.equal(ok.supplier.name, "Timgad Ceramic SPA");
  assert.equal(ok.supplier.revision, 2, "every edit raises the revision");
  assert.equal(d.suppliers.length, 1, "editing never creates a second supplier");
});

test("a supplier with the same name, phone number or tax number is warned about and never merged", () => {
  const d = draft();
  P.saveSupplier(d, supplierInput({ taxId: "RC 123-45" }));
  const sameName = P.saveSupplier(d, { name: "  timgad  CERAMIC ", paymentTermsDays: "0" });
  assert.equal(sameName.skip, true);
  assert.deepEqual(sameName.duplicates[0].reasons, ["name"]);
  const samePhone = P.saveSupplier(d, { name: "Other Co", phone: "0555-12-34-56" });
  assert.deepEqual(samePhone.duplicates[0].reasons, ["phone"]);
  const sameTax = P.saveSupplier(d, { name: "Third Co", taxId: "rc12345" });
  assert.deepEqual(sameTax.duplicates[0].reasons, ["taxId"]);
  assert.equal(d.suppliers.length, 1, "nothing was saved without the person confirming");
  const forced = P.saveSupplier(d, { name: "Other Co", phone: "0555-12-34-56" }, { allowDuplicate: true });
  assert.ok(forced.supplier);
  assert.equal(d.suppliers.length, 2, "saved as a separate supplier only after confirming; the first is untouched");
  assert.equal(d.suppliers[0].name, "Timgad Ceramic");
});

test("a supplier with no history can be deleted; one with purchases or payments can only be archived", () => {
  const d = withSupplier();
  const lone = P.saveSupplier(d, { name: "Lone Co" }).supplier;
  assert.ok(P.deleteSupplier(d, lone.id).supplier);
  assert.equal(d.suppliers.length, 1);

  draftPurchase(d);
  const id = d.suppliers[0].id;
  assert.match(P.deleteSupplier(d, id).error, /archive/i, "history means archive, not delete");
  assert.equal(d.suppliers.length, 1);
  assert.equal(P.setSupplierArchived(d, id, true).supplier.archived, true);
  assert.ok(d.suppliers[0].archivedAt);
  assert.match(P.saveDraft(d, purchaseInput(d)).error, /archived/i, "an archived supplier is not offered for new purchases");
  assert.equal(P.setSupplierArchived(d, id, false).supplier.archived, false);
  assert.equal(P.saveDraft(d, purchaseInput(d, { supplierInvoiceNumber: "FA-002" })).error, undefined, "restoring brings it back");
});

/* ==========================================================================
   2-5. Purchases: drafts, new products, conversion, totals
   ========================================================================== */

test("a purchase from an existing supplier with an existing product gets its own PUR- reference and due date", () => {
  const d = withSupplier();
  const p = draftPurchase(d, { invoiceDate: "2026-10-01" });
  assert.equal(p.reference, "PUR-000001");
  assert.equal(p.status, "draft");
  assert.equal(p.dueDate, "2026-10-31", "due date comes from the 30-day terms");
  assert.equal(d.purchaseCounter, 1);
  const second = draftPurchase(d, { supplierInvoiceNumber: "FA-002" });
  assert.equal(second.reference, "PUR-000002", "references never repeat");
  assert.notEqual(p.reference, V.formatInvoiceNumber(1), "purchase references are not customer invoice numbers");
  const edited = P.saveDraft(d, { ...purchaseInput(d, { dueDate: "2026-11-15", invoiceDate: "2026-10-01" }), id: p.id });
  assert.equal(edited.purchase.dueDate, "2026-11-15", "the due date can be changed");
  assert.equal(edited.purchase.reference, "PUR-000001", "editing a draft keeps its reference");
});

test("200 boxes of 1.44 m² at 900 DA a box = 288 m² and 180,000 DA; the factor is worked out from the product", () => {
  const d = withSupplier();
  const p = draftPurchase(d);
  assert.equal(p.lines[0].factor, 1.44);
  assert.equal(p.lines[0].baseQty, 288);
  assert.equal(p.lines[0].stockUnit, "m2");
  assert.equal(p.lines[0].lineTotal, 180000);
  assert.equal(p.total, 180000);
  assert.equal(P.lineBaseQty({ qty: 200, factor: 1.44 }), 288);
});

test("a typed conversion factor is used when the product can not give one", () => {
  const d = withSupplier();
  d.products.push(sampleProduct({ id: "p-sand", name: "Sand", tileSize: "", coveragePerBox: null, priceUnit: "kg", stockUnit: "kg", sellingPrice: 10, sku: "SD", stock: 0 }));
  const noFactor = P.saveDraft(d, purchaseInput(d, { lines: [{ productId: "p-sand", unit: "m", qty: "3", unitPrice: "5" }] }));
  assert.match(noFactor.error, /how many/i, "an impossible conversion asks instead of guessing");
  const kgToKg = P.saveDraft(d, purchaseInput(d, { lines: [{ productId: "p-sand", unit: "kg", qty: "40", unitPrice: "5" }] }));
  assert.equal(kgToKg.purchase.lines[0].baseQty, 40);
  const factor = P.previewPurchase(d, purchaseInput(d, { supplierInvoiceNumber: "FA-FACTOR", lines: [{ productId: "p-sand", unit: "box", qty: "2", factor: "25", unitPrice: "100" }] }), "draft");
  assert.equal(factor.errors.length, 0);
  assert.equal(factor.purchase.lines[0].baseQty, 50);
});

test("line discounts, invoice discount, tax and delivery give clear totals; tax can be added or already included", () => {
  const d = withSupplier();
  const base = { lines: [{ productId: "p-tile", unit: "box", qty: "10", unitPrice: "1000", discount: "500" }] };
  const added = P.previewPurchase(d, purchaseInput(d, { ...base, discountType: "percent", discountValue: "10", taxType: "percent", taxValue: "19", taxMode: "added", delivery: "300", otherCosts: "200" }), "draft").purchase;
  // lines 10,000 - 500 = 9,500; discount 10% = 950 -> goods 8,550; tax 19% = 1,624.5; + delivery 300 + other 200
  assert.deepEqual([added.subtotal, added.discount, added.tax, added.total], [9500, 950, 1624.5, 10674.5]);
  const included = P.previewPurchase(d, purchaseInput(d, { ...base, taxType: "percent", taxValue: "19", taxMode: "included" }), "draft").purchase;
  assert.equal(included.total, 9500, "included tax is shown but does not raise the total");
  assert.equal(included.tax, 1516.81);
  const fixed = P.previewPurchase(d, purchaseInput(d, { ...base, taxType: "amount", taxValue: "250", taxMode: "added" }), "draft").purchase;
  assert.equal(fixed.total, 9750);
  const bad = P.previewPurchase(d, purchaseInput(d, { ...base, discountType: "amount", discountValue: "99999" }), "draft");
  assert.match(bad.errors[0].message, /subtotal/i);
  assert.match(P.previewPurchase(d, purchaseInput(d, { ...base, taxValue: "-1", taxType: "amount" }), "draft").errors[0].message, /negative/i);
  assert.match(P.previewPurchase(d, purchaseInput(d, { lines: [{ productId: "p-tile", unit: "box", qty: "1", unitPrice: "-5" }] }), "draft").errors[0].message, /negative/i);
});

test("a purchase can create a new product; it is only created when the purchase is confirmed, with the typed selling price", () => {
  const d = withSupplier();
  const newLine = { newProduct: { name: "Tile B", tileSize: "30*30", coveragePerBox: "1.08", sellingPrice: "700", priceUnit: "m2", stockUnit: "m2", sku: "TB-1" }, unit: "box", qty: "10", unitPrice: "500" };
  const p = draftPurchase(d, { lines: [newLine] });
  assert.equal(d.products.length, 1, "a draft does not create the product yet");
  assert.equal(p.lines[0].baseQty, 10.8);
  const r = P.confirmPurchase(d, p.id);
  assert.deepEqual(r.createdProducts, [p.lines[0].productId]);
  const created = d.products.find((x) => x.name === "Tile B");
  assert.equal(created.stock, 10.8, "10 boxes x 1.08 m²");
  assert.equal(created.sellingPrice, 700, "the selling price is the one typed for customers");
  assert.equal(created.purchasePrice, null, "the purchase price does not overwrite or fill the product's price fields");
  assert.equal(created.id, p.lines[0].productId, "the line keeps pointing at the same product");
  assert.equal(P.productHistory(d, created.id)[0].line.unitPrice, 500, "the cost lives on the purchase line");
});

test("a new product with a duplicate SKU, or no stock unit, is refused and nothing is created", () => {
  const d = withSupplier();
  const line = (overrides) => ({ newProduct: { name: "Tile C", sellingPrice: "100", priceUnit: "piece", stockUnit: "piece", ...overrides }, unit: "piece", qty: "4", unitPrice: "50" });
  assert.match(P.saveDraft(d, purchaseInput(d, { lines: [line({ sku: "ta-1" })] })).error, /SKU/i);
  assert.match(P.saveDraft(d, purchaseInput(d, { lines: [line({ stockUnit: "" })] })).error, /counted|unit/i);
  assert.equal(d.purchases.length, 0);
  assert.equal(d.products.length, 1);
});

test("a draft never adds stock, never creates a debt and never counts in any report", () => {
  const d = withSupplier();
  const p = draftPurchase(d);
  assert.equal(stockOf(d), 10);
  const sum = P.purchaseSummary(p, d.supplierPayments, day());
  assert.equal(sum.outstanding, 0);
  assert.equal(P.supplierSummary(d.suppliers[0], d.purchases, d.supplierPayments).outstanding, 0);
  assert.equal(P.periodReport(d, "", "").count, 0);
  assert.match(P.recordPayment(d, p.id, { amount: "10" }).error, /confirmed/i, "no payment on a draft");
  assert.match(P.receiveDelivery(d, p.id, { [p.lines[0].id]: "1" }).error, /not confirmed/i);
});

/* ==========================================================================
   6. Confirming: stock exactly once, all or nothing
   ========================================================================== */

test("confirming adds 288 m² to stock once; confirming again, or double-clicking, adds nothing", () => {
  const d = withSupplier();
  const p = draftPurchase(d);
  const first = P.confirmPurchase(d, p.id);
  assert.equal(first.error, undefined);
  assert.equal(stockOf(d), 298, "10 + 200 boxes x 1.44");
  assert.equal(p.status, "confirmed");
  assert.equal(p.receipts.length, 1);
  assert.equal(p.receipts[0].lines[0].baseQty, 288);
  const second = P.confirmPurchase(d, p.id);
  assert.equal(second.skip, true);
  assert.equal(second.already, true);
  assert.equal(stockOf(d), 298, "the second confirm did not add stock again");
  assert.equal(p.receipts.length, 1);
  assert.match(P.saveDraft(d, { ...purchaseInput(d), id: p.id }).error, /no longer a draft/i, "a confirmed purchase can not be saved as a draft again");
  assert.equal(stockOf(d), 298);
});

test("the selling price and every other product field stay as they were; purchase cost is not copied over", () => {
  const d = withSupplier();
  const before = plain(d.products[0]);
  confirmed(d);
  const after = plain(d.products[0]);
  assert.equal(after.sellingPrice, 800);
  assert.equal(after.purchasePrice, null);
  delete before.stock; delete after.stock;
  assert.deepEqual(after, before);
});

test("a purchase refused at confirm time changes nothing at all (no stock, no new product, no payment)", () => {
  const d = withSupplier();
  const p = draftPurchase(d, {
    lines: [
      { productId: "p-tile", unit: "box", qty: "5", unitPrice: "900" },
      { newProduct: { name: "Tile D", sellingPrice: "100", priceUnit: "piece", stockUnit: "piece", sku: "TD" }, unit: "piece", qty: "4", unitPrice: "50" },
    ],
    initialPayment: { amount: "100" },
  });
  d.products = d.products.filter((x) => x.id === "p-tile");
  const snapshot = plain({ products: d.products, purchases: d.purchases, supplierPayments: d.supplierPayments, counter: d.purchaseCounter });
  // another product took the SKU of the new one after the draft was saved
  d.products.push(sampleProduct({ id: "p-other", sku: "TD", name: "Other", stock: 1 }));
  snapshot.products.push(plain(d.products[1]));
  const r = P.confirmPurchase(d, p.id);
  assert.match(r.error, /SKU/i);
  assert.deepEqual(plain({ products: d.products, purchases: d.purchases, supplierPayments: d.supplierPayments, counter: d.purchaseCounter }), snapshot);
});

test("a deleted product, or one whose unit changed, stops the confirm and tells which", () => {
  const d = withSupplier();
  const p = draftPurchase(d);
  d.products[0].stockUnit = "box";
  assert.match(P.confirmPurchase(d, p.id).error, /unit of Tile A changed/i);
  d.products = [];
  assert.match(P.confirmPurchase(d, p.id).error, /no longer exists/i);
  assert.equal(p.status, "draft");
});

test("goods can be confirmed first and received later, in parts; the last part makes the total exact", () => {
  const d = withSupplier();
  const p = confirmed(d, {}, { receive: {} });
  assert.equal(stockOf(d), 10, "nothing arrived yet");
  assert.equal(P.purchaseSummary(p, [], day()).delivery.status, "pending");
  const lineId = p.lines[0].id;
  assert.equal(P.receiveDelivery(d, p.id, { [lineId]: "120" }).error, undefined);
  assert.equal(stockOf(d), 10 + 172.8);
  assert.equal(P.purchaseSummary(p, [], day()).delivery.status, "partial");
  assert.match(P.receiveDelivery(d, p.id, { [lineId]: "81" }).error, /only 80/, "more than ordered is refused");
  assert.equal(P.receiveDelivery(d, p.id, { [lineId]: "80" }).error, undefined);
  assert.equal(stockOf(d), 298, "120 + 80 boxes together are exactly 288 m²");
  assert.equal(P.purchaseSummary(p, [], day()).delivery.status, "received");
  assert.match(P.receiveDelivery(d, p.id, { [lineId]: "1" }).error, /only 0|still to come/i);
});

/* ==========================================================================
   7-9. Payments and balances
   ========================================================================== */

test("an unpaid invoice owes its full total; an empty initial payment is 0, never 'paid in full'", () => {
  const d = withSupplier();
  const p = confirmed(d, { initialPayment: { amount: "" } });
  const sum = P.purchaseSummary(p, d.supplierPayments, day());
  assert.deepEqual([sum.paid, sum.outstanding, sum.paymentStatus], [0, 180000, "unpaid"]);
  assert.equal(d.supplierPayments.length, 0, "no payment record was invented");
});

test("an initial payment is recorded as its own payment; further payments add up; Paid at exactly the total", () => {
  const d = withSupplier();
  const p = confirmed(d, { initialPayment: { amount: "80000", reference: "TRF-1" } });
  assert.equal(d.supplierPayments.length, 1);
  assert.equal(P.purchaseSummary(p, d.supplierPayments, day()).paymentStatus, "partial");
  assert.equal(P.purchaseSummary(p, d.supplierPayments, day()).outstanding, 100000, "outstanding = total - payments");
  assert.equal(P.recordPayment(d, p.id, { amount: "50000", date: day(0), reference: "TRF-2", note: "second" }).error, undefined);
  assert.equal(P.purchaseSummary(p, d.supplierPayments, day()).outstanding, 50000);
  assert.equal(P.recordPayment(d, p.id, { amount: "50000" }).error, undefined);
  const sum = P.purchaseSummary(p, d.supplierPayments, day());
  assert.deepEqual([sum.outstanding, sum.paymentStatus, sum.payments.length], [0, "paid", 3]);
  assert.match(P.recordPayment(d, p.id, { amount: "1" }).error, /already fully paid/i);
});

test("payments are validated: no negatives, no zero, no future dates, and never more than what is owed", () => {
  const d = withSupplier();
  const p = confirmed(d);
  assert.match(P.recordPayment(d, p.id, { amount: "-5" }).error, /negative/i);
  assert.match(P.recordPayment(d, p.id, { amount: "0" }).error, /greater than 0/i);
  assert.match(P.recordPayment(d, p.id, { amount: "" }).error, /greater than 0/i);
  assert.match(P.recordPayment(d, p.id, { amount: "abc" }).error, /greater than 0/i);
  assert.match(P.recordPayment(d, p.id, { amount: "10", date: day(3) }).error, /future/i);
  assert.match(P.recordPayment(d, p.id, { amount: "10", date: "31/12/2026" }).error, /valid/i);
  assert.match(P.recordPayment(d, p.id, { amount: "180000.01" }).error, /at most 180000/);
  assert.equal(d.supplierPayments.length, 0);
  assert.equal(P.recordPayment(d, p.id, { amount: "180000" }).error, undefined, "exactly the total is allowed");
});

test("an initial payment bigger than the invoice is refused when confirming", () => {
  const d = withSupplier();
  const p = draftPurchase(d);
  const r = P.confirmPurchase(d, p.id, { initialPayment: { amount: "200000" } });
  assert.match(r.error, /at most/i);
  assert.equal(p.status, "draft");
  assert.equal(stockOf(d), 10);
});

test("a payment can be corrected (the old values stay in its history) and voided (never deleted)", () => {
  const d = withSupplier();
  const p = confirmed(d);
  const pay = P.recordPayment(d, p.id, { amount: "1000", reference: "A" }).payment;
  assert.equal(P.updatePayment(d, pay.id, { amount: "1500", reference: "A" }).error, undefined);
  assert.equal(pay.amount, 1500);
  assert.equal(pay.history.length, 1);
  assert.equal(pay.history[0].amount, 1000);
  assert.match(P.updatePayment(d, pay.id, { amount: "999999" }).error, /at most/i, "a correction can not go over the total either");
  assert.match(P.voidPayment(d, pay.id, "").error, /reason/i);
  assert.equal(P.voidPayment(d, pay.id, "typed on the wrong invoice").error, undefined);
  assert.equal(d.supplierPayments.length, 1, "the voided payment is still there");
  assert.equal(P.purchaseSummary(p, d.supplierPayments, day()).outstanding, 180000, "and no longer counts");
  assert.match(P.updatePayment(d, pay.id, { amount: "5" }).error, /voided/i);
});

test("balances per supplier and overdue invoices follow the due date; credit limit only warns", () => {
  const d = withSupplier();
  d.suppliers[0].creditLimit = 100000;
  const old = confirmed(d, { supplierInvoiceNumber: "OLD", invoiceDate: day(-60), dueDate: day(-30), lines: [{ productId: "p-tile", unit: "box", qty: "10", unitPrice: "1000" }] });
  const fresh = confirmed(d, { supplierInvoiceNumber: "NEW", invoiceDate: day(0), dueDate: day(10), lines: [{ productId: "p-tile", unit: "box", qty: "20", unitPrice: "1000" }] });
  P.recordPayment(d, old.id, { amount: "2000", date: day(-1) });
  const s = P.supplierSummary(d.suppliers[0], d.purchases, d.supplierPayments, day());
  assert.deepEqual([s.count, s.total, s.paid, s.outstanding], [2, 30000, 2000, 28000]);
  assert.deepEqual([s.overdueCount, s.overdueTotal], [1, 8000]);
  assert.equal(s.lastPurchase, day(0));
  assert.equal(s.overLimit, false);
  const report = P.outstandingReport(d, day());
  assert.equal(report.total, 28000);
  assert.equal(report.overdue.length, 1);
  assert.equal(report.overdue[0].purchase.id, old.id);
  assert.equal(report.overdue[0].summary.daysOverdue, 30);
  assert.equal(P.purchaseSummary(fresh, [], day()).overdue, false);
  const extra = draftPurchase(d, { supplierInvoiceNumber: "BIG", lines: [{ productId: "p-tile", unit: "box", qty: "100", unitPrice: "1000" }] });
  assert.ok(P.creditCheck(d, extra.id, day()), "a purchase that goes over the credit limit is flagged");
  assert.equal(P.confirmPurchase(d, extra.id).error, undefined, "but it is only a warning: confirming still works");
});

test("reports: purchases in a period, by supplier, product history and payments; cancelled and voided never count", () => {
  const d = withSupplier();
  P.saveSupplier(d, { name: "Second Supplier", phone: "0661 99 88 77" });
  const a = confirmed(d, { supplierInvoiceNumber: "A", invoiceDate: "2026-09-10", initialPayment: { amount: "1000", date: "2026-09-11" } });
  const b = P.saveDraft(d, purchaseInput(d, { supplierId: d.suppliers[1].id, supplierInvoiceNumber: "B", invoiceDate: "2026-10-05", lines: [{ productId: "p-tile", unit: "box", qty: "10", unitPrice: "1000" }] })).purchase;
  P.confirmPurchase(d, b.id);
  const c = confirmed(d, { supplierInvoiceNumber: "C", invoiceDate: "2026-10-06", lines: [{ productId: "p-tile", unit: "box", qty: "1", unitPrice: "100" }] });
  P.cancelPurchase(d, c.id, "ordered twice");
  const draftOnly = draftPurchase(d, { supplierInvoiceNumber: "D", invoiceDate: "2026-10-07" });
  assert.ok(draftOnly);
  P.recordPayment(d, b.id, { amount: "300", date: "2026-10-08" });
  const voided = P.recordPayment(d, b.id, { amount: "400", date: "2026-10-08" }).payment;
  P.voidPayment(d, voided.id, "mistake");

  const october = P.periodReport(d, "2026-10-01", "2026-10-31", "2026-10-11");
  assert.deepEqual([october.count, october.total], [1, 10000], "only the confirmed purchase of October");
  assert.equal(october.paid, 300, "the voided payment is not counted");
  assert.equal(P.periodReport(d, "", "", "2026-10-11").count, 2, "cancelled and draft purchases are left out");
  const by = P.purchasesBySupplier(d, "", "", "2026-10-11");
  assert.deepEqual(by.map((g) => [g.supplier.name, g.count, g.total]), [["Timgad Ceramic", 1, 180000], ["Second Supplier", 1, 10000]]);
  const pay = P.paymentsReport(d, "2026-09-01", "2026-10-31");
  assert.deepEqual(pay.rows.map((r) => r.payment.amount).sort((x, y) => x - y), [300, 1000]);
  assert.equal(pay.total, 1300);
  assert.equal(P.paymentsReport(d, "2026-10-01", "2026-10-31").count, 1);
  const history = P.productHistory(d, "p-tile");
  assert.equal(history.length, 2);
  assert.equal(history[0].purchase.id, b.id, "newest first");
  assert.equal(history[1].costPerStockUnit, 625, "180,000 / 288 m²");
  assert.equal(P.productHistory(d, "p-tile", d.suppliers[1].id).length, 1);
  assert.equal(P.supplierProducts(d, d.suppliers[0].id)[0].baseQty, 288);
  assert.equal(a.status, "confirmed");
});

/* ==========================================================================
   10. Duplicate supplier invoice numbers and references
   ========================================================================== */

test("a supplier invoice number is unique per supplier (ignoring case, spaces and accents) but can repeat across suppliers", () => {
  const d = withSupplier();
  P.saveSupplier(d, { name: "Other Supplier" });
  draftPurchase(d, { supplierInvoiceNumber: " fa-001 " });
  const clash = P.saveDraft(d, purchaseInput(d, { supplierInvoiceNumber: "FA-001" }));
  assert.match(clash.error, /already used by purchase PUR-000001/);
  const other = P.saveDraft(d, purchaseInput(d, { supplierId: d.suppliers[1].id, supplierInvoiceNumber: "FA-001" }));
  assert.equal(other.error, undefined, "the same number from a different supplier is fine");
  assert.equal(P.saveDraft(d, purchaseInput(d, { supplierInvoiceNumber: "" })).error, undefined, "a draft may still lack a number");
  assert.match(P.confirmPurchase(d, d.purchases[2].id).error, /invoice number/i, "but a purchase can not be confirmed without one");
  const none = P.saveDraft(d, purchaseInput(d, { supplierInvoiceNumber: "", noSupplierInvoice: true }));
  assert.equal(P.confirmPurchase(d, none.purchase.id).error, undefined, "unless the person says there is no supplier invoice");
});

test("a cancelled purchase frees its supplier invoice number; internal references are unique", () => {
  const d = withSupplier();
  const first = confirmed(d, { supplierInvoiceNumber: "FA-9" });
  assert.match(P.saveDraft(d, purchaseInput(d, { supplierInvoiceNumber: "FA-9" })).error, /already used/);
  P.cancelPurchase(d, first.id, "wrong supplier invoice");
  assert.equal(P.saveDraft(d, purchaseInput(d, { supplierInvoiceNumber: "FA-9" })).error, undefined, "the number can be entered again after a cancel");
  assert.match(P.saveDraft(d, purchaseInput(d, { supplierInvoiceNumber: "FA-10", reference: "PUR-000002" })).error, /reference/i);
  const typed = P.saveDraft(d, purchaseInput(d, { supplierInvoiceNumber: "FA-11", reference: "PUR-000050" })).purchase;
  assert.equal(typed.reference, "PUR-000050");
  assert.equal(P.saveDraft(d, purchaseInput(d, { supplierInvoiceNumber: "FA-12" })).purchase.reference, "PUR-000051", "the counter never goes backwards");
});

/* ==========================================================================
   12. Editing, cancelling and reversing never re-apply stock; history is kept
   ========================================================================== */

test("editing a confirmed purchase can change its invoice number, dates and notes only, and never touches stock", () => {
  const d = withSupplier();
  const p = confirmed(d);
  const lines = plain(p.lines);
  const r = P.updatePurchaseDetails(d, p.id, { supplierInvoiceNumber: "FA-001-BIS", dueDate: day(45), notes: "corrected", total: 1, lines: [], supplierId: "x" });
  assert.deepEqual(r.changed.sort(), ["dueDate", "notes", "supplierInvoiceNumber"], "other fields in the patch are ignored");
  assert.equal(p.total, 180000);
  assert.deepEqual(plain(p.lines), lines);
  assert.equal(stockOf(d), 298);
  assert.match(P.updatePurchaseDetails(d, p.id, { dueDate: "1999-01-01" }).error, /before the invoice date/i);
  assert.match(p.log.map((e) => e.event).join(), /edited/);
  assert.equal(P.updatePurchaseDetails(d, p.id, { notes: "corrected" }).skip, true, "an unchanged edit does nothing");
});

test("a delivery can be reversed once: stock goes down by exactly what it added, and the receipt stays in the history", () => {
  const d = withSupplier();
  const p = confirmed(d);
  const receipt = p.receipts[0];
  assert.match(P.reverseReceipt(d, p.id, receipt.id, "").error, /reason/i);
  assert.equal(P.reverseReceipt(d, p.id, receipt.id, "supplier shipped the wrong goods").error, undefined);
  assert.equal(stockOf(d), 10);
  assert.equal(receipt.status, "reversed");
  assert.equal(p.receipts.length, 1, "the receipt is kept");
  assert.equal(P.reverseReceipt(d, p.id, receipt.id, "again").skip, true);
  assert.equal(stockOf(d), 10, "a second reversal changes nothing");
  assert.equal(P.purchaseSummary(p, [], day()).delivery.status, "pending", "the goods are due again");
  assert.equal(P.receiveDelivery(d, p.id, { [p.lines[0].id]: "200" }).error, undefined, "and can be received again, as a new receipt");
  assert.equal(stockOf(d), 298);
  assert.equal(p.receipts.length, 2);
});

test("goods that were already sold can not be taken out of stock: the reversal is refused and nothing changes", () => {
  const d = withSupplier();
  const p = confirmed(d);
  d.products[0].stock = 100;   // 198 m² were sold since
  const before = plain(d);
  const r = P.reverseReceipt(d, p.id, p.receipts[0].id, "return to supplier");
  assert.match(r.error, /can not be taken out of stock/i);
  assert.deepEqual(plain(d), before);
  const c = P.cancelPurchase(d, p.id, "cancel");
  assert.match(c.error, /can not be taken out of stock/i);
  assert.equal(p.status, "confirmed");
  assert.equal(d.products[0].stock, 100, "stock never goes negative or half-changes");
});

test("cancelling a confirmed purchase needs a reason and voided payments, reverses its goods, and keeps the record", () => {
  const d = withSupplier();
  const p = confirmed(d, { initialPayment: { amount: "1000" } });
  assert.match(P.cancelPurchase(d, p.id, "").error, /reason/i);
  assert.match(P.cancelPurchase(d, p.id, "duplicate order").error, /active payment/i, "void the payments first");
  assert.equal(stockOf(d), 298);
  P.voidPayment(d, d.supplierPayments[0].id, "paid by mistake");
  assert.equal(P.cancelPurchase(d, p.id, "duplicate order").error, undefined);
  assert.equal(stockOf(d), 10, "the goods are taken out again");
  assert.equal(p.status, "cancelled");
  assert.equal(p.cancelReason, "duplicate order");
  assert.equal(d.purchases.length, 1);
  assert.equal(d.supplierPayments.length, 1, "payment history is kept");
  assert.equal(P.cancelPurchase(d, p.id, "again").skip, true, "cancelling twice does nothing");
  assert.equal(P.supplierSummary(d.suppliers[0], d.purchases, d.supplierPayments).total, 0, "cancelled purchases count nowhere");
  assert.match(P.recordPayment(d, p.id, { amount: "5" }).error, /confirmed/i);
});

test("only a draft can be deleted; a confirmed or cancelled purchase is a financial record", () => {
  const d = withSupplier();
  const draftOne = draftPurchase(d, { supplierInvoiceNumber: "X" });
  assert.equal(P.deleteDraft(d, draftOne.id).error, undefined);
  assert.equal(d.purchases.length, 0);
  const p = confirmed(d, { supplierInvoiceNumber: "Y" });
  assert.match(P.deleteDraft(d, p.id).error, /no longer a draft/i);
  assert.equal(d.purchases.length, 1);
});

/* ==========================================================================
   Attachments
   ========================================================================== */

test("attachments: only photos, scans and PDFs up to 5 MB; they belong to the purchase and go with a deleted draft", () => {
  const ok = { id: "a1", name: "scan.pdf", type: "application/pdf", size: 1000 };
  assert.equal(P.attachmentMetaProblem(ok), "");
  assert.match(P.attachmentMetaProblem({ ...ok, type: "application/zip" }), /JPG, PNG, WebP or PDF/);
  assert.match(P.attachmentMetaProblem({ ...ok, size: 6 * 1024 * 1024 }), /too big/i);
  const d = withSupplier();
  const p = draftPurchase(d, { attachments: [ok] });
  assert.deepEqual(p.attachments.map((a) => a.id), ["a1"]);
  assert.match(P.saveDraft(d, purchaseInput(d, { supplierInvoiceNumber: "Z", attachments: [{ ...ok, type: "text/html" }] })).error, /JPG, PNG/);
  const again = P.saveDraft(d, { ...purchaseInput(d), id: p.id });
  assert.equal(again.purchase.attachments.length, 1, "editing a draft without mentioning files keeps them");
  P.deleteDraft(d, p.id);
  assert.deepEqual(d.attachments.remove, ["a1"], "the stored file of a deleted draft is removed too");
});

/* ==========================================================================
   Through the real page scripts: saved, reloaded, atomic
   ========================================================================== */

test("app: a confirmed purchase is saved with its stock and payment in ONE transaction and survives a reload", async () => {
  const app = await shop();
  const sid = supplierId(app);
  const saved = await app.api.commit((d) => {
    const r = P.saveDraft(d, { supplierId: sid, supplierInvoiceNumber: "FA-001", invoiceDate: day(0), lines: [{ productId: "p-tile", unit: "box", qty: "200", unitPrice: "900" }] });
    if (r.error) return r;
    return P.confirmPurchase(d, r.purchase.id, { initialPayment: { amount: "80000", reference: "TRF-1" } });
  });
  assert.equal(saved.error, undefined);
  const s = state(app);
  assert.equal(s.products[0].stock, 298);
  assert.equal(s.purchases[0].status, "confirmed");
  assert.equal(s.supplierPayments[0].amount, 80000);
  assert.equal(s.purchaseCounter, 1);

  const again = await reload(app);
  const r = state(again);
  assert.equal(r.products[0].stock, 298);
  assert.equal(r.purchases[0].reference, "PUR-000001");
  assert.equal(r.purchases[0].invoiceKey, undefined, "the database's private keys never reach the app's data");
  assert.equal(r.supplierPayments.length, 1);
  assert.equal(r.purchaseCounter, 1);
  assert.equal(P.purchaseSummary(r.purchases[0], r.supplierPayments, day()).outstanding, 100000);
});

test("app: two confirm requests at the same time (double click, retry) add the stock once", async () => {
  const app = await shop();
  const sid = supplierId(app);
  const drafted = await app.api.commit((d) => P.saveDraft(d, { supplierId: sid, supplierInvoiceNumber: "FA-1", invoiceDate: day(0), lines: [{ productId: "p-tile", unit: "box", qty: "200", unitPrice: "900" }] }));
  const id = drafted.purchase.id;
  const results = await Promise.all([1, 2, 3].map(() => app.api.commit((d) => P.confirmPurchase(d, id))));
  assert.equal(results.filter((r) => r.already).length, 2, "the others see an already confirmed purchase");
  assert.equal(state(app).products[0].stock, 298);
  assert.equal(state(app).purchases[0].receipts.length, 1);
  assert.equal((await reload(app)).api.getState().products[0].stock, 298);
});

test("app: a transaction that fails half way leaves the database, the stock and the screen exactly as they were; a retry then works once", async () => {
  const app = await shop();
  const sid = supplierId(app);
  const drafted = await app.api.commit((d) => P.saveDraft(d, { supplierId: sid, supplierInvoiceNumber: "FA-1", invoiceDate: day(0), lines: [{ productId: "p-tile", unit: "box", qty: "200", unitPrice: "900" }] }));
  const id = drafted.purchase.id;
  const before = await dump(app.api.db);
  const stateBefore = plain(state(app).purchases);

  const restore = failPutWith("QuotaExceededError", 2);   // the disk fills up in the middle of the write
  let failed;
  try {
    failed = await app.api.commit((d) => P.confirmPurchase(d, id, { initialPayment: { amount: "1000" } }));
  } finally {
    restore();
  }
  assert.ok(failed.error, "the person is told it failed");
  assert.deepEqual(await dump(app.api.db), before, "nothing at all was written");
  assert.equal(state(app).products[0].stock, 10);
  assert.deepEqual(plain(state(app).purchases), stateBefore, "the screen still shows the draft");
  assert.equal(state(app).supplierPayments.length, 0);

  const retry = await app.api.commit((d) => P.confirmPurchase(d, id, { initialPayment: { amount: "1000" } }));
  assert.equal(retry.error, undefined);
  assert.equal(state(app).products[0].stock, 298);
  assert.equal(state(app).supplierPayments.length, 1);
});

test("app: a change made in another window is detected and nothing from the stale window is saved", async () => {
  const app = await shop();
  const other = await reload(app);
  const sid = supplierId(app);
  await other.api.commit((d) => P.saveDraft(d, { supplierId: sid, supplierInvoiceNumber: "FROM-OTHER", invoiceDate: day(0), lines: [{ productId: "p-tile", unit: "box", qty: "1", unitPrice: "1" }] }));
  const stale = await app.api.commit((d) => P.saveDraft(d, { supplierId: sid, supplierInvoiceNumber: "FROM-STALE", invoiceDate: day(0), lines: [{ productId: "p-tile", unit: "box", qty: "1", unitPrice: "1" }] }));
  assert.ok(stale.error, "the stale window is refused");
  const all = await app.api.db.loadAll();
  assert.deepEqual(all.purchases.map((p) => p.supplierInvoiceNumber), ["FROM-OTHER"]);
});

/* ==========================================================================
   The database rules behind it (what the screens can not bypass)
   ========================================================================== */

test("db: two purchases with the same supplier invoice number are refused even if a screen forgot to check", async () => {
  const db = await openedDb();
  await change(db, (d) => { d.products.push(tile()); return P.saveSupplier(d, supplierInput()); });
  assert.equal((await change(db, (d) => P.saveDraft(d, purchaseInput(d, { supplierInvoiceNumber: "FA-1" })))).error, undefined);
  // build a clash by hand, bypassing purchases.js
  const before = await db.loadAll();
  const copy = structuredClone(before.purchases[0]);
  copy.id = "forged";
  copy.reference = "PUR-999999";
  await assert.rejects(db.commitChanges({ purchases: { put: [copy], remove: [] } }, { expectedRevision: before.revision }), /already has the supplier invoice number/);
  assert.equal((await db.loadAll()).purchases.length, 1);
  // the same number for another supplier is fine, and a cancelled purchase frees its number
  await change(db, (d) => P.saveSupplier(d, { name: "Other" }));
  const other = (await db.loadAll()).suppliers[1].id;
  assert.equal((await change(db, (d) => P.saveDraft(d, purchaseInput(d, { supplierId: other, supplierInvoiceNumber: "FA-1" })))).error, undefined);
});

test("db: payments are never deleted, a confirmed purchase is never deleted or turned back into a draft, and overpayment is refused", async () => {
  const db = await openedDb();
  await change(db, (d) => { d.products.push(tile()); return P.saveSupplier(d, supplierInput()); });
  const made = await change(db, (d) => {
    const p = P.saveDraft(d, purchaseInput(d, { initialPayment: { amount: "1000" } })).purchase;
    return P.confirmPurchase(d, p.id);
  });
  assert.equal(made.error, undefined);
  const all = await db.loadAll();
  const pay = all.supplierPayments[0];
  await assert.rejects(db.commitChanges({ supplierPayments: { put: [], remove: [pay.id] } }, { expectedRevision: all.revision }), /never deleted/);
  await assert.rejects(db.commitChanges({ purchases: { put: [], remove: [all.purchases[0].id] } }, { expectedRevision: all.revision }), /only be deleted together with all its payments/);
  await assert.rejects(db.commitChanges({ purchases: { put: [{ ...all.purchases[0], status: "draft", receipts: [] }], remove: [] } }, { expectedRevision: all.revision }), /draft again/i);
  await assert.rejects(db.commitChanges({ suppliers: { put: [], remove: [all.suppliers[0].id] } }, { expectedRevision: all.revision }), /Archive/);
  await assert.rejects(db.commitChanges({ supplierPayments: { put: [{ ...pay, amount: 999999 }], remove: [] } }, { expectedRevision: all.revision }), /more than its total/);
  await assert.rejects(db.commitChanges({ supplierPayments: { put: [{ ...pay, id: "orphan", purchaseId: "nope" }], remove: [] } }, { expectedRevision: all.revision }), /no longer exists/);
  assert.deepEqual(await dump(db), await dump(db), "stable");
  const after = await db.loadAll();
  assert.equal(after.supplierPayments.length, 1);
  assert.equal(after.purchases.length, 1);
  assert.equal(after.revision, all.revision, "none of the refused writes changed the revision");
});

test("db: the purchase counter never goes backwards and stays in step with the saved references", async () => {
  const db = await openedDb();
  await change(db, (d) => { d.products.push(tile()); return P.saveSupplier(d, supplierInput()); });
  await change(db, (d) => P.saveDraft(d, purchaseInput(d)));
  const all = await db.loadAll();
  assert.equal(all.purchaseCounter, 1);
  await assert.rejects(db.commitChanges({ purchaseCounter: { next: 0 } }, { expectedRevision: all.revision }), /can not go back/);
  assert.equal((await db.loadAll()).purchaseCounter, 1);
});

test("db: attached files are saved with their purchase in one transaction and read back on demand", async () => {
  const db = await openedDb();
  await change(db, (d) => { d.products.push(tile()); return P.saveSupplier(d, supplierInput()); });
  const file = { id: "att-1", name: "invoice.png", type: "image/png", size: 12, addedAt: iso(1), dataUrl: "data:image/png;base64,AAAA" };
  const r = await change(db, (d) => {
    const p = P.saveDraft(d, purchaseInput(d, { id: "pur-att", attachments: [P.attachmentMeta(file)] })).purchase;
    d.attachments.put.push({ ...file, purchaseId: p.id });
    return { purchase: p };
  });
  assert.equal(r.error, undefined);
  const plainLoad = await db.loadAll();
  assert.equal(plainLoad.attachments, undefined, "files are not loaded into memory with the data");
  assert.equal(plainLoad.purchases[0].attachments[0].dataUrl, undefined);
  assert.equal((await db.getAttachment("att-1")).dataUrl, "data:image/png;base64,AAAA");
  assert.equal((await db.loadAll({ withAttachments: true })).attachments.length, 1);
  // a file for a purchase that does not exist is refused
  const before = await db.loadAll();
  await assert.rejects(db.commitChanges({ attachments: { put: [{ ...file, id: "att-2", purchaseId: "ghost" }], remove: [] } }, { expectedRevision: before.revision }));
  assert.equal((await db.getAttachment("att-2")), undefined);
});

/* ==========================================================================
   13. Upgrade from database version 2 (everything before purchases)
   ========================================================================== */

// Builds a version 2 database the way the previous release did: its five stores and indexes, and its records.
async function makeVersion2(factory, name, rows) {
  const req = factory.open(name, 2);
  req.onupgradeneeded = () => {
    const db = req.result;
    const products = db.createObjectStore("products", { keyPath: "id" });
    products.createIndex("sku", "sku");
    products.createIndex("name", "name");
    const invoices = db.createObjectStore("invoices", { keyPath: "id" });
    invoices.createIndex("invoiceNumber", "invoiceNumber", { unique: true });
    invoices.createIndex("date", "date");
    db.createObjectStore("settings", { keyPath: "key" });
    db.createObjectStore("counters", { keyPath: "name" });
    db.createObjectStore("meta", { keyPath: "key" });
  };
  const db = await new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
  const tx = db.transaction(Object.keys(rows), "readwrite");
  for (const [store, list] of Object.entries(rows)) for (const row of list) tx.objectStore(store).put(row);
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  db.close();
}

async function rawRows(factory, name) {
  const req = factory.open(name);
  const db = await new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
  const out = { version: db.version, stores: [...db.objectStoreNames].sort() };
  for (const store of ["products", "invoices", "settings", "counters", "meta"]) {
    const tx = db.transaction(store, "readonly");
    const all = tx.objectStore(store).getAll();
    out[store] = await new Promise((resolve) => { all.onsuccess = () => resolve(all.result); });
  }
  db.close();
  return out;
}

test("upgrade 2 -> 3: every product, invoice, payment, setting, counter and backup record is kept exactly; new stores start empty", async () => {
  // The old five stores are saved in the same shape by version 3, so rows written by the current code into them are what
  // the previous release saved. They are copied, with the version 2 schema, into a database that is then opened normally.
  const sourceFactory = new fake.IDBFactory();
  const source = newDb({ indexedDB: sourceFactory, name: "source" });
  await source.initDatabase();
  const p1 = sampleProduct({ id: "p-1", sku: "OLD-1", stock: 18 });
  const p2 = sampleProduct({ id: "p-2", sku: "OLD-2", name: "Cement", priceUnit: "kg", stockUnit: "kg", tileSize: "", coveragePerBox: null, stock: 90 });
  const i1 = sampleInvoice({ number: 1, payments: [{ amount: 1900, timestamp: iso(1) }] });
  const i2 = sampleInvoice({ number: 2, payments: [{ amount: 500, timestamp: iso(2) }, { amount: 250.5, timestamp: iso(3) }] });
  await source.commitChanges({
    products: { put: [p1, p2], remove: [] }, invoices: { put: [i1, i2], remove: [] },
    settings: { ...V.DEFAULT_SETTINGS, businessName: "Old Shop", currency: "DZD", paper: "A5" }, counter: { next: 7 },
  });
  await source.recordBackup({ at: iso(5), fileName: "invoisy-backup.json", counts: { products: 2, invoices: 2 } });
  const oldRows = await rawRows(sourceFactory, "source");
  const expected = await dump(source);

  const factory = new fake.IDBFactory();
  await makeVersion2(factory, "legacy", Object.fromEntries(["products", "invoices", "settings", "counters", "meta"].map((k) => [k, oldRows[k]])));
  assert.equal((await rawRows(factory, "legacy")).version, 2, "the starting point really is version 2");

  const db = newDb({ indexedDB: factory, name: "legacy" });
  await db.initDatabase();
  const upgraded = await rawRows(factory, "legacy");
  assert.equal(upgraded.version, 4, "opening a version 2 database runs the version 3 (purchases) and version 4 (debt ledger) upgrades");
  assert.deepEqual(upgraded.stores, ["attachments", "counters", "debtTransfers", "invoices", "meta", "products", "purchases", "settings", "supplierPayments", "suppliers"]);
  for (const store of ["products", "invoices", "settings", "counters", "meta"]) {
    assert.deepEqual(upgraded[store], oldRows[store], `${store} rows are byte for byte the same after the upgrade`);
  }
  assert.deepEqual(await dump(db), expected, "the app sees exactly the same products, invoices, payments, settings and counter");
  const all = await db.loadAll();
  assert.deepEqual([all.suppliers, all.purchases, all.supplierPayments, all.purchaseCounter], [[], [], [], 0]);
  assert.equal(await db.getNextInvoiceNumber(), "INV-000008", "the invoice counter carries on from where it was");
  assert.equal((await db.getBackupInfo()).lastBackupFile, "invoisy-backup.json", "the backup reminder state is kept");

  // and the upgraded database does purchases, without touching the customer side
  const before = await dump(db);
  const made = await change(db, (d) => {
    P.saveSupplier(d, supplierInput());
    const p = P.saveDraft(d, { supplierId: d.suppliers[0].id, supplierInvoiceNumber: "FA-1", invoiceDate: day(0), lines: [{ productId: "p-1", unit: "box", qty: "5", unitPrice: "700" }] });
    return P.confirmPurchase(d, p.purchase.id);
  });
  assert.equal(made.error, undefined);
  const after = await dump(db);
  assert.deepEqual(after.invoices, before.invoices, "customer invoices are untouched");
  assert.equal(after.products.find((p) => p.id === "p-1").stock, 18 + 5, "only the stock of the bought product changed");
  assert.equal(after.products.find((p) => p.id === "p-2").stock, 90);
  assert.equal(after.products.find((p) => p.id === "p-1").sellingPrice, p1.sellingPrice);
});

test("upgrade 2 -> 3 is safe to run again: opening an upgraded database changes nothing", async () => {
  const factory = new fake.IDBFactory();
  const first = newDb({ indexedDB: factory, name: "again" });
  await first.initDatabase();
  await change(first, (d) => { d.products.push(tile()); return P.saveSupplier(d, supplierInput()); });
  const before = await dump(first);
  first.close && first.close();
  const second = newDb({ indexedDB: factory, name: "again" });
  await second.initDatabase();
  assert.deepEqual(await dump(second), before);
});

/* ==========================================================================
   14. Export, import and restore
   ========================================================================== */

async function shopWithHistory() {
  const app = await shop();
  const sid = supplierId(app);
  const file = { id: "att-1", name: "invoice.pdf", type: "application/pdf", size: 9, addedAt: iso(1), dataUrl: "data:application/pdf;base64,JVBERi0=" };
  const r = await app.api.commit((d) => {
    const p = P.saveDraft(d, { supplierId: sid, supplierInvoiceNumber: "FA-001", invoiceDate: day(-3), lines: [{ productId: "p-tile", unit: "box", qty: "200", unitPrice: "900" }], attachments: [P.attachmentMeta(file)] });
    if (p.error) return p;
    d.attachments.put.push({ ...file, purchaseId: p.purchase.id });
    const c = P.confirmPurchase(d, p.purchase.id, { initialPayment: { amount: "80000", date: day(-2), reference: "TRF-1" } });
    if (c.error) return c;
    return P.recordPayment(d, p.purchase.id, { amount: "5000", date: day(-1), reference: "TRF-2" });
  });
  assert.equal(r.error, undefined);
  return app;
}

test("export holds suppliers, purchases, payments and attached files; restoring it in a new browser brings back everything", async () => {
  const app = await shopWithHistory();
  await app.api.exportBackup();
  const text = await app.downloadedText();
  const file = JSON.parse(text);
  assert.equal(file.formatVersion, 2);
  assert.deepEqual(file.counts, { products: 1, invoices: 0, suppliers: 1, purchases: 1, supplierPayments: 2, attachments: 1 });
  assert.equal(file.data.purchaseCounter, 1);
  assert.equal(file.data.attachments[0].dataUrl, "data:application/pdf;base64,JVBERi0=", "scanned invoices are in the backup");
  assert.equal(file.data.purchases[0].invoiceKey, undefined);
  assert.match(app.toast(), /1 supplier, 1 purchase/);

  const fresh = await startedApp();
  await fresh.api.importBackup(fresh.file(text));
  const a = state(app);
  const b = state(fresh);
  assert.deepEqual(plain(b.suppliers), plain(a.suppliers));
  assert.deepEqual(plain(b.purchases), plain(a.purchases));
  const byId = (list) => plain(list).sort((x, y) => x.id.localeCompare(y.id));
  assert.deepEqual(byId(b.supplierPayments), byId(a.supplierPayments), "every payment comes back, with its history");
  assert.deepEqual(plain(b.products), plain(a.products));
  assert.equal(b.purchaseCounter, 1);
  assert.equal((await fresh.api.db.getAttachment("att-1")).dataUrl, "data:application/pdf;base64,JVBERi0=");
  assert.equal(P.purchaseSummary(b.purchases[0], b.supplierPayments, day()).outstanding, 95000);
  assert.match(fresh.toast(), /Restore completed/);
});

test("restoring first downloads a safety copy of the current supplier data; a restore that fails changes nothing", async () => {
  const app = await shopWithHistory();
  await app.api.exportBackup();
  const text = await app.downloadedText();
  const other = await shop();   // a different shop with different data
  await other.api.commit((d) => P.saveSupplier(d, { name: "Only In Other" }));
  const before = await dump(other.api.db);
  const restore = failPutWith("QuotaExceededError", 3);
  try {
    await other.api.importBackup(other.file(text));
  } finally {
    restore();
  }
  assert.deepEqual(await dump(other.api.db), before, "a restore that fails leaves everything as it was");
  assert.ok(other.downloads.some((d) => /before-restore/.test(d.name)), "the safety copy was downloaded first");
  const safety = V.parseBackup(await other.downloadedText(other.downloads.findIndex((d) => /before-restore/.test(d.name))));
  assert.equal(safety.error, undefined);
  assert.deepEqual(safety.data.suppliers.map((s) => s.name).sort(), ["Only In Other", "Timgad Ceramic"], "the safety copy includes suppliers");
});

test("an older backup (format 1, no suppliers) is still restored; restoring it replaces the supplier side as the warning says", async () => {
  const app = await shopWithHistory();
  const v1 = V.buildBackup({ products: [tile({ stock: 33 })], invoices: [], settings: { ...V.DEFAULT_SETTINGS, currency: "DZD" }, counter: 0 }, new Date());
  const old = { application: v1.application, formatVersion: 1, exportedAt: v1.exportedAt, counts: { products: 1, invoices: 0 }, data: { products: v1.data.products, invoices: [], settings: v1.data.settings, invoiceCounter: 0 } };
  const parsed = V.parseBackup(JSON.stringify(old));
  assert.equal(parsed.error, undefined);
  assert.deepEqual(parsed.data.suppliers, []);
  await app.api.importBackup(app.file(JSON.stringify(old)));
  assert.equal(state(app).products[0].stock, 33);
  assert.equal(state(app).suppliers.length, 0);
  assert.match(app.confirms[app.confirms.length - 1], /suppliers, purchases/, "the warning names what will be replaced");
});

test("a damaged or inconsistent backup is rejected whole, with a reason, and nothing is changed", async () => {
  const app = await shopWithHistory();
  await app.api.exportBackup();
  const good = JSON.parse(await app.downloadedText());
  const bad = (mutate) => { const copy = plain(good); mutate(copy); return V.parseBackup(JSON.stringify(copy)); };
  assert.ok(V.parseBackup(JSON.stringify(good)).data, "the untouched file is fine");
  assert.match(bad((f) => { f.data.supplierPayments[0].purchaseId = "ghost"; }).error, /not in the data/);
  assert.match(bad((f) => { f.data.supplierPayments[0].amount = 10 ** 9; }).error, /more than its total/);
  assert.match(bad((f) => { f.data.purchases[0].supplierId = "ghost"; }).error, /supplier that is not in the data/);
  assert.match(bad((f) => { f.data.purchases.push({ ...f.data.purchases[0], id: "dup", reference: "PUR-000002" }); f.counts.purchases = 2; }).error, /share the supplier invoice number/);
  assert.match(bad((f) => { f.data.attachments = []; f.counts.attachments = 0; }).error, /missing from the data/);
  assert.match(bad((f) => { f.counts.suppliers = 5; }).error, /does not match|count/i);
  assert.match(bad((f) => { delete f.data.suppliers; }).error, /missing its supplier/);
  assert.match(bad((f) => { f.formatVersion = 3; }).error, /newer/i);
  assert.match(bad((f) => { f.data.purchases[0].total = -5; }).error, /invalid/);
  assert.match(bad((f) => { f.data.suppliers[0].name = ""; }).error, /name/);
  const before = await dump(app.api.db);
  const copy = plain(good);
  copy.data.supplierPayments[0].purchaseId = "ghost";
  await app.api.importBackup(app.file(JSON.stringify(copy)));
  assert.deepEqual(await dump(app.api.db), before);
  assert.match(app.errorText("dataError"), /not in the data/);
});

test("stored figures that do not add up are kept as they are and reported as a warning, never silently fixed", () => {
  const app = null;
  const d = withSupplier();
  const p = confirmed(d);
  const forged = plain(p);
  forged.total = 1;
  const warnings = P.purchaseWarnings(forged);
  assert.match(warnings.join(), /total does not match/);
  assert.equal(app, null);
  assert.equal(p.total, 180000);
});

test("the purchase counter in a backup never makes the counter go backwards", async () => {
  const app = await shopWithHistory();
  await app.api.commit((d) => P.saveDraft(d, { supplierId: d.suppliers[0].id, supplierInvoiceNumber: "FA-2", invoiceDate: day(0), lines: [{ productId: "p-tile", unit: "box", qty: "1", unitPrice: "1" }] }));
  assert.equal(state(app).purchaseCounter, 2);
  const older = V.buildBackup({ products: [tile()], invoices: [], settings: { ...V.DEFAULT_SETTINGS, currency: "DZD" }, counter: 0, suppliers: [], purchases: [], supplierPayments: [], attachments: [], purchaseCounter: 1 }, new Date());
  await app.api.importBackup(app.file(JSON.stringify(older)));
  assert.equal(state(app).purchaseCounter, 2, "references already handed out are never handed out again");
  const next = await app.api.commit((d) => { P.saveSupplier(d, { name: "New" }); return P.saveDraft(d, { supplierId: d.suppliers[0].id, supplierInvoiceNumber: "Z", invoiceDate: day(0), lines: [{ productId: "p-tile", unit: "box", qty: "1", unitPrice: "1" }] }); });
  assert.equal(next.purchase.reference, "PUR-000003");
});

/* ==========================================================================
   15. Sales stay separate: invoices, selling prices and sale stock are untouched
   ========================================================================== */

test("customer invoices, selling prices and the way a sale reduces stock are untouched by purchases", async () => {
  const app = await shop();
  await app.api.commit((d) => { d.products[0].stock = 50; });
  const sale = app.api.addToSale("p-tile", "10", "box");
  assert.equal(sale.ok, true, sale.error);
  await app.api.completeSale();
  const invoice = plain(state(app).invoices[0]);
  assert.equal(state(app).products[0].stock, 35.6, "a sale of 10 boxes took 14.4 m² as it always did");
  const stockAfterSale = state(app).products[0].stock;

  const sid = supplierId(app);
  const bought = await app.api.commit((d) => {
    const p = P.saveDraft(d, { supplierId: sid, supplierInvoiceNumber: "FA-1", invoiceDate: day(0), lines: [{ productId: "p-tile", unit: "box", qty: "200", unitPrice: "900" }] });
    return P.confirmPurchase(d, p.purchase.id, { initialPayment: { amount: "1000" } });
  });
  assert.equal(bought.error, undefined);
  assert.deepEqual(plain(state(app).invoices[0]), invoice, "the historical customer invoice is identical");
  assert.equal(state(app).invoices.length, 1);
  assert.equal(state(app).counter, 1, "purchases never use the invoice counter");
  assert.equal(state(app).products[0].sellingPrice, 800);
  assert.equal(state(app).products[0].stock, Math.round((stockAfterSale + 288) * 100) / 100);

  // cancelling the purchase afterwards (void its payment first) does not disturb the invoice either
  await app.api.commit((d) => P.voidPayment(d, d.supplierPayments[0].id, "test"));
  const cancelled = await app.api.commit((d) => P.cancelPurchase(d, d.purchases[0].id, "test"));
  assert.equal(cancelled.error, undefined);
  assert.deepEqual(plain(state(app).invoices[0]), invoice);
  assert.equal(state(app).products[0].stock, stockAfterSale);

  // a sale still works normally afterwards, and customer payments have nothing to do with supplier payments
  await app.api.commit((d) => { d.products[0].stock = 50; });
  assert.equal(app.api.addToSale("p-tile", "2", "box").ok, true);
  await app.api.completeSale();
  assert.equal(state(app).invoices.length, 2);
  assert.equal(state(app).invoices[1].invoiceNumber, "INV-000002");
  assert.equal(state(app).supplierPayments.length, 1);
});

test("reminder and counts: suppliers and purchases count as data worth backing up", async () => {
  const app = await startedApp();
  assert.equal(app.field("backupReminder").hidden, true, "an empty app has nothing to remind about");
  await app.api.commit((d) => P.saveSupplier(d, supplierInput()));
  app.api.getState();
  assert.match(app.api.describeData(state(app)), /0 products, 0 invoices, 1 supplier$/);
  assert.equal(app.api.describeData({ products: 2, invoices: 3 }), "2 products, 3 invoices", "counts of an export are described too");
});

/* ==========================================================================
   Screens (drawn into the page stand-in): escaping, languages, export file
   ========================================================================== */

test("screens: supplier and purchase text is escaped, never run as HTML", async () => {
  const app = await shop();
  const evil = "<img src=x onerror=alert(1)>";
  await app.api.commit((d) => {
    d.suppliers[0].name = evil;
    d.suppliers[0].contactName = '"><script>alert(2)</script>';
    return {};
  });
  const s = state(app);
  s.view = "suppliers";
  app.api.renderAll();
  const html = app.field("suppliersRoot").innerHTML;
  assert.ok(!html.includes("<img src=x"), "the supplier name is escaped");
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  s.view = "purchases";
  await app.api.commit((d) => P.saveDraft(d, { supplierId: d.suppliers[0].id, supplierInvoiceNumber: evil, invoiceDate: day(0), lines: [{ productId: "p-tile", unit: "box", qty: "1", unitPrice: "1" }], notes: evil }));
  app.api.renderAll();
  assert.ok(!app.field("purchasesRoot").innerHTML.includes("<img src=x"));
});

test("screens: the supplier list shows totals, paid, outstanding and last purchase; a draft is not counted", async () => {
  const app = await shopWithHistory();
  await app.api.commit((d) => P.saveDraft(d, { supplierId: d.suppliers[0].id, supplierInvoiceNumber: "DRAFT-ONLY", invoiceDate: day(0), lines: [{ productId: "p-tile", unit: "box", qty: "50", unitPrice: "1000" }] }));
  const ui = app.api.PurchasesUI;
  const [row] = ui.supplierRows();
  assert.deepEqual([row.total, row.paid, row.outstanding, row.last], [180000, 85000, 95000, day(-3)]);
  state(app).view = "suppliers";
  app.api.renderAll();
  const html = app.field("suppliersRoot").innerHTML;
  assert.match(html, /Timgad Ceramic/);
  assert.match(html, /180,000 DA/);
  assert.match(html, /95,000 DA/);
  ui.state.sup.q = "nobody";
  assert.equal(ui.supplierRows().length, 0, "search filters the list");
  ui.state.sup.q = "0555 12";
  assert.equal(ui.supplierRows().length, 1, "search finds part of a phone number");
  ui.state.sup.q = "0555";
  assert.equal(ui.supplierRows().length, 1);
  ui.state.sup.q = "";
  ui.state.sup.status = "archived";
  assert.equal(ui.supplierRows().length, 0, "the archived filter hides active suppliers");
});

test("screens: everything is drawn in French too, with no missing text", async () => {
  const app = await shopWithHistory();
  await app.api.commit((d) => { d.settings.language = "fr"; });
  const s = state(app);
  const ui = app.api.PurchasesUI;
  for (const view of ["suppliers", "purchases"]) {
    s.view = view;
    ui.reset();
    app.api.renderAll();
    const html = app.field(view + "Root").innerHTML;
    assert.ok(html.length > 200);
    assert.ok(!/\b(?:sup|pur|spay|rep)\.[a-z]+(?:\.[A-Za-z]+)*\b/.test(html.replace(/data-[a-z-]+="[^"]*"/g, "").replace(/id="[^"]*"/g, "")), view + ": a text key was shown instead of text");
  }
  s.view = "suppliers";
  ui.reset();
  app.api.renderAll();
  assert.match(app.field("suppliersRoot").innerHTML, /Ajouter un fournisseur/);
  ui.openSupplier(s.suppliers[0].id);
  app.api.renderAll();
  assert.match(app.field("suppliersRoot").innerHTML, /Aperçu/);
  s.view = "purchases";
  ui.openPurchase(s.purchases[0].id);
  app.api.renderAll();
  const detail = app.field("purchasesRoot").innerHTML;
  assert.match(detail, /Confirmé/);
  assert.match(detail, /Partiellement payé/);
  assert.match(detail, /Paiements au fournisseur/);
});

test("screens: the supplier statement CSV is complete and spreadsheet formulas are neutralised", async () => {
  const app = await shopWithHistory();
  await app.api.commit((d) => P.recordPayment(d, d.purchases[0].id, { amount: "100", reference: "=HYPERLINK(\"http://evil\")" }));
  const csv = app.api.PurchasesUI.supplierCsv(state(app).suppliers[0]);
  assert.ok(csv.startsWith("﻿"), "a byte order mark so spreadsheets read accents correctly");
  assert.match(csv, /FA-001/);
  assert.match(csv, /TRF-1/);
  assert.ok(!/(^|,)=HYPERLINK/m.test(csv), "a cell can not start with = and run as a formula");
  assert.match(csv, /'=HYPERLINK/);
  assert.match(csv, /\r\n/);
});

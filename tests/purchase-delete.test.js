"use strict";

// Permanently deleting a purchase (not cancelling it): the purchase, its payments and its attached files go,
// the goods it added are taken out of stock again, and suppliers, products and other purchases are untouched.
//
// Three levels, all against disposable in-memory databases:
//   - the business rule in purchases.js on a plain copy of the data,
//   - the database layer (database.js) with its guards and revision check,
//   - the real page scripts: the Delete button, the confirmation question and the refreshed list.

const test = require("node:test");
const assert = require("node:assert/strict");
const { V, DB, newDb, iso, sampleProduct } = require("./helpers/modules");
const { loadApp } = require("./helpers/app");

const P = globalThis.Purchases;
const day = (offset) => P.addDays(P.toDay(new Date()), offset || 0);
const plain = (x) => JSON.parse(JSON.stringify(x));

/* ---------- helpers ---------- */

// A tile counted in m², bought by the box (1 box = 1.44 m²). 10 m² in stock.
const tile = (overrides) => sampleProduct({
  id: "p-tile", name: "Tile A", tileSize: "60*60", coveragePerBox: 1.44, sellingPrice: 800, priceUnit: "m2", stockUnit: "m2",
  purchasePrice: null, sku: "TA-1", stock: 10, ...overrides,
});

function draft(overrides) {
  return {
    products: [tile()], invoices: [], settings: { ...V.DEFAULT_SETTINGS, currency: "DZD" }, counter: 0,
    suppliers: [], purchases: [], supplierPayments: [], purchaseCounter: 0, attachments: { put: [], remove: [] },
    ...overrides,
  };
}

const supplierInput = () => ({ name: "Timgad Ceramic", phone: "0555 12 34 56", paymentTermsDays: "30" });

// 200 boxes at 900 DA = 180,000 DA (288 m² into stock).
function purchaseInput(d, overrides) {
  return {
    supplierId: d.suppliers[0].id, supplierInvoiceNumber: "FA-001", invoiceDate: day(0),
    lines: [{ productId: "p-tile", unit: "box", qty: "200", unitPrice: "900" }], ...overrides,
  };
}

function withSupplier() {
  const d = draft();
  assert.ok(P.saveSupplier(d, supplierInput()).supplier);
  return d;
}

function confirmed(d, overrides, options) {
  const made = P.saveDraft(d, purchaseInput(d, overrides));
  assert.ok(made.purchase, made.error);
  const r = P.confirmPurchase(d, made.purchase.id, options);
  assert.ok(r.purchase, r.error);
  return made.purchase;
}

const pay = (d, id, amount) => {
  const r = P.recordPayment(d, id, { amount: String(amount), date: day(0) });
  assert.ok(r.payment, r.error);
  return r.payment;
};

const stockOf = (d, id) => d.products.find((p) => p.id === (id || "p-tile")).stock;

async function openedDb() {
  const db = newDb();
  await db.initDatabase();
  return db;
}

// One change through a real database exactly as the page does: load, change a copy, save only what changed.
async function change(db, mutate) {
  const before = await db.loadAll();
  const d = structuredClone(before);
  d.attachments = { put: [], remove: [] };
  const result = mutate(d) || {};
  if (result.error || result.skip) return result;
  const saved = await db.commitChanges(DB.diff(before, d), { expectedRevision: before.revision });
  return { ...result, saved };
}

async function startedApp(options) {
  const app = loadApp(options);
  const storage = await app.start();
  assert.equal(storage.mode, "ready", storage.reason);
  return app;
}

const state = (app) => app.api.getState();

// A shop with a tile, a supplier and one confirmed purchase of 200 boxes with 1,000 DA paid.
async function shop(options) {
  const app = await startedApp(options);
  assert.equal((await app.api.commit((d) => { d.products.push(tile()); })).error, undefined);
  assert.equal((await app.api.commit((d) => P.saveSupplier(d, supplierInput()))).error, undefined);
  const r = await app.api.commit((d) => {
    const made = P.saveDraft(d, purchaseInput(d, { initialPayment: { amount: "1000" } })).purchase;
    return P.confirmPurchase(d, made.id);
  });
  assert.ok(r.purchase, r.error);
  return { app, purchaseId: r.purchase.id };
}

/* ==========================================================================
   1. The rule (purchases.js)
   ========================================================================== */

test("deleting a received purchase takes its goods out of stock and removes the purchase and every payment, voided ones too", () => {
  const d = withSupplier();
  const p = confirmed(d, { initialPayment: { amount: "1000" } });
  const second = pay(d, p.id, 4000);
  pay(d, p.id, 500);
  assert.ok(P.voidPayment(d, second.id, "wrong amount").payment);
  assert.equal(d.supplierPayments.length, 3);
  assert.equal(stockOf(d), 298, "10 + 200 boxes x 1.44 m²");

  const r = P.deletePurchase(d, p.id);
  assert.equal(r.error, undefined);
  assert.equal(stockOf(d), 10, "back to what it was before the purchase");
  assert.equal(d.purchases.length, 0);
  assert.equal(d.supplierPayments.length, 0, "recorded and voided payments are both gone");
  assert.equal(r.removedPayments, 3);
  // What existed independently stays.
  assert.equal(d.suppliers.length, 1);
  assert.equal(d.products.length, 1);
  // Balances follow: nothing is owed, nothing was paid, nothing was bought.
  const s = P.supplierSummary(d.suppliers[0], d.purchases, d.supplierPayments, day(0));
  assert.deepEqual([s.total, s.paid, s.outstanding], [0, 0, 0]);
});

test("a partly received purchase only gives back what was received", () => {
  const d = withSupplier();
  const made = P.saveDraft(d, purchaseInput(d)).purchase;
  assert.ok(P.confirmPurchase(d, made.id, { receive: { [made.lines[0].id]: "50" } }).purchase);
  assert.equal(stockOf(d), 82, "10 + 50 boxes x 1.44 m²");
  assert.equal(P.deletePurchase(d, made.id).error, undefined);
  assert.equal(stockOf(d), 10);
});

test("a purchase confirmed without receiving goods has no stock to take out", () => {
  const d = withSupplier();
  const made = P.saveDraft(d, purchaseInput(d)).purchase;
  assert.ok(P.confirmPurchase(d, made.id, { receive: {} }).purchase);
  assert.equal(stockOf(d), 10);
  assert.equal(P.deletePurchase(d, made.id).error, undefined);
  assert.equal(stockOf(d), 10);
  assert.equal(d.purchases.length, 0);
});

test("a cancelled purchase can be deleted too, and its goods are not taken out a second time", () => {
  const d = withSupplier();
  const p = confirmed(d, { initialPayment: { amount: "1000" } });
  const payment = d.supplierPayments[0];
  assert.ok(P.voidPayment(d, payment.id, "mistake").payment);
  assert.ok(P.cancelPurchase(d, p.id, "entered twice").purchase);
  assert.equal(stockOf(d), 10, "cancelling already took the goods out");
  assert.equal(d.supplierPayments.length, 1, "the voided payment is still kept as history");

  assert.equal(P.deletePurchase(d, p.id).error, undefined);
  assert.equal(stockOf(d), 10, "not reduced again");
  assert.equal(d.purchases.length, 0);
  assert.equal(d.supplierPayments.length, 0);
});

test("a draft is deleted the same way and never touches stock", () => {
  const d = withSupplier();
  const made = P.saveDraft(d, purchaseInput(d)).purchase;
  const r = P.deletePurchase(d, made.id);
  assert.equal(r.error, undefined);
  assert.equal(d.purchases.length, 0);
  assert.equal(stockOf(d), 10);
});

test("the attached files of the purchase are listed for removal", () => {
  const d = withSupplier();
  const file = { id: "att-1", name: "invoice.png", type: "image/png", size: 12, addedAt: iso(1), dataUrl: "data:image/png;base64,AAAA" };
  const p = confirmed(d, { attachments: [P.attachmentMeta(file)] });
  assert.equal(p.attachments.length, 1);
  assert.equal(P.deletePurchase(d, p.id).error, undefined);
  assert.deepEqual(d.attachments.remove, ["att-1"]);
});

test("goods that were already sold can not be taken out: the purchase is kept and nothing changes", () => {
  const d = withSupplier();
  const p = confirmed(d, { initialPayment: { amount: "1000" } });
  d.products[0].stock = 100;   // 198 m² of the 298 m² were sold
  const before = plain(d);
  const r = P.deletePurchase(d, p.id);
  assert.match(r.error, /can not be taken out of stock/);
  assert.deepEqual(plain(d), before, "not a single record changed");
  assert.equal(d.purchases.length, 1);
  assert.equal(d.supplierPayments.length, 1);
});

test("deleting twice never reverses the stock twice", () => {
  const d = withSupplier();
  const p = confirmed(d);
  assert.equal(P.deletePurchase(d, p.id).error, undefined);
  assert.equal(stockOf(d), 10);
  d.products[0].stock = 40;                // unrelated stock that arrived since
  const again = P.deletePurchase(d, p.id);
  assert.equal(again.skip, true);
  assert.equal(again.already, true);
  assert.equal(stockOf(d), 40, "the second attempt changed nothing");
});

test("other purchases of the same supplier and product are left alone", () => {
  const d = withSupplier();
  const wrong = confirmed(d, { supplierInvoiceNumber: "WRONG", lines: [{ productId: "p-tile", unit: "box", qty: "10", unitPrice: "900" }], initialPayment: { amount: "500" } });
  const right = confirmed(d, { supplierInvoiceNumber: "RIGHT", lines: [{ productId: "p-tile", unit: "box", qty: "100", unitPrice: "900" }], initialPayment: { amount: "2000" } });
  assert.equal(stockOf(d), 10 + 14.4 + 144);
  assert.equal(P.deletePurchase(d, wrong.id).error, undefined);
  assert.equal(stockOf(d), 10 + 144);
  assert.deepEqual(d.purchases.map((x) => x.id), [right.id]);
  assert.deepEqual(d.supplierPayments.map((x) => x.purchaseId), [right.id]);
  const s = P.supplierSummary(d.suppliers[0], d.purchases, d.supplierPayments, day(0));
  assert.deepEqual([s.total, s.paid, s.outstanding], [90000, 2000, 88000]);
});

test("a product deleted from Stock since does not block deleting the purchase", () => {
  const d = withSupplier();
  const p = confirmed(d);
  d.products = [];
  assert.equal(P.deletePurchase(d, p.id).error, undefined);
  assert.equal(d.purchases.length, 0);
});

test("the question shown before deleting lists the stock and payments that will go, and changes nothing", () => {
  const d = withSupplier();
  const p = confirmed(d, { initialPayment: { amount: "1000" } });
  pay(d, p.id, 250);
  const before = plain(d);
  const preview = P.deletionPreview(d, p.id);
  assert.deepEqual(preview.stockOut, [{ productId: "p-tile", name: "Tile A", qty: 288, unit: "m²" }]);
  assert.equal(preview.paymentCount, 2);
  assert.equal(preview.paid, 1250);
  assert.deepEqual(plain(d), before);
  assert.equal(P.deletionPreview(d, "nope"), null);
});

/* ==========================================================================
   2. The database (database.js)
   ========================================================================== */

test("db: deleting a confirmed purchase removes it, its payments and its attached files in ONE transaction", async () => {
  const db = await openedDb();
  await change(db, (d) => { d.products.push(tile()); return P.saveSupplier(d, supplierInput()); });
  const file = { id: "att-1", name: "invoice.png", type: "image/png", size: 12, addedAt: iso(1), dataUrl: "data:image/png;base64,AAAA" };
  const made = await change(db, (d) => {
    const p = P.saveDraft(d, purchaseInput(d, { attachments: [P.attachmentMeta(file)], initialPayment: { amount: "1000" } })).purchase;
    d.attachments.put.push({ ...file, purchaseId: p.id });
    return P.confirmPurchase(d, p.id);
  });
  assert.ok(made.purchase, made.error);
  const pid = made.purchase.id;
  await change(db, (d) => P.recordPayment(d, pid, { amount: "300", date: day(0) }));
  let all = await db.loadAll();
  assert.equal(all.supplierPayments.length, 2);
  assert.equal(all.products[0].stock, 298);
  assert.equal((await db.getAttachmentsOf(pid)).length, 1);
  const revisionBefore = all.revision;

  const r = await change(db, (d) => P.deletePurchase(d, pid));
  assert.equal(r.error, undefined);
  all = await db.loadAll();
  assert.equal(all.purchases.length, 0);
  assert.equal(all.supplierPayments.length, 0);
  assert.equal((await db.getAttachmentsOf(pid)).length, 0, "the scanned file is gone");
  assert.equal(all.products.length, 1);
  assert.equal(all.products[0].stock, 10);
  assert.equal(all.suppliers.length, 1);
  assert.equal(all.revision, revisionBefore + 1, "one transaction, one revision");
  assert.equal(all.purchaseCounter, 1, "the reference counter never goes backwards");
});

test("db: after deleting, the same supplier invoice number can be entered again, correctly", async () => {
  const db = await openedDb();
  await change(db, (d) => { d.products.push(tile()); return P.saveSupplier(d, supplierInput()); });
  const first = await change(db, (d) => confirmed(d, { supplierInvoiceNumber: "FA-WRONG" }) && {});
  assert.equal(first.error, undefined);
  const pid = (await db.loadAll()).purchases[0].id;
  assert.ok((await change(db, (d) => P.saveDraft(d, purchaseInput(d, { supplierInvoiceNumber: "FA-WRONG" })))).error, "refused while it exists");
  assert.equal((await change(db, (d) => P.deletePurchase(d, pid))).error, undefined);
  const again = await change(db, (d) => confirmed(d, { supplierInvoiceNumber: "FA-WRONG", lines: [{ productId: "p-tile", unit: "box", qty: "20", unitPrice: "900" }] }) && {});
  assert.equal(again.error, undefined);
  const all = await db.loadAll();
  assert.equal(all.purchases.length, 1);
  assert.equal(all.products[0].stock, 10 + 28.8);
});

test("db: a second delete of the same purchase writes nothing", async () => {
  const db = await openedDb();
  await change(db, (d) => { d.products.push(tile()); return P.saveSupplier(d, supplierInput()); });
  await change(db, (d) => confirmed(d, { initialPayment: { amount: "1000" } }) && {});
  const pid = (await db.loadAll()).purchases[0].id;
  assert.equal((await change(db, (d) => P.deletePurchase(d, pid))).error, undefined);
  const after = await db.loadAll();
  const second = await change(db, (d) => P.deletePurchase(d, pid));
  assert.equal(second.skip, true);
  const last = await db.loadAll();
  assert.equal(last.revision, after.revision, "no new revision");
  assert.equal(last.products[0].stock, 10);
});

test("db: a payment is never deleted on its own, and a purchase is never deleted with some of its payments left behind", async () => {
  const db = await openedDb();
  await change(db, (d) => { d.products.push(tile()); return P.saveSupplier(d, supplierInput()); });
  await change(db, (d) => confirmed(d, { initialPayment: { amount: "1000" } }) && {});
  const pid = (await db.loadAll()).purchases[0].id;
  await change(db, (d) => P.recordPayment(d, pid, { amount: "300", date: day(0) }));
  const all = await db.loadAll();
  const [p1, p2] = all.supplierPayments;
  const opts = { expectedRevision: all.revision };
  await assert.rejects(db.commitChanges({ supplierPayments: { put: [], remove: [p1.id] } }, opts), /never deleted on its own/);
  await assert.rejects(db.commitChanges({ purchases: { put: [], remove: [pid] }, supplierPayments: { put: [], remove: [p1.id] } }, opts), /only be deleted together with all its payments/);
  await assert.rejects(db.commitChanges({ purchases: { put: [], remove: [pid] } }, opts), /only be deleted together/);
  const same = await db.loadAll();
  assert.equal(same.purchases.length, 1);
  assert.equal(same.supplierPayments.length, 2);
  assert.equal(same.revision, all.revision, "none of the refused writes changed anything");
  // Together with ALL its payments it is accepted.
  await db.commitChanges({ purchases: { put: [], remove: [pid] }, supplierPayments: { put: [], remove: [p1.id, p2.id] } }, opts);
  const gone = await db.loadAll();
  assert.equal(gone.purchases.length + gone.supplierPayments.length, 0);
});

test("two windows: a window that still shows the purchase can not delete it a second time or reverse the stock again", async () => {
  const { app: a, purchaseId } = await shop();
  const b = await startedApp({ indexedDB: a.indexedDB });          // a second window, loaded while the purchase exists
  assert.equal(state(b).purchases.length, 1);

  assert.equal((await a.api.commit((d) => P.deletePurchase(d, purchaseId))).error, undefined);
  assert.equal(state(a).products[0].stock, 10);

  const late = await b.api.commit((d) => P.deletePurchase(d, purchaseId));
  assert.ok(late.error, "the out-of-date window is refused");
  const c = await startedApp({ indexedDB: a.indexedDB });
  assert.equal(state(c).products[0].stock, 10, "the stock was reversed exactly once");
  assert.equal(state(c).purchases.length, 0);
  assert.equal(state(b).purchases.length, 0, "the refused window reloaded the current data");
});

/* ==========================================================================
   3. The screen
   ========================================================================== */

// Gives the Purchases screen a click listener, as the browser does, and returns a function that presses a button.
function clicker(app) {
  const listeners = {};
  const root = app.field("purchasesRoot");
  root.addEventListener = (type, fn) => { listeners[type] = fn; };
  app.field("suppliersRoot").addEventListener = () => {};
  app.field("dashboardRoot").addEventListener = () => {};
  app.api.PurchasesUI.bind();
  return async (act, id) => {
    const el = { dataset: { act, id }, tagName: "BUTTON" };
    listeners.click({ target: { closest: () => el }, preventDefault() {} });
    // Changes are saved one after another: a do-nothing change only finishes once the one the click started has.
    await app.api.commit(() => ({ skip: true }));
    for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
  };
}

function openList(app) {
  state(app).view = "purchases";
  app.api.PurchasesUI.state.pur.screen = "list";
  app.api.renderAll();
  return app.field("purchasesRoot").innerHTML;
}

test("screen: every purchase in the list has a Delete button next to View or Edit", async () => {
  const { app } = await shop();
  await app.api.commit((d) => P.saveDraft(d, purchaseInput(d, { supplierInvoiceNumber: "DRAFT-1" })));
  await app.api.commit((d) => {
    const p = confirmed(d, { supplierInvoiceNumber: "TO-CANCEL" });
    return P.cancelPurchase(d, p.id, "wrong");
  });
  const html = openList(app);
  assert.equal(state(app).purchases.length, 3);
  assert.equal((html.match(/data-act="pur-delete"/g) || []).length, 3, "draft, confirmed and cancelled all have it");
  assert.equal((html.match(/data-act="pur-open"/g) || []).length, 6, "View/Edit and the reference link are still there");
  assert.match(html, />Delete</);
});

test("screen: the confirmation says what will go, and answering Cancel changes nothing", async () => {
  const { app, purchaseId } = await shop();
  const press = clicker(app);
  openList(app);
  app.answer(false);
  await press("pur-delete", purchaseId);
  assert.equal(app.confirms.length, 1);
  const question = app.confirms[0];
  assert.match(question, /PUR-000001/);
  assert.match(question, /Timgad Ceramic/);
  assert.match(question, /Tile A: 288 m²/);
  assert.match(question, /1 supplier payment\(s\) totalling 1,000 DA/);
  assert.match(question, /can not be undone/);
  assert.equal(state(app).purchases.length, 1);
  assert.equal(state(app).supplierPayments.length, 1);
  assert.equal(state(app).products[0].stock, 298);
});

test("screen: confirming deletes the purchase, refreshes the list and the totals at once, and a repeat does nothing more", async () => {
  const { app, purchaseId } = await shop();
  const press = clicker(app);
  assert.match(openList(app), /PUR-000001/);
  assert.equal(P.supplierSummary(state(app).suppliers[0], state(app).purchases, state(app).supplierPayments, day(0)).total, 180000);

  app.answer(true);
  await press("pur-delete", purchaseId);
  assert.equal(state(app).purchases.length, 0);
  assert.equal(state(app).supplierPayments.length, 0);
  assert.equal(state(app).products[0].stock, 10);
  assert.equal(state(app).suppliers.length, 1);
  assert.doesNotMatch(app.field("purchasesRoot").innerHTML, /PUR-000001/, "the list was redrawn without it");
  assert.match(app.toast(), /Purchase PUR-000001 deleted\./);
  const s = P.supplierSummary(state(app).suppliers[0], state(app).purchases, state(app).supplierPayments, day(0));
  assert.deepEqual([s.total, s.paid, s.outstanding], [0, 0, 0]);

  // A stale button pressed again: nothing is asked, nothing is reversed again.
  state(app).products[0].stock = 55;
  const asked = app.confirms.length;
  await press("pur-delete", purchaseId);
  assert.equal(app.confirms.length, asked, "no question for a purchase that is gone");
  assert.match(app.toast(), /already deleted/);
  assert.equal(state(app).products[0].stock, 55);

  // It is really saved: a fresh window sees the same.
  const fresh = await startedApp({ indexedDB: app.indexedDB });
  assert.equal(state(fresh).purchases.length, 0);
  assert.equal(state(fresh).supplierPayments.length, 0);
  assert.equal(state(fresh).products[0].stock, 10);
});

test("screen: sold goods block the deletion with a clear message and the purchase stays", async () => {
  const { app, purchaseId } = await shop();
  const press = clicker(app);
  await app.api.commit((d) => { d.products[0].stock = 100; });
  openList(app);
  app.answer(true);
  await press("pur-delete", purchaseId);
  assert.match(app.toast(), /can not be taken out of stock/);
  assert.equal(state(app).purchases.length, 1);
  assert.equal(state(app).supplierPayments.length, 1);
  assert.equal(state(app).products[0].stock, 100);
});

test("screen: the detail page of a confirmed purchase offers Delete and returns to the list afterwards", async () => {
  const { app, purchaseId } = await shop();
  const press = clicker(app);
  app.api.PurchasesUI.openPurchase(purchaseId);
  assert.match(app.field("purchasesRoot").innerHTML, /data-act="pur-delete"[^>]*>Delete purchase</);
  app.answer(true);
  await press("pur-delete", purchaseId);
  assert.equal(state(app).purchases.length, 0);
  assert.equal(app.api.PurchasesUI.state.pur.screen, "list");
  assert.doesNotMatch(app.field("purchasesRoot").innerHTML, /PUR-000001/);
});

test("screen: the delete texts exist in French too", async () => {
  const { app, purchaseId } = await shop();
  const press = clicker(app);
  await app.api.commit((d) => { d.settings.language = "fr"; });
  openList(app);
  app.answer(false);
  await press("pur-delete", purchaseId);
  const question = app.confirms[0];
  assert.match(question, /Supprimer définitivement l’achat PUR-000001/);
  assert.match(question, /retirées du stock/);
  assert.match(question, /irréversible/);
  assert.doesNotMatch(question, /pur\.delete/, "no missing translation");
});

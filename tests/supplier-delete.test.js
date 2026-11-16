"use strict";

// Deleting a supplier for good: the supplier goes together with everything that belongs to it alone (its invoice payments,
// advance payments / acomptes, refunds, allocations, and purchases with no goods in stock), in ONE transaction. A supplier
// whose purchases still have goods in Stock is refused, because deleting them would have to change stock.
//
// Three levels, all against disposable in-memory databases (nothing touches real data):
//   - the business rules in purchases.js on a plain copy of the data,
//   - the database guard in database.js,
//   - the real page scripts (script.js + purchases-ui.js): the trash button, the question, the save, and a restart.

const test = require("node:test");
const assert = require("node:assert/strict");
const { V, sampleProduct, newDb } = require("./helpers/modules");
const { loadApp } = require("./helpers/app");

const P = globalThis.Purchases;
const day = (offset) => P.addDays(P.toDay(new Date()), offset || 0);
const plain = (x) => JSON.parse(JSON.stringify(x));

const tile = () => sampleProduct({
  id: "p-tile", name: "Tile A", tileSize: "60*60", coveragePerBox: 1.44, sellingPrice: 800, priceUnit: "m2", stockUnit: "m2",
  purchasePrice: null, sku: "TA-1", stock: 10,
});

function draft() {
  const d = {
    products: [tile()], invoices: [], settings: { ...V.DEFAULT_SETTINGS, currency: "DZD" }, counter: 0,
    suppliers: [], purchases: [], supplierPayments: [], supplierDeposits: [], advanceAllocations: [], purchaseCounter: 0,
    attachments: { put: [], remove: [] },
  };
  for (const name of ["Timgad Ceramic", "Mistaken Co"]) {
    const r = P.saveSupplier(d, { name, phone: "", paymentTermsDays: "30", ...(name === "Mistaken Co" ? { phone: "0555 99 99 99" } : { phone: "0555 12 34 56" }) });
    assert.ok(r.supplier, r.error);
  }
  return d;
}

const timgad = (d) => d.suppliers.find((s) => s.name === "Timgad Ceramic");
const mistaken = (d) => d.suppliers.find((s) => s.name === "Mistaken Co");

// A confirmed purchase of `boxes` boxes at 1,000 DA. options.receive = {} means nothing was received (no goods in stock).
function buy(d, supplier, boxes, extra, options) {
  const input = {
    supplierId: supplier.id, supplierInvoiceNumber: "FA-" + (d.purchases.length + 1), invoiceDate: day(0),
    lines: [{ productId: "p-tile", unit: "box", qty: String(boxes), unitPrice: "1000" }], ...extra,
  };
  const saved = P.saveDraft(d, input);
  assert.ok(saved.purchase, saved.error);
  const done = P.confirmPurchase(d, saved.purchase.id, options);
  assert.ok(done.purchase, done.error);
  return saved.purchase;
}

function advance(d, supplier, amount, extra) {
  const r = P.recordDeposit(d, { supplierId: supplier.id, amount: String(amount), date: day(0), ...extra });
  assert.ok(r.deposit, r.error);
  return r.deposit;
}

const links = (d) => P.linkProblems({ ...d, attachments: [] });
const mine = (list, id) => list.filter((x) => x.supplierId === id);

/* ==========================================================================
   Business rules (purchases.js)
   ========================================================================== */

test("1. a supplier with no transactions is deleted alone and nothing else changes", () => {
  const d = draft();
  const before = plain({ ...d, suppliers: d.suppliers.filter((s) => s.id !== mistaken(d).id) });
  const preview = P.supplierDeletionPreview(d, mistaken(d).id);
  assert.deepEqual([preview.paymentCount, preview.removedTotal, preview.purchases.count, preview.allocations, preview.inStock.length], [0, 0, 0, 0, 0]);
  const r = P.deleteSupplier(d, mistaken(d).id);
  assert.ok(r.supplier, r.error);
  assert.deepEqual(plain(d), before);
});

test("2. a supplier with an advance payment (the 382,000 DA mistake) is removed with it and the books return to what they were", () => {
  const d = draft();
  advance(d, timgad(d), 50000);
  const real = plain(P.overview(d, day(0)));
  advance(d, mistaken(d), 382000, { reference: "VIR-WRONG" });
  assert.equal(P.overview(d, day(0)).advance, 432000, "the mistake is in the totals");

  const preview = P.supplierDeletionPreview(d, mistaken(d).id);
  assert.deepEqual([preview.advances.count, preview.advances.amount, preview.paymentCount, preview.removedTotal], [1, 382000, 1, 382000]);

  const r = P.deleteSupplier(d, mistaken(d).id);
  assert.ok(r.supplier, r.error);
  assert.equal(d.suppliers.length, 1);
  assert.equal(d.supplierDeposits.length, 1, "only the other supplier's advance is left");
  assert.equal(d.supplierDeposits[0].supplierId, timgad(d).id);
  const o = P.overview(d, day(0));
  assert.equal(o.advance, 50000);
  assert.equal(o.suppliers, 1);
  assert.deepEqual([o.total, o.paid, o.owed, o.advance], [real.total, real.paid, real.owed, real.advance], "the totals are what they were before the mistake");
  assert.deepEqual(links(d), []);
});

test("3. invoice payments, a refund and an applied advance of the supplier are all removed; the other supplier's records are untouched", () => {
  const d = draft();
  // Mistaken Co: an invoice nothing was received for (no goods in stock), part paid directly, part covered by an advance, and a refund.
  advance(d, mistaken(d), 25000);
  advance(d, mistaken(d), 5000, { kind: "refund" });   // 20,000 of the advance is still unapplied
  const purchase = buy(d, mistaken(d), 100, {}, { receive: {} });   // 100,000 DA: the 20,000 advance is applied to it automatically
  assert.ok(P.recordPayment(d, purchase.id, { amount: "30000", date: day(0) }).payment);
  // Timgad: its own purchase, payment and advance.
  const other = buy(d, timgad(d), 10, {}, { receive: {} });
  assert.ok(P.recordPayment(d, other.id, { amount: "4000", date: day(0) }).payment);
  advance(d, timgad(d), 7000);
  assert.ok(d.advanceAllocations.some((a) => a.supplierId === mistaken(d).id), "the advance was applied to the invoice");
  const keep = plain({ purchases: d.purchases.filter((p) => p.supplierId === timgad(d).id), payments: mine(d.supplierPayments, timgad(d).id), deposits: mine(d.supplierDeposits, timgad(d).id), allocations: mine(d.advanceAllocations, timgad(d).id) });
  const productsBefore = plain(d.products);
  const timgadSummary = plain(P.supplierPayable(d, timgad(d).id, day(0)));

  const preview = P.supplierDeletionPreview(d, mistaken(d).id);
  assert.deepEqual([preview.payments.count, preview.payments.amount, preview.advances.count, preview.advances.amount, preview.refunds.count, preview.refunds.amount], [1, 30000, 1, 25000, 1, 5000]);
  assert.ok(preview.allocations >= 1);
  assert.deepEqual([preview.purchases.count, preview.purchases.total, preview.removedTotal], [1, 100000, 55000]);

  const r = P.deleteSupplier(d, mistaken(d).id);
  assert.ok(r.supplier, r.error);
  assert.equal(mistaken(d), undefined, "the supplier is gone");
  assert.deepEqual(plain({ purchases: d.purchases, payments: d.supplierPayments, deposits: d.supplierDeposits, allocations: d.advanceAllocations }), keep, "only Timgad's records remain, exactly as they were");
  assert.deepEqual(plain(d.products), productsBefore, "stock is never touched");
  assert.deepEqual(plain(P.supplierPayable(d, timgad(d).id, day(0))), timgadSummary);
  assert.deepEqual(links(d), []);
});

test("4. a supplier whose purchase still has goods in stock is refused and nothing at all changes", () => {
  const d = draft();
  advance(d, mistaken(d), 1000);
  buy(d, mistaken(d), 20);   // 20 boxes received: stock goes up
  const stock = d.products[0].stock;
  assert.ok(stock > 10);
  const before = plain(d);

  const preview = P.supplierDeletionPreview(d, mistaken(d).id);
  assert.equal(preview.inStock.length, 1);
  const r = P.deleteSupplier(d, mistaken(d).id);
  assert.match(r.error, /Stock/);
  assert.deepEqual(plain(d), before, "a refusal changes nothing: stock, purchase, advance and supplier are all still there");

  // After the purchase is deleted the proper way (it takes its goods out of stock), the supplier can go.
  assert.ok(P.deletePurchase(d, d.purchases[0].id).purchase);
  assert.equal(d.products[0].stock, 10);
  assert.ok(P.deleteSupplier(d, mistaken(d).id).supplier);
  assert.equal(d.suppliers.length, 1);
  assert.deepEqual(links(d), []);
});

test("5. a draft purchase and a cancelled one go with the supplier; their attached files are queued for removal", () => {
  const d = draft();
  const sp = mistaken(d);
  const drafted = P.saveDraft(d, { supplierId: sp.id, supplierInvoiceNumber: "DR-1", invoiceDate: day(0), lines: [{ productId: "p-tile", unit: "box", qty: "5", unitPrice: "1000" }] }).purchase;
  drafted.attachments = [{ id: "att-1", name: "scan.pdf", type: "application/pdf", size: 10, addedAt: new Date().toISOString() }];
  const bought = buy(d, sp, 3, {}, { receive: {} });
  assert.ok(P.cancelPurchase(d, bought.id, "wrong supplier").purchase);

  const preview = P.supplierDeletionPreview(d, sp.id);
  assert.deepEqual([preview.purchases.count, preview.attachments, preview.inStock.length], [2, 1, 0]);
  assert.ok(P.deleteSupplier(d, sp.id).supplier);
  assert.equal(d.purchases.length, 0);
  assert.deepEqual(d.attachments.remove, ["att-1"]);
});

test("6. deleting twice never does anything twice", () => {
  const d = draft();
  advance(d, mistaken(d), 1000);
  const id = mistaken(d).id;
  assert.ok(P.deleteSupplier(d, id).supplier);
  const after = plain(d);
  const again = P.deleteSupplier(d, id);
  assert.equal(again.already, true);
  assert.equal(again.error, undefined);
  assert.deepEqual(plain(d), after);
});

/* ==========================================================================
   The database guard (database.js)
   ========================================================================== */

async function openedDb() {
  const db = newDb();
  await db.initDatabase();
  return db;
}

async function change(db, mutate) {
  const before = await db.loadAll();
  const d = structuredClone(before);
  d.attachments = { put: [], remove: [] };
  const result = mutate(d) || {};
  if (result.error) return result;
  await db.commitChanges(DBdiff(before, d), { expectedRevision: before.revision });
  return result;
}
const DBdiff = (before, after) => globalThis.InvoisyDB.diff(before, after);

test("7. the database never removes a supplier and leaves one of its records behind; the whole change is refused", async () => {
  const db = await openedDb();
  await change(db, (d) => { d.products.push(tile()); P.saveSupplier(d, { name: "Mistaken Co" }); });
  await change(db, (d) => { P.recordDeposit(d, { supplierId: d.suppliers[0].id, amount: "382000", date: day(0) }); });
  const all = await db.loadAll();
  await assert.rejects(db.commitChanges({ suppliers: { put: [], remove: [all.suppliers[0].id] } }, { expectedRevision: all.revision }), /deleted together with all of its/);
  const stored = await db.loadAll();
  assert.equal(stored.suppliers.length, 1, "nothing was written");
  assert.equal(stored.supplierDeposits.length, 1);

  // Done as one change (what deleteSupplier builds), it is accepted and leaves no orphan.
  const r = await change(db, (d) => P.deleteSupplier(d, d.suppliers[0].id));
  assert.equal(r.error, undefined);
  const gone = await db.loadAll();
  assert.deepEqual([gone.suppliers.length, gone.supplierDeposits.length, gone.supplierPayments.length, gone.advanceAllocations.length, gone.purchases.length], [0, 0, 0, 0, 0]);
  assert.equal(gone.products.length, 1, "unrelated records are kept");
});

/* ==========================================================================
   The screens: trash button, question, save, restart
   ========================================================================== */

const state = (app) => app.api.getState();
const ui = (app) => app.api.PurchasesUI;
const settle = () => new Promise((resolve) => setImmediate(resolve));

async function shop(options) {
  const app = loadApp(options);
  const storage = await app.start();
  assert.equal(storage.mode, "ready", storage.reason);
  return app;
}

async function seed(app) {
  assert.equal((await app.api.commit((d) => {
    d.products.push(tile());
    P.saveSupplier(d, { name: "Timgad Ceramic", phone: "0555 12 34 56", paymentTermsDays: "30" });
    P.saveSupplier(d, { name: "Mistaken Co", phone: "0555 99 99 99", paymentTermsDays: "30" });
    advance(d, d.suppliers[0], 50000);
    advance(d, d.suppliers[1], 382000, { reference: "VIR-WRONG" });
  })).error, undefined);
}

const openList = (app) => { state(app).view = "suppliers"; ui(app).reset(); app.api.renderAll(); return app.field("suppliersRoot").innerHTML; };
const idOf = (app, name) => state(app).suppliers.find((s) => s.name === name).id;

test("8. every supplier row has a red trash button, archived suppliers included, and so has the profile", async () => {
  const app = await shop();
  await seed(app);
  await app.api.commit((d) => P.setSupplierArchived(d, d.suppliers[0].id, true));
  ui(app).state.sup.status = "all";
  const html = openList(app);
  for (const name of ["Timgad Ceramic", "Mistaken Co"]) {
    const id = idOf(app, name);
    assert.match(html, new RegExp(`class="icon-btn danger" data-act="sup-delete" data-id="${id}" title="Delete this supplier permanently"`), name);
  }
  const profile = ui(app).supplierProfileHtml(state(app).suppliers[0]);
  assert.match(profile, /class="btn danger" data-act="sup-delete"/);
});

test("9. the question names the supplier, the payments and their total, says it is permanent; Cancel keeps everything", async () => {
  const app = await shop();
  await seed(app);
  openList(app);
  const id = idOf(app, "Mistaken Co");
  app.answer(false);
  await ui(app).actions["sup-delete"]({ dataset: { id } });
  await settle();
  assert.equal(app.confirms.length, 1);
  const question = app.confirms[0];
  assert.match(question, /Delete this supplier\?/);
  assert.match(question, /Mistaken Co/);
  assert.match(question, /Advance payments \(acomptes\): 1 \(.*382\D{0,2}000/);
  assert.match(question, /Total of payments removed from your records: .*382\D{0,2}000/);
  assert.match(question, /permanent and can not be undone/);
  assert.equal(state(app).suppliers.length, 2, "Cancel deletes nothing");
  assert.equal(state(app).supplierDeposits.length, 2);
});

test("10. confirming deletes the supplier and its advance at once, totals are recalculated, and it stays deleted after a restart", async () => {
  const first = await shop();
  await seed(first);
  openList(first);
  assert.equal(P.overview(state(first), day(0)).advance, 432000);
  const keepProduct = plain(state(first).products);

  first.answer(true);
  await ui(first).actions["sup-delete"]({ dataset: { id: idOf(first, "Mistaken Co") } });
  await settle();
  assert.match(first.toast(), /Mistaken Co was deleted\./);
  assert.deepEqual(state(first).suppliers.map((s) => s.name), ["Timgad Ceramic"]);
  assert.equal(state(first).supplierDeposits.length, 1);
  assert.equal(P.overview(state(first), day(0)).advance, 50000, "totals follow immediately");
  const html = first.field("suppliersRoot").innerHTML;
  assert.ok(!/Mistaken Co/.test(html), "the list is redrawn without it");

  // Restart: a second copy of the app on the SAME database.
  const second = await shop({ indexedDB: first.indexedDB });
  assert.deepEqual(state(second).suppliers.map((s) => s.name), ["Timgad Ceramic"]);
  assert.equal(state(second).supplierDeposits.length, 1);
  assert.equal(state(second).supplierDeposits[0].supplierId, idOf(second, "Timgad Ceramic"));
  assert.equal(P.overview(state(second), day(0)).advance, 50000);
  assert.deepEqual(plain(state(second).products), keepProduct);
  assert.deepEqual(links(state(second)), []);
});

test("11. a supplier with an invoice, its payment and an applied advance is deleted in one transaction and stays deleted after a restart", async () => {
  const first = await shop();
  await seed(first);
  const made = await first.api.commit((d) => {
    const sp = d.suppliers.find((s) => s.name === "Mistaken Co");
    const p = buy(d, sp, 500, {}, { receive: {} });   // 500,000 DA, nothing received (no stock effect): the 382,000 advance is applied to it
    assert.ok(P.recordPayment(d, p.id, { amount: "30000", date: day(0) }).payment);
  });
  assert.equal(made.error, undefined);
  assert.ok(state(first).advanceAllocations.length >= 1);
  const stock = state(first).products[0].stock;
  openList(first);

  first.answer(true);
  await ui(first).actions["sup-delete"]({ dataset: { id: idOf(first, "Mistaken Co") } });
  await settle();
  assert.match(first.confirms[0], /Invoice payments: 1 \(.*30\D{0,2}000/);
  assert.match(first.confirms[0], /Purchases: 1/);
  assert.match(first.confirms[0], /Stock is not changed/);

  const second = await shop({ indexedDB: first.indexedDB });
  const s = state(second);
  assert.deepEqual(s.suppliers.map((x) => x.name), ["Timgad Ceramic"]);
  assert.deepEqual([s.purchases.length, s.supplierPayments.length, s.advanceAllocations.length, s.supplierDeposits.length], [0, 0, 0, 1]);
  assert.equal(s.products[0].stock, stock, "stock is exactly as it was");
  assert.deepEqual(links(s), []);
});

test("12. a supplier whose goods are in stock is explained, not deleted; deleting the purchase first makes it possible", async () => {
  const app = await shop();
  await seed(app);
  assert.equal((await app.api.commit((d) => { buy(d, d.suppliers.find((s) => s.name === "Mistaken Co"), 20); })).error, undefined);
  openList(app);
  const before = plain(state(app));

  app.answer(true);   // even if "OK" were answered, nothing may be deleted
  await ui(app).actions["sup-delete"]({ dataset: { id: idOf(app, "Mistaken Co") } });
  await settle();
  assert.match(app.toast(), /still have goods counted in Stock/);
  assert.equal(state(app).suppliers.length, before.suppliers.length);
  assert.equal(state(app).products[0].stock, before.products[0].stock);
  assert.equal(state(app).purchases.length, 1);
  assert.equal(app.confirms.length, 0, "no deletion question is asked when it can not be done");

  await app.api.commit((d) => P.deletePurchase(d, d.purchases[0].id));
  app.answer(true);
  await ui(app).actions["sup-delete"]({ dataset: { id: idOf(app, "Mistaken Co") } });
  await settle();
  assert.deepEqual(state(app).suppliers.map((s) => s.name), ["Timgad Ceramic"]);
  assert.equal(state(app).products[0].stock, 10);
});

test("13. a supplier that is already gone is only reported, and open filters pointing at it are cleared", async () => {
  const app = await shop();
  await seed(app);
  const id = idOf(app, "Mistaken Co");
  ui(app).state.act.supplierId = id;
  ui(app).state.pur.supplierId = id;
  openList(app);
  app.answer(true);
  await ui(app).actions["sup-delete"]({ dataset: { id } });
  await settle();
  assert.equal(ui(app).state.act.supplierId, "");
  assert.equal(ui(app).state.pur.supplierId, "");
  const after = plain(state(app));
  await ui(app).actions["sup-delete"]({ dataset: { id } });
  await settle();
  assert.match(app.toast(), /no longer exists/);
  assert.deepEqual(plain(state(app)), after);
});

// The page's own <dialog> (a browser that has one), driven through the buttons' real listeners.
function withDialog(app) {
  const listeners = {};
  const dialog = app.field("supplierDeleteDialog");
  dialog.opened = 0; dialog.closed = 0;
  dialog.showModal = () => { dialog.opened++; };
  dialog.close = () => { dialog.closed++; };
  for (const id of ["supplierDeleteDialog", "supplierDeleteConfirm", "supplierDeleteCancel"]) {
    app.field(id).addEventListener = (type, fn) => { listeners[id + ":" + type] = fn; };
  }
  for (const id of ["suppliersRoot", "purchasesRoot", "dashboardRoot"]) app.field(id).addEventListener = () => {};
  app.api.PurchasesUI.bind();
  return { dialog, listeners };
}

test("14. the page's own dialog: it shows the name, the records and the total, Cancel has the focus, Esc and Cancel keep everything, Delete permanently deletes", async () => {
  const app = await shop();
  await seed(app);
  openList(app);
  const { dialog, listeners } = withDialog(app);
  let focused = "";
  app.field("supplierDeleteCancel").focus = () => { focused = "cancel"; };
  const id = idOf(app, "Mistaken Co");

  // Esc closes it like Cancel.
  let pending = ui(app).actions["sup-delete"]({ dataset: { id } });
  assert.equal(dialog.opened, 1);
  assert.equal(focused, "cancel", "Enter must not delete by accident");
  assert.equal(app.field("supplierDeleteTitle").textContent, "Delete this supplier?");
  assert.equal(app.field("supplierDeleteSubject").textContent, "Mistaken Co");
  assert.match(app.field("supplierDeleteList").innerHTML, /<li>Advance payments \(acomptes\): 1 \(.*382\D{0,2}000.*\)<\/li>/);
  assert.match(app.field("supplierDeleteTotal").textContent, /382\D{0,2}000/);
  assert.match(app.field("supplierDeleteBody").textContent, /permanent and can not be undone/);
  assert.equal(app.field("supplierDeleteConfirm").hidden, false);
  assert.equal(app.field("supplierDeleteCancel").textContent, "Cancel");
  let prevented = false;
  listeners["supplierDeleteDialog:cancel"]({ preventDefault() { prevented = true; } });
  await pending; await settle();
  assert.equal(prevented, true);
  assert.equal(dialog.closed, 1);
  assert.equal(state(app).suppliers.length, 2, "Esc deletes nothing");

  // Cancel.
  pending = ui(app).actions["sup-delete"]({ dataset: { id } });
  listeners["supplierDeleteCancel:click"]();
  await pending; await settle();
  assert.equal(state(app).suppliers.length, 2, "Cancel deletes nothing");

  // A second request while the question is open is ignored; a repeated press of Delete permanently deletes once.
  pending = ui(app).actions["sup-delete"]({ dataset: { id } });
  assert.equal(dialog.opened, 3);
  await ui(app).actions["sup-delete"]({ dataset: { id } });
  assert.equal(dialog.opened, 3, "no second dialog");
  listeners["supplierDeleteConfirm:click"]();
  listeners["supplierDeleteConfirm:click"]();
  await pending; await settle();
  assert.deepEqual(state(app).suppliers.map((x) => x.name), ["Timgad Ceramic"]);
  assert.equal(state(app).supplierDeposits.length, 1);
  assert.equal(app.confirms.length, 0, "the browser's own box was never used");
});

test("15. the page's own dialog explains a refusal and offers only Close", async () => {
  const app = await shop();
  await seed(app);
  assert.equal((await app.api.commit((d) => { buy(d, d.suppliers.find((s) => s.name === "Mistaken Co"), 20); })).error, undefined);
  openList(app);
  const { dialog, listeners } = withDialog(app);
  const pending = ui(app).actions["sup-delete"]({ dataset: { id: idOf(app, "Mistaken Co") } });
  assert.equal(app.field("supplierDeleteTitle").textContent, "This supplier can not be deleted yet");
  assert.equal(app.field("supplierDeleteConfirm").hidden, true, "there is nothing to confirm");
  assert.equal(app.field("supplierDeleteCancel").textContent, "Close");
  assert.match(app.field("supplierDeleteList").innerHTML, /PUR-/, "the purchase that blocks it is listed");
  assert.match(app.field("supplierDeleteBody").textContent, /Deleting them would change your stock/);
  listeners["supplierDeleteCancel:click"]();
  await pending; await settle();
  assert.equal(dialog.closed, 1);
  assert.equal(state(app).suppliers.length, 2);
  assert.equal(state(app).purchases.length, 1);
});

test("16. the dialog and its strings exist in the page and in every language", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  for (const id of ["supplierDeleteDialog", "supplierDeleteTitle", "supplierDeleteSubject", "supplierDeleteList", "supplierDeleteTotal", "supplierDeleteBody", "supplierDeleteCancel", "supplierDeleteConfirm"]) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  const keys = ["sup.tip.delete", "sup.deleteTitle", "sup.deleteBlockedTitle", "sup.deleteWarn", "sup.deleteNothing", "sup.delete.payments", "sup.delete.advances",
    "sup.delete.refunds", "sup.delete.allocations", "sup.delete.purchases", "sup.delete.files", "sup.delete.total", "sup.delete.stockSafe", "sup.deleteBtn",
    "sup.deleteBlockedBody", "sup.deleteAlready", "sup.err.hasStock", "db.cannotDeleteSupplier", "sup.deleted"];
  const I18n = globalThis.I18n;
  try {
    for (const code of ["en", "fr", "ar"]) {
      I18n.setLanguage(code);
      for (const key of keys) assert.notEqual(I18n.t(key, { name: "X", n: 2, amount: "1", total: "1" }), key, `${code}: ${key}`);
    }
    I18n.setLanguage("fr");
    assert.equal(I18n.t("sup.deleteBtn"), "Supprimer définitivement");
    assert.match(I18n.t("sup.delete.total", { amount: "382 000,00 DA" }), /Total des paiements retirés de vos comptes\u00a0: 382 000,00 DA/);
  } finally {
    I18n.setLanguage("en");
  }
});

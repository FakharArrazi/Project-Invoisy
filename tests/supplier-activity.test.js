"use strict";

// Supplier standing (Good standing / Needs attention), the Supplier Activity list, and the Back buttons.
// The rules run on a plain copy of the data; the screens run through the real page scripts against a disposable
// in-memory IndexedDB, with the page's buttons called the way a click would call them.

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { V, sampleProduct } = require("./helpers/modules");
const { loadApp } = require("./helpers/app");

const P = globalThis.Purchases;
const day = (offset) => P.addDays(P.toDay(new Date()), offset || 0);
const at = (dayText, hhmm) => new Date(`${dayText}T${hhmm}:00.000Z`);   // a moment on a given day, for the stamps
const settle = () => new Promise((resolve) => setImmediate(resolve));

const tile = () => sampleProduct({
  id: "p-tile", name: "Tile A", tileSize: "60*60", coveragePerBox: 1.44, sellingPrice: 800, priceUnit: "m2", stockUnit: "m2",
  purchasePrice: null, sku: "TA-1", stock: 10,
});

function blank() {
  return {
    products: [tile()], invoices: [], settings: { ...V.DEFAULT_SETTINGS, currency: "DZD" }, counter: 0,
    suppliers: [], purchases: [], supplierPayments: [], supplierDeposits: [], advanceAllocations: [], purchaseCounter: 0,
    attachments: { put: [], remove: [] },
  };
}

let phoneSerial = 10;
function addSupplier(d, name) {
  const r = P.saveSupplier(d, { name, phone: "0555 12 34 " + ++phoneSerial, paymentTermsDays: "30" });
  assert.ok(r.supplier, r.error);
  return r.supplier;
}

// A confirmed purchase of `boxes` boxes (1,000 DA each) from a supplier, invoice dated `invoiceDate`, entered at `when`.
let serial = 0;
function buy(d, supplier, invoiceDate, when, boxes, extra) {
  const saved = P.saveDraft(d, {
    supplierId: supplier.id, supplierInvoiceNumber: "FA-" + (100 + ++serial), invoiceDate,
    lines: [{ productId: "p-tile", unit: "box", qty: String(boxes || 1), unitPrice: "1000" }], ...extra,
  }, { now: when });
  assert.ok(saved.purchase, saved.error);
  const done = P.confirmPurchase(d, saved.purchase.id, { now: when });
  assert.ok(done.purchase, done.error);
  return d.purchases.find((p) => p.id === saved.purchase.id);
}

function pay(d, purchase, payDay, when, amount, extra) {
  const r = P.recordPayment(d, purchase.id, { amount: String(amount), date: payDay, ...extra }, { now: when });
  assert.ok(r.payment, r.error);
  return r.payment;
}

const order = (d, options) => P.supplierActivity(d, options).rows.map((r) => r.id);
const clone = (x) => JSON.parse(JSON.stringify(x));

/* ---------- Supplier standing ---------- */

test("a supplier is neutral until marked; only Good standing or Needs attention is ever stored, and clearing removes the field", () => {
  const d = blank();
  const sp = addSupplier(d, "Bookseram");
  assert.equal("standing" in sp, false, "a new supplier has exactly the shape it always had");
  assert.equal(P.supplierStanding(sp), "neutral");

  assert.ok(P.setSupplierStanding(d, sp.id, "good").supplier);
  assert.equal(sp.standing, "good");
  assert.ok(P.setSupplierStanding(d, sp.id, "attention").supplier);
  assert.equal(sp.standing, "attention", "only one status at a time: the second replaced the first");
  assert.equal(P.setSupplierStanding(d, sp.id, "attention").skip, true, "setting what is already set changes nothing");

  assert.ok(P.setSupplierStanding(d, sp.id, "neutral").supplier);
  assert.equal("standing" in sp, false, "neutral is the absence of the field");
  assert.equal(P.supplierStanding(sp), "neutral");

  assert.ok(P.setSupplierStanding(d, sp.id, "excellent").error, "an unknown status is refused");
  assert.ok(P.setSupplierStanding(d, "nobody", "good").error, "an unknown supplier is refused");
  assert.equal("standing" in sp, false, "a refused change wrote nothing");
});

test("a standing survives editing the supplier, a backup round trip and normalizing; unusable values are not kept", () => {
  const d = blank();
  const sp = addSupplier(d, "Bookseram");
  P.setSupplierStanding(d, sp.id, "good");
  assert.ok(P.saveSupplier(d, { id: sp.id, name: "Bookseram", phone: "0555 99 88 77", paymentTermsDays: "30" }).supplier);
  assert.equal(sp.standing, "good", "editing the supplier's details keeps the status");

  const restored = P.normalizeSupplier(JSON.parse(JSON.stringify(sp)));
  assert.equal(restored.standing, "good");
  assert.equal(P.supplierProblem(restored), "", "a supplier with a standing is a valid record");

  for (const junk of ["neutral", "excellent", 3, null, ""]) {
    assert.equal("standing" in P.normalizeSupplier({ ...JSON.parse(JSON.stringify(sp)), standing: junk }), false, `${JSON.stringify(junk)} is dropped`);
  }
  assert.ok(P.supplierProblem({ ...JSON.parse(JSON.stringify(sp)), standing: "excellent" }), "a backup with an unknown status is refused, not repaired");
  const old = JSON.parse(JSON.stringify(sp));
  delete old.standing;
  assert.equal(P.supplierProblem(old), "", "an older record without the field is valid");
});

test("a standing never touches a balance, a purchase, a payment or an advance", () => {
  const d = blank();
  const sp = addSupplier(d, "Bookseram");
  const a = buy(d, sp, day(-3), at(day(-3), "09:00"), 5);
  pay(d, a, day(-3), at(day(-3), "10:00"), 2000);
  P.recordDeposit(d, { supplierId: sp.id, amount: "1500", date: day(-2) }, { now: at(day(-2), "09:00") });
  const money = () => clone({
    purchases: d.purchases, payments: d.supplierPayments, deposits: d.supplierDeposits, allocations: d.advanceAllocations,
    summary: P.supplierSummary(sp, d.purchases, d.supplierPayments, day(0), d.supplierDeposits, d.advanceAllocations),
    activity: P.supplierActivity(d, {}),
  });
  const before = money();
  P.setSupplierStanding(d, sp.id, "attention");
  P.setSupplierStanding(d, sp.id, "good");
  P.setSupplierStanding(d, sp.id, "neutral");
  assert.deepEqual(money(), before);
});

/* ---------- Supplier Activity: the order ---------- */

test("same-day transactions are ordered by when they were entered: your example, newest first and oldest first", () => {
  const d = blank();
  const sp = addSupplier(d, "Bookseram");
  const other = addSupplier(d, "Timgad Ceramic");
  const D = day(-4);
  const A = buy(d, sp, D, at(D, "10:00"), 3);                          // Purchase A, entered 10:00
  const B = pay(d, A, D, at(D, "13:00"), 500);                         // Payment B, entered 13:00
  const C = buy(d, other, D, at(D, "16:00"), 2);                       // Purchase C, entered 16:00
  assert.deepEqual(order(d), [C.id, B.id, A.id], "newest first: C (4 PM), B (1 PM), A (10 AM)");
  assert.deepEqual(order(d, { order: "oldest" }), [A.id, B.id, C.id], "oldest first is the exact mirror");
  assert.deepEqual(order(d, { order: "newest" }), order(d), "newest first is the default");
});

test("the transaction date decides first: a purchase dated earlier but entered later stays below a later-dated one", () => {
  const d = blank();
  const sp = addSupplier(d, "Bookseram");
  const late = buy(d, sp, day(-1), at(day(-4), "08:00"), 1);   // dated yesterday, entered long ago
  const early = buy(d, sp, day(-3), at(day(-1), "18:00"), 1);   // dated 3 days ago, entered last
  assert.deepEqual(order(d), [late.id, early.id]);
  assert.deepEqual(order(d, { order: "oldest" }), [early.id, late.id]);
});

test("the order never depends on how the records are stored: shuffled records give the same list", () => {
  const d = blank();
  const sp = addSupplier(d, "Bookseram");
  const D = day(-5);
  const a = buy(d, sp, D, at(D, "09:00"), 1);
  const p1 = pay(d, a, D, at(D, "09:30"), 100);
  const b = buy(d, sp, D, at(D, "11:00"), 1);
  const p2 = pay(d, b, D, at(D, "11:00"), 100);   // saved at the very same instant as its purchase
  const expected = order(d);
  assert.deepEqual(expected, [p2.id, b.id, p1.id, a.id], "the payment made with a purchase (same instant) is listed after it");
  const reversed = { ...d, purchases: [...d.purchases].reverse(), supplierPayments: [...d.supplierPayments].reverse(), suppliers: [...d.suppliers].reverse() };
  assert.deepEqual(order(reversed), expected);
  const rotated = { ...d, purchases: [...d.purchases.slice(1), d.purchases[0]], supplierPayments: [...d.supplierPayments.slice(1), d.supplierPayments[0]] };
  assert.deepEqual(order(rotated), expected);
});

test("editing an old purchase or payment keeps its place: nothing becomes 'new'", () => {
  const d = blank();
  const sp = addSupplier(d, "Bookseram");
  const D = day(-6);
  const first = buy(d, sp, D, at(D, "09:00"), 4);
  const p1 = pay(d, first, D, at(D, "10:00"), 300);
  const second = buy(d, sp, D, at(D, "12:00"), 1);
  const p2 = pay(d, first, D, at(D, "14:00"), 300);
  const before = order(d);
  assert.deepEqual(before, [p2.id, second.id, p1.id, first.id]);
  const stamps = () => clone([d.purchases.map((p) => [p.createdAt, p.confirmedAt]), d.supplierPayments.map((p) => p.createdAt)]);
  const stampsBefore = stamps();

  const late = at(day(0), "23:00");   // edited tonight
  const e1 = P.updatePayment(d, p1.id, { amount: "250", date: D, note: "corrected" }, { now: late });
  assert.ok(e1.payment, e1.error);
  const e2 = P.updatePurchaseDetails(d, first.id, { notes: "checked again", supplierInvoiceNumber: "FA-EDITED" }, { now: late });
  assert.ok(e2.purchase, e2.error);

  assert.deepEqual(order(d), before, "the same order after both edits");
  assert.deepEqual(stamps(), stampsBefore, "no creation or confirmation stamp was touched");
  const edited = P.supplierActivity(d, {}).rows.find((r) => r.id === first.id);
  assert.equal(edited.reference, "FA-EDITED", "the list shows the edited value");
});

test("records from before the stamps existed are listed without error, as the oldest of their day, and nothing is invented", () => {
  const d = blank();
  const sp = addSupplier(d, "Bookseram");
  const D = day(-5);
  const stamped = buy(d, sp, D, at(D, "09:00"), 1);
  const legacy = buy(d, sp, D, at(D, "10:00"), 1);
  const legacyPay = pay(d, legacy, D, at(D, "10:30"), 100);
  for (const p of [legacy]) { p.createdAt = ""; delete p.confirmedAt; }
  delete legacyPay.createdAt;

  const rows = P.supplierActivity(d, {}).rows;
  assert.equal(rows.length, 3, "every record is still listed");
  assert.deepEqual(rows.map((r) => r.id), [stamped.id, legacyPay.id, legacy.id], "the stamped record is newest; the unstamped ones are the oldest of their day (a payment after its purchase)");
  for (const r of rows.filter((x) => x.id !== stamped.id)) {
    assert.equal(r.enteredAt, "", "no time was made up");
    assert.equal(r.enteredMs, null);
  }
  assert.deepEqual(order(d, { order: "oldest" }), order(d).reverse(), "oldest first is still the mirror");
  assert.equal(order({ ...d, purchases: [...d.purchases].reverse(), supplierPayments: [] }).length, 2, "reading them in another order does not throw");
});

/* ---------- Supplier Activity: what is listed, filters and totals ---------- */

function sampleBooks() {
  const d = blank();
  const book = addSupplier(d, "Bookseram");
  const timgad = addSupplier(d, "Timgad Ceramic");
  const a = buy(d, book, day(-9), at(day(-9), "09:00"), 5);
  const pa = pay(d, a, day(-8), at(day(-8), "10:00"), 1200, { method: "bank", reference: "VIR-77" });
  const b = buy(d, timgad, day(-6), at(day(-6), "11:00"), 2, { supplierInvoiceNumber: "TC-2042" });
  const adv = P.recordDeposit(d, { supplierId: timgad.id, amount: "700", date: day(-4), method: "cash" }, { now: at(day(-4), "12:00") }).deposit;
  return { d, book, timgad, a, pa, b, adv };
}

test("one row per confirmed purchase and per payment; drafts, refunds and allocations are not rows", () => {
  const { d, book, timgad, a, pa, b, adv } = sampleBooks();
  const draftOnly = P.saveDraft(d, { supplierId: book.id, supplierInvoiceNumber: "DRAFT-1", invoiceDate: day(-2), lines: [{ productId: "p-tile", unit: "box", qty: "1", unitPrice: "1000" }] });
  assert.ok(draftOnly.purchase, draftOnly.error);
  const refund = P.recordDeposit(d, { supplierId: timgad.id, kind: "refund", amount: "100", date: day(-1) }, { now: at(day(-1), "12:00") });
  assert.ok(refund.deposit || refund.error);   // a refund may be refused while there is little credit: the list must hold either way

  const activity = P.supplierActivity(d, {});
  assert.equal(activity.rows.length, 4, "2 purchases + 1 invoice payment + 1 advance");
  assert.deepEqual(new Set(activity.rows.map((r) => r.id)), new Set([a.id, pa.id, b.id, adv.id]));
  assert.equal(activity.rows.filter((r) => r.kind === "advance").length, 1);
  assert.equal(activity.rows.find((r) => r.id === adv.id).purchaseId, "", "an advance is not tied to one invoice");

  // The advance is applied to an invoice: that moves money between records and must not show up as a payment.
  const applied = P.settleSupplierCredit(d, timgad.id, { now: at(day(-3), "13:00") });
  assert.ok(applied);
  assert.equal(P.supplierActivity(d, { type: "payments" }).rows.length, 2, "still only the invoice payment and the advance");
});

test("the list only reads: it changes nothing and counts every record once", () => {
  const { d } = sampleBooks();
  const before = JSON.stringify(d);
  const first = P.supplierActivity(d, { order: "oldest" });
  P.supplierActivity(d, { q: "bookseram", type: "purchases" });
  assert.equal(JSON.stringify(d), before, "no record was touched");
  assert.equal(first.rows.length, d.purchases.length + d.supplierPayments.length + d.supplierDeposits.length, "one row per record, no duplicates");
  assert.equal(new Set(first.rows.map((r) => r.key)).size, first.rows.length);
});

test("All / Purchases / Payments, supplier, search and date range filters", () => {
  const { d, book, timgad, a, pa, b, adv } = sampleBooks();
  assert.deepEqual(order(d, { type: "purchases", order: "oldest" }), [a.id, b.id]);
  assert.deepEqual(order(d, { type: "payments", order: "oldest" }), [pa.id, adv.id]);
  assert.deepEqual(order(d, { supplierId: book.id, order: "oldest" }), [a.id, pa.id]);
  assert.deepEqual(order(d, { supplierId: timgad.id, type: "payments" }), [adv.id]);

  assert.deepEqual(order(d, { q: "bookseram", order: "oldest" }), [a.id, pa.id], "by supplier name");
  assert.deepEqual(order(d, { q: "  BOOKSERAM " }), order(d, { q: "bookseram" }), "case and spaces do not matter");
  assert.deepEqual(order(d, { q: "TC-2042" }), [b.id], "by the supplier's invoice number");
  assert.deepEqual(order(d, { q: b.reference }), [b.id], "by the purchase's own reference");
  assert.deepEqual(new Set(order(d, { q: "FA-" })), new Set([a.id, pa.id]), "a partial number matches the purchase and the payment of that invoice, not the other supplier's");
  assert.deepEqual(order(d, { q: "nothing like this" }), []);

  assert.deepEqual(order(d, { from: day(-8), to: day(-6), order: "oldest" }), [pa.id, b.id], "both ends are included");
  assert.deepEqual(order(d, { from: day(-3) }), [], "nothing after that day");
  assert.deepEqual(order(d, { to: day(-9) }), [a.id]);
});

test("purchases and payments are totalled apart; a cancelled purchase and a voided payment are listed but not counted", () => {
  const { d, a, pa, b, adv } = sampleBooks();
  let t = P.supplierActivity(d, {}).totals;
  assert.deepEqual(t, { purchases: { count: 2, amount: 7000 }, payments: { count: 2, amount: 1900 } }, "5,000 + 2,000 bought; 1,200 + 700 paid: two separate figures");
  assert.deepEqual(P.supplierActivity(d, { type: "purchases" }).totals.payments, { count: 0, amount: 0 }, "payments are not counted in the purchases view");
  assert.equal(P.supplierActivity(d, { supplierId: a.supplierId }).totals.purchases.amount, 5000, "totals follow the filters");

  const voided = P.voidPayment(d, pa.id, "typed twice", { now: at(day(-1), "10:00") });
  assert.ok(voided.payment, voided.error);
  const cancelled = P.cancelPurchase(d, b.id, "returned to the supplier", { now: at(day(-1), "11:00") });
  assert.ok(cancelled.purchase, cancelled.error);
  const after = P.supplierActivity(d, {});
  assert.equal(after.rows.length, 4, "nothing disappeared from the history");
  assert.equal(after.rows.find((r) => r.id === pa.id).status, "voided");
  assert.equal(after.rows.find((r) => r.id === b.id).status, "cancelled");
  assert.deepEqual(after.totals, { purchases: { count: 1, amount: 5000 }, payments: { count: 1, amount: 700 } });
  assert.equal(adv.amount, 700);
});

/* ---------- The screens ---------- */

async function shop() {
  const app = loadApp();
  const storage = await app.start();
  assert.equal(storage.mode, "ready", storage.reason);
  const { d, book, timgad } = sampleBooks();
  assert.equal((await app.api.commit((s) => {
    s.products.push(tile());
    for (const sp of d.suppliers) s.suppliers.push(sp);
    for (const p of d.purchases) s.purchases.push(p);
    for (const p of d.supplierPayments) s.supplierPayments.push(p);
    for (const p of d.supplierDeposits) s.supplierDeposits.push(p);
    s.purchaseCounter = d.purchaseCounter;
  })).error, undefined);
  return { app, book: book.id, timgad: timgad.id };
}

const state = (app) => app.api.getState();
const ui = (app) => app.api.PurchasesUI;
const rows = (app) => app.field("suppliersRoot").innerHTML;
async function showSuppliers(app) {
  state(app).view = "suppliers";
  ui(app).reset();
  app.api.renderAll();
}
const rowOf = (html, id) => (html.match(new RegExp(`<tr data-id="${id}"[\\s\\S]*?</tr>`)) || [""])[0];

test("the Suppliers table has compact icon buttons with tooltips: the four actions plus the two standing toggles", async () => {
  const { app, book } = await shop();
  await showSuppliers(app);
  const row = rowOf(rows(app), book);
  assert.ok(row, "the supplier row is drawn");
  for (const action of ["sup-open", "sup-deposit", "pur-new", "sup-edit"]) {
    assert.match(row, new RegExp(`class="icon-btn" data-act="${action}"[^>]*title="[^"]+"[^>]*aria-label="[^"]*Bookseram[^"]*"`), `${action} is an icon button with a tooltip and a label naming the supplier`);
  }
  assert.equal((row.match(/data-act="sup-standing"/g) || []).length, 2, "two standing controls");
  assert.equal((row.match(/aria-pressed="false"/g) || []).length, 2, "both are off for a supplier never marked");
  assert.doesNotMatch(row, /class="btn small"/, "no wide text buttons are left in the row");
  assert.doesNotMatch(row, /standing-(good|attention)/, "a neutral row has no tint class");
});

test("an archived supplier keeps View, Edit and the standing controls but offers no payment or purchase", async () => {
  const { app, timgad } = await shop();
  assert.equal((await app.api.commit((d) => P.setSupplierArchived(d, timgad, true))).error, undefined);
  state(app).view = "suppliers";
  ui(app).reset();
  ui(app).state.sup.status = "all";
  app.api.renderAll();
  const row = rowOf(rows(app), timgad);
  assert.match(row, /data-act="sup-open"/);
  assert.match(row, /data-act="sup-edit"/);
  assert.doesNotMatch(row, /data-act="(sup-deposit|pur-new)"/);
  assert.equal((row.match(/data-act="sup-standing"/g) || []).length, 2);
});

test("pressing a standing sets it, only one is on at a time, pressing it again clears it, and the row is tinted to match", async () => {
  const { app, book, timgad } = await shop();
  await showSuppliers(app);
  const press = async (id, value) => { await ui(app).actions["sup-standing"]({ dataset: { id, standing: value } }); await settle(); };
  // Pressing a button redraws only the table body (supRows), which the stand-in page keeps apart from the whole screen's text.
  const body = () => app.field("supRows").innerHTML;
  const bookRow = () => rowOf(body(), book);
  const pressed = (row, value) => new RegExp(`data-standing="${value}" aria-pressed="true"`).test(row);

  await press(book, "good");
  assert.match(bookRow(), /class="sup-row standing-good"/);
  assert.ok(pressed(bookRow(), "good") && !pressed(bookRow(), "attention"));
  assert.equal(state(app).suppliers.find((s) => s.id === book).standing, "good");

  await press(timgad, "attention");
  assert.match(rowOf(body(), timgad), /class="sup-row standing-attention"/);
  assert.match(bookRow(), /standing-good/, "the other supplier is untouched");

  await press(book, "attention");   // switching: never both
  assert.ok(pressed(bookRow(), "attention") && !pressed(bookRow(), "good"));
  assert.match(bookRow(), /standing-attention/);
  assert.doesNotMatch(bookRow(), /standing-good/);

  await press(book, "attention");   // the one that is on: clears
  assert.match(bookRow(), /class="sup-row"/, "back to a plain row");
  assert.doesNotMatch(bookRow(), /sup-row standing-/);
  assert.equal("standing" in state(app).suppliers.find((s) => s.id === book), false, "back to neutral: the field is gone");
  assert.match(rowOf(body(), timgad), /<span class="sr-only"> \(Needs attention\)<\/span>/, "the state is also in words for a screen reader");
});

test("a standing survives closing and reopening the application; suppliers never marked are unchanged", async () => {
  const { app, book, timgad } = await shop();
  await showSuppliers(app);
  await ui(app).actions["sup-standing"]({ dataset: { id: book, standing: "good" } });
  await settle();

  const second = loadApp({ indexedDB: app.indexedDB });
  const storage = await second.start();
  assert.equal(storage.mode, "ready", storage.reason);
  const suppliers = second.api.getState().suppliers;
  assert.equal(suppliers.find((s) => s.id === book).standing, "good", "still marked after a restart");
  assert.equal("standing" in suppliers.find((s) => s.id === timgad), false, "an unmarked supplier is exactly as before");
  second.api.getState().view = "suppliers";
  second.api.PurchasesUI.reset();
  second.api.renderAll();
  assert.match(rowOf(second.field("suppliersRoot").innerHTML, book), /standing-good/, "and the row is tinted again");
});

test("the Supplier Activity page: reached from Suppliers, three views, rows in order, separate totals", async () => {
  const { app, book } = await shop();
  await showSuppliers(app);
  assert.match(rows(app), /data-act="sup-activity"/, "a button on the Suppliers page opens it");

  ui(app).actions["sup-activity"]();
  const html = rows(app);
  assert.match(html, /<h2>Supplier Activity<\/h2>/);
  for (const type of ["all", "purchases", "payments"]) assert.match(html, new RegExp(`data-act="act-type" data-type="${type}"`));
  for (const id of ["actSearch", "actSupplier", "actFrom", "actTo", "actOrder"]) assert.match(html, new RegExp(`id="${id}"`), `${id} filter`);
  assert.match(html, /Back to Suppliers/);
  const dates = [...html.matchAll(/<td class="date-cell">(\d\d\/\d\d\/\d{4})/g)].map((m) => m[1]);
  assert.equal(dates.length, 4, "2 purchases + 2 payments");
  const key = (text) => text.split("/").reverse().join("");
  assert.deepEqual(dates, [...dates].sort((x, y) => key(y).localeCompare(key(x))), "newest first");
  assert.match(html, /Purchases listed[\s\S]*Payments listed/, "two separate totals");
  assert.doesNotMatch(html, /data-act="act-type" data-type="all"[^>]*aria-selected="false"/, "All activity is the view that opens");

  ui(app).actions["act-type"]({ dataset: { type: "payments" } });
  const payments = rows(app);
  assert.equal((payments.match(/<td class="date-cell">/g) || []).length, 2);
  assert.doesNotMatch(payments, /Purchases listed/, "the purchases total is not shown in the payments view");
  assert.match(payments, /Payments listed/);

  ui(app).actions["act-type"]({ dataset: { type: "purchases" } });
  assert.equal((rows(app).match(/<td class="date-cell">/g) || []).length, 2);
  assert.doesNotMatch(rows(app), /Payments listed/);
  assert.ok(book);
});

test("opening a row goes to its purchase or supplier, and Back returns to the Supplier Activity list", async () => {
  const { app, book, timgad } = await shop();
  await showSuppliers(app);
  ui(app).actions["sup-activity"]();
  const purchase = state(app).purchases.find((p) => p.supplierId === book);

  ui(app).actions["act-open"]({ dataset: { purchase: purchase.id, supplier: book } });
  assert.equal(state(app).view, "purchases");
  assert.equal(ui(app).state.pur.screen, "detail");
  assert.equal(ui(app).state.pur.detailId, purchase.id);
  assert.match(app.field("purchasesRoot").innerHTML, /Back to Supplier Activity/, "the button names where it goes");

  ui(app).actions["pur-back"]();
  assert.equal(state(app).view, "suppliers");
  assert.equal(ui(app).state.sup.screen, "activity", "back on the activity list");

  // An advance has no invoice: its row opens the supplier's payments.
  ui(app).actions["act-open"]({ dataset: { purchase: "", supplier: timgad } });
  assert.equal(ui(app).state.sup.screen, "profile");
  assert.equal(ui(app).state.sup.tab, "payments");
  assert.match(rows(app), /Back to Supplier Activity/);
  ui(app).actions["sup-back"]();
  assert.equal(ui(app).state.sup.screen, "activity");
});

test("Back goes where the person came from, names it, and falls back to the screen's own list", async () => {
  const { app, book } = await shop();
  const purchase = state(app).purchases.find((p) => p.supplierId === book);

  // From the supplier's profile: the purchase's Back leads to that profile, and the profile's Back to the list.
  await showSuppliers(app);
  ui(app).openSupplier(book);
  assert.match(rows(app), /Back to Suppliers/);
  ui(app).openPurchase(purchase.id);
  assert.match(app.field("purchasesRoot").innerHTML, /Back to Bookseram/);
  ui(app).actions["pur-back"]();
  assert.equal(state(app).view, "suppliers");
  assert.equal(ui(app).state.sup.screen, "profile");
  assert.equal(ui(app).state.sup.profileId, book);
  ui(app).actions["sup-back"]();
  assert.equal(ui(app).state.sup.screen, "list");

  // Reached with no history (straight from the side menu): the fallback is the Purchases list.
  state(app).view = "purchases";
  ui(app).reset();
  ui(app).openPurchase(purchase.id);
  assert.match(app.field("purchasesRoot").innerHTML, /Back to Purchases/);
  ui(app).actions["pur-back"]();
  assert.equal(ui(app).state.pur.screen, "list");
  assert.equal(state(app).view, "purchases");

  // From the Dashboard: back to the Dashboard.
  state(app).view = "dashboard";
  ui(app).reset();
  ui(app).openPurchase(purchase.id);
  assert.match(app.field("purchasesRoot").innerHTML, /Back to Dashboard/);
  ui(app).actions["pur-back"]();
  assert.equal(state(app).view, "dashboard");
});

test("a place that no longer exists is skipped by Back, and the side menu starts a fresh trail", async () => {
  const { app, book } = await shop();
  const purchase = state(app).purchases.find((p) => p.supplierId === book);
  await showSuppliers(app);
  ui(app).openSupplier(book);
  ui(app).openPurchase(purchase.id);
  assert.match(app.field("purchasesRoot").innerHTML, /Back to Bookseram/);

  state(app).suppliers = state(app).suppliers.filter((s) => s.id !== book);   // the supplier was deleted meanwhile
  app.api.renderAll();
  assert.match(app.field("purchasesRoot").innerHTML, /Back to Suppliers/, "the button now names a place that is really there");
  assert.doesNotMatch(app.field("purchasesRoot").innerHTML, /Back to Bookseram/);
  ui(app).actions["pur-back"]();
  assert.equal(state(app).view, "suppliers");
  assert.equal(ui(app).state.sup.screen, "list", "it did not open a profile that is gone");

  ui(app).state.trail.push({ v: "suppliers", s: "list" });
  state(app).view = "stock";   // the side menu: a view these screens do not own
  app.api.renderAll();
  assert.equal(ui(app).state.trail.length, 0, "reaching another view from the side menu starts again");
});

test("every back control is the shared back button: no underlined text link is left", () => {
  const root = path.join(__dirname, "..");
  const files = ["index.html", ...fs.readdirSync(path.join(root, "java script")).filter((f) => f.endsWith(".js")).map((f) => "java script/" + f)];
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.doesNotMatch(source, /class="link back"/, `${file} has no plain back link`);
  }
  const styles = fs.readFileSync(path.join(root, "css", "style.css"), "utf8");
  assert.doesNotMatch(styles, /\.link\.back/);
  for (const file of ["java script/purchases-ui.js", "java script/workers-ui.js", "index.html"]) {
    assert.match(fs.readFileSync(path.join(root, file), "utf8"), /class="back-btn"/, `${file} uses the shared back button`);
  }
});

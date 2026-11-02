"use strict";

// Unified supplier payments: ONE payment to a supplier (an advance) is spread by itself over the supplier's open invoices,
// oldest first; what is left stays as credit and is used by the next confirmed purchase. The rules run on a plain copy of
// the data; the screens and the storage run through the real page scripts / a disposable in-memory IndexedDB.

const test = require("node:test");
const assert = require("node:assert/strict");
const { V, newDb, sampleProduct } = require("./helpers/modules");
const { loadApp } = require("./helpers/app");

const P = globalThis.Purchases;
const day = (offset) => P.addDays(P.toDay(new Date()), offset || 0);
const round = (n) => Math.round(n * 100) / 100;

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
  assert.ok(P.saveSupplier(d, { name: "Timgad Ceramic", phone: "0555 12 34 56", paymentTermsDays: "30" }).supplier);
  return d;
}

// A confirmed purchase of `thousands` thousand DA (1,000 DA per box) dated `daysAgo` days ago.
let invoiceSerial = 0;
function invoice(d, thousands, daysAgo, extra, options) {
  const saved = P.saveDraft(d, {
    supplierId: d.suppliers[0].id, supplierInvoiceNumber: "FA-" + ++invoiceSerial, invoiceDate: day(-(daysAgo || 0)),
    lines: [{ productId: "p-tile", unit: "box", qty: String(thousands), unitPrice: "1000" }], ...extra,
  });
  assert.ok(saved.purchase, saved.error);
  const done = P.confirmPurchase(d, saved.purchase.id, options);
  assert.ok(done.purchase, done.error);
  return { ...done, id: saved.purchase.id };
}

function advance(d, amount, extra) {
  const r = P.recordDeposit(d, { supplierId: d.suppliers[0].id, amount: String(amount), date: day(0), ...extra });
  assert.ok(r.deposit, r.error);
  return r;
}

const sid = (d) => d.suppliers[0].id;
const sum = (d) => P.supplierPayable(d, sid(d), day(0));
const inv = (d, id) => P.purchaseSummary(d.purchases.find((p) => p.id === id), d.supplierPayments, day(0), d.advanceAllocations);
const state = (d, id) => { const s = inv(d, id); return [s.paid, s.outstanding, s.paymentStatus]; };
const links = (d) => P.linkProblems({ ...d, attachments: [] });

// The accounting rules that must hold after EVERY operation.
function audit(d) {
  const s = sum(d);
  assert.equal(s.net, round(s.outstanding - s.unapplied), "net balance = outstanding invoices - unapplied credit");
  assert.equal(s.net, round(s.total - s.paid), "net balance = purchases - paid");
  assert.equal(s.paid, round(s.invoicePaid + s.deposited - s.refunded), "an allocation is never counted as a payment");
  for (const p of d.purchases.filter((x) => x.status === "confirmed")) assert.ok(inv(d, p.id).paid <= p.total + 0.001, "an invoice is never over-settled");
  const used = new Map();
  for (const a of d.advanceAllocations.filter((x) => x.status !== "reversed")) used.set(a.depositId, round((used.get(a.depositId) || 0) + a.amount));
  for (const x of d.supplierDeposits.filter((y) => y.kind !== "refund" && y.status !== "voided")) assert.ok((used.get(x.id) || 0) <= x.amount + 0.001, "a deposit is never over-applied");
  assert.deepEqual(links(d), []);
}

// Four invoices of 250, 350, 400 and 300 thousand, entered in a scrambled order but dated oldest to newest.
function fourInvoices(d) {
  const i3 = invoice(d, 400, 7);
  const i1 = invoice(d, 250, 10);
  const i4 = invoice(d, 300, 5);
  const i2 = invoice(d, 350, 8);
  return [i1, i2, i3, i4];
}

test("1. an advance that equals one invoice pays it in full: one deposit, one allocation, no credit", () => {
  const d = draft();
  const a = invoice(d, 250, 3);
  const r = advance(d, 250000);
  assert.deepEqual(state(d, a.id), [250000, 0, "paid"]);
  assert.equal(d.supplierDeposits.length, 1);
  assert.equal(d.advanceAllocations.length, 1);
  assert.equal(d.supplierPayments.length, 0, "no cash payment was created for the invoice");
  assert.deepEqual([r.allocated, r.credit, r.covered.length], [250000, 0, 1]);
  assert.equal(sum(d).unapplied, 0);
  audit(d);
});

test("2. one advance of 1,000,000 pays the oldest three invoices (by invoice date, not entry order) and leaves the fourth unpaid", () => {
  const d = draft();
  const [i1, i2, i3, i4] = fourInvoices(d);
  const r = advance(d, 1000000, { method: "bank", reference: "VIR-1", note: "autumn" });
  assert.deepEqual(state(d, i1.id), [250000, 0, "paid"]);
  assert.deepEqual(state(d, i2.id), [350000, 0, "paid"]);
  assert.deepEqual(state(d, i3.id), [400000, 0, "paid"]);
  assert.deepEqual(state(d, i4.id), [0, 300000, "unpaid"]);
  assert.equal(d.supplierDeposits.length, 1, "ONE payment transaction of 1,000,000");
  assert.equal(d.supplierPayments.length, 0, "not three separate cash payments");
  assert.equal(d.advanceAllocations.length, 3, "the allocation records say exactly which invoices were covered");
  assert.deepEqual(r.covered.map((c) => c.amount).sort((a, b) => a - b), [250000, 350000, 400000]);
  const history = P.supplierPaymentHistory(d, sid(d));
  assert.equal(history.length, 1, "the history lists the advance once");
  assert.deepEqual([history[0].kind, history[0].amount, history[0].method, history[0].reference, history[0].note, history[0].allocations.length, history[0].allocated], ["advance", 1000000, "bank", "VIR-1", "autumn", 3, 1000000]);
  const s = sum(d);
  assert.deepEqual([s.total, s.paid, s.applied, s.outstanding, s.unapplied, s.net], [1300000, 1000000, 1000000, 300000, 0, 300000]);
  audit(d);
});

test("3. an advance of 700,000 pays two invoices and part of the third", () => {
  const d = draft();
  const [i1, i2, i3, i4] = fourInvoices(d);
  advance(d, 700000);
  assert.deepEqual(state(d, i1.id), [250000, 0, "paid"]);
  assert.deepEqual(state(d, i2.id), [350000, 0, "paid"]);
  assert.deepEqual(state(d, i3.id), [100000, 300000, "partial"]);
  assert.deepEqual(state(d, i4.id), [0, 300000, "unpaid"]);
  assert.equal(sum(d).outstanding, 600000);
  audit(d);
});

test("the preview shows exactly what saving will do", () => {
  const d = draft();
  const [, , i3] = fourInvoices(d);
  const plan = P.previewAllocation(d, sid(d), 700000);
  assert.deepEqual(plan.rows.map((r) => [r.allocated, r.remaining]), [[250000, 0], [350000, 0], [100000, 300000], [0, 300000]]);
  assert.deepEqual([plan.allocated, plan.credit], [700000, 0]);
  assert.equal(d.advanceAllocations.length, 0, "a preview changes nothing");
  advance(d, 700000);
  assert.equal(inv(d, i3.id).advanceApplied, 100000);
});

test("4. an advance larger than every open invoice keeps the rest as unapplied credit", () => {
  const d = draft();
  const a = invoice(d, 200, 4);
  const b = invoice(d, 300, 3);
  const r = advance(d, 800000);
  assert.deepEqual([state(d, a.id)[2], state(d, b.id)[2]], ["paid", "paid"]);
  assert.deepEqual([r.allocated, r.credit], [500000, 300000]);
  const s = sum(d);
  assert.deepEqual([s.outstanding, s.unapplied, s.net, s.advance], [0, 300000, -300000, 300000]);
  assert.equal(d.supplierDeposits[0].amount, 800000, "the original payment is untouched");
  audit(d);
});

test("5. credit is used by itself when a new purchase is confirmed; a draft never uses it", () => {
  const d = draft();
  invoice(d, 200, 4);
  invoice(d, 300, 3);
  advance(d, 800000);
  const saved = P.saveDraft(d, { supplierId: sid(d), supplierInvoiceNumber: "FA-NEW", invoiceDate: day(0), lines: [{ productId: "p-tile", unit: "box", qty: "200", unitPrice: "1000" }] });
  assert.ok(saved.purchase, saved.error);
  assert.equal(sum(d).unapplied, 300000, "a draft consumes nothing");
  assert.equal(d.advanceAllocations.length, 2);
  const done = P.confirmPurchase(d, saved.purchase.id);
  assert.ok(done.purchase, done.error);
  assert.deepEqual(state(d, saved.purchase.id), [200000, 0, "paid"]);
  assert.equal(sum(d).unapplied, 100000, "100,000 of credit is left");
  assert.equal(done.allocations.length, 1);
  assert.equal(d.supplierPayments.length, 0);
  audit(d);
});

test("6. a new invoice bigger than the credit is partly covered", () => {
  const d = draft();
  invoice(d, 500, 4);
  advance(d, 800000);
  const n = invoice(d, 400, 0);
  assert.deepEqual(state(d, n.id), [300000, 100000, "partial"]);
  const s = sum(d);
  assert.deepEqual([s.unapplied, s.outstanding, s.net], [0, 100000, 100000]);
  audit(d);
});

test("7. several advances: each is one record, they are used oldest first, and the invoices fill up in order", () => {
  const d = draft();
  const big = invoice(d, 1000, 6);
  const a1 = advance(d, 300000, { date: day(-3) });
  const a2 = advance(d, 400000, { date: day(-2) });
  assert.equal(d.supplierDeposits.length, 2);
  assert.deepEqual(state(d, big.id), [700000, 300000, "partial"]);
  const next = invoice(d, 200, 1);
  assert.deepEqual(state(d, next.id), [0, 200000, "unpaid"], "the oldest invoice is settled first");
  const a3 = advance(d, 500000);
  assert.deepEqual(state(d, big.id), [1000000, 0, "paid"]);
  assert.deepEqual(state(d, next.id), [200000, 0, "paid"]);
  assert.equal(sum(d).unapplied, 0, "300,000 + 200,000 of the 500,000 were needed");
  assert.deepEqual(P.supplierPaymentHistory(d, sid(d)).map((x) => x.id), [a3.deposit.id, a2.deposit.id, a1.deposit.id], "newest first");
  assert.equal(P.supplierPaymentHistory(d, sid(d)).length, 3);
  audit(d);
});

test("8. direct payments and advances work together without counting the same money twice", () => {
  const d = draft();
  const [i1, i2] = fourInvoices(d);
  assert.ok(P.recordPayment(d, i1.id, { amount: "100000", date: day(0), method: "cash" }).payment);
  assert.deepEqual(state(d, i1.id), [100000, 150000, "partial"]);
  advance(d, 1000000);
  assert.equal(P.purchaseSummary(d.purchases.find((p) => p.id === i1.id), d.supplierPayments, day(0), d.advanceAllocations).advanceApplied, 150000, "only the 150,000 still owed on the oldest invoice");
  assert.deepEqual(state(d, i1.id), [250000, 0, "paid"]);
  assert.deepEqual(state(d, i2.id), [350000, 0, "paid"]);
  const s = sum(d);
  assert.deepEqual([s.paid, s.invoicePaid, s.deposited], [1100000, 100000, 1000000], "money paid = the cash payment + the advance");
  assert.equal(s.paid, P.moneyOutReport(d, "", "").paid);
  audit(d);
});

test("8b. an initial payment made when confirming and the credit together cover the invoice exactly once", () => {
  const d = draft();
  advance(d, 300000);
  const n = invoice(d, 400, 0, { initialPayment: { amount: "150000", date: day(0) } });
  assert.deepEqual(state(d, n.id), [400000, 0, "paid"]);
  assert.equal(inv(d, n.id).paidCash, 150000);
  assert.equal(inv(d, n.id).advanceApplied, 250000, "only what the cash did not cover");
  assert.equal(sum(d).unapplied, 50000);
  audit(d);
});

test("9. editing an advance recalculates its allocations", () => {
  const d = draft();
  const [i1, i2, i3] = fourInvoices(d);
  const r = advance(d, 700000);
  const x = r.deposit;
  // Larger: the extra 300,000 goes to the next open invoice.
  const up = P.updateDeposit(d, x.id, { amount: "1000000", date: x.date });
  assert.ok(up.deposit, up.error);
  assert.deepEqual(state(d, i3.id), [400000, 0, "paid"]);
  // Smaller than what was applied: the allocations are reversed (kept as history) and spread again.
  const down = P.updateDeposit(d, x.id, { amount: "300000", date: x.date });
  assert.ok(down.deposit, down.error);
  assert.deepEqual(state(d, i1.id), [250000, 0, "paid"]);
  assert.deepEqual(state(d, i2.id), [50000, 300000, "partial"]);
  assert.deepEqual(state(d, i3.id), [0, 400000, "unpaid"]);
  assert.ok(d.advanceAllocations.some((a) => a.status === "reversed"), "the earlier allocations stay as history");
  assert.equal(d.supplierDeposits.length, 1);
  assert.equal(x.history.length, 2, "both earlier amounts are kept");
  // Only the note changes: nothing moves.
  const before = JSON.stringify(d.advanceAllocations);
  P.updateDeposit(d, x.id, { amount: "300000", date: x.date, note: "just a note" });
  assert.equal(JSON.stringify(d.advanceAllocations), before);
  audit(d);
});

test("9b. voiding an advance reverses its allocations and the invoices are unpaid again; nothing is deleted", () => {
  const d = draft();
  const [i1, i2, i3] = fourInvoices(d);
  const x = advance(d, 700000).deposit;
  const v = P.voidDeposit(d, x.id, "paid twice");
  assert.ok(v.deposit, v.error);
  assert.deepEqual([state(d, i1.id)[2], state(d, i2.id)[2], state(d, i3.id)[2]], ["unpaid", "unpaid", "unpaid"]);
  assert.equal(d.supplierDeposits.length, 1);
  assert.equal(d.advanceAllocations.length, 3);
  assert.ok(d.advanceAllocations.every((a) => a.status === "reversed" && a.reverseReason));
  const s = sum(d);
  assert.deepEqual([s.paid, s.unapplied, s.outstanding], [0, 0, 1300000]);
  audit(d);
});

test("9c. voiding an advance frees its invoices for the credit of another advance", () => {
  const d = draft();
  const a = invoice(d, 100, 5);
  const first = advance(d, 100000);
  advance(d, 60000);
  assert.deepEqual([state(d, a.id)[2], sum(d).unapplied], ["paid", 60000]);
  P.voidDeposit(d, first.deposit.id, "mistake");
  assert.deepEqual(state(d, a.id), [60000, 40000, "partial"], "the other advance now covers the invoice");
  assert.equal(sum(d).unapplied, 0);
  audit(d);
});

test("9d. an edit or void that would leave refunds without money is refused and changes nothing", () => {
  const d = draft();
  const a = invoice(d, 100, 5);
  const x = advance(d, 150000).deposit;               // 100,000 applied, 50,000 credit
  assert.ok(P.recordDeposit(d, { supplierId: sid(d), kind: "refund", amount: "40000", date: day(0) }).deposit);
  const snapshot = JSON.stringify([d.supplierDeposits, d.advanceAllocations, d.purchases]);
  assert.ok(P.voidDeposit(d, x.id, "mistake").error);
  assert.ok(P.updateDeposit(d, x.id, { amount: "20000", date: x.date }).error);
  assert.equal(JSON.stringify([d.supplierDeposits, d.advanceAllocations, d.purchases]), snapshot, "nothing changed, not even the allocations");
  assert.equal(state(d, a.id)[2], "paid");
  audit(d);
});

test("9e. voiding or lowering a direct payment reopens the invoice, and credit the supplier holds is applied to it", () => {
  const d = draft();
  const a = invoice(d, 100, 5);
  const pay = P.recordPayment(d, a.id, { amount: "100000", date: day(0) }).payment;
  assert.equal(state(d, a.id)[2], "paid");
  const low = P.updatePayment(d, pay.id, { amount: "60000", date: day(0) });
  assert.ok(low.payment, low.error);
  assert.deepEqual(state(d, a.id), [60000, 40000, "partial"]);
  assert.ok(P.voidPayment(d, pay.id, "wrong").payment);
  assert.deepEqual(state(d, a.id), [0, 100000, "unpaid"]);
  // Now with credit: the supplier holds 80,000 for a later invoice, an older payment is voided.
  const b = invoice(d, 100, 1);
  const pay2 = P.recordPayment(d, b.id, { amount: "100000", date: day(0) }).payment;
  P.recordDeposit(d, { supplierId: sid(d), amount: "100000", date: day(0) });   // settles invoice a
  assert.deepEqual([state(d, a.id)[2], sum(d).unapplied], ["paid", 0]);
  P.recordDeposit(d, { supplierId: sid(d), amount: "80000", date: day(0) });
  assert.equal(sum(d).unapplied, 80000);
  assert.ok(P.voidPayment(d, pay2.id, "wrong invoice").payment);
  assert.deepEqual(state(d, b.id), [80000, 20000, "partial"]);
  assert.equal(sum(d).unapplied, 0);
  audit(d);
});

test("a payment can not be raised so that payments and an advance together exceed the invoice", () => {
  const d = draft();
  const a = invoice(d, 100, 5);
  const pay = P.recordPayment(d, a.id, { amount: "40000", date: day(0) }).payment;
  advance(d, 60000);
  assert.ok(P.updatePayment(d, pay.id, { amount: "50000", date: day(0) }).error);
  assert.equal(state(d, a.id)[2], "paid");
  audit(d);
});

test("10. reversing an allocation returns the money to the credit; the payment stays; applying credit puts it back", () => {
  const d = draft();
  const a = invoice(d, 100, 5);
  const x = advance(d, 100000).deposit;
  const r = P.reverseAllocation(d, d.advanceAllocations[0].id, "applied to the wrong invoice");
  assert.ok(r.allocation, r.error);
  assert.deepEqual(state(d, a.id), [0, 100000, "unpaid"]);
  assert.deepEqual([sum(d).unapplied, d.supplierDeposits[0].amount, d.supplierDeposits[0].id], [100000, 100000, x.id]);
  assert.equal(d.advanceAllocations.length, 1, "the allocation is kept as history");
  audit(d);
  const done = P.applyCredit(d, sid(d));
  assert.ok(!done.error, done.error);
  assert.deepEqual(state(d, a.id), [100000, 0, "paid"]);
  assert.equal(d.advanceAllocations.length, 2);
  assert.equal(P.applyCredit(d, sid(d)).error !== undefined, true, "nothing left to apply");
  audit(d);
});

test("11. cancelling a purchase that was paid by an advance returns the credit, which then covers the supplier's other open invoices", () => {
  const d = draft();
  const a = invoice(d, 100, 6);
  const b = invoice(d, 200, 5);
  advance(d, 100000);                                // pays a
  assert.deepEqual([state(d, a.id)[2], state(d, b.id)[2]], ["paid", "unpaid"]);
  const r = P.cancelPurchase(d, a.id, "entered twice");
  assert.ok(!r.error, r.error);
  assert.deepEqual(state(d, b.id), [100000, 100000, "partial"], "the 100,000 went to the next open invoice, nothing was lost");
  assert.equal(sum(d).unapplied, 0);
  assert.ok(d.advanceAllocations.some((x) => x.status === "reversed"));
  audit(d);
});

test("11b. deleting a purchase with allocations removes them and restores the credit", () => {
  const d = draft();
  const a = invoice(d, 100, 6);
  advance(d, 150000);
  assert.equal(sum(d).unapplied, 50000);
  const preview = P.deletionPreview(d, a.id);
  assert.equal(preview.advanceReturned, 100000);
  const r = P.deletePurchase(d, a.id);
  assert.ok(!r.error, r.error);
  assert.deepEqual([d.advanceAllocations.length, d.supplierDeposits.length, sum(d).unapplied, sum(d).net], [0, 1, 150000, -150000]);
  audit(d);
});

test("12. the supplier overview, the profile figures and the report agree", () => {
  const d = draft();
  const [i1] = fourInvoices(d);
  P.recordPayment(d, i1.id, { amount: "50000", date: day(0) });
  advance(d, 1500000);                                 // 1,300,000 - 50,000 = 1,250,000 applied; 250,000 credit
  const s = sum(d);
  assert.deepEqual([s.total, s.invoicePaid, s.deposited, s.paid, s.applied, s.outstanding, s.unapplied, s.net], [1300000, 50000, 1500000, 1550000, 1250000, 0, 250000, -250000]);
  const o = P.overview(d, day(0));
  assert.deepEqual([o.total, o.paid, o.outstanding, o.unapplied, o.advance, o.owed], [s.total, s.paid, s.outstanding, s.unapplied, s.advance, s.owed]);
  assert.equal(P.moneyOutReport(d, "", "").paid, s.paid);
  assert.equal(P.paymentsReport(d, "", "").total, 50000, "the payments report lists cash payments only");
  // A second supplier does not mix in.
  P.saveSupplier(d, { name: "Other", phone: "0555 99 99 99" });
  assert.equal(P.supplierPayable(d, d.suppliers[1].id, day(0)).paid, 0);
  audit(d);
});

test("13. data from before this change (payments without a method, deposits and allocations as stored) is read unchanged", () => {
  const d = draft();
  const a = invoice(d, 100, 3);
  const pay = P.recordPayment(d, a.id, { amount: "10000", date: day(0) }).payment;
  assert.equal("method" in pay, false, "a payment without a method has no method key");
  assert.equal(P.paymentProblem(P.normalizePayment({ ...pay })), "");
  assert.equal(P.paymentProblem({ ...pay, method: "bank" }), "");
  assert.ok(P.paymentProblem({ ...pay, method: "gold" }), "an unknown method is refused");
  const before = JSON.stringify(d.supplierPayments);
  assert.equal(JSON.stringify(d.supplierPayments.map((x) => P.normalizePayment(x))), before, "normalizing an old payment does not change it");
  advance(d, 20000);
  assert.deepEqual(state(d, a.id), [30000, 70000, "partial"]);
  // Old records with no helper lists at all.
  const old = draft();
  delete old.supplierDeposits; delete old.advanceAllocations;
  const b = invoice(old, 10, 1);
  assert.equal(P.settleSupplierCredit(old, sid(old)).amount, 0);
  assert.equal(state(old, b.id)[2], "unpaid");
});

test("14. nothing is counted twice: the same form sent again, settling again and a restore of the same data change no balance", () => {
  const d = draft();
  invoice(d, 100, 3);
  const input = { id: "form-1", supplierId: sid(d), amount: "60000", date: day(0) };
  const first = P.recordDeposit(d, input);
  const again = P.recordDeposit(d, input);
  assert.equal(again.already, true);
  assert.equal(d.supplierDeposits.length, 1);
  assert.equal(d.advanceAllocations.length, 1);
  const snapshot = JSON.stringify(d.advanceAllocations);
  assert.equal(P.settleSupplierCredit(d, sid(d)).allocations.length, 0, "settling again finds nothing to do");
  assert.equal(JSON.stringify(d.advanceAllocations), snapshot);
  assert.equal(sum(d).paid, 60000);
  assert.ok(first.deposit);
  audit(d);
});

test("a failed change leaves everything exactly as it was", () => {
  const d = draft();
  invoice(d, 100, 3);
  advance(d, 50000);
  const snapshot = JSON.stringify(d);
  assert.ok(P.recordDeposit(d, { supplierId: sid(d), amount: "-5", date: day(0) }).error);
  assert.ok(P.recordDeposit(d, { supplierId: sid(d), kind: "refund", amount: "1", date: day(0) }).error, "nothing unapplied to refund");
  assert.equal(JSON.stringify(d), snapshot);
});

/* ---------- storage and backup ---------- */

async function seeded() {
  const db = newDb();
  await db.initDatabase();
  const d0 = await db.loadAll();
  await db.commitChanges({ products: { put: [tile()] }, suppliers: { put: [P.normalizeSupplier({ id: "s-1", name: "Timgad", paymentTermsDays: 30, createdAt: new Date().toISOString() })] } });
  void d0;
  return db;
}

async function change(db, mutate) {
  const before = await db.loadAll();
  const after = JSON.parse(JSON.stringify(before));
  after.attachments = { put: [], remove: [] };
  const result = mutate(after);
  if (result && result.error) throw new Error(result.error);
  return db.commitChanges(db.diff ? db.diff(before, after) : db.changesBetween(before, after));
}

test("13b. one transaction saves the advance and its allocations; a backup restores them exactly, and an older backup still restores", async () => {
  const app = loadApp();
  const storage = await app.start();
  assert.equal(storage.mode, "ready", storage.reason);
  const commit = app.api.commit;
  assert.equal((await commit((d) => { d.products.push(tile()); })).error, undefined);
  assert.equal((await commit((d) => P.saveSupplier(d, { name: "Timgad", phone: "0555 12 34 56", paymentTermsDays: "30" }))).error, undefined);
  const sId = () => app.api.getState().suppliers[0].id;
  const buy = (thousands, ago) => commit((d) => {
    const saved = P.saveDraft(d, { supplierId: d.suppliers[0].id, supplierInvoiceNumber: "FA-" + ++invoiceSerial, invoiceDate: day(-ago), lines: [{ productId: "p-tile", unit: "box", qty: String(thousands), unitPrice: "1000" }] });
    return saved.error ? saved : P.confirmPurchase(d, saved.purchase.id);
  });
  assert.equal((await buy(250, 3)).error, undefined);
  assert.equal((await buy(350, 2)).error, undefined);
  const pay = await commit((d) => P.recordDeposit(d, { supplierId: d.suppliers[0].id, amount: "700000", date: day(0), method: "bank" }));
  assert.equal(pay.error, undefined, pay.error);
  const st = app.api.getState();
  assert.equal(st.supplierDeposits.length, 1);
  assert.equal(st.advanceAllocations.length, 2, "saved together with the deposit");
  assert.deepEqual(P.supplierPayable(st, sId(), day(0)).unapplied, 100000);

  const file = V.prepareBackupFile(st, new Date());
  assert.equal(file.error, undefined, file.error);
  const parsed = V.parseBackup(file.text);
  assert.equal(parsed.error, undefined, parsed.error);
  assert.deepEqual(parsed.data.advanceAllocations, st.advanceAllocations);
  const fresh = newDb();
  await fresh.initDatabase();
  const restored = await fresh.restore(parsed.data);
  assert.equal(restored.error, undefined, restored.error);
  const after = await fresh.loadAll();
  assert.deepEqual(after.supplierDeposits, st.supplierDeposits);
  assert.deepEqual(after.advanceAllocations, st.advanceAllocations);
  assert.deepEqual(P.supplierPayable(after, after.suppliers[0].id, day(0)), P.supplierPayable(st, sId(), day(0)));

  // An older backup: payments with no method key, no deposits, no allocations.
  const older = JSON.parse(JSON.stringify(parsed.data));
  older.supplierDeposits = []; older.advanceAllocations = [];
  older.supplierPayments = [P.normalizePayment({ id: "pay-old", purchaseId: older.purchases[0].id, supplierId: older.purchases[0].supplierId, amount: 1000, date: day(0), createdAt: new Date().toISOString(), status: "recorded" })];
  const oldDb = newDb();
  await oldDb.initDatabase();
  const oldRestored = await oldDb.restore(older);
  assert.equal(oldRestored.error, undefined, oldRestored.error);
  const loaded = await oldDb.loadAll();
  assert.equal("method" in loaded.supplierPayments[0], false);
  assert.equal(P.supplierPayable(loaded, loaded.suppliers[0].id, day(0)).invoicePaid, 1000);
});

/* ---------- the screens ---------- */

const ui = (app) => app.api.PurchasesUI;
const settle = () => new Promise((resolve) => setImmediate(resolve));

async function shop() {
  const app = loadApp();
  const storage = await app.start();
  assert.equal(storage.mode, "ready", storage.reason);
  assert.equal((await app.api.commit((d) => { d.products.push(tile()); })).error, undefined);
  assert.equal((await app.api.commit((d) => P.saveSupplier(d, { name: "Timgad Ceramic", phone: "0555 12 34 56", paymentTermsDays: "30" }))).error, undefined);
  return app;
}

async function openPayments(app) {
  app.api.getState().view = "suppliers";
  ui(app).reset();
  ui(app).openSupplier(app.api.getState().suppliers[0].id, "payments");
  app.api.renderAll();
  return app.field("suppliersRoot").innerHTML;
}

const buy = (app, thousands, ago) => app.api.commit((d) => {
  const saved = P.saveDraft(d, { supplierId: d.suppliers[0].id, supplierInvoiceNumber: "FA-" + ++invoiceSerial, invoiceDate: day(-ago), lines: [{ productId: "p-tile", unit: "box", qty: String(thousands), unitPrice: "1000" }] });
  return saved.error ? saved : P.confirmPurchase(d, saved.purchase.id);
});

function fill(app, values) {
  const v = { amount: "", date: day(0), method: "", reference: "", note: "", ...values };
  for (const [k, id] of [["amount", "spAmount"], ["date", "spDate"], ["method", "spMethod"], ["reference", "spRef"], ["note", "spNote"]]) app.field(id).value = v[k];
}

test("screen: the supplier profile has one Payments tab and no Deposits tab", async () => {
  const app = await shop();
  const html = await openPayments(app);
  assert.ok(!/data-tab="deposits"/.test(html), "no separate Deposits tab");
  assert.match(html, /data-tab="payments"/);
  assert.match(html, /Pay a specific invoice/);
  assert.match(html, /Pay the supplier \(automatic allocation\)/);
  assert.match(html, /id="spMethod"/);
  assert.match(html, /id="spNote"/);
});

test("screen: the invoice choice lists total, paid and remaining of each open invoice, oldest first", async () => {
  const app = await shop();
  const a = await buy(app, 250, 5);
  await buy(app, 100, 9);
  assert.equal(a.error, undefined);
  await app.api.commit((d) => P.recordPayment(d, a.purchase.id, { amount: "50000", date: day(0) }));
  const html = await openPayments(app);
  assert.match(html, /id="spInv-/);
  assert.match(html, /250,000 DA/);
  assert.match(html, /50,000 DA/);
  assert.match(html, /200,000 DA/);
  const first = html.indexOf("100,000 DA");
  assert.ok(first > -1 && first < html.indexOf("200,000 DA"), "the older invoice is listed first");
});

test("screen: one supplier payment covers several invoices, is ONE row in the history, and keeps its allocation details", async () => {
  const app = await shop();
  const i1 = await buy(app, 250, 6);
  await buy(app, 350, 5);
  await buy(app, 400, 4);
  await openPayments(app);
  fill(app, { amount: "700000", method: "bank", reference: "VIR-7", note: "advance for autumn" });
  await ui(app).forms["sup-pay"]();
  await settle();
  const st = app.api.getState();
  assert.equal(st.supplierDeposits.length, 1);
  assert.equal(st.supplierPayments.length, 0);
  assert.equal(st.advanceAllocations.length, 3);
  assert.equal(P.purchaseSummary(st.purchases.find((p) => p.id === i1.purchase.id), st.supplierPayments, day(0), st.advanceAllocations).paymentStatus, "paid");
  const html = await openPayments(app);
  assert.match(html, /VIR-7/);
  assert.match(html, /advance for autumn/);
  assert.match(html, /Covered 3 invoice\(s\): 700,000 DA/);
  assert.match(html, /Allocation details/);
  assert.equal((html.match(/700,000 DA/g) || []).length >= 1, true);
});

test("screen: paying a named invoice records a direct payment with its method, never above the balance", async () => {
  const app = await shop();
  const b = await buy(app, 100, 3);
  await openPayments(app);
  app.field("spMode-invoice").checked = true;
  app.field("spInv-" + b.purchase.id).checked = true;
  fill(app, { amount: "150000" });
  await ui(app).forms["sup-pay"]();
  await settle();
  assert.match(app.errorText("spError"), /100,000|at most|more than/i);
  assert.equal(app.api.getState().supplierPayments.length, 0);
  fill(app, { amount: "40000", method: "cheque", reference: "CH-1" });
  await ui(app).forms["sup-pay"]();
  await settle();
  const pays = app.api.getState().supplierPayments;
  assert.equal(pays.length, 1);
  assert.deepEqual([pays[0].amount, pays[0].method, pays[0].reference], [40000, "cheque", "CH-1"]);
  assert.equal(app.api.getState().supplierDeposits.length, 0);
  const html = await openPayments(app);
  assert.match(html, /CH-1/);
  assert.match(html, /Cheque/);
});

test("screen: an advance with no open invoice is kept as credit and shown as such", async () => {
  const app = await shop();
  await openPayments(app);
  fill(app, { amount: "80000" });
  await ui(app).forms["sup-pay"]();
  await settle();
  const html = await openPayments(app);
  assert.match(html, /80,000 DA still unapplied/);
  assert.match(html, /No invoice covered yet/);
});

test("screen: confirming a purchase from the purchase page uses the credit by itself and the invoice page says where it came from", async () => {
  const app = await shop();
  await app.api.commit((d) => P.recordDeposit(d, { supplierId: d.suppliers[0].id, amount: "300000", date: day(-1), method: "bank", reference: "VIR-3" }));
  const drafted = await app.api.commit((d) => P.saveDraft(d, { supplierId: d.suppliers[0].id, supplierInvoiceNumber: "FA-Z", invoiceDate: day(0), lines: [{ productId: "p-tile", unit: "box", qty: "400", unitPrice: "1000" }] }));
  const id = drafted.purchase.id;
  app.api.getState().view = "purchases";
  ui(app).openPurchase(id);
  ui(app).state.pur.open = "confirm";
  app.api.renderAll();
  assert.match(app.field("purchasesRoot").innerHTML, /300,000 DA is applied to this purchase automatically/);
  app.field("dc-receive").checked = true;
  app.field("dc-rdate").value = day(0);
  app.field("dc-pamount").value = ""; app.field("dc-pdate").value = day(0); app.field("dc-pref").value = "";
  await ui(app).forms["pur-confirm"]();
  await settle();
  const st = app.api.getState();
  const s = P.purchaseSummary(st.purchases[0], st.supplierPayments, day(0), st.advanceAllocations);
  assert.deepEqual([s.paid, s.outstanding, s.paymentStatus], [300000, 100000, "partial"]);
  ui(app).openPurchase(id);
  app.api.renderAll();
  const page = app.field("purchasesRoot").innerHTML;
  assert.match(page, /300,000 DA from advance/);
  assert.match(page, /VIR-3/, "the advance's reference is shown with the allocation");
});

test("screen: every new text exists in English, French and Arabic", () => {
  const keys = ["spay.title", "spay.mode.invoice", "spay.mode.advance", "spay.mode.refund", "spay.mode.invoiceHelp", "spay.mode.advanceHelp", "spay.mode.refundHelp",
    "spay.noOpenInvoices", "spay.pickInvoice", "spay.payFullShort", "spay.afterInvoice", "spay.refundNote", "spay.preview.title", "spay.preview.none", "spay.preview.credit",
    "spay.remainingShort", "spay.advanceDone", "spay.advanceDoneNone", "spay.col.for", "spay.col.details", "spay.for.advance", "spay.for.refund", "spay.covered", "spay.coveredNone",
    "spay.allocDetails", "dep.voidAllocNote", "adv.reason.depositEdited", "adv.reason.depositVoided", "adv.err.noCredit", "adv.err.noOpenInvoices", "adv.applyCredit",
    "adv.creditApplied", "adv.autoNote", "adv.autoRow", "fin.allocated", "fin.unappliedCredit"];
  for (const lang of ["en", "fr", "ar"]) {
    I18n.setLanguage(lang);
    for (const k of keys) {
      const text = I18n.t(k, { amount: "1", n: 1, allocated: "1", credit: "1", use: "1", reason: "x" });
      assert.ok(text && text !== k, `${lang}: ${k} is missing`);
    }
  }
  I18n.setLanguage("en");
});

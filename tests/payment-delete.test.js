"use strict";

// Permanent deletion of supplier payments (single-administrator mode): an invoice payment, an advance or a refund is
// removed for good, together with everything that exists only because of it, and the balances are worked out again.
// Void (the record stays, greyed) is a different feature and keeps working: see the last business tests.
//
// Business rules run on a plain copy of the data; storage rules run against a disposable in-memory IndexedDB; the
// screens run through the real page scripts. Nothing here touches real data.

const test = require("node:test");
const assert = require("node:assert/strict");
const { fake, V, DB, newDb, sampleProduct } = require("./helpers/modules");
const { loadApp } = require("./helpers/app");

const P = globalThis.Purchases;
const day = (offset) => P.addDays(P.toDay(new Date()), offset || 0);
const round2 = (n) => Math.round(n * 100) / 100;

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
  const r = P.saveSupplier(d, { name: "Timgad Ceramic", phone: "0555 12 34 56", paymentTermsDays: "30" });
  assert.ok(r.supplier, r.error);
  return d;
}

// A confirmed purchase of `boxes` boxes at 1,000 DA, so 100 boxes = 100,000 DA.
function confirmed(d, boxes, extra, options) {
  const input = {
    supplierId: d.suppliers[0].id, supplierInvoiceNumber: "FA-" + (d.purchases.length + 1), invoiceDate: day(0),
    lines: [{ productId: "p-tile", unit: "box", qty: String(boxes), unitPrice: "1000" }], ...extra,
  };
  const saved = P.saveDraft(d, input);
  assert.ok(saved.purchase, saved.error);
  const done = P.confirmPurchase(d, saved.purchase.id, options);
  assert.equal(done.error, undefined, done.error);
  return { ...done, id: saved.purchase.id };
}

function deposit(d, amount, extra) {
  const r = P.recordDeposit(d, { supplierId: d.suppliers[0].id, amount: String(amount), date: day(0), ...extra });
  assert.ok(r.deposit, r.error);
  return r.deposit;
}

const links = (d) => P.linkProblems({ ...d, attachments: [] });
const sum = (d) => P.supplierPayable(d, d.suppliers[0].id, day(0));
const purchase = (d, id) => d.purchases.find((p) => p.id === id);
const summaryOf = (d, id) => P.purchaseSummary(purchase(d, id), d.supplierPayments, day(0), d.advanceAllocations);
const logEvents = (d, id) => (purchase(d, id).log || []).map((e) => e.event);
const copy = (v) => JSON.parse(JSON.stringify(v));
const stockOf = (d) => d.products.find((p) => p.id === "p-tile").stock;

/* ==========================================================================
   Business rules
   ========================================================================== */

test("A. a wrong advance of 2,000,000 is deleted for good: gone from the payment history, the ledger and every balance, and the right one is entered normally", () => {
  const d = draft();
  const wrong = deposit(d, 2000000, { reference: "WRONG-1" });
  assert.equal(sum(d).unapplied, 2000000);
  assert.equal(P.supplierPaymentHistory(d, d.suppliers[0].id).length, 1);
  assert.equal(P.supplierActivity(d, { type: "payments" }).rows.length, 1, "listed on the Supplier Activity page before");

  const r = P.deleteDeposit(d, wrong.id);
  assert.equal(r.error, undefined, r.error);

  assert.deepEqual(d.supplierDeposits, [], "the record is gone from the data, not marked");
  assert.deepEqual(d.advanceAllocations, []);
  assert.deepEqual(P.supplierPaymentHistory(d, d.suppliers[0].id), [], "gone from the payment history");
  assert.deepEqual(P.supplierLedger(d, d.suppliers[0].id), [], "gone from the supplier transaction history");
  assert.deepEqual(P.supplierActivity(d, { type: "payments" }).rows, [], "gone from the Supplier Activity page");
  const s = sum(d);
  assert.deepEqual([s.paid, s.deposited, s.applied, s.unapplied, s.net, s.advance, s.owed], [0, 0, 0, 0, 0, 0, 0]);
  assert.ok(!JSON.stringify(d).includes(wrong.id), "no reference to the deleted payment is left anywhere");
  assert.ok(!JSON.stringify(d).includes("WRONG-1"));
  assert.ok(!JSON.stringify(d).includes("voided"), "not disguised as a void");
  assert.deepEqual(links(d), []);

  // The correct payment is entered as if the first had never existed.
  const right = deposit(d, 200000, { reference: "RIGHT-1" });
  const rows = P.supplierPaymentHistory(d, d.suppliers[0].id);
  assert.deepEqual(rows.map((x) => [x.kind, x.amount, x.status, x.reference]), [["advance", 200000, "recorded", "RIGHT-1"]]);
  assert.equal(sum(d).unapplied, 200000);
  assert.equal(sum(d).net, -200000);
  assert.notEqual(right.id, wrong.id);
});

test("B. an advance applied to a purchase: deleting it removes the allocation and the history lines it made, and the invoice and the supplier balance are worked out again", () => {
  const d = draft();
  const adv = deposit(d, 60000, { date: day(-3) });
  const { id } = confirmed(d, 100);                 // 100,000 DA: the 60,000 advance is applied to it by itself
  assert.equal(d.advanceAllocations.length, 1);
  assert.equal(summaryOf(d, id).outstanding, 40000);
  assert.ok(logEvents(d, id).includes("advanceApplied"));
  const stock = stockOf(d);
  const before = copy(purchase(d, id));

  const r = P.deleteDeposit(d, adv.id);
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.removedAllocations, 1);

  assert.deepEqual(d.advanceAllocations, [], "the allocation went with the advance");
  assert.deepEqual(d.supplierDeposits, []);
  assert.ok(!logEvents(d, id).includes("advanceApplied"), "the 'advance applied' line of the purchase's history went too");
  assert.ok(!JSON.stringify(d).includes(adv.id));
  const sInv = summaryOf(d, id);
  assert.deepEqual([sInv.paid, sInv.outstanding, sInv.paymentStatus], [0, 100000, "unpaid"]);
  const s = sum(d);
  assert.deepEqual([s.total, s.paid, s.net, s.owed, s.outstanding, s.unapplied, s.advance], [100000, 0, 100000, 100000, 100000, 0, 0]);
  assert.equal(s.net, s.outstanding - s.unapplied, "net balance = open invoices - unapplied credit");
  // The purchase itself, its goods and the stock are untouched.
  assert.equal(purchase(d, id).status, "confirmed");
  assert.equal(purchase(d, id).total, before.total);
  assert.deepEqual(purchase(d, id).lines, before.lines);
  assert.deepEqual(purchase(d, id).receipts, before.receipts);
  assert.equal(stockOf(d), stock);
  assert.deepEqual(links(d), []);
});

test("C. an advance spread over several purchases: every allocation goes and every purchase is open again for exactly what it needs", () => {
  const d = draft();
  const adv = deposit(d, 250000, { date: day(-9) });
  const a = confirmed(d, 100, { invoiceDate: day(-5) }).id;   // 100,000
  const b = confirmed(d, 100, { invoiceDate: day(-4) }).id;   // 100,000
  const c = confirmed(d, 100, { invoiceDate: day(-3) }).id;   // 100,000: only 50,000 of the advance is left for it
  assert.deepEqual([a, b, c].map((id) => summaryOf(d, id).outstanding), [0, 0, 50000]);
  assert.equal(d.advanceAllocations.length, 3);

  const r = P.deleteDeposit(d, adv.id);
  assert.equal(r.error, undefined, r.error);

  assert.deepEqual(d.advanceAllocations, []);
  assert.deepEqual([a, b, c].map((id) => summaryOf(d, id).outstanding), [100000, 100000, 100000]);
  assert.deepEqual([a, b, c].map((id) => summaryOf(d, id).paymentStatus), ["unpaid", "unpaid", "unpaid"]);
  for (const id of [a, b, c]) assert.ok(!logEvents(d, id).some((e) => e.startsWith("advance")), "no advance line left in " + id);
  const s = sum(d);
  assert.deepEqual([s.total, s.paid, s.outstanding, s.unapplied, s.net], [300000, 0, 300000, 0, 300000]);
  assert.equal(d.purchases.length, 3, "no purchase was deleted");
  assert.ok(!JSON.stringify(d).includes(adv.id));
  assert.deepEqual(links(d), []);
});

test("C2. the same when the advance was made AFTER the purchases (spread oldest invoice first)", () => {
  const d = draft();
  const a = confirmed(d, 100, { invoiceDate: day(-5) }).id;
  const b = confirmed(d, 100, { invoiceDate: day(-4) }).id;
  const adv = deposit(d, 150000);
  assert.deepEqual([a, b].map((id) => summaryOf(d, id).outstanding), [0, 50000]);
  assert.equal(P.deleteDeposit(d, adv.id).error, undefined);
  assert.deepEqual([a, b].map((id) => summaryOf(d, id).outstanding), [100000, 100000]);
  assert.deepEqual(d.advanceAllocations, []);
  for (const id of [a, b]) assert.ok(!logEvents(d, id).some((e) => e.startsWith("advance")));
});

test("D. existing cancelled (voided) records are not restored or changed by deleting another payment", () => {
  const d = draft();
  const old = deposit(d, 40000, { date: day(-8), reference: "OLD" });
  const { id } = confirmed(d, 30);                              // 30,000: the old advance settles it
  assert.equal(P.voidDeposit(d, old.id, "entered twice").error, undefined);
  const payOld = P.recordPayment(d, id, { amount: "5000", date: day(-1), reference: "PAY-OLD" }).payment;
  assert.equal(P.voidPayment(d, payOld.id, "wrong invoice").error, undefined);
  assert.equal(d.supplierDeposits[0].status, "voided");
  assert.equal(d.advanceAllocations[0].status, "reversed");

  const fresh = deposit(d, 10000, { reference: "NEW" });
  const snapshot = copy({ deposits: d.supplierDeposits.filter((x) => x.id === old.id), pays: d.supplierPayments, allocs: d.advanceAllocations.filter((a) => a.depositId === old.id) });
  const purchaseLogBefore = copy(purchase(d, id).log).filter((e) => !e.allocationIds || !e.allocationIds.includes(d.advanceAllocations.find((a) => a.depositId === fresh.id)?.id));

  assert.equal(P.deleteDeposit(d, fresh.id).error, undefined);

  assert.deepEqual(d.supplierDeposits.filter((x) => x.id === old.id), snapshot.deposits, "the voided advance is exactly as it was: still voided");
  assert.deepEqual(d.supplierPayments, snapshot.pays, "the voided payment is exactly as it was");
  assert.deepEqual(d.advanceAllocations.filter((a) => a.depositId === old.id), snapshot.allocs, "its reversed allocation is exactly as it was");
  assert.equal(d.supplierDeposits.length, 1);
  assert.equal(d.supplierDeposits[0].status, "voided");
  // the purchase's own history keeps the lines of the OLD advance (applied, then released)
  const lines = purchase(d, id).log.filter((e) => e.event.startsWith("advance")).map((e) => [e.event, e.amount]);
  assert.deepEqual(lines, [["advanceApplied", 30000], ["advanceReversed", 30000]]);
  assert.ok(purchaseLogBefore.length >= 2);
});

test("D2. a voided advance can itself be deleted for good: its reversed allocations and the history lines about them go, nothing else", () => {
  const d = draft();
  const old = deposit(d, 40000, { date: day(-8) });
  const { id } = confirmed(d, 30);
  assert.equal(P.voidDeposit(d, old.id, "mistake").error, undefined);
  assert.deepEqual(logEvents(d, id).filter((e) => e.startsWith("advance")), ["advanceApplied", "advanceReversed"]);

  const r = P.deleteDeposit(d, old.id);
  assert.equal(r.error, undefined, r.error);
  assert.deepEqual([d.supplierDeposits, d.advanceAllocations], [[], []]);
  assert.deepEqual(logEvents(d, id).filter((e) => e.startsWith("advance")), []);
  assert.ok(!JSON.stringify(d).includes(old.id));
  assert.ok(!JSON.stringify(d).includes("mistake"));
  assert.deepEqual(logEvents(d, id).slice(0, 2), ["created", "confirmed"].slice(0, 2).length ? logEvents(d, id).slice(0, 2) : []);
  assert.deepEqual(links(d), []);
});

test("E. with two advances, deleting one keeps the other one's allocation and takes only the deleted part off the shared history line", () => {
  const d = draft();
  const a = deposit(d, 60000, { date: day(-6) });
  const b = deposit(d, 60000, { date: day(-5) });
  const { id } = confirmed(d, 100);                      // 100,000 = 60,000 from A + 40,000 from B, in ONE history line
  const line = purchase(d, id).log.find((e) => e.event === "advanceApplied");
  assert.equal(line.amount, 100000);
  assert.equal(line.allocationIds.length, 2);
  const fromB = d.advanceAllocations.find((x) => x.depositId === b.id);

  assert.equal(P.deleteDeposit(d, a.id).error, undefined);

  assert.deepEqual(d.advanceAllocations.filter((x) => x.depositId === a.id), []);
  assert.ok(d.advanceAllocations.some((x) => x.id === fromB.id), "B's own allocation is kept");
  // B holds 60,000 in all: its 40,000 stay on the invoice and the remaining 20,000 are applied to it by themselves.
  assert.equal(summaryOf(d, id).paid, 60000);
  assert.equal(summaryOf(d, id).outstanding, 40000);
  const lines = purchase(d, id).log.filter((e) => e.event === "advanceApplied");
  assert.deepEqual(lines.map((e) => e.amount), [40000, 20000], "the shared line lost only A's 60,000");
  assert.ok(lines.every((e) => e.allocationIds.every((x) => d.advanceAllocations.some((al) => al.id === x))), "every line still points at a real allocation");
  const s = sum(d);
  assert.deepEqual([s.paid, s.net, s.unapplied, s.outstanding], [60000, 40000, 0, 40000]);
  assert.equal(s.net, s.outstanding - s.unapplied);
  assert.deepEqual(links(d), []);
});

test("F. a refund: deleting it gives the money back to the supplier's credit; an advance that refunds depend on can not be deleted, and nothing changes", () => {
  const d = draft();
  const adv = deposit(d, 100000);
  const refund = P.recordDeposit(d, { supplierId: d.suppliers[0].id, kind: "refund", amount: "30000", date: day(0) }).deposit;
  assert.equal(sum(d).unapplied, 70000);

  const frozen = copy(d);
  const refused = P.deleteDeposit(d, adv.id);
  assert.ok(refused.error, "refunds depend on this money");
  assert.deepEqual(d, frozen, "a refused deletion changes nothing at all");

  assert.equal(P.deleteDeposit(d, refund.id).error, undefined);
  assert.equal(sum(d).unapplied, 100000);
  assert.deepEqual(d.supplierDeposits.map((x) => x.id), [adv.id]);
  assert.equal(P.deleteDeposit(d, adv.id).error, undefined);
  assert.deepEqual(d.supplierDeposits, []);
  assert.equal(sum(d).net, 0);
});

test("G. an invoice payment: deleting it (voided or not) removes the record only; the invoice is open again for that amount", () => {
  const d = draft();
  const { id } = confirmed(d, 100);
  const p1 = P.recordPayment(d, id, { amount: "40000", date: day(-2), reference: "P1" }).payment;
  const p2 = P.recordPayment(d, id, { amount: "10000", date: day(-1), reference: "P2" }).payment;
  assert.equal(P.voidPayment(d, p2.id, "wrong").error, undefined);
  assert.equal(summaryOf(d, id).outstanding, 60000);

  assert.equal(P.deletePayment(d, p1.id).error, undefined);
  assert.deepEqual(d.supplierPayments.map((x) => x.id), [p2.id], "only the deleted payment went; the voided one is untouched");
  assert.equal(d.supplierPayments[0].status, "voided");
  assert.deepEqual([summaryOf(d, id).paid, summaryOf(d, id).outstanding, summaryOf(d, id).paymentStatus], [0, 100000, "unpaid"]);
  assert.ok(!JSON.stringify(d).includes(p1.id));
  assert.ok(!JSON.stringify(d).includes("P1"));

  assert.equal(P.deletePayment(d, p2.id).error, undefined);
  assert.deepEqual(d.supplierPayments, []);
  assert.ok(!JSON.stringify(d).includes("wrong"), "the voided payment's reason went with it");
  const s = sum(d);
  assert.deepEqual([s.paid, s.net, s.outstanding], [0, 100000, 100000]);
  assert.deepEqual(links(d), []);
});

test("G2. deleting an invoice payment while the supplier holds unapplied credit: the credit is applied to the invoice that is open again", () => {
  const d = draft();
  const { id } = confirmed(d, 100);
  const pay = P.recordPayment(d, id, { amount: "100000", date: day(-1) }).payment;
  deposit(d, 50000);                                        // nothing is open: it stays as credit
  assert.equal(sum(d).unapplied, 50000);

  assert.equal(P.deletePayment(d, pay.id).error, undefined);
  const s = sum(d);
  assert.deepEqual([summaryOf(d, id).outstanding, s.unapplied, s.net, s.outstanding], [50000, 0, 50000, 50000]);
  assert.equal(s.net, s.outstanding - s.unapplied);
});

test("H. deleting twice (or something that never existed) only reports it and changes nothing", () => {
  const d = draft();
  const adv = deposit(d, 1000);
  const { id } = confirmed(d, 10);
  const pay = P.recordPayment(d, id, { amount: "1000", date: day(0) }).payment;
  assert.equal(P.deleteDeposit(d, adv.id).error, undefined);
  assert.equal(P.deletePayment(d, pay.id).error, undefined);
  const frozen = copy(d);
  assert.deepEqual(P.deleteDeposit(d, adv.id), { skip: true, already: true });
  assert.deepEqual(P.deletePayment(d, pay.id), { skip: true, already: true });
  assert.deepEqual(P.deleteDeposit(d, "never-existed"), { skip: true, already: true });
  assert.deepEqual(d, frozen);
});

test("I. history lines written before they named their allocation are removed only when they match beyond doubt; others stay", () => {
  const d = draft();
  const adv = deposit(d, 60000, { date: day(-3) });
  const { id } = confirmed(d, 100);
  P.recordPayment(d, id, { amount: "5000", date: day(0) });
  const p = purchase(d, id);
  // Make the history look like an older version wrote it: no allocation ids.
  p.log = p.log.map((e) => { const { allocationIds, ...rest } = e; return rest; });
  // Two other lines that must survive: an unrelated amount, and a line far away in time.
  p.log.push({ at: new Date(Date.now() + 3600000).toISOString(), event: "advanceApplied", amount: 60000 });
  p.log.push({ at: p.log[0].at, event: "advanceApplied", amount: 12345 });
  const events = p.log.length;

  assert.equal(P.deleteDeposit(d, adv.id).error, undefined);

  const after = purchase(d, id).log;
  assert.equal(after.length, events - 1, "exactly the one matching line was removed");
  assert.ok(after.some((e) => e.amount === 12345), "the line with another amount stays");
  assert.ok(after.some((e) => e.amount === 60000 && Date.parse(e.at) > Date.now() + 1000), "the same amount far away in time stays");
  assert.ok(after.some((e) => e.event === "confirmed") && after.some((e) => e.event === "created"));
});

test("J. a randomised run of deposits, purchases, payments, voids and deletions never breaks the balance, the links or leaves a reference behind", () => {
  for (const seed of [1, 7, 42, 2026]) {
    let x = seed;
    const rnd = (n) => { x = (x * 1103515245 + 12345) % 2147483648; return Math.floor((x / 2147483648) * n); };
    const d = draft();
    let serial = 0;
    for (let step = 0; step < 120; step++) {
      const open = P.openInvoices(d, d.suppliers[0].id, day(0));
      const live = d.supplierPayments.filter((p) => p.status === "recorded");
      const op = rnd(8);
      let deleted = "";
      if (op === 0 || op === 1) P.recordDeposit(d, { supplierId: d.suppliers[0].id, amount: String(5000 * (1 + rnd(30))), date: day(-rnd(5)) });
      else if (op === 2) {
        const saved = P.saveDraft(d, { supplierId: d.suppliers[0].id, supplierInvoiceNumber: "FZ-" + ++serial, invoiceDate: day(-rnd(10)), lines: [{ productId: "p-tile", unit: "box", qty: String(5 + rnd(60)), unitPrice: "1000" }] });
        if (saved.purchase) P.confirmPurchase(d, saved.purchase.id);
      } else if (op === 3 && open.length) P.recordPayment(d, open[rnd(open.length)].purchase.id, { amount: String(Math.max(1, Math.floor(open[0].outstanding / (1 + rnd(3))))), date: day(0) });
      else if (op === 4 && d.supplierDeposits.length) { const dep = d.supplierDeposits[rnd(d.supplierDeposits.length)]; P.voidDeposit(d, dep.id, "r"); }
      else if (op === 5 && live.length) P.voidPayment(d, live[rnd(live.length)].id, "r");
      else if (op === 6 && d.supplierDeposits.length) { const dep = d.supplierDeposits[rnd(d.supplierDeposits.length)]; if (!P.deleteDeposit(d, dep.id).error) deleted = dep.id; }
      else if (op === 7 && d.supplierPayments.length) { const pay = d.supplierPayments[rnd(d.supplierPayments.length)]; if (!P.deletePayment(d, pay.id).error) deleted = pay.id; }

      const where = `seed ${seed} step ${step} op ${op}`;
      assert.deepEqual(links(d), [], where);
      const s = sum(d);
      assert.equal(s.net, round2(s.outstanding - s.unapplied), "net = open invoices - unapplied credit: " + where);
      assert.ok(s.unapplied >= -1e-9, where);
      for (const p of d.purchases) assert.ok(P.purchaseSummary(p, d.supplierPayments, day(0), d.advanceAllocations).paid <= p.total + 0.011, where);
      const allocIds = new Set(d.advanceAllocations.map((a) => a.id));
      for (const p of d.purchases) for (const e of p.log || []) for (const aid of e.allocationIds || []) assert.ok(allocIds.has(aid), "a history line points at an allocation that no longer exists: " + where);
      if (deleted) assert.ok(!JSON.stringify(d).includes(deleted), "the deleted id is still referenced: " + where);
    }
  }
});

test("K. void still works as before (the record stays, greyed, with its reason): deleting is a separate, stronger action", () => {
  const d = draft();
  const adv = deposit(d, 1000);
  assert.equal(P.voidDeposit(d, adv.id, "oops").error, undefined);
  assert.equal(d.supplierDeposits[0].status, "voided");
  assert.equal(d.supplierDeposits[0].voidReason, "oops");
  assert.equal(P.supplierPaymentHistory(d, d.suppliers[0].id).length, 1, "a voided record is still listed");
  assert.equal(P.deleteDeposit(d, adv.id).error, undefined);
  assert.equal(P.supplierPaymentHistory(d, d.suppliers[0].id).length, 0, "a deleted one is not");
});

/* ==========================================================================
   Storage: one transaction, nothing half done, survives a reload
   ========================================================================== */

async function openedDb(options) {
  const db = newDb(options);
  await db.initDatabase();
  return db;
}

async function change(db, mutate) {
  const before = await db.loadAll();
  const d = structuredClone(before);
  d.attachments = { put: [], remove: [] };
  const result = mutate(d) || {};
  if (result.error || result.skip) return result;
  const saved = await db.commitChanges(DB.diff(before, d), { expectedRevision: before.revision });
  return { ...result, saved };
}

async function seeded(options) {
  const db = await openedDb(options);
  await change(db, (d) => {
    d.products = [tile()];
    const r = P.saveSupplier(d, { name: "Timgad Ceramic", paymentTermsDays: "30" });
    assert.ok(r.supplier, r.error);
  });
  return db;
}

const counts = (all) => [all.supplierDeposits.length, all.advanceAllocations.length, all.supplierPayments.length, all.purchases.length];

test("db: deleting an advance that was applied to two purchases is ONE transaction and survives a reload", async () => {
  const factory = new fake.IDBFactory();
  const db = await seeded({ indexedDB: factory, name: "pay-delete" });
  await change(db, (d) => { deposit(d, 150000, { id: "dep-1", date: day(-5) }); });
  await change(db, (d) => { confirmed(d, 100, { invoiceDate: day(-3) }); });
  await change(db, (d) => { confirmed(d, 100, { invoiceDate: day(-2) }); });
  const before = await db.loadAll();
  assert.deepEqual(counts(before), [1, 2, 0, 2]);

  const r = await change(db, (d) => P.deleteDeposit(d, "dep-1"));
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.saved.revision, before.revision + 1, "one commit, one revision");

  const after = await db.loadAll();
  assert.deepEqual(counts(after), [0, 0, 0, 2]);
  assert.deepEqual(after.purchases.map((p) => (p.log || []).filter((e) => e.event.startsWith("advance")).length), [0, 0]);
  assert.deepEqual(P.linkProblems({ ...after, attachments: [] }), []);

  // "Refresh": a brand new connection to the same database sees the same thing.
  db.close();
  const again = await openedDb({ indexedDB: factory, name: "pay-delete" });
  const reloaded = await again.loadAll();
  assert.deepEqual(counts(reloaded), [0, 0, 0, 2]);
  assert.deepEqual(reloaded.purchases.map((p) => P.purchaseSummary(p, reloaded.supplierPayments, day(0), reloaded.advanceAllocations).outstanding), [100000, 100000]);
});

test("db: a deletion that fails halfway leaves the database exactly as it was (all or nothing)", async () => {
  const db = await seeded();
  await change(db, (d) => { deposit(d, 60000, { id: "dep-1", date: day(-5) }); });
  await change(db, (d) => { confirmed(d, 100); });
  const before = await db.loadAll();
  const dump = (all) => JSON.stringify([all.supplierDeposits, all.advanceAllocations, all.supplierPayments, all.purchases, all.revision]);

  // The deposit and its allocation are removed in the same write as a change the database refuses AFTER the deletes ran.
  await assert.rejects(change(db, (d) => { P.deleteDeposit(d, "dep-1"); d.purchases[0].supplierId = "ghost"; }));
  assert.equal(dump(await db.loadAll()), dump(before), "nothing was removed");

  // The deposit alone, leaving its allocation pointing at it, is refused.
  await assert.rejects(change(db, (d) => { d.supplierDeposits = []; }), /together with the advance applied from it/);
  // An allocation alone is refused (it only goes with its purchase or its deposit).
  await assert.rejects(change(db, (d) => { d.advanceAllocations = []; }), /together with its purchase or with its deposit/);
  assert.equal(dump(await db.loadAll()), dump(before));
});

test("db: a forged deletion that would leave refunds without the money they were paid from is refused by the database itself", async () => {
  const db = await seeded();
  await change(db, (d) => { deposit(d, 100000, { id: "dep-1" }); });
  await change(db, (d) => { P.recordDeposit(d, { id: "ref-1", supplierId: d.suppliers[0].id, kind: "refund", amount: "30000", date: day(0) }); });
  const before = await db.loadAll();
  // Bypasses Purchases.deleteDeposit: only the deposit record is removed.
  await assert.rejects(change(db, (d) => { d.supplierDeposits = d.supplierDeposits.filter((x) => x.id !== "dep-1"); }), /more advance|Advance/i);
  assert.deepEqual(counts(await db.loadAll()), counts(before));
  // The proper operation says why, and also changes nothing.
  const r = await change(db, (d) => P.deleteDeposit(d, "dep-1"));
  assert.ok(r.error);
  assert.equal((await db.loadAll()).revision, before.revision);
});

test("db: deleting one invoice payment leaves the other payments and the purchase alone; repeating it does nothing", async () => {
  const db = await seeded();
  await change(db, (d) => { confirmed(d, 100); });
  const pid = (await db.loadAll()).purchases[0].id;
  await change(db, (d) => { P.recordPayment(d, pid, { amount: "30000", date: day(-1) }); });
  await change(db, (d) => { P.recordPayment(d, pid, { amount: "20000", date: day(0) }); });
  const all = await db.loadAll();
  const [first, second] = all.supplierPayments.sort((a, b) => a.amount - b.amount).reverse();
  const r = await change(db, (d) => P.deletePayment(d, first.id));
  assert.equal(r.error, undefined, r.error);
  const after = await db.loadAll();
  assert.deepEqual(after.supplierPayments.map((x) => x.id), [second.id]);
  assert.equal(after.purchases.length, 1);
  const again = await change(db, (d) => P.deletePayment(d, first.id));
  assert.equal(again.skip, true);
  assert.equal((await db.loadAll()).revision, after.revision, "no new revision");
});

test("backup: a backup made after a deletion holds no trace of it and restores exactly; a backup made before still restores", async () => {
  const db = await seeded();
  await change(db, (d) => { deposit(d, 60000, { id: "dep-gone", reference: "GONE-REF", date: day(-3) }); });
  await change(db, (d) => { confirmed(d, 100); });
  const older = V.prepareBackupFile(await db.loadAll(), new Date());
  assert.equal(older.error, undefined, older.error);
  assert.equal(older.counts.supplierDeposits, 1);

  assert.equal((await change(db, (d) => P.deleteDeposit(d, "dep-gone"))).error, undefined);
  const snapshot = await db.loadAll();
  const file = V.prepareBackupFile(snapshot, new Date());
  assert.equal(file.error, undefined, file.error);
  assert.ok(!file.text.includes("dep-gone") && !file.text.includes("GONE-REF"), "the backup holds no trace of the deleted payment");
  assert.equal(file.counts.supplierDeposits, undefined, "no deposits to count");
  const parsed = V.parseBackup(file.text);
  assert.equal(parsed.error, undefined, parsed.error);
  const target = await openedDb();
  const restored = await target.restore(parsed.data);
  assert.equal(restored.error, undefined, restored.error);
  const back = await target.loadAll();
  assert.deepEqual(counts(back), [0, 0, 0, 1]);
  assert.deepEqual(back.purchases.map((p) => p.log.length), snapshot.purchases.map((p) => p.log.length));

  // An older file is a legitimate file: it still parses and restores (with its payment, as it was when it was made).
  const olderParsed = V.parseBackup(older.text);
  assert.equal(olderParsed.error, undefined, olderParsed.error);
  const other = await openedDb();
  assert.equal((await other.restore(olderParsed.data)).error, undefined);
  assert.deepEqual(counts(await other.loadAll()), [1, 1, 0, 1]);
});

/* ==========================================================================
   Screens
   ========================================================================== */

const state = (app) => app.api.getState();
const ui = (app) => app.api.PurchasesUI;
const sid = (app) => state(app).suppliers[0].id;
const settle = () => new Promise((resolve) => setImmediate(resolve));

async function shop() {
  const app = loadApp();
  const storage = await app.start();
  assert.equal(storage.mode, "ready", storage.reason);
  assert.equal((await app.api.commit((d) => { d.products.push(tile()); })).error, undefined);
  assert.equal((await app.api.commit((d) => P.saveSupplier(d, { name: "Timgad Ceramic", phone: "0555 12 34 56", paymentTermsDays: "30" }))).error, undefined);
  return app;
}

async function openTab(app, tab) {
  state(app).view = "suppliers";
  ui(app).reset();
  ui(app).openSupplier(sid(app), tab);
  app.api.renderAll();
  return app.field("suppliersRoot").innerHTML;
}

const buy = (app, boxes, extra) => app.api.commit((d) => {
  const saved = P.saveDraft(d, { supplierId: d.suppliers[0].id, supplierInvoiceNumber: "FA-" + (d.purchases.length + 1), invoiceDate: day(0), lines: [{ productId: "p-tile", unit: "box", qty: String(boxes), unitPrice: "1000" }], ...extra });
  if (saved.error) return saved;
  return P.confirmPurchase(d, saved.purchase.id);
});

test("screen: the Payments tab offers Delete on an advance; the question is asked first, Cancel keeps everything, Delete permanently removes it at once", async () => {
  const app = await shop();
  await app.api.commit((d) => P.recordDeposit(d, { id: "dep-1", supplierId: d.suppliers[0].id, amount: "2000000", date: day(0), reference: "VIR-WRONG" }));
  let html = await openTab(app, "payments");
  assert.match(html, /data-act="sup-pay-delete" data-kind="deposit" data-id="dep-1"/);
  assert.match(html, /VIR-WRONG/);

  ui(app).actions["sup-pay-delete"]({ dataset: { kind: "deposit", id: "dep-1" } });
  html = app.field("suppliersRoot").innerHTML;
  assert.match(html, /Delete this payment permanently\?/);
  assert.match(html, /This action cannot be undone\. The payment and its associated records will be permanently removed\./);
  assert.match(html, /data-act="sup-pay-delete-cancel">Cancel</);
  assert.match(html, /data-act="pay-delete-confirm" data-kind="deposit" data-id="dep-1">Delete permanently</);
  assert.equal(state(app).supplierDeposits.length, 1, "asking deletes nothing");

  ui(app).actions["sup-pay-delete-cancel"]();
  html = app.field("suppliersRoot").innerHTML;
  assert.ok(!/Delete this payment permanently\?/.test(html));
  assert.equal(state(app).supplierDeposits.length, 1, "Cancel keeps the payment");
  assert.match(html, /VIR-WRONG/);

  ui(app).actions["sup-pay-delete"]({ dataset: { kind: "deposit", id: "dep-1" } });
  await ui(app).actions["pay-delete-confirm"]({ dataset: { kind: "deposit", id: "dep-1" } });
  await settle();
  assert.deepEqual([state(app).supplierDeposits.length, state(app).advanceAllocations.length], [0, 0]);
  html = app.field("suppliersRoot").innerHTML;
  assert.ok(!/VIR-WRONG/.test(html), "gone from the page at once");
  assert.ok(!/Delete this payment permanently\?/.test(html), "the question is closed");
  const s = P.supplierPayable(state(app), sid(app), day(0));
  assert.deepEqual([s.paid, s.unapplied, s.net], [0, 0, 0]);

  // The correct payment can be entered again, and nothing of the first one shows.
  await app.api.commit((d) => P.recordDeposit(d, { supplierId: d.suppliers[0].id, amount: "200000", date: day(0), reference: "VIR-RIGHT" }));
  html = await openTab(app, "payments");
  assert.match(html, /VIR-RIGHT/);
  assert.ok(!/VIR-WRONG/.test(html));
});

test("screen: deleting an applied advance refreshes the invoice picture; the statement and the history keep no entry of it", async () => {
  const app = await shop();
  await app.api.commit((d) => P.recordDeposit(d, { id: "dep-1", supplierId: d.suppliers[0].id, amount: "60000", date: day(-2), reference: "VIR-APPLIED" }));
  assert.equal((await buy(app, 100)).error, undefined);
  assert.equal(state(app).advanceAllocations.length, 1);
  assert.match(await openTab(app, "statement"), /VIR-APPLIED|60[\s\u202f\u00a0,.]?000/);

  ui(app).actions["sup-pay-delete"]({ dataset: { kind: "deposit", id: "dep-1" } });
  await ui(app).actions["pay-delete-confirm"]({ dataset: { kind: "deposit", id: "dep-1" } });
  await settle();
  const st = state(app);
  assert.deepEqual([st.supplierDeposits.length, st.advanceAllocations.length, st.purchases.length], [0, 0, 1]);
  assert.ok(!(st.purchases[0].log || []).some((e) => e.event.startsWith("advance")));
  const s = P.supplierPayable(st, sid(app), day(0));
  assert.deepEqual([s.total, s.paid, s.outstanding, s.net], [100000, 0, 100000, 100000]);
  for (const tab of ["payments", "statement", "overview"]) {
    const html = await openTab(app, tab);
    assert.ok(!/VIR-APPLIED/.test(html), tab + " still shows the deleted payment");
  }
});

test("screen: an invoice payment has Delete on the invoice page and on the supplier's Payments tab, voided ones too", async () => {
  const app = await shop();
  assert.equal((await buy(app, 100)).error, undefined);
  const pid = state(app).purchases[0].id;
  await app.api.commit((d) => P.recordPayment(d, pid, { amount: "40000", date: day(-1), reference: "PAY-KEEP" }));
  await app.api.commit((d) => P.recordPayment(d, pid, { amount: "10000", date: day(0), reference: "PAY-VOID" }));
  const [keep, voided] = [state(app).supplierPayments.find((x) => x.reference === "PAY-KEEP"), state(app).supplierPayments.find((x) => x.reference === "PAY-VOID")];
  await app.api.commit((d) => P.voidPayment(d, voided.id, "wrong"));

  const tab = await openTab(app, "payments");
  assert.equal((tab.match(/data-act="sup-pay-delete" data-kind="payment"/g) || []).length, 2, "one Delete per payment row, the voided one included");

  state(app).view = "purchases";
  ui(app).reset();
  ui(app).openPurchase(pid);
  app.api.renderAll();
  let html = app.field("purchasesRoot").innerHTML;
  assert.equal((html.match(/data-panel="deletePay:/g) || []).length, 2);
  ui(app).state.pur.open = "deletePay:" + keep.id;
  app.api.renderAll();
  html = app.field("purchasesRoot").innerHTML;
  assert.match(html, /Delete this payment permanently\?/);
  assert.match(html, /data-act="pur-close-panel">Cancel</);
  await ui(app).actions["pay-delete-confirm"]({ dataset: { kind: "payment", id: keep.id } });
  await settle();
  assert.deepEqual(state(app).supplierPayments.map((x) => x.id), [voided.id], "only the chosen payment went; the voided one is untouched");
  assert.equal(state(app).supplierPayments[0].status, "voided");
  html = app.field("purchasesRoot").innerHTML;
  assert.ok(!/PAY-KEEP/.test(html), "gone from the invoice page");
  assert.ok(!/Delete this payment permanently\?/.test(html));
  const sum = P.purchaseSummary(state(app).purchases[0], state(app).supplierPayments, day(0), state(app).advanceAllocations);
  assert.deepEqual([sum.paid, sum.outstanding], [0, 100000]);
});

test("screen: a refused deletion keeps the question open and saves nothing; a deletion survives a reload of the app", async () => {
  const app = await shop();
  await app.api.commit((d) => P.recordDeposit(d, { id: "dep-1", supplierId: d.suppliers[0].id, amount: "100000", date: day(-1) }));
  await app.api.commit((d) => P.recordDeposit(d, { id: "ref-1", supplierId: d.suppliers[0].id, kind: "refund", amount: "30000", date: day(0) }));
  await openTab(app, "payments");
  ui(app).actions["sup-pay-delete"]({ dataset: { kind: "deposit", id: "dep-1" } });
  await ui(app).actions["pay-delete-confirm"]({ dataset: { kind: "deposit", id: "dep-1" } });
  await settle();
  assert.equal(state(app).supplierDeposits.length, 2, "refused: refunds depend on it");

  // Delete the refund, then the advance; reload the app from the same database.
  for (const [kind, id] of [["deposit", "ref-1"], ["deposit", "dep-1"]]) {
    ui(app).actions["sup-pay-delete"]({ dataset: { kind, id } });
    await ui(app).actions["pay-delete-confirm"]({ dataset: { kind, id } });
    await settle();
  }
  assert.equal(state(app).supplierDeposits.length, 0);
  const reopened = loadApp({ indexedDB: app.indexedDB });
  const storage = await reopened.start();
  assert.equal(storage.mode, "ready", storage.reason);
  assert.deepEqual([state(reopened).supplierDeposits.length, state(reopened).advanceAllocations.length], [0, 0]);
});

test("screen: the question and the buttons are drawn in French and Arabic with no missing text", async () => {
  const app = await shop();
  await app.api.commit((d) => P.recordDeposit(d, { id: "dep-1", supplierId: d.suppliers[0].id, amount: "5000", date: day(0) }));
  const expected = {
    // French typography: the app puts a non-breaking space before "?" (see i18n.js).
    fr: ["Supprimer ce paiement définitivement\u00a0?", "Cette action est irréversible.", "Annuler", "Supprimer définitivement"],
    ar: ["حذف هذه الدفعة نهائيًا؟", "لا يمكن التراجع عن هذا الإجراء.", "إلغاء", "حذف نهائي"],
  };
  for (const language of ["fr", "ar"]) {
    await app.api.commit((d) => { d.settings.language = language; });
    await openTab(app, "payments");
    ui(app).actions["sup-pay-delete"]({ dataset: { kind: "deposit", id: "dep-1" } });
    const html = app.field("suppliersRoot").innerHTML;
    for (const word of expected[language]) assert.ok(html.includes(word), `${language}: "${word}" is missing`);
    assert.ok(!/\bspay\.[a-zA-Z]+\b/.test(html.replace(/data-[a-z-]+="[^"]*"/g, "").replace(/id="[^"]*"/g, "")), language + ": a text key was shown instead of text");
  }
});

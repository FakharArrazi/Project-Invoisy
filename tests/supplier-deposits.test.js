"use strict";

// Supplier deposits and advance payments: money given to a supplier without naming an invoice, applied later to
// purchases through separate allocation records. Numbers follow the sixteen cases of the specification.
// Business rules run on a plain copy of the data; storage rules run against a disposable in-memory IndexedDB.

const test = require("node:test");
const assert = require("node:assert/strict");
const { fake, V, DB, newDb, sampleProduct } = require("./helpers/modules");

const P = globalThis.Purchases;
const day = (offset) => P.addDays(P.toDay(new Date()), offset || 0);

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

// A purchase of `boxes` boxes at 1,000 DA, so 100 boxes = 100,000 DA.
function confirmed(d, boxes, extra, options) {
  const input = {
    supplierId: d.suppliers[0].id, supplierInvoiceNumber: "FA-" + (d.purchases.length + 1), invoiceDate: day(0),
    lines: [{ productId: "p-tile", unit: "box", qty: String(boxes), unitPrice: "1000" }], ...extra,
  };
  const saved = P.saveDraft(d, input);
  assert.ok(saved.purchase, saved.error);
  const done = P.confirmPurchase(d, saved.purchase.id, options);
  return { ...done, id: saved.purchase.id };
}

function deposit(d, amount, extra) {
  const r = P.recordDeposit(d, { supplierId: d.suppliers[0].id, amount: String(amount), date: day(0), ...extra });
  assert.ok(r.deposit, r.error);
  return r.deposit;
}

const links = (d) => P.linkProblems({ ...d, attachments: [] });
const sum = (d) => P.supplierPayable(d, d.suppliers[0].id, day(0));
const summaryOf = (d, id) => P.purchaseSummary(d.purchases.find((p) => p.id === id), d.supplierPayments, day(0), d.advanceAllocations);

test("1. a deposit with no purchases at all is accepted and leaves a prepaid balance of -50,000", () => {
  const d = draft();
  deposit(d, 50000);
  const s = sum(d);
  assert.deepEqual([s.total, s.paid, s.net, s.owed, s.advance, s.unapplied, s.outstanding], [0, 50000, -50000, 0, 50000, 50000, 0]);
});

test("2 and 8. a deposit larger than all purchases is accepted: owed 0, advance 50,000, net -50,000, nothing invented", () => {
  const d = draft();
  const { id } = confirmed(d, 100);
  deposit(d, 150000);
  const s = sum(d);
  assert.deepEqual([s.total, s.paid, s.net, s.owed, s.advance], [100000, 150000, -50000, 0, 50000]);
  assert.equal(d.purchases.length, 1, "no fake purchase or invoice was created");
  assert.equal(s.unapplied, 150000);
  assert.equal(s.net, s.outstanding - s.unapplied, "net balance = open invoices - unapplied deposits");
  assert.equal(summaryOf(d, id).outstanding, 100000, "the invoice itself is untouched");
});

test("5. an invoice-specific payment of 40,000 leaves 60,000 outstanding on that invoice", () => {
  const d = draft();
  const { id } = confirmed(d, 100);
  const r = P.recordPayment(d, id, { amount: "40000", date: day(0) });
  assert.ok(r.payment, r.error);
  assert.equal(summaryOf(d, id).outstanding, 60000);
  assert.equal(sum(d).net, 60000);
});

test("6. a general deposit of 40,000 makes the net balance 60,000 but does not change the invoice status", () => {
  const d = draft();
  const { id } = confirmed(d, 100);
  const before = summaryOf(d, id);
  deposit(d, 40000);
  const after = summaryOf(d, id);
  assert.equal(sum(d).net, 60000);
  assert.deepEqual([after.paid, after.outstanding, after.paymentStatus], [before.paid, before.outstanding, before.paymentStatus]);
  assert.equal(after.paymentStatus, "unpaid");
});

test("7. a general deposit can be recorded before any purchase invoice exists, with no invoice named", () => {
  const d = draft();
  const x = deposit(d, 10000, { method: "bank", reference: "VIR-77", note: "advance for autumn" });
  assert.equal(x.purchaseId, undefined);
  assert.deepEqual([x.kind, x.method, x.reference, x.note, x.status], ["deposit", "bank", "VIR-77", "advance for autumn", "recorded"]);
});

test("3. an advance of 50,000 applied to a purchase of 30,000 leaves 20,000 in credit and 0 outstanding", () => {
  const d = draft();
  deposit(d, 50000);
  const done = confirmed(d, 30, { advanceApply: "30000" });
  assert.ok(done.purchase, done.error);
  assert.equal(done.allocations.length, 1);
  const s = sum(d);
  assert.deepEqual([s.total, s.paid, s.net, s.advance, s.unapplied, s.outstanding], [30000, 50000, -20000, 20000, 20000, 0]);
  assert.equal(summaryOf(d, done.id).paymentStatus, "paid");
});

test("4. an advance of 20,000 on a purchase of 35,000 leaves 15,000 still owed; with 5,000 paid in cash 10,000 remains", () => {
  const d = draft();
  deposit(d, 20000);
  const done = confirmed(d, 35, { advanceApply: "20000" });
  assert.ok(done.purchase, done.error);
  let s = sum(d);
  assert.deepEqual([s.net, s.owed, s.advance, s.outstanding], [15000, 15000, 0, 15000]);
  const r = P.recordPayment(d, done.id, { amount: "5000", date: day(0) });
  assert.ok(r.payment, r.error);
  s = sum(d);
  assert.deepEqual([s.net, s.outstanding, s.paid], [10000, 10000, 25000]);
  const inv = summaryOf(d, done.id);
  assert.deepEqual([inv.advanceApplied, inv.paidCash, inv.paid, inv.outstanding], [20000, 5000, 25000, 10000]);
});

test("9 and 15. applying an advance never counts the deposit twice, and a partial application keeps the rest", () => {
  const d = draft();
  deposit(d, 50000);
  const before = sum(d);
  const done = confirmed(d, 30, { advanceApply: "12000", initialPayment: { amount: "18000", date: day(0) } });
  assert.ok(done.purchase, done.error);
  const s = sum(d);
  assert.equal(s.deposited, 50000);
  assert.equal(s.paid, before.paid + 18000, "paid to supplier grew by the cash payment only; the 12,000 was already counted as a deposit");
  assert.equal(s.unapplied, 38000, "partial application: 50,000 - 12,000 stays available");
  assert.equal(summaryOf(d, done.id).outstanding, 0, "12,000 advance + 18,000 cash = the 30,000 total, exactly");
  assert.equal(d.supplierDeposits[0].amount, 50000, "the original deposit was not edited");
});

test("an advance can not be applied for more than the unapplied deposits, nor than the purchase needs", () => {
  const d = draft();
  deposit(d, 10000);
  const tooMuch = P.saveDraft(d, { supplierId: d.suppliers[0].id, invoiceDate: day(0), lines: [{ productId: "p-tile", unit: "box", qty: "30", unitPrice: "1000" }], advanceApply: "15000" });
  const refused = P.confirmPurchase(d, tooMuch.purchase.id);
  assert.ok(refused.error, "only 10,000 is available");
  assert.equal(d.advanceAllocations.length, 0);
  const done = confirmed(d, 5, {});
  const r = P.applyAdvance(d, done.id, "6000");
  assert.ok(r.error, "the purchase only needs 5,000");
  const ok = P.applyAdvance(d, done.id, "5000");
  assert.equal(ok.amount, 5000);
  assert.ok(P.applyAdvance(d, done.id, "1").error, "now it is fully settled");
});

test("an allocation draws from the oldest deposits first and records one allocation per deposit used", () => {
  const d = draft();
  const first = deposit(d, 4000, { date: day(-2) });
  const second = deposit(d, 4000, { date: day(-1) });
  const done = confirmed(d, 6, { advanceApply: "6000" });
  assert.deepEqual(done.allocations.map((a) => [a.depositId, a.amount]), [[first.id, 4000], [second.id, 2000]]);
  assert.equal(sum(d).unapplied, 2000);
});

test("10. cancelling a purchase gives its advance back; the allocation stays as reversed history", () => {
  const d = draft();
  deposit(d, 50000);
  const done = confirmed(d, 30, { advanceApply: "30000" });
  assert.equal(sum(d).unapplied, 20000);
  const r = P.cancelPurchase(d, done.id, "wrong invoice");
  assert.ok(!r.error, r.error);
  assert.equal(sum(d).unapplied, 50000);
  assert.equal(d.advanceAllocations.length, 1);
  assert.deepEqual([d.advanceAllocations[0].status, d.advanceAllocations[0].reverseReason], ["reversed", "wrong invoice"]);
  assert.equal(sum(d).net, -50000);
});

test("10. deleting a purchase removes its allocations and the deposit is untouched; the preview says what comes back", () => {
  const d = draft();
  deposit(d, 50000);
  const done = confirmed(d, 30, { advanceApply: "30000" });
  const preview = P.deletionPreview(d, done.id);
  assert.deepEqual([preview.allocationCount, preview.advanceReturned], [1, 30000]);
  const r = P.deletePurchase(d, done.id);
  assert.ok(!r.error, r.error);
  assert.deepEqual([d.advanceAllocations.length, d.supplierDeposits.length, sum(d).unapplied], [0, 1, 50000]);
});

test("reversing an allocation on its own releases it to the deposits and lowers what the invoice has settled", () => {
  const d = draft();
  deposit(d, 50000);
  const done = confirmed(d, 30, { advanceApply: "30000" });
  assert.ok(P.reverseAllocation(d, d.advanceAllocations[0].id, "").error, "a reason is required");
  const r = P.reverseAllocation(d, d.advanceAllocations[0].id, "applied to the wrong purchase");
  assert.ok(r.allocation, r.error);
  assert.equal(summaryOf(d, done.id).outstanding, 30000);
  assert.equal(sum(d).unapplied, 50000);
});

test("14. submitting the same deposit twice (double click, retry) records it once", () => {
  const d = draft();
  const input = { id: "form-nonce-1", supplierId: d.suppliers[0].id, amount: "5000", date: day(0) };
  const a = P.recordDeposit(d, input);
  const b = P.recordDeposit(d, input);
  assert.ok(a.deposit);
  assert.deepEqual([b.skip, b.already], [true, true]);
  assert.equal(d.supplierDeposits.length, 1);
});

test("deposit input is validated: amount above zero, no future date, a known method, an existing supplier", () => {
  const d = draft();
  const sid = d.suppliers[0].id;
  assert.ok(P.recordDeposit(d, { supplierId: sid, amount: "0", date: day(0) }).error);
  assert.ok(P.recordDeposit(d, { supplierId: sid, amount: "-5", date: day(0) }).error);
  assert.ok(P.recordDeposit(d, { supplierId: sid, amount: "abc", date: day(0) }).error);
  assert.ok(P.recordDeposit(d, { supplierId: sid, amount: "5", date: day(3) }).error);
  assert.ok(P.recordDeposit(d, { supplierId: sid, amount: "5", date: day(0), method: "bitcoin" }).error);
  assert.ok(P.recordDeposit(d, { supplierId: "nobody", amount: "5", date: day(0) }).error);
  assert.equal(d.supplierDeposits.length, 0);
});

test("16. a refund is its own record that lowers the advance; it can not exceed the unapplied deposits; voiding it restores them", () => {
  const d = draft();
  deposit(d, 50000);
  const big = P.recordDeposit(d, { supplierId: d.suppliers[0].id, kind: "refund", amount: "60000", date: day(0) });
  assert.ok(big.error);
  const r = P.recordDeposit(d, { supplierId: d.suppliers[0].id, kind: "refund", amount: "20000", date: day(0), reference: "cash back" });
  assert.equal(r.deposit.kind, "refund");
  let s = sum(d);
  assert.deepEqual([s.deposited, s.refunded, s.paid, s.net, s.unapplied], [50000, 20000, 30000, -30000, 30000]);
  P.voidDeposit(d, r.deposit.id, "entered by mistake");
  s = sum(d);
  assert.deepEqual([s.paid, s.net, s.unapplied], [50000, -50000, 50000]);
});

test("a deposit that was applied can not be voided or lowered below what was applied; once reversed it can", () => {
  const d = draft();
  const x = deposit(d, 50000);
  confirmed(d, 30, { advanceApply: "30000" });
  assert.ok(P.voidDeposit(d, x.id, "mistake").error, "applied to a purchase");
  assert.ok(P.updateDeposit(d, x.id, { amount: "20000", date: x.date }).error, "30,000 of it was applied");
  const ok = P.updateDeposit(d, x.id, { amount: "35000", date: x.date, note: "corrected" });
  assert.ok(ok.deposit, ok.error);
  assert.equal(ok.deposit.history.length, 1, "the old values stay in its history");
  assert.equal(ok.deposit.history[0].amount, 50000);
  P.reverseAllocation(d, d.advanceAllocations[0].id, "undo");
  const v = P.voidDeposit(d, x.id, "paid twice");
  assert.ok(v.deposit, v.error);
  assert.equal(sum(d).paid, 0);
});

test("a deposit can not be voided while refunds depend on it", () => {
  const d = draft();
  const x = deposit(d, 10000);
  P.recordDeposit(d, { supplierId: d.suppliers[0].id, kind: "refund", amount: "8000", date: day(0) });
  assert.ok(P.voidDeposit(d, x.id, "mistake").error);
  assert.ok(P.updateDeposit(d, x.id, { amount: "5000", date: x.date }).error);
});

test("11. a supplier with only a deposit can not be deleted", () => {
  const d = draft();
  deposit(d, 1000);
  const r = P.deleteSupplier(d, d.suppliers[0].id);
  assert.ok(r.error);
  assert.equal(d.suppliers.length, 1);
});

test("12. data from before deposits existed (no deposit or allocation lists at all) still works", () => {
  const d = draft();
  delete d.supplierDeposits;
  delete d.advanceAllocations;
  const { id } = confirmed(d, 10);
  assert.ok(P.recordPayment(d, id, { amount: "4000", date: day(0) }).payment);
  const s = P.supplierPayable(d, d.suppliers[0].id, day(0));
  assert.deepEqual([s.total, s.paid, s.net, s.outstanding, s.advance, s.unapplied], [10000, 4000, 6000, 6000, 0, 0]);
  assert.deepEqual(links(d), []);
});

test("an invoice can not be paid for more than is left after an advance was applied to it", () => {
  const d = draft();
  deposit(d, 8000);
  const done = confirmed(d, 10, { advanceApply: "8000" });
  assert.ok(P.recordPayment(d, done.id, { amount: "2500", date: day(0) }).error);
  assert.ok(P.recordPayment(d, done.id, { amount: "2000", date: day(0) }).payment);
});

test("the supplier statement lists every deposit, even without an invoice, with a running balance and allocations that change nothing", () => {
  const d = draft();
  deposit(d, 50000, { date: day(-3) });
  const done = confirmed(d, 30, { advanceApply: "30000", invoiceDate: day(-1) });
  const rows = P.supplierLedger(d, d.suppliers[0].id);
  assert.deepEqual(rows.map((r) => r.type), ["deposit", "purchase", "allocation"]);
  assert.deepEqual(rows.map((r) => r.balance), [-50000, -20000, -20000]);
  assert.equal(rows[2].purchaseId, done.id);
  assert.equal(rows[2].effect, 0);
  assert.equal(rows.at(-1).balance, sum(d).net, "the last running balance is the net balance");
});

test("every balance reconciles: net = open invoices - unapplied deposits, across a mixed history", () => {
  const d = draft();
  deposit(d, 70000);
  const a = confirmed(d, 40, { advanceApply: "25000" });
  const b = confirmed(d, 20, {});
  P.recordPayment(d, a.id, { amount: "5000", date: day(0) });
  P.recordDeposit(d, { supplierId: d.suppliers[0].id, kind: "refund", amount: "10000", date: day(0) });
  const s = sum(d);
  assert.equal(s.net, round(s.outstanding - s.unapplied));
  assert.equal(s.net, round(s.total - s.paid));
  assert.deepEqual(links(d), []);
  assert.ok(b.purchase);
});
const round = (n) => Math.round(n * 100) / 100;

test("link checks flag allocations that point nowhere, mismatch the supplier or exceed what they come from", () => {
  const d = draft();
  deposit(d, 10000);
  confirmed(d, 5, { advanceApply: "5000" });
  const good = JSON.parse(JSON.stringify(d));
  assert.deepEqual(links(good), []);
  const noDeposit = JSON.parse(JSON.stringify(d)); noDeposit.advanceAllocations[0].depositId = "ghost";
  assert.ok(links(noDeposit).length);
  const over = JSON.parse(JSON.stringify(d)); over.advanceAllocations[0].amount = 20000;
  assert.ok(links(over).length);
  const orphan = JSON.parse(JSON.stringify(d)); orphan.supplierDeposits[0].supplierId = "ghost";
  assert.ok(links(orphan).length);
});

/* ---------- storage ---------- */

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

async function seeded() {
  const db = await openedDb();
  await change(db, (d) => {
    d.products = [tile()];
    const r = P.saveSupplier(d, { name: "Timgad Ceramic", paymentTermsDays: "30" });
    assert.ok(r.supplier, r.error);
  });
  return db;
}

const inDb = (db, mutate) => change(db, mutate);

test("deposits and allocations persist, reload and keep their order after a reopen", async () => {
  const factory = new fake.IDBFactory();
  const db = newDb({ indexedDB: factory, name: "deposits" });
  await db.initDatabase();
  await change(db, (d) => { d.products = [tile()]; P.saveSupplier(d, { name: "S", paymentTermsDays: "30" }); });
  await change(db, (d) => { P.recordDeposit(d, { id: "dep-a", supplierId: d.suppliers[0].id, amount: "150000", date: day(0), method: "cash" }); });
  await change(db, (d) => { confirmed(d, 30, { advanceApply: "30000" }); });
  const again = newDb({ indexedDB: factory, name: "deposits" });
  await again.initDatabase();
  const all = await again.loadAll();
  assert.equal(all.supplierDeposits.length, 1);
  assert.equal(all.advanceAllocations.length, 1);
  assert.equal(all.supplierDeposits[0].id, "dep-a");
  assert.equal(P.supplierPayable(all, all.suppliers[0].id, day(0)).unapplied, 120000);
});

test("the database refuses to delete a deposit, to apply more than a deposit holds, or to overpay an invoice", async () => {
  const db = await seeded();
  await change(db, (d) => { P.recordDeposit(d, { id: "dep-1", supplierId: d.suppliers[0].id, amount: "10000", date: day(0) }); });
  await change(db, (d) => { confirmed(d, 10, {}); });

  await assert.rejects(change(db, (d) => { d.supplierDeposits = []; }), /deposit/i, "a deposit is never deleted");

  const forged = (amount) => (d) => {
    const p = d.purchases[0];
    d.advanceAllocations.push(P.normalizeAllocation({ id: "a-x", depositId: "dep-1", purchaseId: p.id, supplierId: p.supplierId, amount, date: day(0), status: "applied", createdAt: new Date().toISOString() }));
  };
  await assert.rejects(change(db, forged(10001)), "more than the deposit holds");
  const ok = await change(db, forged(10000));
  assert.ok(ok.saved, "exactly what the deposit holds is fine");
  await assert.rejects(change(db, (d) => { d.advanceAllocations = []; }), "an allocation is only removed with its purchase");
  await assert.rejects(change(db, (d) => { d.supplierDeposits[0].status = "voided"; d.supplierDeposits[0].voidedAt = new Date().toISOString(); d.supplierDeposits[0].voidReason = "x"; }), "a voided deposit can not have applied allocations");
  await assert.rejects(change(db, (d) => { d.suppliers = []; }));
});

test("13. a backup keeps deposits, refunds and allocations exactly, and restoring it brings them back", async () => {
  const db = await seeded();
  await change(db, (d) => { P.recordDeposit(d, { id: "dep-1", supplierId: d.suppliers[0].id, amount: "50000", date: day(-1), method: "bank", reference: "VIR-1", note: "n" }); });
  await change(db, (d) => { confirmed(d, 30, { advanceApply: "30000" }); });
  await change(db, (d) => { P.recordDeposit(d, { id: "ref-1", supplierId: d.suppliers[0].id, kind: "refund", amount: "5000", date: day(0) }); });
  const snapshot = await db.loadAll();
  const file = V.prepareBackupFile(snapshot, new Date());
  assert.equal(file.error, undefined, file.error);
  assert.equal(file.counts.supplierDeposits, 2);
  assert.equal(file.counts.advanceAllocations, 1);
  const parsed = V.parseBackup(file.text);
  assert.equal(parsed.error, undefined, parsed.error);
  assert.deepEqual(parsed.data.supplierDeposits, snapshot.supplierDeposits);
  assert.deepEqual(parsed.data.advanceAllocations, snapshot.advanceAllocations);

  const empty = await openedDb();
  const restored = await empty.restore(parsed.data);
  assert.equal(restored.error, undefined, restored.error);
  const after = await empty.loadAll();
  assert.deepEqual(after.supplierDeposits, snapshot.supplierDeposits);
  assert.deepEqual(after.advanceAllocations, snapshot.advanceAllocations);
  assert.deepEqual(P.supplierPayable(after, after.suppliers[0].id, day(0)), P.supplierPayable(snapshot, snapshot.suppliers[0].id, day(0)));
});

test("a backup of data without deposits keeps its old shape (no new lists, no new counts)", async () => {
  const db = await seeded();
  const file = V.prepareBackupFile(await db.loadAll(), new Date());
  const parsed = JSON.parse(file.text);
  assert.equal("supplierDeposits" in parsed.data, false);
  assert.equal("supplierDeposits" in file.counts, false);
});

test("a damaged backup is refused: an allocation pointing at a deposit that is not in the file", async () => {
  const db = await seeded();
  await change(db, (d) => { P.recordDeposit(d, { id: "dep-1", supplierId: d.suppliers[0].id, amount: "50000", date: day(0) }); });
  await change(db, (d) => { confirmed(d, 30, { advanceApply: "30000" }); });
  const file = V.prepareBackupFile(await db.loadAll(), new Date());
  const broken = JSON.parse(file.text);
  broken.data.supplierDeposits = [];
  delete broken.counts;
  const parsed = V.parseBackup(JSON.stringify(broken));
  assert.ok(parsed.error, "the file is rejected, nothing is restored");
});

test("upgrade 4 -> 5: every record is kept exactly, the two new stores start empty, and deposits can then be saved", async () => {
  const factory = new fake.IDBFactory();
  const rows = {
    products: [tile()], suppliers: [{ id: "s1", name: "Old Supplier" }], settings: [], counters: [], meta: [],
  };
  const open = await new Promise((resolve, reject) => {
    const req = factory.open("legacy4", 4);
    req.onupgradeneeded = () => {
      const db = req.result;
      const p = db.createObjectStore("products", { keyPath: "id" }); p.createIndex("sku", "sku"); p.createIndex("name", "name");
      const i = db.createObjectStore("invoices", { keyPath: "id" }); i.createIndex("invoiceNumber", "invoiceNumber", { unique: true }); i.createIndex("date", "date");
      db.createObjectStore("settings", { keyPath: "key" }); db.createObjectStore("counters", { keyPath: "name" }); db.createObjectStore("meta", { keyPath: "key" });
      const s = db.createObjectStore("suppliers", { keyPath: "id" }); s.createIndex("name", "name");
      const pu = db.createObjectStore("purchases", { keyPath: "id" });
      for (const k of ["supplierId", "invoiceDate", "status"]) pu.createIndex(k, k);
      pu.createIndex("invoiceKey", "invoiceKey", { unique: true }); pu.createIndex("refKey", "refKey", { unique: true });
      const pay = db.createObjectStore("supplierPayments", { keyPath: "id" }); for (const k of ["purchaseId", "supplierId", "date"]) pay.createIndex(k, k);
      db.createObjectStore("attachments", { keyPath: "id" }).createIndex("purchaseId", "purchaseId");
      const t = db.createObjectStore("debtTransfers", { keyPath: "id" }); t.createIndex("sourceInvoiceId", "sourceInvoiceId"); t.createIndex("targetInvoiceId", "targetInvoiceId");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  await new Promise((resolve, reject) => {
    const tx = open.transaction(["products", "suppliers"], "readwrite");
    tx.objectStore("products").put(rows.products[0]);
    tx.objectStore("suppliers").put(rows.suppliers[0]);
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
  open.close();

  const db = newDb({ indexedDB: factory, name: "legacy4" });
  const info = await db.initDatabase();
  assert.equal(info.version, 5);
  const all = await db.loadAll();
  assert.equal(all.products.length, 1);
  assert.equal(all.products[0].id, "p-tile");
  assert.equal(all.suppliers[0].id, "s1");
  assert.deepEqual([all.supplierDeposits.length, all.advanceAllocations.length], [0, 0]);
  const saved = await change(db, (d) => { P.recordDeposit(d, { supplierId: "s1", amount: "1000", date: day(0) }); });
  assert.ok(saved.saved);
});

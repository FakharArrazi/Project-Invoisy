"use strict";

// A made-up shop that touches every kind of record Invoisy keeps (products, invoices with partial payments, customers, a
// supplier with purchases, payments and a deposit, a worker with an advance and a salary payment, settings). It is built
// with the application's own functions in a disposable in-memory database and handed out as the text of a backup file, so
// the Electron tests can restore it into the real desktop application and compare what comes out. No real data.

const { boot, addTile, sellLines } = require("./edit");
require("./modules");

const P = globalThis.Purchases;
const W = globalThis.Workers;
const day = (offset) => P.addDays(P.toDay(new Date()), offset || 0);

// Fills a started application (ctx.api, as boot() or a test makes it) with the made-up shop.
async function populate(ctx) {
  const { api } = ctx;
  const commit = async (fn) => { const r = await api.commit(fn); if (r && r.error) throw new Error(r.error); return r; };

  const grey = await addTile(ctx, { name: "Everton Grey", sku: "EV-60", stock: 120 });
  const sand = await addTile(ctx, { name: "Desert Sand", sku: "DS-60", stock: 80, sellingPrice: 2600 });

  // Customers and invoices: one paid in part, one paid in full.
  await sellLines(ctx, [{ product: grey, qty: "10", unit: "box" }], { name: "Karim Boudiaf", phone: "0550 11 22 33", paid: "5000" });
  await sellLines(ctx, [{ product: sand, qty: "5", unit: "box" }, { product: grey, qty: "2", unit: "box" }], { name: "Samira Hamdi", phone: "0661 44 55 66", paid: "17000" });

  // Two suppliers: one with a purchase and a first payment, one with a deposit applied to a purchase.
  await commit((d) => P.saveSupplier(d, { name: "Timgad Ceramic", phone: "0555 12 34 56", paymentTermsDays: "30" }));
  await commit((d) => P.saveSupplier(d, { name: "Hodna Tiles", phone: "0770 98 76 54", paymentTermsDays: "30" }));
  const [timgad, hodna] = api.getState().suppliers.map((s) => s.id);
  const buy = (supplierId, number, boxes, invoiceDate, extra, options) => commit((d) => {
    const saved = P.saveDraft(d, { supplierId, supplierInvoiceNumber: number, invoiceDate, lines: [{ productId: grey.id, unit: "box", qty: String(boxes), unitPrice: "1000" }], ...(extra || {}) });
    if (saved.error) return saved;
    return P.confirmPurchase(d, saved.purchase.id, options);
  });
  await buy(timgad, "TC-100", 40, day(-14), null, { initialPayment: { amount: "15000", date: day(-14) } });
  await commit((d) => P.recordDeposit(d, { supplierId: hodna, amount: "50000", date: day(-9), method: "bank", reference: "VIR-31" }));
  await buy(hodna, "HT-1", 30, day(-2), { advanceApply: "30000" });

  // A worker: an advance and a salary payment.
  const ctxW = (today) => ({ today, now: new Date(today + "T10:00:00Z") });
  const start = day(-60);
  await commit((d) => W.addWorker(d, { name: "Ali Benali", startDate: start, salary: "40000" }, ctxW(start)));
  const workerId = api.getState().workers[0].id;
  await commit((d) => W.addTransaction(d, { workerId, type: "advance", amount: "8000", date: day(-20) }, ctxW(day(-20))));
  await commit((d) => W.addTransaction(d, { workerId, type: "payment", amount: "32000", date: day(-1), periodIndex: 0 }, ctxW(day(-1))));

  await api.autoBackup.flushNow();
}

// The text of a backup file of that shop (made in the browser way: a stand-in file handle).
async function buildSampleBackup() {
  const ctx = await boot();
  await populate(ctx);
  const text = ctx.handle.content;
  if (!text) throw new Error("The sample backup was not written.");
  return text;
}

// Counts and money totals of a backup text, for comparing before and after a restore. Reads only the file (the same
// text a person could open), never the database.
function summarize(text) {
  const raw = JSON.parse(text);
  const d = raw.data;
  const sum = (list, pick) => Math.round(list.reduce((n, x) => n + (Number(pick(x)) || 0), 0) * 100) / 100;
  return {
    counts: raw.counts,
    invoiceNumbers: d.invoices.map((i) => i.invoiceNumber).sort(),
    invoiceCounter: d.invoiceCounter,
    purchaseCounter: d.purchaseCounter,
    stockTotal: sum(d.products, (p) => p.stock),
    paidOnInvoices: sum(d.invoices, (i) => i.amountPaid),
    remainingOnInvoices: sum(d.invoices, (i) => i.remaining),
    paidToSuppliers: sum(d.supplierPayments || [], (p) => p.amount),
    deposits: sum(d.supplierDeposits || [], (p) => p.amount),
    advanceAllocations: sum(d.advanceAllocations || [], (p) => p.amount),
    workerPayments: sum(d.workerTransactions || [], (p) => p.amount),
    data: d,
  };
}

module.exports = { populate, buildSampleBackup, summarize };

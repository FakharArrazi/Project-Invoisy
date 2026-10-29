"use strict";

// Dashboard: the business figures (analytics.js) and the page that shows them (dashboard.js).
//
//   1. Acceptance scenarios, run through the application's own functions (selling, paying, returning, cancelling, deleting,
//      recording a supplier purchase) against a disposable in-memory IndexedDB: the Dashboard figures must follow the rules.
//   2. The rules on hand-made data: month and year boundaries, carried debt, units that must not be mixed, slow stock, alerts.
//   3. The Dashboard screen: empty shop, filled shop, French, escaping, clicks.

const test = require("node:test");
const assert = require("node:assert/strict");
const { V, sampleProduct, sampleInvoice } = require("./helpers/modules");
const { boot, addTile, sellLines, stockOf, openEdit, typeQty, removeLine } = require("./helpers/edit");
const { loadApp } = require("./helpers/app");

const A = globalThis.Analytics;
const P = globalThis.Purchases;

const today = () => A.dayOf(new Date());
const dayIso = (offset) => {                       // noon, local time, `offset` days from today
  const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + offset); return d.toISOString();
};

// The Dashboard figures of the data the app holds right now.
function figures(api, options) {
  const s = api.getState();
  return A.compute({ invoices: s.invoices, products: s.products, debtTransfers: s.debtTransfers, purchases: s.purchases }, { now: new Date(), lowStock: 5, ...options });
}

/* ==========================================================================
   1. Acceptance scenarios
   ========================================================================== */

test("1-3. a 100,000 DA sale: sales, money collected and outstanding balance each move only when they should", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 100 });
  const before = figures(ctx.api);
  assert.deepEqual([before.cards.today.sales, before.cards.collected.today, before.cards.outstanding.total], [0, 0, 0]);

  // 1. Sold today, nothing paid.
  const inv = await sellLines(ctx, [{ product: tile, qty: "50" }], { name: "Karim Benali", phone: "0555 11 22 33" });
  assert.equal(inv.total, 100000);
  let f = figures(ctx.api);
  assert.equal(f.cards.today.sales, 100000, "today's sales rise by the invoice total");
  assert.equal(f.cards.today.count, 1);
  assert.equal(f.cards.month.sales, 100000);
  assert.equal(f.cards.collected.today, 0, "nothing was paid, nothing was collected");
  assert.equal(f.cards.outstanding.total, 100000, "all of it is still owed");
  assert.equal(f.cards.outstanding.invoices, 1);
  assert.equal(f.cards.outstanding.customers, 1);
  assert.equal(f.cards.invoices.byStatus.unpaid, 1);

  // 2. A part payment of 40,000: sales do not move, collected does.
  await ctx.api.addPayment(inv.id, "40000");
  f = figures(ctx.api);
  assert.equal(f.cards.today.sales, 100000, "a payment is not a sale");
  assert.equal(f.cards.collected.today, 40000);
  assert.equal(f.cards.collected.month, 40000);
  assert.equal(f.cards.outstanding.total, 60000);
  assert.equal(f.cards.invoices.byStatus.partial, 1);

  // 3. The rest: sales unchanged, collected grows by the new payment only, nothing is owed.
  await ctx.api.addPayment(inv.id, "60000");
  f = figures(ctx.api);
  assert.equal(f.cards.today.sales, 100000);
  assert.equal(f.cards.collected.today, 100000);
  assert.equal(f.cards.outstanding.total, 0);
  assert.equal(f.cards.outstanding.invoices, 0);
  assert.equal(f.cards.invoices.byStatus.paid, 1);
  assert.equal(f.series.sales, 100000, "the chart never adds payments to sales");
  assert.equal(f.series.collected, 100000);
});

test("4. a supplier purchase changes no sales figure and never appears as a customer sale", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 100 });
  await sellLines(ctx, [{ product: tile, qty: "10" }], { name: "Ali", paid: "5000" });
  const before = JSON.stringify(figures(ctx.api));

  const supplier = (await ctx.api.commit((d) => P.saveSupplier(d, { name: "Timgad Distribution", phone: "0555 99 88 77" }))).supplier;
  await ctx.api.commit((d) => {
    const made = P.saveDraft(d, { supplierId: supplier.id, supplierInvoiceNumber: "F-1", invoiceDate: today(), lines: [{ productId: tile.id, unit: "box", qty: "10", unitPrice: "1500" }] });
    assert.ok(made.purchase, made.error);
    return P.confirmPurchase(d, made.purchase.id);
  });
  const after = figures(ctx.api);
  assert.equal(after.cards.today.sales, 20000, "sales stay what customers bought");
  assert.equal(after.cards.today.count, 1);
  assert.equal(after.cards.collected.today, 5000);
  assert.equal(after.series.sales, 20000);
  assert.equal(JSON.stringify(after.bestSelling.byRevenue), JSON.stringify(JSON.parse(before).bestSelling.byRevenue), "best sellers are customer sales only");
  assert.equal(after.recent.length, 1, "no purchase in the recent sales");
});

test("5. a returned product: sales follow the edited invoice once, stock is restored, the return is not deducted twice", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 100 });
  const inv = await sellLines(ctx, [{ product: tile, qty: "50" }], { name: "Ali", paid: "100000" });
  assert.equal(stockOf(ctx.api, tile.id), 50);

  openEdit(ctx, inv);
  typeQty(ctx.api, 0, 45);                                         // 5 boxes come back
  assert.equal((ctx.api.editPlan()).error, undefined);
  await ctx.api.saveInvoiceEdit();

  assert.equal(stockOf(ctx.api, tile.id), 55, "stock gets exactly the 5 boxes back");
  const f = figures(ctx.api);
  assert.equal(f.cards.today.sales, 90000, "100,000 - 5 boxes x 2,000, deducted once");
  assert.equal(f.cards.today.count, 1, "still one invoice");
  assert.equal(f.bestSelling.byRevenue[0].revenue, 90000);
  assert.deepEqual(f.bestSelling.byRevenue[0].quantities, [{ unit: "box", qty: 45 }], "45 boxes sold, not 50 and not 40");
  assert.equal(f.cards.collected.today, 100000, "the payment is untouched; the customer is now owed 10,000 back, which is not a debt");
  assert.equal(f.cards.outstanding.total, 0);
});

test("6. an emptied or deleted invoice leaves every figure, with its stock back and nothing orphaned", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 100 });
  const keep = await sellLines(ctx, [{ product: tile, qty: "5" }], { name: "Keeper", phone: "0555 00 11 22", paid: "4000" });      // 10,000, 4,000 paid
  const emptied = await sellLines(ctx, [{ product: tile, qty: "10" }], { name: "Emptied", phone: "0555 33 44 55", paid: "20000" }); // 20,000, all paid
  const doomed = await sellLines(ctx, [{ product: tile, qty: "8" }], { name: "Doomed", phone: "0555 66 77 88" });                  // 16,000, unpaid
  let f = figures(ctx.api);
  assert.equal(f.cards.today.sales, 10000 + 20000 + 16000);
  assert.equal(f.cards.today.count, 3);
  assert.equal(f.cards.collected.today, 24000);
  assert.equal(f.cards.outstanding.total, 6000 + 16000);

  // Taking every line off an invoice deletes it (the money handed back is logged, the stock returns).
  openEdit(ctx, emptied);
  removeLine(ctx.api, 0);
  assert.equal(ctx.api.editPlan().deleted, true);
  await ctx.api.saveInvoiceEdit();
  assert.equal(ctx.api.getState().invoices.some((i) => i.id === emptied.id), false);
  assert.equal(stockOf(ctx.api, tile.id), 100 - 5 - 8, "the boxes are back in stock");
  f = figures(ctx.api);
  assert.equal(f.cards.today.sales, 10000 + 16000, "the emptied invoice is no longer a sale");
  assert.equal(f.cards.today.count, 2);
  assert.equal(f.cards.collected.today, 4000, "its 20,000 left the books with it (the refund is in the refund log, not in this figure)");
  assert.equal(f.cards.outstanding.total, 6000 + 16000);
  assert.ok(f.recent.every((r) => r.id !== emptied.id));
  assert.equal(ctx.api.getState().settings.rollbackLog.length, 1, "the refund log is untouched by the Dashboard");

  // Deleting an invoice does the same.
  await ctx.api.deleteInvoice(doomed.id);
  f = figures(ctx.api);
  assert.equal(f.cards.today.sales, 10000, "only the kept sale is left");
  assert.equal(f.cards.today.count, 1);
  assert.equal(f.cards.outstanding.total, 6000);
  assert.equal(f.cards.collected.today, 4000);
  assert.equal(f.bestSelling.byRevenue[0].revenue, 10000);
  assert.ok(keep.id);
});

test("6b. a cancelled sale from an earlier version (kept on file) is not a sale and holds no debt; its refund nets its payment", () => {
  const done = sampleInvoice({ number: 1, date: dayIso(0), items: [], subtotal: 3000, discount: 0, total: 3000, payments: [{ amount: 3000, timestamp: dayIso(0) }] });
  const cancelled = sampleInvoice({
    number: 2, date: dayIso(0), items: [], subtotal: 9000, discount: 0, total: 9000, payments: [{ amount: 9000, timestamp: dayIso(0) }],
    cancellation: { at: dayIso(0), total: 9000, paid: 9000, refund: 9000 }, refunds: [{ id: "r1", amount: 9000, timestamp: dayIso(0), reason: "cancellation" }],
  });
  const f = A.compute({ invoices: [done, cancelled], products: [] }, { now: new Date() });
  assert.equal(f.cards.today.sales, 3000, "a cancelled sale is not a sale");
  assert.equal(f.cards.today.count, 1);
  assert.equal(f.cards.collected.today, 3000, "9,000 paid and 9,000 handed back: nothing kept from it");
  assert.equal(f.cards.collected.refundedToday, 9000);
  assert.equal(f.cards.outstanding.total, 0);
  assert.deepEqual(f.status.count, { paid: 1, partial: 0, unpaid: 0, transferred: 0 }, "not counted as an invoice either");
});

test("7. sales are grouped by invoice date, payments by payment date", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 100 });
  const inv = await sellLines(ctx, [{ product: tile, qty: "10" }], { name: "Ali", phone: "0555 12 12 12", paid: "5000" });   // 20,000, 5,000 paid
  // Re-date it: sold five days ago, the first 5,000 paid the same day, 15,000 paid two days ago.
  await ctx.api.commit((d) => {
    const i = d.invoices.find((x) => x.id === inv.id);
    i.date = dayIso(-5);
    i.payments = [{ amount: 5000, timestamp: dayIso(-5) }, { amount: 15000, timestamp: dayIso(-2) }];
  });
  const f = figures(ctx.api, { period: "7" });
  const byDay = Object.fromEntries(f.series.buckets.map((b) => [b.key, b]));
  assert.equal(byDay[A.addDays(today(), -5)].sales, 20000, "the sale is on its invoice day");
  assert.equal(byDay[A.addDays(today(), -5)].collected, 5000);
  assert.equal(byDay[A.addDays(today(), -2)].sales, 0, "no sale on the day of the later payment");
  assert.equal(byDay[A.addDays(today(), -2)].collected, 15000, "the later payment is on its own day");
  assert.equal(f.cards.today.sales, 0);
  assert.equal(f.cards.collected.today, 0);
  assert.equal(f.series.sales, 20000);
  assert.equal(f.series.collected, 20000);
});

test("8. an empty shop: every figure is zero, nothing throws, and every list is empty", () => {
  const f = A.compute({}, { now: new Date() });
  assert.deepEqual([f.cards.today.sales, f.cards.month.sales, f.cards.collected.today, f.cards.outstanding.total, f.cards.invoices.month, f.cards.inventory.products], [0, 0, 0, 0, 0, 0]);
  assert.equal(f.cards.today.pct, null);
  assert.equal(f.cards.month.pct, null);
  assert.equal(f.series.empty, true);
  assert.equal(f.series.buckets.length, 30);
  assert.deepEqual(f.status.count, { paid: 0, partial: 0, unpaid: 0, transferred: 0 });
  assert.equal(f.bestSelling.empty, true);
  assert.equal(f.leastSelling.enoughHistory, false);
  assert.deepEqual([f.recent, f.alerts.out, f.alerts.low, f.alerts.negative], [[], [], [], []]);
  assert.equal(f.hasData, false);
  for (const period of A.PERIODS) assert.doesNotThrow(() => A.compute({ invoices: [], products: [] }, { period, now: new Date() }));
});

test("9. units are never mixed: boxes, m² and pieces are ranked in their own lists, and a line in pieces counts in the product's boxes", async () => {
  const boxes = sampleProduct({ id: "b", name: "Box Tile", tileSize: "60*60", coveragePerBox: 1.44, stockUnit: "box", priceUnit: "box", sellingPrice: 2000, stock: 50 });
  const area = sampleProduct({ id: "m", name: "Area Tile", tileSize: "30*60", coveragePerBox: 1.62, stockUnit: "m2", priceUnit: "m2", sellingPrice: 1000, stock: 50 });
  const line = (product, qty, sellingUnit, unitPrice, total) => ({ productId: product.id, name: product.name, manufacturer: "X", tileSize: product.tileSize, coveragePerBox: product.coveragePerBox, sellingUnit, qty, unitPrice, total, priceUnit: sellingUnit });
  const invoices = [
    sampleInvoice({ number: 1, date: dayIso(0), items: [line(boxes, 10, "box", 2000, 20000), line(area, 12, "m2", 1000, 12000)], total: 32000, subtotal: 32000, discount: 0, payments: [] }),
    sampleInvoice({ number: 2, date: dayIso(0), items: [line(boxes, 8, "piece", 500, 4000)], total: 4000, subtotal: 4000, discount: 0, payments: [] }),   // 8 pieces = 2 boxes (4 per box)
  ];
  const f = A.compute({ invoices, products: [boxes, area] }, { now: new Date(), productPeriod: "month" });
  assert.deepEqual(f.bestSelling.byUnit.map((g) => g.unit).sort(), ["box", "m2"], "one list per unit");
  const boxList = f.bestSelling.byUnit.find((g) => g.unit === "box").items;
  assert.equal(boxList.length, 1);
  assert.equal(boxList[0].qty, 12, "10 boxes + 8 pieces (2 boxes) = 12 boxes");
  assert.equal(f.bestSelling.byUnit.find((g) => g.unit === "m2").items[0].qty, 12, "12 m² is its own list, not 12 more boxes");
  assert.equal(f.bestSelling.byRevenue[0].name, "Box Tile", "revenue is the one measure that is comparable across units");
  assert.equal(f.bestSelling.byRevenue[0].revenue, 24000);
  assert.equal(f.cards.inventory.totals.length, 2, "stock is totalled per unit");
  assert.deepEqual(f.cards.inventory.totals.map((x) => x.unit).sort(), ["box", "m2"]);
});

test("10. after a restart the Dashboard figures come back identical from the saved data", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 100 });
  const inv = await sellLines(ctx, [{ product: tile, qty: "10" }], { name: "Ali", phone: "0555 21 21 21" });
  await ctx.api.addPayment(inv.id, "7000");
  const before = JSON.stringify(figures(ctx.api, { now: new Date() }).cards);
  const reloaded = loadApp({ indexedDB: ctx.app.indexedDB });
  const storage = await reloaded.start();
  assert.equal(storage.mode, "ready", storage.reason);
  assert.equal(JSON.stringify(figures(reloaded.api).cards), before);
});

/* ==========================================================================
   2. The rules on hand-made data
   ========================================================================== */

test("days and months: month ends, year ends, leap day and the same elapsed days of the previous month", () => {
  assert.equal(A.addDays("2026-03-28", 2), "2026-03-30");
  assert.equal(A.addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(A.addDays("2024-03-01", -1), "2024-02-29", "leap year");
  assert.equal(A.addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(A.addMonths("2026-01", -1), "2025-12");
  assert.equal(A.addMonths("2026-12", 1), "2027-01");
  assert.equal(A.daysInMonth("2026-02"), 28);
  assert.equal(A.daysBetween("2026-03-28", "2026-03-30"), 2, "the clock change of a spring weekend does not shift a day");

  const inv = (n, date, total) => sampleInvoice({ number: n, date: date + "T12:00:00", total, subtotal: total, discount: 0, items: [], payments: [] });
  const data = { invoices: [inv(1, "2026-02-03", 1000), inv(2, "2026-02-28", 2000), inv(3, "2026-03-01", 500), inv(4, "2026-03-31", 700)], products: [] };
  const f = A.compute(data, { today: "2026-03-31" });
  assert.equal(f.cards.month.sales, 1200, "March so far");
  assert.equal(f.cards.month.elapsedDays, 31);
  assert.equal(f.cards.month.previousSameDays, 3000, "February has only 28 days: 31 elapsed days are capped at its last day");
  assert.equal(f.cards.month.previousFull, 3000);
  assert.equal(f.cards.month.pct, -60);
  const early = A.compute(data, { today: "2026-03-10" });
  assert.equal(early.cards.month.sales, 500);
  assert.equal(early.cards.month.previousSameDays, 1000, "1-10 February only: the 28th is not counted yet");
  assert.equal(early.summary.previousFull, 3000, "the full previous month is kept as its own figure");
  assert.equal(A.compute(data, { today: "2026-01-05" }).summary.previousMonth, "2025-12", "across a year end");
});

test("percentage change is only given when there is something to compare with", () => {
  assert.equal(A.pctChange(150, 100), 50);
  assert.equal(A.pctChange(50, 100), -50);
  assert.equal(A.pctChange(100, 0), null);
  assert.equal(A.pctChange(0, 0), null);
  assert.equal(A.pctChange(112.5, 100), 12.5);
});

test("carried-forward debt is owed once and is never revenue", () => {
  const old = sampleInvoice({ number: 1, date: dayIso(-20), customer: { name: "Ali", phone: "0555 12 34 56", address: "" }, items: [], subtotal: 10000, discount: 0, total: 10000, payments: [] });
  const next = sampleInvoice({
    number: 2, date: dayIso(0), customer: { name: "Ali", phone: "0555 12 34 56", address: "" }, items: [], subtotal: 5000, discount: 0, total: 5000, payments: [],
    carriedForward: [{ sourceInvoiceId: old.id, sourceInvoiceNumber: old.invoiceNumber, amount: 10000 }],
  });
  const transfers = [{ id: "t1", sourceInvoiceId: old.id, sourceInvoiceNumber: old.invoiceNumber, targetInvoiceId: next.id, targetInvoiceNumber: next.invoiceNumber, amount: 10000 }];
  const f = A.compute({ invoices: [old, next], products: [], debtTransfers: transfers }, { now: new Date() });
  assert.equal(f.cards.outstanding.total, 15000, "10,000 old + 5,000 new, each once");
  assert.equal(f.cards.outstanding.invoices, 1, "only the newer invoice is still collectible");
  assert.equal(f.cards.outstanding.customers, 1);
  assert.equal(f.cards.outstanding.top[0].debt, 15000);
  assert.equal(f.cards.month.sales + f.summary.previousFull, 15000, "revenue is the two purchases (10,000 + 5,000), the carried 10,000 is not added again");
  // The cash that settles carried debt is collected once.
  next.payments = [{ amount: 12000, timestamp: dayIso(0) }];
  const g = A.compute({ invoices: [old, next], products: [], debtTransfers: transfers }, { now: new Date() });
  assert.equal(g.cards.collected.today, 12000);
  assert.equal(g.cards.outstanding.total, 3000);
});

test("customers who owe: biggest balance first, with the number of unpaid invoices and the oldest one", () => {
  const mk = (n, name, phone, daysAgo, total, paid) => sampleInvoice({ number: n, date: dayIso(-daysAgo), customer: { name, phone, address: "" }, items: [], subtotal: total, discount: 0, total, payments: paid ? [{ amount: paid, timestamp: dayIso(-daysAgo) }] : [] });
  const invoices = [mk(1, "Small", "0555 00 00 01", 3, 1000, 0), mk(2, "Big", "0555 00 00 02", 40, 9000, 1000), mk(3, "Big", "0555 00 00 02", 5, 4000, 0), mk(4, "Settled", "0555 00 00 03", 2, 800, 800), mk(5, "Walk-in Customer", "", 1, 700, 0)];
  const f = A.compute({ invoices, products: [] }, { now: new Date() });
  const o = f.cards.outstanding;
  assert.equal(o.total, 1000 + 8000 + 4000 + 700);
  assert.deepEqual(o.top.map((c) => [c.name, c.invoices, c.debt]), [["Big", 2, 12000], ["Small", 1, 1000]]);
  assert.equal(o.top[0].oldest, A.addDays(today(), -40));
  assert.equal(o.unidentifiedInvoices, 1, "a sale with no customer name still counts in the total");
  assert.equal(o.unidentifiedTotal, 700);
});

test("payment status counts and values follow the selected period only", () => {
  const mk = (n, daysAgo, total, paid) => sampleInvoice({ number: n, date: dayIso(-daysAgo), items: [], subtotal: total, discount: 0, total, payments: paid ? [{ amount: paid, timestamp: dayIso(-daysAgo) }] : [] });
  const invoices = [mk(1, 1, 1000, 1000), mk(2, 2, 2000, 500), mk(3, 3, 3000, 0), mk(4, 20, 9000, 0)];
  const week = A.compute({ invoices, products: [] }, { now: new Date(), period: "7" }).status;
  assert.deepEqual(week.count, { paid: 1, partial: 1, unpaid: 1, transferred: 0 });
  assert.deepEqual(week.value, { paid: 1000, partial: 2000, unpaid: 3000, transferred: 0 });
  const thirty = A.compute({ invoices, products: [] }, { now: new Date(), period: "30" }).status;
  assert.equal(thirty.total, 4);
  assert.equal(thirty.value.unpaid, 12000);
});

test("slow-moving stock: only old, in-stock products are judged; new, unrecorded and out-of-stock ones are not", () => {
  const p = (id, name, stock) => sampleProduct({ id, name, stock, tileSize: "60*60", coveragePerBox: 1.44, stockUnit: "box", priceUnit: "box" });
  const sells = p("sells", "Sells well", 10);
  const sleeps = p("sleeps", "Sleeps", 20);
  const fresh = p("fresh", "Brand new", 30);
  const unrecorded = p("unrec", "No history", 8);
  const empty = p("empty", "Sold out", 0);
  const item = (product, qty, total) => ({ productId: product.id, name: product.name, manufacturer: "X", tileSize: "60*60", coveragePerBox: 1.44, sellingUnit: "box", qty, unitPrice: total / qty, total, priceUnit: "box" });
  const invoices = [
    sampleInvoice({ number: 1, date: dayIso(-100), items: [item(sleeps, 2, 4000)], total: 4000, subtotal: 4000, discount: 0, payments: [] }),     // sleeps was sold once, long ago
    sampleInvoice({ number: 2, date: dayIso(-5), items: [item(sells, 5, 10000)], total: 10000, subtotal: 10000, discount: 0, payments: [] }),
    sampleInvoice({ number: 3, date: dayIso(-100), items: [item(sells, 1, 2000)], total: 2000, subtotal: 2000, discount: 0, payments: [] }),
  ];
  const purchases = [{ id: "pu1", status: "confirmed", invoiceDate: A.addDays(today(), -10), lines: [{ productId: "fresh" }] }];     // fresh first appears 10 days ago
  const f = A.compute({ invoices, products: [sells, sleeps, fresh, unrecorded, empty], purchases }, { now: new Date(), slowPeriod: "90" });
  const s = f.leastSelling;
  assert.equal(s.enoughHistory, true);
  assert.deepEqual(s.items.map((x) => [x.name, x.sold]), [["Sleeps", false], ["Sells well", true]], "zero sales first, then the least revenue");
  assert.equal(s.items[0].stock, 20);
  assert.equal(s.noHistory, 1, "no sale or purchase on record: age unknown, not judged");
  assert.equal(s.tooNew, 1, "first seen inside the period: still new");
  assert.equal(s.noStock, 1, "nothing in stock is a stock alert, not slow stock");
  assert.deepEqual(f.alerts.out.map((x) => x.name), ["Sold out"]);
  const young = A.compute({ invoices: [invoices[1]], products: [sells, sleeps] }, { now: new Date(), slowPeriod: "90" }).leastSelling;
  assert.equal(young.enoughHistory, false, "a shop with only a few days of records is not asked to judge 90 days");
  assert.deepEqual(young.items, []);
});

test("stock alerts: below zero, out of stock and low stock are separate, with the same threshold as the Stock page", () => {
  const p = (id, name, stock) => ({ id, name, stock, stockUnit: "box", tileSize: "60*60", manufacturer: "M" });
  const f = A.compute({ products: [p("a", "A", 12), p("b", "B", 5), p("c", "C", 0), p("d", "D", -2), p("e", "E", 1)], invoices: [] }, { now: new Date(), lowStock: 5 });
  assert.deepEqual(f.alerts.negative.map((x) => x.name), ["D"]);
  assert.deepEqual(f.alerts.out.map((x) => x.name), ["C"]);
  assert.deepEqual(f.alerts.low.map((x) => x.name), ["E", "B"], "5 is low (the Stock page says low at 5 or fewer), fewest first");
  assert.equal(f.cards.inventory.products, 5);
  assert.equal(f.cards.inventory.totals[0].qty, 18, "12 + 5 + 1: only stock on hand, no negatives");
});

test("recent sales: newest first, cancelled left out, with paid and remaining", () => {
  const mk = (n, daysAgo, total, paid, extra) => sampleInvoice({ number: n, date: dayIso(-daysAgo), items: [], subtotal: total, discount: 0, total, payments: paid ? [{ amount: paid, timestamp: dayIso(-daysAgo) }] : [], ...extra });
  const cancelled = mk(9, 0, 3000, 3000, { cancellation: { at: dayIso(0), total: 3000, paid: 3000, refund: 3000 }, refunds: [{ id: "r", amount: 3000, timestamp: dayIso(0), reason: "cancellation" }] });
  const f = A.compute({ invoices: [mk(1, 3, 1000, 1000), mk(2, 1, 2000, 500), cancelled], products: [] }, { now: new Date(), recent: 5 });
  assert.deepEqual(f.recent.map((r) => r.invoiceNumber), [V.formatInvoiceNumber(2), V.formatInvoiceNumber(1)]);
  assert.deepEqual([f.recent[0].due, f.recent[0].paid, f.recent[0].remaining, f.recent[0].status], [2000, 500, 1500, "partial"]);
});

/* ==========================================================================
   3. The Dashboard screen
   ========================================================================== */

async function started(options) {
  const app = loadApp(options);
  const storage = await app.start();
  assert.equal(storage.mode, "ready", storage.reason);
  return app;
}

function draw(app) {
  app.api.getState().view = "dashboard";
  app.api.renderAll();
  return app.field("analyticsRoot").innerHTML;
}

function press(app) {
  const listeners = {};
  app.field("analyticsRoot").addEventListener = (type, fn) => { listeners[type] = fn; };
  app.field("dashboardRoot").addEventListener = () => {};
  app.field("purchasesRoot").addEventListener = () => {};
  app.field("suppliersRoot").addEventListener = () => {};
  app.api.Dashboard.bind();
  return async (act, dataset) => {
    const el = { dataset: { act, ...dataset }, tagName: "BUTTON" };
    listeners.click({ target: { closest: (selector) => (selector === "[data-act]" ? el : null) }, preventDefault() {} });
    for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
  };
}

test("screen: an empty shop shows zeros and calm empty states, not errors", async () => {
  const app = await started();
  const html = draw(app).replace(/&#39;/g, "'");
  for (const id of ["Today's sales", "This month's sales", "Money collected", "Outstanding balances", "Inventory", "Sales over time", "Sales and money collected", "Invoice payment status", "Best-selling products", "Slow-moving stock", "Recent sales", "Stock alerts", "Monthly summary"]) {
    assert.ok(html.includes(id), id);
  }
  assert.match(html, /Nothing recorded in this period yet\./);
  assert.match(html, /No sales in this period yet\./);
  assert.match(html, /No invoices yet\./);
  assert.match(html, /Nobody owes anything/);
  assert.match(html, /Nothing needs attention/);
  assert.match(html, /Not enough history yet/);
  assert.doesNotMatch(html, /NaN|undefined|Infinity/);
});

test("screen: a real sale appears in the cards, the lists and the charts, in the same words as the definitions", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 100 });
  await sellLines(ctx, [{ product: tile, qty: "50" }], { name: "Karim Benali", phone: "0555 11 22 33", paid: "40000" });
  const html = draw(ctx.app);
  assert.match(html, /100,000/);
  assert.match(html, /40,000/);
  assert.match(html, /60,000/);
  assert.match(html, /1 unpaid invoice/);
  assert.match(html, /1 customer/);
  assert.match(html, /Karim Benali/);
  assert.match(html, /Everton Grey/);
  assert.match(html, /INV-000001/);
  assert.match(html, /Partial/);
  assert.match(html, /50 Boxes/);
  assert.match(html, /class="dc-bar"/);
  assert.match(html, /never added together/, "the sales-versus-payments explanation is on the page");
  assert.doesNotMatch(html, /NaN|undefined|Infinity/);
});

test("screen: period tabs, product mode and status toggle redraw the figures; buttons open stock, invoices and customers", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 100 });
  const inv = await sellLines(ctx, [{ product: tile, qty: "10" }], { name: "Karim Benali", phone: "0555 11 22 33" });
  const click = press(ctx.app);
  let html = draw(ctx.app);
  assert.equal((html.match(/data-act="dc-period"/g) || []).length, 4);
  await click("dc-period", { v: "7" });
  assert.equal(ctx.app.api.Dashboard.state.period, "7");
  assert.equal((ctx.app.field("analyticsRoot").innerHTML.match(/class="dc-bar"/g) || []).length, 14, "7 bars for sales, 7 pairs for sales vs collected");
  await click("dc-period", { v: "12m" });
  assert.match(ctx.app.field("analyticsRoot").innerHTML, /by month/);
  await click("dc-pmode", { v: "quantity" });
  assert.match(ctx.app.field("analyticsRoot").innerHTML, /dc-unit/);
  await click("dc-status", { v: "value" });
  assert.match(ctx.app.field("analyticsRoot").innerHTML, /20,000/);
  await click("dc-period", { v: "bogus" });
  assert.equal(ctx.app.api.Dashboard.state.period, "12m", "an unknown choice is ignored");

  await click("dc-product", { id: tile.id });
  assert.equal(ctx.app.api.getState().view, "stock");
  assert.equal(ctx.app.api.getState().stockFocusId, tile.id);
  ctx.app.api.showView("dashboard");
  await click("dc-customer", { name: "Karim Benali" });
  assert.equal(ctx.app.api.getState().view, "invoices");
  assert.equal(ctx.app.field("invoiceFilter").value, "Karim Benali");
  ctx.app.api.showView("dashboard");
  await click("dc-invoice", { id: inv.id });
  assert.equal(ctx.app.api.getState().view, "sell", "an invoice opens the way the Invoices page opens it");
  assert.equal(ctx.app.api.getState().previewInvoice.id, inv.id);
  ctx.app.api.showView("dashboard");
  await click("dc-invoices");
  assert.equal(ctx.app.api.getState().view, "invoices");
});

test("screen: names typed by the user can not inject markup", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { name: "<img src=x onerror=alert(1)>", stock: 100 });
  await sellLines(ctx, [{ product: tile, qty: "3" }], { name: "<b>Evil</b>", phone: "0555 55 55 55" });
  const html = draw(ctx.app);
  assert.doesNotMatch(html, /<img src=x|<b>Evil/);
  assert.match(html, /&lt;b&gt;Evil&lt;\/b&gt;/);
});

test("screen: the Dashboard reads in French, and dates and amounts follow the language", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 100 });
  await sellLines(ctx, [{ product: tile, qty: "50" }], { name: "Karim", phone: "0555 11 22 33" });
  await ctx.api.commit((d) => { d.settings.language = "fr"; });
  const html = draw(ctx.app);
  for (const text of ["Ventes du jour", "Argent encaissé", "Soldes impayés", "Produits les plus vendus", "Stock à rotation lente", "Ventes récentes", "Alertes de stock", "Résumé du mois"]) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /Today's sales|Best-selling/);
  assert.match(html, /100[\s\u00a0\u202f]000/, "French grouping of 100 000");
});

test("screen: the Dashboard draws only on its own page, and redraws after a payment", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 100 });
  const inv = await sellLines(ctx, [{ product: tile, qty: "10" }], { name: "Ali", phone: "0555 77 77 77" });
  ctx.app.api.getState().view = "dashboard";
  ctx.app.api.renderAll();
  assert.match(ctx.app.field("analyticsRoot").innerHTML, /20,000/);
  await ctx.api.addPayment(inv.id, "5000");
  ctx.app.api.renderAll();
  assert.match(ctx.app.field("analyticsRoot").innerHTML, /15,000/, "the balance followed the payment");
  const marker = ctx.app.field("analyticsRoot").innerHTML;
  ctx.app.api.getState().view = "stock";
  ctx.app.field("analyticsRoot").innerHTML = "untouched";
  ctx.app.api.renderAll();
  assert.equal(ctx.app.field("analyticsRoot").innerHTML, "untouched", "nothing is drawn while another page is open");
  assert.ok(marker.length > 100);
});

test("screen: the Dashboard never writes anything", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 100 });
  await sellLines(ctx, [{ product: tile, qty: "10" }], { name: "Ali", phone: "0555 77 77 77", paid: "1000" });
  const before = JSON.stringify(await ctx.api.db.loadAll());
  const stateBefore = JSON.stringify({ i: ctx.api.getState().invoices, p: ctx.api.getState().products });
  draw(ctx.app);
  const click = press(ctx.app);
  await click("dc-period", { v: "7" });
  await click("dc-pmode", { v: "quantity" });
  assert.equal(JSON.stringify(await ctx.api.db.loadAll()), before, "the database is exactly as it was");
  assert.equal(JSON.stringify({ i: ctx.api.getState().invoices, p: ctx.api.getState().products }), stateBefore);
});

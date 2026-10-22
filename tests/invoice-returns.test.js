"use strict";

// Product returns handled inside the normal "Edit invoice" flow (the invoice is edited on the Sell page; no separate Returns module).
// A returned box is a quantity reduced on the saved invoice: the totals follow, the difference goes back to stock,
// payments are never touched, and a paid invoice that got cheaper shows a refund / credit due instead of a fake payment.
// Everything runs through the application's own functions against a disposable in-memory IndexedDB.

const test = require("node:test");
const assert = require("node:assert/strict");
const { failPutWith } = require("./helpers/modules");
const {
  V, plain, round2, boot, addTile, sellLines, stockOf, invoiceById, snapshot, openEdit, typeQty, removeLine, setQty,
} = require("./helpers/edit");

/* ==========================================================================
   1-2. A returned quantity: totals follow, exactly the difference goes back to stock
   ========================================================================== */

test("15 boxes -> 14: line total, invoice total and balance follow, and exactly 1 box returns to stock", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx);
  const inv = await sellLines(ctx, [{ product: tile, qty: "15" }], { paid: "20000" });   // 30,000 total, 20,000 paid
  assert.equal(inv.total, 30000);
  assert.equal(stockOf(ctx.api, tile.id), 5);
  const original = plain(inv);

  const plan = await setQty(ctx, inv, 14);
  assert.equal(plan.error, undefined);

  const saved = invoiceById(ctx.api, inv.id);
  assert.equal(saved.items[0].qty, 14);
  assert.equal(saved.items[0].unitPrice, 2000, "the price it was sold at");
  assert.equal(saved.items[0].total, 28000);
  assert.equal(saved.subtotal, 28000);
  assert.equal(saved.total, 28000);
  assert.equal(stockOf(ctx.api, tile.id), 6, "exactly one box back: 5 + 1");
  // Same record: id, number, date, customer.
  assert.equal(saved.id, original.id);
  assert.equal(saved.invoiceNumber, original.invoiceNumber);
  assert.equal(saved.date, original.date);
  assert.deepEqual(plain(saved.customer), original.customer);
  assert.equal(ctx.api.getInvoices().length, 1, "no second invoice was created");
  // Payments untouched; balance 28,000 - 20,000 = 8,000 (the 10,000 owed before, minus the 2,000 box).
  assert.deepEqual(plain(saved.payments), original.payments);
  const info = ctx.api.paymentInfo(saved);
  assert.equal(info.paid, 20000);
  assert.equal(info.remaining, 8000);
  assert.equal(info.refundDue, 0);
  assert.match(info.status, /partial/i);
});

test("15 boxes -> 12 restores exactly 3 boxes (never the whole new quantity)", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx);
  const inv = await sellLines(ctx, [{ product: tile, qty: "15" }]);
  await setQty(ctx, inv, 12);
  assert.equal(stockOf(ctx.api, tile.id), 8, "20 - 15 sold + 3 returned");
  assert.equal(invoiceById(ctx.api, inv.id).total, 24000);
});

test("pieces and square metres: the difference goes back using the product's own stock conversion", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx);                          // 4 pieces per box (60x60, 1.44 m² per box)
  const inv = await sellLines(ctx, [{ product: tile, qty: "10", unit: "piece" }]);
  assert.equal(stockOf(ctx.api, tile.id), 17.5, "10 pieces = 2.5 boxes");
  await setQty(ctx, inv, 8);                                // 2 pieces back = half a box
  assert.equal(stockOf(ctx.api, tile.id), 18);
  assert.equal(invoiceById(ctx.api, inv.id).items[0].qty, 8);
  assert.equal(invoiceById(ctx.api, inv.id).items[0].sellingUnit, "piece");

  // A product counted in square metres: 20 m² -> 15 m² gives 5 m² back.
  const roll = await addTile(ctx, { name: "Floor screed", sku: "FS-1", tileSize: "", coveragePerBox: null, priceUnit: "m2", sellingPrice: 500, stockUnit: "m2", stock: 100 });
  const inv2 = await sellLines(ctx, [{ product: roll, qty: "20", unit: "m2" }], { name: "Sam" });
  assert.equal(stockOf(ctx.api, roll.id), 80);
  await setQty(ctx, inv2, 15);
  assert.equal(stockOf(ctx.api, roll.id), 85, "exactly 5 m² back");
  assert.equal(invoiceById(ctx.api, inv2.id).total, 7500);
});

/* ==========================================================================
   3. No duplicate adjustments
   ========================================================================== */

test("saving an invoice again, with or without a change of text, never moves stock a second time", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx);
  const inv = await sellLines(ctx, [{ product: tile, qty: "15" }]);
  await setQty(ctx, inv, 14);
  assert.equal(stockOf(ctx.api, tile.id), 6);
  const revision = (await ctx.api.db.loadAll()).revision;

  for (let n = 0; n < 3; n++) {
    openEdit(ctx, inv);
    await ctx.api.saveInvoiceEdit();                         // nothing changed
  }
  assert.equal(stockOf(ctx.api, tile.id), 6, "still 6");
  assert.equal((await ctx.api.db.loadAll()).revision, revision, "nothing was written");

  // The same quantity typed again (as text "14.0") is also no change.
  openEdit(ctx, inv);
  typeQty(ctx.api, 0, "14.0");
  await ctx.api.saveInvoiceEdit();
  assert.equal(stockOf(ctx.api, tile.id), 6);
  assert.equal(invoiceById(ctx.api, inv.id).edits.length, 1, "no extra history entry either");
});

test("editing the same invoice several times works from the saved quantity each time (15 -> 14 -> 12 -> 13 -> 15)", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx);
  const inv = await sellLines(ctx, [{ product: tile, qty: "15" }]);
  const steps = [[14, 6], [12, 8], [13, 7], [15, 5]];
  for (const [qty, stock] of steps) {
    await setQty(ctx, inv, qty);
    assert.equal(stockOf(ctx.api, tile.id), stock, `after ${qty} boxes`);
    assert.equal(invoiceById(ctx.api, inv.id).total, qty * 2000);
  }
  assert.equal(invoiceById(ctx.api, inv.id).edits.length, 4);
});

/* ==========================================================================
   4-5. Removing lines, adding lines, increasing
   ========================================================================== */

test("removing a whole line puts back what it took; the other line and its stock are untouched", async () => {
  const ctx = await boot();
  const a = await addTile(ctx);
  const b = await addTile(ctx, { name: "Pietra Beige", sku: "PB-1", sellingPrice: 3000 });
  const inv = await sellLines(ctx, [{ product: a, qty: "4" }, { product: b, qty: "3" }], { paid: "5000" });
  assert.equal(inv.total, 4 * 2000 + 3 * 3000);
  const sale = openEdit(ctx, inv);
  removeLine(ctx.api, sale.items.findIndex((l) => l.productId === b.id));
  assert.equal(ctx.api.editPlan().cancelled, undefined, "one line is left: this is an edit, not a cancellation");
  await ctx.api.saveInvoiceEdit();
  assert.equal(stockOf(ctx.api, b.id), 20, "all 3 boxes back");
  assert.equal(stockOf(ctx.api, a.id), 16, "unchanged");
  const saved = invoiceById(ctx.api, inv.id);
  assert.equal(saved.items.length, 1);
  assert.equal(saved.total, 8000);
  assert.equal(ctx.api.paymentInfo(saved).remaining, 3000);
});

test("removing the last line is a complete cancellation: refused answer changes nothing, the confirmation cancels it", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx);
  const inv = await sellLines(ctx, [{ product: tile, qty: "2" }], { paid: "1000" });
  const before = await snapshot(ctx);
  openEdit(ctx, inv);
  removeLine(ctx.api, 0);
  const plan = ctx.api.editPlan();
  assert.equal(plan.error, undefined);
  assert.equal(plan.cancelled, true);
  assert.equal(plan.refund, 1000, "what was collected");
  ctx.app.answer(false);                                     // the person says "no" in the dialog
  await ctx.api.saveInvoiceEdit();
  assert.deepEqual(await snapshot(ctx), before, "declining changes nothing");
  assert.equal(ctx.api.getInvoiceEdit() !== null, true, "the edit stays open");
});

test("increasing a quantity takes the additional stock, also after a reduction; too much is refused and changes nothing", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx);
  const inv = await sellLines(ctx, [{ product: tile, qty: "15" }]);   // stock 5
  await setQty(ctx, inv, 12);                                          // stock 8
  await setQty(ctx, inv, 14);                                          // takes 2 more: stock 6
  assert.equal(stockOf(ctx.api, tile.id), 6);
  assert.equal(invoiceById(ctx.api, inv.id).total, 28000);

  const before = await snapshot(ctx);
  // The Sell page itself refuses the quantity (needs 7 more, only 6 available) ...
  openEdit(ctx, invoiceById(ctx.api, inv.id));
  const typed = typeQty(ctx.api, 0, 21);
  assert.match(typed.error, /stock/i);
  assert.equal(ctx.api.getSale().items[0].qty, 20, "the line stays at the most the stock allows (14 + 6)");
  ctx.api.cancelInvoiceEdit();
  // ... and so does the database rule, if a stale screen sends the quantity anyway.
  const plan = await setQty(ctx, invoiceById(ctx.api, inv.id), 21, 0, { force: true });
  assert.match(plan.error, /Not enough stock/);
  assert.deepEqual(await snapshot(ctx), before, "a refused edit changes nothing");
  assert.equal(ctx.api.getInvoiceEdit() !== null, true, "the screen stays open with what was typed");
});

test("adding another product during the edit takes its stock and adds to the total", async () => {
  const ctx = await boot();
  const a = await addTile(ctx);
  const b = await addTile(ctx, { name: "Pietra Beige", sku: "PB-1", sellingPrice: 3000 });
  const inv = await sellLines(ctx, [{ product: a, qty: "2" }]);
  openEdit(ctx, inv);
  assert.equal(ctx.api.addToSale(b.id, "3", "box").ok, true);
  await ctx.api.saveInvoiceEdit();
  assert.equal(stockOf(ctx.api, b.id), 17);
  assert.equal(invoiceById(ctx.api, inv.id).total, 2 * 2000 + 3 * 3000);
  assert.equal(invoiceById(ctx.api, inv.id).items.length, 2);
});

/* ==========================================================================
   6. Payments, balances, refund / credit
   ========================================================================== */

test("a fully paid invoice that gets cheaper is saved: payments untouched, no cash recorded as refunded, refund due shown", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx);
  const inv = await sellLines(ctx, [{ product: tile, qty: "15" }], { paid: "30000" });
  const original = plain(inv);
  assert.match(ctx.api.paymentInfo(inv).status, /^paid$/i);

  const plan = await setQty(ctx, inv, 14);
  assert.equal(plan.error, undefined);
  assert.equal(plan.refundDue, 2000);
  assert.equal(stockOf(ctx.api, tile.id), 6);

  const saved = invoiceById(ctx.api, inv.id);
  assert.equal(saved.total, 28000);
  assert.deepEqual(plain(saved.payments), original.payments, "the payment history is never rewritten");
  assert.equal(saved.payments.length, 1);
  assert.equal(saved.refunds, undefined, "nothing was handed back yet, so no refund is recorded");
  const info = ctx.api.paymentInfo(saved);
  assert.equal(info.paid, 30000, "the customer really paid 30,000");
  assert.equal(info.remaining, 0);
  assert.equal(info.refundDue, 2000, "and is owed 2,000 back");
  assert.match(info.status, /^paid$/i);

  // Going back up removes the refund.
  openEdit(ctx, saved);
  typeQty(ctx.api, 0, 15);
  await ctx.api.saveInvoiceEdit();
  const back = invoiceById(ctx.api, inv.id);
  assert.equal(ctx.api.paymentInfo(back).refundDue, 0);
  assert.equal(ctx.api.paymentInfo(back).remaining, 0);
});

test("the refund due appears on the Sell page summary, the pay box and the printed invoice", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx);
  const inv = await sellLines(ctx, [{ product: tile, qty: "15" }], { paid: "30000" });
  openEdit(ctx, inv);
  typeQty(ctx.api, 0, 14);
  ctx.api.renderTotals();
  const summary = ctx.app.field("tEditRows").innerHTML;
  assert.match(summary, /Refund \/ credit due to the customer/);
  assert.match(summary, /Returned to stock/);
  assert.match(summary, /1 Box/);
  assert.equal(ctx.app.field("editSave").disabled, false, "the edit can be saved");
  assert.equal(ctx.app.field("editSavePrint").disabled, false);
  assert.equal(ctx.app.field("editBanner").hidden, false);

  await ctx.api.saveInvoiceEdit();
  ctx.api.viewInvoice(inv.id);
  const page = ctx.app.field("invoice").innerHTML;
  assert.match(page, /Refund \/ credit due to customer/);
  assert.match(page, /2,000/);
  assert.match(ctx.app.field("payRefund").textContent, /2,000/);
  assert.equal(ctx.app.field("payRefundRow").hidden, false);
  assert.equal(ctx.app.field("refundForm").hidden, false);

  // An invoice that owes nothing back shows none of it.
  const plain2 = await sellLines(ctx, [{ product: tile, qty: "1" }], { name: "Other" });
  ctx.api.viewInvoice(plain2.id);
  assert.doesNotMatch(ctx.app.field("invoice").innerHTML, /Refund/);
  assert.equal(ctx.app.field("payRefundRow").hidden, true);
  assert.equal(ctx.app.field("refundForm").hidden, true);
});

test("carried-forward debt: the old invoice can't drop below what was paid plus what moved on; the new invoice's refund counts only its own purchase", async () => {
  const ctx = await boot();
  const { api } = ctx;
  const tile = await addTile(ctx);
  const karim = { name: "Karim Benali", phone: "0555 11 22 33" };
  // INV-000001: 5 boxes = 10,000, 4,000 paid, 6,000 owed.
  const first = await sellLines(ctx, [{ product: tile, qty: "5" }], { ...karim, paid: "4000" });
  // INV-000002: 2 boxes = 4,000, carries the 6,000 and is paid in full (10,000).
  assert.equal(api.addToSale(tile.id, "2", "box").ok, true);
  api.getSale().customer.name = karim.name;
  api.getSale().customer.phone = karim.phone;
  api.onCustomerSettled();
  const carried = api.addDebtToSale([{ sourceInvoiceId: first.id, amount: 6000 }]);
  assert.equal(carried.error, undefined, carried.error);
  api.getSale().paidValue = "10000";
  await api.completeSale();
  const second = api.getInvoices()[1];
  assert.equal(api.paymentInfo(second).due, 10000);
  assert.equal(api.paymentInfo(second).remaining, 0);

  // The old invoice: 4 boxes would be 8,000, but 4,000 was paid and 6,000 now sits on INV-000002.
  const before = await snapshot(ctx);
  openEdit(ctx, first);
  typeQty(api, 0, 4);
  assert.match(api.editPlan().error || "", /./, "refused: more would be owed elsewhere than this invoice asks for");
  await api.saveInvoiceEdit();
  assert.deepEqual(await snapshot(ctx), before, "nothing changed");
  api.cancelInvoiceEdit();

  // The new invoice: returning one box lowers ITS purchase to 2,000; the 6,000 carried debt is not part of the refund.
  openEdit(ctx, second);
  typeQty(api, 0, 1);
  const plan = api.editPlan();
  assert.equal(plan.error, undefined, plan.error);
  assert.equal(plan.refundDue, 2000, "10,000 paid - (2,000 purchase + 6,000 carried) = 2,000");
  await api.saveInvoiceEdit();
  assert.equal(stockOf(api, tile.id), 20 - 5 - 1, "5 sold on the first invoice, 1 net on the second");
  assert.equal(api.paymentInfo(invoiceById(api, second.id)).refundDue, 2000);
  assert.equal(api.paymentInfo(invoiceById(api, second.id)).paid, 10000);
});

/* ==========================================================================
   7. Discounts, tax and unit conversions
   ========================================================================== */

test("a percent discount and tax follow the new quantity; a fixed discount stays the same amount", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx);
  const pct = await sellLines(ctx, [{ product: tile, qty: "15" }], { name: "Pct", discount: { type: "percent", value: "10" }, tax: { type: "percent", value: "19" } });
  assert.equal(pct.total, round2((30000 - 3000) * 1.19));       // 32,130
  await setQty(ctx, pct, 14);
  const savedPct = invoiceById(ctx.api, pct.id);
  assert.equal(savedPct.subtotal, 28000);
  assert.equal(savedPct.discount, 2800);
  assert.equal(savedPct.tax, round2((28000 - 2800) * 0.19));
  assert.equal(savedPct.total, round2((28000 - 2800) * 1.19));

  const fixed = await sellLines(ctx, [{ product: tile, qty: "3" }], { name: "Fixed", discount: { type: "amount", value: "500" } });
  await setQty(ctx, fixed, 2);
  const savedFixed = invoiceById(ctx.api, fixed.id);
  assert.equal(savedFixed.discount, 500);
  assert.equal(savedFixed.total, 4000 - 500);
});

test("a per-m² product sold by the box keeps its sold price and unit through a return", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { sellingPrice: 800, priceUnit: "m2" });          // 800 DA/m² x 1.44 m² = 1,152 per box
  const inv = await sellLines(ctx, [{ product: tile, qty: "15" }]);
  assert.equal(inv.items[0].unitPrice, 1152);
  await setQty(ctx, inv, 14);
  const saved = invoiceById(ctx.api, inv.id);
  assert.equal(saved.items[0].unitPrice, 1152);
  assert.equal(saved.items[0].sellingUnit, "box");
  assert.equal(saved.items[0].unitPriceUnit, "box");
  assert.equal(saved.total, 16128);
  // The catalogue price changes later: the edited invoice still uses the price it was sold at.
  await ctx.api.commit((d) => { const p = d.products.find((x) => x.id === tile.id); p.sellingPrice = 5000; p.sellingPrices = [{ unit: "m2", price: 5000 }]; });
  await setQty(ctx, saved, 13);
  assert.equal(invoiceById(ctx.api, inv.id).items[0].unitPrice, 1152);
  assert.equal(invoiceById(ctx.api, inv.id).total, 13 * 1152);
});

/* ==========================================================================
   8. Reload and backup
   ========================================================================== */

test("after a reload the edited invoice, the stock and the history are as saved; the backup file equals the database", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx);
  const inv = await sellLines(ctx, [{ product: tile, qty: "15" }], { paid: "30000" });
  await setQty(ctx, inv, 14);

  await ctx.api.loadFromDatabase();
  const saved = invoiceById(ctx.api, inv.id);
  assert.equal(saved.items[0].qty, 14);
  assert.equal(saved.total, 28000);
  assert.equal(stockOf(ctx.api, tile.id), 6);
  assert.equal(ctx.api.paymentInfo(saved).refundDue, 2000);

  // A completely new start of the app on the same stored data.
  const second = await boot({ indexedDB: ctx.app.indexedDB });
  const again = second.api.getState().invoices.find((i) => i.id === inv.id);
  assert.equal(again.total, 28000);
  assert.equal(second.api.getState().products.find((p) => p.id === tile.id).stock, 6);

  await ctx.api.autoBackup.flushNow();
  const parsed = V.parseBackup(ctx.handle.content);
  assert.equal(parsed.error, undefined, parsed.error);
  assert.deepEqual(plain(parsed.data.invoices.map(V.stripDerived)), plain((await ctx.api.db.loadAll()).invoices));
  assert.deepEqual(parsed.warnings, [], "an overpayment explained by a recorded edit is not reported as damage");
});

test("payments above the total with no recorded edit behind them are still reported when a backup is read", () => {
  const unexplained = { ...plain(sampleInvoiceLike()), payments: [{ amount: 5000, timestamp: new Date().toISOString() }] };
  assert.ok(V.invoiceWarnings(unexplained).some((w) => /more than the invoice total/.test(w)));
  const explained = { ...unexplained, edits: [{ at: new Date().toISOString(), totalBefore: 6000, totalAfter: 1900, paid: 5000, refundDue: 3100 }] };
  assert.deepEqual(V.invoiceWarnings(explained), []);
  const stale = { ...unexplained, edits: [{ at: new Date().toISOString(), totalBefore: 6000, totalAfter: 1900, paid: 5000, refundDue: 100 }] };
  assert.ok(V.invoiceWarnings(stale).length > 0, "an edit that explains a different amount does not hide the overpayment");
  // A refund handed back since the edit leaves less held than the edit said was due: still explained, not damage.
  const partlyRefunded = { ...explained, refunds: [{ id: "r1", amount: 1000, timestamp: new Date().toISOString(), reason: "refund" }] };
  assert.deepEqual(V.invoiceWarnings(partlyRefunded), []);
});

function sampleInvoiceLike() {
  const { sampleInvoice } = require("./helpers/modules");
  return sampleInvoice({});   // total 1,900
}

/* ==========================================================================
   9. Printing
   ========================================================================== */

test("Save and print saves first, then prints the SAVED invoice: new quantity, total, paid, balance; never the old values", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx);
  const inv = await sellLines(ctx, [{ product: tile, qty: "15" }], { paid: "20000" });
  openEdit(ctx, inv);
  typeQty(ctx.api, 0, 14);
  await ctx.api.saveInvoiceEdit({ print: true });

  assert.equal(ctx.print.calls, 1, "printed once");
  const saved = invoiceById(ctx.api, inv.id);
  assert.equal(saved.total, 28000, "saved");
  const page = ctx.app.field("invoice").innerHTML;
  assert.match(page, /INV-000001/);
  assert.match(page, />14 Boxes</, "the new quantity");
  assert.match(page, /28,000/, "the new line and invoice total");
  assert.match(page, /20,000/, "the amount actually paid");
  assert.match(page, /8,000/, "the new balance");
  assert.doesNotMatch(page, /30,000/, "no stale total");
  assert.doesNotMatch(page, />15 Boxes</, "no stale quantity");
  assert.equal(ctx.api.getInvoiceEdit(), null);
});

test("Save and print on a paid invoice prints the refund due; a failing printer leaves the edit saved", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx);
  const inv = await sellLines(ctx, [{ product: tile, qty: "15" }], { paid: "30000" });
  ctx.print.fail = true;
  openEdit(ctx, inv);
  typeQty(ctx.api, 0, 14);
  await ctx.api.saveInvoiceEdit({ print: true });
  assert.equal(ctx.print.calls, 1);
  assert.equal(invoiceById(ctx.api, inv.id).total, 28000, "saved even though printing failed");
  assert.equal(stockOf(ctx.api, tile.id), 6);
  assert.match(ctx.app.toast(), /could not open the print window/);
  assert.match(ctx.app.field("invoice").innerHTML, /Refund \/ credit due to customer/);
});

test("Save and print does not print when the edit is refused", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx);
  const inv = await sellLines(ctx, [{ product: tile, qty: "2" }]);
  openEdit(ctx, inv);
  ctx.api.getSale().items[0].qty = 500;                      // what a stale screen could hold
  await ctx.api.saveInvoiceEdit({ print: true });
  assert.equal(ctx.print.calls, 0);
  assert.equal(invoiceById(ctx.api, inv.id).items[0].qty, 2);
});

test("Save and print is not offered for a cancellation", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx);
  const inv = await sellLines(ctx, [{ product: tile, qty: "2" }], { paid: "1000" });
  openEdit(ctx, inv);
  removeLine(ctx.api, 0);
  ctx.api.renderTotals();
  assert.equal(ctx.app.field("editSave").disabled, false);
  assert.equal(ctx.app.field("editSavePrint").disabled, true);
});

/* ==========================================================================
   History
   ========================================================================== */

test("every edit keeps its own history entry: what was paid, which lines changed (before and after) and the stock moved", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx);
  const inv = await sellLines(ctx, [{ product: tile, qty: "15" }], { paid: "30000" });
  await setQty(ctx, inv, 14);
  await setQty(ctx, inv, 12);

  const saved = invoiceById(ctx.api, inv.id);
  assert.equal(saved.edits.length, 2);
  const [one, two] = plain(saved.edits);
  assert.equal(one.totalBefore, 30000);
  assert.equal(one.totalAfter, 28000);
  assert.equal(one.paid, 30000);
  assert.equal(one.refundDue, 2000);
  assert.equal(one.lines.length, 1);
  assert.equal(one.lines[0].qtyBefore, 15);
  assert.equal(one.lines[0].qtyAfter, 14);
  assert.equal(one.lines[0].unit, "box");
  assert.match(one.lines[0].name, /Everton Grey/);
  assert.deepEqual(one.stock.map((s) => [s.productId, s.change]), [[tile.id, 1]]);
  assert.equal(two.totalBefore, 28000);
  assert.equal(two.totalAfter, 24000);
  assert.equal(two.refundDue, 6000);
  assert.equal(two.lines[0].qtyBefore, 14);
  assert.deepEqual(two.stock.map((s) => s.change), [2]);
  assert.equal(V.invoiceProblem(V.stripDerived(plain(saved))), "", "still a valid invoice");

  // An edit that only changes the customer's name records no line and no stock.
  openEdit(ctx, saved);
  ctx.api.getSale().customer.name = "Alex B.";
  await ctx.api.saveInvoiceEdit();
  const last = invoiceById(ctx.api, inv.id).edits[2];
  assert.equal(last.lines, undefined);
  assert.equal(last.stock, undefined);
});

/* ==========================================================================
   Failed saves
   ========================================================================== */

test("a write failure at any point of the edit saves nothing: invoice, stock and revision stay as they were", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx);
  const inv = await sellLines(ctx, [{ product: tile, qty: "15" }], { paid: "20000" });
  const before = await snapshot(ctx);
  let failures = 0;

  for (const onCall of [1, 2, 3]) {
    openEdit(ctx, inv);
    typeQty(ctx.api, 0, 14);
    const restore = failPutWith("QuotaExceededError", onCall);
    try {
      await ctx.api.saveInvoiceEdit();
    } finally {
      restore();
    }
    if (invoiceById(ctx.api, inv.id).items[0].qty === 14) break;     // that write number does not exist: the edit went through
    failures++;
    assert.deepEqual(await snapshot(ctx), before, `nothing saved when write #${onCall} fails`);
    assert.equal(stockOf(ctx.api, tile.id), 5, "memory still matches the database");
    assert.equal(ctx.api.getInvoiceEdit() !== null, true, "the screen stays open with what was typed");
    assert.equal(ctx.api.getSale().items[0].qty, 14);
    ctx.api.cancelInvoiceEdit();
  }
  assert.ok(failures >= 2, "an edit writes at least the invoice and the product");

  // The same edit works once the disk problem is gone, and moves the stock exactly once.
  openEdit(ctx, inv);
  typeQty(ctx.api, 0, 14);
  await ctx.api.saveInvoiceEdit();
  assert.equal(stockOf(ctx.api, tile.id), 6);
  assert.equal(invoiceById(ctx.api, inv.id).total, 28000);
});

test("an edit made stale by another window is refused instead of adjusting stock from an old quantity", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx);
  const inv = await sellLines(ctx, [{ product: tile, qty: "15" }]);
  openEdit(ctx, inv);
  typeQty(ctx.api, 0, 14);
  // Meanwhile (another window) the persisted quantity became 12 and 3 boxes went back to stock.
  await ctx.api.commit((d) => {
    const i = d.invoices.find((x) => x.id === inv.id);
    i.items[0].qty = 12; i.items[0].stockDeducted = 12; i.items[0].total = 24000; i.subtotal = 24000; i.total = 24000;
    d.products.find((p) => p.id === tile.id).stock = 8;
  });
  await ctx.api.saveInvoiceEdit();
  assert.equal(invoiceById(ctx.api, inv.id).items[0].qty, 12, "the newer saved quantity wins");
  assert.equal(stockOf(ctx.api, tile.id), 8, "stock was not adjusted from the outdated 15");
});

/* ==========================================================================
   The page and the texts
   ========================================================================== */

test("the new buttons, rows and texts exist in the page and in both languages", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  for (const id of ["editBanner", "editSave", "editSavePrint", "editCancel", "tEditRows", "payRefundRow", "payRefund", "payRefundedRow", "refundForm", "payCancelRow"]) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.doesNotMatch(html, /id="view-editinvoice"/, "there is no separate edit screen any more");
  for (const lang of ["en", "fr"]) {
    const text = fs.readFileSync(path.join(__dirname, "..", "java script", "lang", lang + ".js"), "utf8");
    for (const key of ["edit.refundDue", "edit.stockBack", "edit.stockTaken", "edit.saveAndPrint", "edit.printFailed", "inv.refundDue", "pay.refund", "invoices.refundDue",
      "edit.cancelConfirm", "inv.cancelledBanner", "refund.record"]) {
      assert.match(text, new RegExp(`"${key.replace(".", "\\.")}"`), `${lang}: ${key}`);
    }
    assert.doesNotMatch(text, /"edit\.overpaid"/, `${lang}: the old refusal text is gone`);
  }
});

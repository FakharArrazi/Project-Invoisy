"use strict";

// Editing a saved invoice on the Sell page, and cancelling a sale with a refund.
//   A  edit phone, quantity and price: same invoice, same number and date, no new invoice, no counter change
//   B  remove one product: its stock comes back
//   C  10 boxes -> 6: exactly 4 return to stock
//   D  add a product: it gets today's catalogue price in the unit the catalogue prices it in
//   E  remove every product: complete cancellation + refund (stock, payments kept, cancelled, excluded, no double refund)
//   F  refund = what was actually collected (30,000 total / 20,000 paid -> 20,000)
//   G  per-piece, per-box and per-m² pricing units stay the same in Sell, edit, preview, saved invoice, print and details
//   H  failures: nothing half-saved; no double cancellation (also not through the database); everything survives a reload
//   I  a catalogue price change never rewrites a saved line
// Everything runs through the application's own functions against a disposable in-memory IndexedDB (no real data).

const test = require("node:test");
const assert = require("node:assert/strict");
const { failPutWith } = require("./helpers/modules");
const {
  V, plain, boot, addTile, sellLines, stockOf, invoiceById, snapshot, openEdit, typeQty, typePrice, removeLine,
} = require("./helpers/edit");

const CONFIRM_SENTENCE = "You are about to cancel this sale. All original sold quantities will be returned to stock, and the amount actually collected will be recorded as a refund. Continue?";

// Opens the invoice, removes every product and confirms the dialog. Returns what the dialog said.
async function cancelSale(ctx, inv) {
  openEdit(ctx, inv);
  while (ctx.api.getSale().items.length) removeLine(ctx.api, 0);
  const before = ctx.app.confirms.length;
  ctx.app.answer(true);
  await ctx.api.saveInvoiceEdit();
  return ctx.app.confirms.slice(before);
}

/* ==========================================================================
   A. Edit = the Sell page, on the same invoice
   ========================================================================== */

test("A: editing phone, quantity and price happens on the Sell page and updates the SAME invoice", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { sellingPrice: 800, priceUnit: "m2" });
  const inv = await sellLines(ctx, [{ product: tile, qty: "5" }], { paid: "1000", phone: "0550 11" });
  const original = plain(inv);
  const counter = (await ctx.api.db.loadAll()).counter;

  const sale = openEdit(ctx, inv);
  // The Sell page itself is showing the invoice: its own boxes, its own lines, its own totals.
  assert.equal(ctx.app.field("editBanner").hidden, false);
  assert.match(ctx.app.field("editHeading").textContent, new RegExp(inv.invoiceNumber));
  assert.equal(ctx.app.field("view-sell").hidden, false, "the normal Sell view");
  assert.equal(ctx.app.field("custPhone").value, "0550 11");
  assert.equal(ctx.app.field("completeSale").hidden, true, "no new sale can be completed from here");
  assert.equal(ctx.app.field("editSave").hidden, false);
  assert.equal(sale.items.length, 1);

  sale.customer.phone = "0661 22";
  assert.equal(typeQty(ctx.api, 0, 6).error, undefined);
  assert.equal(typePrice(ctx.api, 0, "900").error, undefined);
  await ctx.api.saveInvoiceEdit();

  const saved = invoiceById(ctx.api, inv.id);
  assert.equal(ctx.api.getInvoices().length, 1, "no second invoice");
  assert.equal(saved.id, original.id);
  assert.equal(saved.invoiceNumber, original.invoiceNumber, "same number");
  assert.equal(saved.date, original.date, "same date");
  assert.equal((await ctx.api.db.loadAll()).counter, counter, "the invoice counter did not move");
  assert.equal(saved.customer.phone, "0661 22");
  assert.equal(saved.customer.name, original.customer.name);
  assert.equal(saved.items[0].qty, 6);
  assert.equal(saved.items[0].unitPrice, 900 * 1.44, "900 DA/m² x 1.44 m² per box");
  assert.equal(saved.total, 6 * 900 * 1.44);
  assert.deepEqual(plain(saved.payments), original.payments, "payment history unchanged");
  assert.equal(stockOf(ctx.api, tile.id), 20 - 6);
  assert.equal(ctx.api.getInvoiceEdit(), null);
  assert.equal(ctx.app.field("editBanner").hidden, true, "the Sell page is a normal Sell page again");
  assert.equal(ctx.app.field("completeSale").hidden, false);
});

test("A: the sale being prepared before the edit comes back untouched afterwards", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx);
  const other = await addTile(ctx, { name: "Pietra Beige", sku: "PB-1" });
  const inv = await sellLines(ctx, [{ product: tile, qty: "2" }]);
  assert.equal(ctx.api.addToSale(other.id, "3", "box").ok, true);   // a new sale in preparation
  ctx.api.getSale().customer.name = "Someone Else";
  openEdit(ctx, inv);
  assert.equal(ctx.api.getSale().items[0].productId, tile.id, "the edit shows the invoice, not the sale in preparation");
  typeQty(ctx.api, 0, 3);
  await ctx.api.saveInvoiceEdit();
  assert.equal(ctx.api.getSale().items.length, 1);
  assert.equal(ctx.api.getSale().items[0].productId, other.id);
  assert.equal(ctx.api.getSale().customer.name, "Someone Else");
  assert.equal(ctx.app.field("custName").value, "Someone Else");
});

/* ==========================================================================
   B / C. Stock follows the difference
   ========================================================================== */

test("B: removing one product from a two-product invoice returns its stock; the other is untouched", async () => {
  const ctx = await boot();
  const a = await addTile(ctx);
  const b = await addTile(ctx, { name: "Pietra Beige", sku: "PB-1", sellingPrice: 3000 });
  const inv = await sellLines(ctx, [{ product: a, qty: "4" }, { product: b, qty: "3" }]);
  assert.equal(stockOf(ctx.api, b.id), 17);
  const sale = openEdit(ctx, inv);
  removeLine(ctx.api, sale.items.findIndex((l) => l.productId === b.id));
  await ctx.api.saveInvoiceEdit();
  assert.equal(stockOf(ctx.api, b.id), 20, "3 boxes back");
  assert.equal(stockOf(ctx.api, a.id), 16);
  assert.equal(invoiceById(ctx.api, inv.id).items.length, 1);
  assert.equal(Boolean(invoiceById(ctx.api, inv.id).cancellation), false, "one product is left: an edit, not a cancellation");
});

test("C: 10 boxes edited to 6 returns exactly 4 boxes; going back to 10 takes exactly 4 again", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 30 });
  const inv = await sellLines(ctx, [{ product: tile, qty: "10" }]);
  assert.equal(stockOf(ctx.api, tile.id), 20);
  openEdit(ctx, inv);
  typeQty(ctx.api, 0, 6);
  await ctx.api.saveInvoiceEdit();
  assert.equal(stockOf(ctx.api, tile.id), 24, "20 + 4");
  openEdit(ctx, invoiceById(ctx.api, inv.id));
  typeQty(ctx.api, 0, 10);
  await ctx.api.saveInvoiceEdit();
  assert.equal(stockOf(ctx.api, tile.id), 20, "24 - 4: never deducted twice");
});

test("C: stock never goes negative: more than what the stock plus the invoice's own quantity holds is refused", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 12 });
  const inv = await sellLines(ctx, [{ product: tile, qty: "10" }]);   // 2 left
  const before = await snapshot(ctx);
  openEdit(ctx, inv);
  assert.match(typeQty(ctx.api, 0, 13).error, /stock/i);
  assert.equal(ctx.api.getSale().items[0].qty, 12, "limited to the 2 in stock + the 10 the invoice already holds");
  ctx.api.getSale().items[0].qty = 13;       // a stale screen
  assert.match(ctx.api.editPlan().error, /Not enough stock/);
  await ctx.api.saveInvoiceEdit();
  assert.deepEqual(await snapshot(ctx), before);
  ctx.api.cancelInvoiceEdit();
  openEdit(ctx, inv);
  typeQty(ctx.api, 0, 12);                   // exactly what is available is fine
  await ctx.api.saveInvoiceEdit();
  assert.equal(stockOf(ctx.api, tile.id), 0);
});

/* ==========================================================================
   D. A product added during the edit
   ========================================================================== */

test("D: a product added in the edit gets the inventory's current price and unit (per piece, per box or per m²)", async () => {
  const ctx = await boot();
  const base = await addTile(ctx);
  const perPiece = await addTile(ctx, { name: "Mosaic", sku: "MO-1", sellingPrice: 300, priceUnit: "piece", stock: 100 });
  const perM2 = await addTile(ctx, { name: "Plank", sku: "PL-1", sellingPrice: 1000, priceUnit: "m2", stock: 100 });
  const perBox = await addTile(ctx, { name: "Slab", sku: "SL-1", sellingPrice: 2500, priceUnit: "box", stock: 100 });
  const inv = await sellLines(ctx, [{ product: base, qty: "1" }]);
  openEdit(ctx, inv);
  for (const p of [perPiece, perM2, perBox]) assert.equal(ctx.api.addToSale(p.id, "2", "box").ok, true);
  const lines = ctx.api.getSale().items;
  assert.deepEqual(plain(lines.slice(1).map((l) => [l.priceUnit, l.unitPrice])), [["piece", 300], ["m2", 1000], ["box", 2500]], "each line shows the product's own price unit");
  await ctx.api.saveInvoiceEdit();
  const saved = invoiceById(ctx.api, inv.id);
  assert.equal(saved.items.length, 4);
  // 2 boxes: 8 pieces x 300, 2.88 m² x 1,000, 2 boxes x 2,500
  assert.deepEqual(plain(saved.items.slice(1).map((i) => i.total)), [2400, 2880, 5000]);
  assert.deepEqual(plain(saved.items.slice(1).map((i) => i.priceUnit)), ["piece", "m2", "box"]);
  assert.equal(stockOf(ctx.api, perPiece.id), 92, "a per-piece product is counted in pieces: 2 boxes = 8 pieces");
});

test("D: a product removed and added again is a new line at today's catalogue price; the stock nets out", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { sellingPrice: 2000, priceUnit: "box", stock: 20 });
  const inv = await sellLines(ctx, [{ product: tile, qty: "4" }]);
  assert.equal(inv.items[0].unitPrice, 2000);
  await ctx.api.commit((d) => { const p = d.products.find((x) => x.id === tile.id); p.sellingPrice = 2500; p.sellingPrices = [{ unit: "box", price: 2500 }]; });
  openEdit(ctx, inv);
  assert.equal(ctx.api.getSale().items[0].unitPrice, 2000, "the kept line shows the price it was sold at, not today's");
  removeLine(ctx.api, 0);
  assert.equal(ctx.api.addToSale(tile.id, "4", "box").ok, true);
  assert.equal(ctx.api.getSale().items[0].unitPrice, 2500, "a re-added product takes the current price");
  await ctx.api.saveInvoiceEdit();
  const saved = invoiceById(ctx.api, inv.id);
  assert.equal(saved.items[0].unitPrice, 2500);
  assert.equal(saved.total, 10000);
  assert.equal(stockOf(ctx.api, tile.id), 16, "4 given back, 4 taken: net 0 from the 16 left");
});

/* ==========================================================================
   E / F. Removing every product = complete cancellation and refund
   ========================================================================== */

test("E+F: removing every product cancels the sale: 30,000 total / 20,000 paid refunds exactly 20,000", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx);
  const inv = await sellLines(ctx, [{ product: tile, qty: "15" }], { paid: "20000" });
  assert.equal(inv.total, 30000);
  assert.equal(stockOf(ctx.api, tile.id), 5);
  const original = plain(inv);

  openEdit(ctx, inv);
  removeLine(ctx.api, 0);
  const plan = ctx.api.editPlan();
  assert.equal(plan.cancelled, true);
  assert.equal(plan.refund, 20000);
  assert.equal(stockOf(ctx.api, tile.id), 5, "nothing moves before Save");

  // Declining the confirmation changes nothing at all.
  const before = await snapshot(ctx);
  ctx.app.answer(false);
  await ctx.api.saveInvoiceEdit();
  assert.deepEqual(await snapshot(ctx), before);
  assert.equal(ctx.api.getInvoiceEdit() !== null, true);

  // Confirming cancels it.
  const asked = ctx.app.confirms.length;
  ctx.app.answer(true);
  await ctx.api.saveInvoiceEdit();
  const dialog = ctx.app.confirms[asked];
  assert.ok(dialog.startsWith(CONFIRM_SENTENCE), "the exact confirmation sentence");
  assert.match(dialog, new RegExp(inv.invoiceNumber));
  assert.match(dialog, /Original total: .*30,000/);
  assert.match(dialog, /Amount collected: .*20,000/);
  assert.match(dialog, /Refund: .*20,000/);

  const saved = invoiceById(ctx.api, inv.id);
  assert.equal(stockOf(ctx.api, tile.id), 20, "all 15 boxes are back");
  assert.equal(ctx.api.getInvoices().length, 1);
  assert.equal(saved.invoiceNumber, original.invoiceNumber);
  assert.equal(saved.date, original.date);
  assert.deepEqual(plain(saved.items), original.items, "the original transaction is kept");
  assert.equal(saved.total, 30000);
  assert.deepEqual(plain(saved.payments), original.payments, "payment history untouched");
  assert.equal(saved.refunds.length, 1);
  assert.equal(saved.refunds[0].amount, 20000);
  assert.equal(saved.refunds[0].reason, "cancellation");
  assert.ok(saved.refunds[0].timestamp);
  assert.equal(saved.cancellation.refund, 20000);
  assert.equal(saved.cancellation.paid, 20000);
  assert.equal(saved.cancellation.total, 30000);
  assert.ok(!Number.isNaN(Date.parse(saved.cancellation.at)), "cancellation date and time");
  assert.equal(V.invoiceProblem(V.stripDerived(plain(saved))), "", "still a valid invoice");

  // Status, balances: cancelled, nothing owed, nothing due back.
  const info = ctx.api.paymentInfo(saved);
  assert.equal(info.cls, "cancelled");
  assert.match(info.status, /cancelled/i);
  assert.equal(info.remaining, 0);
  assert.equal(info.refundDue, 0);
  assert.equal(info.refunded, 20000);
  assert.equal(info.due, 0, "a cancelled sale asks for nothing");
});

test("E: a cancelled invoice is labelled in the list and in the details, and is not collectible debt", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx);
  const inv = await sellLines(ctx, [{ product: tile, qty: "10" }], { name: "Karim Benali", phone: "0555 1", paid: "4000" });
  const live = await sellLines(ctx, [{ product: tile, qty: "1" }], { name: "Karim Benali", phone: "0555 1" });   // 2,000 owed, still live
  await cancelSale(ctx, inv);

  ctx.api.renderInvoices();
  const rows = ctx.app.field("invoiceBody").innerHTML;
  assert.match(rows, /class="badge cancelled">Cancelled</);
  assert.match(rows, /4,000 DA refunded/);
  assert.match(rows, /Total of the cancelled sale: .*20,000/);
  assert.match(rows, /data-action="edit" disabled/, "a cancelled invoice can not be edited");

  ctx.api.viewInvoice(inv.id);
  const page = ctx.app.field("invoice").innerHTML;
  assert.match(page, /SALE CANCELLED/);
  assert.match(page, /REFUND HISTORY/);
  assert.match(page, /4,000/);
  assert.match(ctx.app.field("payCancelRow").textContent, /SALE CANCELLED/);
  assert.equal(ctx.app.field("payCancelRow").hidden, false);
  assert.equal(ctx.app.field("payRefundedRow").hidden, false);

  // Customer debt counts only the live invoice (the cancelled one owed 16,000 before it was cancelled).
  const dir = globalThis.Debt.directory(ctx.api.getState().invoices, ctx.api.getState().debtTransfers);
  assert.equal(dir.find((g) => /Karim/.test(g.name)).debt, 2000);
  void live;
  // The filter "Cancelled" finds it.
  ctx.api.invoiceView.pay = "cancelled";
  assert.deepEqual(Array.from(ctx.api.searchInvoices("")).map((i) => i.id), [inv.id]);
  ctx.api.invoiceView.pay = "all";
});

test("F: refund = what was actually collected: fully paid, partly paid, nothing paid", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 100 });
  const paidFull = await sellLines(ctx, [{ product: tile, qty: "5" }], { name: "Full", paid: "10000" });
  const partial = await sellLines(ctx, [{ product: tile, qty: "5" }], { name: "Part", paid: "3500" });
  const none = await sellLines(ctx, [{ product: tile, qty: "5" }], { name: "None" });
  assert.equal(stockOf(ctx.api, tile.id), 85);

  await cancelSale(ctx, paidFull);
  await cancelSale(ctx, partial);
  const askedNone = await cancelSale(ctx, none);
  assert.match(askedNone[0], /Refund: .*\b0\b/, "nothing collected = nothing to refund");

  assert.equal(invoiceById(ctx.api, paidFull.id).cancellation.refund, 10000);
  assert.equal(invoiceById(ctx.api, partial.id).cancellation.refund, 3500);
  const n = invoiceById(ctx.api, none.id);
  assert.equal(n.cancellation.refund, 0);
  assert.equal(n.refunds, undefined, "no refund record for a refund of nothing");
  assert.equal(n.payments.length, 0);
  assert.equal(stockOf(ctx.api, tile.id), 100, "every box is back");
  for (const i of [paidFull, partial, none]) assert.equal(ctx.api.paymentInfo(invoiceById(ctx.api, i.id)).cls, "cancelled");
});

test("E: a sale sold in boxes, pieces and m² gives back each product's own stock", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 20 });
  const roll = await addTile(ctx, { name: "Screed", sku: "FS-1", tileSize: "", coveragePerBox: null, priceUnit: "m2", sellingPrice: 500, stockUnit: "m2", stock: 100 });
  const inv = await sellLines(ctx, [{ product: tile, qty: "10", unit: "piece" }, { product: roll, qty: "20", unit: "m2" }], { paid: "1000" });
  assert.equal(stockOf(ctx.api, tile.id), 17.5);
  assert.equal(stockOf(ctx.api, roll.id), 80);
  await cancelSale(ctx, inv);
  assert.equal(stockOf(ctx.api, tile.id), 20);
  assert.equal(stockOf(ctx.api, roll.id), 100);
});

test("E: the edit history records the cancellation and the stock that went back", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx);
  const inv = await sellLines(ctx, [{ product: tile, qty: "3" }], { paid: "1500" });
  await cancelSale(ctx, inv);
  const saved = invoiceById(ctx.api, inv.id);
  const last = plain(saved.edits[saved.edits.length - 1]);
  assert.equal(last.cancelled, true);
  assert.equal(last.refund, 1500);
  assert.equal(last.lines[0].qtyBefore, 3);
  assert.equal(last.lines[0].qtyAfter, 0);
  assert.deepEqual(last.stock.map((s) => s.change), [3]);
});

test("E: a customer name typed in the edit before cancelling is kept on the cancelled invoice", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx);
  const inv = await sellLines(ctx, [{ product: tile, qty: "3" }], { paid: "1500" });
  const sale = openEdit(ctx, inv);
  sale.customer.name = "Alexandre";
  removeLine(ctx.api, 0);
  ctx.app.answer(true);
  await ctx.api.saveInvoiceEdit();
  assert.equal(invoiceById(ctx.api, inv.id).customer.name, "Alexandre");
});

/* ==========================================================================
   No double cancellation, no double refund
   ========================================================================== */

test("H: a cancelled sale can not be cancelled, edited, deleted or refunded again (screen and database)", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx);
  const inv = await sellLines(ctx, [{ product: tile, qty: "5" }], { paid: "6000" });
  await cancelSale(ctx, inv);
  const done = await snapshot(ctx);
  assert.equal(stockOf(ctx.api, tile.id), 20);

  // Screen: Edit is refused, the refund box has nothing to give, Delete is refused, a payment is refused.
  const r = ctx.api.startEditInvoice(inv.id);
  assert.match(r.error, /cancelled/i);
  assert.equal(ctx.api.getInvoiceEdit(), null);
  assert.match((await ctx.api.recordRefund(inv.id, "100")).error, /already recorded|Nothing is due/);
  assert.match((await ctx.api.addPayment(inv.id, "100")).error || "", /./);
  await ctx.api.deleteInvoice(inv.id);
  assert.equal(ctx.api.getInvoices().length, 1, "a cancelled invoice is kept");

  // The planner itself (what the screen and the transaction share).
  const state = ctx.api.getState();
  const plan = ctx.api.planInvoiceEdit(state, inv.id, { sale: { items: [], customer: { name: "x" } } });
  assert.match(plan.error, /cancelled/i);
  // Database: whatever a stale window sends, the cancelled record can only get refunds appended; nothing else.
  const tamper = async (mutate) => (await ctx.api.commit((d) => { mutate(d.invoices.find((i) => i.id === inv.id)); })).error;
  assert.match(await tamper((i) => { i.cancellation.refund = 0; i.refunds = []; }) || "", /./, "the refund can not be erased");
  assert.match(await tamper((i) => { i.refunds.push({ id: "r2", amount: 6000, timestamp: new Date().toISOString(), reason: "refund" }); }) || "", /./, "no second refund of the same money");
  assert.match(await tamper((i) => { delete i.cancellation; }) || "", /./, "it can not be un-cancelled");
  assert.match(await tamper((i) => { i.items[0].qty = 1; }) || "", /./, "the cancelled lines are locked");
  assert.match(await tamper((i) => { i.payments = []; }) || "", /./, "the payment history is locked");
  assert.equal(stockOf(ctx.api, tile.id), 20, "stock was given back once");
  assert.deepEqual(await snapshot(ctx), done, "after all of that, nothing changed");
});

test("H: cancelling twice from two windows gives the stock back once", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx);
  const inv = await sellLines(ctx, [{ product: tile, qty: "5" }], { paid: "6000" });
  openEdit(ctx, inv);
  removeLine(ctx.api, 0);
  // The other window cancels first.
  const other = plain(invoiceById(ctx.api, inv.id));
  ctx.app.answer(true);
  const second = await (async () => {
    await ctx.api.commit((d) => ctx.api.applyInvoiceEdit(d, inv.id, { sale: { items: [], customer: other.customer } }));
    return invoiceById(ctx.api, inv.id);
  })();
  assert.ok(second.cancellation);
  assert.equal(stockOf(ctx.api, tile.id), 20);
  // This window's Save now meets a cancelled invoice.
  ctx.app.answer(true);
  await ctx.api.saveInvoiceEdit();
  assert.equal(stockOf(ctx.api, tile.id), 20, "not 25: the stock was not returned a second time");
  assert.equal(invoiceById(ctx.api, inv.id).refunds.length, 1);
});

test("H: cancelling is refused when the payments changed after the dialog showed the refund", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx);
  const inv = await sellLines(ctx, [{ product: tile, qty: "5" }], { paid: "6000" });
  openEdit(ctx, inv);
  removeLine(ctx.api, 0);
  const sale = ctx.api.getSale();
  const plan = ctx.api.editPlan();
  assert.equal(plan.refund, 6000);
  // A payment arrives (other window) after the dialog said 6,000.
  await ctx.api.commit((d) => { d.invoices.find((i) => i.id === inv.id).payments.push({ amount: 1000, timestamp: new Date().toISOString() }); });
  const r = await ctx.api.commit((d) => ctx.api.applyInvoiceEdit(d, inv.id, { sale, confirmedRefund: 6000 }));
  assert.match(r.error || "", /./);
  assert.equal(invoiceById(ctx.api, inv.id).cancellation, undefined, "not cancelled with a refund nobody confirmed");
  assert.equal(stockOf(ctx.api, tile.id), 15);
});

test("H: a failed write while cancelling saves nothing: stock, invoice and refund stay as they were", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx);
  const inv = await sellLines(ctx, [{ product: tile, qty: "5" }], { paid: "6000" });
  const before = await snapshot(ctx);
  let failures = 0;
  for (const onCall of [1, 2, 3]) {
    openEdit(ctx, inv);
    removeLine(ctx.api, 0);
    ctx.app.answer(true);
    const restore = failPutWith("QuotaExceededError", onCall);
    try { await ctx.api.saveInvoiceEdit(); } finally { restore(); }
    if (invoiceById(ctx.api, inv.id).cancellation) break;
    failures++;
    assert.deepEqual(await snapshot(ctx), before, `nothing saved when write #${onCall} fails`);
    assert.equal(stockOf(ctx.api, tile.id), 15, "memory still matches the database");
    assert.equal(invoiceById(ctx.api, inv.id).refunds, undefined);
    assert.equal(ctx.api.getInvoiceEdit() !== null, true, "the screen stays open");
    ctx.api.cancelInvoiceEdit();
  }
  assert.ok(failures >= 2);
  // Once the problem is gone the same cancellation works, exactly once.
  await cancelSale(ctx, inv);
  assert.equal(stockOf(ctx.api, tile.id), 20);
  assert.equal(invoiceById(ctx.api, inv.id).refunds.length, 1);
});

test("H: a cancelled sale survives a reload and a full restart, and the backup file equals the database", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx);
  const inv = await sellLines(ctx, [{ product: tile, qty: "5" }], { paid: "6000" });
  await cancelSale(ctx, inv);
  await ctx.api.loadFromDatabase();
  const saved = invoiceById(ctx.api, inv.id);
  assert.equal(ctx.api.paymentInfo(saved).cls, "cancelled");
  assert.equal(stockOf(ctx.api, tile.id), 20);

  const second = await boot({ indexedDB: ctx.app.indexedDB });
  const again = second.api.getState().invoices.find((i) => i.id === inv.id);
  assert.equal(again.cancellation.refund, 6000);
  assert.equal(second.api.getState().products.find((p) => p.id === tile.id).stock, 20);

  await ctx.api.autoBackup.flushNow();
  const parsed = V.parseBackup(ctx.handle.content);
  assert.equal(parsed.error, undefined, parsed.error);
  assert.deepEqual(parsed.warnings, []);
  assert.deepEqual(plain(parsed.data.invoices.map(V.stripDerived)), plain((await ctx.api.db.loadAll()).invoices));
  // Derived fields in the backup say cancelled and what was refunded; they are never trusted when the file is read back.
  const raw = JSON.parse(ctx.handle.content).data.invoices[0];
  assert.equal(raw.amountRefunded, 6000);
  assert.equal(raw.status, "cancelled");
});

test("H: an invoice saved by an older version (no refunds, no cancellation) is read, shown and edited as before", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx);
  const inv = await sellLines(ctx, [{ product: tile, qty: "2" }], { paid: "500" });
  const old = plain(invoiceById(ctx.api, inv.id));
  assert.equal(old.refunds, undefined);
  assert.equal(old.cancellation, undefined);
  assert.equal(V.invoiceProblem(V.stripDerived(old)), "");
  const info = ctx.api.paymentInfo(inv);
  assert.equal(info.refunded, 0);
  assert.notEqual(info.cls, "cancelled");
  openEdit(ctx, inv);
  typeQty(ctx.api, 0, 3);
  await ctx.api.saveInvoiceEdit();
  assert.equal(invoiceById(ctx.api, inv.id).items[0].qty, 3);
});

/* ==========================================================================
   Refunds handed back after a cheaper edit (kept separate from payments)
   ========================================================================== */

test("refund: a refund due after a cheaper edit is recorded separately, in parts, never above what is due, never touching payments", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx);
  const inv = await sellLines(ctx, [{ product: tile, qty: "10" }], { paid: "20000" });
  openEdit(ctx, inv);
  typeQty(ctx.api, 0, 6);                                   // total 12,000, paid 20,000: 8,000 due back
  await ctx.api.saveInvoiceEdit();
  const paymentsBefore = plain(invoiceById(ctx.api, inv.id).payments);
  assert.equal(ctx.api.paymentInfo(invoiceById(ctx.api, inv.id)).refundDue, 8000);

  assert.match((await ctx.api.recordRefund(inv.id, "9000")).error, /can not be more/);
  assert.match((await ctx.api.recordRefund(inv.id, "0")).error, /./);
  assert.match((await ctx.api.recordRefund(inv.id, "abc")).error, /./);
  assert.equal((await ctx.api.recordRefund(inv.id, "3000")).error, undefined);
  let info = ctx.api.paymentInfo(invoiceById(ctx.api, inv.id));
  assert.equal(info.refundDue, 5000);
  assert.equal(info.refunded, 3000);
  assert.equal(info.paid, 20000, "the payments are still what was paid");
  assert.equal(info.remaining, 0);
  assert.equal((await ctx.api.recordRefund(inv.id, "5000")).error, undefined);
  info = ctx.api.paymentInfo(invoiceById(ctx.api, inv.id));
  assert.equal(info.refundDue, 0);
  assert.match((await ctx.api.recordRefund(inv.id, "1")).error, /Nothing is due/, "no refund twice");
  const saved = invoiceById(ctx.api, inv.id);
  assert.deepEqual(plain(saved.payments), paymentsBefore);
  assert.deepEqual(plain(saved.refunds.map((x) => [x.amount, x.reason])), [[3000, "refund"], [5000, "refund"]]);
  assert.equal(V.invoiceProblem(V.stripDerived(plain(saved))), "");
  await ctx.api.loadFromDatabase();
  assert.equal(ctx.api.paymentInfo(invoiceById(ctx.api, inv.id)).refundDue, 0);
});

test("refund: after a refund was handed back, a further edit works from what is still held", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx);
  const inv = await sellLines(ctx, [{ product: tile, qty: "10" }], { paid: "20000" });
  openEdit(ctx, inv);
  typeQty(ctx.api, 0, 6);
  await ctx.api.saveInvoiceEdit();
  await ctx.api.recordRefund(inv.id, "8000");                // held is now 12,000 = the total
  openEdit(ctx, invoiceById(ctx.api, inv.id));
  typeQty(ctx.api, 0, 8);                                    // 16,000 due, 12,000 held: 4,000 owed again
  await ctx.api.saveInvoiceEdit();
  const info = ctx.api.paymentInfo(invoiceById(ctx.api, inv.id));
  assert.equal(info.remaining, 4000);
  assert.equal(info.refundDue, 0);
  assert.equal(info.paid, 20000);
  assert.equal(info.refunded, 8000);
});

/* ==========================================================================
   Cancellation limits (explicit, tested)
   ========================================================================== */

test("limits: an invoice with deliveries, or whose balance moved to a newer invoice, is not cancelled here and nothing changes", async () => {
  const ctx = await boot();
  const { api } = ctx;
  const tile = await addTile(ctx, { stock: 50 });
  // Tracked invoice.
  api.addToSale(tile.id, "1", "box");
  const line = api.getSale().items[0];
  api.setSalePartial(line.lineId, true);
  api.updateSaleQuantity(line.lineId, "4");
  api.updateSaleDeliverNow(line.lineId, "1");
  api.getSale().customer.name = "Alex";
  await api.completeSale();
  const tracked = api.getInvoices()[0];
  let before = await snapshot(ctx);
  openEdit(ctx, tracked);
  removeLine(api, 0);
  assert.match(api.editPlan().error, /deliver/i);
  ctx.app.answer(true);
  await api.saveInvoiceEdit();
  assert.deepEqual(await snapshot(ctx), before);
  api.cancelInvoiceEdit();

  // Balance carried forward.
  const karim = { name: "Karim Benali", phone: "0555 11 22 33" };
  const first = await sellLines(ctx, [{ product: tile, qty: "5" }], { ...karim, paid: "4000" });
  api.addToSale(tile.id, "2", "box");
  api.getSale().customer.name = karim.name;
  api.getSale().customer.phone = karim.phone;
  api.onCustomerSettled();
  assert.equal(api.addDebtToSale([{ sourceInvoiceId: first.id, amount: 6000 }]).error, undefined);
  await api.completeSale();
  before = await snapshot(ctx);
  openEdit(ctx, first);
  removeLine(api, 0);
  assert.match(api.editPlan().error, /carried|moved|INV-/i);
  ctx.app.answer(true);
  await api.saveInvoiceEdit();
  assert.deepEqual(await snapshot(ctx), before);
});

test("limits: cancelling the invoice that CARRIED an old debt refunds only its own purchase, not the old debt that was paid with it", async () => {
  const ctx = await boot();
  const { api } = ctx;
  const tile = await addTile(ctx, { stock: 50 });
  const karim = { name: "Karim Benali", phone: "0555 11 22 33" };
  const first = await sellLines(ctx, [{ product: tile, qty: "5" }], { ...karim, paid: "4000" });   // 10,000, 6,000 owed
  api.addToSale(tile.id, "2", "box");                                                                  // 4,000 new purchase
  api.getSale().customer.name = karim.name;
  api.getSale().customer.phone = karim.phone;
  api.onCustomerSettled();
  api.addDebtToSale([{ sourceInvoiceId: first.id, amount: 6000 }]);
  api.getSale().paidValue = "10000";                                                                   // pays purchase + old debt
  await api.completeSale();
  const second = api.getInvoices()[1];
  openEdit(ctx, second);
  removeLine(api, 0);
  const plan = api.editPlan();
  assert.equal(plan.error, undefined, plan.error);
  assert.equal(plan.refund, 4000, "10,000 collected - 6,000 that settles the old invoice = 4,000 for this purchase");
  ctx.app.answer(true);
  await api.saveInvoiceEdit();
  assert.equal(invoiceById(api, second.id).cancellation.refund, 4000);
  assert.equal(stockOf(api, tile.id), 50 - 5, "only the second invoice's 2 boxes came back");
});

/* ==========================================================================
   G. Pricing units
   ========================================================================== */

test("G: per-piece, per-box and per-m² products keep their own price unit in Sell, edit, preview, saved invoice, print and details", async () => {
  const ctx = await boot();
  const { api } = ctx;
  const pc = await addTile(ctx, { name: "Mosaic", sku: "MO-1", sellingPrice: 300, priceUnit: "piece", stock: 100 });
  const bx = await addTile(ctx, { name: "Slab", sku: "SL-1", sellingPrice: 2500, priceUnit: "box", stock: 100 });
  const m2 = await addTile(ctx, { name: "Plank", sku: "PL-1", sellingPrice: 1000, priceUnit: "m2", stock: 100 });
  const expected = { [pc.id]: "piece", [bx.id]: "box", [m2.id]: "m2" };

  // Sell page: the line takes the product's configured price unit (never box by default).
  for (const p of [pc, bx, m2]) assert.equal(api.addToSale(p.id, "2", "box").ok, true);
  for (const l of api.getSale().items) assert.equal(l.priceUnit, expected[l.productId], `Sell: ${l.productId}`);
  api.getSale().customer.name = "Alex";
  await api.completeSale();
  const inv = api.getInvoices()[0];
  for (const i of inv.items) assert.equal(i.priceUnit, expected[i.productId], "saved invoice");
  const totals = plain(inv.items.map((i) => i.total));
  assert.deepEqual(totals, [2400, 5000, 2880].sort((a, b) => 0) && [2400, 5000, 2880]);

  // Edit page: the same units, and the same prices, before anything is changed.
  const sale = openEdit(ctx, inv);
  for (const l of sale.items) assert.equal(l.priceUnit, expected[l.productId], `Edit: ${l.productId}`);
  assert.deepEqual(plain(sale.items.map((l) => l.unitPrice)), [300, 2500, 1000]);
  // After a quantity change the unit does not move and the preview (not saved) shows the new total in the same unit.
  typeQty(api, 0, 3);
  for (const l of api.getSale().items) assert.equal(l.priceUnit, expected[l.productId], "after a change");
  const preview = api.editPreviewInvoice();
  assert.deepEqual(plain(preview.items.map((i) => i.priceUnit)), ["piece", "box", "m2"]);
  assert.equal(preview.items[0].total, 3600, "3 boxes = 12 pieces x 300");
  assert.equal(invoiceById(api, inv.id).items[0].total, 2400, "the preview did not save anything");
  assert.equal(stockOf(api, pc.id), 92, "and moved no stock (2 boxes = 8 pieces were taken by the sale)");
  api.refreshLive();
  const previewHtml = ctx.app.field("invoice").innerHTML;
  assert.match(ctx.app.field("previewStatus").className, /preview-unsaved/);
  assert.match(ctx.app.field("invoice").className, /invoice-unsaved/);
  await api.saveInvoiceEdit();

  // Saved, printed and in the details: same units everywhere.
  const saved = invoiceById(api, inv.id);
  assert.deepEqual(plain(saved.items.map((i) => i.priceUnit)), ["piece", "box", "m2"]);
  assert.deepEqual(plain(saved.items.map((i) => i.unitPrice)), [300 * 4, 2500, 1440], "per box sold: 4 pieces x 300, 1 box x 2,500, 1.44 m² x 1,000");
  api.printInvoice(saved);
  const printed = ctx.app.field("invoice").innerHTML;
  assert.doesNotMatch(ctx.app.field("previewStatus").className, /preview-unsaved/, "a saved invoice is not marked unsaved");
  assert.doesNotMatch(ctx.app.field("invoice").className, /invoice-unsaved/);
  // The preview, the saved invoice and the print show the same unit labels for each line.
  const labels = (html) => ["piece", "box", "m²"].map((u) => html.includes(u));
  assert.deepEqual(labels(printed), labels(previewHtml), "same units on the preview and on the printed invoice");
  assert.match(printed, /300/);
  assert.match(printed, /2,500/);
  assert.match(printed, /1,000/);
  ctx.api.viewInvoice(inv.id);
  assert.equal(ctx.app.field("invoice").innerHTML, printed, "the details page is the same document");
});

test("G: changing a line's unit and changing it back restores the price it was sold at", async () => {
  const ctx = await boot();
  const { api } = ctx;
  const pc = await addTile(ctx, { name: "Mosaic", sku: "MO-1", sellingPrice: 300, priceUnit: "piece", stock: 100 });
  const inv = await sellLines(ctx, [{ product: pc, qty: "10", unit: "piece" }]);
  assert.equal(inv.items[0].unitPrice, 300);
  openEdit(ctx, inv);
  const line = api.getSale().items[0];
  api.updateSaleUnit(line.lineId, "box");
  assert.equal(api.getSale().items[0].sellingUnit, "box");
  api.updateSaleUnit(api.getSale().items[0].lineId, "piece");
  const back = api.getSale().items[0];
  assert.equal(back.sellingUnit, "piece");
  assert.equal(back.qty, 10);
  assert.equal(back.unitPrice, 300);
  assert.equal(api.editPlan().skip, true, "back where it started: nothing to save");
});

/* ==========================================================================
   I. Historical prices
   ========================================================================== */

test("I: a catalogue price change never rewrites a saved line: not on opening, not after editing a quantity, not on cancelling", async () => {
  const ctx = await boot();
  const { api } = ctx;
  const tile = await addTile(ctx, { sellingPrice: 800, priceUnit: "m2", stock: 100 });
  const piece = await addTile(ctx, { name: "Mosaic", sku: "MO-1", sellingPrice: 300, priceUnit: "piece", stock: 100 });
  const inv = await sellLines(ctx, [{ product: tile, qty: "5" }, { product: piece, qty: "3" }], { paid: "1000" });
  const sold = plain(inv.items.map((i) => [i.unitPrice, i.priceUnit, i.total]));
  await api.commit((d) => {
    const a = d.products.find((x) => x.id === tile.id); a.sellingPrice = 5000; a.sellingPrices = [{ unit: "m2", price: 5000 }];
    const b = d.products.find((x) => x.id === piece.id); b.sellingPrice = 999; b.sellingPrices = [{ unit: "piece", price: 999 }];
  });

  const sale = openEdit(ctx, inv);
  assert.deepEqual(plain(sale.items.map((l) => l.unitPrice)), [800, 300], "the edit shows the saved prices, not today's");
  api.renderTotals();
  assert.equal(ctx.app.field("tTotal").textContent.replace(/\D/g, ""), String(inv.total).replace(/\D/g, ""));
  typeQty(api, 0, 6);
  await api.saveInvoiceEdit();
  const saved = invoiceById(api, inv.id);
  assert.equal(saved.items[0].unitPrice, sold[0][0], "unit price untouched");
  assert.equal(saved.items[0].total, sold[0][0] * 6);
  assert.deepEqual(plain([saved.items[1].unitPrice, saved.items[1].priceUnit, saved.items[1].total]), sold[1], "the other line is exactly as sold");

  // Cancelling keeps the historical lines exactly as they were last saved.
  const lines = plain(saved.items);
  await cancelSale(ctx, saved);
  assert.deepEqual(plain(invoiceById(api, inv.id).items), lines);
});

test("I: the invoice list and the details show the saved prices after the catalogue changed", async () => {
  const ctx = await boot();
  const { api } = ctx;
  const tile = await addTile(ctx, { sellingPrice: 2000, priceUnit: "box", stock: 100 });
  const inv = await sellLines(ctx, [{ product: tile, qty: "5" }]);
  await api.commit((d) => { const p = d.products.find((x) => x.id === tile.id); p.sellingPrice = 9999; p.sellingPrices = [{ unit: "box", price: 9999 }]; });
  api.viewInvoice(inv.id);
  const html = ctx.app.field("invoice").innerHTML;
  assert.match(html, /2,000/);
  assert.doesNotMatch(html, /9,999/);
});

/* ==========================================================================
   Preview and the Sell page's own state
   ========================================================================== */

test("preview: is live, clearly unsaved, and changes neither stock nor storage until Save", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx);
  const inv = await sellLines(ctx, [{ product: tile, qty: "4" }], { paid: "2000" });
  const before = await snapshot(ctx);
  openEdit(ctx, inv);
  typeQty(ctx.api, 0, 2);
  ctx.api.refreshLive();
  assert.match(ctx.app.field("previewStatus").className, /preview-unsaved/);
  assert.match(ctx.app.field("invoice").innerHTML, />2 Boxes</, "the preview shows the new quantity as it is typed");
  assert.match(ctx.app.field("invoice").innerHTML, /4,000/);
  typeQty(ctx.api, 0, 3);
  ctx.api.refreshLive();
  assert.match(ctx.app.field("invoice").innerHTML, />3 Boxes</, "and follows the next change");
  assert.deepEqual(await snapshot(ctx), before, "nothing was stored");
  assert.equal(stockOf(ctx.api, tile.id), 16);
  ctx.api.cancelInvoiceEdit();
  assert.deepEqual(await snapshot(ctx), before);
});

test("edit page: totals show subtotal, discount, tax, total, paid and remaining live; a tracked invoice locks adding products", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx);
  const inv = await sellLines(ctx, [{ product: tile, qty: "10" }], { paid: "5000", discount: { type: "percent", value: "10" } });   // 20,000 - 2,000 = 18,000
  const sale = openEdit(ctx, inv);
  const digits = (id) => ctx.app.field(id).textContent.replace(/\D/g, "");
  ctx.api.renderTotals();
  assert.equal(digits("tSubtotal"), "20000");
  assert.equal(digits("tDiscount"), "2000");
  assert.equal(digits("tTotal"), "18000");
  assert.equal(digits("tRemaining"), "13000");
  assert.match(ctx.app.field("tEditRows").innerHTML, /5,000/, "paid");
  typeQty(ctx.api, 0, 5);
  ctx.api.renderTotals();
  assert.equal(digits("tSubtotal"), "10000");
  assert.equal(digits("tDiscount"), "1000");
  assert.equal(digits("tTotal"), "9000");
  assert.equal(digits("tRemaining"), "4000");
  sale.discountType = "amount";
  sale.discountValue = "500";
  ctx.api.renderTotals();
  assert.equal(digits("tTotal"), "9500");
  assert.equal(digits("tRemaining"), "4500");
});

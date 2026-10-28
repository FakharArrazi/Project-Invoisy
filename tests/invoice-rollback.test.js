"use strict";

// Deleting an invoice reverses the sale (the Supprimer button, and removing every line while editing).
//   A  every payment status: fully paid, partly paid (several tranches), unpaid, and a cancelled invoice from an earlier version
//   B  stock: several lines of one product, boxes / pieces / m², a product that is gone, an older line with no saved stock figure,
//      goods never delivered, a stock unit that changed
//   C  the books: lists, counts, filters, search and customer debt update at once; counter and unrelated records are untouched
//   D  safety: all or nothing on a failed write, never twice (double click, stale window), refused only for a carried-forward balance
//   E  persistence: the refund log survives a reload, a restart, a backup and a restore, and old data without it still loads
// Everything runs through the application's own functions against a disposable in-memory IndexedDB (no real data).

const test = require("node:test");
const assert = require("node:assert/strict");
const { failPutWith } = require("./helpers/modules");
const {
  V, plain, boot, addTile, sellLines, stockOf, invoiceById, openEdit, removeLine,
} = require("./helpers/edit");

const logOf = (ctx) => plain(ctx.api.getState().settings.rollbackLog || []);
// Data AND settings (the refund log lives in the settings), as stored.
const stored = async (ctx) => {
  const all = await ctx.api.db.loadAll();
  return plain({ products: all.products, invoices: all.invoices, debtTransfers: all.debtTransfers, settings: all.settings, counter: all.counter });
};
const revisionOf = async (ctx) => (await ctx.api.db.loadAll()).revision;
const countText = (ctx) => { ctx.api.renderInvoices(); return ctx.app.field("invoiceCount").textContent; };

/* ==========================================================================
   A. Every payment status
   ========================================================================== */

test("A: a fully paid invoice: stock back, refund of everything collected logged, invoice and payments gone", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 40 });
  const inv = await sellLines(ctx, [{ product: tile, qty: "10" }], { name: "Karim", paid: "20000" });
  assert.equal(ctx.api.paymentInfo(inv).cls, "paid");
  assert.equal(stockOf(ctx.api, tile.id), 30);

  await ctx.api.deleteInvoice(inv.id);

  assert.equal(ctx.api.getInvoices().length, 0);
  assert.equal(stockOf(ctx.api, tile.id), 40);
  const [entry] = logOf(ctx);
  assert.equal(entry.reason, "delete");
  assert.equal(entry.status, "paid");
  assert.equal(entry.refund, 20000);
  assert.equal(entry.paid, 20000);
  assert.equal(entry.total, 20000);
  assert.equal((await ctx.api.db.loadAll()).invoices.length, 0, "removed from the database");
  assert.match(ctx.app.toast(), /deleted\. Refund to hand back: .*20,000/);
});

test("A: a partly paid invoice with several payment tranches: every tranche is refunded, the balance is not debt any more", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 40 });
  const inv = await sellLines(ctx, [{ product: tile, qty: "10" }], { name: "Karim", phone: "0555 1", paid: "5000" });
  assert.equal((await ctx.api.addPayment(inv.id, "3000")).error, undefined);
  assert.equal((await ctx.api.addPayment(inv.id, "1500")).error, undefined);
  const live = invoiceById(ctx.api, inv.id);
  assert.equal(live.payments.length, 3);
  const info = ctx.api.paymentInfo(live);
  assert.equal(info.cls, "partial");
  assert.equal(info.remaining, 20000 - 9500);
  const debtBefore = globalThis.Debt.directory(ctx.api.getState().invoices, ctx.api.getState().debtTransfers).find((g) => /Karim/.test(g.name)).debt;
  assert.equal(debtBefore, 10500);

  await ctx.api.deleteInvoice(inv.id);

  const [entry] = logOf(ctx);
  assert.equal(entry.refund, 9500, "5,000 + 3,000 + 1,500");
  assert.deepEqual(entry.payments.map((p) => p.amount), [5000, 3000, 1500], "every tranche is on the record");
  assert.equal(entry.status, "partial");
  assert.equal(stockOf(ctx.api, tile.id), 40);
  const directory = globalThis.Debt.directory(ctx.api.getState().invoices, ctx.api.getState().debtTransfers);
  assert.equal(directory.find((g) => /Karim/.test(g.name)), undefined, "no outstanding balance is left for the customer");
});

test("A: an unpaid invoice: stock back, nothing to refund, outstanding balance gone", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 40 });
  const inv = await sellLines(ctx, [{ product: tile, qty: "4" }], { name: "Walid", phone: "0770 2" });
  assert.equal(ctx.api.paymentInfo(inv).cls, "unpaid");
  assert.equal(stockOf(ctx.api, tile.id), 36);

  await ctx.api.deleteInvoice(inv.id);

  assert.equal(stockOf(ctx.api, tile.id), 40);
  const [entry] = logOf(ctx);
  assert.equal(entry.refund, 0);
  assert.deepEqual(entry.payments, []);
  assert.doesNotMatch(ctx.app.toast(), /Refund/, "no refund is announced when none is due");
  assert.equal(globalThis.Debt.directory(ctx.api.getState().invoices, ctx.api.getState().debtTransfers).length, 0);
});

// A cancelled sale as an earlier version saved it: lines, payments and the refund kept, the stock already given back.
async function legacyCancelled(ctx, tile, { qty = "5", paid = "6000" } = {}) {
  const inv = await sellLines(ctx, [{ product: tile, qty }], { name: "Karim", paid });
  const at = new Date().toISOString();
  const taken = inv.items[0].stockDeducted;
  await ctx.api.commit((d) => {
    const i = d.invoices.find((x) => x.id === inv.id);
    i.cancellation = { at, total: i.total, paid: Number(paid), refund: Number(paid) };
    i.refunds = [{ id: "r-legacy", amount: Number(paid), timestamp: at, reason: "cancellation" }];
    d.products.find((p) => p.id === tile.id).stock += taken;   // what the old cancellation did
  });
  return invoiceById(ctx.api, inv.id);
}

test("A: a cancelled invoice (earlier version) can be deleted: no second stock restoration and no second refund", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 20 });
  const cancelled = await legacyCancelled(ctx, tile);
  assert.equal(ctx.api.paymentInfo(cancelled).cls, "cancelled");
  assert.equal(stockOf(ctx.api, tile.id), 20, "the cancellation already gave everything back");
  assert.equal(ctx.api.stockHeld(cancelled).size, 0, "it holds nothing in stock");

  await ctx.api.deleteInvoice(cancelled.id);

  assert.equal(ctx.api.getInvoices().length, 0, "really deleted, not archived");
  assert.equal(stockOf(ctx.api, tile.id), 20, "not 25: the stock is not restored a second time");
  const [entry] = logOf(ctx);
  assert.equal(entry.wasCancelled, true);
  assert.equal(entry.paid, 6000);
  assert.equal(entry.alreadyRefunded, 6000);
  assert.equal(entry.refund, 0, "the 6,000 was already refunded by the cancellation: nothing more to hand back");
  assert.deepEqual(entry.stock, [], "no stock moved");
  assert.doesNotMatch(ctx.app.toast(), /Refund/);
});

test("A: a cancelled invoice whose refund was only partly handed back keeps only the remainder as refund", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 20 });
  const cancelled = await legacyCancelled(ctx, tile);
  // The earlier version recorded the whole 6,000; model money held above the refund by dropping it to 4,000 (an overpayment case).
  await ctx.api.commit((d) => {
    const i = d.invoices.find((x) => x.id === cancelled.id);
    i.payments.push({ amount: 500, timestamp: new Date().toISOString() });
  });
  assert.equal(V.netPaid(invoiceById(ctx.api, cancelled.id)), 500);
  await ctx.api.deleteInvoice(cancelled.id);
  assert.equal(logOf(ctx)[0].refund, 500, "only what is still held");
  assert.equal(stockOf(ctx.api, tile.id), 20);
});

/* ==========================================================================
   B. Stock
   ========================================================================== */

test("B: several lines of the same product in different units restore the exact total, to the same product", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 20 });          // 4 pieces = 1 box = 1.44 m²
  const other = await addTile(ctx, { name: "Pietra", sku: "PB-1", stock: 9 });
  const inv = await sellLines(ctx, [
    { product: tile, qty: "3", unit: "box" },
    { product: tile, qty: "2", unit: "piece" },            // 0.5 box
    { product: tile, qty: "2.88", unit: "m2" },            // 2 boxes
    { product: other, qty: "1", unit: "box" },
  ], { paid: "1000" });
  assert.equal(stockOf(ctx.api, tile.id), 20 - 5.5);
  assert.equal(stockOf(ctx.api, other.id), 8);

  await ctx.api.deleteInvoice(inv.id);

  assert.equal(stockOf(ctx.api, tile.id), 20, "3 + 0.5 + 2 boxes are back, exactly");
  assert.equal(stockOf(ctx.api, other.id), 9);
  assert.equal(ctx.api.getState().products.length, 2, "no product was created or duplicated");
  const entry = logOf(ctx)[0];
  assert.deepEqual(entry.stock.map((s) => [s.productId, s.qty]).sort(), [[other.id, 1], [tile.id, 5.5]].sort());
});

test("B: a product whose stock is counted in pieces gets pieces back, one counted in m² gets m² back", async () => {
  const ctx = await boot();
  const mosaic = await addTile(ctx, { name: "Mosaic", sku: "MO-1", tileSize: "", coveragePerBox: null, priceUnit: "piece", sellingPrice: 300, stockUnit: "piece", stock: 100 });
  const screed = await addTile(ctx, { name: "Screed", sku: "FS-1", tileSize: "", coveragePerBox: null, priceUnit: "m2", sellingPrice: 500, stockUnit: "m2", stock: 100 });
  const inv = await sellLines(ctx, [{ product: mosaic, qty: "7", unit: "piece" }, { product: screed, qty: "12.5", unit: "m2" }], { paid: "500" });
  assert.equal(stockOf(ctx.api, mosaic.id), 93);
  assert.equal(stockOf(ctx.api, screed.id), 87.5);
  await ctx.api.deleteInvoice(inv.id);
  assert.equal(stockOf(ctx.api, mosaic.id), 100);
  assert.equal(stockOf(ctx.api, screed.id), 100);
});

test("B: goods that were never taken out of stock (not yet delivered) are not given back", async () => {
  const ctx = await boot();
  const { api } = ctx;
  const tile = await addTile(ctx, { stock: 10 });
  api.addToSale(tile.id, "1", "box");
  const line = api.getSale().items[0];
  api.setSalePartial(line.lineId, true);
  api.updateSaleQuantity(line.lineId, "15");   // 15 sold, only 10 in the warehouse: 10 delivered now, 5 later
  api.getSale().customer.name = "Alex";
  api.getSale().paidValue = "15000";
  await api.completeSale();
  const inv = api.getInvoices()[0];
  assert.equal(V.isTracked(inv), true);
  assert.equal(stockOf(api, tile.id), 0);

  await api.deleteInvoice(inv.id);

  assert.equal(stockOf(api, tile.id), 10, "the 10 that left the warehouse are back; the 5 never left");
  assert.equal(logOf(ctx)[0].refund, 15000);
  assert.equal(api.getInvoices().length, 0);
});

test("B: an older invoice line with no saved stock figure is worked out from the line's own unit, as the edit does", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 20 });
  const inv = await sellLines(ctx, [{ product: tile, qty: "3" }], { paid: "1000" });
  await ctx.api.commit((d) => { delete d.invoices.find((i) => i.id === inv.id).items[0].stockDeducted; });
  assert.equal(invoiceById(ctx.api, inv.id).items[0].stockDeducted, undefined);
  await ctx.api.deleteInvoice(inv.id);
  assert.equal(stockOf(ctx.api, tile.id), 20);
});

test("B: a product that no longer exists is never re-created: the rest is restored and the person is told", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 20 });
  const gone = await addTile(ctx, { name: "Discontinued", sku: "DC-1", stock: 5 });
  const inv = await sellLines(ctx, [{ product: tile, qty: "2" }, { product: gone, qty: "1" }], { paid: "1000" });
  await ctx.api.deleteProduct(gone.id);
  assert.equal(ctx.api.getState().products.length, 1);

  await ctx.api.deleteInvoice(inv.id);

  assert.equal(ctx.api.getInvoices().length, 0);
  assert.equal(ctx.api.getState().products.length, 1, "the deleted product is not brought back");
  assert.equal(stockOf(ctx.api, tile.id), 20);
  const { notRestored, stock } = logOf(ctx)[0];
  assert.equal(notRestored.length, 1, "the missing product is on the record");
  assert.match(notRestored[0], /^Discontinued/);
  assert.deepEqual(stock.map((s) => s.productId), [tile.id], "only the product that still exists got stock back");
  assert.match(ctx.app.toast(), /Not returned to stock .*Discontinued/);
});

test("B: when a product's stock unit changed since the sale, nothing is deleted and the person is told", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 20 });
  const inv = await sellLines(ctx, [{ product: tile, qty: "2" }], { paid: "1000" });
  await ctx.api.commit((d) => { d.products.find((p) => p.id === tile.id).stockUnit = "piece"; });
  const before = await stored(ctx);
  await ctx.api.deleteInvoice(inv.id);
  assert.match(ctx.app.toast(), /stock unit .* changed/i);
  assert.deepEqual(await stored(ctx), before, "nothing was changed");
  assert.equal(ctx.api.getInvoices().length, 1);
});

/* ==========================================================================
   C. The books
   ========================================================================== */

test("C: counts, filters and search update at once; the counter and every unrelated record are untouched", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 100 });
  const a = await sellLines(ctx, [{ product: tile, qty: "1" }], { name: "Amine", paid: "2000" });
  const b = await sellLines(ctx, [{ product: tile, qty: "2" }], { name: "Bilal", paid: "1000" });
  const c = await sellLines(ctx, [{ product: tile, qty: "3" }], { name: "Chems" });
  assert.equal(countText(ctx), "3 of 3 invoices");
  const counter = (await ctx.api.db.loadAll()).counter;
  const before = await stored(ctx);
  const revision = await revisionOf(ctx);

  await ctx.api.deleteInvoice(b.id);

  assert.equal(countText(ctx), "2 of 2 invoices");
  assert.deepEqual(plain(Array.from(ctx.api.searchInvoices("")).map((i) => i.invoiceNumber)).sort(), [a.invoiceNumber, c.invoiceNumber].sort());
  assert.deepEqual(Array.from(ctx.api.searchInvoices("Bilal")), [], "search does not find it");
  for (const filter of ["paid", "partial", "unpaid", "cancelled"]) {
    ctx.api.invoiceView.pay = filter;
    assert.ok(!Array.from(ctx.api.searchInvoices("")).some((i) => i.id === b.id), `not under ${filter}`);
  }
  ctx.api.invoiceView.pay = "all";
  assert.doesNotMatch(ctx.app.field("invoiceBody").innerHTML, new RegExp(b.invoiceNumber));

  const after = await stored(ctx);
  assert.equal(after.counter, counter, "the invoice counter did not move");
  assert.deepEqual(after.invoices, before.invoices.filter((i) => i.id !== b.id), "the other invoices are byte-for-byte the same");
  assert.deepEqual(after.products.filter((p) => p.id !== tile.id), before.products.filter((p) => p.id !== tile.id));
  assert.equal(after.products.find((p) => p.id === tile.id).stock, before.products.find((p) => p.id === tile.id).stock + 2);
  const { rollbackLog, ...settingsAfter } = after.settings;
  assert.deepEqual(settingsAfter, before.settings, "the rest of the settings are identical");
  assert.equal(rollbackLog.length, 1);
  assert.equal((await revisionOf(ctx)), revision + 1, "one save, not several");

  // The next invoice never reuses the deleted number.
  const next = await sellLines(ctx, [{ product: tile, qty: "1" }], { name: "Dina" });
  assert.equal(next.invoiceNumber, "INV-000004");
});

test("C: invoices of the same customer are independent: deleting one leaves the other's payments and balance alone", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 100 });
  const karim = { name: "Karim Benali", phone: "0555 11 22 33" };
  const one = await sellLines(ctx, [{ product: tile, qty: "5" }], { ...karim, paid: "4000" });   // 6,000 owed
  const two = await sellLines(ctx, [{ product: tile, qty: "2" }], { ...karim });                    // 4,000 owed
  await ctx.api.deleteInvoice(two.id);
  const kept = invoiceById(ctx.api, one.id);
  assert.equal(kept.payments.length, 1);
  assert.equal(ctx.api.paymentInfo(kept).remaining, 6000);
  const group = globalThis.Debt.directory(ctx.api.getState().invoices, ctx.api.getState().debtTransfers).find((g) => /Karim/.test(g.name));
  assert.equal(group.debt, 6000);
});

test("C: the question names the stock that goes back and the refund before anything is deleted", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 40 });
  const inv = await sellLines(ctx, [{ product: tile, qty: "10" }], { paid: "12000" });
  const dialog = ctx.app.field("invoiceDeleteDialog");
  let opened = 0;
  dialog.showModal = () => { opened++; };
  dialog.close = () => {};
  const asked = ctx.api.deleteInvoice(inv.id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(opened, 1);
  const body = ctx.app.field("invoiceDeleteBody").textContent;
  assert.match(body, /deleted permanently/);
  assert.match(body, /Returned to stock: .*10 Boxes/);
  assert.match(body, /12,000.* will be recorded as refunded/);
  assert.equal(ctx.app.field("invoiceDeleteConfirm").hidden, false);
  assert.equal(ctx.api.getInvoices().length, 1, "nothing is deleted before the answer");
  ctx.api.answerInvoiceDelete(false);
  await asked;
  assert.equal(ctx.api.getInvoices().length, 1);
  assert.equal(stockOf(ctx.api, tile.id), 30);
  assert.equal(logOf(ctx).length, 0, "declining logs nothing");
});

/* ==========================================================================
   D. Safety
   ========================================================================== */

test("D: a failed write at any step leaves the database exactly as it was, then the same delete works once", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 20 });
  const inv = await sellLines(ctx, [{ product: tile, qty: "5" }], { paid: "6000" });
  const before = await stored(ctx);
  let failures = 0;
  for (const onCall of [1, 2, 3]) {
    const restore = failPutWith("QuotaExceededError", onCall);
    try { await ctx.api.deleteInvoice(inv.id); } finally { restore(); }
    if (!invoiceById(ctx.api, inv.id)) break;
    failures++;
    assert.deepEqual(await stored(ctx), before, `nothing saved when write #${onCall} fails`);
    assert.equal(stockOf(ctx.api, tile.id), 15, "memory matches the database");
    assert.equal(logOf(ctx).length, 0);
    assert.notEqual(ctx.app.toast(), "");
    assert.doesNotMatch(ctx.app.toast(), /deleted\./, "a failure is not announced as a success");
  }
  assert.ok(failures >= 2, "the failing writes were really exercised");
  await ctx.api.deleteInvoice(inv.id);
  assert.equal(stockOf(ctx.api, tile.id), 20);
  assert.equal(logOf(ctx).length, 1);
});

test("D: a lost connection reports the failure and keeps the invoice; after reconnecting the delete works", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 20 });
  const inv = await sellLines(ctx, [{ product: tile, qty: "5" }], { paid: "6000" });
  ctx.api.db.close();
  await ctx.api.deleteInvoice(inv.id);
  assert.equal(ctx.api.getInvoices().length, 1);
  assert.equal(stockOf(ctx.api, tile.id), 15);
  assert.doesNotMatch(ctx.app.toast(), /deleted\./);
  await ctx.api.startStorage();
  await ctx.api.deleteInvoice(inv.id);
  assert.equal(ctx.api.getInvoices().length, 0);
  assert.equal(stockOf(ctx.api, tile.id), 20);
});

test("D: deleting the same invoice twice (two clicks, or two windows) gives the stock back once and logs one refund", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 20 });
  const inv = await sellLines(ctx, [{ product: tile, qty: "5" }], { paid: "6000" });
  const other = await boot({ indexedDB: ctx.app.indexedDB });
  assert.equal(other.api.getInvoices().length, 1);

  await Promise.all([ctx.api.deleteInvoice(inv.id), ctx.api.deleteInvoice(inv.id)]);
  await other.api.deleteInvoice(inv.id);   // the stale window: its copy still has the invoice

  const all = await ctx.api.db.loadAll();
  assert.equal(all.invoices.length, 0);
  assert.equal(all.products.find((p) => p.id === tile.id).stock, 20, "not 25 or 30");
  assert.equal(all.settings.rollbackLog.length, 1, "one refund record");
});

test("D: a delete followed at once by another operation does both, in order, and neither is lost", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 20 });
  const a = await sellLines(ctx, [{ product: tile, qty: "5" }], { name: "Amine", paid: "6000" });
  const b = await sellLines(ctx, [{ product: tile, qty: "2" }], { name: "Bilal" });
  await Promise.all([ctx.api.deleteInvoice(a.id), ctx.api.addPayment(b.id, "1500")]);
  assert.deepEqual(plain(ctx.api.getInvoices().map((i) => i.id)), [b.id]);
  assert.equal(invoiceById(ctx.api, b.id).payments[0].amount, 1500);
  assert.equal(stockOf(ctx.api, tile.id), 18, "5 back, b's 2 still out");
  assert.equal(logOf(ctx).length, 1);
});

test("D: the one refusal that remains: an invoice whose unpaid balance was carried to a newer invoice (the debt would be lost)", async () => {
  const ctx = await boot();
  const { api } = ctx;
  const tile = await addTile(ctx, { stock: 50 });
  const karim = { name: "Karim Benali", phone: "0555 11 22 33" };
  const old = await sellLines(ctx, [{ product: tile, qty: "5" }], { ...karim, paid: "4000" });
  api.addToSale(tile.id, "1", "box");
  api.getSale().customer.name = karim.name;
  api.getSale().customer.phone = karim.phone;
  api.onCustomerSettled();
  assert.equal(api.addDebtToSale([{ sourceInvoiceId: old.id, amount: 6000 }]).error, undefined);
  await api.completeSale();
  const before = await stored(ctx);
  await api.deleteInvoice(old.id);
  assert.match(ctx.app.toast(), /carried forward to INV-000002/);
  assert.deepEqual(await stored(ctx), before);
  // Deleting the NEWER invoice first is allowed, and then the older one can go too.
  await api.deleteInvoice(api.getInvoices()[1].id);
  await api.deleteInvoice(old.id);
  assert.equal(api.getInvoices().length, 0);
});

/* ==========================================================================
   E. Persistence
   ========================================================================== */

test("E: the refund log survives a reload, a restart, a settings change, a backup and a restore", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 20 });
  const inv = await sellLines(ctx, [{ product: tile, qty: "5" }], { name: "Karim", paid: "6000" });
  const kept = await sellLines(ctx, [{ product: tile, qty: "1" }], { name: "Other" });
  await ctx.api.deleteInvoice(inv.id);
  const entry = logOf(ctx)[0];

  await ctx.api.loadFromDatabase();
  assert.equal(invoiceById(ctx.api, inv.id), undefined, "a reload does not bring it back");
  assert.equal(stockOf(ctx.api, tile.id), 19, "and does not undo the stock");

  const restarted = await boot({ indexedDB: ctx.app.indexedDB });
  assert.deepEqual(plain(restarted.api.getState().invoices.map((i) => i.id)), [kept.id]);
  assert.deepEqual(plain(restarted.api.getState().settings.rollbackLog), [entry]);

  // Saving the business settings, the language or the paper keeps the log.
  await ctx.api.savePaper("A5");
  await ctx.api.saveLanguage("fr");
  await ctx.api.saveLanguage("en");
  assert.deepEqual(logOf(ctx), [entry]);

  // The backup file carries it, and a restore of that file brings it back with the same stock and invoices.
  await ctx.api.autoBackup.flushNow();
  const text = ctx.handle.content;
  const parsed = V.parseBackup(text);
  assert.equal(parsed.error, undefined, parsed.error);
  assert.deepEqual(parsed.warnings, []);
  assert.deepEqual(plain(parsed.data.settings.rollbackLog), [entry]);

  const fresh = await boot();
  const restored = await fresh.api.importBackup(fresh.app.file(text));
  assert.equal(restored && restored.error, undefined, restored && restored.error);
  assert.deepEqual(plain(fresh.api.getState().settings.rollbackLog), [entry]);
  assert.deepEqual(plain(fresh.api.getState().invoices.map((i) => i.id)), [kept.id]);
  assert.equal(fresh.api.getState().products.find((p) => p.id === tile.id).stock, 19);
});

test("E: data made before this feature (no refund log) loads, saves and shows exactly as before; a damaged log is refused", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx);
  await sellLines(ctx, [{ product: tile, qty: "1" }]);
  const settings = ctx.api.getState().settings;
  assert.equal("rollbackLog" in settings, false, "nothing is added to settings until a rollback happens");
  assert.equal(V.settingsProblem(settings), "");
  assert.equal("rollbackLog" in V.normalizeSettings({ businessName: "X" }), false);

  const good = { id: "e1", at: new Date().toISOString(), reason: "delete", invoiceId: "i1", invoiceNumber: "INV-000001", refund: 0 };
  assert.equal(V.settingsProblem({ ...settings, rollbackLog: [good] }), "");
  assert.notEqual(V.settingsProblem({ ...settings, rollbackLog: "x" }), "");
  assert.notEqual(V.settingsProblem({ ...settings, rollbackLog: [{ ...good, refund: -1 }] }), "");
  assert.notEqual(V.settingsProblem({ ...settings, rollbackLog: [{ ...good, reason: "other" }] }), "");
  assert.notEqual(V.settingsProblem({ ...settings, rollbackLog: [good, good] }), "", "the same record twice");
  const refused = await ctx.api.commit((d) => { d.settings.rollbackLog = [{ ...good, at: "not a date" }]; });
  assert.match(refused.error || "", /./, "the database refuses a damaged log");
  assert.equal("rollbackLog" in ctx.api.getState().settings, false);
});

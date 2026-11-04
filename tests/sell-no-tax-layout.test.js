"use strict";

// Sell page cleanup: no tax any more, and the cards in a 2 x 2 grid.
//   A  the page: no tax box or control, cards in the order Customer | Delivery, Discount | Totals
//   B  the money: subtotal - discount (+ delivery fee, which is never part of the products), payments as before
//   C  the live totals: no tax line on a new sale
//   D  invoices saved while tax existed: still valid, still add up, printed as before, never changed by accident
// Everything runs through the application's own functions against a disposable in-memory IndexedDB (no real data).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { V } = require("./helpers/modules");
const { plain, boot, addTile, sellLines, invoiceById, openEdit, typeQty } = require("./helpers/edit");

const root = path.join(__dirname, "..");
const indexHtml = fs.readFileSync(path.join(root, "index.html"), "utf8");
const sellCss = fs.readFileSync(path.join(root, "css", "sell.css"), "utf8");

// The part of the page that holds the four cards: from <div class="sale-fields"> up to the debt notice that follows it.
const fieldsHtml = indexHtml.slice(indexHtml.indexOf('<div class="sale-fields">'), indexHtml.indexOf('<section class="debt-notice'));

/* ==========================================================================
   A. The page
   ========================================================================== */

test("A: the Sell page has no tax box, tax type or tax control", () => {
  assert.ok(!/id="taxValue"|id="taxType"/.test(indexHtml), "the tax inputs are gone");
  assert.ok(!/sell\.taxType|discountTaxLegend/.test(indexHtml), "no tax label or legend is left");
  assert.ok(!/Discount and tax/i.test(indexHtml));
  assert.match(fieldsHtml, /<legend data-i18n="sell\.discountLegend">Discount<\/legend>/, "the card is called Discount");
  // The only tax element left is a read-only line, hidden unless an invoice saved with a tax is on screen (see D).
  assert.equal((indexHtml.match(/id="tTax"/g) || []).length, 1);
  assert.match(indexHtml, /<div id="tTaxRow" hidden><span data-i18n="sell\.tax">Tax<\/span><span id="tTax"><\/span><\/div>/);
});

test("A: the four cards are Customer | Delivery, then Discount | Totals, in one two-column grid", () => {
  const at = (needle) => {
    const i = fieldsHtml.indexOf(needle);
    assert.ok(i >= 0, needle + " is in the grid");
    return i;
  };
  const customer = at('data-i18n="sell.customerLegend"');
  const delivery = at('data-i18n="sell.deliveryLegend"');
  const discount = at('data-i18n="sell.discountLegend"');
  const totals = at('<div class="totals">');
  assert.ok(customer < delivery && delivery < discount && discount < totals, "document order = grid order (row by row)");
  assert.ok(at('id="custName"') < customer + 400 && at('id="deliveryPerson"') > delivery, "the fields sit in their own cards");
  assert.ok(at('id="discountValue"') > discount && at('id="discountValue"') < totals, "the discount box is in the Discount card");
  assert.ok(at('id="tSubtotal"') > totals && at('id="amountPaid"') > totals && at('id="tRemaining"') > totals, "subtotal, amount paid and remaining are in the totals card");
  // Exactly four direct children: three fieldsets and the totals card (no wrapper that would change the rows).
  assert.equal((fieldsHtml.match(/^ {10}<fieldset>/gm) || []).length, 3);
  assert.equal((fieldsHtml.match(/^ {10}<div class="totals">/gm) || []).length, 1);
  assert.ok(!fieldsHtml.includes("sale-fields-side"), "the side wrapper that stacked Discount above Delivery is gone");
  // The debt warning and the buttons still follow the grid.
  assert.ok(indexHtml.indexOf('id="debtNotice"') > indexHtml.indexOf('<div class="totals">'));
  assert.ok(indexHtml.indexOf('id="completeSale"') > indexHtml.indexOf('id="debtNotice"'));
});

test("A: the grid stays two columns when there is room and stacks (same order) when there is not; the totals card fills its cell", () => {
  assert.match(sellCss, /\.sell-sale \.sale-fields \{[^}]*grid-template-columns: repeat\(auto-fit, minmax\(290px, 1fr\)\)/);
  assert.ok(!sellCss.includes("sale-fields-side"));
  assert.match(sellCss, /\.sell-sale \.sale-fields \.totals \{ max-width: none; margin: 0; \}/, "no 340px cap, no right-aligned margin inside the grid (also in right-to-left)");
});

/* ==========================================================================
   B. The money
   ========================================================================== */

test("B: totals are subtotal - discount, whatever was left in an old sale object", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 40 });
  const { api } = ctx;
  api.addToSale(tile.id, "5", "box");                                // 10,000
  const sale = api.getSale();
  assert.ok(!("taxType" in sale) && !("taxValue" in sale), "a new sale has no tax fields");
  sale.discountType = "percent"; sale.discountValue = "10";
  assert.deepEqual(plain(api.calculateTotals(sale)), { subtotal: 10000, discount: 1000, tax: 0, total: 9000 });
  sale.taxType = "percent"; sale.taxValue = "19";                    // nothing reads these any more
  assert.deepEqual(plain(api.calculateTotals(sale)), { subtotal: 10000, discount: 1000, tax: 0, total: 9000 });
});

test("B: the delivery fee is owed on top of the products, never inside the subtotal or the discount; payments and balance as before", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 40 });
  const { api } = ctx;
  api.addToSale(tile.id, "5", "box");                                // 10,000
  const sale = api.getSale();
  sale.discountType = "percent"; sale.discountValue = "10";          // -1,000
  Object.assign(sale.delivery, { person: "Karim", phone: "0550", fee: "500" });
  sale.paidValue = "4000";
  assert.equal(api.calculateTotals(sale).total, 9000, "the fee is not in the products' total");
  assert.equal(api.saleDue(sale), 9500, "what the customer owes = products 9,000 + fee 500");
  await api.completeSale();
  const inv = api.getInvoices()[0];
  assert.deepEqual(plain([inv.subtotal, inv.discount, inv.tax, inv.total]), [10000, 1000, 0, 9000]);
  assert.equal(inv.deliveryInfo.fee, 500);
  assert.equal(inv.taxPercent, undefined);
  const pay = api.paymentInfo(inv);
  assert.deepEqual(plain([pay.paid, pay.remaining, pay.cls]), [4000, 5500, "partial"]);
  assert.equal(V.invoiceProblem(inv), "", "a new invoice passes the same validation as before");
  assert.equal((await api.addPayment(inv.id, "5500")).error, undefined);
  assert.equal(api.paymentInfo(api.getInvoices()[0]).cls, "paid");
});

test("B: a new invoice prints no tax line, and its summary adds up", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 40 });
  const inv = await sellLines(ctx, [{ product: tile, qty: "5" }], { discount: { type: "amount", value: "500" } });
  const html = ctx.api.invoiceHtml(inv);
  assert.ok(!/<td>Tax/.test(html), "no tax line");
  assert.match(html, /<td>Discount<\/td><td>500 DA<\/td>/);
  assert.match(html, /<td>TOTAL<\/td><td>9,500 DA<\/td>/);
});

/* ==========================================================================
   C. The live totals
   ========================================================================== */

test("C: the live totals of a new sale never show a tax line", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 40 });
  const { api, app } = ctx;
  api.addToSale(tile.id, "5", "box");
  api.getSale().discountType = "amount"; api.getSale().discountValue = "250";
  api.renderTotals();
  assert.equal(app.field("tTaxRow").hidden, true);
  assert.equal(app.field("tSubtotal").textContent, "10,000 DA");
  assert.equal(app.field("tDiscount").textContent, "250 DA");
  assert.equal(app.field("tTotal").textContent, "9,750 DA");
});

/* ==========================================================================
   D. Invoices saved while tax existed
   ========================================================================== */

// A saved invoice as it was made when tax existed: 10,000 - 1,000 discount + 900 tax = 9,900, with 2,000 paid.
async function legacyTaxedInvoice(ctx, tile) {
  const inv = await sellLines(ctx, [{ product: tile, qty: "5" }], { discount: { type: "percent", value: "10" }, paid: "2000" });
  const saved = invoiceById(ctx.api, inv.id);
  Object.assign(saved, { tax: 900, taxPercent: 10, total: 9900 });
  return saved;
}

test("D: an invoice with a stored tax stays valid, keeps its total and balance, and still prints its tax line", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 40 });
  const inv = await legacyTaxedInvoice(ctx, tile);
  assert.equal(V.invoiceProblem(inv), "", "subtotal - discount + tax = total still holds for it");
  const pay = ctx.api.paymentInfo(inv);
  assert.deepEqual(plain([pay.paid, pay.remaining, pay.cls]), [2000, 7900, "partial"]);
  const html = ctx.api.invoiceHtml(inv);
  assert.match(html, /<td>Tax \(10%\)<\/td><td>900 DA<\/td>/, "historical invoices keep their tax line");
  assert.match(html, /<td>TOTAL<\/td><td>9,900 DA<\/td>/);
});

test("D: an invoice made before this change that has no taxPercent at all still prints and validates", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 40 });
  const inv = await legacyTaxedInvoice(ctx, tile);
  delete inv.taxPercent;
  assert.equal(V.invoiceProblem(inv), "");
  assert.match(ctx.api.invoiceHtml(inv), /<td>Tax<\/td><td>900 DA<\/td>/);
});

test("D: correcting only the customer on such an invoice leaves its tax, total and payments exactly as they were", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 40 });
  const inv = await legacyTaxedInvoice(ctx, tile);
  openEdit(ctx, inv);
  ctx.api.getSale().customer.name = "Alexandre";
  await ctx.api.saveInvoiceEdit();
  const after = invoiceById(ctx.api, inv.id);
  assert.equal(after.customer.name, "Alexandre");
  assert.deepEqual(plain([after.subtotal, after.discount, after.tax, after.total]), [10000, 1000, 900, 9900]);
  assert.equal(after.taxPercent, 10);
  assert.deepEqual(plain(after.payments.map((p) => p.amount)), [2000]);
});

test("D: while such an invoice is edited the totals card shows its tax line and the banner says what a correction will do", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 40 });
  const inv = await legacyTaxedInvoice(ctx, tile);
  openEdit(ctx, inv);
  const { app, api } = ctx;
  api.renderTotals();
  assert.equal(app.field("tTaxRow").hidden, false);
  assert.equal(app.field("tTax").textContent, "900 DA");
  assert.equal(app.field("tTotal").textContent, "9,900 DA");
  assert.equal(app.field("editNotes").hidden, false);
  assert.match(app.field("editNotes").textContent, /tax of 900 DA/);
  assert.match(app.field("editNotes").textContent, /without tax/);
});

test("D: changing the products of such an invoice recalculates it without tax, and the edit history keeps both totals", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 40 });
  const inv = await legacyTaxedInvoice(ctx, tile);
  openEdit(ctx, inv);
  assert.equal(typeQty(ctx.api, 0, 4).error, undefined);             // 4 boxes = 8,000 - 800 = 7,200
  await ctx.api.saveInvoiceEdit();
  const after = invoiceById(ctx.api, inv.id);
  assert.deepEqual(plain([after.subtotal, after.discount, after.tax, after.total]), [8000, 800, 0, 7200]);
  assert.equal(after.taxPercent, null);
  assert.equal(V.invoiceProblem(after), "");
  const entry = after.edits[after.edits.length - 1];
  assert.deepEqual(plain([entry.totalBefore, entry.totalAfter]), [9900, 7200], "nothing is lost silently: the history says what the total was");
  assert.deepEqual(plain(after.payments.map((p) => p.amount)), [2000], "payments are never touched");
});

test("D: a saved invoice without any tax shows no tax row and no tax note while it is edited", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 40 });
  const inv = await sellLines(ctx, [{ product: tile, qty: "5" }]);
  openEdit(ctx, inv);
  ctx.api.renderTotals();
  assert.equal(ctx.app.field("tTaxRow").hidden, true);
  assert.equal(ctx.app.field("editNotes").hidden, true);
});

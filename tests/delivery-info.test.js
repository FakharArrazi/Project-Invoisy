"use strict";

// Optional delivery information on the Sell page and on the invoice: Delivery Person Name, Phone Number, Delivery Fee.
//   A  the Sell page: three optional boxes, the fee added to the final total, empty = nothing at all
//   B  the invoice, preview and print: a Delivery section and a summary line, hidden when empty, A4 and A5, dinars and centimes
//   C  reopening an invoice for editing keeps the delivery information (and editing it works)
//   D  refunds: the delivery fee is never handed back and is never sales revenue
//   E  data: older invoices are unchanged, bad values are refused, backups and the database keep it
// Everything runs through the application's own functions against a disposable in-memory IndexedDB (no real data).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { V, sampleInvoice } = require("./helpers/modules");
const { plain, boot, addTile, sellLines, stockOf, invoiceById, openEdit, typeQty, removeLine } = require("./helpers/edit");

const A = globalThis.Analytics;
const root = path.join(__dirname, "..");
const indexHtml = fs.readFileSync(path.join(root, "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "css", "style.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const KARIM = { person: "Karim Benali", phone: "0550 12 34 56", fee: "500" };

// 5 boxes at 2,000 DA = 10,000 DA of products; the delivery fee is typed on the Sell page before the sale is saved.
async function sellWithDelivery(ctx, tile, delivery, { qty = "5", paid = "", name = "Alex" } = {}) {
  const { api } = ctx;
  assert.equal(api.addToSale(tile.id, qty, "box").ok, true);
  const sale = api.getSale();
  sale.customer.name = name;
  sale.paidValue = paid;
  if (delivery) Object.assign(sale.delivery, delivery);
  await api.completeSale();
  const all = api.getInvoices();
  return all[all.length - 1];
}

const figuresOf = (api) => {
  const s = api.getState();
  return A.compute({ invoices: s.invoices, products: s.products, debtTransfers: s.debtTransfers, purchases: s.purchases }, { now: new Date(), lowStock: 5 });
};

/* ==========================================================================
   A. The Sell page
   ========================================================================== */

test("A: the page has a Delivery Information section with three optional boxes and a summary row", () => {
  for (const id of ["deliveryPerson", "deliveryPhone", "deliveryFee", "tDeliveryRow", "tDelivery"]) {
    assert.equal((indexHtml.match(new RegExp(`id="${id}"`, "g")) || []).length, 1, id);
  }
  const section = indexHtml.slice(indexHtml.indexOf('data-i18n="sell.deliveryLegend"'), indexHtml.indexOf('<!-- Warning about the customer'));
  assert.ok(section.includes('data-i18n="sell.deliveryPerson"') && section.includes('data-i18n="sell.deliveryPhone"') && section.includes('data-i18n="sell.deliveryFee"'));
  assert.ok(!/required/.test(section), "all three are optional");
  assert.match(indexHtml, /<input type="number" id="deliveryFee" min="0" step="any"/, "a numeric box that refuses negative numbers");
  assert.ok(indexHtml.indexOf('id="tDeliveryRow"') > indexHtml.indexOf('id="tTax"') && indexHtml.indexOf('id="tDeliveryRow"') < indexHtml.indexOf('id="tTotalRow"'), "the fee line sits between the tax and the total");
});

test("A: Final Total = products + delivery fee (10,000 + 500 = 10,500), shown live on the Sell page", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 40 });
  const { api, app } = ctx;
  api.addToSale(tile.id, "5", "box");

  api.renderTotals();
  assert.equal(app.field("tDeliveryRow").hidden, true, "no fee typed: no fee line");
  assert.equal(app.field("tTotal").textContent, "10,000 DA");

  Object.assign(api.getSale().delivery, { fee: "500" });
  api.renderTotals();
  assert.equal(app.field("tDeliveryRow").hidden, false);
  assert.equal(app.field("tDelivery").textContent, "500 DA");
  assert.equal(app.field("tTotal").textContent, "10,500 DA", "the final total includes the fee");
  assert.equal(app.field("tRemaining").textContent, "10,500 DA", "all of it is due now, not a separate amount later");
  assert.equal(api.saleDue(api.getSale()), 10500);
  assert.equal(api.calculateTotals(api.getSale()).total, 10000, "the products' own totals are untouched");
});

test("A: the saved invoice asks the customer for products + fee, and the fee is part of what is paid", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 40 });
  const inv = await sellWithDelivery(ctx, tile, KARIM, { paid: "10500" });

  assert.deepEqual(plain(inv.deliveryInfo), { person: "Karim Benali", phone: "0550 12 34 56", fee: 500 });
  assert.equal(inv.subtotal, 10000);
  assert.equal(inv.total, 10000, "total stays the products: it is what sales figures read");
  const pay = ctx.api.paymentInfo(inv);
  assert.equal(pay.due, 10500);
  assert.equal(pay.paid, 10500);
  assert.equal(pay.remaining, 0);
  assert.equal(pay.cls, "paid", "paying products + fee settles the invoice");
  assert.equal(stockOf(ctx.api, tile.id), 35, "stock moves only for the products");
  assert.equal((await ctx.api.db.loadAll()).invoices[0].deliveryInfo.fee, 500, "saved in the database");
});

test("A: paying only the products leaves the fee still due; paying more than products + fee is refused", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 40 });
  const part = await sellWithDelivery(ctx, tile, KARIM, { paid: "10000" });
  const pay = ctx.api.paymentInfo(part);
  assert.deepEqual([pay.cls, pay.remaining], ["partial", 500], "the fee is owed like the rest of the invoice");

  ctx.api.addToSale(tile.id, "5", "box");
  const sale = ctx.api.getSale();
  Object.assign(sale.delivery, KARIM);
  sale.paidValue = "10501";
  assert.ok(ctx.api.validateSale().length > 0, "10,501 is more than 10,500");
  sale.paidValue = "10500";
  assert.deepEqual(plain(ctx.api.validateSale()), []);
});

test("A: with every delivery box empty nothing about delivery is saved, shown or printed", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 40 });
  const { api, app } = ctx;
  const inv = await sellWithDelivery(ctx, tile, { person: "   ", phone: "", fee: "" });   // blanks and spaces only

  assert.equal("deliveryInfo" in inv, false, "the invoice has no delivery field at all");
  assert.equal(api.paymentInfo(inv).due, 10000);
  const html = api.invoiceHtml(inv);
  assert.ok(!html.includes("inv-delivery") && !/Delivery/i.test(html), "no section, no line");
  assert.equal(api.invoiceParts(inv).deliveryInfo, "");
  assert.equal(api.printItems(inv).some((x) => x.html && x.html.includes("inv-delivery")), false);
  api.addToSale(tile.id, "1", "box");
  api.renderTotals();
  assert.equal(app.field("tDeliveryRow").hidden, true);

  // A fee of 0 typed by hand is the same as nothing.
  const zero = await sellWithDelivery(ctx, tile, { fee: "0" });
  assert.equal("deliveryInfo" in zero, false);
});

test("A: a name or a phone without a fee is printed, and adds nothing to the total", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 40 });
  const inv = await sellWithDelivery(ctx, tile, { person: "Karim", phone: "", fee: "" });
  assert.deepEqual(plain(inv.deliveryInfo), { person: "Karim", phone: "", fee: 0 });
  assert.equal(ctx.api.paymentInfo(inv).due, 10000);
  const html = ctx.api.invoiceHtml(inv);
  assert.ok(html.includes("inv-delivery") && html.includes("Karim"));
  assert.ok(!html.includes("Delivery fee"), "no fee, no fee line");
  assert.ok(html.includes("10,000 DA"));
});

test("A: a negative or invalid delivery fee is refused with a message and no invoice is made", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 40 });
  ctx.api.addToSale(tile.id, "5", "box");
  const sale = ctx.api.getSale();
  for (const bad of ["-5", "abc", "1e999"]) {
    sale.delivery.fee = bad;
    assert.ok(ctx.api.validateSale().some((e) => /delivery fee must be a number/i.test(e)), `"${bad}" is refused`);
  }
  sale.delivery.fee = "-5";
  await ctx.api.completeSale();
  assert.equal(ctx.api.getInvoices().length, 0, "nothing was saved");
  assert.equal(stockOf(ctx.api, tile.id), 40);
});

test("A: the delivery boxes are cleared with the sale and never leak into the next one", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 40 });
  const { api, app } = ctx;
  await sellWithDelivery(ctx, tile, KARIM);
  assert.deepEqual(plain(api.getSale().delivery), { person: "", phone: "", fee: "" }, "the sale was reset after saving");
  for (const id of ["deliveryPerson", "deliveryPhone", "deliveryFee"]) assert.equal(app.field(id).value, "", id);

  api.addToSale(tile.id, "1", "box");
  Object.assign(api.getSale().delivery, KARIM);
  api.clearSale();
  assert.deepEqual(plain(api.getSale().delivery), { person: "", phone: "", fee: "" }, "Clear empties the delivery boxes too");
  assert.equal(app.field("deliveryFee").value, "");
});

/* ==========================================================================
   B. The invoice: preview and print
   ========================================================================== */

test("B: the invoice shows a Delivery section (name, phone, fee) and the fee as its own summary line inside the final total", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 40 });
  const inv = await sellWithDelivery(ctx, tile, KARIM, { paid: "4000" });
  const html = ctx.api.invoiceHtml(inv);
  const parts = ctx.api.invoiceParts(inv);

  for (const text of ["DELIVERY", "Delivery person", "Karim Benali", "Phone", "0550 12 34 56", "Delivery fee", "500 DA"]) assert.ok(parts.deliveryInfo.includes(text), text);
  assert.ok(html.indexOf("inv-table") < html.indexOf("inv-delivery") && html.indexOf("inv-delivery") < html.indexOf("inv-summary"), "products, then delivery, then the summary");

  const totals = parts.summary;
  const at = (label) => totals.indexOf(label);
  assert.ok(at(">Tax<") < at("<td>Delivery fee</td>") && at("<td>Delivery fee</td>") < at("<td>TOTAL</td>"), "subtotal, discount, tax, delivery fee, then the final total");
  assert.match(totals, /<td>Delivery fee<\/td><td>500 DA<\/td>/);
  assert.match(totals, /<tr class="grand"><td>TOTAL<\/td><td>10,500 DA<\/td><\/tr>/, "the final total is products + fee");
  assert.match(totals, /Remaining<\/td><td>6,500 DA<\/td>/, "10,500 due, 4,000 paid");
});

test("B: the live preview and the printed pages are built from the same markup", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 40 });
  const { api } = ctx;
  api.addToSale(tile.id, "5", "box");
  Object.assign(api.getSale().delivery, KARIM);
  const draft = api.draftInvoice();                               // what the live preview shows while typing
  const draftParts = api.invoiceParts(draft);
  assert.ok(draftParts.deliveryInfo.includes("Karim Benali") && /Delivery fee<\/td><td>500 DA/.test(draftParts.summary));

  await api.completeSale();
  const saved = api.getInvoices()[0];
  assert.equal(api.invoiceParts(saved).deliveryInfo, draftParts.deliveryInfo, "preview section = saved invoice section");
  assert.equal(api.invoiceParts(saved).summary.replace(/inv-status[\s\S]*$/, ""), draftParts.summary.replace(/inv-status[\s\S]*$/, ""), "same totals");

  // The printed pages: the section is its own block that stays whole, just before the summary block.
  const items = api.printItems(saved);
  const index = items.findIndex((x) => x.kind === "block" && x.html === api.invoiceParts(saved).deliveryInfo);
  assert.ok(index > 0 && items[index + 1].html.includes("inv-summary"), "printed: delivery block, then the summary");
});

test("B: A4 and A5 print the same invoice; the paper size only changes sizes in CSS and nothing hides the section", () => {
  assert.match(css, /\.inv-delivery \{[^}]*margin-top/, "the section has its own style");
  assert.match(css, /\.inv-table tr, \.inv-totals, \.inv-summary, \.inv-status, \.inv-payments, \.inv-carried, \.inv-delivery \{ page-break-inside: avoid; \}/);
  // The A5 rules only change padding and font sizes, for the invoice as a whole: none of them mentions or hides the delivery section.
  const a5 = css.split("\n").filter((line) => /data-paper="a5"/.test(line));
  assert.ok(a5.length > 0 && a5.every((line) => !/inv-delivery/.test(line) && !/display:\s*none/.test(line.replace(/\.collection-print[^{]*\{/, ""))));
  assert.ok(/\.inv-delivery-lines \{ display: flex; flex-wrap: wrap/.test(css), "long names wrap instead of overflowing a narrow A5 page");
});

test("B: in centimes the fee and the final total read in centimes, like every other amount on the invoice", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 40 });
  const inv = await sellWithDelivery(ctx, tile, KARIM);
  await ctx.api.saveCurrencyUnit("centimes");
  const html = ctx.api.invoiceHtml(inv);
  assert.ok(html.includes("50,000 centimes"), "500 DA = 50,000 centimes");
  assert.ok(html.includes("1,050,000 centimes"), "10,500 DA = 1,050,000 centimes");
  assert.equal(invoiceById(ctx.api, inv.id).deliveryInfo.fee, 500, "stored in dinars, only the display changes");
});

test("B: debt carried onto the invoice: the purchase total includes the fee, and the total due adds the debt", () => {
  const ctx = require("./helpers/app").loadApp();
  const inv = sampleInvoice({
    number: 5, subtotal: 10000, discount: 0, tax: 0, total: 10000, payments: [],
    deliveryInfo: { person: "Karim", phone: "", fee: 500 },
    carriedForward: [{ transferId: "t-1", sourceInvoiceId: "i-1", sourceInvoiceNumber: "INV-000001", sourceDate: "2026-10-01T12:00:00.000Z", amount: 2000 }],
  });
  const parts = ctx.api.invoiceParts(inv);
  assert.match(parts.summary, /<td>TOTAL \(this purchase\)<\/td><td>10,500 DA<\/td>/);
  assert.match(parts.summary, /Balance carried forward<\/td><td>2,000 DA/);
  assert.match(parts.summary, /<td>TOTAL DUE<\/td><td>12,500 DA<\/td>/);
  assert.match(parts.summary, /<td>Delivery fee<\/td><td>500 DA<\/td>/);
});

test("B: French and Arabic labels, and an unsafe name is escaped", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 40 });
  const inv = await sellWithDelivery(ctx, tile, { person: "<b>Karim</b> & fils", phone: "0550", fee: "500" });
  const en = ctx.api.invoiceHtml(inv);
  assert.ok(en.includes("&lt;b&gt;Karim&lt;/b&gt; &amp; fils") && !en.includes("<b>Karim"));
  await ctx.api.saveLanguage("fr");
  const fr = ctx.api.invoiceHtml(inv);
  for (const text of ["LIVRAISON", "Livreur", "Téléphone", "Frais de livraison"]) assert.ok(fr.includes(text), text);
  await ctx.api.saveLanguage("ar");
  assert.ok(ctx.api.invoiceHtml(inv).includes("رسوم التوصيل"));
});

/* ==========================================================================
   C. Reopening an invoice for editing
   ========================================================================== */

test("C: reopening an invoice shows its delivery information in the boxes; leaving without a change keeps it", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 40 });
  const inv = await sellWithDelivery(ctx, tile, KARIM, { paid: "2000" });
  const { api, app } = ctx;

  const sale = openEdit(ctx, inv);
  assert.deepEqual(plain(sale.delivery), { person: "Karim Benali", phone: "0550 12 34 56", fee: "500" });
  assert.equal(app.field("deliveryPerson").value, "Karim Benali");
  assert.equal(app.field("deliveryPhone").value, "0550 12 34 56");
  assert.equal(app.field("deliveryFee").value, "500");
  assert.equal(api.editDirty(), false, "just opening is no change");
  assert.equal(api.editPlan().skip, true, "nothing to save");

  const revision = (await api.db.loadAll()).revision;
  await api.saveInvoiceEdit();
  assert.equal((await api.db.loadAll()).revision, revision, "nothing was written");
  assert.deepEqual(plain(invoiceById(api, inv.id).deliveryInfo), plain(inv.deliveryInfo));
});

test("C: editing the fee changes what is due, never the products, the payments or the stock", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 40 });
  const inv = await sellWithDelivery(ctx, tile, KARIM, { paid: "5000" });
  const { api, app } = ctx;

  const sale = openEdit(ctx, inv);
  sale.delivery.fee = "800";
  sale.delivery.person = "Yacine";
  assert.equal(api.editDirty(), true);
  assert.equal(api.editPlan().error, undefined);
  api.renderTotals();
  assert.equal(app.field("tTotal").textContent, "10,800 DA", "the corrected final total");
  assert.equal(app.field("tDelivery").textContent, "800 DA");
  await api.saveInvoiceEdit();

  const saved = invoiceById(api, inv.id);
  assert.deepEqual(plain(saved.deliveryInfo), { person: "Yacine", phone: "0550 12 34 56", fee: 800 });
  assert.equal(saved.total, 10000);
  assert.deepEqual(plain(saved.payments), plain(inv.payments), "payments are never rewritten");
  assert.equal(api.paymentInfo(saved).due, 10800);
  assert.equal(api.paymentInfo(saved).remaining, 5800);
  assert.equal(stockOf(api, tile.id), 35, "no stock moved");
  assert.equal(saved.edits.length, 1);
  assert.equal(saved.edits[0].deliveryFeeBefore, 500);
  assert.equal(saved.edits[0].deliveryFeeAfter, 800);
});

test("C: changing the products keeps the delivery information; clearing the three boxes removes it", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 40 });
  const inv = await sellWithDelivery(ctx, tile, KARIM, { paid: "10500" });
  const { api } = ctx;

  openEdit(ctx, inv);
  typeQty(api, 0, 4);
  await api.saveInvoiceEdit();
  let saved = invoiceById(api, inv.id);
  assert.equal(saved.total, 8000);
  assert.equal(saved.deliveryInfo.fee, 500, "still there");
  assert.equal(api.paymentInfo(saved).due, 8500);

  const sale = openEdit(ctx, saved);
  Object.assign(sale.delivery, { person: "", phone: "", fee: "" });
  await api.saveInvoiceEdit();
  saved = invoiceById(api, inv.id);
  assert.equal("deliveryInfo" in saved, false, "an invoice with empty boxes has no delivery information");
  assert.equal(api.paymentInfo(saved).due, 8000);
  assert.ok(!api.invoiceHtml(saved).includes("inv-delivery"));
});

test("C: delivery information can be added to an older invoice that has none", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 40 });
  const inv = await sellWithDelivery(ctx, tile, null, { paid: "10000" });
  assert.equal(ctx.api.paymentInfo(inv).cls, "paid");
  const sale = openEdit(ctx, inv);
  Object.assign(sale.delivery, { person: "Karim", fee: "300" });
  await ctx.api.saveInvoiceEdit();
  const saved = invoiceById(ctx.api, inv.id);
  assert.equal(saved.deliveryInfo.fee, 300);
  const pay = ctx.api.paymentInfo(saved);
  assert.deepEqual([pay.due, pay.remaining, pay.cls], [10300, 300, "partial"]);
});

test("C: an invalid fee typed while editing blocks Save and changes nothing", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 40 });
  const inv = await sellWithDelivery(ctx, tile, KARIM);
  const sale = openEdit(ctx, inv);
  sale.delivery.fee = "-1";
  assert.match(ctx.api.editPlan().error, /delivery fee must be a number/i);
  await ctx.api.saveInvoiceEdit();
  assert.equal(invoiceById(ctx.api, inv.id).deliveryInfo.fee, 500);
});

/* ==========================================================================
   D. Refunds: the delivery fee is never handed back and is not revenue
   ========================================================================== */

test("D: returning products refunds only the product amount; the fee is never part of what is owed back", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 40 });
  const inv = await sellWithDelivery(ctx, tile, KARIM, { paid: "10500" });   // paid in full, fee included
  const { api } = ctx;

  openEdit(ctx, inv);
  typeQty(api, 0, 4);                                                        // one box (2,000 DA) comes back
  await api.saveInvoiceEdit();
  const saved = invoiceById(api, inv.id);
  const pay = api.paymentInfo(saved);
  assert.equal(pay.refundDue, 2000, "exactly the returned box, not 2,500");
  assert.equal(stockOf(api, tile.id), 36, "the box is back in stock");

  assert.match((await api.recordRefund(inv.id, "2500")).error, /more than|too much|exceed|max/i, "the fee can not be refunded through a refund either");
  assert.equal((await api.recordRefund(inv.id, "2000")).error, undefined);
  const after = api.paymentInfo(invoiceById(api, inv.id));
  assert.equal(after.refundDue, 0);
  assert.equal(after.refunded, 2000);
  assert.equal(after.paid - after.refunded, 8500, "what the shop keeps: 8,000 of products + the 500 fee that was already paid out");
});

test("D: removing every product refunds the product amount only, and the confirmation says the fee is kept", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 40 });
  const inv = await sellWithDelivery(ctx, tile, KARIM, { paid: "10500" });
  const { api, app } = ctx;

  openEdit(ctx, inv);
  removeLine(api, 0);
  const plan = api.editPlan();
  assert.equal(plan.deleted, true);
  assert.equal(plan.refund, 10000, "10,500 collected, 500 of it is the delivery fee");
  assert.equal(plan.deliveryFee, 500);

  await api.saveInvoiceEdit();
  const question = app.confirms[app.confirms.length - 1];
  assert.match(question, /Original total: 10,500 DA/);
  assert.match(question, /Amount collected: 10,500 DA/);
  assert.match(question, /Refund to hand back: 10,000 DA/);
  assert.match(question, /Delivery fee kept, never refunded: 500 DA/);
  assert.equal(api.getInvoices().length, 0);
  assert.equal(stockOf(api, tile.id), 40);
  const [entry] = api.getState().settings.rollbackLog;
  assert.equal(entry.refund, 10000);
  assert.equal(entry.paid, 10500);
  assert.equal(entry.deliveryFee, 500);
  assert.match(app.toast(), /10,000/);
  assert.doesNotMatch(app.toast(), /10,500/);
});

test("D: deleting an invoice: the refund is what was collected beyond the fee (and 0 while less than the fee was paid)", async () => {
  for (const [paid, refund] of [["10500", 10000], ["3000", 2500], ["300", 0], ["", 0]]) {
    const ctx = await boot();
    const tile = await addTile(ctx, { stock: 40 });
    const inv = await sellWithDelivery(ctx, tile, KARIM, { paid });
    await ctx.api.deleteInvoice(inv.id);
    assert.equal(ctx.api.getInvoices().length, 0);
    assert.equal(stockOf(ctx.api, tile.id), 40);
    const [entry] = ctx.api.getState().settings.rollbackLog;
    assert.equal(entry.refund, refund, `paid ${paid || 0}`);
    assert.equal(entry.deliveryFee, 500);
  }
});

test("D: an invoice without delivery information is refunded exactly as before", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 40 });
  const inv = await sellWithDelivery(ctx, tile, null, { paid: "10000" });
  await ctx.api.deleteInvoice(inv.id);
  const [entry] = ctx.api.getState().settings.rollbackLog;
  assert.equal(entry.refund, 10000);
  assert.equal("deliveryFee" in entry, false, "the log keeps its old shape");
});

test("D: the delivery fee is not sales revenue; what the customer still owes for it is an outstanding balance", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 40 });
  await sellWithDelivery(ctx, tile, KARIM, { name: "Karim", paid: "" });
  const f = figuresOf(ctx.api);
  assert.equal(f.cards.today.sales, 10000, "sales = the products only");
  assert.equal(f.bestSelling.byRevenue[0].revenue, 10000);
  assert.equal(f.cards.outstanding.total, 10500, "the customer still owes products + fee");
});

/* ==========================================================================
   E. Data: older invoices, validation, backups
   ========================================================================== */

test("E: an invoice made before this feature behaves exactly as it did", () => {
  const old = sampleInvoice({ number: 3 });
  assert.equal(V.amountDue(old), 1900);
  assert.equal(V.deliveryFeeOf(old), 0);
  assert.equal(V.deliveryInfoOf(old), null);
  assert.equal(V.refundableOf(old), 500, "everything held is refundable when there is no fee");
  assert.equal(V.invoiceProblem(old), "");
  const clean = V.normalizeInvoice(old);
  assert.equal("deliveryInfo" in clean, false, "no field is invented");
  const backup = JSON.parse(JSON.stringify(V.buildBackup({ products: [], invoices: [old], settings: { ...V.DEFAULT_SETTINGS }, counter: 3 }, new Date(Date.UTC(2026, 9, 9, 12)))));
  assert.equal("amountDue" in backup.data.invoices[0], false, "backups of such invoices keep their shape");
});

test("E: cleanDeliveryInfo tidies what was typed and never keeps a negative or invalid fee", () => {
  assert.deepEqual(plain(V.cleanDeliveryInfo({ person: "  Karim   Benali ", phone: " 0550  12 ", fee: "500.456" })), { person: "Karim Benali", phone: "0550 12", fee: 500.46 });
  assert.equal(V.cleanDeliveryInfo({ person: "", phone: "", fee: "" }), null);
  assert.equal(V.cleanDeliveryInfo({ fee: "0" }), null);
  assert.equal(V.cleanDeliveryInfo({ fee: "-3" }), null, "a negative fee is nothing");
  assert.equal(V.cleanDeliveryInfo({ fee: "abc" }), null);
  assert.equal(V.cleanDeliveryInfo(null), null);
  assert.equal(V.cleanDeliveryInfo({ person: "x".repeat(500) }).person.length, 80);
});

test("E: a malformed delivery field in a file is reported, a valid one is accepted", () => {
  const good = sampleInvoice({ number: 4, deliveryInfo: { person: "Karim", phone: "", fee: 500 } });
  assert.equal(V.invoiceProblem(good), "");
  for (const bad of [{ person: "K", phone: "", fee: -1 }, { person: "K", phone: "", fee: "500" }, { person: 5, phone: "", fee: 1 }, { person: "K", fee: 1 }, [], "x", 5]) {
    assert.match(V.invoiceProblem(sampleInvoice({ number: 4, deliveryInfo: bad })), /invalid delivery information/, JSON.stringify(bad));
  }
  assert.equal(V.deliveryFeeOf({ deliveryInfo: { person: "K", phone: "", fee: "5000" } }), 0, "a fee that is not a number is never trusted");
});

test("E: the delivery information travels in a backup, with the amount due written for people reading the file", async () => {
  const inv = sampleInvoice({ number: 6, subtotal: 2000, discount: 0, total: 2000, payments: [{ amount: 1000, timestamp: "2026-10-01T12:00:00.000Z" }], deliveryInfo: { person: "Karim", phone: "0550", fee: 300 } });
  const data = { products: [], invoices: [inv], settings: { ...V.DEFAULT_SETTINGS }, counter: 6 };
  const text = JSON.stringify(V.buildBackup(data, new Date(Date.UTC(2026, 9, 9, 12))));
  const written = JSON.parse(text).data.invoices[0];
  assert.deepEqual(written.deliveryInfo, { person: "Karim", phone: "0550", fee: 300 });
  assert.equal(written.amountDue, 2300);
  assert.equal(written.remaining, 1300);
  const read = V.parseBackup(text);
  assert.equal(read.error, undefined, read.error);
  assert.deepEqual(plain(read.data.invoices[0].deliveryInfo), { person: "Karim", phone: "0550", fee: 300 });
  assert.equal("amountDue" in read.data.invoices[0], false, "derived figures are recalculated, never trusted");
  assert.equal(V.amountDue(read.data.invoices[0]), 2300);
});

"use strict";

// The Invoices page: the table, search and sorting, and deleting an invoice.
//   A  the table lists every invoice once, with its figures and the same action buttons as before
//   B  search by number, customer (both names) and phone; clearing it; the empty state
//   C  sorting by number, date, customer, total, paid, remaining and status with the correct data types; sorting + searching together
//   D  deleting: asked first (Cancel leaves everything), saved for good, numbering and stock untouched, refusals explained, failures reported
// Everything runs through the application's own functions against a disposable in-memory IndexedDB (no real data).
// The real-browser side (layout, dialog, keyboard, reload) is in tests/e2e/invoices_page_check.py.

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./helpers/app");
const {
  V, plain, boot, addTile, sellLines, stockOf, snapshot, openEdit, removeLine,
} = require("./helpers/edit");

const bodyHtml = (ctx) => ctx.app.field("invoiceBody").innerHTML;
const numbersShown = (ctx) => [...bodyHtml(ctx).matchAll(/<td class="invoice-no"[^>]*>([^<]+)<\/td>/g)].map((m) => m[1]);
const seq = (n) => V.invoiceSequence(n);

// Draws the table and returns the invoice numbers in the order the rows are drawn.
function draw(ctx) {
  ctx.api.renderInvoices();
  return numbersShown(ctx);
}

// Sets the search box the way typing does, then redraws.
function type(ctx, text) {
  ctx.app.field("invoiceFilter").value = text;
  return draw(ctx);
}

// Several invoices with different customers, quantities (so totals) and payments. Returns the tile and the invoices in creation order.
async function manyInvoices(ctx, count = 12) {
  const tile = await addTile(ctx, { stock: 500 });
  const names = ["bravo", "Alpha", "Charlie", "alpha two", "Delta"];
  const qtys = [9, 2, 11, 1, 5, 12, 3, 8, 4, 10, 6, 7];
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(await sellLines(ctx, [{ product: tile, qty: String(qtys[i % qtys.length]) }], {
      name: i === 5 ? "" : names[i % names.length],
      phone: i === 1 ? "0555 11 22 33" : "",
      paid: i % 3 === 0 ? "1000" : i % 3 === 1 ? "" : String(qtys[i % qtys.length] * 2000),   // part paid, unpaid, paid in full
    }));
  }
  return { tile, invoices: ctx.api.getInvoices().slice() };
}

// A stand-in for the <dialog>: it opens and closes and remembers what the page put in it.
function dialogStandIn(ctx) {
  const seen = { opens: 0, closes: 0, open: false, focused: null };
  const dialog = ctx.app.field("invoiceDeleteDialog");
  dialog.showModal = () => { seen.opens++; seen.open = true; };
  dialog.close = () => { seen.closes++; seen.open = false; };
  ctx.app.field("invoiceDeleteCancel").focus = () => { seen.focused = "cancel"; };
  ctx.app.field("invoiceDeleteConfirm").focus = () => { seen.focused = "delete"; };
  return seen;
}

// boot() connects a backup file, which announces itself; the tests below look at what deleting says.
const quiet = (ctx) => { ctx.app.field("toast").textContent = ""; };

const flush = () => new Promise((resolve) => setImmediate(resolve));

/* ==========================================================================
   A. The table
   ========================================================================== */

test("A: every invoice is listed once, newest first, with its figures and its six actions", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx);
  await sellLines(ctx, [{ product: tile, qty: "5" }], { name: "Karim Benali", paid: "1000" });
  await sellLines(ctx, [{ product: tile, qty: "1" }], { name: "<b>Sara</b> & Co" });
  await sellLines(ctx, [{ product: tile, qty: "2" }], { name: "Amine", paid: "4000" });

  assert.deepEqual(draw(ctx), ["INV-000003", "INV-000002", "INV-000001"]);
  assert.equal(ctx.app.field("invoiceCount").textContent, "3 of 3 invoices");
  assert.equal(ctx.app.field("invoiceTable").hidden, false);
  assert.equal(ctx.app.field("invoiceEmpty").hidden, true);

  const html = bodyHtml(ctx);
  assert.match(html, /Karim Benali/);
  assert.match(html, /&lt;b&gt;Sara&lt;\/b&gt; &amp; Co/, "a name is shown as text, never as markup");
  assert.doesNotMatch(html, /<b>Sara/);
  assert.match(html, /<span class="badge unpaid">Unpaid<\/span>/);
  assert.match(html, /<span class="badge partial">Partial/);
  assert.match(html, /<span class="badge paid">Paid<\/span>/);

  // The same actions as before, each one naming its invoice.
  for (const number of ["INV-000001", "INV-000002", "INV-000003"]) {
    for (const [action, label] of [["view", "View"], ["pay", "Add Payment"], ["print", "Print"], ["edit", "Edit"], ["delete", "Delete"]]) {
      assert.ok(html.includes(`aria-label="${label} ${number}"`), `${label} ${number}`);
      assert.ok(html.includes(`data-action="${action}"`));
    }
  }
  assert.equal((html.match(/data-action="delete"/g) || []).length, 3, "every invoice has a Delete button");
  // A paid invoice has nothing left to pay: its payment button is off, as before.
  assert.match(html, /data-action="pay" disabled aria-label="Add Payment INV-000003"/);
});

test("A: with no invoice the page says so and shows no table", async () => {
  const ctx = await boot();
  draw(ctx);
  assert.equal(ctx.app.field("invoiceTable").hidden, true);
  assert.equal(ctx.app.field("invoiceEmpty").hidden, false);
  assert.match(ctx.app.field("invoiceEmpty").innerHTML, /No invoices yet\./);
  assert.equal(ctx.app.field("invoiceCount").textContent, "");
});

/* ==========================================================================
   B. Search
   ========================================================================== */

test("B: the list follows what is typed: invoice number, customer (either name, any case) and phone", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx);
  await sellLines(ctx, [{ product: tile, qty: "1" }], { name: "Karim Benali", phone: "0555 11 22 33" });
  await sellLines(ctx, [{ product: tile, qty: "1" }], { name: "Sara Haddad" });
  ctx.api.getSale();
  // A second customer on one invoice.
  ctx.api.addToSale(tile.id, "1", "box");
  ctx.api.getSale().customer.name = "Alex";
  ctx.api.getSale().secondCustomer.name = "Jack Builder";
  await ctx.api.completeSale();

  assert.deepEqual(type(ctx, ""), ["INV-000003", "INV-000002", "INV-000001"]);
  assert.deepEqual(type(ctx, "INV-000002"), ["INV-000002"], "by invoice number");
  assert.deepEqual(type(ctx, "000001"), ["INV-000001"], "by a part of the number");
  assert.deepEqual(type(ctx, "KARIM"), ["INV-000001"], "by customer, any case");
  assert.deepEqual(type(ctx, "benali karim"), ["INV-000001"], "every word must match");
  assert.deepEqual(type(ctx, "jack"), ["INV-000003"], "by the second customer");
  assert.deepEqual(type(ctx, "alex"), ["INV-000003"], "by the first customer");
  assert.deepEqual(type(ctx, "0555112233"), ["INV-000001"], "by phone, spaces ignored");
  assert.equal(ctx.app.field("invoiceCount").textContent, "1 of 3 invoices");
});

test("B: the cross in the search box shows only while something is typed; no match gives a clean empty state with a way back", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx);
  await sellLines(ctx, [{ product: tile, qty: "1" }], { name: "Karim" });

  draw(ctx);
  assert.equal(ctx.app.field("invoiceSearchClear").hidden, true);
  assert.equal(ctx.app.field("invoiceClear").hidden, true);

  assert.deepEqual(type(ctx, "zzz"), [], "nothing matches");
  assert.equal(ctx.app.field("invoiceSearchClear").hidden, false);
  assert.equal(ctx.app.field("invoiceTable").hidden, true);
  assert.equal(ctx.app.field("invoiceEmpty").hidden, false);
  assert.match(ctx.app.field("invoiceEmpty").innerHTML, /No invoices match &quot;zzz&quot;\./);
  assert.match(ctx.app.field("invoiceEmpty").innerHTML, /data-action="clear-filters"/, "a button brings the full list back");
  assert.equal(ctx.app.field("invoiceCount").textContent, "0 of 1 invoices");

  ctx.api.clearInvoiceFilters();
  assert.equal(ctx.app.field("invoiceFilter").value, "");
  assert.deepEqual(numbersShown(ctx), ["INV-000001"]);
  assert.equal(ctx.app.field("invoiceSearchClear").hidden, true);
  assert.equal(ctx.app.field("invoiceEmpty").hidden, true);
});

/* ==========================================================================
   C. Sorting
   ========================================================================== */

test("C: invoice numbers sort as numbers (INV-000010 after INV-000009), and clicking again reverses", async () => {
  const ctx = await boot();
  await manyInvoices(ctx, 12);

  ctx.api.setInvoiceSort("number");
  let shown = numbersShown(ctx);
  assert.deepEqual(shown.map(seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], "ascending, numerically");
  assert.deepEqual([...shown].sort(), shown, "which is also the text order here (zero padded)");

  ctx.api.setInvoiceSort("number");
  assert.deepEqual(numbersShown(ctx).map(seq), [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1], "descending");
  assert.equal(ctx.api.invoiceView.sortKey, "number");
  assert.equal(ctx.api.invoiceView.sortDir, -1);
});

test("C: totals, paid and remaining sort as numbers, never as text", async () => {
  const ctx = await boot();
  const { invoices } = await manyInvoices(ctx, 12);
  const pay = (inv) => ctx.api.paymentInfo(inv);
  const byNumber = new Map(invoices.map((i) => [i.invoiceNumber, i]));

  for (const [key, read] of [["total", (i) => pay(i).due], ["paid", (i) => pay(i).paid], ["remaining", (i) => pay(i).remaining]]) {
    ctx.api.invoiceView.sortKey = null;
    ctx.api.setInvoiceSort(key);
    const values = numbersShown(ctx).map((n) => read(byNumber.get(n)));
    assert.deepEqual(values, [...values].sort((a, b) => a - b), `${key} ascending`);
    ctx.api.setInvoiceSort(key);
    const reversed = numbersShown(ctx).map((n) => read(byNumber.get(n)));
    assert.deepEqual(reversed, [...reversed].sort((a, b) => b - a), `${key} descending`);
    assert.equal(new Set(values).size > 3, true, `${key}: the data really differs, so the test means something`);
  }
});

test("C: dates sort by time, not as text (20/12/2025 comes before 05/01/2026)", async () => {
  const ctx = await boot();
  const { invoices } = await manyInvoices(ctx, 6);
  // As text, "05/01/2026" < "20/12/2025" < "28/02/2026"; as dates the order is Dec 2025, Jan 2026, Feb 2026.
  const dates = ["2026-01-05T09:00:00.000Z", "2025-12-20T09:00:00.000Z", "2026-02-28T09:00:00.000Z", "2025-11-30T09:00:00.000Z", "2026-01-15T09:00:00.000Z", "2025-12-31T09:00:00.000Z"];
  await ctx.api.commit((d) => { d.invoices.forEach((inv, i) => { inv.date = dates[i]; }); });
  const dateOf = new Map(ctx.api.getInvoices().map((i) => [i.invoiceNumber, Date.parse(i.date)]));

  ctx.api.setInvoiceSort("date");
  const asc = numbersShown(ctx).map((n) => dateOf.get(n));
  assert.deepEqual(asc, [...asc].sort((a, b) => a - b), "oldest first");
  ctx.api.setInvoiceSort("date");
  const desc = numbersShown(ctx).map((n) => dateOf.get(n));
  assert.deepEqual(desc, [...desc].sort((a, b) => b - a), "newest first");
  assert.equal(numbersShown(ctx).length, invoices.length, "no invoice is lost by sorting");
});

test("C: customers sort A-Z ignoring case; the heading shows the active column and direction", async () => {
  const ctx = await boot();
  await manyInvoices(ctx, 10);
  const label = (n) => ctx.api.customerLabel(ctx.api.getInvoices().find((i) => i.invoiceNumber === n).customer.name).toLowerCase();

  ctx.api.setInvoiceSort("customer");
  const asc = numbersShown(ctx).map(label);
  assert.deepEqual(asc, [...asc].sort((a, b) => a.localeCompare(b)));
  assert.equal(asc[0] <= asc[asc.length - 1], true);
  ctx.api.setInvoiceSort("customer");
  const desc = numbersShown(ctx).map(label);
  assert.deepEqual(desc, [...desc].sort((a, b) => b.localeCompare(a)));
});

test("C: sorting and searching work together and never lose or hide an invoice", async () => {
  const ctx = await boot();
  const { invoices } = await manyInvoices(ctx, 12);
  const all = invoices.map((i) => i.invoiceNumber).sort();
  const pay = (n) => ctx.api.paymentInfo(invoices.find((i) => i.invoiceNumber === n));

  // Every sort key, both directions, shows exactly the same set of invoices.
  for (const key of ["number", "date", "customer", "total", "paid", "remaining", "status"]) {
    ctx.api.invoiceView.sortKey = null;
    ctx.api.invoiceView.sortDir = 1;
    for (let pass = 0; pass < 2; pass++) {
      ctx.api.setInvoiceSort(key);
      assert.deepEqual([...type(ctx, "")].sort(), all, `${key}: every invoice is still listed`);
    }
  }

  // Search + sort: the matches only, in the chosen order.
  ctx.api.invoiceView.sortKey = null;
  ctx.api.invoiceView.sortDir = 1;
  ctx.api.setInvoiceSort("total");
  ctx.api.setInvoiceSort("total");   // descending
  const found = type(ctx, "alpha");
  assert.ok(found.length >= 2, "both 'Alpha' and 'alpha two' match");
  const totals = found.map((n) => pay(n).due);
  assert.deepEqual(totals, [...totals].sort((a, b) => b - a), "the matches are in total order, highest first");
  const expected = invoices.filter((i) => /alpha/i.test(i.customer.name)).map((i) => i.invoiceNumber).sort();
  assert.deepEqual([...found].sort(), expected, "exactly the matching invoices");

  // Clearing the search keeps the sort; the full list is back.
  type(ctx, "");
  assert.equal(numbersShown(ctx).length, 12);
  assert.equal(ctx.api.invoiceView.sortKey, "total");
});

/* ==========================================================================
   D. Deleting an invoice
   ========================================================================== */

test("D: Delete asks first; Cancel leaves the invoice, the stock and the saved data exactly as they were", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx);
  await sellLines(ctx, [{ product: tile, qty: "3" }], { name: "Karim" });
  const target = await sellLines(ctx, [{ product: tile, qty: "2" }], { name: "Sara" });
  const before = await snapshot(ctx);
  quiet(ctx);

  ctx.app.answer(false);   // the browser's own box is the fallback when there is no <dialog>
  await ctx.api.deleteInvoice(target.id);

  assert.equal(ctx.app.confirms.length, 1, "it asked");
  assert.match(ctx.app.confirms[0], /Delete INV-000002\?/, "and named the invoice");
  assert.equal(ctx.api.getInvoices().length, 2);
  assert.deepEqual(await snapshot(ctx), before, "nothing was written");
  assert.equal(ctx.app.toast(), "", "and nothing was announced");
});

test("D: a deleted invoice is gone from the list at once, the count follows, and a short message names it", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx);
  await sellLines(ctx, [{ product: tile, qty: "1" }], { name: "Karim" });
  const middle = await sellLines(ctx, [{ product: tile, qty: "1" }], { name: "Sara" });
  await sellLines(ctx, [{ product: tile, qty: "1" }], { name: "Amine" });
  assert.deepEqual(draw(ctx), ["INV-000003", "INV-000002", "INV-000001"]);

  await ctx.api.deleteInvoice(middle.id);   // OK is the default answer of the stand-in

  assert.deepEqual(numbersShown(ctx), ["INV-000003", "INV-000001"], "the list was redrawn without a reload");
  assert.equal(ctx.app.field("invoiceCount").textContent, "2 of 2 invoices");
  assert.equal(ctx.app.toast(), "INV-000002 deleted.");
  assert.equal(ctx.api.getInvoices().some((i) => i.id === middle.id), false, "the live data lost it");
});

test("D: search and sorting still work, and still count right, after a deletion", async () => {
  const ctx = await boot();
  const { invoices } = await manyInvoices(ctx, 8);
  ctx.api.setInvoiceSort("total");
  type(ctx, "alpha");
  const victim = invoices.find((i) => /alpha/i.test(i.customer.name));

  await ctx.api.deleteInvoice(victim.id);

  assert.equal(numbersShown(ctx).includes(victim.invoiceNumber), false);
  assert.equal(ctx.app.field("invoiceFilter").value, "alpha", "the search text is kept");
  assert.equal(ctx.api.invoiceView.sortKey, "total", "and so is the sort");
  assert.match(ctx.app.field("invoiceCount").textContent, new RegExp(`of ${invoices.length - 1} invoices$`));
  assert.deepEqual(type(ctx, ""), numbersShown(ctx));
  assert.equal(numbersShown(ctx).length, invoices.length - 1);
});

test("D: the deletion is saved for good: it survives leaving the page and restarting the application", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx);
  await sellLines(ctx, [{ product: tile, qty: "1" }], { name: "Karim" });
  const gone = await sellLines(ctx, [{ product: tile, qty: "1" }], { name: "Sara" });
  await sellLines(ctx, [{ product: tile, qty: "1" }], { name: "Amine" });

  await ctx.api.deleteInvoice(gone.id);

  // What the database holds right now ...
  const saved = await ctx.api.db.loadAll();
  assert.deepEqual(plain(saved.invoices.map((i) => i.invoiceNumber).sort()), ["INV-000001", "INV-000003"]);

  // ... and in a second copy of the application started on the same database (a restart).
  const again = loadApp({ indexedDB: ctx.app.indexedDB });
  await again.start();
  assert.deepEqual(plain(again.api.getInvoices().map((i) => i.invoiceNumber).sort()), ["INV-000001", "INV-000003"]);
  again.api.renderInvoices();
  assert.equal(again.field("invoiceBody").innerHTML.includes("INV-000002"), false, "it does not come back");
});

test("D: the backup file (invoisy-data.json) no longer has the deleted invoice either", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx);
  await sellLines(ctx, [{ product: tile, qty: "1" }], { name: "Karim" });
  const gone = await sellLines(ctx, [{ product: tile, qty: "1" }], { name: "Sara" });
  await ctx.api.autoBackup.flushNow();
  assert.equal(V.parseBackup(ctx.handle.content).data.invoices.length, 2);

  await ctx.api.deleteInvoice(gone.id);
  await ctx.api.autoBackup.flushNow();

  const file = V.parseBackup(ctx.handle.content);
  assert.deepEqual(file.data.invoices.map((i) => i.invoiceNumber), ["INV-000001"]);
  assert.equal(file.data.products.length, 1, "the products are in the file as before");
});

test("D: numbering stays consistent: a deleted number is never given out again, also after a restart", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx);
  await sellLines(ctx, [{ product: tile, qty: "1" }]);
  await sellLines(ctx, [{ product: tile, qty: "1" }]);
  const last = await sellLines(ctx, [{ product: tile, qty: "1" }]);
  assert.equal(last.invoiceNumber, "INV-000003");
  const counterBefore = (await snapshot(ctx)).counter;

  await ctx.api.deleteInvoice(last.id);   // the newest one, the case where a number could be reused
  assert.equal((await snapshot(ctx)).counter, counterBefore, "the counter is not lowered");

  const next = await sellLines(ctx, [{ product: tile, qty: "1" }]);
  assert.equal(next.invoiceNumber, "INV-000004", "INV-000003 is not reused");

  // Delete the newest again, restart, and sell: still no reuse.
  await ctx.api.deleteInvoice(next.id);
  const again = loadApp({
    indexedDB: ctx.app.indexedDB,
    globals: { window: { print() {}, addEventListener() {} } },
  });
  await again.start();
  const product = again.api.getState().products[0];
  again.api.addToSale(product.id, "1", "box");
  await again.api.completeSale();
  const numbers = plain(again.api.getInvoices().map((i) => i.invoiceNumber));
  assert.deepEqual(numbers, ["INV-000001", "INV-000002", "INV-000005"], "no duplicate and no reuse");
  assert.equal(new Set(numbers).size, numbers.length);
});

test("D: deleting an invoice does not touch the products or their stock (the goods stay sold)", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 40 });
  const other = await addTile(ctx, { name: "Other tile", sku: "OT-1", stock: 7 });
  await sellLines(ctx, [{ product: tile, qty: "5" }, { product: other, qty: "2" }]);
  const gone = await sellLines(ctx, [{ product: tile, qty: "4" }]);
  const productsBefore = (await snapshot(ctx)).products;
  assert.equal(stockOf(ctx.api, tile.id), 31);

  await ctx.api.deleteInvoice(gone.id);

  assert.equal(stockOf(ctx.api, tile.id), 31, "stock is not given back");
  assert.equal(stockOf(ctx.api, other.id), 5);
  assert.deepEqual((await snapshot(ctx)).products, productsBefore, "the saved products are identical");
  assert.equal((await snapshot(ctx)).invoices.length, 1, "and the other invoice is untouched");
});

test("D: if the deletion can not be saved the invoice stays everywhere and the failure is shown", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx);
  const kept = await sellLines(ctx, [{ product: tile, qty: "1" }], { name: "Karim" });
  draw(ctx);

  ctx.api.db.close();   // the browser closed the connection: nothing can be saved
  await ctx.api.deleteInvoice(kept.id);

  assert.notEqual(ctx.app.toast(), "", "the failure is announced");
  assert.doesNotMatch(ctx.app.toast(), /deleted\./, "not as a success");
  assert.equal(ctx.api.getInvoices().length, 1, "the invoice is still in the data");
  assert.deepEqual(draw(ctx), ["INV-000001"], "and in the list");

  // After the connection is back, the same deletion works.
  await ctx.api.startStorage();
  await ctx.api.deleteInvoice(kept.id);
  assert.equal(ctx.api.getInvoices().length, 0);
  assert.equal((await ctx.api.db.loadAll()).invoices.length, 0);
});

test("D: with the page's own dialog: it names the invoice, Cancel has the focus, Delete deletes once", async () => {
  const ctx = await boot();
  const dialog = dialogStandIn(ctx);
  const tile = await addTile(ctx);
  await sellLines(ctx, [{ product: tile, qty: "1" }], { name: "Karim" });
  const target = await sellLines(ctx, [{ product: tile, qty: "2" }], { name: "Sara Haddad" });

  const asked = ctx.api.deleteInvoice(target.id);
  await flush();
  assert.equal(dialog.open, true);
  assert.equal(ctx.app.confirms.length, 0, "the browser's own box is not used");
  assert.equal(ctx.app.field("invoiceDeleteTitle").textContent, "Delete this invoice?");
  assert.equal(ctx.app.field("invoiceDeleteSubject").textContent, "INV-000002");
  assert.match(ctx.app.field("invoiceDeleteDetail").textContent, /Sara Haddad/);
  assert.match(ctx.app.field("invoiceDeleteDetail").textContent, /4,000 DA/);
  assert.equal(ctx.app.field("invoiceDeleteCancel").textContent, "Cancel");
  assert.equal(ctx.app.field("invoiceDeleteConfirm").hidden, false);
  assert.equal(dialog.focused, "cancel", "Enter must not delete by accident");
  assert.equal(ctx.api.getInvoices().length, 2, "nothing is deleted while it is open");

  // A second request while the question is open is ignored (it never opens a second dialog or deletes another invoice).
  await ctx.api.deleteInvoice(ctx.api.getInvoices()[0].id);
  assert.equal(dialog.opens, 1);

  ctx.api.answerInvoiceDelete(true);
  ctx.api.answerInvoiceDelete(true);   // a double click
  await asked;
  assert.equal(dialog.open, false);
  assert.equal(dialog.closes, 1, "it closed once");
  assert.deepEqual(ctx.api.getInvoices().map((i) => i.invoiceNumber), ["INV-000001"], "exactly the asked-about invoice went");
  assert.equal(ctx.app.toast(), "INV-000002 deleted.");
});

test("D: Cancel (or Esc) in the page's own dialog changes nothing", async () => {
  const ctx = await boot();
  const dialog = dialogStandIn(ctx);
  const tile = await addTile(ctx);
  const inv = await sellLines(ctx, [{ product: tile, qty: "1" }]);
  const before = await snapshot(ctx);
  quiet(ctx);

  const asked = ctx.api.deleteInvoice(inv.id);
  await flush();
  ctx.api.answerInvoiceDelete(false);
  await asked;

  assert.equal(dialog.open, false);
  assert.equal(ctx.api.getInvoices().length, 1);
  assert.deepEqual(await snapshot(ctx), before);
  assert.equal(ctx.app.toast(), "");

  // The dialog can be opened again afterwards.
  const again = ctx.api.deleteInvoice(inv.id);
  await flush();
  assert.equal(dialog.opens, 2);
  ctx.api.answerInvoiceDelete(false);
  await again;
});

test("D: an invoice that is kept on purpose explains why in the dialog (only Close is offered) and is not deleted", async () => {
  const ctx = await boot();
  const dialog = dialogStandIn(ctx);
  const tile = await addTile(ctx);
  const inv = await sellLines(ctx, [{ product: tile, qty: "5" }], { name: "Karim", paid: "6000" });
  openEdit(ctx, inv);
  while (ctx.api.getSale().items.length) removeLine(ctx.api, 0);
  await ctx.api.saveInvoiceEdit();   // removing every product cancels the sale (the stand-in confirms)
  assert.equal(ctx.api.getInvoices()[0].cancellation !== undefined, true, "the sale is cancelled");
  const before = await snapshot(ctx);

  const asked = ctx.api.deleteInvoice(inv.id);
  await flush();
  assert.equal(dialog.open, true);
  assert.equal(ctx.app.field("invoiceDeleteTitle").textContent, "This invoice can not be deleted");
  assert.equal(ctx.app.field("invoiceDeleteSubject").textContent, "INV-000001");
  assert.match(ctx.app.field("invoiceDeleteBody").textContent, /cancelled/);
  assert.equal(ctx.app.field("invoiceDeleteConfirm").hidden, true, "there is no Delete button to press");
  assert.equal(ctx.app.field("invoiceDeleteCancel").textContent, "Close");

  ctx.api.answerInvoiceDelete(false);
  await asked;
  assert.deepEqual(await snapshot(ctx), before, "kept");
});

test("D: without <dialog> support a refusal is still explained (message) and the invoice stays", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx);
  const inv = await sellLines(ctx, [{ product: tile, qty: "5" }], { paid: "6000" });
  openEdit(ctx, inv);
  while (ctx.api.getSale().items.length) removeLine(ctx.api, 0);
  await ctx.api.saveInvoiceEdit();

  await ctx.api.deleteInvoice(inv.id);
  assert.match(ctx.app.toast(), /INV-000001 was cancelled\. It is kept as a record and can not be deleted\./);
  assert.equal(ctx.api.getInvoices().length, 1);
});

test("D: an invoice that carries debt forward says so before it is deleted, and gives the debt back", async () => {
  const ctx = await boot();
  const dialog = dialogStandIn(ctx);
  const tile = await addTile(ctx);
  const old = await sellLines(ctx, [{ product: tile, qty: "2" }], { name: "Karim Benali", phone: "0555 11 22 33", paid: "1000" });
  const owed = ctx.api.paymentInfo(old).remaining;
  assert.ok(owed > 0);

  // A new sale for the same customer carries the old balance.
  ctx.api.addToSale(tile.id, "1", "box");
  ctx.api.getSale().customer.name = "Karim Benali";
  ctx.api.getSale().customer.phone = "0555 11 22 33";
  ctx.api.onCustomerSettled();
  const added = ctx.api.addDebtToSale([{ sourceInvoiceId: old.id, amount: owed }]);
  assert.equal(added.error, undefined, added.error);
  await ctx.api.completeSale();
  const carrier = ctx.api.getInvoices()[1];
  assert.equal(carrier.invoiceNumber, "INV-000002");
  assert.equal(ctx.api.paymentInfo(ctx.api.getInvoices()[0]).remaining, 0, "the old invoice's balance now lives on the new one");

  const asked = ctx.api.deleteInvoice(carrier.id);
  await flush();
  assert.equal(ctx.app.field("invoiceDeleteTitle").textContent, "Delete this invoice?");
  assert.match(ctx.app.field("invoiceDeleteBody").textContent, /carries debt forward from INV-000001/);
  ctx.api.answerInvoiceDelete(true);
  await asked;

  assert.deepEqual(ctx.api.getInvoices().map((i) => i.invoiceNumber), ["INV-000001"]);
  assert.equal(ctx.api.paymentInfo(ctx.api.getInvoices()[0]).remaining, owed, "the balance is collectible on the old invoice again");
  assert.equal(dialog.open, false);
});

test("D: the page's markup has what the code needs (dialog, search clear, sortable headings, stylesheet)", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  for (const id of ["invoiceDeleteDialog", "invoiceDeleteTitle", "invoiceDeleteSubject", "invoiceDeleteDetail", "invoiceDeleteBody", "invoiceDeleteCancel", "invoiceDeleteConfirm", "invoiceSearchClear", "invoiceFilter", "invoiceFilters", "invoicePayFilter", "invoiceDeliveryFilter", "invoiceClear", "invoiceCount", "invoiceTable", "invoiceBody", "invoiceEmpty"]) {
    assert.equal((html.match(new RegExp(`id="${id}"`, "g")) || []).length, 1, `${id} exists once`);
  }
  for (const key of ["number", "date", "customer", "total", "paid", "remaining", "status"]) {
    assert.match(html, new RegExp(`data-sort="${key}"`), `${key} is a sortable column`);
  }
  assert.match(html, /<link rel="stylesheet" href="css\/invoices\.css">/);
  assert.ok(fs.existsSync(path.join(__dirname, "..", "css", "invoices.css")));
  // The page asks with its own dialog: no browser alert is left in the invoice deletion.
  const script = fs.readFileSync(path.join(__dirname, "..", "java script", "script.js"), "utf8");
  const deleteFn = script.slice(script.indexOf("async function deleteInvoice"), script.indexOf("// Adds a cash payment"));
  assert.doesNotMatch(deleteFn, /\balert\(/);
  assert.match(deleteFn, /askAboutInvoice\(/);
});

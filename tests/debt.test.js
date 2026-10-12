"use strict";

// Outstanding customer debt: recognizing a returning customer on the Sell page, carrying an unpaid balance onto a
// new invoice, and keeping the books right (every debt collectible once). Runs the real page scripts against a
// disposable in-memory IndexedDB.

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { sampleProduct, failPutWith, fake } = require("./helpers/modules");
const { loadApp } = require("./helpers/app");

const plain = (x) => JSON.parse(JSON.stringify(x));
const css = fs.readFileSync(path.join(__dirname, "..", "css", "style.css"), "utf8");

async function startedApp(options) {
  const app = loadApp(options);
  const storage = await app.start();
  assert.equal(storage.mode, "ready", storage.reason);
  return app;
}

// A product at 1,000 DA per piece with plenty of stock.
async function shop(stock = 100) {
  const app = await startedApp();
  const { id, ...values } = sampleProduct({ name: "Marble slab", sellingPrice: 1000, priceUnit: "piece", stockUnit: "piece", tileSize: "", coveragePerBox: null, purchasePrice: null, sku: "MS-1", stock });
  await app.api.addProduct(values);
  return { app, productId: app.api.getState().products[0].id };
}

const setCustomer = (app, name, phone = "") => {
  const c = app.api.getSale().customer;
  c.name = name; c.phone = phone;
};
const lastInvoice = (app) => { const l = app.api.getState().invoices; return l[l.length - 1]; };
const byNumber = (app, n) => app.api.getState().invoices.find((i) => i.invoiceNumber === n);
const pay = (app, invoice) => app.api.Validation.paymentDetail(invoice, app.api.getState().debtTransfers);

// Sells `qty` pieces (1,000 DA each) to a customer. `paid` is what is typed in Amount Paid. `debts` are
// [{ sourceInvoiceId, amount }] to carry onto the sale first.
async function sell(app, productId, { name = "", phone = "", qty = "1", paid, debts = [], discount } = {}) {
  const added = app.api.addToSale(productId, qty, "piece");
  assert.equal(added.ok, true, added.error);
  setCustomer(app, name, phone);
  if (paid !== undefined) app.api.getSale().paidValue = paid;
  if (discount) Object.assign(app.api.getSale(), { discountType: "percent", discountValue: discount });
  if (debts.length) {
    app.api.onCustomerSettled();
    const r = app.api.addDebtToSale(debts);
    assert.equal(r.error, undefined, r.error);
  }
  await app.api.completeSale();
  return lastInvoice(app);
}

// A shop where Karim owes 3,000 (INV-000001, nothing paid) and Salima 1,000 of 2,000 (INV-000002).
async function twoDebtors() {
  const ctx = await shop();
  const { app, productId } = ctx;
  await sell(app, productId, { name: "Karim Benali", phone: "0555 11 22 33", qty: "3" });
  await sell(app, productId, { name: "Salima Haddad", phone: "0770 00 11 22", qty: "2", paid: "1000" });
  return ctx;
}

const view = (app, name, phone) => {
  setCustomer(app, name, phone);
  app.api.onCustomerSettled();
  return app.api.debtView();
};

/* ---------- Debt detection ---------- */

test("1. a customer with no unpaid invoices gets no notification", async () => {
  const { app, productId } = await shop();
  await sell(app, productId, { name: "Nadia", phone: "0661 00 00 01", paid: "1000" });          // paid in full
  assert.equal(view(app, "Nadia", "0661 00 00 01"), null);
  assert.equal(view(app, "Brand New Customer", "0661 99 99 99"), null);
  assert.equal(app.field("debtNotice").hidden, true);
});

test("2. a customer with one unpaid invoice: number, date, original total, paid, outstanding and total debt", async () => {
  const { app } = await twoDebtors();
  const v = view(app, "Karim Benali", "0555 11 22 33");
  assert.equal(v.kind, "confirmed");
  assert.equal(v.owed.count, 1);
  assert.equal(v.owed.total, 3000);
  const row = v.owed.rows[0];
  assert.deepEqual({ n: row.invoice.invoiceNumber, due: row.due, paid: row.paid, left: row.available }, { n: "INV-000001", due: 3000, paid: 0, left: 3000 });
  assert.equal(app.field("debtNotice").hidden, false);
  const html = app.field("debtNotice").innerHTML;
  assert.match(html, /Karim Benali/);
  assert.match(html, /INV-000001/);
  assert.match(html, /Original total/);
  assert.match(html, /Already paid/);
  assert.match(html, /Outstanding balance/);
  assert.match(html, /Total outstanding customer debt/);
  assert.match(html, /3,000 DA/);
  for (const label of ["View Invoice", "Add Outstanding Debt", "Remind Me Later"]) assert.ok(html.includes(label), label);
});

test("3. several unpaid invoices are listed and summed once each", async () => {
  const { app, productId } = await twoDebtors();
  await sell(app, productId, { name: "Karim Benali", phone: "0555 11 22 33", qty: "1", paid: "250" });   // INV-000003: 750 left
  const v = view(app, "Karim Benali", "0555 11 22 33");
  assert.equal(v.owed.count, 2);
  assert.deepEqual(plain(v.owed.rows.map((r) => [r.invoice.invoiceNumber, r.available])), [["INV-000001", 3000], ["INV-000003", 750]]);
  assert.equal(v.owed.total, 3750);
  assert.match(app.field("debtNotice").innerHTML, /2 unpaid invoices/);
});

test("4. partially paid invoices show what was paid and what is left; fully paid ones are not listed", async () => {
  const { app, productId } = await twoDebtors();
  const v = view(app, "Salima Haddad", "0770 00 11 22");
  assert.deepEqual([v.owed.rows[0].due, v.owed.rows[0].paid, v.owed.rows[0].available], [2000, 1000, 1000]);
  const inv = byNumber(app, "INV-000002");
  assert.equal((await app.api.addPayment(inv.id, "1000")).error, undefined);
  assert.equal(app.api.debtView(), null, "paid in full: nothing to warn about any more");
  await sell(app, productId, { name: "Salima Haddad", phone: "0770 00 11 22", paid: "1000" });
});

test("5. the customer is identified carefully: walk-in, same name, similar names and phone numbers", async () => {
  const { app, productId } = await twoDebtors();
  // the walk-in name never looks anything up, even if walk-in invoices are unpaid
  await sell(app, productId, { name: "", qty: "1" });
  assert.equal(view(app, "", ""), null);
  assert.equal(view(app, "Walk-in Customer", ""), null);
  // exact name + phone (spacing/case/accents do not matter) confirms the customer
  assert.equal(view(app, "  karim   BENALI ", "+213 555 11 22 33").kind, "confirmed");
  // the same name but another phone number is another person until the user says otherwise
  const same = view(app, "Karim Benali", "0666 00 00 00");
  assert.equal(same.kind, "choose");
  assert.equal(same.candidates[0].group.name, "Karim Benali");
  // a similar name asks the user to choose
  assert.equal(view(app, "Karim", "").kind, "choose");
  // the same phone under another name also asks
  assert.equal(view(app, "K. Benali", "0555112233").kind, "choose");
  // a different name and phone: nothing
  assert.equal(view(app, "Sofiane Meziane", "0550 55 55 55"), null);
  // while typing nothing is shown
  app.api.getSale().customer.name = "Karim Benali";
  app.api.getSale().customer.phone = "0555 11 22 33";
  app.api.onCustomerTyped("name");
  assert.equal(app.api.debtView(), null);
  assert.equal(app.field("debtNotice").hidden, true);
});

test("5b. choosing among similar customers confirms exactly that customer", async () => {
  const { app } = await twoDebtors();
  setCustomer(app, "Karim", "");
  app.api.onCustomerSettled();
  const v = app.api.debtView();
  assert.equal(v.kind, "choose");
  app.api.pickCustomer(v.candidates[0].group.keys[0]);
  const after = app.api.debtView();
  assert.equal(after.kind, "confirmed");
  assert.equal(app.api.getSale().customer.name, "Karim Benali");
  assert.equal(app.api.getSale().customer.phone, "0555 11 22 33");
  // editing the name afterwards drops the confirmation
  app.api.getSale().customer.name = "Karim Benal";
  app.api.onCustomerTyped("name");
  assert.equal(app.api.debtView(), null);
});

test("5c. the suggestion list offers matching customers while typing", async () => {
  const { app } = await twoDebtors();
  app.api.getSale().customer.name = "sal";
  app.api.onCustomerTyped("name");
  const ui = app.api.getDebtUi();
  assert.deepEqual(plain(ui.suggestions.map((g) => g.name)), ["Salima Haddad"]);
  assert.match(app.field("custSuggest").innerHTML, /Salima Haddad/);
  assert.match(app.field("custSuggest").innerHTML, /owes 1,000 DA/);
});

test("6. viewing the old invoice from the notice keeps the sale being prepared", async () => {
  const { app, productId } = await twoDebtors();
  app.api.addToSale(productId, "2", "piece");
  view(app, "Karim Benali", "0555 11 22 33");
  app.api.addDebtToSale([{ sourceInvoiceId: byNumber(app, "INV-000001").id, amount: 1000 }]);
  const before = plain(app.api.getSale());
  app.api.viewInvoice(byNumber(app, "INV-000001").id);
  assert.equal(app.api.getState().previewInvoice.invoiceNumber, "INV-000001");
  assert.deepEqual(plain(app.api.getSale()), before, "the sale is untouched");
  app.api.getState().previewInvoice = null;                                   // "Back to current sale"
  app.api.renderInvoice();
  assert.deepEqual(plain(app.api.getSale()), before);
  assert.match(app.field("invoicePaper").innerHTML || app.api.invoiceHtml(app.api.draftInvoice()), /INV-000001/);
});

test("7. Remind Me Later hides the card for this sale only; the next sale shows it again", async () => {
  const { app } = await twoDebtors();
  view(app, "Karim Benali", "0555 11 22 33");
  app.api.dismissDebtNotice();
  assert.equal(app.field("debtNotice").hidden, true);
  assert.equal(app.field("debtReminder").hidden, false);
  assert.match(app.field("debtReminderText").textContent, /3,000 DA/);
  app.api.onCustomerSettled();                                                // still the same sale: stays dismissed
  assert.equal(app.field("debtNotice").hidden, true);
  app.api.showDebtNoticeAgain();
  assert.equal(app.field("debtNotice").hidden, false);
  app.api.dismissDebtNotice();
  app.api.clearSale();                                                        // next sale
  assert.equal(app.field("debtReminder").hidden, true);
  view(app, "Karim Benali", "0555 11 22 33");
  assert.equal(app.field("debtNotice").hidden, false);
});

/* ---------- Carrying debt forward ---------- */

test("8. a full transfer: carried line, no stock, no price, discount and tax do not touch it, old invoice untouched", async () => {
  const { app, productId } = await twoDebtors();
  const source = byNumber(app, "INV-000001");
  const sourceBefore = plain(source);
  const stockBefore = app.api.getState().products[0].stock;
  const invoice = await sell(app, productId, { name: "Karim Benali", phone: "0555 11 22 33", qty: "2", discount: "10", debts: [{ sourceInvoiceId: source.id, amount: 3000 }] });

  assert.equal(invoice.invoiceNumber, "INV-000003");
  assert.equal(invoice.subtotal, 2000);
  assert.equal(invoice.discount, 200, "the discount applies to the products only");
  assert.equal(invoice.total, 1800, "total = this purchase");
  assert.deepEqual(plain(invoice.carriedForward.map((l) => [l.sourceInvoiceNumber, l.amount])), [["INV-000001", 3000]]);
  assert.equal(invoice.items.length, 1, "the carried debt is not a product line");
  assert.equal(app.api.getState().products[0].stock, stockBefore - 2, "only the real product leaves stock");
  const info = pay(app, invoice);
  assert.deepEqual([info.due, info.remaining, info.cls], [4800, 4800, "unpaid"]);

  assert.deepEqual(plain(byNumber(app, "INV-000001")), sourceBefore, "the old invoice is not edited");
  const old = pay(app, byNumber(app, "INV-000001"));
  assert.deepEqual([old.remaining, old.transferredOut, old.cls], [0, 3000, "transferred"]);
  assert.equal(app.api.getState().debtTransfers.length, 1);
  assert.equal(app.api.getState().counter, 3);
});

test("9. a partial transfer leaves the rest collectible on the old invoice, and can be completed later", async () => {
  const { app, productId } = await twoDebtors();
  const source = byNumber(app, "INV-000001");
  await sell(app, productId, { name: "Karim Benali", phone: "0555 11 22 33", debts: [{ sourceInvoiceId: source.id, amount: 1200 }] });
  assert.deepEqual([pay(app, source).remaining, pay(app, source).transferredOut], [1800, 1200]);
  const v = view(app, "Karim Benali", "0555 11 22 33");
  assert.deepEqual(plain(v.owed.rows.map((r) => [r.invoice.invoiceNumber, r.available])), [["INV-000001", 1800], ["INV-000003", 2200]]);
  await sell(app, productId, { name: "Karim Benali", phone: "0555 11 22 33", qty: "1", paid: "1000", debts: [{ sourceInvoiceId: source.id, amount: 1800 }] });
  assert.deepEqual([pay(app, source).remaining, pay(app, source).cls], [0, "transferred"]);
  assert.equal(app.api.getState().debtTransfers.length, 2);
});

test("10. the same balance cannot be added twice, nor transferred beyond what is left", async () => {
  const { app, productId } = await twoDebtors();
  const source = byNumber(app, "INV-000001");
  app.api.addToSale(productId, "1", "piece");
  view(app, "Karim Benali", "0555 11 22 33");
  assert.equal(app.api.addDebtToSale([{ sourceInvoiceId: source.id, amount: 1000 }]).ok, true);
  assert.match(app.api.addDebtToSale([{ sourceInvoiceId: source.id, amount: 500 }]).error, /already on this sale/);
  assert.match(app.api.Debt.addToDraft([], [{ sourceInvoiceId: source.id, amount: 3000.01 }], app.api.debtContext()).error, /only 3,000 DA can still be carried/);
  assert.match(app.api.Debt.addToDraft([], [{ sourceInvoiceId: source.id, amount: 0 }], app.api.debtContext()).error, /greater than 0/);
  assert.match(app.api.Debt.addToDraft([], [{ sourceInvoiceId: source.id, amount: -5 }], app.api.debtContext()).error, /greater than 0/);
  await app.api.completeSale();
  // after saving, the whole original balance can not be moved again
  app.api.addToSale(productId, "1", "piece");
  view(app, "Karim Benali", "0555 11 22 33");
  const again = app.api.Debt.addToDraft([], [{ sourceInvoiceId: source.id, amount: 2500 }], app.api.debtContext());
  assert.match(again.error, /only 2,000 DA can still be carried/);
  // a forged duplicate in the database is refused too
  const t = app.api.getState().debtTransfers[0];
  await assert.rejects(app.api.db.commitChanges({ debtTransfers: { put: [{ ...t, id: "dup-1", amount: 2500 }], remove: [] } }), /.+/);
});

test("11. nothing is counted twice: the money collectible across all invoices is what was really sold and not paid", async () => {
  const { app, productId } = await twoDebtors();
  const k = byNumber(app, "INV-000001");
  const s = byNumber(app, "INV-000002");
  await sell(app, productId, { name: "Karim Benali", phone: "0555 11 22 33", qty: "2", paid: "500", debts: [{ sourceInvoiceId: k.id, amount: 3000 }] });
  await sell(app, productId, { name: "Salima Haddad", phone: "0770 00 11 22", qty: "1", debts: [{ sourceInvoiceId: s.id, amount: 400 }] });
  const sold = 3000 + 2000 + 2000 + 1000;
  const paid = 0 + 1000 + 500 + 0;
  const collectible = app.api.getState().invoices.reduce((sum, i) => sum + pay(app, i).remaining, 0);
  assert.equal(collectible, sold - paid, "collectible debt = sales - payments, whatever was moved around");
  // customer totals per customer
  const dir = app.api.Debt.directory(app.api.getState().invoices, app.api.getState().debtTransfers);
  const owes = Object.fromEntries(dir.map((g) => [g.name, g.debt]));
  assert.deepEqual(plain(owes), { "Karim Benali": 4500, "Salima Haddad": 2000 });
});

test("12. a payment after a transfer is accepted only on the invoice that now carries the debt, oldest debt first", async () => {
  const { app, productId } = await twoDebtors();
  const k = byNumber(app, "INV-000001");
  const carrier = await sell(app, productId, { name: "Karim Benali", phone: "0555 11 22 33", qty: "1", debts: [{ sourceInvoiceId: k.id, amount: 3000 }] });
  const refused = await app.api.addPayment(k.id, "100");
  assert.match(refused.error, /INV-000003/);
  assert.equal(byNumber(app, "INV-000001").payments.length, 0);
  assert.equal((await app.api.addPayment(carrier.id, "3500")).error, undefined);
  const settled = pay(app, byNumber(app, "INV-000003"));
  assert.deepEqual([settled.paid, settled.remaining], [3500, 500]);
  const split = app.api.Validation.carriedBreakdown(byNumber(app, "INV-000003"));
  assert.deepEqual(plain(split.lines.map((l) => [l.sourceInvoiceNumber, l.settled, l.remaining])), [["INV-000001", 3000, 0]]);
  assert.deepEqual([split.currentPaid, split.currentRemaining], [500, 500]);
  assert.equal((await app.api.addPayment(carrier.id, "500")).error, undefined);
  assert.equal(pay(app, byNumber(app, "INV-000003")).cls, "paid");
  assert.match((await app.api.addPayment(carrier.id, "1")).error, /already fully paid/);
});

test("13. paying the old invoice before confirming lowers the draft amount to what is still owed", async () => {
  const { app, productId } = await twoDebtors();
  const k = byNumber(app, "INV-000001");
  app.api.addToSale(productId, "1", "piece");
  view(app, "Karim Benali", "0555 11 22 33");
  app.api.addDebtToSale([{ sourceInvoiceId: k.id, amount: 3000 }]);
  assert.equal((await app.api.addPayment(k.id, "2500")).error, undefined);
  assert.deepEqual(plain(app.api.getSale().debts), [{ sourceInvoiceId: k.id, amount: 500 }]);
  assert.match(app.toast(), /now 500 DA/);
  assert.equal(app.api.saleDue(app.api.getSale()), 1500);
  assert.equal((await app.api.addPayment(k.id, "500")).error, undefined);
  assert.deepEqual(plain(app.api.getSale().debts), []);
  assert.equal(app.api.saleDue(app.api.getSale()), 1000);
});

test("14. a draft allocation can be removed before saving; nothing is written", async () => {
  const { app, productId } = await twoDebtors();
  const k = byNumber(app, "INV-000001");
  app.api.addToSale(productId, "1", "piece");
  view(app, "Karim Benali", "0555 11 22 33");
  app.api.addDebtToSale([{ sourceInvoiceId: k.id, amount: 3000 }]);
  assert.equal(app.api.saleDue(app.api.getSale()), 4000);
  assert.match(app.field("saleDebts").innerHTML, /INV-000001/);
  assert.equal(app.field("tCarriedRow").hidden, false);
  assert.equal((await app.api.db.loadAll()).debtTransfers.length, 0, "a draft is not saved");
  app.api.removeDebtFromSale(k.id);
  assert.equal(app.api.saleDue(app.api.getSale()), 1000);
  assert.equal(app.field("saleDebts").hidden, true);
  assert.equal(app.field("tCarriedRow").hidden, true);
  await app.api.completeSale();
  assert.equal(lastInvoice(app).carriedForward, undefined);
  assert.equal(pay(app, k).remaining, 3000);
});

test("15. a failure while saving rolls everything back: no invoice, no ledger record, stock and counter unchanged", async () => {
  for (const failAt of [1, 2, 3, 4, 5]) {
    const { app, productId } = await twoDebtors();
    const k = byNumber(app, "INV-000001");
    app.api.addToSale(productId, "1", "piece");
    view(app, "Karim Benali", "0555 11 22 33");
    app.api.addDebtToSale([{ sourceInvoiceId: k.id, amount: 3000 }]);
    const before = plain(await app.api.db.loadAll());
    const stateBefore = plain({ invoices: app.api.getState().invoices, transfers: app.api.getState().debtTransfers, counter: app.api.getState().counter });
    const undo = failPutWith("QuotaExceededError", failAt);
    try { await app.api.completeSale(); } finally { undo(); }
    assert.deepEqual(plain(await app.api.db.loadAll()), before, `write #${failAt} failed: the database is as before`);
    assert.deepEqual(plain({ invoices: app.api.getState().invoices, transfers: app.api.getState().debtTransfers, counter: app.api.getState().counter }), stateBefore);
    assert.equal(app.api.getSale().debts.length, 1, "the sale on screen is kept so it can be retried");
    await app.api.completeSale();                                             // and the retry works
    assert.equal(app.api.getState().debtTransfers.length, 1);
  }
});

test("16. the live preview and the printed invoice show the carried line separately; the CSS styles it for print", async () => {
  const { app, productId } = await twoDebtors();
  const k = byNumber(app, "INV-000001");
  app.api.addToSale(productId, "1", "piece");
  view(app, "Karim Benali", "0555 11 22 33");
  app.api.addDebtToSale([{ sourceInvoiceId: k.id, amount: 3000 }]);
  const live = app.api.invoiceHtml(app.api.draftInvoice());
  assert.match(live, /inv-carried/);
  assert.match(live, /Balance carried forward/i);
  assert.match(live, /INV-000001/);
  assert.match(live, /TOTAL DUE/);
  assert.match(live, /4,000 DA/);
  await app.api.completeSale();
  const saved = app.api.invoiceHtml(lastInvoice(app));
  assert.match(saved, /inv-carried/);
  assert.match(saved, /INV-000001/);
  assert.match(saved, /4,000 DA/);
  const original = app.api.invoiceHtml(byNumber(app, "INV-000001"));
  assert.match(original, /Carried forward to INV-000003/);
  assert.match(css, /\.inv-carried/);
  assert.match(css, /@media print[^]*\.inv-carried/);
  assert.match(css, /@media \(max-width: 720px\)[^]*\.debt-/);
});

test("17. stock is never changed by a carried line, only by products", async () => {
  const { app, productId } = await twoDebtors();
  const before = app.api.getState().products[0].stock;
  const k = byNumber(app, "INV-000001");
  await sell(app, productId, { name: "Karim Benali", phone: "0555 11 22 33", qty: "1", debts: [{ sourceInvoiceId: k.id, amount: 3000 }] });
  assert.equal(app.api.getState().products[0].stock, before - 1);
});

test("18. backup and restore keep the ledger and every relationship", async () => {
  const { app, productId } = await twoDebtors();
  const k = byNumber(app, "INV-000001");
  await sell(app, productId, { name: "Karim Benali", phone: "0555 11 22 33", qty: "1", paid: "200", debts: [{ sourceInvoiceId: k.id, amount: 1500 }] });
  await app.api.exportBackup();
  const text = await app.downloadedText();
  const backup = JSON.parse(text);
  assert.equal(backup.data.debtTransfers.length, 1);
  const exported = backup.data.invoices.find((i) => i.invoiceNumber === "INV-000001");
  assert.deepEqual([exported.remaining, exported.transferredOut], [1500, 1500], "the file shows the old invoice with its collectible balance and what moved");

  const target = await startedApp();
  await target.api.importBackup(target.file(text));
  const s = target.api.getState();
  assert.deepEqual(plain(s.debtTransfers), plain(app.api.getState().debtTransfers));
  assert.deepEqual(plain(s.invoices), plain(app.api.getState().invoices));
  assert.equal(pay(target, byNumber(target, "INV-000001")).remaining, 1500);
  const reopened = await startedApp({ indexedDB: target.indexedDB });
  assert.equal(reopened.api.getState().debtTransfers.length, 1);

  // a backup whose ledger disagrees with its invoices is refused, and nothing is changed
  const forged = JSON.parse(text);
  forged.data.debtTransfers[0].amount = 99999;
  const empty = await startedApp();
  await empty.api.importBackup(empty.file(JSON.stringify(forged)));
  assert.equal(empty.api.getState().invoices.length, 0);
  // a backup without any transfer (the format of every earlier version) still restores
  const old = JSON.parse((await (async () => { const a = await shop(); await sell(a.app, a.productId, { name: "Z", paid: "1" }); await a.app.api.exportBackup(); return a.app.downloadedText(); })()));
  assert.equal(old.data.debtTransfers, undefined);
});

test("19. historical totals and payments of invoices never change when debt moves", async () => {
  const { app, productId } = await twoDebtors();
  const snapshot = plain(app.api.getState().invoices);
  const k = byNumber(app, "INV-000001");
  await sell(app, productId, { name: "Karim Benali", phone: "0555 11 22 33", qty: "1", paid: "1000", debts: [{ sourceInvoiceId: k.id, amount: 3000 }] });
  assert.deepEqual(plain(app.api.getState().invoices.slice(0, 2)), snapshot);
  const t = app.api.getState().debtTransfers[0];
  assert.deepEqual([t.sourceTotal, t.sourcePaid, t.availableBefore, t.availableAfter, t.amount], [3000, 0, 3000, 0, 3000], "the ledger keeps an audit snapshot");
  assert.ok(t.createdAt && t.id && t.sourceInvoiceNumber === "INV-000001" && t.targetInvoiceNumber === "INV-000003");
});

test("20. deleting the invoice that carries a debt gives the balance back to the old invoice; the old invoice cannot be deleted", async () => {
  const { app, productId } = await twoDebtors();
  const k = byNumber(app, "INV-000001");
  const carrier = await sell(app, productId, { name: "Karim Benali", phone: "0555 11 22 33", qty: "1", debts: [{ sourceInvoiceId: k.id, amount: 3000 }] });
  await app.api.deleteInvoice(k.id);
  assert.ok(byNumber(app, "INV-000001"), "refused: its balance lives on INV-000003");
  assert.match(app.toast(), /INV-000003/);
  await app.api.deleteInvoice(carrier.id);
  assert.equal(app.api.getState().debtTransfers.length, 0);
  assert.equal(pay(app, byNumber(app, "INV-000001")).remaining, 3000);
  assert.equal((await app.api.db.loadAll()).debtTransfers.length, 0);
});

test("changing the customer on the sale drops the carried debt", async () => {
  const { app, productId } = await twoDebtors();
  const k = byNumber(app, "INV-000001");
  app.api.addToSale(productId, "1", "piece");
  view(app, "Karim Benali", "0555 11 22 33");
  app.api.addDebtToSale([{ sourceInvoiceId: k.id, amount: 3000 }]);
  app.api.getSale().customer.name = "Someone Else";
  app.api.onCustomerTyped("name");
  assert.deepEqual(plain(app.api.getSale().debts), []);
  assert.match(app.toast(), /customer changed/i);
});

test("a debt can not be carried onto the invoice of a different customer", async () => {
  const { app, productId } = await twoDebtors();
  const k = byNumber(app, "INV-000001");
  app.api.addToSale(productId, "1", "piece");
  view(app, "Salima Haddad", "0770 00 11 22");
  assert.match(app.api.addDebtToSale([{ sourceInvoiceId: k.id, amount: 100 }]).error, /different customer/);
});

test("the paid amount on a sale with carried debt may reach the total due but not exceed it", async () => {
  const { app, productId } = await twoDebtors();
  const k = byNumber(app, "INV-000001");
  app.api.addToSale(productId, "1", "piece");
  view(app, "Karim Benali", "0555 11 22 33");
  app.api.addDebtToSale([{ sourceInvoiceId: k.id, amount: 3000 }]);
  app.api.getSale().paidValue = "4000";
  assert.equal(app.api.validateSale().length, 0);
  app.api.getSale().paidValue = "4000.01";
  assert.notEqual(app.api.validateSale().length, 0);
  app.api.getSale().paidValue = "4000";
  await app.api.completeSale();
  assert.equal(pay(app, lastInvoice(app)).cls, "paid");
});

test("customers are recognized again after a reload, and the id is minted only for returning customers", async () => {
  const { app, productId } = await twoDebtors();
  assert.equal(byNumber(app, "INV-000001").customer.id, undefined, "a first invoice has no customer id");
  const k = byNumber(app, "INV-000001");
  const second = await sell(app, productId, { name: "Karim Benali", phone: "0555 11 22 33", debts: [{ sourceInvoiceId: k.id, amount: 100 }] });
  assert.match(second.customer.id, /^cust-/);
  const reloaded = await startedApp({ indexedDB: app.indexedDB });
  setCustomer(reloaded, "Karim Benali", "0555 11 22 33");
  reloaded.api.onCustomerSettled();
  assert.equal(reloaded.api.debtView().kind, "confirmed");
});

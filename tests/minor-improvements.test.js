"use strict";

// The six small improvements: several business phone numbers, several supplier contacts, the "sale completed" dialog,
// editing a saved invoice, similar-product suggestions in Stock, and search / filter / sort in the invoice history.
// Everything runs through the application's own functions (script.js) against a disposable in-memory IndexedDB, so
// every write goes through the same database layer (revision check, one transaction, automatic backup file).

const test = require("node:test");
const assert = require("node:assert/strict");
const { V, sampleProduct, sampleInvoice, iso } = require("./helpers/modules");
const { loadApp } = require("./helpers/app");
const { FakeHandle } = require("./helpers/fake-handle");

const P = globalThis.Purchases;
const plain = (x) => JSON.parse(JSON.stringify(x));
// Arrays made inside the app's sandbox are not the test's own arrays: compare plain copies.
const same = (actual, expected, message) => assert.deepEqual(plain(actual), plain(expected), message);

/* ---------- Helpers ---------- */

// A started app with an automatic-backup file connected. `printed` counts window.print() calls; `print.fail` makes it throw.
async function boot(options) {
  const handle = new FakeHandle();
  const print = { calls: 0, fail: false };
  const app = loadApp({
    globals: {
      showSaveFilePicker: async () => handle,
      window: { print() { print.calls++; if (print.fail) throw new Error("The printer is not available."); }, addEventListener() {} },
    },
    ...options,
  });
  const storage = await app.start();
  assert.equal(storage.mode, "ready", storage.reason);
  await app.api.connectBackupFile();
  return { app, api: app.api, handle, print };
}

const tileValues = (overrides) => {
  const { id, ...values } = sampleProduct({ name: "Everton Grey", tileSize: "60*60", coveragePerBox: 1.44, sku: "EV-60", sellingPrice: 800, priceUnit: "m2", purchasePrice: 600, stock: 10, ...overrides });
  return values;
};

async function addTile(ctx, overrides) {
  const before = ctx.api.getState().products.map((p) => p.id);
  await ctx.api.addProduct(tileValues(overrides));
  return ctx.api.getState().products.find((p) => !before.includes(p.id));
}

// Sells `qty` boxes of a product the way the Sell page does; returns the saved invoice.
async function sell(ctx, product, { qty = "2", unit = "box", name = "Alex", phone = "", paid = "" } = {}) {
  const { api } = ctx;
  assert.equal(api.addToSale(product.id, qty, unit).ok, true);
  api.getSale().customer.name = name;
  api.getSale().customer.phone = phone;
  api.getSale().paidValue = paid;
  await api.completeSale();
  return api.getInvoices()[api.getInvoices().length - 1];
}

const flushAndCompare = async (ctx) => {
  await ctx.api.autoBackup.flushNow();
  const parsed = V.parseBackup(ctx.handle.content);
  assert.equal(parsed.error, undefined, parsed.error);
  const all = await ctx.api.db.loadAll();
  assert.equal(parsed.revision, all.revision, "the backup file carries the database revision");
  assert.deepEqual(plain(parsed.data.invoices.map(V.stripDerived)), plain(all.invoices));
  assert.deepEqual(plain(parsed.data.products), plain(all.products));
  assert.deepEqual(plain(parsed.data.settings), plain(all.settings));
  assert.deepEqual(plain(parsed.data.suppliers || []), plain(all.suppliers || []));
  return { parsed, all };
};

const stockOf = (api, id) => api.getState().products.find((p) => p.id === id).stock;
const invoiceById = (api, id) => api.getState().invoices.find((i) => i.id === id);

/* ==========================================================================
   1. Several business phone numbers
   ========================================================================== */

test("phones: an older business with one phone is read as a list of one, and the invoice looks exactly as before", () => {
  const legacy = { businessName: "Shop", address: "Rue 1", phone: "0550 11 22 33", email: "a@b.dz" };
  assert.deepEqual(V.businessPhones(legacy), ["0550 11 22 33"]);
  assert.deepEqual(V.businessSnapshot(legacy), { name: "Shop", address: "Rue 1", phone: "0550 11 22 33", email: "a@b.dz" }, "one number = the snapshot shape of today");
  const several = V.businessSnapshot({ ...legacy, phones: ["0550 11 22 33", "0661 44 55 66"] });
  assert.deepEqual(several.phones, ["0550 11 22 33", "0661 44 55 66"]);
  assert.equal(several.phone, "0550 11 22 33", "the older single phone is the first number");
});

test("phones: blank and repeated numbers are dropped, spacing is tidied, and too many are refused", () => {
  assert.deepEqual(V.cleanPhoneList(["  0550  11 ", "", "0550 11", "0661"]), ["0550 11", "0661"]);
  assert.match(V.settingsProblem({ ...plain(V.normalizeSettings({})), phones: new Array(V.MAX_BUSINESS_PHONES + 1).fill("1") }) || "", /./);
  assert.equal(V.settingsProblem({ ...plain(V.normalizeSettings({})), phones: "0550" }) !== "", true);
});

test("phones: add, remove and save several numbers; they persist, survive a reload and reach the backup file", async () => {
  const ctx = await boot();
  const { api, app } = ctx;
  api.fillSettingsForm();
  const first = api.getState().phoneRows[0];
  api.setPhoneRow(first.rowId, "0550 11 22 33");
  const second = api.addPhoneRow();
  api.setPhoneRow(second.rowId, "0661 44 55 66");
  const third = api.addPhoneRow();
  api.setPhoneRow(third.rowId, "0770 00 00 00");
  assert.equal(api.removePhoneRow(third.rowId), true);
  app.field("sName").value = "Shop";
  await api.saveBusinessSettings();
  assert.deepEqual(plain(api.getState().settings.phones), ["0550 11 22 33", "0661 44 55 66"]);
  assert.equal(api.getState().settings.phone, "0550 11 22 33");

  const stored = (await api.db.loadAll()).settings;
  assert.deepEqual(plain(stored.phones), ["0550 11 22 33", "0661 44 55 66"]);
  await api.loadFromDatabase();
  assert.deepEqual(plain(api.getState().settings.phones), ["0550 11 22 33", "0661 44 55 66"]);
  api.fillSettingsForm();
  same(api.getState().phoneRows.map((r) => r.value), ["0550 11 22 33", "0661 44 55 66"]);
  await flushAndCompare(ctx);   // the backup holds the numbers too
});

test("phones: the last row can not be removed, and a blank row saves no number", async () => {
  const { api, app } = await boot();
  api.fillSettingsForm();
  assert.equal(api.removePhoneRow(api.getState().phoneRows[0].rowId), false);
  app.field("sName").value = "Shop";
  await api.saveBusinessSettings();
  assert.deepEqual(plain(api.getState().settings.phones), []);
  assert.equal(api.getState().settings.phone, "");
});

test("phones: several numbers print on the invoice as one neat line; a single number prints as it always did", async () => {
  const ctx = await boot();
  const { api } = ctx;
  const tile = await addTile(ctx);
  // One number (the older way of saving it): no phone list markup at all.
  await api.commit((d) => { d.settings.phone = "0550 11 22 33"; });
  const one = await sell(ctx, tile);
  const htmlOne = api.invoiceHtml(one);
  assert.match(htmlOne, /0550 11 22 33/);
  assert.doesNotMatch(htmlOne, /inv-phones/);
  assert.deepEqual(plain(one.business), { name: one.business.name, address: "", phone: "0550 11 22 33", email: "" });

  await api.commit((d) => { d.settings.phones = ["0550 11 22 33", "0661 44 55 66"]; });
  const two = await sell(ctx, tile);
  assert.deepEqual(plain(two.business.phones), ["0550 11 22 33", "0661 44 55 66"]);
  const htmlTwo = api.invoiceHtml(two);
  assert.match(htmlTwo, /inv-phones/);
  assert.match(htmlTwo, /0550 11 22 33[\s\S]*0661 44 55 66/);
  // An invoice saved earlier keeps the letterhead it was made with.
  assert.doesNotMatch(api.invoiceHtml(invoiceById(api, one.id)), /0661 44 55 66/);
});

/* ==========================================================================
   2. Several supplier contacts
   ========================================================================== */

test("supplier contacts: several contacts, either part may be blank, the first one is the main contact", () => {
  const d = { suppliers: [], products: [], purchases: [], settings: V.normalizeSettings({}) };
  const r = P.saveSupplier(d, { name: "Timgad", contacts: [{ name: "Karim", phone: "0550 1" }, { name: "", phone: "0661 2" }, { name: "Sofia", phone: "" }, { name: "", phone: "" }] });
  assert.equal(r.error, undefined, r.error);
  assert.deepEqual(plain(r.supplier.contacts), [{ name: "Karim", phone: "0550 1" }, { name: "", phone: "0661 2" }, { name: "Sofia", phone: "" }], "an empty contact is dropped");
  assert.equal(r.supplier.contactName, "Karim");
  assert.equal(r.supplier.phone, "0550 1");
  assert.deepEqual(P.supplierPhones(r.supplier), ["0550 1", "0661 2"]);
  assert.deepEqual(P.supplierContactNames(r.supplier), ["Karim", "Sofia"]);
});

test("supplier contacts: a supplier saved with one contact name and one phone is read as a list of one, and an edit keeps it safe", () => {
  const legacy = { id: "s1", name: "Old Supplier", contactName: "Amine", phone: "0550 9" };
  assert.deepEqual(plain(P.supplierContacts(legacy)), [{ name: "Amine", phone: "0550 9" }]);
  assert.equal(P.normalizeSupplier({ ...legacy, archived: false }).contacts, undefined, "reading never rewrites the stored shape");

  const d = { suppliers: [P.normalizeSupplier({ ...legacy, archived: false, currency: "DA", createdAt: iso(), updatedAt: iso(), revision: 1 })], products: [], purchases: [], settings: V.normalizeSettings({}) };
  const edited = P.saveSupplier(d, { id: "s1", name: "Old Supplier", contacts: [{ name: "Amine", phone: "0550 9" }, { name: "Nadia", phone: "0661 3" }] });
  assert.equal(edited.error, undefined, edited.error);
  assert.equal(edited.supplier.contacts.length, 2);
  assert.equal(edited.supplier.phone, "0550 9");
});

test("supplier contacts: too many contacts are refused with a message, and a phone shared with another supplier is flagged", () => {
  const d = { suppliers: [], products: [], purchases: [], settings: V.normalizeSettings({}) };
  const many = Array.from({ length: P.MAX_CONTACTS + 1 }, (_, i) => ({ name: "C" + i, phone: "" }));
  assert.match(P.saveSupplier(d, { name: "X", contacts: many }).error, /./);
  assert.ok(P.saveSupplier(d, { name: "First", contacts: [{ name: "A", phone: "0550 1" }, { name: "B", phone: "0661 22 33 44" }] }).supplier);
  const again = P.saveSupplier(d, { name: "Second", contacts: [{ name: "Z", phone: "0661 22 33 44" }] });
  assert.ok(again.duplicates && again.duplicates.length === 1, "the second contact's phone matches the first supplier");
});

test("supplier contacts: saved through the database, they reach the backup file", async () => {
  const ctx = await boot();
  const r = await ctx.api.commit((d) => P.saveSupplier(d, { name: "Timgad", contacts: [{ name: "Karim", phone: "0550 1" }, { name: "", phone: "0661 2" }] }));
  assert.equal(r.error, undefined, r.error);
  const { all } = await flushAndCompare(ctx);
  assert.deepEqual(plain(all.suppliers[0].contacts), [{ name: "Karim", phone: "0550 1" }, { name: "", phone: "0661 2" }]);
});

test("supplier contacts: the form lists a contact per row, can add and remove them, and reads them back", () => {
  const ui = loadApp().api.PurchasesUI;
  const form = ui.supplierFormHtml({ id: "s1", name: "Old", contactName: "Amine", phone: "0550 9" });
  assert.match(form, /Amine/);
  assert.match(form, /0550 9/);
  assert.match(form, /sup-contact-add/);
});

/* ==========================================================================
   3. The "sale completed" dialog
   ========================================================================== */

test("sale dialog: after a successful save it opens on Print Invoice, with the saved invoice number", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx);
  const inv = await sell(ctx, tile, { paid: "500" });
  const done = ctx.api.getSaleDone();
  assert.deepEqual(plain(done), { id: inv.id, number: inv.invoiceNumber });
  assert.match(ctx.app.field("saleDoneNumber").textContent, new RegExp(inv.invoiceNumber));
  assert.equal(ctx.print.calls, 0, "nothing is printed until the person asks");
});

test("sale dialog: Enter on Print Invoice prints the exact saved invoice, once, even when pressed repeatedly", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx);
  const inv = await sell(ctx, tile, { name: "Alex", paid: "500" });
  const before = ctx.api.getInvoices().length;
  await Promise.all([ctx.api.saleDoneAction("print"), ctx.api.saleDoneAction("print"), ctx.api.saleDoneAction("print")]);
  assert.equal(ctx.print.calls, 1, "repeated Enter / clicks print one invoice");
  assert.equal(ctx.api.getInvoices().length, before, "no duplicate invoice");
  assert.equal(ctx.api.getSaleDone(), null);
  const printed = ctx.app.field("invoice").innerHTML;
  assert.match(printed, new RegExp(inv.invoiceNumber));
  assert.match(printed, /Alex/);
  assert.equal(stockOf(ctx.api, tile.id), 8, "the sale was committed once");
});

test("sale dialog: the invoice is committed before printing, so a print that fails or is cancelled leaves it saved", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx);
  const inv = await sell(ctx, tile);
  ctx.print.fail = true;
  await ctx.api.saleDoneAction("print");
  assert.equal(ctx.print.calls, 1);
  assert.equal((await ctx.api.db.loadAll()).invoices.some((i) => i.id === inv.id), true, "saved in the database");
  assert.match(ctx.app.toast(), /./);
  await flushAndCompare(ctx);
});

test("sale dialog: New Sale and Later close it without printing, and never lose or repeat the invoice", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx);
  await sell(ctx, tile);
  await ctx.api.saleDoneAction("new");
  assert.equal(ctx.api.getSaleDone(), null);
  assert.equal(ctx.print.calls, 0);
  assert.equal(ctx.api.getInvoices().length, 1);

  await sell(ctx, tile);
  await ctx.api.saleDoneAction("later");
  assert.equal(ctx.api.getSaleDone(), null);
  assert.equal(ctx.print.calls, 0);
  assert.equal(ctx.api.getInvoices().length, 2);
  await ctx.api.saleDoneAction("print");   // nothing is pending any more
  assert.equal(ctx.print.calls, 0);
});

/* ==========================================================================
   4. Editing a saved invoice (on the Sell page)
   ========================================================================== */

// Opens the invoice on the Sell page and returns the sale on screen (the saved invoice, loaded as a Sell page sale).
function openEdit(ctx, inv) {
  const r = ctx.api.startEditInvoice(inv.id);
  assert.equal(r.error, undefined, r.error);
  return ctx.api.getSale();
}
const typeQty = (api, index, qty) => api.updateSaleQuantity(api.getSale().items[index].lineId, String(qty));
const typePrice = (api, index, price) => api.updateSalePrice(api.getSale().items[index].lineId, String(price));

test("edit: opening shows what the invoice has; nothing typed means nothing to save", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx);
  const inv = await sell(ctx, tile, { paid: "500", phone: "0550 1" });
  const sale = openEdit(ctx, inv);
  assert.equal(ctx.api.getInvoiceEdit().id, inv.id);
  assert.equal(sale.customer.name, "Alex");
  assert.equal(sale.customer.phone, "0550 1");
  assert.equal(sale.items.length, 1);
  assert.equal(ctx.app.field("custName").value, "Alex", "the Sell page's own customer boxes show it");
  assert.equal(ctx.app.field("editBanner").hidden, false);
  assert.equal(ctx.api.editDirty(), false);
  const revision = (await ctx.api.db.loadAll()).revision;
  await ctx.api.saveInvoiceEdit();
  assert.equal((await ctx.api.db.loadAll()).revision, revision, "nothing changed = nothing written");
});

test("edit: changing a quantity keeps number, date, customer id, payments and historical pricing, and moves the stock", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx);
  const inv = await sell(ctx, tile, { qty: "2", paid: "500" });
  const original = plain(inv);
  // The catalogue price changes afterwards: the invoice must keep the price it was sold at.
  await ctx.api.commit((d) => { const p = d.products.find((x) => x.id === tile.id); p.sellingPrice = 5000; p.sellingPrices = [{ unit: "m2", price: 5000 }]; });
  const counter = (await ctx.api.db.loadAll()).counter;

  openEdit(ctx, inv);
  assert.equal(typeQty(ctx.api, 0, 3).error, undefined);
  assert.equal(ctx.api.editDirty(), true);
  await ctx.api.saveInvoiceEdit();

  const saved = invoiceById(ctx.api, inv.id);
  assert.equal(saved.invoiceNumber, original.invoiceNumber);
  assert.equal(saved.date, original.date);
  assert.deepEqual(plain(saved.customer), original.customer);
  assert.deepEqual(plain(saved.payments), original.payments, "payment history untouched");
  assert.equal(saved.items[0].qty, 3);
  assert.equal(saved.items[0].unitPrice, original.items[0].unitPrice, "the price it was sold at");
  assert.equal(saved.items[0].unitPriceUnit, original.items[0].unitPriceUnit);
  assert.equal(saved.items[0].productPrice, original.items[0].productPrice, "the catalogue price then");
  assert.equal(saved.items[0].priceSource, original.items[0].priceSource);
  assert.equal(saved.total, original.items[0].unitPrice * 3);
  assert.equal(stockOf(ctx.api, tile.id), 7, "10 - 2 sold, 1 more box taken by the edit");
  assert.equal((await ctx.api.db.loadAll()).counter, counter, "the invoice counter is not touched");
  assert.equal(ctx.api.getInvoices().length, 1);
  const info = ctx.api.paymentInfo(saved);
  assert.equal(info.paid, 500);
  assert.equal(info.remaining, saved.total - 500, "balance and status follow the new total");
  assert.equal(ctx.api.getInvoiceEdit(), null, "the edit ends after saving");
  await flushAndCompare(ctx);
});

test("edit: reducing a quantity and removing a line put the stock back", async () => {
  const ctx = await boot();
  const a = await addTile(ctx);
  const b = await addTile(ctx, { name: "Pietra Beige", sku: "PB-1", stock: 10 });
  const { api } = ctx;
  api.addToSale(a.id, "4", "box");
  api.addToSale(b.id, "3", "box");
  api.getSale().customer.name = "Alex";
  await api.completeSale();
  const inv = api.getInvoices()[0];
  assert.equal(stockOf(api, a.id), 6);
  assert.equal(stockOf(api, b.id), 7);

  const sale = openEdit(ctx, inv);
  typeQty(api, sale.items.findIndex((l) => l.productId === a.id), 1);
  api.removeFromSale(sale.items.find((l) => l.productId === b.id).lineId);
  await api.saveInvoiceEdit();
  assert.equal(stockOf(api, a.id), 9);
  assert.equal(stockOf(api, b.id), 10);
  assert.equal(invoiceById(api, inv.id).items.length, 1);
  await flushAndCompare(ctx);
});

test("edit: customer details, a selling price and the discount can be changed; totals are recalculated", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx);                       // 800 DA/m², 1.44 m² per box
  const inv = await sell(ctx, tile, { qty: "2", paid: "0" });
  const sale = openEdit(ctx, inv);
  sale.customer.name = "Alexandre";
  sale.customer.phone = "0770 55";
  assert.equal(typePrice(ctx.api, 0, "1000").error, undefined);   // 1,000 DA per m² (the product's own unit), 2 boxes = 2.88 m²
  sale.discountValue = "100";
  sale.discountType = "amount";
  await ctx.api.saveInvoiceEdit();
  const saved = invoiceById(ctx.api, inv.id);
  assert.equal(saved.customer.name, "Alexandre");
  assert.equal(saved.customer.phone, "0770 55");
  assert.equal(saved.items[0].unitPrice, 1440, "1,000 DA/m² x 1.44 m² per box");
  assert.equal(saved.items[0].priceOverridden, true);
  assert.equal(saved.items[0].total, 2880);
  assert.equal(saved.subtotal, 2880);
  assert.equal(saved.discount, 100);
  assert.equal(saved.total, 2780);
  assert.equal(saved.invoiceNumber, inv.invoiceNumber);
});

test("edit: a product can be added to the invoice (stock taken, same rules as a sale)", async () => {
  const ctx = await boot();
  const a = await addTile(ctx);
  const b = await addTile(ctx, { name: "Pietra Beige", sku: "PB-1", stock: 5 });
  const inv = await sell(ctx, a, { qty: "1" });
  const { api } = ctx;
  openEdit(ctx, inv);
  const added = api.addToSale(b.id, "2", "box");
  assert.equal(added.error, undefined, added.error);
  await api.saveInvoiceEdit();
  const saved = invoiceById(api, inv.id);
  assert.equal(saved.items.length, 2);
  assert.equal(saved.items[1].qty, 2);
  assert.equal(saved.items[1].stockDeducted, 2);
  assert.equal(stockOf(api, b.id), 3);
});

test("edit: more than the stock can give is refused and NOTHING changes (no partial edit, no backup write)", async () => {
  const ctx = await boot();
  const a = await addTile(ctx, { stock: 10 });
  const inv = await sell(ctx, a, { qty: "2", paid: "500" });
  await flushAndCompare(ctx);
  const before = plain(await ctx.api.db.loadAll());

  const sale = openEdit(ctx, inv);
  sale.customer.name = "Someone Else";   // a valid change next to the impossible one must not slip through
  assert.match(typeQty(ctx.api, 0, "50").error, /stock/i, "the Sell page refuses it as it is typed");
  sale.items[0].qty = 50;                // and a stale screen that still holds it is refused when saving
  const plan = ctx.api.editPlan();
  assert.match(plan.error, /./);
  await ctx.api.saveInvoiceEdit();
  assert.match(ctx.app.field("saleError").textContent, /./);
  assert.equal(ctx.api.getInvoiceEdit() !== null, true, "the screen stays open with what was typed");

  const after = plain(await ctx.api.db.loadAll());
  assert.deepEqual(after, before, "database untouched, revision included");
  assert.equal(stockOf(ctx.api, a.id), 8);
  assert.equal(invoiceById(ctx.api, inv.id).customer.name, "Alex");
});

test("edit: invalid inputs are refused (zero, negative or fractional box quantity, negative price, a price left empty)", async () => {
  const ctx = await boot();
  const a = await addTile(ctx);
  const inv = await sell(ctx, a, { qty: "2" });
  openEdit(ctx, inv);
  const line = ctx.api.getSale().items[0];
  for (const qty of ["0", "-1", "1.5", "abc", ""]) {
    assert.match(typeQty(ctx.api, 0, qty).error || "", /./, `quantity "${qty}" must be refused`);
    assert.equal(line.qty, 2, "the line keeps its quantity");
  }
  assert.match(typePrice(ctx.api, 0, "-5").error || "", /./);
  assert.match(typePrice(ctx.api, 0, "").error || "", /./);
  assert.equal(ctx.api.editPlan().error, undefined, "what was refused was never typed in: the sale is still the saved invoice");
  assert.equal(ctx.api.editPlan().skip, true);
  assert.equal(invoiceById(ctx.api, inv.id).items[0].qty, 2);
});

test("edit: a price cut below what is already paid is saved; payments are never deleted and the difference is a refund due, not a payment", async () => {
  const ctx = await boot();
  const a = await addTile(ctx);
  const inv = await sell(ctx, a, { qty: "2", paid: "2000" });   // 800 DA/m² x 2.88 m² = 2304, 2000 paid
  openEdit(ctx, inv);
  typePrice(ctx.api, 0, "100");   // 100 DA/m²: new total 288 < 2000 paid
  const plan = ctx.api.editPlan();
  assert.equal(plan.error, undefined, "an overpayment is no longer a reason to refuse the edit");
  assert.equal(plan.refundDue, 1712);
  await ctx.api.saveInvoiceEdit();
  const saved = invoiceById(ctx.api, inv.id);
  assert.deepEqual(plain(saved.payments), plain(inv.payments), "payment history is exactly as it was");
  assert.equal(saved.items[0].unitPrice, 144);
  assert.equal(saved.total, 288);
  const info = ctx.api.paymentInfo(saved);
  assert.equal(info.paid, 2000, "nothing was recorded as paid back");
  assert.equal(info.remaining, 0);
  assert.equal(info.refundDue, 1712);
  assert.match(info.status, /paid/i);
});

test("edit: leaving with unsaved changes asks first; cancelling the question keeps the screen and what was typed", async () => {
  const ctx = await boot();
  const a = await addTile(ctx);
  const inv = await sell(ctx, a);
  openEdit(ctx, inv);
  assert.equal(ctx.api.cancelInvoiceEdit().cancelled, true, "nothing typed: it just closes");
  assert.equal(ctx.app.confirms.length, 0);

  const sale = openEdit(ctx, inv);
  sale.customer.name = "Changed";
  ctx.app.answer(false);
  assert.equal(ctx.api.cancelInvoiceEdit().stayed, true);
  assert.equal(ctx.app.confirms.length, 1);
  assert.equal(ctx.api.getSale().customer.name, "Changed");
  ctx.app.answer(false);
  assert.equal(ctx.api.showView("invoices"), false, "the menu is blocked too");
  assert.equal(ctx.api.getInvoiceEdit() !== null, true);
  ctx.app.answer(true);
  assert.equal(ctx.api.cancelInvoiceEdit().cancelled, true);
  assert.equal(invoiceById(ctx.api, inv.id).customer.name, "Alex", "nothing was saved");
  assert.equal(ctx.api.getInvoiceEdit(), null);
  assert.equal(ctx.api.getSale().items.length, 0, "the sale that was being prepared before the edit is back");
});

test("edit: printing an edited invoice prints the corrected details under the same number", async () => {
  const ctx = await boot();
  const a = await addTile(ctx);
  const inv = await sell(ctx, a, { qty: "2", name: "Alex" });
  const sale = openEdit(ctx, inv);
  sale.customer.name = "Alexandre";
  typeQty(ctx.api, 0, 3);
  await ctx.api.saveInvoiceEdit();
  ctx.api.printInvoice(invoiceById(ctx.api, inv.id));
  const html = ctx.app.field("invoice").innerHTML;
  assert.match(html, new RegExp(inv.invoiceNumber));
  assert.match(html, /Alexandre/);
  assert.doesNotMatch(html, />Alex</);
  assert.equal(ctx.print.calls, 1);
});

test("edit: invoices that track deliveries keep their quantities and lines (delivery history stays true)", async () => {
  const ctx = await boot();
  const a = await addTile(ctx, { stock: 10 });
  const { api } = ctx;
  api.addToSale(a.id, "1", "box");
  const line = api.getSale().items[0];
  api.setSalePartial(line.lineId, true);
  api.updateSaleQuantity(line.lineId, "4");
  api.updateSaleDeliverNow(line.lineId, "1");
  api.getSale().customer.name = "Alex";
  await api.completeSale();
  const inv = api.getInvoices()[0];
  assert.equal(V.isTracked(inv), true);
  const sale = openEdit(ctx, inv);
  sale.items[0].qty = 3;
  assert.match(api.editPlan().error || "", /./, "a quantity that deliveries refer to is locked");
  sale.items[0].qty = 4;
  sale.customer.phone = "0550 1";   // the customer and the price can still be corrected
  typePrice(api, 0, "1000");
  assert.equal(api.editPlan().error, undefined);
  // Removing every line deletes the invoice (the rollback), delivery record or not: it is planned, not refused, and gives back only the
  // goods that were handed over (1 of the 4 boxes).
  const keep = sale.items.slice();
  sale.items = [];
  const rollback = api.editPlan();
  assert.equal(rollback.error, undefined, rollback.error);
  assert.equal(rollback.deleted, true);
  assert.deepEqual(plain(rollback.stock.map((s) => s.qty)), [1], "only the delivered box goes back");
  sale.items = keep;
  await api.saveInvoiceEdit();
  const saved = invoiceById(api, inv.id);
  assert.deepEqual(plain(saved.deliveries), plain(inv.deliveries));
  assert.equal(saved.items[0].lineId, inv.items[0].lineId);
  assert.equal(saved.items[0].unitPrice, 1440, "1,000 DA/m² x 1.44 m² per box");
});

test("edit: a change made in another window (the invoice was edited meanwhile) is not overwritten", async () => {
  const ctx = await boot();
  const a = await addTile(ctx);
  const inv = await sell(ctx, a, { qty: "2" });
  openEdit(ctx, inv);
  typeQty(ctx.api, 0, 3);
  // Meanwhile the invoice changes underneath the open screen.
  await ctx.api.commit((d) => { const i = d.invoices.find((x) => x.id === inv.id); i.items[0].qty = 1; i.items[0].total = 1152; i.subtotal = 1152; i.total = 1152; i.items[0].stockDeducted = 1; d.products.find((p) => p.id === a.id).stock += 1; });
  await ctx.api.saveInvoiceEdit();
  assert.match(ctx.app.field("saleError").textContent, /./);
  assert.equal(invoiceById(ctx.api, inv.id).items[0].qty, 1, "the newer data stays");
});

/* ==========================================================================
   5. Similar-product suggestions in Stock
   ========================================================================== */

const catalogue = () => [
  sampleProduct({ id: "a", name: "Cotto Bianco", tileSize: "60*60", manufacturer: "Timgad Ceramic", productType: "Faience" }),
  sampleProduct({ id: "b", name: "Cotto Bianco", tileSize: "30*60", manufacturer: "Cevisama" }),
  sampleProduct({ id: "c", name: "Marmo Nero", tileSize: "60*120", manufacturer: "Timgad Ceramic" }),
  sampleProduct({ id: "d", name: "Évier Inox", tileSize: "", manufacturer: "Franke" }),
];
const names = (list) => list.map((p) => p.id);

test("suggestions: case, spacing, punctuation and accents do not matter", () => {
  const products = catalogue();
  for (const typed of ["cotto bianco", "COTTO  BIANCO", "Cotto-Bianco", "cottobianco", " cotto.bianco ", "cotto"]) {
    assert.deepEqual(names(V.suggestProducts(typed, products)).sort(), ["a", "b"], typed);
  }
  assert.deepEqual(names(V.suggestProducts("evier", products)), ["d"], "accents are ignored");
  assert.deepEqual(names(V.suggestProducts("mar nero", products)), ["c"], "every word typed is found");
});

test("suggestions: matches on manufacturer, size or type; nothing typed or nothing alike gives an empty list; the edited product is left out", () => {
  const products = catalogue();
  assert.deepEqual(names(V.suggestProducts("cevisama", products)), ["b"]);
  assert.deepEqual(names(V.suggestProducts("faience", products)), ["a"]);
  assert.deepEqual(names(V.suggestProducts("", products)), []);
  assert.deepEqual(names(V.suggestProducts("   ", products)), []);
  assert.deepEqual(names(V.suggestProducts("zzzzz", products)), []);
  assert.deepEqual(names(V.suggestProducts("cotto bianco", products, { exceptId: "a" })), ["b"]);
  assert.equal(V.suggestProducts("a", Array.from({ length: 30 }, (_, i) => sampleProduct({ id: "x" + i, name: "A" + i }))).length, 6, "the list stays short");
});

test("suggestions: the best match comes first (the same name, then names that start with the text)", () => {
  const products = [
    sampleProduct({ id: "1", name: "Grand Cotto Bianco" }),
    sampleProduct({ id: "2", name: "Cotto Bianco Plus" }),
    sampleProduct({ id: "3", name: "Cotto Bianco" }),
  ];
  assert.deepEqual(names(V.suggestProducts("cotto bianco", products)), ["3", "2", "1"]);
});

test("suggestions: the Stock form shows full name, tile size, type and manufacturer, live, from the list in memory", async () => {
  const ctx = await boot();
  const { api, app } = ctx;
  await api.addProduct(tileValues({ name: "Cotto Bianco", tileSize: "60*60", manufacturer: "Timgad Ceramic", productType: "Faience", sku: "CB-60" }));
  await api.addProduct(tileValues({ name: "Marmo Nero", tileSize: "60*120", manufacturer: "Cevisama", sku: "MN-1" }));
  app.field("pName").value = "cotto-bi";
  api.renderProductSuggestions();
  const box = app.field("productSimilar");
  assert.equal(box.hidden, false);
  assert.match(box.innerHTML, /Cotto Bianco/);
  assert.match(box.innerHTML, /Timgad Ceramic/);
  assert.match(box.innerHTML, /Faience/);
  assert.match(box.innerHTML, /60 ?[×x*] ?60|60\*60/);
  assert.doesNotMatch(box.innerHTML, /Marmo Nero/);
  assert.match(box.innerHTML, /data-similar="view"/);
  assert.doesNotMatch(box.innerHTML, /data-similar="stock"/, "stock is changed by editing the product: no separate add-stock shortcut");
  assert.doesNotMatch(box.innerHTML, /Review one or add stock/, "no instruction text in the form");

  // Typing is answered from memory: the database is not read again.
  let reads = 0;
  const loadAll = api.db.loadAll;
  api.db.loadAll = async (...a) => { reads++; return loadAll.apply(api.db, a); };
  for (const typed of ["m", "ma", "mar", "marm"]) { app.field("pName").value = typed; api.renderProductSuggestions(); }
  api.db.loadAll = loadAll;
  assert.equal(reads, 0);
  assert.match(box.innerHTML, /Marmo Nero/);
});

test("suggestions: the box stays hidden (no message) when nothing matches or the name is empty", async () => {
  const ctx = await boot();
  await ctx.api.addProduct(tileValues());
  ctx.app.field("pName").value = "Completely New Thing";
  ctx.api.renderProductSuggestions();
  assert.equal(ctx.app.field("productSimilar").hidden, true);
  assert.equal(ctx.app.field("productSimilar").innerHTML, "");
  ctx.app.field("pName").value = "";
  ctx.api.renderProductSuggestions();
  assert.equal(ctx.app.field("productSimilar").hidden, true);
});

test("suggestions: nothing is merged or deleted; a similar name with another size is still added as a new variant", async () => {
  const ctx = await boot();
  const { api } = ctx;
  await api.addProduct(tileValues({ name: "Cotto Bianco", tileSize: "60*60", sku: "CB-60" }));
  ctx.app.field("pName").value = "Cotto Bianco";
  api.renderProductSuggestions();
  assert.equal(api.getState().products.length, 1, "suggesting changes nothing");
  await api.addProduct(tileValues({ name: "Cotto Bianco", tileSize: "30*60", sku: "CB-30", coveragePerBox: 1.08 }));
  assert.equal(api.getState().products.length, 2);
  assert.equal(api.getState().products.filter((p) => p.name === "Cotto Bianco").length, 2);
  // The existing duplicate rule is unchanged: the exact same product is a duplicate, another size is not.
  const products = plain(api.getState().products);
  assert.ok(V.findDuplicateProduct({ name: "Cotto Bianco", manufacturer: "Timgad Ceramic", tileSize: "30*60", sku: "CB-30" }, products));
  assert.equal(V.findDuplicateProduct({ name: "Cotto Bianco", manufacturer: "Timgad Ceramic", tileSize: "45*45", sku: "CB-45" }, products), null);
});

test("suggestions: choosing a suggestion opens that product for review / editing, without saving anything", async () => {
  const ctx = await boot();
  const { api, app } = ctx;
  await api.addProduct(tileValues({ name: "Cotto Bianco", sku: "CB-60" }));
  await api.addProduct(tileValues({ name: "Marmo Nero", sku: "MN-1" }));
  const [a, b] = api.getState().products;
  const revision = (await api.db.loadAll()).revision;
  assert.equal(api.useSuggestion(a.id, "view"), true);
  assert.equal(api.getState().editingId, a.id);
  assert.equal(api.getStockView().open, true, "the product form is open on the Stock page");
  assert.equal(api.useSuggestion(b.id, "view"), true);
  assert.equal(api.getState().editingId, b.id);
  assert.equal(api.useSuggestion("missing", "view"), false);
  assert.equal((await api.db.loadAll()).revision, revision);
});

/* ==========================================================================
   6. Invoice history: search, filter, sort
   ========================================================================== */

// Invoices of different numbers, dates, customers, totals, payments and deliveries, put straight into the screen's data.
function historyApp() {
  const app = loadApp();
  const { api } = app;
  const mk = (number, over) => ({
    ...sampleInvoice({ number }),
    ...over,
  });
  const delivery = (status) => status === "none" ? {} : {
    items: [{ ...sampleInvoice().items[0], lineId: "l" + status, qty: 2 }],
    deliveries: status === "complete" ? [{ id: "d1", type: "sale", date: iso(), lines: [{ lineId: "lcomplete", qty: 2 }] }]
      : status === "partial" ? [{ id: "d1", type: "sale", date: iso(), lines: [{ lineId: "lpartial", qty: 1 }] }] : [],
  };
  api.getState().invoices = [
    mk(2, { customer: { name: "Zora Ben", phone: "0550 11 22 33", address: "" }, total: 3000, subtotal: 3000, discount: 0, payments: [{ amount: 3000, timestamp: iso() }], date: "2026-03-05T10:00:00.000Z" }),
    mk(9, { customer: { name: "alice Ait", phone: "0661 99 88 77", address: "" }, total: 900, subtotal: 1000, discount: 100, payments: [], date: "2026-01-20T10:00:00.000Z", ...delivery("pending") }),
    mk(10, { customer: { name: "Bob Dahmani", phone: "0770 12 34 56", address: "" }, total: 12000, subtotal: 12000, discount: 0, payments: [{ amount: 100, timestamp: iso() }], date: "2025-12-31T10:00:00.000Z", ...delivery("partial") }),
    mk(11, { customer: { name: "Alice Brahimi", phone: "0550 77 66 55", address: "" }, total: 500, subtotal: 500, discount: 0, payments: [{ amount: 500, timestamp: iso() }], date: "2026-02-14T10:00:00.000Z", ...delivery("complete") }),
  ];
  return { app, api };
}

const shown = (api, query, view) => Array.from(api.searchInvoices(query, view)).map((i) => i.invoiceNumber);
const inv = (...n) => n.map((x) => "INV-" + String(x).padStart(6, "0"));
const resetView = (api) => Object.assign(api.invoiceView, { pay: "all", delivery: "all", sortKey: null, sortDir: 1 });

test("history: search finds partial, case-insensitive matches on number, customer name and customer phone", () => {
  const { api } = historyApp();
  resetView(api);
  assert.deepEqual(shown(api, "inv-000010"), inv(10));
  assert.deepEqual(shown(api, "000009"), inv(9));
  assert.deepEqual(shown(api, "ALICE").sort(), inv(9, 11));
  assert.deepEqual(shown(api, "ali bra"), inv(11));
  assert.deepEqual(shown(api, "0550").sort(), inv(2, 11));
  assert.deepEqual(shown(api, "05501122"), inv(2), "spaces in the phone do not matter");
  assert.deepEqual(shown(api, "nobody"), []);
  assert.equal(shown(api, "").length, 4);
});

test("history: payment and delivery filters are independent and work with the search", () => {
  const { api } = historyApp();
  resetView(api);
  const view = (pay, delivery) => ({ pay, delivery, sortKey: null, sortDir: 1 });
  assert.deepEqual(shown(api, "", view("paid", "all")).sort(), inv(2, 11));
  assert.deepEqual(shown(api, "", view("unpaid", "all")), inv(9));
  assert.deepEqual(shown(api, "", view("partial", "all")), inv(10));
  assert.deepEqual(shown(api, "", view("all", "notDelivered")).sort(), inv(9, 10));
  assert.deepEqual(shown(api, "", view("all", "delivered")).sort(), inv(2, 11), "an invoice that does not track deliveries handed everything over at the sale");
  assert.deepEqual(shown(api, "", view("unpaid", "notDelivered")), inv(9));
  assert.deepEqual(shown(api, "", view("paid", "notDelivered")), []);
  assert.deepEqual(shown(api, "alice", view("paid", "delivered")), inv(11));
});

test("history: sorting by number is numeric, by date chronological, by customer A-Z ignoring case, by total numeric, by status by payment state", () => {
  const { api } = historyApp();
  const by = (key, dir) => shown(api, "", { pay: "all", delivery: "all", sortKey: key, sortDir: dir });
  assert.deepEqual(by("number", 1), inv(2, 9, 10, 11), "9 before 10, not after");
  assert.deepEqual(by("number", -1), inv(11, 10, 9, 2));
  assert.deepEqual(by("date", 1), inv(10, 9, 11, 2));
  assert.deepEqual(by("date", -1), inv(2, 11, 9, 10));
  assert.deepEqual(by("customer", 1), inv(9, 11, 10, 2), "alice, Alice, Bob, Zora");
  assert.deepEqual(by("customer", -1), inv(2, 10, 11, 9));
  assert.deepEqual(by("total", 1), inv(11, 9, 2, 10), "500 < 900 < 3000 < 12000 (not as text)");
  assert.deepEqual(by("total", -1), inv(10, 2, 9, 11));
  const status = by("status", 1);
  assert.equal(status[0], "INV-000009", "unpaid first");
  assert.equal(status[1], "INV-000010", "then partially paid");
  assert.deepEqual(status.slice(2).sort(), inv(2, 11));
});

test("history: clicking a header sorts ascending, clicking again descending; search, filters and sort work together; clear resets everything", () => {
  const { app, api } = historyApp();
  resetView(api);
  api.setInvoiceSort("number");
  assert.deepEqual([api.invoiceView.sortKey, api.invoiceView.sortDir], ["number", 1]);
  api.setInvoiceSort("number");
  assert.deepEqual([api.invoiceView.sortKey, api.invoiceView.sortDir], ["number", -1]);
  api.setInvoiceSort("total");
  assert.deepEqual([api.invoiceView.sortKey, api.invoiceView.sortDir], ["total", 1], "a new column starts ascending");

  app.field("invoiceFilter").value = "alice";
  api.invoiceView.pay = "paid";
  api.renderInvoices();
  const rows = [...app.field("invoiceBody").innerHTML.matchAll(/INV-\d+/g)].map((m) => m[0]).filter((n, i, all) => all.indexOf(n) === i);
  assert.deepEqual(rows, inv(11));
  assert.equal(app.field("invoiceClear").hidden, false);
  assert.match(app.field("invoiceCount").textContent, /1 of 4/);

  api.clearInvoiceFilters();
  assert.deepEqual([api.invoiceView.pay, api.invoiceView.delivery, api.invoiceView.sortKey], ["all", "all", null]);
  assert.equal(app.field("invoiceFilter").value, "");
  assert.equal(app.field("invoiceClear").hidden, true);
  assert.equal(shown(api, "").length, 4);
});

test("history: with the filters on and nothing matching, the screen says so; each row keeps its actions (including Edit)", () => {
  const { app, api } = historyApp();
  resetView(api);
  api.invoiceView.pay = "unpaid";
  api.invoiceView.delivery = "delivered";
  api.renderInvoices();
  assert.equal(app.field("invoiceTable").hidden, true);
  assert.match(app.field("invoiceEmpty").innerHTML, /No invoices match the selected filters/);
  resetView(api);
  api.renderInvoices();
  const html = app.field("invoiceBody").innerHTML;
  for (const action of ["view", "pay", "print", "edit", "delete"]) assert.match(html, new RegExp(`data-action="${action}"`));
});

/* ==========================================================================
   7. Automatic backup after each new kind of change
   ========================================================================== */

test("backup: business phones, supplier contacts, a sale, an invoice edit and a product each leave the file equal to the database", async () => {
  const ctx = await boot();
  const { api, app } = ctx;
  await flushAndCompare(ctx);

  api.fillSettingsForm();
  api.setPhoneRow(api.getState().phoneRows[0].rowId, "0550 1");
  api.setPhoneRow(api.addPhoneRow().rowId, "0661 2");
  app.field("sName").value = "Shop";
  await api.saveBusinessSettings();
  let { parsed } = await flushAndCompare(ctx);
  assert.deepEqual(plain(parsed.data.settings.phones), ["0550 1", "0661 2"]);

  await api.commit((d) => P.saveSupplier(d, { name: "Timgad", contacts: [{ name: "Karim", phone: "0550 9" }, { name: "", phone: "0661 8" }] }));
  ({ parsed } = await flushAndCompare(ctx));
  assert.equal(parsed.data.suppliers[0].contacts.length, 2);

  const tile = await addTile(ctx);
  await flushAndCompare(ctx);
  const invoice = await sell(ctx, tile, { qty: "2", paid: "500" });
  await ctx.api.saleDoneAction("later");
  ({ parsed } = await flushAndCompare(ctx));
  assert.equal(parsed.data.invoices.length, 1);

  const sale = openEdit(ctx, invoice);
  typeQty(api, 0, 3);
  sale.customer.name = "Alexandre";
  await api.saveInvoiceEdit();
  ({ parsed } = await flushAndCompare(ctx));
  assert.equal(parsed.data.invoices[0].items[0].qty, 3);
  assert.equal(parsed.data.invoices[0].customer.name, "Alexandre");
  assert.equal(parsed.data.products.find((p) => p.id === tile.id).stock, 7);
});

/* ==========================================================================
   8. Older data keeps working
   ========================================================================== */

test("legacy: old settings, suppliers and invoices are read and shown without being rewritten", async () => {
  const ctx = await boot();
  const { api } = ctx;
  // Data as an older version saved it: a single phone, a single contact, an invoice with no edit history.
  await api.commit((d) => {
    d.settings = { ...d.settings, phone: "0550 00 11 22" };
    delete d.settings.phones;
    d.suppliers = [P.normalizeSupplier({ id: "s-old", name: "Old Supplier", contactName: "Amine", phone: "0550 9", archived: false, currency: "DA", createdAt: iso(), updatedAt: iso(), revision: 1 })];
  });
  const stored = await api.db.loadAll();
  assert.equal(stored.settings.phones, undefined, "nothing was added to old settings");
  assert.equal(stored.suppliers[0].contacts, undefined, "nothing was added to an old supplier");
  api.fillSettingsForm();
  same(api.getState().phoneRows.map((r) => r.value), ["0550 00 11 22"]);
  assert.deepEqual(plain(P.supplierContacts(stored.suppliers[0])), [{ name: "Amine", phone: "0550 9" }]);

  const tile = await addTile(ctx);
  const old = await sell(ctx, tile, { paid: "100" });
  assert.equal(old.edits, undefined, "a never-edited invoice has no edit history");
  assert.deepEqual(plain(old.business), { name: old.business.name, address: "", phone: "0550 00 11 22", email: "" });
});

test("legacy: an edited invoice records when and how the total changed, and still validates as an invoice", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx);
  const invoice = await sell(ctx, tile, { qty: "2" });
  openEdit(ctx, invoice);
  typeQty(ctx.api, 0, 3);
  await ctx.api.saveInvoiceEdit();
  const saved = invoiceById(ctx.api, invoice.id);
  assert.equal(saved.edits.length, 1);
  assert.equal(saved.edits[0].totalBefore, 2304);
  assert.equal(saved.edits[0].totalAfter, 3456);
  assert.ok(saved.updatedAt);
  assert.equal(V.invoiceProblem(V.stripDerived(plain(saved))), "");
});

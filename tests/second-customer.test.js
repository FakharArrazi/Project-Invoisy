"use strict";

// An invoice may carry an optional SECOND customer name (an architect buys for a builder): it is saved in its own
// field, shown on the invoice, searchable on its own, and survives backup and restore. Older invoices have no such
// field and keep working. Tested through the application functions in script.js.
const assert = require("node:assert/strict");
const test = require("node:test");
const { loadProductApi, openDatabase } = require("./helpers");
const { V, sampleInvoice } = require("./helpers/modules");
const { loadApp } = require("./helpers/app");

const plain = (value) => JSON.parse(JSON.stringify(value));

function load() {
  const { api, field } = loadProductApi();
  const tile = api.normalizeProduct({
    id: "t1", name: "Ceramic Tile", sku: "TILE-1", tileSize: "60*60", coveragePerBox: 1.44,
    sellingPrice: 1000, priceUnit: "box", stockUnit: "box", stock: 100,
  });
  api.applyData({ products: [tile], invoices: [], settings: { ...api.DEFAULT_SETTINGS }, counter: 0, lastSaved: "" });
  return { api, field };
}

// Makes and saves one sale the way the app does. `second` is the optional second customer name.
async function sell(api, first, second) {
  api.clearSale();
  assert.equal(api.addToSale("t1", "1", "box").ok, true);
  api.getSale().customer.name = first;
  if (second !== undefined) api.getSale().secondCustomer.name = second;
  await openDatabase(api);
  const result = await api.commit((d) => api.applySale(d, api.getSale()));
  assert.equal(result.error, undefined, result.error);
  return result.invoice;
}

// What the Invoices list shows for a search, as invoice numbers.
function searchResult(app, query) {
  app.field("invoiceFilter").value = query;
  app.api.renderInvoices();
  const html = app.field("invoiceBody").innerHTML;
  return [...html.matchAll(/INV-\d+/g)].map((m) => m[0]).filter((n, i, all) => all.indexOf(n) === i).sort();
}

// The four invoices of the feature request.
async function fourInvoices() {
  const app = load();
  await sell(app.api, "Alex", "Jack");        // INV-000001
  await sell(app.api, "Alex", "Mike");        // INV-000002
  await sell(app.api, "Sarah", "Jack");       // INV-000003
  await sell(app.api, "David");               // INV-000004
  return app;
}
const numbers = (...n) => n.map((x) => "INV-" + String(x).padStart(6, "0"));

/* ---------- Saving ---------- */

test("a sale starts with no second customer, and an invoice with one customer is saved exactly as before", async () => {
  const app = load();
  assert.deepEqual(plain(app.api.getSale().secondCustomer), { name: "" });
  const invoice = await sell(app.api, "Alex");
  assert.equal(invoice.customer.name, "Alex");
  assert.equal("secondCustomer" in invoice, false, "no empty second customer is stored");
  assert.equal(app.api.invoiceHtml(invoice).includes("inv-second-label"), false, "no empty second field on the invoice");
});

test("both names are saved in their own fields on the same invoice", async () => {
  const app = load();
  const invoice = await sell(app.api, "Alex", "Jack");
  assert.equal(invoice.customer.name, "Alex");
  assert.deepEqual(plain(invoice.secondCustomer), { name: "Jack" });
  assert.equal(app.api.getInvoices().length, 1, "two names, one invoice");
  assert.equal(Object.values(invoice.customer).includes("Alex Jack"), false, "the names are never merged");
});

test("a blank or spaces-only second name is not stored, and a second name is trimmed", async () => {
  const app = load();
  assert.equal("secondCustomer" in (await sell(app.api, "Alex", "   ")), false);
  assert.deepEqual(plain((await sell(app.api, "Alex", "  Jack  ")).secondCustomer), { name: "Jack" });
});

test("a second customer can be entered without a first one: the first reads as the walk-in customer", async () => {
  const app = load();
  const invoice = await sell(app.api, "", "Jack");
  assert.equal(invoice.customer.name, "Walk-in Customer");
  assert.equal(invoice.secondCustomer.name, "Jack");
});

test("clearing the sale clears the second name too", async () => {
  const app = load();
  app.api.getSale().secondCustomer.name = "Jack";
  app.field("custName2").value = "Jack";
  app.api.clearSale();
  assert.equal(app.api.getSale().secondCustomer.name, "");
  assert.equal(app.field("custName2").value, "");
});

/* ---------- Display: preview, print, collection document ---------- */

test("with two customers the invoice shows both, labelled; with one it shows only the customer", async () => {
  const app = load();
  const both = app.api.invoiceHtml(await sell(app.api, "Alex", "Jack"));
  assert.match(both, /Customer<\/div><div class="inv-customer">Alex<\/div>/);
  assert.match(both, /Builder \/ Group<\/div><div class="inv-customer">Jack<\/div>/);
  const one = app.api.invoiceHtml(await sell(app.api, "Alex"));
  assert.doesNotMatch(one, /Builder \/ Group/);
  assert.match(one, /<div class="inv-customer">Alex<\/div>/);
});

test("the live preview of the sale shows the second name before the invoice is saved", () => {
  const app = load();
  app.api.addToSale("t1", "1", "box");
  app.api.getSale().customer.name = "Alex";
  app.api.getSale().secondCustomer.name = "Jack";
  const html = app.api.invoiceHtml(app.api.draftInvoice());
  assert.match(html, /Alex/);
  assert.match(html, /Builder \/ Group/);
  assert.match(html, /Jack/);
});

test("names are escaped on the invoice", async () => {
  const app = load();
  const html = app.api.invoiceHtml(await sell(app.api, "A <b>", "<script>x</script>"));
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("the French invoice uses the French label", async () => {
  const app = load();
  const invoice = await sell(app.api, "Alex", "Jack");
  app.api.applyData({ products: [], invoices: [invoice], settings: { ...app.api.DEFAULT_SETTINGS, language: "fr" }, counter: 1, lastSaved: "" });
  assert.match(app.api.invoiceHtml(invoice), /Constructeur \/ Groupe/);
});

test("the 'remaining goods' collection document shows the second name as well", async () => {
  const app = load();
  app.api.clearSale();
  app.api.addToSale("t1", "1", "box");
  const line = app.api.getSale().items[0];
  app.api.setSalePartial(line.lineId, true);
  app.api.updateSaleQuantity(line.lineId, "150");   // more than the stock of 100: the rest is collected later
  app.api.getSale().customer.name = "Alex";
  app.api.getSale().secondCustomer.name = "Jack";
  await openDatabase(app.api);
  const result = await app.api.commit((d) => app.api.applySale(d, app.api.getSale()));
  assert.equal(result.error, undefined, result.error);
  const html = app.api.collectionHtml(result.invoice);
  assert.match(html, /Alex/);
  assert.match(html, /Builder \/ Group/);
  assert.match(html, /Jack/);
});

/* ---------- Search ---------- */

test("search finds invoices by either customer name, whichever field holds it", async () => {
  const app = await fourInvoices();
  assert.deepEqual(searchResult(app, "Alex"), numbers(1, 2));
  assert.deepEqual(searchResult(app, "Jack"), numbers(1, 3));
  assert.deepEqual(searchResult(app, "Mike"), numbers(2));
  assert.deepEqual(searchResult(app, "David"), numbers(4));
  assert.deepEqual(searchResult(app, "Sarah"), numbers(3));
});

test("search ignores case, accepts part of a name, and still finds by invoice number", async () => {
  const app = await fourInvoices();
  assert.deepEqual(searchResult(app, "jACK"), numbers(1, 3));
  assert.deepEqual(searchResult(app, "ik"), numbers(2));
  assert.deepEqual(searchResult(app, "INV-000004"), numbers(4));
  assert.deepEqual(searchResult(app, ""), numbers(1, 2, 3, 4), "an empty search lists everything");
  assert.deepEqual(searchResult(app, "Nobody"), []);
});

test("an invoice is listed once when the same name is in both fields", async () => {
  const app = load();
  await sell(app.api, "Alex", "Alex");
  app.field("invoiceFilter").value = "Alex";
  app.api.renderInvoices();
  assert.equal((app.field("invoiceBody").innerHTML.match(/data-id=/g) || []).length, 1);
});

test("search by phone still works, and the second name shows under the first in the list", async () => {
  const app = load();
  app.api.clearSale();
  app.api.addToSale("t1", "1", "box");
  app.api.getSale().customer.name = "Alex";
  app.api.getSale().customer.phone = "0555 12 34 56";
  app.api.getSale().secondCustomer.name = "Jack";
  await openDatabase(app.api);
  assert.equal((await app.api.commit((d) => app.api.applySale(d, app.api.getSale()))).error, undefined);
  assert.deepEqual(searchResult(app, "0555123456"), numbers(1));
  assert.match(app.field("invoiceBody").innerHTML, /Alex<div class="muted small">Jack<\/div>/);
});

/* ---------- Older data ---------- */

test("an invoice saved before this feature (no second customer) is valid, shows as before and is found by its customer", () => {
  const app = load();
  const old = sampleInvoice({ number: 7, customer: { name: "Sarah", phone: "", address: "" } });
  assert.equal("secondCustomer" in old, false);
  assert.equal(V.invoiceProblem(old), "");
  assert.doesNotMatch(app.api.invoiceHtml(old), /Builder \/ Group/);
  app.api.applyData({ products: [], invoices: [old], settings: { ...app.api.DEFAULT_SETTINGS }, counter: 7, lastSaved: "" });
  assert.deepEqual(searchResult(app, "Sarah"), numbers(7));
  assert.deepEqual(searchResult(app, "Jack"), []);
});

test("a malformed second customer is refused by validation", () => {
  for (const bad of ["Jack", 5, null, [], { name: 5 }, {}]) {
    assert.notEqual(V.invoiceProblem(sampleInvoice({ secondCustomer: bad })), "", JSON.stringify(bad));
  }
  assert.equal(V.invoiceProblem(sampleInvoice({ secondCustomer: { name: "Jack" } })), "");
});

test("the second name does not change who the customer is for carried-forward debt", () => {
  const a = sampleInvoice({ number: 1, customer: { name: "Alex", phone: "", address: "" }, secondCustomer: { name: "Jack" } });
  const b = sampleInvoice({ number: 2, customer: { name: "Alex", phone: "", address: "" }, secondCustomer: { name: "Mike" } });
  const c = sampleInvoice({ number: 3, customer: { name: "Sarah", phone: "", address: "" }, secondCustomer: { name: "Jack" } });
  assert.equal(V.sameCustomer(a, b, V.customerGroups([a, b, c])), true, "same architect, different builders: same debtor");
  assert.equal(V.sameCustomer(a, c, V.customerGroups([a, b, c])), false, "same builder, different architects: not the same debtor");
});

/* ---------- Backup and restore ---------- */

test("a backup file keeps both names and restoring it brings both back", async () => {
  const app = load();
  await sell(app.api, "Alex", "Jack");
  await sell(app.api, "David");
  const data = await app.api.db.loadAll();
  const file = V.prepareBackupFile(data, new Date());
  assert.match(file.text, /"secondCustomer"/);
  const parsed = V.parseBackup(file.text);
  assert.equal(parsed.error, undefined, parsed.error);
  const [first, second] = parsed.data.invoices;
  assert.equal(first.customer.name, "Alex");
  assert.equal(first.secondCustomer.name, "Jack");
  assert.equal("secondCustomer" in second, false);
});

test("Import / Restore in the running app puts both names back and search finds them", async () => {
  const source = load();
  await sell(source.api, "Alex", "Jack");
  await sell(source.api, "Sarah", "Jack");
  const file = V.prepareBackupFile(await source.api.db.loadAll(), new Date());

  const target = loadApp();
  const storage = await target.start();
  assert.equal(storage.mode, "ready", storage.reason);
  target.answer(true);
  await target.api.importBackup(target.file(file.text));
  assert.equal(target.api.getInvoices().length, 2);
  assert.deepEqual(plain(target.api.getInvoices().map((i) => i.secondCustomer)), [{ name: "Jack" }, { name: "Jack" }]);
  const stored = await target.api.db.loadAll();
  assert.deepEqual(plain(stored.invoices.map((i) => i.secondCustomer && i.secondCustomer.name)), ["Jack", "Jack"]);
  assert.deepEqual(searchResult(target, "Jack"), numbers(1, 2));
  assert.deepEqual(searchResult(target, "Sarah"), numbers(2));
});

test("recording a payment on an invoice keeps its second customer", async () => {
  const app = load();
  const invoice = await sell(app.api, "Alex", "Jack");
  const paid = await app.api.addPayment(invoice.id, 500);
  assert.equal(paid.error, undefined, paid.error);
  assert.equal(app.api.getInvoices()[0].secondCustomer.name, "Jack");
});

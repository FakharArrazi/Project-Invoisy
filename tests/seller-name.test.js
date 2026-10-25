"use strict";

// "Nom du vendeur": the name of the person handling the sales, typed in the box in the page header and kept with the Save button
// next to it. It is a SETTING (kept until it is changed: across sales, page reloads and closing the app), copied onto each invoice when the invoice is made (so changing it never rewrites the history),
// and printed in the middle of the footer of every page. Tested through the application functions in script.js; the printed
// footer's geometry (centred on the sheet, long names, page numbers) is checked in a real browser: tests/e2e/seller_name_check.py.
const assert = require("node:assert/strict");
const test = require("node:test");
const { loadApp } = require("./helpers/app");
const { V, sampleProduct, sampleInvoice } = require("./helpers/modules");

const plain = (value) => JSON.parse(JSON.stringify(value));

// One page load. Pass the previous load's `indexedDB` to open the same data again (closing the app and opening it again).
async function load(indexedDB) {
  const app = loadApp(indexedDB ? { indexedDB } : {});
  const storage = await app.start();
  assert.equal(storage.mode, "ready", storage.reason);
  return app;
}

async function addTile(app) {
  const { id, ...values } = sampleProduct({ name: "Everton Grey", tileSize: "60*60", coveragePerBox: 1.44, sku: "EV-60", sellingPrice: 800, priceUnit: "m2", purchasePrice: 600, stock: 100 });
  await app.api.addProduct(values);
  return app.api.getState().products[0];
}

// Types a seller name into the box and presses Save, the way the page does: typing only readies the button, Save keeps the name.
async function typeSeller(app, name) {
  app.field("sellerName").value = name;
  app.api.onSellerInput();
  await app.api.submitSellerName();
}

// Completes a sale of one box with the seller that is on the page now.
async function sell(app, tile, customer) {
  assert.equal(app.api.addToSale(tile.id, "1", "box").ok, true);
  app.api.getSale().customer.name = customer;
  await app.api.completeSale();
  const all = app.api.getInvoices();
  return all[all.length - 1];
}

const sellerOf = (invoice) => (invoice.sellerName === undefined ? null : invoice.sellerName);

/* ---------- The setting ---------- */

test("a new installation has no seller name, and older saved settings (without the field) read as empty", () => {
  assert.equal(V.DEFAULT_SETTINGS.sellerName, "");
  const old = { businessName: "Hedjazi", address: "", phone: "", email: "", currency: "DA", logo: "", paper: "A4", language: "en" };
  assert.equal(V.normalizeSettings(old).sellerName, "");
  assert.equal(V.settingsProblem(old), "", "an old settings record is still valid");
});

test("the seller name is kept as written, and a wrong kind of value is refused", () => {
  assert.equal(V.normalizeSettings({ sellerName: "John" }).sellerName, "John");
  assert.equal(V.normalizeSettings({ sellerName: 42 }).sellerName, "", "a number is not a name");
  assert.equal(V.settingsProblem({ ...V.DEFAULT_SETTINGS, sellerName: "John" }), "");
  assert.notEqual(V.settingsProblem({ ...V.DEFAULT_SETTINGS, sellerName: 42 }), "");
});

test("an invoice may carry a seller name; a missing one is fine, a wrong kind is refused", () => {
  assert.equal(V.invoiceProblem(sampleInvoice({ sellerName: "John" })), "");
  assert.equal(V.invoiceProblem(sampleInvoice()), "", "older invoices have none");
  for (const bad of [5, null, [], {}, true]) assert.notEqual(V.invoiceProblem(sampleInvoice({ sellerName: bad })), "", JSON.stringify(bad));
});

/* ---------- John, then Jack ---------- */

test("John -> saved invoice -> next sale still says John -> closed and opened again -> still John -> Jack from then on", async () => {
  const first = await load();
  const tile = await addTile(first);
  assert.equal(first.field("sellerName").value, "", "starts empty");

  await typeSeller(first, "John");
  const one = await sell(first, tile, "Alice");
  assert.equal(sellerOf(one), "John", "the invoice is saved with John");
  assert.equal(first.api.getSale().sellerName, "John", "the next sale still says John");
  assert.equal(first.field("sellerName").value, "John", "and so does the box");

  first.api.clearSale();
  assert.equal(first.api.getSale().sellerName, "John", "Clear (starting over) keeps the seller too");

  // closing the app and opening it again: the same database, a brand new page
  const second = await load(first.indexedDB);
  assert.equal((await second.api.db.loadAll()).settings.sellerName, "John", "it is in the saved settings, not in the page");
  assert.equal(second.api.getSale().sellerName, "John", "the new page's sale starts with John");
  assert.equal(second.field("sellerName").value, "John", "and so does its box");

  // later: Jack
  await typeSeller(second, "Jack");
  const two = await sell(second, second.api.getState().products[0], "Bob");
  assert.equal(sellerOf(two), "Jack", "future invoices use Jack");
  const third = await sell(second, second.api.getState().products[0], "Carol");
  assert.equal(sellerOf(third), "Jack", "...until it is changed again");

  const saved = (await second.api.db.loadAll()).invoices;
  assert.deepEqual(plain(saved.map(sellerOf)), ["John", "Jack", "Jack"], "the invoice made under John was not rewritten");
  assert.equal(sellerOf(second.api.getInvoices()[0]), "John");
});

test("the name is saved with the sale that used it, even if the box was never left (typed, then Complete Sale at once)", async () => {
  const app = await load();
  const tile = await addTile(app);
  app.api.getSale().sellerName = "Jack";   // typed; the save that follows typing has not happened
  const invoice = await sell(app, tile, "Alice");
  assert.equal(sellerOf(invoice), "Jack");
  assert.equal((await app.api.db.loadAll()).settings.sellerName, "Jack", "and it is kept for the next sale");
});

test("an empty name: nothing is printed, nothing is invented, and the empty name is kept", async () => {
  const app = await load();
  const tile = await addTile(app);
  await typeSeller(app, "John");
  await typeSeller(app, "");
  assert.equal((await app.api.db.loadAll()).settings.sellerName, "", "clearing the box is kept");
  const invoice = await sell(app, tile, "Alice");
  assert.equal("sellerName" in invoice, false, "an invoice made without a seller has no seller field (the shape older invoices have)");
  assert.equal(V.invoiceProblem(invoice), "");
  const footer = app.api.invoiceFooterHtml(invoice, 1, 1);
  assert.match(footer, /<span class="foot-seller"[^>]*><\/span>/, "the middle of the footer is empty");
  const visible = footer.replace(/<[^>]*>/g, " ");   // the words a reader sees, not the class names
  assert.doesNotMatch(visible, /undefined|null|seller|vendeur|n\/a|-{2,}/i, "no placeholder text");
});

test("spaces are tidied, and a name of only spaces is no name", async () => {
  const app = await load();
  const tile = await addTile(app);
  await typeSeller(app, "  Jack    Daniels ");
  assert.equal((await app.api.db.loadAll()).settings.sellerName, "Jack Daniels");
  assert.equal(sellerOf(await sell(app, tile, "Alice")), "Jack Daniels");
  await typeSeller(app, "     ");
  assert.equal((await app.api.db.loadAll()).settings.sellerName, "");
  assert.equal(sellerOf(await sell(app, tile, "Bob")), null);
});

test("saving the same name again changes nothing (no needless write)", async () => {
  const app = await load();
  await typeSeller(app, "John");
  const before = (await app.api.db.loadAll()).revision;
  await typeSeller(app, "John");
  assert.equal((await app.api.db.loadAll()).revision, before, "the database was not touched");
});

/* ---------- Typing, then Save ---------- */

test("typing changes nothing until Save: not the sale, not the preview, not the saved setting; only the button gets ready", async () => {
  const app = await load();
  await typeSeller(app, "John");
  const before = (await app.api.db.loadAll()).revision;
  const button = app.field("sellerSave");
  assert.equal(button.disabled, true, "nothing to save: the button is quiet");
  assert.equal(button.textContent, "Saved");

  for (const typed of ["J", "Ja", "Jac", "Jack"]) {   // letter after letter, as a person types
    app.field("sellerName").value = typed;
    app.api.onSellerInput();
    assert.equal(app.api.getSale().sellerName, "John", `after "${typed}" the sale still says John (no redraw of the preview)`);
  }
  assert.equal((await app.api.db.loadAll()).revision, before, "and nothing was written to the database");
  assert.equal(button.disabled, false, "the button is ready");
  assert.equal(button.textContent, "Save");
  assert.equal(button.classList.contains("primary"), true, "and looks like the main button");

  await app.api.submitSellerName();   // the person presses Save
  assert.equal(app.api.getSale().sellerName, "Jack", "now the sale says Jack");
  assert.equal(app.api.sellerNameOf(app.api.draftInvoice()), "Jack", "so does the preview");
  assert.equal((await app.api.db.loadAll()).settings.sellerName, "Jack", "and it is kept");
  assert.equal(button.disabled, true, "the button is quiet again");
  assert.equal(button.textContent, "Saved");
  assert.equal(button.classList.contains("primary"), false);
});

test("typing the saved name back leaves nothing to save; spaces alone do not count as a change", async () => {
  const app = await load();
  await typeSeller(app, "John");
  app.field("sellerName").value = "Johnny";
  app.api.onSellerInput();
  assert.equal(app.field("sellerSave").disabled, false);
  app.field("sellerName").value = "  John ";
  app.api.onSellerInput();
  assert.equal(app.field("sellerSave").disabled, true, "the same name once the spaces are tidied");
});

test("a name that is typed and not saved is neither lost by starting another sale nor printed on the invoice", async () => {
  const app = await load();
  const tile = await addTile(app);
  await typeSeller(app, "John");
  app.field("sellerName").value = "Jack";
  app.api.onSellerInput();

  app.api.renderSellerName();   // the page is drawn again (another change, a new sale, a language change...)
  assert.equal(app.field("sellerName").value, "Jack", "what was typed is still in the box");
  assert.equal(app.field("sellerSave").disabled, false, "still waiting for Save");

  const invoice = await sell(app, tile, "Alice");
  assert.equal(sellerOf(invoice), "John", "an invoice only gets a name that was saved, what the preview showed");
  assert.equal(app.field("sellerName").value, "Jack", "the typed name is still waiting after the sale");
  assert.equal((await app.api.db.loadAll()).settings.sellerName, "John");
});

test("Save with an empty box clears the seller", async () => {
  const app = await load();
  await typeSeller(app, "John");
  app.field("sellerName").value = "";
  app.api.onSellerInput();
  assert.equal(app.field("sellerSave").disabled, false, "removing the name is a change too");
  await app.api.submitSellerName();
  assert.equal((await app.api.db.loadAll()).settings.sellerName, "");
  assert.equal(app.api.sellerNameOf(app.api.draftInvoice()), "");
});

/* ---------- The live preview follows the saved name ---------- */

test("the preview of the sale prints the name before the invoice is saved", async () => {
  const app = await load();
  const tile = await addTile(app);
  assert.equal(app.api.addToSale(tile.id, "1", "box").ok, true);
  app.api.getSale().sellerName = "John";
  assert.equal(app.api.sellerNameOf(app.api.draftInvoice()), "John");
  app.api.getSale().sellerName = "";
  assert.equal(app.api.sellerNameOf(app.api.draftInvoice()), "");
});

/* ---------- The footer ---------- */

test("the footer holds the invoice number, the seller and the page number, in that order, always as three parts", () => {
  const app = loadApp();
  const invoice = sampleInvoice({ number: 18, sellerName: "John" });
  const footer = app.api.invoiceFooterHtml(invoice, 2, 3);
  const parts = [...footer.matchAll(/<span class="(foot-[a-z]+)"[^>]*>([^<]*)<\/span>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(parts, [["foot-number", "INV-000018"], ["foot-seller", "John"], ["foot-page", "Page 2 of 3"]]);
  const without = app.api.invoiceFooterHtml(sampleInvoice({ number: 18 }), 1, 1);
  assert.deepEqual([...without.matchAll(/<span class="(foot-[a-z]+)"/g)].map((m) => m[1]), ["foot-number", "foot-seller", "foot-page"], "an empty seller keeps its (empty) place, so the other two stay where they are");
});

test("the page numbering keeps its wording in every language, and the name is escaped", async () => {
  const app = await load();
  const invoice = sampleInvoice({ number: 4, sellerName: "<b>Jo</b> & \"Co\"" });
  const footer = app.api.invoiceFooterHtml(invoice, 1, 2);
  assert.doesNotMatch(footer, /<b>/);
  assert.match(footer, /&lt;b&gt;Jo&lt;\/b&gt; &amp; &quot;Co&quot;/);
  assert.match(footer, /dir="auto"/, "a name in another script reads in its own direction");
  await app.api.saveLanguage("fr");
  assert.match(app.api.invoiceFooterHtml(invoice, 1, 2), /Page 1 sur 2/);
  await app.api.saveLanguage("ar");
  assert.match(app.api.invoiceFooterHtml(invoice, 1, 2), /صفحة 1 من 2/);
});

test("the plain invoice markup (preview fallback, tests, collection documents) is unchanged: the seller belongs to the footer only", () => {
  const app = loadApp();
  const html = app.api.invoiceHtml(sampleInvoice({ number: 3, sellerName: "John" }));
  assert.doesNotMatch(html, /John/);
});

/* ---------- Editing a saved invoice ---------- */

test("editing a saved invoice shows its own seller, locks the box and never touches the saved setting", async () => {
  const app = await load();
  const tile = await addTile(app);
  await typeSeller(app, "John");
  const john = await sell(app, tile, "Alice");
  await typeSeller(app, "Jack");

  assert.deepEqual(plain(app.api.startEditInvoice(john.id)), {});
  assert.equal(app.api.getSale().sellerName, "John", "the edit shows the invoice's seller");
  assert.equal(app.field("sellerName").value, "John");
  assert.equal(app.field("sellerName").disabled, true, "and the box can not be typed in");
  assert.equal(app.field("sellerSave").disabled, true, "nor saved");
  assert.equal(app.field("sellerLocked").hidden, false, "with a note that says why");
  assert.equal(app.api.sellerNameOf(app.api.editPreviewInvoice()), "John", "the preview of the edit prints John");

  app.field("sellerName").value = "Mallory";   // even if something tried
  await app.api.submitSellerName();
  assert.equal((await app.api.db.loadAll()).settings.sellerName, "Jack", "the saved setting is untouched while an invoice is edited");

  app.api.cancelInvoiceEdit();
  assert.equal(app.field("sellerName").disabled, false, "after the edit the box works again");
  assert.equal(app.field("sellerSave").disabled, true, "with nothing to save");
  app.api.renderSellerName();
  assert.equal(app.api.getSale().sellerName, "Jack", "and the sale on the page is back to the saved name");
  assert.equal(sellerOf(app.api.getInvoices()[0]), "John", "the invoice itself was not changed");
});

test("saving an edit keeps the invoice's own seller, whatever the setting is now", async () => {
  const app = await load();
  const tile = await addTile(app);
  await typeSeller(app, "John");
  const john = await sell(app, tile, "Alice");
  await typeSeller(app, "Jack");
  assert.deepEqual(plain(app.api.startEditInvoice(john.id)), {});
  app.api.getSale().customer.name = "Alice B.";
  await app.api.saveInvoiceEdit();
  const saved = app.api.getInvoices().find((i) => i.id === john.id);
  assert.equal(saved.customer.name, "Alice B.", "the edit was saved");
  assert.equal(sellerOf(saved), "John", "and the invoice is still John's");
});

/* ---------- Backup and restore ---------- */

test("a backup keeps the setting and each invoice's seller, and restoring brings them back", async () => {
  const source = await load();
  const tile = await addTile(source);
  await typeSeller(source, "John");
  await sell(source, tile, "Alice");
  await typeSeller(source, "Jack");
  await sell(source, tile, "Bob");
  const file = V.prepareBackupFile(await source.api.db.loadAll(), new Date());
  assert.match(file.text, /"sellerName"/);

  const target = await load();
  target.answer(true);
  await target.api.importBackup(target.file(file.text));
  assert.deepEqual(plain(target.api.getInvoices().map(sellerOf)), ["John", "Jack"]);
  assert.equal((await target.api.db.loadAll()).settings.sellerName, "Jack");
  assert.equal(target.api.getSale().sellerName, "Jack", "the box shows the restored name");
});

test("a backup made before this feature restores with an empty seller", async () => {
  const source = await load();
  const tile = await addTile(source);
  await sell(source, tile, "Alice");
  const data = plain(await source.api.db.loadAll());
  delete data.settings.sellerName;
  const file = V.prepareBackupFile(data, new Date());
  assert.doesNotMatch(file.text, /"sellerName"/);
  const target = await load();
  target.answer(true);
  await target.api.importBackup(target.file(file.text));
  assert.equal(target.api.getInvoices().length, 1);
  assert.equal(target.api.getState().settings.sellerName, "");
  assert.equal(target.api.getSale().sellerName, "");
});

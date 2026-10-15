"use strict";

// The optional Product type (None / Daltosol / Faience / Porcelain / Rock): the Stock form field, saving and editing it,
// backups, products and invoices saved before the field existed, and the text printed on the invoice.

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./helpers/app");
const { fillProductForm } = require("./helpers");

const TYPES = ["Daltosol", "Faience", "Porcelain", "Rock"];
const plain = (value) => JSON.parse(JSON.stringify(value));   // the app runs in its own context: compare plain data

async function startedApp(options) {
  const app = loadApp(options);
  const storage = await app.start();
  assert.equal(storage.mode, "ready", storage.reason);
  return app;
}

// The Stock form filled like a person would; returns what readProductForm() made of it.
const form = (app, extra) => fillProductForm(app, {
  pName: "ACRA Beige", pTileSize: "45*45", pCoveragePerBox: "1.44", pStock: "10", pStockUnit: "box",
  priceRows: [{ unit: "m2", price: "1000" }], ...extra,
});

// Saves a product through the Stock form and returns it as the app holds it.
async function addViaForm(app, extra) {
  const read = form(app, extra);
  assert.equal(read.error, undefined, read.error);
  await app.api.addProduct(read.values);
  return app.api.getProducts().find((p) => p.name === (extra && extra.pName ? extra.pName : "ACRA Beige"));
}

// Switches the language the app is shown in, the way the Settings language picker does.
function setLang(app, code) {
  app.api.getState().settings.language = code;
  app.api.applyData({ ...app.api.getState() });
}

const legacyProduct = (overrides) => ({
  id: "old-1", name: "ROZALIA Marfil", manufacturer: "", tileSize: "30*90", coveragePerBox: 1.62, description: "", sku: "ROZ",
  category: "", sellingPrice: 1200, priceUnit: "m2", stockUnit: "box", purchasePrice: null, stock: 8, ...overrides,
});

/* ---------- The form field ---------- */

test("the Stock form has a Product type dropdown: None (default), Daltosol, Faience, Porcelain, Rock, and it is optional", () => {
  const html = loadApp().api.stockForm.html();
  const select = html.match(/<select id="pType">([^]*?)<\/select>/);
  assert.ok(select, "a select with the id pType");
  const options = [...select[1].matchAll(/<option value="([^"]*)"([^>]*)>([^<]*)<\/option>/g)].map((m) => ({ value: m[1], selected: /selected/.test(m[2]), text: m[3] }));
  assert.deepEqual(options.map((o) => o.value), ["", ...TYPES]);
  assert.deepEqual(options.map((o) => o.text), ["None", ...TYPES]);
  assert.deepEqual(options.filter((o) => o.selected).map((o) => o.value), [""], "None is the default");
  assert.match(html, /<label for="pType" data-i18n="stock\.productType">Product type<\/label>/);
  assert.doesNotMatch(html, /id="pType"[^>]*(aria-required|required)/, "not mandatory");
  assert.doesNotMatch(html.match(/<label for="pType"[^]*?<\/label>/)[0], /class="req"/, "no asterisk");
  assert.ok(html.indexOf('id="pName"') < html.indexOf('id="pType"') && html.indexOf('id="pType"') < html.indexOf('id="pManufacturer"'), "right after the product name");
});

test("the form reads the type; a blank (None) choice saves an empty type; an unknown value is refused", () => {
  const app = loadApp();
  assert.equal(form(app).values.productType, "", "None by default");
  for (const type of TYPES) assert.equal(form(app, { pType: type }).values.productType, type);
  assert.equal(form(app, { pType: "" }).values.productType, "");
  const bad = form(app, { pType: "Marble" });
  assert.equal(bad.field, "pType");
  assert.match(bad.error, /product type/i);
});

test("choosing a type changes nothing else the form reads (prices, stock, calculations)", () => {
  const app = loadApp();
  const { productType: none, ...withoutType } = form(app).values;
  const { productType: typed, ...withType } = form(app, { pType: "Faience" }).values;
  assert.equal(none, "");
  assert.equal(typed, "Faience");
  assert.deepEqual(plain(withType), plain(withoutType));
});

test("the dropdown shows a saved product's type, and None for a product saved before the field existed", () => {
  const { api } = loadApp();
  const raw = api.ProductForm.toRaw;
  assert.equal(raw({ ...legacyProduct(), productType: "Rock" }).productType, "Rock");
  assert.equal(raw(legacyProduct()).productType, "");
  assert.equal(raw(null).productType, "");
  assert.match(api.ProductForm.create({ prefix: "x-", holder: {} }).html({ ...legacyProduct(), productType: "Faience" }), /<option value="Faience" selected data-i18n="productType\.Faience">Faience<\/option>/);
});

/* ---------- Saving, editing, reloading ---------- */

test("the type is saved with the product, kept when editing, changed or cleared, and still there after a reload", async () => {
  const app = await startedApp();
  const saved = await addViaForm(app, { pType: "Daltosol" });
  assert.equal(saved.productType, "Daltosol");
  assert.equal(app.field("pType").value, "", "the form goes back to None after saving");

  // Edit opens the saved type in the dropdown; saving again without touching it keeps it.
  app.api.startEditProduct(saved.id);
  assert.equal(app.field("pType").value, "Daltosol");
  let read = app.api.readProductForm();
  assert.equal(read.values.productType, "Daltosol");
  await app.api.updateProduct(saved.id, read.values);
  assert.equal(app.api.getProducts()[0].productType, "Daltosol");

  // Changed to another type, then cleared.
  app.api.startEditProduct(saved.id);
  app.field("pType").value = "Faience";
  await app.api.updateProduct(saved.id, app.api.readProductForm().values);
  assert.equal(app.api.getProducts()[0].productType, "Faience");
  app.api.startEditProduct(saved.id);
  app.field("pType").value = "";
  await app.api.updateProduct(saved.id, app.api.readProductForm().values);
  assert.equal(app.api.getProducts()[0].productType, "");

  // Saved in IndexedDB: a second copy of the app on the same database reads it back.
  app.api.startEditProduct(saved.id);
  app.field("pType").value = "Porcelain";
  await app.api.updateProduct(saved.id, app.api.readProductForm().values);
  const again = await startedApp({ indexedDB: app.indexedDB });
  assert.equal(again.api.getProducts().length, 1);
  assert.equal(again.api.getProducts()[0].productType, "Porcelain");
  assert.equal(again.api.getProducts()[0].stock, 10, "stock is untouched");
});

test("a product saved before the field existed loads, shows None, and saves without gaining a type", async () => {
  const app = await startedApp();
  await app.api.db.initDatabase();
  await app.api.db.commitChanges({ products: { put: [legacyProduct()], remove: [] } });   // stored exactly as an older version saved it
  const again = await startedApp({ indexedDB: app.indexedDB });
  const [product] = again.api.getProducts();
  assert.equal(product.name, "ROZALIA Marfil");
  assert.equal(product.productType, undefined, "nothing is added behind the person's back");

  again.api.startEditProduct(product.id);
  assert.equal(again.field("pType").value, "", "None");
  const read = again.api.readProductForm();
  assert.equal(read.error, undefined);
  assert.equal(read.values.productType, "");
  await again.api.updateProduct(product.id, read.values);
  assert.equal(again.api.getProducts()[0].sellingPrice, 1200);
  assert.equal(again.api.getProducts()[0].stock, 8);
});

test("a product made while recording a purchase can carry a type too", () => {
  const { api } = loadApp();
  const raw = { name: "ACRA Beige", productType: "Daltosol", tileSize: "45*45", coveragePerBox: "1.44", stockUnit: "box", prices: [{ unit: "m2", price: "1000" }] };
  const made = api.Validation.readProductInput(raw, { products: [], stockFromPurchase: true });
  assert.equal(made.error, undefined);
  assert.equal(made.values.productType, "Daltosol");
  assert.equal(api.Validation.readProductInput({ ...raw, productType: "Granite" }, { products: [], stockFromPurchase: true }).field, "productType");
  assert.equal(api.Validation.readProductInput({ ...raw, productType: undefined }, { products: [], stockFromPurchase: true }).values.productType, "", "left out = None");
});

/* ---------- Backups ---------- */

test("Export Backup / Import keep the type of every product, and a backup from before the field still imports", async () => {
  const app = await startedApp();
  await addViaForm(app, { pName: "ACRA Beige", pType: "Daltosol" });
  await addViaForm(app, { pName: "ROZALIA Marfil", pTileSize: "30*90", pType: "Faience" });
  await addViaForm(app, { pName: "Plain Tile" });
  await app.api.exportBackup();
  const text = await app.downloadedText();
  const exported = JSON.parse(text).data.products;
  assert.deepEqual(exported.map((p) => [p.name, p.productType]).sort(), [["ACRA Beige", "Daltosol"], ["Plain Tile", ""], ["ROZALIA Marfil", "Faience"]]);

  const other = await startedApp();
  await other.api.importBackup(other.file(text));
  const types = Object.fromEntries(other.api.getProducts().map((p) => [p.name, p.productType]));
  assert.deepEqual(plain(types), { "ACRA Beige": "Daltosol", "ROZALIA Marfil": "Faience", "Plain Tile": "" });

  // An old backup: its products have no productType at all.
  const old = JSON.parse(text);
  old.data.products = old.data.products.map(({ productType, ...rest }) => rest);
  const third = await startedApp();
  await third.api.importBackup(third.file(JSON.stringify(old)));
  assert.equal(third.api.getProducts().length, 3, "every product of the old backup was imported");
  assert.ok(third.api.getProducts().every((p) => p.productType === ""), "and they default to None");
});

test("a backup with an unknown product type is refused instead of printing it on invoices", () => {
  const { api } = loadApp();
  assert.equal(api.Validation.productProblem({ ...legacyProduct(), productType: "Granite" }) !== "", true);
  for (const ok of [undefined, "", ...TYPES]) assert.equal(api.Validation.productProblem({ ...legacyProduct(), productType: ok }), "", String(ok));
});

/* ---------- Invoices ---------- */

test("the invoice line shows the type on its own line under the name, and nothing extra when there is none", () => {
  const { api } = loadApp();
  // the name label no longer carries the type: no prefix, no suffix
  assert.equal(api.invoiceItemLabel({ name: "ACRA Beige", tileSize: "45*45", manufacturer: "", productType: "Daltosol" }), "ACRA Beige (45 × 45)");
  assert.equal(api.invoiceItemLabel({ name: "Marfil", tileSize: "", manufacturer: "Vega", productType: "Porcelain" }), "Marfil Vega");
  assert.equal(api.invoiceItemTypeHtml({ productType: "Daltosol" }), '<div class="inv-sub">Daltosol</div>');
  assert.equal(api.invoiceItemTypeHtml({ productType: "Faience" }), '<div class="inv-sub">Faience</div>');
  assert.equal(api.invoiceItemTypeHtml({ productType: "Porcelain" }), '<div class="inv-sub">Porcelain</div>');
  assert.equal(api.invoiceItemTypeHtml({ productType: "Rock" }), '<div class="inv-sub">Rock</div>');
  for (const none of ["", undefined, null, "   "]) assert.equal(api.invoiceItemTypeHtml({ productType: none }), "", "no type: no empty line, no placeholder");
  assert.equal(api.invoiceItemLabel({ name: "(deleted product)", tileSize: "", manufacturer: "", productType: "" }), "(deleted product)");
});

// Sells 2 boxes of each product; returns { api, invoice } with the invoice saved by the app's own sale code.
async function sell(app, products) {
  for (const p of products) assert.equal(app.api.addToSale(p.id, "2", "box").ok, true);
  const result = await app.api.commit((d) => app.api.applySale(d, app.api.getSale()));
  assert.equal(result.error, undefined, result.error);
  return result.invoice;
}

test("the live preview, the saved invoice and the printed invoice all show the type; the type is kept on the saved line", async () => {
  const app = await startedApp();
  const daldosol = await addViaForm(app, { pName: "ACRA Beige", pTileSize: "45*45", pType: "Daltosol" });
  const faience = await addViaForm(app, { pName: "ROZALIA Marfil", pTileSize: "30*90", pType: "Faience" });
  const plainTile = await addViaForm(app, { pName: "ROZALIA Marfil Decor", pTileSize: "30*90" });
  for (const p of [daldosol, faience, plainTile]) assert.equal(app.api.addToSale(p.id, "2", "box").ok, true);

  const preview = app.api.invoiceHtml(app.api.draftInvoice());   // what the page shows while the sale is being made
  assert.match(preview, /<td>ACRA Beige \(45 × 45\)<div class="inv-sub">Daltosol<\/div><\/td>/);
  assert.match(preview, /<td>ROZALIA Marfil \(30 × 90\)<div class="inv-sub">Faience<\/div><\/td>/);
  assert.match(preview, /<td>ROZALIA Marfil Decor \(30 × 90\)<\/td>/, "no type: only the name, no empty line");
  assert.doesNotMatch(preview, /None|—/);

  const result = await app.api.commit((d) => app.api.applySale(d, app.api.getSale()));
  assert.equal(result.error, undefined, result.error);
  const invoice = result.invoice;
  assert.deepEqual(plain(invoice.items.map((i) => i.productType)), ["Daltosol", "Faience", ""], "kept on each saved line");

  // The saved invoice is what viewing, printing and the PDF use (window.print() prints this same markup).
  const saved = app.api.getInvoices().find((i) => i.invoiceNumber === invoice.invoiceNumber);
  const html = app.api.invoiceHtml(saved);
  assert.match(html, /<td>ACRA Beige \(45 × 45\)<div class="inv-sub">Daltosol<\/div><\/td>/);
  assert.match(html, /<td>ROZALIA Marfil \(30 × 90\)<div class="inv-sub">Faience<\/div><\/td>/);
  assert.match(html, /<td>ROZALIA Marfil Decor \(30 × 90\)<\/td>/);
  assert.doesNotMatch(html, /Daltosol — |— ACRA/, "the type is never before the name");
});

test("a saved invoice keeps the type it was sold with, even if the product's type is changed or removed later", async () => {
  const app = await startedApp();
  const product = await addViaForm(app, { pName: "ACRA Beige", pType: "Daltosol" });
  const invoice = await sell(app, [product]);
  app.api.startEditProduct(product.id);
  app.field("pType").value = "Faience";
  await app.api.updateProduct(product.id, app.api.readProductForm().values);
  assert.equal(app.api.getProducts()[0].productType, "Faience");
  const saved = app.api.getInvoices().find((i) => i.invoiceNumber === invoice.invoiceNumber);
  assert.match(app.api.invoiceHtml(saved), /<td>ACRA Beige \(45 × 45\)<div class="inv-sub">Daltosol<\/div><\/td>/);
  assert.doesNotMatch(app.api.invoiceHtml(saved), /Faience/);

  // A new sale of the same product uses the product's current type.
  const next = await sell(app, [app.api.getProducts()[0]]);
  assert.equal(next.items[0].productType, "Faience");

  // The type also survives a backup of the invoices.
  await app.api.exportBackup();
  const items = JSON.parse(await app.downloadedText()).data.invoices.flatMap((i) => i.items);
  assert.deepEqual(plain(items.map((i) => i.productType).sort()), ["Daltosol", "Faience"]);
});

test("invoices saved before the field existed still load and print exactly as before", async () => {
  const app = await startedApp();
  const product = await addViaForm(app, { pName: "ACRA Beige", pType: "Daltosol" });
  const invoice = await sell(app, [product]);
  // The same invoice as an older version saved it: the line has no productType at all.
  const old = plain(app.api.getInvoices().find((i) => i.invoiceNumber === invoice.invoiceNumber));
  delete old.items[0].productType;
  const html = app.api.invoiceHtml(old);
  assert.match(html, /<td>ACRA Beige \(45 × 45\)<\/td>/);
  assert.doesNotMatch(html, /Daltosol|None|<td>\s*—/);
  assert.equal(app.api.Validation.invoiceProblem(old), "", "an old invoice is still valid");
  assert.equal(app.api.Validation.invoiceProblem(invoice), "", "and so is one with the type");

  const restored = await startedApp();
  const file = JSON.parse((await (async () => { await app.api.exportBackup(); return app.downloadedText(); })()));
  file.data.invoices = [old];
  await restored.api.importBackup(restored.file(JSON.stringify(file)));
  assert.equal(restored.api.getInvoices().length, 1);
  assert.match(restored.api.invoiceHtml(restored.api.getInvoices()[0]), /<td>ACRA Beige \(45 × 45\)<\/td>/);
});

test("the type changes no price, stock, total or payment on the invoice", async () => {
  const numbers = async (type) => {
    const app = await startedApp();
    const product = await addViaForm(app, { pName: "ACRA Beige", pType: type });
    const invoice = await sell(app, [product]);
    const { productType, productId, ...item } = invoice.items[0];   // the id is random for every product
    return plain({ item, total: invoice.total, subtotal: invoice.subtotal, stock: app.api.getProducts()[0].stock, price: app.api.getProducts()[0].sellingPrice });
  };
  const none = await numbers("");
  for (const type of TYPES) assert.deepEqual(await numbers(type), none, type);
});

test("the delivery and collection documents show the type too", async () => {
  const app = await startedApp();
  const product = await addViaForm(app, { pName: "ACRA Beige", pTileSize: "45*45", pType: "Daltosol", pStock: "1" });
  assert.equal(app.api.addToSale(product.id, "1", "box").ok, true);
  const line = app.api.getSale().items[0];
  app.api.setSalePartial(line.lineId, true);                              // "deliver only part now": 3 sold, 1 in stock
  assert.equal(app.api.updateSaleQuantity(line.lineId, "3").error, undefined);
  const result = await app.api.commit((d) => app.api.applySale(d, app.api.getSale()));
  assert.equal(result.error, undefined, result.error);
  const saved = app.api.getInvoices()[0];
  assert.match(app.api.collectionHtml(saved), /ACRA Beige \(45 × 45\)<div class="inv-sub">Daltosol<\/div>/);
  assert.match(app.api.invoiceHtml(saved), /ACRA Beige \(45 × 45\)<div class="inv-sub">Daltosol<\/div>/);
});

/* ---------- Names, French labels and the old spelling ---------- */

test("the dropdown labels are Daltosol, Faience, Porcelain, Rock in English and Daltosol, Faïence, Porcelaine, Pierre in French", () => {
  const options = (lang) => {
    const app = loadApp();
    setLang(app, lang);
    const html = app.api.stockForm.html();
    const select = html.match(/<select id="pType">([^]*?)<\/select>/)[1];
    return [...select.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((m) => [m[1], m[2]]);
  };
  assert.deepEqual(options("en"), [["", "None"], ["Daltosol", "Daltosol"], ["Faience", "Faience"], ["Porcelain", "Porcelain"], ["Rock", "Rock"]]);
  assert.deepEqual(options("fr"), [["", "Aucun"], ["Daltosol", "Daltosol"], ["Faience", "Faïence"], ["Porcelain", "Porcelaine"], ["Rock", "Pierre"]]);
});

test("the invoice shows the type in the language of the app, under the name", async () => {
  const app = await startedApp();
  const products = [];
  for (const [name, type] of [["ACRA Beige", "Daltosol"], ["ROZALIA", "Faience"], ["Slab", "Rock"], ["Gres", "Porcelain"]]) products.push(await addViaForm(app, { pName: name, pType: type }));
  const invoice = await sell(app, products);
  setLang(app, "fr");
  const fr = app.api.invoiceHtml(invoice);
  for (const [name, label] of [["ACRA Beige", "Daltosol"], ["ROZALIA", "Faïence"], ["Slab", "Pierre"], ["Gres", "Porcelaine"]]) {
    assert.match(fr, new RegExp(`<td>${name} \\(45 × 45\\)<div class="inv-sub">${label}</div></td>`), `${name}: ${label}`);
  }
  setLang(app, "en");
  const en = app.api.invoiceHtml(invoice);
  assert.match(en, /<div class="inv-sub">Faience<\/div>/);
  assert.match(en, /<div class="inv-sub">Rock<\/div>/);
});

test("the type line uses the very same class as the converted quantity, with no badge, box or icon", async () => {
  const app = await startedApp();
  const product = await addViaForm(app, { pName: "ACRA Beige", pTileSize: "45*45", pType: "Daltosol" });
  const html = app.api.invoiceHtml(await sell(app, [product]));
  const cell = html.match(/<tr><td>(ACRA Beige[^]*?)<\/td><td class="num">/)[1];
  assert.equal(cell, 'ACRA Beige (45 × 45)<div class="inv-sub">Daltosol</div>');
  assert.match(html, /<td class="num">[^<]*<div class="inv-sub">[\d.,\s]+ m²<\/div>/, "the quantity detail is the same inv-sub block");
  assert.doesNotMatch(cell, /badge|icon|<svg|<img|<span/);
});

test("the old spelling Daldosol is read as Daltosol: products, backups and invoices saved before keep working", async () => {
  const { api } = loadApp();
  assert.equal(api.Validation.normalizeProductType("Daldosol"), "Daltosol");
  assert.equal(api.Validation.normalizeProductType("Daltosol"), "Daltosol");
  assert.equal(api.Validation.normalizeProductType("Granite"), "");
  assert.equal(api.Validation.normalizeProductType(undefined), "");
  assert.equal(api.normalizeProduct(legacyProduct({ productType: "Daldosol" })).productType, "Daltosol");
  assert.equal(api.Validation.productProblem({ ...legacyProduct(), productType: "Daldosol" }), "", "an old backup is not refused");
  assert.equal(api.Validation.readProductInput({ name: "A", productType: "Daldosol", coveragePerBox: "1.44", stockUnit: "box", prices: [{ unit: "m2", price: "1000" }] }, { products: [], stockFromPurchase: true }).values.productType, "Daltosol");
  assert.equal(api.productTypeLabel("Daldosol"), "Daltosol");
  assert.equal(api.invoiceItemTypeHtml({ productType: "Daldosol" }), '<div class="inv-sub">Daltosol</div>');

  // a product stored with the old spelling is not rewritten behind the person's back, but it shows Daltosol when edited,
  // is saved as Daltosol when saved, and a new sale of it is snapshotted as Daltosol
  const app = await startedApp();
  await app.api.db.initDatabase();
  await app.api.db.commitChanges({ products: { put: [legacyProduct({ productType: "Daldosol" })], remove: [] } });
  const again = await startedApp({ indexedDB: app.indexedDB });
  const [product] = again.api.getProducts();
  assert.equal(product.name, "ROZALIA Marfil", "the product loads");
  again.api.startEditProduct(product.id);
  assert.equal(again.field("pType").value, "Daltosol", "the dropdown shows the corrected type, not None");
  const sold = await sell(again, [product]);
  assert.equal(sold.items[0].productType, "Daltosol");
  again.api.startEditProduct(product.id);
  await again.api.updateProduct(product.id, again.api.readProductForm().values);
  assert.equal(again.api.getProducts()[0].productType, "Daltosol");
  assert.equal(again.api.getProducts()[0].sellingPrice, 1200, "nothing else changed");

  // an invoice sold before the correction keeps its saved line and shows the correct spelling
  const invoice = plain(sold);
  invoice.items[0].productType = "Daldosol";
  assert.equal(again.api.Validation.invoiceProblem(invoice), "");
  assert.match(again.api.invoiceHtml(invoice), /<div class="inv-sub">Daltosol<\/div>/);
  assert.doesNotMatch(again.api.invoiceHtml(invoice), /Daldosol/);
});

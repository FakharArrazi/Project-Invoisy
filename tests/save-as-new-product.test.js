"use strict";

// "Save as New Product": while a product is being edited on the Stock page, a third button turns what the form shows into a
// separate, new product. The original must stay exactly as it was (data, stock, invoices, purchases), the new product starts
// with its own id and no stock, and the existing rules (duplicate refusal, validation, persistence errors) still apply.

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { failPutWith } = require("./helpers/modules");
const { loadApp } = require("./helpers/app");

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const script = fs.readFileSync(path.join(ROOT, "java script", "script.js"), "utf8");
const css = fs.readFileSync(path.join(ROOT, "css", "stock.css"), "utf8");
const plain = (x) => JSON.parse(JSON.stringify(x));

async function boot() {
  const app = loadApp();
  const storage = await app.start();
  assert.equal(storage.mode, "ready", storage.reason);
  return app;
}

const tile = (overrides) => ({
  name: "Acra Beige", productType: "", manufacturer: "TimgadCeram", tileSize: "60*60", coveragePerBox: 1.44, description: "", sku: "",
  category: "", sellingPrice: 1200, priceUnit: "m2", stockUnit: "box", purchasePrice: 900, stock: 25, ...overrides,
});

// Opens the product in the form like a click on Edit; the stand-in boxes keep what is assigned, a real input turns it into text.
function openEdit(app, id) {
  app.api.startEditProduct(id);
  for (const box of ["pName", "pManufacturer", "pTileSize", "pDesc", "pCost", "pStock", "pStockUnit", "pSku", "pCoveragePerBox", "pCategory"]) {
    app.field(box).value = String(app.field(box).value);
  }
}

async function withProduct(overrides) {
  const app = await boot();
  await app.api.addProduct(tile(overrides));
  const original = app.api.getState().products[0];
  openEdit(app, original.id);
  return { app, original: plain(original) };
}

/* ---------- The button ---------- */

test("the footer has three buttons in order: save changes, save as new product, cancel; the new one is a plain button", () => {
  const footer = html.match(/<div class="actions left stock-form-actions">([^]*?)<\/div>/)[1];
  const ids = [...footer.matchAll(/<button[^>]*id="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ["productSubmit", "productSaveAsNew", "productCancel"]);
  const button = footer.match(/<button[^>]*id="productSaveAsNew"[^>]*>/)[0];
  assert.match(button, /type="button"/, "never submits the form (Enter still means Save changes)");
  assert.match(button, /data-i18n="stock\.saveAsNew"/);
  assert.match(button, /\shidden/, "hidden until a product is being edited");
  assert.doesNotMatch(button, /\bprimary\b/, "not styled like the primary save button");
  assert.match(css, /\.stock-form-actions \.btn\.accent-outline/, "has its own style");
});

test("the label is 'Ajouter comme nouveau produit' in French and is translated in English and Arabic", async () => {
  const app = await boot();
  const label = async (code) => { await app.api.saveLanguage(code); return app.api.t("stock.saveAsNew"); };
  assert.equal(await label("fr"), "Ajouter comme nouveau produit");
  assert.equal(await label("ar") === "Save as New Product", false);
  assert.match(app.api.t("stock.saveAsNew"), /[\u0600-\u06FF]/);
  assert.equal(await label("en"), "Save as New Product");
});

test("the button shows only while a product is being edited, and is gone again after the form is closed", async () => {
  const app = await boot();
  await app.api.addProduct(tile());
  const id = app.api.getState().products[0].id;
  app.api.openProductForm();
  assert.equal(app.field("productSaveAsNew").hidden, true, "a new-product form has no such button");
  app.api.closeProductForm({ force: true });
  openEdit(app, id);
  assert.equal(app.field("productSaveAsNew").hidden, false, "shown while editing");
  assert.equal(app.field("productSubmit").textContent, "Save Changes");
  app.api.closeProductForm({ force: true });
  assert.equal(app.field("productSaveAsNew").hidden, true);
});

test("the click is wired through guard(), so a double click cannot add two products", () => {
  assert.match(script, /\$\("productSaveAsNew"\)\.addEventListener\("click", \(\) => guard\(addProductAsNew\)\)/);
});

/* ---------- Creating the new product ---------- */

test("with changed fields: the new product has the typed values and its own id; the original is untouched", async () => {
  const { app, original } = await withProduct({ sku: "AB-1" });
  app.field("pName").value = "Acra Beige Mat";
  app.field("pTileSize").value = "65*30";
  app.field("pSku").value = "AB-2";
  app.field("pDesc").value = "matte finish";
  app.field("pCost").value = "950";
  assert.equal(await app.api.addProductAsNew(), true);

  const products = plain(app.api.getState().products);
  assert.equal(products.length, 2);
  const fresh = products.find((p) => p.id !== original.id);
  const kept = products.find((p) => p.id === original.id);
  assert.deepEqual(kept, original, "the original product is exactly as it was");
  assert.notEqual(fresh.id, original.id);
  assert.equal(fresh.name, "Acra Beige Mat");
  assert.equal(fresh.tileSize, "65*30");
  assert.equal(fresh.sku, "AB-2");
  assert.equal(fresh.description, "matte finish");
  assert.equal(fresh.purchasePrice, 950);
  assert.equal(fresh.manufacturer, "TimgadCeram", "fields that were not changed come along");
  assert.equal(fresh.coveragePerBox, 1.44);
  assert.equal(fresh.stockUnit, "box");
  assert.equal(fresh.sellingPrice, 1200);
  assert.equal(fresh.priceUnit, "m2");
  assert.deepEqual(plain(fresh.sellingPrices), [{ unit: "m2", price: 1200 }], "selling prices are copied");
});

test("the new product starts with no stock: the original's quantity is neither copied nor changed", async () => {
  const { app, original } = await withProduct({ sku: "AB-1", stock: 25 });
  app.field("pTileSize").value = "65*30";
  app.field("pSku").value = "AB-2";
  assert.equal(app.field("pStock").value, "25", "the form shows the original's stock");
  assert.equal(await app.api.addProductAsNew(), true);
  const fresh = app.api.getState().products.find((p) => p.id !== original.id);
  const kept = app.api.getState().products.find((p) => p.id === original.id);
  assert.equal(fresh.stock, 0);
  assert.equal(kept.stock, 25);
});

test("an original with part of a box left (19.25 boxes) can still be used as a starting point", async () => {
  const { app, original } = await withProduct({ sku: "AB-1", stock: 19.25 });
  app.field("pName").value = "Acra Beige 2";
  app.field("pSku").value = "AB-2";
  assert.equal(await app.api.addProductAsNew(), true, app.field("productError").textContent);
  assert.equal(app.api.getState().products.find((p) => p.id === original.id).stock, 19.25);
  assert.equal(app.api.getState().products.find((p) => p.id !== original.id).stock, 0);
});

test("invoices, payments and purchases of the original are not copied, moved or changed", async () => {
  const { app, original } = await withProduct({ sku: "AB-1", stock: 25 });
  app.api.closeProductForm({ force: true });
  app.api.addToSale(original.id, "2", "box");
  app.api.getSale().customer.name = "Karim";
  app.api.getSale().paidValue = "500";
  await app.api.completeSale();
  await app.api.saleDoneAction("later");
  const before = plain({ invoices: app.api.getState().invoices, purchases: app.api.getState().purchases, product: app.api.getState().products[0] });
  assert.equal(before.invoices.length, 1);
  assert.equal(before.product.stock, 23);

  openEdit(app, original.id);
  app.field("pTileSize").value = "65*30";
  app.field("pSku").value = "AB-2";
  assert.equal(await app.api.addProductAsNew(), true);

  const state = app.api.getState();
  assert.deepEqual(plain(state.invoices), before.invoices, "the invoice is exactly as it was");
  assert.deepEqual(plain(state.purchases), before.purchases);
  assert.deepEqual(plain(state.products.find((p) => p.id === original.id)), before.product, "the original, with its stock after the sale, is unchanged");
  const fresh = state.products.find((p) => p.id !== original.id);
  assert.equal(fresh.stock, 0);
  assert.ok(state.invoices.every((inv) => inv.items.every((i) => i.productId !== fresh.id)), "no invoice line points at the new product");
});

test("saved for good: both products are still there after the application is reloaded", async () => {
  const { app, original } = await withProduct({ sku: "AB-1" });
  app.field("pTileSize").value = "65*30";
  app.field("pSku").value = "AB-2";
  assert.equal(await app.api.addProductAsNew(), true);
  const reloaded = loadApp({ indexedDB: app.indexedDB });
  await reloaded.start();
  const products = reloaded.api.getState().products;
  assert.equal(products.length, 2);
  assert.deepEqual(plain(products.find((p) => p.id === original.id)), original);
  assert.equal(products.find((p) => p.id !== original.id).tileSize, "65*30");
});

/* ---------- After success ---------- */

test("after success the form is closed and cleared, so nothing can be saved over the original afterwards", async () => {
  const { app, original } = await withProduct({ sku: "AB-1" });
  app.field("pTileSize").value = "65*30";
  app.field("pSku").value = "AB-2";
  await app.api.addProductAsNew();
  const view = plain(app.api.getStockView());
  assert.equal(view.open, false);
  assert.equal(view.editingId, null);
  assert.equal(app.field("pName").value, "");
  assert.equal(app.field("productSaveAsNew").hidden, true);
  assert.equal(await app.api.addProductAsNew(), false, "with no product being edited the action does nothing");
  assert.equal(app.api.getState().products.length, 2);
  assert.equal(app.api.getState().products.find((p) => p.id === original.id).tileSize, "60*60");
});

test("a short success message names the new product and says the original is unchanged", async () => {
  const { app } = await withProduct({ sku: "AB-1" });
  app.field("pName").value = "Acra Beige Mat";
  app.field("pSku").value = "AB-2";
  await app.api.addProductAsNew();
  assert.equal(app.toast(), "Acra Beige Mat was added as a new product. The original product is unchanged.");
});

test("the Stock table lists the new product at once", async () => {
  const { app } = await withProduct({ sku: "AB-1" });
  app.field("pName").value = "Zeta New";
  app.field("pSku").value = "AB-2";
  await app.api.addProductAsNew();
  assert.match(app.field("stockBody").innerHTML, /Zeta New/);
  assert.match(app.field("stockBody").innerHTML, /Acra Beige/);
});

/* ---------- The existing rules still apply ---------- */

test("with nothing changed the existing duplicate rule refuses it: nothing is saved, the form keeps what was typed", async () => {
  const { app, original } = await withProduct({ sku: "" });   // same name, manufacturer and size, no SKU: the same product
  assert.equal(await app.api.addProductAsNew(), false);
  assert.match(app.field("productError").textContent, /already|exists|duplicate|same/i);
  assert.equal(app.api.getState().products.length, 1);
  assert.deepEqual(plain(app.api.getState().products[0]), original);
  assert.equal(app.api.getStockView().open, true, "the form stays open");
  assert.equal(app.api.getStockView().editingId, original.id, "still editing the original");
  assert.equal(app.field("pName").value, "Acra Beige");
});

test("the SKU of the original cannot be reused for the new product", async () => {
  const { app, original } = await withProduct({ sku: "AB-1" });
  app.field("pTileSize").value = "65*30";   // another size, but the same SKU
  assert.equal(await app.api.addProductAsNew(), false);
  assert.match(app.field("productError").textContent, /AB-1/);
  assert.equal(app.api.getState().products.length, 1);
  assert.deepEqual(plain(app.api.getState().products[0]), original);
});

test("an invalid form (no name) is refused with the usual message and nothing is saved", async () => {
  const { app } = await withProduct({ sku: "AB-1" });
  app.field("pName").value = "";
  assert.equal(await app.api.addProductAsNew(), false);
  assert.notEqual(app.field("productError").textContent, "");
  assert.equal(app.api.getState().products.length, 1);
  assert.equal(app.api.getStockView().open, true);
});

test("when saving fails the form stays open with what was typed, an error is shown, and no success is reported", async () => {
  const { app, original } = await withProduct({ sku: "AB-1" });
  app.field("pTileSize").value = "65*30";
  app.field("pSku").value = "AB-2";
  app.field("pDesc").value = "typed but not saved";
  const restore = failPutWith("QuotaExceededError", 1);
  let saved;
  try { saved = await app.api.addProductAsNew(); } finally { restore(); }
  assert.equal(saved, false);
  assert.notEqual(app.field("productError").textContent, "");
  assert.doesNotMatch(app.toast(), /added as a new product/);
  assert.equal(app.api.getState().products.length, 1, "nothing was added");
  assert.deepEqual(plain(app.api.getState().products[0]), original);
  assert.equal(app.api.getStockView().open, true);
  assert.equal(app.field("pDesc").value, "typed but not saved");
  assert.equal(await app.api.addProductAsNew(), true, "and once saving works again the same form can be saved");
  assert.equal(app.api.getState().products.length, 2);
});

test("two clicks at once (through guard) add one product, not two", async () => {
  const { app } = await withProduct({ sku: "AB-1" });
  app.field("pTileSize").value = "65*30";
  app.field("pSku").value = "AB-9";
  await Promise.all([app.api.guard(app.api.addProductAsNew), app.api.guard(app.api.addProductAsNew)]);
  assert.equal(app.api.getState().products.length, 2);
});

/* ---------- The other buttons are unchanged ---------- */

test("Save Changes still updates only the product being edited and creates nothing", async () => {
  const { app, original } = await withProduct({ sku: "AB-1" });
  app.field("pName").value = "Acra Beige Renamed";
  const result = app.api.readProductForm();
  assert.equal(result.error, undefined, result.error);
  await app.api.updateProduct(original.id, result.values);
  const products = plain(app.api.getState().products);
  assert.equal(products.length, 1);
  assert.equal(products[0].id, original.id);
  assert.equal(products[0].name, "Acra Beige Renamed");
  assert.equal(products[0].stock, 25, "its stock is kept");
});

test("the plain form check still treats the edited product as itself (save changes unchanged), unlike the new-product check", async () => {
  const { app } = await withProduct({ sku: "" });
  assert.equal(app.api.readProductForm().error, undefined, "saving the product as it is is fine");
  assert.ok(app.api.readProductForm(true).error, "but as a new product it would repeat itself");
});

test("Cancel still closes the form without saving anything", async () => {
  const { app, original } = await withProduct({ sku: "AB-1" });
  app.field("pName").value = "Never saved";
  assert.equal(app.api.closeProductForm({ force: true }), true);
  assert.equal(app.api.getState().products.length, 1);
  assert.deepEqual(plain(app.api.getState().products[0]), original);
});

"use strict";

// Settings -> Product types: the list the Product type field of the product form offers is managed by the person, not by the code.
//   - it lives in the existing settings (settings.productTypes), is only written once it is changed, and starts as the built-in types
//   - Add / Remove take effect at once in the product forms and are still there after a reload
//   - no empty type, no repeat (capitals, accents, spaces, or another language's name of a built-in type)
//   - taking a type out of the list never changes a product, an invoice or a backup that uses it

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./helpers/app");
const { fillProductForm } = require("./helpers");

const BUILT_IN = ["DalleDeSol", "Faience", "Porcelain", "Rock", "Evier", "CimentColle", "PateAJoint", "Parquet"];
const plain = (value) => JSON.parse(JSON.stringify(value));

async function startedApp(options) {
  const app = loadApp(options);
  const storage = await app.start();
  assert.equal(storage.mode, "ready", storage.reason);
  return app;
}

// A product through the Stock form, like a person would add it. Returns it as the app holds it.
async function addProduct(app, name, type) {
  const read = fillProductForm(app, {
    pName: name, pTileSize: "45*45", pCoveragePerBox: "1.44", pStock: "10", pStockUnit: "box", pType: type || "",
    priceRows: [{ unit: "m2", price: "1000" }],
  });
  assert.equal(read.error, undefined, read.error);
  assert.equal(await app.api.addProduct(read.values), true);
  return app.api.getProducts().find((p) => p.name === name);
}

// The values the Product type list of the Stock form offers right now (without None), read from its markup.
const offered = (app) => [...app.field("pType").innerHTML.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]).filter(Boolean);
const labels = (app) => [...app.field("pType").innerHTML.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].filter((m) => m[1]).map((m) => m[2]);

// What the Settings page does when a type is typed and Add is pressed.
async function typeAndAdd(app, text) {
  app.field("productTypeInput").value = text;
  await app.api.submitProductType();
  return { error: app.errorText("productTypeError"), box: app.field("productTypeInput").value };
}

const savedTypes = async (app) => plain((await app.api.db.getSettings()).productTypes);
const unescape = (text) => text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const listed = (app) => [...app.field("productTypeList").innerHTML.matchAll(/data-type="([^"]*)"/g)].map((m) => unescape(m[1]));

/* ---------- The starting point: nothing is reset ---------- */

test("settings that never changed the list offer the built-in types, and the stored settings do not gain a key", async () => {
  const app = await startedApp();
  const { Validation } = app.api;
  assert.deepEqual(plain(Validation.productTypesOf(app.api.getState().settings)), BUILT_IN);
  assert.equal("productTypes" in app.api.getState().settings, false, "the saved settings keep their old shape until the list is changed");
  assert.equal("productTypes" in (await app.api.db.getSettings()), false);
  assert.deepEqual(offered(app), BUILT_IN, "the Stock form offers all of them");
  assert.deepEqual(listed(app), BUILT_IN, "and so does the Settings list");
  assert.equal(Validation.normalizeSettings({}).productTypes, undefined);
  assert.equal(Validation.normalizeSettings(null).productTypes, undefined);
});

test("the first change keeps every existing type and the products that use them", async () => {
  const app = await startedApp();
  const tile = await addProduct(app, "ACRA Beige", "DalleDeSol");
  const sink = await addProduct(app, "Inox 1 bac", "Evier");
  const before = plain(app.api.getProducts());

  const r = await app.api.addProductTypeToSettings("Électricité");
  assert.deepEqual(plain(r), { value: "Électricité" });
  assert.deepEqual(await savedTypes(app), [...BUILT_IN, "Électricité"], "the saved list is the built-in types plus the new one: nothing was reset");
  assert.deepEqual(plain(app.api.getProducts()), before, "no product changed");
  assert.equal(app.api.getProducts().find((p) => p.id === tile.id).productType, "DalleDeSol");
  assert.equal(app.api.getProducts().find((p) => p.id === sink.id).productType, "Evier");
});

test("settings saved by an older version (no list) load, and a restored old backup offers the built-in types", async () => {
  const app = await startedApp();
  await app.api.db.initDatabase();
  await app.api.db.commitChanges({ settings: { ...app.api.getState().settings, businessName: "Carrelage Setif" } });
  const again = await startedApp({ indexedDB: app.indexedDB });
  assert.equal(again.api.getState().settings.businessName, "Carrelage Setif");
  assert.deepEqual(offered(again), BUILT_IN);
});

/* ---------- Adding a type ---------- */

test("Add puts the type in the list and in the product form at once, and it is still there after a reload", async () => {
  const app = await startedApp();
  assert.equal(offered(app).includes("Électricité"), false);
  const result = await typeAndAdd(app, "Électricité");
  assert.equal(result.error, "", "no message");
  assert.equal(result.box, "", "the box is emptied, ready for the next one");
  assert.deepEqual(listed(app), [...BUILT_IN, "Électricité"], "the Settings list shows it");
  assert.deepEqual(offered(app), [...BUILT_IN, "Électricité"], "the Stock form offers it straight away, with no reload");
  assert.equal(labels(app).at(-1), "Électricité", "shown as it was typed");

  const again = await startedApp({ indexedDB: app.indexedDB });
  assert.deepEqual(await savedTypes(again), [...BUILT_IN, "Électricité"]);
  assert.deepEqual(listed(again), [...BUILT_IN, "Électricité"]);
  assert.deepEqual(offered(again), [...BUILT_IN, "Électricité"], "the form offers it after a reload too");
});

test("a new type can be chosen when adding a product, is kept on it, and survives a reload, an edit and a sale", async () => {
  const app = await startedApp();
  await typeAndAdd(app, "Électricité");
  const saved = await addProduct(app, "Prise double", "Électricité");
  assert.equal(saved.productType, "Électricité");

  const again = await startedApp({ indexedDB: app.indexedDB });
  const [product] = again.api.getProducts();
  assert.equal(product.productType, "Électricité", "not blanked when the data is loaded");

  again.api.startEditProduct(product.id);
  assert.equal(again.field("pType").value, "Électricité", "the edit form shows it selected");
  await again.api.updateProduct(product.id, again.api.readProductForm().values);
  assert.equal(again.api.getProducts()[0].productType, "Électricité");

  assert.equal(again.api.addToSale(product.id, "2", "box").ok, true);
  const sold = await again.api.commit((d) => again.api.applySale(d, again.api.getSale()));
  assert.equal(sold.error, undefined, sold.error);
  assert.equal(sold.invoice.items[0].productType, "Électricité", "the invoice line keeps it");
  assert.equal(again.api.invoiceItemTypeHtml(sold.invoice.items[0]), '<div class="inv-sub">Électricité</div>', "printed as typed, never a missing-translation key");
});

test("a type with special characters is shown safely on the Settings list, the form and the invoice", async () => {
  const app = await startedApp();
  await typeAndAdd(app, "Vitrage <b>&\"1\"");
  assert.deepEqual(listed(app).at(-1), "Vitrage <b>&\"1\"");
  assert.doesNotMatch(app.field("productTypeList").innerHTML, /<b>/);
  assert.doesNotMatch(app.field("pType").innerHTML, /<b>/);
  assert.equal(app.api.invoiceItemTypeHtml({ productType: "Vitrage <b>" }), '<div class="inv-sub">Vitrage &lt;b&gt;</div>');
});

test("a custom type is found by its text in the product search", async () => {
  const app = await startedApp();
  await typeAndAdd(app, "Électricité");
  await addProduct(app, "Prise double", "Électricité");
  await addProduct(app, "ACRA Beige", "DalleDeSol");
  const found = (query) => plain(app.api.Validation.suggestProducts(query, app.api.getProducts()).map((p) => p.name));
  assert.deepEqual(found("electricite"), ["Prise double"]);
  assert.deepEqual(found("dalle"), ["ACRA Beige"]);
});

test("the stored type is tidied: spaces around it and inside it are reduced to single spaces", async () => {
  const app = await startedApp();
  assert.deepEqual(plain(await app.api.addProductTypeToSettings("   Gaz    naturel  ")), { value: "Gaz naturel" });
  assert.equal((await savedTypes(app)).at(-1), "Gaz naturel");
});

/* ---------- Rules: no empty type, no repeat ---------- */

test("an empty type, or one made only of spaces, is refused with a message and nothing is saved", async () => {
  const app = await startedApp();
  const revision = app.api.getState().revision;
  for (const text of ["", "   ", "\t\n "]) {
    const result = await typeAndAdd(app, text);
    assert.match(result.error, /type a product type first/i, JSON.stringify(text));
  }
  assert.equal(app.api.getState().revision, revision, "no save was made");
  assert.equal("productTypes" in app.api.getState().settings, false);
  assert.deepEqual(offered(app), BUILT_IN);
});

test("a type already in the list is refused whatever its capitals, accents or spacing, and nothing is saved", async () => {
  const app = await startedApp();
  await app.api.addProductTypeToSettings("Électricité");
  const revision = app.api.getState().revision;
  for (const text of ["Électricité", "électricité", "ÉLECTRICITÉ", "Electricite", "  Électricité  ", "Électricité ", "electricite ", "\tÉLECTRICITE\n"]) {
    const result = await typeAndAdd(app, text);
    assert.match(result.error, /already in the list/i, JSON.stringify(text));
    assert.equal(result.box, text, "what was typed stays so it can be corrected");
  }
  assert.equal(app.api.getState().revision, revision, "no save was made");
  assert.deepEqual(await savedTypes(app), [...BUILT_IN, "Électricité"], "the list has it once");
});

test("a built-in type typed under any of its names is a repeat: Faïence, Pierre, Porcelaine, ROCK, Pâte  à joint ...", async () => {
  const app = await startedApp();
  for (const text of ["Faïence", "faience", "Pierre", "Porcelaine", "ROCK", "Dalle de sol", "Pâte   à  joint", "Évier", "evier", "Ciment-colle", "Parquet", "PateAJoint"]) {
    const result = await typeAndAdd(app, text);
    assert.match(result.error, /already in the list/i, text);
  }
  assert.equal("productTypes" in app.api.getState().settings, false, "nothing was saved");
});

test("a type that is only similar to one in the list is a different type and can be added: Ciment is not Ciment-colle", async () => {
  const app = await startedApp();
  const result = await typeAndAdd(app, "Ciment");
  assert.equal(result.error, "");
  assert.equal((await savedTypes(app)).at(-1), "Ciment");
});

test("the length and the size of the list are limited, with a message", async () => {
  const app = await startedApp();
  const { MAX_PRODUCT_TYPE_LENGTH, MAX_PRODUCT_TYPES } = app.api.Validation;
  assert.match((await typeAndAdd(app, "x".repeat(MAX_PRODUCT_TYPE_LENGTH + 1))).error, /at most 60 characters/);
  assert.equal((await typeAndAdd(app, "y".repeat(MAX_PRODUCT_TYPE_LENGTH))).error, "", "exactly the limit is fine");

  const full = Array.from({ length: MAX_PRODUCT_TYPES }, (_, i) => "Type " + i);
  const { Validation } = app.api;
  const checked = Validation.addProductType(full, "One more");
  assert.equal(checked.error, "tooMany");
  assert.equal(full.length, MAX_PRODUCT_TYPES, "the list that was given is not changed");
});

/* ---------- Removing a type ---------- */

test("removing an unused type asks first, and Cancel changes nothing", async () => {
  const app = await startedApp();
  app.answer(false);
  assert.deepEqual(plain(await app.api.removeProductTypeFromSettings("Rock")), { cancelled: true });
  assert.equal(app.confirms.length, 1);
  assert.match(app.confirms[0], /Remove “Rock” from the list\?/);
  assert.match(app.confirms[0], /No product is changed/);
  assert.equal("productTypes" in app.api.getState().settings, false, "nothing was saved");
  assert.deepEqual(offered(app), BUILT_IN);
});

test("removing an unused type takes it out of the Settings list and out of the product form at once, and it stays out after a reload", async () => {
  const app = await startedApp();
  app.answer(true);
  assert.deepEqual(plain(await app.api.removeProductTypeFromSettings("Rock")), { removed: "Rock" });
  const rest = BUILT_IN.filter((type) => type !== "Rock");
  assert.deepEqual(listed(app), rest);
  assert.deepEqual(offered(app), rest, "no longer offered, with no reload");
  assert.deepEqual(await savedTypes(app), rest);

  const again = await startedApp({ indexedDB: app.indexedDB });
  assert.deepEqual(offered(again), rest);
  assert.deepEqual(listed(again), rest);
});

test("Remove on the Settings list does the same, and puts the cursor back in the box", async () => {
  const app = await startedApp();
  app.answer(true);
  await app.api.clickRemoveProductType("Parquet");
  assert.equal(listed(app).includes("Parquet"), false);
  assert.equal(app.errorText("productTypeError"), "");
});

test("a removed type can be added again, and a removed built-in type comes back as the same built-in type", async () => {
  const app = await startedApp();
  app.answer(true);
  await app.api.removeProductTypeFromSettings("Faience");
  assert.equal(offered(app).includes("Faience"), false);
  const result = await typeAndAdd(app, "Faïence");
  assert.equal(result.error, "");
  assert.deepEqual(await savedTypes(app), [...BUILT_IN.filter((t) => t !== "Faience"), "Faience"], "stored as the built-in value, not as a second spelling");
  assert.equal(labels(app).at(-1), "Faience", "and shown with its translated name");
});

test("every type can be removed: the product form then offers only None, and the list says so", async () => {
  const app = await startedApp();
  for (const type of BUILT_IN) { app.answer(true); await app.api.removeProductTypeFromSettings(type); }
  assert.deepEqual(await savedTypes(app), [], "an empty list is kept as an empty list, not reset to the built-in types");
  assert.deepEqual(offered(app), []);
  assert.equal(app.field("productTypesEmpty").hidden, false);
  const again = await startedApp({ indexedDB: app.indexedDB });
  assert.deepEqual(offered(again), [], "still empty after a reload");
  assert.equal(again.field("productTypesEmpty").hidden, false);
});

/* ---------- A type that is removed while products use it ---------- */

async function shopWithUsedType() {
  const app = await startedApp();
  await typeAndAdd(app, "Électricité");
  const one = await addProduct(app, "Prise double", "Électricité");
  const two = await addProduct(app, "Interrupteur", "Électricité");
  const other = await addProduct(app, "ACRA Beige", "DalleDeSol");
  const sold = await (async () => {
    assert.equal(app.api.addToSale(one.id, "2", "box").ok, true);
    const result = await app.api.commit((d) => app.api.applySale(d, app.api.getSale()));
    assert.equal(result.error, undefined, result.error);
    return result.invoice;
  })();
  return { app, one, two, other, sold };
}

test("removing a type that products use says how many, and changes none of them, nor the invoices", async () => {
  const { app, sold } = await shopWithUsedType();
  const productsBefore = plain(app.api.getProducts());
  const invoicesBefore = plain(app.api.getInvoices());

  app.answer(true);
  assert.deepEqual(plain(await app.api.removeProductTypeFromSettings("Électricité")), { removed: "Électricité" });
  assert.equal(app.confirms.length, 1);
  assert.match(app.confirms[0], /“Électricité” is used by 2 products/);
  assert.match(app.confirms[0], /keep their type/);
  assert.match(app.confirms[0], /no longer be offered for new products/);

  assert.deepEqual(plain(app.api.getProducts()), productsBefore, "every product is exactly as it was, type included");
  assert.deepEqual(plain(app.api.getInvoices()), invoicesBefore, "so is every invoice");
  assert.equal(sold.items[0].productType, "Électricité");
  assert.equal(offered(app).includes("Électricité"), false, "but it is no longer offered");
  assert.equal(listed(app).includes("Électricité"), false);

  const again = await startedApp({ indexedDB: app.indexedDB });
  assert.deepEqual(plain(again.api.getProducts()), productsBefore, "and it stays so after a reload");
  assert.deepEqual(plain(again.api.getInvoices()), invoicesBefore);
});

test("the question counts one product in the singular and a French shop reads it in French", async () => {
  const app = await startedApp();
  await typeAndAdd(app, "Gaz");
  await addProduct(app, "Chauffe-eau", "Gaz");
  app.answer(false);
  await app.api.removeProductTypeFromSettings("Gaz");
  assert.match(app.confirms[0], /“Gaz” is used by 1 product\./);

  app.api.getState().settings.language = "fr";
  app.api.applyData({ ...app.api.getState() });
  app.answer(false);
  await app.api.removeProductTypeFromSettings("Gaz");
  assert.match(app.confirms[1], /« Gaz » est utilisé par 1 produit\./);
  assert.match(app.confirms[1], / \?$/, "French punctuation");
});

test("a product keeps its removed type when it is edited and saved, and the form shows it selected", async () => {
  const { app, one } = await shopWithUsedType();
  app.answer(true);
  await app.api.removeProductTypeFromSettings("Électricité");

  app.api.startEditProduct(one.id);
  assert.equal(app.field("pType").value, "Électricité", "the edit form still shows the product's own type");
  assert.match(app.field("pType").innerHTML, /Électricité \(no longer in the list\)/, "marked, so it is clear why it is there");
  assert.deepEqual(offered(app).filter((v) => v === "Électricité").length, 1, "once");

  const read = app.api.readProductForm();
  assert.equal(read.error, undefined, "saving it unchanged is allowed");
  assert.equal(read.values.productType, "Électricité");
  fillProductForm(app, { pStock: "7", priceRows: [{ unit: "m2", price: "1100" }] });
  await app.api.updateProduct(one.id, app.api.readProductForm().values);
  const after = app.api.getProducts().find((p) => p.id === one.id);
  assert.equal(after.productType, "Électricité", "type kept");
  assert.equal(after.sellingPrice, 1100, "and the edit itself was saved");

  const again = await startedApp({ indexedDB: app.indexedDB });
  assert.equal(again.api.getProducts().find((p) => p.id === one.id).productType, "Électricité");
});

test("after editing, a removed type is not on offer to the next product", async () => {
  const { app, one } = await shopWithUsedType();
  app.answer(true);
  await app.api.removeProductTypeFromSettings("Électricité");
  app.api.startEditProduct(one.id);
  assert.equal(offered(app).includes("Électricité"), true, "offered while editing the product that has it");
  app.api.closeProductForm({ force: true });
  assert.equal(offered(app).includes("Électricité"), false, "not on offer again for a new product");
  assert.equal(app.field("pType").value, "");
});

test("a removed type cannot be given to a new product, to another product, or to a copy of the product that has it", async () => {
  const { app, one, other } = await shopWithUsedType();
  app.answer(true);
  await app.api.removeProductTypeFromSettings("Électricité");

  // a new product
  const fresh = fillProductForm(app, { pName: "Câble", pTileSize: "", pType: "Électricité", pStock: "1", pStockUnit: "box", pCoveragePerBox: "1", priceRows: [{ unit: "m2", price: "10" }] });
  assert.equal(fresh.field, "pType");
  assert.match(fresh.error, /choose a product type from the list/i);

  // another product that does not have it
  app.api.startEditProduct(other.id);
  app.field("pType").value = "Électricité";
  assert.equal(app.api.readProductForm().field, "pType");

  // "Save as new product" from the product that has it: the copy is a new product
  app.api.startEditProduct(one.id);
  assert.equal(app.api.readProductForm().error, undefined, "saving the product itself is fine");
  assert.equal(app.api.readProductForm(true).field, "pType", "a copy is a new product, so it has to choose a type that is on offer");
});

test("a removed type is not wiped by a backup: export, restore and the type is still on the products", async () => {
  const { app, one, two } = await shopWithUsedType();
  app.answer(true);
  await app.api.removeProductTypeFromSettings("Électricité");
  await app.api.exportBackup();
  const text = await app.downloadedText();
  const file = JSON.parse(text);
  assert.equal(file.data.products.find((p) => p.id === one.id).productType, "Électricité");
  assert.equal(file.data.settings.productTypes.includes("Électricité"), false, "the list in the backup is the list as it is now");

  const other = await startedApp();
  await other.api.importBackup(other.file(text));
  assert.deepEqual(plain(other.api.getProducts().map((p) => p.productType)).sort(), ["DalleDeSol", "Électricité", "Électricité"]);
  assert.equal(other.api.getProducts().some((p) => p.id === two.id), true);
  assert.equal(offered(other).includes("Électricité"), false, "and the restored list does not offer it");
  assert.deepEqual(await savedTypes(other), BUILT_IN);
});

test("a backup keeps the list a person built, in the same order, and an old backup without a list restores with the built-in types", async () => {
  const app = await startedApp();
  await typeAndAdd(app, "Électricité");
  app.answer(true);
  await app.api.removeProductTypeFromSettings("Rock");
  await app.api.exportBackup();
  const text = await app.downloadedText();
  const expected = [...BUILT_IN.filter((t) => t !== "Rock"), "Électricité"];
  assert.deepEqual(plain(JSON.parse(text).data.settings.productTypes), expected);

  const restored = await startedApp();
  await restored.api.importBackup(restored.file(text));
  assert.deepEqual(await savedTypes(restored), expected);
  assert.deepEqual(offered(restored), expected);

  const old = JSON.parse(text);
  delete old.data.settings.productTypes;
  const legacy = await startedApp();
  await legacy.api.importBackup(legacy.file(JSON.stringify(old)));
  assert.deepEqual(offered(legacy), BUILT_IN);
});

/* ---------- The data rules in validation.js ---------- */

test("settings are cleaned when loaded: blanks and repeats go, spaces are tidied, an empty list stays empty, other settings are untouched", () => {
  const { Validation } = loadApp().api;
  const settings = Validation.normalizeSettings({
    businessName: "Shop", productTypes: ["  Gaz  ", "", "gaz", "Électricité", "ELECTRICITE", 7, null, "Rock", "rock"],
  });
  assert.deepEqual(plain(settings.productTypes), ["Gaz", "Électricité", "Rock"], "repeats by capital, accent and spacing are dropped, and so are non-texts");
  // Loading never rewrites a stored value into another one: a stored "Pierre" stays "Pierre" (typing it in Settings is what maps
  // it to the built-in Rock, see addProductType), so nothing a product could be holding is ever changed behind its back.
  assert.deepEqual(plain(Validation.normalizeSettings({ productTypes: ["Rock", "Pierre"] }).productTypes), ["Rock", "Pierre"]);
  assert.equal(settings.businessName, "Shop");
  assert.deepEqual(plain(Validation.normalizeSettings({ productTypes: [] }).productTypes), []);
  for (const notAList of ["Rock", 5, true, null, {}]) {
    const loaded = Validation.normalizeSettings({ businessName: "Shop", productTypes: notAList });
    assert.equal("productTypes" in loaded, false, "something that is not a list is not carried over: " + JSON.stringify(notAList));
    assert.equal(Validation.settingsProblem(loaded), "", "so the settings can still be saved");
  }
});

test("a backup with a damaged list of types is refused with a message; a good one is not", () => {
  const { Validation } = loadApp().api;
  assert.equal(Validation.settingsProblem({ productTypes: ["Rock", "Électricité"] }), "");
  assert.equal(Validation.settingsProblem({ productTypes: [] }), "");
  assert.equal(Validation.settingsProblem({}), "");
  for (const bad of ["Rock", {}, [1], [null], ["x".repeat(61)], Array.from({ length: 101 }, (_, i) => "T" + i)]) {
    assert.match(Validation.settingsProblem({ productTypes: bad }), /product types in the settings/i, JSON.stringify(bad).slice(0, 20));
  }
});

test("the form accepts a type that is on offer, one the product being edited already has, and refuses any other", () => {
  const { Validation } = loadApp().api;
  const raw = { name: "A", productType: "Électricité", coveragePerBox: "1.44", stockUnit: "box", prices: [{ unit: "m2", price: "1000" }] };
  const check = (ctx) => Validation.readProductInput(raw, { products: [], stockFromPurchase: true, ...ctx });
  assert.equal(check({ productTypes: ["Rock", "Électricité"] }).error, undefined, "on offer");
  assert.equal(check({ productTypes: ["Électricité "] }).error, undefined, "compared as stored values");
  assert.equal(check({ productTypes: ["Rock"] }).field, "productType", "not on offer");
  assert.equal(check({ productTypes: [] }).field, "productType", "an empty list offers nothing");
  assert.equal(check({}).field, "productType", "without a list the built-in types are on offer");
  assert.equal(check({ productTypes: ["Rock"], editing: { productType: "Électricité" } }).error, undefined, "the product being edited keeps its own type");
  assert.equal(check({ productTypes: ["Rock"], editing: { productType: "Gaz" } }).field, "productType", "but only its own");
  assert.equal(Validation.readProductInput({ ...raw, productType: "" }, { products: [], stockFromPurchase: true, productTypes: [] }).values.productType, "", "None is always allowed");
  assert.equal(Validation.readProductInput({ ...raw, productType: "Daldosol" }, { products: [], stockFromPurchase: true, productTypes: ["DalleDeSol"] }).values.productType, "DalleDeSol", "an old spelling is read as the current type");
});

test("addProductType, removeProductType and countProductsOfType are pure and exact", () => {
  const { Validation } = loadApp().api;
  const list = ["Rock", "Gaz"];
  assert.deepEqual(plain(Validation.addProductType(list, " Eau ")), { list: ["Rock", "Gaz", "Eau"], value: "Eau" });
  assert.deepEqual(list, ["Rock", "Gaz"], "the list given is not changed");
  assert.deepEqual(plain(Validation.addProductType(list, "pierre")), { error: "duplicate", value: "Rock" });
  assert.deepEqual(plain(Validation.addProductType(["Faience"], "faïence")), { error: "duplicate", value: "Faience" });
  assert.deepEqual(plain(Validation.addProductType([], "الحجر")), { list: ["Rock"], value: "Rock" }, "a built-in type's Arabic name is that type too");
  assert.deepEqual(plain(Validation.removeProductType(list, "Gaz")), ["Rock"]);
  assert.deepEqual(plain(Validation.removeProductType(list, "Missing")), ["Rock", "Gaz"]);
  const products = [{ productType: "Gaz" }, { productType: "Gaz " }, { productType: "Rock" }, {}, null];
  assert.equal(Validation.countProductsOfType(products, "Gaz"), 2);
  assert.equal(Validation.countProductsOfType(products, ""), 0);
  assert.equal(Validation.countProductsOfType([{ productType: "Daldosol" }], "DalleDeSol"), 1, "an old spelling counts as the current type");
});

/* ---------- What the person sees ---------- */

test("built-in types are listed in the language of the app and follow it; custom types stay as typed", async () => {
  const app = await startedApp();
  await typeAndAdd(app, "Électricité");
  assert.match(app.field("productTypeList").innerHTML, /<span class="type-name">Rock<\/span>/);
  await app.api.saveLanguage("fr");   // what the language picker in Settings does: saves, then redraws everything
  assert.match(app.field("productTypeList").innerHTML, /<span class="type-name">Pierre<\/span>/);
  assert.match(app.field("productTypeList").innerHTML, /<span class="type-name">Faïence<\/span>/);
  assert.match(app.field("productTypeList").innerHTML, /<span class="type-name">Électricité<\/span>/, "a type the person added has no translation");
  assert.deepEqual(labels(app).slice(0, 4), ["Dalle de sol", "Faïence", "Porcelaine", "Pierre"], "the product form follows too");
  assert.equal(labels(app).at(-1), "Électricité");
  assert.equal(labels(app).some((text) => /^productType\./.test(text)), false, "no translation key is ever shown as a label");
  assert.match(app.field("pType").innerHTML, /<option value="Électricité">Électricité<\/option>/, "a custom type has no data-i18n, so a language change can never replace it with a key");
  assert.match(app.field("pType").innerHTML, /<option value="Rock" data-i18n="productType\.Rock">Pierre<\/option>/, "a built-in type keeps its data-i18n so the page translates it");
});

test("every row has its own Remove button, named for its type", async () => {
  const app = await startedApp();
  await typeAndAdd(app, "Électricité");
  const html = app.field("productTypeList").innerHTML;
  assert.equal((html.match(/data-action="remove-type"/g) || []).length, BUILT_IN.length + 1);
  assert.match(html, /aria-label="Remove the type Électricité"[^>]*>Remove<\/button>/);
  assert.match(html, /<li class="type-row" data-type="Électricité">/);
});

test("the Settings form has a large primary Add button that submits the form, so Enter in the box adds too", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const panel = html.slice(html.indexOf('id="productTypesPanel"'), html.indexOf("<!-- Where the data is kept"));
  assert.match(panel, /<form class="type-add" id="productTypeForm" novalidate>/);
  assert.match(panel, /<button type="submit" class="btn primary" id="addProductType"/);
  assert.match(panel, /<input type="text" id="productTypeInput"/);
  assert.match(panel, /<ul class="type-list" id="productTypeList">/);
  const businessFormEnds = html.indexOf("</form>", html.indexOf('<form id="settingsForm"'));
  assert.ok(html.indexOf('id="productTypesPanel"') > businessFormEnds, "it is not inside the business details form (whose Save button it must not trigger)");
});

test("a failed save shows the reason next to the box and leaves the list as it was", async () => {
  const app = await startedApp();
  await app.api.db.close();   // the database is gone: nothing can be saved
  app.field("productTypeInput").value = "Électricité";
  await app.api.submitProductType();
  assert.notEqual(app.errorText("productTypeError"), "", "the reason is shown");
  assert.equal(app.field("productTypeInput").value, "Électricité", "what was typed is kept");
  assert.equal(offered(app).includes("Électricité"), false);
});

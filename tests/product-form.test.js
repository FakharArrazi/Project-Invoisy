"use strict";

// The Add / Edit product form: which fields exist, which ones are marked mandatory (*), and that the marks
// agree with what the application really requires.

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./helpers/app");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const formHtml = html.slice(html.indexOf('<form id="productForm"'), html.indexOf("</form>", html.indexOf('<form id="productForm"')));

const FIELDS = ["pName", "pManufacturer", "pTileSize", "pDesc", "pPrice", "pPriceUnit", "pCost", "pStock", "pStockUnit", "pSku", "pCoveragePerBox", "pCategory"];
const valid = (extra) => ({
  pName: "Tile", pManufacturer: "", pTileSize: "60*60", pCoveragePerBox: "1.44", pDesc: "", pPrice: "800", pPriceUnit: "piece",
  pCost: "", pStock: "5", pStockUnit: "piece", pSku: "", pCategory: "", ...extra,
});

function fillForm(app, values) {
  for (const id of FIELDS) app.field(id).value = values[id] === undefined ? "" : values[id];
  return app.api.readProductForm();
}

// Opens a product in the form like a click on Edit does. A real <input> turns whatever is assigned to it into
// text, so the stand-in elements are made to do the same before the form is read back.
function openEdit(app, id) {
  app.api.startEditProduct(id);
  for (const field of FIELDS) app.field(field).value = String(app.field(field).value);
}

// ids of the inputs whose label carries a "*" in the page, and the ones that are optional.
const markedIds = [...formHtml.matchAll(/<label for="(\w+)">(?:(?!<\/label>)[^])*?class="req"[^>]*>\*<\/span>/g)].map((m) => m[1]);

test("the Manufacturer field is a plain, optional text input right after Product name", () => {
  assert.match(formHtml, /<input type="text" id="pManufacturer" autocomplete="off">/, "a simple text input");
  assert.match(formHtml, /<label for="pManufacturer" data-i18n="stock\.manufacturer">Manufacturer<\/label>/);
  assert.ok(formHtml.indexOf('id="pName"') < formHtml.indexOf('id="pManufacturer"'), "after the product name");
  assert.ok(formHtml.indexOf('id="pManufacturer"') < formHtml.indexOf('id="pTileSize"'), "before the tile size");
  assert.doesNotMatch(formHtml, /id="pManufacturer"[^>]*(aria-required|required|list=)/, "not required, no suggestions");
  assert.ok(!markedIds.includes("pManufacturer"), "no mandatory asterisk");

  const app = loadApp();
  const without = fillForm(app, valid());
  assert.equal(without.error, undefined, "a product can be saved without a manufacturer");
  assert.equal(without.values.manufacturer, "");
  const withOne = fillForm(app, valid({ pManufacturer: "  VEGA  " }));
  assert.equal(withOne.error, undefined);
  assert.equal(withOne.values.manufacturer, "VEGA", "any text is accepted; surrounding spaces are trimmed");
  assert.equal(fillForm(app, valid({ pManufacturer: "Porcelanosa" })).values.manufacturer, "Porcelanosa");
});

test("the Manufacturer label exists in English and French", () => {
  const lang = (file) => fs.readFileSync(path.join(__dirname, "..", "java script", "lang", file), "utf8");
  assert.match(lang("en.js"), /"stock\.manufacturer": "Manufacturer"/);
  assert.match(lang("fr.js"), /"stock\.manufacturer": "Fabricant"/);
});

test("the Tile size field keeps working but no longer shows an example", () => {
  assert.match(formHtml, /<input type="text" id="pTileSize"/);
  assert.doesNotMatch(formHtml, /60\s*(\*|by|x|×)\s*120/i);
  assert.doesNotMatch(formHtml, /placeholder="60/);
  const tileLabel = formHtml.match(/<label for="pTileSize"[^]*?<\/label>/)[0];
  assert.doesNotMatch(tileLabel, /example|small/i);
  const app = loadApp();
  assert.equal(fillForm(app, valid({ pTileSize: "60 x 120 cm" })).values.tileSize, "60*120", "still parsed and normalised");
  assert.equal(fillForm(app, valid({ pTileSize: "banana" })).field, "pTileSize", "still validated");
  assert.equal(fillForm(app, valid({ pTileSize: "" })).error, undefined, "still optional");
});

test("no field is labelled (optional); mandatory fields carry a small asterisk instead", () => {
  assert.doesNotMatch(formHtml, /optional|facultatif/i);
  assert.doesNotMatch(formHtml, /data-i18n="stock\.optional"/);
  assert.ok(markedIds.length > 0);
  // the asterisk is decorative: the control itself says it is required to assistive technology
  assert.match(formHtml, /id="pName"[^>]*aria-required="true"/);
  assert.match(formHtml, /id="pPrice"[^>]*aria-required="true"/);
  assert.match(formHtml, /id="pPriceUnit"[^>]*aria-required="true"/);
  assert.match(formHtml, /id="pStockUnit"[^>]*aria-required="true"/);
});

test("the asterisks are exactly the fields the validation really requires", () => {
  const app = loadApp();
  // blank each field on an otherwise valid form (price per piece): it is mandatory only if the form is then refused for that field
  const mandatory = FIELDS.filter((id) => {
    const result = fillForm(app, valid({ [id]: "" }));
    return result.error !== undefined && result.field === id;
  });
  assert.deepEqual(mandatory.sort(), ["pName", "pPrice", "pPriceUnit", "pStockUnit"]);
  // coverage per box is mandatory only for a price per m², so its * is switched on and off with the price unit
  assert.equal(fillForm(app, valid({ pPriceUnit: "m2", pStockUnit: "box", pCoveragePerBox: "" })).field, "pCoveragePerBox");
  assert.match(formHtml, /id="coverageReq"[^>]*hidden/, "hidden until the price is per m²");

  // what the page marks (always-on marks) equals what is mandatory regardless of the price unit
  assert.deepEqual([...markedIds].sort(), ["pName", "pPrice", "pPriceUnit", "pStockUnit"].sort().concat(["pCoveragePerBox"]).sort());
});

test("the coverage asterisk follows the selling price unit", () => {
  const app = loadApp();
  app.api.syncCoverageMark();
  assert.equal(app.field("coverageReq").hidden, true);
  app.field("pPriceUnit").value = "m2";
  app.api.syncCoverageMark();
  assert.equal(app.field("coverageReq").hidden, false);
  app.field("pPriceUnit").value = "kg";
  app.api.syncCoverageMark();
  assert.equal(app.field("coverageReq").hidden, true);
});

test("every mandatory field is refused when empty, with its own message", () => {
  const app = loadApp();
  assert.equal(fillForm(app, valid({ pName: "  " })).error, "Product name is required.");
  assert.equal(fillForm(app, valid({ pPrice: "" })).field, "pPrice");
  assert.equal(fillForm(app, valid({ pPriceUnit: "" })).field, "pPriceUnit");
  assert.equal(fillForm(app, valid({ pStockUnit: "" })).field, "pStockUnit");
  assert.equal(fillForm(app, valid({ pStock: "" })).values.stock, 0, "an empty stock quantity is accepted as 0, so it is not marked");
});

test("create with and without a manufacturer, edit it, change it, clear it, and keep it after a reload", async () => {
  const app = loadApp();
  assert.equal((await app.start()).mode, "ready");

  // created with a manufacturer
  const a = fillForm(app, valid({ pName: "Marble", pSku: "M-1", pManufacturer: "VEGA" }));
  await app.api.addProduct(a.values);
  // created without one
  const b = fillForm(app, valid({ pName: "Plain", pSku: "P-1" }));
  await app.api.addProduct(b.values);
  const byName = (api, name) => api.getState().products.find((p) => p.name === name);
  assert.equal(byName(app.api, "Marble").manufacturer, "VEGA");
  assert.equal(byName(app.api, "Plain").manufacturer, "");
  assert.equal(app.api.productLabel(byName(app.api, "Marble")), "Marble — 60*60 — VEGA");

  // Edit shows the saved value; a product without one shows an empty field
  openEdit(app, byName(app.api, "Marble").id);
  assert.equal(app.field("pManufacturer").value, "VEGA");
  openEdit(app, byName(app.api, "Plain").id);
  assert.equal(app.field("pManufacturer").value, "");

  // Change it
  const marbleId = byName(app.api, "Marble").id;
  openEdit(app, marbleId);
  app.field("pManufacturer").value = "Porcelanosa";
  const changed = app.api.readProductForm();
  assert.equal(changed.error, undefined, changed.error);
  await app.api.updateProduct(marbleId, changed.values);
  assert.equal(byName(app.api, "Marble").manufacturer, "Porcelanosa");

  // Editing something else leaves it alone
  openEdit(app, marbleId);
  app.field("pPrice").value = "950";
  await app.api.updateProduct(marbleId, app.api.readProductForm().values);
  assert.equal(byName(app.api, "Marble").manufacturer, "Porcelanosa");
  assert.equal(byName(app.api, "Marble").sellingPrice, 950);

  // Add a manufacturer to the product that had none
  const plainId = byName(app.api, "Plain").id;
  openEdit(app, plainId);
  app.field("pManufacturer").value = "Garnada";
  await app.api.updateProduct(plainId, app.api.readProductForm().values);
  assert.equal(byName(app.api, "Plain").manufacturer, "Garnada");

  // It is still there after a reload (a new page on the same IndexedDB)
  const reloaded = loadApp({ indexedDB: app.indexedDB });
  await reloaded.start();
  assert.equal(byName(reloaded.api, "Marble").manufacturer, "Porcelanosa");
  assert.equal(byName(reloaded.api, "Plain").manufacturer, "Garnada");
  openEdit(reloaded, marbleId);
  assert.equal(reloaded.field("pManufacturer").value, "Porcelanosa", "shown again when editing after the reload");

  // Clear it
  reloaded.field("pManufacturer").value = "   ";
  const cleared = reloaded.api.readProductForm();
  assert.equal(cleared.error, undefined, cleared.error);
  await reloaded.api.updateProduct(marbleId, cleared.values);
  assert.equal(byName(reloaded.api, "Marble").manufacturer, "");
  const again = loadApp({ indexedDB: app.indexedDB });
  await again.start();
  assert.equal(byName(again.api, "Marble").manufacturer, "", "the cleared value is what is saved");
  assert.equal(byName(again.api, "Plain").manufacturer, "Garnada");
});

test("the manufacturer is part of a backup and comes back after a restore", async () => {
  const app = loadApp();
  await app.start();
  await app.api.addProduct(fillForm(app, valid({ pName: "Marble", pSku: "M-1", pManufacturer: "VEGA" })).values);
  await app.api.addProduct(fillForm(app, valid({ pName: "Plain", pSku: "P-1" })).values);
  await app.api.exportBackup();
  const text = await app.downloadedText();
  const backup = JSON.parse(text);
  assert.equal(backup.data.products.find((p) => p.name === "Marble").manufacturer, "VEGA");

  const target = loadApp();
  await target.start();
  await target.api.importBackup(target.file(text));
  const restored = target.api.getState().products;
  assert.equal(restored.find((p) => p.name === "Marble").manufacturer, "VEGA");
  assert.equal(restored.find((p) => p.name === "Plain").manufacturer, "");
  openEdit(target, restored.find((p) => p.name === "Marble").id);
  assert.equal(target.field("pManufacturer").value, "VEGA");
});

test("a product saved before the field existed (no manufacturer at all) still loads, edits and saves", async () => {
  // a backup whose product has no "manufacturer" key, like data saved by an older version
  const source = loadApp();
  await source.start();
  await source.api.addProduct(fillForm(source, valid({ pName: "Old tile", pSku: "O-1" })).values);
  await source.api.exportBackup();
  const backup = JSON.parse(await source.downloadedText());
  delete backup.data.products[0].manufacturer;
  assert.equal("manufacturer" in backup.data.products[0], false);

  const app = loadApp();
  await app.start();
  await app.api.importBackup(app.file(JSON.stringify(backup)));
  const old = app.api.getState().products[0];
  assert.equal(old.name, "Old tile");
  assert.equal(old.manufacturer, "", "a missing manufacturer reads as empty");
  assert.equal(app.api.productLabel(old), "Old tile — 60*60", "no stray 'undefined' in labels");
  assert.equal(app.api.findMatches("undefined").length, 0, "the search text never contains the word 'undefined'");

  openEdit(app, old.id);
  assert.equal(app.field("pManufacturer").value, "", "the field is empty, not 'undefined'");
  app.field("pPrice").value = "900";
  const edited = app.api.readProductForm();
  assert.equal(edited.error, undefined, edited.error);
  await app.api.updateProduct(old.id, edited.values);
  assert.equal(app.api.getState().products[0].sellingPrice, 900);
  assert.equal(app.api.getState().products[0].manufacturer, "");
});

test("a product saved with a manufacturer by the previous version is still shown, searched and kept", async () => {
  const app = loadApp();
  assert.equal((await app.start()).mode, "ready");
  await app.api.addProduct({
    name: "Golden Era", manufacturer: "Garnada", tileSize: "60*120", coveragePerBox: 2.88, description: "", sku: "GE-1",
    category: "", sellingPrice: 1000, priceUnit: "m2", stockUnit: "box", purchasePrice: null, stock: 4,
  });
  const saved = app.api.getState().products[0];
  assert.equal(saved.manufacturer, "Garnada");
  assert.equal(app.api.productLabel(saved), "Golden Era — 60*120 — Garnada");
  assert.equal(app.api.findMatches("garnada").length, 1, "found by manufacturer");
});

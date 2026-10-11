"use strict";

// The Add / Edit product form: its three sections, which fields exist, which ones are marked mandatory (*), how the
// selling price rows behave, and that the marks agree with what the application really requires.

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./helpers/app");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const formStart = html.indexOf('<form id="productForm"');
const formHtml = html.slice(formStart, html.indexOf("</form>", formStart));

// Plain fields of the form (the selling prices are rows, see priceRows below).
const FIELDS = ["pName", "pManufacturer", "pTileSize", "pDesc", "pCost", "pStock", "pStockUnit", "pSku", "pCoveragePerBox", "pCategory"];
const valid = (extra) => ({
  pName: "Tile", pManufacturer: "", pTileSize: "60*60", pCoveragePerBox: "1.44", pDesc: "", pCost: "", pStock: "5",
  pStockUnit: "piece", pSku: "", pCategory: "", priceRows: [{ unit: "piece", price: "800" }], ...extra,
});

function fillForm(app, values) {
  for (const id of FIELDS) app.field(id).value = values[id] === undefined ? "" : values[id];
  app.api.setPriceRows(values.priceRows);
  return app.api.readProductForm();
}

const plain = (value) => JSON.parse(JSON.stringify(value));   // the app runs in its own context: compare plain data
// A real input turns whatever is assigned to .value into text; the stand-in page does not, so do it here.
const asTyped = (app) => { for (const id of FIELDS) app.field(id).value = String(app.field(id).value); };
// Opens a product in the form like a click on Edit does; the stand-in elements turn assigned values into text like a real input.
function openEdit(app, id) {
  app.api.startEditProduct(id);
  asTyped(app);
}
const rowUnits = (app) => plain(app.api.getState().priceRows.map((r) => r.unit));
const rowPairs = (app) => plain(app.api.getState().priceRows.map((r) => [r.unit, r.price]));
const idOf = (app, index, part) => `${part === "unit" ? "priceUnit" : "priceValue"}-${app.api.getState().priceRows[index].rowId}`;

// ids of the inputs whose label carries a "*" in the page.
const markedIds = [...formHtml.matchAll(/<label for="(\w+)">(?:(?!<\/label>)[^])*?class="req"[^>]*>\*<\/span>/g)].map((m) => m[1]);

/* ---------- Sections and fields ---------- */

test("the form has three sections, and each field is in the right one", () => {
  const sections = [...formHtml.matchAll(/<fieldset class="form-section">\s*<legend[^>]*>([^]*?)<\/legend>([^]*?)<\/fieldset>/g)]
    .map((m) => ({ legend: m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(), body: m[2] }));
  assert.deepEqual(sections.map((s) => s.legend.replace(/ \*$/, "")), ["Product information", "Selling prices", "Stock information"]);
  const has = (section, id) => new RegExp(`id="${id}"`).test(section.body);
  for (const id of ["pName", "pManufacturer", "pTileSize", "pSku", "pCategory", "pDesc"]) assert.ok(has(sections[0], id), `${id} is in Product information`);
  for (const id of ["priceRows", "addPriceRow"]) assert.ok(has(sections[1], id), `${id} is in Selling prices`);
  for (const id of ["pStock", "pStockUnit", "pCoveragePerBox", "pCost"]) assert.ok(has(sections[2], id), `${id} is in Stock information`);
  // the old single price controls are gone: prices are rows now
  assert.doesNotMatch(formHtml, /id="pPrice"|id="pPriceUnit"/);
});

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
  assert.equal((lang("en.js").match(/"stock\.manufacturer"/g) || []).length, 1, "the key is defined once");
  assert.equal((lang("fr.js").match(/"stock\.manufacturer"/g) || []).length, 1, "the key is defined once");
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

test("a tile's size is never used as its box coverage: the two fields are read separately", () => {
  const app = loadApp();
  const form = fillForm(app, valid({ pTileSize: "60*120", pCoveragePerBox: "" }));
  assert.equal(form.values.tileSize, "60*120");
  assert.equal(form.values.coveragePerBox, null, "blank until the person enters it: nothing is invented");
});

test("no field is labelled (optional); mandatory fields carry a small asterisk instead", () => {
  assert.doesNotMatch(formHtml, /optional|facultatif/i);
  assert.doesNotMatch(formHtml, /data-i18n="stock\.optional"/);
  assert.ok(markedIds.length > 0);
  // the asterisk is decorative: the control itself says it is required to assistive technology
  assert.match(formHtml, /id="pName"[^>]*aria-required="true"/);
  assert.match(formHtml, /id="pStockUnit"[^>]*aria-required="true"/);
  const app = loadApp();
  app.api.setPriceRows([{ unit: "m2", price: "" }, { unit: "piece", price: "" }]);
  const rows = app.field("priceRows").innerHTML;
  assert.match(rows, /id="priceValue-\d+"[^>]*aria-required="true"/, "the first price is required");
  assert.equal((rows.match(/aria-required="true"/g) || []).length, 1, "only the first price row is required; the others are extra");
});

test("the asterisks are exactly the fields the validation really requires", () => {
  const app = loadApp();
  // blank each plain field on an otherwise valid form: it is mandatory only if the form is then refused for that field
  const mandatory = FIELDS.filter((id) => {
    const result = fillForm(app, valid({ [id]: "" }));
    return result.error !== undefined && result.field === id;
  });
  assert.deepEqual(mandatory.sort(), ["pName", "pStockUnit"]);
  // the selling price (first row) is mandatory too
  assert.equal(fillForm(app, valid({ priceRows: [{ unit: "piece", price: "" }] })).field, idOf(app, 0, "price"));
  // coverage per box is mandatory only when a price is per m², so its * is switched on and off with the prices
  assert.equal(fillForm(app, valid({ priceRows: [{ unit: "m2", price: "800" }], pStockUnit: "box", pCoveragePerBox: "" })).field, "pCoveragePerBox");
  assert.match(formHtml, /id="coverageReq"[^>]*hidden/, "hidden until a price is per m²");

  // what the page marks with a label asterisk, plus the first price row, equals what is mandatory
  assert.deepEqual([...markedIds].sort(), ["pCoveragePerBox", "pName", "pStockUnit"]);
});

test("the coverage asterisk follows the price units: shown while any price is per m²", () => {
  const app = loadApp();
  app.api.setPriceRows([{ unit: "piece", price: "" }]);
  assert.equal(app.field("coverageReq").hidden, true);
  app.api.setPriceRows([{ unit: "piece", price: "300" }, { unit: "m2", price: "1000" }]);
  assert.equal(app.field("coverageReq").hidden, false, "any m² price needs a coverage per box");
  app.api.setPriceRows([{ unit: "kg", price: "50" }]);
  assert.equal(app.field("coverageReq").hidden, true);
});

test("every mandatory field is refused when empty, with its own message", () => {
  const app = loadApp();
  assert.equal(fillForm(app, valid({ pName: "  " })).error, "Product name is required.");
  assert.equal(fillForm(app, valid({ priceRows: [{ unit: "piece", price: "" }] })).field, idOf(app, 0, "price"));
  assert.equal(fillForm(app, valid({ priceRows: [{ unit: "", price: "800" }] })).field, idOf(app, 0, "unit"));
  assert.equal(fillForm(app, valid({ pStockUnit: "" })).field, "pStockUnit");
  assert.equal(fillForm(app, valid({ pStock: "" })).values.stock, 0, "an empty stock quantity is accepted as 0, so it is not marked");
});

/* ---------- Defaults ---------- */

test("a new product starts with a price per m² and stock counted in boxes, with coverage and stock quantity left alone", () => {
  assert.match(formHtml, /<option value="box" selected/, "stock unit defaults to boxes");
  assert.match(formHtml, /id="pStock"[^>]*value="0"/, "stock quantity follows the existing convention (0)");
  assert.doesNotMatch(formHtml, /id="pCoveragePerBox"[^>]*value=/, "coverage is blank until entered");
  const app = loadApp();
  app.api.setPriceRows();
  assert.deepEqual(rowPairs(app), [["m2", ""]]);
});

/* ---------- Price rows ---------- */

test("rows are added one unit at a time, never twice for a unit, and at least one stays", () => {
  const app = loadApp();
  app.api.setPriceRows([{ unit: "m2", price: "1000" }]);
  assert.equal(app.field("addPriceRow").disabled, false);
  app.api.addPriceRow();
  assert.deepEqual(rowUnits(app), ["m2", "piece"], "the next unused unit of the same kind");
  app.api.addPriceRow();
  assert.deepEqual(rowUnits(app), ["m2", "piece", "box"]);
  assert.equal(app.field("addPriceRow").disabled, true, "piece, box and m² all have a price: nothing left to add");
  assert.equal(app.api.addPriceRow(), null);
  assert.equal(rowUnits(app).length, 3);

  // a unit already on another row can't be chosen again
  const second = app.api.getState().priceRows[1];
  app.api.setPriceRowUnit(second.rowId, "box");
  assert.deepEqual(rowUnits(app), ["m2", "piece", "box"], "refused: the unit stays as it was");
  assert.match(app.field("productError").textContent, /already has a price/);
  assert.match(app.field("priceRows").innerHTML, /<option value="box" disabled>/, "and it is greyed out in the other rows");

  // removing keeps the others, and the last row can't be removed
  assert.equal(app.api.removePriceRow(second.rowId), true);
  assert.deepEqual(rowUnits(app), ["m2", "box"]);
  assert.equal(app.api.removePriceRow(app.api.getState().priceRows[0].rowId), true);
  assert.deepEqual(rowUnits(app), ["box"]);
  assert.equal(app.api.removePriceRow(app.api.getState().priceRows[0].rowId), false, "at least one price remains");
  assert.deepEqual(rowUnits(app), ["box"]);
  assert.match(app.field("priceRows").innerHTML, /data-action="remove-price"[^>]*disabled/);
});

test("kg and meter prices stand alone: no second row can be added, and the unit kinds are not mixed", () => {
  const app = loadApp();
  app.api.setPriceRows([{ unit: "kg", price: "50" }]);
  assert.equal(app.field("addPriceRow").disabled, true);
  assert.equal(app.api.nextPriceUnit(), null);
  // a hand-built mix (kg with m²) is refused when saving, not saved
  const mixed = fillForm(app, valid({ pStockUnit: "kg", priceRows: [{ unit: "kg", price: "50" }, { unit: "m2", price: "1000" }] }));
  assert.equal(mixed.field, idOf(app, 1, "unit"));
  assert.match(mixed.error, /same kind/);
});

test("each row is labelled with its unit: Price per m², Price per piece, Price per box", () => {
  const app = loadApp();
  app.api.setPriceRows([{ unit: "m2", price: "1000" }, { unit: "piece", price: "300" }, { unit: "box", price: "1440" }]);
  const rows = app.field("priceRows").innerHTML;
  for (const label of ["Price per m²", "Price per piece", "Price per box"]) assert.ok(rows.includes(label), label);
  assert.ok(rows.includes('value="1000"') && rows.includes('value="300"') && rows.includes('value="1440"'), "each price shows its own value");
});

test("the form reads one independent price per unit, and the first price is the main one", () => {
  const app = loadApp();
  const form = fillForm(app, valid({ pStockUnit: "box", priceRows: [{ unit: "m2", price: "1000" }, { unit: "piece", price: "300" }, { unit: "box", price: "1440" }] }));
  assert.equal(form.error, undefined, form.error);
  assert.deepEqual(JSON.parse(JSON.stringify(form.values.sellingPrices)), [{ unit: "m2", price: 1000 }, { unit: "piece", price: 300 }, { unit: "box", price: 1440 }]);
  assert.equal(form.values.sellingPrice, 1000, "the older single-price fields mirror the first entry");
  assert.equal(form.values.priceUnit, "m2");
});

test("invalid price entries are refused with a message for that row, never saved as 0", () => {
  const app = loadApp();
  const bad = (rows, stock = "box") => fillForm(app, valid({ pStockUnit: stock, priceRows: rows }));
  const empty = bad([{ unit: "m2", price: "1000" }, { unit: "piece", price: "" }]);
  assert.equal(empty.field, idOf(app, 1, "price"));
  assert.equal(empty.error, "Enter the price per piece.");
  const negative = bad([{ unit: "m2", price: "1000" }, { unit: "piece", price: "-5" }]);
  assert.equal(negative.field, idOf(app, 1, "price"));
  assert.equal(negative.error, "The price per piece can't be negative.");
  const nan = bad([{ unit: "m2", price: "abc" }]);
  assert.equal(nan.field, idOf(app, 0, "price"));
  const infinite = bad([{ unit: "m2", price: "Infinity" }]);
  assert.equal(infinite.field, idOf(app, 0, "price"));
  const dup = bad([{ unit: "m2", price: "1000" }, { unit: "m2", price: "900" }]);
  assert.equal(dup.field, idOf(app, 1, "unit"));
  assert.equal(dup.error, "There are two prices per m². Each unit can have only one price.");
  assert.equal(bad([{ unit: "m2", price: "0" }]).error, undefined, "a price of 0 is a valid number");
});

test("the stock unit must be of the same kind as the prices", () => {
  const app = loadApp();
  const result = fillForm(app, valid({ pStockUnit: "kg", priceRows: [{ unit: "m2", price: "1000" }, { unit: "piece", price: "300" }] }));
  assert.equal(result.field, "pStockUnit");
  assert.equal(result.error, "Stock counted in kg doesn't match a price per m².");
});

/* ---------- Editing and the manufacturer through the product's life ---------- */

test("a product saved with a manufacturer loads, edits, and keeps that data; new products have none", async () => {
  const app = loadApp();
  assert.equal((await app.start()).mode, "ready");
  const old = {
    name: "Golden Era", manufacturer: "Garnada", tileSize: "60*120", coveragePerBox: 2.88, description: "", sku: "GE-1",
    category: "", sellingPrice: 1000, priceUnit: "m2", stockUnit: "box", purchasePrice: null, stock: 4,
  };
  await app.api.addProduct(old);
  const saved = app.api.getState().products[0];
  assert.equal(saved.manufacturer, "Garnada");
  assert.equal(app.api.productLabel(saved), "Golden Era — 60*120 — Garnada", "existing data is still shown");

  app.api.startEditProduct(saved.id);
  assert.equal(app.field("pManufacturer").value, "Garnada", "the editor shows the saved manufacturer");
  assert.deepEqual(rowUnits(app), ["m2"], "an old single price is shown as one m² row");
  assert.equal(app.api.getState().priceRows[0].price, "1000");

  // saving the form as it stands changes nothing about the manufacturer
  asTyped(app);
  const untouched = app.api.readProductForm();
  assert.equal(untouched.error, undefined, untouched.error);
  assert.equal(untouched.values.manufacturer, "Garnada");

  const form = fillForm(app, valid({
    pName: "Golden Era 2", pManufacturer: "Garnada", pStockUnit: "box", pCoveragePerBox: "2.88", pTileSize: "60*120", pSku: "GE-1",
    priceRows: [{ unit: "m2", price: "1100" }],
  }));
  assert.equal(form.error, undefined, form.error);
  await app.api.updateProduct(saved.id, form.values);
  const edited = app.api.getState().products[0];
  assert.equal(edited.name, "Golden Era 2");
  assert.equal(edited.manufacturer, "Garnada", "editing never wipes the stored manufacturer");

  // the manufacturer can also be changed, and found by search
  app.api.startEditProduct(saved.id);
  app.field("pManufacturer").value = "Garnada Ceramics";
  asTyped(app);
  await app.api.updateProduct(saved.id, app.api.readProductForm().values);
  assert.equal(app.api.getState().products[0].manufacturer, "Garnada Ceramics");
  assert.equal(app.api.findMatches("ceramics").length, 1, "found by manufacturer");

  const reloaded = loadApp({ indexedDB: app.indexedDB });
  await reloaded.start();
  assert.equal(reloaded.api.getState().products[0].manufacturer, "Garnada Ceramics");

  const fresh = fillForm(app, valid({ pName: "New one", pSku: "N-1" }));
  await app.api.addProduct(fresh.values);
  const added = app.api.getState().products.find((p) => p.name === "New one");
  assert.equal(added.manufacturer, "", "a new product has no manufacturer unless one is typed");
  assert.equal(app.api.findMatches("undefined").length, 0, "the search text never contains the word 'undefined'");
});

test("editing a product shows each saved price in its own row, and an old product with no price unit keeps its price but asks for a unit", async () => {
  const app = loadApp();
  assert.equal((await app.start()).mode, "ready");
  await app.api.addProduct({
    name: "Multi", tileSize: "60*60", coveragePerBox: 1.44, sku: "M-1", stockUnit: "box", stock: 3, purchasePrice: null,
    sellingPrices: [{ unit: "m2", price: 1000 }, { unit: "piece", price: 300 }, { unit: "box", price: 1440 }], sellingPrice: 1000, priceUnit: "m2",
  });
  const multi = app.api.getState().products[0];
  app.api.startEditProduct(multi.id);
  assert.deepEqual(rowPairs(app), [["m2", "1000"], ["piece", "300"], ["box", "1440"]]);

  // an old product with no price unit: its price is shown, its unit is not guessed
  app.api.applyData({ products: [app.api.normalizeProduct({ id: "legacy", name: "Old", sellingPrice: 120, stock: 5 })], invoices: [], settings: { ...app.api.DEFAULT_SETTINGS }, counter: 0, lastSaved: "" });
  app.api.startEditProduct("legacy");
  assert.deepEqual(rowPairs(app), [["", "120"]]);
  asTyped(app);
  assert.equal(app.api.readProductForm().field, idOf(app, 0, "unit"), "a unit has to be chosen before it can be saved");
});

/* ---------- Manufacturer through the product's life (kept from the upstream tests, on price rows) ---------- */

const setMainPrice = (app, value) => { app.api.getState().priceRows[0].price = value; };

test("create with and without a manufacturer, edit it, change it, clear it, and keep it after a reload", async () => {
  const app = loadApp();
  assert.equal((await app.start()).mode, "ready");

  const a = fillForm(app, valid({ pName: "Marble", pSku: "M-1", pManufacturer: "VEGA" }));
  await app.api.addProduct(a.values);
  const b = fillForm(app, valid({ pName: "Plain", pSku: "P-1" }));
  await app.api.addProduct(b.values);
  const byName = (api, name) => api.getState().products.find((p) => p.name === name);
  assert.equal(byName(app.api, "Marble").manufacturer, "VEGA");
  assert.equal(byName(app.api, "Plain").manufacturer, "");
  assert.equal(app.api.productLabel(byName(app.api, "Marble")), "Marble — 60*60 — VEGA");

  openEdit(app, byName(app.api, "Marble").id);
  assert.equal(app.field("pManufacturer").value, "VEGA");
  openEdit(app, byName(app.api, "Plain").id);
  assert.equal(app.field("pManufacturer").value, "");

  const marbleId = byName(app.api, "Marble").id;
  openEdit(app, marbleId);
  app.field("pManufacturer").value = "Porcelanosa";
  const changed = app.api.readProductForm();
  assert.equal(changed.error, undefined, changed.error);
  await app.api.updateProduct(marbleId, changed.values);
  assert.equal(byName(app.api, "Marble").manufacturer, "Porcelanosa");

  // editing something else leaves it alone
  openEdit(app, marbleId);
  setMainPrice(app, "950");
  await app.api.updateProduct(marbleId, app.api.readProductForm().values);
  assert.equal(byName(app.api, "Marble").manufacturer, "Porcelanosa");
  assert.equal(byName(app.api, "Marble").sellingPrice, 950);

  const plainId = byName(app.api, "Plain").id;
  openEdit(app, plainId);
  app.field("pManufacturer").value = "Garnada";
  await app.api.updateProduct(plainId, app.api.readProductForm().values);
  assert.equal(byName(app.api, "Plain").manufacturer, "Garnada");

  const reloaded = loadApp({ indexedDB: app.indexedDB });
  await reloaded.start();
  assert.equal(byName(reloaded.api, "Marble").manufacturer, "Porcelanosa");
  assert.equal(byName(reloaded.api, "Plain").manufacturer, "Garnada");
  openEdit(reloaded, marbleId);
  assert.equal(reloaded.field("pManufacturer").value, "Porcelanosa", "shown again when editing after the reload");

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
  setMainPrice(app, "900");
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

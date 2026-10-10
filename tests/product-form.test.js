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

const FIELDS = ["pName", "pTileSize", "pDesc", "pPrice", "pPriceUnit", "pCost", "pStock", "pStockUnit", "pSku", "pCoveragePerBox", "pCategory"];
const valid = (extra) => ({
  pName: "Tile", pTileSize: "60*60", pCoveragePerBox: "1.44", pDesc: "", pPrice: "800", pPriceUnit: "piece",
  pCost: "", pStock: "5", pStockUnit: "piece", pSku: "", pCategory: "", ...extra,
});

function fillForm(app, values) {
  for (const id of FIELDS) app.field(id).value = values[id] === undefined ? "" : values[id];
  return app.api.readProductForm();
}

// ids of the inputs whose label carries a "*" in the page, and the ones that are optional.
const markedIds = [...formHtml.matchAll(/<label for="(\w+)">(?:(?!<\/label>)[^])*?class="req"[^>]*>\*<\/span>/g)].map((m) => m[1]);

test("the Manufacturer / Brand field is gone from the form, and nothing in it asks for one", () => {
  assert.doesNotMatch(formHtml, /pManufacturer/);
  assert.doesNotMatch(formHtml, /manufacturer/i);
  assert.doesNotMatch(formHtml, /brand/i);
  const app = loadApp();
  assert.equal("manufacturer" in fillForm(app, valid()).values, false, "the form no longer reads a manufacturer");
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

test("a product saved with a manufacturer still loads, edits, and keeps that data; new products have none", async () => {
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

  app.api.startEditProduct(saved.id);                                    // must not need the removed field
  const form = fillForm(app, valid({ pName: "Golden Era 2", pPrice: "1100", pPriceUnit: "m2", pStockUnit: "box", pCoveragePerBox: "2.88", pTileSize: "60*120", pSku: "GE-1" }));
  assert.equal(form.error, undefined, form.error);
  await app.api.updateProduct(saved.id, form.values);
  const edited = app.api.getState().products[0];
  assert.equal(edited.name, "Golden Era 2");
  assert.equal(edited.manufacturer, "Garnada", "editing never wipes the stored manufacturer");

  const reloaded = loadApp({ indexedDB: app.indexedDB });
  await reloaded.start();
  assert.equal(reloaded.api.getState().products[0].manufacturer, "Garnada");

  const fresh = fillForm(app, valid({ pName: "New one", pSku: "N-1" }));
  await app.api.addProduct(fresh.values);
  const added = app.api.getState().products.find((p) => p.name === "New one");
  assert.equal(added.manufacturer, "", "a new product has no manufacturer");
  assert.equal(app.api.findMatches("undefined").length, 0, "the search text never contains the word 'undefined'");
});

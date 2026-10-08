"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadProductApi() {
  const fields = new Map();
  const element = (id) => {
    if (!fields.has(id)) fields.set(id, {
      id,
      value: "",
      textContent: "",
      className: "",
      hidden: false,
      dataset: {},
      style: {},
      offsetHeight: 0,
      classList: { toggle() {} },
      reset() {},
      focus() {},
      querySelectorAll() { return []; },
      setAttribute() {},
      removeAttribute() {},
    });
    return fields.get(id);
  };
  const values = new Map();
  const localStorage = {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
  };
  const exports = {};
  const context = {
    __INVOISY_TEST_EXPORTS__: exports,
    console,
    document: {
      getElementById: element,
      querySelectorAll: () => [],
      documentElement: { style: { setProperty() {} } },
    },
    window: {},
    localStorage,
    setTimeout,
    clearTimeout,
    structuredClone,
  };
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, "..", "java script", "script.js"), "utf8");
  vm.runInContext(source, context, { filename: "script.js" });
  return { api: exports, field: element };
}

function ceramic(overrides = {}) {
  return {
    id: "product-" + Math.random().toString(36).slice(2),
    name: "Everton Grey",
    manufacturer: "Timgad Ceramic",
    tileSize: "60 × 120 cm",
    coveragePerBox: 2.88,
    description: "",
    sku: "",
    category: "Tiles",
    sellingPrice: 1000,
    purchasePrice: 800,
    stock: 12,
    ...overrides,
  };
}

test("keeps same-name products from different manufacturers as distinct records", () => {
  const { api } = loadProductApi();
  const first = api.normalizeProduct(ceramic({ id: "timgad" }));
  const second = api.normalizeProduct(ceramic({ id: "other", manufacturer: "Another Ceramic Factory" }));
  const built = api.buildData({ products: [first, second], invoices: [], settings: {}, invoiceCounter: 0 }, true);

  assert.equal(built.data.products.length, 2);
  assert.notEqual(first.id, second.id);
  assert.notEqual(api.productLabel(first), api.productLabel(second));
});

test("keeps same-brand products with different tile sizes as distinct records", () => {
  const { api } = loadProductApi();
  const sixtyByOneTwenty = api.normalizeProduct(ceramic({ id: "60x120" }));
  const sixtyBySixty = api.normalizeProduct(ceramic({ id: "60x60", tileSize: "60 × 60 cm" }));
  const built = api.buildData({ products: [sixtyByOneTwenty, sixtyBySixty], invoices: [], settings: {}, invoiceCounter: 0 }, true);

  assert.equal(built.data.products.length, 2);
  assert.notEqual(sixtyByOneTwenty.tileSize, sixtyBySixty.tileSize);
  assert.notEqual(api.productLabel(sixtyByOneTwenty), api.productLabel(sixtyBySixty));
});

test("stores physical tile dimensions independently from coverage per box", () => {
  const { api } = loadProductApi();
  const product = api.normalizeProduct(ceramic({ tileSize: "60 × 120 cm", coveragePerBox: 2.88 }));

  assert.equal(product.tileSize, "60 × 120 cm");
  assert.equal(product.coveragePerBox, 2.88);
  assert.notEqual(product.tileSize, String(product.coveragePerBox));
  assert.match(api.productLabel(product), /60 × 120 cm/);
});

test("normalizes existing products without ceramic fields without losing their existing data", () => {
  const { api } = loadProductApi();
  const legacy = {
    id: "legacy-1", name: "Existing Product", description: "kept", sku: "OLD-1", category: "Legacy",
    sellingPrice: 15, purchasePrice: 10, stock: 7,
  };
  const built = api.buildData({ products: [legacy], invoices: [], settings: {}, invoiceCounter: 0 }, true);
  const product = built.data.products[0];

  assert.equal(product.id, "legacy-1");
  assert.equal(product.name, "Existing Product");
  assert.equal(product.stock, 7);
  assert.equal(product.manufacturer, "");
  assert.equal(product.tileSize, "");
  assert.equal(product.coveragePerBox, null);
  assert.equal(product.sellingUnit, undefined);
});

test("validates ceramic form fields and persists a product creation and edit", async () => {
  const { api, field } = loadProductApi();
  const values = {
    pName: "Everton Grey", pManufacturer: "Timgad Ceramic", pTileSize: "60*120",
    pCoveragePerBox: "2.88", pDesc: "", pPrice: "1000", pCost: "800",
    pStock: "12", pSku: "EV-GREY", pCategory: "Tiles",
  };
  for (const [id, value] of Object.entries(values)) field(id).value = value;
  const created = api.readProductForm();

  assert.equal(created.error, undefined);
  assert.equal(created.values.tileSize, "60*120");
  assert.equal(created.values.coveragePerBox, 2.88);
  assert.equal(created.values.sellingUnit, undefined);

  api.applyData({ products: [], invoices: [], settings: { ...api.DEFAULT_SETTINGS }, counter: 0, lastSaved: "" });
  const create = await api.commit((draft) => {
    draft.products.push(api.normalizeProduct({ id: "everton", ...created.values }));
  });
  assert.equal(create.error, undefined);
  const loaded = api.readMirror().data;

  const edit = await api.commit((draft) => {
    Object.assign(draft.products[0], { manufacturer: "Timgad Ceramic Updated", coveragePerBox: 3.12 });
  });
  assert.equal(edit.error, undefined);
  const reloaded = api.readMirror().data.products[0];

  assert.equal(reloaded.manufacturer, "Timgad Ceramic Updated");
  assert.equal(reloaded.tileSize, "60*120");
  assert.equal(reloaded.coveragePerBox, 3.12);

  field("pTileSize").value = "2.88 m²";
  const invalidSize = api.readProductForm();
  assert.equal(invalidSize.field, "pTileSize");
  field("pTileSize").value = "12*15";
  field("pSku").value = "";
  assert.equal(api.readProductForm().values.tileSize, "12*15");
  field("pCoveragePerBox").value = "0";
  const invalidCoverage = api.readProductForm();
  assert.equal(invalidCoverage.field, "pCoveragePerBox");
});

test("accepts any WIDTH*HEIGHT tile size and stores it as 60*120", () => {
  const { api } = loadProductApi();
  for (const ok of ["60*120", "12*15", "60 * 120", "60x120", "60 × 120 cm", "7.5*15"]) assert.equal(api.isTileSize(ok), true, ok);
  for (const bad of ["60", "60*", "abc", "2.88 m²", "60*120*3"]) assert.equal(api.isTileSize(bad), false, bad);
  assert.equal(api.normalizeTileSize("60 x 120"), "60*120");
  assert.equal(api.normalizeTileSize("12 × 15 cm"), "12*15");
});

test("a sale line carries its own selling unit", async () => {
  const { api } = loadProductApi();
  api.applyData({ products: [api.normalizeProduct(ceramic({ id: "t1", stock: 10 }))], invoices: [], settings: { ...api.DEFAULT_SETTINGS }, counter: 0, lastSaved: "" });
  for (const unit of ["piece", "box", "m2", "kg"]) {
    const { api: fresh } = loadProductApi();
    fresh.applyData({ products: [fresh.normalizeProduct(ceramic({ id: "t1", stock: 10 }))], invoices: [], settings: { ...fresh.DEFAULT_SETTINGS }, counter: 0, lastSaved: "" });
    assert.equal(fresh.addToSale("t1", "2", unit).ok, true, unit);
  }
  assert.equal(api.addToSale("t1", "2", "box").ok, true);
  assert.equal(api.addToSale("t1", "1", "box").ok, true);
  assert.equal(api.addToSale("t1", "1", "kg").ok, true);   // a different unit is a separate line
});

test("invoice line reads: name (60 × 120) manufacturer", () => {
  const { api } = loadProductApi();
  assert.equal(api.invoiceItemLabel({ name: "golden era", tileSize: "60*120", manufacturer: "garnada" }), "golden era (60 × 120) garnada");
  assert.equal(api.invoiceItemLabel({ name: "golden era", tileSize: "60 × 120 cm", manufacturer: "garnada" }), "golden era (60 × 120) garnada");
  assert.equal(api.invoiceItemLabel({ name: "Chips", tileSize: "", manufacturer: "" }), "Chips");
});

test("m² is converted to whole boxes (rounded up); piece and kg stay as entered", () => {
  const { api } = loadProductApi();
  const load = () => api.applyData({ products: [api.normalizeProduct(ceramic({ id: "t1", stock: 100, coveragePerBox: 2.88 })), api.normalizeProduct({ id: "k1", name: "Cement", stock: 100, sellingPrice: 5 })], invoices: [], settings: { ...api.DEFAULT_SETTINGS }, counter: 0, lastSaved: "" });
  load();
  const r = api.addToSale("t1", "8", "m2");
  assert.equal(r.ok, true);
  assert.deepEqual({ ...r.converted }, { area: 8, boxes: 3, coverage: 2.88 });
  assert.equal(api.addToSale("t1", "5.76", "m2").converted.boxes, 2);   // exact multiple, no extra box
  assert.equal(api.addToSale("k1", "2", "kg").converted, null);
  assert.match(api.addToSale("k1", "3", "m2").error, /no coverage per box/);
});

test("the same product can be sold as 5 boxes and 2 pieces, sharing one stock pool", () => {
  const { api } = loadProductApi();
  api.applyData({ products: [api.normalizeProduct(ceramic({ id: "t1", stock: 8 }))], invoices: [], settings: { ...api.DEFAULT_SETTINGS }, counter: 0, lastSaved: "" });
  assert.equal(api.addToSale("t1", "5", "box").ok, true);
  assert.equal(api.addToSale("t1", "2", "piece").ok, true);
  const sale = api.getSale();
  assert.equal(sale.items.length, 2);
  assert.equal(JSON.stringify(sale.items.map((i) => [i.qty, i.sellingUnit])), JSON.stringify([[5, "box"], [2, "piece"]]));
  assert.equal(api.addToSale("t1", "2", "box").error.startsWith("Not enough stock"), true);   // 5 + 2 + 2 > 8
  assert.equal(api.addToSale("t1", "1", "box").ok, true);                                    // 6 boxes + 2 pieces = 8
  assert.equal(sale.items[0].qty, 6);
  assert.equal(api.validateSale().filter((e) => /stock/i.test(e)).length, 0);
  // changing a line's unit onto an existing line merges them
  const pieceLine = sale.items.find((i) => i.sellingUnit === "piece");
  assert.equal(api.updateSaleUnit(pieceLine.lineId, "box").merged, true);
  assert.equal(JSON.stringify(sale.items.map((i) => [i.qty, i.sellingUnit])), JSON.stringify([[8, "box"]]));
});

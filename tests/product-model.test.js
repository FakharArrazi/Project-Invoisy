"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { loadProductApi, ceramic } = require("./helpers");

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
    pStock: "12", pStockUnit: "box", pSku: "EV-GREY", pCategory: "Tiles", pPriceUnit: "box",
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

/* ---------- Price unit ---------- */

function loadTile(overrides = {}) {
  const { api, field } = loadProductApi();
  const tile = ceramic({ id: "t1", tileSize: "60*60", coveragePerBox: 1.44, sellingPrice: 800, priceUnit: "m2", stock: 50, ...overrides });
  api.applyData({ products: [api.normalizeProduct(tile)], invoices: [], settings: { ...api.DEFAULT_SETTINGS }, counter: 0, lastSaved: "" });
  return { api, field };
}

test("800 DA per m² with 1.44 m² per box: 1 box = 1,152 DA, 2 boxes = 2,304 DA", () => {
  const { api } = loadTile();
  assert.equal(api.addToSale("t1", "2", "box").ok, true);
  const line = api.getSale().items[0];
  assert.equal(line.unitPrice, 1152);
  const inv = api.buildInvoiceData(api.getSale(), "INV-000001", new Date().toISOString());
  assert.equal(inv.items[0].total, 2304);
  assert.equal(inv.items[0].priceUnit, "m2");
  assert.equal(inv.total, 2304);
});

test("the same m² price gives a per-piece price from the piece size", () => {
  const { api } = loadTile();
  api.addToSale("t1", "5", "piece");
  assert.equal(api.getSale().items[0].unitPrice, 288);   // 0.6 x 0.6 m x 800
});

test("typing an area still sells whole boxes at the box price", () => {
  const { api } = loadTile();
  const r = api.addToSale("t1", "3", "m2");               // 3 / 1.44 -> 3 boxes
  assert.equal(r.converted.boxes, 3);
  assert.equal(api.getSale().items[0].sellingUnit, "box");
  assert.equal(api.getSale().items[0].unitPrice, 1152);
});

test("a price per box converts to pieces and the unit can be switched on a line", () => {
  const { api } = loadTile({ sellingPrice: 1152, priceUnit: "box" });
  api.addToSale("t1", "1", "box");
  const line = api.getSale().items[0];
  assert.equal(line.unitPrice, 1152);
  assert.equal(api.updateSaleUnit(line.lineId, "piece").error, undefined);
  assert.equal(line.unitPrice, 288);
  assert.equal(api.updateSaleUnit(line.lineId, "box").error, undefined);
  assert.equal(line.unitPrice, 1152);
});

test("kg and meter prices apply only to their own unit", () => {
  const { api } = loadProductApi();
  api.applyData({ products: [
    api.normalizeProduct({ id: "c1", name: "Cement", sellingPrice: 300, priceUnit: "kg", stock: 100 }),
    api.normalizeProduct({ id: "p1", name: "Pipe", sellingPrice: 150, priceUnit: "m", stock: 100 }),
  ], invoices: [], settings: { ...api.DEFAULT_SETTINGS }, counter: 0, lastSaved: "" });
  assert.equal(api.addToSale("c1", "2", "kg").ok, true);
  assert.equal(api.addToSale("p1", "4", "m").ok, true);
  assert.equal(api.getSale().items[0].unitPrice, 300);
  assert.equal(api.getSale().items[1].unitPrice, 150);
  assert.match(api.addToSale("c1", "1", "piece").error, /priced per kg/);
  assert.match(api.addToSale("p1", "1", "box").error, /priced per m/);
  assert.equal(api.getSale().items.length, 2);             // refused lines are not added
});

test("a refused unit change leaves the line as it was", () => {
  const { api } = loadProductApi();
  api.applyData({ products: [api.normalizeProduct({ id: "c1", name: "Cement", sellingPrice: 300, priceUnit: "kg", stock: 100 })], invoices: [], settings: { ...api.DEFAULT_SETTINGS }, counter: 0, lastSaved: "" });
  api.addToSale("c1", "2", "kg");
  const line = api.getSale().items[0];
  const r = api.updateSaleUnit(line.lineId, "box");
  assert.equal(r.revert, true);
  assert.equal(line.sellingUnit, "kg");
  assert.equal(line.unitPrice, 300);
});

test("conversion needs the tile size or box coverage and says which is missing", () => {
  const { api } = loadTile({ coveragePerBox: null });
  assert.match(api.addToSale("t1", "1", "box").error, /coverage per box/);
  const { api: api2 } = loadTile({ tileSize: "" });
  assert.match(api2.addToSale("t1", "1", "piece").error, /tile size/);
  assert.equal(api2.addToSale("t1", "1", "box").ok, true);   // the box price only needs the coverage
});

test("products saved without a price unit keep the old behavior", () => {
  const { api } = loadProductApi();
  const legacy = api.normalizeProduct({ id: "old", name: "Old", sellingPrice: 100, stock: 10 });
  assert.equal(legacy.priceUnit, null);
  api.applyData({ products: [legacy], invoices: [], settings: { ...api.DEFAULT_SETTINGS }, counter: 0, lastSaved: "" });
  api.addToSale("old", "1", "kg");
  assert.equal(api.getSale().items[0].unitPrice, 100);       // price used as typed for any unit
  assert.equal(api.priceLabel(legacy), "100 DA");
  assert.equal(api.productProblem(legacy), "");
});

test("the product form requires a price unit and a coverage for per-m² prices", () => {
  const { api, field } = loadProductApi();
  const fill = (extra) => {
    const base = { pName: "Tile", pManufacturer: "", pTileSize: "60*60", pCoveragePerBox: "1.44", pDesc: "", pPrice: "800", pPriceUnit: "m2", pCost: "", pStock: "5", pStockUnit: "box", pSku: "", pCategory: "" };
    for (const [id, value] of Object.entries({ ...base, ...extra })) field(id).value = value;
    return api.readProductForm();
  };
  const ok = fill({});
  assert.equal(ok.values.priceUnit, "m2");
  assert.equal(ok.values.coveragePerBox, 1.44);
  assert.equal(fill({ pPriceUnit: "" }).field, "pPriceUnit");
  assert.equal(fill({ pPriceUnit: "bogus" }).field, "pPriceUnit");
  assert.equal(fill({ pCoveragePerBox: "" }).field, "pCoveragePerBox");
  assert.equal(fill({ pCoveragePerBox: "", pPriceUnit: "piece" }).error, undefined);
});

test("an invalid price unit in a data file is rejected", () => {
  const { api } = loadProductApi();
  assert.match(api.productProblem({ ...api.normalizeProduct(ceramic({ id: "x" })), priceUnit: "bogus" }), /price unit/);
  assert.equal(api.productProblem({ ...api.normalizeProduct(ceramic({ id: "x" })), priceUnit: "m2" }), "");
});

/* ---------- Sell search ---------- */

test("sell search lists nothing until something is typed, then the closest matches first", () => {
  const { api } = loadProductApi();
  const names = ["Golden Era", "Era Grey", "Cement", "Pera Tile"];
  api.applyData({ products: names.map((name, i) => api.normalizeProduct({ id: "s" + i, name, sellingPrice: 10, priceUnit: "piece", stock: 5 })), invoices: [], settings: { ...api.DEFAULT_SETTINGS }, counter: 0, lastSaved: "" });
  assert.equal(api.findMatches("").length, 0);
  assert.equal(api.findMatches("   ").length, 0);
  assert.equal(JSON.stringify(api.findMatches("era").map((p) => p.name)), JSON.stringify(["Era Grey", "Golden Era", "Pera Tile"]));
  assert.equal(api.findMatches("zzz").length, 0);
});

test("sell search shows at most 8 results", () => {
  const { api } = loadProductApi();
  api.applyData({ products: Array.from({ length: 12 }, (_, i) => api.normalizeProduct({ id: "m" + i, name: "Tile " + i, sellingPrice: 10, priceUnit: "piece", stock: 5 })), invoices: [], settings: { ...api.DEFAULT_SETTINGS }, counter: 0, lastSaved: "" });
  assert.equal(api.findMatches("tile").length, 8);
});

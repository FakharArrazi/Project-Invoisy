"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { loadProductApi, ceramic, fillProductForm, priceFieldId } = require("./helpers");

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
  const created = fillProductForm({ api, field }, values);

  assert.equal(created.error, undefined);
  assert.equal(created.values.tileSize, "60*120");
  assert.equal(created.values.coveragePerBox, 2.88);
  assert.equal(created.values.sellingUnit, undefined);

  // The page starts against a brand new in-memory IndexedDB; every change is saved there first.
  await api.startStorage();
  assert.equal(api.getStorage().mode, "ready", api.getStorage().reason);
  const create = await api.commit((draft) => {
    draft.products.push(api.normalizeProduct({ id: "everton", ...created.values }));
  });
  assert.equal(create.error, undefined);
  assert.equal((await api.db.loadAll()).products[0].name, "Everton Grey");

  const edit = await api.commit((draft) => {
    Object.assign(draft.products[0], { manufacturer: "Timgad Ceramic Updated", coveragePerBox: 3.12 });
  });
  assert.equal(edit.error, undefined);
  // read back from the database itself, not from the copy the page holds in memory
  const reloaded = (await api.db.loadAll()).products[0];

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

test("m² is a real selling unit: the area stays as entered; piece and kg stay as entered too", () => {
  const { api } = loadProductApi();
  const load = () => api.applyData({ products: [api.normalizeProduct(ceramic({ id: "t1", stock: 100, coveragePerBox: 2.88 })), api.normalizeProduct({ id: "k1", name: "Cement", stock: 100, sellingPrice: 5, priceUnit: "kg", stockUnit: "kg" })], invoices: [], settings: { ...api.DEFAULT_SETTINGS }, counter: 0, lastSaved: "" });
  load();
  assert.equal(api.addToSale("t1", "8", "m2").ok, true);
  const line = api.getSale().items[0];
  assert.deepEqual([line.qty, line.sellingUnit], [8, "m2"]);          // 8 m², not rounded up to boxes
  assert.equal(api.addToSale("t1", "5.76", "m2").ok, true);           // same unit: joins the same line
  assert.equal(api.getSale().items[0].qty, 13.76);
  assert.equal(api.addToSale("k1", "2", "kg").ok, true);
  assert.equal(typeof api.addToSale("k1", "3", "m2").error, "string");     // a per-kg product can't be sold by area
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

test("800 DA per m² with 1.44 m² per box: the line keeps 800 DA/m², 2 boxes = 2.88 m² = 2,304 DA", () => {
  const { api } = loadTile();
  assert.equal(api.addToSale("t1", "2", "box").ok, true);
  const line = api.getSale().items[0];
  assert.deepEqual([line.unitPrice, line.priceUnit, line.priceQty], [800, "m2", 2.88]);   // the price stays per m², billed for 2.88 m²
  const inv = api.buildInvoiceData(api.getSale(), "INV-000001", new Date().toISOString());
  assert.equal(inv.items[0].total, 2304);
  assert.equal(inv.items[0].unitPrice, 1152);        // a saved invoice line still holds the price per unit sold (1 box)
  assert.equal(inv.items[0].priceUnit, "m2");
  assert.equal(inv.total, 2304);
});

test("the same m² price gives a per-piece price from the piece size", () => {
  const { api } = loadTile();
  api.addToSale("t1", "5", "piece");
  const line = api.getSale().items[0];
  assert.deepEqual([line.unitPrice, line.priceUnit, line.priceQty], [800, "m2", 1.8]);   // 5 pieces = 1.8 m², still priced per m²
  assert.equal(api.calculateTotals(api.getSale()).total, 1440);                             // 5 x 288 (0.6 x 0.6 m x 800)
  const inv = api.buildInvoiceData(api.getSale(), "INV-000001", new Date().toISOString());
  assert.equal(inv.items[0].unitPrice, 288);                                                // saved per piece sold
});

test("typing an area on a product supplied in boxes takes whole boxes from stock and bills the area those boxes contain at the price per m²", () => {
  const { api } = loadTile();
  const added = api.addToSale("t1", "3", "m2");                    // 3 / 1.44 = 2.08 boxes: a fraction needs a whole extra box
  assert.equal(added.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(added.converted)), { requested: 3, exact: 2.08333333333, boxes: 3, area: 4.32 });
  const line = api.getSale().items[0];
  assert.deepEqual([line.qty, line.sellingUnit, line.unitPrice, line.priceUnit, line.priceQty, line.requestedArea], [3, "box", 800, "m2", 4.32, 3]);   // 3 boxes leave the stock; 4.32 m² x 800 DA/m² is billed; 3 m² were asked for
  assert.equal(line.catalog.unit, "m2");
  assert.equal(line.catalog.price, 800, "the product's price is still the price per m²");
  assert.equal(api.calculateTotals(api.getSale()).total, 3456);   // 4.32 m² x 800
});

test("a price per box converts to pieces and the unit can be switched on a line", () => {
  const { api } = loadTile({ sellingPrice: 1152, priceUnit: "box" });
  api.addToSale("t1", "1", "box");
  const line = api.getSale().items[0];
  assert.deepEqual([line.unitPrice, line.priceUnit, line.priceQty], [1152, "box", 1]);
  assert.equal(api.updateSaleUnit(line.lineId, "piece").error, undefined);
  assert.deepEqual([line.unitPrice, line.priceUnit, line.priceQty], [1152, "box", 0.25]);   // 1 piece = 0.25 box: the price stays per box
  assert.equal(api.calculateTotals(api.getSale()).total, 288);
  assert.equal(api.updateSaleUnit(line.lineId, "box").error, undefined);
  assert.deepEqual([line.unitPrice, line.priceQty], [1152, 1]);
  assert.equal(api.calculateTotals(api.getSale()).total, 1152);
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
    return fillProductForm({ api, field }, { ...base, ...extra });
  };
  const ok = fill({});
  assert.equal(ok.values.priceUnit, "m2");
  assert.equal(ok.values.coveragePerBox, 1.44);
  assert.equal(fill({ pPriceUnit: "" }).field, priceFieldId(api, 0, "unit"));
  assert.equal(fill({ pPriceUnit: "bogus" }).field, priceFieldId(api, 0, "unit"));
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

// This used to say "at most 8 results". That cap was the bug: a product that matched was silently left out of the list (see
// tests/sell-search.test.js). Every match is listed now; the list scrolls.
test("sell search lists every matching product, however many there are", () => {
  const { api } = loadProductApi();
  api.applyData({ products: Array.from({ length: 12 }, (_, i) => api.normalizeProduct({ id: "m" + i, name: "Tile " + i, sellingPrice: 10, priceUnit: "piece", stock: 5 })), invoices: [], settings: { ...api.DEFAULT_SETTINGS }, counter: 0, lastSaved: "" });
  assert.equal(api.findMatches("tile").length, 12);
});

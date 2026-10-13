"use strict";

// Unit price of a sale line: the price is always for ONE selected selling unit, can be overridden for the
// current sale only, is saved with the invoice exactly as charged, and never touches Stock prices or stock use.
const assert = require("node:assert/strict");
const test = require("node:test");
const { loadProductApi, openDatabase } = require("./helpers");

// Reference tile: 800 DA/m², 60 x 60 cm, 1.44 m² per box (4 pieces per box), stock counted in boxes.
function load(overrides = {}) {
  const { api } = loadProductApi();
  const tile = api.normalizeProduct({
    id: "t1", name: "Ceramic Tile", sku: "TILE-1", tileSize: "60*60", coveragePerBox: 1.44,
    sellingPrice: 800, priceUnit: "m2", stockUnit: "box", stock: 100, ...overrides,
  });
  api.applyData({ products: [tile], invoices: [], settings: { ...api.DEFAULT_SETTINGS }, counter: 0, lastSaved: "" });
  return api;
}

async function complete(api) {
  await openDatabase(api);
  const result = await api.commit((d) => api.applySale(d, api.getSale()));
  assert.equal(result.error, undefined, result.error);
  return result.invoice;
}
const product = (api) => api.getProducts().find((p) => p.id === "t1");
const plain = (value) => JSON.parse(JSON.stringify(value));
const line = (api, index = 0) => api.getSale().items[index];
const near = (a, b) => Math.abs(a - b) < 1e-9;

test("1. a new sale line starts at the saved price of the selected unit, with its price-unit label", () => {
  const api = load({ stockUnit: "piece", stock: 400 });   // stock counted in pieces: an area is sold as typed (see 1c for boxes)
  api.addToSale("t1", "2", "box");
  api.addToSale("t1", "4", "piece");
  api.addToSale("t1", "10", "m2");
  const [box, piece, m2] = api.getSale().items;
  assert.deepEqual(plain([box.sellingUnit, box.unitPrice, piece.sellingUnit, piece.unitPrice, m2.sellingUnit, m2.unitPrice]),
    ["box", 1152, "piece", 288, "m2", 800]);
  assert.deepEqual([api.linePriceUnit(box), api.linePriceUnit(piece), api.linePriceUnit(m2)], ["DA/box", "DA/piece", "DA/m²"]);
  assert.deepEqual(plain(api.getSale().items.map((i) => i.priceOverridden)), [false, false, false]);

  // a product priced per box and one priced per piece
  const perBox = load({ sellingPrice: 1656, priceUnit: "box" });
  perBox.addToSale("t1", "15", "box");
  assert.equal(perBox.calculateTotals(perBox.getSale()).total, 24840);        // 15 boxes x 1,656 DA/box
  const perPiece = load({ sellingPrice: 300, priceUnit: "piece" });
  perPiece.addToSale("t1", "4", "piece");
  assert.equal(perPiece.calculateTotals(perPiece.getSale()).total, 1200);     // 4 pieces x 300 DA/piece
});

test("1c. on a product supplied in boxes an area typed in m² becomes a box line: box label, price worked out from the m² price", () => {
  const api = load();
  api.addToSale("t1", "10", "m2");                                           // 10 / 1.44 = 6.94 boxes -> 7
  assert.deepEqual(plain([line(api).qty, line(api).sellingUnit, line(api).unitPrice, line(api).priceOverridden]), [7, "box", 1152, false]);
  assert.equal(api.linePriceUnit(line(api)), "DA/box");
  assert.equal(api.calculateTotals(api.getSale()).total, 8064);               // 7 boxes = 10.08 m² x 800 DA/m²
});

test("1b. the Current Sale row shows the price-unit label next to the price input", () => {
  const { api, field } = (() => {
    const loaded = loadProductApi();
    loaded.api.applyData({ products: [loaded.api.normalizeProduct({ id: "t1", name: "Ceramic Tile", tileSize: "60*60", coveragePerBox: 1.44, sellingPrice: 800, priceUnit: "m2", stockUnit: "piece", stock: 40 })], invoices: [], settings: { ...loaded.api.DEFAULT_SETTINGS }, counter: 0, lastSaved: "" });
    return loaded;
  })();
  api.addToSale("t1", "10", "m2");
  api.renderSale();
  const html = field("saleBody").innerHTML;
  assert.match(html, /class="price-input"[^>]*value="800"/);
  assert.match(html, /<span class="price-unit" data-price-unit>DA\/m²<\/span>/);
  assert.match(html, /data-line-total>8,000 DA</);
});

test("2. editing the unit price updates the line, subtotal, discount, tax and final total", () => {
  const api = load({ sellingPrice: 1000, priceUnit: "box" });
  api.addToSale("t1", "10", "box");
  const sale = api.getSale();
  sale.discountType = "percent"; sale.discountValue = "10";
  sale.taxType = "amount"; sale.taxValue = "50";
  assert.deepEqual(plain(api.calculateTotals(sale)), { subtotal: 10000, discount: 1000, tax: 50, total: 9050 });

  assert.equal(api.updateSalePrice(line(api).lineId, "900").error, undefined);
  assert.equal(line(api).unitPrice, 900);
  assert.equal(line(api).priceOverridden, true);
  assert.equal(line(api).listPrice, 1000);
  assert.deepEqual(plain(api.calculateTotals(sale)), { subtotal: 9000, discount: 900, tax: 50, total: 8150 });

  // the live invoice (draft) shows the charged price and unit
  const html = api.invoiceHtml(api.buildInvoiceData(sale, "INV-000001", new Date().toISOString()));
  assert.match(html, /900 <span class="inv-unit">\/ Box<\/span>/);
  assert.doesNotMatch(html, /1,000 <span/);
  assert.match(html, /<td class="num">9,000<\/td>/);
});

test("3. a price typed in Current Sale never changes the product's saved prices or its stock", () => {
  const api = load();
  const before = JSON.stringify(product(api));
  api.addToSale("t1", "3", "box");
  api.updateSalePrice(line(api).lineId, "1");
  api.updateSalePrice(line(api).lineId, "5000");
  assert.equal(JSON.stringify(product(api)), before);
  assert.equal(product(api).sellingPrice, 800);
  assert.equal(product(api).priceUnit, "m2");
});

test("4. removing a product and adding it again restores the normal saved price", () => {
  const api = load();
  api.addToSale("t1", "2", "box");
  api.updateSalePrice(line(api).lineId, "900");
  const id = line(api).lineId;
  api.getSale().items = api.getSale().items.filter((i) => i.lineId !== id);   // what the Remove button does
  api.addToSale("t1", "2", "box");
  assert.equal(line(api).unitPrice, 1152);
  assert.equal(line(api).priceOverridden, false);
});

test("5. a later sale to the same customer does not inherit the override", async () => {
  const api = load();
  api.addToSale("t1", "2", "box");
  Object.assign(api.getSale().customer, { name: "Karim", phone: "0555", address: "Béjaïa" });
  api.updateSalePrice(line(api).lineId, "900");
  const first = await complete(api);
  assert.equal(first.items[0].unitPrice, 900);

  // tomorrow: same customer, same product
  api.getSale().items = [];
  api.addToSale("t1", "2", "box");
  assert.equal(api.getSale().customer.name, "Karim");
  assert.equal(line(api).unitPrice, 1152, "the customer carries no price of its own");
  // nothing about prices is stored on the customer, in settings or in the catalogue
  assert.deepEqual(Object.keys(plain(first.customer)).sort(), ["address", "name", "phone"]);
  assert.equal(product(api).sellingPrice, 800);
  assert.equal(JSON.stringify(api.getState().settings).includes("900"), false);
});

test("6. changing the unit selects that unit's price and label; the quantity is not converted or priced twice", () => {
  const api = load({ stockUnit: "piece", stock: 400 });   // stock counted in pieces, so m² is a direct unit (a box-counted product refuses it, see sales.test.js)
  api.addToSale("t1", "3", "box");
  const l = line(api);
  assert.deepEqual([l.unitPrice, api.linePriceUnit(l)], [1152, "DA/box"]);
  assert.equal(api.updateSaleUnit(l.lineId, "piece").error, undefined);
  assert.deepEqual([l.qty, l.unitPrice, api.linePriceUnit(l)], [3, 288, "DA/piece"]);
  assert.equal(api.updateSaleUnit(l.lineId, "m2").error, undefined);
  assert.deepEqual([l.qty, l.unitPrice, api.linePriceUnit(l)], [3, 800, "DA/m²"]);
  assert.equal(api.calculateTotals(api.getSale()).total, 2400);               // 3 m² x 800, quantity untouched
  api.updateSaleUnit(l.lineId, "box");
  assert.deepEqual([l.qty, l.unitPrice], [3, 1152]);

  // a hand-typed price was for the old unit: the new unit gets its own price and the caller is told
  api.updateSalePrice(l.lineId, "1000");
  const result = api.updateSaleUnit(l.lineId, "piece");
  assert.equal(result.priceReset, true);
  assert.deepEqual([l.unitPrice, l.priceOverridden], [288, false]);
  // changing the quantity never touches a typed price
  api.updateSalePrice(l.lineId, "250");
  api.updateSaleQuantity(l.lineId, "5");
  assert.deepEqual([l.qty, l.unitPrice, l.priceOverridden], [5, 250, true]);
  assert.equal(api.calculateTotals(api.getSale()).total, 1250);
});

test("6b. a product price changed in Stock reaches normal lines, but never replaces a typed price", () => {
  const api = load();
  api.addToSale("t1", "2", "box");
  api.addToSale("t1", "2", "piece");
  api.updateSalePrice(line(api, 1).lineId, "250");
  product(api).sellingPrice = 1000;                                          // edited in Stock meanwhile
  api.syncSaleWithProducts();
  assert.deepEqual(plain([line(api, 0).unitPrice, line(api, 0).priceOverridden]), [1440, false]);
  assert.deepEqual(plain([line(api, 1).unitPrice, line(api, 1).priceOverridden, line(api, 1).listPrice]), [250, true, 360]);
});

test("7. a saved invoice keeps the exact price charged, its unit, and the line total", async () => {
  const api = load();
  api.addToSale("t1", "15", "box");
  api.updateSalePrice(line(api).lineId, "1656");
  const invoice = await complete(api);
  const item = invoice.items[0];
  assert.deepEqual(plain([item.productId, item.name, item.qty, item.sellingUnit, item.unitPrice, item.unitPriceUnit, item.total]),
    ["t1", "Ceramic Tile", 15, "box", 1656, "box", 24840]);
  assert.equal(item.priceOverridden, true);
  assert.equal(item.calculatedUnitPrice, 1152);
  assert.equal(item.productPrice, 800);
  assert.equal(item.priceUnit, "m2");
  assert.equal(item.tileSize, "60*60");
  assert.equal(item.coveragePerBox, 1.44);

  // and it reads back the same from the database and from a backup file
  const stored = await api.db.loadAll();
  const saved = stored.invoices[0].items[0];
  assert.deepEqual(plain([saved.unitPrice, saved.unitPriceUnit, saved.total, saved.priceOverridden]), [1656, "box", 24840, true]);
  const written = api.Validation.prepareBackupFile(stored, new Date());
  const loaded = api.Validation.parseBackup(written.text);
  assert.equal(loaded.error, undefined, loaded.error);
  const restored = loaded.data.invoices[0].items[0];
  assert.deepEqual(plain([restored.unitPrice, restored.unitPriceUnit, restored.total]), [1656, "box", 24840]);
});

test("8. a saved invoice is not recalculated when the product's prices change, and prints the charged price", async () => {
  const api = load();
  api.addToSale("t1", "2", "box");
  api.updateSalePrice(line(api).lineId, "1000");
  api.addToSale("t1", "4", "piece");
  const invoice = await complete(api);
  const before = JSON.stringify(invoice);
  const htmlBefore = api.invoiceHtml(invoice);

  await api.commit((d) => { Object.assign(d.products[0], { sellingPrice: 5000, priceUnit: "piece", coveragePerBox: 2.88, tileSize: "30*30" }); });
  const saved = api.getInvoices()[0];
  assert.equal(JSON.stringify(saved), before);
  assert.equal(api.invoiceHtml(saved), htmlBefore);
  assert.match(htmlBefore, /1,000 <span class="inv-unit">\/ Box<\/span>/);     // charged, per unit sold
  assert.equal((htmlBefore.match(/800 <span class="inv-unit">\/ m²<\/span>/g) || []).length, 1);   // only the normally priced piece line shows the product price
  assert.equal(saved.total, 3152);                                              // 2 x 1,000 + 4 x 288
});

test("8b. an older saved line whose price differs from the product price never shows the product price as charged", () => {
  const api = load();
  const legacy = {
    productId: "t1", name: "Ceramic Tile", tileSize: "60*60", coveragePerBox: 1.44, sellingUnit: "box", qty: 2,
    unitPrice: 1000, total: 2000, priceUnit: "m2", productPrice: 800,          // typed by hand, before priceOverridden existed
  };
  const shown = api.invoiceLinePrice(legacy);
  assert.deepEqual(plain([shown.price, shown.unit]), [1000, "box"]);
  const normal = api.invoiceLinePrice({ ...legacy, unitPrice: 1152 });
  assert.deepEqual(plain([normal.price, normal.unit]), [800, "m2"]);           // consistent: 800/m² x 1.44 m² = 1,152 per box
});

test("9. stock deduction depends on quantity and unit, never on the price", async () => {
  const sold = async (qty, unit, price) => {
    const api = load({ stock: 100 });
    api.addToSale("t1", qty, unit);
    if (price !== undefined) api.updateSalePrice(line(api).lineId, price);
    const invoice = await complete(api);
    return { stock: product(api).stock, deducted: invoice.items[0].stockDeducted };
  };
  for (const price of [undefined, "0", "1", "99999"]) {
    assert.deepEqual(plain(await sold("3", "box", price)), { stock: 97, deducted: 3 });
    assert.deepEqual(plain(await sold("4", "piece", price)), { stock: 99, deducted: 1 });          // 4 pieces = 1 box
    const area = await sold("5", "m2", price);                                                     // 5 m² / 1.44 = 3.47 boxes -> 4 whole boxes
    assert.deepEqual(plain(area), { stock: 96, deducted: 4 });
  }
});

test("10. invalid prices are rejected and the line keeps its last valid price", () => {
  const api = load();
  api.addToSale("t1", "2", "box");
  const l = line(api);
  api.updateSalePrice(l.lineId, "900");
  for (const bad of ["", "abc", "-1", "-0.01", "Infinity", "-Infinity", "NaN", "1e999"]) {
    assert.equal(typeof api.updateSalePrice(l.lineId, bad).error, "string", `"${bad}" must be rejected`);
    assert.equal(l.unitPrice, 900, `"${bad}" must not change the price`);
  }
  assert.equal(api.updateSalePrice(l.lineId, "0").error, undefined);           // a free line is a valid price
  assert.equal(l.unitPrice, 0);
  assert.equal(api.validateSale().some((e) => /negative/.test(e)), false);
  // the decimals the app supports: money is kept to 2 decimals so the line, subtotal and invoice agree
  api.updateSalePrice(l.lineId, "900.456");
  assert.equal(l.unitPrice, 900.46);
  assert.equal(api.calculateTotals(api.getSale()).total, 1800.92);
  // a corrupted line can't be completed
  l.unitPrice = -5;
  assert.ok(api.validateSale().length > 0);
});

test("11. discount, tax and payment still work with a special price", async () => {
  const api = load();
  api.addToSale("t1", "10", "box");
  api.updateSalePrice(line(api).lineId, "700");                                // 7,000
  const sale = api.getSale();
  sale.discountType = "percent"; sale.discountValue = "10";                    // -700
  sale.taxType = "percent"; sale.taxValue = "19";                              // 19% of 6,300 = 1,197
  sale.paidValue = "3000";
  assert.deepEqual(plain(api.calculateTotals(sale)), { subtotal: 7000, discount: 700, tax: 1197, total: 7497 });
  const invoice = await complete(api);
  assert.equal(invoice.total, 7497);
  const pay = api.paymentInfo(invoice);
  assert.deepEqual(plain([pay.paid, pay.remaining, pay.cls]), [3000, 4497, "partial"]);
  assert.equal(invoice.discountPercent, 10);
  assert.equal(invoice.taxPercent, 19);
});

"use strict";

// Unit price of a sale line: the price is always for ONE selected selling unit, can be overridden for the
// current sale only, is saved with the invoice exactly as charged, and never touches Stock prices or stock use.
const assert = require("node:assert/strict");
const test = require("node:test");
const { loadProductApi, openDatabase } = require("./helpers");

require("./helpers/modules");   // loads calc.js, validation.js and the languages into this process
const Calc = globalThis.Calc;

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

test("1. a new sale line starts at the saved price in the unit the product is priced in, whatever unit is sold", () => {
  const api = load({ stockUnit: "piece", stock: 400 });   // stock counted in pieces: an area is sold as typed (see 1c for boxes)
  api.addToSale("t1", "2", "box");
  api.addToSale("t1", "4", "piece");
  api.addToSale("t1", "10", "m2");
  const [box, piece, m2] = api.getSale().items;
  assert.deepEqual(plain([box.sellingUnit, box.unitPrice, piece.sellingUnit, piece.unitPrice, m2.sellingUnit, m2.unitPrice]),
    ["box", 800, "piece", 800, "m2", 800]);
  assert.deepEqual([api.linePriceUnit(box), api.linePriceUnit(piece), api.linePriceUnit(m2)], ["DA/m²", "DA/m²", "DA/m²"]);
  assert.deepEqual(plain([box.priceQty, piece.priceQty, m2.priceQty]), [2.88, 1.44, 10]);           // billed in m²: 2 boxes, 4 pieces, 10 m²
  assert.deepEqual(plain(api.getSale().items.map((i) => i.priceOverridden)), [false, false, false]);

  // a product priced per box and one priced per piece
  const perBox = load({ sellingPrice: 1656, priceUnit: "box" });
  perBox.addToSale("t1", "15", "box");
  assert.equal(perBox.calculateTotals(perBox.getSale()).total, 24840);        // 15 boxes x 1,656 DA/box
  const perPiece = load({ sellingPrice: 300, priceUnit: "piece" });
  perPiece.addToSale("t1", "4", "piece");
  assert.equal(perPiece.calculateTotals(perPiece.getSale()).total, 1200);     // 4 pieces x 300 DA/piece
});

test("1c. on a product supplied in boxes an area typed in m² takes whole boxes from stock and is billed as typed, at the price per m²", () => {
  const api = load();
  api.addToSale("t1", "10", "m2");                                           // 10 / 1.44 = 6.94 boxes -> 7
  assert.deepEqual(plain([line(api).qty, line(api).sellingUnit, line(api).unitPrice, line(api).priceOverridden]), [7, "box", 800, false]);
  assert.equal(api.linePriceUnit(line(api)), "DA/m²");
  assert.equal(line(api).priceQty, 10);
  assert.equal(api.calculateTotals(api.getSale()).total, 8000);               // 10 m² x 800 DA/m² (the 7 boxes cover 10.08 m²)
});

test("1d. the example: 9 m² of a 1,150 DA/m² tile with 1.22 m² per box -> 8 boxes leave the stock, 1,150 DA/m² x 9 m² = 10,350 DA", async () => {
  const api = load({ name: "Perla", tileSize: "45*45", coveragePerBox: 1.22, sellingPrice: 1150, stock: 50 });
  const added = api.addToSale("t1", "9", "m2");
  assert.deepEqual(plain(added.converted), { requested: 9, exact: 7.37704918033, boxes: 8, area: 9.76 });
  assert.deepEqual(plain([line(api).qty, line(api).sellingUnit, line(api).unitPrice, line(api).priceQty]), [8, "box", 1150, 9]);
  assert.equal(api.linePriceUnit(line(api)), "DA/m²");
  assert.equal(api.qtyNote(line(api)), "Billed: 9 m² · 1 Box = 1.22 m²");
  assert.equal(api.priceNote(line(api)), "Product price: 1,150 DA / m²");
  assert.equal(api.calculateTotals(api.getSale()).total, 10350);

  // a special price for this customer, per m²: the stock deduction does not move
  assert.equal(api.updateSalePrice(line(api).lineId, "1100").error, undefined);
  assert.equal(api.calculateTotals(api.getSale()).total, 9900);
  assert.deepEqual(plain([line(api).qty, line(api).sellingUnit, line(api).priceQty, line(api).priceOverridden]), [8, "box", 9, true]);
  assert.equal(product(api).sellingPrice, 1150, "the product keeps its saved price");

  const invoice = await complete(api);
  assert.deepEqual(plain([invoice.items[0].qty, invoice.items[0].sellingUnit, invoice.items[0].total, invoice.total]), [8, "box", 9900, 9900]);
  assert.equal(invoice.items[0].stockDeducted, 8);
  assert.equal(product(api).stock, 42);
  assert.equal(Calc.calculateLineTotal(invoice.items[0].qty, invoice.items[0].unitPrice), 9900, "the saved quantity x price gives the saved total");
});

test("1e. a line's billed quantity follows the quantity sold: editing the boxes drops the area typed; typing more area adds to it", () => {
  const api = load();
  api.addToSale("t1", "10", "m2");                                           // 7 boxes, 10 m² billed
  assert.equal(api.updateSaleQuantity(line(api).lineId, "6").error, undefined);
  assert.deepEqual(plain([line(api).qty, line(api).priceQty, line(api).priceQtyTyped]), [6, 8.64, false]);   // 6 boxes = 8.64 m²
  assert.equal(api.calculateTotals(api.getSale()).total, 6912);
  api.addToSale("t1", "10", "m2");                                           // +7 boxes, +10 m²
  assert.deepEqual(plain([line(api).qty, line(api).priceQty, line(api).priceQtyTyped]), [13, 18.64, true]);
  assert.equal(api.calculateTotals(api.getSale()).total, 14912);
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
  assert.equal(line(api).unitPrice, 800);
  assert.equal(line(api).priceOverridden, false);
});

test("5. a later sale to the same customer does not inherit the override", async () => {
  const api = load();
  api.addToSale("t1", "2", "box");
  Object.assign(api.getSale().customer, { name: "Karim", phone: "0555", address: "Béjaïa" });
  api.updateSalePrice(line(api).lineId, "900");
  const first = await complete(api);
  assert.equal(first.items[0].unitPrice, 1296);                               // 900 DA/m² x 1.44 m² = the price of the box sold
  assert.equal(first.items[0].total, 2592);

  // tomorrow: same customer, same product
  api.getSale().items = [];
  api.addToSale("t1", "2", "box");
  assert.equal(api.getSale().customer.name, "Karim");
  assert.equal(line(api).unitPrice, 800, "the customer carries no price of its own");
  // nothing about prices is stored on the customer, in settings or in the catalogue
  assert.deepEqual(Object.keys(plain(first.customer)).sort(), ["address", "name", "phone"]);
  assert.equal(product(api).sellingPrice, 800);
  assert.equal(JSON.stringify(api.getState().settings).includes("900"), false);
});

test("6. changing the unit sold keeps the price in the product's own price unit; the quantity is not converted or priced twice", () => {
  const api = load({ stockUnit: "piece", stock: 400 });   // stock counted in pieces, so m² is a direct unit (a box-counted product refuses it, see sales.test.js)
  api.addToSale("t1", "3", "box");
  const l = line(api);
  assert.deepEqual([l.unitPrice, api.linePriceUnit(l), l.priceQty], [800, "DA/m²", 4.32]);
  assert.equal(api.updateSaleUnit(l.lineId, "piece").error, undefined);
  assert.deepEqual([l.qty, l.unitPrice, api.linePriceUnit(l), l.priceQty], [3, 800, "DA/m²", 1.08]);
  assert.equal(api.updateSaleUnit(l.lineId, "m2").error, undefined);
  assert.deepEqual([l.qty, l.unitPrice, api.linePriceUnit(l), l.priceQty], [3, 800, "DA/m²", 3]);
  assert.equal(api.calculateTotals(api.getSale()).total, 2400);               // 3 m² x 800, quantity untouched
  api.updateSaleUnit(l.lineId, "box");
  assert.deepEqual([l.qty, l.unitPrice, l.priceQty], [3, 800, 4.32]);
  assert.equal(api.calculateTotals(api.getSale()).total, 3456);               // 3 boxes = 4.32 m²

  // a hand-typed price per m² stays while the price unit stays m², whatever unit is sold
  api.updateSalePrice(l.lineId, "1000");
  const result = api.updateSaleUnit(l.lineId, "piece");
  assert.equal(result.priceReset, undefined);
  assert.deepEqual([l.unitPrice, l.priceOverridden], [1000, true]);
  // changing the quantity never touches a typed price
  api.updateSalePrice(l.lineId, "250");
  api.updateSaleQuantity(l.lineId, "5");
  assert.deepEqual([l.qty, l.unitPrice, l.priceOverridden, l.priceQty], [5, 250, true, 1.8]);
  assert.equal(api.calculateTotals(api.getSale()).total, 450);                // 5 pieces = 1.8 m² x 250
});

test("6c. a unit that has a price of its own changes the price unit: a price typed for the old one is replaced and the caller is told", () => {
  const api = load({ stockUnit: "piece", stock: 400, sellingPrices: [{ unit: "m2", price: 800 }, { unit: "piece", price: 300 }] });
  api.addToSale("t1", "3", "box");                                           // no box price: worked out from 800 DA/m²
  const l = line(api);
  api.updateSalePrice(l.lineId, "1000");
  const result = api.updateSaleUnit(l.lineId, "piece");                      // 300 DA per piece is saved
  assert.equal(result.priceReset, true);
  assert.deepEqual([l.unitPrice, l.priceUnit, l.priceOverridden, l.priceQty], [300, "piece", false, 3]);
  assert.equal(api.linePriceUnit(l), "DA/piece");
  assert.equal(api.calculateTotals(api.getSale()).total, 900);
});

test("6b. a product price changed in Stock reaches normal lines, but never replaces a typed price", () => {
  const api = load();
  api.addToSale("t1", "2", "box");
  api.addToSale("t1", "2", "piece");
  api.updateSalePrice(line(api, 1).lineId, "250");
  product(api).sellingPrice = 1000;                                          // edited in Stock meanwhile
  api.syncSaleWithProducts();
  assert.deepEqual(plain([line(api, 0).unitPrice, line(api, 0).priceOverridden]), [1000, false]);
  assert.deepEqual(plain([line(api, 1).unitPrice, line(api, 1).priceOverridden, line(api, 1).listPrice]), [250, true, 1000]);
});

test("7. a saved invoice keeps the exact price charged, its unit, and the line total", async () => {
  const api = load();
  api.addToSale("t1", "15", "box");
  api.updateSalePrice(line(api).lineId, "1150");                             // 1,150 DA/m² x 1.44 m² = 1,656 DA per box
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
  api.updateSalePrice(line(api).lineId, "1250");                             // 1,250 DA/m² x 1.44 m² = 1,800 DA per box
  api.addToSale("t1", "4", "piece");
  const invoice = await complete(api);
  const before = JSON.stringify(invoice);
  const htmlBefore = api.invoiceHtml(invoice);

  await api.commit((d) => { Object.assign(d.products[0], { sellingPrice: 5000, priceUnit: "piece", coveragePerBox: 2.88, tileSize: "30*30" }); });
  const saved = api.getInvoices()[0];
  assert.equal(JSON.stringify(saved), before);
  assert.equal(api.invoiceHtml(saved), htmlBefore);
  assert.match(htmlBefore, /1,800 <span class="inv-unit">\/ Box<\/span>/);     // charged, per unit sold
  assert.equal((htmlBefore.match(/800 <span class="inv-unit">\/ m²<\/span>/g) || []).length, 1);   // only the normally priced piece line shows the product price
  assert.equal(saved.total, 4752);                                              // 2 x 1,800 + 4 x 288
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
  assert.equal(api.calculateTotals(api.getSale()).total, 2593.32);              // 2 boxes = 2.88 m² x 900.46
  // a corrupted line can't be completed
  l.unitPrice = -5;
  assert.ok(api.validateSale().length > 0);
});

test("11. discount, tax and payment still work with a special price", async () => {
  const api = load();
  api.addToSale("t1", "10", "box");
  api.updateSalePrice(line(api).lineId, "500");                                // 10 boxes = 14.4 m² x 500 = 7,200
  const sale = api.getSale();
  sale.discountType = "percent"; sale.discountValue = "10";                    // -720
  sale.taxType = "percent"; sale.taxValue = "19";                              // 19% of 6,480 = 1,231.2
  sale.paidValue = "3000";
  assert.deepEqual(plain(api.calculateTotals(sale)), { subtotal: 7200, discount: 720, tax: 1231.2, total: 7711.2 });
  const invoice = await complete(api);
  assert.equal(invoice.total, 7711.2);
  const pay = api.paymentInfo(invoice);
  assert.deepEqual(plain([pay.paid, pay.remaining, pay.cls]), [3000, 4711.2, "partial"]);
  assert.equal(invoice.discountPercent, 10);
  assert.equal(invoice.taxPercent, 19);
});

test("12. products priced per m², box, piece and kg in one sale: each keeps its own price unit; totals, discount, tax and stock stay right", async () => {
  const { api } = loadProductApi();
  const make = (o) => api.normalizeProduct({ tileSize: "60*60", coveragePerBox: 1.44, stockUnit: "box", stock: 50, ...o });
  api.applyData({
    products: [
      make({ id: "m", name: "Per m²", sku: "M", sellingPrice: 800, priceUnit: "m2" }),
      make({ id: "b", name: "Per box", sku: "B", sellingPrice: 1656, priceUnit: "box" }),
      make({ id: "p", name: "Per piece", sku: "P", sellingPrice: 300, priceUnit: "piece", stockUnit: "piece", stock: 200 }),
      api.normalizeProduct({ id: "k", name: "Cement", sku: "K", sellingPrice: 5, priceUnit: "kg", stockUnit: "kg", stock: 500 }),
    ],
    invoices: [], settings: { ...api.DEFAULT_SETTINGS }, counter: 0, lastSaved: "",
  });
  api.addToSale("m", "9", "m2");        // 9 / 1.44 = 6.25 -> 7 boxes leave the stock, 9 m² x 800 = 7,200
  api.addToSale("b", "3", "box");       // 3 x 1,656 = 4,968
  api.addToSale("p", "10", "piece");    // 10 x 300 = 3,000
  api.addToSale("k", "25", "kg");       // 25 x 5 = 125
  const items = api.getSale().items;
  assert.deepEqual(plain(items.map((i) => [i.unitPrice, i.priceUnit, i.priceQty])), [[800, "m2", 9], [1656, "box", 3], [300, "piece", 10], [5, "kg", 25]]);
  assert.deepEqual(plain(items.map((i) => api.linePriceUnit(i))), ["DA/m²", "DA/box", "DA/piece", "DA/kg"]);
  const sale = api.getSale();
  sale.discountType = "percent"; sale.discountValue = "10";
  sale.taxType = "percent"; sale.taxValue = "19";
  assert.deepEqual(plain(api.calculateTotals(sale)), { subtotal: 15293, discount: 1529.3, tax: 2615.1, total: 16378.8 });
  const invoice = await complete(api);
  assert.deepEqual(plain(invoice.items.map((i) => [i.qty, i.sellingUnit, i.total])), [[7, "box", 7200], [3, "box", 4968], [10, "piece", 3000], [25, "kg", 125]]);
  assert.equal(invoice.total, 16378.8);
  assert.deepEqual(plain(invoice.items.map((i) => i.stockDeducted)), [7, 3, 10, 25]);
  const stock = (id) => api.getProducts().find((p) => p.id === id).stock;
  assert.deepEqual([stock("m"), stock("b"), stock("p"), stock("k")], [43, 47, 190, 475]);
  // a saved invoice's lines still add up to its subtotal (the backup check compares them)
  assert.equal(Calc.roundMoney(invoice.items.reduce((sum, i) => sum + Calc.calculateLineTotal(i.qty, i.unitPrice), 0)), invoice.subtotal);
});

test("13. a price that does not divide evenly (1,333.33 DA/m²) still gives the price of one box rounded to the cent, as before", async () => {
  const api = load({ sellingPrice: 1333.33, stock: 100 });
  api.addToSale("t1", "5", "box");                                           // 1,333.33 x 1.44 = 1,919.9952 -> 1,920 per box
  assert.equal(api.calculateTotals(api.getSale()).total, 9600);
  const invoice = await complete(api);
  assert.deepEqual(plain([invoice.items[0].unitPrice, invoice.items[0].total]), [1920, 9600]);
  assert.match(api.invoiceHtml(invoice), /5 Boxes<div class="inv-sub">7\.2 m²<\/div><\/td><td class="num">1,333\.33 <span class="inv-unit">\/ m²<\/span><\/td><td class="num">9,600<\/td>/);
});

"use strict";

// Sales, stock deduction and saved invoices, tested through the application functions in script.js.
const assert = require("node:assert/strict");
const test = require("node:test");
const { loadProductApi, openDatabase } = require("./helpers");

// Reference product: 1,500 DA / m², 60 x 60 cm, 1.44 m² per box. Stock counted in boxes unless stated.
function load(overrides = {}, extraProducts = []) {
  const { api, field } = loadProductApi();
  const tile = api.normalizeProduct({
    id: "t1", name: "Ceramic Tile", sku: "TILE-1", tileSize: "60*60", coveragePerBox: 1.44,
    sellingPrice: 1500, priceUnit: "m2", stockUnit: "box", stock: 20, ...overrides,
  });
  api.applyData({
    products: [tile, ...extraProducts.map((p) => api.normalizeProduct(p))], invoices: [],
    settings: { ...api.DEFAULT_SETTINGS }, counter: 0, lastSaved: "",
  });
  return { api, field };
}

// Completes the sale the way the app does (one commit) and returns the saved invoice.
async function complete(api) {
  await openDatabase(api);   // saving goes to a disposable in-memory IndexedDB
  const result = await api.commit((d) => api.applySale(d, api.getSale()));
  assert.equal(result.error, undefined, result.error);
  return result.invoice;
}
const product = (api, id = "t1") => api.getProducts().find((p) => p.id === id);
const plain = (value) => JSON.parse(JSON.stringify(value));   // the app runs in its own context: compare plain data

test("the reference sale: 2 boxes of 1,500 DA/m² tile cost 4,320 DA and take 2 boxes from stock", async () => {
  const { api } = load();
  assert.equal(api.addToSale("t1", "2", "box").ok, true);
  const line = api.getSale().items[0];
  assert.equal(line.unitPrice, 2160);
  assert.equal(api.calculateTotals(api.getSale()).total, 4320);
  assert.equal(product(api).stock, 20, "stock is not touched while the sale is being prepared");

  const invoice = await complete(api);
  assert.equal(invoice.items[0].qty, 2);
  assert.equal(invoice.items[0].sellingUnit, "box");
  assert.equal(invoice.items[0].unitPrice, 2160);
  assert.equal(invoice.items[0].total, 4320);
  assert.equal(invoice.items[0].stockDeducted, 2);
  assert.equal(product(api).stock, 18);
});

test("12. selling boxes deducts the right stock for each stock unit", async () => {
  for (const [stockUnit, stock, expected] of [["piece", 80, 72], ["box", 20, 18], ["m2", 100, 97.12]]) {
    const { api } = load({ stockUnit, stock });
    assert.equal(api.addToSale("t1", "2", "box").ok, true, stockUnit);
    await complete(api);
    assert.equal(product(api).stock, expected, `stock counted in ${stockUnit}`);
  }
});

test("13. selling pieces deducts the right stock for each stock unit", async () => {
  for (const [stockUnit, stock, expected] of [["piece", 80, 77], ["box", 20, 19.25], ["m2", 100, 98.92]]) {
    const { api } = load({ stockUnit, stock });
    assert.equal(api.addToSale("t1", "3", "piece").ok, true, stockUnit);
    assert.equal(api.getSale().items[0].unitPrice, 540);
    const invoice = await complete(api);
    assert.equal(invoice.items[0].total, 1620);
    assert.equal(product(api).stock, expected, `stock counted in ${stockUnit}`);
  }
});

test("boxes and pieces of the same product share one stock pool, counted in the stock unit", async () => {
  const { api } = load({ stock: 3 });   // 3 boxes = 12 pieces
  assert.equal(api.addToSale("t1", "2", "box").ok, true);       // 8 pieces
  assert.equal(api.addToSale("t1", "4", "piece").ok, true);     // 12 pieces: exactly everything
  assert.match(api.addToSale("t1", "1", "piece").error, /^Not enough stock/);
  assert.equal(api.validateSale().length, 0);
  await complete(api);
  assert.equal(product(api).stock, 0);
});

test("a sale larger than the stock is refused", () => {
  const { api } = load({ stock: 2 });
  assert.match(api.addToSale("t1", "3", "box").error, /^Not enough stock/);
  assert.match(api.addToSale("t1", "9", "piece").error, /^Not enough stock/);   // 9 pieces = 2.25 boxes
  assert.equal(api.addToSale("t1", "8", "piece").ok, true);                     // 8 pieces = 2 boxes
  assert.equal(api.getSale().items.length, 1);
});

test("stock is checked again when the sale is completed", async () => {
  const { api } = load({ stock: 5 });
  api.addToSale("t1", "5", "box");
  await openDatabase(api);
  await api.commit((d) => { d.products[0].stock = 3; });          // stock lowered elsewhere
  const result = await api.commit((d) => api.applySale(d, api.getSale()));
  assert.match(result.error, /Not enough stock/);
  assert.equal(product(api).stock, 3);
  assert.equal(api.getInvoices().length, 0);
});

test("changing the unit of a line recalculates its price; changing the quantity updates the total", () => {
  const { api } = load();
  api.addToSale("t1", "2", "box");
  const line = api.getSale().items[0];
  assert.equal(line.unitPrice, 2160);
  assert.equal(api.updateSaleUnit(line.lineId, "piece").error, undefined);
  assert.equal(line.unitPrice, 540);
  assert.equal(api.updateSaleQuantity(line.lineId, "3").error, undefined);
  assert.equal(api.calculateTotals(api.getSale()).total, 1620);
  api.updateSaleUnit(line.lineId, "box");
  assert.equal(line.unitPrice, 2160);
  assert.equal(api.calculateTotals(api.getSale()).total, 6480);
});

test("a unit change that would exceed the stock or break a whole-number rule is refused", () => {
  const { api } = load({ stock: 2 });                           // 2 boxes = 8 pieces
  api.addToSale("t1", "8", "piece");
  const line = api.getSale().items[0];
  const r = api.updateSaleUnit(line.lineId, "box");             // 8 boxes won't fit
  assert.equal(r.revert, true);
  assert.equal(line.sellingUnit, "piece");
  assert.equal(line.unitPrice, 540);
});

test("a hand-typed price stays on its own line and never changes the product", () => {
  const { api } = load();
  api.addToSale("t1", "1", "box");
  const line = api.getSale().items[0];
  api.updateSalePrice(line.lineId, "2000");
  assert.equal(line.priceOverridden, true);
  assert.equal(line.listPrice, 2160);
  assert.equal(product(api).sellingPrice, 1500);
  assert.equal(product(api).priceUnit, "m2");
  assert.match(api.priceNote(line), /Custom price/);
  api.updateSalePrice(line.lineId, "2160");                      // typing the calculated price back is not an override
  assert.equal(line.priceOverridden, false);
  api.updateSalePrice(line.lineId, "2000");
  api.updateSaleUnit(line.lineId, "piece");                      // a new unit goes back to the calculated price
  assert.equal(line.unitPrice, 540);
  assert.equal(line.priceOverridden, false);
});

test("area typed in m² is sold as whole boxes at the box price", async () => {
  const { api } = load();
  const r = api.addToSale("t1", "3", "m2");
  assert.deepEqual({ ...r.converted }, { area: 3, boxes: 3, coverage: 1.44 });
  const invoice = await complete(api);
  assert.equal(invoice.items[0].sellingUnit, "box");
  assert.equal(invoice.items[0].qty, 3);
  assert.notEqual(invoice.items[0].sellingUnit, "m2");
});

test("kg and meter products: fractional quantities, own units only", async () => {
  const { api } = load({}, [
    { id: "c1", name: "Cement", sellingPrice: 30, priceUnit: "kg", stockUnit: "kg", stock: 10 },
    { id: "p1", name: "Pipe", sellingPrice: 150, priceUnit: "m", stockUnit: "m", stock: 10 },
  ]);
  assert.equal(api.addToSale("c1", "2.5", "kg").ok, true);
  assert.equal(api.addToSale("p1", "1.5", "m").ok, true);
  assert.match(api.addToSale("c1", "1", "box").error, /priced per kg/);
  assert.match(api.addToSale("p1", "1", "piece").error, /priced per m/);
  assert.match(api.addToSale("t1", "1", "kg").error, /priced per m²/);
  const invoice = await complete(api);
  assert.equal(invoice.total, 75 + 225);
  assert.equal(product(api, "c1").stock, 7.5);
  assert.equal(product(api, "p1").stock, 8.5);
});

test("piece and box quantities must be whole numbers", () => {
  const { api } = load();
  assert.match(api.addToSale("t1", "1.5", "box").error, /whole number/);
  assert.match(api.addToSale("t1", "2.5", "piece").error, /whole number/);
  assert.ok(api.addToSale("t1", "0", "box").error);
  assert.ok(api.addToSale("t1", "-1", "box").error);
  assert.ok(api.addToSale("t1", "", "box").error);
});

test("a missing conversion says which product data to correct", () => {
  const noSize = load({ tileSize: "" }).api;
  assert.match(noSize.addToSale("t1", "1", "piece").error, /no tile size/);
  assert.equal(noSize.addToSale("t1", "1", "box").ok, true);
  const noCoverage = load({ coveragePerBox: null }).api;
  assert.match(noCoverage.addToSale("t1", "1", "box").error, /no coverage per box/);
  assert.match(noCoverage.addToSale("t1", "1", "m2").error, /no coverage per box/);
  const odd = load({ coveragePerBox: 1.5 }).api;
  assert.match(odd.addToSale("t1", "3", "piece").error, /not a whole number of pieces/);
});

test("the Sell page only offers units the product can really be sold in", () => {
  const { api } = load();
  assert.equal(api.unitProblem(api.getProducts()[0], "piece"), "");
  assert.equal(api.unitProblem(api.getProducts()[0], "box"), "");
  assert.equal(api.unitProblem(api.getProducts()[0], "m2"), "");
  assert.match(api.unitProblem(api.getProducts()[0], "kg"), /priced per m²/);
  const noSize = load({ tileSize: "" }).api;
  assert.match(noSize.unitProblem(noSize.getProducts()[0], "piece"), /tile size/);
});

/* ---------- Invoices ---------- */

test("16. a saved invoice keeps its units and prices after the product is edited", async () => {
  const { api } = load();
  api.addToSale("t1", "2", "box");
  api.addToSale("t1", "3", "piece");
  const invoice = await complete(api);
  const before = JSON.stringify(invoice);

  await api.commit((d) => {
    Object.assign(d.products[0], { name: "Renamed", sellingPrice: 9999, priceUnit: "piece", coveragePerBox: 2.88, tileSize: "30*30", stockUnit: "piece" });
  });
  const saved = api.getInvoices()[0];
  assert.equal(JSON.stringify(saved), before);
  assert.deepEqual(saved.items.map((i) => [i.qty, i.sellingUnit, i.unitPrice, i.total]), [[2, "box", 2160, 4320], [3, "piece", 540, 1620]]);
  assert.equal(saved.items[0].name, "Ceramic Tile");
  assert.equal(saved.items[0].sku, "TILE-1");
  assert.equal(saved.items[0].productId, "t1");
  assert.equal(saved.items[0].priceUnit, "m2");
  assert.equal(saved.items[0].productPrice, 1500);
  assert.equal(saved.total, 5940);

  // and it reads back the same from the database, and from a backup file made from it
  const stored = await api.db.loadAll();
  const check = (invoice) => {
    const item = invoice.items[0];
    assert.equal(JSON.stringify([item.qty, item.sellingUnit, item.unitPrice, item.total, item.stockDeducted]), JSON.stringify([2, "box", 2160, 4320, 2]));
    assert.equal(invoice.total, 5940);
  };
  check(stored.invoices[0]);
  const written = api.Validation.prepareBackupFile(stored, new Date());
  assert.equal(written.error, undefined, written.error);
  const loaded = api.Validation.parseBackup(written.text);
  assert.equal(loaded.error, undefined, loaded.error);
  check(loaded.data.invoices[0]);
});

test("the invoice shows the product's own price and unit (1,500 / m²) while the quantity stays in the unit sold", async () => {
  const { api } = load();
  api.addToSale("t1", "2", "box");
  api.addToSale("t1", "3", "piece");
  api.addToSale("t1", "1", "m2");                               // 1 m² -> 1 box
  const invoice = await complete(api);
  const html = api.invoiceHtml(invoice);
  // quantity: what was sold, with the same amount in the price unit underneath
  assert.match(html, /3 Pieces<div class="inv-sub">1\.08 m²<\/div>/);
  assert.match(html, /3 Boxes<div class="inv-sub">4\.32 m²<\/div>/);   // 2 boxes + 1 box from the m² line, merged
  // price: the configured price and unit, for every line, never a per-box or per-piece price
  assert.equal((html.match(/1,500 <span class="inv-unit">\/ m²<\/span>/g) || []).length, 2);
  assert.doesNotMatch(html, /2,160|540 <span/);
  // totals are still worked out per unit sold: 3 x 2,160 and 3 x 540
  assert.deepEqual(plain(invoice.items.map((i) => i.total)), [6480, 1620]);
  // the saved line is untouched: it still holds the price per unit sold and the details it came from
  assert.deepEqual(plain(invoice.items.map((i) => [i.sellingUnit, i.unitPrice, i.priceUnit, i.productPrice])), [["box", 2160, "m2", 1500], ["piece", 540, "m2", 1500]]);
  const single = api.invoiceHtml({ ...invoice, items: [{ ...invoice.items[0], qty: 1 }] });
  assert.match(single, /1 Box<div class="inv-sub">1\.44 m²<\/div>/);
});

test("invoice price unit: per piece, per kg, per box and per m² each show exactly the configured unit", async () => {
  const kg = { id: "k1", name: "Cement", sellingPrice: 200, priceUnit: "kg", stockUnit: "kg", stock: 100 };
  const pc = { id: "p1", name: "Chips", sellingPrice: 500, priceUnit: "piece", stockUnit: "piece", stock: 100 };
  const bx = { id: "b1", name: "Glue", sellingPrice: 3000, priceUnit: "box", stockUnit: "box", stock: 100, coveragePerBox: 1.44, tileSize: "60*60" };
  const { api } = load({}, [kg, pc, bx]);
  api.addToSale("k1", "2.5", "kg");
  api.addToSale("p1", "3", "piece");
  api.addToSale("b1", "2", "box");
  api.addToSale("b1", "2", "piece");                            // a box-priced product sold by the piece
  const invoice = await complete(api);
  const html = api.invoiceHtml(invoice);
  assert.match(html, /200 <span class="inv-unit">\/ kg<\/span>/);
  assert.match(html, /500 <span class="inv-unit">\/ Piece<\/span>/);
  assert.equal((html.match(/3,000 <span class="inv-unit">\/ Box<\/span>/g) || []).length, 2);
  assert.match(html, /2\.5 kg<\/td>/, "no second line when the quantity is already in the price unit");
  assert.match(html, /2 Pieces<div class="inv-sub">0\.5 Boxes<\/div>/);
  assert.deepEqual(plain(invoice.items.map((i) => i.total)), [500, 1500, 6000, 1500]);
});

test("invoice price: a price typed by hand is shown as charged, in the unit sold; the stock price is not touched", async () => {
  const { api } = load();
  api.addToSale("t1", "2", "box");
  const line = api.getSale().items[0];
  assert.equal(api.updateSalePrice(line.lineId, "2000").error, undefined);
  const invoice = await complete(api);
  const html = api.invoiceHtml(invoice);
  assert.match(html, /2,000 <span class="inv-unit">\/ Box<\/span>/);
  assert.doesNotMatch(html, /1,500/);
  assert.equal(invoice.items[0].total, 4000);
  assert.equal(product(api).sellingPrice, 1500, "the product's price in Stock is never overwritten by a sale");
  assert.equal(product(api).priceUnit, "m2");
});

test("sale editor note shows the product's own price and unit", () => {
  const { api } = load();
  api.addToSale("t1", "2", "box");
  assert.equal(api.priceNote(api.getSale().items[0]), "Product price: 1,500 DA / m² (1 Box = 1.44 m²)");
  api.addToSale("t1", "3", "piece");
  assert.equal(api.priceNote(api.getSale().items[1]), "Product price: 1,500 DA / m² (1 Piece = 0.36 m²)");
});

test("17. existing products and invoices stay compatible", () => {
  const { api } = loadProductApi();
  const legacyProduct = { id: "old", name: "Old Tile", sellingPrice: 100, purchasePrice: 60, stock: 7, coveragePerBox: 1.44, tileSize: "60*60" };
  const legacyInvoice = {
    id: "i1", invoiceNumber: "INV-000001", date: "2024-01-01T10:00:00.000Z",
    items: [{ productId: "old", name: "Old Tile", qty: 2, unitPrice: 100, total: 200 }],
    subtotal: 200, discount: 0, tax: 0, total: 200, payments: [{ amount: 200, timestamp: "2024-01-01T10:00:00.000Z" }],
  };
  const built = api.buildData({ version: 1, products: [legacyProduct], invoices: [legacyInvoice], settings: {}, invoiceCounter: 1 }, false);
  assert.equal(built.error, undefined);
  assert.equal(built.problems.length, 0);
  const p = built.data.products[0];
  assert.equal(p.priceUnit, null, "an old price is never read as per m² or per box");
  assert.equal(p.stockUnit, null);
  assert.equal(p.stock, 7);
  assert.equal(p.sellingPrice, 100);
  assert.deepEqual(JSON.parse(JSON.stringify(built.data.invoices[0].items)), legacyInvoice.items);

  api.applyData({ ...built.data, counter: 1 });
  assert.equal(api.addToSale("old", "2", "box").ok, true);       // old behavior: price as typed, any unit
  assert.equal(api.getSale().items[0].unitPrice, 100);
  const html = api.invoiceHtml(built.data.invoices[0]);
  assert.match(html, /<td class="num">2<\/td>/, "an old line has no unit, so none is invented");
  assert.doesNotMatch(html, /Piece/);
});

test("17b. an old product's stock is reduced one-for-one, as before", async () => {
  const { api } = loadProductApi();
  api.applyData({ products: [api.normalizeProduct({ id: "old", name: "Old", sellingPrice: 100, stock: 7 })], invoices: [], settings: { ...api.DEFAULT_SETTINGS }, counter: 0, lastSaved: "" });
  api.addToSale("old", "3", "piece");
  await complete(api);
  assert.equal(product(api, "old").stock, 4);
});

test("17c. units in a data file are normalised and checked", () => {
  const { api } = loadProductApi();
  const ok = api.normalizeProduct({ id: "a", name: "A", sellingPrice: 5, priceUnit: "m²", stock: 3 });
  assert.equal(ok.priceUnit, "m2");
  assert.equal(ok.stockUnit, "box");
  assert.match(api.productProblem({ ...ok, stockUnit: "bogus" }), /stock unit/);
  assert.equal(api.productProblem({ ...ok, stock: 19.25 }), "");
  assert.match(api.productProblem({ ...ok, stock: -1 }), /stock quantity/);
});

test("18. discounts, taxes, payments and totals still calculate correctly", async () => {
  const { api } = load();
  api.addToSale("t1", "2", "box");                               // 4,320
  api.addToSale("t1", "3", "piece");                             // 1,620 -> subtotal 5,940
  const sale = api.getSale();
  sale.discountType = "percent"; sale.discountValue = "10";      // 594
  sale.taxType = "amount"; sale.taxValue = "100";
  const t = api.calculateTotals(sale);
  assert.deepEqual({ ...t }, { subtotal: 5940, discount: 594, tax: 100, total: 5446 });
  sale.paidValue = "1000";
  const invoice = await complete(api);
  assert.equal(invoice.total, 5446);
  assert.equal(invoice.discountPercent, 10);
  assert.equal(JSON.stringify(invoice.payments.map((p) => p.amount)), "[1000]");
  assert.equal(invoice.invoiceNumber, "INV-000001");
  assert.equal(api.paymentInfo(invoice).remaining, 4446);
  const paid = await api.addPayment(invoice.id, "4446");
  assert.equal(paid.error, undefined);
  assert.equal(api.paymentInfo(api.getInvoices()[0]).status, "PAID");
});

test("stock display: boxes also show pieces", () => {
  const { api } = load();
  assert.equal(api.stockLabel(product(api)), "20 Boxes (80 Pieces)");
  assert.equal(api.stockText(product(api), 1), "1 Box");
  const oldOne = api.normalizeProduct({ id: "o", name: "O", sellingPrice: 1, stock: 7 });
  assert.equal(api.stockLabel(oldOne), "7");
});

test("invoices saved by earlier versions still print: with a price snapshot, with no unit at all, and with incomplete data", () => {
  const { api } = load();
  const base = { id: "i", invoiceNumber: "INV-000009", date: "2025-01-01T10:00:00.000Z", subtotal: 0, discount: 0, tax: 0, payments: [] };
  const show = (item) => api.invoiceHtml({ ...base, total: item.total, items: [item] });

  // saved by the previous version: price per box on the line, with what it was worked out from
  const snapshot = show({ name: "Old tile", tileSize: "60*60", coveragePerBox: 1.44, sellingUnit: "box", qty: 2, unitPrice: 2160, total: 4320, priceUnit: "m2", productPrice: 1500 });
  assert.match(snapshot, /1,500 <span class="inv-unit">\/ m²<\/span>/);
  assert.match(snapshot, /2 Boxes<div class="inv-sub">2\.88 m²<\/div>/);

  // saved before price units existed: the price charged, in the unit sold (or no unit when none was saved)
  assert.match(show({ name: "Older", sellingUnit: "box", qty: 2, unitPrice: 100, total: 200 }), /100 <span class="inv-unit">\/ Box<\/span>/);
  const none = show({ name: "Oldest", qty: 2, unitPrice: 100, total: 200 });
  assert.match(none, /<td class="num">2<\/td><td class="num">100<\/td>/);
  assert.doesNotMatch(none, /inv-unit|inv-sub/);

  // a snapshot that can't be converted (no coverage saved): show what was charged instead of guessing
  const partial = show({ name: "Odd", sellingUnit: "box", qty: 2, unitPrice: 2160, total: 4320, priceUnit: "m2", productPrice: 1500 });
  assert.match(partial, /2,160 <span class="inv-unit">\/ Box<\/span>/);
  assert.doesNotMatch(partial, /inv-sub/);
});

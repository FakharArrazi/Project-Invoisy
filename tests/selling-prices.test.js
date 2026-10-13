"use strict";

// Multiple independent selling prices per product, tested through the real page scripts against a disposable
// in-memory IndexedDB. The numbers follow the ceramic example: 1,000 DA/m², 300 DA/piece, 1,440 DA/box, on a
// 60 x 60 cm tile with 1.44 m² per box (1 piece = 0.36 m², 1 box = 4 pieces).

const test = require("node:test");
const assert = require("node:assert/strict");
const { V } = require("./helpers/modules");   // also loads calc.js, validation.js, the languages into this process
const { loadApp } = require("./helpers/app");
const { fillProductForm } = require("./helpers");

const Calc = globalThis.Calc;
const plain = (x) => JSON.parse(JSON.stringify(x));

async function startedApp(options) {
  const app = loadApp(options);
  const storage = await app.start();
  assert.equal(storage.mode, "ready", storage.reason);
  return app;
}

const FORM = { pName: "Everton Grey", pManufacturer: "Timgad Ceramic", pTileSize: "60*60", pCoveragePerBox: "1.44", pDesc: "", pCost: "", pStock: "20", pStockUnit: "box", pSku: "EV-1", pCategory: "Tiles" };
const PRICES = [{ unit: "m2", price: "1000" }, { unit: "piece", price: "300" }, { unit: "box", price: "1440" }];

// Saves a product through the Stock form code (readProductForm + addProduct) and returns it.
async function addThroughForm(app, extra = {}) {
  const form = fillProductForm(app, { ...FORM, priceRows: PRICES, ...extra });
  assert.equal(form.error, undefined, form.error);
  await app.api.addProduct(form.values);
  return app.api.getState().products.find((p) => p.sku === (extra.pSku || FORM.pSku));
}

// Edits through the form: opens the product, lets `change` alter the price rows / fields, saves.
async function editThroughForm(app, id, change) {
  app.api.startEditProduct(id);
  for (const key of ["pStock", "pCoveragePerBox", "pCost"]) app.field(key).value = String(app.field(key).value);   // a browser turns assigned numbers into text
  change();
  const form = app.api.readProductForm();
  assert.equal(form.error, undefined, form.error);
  await app.api.updateProduct(id, form.values);
  return app.api.getState().products.find((p) => p.id === id);
}

const priceOf = (product, unit) => Calc.getExplicitPrice(product, unit);
const rows = (app) => app.api.getState().priceRows;
const rowFor = (app, unit) => rows(app).find((r) => r.unit === unit);

async function sell(app, lines, setup) {
  for (const [id, qty, unit] of lines) {
    const added = app.api.addToSale(id, String(qty), unit);
    assert.equal(added.ok, true, added.error);
  }
  if (setup) setup(app.api.getSale());
  await app.api.completeSale();
  const invoices = app.api.getState().invoices;
  return invoices[invoices.length - 1];
}

/* ---------- 1-4: creating and editing prices ---------- */

test("1. a product is created with an m² price and box-counted stock", async () => {
  const app = await startedApp();
  const form = fillProductForm(app, { ...FORM, priceRows: [{ unit: "m2", price: "1000" }] });
  assert.equal(form.error, undefined, form.error);
  await app.api.addProduct(form.values);
  const saved = (await app.api.db.loadAll()).products[0];   // read back from the database itself
  assert.deepEqual(plain(saved.sellingPrices), [{ unit: "m2", price: 1000 }]);
  assert.equal(saved.sellingPrice, 1000);
  assert.equal(saved.priceUnit, "m2");
  assert.equal(saved.stockUnit, "box");
  assert.equal(saved.stock, 20);
  assert.equal(saved.manufacturer, "Timgad Ceramic");
});

test("2 + 3. adding a piece price, then a box price, keeps every earlier price", async () => {
  const app = await startedApp();
  const product = await addThroughForm(app, { priceRows: [{ unit: "m2", price: "1000" }] });

  app.api.startEditProduct(product.id);
  app.api.addPriceRow();
  assert.equal(rows(app)[1].unit, "piece");
  rows(app)[1].price = "300";
  for (const key of ["pStock", "pCoveragePerBox", "pCost"]) app.field(key).value = String(app.field(key).value);
  await app.api.updateProduct(product.id, app.api.readProductForm().values);
  let now = app.api.getState().products[0];
  assert.deepEqual(plain(now.sellingPrices), [{ unit: "m2", price: 1000 }, { unit: "piece", price: 300 }]);

  app.api.startEditProduct(product.id);
  app.api.addPriceRow();
  assert.equal(rows(app)[2].unit, "box");
  rows(app)[2].price = "1440";
  for (const key of ["pStock", "pCoveragePerBox", "pCost"]) app.field(key).value = String(app.field(key).value);
  await app.api.updateProduct(product.id, app.api.readProductForm().values);
  now = (await app.api.db.loadAll()).products[0];
  assert.deepEqual(plain(now.sellingPrices), [{ unit: "m2", price: 1000 }, { unit: "piece", price: 300 }, { unit: "box", price: 1440 }]);
  assert.equal(now.sellingPrice, 1000, "the main price is still the first entry");
});

test("4. editing one price leaves the others as they were", async () => {
  const app = await startedApp();
  const product = await addThroughForm(app);
  const edited = await editThroughForm(app, product.id, () => { rowFor(app, "piece").price = "320"; });
  assert.equal(priceOf(edited, "piece"), 320);
  assert.equal(priceOf(edited, "m2"), 1000);
  assert.equal(priceOf(edited, "box"), 1440);
  // editing the main (first) price keeps the older single-price fields in step with it
  const again = await editThroughForm(app, product.id, () => { rowFor(app, "m2").price = "1100"; });
  assert.equal(again.sellingPrice, 1100);
  assert.equal(priceOf(again, "piece"), 320);
  assert.equal(priceOf(again, "box"), 1440);
});

test("removing a price keeps the others; the first remaining price becomes the main one", async () => {
  const app = await startedApp();
  const product = await addThroughForm(app);
  const edited = await editThroughForm(app, product.id, () => app.api.removePriceRow(rowFor(app, "m2").rowId));
  assert.deepEqual(plain(edited.sellingPrices), [{ unit: "piece", price: 300 }, { unit: "box", price: 1440 }]);
  assert.equal(edited.priceUnit, "piece");
  assert.equal(edited.sellingPrice, 300);
});

/* ---------- 5-8: prices in Current Sale, and stock maths ---------- */

test("5. Current Sale uses the explicit price for the selected unit, and the printed invoice shows it", async () => {
  const app = await startedApp();
  const product = await addThroughForm(app);
  assert.equal(app.api.addToSale(product.id, "3", "piece").ok, true);
  assert.equal(app.api.addToSale(product.id, "2", "box").ok, true);
  const [pieces, boxes] = app.api.getSale().items;
  assert.equal(pieces.unitPrice, 300, "3 pieces use the 300 DA/piece price");
  assert.equal(boxes.unitPrice, 1440, "2 boxes use the 1,440 DA/box price");
  assert.equal(app.api.calculateTotals(app.api.getSale()).total, 3 * 300 + 2 * 1440);

  const invoice = await sell(app, [], null);
  assert.equal(invoice.items[0].priceSource, "explicit");
  assert.equal(invoice.items[0].priceUnit, "piece");
  assert.equal(invoice.items[0].productPrice, 300);
  assert.equal(invoice.total, 3780);
  const html = app.api.invoiceHtml(invoice);
  assert.match(html, /300 <span class="inv-unit">\/ Piece<\/span>/);
  assert.match(html, /1,440 <span class="inv-unit">\/ Box<\/span>/);
  assert.doesNotMatch(html, /1,000 <span class="inv-unit">\/ m²/, "no m² price is shown for lines sold by piece or box");
});

test("6. a unit with no price of its own falls back to the conversion; nothing is saved to the product", async () => {
  const app = await startedApp();
  const product = await addThroughForm(app, { priceRows: [{ unit: "m2", price: "1000" }] });
  const before = JSON.stringify((await app.api.db.loadAll()).products[0]);

  assert.equal(app.api.addToSale(product.id, "1", "box").ok, true);
  assert.equal(app.api.addToSale(product.id, "1", "piece").ok, true);
  const [box, piece] = app.api.getSale().items;
  assert.equal(box.unitPrice, 1440, "1,000 DA/m² x 1.44 m²");
  assert.equal(piece.unitPrice, 360, "1,000 DA/m² x 0.36 m²");
  assert.equal(box.catalog.source, "calculated");

  const invoice = await sell(app, [], null);
  assert.equal(invoice.items[0].priceSource, "calculated");
  const after = (await app.api.db.loadAll()).products[0];
  assert.equal(JSON.stringify({ ...after, stock: 0 }), JSON.stringify({ ...JSON.parse(before), stock: 0 }), "the catalogue has no new price");
  assert.deepEqual(plain(after.sellingPrices), [{ unit: "m2", price: 1000 }]);
});

test("7. an independent piece price is used exactly, even when it differs from the calculated equivalent", async () => {
  const app = await startedApp();
  const product = await addThroughForm(app);
  const calculatedOnly = Calc.getUnitPrice({ ...product, sellingPrices: [{ unit: "m2", price: 1000 }], sellingPrice: 1000, priceUnit: "m2" }, "piece");
  assert.equal(calculatedOnly.value, 360);
  assert.equal(Calc.getUnitPrice(product, "piece").value, 300, "the explicit 300 is not replaced by 360");
  assert.equal(Calc.getUnitPrice(product, "piece").source, "explicit");
  assert.equal(Calc.getUnitPrice(product, "m2").value, 1000);
  assert.equal(Calc.getUnitPrice(product, "box").value, 1440);

  // switching the unit on a sale line re-reads the catalogue: no price is converted twice
  app.api.addToSale(product.id, "1", "box");
  const line = app.api.getSale().items[0];
  assert.equal(app.api.updateSaleUnit(line.lineId, "piece").error, undefined);
  assert.equal(line.unitPrice, 300);
  assert.equal(app.api.updateSaleUnit(line.lineId, "box").error, undefined);
  assert.equal(line.unitPrice, 1440);
});

test("7 (continued). a temporary sale price never changes the saved prices", async () => {
  const app = await startedApp();
  const product = await addThroughForm(app);
  app.api.addToSale(product.id, "2", "piece");
  const line = app.api.getSale().items[0];
  assert.equal(app.api.updateSalePrice(line.lineId, "250").error, undefined);
  assert.equal(line.priceOverridden, true);
  const invoice = await sell(app, [], null);
  assert.equal(invoice.items[0].unitPrice, 250);
  assert.equal(invoice.items[0].priceSource, "custom");
  assert.equal(invoice.items[0].calculatedUnitPrice, 300, "what the catalogue price was is kept for the record");
  assert.deepEqual(plain(app.api.getState().products[0].sellingPrices), [{ unit: "m2", price: 1000 }, { unit: "piece", price: 300 }, { unit: "box", price: 1440 }]);
});

test("8. stock conversions are the same whatever the prices are: 3 pieces from 20 boxes leaves 19.25, 2 boxes leaves 18", async () => {
  const app = await startedApp();
  const product = await addThroughForm(app);

  // one piece covers 0.36 m², one box holds 4 pieces
  assert.equal(Calc.getPieceArea(product).value, 0.36);
  assert.equal(Calc.getPiecesPerBox(product).value, 4);
  // prices of any kind do not move a conversion factor
  const noPrices = { ...product, sellingPrices: [{ unit: "m2", price: 1 }], sellingPrice: 1 };
  const factors = (p) => ["piece", "box", "m2"].flatMap((a) => ["piece", "box", "m2"].map((b) => Calc.getUnitFactor(p, a, b).value));
  assert.deepEqual(factors(product), factors(noPrices));

  await sell(app, [[product.id, 3, "piece"]]);
  assert.equal(app.api.getState().products[0].stock, 19.25);
  await sell(app, [[product.id, 2, "box"]]);
  assert.equal(app.api.getState().products[0].stock, 17.25);
});

test("8 (continued). 2 boxes from 20 boxes leaves exactly 18, with every price configured", async () => {
  const app = await startedApp();
  const product = await addThroughForm(app);
  const invoice = await sell(app, [[product.id, 2, "box"]]);
  assert.equal(app.api.getState().products[0].stock, 18);
  assert.equal(invoice.items[0].stockDeducted, 2);
});

/* ---------- 9: manufacturer ---------- */

test("9. the manufacturer is saved, edited, searched, shown on the invoice, and survives a backup and restore", async () => {
  const app = await startedApp();
  const product = await addThroughForm(app);
  assert.equal(app.api.findMatches("timgad").length, 1, "found by manufacturer");
  const edited = await editThroughForm(app, product.id, () => { app.field("pManufacturer").value = "Timgad Ceramic 2"; });
  assert.equal(edited.manufacturer, "Timgad Ceramic 2");
  assert.equal(app.api.findMatches("ceramic 2").length, 1);

  const invoice = await sell(app, [[product.id, 1, "box"]]);
  assert.match(app.api.invoiceHtml(invoice), /Timgad Ceramic 2/);

  await app.api.exportBackup();
  const parsed = V.parseBackup(await app.downloadedText());
  assert.equal(parsed.error, undefined, parsed.error);
  assert.equal(parsed.data.products[0].manufacturer, "Timgad Ceramic 2");

  const fresh = await startedApp();
  await fresh.api.importBackup(fresh.file(await app.downloadedText()));
  assert.equal(fresh.api.getState().products[0].manufacturer, "Timgad Ceramic 2");
});

test("9 (continued). a product saved without a manufacturer stays valid and is never given one", async () => {
  const app = await startedApp();
  const sku = FORM.pSku;
  const form = fillProductForm(app, { ...FORM, pManufacturer: "", priceRows: PRICES });
  await app.api.addProduct(form.values);
  assert.equal(app.api.getState().products.find((p) => p.sku === sku).manufacturer, "");
  assert.equal(V.productProblem(app.api.getState().products[0]), "");
  assert.equal(V.productProblem({ id: "x", name: "No brand", sellingPrice: 5, stock: 1 }), "", "an old product without the field is valid");
});

/* ---------- 10: migrating single-price products ---------- */

test("10. an existing single-price product keeps working: its price is read as one price in its own unit", async () => {
  const legacy = { id: "old1", name: "Golden Era", tileSize: "60*60", coveragePerBox: 1.44, sku: "GE", category: "", description: "", sellingPrice: 1000, priceUnit: "m2", stockUnit: "box", purchasePrice: null, stock: 7 };

  // read-time: no list is stored, one is derived
  assert.deepEqual(plain(Calc.getSellingPrices(legacy)), [{ unit: "m2", price: 1000 }]);
  assert.equal(Calc.getUnitPrice(legacy, "m2").value, 1000);
  assert.equal(Calc.getUnitPrice(legacy, "box").value, 1440);
  assert.equal(Calc.getUnitPrice(legacy, "box").source, "calculated");
  assert.equal(V.productProblem(legacy), "", "a record without sellingPrices is still valid");

  // normalising (restoring an old backup, loading demo data) fills the list from the old fields, nothing else changes
  const normalized = V.normalizeProduct(legacy);
  assert.deepEqual(plain(normalized.sellingPrices), [{ unit: "m2", price: 1000 }]);
  assert.equal(normalized.sellingPrice, 1000);
  assert.equal(normalized.priceUnit, "m2");
  assert.equal(normalized.stock, 7);
  assert.equal(normalized.manufacturer, "");

  // a product with no price unit is NOT assigned one: its price still applies as typed
  const unitless = V.normalizeProduct({ id: "old2", name: "Chips", sellingPrice: 120, stock: 5 });
  assert.deepEqual(plain(unitless.sellingPrices), []);
  assert.equal(unitless.priceUnit, null);
  assert.equal(Calc.getUnitPrice(unitless, "piece").value, 120);
  assert.equal(Calc.getUnitPrice(unitless, "piece").legacy, true);
  assert.equal(Calc.getUnitPrice(unitless, "box").value, 120);
});

test("10 (continued). a stored single-price product is untouched until edited, then saved with a price list", async () => {
  const app = await startedApp();
  const legacy = { id: "old1", name: "Golden Era", manufacturer: "", tileSize: "60*60", coveragePerBox: 1.44, sku: "GE", category: "", description: "", sellingPrice: 1000, priceUnit: "m2", stockUnit: "box", purchasePrice: null, stock: 7 };
  const saved = await app.api.commit((d) => { d.products.push(legacy); });
  assert.equal(saved && saved.error, undefined);
  const reloaded = app;
  const stored = (await reloaded.api.db.loadAll()).products[0];
  assert.equal("sellingPrices" in stored, false, "nothing was rewritten");
  assert.equal(stored.stock, 7, "stock is not reset");

  const edited = await editThroughForm(reloaded, "old1", () => {
    reloaded.api.addPriceRow();
    rowFor(reloaded, "piece").price = "300";
  });
  assert.deepEqual(plain(edited.sellingPrices), [{ unit: "m2", price: 1000 }, { unit: "piece", price: 300 }]);
  assert.equal(edited.stock, 7);
});

/* ---------- 11: backups ---------- */

test("11. a backup holds every price and restores them exactly; old backups still restore", async () => {
  const app = await startedApp();
  const product = await addThroughForm(app);
  await sell(app, [[product.id, 3, "piece"]]);
  await app.api.exportBackup();
  const text = await app.downloadedText();
  const file = JSON.parse(text);
  assert.deepEqual(plain(file.data.products[0].sellingPrices), [{ unit: "m2", price: 1000 }, { unit: "piece", price: 300 }, { unit: "box", price: 1440 }]);

  const fresh = await startedApp();
  await fresh.api.importBackup(fresh.file(text));
  const restored = fresh.api.getState().products[0];
  assert.deepEqual(plain(restored.sellingPrices), [{ unit: "m2", price: 1000 }, { unit: "piece", price: 300 }, { unit: "box", price: 1440 }]);
  assert.equal(restored.stock, 19.25);
  assert.equal(fresh.api.getState().invoices.length, 1);
  assert.equal(JSON.stringify(plain(fresh.api.getState().invoices[0].items)), JSON.stringify(plain(app.api.getState().invoices[0].items)));

  // a backup made before this feature (no sellingPrices anywhere) restores, and its products get one price each
  const old = JSON.parse(text);
  for (const p of old.data.products) { delete p.sellingPrices; p.sellingPrice = 1000; p.priceUnit = "m2"; }
  for (const inv of old.data.invoices) for (const i of inv.items) { delete i.priceSource; }
  const older = await startedApp();
  await older.api.importBackup(older.file(JSON.stringify(old)));
  assert.equal(older.api.getState().products.length, 1);
  assert.deepEqual(plain(older.api.getState().products[0].sellingPrices), [{ unit: "m2", price: 1000 }]);
  assert.equal(older.api.getState().products[0].stock, 19.25);
});

/* ---------- 12-13: invoices, payments and numbering ---------- */

test("12. saved invoices keep their prices after the catalogue prices change", async () => {
  const app = await startedApp();
  const product = await addThroughForm(app);
  const invoice = await sell(app, [[product.id, 3, "piece"], [product.id, 1, "box"]]);
  const before = JSON.stringify(invoice);
  const html = app.api.invoiceHtml(invoice);

  await editThroughForm(app, product.id, () => {
    rowFor(app, "piece").price = "999";
    rowFor(app, "box").price = "5000";
    rowFor(app, "m2").price = "2000";
  });
  assert.equal(priceOf(app.api.getState().products[0], "piece"), 999);

  const saved = app.api.getState().invoices[0];
  assert.equal(JSON.stringify(saved), before);
  assert.equal(app.api.invoiceHtml(saved), html, "the printed invoice is the same too");
  assert.deepEqual(plain(saved.items.map((i) => [i.qty, i.sellingUnit, i.unitPrice, i.total])), [[3, "piece", 300, 900], [1, "box", 1440, 1440]]);
  assert.equal(saved.total, 2340);
  const stored = (await app.api.db.loadAll()).invoices[0];
  assert.equal(stored.total, 2340);
});

test("12 (continued). an invoice saved before this feature still shows its original prices", async () => {
  const app = await startedApp();
  const tile = V.normalizeProduct({ id: "t1", name: "Ceramic Tile", tileSize: "60*60", coveragePerBox: 1.44, sellingPrice: 1500, priceUnit: "m2", stockUnit: "box", stock: 20 });
  const oldInvoice = {
    id: "i1", invoiceNumber: "INV-000007", date: new Date().toISOString(), customer: { name: "Walk-in Customer", phone: "", address: "" },
    items: [{ productId: "t1", name: "Ceramic Tile", manufacturer: "", tileSize: "60*60", coveragePerBox: 1.44, sellingUnit: "box", sku: "", qty: 2, unitPrice: 2160, total: 4320, priceUnit: "m2", productPrice: 1500, calculatedUnitPrice: 2160, priceOverridden: false, stockUnit: "box", stockDeducted: 2 }],
    subtotal: 4320, discount: 0, tax: 0, total: 4320, payments: [{ amount: 4320, timestamp: new Date().toISOString() }],
  };
  await app.api.commit((d) => { d.products.push(tile); d.invoices.push(oldInvoice); d.counter = 7; });
  const html = app.api.invoiceHtml(app.api.getState().invoices[0]);
  assert.match(html, /1,500 <span class="inv-unit">\/ m²<\/span>/);
  assert.match(html, /2 Boxes<div class="inv-sub">2\.88 m²<\/div>/);
  await editThroughForm(app, "t1", () => { rowFor(app, "m2").price = "9000"; });
  assert.equal(app.api.invoiceHtml(app.api.getState().invoices[0]), html);
});

test("13. payments, discounts, taxes and invoice numbering behave as before with several prices", async () => {
  const app = await startedApp();
  const product = await addThroughForm(app);

  const first = await sell(app, [[product.id, 3, "piece"], [product.id, 1, "box"]], (sale) => {
    sale.discountType = "percent"; sale.discountValue = "10";
    sale.taxType = "amount"; sale.taxValue = "100";
    sale.paidValue = "1000";
  });
  assert.equal(first.invoiceNumber, "INV-000001");
  assert.equal(first.subtotal, 2340);
  assert.equal(first.discount, 234);
  assert.equal(first.tax, 100);
  assert.equal(first.total, 2206);
  assert.deepEqual(plain(app.api.Validation.paymentSummary(first)), { payments: plain(first.payments), paid: 1000, remaining: 1206, cls: "partial" });

  // prices change; a later payment on the old invoice and the next invoice number are unaffected
  await editThroughForm(app, product.id, () => { rowFor(app, "piece").price = "350"; });
  const paid = await app.api.addPayment(first.id, "1206");
  assert.equal(paid && paid.error, undefined);
  const summary = app.api.Validation.paymentSummary(app.api.getState().invoices[0]);
  assert.equal(summary.cls, "paid");
  assert.equal(summary.payments.length, 2);
  assert.equal(app.api.getState().invoices[0].total, 2206);

  const second = await sell(app, [[product.id, 1, "piece"]], (sale) => { sale.paidValue = "350"; });
  assert.equal(second.invoiceNumber, "INV-000002");
  assert.equal(second.total, 350, "the new price applies to new sales only");
});

/* ---------- 14: rejecting bad entries ---------- */

test("14. duplicate units and invalid prices are rejected everywhere: form rules, saving, and backups", async () => {
  const check = (entries) => Calc.checkSellingPrices(entries);
  assert.equal(check([{ unit: "m2", price: 1 }, { unit: "m2", price: 2 }]).code, "duplicate");
  assert.equal(check([]).code, "none");
  assert.equal(check([{ unit: "yard", price: 1 }]).code, "unit");
  assert.equal(check([{ unit: "m2", price: "" }]).code, "missing");
  assert.equal(check([{ unit: "m2", price: null }]).code, "missing");
  assert.equal(check([{ unit: "m2", price: "abc" }]).code, "invalid");
  assert.equal(check([{ unit: "m2", price: Infinity }]).code, "invalid");
  assert.equal(check([{ unit: "m2", price: NaN }]).code, "invalid");
  assert.equal(check([{ unit: "m2", price: -1 }]).code, "negative");
  assert.equal(check([{ unit: "kg", price: 1 }, { unit: "piece", price: 2 }]).code, "mixed");
  assert.equal(check([{ unit: "m2", price: 0 }]).error, undefined, "0 is a valid price");
  assert.deepEqual(plain(check([{ unit: "m2", price: "12.5" }, { unit: "box", price: 3 }]).value), [{ unit: "m2", price: 12.5 }, { unit: "box", price: 3 }]);

  // the validation every save goes through
  const tile = V.normalizeProduct({ id: "t", name: "T", tileSize: "60*60", coveragePerBox: 1.44, sellingPrice: 1000, priceUnit: "m2", stockUnit: "box", stock: 1 });
  assert.equal(V.productProblem(tile), "");
  assert.match(V.productProblem({ ...tile, sellingPrices: [{ unit: "m2", price: 1000 }, { unit: "m2", price: 5 }] }), /two selling prices for the same unit/);
  assert.match(V.productProblem({ ...tile, sellingPrices: [{ unit: "m2", price: -5 }] }), /invalid list of selling prices/);
  assert.match(V.productProblem({ ...tile, sellingPrices: [{ unit: "m2", price: "1000" }] }), /invalid list of selling prices/, "a price must be a number, not text");
  assert.match(V.productProblem({ ...tile, sellingPrices: "m2" }), /invalid list of selling prices/);

  const app = await startedApp();
  const bad = await app.api.commit((d) => { d.products.push({ ...tile, sellingPrices: [{ unit: "m2", price: 1 }, { unit: "m2", price: 2 }] }); });
  assert.ok(bad.error, "the database refuses to save it");
  assert.equal((await app.api.db.loadAll()).products.length, 0);

  // a backup with such a product is refused, never repaired
  const good = V.buildBackup({ products: [tile], invoices: [], settings: { ...V.DEFAULT_SETTINGS }, counter: 0 }, new Date());
  assert.equal(V.parseBackup(JSON.stringify(good)).error, undefined);
  good.data.products[0].sellingPrices = [{ unit: "m2", price: 1000 }, { unit: "m2", price: 1 }];
  assert.ok(V.parseBackup(JSON.stringify(good)).error);
});

test("14 (continued). a product edit with a bad price row is not saved", async () => {
  const app = await startedApp();
  const product = await addThroughForm(app);
  app.api.startEditProduct(product.id);
  for (const key of ["pStock", "pCoveragePerBox", "pCost"]) app.field(key).value = String(app.field(key).value);
  rowFor(app, "piece").price = "";
  const form = app.api.readProductForm();
  assert.ok(form.error);
  assert.equal(form.error, "Enter the price per piece.");
  assert.equal(priceOf(app.api.getState().products[0], "piece"), 300, "the saved price is untouched");
});

test("a price can be edited after pieces were sold from box-counted stock; a newly typed fraction of a box is still refused", async () => {
  const app = await startedApp();
  const product = await addThroughForm(app);
  await sell(app, [[product.id, 3, "piece"]]);
  assert.equal(app.api.getState().products[0].stock, 19.25);

  const edited = await editThroughForm(app, product.id, () => { rowFor(app, "piece").price = "310"; });
  assert.equal(edited.stock, 19.25, "the saved partial box is kept exactly");
  assert.equal(priceOf(edited, "piece"), 310);

  app.api.startEditProduct(product.id);
  for (const key of ["pCoveragePerBox", "pCost"]) app.field(key).value = String(app.field(key).value);
  app.field("pStock").value = "19.5";
  assert.equal(app.api.readProductForm().field, "pStock", "typing 19.5 boxes is refused as before");
  app.field("pStock").value = "19";
  assert.equal(app.api.readProductForm().error, undefined);
});

/* ---------- Working with the m² sale lines and the sale re-pricing ---------- */

test("an area typed in m² is supplied in whole boxes, priced with the saved box price or worked out from the m² price", async () => {
  const app = await startedApp();
  const product = await addThroughForm(app);                    // 1,000 DA/m², 300 DA/piece and 1,440 DA/box saved, stock counted in boxes
  assert.equal(app.api.addToSale(product.id, "10", "m2").ok, true);   // 10 / 1.44 = 6.94 boxes -> 7
  let line = app.api.getSale().items[0];
  assert.deepEqual(plain([line.qty, line.sellingUnit, line.unitPrice, line.catalog.source]), [7, "box", 1440, "explicit"]);
  assert.equal(Calc.calculateLineTotal(line.qty, line.unitPrice), 10080);   // 7 boxes = 10.08 m² x 1,000 DA/m²

  const invoice = await sell(app, [], null);
  assert.equal(invoice.items[0].unitPriceUnit, "box");
  assert.equal(invoice.items[0].priceSource, "explicit");
  assert.equal(invoice.items[0].stockDeducted, 7);
  assert.equal(invoice.total, 10080);
  assert.equal(app.api.getState().products[0].stock, 13, "7 whole boxes leave the stock");

  // only an m² price saved: the box price is worked out from it, and the invoice keeps showing the price per m²
  const m2Only = await addThroughForm(app, { pSku: "EV-2", priceRows: [{ unit: "m2", price: "1000" }] });
  app.api.addToSale(m2Only.id, "10", "m2");
  line = app.api.getSale().items[0];
  assert.deepEqual(plain([line.qty, line.sellingUnit, line.unitPrice, line.catalog.source, line.catalog.unit, line.catalog.price]), [7, "box", 1440, "calculated", "m2", 1000]);
  app.api.getSale().items = [];

  // only a box price saved
  const boxOnly = await addThroughForm(app, { pSku: "EV-3", priceRows: [{ unit: "box", price: "1440" }] });
  app.api.addToSale(boxOnly.id, "1", "m2");                     // 0.69 box -> 1 box
  line = app.api.getSale().items[0];
  assert.deepEqual(plain([line.qty, line.sellingUnit, line.unitPrice, line.catalog.source]), [1, "box", 1440, "explicit"]);
});

test("a price changed in Stock reaches sale lines at the normal price (also a newly saved price for that unit), never a typed one", async () => {
  const app = await startedApp();
  const product = await addThroughForm(app, { priceRows: [{ unit: "m2", price: "1000" }] });
  app.api.addToSale(product.id, "2", "piece");          // 360, worked out from the m² price
  app.api.addToSale(product.id, "2", "box");
  app.api.updateSalePrice(app.api.getSale().items[1].lineId, "1300");
  assert.equal(app.api.getSale().items[0].unitPrice, 360);

  // a piece price of its own is saved while the sale is open
  await editThroughForm(app, product.id, () => { app.api.addPriceRow(); rowFor(app, "piece").price = "300"; });
  app.api.syncSaleWithProducts();
  const [piece, box] = app.api.getSale().items;
  assert.equal(piece.unitPrice, 300);
  assert.equal(piece.catalog.source, "explicit", "the line's record of its catalogue price follows too");
  assert.equal(box.unitPrice, 1300, "a typed price is kept exactly");
  assert.equal(box.priceOverridden, true);
  assert.equal(box.listPrice, 1440);

  const invoice = await sell(app, [], null);
  assert.equal(invoice.items[0].priceSource, "explicit");
  assert.equal(invoice.items[0].productPrice, 300);
  assert.equal(invoice.items[1].priceSource, "custom");
});

test("the main price follows the product's sellingPrice / priceUnit, whoever writes them; the other prices stay", async () => {
  const product = V.normalizeProduct({ id: "m", name: "Multi", tileSize: "60*60", coveragePerBox: 1.44, stockUnit: "box", stock: 5, sellingPrice: 1000, priceUnit: "m2", sellingPrices: [{ unit: "m2", price: 1000 }, { unit: "piece", price: 300 }] });
  assert.deepEqual(plain(Calc.getSellingPrices(product)), [{ unit: "m2", price: 1000 }, { unit: "piece", price: 300 }]);

  // another part of the app (or an older version) changes the main price in the old fields
  const changed = { ...product, sellingPrice: 1100 };
  assert.deepEqual(plain(Calc.getSellingPrices(changed)), [{ unit: "m2", price: 1100 }, { unit: "piece", price: 300 }]);
  assert.equal(Calc.getUnitPrice(changed, "m2").value, 1100);
  assert.equal(Calc.getUnitPrice(changed, "piece").value, 300, "the other price is untouched");
  assert.equal(Calc.getUnitPrice(changed, "box").value, 1584, "and a unit with no price follows the main price");

  // a list with no old fields (nothing else writes them) is read as it is
  const listOnly = { name: "L", sellingPrices: [{ unit: "box", price: 50 }, { unit: "piece", price: 20 }] };
  assert.deepEqual(plain(Calc.getSellingPrices(listOnly)), [{ unit: "box", price: 50 }, { unit: "piece", price: 20 }]);
});

test("a product created from a purchase (one price in the old fields) can be edited in Stock and gets a price list", async () => {
  const app = await startedApp();
  const created = { id: "pp1", name: "From purchase", manufacturer: "", tileSize: "60*60", coveragePerBox: 1.44, sku: "PP", category: "", description: "", sellingPrice: 1000, priceUnit: "m2", stockUnit: "box", purchasePrice: null, stock: 0 };
  const saved = await app.api.commit((d) => { d.products.push(created); });
  assert.equal(saved && saved.error, undefined);
  const edited = await editThroughForm(app, "pp1", () => { app.api.addPriceRow(); rowFor(app, "piece").price = "300"; });
  assert.deepEqual(plain(edited.sellingPrices), [{ unit: "m2", price: 1000 }, { unit: "piece", price: 300 }]);
  assert.equal(edited.sellingPrice, 1000);
});

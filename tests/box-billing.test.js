"use strict";

// Products sold per m² are sold in whole boxes and billed for the area those boxes contain, at the configured price per m²;
// products sold per piece are billed in pieces with no conversion. Tested through the application's own functions: the sale,
// the saved invoice, the stock, the printed invoice markup, the invoice editor and the backup file.
//
//   requestedArea / coveragePerBox -> ceil -> boxesRequired;  boxesRequired x coveragePerBox -> actualSuppliedArea;
//   actualSuppliedArea x pricePerSquareMetre -> lineTotal.   A price per box is never worked out, saved or printed.

const assert = require("node:assert/strict");
const test = require("node:test");
const { loadProductApi, openDatabase } = require("./helpers");
const { loadApp } = require("./helpers/app");
const { FakeHandle } = require("./helpers/fake-handle");

require("./helpers/modules");   // loads calc.js, validation.js and the languages into this process
const Calc = globalThis.Calc;
const plain = (value) => JSON.parse(JSON.stringify(value));   // the app runs in its own context: compare plain data

const GPT = { id: "gpt", name: "GPT", sku: "GPT-1", tileSize: "60*60", coveragePerBox: 1.44, sellingPrice: 1400, priceUnit: "m2", stockUnit: "box", stock: 20 };
const DECOR = { id: "decor", name: "Metro Gray Decor", sku: "MGD-1", tileSize: "30*30", coveragePerBox: 1.08, sellingPrice: 1600, priceUnit: "piece", stockUnit: "piece", stock: 100 };

function load(products = [GPT], language = "en") {
  const { api, field } = loadProductApi();
  api.applyData({
    products: products.map((p) => api.normalizeProduct(p)), invoices: [],
    settings: { ...api.DEFAULT_SETTINGS, language }, counter: 0, lastSaved: "",
  });
  return { api, field };
}

// Completes the sale the way the app does (one commit) and returns the saved invoice.
async function complete(api) {
  await openDatabase(api);
  const result = await api.commit((d) => api.applySale(d, api.getSale()));
  assert.equal(result.error, undefined, result.error);
  return result.invoice;
}
const stock = (api, id = "gpt") => api.getProducts().find((p) => p.id === id).stock;
const line = (api, index = 0) => api.getSale().items[index];

// The product rows of the printed pages: what window.print() prints is laid out from exactly these entries.
const printedRows = (api, invoice) => [...[...api.printItems(invoice)].find((item) => item.kind === "flow").entries];   // the first flowing section is the product table

// The cells of the one product row an invoice prints: quantity, price, total.
const cells = (row) => {
  const [, qty, price, total] = [...row.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((m) => m[1]);
  return { qty, price, total };
};

/* ==========================================================================
   Test A: a fractional box requirement (the Tile GPT example)
   ========================================================================== */

test("A. GPT: 10 m² at 1,400 DA/m², 1.44 m² per box -> 7 boxes, 10.08 m², 14,112 DA", async () => {
  const { api, field } = load();
  const raw = Calc.boxesForArea(GPT, 10);
  assert.equal(raw.exact, 6.94444444444, "raw requirement 10 / 1.44 = 6.9444…");
  const added = api.addToSale("gpt", "10", "m2");
  assert.deepEqual(plain(added.converted), { requested: 10, exact: 6.94444444444, boxes: 7, area: 10.08 });

  // the sale line: 7 boxes, billed for the 10.08 m² they contain at the configured 1,400 DA/m²
  assert.deepEqual(plain([line(api).qty, line(api).sellingUnit, line(api).unitPrice, line(api).priceUnit, line(api).priceQty, line(api).requestedArea]),
    [7, "box", 1400, "m2", 10.08, 10]);
  assert.equal(api.calculateTotals(api.getSale()).total, 14112, "not 14,000 (the 10 m² asked for)");
  api.renderSale();
  const row = field("saleBody").innerHTML;
  assert.match(row, /class="qty-input"[^>]*value="7"/);
  assert.match(row, /class="price-input"[^>]*value="1400"/);
  assert.match(row, /<span class="price-unit" data-price-unit>DA\/m²<\/span>/);
  assert.match(row, /data-line-total>14,112 DA</);
  assert.match(row, /Billed: 10\.08 m² · 1 Box = 1\.44 m²/);
  assert.doesNotMatch(row, /2,016|14,000/);

  // the live preview shows what will be saved
  const preview = api.invoiceHtml(api.buildInvoiceData(api.getSale(), "INV-000001", new Date().toISOString()));
  assert.match(preview, /<td>GPT \(60 × 60\)<\/td><td class="num">7 Boxes<div class="inv-sub">10\.08 m²<\/div><\/td><td class="num">1,400 <span class="inv-unit">\/ m²<\/span><\/td><td class="num">14,112<\/td>/);

  // the saved invoice
  const invoice = await complete(api);
  const item = invoice.items[0];
  assert.deepEqual(plain([item.qty, item.sellingUnit, item.total, invoice.subtotal, invoice.total]), [7, "box", 14112, 14112, 14112]);
  assert.deepEqual(plain([item.requestedArea, item.suppliedArea, item.chargedPrice, item.priceUnit, item.productPrice, item.coveragePerBox]), [10, 10.08, 1400, "m2", 1400, 1.44],
    "what was asked for, what was supplied, the price charged per m², all kept on the line");
  assert.equal(Calc.calculateLineTotal(item.qty, item.unitPrice), 14112, "the saved quantity x price still gives the saved total");

  // the invoice as the page shows it, and the pages that are printed: the same quantity, price and total, and no price per box
  for (const [label, html] of [["saved invoice", api.invoiceHtml(invoice)], ["printed rows", printedRows(api, invoice).join("")]]) {
    assert.match(html, /<td class="num">7 Boxes<div class="inv-sub">10\.08 m²<\/div><\/td>/, label);
    assert.match(html, /<td class="num">1,400 <span class="inv-unit">\/ m²<\/span><\/td>/, label);
    assert.match(html, /<td class="num">14,112<\/td>/, label);
    assert.doesNotMatch(html, /\/ Box|2,016|14,000|6\.94|>10 m²</, label + ": no price per box, no area asked for shown as boxes");
  }
  api.getState().previewInvoice = invoice;   // what the Print button does first...
  api.renderInvoice();                       // ...which is exactly what window.print() then prints
  assert.match(field("invoice").innerHTML, /7 Boxes<div class="inv-sub">10\.08 m²<\/div>/);
  assert.doesNotMatch(field("invoice").innerHTML, /\/ Box/);

  // stock: 7 boxes, once (not 10 boxes, not 7 boxes and then 10.08 m² again)
  assert.equal(item.stockDeducted, 7);
  assert.equal(stock(api), 13);
  assert.equal(api.getProducts()[0].sellingPrice, 1400, "the product keeps its configured price");
  assert.equal(api.getProducts()[0].priceUnit, "m2");
});

/* ==========================================================================
   Test B: an exact box requirement
   ========================================================================== */

test("B. 7.2 m² at 1.44 m² per box is exactly 5 boxes: no extra box, 10,080 DA", async () => {
  const { api } = load();
  assert.equal(Calc.boxesForArea(GPT, 7.2).exact, 5);
  api.addToSale("gpt", "7.2", "m2");
  assert.deepEqual(plain([line(api).qty, line(api).priceQty]), [5, 7.2]);
  assert.equal(api.calculateTotals(api.getSale()).total, 10080);
  const invoice = await complete(api);
  assert.deepEqual(plain([invoice.items[0].qty, invoice.items[0].suppliedArea, invoice.items[0].total, invoice.items[0].stockDeducted]), [5, 7.2, 10080, 5]);
  assert.equal(stock(api), 15, "5 boxes leave the stock, not 6");
  assert.match(api.invoiceHtml(invoice), /5 Boxes<div class="inv-sub">7\.2 m²<\/div>/);
});

test("the next hundredth of a m² needs one more box (7.21 m² -> 6 boxes, 8.64 m²)", () => {
  const { api } = load();
  api.addToSale("gpt", "7.21", "m2");
  assert.deepEqual(plain([line(api).qty, line(api).priceQty]), [6, 8.64]);
  assert.equal(api.calculateTotals(api.getSale()).total, 12096);
});

/* ==========================================================================
   Test C: products sold per piece are not converted
   ========================================================================== */

test("C. Metro Gray Decor: 10 pieces at 1,600 DA/piece -> 10 Pieces, 16,000 DA, 10 pieces from stock, no box conversion", async () => {
  const { api } = load([DECOR]);
  const added = api.addToSale("decor", "10", "piece");
  assert.equal(added.converted, undefined, "nothing was converted");
  assert.deepEqual(plain([line(api).qty, line(api).sellingUnit, line(api).unitPrice, line(api).priceUnit, line(api).priceQty]), [10, "piece", 1600, "piece", 10]);
  assert.equal(line(api).requestedArea, undefined);
  assert.equal(api.calculateTotals(api.getSale()).total, 16000);
  const invoice = await complete(api);
  const item = invoice.items[0];
  assert.deepEqual(plain([item.qty, item.sellingUnit, item.unitPrice, item.total, item.stockDeducted]), [10, "piece", 1600, 16000, 10]);
  assert.equal(item.chargedPrice, undefined);
  assert.equal(item.suppliedArea, undefined, "no area is worked out for a piece sale");
  assert.equal(stock(api, "decor"), 90);
  const printed = cells(printedRows(api, invoice)[0]);
  assert.deepEqual(plain(printed), { qty: "10 Pieces", price: '1,600 <span class="inv-unit">/ Piece</span>', total: "16,000" });
  assert.doesNotMatch(api.invoiceHtml(invoice), /m²|Box/, "no m² and no boxes anywhere on the line");
});

test("C. the pricing unit decides, not the name or the dimensions: a 'Decor' priced per m² is converted, a tile named GPT priced per piece is not", async () => {
  const perM2 = { ...DECOR, id: "d2", sku: "D2", sellingPrice: 1400, priceUnit: "m2", stockUnit: "box", stock: 20 };
  const perPiece = { ...GPT, id: "g2", sku: "G2", sellingPrice: 1600, priceUnit: "piece", stockUnit: "piece", stock: 100 };
  const { api } = load([perM2, perPiece]);
  assert.equal(api.addToSale("d2", "10", "m2").converted.boxes, 10, "10 m² / 1.08 = 9.26 -> 10 boxes (10.8 m²)");
  assert.equal(line(api, 0).priceQty, 10.8);
  assert.equal(api.addToSale("g2", "10", "piece").converted, undefined);
  assert.deepEqual(plain([line(api, 1).qty, line(api, 1).sellingUnit, line(api, 1).priceQty]), [10, "piece", 10]);
  assert.equal(api.calculateTotals(api.getSale()).total, 15120 + 16000);   // 10.8 m² x 1,400 + 10 x 1,600
  const invoice = await complete(api);
  assert.deepEqual(plain(invoice.items.map((i) => [i.sellingUnit, i.qty, i.total, i.stockDeducted])), [["box", 10, 15120, 10], ["piece", 10, 16000, 10]]);
});

/* ==========================================================================
   Test D: other coverage values, read from the product
   ========================================================================== */

const COVERAGES = [["90*45", 1.215], ["30*90", 1.62], ["25*75", 1.5], ["90*90", 1.62], ["60*60", 1.44]];

test("D. every saved coverage is read from the product: boxes, supplied area and total match an exact integer calculation", () => {
  for (const [tileSize, coverage] of COVERAGES) {
    const product = { ...GPT, id: "p", tileSize, coveragePerBox: coverage, stock: 100000 };
    const milli = Math.round(coverage * 1000);
    for (const area of [0.5, 1, 5, 10, 25, 37.5, 99.99, 100.01, 250]) {
      const { api } = load([product]);
      assert.equal(api.addToSale("p", String(area), "m2").ok, true, `${coverage} / ${area}`);
      const askedMilli = Math.round(area * 1000);
      const boxes = Math.ceil(askedMilli / milli);                 // integer arithmetic: no floating point involved
      const suppliedMilli = boxes * milli;
      assert.equal(line(api).qty, boxes, `${coverage} m² per box, ${area} m²`);
      assert.equal(Math.round(line(api).priceQty * 1000), suppliedMilli, `${coverage} m² per box, ${area} m²: supplied area`);
      assert.equal(api.calculateTotals(api.getSale()).total, Calc.roundMoney(suppliedMilli * 1400 / 1000), `${coverage} m² per box, ${area} m²: total`);
    }
  }
});

test("D. an exact multiple of any saved coverage never adds a box", () => {
  for (const [tileSize, coverage] of COVERAGES) {
    for (let boxes = 1; boxes <= 60; boxes++) {
      const { api } = load([{ ...GPT, id: "p", tileSize, coveragePerBox: coverage, stock: 1000 }]);
      const typed = String(Number((boxes * coverage).toFixed(6)));   // the area as it is typed: 7.2, 8.505, ...
      api.addToSale("p", typed, "m2");
      assert.equal(line(api).qty, boxes, `${typed} m² at ${coverage} m² per box`);
    }
  }
});

test("D. changing a product's coverage changes the next sale, not a saved invoice", async () => {
  const { api } = load();
  api.addToSale("gpt", "10", "m2");
  const invoice = await complete(api);
  const before = JSON.stringify(invoice);
  const htmlBefore = api.invoiceHtml(invoice);
  await api.commit((d) => { Object.assign(d.products[0], { coveragePerBox: 1.62, tileSize: "90*90", sellingPrice: 2500 }); });
  assert.equal(JSON.stringify(api.getInvoices()[0]), before);
  assert.equal(api.invoiceHtml(api.getInvoices()[0]), htmlBefore);
  api.getSale().items = [];                                    // the first sale is finished
  assert.equal(api.addToSale("gpt", "10", "m2").ok, true);
  assert.deepEqual(plain([line(api).qty, line(api).priceQty, line(api).unitPrice]), [7, 11.34, 2500], "10 / 1.62 = 6.17 -> 7 boxes = 11.34 m² at the new price");
});

/* ==========================================================================
   Test E: the printed invoice, in every language
   ========================================================================== */

test("E. the printed quantity, area, configured price and total in English, French and Arabic; never a price per box", async () => {
  const SEP = "[\\s\u00a0\u202f,.]?";                                  // the thousands separator differs by language
  for (const language of ["en", "fr", "ar"]) {
    const { api } = load([GPT], language);
    api.addToSale("gpt", "10", "m2");
    const invoice = await complete(api);
    for (const html of [api.invoiceHtml(invoice), printedRows(api, invoice).join("")]) {
      const row = html.match(/<tr><td>GPT.*?<\/tr>/s)[0];
      assert.match(row, /10[.,]08 (m²|م²)<\/div>/, language + ": the area supplied");
      assert.match(row, new RegExp(`1${SEP}400 <span class="inv-unit">\\/ (m²|م²)<\\/span>`), language + ": the configured price per m²");
      assert.match(row, new RegExp(`<td class="num">14${SEP}112<\\/td>`), language);
      assert.doesNotMatch(row, new RegExp(`2${SEP}016|14${SEP}000`), language + ": no price per box, no total on the area asked for");
      assert.doesNotMatch(row, /<span class="inv-unit">\/ (Box|Carton|كرتون)/, language);
    }
  }
});

test("E. a line with a price typed for this sale prints that price per m², never per box", async () => {
  const { api } = load();
  api.addToSale("gpt", "10", "m2");
  assert.equal(api.updateSalePrice(line(api).lineId, "1300").error, undefined);
  assert.equal(api.calculateTotals(api.getSale()).total, 13104);   // 10.08 m² x 1,300
  const invoice = await complete(api);
  const printed = cells(printedRows(api, invoice)[0]);
  assert.deepEqual(plain(printed), { qty: '7 Boxes<div class="inv-sub">10.08 m²</div>', price: '1,300 <span class="inv-unit">/ m²</span>', total: "13,104" });
  assert.equal(invoice.items[0].priceSource, "custom");
  assert.equal(stock(api), 13);
});

test("E. a line that was boxes typed by hand (no area asked for) prints the same way", async () => {
  const { api } = load();
  api.addToSale("gpt", "7", "box");
  const invoice = await complete(api);
  assert.equal(invoice.items[0].requestedArea, undefined);
  assert.deepEqual(plain(cells(printedRows(api, invoice)[0])), { qty: '7 Boxes<div class="inv-sub">10.08 m²</div>', price: '1,400 <span class="inv-unit">/ m²</span>', total: "14,112" });
});

/* ==========================================================================
   Test F: discount, tax, payments and balances on the corrected line totals
   ========================================================================== */

test("F. discount, tax and a partial payment work from the corrected line totals", async () => {
  const { api } = load([GPT, DECOR]);
  api.addToSale("gpt", "10", "m2");            // 14,112
  api.addToSale("decor", "10", "piece");       // 16,000
  const sale = api.getSale();
  Object.assign(sale, { discountType: "percent", discountValue: "10", taxType: "amount", taxValue: "500", paidValue: "10000" });
  assert.deepEqual(plain(api.calculateTotals(sale)), { subtotal: 30112, discount: 3011.2, tax: 500, total: 27600.8 });
  const invoice = await complete(api);
  assert.deepEqual(plain([invoice.subtotal, invoice.discount, invoice.tax, invoice.total]), [30112, 3011.2, 500, 27600.8]);
  assert.deepEqual(plain(invoice.payments.map((p) => p.amount)), [10000]);
  const pay = api.paymentInfo(invoice);
  assert.deepEqual(plain([pay.paid, pay.remaining, pay.cls]), [10000, 17600.8, "partial"]);
  const html = api.invoiceHtml(invoice);
  assert.match(html, /<td>TOTAL<\/td><td>27,600\.8 DA<\/td>/);          // the discount and the tax were applied once
  assert.equal(Calc.roundMoney(invoice.items.reduce((sum, i) => sum + Calc.calculateLineTotal(i.qty, i.unitPrice), 0)), invoice.subtotal, "the lines add up to the subtotal");
  assert.deepEqual(plain([stock(api, "gpt"), stock(api, "decor")]), [13, 90]);
});

test("F. a sale that is paid in full and one that is not paid at all", async () => {
  for (const [paid, cls, remaining] of [["14112", "paid", 0], ["", "unpaid", 14112]]) {
    const { api } = load();
    api.addToSale("gpt", "10", "m2");
    api.getSale().paidValue = paid;
    const pay = api.paymentInfo(await complete(api));
    assert.deepEqual(plain([pay.cls, pay.remaining]), [cls, remaining]);
  }
  const { api } = load();
  api.addToSale("gpt", "10", "m2");
  api.getSale().paidValue = "14113";
  assert.match(api.validateSale().join(" "), /more than|exceed|total/i, "paying more than the total is still refused");
});

/* ==========================================================================
   Input validation and stock
   ========================================================================== */

test("missing, zero or negative coverage stops the sale with a clear reason and substitutes nothing", () => {
  for (const coverage of [null, 0, -1.44]) {
    const { api } = load();
    api.getProducts()[0].coveragePerBox = coverage;   // as if the saved value were damaged
    const result = api.addToSale("gpt", "10", "m2");
    assert.match(result.error, /coverage per box/i, `coverage ${coverage}`);
    assert.equal(api.getSale().items.length, 0, "nothing was added");
    assert.equal(stock(api), 20);
  }
  assert.match(Calc.boxesForArea({ name: "X" }, 10).error, /coverage per box/i);
});

test("zero, negative, blank and invalid areas and quantities are refused", () => {
  const { api } = load();
  for (const bad of ["0", "-1", "-0.5", "", "abc", "NaN"]) {
    assert.ok(api.addToSale("gpt", bad, "m2").error, `area "${bad}"`);
    assert.ok(api.addToSale("gpt", bad, "box").error, `boxes "${bad}"`);
  }
  assert.ok(api.addToSale("gpt", "2.5", "box").error, "half a box can't be sold");
  assert.ok(api.addToSale("decor", "1", "piece").error, "an unknown product is refused");
  assert.equal(api.getSale().items.length, 0);
});

test("insufficient stock: the sale is refused in whole boxes, on the sale page and again when it is saved", async () => {
  const { api } = load([{ ...GPT, stock: 6 }]);
  assert.match(api.addToSale("gpt", "10", "m2").error, /Not enough stock/);   // 10 m² needs 7 boxes, 6 are left
  assert.equal(api.getSale().items.length, 0);
  assert.equal(api.addToSale("gpt", "8.64", "m2").ok, true);                    // exactly 6 boxes
  assert.equal(line(api).qty, 6);

  // the stock went down elsewhere after the line was added: saving checks again and changes nothing
  await openDatabase(api);
  api.getProducts()[0].stock = 5;
  const before = JSON.stringify(api.getProducts());
  const result = await api.commit((d) => api.applySale(d, api.getSale()));
  assert.match(result.error, /Not enough stock/);
  assert.equal(JSON.stringify(api.getProducts()), before, "no stock was taken");
  assert.equal(api.getInvoices().length, 0, "no invoice was saved");
});

test("stock is deducted once per sale, in the stock unit, however the quantity was typed", async () => {
  for (const [typed, unit, boxes] of [["10", "m2", 7], ["7", "box", 7], ["10.08", "m2", 7], ["10.09", "m2", 8]]) {
    const { api } = load();
    api.addToSale("gpt", typed, unit);
    const invoice = await complete(api);
    assert.equal(invoice.items[0].stockDeducted, boxes, `${typed} ${unit}`);
    assert.equal(stock(api), 20 - boxes, `${typed} ${unit}`);
  }
});

test("a box-priced product with a saved box price keeps that configured price per box", async () => {
  const { api } = load([{ ...GPT, sellingPrice: 2016, priceUnit: "box" }]);
  api.addToSale("gpt", "10", "m2");
  assert.deepEqual(plain([line(api).qty, line(api).unitPrice, line(api).priceUnit]), [7, 2016, "box"]);
  assert.equal(api.calculateTotals(api.getSale()).total, 14112);
  const invoice = await complete(api);
  assert.equal(invoice.items[0].chargedPrice, undefined, "the price was configured per box, so it is printed per box");
  assert.deepEqual(plain(cells(printedRows(api, invoice)[0])), { qty: "7 Boxes", price: '2,016 <span class="inv-unit">/ Box</span>', total: "14,112" });
});

/* ==========================================================================
   Test G: historical invoices, the invoice editor and backups
   ========================================================================== */

test("G. an invoice saved before this change prints exactly as it was saved and is not recalculated", async () => {
  const { api } = load();
  await openDatabase(api);
  // the shape an older version saved for GPT: 10 m² asked for, billed as 10 m² (14,000), 7 boxes at 2,000 DA per box
  const old = {
    id: "old-1", invoiceNumber: "INV-000001", date: "2026-09-01T10:00:00.000Z", customer: { name: "Alex", phone: "", address: "" },
    items: [{ productId: "gpt", name: "GPT", manufacturer: "", tileSize: "60*60", coveragePerBox: 1.44, sellingUnit: "box", sku: "GPT-1", qty: 7, unitPrice: 2000, unitPriceUnit: "box",
      total: 14000, priceUnit: "m2", productPrice: 1400, calculatedUnitPrice: 2016, priceOverridden: false, stockUnit: "box", stockDeducted: 7 }],
    subtotal: 14000, discount: 0, tax: 0, total: 14000, payments: [{ amount: 14000, timestamp: "2026-09-01T10:00:00.000Z" }],
    discountPercent: null, taxPercent: null, currency: "DA", business: { name: "Shop", address: "", phone: "", email: "" },
  };
  await api.commit((d) => { d.invoices.push(old); d.counter = 1; });
  const before = JSON.stringify(api.getInvoices()[0]);
  const htmlBefore = api.invoiceHtml(api.getInvoices()[0]);
  await api.commit((d) => { Object.assign(d.products[0], { coveragePerBox: 2.88, sellingPrice: 9999, tileSize: "60*120" }); });
  assert.equal(JSON.stringify(api.getInvoices()[0]), before, "the saved record is untouched");
  assert.equal(api.invoiceHtml(api.getInvoices()[0]), htmlBefore, "and prints the same");
  assert.deepEqual(plain([api.getInvoices()[0].total, api.paymentInfo(api.getInvoices()[0]).remaining]), [14000, 0]);
});

test("G. a saved invoice is not recalculated when the product's price, coverage or unit change; a backup keeps every value", async () => {
  const { api } = load();
  api.addToSale("gpt", "10", "m2");
  const invoice = await complete(api);
  const before = JSON.stringify(invoice);
  const htmlBefore = api.invoiceHtml(invoice);
  await api.commit((d) => { Object.assign(d.products[0], { sellingPrice: 5000, priceUnit: "piece", coveragePerBox: 2.88, tileSize: "30*30" }); });
  assert.equal(JSON.stringify(api.getInvoices()[0]), before);
  assert.equal(api.invoiceHtml(api.getInvoices()[0]), htmlBefore);
  assert.match(htmlBefore, /7 Boxes<div class="inv-sub">10\.08 m²<\/div>.*1,400 <span class="inv-unit">\/ m²<\/span>.*14,112/s);

  // export and restore: the new fields survive, and the file still passes the backup checks
  const state = { ...api.getState(), invoices: api.getInvoices(), products: api.getProducts() };
  const written = api.Validation.prepareBackupFile(plain({ products: state.products, invoices: state.invoices, settings: state.settings, counter: state.counter, debtTransfers: [] }), new Date());
  assert.equal(written.error, undefined, written.error);
  const loaded = api.Validation.parseBackup(written.text);
  assert.equal(loaded.error, undefined, loaded.error);
  const item = loaded.data.invoices[0].items[0];
  assert.deepEqual(plain([item.qty, item.total, item.chargedPrice, item.suppliedArea, item.requestedArea]), [7, 14112, 1400, 10.08, 10]);
});

// ----- the invoice editor (corrections and returns on a saved invoice) -----

async function boot() {
  const handle = new FakeHandle();
  const app = loadApp({ globals: { showSaveFilePicker: async () => handle, window: { print() {}, addEventListener() {} } } });
  const storage = await app.start();
  assert.equal(storage.mode, "ready", storage.reason);
  await app.api.connectBackupFile();
  return { api: app.api, app };
}

async function sellGpt(api, area) {
  const { id, ...values } = { ...GPT, name: "GPT", sku: "GPT-ED", stock: 20 };
  await api.addProduct(values);
  const product = api.getState().products.find((p) => p.sku === "GPT-ED");
  assert.equal(api.addToSale(product.id, area, "m2").ok, true);
  await api.completeSale();
  const all = api.getInvoices();
  return { product, invoice: all[all.length - 1] };
}

test("G. correcting the boxes of a saved invoice keeps the area and the total consistent, and gives the boxes back to stock", async () => {
  const { api } = await boot();
  const { product, invoice } = await sellGpt(api, "10");
  assert.deepEqual(plain([invoice.items[0].qty, invoice.items[0].total, invoice.items[0].suppliedArea]), [7, 14112, 10.08]);
  assert.equal(api.getState().products.find((p) => p.id === product.id).stock, 13);

  assert.equal(api.startEditInvoice(invoice.id).error, undefined);   // the invoice opens on the Sell page
  assert.deepEqual(plain([line(api).qty, line(api).priceUnit, line(api).unitPrice, line(api).priceQty]), [7, "m2", 1400, 10.08], "the Sell page shows the saved price per m² and area");
  assert.equal(api.updateSaleQuantity(line(api).lineId, "5").error, undefined);   // two boxes come back
  assert.equal(line(api).priceQty, 7.2, "billed for the area the 5 boxes contain");
  await api.saveInvoiceEdit();
  const saved = api.getState().invoices.find((i) => i.id === invoice.id);
  assert.deepEqual(plain([saved.items[0].qty, saved.items[0].total, saved.items[0].suppliedArea, saved.items[0].chargedPrice, saved.total]), [5, 10080, 7.2, 1400, 10080]);
  assert.equal(saved.items[0].requestedArea, 10, "the original request stays on record; the edit history holds the change");
  assert.equal(api.getState().products.find((p) => p.id === product.id).stock, 15, "exactly the two returned boxes");
  const printed = cells(printedRows(api, saved)[0]);
  assert.deepEqual(plain(printed), { qty: '5 Boxes<div class="inv-sub">7.2 m²</div>', price: '1,400 <span class="inv-unit">/ m²</span>', total: "10,080" });
});

test("G. correcting the price of a saved invoice line moves the price per m² with it", async () => {
  const { api } = await boot();
  const { invoice } = await sellGpt(api, "10");
  assert.equal(api.startEditInvoice(invoice.id).error, undefined);
  assert.equal(api.updateSalePrice(line(api).lineId, "1250").error, undefined);   // the Sell page works per price unit: 1,250 per m² = 1,800 per box
  await api.saveInvoiceEdit();
  const saved = api.getState().invoices.find((i) => i.id === invoice.id);
  assert.deepEqual(plain([saved.items[0].unitPrice, saved.items[0].chargedPrice, saved.items[0].total, saved.items[0].priceOverridden]), [1800, 1250, 12600, true]);
  assert.match(cells(printedRows(api, saved)[0]).price, /^1,250 <span class="inv-unit">\/ m²<\/span>$/);
});

test("G. a box line added while correcting an invoice is billed per m² like a sale line, an area typed there becomes whole boxes", async () => {
  const { api } = await boot();
  const { invoice } = await sellGpt(api, "10");
  const { id, ...values } = { ...GPT, name: "GPT Two", sku: "GPT-2", stock: 20 };
  await api.addProduct(values);
  const second = api.getState().products.find((p) => p.sku === "GPT-2");

  assert.equal(api.startEditInvoice(invoice.id).error, undefined);
  const added = api.addToSale(second.id, "10", "m2");            // an area typed in the edit is converted like on the Sell page
  assert.equal(added.error, undefined, added.error);
  assert.deepEqual(plain({ boxes: added.converted.boxes, area: added.converted.area }), { boxes: 7, area: 10.08 });
  await api.saveInvoiceEdit();

  const saved = api.getState().invoices.find((i) => i.id === invoice.id);
  const item = saved.items[1];
  assert.deepEqual(plain([item.qty, item.sellingUnit, item.total, item.chargedPrice, item.suppliedArea, item.priceUnit, item.stockDeducted]), [7, "box", 14112, 1400, 10.08, "m2", 7]);
  assert.equal(saved.total, 28224);
  assert.equal(api.getState().products.find((p) => p.id === second.id).stock, 13);
  assert.deepEqual(plain(cells(printedRows(api, saved)[1])), { qty: '7 Boxes<div class="inv-sub">10.08 m²</div>', price: '1,400 <span class="inv-unit">/ m²</span>', total: "14,112" });
});

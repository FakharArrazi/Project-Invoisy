"use strict";

// A product made while recording a purchase uses the SAME product form and the SAME rules as the Stock page's Add product:
//   - one set of fields (Manufacturer included), saved to the shared catalogue,
//   - the supplier of the purchase stays the supplier, the manufacturer stays the product's own,
//   - no duplicate products, and stock is counted once (the goods received are the only thing that adds to it).

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { V, sampleProduct } = require("./helpers/modules");
const { loadApp } = require("./helpers/app");

const P = globalThis.Purchases;
const day = (offset) => P.addDays(P.toDay(new Date()), offset || 0);
const plain = (x) => JSON.parse(JSON.stringify(x));

/* ---------- helpers ---------- */

const draft = (overrides) => ({
  products: [], invoices: [], settings: { ...V.DEFAULT_SETTINGS, currency: "DZD" }, counter: 0,
  suppliers: [], purchases: [], supplierPayments: [], purchaseCounter: 0, attachments: { put: [], remove: [] },
  ...overrides,
});

function withSupplier(overrides) {
  const d = draft(overrides);
  const r = P.saveSupplier(d, { name: "Middleman Trading", phone: "0555 12 34 56", paymentTermsDays: "30" });
  assert.ok(r.supplier, r.error);
  return d;
}

// What the form gives for a new product (typed text), with every field filled in.
const typed = (overrides) => ({
  name: "Everton Grey", manufacturer: "Timgad Ceramic", tileSize: "60 x 120", sku: "EV-GR", category: "Porcelain", description: "Matt finish",
  coveragePerBox: "2.88", prices: [{ unit: "m2", price: "1900" }, { unit: "box", price: "5472" }], stockUnit: "box", purchasePrice: "1500",
  stock: "0", ...overrides,
});

const line = (product, overrides) => ({ newProduct: product, unit: "box", qty: "10", unitPrice: "4000", ...overrides });
const input = (d, lines, overrides) => ({ supplierId: d.suppliers[0].id, supplierInvoiceNumber: "FA-1", invoiceDate: day(0), lines, ...overrides });

function draftOf(d, lines, overrides) {
  const r = P.saveDraft(d, input(d, lines, overrides));
  assert.ok(r.purchase, r.error);
  return r.purchase;
}

/* ---------- One set of rules (Validation.readProductInput) ---------- */

test("the Stock form and a purchase read a product the same way: same fields, same values", () => {
  const stock = V.readProductInput(typed({ stock: "7" }), { products: [] });
  const purchase = V.readProductInput(typed({ stock: "7" }), { products: [], stockFromPurchase: true });
  assert.equal(stock.error, undefined);
  assert.equal(stock.values.stock, 7, "a product added in Stock starts with the stock typed");
  assert.equal(purchase.values.stock, 0, "a product made by a purchase starts at 0: the goods received add to it");
  assert.deepEqual({ ...plain(purchase.values), stock: 7 }, plain(stock.values), "every other field is identical");
  assert.deepEqual(Object.keys(stock.values).sort(), [
    "category", "coveragePerBox", "description", "manufacturer", "name", "priceUnit", "productType", "purchasePrice", "sellingPrice", "sellingPrices", "sku", "stock", "stockUnit", "tileSize",
  ]);
  assert.equal(stock.values.manufacturer, "Timgad Ceramic");
  assert.equal(stock.values.tileSize, "60*120");
  assert.deepEqual(plain(stock.values.sellingPrices), [{ unit: "m2", price: 1900 }, { unit: "box", price: 5472 }]);
  assert.equal(stock.values.sellingPrice, 1900, "the first price is the main one, like in the Stock form");
});

test("the product rules are the Stock form's rules, for a purchase as well", () => {
  const bad = (overrides, ctx) => V.readProductInput(typed(overrides), { products: [], stockFromPurchase: true, ...ctx });
  assert.equal(bad({ name: "  " }).field, "name");
  assert.equal(bad({ tileSize: "banana" }).field, "tileSize");
  assert.equal(bad({ coveragePerBox: "" }).field, "coveragePerBox", "an m² price needs the coverage per box");
  assert.equal(bad({ prices: [{ unit: "m2", price: "" }] }).field, "priceValue");
  assert.equal(bad({ prices: [{ unit: "", price: "10" }] }).field, "priceUnit");
  assert.equal(bad({ prices: [{ unit: "m2", price: "1" }, { unit: "m2", price: "2" }] }).field, "priceUnit", "one price per unit");
  assert.equal(bad({ prices: [{ unit: "kg", price: "1" }, { unit: "m2", price: "2" }] }).field, "priceUnit", "units of one kind");
  assert.equal(bad({ purchasePrice: "-1" }).field, "purchasePrice");
  assert.equal(bad({ stockUnit: "" }).field, "stockUnit");
  assert.equal(bad({ stockUnit: "kg" }).field, "stockUnit", "stock unit must fit the price unit");
  assert.equal(bad({ stock: "-3" }, { stockFromPurchase: false }).field, "stock");
  assert.equal(bad({ stock: "1.5" }, { stockFromPurchase: false }).field, "stock", "boxes are whole");
  assert.equal(bad({ stock: "-3" }).error, undefined, "a purchase does not read the stock box");
  assert.equal(bad({ manufacturer: "" }).error, undefined, "Manufacturer is optional, as in the Stock form");
});

test("a product kept the older way (one price and its unit) is still read", () => {
  const old = V.readProductInput({ name: "Tile B", tileSize: "30*30", coveragePerBox: "1.08", sellingPrice: "700", priceUnit: "m2", stockUnit: "m2", sku: "TB-1" }, { products: [], stockFromPurchase: true });
  assert.equal(old.error, undefined);
  assert.equal(old.values.manufacturer, "");
  assert.deepEqual(plain(old.values.sellingPrices), [{ unit: "m2", price: 700 }]);
});

/* ---------- No duplicates ---------- */

test("the same product is not created twice; a different manufacturer, size or SKU is a different product", () => {
  const catalogue = [sampleProduct({ id: "p-1", name: "Everton Grey", manufacturer: "Timgad Ceramic", tileSize: "60*120", sku: "EV-GR", priceUnit: "m2", stockUnit: "box" })];
  const read = (overrides, ctx) => V.readProductInput(typed(overrides), { products: catalogue, ...ctx });

  assert.equal(read({ sku: "ev-gr", name: "Another" }).field, "sku", "the same SKU, whatever the case");
  const same = read({ sku: "", name: "  everton   grey ", manufacturer: "TIMGAD CERAMIC", tileSize: "60x120" });
  assert.equal(same.field, "duplicate", "same name, manufacturer and size (typed differently)");
  assert.match(same.error, /Everton Grey — 60\*120 — Timgad Ceramic already exists/);
  assert.equal(read({ sku: "" }).field, "duplicate", "without a SKU it is the same product too");

  assert.equal(read({ sku: "", manufacturer: "Vega" }).error, undefined, "another manufacturer");
  assert.equal(read({ sku: "", tileSize: "30*60" }).error, undefined, "another size");
  assert.equal(read({ sku: "EV-GR-2" }).error, undefined, "a different SKU tells two variants apart");
  assert.equal(read({ sku: "", name: "Everton Grey" }, { editing: catalogue[0] }).error, undefined, "editing a product is not repeating it");
});

test("a product that already has an identical twin from before can still be edited, but not renamed into one", () => {
  const twinA = sampleProduct({ id: "p-a", name: "Everton Grey", manufacturer: "Timgad Ceramic", tileSize: "60*120", sku: "", priceUnit: "m2", stockUnit: "box" });
  const twinB = sampleProduct({ id: "p-b", name: "Everton Grey", manufacturer: "Timgad Ceramic", tileSize: "60*120", sku: "", priceUnit: "m2", stockUnit: "box" });
  const other = sampleProduct({ id: "p-c", name: "Nova White", manufacturer: "Vega", tileSize: "60*60", sku: "", priceUnit: "m2", stockUnit: "box" });
  const products = [twinA, twinB, other];
  const edit = (target, overrides) => V.readProductInput(typed({ sku: "", stock: String(target.stock), ...overrides }), { products, editing: target });
  assert.equal(edit(twinA, { prices: [{ unit: "m2", price: "2100" }] }).error, undefined, "changing a price of a twin is allowed");
  assert.equal(edit(twinB, { description: "new" }).error, undefined);
  assert.equal(edit(other, { name: "Everton Grey", manufacturer: "Timgad Ceramic", tileSize: "60x120" }).field, "duplicate", "renaming another product into an existing one is refused");
});

test("a purchase can not repeat a product that is already in Stock, nor create one twice", () => {
  const d = withSupplier({ products: [sampleProduct({ id: "p-1", name: "Everton Grey", manufacturer: "Timgad Ceramic", tileSize: "60*120", sku: "EV-GR", priceUnit: "m2", stockUnit: "box" })] });
  const before = plain(d);
  const again = P.saveDraft(d, input(d, [line(typed({ sku: "" }))]));
  assert.match(again.error, /already exists in Stock/);
  assert.equal(again.field, "line.0.newProduct.duplicate");

  const twice = P.saveDraft(d, input(d, [line(typed({ sku: "", name: "Nova White", manufacturer: "Vega" })), line(typed({ sku: "", name: "Nova White", manufacturer: "Vega" }))]));
  assert.match(twice.error, /Nova White/);
  assert.equal(twice.errors[0].line, 1, "the second line is the one refused");
  assert.deepEqual(plain(d), before, "nothing was created or saved by the refused attempts");
});

test("a product that appears in Stock after the draft was saved stops the confirm, and nothing changes", () => {
  const d = withSupplier();
  const p = draftOf(d, [line(typed({ sku: "" }))]);
  d.products.push(sampleProduct({ id: "p-added-meanwhile", name: "Everton Grey", manufacturer: "Timgad Ceramic", tileSize: "60*120", sku: "", priceUnit: "m2", stockUnit: "box", stock: 3 }));
  const snapshot = plain({ products: d.products, purchases: d.purchases, counter: d.purchaseCounter });
  const r = P.confirmPurchase(d, p.id);
  assert.match(r.error, /already exists in Stock/);
  assert.deepEqual(plain({ products: d.products, purchases: d.purchases, counter: d.purchaseCounter }), snapshot);
});

/* ---------- The product saved to the catalogue ---------- */

test("a product made in a purchase is saved with every field of the Stock form, and the supplier is not mixed up with the manufacturer", () => {
  const d = withSupplier();
  const p = draftOf(d, [line(typed())]);
  assert.equal(d.products.length, 0, "nothing is in the catalogue before the purchase is confirmed");
  const r = P.confirmPurchase(d, p.id);
  assert.equal(r.error, undefined);

  const created = d.products.find((x) => x.name === "Everton Grey");
  assert.equal(created.manufacturer, "Timgad Ceramic", "Manufacturer is saved");
  assert.equal(created.tileSize, "60*120");
  assert.equal(created.sku, "EV-GR");
  assert.equal(created.category, "Porcelain");
  assert.equal(created.description, "Matt finish");
  assert.equal(created.coveragePerBox, 2.88);
  assert.equal(created.sellingPrice, 1900);
  assert.equal(created.priceUnit, "m2");
  assert.deepEqual(plain(created.sellingPrices), [{ unit: "m2", price: 1900 }, { unit: "box", price: 5472 }], "the other selling prices are kept");
  assert.equal(created.purchasePrice, 1500);
  assert.equal(created.stockUnit, "box");
  assert.equal(V.productProblem(created), "", "it is a valid catalogue product");
  assert.deepEqual(plain(created), plain(V.normalizeProduct(created)), "and already in the shape the database keeps");

  assert.equal(d.suppliers[0].name, "Middleman Trading");
  assert.equal(p.supplierId, d.suppliers[0].id, "the purchase still belongs to the supplier it was bought from");
  assert.notEqual(created.manufacturer, d.suppliers[0].name);
  assert.equal(created.supplierId, undefined, "the product does not carry the supplier");
  assert.equal(JSON.stringify(created).includes("Middleman"), false, "nor its name");
});

test("a product made in a purchase is reused later: choosing it in another purchase and in a sale needs no second product", () => {
  const d = withSupplier();
  const first = draftOf(d, [line(typed())]);
  P.confirmPurchase(d, first.id);
  const id = d.products[0].id;

  const second = draftOf(d, [{ productId: id, unit: "box", qty: "5", unitPrice: "4100" }], { supplierInvoiceNumber: "FA-2" });
  const r = P.confirmPurchase(d, second.id);
  assert.equal(r.error, undefined);
  assert.equal(d.products.length, 1, "still one product");
  assert.equal(d.products[0].stock, 15, "10 + 5 boxes");
  assert.equal(d.products[0].manufacturer, "Timgad Ceramic");
  assert.equal(P.productHistory(d, id).length, 2, "both purchases are in the product's history");
});

/* ---------- Stock is counted once ---------- */

test("the stock typed in the form is ignored for a product made by a purchase: the goods received count once", () => {
  const d = withSupplier();
  // someone types 50 in the stock box of the product form (the form shows it locked, but the data layer does not rely on that)
  const p = draftOf(d, [line(typed({ stock: "50" }), { qty: "10" })]);
  assert.equal(p.lines[0].newProduct.stock, 0, "the draft keeps the product at 0");
  const r = P.confirmPurchase(d, p.id);
  assert.equal(r.error, undefined);
  assert.equal(d.products[0].stock, 10, "10 boxes received, not 60");
  assert.equal(P.confirmPurchase(d, p.id).skip, true);
  assert.equal(d.products[0].stock, 10, "confirming again adds nothing");
});

test("goods received later add to the new product once, in parts", () => {
  const d = withSupplier();
  const p = draftOf(d, [line(typed(), { qty: "10" })]);
  const r = P.confirmPurchase(d, p.id, { receive: {} });
  assert.equal(r.error, undefined);
  assert.equal(d.products[0].stock, 0, "created, nothing received yet");
  P.receiveDelivery(d, p.id, { [p.lines[0].id]: "4" });
  assert.equal(d.products[0].stock, 4);
  P.receiveDelivery(d, p.id, { [p.lines[0].id]: "6" });
  assert.equal(d.products[0].stock, 10);
});

/* ---------- Older drafts ---------- */

test("a draft saved before the product form was shared (no manufacturer, one price) still confirms", () => {
  const d = withSupplier();
  const old = { name: "Old Tile", tileSize: "30*30", coveragePerBox: "1.08", sellingPrice: "700", priceUnit: "m2", stockUnit: "m2", sku: "OT-1" };
  const p = draftOf(d, [line(old, { qty: "10", unit: "box" })]);
  // the draft as an older version saved it: the product exactly as it was read then
  p.lines[0].newProduct = { name: "Old Tile", tileSize: "30*30", coveragePerBox: 1.08, description: "", sku: "OT-1", category: "", sellingPrice: 700, priceUnit: "m2", stockUnit: "m2", purchasePrice: null };
  const r = P.confirmPurchase(d, p.id);
  assert.equal(r.error, undefined);
  const created = d.products[0];
  assert.equal(created.manufacturer, "");
  assert.equal(created.sellingPrice, 700);
  assert.equal(created.stock, 10.8);
});

/* ---------- The same form on both pages ---------- */

test("the Stock page and a purchase draw the same product form", () => {
  const app = loadApp();
  const { ProductForm } = app.api;
  const stockHtml = ProductForm.create({ prefix: "p" }).html();
  const purchaseHtml = ProductForm.create({ prefix: "pl-1-np-", stockFromPurchase: true }).html();
  const keys = (markup) => [...markup.matchAll(/data-i18n(?:-placeholder)?="([^"]+)"/g)].map((m) => m[1]);
  const extra = keys(purchaseHtml).filter((k) => !keys(stockHtml).includes(k));
  // The Stock page's own form has no instruction paragraph (the prices hint); the purchase dialog keeps it, and adds its stock note.
  assert.deepEqual(extra, ["stock.pricesHint", "pur.newProductStockNote"], "the purchase form has every label of the Stock form, plus its two notes");
  assert.deepEqual(keys(stockHtml), keys(purchaseHtml).filter((k) => k !== "pur.newProductStockNote" && k !== "stock.pricesHint"), "in the same order");
  assert.doesNotMatch(stockHtml, /price-hint/, "no explanatory paragraph in the Stock form");
  assert.match(purchaseHtml, /price-hint/);
  for (const field of ["Name", "Manufacturer", "TileSize", "Sku", "Category", "Desc", "Stock", "StockUnit", "CoveragePerBox", "Cost"]) {
    assert.match(stockHtml, new RegExp(`id="p${field}"`));
    assert.match(purchaseHtml, new RegExp(`id="pl-1-np-${field}"`));
  }
  assert.match(purchaseHtml, /id="pl-1-np-Stock"[^>]*disabled/, "the stock quantity is shown, locked at 0");
  assert.match(purchaseHtml, /id="pl-1-np-Stock"[^>]*value="0"/);
  assert.doesNotMatch(stockHtml, /id="pStock"[^>]*disabled/);
});

test("index.html holds no second copy of the product fields: the Stock page mounts the shared form", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  assert.match(html, /<div id="productFields"><\/div>/);
  assert.doesNotMatch(html, /id="pManufacturer"|id="pName"/);
  const at = (file) => html.indexOf(`<script src="java script/${file}"></script>`);
  assert.ok(at("product-form.js") > at("validation.js") && at("product-form.js") < at("purchases-ui.js"), "loaded after the rules, before the pages that use it");
  const ui = fs.readFileSync(path.join(__dirname, "..", "java script", "purchases-ui.js"), "utf8");
  assert.doesNotMatch(ui, /np-name|np-sell|np-priceUnit/, "Purchases has no product fields of its own");
});

test("a new product typed in a purchase is read with the Stock form's code, from its own boxes", () => {
  const app = loadApp();
  const form = app.api.ProductForm.create({ prefix: "pl-9-np-", stockFromPurchase: true, products: () => [] });
  const set = (suffix, value) => { app.field("pl-9-np-" + suffix).value = value; };
  set("Name", "Nova White"); set("Manufacturer", " Vega "); set("TileSize", "60 x 60"); set("Sku", "NW-1"); set("Category", "Ceramic");
  set("Desc", "Glossy"); set("CoveragePerBox", "1.44"); set("StockUnit", "box"); set("Cost", "900"); set("Stock", "40");
  form.setRows([{ unit: "m2", price: "1200" }, { unit: "piece", price: "430" }]);
  const read = form.read();
  assert.equal(read.error, undefined);
  assert.equal(read.values.manufacturer, "Vega");
  assert.equal(read.values.stock, 0);
  assert.deepEqual(plain(read.values.sellingPrices), [{ unit: "m2", price: 1200 }, { unit: "piece", price: 430 }]);
  assert.deepEqual(plain(form.readRaw().prices).map((p) => p.unit), ["m2", "piece"]);

  set("Name", "");
  assert.deepEqual(plain(form.read()), { field: "pl-9-np-Name", error: "Product name is required." });
  set("Name", "Nova White");
  form.setRows([{ unit: "m2", price: "" }]);
  const rowId = form.rows[0].rowId;
  assert.equal(form.read().field, "priceValue-" + rowId, "a price problem is attributed to its row's own box");
});

test("two product forms on one page do not share their selling price rows", () => {
  const app = loadApp();
  const a = app.api.ProductForm.create({ prefix: "pl-a-np-", stockFromPurchase: true });
  const b = app.api.ProductForm.create({ prefix: "pl-b-np-", stockFromPurchase: true });
  a.html(); b.html();
  a.addRow();
  assert.equal(a.rows.length, 2);
  assert.equal(b.rows.length, 1);
  assert.notEqual(a.rows[0].rowId, b.rows[0].rowId, "row ids are unique across forms");
  assert.notEqual(app.api.getState().priceRows, a.rows, "and apart from the Stock form's rows");
});

test("a new product saved through the real page scripts reaches the catalogue with its manufacturer", async () => {
  const app = loadApp();
  const storage = await app.start();
  assert.equal(storage.mode, "ready", storage.reason);
  const sup = await app.api.commit((d) => P.saveSupplier(d, { name: "Middleman Trading", paymentTermsDays: "0" }));
  assert.equal(sup.error, undefined);
  const supplierId = app.api.getState().suppliers[0].id;
  const saved = await app.api.commit((d) => P.saveDraft(d, { supplierId, supplierInvoiceNumber: "FA-9", invoiceDate: day(0), lines: [line(typed())] }));
  assert.equal(saved.error, undefined);
  const id = saved.purchase.id;
  const done = await app.api.commit((d) => P.confirmPurchase(d, id));
  assert.equal(done.error, undefined);
  const products = app.api.getProducts();
  assert.equal(products.length, 1);
  assert.equal(products[0].manufacturer, "Timgad Ceramic");
  assert.equal(products[0].stock, 10);

  // a second attempt to create the same product from another purchase is refused, with nothing saved
  const refused = await app.api.commit((d) => P.saveDraft(d, { supplierId, supplierInvoiceNumber: "FA-10", invoiceDate: day(0), lines: [line(typed())] }));
  assert.match(refused.error, /already exists in Stock|SKU/);
  assert.equal(app.api.getState().purchases.length, 1);
  assert.equal(app.api.getProducts().length, 1);
});

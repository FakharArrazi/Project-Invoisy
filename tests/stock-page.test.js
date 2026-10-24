"use strict";

// The redesigned Stock page: the inline product form, the seven-column table with row numbers, search and sorting
// (names, manufacturers, real tile surface area, quantity), and the removal of the Add Stock panel and the +/- buttons.
// Everything runs through the application's own functions against a disposable in-memory IndexedDB.

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { sampleProduct } = require("./helpers/modules");
const { loadApp } = require("./helpers/app");

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const stockCss = fs.readFileSync(path.join(ROOT, "css", "stock.css"), "utf8");
const plain = (x) => JSON.parse(JSON.stringify(x));

async function boot() {
  const app = loadApp();
  const storage = await app.start();
  assert.equal(storage.mode, "ready", storage.reason);
  return app;
}

const values = (overrides) => {
  const { id, ...rest } = sampleProduct({ name: "Everton Grey", tileSize: "60*60", coveragePerBox: 1.44, sku: "", sellingPrice: 800, priceUnit: "m2", purchasePrice: 600, stock: 10, manufacturer: "", ...overrides });
  return rest;
};

async function add(app, overrides) {
  const before = app.api.getState().products.map((p) => p.id);
  await app.api.addProduct(values(overrides));
  return app.api.getState().products.find((p) => !before.includes(p.id));
}

// The names of the products in the table, top to bottom, and the cells of every row as plain text.
const rows = (app) => app.field("stockBody").innerHTML.split("<tr data-id=").slice(1);
const cells = (row) => [...row.matchAll(/<td[^>]*>([^]*?)<\/td>/g)].map((m) => m[1].replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim());
const names = (app) => rows(app).map((row) => cells(row)[1]);
const numbers = (app) => rows(app).map((row) => cells(row)[0]);

/* ---------- Sorting ---------- */

test("tile size sorts by the real surface area, never as text and never by the first dimension", async () => {
  const app = await boot();
  const sizes = { A: "60*120", B: "30*30", C: "45*90", D: "30*60", E: "90*45", F: "10*200", G: "" };
  for (const [name, tileSize] of Object.entries(sizes)) await add(app, { name, tileSize, sku: name, coveragePerBox: undefined, sellingPrice: 100, priceUnit: "piece", stockUnit: "piece" });
  const { api } = app;
  // H stands for an old product whose size is text that is not a size (the form would not accept it today)
  const list = [...api.getState().products, { ...plain(api.getState().products[0]), id: "legacy", name: "H", tileSize: "abc" }];
  // 900, 1800 (30*60), 2000 (10*200), 4050 (45*90 and 90*45 tie: name order), 7200, then the two without a readable size
  assert.deepEqual(plain(api.sortProducts(list, "size-asc").map((p) => p.name)), ["B", "D", "F", "C", "E", "A", "G", "H"]);
  assert.deepEqual(plain(api.sortProducts(list, "size-desc").map((p) => p.name)), ["A", "C", "E", "F", "D", "B", "G", "H"], "largest first; a product with no size still goes last");
  assert.equal(api.tileArea({ tileSize: "30*60" }), 1800);
  assert.equal(api.tileArea({ tileSize: "600*1200 mm" }), 7200);
  assert.equal(api.tileArea({ tileSize: "" }), null);
  assert.equal(api.tileArea({ tileSize: "abc" }), null);
});

test("sorting by name, manufacturer and quantity, both ways; a missing manufacturer is always last", async () => {
  const app = await boot();
  await add(app, { name: "Bari", manufacturer: "Zeta Ceram", stock: 5, sku: "1" });
  await add(app, { name: "alba", manufacturer: "", stock: 40, sku: "2" });
  await add(app, { name: "Cairo", manufacturer: "Alpha Tiles", stock: 0, sku: "3" });
  await add(app, { name: "Dubai", manufacturer: "Mega", stock: 12, sku: "4" });
  const { api } = app;
  const list = api.getState().products;
  const order = (key) => plain(api.sortProducts(list, key).map((p) => p.name));
  assert.deepEqual(order("name-asc"), ["alba", "Bari", "Cairo", "Dubai"], "A-Z ignores upper/lower case");
  assert.deepEqual(order("name-desc"), ["Dubai", "Cairo", "Bari", "alba"]);
  assert.deepEqual(order("manufacturer-asc"), ["Cairo", "Dubai", "Bari", "alba"]);
  assert.deepEqual(order("manufacturer-desc"), ["Bari", "Dubai", "Cairo", "alba"]);
  assert.deepEqual(order("qty-asc"), ["Cairo", "Bari", "Dubai", "alba"]);
  assert.deepEqual(order("qty-desc"), ["alba", "Dubai", "Bari", "Cairo"]);
  assert.deepEqual(order("something-else"), order("name-asc"), "an unknown choice falls back to name A-Z");
});

test("sorting never changes the stored products: neither their order nor their data", async () => {
  const app = await boot();
  await add(app, { name: "Zed", sku: "1", stock: 3 });
  await add(app, { name: "Abc", sku: "2", stock: 9 });
  const { api } = app;
  const stored = plain(api.getState().products);
  const revision = (await api.db.loadAll()).revision;
  api.setStockSort("qty-desc");
  api.renderStock();
  api.sortProducts(api.getState().products, "name-desc");
  assert.deepEqual(plain(api.getState().products), stored);
  assert.equal((await api.db.loadAll()).revision, revision, "nothing was saved");
  assert.deepEqual(names(app), ["Abc", "Zed"], "the table follows the chosen sort (quantity high to low)");
});

/* ---------- The table ---------- */

test("each row has seven cells in the agreed order, with only Edit and Delete as actions", async () => {
  const app = await boot();
  await add(app, { name: "Crystal Noble Gray", manufacturer: "Ceram Decor", tileSize: "45*90", coveragePerBox: 1.215, sellingPrice: 1400, priceUnit: "m2", stock: 100 });
  app.api.renderStock();
  const [row] = rows(app);
  const c = cells(row);
  assert.equal(c.length, 7);
  assert.equal(c[0], "1", "row number");
  assert.equal(c[1], "Crystal Noble Gray", "the product cell holds the name and nothing else");
  assert.equal(c[2], "45 × 90 cm", "tile size has its own cell");
  assert.equal(c[3], "Ceram Decor", "manufacturer has its own cell");
  assert.match(c[4], /^1,400 DA \/ m²$/, "price keeps the app's price format and the selling unit");
  assert.match(c[5], /^100 Boxes/, "quantity with its stock unit");
  assert.equal(c[6], "Edit Delete");
  assert.equal((row.match(/data-action="/g) || []).length, 2);
  assert.match(row, /data-action="edit"[^>]*aria-label="Edit Crystal Noble Gray"/);
  assert.match(row, /data-action="delete"[^>]*aria-label="Delete Crystal Noble Gray"/);
  assert.doesNotMatch(row, /data-action="(inc|dec)"/, "no plus / minus stock buttons");
});

test("a product with no manufacturer or tile size still draws a row; every price has its own line and unit", async () => {
  const app = await boot();
  const p = await add(app, { name: "Plain", manufacturer: "", tileSize: "", coveragePerBox: undefined, sku: "P", sellingPrice: 300, priceUnit: "piece", stockUnit: "piece", stock: 7 });
  app.api.renderStock();
  const c = cells(rows(app)[0]);
  assert.equal(c[2], "-");
  assert.equal(c[3], "-");
  assert.match(c[4], /^300 DA \/ Piece$/);
  assert.match(c[5], /^7 Pieces$/);
  // several prices: one line each, nothing derived or converted
  const lines = app.api.priceLines({ ...plain(p), sellingPrices: [{ unit: "m2", price: 1000 }, { unit: "piece", price: 300 }, { unit: "box", price: 1440 }] });
  assert.deepEqual(plain([...lines].sort()), ["1,000 DA / m²", "1,440 DA / Box", "300 DA / Piece"]);
  assert.equal(lines.length, 3);
  const two = { ...plain(p), sellingPrices: [{ unit: "m2", price: 1000 }, { unit: "piece", price: 300 }] };
  assert.equal(app.api.priceLabel(two), app.api.priceLines(two).join(" · "), "the one-line label other screens use is the same lines, joined as before");
});

test("a long product name stays whole in its cell (wraps, never cut)", async () => {
  const app = await boot();
  const long = "Porcelain Calacatta Gold Extra Polished Rectified Large Format Wall And Floor Tile";
  await add(app, { name: long });
  app.api.renderStock();
  assert.equal(cells(rows(app)[0])[1], long);
  assert.doesNotMatch(stockCss, /text-overflow\s*:\s*ellipsis/);
});

test("row numbers are the position in the displayed list: they restart after a search and follow every sort", async () => {
  const app = await boot();
  for (const [name, tileSize, manufacturer] of [["Roma", "60*120", "Tim"], ["Berlin", "30*60", "Ceram"], ["Rio", "45*90", "Tim"], ["Sydney", "30*30", "Ceram"]]) {
    await add(app, { name, tileSize, manufacturer, sku: name });
  }
  const { api } = app;
  api.renderStock();
  assert.deepEqual(names(app), ["Berlin", "Rio", "Roma", "Sydney"]);
  assert.deepEqual(numbers(app), ["1", "2", "3", "4"]);

  api.setStockSort("size-desc");
  api.renderStock();
  assert.deepEqual(names(app), ["Roma", "Rio", "Berlin", "Sydney"]);
  assert.deepEqual(numbers(app), ["1", "2", "3", "4"]);

  // search and sort together: only Tim's products, biggest first, numbered from 1 again
  app.field("stockFilter").value = "tim";
  api.renderStock();
  assert.deepEqual(names(app), ["Roma", "Rio"]);
  assert.deepEqual(numbers(app), ["1", "2"]);
  api.setStockSort("name-asc");
  api.renderStock();
  assert.deepEqual(names(app), ["Rio", "Roma"]);
  assert.deepEqual(numbers(app), ["1", "2"]);

  // search finds by size, SKU and category as before; nothing found shows the message instead of the table
  app.field("stockFilter").value = "30*30";
  api.renderStock();
  assert.deepEqual(names(app), ["Sydney"]);
  app.field("stockFilter").value = "nothing like this";
  api.renderStock();
  assert.equal(app.field("stockTable").hidden, true);
  assert.equal(app.field("stockEmpty").hidden, false);
  assert.match(app.field("stockEmpty").innerHTML, /nothing like this/);
});

test("the toolbar and table are hidden for an empty stock, and the sort choice survives other screens being drawn", async () => {
  const app = await boot();
  app.api.renderStock();
  assert.equal(app.field("stockToolbar").hidden, true);
  assert.equal(app.field("stockTable").hidden, true);
  await add(app, { name: "One", sku: "1" });
  app.api.setStockSort("qty-desc");
  app.api.renderAll();
  app.api.showView("sell");
  app.api.showView("stock");
  assert.equal(app.api.getStockView().sort, "qty-desc");
  assert.equal(app.field("stockSort").value, "qty-desc");
  assert.equal(app.field("stockToolbar").hidden, false);
});

/* ---------- The inline product form ---------- */

test("Add New Product opens the form inside the page and Close Form shuts it again, without touching the data", async () => {
  const app = await boot();
  const { api } = app;
  const revision = (await api.db.loadAll()).revision;
  api.renderAll();
  assert.equal(app.field("stockFormPanel").hidden, true);
  assert.equal(app.field("stockAddLabel").textContent, "Add New Product");
  assert.equal(app.field("stockAddToggle").attributes === undefined, true);

  api.openProductForm();
  assert.equal(api.getStockView().open, true);
  assert.equal(app.field("stockFormPanel").hidden, false);
  assert.equal(app.field("stockAddLabel").textContent, "Close Form");
  assert.equal(app.field("stockAddPlus").hidden, true);
  assert.equal(app.field("stockAddClose").hidden, false);
  assert.equal(app.field("productSubmit").textContent, "Save Product");
  assert.equal(app.field("productFormTitle").textContent, "Add product");

  assert.equal(api.closeProductForm(), true, "nothing typed: closes without asking");
  assert.equal(app.confirms.length, 0);
  assert.equal(app.field("stockFormPanel").hidden, true);
  assert.equal(app.field("stockAddLabel").textContent, "Add New Product");
  assert.equal((await api.db.loadAll()).revision, revision);
});

test("closing the form with typed input asks first; keeping it leaves everything as it was", async () => {
  const app = await boot();
  const { api } = app;
  api.openProductForm();
  app.field("pName").value = "Half typed";
  api.touchProductForm();

  app.answer(false);
  assert.equal(api.closeProductForm(), false);
  assert.equal(app.confirms.length, 1);
  assert.equal(api.getStockView().open, true);
  assert.equal(app.field("pName").value, "Half typed", "what was typed is still there");

  app.answer(true);
  assert.equal(api.closeProductForm(), true);
  assert.equal(api.getStockView().open, false);
  assert.equal(app.field("pName").value, "", "discarded only after the person agreed");
  assert.equal(api.hasUnsavedWork(), false);
});

test("Edit opens the form with the product; opening another product over typed changes asks first", async () => {
  const app = await boot();
  const { api } = app;
  const a = await add(app, { name: "First", sku: "1" });
  const b = await add(app, { name: "Second", sku: "2" });
  api.startEditProduct(a.id);
  assert.deepEqual(plain(api.getStockView()), { open: true, editingId: a.id, sort: "name-asc" });
  assert.equal(app.field("pName").value, "First");
  assert.equal(app.field("productFormTitle").textContent, "Edit product");
  assert.equal(app.field("productSubmit").textContent, "Save Changes");
  assert.equal(app.confirms.length, 0);

  api.touchProductForm();
  app.answer(false);
  api.startEditProduct(b.id);
  assert.equal(api.getStockView().editingId, a.id, "the person kept their changes");
  app.answer(true);
  api.startEditProduct(b.id);
  assert.equal(api.getStockView().editingId, b.id);
  assert.equal(app.field("pName").value, "Second");
});

test("saving a valid product closes the form, shows it once in the table and keeps it saved", async () => {
  const app = await boot();
  const { api } = app;
  api.openProductForm();
  const set = (id, value) => { app.field(id).value = value; };
  set("pName", "Wonder"); set("pManufacturer", "Tiknus Ceram"); set("pTileSize", "45*90"); set("pCoveragePerBox", "1.215");
  set("pStock", "100"); set("pStockUnit", "box"); set("pSku", ""); set("pCategory", ""); set("pDesc", ""); set("pCost", ""); set("pType", "");
  api.setPriceRows([{ unit: "m2", price: "1400" }]);
  const read = api.readProductForm();
  assert.equal(read.error, undefined);
  await api.addProduct(read.values);

  assert.equal(api.getStockView().open, false);
  assert.equal(app.field("stockFormPanel").hidden, true);
  assert.deepEqual(names(app), ["Wonder"], "it is in the table, once, without a reload");
  const saved = (await api.db.loadAll()).products;
  assert.equal(saved.length, 1);
  assert.equal(saved[0].name, "Wonder");
  assert.equal(saved[0].manufacturer, "Tiknus Ceram");
  assert.equal(app.field("pName").value, "", "the form is empty for the next product");
});

test("editing and saving updates the table and closes the form; deleting the product being edited closes it too", async () => {
  const app = await boot();
  const { api } = app;
  const p = await add(app, { name: "Old name", sku: "1", stock: 4 });
  api.startEditProduct(p.id);
  app.field("pName").value = "New name";
  app.field("pStock").value = "25";
  const read = api.readProductForm();
  assert.equal(read.error, undefined);
  await api.updateProduct(p.id, read.values);
  assert.equal(api.getStockView().open, false);
  assert.deepEqual(names(app), ["New name"]);
  assert.match(cells(rows(app)[0])[5], /^25 Boxes/);
  assert.equal((await api.db.loadAll()).products[0].stock, 25, "the stock quantity is changed through Edit");

  api.startEditProduct(p.id);
  await api.deleteProduct(p.id);
  assert.equal(api.getStockView().open, false);
  assert.equal(rows(app).length, 0);
});

test("a save that fails keeps the form open with what was typed", async () => {
  const app = await boot();
  const { api } = app;
  api.openProductForm();
  app.field("pName").value = "Keep me";
  api.touchProductForm();
  const read = (() => { app.field("pTileSize").value = "60*60"; app.field("pCoveragePerBox").value = "1.44"; app.field("pStock").value = "3"; app.field("pStockUnit").value = "box"; api.setPriceRows([{ unit: "m2", price: "500" }]); return api.readProductForm(); })();
  assert.equal(read.error, undefined);
  const original = api.db.commitChanges;
  api.db.commitChanges = async () => { throw new Error("disk is full"); };
  try { await api.addProduct(read.values); } finally { api.db.commitChanges = original; }
  assert.equal(api.getStockView().open, true, "the person is not told it worked");
  assert.equal(app.field("pName").value, "Keep me");
  assert.equal((await api.db.loadAll()).products.length, 0);
});

/* ---------- The page itself ---------- */

test("the Stock page has the title, the add button, the form above the table, and no Add Stock panel", () => {
  const stock = html.slice(html.indexOf('<section class="view" id="view-stock"'), html.indexOf("<!-- INVOICES -->"));
  const at = (needle) => stock.indexOf(needle);
  assert.ok(at('class="stock-title"') > -1 && at('id="stockAddToggle"') > at('class="stock-title"'), "STOCK title, then the button");
  assert.ok(at('id="stockFormPanel"') > at('id="stockAddToggle"') && at('id="stockTable"') > at('id="stockFormPanel"'), "header, form, then the table");
  assert.ok(at('id="stockToolbar"') > at('id="stockFormPanel"') && at('id="stockToolbar"') < at('id="stockTable"'), "the search and sort bar sits above the table");
  assert.doesNotMatch(stock, /<dialog/, "the form is not a dialog or popup");
  assert.doesNotMatch(stock, /restockForm|rProduct|rQty|restockInfo|restockError/, "the Add Stock panel is gone");
  assert.doesNotMatch(stock, /stock\.addStock|quantityToAdd/);
  const headers = [...stock.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
  assert.deepEqual(headers, ["#", "Product", "Tile Size", "Manufacturer", "Price", "Quantity", "Actions"]);
  const sorts = [...stock.matchAll(/<option value="([a-z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(sorts, ["name-asc", "name-desc", "manufacturer-asc", "manufacturer-desc", "size-asc", "size-desc", "qty-asc", "qty-desc"]);
  assert.match(stock, /type="search" id="stockFilter" placeholder="Search products\.\.\."/);
  assert.match(stock, /class="stock-search">\s*<svg/, "the search field starts with an icon");
});

test("the Stock form carries no instruction paragraph, but keeps its labels and * marks", () => {
  const form = loadApp().api.stockForm.html();
  assert.doesNotMatch(form, /Each price is its own price/);
  assert.doesNotMatch(form, /<p[^>]*class="[^"]*(price-hint|muted)/);
  assert.match(form, /for="pName"[^>]*>[^]*?<span class="req"/);
  assert.match(form, /Selling prices/);
});

test("the Stock styles use no animation or transition", () => {
  const rules = stockCss.replace(/\/\*[^]*?\*\//g, "");
  assert.doesNotMatch(rules, /transition|animation|@keyframes/);
});

test("the old Stock layout rules are gone from style.css and the page links stock.css before the RTL rules", () => {
  const css = fs.readFileSync(path.join(ROOT, "css", "style.css"), "utf8");
  assert.doesNotMatch(css, /stock-layout|\.restock|#restockInfo/);
  assert.ok(html.indexOf("css/stock.css") > html.indexOf("css/pricing.css") && html.indexOf("css/stock.css") < html.indexOf("css/rtl.css"));
});

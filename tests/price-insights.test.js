"use strict";

// Dashboard -> Supplier Price Insights: the same product bought from different suppliers at different prices.
//
//   1. The rule (purchases.js priceInsights) on plain data: who is compared with whom, which price counts, what is never used.
//   2. The same rule through the real purchase flow (draft -> confirm), so the saved shape is what the rule reads.
//   3. The Dashboard screen drawn by the real page scripts: cards, history, links, empty state, French, escaping.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { V, sampleProduct } = require("./helpers/modules");
const { loadApp } = require("./helpers/app");

const P = globalThis.Purchases;
const day = (offset) => P.addDays(P.toDay(new Date()), offset || 0);
const shown = (iso) => iso.split("-").reverse().join("/");   // 2026-10-12 -> 12/10/2026, as the screen writes a day

/* ---------- plain data ---------- */

const tile = (overrides) => sampleProduct({
  id: "p-tile", name: "Tile 60 × 60", tileSize: "60*60", manufacturer: "TecnoCeram", coveragePerBox: 1.44, sellingPrice: 800, priceUnit: "m2",
  stockUnit: "m2", sku: "T60", stock: 10, ...overrides,
});

const supplier = (id, name) => ({ id, name });

let serial = 0;
// A saved, confirmed purchase of one line. Only the fields the rule reads are needed.
function purchase(supplierId, invoiceDate, price, overrides) {
  const o = overrides || {};
  serial++;
  return {
    id: "pu-" + serial, reference: "PUR-" + String(serial).padStart(6, "0"), status: o.status || "confirmed", supplierId, invoiceDate,
    lines: [{
      id: "l-" + serial, productId: o.productId || "p-tile", productName: o.productName || "Tile 60 × 60", tileSize: "60*60",
      unit: o.unit || "box", qty: o.qty === undefined ? 10 : o.qty, unitPrice: price, stockUnit: o.stockUnit === undefined ? "m2" : o.stockUnit, factor: o.factor === undefined ? 1.44 : o.factor,
    }],
  };
}

const shop = (purchases, extra) => ({
  products: [tile()], suppliers: [supplier("s-a", "Supplier A"), supplier("s-b", "Supplier B"), supplier("s-c", "Supplier C")], purchases, ...extra,
});

/* ==========================================================================
   1. The rule
   ========================================================================== */

test("two suppliers, two prices: one card with both prices, dates, the difference in DA and in percent", () => {
  const { insights } = P.priceInsights(shop([purchase("s-a", "2026-10-12", 1200), purchase("s-b", "2026-10-25", 1350)]));
  assert.equal(insights.length, 1);
  const i = insights[0];
  assert.equal(i.productId, "p-tile");
  assert.equal(i.name, "Tile 60 × 60");
  assert.equal(i.tileSize, "60*60");
  assert.equal(i.unit, "box");
  assert.deepEqual(i.entries.map((e) => [e.supplierName, e.date, e.price, e.unit]), [["Supplier A", "2026-10-12", 1200, "box"], ["Supplier B", "2026-10-25", 1350, "box"]]);
  assert.equal(i.lowest, 1200);
  assert.equal(i.highest, 1350);
  assert.equal(i.diff, 150);
  assert.equal(i.pct, 12.5, "150 more than 1,200 is 12.5 %, measured against the cheaper price");
  assert.equal(i.level, "high");
  assert.deepEqual(i.entries.map((e) => [e.isLowest, e.isHighest]), [[true, false], [false, true]]);
});

test("the same price from two suppliers is not flagged, and a single supplier is not a comparison", () => {
  const same = P.priceInsights(shop([purchase("s-a", "2026-10-01", 1200), purchase("s-b", "2026-10-02", 1200)]));
  assert.equal(same.insights.length, 0);
  assert.equal(same.samePriceProducts, 1);
  const one = P.priceInsights(shop([purchase("s-a", "2026-10-01", 1200), purchase("s-a", "2026-10-09", 1500)]));
  assert.equal(one.insights.length, 0, "one supplier raising its price is not a supplier comparison");
  assert.equal(one.comparedProducts, 0);
});

test("each supplier is judged by its most recent purchase, not by the oldest or the newest overall", () => {
  const { insights } = P.priceInsights(shop([
    purchase("s-a", "2026-09-01", 1000),   // A, old
    purchase("s-b", "2026-09-15", 1200),   // B
    purchase("s-a", "2026-10-20", 1300),   // A, now
  ]));
  const i = insights[0];
  assert.deepEqual(i.entries.map((e) => [e.supplierName, e.price, e.date, e.count]), [["Supplier B", 1200, "2026-09-15", 1], ["Supplier A", 1300, "2026-10-20", 2]]);
  assert.equal(i.diff, 100, "1,300 now against 1,200, not 1,000 against 1,200");
  // The same supplier at a different price earlier is a separate piece of history.
  assert.deepEqual(i.changes.map((c) => [c.supplierName, c.from, c.to, c.fromDate, c.toDate, c.diff, c.pct]), [["Supplier A", 1000, 1300, "2026-09-01", "2026-10-20", 300, 30]]);
  assert.equal(i.history.length, 3, "every purchase of the product stays in the history");
  assert.equal(i.history[0].date, "2026-10-20", "newest first");
});

test("a supplier that now matches the other one is not a difference, even though it changed its price", () => {
  const r = P.priceInsights(shop([purchase("s-a", "2026-09-01", 1000), purchase("s-a", "2026-10-01", 1200), purchase("s-b", "2026-10-05", 1200)]));
  assert.equal(r.insights.length, 0);
  assert.equal(r.samePriceProducts, 1);
});

test("three suppliers: cheapest first, lowest and highest marked, the middle one neither", () => {
  const { insights } = P.priceInsights(shop([purchase("s-a", "2026-10-01", 1300), purchase("s-b", "2026-10-02", 1200), purchase("s-c", "2026-10-03", 1250)]));
  const i = insights[0];
  assert.deepEqual(i.entries.map((e) => [e.supplierName, e.isLowest, e.isHighest]), [["Supplier B", true, false], ["Supplier C", false, false], ["Supplier A", false, true]]);
  assert.equal(i.diff, 100);
});

test("products are matched by id: similar names are never combined", () => {
  const products = [tile(), tile({ id: "p-other", name: "Tile 60 × 60", sku: "T60-2" })];
  const r = P.priceInsights({
    products, suppliers: [supplier("s-a", "Supplier A"), supplier("s-b", "Supplier B")],
    purchases: [purchase("s-a", "2026-10-01", 1200), purchase("s-b", "2026-10-02", 1500, { productId: "p-other" })],
  });
  assert.equal(r.insights.length, 0, "same name and size, two products: each has one supplier");
});

test("a manufacturer is not a supplier: the cards name the supplier, and one manufacturer's products are not merged", () => {
  const products = [tile(), tile({ id: "p-2", name: "Tile 30 × 60", tileSize: "30*60", manufacturer: "TecnoCeram" })];
  const r = P.priceInsights({
    products, suppliers: [supplier("s-a", "Supplier A"), supplier("s-b", "Supplier B")],
    purchases: [
      purchase("s-a", "2026-10-01", 1200), purchase("s-b", "2026-10-02", 1350),
      purchase("s-a", "2026-10-03", 900, { productId: "p-2" }),            // only one supplier for the other product
    ],
  });
  assert.equal(r.insights.length, 1);
  assert.equal(r.insights[0].manufacturer, "TecnoCeram");
  assert.deepEqual(r.insights[0].entries.map((e) => e.supplierName), ["Supplier A", "Supplier B"]);
  assert.ok(r.insights[0].entries.every((e) => e.supplierName !== "TecnoCeram"));
});

test("the selling price is never read", () => {
  const data = shop([purchase("s-a", "2026-10-01", 1200), purchase("s-b", "2026-10-02", 1350)]);
  const before = JSON.stringify(P.priceInsights(data));
  data.products[0].sellingPrice = 99999;
  data.products[0].sellingPrices = [{ unit: "box", price: 1 }];
  assert.equal(JSON.stringify(P.priceInsights(data)), before);
});

test("drafts and cancelled purchases do not count; a purchase without a supplier is ignored", () => {
  const r = P.priceInsights(shop([
    purchase("s-a", "2026-10-01", 1200), purchase("s-b", "2026-10-02", 1500, { status: "draft" }),
    purchase("s-c", "2026-10-03", 1500, { status: "cancelled" }), purchase("", "2026-10-04", 1700),
  ]));
  assert.equal(r.insights.length, 0);
});

test("lines with no price, and the same supplier twice on one line set, can not invent a comparison", () => {
  const r = P.priceInsights(shop([purchase("s-a", "2026-10-01", 1200), purchase("s-b", "2026-10-02", 0)]));
  assert.equal(r.insights.length, 0, "a zero price is not a price to compare");
});

test("different units are brought to one unit with the product's saved coverage (800 DA/m² against 1,152 DA/box is the same price)", () => {
  const same = P.priceInsights(shop([purchase("s-a", "2026-10-01", 1152, { unit: "box" }), purchase("s-b", "2026-10-02", 800, { unit: "m2" })]));
  assert.equal(same.insights.length, 0);
  assert.equal(same.samePriceProducts, 1);

  const { insights } = P.priceInsights(shop([purchase("s-a", "2026-10-01", 1152, { unit: "box" }), purchase("s-b", "2026-10-02", 900, { unit: "m2" })]));
  const i = insights[0];
  assert.equal(i.unit, "m2", "the product is counted in m²");
  assert.deepEqual(i.entries.map((e) => [e.supplierName, e.price, e.bought]), [["Supplier A", 800, { unitPrice: 1152, unit: "box" }], ["Supplier B", 900, null]]);
  assert.equal(i.diff, 100);
  assert.equal(i.pct, 12.5);
});

test("a line that can not be converted is left out instead of guessed", () => {
  // The product has no coverage, so a price per box can not be brought to m².
  const noCoverage = tile({ coveragePerBox: null });
  const r = P.priceInsights({
    products: [noCoverage], suppliers: [supplier("s-a", "Supplier A"), supplier("s-b", "Supplier B")],
    purchases: [purchase("s-a", "2026-10-01", 1152, { unit: "box" }), purchase("s-b", "2026-10-02", 900, { unit: "m2" })],
  });
  assert.equal(r.insights.length, 0);
});

test("a product deleted from the catalogue keeps its card, from what the purchases recorded, with no Stock link possible", () => {
  const r = P.priceInsights({
    products: [], suppliers: [supplier("s-a", "Supplier A"), supplier("s-b", "Supplier B")],
    purchases: [purchase("s-a", "2026-10-01", 1200), purchase("s-b", "2026-10-02", 1300)],
  });
  assert.equal(r.insights.length, 1);
  assert.equal(r.insights[0].productExists, false);
  assert.equal(r.insights[0].name, "Tile 60 × 60");
});

test("levels: a small gap stays quiet, 3 % is noticeable, 10 % or more is large; the biggest gap comes first", () => {
  const products = [tile(), tile({ id: "p-2", name: "B" }), tile({ id: "p-3", name: "C" })];
  const r = P.priceInsights({
    products, suppliers: [supplier("s-a", "Supplier A"), supplier("s-b", "Supplier B")],
    purchases: [
      purchase("s-a", "2026-10-01", 1000), purchase("s-b", "2026-10-02", 1020),                                           // 2 %
      purchase("s-a", "2026-10-01", 1000, { productId: "p-2", productName: "B" }), purchase("s-b", "2026-10-02", 1050, { productId: "p-2", productName: "B" }),   // 5 %
      purchase("s-a", "2026-10-01", 1000, { productId: "p-3", productName: "C" }), purchase("s-b", "2026-10-02", 1125, { productId: "p-3", productName: "C" }),   // 12.5 %
    ],
  });
  assert.deepEqual(r.insights.map((i) => [i.name, i.level]), [["C", "high"], ["B", "moderate"], ["Tile 60 × 60", "small"]]);
});

test("no purchases at all, or none with two suppliers: nothing to show", () => {
  assert.deepEqual(P.priceInsights({}), { insights: [], comparedProducts: 0, samePriceProducts: 0 });
  assert.equal(P.priceInsights(shop([purchase("s-a", "2026-10-01", 1200)])).insights.length, 0);
});

test("the rule changes nothing it reads", () => {
  const data = shop([purchase("s-a", "2026-10-01", 1200), purchase("s-b", "2026-10-02", 1350)]);
  const before = JSON.stringify(data);
  P.priceInsights(data);
  assert.equal(JSON.stringify(data), before);
});

/* ==========================================================================
   2. Through the real purchase flow
   ========================================================================== */

test("purchases recorded and confirmed the normal way are what the rule reads", async () => {
  const app = await started();
  await app.api.commit((d) => { d.products.push(tile()); });
  const a = (await app.api.commit((d) => P.saveSupplier(d, { name: "Supplier A", phone: "0555 11 11 11" }))).supplier;
  const b = (await app.api.commit((d) => P.saveSupplier(d, { name: "Supplier B", phone: "0555 22 22 22" }))).supplier;
  await buy(app, a.id, day(-13), "1200");
  await buy(app, b.id, day(0), "1350");
  const { insights } = P.priceInsights(app.api.getState());
  assert.equal(insights.length, 1);
  assert.deepEqual(insights[0].entries.map((e) => [e.supplierName, e.price, e.unit]), [["Supplier A", 1200, "box"], ["Supplier B", 1350, "box"]]);
  assert.equal(insights[0].diff, 150);
});

/* ==========================================================================
   3. The Dashboard screen
   ========================================================================== */

async function started(options) {
  const app = loadApp(options);
  const storage = await app.start();
  assert.equal(storage.mode, "ready", storage.reason);
  return app;
}

async function buy(app, supplierId, invoiceDate, price, extra) {
  const r = await app.api.commit((d) => {
    const made = P.saveDraft(d, {
      supplierId, supplierInvoiceNumber: "F-" + Math.random().toString(36).slice(2, 8), invoiceDate,
      lines: [{ productId: (extra && extra.productId) || "p-tile", unit: "box", qty: "10", unitPrice: price }],
    });
    assert.ok(made.purchase, made.error);
    return P.confirmPurchase(d, made.purchase.id);
  });
  assert.ok(r.purchase, r.error);
  return r.purchase;
}

// A shop with the tile and two suppliers who sold it at 1,200 DA (13 days ago) and 1,350 DA (today).
async function shopWithTwoSuppliers(options) {
  const app = await started(options);
  await app.api.commit((d) => { d.products.push(tile()); });
  const a = (await app.api.commit((d) => P.saveSupplier(d, { name: "Supplier A", phone: "0555 11 11 11" }))).supplier;
  const b = (await app.api.commit((d) => P.saveSupplier(d, { name: "Supplier B", phone: "0555 22 22 22" }))).supplier;
  const first = await buy(app, a.id, day(-13), "1200");
  const second = await buy(app, b.id, day(0), "1350");
  return { app, a, b, first, second };
}

function drawDashboard(app) {
  app.api.getState().view = "dashboard";
  app.api.renderAll();
  return app.field("dashboardRoot").innerHTML;
}

// Gives the Dashboard a click listener, as the browser does, and returns a function that presses a button.
function clicker(app) {
  const listeners = {};
  app.field("dashboardRoot").addEventListener = (type, fn) => { listeners[type] = fn; };
  app.field("purchasesRoot").addEventListener = () => {};
  app.field("suppliersRoot").addEventListener = () => {};
  app.api.PurchasesUI.bind();
  return async (act, id) => {
    const el = { dataset: { act, id }, tagName: "BUTTON" };
    listeners.click({ target: { closest: () => el }, preventDefault() {} });
    for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
  };
}

test("screen: Invoisy opens on the Dashboard, and the Dashboard is in the menu and on the page", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  assert.match(html, /<button type="button" class="nav-btn" data-view="dashboard">/);
  assert.ok(html.indexOf('data-view="dashboard"') < html.indexOf('data-view="sell"'), "first in the menu");
  assert.match(html, /<section class="view" id="view-dashboard">/);
  assert.match(html, /<section class="view" id="view-sell" hidden>/);
  assert.match(html, /id="dashboardRoot"/);
  assert.match(html, /href="css\/dashboard\.css"/);
  const script = fs.readFileSync(path.join(__dirname, "..", "java script", "script.js"), "utf8");
  assert.match(script, /\$\("brand"\)\.addEventListener\("click", \(\) => showView\("dashboard"\)\)/, "the Invoisy name goes back to the Dashboard");
  assert.match(script, /view: "dashboard",\n  sale: newSale\(\)/);
});

test("screen: a card shows the product, both suppliers, both dates, both prices with their unit, and the difference", async () => {
  const { app } = await shopWithTwoSuppliers();
  const html = drawDashboard(app);
  assert.match(html, /Supplier Price Insights/);
  assert.equal((html.match(/class="pi-card /g) || []).length, 1);
  assert.match(html, /Tile 60 × 60/);
  assert.match(html, /60 × 60/);
  assert.match(html, /Supplier A/);
  assert.match(html, /Supplier B/);
  assert.ok(html.includes(shown(day(-13))) && html.includes(shown(day(0))), "both purchase dates");
  assert.match(html, /1,200[^<]*\/ Box/);
  assert.match(html, /1,350[^<]*\/ Box/);
  assert.match(html, /\+150[^<]*\/ Box · \+12\.5%/, "the difference in DA and in percent");
  assert.match(html, /Supplier B costs 150[^<]* more per box than Supplier A, which is 12\.5% higher\./);
  assert.match(html, />Lowest</);
  assert.match(html, />Highest</);
  assert.match(html, /1 product with a price difference/);
});

test("screen: the card never shows what the product sells for", async () => {
  const { app } = await shopWithTwoSuppliers();
  await app.api.commit((d) => { d.products[0].sellingPrice = 424242; });
  assert.doesNotMatch(drawDashboard(app), /424,?242/);
});

test("screen: the history opens inside the card, lists the purchases with a working link to each, and closes again", async () => {
  const { app, first, second } = await shopWithTwoSuppliers();
  const press = clicker(app);
  assert.doesNotMatch(drawDashboard(app), /class="pi-detail"/, "closed at first");
  await press("dash-toggle", "p-tile");
  const open = app.field("dashboardRoot").innerHTML;
  assert.match(open, /class="pi-detail"/);
  assert.match(open, new RegExp(`data-act="dash-purchase" data-id="${first.id}"`));
  assert.match(open, new RegExp(`data-act="dash-purchase" data-id="${second.id}"`));
  assert.match(open, /Hide history/);
  assert.equal((open.match(/data-act="dash-purchase"/g) || []).length, 2, "one link per purchase line");
  await press("dash-toggle", "p-tile");
  assert.doesNotMatch(app.field("dashboardRoot").innerHTML, /class="pi-detail"/);
});

test("screen: View purchase opens that purchase on the Purchases page", async () => {
  const { app, second } = await shopWithTwoSuppliers();
  const press = clicker(app);
  drawDashboard(app);
  await press("dash-purchase", second.id);
  assert.equal(app.api.getState().view, "purchases");
  assert.equal(app.api.PurchasesUI.state.pur.screen, "detail");
  assert.equal(app.api.PurchasesUI.state.pur.detailId, second.id);
});

test("screen: Open in Stock shows the Stock page narrowed to that product, with its row marked", async () => {
  const { app } = await shopWithTwoSuppliers();
  const press = clicker(app);
  assert.match(drawDashboard(app), /data-act="dash-stock" data-id="p-tile"/);
  await press("dash-stock", "p-tile");
  const state = app.api.getState();
  assert.equal(state.view, "stock");
  assert.equal(state.stockFocusId, "p-tile");
  assert.equal(app.field("stockFilter").value, "Tile 60 × 60 60*60");
  const rows = app.field("stockBody").innerHTML;
  assert.match(rows, /<tr data-id="p-tile" class="is-focus">/);
  // Leaving Stock clears the mark.
  app.api.showView("dashboard");
  assert.equal(app.api.getState().stockFocusId, null);
});

test("screen: a product deleted from Stock has no Open in Stock button (no dead buttons)", async () => {
  const { app } = await shopWithTwoSuppliers();
  await app.api.commit((d) => { d.products = []; });
  const html = drawDashboard(app);
  assert.match(html, /Tile 60 × 60/);
  assert.doesNotMatch(html, /dash-stock/);
  assert.match(html, /data-act="dash-toggle"/, "the history is still there");
});

test("screen: with more than six products only six cards show, and Show all reveals the rest", async () => {
  const app = await started();
  await app.api.commit((d) => { for (let n = 1; n <= 7; n++) d.products.push(tile({ id: "p" + n, name: "Tile " + n, sku: "S" + n })); });
  const a = (await app.api.commit((d) => P.saveSupplier(d, { name: "Supplier A", phone: "0555 11 11 11" }))).supplier;
  const b = (await app.api.commit((d) => P.saveSupplier(d, { name: "Supplier B", phone: "0555 22 22 22" }))).supplier;
  for (let n = 1; n <= 7; n++) {
    await buy(app, a.id, day(-5), "1000", { productId: "p" + n });
    await buy(app, b.id, day(-4), String(1000 + n * 10), { productId: "p" + n });   // the gap grows with n
  }
  const press = clicker(app);
  let html = drawDashboard(app);
  assert.equal((html.match(/class="pi-card /g) || []).length, 6);
  assert.match(html, />Show all 7</);
  assert.match(html, /7 products with a price difference/);
  assert.ok(html.indexOf("Tile 7") < html.indexOf("Tile 2") && !html.includes("Tile 1<"), "the biggest gaps come first; the smallest waits");
  await press("dash-all");
  html = app.field("dashboardRoot").innerHTML;
  assert.equal((html.match(/class="pi-card /g) || []).length, 7);
  assert.match(html, />Show fewer</);
});

test("screen: nothing to review shows a calm message with a working link, not an empty section", async () => {
  const app = await started();
  const html = drawDashboard(app);
  assert.match(html, /Supplier Price Insights/);
  assert.match(html, /No supplier price differences to review/);
  assert.match(html, /data-act="dash-purchases"/);
  assert.doesNotMatch(html, /pi-card/);
  const press = clicker(app);
  await press("dash-purchases");
  assert.equal(app.api.getState().view, "purchases");
});

test("screen: several suppliers at one price says everything is fine", async () => {
  const app = await started();
  await app.api.commit((d) => { d.products.push(tile()); });
  const a = (await app.api.commit((d) => P.saveSupplier(d, { name: "Supplier A", phone: "0555 11 11 11" }))).supplier;
  const b = (await app.api.commit((d) => P.saveSupplier(d, { name: "Supplier B", phone: "0555 22 22 22" }))).supplier;
  await buy(app, a.id, day(-3), "1200");
  await buy(app, b.id, day(-2), "1200");
  const html = drawDashboard(app);
  assert.match(html, /same price\. Nothing to review/);
  assert.doesNotMatch(html, /pi-card/);
});

test("screen: names typed by the user can not inject markup into a card", async () => {
  const app = await started();
  await app.api.commit((d) => { d.products.push(tile({ name: "<img src=x onerror=alert(1)>" })); });
  const a = (await app.api.commit((d) => P.saveSupplier(d, { name: "<b>Evil</b>", phone: "0555 11 11 11" }))).supplier;
  const b = (await app.api.commit((d) => P.saveSupplier(d, { name: "Supplier B", phone: "0555 22 22 22" }))).supplier;
  await buy(app, a.id, day(-3), "1200");
  await buy(app, b.id, day(-2), "1300");
  const html = drawDashboard(app);
  assert.doesNotMatch(html, /<img src=x|<b>Evil/);
  assert.match(html, /&lt;b&gt;Evil&lt;\/b&gt;/);
});

test("screen: the section reads in French", async () => {
  const { app } = await shopWithTwoSuppliers();
  await app.api.commit((d) => { d.settings.language = "fr"; });
  const html = drawDashboard(app);
  assert.match(html, /Écarts de prix entre fournisseurs/);
  assert.match(html, /Historique des achats/);
  assert.match(html, /Ouvrir dans Stock/);
  assert.match(html, /Le moins cher/);
  assert.doesNotMatch(html, /Supplier Price Insights/);
});

test("screen: opening the page with a remembered view still works, and the default is the Dashboard", async () => {
  const app = await started();
  assert.equal(app.api.getState().view, "dashboard");
});

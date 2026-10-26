"use strict";

// Settings -> Currency display: invoices can show amounts in dinars (1,500 DA) or centimes (150,000 centimes).
// It is a DISPLAY choice only (1 DA = 100 centimes): nothing that is stored or calculated may change with it.
// Run through the real page scripts against a disposable in-memory IndexedDB.

const test = require("node:test");
const assert = require("node:assert/strict");
const { sampleProduct } = require("./helpers/modules");
const { loadApp } = require("./helpers/app");

const plain = (x) => JSON.parse(JSON.stringify(x));

async function startedApp(options) {
  const app = loadApp(options);
  const storage = await app.start();
  assert.equal(storage.mode, "ready", storage.reason);
  return app;
}

// A product at `price` DA per piece.
async function appWithProduct(price = 10000) {
  const app = await startedApp();
  const { id, ...values } = sampleProduct({ name: "Marble slab", sellingPrice: price, priceUnit: "piece", stockUnit: "piece", tileSize: "", coveragePerBox: null, purchasePrice: null, sku: "MS-1", stock: 50 });
  await app.api.addProduct(values);
  return { app, productId: app.api.getState().products[0].id };
}

// 2 pieces at 10,000 DA, 10 % discount, 5 % tax, 500 DA paid now and 100 DA later:
//   subtotal 20,000 - discount 2,000 + tax 900 = total 18,900;  paid 600;  remaining 18,300.
async function partlyPaidInvoice() {
  const { app, productId } = await appWithProduct(10000);
  assert.equal(app.api.addToSale(productId, "2", "piece").ok, true);
  const sale = app.api.getSale();
  sale.discountType = "percent"; sale.discountValue = "10";
  sale.taxType = "percent"; sale.taxValue = "5";
  sale.paidValue = "500";
  await app.api.completeSale();
  const invoice = app.api.getInvoices()[0];
  assert.equal((await app.api.addPayment(invoice.id, "100")).error, undefined);
  return { app, productId, invoiceId: invoice.id };
}

const savedInvoice = (app, id) => app.api.getInvoices().find((i) => i.id === id);
const shown = (app, id) => app.api.invoiceHtml(savedInvoice(app, id));

/* ---------- The default ---------- */

test("dinars is the default: a new installation, and saved settings that have no currency preference", async () => {
  const app = await startedApp();
  assert.equal(app.api.getState().settings.currencyUnit, "dinars");
  assert.equal(app.api.DEFAULT_SETTINGS.currencyUnit, "dinars");
  app.api.applyCurrencyUnit();
  assert.equal(app.field("currencyUnitDinars").checked, true);
  assert.equal(app.api.invoiceMoney(1500), "1,500 DA");

  // An installation from before this setting existed: its settings have no such key. Nothing else about them changes.
  const old = { version: 1, lastSaved: "2026-01-01T00:00:00.000Z", products: [], invoices: [], invoiceCounter: 5, settings: { businessName: "Old Shop", address: "1 Old Road", currency: "DZD", paper: "A5" } };
  const upgraded = await startedApp({ localStorage: { "invoisy-data": JSON.stringify(old) } });
  const settings = upgraded.api.getState().settings;
  assert.equal(settings.currencyUnit, "dinars");
  assert.deepEqual([settings.businessName, settings.address, settings.currency, settings.paper], ["Old Shop", "1 Old Road", "DZD", "A5"]);
  assert.equal(upgraded.api.invoiceMoney(1500), "1,500 DZD", "the existing label is kept in dinars mode");

  // Missing, unknown or the wrong kind of value all mean dinars; a settings file with a bad value is refused like a bad paper size.
  const V = app.api.Validation;
  for (const stored of [{}, { currencyUnit: "" }, { currencyUnit: "cents" }, { currencyUnit: 5 }, null]) {
    assert.equal(V.normalizeSettings(stored).currencyUnit, "dinars", JSON.stringify(stored));
  }
  assert.equal(V.normalizeSettings({ currencyUnit: "centimes" }).currencyUnit, "centimes");
  assert.equal(V.settingsProblem({ currencyUnit: "centimes" }), "");
  assert.equal(V.settingsProblem({ currencyUnit: "dinars" }), "");
  assert.notEqual(V.settingsProblem({ currencyUnit: "cents" }), "");
});

/* ---------- The conversion ---------- */

test("1 DA = 100 centimes: the amounts of the specification, in both modes", async () => {
  const app = await startedApp();
  const examples = [
    [1, "1 DA", "100 centimes"],
    [10, "10 DA", "1,000 centimes"],
    [100, "100 DA", "10,000 centimes"],
    [1000, "1,000 DA", "100,000 centimes"],
    [1500.5, "1,500.5 DA", "150,050 centimes"],
    [0, "0 DA", "0 centimes"],
  ];
  for (const [amount, dinars, centimes] of examples) {
    await app.api.saveCurrencyUnit("dinars");
    assert.equal(app.api.invoiceMoney(amount), dinars);
    await app.api.saveCurrencyUnit("centimes");
    assert.equal(app.api.invoiceMoney(amount), centimes);
  }
});

test("the conversion keeps every digit: no floating point noise, no rounding away of real precision", async () => {
  const app = await startedApp();
  await app.api.saveCurrencyUnit("centimes");
  // 1.15 x 100 and 0.29 x 100 are 114.99999999999999 and 28.999999999999996 in floating point.
  assert.equal(app.api.displayAmount(1.15), 115);
  assert.equal(app.api.displayAmount(0.29), 29);
  assert.equal(app.api.displayAmount(4.35), 435);
  assert.equal(app.api.displayAmount(19.99), 1999);
  assert.equal(app.api.displayAmount(0.125), 12.5, "a fraction of a centime is kept, not rounded away");
  assert.equal(app.api.displayAmount(123456789.12), 12345678912);
  assert.equal(app.api.displayAmount(undefined), 0);
  assert.equal(app.api.displayAmount("abc"), 0);

  // Back to dinars the very same numbers come out: switching never accumulates an error.
  const amounts = [1, 0.1, 0.29, 1.15, 4.35, 19.99, 1500.5, 14112, 123456789.12];
  for (let round = 0; round < 25; round++) {
    await app.api.saveCurrencyUnit(round % 2 ? "dinars" : "centimes");
  }
  await app.api.saveCurrencyUnit("dinars");
  assert.deepEqual(amounts.map((a) => app.api.displayAmount(a)), amounts);
});

/* ---------- The invoice ---------- */

test("the invoice shows every amount in centimes, and the same invoice in dinars again afterwards", async () => {
  const { app, invoiceId } = await partlyPaidInvoice();
  const inv = savedInvoice(app, invoiceId);
  assert.deepEqual([inv.subtotal, inv.discount, inv.tax, inv.total], [20000, 2000, 900, 18900]);

  const inDinars = shown(app, invoiceId);
  assert.match(inDinars, /Price \(DA\)/);
  assert.match(inDinars, /Total \(DA\)/);
  assert.match(inDinars, /<td class="num">2 Pieces<\/td><td class="num">10,000 <span class="inv-unit">\/ Piece<\/span><\/td><td class="num">20,000<\/td>/);
  for (const text of ["20,000 DA", "2,000 DA", "900 DA", "18,900 DA", "600 DA", "18,300 DA"]) assert.ok(inDinars.includes(text), text + " in dinars");
  assert.ok(!inDinars.includes("centimes"));

  await app.api.saveCurrencyUnit("centimes");
  const inCentimes = shown(app, invoiceId);
  assert.match(inCentimes, /Price \(centimes\)/);
  assert.match(inCentimes, /Total \(centimes\)/);
  assert.ok(!inCentimes.includes("DA"), "no dinar label is left on the invoice");
  // Line: the quantity is untouched, the price keeps its unit, price and total are x 100.
  assert.match(inCentimes, /<td class="num">2 Pieces<\/td><td class="num">1,000,000 <span class="inv-unit">\/ Piece<\/span><\/td><td class="num">2,000,000<\/td>/);
  // Totals, payments and the remaining balance: x 100.
  for (const text of ["2,000,000 centimes", "200,000 centimes", "90,000 centimes", "1,890,000 centimes", "60,000 centimes", "1,830,000 centimes"]) {
    assert.ok(inCentimes.includes(text), text + " in centimes");
  }
  // Both payments of the history are there: 500 DA and 100 DA.
  assert.ok(inCentimes.includes("50,000 centimes") && inCentimes.includes("10,000 centimes"), "each payment, in centimes");

  await app.api.saveCurrencyUnit("dinars");
  assert.equal(shown(app, invoiceId), inDinars, "back to dinars: byte for byte the invoice it was");
});

test("a price per m² keeps its unit: 1,500 DA / m² reads 150,000 centimes / m²", async () => {
  const app = await startedApp();
  const { id, ...values } = sampleProduct({ name: "Tile", tileSize: "60*60", coveragePerBox: 1.44, sku: "T-1", sellingPrice: 1500, priceUnit: "m2", stockUnit: "box", purchasePrice: 900, stock: 20 });
  await app.api.addProduct(values);
  const productId = app.api.getState().products[0].id;
  assert.equal(app.api.addToSale(productId, "10", "box").ok, true);
  app.api.getSale().paidValue = "0";
  await app.api.completeSale();
  const invoice = app.api.getInvoices()[0];

  const dinarsHtml = app.api.invoiceHtml(invoice);
  assert.match(dinarsHtml, /<td class="num">1,500 <span class="inv-unit">\/ m²<\/span><\/td>/);
  await app.api.saveCurrencyUnit("centimes");
  const html = app.api.invoiceHtml(invoice);
  assert.match(html, /<td class="num">150,000 <span class="inv-unit">\/ m²<\/span><\/td>/);
  assert.match(html, /<td class="num">10 Boxes<div class="inv-sub">14\.4 m²<\/div><\/td>/, "quantity and area are not converted");
  assert.ok(html.includes(`${(1500 * 14.4 * 100).toLocaleString("en")} centimes`), "the grand total is the m² price x area x 100");
});

test("carried-forward debt lines are converted too", async () => {
  const { app, invoiceId } = await partlyPaidInvoice();
  const withDebt = { ...plain(savedInvoice(app, invoiceId)), carriedForward: [{ sourceInvoiceId: "old", sourceInvoiceNumber: "INV-000001", sourceDate: "2026-01-02T10:00:00.000Z", amount: 3000 }] };
  assert.match(app.api.invoiceHtml(withDebt), /<td class="num">3,000<\/td>/);
  await app.api.saveCurrencyUnit("centimes");
  const html = app.api.invoiceHtml(withDebt);
  assert.match(html, /<td class="num">300,000<\/td>/);
  assert.ok(html.includes("300,000 centimes"), "the carried total");
});

test("the printed pages are made from the same pieces, so they follow the same setting (A4 and A5)", async () => {
  const { app, invoiceId } = await partlyPaidInvoice();
  const inv = savedInvoice(app, invoiceId);
  const printed = () => app.api.printItems(inv).map((item) => (item.kind === "block" ? item.html : item.entries.join("") + item.build(item.entries, false))).join("\n");
  assert.ok(printed().includes("18,900 DA"));

  for (const paper of ["A4", "A5"]) {
    await app.api.savePaper(paper);
    await app.api.saveCurrencyUnit("centimes");
    const printedCentimes = printed();
    assert.ok(printedCentimes.includes("1,890,000 centimes") && printedCentimes.includes("1,830,000 centimes"), paper);
    assert.ok(!printedCentimes.includes("DA"), paper + ": no dinar label");
    // What is printed shows the same amounts as the live preview.
    for (const amount of ["2,000,000", "1,890,000 centimes", "1,830,000 centimes", "60,000 centimes"]) {
      assert.ok(app.api.invoiceHtml(inv).includes(amount) && printedCentimes.includes(amount), `${paper}: ${amount} in preview and print`);
    }
    await app.api.saveCurrencyUnit("dinars");
  }
  assert.equal(app.api.getState().settings.paper, "A5", "the paper size is not touched by the currency display");
});

test("the label and the amount stay left to right in French and Arabic", async () => {
  const { app, invoiceId } = await partlyPaidInvoice();
  await app.api.saveCurrencyUnit("centimes");
  await app.api.saveLanguage("fr");
  const fr = shown(app, invoiceId);
  assert.ok(fr.includes("1 890 000 centimes"), "French groups digits with a no-break space");
  await app.api.saveLanguage("ar");
  const ar = shown(app, invoiceId);
  assert.ok(ar.includes("⁦") && ar.includes("centimes"), "Arabic keeps the amount in its own left-to-right run");
  await app.api.saveLanguage("en");
  assert.equal(app.api.getState().settings.currencyUnit, "centimes", "changing the language does not touch it");
});

/* ---------- Nothing that is stored changes ---------- */

test("switching the display changes no invoice, payment, stock level, price, counter or other setting", async () => {
  const { app, invoiceId } = await partlyPaidInvoice();
  const snapshot = () => {
    const state = app.api.getState();
    const { currencyUnit, ...otherSettings } = plain(state.settings);
    return plain({ products: state.products, invoices: state.invoices, counter: state.counter, otherSettings });
  };
  const before = snapshot();
  const invoiceBefore = plain(savedInvoice(app, invoiceId));

  for (const unit of ["centimes", "dinars", "centimes", "centimes", "dinars"]) {
    await app.api.saveCurrencyUnit(unit);
    assert.deepEqual(snapshot(), before, `after choosing ${unit}`);
    assert.equal(app.api.getState().settings.currencyUnit, unit);
  }
  assert.deepEqual(plain(savedInvoice(app, invoiceId)), invoiceBefore);
  assert.deepEqual(plain(app.api.paymentInfo(savedInvoice(app, invoiceId))).paid, 600);
  assert.equal(app.api.getState().products[0].sellingPrice, 10000);
  assert.equal(app.api.getState().products[0].stock, 48);
  assert.equal(app.api.getState().invoices.length, 1, "no new invoice");
});

test("payments recorded and a refund after the display was changed are in dinars, as ever", async () => {
  const { app, invoiceId } = await partlyPaidInvoice();
  await app.api.saveCurrencyUnit("centimes");
  // The payment box is a typing field: what is typed is dinars. The invoice shows the result in centimes.
  assert.equal((await app.api.addPayment(invoiceId, "400")).error, undefined);
  const inv = savedInvoice(app, invoiceId);
  assert.deepEqual(plain(inv.payments.map((p) => p.amount)), [500, 100, 400]);
  assert.ok(shown(app, invoiceId).includes("1,790,000 centimes"), "remaining 17,900 DA");
  assert.equal(app.api.paymentInfo(inv).remaining, 17900);
});

/* ---------- Saved, and still there after a reload ---------- */

test("the choice is saved and restored when the application is opened again", async () => {
  const { app, invoiceId } = await partlyPaidInvoice();
  await app.api.saveCurrencyUnit("centimes");
  assert.equal(app.field("currencyUnitCentimes").checked, true);
  const before = plain({ products: app.api.getState().products, invoices: app.api.getState().invoices, counter: app.api.getState().counter });

  const reopened = await startedApp({ indexedDB: app.indexedDB });          // the same database, a new page load
  assert.equal(reopened.api.getState().settings.currencyUnit, "centimes");
  assert.equal(reopened.field("currencyUnitCentimes").checked, true, "the selector shows it");
  assert.ok(reopened.api.invoiceHtml(savedInvoice(reopened, invoiceId)).includes("1,830,000 centimes"));
  assert.deepEqual(plain({ products: reopened.api.getState().products, invoices: reopened.api.getState().invoices, counter: reopened.api.getState().counter }), before);

  await reopened.api.saveCurrencyUnit("dinars");
  const again = await startedApp({ indexedDB: app.indexedDB });
  assert.equal(again.api.getState().settings.currencyUnit, "dinars");
  assert.equal(again.field("currencyUnitDinars").checked, true);
});

test("Save Settings (business details) does not reset the choice, nor does choosing reset the business details", async () => {
  const app = await startedApp();
  await app.api.saveCurrencyUnit("centimes");
  app.api.fillSettingsForm();
  app.field("sName").value = "Timgad Ceramic";
  await app.api.saveBusinessSettings();
  assert.equal(app.api.getState().settings.businessName, "Timgad Ceramic");
  assert.equal(app.api.getState().settings.currencyUnit, "centimes");

  await app.api.savePaper("A5");
  await app.api.saveCurrencyUnit("dinars");
  const s = app.api.getState().settings;
  assert.deepEqual([s.businessName, s.paper, s.currencyUnit, s.currency], ["Timgad Ceramic", "A5", "dinars", "DA"]);
});

test("a bad value is ignored and the saved choice stays", async () => {
  const app = await startedApp();
  await app.api.saveCurrencyUnit("centimes");
  await app.api.saveCurrencyUnit("cents");
  await app.api.saveCurrencyUnit(undefined);
  assert.equal(app.api.getState().settings.currencyUnit, "centimes");
  assert.equal(app.field("currencyUnitCentimes").checked, true);
});

test("a backup carries the choice, and an older backup without it restores as dinars", async () => {
  const { app } = await partlyPaidInvoice();
  await app.api.saveCurrencyUnit("centimes");
  await app.api.exportBackup();
  const text = await app.downloadedText();
  const V = app.api.Validation;
  const parsed = V.parseBackup(text);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.data.settings.currencyUnit, "centimes");

  // Restoring it brings the choice back, with the invoice it displays.
  const restored = await startedApp();
  await restored.api.importBackup(restored.file(text));
  assert.equal(restored.api.getState().settings.currencyUnit, "centimes");
  assert.equal(restored.api.getState().invoices.length, 1);
  assert.ok(restored.api.invoiceHtml(restored.api.getInvoices()[0]).includes("1,830,000 centimes"));

  // A backup made before the setting existed has no such key: it restores as dinars and nothing else about it changes.
  const old = JSON.parse(text);
  delete old.data.settings.currencyUnit;
  old.data.settings.businessName = "Old Shop";
  const older = await startedApp();
  await older.api.importBackup(older.file(JSON.stringify(old)));
  const settings = older.api.getState().settings;
  assert.equal(settings.currencyUnit, "dinars");
  assert.equal(settings.businessName, "Old Shop");
  assert.equal(older.api.getState().invoices.length, 1);
  assert.equal(older.api.getInvoices()[0].total, 18900, "the saved amounts are untouched");
  assert.ok(older.api.invoiceHtml(older.api.getInvoices()[0]).includes("18,900 DA"));
});

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const SCRIPT_DIR = path.join(__dirname, "..", "java script");
// Add a new language's file here (and in index.html and tests/helpers.js).
const LANGUAGE_FILES = ["i18n.js", "lang/en.js", "lang/fr.js"];
const read = (file) => fs.readFileSync(path.join(SCRIPT_DIR, file), "utf8");

// Loads only the language files: enough to check the dictionaries.
function loadI18n() {
  const context = { Intl };
  vm.createContext(context);
  for (const file of LANGUAGE_FILES) vm.runInContext(read(file), context, { filename: file });
  return context.I18n;
}

// The app itself, with the same small stand-ins for the page that product-model.test.js uses.
function loadApp() {
  const fields = new Map();
  const element = (id) => {
    if (!fields.has(id)) fields.set(id, {
      id, value: "", textContent: "", innerHTML: "", className: "", hidden: false, dataset: {}, style: {}, offsetHeight: 0,
      classList: { toggle() {} }, reset() {}, focus() {}, querySelectorAll() { return []; }, setAttribute() {}, removeAttribute() {},
    });
    return fields.get(id);
  };
  const values = new Map();
  const exports = {};
  const context = {
    __INVOISY_TEST_EXPORTS__: exports,
    console,
    Intl,
    document: { getElementById: element, querySelectorAll: () => [], documentElement: { style: { setProperty() {} } } },
    window: {},
    localStorage: { getItem: (k) => (values.has(k) ? values.get(k) : null), setItem: (k, v) => values.set(k, String(v)) },
    setTimeout, clearTimeout, structuredClone,
  };
  vm.createContext(context);
  for (const file of LANGUAGE_FILES.concat(["calc.js", "script.js"])) vm.runInContext(read(file), context, { filename: file });
  const api = exports;
  const useLanguage = (language) => api.applyData({
    products: [], invoices: [], settings: { ...api.DEFAULT_SETTINGS, language }, counter: 0, lastSaved: "",
  });
  return { api, I18n: context.I18n, Calc: context.Calc, useLanguage, field: element };
}

const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");

/* ---------- The dictionaries ---------- */

test("every language has exactly the keys English has", () => {
  const I18n = loadI18n();
  const en = loadMessages("lang/en.js");
  for (const { code } of I18n.languages()) {
    const keys = Object.keys(loadMessages(`lang/${code}.js`));
    assert.deepEqual(keys.filter((k) => !(k in en)), [], `${code} has keys English does not`);
    assert.deepEqual(Object.keys(en).filter((k) => !keys.includes(k)), [], `${code} is missing keys`);
  }
});

test("every translation keeps the {placeholders} of the English text", () => {
  const en = loadMessages("lang/en.js");
  for (const code of ["fr"]) {
    const messages = loadMessages(`lang/${code}.js`);
    for (const key of Object.keys(en)) {
      assert.equal(placeholders(messages[key]), placeholders(en[key]), `${code}: placeholders differ for ${key}`);
    }
  }
});

test("counted text always comes as a .one and a .other pair", () => {
  for (const file of ["lang/en.js", "lang/fr.js"]) {
    const keys = Object.keys(loadMessages(file));
    for (const key of keys.filter((k) => k.endsWith(".one"))) assert.ok(keys.includes(key.replace(/\.one$/, ".other")), `${file}: ${key} has no .other`);
    for (const key of keys.filter((k) => k.endsWith(".other"))) assert.ok(keys.includes(key.replace(/\.other$/, ".one")), `${file}: ${key} has no .one`);
  }
});

test("French has no empty values and uses non-breaking spaces before : ? ! ; and inside « »", () => {
  const fr = loadMessages("lang/fr.js");
  for (const [key, text] of Object.entries(fr)) {
    assert.ok(text.length > 0, `${key} is empty`);
    assert.doesNotMatch(text, / [:;?!»]|« /, `${key} has a breaking space before punctuation`);
  }
});

// Reads a language file's messages by running it against a stand-in I18n.register.
function loadMessages(file) {
  let messages;
  const context = { I18n: { register: (code, name, m) => { messages = m; } } };
  vm.createContext(context);
  vm.runInContext(read(file), context, { filename: file });
  return messages;
}

/* ---------- The code only asks for text that exists ---------- */

test("every text key used in the code or in index.html exists in English", () => {
  const en = loadMessages("lang/en.js");
  // A key ending in "." is the start of a key built at run time ("demo.cat." + category, "unit." + unit);
  // the "units and demo products are translated" test checks those.
  const known = (key) => key.endsWith(".") || key in en || (`${key}.one` in en && `${key}.other` in en);
  const namespaces = [...new Set(Object.keys(en).map((k) => k.split(".")[0]))];
  const literal = new RegExp(`"((?:${namespaces.join("|")})\\.[A-Za-z0-9.]+)"`, "g");

  const used = new Map();   // key -> where
  for (const file of ["script.js", "calc.js"]) {
    for (const m of read(file).matchAll(literal)) used.set(m[1], file);
  }
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  for (const m of html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) used.set(m[1], "index.html");

  const missing = [...used].filter(([key]) => !known(key)).map(([key, file]) => `${key} (${file})`);
  assert.deepEqual(missing, []);
  assert.ok(used.size > 100, "the scan should find the keys the app uses");
});

test("units and demo products are translated", () => {
  const { api } = loadApp();
  const en = loadMessages("lang/en.js");
  const fr = loadMessages("lang/fr.js");
  for (const unit of ["piece", "box", "m2", "kg", "m"]) {
    assert.ok(`unit.${unit}` in en && `price.${unit}` in en, `unit ${unit}`);
    assert.ok(`unit.${unit}` in fr && `price.${unit}` in fr, `unit ${unit} (fr)`);
  }
  for (const demo of api.DEMO_PRODUCTS) {
    assert.ok(`demo.${demo.sku}.name` in en && `demo.${demo.sku}.name` in fr, `demo name ${demo.sku}`);
    if (demo.description) assert.ok(`demo.${demo.sku}.description` in fr, `demo description ${demo.sku}`);
    assert.ok(`demo.cat.${demo.category.toLowerCase()}` in fr, `demo category ${demo.category}`);
  }
});

/* ---------- The engine ---------- */

test("the language switches, falls back to English, and ignores unknown codes", () => {
  const I18n = loadI18n();
  assert.equal(I18n.language(), "en");
  assert.equal(I18n.t("nav.settings"), "Settings");
  I18n.setLanguage("fr");
  assert.equal(I18n.t("nav.settings"), "Paramètres");
  assert.equal(I18n.setLanguage("de"), "en");              // unknown: back to English
  assert.equal(I18n.t("no.such.key"), "no.such.key");       // unknown key: shows the key, never crashes
  assert.equal(I18n.t("stock.n", { n: 3 }), "Stock: 3");
  assert.deepEqual(Array.from(I18n.languages(), (l) => l.name), ["English", "Français"]);
});

test("plurals follow the language: French 0 and 1 are singular, English only 1", () => {
  const I18n = loadI18n();
  assert.equal(I18n.tn("storage.countProducts", 0), "0 products");
  assert.equal(I18n.tn("storage.countProducts", 1), "1 product");
  I18n.setLanguage("fr");
  assert.equal(I18n.tn("storage.countProducts", 0), "0 produit");
  assert.equal(I18n.tn("storage.countProducts", 1), "1 produit");
  assert.equal(I18n.tn("storage.countProducts", 2), "2 produits");
});

/* ---------- The app in French ---------- */

test("numbers and money follow the language", () => {
  const { api, useLanguage } = loadApp();
  assert.equal(api.money(1152.5), "1,152.5 DA");
  useLanguage("fr");
  assert.equal(api.money(1152.5), "1\u00a0152,5 DA");     // no-break space between groups, comma decimal
});

test("sale errors and form checks speak French", () => {
  const { api, useLanguage, field } = loadApp();
  useLanguage("fr");
  api.applyData({
    products: [api.normalizeProduct({ id: "t1", name: "Tile", sellingPrice: 800, priceUnit: "m2", stock: 3, tileSize: "60*60", coveragePerBox: 1.44 })],
    invoices: [], settings: { ...api.DEFAULT_SETTINGS, language: "fr" }, counter: 0, lastSaved: "",
  });
  assert.equal(api.addToSale("t1", "9", "box").error, "Stock insuffisant. Quantité disponible\u00a0: 3 Cartons.");   // the stock is shown with its unit
  assert.equal(api.addToSale("t1", "0", "box").error, "La quantité doit être un nombre entier d’au moins 1.");
  assert.equal(api.productProblem({ ...api.normalizeProduct({ id: "x", name: "A", sellingPrice: 1 }), priceUnit: "bogus" }), "unité de prix non valide");
  field("pName").value = "";
  assert.equal(api.readProductForm().error, "Le nom du produit est obligatoire.");
});

test("price conversion messages use the unit names of the language", () => {
  const { api, useLanguage } = loadApp();
  const cement = { id: "c1", name: "Ciment", sellingPrice: 300, priceUnit: "kg", stock: 10 };
  useLanguage("en");
  api.applyData({ products: [api.normalizeProduct(cement)], invoices: [], settings: { ...api.DEFAULT_SETTINGS }, counter: 0, lastSaved: "" });
  assert.equal(api.addToSale("c1", "1", "piece").error, "Ciment is priced per kg, so it can't be sold by piece.");
  api.applyData({ products: [api.normalizeProduct(cement)], invoices: [], settings: { ...api.DEFAULT_SETTINGS, language: "fr" }, counter: 0, lastSaved: "" });
  assert.equal(api.addToSale("c1", "1", "piece").error, "Ciment est tarifé par kg\u00a0: il ne peut pas être vendu par pièce.");
});

test("unit names, plurals and conversion messages of calc.js follow the language", () => {
  const { Calc, useLanguage } = loadApp();
  const tile = { id: "t1", name: "Carrelage", tileSize: "60*60", coveragePerBox: 1.44, sellingPrice: 1500, priceUnit: "m2", stockUnit: "box", stock: 20 };

  assert.equal(Calc.unitLabel("box", 2), "Boxes");
  assert.equal(Calc.unitLabel("piece", 1), "Piece");
  useLanguage("fr");
  assert.equal(Calc.unitLabel("box", 2), "Cartons");
  assert.equal(Calc.unitLabel("box", 1), "Carton");
  assert.equal(Calc.unitLabel("box", 0.75), "Carton");      // French: anything below 2 is singular
  assert.equal(Calc.unitLabel("m2", 3), "m²");              // units that never change with the count
  assert.equal(Calc.unitLabel("piece"), "Pièce");

  assert.equal(Calc.getUnitPrice({ ...tile, coveragePerBox: undefined }, "box").error,
    "Carrelage n’a pas de couverture par carton. Modifiez le produit pour pouvoir convertir vers ou depuis les cartons.");
  assert.equal(Calc.getUnitPrice({ ...tile, priceUnit: "kg", stockUnit: "kg" }, "box").error,
    "Carrelage est tarifé par kg\u00a0: il ne peut pas être vendu par carton.");
  assert.equal(Calc.getPiecesPerBox({ ...tile, coveragePerBox: 1.5 }).error,
    "Carrelage\u00a0: la couverture par carton (1.5 m²) n’est pas un nombre entier de pièces de 0.36 m². Vérifiez les dimensions du carreau et la couverture par carton.");
  assert.equal(Calc.validateQuantity("1.5", "box").error, "La quantité doit être un nombre entier d’au moins 1.");
  assert.equal(Calc.validateQuantity("0", "kg").error, "La quantité doit être supérieure à 0.");
  assert.equal(Calc.boxesForArea(tile, 0).error, "Saisissez la surface en m², supérieure à 0.");
});

test("stock is shown with its unit in French, and the new product-form checks speak French", () => {
  const { api, useLanguage, field } = loadApp();
  useLanguage("fr");
  const tile = api.normalizeProduct({ id: "t1", name: "Carrelage", tileSize: "60*60", coveragePerBox: 1.44, sellingPrice: 1500, priceUnit: "m2", stockUnit: "box", stock: 20 });
  assert.equal(api.stockLabel(tile), "20 Cartons (80 Pièces)");
  assert.equal(api.priceNote({ productId: "none" }), "");

  api.applyData({ products: [tile], invoices: [], settings: { ...api.DEFAULT_SETTINGS, language: "fr" }, counter: 0, lastSaved: "" });
  assert.equal(api.addToSale("t1", "1", "piece").ok, true);
  const line = api.getSale().items[0];
  assert.equal(api.updateSalePrice(line.lineId, "500").error, undefined);
  assert.equal(api.priceNote(line), "Prix personnalisé (calculé\u00a0: 540 DA)");

  const fill = (extra) => {
    const base = { pName: "Tile", pManufacturer: "", pTileSize: "60*60", pCoveragePerBox: "1.44", pDesc: "", pPrice: "800", pPriceUnit: "m2", pCost: "", pStock: "5", pStockUnit: "box", pSku: "", pCategory: "" };
    for (const [id, value] of Object.entries({ ...base, ...extra })) field(id).value = value;
    return api.readProductForm();
  };
  assert.equal(fill({ pStockUnit: "" }).error, "Choisissez l’unité dans laquelle le stock est compté.");
  assert.equal(fill({ pStockUnit: "kg" }).error, "Un stock compté en kg ne correspond pas à un prix par m².");
  assert.equal(fill({ pStock: "2.5" }).error, "Le stock doit être un nombre entier, 0 ou plus.");
  assert.equal(api.productProblem({ ...tile, stockUnit: "bogus" }), "unité de stock non valide");
});

test("the printed invoice is in French but the saved invoice data stays language-neutral", () => {
  const { api, useLanguage } = loadApp();
  api.applyData({
    products: [api.normalizeProduct({ id: "p1", name: "Chips", sellingPrice: 120, priceUnit: "piece", stock: 5 })],
    invoices: [], settings: { ...api.DEFAULT_SETTINGS, language: "fr" }, counter: 0, lastSaved: "",
  });
  assert.equal(api.addToSale("p1", "2", "piece").ok, true);
  const invoice = api.buildInvoiceData(api.getSale(), "INV-000001", new Date().toISOString());

  // What is saved in the data file does not change with the language.
  assert.equal(invoice.customer.name, "Walk-in Customer");
  assert.equal(invoice.payments.length, 1);

  const french = api.invoiceHtml(invoice);
  assert.match(french, />FACTURE</);
  assert.match(french, /Client de passage/);
  assert.match(french, /Sous-total/);
  assert.match(french, /STATUT\u00a0: PAYÉE/);
  assert.match(french, /Merci pour votre achat\./);
  assert.doesNotMatch(french, /Walk-in|Thank you|INVOICE/);

  useLanguage("en");
  const english = api.invoiceHtml(invoice);
  assert.match(english, />INVOICE</);
  assert.match(english, /Walk-in Customer/);
  assert.match(english, /STATUS: PAID/);
});

test("an invoice line for a deleted product is shown translated but saved as before", () => {
  const { api, useLanguage } = loadApp();
  const line = { name: "(deleted product)", tileSize: "", manufacturer: "" };
  assert.equal(api.invoiceItemLabel(line), "(deleted product)");
  useLanguage("fr");
  assert.equal(api.invoiceItemLabel(line), "(produit supprimé)");
});

test("the language is a saved setting; old files without it and unknown codes still load", () => {
  const { api, I18n } = loadApp();
  assert.equal(api.DEFAULT_SETTINGS.language, "en");

  // An existing data file from before this setting: loads, as English.
  const old = { version: 1, lastSaved: "2026-01-01T00:00:00.000Z", products: [], invoices: [], invoiceCounter: 0, settings: { businessName: "Shop", currency: "DA", paper: "A4" } };
  const parsed = api.parseDataText(JSON.stringify(old));
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.data.settings.language, "en");

  // A code this version doesn't know (for example from a newer version) falls back instead of blocking the file.
  const future = { ...old, settings: { ...old.settings, language: "xx" } };
  assert.equal(api.parseDataText(JSON.stringify(future)).data.settings.language, "en");

  // A French setting is written to the file and read back.
  const draft = { products: [], invoices: [], settings: { ...api.DEFAULT_SETTINGS, language: "fr" }, counter: 0 };
  const built = api.buildPayload(draft, "2026-02-02T00:00:00.000Z");
  assert.equal(built.error, undefined);
  const back = api.parseDataText(built.text);
  assert.equal(back.data.settings.language, "fr");
  api.applyData(back.data);
  assert.equal(I18n.language(), "fr");
});

test("demo products are saved in the active language", () => {
  const { api, useLanguage } = loadApp();
  const tile = api.DEMO_PRODUCTS.find((d) => d.sku === "TILE6060");
  assert.equal(api.localizedDemo(tile).name, "Demo Floor Tile");
  useLanguage("fr");
  const french = api.localizedDemo(tile);
  assert.equal(french.name, "Carrelage de démonstration");
  assert.equal(french.category, "Carrelage");
  assert.equal(french.sku, "TILE6060");                      // identity and numbers never change
  assert.equal(french.sellingPrice, 800);
  assert.equal(api.localizedDemo(api.DEMO_PRODUCTS[0]).description, "Bouteille de Coca Cola 330 ml");
});

test("data-check messages speak French and describeData counts correctly", () => {
  const { api, useLanguage } = loadApp();
  useLanguage("fr");
  const built = api.buildData({ products: [{ id: "a", name: "", sellingPrice: 1, stock: 1 }], invoices: [], settings: {}, invoiceCounter: 0, version: 1 }, false);
  assert.equal(built.problems[0], "Produit 1\u00a0: nom manquant.");
  assert.equal(api.describeData({ products: [], invoices: [{}] }), "0 produit, 1 facture");
  assert.equal(api.parseDataText("not json").error, "Le fichier n’est pas un JSON valide.");
});

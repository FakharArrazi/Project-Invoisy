"use strict";

// Loads the language files, calc.js, validation.js, database.js and script.js into a fake browser (no DOM,
// in-memory localStorage, a disposable in-memory IndexedDB) so the application functions can be tested without
// a browser. Shared by the test files.
// The in-memory IndexedDB comes from the fake-indexeddb package (a development-only dependency: `npm install`).
// Without it the tests that only use pure functions still run; the ones that save data say what is missing.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

let fakeIndexedDB = null;
try { fakeIndexedDB = require("fake-indexeddb"); } catch { /* not installed: see above */ }

const SCRIPT_DIR = path.join(__dirname, "..", "java script");
// Loaded first, in the same order as index.html. Add a new language's file here (and in index.html).
const LANGUAGE_FILES = ["i18n.js", "lang/en.js", "lang/fr.js", "lang/ar.js"];
// Everything the page loads, in the order index.html loads it.
const APP_FILES = LANGUAGE_FILES.concat(["calc.js", "purchases.js", "validation.js", "product-form.js", "debt.js", "analytics.js", "database.js", "autobackup.js", "purchases-ui.js", "dashboard.js", "script.js"]);

function loadProductApi() {
  const fields = new Map();
  const element = (id) => {
    if (!fields.has(id)) fields.set(id, {
      id,
      value: "",
      textContent: "",
      className: "",
      hidden: false,
      dataset: {},
      style: {},
      offsetHeight: 0,
      classList: { toggle() {} },
      reset() {},
      focus() {},
      querySelectorAll() { return []; },
      setAttribute() {},
      removeAttribute() {},
    });
    return fields.get(id);
  };
  const values = new Map();
  const localStorage = {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  const exports = {};
  const context = {
    __INVOISY_TEST_EXPORTS__: exports,
    console,
    document: {
      getElementById: element,
      querySelectorAll: () => [],
      documentElement: { style: { setProperty() {} }, dataset: {} },
    },
    window: {},
    localStorage,
    navigator: {},
    indexedDB: fakeIndexedDB ? new fakeIndexedDB.IDBFactory() : undefined,
    setTimeout,
    clearTimeout,
    structuredClone,
  };
  vm.createContext(context);
  for (const file of APP_FILES) {
    const source = fs.readFileSync(path.join(SCRIPT_DIR, file), "utf8");
    vm.runInContext(source, context, { filename: file });
  }
  return { api: exports, field: element };
}

function ceramic(overrides = {}) {
  return {
    id: "product-" + Math.random().toString(36).slice(2),
    name: "Everton Grey",
    manufacturer: "Timgad Ceramic",
    tileSize: "60 × 120 cm",
    coveragePerBox: 2.88,
    description: "",
    sku: "",
    category: "Tiles",
    sellingPrice: 1000,
    purchasePrice: 800,
    stock: 12,
    ...overrides,
  };
}

// Opens the (disposable, in-memory) database and lets the app save to it, WITHOUT loading anything from it, so a
// test can put data in the page with applyData() and then use commit() like the app does. Needs fake-indexeddb.
async function openDatabase(api) {
  await api.db.initDatabase();
  api.getStorage().mode = "ready";
}

// Fills the Stock form the way a person would and reads it with the application's own readProductForm().
// Plain fields are set by their element id. The selling prices are the form's price rows: give `priceRows`
// ([{ unit, price }, ...]), or the single pair pPriceUnit / pPrice. Returns { values } or { field, error }.
function fillProductForm(app, values) {
  const { api, field } = app;
  const rows = values.priceRows || [{ unit: values.pPriceUnit === undefined ? "" : values.pPriceUnit, price: values.pPrice === undefined ? "" : values.pPrice }];
  for (const [id, value] of Object.entries(values)) {
    if (id === "priceRows" || id === "pPrice" || id === "pPriceUnit") continue;
    field(id).value = value;
  }
  api.setPriceRows(rows);
  return api.readProductForm();
}

// The element id of a price row's price / unit control, by row position (0 = first row).
const priceFieldId = (api, index, part) => `${part === "unit" ? "priceUnit" : "priceValue"}-${api.getState().priceRows[index].rowId}`;

module.exports = { loadProductApi, ceramic, openDatabase, fillProductForm, priceFieldId, LANGUAGE_FILES, APP_FILES, SCRIPT_DIR };

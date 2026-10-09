"use strict";

// Loads the language files, calc.js and script.js into a fake browser (no DOM, in-memory localStorage)
// so the application functions can be tested without a browser. Shared by the test files.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SCRIPT_DIR = path.join(__dirname, "..", "java script");
// Loaded first, in the same order as index.html. Add a new language's file here (and in index.html).
const LANGUAGE_FILES = ["i18n.js", "lang/en.js", "lang/fr.js"];

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
  };
  const exports = {};
  const context = {
    __INVOISY_TEST_EXPORTS__: exports,
    console,
    document: {
      getElementById: element,
      querySelectorAll: () => [],
      documentElement: { style: { setProperty() {} } },
    },
    window: {},
    localStorage,
    setTimeout,
    clearTimeout,
    structuredClone,
  };
  vm.createContext(context);
  for (const file of LANGUAGE_FILES.concat(["calc.js", "script.js"])) {
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

module.exports = { loadProductApi, ceramic, LANGUAGE_FILES, SCRIPT_DIR };

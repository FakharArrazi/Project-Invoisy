"use strict";

// The product box of a purchase line is a search box and a list in one. What it finds is decided here, in
// Purchases.matchProducts, so it can be checked without a browser (the box itself is checked by
// tests/e2e/purchase_product_picker_check.py).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
require("./helpers/modules");

const P = globalThis.Purchases;

const catalogue = [
  { id: "1", name: "BARCELONA Crema", tileSize: "60*60", manufacturer: "TimgadCeram", productType: "DalleDeSol" },
  { id: "2", name: "Barcelona Gris", tileSize: "60*60", manufacturer: "TimgadCeram" },
  { id: "3", name: "Tile B", tileSize: "30*30", manufacturer: "Sétif Céram", sku: "SKU-9", category: "Mur" },
  { id: "4", name: "Colle Flex", tileSize: "", manufacturer: "Weber", productType: "CimentColle" },
  { id: "5", name: "Carrelage Crema", tileSize: "45×45", manufacturer: "" },
];
const names = (query, extra) => P.matchProducts(catalogue, query, extra).map((p) => p.name);

test("nothing typed lists every product, alphabetically", () => {
  assert.deepEqual(names(""), ["BARCELONA Crema", "Barcelona Gris", "Carrelage Crema", "Colle Flex", "Tile B"]);
  assert.deepEqual(names("   "), names(""));
  assert.deepEqual(names(undefined), names(""));
  assert.deepEqual(names("—"), names(""), "only punctuation counts as nothing typed");
});

test("capital letters, accents and extra spaces never matter", () => {
  assert.deepEqual(names("barcelona"), ["BARCELONA Crema", "Barcelona Gris"]);
  assert.deepEqual(names("BARCELONA"), ["BARCELONA Crema", "Barcelona Gris"]);
  assert.deepEqual(names("  BaRcElOnA    crema  "), ["BARCELONA Crema"]);
  assert.deepEqual(names("setif ceram"), ["Tile B"]);
  assert.deepEqual(names("SÉTIF"), ["Tile B"]);
});

test("spacing differences are tolerated: no space, a split word, another word order", () => {
  assert.deepEqual(names("barcelonacrema"), ["BARCELONA Crema"]);
  assert.deepEqual(names("tileb"), ["Tile B"]);
  assert.deepEqual(names("tile  b"), ["Tile B"]);
  assert.deepEqual(names("crema barcelona"), ["BARCELONA Crema"]);
});

test("a tile size can be typed as 60*60, 60x60, 60 x 60 or 60 × 60", () => {
  for (const q of ["60*60", "60x60", "60X60", "60 x 60", "60 * 60", "60×60", "60 × 60"]) {
    assert.deepEqual(names(q), ["BARCELONA Crema", "Barcelona Gris"], q);
  }
  assert.deepEqual(names("45x45"), ["Carrelage Crema"], "a product saved as 45×45 is found as 45*45");
  assert.deepEqual(names("60*60 gris"), ["Barcelona Gris"]);
});

test("the manufacturer, SKU, category and any extra text (the product type as shown) are searched too", () => {
  assert.deepEqual(names("weber"), ["Colle Flex"]);
  assert.deepEqual(names("sku9"), ["Tile B"]);
  assert.deepEqual(names("mur"), ["Tile B"]);
  assert.deepEqual(names("ciment colle"), [], "the type is not searched unless the screen passes its shown text");
  const typeText = (p) => (p.productType === "CimentColle" ? "Ciment-colle" : p.productType === "DalleDeSol" ? "Dalle de sol" : "");
  assert.deepEqual(names("ciment colle", typeText), ["Colle Flex"]);
  assert.deepEqual(names("dalle de sol", typeText), ["BARCELONA Crema"]);
});

test("every word typed must be found: no match gives an empty list", () => {
  assert.deepEqual(names("zzz nothing"), []);
  assert.deepEqual(names("barcelona zzz"), []);
});

test("names that start with the text come before names that merely contain it", () => {
  const list = [
    { id: "a", name: "Grand Crema", tileSize: "" },
    { id: "b", name: "Crema Classic", tileSize: "" },
    { id: "c", name: "Ultracrema", tileSize: "" },
    { id: "d", name: "Sable", tileSize: "", manufacturer: "Crema SA" },
  ];
  assert.deepEqual(P.matchProducts(list, "crema").map((p) => p.name), ["Crema Classic", "Grand Crema", "Ultracrema", "Sable"]);
});

test("it never changes the list it is given, and tolerates odd input", () => {
  const before = JSON.stringify(catalogue);
  names("barcelona");
  assert.equal(JSON.stringify(catalogue), before);
  assert.deepEqual(P.matchProducts(null, "x"), []);
  assert.deepEqual(P.matchProducts([{ id: "z", name: null }], "x"), []);
  assert.equal(P.matchProducts([{ id: "z", name: "Z" }], "").length, 1);
});

test("the purchase line's product box and its strings exist in English and French", () => {
  const script = path.join(__dirname, "..", "java script");
  const ui = fs.readFileSync(path.join(script, "purchases-ui.js"), "utf8");
  assert.match(ui, /id="pl-\$\{id\}-search"[^>]*role="combobox"/, "the product box is a combobox");
  assert.match(ui, /<select id="pl-\$\{id\}-product"[^>]*hidden/, "the real value stays in the hidden list the form reads");
  assert.match(ui, /class="btn small pl-add-product" data-act="pur-product-new"/, "+ Add new product is a button");
  const used = [...ui.matchAll(/t\("(pur\.product(?:Search|ListAria|NoMatch|None|AddHint|More))"/g)].map((m) => m[1]);
  assert.ok(used.length >= 6, "the box uses its own strings: " + used.join(", "));
  for (const lang of ["en", "fr"]) {
    const dict = fs.readFileSync(path.join(script, "lang", lang + ".js"), "utf8");
    for (const key of new Set(used.concat(["pur.addNewProduct"]))) assert.ok(dict.includes(`"${key}"`), `${lang} has ${key}`);
  }
});

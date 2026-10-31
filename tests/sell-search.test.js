"use strict";

// The Sell page search box (and the Stock filter, which shares it): what it finds, in which order, and that it never drops
// a product that matches. The product type is searched through the product's existing `productType` value (no second type
// system): "Pâte à joint" is found as "pâte à joint", "pate a joint", "PATE À JOINT" and (Arabic app) "معجون الفواصل".
//
// History: the list used to be cut at 8 results after sorting, so on "joint" the Capablanco products (earlier in the
// alphabet) filled the list and every Sika product was silently left out, though "sika" found them.

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./helpers/app");

const product = (id, name, manufacturer, productType, extra) => ({
  id, name, manufacturer, productType, sellingPrice: 100, priceUnit: "piece", stockUnit: "piece", stock: 10, ...extra,
});

const JOINTS = [
  product("cap2", "Capablanco pate a joint 2KG beige", "Capa", "PateAJoint"),
  product("cap5", "Capablanco pate a joint 5KG beige", "Capa", "PateAJoint"),
  product("sika-beige", "Sika 510 Joint Beige 5KG", "SikaCeram", "PateAJoint"),
  product("sika-blanc", "Sika 510 Joint Blanc", "SikaCeram", "PateAJoint"),
  product("sika-brown", "Sika 510 Joint brown", "SikaCeram", "PateAJoint"),
  product("sika-noir", "Sika 510 Joint Noir", "SikaCeram", "PateAJoint"),
  product("cer1", "Ceresit CE 40 joint gris", "Ceresit", "PateAJoint"),
  product("cer2", "Ceresit CE 40 joint blanc", "Ceresit", "PateAJoint"),
  product("map1", "Mapei Ultracolor joint 2KG", "Mapei", "PateAJoint"),
  product("map2", "Mapei Keracolor joint 5KG", "Mapei", "PateAJoint"),
  product("web1", "Weber joint fin", "Weber", "PateAJoint"),
  // Its type is the only thing that says "pâte à joint": neither its name nor its manufacturer does.
  product("kera", "Kerapoxy Design", "Mapei", "PateAJoint"),
];
const OTHERS = [
  product("dal1", "Barcelona Crema", "TimgadCeram", "DalleDeSol", { tileSize: "60*60" }),
  product("dal2", "Everton Grey", "TimgadCeram", "DalleDeSol", { tileSize: "60*120" }),
  product("fai1", "Cotto Bianco", "Sétif Céram", "Faience"),
  product("fai2", "Mur Blanc brillant", "Sétif Céram", "Faience"),
  product("roc1", "Marbre Rosa", "Atlas", "Rock"),
  product("roc2", "Granit Noir", "Atlas", "Rock"),
  product("col1", "Colle Flex", "Weber", "CimentColle"),
  product("col2", "Ciment gris 50KG", "Lafarge", "CimentColle"),
  product("col3", "Sika Colle C2", "SikaCeram", "CimentColle"),
  product("evi1", "Évier inox 2 bacs", "Teka", "Evier"),
  product("par1", "Parquet chêne", "Pergo", "Parquet"),
  product("por1", "Porcelaine gris mat", "TimgadCeram", "Porcelain"),
  product("none1", "Plinthe blanche", "", ""),                       // no type at all
  product("joint-none", "Joint de dilatation", "", ""),              // "joint" in the name, no type
];
const CATALOGUE = [...JOINTS, ...OTHERS];

function load(products, language) {
  const app = loadApp();
  const { api } = app;
  api.applyData({
    products: products.map((p) => api.normalizeProduct(p)),
    invoices: [],
    settings: { ...api.DEFAULT_SETTINGS, language: language || "fr" },
    counter: 0,
    lastSaved: "",
  });
  return app;
}

const ids = (api, query) => api.findMatches(query).map((p) => p.id).sort();
const idsOf = (list) => list.map((p) => p.id).sort();
const ofType = (type) => idsOf(CATALOGUE.filter((p) => p.productType === type));

/* ---------- the reported bug ---------- */

test("\"joint\" lists the Capablanco AND the Sika products (the list is no longer cut after 8)", () => {
  const { api } = load(CATALOGUE);
  const found = ids(api, "joint");
  for (const id of ["cap2", "cap5", "sika-beige", "sika-blanc", "sika-brown", "sika-noir"]) assert.ok(found.includes(id), id + " is listed");
  // everything that has "joint" in its name or type: the 12 joint products and the one named "Joint de dilatation"
  assert.deepEqual(found, idsOf([...JOINTS, OTHERS.find((p) => p.id === "joint-none")]));
  assert.ok(found.length > 8, "more than the old limit of 8: " + found.length);
});

test("no matching product is ever left out, however many there are", () => {
  const many = Array.from({ length: 60 }, (_, i) => product("t" + i, "Tile " + i, "Brand", ""));
  const { api } = load(many);
  assert.equal(api.findMatches("tile").length, 60);
  assert.equal(api.findMatches("tile 5").length, 15, "every word must match: Tile 5, 15, 25, 35, 45 and Tile 50 … 59");
});

test("the best matches still come first: names that start with the text, then words that start with it", () => {
  const { api } = load(CATALOGUE);
  const names = api.findMatches("joint").map((p) => p.name);
  assert.equal(names[0], "Joint de dilatation", "the only name that starts with the text is first");
  const sika = names.indexOf("Sika 510 Joint Blanc");
  assert.ok(sika > 0 && sika < names.length, "and the Sika products are in the list, further down");
});

test("a word is not split at the letter x: a name that merely contains the text ranks below a word that starts with it", () => {
  const { api } = load([product("a", "Aaa Texture", "", ""), product("b", "Zzz Ture", "", "")]);
  assert.deepEqual(api.findMatches("ture").map((p) => p.id), ["b", "a"]);
});

/* ---------- the queries of the task ---------- */

test("sika → the Sika products; sika joint → only the Sika joint products", () => {
  const { api } = load(CATALOGUE);
  assert.deepEqual(ids(api, "sika"), ["sika-beige", "sika-blanc", "sika-brown", "sika-noir", "col3"].sort());
  assert.deepEqual(ids(api, "sika joint"), ["sika-beige", "sika-blanc", "sika-brown", "sika-noir"].sort(), "every word must match: Sika Colle has no joint");
  assert.deepEqual(ids(api, "joint sika"), ids(api, "sika joint"), "the order of the words does not matter");
});

test("pâte à joint → every product of that type, whatever its name or manufacturer; pate a joint gives the same list", () => {
  const { api } = load(CATALOGUE);
  const expected = ofType("PateAJoint");
  assert.equal(expected.length, JOINTS.length);
  for (const q of ["pâte à joint", "pate a joint", "PÂTE À JOINT", "  Pate   a  JOINT  ", "pâte à joint "]) {
    assert.deepEqual(ids(api, q), expected, JSON.stringify(q));
  }
  assert.ok(ids(api, "pate a joint").includes("kera"), "found by its type alone");
  assert.ok(!ids(api, "pate a joint").includes("joint-none"), "a product with joint in its name but another type is not a pâte à joint");
});

test("dalle de sol, faïence, pierre, évier, parquet, porcelaine → all products of that type", () => {
  const { api } = load(CATALOGUE);
  assert.deepEqual(ids(api, "dalle de sol"), ofType("DalleDeSol"));
  assert.deepEqual(ids(api, "faïence"), ofType("Faience"));
  assert.deepEqual(ids(api, "pierre"), ofType("Rock"));
  assert.deepEqual(ids(api, "évier"), ofType("Evier"));
  assert.deepEqual(ids(api, "parquet"), ofType("Parquet"));
  assert.deepEqual(ids(api, "porcelaine"), ofType("Porcelain"));
});

test("faience finds faïence, evier finds évier: accents and capital letters never matter", () => {
  const { api } = load(CATALOGUE);
  assert.deepEqual(ids(api, "faience"), ids(api, "faïence"));
  assert.deepEqual(ids(api, "FAIENCE"), ids(api, "faïence"));
  assert.deepEqual(ids(api, "FAÏENCE"), ids(api, "faience"));
  assert.deepEqual(ids(api, "evier"), ids(api, "Évier"));
  assert.deepEqual(ids(api, "setif ceram"), ids(api, "SÉTIF CÉRAM"));
  assert.deepEqual(ids(api, "setif ceram"), ["fai1", "fai2"]);
});

test("colle and ciment → the ciment-colle products (by type or by name)", () => {
  const { api } = load(CATALOGUE);
  assert.deepEqual(ids(api, "colle"), ofType("CimentColle"));
  assert.deepEqual(ids(api, "ciment"), ofType("CimentColle"));
  assert.deepEqual(ids(api, "ciment colle"), ofType("CimentColle"));
  assert.deepEqual(ids(api, "ciment-colle"), ofType("CimentColle"), "a hyphen is the same as a space");
});

test("type words, manufacturer and name combine: every word must be found somewhere", () => {
  const { api } = load(CATALOGUE);
  assert.deepEqual(ids(api, "mapei pate a joint"), ["kera", "map1", "map2"]);
  assert.deepEqual(ids(api, "weber colle"), ["col1"]);
  assert.deepEqual(ids(api, "dalle 60*120"), ["dal2"]);
  assert.deepEqual(ids(api, "dalle 60 x 60"), ["dal1"]);
  assert.deepEqual(ids(api, "dalle zzz"), []);
});

/* ---------- the type is found in every language ---------- */

test("a product type is found by its words in any language, whichever language the app shows", () => {
  for (const language of ["fr", "en", "ar"]) {
    const { api } = load(CATALOGUE, language);
    assert.deepEqual(ids(api, "pierre"), ofType("Rock"), language + ": pierre");
    assert.deepEqual(ids(api, "rock"), ofType("Rock"), language + ": rock");
    assert.deepEqual(ids(api, "pâte à joint"), ofType("PateAJoint"), language + ": pâte à joint");
    assert.deepEqual(ids(api, "faience"), ofType("Faience"), language + ": faience");
    assert.deepEqual(ids(api, "معجون الفواصل"), ofType("PateAJoint"), language + ": Arabic type name");
  }
});

/* ---------- older data ---------- */

test("an older product with no manufacturer, SKU, category or type is searched without the word \"undefined\"", () => {
  const { api } = load([]);
  // the raw shapes an older data file can hold, put straight into the list (no normalizing)
  api.getState().products.push(
    { id: "old1", name: "Old tile", sellingPrice: 50, stock: 3 },
    { id: "old2", name: "Older tile", manufacturer: null, sku: undefined, category: null, tileSize: "30*30", productType: "Daldosol", sellingPrice: 50, stock: 3 },
    { id: "old3", name: "Unknown type", productType: "SomethingNew", sellingPrice: 50, stock: 3 },
  );
  assert.equal(api.findMatches("undefined").length, 0);
  assert.equal(api.findMatches("null").length, 0);
  assert.equal(api.findMatches("def").length, 0, "no partial of a field that is not there");
  assert.deepEqual(ids(api, "old"), ["old1", "old2"]);
  assert.deepEqual(ids(api, "dalle de sol"), ["old2"], "the old spelling Daldosol is the type Dalle de sol");
  assert.deepEqual(ids(api, "30x30"), ["old2"]);
  assert.deepEqual(ids(api, "somethingnew"), ["old3"], "a type this version does not know is searched as written");
});

/* ---------- searching never changes anything ---------- */

test("searching changes no product, no name, no manufacturer, no type, and saves nothing", () => {
  const app = load(CATALOGUE);
  const { api } = app;
  const before = JSON.stringify(api.getProducts());
  const revision = api.getState().revision;
  for (const q of ["joint", "sika", "sika joint", "pâte à joint", "pate a joint", "dalle de sol", "faïence", "faience", "colle", "pierre", "", "   ", "zzz", "é", "—", "60*60"]) {
    api.findMatches(q);
    api.filterProducts(q);
  }
  api.renderResults();
  assert.equal(JSON.stringify(api.getProducts()), before);
  assert.equal(api.getState().revision, revision);
  assert.deepEqual(app.localStorage.writes, []);
  assert.equal(api.getProducts().find((p) => p.id === "kera").productType, "PateAJoint", "the stored type is still the code, not its label");
  assert.equal(api.getProducts().find((p) => p.id === "fai1").manufacturer, "Sétif Céram", "accents are kept in what is stored");
});

test("the Stock page filter shares the search: it finds the same products", () => {
  const { api } = load(CATALOGUE);
  assert.deepEqual(idsOf(api.filterProducts("sika joint")), ids(api, "sika joint"));
  assert.deepEqual(idsOf(api.filterProducts("pate a joint")), ofType("PateAJoint"));
  assert.equal(api.filterProducts("").length, CATALOGUE.length, "an empty filter lists everything");
});

/* ---------- the normalizing function ---------- */

test("normalizeSearchText: lower case, no accents, one space, tile sizes alike, no \"undefined\"", () => {
  const { api } = load([]);
  const n = api.normalizeSearchText;
  assert.equal(n("Pâte à joint"), "pate a joint");
  assert.equal(n("FAÏENCE"), "faience");
  assert.equal(n("Évier"), "evier");
  assert.equal(n("  très   chère  ê "), "tres chere e");
  assert.equal(n("Ciment-colle"), "ciment colle");
  assert.equal(n("a,b;c"), "a b c");
  for (const size of ["60*60", "60x60", "60X60", "60 x 60", "60 × 60", "60×60"]) assert.equal(n(size), "60x60", size);
  assert.equal(n("510 x 2 pièces"), "510x2 pieces");
  assert.equal(n(null), "");
  assert.equal(n(undefined), "");
  assert.equal(n(0), "0");
  assert.equal(n("معجون الفواصل"), "معجون الفواصل", "letters of other scripts are kept");
  const plain = (value) => JSON.parse(JSON.stringify(value));   // the app runs in its own context: compare plain data
  assert.deepEqual(plain(api.searchTerms("  Pâte à  JOINT ")), ["pate", "a", "joint"]);
  assert.deepEqual(plain(api.searchTerms("   ")), []);
  assert.deepEqual(plain(api.searchTerms("—")), []);
});

/* ---------- what the Sell page shows ---------- */

test("an empty search shows no list; no match shows the existing message; matches show name, price and stock", () => {
  const app = load(CATALOGUE);
  const { api } = app;
  const box = app.field("results");
  box.querySelector = () => null;   // the test page's stand-in element has no querySelector (the app only uses it to scroll the selected row into view)
  const search = app.field("search");

  search.value = "";
  api.renderResults();
  assert.equal(box.innerHTML, "", "nothing typed: the normal, empty state");
  search.value = "   ";
  api.renderResults();
  assert.equal(box.innerHTML, "");

  search.value = "zzzz";
  api.renderResults();
  assert.match(box.innerHTML, /class="empty"/, "the existing no-match message");
  assert.match(box.innerHTML, /zzzz/);
  assert.equal((box.innerHTML.match(/class="result"/g) || []).length, 0);

  search.value = "sika joint";
  api.renderResults();
  assert.equal((box.innerHTML.match(/class="result"/g) || []).length, 4, "the four Sika joint products");
  for (const name of ["Sika 510 Joint Beige 5KG", "Sika 510 Joint Blanc", "Sika 510 Joint brown", "Sika 510 Joint Noir"]) assert.ok(box.innerHTML.includes(name), name);
  assert.match(box.innerHTML, /class="price"/, "the selling price");
  assert.match(box.innerHTML, /class="stock/, "the available stock");

  search.value = "";
  api.renderResults();
  assert.equal(box.innerHTML, "", "emptying the search restores the normal state");
});

test("a product found by its type can be selected and added to a sale, and its stock and price stay as they were", () => {
  const app = load(CATALOGUE);
  const { api } = app;
  const first = api.findMatches("pate a joint").find((p) => p.id === "kera");
  assert.ok(first, "found by type");
  const stockBefore = first.stock;
  const priceBefore = first.sellingPrice;

  const added = api.addToSale(first.id, "2", "piece");
  assert.equal(added && added.error, undefined);
  const sale = api.getSale();
  assert.equal(sale.items.length, 1);
  assert.equal(sale.items[0].productId, "kera");
  assert.equal(sale.items[0].qty, 2);
  assert.equal(api.getProducts().find((p) => p.id === "kera").stock, stockBefore, "stock is only taken when the sale is completed");
  assert.equal(api.getProducts().find((p) => p.id === "kera").sellingPrice, priceBefore);
});

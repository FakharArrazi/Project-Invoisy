"use strict";

// Loads the app's plain scripts (i18n, language files, calc.js, validation.js, database.js) into this process and
// hands out disposable in-memory IndexedDB databases. Nothing here touches a real browser profile or real business data.
// Needs the fake-indexeddb package (a development-only dependency): run `npm install` once.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

let fake;
try {
  fake = require("fake-indexeddb");
} catch {
  throw new Error("The persistence tests need the fake-indexeddb package. Run `npm install` once, then try again.");
}

const scriptDir = path.join(__dirname, "..", "..", "java script");
for (const file of ["i18n.js", "lang/en.js", "lang/fr.js", "calc.js", "validation.js", "database.js"]) {
  vm.runInThisContext(fs.readFileSync(path.join(scriptDir, file), "utf8"), { filename: file });
}

const V = globalThis.Validation;
const DB = globalThis.InvoisyDB;

let serial = 0;

// A brand new, empty, isolated database (its own IndexedDB factory).
function newDb(overrides) {
  const factory = (overrides && overrides.indexedDB) || new fake.IDBFactory();
  return DB.create({ indexedDB: factory, channel: false, name: "invoisy-test-" + ++serial, ...overrides, indexedDB: factory });
}

const iso = (offsetMinutes) => new Date(Date.UTC(2026, 9, 1, 12, offsetMinutes || 0)).toISOString();

function sampleProduct(overrides) {
  return V.normalizeProduct({
    id: "p-" + ++serial,
    name: "Everton Grey",
    manufacturer: "Timgad Ceramic",
    tileSize: "60*120",
    coveragePerBox: 2.88,
    sku: "EV-" + serial,
    category: "Tiles",
    sellingPrice: 1000,
    priceUnit: "box",
    purchasePrice: 800,
    stock: 20,
    ...overrides,
  });
}

// A valid invoice: 2 boxes at 1,000 = 2,000, discount 100, tax 0, total 1,900, 500 paid so far.
function sampleInvoice(overrides) {
  const n = (overrides && overrides.number) || 1;
  const { number, ...rest } = overrides || {};
  return {
    id: "i-" + n,
    invoiceNumber: V.formatInvoiceNumber(n),
    date: iso(n),
    customer: { name: "Walk-in Customer", phone: "", address: "" },
    items: [{ productId: "p-1", name: "Everton Grey", manufacturer: "Timgad Ceramic", tileSize: "60*120", coveragePerBox: 2.88, sellingUnit: "box", sku: "EV-1", qty: 2, unitPrice: 1000, total: 2000, priceUnit: "box", productPrice: 1000 }],
    subtotal: 2000,
    discount: 100,
    tax: 0,
    total: 1900,
    payments: [{ amount: 500, timestamp: iso(n) }],
    discountPercent: null,
    taxPercent: null,
    currency: "DA",
    business: { name: "My Store", address: "", phone: "", email: "" },
    ...rest,
  };
}

// An object shaped like window.localStorage that records every write, so tests can prove nothing was changed.
function fakeLocalStorage(initial) {
  const values = new Map(Object.entries(initial || {}));
  return {
    values,
    calls: { set: [], remove: [] },
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { this.calls.set.push(key); values.set(key, String(value)); },
    removeItem(key) { this.calls.remove.push(key); values.delete(key); },
  };
}

// Everything the database holds, in the shape the tests compare.
async function dump(db) {
  const all = await db.loadAll();
  return JSON.parse(JSON.stringify({ products: all.products, invoices: all.invoices, settings: all.settings, counter: all.counter, revision: all.revision }));
}

// Makes the next `n`th call to IDBObjectStore.put fail the way a full disk does. Returns a function that restores it.
function failPutWith(errorName, onCall) {
  const proto = fake.IDBObjectStore.prototype;
  const original = proto.put;
  let calls = 0;
  proto.put = function (...args) {
    calls++;
    if (calls === onCall) throw new DOMException("simulated failure", errorName);
    return original.apply(this, args);
  };
  return () => { proto.put = original; };
}

module.exports = { fake, V, DB, newDb, iso, sampleProduct, sampleInvoice, fakeLocalStorage, dump, failPutWith };

"use strict";

/* ==========================================================================
   Simple Invoice - products, stock, sales and invoices in the browser.
   Data lives in a local invoisy-data.json file (with a browser copy as fallback).
   No backend, no dependencies.
   ========================================================================== */

/* ---------- Configuration ---------- */

const CURRENCY = "DA";            // default currency (can be changed in Settings)
// These two names are saved inside invoices exactly as written here, so the data file does not depend on the
// language. They are translated only when shown (see customerLabel and invoiceItemLabel).
const WALK_IN = "Walk-in Customer";
const DELETED_PRODUCT = "(deleted product)";
const LOW_STOCK = 5;              // stock at or below this shows "Low stock"
const LOGO_MAX_W = 320;           // stored logo size (shown at 160x100 max, 2x keeps it sharp)
const LOGO_MAX_H = 200;

const DEFAULT_SETTINGS = {
  businessName: "My Store",
  address: "",
  phone: "",
  email: "",
  currency: CURRENCY,
  logo: "",                         // store logo, stored as a PNG data URL
  paper: "A4",                      // invoice paper size: "A4" or "A5"
  language: "en",                   // language of the app and of invoices (a code registered in java script/lang/)
};

const DEMO_PRODUCTS = [
  { name: "Coca Cola 33cl", description: "330ml Coca Cola bottle", sku: "COCA33",   category: "Drinks", sellingPrice: 80,  priceUnit: "piece", stockUnit: "piece", purchasePrice: 60, stock: 50 },
  { name: "Chips",          description: "Salted potato chips",    sku: "CHIPS01",  category: "Snacks", sellingPrice: 120, priceUnit: "piece", stockUnit: "piece", purchasePrice: 90, stock: 24 },
  { name: "Water 1.5L",     description: "Bottled water 1.5L",     sku: "WATER15",  category: "Drinks", sellingPrice: 50,  priceUnit: "piece", stockUnit: "piece", purchasePrice: 35, stock: 40 },
  { name: "Coffee",         description: "Ground coffee, 250g",    sku: "COFFEE01", category: "Drinks", sellingPrice: 350, priceUnit: "piece", stockUnit: "piece", purchasePrice: 280, stock: 15 },
  { name: "Chocolate",      description: "Milk chocolate bar",     sku: "CHOC01",   category: "Snacks", sellingPrice: 100, priceUnit: "piece", stockUnit: "piece", purchasePrice: 70, stock: 30 },
  { name: "Demo Floor Tile", tileSize: "60*60", coveragePerBox: 1.44, sku: "TILE6060", category: "Tiles", sellingPrice: 800, priceUnit: "m2", stockUnit: "box", purchasePrice: 600, stock: 20 },
];

/* ---------- Helpers ---------- */

const $ = (id) => document.getElementById(id);
const t = (key, params) => I18n.t(key, params);                       // text in the current language
const tn = (key, count, params) => I18n.tn(key, count, params);      // text with a count (singular or plural)

// Numbers follow the language: 1,152.5 in English, 1 152,5 in French. French separates digit groups with a
// narrow no-break space; it is swapped for a regular no-break space, which more fonts and PDF printers draw correctly.
const numberFormatters = {};
const numberFormat = {
  format(n) {
    const locale = I18n.locale();
    const formatter = numberFormatters[locale] || (numberFormatters[locale] = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }));
    return formatter.format(n).replace(/\u202f/g, "\u00a0");
  },
};

// Money rounding and number cleaning live in calc.js, the one place for unit and price maths.
const round2 = Calc.roundMoney;
const toNumber = Calc.toNumber;

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function esc(value) {
  const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => map[c]);
}

function money(amount, currency) {
  return numberFormat.format(amount) + " " + (currency || state.settings.currency);
}

function formatDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return pad(d.getDate()) + "/" + pad(d.getMonth() + 1) + "/" + d.getFullYear();
}

function formatDateTime(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return formatDate(iso) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
}

function formatInvoiceNumber(n) {
  return "INV-" + String(n).padStart(6, "0");
}

let toastTimer = null;
function notify(message, type) {
  const toast = $("toast");
  toast.textContent = message;
  toast.className = "toast show" + (type === "error" ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = "toast"; }, type === "error" ? 8000 : 3500);
}

function showError(id, message) {
  $(id).textContent = message || "";
}

// A customer name as shown: no name, or the stored walk-in name, reads in the current language.
function customerLabel(name) {
  return !name || name === WALK_IN ? t("sell.walkIn") : name;
}

/* ---------- Data model ---------- */

const DATA_VERSION = 1;
const DATA_FILE_NAME = "invoisy-data.json";
const MIRROR_KEY = "invoisy-data";            // browser copy of the data file (fallback and recovery)
const LEGACY_KEYS = ["products", "invoices", "settings", "invoiceCounter"];
const DERIVED_INVOICE_FIELDS = ["amountPaid", "remaining", "status"];   // written to the file for readability only
// Units a line on a sale can be sold in. The unit belongs to the sale line, not to the product.
const SELLING_UNITS = Calc.UNITS;
// m² can be typed when adding to a sale, but it is converted to boxes and never stored on a sale line.
const SALE_LINE_UNITS = ["piece", "box", "kg", "m"];
// "Box", or "Boxes" when given a quantity other than 1, in the current language; "" for no/unknown unit.
const unitLabel = Calc.unitLabel;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string";
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isDate = (v) => isStr(v) && !isNaN(new Date(v));

function normalizeProduct(raw) {
  if (!raw || typeof raw !== "object" || !raw.name) return null;
  const price = Number(raw.sellingPrice);
  const priceUnit = Calc.normalizeUnit(raw.priceUnit);
  // What the stock quantity is counted in. null = an old product whose unit was never recorded:
  // its stock keeps being reduced one-for-one, as before.
  const stockUnit = Calc.inferStockUnit({ stockUnit: raw.stockUnit, priceUnit });
  // Stock may be fractional (3 pieces sold from a box-counted product), but only when the unit is known.
  const stock = stockUnit ? Number(raw.stock) : Math.floor(Number(raw.stock));
  const hasCost = raw.purchasePrice !== "" && raw.purchasePrice != null && Number.isFinite(Number(raw.purchasePrice)) && Number(raw.purchasePrice) >= 0;
  const coverage = Number(raw.coveragePerBox);
  return {
    id: String(raw.id || uid()),
    name: String(raw.name),
    manufacturer: String(raw.manufacturer || ""),
    // tileSize is the physical size of one tile. It is deliberately separate from box coverage.
    tileSize: String(raw.tileSize != null ? raw.tileSize : raw.dimensions || ""),
    coveragePerBox: Number.isFinite(coverage) && coverage > 0 ? coverage : null,
    description: String(raw.description || ""),
    sku: String(raw.sku || ""),
    category: String(raw.category || ""),
    sellingPrice: Number.isFinite(price) && price >= 0 ? price : 0,
    // What the selling price is per (piece, box, m2, kg, m). null = saved before this field existed.
    priceUnit,
    stockUnit,
    purchasePrice: hasCost ? Number(raw.purchasePrice) : null,
    stock: Number.isFinite(stock) && stock >= 0 ? Calc.cleanNumber(stock) : 0,
  };
}

// Accepts 60*120, 12*15, 60x120 or 60 × 120 (an old "cm" suffix is still accepted so saved data keeps loading).
// Stored in one format, in cm: "60*120". The parsing itself lives in calc.js.
const isTileSize = Calc.isTileSize;
const normalizeTileSize = Calc.normalizeTileSize;

// A display label is derived at render time; it is never the persisted product value.
function productLabel(product) {
  if (!product) return "";
  return [product.name, product.tileSize, product.manufacturer].filter(Boolean).join(" — ");
}

function productDetails(product) {
  if (!product) return "";
  const details = [];
  if (product.coveragePerBox != null) details.push(t("stock.coverageDetail", { n: numberFormat.format(product.coveragePerBox) }));
  return details.join(", ");
}

// "800 DA / m²". A product saved without a price unit shows just the amount.
function priceLabel(product) {
  const unit = Calc.unitLabel(product.priceUnit);
  return money(product.sellingPrice) + (unit ? ` / ${unit}` : "");
}

// "20 Boxes" (stock counted in boxes), or just "20" for an old product with no stock unit.
function stockText(product, amount = product.stock) {
  const unit = Calc.unitLabel(product.stockUnit, amount);
  return numberFormat.format(amount) + (unit ? ` ${unit}` : "");
}

// "20 Boxes (80 Pieces)": the stock also shown in pieces when it is counted in boxes.
function stockLabel(product) {
  const text = stockText(product);
  if (product.stockUnit !== "box") return text;
  const pieces = Calc.stockIn(product, "piece");
  return pieces.error ? text : `${text} (${stockText({ stockUnit: "piece" }, pieces.value)})`;
}

// "60*120" or "60 × 120 cm" -> "60 × 120"
function formatTileSize(size) {
  const m = String(size || "").match(/^\s*(\d+(?:[.,]\d+)?)\s*[*×x]\s*(\d+(?:[.,]\d+)?)/i);
  return m ? `${m[1]} × ${m[2]}` : String(size || "").trim();
}

// Invoice wording: golden era (60 × 120) garnada
function invoiceItemLabel(item) {
  const size = formatTileSize(item.tileSize);
  const name = item.name === DELETED_PRODUCT ? t("sell.deletedProduct") : item.name;
  return [name, size ? `(${size})` : "", item.manufacturer].filter(Boolean).join(" ");
}

// Invoices saved before payments existed are treated as fully paid at their sale date.
function normalizeInvoice(inv) {
  if (!inv || typeof inv !== "object" || !inv.invoiceNumber || !Array.isArray(inv.items)) return null;
  const clean = { ...inv };
  for (const key of DERIVED_INVOICE_FIELDS) delete clean[key];
  const amount = (value, fallback) => (value !== "" && value != null && Number.isFinite(Number(value)) ? Number(value) : fallback);
  const itemsTotal = round2(inv.items.reduce((sum, i) => sum + toNumber(i && i.qty) * toNumber(i && i.unitPrice), 0));
  clean.subtotal = amount(inv.subtotal, itemsTotal);
  clean.discount = amount(inv.discount, 0);
  clean.tax = amount(inv.tax, 0);
  clean.total = amount(inv.total, Math.max(0, round2(clean.subtotal - clean.discount + clean.tax)));

  let payments;
  if (Array.isArray(inv.payments)) {
    payments = inv.payments
      .filter((p) => p && Number.isFinite(Number(p.amount)) && Number(p.amount) > 0)
      .map((p) => ({ amount: round2(Number(p.amount)), timestamp: p.timestamp || inv.date }));
  } else {
    payments = clean.total > 0 ? [{ amount: clean.total, timestamp: inv.date }] : [];
  }
  return { ...clean, id: String(inv.id || uid()), payments };
}

function normalizeSettings(stored) {
  const settings = { ...DEFAULT_SETTINGS };
  if (stored && typeof stored === "object") {
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (typeof stored[key] === "string") settings[key] = stored[key];
    }
  }
  if (!settings.currency.trim()) settings.currency = CURRENCY;
  if (!settings.logo.startsWith("data:image/")) settings.logo = "";
  if (!["A4", "A5"].includes(settings.paper)) settings.paper = "A4";
  // An unknown language (for example from a newer data file) falls back to the default instead of blocking the file.
  if (!I18n.has(settings.language)) settings.language = DEFAULT_SETTINGS.language;
  return settings;
}

function invoiceSequence(invoiceNumber) {
  return parseInt(String(invoiceNumber).replace(/\D/g, ""), 10) || 0;
}

function highestInvoiceNumber(invoices) {
  return invoices.reduce((max, inv) => Math.max(max, invoiceSequence(inv.invoiceNumber)), 0);
}

/* ---------- Validation ---------- */

function productProblem(p) {
  if (!isObj(p)) return t("problem.notObject");
  if (!isStr(p.id) || !p.id) return t("problem.noId");
  if (!isStr(p.name) || !p.name.trim()) return t("problem.noName");
  if (p.manufacturer !== undefined && !isStr(p.manufacturer)) return t("problem.badManufacturer");
  if (p.tileSize !== undefined && (!isStr(p.tileSize) || (p.tileSize.trim() && !isTileSize(p.tileSize)))) return t("problem.badTileSize");
  if (p.coveragePerBox !== undefined && p.coveragePerBox !== null && (!isNum(p.coveragePerBox) || p.coveragePerBox <= 0)) return t("problem.badCoverage");
  if (!isNum(p.sellingPrice) || p.sellingPrice < 0) return t("problem.badPrice");
  if (p.priceUnit !== undefined && p.priceUnit !== null && !Calc.isUnit(p.priceUnit)) return t("problem.badPriceUnit");
  if (p.stockUnit !== undefined && p.stockUnit !== null && !Calc.isUnit(p.stockUnit)) return t("problem.badStockUnit");
  if (p.purchasePrice != null && (!isNum(p.purchasePrice) || p.purchasePrice < 0)) return t("problem.badCost");
  if (!isNum(p.stock) || p.stock < 0) return t("problem.badStock");
  return "";
}

const AMOUNT_PROBLEMS = { subtotal: "problem.badSubtotal", discount: "problem.badDiscount", tax: "problem.badTax", total: "problem.badTotal" };

function invoiceProblem(inv) {
  if (!isObj(inv)) return t("problem.notObject");
  if (!isStr(inv.id) || !inv.id) return t("problem.noId");
  if (!isStr(inv.invoiceNumber) || !/^INV-\d+$/.test(inv.invoiceNumber)) return t("problem.badNumber");
  if (!isDate(inv.date)) return t("problem.badDate");
  if (!Array.isArray(inv.items)) return t("problem.noItems");
  if (inv.items.some((i) => !isObj(i) || !isNum(i.qty) || i.qty <= 0 || !isNum(i.unitPrice) || i.unitPrice < 0 || (i.sellingUnit !== undefined && !SELLING_UNITS.includes(i.sellingUnit)))) return t("problem.badItem");
  for (const key of Object.keys(AMOUNT_PROBLEMS)) {
    if (!isNum(inv[key]) || inv[key] < 0) return t(AMOUNT_PROBLEMS[key]);
  }
  if (!Array.isArray(inv.payments)) return t("problem.noPayments");
  if (inv.payments.some((p) => !isObj(p) || !isNum(p.amount) || p.amount <= 0 || !isDate(p.timestamp))) return t("problem.badPayment");
  if (inv.customer != null && !isObj(inv.customer)) return t("problem.badCustomer");
  return "";
}

function settingsProblem(s) {
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (s[key] !== undefined && !isStr(s[key])) return t("problem.setting", { key });
  }
  if (s.paper !== undefined && !["A4", "A5"].includes(s.paper)) return t("problem.paper");
  if (s.logo && !s.logo.startsWith("data:image/")) return t("problem.logo");
  return "";
}

function collect(list, label, problemOf, normalize, lenient, problems) {
  const out = [];
  list.forEach((item, i) => {
    const candidate = lenient ? normalize(item) : item;
    const why = candidate ? problemOf(candidate) : t("problem.notValid");
    if (why) problems.push(t("problem.entry", { label, n: i + 1, why }));
    else out.push(lenient ? candidate : normalize(item));
  });
  return out;
}

function firstDuplicate(values) {
  const seen = new Set();
  for (const v of values) {
    if (seen.has(v)) return v;
    seen.add(v);
  }
  return null;
}

// Turns raw data (file, backup or old browser storage) into application data.
// Strict mode reports every bad entry; lenient mode (old browser data) leaves bad entries out and reports them.
function buildData(raw, lenient) {
  if (!isObj(raw)) return { error: t("data.notObject") };
  if (!Array.isArray(raw.products)) return { error: t("data.noProducts") };
  if (!Array.isArray(raw.invoices)) return { error: t("data.noInvoices") };
  if (!isObj(raw.settings)) return { error: t("data.noSettings") };
  if (!lenient) {
    if (!Number.isInteger(raw.version) || raw.version < 1) return { error: t("data.noVersion") };
    if (raw.version > DATA_VERSION) return { error: t("data.newerVersion", { version: raw.version }) };
    if (!Number.isInteger(raw.invoiceCounter) || raw.invoiceCounter < 0) return { error: t("data.badCounter") };
    const settingsIssue = settingsProblem(raw.settings);
    if (settingsIssue) return { error: settingsIssue };
  }

  const problems = [];
  const products = collect(raw.products, t("problem.label.product"), productProblem, normalizeProduct, lenient, problems);
  const invoices = collect(raw.invoices, t("problem.label.invoice"), invoiceProblem, normalizeInvoice, lenient, problems);

  const dupProduct = firstDuplicate(products.map((p) => p.id));
  if (dupProduct) return { error: t("data.dupProduct", { id: dupProduct }) };
  const dupInvoice = firstDuplicate(invoices.map((i) => i.id));
  if (dupInvoice) return { error: t("data.dupInvoice", { id: dupInvoice }) };
  const dupNumber = firstDuplicate(invoices.map((i) => i.invoiceNumber));
  if (dupNumber) return { error: t("data.dupNumber", { number: dupNumber }) };

  const stored = Math.max(0, Math.floor(toNumber(raw.invoiceCounter)));
  const highest = highestInvoiceNumber(invoices);
  return {
    problems,
    data: {
      products,
      invoices,
      settings: normalizeSettings(raw.settings),
      counter: Math.max(stored, highest),
      counterRecovered: highest > stored,
      lastSaved: isStr(raw.lastSaved) ? raw.lastSaved : "",
    },
  };
}

function validatePersistentData(data) {
  const built = buildData(data, false);
  if (built.error) return [built.error];
  const problems = [...built.problems];
  if (built.data.counterRecovered) problems.push(t("data.counterLow"));
  return problems;
}

function parseDataText(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: t("data.notJson") };
  }
  const built = buildData(raw, false);
  if (built.error) return { error: built.error };
  if (built.problems.length) {
    const more = built.problems.length > 3 ? t("data.andMore", { n: built.problems.length - 3 }) : "";
    return { error: built.problems.slice(0, 3).join(" ") + more };
  }
  return { data: built.data };
}

/* ---------- State ---------- */

function newSale() {
  return {
    items: [],                              // { lineId, productId, qty, sellingUnit, unitPrice }
    customer: { name: "", phone: "", address: "" },
    discountType: "amount", discountValue: "",
    taxType: "amount", taxValue: "",
    paidValue: "",                          // amount paid now; empty = paid in full
  };
}

const state = {
  products: [],
  invoices: [],
  settings: { ...DEFAULT_SETTINGS },
  counter: 0,
  lastSaved: "",          // time stamp of the data in memory (matches the data file when connected)
  view: "sell",
  sale: newSale(),
  results: [],            // products currently listed in the picker
  selectedId: null,       // product selected in the picker
  previewInvoice: null,   // saved invoice shown in the preview (null = live sale)
  editingId: null,        // product being edited in the Stock form
  addUnitFor: null,       // product the Sell page unit list was last set up for
};

function applyData(d) {
  state.products = d.products;
  state.invoices = d.invoices;
  state.settings = d.settings;
  state.counter = d.counter;
  state.lastSaved = d.lastSaved || "";
  I18n.setLanguage(state.settings.language);
  if (state.previewInvoice) state.previewInvoice = state.invoices.find((i) => i.id === state.previewInvoice.id) || null;
}

function draftFromState() {
  return structuredClone({ products: state.products, invoices: state.invoices, settings: state.settings, counter: state.counter });
}

/* ---------- Persistence: one master data file ----------
   invoisy-data.json is the source of truth. Every change is built on a copy of the data (a draft),
   validated, written to the file and read back. Only then does the draft become the live state.
   A copy is also kept in localStorage (MIRROR_KEY) as a fallback and recovery copy. */

const FS_SUPPORTED = typeof window.showOpenFilePicker === "function" && typeof window.showSaveFilePicker === "function";
const FILE_TYPES = [{ description: "Invoisy data", accept: { "application/json": [".json"] } }];

const msgPermission = () => t("storage.permission");
const msgMissing = () => t("storage.missing");

const storage = {
  supported: FS_SUPPORTED,
  mode: FS_SUPPORTED ? "connecting" : "unlinked",   // connecting | connected | unlinked | disconnected
  reason: "",                                       // why the file is disconnected
  handle: null,
  fileName: "",
  mirrorOk: true,
  ready: Promise.resolve(),
};

function defaultData() {
  return { products: [], invoices: [], settings: { ...DEFAULT_SETTINGS }, counter: 0, lastSaved: "" };
}

function nextStamp() {
  let t = Date.now();
  const previous = Date.parse(state.lastSaved);
  if (previous >= t) t = previous + 1;
  return new Date(t).toISOString();
}

function serializeState(d, lastSaved) {
  return {
    version: DATA_VERSION,
    lastSaved,
    products: d.products,
    invoices: d.invoices.map((inv) => {
      const pay = paymentInfo(inv);
      return { ...inv, amountPaid: pay.paid, remaining: pay.remaining, status: pay.cls };
    }),
    settings: d.settings,
    invoiceCounter: d.counter,
  };
}

// Serializes and validates the data. Nothing that fails here is ever written.
function buildPayload(d, lastSaved) {
  let text;
  try {
    text = JSON.stringify(serializeState(d, lastSaved), null, 2);
  } catch {
    return { error: t("storage.jsonFailed") };
  }
  const problems = validatePersistentData(JSON.parse(text));
  if (problems.length) return { error: t("storage.safetyFailed", { problem: problems[0] }) };
  return { text, lastSaved };
}

function writeMirror(text) {
  try {
    localStorage.setItem(MIRROR_KEY, text);
    return true;
  } catch {
    return false;
  }
}

function readMirror() {
  let text;
  try {
    text = localStorage.getItem(MIRROR_KEY);
  } catch {
    return {};
  }
  if (text === null) return {};
  const parsed = parseDataText(text);
  return parsed.error ? { error: parsed.error } : { data: parsed.data };
}

// Reads the pre-update localStorage keys. They are never modified or deleted.
function migrateLegacyStorage() {
  const parts = {};
  const problems = [];
  let found = false;
  for (const key of LEGACY_KEYS) {
    let raw;
    try {
      raw = localStorage.getItem(key);
    } catch {
      raw = null;
    }
    if (raw === null) continue;
    found = true;
    try {
      parts[key] = JSON.parse(raw);
    } catch {
      problems.push(`Saved ${key} could not be read.`);
    }
  }
  if (!found) return null;
  const built = buildData({
    products: Array.isArray(parts.products) ? parts.products : [],
    invoices: Array.isArray(parts.invoices) ? parts.invoices : [],
    settings: isObj(parts.settings) ? parts.settings : {},
    invoiceCounter: parts.invoiceCounter,
  }, true);
  if (built.error) return { data: defaultData(), problems: [built.error] };
  return { data: built.data, problems: [...problems, ...built.problems] };
}

// Starts from the browser copy, or migrates the old localStorage data, or starts empty.
function loadLocalCopy() {
  const notices = [];
  const mirror = readMirror();
  if (mirror.data) {
    applyData(mirror.data);
    return notices;
  }
  if (mirror.error) notices.push(t("storage.mirrorUnreadable"));

  const legacy = migrateLegacyStorage();
  if (!legacy) {
    applyData(defaultData());
    return notices;
  }
  applyData(legacy.data);
  const built = buildPayload(draftFromState(), nextStamp());
  if (!built.error && writeMirror(built.text)) state.lastSaved = built.lastSaved;
  else notices.push(t("storage.migrateFailed"));
  if (legacy.problems.length) {
    notices.push(t("storage.entriesSkipped", { n: legacy.problems.length }));
  }
  return notices;
}

/* -- File handle memory (IndexedDB) -- */

function handleStore(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("invoisy", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("kv");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction("kv", mode);
      const req = fn(tx.objectStore("kv"));
      tx.oncomplete = () => { open.result.close(); resolve(req.result); };
      tx.onerror = tx.onabort = () => reject(tx.error);
    };
  });
}

const loadHandle = () => handleStore("readonly", (s) => s.get("dataFile"));
const storeHandle = (handle) => handleStore("readwrite", (s) => s.put(handle, "dataFile"));

/* -- Writing the data file -- */

function errorText(e) {
  return (e && e.message) || "";
}

function setStorageMode(mode, reason) {
  storage.mode = mode;
  storage.reason = reason || "";
  renderStorage();
}

function canWrite() {
  return storage.mode === "connected" || storage.mode === "unlinked";
}

function blockedMessage() {
  const why = storage.mode === "disconnected" ? storage.reason : t("storage.notReady");
  return t("storage.blocked", { reason: why });
}

function describeFileError(e, active) {
  if (e && e.name === "NotFoundError") {
    if (active) setStorageMode("disconnected", msgMissing());
    return t("storage.nothingSaved", { reason: msgMissing() });
  }
  if (e && e.name === "NotAllowedError") {
    if (active) setStorageMode("disconnected", msgPermission());
    return t("storage.nothingSaved", { reason: msgPermission() });
  }
  return t("storage.writeFailed", { error: errorText(e) });
}

// Before writing, make sure nobody else changed the file since Invoisy last read or wrote it.
async function checkUnchanged(handle, expectedStamp) {
  const current = await (await handle.getFile()).text();
  if (!current.trim()) {
    setStorageMode("disconnected", t("storage.empty"));
    return { error: t("storage.emptyNotOverwritten") };
  }
  const parsed = parseDataText(current);
  if (parsed.error) {
    const reason = t("storage.unreadable", { error: parsed.error });
    setStorageMode("disconnected", reason);
    return { error: reason };
  }
  if (parsed.data.lastSaved === expectedStamp) return null;
  applyData(parsed.data);
  storage.mirrorOk = writeMirror(current);
  refreshAfterLoad();
  return { error: t("storage.changedElsewhere") };
}

// expectedStamp: the lastSaved the file must still have (null skips the check, for a brand new file).
async function writeToDataFile(handle, text, expectedStamp, active) {
  try {
    if ((await handle.queryPermission({ mode: "readwrite" })) !== "granted") {
      if (active) setStorageMode("disconnected", msgPermission());
      return { error: t("storage.nothingSaved", { reason: msgPermission() }) };
    }
    if (expectedStamp !== null) {
      const changed = await checkUnchanged(handle, expectedStamp);
      if (changed) return changed;
    }
    const writable = await handle.createWritable();
    try {
      await writable.write(text);
      await writable.close();
    } catch (e) {
      try { await writable.abort(); } catch { /* already closed */ }
      throw e;
    }
    if ((await (await handle.getFile()).text()) !== text) {
      return { error: t("storage.verifyFailed") };
    }
    return {};
  } catch (e) {
    return { error: describeFileError(e, active) };
  }
}

async function persistData(draft) {
  const built = buildPayload(draft, nextStamp());
  if (built.error) return { error: built.error };

  if (storage.mode === "connected") {
    const written = await writeToDataFile(storage.handle, built.text, state.lastSaved, true);
    if (written.error) return written;
    storage.mirrorOk = writeMirror(built.text);
    return { lastSaved: built.lastSaved, toFile: true };
  }
  if (!writeMirror(built.text)) {
    storage.mirrorOk = false;
    return { error: t("storage.browserSaveFailed") };
  }
  storage.mirrorOk = true;
  return { lastSaved: built.lastSaved, toFile: false };
}

/* -- Transactions: every change goes through enqueue() and commit() -- */

let queue = Promise.resolve();
function enqueue(task) {
  const run = async () => {
    await storage.ready;
    return task();
  };
  const result = queue.then(run, run);
  queue = result.catch(() => {});
  return result;
}

// mutate(draft) edits a copy of the data and returns { error } to cancel, { skip: true } for "nothing to do",
// or any extra result fields. The live state only changes after the data was saved successfully.
function commit(mutate) {
  return enqueue(async () => {
    if (!canWrite()) return { error: blockedMessage() };
    const draft = draftFromState();
    let result;
    try {
      result = mutate(draft) || {};
    } catch (e) {
      return { error: t("app.somethingWrongNotSaved", { error: errorText(e) }) };
    }
    if (result.error || result.skip) return result;
    const saved = await persistData(draft);
    if (saved.error) return { error: saved.error };
    applyData({ ...draft, lastSaved: saved.lastSaved });
    renderStorage();
    return { ...result, toFile: saved.toFile };
  });
}

let busy = false;
async function guard(task) {
  if (busy) return;
  busy = true;
  try {
    await task();
  } catch (e) {
    notify(t("app.somethingWrong", { error: errorText(e) }), "error");
  } finally {
    busy = false;
  }
}

function savedNote(result) {
  return result.toFile ? "" : t("storage.savedBrowserOnly");
}

/* -- Connecting a data file -- */

function describeData(d) {
  return `${tn("storage.countProducts", d.products.length)}, ${tn("storage.countInvoices", d.invoices.length)}`;
}

function reportFileProblem(message) {
  showError("dataError", message);
  notify(message, "error");
  return false;
}

async function startNewFile(handle) {
  const built = buildPayload(draftFromState(), nextStamp());
  if (built.error) return reportFileProblem(built.error);
  const written = await writeToDataFile(handle, built.text, null, false);
  if (written.error) return reportFileProblem(written.error);

  state.lastSaved = built.lastSaved;
  storage.mirrorOk = writeMirror(built.text);
  storage.handle = handle;
  storage.fileName = handle.name;
  let remembered = true;
  try { await storeHandle(handle); } catch { remembered = false; }
  showError("dataError", "");
  setStorageMode("connected");
  notify(remembered
    ? t("storage.fileSaved", { file: handle.name })
    : t("storage.fileSavedNoMemory", { file: handle.name }));
  return true;
}

// chosen = the person just picked this file (otherwise it is the remembered file being reopened).
async function connectHandle(handle, chosen) {
  const fail = (message) => (chosen ? reportFileProblem(message) : (setStorageMode("disconnected", message), false));

  let text;
  try {
    text = await (await handle.getFile()).text();
  } catch (e) {
    return fail(e && e.name === "NotFoundError" ? msgMissing() : t("storage.cannotOpen", { error: errorText(e) }));
  }
  if (!text.trim()) {
    if (chosen) return startNewFile(handle);
    return fail(t("storage.emptyReconnect"));
  }
  const parsed = parseDataText(text);
  if (parsed.error) {
    return fail(t("storage.unreadable", { error: parsed.error }));
  }

  const incoming = parsed.data;
  const hasLocal = state.products.length > 0 || state.invoices.length > 0;
  const sameVersion = incoming.lastSaved !== "" && incoming.lastSaved === state.lastSaved;
  const browserNewer = Date.parse(state.lastSaved) > Date.parse(incoming.lastSaved);
  if (hasLocal && !sameVersion && (chosen || browserNewer)) {
    const lead = chosen
      ? t("storage.confirmLoadChosen", { file: handle.name })
      : t("storage.confirmLoadOlder", { file: handle.name });
    const saved = (iso) => formatDateTime(iso) || t("storage.unknown");
    const ok = confirm(t("storage.confirmLoadBody", {
      lead,
      file: describeData(incoming), fileSaved: saved(incoming.lastSaved),
      browser: describeData(state), browserSaved: saved(state.lastSaved),
    }));
    if (!ok) {
      if (!chosen) setStorageMode("disconnected", t("storage.olderNotLoaded"));
      return false;
    }
  }

  applyData(incoming);
  storage.mirrorOk = writeMirror(text);
  storage.handle = handle;
  storage.fileName = handle.name;
  let remembered = true;
  if (chosen) {
    try { await storeHandle(handle); } catch { remembered = false; }
  }
  showError("dataError", "");
  setStorageMode("connected");
  refreshAfterLoad();
  const notes = [];
  if (chosen) notes.push(t("storage.loadedFrom", { file: handle.name }));
  if (!remembered) notes.push(t("storage.cannotRemember"));
  if (incoming.counterRecovered) notes.push(t("storage.counterFixed"));
  if (notes.length) notify(notes.join(" "), remembered ? undefined : "error");
  return true;
}

async function pickDataFile(create) {
  if (!storage.supported) return;
  let handle;
  try {
    if (create) handle = await window.showSaveFilePicker({ suggestedName: DATA_FILE_NAME, types: FILE_TYPES });
    else [handle] = await window.showOpenFilePicker({ types: FILE_TYPES, multiple: false });
    if ((await handle.requestPermission({ mode: "readwrite" })) !== "granted") {
      reportFileProblem(t("storage.notGranted"));
      return;
    }
  } catch (e) {
    if (!e || e.name !== "AbortError") reportFileProblem(t("storage.cannotOpen", { error: errorText(e) }));
    return;
  }
  await enqueue(() => connectHandle(handle, true));
}

async function reconnect() {
  const handle = storage.handle;
  if (!handle) return pickDataFile(false);
  try {
    if ((await handle.requestPermission({ mode: "readwrite" })) !== "granted") {
      notify(t("storage.notGranted"), "error");
      return;
    }
  } catch (e) {
    notify(t("storage.cannotReopen", { error: errorText(e) }), "error");
    return;
  }
  await enqueue(() => connectHandle(handle, false));
}

async function initStorage(notices) {
  if (storage.supported) {
    let handle = null;
    try { handle = await loadHandle(); } catch { handle = null; }
    if (handle) {
      storage.handle = handle;
      storage.fileName = handle.name;
      let granted = false;
      try { granted = (await handle.queryPermission({ mode: "readwrite" })) === "granted"; } catch { granted = false; }
      if (granted) await connectHandle(handle, false);
      else setStorageMode("disconnected", t("storage.needPermission"));
    } else {
      setStorageMode("unlinked");
    }
  } else {
    setStorageMode("unlinked");
  }
  if (notices.length) notify(notices.join(" "), "error");
}

function saveNow() {
  return guard(async () => {
    const r = await commit(() => ({}));
    if (r.error) return reportFileProblem(r.error);
    showError("dataError", "");
    notify(t("storage.savedTo", { file: storage.fileName }));
  });
}

function exportBackup() {
  const built = buildPayload(draftFromState(), state.lastSaved || new Date().toISOString());
  if (built.error) { reportFileProblem(built.error); return; }
  const pad = (n) => String(n).padStart(2, "0");
  const now = new Date();
  const name = `invoisy-backup-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.json`;
  const url = URL.createObjectURL(new Blob([built.text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showError("dataError", "");
  notify(t("storage.backupExported", { name }));
}

function importBackup(file) {
  return guard(async () => {
    showError("dataError", "");
    if (!file) return;
    let text;
    try {
      text = await file.text();
    } catch {
      reportFileProblem(t("storage.fileUnreadable"));
      return;
    }
    const parsed = parseDataText(text);
    if (parsed.error) {
      reportFileProblem(t("storage.badBackup", { error: parsed.error }));
      return;
    }
    if (!canWrite()) { reportFileProblem(blockedMessage()); return; }
    const incoming = parsed.data;
    const saved = formatDateTime(incoming.lastSaved) || t("storage.unknown");
    if (!confirm(t("storage.confirmImport", { backup: describeData(incoming), saved, current: describeData(state) }))) return;

    // The invoice counter never goes backwards, so numbers already issued are not reused.
    const r = await commit((d) => {
      d.products = incoming.products;
      d.invoices = incoming.invoices;
      d.settings = incoming.settings;
      d.counter = Math.max(d.counter, incoming.counter);
    });
    if (r.error) { reportFileProblem(r.error); return; }
    refreshAfterLoad();
    notify(t("storage.backupImported") + savedNote(r));
  });
}

/* ==========================================================================
   PRODUCTS
   ========================================================================== */

function findProduct(id, data = state) {
  return data.products.find((p) => p.id === id);
}

function searchProducts(query) {
  const terms = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  return state.products
    .filter((p) => {
      const haystack = (p.name + " " + p.manufacturer + " " + p.tileSize + " " + p.sku + " " + p.category).toLowerCase();
      return terms.every((t) => haystack.includes(t));
    })
    .sort((a, b) => productLabel(a).localeCompare(productLabel(b)));
}

// Sell page search: nothing is listed until the user types. Best matches first:
// names that start with the text, then names with a word that starts with it, then the rest.
const MAX_SEARCH_RESULTS = 8;

function findMatches(query) {
  const terms = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const rank = (p) => {
    const name = p.name.toLowerCase();
    return terms.reduce((sum, t) => {
      if (name.startsWith(t)) return sum;
      if (name.split(/[\s\-—*×x]+/).some((w) => w.startsWith(t))) return sum + 1;
      return sum + 2;
    }, 0);
  };
  return searchProducts(query)
    .map((p) => ({ p, score: rank(p) }))
    .sort((a, b) => a.score - b.score)   // stable: ties stay alphabetical
    .slice(0, MAX_SEARCH_RESULTS)
    .map((m) => m.p);
}

function readProductForm() {
  const get = (id) => $(id).value.trim();
  const fail = (field, error) => ({ field, error });

  const name = get("pName");
  if (!name) return fail("pName", t("product.nameRequired"));
  const tileSizeRaw = get("pTileSize");
  if (tileSizeRaw && !isTileSize(tileSizeRaw)) return fail("pTileSize", t("product.tileSizeFormat"));
  const tileSize = tileSizeRaw ? normalizeTileSize(tileSizeRaw) : "";
  const coverageRaw = get("pCoveragePerBox");
  const coveragePerBox = Number(coverageRaw);
  if (coverageRaw !== "" && (!Number.isFinite(coveragePerBox) || coveragePerBox <= 0)) {
    return fail("pCoveragePerBox", t("product.coverageGreater"));
  }

  const priceRaw = get("pPrice");
  const price = Number(priceRaw);
  if (priceRaw === "" || !Number.isFinite(price)) return fail("pPrice", t("product.priceRequired"));
  if (price < 0) return fail("pPrice", t("product.priceNegative"));

  const priceUnit = get("pPriceUnit");
  if (!Calc.isUnit(priceUnit)) return fail("pPriceUnit", t("product.chooseUnit"));
  if (priceUnit === "m2" && coverageRaw === "") {
    return fail("pCoveragePerBox", t("product.coverageNeeded"));
  }

  const costRaw = get("pCost");
  const cost = Number(costRaw);
  if (costRaw !== "" && (!Number.isFinite(cost) || cost < 0)) return fail("pCost", t("product.costNegative"));

  const stockUnit = get("pStockUnit");
  if (!Calc.isUnit(stockUnit)) return fail("pStockUnit", t("product.chooseStockUnit"));
  if (Calc.unitFamily(stockUnit) !== Calc.unitFamily(Calc.defaultStockUnit(priceUnit))) {
    return fail("pStockUnit", t("product.stockUnitMismatch", { stock: t("stockunit." + stockUnit), price: t("price." + priceUnit) }));
  }

  const stockRaw = get("pStock");
  const stock = stockRaw === "" ? 0 : Number(stockRaw);
  if (!Number.isFinite(stock) || stock < 0 || (Calc.isWholeUnit(stockUnit) && !Number.isInteger(stock))) {
    return fail("pStock", t(Calc.isWholeUnit(stockUnit) ? "product.stockWhole" : "product.stockNumber"));
  }

  const sku = get("pSku");
  if (sku) {
    const clash = state.products.find((p) => p.id !== state.editingId && p.sku.toLowerCase() === sku.toLowerCase());
    if (clash) return fail("pSku", t("product.skuUsed", { sku, name: clash.name }));
  }

  return {
    values: {
      name,
      manufacturer: get("pManufacturer"),
      tileSize,
      coveragePerBox: coverageRaw === "" ? null : coveragePerBox,
      description: get("pDesc"),
      sku,
      category: get("pCategory"),
      sellingPrice: price,
      priceUnit,
      stockUnit,
      purchasePrice: costRaw === "" ? null : cost,
      stock,
    },
  };
}

async function addProduct(values) {
  const r = await commit((d) => { d.products.push({ id: uid(), ...values }); });
  if (r.error) {
    showError("productError", r.error);
    notify(r.error, "error");
    return;
  }
  resetProductForm();
  renderAll();
  notify(t("product.added", { label: productLabel(values) }) + savedNote(r));
  $("pName").focus();
}

async function updateProduct(id, values) {
  const r = await commit((d) => {
    const product = findProduct(id, d);
    if (!product) return { error: t("product.gone") };
    Object.assign(product, values);
  });
  if (r.error) {
    showError("productError", r.error);
    notify(r.error, "error");
    return;
  }
  resetProductForm();
  renderAll();
  notify(t("product.updated", { label: productLabel(values) }) + savedNote(r));
}

async function deleteProduct(id) {
  const product = findProduct(id);
  if (!product) return;
  if (!confirm(t("product.confirmDelete", { name: product.name }))) return;
  const r = await commit((d) => { d.products = d.products.filter((p) => p.id !== id); });
  if (r.error) { notify(r.error, "error"); return; }
  state.sale.items = state.sale.items.filter((i) => i.productId !== id);
  if (state.selectedId === id) state.selectedId = null;
  if (state.editingId === id) resetProductForm();
  renderAll();
  notify(t("product.deleted", { name: product.name }) + savedNote(r));
}

async function adjustStock(id, delta) {
  const r = await commit((d) => {
    const product = findProduct(id, d);
    if (!product) return { skip: true };
    product.stock = Math.max(0, Calc.cleanNumber(product.stock + delta));
  });
  if (r.error) { notify(r.error, "error"); return; }
  renderStock();
  renderResults();
  renderSelected();
}

async function addStock(id, rawQty) {
  if (!findProduct(id)) return { error: t("product.selectFirst") };
  const stockUnit = findProduct(id).stockUnit;
  const checked = Calc.validateQuantity(rawQty, stockUnit);
  if (checked.error) return { error: t(Calc.isWholeUnit(stockUnit) ? "restock.qtyWhole" : "restock.qtyPositive") };
  const qty = checked.value;
  return commit((d) => {
    const product = findProduct(id, d);
    if (!product) return { error: t("product.gone") };
    const before = product.stock;
    product.stock = Calc.cleanNumber(before + qty);
    return { message: `${product.name}: ${numberFormat.format(before)} + ${numberFormat.format(qty)} = ${stockText(product)}` };
  });
}

function startEditProduct(id) {
  const p = findProduct(id);
  if (!p) return;
  state.editingId = id;
  $("pName").value = p.name;
  $("pManufacturer").value = p.manufacturer;
  $("pTileSize").value = p.tileSize;
  $("pCoveragePerBox").value = p.coveragePerBox == null ? "" : p.coveragePerBox;
  $("pDesc").value = p.description;
  $("pPrice").value = p.sellingPrice;
  $("pPriceUnit").value = p.priceUnit || "";   // empty for products saved before price units
  $("pCost").value = p.purchasePrice == null ? "" : p.purchasePrice;
  $("pStock").value = p.stock;
  $("pStockUnit").value = p.stockUnit || "";   // empty for products saved before stock units
  $("pStockUnit").dataset.touched = "1";       // an edit never changes the unit on its own
  $("pSku").value = p.sku;
  $("pCategory").value = p.category;
  renderProductFormMode();
  clearProductErrors();
  $("pName").focus();
}

function resetProductForm() {
  state.editingId = null;
  $("productForm").reset();
  $("pStock").value = 0;
  delete $("pStockUnit").dataset.touched;
  renderProductFormMode();
  clearProductErrors();
}

// The Stock form's title and buttons depend on whether a product is being edited.
function renderProductFormMode() {
  const editing = Boolean(state.editingId);
  $("productFormTitle").textContent = t(editing ? "stock.editProduct" : "stock.addProduct");
  $("productSubmit").textContent = t(editing ? "stock.saveChanges" : "stock.addProductBtn");
  $("productCancel").hidden = !editing;
}

function clearProductErrors() {
  showError("productError", "");
  $("productForm").querySelectorAll("[aria-invalid]").forEach((el) => el.removeAttribute("aria-invalid"));
}

// Demo products are saved in the language that is active when they are loaded.
function localizedDemo(demo) {
  const pick = (key, fallback) => {
    const text = t(key);
    return text === key ? fallback : text;
  };
  const id = "demo." + demo.sku;
  return {
    ...demo,
    name: pick(id + ".name", demo.name),
    ...(demo.description ? { description: pick(id + ".description", demo.description) } : {}),
    category: pick("demo.cat." + demo.category.toLowerCase(), demo.category),
  };
}

function loadDemoData() {
  return guard(async () => {
    const r = await commit((d) => {
      const have = new Set(d.products.map((p) => p.sku.toLowerCase()).filter(Boolean));
      let added = 0;
      for (const demo of DEMO_PRODUCTS) {
        if (have.has(demo.sku.toLowerCase())) continue;
        d.products.push(normalizeProduct({ id: uid(), ...localizedDemo(demo) }));
        added++;
      }
      return added ? { added } : { skip: true };
    });
    if (r.error) { notify(r.error, "error"); return; }
    if (r.skip) { notify(t("demo.already")); return; }
    renderAll();
    notify(tn("demo.added", r.added) + savedNote(r));
  });
}

/* ==========================================================================
   CURRENT SALE
   ========================================================================== */

// A sale line is one product in one unit, so the same product can appear on several lines
// (for example 5 boxes and 2 pieces). Lines are found by lineId.
function findSaleItem(lineId) {
  return state.sale.items.find((i) => i.lineId === lineId);
}

// Stock a product's lines take, in the product's own stock unit (2 boxes = 8 pieces of a piece-counted product).
// Lines in `exceptLineIds` are left out, so one line can be checked against all the others.
function stockUsedInSale(productId, exceptLineIds = [], sale = state.sale, data = state) {
  const product = findProduct(productId, data);
  if (!product) return 0;
  let used = 0;
  for (const i of sale.items) {
    if (i.productId !== productId || exceptLineIds.includes(i.lineId)) continue;
    const d = Calc.stockDeduction(product, i.qty, i.sellingUnit);
    if (!d.error) used += d.value;
  }
  return Calc.cleanNumber(used);
}

// Stock needed per product for these sale lines, in each product's stock unit.
// errors lists lines that can't be converted (for example a tile size removed after the line was added).
function stockNeeds(items, data = state) {
  const totals = new Map();
  const errors = [];
  for (const item of items) {
    const p = findProduct(item.productId, data);
    if (!p) continue;
    const d = Calc.stockDeduction(p, item.qty, item.sellingUnit);
    if (d.error) errors.push(d.error);
    else totals.set(p.id, Calc.cleanNumber((totals.get(p.id) || 0) + d.value));
  }
  return { totals, errors: [...new Set(errors)] };
}

function stockMessage(product, inSale) {
  return t("sale.stockLow", { available: stockText(product) }) + (inSale ? t("sale.stockInSale", { n: stockText(product, inSale) }) : "");
}

// Largest quantity of `unit` that fits in `remaining` stock (in the product's stock unit).
// Whole units round down (at least 1, so the line stays visible and checkout reports the shortage).
function fitQuantity(product, unit, remaining) {
  const whole = Calc.isWholeUnit(unit);
  const c = Calc.isUnit(product.stockUnit) ? Calc.convertQuantity(remaining, product.stockUnit, unit, product) : { value: remaining };
  if (c.error) return whole ? 1 : 0.001;
  const fit = whole ? Math.floor(c.value + 1e-9) : Math.floor(c.value * 1000 + 1e-9) / 1000;
  return Math.max(fit, whole ? 1 : 0.001);
}

function addToSale(productId, rawQty, rawUnit) {
  const product = findProduct(productId);
  if (!product) return { error: t("product.selectFirst") };
  let qty;
  let sellingUnit = SALE_LINE_UNITS.includes(rawUnit) ? rawUnit : "piece";
  let converted = null;
  if (rawUnit === "m2") {
    // Typed in m²: work out how many whole boxes cover that area (rounded up).
    const area = Calc.boxesForArea(product, rawQty);
    if (area.error) return { error: area.error };
    converted = { area: area.area, boxes: area.boxes, coverage: area.coverage };
    qty = area.boxes;
    sellingUnit = "box";
  } else {
    const checked = Calc.validateQuantity(rawQty, sellingUnit);
    if (checked.error) return { error: checked.error };
    qty = checked.value;
  }

  // The price of one unit comes from the selling price and its price unit (1,500 DA per m² -> 2,160 DA per box).
  const priced = Calc.getUnitPrice(product, sellingUnit);
  if (priced.error) return { error: priced.error };
  // Stock is checked in the product's own stock unit, so 1 box is not the same as 1 piece.
  const taken = Calc.stockDeduction(product, qty, sellingUnit);
  if (taken.error) return { error: taken.error };
  const inSale = stockUsedInSale(productId);
  if (!Calc.hasEnoughStock(product.stock, inSale + taken.value)) return { error: stockMessage(product, inSale) };

  const item = state.sale.items.find((i) => i.productId === productId && i.sellingUnit === sellingUnit);
  if (item) item.qty = Calc.cleanNumber(item.qty + qty);
  else state.sale.items.push({ lineId: uid(), productId, qty, sellingUnit, unitPrice: priced.value, listPrice: priced.value, priceOverridden: false });
  return { ok: true, converted };
}

// Changing the unit keeps the quantity typed and works out the price (and stock use) for the new unit.
// Returns { merged: true } when the line joined an existing line of the same product and unit;
// { error, revert: true } when the unit can't be used (the line keeps its old unit).
function updateSaleUnit(lineId, rawUnit) {
  const item = findSaleItem(lineId);
  if (!item) return { error: t("sale.lineGone") };
  if (!SALE_LINE_UNITS.includes(rawUnit)) return { error: t("sale.chooseUnit") };
  const product = findProduct(item.productId);
  const twin = state.sale.items.find((i) => i !== item && i.productId === item.productId && i.sellingUnit === rawUnit);
  const newQty = twin ? Calc.cleanNumber(twin.qty + item.qty) : item.qty;
  let priced = { value: item.unitPrice };
  if (product) {
    priced = Calc.getUnitPrice(product, rawUnit);
    if (priced.error) return { error: priced.error, revert: true };
    const checked = Calc.validateQuantity(newQty, rawUnit);
    if (checked.error) return { error: `${checked.error} (${Calc.unitLabel(rawUnit)})`, revert: true };
    const taken = Calc.stockDeduction(product, newQty, rawUnit);
    if (taken.error) return { error: taken.error, revert: true };
    const others = stockUsedInSale(item.productId, [item.lineId, twin && twin.lineId]);
    if (!Calc.hasEnoughStock(product.stock, others + taken.value)) return { error: stockMessage(product, others), revert: true };
  }
  item.sellingUnit = rawUnit;
  if (twin) {
    twin.qty = newQty;
    state.sale.items = state.sale.items.filter((i) => i !== item);
    return { merged: true };
  }
  // A price typed by hand on this line is replaced by the new unit's calculated price.
  item.unitPrice = priced.value;
  item.listPrice = priced.value;
  item.priceOverridden = false;
  return {};
}

function removeFromSale(lineId) {
  state.sale.items = state.sale.items.filter((i) => i.lineId !== lineId);
}

// Returns { error } when the value is rejected; { error, clamped } when it was capped to stock.
function updateSaleQuantity(lineId, rawQty) {
  const item = findSaleItem(lineId);
  const product = item && findProduct(item.productId);
  if (!item || !product) return { error: t("sale.productUnavailable") };
  const checked = Calc.validateQuantity(rawQty, item.sellingUnit);
  if (checked.error) return { error: checked.error };
  const qty = checked.value;
  const taken = Calc.stockDeduction(product, qty, item.sellingUnit);
  if (taken.error) return { error: taken.error };
  const others = stockUsedInSale(item.productId, [lineId]);
  if (!Calc.hasEnoughStock(product.stock, others + taken.value)) {
    item.qty = fitQuantity(product, item.sellingUnit, Calc.cleanNumber(product.stock - others));
    return { error: stockMessage(product, others), clamped: true };
  }
  item.qty = qty;
  return {};
}

function updateSalePrice(lineId, rawPrice) {
  const item = findSaleItem(lineId);
  if (!item) return { error: t("sale.lineGone") };
  const price = Number(rawPrice);
  if (rawPrice === "" || !Number.isFinite(price)) return { error: t("sale.enterPrice") };
  if (price < 0) return { error: t("sale.priceNegative") };
  // A hand-typed price belongs to this sale line only. The product's own price is never touched,
  // and changing the unit later goes back to the calculated price.
  item.unitPrice = price;
  item.priceOverridden = round2(price) !== round2(toNumber(item.listPrice));
  return {};
}

function amountFrom(type, value, base) {
  const v = Number(value);
  if (!Number.isFinite(v) || v < 0) return 0;
  return round2(type === "percent" ? (base * Math.min(v, 100)) / 100 : v);
}

function calculateTotals(sale) {
  const subtotal = Calc.calculateSubtotal(sale.items);
  const discount = Math.min(amountFrom(sale.discountType, sale.discountValue, subtotal), subtotal);
  const tax = amountFrom(sale.taxType, sale.taxValue, subtotal - discount);
  const total = Math.max(0, round2(subtotal - discount + tax));
  return { subtotal, discount, tax, total };
}

// Amount received with the sale. An empty field means paid in full.
function salePaid(sale, total) {
  if (String(sale.paidValue).trim() === "") return total;
  const v = Number(sale.paidValue);
  return Number.isFinite(v) && v > 0 ? Math.min(round2(v), total) : 0;
}

// Total paid, remaining balance and status are always calculated from the payments list.
function paymentInfo(inv) {
  const payments = Array.isArray(inv.payments) ? inv.payments : [];
  const paid = round2(payments.reduce((sum, p) => sum + toNumber(p.amount), 0));
  const remaining = Math.max(0, round2(toNumber(inv.total) - paid));
  const cls = remaining <= 0 ? "paid" : paid > 0 ? "partial" : "unpaid";
  const status = t({ paid: "inv.status.paid", partial: "inv.status.partial", unpaid: "inv.status.unpaid" }[cls]);
  return { payments, paid, remaining, status, cls };
}

function paidError() {
  const raw = String(state.sale.paidValue).trim();
  if (raw === "") return "";
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0) return t("sale.paidNegative");
  if (round2(v) > calculateTotals(state.sale).total) return t("sale.paidTooMuch");
  return "";
}

function adjustmentError() {
  const s = state.sale;
  const checks = [
    [s.discountType, s.discountValue, "sale.discountNegative", "sale.discountPercent"],
    [s.taxType, s.taxValue, "sale.taxNegative", "sale.taxPercent"],
  ];
  for (const [type, value, negativeKey, percentKey] of checks) {
    if (value === "") continue;
    const v = Number(value);
    if (!Number.isFinite(v) || v < 0) return t(negativeKey);
    if (type === "percent" && v > 100) return t(percentKey);
  }
  return "";
}

function validateSale() {
  const errors = [];
  if (state.sale.items.length === 0) errors.push(t("sale.addOne"));
  for (const item of state.sale.items) {
    const p = findProduct(item.productId);
    if (!p) { errors.push(t("sale.productMissing")); continue; }
    if (Calc.validateQuantity(item.qty, item.sellingUnit).error) {
      errors.push(t(Calc.isWholeUnit(item.sellingUnit) ? "sale.lineQty" : "sale.lineQtyPositive", { name: p.name }));
    }
    if (!Number.isFinite(item.unitPrice) || item.unitPrice < 0) errors.push(t("sale.linePrice", { name: p.name }));
  }
  const needs = stockNeeds(state.sale.items);
  errors.push(...needs.errors);
  for (const [productId, total] of needs.totals) {
    const p = findProduct(productId);
    if (p && !Calc.hasEnoughStock(p.stock, total)) errors.push(t("sale.nameMessage", { name: p.name, message: stockMessage(p) }));
  }
  const adj = adjustmentError() || paidError();
  if (adj) errors.push(adj);
  if (!Number.isFinite(calculateTotals(state.sale).total)) errors.push(t("sale.totalInvalid"));
  return errors;
}

// Keeps the sale in line with the inventory (deleted products, stock lowered elsewhere).
function syncSaleWithProducts() {
  const notes = [];
  const used = new Map();   // stock (in the product's stock unit) already given to earlier lines of the same product
  state.sale.items = state.sale.items.filter((item) => {
    const p = findProduct(item.productId);
    if (!p) { notes.push(t("sale.removedGone")); return false; }
    const left = Calc.cleanNumber(p.stock - (used.get(p.id) || 0));
    let need = Calc.stockDeduction(p, item.qty, item.sellingUnit);
    if (need.error) { notes.push(t("sale.removedError", { error: need.error })); return false; }
    if (!Calc.hasEnoughStock(left, need.value)) {
      const fit = fitQuantity(p, item.sellingUnit, left);
      const fitNeed = Calc.stockDeduction(p, fit, item.sellingUnit);
      if (fitNeed.error || !Calc.hasEnoughStock(left, fitNeed.value)) { notes.push(t("sale.removedOut", { name: p.name })); return false; }
      item.qty = fit;
      need = fitNeed;
      notes.push(t("sale.reduced", { name: p.name, stock: stockText(p) }));
    }
    used.set(p.id, Calc.cleanNumber((used.get(p.id) || 0) + need.value));
    return true;
  });
  return notes;
}

function clearSale() {
  state.sale = newSale();
  $("custName").value = "";
  $("custPhone").value = "";
  $("custAddress").value = "";
  $("discountValue").value = "";
  $("taxValue").value = "";
  $("amountPaid").value = "";
  $("discountType").value = "amount";
  $("taxType").value = "amount";
  showError("saleError", "");
  showError("addError", "");
  state.previewInvoice = null;
  renderSale();
  renderInvoice();
}

/* ==========================================================================
   INVOICES
   ========================================================================== */

function buildInvoiceData(sale, invoiceNumber, dateIso, data = state) {
  const totals = calculateTotals(sale);
  const paid = salePaid(sale, totals.total);
  const items = sale.items.map((item) => {
    const p = findProduct(item.productId, data);
    const taken = p ? Calc.stockDeduction(p, item.qty, item.sellingUnit) : { error: true };
    return {
      productId: item.productId,
      name: p ? p.name : DELETED_PRODUCT,
      manufacturer: p ? p.manufacturer : "",
      tileSize: p ? p.tileSize : "",
      coveragePerBox: p ? p.coveragePerBox : null,
      sellingUnit: SELLING_UNITS.includes(item.sellingUnit) ? item.sellingUnit : "piece",
      sku: p ? p.sku : "",
      qty: item.qty,
      unitPrice: item.unitPrice,
      total: Calc.calculateLineTotal(item.qty, item.unitPrice),
      // What the price was worked out from, kept so the line can be audited later. A saved invoice
      // is never recalculated from the product's current price, size or coverage.
      priceUnit: p ? p.priceUnit : null,
      productPrice: p ? p.sellingPrice : item.unitPrice,
      calculatedUnitPrice: item.listPrice != null ? item.listPrice : item.unitPrice,
      priceOverridden: Boolean(item.priceOverridden),
      stockUnit: p ? p.stockUnit : null,
      stockDeducted: taken.error ? null : taken.value,
    };
  });
  const s = data.settings;
  return {
    invoiceNumber,
    date: dateIso,
    customer: {
      name: sale.customer.name.trim() || WALK_IN,
      phone: sale.customer.phone.trim(),
      address: sale.customer.address.trim(),
    },
    items,
    subtotal: totals.subtotal,
    discount: totals.discount,
    tax: totals.tax,
    total: totals.total,
    payments: paid > 0 ? [{ amount: paid, timestamp: dateIso }] : [],
    discountPercent: sale.discountType === "percent" ? toNumber(sale.discountValue) : null,
    taxPercent: sale.taxType === "percent" ? toNumber(sale.taxValue) : null,
    currency: s.currency,
    business: { name: s.businessName, address: s.address, phone: s.phone, email: s.email },
  };
}

function draftInvoice() {
  return buildInvoiceData(state.sale, formatInvoiceNumber(state.counter + 1), new Date().toISOString());
}

// Turns a sale into a saved invoice on the data draft `d`: checks the stock again, takes the stock out
// (converted to each product's stock unit) and moves the invoice counter on. { invoice } or { error }.
function applySale(d, sale) {
  if (sale.items.some((i) => !findProduct(i.productId, d))) return { error: t("sale.productMissing") };
  const needs = stockNeeds(sale.items, d);
  if (needs.errors.length) return { error: needs.errors[0] };
  for (const [productId, total] of needs.totals) {
    const p = findProduct(productId, d);
    if (!Calc.hasEnoughStock(p.stock, total)) return { error: t("sale.nameMessage", { name: p.name, message: stockMessage(p) }) };
  }
  const invoice = { id: uid(), ...buildInvoiceData(sale, formatInvoiceNumber(d.counter + 1), new Date().toISOString(), d) };
  // Stock goes down by what was sold converted to each product's stock unit (never by the typed quantity).
  for (const [productId, total] of needs.totals) {
    const p = findProduct(productId, d);
    p.stock = Math.max(0, Calc.cleanNumber(p.stock - total));
  }
  d.invoices.push(invoice);
  d.counter = Math.max(d.counter, invoiceSequence(invoice.invoiceNumber));
  return { invoice };
}

function completeSale() {
  return guard(async () => {
    // Validate the sale and check the stock one final time.
    const errors = validateSale();
    if (errors.length) {
      showError("saleError", errors.join("\n"));
      return;
    }
    showError("saleError", "");

    // One transaction: invoice added + stock decreased + counter increased, saved together or not at all.
    const sale = state.sale;
    const r = await commit((d) => applySale(d, sale));

    if (r.error) {
      showError("saleError", r.error);
      notify(r.error, "error");
      return;
    }

    clearSale();
    state.previewInvoice = r.invoice;
    state.selectedId = null;
    $("search").value = "";
    renderAll();
    notify(t("sell.completed", { number: r.invoice.invoiceNumber }) + savedNote(r));
  });
}

async function deleteInvoice(id) {
  const inv = state.invoices.find((i) => i.id === id);
  if (!inv) return;
  if (!confirm(t("invoice.confirmDelete", { number: inv.invoiceNumber }))) return;
  const r = await commit((d) => { d.invoices = d.invoices.filter((i) => i.id !== id); });
  if (r.error) { notify(r.error, "error"); return; }
  renderAll();
  notify(t("invoice.deleted", { number: inv.invoiceNumber }) + savedNote(r));
}

// Adds a cash payment (current date/time) to a saved invoice. Items and stock are never touched.
async function addPayment(id, rawAmount) {
  const inv = state.invoices.find((i) => i.id === id);
  if (!inv) return { error: t("pay.notFound") };
  const { remaining } = paymentInfo(inv);
  if (remaining <= 0) return { error: t("pay.alreadyPaid") };
  const amount = Number(rawAmount);
  if (rawAmount === "" || !Number.isFinite(amount) || amount <= 0) return { error: t("pay.enterAmount") };
  if (round2(amount) > remaining) return { error: t("pay.tooMuch") };

  return commit((d) => {
    const target = d.invoices.find((i) => i.id === id);
    if (!target) return { error: t("pay.notFound") };
    if (round2(amount) > paymentInfo(target).remaining) return { error: t("pay.tooMuch") };
    target.payments.push({ amount: round2(amount), timestamp: new Date().toISOString() });
  });
}

function viewInvoice(id) {
  const inv = state.invoices.find((i) => i.id === id);
  if (!inv) return;
  state.previewInvoice = inv;
  $("payAmount").value = "";
  showError("payError", "");
  showView("sell", { keepPreview: true });
}

function printInvoice(invoice) {
  if (invoice) {
    state.previewInvoice = invoice;
    renderInvoice();
  }
  // The document title becomes the suggested file name when saving as PDF.
  const original = document.title;
  document.title = (state.previewInvoice || draftInvoice()).invoiceNumber;
  window.addEventListener("afterprint", () => { document.title = original; }, { once: true });
  window.print();
}

/* ==========================================================================
   RENDERING
   ========================================================================== */

/* ==========================================================================
   STORE LOGO
   ========================================================================== */

function renderLogoSetting() {
  const logo = state.settings.logo;
  $("logoPreview").innerHTML = logo ? `<img src="${esc(logo)}" alt="${esc(t("logo.alt"))}">` : `<span class="muted small">${esc(t("logo.none"))}</span>`;
  $("removeLogo").disabled = !logo;
}

async function saveLogo(dataUrl) {
  const r = await commit((d) => { d.settings.logo = dataUrl; });
  if (r.error) {
    showError("logoError", r.error);
    notify(r.error, "error");
    return;
  }
  renderLogoSetting();
  renderInvoice();
  notify(t(dataUrl ? "logo.saved" : "logo.removed") + savedNote(r));
}

// Reads a PNG, shrinks it to fit LOGO_MAX_W x LOGO_MAX_H (never enlarges, keeps transparency) and saves it.
function chooseLogo(file) {
  showError("logoError", "");
  if (!file) return;
  if (file.type !== "image/png" && !/\.png$/i.test(file.name)) { showError("logoError", t("logo.pickPng")); return; }
  const reader = new FileReader();
  reader.onerror = () => showError("logoError", t("storage.fileUnreadable"));
  reader.onload = () => {
    const img = new Image();
    img.onerror = () => showError("logoError", t("logo.badPng"));
    img.onload = () => {
      const scale = Math.min(1, LOGO_MAX_W / img.naturalWidth, LOGO_MAX_H / img.naturalHeight);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      saveLogo(canvas.toDataURL("image/png"));
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

function stockBadge(stock) {
  if (stock <= 0) return ` <span class="badge out">${esc(t("stock.out"))}</span>`;
  if (stock <= LOW_STOCK) return ` <span class="badge low">${esc(t("stock.low"))}</span>`;
  return "";
}

function renderResults() {
  const box = $("results");
  const query = $("search").value;

  if (state.products.length === 0) {
    state.results = [];
    box.innerHTML =
      `<div class="empty"><p><strong>${esc(t("results.none"))}</strong></p>` +
      `<p class="muted">${esc(t("results.addFirst"))}</p>` +
      `<div class="actions"><button type="button" class="btn primary" data-action="goto-add">${esc(t("stock.addProductBtn"))}</button>` +
      `<button type="button" class="btn" data-action="demo">${esc(t("settings.loadDemo"))}</button></div></div>`;
    return;
  }

  state.results = findMatches(query);
  if (!query.trim()) { box.innerHTML = ""; return; }   // nothing typed: no list
  if (state.results.length === 0) {
    box.innerHTML = `<div class="empty"><p class="muted">${esc(t("results.noMatch", { query }))}</p></div>`;
    return;
  }

  box.innerHTML = state.results.map((p) => {
    const meta = [productDetails(p), p.sku, p.category].filter(Boolean).join(", ");
    const stock = esc(p.stock <= 0 ? t("stock.out") : p.stock <= LOW_STOCK ? t("stock.lowN", { n: stockLabel(p) }) : t("stock.n", { n: stockLabel(p) }));
    return `<div class="result" role="option" data-id="${esc(p.id)}" aria-selected="${p.id === state.selectedId}">` +
      `<div><div>${esc(productLabel(p))}</div>${meta ? `<div class="meta">${esc(meta)}</div>` : ""}</div>` +
      `<div class="price">${esc(priceLabel(p))}</div>` +
      `<div class="stock${p.stock <= 0 ? " out" : p.stock <= LOW_STOCK ? " low" : ""}">${stock}</div></div>`;
  }).join("");

  const selected = box.querySelector('[aria-selected="true"]');
  if (selected) selected.scrollIntoView({ block: "nearest" });
}

function renderSelected() {
  const p = findProduct(state.selectedId);
  $("selectedInfo").innerHTML = p
    ? `<strong>${esc(productLabel(p))}</strong>` +
      (productDetails(p) ? `<span>${esc(productDetails(p))}</span>` : "") +
      (p.stock > 0 ? `<span>${esc(t("stock.n", { n: stockLabel(p) }))}</span>` : `<span class="out">${esc(t("stock.out"))}</span>`) +
      (p.stock > 0 && p.stock <= LOW_STOCK ? `<span class="low">${esc(t("stock.low"))}</span>` : "") +
      `<span>${esc(t("selected.price", { price: priceLabel(p) }))}</span>` +
      boxPriceNote(p)
    : `<span class="none">${esc(t("selected.none"))}</span>`;
  syncAddUnit(p);
}

// Can this product be added to a sale in this unit? ("m²" is typed as an area and turned into boxes.)
function unitProblem(product, unit) {
  if (unit === "m2") return Calc.getBoxCoverage(product).error || unitProblem(product, "box");
  return Calc.checkSellable(product, unit).error || "";
}

// The unit list on the Sell page: units this product can't be sold in are greyed out (with the reason),
// and a newly selected product starts on the unit its price is per (boxes for a per-m² price).
function syncAddUnit(p) {
  const select = $("addUnit");
  const options = Array.from(select.options || []);
  for (const opt of options) {
    const problem = p ? unitProblem(p, opt.value) : "";
    opt.disabled = Boolean(problem);
    opt.title = problem;
  }
  if (p && (state.addUnitFor !== p.id || options.some((o) => o.value === select.value && o.disabled))) {
    const wanted = Calc.defaultSellingUnit(p);
    const pick = options.find((o) => o.value === wanted && !o.disabled) || options.find((o) => !o.disabled);
    if (pick) select.value = pick.value;
  }
  state.addUnitFor = p ? p.id : null;
}

// "Box: 1,152 DA" for a tile priced per m², so the cashier sees what one box costs.
function boxPriceNote(p) {
  if (!p.priceUnit || p.priceUnit === "box" || !p.coveragePerBox) return "";
  const box = Calc.getUnitPrice(p, "box");
  return box.error ? "" : `<span>${esc(t("selected.box", { price: money(box.value) }))}</span>`;
}

function unitOptions(selected, product) {
  return SALE_LINE_UNITS.map((u) => {
    const problem = product && u !== selected ? unitProblem(product, u) : "";
    return `<option value="${u}"${u === selected ? " selected" : ""}${problem ? ` disabled title="${esc(problem)}"` : ""}>${esc(unitLabel(u))}</option>`;
  }).join("");
}

// Shows how the line's price was worked out: "1,500 DA / m² x 1.44 m² = 2,160 DA per Box".
function priceNote(item) {
  const p = findProduct(item.productId);
  const priced = p ? Calc.getUnitPrice(p, item.sellingUnit) : null;
  if (!priced || priced.error) return "";
  if (item.priceOverridden) return t("sell.customPrice", { price: money(item.listPrice) });
  if (priced.legacy || priced.factor === 1) return "";
  return `${money(priced.basePrice)} / ${unitLabel(priced.priceUnit)} × ${numberFormat.format(priced.factor)} ${unitLabel(priced.priceUnit)}`;
}

function renderSale() {
  const body = $("saleBody");
  if (state.sale.items.length === 0) {
    body.innerHTML = `<tr class="empty-row"><td colspan="5">${esc(t("sell.empty"))}</td></tr>`;
  } else {
    body.innerHTML = state.sale.items.map((item) => {
      const p = findProduct(item.productId);
      const name = p ? productLabel(p) : t("sell.deletedProduct");
      const whole = Calc.isWholeUnit(item.sellingUnit);
      return `<tr data-id="${esc(item.lineId)}">` +
        `<td><div>${esc(name)}</div><div class="muted small">${esc(t("sell.available", { n: p ? stockLabel(p) : 0 }))}</div><div class="error small" data-row-error></div></td>` +
        `<td class="num"><div class="qty-cell"><input class="qty-input" type="number" min="${whole ? 1 : 0}" step="${whole ? 1 : "any"}" value="${item.qty}" data-field="qty" aria-label="${esc(t("sell.qtyAria", { name }))}">` +
        `<select class="unit-select" data-field="unit" aria-label="${esc(t("sell.unitAria", { name }))}">${unitOptions(item.sellingUnit, p)}</select></div></td>` +
        `<td class="num"><input class="price-input" type="number" min="0" step="any" value="${item.unitPrice}" data-field="price" aria-label="${esc(t("sell.priceAria", { name }))}">` +
        `<div class="muted small price-note" data-price-note>${esc(priceNote(item))}</div></td>` +
        `<td class="num" data-line-total>${esc(money(Calc.calculateLineTotal(item.qty, item.unitPrice)))}</td>` +
        `<td class="num"><button type="button" class="btn small danger" data-action="remove" aria-label="${esc(t("sell.removeAria", { name }))}">${esc(t("common.remove"))}</button></td>` +
        `</tr>`;
    }).join("");
  }
  renderTotals();
}

function renderTotals() {
  const t = calculateTotals(state.sale);
  $("tSubtotal").textContent = money(t.subtotal);
  $("tDiscount").textContent = money(t.discount);
  $("tTax").textContent = money(t.tax);
  $("tTotal").textContent = money(t.total);
  $("tRemaining").textContent = money(Math.max(0, round2(t.total - salePaid(state.sale, t.total))));
  $("amountPaid").placeholder = numberFormat.format(t.total);
}

// Updates totals, line totals and the preview without rebuilding the inputs (keeps focus).
function refreshLive() {
  state.previewInvoice = null;
  $("saleBody").querySelectorAll("tr[data-id]").forEach((row) => {
    const item = findSaleItem(row.dataset.id);
    if (!item) return;
    row.querySelector("[data-line-total]").textContent = money(Calc.calculateLineTotal(item.qty, item.unitPrice));
    row.querySelector("[data-price-note]").textContent = priceNote(item);
  });
  renderTotals();
  renderInvoice();
}

function invoiceHtml(inv) {
  const cur = inv.currency || state.settings.currency;
  const biz = inv.business || {
    name: state.settings.businessName, address: state.settings.address,
    phone: state.settings.phone, email: state.settings.email,
  };
  const cust = inv.customer || { name: WALK_IN, phone: "", address: "" };
  const num = (n) => numberFormat.format(toNumber(n));
  const pct = (p) => (p ? ` (${numberFormat.format(p)}%)` : "");
  const line = (text) => (text ? `<div>${esc(text)}</div>` : "");
  const logo = state.settings.logo ? `<img class="inv-logo" src="${esc(state.settings.logo)}" alt="${esc(t("logo.alt"))}">` : "";

  const rows = inv.items.length
    ? inv.items.map((i) =>
        `<tr><td>${esc(invoiceItemLabel(i))}</td><td class="num">${num(i.qty)}${i.sellingUnit ? ` ${esc(unitLabel(i.sellingUnit, i.qty))}` : ""}</td><td class="num">${num(i.unitPrice)}${i.sellingUnit ? ` <span class="inv-unit">/ ${esc(unitLabel(i.sellingUnit))}</span>` : ""}</td><td class="num">${num(i.total != null ? i.total : Calc.calculateLineTotal(i.qty, i.unitPrice))}</td></tr>`
      ).join("")
    : `<tr><td colspan="4" class="none">${esc(t("inv.noItems"))}</td></tr>`;

  const pay = paymentInfo(inv);
  const hasItems = inv.items.length > 0;
  const paidRows = hasItems
    ? `<tr><td>${esc(t("inv.totalPaid"))}</td><td>${esc(money(pay.paid, cur))}</td></tr><tr class="due"><td>${esc(t("inv.remaining"))}</td><td>${esc(money(pay.remaining, cur))}</td></tr>`
    : "";
  const history = hasItems
    ? `<div class="inv-status"><span class="${pay.cls}">${esc(t("inv.status"))} ${esc(pay.status)}</span></div>
    <section class="inv-payments"><h3>${esc(t("inv.history"))}</h3>${
      pay.payments.length
        ? pay.payments.map((p) => `<div class="inv-pay"><span class="when">${esc(formatDateTime(p.timestamp))}</span><span>${esc(t("inv.paidLine", { amount: money(p.amount, cur) }))}</span></div>`).join("")
        : `<div class="inv-pay"><span class="when">${esc(t("inv.noPayments"))}</span></div>`
    }</section>`
    : "";

  return `<header class="inv-head">
      <div>${logo}<div class="inv-biz-name">${esc(biz.name)}</div>${line(biz.address)}${line(biz.phone)}${line(biz.email)}</div>
      <div class="inv-title">${esc(t("inv.title"))}</div>
    </header>
    <div class="inv-meta">
      <div><div class="label">${esc(t("inv.customer"))}</div><div class="inv-customer">${esc(customerLabel(cust.name))}${cust.phone ? "\n" + esc(cust.phone) : ""}${cust.address ? "\n" + esc(cust.address) : ""}</div></div>
      <div class="right"><div><span class="label">${esc(t("inv.number"))}</span> ${esc(inv.invoiceNumber)}</div><div><span class="label">${esc(t("inv.date"))}</span> ${esc(formatDateTime(inv.date))}</div></div>
    </div>
    <table class="inv-table">
      <thead><tr><th>${esc(t("inv.product"))}</th><th class="num">${esc(t("inv.qty"))}</th><th class="num">${esc(t("inv.price", { currency: cur }))}</th><th class="num">${esc(t("inv.lineTotal", { currency: cur }))}</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <table class="inv-totals">
      <tr><td>${esc(t("inv.subtotal"))}</td><td>${esc(money(toNumber(inv.subtotal), cur))}</td></tr>
      <tr><td>${esc(t("inv.discount"))}${pct(inv.discountPercent)}</td><td>${esc(money(toNumber(inv.discount), cur))}</td></tr>
      <tr><td>${esc(t("inv.tax"))}${pct(inv.taxPercent)}</td><td>${esc(money(toNumber(inv.tax), cur))}</td></tr>
      <tr class="grand"><td>${esc(t("inv.grandTotal"))}</td><td>${esc(money(toNumber(inv.total), cur))}</td></tr>
      ${paidRows}
    </table>
    ${history}
    <p class="inv-thanks">${esc(t("inv.thanks"))}</p>`;
}

// Payment box above a saved invoice: totals plus the "Add Payment" control.
function renderPayBox() {
  const inv = state.previewInvoice;
  $("payBox").hidden = !inv;
  if (!inv) return;
  const cur = inv.currency || state.settings.currency;
  const info = paymentInfo(inv);
  const full = info.remaining <= 0;
  $("payNumber").textContent = inv.invoiceNumber;
  $("payTotal").textContent = money(toNumber(inv.total), cur);
  $("payPaid").textContent = money(info.paid, cur);
  $("payRemaining").textContent = money(info.remaining, cur);
  $("payAmount").disabled = full;
  $("payBtn").disabled = full;
  $("payAmount").placeholder = full ? t("pay.fullyPaid") : t("pay.max", { n: numberFormat.format(info.remaining) });
}

function renderInvoice() {
  const saved = state.previewInvoice;
  $("invoice").innerHTML = invoiceHtml(saved || draftInvoice());
  $("previewStatus").textContent = t(saved ? "preview.saved" : "preview.live");
  $("backToSale").hidden = !saved;
  renderPayBox();
}

function renderStock() {
  const hasProducts = state.products.length > 0;
  const list = searchProducts($("stockFilter").value);
  const empty = $("stockEmpty");

  $("stockFilter").hidden = !hasProducts;
  $("stockTable").hidden = list.length === 0;
  empty.hidden = list.length > 0;

  if (!hasProducts) {
    empty.innerHTML =
      `<p><strong>${esc(t("results.none"))}</strong></p><p class="muted">${esc(t("results.addFirst"))}</p>` +
      `<div class="actions"><button type="button" class="btn primary" data-action="goto-add">${esc(t("stock.addProductBtn"))}</button>` +
      `<button type="button" class="btn" data-action="demo">${esc(t("settings.loadDemo"))}</button></div>`;
  } else if (list.length === 0) {
    empty.innerHTML = `<p class="muted">${esc(t("results.noMatch", { query: $("stockFilter").value }))}</p>`;
  }

  $("stockBody").innerHTML = list.map((p) =>
    `<tr data-id="${esc(p.id)}">` +
    `<td><div>${esc(productLabel(p))}</div>${[productDetails(p), p.category].filter(Boolean).length ? `<div class="muted small">${esc([productDetails(p), p.category].filter(Boolean).join(", "))}</div>` : ""}</td>` +
    `<td>${p.sku ? esc(p.sku) : '<span class="muted">-</span>'}</td>` +
    `<td class="num">${esc(priceLabel(p))}</td>` +
    `<td class="num">${esc(stockLabel(p))}${stockBadge(p.stock)}</td>` +
    `<td class="num"><div class="row-actions">` +
    `<button type="button" class="btn small" data-action="dec" aria-label="${esc(t("stock.decAria", { name: p.name }))}"${p.stock < 1 ? " disabled" : ""}>-</button>` +
    `<button type="button" class="btn small" data-action="inc" aria-label="${esc(t("stock.incAria", { name: p.name }))}">+</button>` +
    `<button type="button" class="btn small" data-action="edit">${esc(t("common.edit"))}</button>` +
    `<button type="button" class="btn small danger" data-action="delete">${esc(t("common.delete"))}</button>` +
    `</div></td></tr>`
  ).join("");

  // Restock selector (keep the current choice) and category suggestions.
  const select = $("rProduct");
  const previous = select.value;
  const sorted = [...state.products].sort((a, b) => productLabel(a).localeCompare(productLabel(b)));
  select.innerHTML = sorted.map((p) => `<option value="${esc(p.id)}">${esc(productLabel(p))}</option>`).join("");
  if (sorted.some((p) => p.id === previous)) select.value = previous;
  select.disabled = !hasProducts;
  $("categoryList").innerHTML = [...new Set(state.products.map((p) => p.category).filter(Boolean))]
    .map((c) => `<option value="${esc(c)}"></option>`).join("");
  renderRestockInfo();
}

function renderRestockInfo() {
  const p = findProduct($("rProduct").value);
  if (!p) { $("restockInfo").textContent = t("restock.addFirst"); return; }
  const raw = $("rQty").value;
  const checked = Calc.validateQuantity(raw, p.stockUnit);
  $("restockInfo").textContent = t("restock.current", { n: stockLabel(p) }) +
    (!checked.error ? t("restock.after", { n: stockText(p, Calc.cleanNumber(p.stock + checked.value)) }) : "");
}

function searchInvoices(query) {
  const terms = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  return [...state.invoices].reverse().filter((inv) => {
    const c = inv.customer || {};
    const phone = String(c.phone || "");
    // The stored walk-in name and its translation are both searchable.
    const haystack = (inv.invoiceNumber + " " + (c.name || WALK_IN) + " " + customerLabel(c.name) + " " + phone + " " + phone.replace(/\s+/g, "")).toLowerCase();
    return terms.every((t) => haystack.includes(t));
  });
}

function renderInvoices() {
  const hasInvoices = state.invoices.length > 0;
  const list = searchInvoices($("invoiceFilter").value);
  $("invoiceFilter").hidden = !hasInvoices;
  $("invoiceTable").hidden = list.length === 0;
  $("invoiceEmpty").hidden = list.length > 0;
  $("invoiceEmpty").innerHTML = hasInvoices
    ? `<p class="muted">${esc(t("invoices.noMatch", { query: $("invoiceFilter").value }))}</p>`
    : `<p><strong>${esc(t("invoices.none"))}</strong></p><p class="muted">${esc(t("invoices.noneHint"))}</p>`;
  $("invoiceBody").innerHTML = list.map((inv) => {
    const pay = paymentInfo(inv);
    const label = t({ paid: "badge.paid", partial: "badge.partial", unpaid: "badge.unpaid" }[pay.cls]);
    return `<tr data-id="${esc(inv.id)}">` +
      `<td>${esc(inv.invoiceNumber)}</td>` +
      `<td>${esc(formatDate(inv.date))}</td>` +
      `<td>${esc(customerLabel(inv.customer && inv.customer.name))}</td>` +
      `<td class="num">${esc(money(toNumber(inv.total), inv.currency))}</td>` +
      `<td class="num">${esc(money(pay.paid, inv.currency))}</td>` +
      `<td class="num">${esc(money(pay.remaining, inv.currency))}</td>` +
      `<td><span class="badge ${pay.cls}">${esc(label)}</span></td>` +
      `<td class="num"><div class="row-actions">` +
      `<button type="button" class="btn small" data-action="view">${esc(t("invoices.view"))}</button>` +
      `<button type="button" class="btn small" data-action="pay"${pay.remaining <= 0 ? " disabled" : ""}>${esc(t("invoices.addPayment"))}</button>` +
      `<button type="button" class="btn small" data-action="print">${esc(t("invoices.print"))}</button>` +
      `<button type="button" class="btn small danger" data-action="delete">${esc(t("common.delete"))}</button>` +
      `</div></td></tr>`;
  }).join("");
}

function applyCurrency() {
  document.querySelectorAll("[data-currency]").forEach((el) => { el.textContent = state.settings.currency; });
}

function fillSettingsForm() {
  const s = state.settings;
  $("sName").value = s.businessName;
  $("sAddress").value = s.address;
  $("sPhone").value = s.phone;
  $("sEmail").value = s.email;
  $("sCurrency").value = s.currency;
  renderLogoSetting();
  renderLanguageSetting();
}

// The picker lists every registered language by its own name.
function renderLanguageSetting() {
  $("sLanguage").innerHTML = I18n.languages().map((l) => `<option value="${esc(l.code)}">${esc(l.name)}</option>`).join("");
  $("sLanguage").value = state.settings.language;
}

// Static text is marked in index.html with data-i18n (text), data-i18n-placeholder, data-i18n-title and
// data-i18n-aria-label. It is rewritten only when the language changes.
let appliedLanguage = null;
function applyLanguage() {
  const language = I18n.language();
  if (language === appliedLanguage) return;
  appliedLanguage = language;
  document.documentElement.lang = language;
  document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => { el.title = t(el.dataset.i18nTitle); });
  document.querySelectorAll("[data-i18n-aria-label]").forEach((el) => { el.setAttribute("aria-label", t(el.dataset.i18nAriaLabel)); });
}

// Saves the chosen language with the other settings. If it can't be saved the picker goes back to the saved one.
function saveLanguage(code) {
  return guard(async () => {
    if (!I18n.has(code) || code === state.settings.language) { renderLanguageSetting(); return; }
    const r = await commit((d) => { d.settings.language = code; });
    if (r.error) {
      notify(r.error, "error");
      renderLanguageSetting();
      return;
    }
    // commit() has switched the language; redraw everything in it.
    renderAll();
    renderStorage();
    fillSettingsForm();
    notify(t("settings.languageChanged") + savedNote(r));
  });
}

function applyPaperSize() {
  const paper = state.settings.paper;
  $("paperStyle").textContent = `@page { size: ${paper}; }`;
  document.documentElement.dataset.paper = paper.toLowerCase();
  $("paper" + paper).checked = true;
}

async function savePaper(paper) {
  const r = await commit((d) => { d.settings.paper = paper; });
  if (r.error) notify(r.error, "error");
  else notify(t("settings.paperSet", { paper }) + savedNote(r));
  applyPaperSize();
}

function updateBannerHeight() {
  const banner = $("storageBanner");
  document.documentElement.style.setProperty("--banner-h", banner.hidden ? "0px" : banner.offsetHeight + "px");
}

function renderStorage() {
  const m = storage.mode;
  const connected = m === "connected";
  let text = "";
  let action = "";
  let label = "";
  if (m === "unlinked") {
    text = t(storage.supported ? "banner.unlinked" : "banner.unsupported");
    if (storage.supported) { action = "settings"; label = t("banner.setup"); }
  } else if (m === "disconnected") {
    text = t("banner.blocked", { reason: storage.reason });
    action = storage.handle ? "reconnect" : "choose";
    label = t(storage.handle ? "banner.reconnect" : "settings.chooseData");
  }
  const banner = $("storageBanner");
  banner.hidden = !text;
  banner.classList.toggle("blocked", m === "disconnected");
  $("bannerText").textContent = text;
  $("bannerAction").hidden = !action;
  $("bannerAction").textContent = label;
  $("bannerAction").dataset.action = action;
  updateBannerHeight();

  const stateText = t({
    connecting: "state.checking",
    connected: "state.connected",
    unlinked: storage.supported ? "state.unlinked" : "state.unsupported",
    disconnected: "state.disconnected",
  }[m]);
  $("dataFile").textContent = (storage.fileName || DATA_FILE_NAME) + (connected ? "" : t("state.notConnectedSuffix"));
  $("dataState").textContent = stateText;
  $("dataState").className = "state-" + m;
  $("dataSaved").textContent = state.lastSaved ? formatDateTime(state.lastSaved) + (connected ? "" : t("state.browserCopySuffix")) : t("state.never");
  $("dataNote").textContent = (connected
    ? t("note.connected")
    : m === "disconnected" ? storage.reason
    : t("note.unlinked")) +
    (storage.mirrorOk ? "" : t("note.mirrorFailed"));
  $("saveNow").disabled = !connected;
  $("chooseData").disabled = !storage.supported;
  $("createData").disabled = !storage.supported;
}

// Called after the in-memory data was replaced from the file, a backup or another window.
function refreshAfterLoad() {
  if (state.editingId && !findProduct(state.editingId)) resetProductForm();
  if (state.selectedId && !findProduct(state.selectedId)) state.selectedId = null;
  const notes = syncSaleWithProducts();
  showError("saleError", "");
  fillSettingsForm();
  renderAll();
  renderStorage();
  if (notes.length) notify(notes.join(" "), "error");
}

function renderAll() {
  applyLanguage();
  renderProductFormMode();
  applyPaperSize();
  applyCurrency();
  renderResults();
  renderSelected();
  renderSale();
  renderStock();
  renderInvoices();
  renderInvoice();
}

/* ==========================================================================
   NAVIGATION
   ========================================================================== */

function showView(name, options) {
  const keepPreview = options && options.keepPreview;
  const previous = state.view;
  state.view = name;

  document.querySelectorAll(".view").forEach((v) => { v.hidden = v.id !== "view-" + name; });
  document.querySelectorAll(".nav-btn").forEach((b) => {
    if (b.dataset.view === name) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  $("app").dataset.view = name;

  let notes = [];
  if (name === "sell") {
    notes = syncSaleWithProducts();
    if (!keepPreview && previous !== "sell") state.previewInvoice = null;
  }
  if (name === "settings") fillSettingsForm();

  renderAll();
  if (notes.length) notify(notes.join(" "), "error");
}

function goToAddProduct() {
  showView("stock");
  $("pName").focus();
}

/* ==========================================================================
   EVENTS
   ========================================================================== */

function selectProduct(id) {
  state.selectedId = id;
  renderResults();
  renderSelected();
}

function bindEvents() {
  // Navigation and shared buttons
  document.querySelectorAll(".nav-btn").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));
  $("brand").addEventListener("click", () => showView("sell"));
  document.addEventListener("click", (e) => {
    const action = e.target.closest("[data-action='goto-add'], [data-action='demo']");
    if (!action) return;
    if (action.dataset.action === "goto-add") goToAddProduct();
    else loadDemoData();
  });

  // Product picker
  const search = $("search");
  search.addEventListener("input", () => {
    state.results = findMatches(search.value);
    state.selectedId = state.results.length ? state.results[0].id : null;
    renderResults();
    renderSelected();
  });
  search.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!state.results.length) return;
      const index = state.results.findIndex((p) => p.id === state.selectedId);
      const next = e.key === "ArrowDown" ? Math.min(index + 1, state.results.length - 1) : Math.max(index - 1, 0);
      selectProduct(state.results[next].id);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (!state.selectedId && state.results.length) selectProduct(state.results[0].id);
      if (state.selectedId) { $("addQty").focus(); $("addQty").select(); }
    }
  });
  $("results").addEventListener("click", (e) => {
    const row = e.target.closest(".result");
    if (!row) return;
    selectProduct(row.dataset.id);
    $("addQty").focus();
    $("addQty").select();
  });
  $("addForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const result = addToSale(state.selectedId, $("addQty").value.trim(), $("addUnit").value);
    if (result.error) {
      showError("addError", result.error);
      $("addQty").focus();
      return;
    }
    showError("addError", "");
    showError("saleError", "");
    if (result.converted) {
      const c = result.converted;
      notify(tn("sell.converted", c.boxes, { area: numberFormat.format(c.area), coverage: numberFormat.format(c.coverage) }));
    }
    state.selectedId = null;
    state.previewInvoice = null;
    search.value = "";
    $("addQty").value = 1;
    renderResults();
    renderSelected();
    renderSale();
    renderInvoice();
    search.focus();
  });
  $("addQty").addEventListener("input", () => showError("addError", ""));

  // Current sale rows
  const saleBody = $("saleBody");
  saleBody.addEventListener("input", (e) => {
    const input = e.target.closest("input[data-field]");
    if (!input) return;
    const row = input.closest("tr");
    const id = row.dataset.id;
    const result = input.dataset.field === "qty" ? updateSaleQuantity(id, input.value.trim()) : updateSalePrice(id, input.value.trim());
    if (result.clamped) input.value = findSaleItem(id).qty;
    row.querySelector("[data-row-error]").textContent = result.error || "";
    showError("saleError", "");
    refreshLive();
  });
  saleBody.addEventListener("change", (e) => {
    const unitSelect = e.target.closest("select[data-field='unit']");
    if (unitSelect) {
      const rowId = unitSelect.closest("tr").dataset.id;
      const result = updateSaleUnit(rowId, unitSelect.value);
      if (result.revert) {
        unitSelect.value = findSaleItem(rowId).sellingUnit;
        unitSelect.closest("tr").querySelector("[data-row-error]").textContent = result.error;
        return;
      }
      if (result.merged) {
        state.previewInvoice = null;
        renderSale();
        renderInvoice();
        return;
      }
      const row = unitSelect.closest("tr");
      const line = findSaleItem(rowId);
      const whole = Calc.isWholeUnit(line.sellingUnit);
      row.querySelector("[data-row-error]").textContent = result.error || "";
      row.querySelector(".price-input").value = line.unitPrice;   // show the price calculated for the new unit
      row.querySelector(".qty-input").min = whole ? 1 : 0;
      row.querySelector(".qty-input").step = whole ? 1 : "any";
      state.previewInvoice = null;
      refreshLive();
      return;
    }
    // On leaving a field, show the value that is actually in the sale.
    const input = e.target.closest("input[data-field]");
    if (!input) return;
    const row = input.closest("tr");
    const item = findSaleItem(row.dataset.id);
    if (!item) return;
    input.value = input.dataset.field === "qty" ? item.qty : item.unitPrice;
    row.querySelector("[data-row-error]").textContent = "";
  });
  saleBody.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action='remove']");
    if (!btn) return;
    removeFromSale(btn.closest("tr").dataset.id);
    showError("saleError", "");
    state.previewInvoice = null;
    renderSale();
    renderInvoice();
  });

  // Customer, discount, tax
  const customerFields = { custName: "name", custPhone: "phone", custAddress: "address" };
  for (const [id, key] of Object.entries(customerFields)) {
    $(id).addEventListener("input", () => {
      state.sale.customer[key] = $(id).value;
      refreshLive();
    });
  }
  const adjustFields = { discountValue: "discountValue", discountType: "discountType", taxValue: "taxValue", taxType: "taxType" };
  for (const [id, key] of Object.entries(adjustFields)) {
    $(id).addEventListener("input", () => {
      state.sale[key] = $(id).value;
      showError("saleError", adjustmentError() || paidError());
      refreshLive();
    });
  }

  $("amountPaid").addEventListener("input", () => {
    state.sale.paidValue = $("amountPaid").value;
    showError("saleError", paidError());
    refreshLive();
  });

  $("clearSale").addEventListener("click", clearSale);
  $("completeSale").addEventListener("click", completeSale);

  // Stock: product form
  const productForm = $("productForm");
  productForm.addEventListener("submit", (e) => {
    e.preventDefault();
    guard(async () => {
      clearProductErrors();
      const result = readProductForm();
      if (result.error) {
        showError("productError", result.error);
        $(result.field).setAttribute("aria-invalid", "true");
        $(result.field).focus();
        return;
      }
      if (state.editingId) await updateProduct(state.editingId, result.values);
      else await addProduct(result.values);
    });
  });
  $("pPriceUnit").addEventListener("change", () => {
    const stockUnit = $("pStockUnit");
    if (!stockUnit.dataset.touched) stockUnit.value = Calc.defaultStockUnit($("pPriceUnit").value) || "";
  });
  $("pStockUnit").addEventListener("change", () => { $("pStockUnit").dataset.touched = "1"; });
  productForm.addEventListener("input", (e) => {
    e.target.removeAttribute("aria-invalid");
    showError("productError", "");
  });
  $("productCancel").addEventListener("click", resetProductForm);

  // Stock: add stock
  $("restockForm").addEventListener("submit", (e) => {
    e.preventDefault();
    guard(async () => {
      const result = await addStock($("rProduct").value, $("rQty").value.trim());
      if (result.error) {
        showError("restockError", result.error);
        $("rQty").focus();
        return;
      }
      showError("restockError", "");
      $("rQty").value = "";
      renderStock();
      renderResults();
      renderSelected();
      notify(result.message + savedNote(result));
      $("rQty").focus();
    });
  });
  $("rProduct").addEventListener("change", renderRestockInfo);
  $("rQty").addEventListener("input", () => { showError("restockError", ""); renderRestockInfo(); });

  // Stock: table
  $("stockFilter").addEventListener("input", renderStock);
  $("stockBody").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const id = btn.closest("tr").dataset.id;
    if (btn.dataset.action === "inc") adjustStock(id, 1);
    else if (btn.dataset.action === "dec") adjustStock(id, -1);
    else if (btn.dataset.action === "edit") startEditProduct(id);
    else if (btn.dataset.action === "delete") deleteProduct(id);
  });

  // Invoices
  $("invoiceBody").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const id = btn.closest("tr").dataset.id;
    if (btn.dataset.action === "view") viewInvoice(id);
    else if (btn.dataset.action === "pay") { viewInvoice(id); $("payAmount").focus(); }
    else if (btn.dataset.action === "print") printInvoice(state.invoices.find((i) => i.id === id));
    else if (btn.dataset.action === "delete") deleteInvoice(id);
  });

  $("invoiceFilter").addEventListener("input", renderInvoices);

  // Add a payment to the invoice shown in the preview
  $("payForm").addEventListener("submit", (e) => {
    e.preventDefault();
    guard(async () => {
      if (!state.previewInvoice) return;
      const result = await addPayment(state.previewInvoice.id, $("payAmount").value.trim());
      if (result.error) {
        showError("payError", result.error);
        $("payAmount").focus();
        return;
      }
      showError("payError", "");
      $("payAmount").value = "";
      renderInvoices();
      renderInvoice();
      notify(t("pay.added") + savedNote(result));
    });
  });
  $("payAmount").addEventListener("input", () => showError("payError", ""));

  // Preview
  $("printBtn").addEventListener("click", () => printInvoice());
  $("backToSale").addEventListener("click", () => {
    state.previewInvoice = null;
    renderInvoice();
  });

  // Settings
  $("settingsForm").addEventListener("submit", (e) => {
    e.preventDefault();
    guard(async () => {
      const r = await commit((d) => {
        d.settings = {
          ...d.settings,
          businessName: $("sName").value.trim(),
          address: $("sAddress").value.trim(),
          phone: $("sPhone").value.trim(),
          email: $("sEmail").value.trim(),
          currency: $("sCurrency").value.trim() || CURRENCY,
        };
      });
      if (r.error) { notify(r.error, "error"); return; }
      notify(t("settings.saved") + savedNote(r));
      fillSettingsForm();
      renderAll();
    });
  });

  // Language
  $("sLanguage").addEventListener("change", () => saveLanguage($("sLanguage").value));

  // Data storage
  $("chooseData").addEventListener("click", () => pickDataFile(false));
  $("createData").addEventListener("click", () => pickDataFile(true));
  $("saveNow").addEventListener("click", saveNow);
  $("exportBackup").addEventListener("click", exportBackup);
  $("importBackup").addEventListener("click", () => $("importFile").click());
  $("importFile").addEventListener("change", (e) => { importBackup(e.target.files[0]); e.target.value = ""; });
  $("bannerAction").addEventListener("click", () => {
    const action = $("bannerAction").dataset.action;
    if (action === "settings") showView("settings");
    else if (action === "reconnect") reconnect();
    else if (action === "choose") pickDataFile(false);
  });
  window.addEventListener("resize", updateBannerHeight);
  $("loadDemo").addEventListener("click", loadDemoData);
  $("chooseLogo").addEventListener("click", () => $("logoFile").click());
  $("logoFile").addEventListener("change", (e) => { chooseLogo(e.target.files[0]); e.target.value = ""; });
  $("removeLogo").addEventListener("click", () => saveLogo(""));
  document.querySelectorAll('input[name="paper"]').forEach((r) => r.addEventListener("change", () => savePaper(r.value)));

  // Another window saved new data: pick it up (the browser copy is only written after a successful save).
  window.addEventListener("storage", (e) => {
    if (e.key !== MIRROR_KEY) return;
    const mirror = readMirror();
    if (!mirror.data || mirror.data.lastSaved === state.lastSaved) return;
    applyData(mirror.data);
    refreshAfterLoad();
  });
}

/* ---------- Start ---------- */

if (globalThis.__INVOISY_TEST_EXPORTS__) {
  Object.assign(globalThis.__INVOISY_TEST_EXPORTS__, {
    normalizeProduct,
    normalizeTileSize,
    formatTileSize,
    isTileSize,
    addToSale,
    updateSaleQuantity,
    updateSaleUnit,
    updateSalePrice,
    validateSale,
    syncSaleWithProducts,
    getSale: () => state.sale,
    productProblem,
    productLabel,
    findMatches,
    priceLabel,
    buildInvoiceData,
    calculateTotals,
    applySale,
    invoiceHtml,
    getProducts: () => state.products,
    getInvoices: () => state.invoices,
    paymentInfo,
    addPayment,
    stockLabel,
    stockText,
    unitProblem,
    priceNote,
    invoiceItemLabel,
    readProductForm,
    buildData,
    buildPayload,
    parseDataText,
    applyData,
    commit,
    readMirror,
    DEFAULT_SETTINGS,
    DEMO_PRODUCTS,
    localizedDemo,
    invoiceHtml,
    paymentInfo,
    money,
    customerLabel,
    describeData,
    normalizeSettings,
    settingsProblem,
  });
} else {
  const startupNotices = loadLocalCopy();
  bindEvents();
  resetProductForm();
  showView("sell");
  renderStorage();
  storage.ready = initStorage(startupNotices).catch((e) => {
    setStorageMode("disconnected", t("storage.cannotOpen", { error: errorText(e) }));
  });
}

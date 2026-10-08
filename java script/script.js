"use strict";

/* ==========================================================================
   Simple Invoice - products, stock, sales and invoices in the browser.
   Data lives in a local invoisy-data.json file (with a browser copy as fallback).
   No backend, no dependencies.
   ========================================================================== */

/* ---------- Configuration ---------- */

const CURRENCY = "DA";            // default currency (can be changed in Settings)
const WALK_IN = "Walk-in Customer";
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
};

const DEMO_PRODUCTS = [
  { name: "Coca Cola 33cl", description: "330ml Coca Cola bottle", sku: "COCA33",   category: "Drinks", sellingPrice: 80,  purchasePrice: 60, stock: 50 },
  { name: "Chips",          description: "Salted potato chips",    sku: "CHIPS01",  category: "Snacks", sellingPrice: 120, purchasePrice: 90, stock: 24 },
  { name: "Water 1.5L",     description: "Bottled water 1.5L",     sku: "WATER15",  category: "Drinks", sellingPrice: 50,  purchasePrice: 35, stock: 40 },
  { name: "Coffee",         description: "Ground coffee, 250g",    sku: "COFFEE01", category: "Drinks", sellingPrice: 350, purchasePrice: 280, stock: 15 },
  { name: "Chocolate",      description: "Milk chocolate bar",     sku: "CHOC01",   category: "Snacks", sellingPrice: 100, purchasePrice: 70, stock: 30 },
];

/* ---------- Helpers ---------- */

const $ = (id) => document.getElementById(id);
const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

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

/* ---------- Data model ---------- */

const DATA_VERSION = 1;
const DATA_FILE_NAME = "invoisy-data.json";
const MIRROR_KEY = "invoisy-data";            // browser copy of the data file (fallback and recovery)
const LEGACY_KEYS = ["products", "invoices", "settings", "invoiceCounter"];
const DERIVED_INVOICE_FIELDS = ["amountPaid", "remaining", "status"];   // written to the file for readability only
// Units a line on a sale can be sold in. The unit belongs to the sale line, not to the product.
const SELLING_UNITS = ["piece", "box", "m2", "kg"];
const UNIT_LABELS = { piece: "Piece", box: "Box", m2: "m²", kg: "kg" };
// m² can be typed when adding to a sale, but it is converted to boxes and never stored on a sale line.
const SALE_LINE_UNITS = ["piece", "box", "kg"];
const unitLabel = (unit) => UNIT_LABELS[unit] || UNIT_LABELS.piece;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string";
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isDate = (v) => isStr(v) && !isNaN(new Date(v));

function normalizeProduct(raw) {
  if (!raw || typeof raw !== "object" || !raw.name) return null;
  const price = Number(raw.sellingPrice);
  const stock = Math.floor(Number(raw.stock));
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
    purchasePrice: hasCost ? Number(raw.purchasePrice) : null,
    stock: Number.isFinite(stock) && stock >= 0 ? stock : 0,
  };
}

// Accepts 60*120, 12*15, 60x120 or 60 × 120 (an old "cm" suffix is still accepted so saved data keeps loading).
function isTileSize(value) {
  return /^\d+(?:[.,]\d+)?\s*[*×x]\s*\d+(?:[.,]\d+)?\s*(?:mm|cm|m)?$/i.test(String(value).trim());
}

// Stores whatever was typed in one format: "60*120".
function normalizeTileSize(value) {
  const m = String(value).trim().match(/^(\d+(?:[.,]\d+)?)\s*[*×x]\s*(\d+(?:[.,]\d+)?)/i);
  return m ? `${m[1].replace(",", ".")}*${m[2].replace(",", ".")}` : String(value).trim();
}

// A display label is derived at render time; it is never the persisted product value.
function productLabel(product) {
  if (!product) return "";
  return [product.name, product.tileSize, product.manufacturer].filter(Boolean).join(" — ");
}

function productDetails(product) {
  if (!product) return "";
  const details = [];
  if (product.coveragePerBox != null) details.push(`${numberFormat.format(product.coveragePerBox)} m² per box`);
  return details.join(", ");
}

// "60*120" or "60 × 120 cm" -> "60 × 120"
function formatTileSize(size) {
  const m = String(size || "").match(/^\s*(\d+(?:[.,]\d+)?)\s*[*×x]\s*(\d+(?:[.,]\d+)?)/i);
  return m ? `${m[1]} × ${m[2]}` : String(size || "").trim();
}

// Invoice wording: golden era (60 × 120) garnada
function invoiceItemLabel(item) {
  const size = formatTileSize(item.tileSize);
  return [item.name, size ? `(${size})` : "", item.manufacturer].filter(Boolean).join(" ");
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
  if (!isObj(p)) return "is not an object";
  if (!isStr(p.id) || !p.id) return "has no id";
  if (!isStr(p.name) || !p.name.trim()) return "has no name";
  if (p.manufacturer !== undefined && !isStr(p.manufacturer)) return "has an invalid manufacturer";
  if (p.tileSize !== undefined && (!isStr(p.tileSize) || (p.tileSize.trim() && !isTileSize(p.tileSize)))) return "has an invalid tile size";
  if (p.coveragePerBox !== undefined && p.coveragePerBox !== null && (!isNum(p.coveragePerBox) || p.coveragePerBox <= 0)) return "has an invalid box coverage";
  if (!isNum(p.sellingPrice) || p.sellingPrice < 0) return "has an invalid selling price";
  if (p.purchasePrice != null && (!isNum(p.purchasePrice) || p.purchasePrice < 0)) return "has an invalid purchase price";
  if (!Number.isInteger(p.stock) || p.stock < 0) return "has an invalid stock quantity";
  return "";
}

function invoiceProblem(inv) {
  if (!isObj(inv)) return "is not an object";
  if (!isStr(inv.id) || !inv.id) return "has no id";
  if (!isStr(inv.invoiceNumber) || !/^INV-\d+$/.test(inv.invoiceNumber)) return "has an invalid invoice number";
  if (!isDate(inv.date)) return "has an invalid date";
  if (!Array.isArray(inv.items)) return "has no item list";
  if (inv.items.some((i) => !isObj(i) || !isNum(i.qty) || i.qty <= 0 || !isNum(i.unitPrice) || i.unitPrice < 0 || (i.sellingUnit !== undefined && !SELLING_UNITS.includes(i.sellingUnit)))) return "has an invalid item";
  for (const key of ["subtotal", "discount", "tax", "total"]) {
    if (!isNum(inv[key]) || inv[key] < 0) return `has an invalid ${key}`;
  }
  if (!Array.isArray(inv.payments)) return "has no payment list";
  if (inv.payments.some((p) => !isObj(p) || !isNum(p.amount) || p.amount <= 0 || !isDate(p.timestamp))) return "has an invalid payment";
  if (inv.customer != null && !isObj(inv.customer)) return "has invalid customer details";
  return "";
}

function settingsProblem(s) {
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (s[key] !== undefined && !isStr(s[key])) return `The setting "${key}" is not valid.`;
  }
  if (s.paper !== undefined && !["A4", "A5"].includes(s.paper)) return "The paper size must be A4 or A5.";
  if (s.logo && !s.logo.startsWith("data:image/")) return "The logo is not valid image data.";
  return "";
}

function collect(list, label, problemOf, normalize, lenient, problems) {
  const out = [];
  list.forEach((item, i) => {
    const candidate = lenient ? normalize(item) : item;
    const why = candidate ? problemOf(candidate) : "is not valid";
    if (why) problems.push(`${label} ${i + 1} ${why}.`);
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
  if (!isObj(raw)) return { error: "The data is not an Invoisy data object." };
  if (!Array.isArray(raw.products)) return { error: "The products list is missing." };
  if (!Array.isArray(raw.invoices)) return { error: "The invoices list is missing." };
  if (!isObj(raw.settings)) return { error: "The settings are missing." };
  if (!lenient) {
    if (!Number.isInteger(raw.version) || raw.version < 1) return { error: "The data version is missing." };
    if (raw.version > DATA_VERSION) return { error: `This data was made by a newer version of Invoisy (data version ${raw.version}).` };
    if (!Number.isInteger(raw.invoiceCounter) || raw.invoiceCounter < 0) return { error: "The invoice counter is not valid." };
    const settingsIssue = settingsProblem(raw.settings);
    if (settingsIssue) return { error: settingsIssue };
  }

  const problems = [];
  const products = collect(raw.products, "Product", productProblem, normalizeProduct, lenient, problems);
  const invoices = collect(raw.invoices, "Invoice", invoiceProblem, normalizeInvoice, lenient, problems);

  const dupProduct = firstDuplicate(products.map((p) => p.id));
  if (dupProduct) return { error: `Two products share the id ${dupProduct}.` };
  const dupInvoice = firstDuplicate(invoices.map((i) => i.id));
  if (dupInvoice) return { error: `Two invoices share the id ${dupInvoice}.` };
  const dupNumber = firstDuplicate(invoices.map((i) => i.invoiceNumber));
  if (dupNumber) return { error: `Two invoices share the number ${dupNumber}.` };

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
  if (built.data.counterRecovered) problems.push("The invoice counter is lower than the highest invoice number.");
  return problems;
}

function parseDataText(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: "The file is not valid JSON." };
  }
  const built = buildData(raw, false);
  if (built.error) return { error: built.error };
  if (built.problems.length) {
    const more = built.problems.length > 3 ? ` (and ${built.problems.length - 3} more)` : "";
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
};

function applyData(d) {
  state.products = d.products;
  state.invoices = d.invoices;
  state.settings = d.settings;
  state.counter = d.counter;
  state.lastSaved = d.lastSaved || "";
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

const MSG_PERMISSION = "Invoisy no longer has permission to use the data file.";
const MSG_MISSING = "The data file could not be found. It may have been moved or deleted.";

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
    return { error: "The data could not be converted to JSON, so nothing was saved." };
  }
  const problems = validatePersistentData(JSON.parse(text));
  if (problems.length) return { error: "The data failed its safety check, so nothing was saved. " + problems[0] };
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
  if (mirror.error) notices.push("The browser copy of the data could not be read and was ignored.");

  const legacy = migrateLegacyStorage();
  if (!legacy) {
    applyData(defaultData());
    return notices;
  }
  applyData(legacy.data);
  const built = buildPayload(draftFromState(), nextStamp());
  if (!built.error && writeMirror(built.text)) state.lastSaved = built.lastSaved;
  else notices.push("Your existing data was loaded but could not be copied to the new storage. Export a backup now.");
  if (legacy.problems.length) {
    notices.push(`${legacy.problems.length} saved entries could not be read and were left out. Your original browser data was not touched.`);
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
  const why = storage.mode === "disconnected" ? storage.reason : "The data file is not ready yet.";
  return why + " Nothing was changed. Reconnect the data file first (Settings, Data storage).";
}

function describeFileError(e, active) {
  if (e && e.name === "NotFoundError") {
    if (active) setStorageMode("disconnected", MSG_MISSING);
    return MSG_MISSING + " Nothing was saved.";
  }
  if (e && e.name === "NotAllowedError") {
    if (active) setStorageMode("disconnected", MSG_PERMISSION);
    return MSG_PERMISSION + " Nothing was saved.";
  }
  return "The data file could not be written. " + errorText(e);
}

// Before writing, make sure nobody else changed the file since Invoisy last read or wrote it.
async function checkUnchanged(handle, expectedStamp) {
  const current = await (await handle.getFile()).text();
  if (!current.trim()) {
    setStorageMode("disconnected", "The data file is empty.");
    return { error: "The data file is empty, so nothing was saved and the file was not overwritten." };
  }
  const parsed = parseDataText(current);
  if (parsed.error) {
    const reason = `The Invoisy data file could not be read. Your existing data has not been overwritten. Please check the data file or restore a backup. (${parsed.error})`;
    setStorageMode("disconnected", reason);
    return { error: reason };
  }
  if (parsed.data.lastSaved === expectedStamp) return null;
  applyData(parsed.data);
  storage.mirrorOk = writeMirror(current);
  refreshAfterLoad();
  return { error: "The data file was changed by another window or program. The latest data has been loaded and nothing was saved. Please repeat your last action." };
}

// expectedStamp: the lastSaved the file must still have (null skips the check, for a brand new file).
async function writeToDataFile(handle, text, expectedStamp, active) {
  try {
    if ((await handle.queryPermission({ mode: "readwrite" })) !== "granted") {
      if (active) setStorageMode("disconnected", MSG_PERMISSION);
      return { error: MSG_PERMISSION + " Nothing was saved." };
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
      return { error: "The data file could not be verified after saving. Please check the file and export a backup." };
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
    return { error: "Could not save data. Check that browser storage is available." };
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
      return { error: "Something went wrong, so nothing was saved. " + errorText(e) };
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
    notify("Something went wrong. " + errorText(e), "error");
  } finally {
    busy = false;
  }
}

function savedNote(result) {
  return result.toFile ? "" : " Saved in this browser only.";
}

/* -- Connecting a data file -- */

function describeData(d) {
  const n = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
  return `${n(d.products.length, "product")}, ${n(d.invoices.length, "invoice")}`;
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
    ? `Data saved to ${handle.name}. Changes are now saved to this file automatically.`
    : `Data saved to ${handle.name}, but this browser cannot remember the file. Choose it again next time.`);
  return true;
}

// chosen = the person just picked this file (otherwise it is the remembered file being reopened).
async function connectHandle(handle, chosen) {
  const fail = (message) => (chosen ? reportFileProblem(message) : (setStorageMode("disconnected", message), false));

  let text;
  try {
    text = await (await handle.getFile()).text();
  } catch (e) {
    return fail(e && e.name === "NotFoundError" ? MSG_MISSING : "The data file could not be opened. " + errorText(e));
  }
  if (!text.trim()) {
    if (chosen) return startNewFile(handle);
    return fail("The data file is empty. Your data has not been overwritten. Use Create Data File or Choose Data File to set it up again.");
  }
  const parsed = parseDataText(text);
  if (parsed.error) {
    return fail(`The Invoisy data file could not be read. Your existing data has not been overwritten. Please check the data file or restore a backup. (${parsed.error})`);
  }

  const incoming = parsed.data;
  const hasLocal = state.products.length > 0 || state.invoices.length > 0;
  const sameVersion = incoming.lastSaved !== "" && incoming.lastSaved === state.lastSaved;
  const browserNewer = Date.parse(state.lastSaved) > Date.parse(incoming.lastSaved);
  if (hasLocal && !sameVersion && (chosen || browserNewer)) {
    const lead = chosen
      ? `Load data from ${handle.name}?`
      : `The data file ${handle.name} is older than the copy stored in this browser. Load the older file anyway?`;
    const saved = (iso) => formatDateTime(iso) || "unknown";
    const ok = confirm(`${lead}\n\nFile: ${describeData(incoming)} (saved ${saved(incoming.lastSaved)})\nBrowser: ${describeData(state)} (saved ${saved(state.lastSaved)})\n\nThe data now shown will be replaced by the data in the file. Use Export Backup first if you want to keep a copy.`);
    if (!ok) {
      if (!chosen) setStorageMode("disconnected", "The data file was not loaded because it is older than the copy stored in this browser. Export a backup if you need that copy.");
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
  if (chosen) notes.push(`Data loaded from ${handle.name}.`);
  if (!remembered) notes.push("This browser cannot remember the file, so choose it again next time.");
  if (incoming.counterRecovered) notes.push("The invoice counter was corrected to match the existing invoices.");
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
      reportFileProblem("Permission to change the data file was not granted.");
      return;
    }
  } catch (e) {
    if (!e || e.name !== "AbortError") reportFileProblem("The data file could not be opened. " + errorText(e));
    return;
  }
  await enqueue(() => connectHandle(handle, true));
}

async function reconnect() {
  const handle = storage.handle;
  if (!handle) return pickDataFile(false);
  try {
    if ((await handle.requestPermission({ mode: "readwrite" })) !== "granted") {
      notify("Permission to change the data file was not granted.", "error");
      return;
    }
  } catch (e) {
    notify("The data file could not be reopened. " + errorText(e), "error");
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
      else setStorageMode("disconnected", "Invoisy needs your permission to open the data file again. Click Reconnect.");
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
    notify(`Data saved to ${storage.fileName}.`);
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
  notify(`Backup exported as ${name}.`);
}

function importBackup(file) {
  return guard(async () => {
    showError("dataError", "");
    if (!file) return;
    let text;
    try {
      text = await file.text();
    } catch {
      reportFileProblem("That file could not be read.");
      return;
    }
    const parsed = parseDataText(text);
    if (parsed.error) {
      reportFileProblem(`That file is not a valid Invoisy backup, so nothing was changed. (${parsed.error})`);
      return;
    }
    if (!canWrite()) { reportFileProblem(blockedMessage()); return; }
    const incoming = parsed.data;
    const saved = formatDateTime(incoming.lastSaved) || "unknown";
    if (!confirm(`Importing this backup will replace the current Invoisy data.\n\nProducts, stock, invoices, payments, and settings will be replaced.\n\nBackup: ${describeData(incoming)} (saved ${saved})\nCurrent: ${describeData(state)}\n\nContinue?`)) return;

    // The invoice counter never goes backwards, so numbers already issued are not reused.
    const r = await commit((d) => {
      d.products = incoming.products;
      d.invoices = incoming.invoices;
      d.settings = incoming.settings;
      d.counter = Math.max(d.counter, incoming.counter);
    });
    if (r.error) { reportFileProblem(r.error); return; }
    refreshAfterLoad();
    notify("Backup imported." + savedNote(r));
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

function readProductForm() {
  const get = (id) => $(id).value.trim();
  const fail = (field, error) => ({ field, error });

  const name = get("pName");
  if (!name) return fail("pName", "Product name is required.");
  const tileSizeRaw = get("pTileSize");
  if (tileSizeRaw && !isTileSize(tileSizeRaw)) return fail("pTileSize", "Tile size must look like 60*120.");
  const tileSize = tileSizeRaw ? normalizeTileSize(tileSizeRaw) : "";
  const coverageRaw = get("pCoveragePerBox");
  const coveragePerBox = Number(coverageRaw);
  if (coverageRaw !== "" && (!Number.isFinite(coveragePerBox) || coveragePerBox <= 0)) {
    return fail("pCoveragePerBox", "Coverage per box must be greater than 0.");
  }

  const priceRaw = get("pPrice");
  const price = Number(priceRaw);
  if (priceRaw === "" || !Number.isFinite(price)) return fail("pPrice", "Selling price is required.");
  if (price < 0) return fail("pPrice", "Selling price can't be negative.");

  const costRaw = get("pCost");
  const cost = Number(costRaw);
  if (costRaw !== "" && (!Number.isFinite(cost) || cost < 0)) return fail("pCost", "Purchase price can't be negative.");

  const stockRaw = get("pStock");
  const stock = stockRaw === "" ? 0 : Number(stockRaw);
  if (!Number.isInteger(stock) || stock < 0) return fail("pStock", "Stock must be a whole number, 0 or more.");

  const sku = get("pSku");
  if (sku) {
    const clash = state.products.find((p) => p.id !== state.editingId && p.sku.toLowerCase() === sku.toLowerCase());
    if (clash) return fail("pSku", `SKU "${sku}" is already used by ${clash.name}.`);
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
  notify(`${productLabel(values)} added.` + savedNote(r));
  $("pName").focus();
}

async function updateProduct(id, values) {
  const r = await commit((d) => {
    const product = findProduct(id, d);
    if (!product) return { error: "That product no longer exists." };
    Object.assign(product, values);
  });
  if (r.error) {
    showError("productError", r.error);
    notify(r.error, "error");
    return;
  }
  resetProductForm();
  renderAll();
  notify(`${productLabel(values)} updated.` + savedNote(r));
}

async function deleteProduct(id) {
  const product = findProduct(id);
  if (!product) return;
  if (!confirm(`Delete "${product.name}"? This cannot be undone.`)) return;
  const r = await commit((d) => { d.products = d.products.filter((p) => p.id !== id); });
  if (r.error) { notify(r.error, "error"); return; }
  state.sale.items = state.sale.items.filter((i) => i.productId !== id);
  if (state.selectedId === id) state.selectedId = null;
  if (state.editingId === id) resetProductForm();
  renderAll();
  notify(`${product.name} deleted.` + savedNote(r));
}

async function adjustStock(id, delta) {
  const r = await commit((d) => {
    const product = findProduct(id, d);
    if (!product) return { skip: true };
    product.stock = Math.max(0, product.stock + delta);
  });
  if (r.error) { notify(r.error, "error"); return; }
  renderStock();
  renderResults();
  renderSelected();
}

async function addStock(id, rawQty) {
  if (!findProduct(id)) return { error: "Select a product first." };
  const qty = Number(rawQty);
  if (rawQty === "" || !Number.isInteger(qty) || qty < 1) {
    return { error: "Quantity to add must be a whole number of at least 1." };
  }
  return commit((d) => {
    const product = findProduct(id, d);
    if (!product) return { error: "That product no longer exists." };
    const before = product.stock;
    product.stock = before + qty;
    return { message: `${product.name}: ${before} + ${qty} = ${product.stock}` };
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
  $("pCost").value = p.purchasePrice == null ? "" : p.purchasePrice;
  $("pStock").value = p.stock;
  $("pSku").value = p.sku;
  $("pCategory").value = p.category;
  $("productFormTitle").textContent = "Edit product";
  $("productSubmit").textContent = "Save Changes";
  $("productCancel").hidden = false;
  clearProductErrors();
  $("pName").focus();
}

function resetProductForm() {
  state.editingId = null;
  $("productForm").reset();
  $("pStock").value = 0;
  $("productFormTitle").textContent = "Add product";
  $("productSubmit").textContent = "Add Product";
  $("productCancel").hidden = true;
  clearProductErrors();
}

function clearProductErrors() {
  showError("productError", "");
  $("productForm").querySelectorAll("[aria-invalid]").forEach((el) => el.removeAttribute("aria-invalid"));
}

function loadDemoData() {
  return guard(async () => {
    const r = await commit((d) => {
      const have = new Set(d.products.map((p) => p.sku.toLowerCase()).filter(Boolean));
      let added = 0;
      for (const demo of DEMO_PRODUCTS) {
        if (have.has(demo.sku.toLowerCase())) continue;
        d.products.push(normalizeProduct({ id: uid(), ...demo }));
        added++;
      }
      return added ? { added } : { skip: true };
    });
    if (r.error) { notify(r.error, "error"); return; }
    if (r.skip) { notify("The demo products are already in your stock."); return; }
    renderAll();
    notify(`${r.added} demo products added.` + savedNote(r));
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

// Quantity of a product already on the sale across all its lines, optionally ignoring one line.
function qtyInSale(productId, exceptLineId, sale = state.sale) {
  return sale.items.reduce((sum, i) => (i.productId === productId && i.lineId !== exceptLineId ? sum + toNumber(i.qty) : sum), 0);
}

// Total quantity per product across all lines, for stock checks.
function totalsByProduct(items) {
  const totals = new Map();
  for (const i of items) totals.set(i.productId, (totals.get(i.productId) || 0) + toNumber(i.qty));
  return totals;
}

function stockMessage(available, inSale) {
  return `Not enough stock. Available quantity: ${available}.` + (inSale ? ` ${inSale} already in this sale.` : "");
}

function addToSale(productId, rawQty, rawUnit) {
  const product = findProduct(productId);
  if (!product) return { error: "Select a product first." };
  let qty = Number(rawQty);
  let sellingUnit = SALE_LINE_UNITS.includes(rawUnit) ? rawUnit : "piece";
  let converted = null;
  if (rawUnit === "m2") {
    // Typed in m²: work out how many whole boxes cover that area (rounded up).
    if (rawQty === "" || !Number.isFinite(qty) || qty <= 0) return { error: "Enter the area in m², greater than 0." };
    if (!product.coveragePerBox) return { error: `${product.name} has no coverage per box. Edit the product and set it to sell by m².` };
    const boxes = Math.max(1, Math.ceil(round2(qty / product.coveragePerBox * 1e4) / 1e4));
    converted = { area: qty, boxes, coverage: product.coveragePerBox };
    qty = boxes;
    sellingUnit = "box";
  } else if (rawQty === "" || !Number.isInteger(qty) || qty < 1) {
    return { error: "Quantity must be a whole number of at least 1." };
  }
  const item = state.sale.items.find((i) => i.productId === productId && i.sellingUnit === sellingUnit);
  const inSale = qtyInSale(productId);
  if (inSale + qty > product.stock) return { error: stockMessage(product.stock, inSale) };

  if (item) item.qty += qty;
  else state.sale.items.push({ lineId: uid(), productId, qty, sellingUnit, unitPrice: product.sellingPrice });
  return { ok: true, converted };
}

// Returns { merged: true } when the line joined an existing line of the same product and unit.
function updateSaleUnit(lineId, rawUnit) {
  const item = findSaleItem(lineId);
  if (!item) return { error: "This product is no longer in the sale." };
  if (!SALE_LINE_UNITS.includes(rawUnit)) return { error: "Choose a valid unit." };
  item.sellingUnit = rawUnit;
  const twin = state.sale.items.find((i) => i !== item && i.productId === item.productId && i.sellingUnit === rawUnit);
  if (twin) {
    twin.qty += item.qty;
    state.sale.items = state.sale.items.filter((i) => i !== item);
    return { merged: true };
  }
  return {};
}

function removeFromSale(lineId) {
  state.sale.items = state.sale.items.filter((i) => i.lineId !== lineId);
}

// Returns { error } when the value is rejected; { error, clamped } when it was capped to stock.
function updateSaleQuantity(lineId, rawQty) {
  const item = findSaleItem(lineId);
  const product = item && findProduct(item.productId);
  if (!item || !product) return { error: "This product is no longer available." };
  const qty = Number(rawQty);
  if (rawQty === "" || !Number.isInteger(qty) || qty < 1) {
    return { error: "Quantity must be a whole number of at least 1." };
  }
  const others = qtyInSale(item.productId, lineId);
  if (qty + others > product.stock) {
    item.qty = Math.max(1, product.stock - others);
    return { error: stockMessage(product.stock, others), clamped: true };
  }
  item.qty = qty;
  return {};
}

function updateSalePrice(lineId, rawPrice) {
  const item = findSaleItem(lineId);
  if (!item) return { error: "This product is no longer in the sale." };
  const price = Number(rawPrice);
  if (rawPrice === "" || !Number.isFinite(price)) return { error: "Enter a price." };
  if (price < 0) return { error: "Price can't be negative." };
  item.unitPrice = price;
  return {};
}

function amountFrom(type, value, base) {
  const v = Number(value);
  if (!Number.isFinite(v) || v < 0) return 0;
  return round2(type === "percent" ? (base * Math.min(v, 100)) / 100 : v);
}

function calculateTotals(sale) {
  const subtotal = round2(sale.items.reduce((sum, i) => sum + toNumber(i.qty) * toNumber(i.unitPrice), 0));
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
  const status = { paid: "PAID", partial: "PARTIALLY PAID", unpaid: "UNPAID" }[cls];
  return { payments, paid, remaining, status, cls };
}

function paidError() {
  const raw = String(state.sale.paidValue).trim();
  if (raw === "") return "";
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0) return "Amount paid can't be negative.";
  if (round2(v) > calculateTotals(state.sale).total) return "Amount paid can't be more than the invoice total.";
  return "";
}

function adjustmentError() {
  const s = state.sale;
  for (const [label, type, value] of [["Discount", s.discountType, s.discountValue], ["Tax", s.taxType, s.taxValue]]) {
    if (value === "") continue;
    const v = Number(value);
    if (!Number.isFinite(v) || v < 0) return `${label} can't be negative.`;
    if (type === "percent" && v > 100) return `${label} percentage can't be more than 100.`;
  }
  return "";
}

function validateSale() {
  const errors = [];
  if (state.sale.items.length === 0) errors.push("Add at least one product to the sale.");
  for (const item of state.sale.items) {
    const p = findProduct(item.productId);
    if (!p) { errors.push("A product in this sale no longer exists."); continue; }
    if (!Number.isInteger(item.qty) || item.qty < 1) errors.push(`${p.name}: quantity must be at least 1.`);
    if (!Number.isFinite(item.unitPrice) || item.unitPrice < 0) errors.push(`${p.name}: price can't be negative.`);
  }
  for (const [productId, total] of totalsByProduct(state.sale.items)) {
    const p = findProduct(productId);
    if (p && total > p.stock) errors.push(`${p.name}: ${stockMessage(p.stock)}`);
  }
  const adj = adjustmentError() || paidError();
  if (adj) errors.push(adj);
  if (!Number.isFinite(calculateTotals(state.sale).total)) errors.push("The invoice total is not valid.");
  return errors;
}

// Keeps the sale in line with the inventory (deleted products, stock lowered elsewhere).
function syncSaleWithProducts() {
  const notes = [];
  const used = new Map();   // stock already given to earlier lines of the same product
  state.sale.items = state.sale.items.filter((item) => {
    const p = findProduct(item.productId);
    if (!p) { notes.push("A product was removed from the sale because it no longer exists."); return false; }
    const left = p.stock - (used.get(p.id) || 0);
    if (left < 1) { notes.push(`${p.name} was removed from the sale: out of stock.`); return false; }
    if (item.qty > left) { item.qty = left; notes.push(`${p.name} was reduced to the available stock (${p.stock}).`); }
    used.set(p.id, (used.get(p.id) || 0) + item.qty);
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
    return {
      productId: item.productId,
      name: p ? p.name : "(deleted product)",
      manufacturer: p ? p.manufacturer : "",
      tileSize: p ? p.tileSize : "",
      coveragePerBox: p ? p.coveragePerBox : null,
      sellingUnit: SELLING_UNITS.includes(item.sellingUnit) ? item.sellingUnit : "piece",
      sku: p ? p.sku : "",
      qty: item.qty,
      unitPrice: item.unitPrice,
      total: round2(item.qty * item.unitPrice),
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
    const r = await commit((d) => {
      for (const [productId, total] of totalsByProduct(sale.items)) {
        const p = findProduct(productId, d);
        if (!p) return { error: "A product in this sale no longer exists." };
        if (total > p.stock) return { error: `${p.name}: ${stockMessage(p.stock)}` };
      }
      const invoice = { id: uid(), ...buildInvoiceData(sale, formatInvoiceNumber(d.counter + 1), new Date().toISOString(), d) };
      for (const item of invoice.items) findProduct(item.productId, d).stock -= item.qty;
      d.invoices.push(invoice);
      d.counter = Math.max(d.counter, invoiceSequence(invoice.invoiceNumber));
      return { invoice };
    });
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
    notify(`Sale completed. ${r.invoice.invoiceNumber} saved.` + savedNote(r));
  });
}

async function deleteInvoice(id) {
  const inv = state.invoices.find((i) => i.id === id);
  if (!inv) return;
  if (!confirm(`Delete ${inv.invoiceNumber}? Stock is not changed.`)) return;
  const r = await commit((d) => { d.invoices = d.invoices.filter((i) => i.id !== id); });
  if (r.error) { notify(r.error, "error"); return; }
  renderAll();
  notify(`${inv.invoiceNumber} deleted.` + savedNote(r));
}

// Adds a cash payment (current date/time) to a saved invoice. Items and stock are never touched.
async function addPayment(id, rawAmount) {
  const inv = state.invoices.find((i) => i.id === id);
  if (!inv) return { error: "Invoice not found." };
  const { remaining } = paymentInfo(inv);
  if (remaining <= 0) return { error: "This invoice is already fully paid." };
  const amount = Number(rawAmount);
  if (rawAmount === "" || !Number.isFinite(amount) || amount <= 0) return { error: "Enter a payment amount greater than 0." };
  if (round2(amount) > remaining) return { error: "Payment cannot be greater than the remaining balance." };

  return commit((d) => {
    const target = d.invoices.find((i) => i.id === id);
    if (!target) return { error: "Invoice not found." };
    if (round2(amount) > paymentInfo(target).remaining) return { error: "Payment cannot be greater than the remaining balance." };
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
  $("logoPreview").innerHTML = logo ? `<img src="${esc(logo)}" alt="Store logo">` : '<span class="muted small">No logo</span>';
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
  notify((dataUrl ? "Logo saved." : "Logo removed.") + savedNote(r));
}

// Reads a PNG, shrinks it to fit LOGO_MAX_W x LOGO_MAX_H (never enlarges, keeps transparency) and saves it.
function chooseLogo(file) {
  showError("logoError", "");
  if (!file) return;
  if (file.type !== "image/png" && !/\.png$/i.test(file.name)) { showError("logoError", "Please choose a PNG image."); return; }
  const reader = new FileReader();
  reader.onerror = () => showError("logoError", "That file could not be read.");
  reader.onload = () => {
    const img = new Image();
    img.onerror = () => showError("logoError", "That file is not a valid PNG image.");
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
  if (stock <= 0) return ' <span class="badge out">Out of stock</span>';
  if (stock <= LOW_STOCK) return ' <span class="badge low">Low stock</span>';
  return "";
}

function renderResults() {
  const box = $("results");
  const query = $("search").value;

  if (state.products.length === 0) {
    state.results = [];
    box.innerHTML =
      '<div class="empty"><p><strong>No products yet.</strong></p>' +
      '<p class="muted">Add your first product to start selling.</p>' +
      '<div class="actions"><button type="button" class="btn primary" data-action="goto-add">Add Product</button>' +
      '<button type="button" class="btn" data-action="demo">Load Demo Data</button></div></div>';
    return;
  }

  state.results = searchProducts(query);
  if (state.results.length === 0) {
    box.innerHTML = `<div class="empty"><p class="muted">No products match "${esc(query)}".</p></div>`;
    return;
  }

  box.innerHTML = state.results.map((p) => {
    const meta = [productDetails(p), p.sku, p.category].filter(Boolean).join(", ");
    const stock = p.stock <= 0 ? "Out of stock" : p.stock <= LOW_STOCK ? `Low stock: ${p.stock}` : `Stock: ${p.stock}`;
    return `<div class="result" role="option" data-id="${esc(p.id)}" aria-selected="${p.id === state.selectedId}">` +
      `<div><div>${esc(productLabel(p))}</div>${meta ? `<div class="meta">${esc(meta)}</div>` : ""}</div>` +
      `<div class="price">${esc(money(p.sellingPrice))}</div>` +
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
      (p.stock > 0 ? `<span>Stock: ${p.stock}</span>` : '<span class="out">Out of stock</span>') +
      (p.stock > 0 && p.stock <= LOW_STOCK ? '<span class="low">Low stock</span>' : "") +
      `<span>Price: ${esc(money(p.sellingPrice))}</span>`
    : '<span class="none">Select a product from the list.</span>';
}

function unitOptions(selected) {
  return SALE_LINE_UNITS.map((u) => `<option value="${u}"${u === selected ? " selected" : ""}>${esc(unitLabel(u))}</option>`).join("");
}

function renderSale() {
  const body = $("saleBody");
  if (state.sale.items.length === 0) {
    body.innerHTML = '<tr class="empty-row"><td colspan="5">No items yet. Search for a product above and add it to the sale.</td></tr>';
  } else {
    body.innerHTML = state.sale.items.map((item) => {
      const p = findProduct(item.productId);
      const name = p ? productLabel(p) : "(deleted product)";
      return `<tr data-id="${esc(item.lineId)}">` +
        `<td><div>${esc(name)}</div><div class="muted small">Available: ${p ? p.stock : 0}</div><div class="error small" data-row-error></div></td>` +
        `<td class="num"><div class="qty-cell"><input class="qty-input" type="number" min="1" step="1" value="${item.qty}" data-field="qty" aria-label="Quantity of ${esc(name)}">` +
        `<select class="unit-select" data-field="unit" aria-label="Unit of ${esc(name)}">${unitOptions(item.sellingUnit)}</select></div></td>` +
        `<td class="num"><input class="price-input" type="number" min="0" step="any" value="${item.unitPrice}" data-field="price" aria-label="Unit price of ${esc(name)}"></td>` +
        `<td class="num" data-line-total>${esc(money(item.qty * item.unitPrice))}</td>` +
        `<td class="num"><button type="button" class="btn small danger" data-action="remove" aria-label="Remove ${esc(name)} from sale">Remove</button></td>` +
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
    if (item) row.querySelector("[data-line-total]").textContent = money(item.qty * item.unitPrice);
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
  const logo = state.settings.logo ? `<img class="inv-logo" src="${esc(state.settings.logo)}" alt="Store logo">` : "";

  const rows = inv.items.length
    ? inv.items.map((i) =>
        `<tr><td>${esc(invoiceItemLabel(i))}</td><td class="num">${num(i.qty)} ${esc(unitLabel(i.sellingUnit))}</td><td class="num">${num(i.unitPrice)}</td><td class="num">${num(i.total != null ? i.total : toNumber(i.qty) * toNumber(i.unitPrice))}</td></tr>`
      ).join("")
    : '<tr><td colspan="4" class="none">No items yet</td></tr>';

  const pay = paymentInfo(inv);
  const hasItems = inv.items.length > 0;
  const paidRows = hasItems
    ? `<tr><td>Total Paid</td><td>${esc(money(pay.paid, cur))}</td></tr><tr class="due"><td>Remaining</td><td>${esc(money(pay.remaining, cur))}</td></tr>`
    : "";
  const history = hasItems
    ? `<div class="inv-status"><span class="${pay.cls}">STATUS: ${pay.status}</span></div>
    <section class="inv-payments"><h3>PAYMENT HISTORY</h3>${
      pay.payments.length
        ? pay.payments.map((p) => `<div class="inv-pay"><span class="when">${esc(formatDateTime(p.timestamp))}</span><span>Paid: ${esc(money(p.amount, cur))}</span></div>`).join("")
        : '<div class="inv-pay"><span class="when">No payments yet.</span></div>'
    }</section>`
    : "";

  return `<header class="inv-head">
      <div>${logo}<div class="inv-biz-name">${esc(biz.name)}</div>${line(biz.address)}${line(biz.phone)}${line(biz.email)}</div>
      <div class="inv-title">INVOICE</div>
    </header>
    <div class="inv-meta">
      <div><div class="label">Customer</div><div class="inv-customer">${esc(cust.name || WALK_IN)}${cust.phone ? "\n" + esc(cust.phone) : ""}${cust.address ? "\n" + esc(cust.address) : ""}</div></div>
      <div class="right"><div><span class="label">Invoice:</span> ${esc(inv.invoiceNumber)}</div><div><span class="label">Date:</span> ${esc(formatDateTime(inv.date))}</div></div>
    </div>
    <table class="inv-table">
      <thead><tr><th>Product</th><th class="num">Qty</th><th class="num">Price (${esc(cur)})</th><th class="num">Total (${esc(cur)})</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <table class="inv-totals">
      <tr><td>Subtotal</td><td>${esc(money(toNumber(inv.subtotal), cur))}</td></tr>
      <tr><td>Discount${pct(inv.discountPercent)}</td><td>${esc(money(toNumber(inv.discount), cur))}</td></tr>
      <tr><td>Tax${pct(inv.taxPercent)}</td><td>${esc(money(toNumber(inv.tax), cur))}</td></tr>
      <tr class="grand"><td>TOTAL</td><td>${esc(money(toNumber(inv.total), cur))}</td></tr>
      ${paidRows}
    </table>
    ${history}
    <p class="inv-thanks">Thank you for your purchase.</p>`;
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
  $("payAmount").placeholder = full ? "Fully paid" : "Max " + numberFormat.format(info.remaining);
}

function renderInvoice() {
  const saved = state.previewInvoice;
  $("invoice").innerHTML = invoiceHtml(saved || draftInvoice());
  $("previewStatus").textContent = saved ? "Saved invoice" : "Live preview";
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
      '<p><strong>No products yet.</strong></p><p class="muted">Add your first product to start selling.</p>' +
      '<div class="actions"><button type="button" class="btn primary" data-action="goto-add">Add Product</button>' +
      '<button type="button" class="btn" data-action="demo">Load Demo Data</button></div>';
  } else if (list.length === 0) {
    empty.innerHTML = `<p class="muted">No products match "${esc($("stockFilter").value)}".</p>`;
  }

  $("stockBody").innerHTML = list.map((p) =>
    `<tr data-id="${esc(p.id)}">` +
    `<td><div>${esc(productLabel(p))}</div>${[productDetails(p), p.category].filter(Boolean).length ? `<div class="muted small">${esc([productDetails(p), p.category].filter(Boolean).join(", "))}</div>` : ""}</td>` +
    `<td>${p.sku ? esc(p.sku) : '<span class="muted">-</span>'}</td>` +
    `<td class="num">${esc(money(p.sellingPrice))}</td>` +
    `<td class="num">${p.stock}${stockBadge(p.stock)}</td>` +
    `<td class="num"><div class="row-actions">` +
    `<button type="button" class="btn small" data-action="dec" aria-label="Decrease stock of ${esc(p.name)} by 1"${p.stock < 1 ? " disabled" : ""}>-</button>` +
    `<button type="button" class="btn small" data-action="inc" aria-label="Increase stock of ${esc(p.name)} by 1">+</button>` +
    `<button type="button" class="btn small" data-action="edit">Edit</button>` +
    `<button type="button" class="btn small danger" data-action="delete">Delete</button>` +
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
  if (!p) { $("restockInfo").textContent = "Add a product first."; return; }
  const raw = $("rQty").value;
  const qty = Number(raw);
  $("restockInfo").textContent = `Current stock: ${p.stock}.` +
    (raw !== "" && Number.isInteger(qty) && qty > 0 ? ` After adding: ${p.stock + qty}.` : "");
}

function searchInvoices(query) {
  const terms = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  return [...state.invoices].reverse().filter((inv) => {
    const c = inv.customer || {};
    const phone = String(c.phone || "");
    const haystack = (inv.invoiceNumber + " " + (c.name || WALK_IN) + " " + phone + " " + phone.replace(/\s+/g, "")).toLowerCase();
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
    ? `<p class="muted">No invoices match "${esc($("invoiceFilter").value)}".</p>`
    : '<p><strong>No invoices yet.</strong></p><p class="muted">Completed sales will appear here.</p>';
  $("invoiceBody").innerHTML = list.map((inv) => {
    const pay = paymentInfo(inv);
    const label = { paid: "Paid", partial: "Partial", unpaid: "Unpaid" }[pay.cls];
    return `<tr data-id="${esc(inv.id)}">` +
      `<td>${esc(inv.invoiceNumber)}</td>` +
      `<td>${esc(formatDate(inv.date))}</td>` +
      `<td>${esc((inv.customer && inv.customer.name) || WALK_IN)}</td>` +
      `<td class="num">${esc(money(toNumber(inv.total), inv.currency))}</td>` +
      `<td class="num">${esc(money(pay.paid, inv.currency))}</td>` +
      `<td class="num">${esc(money(pay.remaining, inv.currency))}</td>` +
      `<td><span class="badge ${pay.cls}">${label}</span></td>` +
      `<td class="num"><div class="row-actions">` +
      `<button type="button" class="btn small" data-action="view">View</button>` +
      `<button type="button" class="btn small" data-action="pay"${pay.remaining <= 0 ? " disabled" : ""}>Add Payment</button>` +
      `<button type="button" class="btn small" data-action="print">Print</button>` +
      `<button type="button" class="btn small danger" data-action="delete">Delete</button>` +
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
  else notify("Paper size set to " + paper + "." + savedNote(r));
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
    text = storage.supported
      ? "The data file is not connected, so changes are saved in this browser only."
      : "This browser cannot save to a data file, so changes are saved in this browser only. Use Chrome or Edge, and use Export Backup regularly.";
    if (storage.supported) { action = "settings"; label = "Set up data file"; }
  } else if (m === "disconnected") {
    text = storage.reason + " Changes are blocked until the data file is reconnected.";
    action = storage.handle ? "reconnect" : "choose";
    label = storage.handle ? "Reconnect" : "Choose Data File";
  }
  const banner = $("storageBanner");
  banner.hidden = !text;
  banner.classList.toggle("blocked", m === "disconnected");
  $("bannerText").textContent = text;
  $("bannerAction").hidden = !action;
  $("bannerAction").textContent = label;
  $("bannerAction").dataset.action = action;
  updateBannerHeight();

  const stateText = {
    connecting: "Checking...",
    connected: "Connected",
    unlinked: storage.supported ? "Not connected" : "Not available in this browser",
    disconnected: "Disconnected",
  }[m];
  $("dataFile").textContent = (storage.fileName || DATA_FILE_NAME) + (connected ? "" : " (not connected)");
  $("dataState").textContent = stateText;
  $("dataState").className = "state-" + m;
  $("dataSaved").textContent = state.lastSaved ? formatDateTime(state.lastSaved) + (connected ? "" : " (browser copy)") : "Never";
  $("dataNote").textContent = (connected
    ? "Every change is saved to this file automatically. Keep it with the Invoisy folder and back it up regularly."
    : m === "disconnected" ? storage.reason
    : "Changes are saved in this browser only. Use Export Backup regularly.") +
    (storage.mirrorOk ? "" : " The browser recovery copy could not be updated.");
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
    state.results = searchProducts(search.value);
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
      notify(`${numberFormat.format(c.area)} m² = ${c.boxes} box${c.boxes === 1 ? "" : "es"} (${numberFormat.format(c.coverage)} m² per box).`);
    }
    state.selectedId = null;
    state.previewInvoice = null;
    search.value = "";
    $("addQty").value = 1;
    $("addUnit").value = "piece";
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
      const result = updateSaleUnit(unitSelect.closest("tr").dataset.id, unitSelect.value);
      if (result.merged) {
        state.previewInvoice = null;
        renderSale();
        renderInvoice();
        return;
      }
      unitSelect.closest("tr").querySelector("[data-row-error]").textContent = result.error || "";
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
      notify("Payment added." + savedNote(result));
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
      notify("Settings saved." + savedNote(r));
      fillSettingsForm();
      renderAll();
    });
  });

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
    validateSale,
    syncSaleWithProducts,
    getSale: () => state.sale,
    productProblem,
    productLabel,
    invoiceItemLabel,
    readProductForm,
    buildData,
    buildPayload,
    parseDataText,
    applyData,
    commit,
    readMirror,
    DEFAULT_SETTINGS,
  });
} else {
  const startupNotices = loadLocalCopy();
  bindEvents();
  resetProductForm();
  showView("sell");
  renderStorage();
  storage.ready = initStorage(startupNotices).catch((e) => {
    setStorageMode("disconnected", "The data file could not be opened. " + errorText(e));
  });
}

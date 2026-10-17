"use strict";

/* ==========================================================================
   Simple Invoice - products, stock, sales and invoices in the browser.
   Data is saved in the browser's IndexedDB database (database.js); backups are JSON files.
   No backend, no dependencies.
   ========================================================================== */

/* ---------- Configuration ---------- */

// The data rules (setting defaults, units, ids, invoice numbers) live in validation.js; unit and price maths in calc.js.
const { CURRENCY, DEFAULT_SETTINGS, SELLING_UNITS, round2, toNumber, uid, formatInvoiceNumber, invoiceSequence } = Validation;
// These two names are saved inside invoices exactly as written here, so the data file does not depend on the
// language. They are translated only when shown (see customerLabel and invoiceItemLabel).
const WALK_IN = "Walk-in Customer";
const DELETED_PRODUCT = "(deleted product)";
const LOW_STOCK = 5;              // stock at or below this shows "Low stock"
const LOGO_MAX_W = 320;           // stored logo size (shown at 160x100 max, 2x keeps it sharp)
const LOGO_MAX_H = 200;

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

// The optional second customer name of an invoice or of the sale being prepared ("" when there is none).
function secondCustomerName(record) {
  const second = record && record.secondCustomer;
  return second && typeof second.name === "string" ? second.name.trim() : "";
}

// The customer block of an invoice or collection document. One customer reads exactly as before; with a second
// name, a labelled line is added below the first customer's details.
function customerBlockHtml(inv, cust) {
  const second = secondCustomerName(inv);
  return `<div><div class="label">${esc(t("inv.customer"))}</div><div class="inv-customer">${esc(customerLabel(cust.name))}${cust.phone ? "\n" + esc(cust.phone) : ""}${cust.address ? "\n" + esc(cust.address) : ""}</div>` +
    (second ? `<div class="label inv-second-label">${esc(t("inv.secondCustomer"))}</div><div class="inv-customer">${esc(second)}</div>` : "") + `</div>`;
}

// The phone line of a business header (an invoice, a collection document). One number, or the single number older invoices have,
// reads exactly as before. Several numbers share one compact line, each kept whole, separated by a dot, so the header stays tidy.
function businessPhonesHtml(biz) {
  const phones = Validation.businessPhones(biz);
  if (!phones.length) return "";
  if (phones.length === 1) return `<div>${esc(phones[0])}</div>`;
  return `<div class="inv-phones">${phones.map((p) => `<span class="inv-phone">${esc(p)}</span>`).join('<span class="inv-sep"> · </span>')}</div>`;
}

/* ---------- Data model ---------- */

// Units a line on a sale can be sold in. The unit belongs to the sale line, not to the product.
// m² is a real selling unit: a line sold by the m² keeps its area and its price per m²; stock is taken out
// converted to the product's stock unit by Calc (fractions of a box included).
const SALE_LINE_UNITS = ["piece", "box", "m2", "kg", "m"];
// "Box", or "Boxes" when given a quantity other than 1, in the current language; "" for no/unknown unit.
const unitLabel = Calc.unitLabel;

// What a product, an invoice, the settings and a backup file may contain is defined in validation.js.
const { normalizeProduct, normalizeTileSize, isTileSize, productProblem, buildData } = Validation;

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

// "1,000 DA / m² · 300 DA / piece · 1,440 DA / box": every price the product has, each with its own unit.
// A product saved without a price unit shows just the amount.
function priceLabel(product) {
  const prices = Calc.getSellingPrices(product);
  if (prices.length === 0) return money(product.sellingPrice);
  return prices.map((entry) => `${money(entry.price)} / ${Calc.unitLabel(entry.unit)}`).join(" · ");
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

// A product type in the language shown now: Dalle de sol, Faience / Faïence, Porcelain / Porcelaine, Rock / Pierre, Évier, Ciment-colle, Pâte à joint.
// A type saved under an old spelling (Daldosol, Daltosol) reads as the current one; "" when the product has no type.
function productTypeLabel(type) {
  const value = String(type || "").trim();
  if (!value) return "";
  const known = Validation.normalizeProductType(value);
  return known ? t("productType." + known) : value;
}

// The type under the product name, in the same small grey style as the converted quantity ("1,42 m²").
// No type: nothing at all, so the line is exactly what it always was.
function invoiceItemTypeHtml(item) {
  const label = productTypeLabel(item.productType);
  return label ? `<div class="inv-sub">${esc(label)}</div>` : "";
}

// "10 Boxes", "2.5 m²": a quantity with the unit it is counted in.
function qtyText(qty, unit) {
  return numberFormat.format(qty) + (unit ? ` ${unitLabel(unit, qty)}` : "");
}

/* ---------- State ---------- */

function newSale() {
  return {
    items: [],                              // { lineId, productId, qty, sellingUnit, unitPrice }; a line sold beyond the stock also has partial / deliverNow (see deliverNowQty)
    customer: { name: "", phone: "", address: "" },
    secondCustomer: { name: "" },           // optional second name on the same invoice (e.g. the builder when an architect buys); never a debt identity
    discountType: "amount", discountValue: "",
    taxType: "amount", taxValue: "",
    paidValue: "",                          // amount paid now; empty = 0 (nothing paid yet)
    identity: null,                         // the returning customer the person confirmed: { key, name, phone } (see debt.js)
    debts: [],                              // old debt to carry onto this invoice: [{ sourceInvoiceId, amount }]. Draft only until the sale is saved.
  };
}

const state = {
  products: [],
  invoices: [],
  debtTransfers: [],      // the debt-transfer ledger: which unpaid balance of an older invoice was carried to which new invoice
  settings: { ...DEFAULT_SETTINGS },
  counter: 0,
  suppliers: [],          // who the shop buys from (purchases.js); purchases are never mixed with sales
  purchases: [],          // supplier invoices: drafts, confirmed purchases and cancelled ones
  supplierPayments: [],   // money paid to suppliers, one record per payment
  purchaseCounter: 0,     // numbers the internal purchase references (PUR-000001), never goes backwards
  lastSaved: "",          // when the data in the database was last changed
  revision: 0,            // the database revision this page has loaded; every save has to start from it
  view: "sell",
  sale: newSale(),
  results: [],            // products currently listed in the picker
  selectedId: null,       // product selected in the picker
  previewInvoice: null,   // saved invoice shown in the preview (null = live sale)
  editingId: null,        // product being edited in the Stock form
  priceRows: [],          // the selling price rows of the Stock form, as typed: { rowId, unit, price } (kept by stockForm)
  addUnitFor: null,       // product the Sell page unit list was last set up for
  debtUi: { armed: false, dismissedKey: null, suggestions: [], suggestIndex: -1 },   // screen-only: never saved
  invoiceEdit: null,      // the saved invoice being corrected (screen-only until Save changes): see startEditInvoice
  saleDone: null,         // the sale just saved while its "What would you like to do?" dialog is open: { id, number } (screen-only)
  phoneRows: [],          // the business phone numbers of the Settings form, as typed: { rowId, value } (screen-only until saved)
};

function applyData(d) {
  state.products = d.products;
  state.invoices = d.invoices;
  state.debtTransfers = d.debtTransfers || [];
  state.settings = d.settings;
  state.counter = d.counter;
  state.suppliers = d.suppliers || [];
  state.purchases = d.purchases || [];
  state.supplierPayments = d.supplierPayments || [];
  state.purchaseCounter = d.purchaseCounter || 0;
  state.lastSaved = d.lastSaved || "";
  if (d.revision !== undefined) state.revision = d.revision;
  I18n.setLanguage(state.settings.language);
  if (state.previewInvoice) state.previewInvoice = state.invoices.find((i) => i.id === state.previewInvoice.id) || null;
}

function draftFromState() {
  const draft = structuredClone({
    products: state.products, invoices: state.invoices, debtTransfers: state.debtTransfers, settings: state.settings, counter: state.counter,
    suppliers: state.suppliers, purchases: state.purchases, supplierPayments: state.supplierPayments, purchaseCounter: state.purchaseCounter,
  });
  // Scanned supplier invoices are not kept in memory. A change that adds or removes one lists it here, and
  // it is saved in the same transaction as the purchase it belongs to.
  draft.attachments = { put: [], remove: [] };
  return draft;
}

/* ---------- Persistence: the browser database ----------
   The browser's IndexedDB database (database.js) is the only place Invoisy saves data. Every change is built
   on a copy of the data (a draft), then only the records that changed are saved in ONE transaction. The draft
   becomes the live state only after that transaction has committed. Nothing is kept in localStorage or in a
   file any more; if the database can not be used, changes are refused rather than saved somewhere else. */

const db = InvoisyDB.create();

// The automatic backup file (autobackup.js). It listens to the database's "commit" event (see below), so every
// change saved through database.js is covered without any screen having to ask for it.
const autoBackup = AutoBackup.create({ db });

const storage = {
  mode: "connecting",     // connecting | ready | unavailable | failed | outdated
  reason: "",             // why the database can not be used (shown to the person)
  migrationFailed: false,
  migrationUnreadable: false,   // the older data exists but none of it could be read
  migration: null,        // record of the move from the storage older versions used
  backup: { lastBackupAt: null, lastBackupFile: "", lastBackupCounts: null, intervalDays: Validation.DEFAULT_BACKUP_DAYS },
  persisted: null,        // true / false once the browser says whether it will keep the data; null = unknown
  usage: null,
  quota: null,
  ready: Promise.resolve(),
};

function errorText(e) {
  return (e && e.message) || "";
}

function setStorageMode(mode, reason) {
  storage.mode = mode;
  storage.reason = reason || "";
  renderStorage();
}

function canWrite() {
  return storage.mode === "ready";
}

function blockedMessage() {
  const why = storage.mode === "connecting" ? t("storage.opening") : storage.reason;
  return t("storage.notChanged", { reason: why });
}

// Reads the older browser storage. window.localStorage can be blocked by browser settings, which is not an error here.
function legacyStorage() {
  try {
    if (typeof localStorage !== "undefined" && localStorage) return localStorage;
  } catch { /* blocked by the browser */ }
  return { getItem() { return null; }, removeItem() {} };
}

// Reloads everything from the database. Used at start, after a restore and when another window saved first.
async function loadFromDatabase() {
  applyData(await db.loadAll());
}

// Turns a failed save into a message. A conflict means another window saved first: its data is loaded so the
// screen is up to date, and nothing from this change was saved.
async function describeSaveFailure(e) {
  const err = e instanceof InvoisyDB.DbError ? e : new InvoisyDB.DbError("ABORTED", InvoisyDB.MSG.ABORTED + " " + errorText(e));
  if (err.code === "CONFLICT") {
    try {
      await loadFromDatabase();
      refreshAfterLoad();
    } catch { /* the message below still tells the person what to do */ }
    return t("storage.conflictReload", { message: err.message });
  }
  if (err.code === "CLOSED") setStorageMode("outdated", err.message);
  return err.message;
}

async function persistData(draft) {
  const changes = InvoisyDB.diff(
    {
      products: state.products, invoices: state.invoices, debtTransfers: state.debtTransfers, settings: state.settings, counter: state.counter,
      suppliers: state.suppliers, purchases: state.purchases, supplierPayments: state.supplierPayments, purchaseCounter: state.purchaseCounter,
    },
    draft
  );
  if (InvoisyDB.isEmptyChange(changes)) return { unchanged: true };
  try {
    const saved = await db.commitChanges(changes, { expectedRevision: state.revision });
    return { revision: saved.revision, lastSaved: saved.lastSaved };
  } catch (e) {
    return { error: await describeSaveFailure(e) };
  }
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
// or any extra result fields. The live state only changes after the database has committed the change.
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
    if (saved.unchanged) return result;
    applyData({ ...draft, lastSaved: saved.lastSaved, revision: saved.revision });
    try { renderStorage(); } catch { /* the data is saved; only the status line failed to refresh */ }
    return result;
  });
}

let busy = false;
async function guard(task) {
  if (busy) return;
  busy = true;
  try { renderStorage(); } catch { /* status only */ }
  try {
    await task();
  } catch (e) {
    notify(t("app.somethingWrong", { error: errorText(e) }), "error");
  } finally {
    busy = false;
    try { renderStorage(); } catch { /* status only */ }
  }
}

/* -- Starting up: open the database, move older data over once, load -- */

// "12 products, 40 invoices", plus suppliers and purchases when there are any. `d` holds lists or counts.
function describeData(d) {
  const count = (v) => (Array.isArray(v) ? v.length : Number(v) || 0);
  const parts = [tn("storage.countProducts", count(d.products)), tn("storage.countInvoices", count(d.invoices))];
  if (count(d.suppliers)) parts.push(tn("storage.countSuppliers", count(d.suppliers)));
  if (count(d.purchases)) parts.push(tn("storage.countPurchases", count(d.purchases)));
  return parts.join(", ");
}

function reportDataProblem(message) {
  showError("dataError", message);
  notify(message, "error");
  return false;
}

async function refreshBackupInfo() {
  try {
    storage.backup = await db.getBackupInfo();
    $("backupDays").value = storage.backup.intervalDays;
  } catch { /* keep what was known */ }
}

// Asks whether the browser promises to keep the data. This only reads; it never shows a browser prompt.
async function refreshQuota() {
  try {
    if (typeof navigator !== "undefined" && navigator.storage) {
      if (navigator.storage.persisted) storage.persisted = await navigator.storage.persisted();
      if (navigator.storage.estimate) {
        const estimate = await navigator.storage.estimate();
        storage.usage = estimate.usage;
        storage.quota = estimate.quota;
      }
    }
  } catch { /* optional information */ }
  renderStorage();
}

// Only when the person presses the button: some browsers show a permission prompt for this.
async function askBrowserToKeepData() {
  try {
    if (navigator.storage && navigator.storage.persist) storage.persisted = await navigator.storage.persist();
  } catch { /* the answer stays "not protected" */ }
  await refreshQuota();
  notify(t(storage.persisted ? "storage.keepYes" : "storage.keepNo"), storage.persisted ? undefined : "error");
}

function migrationNotice(result) {
  const record = result.record;
  if (!record || record.noticeShown) return "";
  if (result.status === "migrated") return t("storage.noticeMigrated", { counts: describeData(record.counts) });
  if (result.status === "conflict") return t("storage.noticeConflict");
  if (record.legacyDataFile) return t("storage.noticeDataFile", { file: record.legacyDataFile });
  return "";
}

async function initStorage() {
  try {
    await db.initDatabase();
  } catch (e) {
    setStorageMode(e.code === "UNAVAILABLE" ? "unavailable" : "failed", errorText(e));
    return;
  }

  let notice = "";
  try {
    const migrated = await db.migrateLegacy(legacyStorage());
    storage.migration = migrated.record;
    storage.migrationFailed = false;
    storage.migrationUnreadable = false;
    notice = migrationNotice(migrated);
    if (notice) db.updateMigrationRecord({ noticeShown: true }).catch(() => {});
  } catch (e) {
    const unreadable = e && e.code === "MIGRATION";
    storage.migrationFailed = true;
    storage.migrationUnreadable = unreadable;
    setStorageMode("failed", t(unreadable ? "storage.migrationUnreadable" : "storage.migrationFailed", { error: errorText(e) }));
    return;
  }

  try {
    await loadFromDatabase();
  } catch (e) {
    setStorageMode("failed", t("storage.readFailed", { error: errorText(e) }));
    return;
  }
  await refreshBackupInfo();
  setStorageMode("ready");
  refreshAfterLoad();
  refreshQuota();
  // Reconnects to the backup file chosen earlier and, if the database is ahead of it, brings it up to date. This
  // never waits for the file, never prompts, and a problem with the file never affects the database.
  autoBackup.start().catch(() => {});
  if (notice) notify(notice);
}

function startStorage() {
  storage.ready = initStorage().catch((e) => {
    setStorageMode("failed", t("storage.openFailed", { error: errorText(e) }));
  });
  return storage.ready;
}

/* -- Backup: export and restore -- */

// Hands a text file to the browser as a download. The temporary address is released afterwards.
function downloadText(text, name, type) {
  const url = URL.createObjectURL(new Blob([text], { type: type || "application/json" }));
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
}

// Export Backup: reads the database (not the copy on screen), checks the file, downloads it, and only then
// records the backup date. Invoisy can not see where the downloaded file ends up or whether it is kept.
function exportBackup() {
  return guard(async () => {
    showError("dataError", "");
    await storage.ready;
    if (storage.mode !== "ready") { reportDataProblem(blockedMessage()); return; }
    let snapshot;
    try {
      snapshot = await db.loadAll({ withAttachments: true });
    } catch (e) {
      reportDataProblem(t("storage.exportReadFailed", { error: errorText(e) }));
      return;
    }
    const file = Validation.prepareBackupFile(snapshot, new Date());
    if (file.error) { reportDataProblem(t("storage.exportNoDate", { error: file.error })); return; }
    try {
      downloadText(file.text, file.name);
    } catch (e) {
      reportDataProblem(t("storage.exportDownloadFailed", { error: errorText(e) }));
      return;
    }
    try {
      await db.recordBackup({ at: new Date().toISOString(), fileName: file.name, counts: file.counts });
      await refreshBackupInfo();
    } catch (e) {
      renderStorage();
      notify(t("storage.exportDateFailed", { error: errorText(e) }), "error");
      return;
    }
    renderStorage();
    notify(t("storage.backupExported", { name: file.name, counts: describeData(file.counts) }));
  });
}

// Import / Restore Backup: checks the whole file first, asks, downloads a safety copy of the current data,
// then replaces everything in ONE transaction. A restore that fails changes nothing.
function importBackup(file) {
  return guard(async () => {
    showError("dataError", "");
    if (!file) return;
    await storage.ready;
    if (!canWrite()) { reportDataProblem(blockedMessage()); return; }
    let text;
    try {
      text = await file.text();
    } catch {
      reportDataProblem(t("storage.fileUnreadable"));
      return;
    }
    const parsed = Validation.parseBackup(text);
    if (parsed.error) {
      reportDataProblem(t("storage.badBackup", { error: parsed.error }));
      return;
    }
    const incoming = parsed.data;
    const made = formatDateTime(parsed.exportedAt) || t("storage.unknown");
    const nextNumber = formatInvoiceNumber(Math.max(state.counter, incoming.counter) + 1);
    const noted = parsed.warnings.slice(0, 3).map((w) => "\n- " + w).join("") + (parsed.warnings.length > 3 ? "\n- " + t("storage.andMore", { n: parsed.warnings.length - 3 }) : "");
    const ok = confirm(t("storage.confirmRestore", {
      backup: describeData(incoming), made, current: describeData(state), next: nextNumber,
      notes: noted ? "\n\n" + t("storage.noteHeading") + noted : "",
    }));
    if (!ok) { notify(t("storage.restoreCancelled")); return; }

    const outcome = await enqueue(async () => {
      let before;
      try {
        before = await db.loadAll({ withAttachments: true });
      } catch (e) {
        return { error: t("storage.restoreReadFailed", { error: errorText(e) }) };
      }
      let safetyName = "";
      if (Validation.hasMeaningfulData(before)) {
        const safety = Validation.prepareBackupFile(before, new Date(), "invoisy-before-restore");
        if (safety.error) return { error: t("storage.safetyMakeFailed", { error: safety.error }) };
        try {
          downloadText(safety.text, safety.name);
          safetyName = safety.name;
        } catch (e) {
          return { error: t("storage.safetyDownloadFailed", { error: errorText(e) }) };
        }
      }
      try {
        const done = await db.restore(incoming, { expectedRevision: before.revision });
        await loadFromDatabase();
        return { done, safetyName };
      } catch (e) {
        return { error: await describeSaveFailure(e) };
      }
    });
    if (outcome.error) { reportDataProblem(outcome.error); return; }
    PurchasesUI.reset();   // an open supplier, purchase or form may point at data the backup replaced
    refreshAfterLoad();
    notify(t("storage.restored", { counts: describeData(outcome.done.counts) }) + (outcome.safetyName ? " " + t("storage.restoredSafety", { name: outcome.safetyName }) : ""));
  });
}

/* -- Automatic backup file: choose it, grant access again, retry -- */

// Is what a file holds the same data as the database? Both sides went through the same reader, so they compare directly.
function sameBackupData(a, b) {
  const pick = (d) => ({
    products: d.products, invoices: d.invoices, debtTransfers: d.debtTransfers || [], settings: d.settings, counter: d.counter,
    suppliers: d.suppliers || [], purchases: d.purchases || [], supplierPayments: d.supplierPayments || [],
    attachments: d.attachments || [], purchaseCounter: d.purchaseCounter || 0,
  });
  return Validation.sameValue(pick(a), pick(b));
}

// Choose backup file. A file that already holds something is never replaced quietly: it must be an Invoisy backup,
// Invoisy must have data of its own (an empty Invoisy never overwrites a file that has data: restore it first),
// the person confirms, and a copy of the file as it is now is downloaded. Nothing is ever restored from here.
function connectBackupFile() {
  return guard(async () => {
    showError("dataError", "");
    let chosen;
    try {
      chosen = await autoBackup.pickFile();   // first, while the click still counts
    } catch (e) {
      reportDataProblem(t("auto.pickFailed", { error: errorText(e) }));
      return;
    }
    if (!chosen) return;   // cancelled
    await storage.ready;
    if (!canWrite()) { reportDataProblem(blockedMessage()); return; }

    let current;
    try {
      current = await db.loadAll({ withAttachments: true });
    } catch (e) {
      reportDataProblem(t("storage.readFailed", { error: errorText(e) }));
      return;
    }
    const seen = await autoBackup.inspect(chosen);
    if (seen.kind === "unreadable") { reportDataProblem(seen.error); return; }
    if (seen.kind === "foreign") { reportDataProblem(t("auto.notBackup", { error: seen.error })); return; }

    if (seen.kind === "invoisy") {
      const mine = Validation.prepareBackupFile(current, new Date());
      if (mine.error) { reportDataProblem(mine.error); return; }
      if (!sameBackupData(Validation.parseBackup(mine.text).data, seen.parsed.data)) {
        const inFile = describeData(seen.parsed.data);
        if (!Validation.hasMeaningfulData(current)) { reportDataProblem(t("auto.fileHasData", { file: inFile })); return; }
        const made = formatDateTime(seen.parsed.exportedAt) || t("storage.unknown");
        if (!confirm(t("auto.confirmReplace", { file: inFile, made, current: describeData(current) }))) { notify(t("auto.cancelled")); return; }
        try {
          downloadText(seen.text, Validation.backupFileName(new Date(), "invoisy-before-autobackup"));
        } catch (e) {
          reportDataProblem(t("auto.safetyFailed", { error: errorText(e) }));
          return;
        }
      }
    }

    let result;
    try {
      result = await autoBackup.attach(chosen);
    } catch (e) {
      reportDataProblem(errorText(e));
      return;
    }
    const parts = [];
    let kind;
    if (result.status.state === "current") {
      parts.push(t("auto.connected", { name: result.status.fileName }));
    } else {
      parts.push(t("auto.connectedPending", { error: result.status.error }));
      kind = "error";
    }
    if (!result.remembered) { parts.push(t("auto.notRemembered")); kind = "error"; }
    notify(parts.join(" "), kind);
  });
}

function reportAutoBackupResult(status) {
  if (status.state === "needs-permission") notify(t("auto.permissionStillNeeded"), "error");
  else if (status.state === "current") notify(t("auto.nowCurrent"));
  else if (status.error) notify(status.error, "error");
}

// Needs a click: the browser only shows its permission question after one.
function grantBackupPermission() {
  return guard(async () => { reportAutoBackupResult(await autoBackup.grant()); });
}

function retryBackupFile() {
  return guard(async () => { reportAutoBackupResult(await autoBackup.retry()); });
}

function saveBackupInterval() {
  return guard(async () => {
    const days = Number($("backupDays").value);
    if (!Number.isInteger(days) || days < 1 || days > 365) { reportDataProblem(t("storage.intervalInvalid")); return; }
    try {
      await db.setBackupInterval(days);
    } catch (e) {
      reportDataProblem(errorText(e));
      return;
    }
    showError("dataError", "");
    await refreshBackupInfo();
    renderStorage();
    notify(tn("storage.intervalSaved", days));
  });
}

/* -- Older browser data (what earlier versions saved in localStorage) -- */

function downloadLegacyCopy() {
  return guard(async () => {
    showError("dataError", "");
    const file = Validation.prepareLegacyCopy(legacyStorage(), new Date());
    if (file.error) { reportDataProblem(file.error); return; }
    try {
      downloadText(file.text, file.name);
    } catch (e) {
      reportDataProblem(t("storage.downloadFailed", { error: errorText(e) }));
      return;
    }
    try {
      if (storage.migration) storage.migration = await db.updateMigrationRecord({ legacyCopyDownloadedAt: new Date().toISOString() }) || storage.migration;
    } catch { /* the copy was still downloaded */ }
    renderStorage();
    notify(t("storage.legacyCopyDownloaded", { name: file.name }));
  });
}

function removeLegacyCopy() {
  return guard(async () => {
    showError("dataError", "");
    if (!confirm(t("storage.confirmRemoveLegacy"))) return;
    try {
      await db.removeLegacyData(legacyStorage());
      storage.migration = await db.getMigrationRecord();
    } catch (e) {
      reportDataProblem(errorText(e));
      return;
    }
    renderStorage();
    notify(t("storage.legacyRemoved"));
  });
}

// For data that could not be read at all: starts with an empty database. The older data stays where it is.
function skipLegacyMigration() {
  return guard(async () => {
    if (!confirm(t("storage.confirmSkip"))) return;
    try {
      await db.skipMigration("The older data could not be read and the person chose to start empty.");
    } catch (e) {
      reportDataProblem(errorText(e));
      return;
    }
    await startStorage();
  });
}

db.on("blocked", () => { if (storage.mode === "connecting") setStorageMode("connecting", InvoisyDB.MSG.BLOCKED); });
db.on("versionchange", () => setStorageMode("outdated", t("storage.versionChanged")));
db.on("closed", () => { if (storage.mode === "ready") setStorageMode("outdated", t("storage.connectionClosed")); });
// Another window saved: pick up its data (queued behind anything this window is saving).
db.on("change", (message) => {
  if (message.revision <= state.revision) return;
  enqueue(async () => {
    if (!canWrite()) return;
    await loadFromDatabase();
    refreshAfterLoad();
  }).catch(() => {});
});
// The automatic backup file. "commit" comes from database.js after a transaction in THIS window really committed
// a change; "change" is another window's commit (that window may not have the file connected, this one may).
db.on("commit", (message) => autoBackup.notifyCommitted(message.revision));
db.on("change", (message) => autoBackup.notifyCommitted(message.revision));
autoBackup.on(() => { try { renderStorage(); } catch { /* status only */ } });

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
      const haystack = (p.name + " " + (p.manufacturer || "") + " " + p.tileSize + " " + p.sku + " " + p.category).toLowerCase();
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

// The Stock form is the shared product form (product-form.js) with its prices kept in this page's state. A product made
// while recording a purchase uses the same form and the same rules (see purchases-ui.js).
const stockForm = ProductForm.create({
  prefix: "p",
  holder: state,
  products: () => state.products,
  editing: () => (state.editingId ? findProduct(state.editingId) : null),
  onError: (message) => showError("productError", message),
});

// { values } to save, or { field: id of the box, error }.
function readProductForm() {
  return stockForm.read();
}

async function addProduct(values) {
  const r = await commit((d) => { d.products.push({ id: uid(), manufacturer: "", ...values }); });
  if (r.error) {
    showError("productError", r.error);
    notify(r.error, "error");
    return;
  }
  resetProductForm();
  renderAll();
  notify(t("product.added", { label: productLabel(values) }));
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
  notify(t("product.updated", { label: productLabel(values) }));
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
  notify(t("product.deleted", { name: product.name }));
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

/* ---------- Similar products (Stock form) ----------
   While a name is typed the form lists the products already in stock that look like it (Validation.suggestProducts), so a
   duplicate is noticed before it is made. It reads state.products, which is already in memory (no database read per key),
   and it only shows: a suggestion can be opened to review/edit or used to add stock, nothing is merged or deleted. A new
   variant (another size) can still be added. */

function productSuggestions() {
  return Validation.suggestProducts($("pName").value, state.products, { exceptId: state.editingId });
}

function suggestionHtml(p, typedSize) {
  const type = Validation.normalizeProductType(p.productType);
  const details = [p.tileSize, type ? t("productType." + type) : "", p.manufacturer].filter(Boolean);
  const same = typedSize && Calc.normalizeTileSize(p.tileSize) === typedSize;
  return `<li class="similar-item" data-id="${esc(p.id)}">` +
    `<div class="similar-text"><strong>${esc(p.name)}</strong>` +
    `<span class="muted small">${esc(details.length ? details.join(" · ") : t("stock.similar.noDetails"))}</span>` +
    (same ? `<span class="similar-same small">${esc(t("stock.similar.sameSize"))}</span>` : "") + `</div>` +
    `<div class="similar-actions"><button type="button" class="btn small" data-similar="view">${esc(t("stock.similar.view"))}</button>` +
    `<button type="button" class="btn small" data-similar="stock">${esc(t("stock.similar.addStock"))}</button></div></li>`;
}

function renderProductSuggestions() {
  const box = $("productSimilar");
  if (!box) return;
  const query = $("pName").value;
  if (!query.trim()) { box.hidden = true; box.innerHTML = ""; return; }
  const found = productSuggestions();
  const typedSize = Calc.normalizeTileSize($("pTileSize").value);
  box.hidden = false;
  box.innerHTML = found.length
    ? `<p class="small"><strong>${esc(t("stock.similar.title"))}</strong> <span class="muted">${esc(t("stock.similar.hint"))}</span></p><ul class="similar-list">${found.map((p) => suggestionHtml(p, typedSize)).join("")}</ul>`
    : `<p class="muted small">${esc(t("stock.similar.none"))}</p>`;
}

// A suggestion's buttons: open the product to review or edit it, or go straight to adding stock to it.
function useSuggestion(id, action) {
  const p = findProduct(id);
  if (!p) return false;
  if (action === "stock") {
    $("rProduct").value = id;
    renderRestockInfo();
    $("rQty").focus();
  } else startEditProduct(id);
  return true;
}

function startEditProduct(id) {
  const p = findProduct(id);
  if (!p) return;
  state.editingId = id;
  stockForm.fill(p);
  renderProductFormMode();
  clearProductErrors();
  renderProductSuggestions();
  $("pName").focus();
}

function resetProductForm() {
  state.editingId = null;
  stockForm.blank();   // a new product starts with a price per m² (stock counted in boxes)
  renderProductFormMode();
  clearProductErrors();
  renderProductSuggestions();
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
    notify(tn("demo.added", r.added));
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

/* ---------- Delivering only part of a line now ----------
   Normally a sale line leaves with the customer at once, so all of it has to be in stock. When the goods are paid but the
   warehouse has only part of them, the line can be marked "deliver only part now" (partial): the customer takes
   deliverNow, and the rest stays on the invoice to be collected later. Only the quantity delivered now is checked
   against the stock and taken out of it; the quantity, the price and the total of the line stay those of the sale. */

// How much of a line leaves with the customer now, in the unit it is sold in. A line that is not marked hands over everything.
function deliverNowQty(item) {
  return item.partial ? Calc.cleanNumber(Math.max(0, toNumber(item.deliverNow))) : item.qty;
}

// The most of this line that `left` (stock in the product's stock unit) can deliver, in the unit sold; never more than the line.
// Whole units round down, other units to 3 decimals. 0 when the stock can not deliver anything.
function deliverableFrom(product, item, left) {
  if (!(left > 0)) return 0;
  const c = Calc.isUnit(product.stockUnit) ? Calc.convertQuantity(left, product.stockUnit, item.sellingUnit, product) : { value: left };
  if (c.error) return 0;
  const fit = Calc.isWholeUnit(item.sellingUnit) ? Math.floor(c.value + 1e-9) : Math.floor(c.value * 1000 + 1e-9) / 1000;
  return Math.max(0, Math.min(fit, item.qty));
}

// What the stock can deliver now for this line, after the other lines of the same product.
function maxDeliverableNow(item, sale = state.sale, data = state) {
  const p = findProduct(item.productId, data);
  if (!p) return 0;
  return deliverableFrom(p, item, Calc.cleanNumber(p.stock - stockUsedInSale(p.id, [item.lineId], sale, data)));
}

// After the quantity, the unit or the stock changed: a line the person never typed a delivery for follows the stock
// (delivers as much as is available); one they typed keeps their number, lowered if it no longer fits.
function refitDeliverNow(item) {
  const max = maxDeliverableNow(item);
  const typed = Calc.cleanNumber(Math.min(Math.max(0, toNumber(item.deliverNow)), item.qty, max));
  item.deliverNow = item.deliverTouched ? typed : max;
}

// A line that will leave something to collect later.
const leavesRemainder = (item) => Boolean(item.partial) && deliverNowQty(item) < item.qty - Validation.DELIVERY_EPSILON;

// Ticks or unticks "deliver only part now". Unticking a line that is more than the stock brings its quantity back to the stock.
function setSalePartial(lineId, on) {
  const item = findSaleItem(lineId);
  const product = item && findProduct(item.productId);
  if (!item || !product) return { error: t("sale.productUnavailable") };
  if (on) {
    item.partial = true;
    item.deliverTouched = false;
    refitDeliverNow(item);
    return {};
  }
  item.partial = false;
  delete item.deliverNow;
  delete item.deliverTouched;
  const others = stockUsedInSale(item.productId, [lineId]);
  const taken = Calc.stockDeduction(product, item.qty, item.sellingUnit);
  if (!taken.error && !Calc.hasEnoughStock(product.stock, others + taken.value)) {
    item.qty = fitQuantity(product, item.sellingUnit, Calc.cleanNumber(product.stock - others));
    return { error: stockMessage(product, others), clamped: true };
  }
  return {};
}

// The quantity typed in "Deliver now". Returns { error } when it is refused, { error, clamped } when it was brought back to a valid number.
function updateSaleDeliverNow(lineId, rawQty) {
  const item = findSaleItem(lineId);
  const product = item && findProduct(item.productId);
  if (!item || !product) return { error: t("sale.productUnavailable") };
  if (!item.partial) return { error: t("sale.notPartial") };
  const raw = String(rawQty).trim();
  const qty = Number(raw);
  if (raw === "" || !Number.isFinite(qty) || qty < 0) return { error: t("sale.deliverInvalid") };
  if (Calc.isWholeUnit(item.sellingUnit) && !Number.isInteger(qty)) return { error: t("sale.deliverWhole") };
  item.deliverTouched = true;
  if (qty > item.qty + Validation.DELIVERY_EPSILON) {
    item.deliverNow = maxDeliverableNow(item);   // the quantity sold, or less when the stock can not deliver that much
    return { error: t("sale.deliverTooMany", { n: qtyText(item.qty, item.sellingUnit) }), clamped: true };
  }
  const max = maxDeliverableNow(item);
  if (qty > max + Validation.DELIVERY_EPSILON) {
    item.deliverNow = max;
    return { error: t("sale.deliverNoStock", { available: stockText(product) }), clamped: true };
  }
  item.deliverNow = Calc.cleanNumber(qty);
  return {};
}

// Problems with the "deliver now" quantity of the partial lines of a sale.
function deliveryErrors(sale = state.sale, data = state) {
  const errors = [];
  for (const item of sale.items) {
    if (!item.partial) continue;
    const p = findProduct(item.productId, data);
    const now = Number(item.deliverNow);
    const whole = Calc.isWholeUnit(item.sellingUnit);
    if (!Number.isFinite(now) || now < 0 || now > item.qty + Validation.DELIVERY_EPSILON || (whole && !Number.isInteger(now))) {
      errors.push(t("sale.deliverLine", { name: p ? p.name : t("sell.deletedProduct") }));
    }
  }
  return errors;
}

// Stock a product's lines take, in the product's own stock unit (2 boxes = 8 pieces of a piece-counted product).
// Lines in `exceptLineIds` are left out, so one line can be checked against all the others.
function stockUsedInSale(productId, exceptLineIds = [], sale = state.sale, data = state) {
  const product = findProduct(productId, data);
  if (!product) return 0;
  let used = 0;
  for (const i of sale.items) {
    if (i.productId !== productId || exceptLineIds.includes(i.lineId)) continue;
    const d = Calc.stockDeduction(product, deliverNowQty(i), i.sellingUnit);
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
    const d = Calc.stockDeduction(p, deliverNowQty(item), item.sellingUnit);
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

// What a sale line's catalogue price came from, kept on the line so the saved invoice can show it later:
// the unit the price is per, the price, and whether it was saved for that unit ("explicit"), worked out from
// the main price ("calculated") or the price of an old product with no unit ("legacy").
const catalogOf = (priced) => ({ unit: priced.priceUnit, price: priced.basePrice, source: priced.source });

function addToSale(productId, rawQty, rawUnit) {
  const product = findProduct(productId);
  if (!product) return { error: t("product.selectFirst") };
  const typedUnit = SALE_LINE_UNITS.includes(rawUnit) ? rawUnit : "piece";
  const checked = Calc.validateQuantity(rawQty, typedUnit);
  if (checked.error) return { error: checked.error };

  // What is really supplied. A product counted in boxes is handed over in whole boxes, so an area typed in m² becomes
  // boxes here, once (25 m² -> 18 boxes with 1.44 m² per box, see Calc.roundBoxes). From this point the line is a box
  // line: its price, the stock check, the stock taken out, the invoice preview and the print all read the same boxes,
  // and nothing converts or rounds them again. Every other unit is added as typed.
  const supplied = Calc.toSuppliedQuantity(product, checked.value, typedUnit);
  if (supplied.error) return { error: supplied.error };
  const sellingUnit = supplied.unit;
  const qty = supplied.qty;

  // The price of one unit: the price saved for that unit when there is one, else worked out from the main price
  // (1,500 DA per m² -> 2,160 DA per box). Nothing is saved to the product either way.
  const priced = Calc.getUnitPrice(product, sellingUnit);
  if (priced.error) return { error: priced.error };
  // Stock is checked in the product's own stock unit, so 1 box is not the same as 1 piece.
  const taken = Calc.stockDeduction(product, qty, sellingUnit);
  if (taken.error) return { error: taken.error };

  const item = state.sale.items.find((i) => i.productId === productId && i.sellingUnit === sellingUnit);
  // A line marked "deliver only part now" may grow beyond the stock: only what is delivered now has to be in stock.
  if (item && item.partial) {
    item.qty = Calc.cleanNumber(item.qty + qty);
    refitDeliverNow(item);
    return { ok: true };
  }
  const inSale = stockUsedInSale(productId);
  if (!Calc.hasEnoughStock(product.stock, inSale + taken.value)) return { error: stockMessage(product, inSale), lowStock: true };

  if (item) item.qty = Calc.cleanNumber(item.qty + qty);
  else state.sale.items.push({ lineId: uid(), productId, qty, sellingUnit, unitPrice: priced.value, listPrice: priced.value, priceOverridden: false, catalog: catalogOf(priced) });
  // `converted` tells the caller an area was turned into boxes, so the person is told what was added to the sale.
  return supplied.converted ? { ok: true, converted: { requested: supplied.requested, exact: supplied.exact, boxes: qty, area: supplied.area } } : { ok: true };
}

// Why a line already on the sale can't be switched to this unit ("" when it can). A product supplied in boxes is never
// switched to m²: that would bring back an area that is not a whole number of boxes. The area is typed in the add form
// (unit m²), which turns it into boxes. Other problems are the ones the Sell page already reports (unitProblem).
function lineUnitProblem(product, unit) {
  if (unit === "m2" && Calc.suppliesInBoxes(product)) return t("sale.areaInBoxes", { name: product.name });
  return unitProblem(product, unit);
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
  const partial = Boolean(item.partial || (twin && twin.partial));   // such a line is not limited by the stock, only what it delivers now is
  let priced = { value: item.unitPrice };
  if (product) {
    if (rawUnit === "m2" && rawUnit !== item.sellingUnit && Calc.suppliesInBoxes(product)) return { error: lineUnitProblem(product, rawUnit), revert: true };
    priced = Calc.getUnitPrice(product, rawUnit);
    if (priced.error) return { error: priced.error, revert: true };
    const checked = Calc.validateQuantity(newQty, rawUnit);
    if (checked.error) return { error: `${checked.error} (${Calc.unitLabel(rawUnit)})`, revert: true };
    const taken = Calc.stockDeduction(product, newQty, rawUnit);
    if (taken.error) return { error: taken.error, revert: true };
    const others = stockUsedInSale(item.productId, [item.lineId, twin && twin.lineId]);
    if (!partial && !Calc.hasEnoughStock(product.stock, others + taken.value)) return { error: stockMessage(product, others), revert: true };
  }
  item.sellingUnit = rawUnit;
  if (twin) {
    twin.qty = newQty;
    state.sale.items = state.sale.items.filter((i) => i !== item);
    if (partial) {
      twin.partial = true;
      twin.deliverTouched = false;
      refitDeliverNow(twin);
    }
    return { merged: true };
  }
  if (partial) {
    item.deliverTouched = false;   // the number typed was for the old unit
    refitDeliverNow(item);
  }
  // A price typed by hand on this line was for the old unit, so it is replaced by the new unit's price
  // (the saved price for that unit, or the conversion of it). The caller tells the person.
  const priceReset = Boolean(item.priceOverridden);
  item.unitPrice = priced.value;
  item.listPrice = priced.value;
  item.priceOverridden = false;
  if (product) item.catalog = catalogOf(priced);
  return priceReset ? { priceReset: true } : {};
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
  if (item.partial) {
    item.qty = qty;
    refitDeliverNow(item);
    return {};
  }
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
  // and changing the unit later goes back to the calculated price. Money has 2 decimals everywhere
  // in the app, so the price is kept to 2 decimals: the line, the subtotal and the invoice then agree.
  const rounded = Calc.roundMoney(price);
  if (!Number.isFinite(Calc.calculateLineTotal(item.qty, rounded))) return { error: t("sale.enterPrice") };
  item.unitPrice = rounded;
  item.priceOverridden = rounded !== round2(toNumber(item.listPrice));
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

// Old debt carried onto this sale (a draft until the sale is saved) is NOT part of calculateTotals: those totals
// describe the products sold, and discount and tax apply to them only. What the customer owes on this invoice is
// the total of this purchase plus the carried-forward debt.
function saleCarried(sale) {
  return round2((sale.debts || []).reduce((sum, d) => sum + toNumber(d.amount), 0));
}

function saleDue(sale) {
  return round2(calculateTotals(sale).total + saleCarried(sale));
}

// The carried-forward lines a sale will print, worked out from its draft debts (the ids are replaced by real
// transfer ids when the sale is saved, see applySale).
function draftCarriedLines(sale, data = state) {
  const lines = [];
  for (const d of sale.debts || []) {
    const source = data.invoices.find((i) => i.id === d.sourceInvoiceId);
    if (!source) continue;
    lines.push({ transferId: "draft-" + source.id, sourceInvoiceId: source.id, sourceInvoiceNumber: source.invoiceNumber, sourceDate: source.date, amount: round2(toNumber(d.amount)) });
  }
  return lines.sort((a, b) => invoiceSequence(a.sourceInvoiceNumber) - invoiceSequence(b.sourceInvoiceNumber));
}

// Amount received with the sale. An empty field means nothing was paid (never "paid in full").
function salePaid(sale, total) {
  if (String(sale.paidValue).trim() === "") return 0;
  const v = Number(sale.paidValue);
  return Number.isFinite(v) && v > 0 ? Math.min(round2(v), total) : 0;
}

// Total paid, remaining balance and status are always calculated from the payments list
// (the sums are in validation.js; the status is worded here in the current language).
function paymentInfo(inv) {
  const { payments, paid, remaining, cls, due, transferredOut, carried } = Validation.paymentDetail(inv, state.debtTransfers);
  const status = t({ paid: "inv.status.paid", partial: "inv.status.partial", unpaid: "inv.status.unpaid", transferred: "inv.status.transferred" }[cls]);
  return { payments, paid, remaining, status, cls, due, transferredOut, carried };
}
// "INV-000030" or "INV-000030, INV-000031": where an invoice's balance was carried forward to.
function carriedToNumbers(inv, transfers = state.debtTransfers) {
  return [...new Set(Debt.carriedTo(inv, transfers).map((x) => x.number))].join(", ");
}

// What the debt rules need to know about the sale on screen: the invoices, the ledger and the confirmed customer.
function debtContext(sale = state.sale) {
  const resolved = Debt.resolve(sale.customer, Debt.directory(state.invoices, state.debtTransfers), sale.identity);
  return { invoices: state.invoices, transfers: state.debtTransfers, group: resolved.status === "confirmed" ? resolved.group : null, money: (n) => money(n) };
}

function paidError() {
  const raw = String(state.sale.paidValue).trim();
  if (raw === "") return "";
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0) return t("sale.paidNegative");
  if (round2(v) > saleDue(state.sale)) return t("sale.paidTooMuch");
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
  errors.push(...deliveryErrors());
  const needs = stockNeeds(state.sale.items);
  errors.push(...needs.errors);
  for (const [productId, total] of needs.totals) {
    const p = findProduct(productId);
    if (p && !Calc.hasEnoughStock(p.stock, total)) errors.push(t("sale.nameMessage", { name: p.name, message: stockMessage(p) }));
  }
  const adj = adjustmentError() || paidError();
  if (adj) errors.push(adj);
  if (!Number.isFinite(calculateTotals(state.sale).total)) errors.push(t("sale.totalInvalid"));
  errors.push(...Debt.draftProblems(state.sale.debts, debtContext()));
  return errors;
}

// A product's price can change in Stock while it sits in the sale. A line at the normal price follows the
// new saved price; a line with a hand-typed price keeps exactly what was typed (only its reference changes).
function repriceLine(item, product) {
  const priced = Calc.getUnitPrice(product, item.sellingUnit);
  if (priced.error) return;
  item.listPrice = priced.value;
  item.catalog = catalogOf(priced);   // what the line's catalogue price now is (it may be a newly saved price for this unit)
  if (item.priceOverridden && round2(item.unitPrice) !== round2(priced.value)) return;
  item.unitPrice = priced.value;
  item.priceOverridden = false;
}

// Keeps the sale in line with the inventory (deleted products, stock lowered elsewhere).
function syncSaleWithProducts() {
  const notes = [];
  const used = new Map();   // stock (in the product's stock unit) already given to earlier lines of the same product
  state.sale.items = state.sale.items.filter((item) => {
    const p = findProduct(item.productId);
    if (!p) { notes.push(t("sale.removedGone")); return false; }
    repriceLine(item, p);
    const left = Calc.cleanNumber(p.stock - (used.get(p.id) || 0));
    let need = Calc.stockDeduction(p, item.qty, item.sellingUnit);
    if (need.error) { notes.push(t("sale.removedError", { error: need.error })); return false; }
    if (item.partial) {
      // Only what is delivered now has to be in stock: it follows the stock, the quantity sold stays as it is.
      const cap = deliverableFrom(p, item, left);
      const wanted = Calc.cleanNumber(Math.max(0, toNumber(item.deliverNow)));
      const next = item.deliverTouched ? Math.min(wanted, item.qty, cap) : cap;
      if (next < wanted - Validation.DELIVERY_EPSILON) notes.push(t("sale.deliverReduced", { name: p.name, stock: stockText(p) }));
      item.deliverNow = Calc.cleanNumber(next);
      const now = Calc.stockDeduction(p, item.deliverNow, item.sellingUnit);
      if (now.error) { notes.push(t("sale.removedError", { error: now.error })); return false; }
      used.set(p.id, Calc.cleanNumber((used.get(p.id) || 0) + now.value));
      return true;
    }
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
  $("custName2").value = "";
  $("discountValue").value = "";
  $("taxValue").value = "";
  $("amountPaid").value = "";
  $("discountType").value = "amount";
  $("taxType").value = "amount";
  showError("saleError", "");
  showError("addError", "");
  state.previewInvoice = null;
  state.debtUi = { armed: false, dismissedKey: null, suggestions: [], suggestIndex: -1 };   // the next sale starts with a clean slate: the warning shows again
  renderSale();
  renderInvoice();
  renderDebtUi();
}

/* ==========================================================================
   INVOICES
   ========================================================================== */

// One line of a saved invoice, from a sale line (productId, qty, sellingUnit, unitPrice, listPrice, priceOverridden, catalog) and its
// product. Everything the line needs later is saved in it, so a saved invoice never depends on the product's current data.
// `stockDeducted` is what the sale took out of stock for this line (null when it could not be worked out).
// Used when a sale is saved and when a line is added while editing a saved invoice.
function invoiceLineData(item, p, stockDeducted) {
  return {
    productId: item.productId,
    name: p ? p.name : DELETED_PRODUCT,
    productType: p ? Validation.normalizeProductType(p.productType) : "",   // a snapshot, like the name: editing the product later never changes a saved invoice
    manufacturer: p ? p.manufacturer : "",
    tileSize: p ? p.tileSize : "",
    coveragePerBox: p ? p.coveragePerBox : null,
    sellingUnit: SELLING_UNITS.includes(item.sellingUnit) ? item.sellingUnit : "piece",
    sku: p ? p.sku : "",
    qty: item.qty,
    unitPrice: item.unitPrice,
    // The unit the charged unitPrice is for (always the unit sold), kept next to the price so the
    // line never depends on the product's current data to say what the price is per.
    unitPriceUnit: SELLING_UNITS.includes(item.sellingUnit) ? item.sellingUnit : "piece",
    total: Calc.calculateLineTotal(item.qty, item.unitPrice),
    // What the price was worked out from, kept so the line can be audited later. A saved invoice
    // is never recalculated from the product's current price, size or coverage.
    // `priceUnit` / `productPrice` are the catalogue price the line used (the price saved for the unit sold, or the
    // main price it was converted from). `priceSource` says which: explicit, calculated, legacy, or custom (typed here).
    priceUnit: item.catalog ? item.catalog.unit : p ? p.priceUnit : null,
    productPrice: item.catalog ? item.catalog.price : p ? p.sellingPrice : item.unitPrice,
    ...(item.priceOverridden || item.catalog ? { priceSource: item.priceOverridden ? "custom" : item.catalog.source } : {}),
    calculatedUnitPrice: item.listPrice != null ? item.listPrice : item.unitPrice,
    priceOverridden: Boolean(item.priceOverridden),
    stockUnit: p ? p.stockUnit : null,
    // What this line took out of stock with the sale (for a partial line: only what was delivered now).
    stockDeducted,
  };
}

function buildInvoiceData(sale, invoiceNumber, dateIso, data = state) {
  const totals = calculateTotals(sale);
  const carried = draftCarriedLines(sale, data);
  const paid = salePaid(sale, round2(totals.total + round2(carried.reduce((sum, l) => sum + l.amount, 0))));
  // When some line leaves something to collect later, the invoice keeps a delivery log (see Validation.deliveryDetail).
  const tracked = sale.items.some(leavesRemainder);
  const handedOver = [];
  const items = sale.items.map((item) => {
    const p = findProduct(item.productId, data);
    const handed = deliverNowQty(item);
    const taken = p ? Calc.stockDeduction(p, handed, item.sellingUnit) : { error: true };
    if (tracked && handed > 0) handedOver.push({ lineId: item.lineId, qty: handed, stockDeducted: taken.error ? 0 : taken.value });
    return { ...invoiceLineData(item, p, taken.error ? null : taken.value), ...(tracked ? { lineId: item.lineId } : {}) };
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
    // Second customer: its own field, only present when filled in, so older invoices and one-customer invoices keep their shape.
    ...(secondCustomerName(sale) ? { secondCustomer: { name: secondCustomerName(sale) } } : {}),
    items,
    // Debt carried forward from older invoices: its own lines, never products. subtotal, discount, tax and total
    // above stay the figures of this purchase; what the customer owes is total + the carried lines.
    ...(carried.length ? { carriedForward: carried } : {}),
    ...(tracked ? { deliveries: handedOver.length ? [{ id: uid(), type: "sale", date: dateIso, lines: handedOver }] : [] } : {}),
    subtotal: totals.subtotal,
    discount: totals.discount,
    tax: totals.tax,
    total: totals.total,
    payments: paid > 0 ? [{ amount: paid, timestamp: dateIso }] : [],
    discountPercent: sale.discountType === "percent" ? toNumber(sale.discountValue) : null,
    taxPercent: sale.taxType === "percent" ? toNumber(sale.taxValue) : null,
    currency: s.currency,
    business: Validation.businessSnapshot(s),
  };
}

function draftInvoice() {
  return buildInvoiceData(state.sale, formatInvoiceNumber(state.counter + 1), new Date().toISOString());
}

// Turns a sale into a saved invoice on the data draft `d`: checks the stock again, takes the stock out
// (converted to each product's stock unit) and moves the invoice counter on. { invoice } or { error }.
//
// A sale that carries old debt forward also adds its ledger records to the same draft, so the invoice, the stock,
// the counter and the debt transfers are saved in ONE transaction (see persistData / database.js): all or nothing.
// The debt is checked again here against the latest data, and once more inside the database transaction.
function applySale(d, sale) {
  d.debtTransfers = d.debtTransfers || [];
  if (sale.items.some((i) => !findProduct(i.productId, d))) return { error: t("sale.productMissing") };
  const badDelivery = deliveryErrors(sale, d);
  if (badDelivery.length) return { error: badDelivery[0] };
  const needs = stockNeeds(sale.items, d);
  if (needs.errors.length) return { error: needs.errors[0] };
  for (const [productId, total] of needs.totals) {
    const p = findProduct(productId, d);
    if (!Calc.hasEnoughStock(p.stock, total)) return { error: t("sale.nameMessage", { name: p.name, message: stockMessage(p) }) };
  }
  const createdAt = new Date().toISOString();
  const invoice = { id: uid(), ...buildInvoiceData(sale, formatInvoiceNumber(d.counter + 1), createdAt, d) };
  // A returning customer (confirmed from the list, or the exact same name and phone) keeps one id from now on.
  const resolved = Debt.resolve(sale.customer, Debt.directory(d.invoices, d.debtTransfers), sale.identity);
  const customerId = Debt.customerIdFor(resolved);
  if (customerId) invoice.customer.id = customerId;
  if ((sale.debts || []).length) {
    const ctx = { invoices: d.invoices, transfers: d.debtTransfers, group: resolved.status === "confirmed" ? resolved.group : null, money: (n) => money(n) };
    const carried = Debt.buildTransfers(sale.debts, invoice, ctx, createdAt);
    if (carried.error) return { error: carried.error };
    invoice.carriedForward = carried.lines;
    d.debtTransfers.push(...carried.transfers);
  }
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
    // A dialog about the previous sale that is still open is treated as "Later" (the invoice stays saved).
    if (state.saleDone) { state.saleDone = null; closeSaleDoneDialog(); }
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
    notify(t("sell.completed", { number: r.invoice.invoiceNumber }));
    // Only now, with the invoice and its stock committed, is the person asked what to do next.
    openSaleDoneDialog(r.invoice);
  });
}

/* ---------- After a sale: Print Invoice / New Sale / Later ----------
   The dialog opens only after the transaction has committed, so printing always starts from a saved invoice. It remembers
   the id of THAT invoice. Whatever is pressed, the pending record is cleared first, so a second Enter or a rapid second
   click finds nothing to do: no second print, and the sale was already saved once, so no second invoice. */

function openSaleDoneDialog(invoice) {
  state.saleDone = { id: invoice.id, number: invoice.invoiceNumber };
  $("saleDoneNumber").textContent = t("saleDone.number", { number: invoice.invoiceNumber });
  const dialog = $("saleDoneDialog");
  if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "");
  $("saleDonePrint").focus();   // Print Invoice is the default action: Enter prints the invoice that was just saved
}

function closeSaleDoneDialog() {
  const dialog = $("saleDoneDialog");
  if (typeof dialog.close === "function") dialog.close(); else dialog.removeAttribute("open");
}

// action: "print" | "new" | "later". { ignored: true } when nothing is pending (a repeated press).
function saleDoneAction(action) {
  const done = state.saleDone;
  if (!done) return { ignored: true };
  state.saleDone = null;
  closeSaleDoneDialog();
  if (action === "new") {
    state.previewInvoice = null;
    renderInvoice();
    const search = $("search");
    if (search && search.focus) search.focus();
    return { action: "new" };
  }
  if (action === "print") {
    const invoice = state.invoices.find((i) => i.id === done.id);
    if (!invoice) {
      notify(t("saleDone.gone", { number: done.number }), "error");
      return { action: "print", error: true };
    }
    try {
      printInvoice(invoice);
    } catch (e) {
      // The browser refused to print. The invoice is saved and shown in the preview: Print / PDF there tries again.
      notify(t("saleDone.printFailed", { number: done.number }), "error");
      return { action: "print", error: true };
    }
    notify(t("saleDone.afterPrint", { number: done.number }));
    return { action: "print", invoice };
  }
  return { action: "later" };
}

async function deleteInvoice(id) {
  const inv = state.invoices.find((i) => i.id === id);
  if (!inv) return;
  // An invoice sold in several deliveries keeps its delivery log as an audit trail (the database refuses it too).
  if (Validation.isTracked(inv)) {
    notify(t("invoice.cannotDeleteDelivered", { number: inv.invoiceNumber }), "error");
    return;
  }
  // An invoice whose unpaid balance was carried to a newer invoice stays: deleting it would lose that debt.
  if (Debt.carriedTo(inv, state.debtTransfers).length) {
    notify(t("invoice.cannotDeleteCarried", { number: inv.invoiceNumber, numbers: carriedToNumbers(inv) }), "error");
    return;
  }
  const carriedFrom = Validation.carriedLines(inv).map((l) => l.sourceInvoiceNumber).join(", ");
  const question = t("invoice.confirmDelete", { number: inv.invoiceNumber }) + (carriedFrom ? "\n\n" + t("invoice.confirmDeleteRestores", { number: inv.invoiceNumber, from: carriedFrom }) : "");
  if (!confirm(question)) return;
  // Deleting a new invoice also removes the ledger records that carried debt into it, so that balance is
  // collectible on the older invoice again (the database does the same, see commitInTx).
  const r = await commit((d) => {
    d.invoices = d.invoices.filter((i) => i.id !== id);
    d.debtTransfers = (d.debtTransfers || []).filter((tr) => tr.targetInvoiceId !== id);
  });
  if (r.error) { notify(r.error, "error"); return; }
  renderAll();
  onDebtDataChanged();
  notify(t("invoice.deleted", { number: inv.invoiceNumber }));
}

// Adds a cash payment (current date/time) to a saved invoice. Items and stock are never touched.
async function addPayment(id, rawAmount) {
  const inv = state.invoices.find((i) => i.id === id);
  if (!inv) return { error: t("pay.notFound") };
  const { remaining, transferredOut } = paymentInfo(inv);
  // Money owed on a balance that was carried forward is collected on the NEW invoice, never on both.
  if (remaining <= 0) return { error: transferredOut > 0 ? t("pay.transferredMsg", { numbers: carriedToNumbers(inv) }) : t("pay.alreadyPaid") };
  const amount = Number(rawAmount);
  if (rawAmount === "" || !Number.isFinite(amount) || amount <= 0) return { error: t("pay.enterAmount") };
  if (round2(amount) > remaining) return { error: t("pay.tooMuch") };

  const saved = await commit((d) => {
    const target = d.invoices.find((i) => i.id === id);
    if (!target) return { error: t("pay.notFound") };
    if (round2(amount) > Validation.paymentSummary(target, d.debtTransfers).remaining) return { error: t("pay.tooMuch") };
    target.payments.push({ amount: round2(amount), timestamp: new Date().toISOString() });
  });
  // A payment may lower what can still be carried onto the sale on screen.
  if (!saved.error) onDebtDataChanged();
  return saved;
}

/* ---------- Goods collected later (partial delivery) ----------
   Payment and delivery are separate. Recording a collection never touches the invoice's items, prices, total or
   payments: it only appends one entry to the delivery log and takes the delivered goods out of stock, in one transaction. */

// Records one pick-up on the data draft `d` (entries: [{ lineId, qty }], qty as typed; blank = nothing for that line).
// Everything is checked again against the latest data: nothing is delivered beyond what is left to collect, and stock
// can never go below zero. All or nothing: { delivery, invoice } or { error }.
function applyCollection(d, invoiceId, entries, note) {
  const inv = d.invoices.find((i) => i.id === invoiceId);
  if (!inv) return { error: t("collect.notFound") };
  const detail = Validation.deliveryDetail(inv);
  if (!detail.tracked || !detail.toCollect.length) return { error: t("collect.nothingLeft") };
  const lines = [];
  const needs = new Map();
  const seen = new Set();
  for (const entry of entries || []) {
    const raw = String(entry && entry.qty != null ? entry.qty : "").trim();
    if (raw === "") continue;
    const line = detail.lines.find((l) => l.lineId && l.lineId === entry.lineId);
    if (!line || seen.has(line.lineId)) return { error: t("collect.badLine") };
    seen.add(line.lineId);
    const name = invoiceItemLabel(line.item);
    const unit = line.item.sellingUnit;
    const checked = Calc.validateQuantity(raw, unit);
    if (checked.error) return { error: t("collect.lineError", { name, error: checked.error }) };
    const qty = Calc.cleanNumber(checked.value);
    if (qty > line.remaining + Validation.DELIVERY_EPSILON) return { error: t("collect.tooMuch", { name, remaining: qtyText(line.remaining, unit) }) };
    const p = findProduct(line.item.productId, d);
    if (!p) return { error: t("collect.productGone", { name }) };
    const taken = Calc.stockDeduction(p, qty, unit);
    if (taken.error) return { error: t("collect.lineError", { name, error: taken.error }) };
    needs.set(p.id, Calc.cleanNumber((needs.get(p.id) || 0) + taken.value));
    lines.push({ lineId: line.lineId, qty, stockDeducted: taken.value });
  }
  if (!lines.length) return { error: t("collect.enterQty") };
  for (const [productId, total] of needs) {
    const p = findProduct(productId, d);
    if (!Calc.hasEnoughStock(p.stock, total)) return { error: t("collect.noStock", { name: p.name, needed: stockText(p, total), available: stockText(p) }) };
  }
  for (const [productId, total] of needs) {
    const p = findProduct(productId, d);
    p.stock = Math.max(0, Calc.cleanNumber(p.stock - total));
  }
  const text = String(note || "").trim().slice(0, Validation.DELIVERY_NOTE_MAX);
  const delivery = { id: uid(), type: "collection", date: new Date().toISOString(), lines, ...(text ? { note: text } : {}) };
  inv.deliveries.push(delivery);
  return { delivery, invoice: inv };
}

async function recordCollection(id, entries, note) {
  return commit((d) => applyCollection(d, id, entries, note));
}

/* ==========================================================================
   EDITING A SAVED INVOICE
   Corrects an invoice after it was saved (and maybe printed) WITHOUT making a new one: the id, the number, the date, the
   customer link, the payments, the carried-forward debt and the delivery log all stay. What can change is the customer's
   details, the lines (products, quantities, prices) and the discount and tax.

   The rules, all in planInvoiceEdit() so the screen, the tests and the database transaction share them:
     - Stock: what the invoice originally took out of stock (the `stockDeducted` saved on each line, never recalculated from
       today's product data) is given back and what the corrected lines need is taken out, per product, as ONE net change.
       Not enough stock = the whole edit is refused and nothing is changed.
     - History: a line that is kept keeps every saved detail (unit, the price it was sold at, where that price came from, the
       size and coverage it was sold with). Only a quantity or price that was edited changes, and the line total follows. A
       new line is made like a sale line, from the product as it is now.
     - Money: subtotal, discount, tax and total are recalculated only when something financial was edited. Payments are never
       edited or removed; if the new amount due would be lower than what is already paid, the edit is refused.
     - An invoice sold in several deliveries keeps its products and quantities (its delivery log is a record); prices,
       customer, discount and tax can still be corrected.
   applyInvoiceEdit() saves through commit(): invoice + stock in ONE transaction, with the usual revision check and backup. */

// What a saved line took out of stock, in the product's stock unit. Lines saved by older versions may not say: they are
// worked out from the line's OWN saved size and unit, or (no unit known) one-for-one, as such stock always was.
function lineStockTaken(item) {
  if (typeof item.stockDeducted === "number" && Number.isFinite(item.stockDeducted) && item.stockDeducted >= 0) return item.stockDeducted;
  if (Calc.isUnit(item.stockUnit)) {
    const c = Calc.stockDeduction(item, item.qty, item.sellingUnit);
    if (!c.error) return c.value;
  }
  return toNumber(item.qty);
}

// The discount and tax of a saved invoice as the edit form shows them (text, like the Sell page boxes).
function invoiceAdjustInputs(inv) {
  const part = (percent, amount) => (percent != null && percent !== "" ? { type: "percent", value: String(percent) } : { type: "amount", value: toNumber(amount) ? String(amount) : "" });
  const d = part(inv.discountPercent, inv.discount);
  const x = part(inv.taxPercent, inv.tax);
  return { discountType: d.type, discountValue: d.value, taxType: x.type, taxValue: x.value };
}

const clean = (v) => String(v == null ? "" : v).trim();

// Plans the corrected invoice WITHOUT changing anything.
//   edit: { customer: { name, phone, address }, secondName, lines: [{ origIndex | null, productId, sellingUnit, qty, unitPrice }],
//           discountType, discountValue, taxType, taxValue, baseItems? }
//     origIndex = the position of the line on the saved invoice (a kept line); null = a line added now.
//     baseItems = the lines the person started from: when the invoice changed meanwhile (another window), the edit is refused.
// Returns { skip: true } (nothing to change) or { invoice, stockChanges: Map(productId -> new stock), overpaid }, or { error }.
// A problem found after the corrected invoice could be worked out still carries it as `invoice` (the live preview uses it).
function planInvoiceEdit(d, invoiceId, edit) {
  const inv = d.invoices.find((i) => i.id === invoiceId);
  if (!inv) return { error: t("edit.gone") };
  if (edit.baseItems && !Validation.sameValue(edit.baseItems, inv.items)) return { error: t("edit.changedElsewhere") };
  const tracked = Validation.isTracked(inv);
  const lines = Array.isArray(edit.lines) ? edit.lines : [];
  const used = new Set();
  const restore = new Map();   // productId -> stock the invoice holds now, to give back
  const take = new Map();      // productId -> stock the corrected lines need
  const bump = (map, id, n) => map.set(id, Calc.cleanNumber((map.get(id) || 0) + n));
  let linesChanged = lines.length !== inv.items.length;
  const items = [];

  for (const line of lines) {
    if (line.origIndex != null) {
      // ----- a kept line: every saved detail stays unless this edit changes it -----
      const orig = inv.items[line.origIndex];
      if (!orig || used.has(line.origIndex)) return { error: t("edit.changedElsewhere") };
      used.add(line.origIndex);
      const name = invoiceItemLabel(orig);
      const product = findProduct(orig.productId, d);
      const rawQty = clean(line.qty);
      const rawPrice = clean(line.unitPrice);
      const qtyChanged = Number(rawQty) !== orig.qty;
      const priceChanged = rawPrice !== "" ? Number(rawPrice) !== orig.unitPrice : false;
      let item = { ...orig };
      if (qtyChanged) {
        const checked = Calc.validateQuantity(rawQty, orig.sellingUnit);
        if (checked.error) return { error: t("edit.lineError", { name, error: checked.error }) };
        if (tracked) return { error: t("edit.trackedQty", { name }) };
        if (!product) return { error: t("edit.productGone", { name }) };
        if (Calc.isUnit(orig.stockUnit) && Calc.isUnit(product.stockUnit) && orig.stockUnit !== product.stockUnit) return { error: t("edit.stockUnitChanged", { name }) };
        item.qty = Calc.cleanNumber(checked.value);
        // The conversion this line was sold with is kept: its stock use follows the quantity in proportion.
        item.stockDeducted = Calc.cleanNumber(lineStockTaken(orig) * item.qty / orig.qty);
      }
      if (rawPrice === "" || !Number.isFinite(Number(rawPrice)) || Number(rawPrice) < 0) return { error: t("edit.linePrice", { name }) };
      if (priceChanged) {
        item.unitPrice = Calc.roundMoney(Number(rawPrice));
        // Back at the price the line was calculated at: it is a normal price again; any other price is typed by hand.
        const reference = orig.calculatedUnitPrice;
        item.priceOverridden = reference == null || round2(item.unitPrice) !== round2(toNumber(reference));
        if (item.priceOverridden) item.priceSource = "custom";
        else if (item.priceSource === "custom") delete item.priceSource;
      }
      if (!Number.isFinite(Calc.calculateLineTotal(item.qty, item.unitPrice))) return { error: t("edit.linePrice", { name }) };
      if (qtyChanged || priceChanged) { item.total = Calc.calculateLineTotal(item.qty, item.unitPrice); linesChanged = true; }
      if (line.origIndex !== items.length) linesChanged = true;   // moved or an earlier line removed
      // Stock: the invoice's own record of what it took, against what the (possibly new) quantity takes.
      if (product) {
        bump(restore, product.id, lineStockTaken(orig));
        bump(take, product.id, lineStockTaken(item));
      }
      items.push(item);
    } else {
      // ----- a line added now: made like a sale line, from the product as it is today -----
      const product = findProduct(line.productId, d);
      if (!product) return { error: t("sale.productMissing") };
      const unit = line.sellingUnit;
      const name = productLabel(product);
      if (!SALE_LINE_UNITS.includes(unit)) return { error: t("sale.chooseUnit") };
      if (unit === "m2" && Calc.suppliesInBoxes(product)) return { error: t("sale.areaInBoxes", { name: product.name }) };
      const checked = Calc.validateQuantity(clean(line.qty), unit);
      if (checked.error) return { error: t("edit.lineError", { name, error: checked.error }) };
      const priced = Calc.getUnitPrice(product, unit);
      if (priced.error) return { error: priced.error };
      const taken = Calc.stockDeduction(product, checked.value, unit);
      if (taken.error) return { error: taken.error };
      const rawPrice = clean(line.unitPrice);
      const typed = rawPrice === "" ? priced.value : Number(rawPrice);
      if (!Number.isFinite(typed) || typed < 0) return { error: t("edit.linePrice", { name }) };
      const unitPrice = Calc.roundMoney(typed);
      const sold = {
        productId: product.id, qty: Calc.cleanNumber(checked.value), sellingUnit: unit, unitPrice, listPrice: priced.value,
        priceOverridden: unitPrice !== round2(priced.value), catalog: catalogOf(priced),
      };
      if (!Number.isFinite(Calc.calculateLineTotal(sold.qty, sold.unitPrice))) return { error: t("edit.linePrice", { name }) };
      items.push(invoiceLineData(sold, product, taken.value));
      bump(take, product.id, taken.value);
      linesChanged = true;
    }
  }
  if (!items.length) return { error: t("edit.noLines") };
  // A kept line that was removed hands its stock back.
  inv.items.forEach((orig, index) => {
    if (used.has(index)) return;
    const product = findProduct(orig.productId, d);
    if (product) bump(restore, product.id, lineStockTaken(orig));
  });
  if (tracked && (items.length !== inv.items.length || items.some((i, n) => i.lineId !== inv.items[n].lineId || i.qty !== inv.items[n].qty))) return { error: t("edit.trackedLines") };

  // ----- the discount and the tax -----
  const adjust = {
    discountType: edit.discountType === "percent" ? "percent" : "amount", discountValue: clean(edit.discountValue),
    taxType: edit.taxType === "percent" ? "percent" : "amount", taxValue: clean(edit.taxValue),
  };
  for (const [type, value, negativeKey, percentKey] of [
    [adjust.discountType, adjust.discountValue, "sale.discountNegative", "sale.discountPercent"],
    [adjust.taxType, adjust.taxValue, "sale.taxNegative", "sale.taxPercent"],
  ]) {
    if (value === "") continue;
    const v = Number(value);
    if (!Number.isFinite(v) || v < 0) return { error: t(negativeKey) };
    if (type === "percent" && v > 100) return { error: t(percentKey) };
  }
  const before = invoiceAdjustInputs(inv);
  // Nothing typed (or 0) is the same whichever type is selected; otherwise the type and the number must both match.
  const sameAdjust = (type, value, beforeType, beforeValue) => (toNumber(value) === 0 && toNumber(beforeValue) === 0) || (type === beforeType && toNumber(value) === toNumber(beforeValue));
  const adjustChanged = !sameAdjust(adjust.discountType, adjust.discountValue, before.discountType, before.discountValue) ||
    !sameAdjust(adjust.taxType, adjust.taxValue, before.taxType, before.taxValue);

  const updated = { ...inv, customer: { ...(inv.customer || {}) }, items };
  // A blank name is the walk-in customer, as on the Sell page. A detail an old invoice never had stays absent while it is blank.
  const typedName = clean(edit.customer && edit.customer.name);
  updated.customer.name = typedName || (inv.customer && inv.customer.name === "" ? "" : WALK_IN);
  for (const key of ["phone", "address"]) {
    const value = clean(edit.customer && edit.customer[key]);
    if (value || key in updated.customer) updated.customer[key] = value;
  }
  const second = clean(edit.secondName);
  if (second) updated.secondCustomer = { name: second }; else delete updated.secondCustomer;

  if (linesChanged || adjustChanged) {
    const totals = calculateTotals({ items, ...adjust });
    if (!Number.isFinite(totals.total)) return { error: t("sale.totalInvalid") };
    Object.assign(updated, totals, {
      discountPercent: adjust.discountType === "percent" ? toNumber(adjust.discountValue) : null,
      taxPercent: adjust.taxType === "percent" ? toNumber(adjust.taxValue) : null,
    });
  }

  // Nothing at all changed: there is nothing to save.
  if (Validation.sameValue(updated, inv)) return { skip: true, invoice: inv };
  const now = new Date().toISOString();
  updated.updatedAt = now;
  updated.edits = [...(Array.isArray(inv.edits) ? inv.edits : []), { at: now, totalBefore: inv.total, totalAfter: updated.total }];

  const stockChanges = new Map();
  const result = { invoice: updated, stockChanges, overpaid: false };
  // ----- the stock: given back and taken, per product, as one net change -----
  for (const productId of new Set([...restore.keys(), ...take.keys()])) {
    const product = findProduct(productId, d);
    const available = Calc.cleanNumber(product.stock + (restore.get(productId) || 0));
    const needed = take.get(productId) || 0;
    if (!Calc.hasEnoughStock(available, needed)) {
      return { ...result, error: t("edit.noStock", { name: product.name, needed: stockText(product, needed), available: stockText(product, available) }) };
    }
    const next = Math.max(0, Calc.cleanNumber(available - needed));
    if (next !== product.stock) stockChanges.set(productId, next);
  }
  // ----- the money: payments stay, and can never be more than what is due -----
  const paid = Validation.paidTotal(inv);
  const due = round2(toNumber(updated.total) + Validation.carriedTotal(inv));
  if (paid > due + 0.01) {
    result.overpaid = true;
    return { ...result, error: t("edit.overpaid", { paid: money(paid, inv.currency), due: money(due, inv.currency) }) };
  }
  // ----- what the database would refuse anyway, said plainly first -----
  const why = Validation.invoiceProblem(updated);
  if (why) return { ...result, error: t("edit.invalid", { number: inv.invoiceNumber, problem: why }) };
  const history = Validation.deliveryHistoryProblem(inv, updated);
  if (history) return { ...result, error: t("edit.invalid", { number: inv.invoiceNumber, problem: history }) };
  const ledger = Validation.ledgerProblems(d.invoices.map((i) => (i.id === invoiceId ? updated : i)), d.debtTransfers || []);
  if (ledger.length) return { ...result, error: ledger[0] };
  return result;
}

// Saves a planned edit on the data draft `d`. All or nothing: any problem returns { error } and the draft is thrown away.
function applyInvoiceEdit(d, invoiceId, edit) {
  const plan = planInvoiceEdit(d, invoiceId, edit);
  if (plan.error) return { error: plan.error };
  if (plan.skip) return { skip: true, invoice: plan.invoice };
  const index = d.invoices.findIndex((i) => i.id === invoiceId);
  d.invoices[index] = plan.invoice;
  for (const [productId, stock] of plan.stockChanges) findProduct(productId, d).stock = stock;
  return { invoice: plan.invoice };
}

/* ---------- The Edit invoice screen ----------
   state.invoiceEdit holds what is typed. Nothing is saved until Save changes, which sends it through applyInvoiceEdit(). */

let editSerial = 0;

function editInput(edit = state.invoiceEdit) {
  return {
    customer: { ...edit.customer },
    secondName: edit.secondName,
    lines: edit.lines.map((l) => ({ origIndex: l.origIndex, productId: l.productId, sellingUnit: l.sellingUnit, qty: l.qty, unitPrice: l.unitPrice })),
    discountType: edit.discountType, discountValue: edit.discountValue, taxType: edit.taxType, taxValue: edit.taxValue,
  };
}

// True when something was typed that is not on the saved invoice (what the "unsaved changes" warnings ask about).
function editDirty() {
  return Boolean(state.invoiceEdit) && JSON.stringify(editInput()) !== state.invoiceEdit.initial;
}

// Opens the edit screen for a saved invoice. { error } when it can not be edited now.
function startEditInvoice(id) {
  const inv = state.invoices.find((i) => i.id === id);
  if (!inv) return { error: t("edit.gone") };
  if (!canWrite()) { const error = blockedMessage(); notify(error, "error"); return { error }; }
  const c = inv.customer || {};
  const adjust = invoiceAdjustInputs(inv);
  const edit = {
    id,
    fromPreview: Boolean(state.previewInvoice && state.previewInvoice.id === id),
    baseItems: structuredClone(inv.items),
    customer: { name: !c.name || c.name === WALK_IN ? "" : c.name, phone: c.phone || "", address: c.address || "" },
    secondName: secondCustomerName(inv),
    lines: inv.items.map((item, index) => ({ key: ++editSerial, origIndex: index, productId: item.productId, sellingUnit: item.sellingUnit, qty: String(item.qty), unitPrice: String(item.unitPrice), label: invoiceItemLabel(item), fresh: false })),
    ...adjust,
    pickId: null,
    initial: "",
  };
  edit.initial = JSON.stringify(editInput(edit));
  state.invoiceEdit = edit;
  showView("editinvoice");
  return {};
}

// The corrected invoice as it would be saved, worked out from what is typed (for the live preview and the summary).
function editPlan() {
  const edit = state.invoiceEdit;
  return planInvoiceEdit(state, edit.id, { ...editInput(edit), baseItems: edit.baseItems });
}

function editPreviewInvoice() {
  const edit = state.invoiceEdit;
  const plan = editPlan();
  return plan.invoice || state.invoices.find((i) => i.id === edit.id) || null;
}

function editLineHtml(line) {
  const edit = state.invoiceEdit;
  const inv = state.invoices.find((i) => i.id === edit.id);
  const orig = line.origIndex != null ? inv.items[line.origIndex] : null;
  const product = findProduct(line.productId);
  const name = line.label;
  const tracked = Validation.isTracked(inv);
  const whole = Calc.isWholeUnit(line.sellingUnit);
  const unit = line.sellingUnit;
  const note = orig && !product ? t("edit.productGone", { name }) : "";
  const qtyLocked = tracked && orig;
  return `<tr data-key="${line.key}"${orig ? "" : ' class="edit-new"'}>` +
    `<td><div>${esc(name)}</div>${note ? `<div class="muted small edit-line-note">${esc(note)}</div>` : ""}<div class="error small" data-row-error></div></td>` +
    `<td class="num"><div class="qty-cell"><input class="qty-input" type="number" min="${whole ? 1 : 0}" step="${whole ? 1 : "any"}" value="${esc(line.qty)}" data-field="qty"${qtyLocked ? ` disabled title="${esc(t("edit.quantityFixed"))}"` : ""} aria-label="${esc(t("sell.qtyAria", { name }))}"><span class="muted small" data-qty-unit>${esc(unitLabel(unit, toNumber(line.qty)))}</span></div></td>` +
    `<td class="num"><div class="price-cell"><input class="price-input" type="number" min="0" step="any" value="${esc(line.unitPrice)}" data-field="price" aria-label="${esc(t("sell.priceAria", { name, unit: t("sell.priceUnit", { currency: state.settings.currency, unit: unitLabel(unit, 1).toLowerCase() }) }))}"><span class="price-unit">${esc(t("sell.priceUnit", { currency: state.settings.currency, unit: unitLabel(unit, 1).toLowerCase() }))}</span></div></td>` +
    `<td class="num" data-line-total>${esc(money(Calc.calculateLineTotal(toNumber(line.qty), toNumber(line.unitPrice))))}</td>` +
    `<td class="num"><button type="button" class="btn small danger" data-action="edit-remove" aria-label="${esc(t("edit.removeLine", { name }))}"${tracked ? " disabled" : ""}>${esc(t("common.remove"))}</button></td></tr>`;
}

// Draws the whole screen from state.invoiceEdit (opening it, adding or removing a line).
function renderInvoiceEdit() {
  const edit = state.invoiceEdit;
  if (!edit) return;
  const inv = state.invoices.find((i) => i.id === edit.id);
  if (!inv) return;
  $("editHeading").textContent = t("edit.heading", { number: inv.invoiceNumber });
  const tracked = Validation.isTracked(inv);
  $("editNotes").hidden = !tracked;
  $("editNotes").textContent = tracked ? t("edit.trackedNote") : "";
  $("editName").value = edit.customer.name;
  $("editPhone").value = edit.customer.phone;
  $("editAddress").value = edit.customer.address;
  $("editName2").value = edit.secondName;
  $("editDiscountValue").value = edit.discountValue;
  $("editDiscountType").value = edit.discountType;
  $("editTaxValue").value = edit.taxValue;
  $("editTaxType").value = edit.taxType;
  $("editBody").innerHTML = edit.lines.map(editLineHtml).join("");
  const addBox = $("editAdd");
  addBox.disabled = tracked;
  $("editSearch").disabled = tracked;
  renderEditResults();
  refreshEditLive();
}

// The product list under the "Add a product" search (the same matches as the Sell page).
function renderEditResults() {
  const edit = state.invoiceEdit;
  const query = $("editSearch").value;
  const box = $("editResults");
  if (!edit || !query.trim()) { box.innerHTML = ""; return; }
  const matches = findMatches(query);
  box.innerHTML = matches.length
    ? matches.map((p) => `<div class="result" role="option" data-id="${esc(p.id)}" aria-selected="${p.id === edit.pickId}">` +
        `<div><div>${esc(productLabel(p))}</div></div><div class="price">${esc(priceLabel(p))}</div><div class="stock">${esc(t("stock.n", { n: stockLabel(p) }))}</div></div>`).join("")
    : `<div class="empty"><p class="muted">${esc(t("results.noMatch", { query }))}</p></div>`;
}

// Updates the line totals, the summary, the problem line and the preview without redrawing the inputs (keeps focus).
function refreshEditLive() {
  const edit = state.invoiceEdit;
  if (!edit) return;
  for (const row of $("editBody").querySelectorAll("tr[data-key]")) {
    const line = edit.lines.find((l) => String(l.key) === row.dataset.key);
    if (!line) continue;
    row.querySelector("[data-line-total]").textContent = money(Calc.calculateLineTotal(toNumber(line.qty), toNumber(line.unitPrice)));
    row.querySelector("[data-qty-unit]").textContent = unitLabel(line.sellingUnit, toNumber(line.qty));
  }
  const plan = editPlan();
  const inv = state.invoices.find((i) => i.id === edit.id);
  const shown = plan.invoice || inv;
  const pay = paymentInfo(shown);
  const cur = shown.currency;
  const row = (label, value, cls) => `<div${cls ? ` class="${cls}"` : ""}><span>${esc(label)}</span><span>${esc(value)}</span></div>`;
  $("editSummary").innerHTML =
    row(t("sell.subtotal"), money(toNumber(shown.subtotal), cur)) + row(t("sell.discount"), money(toNumber(shown.discount), cur)) + row(t("sell.tax"), money(toNumber(shown.tax), cur)) +
    row(t("edit.newDue"), money(pay.due, cur), "grand") +
    row(t("edit.paid"), money(pay.paid, cur)) +
    row(t("edit.remainingAfter"), money(pay.remaining, cur), plan.overpaid ? "due edit-warn" : "due") +
    row(t("edit.statusAfter"), pay.status);
  $("editError").textContent = plan.error || "";
  $("editSave").disabled = Boolean(plan.error);
  if (state.view === "editinvoice") renderInvoice();
}

// Adds the product picked in the search to the lines (the same product and unit joins the line already there).
function addEditLine() {
  const edit = state.invoiceEdit;
  const product = edit && findProduct(edit.pickId);
  if (!product) return { error: t("edit.chooseProduct") };
  const typedUnit = SALE_LINE_UNITS.includes($("editAddUnit").value) ? $("editAddUnit").value : "piece";
  const checked = Calc.validateQuantity($("editAddQty").value.trim(), typedUnit);
  if (checked.error) return { error: checked.error };
  // Same rule as the Sell page: an area typed for a product supplied in boxes becomes whole boxes, once, here.
  const supplied = Calc.toSuppliedQuantity(product, checked.value, typedUnit);
  if (supplied.error) return { error: supplied.error };
  const priced = Calc.getUnitPrice(product, supplied.unit);
  if (priced.error) return { error: priced.error };
  const taken = Calc.stockDeduction(product, supplied.qty, supplied.unit);
  if (taken.error) return { error: taken.error };
  const twin = edit.lines.find((l) => l.productId === product.id && l.sellingUnit === supplied.unit);
  if (twin) twin.qty = String(Calc.cleanNumber(toNumber(twin.qty) + supplied.qty));
  else edit.lines.push({ key: ++editSerial, origIndex: null, productId: product.id, sellingUnit: supplied.unit, qty: String(supplied.qty), unitPrice: String(priced.value), label: productLabel(product), fresh: true });
  return { ok: true, converted: supplied.converted ? { requested: supplied.requested, exact: supplied.exact, boxes: supplied.qty, area: supplied.area } : null };
}

function removeEditLine(key) {
  const edit = state.invoiceEdit;
  if (!edit) return false;
  const before = edit.lines.length;
  edit.lines = edit.lines.filter((l) => String(l.key) !== String(key));
  return edit.lines.length < before;
}

// Where the person goes when the edit ends: back to the saved invoice they were looking at, or to the list.
function leaveEdit(id, fromPreview, saved) {
  state.invoiceEdit = null;
  if (saved || fromPreview) viewInvoice(id);
  else showView("invoices");
}

function cancelInvoiceEdit() {
  const edit = state.invoiceEdit;
  if (!edit) return { ignored: true };
  if (editDirty() && !confirm(t("edit.leaveConfirm"))) return { stayed: true };
  leaveEdit(edit.id, edit.fromPreview, false);
  return { cancelled: true };
}

// Save changes: ONE transaction for the invoice and the stock (see applyInvoiceEdit). On any problem nothing is changed and
// the screen stays open with what was typed.
function saveInvoiceEdit() {
  return guard(async () => {
    const edit = state.invoiceEdit;
    if (!edit) return;
    const input = { ...editInput(edit), baseItems: edit.baseItems };
    const r = await commit((d) => applyInvoiceEdit(d, edit.id, input));
    if (r.error) {
      showError("editError", r.error);
      notify(r.error, "error");
      return;
    }
    const number = (state.invoices.find((i) => i.id === edit.id) || {}).invoiceNumber || "";
    leaveEdit(edit.id, edit.fromPreview, true);
    notify(t(r.skip ? "edit.nothingChanged" : "edit.saved", { number }));
    onDebtDataChanged();
  });
}

function viewInvoice(id) {
  const inv = state.invoices.find((i) => i.id === id);
  if (!inv) return;
  state.previewInvoice = inv;
  $("payAmount").value = "";
  showError("payError", "");
  $("collectNote").value = "";
  showError("collectError", "");
  showView("sell", { keepPreview: true });
}

// Prints the collection document of an invoice: only what is still to collect, with no prices and no amounts.
function printCollection(invoiceId) {
  const inv = state.invoices.find((i) => i.id === invoiceId);
  if (!inv || !Validation.deliveryDetail(inv).toCollect.length) return;
  $("collectionPrint").innerHTML = collectionHtml(inv);
  const original = document.title;
  document.title = Validation.collectionNumber(inv);
  document.body.dataset.printing = "collection";
  window.addEventListener("afterprint", () => {
    document.title = original;
    delete document.body.dataset.printing;
  }, { once: true });
  window.print();
}

function printInvoice(invoice) {
  if (invoice) {
    state.previewInvoice = invoice;
    renderInvoice();
  }
  // The document title becomes the suggested file name when saving as PDF.
  const original = document.title;
  document.title = (state.previewInvoice || draftInvoice()).invoiceNumber;
  const restore = () => { document.title = original; };
  window.addEventListener("afterprint", restore, { once: true });
  try {
    window.print();
  } catch (e) {
    // The print dialog could not open (blocked by the browser): put the title back and let the caller say so.
    if (typeof window.removeEventListener === "function") window.removeEventListener("afterprint", restore);
    restore();
    throw e;
  }
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
  notify(t(dataUrl ? "logo.saved" : "logo.removed"));
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

// Can this product be added to a sale in this unit? ("" when yes, otherwise the reason.)
function unitProblem(product, unit) {
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
  // Not needed when the box has a price of its own (it is in the price list already) or the main price is per box.
  const main = Calc.getSellingPrices(p)[0];
  if (!main || main.unit === "box" || Calc.getExplicitPrice(p, "box") !== null || !p.coveragePerBox) return "";
  const box = Calc.getUnitPrice(p, "box");
  return box.error ? "" : `<span>${esc(t("selected.box", { price: money(box.value) }))}</span>`;
}

function unitOptions(selected, product) {
  return SALE_LINE_UNITS.map((u) => {
    const problem = product && u !== selected ? lineUnitProblem(product, u) : "";
    return `<option value="${u}"${u === selected ? " selected" : ""}${problem ? ` disabled title="${esc(problem)}"` : ""}>${esc(unitLabel(u))}</option>`;
  }).join("");
}

// "DA/m²", "DA/piece", "DA/box": what the unit price typed on a sale line is for (one selected selling unit).
function linePriceUnit(item) {
  const unit = unitLabel(item.sellingUnit, 1).toLowerCase();
  return t("sell.priceUnit", { currency: state.settings.currency, unit });
}

// Shows the product's own price and unit from Stock, and how the line's price follows from it:
// "Product price: 1,500 DA / m² (1 Box = 1.44 m²)". Old products without a price unit show nothing.
function priceNote(item) {
  const p = findProduct(item.productId);
  const priced = p ? Calc.getUnitPrice(p, item.sellingUnit) : null;
  if (!priced || priced.error) return "";
  if (item.priceOverridden) return t("sell.customPrice", { price: `${numberFormat.format(item.listPrice)} ${linePriceUnit(item)}` });
  if (priced.legacy) return "";
  const params = { price: money(priced.basePrice), priceUnit: unitLabel(priced.priceUnit) };
  if (priced.factor === 1) return t("sell.priceNote", params);
  return t("sell.priceNoteConv", {
    ...params,
    unit: unitLabel(item.sellingUnit, 1),
    factor: numberFormat.format(priced.factor),
    factorUnit: unitLabel(priced.priceUnit, priced.factor),
  });
}

// What an invoice line shows in its Price column, from the line's own saved details (never from the
// product's current data): the product's price and the unit it is priced per, plus the quantity sold
// expressed in that unit when it differs ("2 Boxes" -> "2.88 m²"). { price, unit, qtyInPriceUnit }
// A line whose price was typed by hand, or an old line without a price unit, shows the price that was
// really charged, per unit sold.
function invoiceLinePrice(item) {
  const charged = { price: item.unitPrice, unit: item.unitPriceUnit || item.sellingUnit || null, qtyInPriceUnit: null };
  if (item.priceOverridden || !Calc.isUnit(item.priceUnit)) return charged;
  const base = Number(item.productPrice);
  if (item.productPrice == null || !Number.isFinite(base) || base < 0) return charged;
  // The product's price is only shown when it really is the price charged: worked out again from this
  // line's own saved details, it must give the saved unit price. Otherwise the charged price is shown.
  const perSoldUnit = !item.sellingUnit || item.sellingUnit === item.priceUnit
    ? { value: 1 }
    : Calc.convertQuantity(1, item.sellingUnit, item.priceUnit, item);
  if (perSoldUnit.error || Math.abs(Calc.roundMoney(base * perSoldUnit.value) - toNumber(item.unitPrice)) > 0.005) return charged;
  if (!item.sellingUnit || item.sellingUnit === item.priceUnit) return { price: base, unit: item.priceUnit, qtyInPriceUnit: null };
  const converted = Calc.convertQuantity(item.qty, item.sellingUnit, item.priceUnit, item);
  if (converted.error) return charged;
  return { price: base, unit: item.priceUnit, qtyInPriceUnit: converted.value };
}

// "5 Boxes to collect later" under a partial line.
function collectLaterText(item) {
  return t("sell.collectLater", { n: qtyText(Calc.cleanNumber(Math.max(0, item.qty - deliverNowQty(item))), item.sellingUnit) });
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
      // "Deliver only part now": the customer takes some of the line now and collects the rest later (see deliverNowQty).
      const partialToggle = `<label class="check partial-toggle"><input type="checkbox" data-field="partial"${item.partial ? " checked" : ""} aria-label="${esc(t("sell.partialAria", { name }))}"><span>${esc(t("sell.partialLabel"))}</span></label>`;
      const deliverCell = item.partial
        ? `<div class="deliver-cell"><label class="muted small">${esc(t("sell.deliverNow"))}</label><input class="qty-input" type="number" min="0" step="${whole ? 1 : "any"}" value="${item.deliverNow}" data-field="deliver" aria-label="${esc(t("sell.deliverAria", { name }))}"><span class="muted small">${esc(unitLabel(item.sellingUnit, item.deliverNow))}</span></div>` +
          `<div class="small collect-later" data-collect-later>${esc(collectLaterText(item))}</div>`
        : "";
      return `<tr data-id="${esc(item.lineId)}">` +
        `<td><div>${esc(name)}</div><div class="muted small">${esc(t("sell.available", { n: p ? stockLabel(p) : 0 }))}</div>${partialToggle}<div class="error small" data-row-error></div></td>` +
        `<td class="num"><div class="qty-cell"><input class="qty-input" type="number" min="${whole ? 1 : 0}" step="${whole ? 1 : "any"}" value="${item.qty}" data-field="qty" aria-label="${esc(t("sell.qtyAria", { name }))}">` +
        `<select class="unit-select" data-field="unit" aria-label="${esc(t("sell.unitAria", { name }))}">${unitOptions(item.sellingUnit, p)}</select></div>${deliverCell}</td>` +
        `<td class="num"><div class="price-cell"><input class="price-input" type="number" min="0" step="any" value="${item.unitPrice}" data-field="price" aria-label="${esc(t("sell.priceAria", { name, unit: linePriceUnit(item) }))}">` +
        `<span class="price-unit" data-price-unit>${esc(linePriceUnit(item))}</span></div>` +
        `<div class="muted small price-note" data-price-note>${esc(priceNote(item))}</div></td>` +
        `<td class="num" data-line-total>${esc(money(Calc.calculateLineTotal(item.qty, item.unitPrice)))}</td>` +
        `<td class="num"><button type="button" class="btn small danger" data-action="remove" aria-label="${esc(t("sell.removeAria", { name }))}">${esc(t("common.remove"))}</button></td>` +
        `</tr>`;
    }).join("");
  }
  renderSaleDebts();
  renderTotals();
}

function renderTotals() {
  const totals = calculateTotals(state.sale);
  const carried = saleCarried(state.sale);
  const due = round2(totals.total + carried);
  $("tSubtotal").textContent = money(totals.subtotal);
  $("tDiscount").textContent = money(totals.discount);
  $("tTax").textContent = money(totals.tax);
  // With debt carried forward the Total is the products only, followed by the carried debt and the total due.
  $("tTotalLabel").textContent = I18n.t(carried > 0 ? "sell.totalPurchase" : "sell.total");
  $("tTotalRow").classList.toggle("grand", carried <= 0);
  $("tTotal").textContent = money(totals.total);
  $("tCarriedRow").hidden = carried <= 0;
  $("tCarried").textContent = money(carried);
  $("tDueRow").hidden = carried <= 0;
  $("tDue").textContent = money(due);
  $("tRemaining").textContent = money(Math.max(0, round2(due - salePaid(state.sale, due))));
  $("amountPaid").placeholder = "0";
}

// Updates totals, line totals and the preview without rebuilding the inputs (keeps focus).
function refreshLive() {
  state.previewInvoice = null;
  $("saleBody").querySelectorAll("tr[data-id]").forEach((row) => {
    const item = findSaleItem(row.dataset.id);
    if (!item) return;
    row.querySelector("[data-line-total]").textContent = money(Calc.calculateLineTotal(item.qty, item.unitPrice));
    row.querySelector("[data-price-note]").textContent = priceNote(item);
    row.querySelector("[data-price-unit]").textContent = linePriceUnit(item);
    const later = row.querySelector("[data-collect-later]");
    if (later) later.textContent = collectLaterText(item);
    const deliver = row.querySelector("input[data-field='deliver']");
    if (deliver && document.activeElement !== deliver) deliver.value = item.deliverNow;   // follows the quantity and the stock
  });
  renderTotals();
  renderInvoice();
}

function invoiceHtml(inv) {
  const cur = inv.currency || state.settings.currency;
  const biz = inv.business || Validation.businessSnapshot(state.settings);
  const cust = inv.customer || { name: WALK_IN, phone: "", address: "" };
  const num = (n) => numberFormat.format(toNumber(n));
  const pct = (p) => (p ? ` (${numberFormat.format(p)}%)` : "");
  const line = (text) => (text ? `<div>${esc(text)}</div>` : "");
  const logo = state.settings.logo ? `<img class="inv-logo" src="${esc(state.settings.logo)}" alt="${esc(t("logo.alt"))}">` : "";

  // Goods sold in several deliveries: each line shows what was handed over and what is still to collect. The quantity,
  // price and total of the line are always those of the sale.
  const delivery = Validation.deliveryDetail(inv);
  const rows = inv.items.length
    ? inv.items.map((i, index) => {
        const shown = invoiceLinePrice(i);
        const inPriceUnit = shown.qtyInPriceUnit == null ? "" : `<div class="inv-sub">${num(shown.qtyInPriceUnit)} ${esc(unitLabel(shown.unit, shown.qtyInPriceUnit))}</div>`;
        const left = delivery.tracked ? delivery.lines[index] : null;
        const toCollect = left && left.remaining > 0
          ? `<div class="inv-sub inv-open">${esc(t("inv.deliveredOf", { delivered: qtyText(left.delivered, i.sellingUnit), remaining: qtyText(left.remaining, i.sellingUnit) }))}</div>`
          : "";
        return `<tr><td>${esc(invoiceItemLabel(i))}${invoiceItemTypeHtml(i)}</td><td class="num">${num(i.qty)}${i.sellingUnit ? ` ${esc(unitLabel(i.sellingUnit, i.qty))}` : ""}${inPriceUnit}${toCollect}</td><td class="num">${num(shown.price)}${shown.unit ? ` <span class="inv-unit">/ ${esc(unitLabel(shown.unit))}</span>` : ""}</td><td class="num">${num(i.total != null ? i.total : Calc.calculateLineTotal(i.qty, i.unitPrice))}</td></tr>`;
      }).join("")
    : `<tr><td colspan="4" class="none">${esc(t("inv.noItems"))}</td></tr>`;

  const pay = paymentInfo(inv);
  const hasItems = inv.items.length > 0;
  // Debt carried onto this invoice from older ones: separate lines under the products, never mixed into them.
  const carried = Validation.carriedLines(inv);
  const carriedBlock = carried.length
    ? `<section class="inv-carried"><h3>${esc(t("inv.carriedHeading"))}</h3><table class="inv-table inv-carried-table"><tbody>${
        carried.map((l) => `<tr><td>${esc(t("inv.carriedLine", { number: l.sourceInvoiceNumber, date: formatDate(l.sourceDate) }))}</td><td class="num">${num(l.amount)}</td></tr>`).join("")
      }</tbody></table></section>`
    : "";
  const totalRows = carried.length
    ? `<tr class="purchase"><td>${esc(t("inv.totalPurchase"))}</td><td>${esc(money(toNumber(inv.total), cur))}</td></tr>
      <tr><td>${esc(t("inv.carriedTotal"))}</td><td>${esc(money(pay.carried, cur))}</td></tr>
      <tr class="grand"><td>${esc(t("inv.totalDue"))}</td><td>${esc(money(pay.due, cur))}</td></tr>`
    : `<tr class="grand"><td>${esc(t("inv.grandTotal"))}</td><td>${esc(money(toNumber(inv.total), cur))}</td></tr>`;
  // On an older invoice whose balance moved to a newer one, the original total is untouched and the move is shown as its own line.
  const movedRow = pay.transferredOut > 0
    ? `<tr class="moved"><td>${esc(t("inv.transferredOut", { numbers: carriedToNumbers(inv) }))}</td><td>${esc(money(pay.transferredOut, cur))}</td></tr>`
    : "";
  const paidRows = hasItems
    ? `<tr><td>${esc(t("inv.totalPaid"))}</td><td>${esc(money(pay.paid, cur))}</td></tr>${movedRow}<tr class="due"><td>${esc(t("inv.remaining"))}</td><td>${esc(money(pay.remaining, cur))}</td></tr>`
    : "";
  const history = hasItems
    ? `<div class="inv-status"><span class="${pay.cls}">${esc(t("inv.status"))} ${esc(pay.status)}</span></div>
    <section class="inv-payments"><h3>${esc(t("inv.history"))}</h3>${
      pay.payments.length
        ? pay.payments.map((p) => `<div class="inv-pay"><span class="when">${esc(formatDateTime(p.timestamp))}</span><span>${esc(t("inv.paidLine", { amount: money(p.amount, cur) }))}</span></div>`).join("")
        : `<div class="inv-pay"><span class="when">${esc(t("inv.noPayments"))}</span></div>`
    }</section>`
    : "";
  // Delivery is shown apart from payment: a paid invoice can still have goods waiting.
  const deliveryBlock = hasItems && delivery.tracked
    ? `<div class="inv-status inv-delivery-status"><span class="dlv-${delivery.status}">${esc(t("inv.deliveryStatus"))} ${esc(t("inv.delivery." + delivery.status))}</span></div>
    <section class="inv-payments inv-deliveries"><h3>${esc(t("inv.deliveryHistory"))}</h3>${
      inv.deliveries.length
        ? inv.deliveries.map((d, n) => {
            const what = d.type === "sale" ? t("inv.deliverySale") : t("inv.deliveryCollection", { number: Validation.receiptNumber(inv, inv.deliveries.slice(0, n + 1).filter((x) => x.type === "collection").length) });
            const things = d.lines.map((l) => {
              const item = inv.items.find((i) => i.lineId === l.lineId);
              return t("inv.deliveryLine", { quantity: qtyText(l.qty, item && item.sellingUnit), name: item ? invoiceItemLabel(item) : "" });
            }).join(", ");
            return `<div class="inv-pay"><span class="when">${esc(formatDateTime(d.date))}</span><span>${esc(what)}: ${esc(things)}${d.note ? ` (${esc(d.note)})` : ""}</span></div>`;
          }).join("")
        : `<div class="inv-pay"><span class="when">${esc(t("inv.noDeliveries"))}</span></div>`
    }</section>`
    : "";

  return `<header class="inv-head">
      <div>${logo}<div class="inv-biz-name">${esc(biz.name)}</div>${line(biz.address)}${businessPhonesHtml(biz)}${line(biz.email)}</div>
      <div class="inv-title">${esc(t("inv.title"))}</div>
    </header>
    <div class="inv-meta">
      ${customerBlockHtml(inv, cust)}
      <div class="right"><div><span class="label">${esc(t("inv.number"))}</span> ${esc(inv.invoiceNumber)}</div><div><span class="label">${esc(t("inv.date"))}</span> ${esc(formatDateTime(inv.date))}</div></div>
    </div>
    <table class="inv-table">
      <thead><tr><th>${esc(t("inv.product"))}</th><th class="num">${esc(t("inv.qty"))}</th><th class="num">${esc(t("inv.price", { currency: cur }))}</th><th class="num">${esc(t("inv.lineTotal", { currency: cur }))}</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${carriedBlock}
    <table class="inv-totals">
      <tr><td>${esc(t("inv.subtotal"))}</td><td>${esc(money(toNumber(inv.subtotal), cur))}</td></tr>
      <tr><td>${esc(t("inv.discount"))}${pct(inv.discountPercent)}</td><td>${esc(money(toNumber(inv.discount), cur))}</td></tr>
      <tr><td>${esc(t("inv.tax"))}${pct(inv.taxPercent)}</td><td>${esc(money(toNumber(inv.tax), cur))}</td></tr>
      ${totalRows}
      ${paidRows}
    </table>
    ${history}
    ${deliveryBlock}
    <p class="inv-thanks">${esc(t("inv.thanks"))}</p>`;
}

// The collection document: what is still to collect on an invoice, and nothing else. It is NOT an invoice: it has no
// prices and no amounts, it says which invoice the goods were already sold on, and it is numbered after that invoice
// (INV-000030 -> COL-000030). Payment is recorded on the invoice only, so these goods can not be charged a second time.
function collectionHtml(inv) {
  const biz = inv.business || Validation.businessSnapshot(state.settings);
  const cust = inv.customer || { name: WALK_IN, phone: "", address: "" };
  const line = (text) => (text ? `<div>${esc(text)}</div>` : "");
  const logo = state.settings.logo ? `<img class="inv-logo" src="${esc(state.settings.logo)}" alt="${esc(t("logo.alt"))}">` : "";
  const detail = Validation.deliveryDetail(inv);
  const rows = detail.toCollect.length
    ? detail.toCollect.map((l) => `<tr><td>${esc(invoiceItemLabel(l.item))}${invoiceItemTypeHtml(l.item)}<div class="inv-sub">${esc(t("collect.docSold", { sold: qtyText(l.qty, l.item.sellingUnit), delivered: qtyText(l.delivered, l.item.sellingUnit) }))}</div></td><td class="num collect-qty">${esc(qtyText(l.remaining, l.item.sellingUnit))}</td></tr>`).join("")
    : `<tr><td colspan="2" class="none">${esc(t("collect.docNothing"))}</td></tr>`;
  const done = (inv.deliveries || []).map((d, n) => {
    const what = d.type === "sale" ? t("inv.deliverySale") : Validation.receiptNumber(inv, inv.deliveries.slice(0, n + 1).filter((x) => x.type === "collection").length);
    const things = d.lines.map((l) => {
      const item = inv.items.find((i) => i.lineId === l.lineId);
      return t("inv.deliveryLine", { quantity: qtyText(l.qty, item && item.sellingUnit), name: item ? invoiceItemLabel(item) : "" });
    }).join(", ");
    return `<div class="inv-pay"><span class="when">${esc(formatDateTime(d.date))}</span><span>${esc(what)}: ${esc(things)}</span></div>`;
  }).join("");
  return `<header class="inv-head">
      <div>${logo}<div class="inv-biz-name">${esc(biz.name)}</div>${line(biz.address)}${businessPhonesHtml(biz)}${line(biz.email)}</div>
      <div class="inv-title collect-title">${esc(t("collect.docTitle"))}</div>
    </header>
    <div class="collect-banner">${esc(t("collect.docNotice", { invoice: inv.invoiceNumber }))}</div>
    <div class="inv-meta">
      ${customerBlockHtml(inv, cust)}
      <div class="right">
        <div><span class="label">${esc(t("collect.docNumber"))}</span> ${esc(Validation.collectionNumber(inv))}</div>
        <div><span class="label">${esc(t("collect.docInvoice"))}</span> ${esc(inv.invoiceNumber)} (${esc(formatDate(inv.date))})</div>
        <div><span class="label">${esc(t("collect.docIssued"))}</span> ${esc(formatDateTime(new Date().toISOString()))}</div>
      </div>
    </div>
    <table class="inv-table">
      <thead><tr><th>${esc(t("inv.product"))}</th><th class="num">${esc(t("collect.docQty"))}</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${done ? `<section class="inv-payments"><h3>${esc(t("inv.deliveryHistory"))}</h3>${done}</section>` : ""}
    <div class="collect-sign"><div>${esc(t("collect.docReceived"))}</div><div>${esc(t("collect.docDate"))}</div></div>
    <p class="inv-thanks">${esc(t("collect.docFooter", { invoice: inv.invoiceNumber }))}</p>`;
}

// Payment box above a saved invoice: totals plus the "Add Payment" control.
function renderPayBox() {
  const inv = state.view === "editinvoice" ? null : state.previewInvoice;
  $("payBox").hidden = !inv;
  if (!inv) return;
  const cur = inv.currency || state.settings.currency;
  const info = paymentInfo(inv);
  const full = info.remaining <= 0;
  $("payNumber").textContent = inv.invoiceNumber;
  $("payTotal").textContent = money(info.due, cur);
  $("payPaid").textContent = money(info.paid, cur);
  $("payRemaining").textContent = money(info.remaining, cur);
  // How the payments on this invoice are shared with the debt it carries (oldest debt first), and where its own balance went.
  const breakdown = Validation.carriedBreakdown(inv);
  $("payCarriedRow").hidden = !(info.carried > 0);
  $("payCarried").textContent = info.carried > 0 ? `${money(info.carried, cur)} (${t("pay.carriedSettled", { paid: money(breakdown.carriedPaid, cur), total: money(info.carried, cur) })})` : "";
  $("payTransferredRow").hidden = !(info.transferredOut > 0);
  $("payTransferred").textContent = info.transferredOut > 0 ? `${money(info.transferredOut, cur)} (${carriedToNumbers(inv)})` : "";
  $("payAmount").disabled = full;
  $("payBtn").disabled = full;
  $("payAmount").placeholder = full
    ? t(info.cls === "transferred" ? "pay.carriedTo" : "pay.fullyPaid", { numbers: carriedToNumbers(inv) })
    : t("pay.max", { n: numberFormat.format(info.remaining) });
}

// Box above a saved invoice that was sold in several deliveries: payment and delivery status side by side (never mixed),
// what is left to collect per line, and where the warehouse records a collection.
function renderDeliveryBox() {
  const inv = state.view === "editinvoice" ? null : state.previewInvoice;
  const detail = inv ? Validation.deliveryDetail(inv) : null;
  const box = $("deliveryBox");
  box.hidden = !(detail && detail.tracked);
  if (box.hidden) return;
  const pay = paymentInfo(inv);
  $("delNumber").textContent = inv.invoiceNumber;
  $("delPayment").textContent = pay.status + (pay.remaining > 0 ? ` (${t("deliv.stillToPay", { amount: money(pay.remaining, inv.currency) })})` : "");
  $("delStatus").textContent = t("inv.delivery." + detail.status);
  $("delBody").innerHTML = detail.lines.map((l) => {
    const unit = l.item.sellingUnit;
    const name = invoiceItemLabel(l.item);
    const whole = Calc.isWholeUnit(unit);
    const info = `<div class="collect-info"><div>${esc(name)}</div>${invoiceItemTypeHtml(l.item)}<div class="muted small">${esc(t("deliv.soldLine", { sold: qtyText(l.qty, unit), delivered: qtyText(l.delivered, unit), remaining: qtyText(l.remaining, unit) }))}</div></div>`;
    if (l.remaining <= 0) return `<div class="collect-row done">${info}<div class="collect-input muted small">${esc(t("deliv.done"))}</div></div>`;
    return `<div class="collect-row" data-line="${esc(l.lineId)}">${info}<div class="collect-input"><input type="number" min="0" max="${l.remaining}" step="${whole ? 1 : "any"}" data-collect-qty data-line="${esc(l.lineId)}" data-remaining="${l.remaining}" aria-label="${esc(t("deliv.qtyAria", { name }))}"><span class="muted small">${esc(unitLabel(unit, l.remaining))}</span></div></div>`;
  }).join("");
  const open = detail.toCollect.length > 0;
  $("collectNote").disabled = !open;
  $("collectAll").disabled = !open;
  $("collectBtn").disabled = !open;
  $("collectPrint").disabled = !open;
}

function renderInvoice() {
  // While an invoice is being corrected the preview shows the corrected invoice (not saved yet) and nothing can be printed from it.
  const editing = state.view === "editinvoice" && state.invoiceEdit;
  const saved = state.previewInvoice;
  const shown = editing ? editPreviewInvoice() : saved || draftInvoice();
  $("invoice").innerHTML = invoiceHtml(shown);
  $("previewStatus").textContent = t(editing ? "edit.previewStatus" : saved ? "preview.saved" : "preview.live");
  $("backToSale").hidden = Boolean(editing) || !saved;
  $("editInvoiceBtn").hidden = Boolean(editing) || !saved;
  $("printBtn").hidden = Boolean(editing);
  renderPayBox();
  renderDeliveryBox();
}

function renderStock() {
  renderProductSuggestions();   // the stock list changed: the suggestions follow it
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

// What the history screen shows: the search box, the two filters and the sort, which all work together.
// Payment and delivery are independent filters. "Delivered" = every item handed over (an invoice that does not track deliveries
// handed everything over at the sale); "Not delivered" = something is still to collect (partly delivered included).
const invoiceView = { pay: "all", delivery: "all", sortKey: null, sortDir: 1 };

const PAYMENT_RANK = { unpaid: 0, partial: 1, paid: 2, transferred: 3 };

function invoiceMatchesView(inv, view) {
  if (view.pay !== "all" && paymentInfo(inv).cls !== view.pay) return false;
  if (view.delivery !== "all") {
    const delivered = Validation.deliveryDetail(inv).status === "complete";
    if (delivered !== (view.delivery === "delivered")) return false;
  }
  return true;
}

// The sort column: "number" (the number in INV-000012, so 9 comes before 10), "date" (by time), "customer" (A-Z, case-insensitive),
// "total" (the amount due, as a number) or "status" (unpaid, partially paid, paid). Ties keep the newest invoice first.
function invoiceSortValue(inv, key) {
  if (key === "number") return Validation.invoiceSequence(inv.invoiceNumber);
  if (key === "date") return Date.parse(inv.date) || 0;
  if (key === "customer") return customerLabel(inv.customer && inv.customer.name).toLowerCase();
  if (key === "total") return paymentInfo(inv).due;
  if (key === "status") return PAYMENT_RANK[paymentInfo(inv).cls] ?? 9;
  return 0;
}

function sortInvoices(list, key, dir) {
  if (!key) return list;
  return [...list].sort((a, b) => {
    const x = invoiceSortValue(a, key);
    const y = invoiceSortValue(b, key);
    const r = typeof x === "string" ? x.localeCompare(y) : x - y;
    return r * dir || Validation.invoiceSequence(b.invoiceNumber) - Validation.invoiceSequence(a.invoiceNumber);
  });
}

function searchInvoices(query, view = invoiceView) {
  const terms = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  const found = [...state.invoices].reverse().filter((inv) => {
    const c = inv.customer || {};
    const phone = String(c.phone || "");
    // The stored walk-in name and its translation are both searchable.
    // Both customer names are searched; each one matches on its own, whichever field holds it.
    const haystack = (inv.invoiceNumber + " " + (c.name || WALK_IN) + " " + customerLabel(c.name) + " " + secondCustomerName(inv) + " " + phone + " " + phone.replace(/\s+/g, "")).toLowerCase();
    return terms.every((t) => haystack.includes(t)) && invoiceMatchesView(inv, view);
  });
  return sortInvoices(found, view.sortKey, view.sortDir);
}

function setInvoiceSort(key) {
  if (invoiceView.sortKey === key) invoiceView.sortDir = -invoiceView.sortDir;
  else { invoiceView.sortKey = key; invoiceView.sortDir = 1; }
  renderInvoices();
}

function clearInvoiceFilters() {
  invoiceView.pay = "all";
  invoiceView.delivery = "all";
  invoiceView.sortKey = null;
  invoiceView.sortDir = 1;
  $("invoiceFilter").value = "";
  $("invoicePayFilter").value = "all";
  $("invoiceDeliveryFilter").value = "all";
  renderInvoices();
}

function renderInvoices() {
  const hasInvoices = state.invoices.length > 0;
  const query = $("invoiceFilter").value;
  const list = searchInvoices(query);
  const narrowed = Boolean(query.trim()) || invoiceView.pay !== "all" || invoiceView.delivery !== "all" || invoiceView.sortKey !== null;
  $("invoiceFilter").hidden = !hasInvoices;
  $("invoiceFilters").hidden = !hasInvoices;
  $("invoiceClear").hidden = !narrowed;
  $("invoiceCount").textContent = hasInvoices ? t("invoices.count", { shown: list.length, total: state.invoices.length }) : "";
  document.querySelectorAll("[data-sort-th]").forEach((th) => {
    const on = th.dataset.sortTh === invoiceView.sortKey;
    if (on) th.setAttribute("aria-sort", invoiceView.sortDir > 0 ? "ascending" : "descending");
    else th.removeAttribute("aria-sort");
    th.querySelector(".sort-mark").textContent = on ? (invoiceView.sortDir > 0 ? "▲" : "▼") : "";
  });
  $("invoiceTable").hidden = list.length === 0;
  $("invoiceEmpty").hidden = list.length > 0;
  $("invoiceEmpty").innerHTML = hasInvoices
    ? `<p class="muted">${esc(query.trim() ? t("invoices.noMatch", { query }) : t("invoices.noMatchFilters"))}</p>`
    : `<p><strong>${esc(t("invoices.none"))}</strong></p><p class="muted">${esc(t("invoices.noneHint"))}</p>`;
  $("invoiceBody").innerHTML = list.map((inv) => {
    const pay = paymentInfo(inv);
    const label = t({ paid: "badge.paid", partial: "badge.partial", unpaid: "badge.unpaid", transferred: "badge.transferred" }[pay.cls]);
    // Total is what the invoice asks for (this purchase + debt carried onto it). The notes say where the figure comes from.
    const notes = [];
    if (pay.carried > 0) notes.push(t("invoices.inclCarried", { amount: money(pay.carried, inv.currency) }));
    if (pay.transferredOut > 0) notes.push(t("invoices.carriedTo", { amount: money(pay.transferredOut, inv.currency), numbers: carriedToNumbers(inv) }));
    // Delivery is its own status, shown under the payment status.
    const delivery = Validation.deliveryDetail(inv);
    const deliveryBadge = delivery.tracked
      ? `<div class="status-line"><span class="badge ${{ complete: "dl-received", partial: "dl-partial", pending: "dl-pending" }[delivery.status]}">${esc(t("badge.delivery." + delivery.status))}</span></div>`
      : "";
    return `<tr data-id="${esc(inv.id)}">` +
      `<td>${esc(inv.invoiceNumber)}</td>` +
      `<td>${esc(formatDate(inv.date))}</td>` +
      `<td>${esc(customerLabel(inv.customer && inv.customer.name))}${secondCustomerName(inv) ? `<div class="muted small">${esc(secondCustomerName(inv))}</div>` : ""}</td>` +
      `<td class="num">${esc(money(pay.due, inv.currency))}${notes.length ? `<div class="muted small">${notes.map(esc).join("<br>")}</div>` : ""}</td>` +
      `<td class="num">${esc(money(pay.paid, inv.currency))}</td>` +
      `<td class="num">${esc(money(pay.remaining, inv.currency))}</td>` +
      `<td><span class="badge ${pay.cls}">${esc(label)}</span>${deliveryBadge}</td>` +
      `<td class="num"><div class="row-actions">` +
      `<button type="button" class="btn small" data-action="view">${esc(t("invoices.view"))}</button>` +
      `<button type="button" class="btn small" data-action="pay"${pay.remaining <= 0 ? " disabled" : ""}>${esc(t("invoices.addPayment"))}</button>` +
      (delivery.toCollect.length ? `<button type="button" class="btn small" data-action="collect">${esc(t("invoices.collect"))}</button>` : "") +
      `<button type="button" class="btn small" data-action="print">${esc(t("invoices.print"))}</button>` +
      `<button type="button" class="btn small" data-action="edit">${esc(t("invoices.edit"))}</button>` +
      `<button type="button" class="btn small danger" data-action="delete">${esc(t("common.delete"))}</button>` +
      `</div></td></tr>`;
  }).join("");
}

function applyCurrency() {
  document.querySelectorAll("[data-currency]").forEach((el) => { el.textContent = state.settings.currency; });
}

/* ---------- The business phone numbers (Settings -> Business details) ----------
   A list of text boxes with an "Add phone number" button. What is typed lives in state.phoneRows until Save Settings, which
   saves the whole list in the settings (and the first number as the older single `phone`, see validation.js). */

let phoneSerial = 0;

// The rows for the numbers a business has now (a business saved before the list existed has its one number); always at least one row.
function phoneRowsFrom(settings) {
  const list = Validation.businessPhones(settings);
  return (list.length ? list : [""]).map((value) => ({ rowId: ++phoneSerial, value }));
}

function renderPhoneRows() {
  const rows = state.phoneRows;
  $("sPhones").innerHTML = rows.map((row, i) =>
    `<div class="phone-row" data-row="${row.rowId}">` +
    `<input type="text" inputmode="tel" class="phone-input" value="${esc(row.value)}" maxlength="${Validation.MAX_PHONE_LENGTH}" aria-label="${esc(t("settings.phoneN", { n: i + 1 }))}" autocomplete="off">` +
    `<button type="button" class="btn small" data-action="remove-phone" aria-label="${esc(t("settings.removePhoneN", { n: i + 1 }))}"${rows.length < 2 ? " disabled" : ""}>${esc(t("common.remove"))}</button>` +
    `</div>`
  ).join("");
  $("addPhone").disabled = rows.length >= Validation.MAX_BUSINESS_PHONES;
}

function addPhoneRow() {
  if (state.phoneRows.length >= Validation.MAX_BUSINESS_PHONES) return null;
  const row = { rowId: ++phoneSerial, value: "" };
  state.phoneRows.push(row);
  return row;
}

// At least one row always stays (an empty one means no phone number).
function removePhoneRow(rowId) {
  if (state.phoneRows.length < 2) return false;
  state.phoneRows = state.phoneRows.filter((r) => String(r.rowId) !== String(rowId));
  return true;
}

function setPhoneRow(rowId, value) {
  const row = state.phoneRows.find((r) => String(r.rowId) === String(rowId));
  if (row) row.value = String(value == null ? "" : value);
}

// Save Settings: the business details, with every phone number typed (blank rows and repeats of the same number left out).
function saveBusinessSettings() {
  return guard(async () => {
    const phones = Validation.cleanPhoneList(state.phoneRows.map((r) => r.value)).slice(0, Validation.MAX_BUSINESS_PHONES);
    const r = await commit((d) => {
      d.settings = {
        ...d.settings,
        businessName: $("sName").value.trim(),
        address: $("sAddress").value.trim(),
        phone: phones[0] || "",
        phones,
        email: $("sEmail").value.trim(),
        currency: $("sCurrency").value.trim() || CURRENCY,
      };
    });
    if (r.error) { notify(r.error, "error"); return; }
    notify(t("settings.saved"));
    fillSettingsForm();
    renderAll();
  });
}

function fillSettingsForm() {
  const s = state.settings;
  $("sName").value = s.businessName;
  $("sAddress").value = s.address;
  state.phoneRows = phoneRowsFrom(s);
  renderPhoneRows();
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
    notify(t("settings.languageChanged"));
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
  else notify(t("settings.paperSet", { paper }));
  applyPaperSize();
}

function updateBannerHeight() {
  const banner = $("storageBanner");
  document.documentElement.style.setProperty("--banner-h", banner.hidden ? "0px" : banner.offsetHeight + "px");
}

function storageSize() {
  if (storage.usage == null) return "";
  const mb = Math.round((storage.usage / (1024 * 1024)) * 10) / 10;
  return t("storage.sizeUsed", { mb: numberFormat.format(mb) });
}

function quotaText() {
  const keep = storage.persisted === true
    ? t("storage.persisted")
    : storage.persisted === false
      ? t("storage.notProtected")
      : "";
  return [storageSize(), keep].filter(Boolean).join(" ") || t("storage.notReported");
}

// The small reminder in the top bar. It never opens a dialog and never blocks a sale.
function renderReminder() {
  const hasData = storage.mode === "ready" && (state.products.length > 0 || state.invoices.length > 0 || state.suppliers.length > 0 || state.purchases.length > 0);
  const button = $("backupReminder");
  const auto = autoBackup.getStatus();
  // An automatic backup file that is not being kept up to date is worth a warning at the top: it opens Settings.
  if (storage.mode === "ready" && auto.attention) {
    button.hidden = false;
    button.dataset.mode = "auto";
    button.textContent = t("auto.reminderText");
    button.title = t("auto.reminderTitle");
    button.className = "backup-reminder no-print overdue";
    button.disabled = false;
    return;
  }
  const reminder = Validation.backupReminder(storage.backup, hasData, new Date());
  // While the automatic backup file is verified to be current, the "export a backup" reminder is not needed.
  button.hidden = !reminder.text || auto.state === "current";
  button.dataset.mode = "";
  button.title = t("backup.reminderTitle");
  button.textContent = reminder.text ? t("reminder.action", { text: reminder.text }) : "";
  button.className = "backup-reminder no-print " + reminder.level;
  button.disabled = busy;
}

const AUTO_STATUS_TEXT = {
  current: "auto.status.current",
  pending: "auto.status.pending",
  writing: "auto.status.writing",
  error: "auto.status.error",
  "needs-permission": "auto.status.needsPermission",
  "file-newer": "auto.status.fileNewer",
  "not-connected": "auto.status.notConnected",
  unsupported: "auto.status.unsupported",
};

// The "Automatic backup file" section of Settings. "Backup current" is only ever shown for a file that was written
// (or found to hold the latest revision) and read back; a write that has merely started never counts.
function renderAutoBackup() {
  const s = autoBackup.getStatus();
  const locked = busy || storage.mode !== "ready";
  const connection = s.state === "unsupported" ? "auto.connection.unsupported"
    : !s.connected ? "auto.connection.notConnected"
    : s.state === "needs-permission" ? "auto.connection.needsPermission"
    : "auto.connection.connected";
  $("autoNote").textContent = s.state === "unsupported" ? t("auto.unsupportedNote")
    : s.state === "not-connected" ? t("auto.notConnectedNote", { name: AutoBackup.FILE_NAME }) + " " + t("auto.intro")
    : t("auto.intro");
  $("autoConnection").textContent = t(connection);
  $("autoFile").textContent = s.fileName || "-";
  $("autoStatus").textContent = t(AUTO_STATUS_TEXT[s.state]);
  $("autoStatus").className = "state-" + s.state;
  $("autoLast").textContent = s.lastSuccessAt ? formatDateTime(s.lastSuccessAt) : t("storage.never");
  $("autoDbRevision").textContent = s.latestRevision === null ? t("auto.unknown") : String(s.latestRevision);
  $("autoBackedRevision").textContent = s.lastRevision === null ? t("auto.none") : String(s.lastRevision);
  $("autoError").textContent = s.error || t("auto.none");
  $("autoChoose").hidden = s.state === "unsupported";
  $("autoChoose").textContent = t(s.connected ? "auto.chooseOther" : "auto.choose");
  $("autoChoose").disabled = locked;
  $("autoGrant").hidden = s.state !== "needs-permission";
  $("autoGrant").disabled = busy;
  $("autoRetry").hidden = !(s.connected && (s.state === "error" || s.state === "pending"));
  $("autoRetry").disabled = busy;
}

// What happened to the data older versions kept in this browser, and what can still be done about it.
function renderLegacy() {
  const record = storage.migration;
  const failed = storage.migrationFailed;
  const kept = !!record && record.legacyRetained;
  const lines = [];
  if (failed) {
    lines.push(t("legacy.failed"));
  } else if (record && record.status === "migrated") {
    lines.push(t("legacy.migrated", { counts: describeData(record.counts), date: formatDateTime(record.at) }));
    if (record.rejectedCount) lines.push(tn("legacy.rejected", record.rejectedCount));
    lines.push(t(kept ? "legacy.kept" : "legacy.removed"));
  } else if (record && record.status === "conflict") {
    lines.push(t("legacy.conflict", { older: describeData(record.legacyCounts), current: describeData(record.counts) }));
  } else if (record && record.status === "skipped") {
    lines.push(t("legacy.skipped"));
  }
  if (record && record.legacyDataFile) {
    lines.push(t("legacy.dataFile", { file: record.legacyDataFile }));
  }
  $("legacyBox").hidden = lines.length === 0;
  $("legacyText").textContent = lines.join(" ");

  const hasCopy = failed || (kept && ["migrated", "conflict", "skipped"].includes(record.status));
  const removable = !failed && kept && ((record.status === "migrated" && !!storage.backup.lastBackupAt) || (record.status === "conflict" && !!record.legacyCopyDownloadedAt));
  $("legacyDownload").hidden = !hasCopy;
  $("legacyDownload").disabled = busy;
  $("legacyRemove").hidden = failed || !kept || !["migrated", "conflict"].includes(record.status);
  $("legacyRemove").disabled = busy || !removable;
  $("legacySkip").hidden = !(failed && storage.migrationUnreadable);
  $("legacySkip").disabled = busy;
}

function renderStorage() {
  const m = storage.mode;
  const ready = m === "ready";
  let text = "";
  let action = "";
  let label = "";
  if (m === "unavailable" || m === "failed") {
    text = storage.reason;
    action = "retry";
    label = t("storage.retry");
  } else if (m === "outdated") {
    text = storage.reason;
    action = "reload";
    label = t("storage.reload");
  } else if (m === "connecting") {
    text = storage.reason;   // empty unless another window is blocking an update
  }
  const banner = $("storageBanner");
  banner.hidden = !text;
  banner.classList.toggle("blocked", m !== "connecting");
  $("bannerText").textContent = text;
  $("bannerAction").hidden = !action;
  $("bannerAction").textContent = label;
  $("bannerAction").dataset.action = action;
  updateBannerHeight();

  const stateText = t("storage.state." + m);
  const lastBackup = storage.backup.lastBackupAt;
  $("dataFile").textContent = t("storage.database");
  $("dataState").textContent = stateText;
  $("dataState").className = "state-" + m;
  $("dataSummary").textContent = ready ? describeData(state) : "-";
  $("dataSaved").textContent = ready && state.lastSaved ? formatDateTime(state.lastSaved) : ready ? t("storage.nothingSavedYet") : "-";
  $("dataBackup").textContent = lastBackup
    ? formatDateTime(lastBackup) + (storage.backup.lastBackupFile ? ` (${storage.backup.lastBackupFile})` : "")
    : t("storage.never");
  $("dataQuota").textContent = quotaText();
  $("dataNote").textContent = t("storage.note");

  const locked = busy || !ready;
  $("exportBackup").disabled = locked;
  $("importBackup").disabled = locked;
  $("backupDays").disabled = locked;
  $("backupDaysSave").disabled = locked;
  $("persistBtn").hidden = storage.persisted !== false;
  $("persistBtn").disabled = busy;
  renderReminder();
  renderAutoBackup();
  renderLegacy();
}

// Called after the in-memory data was replaced from the file, a backup or another window.
function refreshAfterLoad() {
  // The invoice being corrected was deleted in another window: the edit has nothing left to change.
  if (state.invoiceEdit && !state.invoices.some((i) => i.id === state.invoiceEdit.id)) {
    state.invoiceEdit = null;
    showView("invoices");
    notify(t("edit.gone"), "error");
  }
  if (state.editingId && !findProduct(state.editingId)) resetProductForm();
  if (state.selectedId && !findProduct(state.selectedId)) state.selectedId = null;
  const notes = syncSaleWithProducts();
  showError("saleError", "");
  fillSettingsForm();
  renderAll();
  renderStorage();
  if (notes.length) notify(notes.join(" "), "error");
  onDebtDataChanged();
}

function renderAll() {
  applyLanguage();
  renderProductFormMode();
  stockForm.renderRows();
  applyPaperSize();
  applyCurrency();
  renderResults();
  renderSelected();
  renderSale();
  renderStock();
  renderInvoices();
  renderInvoice();
  PurchasesUI.render();
  renderDebtUi();
  if (state.view === "editinvoice" && state.invoiceEdit) renderInvoiceEdit();
}

/* ==========================================================================
   OUTSTANDING CUSTOMER DEBT (Sell page)
   Recognizes a returning customer, shows what they still owe, and lets the person carry it onto the sale.
   Everything here is a draft on the screen: nothing is written until the sale is completed (see applySale).
   ========================================================================== */

const BELL_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>';

let debtNoticeCache = "";
let debtDialogReturnFocus = null;

const debtDirectory = () => Debt.directory(state.invoices, state.debtTransfers);

// How much of an older invoice is already on the sale being prepared.
function draftAmountFor(invoiceId) {
  const entry = (state.sale.debts || []).find((d) => d.sourceInvoiceId === invoiceId);
  return entry ? round2(toNumber(entry.amount)) : 0;
}

// What the notice has to show for the customer on the sale right now (null until the customer is confirmed/selected,
// so nothing appears while the name is still being typed).
//   { kind: "confirmed", key, group, owed }  or  { kind: "choose", key, candidates: [{ group, owed }] }
function debtView() {
  if (!state.debtUi.armed) return null;
  const resolved = Debt.resolve(state.sale.customer, debtDirectory(), state.sale.identity);
  if (resolved.status === "confirmed") {
    const owed = Debt.outstanding(resolved.group, state.debtTransfers);
    return owed.count ? { kind: "confirmed", key: resolved.group.keys[0], group: resolved.group, owed } : null;
  }
  if (resolved.status === "choose") {
    const candidates = resolved.candidates
      .map((group) => ({ group, owed: Debt.outstanding(group, state.debtTransfers) }))
      .filter((c) => c.owed.count);
    return candidates.length ? { kind: "choose", key: "choose:" + candidates.map((c) => c.group.keys[0]).join("|"), candidates } : null;
  }
  return null;
}

const debtDismissed = (view) => !!view && state.debtUi.dismissedKey === view.key;

function debtInvoiceCard(row) {
  const inv = row.invoice;
  const cur = inv.currency;
  const inSale = draftAmountFor(inv.id);
  const transferred = row.transferred > 0 ? `<div><dt>${esc(t("debt.row.transferred"))}</dt><dd>${esc(money(row.transferred, cur))}</dd></div>` : "";
  return `<li class="debt-invoice">` +
    `<div class="debt-invoice-head"><span class="debt-invoice-title">${esc(t("debt.invoiceHeading", { number: inv.invoiceNumber, date: formatDate(inv.date) }))}</span>` +
    `<button type="button" class="btn small" data-debt-view="${esc(inv.id)}" aria-label="${esc(t("debt.viewAria", { number: inv.invoiceNumber }))}">${esc(t("debt.viewInvoice"))}</button></div>` +
    `<dl class="debt-figures">` +
    `<div><dt>${esc(t("debt.row.total"))}</dt><dd>${esc(money(row.due, cur))}</dd></div>` +
    `<div><dt>${esc(t("debt.row.paid"))}</dt><dd>${esc(money(row.paid, cur))}</dd></div>` +
    transferred +
    `<div class="debt-outstanding"><dt>${esc(t("debt.row.outstanding"))}</dt><dd>${esc(money(row.available, cur))}</dd></div>` +
    `</dl>` +
    (inSale > 0 ? `<p class="debt-insale small">${esc(t("debt.inSale", { amount: money(inSale, cur) }))}</p>` : "") +
    `</li>`;
}

function debtNoticeHtml(view) {
  if (!view) return "";
  const head = (title, subtitle) => `<div class="debt-head"><span class="debt-icon">${BELL_ICON}</span><div><h3 id="debtNoticeTitle">${esc(title)}</h3><p class="muted small">${esc(subtitle)}</p></div></div>`;
  const later = `<button type="button" class="btn" data-debt-action="later">${esc(t("debt.later"))}</button>`;

  if (view.kind === "choose") {
    const items = view.candidates.map(({ group, owed }) => {
      const label = group.name + (group.phone ? " · " + group.phone : " · " + t("debt.noPhone"));
      return `<li class="debt-candidate"><div><strong>${esc(label)}</strong><div class="muted small">${esc(tn("debt.unpaidCount", owed.count))} · ${esc(t("debt.chooseOwed", { amount: money(owed.total) }))}</div></div>` +
        `<button type="button" class="btn small primary" data-debt-pick="${esc(group.keys[0])}" aria-label="${esc(t("debt.chooseAria", { name: group.name }))}">${esc(t("debt.chooseBtn"))}</button></li>`;
    }).join("");
    return head(t("debt.chooseTitle"), t("debt.chooseText")) + `<ul class="debt-candidates">${items}</ul><div class="debt-actions">${later}</div>`;
  }

  const { group, owed } = view;
  const available = owed.rows.filter((row) => draftAmountFor(row.invoice.id) <= 0);
  const addBtn = available.length ? `<button type="button" class="btn primary" data-debt-action="add">${esc(t("debt.add"))}</button>` : "";
  return head(t("debt.title"), t("debt.subtitle")) +
    `<p class="debt-customer"><strong>${esc(t("debt.customer", { name: group.name }))}</strong> · ${esc(tn("debt.unpaidCount", owed.count))}</p>` +
    `<ul class="debt-list">${owed.rows.map(debtInvoiceCard).join("")}</ul>` +
    `<p class="debt-total"><span>${esc(t("debt.totalOutstanding"))}</span><strong>${esc(money(owed.total))}</strong></p>` +
    `<div class="debt-actions">${addBtn}${later}</div>`;
}

function renderDebtUi() {
  const view = debtView();
  const hidden = !view || debtDismissed(view);
  const notice = $("debtNotice");
  const html = hidden ? "" : debtNoticeHtml(view);
  notice.hidden = hidden;
  // Only touch the card when it changed, so a screen reader does not re-read it and focus is not lost.
  if (html !== debtNoticeCache) { notice.innerHTML = html; debtNoticeCache = html; }

  // After "Remind Me Later" a small reminder stays beside the customer fields.
  const reminder = $("debtReminder");
  const reminded = !!view && view.kind === "confirmed" && debtDismissed(view);
  reminder.hidden = !reminded;
  $("debtReminderText").textContent = reminded ? t("debt.reminder", { amount: money(view.owed.total) }) : "";
  renderSuggestions();
}

function renderSuggestions() {
  const list = $("custSuggest");
  const input = $("custName");
  const items = state.debtUi.suggestions;
  const open = items.length > 0;
  list.hidden = !open;
  list.innerHTML = items.map((group, i) =>
    `<li role="option" id="custSuggest-${i}" data-debt-pick="${esc(group.keys[0])}" aria-selected="${i === state.debtUi.suggestIndex}"${i === state.debtUi.suggestIndex ? ' class="active"' : ""}>` +
    `<span>${esc(group.name)}${group.phone ? " · " + esc(group.phone) : ""}</span>` +
    (group.debt > 0 ? `<span class="owes">${esc(t("debt.suggestOwes", { amount: money(group.debt) }))}</span>` : "") + `</li>`).join("");
  input.setAttribute("aria-expanded", String(open));
  if (open && state.debtUi.suggestIndex >= 0) input.setAttribute("aria-activedescendant", "custSuggest-" + state.debtUi.suggestIndex);
  else input.removeAttribute("aria-activedescendant");
}

// The carried-forward lines of the sale on screen (with a button to take one out again).
function renderSaleDebts() {
  const box = $("saleDebts");
  const lines = draftCarriedLines(state.sale);
  box.hidden = lines.length === 0;
  if (!lines.length) { box.innerHTML = ""; return; }
  box.innerHTML = `<h3>${esc(t("debt.draftTitle"))}</h3><ul>` + lines.map((l) =>
    `<li><div><strong>${esc(t("debt.draftLine", { number: l.sourceInvoiceNumber }))}</strong><div class="muted small">${esc(formatDate(l.sourceDate))}</div></div>` +
    `<span class="debt-amount">${esc(money(l.amount))}</span>` +
    `<button type="button" class="btn small danger" data-debt-remove="${esc(l.sourceInvoiceId)}" aria-label="${esc(t("debt.removeAria", { number: l.sourceInvoiceNumber }))}">${esc(t("common.remove"))}</button></li>`).join("") +
    `</ul><p class="muted small">${esc(t("debt.draftNote"))}</p>`;
}

// The customer fields were typed in: nothing is looked up until the person settles on a customer.
function onCustomerTyped(field) {
  const ui = state.debtUi;
  ui.armed = false;
  ui.dismissedKey = null;
  ui.suggestIndex = -1;
  ui.suggestions = field === "name" ? Debt.suggest(state.sale.customer.name, debtDirectory()) : [];
  dropDebtsIfCustomerChanged();
  renderDebtUi();
}

// Debt on the sale belongs to ONE customer: when the name or phone no longer identifies them, it comes off.
function dropDebtsIfCustomerChanged() {
  if (!state.sale.debts.length) return;
  const ctx = debtContext();
  const theirs = ctx.group && state.sale.debts.every((d) => ctx.group.invoices.some((i) => i.id === d.sourceInvoiceId));
  if (theirs) return;
  state.sale.debts = [];
  notify(t("debt.customerChanged"), "error");
}

// The person finished with the customer fields (left them, pressed Enter): now their debt may be looked up.
function onCustomerSettled() {
  const ui = state.debtUi;
  ui.armed = true;
  ui.suggestions = [];
  ui.suggestIndex = -1;
  renderDebtUi();
  scrollDebtNoticeIntoView();
}

function scrollDebtNoticeIntoView() {
  const notice = $("debtNotice");
  if (!notice.hidden && typeof notice.scrollIntoView === "function") notice.scrollIntoView({ block: "nearest" });
}

// The person chose a customer from the suggestions or from the "is this the customer?" list.
function pickCustomer(key) {
  const group = debtDirectory().find((g) => g.keys.includes(key));
  if (!group) return;
  const c = state.sale.customer;
  c.name = group.name;
  c.phone = group.phone || "";
  if (!String(c.address).trim()) c.address = group.address || "";
  $("custName").value = c.name;
  $("custPhone").value = c.phone;
  $("custAddress").value = c.address;
  state.sale.identity = Debt.identityOf(group, c);
  Object.assign(state.debtUi, { armed: true, dismissedKey: null, suggestions: [], suggestIndex: -1 });
  dropDebtsIfCustomerChanged();
  refreshLive();
  renderSaleDebts();
  renderDebtUi();
  scrollDebtNoticeIntoView();
}

function dismissDebtNotice() {
  const view = debtView();
  if (!view) return;
  state.debtUi.dismissedKey = view.key;
  renderDebtUi();
  const field = $("custName");
  if (field && field.focus) field.focus();
}

function showDebtNoticeAgain() {
  state.debtUi.dismissedKey = null;
  renderDebtUi();
  const first = $("debtNotice").querySelector && $("debtNotice").querySelector("button");
  if (first && first.focus) first.focus();
}

// Adds [{ sourceInvoiceId, amount }] to the sale (all or nothing). { ok } or { error }.
function addDebtToSale(picks) {
  const result = Debt.addToDraft(state.sale.debts, picks, debtContext());
  if (result.error) return { error: result.error };
  state.sale.debts = result.draft;
  const numbers = picks.map((p) => (state.invoices.find((i) => i.id === p.sourceInvoiceId) || {}).invoiceNumber).filter(Boolean).join(", ");
  showError("saleError", paidError());
  refreshLive();
  renderSaleDebts();
  renderDebtUi();
  notify(t("debt.added", { numbers }));
  return { ok: true };
}

function removeDebtFromSale(invoiceId) {
  const source = state.invoices.find((i) => i.id === invoiceId);
  state.sale.debts = Debt.removeFromDraft(state.sale.debts, invoiceId);
  showError("saleError", paidError());
  refreshLive();
  renderSaleDebts();
  renderDebtUi();
  if (source) notify(t("debt.removed", { number: source.invoiceNumber }));
}

// Called when saved data changed under the sale on screen (a payment, a deletion, a restored backup, another window):
// the draft amounts are checked against the new balances and lowered or removed when they no longer fit.
function onDebtDataChanged() {
  if (state.sale.debts.length) {
    const { draft, notes } = Debt.syncDraft(state.sale.debts, debtContext());
    if (notes.length) {
      state.sale.debts = draft;
      notify(notes.join(" "), "error");
    }
  }
  renderSaleDebts();
  renderTotals();
  renderInvoice();
  renderDebtUi();
}

/* ---------- Confirmation dialog ---------- */

function debtDialogRowsData() {
  const view = debtView() || {};
  const owed = view.kind === "confirmed" ? view.owed : Debt.outstanding({ invoices: [] }, state.debtTransfers);
  return owed.rows.filter((row) => draftAmountFor(row.invoice.id) <= 0);
}

function openDebtDialog() {
  const rows = debtDialogRowsData();
  if (!rows.length) return false;
  debtDialogReturnFocus = typeof document.activeElement !== "undefined" ? document.activeElement : null;
  $("debtDialogRows").innerHTML = rows.map((row) => {
    const inv = row.invoice;
    const n = esc(inv.invoiceNumber);
    return `<div class="debt-dialog-row" data-id="${esc(inv.id)}" data-available="${row.available}">` +
      `<label class="debt-dialog-pick"><input type="checkbox" data-debt-include${rows.length === 1 ? " checked" : ""} aria-label="${esc(t("debt.dialogPick", { number: inv.invoiceNumber }))}"> <strong>${esc(t("debt.dialogInvoice"))}: ${n}</strong></label>` +
      `<div class="debt-dialog-figs"><span>${esc(t("debt.dialogDate"))}</span><span>${esc(formatDate(inv.date))}</span>` +
      `<span>${esc(t("debt.dialogRemaining"))}</span><span>${esc(money(row.available, inv.currency))}</span></div>` +
      `<label class="debt-dialog-amount"><span>${esc(t("debt.dialogAmount"))}</span>` +
      `<input type="number" inputmode="decimal" min="0.01" step="0.01" max="${row.available}" value="${row.available}" data-debt-amount aria-label="${esc(t("debt.dialogAmountAria", { number: inv.invoiceNumber }))}"${rows.length === 1 ? "" : " disabled"}></label>` +
      `</div>`;
  }).join("");
  showError("debtDialogError", "");
  updateDebtDialogTotals();
  const dialog = $("debtDialog");
  if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "");
  const first = $("debtDialogRows").querySelector && $("debtDialogRows").querySelector("input");
  if (first && first.focus) first.focus();
  return true;
}

function closeDebtDialog() {
  const dialog = $("debtDialog");
  if (typeof dialog.close === "function") dialog.close(); else dialog.removeAttribute("open");
  if (debtDialogReturnFocus && typeof debtDialogReturnFocus.focus === "function") debtDialogReturnFocus.focus();
  debtDialogReturnFocus = null;
}

// What the person ticked in the dialog: [{ sourceInvoiceId, amount }] (the amount as typed, checked later).
function collectDebtPicks() {
  const picks = [];
  for (const row of $("debtDialogRows").querySelectorAll(".debt-dialog-row")) {
    if (!row.querySelector("[data-debt-include]").checked) continue;
    picks.push({ sourceInvoiceId: row.dataset.id, amount: row.querySelector("[data-debt-amount]").value.trim() });
  }
  return picks;
}

function updateDebtDialogTotals() {
  const adding = round2(collectDebtPicks().reduce((sum, p) => { const n = Number(p.amount); return sum + (Number.isFinite(n) && n > 0 ? n : 0); }, 0));
  const current = saleDue(state.sale);
  $("debtDialogAdding").textContent = money(adding);
  $("debtDialogCurrent").textContent = money(current);
  $("debtDialogNew").textContent = money(round2(current + adding));
}

function confirmDebtDialog() {
  const picks = collectDebtPicks();
  if (!picks.length) { showError("debtDialogError", t("debt.dialogNone")); return; }
  const result = addDebtToSale(picks);
  if (result.error) { showError("debtDialogError", result.error); return; }
  closeDebtDialog();
}

/* ==========================================================================
   NAVIGATION
   ========================================================================== */

// The open page is remembered for this browser tab only (sessionStorage), so if the page is ever reloaded
// (a browser refresh, a development server reloading on a file change) it comes back on the same page
// instead of Sell. This is screen position only; no business data is kept there.
const VIEW_KEY = "invoisy-view";
function rememberView(name) {
  try { sessionStorage.setItem(VIEW_KEY, name); } catch { /* storage blocked: the page just opens on Sell */ }
}
function rememberedView() {
  try {
    const name = sessionStorage.getItem(VIEW_KEY);
    if (name && document.querySelector('.nav-btn[data-view="' + name + '"]')) return name;
  } catch { /* storage blocked */ }
  return "sell";
}

function showView(name, options) {
  // Leaving the edit screen with typed changes asks first; leaving with none just closes it.
  if (state.view === "editinvoice" && name !== "editinvoice" && state.invoiceEdit) {
    if (editDirty() && !confirm(t("edit.leaveConfirm"))) return false;
    state.invoiceEdit = null;
  }
  const keepPreview = options && options.keepPreview;
  const previous = state.view;
  state.view = name;

  document.querySelectorAll(".view").forEach((v) => { v.hidden = v.id !== "view-" + name; });
  document.querySelectorAll(".nav-btn").forEach((b) => {
    if (b.dataset.view === name) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  $("app").dataset.view = name;
  if (name !== "editinvoice") rememberView(name);

  let notes = [];
  if (name === "sell") {
    notes = syncSaleWithProducts();
    if (!keepPreview && previous !== "sell") state.previewInvoice = null;
  }
  if (name === "settings") fillSettingsForm();

  renderAll();
  if (notes.length) notify(notes.join(" "), "error");
  return true;
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
  // The Stock form's fields are drawn by the shared product form (product-form.js); it handles its own price rows.
  const productFields = $("productFields");
  productFields.innerHTML = stockForm.html();
  for (const type of ["input", "change", "click"]) productFields.addEventListener(type, (e) => stockForm.handle(e));
  productFields.addEventListener("input", (e) => { if (e.target && (e.target.id === "pName" || e.target.id === "pTileSize")) renderProductSuggestions(); });
  productFields.addEventListener("click", (e) => {
    const btn = e.target && e.target.closest && e.target.closest("[data-similar]");
    const item = btn && btn.closest("[data-id]");
    if (item) useSuggestion(item.dataset.id, btn.dataset.similar);
  });

  // Navigation and shared buttons
  document.querySelectorAll(".nav-btn").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.view === state.view) PurchasesUI.home(b.dataset.view);   // the menu button of the open page returns to its list
    showView(b.dataset.view);
  }));
  $("brand").addEventListener("click", () => showView("sell"));
  document.addEventListener("click", (e) => {
    const action = e.target.closest("[data-action='goto-add'], [data-action='demo']");
    if (!action) return;
    if (action.dataset.action === "goto-add") goToAddProduct();
    else loadDemoData();
  });

  PurchasesUI.bind();

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
      showError("addError", result.error + (result.lowStock ? " " + t("sell.partialHint") : ""));
      $("addQty").focus();
      return;
    }
    showError("addError", "");
    showError("saleError", "");
    // An area was turned into whole boxes: say what was added (what was asked, the boxes, and the m² they cover).
    if (result.converted) {
      const c = result.converted;
      notify(I18n.tn("sale.areaToBoxes", c.boxes, { requested: numberFormat.format(c.requested), exact: numberFormat.format(c.exact), area: numberFormat.format(c.area) }));
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
    const field = input.dataset.field;
    if (field === "partial") return;   // the checkbox is handled on "change"
    const wasPartial = Boolean(findSaleItem(id) && findSaleItem(id).partial);
    const result = field === "qty" ? updateSaleQuantity(id, input.value.trim())
      : field === "deliver" ? updateSaleDeliverNow(id, input.value.trim())
      : updateSalePrice(id, input.value.trim());
    if (result.clamped) input.value = field === "deliver" ? findSaleItem(id).deliverNow : findSaleItem(id).qty;
    // A quantity brought back to the stock: tell the person they can sell it all and let the customer collect the rest later.
    const hint = result.clamped && field === "qty" && !wasPartial ? " " + t("sell.partialHint") : "";
    row.querySelector("[data-row-error]").textContent = result.error ? result.error + hint : "";
    showError("saleError", "");
    refreshLive();
  });
  saleBody.addEventListener("change", (e) => {
    const toggle = e.target.closest("input[data-field='partial']");
    if (toggle) {
      const result = setSalePartial(toggle.closest("tr").dataset.id, toggle.checked);
      if (result.error) notify(result.error, "error");
      showError("saleError", "");
      state.previewInvoice = null;
      renderSale();
      renderInvoice();
      return;
    }
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
      if (result.priceReset) notify(t("sell.priceReset", { unit: unitLabel(line.sellingUnit, 1).toLowerCase() }));
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
    input.value = input.dataset.field === "qty" ? item.qty : input.dataset.field === "deliver" ? item.deliverNow : item.unitPrice;
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
      if (key !== "address") onCustomerTyped(key);       // a changed name or phone may change who the customer is
      refreshLive();
      if (key !== "address") renderSaleDebts();
    });
  }
  // The optional second customer name is plain data entry: it never identifies a debt, so it needs none of the above.
  $("custName2").addEventListener("input", () => {
    state.sale.secondCustomer.name = $("custName2").value;
    refreshLive();
  });
  // The debt of a returning customer is looked up when the person settles on them (leaves the field, Enter, or picks
  // a suggestion), never while they are still typing.
  for (const id of ["custName", "custPhone"]) {
    $(id).addEventListener("change", onCustomerSettled);
  }
  $("custName").addEventListener("keydown", (e) => {
    const ui = state.debtUi;
    const count = ui.suggestions.length;
    if (e.key === "ArrowDown" && count) {
      e.preventDefault();
      ui.suggestIndex = (ui.suggestIndex + 1) % count;
      renderSuggestions();
    } else if (e.key === "ArrowUp" && count) {
      e.preventDefault();
      ui.suggestIndex = (ui.suggestIndex - 1 + count) % count;
      renderSuggestions();
    } else if (e.key === "Enter") {
      if (count && ui.suggestIndex >= 0) { e.preventDefault(); pickCustomer(ui.suggestions[ui.suggestIndex].keys[0]); }
      else onCustomerSettled();
    } else if (e.key === "Escape" && count) {
      e.preventDefault();
      ui.suggestions = [];
      ui.suggestIndex = -1;
      renderSuggestions();
    }
  });
  $("custName").addEventListener("blur", () => {
    if (!state.debtUi.suggestions.length) return;
    state.debtUi.suggestions = [];
    state.debtUi.suggestIndex = -1;
    renderSuggestions();
  });
  $("custPhone").addEventListener("keydown", (e) => { if (e.key === "Enter") onCustomerSettled(); });
  // mousedown (not click) so the name field keeps focus and its blur does not close the list before the choice is made
  $("custSuggest").addEventListener("mousedown", (e) => {
    const item = e.target.closest("[data-debt-pick]");
    if (!item) return;
    e.preventDefault();
    pickCustomer(item.dataset.debtPick);
  });
  $("debtNotice").addEventListener("click", (e) => {
    const view = e.target.closest("[data-debt-view]");
    if (view) {
      viewInvoice(view.dataset.debtView);
      const preview = document.querySelector(".preview-panel");
      if (preview && typeof preview.scrollIntoView === "function") preview.scrollIntoView({ block: "start" });
      return;
    }
    const pick = e.target.closest("[data-debt-pick]");
    if (pick) { pickCustomer(pick.dataset.debtPick); return; }
    const action = e.target.closest("[data-debt-action]");
    if (!action) return;
    if (action.dataset.debtAction === "add") openDebtDialog();
    else if (action.dataset.debtAction === "later") dismissDebtNotice();
  });
  $("debtNotice").addEventListener("keydown", (e) => { if (e.key === "Escape") dismissDebtNotice(); });
  $("debtReminderShow").addEventListener("click", showDebtNoticeAgain);
  $("saleDebts").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-debt-remove]");
    if (btn) removeDebtFromSale(btn.dataset.debtRemove);
  });
  $("debtForm").addEventListener("submit", (e) => { e.preventDefault(); confirmDebtDialog(); });
  $("debtDialogCancel").addEventListener("click", closeDebtDialog);
  $("debtDialog").addEventListener("cancel", (e) => { e.preventDefault(); closeDebtDialog(); });
  $("debtDialogRows").addEventListener("change", (e) => {
    const row = e.target.closest(".debt-dialog-row");
    if (row && e.target.matches("[data-debt-include]")) row.querySelector("[data-debt-amount]").disabled = !e.target.checked;
    showError("debtDialogError", "");
    updateDebtDialogTotals();
  });
  $("debtDialogRows").addEventListener("input", () => { showError("debtDialogError", ""); updateDebtDialogTotals(); });
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
  // The question after a sale. Esc means Later. Holding Enter down must not press a button again, and a second activation is
  // ignored anyway (saleDoneAction clears what is pending first).
  for (const [id, action] of [["saleDonePrint", "print"], ["saleDoneNew", "new"], ["saleDoneLater", "later"]]) {
    $(id).addEventListener("click", () => saleDoneAction(action));
    $(id).addEventListener("keydown", (e) => { if (e.key === "Enter" && e.repeat) e.preventDefault(); });
  }
  $("saleDoneDialog").addEventListener("cancel", (e) => { e.preventDefault(); saleDoneAction("later"); });

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
      notify(result.message);
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
    else if (btn.dataset.action === "collect") {
      viewInvoice(id);
      const first = document.querySelector("[data-collect-qty]");
      if (first) first.focus();
    }
    else if (btn.dataset.action === "print") printInvoice(state.invoices.find((i) => i.id === id));
    else if (btn.dataset.action === "edit") startEditInvoice(id);
    else if (btn.dataset.action === "delete") deleteInvoice(id);
  });

  $("invoiceFilter").addEventListener("input", renderInvoices);
  $("invoicePayFilter").addEventListener("change", () => { invoiceView.pay = $("invoicePayFilter").value; renderInvoices(); });
  $("invoiceDeliveryFilter").addEventListener("change", () => { invoiceView.delivery = $("invoiceDeliveryFilter").value; renderInvoices(); });
  $("invoiceClear").addEventListener("click", clearInvoiceFilters);
  document.querySelectorAll("[data-sort]").forEach((btn) => btn.addEventListener("click", () => setInvoiceSort(btn.dataset.sort)));

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
      notify(t("pay.added"));
    });
  });
  $("payAmount").addEventListener("input", () => showError("payError", ""));

  // Record goods collected later on the invoice shown in the preview (delivery only: the invoice and its payments are untouched)
  $("collectForm").addEventListener("submit", (e) => {
    e.preventDefault();
    guard(async () => {
      if (!state.previewInvoice) return;
      const entries = [...document.querySelectorAll("[data-collect-qty]")].map((input) => ({ lineId: input.dataset.line, qty: input.value }));
      const result = await recordCollection(state.previewInvoice.id, entries, $("collectNote").value);
      if (result.error) {
        showError("collectError", result.error);
        return;
      }
      showError("collectError", "");
      $("collectNote").value = "";
      const receipts = Validation.collectionReceipts(result.invoice);
      renderStock();
      renderResults();
      renderSelected();
      renderInvoices();
      renderInvoice();
      notify(t("collect.recorded", { number: receipts.length ? receipts[receipts.length - 1].number : result.invoice.invoiceNumber }));
    });
  });
  $("collectForm").addEventListener("input", () => showError("collectError", ""));
  $("collectAll").addEventListener("click", () => {
    document.querySelectorAll("[data-collect-qty]").forEach((input) => { input.value = input.dataset.remaining; });
    showError("collectError", "");
  });
  $("collectPrint").addEventListener("click", () => { if (state.previewInvoice) printCollection(state.previewInvoice.id); });

  // Edit a saved invoice
  $("editInvoiceBtn").addEventListener("click", () => { if (state.previewInvoice) startEditInvoice(state.previewInvoice.id); });
  const editFields = { editName: ["customer", "name"], editPhone: ["customer", "phone"], editAddress: ["customer", "address"] };
  for (const [id, [group, key]] of Object.entries(editFields)) {
    $(id).addEventListener("input", () => { if (state.invoiceEdit) { state.invoiceEdit[group][key] = $(id).value; refreshEditLive(); } });
  }
  $("editName2").addEventListener("input", () => { if (state.invoiceEdit) { state.invoiceEdit.secondName = $("editName2").value; refreshEditLive(); } });
  for (const [id, key] of Object.entries({ editDiscountValue: "discountValue", editDiscountType: "discountType", editTaxValue: "taxValue", editTaxType: "taxType" })) {
    $(id).addEventListener("input", () => { if (state.invoiceEdit) { state.invoiceEdit[key] = $(id).value; refreshEditLive(); } });
  }
  $("editBody").addEventListener("input", (e) => {
    const input = e.target.closest("input[data-field]");
    if (!input || !state.invoiceEdit) return;
    const line = state.invoiceEdit.lines.find((l) => String(l.key) === input.closest("tr").dataset.key);
    if (!line) return;
    line[input.dataset.field === "qty" ? "qty" : "unitPrice"] = input.value;
    refreshEditLive();
  });
  $("editBody").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action='edit-remove']");
    if (!btn) return;
    removeEditLine(btn.closest("tr").dataset.key);
    renderInvoiceEdit();
  });
  $("editSearch").addEventListener("input", () => {
    if (!state.invoiceEdit) return;
    const matches = findMatches($("editSearch").value);
    state.invoiceEdit.pickId = matches.length ? matches[0].id : null;
    showError("editAddError", "");
    renderEditResults();
    const p = findProduct(state.invoiceEdit.pickId);
    if (p) $("editAddUnit").value = Calc.defaultSellingUnit(p);
  });
  $("editResults").addEventListener("click", (e) => {
    const row = e.target.closest(".result");
    if (!row || !state.invoiceEdit) return;
    state.invoiceEdit.pickId = row.dataset.id;
    const p = findProduct(row.dataset.id);
    if (p) $("editAddUnit").value = Calc.defaultSellingUnit(p);
    renderEditResults();
    $("editAddQty").focus();
    $("editAddQty").select();
  });
  $("editAdd").addEventListener("click", () => {
    const r = addEditLine();
    if (r.error) { showError("editAddError", r.error); return; }
    showError("editAddError", "");
    if (r.converted) {
      const c = r.converted;
      notify(I18n.tn("sale.areaToBoxes", c.boxes, { requested: numberFormat.format(c.requested), exact: numberFormat.format(c.exact), area: numberFormat.format(c.area) }));
    }
    state.invoiceEdit.pickId = null;
    $("editSearch").value = "";
    $("editAddQty").value = 1;
    renderInvoiceEdit();
    $("editSearch").focus();
  });
  $("editForm").addEventListener("submit", (e) => { e.preventDefault(); saveInvoiceEdit(); });
  $("editCancel").addEventListener("click", cancelInvoiceEdit);
  // Closing or reloading the page with typed changes asks first.
  window.addEventListener("beforeunload", (e) => {
    if (!editDirty()) return;
    e.preventDefault();
    e.returnValue = "";
  });

  // Preview
  $("printBtn").addEventListener("click", () => printInvoice());
  $("backToSale").addEventListener("click", () => {
    state.previewInvoice = null;
    renderInvoice();
  });

  // Settings
  $("settingsForm").addEventListener("submit", (e) => {
    e.preventDefault();
    saveBusinessSettings();
  });
  $("sPhones").addEventListener("input", (e) => {
    const row = e.target.closest(".phone-row");
    if (row) setPhoneRow(row.dataset.row, e.target.value);
  });
  $("sPhones").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action='remove-phone']");
    if (btn && removePhoneRow(btn.closest(".phone-row").dataset.row)) renderPhoneRows();
  });
  $("addPhone").addEventListener("click", () => {
    const row = addPhoneRow();
    if (!row) return;
    renderPhoneRows();
    const box = $("sPhones").querySelector(`[data-row="${row.rowId}"] input`);
    if (box) box.focus();
  });

  // Language
  $("sLanguage").addEventListener("change", () => saveLanguage($("sLanguage").value));

  // Data storage
  $("exportBackup").addEventListener("click", exportBackup);
  $("backupReminder").addEventListener("click", () => {
    if ($("backupReminder").dataset.mode === "auto") showView("settings");
    else exportBackup();
  });
  $("autoChoose").addEventListener("click", connectBackupFile);
  $("autoGrant").addEventListener("click", grantBackupPermission);
  $("autoRetry").addEventListener("click", retryBackupFile);
  // Coming back to this window is a good moment to try a backup that is waiting (a drive plugged back in, say).
  window.addEventListener("focus", () => { autoBackup.nudge().catch(() => {}); });
  $("importBackup").addEventListener("click", () => $("importFile").click());
  $("importFile").addEventListener("change", (e) => { importBackup(e.target.files[0]); e.target.value = ""; });
  $("backupForm").addEventListener("submit", (e) => { e.preventDefault(); saveBackupInterval(); });
  $("persistBtn").addEventListener("click", askBrowserToKeepData);
  $("legacyDownload").addEventListener("click", downloadLegacyCopy);
  $("legacyRemove").addEventListener("click", removeLegacyCopy);
  $("legacySkip").addEventListener("click", skipLegacyMigration);
  $("bannerAction").addEventListener("click", () => {
    const action = $("bannerAction").dataset.action;
    if (action === "retry") startStorage();
    else if (action === "reload") window.location.reload();
  });
  window.addEventListener("resize", updateBannerHeight);
  $("loadDemo").addEventListener("click", loadDemoData);
  $("chooseLogo").addEventListener("click", () => $("logoFile").click());
  $("logoFile").addEventListener("change", (e) => { chooseLogo(e.target.files[0]); e.target.value = ""; });
  $("removeLogo").addEventListener("click", () => saveLogo(""));
  document.querySelectorAll('input[name="paper"]').forEach((r) => r.addEventListener("change", () => savePaper(r.value)));
}

/* ---------- Start ---------- */

// The Suppliers and Purchases screens (purchases-ui.js) work on this page's data and save through the same commit().
PurchasesUI.init({
  state, db, commit, guard, $, t, tn, esc, money, numberFormat, notify, formatDateTime, productLabel, priceLabel, stockText, formatTileSize,
  downloadText, showView,
});

if (globalThis.__INVOISY_TEST_EXPORTS__) {
  Object.assign(globalThis.__INVOISY_TEST_EXPORTS__, {
    normalizeProduct,
    normalizeTileSize,
    formatTileSize,
    isTileSize,
    addToSale,
    lineUnitProblem,
    updateSaleQuantity,
    updateSaleUnit,
    updateSalePrice,
    validateSale,
    syncSaleWithProducts,
    getSale: () => state.sale,
    getState: () => state,
    getStorage: () => storage,
    renderAll,
    showView,
    draftFromState,
    productProblem,
    productLabel,
    findMatches,
    priceLabel,
    buildInvoiceData,
    calculateTotals,
    renderTotals,
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
    linePriceUnit,
    invoiceLinePrice,
    renderSale,
    invoiceItemLabel,
    invoiceItemTypeHtml,
    productTypeLabel,
    readProductForm,
    stockForm,
    ProductForm,
    setPriceRows: (entries) => stockForm.setRows(entries),
    addPriceRow: () => stockForm.addRow(),
    removePriceRow: (rowId) => stockForm.removeRow(rowId),
    setPriceRowUnit: (rowId, unit) => stockForm.setRowUnit(rowId, unit),
    renderPriceRows: () => stockForm.renderRows(),
    nextPriceUnit: () => stockForm.nextUnit(),
    startEditProduct,
    syncCoverageMark: () => stockForm.syncCoverageMark(),
    buildData,
    applyData,
    commit,
    db,
    autoBackup,
    renderAutoBackup,
    connectBackupFile,
    startStorage,
    loadFromDatabase,
    addProduct,
    updateProduct,
    addStock,
    completeSale,
    deleteInvoice,
    exportBackup,
    importBackup,
    DEFAULT_SETTINGS,
    DEMO_PRODUCTS,
    localizedDemo,
    money,
    customerLabel,
    describeData,
    PurchasesUI,
    Purchases,
    normalizeSettings: Validation.normalizeSettings,
    settingsProblem: Validation.settingsProblem,
    Validation,
    Debt,
    debtView, debtNoticeHtml, renderDebtUi, renderSaleDebts, renderSuggestions, onCustomerTyped, onCustomerSettled, pickCustomer,
    dismissDebtNotice, showDebtNoticeAgain, addDebtToSale, removeDebtFromSale, onDebtDataChanged, debtContext,
    openDebtDialog, closeDebtDialog, confirmDebtDialog, collectDebtPicks, updateDebtDialogTotals, debtDialogRowsData,
    saleDue, saleCarried, draftCarriedLines, carriedToNumbers,
    setSalePartial, updateSaleDeliverNow, deliverNowQty, maxDeliverableNow, deliveryErrors,
    applyCollection, recordCollection, collectionHtml, renderDeliveryBox, qtyText,
    viewInvoice, clearSale, draftInvoice, refreshAfterLoad, renderInvoices, renderInvoice, refreshLive,
    getDebtUi: () => state.debtUi,
    productSuggestions, renderProductSuggestions, useSuggestion, searchInvoices, setInvoiceSort, clearInvoiceFilters, invoiceView, planInvoiceEdit, applyInvoiceEdit, lineStockTaken, startEditInvoice, editInput, editDirty, editPlan, addEditLine, removeEditLine,
    saveInvoiceEdit, cancelInvoiceEdit, renderInvoiceEdit, refreshEditLive, getInvoiceEdit: () => state.invoiceEdit,
    addPhoneRow, removePhoneRow, setPhoneRow, saveBusinessSettings, fillSettingsForm, businessPhonesHtml,
    saleDoneAction, openSaleDoneDialog, getSaleDone: () => state.saleDone, printInvoice,
    businessPhonesHtml, fillSettingsForm, saveBusinessSettings, addPhoneRow, removePhoneRow, setPhoneRow, renderPhoneRows,
    getPhoneRows: () => state.phoneRows,
  });
} else {
  bindEvents();
  resetProductForm();
  showView(rememberedView());
  renderStorage();
  startStorage();
}

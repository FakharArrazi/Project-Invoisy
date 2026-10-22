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

// Text that must keep its own left-to-right order inside right-to-left text (Arabic): tile sizes like 60 × 120 and phone
// numbers. The browser's text direction rules would otherwise swap the parts around ("120 × 60"). English and French are
// returned exactly as given.
function ltr(text) {
  return text && I18n.dir() === "rtl" ? "\u2066" + text + "\u2069" : text;
}

function esc(value) {
  const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => map[c]);
}

function money(amount, currency) {
  // An amount reads left to right in every language ("1,152.5 DA"), also inside Arabic text.
  return ltr(numberFormat.format(amount) + " " + (currency || state.settings.currency));
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
  return ltr(formatDate(iso) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes()));
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
  return `<div><div class="label">${esc(t("inv.customer"))}</div><div class="inv-customer">${esc(customerLabel(cust.name))}${cust.phone ? "\n" + esc(ltr(cust.phone)) : ""}${cust.address ? "\n" + esc(cust.address) : ""}</div>` +
    (second ? `<div class="label inv-second-label">${esc(t("inv.secondCustomer"))}</div><div class="inv-customer">${esc(second)}</div>` : "") + `</div>`;
}

// The phone line of a business header (an invoice, a collection document). One number, or the single number older invoices have,
// reads exactly as before. Several numbers share one compact line, each kept whole, separated by a dot, so the header stays tidy.
function businessPhonesHtml(biz) {
  const phones = Validation.businessPhones(biz);
  if (!phones.length) return "";
  if (phones.length === 1) return `<div>${esc(ltr(phones[0]))}</div>`;
  return `<div class="inv-phones">${phones.map((p) => `<span class="inv-phone">${esc(ltr(p))}</span>`).join('<span class="inv-sep"> · </span>')}</div>`;
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
  return [product.name, ltr(product.tileSize), product.manufacturer].filter(Boolean).join(" — ");
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
  return ltr(m ? `${m[1]} × ${m[2]}` : String(size || "").trim());
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
    items: [],                              // { lineId, productId, qty, sellingUnit, unitPrice, priceUnit, priceQty, requestedArea, ... }: qty is sold / taken from stock in sellingUnit; unitPrice is per priceUnit and is billed for priceQty, the quantity the goods really contain in that unit (see addToSale); requestedArea is the m² the customer asked for, kept only while the line is exactly what that request produced; a line sold beyond the stock also has partial / deliverNow (see deliverNowQty)
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
  invoiceEdit: null,      // set while a saved invoice is edited on the Sell page (state.sale is that invoice; screen-only until Save changes): see startEditInvoice
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
  restoreSaleDone();
  refreshQuota();
  // Reconnects to the backup file chosen earlier and, if the database is ahead of it, brings it up to date. This
  // never waits for the file, never prompts, and a problem with the file never affects the database.
  autoBackup.start().catch(() => {});
  if (notice) notify(notice);
  // A reload right after a save is no longer announced: the data is safe, so no message is shown. The call only
  // clears the remembered save time.
  reloadedRightAfterSave();
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
db.on("commit", (message) => { markCommit(); autoBackup.notifyCommitted(message.revision); });
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
  productFormTouched = false;
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

/* ---------- Editing a saved invoice on the Sell page ----------
   Editing an invoice reuses the Sell page: the saved invoice is loaded into state.sale (see saleFromInvoice) and every
   Sell function (adding a product, the quantity, the unit, the price, the totals, the preview) works on it as it does on a
   new sale. The one difference is the stock: what the saved invoice already took out of stock is available again to the
   edited sale, so a line can be raised from 6 to 10 boxes when only 4 are on the shelf. (More on this at "EDITING A SAVED INVOICE".) */

// Stock (in the product's stock unit) that the saved invoice being edited holds now, for one product. 0 when no invoice is edited.
function stockCredit(productId) {
  const edit = state.invoiceEdit;
  if (!edit) return 0;
  let held = 0;
  for (const item of edit.baseItems) if (item.productId === productId) held += lineStockTaken(item);
  return Calc.cleanNumber(held);
}

// What the sale on screen may use of a product: the shelf stock, plus what the invoice being edited has taken already.
function stockAvail(product) {
  return product ? Calc.cleanNumber(product.stock + stockCredit(product.id)) : 0;
}

// A product as the Sell page shows its stock while an invoice is edited (the shelf stock plus what the invoice holds).
const stockShown = (product) => (state.invoiceEdit && product ? { ...product, stock: stockAvail(product) } : product);

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
  return deliverableFrom(p, item, Calc.cleanNumber(stockAvail(p) - stockUsedInSale(p.id, [item.lineId], sale, data)));
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
  if (!taken.error && !Calc.hasEnoughStock(stockAvail(product), others + taken.value)) {
    item.qty = fitQuantity(product, item.sellingUnit, Calc.cleanNumber(stockAvail(product) - others));
    delete item.requestedArea;
    rebillLine(item, product);   // the line is billed for what it now supplies
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
  return t("sale.stockLow", { available: stockText(stockShown(product)) }) + (inSale ? t("sale.stockInSale", { n: stockText(product, inSale) }) : "");
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

// How many of the line's price unit are in ONE unit sold, for a line loaded from a saved invoice: worked out from what that line
// was sold with (its own saved size and coverage), never from the product as it is today. null when it can't be worked out.
function lineFactor(item) {
  const unit = item.priceUnit || item.sellingUnit;
  if (unit === item.sellingUnit) return 1;
  const f = Calc.getUnitFactor(item.orig, item.sellingUnit, unit);
  return f.error ? null : f.value;
}

// More goods were added to a line: the quantity billed grows with them. `requested` = the m² typed for this addition (only when
// an area was typed). The line keeps the total area the customer asked for only while every addition was an area typed in m²;
// once boxes were added by hand there is no single request left to remember.
function addBilled(item, billed, requested) {
  item.priceQty = Calc.cleanNumber(toNumber(item.priceQty) + billed);
  if (requested != null && item.requestedArea != null) item.requestedArea = Calc.cleanNumber(item.requestedArea + requested);
  else delete item.requestedArea;
}

// The quantity sold changed: the quantity billed follows it, counted in the price unit. For a product priced per m² that
// is the area the whole boxes contain (qty x coverage per box), so the line is always billed for what is supplied.
function rebillLine(item, product) {
  if (item.fromInvoice) {
    const factor = lineFactor(item);
    if (factor !== null) {
      item.priceQty = Calc.cleanNumber(item.qty * factor);
      return;
    }
  }
  const priced = Calc.getUnitPrice(product, item.sellingUnit);
  if (priced.error) return;
  item.priceQty = Calc.cleanNumber(item.qty * priced.factor);
}

function addToSale(productId, rawQty, rawUnit) {
  const product = findProduct(productId);
  if (!product) return { error: t("product.selectFirst") };
  const typedUnit = SALE_LINE_UNITS.includes(rawUnit) ? rawUnit : "piece";
  const checked = Calc.validateQuantity(rawQty, typedUnit);
  if (checked.error) return { error: checked.error };

  // What is really supplied. A product counted in boxes is handed over in whole boxes, so an area typed in m² becomes
  // boxes here, once (10 m² -> 7 boxes with 1.44 m² per box, see Calc.roundBoxes). From this point the line is a box
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

  // What the customer is billed for. The price stays the product's own (1,400 DA/m²) and is billed for the quantity in
  // that unit that is really supplied: the area the whole boxes contain (7 boxes = 10.08 m², although 10 m² were asked
  // for), or for any other line the quantity sold converted to the price unit. The stock above never reads this.
  let billed = Calc.cleanNumber(qty * priced.factor);
  const requested = supplied.converted ? supplied.requested : null;

  const item = state.sale.items.find((i) => i.productId === productId && i.sellingUnit === sellingUnit);
  // Goods added to a line loaded from a saved invoice are billed in that line's own price unit, with what it was sold with.
  if (item && item.fromInvoice) {
    const factor = lineFactor(item);
    if (factor !== null) billed = Calc.cleanNumber(qty * factor);
    if (item.priceQty == null) item.priceQty = item.qty;   // billed for what it sells until now
  }
  // A line marked "deliver only part now" may grow beyond the stock: only what is delivered now has to be in stock.
  if (item && item.partial) {
    item.qty = Calc.cleanNumber(item.qty + qty);
    addBilled(item, billed, requested);
    refitDeliverNow(item);
    return { ok: true };
  }
  const inSale = stockUsedInSale(productId);
  if (!Calc.hasEnoughStock(stockAvail(product), inSale + taken.value)) return { error: stockMessage(product, inSale), lowStock: !state.invoiceEdit };

  if (item) {
    item.qty = Calc.cleanNumber(item.qty + qty);
    addBilled(item, billed, requested);
  } else {
    state.sale.items.push({
      lineId: uid(), productId, qty, sellingUnit,
      unitPrice: priced.basePrice, listPrice: priced.basePrice, priceOverridden: false, catalog: catalogOf(priced),
      priceUnit: priced.priceUnit || sellingUnit, priceQty: billed,
      ...(requested != null ? { requestedArea: requested } : {}),
    });
  }
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
    if (!partial && !Calc.hasEnoughStock(stockAvail(product), others + taken.value)) return { error: stockMessage(product, others), revert: true };
  }
  // A line loaded from a saved invoice: back in the unit it was sold in it is the saved line again (its saved price and
  // conversions, never today's price); in any other unit it is priced like a new Sell line, from the product as it is now.
  if (item.orig && !twin) {
    if (rawUnit === item.orig.sellingUnit) {
      Object.assign(item, saleLineFromItem(item.orig, item.origIndex), { lineId: item.lineId, qty: item.qty });
      rebillLine(item, product);
      return {};
    }
    item.fromInvoice = false;
  }
  item.sellingUnit = rawUnit;
  delete item.requestedArea;
  if (twin) {
    delete twin.requestedArea;
    twin.qty = newQty;
    if (product) rebillLine(twin, product);
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
  // The price of the line is for the unit the product is priced in (DA/m²), not for the unit it is sold in, so changing
  // the unit sold keeps the price, a price typed by hand included, while the price unit stays the same. When the new
  // unit has a price of its own (a saved price per piece, say) the price unit changes: a price typed by hand was for the
  // old price unit, so it is replaced by the new unit's price and the caller tells the person.
  if (!product) {
    item.listPrice = item.unitPrice;
    item.priceOverridden = false;
    return {};
  }
  const priceUnit = priced.priceUnit || rawUnit;
  const keepsPrice = Boolean(item.priceOverridden) && priceUnit === item.priceUnit;
  const priceReset = Boolean(item.priceOverridden) && !keepsPrice;
  item.priceUnit = priceUnit;
  item.listPrice = priced.basePrice;
  item.catalog = catalogOf(priced);
  if (!keepsPrice) {
    item.unitPrice = priced.basePrice;
    item.priceOverridden = false;
  }
  rebillLine(item, product);
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
  const before = item.qty;
  // The quantity billed follows the quantity sold, and the area typed when the line was added no longer applies once it changes.
  const set = (n) => {
    item.qty = n;
    if (n !== before) {
      delete item.requestedArea;   // the quantity is now what was typed here, not what an area produced
      rebillLine(item, product);
    }
  };
  if (item.partial) {
    set(qty);
    refitDeliverNow(item);
    return {};
  }
  const others = stockUsedInSale(item.productId, [lineId]);
  if (!Calc.hasEnoughStock(stockAvail(product), others + taken.value)) {
    set(fitQuantity(product, item.sellingUnit, Calc.cleanNumber(stockAvail(product) - others)));
    return { error: stockMessage(product, others), clamped: true };
  }
  set(qty);
  return {};
}

function updateSalePrice(lineId, rawPrice) {
  const item = findSaleItem(lineId);
  if (!item) return { error: t("sale.lineGone") };
  const price = Number(rawPrice);
  if (rawPrice === "" || !Number.isFinite(price)) return { error: t("sale.enterPrice") };
  if (price < 0) return { error: t("sale.priceNegative") };
  // A hand-typed price belongs to this sale line only. The product's own price is never touched. It is a price per the
  // line's price unit (DA/m²), billed for the quantity in that unit. Money has 2 decimals everywhere
  // in the app, so the price is kept to 2 decimals: the line, the subtotal and the invoice then agree.
  const rounded = Calc.roundMoney(price);
  if (!Number.isFinite(Calc.calculateLineTotal(Calc.lineQuantity(item), rounded))) return { error: t("sale.enterPrice") };
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
  const { payments, paid, refunded, remaining, cls, due, transferredOut, carried, refundDue } = Validation.paymentDetail(inv, state.debtTransfers);
  const status = t({ paid: "inv.status.paid", partial: "inv.status.partial", unpaid: "inv.status.unpaid", transferred: "inv.status.transferred", cancelled: "inv.status.cancelled" }[cls]);
  return { payments, paid, refunded, remaining, status, cls, due, transferredOut, carried, refundDue };
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
    if (p && !Calc.hasEnoughStock(stockAvail(p), total)) errors.push(t("sale.nameMessage", { name: p.name, message: stockMessage(p) }));
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
  if (item.fromInvoice) return;   // a line of a saved invoice keeps the price it was sold at, whatever the product costs now
  const priced = Calc.getUnitPrice(product, item.sellingUnit);
  if (priced.error) return;
  const priceUnit = priced.priceUnit || item.sellingUnit;
  const unitChanged = priceUnit !== item.priceUnit;   // the price is now set in another unit: a price typed for the old one no longer applies
  item.listPrice = priced.basePrice;
  item.catalog = catalogOf(priced);   // what the line's catalogue price now is (it may be a newly saved price for this unit)
  item.priceUnit = priceUnit;
  rebillLine(item, product);   // the area the boxes contain follows the product's current coverage
  if (!unitChanged && item.priceOverridden && round2(item.unitPrice) !== round2(priced.basePrice)) return;
  item.unitPrice = priced.basePrice;
  item.priceOverridden = false;
}

// Keeps the sale in line with the inventory (deleted products, stock lowered elsewhere).
function syncSaleWithProducts() {
  const notes = [];
  const used = new Map();   // stock (in the product's stock unit) already given to earlier lines of the same product
  state.sale.items = state.sale.items.filter((item) => {
    const p = findProduct(item.productId);
    // A line of the invoice being edited is never dropped, repriced or shortened behind the person's back: its price and
    // quantity are the saved ones. A problem with it (stock, a deleted product) is reported when the changes are saved.
    if (item.fromInvoice) {
      const kept = p ? Calc.stockDeduction(p, item.qty, item.sellingUnit) : null;
      if (p && kept && !kept.error) used.set(p.id, Calc.cleanNumber((used.get(p.id) || 0) + kept.value));
      return true;
    }
    if (!p) { notes.push(t("sale.removedGone")); return false; }
    repriceLine(item, p);
    const left = Calc.cleanNumber(stockAvail(p) - (used.get(p.id) || 0));
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
      delete item.requestedArea;
      rebillLine(item, p);
      need = fitNeed;
      notes.push(t("sale.reduced", { name: p.name, stock: stockText(p) }));
    }
    used.set(p.id, Calc.cleanNumber((used.get(p.id) || 0) + need.value));
    return true;
  });
  return notes;
}

function clearSale() {
  if (state.invoiceEdit) return;
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
  const sellingUnit = SELLING_UNITS.includes(item.sellingUnit) ? item.sellingUnit : "piece";
  const priceUnit = item.catalog ? item.catalog.unit : p ? p.priceUnit : null;
  // A line priced in another unit than it is sold in (1,400 DA/m² on boxes) keeps the price that was charged per price unit and,
  // for an area, the m² the goods contain, so the printed invoice can show "7 Boxes, 10.08 m², 1,400 DA/m²" from the line alone.
  const inPriceUnit = Number.isFinite(Number(item.chargedPrice)) && Calc.isUnit(priceUnit) && priceUnit !== sellingUnit;
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
    total: item.lineTotal != null ? item.lineTotal : Calc.calculateLineTotal(item.qty, item.unitPrice),
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
    ...(inPriceUnit ? { chargedPrice: Number(item.chargedPrice) } : {}),
    ...(inPriceUnit && priceUnit === "m2" && item.priceQty != null ? { suppliedArea: Number(item.priceQty) } : {}),
    // What the customer asked for, when it was an area typed in m²: the boxes and suppliedArea are what was really sold.
    ...(item.requestedArea != null ? { requestedArea: Number(item.requestedArea) } : {}),
  };
}

// A sale line prices its billed quantity in the product's price unit (9 m² x 1,150 DA/m²); a saved invoice line keeps
// the price per unit sold, as invoice lines always have (see invoiceLineData). Printing, returns and backups therefore
// read exactly what they always read, and the line total saved is the one the sale showed.
//   billed for the quantity sold: the price of ONE unit sold, worked out from the price unit (1,150 DA/m² -> 1,403 DA/box)
//   billed for another quantity (the m² the boxes contain): the price really charged per unit sold (14,112 DA / 7 boxes = 2,016)
function soldLine(item, product) {
  if (item.priceQty === undefined || item.priceQty === null) return item;   // already per unit sold
  const priced = product ? Calc.getUnitPrice(product, item.sellingUnit) : null;
  // A line of a saved invoice converts with what it was sold with (lineFactor), not with today's product.
  const saved = item.fromInvoice ? lineFactor(item) : null;
  const known = saved !== null ? true : Boolean(priced) && !priced.error;
  const factor = saved !== null ? saved : known ? priced.factor : 1;
  const total = Calc.calculateLineAmount(item);
  const atFactor = Math.abs(Calc.cleanNumber(item.qty * factor) - item.priceQty) < 1e-9;
  // The saved quantity x price must give the saved line total (the invoice's subtotal, the returns and the backup check all
  // read it that way), so a price that does not (cents lost to rounding) is kept exact instead of rounded.
  const exact = Calc.cleanNumber(total / item.qty);
  let perUnit = atFactor ? Calc.roundMoney(item.unitPrice * factor) : exact;
  if (Calc.calculateLineTotal(item.qty, perUnit) !== total) perUnit = exact;
  // `chargedPrice` keeps the price per price unit that was charged (1,400 DA/m², a price typed for this sale included): the saved
  // line is read per unit sold (above), and the printed invoice shows this price instead of a price per box.
  return { ...item, chargedPrice: item.unitPrice, unitPrice: perUnit, listPrice: saved !== null ? perUnit : known ? priced.value : perUnit, lineTotal: total };
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
    return { ...invoiceLineData(soldLine(item, p), p, taken.error ? null : taken.value), ...(tracked ? { lineId: item.lineId } : {}) };
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
    if (state.invoiceEdit) return;   // an invoice is being edited: it is saved with Save changes, never as a new sale
    // A dialog about the previous sale that is still open is treated as "Later" (the invoice stays saved).
    if (state.saleDone) { state.saleDone = null; rememberSaleDone(null); closeSaleDoneDialog(); }
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
  rememberSaleDone(state.saleDone);
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
  rememberSaleDone(null);
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
  // A cancelled sale is a kept record (what was sold, paid and refunded): the database refuses to delete it too.
  if (Validation.isCancelled(inv)) {
    notify(t("invoice.cannotDeleteCancelled", { number: inv.invoiceNumber }), "error");
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
  if (remaining <= 0 && Validation.isCancelled(inv)) return { error: t("pay.cancelledMsg") };
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
   customer link, the payments, the carried-forward debt and the delivery log all stay. The invoice is edited on the Sell
   page itself: it is loaded into state.sale (saleFromInvoice) and everything the Sell page does (search, add, remove,
   quantity, unit, price, discount, tax, the live preview) works on it. What can change is the customer's details, the lines
   (products, quantities, units, prices) and the discount and tax; removing EVERY line cancels the whole sale.

   The rules, all in planInvoiceEdit() so the screen, the tests and the database transaction share them:
     - Stock: what the invoice originally took out of stock (the `stockDeducted` saved on each line, never recalculated from
       today's product data) is given back and what the corrected lines need is taken out, per product, as ONE net change.
       Not enough stock = the whole edit is refused and nothing is changed.
     - History: a line that is kept keeps every saved detail (unit, the price it was sold at, where that price came from, the
       size and coverage it was sold with). Only a quantity or price that was edited changes, and the line total follows. A
       new line (or a line sold in another unit now) is made like a sale line, from the product as it is now.
     - Money: subtotal, discount, tax and total are recalculated only when something financial was edited. Payments are never
       edited or removed. When the new amount due is lower than what is already held (a box returned on a paid invoice), the
       edit is allowed and the difference is a REFUND OR CREDIT DUE to the customer: shown on the screen and the printed
       invoice. It becomes a refund record (separate from the payments) only when it is handed back (recordRefund).
     - Cancellation: with no line left the sale is cancelled (planCancellation): all the stock the invoice took goes back, the
       money actually collected (never more) is recorded as ONE refund, and the invoice keeps what it sold, what it was paid
       and a `cancellation` record. It can not be cancelled, refunded or edited again (Validation.cancellationHistoryProblem).
     - History: each saved edit adds one entry to invoice.edits (when, totals before and after, what was paid, the quantity and
       price of every line that changed, and the stock moved), so the original values stay available for troubleshooting.
     - An invoice sold in several deliveries keeps its products and quantities (its delivery log is a record) and can not be
       cancelled here; prices, customer, discount and tax can still be corrected.
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

// The discount and tax of a saved invoice as the Sell page boxes show them (text).
function invoiceAdjustInputs(inv) {
  const part = (percent, amount) => (percent != null && percent !== "" ? { type: "percent", value: String(percent) } : { type: "amount", value: toNumber(amount) ? String(amount) : "" });
  const d = part(inv.discountPercent, inv.discount);
  const x = part(inv.taxPercent, inv.tax);
  return { discountType: d.type, discountValue: d.value, taxType: x.type, taxValue: x.value };
}

const clean = (v) => String(v == null ? "" : v).trim();

// A saved invoice line as a Sell page line, with the pricing it was sold with (never today's price):
//   - sold at the product's price in the unit it is priced in (2,500 DA/m² for 10 boxes = 14.4 m²): the line shows
//     2,500 DA/m² and bills 14.4 m², as the Sell page does;
//   - anything else (a price typed by hand, a price per box, an area typed in m²): the price really charged per unit sold.
// `orig` is the saved line, `origIndex` its place on the invoice and `fromInvoice` says the line is still in its saved form.
function saleLineFromItem(item, index) {
  const unit = SELLING_UNITS.includes(item.sellingUnit) ? item.sellingUnit : "piece";
  const line = { lineId: uid(), origIndex: index, orig: item, fromInvoice: true, productId: item.productId, qty: item.qty, sellingUnit: unit };
  const savedTotal = round2(item.total != null ? toNumber(item.total) : Calc.calculateLineTotal(item.qty, item.unitPrice));
  const shown = invoiceLinePrice(item);
  if (shown.qtyInPriceUnit != null && Calc.isUnit(shown.unit)) {
    const priced = {
      ...line, unitPrice: shown.price, listPrice: shown.price, priceOverridden: false, priceUnit: shown.unit,
      priceQty: shown.qtyInPriceUnit,
    };
    if (Calc.calculateLineAmount(priced) === savedTotal) return priced;
  }
  const overridden = Boolean(item.priceOverridden);
  return {
    ...line, unitPrice: item.unitPrice, listPrice: overridden && item.calculatedUnitPrice != null ? toNumber(item.calculatedUnitPrice) : item.unitPrice,
    priceOverridden: overridden, priceUnit: unit, priceQty: item.qty,
  };
}

// The sale the Sell page edits for a saved invoice.
function saleFromInvoice(inv) {
  const sale = newSale();
  const c = inv.customer || {};
  sale.customer = { name: !c.name || c.name === WALK_IN ? "" : c.name, phone: c.phone || "", address: c.address || "" };
  sale.secondCustomer = { name: secondCustomerName(inv) };
  Object.assign(sale, invoiceAdjustInputs(inv));
  sale.items = inv.items.map((item, index) => saleLineFromItem(item, index));
  return sale;
}

// Puts a sale's customer, discount, tax and payment into the Sell page boxes.
function loadSaleIntoForm(sale) {
  $("custName").value = sale.customer.name;
  $("custPhone").value = sale.customer.phone;
  $("custAddress").value = sale.customer.address;
  $("custName2").value = secondCustomerName(sale);
  $("discountValue").value = sale.discountValue;
  $("discountType").value = sale.discountType;
  $("taxValue").value = sale.taxValue;
  $("taxType").value = sale.taxType;
  $("amountPaid").value = sale.paidValue;
}

// What is typed on the edited sale, as text, so a change can be told from no change (the "unsaved changes" warnings).
function editSignature(sale = state.sale) {
  return JSON.stringify({
    customer: sale.customer, second: secondCustomerName(sale),
    items: sale.items.map((i) => [i.origIndex == null ? null : i.origIndex, i.productId, i.sellingUnit, i.qty, i.unitPrice, i.priceQty]),
    adjust: [sale.discountType, sale.discountValue, sale.taxType, sale.taxValue],
  });
}

// True when something was typed that is not on the saved invoice.
function editDirty() {
  return Boolean(state.invoiceEdit) && editSignature() !== state.invoiceEdit.initial;
}

// The customer's details as the edit typed them. A blank name is the walk-in customer, as on the Sell page; a detail an old
// invoice never had stays absent while it is blank.
function editedCustomer(inv, sale) {
  const customer = { ...(inv.customer || {}) };
  const typedName = clean(sale.customer && sale.customer.name);
  customer.name = typedName || (inv.customer && inv.customer.name === "" ? "" : WALK_IN);
  for (const key of ["phone", "address"]) {
    const value = clean(sale.customer && sale.customer[key]);
    if (value || key in customer) customer[key] = value;
  }
  return customer;
}

// Cancelling the whole sale (every product removed): the plan, WITHOUT changing anything.
//   Stock: everything the invoice took goes back. Money: what was really collected for THIS sale is refunded, never more:
//   the money held (payments less earlier refunds) minus the old debt carried onto the invoice, which stays owed and settled as it was.
function planCancellation(d, inv, edit) {
  const number = inv.invoiceNumber;
  if (Validation.isTracked(inv)) return { error: t("edit.trackedCancel", { number }) };
  if (Validation.transferredOut(inv, d.debtTransfers || []) > 0) return { error: t("edit.cancelCarried", { number, numbers: carriedToNumbers(inv, d.debtTransfers || []) }) };
  const now = new Date().toISOString();
  const refund = Math.max(0, round2(Validation.netPaid(inv) - Validation.carriedTotal(inv)));
  // The amount shown in the confirmation must be what is refunded: when payments changed since, nothing is cancelled.
  if (edit.confirmedRefund !== undefined && Math.abs(edit.confirmedRefund - refund) > 0.005) return { error: t("edit.cancelChanged", { number }) };
  const restore = new Map();
  const notRestored = [];
  for (const orig of inv.items) {
    const product = findProduct(orig.productId, d);
    if (product) restore.set(product.id, Calc.cleanNumber((restore.get(product.id) || 0) + lineStockTaken(orig)));
    else notRestored.push(invoiceItemLabel(orig));
  }
  const stockChanges = new Map();
  const stockLog = [];
  for (const [productId, back] of restore) {
    const product = findProduct(productId, d);
    const next = Calc.cleanNumber(product.stock + back);
    if (next !== product.stock) {
      stockChanges.set(productId, next);
      stockLog.push({ productId, name: product.name, unit: product.stockUnit || null, change: Calc.cleanNumber(next - product.stock) });
    }
  }
  const paid = Validation.paidTotal(inv);
  const updated = { ...inv, customer: editedCustomer(inv, edit.sale), updatedAt: now };
  const second = secondCustomerName(edit.sale);
  if (second) updated.secondCustomer = { name: second }; else delete updated.secondCustomer;
  updated.cancellation = { at: now, total: inv.total, paid, refund, ...(notRestored.length ? { notRestored } : {}) };
  if (refund > 0) updated.refunds = [...Validation.refundsOf(inv), { id: uid(), amount: refund, timestamp: now, reason: "cancellation" }];
  updated.edits = [...(Array.isArray(inv.edits) ? inv.edits : []), {
    at: now, cancelled: true, totalBefore: inv.total, totalAfter: 0, paid, refund,
    lines: inv.items.map((orig) => ({ name: invoiceItemLabel(orig), unit: orig.sellingUnit, qtyBefore: orig.qty, qtyAfter: 0, priceBefore: orig.unitPrice })),
    ...(stockLog.length ? { stock: stockLog } : {}),
  }];
  const why = Validation.invoiceProblem(updated);
  const result = { invoice: updated, stockChanges, refundDue: 0, cancelled: true, refund, notRestored };
  if (why) return { ...result, error: t("edit.invalid", { number, problem: why }) };
  const ledger = Validation.ledgerProblems(d.invoices.map((i) => (i.id === inv.id ? updated : i)), d.debtTransfers || []);
  if (ledger.length) return { ...result, error: ledger[0] };
  return result;
}

// Plans the corrected invoice WITHOUT changing anything.
//   edit: { sale, baseItems?, confirmedRefund? }
//     sale = a Sell page sale (customer, secondCustomer, items, discountType/Value, taxType/Value). A line that is a saved line
//            of the invoice carries origIndex (its position on the saved invoice); a line added now has none.
//     baseItems = the lines the person started from: when the invoice changed meanwhile (another window), the edit is refused.
//     confirmedRefund = the refund the person confirmed when cancelling: cancelling refuses when payments changed since.
// Returns { skip: true } (nothing to change) or { invoice, stockChanges: Map(productId -> new stock), refundDue, cancelled?, refund? },
// or { error }. A problem found after the corrected invoice could be worked out still carries it as `invoice` (the live preview uses it).
function planInvoiceEdit(d, invoiceId, edit) {
  const inv = d.invoices.find((i) => i.id === invoiceId);
  if (!inv) return { error: t("edit.gone") };
  if (Validation.isCancelled(inv)) return { error: t("edit.cancelledLocked", { number: inv.invoiceNumber }) };
  if (edit.baseItems && !Validation.sameValue(edit.baseItems, inv.items)) return { error: t("edit.changedElsewhere") };
  const sale = edit.sale;
  const lines = Array.isArray(sale.items) ? sale.items : [];
  if (!lines.length) return planCancellation(d, inv, edit);
  const tracked = Validation.isTracked(inv);
  const used = new Set();
  const restore = new Map();   // productId -> stock the invoice holds now, to give back
  const take = new Map();      // productId -> stock the corrected lines need
  const bump = (map, id, n) => map.set(id, Calc.cleanNumber((map.get(id) || 0) + n));
  let linesChanged = lines.length !== inv.items.length;
  const items = [];
  const origOf = [];           // per line: the saved line it keeps, or null for a line made now

  for (const line of lines) {
    const orig = line.origIndex != null ? inv.items[line.origIndex] : null;
    if (line.origIndex != null && !orig) return { error: t("edit.changedElsewhere") };
    if (orig && line.sellingUnit === orig.sellingUnit) {
      // ----- a kept line: every saved detail stays unless this edit changes it -----
      if (used.has(line.origIndex)) return { error: t("edit.changedElsewhere") };
      used.add(line.origIndex);
      const name = invoiceItemLabel(orig);
      const product = findProduct(orig.productId, d);
      const sold = soldLine(line, product);
      const unitPrice = sold.unitPrice;
      const total = sold.lineTotal != null ? sold.lineTotal : Calc.calculateLineTotal(line.qty, unitPrice);
      if (!Number.isFinite(unitPrice) || unitPrice < 0 || !Number.isFinite(total)) return { error: t("edit.linePrice", { name }) };
      const qtyChanged = line.qty !== orig.qty;
      const priceChanged = Math.abs(unitPrice - orig.unitPrice) >= 0.005;
      const item = { ...orig };
      if (qtyChanged) {
        const checked = Calc.validateQuantity(line.qty, orig.sellingUnit);
        if (checked.error) return { error: t("edit.lineError", { name, error: checked.error }) };
        if (tracked) return { error: t("edit.trackedQty", { name }) };
        if (!product) return { error: t("edit.productGone", { name }) };
        if (Calc.isUnit(orig.stockUnit) && Calc.isUnit(product.stockUnit) && orig.stockUnit !== product.stockUnit) return { error: t("edit.stockUnitChanged", { name }) };
        item.qty = Calc.cleanNumber(checked.value);
        // The conversion this line was sold with is kept: its stock use follows the quantity in proportion.
        item.stockDeducted = Calc.cleanNumber(lineStockTaken(orig) * item.qty / orig.qty);
        // The area the boxes contain follows the corrected quantity (from the coverage saved on the line, not the product's current one).
        if (item.suppliedArea != null) {
          const perUnit = Calc.getUnitFactor(item, item.sellingUnit, item.priceUnit);
          if (perUnit.error) delete item.suppliedArea; else item.suppliedArea = Calc.cleanNumber(item.qty * perUnit.value);
        }
      }
      if (priceChanged) {
        item.unitPrice = unitPrice;
        // The price saved per price unit follows the corrected price (2,016 per box = 1,400 per m²).
        if (orig.chargedPrice != null && sold.chargedPrice != null) item.chargedPrice = Calc.roundMoney(sold.chargedPrice);
        // Back at the price the line was calculated at it is a normal price again; any other price is typed by hand.
        item.priceOverridden = Boolean(line.priceOverridden);
        if (item.priceOverridden) item.priceSource = "custom";
        else if (item.priceSource === "custom") delete item.priceSource;
      }
      if (qtyChanged || priceChanged) { item.total = total; linesChanged = true; }
      if (line.origIndex !== items.length) linesChanged = true;   // moved or an earlier line removed
      // Stock: the invoice's own record of what it took, against what the (possibly new) quantity takes.
      if (product) {
        bump(restore, product.id, lineStockTaken(orig));
        bump(take, product.id, lineStockTaken(item));
      }
      items.push(item);
      origOf.push(orig);
    } else {
      // ----- a line made now (or a saved line sold in another unit now): made like a sale line, from the product as it is today -----
      const product = findProduct(line.productId, d);
      if (!product) return { error: t("sale.productMissing") };
      const unit = line.sellingUnit;
      const name = productLabel(product);
      if (!SALE_LINE_UNITS.includes(unit)) return { error: t("sale.chooseUnit") };
      if (unit === "m2" && Calc.suppliesInBoxes(product)) return { error: t("sale.areaInBoxes", { name: product.name }) };
      const checked = Calc.validateQuantity(line.qty, unit);
      if (checked.error) return { error: t("edit.lineError", { name, error: checked.error }) };
      const taken = Calc.stockDeduction(product, checked.value, unit);
      if (taken.error) return { error: taken.error };
      const sold = soldLine({ ...line, fromInvoice: false }, product);
      if (!Number.isFinite(sold.unitPrice) || sold.unitPrice < 0 || !Number.isFinite(sold.lineTotal != null ? sold.lineTotal : Calc.calculateLineTotal(sold.qty, sold.unitPrice))) return { error: t("edit.linePrice", { name }) };
      items.push(invoiceLineData({ ...sold, qty: Calc.cleanNumber(checked.value) }, product, taken.value));
      origOf.push(null);
      bump(take, product.id, taken.value);
      linesChanged = true;
    }
  }
  // A saved line that was removed (or replaced by another unit) hands its stock back.
  inv.items.forEach((orig, index) => {
    if (used.has(index)) return;
    const product = findProduct(orig.productId, d);
    if (product) bump(restore, product.id, lineStockTaken(orig));
  });
  // What changed on each line, kept for the history (a line that stayed the same is not listed).
  const lineLog = [];
  items.forEach((item, n) => {
    const orig = origOf[n];
    if (orig) {
      if (item.qty === orig.qty && item.unitPrice === orig.unitPrice) return;
      lineLog.push({ name: invoiceItemLabel(orig), unit: orig.sellingUnit, qtyBefore: orig.qty, qtyAfter: item.qty,
        ...(item.unitPrice !== orig.unitPrice ? { priceBefore: orig.unitPrice, priceAfter: item.unitPrice } : {}) });
    } else {
      lineLog.push({ name: invoiceItemLabel(item), unit: item.sellingUnit, qtyBefore: 0, qtyAfter: item.qty, priceAfter: item.unitPrice });
    }
  });
  inv.items.forEach((orig, index) => {
    if (!used.has(index)) lineLog.push({ name: invoiceItemLabel(orig), unit: orig.sellingUnit, qtyBefore: orig.qty, qtyAfter: 0, priceBefore: orig.unitPrice });
  });
  if (tracked && (items.length !== inv.items.length || items.some((i, n) => i.lineId !== inv.items[n].lineId || i.qty !== inv.items[n].qty))) return { error: t("edit.trackedLines") };

  // ----- the discount and the tax -----
  const adjust = {
    discountType: sale.discountType === "percent" ? "percent" : "amount", discountValue: clean(sale.discountValue),
    taxType: sale.taxType === "percent" ? "percent" : "amount", taxValue: clean(sale.taxValue),
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

  const updated = { ...inv, customer: editedCustomer(inv, sale), items };
  const second = secondCustomerName(sale);
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
  const stockChanges = new Map();
  const stockLog = [];
  const result = { invoice: updated, stockChanges, refundDue: 0 };
  // ----- the stock: given back and taken, per product, as one net change -----
  for (const productId of new Set([...restore.keys(), ...take.keys()])) {
    const product = findProduct(productId, d);
    const available = Calc.cleanNumber(product.stock + (restore.get(productId) || 0));
    const needed = take.get(productId) || 0;
    if (!Calc.hasEnoughStock(available, needed)) {
      return { ...result, error: t("edit.noStock", { name: product.name, needed: stockText(product, needed), available: stockText(product, available) }) };
    }
    const next = Math.max(0, Calc.cleanNumber(available - needed));
    if (next !== product.stock) {
      stockChanges.set(productId, next);
      stockLog.push({ productId, name: product.name, unit: product.stockUnit || null, change: Calc.cleanNumber(next - product.stock) });
    }
  }
  // ----- the money: payments stay exactly as recorded. Money held for the invoice (payments less refunds already handed back)
  //       above the new amount due is a refund or credit owed to the customer: it is worked out and shown, but never turned
  //       into a payment record. It is recorded as a refund only when it is handed back (recordRefund). -----
  const paid = Validation.paidTotal(inv);
  result.refundDue = Validation.refundDue(updated);
  // ----- the history: this edit's entry, added to the earlier ones -----
  updated.edits = [...(Array.isArray(inv.edits) ? inv.edits : []), {
    at: now, totalBefore: inv.total, totalAfter: updated.total, paid,
    ...(result.refundDue > 0 ? { refundDue: result.refundDue } : {}),
    ...(lineLog.length ? { lines: lineLog } : {}),
    ...(stockLog.length ? { stock: stockLog } : {}),
  }];
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
  return { invoice: plan.invoice, cancelled: Boolean(plan.cancelled), refund: plan.refund || 0 };
}

// Records money handed back to the customer for an invoice that holds more than it asks for (made cheaper after it was paid).
// It is a refund record of its own: the payments are never changed. Never more than is due back, so a refund can't be paid twice.
async function recordRefund(id, rawAmount) {
  const inv = state.invoices.find((i) => i.id === id);
  if (!inv) return { error: t("pay.notFound") };
  const due = paymentInfo(inv).refundDue;
  if (due <= 0) return { error: Validation.isCancelled(inv) ? t("refund.alreadyRefunded") : t("refund.nothingDue") };
  const amount = Number(rawAmount);
  if (rawAmount === "" || !Number.isFinite(amount) || amount <= 0) return { error: t("refund.enterAmount") };
  if (round2(amount) > due) return { error: t("refund.tooMuch", { max: money(due, inv.currency) }) };
  return commit((d) => {
    const target = d.invoices.find((i) => i.id === id);
    if (!target) return { error: t("pay.notFound") };
    if (round2(amount) > Validation.refundDue(target)) return { error: t("refund.tooMuch", { max: money(Validation.refundDue(target), target.currency) }) };
    target.refunds = [...Validation.refundsOf(target), { id: uid(), amount: round2(amount), timestamp: new Date().toISOString(), reason: "refund" }];
    return { invoice: target };
  });
}

/* ---------- The Sell page while an invoice is edited ----------
   state.invoiceEdit = { id, returnTo, baseItems, tracked, stash, initial } marks the mode. state.sale IS the invoice being
   edited; the sale the person was preparing (and the preview they were looking at) wait in `stash` and come back afterwards.
   Nothing is saved, and no stock moves, until Save changes (or Cancel sale and refund, after a confirmation). */

// Opens the Sell page on a saved invoice. { error } when it can not be edited now.
function startEditInvoice(id) {
  const inv = state.invoices.find((i) => i.id === id);
  if (!inv) return { error: t("edit.gone") };
  if (!canWrite()) { const error = blockedMessage(); notify(error, "error"); return { error }; }
  if (Validation.isCancelled(inv)) { const error = t("edit.cancelledLocked", { number: inv.invoiceNumber }); notify(error, "error"); return { error }; }
  if (state.invoiceEdit) {
    if (state.invoiceEdit.id === id) { showView("sell", { keepPreview: true }); return {}; }
    if (editDirty() && !confirm(t("edit.leaveConfirm"))) return { stayed: true };
    endEdit();
  }
  const sale = saleFromInvoice(inv);
  state.invoiceEdit = {
    id, returnTo: state.view === "invoices" ? "invoices" : "sell",
    baseItems: structuredClone(inv.items), tracked: Validation.isTracked(inv),
    stash: { sale: state.sale, previewInvoice: state.previewInvoice, debtUi: state.debtUi },
    initial: "",
  };
  state.sale = sale;
  state.debtUi = { armed: false, dismissedKey: null, suggestions: [], suggestIndex: -1 };
  state.selectedId = null;
  $("search").value = "";
  loadSaleIntoForm(sale);
  state.invoiceEdit.initial = editSignature();
  showError("saleError", "");
  showError("addError", "");
  showView("sell", { keepPreview: true });
  return {};
}

// Closes the edit without saving: the sale the person was preparing comes back. (The caller shows the next screen.)
function endEdit() {
  const edit = state.invoiceEdit;
  if (!edit) return;
  state.invoiceEdit = null;
  state.sale = edit.stash.sale;
  state.previewInvoice = edit.stash.previewInvoice;
  state.debtUi = edit.stash.debtUi;
  loadSaleIntoForm(state.sale);
}

// The plan for what is typed now (for the live preview, the summary and Save).
function editPlan() {
  const edit = state.invoiceEdit;
  return planInvoiceEdit(state, edit.id, { sale: state.sale, baseItems: edit.baseItems });
}

// The corrected invoice as it would be saved (the preview): not saved, never stored.
function editPreviewInvoice() {
  const edit = state.invoiceEdit;
  const plan = editPlan();
  return plan.invoice || state.invoices.find((i) => i.id === edit.id) || null;
}

// The stock this edit would give back or take, one summary row per product (nothing while the edit has a problem).
function editStockRows(plan, row) {
  if (plan.error || !plan.stockChanges) return "";
  let html = "";
  for (const [productId, next] of plan.stockChanges) {
    const product = findProduct(productId);
    if (!product) continue;
    const change = Calc.cleanNumber(next - product.stock);
    if (change === 0) continue;
    html += row(t(change > 0 ? "edit.stockBack" : "edit.stockTaken"), `${productLabel(product)}: ${stockText(product, Math.abs(change))}`);
  }
  return html;
}

// Shows or hides what only an edited invoice has (the banner, Save / Cancel, the paid rows) and hides what only a new sale has.
function renderEditChrome() {
  const edit = state.invoiceEdit;
  const on = Boolean(edit);
  const inv = on ? state.invoices.find((i) => i.id === edit.id) : null;
  $("editBanner").hidden = !on;
  if (on && inv) {
    $("editHeading").textContent = t("edit.heading", { number: inv.invoiceNumber });
    $("editNotes").hidden = !edit.tracked;
    $("editNotes").textContent = edit.tracked ? t("edit.trackedNote") : "";
  }
  for (const id of ["clearSale", "completeSale", "payInputRow", "salePayHint"]) $(id).hidden = on;
  for (const id of ["editCancel", "editSave", "editSavePrint"]) $(id).hidden = !on;
  const locked = on && edit.tracked;
  $("search").disabled = locked;
  $("addQty").disabled = locked;
  $("addUnit").disabled = locked;
}

// The summary of the sale on screen while an invoice is edited: the corrected totals, what is already paid, what remains, the
// refund due, the status after the edit and the stock this would move. Also decides whether Save is possible.
function renderEditTotals() {
  const edit = state.invoiceEdit;
  const saved = state.invoices.find((i) => i.id === edit.id);
  if (!saved) return;
  const plan = editPlan();
  const shown = plan.invoice || saved;
  const pay = paymentInfo(shown);
  const cur = shown.currency;
  const row = (label, value, cls) => `<div${cls ? ` class="${cls}"` : ""}><span>${esc(label)}</span><span>${esc(value)}</span></div>`;
  $("tSubtotal").textContent = money(toNumber(shown.subtotal), cur);
  $("tDiscount").textContent = money(toNumber(shown.discount), cur);
  $("tTax").textContent = money(toNumber(shown.tax), cur);
  $("tTotalLabel").textContent = I18n.t(pay.carried > 0 ? "sell.totalPurchase" : plan.cancelled ? "edit.originalTotal" : "edit.newDue");
  $("tTotalRow").classList.toggle("grand", pay.carried <= 0);
  $("tTotal").textContent = money(toNumber(shown.total), cur);
  $("tCarriedRow").hidden = pay.carried <= 0;
  $("tCarried").textContent = money(pay.carried, cur);
  $("tDueRow").hidden = pay.carried <= 0;
  $("tDue").textContent = money(pay.due, cur);
  $("tRemainingLabel").textContent = t("edit.remainingAfter");
  $("tRemaining").textContent = money(pay.remaining, cur);
  // Paid MORE than the new amount due: the customer is owed the difference. It is shown, and only recorded when handed back.
  $("tEditRows").innerHTML =
    (plan.cancelled ? row(t("edit.cancelNotice"), "", "edit-warn") : "") +
    row(t("edit.paid"), money(pay.paid, cur)) +
    (pay.refunded > 0 && !plan.cancelled ? row(t("inv.refunded"), money(pay.refunded, cur)) : "") +
    (plan.cancelled ? row(t("edit.refundNow"), money(plan.refund, cur), "due edit-warn") : pay.refundDue > 0 ? row(t("edit.refundDue"), money(pay.refundDue, cur), "due edit-warn") : "") +
    row(t("edit.statusAfter"), pay.status) +
    editStockRows(plan, row);
  const bad = Boolean(plan.error);
  showError("saleError", plan.error || "");
  $("editSave").disabled = bad;
  $("editSavePrint").disabled = bad || Boolean(plan.cancelled);
  $("editSave").textContent = t(plan.cancelled ? "edit.cancelSaleBtn" : "edit.save");
  $("editSave").classList.toggle("danger", Boolean(plan.cancelled));
}

// Where the person goes when the edit ends: back to the saved invoice (after a save), or to where they came from.
function leaveEdit(id, saved) {
  const edit = state.invoiceEdit;
  const returnTo = edit ? edit.returnTo : "invoices";
  endEdit();
  if (saved) viewInvoice(id);
  else if (returnTo === "invoices") showView("invoices");
  else showView("sell", { keepPreview: true });
}

function cancelInvoiceEdit() {
  const edit = state.invoiceEdit;
  if (!edit) return { ignored: true };
  if (editDirty() && !confirm(t("edit.leaveConfirm"))) return { stayed: true };
  leaveEdit(edit.id, false);
  return { cancelled: true };
}

// Save changes: ONE transaction for the invoice and the stock (see applyInvoiceEdit). On any problem nothing is changed and
// the screen stays open with what was typed. With every product removed it cancels the sale, after a confirmation that says
// what comes back to stock and what is refunded; declining it changes nothing.
function saveInvoiceEdit(options = {}) {
  return guard(async () => {
    const edit = state.invoiceEdit;
    if (!edit) return;
    const plan = editPlan();
    if (plan.error) {
      showError("saleError", plan.error);
      notify(plan.error, "error");
      return;
    }
    const input = { sale: structuredClone(state.sale), baseItems: edit.baseItems };
    if (plan.cancelled) {
      const inv = state.invoices.find((i) => i.id === edit.id);
      const question = t("edit.cancelConfirm", {
        number: inv.invoiceNumber, total: money(toNumber(inv.total), inv.currency),
        paid: money(Validation.netPaid(inv), inv.currency), refund: money(plan.refund, inv.currency),
      });
      if (!confirm(question)) return;   // nothing was changed
      input.confirmedRefund = plan.refund;
    }
    const r = await commit((d) => applyInvoiceEdit(d, edit.id, input));
    if (r.error) {
      showError("saleError", r.error);
      notify(r.error, "error");
      return;
    }
    const number = (state.invoices.find((i) => i.id === edit.id) || {}).invoiceNumber || "";
    leaveEdit(edit.id, true);
    notify(r.cancelled ? t("edit.cancelled", { number, refund: money(r.refund, (state.invoices.find((i) => i.id === edit.id) || {}).currency) })
      : t(r.skip ? "edit.nothingChanged" : "edit.saved", { number }));
    onDebtDataChanged();
    // Save and print: the invoice is already saved above, and the print is of that saved invoice (never of the screen's typed values).
    if (options.print) {
      const saved = state.invoices.find((i) => i.id === edit.id);
      try {
        if (saved) printInvoice(saved);
      } catch (e) {
        notify(t("edit.printFailed", { number }), "error");
      }
    }
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

  box.innerHTML = state.results.map((shelf) => {
    const p = stockShown(shelf);   // while an invoice is edited, what it already holds is available again
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
  const p = stockShown(findProduct(state.selectedId));
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

// "DA/m²", "DA/piece", "DA/box": what the unit price typed on a sale line is for: the unit the product is priced in,
// which is not always the unit it is sold in.
function linePriceUnit(item) {
  const unit = unitLabel(item.priceUnit || item.sellingUnit, 1).toLowerCase();
  return t("sell.priceUnit", { currency: state.settings.currency, unit });
}

// Shows the product's own price and unit from Stock under the price input: "Product price: 1,150 DA / m²".
// A price typed for this sale says so and shows the saved one. Old products without a price unit show nothing.
function priceNote(item) {
  const p = findProduct(item.productId);
  const priced = p ? Calc.getUnitPrice(p, item.sellingUnit) : null;
  if (!priced || priced.error) return "";
  // A line of the invoice being edited keeps its saved price: say so when today's catalogue price is different.
  if (item.fromInvoice && !item.priceOverridden) {
    const same = priced.priceUnit === item.priceUnit && round2(priced.basePrice) === round2(item.unitPrice);
    return same || priced.legacy ? "" : t("edit.savedPriceNote", { price: money(priced.basePrice), priceUnit: unitLabel(priced.priceUnit) });
  }
  if (item.priceOverridden) return t("sell.customPrice", { price: `${numberFormat.format(item.listPrice)} ${linePriceUnit(item)}` });
  if (priced.legacy) return "";
  return t("sell.priceNote", { price: money(priced.basePrice), priceUnit: unitLabel(priced.priceUnit) });
}

// Under the quantity: what the line is billed for when that is counted in another unit than the one sold, and how the
// two relate: "Billed: 9 m² · 1 Box = 1.22 m²". Nothing when the price is for the unit sold.
function qtyNote(item) {
  const unit = item.priceUnit || item.sellingUnit;
  if (!Calc.isUnit(unit) || unit === item.sellingUnit || item.priceQty == null) return "";
  const p = item.fromInvoice ? item.orig : findProduct(item.productId);   // a saved line converts with what it was sold with
  const factor = p ? Calc.getUnitFactor(p, item.sellingUnit, unit) : null;
  if (!factor || factor.error) return "";
  return t("sell.billedNote", {
    qty: numberFormat.format(item.priceQty),
    unit: unitLabel(unit, item.priceQty),
    sellUnit: unitLabel(item.sellingUnit, 1),
    factor: numberFormat.format(factor.value),
    factorUnit: unitLabel(unit, factor.value),
  });
}

// What an invoice line shows in its Price column, from the line's own saved details (never from the
// product's current data): the product's price and the unit it is priced per, plus the quantity sold
// expressed in that unit when it differs ("2 Boxes" -> "2.88 m²"). { price, unit, qtyInPriceUnit }
// A line whose price was typed by hand, or an old line without a price unit, shows the price that was
// really charged, per unit sold.
function invoiceLinePrice(item) {
  const charged = { price: item.unitPrice, unit: item.unitPriceUnit || item.sellingUnit || null, qtyInPriceUnit: null };
  // A line that saved the price it was charged per price unit shows exactly that: 1,400 per m², with the m² the boxes contain,
  // never a price per box worked out from them.
  if (item.chargedPrice != null && Number.isFinite(Number(item.chargedPrice)) && Calc.isUnit(item.priceUnit) && item.priceUnit !== item.sellingUnit) {
    // The quantity in the price unit follows the quantity sold, from the coverage saved on the line itself (never the product's
    // current one), so the two can't disagree. suppliedArea, saved with the sale, is only the fallback.
    const converted = Calc.convertQuantity(item.qty, item.sellingUnit, item.priceUnit, item);
    const saved = item.suppliedArea != null && Number.isFinite(Number(item.suppliedArea)) ? Number(item.suppliedArea) : null;
    return { price: Number(item.chargedPrice), unit: item.priceUnit, qtyInPriceUnit: converted.error ? saved : converted.value };
  }
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
    // Each cell carries its column title (data-label) so a narrow screen can show the row as a stack (see .sale-table).
    const label = (key) => ` data-label="${esc(t(key))}"`;
    body.innerHTML = state.sale.items.map((item) => {
      const p = findProduct(item.productId);
      // A line of the invoice being edited keeps the name it was saved with (as the invoice prints it).
      const name = item.orig ? invoiceItemLabel(item.orig) : p ? productLabel(p) : t("sell.deletedProduct");
      const whole = Calc.isWholeUnit(item.sellingUnit);
      const editing = Boolean(state.invoiceEdit);
      const locked = editing && state.invoiceEdit.tracked ? " disabled" : "";   // a delivered invoice keeps its products and quantities
      // "Deliver only part now": the customer takes some of the line now and collects the rest later (see deliverNowQty).
      const partialToggle = editing ? "" : `<label class="check partial-toggle"><input type="checkbox" data-field="partial"${item.partial ? " checked" : ""} aria-label="${esc(t("sell.partialAria", { name }))}"><span>${esc(t("sell.partialLabel"))}</span></label>`;
      const deliverCell = item.partial
        ? `<div class="deliver-cell"><label class="muted small">${esc(t("sell.deliverNow"))}</label><input class="qty-input" type="number" min="0" step="${whole ? 1 : "any"}" value="${item.deliverNow}" data-field="deliver" aria-label="${esc(t("sell.deliverAria", { name }))}"><span class="muted small">${esc(unitLabel(item.sellingUnit, item.deliverNow))}</span></div>` +
          `<div class="small collect-later" data-collect-later>${esc(collectLaterText(item))}</div>`
        : "";
      return `<tr data-id="${esc(item.lineId)}">` +
        `<td class="sale-product"${label("col.product")}><div class="sale-name">${esc(name)}</div><div class="muted small">${esc(t("sell.available", { n: p ? stockLabel(stockShown(p)) : 0 }))}</div>${partialToggle}<div class="error small" data-row-error></div></td>` +
        `<td class="num sale-qty"${label("col.qty")}><div class="qty-cell"><input class="qty-input" type="number" min="${whole ? 1 : 0}" step="${whole ? 1 : "any"}" value="${item.qty}" data-field="qty"${locked} aria-label="${esc(t("sell.qtyAria", { name }))}">` +
        `<select class="unit-select" data-field="unit"${locked} aria-label="${esc(t("sell.unitAria", { name }))}">${unitOptions(item.sellingUnit, p)}</select></div><div class="muted small qty-note" data-qty-note>${esc(qtyNote(item))}</div>${deliverCell}</td>` +
        `<td class="num sale-price"${label("col.unitPrice")}><div class="price-cell"><input class="price-input" type="number" min="0" step="any" value="${item.unitPrice}" data-field="price" aria-label="${esc(t("sell.priceAria", { name, unit: linePriceUnit(item) }))}">` +
        `<span class="price-unit" data-price-unit>${esc(linePriceUnit(item))}</span></div>` +
        `<div class="muted small price-note" data-price-note>${esc(priceNote(item))}</div></td>` +
        `<td class="num sale-total"${label("col.total")} data-line-total>${esc(money(Calc.calculateLineAmount(item)))}</td>` +
        `<td class="num sale-remove"><button type="button" class="btn small danger" data-action="remove"${locked} aria-label="${esc(t("sell.removeAria", { name }))}">${esc(t("common.remove"))}</button></td>` +
        `</tr>`;
    }).join("");
  }
  renderSaleDebts();
  renderTotals();
}

function renderTotals() {
  renderEditChrome();
  $("tEditRows").innerHTML = "";
  $("tRemainingLabel").textContent = t("sell.remaining");
  if (state.invoiceEdit) { renderEditTotals(); return; }
  $("editSave").classList.toggle("danger", false);
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
  if (!state.invoiceEdit) state.previewInvoice = null;
  $("saleBody").querySelectorAll("tr[data-id]").forEach((row) => {
    const item = findSaleItem(row.dataset.id);
    if (!item) return;
    row.querySelector("[data-line-total]").textContent = money(Calc.calculateLineAmount(item));
    row.querySelector("[data-price-note]").textContent = priceNote(item);
    row.querySelector("[data-qty-note]").textContent = qtyNote(item);
    row.querySelector("[data-price-unit]").textContent = linePriceUnit(item);
    const later = row.querySelector("[data-collect-later]");
    if (later) later.textContent = collectLaterText(item);
    const deliver = row.querySelector("input[data-field='deliver']");
    if (deliver && document.activeElement !== deliver) deliver.value = item.deliverNow;   // follows the quantity and the stock
  });
  renderTotals();
  renderInvoice();
}

// The invoice as separate pieces of markup. The preview on screen puts them together (invoiceHtml); the printed pages
// are laid out from the same pieces (buildPrintPages), so what is printed is what the preview shows.
function invoiceParts(inv) {
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
      })
    : [`<tr><td colspan="4" class="none">${esc(t("inv.noItems"))}</td></tr>`];   // one row per product: a row is never split between two printed pages

  const pay = paymentInfo(inv);
  const cancelled = Validation.isCancelled(inv);
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
    : `<tr class="grand"><td>${esc(t(cancelled ? "inv.cancelledTotal" : "inv.grandTotal"))}</td><td>${esc(money(toNumber(inv.total), cur))}</td></tr>`;
  // On an older invoice whose balance moved to a newer one, the original total is untouched and the move is shown as its own line.
  const movedRow = pay.transferredOut > 0
    ? `<tr class="moved"><td>${esc(t("inv.transferredOut", { numbers: carriedToNumbers(inv) }))}</td><td>${esc(money(pay.transferredOut, cur))}</td></tr>`
    : "";
  // Paid more than the invoice now asks for (after a return): the amount owed back to the customer, on its own line.
  const refundRow = pay.refundDue > 0
    ? `<tr class="due refund"><td>${esc(t("inv.refundDue"))}</td><td>${esc(money(pay.refundDue, cur))}</td></tr>`
    : "";
  const paidRows = hasItems
    ? `<tr><td>${esc(t("inv.totalPaid"))}</td><td>${esc(money(pay.paid, cur))}</td></tr>${pay.refunded > 0 ? `<tr class="refunded"><td>${esc(t("inv.refunded"))}</td><td>${esc(money(pay.refunded, cur))}</td></tr>` : ""}${movedRow}<tr class="due"><td>${esc(t("inv.remaining"))}</td><td>${esc(money(pay.remaining, cur))}</td></tr>${refundRow}`
    : "";
  // The payment status belongs to the totals: together they are the financial summary, one block that is never split
  // between two printed pages (the status must never be left alone at the top of the next one).
  const statusHtml = hasItems
    ? `<div class="inv-status"><span class="${pay.cls}">${esc(t("inv.status"))} ${esc(pay.status)}</span></div>`
    : "";
  const summary = `<div class="inv-summary">
      <table class="inv-totals">
        <tr><td>${esc(t("inv.subtotal"))}</td><td>${esc(money(toNumber(inv.subtotal), cur))}</td></tr>
        <tr><td>${esc(t("inv.discount"))}${pct(inv.discountPercent)}</td><td>${esc(money(toNumber(inv.discount), cur))}</td></tr>
        <tr><td>${esc(t("inv.tax"))}${pct(inv.taxPercent)}</td><td>${esc(money(toNumber(inv.tax), cur))}</td></tr>
        ${totalRows}
        ${paidRows}
      </table>
      ${statusHtml}
    </div>`;
  // Payment history and delivery history are sections that may run over several pages, one entry per line.
  const payments = hasItems
    ? {
        cls: "inv-payments", lead: "", title: t("inv.history"),
        entries: pay.payments.length
          ? pay.payments.map((p) => `<div class="inv-pay"><span class="when">${esc(formatDateTime(p.timestamp))}</span><span>${esc(t("inv.paidLine", { amount: money(p.amount, cur) }))}</span></div>`)
          : [`<div class="inv-pay"><span class="when">${esc(t("inv.noPayments"))}</span></div>`],
      }
    : null;
  // Money handed back is shown apart from the payments, which are never changed: each refund with its date and why.
  const refundList = Validation.refundsOf(inv);
  const refunds = refundList.length
    ? {
        cls: "inv-payments inv-refunds", lead: "", title: t("inv.refundHistory"),
        entries: refundList.map((r) => `<div class="inv-pay"><span class="when">${esc(formatDateTime(r.timestamp))}</span><span>${esc(t("inv.refundLine", { amount: money(r.amount, cur) }))} (${esc(t("inv.refundReason." + r.reason))})</span></div>`),
      }
    : null;
  // A cancelled sale says so at the top: when it was cancelled and what was refunded; the products below are what was sold.
  const cancelBanner = cancelled
    ? `<div class="inv-cancelled"><strong>${esc(t("inv.cancelledBanner"))}</strong> ${esc(t("inv.cancelledOn", { date: formatDateTime(inv.cancellation.at), refund: money(toNumber(inv.cancellation.refund), cur) }))}</div>`
    : "";
  // Delivery is shown apart from payment: a paid invoice can still have goods waiting.
  const deliveries = hasItems && delivery.tracked
    ? {
        cls: "inv-payments inv-deliveries", title: t("inv.deliveryHistory"),
        lead: `<div class="inv-status inv-delivery-status"><span class="dlv-${delivery.status}">${esc(t("inv.deliveryStatus"))} ${esc(t("inv.delivery." + delivery.status))}</span></div>`,
        entries: inv.deliveries.length
          ? inv.deliveries.map((d, n) => {
              const what = d.type === "sale" ? t("inv.deliverySale") : t("inv.deliveryCollection", { number: Validation.receiptNumber(inv, inv.deliveries.slice(0, n + 1).filter((x) => x.type === "collection").length) });
              const things = d.lines.map((l) => {
                const item = inv.items.find((i) => i.lineId === l.lineId);
                return t("inv.deliveryLine", { quantity: qtyText(l.qty, item && item.sellingUnit), name: item ? invoiceItemLabel(item) : "" });
              }).join(", ");
              return `<div class="inv-pay"><span class="when">${esc(formatDateTime(d.date))}</span><span>${esc(what)}: ${esc(things)}${d.note ? ` (${esc(d.note)})` : ""}</span></div>`;
            })
          : [`<div class="inv-pay"><span class="when">${esc(t("inv.noDeliveries"))}</span></div>`],
      }
    : null;

  return {
    head: `<header class="inv-head">
      <div>${logo}<div class="inv-biz-name">${esc(biz.name)}</div>${line(biz.address)}${businessPhonesHtml(biz)}${line(biz.email)}</div>
      <div class="inv-title">${esc(t("inv.title"))}</div>
    </header>`,
    meta: `<div class="inv-meta">
      ${customerBlockHtml(inv, cust)}
      <div class="right"><div><span class="label">${esc(t("inv.number"))}</span> ${esc(inv.invoiceNumber)}</div><div><span class="label">${esc(t("inv.date"))}</span> ${esc(formatDateTime(inv.date))}</div></div>
    </div>`,
    thead: `<thead><tr><th>${esc(t("inv.product"))}</th><th class="num">${esc(t("inv.qty"))}</th><th class="num">${esc(t("inv.price", { currency: cur }))}</th><th class="num">${esc(t("inv.lineTotal", { currency: cur }))}</th></tr></thead>`,
    cancelBanner,
    rows,
    carried: carriedBlock,
    summary,
    payments,
    refunds,
    deliveries,
    thanks: `<p class="inv-thanks">${esc(t("inv.thanks"))}</p>`,
  };
}

// The product table holding the given rows; the heading row is part of every piece, so a table that continues on the next page repeats it.
function invoiceTableHtml(parts, rows) {
  return `<table class="inv-table">
      ${parts.thead}
      <tbody>${rows.join("")}</tbody>
    </table>`;
}

// A flowing section (payment history, delivery history) holding the given entries. A piece that continues on a
// later page says so in its title.
function invoiceSectionHtml(section, entries, continued) {
  const title = continued ? t("inv.continuedHeading", { title: section.title }) : section.title;
  return `<section class="${section.cls}"><h3>${esc(title)}</h3>${entries.join("")}</section>`;
}

function invoiceHtml(inv) {
  const p = invoiceParts(inv);
  return `${p.head}
    ${p.meta}
    ${p.cancelBanner}
    ${invoiceTableHtml(p, p.rows)}
    ${p.carried}
    ${p.summary}
    ${p.payments ? invoiceSectionHtml(p.payments, p.payments.entries, false) : ""}
    ${p.refunds ? invoiceSectionHtml(p.refunds, p.refunds.entries, false) : ""}
    ${p.deliveries ? p.deliveries.lead + invoiceSectionHtml(p.deliveries, p.deliveries.entries, false) : ""}
    ${p.thanks}`;
}

/* ---------- Printing the invoice over several pages (the layout rules are in invoice-print.js) ---------- */

// The small header at the top of every printed page after the first: whose invoice this is.
function continuationHeadHtml(inv) {
  const biz = inv.business || Validation.businessSnapshot(state.settings);
  const cust = inv.customer || { name: WALK_IN, phone: "", address: "" };
  const second = secondCustomerName(inv);
  const customer = customerLabel(cust.name) + (second ? " / " + second : "");
  return `<div class="inv-cont-head">
      <div class="inv-cont-left"><div class="inv-cont-biz">${esc(biz.name)}</div><div class="inv-cont-sub"><span class="label">${esc(t("inv.customer"))}</span> ${esc(customer)}</div></div>
      <div class="inv-cont-right"><div class="inv-cont-title">${esc(t("inv.continued"))}</div><div class="inv-cont-sub"><span class="label">${esc(t("inv.number"))}</span> ${esc(inv.invoiceNumber)} &nbsp; <span class="label">${esc(t("inv.date"))}</span> ${esc(formatDate(inv.date))}</div></div>
    </div>`;
}

// The invoice as the list of items invoice-print.js lays out: what stays whole, and what may continue on the next page.
function printItems(inv) {
  const p = invoiceParts(inv);
  const items = [
    { kind: "block", html: p.head + p.meta + p.cancelBanner },
    { kind: "flow", lead: "", entries: p.rows, build: (rows) => invoiceTableHtml(p, rows) },
  ];
  if (p.carried) items.push({ kind: "block", html: p.carried });
  items.push({ kind: "block", html: p.summary });
  for (const section of [p.payments, p.refunds, p.deliveries]) {
    if (section) items.push({ kind: "flow", lead: section.lead, entries: section.entries, build: (entries, continued) => invoiceSectionHtml(section, entries, continued) });
  }
  items.push({ kind: "block", html: p.thanks });
  return items;
}

// What is shown in the preview now: the corrected invoice while one is being edited, else the saved or the draft invoice.
function previewedInvoice() {
  return state.invoiceEdit ? editPreviewInvoice() : state.previewInvoice || draftInvoice();
}

function clearPrintPages() {
  $("invoicePages").textContent = "";
  delete document.documentElement.dataset.invoicePages;
}

// Runs just before the browser prints (the Print button, Ctrl+P, the browser menu). Anything that goes wrong leaves the
// browser's own pagination of the preview, which is how invoices were printed before.
function buildPrintPages() {
  if (document.body.dataset.printing || typeof InvoicePrint === "undefined") return;   // a purchase or collection document is printed instead
  try {
    const inv = previewedInvoice();
    if (!inv) { clearPrintPages(); return; }
    const host = $("invoicePages");
    InvoicePrint.paginate(host, printItems(inv), {
      continuation: continuationHeadHtml(inv),
      footer: (page, total) => `<div class="inv-page-foot"><span>${esc(inv.invoiceNumber)}</span><span>${esc(t("inv.pageOf", { page, total }))}</span></div>`,
    });
    document.documentElement.dataset.invoicePages = "1";
    // A logo that is still loading has no height yet, so the pages were measured too short: lay them out again once it is there.
    host.querySelectorAll("img").forEach((img) => { if (!img.complete) img.addEventListener("load", buildPrintPages, { once: true }); });
  } catch (e) {
    clearPrintPages();
  }
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
  const inv = state.invoiceEdit ? null : state.previewInvoice;
  $("payBox").hidden = !inv;
  if (!inv) return;
  const cur = inv.currency || state.settings.currency;
  const info = paymentInfo(inv);
  const full = info.remaining <= 0;
  $("payNumber").textContent = inv.invoiceNumber;
  $("payTotal").textContent = money(info.due, cur);
  $("payPaid").textContent = money(info.paid, cur);
  $("payRemaining").textContent = money(info.remaining, cur);
  $("payRefundRow").hidden = !(info.refundDue > 0);
  $("payRefund").textContent = info.refundDue > 0 ? money(info.refundDue, cur) : "";
  // Money already handed back, and a cancelled sale; a refund still due can be recorded here once it is handed over.
  $("payRefundedRow").hidden = !(info.refunded > 0);
  $("payRefunded").textContent = info.refunded > 0 ? money(info.refunded, cur) : "";
  const cancelled = info.cls === "cancelled";
  $("payCancelRow").hidden = !cancelled;
  $("payCancelRow").textContent = cancelled ? t("inv.cancelledBanner") + " " + t("inv.cancelledOn", { date: formatDateTime(inv.cancellation.at), refund: money(toNumber(inv.cancellation.refund), cur) }) : "";
  $("refundForm").hidden = !(info.refundDue > 0);
  $("refundAmount").placeholder = info.refundDue > 0 ? t("pay.max", { n: numberFormat.format(info.refundDue) }) : "";
  // How the payments on this invoice are shared with the debt it carries (oldest debt first), and where its own balance went.
  const breakdown = Validation.carriedBreakdown(inv);
  $("payCarriedRow").hidden = !(info.carried > 0);
  $("payCarried").textContent = info.carried > 0 ? `${money(info.carried, cur)} (${t("pay.carriedSettled", { paid: money(breakdown.carriedPaid, cur), total: money(info.carried, cur) })})` : "";
  $("payTransferredRow").hidden = !(info.transferredOut > 0);
  $("payTransferred").textContent = info.transferredOut > 0 ? `${money(info.transferredOut, cur)} (${carriedToNumbers(inv)})` : "";
  $("payAmount").disabled = full;
  $("payBtn").disabled = full;
  $("payAmount").placeholder = full
    ? t(info.cls === "transferred" ? "pay.carriedTo" : cancelled ? "pay.cancelled" : "pay.fullyPaid", { numbers: carriedToNumbers(inv) })
    : t("pay.max", { n: numberFormat.format(info.remaining) });
}

// Box above a saved invoice that was sold in several deliveries: payment and delivery status side by side (never mixed),
// what is left to collect per line, and where the warehouse records a collection.
function renderDeliveryBox() {
  const inv = state.invoiceEdit ? null : state.previewInvoice;
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
  const editing = Boolean(state.invoiceEdit);
  const saved = state.previewInvoice;
  const shown = previewedInvoice();
  $("invoice").innerHTML = invoiceHtml(shown);
  clearPrintPages();   // the printed pages are laid out again just before printing (buildPrintPages), so none can be out of date
  $("previewStatus").textContent = t(editing ? "edit.previewStatus" : saved ? "preview.saved" : "preview.live");
  $("previewStatus").classList.toggle("preview-unsaved", editing);   // an unsaved preview never looks like the saved invoice
  $("invoice").classList.toggle("invoice-unsaved", editing);
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

const PAYMENT_RANK = { unpaid: 0, partial: 1, paid: 2, transferred: 3, cancelled: 4 };

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
    const label = t({ paid: "badge.paid", partial: "badge.partial", unpaid: "badge.unpaid", transferred: "badge.transferred", cancelled: "badge.cancelled" }[pay.cls]);
    const cancelled = pay.cls === "cancelled";
    // Total is what the invoice asks for (this purchase + debt carried onto it). The notes say where the figure comes from.
    const notes = [];
    if (cancelled) notes.push(`${t("inv.cancelledTotal")}: ${money(toNumber(inv.total), inv.currency)}`);
    if (pay.carried > 0) notes.push(t("invoices.inclCarried", { amount: money(pay.carried, inv.currency) }));
    if (pay.transferredOut > 0) notes.push(t("invoices.carriedTo", { amount: money(pay.transferredOut, inv.currency), numbers: carriedToNumbers(inv) }));
    if (pay.refundDue > 0) notes.push(t("invoices.refundDue", { amount: money(pay.refundDue, inv.currency) }));
    if (pay.refunded > 0) notes.push(t(cancelled ? "invoices.refundedCancelled" : "invoices.refunded", { amount: money(pay.refunded, inv.currency), date: cancelled ? formatDate(inv.cancellation.at) : "" }));
    // Delivery is its own status, shown under the payment status.
    const delivery = Validation.deliveryDetail(inv);
    const deliveryBadge = delivery.tracked
      ? `<div class="status-line"><span class="badge ${{ complete: "dl-received", partial: "dl-partial", pending: "dl-pending" }[delivery.status]}">${esc(t("badge.delivery." + delivery.status))}</span></div>`
      : "";
    return `<tr data-id="${esc(inv.id)}"${cancelled ? ' class="invoice-cancelled"' : ""}>` +
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
      `<button type="button" class="btn small" data-action="edit"${cancelled ? ` disabled title="${esc(t("edit.cancelledLocked", { number: inv.invoiceNumber }))}"` : ""}>${esc(t("invoices.edit"))}</button>` +
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
  document.documentElement.dir = I18n.dir();   // "rtl" for Arabic, "ltr" for English and French (css/rtl.css only applies to rtl)
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
    endEdit();
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
  if (!state.debtUi.armed || state.invoiceEdit) return null;
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
  if (state.invoiceEdit) { ui.suggestions = []; ui.suggestIndex = -1; renderSuggestions(); return; }   // an edited invoice has its customer already
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
  if (state.invoiceEdit) return;
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

/* ---------- When something outside Invoisy reloads the page ----------
   The page can be reloaded by a tool that is not part of Invoisy: typically a development server with live reload
   (such as the VS Code "Live Server" extension) that reloads every open page when ANY file in its folder changes,
   and the automatic backup writes invoisy-data.json after each save. If that file is inside the watched folder,
   each save is followed, a moment later, by a reload (and the page used to come back as if nothing had happened).
   Invoisy cannot stop such a tool, so it makes sure a reload never costs the person anything:
     - the "Sale completed" dialog is remembered for this tab (the invoice itself is already committed) and is
       opened again after the reload, so Print Invoice can still be pressed;
     - closing or reloading the page with typed work that is not saved yet asks first (see hasUnsavedWork);
     - a reload right after a save is explained once, with what to change.
   Screen position only, in sessionStorage: no business data is kept there. */
const SALE_DONE_KEY = "invoisy-sale-done";
const LAST_COMMIT_KEY = "invoisy-last-commit";
const RELOAD_AFTER_SAVE_MS = 8000;

function sessionGet(key) {
  try { return sessionStorage.getItem(key); } catch { return null; }
}
function sessionSet(key, value) {
  try {
    if (value === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, value);
  } catch { /* storage blocked: nothing is remembered, everything else works as before */ }
}

// The sale whose dialog is open ({ id, number }), or null once it was answered.
function rememberSaleDone(done) {
  sessionSet(SALE_DONE_KEY, done ? JSON.stringify({ id: done.id, number: done.number }) : null);
}
function rememberedSaleDone() {
  try {
    const done = JSON.parse(sessionGet(SALE_DONE_KEY) || "null");
    return done && done.id !== undefined && done.id !== null ? { id: done.id, number: done.number } : null;
  } catch { return null; }
}

// After a (re)load: if the page went away while the "Sale completed" dialog was waiting for an answer, ask again.
// Only a saved invoice is offered; one that no longer exists is forgotten quietly.
function restoreSaleDone() {
  const pending = rememberedSaleDone();
  if (!pending || state.saleDone) return false;
  const invoice = state.invoices.find((i) => i.id === pending.id);
  if (!invoice) { rememberSaleDone(null); return false; }
  state.previewInvoice = invoice;
  renderInvoice();
  openSaleDoneDialog(invoice);
  return true;
}

function markCommit() {
  sessionSet(LAST_COMMIT_KEY, String(Date.now()));
}

// True when this page load is a reload that came right after Invoisy saved something. Said once, then forgotten.
function reloadedRightAfterSave() {
  const last = Number(sessionGet(LAST_COMMIT_KEY));
  sessionSet(LAST_COMMIT_KEY, null);
  if (!last || !(Date.now() - last >= 0) || Date.now() - last > RELOAD_AFTER_SAVE_MS) return false;
  try {
    const entry = performance.getEntriesByType("navigation")[0];
    return Boolean(entry) && entry.type === "reload";
  } catch { return false; }
}

// Typed work that exists only on the screen: an invoice being corrected, a sale in preparation, a product being typed.
let productFormTouched = false;
function hasUnsavedWork() {
  const sale = state.sale;
  const customer = (sale && sale.customer) || {};
  const saleStarted = Boolean(sale) && (sale.items.length > 0 || Boolean(customer.name || customer.phone || customer.address));
  return editDirty() || saleStarted || productFormTouched;
}

function showView(name, options) {
  // Leaving an invoice that is being edited with typed changes asks first; leaving with none just closes the edit.
  if (state.invoiceEdit && name !== "sell") {
    if (editDirty() && !confirm(t("edit.leaveConfirm"))) return false;
    endEdit();
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
  rememberView(name);

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
    if (state.invoiceEdit && state.invoiceEdit.tracked) { showError("addError", t("edit.trackedLines")); return; }
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
      if (result.priceReset) notify(t("sell.priceReset", { unit: unitLabel(line.priceUnit || line.sellingUnit, 1).toLowerCase() }));
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
  // Anything typed or chosen in the Stock form counts as unsaved until the product is saved or the form is cleared.
  productForm.addEventListener("input", () => { productFormTouched = true; });
  productForm.addEventListener("change", () => { productFormTouched = true; });

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

  // Edit a saved invoice: it is edited on the Sell page itself (everything above works on it); these are its buttons.
  $("editInvoiceBtn").addEventListener("click", () => { if (state.previewInvoice) startEditInvoice(state.previewInvoice.id); });
  $("editSave").addEventListener("click", () => saveInvoiceEdit());
  $("editSavePrint").addEventListener("click", () => saveInvoiceEdit({ print: true }));
  $("editCancel").addEventListener("click", cancelInvoiceEdit);
  // Closing or reloading the page with typed work that is not saved yet asks first (see hasUnsavedWork).
  window.addEventListener("beforeunload", (e) => {
    if (!hasUnsavedWork()) return;
    e.preventDefault();
    e.returnValue = "";
  });

  // Record a refund handed back for the invoice shown in the preview (the payments are untouched)
  $("refundForm").addEventListener("submit", (e) => {
    e.preventDefault();
    guard(async () => {
      const inv = state.previewInvoice;
      if (!inv) return;
      const amount = $("refundAmount").value.trim();
      if (amount !== "" && Number.isFinite(Number(amount)) && Number(amount) > 0 && !confirm(t("refund.confirm", { amount: money(round2(Number(amount)), inv.currency), number: inv.invoiceNumber }))) return;
      const result = await recordRefund(inv.id, amount);
      if (result.error) { showError("refundError", result.error); return; }
      showError("refundError", "");
      $("refundAmount").value = "";
      renderInvoices();
      renderInvoice();
      notify(t("refund.recorded"));
    });
  });
  $("refundAmount").addEventListener("input", () => showError("refundError", ""));

  // Preview
  $("printBtn").addEventListener("click", () => printInvoice());
  // The printed pages are laid out whenever the browser is about to print: the Print button, Ctrl+P or the browser menu.
  window.addEventListener("beforeprint", buildPrintPages);
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
  state, db, commit, guard, $, t, tn, esc, money, numberFormat, notify, formatDateTime, productLabel, priceLabel, stockText, formatTileSize, ltr,
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
    qtyNote,
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
    productSuggestions, renderProductSuggestions, useSuggestion, searchInvoices, setInvoiceSort, clearInvoiceFilters, invoiceView, planInvoiceEdit, applyInvoiceEdit, lineStockTaken, startEditInvoice, editDirty, editPlan, editPreviewInvoice, saleFromInvoice, endEdit,
    saveInvoiceEdit, cancelInvoiceEdit, recordRefund, stockAvail, renderTotals, removeFromSale, getInvoiceEdit: () => state.invoiceEdit,
    addPhoneRow, removePhoneRow, setPhoneRow, saveBusinessSettings, fillSettingsForm, businessPhonesHtml,
    saleDoneAction, openSaleDoneDialog, getSaleDone: () => state.saleDone, printInvoice,
    restoreSaleDone, rememberedSaleDone, reloadedRightAfterSave, markCommit, hasUnsavedWork,
    touchProductForm: () => { productFormTouched = true; },
    invoiceParts, invoiceHtml, printItems, continuationHeadHtml,
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

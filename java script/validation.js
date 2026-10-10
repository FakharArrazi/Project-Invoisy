"use strict";

/* ==========================================================================
   Validation - the shape of Invoisy's saved data and the rules it must follow.

   Plain script (no modules, so index.html still works when opened directly).
   No DOM and no storage access: it only inspects and converts data, so the
   database layer, backups and tests can all share exactly the same rules.
   Loaded after i18n.js, the language files and calc.js (it uses their units
   and speaks the current language) and before database.js and script.js.

   Three situations use it:
     - writes     : database.js checks every record before it is saved.
     - backups    : parseBackup() checks a whole backup file before a restore.
     - migration  : readLegacyStorage() reads data an older version left in
                    localStorage. It never silently changes a money or stock
                    value: an entry that cannot be used exactly as stored is
                    set aside ("rejected") and reported, not repaired.
   ========================================================================== */

(function () {
  const t = (key, params) => I18n.t(key, params);
  const tn = (key, count, params) => I18n.tn(key, count, params);

  const APP_NAME = "Invoisy";
  const CURRENCY = "DA";                 // default currency (can be changed in Settings)
  const DATA_VERSION = 1;                // version of the old invoisy-data.json file format
  const BACKUP_FORMAT_VERSION = 1;       // version of the backup file made by Export Backup
  const MIRROR_KEY = "invoisy-data";     // browser copy written by the previous (data file) version
  const LEGACY_KEYS = ["products", "invoices", "settings", "invoiceCounter"];
  const DERIVED_INVOICE_FIELDS = ["amountPaid", "remaining", "status"];   // calculated from the payments, never trusted
  const INVOICE_STATUSES = ["paid", "partial", "unpaid"];
  const MONEY_TOLERANCE = 0.01;
  const DEFAULT_BACKUP_DAYS = 7;

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

  // Units a line on a sale can be sold in. The unit belongs to the sale line, not to the product.
  const SELLING_UNITS = Calc.UNITS;

  /* ---------- Small helpers ---------- */

  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const isStr = (v) => typeof v === "string";
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const isDate = (v) => isStr(v) && !isNaN(new Date(v));
  const present = (v) => v !== undefined && v !== null && v !== "";

  // Money rounding and number cleaning live in calc.js, the one place for unit and price maths.
  const round2 = Calc.roundMoney;
  const toNumber = Calc.toNumber;

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function formatInvoiceNumber(n) {
    return "INV-" + String(n).padStart(6, "0");
  }

  function invoiceSequence(invoiceNumber) {
    return parseInt(String(invoiceNumber).replace(/\D/g, ""), 10) || 0;
  }

  function highestInvoiceNumber(invoices) {
    return invoices.reduce((max, inv) => Math.max(max, invoiceSequence(inv.invoiceNumber)), 0);
  }

  // Deep comparison of plain data. A missing field and an undefined field count as the same.
  function sameValue(a, b) {
    if (a === b) return true;
    if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
      return typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b);
    }
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (a[key] === undefined && b[key] === undefined) continue;
      if (!sameValue(a[key], b[key])) return false;
    }
    return true;
  }

  /* ---------- Normalizing (filling in fields an older version did not have) ---------- */

  // Tile sizes (60*120, 60x120, 60 × 120 cm ...) are parsed in calc.js.
  const isTileSize = Calc.isTileSize;
  const normalizeTileSize = Calc.normalizeTileSize;

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
    // Fields this version does not know about are kept as they are ("dimensions" was renamed to tileSize).
    const { dimensions, ...extra } = raw;
    return {
      ...extra,
      id: String(raw.id || uid()),
      name: String(raw.name),
      manufacturer: String(raw.manufacturer || ""),
      // tileSize is the physical size of one tile. It is deliberately separate from box coverage.
      tileSize: String(raw.tileSize != null ? raw.tileSize : dimensions || ""),
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
      // The amount is kept exactly as stored. Extra fields on a payment are kept too.
      payments = inv.payments
        .filter((p) => p && Number.isFinite(Number(p.amount)) && Number(p.amount) > 0)
        .map((p) => ({ ...p, amount: Number(p.amount), timestamp: p.timestamp || inv.date }));
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
      // Settings this version does not know about are kept when they are plain values.
      for (const [key, value] of Object.entries(stored)) {
        if (key in DEFAULT_SETTINGS) continue;
        if (value === null || ["string", "number", "boolean"].includes(typeof value)) settings[key] = value;
      }
    }
    if (!settings.currency.trim()) settings.currency = CURRENCY;
    if (!settings.logo.startsWith("data:image/")) settings.logo = "";
    if (!["A4", "A5"].includes(settings.paper)) settings.paper = "A4";
    // An unknown language (for example from a newer backup) falls back to the default instead of blocking the file.
    if (!I18n.has(settings.language)) settings.language = DEFAULT_SETTINGS.language;
    return settings;
  }

  // Total paid, remaining balance and status are always calculated from the payments list.
  // (script.js adds the wording of the status in the current language.)
  function paymentSummary(inv) {
    const payments = Array.isArray(inv.payments) ? inv.payments : [];
    const paid = round2(payments.reduce((sum, p) => sum + toNumber(p.amount), 0));
    const remaining = Math.max(0, round2(toNumber(inv.total) - paid));
    const cls = remaining <= 0 ? "paid" : paid > 0 ? "partial" : "unpaid";
    return { payments, paid, remaining, cls };
  }

  function stripDerived(inv) {
    const clean = { ...inv };
    for (const key of DERIVED_INVOICE_FIELDS) delete clean[key];
    return clean;
  }

  /* ---------- Validation of single records ---------- */

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

  // Not rejected (older data may not follow today's arithmetic exactly), but always shown to the person
  // before a restore. The stored values are never changed to make them add up.
  function invoiceWarnings(inv) {
    if (!isObj(inv) || !isStr(inv.invoiceNumber)) return [];
    const warnings = [];
    const number = inv.invoiceNumber;
    const payments = Array.isArray(inv.payments) ? inv.payments : [];
    const paid = round2(payments.reduce((sum, p) => sum + toNumber(p && p.amount), 0));
    if (isNum(inv.total) && paid > round2(inv.total) + MONEY_TOLERANCE) {
      warnings.push(t("warn.paidMoreThanTotal", { number }));
    }
    if (isNum(inv.subtotal) && isNum(inv.discount) && isNum(inv.tax) && isNum(inv.total)) {
      if (Math.abs(Math.max(0, round2(inv.subtotal - inv.discount + inv.tax)) - inv.total) > MONEY_TOLERANCE) {
        warnings.push(t("warn.totalMismatch", { number }));
      }
    }
    if (Array.isArray(inv.items) && isNum(inv.subtotal)) {
      const itemsTotal = round2(inv.items.reduce((sum, i) => sum + toNumber(i && i.qty) * toNumber(i && i.unitPrice), 0));
      if (Math.abs(itemsTotal - inv.subtotal) > MONEY_TOLERANCE) {
        warnings.push(t("warn.subtotalMismatch", { number }));
      }
    }
    if (present(inv.amountPaid) && Math.abs(toNumber(inv.amountPaid) - paid) > MONEY_TOLERANCE) {
      warnings.push(t("warn.amountPaidDiffers", { number }));
    }
    if (present(inv.status) && !INVOICE_STATUSES.includes(inv.status)) {
      warnings.push(t("warn.statusUnknown", { number, status: String(inv.status).slice(0, 20) }));
    }
    return warnings;
  }

  function settingsProblem(s) {
    if (!isObj(s)) return t("problem.settingsInvalid");
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (s[key] !== undefined && !isStr(s[key])) return t("problem.setting", { key });
    }
    if (s.currency !== undefined && !s.currency.trim()) return t("problem.currency");
    if (s.paper !== undefined && !["A4", "A5"].includes(s.paper)) return t("problem.paper");
    if (s.logo && !s.logo.startsWith("data:image/")) return t("problem.logo");
    return "";
  }

  /* ---------- Old data: entries that cannot be used exactly as stored ---------- */

  // normalizeProduct() fills in fields that are missing, which is fine. It also replaces a value that is
  // present but unusable (a price of "abc" becomes 0, a stock of 12.5 becomes 12). For old data that would
  // change real money and stock figures without saying so, so such entries are set aside instead.
  function legacyProductIssue(raw) {
    if (!isObj(raw)) return t("problem.notObject");
    if (!raw.name) return t("problem.noName");
    const finiteAtLeast = (v, min) => Number.isFinite(Number(v)) && Number(v) >= min && typeof v !== "boolean";
    if (present(raw.sellingPrice) && !finiteAtLeast(raw.sellingPrice, 0)) return t("problem.badPrice");
    if (present(raw.purchasePrice) && !finiteAtLeast(raw.purchasePrice, 0)) return t("problem.badCost");
    if (present(raw.priceUnit) && !Calc.isUnit(raw.priceUnit)) return t("problem.badPriceUnit");
    if (present(raw.stockUnit) && !Calc.isUnit(raw.stockUnit)) return t("problem.badStockUnit");
    if (present(raw.stock)) {
      // Fractional stock is only meaningful when the unit is known (same rule as normalizeProduct).
      const unit = Calc.inferStockUnit({ stockUnit: raw.stockUnit, priceUnit: Calc.normalizeUnit(raw.priceUnit) });
      if (!finiteAtLeast(raw.stock, 0) || (!unit && !Number.isInteger(Number(raw.stock)))) return t("problem.badStock");
    }
    if (present(raw.coveragePerBox) && !(finiteAtLeast(raw.coveragePerBox, 0) && Number(raw.coveragePerBox) > 0)) return t("problem.badCoverage");
    return "";
  }

  // Same idea for invoices: normalizeInvoice() would drop an unreadable payment or replace an unreadable total.
  function legacyInvoiceIssue(raw) {
    if (!isObj(raw)) return t("problem.notObject");
    if (!raw.invoiceNumber) return t("problem.badNumber");
    if (!Array.isArray(raw.items)) return t("problem.noItems");
    for (const key of Object.keys(AMOUNT_PROBLEMS)) {
      if (present(raw[key]) && !(Number.isFinite(Number(raw[key])) && Number(raw[key]) >= 0 && typeof raw[key] !== "boolean")) return t(AMOUNT_PROBLEMS[key]);
    }
    if (Array.isArray(raw.payments)) {
      const bad = raw.payments.some((p) => !isObj(p) || !(Number.isFinite(Number(p.amount)) && Number(p.amount) > 0) || (present(p.timestamp) && !isDate(p.timestamp)));
      if (bad) return t("problem.badPayment");
    } else if (raw.payments !== undefined && raw.payments !== null) {
      return t("problem.badPaymentList");
    }
    return "";
  }

  /* ---------- Whole datasets ---------- */

  function firstDuplicate(values) {
    const seen = new Set();
    for (const v of values) {
      if (seen.has(v)) return v;
      seen.add(v);
    }
    return null;
  }

  // Keeps the first entry for each key. Later entries with the same key are returned as `dropped`.
  function dedupe(list, keyOf) {
    const seen = new Set();
    const kept = [];
    const dropped = [];
    list.forEach((item, index) => {
      const key = keyOf(item);
      if (seen.has(key)) dropped.push({ item, index });
      else { seen.add(key); kept.push(item); }
    });
    return { kept, dropped };
  }

  // Turns raw data (backup file or old browser storage) into application data.
  //   strict  (lenient = false): every problem is reported and nothing is repaired. Used for backups.
  //   lenient (lenient = true) : used for data an older version left in the browser. Missing fields get
  //     defaults; an entry that has an unusable value is set aside in `rejected` instead of being altered.
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
    const rejected = [];
    const warnings = [];

    // Names the record (its invoice number or product name) so the person can find it in the file.
    const nameOf = (item) => {
      const name = isObj(item) ? item.invoiceNumber || item.name : "";
      return isStr(name) && name ? ` (${name.length > 40 ? name.slice(0, 40) + "..." : name})` : "";
    };

    function collect(list, kind, label, issueOf, problemOf, normalize) {
      const out = [];
      list.forEach((item, i) => {
        const reject = (why) => {
          problems.push(t("problem.entry", { label, n: `${i + 1}${nameOf(item)}`, why }));
          rejected.push({ kind, index: i, reason: why, raw: item });
        };
        if (lenient) {
          const issue = issueOf(item);
          if (issue) return reject(issue);
        }
        const candidate = lenient ? normalize(item) : item;
        const why = candidate ? problemOf(candidate) : t("problem.notValid");
        if (why) return reject(why);
        if (kind === "invoice") warnings.push(...invoiceWarnings(item));
        out.push(lenient ? candidate : normalize(item));
      });
      return out;
    }

    let products = collect(raw.products, "product", t("problem.label.product"), legacyProductIssue, productProblem, normalizeProduct);
    let invoices = collect(raw.invoices, "invoice", t("problem.label.invoice"), legacyInvoiceIssue, invoiceProblem, normalizeInvoice);

    if (lenient) {
      // Old data may repeat an id. The first entry is kept and the repeat is set aside, never merged.
      const p = dedupe(products, (x) => x.id);
      products = p.kept;
      for (const d of p.dropped) { problems.push(t("legacy.dupProduct", { id: d.item.id })); rejected.push({ kind: "product", index: d.index, reason: t("legacy.reasonProductId"), raw: d.item }); }
      const byId = dedupe(invoices, (x) => x.id);
      const byNumber = dedupe(byId.kept, (x) => x.invoiceNumber);
      invoices = byNumber.kept;
      for (const d of [...byId.dropped, ...byNumber.dropped]) { problems.push(t("legacy.dupInvoice", { number: d.item.invoiceNumber })); rejected.push({ kind: "invoice", index: d.index, reason: t("legacy.reasonInvoiceId"), raw: d.item }); }
    } else {
      const dupProduct = firstDuplicate(products.map((p) => p.id));
      if (dupProduct) return { error: t("data.dupProduct", { id: dupProduct }) };
      const dupInvoice = firstDuplicate(invoices.map((i) => i.id));
      if (dupInvoice) return { error: t("data.dupInvoice", { id: dupInvoice }) };
      const dupNumber = firstDuplicate(invoices.map((i) => i.invoiceNumber));
      if (dupNumber) return { error: t("data.dupNumber", { number: dupNumber }) };
    }

    // The counter never goes backwards: if it is lower than an invoice already issued, it is raised.
    const stored = Math.max(0, Math.floor(toNumber(raw.invoiceCounter)));
    const highest = highestInvoiceNumber(invoices);
    if (highest > stored) warnings.push(t("warn.counterRaised"));
    return {
      problems,
      rejected,
      warnings,
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

  // True when a dataset holds something worth protecting (anything beyond a brand new, empty install).
  function hasMeaningfulData(data) {
    if (!data) return false;
    return (data.products && data.products.length > 0) ||
      (data.invoices && data.invoices.length > 0) ||
      toNumber(data.counter) > 0 ||
      (!!data.settings && !sameValue(normalizeSettings(data.settings), DEFAULT_SETTINGS));
  }

  /* ---------- Backup files ---------- */

  function summarize(problems) {
    const more = problems.length > 3 ? t("data.andMore", { n: problems.length - 3 }) : "";
    return problems.slice(0, 3).join(" ") + more;
  }

  function backupFileName(now, prefix) {
    const pad = (n) => String(n).padStart(2, "0");
    const d = now || new Date();
    return `${prefix || "invoisy-backup"}-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`;
  }

  function withDerived(inv) {
    const pay = paymentSummary(inv);
    return { ...inv, amountPaid: pay.paid, remaining: pay.remaining, status: pay.cls };
  }

  // The backup file. `snapshot` is what database.js reads: { products, invoices, settings, counter }.
  // Customers and payments are saved inside each invoice, so there are no separate lists for them.
  function buildBackup(snapshot, now) {
    return {
      application: APP_NAME,
      formatVersion: BACKUP_FORMAT_VERSION,
      exportedAt: (now || new Date()).toISOString(),
      counts: { products: snapshot.products.length, invoices: snapshot.invoices.length },
      data: {
        products: snapshot.products,
        invoices: snapshot.invoices.map(withDerived),
        settings: snapshot.settings,
        invoiceCounter: snapshot.counter,
      },
    };
  }

  // Builds the backup text and checks it by reading it back with the same code a restore uses.
  // Nothing is offered for download unless this succeeds.
  function prepareBackupFile(snapshot, now, prefix) {
    const when = now || new Date();
    let text;
    try {
      text = JSON.stringify(buildBackup(snapshot, when), null, 2);
    } catch {
      return { error: t("backup.cannotConvert") };
    }
    const check = parseBackup(text);
    if (check.error) return { error: t("backup.safetyFailed", { error: check.error }) };
    if (check.data.products.length !== snapshot.products.length || check.data.invoices.length !== snapshot.invoices.length) {
      return { error: t("backup.safetyFailed", { error: t("backup.safetyCounts") }) };
    }
    return { text, name: backupFileName(when, prefix), counts: { products: snapshot.products.length, invoices: snapshot.invoices.length } };
  }

  // Reads a backup file (the current format, or the old invoisy-data.json / backup format).
  // Returns { error } or { format, exportedAt, data, warnings }. Nothing is repaired or guessed.
  function parseBackup(text) {
    if (typeof text !== "string" || !text.trim()) return { error: t("backup.empty") };
    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      return { error: t("data.notJson") };
    }
    if (!isObj(raw)) return { error: t("backup.notInvoisy") };

    let inner;
    let format;
    let exportedAt = "";
    let counts = null;
    if (raw.application !== undefined) {
      if (raw.application !== APP_NAME) return { error: t("backup.otherApp") };
      if (!Number.isInteger(raw.formatVersion) || raw.formatVersion < 1) return { error: t("backup.noFormat") };
      if (raw.formatVersion > BACKUP_FORMAT_VERSION) return { error: t("backup.newerFormat", { version: raw.formatVersion }) };
      if (!isObj(raw.data)) return { error: t("backup.noData") };
      inner = { version: DATA_VERSION, products: raw.data.products, invoices: raw.data.invoices, settings: raw.data.settings, invoiceCounter: raw.data.invoiceCounter };
      format = "backup";
      exportedAt = isDate(raw.exportedAt) ? raw.exportedAt : "";
      counts = isObj(raw.counts) ? raw.counts : null;
    } else if (raw.version !== undefined || (Array.isArray(raw.products) && Array.isArray(raw.invoices))) {
      inner = raw;
      format = "legacy-file";
      exportedAt = isDate(raw.lastSaved) ? raw.lastSaved : "";
    } else {
      return { error: t("backup.notInvoisy") };
    }

    const built = buildData(inner, false);
    if (built.error) return { error: built.error };
    if (built.problems.length) return { error: summarize(built.problems) };
    if (counts && (counts.products !== built.data.products.length || counts.invoices !== built.data.invoices.length)) {
      return { error: t("backup.countsMismatch") };
    }
    const warnings = [...built.warnings];
    if (!exportedAt) warnings.push(t("warn.noExportDate"));
    return { format, exportedAt, data: built.data, warnings };
  }

  /* ---------- Data an older version left in the browser (localStorage) ---------- */

  // Reads what the previous versions saved in localStorage. It never changes or removes anything.
  //   storage : an object with getItem(key), like window.localStorage.
  // Order of preference (the same the previous version used): its browser copy ("invoisy-data"), then the
  // oldest separate keys (products, invoices, settings, invoiceCounter).
  function readLegacyStorage(storage) {
    const result = { found: false, source: null, data: null, problems: [], rejected: [], warnings: [], notes: [], unreadable: false };
    const read = (key) => {
      try {
        const value = storage.getItem(key);
        return value === undefined ? null : value;
      } catch {
        result.notes.push(t("legacy.storageUnreadable"));
        return undefined;   // undefined = could not be read (different from null = not there)
      }
    };

    const mirrorText = read(MIRROR_KEY);
    const keyTexts = {};
    for (const key of LEGACY_KEYS) keyTexts[key] = read(key);
    const anyKey = LEGACY_KEYS.some((k) => keyTexts[k] !== null && keyTexts[k] !== undefined);
    result.found = (mirrorText !== null && mirrorText !== undefined) || anyKey;
    result.rawDump = { [MIRROR_KEY]: mirrorText, ...keyTexts };
    if (!result.found) return result;

    let usedMirror = false;
    if (mirrorText !== null && mirrorText !== undefined) {
      let parsed = null;
      try { parsed = JSON.parse(mirrorText); } catch { parsed = null; }
      const structured = isObj(parsed) && Array.isArray(parsed.products) && Array.isArray(parsed.invoices) && isObj(parsed.settings);
      if (structured) {
        const built = buildData(parsed, true);
        if (!built.error) {
          result.source = "browser-copy";
          result.data = built.data;
          result.problems.push(...built.problems);
          result.rejected.push(...built.rejected);
          result.warnings.push(...built.warnings);
          usedMirror = true;
          if (anyKey) result.notes.push(t("legacy.newerCopyUsed"));
        }
      }
      if (!usedMirror) {
        result.notes.push(t("legacy.copyUnreadable"));
        result.rejected.push({ kind: "stored-browser-copy", index: -1, reason: t("legacy.reasonUnreadable"), raw: mirrorText });
      }
    }

    if (!usedMirror && anyKey) {
      const parts = {};
      for (const key of LEGACY_KEYS) {
        if (keyTexts[key] === null || keyTexts[key] === undefined) continue;
        try {
          parts[key] = JSON.parse(keyTexts[key]);
        } catch {
          result.problems.push(t("legacy.keyUnreadable", { key }));
          result.notes.push(t("legacy.keyDamaged", { key }));
          result.rejected.push({ kind: "stored-" + key, index: -1, reason: t("legacy.reasonUnreadable"), raw: keyTexts[key] });
        }
      }
      const readable = Object.keys(parts).length > 0;
      if (readable) {
        const built = buildData({
          products: Array.isArray(parts.products) ? parts.products : [],
          invoices: Array.isArray(parts.invoices) ? parts.invoices : [],
          settings: isObj(parts.settings) ? parts.settings : {},
          invoiceCounter: parts.invoiceCounter,
        }, true);
        if (!built.error) {
          result.source = "separate-entries";
          result.data = built.data;
          result.problems.push(...built.problems);
          result.rejected.push(...built.rejected);
          result.warnings.push(...built.warnings);
        }
      }
    }

    // Something was stored but nothing in it could be understood: it must not be treated as "no data".
    if (!result.data) result.unreadable = true;
    return result;
  }

  // A file the person can keep as a copy of the older browser data. When the data could be read it is a normal
  // backup (it can be restored), plus the entries that were set aside and the raw stored text, which Restore
  // ignores. When nothing could be read it holds only the raw stored text, for support.
  function prepareLegacyCopy(storage, now) {
    const legacy = readLegacyStorage(storage);
    if (!legacy.found) return { error: t("legacy.noneFound") };
    const when = now || new Date();
    const extras = {
      legacyCopy: {
        source: legacy.source,
        unreadableEntries: legacy.rejected.map((r) => ({ kind: r.kind, reason: r.reason, entry: r.raw })),
        rawStoredText: legacy.rawDump,
      },
    };
    let file;
    if (legacy.data) {
      file = { ...buildBackup(legacy.data, when), ...extras };
      file.data.invoiceCounter = legacy.data.counter;
    } else {
      file = { application: APP_NAME, formatVersion: BACKUP_FORMAT_VERSION, exportedAt: when.toISOString(), ...extras };
    }
    try {
      return { text: JSON.stringify(file, null, 2), name: backupFileName(when, "invoisy-old-browser-data"), restorable: !!legacy.data };
    } catch {
      return { error: t("legacy.cannotConvert") };
    }
  }

  // The reminder shown in the top bar. Pure so it can be tested without a screen.
  //   info    : { lastBackupAt, intervalDays }
  //   hasData : there is something worth backing up
  function backupReminder(info, hasData, now) {
    if (!hasData) return { level: "none", text: "" };
    const days = Math.max(1, Math.floor(toNumber(info && info.intervalDays)) || DEFAULT_BACKUP_DAYS);
    const last = info && info.lastBackupAt ? new Date(info.lastBackupAt) : null;
    if (!last || isNaN(last)) return { level: "never", days: null, text: t("reminder.never") };
    const age = Math.floor(((now || new Date()) - last) / 86400000);
    if (age >= days) return { level: "overdue", days: age, text: tn("reminder.overdue", age) };
    return { level: "ok", days: Math.max(0, age), text: "" };
  }

  globalThis.Validation = {
    APP_NAME, CURRENCY, DATA_VERSION, BACKUP_FORMAT_VERSION, MIRROR_KEY, LEGACY_KEYS, DEFAULT_BACKUP_DAYS,
    DEFAULT_SETTINGS, SELLING_UNITS, INVOICE_STATUSES, DERIVED_INVOICE_FIELDS,
    isObj, isStr, isNum, isDate, round2, toNumber, uid, sameValue,
    formatInvoiceNumber, invoiceSequence, highestInvoiceNumber,
    isTileSize, normalizeTileSize, normalizeProduct, normalizeInvoice, normalizeSettings, paymentSummary, stripDerived,
    productProblem, invoiceProblem, invoiceWarnings, settingsProblem, legacyProductIssue, legacyInvoiceIssue,
    buildData, hasMeaningfulData, buildBackup, prepareBackupFile, parseBackup, backupFileName,
    readLegacyStorage, prepareLegacyCopy, backupReminder,
  };
})();

"use strict";

/* ==========================================================================
   Validation - the shape of Invoisy's saved data and the rules it must follow.

   Plain script (no modules, so index.html still works when opened directly).
   No DOM and no storage access: it only inspects and converts data, so the
   database layer, backups and tests can all share exactly the same rules.
   Loaded after i18n.js, the language files, calc.js and purchases.js (it uses their
   units and rules, and speaks the current language) and before database.js and script.js.

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
  const BACKUP_FORMAT_VERSION = 2;       // version of the backup file made by Export Backup (1 = before suppliers and purchases; still readable)
  const P = globalThis.Purchases;        // suppliers, purchases and supplier payments (purchases.js)
  const MIRROR_KEY = "invoisy-data";     // browser copy written by the previous (data file) version
  const LEGACY_KEYS = ["products", "invoices", "settings", "invoiceCounter"];
  // Calculated from the payments, the carried-forward lines and the debt transfers, never trusted when read back.
  // amountDue and transferredOut are only written to a backup when they matter (see withDerived).
  const DERIVED_INVOICE_FIELDS = ["amountPaid", "amountRefunded", "remaining", "status", "amountDue", "transferredOut", "deliveryStatus"];
  // "transferred": nothing is left to collect on this invoice because its unpaid balance was carried forward to a newer invoice.
  // "cancelled": the whole sale was cancelled (see Cancelled sales and refunds below); it is no longer an active sale.
  const INVOICE_STATUSES = ["paid", "partial", "unpaid", "transferred", "cancelled"];
  const REFUND_REASONS = ["cancellation", "refund"];   // why money went back to the customer: a cancelled sale, or a refund recorded for an overpayment
  const WALK_IN = "Walk-in Customer";    // the name saved for a sale without a customer (script.js shows it in the current language)
  const MONEY_TOLERANCE = 0.01;
  const DEFAULT_BACKUP_DAYS = 7;
  const SUPPLIER_LISTS = ["suppliers", "purchases", "supplierPayments", "attachments"];   // the supplier side of a backup

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

  /* ---------- Carried-forward debt ----------
     A customer's unpaid balance on an older invoice can be CARRIED FORWARD to a NEW invoice. It is then owed once,
     on the new invoice:
       - the new invoice lists the amount in carriedForward[] and owes   total (this purchase) + carried amounts.
         Its own subtotal, discount, tax and total keep describing the products sold: carried debt is not revenue.
       - one record per carried amount sits in the debtTransfers ledger (which older invoice, which new invoice,
         how much, and what was available before and after).
       - the older invoice is never edited. Its total and payments stay exactly as issued; what can still be collected
         on it is   amount due - payments - transferred out   (calculated from the ledger, never stored).
     Everything here is pure arithmetic and checking, shared by the screens, the database and backups. */

  /* ---------- Cancelled sales and refunds ----------
     The whole sale of an invoice can be CANCELLED (its products are all taken off in the edit screen). Nothing is erased:
       - items, subtotal, discount, tax, total and payments stay exactly as they were sold and paid (the original transaction);
       - `cancellation: { at, total, paid, refund }` records when, what the sale was worth, what had been collected and what was
         refunded; `refunds: [{ id, amount, timestamp, reason }]` records the money that went back to the customer. A refund is
         never a negative payment: payments are never changed. reason "cancellation" = the refund made by the cancellation,
         "refund" = a refund recorded later for an overpayment (an invoice made cheaper after it was paid).
       - a cancelled sale is worth nothing: the invoice asks only for the old debt carried onto it (if any), so it adds
         nothing to what customers owe and is not an active sale. Money kept for the invoice is   payments - refunds.
     A cancelled invoice is locked (see cancellationHistoryProblem): it can not be cancelled again, edited or refunded twice. */

  const isCancelled = (inv) => isObj(inv) && isObj(inv.cancellation);
  const refundsOf = (inv) => (inv && Array.isArray(inv.refunds) ? inv.refunds : []);
  const refundedTotal = (inv) => round2(refundsOf(inv).reduce((sum, r) => sum + toNumber(r && r.amount), 0));

  const carriedLines = (inv) => (inv && Array.isArray(inv.carriedForward) ? inv.carriedForward : []);
  const paidTotal = (inv) => round2((inv && Array.isArray(inv.payments) ? inv.payments : []).reduce((sum, p) => sum + toNumber(p && p.amount), 0));
  const carriedTotal = (inv) => round2(carriedLines(inv).reduce((sum, l) => sum + toNumber(l && l.amount), 0));
  // The money the invoice still holds for the customer: everything paid, less what was handed back.
  const netPaid = (inv) => round2(paidTotal(inv) - refundedTotal(inv));
  // What the invoice asks the customer to pay: this purchase plus the debt carried onto it. A cancelled sale asks only for the debt.
  const amountDue = (inv) => (isCancelled(inv) ? carriedTotal(inv) : round2(toNumber(inv && inv.total) + carriedTotal(inv)));
  // What the customer is owed back when the money held for the invoice is MORE than it now asks for (an invoice whose total
  // was lowered by an edit, for example a returned box, or a cancelled sale, after it had been paid), less what was already
  // refunded. Derived, never stored, and never a payment: the payment history is never changed to hide it.
  const refundDue = (inv) => Math.max(0, round2(netPaid(inv) - amountDue(inv)));
  // How much of this invoice's balance was carried forward to other invoices.
  function transferredOut(inv, transfers) {
    if (!inv || !Array.isArray(transfers)) return 0;
    return round2(transfers.reduce((sum, tr) => (tr && tr.sourceInvoiceId === inv.id ? sum + toNumber(tr.amount) : sum), 0));
  }

  // How the payments received on THIS invoice are applied: oldest debt first, then this purchase.
  // Pure and derived: payments are never copied or split, so nothing can be counted twice.
  function carriedBreakdown(inv) {
    let left = netPaid(inv);
    const sorted = [...carriedLines(inv)].sort((a, b) => invoiceSequence(a.sourceInvoiceNumber) - invoiceSequence(b.sourceInvoiceNumber));
    const lines = sorted.map((l) => {
      const settled = Math.min(round2(toNumber(l.amount)), left);
      left = round2(left - settled);
      return { ...l, settled: round2(settled), remaining: round2(toNumber(l.amount) - settled) };
    });
    const total = isCancelled(inv) ? 0 : round2(toNumber(inv && inv.total));
    const currentPaid = Math.min(left, total);
    return {
      lines,
      carriedPaid: round2(carriedTotal(inv) - lines.reduce((sum, l) => sum + l.remaining, 0)),
      carriedRemaining: round2(lines.reduce((sum, l) => sum + l.remaining, 0)),
      currentPaid: round2(currentPaid),
      currentRemaining: round2(total - currentPaid),
    };
  }

  /* ---------- Who is the customer? ----------
     Invoices keep the customer inside them (name, phone, address), plus an optional id that is added when a
     returning customer is confirmed on the Sell page. Two invoices are the same customer when they share an id, or
     the same name AND phone number (both normalized). A name alone is only a weak identity: it is never matched
     silently, the person has to confirm it. A sale with no name, or the walk-in name, has no identity at all. */

  // "  Ahmed   BENALI " and "ahmed benali" and "Ahmèd Benali" are the same name.
  function normalizeName(name) {
    return String(name == null ? "" : name)
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[’‘`´]/g, "'")
      .toLowerCase().replace(/\s+/g, " ").trim();
  }

  // Digits only, and the Algerian "+213 555 12 34 56" is the same number as "0555 12 34 56".
  // Fewer than 6 digits is not a usable phone number.
  function phoneDigits(phone) {
    let digits = String(phone == null ? "" : phone).replace(/\D/g, "");
    if (digits.startsWith("00")) digits = digits.slice(2);
    if (digits.startsWith("213") && digits.length === 12) digits = "0" + digits.slice(3);
    return digits.length >= 6 ? digits : "";
  }

  function isWalkInName(name) {
    const n = normalizeName(name);
    return !n || n === normalizeName(WALK_IN) || n === normalizeName(I18n.t("sell.walkIn"));
  }

  // The identities one customer record can be recognized by, strongest first. [] = no reliable identity.
  function customerKeys(customer) {
    const c = customer || {};
    const name = normalizeName(c.name);
    if (isWalkInName(name)) return [];
    const keys = [];
    if (c.id) keys.push("id:" + c.id);
    const phone = phoneDigits(c.phone);
    keys.push(phone ? "np:" + name + "|" + phone : "n:" + name);
    return keys;
  }

  // All invoices grouped by customer. Invoices that share any key (an id, or name+phone) end up in one group.
  // { keys, ids, invoices (oldest first), name, phone, address, lastDate } - name, phone and address are the latest ones.
  function customerGroups(invoices) {
    const parent = new Map();
    const find = (key) => {
      let root = key;
      while (parent.get(root) !== root) root = parent.get(root);
      for (let k = key; parent.get(k) !== root;) { const next = parent.get(k); parent.set(k, root); k = next; }
      return root;
    };
    const entries = [];
    for (const inv of invoices || []) {
      const keys = customerKeys(inv && inv.customer);
      if (!keys.length) continue;
      for (const k of keys) if (!parent.has(k)) parent.set(k, k);
      for (let i = 1; i < keys.length; i++) {
        const a = find(keys[0]);
        const b = find(keys[i]);
        if (a !== b) parent.set(b, a);
      }
      entries.push({ inv, keys });
    }
    const byRoot = new Map();
    for (const { inv, keys } of entries) {
      const root = find(keys[0]);
      if (!byRoot.has(root)) byRoot.set(root, { keys: new Set(), invoices: [] });
      const group = byRoot.get(root);
      keys.forEach((k) => group.keys.add(k));
      group.invoices.push(inv);
    }
    return [...byRoot.values()].map((g) => {
      const latest = g.invoices.reduce((best, inv) => (invoiceSequence(inv.invoiceNumber) >= invoiceSequence(best.invoiceNumber) ? inv : best), g.invoices[0]);
      const c = latest.customer || {};
      const keys = [...g.keys];
      return {
        keys,
        ids: keys.filter((k) => k.startsWith("id:")).map((k) => k.slice(3)),
        invoices: g.invoices,
        name: String(c.name || "").trim(),
        phone: String(c.phone || "").trim(),
        address: String(c.address || "").trim(),
        lastDate: latest.date,
      };
    });
  }

  const findGroup = (groups, key) => groups.find((g) => g.keys.includes(key)) || null;

  function sameCustomer(a, b, groups) {
    const keysA = customerKeys(a && a.customer);
    const keysB = customerKeys(b && b.customer);
    if (!keysA.length || !keysB.length) return false;
    const group = findGroup(groups, keysA[0]);
    return !!group && keysB.some((k) => group.keys.includes(k));
  }

  /* ---------- The debt-transfer ledger ---------- */

  // One record of the ledger:
  //   { id, sourceInvoiceId, sourceInvoiceNumber, targetInvoiceId, targetInvoiceNumber, amount, createdAt,
  //     sourceTotal, sourcePaid, availableBefore, availableAfter }
  // The last four are a snapshot for the audit trail: what the older invoice asked, what had been paid, and what was
  // still collectible before and after this transfer. They are informational; balances are always recalculated.
  function transferProblem(tr) {
    if (!isObj(tr)) return t("problem.notObject");
    if (!isStr(tr.id) || !tr.id) return t("problem.noId");
    for (const key of ["sourceInvoiceId", "targetInvoiceId"]) if (!isStr(tr[key]) || !tr[key]) return t("problem.badTransfer");
    for (const key of ["sourceInvoiceNumber", "targetInvoiceNumber"]) if (!isStr(tr[key]) || !/^INV-\d+$/.test(tr[key])) return t("problem.badTransfer");
    if (tr.sourceInvoiceId === tr.targetInvoiceId) return t("problem.badTransfer");
    if (!isNum(tr.amount) || tr.amount <= 0) return t("problem.badTransferAmount");
    if (!isDate(tr.createdAt)) return t("problem.badTransfer");
    for (const key of ["sourceTotal", "sourcePaid", "availableBefore", "availableAfter"]) {
      if (tr[key] !== undefined && (!isNum(tr[key]) || tr[key] < 0)) return t("problem.badTransfer");
    }
    return "";
  }

  // Checks the whole ledger against the invoices it points at. Returns a list of problems ([] = consistent).
  // This is the "nothing is owed twice" rule: for every invoice, payments + amounts carried away from it can never
  // be more than what it asked for, so the same balance can not be carried twice, or carried and also collected.
  // Run by the database inside the transaction of every change that touches invoices or the ledger, and on every restore.
  function ledgerProblems(invoices, transfers) {
    const problems = [];
    const list = Array.isArray(transfers) ? transfers : [];
    // The common case, data that never carried any debt, costs nothing.
    if (!list.length && !(invoices || []).some((inv) => carriedLines(inv).length)) return problems;
    const byId = new Map((invoices || []).map((inv) => [inv.id, inv]));
    const groups = customerGroups(invoices || []);
    const seen = new Set();
    const seenPairs = new Set();
    const out = new Map();
    for (const tr of list) {
      const label = `${tr.sourceInvoiceNumber} → ${tr.targetInvoiceNumber}`;
      if (seen.has(tr.id)) { problems.push(t("ledger.duplicateId", { id: tr.id })); continue; }
      seen.add(tr.id);
      const pair = tr.sourceInvoiceId + ">" + tr.targetInvoiceId;
      if (seenPairs.has(pair)) problems.push(t("ledger.duplicateTransfer", { label }));
      seenPairs.add(pair);
      const source = byId.get(tr.sourceInvoiceId);
      const target = byId.get(tr.targetInvoiceId);
      if (!source) problems.push(t("ledger.sourceMissing", { number: tr.sourceInvoiceNumber }));
      if (!target) problems.push(t("ledger.targetMissing", { number: tr.targetInvoiceNumber }));
      if (!source || !target) continue;
      if (source.invoiceNumber !== tr.sourceInvoiceNumber || target.invoiceNumber !== tr.targetInvoiceNumber) problems.push(t("ledger.numberMismatch", { label }));
      // Debt only ever moves to a NEWER invoice, so a chain of transfers can never loop back on itself.
      if (invoiceSequence(target.invoiceNumber) <= invoiceSequence(source.invoiceNumber)) problems.push(t("ledger.order", { label }));
      const line = carriedLines(target).find((l) => l.transferId === tr.id);
      if (!line || line.sourceInvoiceId !== tr.sourceInvoiceId || Math.abs(toNumber(line.amount) - tr.amount) > 0.005) problems.push(t("ledger.lineMismatch", { label }));
      if (!sameCustomer(source, target, groups)) problems.push(t("ledger.otherCustomer", { label }));
      out.set(source.id, round2((out.get(source.id) || 0) + tr.amount));
    }
    const ids = new Set(list.map((tr) => tr && tr.id));
    for (const inv of invoices || []) {
      for (const l of carriedLines(inv)) if (!ids.has(l.transferId)) problems.push(t("ledger.lineWithoutTransfer", { number: inv.invoiceNumber, from: l.sourceInvoiceNumber }));
    }
    for (const [id, sum] of out) {
      const inv = byId.get(id);
      if (!inv) continue;
      const due = amountDue(inv);
      if (round2(netPaid(inv) + sum) > due + MONEY_TOLERANCE) {
        problems.push(t("ledger.overTransferred", { number: inv.invoiceNumber, due, paid: netPaid(inv), moved: sum }));
      }
    }
    return problems;
  }

  /* ---------- Normalizing (filling in fields an older version did not have) ---------- */

  // Tile sizes (60*120, 60x120, 60 × 120 cm ...) are parsed in calc.js.
  const isTileSize = Calc.isTileSize;
  const normalizeTileSize = Calc.normalizeTileSize;

  // The optional type of a product, shown under its name on invoices. "" = none. These are the stored values; the
  // words people see come from the language files (productType.<value>), so French shows Dalle de sol, Faïence, Porcelaine, Pierre, Évier, Ciment-colle, Pâte à joint, Parquet.
  // A product saved before the field existed simply has none.
  const PRODUCT_TYPES = ["DalleDeSol", "Faience", "Porcelain", "Rock", "Evier", "CimentColle", "PateAJoint", "Parquet"];
  // Spellings an earlier version saved (the type is "Dalle de sol"): they are read as the current value, so no saved
  // product or invoice is lost.
  const LEGACY_PRODUCT_TYPES = { Daldosol: "DalleDeSol", Daltosol: "DalleDeSol" };
  // The stored value a type is known by (an old spelling becomes the current one); "" for no type or an unknown one.
  function normalizeProductType(type) {
    const value = LEGACY_PRODUCT_TYPES.hasOwnProperty(type) ? LEGACY_PRODUCT_TYPES[type] : type;
    return PRODUCT_TYPES.includes(value) ? value : "";
  }

  function normalizeProduct(raw) {
    if (!raw || typeof raw !== "object" || !raw.name) return null;
    // The price list: the saved `sellingPrices`, or (a product saved before the list existed) its one price in its own
    // price unit. A product with no price unit gets an empty list and keeps its price as typed. The older
    // `sellingPrice` / `priceUnit` fields are kept equal to the first entry, so older versions still read them.
    const priceList = Calc.getSellingPrices({ sellingPrices: raw.sellingPrices, sellingPrice: raw.sellingPrice, priceUnit: raw.priceUnit });
    const price = priceList.length ? priceList[0].price : Number(raw.sellingPrice);
    const priceUnit = priceList.length ? priceList[0].unit : Calc.normalizeUnit(raw.priceUnit);
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
      productType: normalizeProductType(raw.productType),
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
      // One independent price per selling unit (see calc.js). Empty for a product that has no price unit.
      sellingPrices: priceList,
      stockUnit,
      purchasePrice: hasCost ? Number(raw.purchasePrice) : null,
      stock: Number.isFinite(stock) && stock >= 0 ? Calc.cleanNumber(stock) : 0,
    };
  }

  /* ---------- A product typed into a form (Stock form and the product made while recording a purchase) ---------- */

  const looseKey = (v) => String(v == null ? "" : v).trim().replace(/\s+/g, " ").toLowerCase();
  const productName = (p) => [p.name, p.tileSize, p.manufacturer].filter(Boolean).join(" — ");

  // The product in `products` that `candidate` would repeat, or null. Two products are the same when they share a SKU,
  // or when name, manufacturer and tile size all match and the SKUs do not tell them apart (a different SKU on each side
  // is a different variant). `exceptId` is the product being edited. Returns { product, by: "sku" | "identity" }.
  function findDuplicateProduct(candidate, products, exceptId) {
    const sku = looseKey(candidate.sku);
    const size = (p) => looseKey(Calc.normalizeTileSize(p.tileSize));
    const others = (products || []).filter((p) => p && (exceptId == null || p.id !== exceptId));
    for (const p of others) {
      if (sku && looseKey(p.sku) === sku) return { product: p, by: "sku" };
    }
    for (const p of others) {
      const sameThing = looseKey(p.name) === looseKey(candidate.name) && looseKey(p.manufacturer) === looseKey(candidate.manufacturer) && size(p) === size(candidate);
      if (sameThing && (!sku || !looseKey(p.sku))) return { product: p, by: "identity" };
    }
    return null;
  }

  // Products that LOOK like the one typed without being the same product (findDuplicateProduct is the rule that refuses an
  // exact repeat). Two products look alike when their names are the same once case, accents, spaces and punctuation are
  // ignored, or when one name is inside the other and their tile sizes do not tell them apart. This only WARNS before a
  // new product is added; nothing is refused or merged here. `exceptId` is a product to leave out.
  function findSimilarProducts(candidate, products, exceptId) {
    const plain = (v) => String(v == null ? "" : v).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
    const size = (p) => looseKey(Calc.normalizeTileSize(p.tileSize));
    const name = plain(candidate.name);
    if (!name) return [];
    return (products || []).filter((p) => {
      if (!p || (exceptId != null && p.id === exceptId)) return false;
      const other = plain(p.name);
      if (!other) return false;
      if (other === name) return true;
      const inside = Math.min(other.length, name.length) >= 4 && (other.includes(name) || name.includes(other));
      return inside && (!size(p) || !size(candidate) || size(p) === size(candidate));
    }).slice(0, 5);
  }

  // The products to suggest while a name is being typed in the Stock form (a live "did you mean one of these?" list).
  // Case, accents, spaces and punctuation do not matter ("Cotto-Bianco", "cotto  bianco" and "COTTOBIANCO" are alike). A product
  // matches when the typed text is inside its name, manufacturer, tile size or type, or when every word typed is somewhere in
  // them. Best matches first (the same name, then names that start with it). Only suggests: nothing is merged or refused here.
  // `products` is the list already in memory (no database read), `exceptId` the product being edited.
  function suggestProducts(query, products, options) {
    const opts = options || {};
    const plain = (v) => String(v == null ? "" : v).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
    const words = String(query == null ? "" : query).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const typed = words.join("");
    if (!typed) return [];
    const ranked = [];
    for (const p of products || []) {
      if (!p || (opts.exceptId != null && p.id === opts.exceptId)) continue;
      const name = plain(p.name);
      const all = name + plain(p.manufacturer) + plain(p.tileSize) + plain(p.productType);
      const rank = name === typed ? 0 : name.startsWith(typed) ? 1 : name.includes(typed) ? 2 : all.includes(typed) || words.every((w) => all.includes(w)) ? 3 : -1;
      if (rank >= 0) ranked.push({ p, rank, name: String(p.name) });
    }
    ranked.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
    return ranked.slice(0, opts.limit || 6).map((x) => x.p);
  }

  // THE one place a product typed into a form is checked, so every way of adding a product follows the same rules:
  // the Stock form calls it, and so does a purchase that creates a product (again when the draft is confirmed).
  //   raw  what was typed: { name, manufacturer, tileSize, coveragePerBox, description, sku, category,
  //        prices: [{ unit, price }], stockUnit, purchasePrice, stock }. A product kept the older way
  //        ({ sellingPrice, priceUnit } or { sellingPrices }) is read as well.
  //   ctx  { products: the catalogue (plus any product made earlier in the same purchase),
  //          editing: the product being edited, stockFromPurchase: stock is not typed: the goods received add to it }
  // Returns { values } ready to save, or { field, index, error } for the first problem, in the order of the form.
  // field is one of name, tileSize, coveragePerBox, priceUnit, priceValue (index = the price row), prices, purchasePrice,
  // stockUnit, stock, sku, duplicate.
  function readProductInput(raw, ctx) {
    const input = raw || {};
    const options = ctx || {};
    const get = (key) => (input[key] == null ? "" : String(input[key]).trim());
    const fail = (field, error, index) => ({ field, error, index: index === undefined ? -1 : index });

    const name = get("name");
    if (!name) return fail("name", t("product.nameRequired"));
    const productType = get("productType");
    if (productType && !normalizeProductType(productType)) return fail("productType", t("product.typeInvalid"));
    const tileSizeRaw = get("tileSize");
    if (tileSizeRaw && !isTileSize(tileSizeRaw)) return fail("tileSize", t("product.tileSizeFormat"));
    const tileSize = tileSizeRaw ? normalizeTileSize(tileSizeRaw) : "";
    const coverageRaw = get("coveragePerBox");
    const coveragePerBox = Number(coverageRaw);
    if (coverageRaw !== "" && (!Number.isFinite(coveragePerBox) || coveragePerBox <= 0)) return fail("coveragePerBox", t("product.coverageGreater"));

    // Selling prices: one independent price per unit (checked in calc.js, the same rules the database applies).
    let rows;
    if (Array.isArray(input.prices)) rows = input.prices;
    else if (Array.isArray(input.sellingPrices) && input.sellingPrices.length) rows = input.sellingPrices;
    else rows = [{ unit: input.priceUnit, price: input.sellingPrice }];
    rows = rows.map((r) => {
      const row = r || {};
      return { unit: row.unit, price: row.price == null ? "" : String(row.price).trim() };
    });
    const unitless = rows.findIndex((r) => !Calc.isUnit(r.unit));
    if (unitless >= 0) return fail("priceUnit", t("product.chooseUnit"), unitless);
    const checked = Calc.checkSellingPrices(rows);
    if (checked.error) {
      if (checked.index < 0) return fail("prices", checked.error);
      return fail(checked.field === "price" ? "priceValue" : "priceUnit", checked.error, checked.index);
    }
    const prices = checked.value;
    if (prices.some((entry) => entry.unit === "m2") && coverageRaw === "") return fail("coveragePerBox", t("product.coverageNeeded"));

    const costRaw = get("purchasePrice");
    const cost = Number(costRaw);
    if (costRaw !== "" && (!Number.isFinite(cost) || cost < 0)) return fail("purchasePrice", t("product.costNegative"));

    const stockUnit = get("stockUnit");
    if (!Calc.isUnit(stockUnit)) return fail("stockUnit", t("product.chooseStockUnit"));
    if (Calc.unitFamily(stockUnit) !== Calc.unitFamily(prices[0].unit)) {
      return fail("stockUnit", t("product.stockUnitMismatch", { stock: t("stockunit." + stockUnit), price: t("price." + prices[0].unit) }));
    }

    // A product made while recording a purchase starts at 0: the goods received add to it (once, in confirmPurchase).
    let stock = 0;
    if (!options.stockFromPurchase) {
      const stockRaw = get("stock");
      stock = stockRaw === "" ? 0 : Number(stockRaw);
      // Selling pieces out of box-counted stock leaves part of a box (19.25 boxes). That saved quantity can be kept as it is
      // while editing (to change a price, say); only a quantity typed in has to be a whole number for a whole unit.
      const editing = options.editing || null;
      const unchangedStock = Boolean(editing) && stockRaw !== "" && stock === editing.stock && stockUnit === editing.stockUnit;
      if (!Number.isFinite(stock) || stock < 0 || (Calc.isWholeUnit(stockUnit) && !Number.isInteger(stock) && !unchangedStock)) {
        return fail("stock", t(Calc.isWholeUnit(stockUnit) ? "product.stockWhole" : "product.stockNumber"));
      }
    }

    const sku = get("sku");
    const values = {
      name,
      productType: normalizeProductType(productType),
      manufacturer: get("manufacturer"),
      tileSize,
      coveragePerBox: coverageRaw === "" ? null : coveragePerBox,
      description: get("description"),
      sku,
      category: get("category"),
      ...Calc.priceFields(prices),   // sellingPrices, plus sellingPrice / priceUnit as the first entry
      stockUnit,
      purchasePrice: costRaw === "" ? null : cost,
      stock,
    };

    const same = findDuplicateProduct(values, options.products, options.editing ? options.editing.id : null);
    if (same && same.by === "sku") return fail("sku", t("product.skuUsed", { sku, name: same.product.name }));
    // Editing a product that already has a twin from before (saved when two could be identical) must stay possible:
    // only changing its name, manufacturer or tile size into someone else's is refused.
    const editing = options.editing;
    const identity = (p) => [p.name, p.manufacturer, Calc.normalizeTileSize(p.tileSize)].map(looseKey).join("|");
    const identityUnchanged = Boolean(editing) && identity(editing) === identity(values);
    if (same && !identityUnchanged) return fail("duplicate", t("product.duplicate", { label: productName(same.product) }));
    return { values };
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
      const due = amountDue(clean);
      payments = due > 0 ? [{ amount: due, timestamp: inv.date }] : [];
    }
    return { ...clean, id: String(inv.id || uid()), payments };
  }

  /* ---------- The business phone numbers ----------
     A business can have several phone numbers. They are saved as `phones` (a list of text) in the settings. The older single
     `phone` is kept equal to the first number, so nothing that reads it breaks, and a business saved before the list existed
     is simply read as a list of one (businessPhones): nothing is rewritten until the settings are saved again. */

  const MAX_BUSINESS_PHONES = 10;
  const MAX_PHONE_LENGTH = 40;

  // The numbers as a clean list: trimmed, single spaces, blanks left out, and the same number only once ("0555 12 34 56" and
  // "+213 555 12 34 56" are one number, the first spelling is kept).
  function cleanPhoneList(list) {
    const seen = new Set();
    const out = [];
    for (const raw of Array.isArray(list) ? list : []) {
      const phone = String(raw == null ? "" : raw).replace(/\s+/g, " ").trim();
      if (!phone) continue;
      const key = phoneDigits(phone) || phone.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(phone);
    }
    return out;
  }

  // The numbers of the settings, or of the business details saved inside an invoice: the `phones` list when there is one,
  // otherwise the single `phone` older data has. [] when there is none.
  function businessPhones(source) {
    const s = source || {};
    if (Array.isArray(s.phones)) {
      const list = cleanPhoneList(s.phones);
      if (list.length) return list;
    }
    return cleanPhoneList([s.phone]);
  }

  // The business details an invoice keeps as they were when it was made. With one number (or none) it has exactly the shape it
  // always had; the list is only added when there are several.
  function businessSnapshot(settings) {
    const s = settings || {};
    const phones = businessPhones(s);
    return {
      name: s.businessName,
      address: s.address,
      phone: phones.length > 1 ? phones[0] : (String(s.phone || "") || phones[0] || ""),
      ...(phones.length > 1 ? { phones } : {}),
      email: s.email,
    };
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
      // The list of phone numbers (the one setting that is a list). Only present when it was saved: older settings keep their shape.
      if (Array.isArray(stored.phones)) settings.phones = cleanPhoneList(stored.phones.filter(isStr)).slice(0, MAX_BUSINESS_PHONES);
    }
    if (!settings.currency.trim()) settings.currency = CURRENCY;
    if (!settings.logo.startsWith("data:image/")) settings.logo = "";
    if (!["A4", "A5"].includes(settings.paper)) settings.paper = "A4";
    // An unknown language (for example from a newer backup) falls back to the default instead of blocking the file.
    if (!I18n.has(settings.language)) settings.language = DEFAULT_SETTINGS.language;
    return settings;
  }

  // Total paid, remaining balance and status are always calculated from the payments list, the debt carried onto the
  // invoice and (when the ledger is given) the balance carried away from it to newer invoices.
  // (script.js adds the wording of the status in the current language.)
  //   remaining = what can still be collected on THIS invoice = amount due - (paid - refunded) - transferred out
  //   cls "transferred" = nothing is left to collect here, but only because the unpaid balance moved to a newer invoice.
  //   cls "cancelled" = the whole sale was cancelled (whatever is still owed is only old debt carried onto the invoice).
  //   An invoice is never "paid" just because its debt was carried forward.
  // paymentSummary keeps the four fields every screen and test already knows { payments, paid, remaining, cls };
  // paymentDetail adds what the debt features need: due (amount due), transferredOut and carried, and what money went back:
  // refunded (all refunds recorded) and refundDue (still owed back to the customer).
  function paymentDetail(inv, transfers) {
    const payments = Array.isArray(inv.payments) ? inv.payments : [];
    const paid = round2(payments.reduce((sum, p) => sum + toNumber(p.amount), 0));
    const refunded = refundedTotal(inv);
    const net = round2(paid - refunded);
    const due = amountDue(inv);
    const moved = transferredOut(inv, transfers);
    const remaining = Math.max(0, round2(due - net - moved));
    let cls;
    if (isCancelled(inv)) cls = "cancelled";
    else if (remaining > 0) cls = net > 0 ? "partial" : "unpaid";
    else cls = moved > 0 && round2(due - net) > 0 ? "transferred" : "paid";
    return { payments, paid, refunded, remaining, cls, due, transferredOut: moved, carried: carriedTotal(inv), refundDue: refundDue(inv) };
  }

  function paymentSummary(inv, transfers) {
    const { payments, paid, remaining, cls } = paymentDetail(inv, transfers);
    return { payments, paid, remaining, cls };
  }

  function stripDerived(inv) {
    const clean = { ...inv };
    for (const key of DERIVED_INVOICE_FIELDS) delete clean[key];
    return clean;
  }

  /* ---------- Delivery: what has been handed over and what is still to collect ----------
     Payment and delivery are two separate things. A fully paid invoice can still have goods waiting in the warehouse.

     An invoice is "tracked" when it was sold with part of an item left to collect later. A tracked invoice has
       - a stable lineId on every item, and
       - deliveries[]: an append-only log. The first entry (type "sale") is what left the shop with the sale; every
         later entry (type "collection") is a pick-up recorded by the warehouse. A line of an entry says which item,
         how much (in the unit the item was sold in) and how much stock that took out (in the product's stock unit).
     Nothing else is stored. Delivered and remaining quantities are always calculated from this log (like the payment
     totals are calculated from the payments), so they can not drift apart. The items, prices, total and payments of
     the invoice are never touched by a delivery.
     An invoice without deliveries[] (every invoice made before this feature, and every sale delivered in full) is
     simply fully delivered. */

  const DELIVERY_EPSILON = 1e-6;
  const DELIVERY_TYPES = ["sale", "collection"];
  const DELIVERY_NOTE_MAX = 200;

  const isTracked = (inv) => isObj(inv) && Array.isArray(inv.deliveries);

  // Per item of the invoice: how much was sold, handed over so far and is still to collect (same unit as the sale).
  // status: "complete" (nothing left, or not tracked), "partial" (some handed over, some left), "pending" (nothing handed over yet).
  function deliveryDetail(inv) {
    const items = Array.isArray(inv && inv.items) ? inv.items : [];
    const tracked = isTracked(inv);
    const handed = new Map();
    if (tracked) {
      for (const d of inv.deliveries) {
        for (const l of isObj(d) && Array.isArray(d.lines) ? d.lines : []) {
          if (isObj(l)) handed.set(l.lineId, Calc.cleanNumber((handed.get(l.lineId) || 0) + toNumber(l.qty)));
        }
      }
    }
    const lines = items.map((item, index) => {
      const qty = toNumber(item && item.qty);
      const delivered = tracked ? Math.min(qty, handed.get(item && item.lineId) || 0) : qty;
      return { lineId: item && item.lineId ? item.lineId : null, index, item, qty, delivered, remaining: Math.max(0, Calc.cleanNumber(qty - delivered)) };
    });
    const toCollect = lines.filter((l) => l.remaining > DELIVERY_EPSILON);
    const anyDelivered = lines.some((l) => l.delivered > DELIVERY_EPSILON);
    const status = !toCollect.length ? "complete" : anyDelivered ? "partial" : "pending";
    return { tracked, lines, toCollect, status };
  }

  // The number of the collection document of an invoice: INV-000030 -> COL-000030. One per invoice, so it needs no counter.
  const collectionNumber = (inv) => "COL-" + String(inv.invoiceNumber).replace(/^INV-/, "");
  // The number of the n-th recorded pick-up (1, 2, ...) of an invoice: COL-000030-1.
  const receiptNumber = (inv, n) => collectionNumber(inv) + "-" + n;
  // Recorded pick-ups, oldest first, each with its receipt number.
  function collectionReceipts(inv) {
    if (!isTracked(inv)) return [];
    return inv.deliveries.filter((d) => d && d.type === "collection").map((d, i) => ({ ...d, number: receiptNumber(inv, i + 1) }));
  }

  // "" when the delivery log of an invoice is well formed and never hands over more than was sold.
  function deliveryProblem(inv) {
    if (inv.deliveries === undefined) return "";
    if (!Array.isArray(inv.deliveries)) return t("problem.badDeliveries");
    const byLine = new Map();
    for (const item of inv.items) {
      if (!isStr(item.lineId) || !item.lineId || byLine.has(item.lineId)) return t("problem.badDeliveries");
      byLine.set(item.lineId, item);
    }
    const handed = new Map();
    const seen = new Set();
    for (let n = 0; n < inv.deliveries.length; n++) {
      const d = inv.deliveries[n];
      if (!isObj(d) || !isStr(d.id) || !d.id || seen.has(d.id) || !DELIVERY_TYPES.includes(d.type) || !isDate(d.date) || !Array.isArray(d.lines) || !d.lines.length) return t("problem.badDeliveries");
      if (d.type === "sale" && n !== 0) return t("problem.badDeliveries");
      if (d.note !== undefined && (!isStr(d.note) || d.note.length > DELIVERY_NOTE_MAX)) return t("problem.badDeliveries");
      seen.add(d.id);
      for (const l of d.lines) {
        const item = isObj(l) ? byLine.get(l.lineId) : null;
        if (!item || !isNum(l.qty) || l.qty <= 0 || !isNum(l.stockDeducted) || l.stockDeducted < 0) return t("problem.badDeliveries");
        if (Calc.isWholeUnit(item.sellingUnit) && !Number.isInteger(l.qty)) return t("problem.badDeliveries");
        handed.set(l.lineId, Calc.cleanNumber((handed.get(l.lineId) || 0) + l.qty));
      }
    }
    for (const [lineId, qty] of handed) {
      if (qty > byLine.get(lineId).qty + DELIVERY_EPSILON) return t("problem.overDelivered");
    }
    return "";
  }

  // The delivery log only ever grows: a saved delivery is never edited or removed, an invoice never becomes tracked
  // after it was saved (its stock was taken out in full when it was sold), and the lines of a tracked invoice never change.
  function deliveryHistoryProblem(stored, next) {
    if (!isTracked(stored) && !isTracked(next)) return "";
    if (!isTracked(stored) || !isTracked(next)) return t("problem.deliveryHistory");
    const before = stored.deliveries;
    const after = next.deliveries;
    if (after.length < before.length || before.some((entry, i) => !sameValue(entry, after[i]))) return t("problem.deliveryHistory");
    const a = Array.isArray(stored.items) ? stored.items : [];
    const b = Array.isArray(next.items) ? next.items : [];
    if (a.length !== b.length || a.some((item, i) => item.lineId !== b[i].lineId || item.qty !== b[i].qty)) return t("problem.deliveryHistory");
    return "";
  }

  /* ---------- Validation of single records ---------- */

  // `sellingPrices` is optional (products saved before it existed do not have it). When it is there it must be a
  // valid list. The main price is still read from the older fields (`sellingPrice`, `priceUnit`, see Calc.getSellingPrices),
  // which the Stock form keeps equal to the list's first entry. They are not compared here, so a backup can always be
  // exported and restored.
  function sellingPricesProblem(p) {
    if (p.sellingPrices === undefined) return "";
    if (!Array.isArray(p.sellingPrices)) return t("problem.badPrices");
    if (p.sellingPrices.length === 0) return "";
    // a saved price is a number (the form turns what was typed into one before saving); text is not repaired
    if (p.sellingPrices.some((e) => !e || typeof e.price !== "number")) return t("problem.badPrices");
    const checked = Calc.checkSellingPrices(p.sellingPrices);
    if (checked.error) return checked.code === "duplicate" ? t("problem.dupPriceUnit") : t("problem.badPrices");
    return "";
  }

  function productProblem(p) {
    if (!isObj(p)) return t("problem.notObject");
    if (!isStr(p.id) || !p.id) return t("problem.noId");
    if (!isStr(p.name) || !p.name.trim()) return t("problem.noName");
    if (p.productType !== undefined && p.productType !== "" && !normalizeProductType(p.productType)) return t("problem.badProductType");
    if (p.manufacturer !== undefined && !isStr(p.manufacturer)) return t("problem.badManufacturer");
    if (p.tileSize !== undefined && (!isStr(p.tileSize) || (p.tileSize.trim() && !isTileSize(p.tileSize)))) return t("problem.badTileSize");
    if (p.coveragePerBox !== undefined && p.coveragePerBox !== null && (!isNum(p.coveragePerBox) || p.coveragePerBox <= 0)) return t("problem.badCoverage");
    if (!isNum(p.sellingPrice) || p.sellingPrice < 0) return t("problem.badPrice");
    if (p.priceUnit !== undefined && p.priceUnit !== null && !Calc.isUnit(p.priceUnit)) return t("problem.badPriceUnit");
    const listProblem = sellingPricesProblem(p);
    if (listProblem) return listProblem;
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
    // Optional second customer (older invoices do not have one): { name: string }.
    if (inv.secondCustomer !== undefined && (!isObj(inv.secondCustomer) || typeof inv.secondCustomer.name !== "string")) return t("problem.badSecondCustomer");
    if (inv.carriedForward !== undefined) {
      if (!Array.isArray(inv.carriedForward)) return t("problem.badCarried");
      const seenTransfers = new Set();
      for (const l of inv.carriedForward) {
        const ok = isObj(l) && isStr(l.transferId) && l.transferId && isStr(l.sourceInvoiceId) && l.sourceInvoiceId &&
          isStr(l.sourceInvoiceNumber) && /^INV-\d+$/.test(l.sourceInvoiceNumber) && isDate(l.sourceDate) && isNum(l.amount) && l.amount > 0;
        if (!ok || seenTransfers.has(l.transferId)) return t("problem.badCarried");
        if (l.sourceInvoiceId === inv.id) return t("problem.carriedSelf");
        seenTransfers.add(l.transferId);
      }
    }
    // Refunds (money handed back) and the cancellation of the whole sale: see "Cancelled sales and refunds".
    if (inv.refunds !== undefined) {
      if (!Array.isArray(inv.refunds)) return t("problem.badRefund");
      const seenRefunds = new Set();
      for (const r of inv.refunds) {
        if (!isObj(r) || !isStr(r.id) || !r.id || seenRefunds.has(r.id) || !isNum(r.amount) || r.amount <= 0 || !isDate(r.timestamp) || !REFUND_REASONS.includes(r.reason)) return t("problem.badRefund");
        seenRefunds.add(r.id);
      }
      if (refundedTotal(inv) > paidTotal(inv) + MONEY_TOLERANCE) return t("problem.refundTooMuch");
    }
    if (inv.cancellation !== undefined) {
      const c = inv.cancellation;
      if (!isObj(c) || !isDate(c.at) || ["total", "paid", "refund"].some((key) => !isNum(c[key]) || c[key] < 0)) return t("problem.badCancellation");
      const byCancellation = round2(refundsOf(inv).reduce((sum, r) => sum + (r.reason === "cancellation" ? r.amount : 0), 0));
      if (Math.abs(byCancellation - c.refund) > MONEY_TOLERANCE) return t("problem.badCancellation");
    }
    return deliveryProblem(inv);
  }

  // A cancelled invoice is a locked record: it stays cancelled, keeps what it sold and what it was worth, and keeps every refund it
  // made. Only more payments (for debt carried onto it) and more refunds may be added. `stored` is the saved copy, `next` the one
  // about to be saved; "" = fine. Checked by the database inside the transaction, so a second window can never cancel again.
  function cancellationHistoryProblem(stored, next) {
    if (!isCancelled(stored)) return "";
    const locked = !isCancelled(next) || !sameValue(stored.cancellation, next.cancellation) || !sameValue(stored.items, next.items) ||
      ["subtotal", "discount", "tax", "total"].some((key) => stored[key] !== next[key]);
    if (locked) return t("problem.cancelledLocked");
    const before = refundsOf(stored);
    const after = refundsOf(next);
    if (after.length < before.length || before.some((r, i) => !sameValue(r, after[i]))) return t("problem.cancelledLocked");
    return "";
  }

  // Money above what the invoice asks for is expected after an edit lowered the total of a paid invoice: that edit recorded the
  // refund it left due (and a later refund records the money that went back). Overpayment that no recorded edit explains is
  // still reported. `paid` is the money held for the invoice (payments less refunds).
  function overpaymentExplainedByEdit(inv, paid) {
    const edits = Array.isArray(inv.edits) ? inv.edits : [];
    const last = edits[edits.length - 1];
    // What is still held above the amount due can be at most what the edit said was due back (less what was refunded since).
    const excess = round2(paid - amountDue(inv));
    return Boolean(last) && isNum(last.refundDue) && excess >= -MONEY_TOLERANCE && excess <= last.refundDue + MONEY_TOLERANCE;
  }

  // Not rejected (older data may not follow today's arithmetic exactly), but always shown to the person
  // before a restore. The stored values are never changed to make them add up.
  function invoiceWarnings(inv) {
    if (!isObj(inv) || !isStr(inv.invoiceNumber)) return [];
    const warnings = [];
    const number = inv.invoiceNumber;
    const payments = Array.isArray(inv.payments) ? inv.payments : [];
    const paid = round2(payments.reduce((sum, p) => sum + toNumber(p && p.amount), 0));
    const held = round2(paid - refundedTotal(inv));   // payments less the money handed back
    if (isNum(inv.total) && held > amountDue(inv) + MONEY_TOLERANCE && !overpaymentExplainedByEdit(inv, held)) {
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
    if (s.phones !== undefined) {
      if (!Array.isArray(s.phones) || s.phones.length > MAX_BUSINESS_PHONES || s.phones.some((p) => !isStr(p) || p.length > MAX_PHONE_LENGTH)) return t("problem.phones", { max: MAX_BUSINESS_PHONES });
    }
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
    if (raw.sellingPrices !== undefined && raw.sellingPrices !== null) {
      if (!Array.isArray(raw.sellingPrices)) return t("problem.badPrices");
      if (raw.sellingPrices.length) {
        const checked = Calc.checkSellingPrices(raw.sellingPrices);
        if (checked.error) return checked.code === "duplicate" ? t("problem.dupPriceUnit") : t("problem.badPrices");
      }
    }
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
      const name = isObj(item) ? item.invoiceNumber || item.name || item.reference : "";
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
        if (kind === "purchase") warnings.push(...P.purchaseWarnings(item));
        out.push(lenient ? candidate : normalize(item));
      });
      return out;
    }

    let products = collect(raw.products, "product", t("problem.label.product"), legacyProductIssue, productProblem, normalizeProduct);
    let invoices = collect(raw.invoices, "invoice", t("problem.label.invoice"), legacyInvoiceIssue, invoiceProblem, normalizeInvoice);

    // The supplier side (purchases from suppliers). Older files and the old browser storage have none of it.
    const supplierSide = {};
    for (const key of SUPPLIER_LISTS) {
      if (raw[key] !== undefined && !Array.isArray(raw[key])) return { error: t("data.badList", { list: key }) };
      supplierSide[key] = raw[key] || [];
    }
    if (raw.purchaseCounter !== undefined && (!Number.isInteger(raw.purchaseCounter) || raw.purchaseCounter < 0)) return { error: t("data.badPurchaseCounter") };
    const none = () => "";
    const suppliers = collect(supplierSide.suppliers, "supplier", t("problem.label.supplier"), none, P.supplierProblem, P.normalizeSupplier);
    const purchases = collect(supplierSide.purchases, "purchase", t("problem.label.purchase"), none, P.purchaseProblem, P.normalizePurchase);
    const supplierPayments = collect(supplierSide.supplierPayments, "supplierPayment", t("problem.label.supplierPayment"), none, P.paymentProblem, P.normalizePayment);
    const attachments = collect(supplierSide.attachments, "attachment", t("problem.label.attachment"), none, P.attachmentProblem, (a) => a);

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
      for (const [list, kind] of [[suppliers, "supplier"], [purchases, "purchase"], [supplierPayments, "supplier payment"], [attachments, "attachment"]]) {
        const dup = firstDuplicate(list.map((r) => r.id));
        if (dup) return { error: t("data.dupRecord", { kind, id: dup }) };
      }
      // Every link must point at something that is in the file, and no number may be used twice.
      problems.push(...P.linkProblems({ suppliers, purchases, supplierPayments, attachments }));
    }

    // The debt-transfer ledger. Optional: data saved before debt could be carried forward has none. Whatever is
    // there must agree with the invoices (nothing owed twice), so a file that does not is refused, never repaired.
    const transfers = [];
    if (raw.debtTransfers !== undefined) {
      if (!Array.isArray(raw.debtTransfers)) return { error: t("data.badTransfers") };
      raw.debtTransfers.forEach((tr, i) => {
        const why = transferProblem(tr);
        if (why) {
          problems.push(t("problem.entry", { label: t("problem.label.transfer"), n: i + 1, why }));
          rejected.push({ kind: "transfer", index: i, reason: why, raw: tr });
        } else {
          transfers.push({ ...tr, amount: Number(tr.amount) });
        }
      });
      const dupTransfer = firstDuplicate(transfers.map((tr) => tr.id));
      if (dupTransfer && !lenient) return { error: t("data.dupTransfer", { id: dupTransfer }) };
    }
    problems.push(...ledgerProblems(invoices, transfers));

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
        // Only present when something was carried forward, so data without any debt transfer keeps its exact shape.
        ...(transfers.length ? { debtTransfers: transfers } : {}),
        settings: normalizeSettings(raw.settings),
        counter: Math.max(stored, highest),
        counterRecovered: highest > stored,
        lastSaved: isStr(raw.lastSaved) ? raw.lastSaved : "",
        suppliers,
        purchases,
        supplierPayments,
        attachments,
        // The purchase reference counter never goes backwards either.
        purchaseCounter: Math.max(Math.max(0, Math.floor(toNumber(raw.purchaseCounter))), P.highestReference(purchases)),
      },
    };
  }

  // True when a dataset holds something worth protecting (anything beyond a brand new, empty install).
  function hasMeaningfulData(data) {
    if (!data) return false;
    return (data.products && data.products.length > 0) ||
      (data.invoices && data.invoices.length > 0) ||
      (data.suppliers && data.suppliers.length > 0) ||
      (data.purchases && data.purchases.length > 0) ||
      (data.supplierPayments && data.supplierPayments.length > 0) ||
      toNumber(data.counter) > 0 ||
      toNumber(data.purchaseCounter) > 0 ||
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

  // The calculated fields written next to an invoice in a backup, for people reading the file. amountDue and
  // transferredOut are only added when debt was carried onto / away from the invoice, so other invoices look as before.
  function withDerived(inv, transfers) {
    const pay = paymentDetail(inv, transfers);
    const derived = { amountPaid: pay.paid, remaining: pay.remaining, status: pay.cls };
    if (pay.refunded > 0) derived.amountRefunded = pay.refunded;
    if (carriedLines(inv).length || isCancelled(inv)) derived.amountDue = pay.due;
    if (pay.transferredOut > 0) derived.transferredOut = pay.transferredOut;
    if (isTracked(inv)) derived.deliveryStatus = deliveryDetail(inv).status;
    return { ...inv, ...derived };
  }

  // How many records of each kind a snapshot or a parsed backup holds.
  function countsOf(data) {
    return {
      products: data.products.length, invoices: data.invoices.length,
      suppliers: (data.suppliers || []).length, purchases: (data.purchases || []).length,
      supplierPayments: (data.supplierPayments || []).length, attachments: (data.attachments || []).length,
    };
  }

  // The backup file. `snapshot` is what database.js reads: { products, invoices, settings, counter, suppliers,
  // purchases, supplierPayments, attachments, purchaseCounter }.
  // Customers and payments are saved inside each invoice, so there are no separate lists for them.
  // Purchases from suppliers, their payments and the scanned supplier invoices have lists of their own.
  // `revision` (the database revision the snapshot was read at) is optional and only written when the snapshot
  // has one. The automatic backup file uses it to know which state of the database the file holds.
  // Debt carried forward between invoices is saved as data.debtTransfers (only when there is any, inside the same
  // format version). A version that does not know the field ignores it, so a backup that carries debt should only be
  // restored into this version or a newer one.
  function buildBackup(snapshot, now) {
    const revision = Number.isInteger(snapshot.revision) && snapshot.revision >= 0 ? { revision: snapshot.revision } : {};
    const transfers = Array.isArray(snapshot.debtTransfers) ? snapshot.debtTransfers : [];
    return {
      application: APP_NAME,
      formatVersion: BACKUP_FORMAT_VERSION,
      exportedAt: (now || new Date()).toISOString(),
      ...revision,
      counts: countsOf(snapshot),
      data: {
        products: snapshot.products,
        invoices: snapshot.invoices.map((inv) => withDerived(inv, transfers)),
        ...(transfers.length ? { debtTransfers: transfers } : {}),
        settings: snapshot.settings,
        invoiceCounter: snapshot.counter,
        suppliers: snapshot.suppliers || [],
        purchases: snapshot.purchases || [],
        supplierPayments: snapshot.supplierPayments || [],
        attachments: snapshot.attachments || [],
        purchaseCounter: snapshot.purchaseCounter || 0,
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
    const wanted = countsOf(snapshot);
    const got = countsOf(check.data);
    const savedTransfers = Array.isArray(snapshot.debtTransfers) ? snapshot.debtTransfers.length : 0;
    if (Object.keys(wanted).some((key) => wanted[key] !== got[key]) || (check.data.debtTransfers || []).length !== savedTransfers) {
      return { error: t("backup.safetyFailed", { error: t("backup.safetyCounts") }) };
    }
    return { text, name: backupFileName(when, prefix), counts: wanted };
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
    let revision = null;
    if (raw.application !== undefined) {
      if (raw.application !== APP_NAME) return { error: t("backup.otherApp") };
      if (!Number.isInteger(raw.formatVersion) || raw.formatVersion < 1) return { error: t("backup.noFormat") };
      if (raw.formatVersion > BACKUP_FORMAT_VERSION) return { error: t("backup.newerFormat", { version: raw.formatVersion }) };
      if (!isObj(raw.data)) return { error: t("backup.noData") };
      // A format 2 file must carry the supplier lists (possibly empty); a format 1 file predates them.
      if (raw.formatVersion >= 2 && SUPPLIER_LISTS.some((key) => !Array.isArray(raw.data[key]))) return { error: t("backup.noSupplierData") };
      inner = {
        version: DATA_VERSION, products: raw.data.products, invoices: raw.data.invoices, settings: raw.data.settings, invoiceCounter: raw.data.invoiceCounter,
        suppliers: raw.data.suppliers, purchases: raw.data.purchases, supplierPayments: raw.data.supplierPayments, attachments: raw.data.attachments,
        purchaseCounter: raw.data.purchaseCounter, debtTransfers: raw.data.debtTransfers,
      };
      format = "backup";
      exportedAt = isDate(raw.exportedAt) ? raw.exportedAt : "";
      counts = isObj(raw.counts) ? raw.counts : null;
      revision = Number.isInteger(raw.revision) && raw.revision >= 0 ? raw.revision : null;
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
    if (counts) {
      const actual = countsOf(built.data);
      const wrong = counts.products !== actual.products || counts.invoices !== actual.invoices ||
        ["suppliers", "purchases", "supplierPayments", "attachments"].some((key) => counts[key] !== undefined && counts[key] !== actual[key]);
      if (wrong) return { error: t("backup.countsMismatch") };
    }
    const warnings = [...built.warnings];
    if (!exportedAt) warnings.push(t("warn.noExportDate"));
    return { format, exportedAt, revision, data: built.data, warnings };
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
    DEFAULT_SETTINGS, SELLING_UNITS, PRODUCT_TYPES, normalizeProductType, INVOICE_STATUSES, DERIVED_INVOICE_FIELDS, WALK_IN,
    isObj, isStr, isNum, isDate, round2, toNumber, uid, sameValue,
    formatInvoiceNumber, invoiceSequence, highestInvoiceNumber,
    carriedLines, paidTotal, carriedTotal, amountDue, refundDue, transferredOut, carriedBreakdown,
    isCancelled, refundsOf, refundedTotal, netPaid, REFUND_REASONS, cancellationHistoryProblem,
    isTracked, deliveryDetail, collectionNumber, receiptNumber, collectionReceipts, deliveryProblem, deliveryHistoryProblem, DELIVERY_EPSILON, DELIVERY_NOTE_MAX,
    normalizeName, phoneDigits, isWalkInName, customerKeys, customerGroups, findGroup, sameCustomer,
    transferProblem, ledgerProblems,
    MAX_BUSINESS_PHONES, MAX_PHONE_LENGTH, cleanPhoneList, businessPhones, businessSnapshot,
    isTileSize, normalizeTileSize, normalizeProduct, readProductInput, findDuplicateProduct, findSimilarProducts, suggestProducts, normalizeInvoice, normalizeSettings, paymentSummary, paymentDetail, stripDerived,
    productProblem, invoiceProblem, invoiceWarnings, settingsProblem, legacyProductIssue, legacyInvoiceIssue,
    buildData, hasMeaningfulData, countsOf, buildBackup, prepareBackupFile, parseBackup, backupFileName,
    readLegacyStorage, prepareLegacyCopy, backupReminder,
  };
})();

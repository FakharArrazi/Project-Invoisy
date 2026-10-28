"use strict";

/* ==========================================================================
   Purchases - suppliers, what is bought from them, the goods received and what is paid to them.

   Plain script (no modules, so index.html still works when opened directly). No DOM and no storage
   access: it only inspects, converts and calculates. Loaded after calc.js and before validation.js,
   which uses it to check backup files, and before database.js, which uses it to check every write.

   Every operation that changes data works on a COPY of the application data (a "draft", just like
   applySale() in script.js) and returns { error } or its result. The caller saves the draft with the
   existing commit() so the purchase, the stock and the payments are written in ONE transaction.

   Words used here
     purchase    goods bought from a supplier, recorded from the supplier's invoice. Never a customer sale.
     draft       a purchase that is saved but not confirmed. It never touches stock or balances.
     confirmed   the supplier's invoice is real: it is owed, and goods can be received.
     cancelled   a confirmed or draft purchase that was undone on purpose. Kept as history, counted nowhere.
     receipt     one delivery of goods. Stock goes up only when a receipt is applied, exactly once.
     payment     money paid to a supplier for ONE purchase. Never deleted: it can be corrected or voided.

   Money, quantities and stock use the same rules as the rest of Invoisy (calc.js).
   ========================================================================== */

(function () {
  const t = (key, params) => I18n.t(key, params);

  const round2 = Calc.roundMoney;
  const toNumber = Calc.toNumber;
  const cleanNumber = Calc.cleanNumber;

  const PURCHASE_STATUSES = ["draft", "confirmed", "cancelled"];
  const RECEIPT_STATUSES = ["applied", "reversed"];
  const PAYMENT_STATUSES = ["recorded", "voided"];
  const DISCOUNT_TYPES = ["amount", "percent"];
  const TAX_TYPES = ["none", "percent", "amount"];
  const TAX_MODES = ["added", "included"];
  const ATTACHMENT_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
  const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
  const REFERENCE_PREFIX = "PUR-";
  const MAX_TERMS_DAYS = 365;
  const MONEY_TOLERANCE = 0.01;
  const QTY_EPSILON = 1e-9;
  const MAX_TEXT = 2000;

  /* ---------- Small helpers ---------- */

  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const isStr = (v) => typeof v === "string";
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const isIso = (v) => isStr(v) && v !== "" && !isNaN(new Date(v));
  const isBlank = (v) => v === undefined || v === null || (isStr(v) && v.trim() === "");
  const text = (v) => (v === undefined || v === null ? "" : String(v));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  // A calendar day as text, "2026-10-09". Dates of invoices, due dates and payments are days, not moments,
  // so they never shift with the time zone.
  function isDay(v) {
    if (!isStr(v) || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    const d = new Date(v + "T00:00:00Z");
    return !isNaN(d) && d.toISOString().slice(0, 10) === v;
  }

  function toDay(date) {
    const d = date || new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function addDays(day, n) {
    const d = new Date(day + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  function daysBetween(fromDay, toDayText) {
    return Math.round((new Date(toDayText + "T00:00:00Z") - new Date(fromDay + "T00:00:00Z")) / 86400000);
  }

  // Lower case, no accents, single spaces: how names, phones and invoice numbers are compared.
  const normText = (s) => text(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
  const digitsOf = (s) => text(s).replace(/\D/g, "");
  const alnumOf = (s) => normText(s).replace(/[^a-z0-9]/g, "");

  // { value } | { blank: true } | { invalid: true }. Never turns an unreadable number into 0.
  function readNumber(raw) {
    if (typeof raw === "number") return Number.isFinite(raw) ? { value: raw } : { invalid: true };
    if (typeof raw === "boolean" || (raw !== undefined && raw !== null && !isStr(raw))) return { invalid: true };
    if (isBlank(raw)) return { blank: true };
    const n = Number(raw.trim());
    return Number.isFinite(n) ? { value: n } : { invalid: true };
  }

  const nowOf = (ctx) => (ctx && ctx.now) || new Date();
  const isoOf = (ctx) => nowOf(ctx).toISOString();
  const todayOf = (ctx) => (ctx && ctx.today) || toDay(nowOf(ctx));

  const unitName = (unit) => (Calc.isUnit(unit) ? Calc.unitLabel(unit) : "");
  // The unit as it reads next to a number ("138 boxes", "1 box"), following the language's plural rule.
  const unitFor = (unit, n) => (Calc.isUnit(unit) ? Calc.unitLabel(unit, n).toLowerCase() : "");

  // What an operation needs to know, taken from the data draft.
  function ctxOf(d, options) {
    const now = (options && options.now) || new Date();
    return {
      products: d.products || [],
      suppliers: d.suppliers || [],
      purchases: d.purchases || [],
      payments: d.supplierPayments || [],
      settings: d.settings || {},
      currency: ((d.settings && d.settings.currency) || "").trim(),
      now,
      today: (options && options.today) || toDay(now),
    };
  }

  /* ==========================================================================
     SUPPLIERS
     ========================================================================== */

  const SUPPLIER_TEXT_FIELDS = ["contactName", "phone", "email", "address", "city", "country", "taxId", "website", "currency", "notes"];
  const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  /* ---------- Supplier contacts ----------
     A supplier can have several contacts, each a name and a phone number: `contacts: [{ name, phone }]`. Either part may be
     blank (a name with no number yet, or just another number). The older single `contactName` and `phone` stay equal to the
     first contact, so everything that reads them keeps working. A supplier saved before the list existed has no `contacts`:
     it is read as one contact made of its old name and phone (supplierContacts), and nothing is rewritten until that supplier
     is saved again. */

  const MAX_CONTACTS = 20;

  function cleanContacts(list) {
    const out = [];
    for (const raw of Array.isArray(list) ? list : []) {
      if (!isObj(raw)) continue;
      const contact = { name: text(raw.name).trim(), phone: text(raw.phone).trim() };
      if (contact.name || contact.phone) out.push(contact);
    }
    return out;
  }

  // The contacts of a supplier, whichever way it was saved: [{ name, phone }], blank ones left out.
  function supplierContacts(supplier) {
    if (!isObj(supplier)) return [];
    if (Array.isArray(supplier.contacts)) return cleanContacts(supplier.contacts);
    return cleanContacts([{ name: supplier.contactName, phone: supplier.phone }]);
  }

  // The phone numbers of a supplier, each once ("0555-12-34-56" and "0555 12 34 56" are one number).
  function supplierPhones(supplier) {
    const seen = new Set();
    const phones = [];
    for (const c of supplierContacts(supplier)) {
      if (!c.phone) continue;
      const key = digitsOf(c.phone) || c.phone.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      phones.push(c.phone);
    }
    return phones;
  }

  // The names of the contact persons of a supplier, each once.
  const supplierContactNames = (supplier) => [...new Set(supplierContacts(supplier).map((c) => c.name).filter(Boolean))];

  // Fills in the fields a supplier may not have. A value that is present but unusable is replaced by the
  // default here, so callers check supplierProblem() BEFORE normalizing (a restore never repairs).
  function normalizeSupplier(raw) {
    if (!isObj(raw) || !isStr(raw.name) || !raw.name.trim()) return null;
    const terms = Number(raw.paymentTermsDays);
    const credit = isBlank(raw.creditLimit) ? null : Number(raw.creditLimit);
    const out = {
      ...raw,
      id: String(raw.id || uid()),
      name: raw.name.trim(),
      paymentTermsDays: Number.isInteger(terms) && terms >= 0 ? terms : 0,
      creditLimit: Number.isFinite(credit) && credit >= 0 ? credit : null,
      archived: raw.archived === true,
      archivedAt: raw.archived === true && isIso(raw.archivedAt) ? raw.archivedAt : null,
      createdAt: isIso(raw.createdAt) ? raw.createdAt : "",
      updatedAt: isIso(raw.updatedAt) ? raw.updatedAt : "",
      revision: Number.isInteger(raw.revision) && raw.revision >= 1 ? raw.revision : 1,
    };
    for (const key of SUPPLIER_TEXT_FIELDS) out[key] = text(raw[key]).trim();
    // The list is only there when it was saved: a supplier from before it existed keeps its exact shape.
    if (Array.isArray(raw.contacts)) out.contacts = cleanContacts(raw.contacts);
    return out;
  }

  function supplierProblem(s) {
    if (!isObj(s)) return t("problem.notObject");
    if (!isStr(s.id) || !s.id) return t("problem.noId");
    if (!isStr(s.name) || !s.name.trim()) return t("problem.noName");
    for (const key of SUPPLIER_TEXT_FIELDS) {
      if (s[key] !== undefined && (!isStr(s[key]) || s[key].length > MAX_TEXT)) return t("problem.badField", { field: key });
    }
    if (s.email && !EMAIL_PATTERN.test(s.email.trim())) return t("problem.badField", { field: "email" });
    if (s.contacts !== undefined) {
      if (!Array.isArray(s.contacts) || s.contacts.length > MAX_CONTACTS) return t("problem.badField", { field: "contacts" });
      if (s.contacts.some((c) => !isObj(c) || !isStr(c.name) || !isStr(c.phone) || c.name.length > MAX_TEXT || c.phone.length > MAX_TEXT)) return t("problem.badField", { field: "contacts" });
    }
    if (s.paymentTermsDays !== undefined && (!Number.isInteger(s.paymentTermsDays) || s.paymentTermsDays < 0 || s.paymentTermsDays > MAX_TERMS_DAYS)) return t("problem.badField", { field: "paymentTermsDays" });
    if (s.creditLimit !== undefined && s.creditLimit !== null && (!isNum(s.creditLimit) || s.creditLimit < 0)) return t("problem.badField", { field: "creditLimit" });
    if (s.archived !== undefined && typeof s.archived !== "boolean") return t("problem.badField", { field: "archived" });
    for (const key of ["archivedAt", "createdAt", "updatedAt"]) {
      if (s[key] !== undefined && s[key] !== null && s[key] !== "" && !isIso(s[key])) return t("problem.badField", { field: key });
    }
    if (s.revision !== undefined && (!Number.isInteger(s.revision) || s.revision < 1)) return t("problem.badField", { field: "revision" });
    return "";
  }

  // Suppliers that may be the same one: same name, same phone number or same tax number. Archived ones count.
  // This only WARNS; nothing is ever merged.
  function findSupplierDuplicates(suppliers, candidate, exceptId) {
    const name = normText(candidate.name);
    // Every phone number of the candidate against every phone number of the other supplier (a contact list or the old single phone).
    const phones = supplierPhones(candidate).map(digitsOf).filter((d) => d.length >= 6);
    const tax = alnumOf(candidate.taxId);
    const found = [];
    for (const s of suppliers) {
      if (s.id === exceptId) continue;
      const reasons = [];
      if (name && normText(s.name) === name) reasons.push("name");
      if (phones.length && supplierPhones(s).some((p) => phones.includes(digitsOf(p)))) reasons.push("phone");
      if (tax.length >= 3 && alnumOf(s.taxId) === tax) reasons.push("taxId");
      if (reasons.length) found.push({ supplier: s, reasons });
    }
    return found;
  }

  function readSupplierInput(input, ctx) {
    const get = (key) => text(input[key]).trim();
    const fail = (field, error) => ({ field, error });
    const name = get("name");
    if (!name) return fail("name", t("sup.err.nameRequired"));
    for (const key of SUPPLIER_TEXT_FIELDS) {
      if (get(key).length > MAX_TEXT) return fail(key, t("sup.err.tooLong"));
    }
    // The contacts: a list from the form, or (older callers) the single contactName and phone.
    const listed = Array.isArray(input.contacts);
    const contacts = cleanContacts(listed ? input.contacts : [{ name: input.contactName, phone: input.phone }]);
    if (contacts.length > MAX_CONTACTS) return fail("contacts", t("sup.err.tooManyContacts", { max: MAX_CONTACTS }));
    if (contacts.some((c) => c.name.length > MAX_TEXT || c.phone.length > MAX_TEXT)) return fail("contacts", t("sup.err.tooLong"));
    const email = get("email");
    if (email && !EMAIL_PATTERN.test(email)) return fail("email", t("sup.err.email"));
    const website = get("website");
    if (/\s/.test(website)) return fail("website", t("sup.err.website"));

    let paymentTermsDays = 0;
    const terms = readNumber(input.paymentTermsDays);
    if (!terms.blank) {
      if (terms.invalid || !Number.isInteger(terms.value) || terms.value < 0 || terms.value > MAX_TERMS_DAYS) return fail("paymentTermsDays", t("sup.err.terms", { max: MAX_TERMS_DAYS }));
      paymentTermsDays = terms.value;
    }
    let creditLimit = null;
    const credit = readNumber(input.creditLimit);
    if (!credit.blank) {
      if (credit.invalid || credit.value < 0) return fail("creditLimit", t("sup.err.credit"));
      creditLimit = credit.value;
    }
    return {
      values: {
        // contactName and phone always follow the first contact, so older readers see the main contact.
        name, contactName: contacts.length ? contacts[0].name : "", phone: contacts.length ? contacts[0].phone : "",
        ...(listed ? { contacts } : {}),
        email, address: get("address"), city: get("city"),
        country: get("country"), taxId: get("taxId"), website, paymentTermsDays, creditLimit, notes: text(input.notes).trim(),
      },
    };
  }

  // Creates or updates a supplier on the draft `d`.
  //   options.allowDuplicate : save even when a supplier with the same name, phone or tax number exists
  // { supplier } | { error, field } | { duplicates, skip: true } (the person has to confirm first)
  function saveSupplier(d, input, options) {
    const ctx = ctxOf(d, options);
    const read = readSupplierInput(input || {}, ctx);
    if (read.error) return read;
    const existing = input.id ? ctx.suppliers.find((s) => s.id === input.id) : null;
    if (input.id && !existing) return { error: t("sup.err.gone") };
    const duplicates = findSupplierDuplicates(ctx.suppliers, read.values, existing && existing.id);
    if (duplicates.length && !(options && options.allowDuplicate)) return { duplicates, skip: true };

    const at = isoOf(ctx);
    if (existing) {
      const values = { ...read.values };
      // An edit that only knows the single contact (not the list) keeps the supplier's list in line with it.
      if (!values.contacts && Array.isArray(existing.contacts)) values.contacts = cleanContacts([{ name: values.contactName, phone: values.phone }]);
      Object.assign(existing, values, { updatedAt: at, revision: (existing.revision || 1) + 1 });
      return { supplier: existing };
    }
    const supplier = normalizeSupplier({
      id: uid(), ...read.values, currency: ctx.currency, archived: false, createdAt: at, updatedAt: at, revision: 1,
    });
    if (!d.suppliers) d.suppliers = [];
    d.suppliers.push(supplier);
    return { supplier };
  }

  function setSupplierArchived(d, id, archived) {
    const supplier = (d.suppliers || []).find((s) => s.id === id);
    if (!supplier) return { error: t("sup.err.gone") };
    if (supplier.archived === Boolean(archived)) return { skip: true, supplier };
    const at = new Date().toISOString();
    supplier.archived = Boolean(archived);
    supplier.archivedAt = archived ? at : null;
    supplier.updatedAt = at;
    supplier.revision = (supplier.revision || 1) + 1;
    return { supplier };
  }

  function supplierHasHistory(d, id) {
    return (d.purchases || []).some((p) => p.supplierId === id) || (d.supplierPayments || []).some((p) => p.supplierId === id);
  }

  // A supplier that never had a purchase or a payment may be deleted. Any other supplier is archived instead,
  // so the history of what was bought and paid is never lost.
  function deleteSupplier(d, id) {
    const supplier = (d.suppliers || []).find((s) => s.id === id);
    if (!supplier) return { error: t("sup.err.gone") };
    if (supplierHasHistory(d, id)) return { error: t("sup.err.hasHistory", { name: supplier.name }) };
    d.suppliers = d.suppliers.filter((s) => s.id !== id);
    return { supplier };
  }

  /* ==========================================================================
     PURCHASE CALCULATIONS
     ========================================================================== */

  const lineGross = (line) => round2(toNumber(line.qty) * toNumber(line.unitPrice));
  const lineTotalOf = (line) => Math.max(0, round2(lineGross(line) - toNumber(line.discount)));
  const lineBaseQty = (line) => cleanNumber(toNumber(line.qty) * toNumber(line.factor));

  function discountAmount(type, value, base) {
    const v = toNumber(value);
    if (v <= 0) return 0;
    return round2(type === "percent" ? (base * Math.min(v, 100)) / 100 : v);
  }

  // Tax of a purchase. "added": the tax is on top of the goods. "included": the supplier's prices already
  // contain it, so it is only shown and does not change the total. A percentage applies to the goods after
  // the invoice discount (not to delivery or other costs); use a fixed amount for any other treatment.
  function taxAmount(type, value, mode, base) {
    const v = toNumber(value);
    if (type === "none" || v <= 0) return 0;
    if (type === "amount") return round2(v);
    return round2(mode === "included" ? (base * v) / (100 + v) : (base * v) / 100);
  }

  // subtotal, discount, tax and total of a purchase, always worked out from its lines and adjustments.
  function computeTotals(p) {
    const lines = Array.isArray(p.lines) ? p.lines : [];
    const subtotal = round2(lines.reduce((sum, l) => sum + lineTotalOf(l), 0));
    const discount = Math.min(discountAmount(p.discountType, p.discountValue, subtotal), subtotal);
    const goods = round2(subtotal - discount);
    const tax = taxAmount(p.taxType, p.taxValue, p.taxMode, goods);
    const delivery = round2(Math.max(0, toNumber(p.delivery)));
    const otherCosts = round2(Math.max(0, toNumber(p.otherCosts)));
    const added = p.taxMode === "included" ? 0 : tax;
    const total = Math.max(0, round2(goods + added + delivery + otherCosts));
    return { subtotal, discount, goods, tax, delivery, otherCosts, total };
  }

  /* ==========================================================================
     PURCHASE: reading the form, checking it, building the record
     ========================================================================== */

  // How many stock units are in ONE purchase unit, worked out from the product itself (its tile size, its saved
  // coverage per box and its stock unit). Nothing is typed and nothing is guessed: when the product does not hold
  // what the conversion needs, { error } says which information is missing. The value is NOT rounded, so 207.36 m²
  // at 1.44 m² a box is exactly 144 boxes.
  function autoFactor(spec, unit, stockUnit) {
    if (!Calc.isUnit(stockUnit)) return { value: 1 };   // an old product with no stock unit counts one-for-one
    if (unit === stockUnit) return { value: 1 };
    return Calc.getUnitFactor(spec, unit, stockUnit);
  }

  // A product made while recording a purchase is checked by the same function as the Stock form (validation.js):
  // same fields, same rules, same duplicate check. `products` is the catalogue plus the products made by earlier lines of
  // this purchase. Its stock starts at 0: the goods received add to it, once, when they are received (confirmPurchase).
  function readNewProduct(raw, products, fail) {
    const checked = Validation.readProductInput(raw, { products, stockFromPurchase: true });
    if (checked.error) return fail(checked.field, checked.error, { priceIndex: checked.index });
    return checked.values;
  }

  function readLines(rawLines, ctx, mode, errors) {
    const lines = [];
    const known = [...ctx.products];   // the catalogue, and each new product as its line is read, so two lines can not repeat one
    (Array.isArray(rawLines) ? rawLines : []).forEach((raw, index) => {
      const fail = (field, message, extra) => { errors.push({ field: `line.${index}.${field}`, message, line: index, ...extra }); return null; };
      const row = isObj(raw) ? raw : {};
      const id = isStr(row.id) && row.id ? row.id : uid();

      let product = null;
      let newProduct = null;
      let productId = isStr(row.productId) ? row.productId : "";
      if (isObj(row.newProduct)) {
        newProduct = readNewProduct(row.newProduct, known, (field, message, extra) => fail("newProduct." + field, message, extra));
        if (!newProduct) return;
        // The id is chosen now so the line keeps pointing at the same product after the purchase is confirmed.
        if (!productId || ctx.products.some((p) => p.id === productId)) productId = uid();
        known.push({ ...newProduct, id: productId });
      } else {
        product = ctx.products.find((p) => p.id === productId);
        if (!product) {
          // A saved line whose product has been deleted since: say which one, instead of asking to choose.
          fail("productId", productId && row.productName ? t("pur.err.productGone", { name: row.productName }) : t("pur.err.chooseProduct"));
          return;
        }
      }
      const spec = newProduct || product;
      const stockUnit = Calc.isUnit(spec.stockUnit) ? spec.stockUnit : null;
      if (row.expectStockUnit !== undefined && (row.expectStockUnit || null) !== stockUnit) {
        fail("productId", t("pur.err.productChanged", { name: spec.name }));
        return;
      }

      const unit = Calc.normalizeUnit(row.unit);
      if (!unit) { fail("unit", t("pur.err.chooseUnit")); return; }

      let qty = 0;
      if (isBlank(row.qty) && mode === "draft") qty = 0;
      else {
        const checked = Calc.validateQuantity(row.qty, unit);
        if (checked.error) fail("qty", checked.error);
        else qty = checked.value;
      }

      // The quantity is the quantity BOUGHT, in the unit it was bought in. What it adds to stock is always worked out
      // from the product's own saved information (never typed, never a hardcoded coverage), so a purchase by m² of a
      // product counted in boxes becomes a number of boxes. When that can not be done reliably the line is refused
      // and the message names what the product is missing.
      let factor = null;
      const auto = autoFactor(spec, unit, stockUnit);
      if (auto.error) {
        fail("unit", t("pur.err.cannotConvert", { name: spec.name, unit: unitFor(unit, 2), stock: unitFor(stockUnit, 2), reason: auto.error }));
      } else factor = auto.value;

      let baseQty = 0;
      if (qty > 0 && factor) {
        baseQty = cleanNumber(qty * factor);
        if (Calc.isWholeUnit(stockUnit)) {
          const whole = Math.round(baseQty);
          if (Math.abs(baseQty - whole) <= 1e-6) baseQty = whole;
          else {
            const lower = Math.floor(baseQty);
            const area = (n) => cleanNumber(n / factor);
            const nearest = (n) => `${n} ${unitFor(stockUnit, n)} = ${area(n)} ${unitFor(unit, area(n))}`;
            const shown = cleanNumber(Math.round(baseQty * 1000) / 1000);
            fail("qty", t("pur.err.wholeStock", {
              name: spec.name, qty: shown, unit: unitFor(stockUnit, shown),
              options: lower >= 1 ? `${nearest(lower)} / ${nearest(lower + 1)}` : nearest(lower + 1),
            }));
          }
        }
      }

      let unitPrice = 0;
      const price = readNumber(row.unitPrice);
      if (price.blank) { if (mode !== "draft") fail("unitPrice", t("pur.err.priceRequired")); }
      else if (price.invalid || price.value < 0) fail("unitPrice", t("pur.err.priceNegative"));
      else unitPrice = price.value;

      let discount = 0;
      const disc = readNumber(row.discount);
      if (!disc.blank) {
        if (disc.invalid || disc.value < 0) fail("discount", t("pur.err.lineDiscount"));
        else if (disc.value > lineGross({ qty, unitPrice }) + MONEY_TOLERANCE) fail("discount", t("pur.err.lineDiscountBig"));
        else discount = round2(disc.value);
      }

      const line = {
        id, productId, productName: spec.name, tileSize: text(spec.tileSize), sku: text(spec.sku),
        newProduct, qty, unit, factor: factor || 1, stockUnit, baseQty, unitPrice, discount, lineTotal: 0, notes: text(row.notes).trim(),
      };
      line.lineTotal = lineTotalOf(line);
      lines.push(line);
    });
    return lines;
  }

  // A purchase that is already saved, as the form values it was made from (used to check it again at confirm time).
  function purchaseToInput(p) {
    return {
      ...p,
      lines: p.lines.map((l) => ({ ...l, expectStockUnit: l.stockUnit || null, newProduct: l.newProduct ? { ...l.newProduct } : null })),
    };
  }

  function duplicateInvoice(purchases, supplierId, number, exceptId) {
    const key = normText(number);
    if (!key) return null;
    return purchases.find((p) => p.id !== exceptId && p.supplierId === supplierId && p.status !== "cancelled" && !p.noSupplierInvoice && normText(p.supplierInvoiceNumber) === key) || null;
  }

  function duplicateReference(purchases, reference, exceptId) {
    const key = normText(reference);
    if (!key) return null;
    return purchases.find((p) => p.id !== exceptId && p.status !== "cancelled" && normText(p.reference) === key) || null;
  }

  // The same reading and checking as saving, for showing live totals while a form is being filled in.
  // Nothing is saved or changed. { purchase, errors }
  function previewPurchase(d, input, mode, options) {
    return composePurchase(input || {}, ctxOf(d, options), mode || "draft");
  }

  // Reads and checks the values of a purchase.
  //   mode "draft"   : saving a draft. Needs a supplier and valid values, but may be unfinished.
  //   mode "confirm" : the purchase must be complete.
  // { purchase, errors } where each error is { field, message, line? }. The purchase is only usable without errors.
  function composePurchase(input, ctx, mode) {
    const errors = [];
    const fail = (field, message) => errors.push({ field, message });
    const confirming = mode === "confirm";
    const existing = input.id ? ctx.purchases.find((p) => p.id === input.id) : null;

    const supplier = ctx.suppliers.find((s) => s.id === input.supplierId);
    if (!supplier) fail("supplierId", t("pur.err.chooseSupplier"));
    else if (supplier.archived) fail("supplierId", t("pur.err.supplierArchived", { name: supplier.name }));

    const invoiceDate = text(input.invoiceDate).trim();
    if (!isDay(invoiceDate)) fail("invoiceDate", t("pur.err.invoiceDate"));

    let dueDate = text(input.dueDate).trim();
    if (!dueDate && supplier && isDay(invoiceDate)) dueDate = addDays(invoiceDate, supplier.paymentTermsDays || 0);
    if (dueDate && !isDay(dueDate)) fail("dueDate", t("pur.err.dueDate"));
    else if (dueDate && isDay(invoiceDate) && dueDate < invoiceDate) fail("dueDate", t("pur.err.dueBeforeInvoice"));

    const noSupplierInvoice = input.noSupplierInvoice === true;
    const supplierInvoiceNumber = noSupplierInvoice ? "" : text(input.supplierInvoiceNumber).trim();
    if (supplierInvoiceNumber.length > 100) fail("supplierInvoiceNumber", t("sup.err.tooLong"));
    if (!noSupplierInvoice && confirming && !supplierInvoiceNumber) fail("supplierInvoiceNumber", t("pur.err.invoiceNumber"));
    if (supplier && supplierInvoiceNumber) {
      const clash = duplicateInvoice(ctx.purchases, supplier.id, supplierInvoiceNumber, existing && existing.id);
      if (clash) fail("supplierInvoiceNumber", t("pur.err.dupInvoice", { number: supplierInvoiceNumber, supplier: supplier.name, reference: clash.reference }));
    }

    const reference = text(input.reference).trim();
    if (reference.length > 100) fail("reference", t("sup.err.tooLong"));
    const refClash = reference ? duplicateReference(ctx.purchases, reference, existing && existing.id) : null;
    if (refClash) fail("reference", t("pur.err.dupReference", { reference }));

    const lines = readLines(input.lines, ctx, mode, errors);
    if (confirming && (!Array.isArray(input.lines) || input.lines.length === 0)) fail("lines", t("pur.err.noLines"));

    // Invoice-level discount, tax and extra costs.
    const discountType = DISCOUNT_TYPES.includes(input.discountType) ? input.discountType : "amount";
    const taxType = TAX_TYPES.includes(input.taxType) ? input.taxType : "none";
    const taxMode = TAX_MODES.includes(input.taxMode) ? input.taxMode : "added";
    const amountField = (field, raw, message) => {
      const n = readNumber(raw);
      if (n.blank) return 0;
      if (n.invalid || n.value < 0) { fail(field, message); return 0; }
      return n.value;
    };
    const discountValue = amountField("discountValue", input.discountValue, t("pur.err.discountNegative"));
    const taxValue = amountField("taxValue", input.taxValue, t("pur.err.taxNegative"));
    const delivery = amountField("delivery", input.delivery, t("pur.err.costNegative"));
    const otherCosts = amountField("otherCosts", input.otherCosts, t("pur.err.costNegative"));
    if (discountType === "percent" && discountValue > 100) fail("discountValue", t("pur.err.discountPercent"));
    if (taxType === "percent" && taxValue > 100) fail("taxValue", t("pur.err.taxPercent"));

    const base = { lines, discountType, discountValue, taxType, taxValue, taxMode, delivery, otherCosts };
    const totals = computeTotals(base);
    if (discountType === "amount" && discountValue > totals.subtotal + MONEY_TOLERANCE) fail("discountValue", t("pur.err.discountTooBig"));
    if (taxType === "amount" && taxMode === "included" && taxValue > totals.goods + MONEY_TOLERANCE) fail("taxValue", t("pur.err.taxTooBig"));

    // The amount paid with the invoice. Empty means nothing was paid (never "paid in full").
    let initialPayment = null;
    const ip = isObj(input.initialPayment) ? input.initialPayment : null;
    if (ip && !isBlank(ip.amount)) {
      const amount = readNumber(ip.amount);
      if (amount.invalid || amount.value < 0) fail("initialPayment.amount", t("spay.err.negative"));
      else if (amount.value > 0) {
        const date = isBlank(ip.date) ? ctx.today : text(ip.date).trim();
        if (confirming && round2(amount.value) > totals.total + MONEY_TOLERANCE) fail("initialPayment.amount", t("spay.err.tooMuch", { max: String(totals.total) }));
        else if (!isDay(date)) fail("initialPayment.date", t("spay.err.date"));
        else if (date > ctx.today) fail("initialPayment.date", t("spay.err.future"));
        else initialPayment = { amount: round2(amount.value), date, reference: text(ip.reference).trim() };
      }
    }

    const notes = text(input.notes).trim();
    if (notes.length > MAX_TEXT) fail("notes", t("sup.err.tooLong"));

    const attachments = Array.isArray(input.attachments) ? input.attachments : (existing && Array.isArray(existing.attachments) ? existing.attachments : []);
    for (const a of attachments) {
      const why = attachmentMetaProblem(a);
      if (why) fail("attachments", why);
    }

    const purchase = {
      id: existing ? existing.id : (isStr(input.id) && input.id ? input.id : uid()),
      reference, supplierId: supplier ? supplier.id : text(input.supplierId),
      supplierInvoiceNumber, noSupplierInvoice, invoiceDate, dueDate, notes,
      currency: existing && existing.currency ? existing.currency : ctx.currency,
      status: "draft",
      lines, discountType, discountValue, taxType, taxValue, taxMode, delivery, otherCosts,
      subtotal: totals.subtotal, discount: totals.discount, tax: totals.tax, total: totals.total,
      initialPayment, receipts: [], attachments: attachments.map((a) => ({ ...a })), log: [],
    };
    return { purchase, errors };
  }

  /* ==========================================================================
     PURCHASE: records, checks
     ========================================================================== */

  function referenceSequence(reference) {
    const m = String(reference || "").match(/^PUR-(\d+)$/i);
    return m ? parseInt(m[1], 10) : 0;
  }

  const formatReference = (n) => REFERENCE_PREFIX + String(n).padStart(6, "0");

  function highestReference(purchases) {
    return (purchases || []).reduce((max, p) => Math.max(max, referenceSequence(p.reference)), 0);
  }

  function normalizeLine(raw) {
    const l = isObj(raw) ? raw : {};
    return {
      ...l,
      id: String(l.id || uid()), productId: text(l.productId), productName: text(l.productName), tileSize: text(l.tileSize), sku: text(l.sku),
      newProduct: isObj(l.newProduct) ? { ...l.newProduct } : null,
      qty: toNumber(l.qty), unit: l.unit, factor: isNum(l.factor) ? l.factor : 1, stockUnit: Calc.isUnit(l.stockUnit) ? l.stockUnit : null,
      baseQty: toNumber(l.baseQty), unitPrice: toNumber(l.unitPrice), discount: toNumber(l.discount), lineTotal: toNumber(l.lineTotal), notes: text(l.notes),
    };
  }

  function normalizePurchase(raw) {
    if (!isObj(raw)) return null;
    const num = (v) => { const n = readNumber(v); return n.value !== undefined ? n.value : 0; };
    return {
      ...raw,
      id: String(raw.id || uid()),
      reference: text(raw.reference).trim(),
      supplierId: text(raw.supplierId),
      supplierInvoiceNumber: text(raw.supplierInvoiceNumber).trim(),
      noSupplierInvoice: raw.noSupplierInvoice === true,
      invoiceDate: text(raw.invoiceDate), dueDate: text(raw.dueDate), notes: text(raw.notes), currency: text(raw.currency),
      status: raw.status,
      lines: (Array.isArray(raw.lines) ? raw.lines : []).map(normalizeLine),
      discountType: DISCOUNT_TYPES.includes(raw.discountType) ? raw.discountType : "amount", discountValue: num(raw.discountValue),
      taxType: TAX_TYPES.includes(raw.taxType) ? raw.taxType : "none", taxValue: num(raw.taxValue),
      taxMode: TAX_MODES.includes(raw.taxMode) ? raw.taxMode : "added",
      delivery: num(raw.delivery), otherCosts: num(raw.otherCosts),
      subtotal: num(raw.subtotal), discount: num(raw.discount), tax: num(raw.tax), total: num(raw.total),
      initialPayment: isObj(raw.initialPayment) ? { ...raw.initialPayment } : null,
      receipts: Array.isArray(raw.receipts) ? raw.receipts.map((r) => ({ ...r, lines: Array.isArray(r.lines) ? r.lines.map((x) => ({ ...x })) : [] })) : [],
      attachments: Array.isArray(raw.attachments) ? raw.attachments.map((a) => ({ ...a })) : [],
      log: Array.isArray(raw.log) ? raw.log.map((e) => ({ ...e })) : [],
      createdAt: text(raw.createdAt), updatedAt: text(raw.updatedAt),
      revision: Number.isInteger(raw.revision) && raw.revision >= 1 ? raw.revision : 1,
    };
  }

  function attachmentMetaProblem(a) {
    if (!isObj(a) || !isStr(a.id) || !a.id) return t("pur.err.attachmentBad");
    if (!isStr(a.name) || !a.name.trim() || a.name.length > 255) return t("pur.err.attachmentBad");
    if (!ATTACHMENT_TYPES.includes(a.type)) return t("pur.err.attachmentType");
    if (!isNum(a.size) || a.size < 0 || a.size > ATTACHMENT_MAX_BYTES) return t("pur.err.attachmentSize", { mb: String(ATTACHMENT_MAX_BYTES / 1048576) });
    return "";
  }

  // The stored file itself: the data lives in its own store, so the purchases stay small to load.
  function attachmentProblem(a) {
    const why = attachmentMetaProblem(a);
    if (why) return why;
    if (!isStr(a.purchaseId) || !a.purchaseId) return t("pur.err.attachmentBad");
    if (!isStr(a.dataUrl) || !a.dataUrl.startsWith("data:")) return t("pur.err.attachmentBad");
    return "";
  }

  const attachmentMeta = (a) => ({ id: a.id, name: a.name, type: a.type, size: a.size, addedAt: a.addedAt || "" });

  function lineProblem(l, draft) {
    if (!isObj(l)) return t("problem.notObject");
    if (!isStr(l.id) || !l.id) return t("problem.noId");
    if (!isStr(l.productId) || !l.productId) return t("problem.badLine");
    if (!isNum(l.qty) || l.qty < 0 || (!draft && l.qty <= 0)) return t("problem.badLine");
    if (!Calc.isUnit(l.unit)) return t("problem.badLine");
    if (!isNum(l.factor) || l.factor <= 0) return t("problem.badLine");
    if (l.stockUnit !== undefined && l.stockUnit !== null && !Calc.isUnit(l.stockUnit)) return t("problem.badLine");
    if (!isNum(l.baseQty) || l.baseQty < 0) return t("problem.badLine");
    if (!isNum(l.unitPrice) || l.unitPrice < 0) return t("problem.badLine");
    if (!isNum(l.discount) || l.discount < 0) return t("problem.badLine");
    if (!isNum(l.lineTotal) || l.lineTotal < 0) return t("problem.badLine");
    if (l.newProduct !== undefined && l.newProduct !== null && !isObj(l.newProduct)) return t("problem.badLine");
    return "";
  }

  function receiptProblem(r, lineIds) {
    if (!isObj(r)) return t("problem.badReceipt");
    if (!isStr(r.id) || !r.id) return t("problem.badReceipt");
    if (!RECEIPT_STATUSES.includes(r.status)) return t("problem.badReceipt");
    if (!isIso(r.at) || !isDay(r.date)) return t("problem.badReceipt");
    if (!Array.isArray(r.lines) || r.lines.length === 0) return t("problem.badReceipt");
    for (const x of r.lines) {
      if (!isObj(x) || !lineIds.has(x.lineId) || !isNum(x.qty) || x.qty <= 0 || !isNum(x.baseQty) || x.baseQty <= 0) return t("problem.badReceipt");
    }
    if (r.status === "reversed" && (!isIso(r.reversedAt) || isBlank(r.reversalReason))) return t("problem.badReceipt");
    return "";
  }

  // The shape and rules of a saved purchase (what the database checks before every write and a restore checks).
  function purchaseProblem(p) {
    if (!isObj(p)) return t("problem.notObject");
    if (!isStr(p.id) || !p.id) return t("problem.noId");
    if (!isStr(p.supplierId) || !p.supplierId) return t("problem.badSupplierLink");
    if (!PURCHASE_STATUSES.includes(p.status)) return t("problem.badStatus");
    const draft = p.status === "draft";
    if (!isStr(p.reference) || !p.reference.trim()) return t("problem.badReference");
    if (p.supplierInvoiceNumber !== undefined && !isStr(p.supplierInvoiceNumber)) return t("problem.badInvoiceNumber");
    if (p.noSupplierInvoice !== undefined && typeof p.noSupplierInvoice !== "boolean") return t("problem.badInvoiceNumber");
    if (p.noSupplierInvoice && p.supplierInvoiceNumber) return t("problem.badInvoiceNumber");
    if (!draft && !p.noSupplierInvoice && isBlank(p.supplierInvoiceNumber)) return t("problem.badInvoiceNumber");
    if (!isDay(p.invoiceDate)) return t("problem.badDate");
    if (p.dueDate !== undefined && p.dueDate !== "" && !isDay(p.dueDate)) return t("problem.badDate");
    for (const key of ["notes", "currency"]) {
      if (p[key] !== undefined && !isStr(p[key])) return t("problem.badField", { field: key });
    }
    if (!Array.isArray(p.lines)) return t("problem.badLine");
    if (!draft && p.lines.length === 0) return t("problem.badLine");
    for (const l of p.lines) {
      const why = lineProblem(l, draft);
      if (why) return why;
    }
    if (new Set(p.lines.map((l) => l.id)).size !== p.lines.length) return t("problem.badLine");
    if (p.discountType !== undefined && !DISCOUNT_TYPES.includes(p.discountType)) return t("problem.badAmount");
    if (p.taxType !== undefined && !TAX_TYPES.includes(p.taxType)) return t("problem.badAmount");
    if (p.taxMode !== undefined && !TAX_MODES.includes(p.taxMode)) return t("problem.badAmount");
    for (const key of ["discountValue", "taxValue", "delivery", "otherCosts", "subtotal", "discount", "tax", "total"]) {
      if (p[key] !== undefined && (!isNum(p[key]) || p[key] < 0)) return t("problem.badAmount");
    }
    if (!isNum(p.total)) return t("problem.badAmount");
    const lineIds = new Set(p.lines.map((l) => l.id));
    const receipts = p.receipts === undefined ? [] : p.receipts;
    if (!Array.isArray(receipts)) return t("problem.badReceipt");
    if (draft && receipts.length) return t("problem.badReceipt");
    for (const r of receipts) {
      const why = receiptProblem(r, lineIds);
      if (why) return why;
    }
    if (new Set(receipts.map((r) => r.id)).size !== receipts.length) return t("problem.badReceipt");
    for (const l of p.lines) {
      const got = receipts.filter((r) => r.status === "applied").reduce((sum, r) => sum + r.lines.filter((x) => x.lineId === l.id).reduce((s, x) => s + x.qty, 0), 0);
      if (got > l.qty + 1e-6) return t("problem.badReceipt");
    }
    if (p.attachments !== undefined) {
      if (!Array.isArray(p.attachments)) return t("pur.err.attachmentBad");
      for (const a of p.attachments) {
        const why = attachmentMetaProblem(a);
        if (why) return why;
      }
    }
    if (p.log !== undefined && (!Array.isArray(p.log) || p.log.some((e) => !isObj(e) || !isIso(e.at) || !isStr(e.event)))) return t("problem.badLog");
    for (const key of ["createdAt", "updatedAt", "confirmedAt", "cancelledAt"]) {
      if (p[key] !== undefined && p[key] !== null && p[key] !== "" && !isIso(p[key])) return t("problem.badField", { field: key });
    }
    if (!draft && !isIso(p.confirmedAt) && p.status === "confirmed") return t("problem.badField", { field: "confirmedAt" });
    if (p.status === "cancelled" && (!isIso(p.cancelledAt) || isBlank(p.cancelReason))) return t("problem.badField", { field: "cancelledAt" });
    if (p.initialPayment !== undefined && p.initialPayment !== null) {
      const ip = p.initialPayment;
      if (!isObj(ip) || !isNum(ip.amount) || ip.amount <= 0 || !isDay(ip.date)) return t("problem.badPayment");
    }
    if (p.revision !== undefined && (!Number.isInteger(p.revision) || p.revision < 1)) return t("problem.badField", { field: "revision" });
    return "";
  }

  // Not rejected, but always shown before a restore: the stored figures are never changed to make them add up.
  function purchaseWarnings(p) {
    if (!isObj(p) || !Array.isArray(p.lines)) return [];
    const ref = p.reference || p.id;
    const warnings = [];
    if (p.lines.some((l) => isNum(l.qty) && isNum(l.unitPrice) && isNum(l.discount) && Math.abs(lineTotalOf(l) - toNumber(l.lineTotal)) > MONEY_TOLERANCE)) {
      warnings.push(t("warn.purchaseLineMismatch", { ref }));
    }
    if (p.status !== "draft" && Math.abs(computeTotals(p).total - toNumber(p.total)) > MONEY_TOLERANCE) {
      warnings.push(t("warn.purchaseTotalMismatch", { ref }));
    }
    return warnings;
  }

  // The two fields the database's unique indexes use. They only exist in the database, never in the app's data:
  // a cancelled purchase has neither, so its invoice number and reference can be used again.
  function withKeys(p) {
    const out = { ...p };
    delete out.invoiceKey;
    delete out.refKey;
    if (p.status !== "cancelled") {
      const number = normText(p.supplierInvoiceNumber);
      if (number && !p.noSupplierInvoice) out.invoiceKey = p.supplierId + "\u0001" + number;
      const ref = normText(p.reference);
      if (ref) out.refKey = ref;
    }
    return out;
  }

  function stripKeys(p) {
    const out = { ...p };
    delete out.invoiceKey;
    delete out.refKey;
    return out;
  }

  /* ==========================================================================
     SUPPLIER PAYMENTS
     ========================================================================== */

  function normalizePayment(raw) {
    if (!isObj(raw)) return null;
    return {
      ...raw,
      id: String(raw.id || uid()),
      purchaseId: text(raw.purchaseId), supplierId: text(raw.supplierId),
      amount: toNumber(raw.amount), date: text(raw.date),
      reference: text(raw.reference).trim(), note: text(raw.note).trim(),
      status: raw.status === "voided" ? "voided" : "recorded",
      createdAt: text(raw.createdAt), updatedAt: text(raw.updatedAt),
      history: Array.isArray(raw.history) ? raw.history.map((h) => ({ ...h })) : [],
    };
  }

  function paymentProblem(p) {
    if (!isObj(p)) return t("problem.notObject");
    if (!isStr(p.id) || !p.id) return t("problem.noId");
    if (!isStr(p.purchaseId) || !p.purchaseId || !isStr(p.supplierId) || !p.supplierId) return t("problem.badSupplierLink");
    if (!isNum(p.amount) || p.amount <= 0) return t("problem.badPayment");
    if (!isDay(p.date)) return t("problem.badDate");
    if (!PAYMENT_STATUSES.includes(p.status)) return t("problem.badStatus");
    for (const key of ["reference", "note"]) {
      if (p[key] !== undefined && (!isStr(p[key]) || p[key].length > MAX_TEXT)) return t("problem.badField", { field: key });
    }
    if (!isIso(p.createdAt)) return t("problem.badField", { field: "createdAt" });
    if (p.updatedAt !== undefined && p.updatedAt !== "" && !isIso(p.updatedAt)) return t("problem.badField", { field: "updatedAt" });
    if (p.status === "voided" && (!isIso(p.voidedAt) || isBlank(p.voidReason))) return t("problem.badField", { field: "voidedAt" });
    if (p.history !== undefined && (!Array.isArray(p.history) || p.history.some((h) => !isObj(h) || !isNum(h.amount) || !isIso(h.at)))) return t("problem.badField", { field: "history" });
    return "";
  }

  const activePayments = (payments) => payments.filter((p) => p.status !== "voided");

  // The state of one purchase, always worked out from what is stored (nothing here is saved):
  //   Outstanding balance = purchase total - payments recorded (voided payments are not recorded payments).
  function purchaseSummary(purchase, payments, today) {
    const mine = activePayments(payments || []).filter((p) => p.purchaseId === purchase.id);
    const paid = round2(mine.reduce((sum, p) => sum + toNumber(p.amount), 0));
    const total = toNumber(purchase.total);
    const confirmed = purchase.status === "confirmed";
    const outstanding = confirmed ? Math.max(0, round2(total - paid)) : 0;
    const paymentStatus = !confirmed ? null : outstanding <= 0 ? "paid" : paid > 0 ? "partial" : "unpaid";
    const day = today || toDay(new Date());
    const overdue = confirmed && outstanding > 0 && isDay(purchase.dueDate) && purchase.dueDate < day;
    return {
      paid, outstanding, paymentStatus, overdue,
      daysOverdue: overdue ? daysBetween(purchase.dueDate, day) : 0,
      overpaid: confirmed && paid > total + MONEY_TOLERANCE ? round2(paid - total) : 0,
      payments: mine,
      delivery: deliveryState(purchase),
    };
  }

  // What was ordered, received and is still to come for each line, from the receipts that are still applied.
  function deliveryState(purchase) {
    const lines = (purchase.lines || []).map((l) => {
      let received = 0;
      let receivedBase = 0;
      for (const r of purchase.receipts || []) {
        if (r.status !== "applied") continue;
        for (const x of r.lines) if (x.lineId === l.id) { received += x.qty; receivedBase += x.baseQty; }
      }
      received = cleanNumber(received);
      receivedBase = cleanNumber(receivedBase);
      const remaining = Math.max(0, cleanNumber(l.qty - received));
      return { lineId: l.id, ordered: l.qty, received, remaining, receivedBase, remainingBase: Math.max(0, cleanNumber(l.baseQty - receivedBase)) };
    });
    let status = null;
    if (purchase.status === "confirmed") {
      const any = lines.some((l) => l.received > QTY_EPSILON);
      const all = lines.every((l) => l.remaining <= QTY_EPSILON);
      status = all ? "received" : any ? "partial" : "pending";
    }
    return { lines, status };
  }

  // What is owed to, paid to and bought from one supplier. Drafts and cancelled purchases count nowhere.
  function supplierSummary(supplier, purchases, payments, today) {
    let count = 0, total = 0, paid = 0, outstanding = 0, overdueCount = 0, overdueTotal = 0, last = "";
    for (const p of purchases) {
      if (p.supplierId !== supplier.id || p.status !== "confirmed") continue;
      const s = purchaseSummary(p, payments, today);
      count++;
      total += toNumber(p.total);
      paid += s.paid;
      outstanding += s.outstanding;
      if (s.overdue) { overdueCount++; overdueTotal += s.outstanding; }
      if (p.invoiceDate > last) last = p.invoiceDate;
    }
    const limit = supplier.creditLimit;
    return {
      count, total: round2(total), paid: round2(paid), outstanding: round2(outstanding), overdueCount, overdueTotal: round2(overdueTotal),
      lastPurchase: last, creditLimit: limit == null ? null : limit, overLimit: limit != null && round2(outstanding) > limit + MONEY_TOLERANCE,
    };
  }

  function supplierPayable(d, supplierId, today) {
    const supplier = (d.suppliers || []).find((s) => s.id === supplierId);
    return supplier ? supplierSummary(supplier, d.purchases || [], d.supplierPayments || [], today) : null;
  }

  function readPaymentInput(input, ctx, options) {
    const fail = (field, error) => ({ field, error });
    const amount = readNumber(input.amount);
    if (amount.blank || amount.invalid) return fail("amount", t("spay.err.enterAmount"));
    if (amount.value <= 0) return fail("amount", t(amount.value < 0 ? "spay.err.negative" : "spay.err.enterAmount"));
    const date = isBlank(input.date) ? ctx.today : text(input.date).trim();
    if (!isDay(date)) return fail("date", t("spay.err.date"));
    if (date > ctx.today) return fail("date", t("spay.err.future"));
    const reference = text(input.reference).trim();
    const note = text(input.note).trim();
    if (reference.length > 200 || note.length > MAX_TEXT) return fail("note", t("sup.err.tooLong"));
    return { values: { amount: round2(amount.value), date, reference, note } };
  }

  // Records a payment against ONE confirmed purchase. A payment can never be more than what is still owed.
  function recordPayment(d, purchaseId, input, options) {
    const ctx = ctxOf(d, options);
    const purchase = ctx.purchases.find((p) => p.id === purchaseId);
    if (!purchase) return { error: t("pur.err.gone") };
    if (purchase.status !== "confirmed") return { error: t("spay.err.notConfirmed") };
    const read = readPaymentInput(input || {}, ctx);
    if (read.error) return read;
    const summary = purchaseSummary(purchase, ctx.payments, ctx.today);
    if (summary.outstanding <= 0) return { error: t("spay.err.alreadyPaid"), field: "amount" };
    if (read.values.amount > summary.outstanding + 1e-9) return { error: t("spay.err.tooMuch", { max: String(summary.outstanding) }), field: "amount" };
    const at = isoOf(ctx);
    const payment = normalizePayment({
      id: uid(), purchaseId: purchase.id, supplierId: purchase.supplierId, ...read.values,
      status: "recorded", createdAt: at, updatedAt: at, history: [],
    });
    if (!d.supplierPayments) d.supplierPayments = [];
    d.supplierPayments.push(payment);
    return { payment };
  }

  // Changes a payment. The old values stay in its history, and the balance is worked out again from the payments.
  function updatePayment(d, paymentId, input, options) {
    const ctx = ctxOf(d, options);
    const payment = ctx.payments.find((p) => p.id === paymentId);
    if (!payment) return { error: t("spay.err.gone") };
    if (payment.status === "voided") return { error: t("spay.err.voided") };
    const purchase = ctx.purchases.find((p) => p.id === payment.purchaseId);
    if (!purchase || purchase.status !== "confirmed") return { error: t("spay.err.notConfirmed") };
    const read = readPaymentInput(input || {}, ctx);
    if (read.error) return read;
    const others = round2(activePayments(ctx.payments).filter((p) => p.purchaseId === purchase.id && p.id !== payment.id).reduce((s, p) => s + toNumber(p.amount), 0));
    const room = Math.max(0, round2(toNumber(purchase.total) - others));
    if (read.values.amount > room + 1e-9) return { error: t("spay.err.tooMuch", { max: String(room) }), field: "amount" };
    const before = { at: isoOf(ctx), amount: payment.amount, date: payment.date, reference: payment.reference, note: payment.note };
    if (before.amount === read.values.amount && before.date === read.values.date && before.reference === read.values.reference && before.note === read.values.note) return { skip: true, payment };
    payment.history = [...(payment.history || []), before];
    Object.assign(payment, read.values, { updatedAt: isoOf(ctx) });
    return { payment };
  }

  // A payment is never deleted. Voiding keeps it, with the reason, and takes it out of every balance.
  function voidPayment(d, paymentId, reason, options) {
    const ctx = ctxOf(d, options);
    const payment = ctx.payments.find((p) => p.id === paymentId);
    if (!payment) return { error: t("spay.err.gone") };
    if (payment.status === "voided") return { skip: true, payment };
    const why = text(reason).trim();
    if (!why) return { error: t("spay.err.reason"), field: "reason" };
    if (why.length > MAX_TEXT) return { error: t("sup.err.tooLong"), field: "reason" };
    payment.status = "voided";
    payment.voidedAt = isoOf(ctx);
    payment.voidReason = why;
    payment.updatedAt = isoOf(ctx);
    return { payment };
  }

  /* ==========================================================================
     PURCHASE OPERATIONS: draft, confirm, receive, reverse, cancel
     ========================================================================== */

  function logEvent(purchase, event, ctx, extra) {
    purchase.log = [...(purchase.log || []), { at: isoOf(ctx), event, ...(extra || {}) }];
  }

  function touch(purchase, ctx) {
    purchase.updatedAt = isoOf(ctx);
    purchase.revision = (purchase.revision || 0) + 1;
  }

  function errorResult(errors) {
    return { error: errors[0].message, field: errors[0].field, errors };
  }

  // Saves a purchase as a DRAFT. A draft never changes stock, products or balances.
  //   input.id : the draft to change. Without it a new draft is made and gets its internal reference.
  function saveDraft(d, input, options) {
    const ctx = ctxOf(d, options);
    const existing = input && input.id ? ctx.purchases.find((p) => p.id === input.id) : null;
    if (existing && existing.status !== "draft") return { error: t("pur.err.notDraft") };
    const { purchase, errors } = composePurchase(input || {}, ctx, "draft");
    if (errors.length) return errorResult(errors);
    if (!d.purchases) d.purchases = [];
    const at = isoOf(ctx);
    if (existing) {
      const keep = { createdAt: existing.createdAt, log: existing.log || [], revision: existing.revision || 1, reference: purchase.reference || existing.reference };
      Object.assign(existing, purchase, keep, { updatedAt: at, receipts: [] });
      existing.revision += 1;
      logEvent(existing, "draftSaved", ctx);
      return { purchase: existing };
    }
    // New draft: its internal reference comes from a counter that never goes backwards.
    let reference = purchase.reference;
    if (!reference) {
      let n = Math.max(toNumber(d.purchaseCounter), highestReference(ctx.purchases)) + 1;
      while (duplicateReference(ctx.purchases, formatReference(n), null)) n++;
      reference = formatReference(n);
      d.purchaseCounter = n;
    } else {
      d.purchaseCounter = Math.max(toNumber(d.purchaseCounter), referenceSequence(reference));
    }
    Object.assign(purchase, { reference, createdAt: at, updatedAt: at, revision: 1 });
    logEvent(purchase, "created", ctx);
    d.purchases.push(purchase);
    return { purchase };
  }

  // Drafts are not financial records, so a draft may be thrown away. Its attached files go with it.
  function deleteDraft(d, id) {
    const purchase = (d.purchases || []).find((p) => p.id === id);
    if (!purchase) return { error: t("pur.err.gone") };
    if (purchase.status !== "draft") return { error: t("pur.err.notDraft") };
    d.purchases = d.purchases.filter((p) => p.id !== id);
    if (!d.attachments) d.attachments = { put: [], remove: [] };
    for (const a of purchase.attachments || []) d.attachments.remove.push(a.id);
    return { purchase };
  }

  function productMissingMessage(line) {
    return t("pur.err.productGone", { name: line.productName || line.productId });
  }

  // Adds the received quantities of a delivery to stock and records the receipt. Used by confirmPurchase()
  // and receiveDelivery(). It checks everything first, then changes the draft, so a refused delivery changes nothing.
  //   entries: [{ lineId, qty }] in the purchase unit of each line
  function applyReceipt(d, purchase, entries, ctx, receiptOptions) {
    const state = deliveryState(purchase);
    const taken = new Map();
    const wanted = [];
    for (const entry of entries) {
      const line = purchase.lines.find((l) => l.id === entry.lineId);
      if (!line) return { error: t("pur.err.lineGone") };
      const left = state.lines.find((s) => s.lineId === line.id);
      const raw = entry.qty;
      if (isBlank(raw) || Number(raw) === 0) continue;
      const checked = Calc.validateQuantity(raw, line.unit);
      if (checked.error) return { error: `${line.productName}: ${checked.error}` };
      const qty = checked.value;
      if (qty > left.remaining + QTY_EPSILON) return { error: t("pur.err.overReceive", { name: line.productName, max: String(left.remaining) }) };
      const product = (d.products || []).find((p) => p.id === line.productId);
      if (!product) return { error: productMissingMessage(line) };
      if ((Calc.isUnit(product.stockUnit) ? product.stockUnit : null) !== (line.stockUnit || null)) return { error: t("pur.err.productChanged", { name: product.name }) };
      // The last delivery of a line gets exactly what is left, so the total received always equals the ordered quantity.
      const isLast = Math.abs(qty - left.remaining) <= QTY_EPSILON;
      let baseQty = isLast ? left.remainingBase : cleanNumber(qty * line.factor);
      if (Calc.isWholeUnit(line.stockUnit)) {
        const whole = Math.round(baseQty);
        if (Math.abs(baseQty - whole) > 1e-6) return { error: t("pur.err.wholeStock", { name: line.productName, qty: baseQty, unit: unitName(line.stockUnit).toLowerCase() }) };
        baseQty = whole;
      }
      if (baseQty <= 0) continue;
      wanted.push({ lineId: line.id, productId: line.productId, qty, baseQty });
      taken.set(line.productId, cleanNumber((taken.get(line.productId) || 0) + baseQty));
    }
    if (!wanted.length) return { error: t("pur.err.nothingToReceive") };

    const day = isBlank(receiptOptions && receiptOptions.date) ? ctx.today : text(receiptOptions.date).trim();
    if (!isDay(day)) return { error: t("pur.err.receiptDate") };
    if (day > ctx.today) return { error: t("pur.err.receiptFuture") };

    // All checks passed: now the stock goes up, once, together with the receipt.
    for (const [productId, qty] of taken) {
      const product = d.products.find((p) => p.id === productId);
      product.stock = cleanNumber(product.stock + qty);
    }
    const receipt = { id: uid(), at: isoOf(ctx), date: day, note: text(receiptOptions && receiptOptions.note).trim(), status: "applied", lines: wanted };
    purchase.receipts = [...(purchase.receipts || []), receipt];
    logEvent(purchase, "received", ctx, { receiptId: receipt.id });
    return { receipt };
  }

  // Runs a change that touches several lists of the draft `d` and puts everything back exactly as it was if the
  // change reports an error, so a refused operation never leaves half of its work behind.
  function allOrNothing(d, change) {
    const keys = ["products", "purchases", "supplierPayments", "suppliers"];
    const snapshot = JSON.stringify({ lists: keys.map((k) => d[k] || []), counter: d.purchaseCounter, attachments: d.attachments || null });
    const result = change();
    if (result && result.error) {
      const saved = JSON.parse(snapshot);
      keys.forEach((k, i) => { if (d[k] !== undefined || saved.lists[i].length) d[k] = saved.lists[i]; });
      d.purchaseCounter = saved.counter;
      if (saved.attachments) d.attachments = saved.attachments;
    }
    return result;
  }

  // Confirms a draft: the supplier's invoice becomes a debt, new products are created, the goods are received
  // (all of them unless options.receive says otherwise) and an initial payment is recorded, all on the draft `d`.
  // Run through commit(), it is saved in ONE transaction. Confirming twice never adds stock twice: the second
  // attempt sees a confirmed purchase and does nothing. If anything is refused, nothing at all has changed.
  //   options.receive        : { [lineId]: quantity } received now; absent = everything; {} = nothing yet
  //   options.receiptDate, options.receiptNote
  //   options.initialPayment : { amount, date, reference } replaces the payment saved in the draft
  function confirmPurchase(d, id, options) {
    const opts = options || {};
    const ctx = ctxOf(d, opts);
    const purchase = ctx.purchases.find((p) => p.id === id);
    if (!purchase) return { error: t("pur.err.gone") };
    if (purchase.status === "confirmed") return { skip: true, already: true, purchase };
    if (purchase.status !== "draft") return { error: t("pur.err.notDraft") };

    // Everything is checked again against today's data: products, prices and suppliers may have changed since the draft.
    const input = purchaseToInput(purchase);
    if (opts.initialPayment !== undefined) input.initialPayment = opts.initialPayment;
    const composed = composePurchase(input, ctx, "confirm");
    if (composed.errors.length) return errorResult(composed.errors);
    const next = composed.purchase;

    for (const line of next.lines) {
      const product = d.products.find((p) => p.id === line.productId);
      if (line.newProduct) {
        if (product) return { error: t("pur.err.productExists", { name: line.productName }) };
        const sku = line.newProduct.sku.toLowerCase();
        const clash = sku ? d.products.find((p) => text(p.sku).toLowerCase() === sku) : null;
        if (clash) return { error: t("product.skuUsed", { sku: line.newProduct.sku, name: clash.name }) };
      } else if (!product) {
        return { error: productMissingMessage(line) };
      }
    }

    return allOrNothing(d, () => {
      const created = next.lines.filter((l) => l.newProduct);
      for (const line of created) {
        d.products.push(Validation.normalizeProduct({ id: line.productId, manufacturer: "", ...line.newProduct, stock: 0 }));
        line.newProduct = null;
      }

      const at = isoOf(ctx);
      Object.assign(purchase, next, {
        status: "confirmed", confirmedAt: at, initialPayment: null, receipts: [], attachments: purchase.attachments || [],
        createdAt: purchase.createdAt, log: purchase.log || [], revision: purchase.revision || 1, reference: purchase.reference,
      });
      logEvent(purchase, "confirmed", ctx);
      touch(purchase, ctx);

      let receipt = null;
      const entries = opts.receive === undefined
        ? purchase.lines.map((l) => ({ lineId: l.id, qty: l.qty }))
        : purchase.lines.filter((l) => opts.receive[l.id] !== undefined).map((l) => ({ lineId: l.id, qty: opts.receive[l.id] }));
      if (entries.some((e) => !isBlank(e.qty) && Number(e.qty) !== 0)) {
        const received = applyReceipt(d, purchase, entries, ctx, { date: opts.receiptDate, note: opts.receiptNote });
        if (received.error) return { error: received.error };
        receipt = received.receipt;
      }

      let payment = null;
      if (next.initialPayment) {
        const ip = next.initialPayment;
        payment = normalizePayment({
          id: uid(), purchaseId: purchase.id, supplierId: purchase.supplierId, amount: ip.amount, date: ip.date, reference: ip.reference,
          note: "", status: "recorded", createdAt: at, updatedAt: at, history: [],
        });
        if (!d.supplierPayments) d.supplierPayments = [];
        d.supplierPayments.push(payment);
      }
      return { purchase, receipt, payment, createdProducts: created.map((l) => l.productId) };
    });
  }

  // Would confirming this purchase put what is owed to the supplier over the supplier's credit limit?
  function creditCheck(d, purchaseId, today) {
    const purchase = (d.purchases || []).find((p) => p.id === purchaseId);
    if (!purchase) return null;
    const supplier = (d.suppliers || []).find((s) => s.id === purchase.supplierId);
    if (!supplier || supplier.creditLimit == null) return null;
    const summary = supplierSummary(supplier, d.purchases, d.supplierPayments || [], today);
    const paidNow = purchase.initialPayment ? purchase.initialPayment.amount : 0;
    const after = round2(summary.outstanding + toNumber(purchase.total) - paidNow);
    return after > supplier.creditLimit + MONEY_TOLERANCE ? { limit: supplier.creditLimit, after, name: supplier.name } : null;
  }

  // Receives goods that were not delivered when the purchase was confirmed.
  //   quantities: { [lineId]: quantity in the purchase unit }
  function receiveDelivery(d, id, quantities, options) {
    const ctx = ctxOf(d, options);
    const purchase = ctx.purchases.find((p) => p.id === id);
    if (!purchase) return { error: t("pur.err.gone") };
    if (purchase.status !== "confirmed") return { error: t("pur.err.notConfirmed") };
    const entries = Object.entries(quantities || {}).map(([lineId, qty]) => ({ lineId, qty }));
    const result = applyReceipt(d, purchase, entries, ctx, options);
    if (result.error) return result;
    touch(purchase, ctx);
    return { purchase, receipt: result.receipt };
  }

  // Checks that goods of the given receipts can still be taken out of stock, and takes them out.
  // Goods that were already sold can not be taken out: stock never goes below 0.
  function takeOutReceipts(d, purchase, receipts, ctx) {
    const needed = new Map();
    for (const r of receipts) {
      for (const x of r.lines) needed.set(x.lineId, cleanNumber((needed.get(x.lineId) || 0) + x.baseQty));
    }
    const perProduct = new Map();
    for (const [lineId, base] of needed) {
      const line = purchase.lines.find((l) => l.id === lineId);
      if (!line) return { error: t("pur.err.lineGone") };
      perProduct.set(line.productId, { line, base: cleanNumber(((perProduct.get(line.productId) || {}).base || 0) + base) });
    }
    for (const [productId, info] of perProduct) {
      const product = d.products.find((p) => p.id === productId);
      if (!product) return { error: productMissingMessage(info.line) };
      if (!Calc.hasEnoughStock(product.stock, info.base)) {
        return { error: t("pur.err.cannotReverse", { name: product.name, stock: String(product.stock), needed: String(info.base), unit: unitName(product.stockUnit).toLowerCase() }) };
      }
    }
    for (const [productId, info] of perProduct) {
      const product = d.products.find((p) => p.id === productId);
      product.stock = Math.max(0, cleanNumber(product.stock - info.base));
    }
    return {};
  }

  // Undoes ONE delivery. Stock goes down by what that delivery added, the receipt stays in the history marked reversed,
  // and the reason is kept. Refused (nothing changed) if that stock has already been sold.
  function reverseReceipt(d, id, receiptId, reason, options) {
    const ctx = ctxOf(d, options);
    const purchase = ctx.purchases.find((p) => p.id === id);
    if (!purchase) return { error: t("pur.err.gone") };
    if (purchase.status !== "confirmed") return { error: t("pur.err.notConfirmed") };
    const receipt = (purchase.receipts || []).find((r) => r.id === receiptId);
    if (!receipt) return { error: t("pur.err.receiptGone") };
    if (receipt.status === "reversed") return { skip: true, purchase, receipt };
    const why = text(reason).trim();
    if (!why) return { error: t("pur.err.reasonNeeded"), field: "reason" };
    if (why.length > MAX_TEXT) return { error: t("sup.err.tooLong"), field: "reason" };
    const out = takeOutReceipts(d, purchase, [receipt], ctx);
    if (out.error) return out;
    receipt.status = "reversed";
    receipt.reversedAt = isoOf(ctx);
    receipt.reversalReason = why;
    logEvent(purchase, "receiptReversed", ctx, { receiptId, note: why });
    touch(purchase, ctx);
    return { purchase, receipt };
  }

  // Cancels a purchase on purpose. A draft is just marked cancelled. For a confirmed purchase every delivery still
  // applied is reversed first (refused, changing nothing, if that stock was already sold) and no payment may be
  // active: void the payments first, so the money is never left pointing at a cancelled invoice.
  function cancelPurchase(d, id, reason, options) {
    const ctx = ctxOf(d, options);
    const purchase = ctx.purchases.find((p) => p.id === id);
    if (!purchase) return { error: t("pur.err.gone") };
    if (purchase.status === "cancelled") return { skip: true, purchase };
    const why = text(reason).trim();
    if (!why) return { error: t("pur.err.reasonNeeded"), field: "reason" };
    if (why.length > MAX_TEXT) return { error: t("sup.err.tooLong"), field: "reason" };
    if (purchase.status === "confirmed") {
      const active = activePayments(ctx.payments).filter((p) => p.purchaseId === purchase.id);
      if (active.length) return { error: t("pur.err.cancelHasPayments", { n: active.length }) };
      const applied = (purchase.receipts || []).filter((r) => r.status === "applied");
      if (applied.length) {
        const out = takeOutReceipts(d, purchase, applied, ctx);
        if (out.error) return out;
        const at = isoOf(ctx);
        for (const r of applied) { r.status = "reversed"; r.reversedAt = at; r.reversalReason = why; }
      }
    }
    purchase.status = "cancelled";
    purchase.cancelledAt = isoOf(ctx);
    purchase.cancelReason = why;
    purchase.initialPayment = null;
    logEvent(purchase, "cancelled", ctx, { note: why });
    touch(purchase, ctx);
    return { purchase };
  }

  // What deleting a purchase would take out, for the question asked before it is done. Nothing is changed.
  // Only deliveries still applied count: a reversed delivery already left stock.
  function deletionPreview(d, id) {
    const purchase = (d.purchases || []).find((p) => p.id === id);
    if (!purchase) return null;
    const goods = new Map();
    for (const r of (purchase.receipts || []).filter((x) => x.status === "applied")) {
      for (const x of r.lines) goods.set(x.productId, cleanNumber((goods.get(x.productId) || 0) + x.baseQty));
    }
    const stockOut = [];
    for (const [productId, qty] of goods) {
      const product = (d.products || []).find((p) => p.id === productId);
      if (product) stockOut.push({ productId, name: product.name, qty, unit: unitName(product.stockUnit).toLowerCase() });
    }
    const payments = (d.supplierPayments || []).filter((x) => x.purchaseId === id);
    return { purchase, stockOut, paymentCount: payments.length, paid: round2(activePayments(payments).reduce((s, x) => s + toNumber(x.amount), 0)) };
  }

  // Deletes a purchase for good, as if it had never been entered (cancelPurchase() keeps it as history, this does not).
  // On the draft `d`: the goods still received are taken out of stock, the purchase, ALL its payments (voided ones
  // too) and its attached files are removed. Suppliers and products are never touched. Run through commit(), it is
  // saved in ONE transaction. Refused, changing nothing, if that stock was already sold (stock never goes below 0).
  // Deleting twice never reverses anything twice: once the purchase is gone the second attempt only reports it.
  function deletePurchase(d, id, options) {
    const purchase = (d.purchases || []).find((p) => p.id === id);
    if (!purchase) return { skip: true, already: true };
    if (purchase.status === "draft") return deleteDraft(d, id);
    const ctx = ctxOf(d, options);
    return allOrNothing(d, () => {
      // A product deleted from Stock since has no stock left to take goods out of: its lines are skipped.
      const exists = (productId) => ctx.products.some((p) => p.id === productId);
      const applied = (purchase.receipts || []).filter((r) => r.status === "applied").map((r) => ({ ...r, lines: r.lines.filter((x) => exists(x.productId)) }));
      if (applied.length) {
        const out = takeOutReceipts(d, purchase, applied, ctx);
        if (out.error) return out;
      }
      const removedPayments = (d.supplierPayments || []).filter((x) => x.purchaseId === id).length;
      d.supplierPayments = (d.supplierPayments || []).filter((x) => x.purchaseId !== id);
      d.purchases = d.purchases.filter((p) => p.id !== id);
      if (!d.attachments) d.attachments = { put: [], remove: [] };
      for (const a of purchase.attachments || []) d.attachments.remove.push(a.id);
      return { purchase, removedPayments };
    });
  }

  // What may still be edited on a confirmed purchase. Its lines, prices, totals and supplier are fixed: to change
  // those, cancel it (which reverses the stock) and enter it again.
  const CONFIRMED_EDITABLE = ["supplierInvoiceNumber", "noSupplierInvoice", "invoiceDate", "dueDate", "reference", "notes"];

  function updatePurchaseDetails(d, id, patch, options) {
    const ctx = ctxOf(d, options);
    const purchase = ctx.purchases.find((p) => p.id === id);
    if (!purchase) return { error: t("pur.err.gone") };
    if (purchase.status !== "confirmed") return { error: t("pur.err.notConfirmed") };
    const input = { ...purchaseToInput(purchase) };
    for (const key of CONFIRMED_EDITABLE) if (patch[key] !== undefined) input[key] = patch[key];
    // Compose checks the invoice number, dates and reference exactly as for a new purchase.
    const supplier = ctx.suppliers.find((s) => s.id === purchase.supplierId);
    const composed = composePurchase(input, { ...ctx, suppliers: ctx.suppliers.map((s) => (s === supplier ? { ...s, archived: false } : s)) }, "confirm");
    const relevant = composed.errors.filter((e) => !e.field.startsWith("line.") && e.field !== "initialPayment.amount" && e.field !== "initialPayment.date");
    if (relevant.length) return errorResult(relevant);
    const next = composed.purchase;
    const changed = [];
    for (const key of CONFIRMED_EDITABLE) {
      if (patch[key] === undefined) continue;
      if (text(purchase[key]) !== text(next[key])) { changed.push(key); purchase[key] = next[key]; }
    }
    if (!changed.length) return { skip: true, purchase };
    logEvent(purchase, "edited", ctx, { note: changed.join(", ") });
    touch(purchase, ctx);
    return { purchase, changed };
  }

  // Adds or removes attached-file records on a purchase. The file data itself is saved by the caller in the
  // same transaction (see d.attachments); here only the purchase's list changes.
  function setAttachmentMeta(d, id, metas, removedIds, options) {
    const ctx = ctxOf(d, options);
    const purchase = ctx.purchases.find((p) => p.id === id);
    if (!purchase) return { error: t("pur.err.gone") };
    for (const m of metas) { const why = attachmentMetaProblem(m); if (why) return { error: why }; }
    const removed = new Set(removedIds || []);
    purchase.attachments = [...(purchase.attachments || []).filter((a) => !removed.has(a.id)), ...metas];
    touch(purchase, ctx);
    return { purchase };
  }

  /* ==========================================================================
     WHOLE DATASET: links between the records (used by backups and restores)
     ========================================================================== */

  // Problems that only show when all the supplier-side records are looked at together. Nothing is repaired.
  // data: { suppliers, purchases, supplierPayments, attachments } (any may be missing)
  function linkProblems(data) {
    const problems = [];
    const suppliers = data.suppliers || [];
    const purchases = data.purchases || [];
    const payments = data.supplierPayments || [];
    const attachments = data.attachments || [];
    const supplierIds = new Set(suppliers.map((x) => x.id));
    const purchaseById = new Map(purchases.map((x) => [x.id, x]));
    const ref = (x) => x.reference || x.id;

    const seenInvoice = new Set();
    const seenRef = new Set();
    for (const p of purchases) {
      if (!supplierIds.has(p.supplierId)) problems.push(t("data.purchaseNoSupplier", { ref: ref(p) }));
      const keyed = withKeys(p);
      if (keyed.invoiceKey) {
        if (seenInvoice.has(keyed.invoiceKey)) problems.push(t("data.dupPurchaseInvoice", { number: p.supplierInvoiceNumber }));
        seenInvoice.add(keyed.invoiceKey);
      }
      if (keyed.refKey) {
        if (seenRef.has(keyed.refKey)) problems.push(t("data.dupPurchaseReference", { reference: p.reference }));
        seenRef.add(keyed.refKey);
      }
    }

    const paidBy = new Map();
    for (const pay of payments) {
      const purchase = purchaseById.get(pay.purchaseId);
      if (!purchase) { problems.push(t("data.paymentNoPurchase", { id: pay.id })); continue; }
      if (purchase.supplierId !== pay.supplierId) problems.push(t("data.paymentWrongSupplier", { ref: ref(purchase) }));
      if (pay.status !== "voided") {
        if (purchase.status !== "confirmed") problems.push(t("data.paymentUnconfirmed", { ref: ref(purchase) }));
        paidBy.set(purchase.id, round2((paidBy.get(purchase.id) || 0) + toNumber(pay.amount)));
      }
    }
    for (const [id, paid] of paidBy) {
      const purchase = purchaseById.get(id);
      if (paid > round2(purchase.total) + MONEY_TOLERANCE) problems.push(t("data.paymentOver", { ref: ref(purchase) }));
    }

    const stored = new Map(attachments.map((a) => [a.id, a]));
    for (const a of attachments) {
      const purchase = purchaseById.get(a.purchaseId);
      if (!purchase) problems.push(t("data.attachmentNoPurchase", { name: a.name }));
      else if (!(purchase.attachments || []).some((m) => m.id === a.id)) problems.push(t("data.attachmentNotListed", { name: a.name }));
    }
    for (const p of purchases) {
      for (const m of p.attachments || []) {
        if (!stored.has(m.id)) problems.push(t("data.attachmentMissing", { name: m.name, ref: ref(p) }));
      }
    }
    return problems;
  }

  /* ==========================================================================
     REPORTS - always worked out from the stored purchases and payments
     ========================================================================== */

  const inPeriod = (day, from, to) => isDay(day) && (!from || day >= from) && (!to || day <= to);

  function dataOf(d) {
    return { suppliers: d.suppliers || [], purchases: d.purchases || [], payments: d.supplierPayments || [], products: d.products || [] };
  }

  // Confirmed purchases only. A cancelled purchase, and a draft, never count. Reversed deliveries do not matter here:
  // only a cancellation removes a purchase from the totals.
  function purchasesInPeriod(d, from, to, today) {
    const { purchases, payments } = dataOf(d);
    return purchases
      .filter((p) => p.status === "confirmed" && inPeriod(p.invoiceDate, from, to))
      .map((purchase) => ({ purchase, summary: purchaseSummary(purchase, payments, today) }))
      .sort((a, b) => b.purchase.invoiceDate.localeCompare(a.purchase.invoiceDate) || b.purchase.reference.localeCompare(a.purchase.reference));
  }

  function periodReport(d, from, to, today) {
    const rows = purchasesInPeriod(d, from, to, today);
    return {
      rows,
      count: rows.length,
      total: round2(rows.reduce((s, r) => s + toNumber(r.purchase.total), 0)),
      paid: round2(rows.reduce((s, r) => s + r.summary.paid, 0)),
      outstanding: round2(rows.reduce((s, r) => s + r.summary.outstanding, 0)),
    };
  }

  // Everything still owed to suppliers, whenever it was bought, and which of it is overdue.
  function outstandingReport(d, today) {
    const { suppliers, purchases, payments } = dataOf(d);
    const bySupplier = suppliers
      .map((supplier) => ({ supplier, summary: supplierSummary(supplier, purchases, payments, today) }))
      .filter((r) => r.summary.outstanding > 0)
      .sort((a, b) => b.summary.outstanding - a.summary.outstanding);
    const overdue = purchases
      .filter((p) => p.status === "confirmed")
      .map((purchase) => ({ purchase, summary: purchaseSummary(purchase, payments, today), supplier: suppliers.find((s) => s.id === purchase.supplierId) }))
      .filter((r) => r.summary.overdue)
      .sort((a, b) => b.summary.daysOverdue - a.summary.daysOverdue);
    return {
      total: round2(bySupplier.reduce((s, r) => s + r.summary.outstanding, 0)),
      bySupplier, overdue,
      overdueTotal: round2(overdue.reduce((s, r) => s + r.summary.outstanding, 0)),
    };
  }

  // Purchases in a period grouped by supplier.
  function purchasesBySupplier(d, from, to, today) {
    const groups = new Map();
    for (const row of purchasesInPeriod(d, from, to, today)) {
      const g = groups.get(row.purchase.supplierId) || { supplierId: row.purchase.supplierId, count: 0, total: 0, paid: 0, outstanding: 0, last: "" };
      g.count++;
      g.total += toNumber(row.purchase.total);
      g.paid += row.summary.paid;
      g.outstanding += row.summary.outstanding;
      if (row.purchase.invoiceDate > g.last) g.last = row.purchase.invoiceDate;
      groups.set(row.purchase.supplierId, g);
    }
    const suppliers = dataOf(d).suppliers;
    return [...groups.values()]
      .map((g) => ({ ...g, total: round2(g.total), paid: round2(g.paid), outstanding: round2(g.outstanding), supplier: suppliers.find((s) => s.id === g.supplierId) || null }))
      .sort((a, b) => b.total - a.total);
  }

  /* ---------- Finding a product while typing (the purchase line's product selector) ---------- */

  // The text a product is searched by: lower case, no accents, single spaces, and a tile size written 60*60, 60x60 or
  // 60 × 60 always as "60x60".
  const searchKey = (s) => normText(s).replace(/(\d)\s*[x×*]\s*(?=\d)/g, "$1x");
  const compactKey = (s) => searchKey(s).replace(/[^a-z0-9]/g, "");

  // The products that match what was typed, best first. Case, accents and spacing never matter: "barcelona crema",
  // "BARCELONACREMA" and "crema barc" all find "BARCELONA Crema", and "60 x 60" finds "60*60". Every word typed must be
  // found somewhere in the product's name, tile size, manufacturer, SKU or category (`extra(product)` adds more text, such as
  // the product type as it is shown). Names that start with the text come first, then names with a word that starts with it,
  // then names that contain it, then the other fields; ties stay in alphabetical order. Nothing typed lists every product.
  function matchProducts(products, query, extra) {
    const list = Array.isArray(products) ? products : [];
    const byName = (a, b) => text(a.name).localeCompare(text(b.name)) || text(a.tileSize).localeCompare(text(b.tileSize));
    const all = [...list].sort(byName);
    const compactQuery = compactKey(query);
    if (!compactQuery) return all;   // nothing typed, or only spaces and punctuation
    const words = searchKey(query).split(" ").map((w) => w.replace(/[^a-z0-9]/g, "")).filter(Boolean);
    const scored = [];
    for (const product of all) {
      const own = [product.name, product.tileSize, product.manufacturer, product.sku, product.category].map(text).join(" ");
      const hay = compactKey(own + " " + (extra ? text(extra(product)) : ""));
      const name = compactKey(product.name);
      const wordsOfName = searchKey(product.name).split(/[^a-z0-9]+/).filter(Boolean);
      const found = (compactQuery && hay.includes(compactQuery)) || (words.length > 0 && words.every((w) => hay.includes(w)));
      if (!found) continue;
      let rank = 3;
      if (name.startsWith(compactQuery) || words.every((w) => name.startsWith(w))) rank = 0;
      else if (words.length && words.every((w) => wordsOfName.some((n) => n.startsWith(w)))) rank = 1;
      else if (name.includes(compactQuery) || words.every((w) => name.includes(w))) rank = 2;
      scored.push({ product, rank });
    }
    return scored.sort((a, b) => a.rank - b.rank).map((s) => s.product);   // stable: ties stay alphabetical
  }

  // Every confirmed purchase line of one product (optionally of one supplier), newest first.
  function productHistory(d, productId, supplierId) {
    const { purchases, suppliers } = dataOf(d);
    const rows = [];
    for (const purchase of purchases) {
      if (purchase.status !== "confirmed" || (supplierId && purchase.supplierId !== supplierId)) continue;
      const state = deliveryState(purchase);
      for (const line of purchase.lines) {
        if (line.productId !== productId) continue;
        const got = state.lines.find((s) => s.lineId === line.id);
        rows.push({
          purchase, line, supplier: suppliers.find((s) => s.id === purchase.supplierId) || null,
          receivedBase: got ? got.receivedBase : 0,
          costPerStockUnit: line.baseQty > 0 ? round2(line.lineTotal / line.baseQty) : null,
        });
      }
    }
    return rows.sort((a, b) => b.purchase.invoiceDate.localeCompare(a.purchase.invoiceDate) || b.purchase.reference.localeCompare(a.purchase.reference));
  }

  // The products bought from one supplier, with what was bought and the last price paid.
  function supplierProducts(d, supplierId) {
    const groups = new Map();
    for (const purchase of dataOf(d).purchases) {
      if (purchase.supplierId !== supplierId || purchase.status !== "confirmed") continue;
      for (const line of purchase.lines) {
        const g = groups.get(line.productId) || { productId: line.productId, name: line.productName, count: 0, baseQty: 0, spent: 0, stockUnit: line.stockUnit, last: null };
        g.count++;
        g.baseQty = cleanNumber(g.baseQty + line.baseQty);
        g.spent += line.lineTotal;
        if (!g.last || purchase.invoiceDate >= g.last.date) g.last = { date: purchase.invoiceDate, unitPrice: line.unitPrice, unit: line.unit };
        groups.set(line.productId, g);
      }
    }
    return [...groups.values()].map((g) => ({ ...g, spent: round2(g.spent) })).sort((a, b) => a.name.localeCompare(b.name));
  }

  /* ---------- Supplier price insights (Dashboard) ----------
     The same product bought from different suppliers at different prices. Only what is saved is used: confirmed purchases,
     their supplier, their invoice date and each line's own unit price and unit. Products are matched by product id, never by
     name or by manufacturer (a manufacturer is who makes the tile, a supplier is who it was bought from). The selling price
     of a product is never read here.

     For each product, the LATEST purchase of each supplier is compared (not the oldest against the newest), so a supplier
     that changed its price is judged by what it charges now. When the lines were bought in different units (800 DA per m²
     from one supplier, 1,152 DA per box from another) they are brought to one unit with the product's own saved
     information (the same conversion the rest of Invoisy uses); a line that can not be converted reliably is left out of the
     comparison instead of being guessed. Nothing is written anywhere. */

  const PRICE_SAME_TOLERANCE = 0.005;     // below half a centime two prices are the same price
  const PRICE_MODERATE_PCT = 3;           // under 3 %: a small difference, shown quietly
  const PRICE_HIGH_PCT = 10;              // 10 % or more: worth a second look

  function priceLevel(pct) {
    if (pct === null) return "moderate";
    return pct >= PRICE_HIGH_PCT ? "high" : pct >= PRICE_MODERATE_PCT ? "moderate" : "small";
  }

  // The unit price of one purchase line in `unit`, or null when the line can not be brought to that unit reliably.
  function linePriceIn(line, unit, product) {
    const price = toNumber(line.unitPrice);
    if (!(price > 0)) return null;
    if (line.unit === unit) return price;
    if (product) {
      const factor = Calc.getUnitFactor(product, unit, line.unit);          // how many of the bought unit are in one `unit`
      if (!factor.error && factor.value > 0) return round2(price * factor.value);
    } else if (line.stockUnit === unit && isNum(line.factor) && line.factor > 0) {
      return round2(price / line.factor);                                   // the line's own saved conversion into stock units
    }
    return null;
  }

  // All the products that were bought from two or more suppliers at different prices, most relevant first.
  //   { insights: [...], comparedProducts, samePriceProducts }
  // insight = { productId, name, tileSize, manufacturer, productExists, unit, entries, lowest, highest, diff, pct, level, changes, history }
  //   entries   one per supplier, cheapest first: { supplierId, supplierName, date, price, unit, bought: {unitPrice, unit} | null,
  //             purchaseId, reference, isLowest, isHighest, count }
  //   changes   a supplier that charged different prices at different times: { supplierId, supplierName, from, to, fromDate, toDate, diff, pct }
  //   history   every confirmed purchase line of the product that could be compared, newest first
  function priceInsights(d) {
    const { purchases, suppliers, products } = dataOf(d);
    const byProduct = new Map();
    for (const purchase of purchases) {
      if (purchase.status !== "confirmed" || !purchase.supplierId) continue;
      for (const line of purchase.lines || []) {
        if (!line.productId) continue;
        const rows = byProduct.get(line.productId) || [];
        rows.push({ purchase, line });
        byProduct.set(line.productId, rows);
      }
    }

    const insights = [];
    let comparedProducts = 0;
    let samePriceProducts = 0;
    for (const [productId, found] of byProduct) {
      if (new Set(found.map((r) => r.purchase.supplierId)).size < 2) continue;
      const product = products.find((p) => p.id === productId) || null;

      // Newest first: by invoice day, then by the internal reference, then the later line of the same purchase.
      found.sort((a, b) => text(b.purchase.invoiceDate).localeCompare(text(a.purchase.invoiceDate)) || text(b.purchase.reference).localeCompare(text(a.purchase.reference)) || b.purchase.lines.indexOf(b.line) - a.purchase.lines.indexOf(a.line));

      // One unit for the whole product: the unit every line was bought in, otherwise the unit the product is counted in.
      const units = new Set(found.map((r) => r.line.unit));
      const unit = units.size === 1 ? found[0].line.unit : (product && Calc.isUnit(product.stockUnit) ? product.stockUnit : (found.find((r) => Calc.isUnit(r.line.stockUnit)) || { line: {} }).line.stockUnit);
      if (!Calc.isUnit(unit)) continue;

      const rows = [];
      for (const r of found) {
        const price = linePriceIn(r.line, unit, product);
        if (price === null) continue;
        rows.push({ ...r, price });
      }
      if (new Set(rows.map((r) => r.purchase.supplierId)).size < 2) continue;
      comparedProducts++;

      const nameOfSupplier = (id) => { const s = suppliers.find((x) => x.id === id); return s ? s.name : ""; };
      const perSupplier = new Map();
      for (const r of rows) {
        const g = perSupplier.get(r.purchase.supplierId) || [];
        g.push(r);
        perSupplier.set(r.purchase.supplierId, g);
      }

      const entries = [];
      const changes = [];
      for (const [supplierId, list] of perSupplier) {
        const latest = list[0];
        entries.push({
          supplierId, supplierName: nameOfSupplier(supplierId), date: text(latest.purchase.invoiceDate), price: latest.price, unit,
          bought: latest.line.unit === unit ? null : { unitPrice: toNumber(latest.line.unitPrice), unit: latest.line.unit },
          purchaseId: latest.purchase.id, reference: text(latest.purchase.reference), count: list.length,
          isLowest: false, isHighest: false,
        });
        // The same supplier at a different price earlier: the most recent price that is not today's price.
        const before = list.find((x) => Math.abs(x.price - latest.price) > PRICE_SAME_TOLERANCE);
        if (before) {
          changes.push({
            supplierId, supplierName: nameOfSupplier(supplierId), from: before.price, to: latest.price,
            fromDate: text(before.purchase.invoiceDate), toDate: text(latest.purchase.invoiceDate),
            diff: round2(latest.price - before.price), pct: before.price > 0 ? Math.round(((latest.price - before.price) / before.price) * 1000) / 10 : null,
          });
        }
      }
      entries.sort((a, b) => a.price - b.price || a.supplierName.localeCompare(b.supplierName));
      const lowest = entries[0].price;
      const highest = entries[entries.length - 1].price;
      if (highest - lowest <= PRICE_SAME_TOLERANCE) { samePriceProducts++; continue; }   // several suppliers, one price: nothing to flag
      for (const e of entries) {
        e.isLowest = Math.abs(e.price - lowest) <= PRICE_SAME_TOLERANCE;
        e.isHighest = Math.abs(e.price - highest) <= PRICE_SAME_TOLERANCE;
      }
      const diff = round2(highest - lowest);
      const pct = lowest > 0 ? Math.round((diff / lowest) * 1000) / 10 : null;      // against the cheaper price
      const sample = found[0].line;
      insights.push({
        productId, name: product ? product.name : text(sample.productName), tileSize: product ? text(product.tileSize) : text(sample.tileSize),
        manufacturer: product ? text(product.manufacturer) : "", productExists: Boolean(product), unit, entries, lowest, highest, diff, pct,
        level: priceLevel(pct), changes: changes.sort((a, b) => a.supplierName.localeCompare(b.supplierName)),
        history: rows.map((r) => ({
          purchaseId: r.purchase.id, reference: text(r.purchase.reference), supplierId: r.purchase.supplierId, supplierName: nameOfSupplier(r.purchase.supplierId),
          date: text(r.purchase.invoiceDate), price: r.price, unit, bought: r.line.unit === unit ? null : { unitPrice: toNumber(r.line.unitPrice), unit: r.line.unit },
          qty: toNumber(r.line.qty), qtyUnit: r.line.unit,
        })),
        latestDate: text(found[0].purchase.invoiceDate),
      });
    }

    // Most relevant first: the biggest relative difference, then the biggest amount, then the most recent purchase.
    insights.sort((a, b) => (b.pct === null ? -1 : b.pct) - (a.pct === null ? -1 : a.pct) || b.diff - a.diff || b.latestDate.localeCompare(a.latestDate) || a.name.localeCompare(b.name));
    return { insights, comparedProducts, samePriceProducts };
  }

  // Payments made in a period (by payment date). Voided payments are not counted.
  function paymentsReport(d, from, to) {
    const { purchases, suppliers, payments } = dataOf(d);
    const rows = activePayments(payments)
      .filter((p) => inPeriod(p.date, from, to))
      .map((payment) => ({
        payment, purchase: purchases.find((p) => p.id === payment.purchaseId) || null, supplier: suppliers.find((s) => s.id === payment.supplierId) || null,
      }))
      .filter((r) => r.purchase && r.purchase.status === "confirmed")
      .sort((a, b) => b.payment.date.localeCompare(a.payment.date) || b.payment.createdAt.localeCompare(a.payment.createdAt));
    return { rows, count: rows.length, total: round2(rows.reduce((s, r) => s + toNumber(r.payment.amount), 0)) };
  }

  // All the numbers at the top of the Suppliers page.
  function overview(d, today) {
    const { suppliers, purchases, payments } = dataOf(d);
    let total = 0, paid = 0, outstanding = 0, overdueCount = 0;
    for (const s of suppliers) {
      const x = supplierSummary(s, purchases, payments, today);
      total += x.total; paid += x.paid; outstanding += x.outstanding; overdueCount += x.overdueCount;
    }
    return {
      suppliers: suppliers.length, active: suppliers.filter((s) => !s.archived).length,
      total: round2(total), paid: round2(paid), outstanding: round2(outstanding), overdueCount,
    };
  }

  globalThis.Purchases = {
    PURCHASE_STATUSES, RECEIPT_STATUSES, PAYMENT_STATUSES, DISCOUNT_TYPES, TAX_TYPES, TAX_MODES,
    ATTACHMENT_TYPES, ATTACHMENT_MAX_BYTES, REFERENCE_PREFIX, MAX_TERMS_DAYS, CONFIRMED_EDITABLE,
    isDay, toDay, addDays, daysBetween, normText, readNumber,
    normalizeSupplier, supplierProblem, supplierContacts, supplierPhones, supplierContactNames, MAX_CONTACTS, findSupplierDuplicates, saveSupplier, setSupplierArchived, deleteSupplier, supplierHasHistory,
    lineTotalOf, lineBaseQty, computeTotals, discountAmount, taxAmount, autoFactor,
    composePurchase, previewPurchase, purchaseToInput, duplicateInvoice, duplicateReference,
    normalizePurchase, purchaseProblem, purchaseWarnings, attachmentProblem, attachmentMetaProblem, attachmentMeta, withKeys, stripKeys,
    referenceSequence, formatReference, highestReference,
    normalizePayment, paymentProblem, purchaseSummary, deliveryState, supplierSummary, supplierPayable,
    saveDraft, deleteDraft, confirmPurchase, creditCheck, receiveDelivery, reverseReceipt, cancelPurchase, deletePurchase, deletionPreview, updatePurchaseDetails, setAttachmentMeta,
    recordPayment, updatePayment, voidPayment,
    linkProblems,
    purchasesInPeriod, periodReport, outstandingReport, purchasesBySupplier, productHistory, supplierProducts, priceInsights, PRICE_MODERATE_PCT, PRICE_HIGH_PCT, matchProducts, paymentsReport, overview,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = globalThis.Purchases;
})();

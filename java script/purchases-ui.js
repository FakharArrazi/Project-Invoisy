"use strict";

/* ==========================================================================
   Suppliers and Purchases screens.

   Plain script, loaded before script.js. The page code (script.js) hands over what these screens need through
   PurchasesUI.init(): the data (state), commit() (every change is one transaction, like the rest of Invoisy),
   guard() (no double clicks) and a few formatting helpers. All business rules live in purchases.js; this file
   only reads forms, calls those rules and draws the result. Purchases are never mixed with sales: they have
   their own pages, their own numbers and their own screens.
   ========================================================================== */

(function () {
  const P = globalThis.Purchases;
  let h = null;                                   // the hooks handed over by script.js

  const t = (key, params) => h.t(key, params);
  const tn = (key, count, params) => h.tn(key, count, params);
  const esc = (v) => h.esc(v);
  const $ = (id) => h.$(id);
  const S = () => h.state;
  const money = (n) => h.money(n);
  const num = (n) => h.numberFormat.format(n);
  const today = () => P.toDay(new Date());

  const UNIT_CHOICES = ["piece", "box", "m2", "kg", "m"];
  const STATUS_FILTERS = ["all", "draft", "confirmed", "cancelled"];
  const PAY_FILTERS = ["all", "unpaid", "partial", "paid", "overdue"];

  const ui = {
    sup: { screen: "list", q: "", status: "active", sortKey: "name", sortDir: 1, editingId: null, profileId: null, tab: "overview", formReady: false, formLang: "", contactRows: [], depositNonce: "", editDepositId: "", voidDepositId: "" },
    pur: {
      screen: "list", tab: "list", q: "", status: "all", pay: "all", supplierId: "", from: "", to: "", sortKey: "date", sortDir: -1,
      detailId: null, open: "", form: null, formLang: "",
      report: { from: "", to: "", productId: "" },
    },
    dash: { all: false, open: [] },   // Dashboard: all price insights shown, and the products whose purchase history is open (screen only)
    lastLanguage: "",
  };

  /* ---------- Small helpers ---------- */

  function fmtDay(day) {
    if (!P.isDay(day)) return "";
    const [y, m, d] = day.split("-");
    return d + "/" + m + "/" + y;
  }

  const unitName = (unit, qty) => (Calc.isUnit(unit) ? Calc.unitLabel(unit, qty) : "");
  const stockUnitName = (unit) => (Calc.isUnit(unit) ? t("stockunit." + unit) : "");
  const qtyText = (qty, unit) => num(qty) + (unit ? " " + unitName(unit, qty) : "");
  const stockQtyText = (qty, unit) => num(qty) + (unit ? " " + stockUnitName(unit) : "");

  // "1 box = 1.44 m²": how the unit a line was bought in relates to the unit stock is counted in ("" when they are the same).
  function conversionRule(unit, stockUnit, factor) {
    if (!(factor > 0) || !Calc.isUnit(unit) || !Calc.isUnit(stockUnit) || unit === stockUnit) return "";
    const per = Calc.cleanNumber(factor < 1 ? 1 / factor : factor);
    return factor < 1
      ? t("pur.conv.eq", { from: unitName(stockUnit, 1).toLowerCase(), n: num(per), to: unitName(unit, per).toLowerCase() })
      : t("pur.conv.eq", { from: unitName(unit, 1).toLowerCase(), n: num(per), to: unitName(stockUnit, per).toLowerCase() });
  }

  const option = (value, label, selected) => `<option value="${esc(value)}"${selected ? " selected" : ""}>${esc(label)}</option>`;
  const badge = (cls, label) => `<span class="badge ${cls}">${esc(label)}</span>`;

  function field(id, label, control, extra) {
    return `<div class="field${extra ? " " + extra : ""}"><label for="${id}">${label}</label>${control}</div>`;
  }

  function showErr(id, message, fieldId) {
    const el = $(id);
    if (el) el.textContent = message || "";
    if (fieldId && $(fieldId)) {
      $(fieldId).setAttribute("aria-invalid", "true");
      if ($(fieldId).focus) $(fieldId).focus();
    }
  }

  function clearInvalid(root) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll("[aria-invalid]").forEach((el) => el.removeAttribute("aria-invalid"));
  }

  // The first moment a number can be read from a box: "" and unreadable text count as 0 (for live totals only).
  function loose(value) {
    const n = P.readNumber(value);
    return n.value !== undefined && n.value >= 0 ? n.value : 0;
  }

  const supplierById = (id) => S().suppliers.find((s) => s.id === id) || null;
  const purchaseById = (id) => S().purchases.find((p) => p.id === id) || null;
  const summaryOf = (purchase) => P.purchaseSummary(purchase, S().supplierPayments, today(), S().advanceAllocations);

  function productOptions(selectedId) {
    const products = [...S().products].sort((a, b) => a.name.localeCompare(b.name));
    // The old inline "+ New product" choice is only kept for a saved draft that still holds a product to be created.
    // A new product is added with the "Add a new product" button (the Stock page's form, in a dialog).
    return option("", t("pur.chooseProduct"), !selectedId)
      + (selectedId === "__new__" ? option("__new__", t("pur.newProduct"), true) : "")
      + products.map((p) => option(p.id, h.productLabel(p), p.id === selectedId)).join("");
  }

  function unitOptions(selected) {
    return UNIT_CHOICES.map((u) => option(u, Calc.unitLabel(u), u === selected)).join("");
  }

  function statusBadge(purchase) {
    return badge("st-" + purchase.status, t("pur.status." + purchase.status));
  }

  function payBadge(purchase, summary) {
    if (purchase.status !== "confirmed") return "";
    let html = badge(summary.paymentStatus, t("pur.pay." + summary.paymentStatus));
    if (summary.overdue) html += " " + badge("overdue", tn("pur.overdueDays", summary.daysOverdue));
    return html;
  }

  function deliveryBadge(purchase, summary) {
    if (purchase.status !== "confirmed" || !summary.delivery.status) return "";
    return badge("dl-" + summary.delivery.status, t("pur.delivery." + summary.delivery.status));
  }

  function stat(label, value, extra) {
    return `<div class="stat${extra ? " " + extra : ""}"><span class="stat-label">${esc(label)}</span><strong>${value}</strong></div>`;
  }

  // The page title row every list and detail screen starts with: the same header Stock and Invoices use.
  function pageHeader(title, actions) {
    return `<header class="stock-header"><h1 class="stock-title">${esc(title)}</h1>${actions ? `<div class="page-actions">${actions}</div>` : ""}</header>`;
  }
  const SEARCH_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>';

  // Net balance in words: positive = we owe the supplier, negative = we prepaid, zero = square. Never colour alone.
  const balanceState = (net) => (net > 0 ? "owes" : net < 0 ? "prepaid" : "square");
  const balanceBadge = (net) => badge(balanceState(net), t("fin.state." + balanceState(net)));
  const methodName = (m) => t("dep.method." + (m === "other" ? "misc" : m));
  const balanceClass = (net) => (net > 0 ? "owed" : net < 0 ? "credit" : "");

  function sortArrow(state, key) {
    return state.sortKey === key ? (state.sortDir > 0 ? " ▲" : " ▼") : "";
  }

  // Runs a change through commit() under guard(): one transaction, no double clicks. On an error nothing was saved.
  function act(mutate, options) {
    const opts = options || {};
    return h.guard(async () => {
      const result = await h.commit(mutate);
      if (result.error) {
        const fieldId = result.field && opts.fieldMap ? opts.fieldMap[result.field] || "" : (result.field && opts.fieldPrefix ? opts.fieldPrefix + result.field : "");
        if (opts.errorId && $(opts.errorId)) showErr(opts.errorId, result.error, fieldId);
        else h.notify(result.error, "error");
        if (opts.onError) opts.onError(result);
        return;
      }
      if (opts.done) await opts.done(result);
    });
  }

  function compareBy(key, dir) {
    return (a, b) => {
      const x = a[key];
      const y = b[key];
      const r = typeof x === "string" || typeof y === "string" ? String(x || "").localeCompare(String(y || "")) : (x || 0) - (y || 0);
      return r * dir;
    };
  }

  /* ---------- Files: attachments ---------- */

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error || new Error("The file could not be read."));
      reader.readAsDataURL(file);
    });
  }

  // A picked file as an attachment record, or { error } when it is not an allowed photo/scan/PDF or is too big.
  async function attachmentFromFile(file) {
    const meta = { id: Validation.uid(), name: file.name, type: file.type, size: file.size, addedAt: new Date().toISOString() };
    const why = P.attachmentMetaProblem(meta);
    if (why) return { error: `${file.name}: ${why}` };
    try {
      return { attachment: { ...meta, dataUrl: await readFileAsDataUrl(file) } };
    } catch (e) {
      return { error: `${file.name}: ${(e && e.message) || ""}` };
    }
  }

  function dataUrlToBlob(dataUrl) {
    const comma = dataUrl.indexOf(",");
    const head = dataUrl.slice(0, comma);
    const mime = (head.match(/^data:([^;,]+)/) || [])[1] || "application/octet-stream";
    const bytes = atob(dataUrl.slice(comma + 1));
    const array = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) array[i] = bytes.charCodeAt(i);
    return new Blob([array], { type: mime });
  }

  async function openAttachment(id, download) {
    const record = await h.db.getAttachment(id);
    if (!record) { h.notify(t("pur.attachmentMissing"), "error"); return; }
    const url = URL.createObjectURL(dataUrlToBlob(record.dataUrl));
    if (download) {
      const link = document.createElement("a");
      link.href = url;
      link.download = record.name;
      document.body.appendChild(link);
      link.click();
      link.remove();
    } else {
      window.open(url, "_blank");
    }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  const sizeText = (bytes) => (bytes >= 1048576 ? num(Math.round(bytes / 10485.76) / 100) + " MB" : num(Math.max(1, Math.round(bytes / 1024))) + " KB");

  /* ---------- Printing and CSV ---------- */

  function printHtml(html, title) {
    const sheet = $("purchasePrint");
    sheet.innerHTML = html;
    const original = document.title;
    document.title = title;
    document.body.dataset.printing = "purchase";
    window.addEventListener("afterprint", () => {
      document.title = original;
      delete document.body.dataset.printing;
    }, { once: true });
    window.print();
  }

  const csvCell = (v) => {
    const s = String(v == null ? "" : v);
    // A cell that starts with = + - @ would be run as a formula by a spreadsheet; the apostrophe keeps it as text.
    const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? "'" + s : s;
    return /[",\n\r;]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
  };
  const csvRow = (cells) => cells.map(csvCell).join(",");

  /* ==========================================================================
     SUPPLIERS
     ========================================================================== */

  function supplierRows() {
    const s = S();
    const day = today();
    const q = P.normText(ui.sup.q);
    const rows = s.suppliers
      .filter((sp) => ui.sup.status === "all" || (ui.sup.status === "archived") === Boolean(sp.archived))
      .filter((sp) => !q || [sp.name, sp.contactName, sp.phone, ...P.supplierContactNames(sp), ...P.supplierPhones(sp), sp.email, sp.city, sp.taxId].some((v) => P.normText(v).includes(q)))
      .map((sp) => {
        const sum = P.supplierSummary(sp, s.purchases, s.supplierPayments, day, s.supplierDeposits, s.advanceAllocations);
        return { sp, sum, name: sp.name, total: sum.total, paid: sum.paid, outstanding: sum.outstanding, last: sum.lastPurchase, net: sum.net, advance: sum.advance, open: sum.openInvoices };
      });
    return rows.sort(compareBy(ui.sup.sortKey, ui.sup.sortDir));
  }

  function supplierSummaryStrip() {
    const o = P.overview(S(), today());
    return stat(t("sup.stat.suppliers"), `${num(o.active)}<small> / ${num(o.suppliers)}</small>`)
      + stat(t("fin.totalPurchases"), esc(money(o.total)))
      + stat(t("fin.paidToSupplier"), esc(money(o.paid)))
      + stat(t("fin.owedToSuppliers"), esc(money(o.owed)), o.owed > 0 ? "warn" : "")
      + stat(t("fin.availableAdvances"), esc(money(o.advance)), o.advance > 0 ? "credit" : "");
  }

  function supplierTableRows() {
    const rows = supplierRows();
    if (!rows.length) {
      const none = S().suppliers.length === 0;
      return `<tr class="empty-row"><td colspan="8">${esc(t(none ? "sup.empty" : "sup.noMatch"))}</td></tr>`;
    }
    return rows.map(({ sp, sum }) => {
      const archived = sp.archived ? " " + badge("st-cancelled", t("sup.status.archived")) : "";
      const overdue = sum.overdueCount ? `<div>${badge("overdue", t("sup.overdueCount", { n: sum.overdueCount }))}</div>` : "";
      const contacts = [...P.supplierContactNames(sp), sp.email].filter(Boolean);
      return `<tr data-id="${esc(sp.id)}">
        <td class="name-cell"><button type="button" class="link" data-act="sup-open" data-id="${esc(sp.id)}">${esc(sp.name)}</button>${archived}${contacts.length ? `<div class="muted small">${esc(contacts.join(", "))}</div>` : ""}</td>
        <td class="phone-cell">${P.supplierPhones(sp).map((phone) => `<div>${esc(h.ltr(phone))}</div>`).join("")}</td>
        <td class="num">${esc(money(sum.total))}</td>
        <td class="num">${esc(money(sum.paid))}</td>
        <td class="num ${balanceClass(sum.net)}">${esc(money(sum.net))}<div>${balanceBadge(sum.net)}</div></td>
        <td class="num">${num(sum.openInvoices)}${overdue}</td>
        <td class="num ${sum.advance > 0 ? "credit" : ""}">${esc(money(sum.advance))}</td>
        <td class="num"><div class="row-actions">
          <button type="button" class="btn small" data-act="sup-open" data-id="${esc(sp.id)}">${esc(t("common.view"))}</button>
          ${sp.archived ? "" : `<button type="button" class="btn small" data-act="sup-deposit" data-id="${esc(sp.id)}">${esc(t("dep.short"))}</button>
          <button type="button" class="btn small" data-act="pur-new" data-id="${esc(sp.id)}">${esc(t("sup.newPurchase"))}</button>`}
          <button type="button" class="btn small" data-act="sup-edit" data-id="${esc(sp.id)}">${esc(t("common.edit"))}</button>
        </div></td></tr>`;
    }).join("");
  }

  function refreshSupplierRows() {
    if ($("supRows")) $("supRows").innerHTML = supplierTableRows();
    if ($("supStrip")) $("supStrip").innerHTML = supplierSummaryStrip();
  }

  function supplierListHtml() {
    const th = (key, label, cls) => `<th class="${cls || ""}"><button type="button" class="th-sort" data-act="sup-sort" data-key="${key}">${esc(label)}${sortArrow(ui.sup, key)}</button></th>`;
    return `${pageHeader(t("nav.suppliers"), `<button type="button" class="btn primary" data-act="sup-add">${esc(t("sup.add"))}</button>`)}
      <div class="stat-strip" id="supStrip">${supplierSummaryStrip()}</div>
      <div class="panel stock-list">
        <div class="stock-toolbar">
          <div class="stock-search">
            ${SEARCH_ICON}
            <label class="sr-only" for="supSearch">${esc(t("sup.searchLabel"))}</label>
            <input type="search" id="supSearch" value="${esc(ui.sup.q)}" placeholder="${esc(t("sup.searchPlaceholder"))}" autocomplete="off">
          </div>
          <div class="list-filters">
            <label class="sr-only" for="supStatus">${esc(t("sup.statusFilter"))}</label>
            <select id="supStatus">${["active", "archived", "all"].map((v) => option(v, t("sup.filter." + v), ui.sup.status === v)).join("")}</select>
          </div>
        </div>
        <div class="table-wrap stock-table-wrap">
          <table class="table stock-table sup-table">
            <thead><tr>
              ${th("name", t("sup.col.name"))}
              <th>${esc(t("sup.col.phone"))}</th>
              ${th("total", t("fin.totalPurchases"), "num")}${th("paid", t("fin.paidToSupplier"), "num")}${th("net", t("fin.netBalance"), "num")}
              ${th("open", t("fin.openInvoices"), "num")}${th("advance", t("fin.availableAdvance"), "num")}
              <th class="num">${esc(t("col.actions"))}</th>
            </tr></thead>
            <tbody id="supRows">${supplierTableRows()}</tbody>
          </table>
        </div>
      </div>`;
  }

  /* ---------- Supplier form ---------- */

  const TERMS_CHOICES = [0, 15, 30];

  // The contact rows of the supplier form, as typed: { rowId, name, phone }. Kept in ui.sup.contactRows so adding and removing a
  // row redraws only the rows, never the other fields. A supplier with no contact yet shows one empty row.
  let contactSerial = 0;
  const newContactRow = (c) => ({ rowId: ++contactSerial, name: (c && c.name) || "", phone: (c && c.phone) || "" });

  function contactRowsHtml() {
    const rows = ui.sup.contactRows;
    return rows.map((row, i) => `<div class="contact-row" data-contact="${row.rowId}">
        <input type="text" class="contact-name" data-field="name" value="${esc(row.name)}" placeholder="${esc(t("sup.f.contactName"))}" aria-label="${esc(t("sup.f.contactNameN", { n: i + 1 }))}" autocomplete="off">
        <input type="text" inputmode="tel" class="contact-phone" data-field="phone" value="${esc(row.phone)}" placeholder="${esc(t("sup.f.phone"))}" aria-label="${esc(t("sup.f.phoneN", { n: i + 1 }))}" autocomplete="off">
        <button type="button" class="btn small" data-act="sup-contact-remove" data-row="${row.rowId}" aria-label="${esc(t("sup.f.removeContactN", { n: i + 1 }))}"${rows.length < 2 ? " disabled" : ""}>${esc(t("common.remove"))}</button>
      </div>`).join("");
  }

  function addContactRow() {
    if (ui.sup.contactRows.length >= P.MAX_CONTACTS) return null;
    const row = newContactRow();
    ui.sup.contactRows.push(row);
    return row;
  }

  function removeContactRow(rowId) {
    if (ui.sup.contactRows.length < 2) return false;
    ui.sup.contactRows = ui.sup.contactRows.filter((r) => String(r.rowId) !== String(rowId));
    return true;
  }

  function redrawContactRows(focusRow) {
    if ($("supContacts")) $("supContacts").innerHTML = contactRowsHtml();
    if ($("supAddContact")) $("supAddContact").disabled = ui.sup.contactRows.length >= P.MAX_CONTACTS;
    if (focusRow) {
      const box = $("supContacts") && $("supContacts").querySelector(`[data-contact="${focusRow.rowId}"] input`);
      if (box && box.focus) box.focus();
    }
  }

  function supplierFormHtml(values) {
    const v = values || {};
    // What the rows start from: a list typed in this form, a saved list, or the single contact an older supplier has.
    const start = P.supplierContacts(v);
    ui.sup.contactRows = (start.length ? start : [{}]).map(newContactRow);
    const terms = v.paymentTermsDays === undefined || v.paymentTermsDays === "" ? 0 : Number(v.paymentTermsDays);
    const custom = !TERMS_CHOICES.includes(terms);
    const text = (id, key, label, extra) => field("sf-" + id, esc(label), `<input type="text" id="sf-${id}" value="${esc(v[key] || "")}" autocomplete="off"${extra || ""}>`);
    const editing = Boolean(ui.sup.editingId);
    return `<div class="panel">
      <h2>${esc(t(editing ? "sup.editTitle" : "sup.addTitle"))}</h2>
      <form id="supplierForm" data-form="sup-save" novalidate>
        <div class="grid-2">
          ${field("sf-name", esc(t("sup.f.name")) + ' <span class="req" aria-hidden="true">*</span>', `<input type="text" id="sf-name" value="${esc(v.name || "")}" autocomplete="off" aria-required="true">`)}
          ${text("email", "email", t("sup.f.email"))}
        </div>
        <div class="field contacts-field">
          <label id="supContactsLabel">${esc(t("sup.f.contacts"))}</label>
          <p class="muted small contacts-hint">${esc(t("sup.f.contactsHint"))}</p>
          <div class="contact-rows" id="supContacts" role="group" aria-labelledby="supContactsLabel">${contactRowsHtml()}</div>
          <button type="button" class="btn small" id="supAddContact" data-act="sup-contact-add"${ui.sup.contactRows.length >= P.MAX_CONTACTS ? " disabled" : ""}>${esc(t("sup.f.addContact"))}</button>
        </div>
        ${text("address", "address", t("sup.f.address"))}
        <div class="grid-2">
          ${text("city", "city", t("sup.f.city"))}
          ${text("country", "country", t("sup.f.country"))}
        </div>
        <div class="grid-2">
          ${text("taxId", "taxId", t("sup.f.taxId"))}
          ${text("website", "website", t("sup.f.website"))}
        </div>
        <fieldset class="terms">
          <legend>${esc(t("sup.f.payment"))}</legend>
          <div class="grid-2">
            ${field("sf-terms", esc(t("sup.f.terms")), `<select id="sf-terms">
              ${option("0", t("sup.terms.immediate"), !custom && terms === 0)}${option("15", tn("sup.terms.days", 15), !custom && terms === 15)}
              ${option("30", tn("sup.terms.days", 30), !custom && terms === 30)}${option("custom", t("sup.terms.custom"), custom)}</select>`)}
            ${field("sf-termsCustom", esc(t("sup.f.termsCustom")), `<input type="number" id="sf-termsCustom" min="0" max="${P.MAX_TERMS_DAYS}" step="1" value="${custom ? esc(terms) : ""}"${custom ? "" : " disabled"}>`)}
          </div>
          <div class="grid-2">
            ${field("sf-creditLimit", esc(t("sup.f.credit")), `<input type="number" id="sf-creditLimit" min="0" step="any" value="${v.creditLimit == null ? "" : esc(v.creditLimit)}" placeholder="${esc(t("sup.f.creditPlaceholder"))}">`)}
            ${field("sf-currency", esc(t("sup.f.currency")), `<input type="text" id="sf-currency" value="${esc(editing && v.currency ? v.currency : S().settings.currency)}" disabled>`)}
          </div>
        </fieldset>
        ${field("sf-notes", esc(t("sup.f.notes")), `<textarea id="sf-notes" rows="3">${esc(v.notes || "")}</textarea>`)}
        <div class="warn-box" id="supDup" hidden></div>
        <p class="error" id="sf-error" role="alert"></p>
        <div class="actions left">
          <button type="submit" class="btn primary" id="sf-save">${esc(t("sup.save"))}</button>
          <button type="button" class="btn" data-act="sup-cancel">${esc(t("common.cancel"))}</button>
        </div>
      </form>
    </div>`;
  }

  function readSupplierForm() {
    const terms = $("sf-terms").value;
    return {
      id: ui.sup.editingId || undefined,
      name: $("sf-name").value, contacts: ui.sup.contactRows.map(({ name, phone }) => ({ name, phone })), email: $("sf-email").value,
      address: $("sf-address").value, city: $("sf-city").value, country: $("sf-country").value, taxId: $("sf-taxId").value,
      website: $("sf-website").value, paymentTermsDays: terms === "custom" ? $("sf-termsCustom").value : terms,
      creditLimit: $("sf-creditLimit").value, notes: $("sf-notes").value,
    };
  }

  function duplicateWarningHtml(duplicates) {
    const reasons = (r) => r.map((x) => t("sup.dup." + x)).join(", ");
    return `<strong>${esc(t("sup.dup.title"))}</strong>
      <ul>${duplicates.map((d) => `<li>${esc(d.supplier.name)}${d.supplier.archived ? " (" + esc(t("sup.status.archived")) + ")" : ""} — ${esc(reasons(d.reasons))}</li>`).join("")}</ul>
      <p class="small">${esc(t("sup.dup.note"))}</p>
      <div class="actions left"><button type="button" class="btn" data-act="sup-save-anyway">${esc(t("sup.dup.saveAnyway"))}</button></div>`;
  }

  function submitSupplier(allowDuplicate) {
    const input = readSupplierForm();
    clearInvalid($("supplierForm"));
    showErr("sf-error", "");
    if ($("supDup")) $("supDup").hidden = true;
    return act((d) => P.saveSupplier(d, input, { allowDuplicate }), {
      errorId: "sf-error",
      fieldPrefix: "sf-",
      done: (r) => {
        if (r.duplicates) {
          $("supDup").innerHTML = duplicateWarningHtml(r.duplicates);
          $("supDup").hidden = false;
          return;
        }
        h.notify(t(input.id ? "sup.saved" : "sup.created", { name: r.supplier.name }));
        ui.sup.profileId = r.supplier.id;
        ui.sup.screen = "profile";
        ui.sup.tab = "overview";
        renderSuppliers();
      },
    });
  }

  /* ---------- Supplier profile ---------- */

  const PROFILE_TABS = ["overview", "purchases", "payments", "deposits", "statement", "products", "documents"];

  function purchaseRowsHtml(purchases, options) {
    const opts = options || {};
    const sorted = opts.keepOrder ? [...purchases] : [...purchases].sort((a, b) => b.invoiceDate.localeCompare(a.invoiceDate) || b.reference.localeCompare(a.reference));
    if (!sorted.length) return `<tr class="empty-row"><td colspan="${opts.withSupplier ? 10 : 9}">${esc(t("pur.noneFound"))}</td></tr>`;
    return sorted.map((p) => {
      const sum = summaryOf(p);
      const sp = supplierById(p.supplierId);
      const confirmed = p.status === "confirmed";
      return `<tr data-id="${esc(p.id)}">
        <td><button type="button" class="link" data-act="pur-open" data-id="${esc(p.id)}">${esc(p.reference)}</button></td>
        <td>${esc(p.noSupplierInvoice ? t("pur.noInvoiceShort") : p.supplierInvoiceNumber)}</td>
        ${opts.withSupplier ? `<td>${esc(sp ? sp.name : "")}</td>` : ""}
        <td>${esc(fmtDay(p.invoiceDate))}</td>
        <td class="num">${num(p.lines.length)}</td>
        <td class="num ${p.status === "cancelled" ? "struck" : ""}">${esc(money(p.total))}</td>
        <td class="num">${confirmed ? esc(money(sum.paid)) : ""}</td>
        <td class="num ${confirmed && sum.outstanding > 0 ? "owed" : ""}">${confirmed ? esc(money(sum.outstanding)) : ""}</td>
        <td>${statusBadge(p)} ${payBadge(p, sum)} ${deliveryBadge(p, sum)}${confirmed && sum.advanceApplied > 0 ? `<div class="muted small">${esc(t("adv.appliedShort", { amount: money(sum.advanceApplied) }))}</div>` : ""}</td>
        <td class="num"><div class="row-actions"><button type="button" class="btn small" data-act="pur-open" data-id="${esc(p.id)}">${esc(p.status === "draft" ? t("common.edit") : t("common.view"))}</button><button type="button" class="btn small danger" data-act="pur-delete" data-id="${esc(p.id)}">${esc(t("common.delete"))}</button></div></td>
      </tr>`;
    }).join("");
  }

  function purchaseTableHead(withSupplier, sortable) {
    const th = (key, label, cls) => (sortable
      ? `<th class="${cls || ""}"><button type="button" class="th-sort" data-act="pur-sort" data-key="${key}">${esc(label)}${sortArrow(ui.pur, key)}</button></th>`
      : `<th class="${cls || ""}">${esc(label)}</th>`);
    return `<thead><tr>${th("reference", t("pur.col.reference"))}<th>${esc(t("pur.col.invoiceNo"))}</th>${withSupplier ? th("supplier", t("pur.col.supplier")) : ""}
      ${th("date", t("pur.col.date"))}<th class="num">${esc(t("pur.col.items"))}</th>${th("total", t("col.total"), "num")}
      ${th("paid", t("col.paid"), "num")}${th("outstanding", t("pur.col.outstanding"), "num")}
      <th>${esc(t("col.status"))}</th><th class="num">${esc(t("col.actions"))}</th></tr></thead>`;
  }

  function paymentRowsHtml(rows, options) {
    const opts = options || {};
    if (!rows.length) return `<tr class="empty-row"><td colspan="${opts.withSupplier ? 6 : 5}">${esc(t("spay.none"))}</td></tr>`;
    return rows.map(({ payment: p, purchase, supplier }) => `<tr${p.status === "voided" ? ' class="voided"' : ""}>
      <td>${esc(fmtDay(p.date))}</td>
      ${opts.withSupplier ? `<td>${esc(supplier ? supplier.name : "")}</td>` : ""}
      <td>${purchase ? `<button type="button" class="link" data-act="pur-open" data-id="${esc(purchase.id)}">${esc(purchase.reference)}</button>` : ""}</td>
      <td class="num">${esc(money(p.amount))}</td>
      <td>${esc(p.reference)}${p.note ? `<div class="muted small">${esc(p.note)}</div>` : ""}${p.status === "voided" ? `<div class="small">${esc(t("spay.voidedBecause", { reason: p.voidReason }))}</div>` : ""}</td>
      <td>${p.status === "voided" ? badge("st-cancelled", t("spay.voided")) : (p.history && p.history.length ? badge("info", t("spay.edited")) : "")}</td>
    </tr>`).join("");
  }

  function supplierPaymentRows(supplierId) {
    const s = S();
    return s.supplierPayments
      .filter((p) => p.supplierId === supplierId)
      .map((payment) => ({ payment, purchase: purchaseById(payment.purchaseId), supplier: supplierById(supplierId) }))
      .sort((a, b) => b.payment.date.localeCompare(a.payment.date) || b.payment.createdAt.localeCompare(a.payment.createdAt));
  }

  function profileOverview(sp, sum) {
    const line = (label, value) => (value ? `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>` : "");
    const terms = sp.paymentTermsDays === 0 ? t("sup.terms.immediate") : tn("sup.terms.days", sp.paymentTermsDays);
    const place = [sp.city, sp.country].filter(Boolean).join(", ");
    const site = sp.website ? `<dt>${esc(t("sup.f.website"))}</dt><dd>${esc(sp.website)}</dd>` : "";
    return `<div class="stat-strip">
        ${stat(t("fin.totalPurchases"), esc(money(sum.total)))}${stat(t("fin.paidToSupplier"), esc(money(sum.paid)))}
        ${stat(t("fin.outstandingInvoices"), esc(money(sum.outstanding)) + `<span class="state">${esc(t("fin.openCount", { n: sum.openInvoices }))}</span>`, sum.outstanding > 0 ? "warn" : "")}
        ${stat(t("fin.netBalance"), esc(money(sum.net)) + `<span class="state">${esc(t("fin.state." + balanceState(sum.net)))}</span>`, sum.net > 0 ? "warn" : sum.net < 0 ? "credit" : "")}
        ${stat(t("fin.availableAdvance"), esc(money(sum.advance)), sum.advance > 0 ? "credit" : "")}
        ${sum.overdueTotal > 0 ? stat(t("sup.stat.overdueAmount"), esc(money(sum.overdueTotal)), "bad") : ""}
      </div>
      <p class="muted balance-note">${esc(t("fin.formulaNote"))}</p>
      ${sum.unapplied > 0 ? `<p class="notice">${esc(t(sum.openInvoices > 0 ? "fin.unappliedOpen" : "fin.unappliedFree", { amount: money(sum.unapplied) }))}</p>` : ""}
      ${sum.overLimit ? `<p class="warn-box">${esc(t("sup.overLimit", { owed: money(sum.owed), limit: money(sum.creditLimit) }))}</p>` : ""}
      <div class="panel">
        <h2>${esc(t("sup.details"))}</h2>
        <dl class="data-info">
          ${P.supplierContacts(sp).map((c) => line(c.name ? t("sup.f.contact") : t("sup.f.phone"), [c.name, h.ltr(c.phone)].filter(Boolean).join(" · "))).join("")}${line(t("sup.f.email"), sp.email)}
          ${line(t("sup.f.address"), sp.address)}${line(t("sup.f.cityCountry"), place)}${line(t("sup.f.taxId"), sp.taxId)}${site}
          <dt>${esc(t("sup.f.terms"))}</dt><dd>${esc(terms)}</dd>
          <dt>${esc(t("sup.f.credit"))}</dt><dd>${esc(sp.creditLimit == null ? t("sup.noLimit") : money(sp.creditLimit))}</dd>
          <dt>${esc(t("sup.f.currency"))}</dt><dd>${esc(sp.currency || S().settings.currency)}</dd>
          <dt>${esc(t("sup.purchaseCount"))}</dt><dd>${num(sum.count)}</dd>
        </dl>
      </div>`;
  }

  function profilePayments(sp) {
    const open = S().purchases
      .filter((p) => p.supplierId === sp.id && p.status === "confirmed")
      .map((p) => ({ p, sum: summaryOf(p) }))
      .filter((x) => x.sum.outstanding > 0)
      .sort((a, b) => a.p.dueDate.localeCompare(b.p.dueDate));
    const form = open.length
      ? `<form id="supPayForm" data-form="sup-pay" novalidate>
          <h3>${esc(t("spay.record"))}</h3>
          <div class="grid-4">
            ${field("spPurchase", esc(t("spay.forPurchase")), `<select id="spPurchase">${open.map(({ p, sum }) => option(p.id, `${p.reference} · ${p.noSupplierInvoice ? t("pur.noInvoiceShort") : p.supplierInvoiceNumber} · ${t("spay.owing", { amount: money(sum.outstanding) })}`, false)).join("")}</select>`)}
            ${field("spAmount", esc(t("spay.amount")), `<input type="number" id="spAmount" min="0" step="any" placeholder="${esc(t("spay.amountHint"))}">`)}
            ${field("spDate", esc(t("spay.date")), `<input type="date" id="spDate" value="${today()}" max="${today()}">`)}
            ${field("spRef", esc(t("spay.reference")), `<input type="text" id="spRef" autocomplete="off">`)}
          </div>
          ${field("spNote", esc(t("spay.note")), `<input type="text" id="spNote" autocomplete="off">`)}
          <p class="error" id="spError" role="alert"></p>
          <div class="actions left"><button type="submit" class="btn primary">${esc(t("spay.recordBtn"))}</button></div>
        </form>`
      : `<p class="muted">${esc(t("spay.nothingOwed"))}</p>`;
    return `<div class="panel">${form}</div>
      <div class="panel"><h2>${esc(t("spay.history"))}</h2>
        <div class="table-wrap"><table class="table"><thead><tr><th>${esc(t("spay.date"))}</th><th>${esc(t("pur.col.reference"))}</th><th class="num">${esc(t("spay.amount"))}</th><th>${esc(t("spay.reference"))}</th><th></th></tr></thead>
        <tbody>${paymentRowsHtml(supplierPaymentRows(sp.id))}</tbody></table></div></div>`;
  }

  function profileProducts(sp) {
    const rows = P.supplierProducts(S(), sp.id);
    return `<div class="panel"><h2>${esc(t("sup.tab.products"))}</h2>
      <div class="table-wrap"><table class="table"><thead><tr><th>${esc(t("col.product"))}</th><th class="num">${esc(t("sup.prod.times"))}</th>
        <th class="num">${esc(t("sup.prod.qty"))}</th><th class="num">${esc(t("sup.prod.spent"))}</th><th class="num">${esc(t("sup.prod.lastPrice"))}</th><th>${esc(t("sup.prod.lastDate"))}</th></tr></thead>
      <tbody>${rows.length ? rows.map((r) => `<tr><td><button type="button" class="link" data-act="pur-history" data-id="${esc(r.productId)}">${esc(r.name)}</button></td>
        <td class="num">${num(r.count)}</td><td class="num">${esc(stockQtyText(r.baseQty, r.stockUnit))}</td><td class="num">${esc(money(r.spent))}</td>
        <td class="num">${esc(money(r.last.unitPrice))} / ${esc(unitName(r.last.unit))}</td><td>${esc(fmtDay(r.last.date))}</td></tr>`).join("")
        : `<tr class="empty-row"><td colspan="6">${esc(t("sup.prod.none"))}</td></tr>`}</tbody></table></div></div>`;
  }

  function profileDocuments(sp) {
    const docs = [];
    for (const p of S().purchases) {
      if (p.supplierId !== sp.id) continue;
      for (const a of p.attachments || []) docs.push({ a, p });
    }
    docs.sort((x, y) => (y.a.addedAt || "").localeCompare(x.a.addedAt || ""));
    return `<div class="panel"><h2>${esc(t("sup.notes"))}</h2>
        ${sp.notes ? `<p class="prewrap">${esc(sp.notes)}</p>` : `<p class="muted">${esc(t("sup.notesNone"))}</p>`}
        <div class="actions left"><button type="button" class="btn" data-act="sup-edit" data-id="${esc(sp.id)}">${esc(t("sup.editNotes"))}</button></div></div>
      <div class="panel"><h2>${esc(t("sup.documents"))}</h2>
        ${docs.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>${esc(t("pur.att.name"))}</th><th>${esc(t("pur.col.reference"))}</th><th>${esc(t("pur.att.size"))}</th><th></th></tr></thead><tbody>
          ${docs.map(({ a, p }) => `<tr><td>${esc(a.name)}</td><td><button type="button" class="link" data-act="pur-open" data-id="${esc(p.id)}">${esc(p.reference)}</button></td><td>${esc(sizeText(a.size))}</td>
          <td class="num"><button type="button" class="btn small" data-act="att-open" data-id="${esc(a.id)}">${esc(t("pur.att.open"))}</button></td></tr>`).join("")}</tbody></table></div>`
        : `<p class="muted">${esc(t("sup.documentsNone"))}</p>`}</div>`;
  }

  /* ---------- Supplier deposits and the statement ---------- */

  function depositFormHtml(x) {
    const editing = Boolean(x);
    const v = x || { kind: "deposit", amount: "", date: today(), method: "", reference: "", note: "" };
    return `<form id="supDepForm" class="deposit-form" data-form="sup-deposit" novalidate>
        <h3>${esc(t(editing ? "dep.editTitle" : "dep.title"))}</h3>
        <p class="muted small">${esc(t("dep.help"))}</p>
        <div class="grid-4">
          ${editing ? "" : field("dpType", esc(t("dep.type")), `<select id="dpType">${["deposit", "refund"].map((k) => option(k, t("dep.kind." + k), v.kind === k)).join("")}</select>`)}
          ${field("dpAmount", esc(t("spay.amount")), `<input type="number" id="dpAmount" min="0" step="any" value="${editing ? esc(v.amount) : ""}" placeholder="0">`)}
          ${field("dpDate", esc(t("spay.date")), `<input type="date" id="dpDate" value="${esc(v.date)}" max="${today()}">`)}
          ${field("dpMethod", esc(t("dep.method")), `<select id="dpMethod">${option("", t("dep.method.none"), !v.method)}${P.PAYMENT_METHODS.map((m) => option(m, methodName(m), v.method === m)).join("")}</select>`)}
        </div>
        <div class="grid-2">
          ${field("dpRef", esc(t("spay.reference")), `<input type="text" id="dpRef" value="${esc(v.reference || "")}" autocomplete="off">`)}
          ${field("dpNote", esc(t("spay.note")), `<input type="text" id="dpNote" value="${esc(v.note || "")}" autocomplete="off">`)}
        </div>
        <p class="error" id="dpError" role="alert"></p>
        <div class="actions left"><button type="submit" class="btn primary">${esc(t(editing ? "spay.saveChange" : "dep.save"))}</button>
          ${editing ? `<button type="button" class="btn" data-act="sup-dep-cancel">${esc(t("common.cancel"))}</button>` : ""}</div>
      </form>`;
  }

  function supplierDepositRows(supplierId) {
    return S().supplierDeposits
      .filter((x) => x.supplierId === supplierId)
      .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  }

  function profileDeposits(sp, sum) {
    const rows = supplierDepositRows(sp.id);
    const editing = ui.sup.editDepositId ? rows.find((x) => x.id === ui.sup.editDepositId && x.status === "recorded") : null;
    const left = P.depositRemaining(sp.id, S().supplierDeposits, S().advanceAllocations);
    const body = rows.map((x) => {
      if (ui.sup.voidDepositId === x.id) {
        return `<tr><td colspan="7"><form data-form="sup-dep-void" novalidate>
          <p>${esc(t("dep.voidAsk", { amount: money(x.amount), date: fmtDay(x.date) }))}</p>
          ${field("dvReason", esc(t("spay.voidReason")), `<input type="text" id="dvReason" autocomplete="off">`)}
          <p class="error" id="dvError" role="alert"></p>
          <div class="actions left"><button type="submit" class="btn danger">${esc(t("dep.voidBtn"))}</button><button type="button" class="btn" data-act="sup-dep-cancel">${esc(t("common.cancel"))}</button></div></form></td></tr>`;
      }
      const applied = x.kind === "refund" || x.status === "voided" ? "" : `${esc(money(round(x.amount - (left.get(x.id) || 0))))}<div class="muted small">${esc(t("dep.stillUnapplied", { amount: money(left.get(x.id) || 0) }))}</div>`;
      const was = (x.history || []).map((hh) => `<div class="muted small">${esc(t("spay.was", { amount: money(hh.amount), date: fmtDay(hh.date) }))}</div>`).join("");
      return `<tr${x.status === "voided" ? ' class="voided"' : ""}>
        <td>${esc(fmtDay(x.date))}</td>
        <td>${badge("dep-" + x.kind, t("dep.kind." + x.kind))}</td>
        <td class="num">${esc(money(x.amount))}</td>
        <td>${esc(x.method ? methodName(x.method) : "")}</td>
        <td>${esc(x.reference)}${x.note ? `<div class="muted small">${esc(x.note)}</div>` : ""}${was}${x.status === "voided" ? `<div class="small">${esc(t("spay.voidedBecause", { reason: x.voidReason }))}</div>` : ""}</td>
        <td class="num">${applied}</td>
        <td class="num">${x.status === "voided" ? badge("st-cancelled", t("spay.voided")) : `<div class="row-actions"><button type="button" class="btn small" data-act="sup-dep-edit" data-id="${esc(x.id)}">${esc(t("common.edit"))}</button>
          <button type="button" class="btn small danger" data-act="sup-dep-void" data-id="${esc(x.id)}">${esc(t("spay.void"))}</button></div>`}</td>
      </tr>`;
    }).join("");
    const allocs = S().advanceAllocations.filter((a) => a.supplierId === sp.id)
      .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
    const allocBody = allocs.map((a) => {
      const purchase = purchaseById(a.purchaseId);
      const from = S().supplierDeposits.find((x) => x.id === a.depositId);
      return `<tr${a.status === "reversed" ? ' class="voided"' : ""}><td>${esc(fmtDay(a.date))}</td>
        <td>${purchase ? `<button type="button" class="link" data-act="pur-open" data-id="${esc(purchase.id)}">${esc(purchase.reference)}</button>` : ""}</td>
        <td class="num">${esc(money(a.amount))}</td><td>${from ? esc(t("dep.fromDeposit", { date: fmtDay(from.date), amount: money(from.amount) })) : ""}</td>
        <td>${a.status === "reversed" ? badge("st-cancelled", t("adv.reversed")) + `<div class="small">${esc(t("spay.voidedBecause", { reason: a.reverseReason }))}</div>` : ""}</td></tr>`;
    }).join("");
    return `<div class="stat-strip small">${stat(t("dep.stat.deposited"), esc(money(sum.deposited)))}${stat(t("dep.stat.refunded"), esc(money(sum.refunded)))}
        ${stat(t("dep.stat.applied"), esc(money(sum.applied)))}${stat(t("fin.unapplied"), esc(money(sum.unapplied)), sum.unapplied > 0 ? "credit" : "")}</div>
      <div class="panel">${depositFormHtml(editing)}</div>
      <div class="panel"><h2>${esc(t("dep.history"))}</h2>
        <div class="table-wrap stock-table-wrap"><table class="table stock-table"><thead><tr><th>${esc(t("spay.date"))}</th><th>${esc(t("dep.type"))}</th><th class="num">${esc(t("spay.amount"))}</th><th>${esc(t("dep.method"))}</th><th>${esc(t("spay.reference"))}</th><th class="num">${esc(t("dep.appliedCol"))}</th><th></th></tr></thead>
        <tbody>${body || `<tr class="empty-row"><td colspan="7">${esc(t("dep.none"))}</td></tr>`}</tbody></table></div></div>
      ${allocs.length ? `<div class="panel"><h2>${esc(t("adv.history"))}</h2><p class="muted small">${esc(t("adv.historyNote"))}</p>
        <div class="table-wrap stock-table-wrap"><table class="table stock-table"><thead><tr><th>${esc(t("spay.date"))}</th><th>${esc(t("pur.col.reference"))}</th><th class="num">${esc(t("spay.amount"))}</th><th>${esc(t("adv.from"))}</th><th></th></tr></thead><tbody>${allocBody}</tbody></table></div></div>` : ""}`;
  }

  // Everything that moved money with this supplier, oldest first, with the net balance after each line.
  function ledgerRowsHtml(rows) {
    if (!rows.length) return `<tr class="empty-row"><td colspan="5">${esc(t("led.none"))}</td></tr>`;
    return rows.map((r) => {
      const what = [];
      if (r.purchaseId && r.ref) what.push(`<button type="button" class="link" data-act="pur-open" data-id="${esc(r.purchaseId)}">${esc(r.ref)}</button>`);
      if (r.type === "purchase" && r.reference) what.push(esc(r.reference));
      else if (r.type !== "purchase" && r.reference) what.push(esc(r.reference));
      if (r.method) what.push(esc(methodName(r.method)));
      const note = r.note ? `<div class="muted small">${esc(r.note)}</div>` : "";
      const amount = r.type === "allocation" ? `<span class="muted">${esc(money(r.amount))}</span>` : esc((r.effect > 0 ? "+" : r.effect < 0 ? "−" : "") + money(Math.abs(r.status === "voided" ? r.amount : r.effect)));
      return `<tr${r.status === "voided" ? ' class="voided"' : ""}><td>${esc(fmtDay(r.date))}</td>
        <td>${badge("dep-" + r.type, t("led.type." + r.type))}${r.status === "voided" ? " " + badge("st-cancelled", t("led.voided")) : ""}${r.type === "allocation" ? `<div class="muted small">${esc(t("led.noChange"))}</div>` : ""}</td>
        <td>${what.join(" · ")}${note}</td><td class="num">${amount}</td><td class="num ${balanceClass(r.balance)}">${r.status === "voided" ? "" : esc(money(r.balance))}</td></tr>`;
    }).join("");
  }

  function profileStatement(sp) {
    const rows = P.supplierLedger(S(), sp.id);
    return `<div class="panel"><h2>${esc(t("led.title"))}</h2><p class="muted small">${esc(t("led.note"))}</p>
      <div class="table-wrap stock-table-wrap"><table class="table stock-table"><thead><tr><th>${esc(t("spay.date"))}</th><th>${esc(t("led.col.type"))}</th><th>${esc(t("led.col.details"))}</th><th class="num">${esc(t("spay.amount"))}</th><th class="num">${esc(t("fin.netBalance"))}</th></tr></thead>
      <tbody>${ledgerRowsHtml(rows)}</tbody></table></div></div>`;
  }

  const round = (n) => Calc.roundMoney(n);

  function supplierProfileHtml(sp) {
    const sum = P.supplierSummary(sp, S().purchases, S().supplierPayments, today(), S().supplierDeposits, S().advanceAllocations);
    const mine = S().purchases.filter((p) => p.supplierId === sp.id);
    const hasHistory = P.supplierHasHistory(S(), sp.id);
    const tabs = PROFILE_TABS.map((k) => `<button type="button" class="tab" role="tab" aria-selected="${ui.sup.tab === k}" data-act="sup-tab" data-tab="${k}">${esc(t("sup.tab." + k))}</button>`).join("");
    let body = "";
    if (ui.sup.tab === "overview") body = profileOverview(sp, sum);
    else if (ui.sup.tab === "purchases") body = `<div class="panel"><div class="table-wrap"><table class="table">${purchaseTableHead(false)}<tbody>${purchaseRowsHtml(mine)}</tbody></table></div></div>`;
    else if (ui.sup.tab === "payments") body = profilePayments(sp);
    else if (ui.sup.tab === "deposits") body = profileDeposits(sp, sum);
    else if (ui.sup.tab === "statement") body = profileStatement(sp);
    else if (ui.sup.tab === "products") body = profileProducts(sp);
    else body = profileDocuments(sp);
    return `${pageHeader(t("nav.suppliers"))}<div class="panel profile-head">
        <div><button type="button" class="link back" data-act="sup-back"><span class="dir-arrow">←</span> ${esc(t("sup.title"))}</button>
          <h2>${esc(sp.name)} ${sp.archived ? badge("st-cancelled", t("sup.status.archived")) : ""}</h2></div>
        <div class="actions wrap">
          ${sp.archived ? "" : `<button type="button" class="btn primary" data-act="pur-new" data-id="${esc(sp.id)}">${esc(t("sup.newPurchase"))}</button>`}
          ${sp.archived ? "" : `<button type="button" class="btn" data-act="sup-tab" data-tab="deposits">${esc(t("dep.short"))}</button>`}
          <button type="button" class="btn" data-act="sup-tab" data-tab="payments">${esc(t("spay.recordShort"))}</button>
          <button type="button" class="btn" data-act="sup-edit" data-id="${esc(sp.id)}">${esc(t("common.edit"))}</button>
          <button type="button" class="btn" data-act="sup-csv" data-id="${esc(sp.id)}">${esc(t("sup.exportCsv"))}</button>
          <button type="button" class="btn" data-act="sup-print" data-id="${esc(sp.id)}">${esc(t("sup.print"))}</button>
          <button type="button" class="btn" data-act="sup-archive" data-id="${esc(sp.id)}">${esc(t(sp.archived ? "sup.restore" : "sup.archive"))}</button>
          ${hasHistory ? "" : `<button type="button" class="btn danger" data-act="sup-delete" data-id="${esc(sp.id)}">${esc(t("common.delete"))}</button>`}
        </div>
      </div>
      <div class="tabs" role="tablist">${tabs}</div>
      ${body}`;
  }

  /* ---------- Supplier statement (print and CSV) ---------- */

  function supplierStatement(sp) {
    const s = S();
    const sum = P.supplierSummary(sp, s.purchases, s.supplierPayments, today(), s.supplierDeposits, s.advanceAllocations);
    const purchases = s.purchases.filter((p) => p.supplierId === sp.id && p.status === "confirmed")
      .sort((a, b) => a.invoiceDate.localeCompare(b.invoiceDate) || a.reference.localeCompare(b.reference));
    return { sum, purchases, payments: supplierPaymentRows(sp.id).filter((r) => r.payment.status !== "voided"), deposits: supplierDepositRows(sp.id).filter((x) => x.status !== "voided") };
  }

  function supplierCsv(sp) {
    const { sum, purchases, payments } = supplierStatement(sp);
    const rows = [
      csvRow([t("sup.csv.supplier"), sp.name]),
      csvRow([t("sup.csv.date"), fmtDay(today())]),
      csvRow([t("fin.totalPurchases"), sum.total, t("fin.paidToSupplier"), sum.paid, t("fin.outstandingInvoices"), sum.outstanding]),
      csvRow([t("fin.netBalance"), sum.net, t("fin.availableAdvance"), sum.advance, t("fin.unapplied"), sum.unapplied]),
      "",
      csvRow([t("pur.col.reference"), t("pur.col.invoiceNo"), t("pur.col.date"), t("pur.col.due"), t("col.total"), t("col.paid"), t("pur.col.outstanding"), t("col.status")]),
    ];
    for (const p of purchases) {
      const x = summaryOf(p);
      rows.push(csvRow([p.reference, p.supplierInvoiceNumber, p.invoiceDate, p.dueDate, p.total, x.paid, x.outstanding, t("pur.pay." + x.paymentStatus)]));
    }
    rows.push("", csvRow([t("spay.date"), t("led.col.type"), t("pur.col.reference"), t("dep.method"), t("spay.reference"), t("spay.amount"), t("fin.netBalance"), t("spay.note")]));
    for (const r of P.supplierLedger(S(), sp.id)) {
      rows.push(csvRow([r.date, t("led.type." + r.type) + (r.status === "voided" ? " (" + t("led.voided") + ")" : ""), r.ref || "", r.method ? methodName(r.method) : "", r.reference || "", r.type === "allocation" ? r.amount : r.effect, r.status === "voided" ? "" : r.balance, r.note || ""]));
    }
    return "﻿" + rows.join("\r\n") + "\r\n";
  }

  function businessHeader() {
    const st = S().settings;
    const line = (v) => (v ? `<div>${esc(v)}</div>` : "");
    const logo = st.logo ? `<img class="inv-logo" src="${esc(st.logo)}" alt="">` : "";
    const phones = Validation.businessPhones(st);
    const phoneLine = phones.length > 1
      ? `<div class="inv-phones">${phones.map((p) => `<span class="inv-phone">${esc(h.ltr(p))}</span>`).join('<span class="inv-sep"> · </span>')}</div>`
      : line(h.ltr(phones[0]));
    return `<div>${logo}<div class="inv-biz-name">${esc(st.businessName)}</div>${line(st.address)}${phoneLine}${line(st.email)}</div>`;
  }

  function supplierStatementHtml(sp) {
    const { sum, purchases, payments, deposits } = supplierStatement(sp);
    return `<header class="inv-head">${businessHeader()}<div class="inv-title">${esc(t("sup.statement"))}</div></header>
      <div class="inv-meta"><div><div class="label">${esc(t("pur.col.supplier"))}</div><div class="inv-customer">${esc(sp.name)}${P.supplierPhones(sp).length ? "\n" + esc(P.supplierPhones(sp).map(h.ltr).join(" · ")) : ""}${sp.address ? "\n" + esc(sp.address) : ""}</div></div>
      <div class="right"><div><span class="label">${esc(t("sup.csv.date"))}</span> ${esc(fmtDay(today()))}</div></div></div>
      <table class="inv-table"><thead><tr><th>${esc(t("pur.col.reference"))}</th><th>${esc(t("pur.col.invoiceNo"))}</th><th>${esc(t("pur.col.date"))}</th><th class="num">${esc(t("col.total"))}</th><th class="num">${esc(t("col.paid"))}</th><th class="num">${esc(t("pur.col.outstanding"))}</th></tr></thead>
      <tbody>${purchases.map((p) => { const x = summaryOf(p); return `<tr><td>${esc(p.reference)}</td><td>${esc(p.supplierInvoiceNumber)}</td><td>${esc(fmtDay(p.invoiceDate))}</td><td class="num">${esc(num(p.total))}</td><td class="num">${esc(num(x.paid))}</td><td class="num">${esc(num(x.outstanding))}</td></tr>`; }).join("") || `<tr><td colspan="6" class="none">${esc(t("pur.noneFound"))}</td></tr>`}</tbody></table>
      <table class="inv-totals"><tr><td>${esc(t("fin.totalPurchases"))}</td><td>${esc(money(sum.total))}</td></tr><tr><td>${esc(t("fin.paidToSupplier"))}</td><td>${esc(money(sum.paid))}</td></tr>
      <tr><td>${esc(t("fin.outstandingInvoices"))}</td><td>${esc(money(sum.outstanding))}</td></tr>
      <tr class="grand"><td>${esc(t("fin.netBalance"))} (${esc(t("fin.state." + balanceState(sum.net)))})</td><td>${esc(money(sum.net))}</td></tr>
      ${sum.advance > 0 ? `<tr><td>${esc(t("fin.availableAdvance"))}</td><td>${esc(money(sum.advance))}</td></tr>` : ""}</table>
      <section class="inv-payments"><h3>${esc(t("spay.history"))}</h3>${payments.length ? payments.map(({ payment: p, purchase }) => `<div class="inv-pay"><span class="when">${esc(fmtDay(p.date))} · ${esc(purchase ? purchase.reference : "")}</span><span>${esc(money(p.amount))}</span></div>`).join("") : `<div class="inv-pay"><span class="when">${esc(t("spay.none"))}</span></div>`}</section>
      <section class="inv-payments"><h3>${esc(t("dep.history"))}</h3>${deposits.length ? deposits.map((x) => `<div class="inv-pay"><span class="when">${esc(fmtDay(x.date))} · ${esc(t("dep.kind." + x.kind))}</span><span>${esc(money(x.amount))}</span></div>`).join("") : `<div class="inv-pay"><span class="when">${esc(t("dep.none"))}</span></div>`}</section>`;
  }

  /* ---------- Supplier screens: rendering and actions ---------- */

  function renderSuppliers() {
    const root = $("suppliersRoot");
    if (!root) return;
    const s = ui.sup;
    if (s.screen === "profile" && !supplierById(s.profileId)) { s.screen = "list"; s.profileId = null; }
    if (s.screen === "form") {
      const existing = s.editingId ? supplierById(s.editingId) : null;
      if (s.editingId && !existing) { s.screen = "list"; s.editingId = null; }
      else {
        const language = I18n.language();
        if (s.formReady && s.formLang === language && $("supplierForm")) return;   // keep what is typed
        const values = s.formReady && $("sf-name") ? readSupplierForm() : (existing || {});
        root.innerHTML = pageHeader(t("nav.suppliers")) + supplierFormHtml(values);
        s.formReady = true;
        s.formLang = language;
        return;
      }
    }
    s.formReady = false;
    root.innerHTML = s.screen === "profile" ? supplierProfileHtml(supplierById(s.profileId)) : supplierListHtml();
  }

  function openSupplier(id, tab) {
    ui.sup.screen = "profile";
    ui.sup.profileId = id;
    ui.sup.tab = tab || "overview";
    if (S().view !== "suppliers") h.showView("suppliers");
    else renderSuppliers();
  }

  function submitSupplierPayment() {
    const purchaseId = $("spPurchase").value;
    const input = { amount: $("spAmount").value, date: $("spDate").value, reference: $("spRef").value, note: $("spNote").value };
    showErr("spError", "");
    return act((d) => P.recordPayment(d, purchaseId, input), {
      errorId: "spError", fieldPrefix: "sp",
      done: () => { h.notify(t("spay.recorded")); renderSuppliers(); },
    });
  }

  function submitDeposit() {
    const sp = supplierById(ui.sup.profileId);
    if (!sp) return;
    const editId = ui.sup.editDepositId;
    const input = { supplierId: sp.id, amount: $("dpAmount").value, date: $("dpDate").value, method: $("dpMethod").value, reference: $("dpRef").value, note: $("dpNote").value };
    const fieldMap = { amount: "dpAmount", date: "dpDate", method: "dpMethod", reference: "dpRef", note: "dpNote" };
    showErr("dpError", "");
    if (editId) {
      return act((d) => P.updateDeposit(d, editId, input), {
        errorId: "dpError", fieldMap,
        done: () => { h.notify(t("dep.changed")); ui.sup.editDepositId = ""; renderSuppliers(); },
      });
    }
    input.kind = $("dpType").value;
    // One id per form: pressing the button twice, or retrying after a hiccup, finds the first record instead of adding a second.
    if (!ui.sup.depositNonce) ui.sup.depositNonce = Validation.uid();
    input.id = ui.sup.depositNonce;
    return act((d) => P.recordDeposit(d, input), {
      errorId: "dpError", fieldMap,
      done: (r) => { h.notify(t(r.already ? "dep.alreadyRecorded" : input.kind === "refund" ? "dep.refundRecorded" : "dep.recorded")); ui.sup.depositNonce = ""; renderSuppliers(); },
    });
  }

  function submitDepositVoid() {
    const id = ui.sup.voidDepositId;
    const reason = $("dvReason").value;
    return act((d) => P.voidDeposit(d, id, reason), {
      errorId: "dvError", fieldMap: { reason: "dvReason" },
      done: () => { h.notify(t("dep.voidedDone")); ui.sup.voidDepositId = ""; renderSuppliers(); },
    });
  }

  function archiveSupplier(id) {
    const sp = supplierById(id);
    if (!sp) return;
    if (!sp.archived && !confirm(t("sup.confirmArchive", { name: sp.name }))) return;
    return act((d) => P.setSupplierArchived(d, id, !sp.archived), {
      done: () => { h.notify(t(sp.archived ? "sup.restored" : "sup.archived", { name: sp.name })); renderSuppliers(); },
    });
  }

  function removeSupplier(id) {
    const sp = supplierById(id);
    if (!sp || !confirm(t("sup.confirmDelete", { name: sp.name }))) return;
    return act((d) => P.deleteSupplier(d, id), {
      done: () => { h.notify(t("sup.deleted", { name: sp.name })); ui.sup.screen = "list"; ui.sup.profileId = null; renderSuppliers(); },
    });
  }

  // Deletes a purchase for good (the list's Delete button and the detail page). The question says what will go; the
  // change itself is one transaction (see Purchases.deletePurchase). A purchase that is already gone is only reported.
  function removePurchase(id) {
    const p = purchaseById(id);
    if (!p) { h.notify(t("pur.alreadyDeleted")); render(); return; }
    const sp = supplierById(p.supplierId);
    let question = t("pur.deleteAsk", { ref: p.reference, supplier: sp ? sp.name : "", total: money(p.total) });
    if (p.status === "draft") {
      question = t("pur.deleteDraftAsk", { ref: p.reference });
    } else {
      const preview = P.deletionPreview(S(), id);
      if (preview.stockOut.length) question += "\n\n" + t("pur.deleteAskStock") + "\n" + preview.stockOut.map((x) => `- ${x.name}: ${num(x.qty)} ${x.unit}`).join("\n");
      if (preview.paymentCount) question += "\n\n" + t("pur.deleteAskPayments", { n: preview.paymentCount, amount: money(preview.paid) });
      if (preview.advanceReturned > 0) question += "\n\n" + t("adv.deleteAsk", { amount: money(preview.advanceReturned) });
      question += "\n\n" + t("pur.deleteAskEnd");
    }
    if (!confirm(question)) return;
    return act((d) => P.deletePurchase(d, id), {
      done: (r) => {
        h.notify(t(r.already ? "pur.alreadyDeleted" : "pur.deleted", { ref: p.reference }));
        if (ui.pur.detailId === id) { ui.pur.screen = "list"; ui.pur.detailId = null; ui.pur.open = ""; }
        render();
      },
    });
  }

  /* ==========================================================================
     PURCHASES: list and reports
     ========================================================================== */

  function filteredPurchases() {
    const f = ui.pur;
    const q = P.normText(f.q);
    return S().purchases.filter((p) => {
      if (f.status !== "all" && p.status !== f.status) return false;
      if (f.supplierId && p.supplierId !== f.supplierId) return false;
      if (f.from && p.invoiceDate < f.from) return false;
      if (f.to && p.invoiceDate > f.to) return false;
      if (f.pay !== "all") {
        if (p.status !== "confirmed") return false;
        const sum = summaryOf(p);
        if (f.pay === "overdue" ? !sum.overdue : sum.paymentStatus !== f.pay) return false;
      }
      if (q) {
        const sp = supplierById(p.supplierId);
        if (![p.reference, p.supplierInvoiceNumber, sp ? sp.name : ""].some((v) => P.normText(v).includes(q))) return false;
      }
      return true;
    });
  }

  // The list in the order chosen by the column buttons (newest first until one is pressed).
  function sortedPurchases() {
    const f = ui.pur;
    const rows = filteredPurchases().map((p) => {
      const sum = summaryOf(p);
      const sp = supplierById(p.supplierId);
      return { p, reference: p.reference, supplier: sp ? sp.name : "", date: p.invoiceDate, total: p.total, paid: p.status === "confirmed" ? sum.paid : 0, outstanding: p.status === "confirmed" ? sum.outstanding : 0 };
    });
    rows.sort((a, b) => compareBy(f.sortKey, f.sortDir)(a, b) || b.date.localeCompare(a.date) || b.reference.localeCompare(a.reference));
    return rows.map((r) => r.p);
  }

  function purchaseListRows() {
    return purchaseRowsHtml(sortedPurchases(), { withSupplier: true, keepOrder: true });
  }

  // The figures above the list. Purchases and payments follow the dates chosen in the filters (all time when empty);
  // what is owed and what is prepaid are the current balances of all suppliers. A deposit is money paid, never a purchase.
  function purchaseSummaryStrip() {
    const s = S();
    const f = ui.pur;
    const period = P.periodReport(s, f.from, f.to, today());
    const out = P.moneyOutReport(s, f.from, f.to);
    const o = P.overview(s, today());
    return stat(t("fin.purchasesInPeriod"), num(period.count))
      + stat(t("fin.totalPurchases"), esc(money(period.total)))
      + stat(t("fin.paidToSuppliers"), esc(money(out.paid)))
      + stat(t("fin.owedToSuppliers"), esc(money(o.owed)), o.owed > 0 ? "warn" : "")
      + stat(t("fin.availableAdvances"), esc(money(o.advance)), o.advance > 0 ? "credit" : "");
  }

  function refreshPurchaseList() {
    if ($("purRows")) $("purRows").innerHTML = purchaseListRows();
    if ($("purStrip")) $("purStrip").innerHTML = purchaseSummaryStrip();
  }

  function purchaseListHtml() {
    const f = ui.pur;
    const suppliers = [...S().suppliers].sort((a, b) => a.name.localeCompare(b.name));
    return `<div class="stat-strip" id="purStrip">${purchaseSummaryStrip()}</div>
      <p class="muted small balance-note">${esc(t("fin.periodNote"))}</p>
      <div class="panel stock-list">
        <div class="stock-toolbar">
          <div class="stock-search">
            ${SEARCH_ICON}
            <label class="sr-only" for="purSearch">${esc(t("pur.searchLabel"))}</label>
            <input type="search" id="purSearch" value="${esc(f.q)}" placeholder="${esc(t("pur.searchPlaceholder"))}" autocomplete="off">
          </div>
          <div class="list-filters">
            <label class="sr-only" for="purStatus">${esc(t("pur.statusFilter"))}</label>
            <select id="purStatus">${STATUS_FILTERS.map((v) => option(v, t(v === "all" ? "pur.filter.allStatuses" : "pur.status." + v), f.status === v)).join("")}</select>
            <label class="sr-only" for="purPay">${esc(t("pur.payFilter"))}</label>
            <select id="purPay">${PAY_FILTERS.map((v) => option(v, t(v === "all" ? "pur.filter.allPayments" : v === "overdue" ? "pur.filter.overdue" : "pur.pay." + v), f.pay === v)).join("")}</select>
            <label class="sr-only" for="purSupplier">${esc(t("pur.supplierFilter"))}</label>
            <select id="purSupplier">${option("", t("pur.filter.allSuppliers"), !f.supplierId)}${suppliers.map((s) => option(s.id, s.name, s.id === f.supplierId)).join("")}</select>
            <label class="sr-only" for="purFrom">${esc(t("pur.filter.from"))}</label>
            <input type="date" id="purFrom" value="${esc(f.from)}" title="${esc(t("pur.filter.from"))}">
            <label class="sr-only" for="purTo">${esc(t("pur.filter.to"))}</label>
            <input type="date" id="purTo" value="${esc(f.to)}" title="${esc(t("pur.filter.to"))}">
          </div>
        </div>
        <div class="table-wrap stock-table-wrap"><table class="table stock-table">${purchaseTableHead(true, true)}<tbody id="purRows">${purchaseListRows()}</tbody></table></div>
      </div>`;
  }

  function monthStart() {
    return today().slice(0, 8) + "01";
  }

  function reportBodyHtml() {
    const r = ui.pur.report;
    const s = S();
    const day = today();
    const from = r.from;
    const to = r.to;
    const period = P.periodReport(s, from, to, day);
    const byS = P.purchasesBySupplier(s, from, to, day);
    const owed = P.outstandingReport(s, day);
    const pays = P.paymentsReport(s, from, to);
    const bought = new Map();
    for (const p of s.purchases) if (p.status === "confirmed") for (const l of p.lines) bought.set(l.productId, l.productName);
    const productId = r.productId && bought.has(r.productId) ? r.productId : "";
    const history = productId ? P.productHistory(s, productId) : [];
    const head = (cells) => `<thead><tr>${cells.map((c, i) => `<th${c.num ? ' class="num"' : ""}>${esc(c.label)}</th>`).join("")}</tr></thead>`;
    const none = (cols) => `<tr class="empty-row"><td colspan="${cols}">${esc(t("rep.none"))}</td></tr>`;
    return `<div class="stat-strip">
        ${stat(t("rep.count"), num(period.count))}${stat(t("sup.stat.purchases"), esc(money(period.total)))}
        ${stat(t("sup.stat.paid"), esc(money(period.paid)))}${stat(t("sup.stat.outstanding"), esc(money(period.outstanding)), period.outstanding > 0 ? "warn" : "")}
      </div>
      <div class="panel"><h2>${esc(t("rep.bySupplier"))}</h2><div class="table-wrap"><table class="table">
        ${head([{ label: t("pur.col.supplier") }, { label: t("rep.count"), num: true }, { label: t("col.total"), num: true }, { label: t("col.paid"), num: true }, { label: t("pur.col.outstanding"), num: true }, { label: t("sup.col.last") }])}
        <tbody>${byS.length ? byS.map((g) => `<tr><td>${g.supplier ? `<button type="button" class="link" data-act="sup-open" data-id="${esc(g.supplier.id)}">${esc(g.supplier.name)}</button>` : ""}</td>
          <td class="num">${num(g.count)}</td><td class="num">${esc(money(g.total))}</td><td class="num">${esc(money(g.paid))}</td><td class="num">${esc(money(g.outstanding))}</td><td>${esc(fmtDay(g.last))}</td></tr>`).join("") : none(6)}</tbody></table></div></div>
      <div class="panel"><h2>${esc(t("rep.purchases"))}</h2><div class="table-wrap"><table class="table">${purchaseTableHead(true)}
        <tbody>${period.rows.length ? purchaseRowsHtml(period.rows.map((x) => x.purchase), { withSupplier: true }) : none(10)}</tbody></table></div></div>
      <div class="panel"><h2>${esc(t("rep.balances"))}</h2>
        <p class="muted small">${esc(t("rep.balancesNote"))}</p>
        <div class="table-wrap"><table class="table">
        ${head([{ label: t("pur.col.supplier") }, { label: t("fin.outstandingInvoices"), num: true }, { label: t("sup.stat.overdueAmount"), num: true }, { label: t("fin.netBalance"), num: true }])}
        <tbody>${owed.bySupplier.length ? owed.bySupplier.map((x) => `<tr><td><button type="button" class="link" data-act="sup-open" data-id="${esc(x.supplier.id)}">${esc(x.supplier.name)}</button></td>
          <td class="num owed">${esc(money(x.summary.outstanding))}</td><td class="num">${esc(money(x.summary.overdueTotal))}</td><td class="num ${balanceClass(x.summary.net)}">${esc(money(x.summary.net))}</td></tr>`).join("")
          + `<tr class="total-row"><td>${esc(t("col.total"))}</td><td class="num">${esc(money(owed.total))}</td><td class="num">${esc(money(owed.overdueTotal))}</td><td></td></tr>` : none(4)}</tbody></table></div></div>
      <div class="panel"><h2>${esc(t("rep.overdue"))}</h2><div class="table-wrap"><table class="table">
        ${head([{ label: t("pur.col.reference") }, { label: t("pur.col.supplier") }, { label: t("pur.col.invoiceNo") }, { label: t("pur.col.due") }, { label: t("rep.daysLate"), num: true }, { label: t("pur.col.outstanding"), num: true }])}
        <tbody>${owed.overdue.length ? owed.overdue.map((x) => `<tr><td><button type="button" class="link" data-act="pur-open" data-id="${esc(x.purchase.id)}">${esc(x.purchase.reference)}</button></td>
          <td>${esc(x.supplier ? x.supplier.name : "")}</td><td>${esc(x.purchase.supplierInvoiceNumber)}</td><td>${esc(fmtDay(x.purchase.dueDate))}</td>
          <td class="num">${num(x.summary.daysOverdue)}</td><td class="num owed">${esc(money(x.summary.outstanding))}</td></tr>`).join("") : none(6)}</tbody></table></div></div>
      <div class="panel"><h2>${esc(t("rep.payments"))} <small>${esc(t("rep.paymentsTotal", { count: pays.count, total: money(pays.total) }))}</small></h2><div class="table-wrap"><table class="table">
        ${head([{ label: t("spay.date") }, { label: t("pur.col.supplier") }, { label: t("pur.col.reference") }, { label: t("spay.amount"), num: true }, { label: t("spay.reference") }, { label: "" }])}
        <tbody>${pays.rows.length ? paymentRowsHtml(pays.rows, { withSupplier: true }) : none(6)}</tbody></table></div></div>
      <div class="panel"><h2>${esc(t("rep.productHistory"))}</h2>
        <div class="field narrow"><label for="repProduct">${esc(t("col.product"))}</label><select id="repProduct">${option("", t("pur.chooseProduct"), !productId)}${[...bought].sort((a, b) => a[1].localeCompare(b[1])).map(([id, name]) => option(id, name, id === productId)).join("")}</select></div>
        <div class="table-wrap"><table class="table">
        ${head([{ label: t("pur.col.date") }, { label: t("pur.col.supplier") }, { label: t("pur.col.reference") }, { label: t("col.qty"), num: true }, { label: t("pur.line.stockQty"), num: true }, { label: t("pur.line.price"), num: true }, { label: t("col.total"), num: true }, { label: t("rep.costPerStock"), num: true }])}
        <tbody>${history.length ? history.map((x) => `<tr><td>${esc(fmtDay(x.purchase.invoiceDate))}</td><td>${esc(x.supplier ? x.supplier.name : "")}</td>
          <td><button type="button" class="link" data-act="pur-open" data-id="${esc(x.purchase.id)}">${esc(x.purchase.reference)}</button></td>
          <td class="num">${esc(qtyText(x.line.qty, x.line.unit))}</td><td class="num">${esc(stockQtyText(x.line.baseQty, x.line.stockUnit))}</td>
          <td class="num">${esc(money(x.line.unitPrice))} / ${esc(unitName(x.line.unit))}</td><td class="num">${esc(money(x.line.lineTotal))}</td>
          <td class="num">${x.costPerStockUnit == null ? "" : esc(money(x.costPerStockUnit)) + (x.line.stockUnit ? " / " + esc(stockUnitName(x.line.stockUnit)) : "")}</td></tr>`).join("") : none(8)}</tbody></table></div></div>
      <p class="muted small">${esc(t("rep.note"))}</p>`;
  }

  function reportsHtml() {
    const r = ui.pur.report;
    return `<div class="panel"><div class="toolbar period">
        <div class="field"><label for="repFrom">${esc(t("rep.from"))}</label><input type="date" id="repFrom" value="${esc(r.from)}"></div>
        <div class="field"><label for="repTo">${esc(t("rep.to"))}</label><input type="date" id="repTo" value="${esc(r.to)}"></div>
        <div class="field"><button type="button" class="btn" data-act="rep-preset" data-preset="month">${esc(t("rep.thisMonth"))}</button>
          <button type="button" class="btn" data-act="rep-preset" data-preset="year">${esc(t("rep.thisYear"))}</button>
          <button type="button" class="btn" data-act="rep-preset" data-preset="all">${esc(t("rep.allTime"))}</button></div>
      </div></div><div id="repBody">${reportBodyHtml()}</div>`;
  }

  /* ==========================================================================
     PURCHASE FORM (new purchase or editing a draft)
     ========================================================================== */

  const NEW = "__new__";

  function blankLine() {
    return { id: Validation.uid(), productId: "", newProduct: null, qty: "", unit: "box", unitPrice: "", discount: "", notes: "" };
  }

  function blankValues(supplierId) {
    return {
      id: Validation.uid(), supplierId: supplierId || "", supplierInvoiceNumber: "", noSupplierInvoice: false,
      invoiceDate: today(), dueDate: "", reference: "", notes: "", lines: [blankLine()],
      discountType: "amount", discountValue: "", taxType: "none", taxValue: "", taxMode: "added", delivery: "", otherCosts: "",
      initialPayment: { amount: "", date: today(), reference: "" }, advanceApply: "", receiveNow: true, receiptDate: today(),
    };
  }

  function valuesFromPurchase(p) {
    const ip = p.initialPayment || {};
    return {
      id: p.id, supplierId: p.supplierId, supplierInvoiceNumber: p.supplierInvoiceNumber, noSupplierInvoice: p.noSupplierInvoice,
      invoiceDate: p.invoiceDate, dueDate: p.dueDate, reference: p.reference, notes: p.notes,
      lines: p.lines.map((l) => ({
        id: l.id, productId: l.productId, newProduct: l.newProduct ? { ...l.newProduct } : null,
        qty: l.qty ? String(l.qty) : "", unit: l.unit, unitPrice: String(l.unitPrice), discount: l.discount ? String(l.discount) : "", notes: l.notes,
      })),
      discountType: p.discountType, discountValue: p.discountValue ? String(p.discountValue) : "", taxType: p.taxType, taxValue: p.taxValue ? String(p.taxValue) : "",
      taxMode: p.taxMode, delivery: p.delivery ? String(p.delivery) : "", otherCosts: p.otherCosts ? String(p.otherCosts) : "",
      initialPayment: { amount: ip.amount ? String(ip.amount) : "", date: ip.date || today(), reference: ip.reference || "" },
      advanceApply: p.advanceApply ? String(p.advanceApply) : "",
      receiveNow: true, receiptDate: today(),
    };
  }

  // The product form of a line's "+ New product" box: the same form as the Stock page, so a product made here gets the
  // same fields (Manufacturer included) and is checked by the same rules. Its stock starts at 0: what the purchase
  // receives is the only thing that adds to it. The supplier of the purchase is not part of it: it is the purchase's own.
  const newProductPrefix = (lineId) => `pl-${lineId}-np-`;

  function newProductForm(lineId) {
    return ProductForm.create({
      prefix: newProductPrefix(lineId),
      stockFromPurchase: true,
      products: () => S().products,
      onError: (message) => showErr(`pl-${lineId}-error`, message),
    });
  }

  function lineHtml(line) {
    const id = line.id;
    const np = line.newProduct;
    const selected = np ? NEW : line.productId;
    return `<div class="pl-row" data-line="${esc(id)}" data-pid="${esc(np ? line.productId : "")}">
      <div class="pl-main">
        <div class="field pl-product"><label for="pl-${id}-search">${esc(t("col.product"))}</label>
          <div class="combo" data-combo="${esc(id)}">
            <input type="text" class="combo-input" id="pl-${id}-search" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="pl-${id}-list"
              autocomplete="off" spellcheck="false" placeholder="${esc(t("pur.productSearch"))}" value="${esc(comboLabelOf(selected))}">
            <ul class="combo-list no-print" id="pl-${id}-list" role="listbox" aria-label="${esc(t("pur.productListAria"))}" hidden></ul>
            <!-- The list the page reads and saves from (what is chosen, as a product id); the search box above only drives it. -->
            <select id="pl-${id}-product" class="combo-native" tabindex="-1" aria-hidden="true" hidden>${productOptions(selected)}</select>
          </div></div>
        <div class="field"><label for="pl-${id}-qty">${esc(t("pur.line.qty"))}</label><input type="number" id="pl-${id}-qty" min="0" step="any" value="${esc(line.qty)}"></div>
        <div class="field"><label for="pl-${id}-unit">${esc(t("pur.line.unit"))}</label><select id="pl-${id}-unit">${unitOptions(line.unit)}</select></div>
        <div class="field"><label for="pl-${id}-price">${esc(t("pur.line.price"))}</label><input type="number" id="pl-${id}-price" min="0" step="any" value="${esc(line.unitPrice)}"></div>
        <div class="field"><label for="pl-${id}-disc">${esc(t("pur.line.discount"))}</label><input type="number" id="pl-${id}-disc" min="0" step="any" value="${esc(line.discount)}"></div>
        <div class="field pl-total"><span class="label">${esc(t("pur.line.subtotal"))}</span><strong id="pl-${id}-total">0</strong></div>
        <button type="button" class="btn small danger pl-remove" data-act="pur-line-remove" data-line="${esc(id)}" aria-label="${esc(t("common.remove"))}">✕</button>
      </div>
      <div class="pl-sub">
        <button type="button" class="btn small pl-add-product" data-act="pur-product-new" data-line="${esc(id)}">${esc(t("pur.addNewProduct"))}</button>
        <span class="muted small" id="pl-${id}-hint"></span> <span class="conv" id="pl-${id}-conv" aria-live="polite"></span>
        <button type="button" class="btn small" id="pl-${id}-edit" data-act="pur-product-edit" data-line="${esc(id)}" hidden>${esc(t("pur.editProduct"))}</button></div>
      <div class="pl-new" id="pl-${id}-newbox"${np ? "" : " hidden"}>
        <h4>${esc(t("pur.newProductTitle"))}</h4>
        <div id="pl-${id}-npHost">${np ? newProductForm(id).html(np) : ""}</div>
        <p class="muted small">${esc(t("pur.newProductNote"))}</p>
      </div>
      <div class="field pl-notes"><label for="pl-${id}-notes">${esc(t("pur.line.notes"))}</label><input type="text" id="pl-${id}-notes" value="${esc(line.notes || "")}" autocomplete="off"></div>
      <p class="error" id="pl-${id}-error" role="alert"></p>
    </div>`;
  }

  /* ---------- "Add a new product" and "Edit this product": the Stock page's own product form, in a dialog ----------
     The dialog sits OUTSIDE the purchase <form>, so nothing typed in the purchase is read, reset or submitted by it.
     Adding saves the product to Stock at once (stock 0: only the goods received by a confirmed purchase add to it)
     through the same checks as the Stock page, then selects it on the line that asked for it. Editing saves with the
     same rules as Stock's Edit product, so a missing tile size or coverage per box can be put right without leaving. */
  const DIALOG_PREFIX = "pd-";

  function productDialogHtml() {
    return `<dialog class="product-dialog no-print" id="purProductDialog" aria-labelledby="purProductTitle">
      <h2 id="purProductTitle"></h2>
      <p class="muted small" id="purProductNote"></p>
      <div id="purProductHost"></div>
      <div class="notice" id="purProductSimilar" hidden></div>
      <p class="error" id="purProductError" role="alert"></p>
      <div class="actions">
        <button type="button" class="btn" data-act="pur-product-cancel">${esc(t("common.cancel"))}</button>
        <button type="button" class="btn primary" id="purProductSave" data-act="pur-product-save"></button>
      </div>
    </dialog>`;
  }

  function resetProductDialogMessages() {
    showErr("purProductError", "");
    const box = $("purProductSimilar");
    if (box) { box.hidden = true; box.innerHTML = ""; }
    const host = $("purProductHost");
    if (host) clearInvalid(host);
  }

  // presetName: what was typed in the product search when nothing matched, so the new product starts with that name.
  function openProductDialog(lineId, mode, productId, presetName) {
    const dialog = $("purProductDialog");
    if (!dialog) return;
    const product = mode === "edit" ? S().products.find((p) => p.id === productId) : null;
    if (mode === "edit" && !product) { h.notify(t("product.gone"), "error"); return; }
    ui.pur.productDialog = { lineId, mode, productId: product ? product.id : "" };
    const form = ProductForm.create({
      prefix: DIALOG_PREFIX,
      stockFromPurchase: mode === "add",
      products: () => S().products,
      editing: () => product,
      onError: (message) => showErr("purProductError", message),
    });
    $("purProductTitle").textContent = t(mode === "edit" ? "pur.productDialog.editTitle" : "pur.productDialog.addTitle");
    $("purProductNote").textContent = t(mode === "edit" ? "pur.productDialog.editNote" : "pur.productDialog.addNote");
    $("purProductHost").innerHTML = mode === "edit" ? form.html(product) : form.html();
    $("purProductSave").textContent = t(mode === "edit" ? "stock.saveChanges" : "pur.productDialog.save");
    $("purProductSave").disabled = false;
    resetProductDialogMessages();
    const first = $(DIALOG_PREFIX + "Name");
    if (mode === "add" && presetName && first) first.value = presetName;
    if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "");
    if (first && first.focus) first.focus();
  }

  function closeProductDialog() {
    const dialog = $("purProductDialog");
    if (dialog) { if (typeof dialog.close === "function") dialog.close(); else dialog.removeAttribute("open"); }
    ProductForm.drop(DIALOG_PREFIX);
    ui.pur.productDialog = null;
  }

  // Redraws every line's product list (a product was added or changed) without touching what is chosen or typed.
  function refreshProductSelects() {
    for (const row of $("pfLines").querySelectorAll(".pl-row")) {
      const lineId = row.dataset.line;
      const select = $(`pl-${lineId}-product`);
      const current = select.value;
      select.innerHTML = productOptions(current);
      select.value = current;
      if (!(combo.lineId === lineId && combo.typed)) syncCombo(lineId);   // a search being typed is left alone
    }
  }

  // Picks a product on a line from code (what choosing it in the list does).
  function chooseProduct(lineId, productId) {
    const select = $(`pl-${lineId}-product`);
    if (!select) return;
    select.value = productId;
    onProductPicked(lineId, productId);
    syncCombo(lineId);
    updatePurchasePreview();
  }

  // The person carries on with the line they just chose a product for: quantity next.
  function focusQuantity(lineId) {
    const qty = $(`pl-${lineId}-qty`);
    if (qty && qty.focus) qty.focus();
  }

  /* ---------- The product selector: a search box and a list in one ----------
     The real value of a line is still the (hidden) <select id="pl-…-product">, so reading the form, the conversions and
     the totals work exactly as before. This box only filters the products as you type (purchases.js: matchProducts) and
     picks one into that select. */
  const COMBO_LIMIT = 60;
  const combo = { lineId: "", matches: [], index: -1, typed: false };   // the one list that is open: its line, rows, highlighted row

  function comboLabelOf(value) {
    if (!value) return "";
    if (value === NEW) return t("pur.newProduct");
    const product = S().products.find((p) => p.id === value);
    return product ? h.productLabel(product) : "";
  }

  // The search box shows what the line has chosen (its name, size and manufacturer), or nothing.
  function syncCombo(lineId) {
    const input = $(`pl-${lineId}-search`);
    const select = $(`pl-${lineId}-product`);
    if (input && select) input.value = comboLabelOf(select.value);
  }

  const typeLabel = (p) => (p.productType ? t("productType." + p.productType) : "");

  function comboMatches(query) {
    return P.matchProducts(S().products, query, typeLabel);
  }

  function comboRowHtml(lineId, p, i, chosenId) {
    const meta = [p.tileSize, p.manufacturer, typeLabel(p)].filter(Boolean).join(" · ");
    const active = i === combo.index;
    return `<li role="option" id="pl-${lineId}-opt-${i}" class="combo-opt${active ? " active" : ""}${p.id === chosenId ? " chosen" : ""}" data-id="${esc(p.id)}" aria-selected="${active}">
      <span class="combo-main"><strong>${esc(p.name)}</strong>${meta ? `<span class="combo-meta">${esc(meta)}</span>` : ""}</span>
      <span class="combo-stock">${esc(t("pur.hint.stock", { stock: h.stockText(p) }))}</span></li>`;
  }

  function drawCombo(lineId) {
    const input = $(`pl-${lineId}-search`);
    const list = $(`pl-${lineId}-list`);
    const query = combo.typed ? input.value : "";
    const found = comboMatches(query);
    combo.matches = found.slice(0, COMBO_LIMIT);
    if (combo.index >= combo.matches.length) combo.index = combo.matches.length - 1;
    const chosenId = $(`pl-${lineId}-product`).value;
    let html = combo.matches.map((p, i) => comboRowHtml(lineId, p, i, chosenId)).join("");
    if (!combo.matches.length) {
      const none = S().products.length ? t("pur.productNoMatch", { q: input.value.trim() }) : t("pur.productNone");
      html = `<li class="combo-empty" role="presentation">${esc(none)}<span class="combo-meta">${esc(t("pur.productAddHint"))}</span></li>`;
    } else if (found.length > combo.matches.length) {
      html += `<li class="combo-more" role="presentation">${esc(t("pur.productMore", { n: COMBO_LIMIT }))}</li>`;
    }
    // Always reachable, so a product that is not in the list can be added without leaving the purchase.
    html += `<li class="combo-foot" role="presentation"><button type="button" class="btn small" tabindex="-1" data-act="pur-product-new" data-line="${esc(lineId)}" data-name="${esc(combo.typed ? input.value.trim() : "")}">${esc(t("pur.addNewProduct"))}</button></li>`;
    list.innerHTML = html;
  }

  function markComboRow(lineId) {
    const input = $(`pl-${lineId}-search`);
    const rows = [...$(`pl-${lineId}-list`).querySelectorAll(".combo-opt")];
    rows.forEach((row, i) => {
      row.classList.toggle("active", i === combo.index);
      row.setAttribute("aria-selected", String(i === combo.index));
    });
    const row = rows[combo.index];
    if (row) {
      input.setAttribute("aria-activedescendant", row.id);
      if (row.scrollIntoView) row.scrollIntoView({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  }

  function showCombo(lineId) {
    if (combo.lineId && combo.lineId !== lineId) hideCombo(combo.lineId);
    combo.lineId = lineId;
    const chosenId = $(`pl-${lineId}-product`).value;
    if (!combo.typed) combo.index = comboMatches("").findIndex((p) => p.id === chosenId);   // the list opens on the chosen product (nothing highlighted if none)
    drawCombo(lineId);
    $(`pl-${lineId}-list`).hidden = false;
    $(`pl-${lineId}-search`).setAttribute("aria-expanded", "true");
    markComboRow(lineId);
  }

  function hideCombo(lineId) {
    const list = $(`pl-${lineId}-list`);
    const input = $(`pl-${lineId}-search`);
    if (list) list.hidden = true;
    if (input) { input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant"); }
    if (combo.lineId === lineId) { combo.lineId = ""; combo.typed = false; combo.index = -1; combo.matches = []; }
  }

  const comboIsOpen = (lineId) => combo.lineId === lineId && !$(`pl-${lineId}-list`).hidden;

  // A product was picked from the list: it goes into the line like any chosen product, then the quantity is next.
  function pickCombo(lineId, productId) {
    hideCombo(lineId);
    chooseProduct(lineId, productId);
    focusQuantity(lineId);
  }

  // The search box was left: what is shown goes back to what the line really has. Only an emptied box clears the choice.
  function leaveCombo(lineId) {
    const input = $(`pl-${lineId}-search`);
    const select = $(`pl-${lineId}-product`);
    if (!input || !select) return;
    const cleared = combo.lineId === lineId && combo.typed && input.value.trim() === "" && select.value !== "";
    hideCombo(lineId);
    if (cleared) chooseProduct(lineId, ""); else syncCombo(lineId);
  }

  function onComboFocus(input) {
    const lineId = input.closest(".combo").dataset.combo;
    combo.typed = false;
    showCombo(lineId);
    if (input.select) input.select();   // typing at once replaces the shown name and filters the list
  }

  function onComboKey(e, input) {
    const lineId = input.closest(".combo").dataset.combo;
    const open = comboIsOpen(lineId);
    const last = combo.matches.length - 1;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) { showCombo(lineId); return; }
      if (last < 0) return;
      combo.index = e.key === "ArrowDown" ? (combo.index >= last ? 0 : combo.index + 1) : (combo.index <= 0 ? last : combo.index - 1);
      markComboRow(lineId);
    } else if (e.key === "Enter") {
      e.preventDefault();   // never submits the purchase form
      if (e.isComposing) return;
      if (!open) { showCombo(lineId); return; }
      if (combo.index >= 0 && combo.matches[combo.index]) pickCombo(lineId, combo.matches[combo.index].id);
      else if (!combo.matches.length) { const name = combo.typed ? input.value.trim() : ""; hideCombo(lineId); openProductDialog(lineId, "add", "", name); }
    } else if (e.key === "Escape") {
      if (open) { e.preventDefault(); e.stopPropagation(); hideCombo(lineId); syncCombo(lineId); if (input.select) input.select(); }
    } else if (e.key === "Tab") {
      // Leaving after typing a name only one product answers to chooses that product; anything else keeps what was chosen.
      if (open && combo.typed && combo.matches.length === 1) { const only = combo.matches[0].id; hideCombo(lineId); chooseProduct(lineId, only); }
    }
  }

  function showSimilarProducts(list) {
    const box = $("purProductSimilar");
    box.innerHTML = `<p>${esc(t("pur.productDialog.similar"))}</p><ul>${list.map((p) => `<li>${esc(h.productLabel(p))} <button type="button" class="btn small" data-act="pur-product-use" data-id="${esc(p.id)}">${esc(t("pur.productDialog.use"))}</button></li>`).join("")}</ul>
      <button type="button" class="btn small" data-act="pur-product-anyway">${esc(t("pur.productDialog.anyway"))}</button>`;
    box.hidden = false;
  }

  // force: the person saw the "similar product" warning and still wants a new product.
  function saveProductDialog(force) {
    const state = ui.pur.productDialog;
    const form = ProductForm.get(DIALOG_PREFIX);
    if (!state || !form) return;
    resetProductDialogMessages();
    const read = form.read();
    if (read.error) { showErr("purProductError", read.error, read.field); return; }
    const values = read.values;
    if (state.mode === "add" && !force) {
      const similar = Validation.findSimilarProducts(values, S().products);
      if (similar.length) { showSimilarProducts(similar); return; }
    }
    // One save at a time: the button is off until this one has finished (guard() also refuses a second run), so a double
    // click or a repeated Enter can never add the product twice. A failed save turns it back on so it can be retried.
    const saveButton = $("purProductSave");
    if (saveButton) saveButton.disabled = true;
    return Promise.resolve(act((d) => {
      if (state.mode === "edit") {
        const product = d.products.find((p) => p.id === state.productId);
        if (!product) return { error: t("product.gone") };
        Object.assign(product, values);
        return { product };
      }
      // Checked again against the data being saved: the exact repeat of a product is never added.
      const twin = Validation.findDuplicateProduct(values, d.products, null);
      if (twin) return { error: t("product.duplicate", { label: h.productLabel(twin.product) }) };
      const product = { id: Validation.uid(), manufacturer: "", ...values };
      d.products.push(product);
      return { product };
    }, {
      errorId: "purProductError",
      done: (r) => {
        const adding = state.mode === "add";
        closeProductDialog();
        refreshProductSelects();
        if (adding) { chooseProduct(state.lineId, r.product.id); focusQuantity(state.lineId); }
        else updatePurchasePreview();
        h.notify(t(adding ? "product.added" : "product.updated", { label: h.productLabel(r.product) }));
      },
    })).finally(() => {
      const button = $("purProductSave");
      if (button) button.disabled = false;
    });
  }

  function attachmentListHtml(form) {
    const items = [
      ...form.attachments.map((a) => ({ a, pending: false })),
      ...form.pending.map((a) => ({ a, pending: true })),
    ];
    if (!items.length) return `<p class="muted small">${esc(t("pur.att.none"))}</p>`;
    return `<ul class="att-list">${items.map(({ a, pending }) => `<li><span>${esc(a.name)} <span class="muted small">(${esc(sizeText(a.size))}${pending ? ", " + esc(t("pur.att.new")) : ""})</span></span>
      <span>${pending ? "" : `<button type="button" class="btn small" data-act="att-open" data-id="${esc(a.id)}">${esc(t("pur.att.open"))}</button> `}<button type="button" class="btn small danger" data-act="pf-att-remove" data-id="${esc(a.id)}">${esc(t("common.remove"))}</button></span></li>`).join("")}</ul>`;
  }

  function purchaseFormHtml(v, form, editing) {
    const suppliers = S().suppliers.filter((s) => !s.archived || s.id === v.supplierId).sort((a, b) => a.name.localeCompare(b.name));
    const ip = v.initialPayment;
    return `<form id="purchaseForm" data-form="pur-save" novalidate>
      <div class="panel">
        <button type="button" class="link back" data-act="pur-back"><span class="dir-arrow">←</span> ${esc(t("pur.title"))}</button>
        <h2>${esc(t(editing ? "pur.editDraft" : "pur.newTitle"))}</h2>
        <p class="notice">${esc(t("pur.notASale"))}</p>
        <div class="grid-3">
          ${field("pf-supplier", esc(t("pur.col.supplier")) + " *", `<select id="pf-supplier">${option("", t("pur.chooseSupplier"), !v.supplierId)}${suppliers.map((s) => option(s.id, s.name, s.id === v.supplierId)).join("")}</select>`)}
          ${field("pf-invoiceNo", esc(t("pur.f.invoiceNo")), `<input type="text" id="pf-invoiceNo" value="${esc(v.supplierInvoiceNumber)}" autocomplete="off"${v.noSupplierInvoice ? " disabled" : ""}>
            <label class="check"><input type="checkbox" id="pf-noInvoice"${v.noSupplierInvoice ? " checked" : ""}> ${esc(t("pur.f.noInvoice"))}</label>`)}
          ${field("pf-reference", esc(t("pur.f.reference")), `<input type="text" id="pf-reference" value="${esc(v.reference)}" placeholder="${esc(t("pur.f.referenceAuto"))}" autocomplete="off"${editing ? "" : ""}>`)}
        </div>
        <p class="muted small" id="pf-supplierInfo"></p>
        <div class="grid-3">
          ${field("pf-date", esc(t("pur.f.invoiceDate")), `<input type="date" id="pf-date" value="${esc(v.invoiceDate)}">`)}
          ${field("pf-due", esc(t("pur.f.dueDate")), `<input type="date" id="pf-due" value="${esc(v.dueDate)}">`)}
          ${field("pf-notes", esc(t("pur.f.notes")), `<input type="text" id="pf-notes" value="${esc(v.notes)}" autocomplete="off">`)}
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>${esc(t("pur.lines"))}</h2><button type="button" class="btn" data-act="pur-line-add">${esc(t("pur.addLine"))}</button></div>
        <div id="pfLines">${v.lines.map(lineHtml).join("")}</div>
        <p class="error" id="pf-lines-error" role="alert"></p>
      </div>
      <div class="panel">
        <div class="adjust">
          <fieldset><legend>${esc(t("pur.adjust"))}</legend>
            <div class="field"><label for="pf-discount">${esc(t("sell.discount"))}</label><div class="with-unit">
              <input type="number" id="pf-discount" min="0" step="any" value="${esc(v.discountValue)}">
              <select id="pf-discountType">${option("amount", S().settings.currency, v.discountType === "amount")}${option("percent", "%", v.discountType === "percent")}</select></div></div>
            <div class="field"><label for="pf-tax">${esc(t("sell.tax"))}</label><div class="with-unit">
              <input type="number" id="pf-tax" min="0" step="any" value="${esc(v.taxValue)}">
              <select id="pf-taxType">${option("none", t("pur.tax.none"), v.taxType === "none")}${option("percent", "%", v.taxType === "percent")}${option("amount", S().settings.currency, v.taxType === "amount")}</select></div></div>
            <div class="field"><label for="pf-taxMode">${esc(t("pur.tax.mode"))}</label><select id="pf-taxMode">${option("added", t("pur.tax.added"), v.taxMode === "added")}${option("included", t("pur.tax.included"), v.taxMode === "included")}</select></div>
            <div class="grid-2">
              ${field("pf-delivery", esc(t("pur.f.delivery")), `<input type="number" id="pf-delivery" min="0" step="any" value="${esc(v.delivery)}">`)}
              ${field("pf-other", esc(t("pur.f.otherCosts")), `<input type="number" id="pf-other" min="0" step="any" value="${esc(v.otherCosts)}">`)}
            </div>
          </fieldset>
          <div class="totals" id="pfTotals"></div>
        </div>
      </div>
      <div class="panel grid-2 top">
        <fieldset><legend>${esc(t("pur.paymentNow"))}</legend>
          <p class="muted small">${esc(t("pur.paymentNowNote"))}</p>
          <div class="grid-3">
            ${field("pf-payAmount", esc(t("spay.amount")), `<input type="number" id="pf-payAmount" min="0" step="any" value="${esc(ip.amount)}" placeholder="0">`)}
            ${field("pf-payDate", esc(t("spay.date")), `<input type="date" id="pf-payDate" value="${esc(ip.date)}" max="${today()}">`)}
            ${field("pf-payRef", esc(t("spay.reference")), `<input type="text" id="pf-payRef" value="${esc(ip.reference)}" autocomplete="off">`)}
          </div>
          <div id="pf-advRow" hidden>
            <div class="grid-3">
              ${field("pf-advance", esc(t("adv.useLabel")), `<input type="number" id="pf-advance" min="0" step="any" value="${esc(v.advanceApply || "")}" placeholder="0">`)}
              <div class="field"><span class="label-spacer">&nbsp;</span><button type="button" class="btn" id="pf-advMax" data-act="pur-adv-max"></button></div>
            </div>
            <p class="muted small" id="pf-advHint"></p>
          </div>
        </fieldset>
        <fieldset><legend>${esc(t("pur.deliveryNow"))}</legend>
          <label class="check"><input type="checkbox" id="pf-receive"${v.receiveNow ? " checked" : ""}> ${esc(t("pur.receiveNow"))}</label>
          <p class="muted small">${esc(t("pur.receiveNowNote"))}</p>
          ${field("pf-receiptDate", esc(t("pur.receiptDate")), `<input type="date" id="pf-receiptDate" value="${esc(v.receiptDate)}" max="${today()}">`)}
        </fieldset>
      </div>
      <div class="panel">
        <h2>${esc(t("pur.att.title"))}</h2>
        <p class="muted small">${esc(t("pur.att.note"))}</p>
        <input type="file" id="pfFile" accept="image/jpeg,image/png,image/webp,application/pdf" multiple>
        <div id="pfAttach">${attachmentListHtml(form)}</div>
        <p class="error" id="pf-att-error" role="alert"></p>
      </div>
      <p class="error" id="pf-error" role="alert"></p>
      <div class="actions left sticky-actions">
        <button type="submit" class="btn" id="pf-saveDraft">${esc(t("pur.saveDraft"))}</button>
        <button type="button" class="btn primary" id="pf-confirm" data-act="pur-confirm-now">${esc(t("pur.confirm"))}</button>
        <button type="button" class="btn" data-act="pur-back">${esc(t("common.cancel"))}</button>
      </div>
    </form>
    ${productDialogHtml()}`;
  }

  // What is typed in the form right now, in the shape purchases.js reads.
  function readPurchaseForm() {
    const form = ui.pur.form;
    const lines = [...$("pfLines").querySelectorAll(".pl-row")].map((row) => {
      const id = row.dataset.line;
      const g = (key) => $(`pl-${id}-${key}`).value;
      const sel = g("product");
      const line = { id, productId: sel === NEW ? row.dataset.pid : sel, newProduct: null, qty: g("qty"), unit: g("unit"), unitPrice: g("price"), discount: g("disc"), notes: g("notes") };
      if (sel === NEW) {
        const form = ProductForm.get(newProductPrefix(id));
        line.newProduct = form ? form.readRaw() : ProductForm.toRaw(null);
      }
      return line;
    });
    return {
      id: form.id, supplierId: $("pf-supplier").value, supplierInvoiceNumber: $("pf-invoiceNo").value, noSupplierInvoice: $("pf-noInvoice").checked,
      invoiceDate: $("pf-date").value, dueDate: $("pf-due").value, reference: $("pf-reference").value, notes: $("pf-notes").value, lines,
      discountType: $("pf-discountType").value, discountValue: $("pf-discount").value, taxType: $("pf-taxType").value, taxValue: $("pf-tax").value,
      taxMode: $("pf-taxMode").value, delivery: $("pf-delivery").value, otherCosts: $("pf-other").value,
      initialPayment: { amount: $("pf-payAmount").value, date: $("pf-payDate").value, reference: $("pf-payRef").value },
      advanceApply: $("pf-advance") ? $("pf-advance").value : "",
      receiveNow: $("pf-receive").checked, receiptDate: $("pf-receiptDate").value,
    };
  }

  // Redraws what is worked out from the form: each line's amount and what it adds to stock, the totals, the due date.
  // The conversion into stock units is never typed: it comes from purchases.js (the same reading as saving), which
  // takes it from the product's own saved tile size, coverage per box and stock unit.
  function updatePurchasePreview() {
    if (!ui.pur.form || !$("pfLines")) return;
    const v = readPurchaseForm();
    const supplier = supplierById(v.supplierId);
    const read = P.previewPurchase(S(), v, "draft");
    const calcLines = [];
    v.lines.forEach((line, index) => {
      const unit = line.unit;
      const qty = loose(line.qty);
      const priced = { qty, unitPrice: loose(line.unitPrice), discount: loose(line.discount), factor: 1 };
      calcLines.push(priced);
      $(`pl-${line.id}-total`).textContent = num(P.lineTotalOf(priced));

      const own = read.purchase.lines.find((l) => l.id === line.id) || null;
      const problems = read.errors.filter((e) => e.line === index && /\.(unit|qty)$/.test(e.field));
      const conv = $(`pl-${line.id}-conv`);
      const editBtn = $(`pl-${line.id}-edit`);
      const problem = problems[0] || null;
      const existing = !line.newProduct && S().products.some((x) => x.id === line.productId);
      conv.classList.toggle("conv-error", Boolean(problem));
      if (problem) conv.textContent = problem.message;
      else if (own && own.stockUnit && qty > 0) {
        // 207.36 m² = 144 boxes, and the rule it comes from: 1 box = 1.44 m²
        const rule = conversionRule(unit, own.stockUnit, own.factor);
        const eq = rule ? ` (${rule})` : "";
        conv.textContent = `${qtyText(qty, unit)} = ${stockQtyText(own.baseQty, own.stockUnit)}${eq}`;
      } else conv.textContent = "";
      // A conversion that fails because of what the product lacks can be put right from here, without losing the purchase.
      if (editBtn) editBtn.hidden = !(problem && /\.unit$/.test(problem.field) && existing);

      const hint = $(`pl-${line.id}-hint`);
      const product = line.newProduct ? null : S().products.find((x) => x.id === line.productId);
      if (product) {
        const last = P.productHistory(S(), product.id)[0];
        hint.textContent = [
          t("pur.hint.stock", { stock: h.stockText(product) }),
          t("pur.hint.selling", { price: h.priceLabel(product) }),
          last ? t("pur.hint.last", { price: money(last.line.unitPrice), unit: unitName(last.line.unit), date: fmtDay(last.purchase.invoiceDate) }) : "",
        ].filter(Boolean).join(" · ");
      } else hint.textContent = "";
    });
    const totals = P.computeTotals({
      lines: calcLines, discountType: v.discountType, discountValue: loose(v.discountValue), taxType: v.taxType, taxValue: loose(v.taxValue),
      taxMode: v.taxMode, delivery: loose(v.delivery), otherCosts: loose(v.otherCosts),
    });
    const paidNow = Math.min(loose(v.initialPayment.amount), totals.total);
    // The supplier's unapplied deposits, offered only when there are some (a normal purchase gets no extra step).
    const pool = supplier ? P.advanceTotals(supplier.id, S().supplierDeposits, S().advanceAllocations).unapplied : 0;
    const advMax = Math.max(0, Math.min(pool, round(totals.total - paidNow)));
    const advance = Math.min(loose(v.advanceApply), advMax);
    $("pf-advRow").hidden = !(pool > 0 || loose(v.advanceApply) > 0);
    $("pf-advHint").textContent = t("adv.available", { amount: money(Math.max(0, pool)) });
    $("pf-advMax").textContent = t("adv.useMax", { amount: money(advMax) });
    $("pf-advMax").disabled = advMax <= 0;
    const row = (label, value, cls) => `<div${cls ? ` class="${cls}"` : ""}><span>${esc(label)}</span><span>${esc(value)}</span></div>`;
    $("pfTotals").innerHTML = row(t("inv.subtotal"), money(totals.subtotal))
      + (totals.discount ? row(t("inv.discount"), "− " + money(totals.discount)) : "")
      + (v.taxType !== "none" ? row(t("inv.tax") + (v.taxMode === "included" ? " (" + t("pur.tax.included").toLowerCase() + ")" : ""), money(totals.tax)) : "")
      + (totals.delivery ? row(t("pur.f.delivery"), money(totals.delivery)) : "")
      + (totals.otherCosts ? row(t("pur.f.otherCosts"), money(totals.otherCosts)) : "")
      + row(t("inv.grandTotal"), money(totals.total), "grand")
      + (advance > 0 ? row(t("adv.appliedRow"), money(advance)) : "")
      + (paidNow > 0 ? row(t("pur.paidNow"), money(paidNow)) : "")
      + (paidNow > 0 || advance > 0 ? row(t("pur.owedAfter"), money(Math.max(0, totals.total - paidNow - advance)), "due") + (advance > 0 ? row(t("adv.remainingAfter"), money(Math.max(0, pool - advance))) : "") : "");
    $("pf-supplierInfo").textContent = supplier ? supplierInfoText(supplier) : "";
    // The due date follows the supplier's payment terms until it is typed by hand.
    if (!ui.pur.form.dueTouched && supplier && P.isDay(v.invoiceDate)) $("pf-due").value = P.addDays(v.invoiceDate, supplier.paymentTermsDays || 0);
  }

  function supplierInfoText(supplier) {
    const sum = P.supplierSummary(supplier, S().purchases, S().supplierPayments, today(), S().supplierDeposits, S().advanceAllocations);
    const terms = supplier.paymentTermsDays === 0 ? t("sup.terms.immediate") : tn("sup.terms.days", supplier.paymentTermsDays);
    return t("pur.supplierInfo", { terms, owed: money(sum.owed) })
      + (sum.unapplied > 0 ? " · " + t("adv.supplierInfo", { amount: money(sum.unapplied) }) : "")
      + (supplier.creditLimit != null ? " · " + t("pur.supplierLimit", { limit: money(supplier.creditLimit) }) : "");
  }

  function openPurchaseForm(values, attachments, editing) {
    ui.pur.screen = "form";
    ui.pur.tab = "list";
    ui.pur.form = {
      id: values.id, values, editing: Boolean(editing), attachments: attachments || [], pending: [], removed: [],
      dueTouched: Boolean(values.dueDate), ready: false,
    };
    if (S().view !== "purchases") h.showView("purchases");
    else renderPurchases();
  }

  function newPurchase(supplierId) {
    openPurchaseForm(blankValues(supplierId), [], false);
  }

  function editDraft(id) {
    const p = purchaseById(id);
    if (!p || p.status !== "draft") return;
    openPurchaseForm(valuesFromPurchase(p), (p.attachments || []).map((a) => ({ ...a })), true);
  }

  // The warning (never a block) when this purchase takes what is owed to the supplier over the credit limit.
  function creditWarning(supplierId, total, paidNow) {
    const supplier = supplierById(supplierId);
    if (!supplier || supplier.creditLimit == null) return "";
    const sum = P.supplierSummary(supplier, S().purchases, S().supplierPayments, today(), S().supplierDeposits, S().advanceAllocations);
    const after = sum.outstanding + total - paidNow;
    return after > supplier.creditLimit + 0.01 ? t("pur.creditWarning", { name: supplier.name, after: money(after), limit: money(supplier.creditLimit) }) : "";
  }

  function showLineErrors(errors) {
    for (const e of errors || []) {
      const m = /^line\.(\d+)\.(.+)$/.exec(e.field || "");
      if (!m) continue;
      const row = [...$("pfLines").querySelectorAll(".pl-row")][Number(m[1])];
      if (row) {
        const box = $(`pl-${row.dataset.line}-error`);
        if (box) box.textContent = (box.textContent ? box.textContent + "\n" : "") + e.message;
        // A problem with the new product's form is marked on the box it belongs to.
        const own = /^newProduct\.(.+)$/.exec(m[2]);
        const form = own ? ProductForm.get(newProductPrefix(row.dataset.line)) : null;
        if (form) form.mark(own[1], e.priceIndex);
      }
    }
  }

  // Maps an error field of purchases.js to the box that shows it.
  function formFieldId(field) {
    const map = {
      advanceApply: "pf-advance", supplierId: "pf-supplier", supplierInvoiceNumber: "pf-invoiceNo", invoiceDate: "pf-date", dueDate: "pf-due", reference: "pf-reference", notes: "pf-notes",
      discountValue: "pf-discount", taxValue: "pf-tax", delivery: "pf-delivery", otherCosts: "pf-other",
      "initialPayment.amount": "pf-payAmount", "initialPayment.date": "pf-payDate", lines: "pf-lines-error", attachments: "pf-att-error",
    };
    return map[field] || "";
  }

  function submitPurchase(confirmNow) {
    const form = ui.pur.form;
    const v = readPurchaseForm();
    clearInvalid($("purchaseForm"));
    for (const el of ["pf-error", "pf-lines-error"]) showErr(el, "");
    [...$("pfLines").querySelectorAll(".pl-row")].forEach((row) => showErr(`pl-${row.dataset.line}-error`, ""));

    const input = { ...v, attachments: [...form.attachments, ...form.pending].map(P.attachmentMeta) };
    if (confirmNow) {
      const preview = P.previewPurchase(S(), input, "confirm");
      if (!preview.errors.length) {
        const supplier = supplierById(v.supplierId);
        const warn = creditWarning(v.supplierId, preview.purchase.total, preview.purchase.initialPayment ? preview.purchase.initialPayment.amount : 0);
        const ask = t("pur.confirmAsk", {
          supplier: supplier ? supplier.name : "", total: money(preview.purchase.total),
          stock: t(v.receiveNow ? "pur.confirmStockNow" : "pur.confirmStockLater"),
        }) + (warn ? "\n\n" + warn : "");
        if (!confirm(ask)) return;
      }
    }
    return act((d) => {
      const saved = P.saveDraft(d, input);
      if (saved.error) return saved;
      const id = saved.purchase.id;
      d.attachments.put.push(...form.pending.map((a) => ({ ...a, purchaseId: id })));
      d.attachments.remove.push(...form.removed);
      if (!confirmNow) return { purchase: saved.purchase, drafted: true };
      const done = P.confirmPurchase(d, id, { receive: v.receiveNow ? undefined : {}, receiptDate: v.receiptDate });
      return done.error ? done : { purchase: done.purchase, receipt: done.receipt, createdProducts: done.createdProducts };
    }, {
      errorId: "pf-error",
      done: (r) => {
        h.notify(r.drafted ? t("pur.draftSaved", { ref: r.purchase.reference }) : t("pur.confirmed", { ref: r.purchase.reference }));
        openPurchase(r.purchase.id);
      },
      onError: (r) => {
        showLineErrors(r.errors);
        const id = formFieldId(r.field);
        if (id && $(id) && id !== "pf-lines-error" && id !== "pf-att-error") {
          $(id).setAttribute("aria-invalid", "true");
          if ($(id).focus) $(id).focus();
        }
      },
    });
  }

  /* ==========================================================================
     PURCHASE DETAIL
     ========================================================================== */

  function openPurchase(id) {
    ui.pur.screen = "detail";
    ui.pur.detailId = id;
    ui.pur.open = "";
    ui.pur.form = null;
    if (S().view !== "purchases") h.showView("purchases");
    else renderPurchases();
  }

  function logLabel(entry) {
    const label = t("pur.log." + entry.event, { amount: entry.amount !== undefined ? money(entry.amount) : "" });
    return entry.note ? `${label}: ${entry.note}` : label;
  }

  function linesTableHtml(p, sum) {
    const confirmed = p.status === "confirmed";
    const rows = p.lines.map((l) => {
      const d = sum.delivery.lines.find((x) => x.lineId === l.id);
      return `<tr>
        <td>${esc(l.productName)}${l.tileSize ? ` <span class="muted small">${esc(h.formatTileSize(l.tileSize))}</span>` : ""}${l.newProduct ? " " + badge("info", t("pur.newProductTag")) : ""}${l.notes ? `<div class="muted small">${esc(l.notes)}</div>` : ""}</td>
        <td class="num">${esc(qtyText(l.qty, l.unit))}</td>
        <td class="num">${l.stockUnit ? esc(stockQtyText(l.baseQty, l.stockUnit)) : ""}${l.stockUnit && l.unit !== l.stockUnit ? `<div class="muted small">${esc(conversionRule(l.unit, l.stockUnit, l.factor))}</div>` : ""}</td>
        <td class="num">${esc(money(l.unitPrice))} / ${esc(unitName(l.unit))}</td>
        <td class="num">${l.discount ? esc(money(l.discount)) : ""}</td>
        <td class="num">${esc(money(l.lineTotal))}</td>
        ${confirmed ? `<td class="num">${esc(qtyText(d.received, l.unit))}${d.remaining > 0 ? `<div class="muted small">${esc(t("pur.line.remaining", { qty: qtyText(d.remaining, l.unit) }))}</div>` : ""}</td>` : ""}
      </tr>`;
    }).join("");
    return `<div class="table-wrap"><table class="table"><thead><tr><th>${esc(t("col.product"))}</th><th class="num">${esc(t("col.qty"))}</th><th class="num">${esc(t("pur.line.stockQty"))}</th>
      <th class="num">${esc(t("pur.line.price"))}</th><th class="num">${esc(t("pur.line.discount"))}</th><th class="num">${esc(t("col.total"))}</th>${confirmed ? `<th class="num">${esc(t("pur.line.received"))}</th>` : ""}</tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function totalsHtml(p, sum) {
    const row = (label, value, cls) => `<div${cls ? ` class="${cls}"` : ""}><span>${esc(label)}</span><span>${esc(value)}</span></div>`;
    const confirmed = p.status === "confirmed";
    return `<div class="totals">${row(t("inv.subtotal"), money(p.subtotal))}
      ${p.discount ? row(t("inv.discount") + (p.discountType === "percent" ? ` (${num(p.discountValue)}%)` : ""), "− " + money(p.discount)) : ""}
      ${p.taxType !== "none" ? row(t("inv.tax") + (p.taxType === "percent" ? ` (${num(p.taxValue)}%)` : "") + (p.taxMode === "included" ? " · " + t("pur.tax.included").toLowerCase() : ""), money(p.tax)) : ""}
      ${p.delivery ? row(t("pur.f.delivery"), money(p.delivery)) : ""}${p.otherCosts ? row(t("pur.f.otherCosts"), money(p.otherCosts)) : ""}
      ${row(t("inv.grandTotal"), money(p.total), "grand")}
      ${confirmed ? row(t("col.paid"), money(sum.paid)) + row(t("pur.col.outstanding"), money(sum.outstanding), "due") : ""}</div>`;
  }

  function paymentsPanelHtml(p, sum) {
    const all = S().supplierPayments.filter((x) => x.purchaseId === p.id).sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
    const open = ui.pur.open;
    const rows = all.map((x) => {
      if (open === "editPay:" + x.id) return `<tr><td colspan="5">${paymentFormHtml("pur-editpay", x)}</td></tr>`;
      if (open === "voidPay:" + x.id) {
        return `<tr><td colspan="5"><form data-form="pur-voidpay" novalidate>
          <p>${esc(t("spay.voidAsk", { amount: money(x.amount), date: fmtDay(x.date) }))}</p>
          ${field("dv-reason", esc(t("spay.voidReason")), `<input type="text" id="dv-reason" autocomplete="off">`)}
          <p class="error" id="dv-error" role="alert"></p>
          <div class="actions left"><button type="submit" class="btn danger">${esc(t("spay.voidBtn"))}</button><button type="button" class="btn" data-act="pur-close-panel">${esc(t("common.cancel"))}</button></div></form></td></tr>`;
      }
      const was = (x.history || []).map((hh) => `<div class="muted small">${esc(t("spay.was", { amount: money(hh.amount), date: fmtDay(hh.date) }))}</div>`).join("");
      return `<tr${x.status === "voided" ? ' class="voided"' : ""}>
        <td>${esc(fmtDay(x.date))}</td><td class="num">${esc(money(x.amount))}</td>
        <td>${esc(x.reference)}${x.note ? `<div class="muted small">${esc(x.note)}</div>` : ""}${was}${x.status === "voided" ? `<div class="small">${esc(t("spay.voidedBecause", { reason: x.voidReason }))}</div>` : ""}</td>
        <td>${x.status === "voided" ? badge("st-cancelled", t("spay.voided")) : ""}</td>
        <td class="num">${x.status === "recorded" && p.status === "confirmed" ? `<div class="row-actions"><button type="button" class="btn small" data-act="pur-panel" data-panel="editPay:${esc(x.id)}">${esc(t("common.edit"))}</button>
          <button type="button" class="btn small danger" data-act="pur-panel" data-panel="voidPay:${esc(x.id)}">${esc(t("spay.void"))}</button></div>` : ""}</td></tr>`;
    }).join("");
    const payForm = open === "pay" ? `<div class="subpanel">${paymentFormHtml("pur-pay", null, sum)}</div>` : "";
    const pool = P.advanceTotals(p.supplierId, S().supplierDeposits, S().advanceAllocations).unapplied;
    const allocs = S().advanceAllocations.filter((a) => a.purchaseId === p.id).sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
    const allocRows = allocs.map((a) => {
      if (open === "releaseAdv:" + a.id) {
        return `<tr><td colspan="4"><form data-form="pur-releaseadv" novalidate>
          <p>${esc(t("adv.releaseAsk", { amount: money(a.amount) }))}</p>
          ${field("da-reason", esc(t("spay.voidReason")), `<input type="text" id="da-reason" autocomplete="off">`)}
          <p class="error" id="da-error" role="alert"></p>
          <div class="actions left"><button type="submit" class="btn danger">${esc(t("adv.releaseBtn"))}</button><button type="button" class="btn" data-act="pur-close-panel">${esc(t("common.cancel"))}</button></div></form></td></tr>`;
      }
      const from = S().supplierDeposits.find((x) => x.id === a.depositId);
      return `<tr${a.status === "reversed" ? ' class="voided"' : ""}><td>${esc(fmtDay(a.date))}</td><td class="num">${esc(money(a.amount))}</td>
        <td>${esc(from ? t("dep.fromDeposit", { date: fmtDay(from.date), amount: money(from.amount) }) : "")}${a.status === "reversed" ? `<div class="small">${esc(t("spay.voidedBecause", { reason: a.reverseReason }))}</div>` : ""}</td>
        <td class="num">${a.status === "reversed" ? badge("st-cancelled", t("adv.reversed")) : p.status === "confirmed" ? `<button type="button" class="btn small danger" data-act="pur-panel" data-panel="releaseAdv:${esc(a.id)}">${esc(t("adv.release"))}</button>` : ""}</td></tr>`;
    }).join("");
    const advForm = open === "applyAdv" ? `<div class="subpanel"><form data-form="pur-applyadv" novalidate>
        <p class="muted small">${esc(t("adv.available", { amount: money(Math.max(0, pool)) }))}</p>
        <div class="grid-3">${field("da-amount", esc(t("adv.useLabel")), `<input type="number" id="da-amount" min="0" step="any" placeholder="${esc(t("spay.max", { max: num(Math.min(pool, sum.outstanding)) }))}">`)}</div>
        <p class="error" id="da-error" role="alert"></p>
        <div class="actions left"><button type="submit" class="btn primary">${esc(t("adv.applyBtn"))}</button>
          <button type="button" class="btn" data-act="pur-adv-fill" data-target="da-amount" data-max="${Math.max(0, Math.min(pool, sum.outstanding))}">${esc(t("adv.useMax", { amount: money(Math.max(0, Math.min(pool, sum.outstanding))) }))}</button>
          <button type="button" class="btn" data-act="pur-close-panel">${esc(t("common.cancel"))}</button></div></form></div>` : "";
    return `<div class="panel"><div class="panel-head"><h2>${esc(t("pur.payments"))}</h2>
        <div class="actions">${p.status === "confirmed" && sum.outstanding > 0 && pool > 0 && open !== "applyAdv" ? `<button type="button" class="btn" data-act="pur-panel" data-panel="applyAdv">${esc(t("adv.apply"))}</button>` : ""}
        ${p.status === "confirmed" && sum.outstanding > 0 && open !== "pay" ? `<button type="button" class="btn primary" data-act="pur-panel" data-panel="pay">${esc(t("spay.recordBtn"))}</button>` : ""}</div></div>
      <div class="stat-strip small">${stat(t("col.total"), esc(money(p.total)))}${stat(t("col.paid"), esc(money(sum.paid)) + (sum.advanceApplied > 0 ? `<span class="state">${esc(t("adv.ofWhich", { amount: money(sum.advanceApplied) }))}</span>` : ""))}${stat(t("pur.col.outstanding"), esc(money(sum.outstanding)), sum.outstanding > 0 ? "warn" : "")}
        ${stat(t("col.status"), sum.paymentStatus ? esc(t("pur.pay." + sum.paymentStatus)) : "—")}${stat(t("pur.col.due"), esc(fmtDay(p.dueDate) || "—") + (sum.overdue ? " " + badge("overdue", tn("pur.overdueDays", sum.daysOverdue)) : ""))}</div>
      ${payForm}${advForm}
      <div class="table-wrap"><table class="table"><thead><tr><th>${esc(t("spay.date"))}</th><th class="num">${esc(t("spay.amount"))}</th><th>${esc(t("spay.reference"))}</th><th></th><th></th></tr></thead>
      <tbody>${rows || (allocRows ? "" : `<tr class="empty-row"><td colspan="5">${esc(t("spay.none"))}</td></tr>`)}</tbody></table></div>
      ${allocRows ? `<h3>${esc(t("adv.history"))}</h3><div class="table-wrap"><table class="table"><thead><tr><th>${esc(t("spay.date"))}</th><th class="num">${esc(t("spay.amount"))}</th><th>${esc(t("adv.from"))}</th><th></th></tr></thead><tbody>${allocRows}</tbody></table></div>` : ""}</div>`;
  }

  function paymentFormHtml(formName, payment, sum) {
    const x = payment || {};
    return `<form data-form="${formName}" novalidate>
      <div class="grid-4">
        ${field("dp-amount", esc(t("spay.amount")), `<input type="number" id="dp-amount" min="0" step="any" value="${payment ? esc(x.amount) : ""}" placeholder="${sum ? esc(t("spay.max", { max: num(sum.outstanding) })) : ""}">`)}
        ${field("dp-date", esc(t("spay.date")), `<input type="date" id="dp-date" value="${esc(payment ? x.date : today())}" max="${today()}">`)}
        ${field("dp-ref", esc(t("spay.reference")), `<input type="text" id="dp-ref" value="${esc(x.reference || "")}" autocomplete="off">`)}
        ${field("dp-note", esc(t("spay.note")), `<input type="text" id="dp-note" value="${esc(x.note || "")}" autocomplete="off">`)}
      </div>
      <p class="error" id="dp-error" role="alert"></p>
      <div class="actions left"><button type="submit" class="btn primary">${esc(t(payment ? "spay.saveChange" : "spay.recordBtn"))}</button>
        ${sum ? `<button type="button" class="btn" data-act="pur-pay-full">${esc(t("spay.payFull", { amount: money(sum.outstanding) }))}</button>` : ""}
        <button type="button" class="btn" data-act="pur-close-panel">${esc(t("common.cancel"))}</button></div></form>`;
  }

  function deliveriesPanelHtml(p, sum) {
    const open = ui.pur.open;
    const receipts = [...(p.receipts || [])].sort((a, b) => a.at.localeCompare(b.at));
    const describe = (r) => r.lines.map((x) => {
      const line = p.lines.find((l) => l.id === x.lineId);
      return `${esc(line ? line.productName : "")}: ${esc(qtyText(x.qty, line ? line.unit : ""))}${line && line.stockUnit ? ` <span class="dir-arrow">→</span> ${esc(stockQtyText(x.baseQty, line.stockUnit))}` : ""}`;
    }).join("<br>");
    const rows = receipts.map((r) => {
      if (open === "reverse:" + r.id) {
        return `<tr><td colspan="5"><form data-form="pur-reverse" data-receipt="${esc(r.id)}" novalidate>
          <p>${esc(t("pur.reverseAsk"))}</p>
          ${field("dx-reason", esc(t("pur.reason")), `<input type="text" id="dx-reason" autocomplete="off">`)}
          <p class="error" id="dx-error" role="alert"></p>
          <div class="actions left"><button type="submit" class="btn danger">${esc(t("pur.reverseBtn"))}</button><button type="button" class="btn" data-act="pur-close-panel">${esc(t("common.cancel"))}</button></div></form></td></tr>`;
      }
      return `<tr${r.status === "reversed" ? ' class="voided"' : ""}><td>${esc(fmtDay(r.date))}</td><td>${describe(r)}${r.note ? `<div class="muted small">${esc(r.note)}</div>` : ""}</td>
        <td>${r.status === "reversed" ? badge("st-cancelled", t("pur.receipt.reversed")) + `<div class="small">${esc(r.reversalReason)}</div>` : badge("st-confirmed", t("pur.receipt.applied"))}</td>
        <td class="num">${r.status === "applied" && p.status === "confirmed" ? `<button type="button" class="btn small danger" data-act="pur-panel" data-panel="reverse:${esc(r.id)}">${esc(t("pur.reverse"))}</button>` : ""}</td></tr>`;
    }).join("");
    let receiveForm = "";
    if (open === "receive") {
      const pending = sum.delivery.lines.filter((x) => x.remaining > 0);
      receiveForm = `<div class="subpanel"><form data-form="pur-receive" novalidate>
        <p class="muted small">${esc(t("pur.receiveNote"))}</p>
        ${pending.map((x) => { const l = p.lines.find((y) => y.id === x.lineId); return field(`dr-${l.id}`, `${esc(l.productName)} <span class="muted small">(${esc(t("pur.line.remaining", { qty: qtyText(x.remaining, l.unit) }))})</span>`, `<input type="number" id="dr-${l.id}" min="0" step="any" value="${esc(x.remaining)}" data-line="${esc(l.id)}">`, "dr-line"); }).join("")}
        <div class="grid-2">${field("dr-date", esc(t("pur.receiptDate")), `<input type="date" id="dr-date" value="${today()}" max="${today()}">`)}${field("dr-note", esc(t("spay.note")), `<input type="text" id="dr-note" autocomplete="off">`)}</div>
        <p class="error" id="dr-error" role="alert"></p>
        <div class="actions left"><button type="submit" class="btn primary">${esc(t("pur.receiveBtn"))}</button><button type="button" class="btn" data-act="pur-close-panel">${esc(t("common.cancel"))}</button></div></form></div>`;
    }
    return `<div class="panel"><div class="panel-head"><h2>${esc(t("pur.deliveries"))} ${sum.delivery.status ? badge("dl-" + sum.delivery.status, t("pur.delivery." + sum.delivery.status)) : ""}</h2>
        ${p.status === "confirmed" && sum.delivery.status !== "received" && open !== "receive" ? `<button type="button" class="btn primary" data-act="pur-panel" data-panel="receive">${esc(t("pur.receiveBtn"))}</button>` : ""}</div>
      ${receiveForm}
      <div class="table-wrap"><table class="table"><thead><tr><th>${esc(t("spay.date"))}</th><th>${esc(t("pur.receipt.goods"))}</th><th>${esc(t("col.status"))}</th><th></th></tr></thead>
      <tbody>${rows || `<tr class="empty-row"><td colspan="4">${esc(t("pur.receipt.none"))}</td></tr>`}</tbody></table></div></div>`;
  }

  function attachmentsPanelHtml(p) {
    const list = p.attachments || [];
    return `<div class="panel"><h2>${esc(t("pur.att.title"))}</h2>
      ${list.length ? `<ul class="att-list">${list.map((a) => `<li><span>${esc(a.name)} <span class="muted small">(${esc(sizeText(a.size))})</span></span>
        <span><button type="button" class="btn small" data-act="att-open" data-id="${esc(a.id)}">${esc(t("pur.att.open"))}</button>
        <button type="button" class="btn small" data-act="att-download" data-id="${esc(a.id)}">${esc(t("pur.att.download"))}</button>
        <button type="button" class="btn small danger" data-act="att-remove" data-id="${esc(a.id)}">${esc(t("common.remove"))}</button></span></li>`).join("")}</ul>` : `<p class="muted small">${esc(t("pur.att.none"))}</p>`}
      <label class="file-add">${esc(t("pur.att.add"))} <input type="file" id="dtFile" accept="image/jpeg,image/png,image/webp,application/pdf" multiple></label>
      <p class="muted small">${esc(t("pur.att.note"))}</p></div>`;
  }

  // The supplier's unapplied deposits, offered when confirming a draft: an optional amount, never all of it by force.
  function advanceChoiceHtml(p, ip) {
    const pool = P.advanceTotals(p.supplierId, S().supplierDeposits, S().advanceAllocations).unapplied;
    if (!(pool > 0)) return "";
    const max = Math.max(0, Math.min(pool, round(p.total - (ip && ip.amount ? Number(ip.amount) : 0))));
    return `<div class="grid-3">
        ${field("dc-advance", esc(t("adv.useLabel")), `<input type="number" id="dc-advance" min="0" step="any" value="${p.advanceApply ? esc(p.advanceApply) : ""}" placeholder="0">`)}
        <div class="field"><span class="label-spacer">&nbsp;</span><button type="button" class="btn" data-act="pur-adv-fill" data-target="dc-advance" data-max="${max}">${esc(t("adv.useMax", { amount: money(max) }))}</button></div>
      </div>
      <p class="muted small">${esc(t("adv.available", { amount: money(pool) }))}</p>`;
  }

  function panelHtml(p, sum) {
    const open = ui.pur.open;
    const wrap = (title, inner) => `<div class="panel action-panel"><h2>${esc(title)}</h2>${inner}</div>`;
    const close = `<button type="button" class="btn" data-act="pur-close-panel">${esc(t("common.cancel"))}</button>`;
    if (open === "confirm" && p.status === "draft") {
      const ip = p.initialPayment || {};
      return wrap(t("pur.confirmTitle"), `<form data-form="pur-confirm" novalidate>
        <p class="notice">${esc(t("pur.confirmNote"))}</p>
        <label class="check"><input type="checkbox" id="dc-receive" checked> ${esc(t("pur.receiveNow"))}</label>
        ${field("dc-rdate", esc(t("pur.receiptDate")), `<input type="date" id="dc-rdate" value="${today()}" max="${today()}">`, "narrow")}
        <div class="grid-3">
          ${field("dc-pamount", esc(t("pur.paymentNow")), `<input type="number" id="dc-pamount" min="0" step="any" value="${ip.amount ? esc(ip.amount) : ""}" placeholder="0">`)}
          ${field("dc-pdate", esc(t("spay.date")), `<input type="date" id="dc-pdate" value="${esc(ip.date || today())}" max="${today()}">`)}
          ${field("dc-pref", esc(t("spay.reference")), `<input type="text" id="dc-pref" value="${esc(ip.reference || "")}" autocomplete="off">`)}
        </div>
        ${advanceChoiceHtml(p, ip)}
        <p class="error" id="dc-error" role="alert"></p>
        <div class="actions left"><button type="submit" class="btn primary">${esc(t("pur.confirm"))}</button>${close}</div></form>`);
    }
    if (open === "cancel" && p.status !== "cancelled") {
      const blocked = sum.payments.length > 0;
      const applied = (p.receipts || []).some((r) => r.status === "applied");
      const advance = sum.advanceApplied > 0 ? `<p class="notice">${esc(t("adv.cancelNote", { amount: money(sum.advanceApplied) }))}</p>` : "";
      return wrap(t("pur.cancelTitle"), `<form data-form="pur-cancel" novalidate>${advance}
        ${blocked ? `<p class="error">${esc(t("pur.cancelHasPayments", { n: sum.payments.length }))}</p>` : `<p class="notice">${esc(t(p.status === "draft" ? "pur.cancelDraftNote" : applied ? "pur.cancelStockNote" : "pur.cancelNote"))}</p>`}
        ${field("dk-reason", esc(t("pur.reason")), `<input type="text" id="dk-reason" autocomplete="off">`)}
        <p class="error" id="dk-error" role="alert"></p>
        <div class="actions left"><button type="submit" class="btn danger"${blocked ? " disabled" : ""}>${esc(t("pur.cancelBtn"))}</button>${close}</div></form>`);
    }
    if (open === "details" && p.status === "confirmed") {
      return wrap(t("pur.detailsTitle"), `<form data-form="pur-details" novalidate>
        <p class="muted small">${esc(t("pur.detailsNote"))}</p>
        <div class="grid-3">
          ${field("de-invoiceNo", esc(t("pur.f.invoiceNo")), `<input type="text" id="de-invoiceNo" value="${esc(p.supplierInvoiceNumber)}"${p.noSupplierInvoice ? " disabled" : ""}><label class="check"><input type="checkbox" id="de-noInvoice"${p.noSupplierInvoice ? " checked" : ""}> ${esc(t("pur.f.noInvoice"))}</label>`)}
          ${field("de-date", esc(t("pur.f.invoiceDate")), `<input type="date" id="de-date" value="${esc(p.invoiceDate)}">`)}
          ${field("de-due", esc(t("pur.f.dueDate")), `<input type="date" id="de-due" value="${esc(p.dueDate)}">`)}
        </div>
        <div class="grid-2">${field("de-ref", esc(t("pur.f.reference")), `<input type="text" id="de-ref" value="${esc(p.reference)}">`)}${field("de-notes", esc(t("pur.f.notes")), `<input type="text" id="de-notes" value="${esc(p.notes)}">`)}</div>
        <p class="error" id="de-error" role="alert"></p>
        <div class="actions left"><button type="submit" class="btn primary">${esc(t("spay.saveChange"))}</button>${close}</div></form>`);
    }
    return "";
  }

  function purchaseDetailHtml(p) {
    const sp = supplierById(p.supplierId);
    const sum = summaryOf(p);
    const open = ui.pur.open;
    const btn = (act, label, cls, extra) => `<button type="button" class="btn ${cls || ""}" data-act="${act}" ${extra || ""}>${esc(label)}</button>`;
    const actions = [];
    if (p.status === "draft") {
      actions.push(btn("pur-edit", t("common.edit")), btn("pur-panel", t("pur.confirm"), "primary", 'data-panel="confirm"'), btn("pur-delete-draft", t("pur.deleteDraft"), "danger"));
    } else if (p.status === "confirmed") {
      actions.push(btn("pur-panel", t("pur.editDetails"), "", 'data-panel="details"'), btn("pur-panel", t("pur.cancelBtn"), "danger", 'data-panel="cancel"'));
    }
    if (p.status !== "draft") actions.push(btn("pur-delete", t("pur.deleteBtn"), "danger", `data-id="${esc(p.id)}"`));
    actions.push(btn("pur-print", t("sup.print")));
    const info = (label, value) => (value ? `<dt>${esc(label)}</dt><dd>${value}</dd>` : "");
    return `<div class="panel profile-head">
        <div><button type="button" class="link back" data-act="pur-back"><span class="dir-arrow">←</span> ${esc(t("pur.title"))}</button>
          <h2>${esc(p.reference)} ${statusBadge(p)} ${payBadge(p, sum)} ${deliveryBadge(p, sum)}</h2></div>
        <div class="actions wrap">${actions.join("")}</div>
      </div>
      ${p.status === "cancelled" ? `<p class="warn-box">${esc(t("pur.cancelledOn", { date: h.formatDateTime(p.cancelledAt), reason: p.cancelReason }))}</p>` : ""}
      ${p.status === "draft" ? `<p class="notice">${esc(t("pur.draftNote"))}</p>` : ""}
      ${panelHtml(p, sum)}
      <div class="panel"><dl class="data-info">
        ${info(t("pur.col.supplier"), sp ? `<button type="button" class="link" data-act="sup-open" data-id="${esc(sp.id)}">${esc(sp.name)}</button>` : "")}
        ${info(t("pur.f.invoiceNo"), esc(p.noSupplierInvoice ? t("pur.noInvoiceShort") : p.supplierInvoiceNumber))}
        ${info(t("pur.f.invoiceDate"), esc(fmtDay(p.invoiceDate)))}${info(t("pur.f.dueDate"), esc(fmtDay(p.dueDate)))}
        ${info(t("pur.f.reference"), esc(p.reference))}${info(t("pur.f.notes"), `<span class="prewrap">${esc(p.notes)}</span>`)}
        ${info(t("pur.confirmedAt"), esc(p.confirmedAt ? h.formatDateTime(p.confirmedAt) : ""))}
      </dl></div>
      <div class="panel"><h2>${esc(t("pur.lines"))}</h2>${linesTableHtml(p, sum)}${totalsHtml(p, sum)}
        ${p.status === "draft" && p.initialPayment ? `<p class="muted small">${esc(t("pur.draftPayment", { amount: money(p.initialPayment.amount) }))}</p>` : ""}</div>
      ${p.status === "confirmed" || (p.status === "cancelled" && sum.payments.length + S().supplierPayments.filter((x) => x.purchaseId === p.id).length > 0) ? paymentsPanelHtml(p, sum) : ""}
      ${p.status !== "draft" && ((p.receipts || []).length || p.status === "confirmed") ? deliveriesPanelHtml(p, sum) : ""}
      ${attachmentsPanelHtml(p)}
      <div class="panel"><h2>${esc(t("pur.log.title"))}</h2><ul class="log">${[...(p.log || [])].reverse().map((e) => `<li><span class="muted">${esc(h.formatDateTime(e.at))}</span> ${esc(logLabel(e))}</li>`).join("")}</ul></div>`;
  }

  function purchasePrintHtml(p) {
    const sp = supplierById(p.supplierId);
    const sum = summaryOf(p);
    const cur = p.currency || S().settings.currency;
    const m = (n) => h.money(n, cur);
    return `<header class="inv-head">${businessHeader()}<div class="inv-title">${esc(t("pur.print.title"))}</div></header>
      <div class="inv-meta"><div><div class="label">${esc(t("pur.col.supplier"))}</div><div class="inv-customer">${esc(sp ? sp.name : "")}${sp && P.supplierPhones(sp).length ? "\n" + esc(P.supplierPhones(sp).map(h.ltr).join(" · ")) : ""}${sp && sp.address ? "\n" + esc(sp.address) : ""}</div></div>
      <div class="right"><div><span class="label">${esc(t("pur.f.reference"))}</span> ${esc(p.reference)}</div>
        <div><span class="label">${esc(t("pur.f.invoiceNo"))}</span> ${esc(p.noSupplierInvoice ? t("pur.noInvoiceShort") : p.supplierInvoiceNumber)}</div>
        <div><span class="label">${esc(t("pur.f.invoiceDate"))}</span> ${esc(fmtDay(p.invoiceDate))}</div><div><span class="label">${esc(t("pur.f.dueDate"))}</span> ${esc(fmtDay(p.dueDate))}</div></div></div>
      <table class="inv-table"><thead><tr><th>${esc(t("col.product"))}</th><th class="num">${esc(t("col.qty"))}</th><th class="num">${esc(t("pur.line.price"))}</th><th class="num">${esc(t("col.total"))}</th></tr></thead>
      <tbody>${p.lines.map((l) => `<tr><td>${esc(l.productName)}${l.stockUnit ? `<div class="inv-sub">${esc(stockQtyText(l.baseQty, l.stockUnit))}</div>` : ""}</td><td class="num">${esc(qtyText(l.qty, l.unit))}</td><td class="num">${esc(num(l.unitPrice))} / ${esc(unitName(l.unit))}</td><td class="num">${esc(num(l.lineTotal))}</td></tr>`).join("")}</tbody></table>
      <table class="inv-totals"><tr><td>${esc(t("inv.subtotal"))}</td><td>${esc(m(p.subtotal))}</td></tr>
        ${p.discount ? `<tr><td>${esc(t("inv.discount"))}</td><td>− ${esc(m(p.discount))}</td></tr>` : ""}${p.tax ? `<tr><td>${esc(t("inv.tax"))}${p.taxMode === "included" ? " (" + esc(t("pur.tax.included").toLowerCase()) + ")" : ""}</td><td>${esc(m(p.tax))}</td></tr>` : ""}
        ${p.delivery ? `<tr><td>${esc(t("pur.f.delivery"))}</td><td>${esc(m(p.delivery))}</td></tr>` : ""}${p.otherCosts ? `<tr><td>${esc(t("pur.f.otherCosts"))}</td><td>${esc(m(p.otherCosts))}</td></tr>` : ""}
        <tr class="grand"><td>${esc(t("inv.grandTotal"))}</td><td>${esc(m(p.total))}</td></tr>
        ${p.status === "confirmed" ? `<tr><td>${esc(t("col.paid"))}</td><td>${esc(m(sum.paid))}</td></tr><tr class="due"><td>${esc(t("pur.col.outstanding"))}</td><td>${esc(m(sum.outstanding))}</td></tr>` : ""}</table>
      <div class="inv-status"><span class="${sum.paymentStatus || "unpaid"}">${esc(t("pur.status." + p.status))}${sum.paymentStatus ? " · " + esc(t("pur.pay." + sum.paymentStatus)) : ""}</span></div>
      ${sum.payments.length ? `<section class="inv-payments"><h3>${esc(t("spay.history"))}</h3>${sum.payments.map((x) => `<div class="inv-pay"><span class="when">${esc(fmtDay(x.date))}${x.reference ? " · " + esc(x.reference) : ""}</span><span>${esc(m(x.amount))}</span></div>`).join("")}</section>` : ""}
      ${p.notes ? `<p class="prewrap">${esc(p.notes)}</p>` : ""}`;
  }

  /* ==========================================================================
     PURCHASES: screens and actions
     ========================================================================== */

  function renderPurchases() {
    const root = $("purchasesRoot");
    if (!root) return;
    const f = ui.pur;
    if (f.screen === "form" && !f.form) f.screen = "list";
    if (f.screen === "detail" && !purchaseById(f.detailId)) { f.screen = "list"; f.detailId = null; }

    if (f.screen === "form") {
      const language = I18n.language();
      if (f.form.ready && f.formLang === language && $("purchaseForm")) return;   // keep what is typed
      let values = f.form.values;
      if (f.form.ready && $("pfLines")) values = readPurchaseForm();               // the language changed: keep the values
      root.innerHTML = pageHeader(t("nav.purchases")) + purchaseFormHtml(values, f.form, f.form.editing);
      f.form.ready = true;
      f.formLang = language;
      updatePurchasePreview();
      return;
    }
    if (f.screen === "detail") { root.innerHTML = pageHeader(t("nav.purchases")) + purchaseDetailHtml(purchaseById(f.detailId)); return; }
    const tab = (key, label) => `<button type="button" class="tab" role="tab" aria-selected="${f.tab === key}" data-act="pur-tab" data-tab="${key}">${esc(label)}</button>`;
    root.innerHTML = `${pageHeader(t("nav.purchases"), `<button type="button" class="btn primary" data-act="pur-new" data-id="">${esc(t("pur.new"))}</button>`)}
      <div class="tabs" role="tablist">${tab("list", t("pur.tab.list"))}${tab("reports", t("pur.tab.reports"))}</div>
      ${f.tab === "reports" ? reportsHtml() : purchaseListHtml()}`;
  }

  function setPanel(name) {
    ui.pur.open = name;
    renderPurchases();
    const first = $("purchasesRoot").querySelector ? $("purchasesRoot").querySelector(".action-panel input, .subpanel input, form[data-form] input") : null;
    if (first && first.focus) first.focus();
  }

  const formValue = (id) => $(id).value;

  const detailForms = {
    "pur-confirm"() {
      const id = ui.pur.detailId;
      const p = purchaseById(id);
      const ip = { amount: formValue("dc-pamount"), date: formValue("dc-pdate"), reference: formValue("dc-pref") };
      const receive = $("dc-receive").checked;
      const advanceApply = $("dc-advance") ? formValue("dc-advance") : undefined;
      const preview = P.previewPurchase(S(), { ...P.purchaseToInput(p), initialPayment: ip, ...(advanceApply !== undefined ? { advanceApply } : {}) }, "confirm");
      if (!preview.errors.length) {
        const warn = creditWarning(p.supplierId, p.total, preview.purchase.initialPayment ? preview.purchase.initialPayment.amount : 0);
        const supplier = supplierById(p.supplierId);
        if (!confirm(t("pur.confirmAsk", { supplier: supplier ? supplier.name : "", total: money(p.total), stock: t(receive ? "pur.confirmStockNow" : "pur.confirmStockLater") }) + (warn ? "\n\n" + warn : ""))) return;
      }
      return act((d) => P.confirmPurchase(d, id, { receive: receive ? undefined : {}, receiptDate: formValue("dc-rdate"), initialPayment: ip, advanceApply }), {
        errorId: "dc-error",
        done: (r) => { h.notify(t(r.already ? "pur.alreadyConfirmed" : "pur.confirmed", { ref: p.reference })); ui.pur.open = ""; renderPurchases(); },
      });
    },
    "pur-applyadv"() {
      const id = ui.pur.detailId;
      const amount = formValue("da-amount");
      return act((d) => P.applyAdvance(d, id, amount), { errorId: "da-error", done: () => { h.notify(t("adv.applied")); ui.pur.open = ""; renderPurchases(); } });
    },
    "pur-releaseadv"() {
      const allocId = ui.pur.open.slice("releaseAdv:".length);
      const reason = formValue("da-reason");
      return act((d) => P.reverseAllocation(d, allocId, reason), { errorId: "da-error", done: () => { h.notify(t("adv.released")); ui.pur.open = ""; renderPurchases(); } });
    },
    "pur-pay"() {
      const id = ui.pur.detailId;
      const input = { amount: formValue("dp-amount"), date: formValue("dp-date"), reference: formValue("dp-ref"), note: formValue("dp-note") };
      return act((d) => P.recordPayment(d, id, input), { errorId: "dp-error", done: () => { h.notify(t("spay.recorded")); ui.pur.open = ""; renderPurchases(); } });
    },
    "pur-editpay"() {
      const payId = ui.pur.open.slice("editPay:".length);
      const input = { amount: formValue("dp-amount"), date: formValue("dp-date"), reference: formValue("dp-ref"), note: formValue("dp-note") };
      return act((d) => P.updatePayment(d, payId, input), { errorId: "dp-error", done: () => { h.notify(t("spay.changed")); ui.pur.open = ""; renderPurchases(); } });
    },
    "pur-voidpay"() {
      const payId = ui.pur.open.slice("voidPay:".length);
      const reason = formValue("dv-reason");
      return act((d) => P.voidPayment(d, payId, reason), { errorId: "dv-error", done: () => { h.notify(t("spay.voidedDone")); ui.pur.open = ""; renderPurchases(); } });
    },
    "pur-receive"() {
      const id = ui.pur.detailId;
      const quantities = {};
      $("purchasesRoot").querySelectorAll("input[data-line]").forEach((el) => { quantities[el.dataset.line] = el.value; });
      const options = { date: formValue("dr-date"), note: formValue("dr-note") };
      return act((d) => P.receiveDelivery(d, id, quantities, options), { errorId: "dr-error", done: () => { h.notify(t("pur.received")); ui.pur.open = ""; renderPurchases(); } });
    },
    "pur-reverse"(form) {
      const id = ui.pur.detailId;
      const receiptId = form.dataset.receipt;
      const reason = formValue("dx-reason");
      return act((d) => P.reverseReceipt(d, id, receiptId, reason), { errorId: "dx-error", done: () => { h.notify(t("pur.reversed")); ui.pur.open = ""; renderPurchases(); } });
    },
    "pur-cancel"() {
      const id = ui.pur.detailId;
      const reason = formValue("dk-reason");
      if (!confirm(t("pur.cancelAsk"))) return;
      return act((d) => P.cancelPurchase(d, id, reason), { errorId: "dk-error", done: () => { h.notify(t("pur.cancelled")); ui.pur.open = ""; renderPurchases(); } });
    },
    "pur-details"() {
      const id = ui.pur.detailId;
      const patch = { supplierInvoiceNumber: formValue("de-invoiceNo"), noSupplierInvoice: $("de-noInvoice").checked, invoiceDate: formValue("de-date"), dueDate: formValue("de-due"), reference: formValue("de-ref"), notes: formValue("de-notes") };
      return act((d) => P.updatePurchaseDetails(d, id, patch), { errorId: "de-error", done: () => { h.notify(t("pur.detailsSaved")); ui.pur.open = ""; renderPurchases(); } });
    },
  };

  async function addDetailAttachments(files) {
    const id = ui.pur.detailId;
    const items = [];
    for (const file of files) {
      const r = await attachmentFromFile(file);
      if (r.error) h.notify(r.error, "error");
      else items.push(r.attachment);
    }
    if (!items.length) return;
    return act((d) => {
      const r = P.setAttachmentMeta(d, id, items.map(P.attachmentMeta));
      if (r.error) return r;
      d.attachments.put.push(...items.map((a) => ({ ...a, purchaseId: id })));
      return r;
    }, { done: () => { h.notify(t("pur.att.added")); renderPurchases(); } });
  }

  async function addFormAttachments(files) {
    const form = ui.pur.form;
    showErr("pf-att-error", "");
    const errors = [];
    for (const file of files) {
      const r = await attachmentFromFile(file);
      if (r.error) errors.push(r.error);
      else form.pending.push(r.attachment);
    }
    $("pfAttach").innerHTML = attachmentListHtml(form);
    showErr("pf-att-error", errors.join("\n"));
  }

  /* ---------- Click, input and submit handling ---------- */

  const actions = {
    // dashboard: supplier price insights
    "dash-toggle"(el) { toggleInsight(el.dataset.id); },
    "dash-all"() { ui.dash.all = !ui.dash.all; renderDashboard(); focusId("pi-all"); },
    "dash-stock"(el) { if (h.openProductInStock) h.openProductInStock(el.dataset.id); },
    "dash-purchase"(el) { openPurchase(el.dataset.id); },
    "dash-purchases"() { h.showView("purchases"); },
    // suppliers
    "sup-add"() { ui.sup.editingId = null; ui.sup.screen = "form"; ui.sup.formReady = false; renderSuppliers(); },
    "sup-edit"(el) { ui.sup.editingId = el.dataset.id; ui.sup.screen = "form"; ui.sup.formReady = false; if (S().view !== "suppliers") h.showView("suppliers"); else renderSuppliers(); },
    "sup-open"(el) { openSupplier(el.dataset.id); },
    "sup-back"() { ui.sup.screen = "list"; renderSuppliers(); },
    "sup-contact-add"() { redrawContactRows(addContactRow()); },
    "sup-contact-remove"(el) { if (removeContactRow(el.dataset.row)) redrawContactRows(); },
    "sup-cancel"() { ui.sup.formReady = false; ui.sup.screen = ui.sup.editingId && supplierById(ui.sup.editingId) ? "profile" : "list"; if (ui.sup.screen === "profile") ui.sup.profileId = ui.sup.editingId; renderSuppliers(); },
    "sup-sort"(el) {
      const key = el.dataset.key;
      if (ui.sup.sortKey === key) ui.sup.sortDir = -ui.sup.sortDir;
      else { ui.sup.sortKey = key; ui.sup.sortDir = key === "name" ? 1 : -1; }
      renderSuppliers();
    },
    "sup-tab"(el) { ui.sup.tab = el.dataset.tab; ui.sup.editDepositId = ""; ui.sup.voidDepositId = ""; renderSuppliers(); },
    "sup-deposit"(el) { openSupplier(el.dataset.id, "deposits"); },
    "sup-dep-edit"(el) { ui.sup.editDepositId = el.dataset.id; ui.sup.voidDepositId = ""; renderSuppliers(); },
    "sup-dep-void"(el) { ui.sup.voidDepositId = el.dataset.id; ui.sup.editDepositId = ""; renderSuppliers(); },
    "sup-dep-cancel"() { ui.sup.editDepositId = ""; ui.sup.voidDepositId = ""; renderSuppliers(); },
    "sup-save-anyway"() { return submitSupplier(true); },
    "sup-archive"(el) { return archiveSupplier(el.dataset.id); },
    "sup-delete"(el) { return removeSupplier(el.dataset.id); },
    "sup-csv"(el) {
      const sp = supplierById(el.dataset.id);
      if (!sp) return;
      const name = "supplier-" + (P.normText(sp.name).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "statement") + "-" + today() + ".csv";
      h.downloadText(supplierCsv(sp), name, "text/csv;charset=utf-8");
    },
    "sup-print"(el) { const sp = supplierById(el.dataset.id); if (sp) printHtml(supplierStatementHtml(sp), sp.name); },
    // purchases
    "pur-new"(el) { newPurchase(el.dataset.id || ""); },
    "pur-sort"(el) {
      const key = el.dataset.key;
      ui.pur.sortDir = ui.pur.sortKey === key ? -ui.pur.sortDir : (key === "date" || key === "total" || key === "paid" || key === "outstanding" ? -1 : 1);
      ui.pur.sortKey = key;
      renderPurchases();
    },
    "pur-open"(el) { openPurchase(el.dataset.id); },
    "pur-back"() { ui.pur.screen = "list"; ui.pur.form = null; ui.pur.open = ""; renderPurchases(); },
    "pur-tab"(el) {
      ui.pur.tab = el.dataset.tab;
      if (ui.pur.tab === "reports" && !ui.pur.report.from && !ui.pur.report.to && !ui.pur.report.touched) ui.pur.report = { from: monthStart(), to: today(), productId: "", touched: true };
      renderPurchases();
    },
    "pur-edit"() { editDraft(ui.pur.detailId); },
    "pur-panel"(el) { setPanel(el.dataset.panel); },
    "pur-close-panel"() { ui.pur.open = ""; renderPurchases(); },
    "pur-adv-max"() {
      const v = readPurchaseForm();
      const supplier = supplierById(v.supplierId);
      const read = P.previewPurchase(S(), v, "draft");
      const pool = supplier ? P.advanceTotals(supplier.id, S().supplierDeposits, S().advanceAllocations).unapplied : 0;
      const total = read.purchase ? read.purchase.total : 0;
      const paid = read.purchase && read.purchase.initialPayment ? read.purchase.initialPayment.amount : 0;
      $("pf-advance").value = Math.max(0, Math.min(pool, round(total - paid)));
      updatePurchasePreview();
    },
    "pur-adv-fill"(el) { const box = $(el.dataset.target); if (box) box.value = el.dataset.max; },
    "pur-pay-full"() {
      const p = purchaseById(ui.pur.detailId);
      if (p) $("dp-amount").value = summaryOf(p).outstanding;
    },
    "pur-delete"(el) { return removePurchase(el.dataset.id); },
    "pur-delete-draft"() {
      const p = purchaseById(ui.pur.detailId);
      if (!p || !confirm(t("pur.deleteDraftAsk", { ref: p.reference }))) return;
      return act((d) => P.deleteDraft(d, p.id), { done: () => { h.notify(t("pur.draftDeleted", { ref: p.reference })); ui.pur.screen = "list"; renderPurchases(); } });
    },
    "pur-print"() { const p = purchaseById(ui.pur.detailId); if (p) printHtml(purchasePrintHtml(p), p.reference); },
    "pur-history"(el) {
      ui.pur.screen = "list"; ui.pur.tab = "reports"; ui.pur.report = { from: "", to: "", productId: el.dataset.id, touched: true };
      if (S().view !== "purchases") h.showView("purchases"); else renderPurchases();
    },
    "pur-line-add"() {
      $("pfLines").insertAdjacentHTML("beforeend", lineHtml(blankLine()));
      updatePurchasePreview();
    },
    "pur-line-remove"(el) {
      const row = el.closest(".pl-row");
      if (row) { ProductForm.drop(newProductPrefix(row.dataset.line)); row.remove(); }
      if (![...$("pfLines").querySelectorAll(".pl-row")].length) $("pfLines").insertAdjacentHTML("beforeend", lineHtml(blankLine()));
      updatePurchasePreview();
    },
    "pur-confirm-now"() { return submitPurchase(true); },
    "pur-product-new"(el) { openProductDialog(el.dataset.line, "add", "", el.dataset.name || ""); },
    "pur-product-edit"(el) { openProductDialog(el.dataset.line, "edit", $(`pl-${el.dataset.line}-product`).value); },
    "pur-product-save"() { return saveProductDialog(false); },
    "pur-product-anyway"() { return saveProductDialog(true); },
    "pur-product-cancel"() { closeProductDialog(); },
    "pur-product-use"(el) {
      const state = ui.pur.productDialog;
      closeProductDialog();
      if (state) { chooseProduct(state.lineId, el.dataset.id); focusQuantity(state.lineId); }
    },
    "pf-att-remove"(el) {
      const form = ui.pur.form;
      const id = el.dataset.id;
      if (form.pending.some((a) => a.id === id)) form.pending = form.pending.filter((a) => a.id !== id);
      else { form.attachments = form.attachments.filter((a) => a.id !== id); form.removed.push(id); }
      $("pfAttach").innerHTML = attachmentListHtml(form);
    },
    "att-open"(el) { return openAttachment(el.dataset.id, false); },
    "att-download"(el) { return openAttachment(el.dataset.id, true); },
    "att-remove"(el) {
      const id = ui.pur.detailId;
      const attId = el.dataset.id;
      if (!confirm(t("pur.att.removeAsk"))) return;
      return act((d) => {
        const r = P.setAttachmentMeta(d, id, [], [attId]);
        if (r.error) return r;
        d.attachments.remove.push(attId);
        return r;
      }, { done: () => renderPurchases() });
    },
    "rep-preset"(el) {
      const r = ui.pur.report;
      const y = today().slice(0, 4);
      if (el.dataset.preset === "month") { r.from = monthStart(); r.to = today(); }
      else if (el.dataset.preset === "year") { r.from = y + "-01-01"; r.to = today(); }
      else { r.from = ""; r.to = ""; }
      r.touched = true;
      renderPurchases();
    },
  };

  const forms = {
    "sup-save"() { return submitSupplier(false); },
    "sup-pay"() { return submitSupplierPayment(); },
    "sup-deposit"() { return submitDeposit(); },
    "sup-dep-void"() { return submitDepositVoid(); },
    "pur-save"() { return submitPurchase(false); },
    ...detailForms,
  };

  function onClick(e) {
    // Add or remove a selling price of a new product: the product form handles it, then the conversions are redrawn.
    if (ProductForm.route(e)) { updatePurchasePreview(); return; }
    const el = e.target.closest("[data-act]");
    if (!el) {
      // Not a button: a row of a product list picks that product, a click into the search box opens its list.
      const row = e.target.closest(".combo-opt");
      if (row) { pickCombo(row.closest(".combo").dataset.combo, row.dataset.id); return; }
      const box = e.target.closest(".combo-input");
      if (box) { const lineId = box.closest(".combo").dataset.combo; if (!comboIsOpen(lineId)) showCombo(lineId); }
      return;
    }
    const handler = actions[el.dataset.act];
    if (!handler) return;
    if (el.tagName === "BUTTON") e.preventDefault();
    const result = handler(el);
    if (result && result.catch) result.catch((err) => h.notify(t("app.somethingWrong", { error: (err && err.message) || "" }), "error"));
  }

  function onSubmit(e) {
    const form = e.target.closest("form[data-form]");
    if (!form) return;
    e.preventDefault();
    const handler = forms[form.dataset.form];
    if (handler) handler(form);
  }

  // A product was chosen on a line: its own form (an older draft's "new product") appears or goes, and the unit starts on
  // the unit the product is priced in.
  function onProductPicked(lineId, value) {
    const select = $(`pl-${lineId}-product`);
    const row = select.closest(".pl-row");
    const isNew = value === NEW;
    $(`pl-${lineId}-newbox`).hidden = !isNew;
    const prefix = newProductPrefix(lineId);
    if (isNew && !ProductForm.get(prefix)) $(`pl-${lineId}-npHost`).innerHTML = newProductForm(lineId).html();
    if (!isNew && ProductForm.get(prefix)) { ProductForm.drop(prefix); $(`pl-${lineId}-npHost`).innerHTML = ""; }
    row.dataset.pid = isNew ? (row.dataset.pid || Validation.uid()) : "";
    const product = S().products.find((p) => p.id === value);
    if (product) $(`pl-${lineId}-unit`).value = Calc.isUnit(product.priceUnit) ? product.priceUnit : (Calc.isUnit(product.stockUnit) ? product.stockUnit : "piece");
  }

  function onInput(e) {
    const el = e.target;
    const id = el.id || "";
    if (el.closest && el.closest("#purProductDialog")) { ProductForm.route(e); return; }   // typing in the product dialog
    if (el.classList && el.classList.contains("combo-input")) {                              // typing in a line's product search
      const lineId = el.closest(".combo").dataset.combo;
      combo.lineId = lineId; combo.typed = true; combo.index = 0;
      showCombo(lineId);
      return;
    }
    const contactBox = el.closest && el.closest("[data-contact]");
    if (contactBox && el.dataset && el.dataset.field) {   // a name or number typed in a supplier contact row
      const row = ui.sup.contactRows.find((r) => String(r.rowId) === contactBox.dataset.contact);
      if (row) row[el.dataset.field] = el.value;
      return;
    }
    if (id === "supSearch") { ui.sup.q = el.value; refreshSupplierRows(); return; }
    if (id === "purSearch") { ui.pur.q = el.value; refreshPurchaseList(); return; }
    if (el.closest && el.closest("#purchaseForm")) {
      ProductForm.route(e);   // typing in a new product's form (its price rows, its stock unit)
      if (id === "pf-due") ui.pur.form.dueTouched = true;
      if (id === "pf-noInvoice") $("pf-invoiceNo").disabled = el.checked;
      const m = /^pl-(.+)-product$/.exec(id);
      if (m) onProductPicked(m[1], el.value);
      if (el.type !== "file") updatePurchasePreview();
    }
  }

  function onChange(e) {
    const el = e.target;
    const id = el.id || "";
    if (el.closest && el.closest("#purProductDialog")) { ProductForm.route(e); return; }
    if (el.classList && el.classList.contains("combo-input")) return;   // the product search only acts while it is typed in
    if (id === "supStatus") { ui.sup.status = el.value; refreshSupplierRows(); }
    else if (id === "sf-terms") { $("sf-termsCustom").disabled = el.value !== "custom"; if (el.value !== "custom") $("sf-termsCustom").value = ""; }
    else if (id === "purStatus") { ui.pur.status = el.value; refreshPurchaseList(); }
    else if (id === "purPay") { ui.pur.pay = el.value; refreshPurchaseList(); }
    else if (id === "purSupplier") { ui.pur.supplierId = el.value; refreshPurchaseList(); }
    else if (id === "purFrom") { ui.pur.from = el.value; refreshPurchaseList(); }
    else if (id === "purTo") { ui.pur.to = el.value; refreshPurchaseList(); }
    else if (id === "repFrom" || id === "repTo") { ui.pur.report[id === "repFrom" ? "from" : "to"] = el.value; ui.pur.report.touched = true; $("repBody").innerHTML = reportBodyHtml(); }
    else if (id === "repProduct") { ui.pur.report.productId = el.value; $("repBody").innerHTML = reportBodyHtml(); }
    else if (id === "pfFile") { addFormAttachments([...el.files]).then(() => { el.value = ""; }); }
    else if (id === "dtFile") { addDetailAttachments([...el.files]).then(() => { el.value = ""; }); }
    else if (el.closest && el.closest("#purchaseForm")) onInput(e);
  }

  // Keys: the product search (arrows, Enter, Escape, Tab), and Enter in the product dialog saves it like the Stock form.
  function onKeyDown(e) {
    const input = e.target.closest ? e.target.closest(".combo-input") : null;
    if (input) { onComboKey(e, input); return; }
    if (e.key === "Enter" && !e.isComposing && e.target.closest && e.target.closest("#purProductDialog") && e.target.tagName === "INPUT") {
      e.preventDefault();
      const result = saveProductDialog(false);
      if (result && result.catch) result.catch((err) => h.notify(t("app.somethingWrong", { error: (err && err.message) || "" }), "error"));
    }
  }

  function onFocusIn(e) {
    const input = e.target.closest ? e.target.closest(".combo-input") : null;
    if (input) onComboFocus(input);
  }

  function onFocusOut(e) {
    const input = e.target.closest ? e.target.closest(".combo-input") : null;
    if (input) leaveCombo(input.closest(".combo").dataset.combo);
  }

  // The list keeps the search box focused while it is clicked; the first click into the box selects its text.
  function onMouseDown(e) {
    if (e.target.closest && e.target.closest(".combo-list")) { e.preventDefault(); return; }
    const input = e.target.closest ? e.target.closest(".combo-input") : null;
    if (input && document.activeElement !== input) { e.preventDefault(); input.focus(); }
  }

  // Closing the product dialog with Escape: forget its form and what it was for, like Cancel does.
  function onDialogClose(e) {
    if (e.target && e.target.id === "purProductDialog" && !e.target.open) {
      ProductForm.drop(DIALOG_PREFIX);
      ui.pur.productDialog = null;
    }
  }

  /* ---------- Dashboard: Supplier Price Insights ----------
     The same product bought from different suppliers at different prices (Purchases.priceInsights does the work: this only
     draws it). Cards show the latest recorded purchase price of each supplier; a card opens to the purchase history of the
     product. Nothing here changes saved data. */

  const PI_VISIBLE = 6;        // cards shown before "Show all"
  const PI_HISTORY_ROWS = 10;  // purchase lines listed in an open card
  const PI_ROWS_IN_CARD = 4;   // suppliers listed in a card; the rest are in the history

  function focusId(id) {
    const el = $(id);
    if (el && el.focus) el.focus();
  }

  const supplierLabel = (name) => name || t("pi.unknownSupplier");
  const priceText = (price, unit) => money(price) + " / " + unitName(unit, 1);
  const signedMoney = (n) => h.ltr((n > 0 ? "+" : n < 0 ? "\u2212" : "") + num(Math.abs(n)) + " " + S().settings.currency);
  const signedPct = (pct) => (pct === null ? "" : h.ltr((pct > 0 ? "+" : pct < 0 ? "\u2212" : "") + num(Math.abs(pct)) + "%"));

  function toggleInsight(productId) {
    const open = ui.dash.open;
    const at = open.indexOf(productId);
    if (at >= 0) open.splice(at, 1); else open.push(productId);
    renderDashboard();
    focusId("pi-head-" + productId);
  }

  function insightRowHtml(e) {
    const tag = e.isLowest ? `<span class="pi-tag pi-tag-low">${esc(t("pi.lowest"))}</span>` : e.isHighest ? `<span class="pi-tag pi-tag-high">${esc(t("pi.highest"))}</span>` : "";
    const notes = [];
    if (e.bought) notes.push(t("pi.bought", { price: priceText(e.bought.unitPrice, e.bought.unit) }));
    if (e.count > 1) notes.push(t("pi.latestOf", { n: e.count }));
    return `<li class="pi-row${e.isLowest ? " is-lowest" : e.isHighest ? " is-highest" : ""}">` +
      `<div class="pi-who"><span class="pi-supplier">${esc(supplierLabel(e.supplierName))}</span><span class="pi-date muted">${esc(fmtDay(e.date))}</span></div>` +
      `<div class="pi-cost"><span class="pi-price">${esc(priceText(e.price, e.unit))}</span>${tag}</div>` +
      (notes.length ? `<div class="pi-note muted">${esc(notes.join(" · "))}</div>` : "") +
      `</li>`;
  }

  function insightDetailHtml(i) {
    const parts = [];
    if (i.changes.length) {
      parts.push(`<div class="pi-changes"><h4>${esc(t("pi.changesTitle"))}</h4><ul>` + i.changes.map((c) => `<li>${esc(t("pi.change", {
        supplier: supplierLabel(c.supplierName), from: priceText(c.from, i.unit), to: priceText(c.to, i.unit),
        change: [signedMoney(c.diff), signedPct(c.pct)].filter(Boolean).join(" · "), fromDate: fmtDay(c.fromDate), toDate: fmtDay(c.toDate),
      }))}</li>`).join("") + `</ul></div>`);
    }
    const rows = i.history.slice(0, PI_HISTORY_ROWS).map((r) => `<tr>` +
      `<td>${esc(fmtDay(r.date))}</td>` +
      `<td>${esc(supplierLabel(r.supplierName))}</td>` +
      `<td class="num">${esc(priceText(r.price, r.unit))}${r.bought ? `<div class="muted small">${esc(t("pi.bought", { price: priceText(r.bought.unitPrice, r.bought.unit) }))}</div>` : ""}</td>` +
      `<td class="num">${esc(qtyText(r.qty, r.qtyUnit))}</td>` +
      `<td class="num"><button type="button" class="btn small" data-act="dash-purchase" data-id="${esc(r.purchaseId)}" aria-label="${esc(t("pi.viewPurchaseAria", { reference: r.reference }))}">${esc(r.reference || t("common.view"))}</button></td>` +
      `</tr>`).join("");
    parts.push(`<div class="table-wrap"><table class="table pi-table"><thead><tr>` +
      `<th scope="col">${esc(t("pur.col.date"))}</th><th scope="col">${esc(t("pur.col.supplier"))}</th><th class="num" scope="col">${esc(t("col.price"))}</th>` +
      `<th class="num" scope="col">${esc(t("col.quantity"))}</th><th class="num" scope="col">${esc(t("pur.col.reference"))}</th>` +
      `</tr></thead><tbody>${rows}</tbody></table></div>`);
    if (i.history.length > PI_HISTORY_ROWS) parts.push(`<p class="muted small">${esc(t("pi.historyCapped", { n: PI_HISTORY_ROWS }))}</p>`);
    if (i.entries.some((e) => e.bought) || i.history.some((r) => r.bought)) parts.push(`<p class="muted small">${esc(t("pi.convertedNote", { unit: unitName(i.unit, 1).toLowerCase() }))}</p>`);
    return `<div class="pi-detail" id="pi-detail-${esc(i.productId)}">${parts.join("")}</div>`;
  }

  function insightCardHtml(i) {
    const open = ui.dash.open.includes(i.productId);
    const low = i.entries[0];
    const high = i.entries[i.entries.length - 1];
    const size = i.tileSize ? h.formatTileSize(i.tileSize) : "";
    const diffText = [signedMoney(i.diff) + " / " + unitName(i.unit, 1), signedPct(i.pct)].filter(Boolean).join(" · ");
    const explain = i.pct === null
      ? t("pi.explainNoPct", { high: supplierLabel(high.supplierName), low: supplierLabel(low.supplierName), amount: money(i.diff), unit: unitName(i.unit, 1).toLowerCase() })
      : t("pi.explain", { high: supplierLabel(high.supplierName), low: supplierLabel(low.supplierName), amount: money(i.diff), unit: unitName(i.unit, 1).toLowerCase(), pct: num(i.pct) });
    // With many suppliers the card lists the cheapest and the dearest; the rest are in the history.
    const shown = i.entries.length > PI_ROWS_IN_CARD ? [...i.entries.slice(0, PI_ROWS_IN_CARD - 1), high] : i.entries;
    return `<article class="pi-card pi-${i.level}${open ? " is-open" : ""}" data-product="${esc(i.productId)}">` +
      `<div class="pi-card-head">` +
        `<button type="button" class="pi-head" id="pi-head-${esc(i.productId)}" data-act="dash-toggle" data-id="${esc(i.productId)}" aria-expanded="${open}" aria-controls="pi-detail-${esc(i.productId)}" aria-label="${esc(t("pi.historyAria", { name: i.name }))}">` +
          `<span class="pi-name">${esc(i.name)}</span>${size ? `<span class="pi-size muted">${size}</span>` : ""}` +
        `</button>` +
        `<span class="pi-diff" title="${esc(t("pi.level." + i.level))}">${esc(diffText)}</span>` +
      `</div>` +
      `<ul class="pi-rows">${shown.map(insightRowHtml).join("")}</ul>` +
      (i.entries.length > shown.length ? `<p class="muted small pi-more">${esc(t("pi.moreSuppliers", { n: i.entries.length - shown.length }))}</p>` : "") +
      `<p class="pi-explain">${esc(explain)}</p>` +
      `<div class="pi-actions">` +
        `<button type="button" class="btn small" data-act="dash-toggle" data-id="${esc(i.productId)}" aria-expanded="${open}" aria-controls="pi-detail-${esc(i.productId)}">${esc(open ? t("pi.closeHistory") : t("pi.openHistory"))}</button>` +
        (i.productExists ? `<button type="button" class="btn small" data-act="dash-stock" data-id="${esc(i.productId)}" aria-label="${esc(t("pi.openStockAria", { name: i.name }))}">${esc(t("pi.openStock"))}</button>` : "") +
      `</div>` +
      (open ? insightDetailHtml(i) : "") +
      `</article>`;
  }

  function renderDashboard() {
    const root = $("dashboardRoot");
    if (!root) return;
    const result = P.priceInsights(S());
    const list = result.insights;
    const shown = ui.dash.all ? list : list.slice(0, PI_VISIBLE);
    const check = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
    const body = list.length
      ? `<div class="pi-grid">${shown.map(insightCardHtml).join("")}</div>` +
        (list.length > PI_VISIBLE ? `<div class="pi-footer"><button type="button" class="btn" id="pi-all" data-act="dash-all" aria-expanded="${ui.dash.all}">${esc(ui.dash.all ? t("pi.showLess") : t("pi.showAll", { n: list.length }))}</button></div>` : "")
      : `<div class="pi-empty"><span class="pi-empty-icon">${check}</span><p>${esc(result.samePriceProducts > 0 ? t("pi.emptySame") : t("pi.empty"))}</p>` +
        `<button type="button" class="btn small" data-act="dash-purchases">${esc(t("nav.purchases"))}</button></div>`;
    root.innerHTML =
      `<section class="panel pi-section" aria-labelledby="pi-title">` +
        `<div class="pi-section-head"><div><h2 id="pi-title">${esc(t("pi.title"))}</h2><p class="muted">${esc(t("pi.subtitle"))}</p></div>` +
        (list.length ? `<span class="pi-count">${esc(tn("pi.count", list.length))}</span>` : "") + `</div>` +
        body +
      `</section>`;
  }

  /* ---------- Hooks from the page ---------- */

  function init(hooks) {
    h = hooks;
  }

  function bind() {
    for (const rootId of ["suppliersRoot", "purchasesRoot", "dashboardRoot"]) {
      const root = $(rootId);
      root.addEventListener("click", onClick);
      root.addEventListener("submit", onSubmit);
      root.addEventListener("input", onInput);
      root.addEventListener("change", onChange);
      root.addEventListener("keydown", onKeyDown);
      root.addEventListener("focusin", onFocusIn);
      root.addEventListener("focusout", onFocusOut);
      root.addEventListener("mousedown", onMouseDown);
      root.addEventListener("close", onDialogClose, true);   // "close" does not bubble
    }
  }

  // Called by the page whenever it redraws. Only the Dashboard, Suppliers and Purchases views draw anything here.
  function render() {
    if (!h) return;
    const view = S().view;
    if (view === "dashboard") renderDashboard();
    else if (view === "suppliers") renderSuppliers();
    else if (view === "purchases") renderPurchases();
  }

  // The person pressed the menu button of the view they are already on: go back to its list (an open form is kept).
  function home(view) {
    if (view === "suppliers" && ui.sup.screen !== "form") { ui.sup.screen = "list"; renderSuppliers(); }
    else if (view === "purchases" && ui.pur.screen !== "form") { ui.pur.screen = "list"; ui.pur.open = ""; renderPurchases(); }
  }

  // Leaves any open form or detail that points at data that no longer exists (after a restore, for example).
  function reset() {
    ui.sup.screen = "list"; ui.sup.editingId = null; ui.sup.profileId = null; ui.sup.formReady = false;
    ui.pur.screen = "list"; ui.pur.detailId = null; ui.pur.form = null; ui.pur.open = "";
  }

  globalThis.PurchasesUI = {
    init, bind, render, reset, home,
    openSupplier, openPurchase, newPurchase, renderDashboard,
    // for tests
    supplierCsv, supplierRows, filteredPurchases, state: ui,
    supplierFormHtml, readSupplierForm, addContactRow, removeContactRow, contactRowsHtml, supplierTableRows, supplierProfileHtml,
    forms, actions, purchaseListHtml, purchaseSummaryStrip, supplierSummaryStrip,
  };
})();

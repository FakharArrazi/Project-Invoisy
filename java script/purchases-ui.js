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
    sup: { screen: "list", q: "", status: "active", sortKey: "name", sortDir: 1, editingId: null, profileId: null, tab: "overview", formReady: false, formLang: "" },
    pur: {
      screen: "list", tab: "list", q: "", status: "all", pay: "all", supplierId: "", sortKey: "date", sortDir: -1,
      detailId: null, open: "", form: null, formLang: "",
      report: { from: "", to: "", productId: "" },
    },
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
  const summaryOf = (purchase) => P.purchaseSummary(purchase, S().supplierPayments, today());

  function productOptions(selectedId) {
    const products = [...S().products].sort((a, b) => a.name.localeCompare(b.name));
    return option("", t("pur.chooseProduct"), !selectedId)
      + option("__new__", t("pur.newProduct"), selectedId === "__new__")
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

  function sortArrow(state, key) {
    return state.sortKey === key ? (state.sortDir > 0 ? " ▲" : " ▼") : "";
  }

  // Runs a change through commit() under guard(): one transaction, no double clicks. On an error nothing was saved.
  function act(mutate, options) {
    const opts = options || {};
    return h.guard(async () => {
      const result = await h.commit(mutate);
      if (result.error) {
        if (opts.errorId && $(opts.errorId)) showErr(opts.errorId, result.error, result.field && opts.fieldPrefix ? opts.fieldPrefix + result.field : "");
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
      .filter((sp) => !q || [sp.name, sp.contactName, sp.phone, sp.email, sp.city, sp.taxId].some((v) => P.normText(v).includes(q)))
      .map((sp) => {
        const sum = P.supplierSummary(sp, s.purchases, s.supplierPayments, day);
        return { sp, sum, name: sp.name, total: sum.total, paid: sum.paid, outstanding: sum.outstanding, last: sum.lastPurchase };
      });
    return rows.sort(compareBy(ui.sup.sortKey, ui.sup.sortDir));
  }

  function supplierSummaryStrip() {
    const o = P.overview(S(), today());
    return stat(t("sup.stat.suppliers"), `${num(o.active)}<small> / ${num(o.suppliers)}</small>`)
      + stat(t("sup.stat.purchases"), esc(money(o.total)))
      + stat(t("sup.stat.paid"), esc(money(o.paid)))
      + stat(t("sup.stat.outstanding"), esc(money(o.outstanding)), o.outstanding > 0 ? "warn" : "")
      + stat(t("sup.stat.overdue"), num(o.overdueCount), o.overdueCount > 0 ? "bad" : "");
  }

  function supplierTableRows() {
    const rows = supplierRows();
    if (!rows.length) {
      const none = S().suppliers.length === 0;
      return `<tr class="empty-row"><td colspan="9">${esc(t(none ? "sup.empty" : "sup.noMatch"))}</td></tr>`;
    }
    return rows.map(({ sp, sum }) => {
      const status = sp.archived ? badge("st-cancelled", t("sup.status.archived")) : badge("st-confirmed", t("sup.status.active"));
      const overdue = sum.overdueCount ? " " + badge("overdue", t("sup.overdueCount", { n: sum.overdueCount })) : "";
      return `<tr data-id="${esc(sp.id)}">
        <td><button type="button" class="link" data-act="sup-open" data-id="${esc(sp.id)}">${esc(sp.name)}</button>${sp.contactName ? `<div class="muted small">${esc(sp.contactName)}</div>` : ""}</td>
        <td>${esc(sp.phone)}</td>
        <td>${esc(sp.email)}</td>
        <td class="num">${esc(money(sum.total))}</td>
        <td class="num">${esc(money(sum.paid))}</td>
        <td class="num ${sum.outstanding > 0 ? "owed" : ""}">${esc(money(sum.outstanding))}</td>
        <td>${esc(fmtDay(sum.lastPurchase))}</td>
        <td>${status}${overdue}</td>
        <td class="num"><div class="row-actions">
          <button type="button" class="btn small" data-act="sup-open" data-id="${esc(sp.id)}">${esc(t("common.view"))}</button>
          <button type="button" class="btn small" data-act="sup-edit" data-id="${esc(sp.id)}">${esc(t("common.edit"))}</button>
          ${sp.archived ? "" : `<button type="button" class="btn small" data-act="pur-new" data-id="${esc(sp.id)}">${esc(t("sup.newPurchase"))}</button>`}
        </div></td></tr>`;
    }).join("");
  }

  function refreshSupplierRows() {
    if ($("supRows")) $("supRows").innerHTML = supplierTableRows();
    if ($("supStrip")) $("supStrip").innerHTML = supplierSummaryStrip();
  }

  function supplierListHtml() {
    const th = (key, label, cls) => `<th class="${cls || ""}"><button type="button" class="th-sort" data-act="sup-sort" data-key="${key}">${esc(label)}${sortArrow(ui.sup, key)}</button></th>`;
    return `<div class="stat-strip" id="supStrip">${supplierSummaryStrip()}</div>
      <div class="panel">
        <div class="panel-head wrap">
          <h2>${esc(t("sup.title"))}</h2>
          <div class="toolbar">
            <label class="sr-only" for="supSearch">${esc(t("sup.searchLabel"))}</label>
            <input type="search" id="supSearch" value="${esc(ui.sup.q)}" placeholder="${esc(t("sup.searchPlaceholder"))}" autocomplete="off">
            <label class="sr-only" for="supStatus">${esc(t("sup.statusFilter"))}</label>
            <select id="supStatus">${["active", "archived", "all"].map((v) => option(v, t("sup.filter." + v), ui.sup.status === v)).join("")}</select>
            <button type="button" class="btn primary" data-act="sup-add">${esc(t("sup.add"))}</button>
          </div>
        </div>
        <div class="table-wrap">
          <table class="table">
            <thead><tr>
              ${th("name", t("sup.col.name"))}
              <th>${esc(t("sup.col.phone"))}</th><th>${esc(t("sup.col.email"))}</th>
              ${th("total", t("sup.col.total"), "num")}${th("paid", t("sup.col.paid"), "num")}${th("outstanding", t("sup.col.outstanding"), "num")}
              ${th("last", t("sup.col.last"))}
              <th>${esc(t("col.status"))}</th><th class="num">${esc(t("col.actions"))}</th>
            </tr></thead>
            <tbody id="supRows">${supplierTableRows()}</tbody>
          </table>
        </div>
      </div>`;
  }

  /* ---------- Supplier form ---------- */

  const TERMS_CHOICES = [0, 15, 30];

  function supplierFormHtml(values) {
    const v = values || {};
    const terms = v.paymentTermsDays === undefined || v.paymentTermsDays === "" ? 0 : Number(v.paymentTermsDays);
    const custom = !TERMS_CHOICES.includes(terms);
    const text = (id, key, label, extra) => field("sf-" + id, esc(label), `<input type="text" id="sf-${id}" value="${esc(v[key] || "")}" autocomplete="off"${extra || ""}>`);
    const editing = Boolean(ui.sup.editingId);
    return `<div class="panel">
      <h2>${esc(t(editing ? "sup.editTitle" : "sup.addTitle"))}</h2>
      <form id="supplierForm" data-form="sup-save" novalidate>
        <div class="grid-2">
          ${field("sf-name", esc(t("sup.f.name")) + ' <span class="req" aria-hidden="true">*</span>', `<input type="text" id="sf-name" value="${esc(v.name || "")}" autocomplete="off" aria-required="true">`)}
          ${text("contactName", "contactName", t("sup.f.contact"))}
        </div>
        <div class="grid-2">
          ${text("phone", "phone", t("sup.f.phone"))}
          ${text("email", "email", t("sup.f.email"))}
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
      name: $("sf-name").value, contactName: $("sf-contactName").value, phone: $("sf-phone").value, email: $("sf-email").value,
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

  const PROFILE_TABS = ["overview", "purchases", "payments", "products", "documents"];

  function purchaseRowsHtml(purchases, options) {
    const opts = options || {};
    const sorted = [...purchases].sort((a, b) => b.invoiceDate.localeCompare(a.invoiceDate) || b.reference.localeCompare(a.reference));
    if (!sorted.length) return `<tr class="empty-row"><td colspan="${opts.withSupplier ? 11 : 10}">${esc(t("pur.noneFound"))}</td></tr>`;
    return sorted.map((p) => {
      const sum = summaryOf(p);
      const sp = supplierById(p.supplierId);
      const confirmed = p.status === "confirmed";
      return `<tr data-id="${esc(p.id)}">
        <td><button type="button" class="link" data-act="pur-open" data-id="${esc(p.id)}">${esc(p.reference)}</button></td>
        <td>${esc(p.noSupplierInvoice ? t("pur.noInvoiceShort") : p.supplierInvoiceNumber)}</td>
        ${opts.withSupplier ? `<td>${esc(sp ? sp.name : "")}</td>` : ""}
        <td>${esc(fmtDay(p.invoiceDate))}</td>
        <td>${esc(fmtDay(p.dueDate))}</td>
        <td class="num ${p.status === "cancelled" ? "struck" : ""}">${esc(money(p.total))}</td>
        <td class="num">${confirmed ? esc(money(sum.paid)) : ""}</td>
        <td class="num ${confirmed && sum.outstanding > 0 ? "owed" : ""}">${confirmed ? esc(money(sum.outstanding)) : ""}</td>
        <td>${statusBadge(p)}</td>
        <td>${payBadge(p, sum)} ${deliveryBadge(p, sum)}</td>
        <td class="num"><div class="row-actions"><button type="button" class="btn small" data-act="pur-open" data-id="${esc(p.id)}">${esc(p.status === "draft" ? t("common.edit") : t("common.view"))}</button></div></td>
      </tr>`;
    }).join("");
  }

  function purchaseTableHead(withSupplier) {
    return `<thead><tr><th>${esc(t("pur.col.reference"))}</th><th>${esc(t("pur.col.invoiceNo"))}</th>${withSupplier ? `<th>${esc(t("pur.col.supplier"))}</th>` : ""}
      <th>${esc(t("pur.col.date"))}</th><th>${esc(t("pur.col.due"))}</th><th class="num">${esc(t("col.total"))}</th>
      <th class="num">${esc(t("col.paid"))}</th><th class="num">${esc(t("pur.col.outstanding"))}</th>
      <th>${esc(t("col.status"))}</th><th>${esc(t("pur.col.paymentDelivery"))}</th><th class="num">${esc(t("col.actions"))}</th></tr></thead>`;
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
        ${stat(t("sup.stat.purchases"), esc(money(sum.total)))}${stat(t("sup.stat.paid"), esc(money(sum.paid)))}
        ${stat(t("sup.stat.outstanding"), esc(money(sum.outstanding)), sum.outstanding > 0 ? "warn" : "")}
        ${stat(t("sup.stat.overdueAmount"), esc(money(sum.overdueTotal)), sum.overdueTotal > 0 ? "bad" : "")}
        ${stat(t("sup.col.last"), esc(fmtDay(sum.lastPurchase) || "—"))}
      </div>
      ${sum.overLimit ? `<p class="warn-box">${esc(t("sup.overLimit", { owed: money(sum.outstanding), limit: money(sum.creditLimit) }))}</p>` : ""}
      <div class="panel">
        <h2>${esc(t("sup.details"))}</h2>
        <dl class="data-info">
          ${line(t("sup.f.contact"), sp.contactName)}${line(t("sup.f.phone"), sp.phone)}${line(t("sup.f.email"), sp.email)}
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

  function supplierProfileHtml(sp) {
    const sum = P.supplierSummary(sp, S().purchases, S().supplierPayments, today());
    const mine = S().purchases.filter((p) => p.supplierId === sp.id);
    const hasHistory = P.supplierHasHistory(S(), sp.id);
    const tabs = PROFILE_TABS.map((k) => `<button type="button" class="tab" role="tab" aria-selected="${ui.sup.tab === k}" data-act="sup-tab" data-tab="${k}">${esc(t("sup.tab." + k))}</button>`).join("");
    let body = "";
    if (ui.sup.tab === "overview") body = profileOverview(sp, sum);
    else if (ui.sup.tab === "purchases") body = `<div class="panel"><div class="table-wrap"><table class="table">${purchaseTableHead(false)}<tbody>${purchaseRowsHtml(mine)}</tbody></table></div></div>`;
    else if (ui.sup.tab === "payments") body = profilePayments(sp);
    else if (ui.sup.tab === "products") body = profileProducts(sp);
    else body = profileDocuments(sp);
    return `<div class="panel profile-head">
        <div><button type="button" class="link back" data-act="sup-back">← ${esc(t("sup.title"))}</button>
          <h2>${esc(sp.name)} ${sp.archived ? badge("st-cancelled", t("sup.status.archived")) : ""}</h2></div>
        <div class="actions wrap">
          ${sp.archived ? "" : `<button type="button" class="btn primary" data-act="pur-new" data-id="${esc(sp.id)}">${esc(t("sup.newPurchase"))}</button>`}
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
    const sum = P.supplierSummary(sp, s.purchases, s.supplierPayments, today());
    const purchases = s.purchases.filter((p) => p.supplierId === sp.id && p.status === "confirmed")
      .sort((a, b) => a.invoiceDate.localeCompare(b.invoiceDate) || a.reference.localeCompare(b.reference));
    return { sum, purchases, payments: supplierPaymentRows(sp.id).filter((r) => r.payment.status !== "voided") };
  }

  function supplierCsv(sp) {
    const { sum, purchases, payments } = supplierStatement(sp);
    const rows = [
      csvRow([t("sup.csv.supplier"), sp.name]),
      csvRow([t("sup.csv.date"), fmtDay(today())]),
      csvRow([t("sup.stat.purchases"), sum.total, t("sup.stat.paid"), sum.paid, t("sup.stat.outstanding"), sum.outstanding]),
      "",
      csvRow([t("pur.col.reference"), t("pur.col.invoiceNo"), t("pur.col.date"), t("pur.col.due"), t("col.total"), t("col.paid"), t("pur.col.outstanding"), t("col.status")]),
    ];
    for (const p of purchases) {
      const x = summaryOf(p);
      rows.push(csvRow([p.reference, p.supplierInvoiceNumber, p.invoiceDate, p.dueDate, p.total, x.paid, x.outstanding, t("pur.pay." + x.paymentStatus)]));
    }
    rows.push("", csvRow([t("spay.date"), t("pur.col.reference"), t("spay.amount"), t("spay.reference"), t("spay.note")]));
    for (const { payment, purchase } of payments) rows.push(csvRow([payment.date, purchase ? purchase.reference : "", payment.amount, payment.reference, payment.note]));
    return "﻿" + rows.join("\r\n") + "\r\n";
  }

  function businessHeader() {
    const st = S().settings;
    const line = (v) => (v ? `<div>${esc(v)}</div>` : "");
    const logo = st.logo ? `<img class="inv-logo" src="${esc(st.logo)}" alt="">` : "";
    return `<div>${logo}<div class="inv-biz-name">${esc(st.businessName)}</div>${line(st.address)}${line(st.phone)}${line(st.email)}</div>`;
  }

  function supplierStatementHtml(sp) {
    const { sum, purchases, payments } = supplierStatement(sp);
    return `<header class="inv-head">${businessHeader()}<div class="inv-title">${esc(t("sup.statement"))}</div></header>
      <div class="inv-meta"><div><div class="label">${esc(t("pur.col.supplier"))}</div><div class="inv-customer">${esc(sp.name)}${sp.phone ? "\n" + esc(sp.phone) : ""}${sp.address ? "\n" + esc(sp.address) : ""}</div></div>
      <div class="right"><div><span class="label">${esc(t("sup.csv.date"))}</span> ${esc(fmtDay(today()))}</div></div></div>
      <table class="inv-table"><thead><tr><th>${esc(t("pur.col.reference"))}</th><th>${esc(t("pur.col.invoiceNo"))}</th><th>${esc(t("pur.col.date"))}</th><th class="num">${esc(t("col.total"))}</th><th class="num">${esc(t("col.paid"))}</th><th class="num">${esc(t("pur.col.outstanding"))}</th></tr></thead>
      <tbody>${purchases.map((p) => { const x = summaryOf(p); return `<tr><td>${esc(p.reference)}</td><td>${esc(p.supplierInvoiceNumber)}</td><td>${esc(fmtDay(p.invoiceDate))}</td><td class="num">${esc(num(p.total))}</td><td class="num">${esc(num(x.paid))}</td><td class="num">${esc(num(x.outstanding))}</td></tr>`; }).join("") || `<tr><td colspan="6" class="none">${esc(t("pur.noneFound"))}</td></tr>`}</tbody></table>
      <table class="inv-totals"><tr><td>${esc(t("sup.stat.purchases"))}</td><td>${esc(money(sum.total))}</td></tr><tr><td>${esc(t("sup.stat.paid"))}</td><td>${esc(money(sum.paid))}</td></tr>
      <tr class="grand"><td>${esc(t("sup.stat.outstanding"))}</td><td>${esc(money(sum.outstanding))}</td></tr></table>
      <section class="inv-payments"><h3>${esc(t("spay.history"))}</h3>${payments.length ? payments.map(({ payment: p, purchase }) => `<div class="inv-pay"><span class="when">${esc(fmtDay(p.date))} · ${esc(purchase ? purchase.reference : "")}</span><span>${esc(money(p.amount))}</span></div>`).join("") : `<div class="inv-pay"><span class="when">${esc(t("spay.none"))}</span></div>`}</section>`;
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
        root.innerHTML = supplierFormHtml(values);
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

  /* ==========================================================================
     PURCHASES: list and reports
     ========================================================================== */

  function filteredPurchases() {
    const f = ui.pur;
    const q = P.normText(f.q);
    return S().purchases.filter((p) => {
      if (f.status !== "all" && p.status !== f.status) return false;
      if (f.supplierId && p.supplierId !== f.supplierId) return false;
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

  function purchaseListRows() {
    return purchaseRowsHtml(filteredPurchases(), { withSupplier: true });
  }

  function purchaseListHtml() {
    const f = ui.pur;
    const suppliers = [...S().suppliers].sort((a, b) => a.name.localeCompare(b.name));
    return `<div class="panel">
        <div class="panel-head wrap">
          <h2>${esc(t("pur.title"))}</h2>
          <div class="toolbar">
            <label class="sr-only" for="purSearch">${esc(t("pur.searchLabel"))}</label>
            <input type="search" id="purSearch" value="${esc(f.q)}" placeholder="${esc(t("pur.searchPlaceholder"))}" autocomplete="off">
            <label class="sr-only" for="purStatus">${esc(t("pur.statusFilter"))}</label>
            <select id="purStatus">${STATUS_FILTERS.map((v) => option(v, t(v === "all" ? "pur.filter.allStatuses" : "pur.status." + v), f.status === v)).join("")}</select>
            <label class="sr-only" for="purPay">${esc(t("pur.payFilter"))}</label>
            <select id="purPay">${PAY_FILTERS.map((v) => option(v, t(v === "all" ? "pur.filter.allPayments" : v === "overdue" ? "pur.filter.overdue" : "pur.pay." + v), f.pay === v)).join("")}</select>
            <label class="sr-only" for="purSupplier">${esc(t("pur.supplierFilter"))}</label>
            <select id="purSupplier">${option("", t("pur.filter.allSuppliers"), !f.supplierId)}${suppliers.map((s) => option(s.id, s.name, s.id === f.supplierId)).join("")}</select>
          </div>
        </div>
        <div class="table-wrap"><table class="table">${purchaseTableHead(true)}<tbody id="purRows">${purchaseListRows()}</tbody></table></div>
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
        <tbody>${period.rows.length ? purchaseRowsHtml(period.rows.map((x) => x.purchase), { withSupplier: true }) : none(11)}</tbody></table></div></div>
      <div class="panel"><h2>${esc(t("rep.balances"))}</h2>
        <p class="muted small">${esc(t("rep.balancesNote"))}</p>
        <div class="table-wrap"><table class="table">
        ${head([{ label: t("pur.col.supplier") }, { label: t("pur.col.outstanding"), num: true }, { label: t("sup.stat.overdueAmount"), num: true }])}
        <tbody>${owed.bySupplier.length ? owed.bySupplier.map((x) => `<tr><td><button type="button" class="link" data-act="sup-open" data-id="${esc(x.supplier.id)}">${esc(x.supplier.name)}</button></td>
          <td class="num owed">${esc(money(x.summary.outstanding))}</td><td class="num">${esc(money(x.summary.overdueTotal))}</td></tr>`).join("")
          + `<tr class="total-row"><td>${esc(t("col.total"))}</td><td class="num">${esc(money(owed.total))}</td><td class="num">${esc(money(owed.overdueTotal))}</td></tr>` : none(3)}</tbody></table></div></div>
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
    return { id: Validation.uid(), productId: "", newProduct: null, qty: "", unit: "box", factor: "", unitPrice: "", discount: "", notes: "" };
  }

  function blankValues(supplierId) {
    return {
      id: Validation.uid(), supplierId: supplierId || "", supplierInvoiceNumber: "", noSupplierInvoice: false,
      invoiceDate: today(), dueDate: "", reference: "", notes: "", lines: [blankLine()],
      discountType: "amount", discountValue: "", taxType: "none", taxValue: "", taxMode: "added", delivery: "", otherCosts: "",
      initialPayment: { amount: "", date: today(), reference: "" }, receiveNow: true, receiptDate: today(),
    };
  }

  function valuesFromPurchase(p) {
    const ip = p.initialPayment || {};
    return {
      id: p.id, supplierId: p.supplierId, supplierInvoiceNumber: p.supplierInvoiceNumber, noSupplierInvoice: p.noSupplierInvoice,
      invoiceDate: p.invoiceDate, dueDate: p.dueDate, reference: p.reference, notes: p.notes,
      lines: p.lines.map((l) => ({
        id: l.id, productId: l.productId, newProduct: l.newProduct ? { ...l.newProduct } : null,
        qty: l.qty ? String(l.qty) : "", unit: l.unit, factor: String(l.factor), unitPrice: String(l.unitPrice), discount: l.discount ? String(l.discount) : "", notes: l.notes,
      })),
      discountType: p.discountType, discountValue: p.discountValue ? String(p.discountValue) : "", taxType: p.taxType, taxValue: p.taxValue ? String(p.taxValue) : "",
      taxMode: p.taxMode, delivery: p.delivery ? String(p.delivery) : "", otherCosts: p.otherCosts ? String(p.otherCosts) : "",
      initialPayment: { amount: ip.amount ? String(ip.amount) : "", date: ip.date || today(), reference: ip.reference || "" },
      receiveNow: true, receiptDate: today(),
    };
  }

  function lineHtml(line) {
    const id = line.id;
    const np = line.newProduct;
    const selected = np ? NEW : line.productId;
    const v = np || {};
    const unitSel = (cur, key) => `<select id="pl-${id}-np-${key}">${key === "stockUnit" ? option("", t("stock.countedIn"), !cur) : ""}${UNIT_CHOICES.map((u) => option(u, key === "stockUnit" ? stockUnitName(u) : t("price." + u), u === cur)).join("")}</select>`;
    return `<div class="pl-row" data-line="${esc(id)}" data-pid="${esc(np ? line.productId : "")}">
      <div class="pl-main">
        <div class="field pl-product"><label for="pl-${id}-product">${esc(t("col.product"))}</label><select id="pl-${id}-product">${productOptions(selected)}</select></div>
        <div class="field"><label for="pl-${id}-qty">${esc(t("pur.line.qty"))}</label><input type="number" id="pl-${id}-qty" min="0" step="any" value="${esc(line.qty)}"></div>
        <div class="field"><label for="pl-${id}-unit">${esc(t("pur.line.unit"))}</label><select id="pl-${id}-unit">${unitOptions(line.unit)}</select></div>
        <div class="field"><label for="pl-${id}-factor">${esc(t("pur.line.factor"))}</label><input type="number" id="pl-${id}-factor" min="0" step="any" value="${esc(line.factor)}"></div>
        <div class="field"><label for="pl-${id}-price">${esc(t("pur.line.price"))}</label><input type="number" id="pl-${id}-price" min="0" step="any" value="${esc(line.unitPrice)}"></div>
        <div class="field"><label for="pl-${id}-disc">${esc(t("pur.line.discount"))}</label><input type="number" id="pl-${id}-disc" min="0" step="any" value="${esc(line.discount)}"></div>
        <div class="field pl-total"><span class="label">${esc(t("pur.line.subtotal"))}</span><strong id="pl-${id}-total">0</strong></div>
        <button type="button" class="btn small danger pl-remove" data-act="pur-line-remove" data-line="${esc(id)}" aria-label="${esc(t("common.remove"))}">✕</button>
      </div>
      <div class="pl-sub"><span class="muted small" id="pl-${id}-hint"></span> <span class="conv" id="pl-${id}-conv"></span></div>
      <div class="pl-new" id="pl-${id}-newbox"${np ? "" : " hidden"}>
        <h4>${esc(t("pur.newProductTitle"))}</h4>
        <div class="grid-3">
          ${field(`pl-${id}-np-name`, esc(t("stock.productName")) + " *", `<input type="text" id="pl-${id}-np-name" value="${esc(v.name || "")}" autocomplete="off">`)}
          ${field(`pl-${id}-np-tile`, esc(t("stock.tileSize")), `<input type="text" id="pl-${id}-np-tile" value="${esc(v.tileSize || "")}" placeholder="60*120" autocomplete="off">`)}
          ${field(`pl-${id}-np-cover`, esc(t("stock.coverage")), `<input type="number" id="pl-${id}-np-cover" min="0" step="any" value="${v.coveragePerBox ? esc(v.coveragePerBox) : ""}">`)}
          ${field(`pl-${id}-np-sell`, esc(t("pur.newSelling")), `<input type="number" id="pl-${id}-np-sell" min="0" step="any" value="${v.sellingPrice !== undefined && v.sellingPrice !== "" ? esc(v.sellingPrice) : ""}">`)}
          ${field(`pl-${id}-np-priceUnit`, esc(t("pur.newSellingUnit")), unitSel(v.priceUnit || "box", "priceUnit"))}
          ${field(`pl-${id}-np-stockUnit`, esc(t("stock.stockUnit")) + " *", unitSel(v.stockUnit === undefined ? "box" : v.stockUnit, "stockUnit"))}
          ${field(`pl-${id}-np-sku`, esc(t("stock.sku")), `<input type="text" id="pl-${id}-np-sku" value="${esc(v.sku || "")}" autocomplete="off">`)}
          ${field(`pl-${id}-np-cat`, esc(t("stock.category")), `<input type="text" id="pl-${id}-np-cat" value="${esc(v.category || "")}" autocomplete="off">`)}
        </div>
        <p class="muted small">${esc(t("pur.newProductNote"))}</p>
      </div>
      <div class="field pl-notes"><label for="pl-${id}-notes">${esc(t("pur.line.notes"))}</label><input type="text" id="pl-${id}-notes" value="${esc(line.notes || "")}" autocomplete="off"></div>
      <p class="error" id="pl-${id}-error" role="alert"></p>
    </div>`;
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
        <button type="button" class="link back" data-act="pur-back">← ${esc(t("pur.title"))}</button>
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
    </form>`;
  }

  // What is typed in the form right now, in the shape purchases.js reads.
  function readPurchaseForm() {
    const form = ui.pur.form;
    const lines = [...$("pfLines").querySelectorAll(".pl-row")].map((row) => {
      const id = row.dataset.line;
      const g = (key) => $(`pl-${id}-${key}`).value;
      const sel = g("product");
      const line = { id, productId: sel === NEW ? row.dataset.pid : sel, newProduct: null, qty: g("qty"), unit: g("unit"), factor: g("factor"), unitPrice: g("price"), discount: g("disc"), notes: g("notes") };
      if (sel === NEW) {
        line.newProduct = {
          name: g("np-name"), tileSize: g("np-tile"), coveragePerBox: g("np-cover"), sellingPrice: g("np-sell"),
          priceUnit: g("np-priceUnit"), stockUnit: g("np-stockUnit"), sku: g("np-sku"), category: g("np-cat"), description: "",
        };
      }
      return line;
    });
    return {
      id: form.id, supplierId: $("pf-supplier").value, supplierInvoiceNumber: $("pf-invoiceNo").value, noSupplierInvoice: $("pf-noInvoice").checked,
      invoiceDate: $("pf-date").value, dueDate: $("pf-due").value, reference: $("pf-reference").value, notes: $("pf-notes").value, lines,
      discountType: $("pf-discountType").value, discountValue: $("pf-discount").value, taxType: $("pf-taxType").value, taxValue: $("pf-tax").value,
      taxMode: $("pf-taxMode").value, delivery: $("pf-delivery").value, otherCosts: $("pf-other").value,
      initialPayment: { amount: $("pf-payAmount").value, date: $("pf-payDate").value, reference: $("pf-payRef").value },
      receiveNow: $("pf-receive").checked, receiptDate: $("pf-receiptDate").value,
    };
  }

  // The product (or the new product being typed) a line is about: only what the unit conversion needs.
  function lineSpec(line) {
    if (line.newProduct) {
      const cover = Number(line.newProduct.coveragePerBox);
      return { coveragePerBox: cover > 0 ? cover : null, priceUnit: line.newProduct.priceUnit, tileSize: line.newProduct.tileSize, stockUnit: Calc.isUnit(line.newProduct.stockUnit) ? line.newProduct.stockUnit : null, name: line.newProduct.name };
    }
    const p = S().products.find((x) => x.id === line.productId);
    return p ? { ...p, stockUnit: Calc.isUnit(p.stockUnit) ? p.stockUnit : null } : null;
  }

  // Redraws what is worked out from the form: each line's amount and stock conversion, the totals, the due date.
  function updatePurchasePreview() {
    if (!ui.pur.form || !$("pfLines")) return;
    const v = readPurchaseForm();
    const supplier = supplierById(v.supplierId);
    const calcLines = [];
    for (const line of v.lines) {
      const spec = lineSpec(line);
      const stockUnit = spec ? spec.stockUnit : null;
      const unit = line.unit;
      const factorBox = $(`pl-${line.id}-factor`);
      let factor = null;
      let placeholder = "";
      if (spec) {
        if (stockUnit && unit === stockUnit) { factor = 1; placeholder = "1"; }
        else {
          const auto = P.autoFactor(spec, unit, stockUnit);
          if (!auto.error) { factor = auto.value; placeholder = String(auto.value); } else placeholder = t("pur.line.factorNeeded");
        }
        const typed = P.readNumber(line.factor);
        if (stockUnit && unit === stockUnit) factor = 1;
        else if (typed.value > 0) factor = typed.value;
      }
      factorBox.placeholder = placeholder;
      factorBox.disabled = Boolean(stockUnit && unit === stockUnit);
      if (factorBox.disabled) factorBox.value = "1";
      const qty = loose(line.qty);
      const priced = { qty, unitPrice: loose(line.unitPrice), discount: loose(line.discount), factor: factor || 1 };
      calcLines.push(priced);
      $(`pl-${line.id}-total`).textContent = num(P.lineTotalOf(priced));
      const conv = $(`pl-${line.id}-conv`);
      conv.textContent = factor && qty > 0 && stockUnit ? `${qtyText(qty, unit)} × ${num(factor)} = ${stockQtyText(P.lineBaseQty(priced), stockUnit)}` : "";
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
    }
    const totals = P.computeTotals({
      lines: calcLines, discountType: v.discountType, discountValue: loose(v.discountValue), taxType: v.taxType, taxValue: loose(v.taxValue),
      taxMode: v.taxMode, delivery: loose(v.delivery), otherCosts: loose(v.otherCosts),
    });
    const paidNow = Math.min(loose(v.initialPayment.amount), totals.total);
    const row = (label, value, cls) => `<div${cls ? ` class="${cls}"` : ""}><span>${esc(label)}</span><span>${esc(value)}</span></div>`;
    $("pfTotals").innerHTML = row(t("inv.subtotal"), money(totals.subtotal))
      + (totals.discount ? row(t("inv.discount"), "− " + money(totals.discount)) : "")
      + (v.taxType !== "none" ? row(t("inv.tax") + (v.taxMode === "included" ? " (" + t("pur.tax.included").toLowerCase() + ")" : ""), money(totals.tax)) : "")
      + (totals.delivery ? row(t("pur.f.delivery"), money(totals.delivery)) : "")
      + (totals.otherCosts ? row(t("pur.f.otherCosts"), money(totals.otherCosts)) : "")
      + row(t("inv.grandTotal"), money(totals.total), "grand")
      + (paidNow > 0 ? row(t("pur.paidNow"), money(paidNow)) + row(t("pur.owedAfter"), money(totals.total - paidNow), "due") : "");
    $("pf-supplierInfo").textContent = supplier ? supplierInfoText(supplier) : "";
    // The due date follows the supplier's payment terms until it is typed by hand.
    if (!ui.pur.form.dueTouched && supplier && P.isDay(v.invoiceDate)) $("pf-due").value = P.addDays(v.invoiceDate, supplier.paymentTermsDays || 0);
  }

  function supplierInfoText(supplier) {
    const sum = P.supplierSummary(supplier, S().purchases, S().supplierPayments, today());
    const terms = supplier.paymentTermsDays === 0 ? t("sup.terms.immediate") : tn("sup.terms.days", supplier.paymentTermsDays);
    return t("pur.supplierInfo", { terms, owed: money(sum.outstanding) }) + (supplier.creditLimit != null ? " · " + t("pur.supplierLimit", { limit: money(supplier.creditLimit) }) : "");
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
    const sum = P.supplierSummary(supplier, S().purchases, S().supplierPayments, today());
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
      }
    }
  }

  // Maps an error field of purchases.js to the box that shows it.
  function formFieldId(field) {
    const map = {
      supplierId: "pf-supplier", supplierInvoiceNumber: "pf-invoiceNo", invoiceDate: "pf-date", dueDate: "pf-due", reference: "pf-reference", notes: "pf-notes",
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
    const label = t("pur.log." + entry.event);
    return entry.note ? `${label}: ${entry.note}` : label;
  }

  function linesTableHtml(p, sum) {
    const confirmed = p.status === "confirmed";
    const rows = p.lines.map((l) => {
      const d = sum.delivery.lines.find((x) => x.lineId === l.id);
      return `<tr>
        <td>${esc(l.productName)}${l.tileSize ? ` <span class="muted small">${esc(h.formatTileSize(l.tileSize))}</span>` : ""}${l.newProduct ? " " + badge("info", t("pur.newProductTag")) : ""}${l.notes ? `<div class="muted small">${esc(l.notes)}</div>` : ""}</td>
        <td class="num">${esc(qtyText(l.qty, l.unit))}</td>
        <td class="num">${l.stockUnit ? esc(stockQtyText(l.baseQty, l.stockUnit)) : ""}${l.stockUnit && l.unit !== l.stockUnit ? `<div class="muted small">× ${esc(num(l.factor))}</div>` : ""}</td>
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
    return `<div class="panel"><div class="panel-head"><h2>${esc(t("pur.payments"))}</h2>
        ${p.status === "confirmed" && sum.outstanding > 0 && open !== "pay" ? `<button type="button" class="btn primary" data-act="pur-panel" data-panel="pay">${esc(t("spay.recordBtn"))}</button>` : ""}</div>
      <div class="stat-strip small">${stat(t("col.total"), esc(money(p.total)))}${stat(t("col.paid"), esc(money(sum.paid)))}${stat(t("pur.col.outstanding"), esc(money(sum.outstanding)), sum.outstanding > 0 ? "warn" : "")}
        ${stat(t("col.status"), sum.paymentStatus ? esc(t("pur.pay." + sum.paymentStatus)) : "—")}${stat(t("pur.col.due"), esc(fmtDay(p.dueDate) || "—") + (sum.overdue ? " " + badge("overdue", tn("pur.overdueDays", sum.daysOverdue)) : ""))}</div>
      ${payForm}
      <div class="table-wrap"><table class="table"><thead><tr><th>${esc(t("spay.date"))}</th><th class="num">${esc(t("spay.amount"))}</th><th>${esc(t("spay.reference"))}</th><th></th><th></th></tr></thead>
      <tbody>${rows || `<tr class="empty-row"><td colspan="5">${esc(t("spay.none"))}</td></tr>`}</tbody></table></div></div>`;
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
      return `${esc(line ? line.productName : "")}: ${esc(qtyText(x.qty, line ? line.unit : ""))}${line && line.stockUnit ? ` → ${esc(stockQtyText(x.baseQty, line.stockUnit))}` : ""}`;
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
        <p class="error" id="dc-error" role="alert"></p>
        <div class="actions left"><button type="submit" class="btn primary">${esc(t("pur.confirm"))}</button>${close}</div></form>`);
    }
    if (open === "cancel" && p.status !== "cancelled") {
      const blocked = sum.payments.length > 0;
      const applied = (p.receipts || []).some((r) => r.status === "applied");
      return wrap(t("pur.cancelTitle"), `<form data-form="pur-cancel" novalidate>
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
    actions.push(btn("pur-print", t("sup.print")));
    const info = (label, value) => (value ? `<dt>${esc(label)}</dt><dd>${value}</dd>` : "");
    return `<div class="panel profile-head">
        <div><button type="button" class="link back" data-act="pur-back">← ${esc(t("pur.title"))}</button>
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
      <div class="inv-meta"><div><div class="label">${esc(t("pur.col.supplier"))}</div><div class="inv-customer">${esc(sp ? sp.name : "")}${sp && sp.phone ? "\n" + esc(sp.phone) : ""}${sp && sp.address ? "\n" + esc(sp.address) : ""}</div></div>
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
      root.innerHTML = purchaseFormHtml(values, f.form, f.form.editing);
      f.form.ready = true;
      f.formLang = language;
      updatePurchasePreview();
      return;
    }
    if (f.screen === "detail") { root.innerHTML = purchaseDetailHtml(purchaseById(f.detailId)); return; }
    const tab = (key, label) => `<button type="button" class="tab" role="tab" aria-selected="${f.tab === key}" data-act="pur-tab" data-tab="${key}">${esc(label)}</button>`;
    root.innerHTML = `<div class="tabs-row"><div class="tabs" role="tablist">${tab("list", t("pur.tab.list"))}${tab("reports", t("pur.tab.reports"))}</div>
      <button type="button" class="btn primary" data-act="pur-new" data-id="">${esc(t("pur.new"))}</button></div>
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
      const preview = P.previewPurchase(S(), { ...P.purchaseToInput(p), initialPayment: ip }, "confirm");
      if (!preview.errors.length) {
        const warn = creditWarning(p.supplierId, p.total, preview.purchase.initialPayment ? preview.purchase.initialPayment.amount : 0);
        const supplier = supplierById(p.supplierId);
        if (!confirm(t("pur.confirmAsk", { supplier: supplier ? supplier.name : "", total: money(p.total), stock: t(receive ? "pur.confirmStockNow" : "pur.confirmStockLater") }) + (warn ? "\n\n" + warn : ""))) return;
      }
      return act((d) => P.confirmPurchase(d, id, { receive: receive ? undefined : {}, receiptDate: formValue("dc-rdate"), initialPayment: ip }), {
        errorId: "dc-error",
        done: (r) => { h.notify(t(r.already ? "pur.alreadyConfirmed" : "pur.confirmed", { ref: p.reference })); ui.pur.open = ""; renderPurchases(); },
      });
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
    // suppliers
    "sup-add"() { ui.sup.editingId = null; ui.sup.screen = "form"; ui.sup.formReady = false; renderSuppliers(); },
    "sup-edit"(el) { ui.sup.editingId = el.dataset.id; ui.sup.screen = "form"; ui.sup.formReady = false; if (S().view !== "suppliers") h.showView("suppliers"); else renderSuppliers(); },
    "sup-open"(el) { openSupplier(el.dataset.id); },
    "sup-back"() { ui.sup.screen = "list"; renderSuppliers(); },
    "sup-cancel"() { ui.sup.formReady = false; ui.sup.screen = ui.sup.editingId && supplierById(ui.sup.editingId) ? "profile" : "list"; if (ui.sup.screen === "profile") ui.sup.profileId = ui.sup.editingId; renderSuppliers(); },
    "sup-sort"(el) {
      const key = el.dataset.key;
      if (ui.sup.sortKey === key) ui.sup.sortDir = -ui.sup.sortDir;
      else { ui.sup.sortKey = key; ui.sup.sortDir = key === "name" ? 1 : -1; }
      renderSuppliers();
    },
    "sup-tab"(el) { ui.sup.tab = el.dataset.tab; renderSuppliers(); },
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
    "pur-pay-full"() {
      const p = purchaseById(ui.pur.detailId);
      if (p) $("dp-amount").value = summaryOf(p).outstanding;
    },
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
      if (row) row.remove();
      if (![...$("pfLines").querySelectorAll(".pl-row")].length) $("pfLines").insertAdjacentHTML("beforeend", lineHtml(blankLine()));
      updatePurchasePreview();
    },
    "pur-confirm-now"() { return submitPurchase(true); },
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
    "pur-save"() { return submitPurchase(false); },
    ...detailForms,
  };

  function onClick(e) {
    const el = e.target.closest("[data-act]");
    if (!el) return;
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

  function onInput(e) {
    const el = e.target;
    const id = el.id || "";
    if (id === "supSearch") { ui.sup.q = el.value; refreshSupplierRows(); return; }
    if (id === "purSearch") { ui.pur.q = el.value; $("purRows").innerHTML = purchaseListRows(); return; }
    if (el.closest && el.closest("#purchaseForm")) {
      if (id === "pf-due") ui.pur.form.dueTouched = true;
      if (id === "pf-noInvoice") $("pf-invoiceNo").disabled = el.checked;
      const m = /^pl-(.+)-product$/.exec(id);
      if (m) {
        const row = el.closest(".pl-row");
        const isNew = el.value === NEW;
        $(`pl-${m[1]}-newbox`).hidden = !isNew;
        row.dataset.pid = isNew ? (row.dataset.pid || Validation.uid()) : "";
        const product = S().products.find((p) => p.id === el.value);
        if (product) {
          $(`pl-${m[1]}-unit`).value = Calc.isUnit(product.priceUnit) ? product.priceUnit : (Calc.isUnit(product.stockUnit) ? product.stockUnit : "piece");
          $(`pl-${m[1]}-factor`).value = "";
        }
      }
      if (/^pl-.+-unit$/.test(id)) $(id.replace(/unit$/, "factor")).value = "";
      if (el.type !== "file") updatePurchasePreview();
    }
  }

  function onChange(e) {
    const el = e.target;
    const id = el.id || "";
    if (id === "supStatus") { ui.sup.status = el.value; refreshSupplierRows(); }
    else if (id === "sf-terms") { $("sf-termsCustom").disabled = el.value !== "custom"; if (el.value !== "custom") $("sf-termsCustom").value = ""; }
    else if (id === "purStatus") { ui.pur.status = el.value; $("purRows").innerHTML = purchaseListRows(); }
    else if (id === "purPay") { ui.pur.pay = el.value; $("purRows").innerHTML = purchaseListRows(); }
    else if (id === "purSupplier") { ui.pur.supplierId = el.value; $("purRows").innerHTML = purchaseListRows(); }
    else if (id === "repFrom" || id === "repTo") { ui.pur.report[id === "repFrom" ? "from" : "to"] = el.value; ui.pur.report.touched = true; $("repBody").innerHTML = reportBodyHtml(); }
    else if (id === "repProduct") { ui.pur.report.productId = el.value; $("repBody").innerHTML = reportBodyHtml(); }
    else if (id === "pfFile") { addFormAttachments([...el.files]).then(() => { el.value = ""; }); }
    else if (id === "dtFile") { addDetailAttachments([...el.files]).then(() => { el.value = ""; }); }
    else if (el.closest && el.closest("#purchaseForm")) onInput(e);
  }

  /* ---------- Hooks from the page ---------- */

  function init(hooks) {
    h = hooks;
  }

  function bind() {
    for (const rootId of ["suppliersRoot", "purchasesRoot"]) {
      const root = $(rootId);
      root.addEventListener("click", onClick);
      root.addEventListener("submit", onSubmit);
      root.addEventListener("input", onInput);
      root.addEventListener("change", onChange);
    }
  }

  // Called by the page whenever it redraws. Only the Suppliers and Purchases views draw anything here.
  function render() {
    if (!h) return;
    const view = S().view;
    if (view === "suppliers") renderSuppliers();
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
    openSupplier, openPurchase, newPurchase,
    // for tests
    supplierCsv, supplierRows, filteredPurchases, state: ui,
  };
})();

"use strict";

/* ==========================================================================
   Workers screens: the list, the add / edit form, a worker's page (information, financial overview, transactions,
   salary periods) and one salary period.

   Plain script, loaded before script.js, in the same way as purchases-ui.js. The page code hands over what these
   screens need through WorkersUI.init(): the data (state), commit() (every change is one transaction), guard() (no
   double clicks) and a few formatting helpers. All payroll rules live in workers.js; this file only reads forms, calls
   those rules and draws the result. Amounts are typed in dinars and shown the way the rest of Invoisy shows money
   (dinars or centimes, see Settings -> Currency display).
   ========================================================================== */

(function () {
  const W = globalThis.Workers;
  let h = null;                                   // the hooks handed over by script.js

  const t = (key, params) => h.t(key, params);
  const tn = (key, count, params) => h.tn(key, count, params);
  const esc = (v) => h.esc(v);
  const $ = (id) => h.$(id);
  const S = () => h.state;
  const money = (n) => h.invoiceMoney(n);
  const nowDate = () => (h.now ? h.now() : new Date());
  const today = () => globalThis.Purchases.toDay(nowDate());
  const ctx = () => ({ now: nowDate(), today: today(), format: (n) => money(n) });

  const TYPE_FILTERS = ["all", ...W.TYPES];
  const STATUS_FILTERS = ["all", "active", "inactive"];
  const SORTS = ["name-asc", "name-desc", "start-asc", "start-desc", "salary-asc", "salary-desc", "payday-asc", "payday-desc"];

  const ui = {
    screen: "list",          // list | form | detail | period
    q: "", status: "all", sort: "name-asc",
    editingId: null,         // the worker in the form (null = a new one)
    detailId: null,
    tab: "transactions",     // transactions | periods
    periodIndex: null,
    panel: "",               // "", advance, pay, adjust, recover, edit-tx
    editTxId: "",
    confirm: null,           // { kind: "delete-tx" | "status", id, status } - an inline question waiting for an answer
    nonce: "",               // one id per open form: pressing the button twice can not record twice
    tq: "", ttype: "all", tfrom: "", tto: "",
    formLang: "",
  };

  /* ---------- Small helpers ---------- */

  function fmtDay(day) {
    if (!globalThis.Purchases.isDay(day)) return "";
    const [y, m, d] = day.split("-");
    return h.ltr(d + "/" + m + "/" + y);
  }

  const period = (p) => h.ltr(fmtDay(p.start) + " – " + fmtDay(p.end));
  const option = (value, label, selected) => `<option value="${esc(value)}"${selected ? " selected" : ""}>${esc(label)}</option>`;
  const badge = (cls, label) => `<span class="badge ${cls}">${esc(label)}</span>`;
  const stat = (label, value, extra) => `<div class="stat${extra ? " " + extra : ""}"><span class="stat-label">${esc(label)}</span><strong>${value}</strong></div>`;
  const field = (id, label, control, extra) => `<div class="field${extra ? " " + extra : ""}"><label for="${id}">${label}</label>${control}</div>`;
  const SEARCH_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>';
  const norm = (s) => globalThis.Purchases.normText(s);

  function pageHeader(title, actions) {
    return `<header class="stock-header"><h1 class="stock-title">${esc(title)}</h1>${actions ? `<div class="page-actions">${actions}</div>` : ""}</header>`;
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

  // One change to the data, saved as one transaction (like every other screen). Errors are shown where the person is looking.
  function act(mutate, options) {
    const opts = options || {};
    return h.guard(async () => {
      const result = await h.commit(mutate);
      if (result.error) {
        const fieldId = result.field && opts.fieldMap ? opts.fieldMap[result.field] || "" : "";
        if (opts.errorId && $(opts.errorId)) showErr(opts.errorId, result.error, fieldId);
        else h.notify(result.error, "error");
        return;
      }
      if (opts.done) await opts.done(result);
    });
  }

  const workerById = (id) => S().workers.find((w) => w.id === id) || null;
  const calcOf = (worker) => W.compute(worker, S().workerTransactions, today());
  const typeName = (type) => t("w.type." + type);
  const typeBadge = (x) => badge("w-" + x.type, typeName(x.type));
  const periodStatus = (status) => badge("wp-" + status, t("w.pstatus." + status));
  const empBadge = (status) => badge(status === "active" ? "st-confirmed" : "st-cancelled", t("w.status." + status));

  // The day number of the payday, as a sentence: "Every month on the 5th".
  function paydayText(worker) {
    const day = Number(worker.startDate.slice(8, 10));
    return t("w.paydayRule", { day }) + (day > 28 ? " " + t("w.paydayShort") : "");
  }

  /* ==========================================================================
     LIST
     ========================================================================== */

  function listRows() {
    const q = norm(ui.q);
    const digits = String(ui.q).replace(/\D/g, "");
    const o = W.overview(S().workers, S().workerTransactions, today());
    let rows = o.rows.filter(({ worker }) => {
      if (ui.status !== "all" && worker.status !== ui.status) return false;
      if (!q) return true;
      return norm(worker.name).includes(q) || (digits.length >= 2 && String(worker.phone).replace(/\D/g, "").includes(digits)) || norm(worker.phone).includes(q);
    });
    const [key, dir] = ui.sort.split("-");
    const sign = dir === "desc" ? -1 : 1;
    const value = {
      name: ({ worker }) => norm(worker.name),
      start: ({ worker }) => worker.startDate,
      salary: ({ calc }) => calc.current.salary,
      payday: ({ calc }) => calc.nextPayday,
    }[key];
    rows = rows.slice().sort((a, b) => {
      const x = value(a), y = value(b);
      const r = typeof x === "string" ? x.localeCompare(y) : x - y;
      return (r || norm(a.worker.name).localeCompare(norm(b.worker.name))) * sign;
    });
    return { rows, overview: o };
  }

  function stripHtml() {
    const o = W.overview(S().workers, S().workerTransactions, today());
    return stat(t("w.stat.active"), esc(String(o.activeCount)))
      + stat(t("w.stat.salaries"), esc(money(o.monthlySalaries)))
      + stat(t("w.stat.advances"), esc(money(o.advancesThisMonth)))
      + stat(t("w.stat.debts"), esc(money(o.debts)), o.debts > 0 ? "warn" : "");
  }

  function rowsHtml() {
    const { rows } = listRows();
    if (!rows.length) {
      const none = S().workers.length === 0;
      return `<tr class="empty-row"><td colspan="9">${esc(t(none ? "w.empty" : "w.noMatch"))}</td></tr>`;
    }
    return rows.map(({ worker, calc }) => `<tr data-id="${esc(worker.id)}">
        <td class="name-cell"><button type="button" class="link" data-act="w-open" data-id="${esc(worker.id)}">${esc(worker.name)}</button></td>
        <td class="phone-cell">${worker.phone ? esc(h.ltr(worker.phone)) : '<span class="muted">—</span>'}</td>
        <td>${worker.position ? esc(worker.position) : '<span class="muted">—</span>'}</td>
        <td>${esc(fmtDay(worker.startDate))}</td>
        <td class="num">${esc(money(calc.current.salary))}</td>
        <td>${esc(fmtDay(calc.nextPayday))}</td>
        <td class="num">${esc(money(calc.current.remaining))}</td>
        <td class="num${calc.debt > 0 ? " owed" : ""}">${calc.debt > 0 ? esc(money(calc.debt)) : '<span class="muted">—</span>'}</td>
        <td>${empBadge(worker.status)}</td>
      </tr>`).join("");
  }

  function listHtml() {
    const th = (key, label, cls) => {
      const active = ui.sort.startsWith(key + "-");
      const arrow = active ? (ui.sort.endsWith("asc") ? " ▲" : " ▼") : "";
      return `<th class="${cls || ""}"${active ? ` aria-sort="${ui.sort.endsWith("asc") ? "ascending" : "descending"}"` : ""}><button type="button" class="th-sort" data-act="w-sort" data-key="${key}">${esc(label)}${arrow}</button></th>`;
    };
    return `${pageHeader(t("nav.workers"), `<button type="button" class="btn primary" data-act="w-add">${esc(t("w.add"))}</button>`)}
      <div class="stat-strip" id="wStrip">${stripHtml()}</div>
      <div class="panel stock-list">
        <div class="stock-toolbar">
          <div class="stock-search">
            ${SEARCH_ICON}
            <label class="sr-only" for="wSearch">${esc(t("w.searchLabel"))}</label>
            <input type="search" id="wSearch" value="${esc(ui.q)}" placeholder="${esc(t("w.searchPlaceholder"))}" autocomplete="off">
          </div>
          <div class="list-filters">
            <label class="sr-only" for="wStatus">${esc(t("w.statusFilter"))}</label>
            <select id="wStatus">${STATUS_FILTERS.map((v) => option(v, t("w.filter." + v), ui.status === v)).join("")}</select>
            <label class="sr-only" for="wSort">${esc(t("w.sortLabel"))}</label>
            <select id="wSort">${SORTS.map((v) => option(v, t("w.sort." + v), ui.sort === v)).join("")}</select>
          </div>
        </div>
        <div class="table-wrap stock-table-wrap">
          <table class="table stock-table workers-table">
            <thead><tr>
              ${th("name", t("w.col.name"))}
              <th>${esc(t("w.col.phone"))}</th>
              <th>${esc(t("w.col.position"))}</th>
              ${th("start", t("w.col.start"))}
              ${th("salary", t("w.col.salary"), "num")}
              ${th("payday", t("w.col.payday"))}
              <th class="num">${esc(t("w.col.remaining"))}</th>
              <th class="num">${esc(t("w.col.debt"))}</th>
              <th>${esc(t("w.col.status"))}</th>
            </tr></thead>
            <tbody id="wRows">${rowsHtml()}</tbody>
          </table>
        </div>
      </div>`;
  }

  /* ==========================================================================
     ADD / EDIT WORKER
     ========================================================================== */

  function formHtml(values) {
    const v = values || {};
    const editing = Boolean(ui.editingId);
    const locked = editing && S().workerTransactions.some((x) => x.workerId === ui.editingId);
    const text = (id, key, label, extra) => field("wf-" + id, esc(label), `<input type="text" id="wf-${id}" value="${esc(v[key] || "")}" autocomplete="off"${extra || ""}>`);
    return `<div class="panel">
      <h2>${esc(t(editing ? "w.editTitle" : "w.addTitle"))}</h2>
      <form id="wForm" data-form="w-save" novalidate>
        <div class="grid-2">
          ${field("wf-name", esc(t("w.f.name")) + ' <span class="req" aria-hidden="true">*</span>', `<input type="text" id="wf-name" value="${esc(v.name || "")}" autocomplete="off" aria-required="true">`)}
          ${text("phone", "phone", t("w.f.phone"), ' inputmode="tel"')}
        </div>
        <div class="grid-2">
          ${text("position", "position", t("w.f.position"))}
          ${field("wf-start", esc(t("w.f.start")) + ' <span class="req" aria-hidden="true">*</span>', `<input type="date" id="wf-start" value="${esc(v.startDate || "")}" aria-required="true"${locked ? " disabled" : ""}>`)}
        </div>
        ${locked ? `<p class="muted small">${esc(t("w.f.startLocked"))}</p>` : `<p class="muted small">${esc(t("w.f.startHelp"))}</p>`}
        <div class="grid-2">
          ${field("wf-salary", esc(t("w.f.salary", { currency: S().settings.currency })) + ' <span class="req" aria-hidden="true">*</span>', `<input type="text" inputmode="decimal" id="wf-salary" value="${esc(v.salary === undefined || v.salary === "" ? "" : String(v.salary))}" autocomplete="off" aria-required="true">`)}
          <div></div>
        </div>
        ${editing ? `<fieldset class="terms" id="wfFromBox">
          <legend>${esc(t("w.f.salaryFrom"))}</legend>
          <label class="radio"><input type="radio" name="wfFrom" value="next" checked> ${esc(t("w.f.fromNext"))}</label>
          <label class="radio"><input type="radio" name="wfFrom" value="current"> ${esc(t("w.f.fromCurrent"))}</label>
          <p class="muted small">${esc(t("w.f.salaryFromHelp"))}</p>
        </fieldset>` : ""}
        ${text("address", "address", t("w.f.address"))}
        ${field("wf-notes", esc(t("w.f.notes")), `<textarea id="wf-notes" rows="3">${esc(v.notes || "")}</textarea>`)}
        <p class="error" id="wfError" role="alert"></p>
        <div class="actions left">
          <button type="submit" class="btn primary">${esc(t(editing ? "w.saveChanges" : "w.save"))}</button>
          <button type="button" class="btn" data-act="w-form-cancel">${esc(t("common.cancel"))}</button>
        </div>
      </form>
    </div>`;
  }

  function readForm() {
    const val = (id) => ($(id) ? $(id).value : "");
    const from = Array.from(document.querySelectorAll('input[name="wfFrom"]')).find((r) => r.checked);
    return {
      name: val("wf-name"), phone: val("wf-phone"), position: val("wf-position"), address: val("wf-address"), notes: val("wf-notes"),
      startDate: $("wf-start") && $("wf-start").disabled ? (workerById(ui.editingId) || {}).startDate : val("wf-start"),
      salary: val("wf-salary"), salaryFrom: from ? from.value : "next",
    };
  }

  function submitWorker() {
    const input = readForm();
    const editing = ui.editingId;
    const fieldMap = { name: "wf-name", startDate: "wf-start", salary: "wf-salary", phone: "wf-phone", position: "wf-position", address: "wf-address", notes: "wf-notes" };
    showErr("wfError", "");
    clearInvalid($("workersRoot"));
    if (!editing && !ui.nonce) ui.nonce = Validation.uid();
    return act((d) => (editing ? W.updateWorker(d, editing, input, ctx()) : W.addWorker(d, { ...input, id: ui.nonce }, ctx())), {
      errorId: "wfError", fieldMap,
      done: (r) => {
        h.notify(t(editing ? "w.saved" : "w.added"));
        // The form's id is kept until the next form is opened: sending it again finds this worker instead of adding another.
        ui.editingId = null;
        ui.detailId = r.worker.id;
        ui.screen = "detail";
        ui.tab = "transactions";
        draw();
      },
    });
  }

  /* ==========================================================================
     A WORKER'S PAGE
     ========================================================================== */

  function infoHtml(worker, calc) {
    const row = (label, value) => `<div class="w-info-row"><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
    const history = (worker.statusHistory || []).map((s) => `${esc(t("w.status." + s.status))} · ${esc(fmtDay(s.day))}`).join("<br>");
    const raises = worker.salaryHistory.length > 1
      ? worker.salaryHistory.map((s) => `${esc(money(s.amount))} · ${esc(t("w.fromDay", { day: fmtDay(s.from) }))}`).join("<br>") : "";
    return `<div class="panel w-info">
      <h2>${esc(t("w.section.info"))}</h2>
      <dl class="w-info-grid">
        ${row(t("w.f.name"), esc(worker.name))}
        ${row(t("w.f.position"), worker.position ? esc(worker.position) : '<span class="muted">—</span>')}
        ${row(t("w.f.phone"), worker.phone ? esc(h.ltr(worker.phone)) : '<span class="muted">—</span>')}
        ${row(t("w.f.start"), esc(fmtDay(worker.startDate)))}
        ${row(t("w.f.monthlySalary"), esc(money(calc.current.salary)))}
        ${row(t("w.f.paydaySchedule"), esc(paydayText(worker)))}
        ${row(t("w.col.status"), empBadge(worker.status))}
        ${worker.address ? row(t("w.f.address"), esc(worker.address)) : ""}
        ${worker.notes ? row(t("w.f.notes"), `<span class="prewrap">${esc(worker.notes)}</span>`) : ""}
        ${raises ? row(t("w.f.salaryHistory"), raises) : ""}
        ${history ? row(t("w.f.employment"), history) : ""}
      </dl>
    </div>`;
  }

  function overviewHtml(worker, calc) {
    const cur = calc.current;
    const prevDebt = Math.max(0, W.toCents(cur.previousDebt) - W.toCents(cur.recovered)) / 100;
    const notes = [];
    if (!calc.started) notes.push(`<p class="muted small">${esc(t("w.notStarted", { day: fmtDay(worker.startDate) }))}</p>`);
    if (cur.balance < 0) notes.push(`<p class="warn-box">${esc(t("w.projectedDebt", { amount: money(-cur.balance) }))}</p>`);
    if (calc.unpaidEarlier > 0) notes.push(`<p class="warn-box">${esc(t("w.unpaidEarlier", { amount: money(calc.unpaidEarlier) }))} <button type="button" class="link" data-act="w-tab" data-tab="periods">${esc(t("w.viewPeriods"))}</button></p>`);
    return `<div class="panel">
      <h2>${esc(t("w.section.overview"))}</h2>
      <p class="muted small">${esc(t("w.currentPeriod"))}: ${period(cur)} · ${esc(t("w.nextPayday"))}: <strong>${esc(fmtDay(calc.nextPayday))}</strong></p>
      <div class="stat-strip" id="wOverview">
        ${stat(t("w.card.salary"), esc(money(cur.salary)))}
        ${stat(t("w.card.advances"), esc(money(cur.advances)))}
        ${stat(t("w.card.previousDebt"), esc(money(prevDebt)), prevDebt > 0 ? "warn" : "")}
        ${stat(t("w.card.remaining"), esc(money(cur.remaining)), cur.remaining > 0 ? "credit" : "")}
      </div>
      ${notes.join("")}
    </div>`;
  }

  function detailHeader(worker, calc) {
    const inactive = worker.status === "inactive";
    const payable = calc.periods.some((p) => p.index <= calc.currentIndex && p._remainingCents > 0);
    const buttons = [
      `<button type="button" class="btn" data-act="w-back">${esc(t("w.backToList"))}</button>`,
      `<button type="button" class="btn" data-act="w-edit" data-id="${esc(worker.id)}">${esc(t("w.edit"))}</button>`,
      `<button type="button" class="btn primary" data-act="w-advance"${inactive ? ` disabled title="${esc(t("w.err.inactive"))}"` : ""}>${esc(t("w.giveAdvance"))}</button>`,
      `<button type="button" class="btn primary" data-act="w-pay"${payable ? "" : ` disabled title="${esc(t("w.payNothing"))}"`}>${esc(t("w.paySalary"))}</button>`,
      `<button type="button" class="btn" data-act="w-adjust"${inactive ? ` disabled title="${esc(t("w.err.inactive"))}"` : ""}>${esc(t("w.adjust"))}</button>`,
      `<button type="button" class="btn" data-act="w-recover"${calc.debt > 0 ? "" : ` disabled title="${esc(t("w.err.recNoDebt"))}"`}>${esc(t("w.recover"))}</button>`,
      `<button type="button" class="btn" data-act="w-status" data-status="${inactive ? "active" : "inactive"}">${esc(t(inactive ? "w.reactivate" : "w.deactivate"))}</button>`,
    ];
    return pageHeader(worker.name, buttons.join(""));
  }

  /* -- Forms for a transaction (advance, salary payment, adjustment, debt recovery, correction) -- */

  function panelKind() {
    if (ui.panel === "edit-tx") {
      const tx = S().workerTransactions.find((x) => x.id === ui.editTxId);
      return tx ? tx.type : "";
    }
    return { advance: "advance", pay: "payment", adjust: "adjustment", recover: "recovery" }[ui.panel] || "";
  }

  function panelHtml(worker, calc) {
    if (!ui.panel) return "";
    const kind = panelKind();
    if (!kind) return "";
    const editing = ui.panel === "edit-tx";
    const tx = editing ? S().workerTransactions.find((x) => x.id === ui.editTxId) : null;
    const owing = calc.periods.filter((p) => p.index <= calc.currentIndex && p._remainingCents > 0);
    const target = tx && kind === "payment" ? tx.periodIndex : W.defaultPayPeriod(calc);
    const targetPeriod = calc.periods[target] || calc.current;
    let amountValue = tx ? String(tx.amount) : "";
    if (!tx && kind === "payment") amountValue = String(targetPeriod.remaining || "");
    if (!tx && kind === "recovery") amountValue = String(Math.max(0, W.toCents(calc.current.previousDebt) - W.toCents(calc.current.recovered)) / 100 || "");

    let extra = "";
    let help = "";
    if (kind === "payment") {
      const choices = (editing ? calc.periods.filter((p) => p.index <= calc.currentIndex) : owing);
      extra = field("txPeriod", esc(t("w.f.forPeriod")), `<select id="txPeriod">${choices.map((p) => option(String(p.index), `${period(p)} — ${money(p.remaining)}`, p.index === target)).join("")}</select>`);
      help = `<p class="w-payable" id="wPayable">${esc(t("w.payableNow"))}: <strong>${esc(money(targetPeriod.remaining))}</strong></p><p class="muted small">${esc(t("w.payHelp"))}</p>`;
    } else if (kind === "adjustment") {
      extra = field("txSign", esc(t("w.f.adjSign")), `<select id="txSign">${option("plus", t("w.sign.plus"), !tx || tx.sign === "plus")}${option("minus", t("w.sign.minus"), tx && tx.sign === "minus")}</select>`);
      help = `<p class="muted small">${esc(t("w.adjHelp"))}</p>`;
    } else if (kind === "advance") {
      help = `<p class="muted small">${esc(t("w.advanceHelp"))}</p>`;
    } else if (kind === "recovery") {
      help = `<p class="muted small">${esc(t("w.recoverHelp", { amount: money(calc.debt) }))}</p>`;
    }
    const title = editing ? t("w.editTx", { type: typeName(kind).toLowerCase() }) : t({ advance: "w.giveAdvance", payment: "w.paySalary", adjustment: "w.adjust", recovery: "w.recover" }[kind]);
    const submit = editing ? t("w.saveChanges") : t({ advance: "w.saveAdvance", payment: "w.confirmPayment", adjustment: "w.saveAdjust", recovery: "w.saveRecover" }[kind]);
    return `<div class="panel w-panel" id="wPanel">
      <form id="wTxForm" data-form="${editing ? "w-tx-save" : "w-tx"}" data-kind="${esc(kind)}" novalidate>
        <h3>${esc(title)}</h3>
        ${help}
        <div class="grid-4">
          ${field("txAmount", esc(t("w.f.amount", { currency: S().settings.currency })) + ' <span class="req" aria-hidden="true">*</span>', `<input type="text" inputmode="decimal" id="txAmount" value="${esc(amountValue)}" autocomplete="off" placeholder="0">`)}
          ${field("txDate", esc(t("w.f.date")), `<input type="date" id="txDate" value="${esc(tx ? tx.date : today())}">`)}
          ${extra}
        </div>
        ${field("txNote", esc(t("w.f.note")), `<input type="text" id="txNote" value="${esc(tx ? tx.note : "")}" autocomplete="off" maxlength="${W.MAX_TEXT}">`)}
        <p class="error" id="txError" role="alert"></p>
        <div class="actions left">
          <button type="submit" class="btn primary">${esc(submit)}</button>
          <button type="button" class="btn" data-act="w-panel-cancel">${esc(t("common.cancel"))}</button>
        </div>
      </form>
    </div>`;
  }

  function submitTransaction(editing) {
    const worker = workerById(ui.detailId);
    if (!worker) return;
    const kind = panelKind();
    const input = { amount: $("txAmount").value, date: $("txDate").value, note: $("txNote").value };
    if ($("txSign")) input.sign = $("txSign").value;
    if ($("txPeriod")) input.periodIndex = Number($("txPeriod").value);
    const fieldMap = { amount: "txAmount", date: "txDate", note: "txNote", sign: "txSign", periodIndex: "txPeriod" };
    showErr("txError", "");
    clearInvalid($("workersRoot"));
    if (editing) {
      const id = ui.editTxId;
      return act((d) => W.updateTransaction(d, id, input, ctx()), {
        errorId: "txError", fieldMap,
        done: (r) => { h.notify(t(r.skip ? "w.txNoChange" : "w.txChanged")); closePanel(); },
      });
    }
    if (!ui.nonce) ui.nonce = Validation.uid();
    const id = ui.nonce;
    return act((d) => W.addTransaction(d, { ...input, id, workerId: worker.id, type: kind }, ctx()), {
      errorId: "txError", fieldMap,
      done: (r) => {
        const calc = calcOf(workerById(worker.id));
        let message = t(r.already ? "w.alreadyRecorded" : "w.recorded." + kind);
        if (kind === "advance" && !r.already && calc.current.overrun > 0) message += " " + t("w.advanceOverrun", { amount: money(calc.current.overrun) });
        h.notify(message);
        closePanel();
      },
    });
  }

  function openPanel(panel, txId) {
    ui.panel = panel;
    ui.editTxId = txId || "";
    ui.confirm = null;
    ui.nonce = Validation.uid();
    draw();
    const amount = $("txAmount");
    if (amount && amount.focus) amount.focus();
  }

  function closePanel() {
    ui.panel = "";
    ui.editTxId = "";
    ui.nonce = "";
    draw();
  }

  /* -- Transaction history -- */

  function describe(x) {
    return x.note ? esc(x.note) : `<span class="muted">${esc(t("w.desc." + x.type))}</span>`;
  }

  function filteredHistory(calc) {
    const q = norm(ui.tq);
    return calc.history.filter((x) => {
      if (ui.ttype !== "all" && x.type !== ui.ttype) return false;
      if (ui.tfrom && x.date < ui.tfrom) return false;
      if (ui.tto && x.date > ui.tto) return false;
      if (q && !norm([x.note, typeName(x.type), x.date, fmtDay(x.date), String(x.amount)].join(" ")).includes(q)) return false;
      return true;
    });
  }

  function signedAmount(x) {
    if (x.type === "adjustment") return (x.sign === "minus" ? "−" : "+") + money(x.amount);
    return money(x.amount);
  }

  function balanceText(n) {
    return n < 0 ? "−" + money(-n) : money(n);
  }

  function txRowsHtml(list, periods, withActions) {
    if (!list.length) return `<tr class="empty-row"><td colspan="${withActions ? 7 : 6}">${esc(t("w.noTx"))}</td></tr>`;
    return list.map((x) => {
      const p = periods[x.periodIndex];
      return `<tr data-id="${esc(x.id)}">
        <td>${esc(fmtDay(x.date))}</td>
        <td>${typeBadge(x)}${x.history && x.history.length ? ` <span class="muted small" title="${esc(t("w.corrected"))}">✎</span>` : ""}</td>
        <td class="w-desc">${describe(x)}</td>
        <td class="num">${esc(signedAmount(x))}</td>
        <td>${p ? `<button type="button" class="link" data-act="w-period" data-index="${p.index}">${period(p)}</button>` : ""}</td>
        <td class="num${x.balanceAfter < 0 ? " owed" : ""}">${esc(balanceText(x.balanceAfter))}</td>
        ${withActions ? `<td class="num w-actions"><button type="button" class="btn small" data-act="w-tx-edit" data-id="${esc(x.id)}">${esc(t("common.edit"))}</button> <button type="button" class="btn small" data-act="w-tx-delete" data-id="${esc(x.id)}">${esc(t("common.delete"))}</button></td>` : ""}
      </tr>`;
    }).join("");
  }

  function txTableHead(withActions) {
    return `<thead><tr><th>${esc(t("w.col.date"))}</th><th>${esc(t("w.col.type"))}</th><th>${esc(t("w.col.description"))}</th><th class="num">${esc(t("w.col.amount"))}</th><th>${esc(t("w.col.period"))}</th><th class="num">${esc(t("w.col.balance"))}</th>${withActions ? `<th class="num">${esc(t("col.actions"))}</th>` : ""}</tr></thead>`;
  }

  function confirmHtml(worker, calc) {
    const c = ui.confirm;
    if (!c) return "";
    if (c.kind === "delete-tx") {
      const x = S().workerTransactions.find((y) => y.id === c.id);
      if (!x) return "";
      return `<div class="warn-box w-confirm" id="wConfirm" role="alertdialog">
        <p><strong>${esc(t("w.deleteTitle"))}</strong></p>
        <p>${esc(t("w.deleteText", { type: typeName(x.type).toLowerCase(), amount: money(x.amount), date: fmtDay(x.date) }))}</p>
        <div class="actions left"><button type="button" class="btn danger" data-act="w-tx-delete-yes" data-id="${esc(x.id)}">${esc(t("w.deleteYes"))}</button>
        <button type="button" class="btn" data-act="w-confirm-cancel">${esc(t("common.cancel"))}</button></div></div>`;
    }
    if (c.kind === "status") {
      return `<div class="warn-box w-confirm" id="wConfirm" role="alertdialog">
        <p>${esc(t(c.status === "inactive" ? "w.deactivateText" : "w.reactivateText", { name: worker.name }))}</p>
        <div class="actions left"><button type="button" class="btn primary" data-act="w-status-yes" data-status="${esc(c.status)}">${esc(t(c.status === "inactive" ? "w.deactivate" : "w.reactivate"))}</button>
        <button type="button" class="btn" data-act="w-confirm-cancel">${esc(t("common.cancel"))}</button></div></div>`;
    }
    return "";
  }

  function transactionsHtml(worker, calc) {
    const list = filteredHistory(calc);
    return `<div class="panel stock-list">
      <h2>${esc(t("w.section.transactions"))}</h2>
      <div class="stock-toolbar w-tx-toolbar">
        <div class="stock-search">
          ${SEARCH_ICON}
          <label class="sr-only" for="wtSearch">${esc(t("w.txSearchLabel"))}</label>
          <input type="search" id="wtSearch" value="${esc(ui.tq)}" placeholder="${esc(t("w.txSearchPlaceholder"))}" autocomplete="off">
        </div>
        <div class="list-filters">
          <label class="sr-only" for="wtType">${esc(t("w.col.type"))}</label>
          <select id="wtType">${TYPE_FILTERS.map((v) => option(v, v === "all" ? t("w.filter.allTypes") : typeName(v), ui.ttype === v)).join("")}</select>
          <label class="w-date-filter"><span class="sr-only">${esc(t("w.from"))}</span><input type="date" id="wtFrom" value="${esc(ui.tfrom)}" title="${esc(t("w.from"))}"></label>
          <label class="w-date-filter"><span class="sr-only">${esc(t("w.to"))}</span><input type="date" id="wtTo" value="${esc(ui.tto)}" title="${esc(t("w.to"))}"></label>
        </div>
      </div>
      <div class="table-wrap stock-table-wrap">
        <table class="table w-tx-table">${txTableHead(true)}<tbody id="wtRows">${txRowsHtml(list, calc.periods, true)}</tbody></table>
      </div>
      <p class="muted small">${esc(t("w.balanceLegend"))}</p>
    </div>`;
  }

  /* -- Salary periods -- */

  function periodsHtml(worker, calc) {
    const rows = calc.periods.slice().reverse().map((p) => `<tr data-index="${p.index}">
        <td><button type="button" class="link" data-act="w-period" data-index="${p.index}">${period(p)}</button>${p.isCurrent ? ` <span class="muted small">(${esc(t("w.current"))})</span>` : ""}</td>
        <td>${esc(fmtDay(p.payday))}</td>
        <td class="num">${esc(money(p.salary))}</td>
        <td class="num">${p.previousDebt > 0 ? esc(money(p.previousDebt)) : '<span class="muted">—</span>'}</td>
        <td class="num">${esc(money(p.advances))}</td>
        <td class="num">${esc(money(p.payments))}</td>
        <td class="num">${esc(money(p.remaining))}</td>
        <td class="num${p.debtOut > 0 ? " owed" : ""}">${p.debtOut > 0 ? esc(money(p.debtOut)) : '<span class="muted">—</span>'}</td>
        <td>${periodStatus(p.status)}</td>
        <td class="num"><button type="button" class="btn small" data-act="w-period" data-index="${p.index}">${esc(t("w.open"))}</button></td>
      </tr>`).join("");
    return `<div class="panel stock-list">
      <h2>${esc(t("w.section.periods"))}</h2>
      <p class="muted small">${esc(t("w.periodsHelp"))}</p>
      <div class="table-wrap stock-table-wrap">
        <table class="table w-period-table"><thead><tr>
          <th>${esc(t("w.col.period"))}</th><th>${esc(t("w.col.payday"))}</th><th class="num">${esc(t("w.col.salary"))}</th><th class="num">${esc(t("w.col.prevDebt"))}</th>
          <th class="num">${esc(t("w.col.advances"))}</th><th class="num">${esc(t("w.col.payments"))}</th><th class="num">${esc(t("w.col.remainingPayable"))}</th>
          <th class="num">${esc(t("w.col.carried"))}</th><th>${esc(t("w.col.settlement"))}</th><th class="num">${esc(t("col.actions"))}</th>
        </tr></thead><tbody>${rows}</tbody></table>
      </div>
    </div>`;
  }

  function periodDetailHtml(worker, calc) {
    const p = calc.periods[ui.periodIndex];
    if (!p) return "";
    const line = (label, value, cls) => `<tr class="${cls || ""}"><td>${esc(label)}</td><td class="num">${esc(value)}</td></tr>`;
    const other = p.adjustments;
    return `${pageHeader(worker.name, `<button type="button" class="btn" data-act="w-period-back">${esc(t("w.backToWorker"))}</button>`)}
      <div class="panel">
        <h2>${esc(t("w.periodTitle"))}: ${period(p)} ${periodStatus(p.status)}</h2>
        <p class="muted small">${esc(t("w.col.payday"))}: ${esc(fmtDay(p.payday))}${p.isCurrent ? " · " + esc(t("w.current")) : ""}</p>
        <div class="table-wrap"><table class="table w-formula"><tbody>
          ${line(t("w.col.salary"), money(p.salary))}
          ${line("− " + t("w.col.prevDebt"), money(p.previousDebt))}
          ${p.recovered > 0 ? line("+ " + t("w.type.recovery"), money(p.recovered)) : ""}
          ${other !== 0 ? line((other > 0 ? "+ " : "− ") + t("w.type.adjustment"), money(Math.abs(other))) : ""}
          ${line("− " + t("w.col.advances"), money(p.advances))}
          ${line("= " + t("w.availableSalary"), balanceText(p.available), "w-total")}
          ${line("− " + t("w.col.payments"), money(p.payments))}
          ${line("= " + t("w.col.remainingPayable"), money(p.remaining), "w-total")}
          ${p.debtOut > 0 ? line(t("w.col.carried"), money(p.debtOut), "w-debt") : ""}
        </tbody></table></div>
      </div>
      <div class="panel stock-list">
        <h2>${esc(t("w.section.transactions"))}</h2>
        <div class="table-wrap stock-table-wrap"><table class="table w-tx-table">${txTableHead(false)}<tbody>${txRowsHtml(p.transactions, calc.periods, false)}</tbody></table></div>
        <p class="muted small">${esc(t("w.balanceLegend"))}</p>
      </div>`;
  }

  function detailHtml() {
    const worker = workerById(ui.detailId);
    if (!worker) { ui.screen = "list"; ui.detailId = null; return listHtml(); }
    const calc = calcOf(worker);
    if (ui.screen === "period") {
      if (calc.periods[ui.periodIndex]) return periodDetailHtml(worker, calc);
      ui.screen = "detail";
    }
    return `${detailHeader(worker, calc)}
      ${confirmHtml(worker, calc)}
      ${panelHtml(worker, calc)}
      ${infoHtml(worker, calc)}
      ${overviewHtml(worker, calc)}
      <div class="tabs" role="tablist">
        ${["transactions", "periods"].map((tab) => `<button type="button" class="tab${ui.tab === tab ? " active" : ""}" role="tab" aria-selected="${ui.tab === tab}" data-act="w-tab" data-tab="${tab}">${esc(t("w.tab." + tab))}</button>`).join("")}
      </div>
      <div id="wTabBody">${ui.tab === "periods" ? periodsHtml(worker, calc) : transactionsHtml(worker, calc)}</div>`;
  }

  /* ==========================================================================
     DRAWING AND EVENTS
     ========================================================================== */

  function pageHtml() {
    if (ui.screen === "form") {
      const existing = ui.editingId ? workerById(ui.editingId) : null;
      if (ui.editingId && !existing) { ui.screen = "list"; ui.editingId = null; return listHtml(); }
      return pageHeader(t("nav.workers")) + formHtml(existing || {});
    }
    if (ui.screen === "detail" || ui.screen === "period") return detailHtml();
    return listHtml();
  }

  function draw() {
    const root = $("workersRoot");
    if (!root) return;
    root.innerHTML = pageHtml();
    ui.formLang = I18n.language();
  }

  // Called by the page whenever it redraws. A form that is open is left alone (what was typed in it is kept) unless the language changed.
  function render() {
    if (!h || S().view !== "workers") return;
    const root = $("workersRoot");
    if (!root) return;
    const formOpen = (ui.screen === "form" && $("wForm")) || (ui.panel && $("wTxForm"));
    if (formOpen && ui.formLang === I18n.language()) return;
    draw();
  }

  function refreshList() {
    const rows = $("wRows");
    if (rows) rows.innerHTML = rowsHtml();
  }

  function refreshTransactions() {
    const worker = workerById(ui.detailId);
    const rows = $("wtRows");
    if (!worker || !rows) return;
    const calc = calcOf(worker);
    rows.innerHTML = txRowsHtml(filteredHistory(calc), calc.periods, true);
  }

  function goList() {
    ui.screen = "list"; ui.editingId = null; ui.detailId = null; ui.panel = ""; ui.editTxId = ""; ui.confirm = null; ui.nonce = "";
    draw();
  }

  function openWorker(id, tab) {
    ui.screen = "detail"; ui.detailId = id; ui.tab = tab || "transactions"; ui.panel = ""; ui.editTxId = ""; ui.confirm = null; ui.nonce = "";
    ui.tq = ""; ui.ttype = "all"; ui.tfrom = ""; ui.tto = "";
    if (S().view !== "workers") h.showView("workers");
    else draw();
  }

  function setStatus(status) {
    const id = ui.detailId;
    return act((d) => W.setWorkerStatus(d, id, status, ctx()), {
      done: () => { h.notify(t(status === "inactive" ? "w.deactivated" : "w.reactivated")); ui.confirm = null; draw(); },
    });
  }

  function onClick(e) {
    const el = e.target && e.target.closest ? e.target.closest("[data-act]") : null;
    if (!el) return;
    const act_ = el.dataset.act;
    if (el.disabled) return;
    switch (act_) {
      case "w-add": ui.screen = "form"; ui.editingId = null; ui.nonce = Validation.uid(); draw(); { const n = $("wf-name"); if (n && n.focus) n.focus(); } break;
      case "w-edit": ui.screen = "form"; ui.editingId = el.dataset.id; ui.nonce = ""; ui.panel = ""; ui.confirm = null; draw(); break;
      case "w-form-cancel":
        if (ui.editingId) { ui.screen = "detail"; ui.detailId = ui.editingId; ui.editingId = null; draw(); } else goList();
        break;
      case "w-open": openWorker(el.dataset.id); break;
      case "w-back": goList(); break;
      case "w-sort": {
        const key = el.dataset.key;
        const [cur, dir] = ui.sort.split("-");
        ui.sort = key + "-" + (cur === key && dir === "asc" ? "desc" : "asc");
        draw();
        break;
      }
      case "w-advance": openPanel("advance"); break;
      case "w-pay": openPanel("pay"); break;
      case "w-adjust": openPanel("adjust"); break;
      case "w-recover": openPanel("recover"); break;
      case "w-panel-cancel": closePanel(); break;
      case "w-tx-edit": openPanel("edit-tx", el.dataset.id); break;
      case "w-tx-delete": ui.confirm = { kind: "delete-tx", id: el.dataset.id }; ui.panel = ""; draw(); { const c = $("wConfirm"); if (c && c.scrollIntoView) c.scrollIntoView({ block: "nearest" }); } break;
      case "w-tx-delete-yes": {
        const id = el.dataset.id;
        return act((d) => W.deleteTransaction(d, id, ctx()), { done: () => { h.notify(t("w.deleted")); ui.confirm = null; draw(); } });
      }
      case "w-confirm-cancel": ui.confirm = null; draw(); break;
      case "w-status": ui.confirm = { kind: "status", status: el.dataset.status }; ui.panel = ""; draw(); break;
      case "w-status-yes": return setStatus(el.dataset.status);
      case "w-tab": ui.tab = el.dataset.tab; ui.screen = "detail"; draw(); break;
      case "w-period": ui.screen = "period"; ui.periodIndex = Number(el.dataset.index); draw(); break;
      case "w-period-back": ui.screen = "detail"; ui.tab = "periods"; draw(); break;
      default: break;
    }
  }

  function onSubmit(e) {
    const form = e.target && e.target.closest ? e.target.closest("[data-form]") : null;
    if (!form) return;
    e.preventDefault();
    if (form.dataset.form === "w-save") submitWorker();
    else if (form.dataset.form === "w-tx") submitTransaction(false);
    else if (form.dataset.form === "w-tx-save") submitTransaction(true);
  }

  function onInput(e) {
    const id = e.target && e.target.id;
    if (id === "wSearch") { ui.q = e.target.value; refreshList(); }
    else if (id === "wtSearch") { ui.tq = e.target.value; refreshTransactions(); }
  }

  function onChange(e) {
    const id = e.target && e.target.id;
    if (id === "wStatus") { ui.status = e.target.value; refreshList(); }
    else if (id === "wSort") { ui.sort = e.target.value; draw(); }
    else if (id === "wtType") { ui.ttype = e.target.value; refreshTransactions(); }
    else if (id === "wtFrom") { ui.tfrom = e.target.value; refreshTransactions(); }
    else if (id === "wtTo") { ui.tto = e.target.value; refreshTransactions(); }
    else if (id === "txPeriod") {
      // Choosing another period to pay: the amount offered follows that period's remaining salary.
      const worker = workerById(ui.detailId);
      const p = worker && calcOf(worker).periods[Number(e.target.value)];
      if (p && $("wPayable")) $("wPayable").innerHTML = `${esc(t("w.payableNow"))}: <strong>${esc(money(p.remaining))}</strong>`;
      if (p && $("txAmount") && ui.panel === "pay") $("txAmount").value = String(p.remaining || "");
    }
  }

  function onKeyDown(e) {
    // Enter inside a search box never submits anything.
    if (e.key === "Enter" && e.target && (e.target.id === "wSearch" || e.target.id === "wtSearch")) e.preventDefault();
  }

  function init(hooks) {
    h = hooks;
  }

  function bind() {
    const root = $("workersRoot");
    root.addEventListener("click", onClick);
    root.addEventListener("submit", onSubmit);
    root.addEventListener("input", onInput);
    root.addEventListener("change", onChange);
    root.addEventListener("keydown", onKeyDown);
  }

  // The person pressed the menu button of the page they are already on: back to the list (an open form is kept).
  function home() {
    if (ui.screen === "form" || ui.panel) return;
    ui.screen = "list"; ui.detailId = null; ui.confirm = null;
    draw();
  }

  // Leaves any open form or page that points at data that no longer exists (after a restore, for example).
  function reset() {
    ui.screen = "list"; ui.editingId = null; ui.detailId = null; ui.panel = ""; ui.editTxId = ""; ui.confirm = null; ui.nonce = ""; ui.periodIndex = null;
  }

  globalThis.WorkersUI = {
    init, bind, render, reset, home, openWorker,
    // for tests
    state: ui, listRows, rowsHtml, stripHtml, detailHtml, formHtml, calcOf, draw, submitWorker, submitTransaction, setSearch: (q) => { ui.q = q; },
    // Presses a button the way a click would (the same code the page's click handler runs).
    press: (action, data) => onClick({ target: { closest: () => ({ dataset: { act: action, ...(data || {}) }, disabled: false }) } }),
  };
})();

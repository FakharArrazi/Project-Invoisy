"use strict";

/* ==========================================================================
   Workers - the people the shop pays, their salary periods, advances and salary payments.

   Plain script (no modules, so index.html still works when opened directly). No DOM and no storage access: it only
   checks, calculates and edits a COPY of the application data (a "draft"), exactly like purchases.js. The caller
   saves the draft with commit(), so every change is one transaction. Loaded after purchases.js (it reuses its day
   helpers) and before validation.js, which uses it to check backup files, and before database.js.

   Payroll is its own world: nothing here reads or changes invoices, stock, suppliers or purchases.

   What is stored (two lists, both inside the same database and the same backup file as everything else)
     workers             one record per worker. Never deleted: a worker who leaves is set to "inactive".
                         salaryHistory keeps the salary of every period as it was when it was in force, so a later raise
                         never rewrites an old period.
     workerTransactions  one record per advance, salary payment, salary adjustment or debt recovery.
   What is NOT stored: salary periods, balances and settlements. They are worked out from the two lists by compute(),
   every time, so editing or deleting an old transaction can never leave a stale balance or a duplicate settlement.

   Salary periods
     The worker's starting date gives the payday: the same day number every month (the 5th, for a start on the 5th).
     A period runs from one payday until the day before the next one (5 Nov to 4 Dec) and is paid on the next payday.
     A day that a month does not have (29, 30, 31) uses that month's last day; the original day is used again as soon as a
     month has it (31 Jan, 28 Feb, 31 Mar). The paydays are always counted from the starting date, never from the previous
     payday, so the schedule can not drift.

   One formula, every period (all in whole centimes, so there is no floating-point error)
     available  = salary - debt carried in + recoveries + adjustments - advances
     balance    = available - salary payments
     balance > 0  the shop still owes the worker this much (the period's "remaining payable")
     balance = 0  nothing is left to pay
     balance < 0  the worker owes the shop this much; it is carried into the next period as "previous debt", and again
                  into the one after, until it is recovered. It never disappears when a new month starts.

   Which period a transaction belongs to
     advance, adjustment, recovery   the period that contains its date (a date before the starting date counts in the first one)
     salary payment                  the period it pays, chosen when it is recorded (the shop often pays last month's salary
                                     on the next payday, so its date alone would name the wrong period)
   ========================================================================== */

(function () {
  const t = (key, params) => I18n.t(key, params);
  const D = globalThis.Purchases;

  const TYPES = ["advance", "payment", "adjustment", "recovery"];
  const STATUSES = ["active", "inactive"];
  const SIGNS = ["plus", "minus"];
  const MAX_AMOUNT = 1e9;       // dinars: far above any salary, far below where cents stop being exact
  const MAX_TEXT = 2000;
  const MAX_NAME = 200;

  /* ---------- Small helpers ---------- */

  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const isStr = (v) => typeof v === "string";
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const isIso = (v) => isStr(v) && v !== "" && !isNaN(new Date(v));
  const isBlank = (v) => v === undefined || v === null || (isStr(v) && v.trim() === "");
  const text = (v) => (v === undefined || v === null ? "" : String(v));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const toNumber = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

  const isDay = D.isDay;
  const addDays = D.addDays;
  const nowOf = (ctx) => (ctx && ctx.now) || new Date();
  const isoOf = (ctx) => nowOf(ctx).toISOString();
  const todayOf = (ctx) => (ctx && ctx.today) || D.toDay(nowOf(ctx));
  // An amount inside a message: the caller's own money format (dinars or centimes, with the label) when it gives one.
  const showAmount = (ctx, dinars) => (ctx && typeof ctx.format === "function" ? ctx.format(dinars) : String(dinars));

  /* ---------- Money: whole centimes inside, dinars with two decimals outside ---------- */

  const toCents = (dinars) => Math.round(Number(dinars) * 100);
  const fromCents = (cents) => cents / 100;
  const hasCents = (n) => Number.isFinite(n) && Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;

  // Reads what was typed in an amount field. { cents } or { error, field }. Never turns something unreadable into 0.
  function parseAmount(raw, field) {
    const f = field || "amount";
    if (typeof raw === "number") {
      if (!Number.isFinite(raw)) return { error: t("w.err.amountInvalid"), field: f };
    } else if (isBlank(raw)) {
      return { error: t("w.err.amountRequired"), field: f };
    } else if (!isStr(raw)) {
      return { error: t("w.err.amountInvalid"), field: f };
    }
    const n = typeof raw === "number" ? raw : Number(raw.trim().replace(/[\s\u00a0\u202f]/g, "").replace(",", "."));
    if (!Number.isFinite(n)) return { error: t("w.err.amountInvalid"), field: f };
    if (n <= 0) return { error: t("w.err.amountPositive"), field: f };
    if (n > MAX_AMOUNT) return { error: t("w.err.amountTooBig"), field: f };
    if (!hasCents(n)) return { error: t("w.err.amountDecimals"), field: f };
    return { cents: toCents(n) };
  }

  /* ---------- Paydays and salary periods ---------- */

  const parseDay = (day) => { const [y, m, d] = day.split("-").map(Number); return { y, m, d }; };
  const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();   // m is 1 to 12
  const dayText = (y, m, d) => `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

  // The payday `months` months after the starting month: the starting day, or the month's last day when it is shorter.
  function paydayAfter(startDay, months) {
    const { y, m, d } = parseDay(startDay);
    const total = y * 12 + (m - 1) + months;
    const year = Math.floor(total / 12);
    const month = (total % 12) + 1;
    return dayText(year, month, Math.min(d, daysInMonth(year, month)));
  }

  const periodStart = (startDay, i) => paydayAfter(startDay, i);
  const periodEnd = (startDay, i) => addDays(paydayAfter(startDay, i + 1), -1);
  const periodPayday = (startDay, i) => paydayAfter(startDay, i + 1);

  // The index (0, 1, 2 ...) of the salary period that contains a day. A day before the start counts in the first period.
  function periodIndexOf(startDay, day) {
    if (day <= startDay) return 0;
    const a = parseDay(startDay);
    const b = parseDay(day);
    let i = Math.max(0, (b.y * 12 + b.m) - (a.y * 12 + a.m));
    while (i > 0 && paydayAfter(startDay, i) > day) i--;
    while (paydayAfter(startDay, i + 1) <= day) i++;
    return i;
  }

  // The salary that was in force when a period started. Entries are { from: day, amount }, the first one from the starting day.
  function salaryAt(worker, day) {
    let amount = worker.salaryHistory[0].amount;
    for (const entry of worker.salaryHistory) if (entry.from <= day) amount = entry.amount;
    return amount;
  }

  /* ---------- Records ---------- */

  function normalizeWorker(raw) {
    if (!isObj(raw)) return null;
    const startDate = text(raw.startDate);
    const salary = toNumber(raw.salary);
    const history = Array.isArray(raw.salaryHistory)
      ? raw.salaryHistory.map((h) => ({ from: text(h && h.from), amount: toNumber(h && h.amount) }))
      : [{ from: startDate, amount: salary }];
    return {
      ...raw,
      id: String(raw.id || uid()),
      name: text(raw.name).trim(),
      phone: text(raw.phone).trim(),
      position: text(raw.position).trim(),
      address: text(raw.address).trim(),
      notes: text(raw.notes).trim(),
      startDate,
      salary,
      salaryHistory: history,
      status: raw.status === "inactive" ? "inactive" : "active",
      statusHistory: Array.isArray(raw.statusHistory) ? raw.statusHistory.map((h) => ({ day: text(h && h.day), status: h && h.status === "inactive" ? "inactive" : "active" })) : [],
      createdAt: text(raw.createdAt),
      updatedAt: text(raw.updatedAt),
    };
  }

  function workerProblem(w) {
    if (!isObj(w)) return t("problem.notObject");
    if (!isStr(w.id) || !w.id) return t("problem.noId");
    if (!isStr(w.name) || !w.name.trim() || w.name.length > MAX_NAME) return t("problem.badField", { field: "name" });
    for (const key of ["phone", "position", "address", "notes"]) {
      if (w[key] !== undefined && (!isStr(w[key]) || w[key].length > MAX_TEXT)) return t("problem.badField", { field: key });
    }
    if (!isDay(w.startDate)) return t("problem.badDate");
    if (!isNum(w.salary) || w.salary <= 0 || w.salary > MAX_AMOUNT || !hasCents(w.salary)) return t("problem.badField", { field: "salary" });
    if (!Array.isArray(w.salaryHistory) || !w.salaryHistory.length) return t("problem.badField", { field: "salaryHistory" });
    let previous = "";
    for (const h of w.salaryHistory) {
      if (!isObj(h) || !isDay(h.from) || !isNum(h.amount) || h.amount <= 0 || h.amount > MAX_AMOUNT || !hasCents(h.amount)) return t("problem.badField", { field: "salaryHistory" });
      if (previous && h.from <= previous) return t("problem.badField", { field: "salaryHistory" });
      previous = h.from;
    }
    if (w.salaryHistory[0].from !== w.startDate || w.salaryHistory[w.salaryHistory.length - 1].amount !== w.salary) return t("problem.badField", { field: "salaryHistory" });
    if (!STATUSES.includes(w.status)) return t("problem.badStatus");
    if (w.statusHistory !== undefined && (!Array.isArray(w.statusHistory) || w.statusHistory.some((h) => !isObj(h) || !isDay(h.day) || !STATUSES.includes(h.status)))) return t("problem.badField", { field: "statusHistory" });
    if (!isIso(w.createdAt)) return t("problem.badField", { field: "createdAt" });
    if (w.updatedAt !== undefined && w.updatedAt !== "" && !isIso(w.updatedAt)) return t("problem.badField", { field: "updatedAt" });
    return "";
  }

  function normalizeTransaction(raw) {
    if (!isObj(raw)) return null;
    const out = {
      ...raw,
      id: String(raw.id || uid()),
      workerId: text(raw.workerId),
      type: text(raw.type),
      amount: toNumber(raw.amount),
      date: text(raw.date),
      note: text(raw.note).trim(),
      createdAt: text(raw.createdAt),
      updatedAt: text(raw.updatedAt),
      history: Array.isArray(raw.history) ? raw.history.map((h) => ({ ...h })) : [],
    };
    if (out.type === "adjustment") out.sign = raw.sign === "minus" ? "minus" : "plus";
    if (out.type === "payment" && raw.periodIndex !== undefined) out.periodIndex = Number(raw.periodIndex);
    return out;
  }

  function transactionProblem(x) {
    if (!isObj(x)) return t("problem.notObject");
    if (!isStr(x.id) || !x.id) return t("problem.noId");
    if (!isStr(x.workerId) || !x.workerId) return t("problem.badWorkerLink");
    if (!TYPES.includes(x.type)) return t("problem.badField", { field: "type" });
    if (!isNum(x.amount) || x.amount <= 0 || x.amount > MAX_AMOUNT || !hasCents(x.amount)) return t("problem.badPayment");
    if (!isDay(x.date)) return t("problem.badDate");
    if (x.note !== undefined && (!isStr(x.note) || x.note.length > MAX_TEXT)) return t("problem.badField", { field: "note" });
    if (x.type === "adjustment" && !SIGNS.includes(x.sign)) return t("problem.badField", { field: "sign" });
    if (x.type !== "adjustment" && x.sign !== undefined) return t("problem.badField", { field: "sign" });
    if (x.type === "payment" && !(Number.isInteger(x.periodIndex) && x.periodIndex >= 0)) return t("problem.badField", { field: "periodIndex" });
    if (x.type !== "payment" && x.periodIndex !== undefined) return t("problem.badField", { field: "periodIndex" });
    if (!isIso(x.createdAt)) return t("problem.badField", { field: "createdAt" });
    if (x.updatedAt !== undefined && x.updatedAt !== "" && !isIso(x.updatedAt)) return t("problem.badField", { field: "updatedAt" });
    if (x.history !== undefined && (!Array.isArray(x.history) || x.history.some((h) => !isObj(h) || !isNum(h.amount) || !isIso(h.at)))) return t("problem.badField", { field: "history" });
    return "";
  }

  // Every transaction must belong to a worker that is in the same data.
  function linkProblems(data) {
    const problems = [];
    const ids = new Set((data.workers || []).map((w) => w.id));
    for (const x of data.workerTransactions || []) {
      if (!ids.has(x.workerId)) problems.push(`Worker transaction "${x.id}" ${t("problem.badWorkerLink")}.`);
    }
    return problems;
  }

  /* ==========================================================================
     THE CALCULATION: every period of one worker, from the records alone
     ========================================================================== */

  const byWhen = (a, b) => String(a.date).localeCompare(String(b.date)) || String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id));

  // compute(worker, transactions, today) -> { periods, current, currentIndex, nextPayday, ... }. Amounts come back in dinars.
  function compute(worker, transactions, today) {
    const start = worker.startDate;
    const mine = transactions.filter((x) => x.workerId === worker.id).sort(byWhen);
    const where = (x) => (x.type === "payment" ? x.periodIndex : periodIndexOf(start, x.date));
    const todayIndex = periodIndexOf(start, today);
    const last = mine.reduce((m, x) => Math.max(m, where(x)), todayIndex);

    const periods = [];
    let carry = 0;                                   // debt carried into the period, in cents
    for (let i = 0; i <= last; i++) {
      const first = periodStart(start, i);
      const salary = toCents(salaryAt(worker, first));
      let advances = 0, payments = 0, plus = 0, minus = 0, recovered = 0;
      const list = mine.filter((x) => where(x) === i);
      for (const x of list) {
        const c = toCents(x.amount);
        if (x.type === "advance") advances += c;
        else if (x.type === "payment") payments += c;
        else if (x.type === "recovery") recovered += c;
        else if (x.sign === "minus") minus += c;
        else plus += c;
      }
      const available = salary - carry + recovered + plus - minus - advances;
      const balance = available - payments;
      const payday = periodPayday(start, i);
      const closed = today >= payday;
      const remaining = Math.max(0, balance);
      const debtOut = Math.max(0, -balance);
      let status;
      if (closed && balance < 0) status = "debt";
      else if (balance === 0) status = "paid";
      else if (balance > 0 && payments > 0) status = "partial";
      else status = "pending";

      // The running balance of the period after each transaction, in the order they happened.
      let running = salary - carry;
      const rows = list.map((x) => {
        const c = toCents(x.amount);
        if (x.type === "advance" || x.type === "payment" || (x.type === "adjustment" && x.sign === "minus")) running -= c;
        else running += c;
        return { ...x, periodIndex: i, balanceAfter: fromCents(running) };
      });

      periods.push({
        index: i, start: first, end: periodEnd(start, i), payday, closed, isCurrent: i === todayIndex,
        salary: fromCents(salary), previousDebt: fromCents(carry), recovered: fromCents(recovered),
        advances: fromCents(advances), payments: fromCents(payments), adjustments: fromCents(plus - minus),
        available: fromCents(available), balance: fromCents(balance), remaining: fromCents(remaining), debtOut: fromCents(debtOut),
        // Advances above this period's own salary (and adjustments): the part that will become debt.
        overrun: fromCents(Math.max(0, advances - (salary + plus - minus))),
        status, transactions: rows,
        _remainingCents: remaining, _debtOutCents: debtOut, _carryCents: carry, _recoveredCents: recovered, _balanceCents: balance,
      });
      carry = debtOut;
    }

    const current = periods[todayIndex];
    const unpaidEarlier = periods.filter((p) => p.index < todayIndex).reduce((sum, p) => sum + p._remainingCents, 0);
    const debtNow = Math.max(0, toCents(current.previousDebt) - toCents(current.recovered)) + toCents(current.overrun);
    return {
      workerId: worker.id, today, periods, current, currentIndex: todayIndex,
      started: today >= start,
      nextPayday: current.payday,
      unpaidEarlier: fromCents(unpaidEarlier),
      debt: fromCents(debtNow),
      // Every transaction in the order it happened, each with its period and the period's balance after it.
      history: periods.flatMap((p) => p.transactions).sort(byWhen),
    };
  }

  // The period a salary payment should pre-select: the oldest closed period that still has something to pay,
  // otherwise the current one.
  function defaultPayPeriod(calc) {
    const owing = calc.periods.filter((p) => p.index <= calc.currentIndex && p._remainingCents > 0);
    const closedOwing = owing.find((p) => p.closed);
    return (closedOwing || owing[owing.length - 1] || calc.current).index;
  }

  // Figures for the workers list and the summary cards. `transactions` is the whole list; `today` a day.
  function overview(workers, transactions, today) {
    const monthPrefix = today.slice(0, 7);
    let activeCount = 0, salaries = 0, advancesMonth = 0, debts = 0;
    const rows = workers.map((worker) => {
      const calc = compute(worker, transactions, today);
      if (worker.status === "active") {
        activeCount++;
        salaries += toCents(calc.current.salary);
      }
      debts += toCents(calc.debt);
      return { worker, calc };
    });
    for (const x of transactions) if (x.type === "advance" && x.date.slice(0, 7) === monthPrefix) advancesMonth += toCents(x.amount);
    return { rows, activeCount, monthlySalaries: fromCents(salaries), advancesThisMonth: fromCents(advancesMonth), debts: fromCents(debts) };
  }

  /* ==========================================================================
     CHANGES: each works on a draft and returns { error, field } or its result
     ========================================================================== */

  const lists = (d) => {
    if (!Array.isArray(d.workers)) d.workers = [];
    if (!Array.isArray(d.workerTransactions)) d.workerTransactions = [];
    return d;
  };

  const tooLong = (value, field) => (text(value).length > MAX_TEXT ? { error: t("w.err.tooLong"), field } : null);

  function readWorkerInput(input) {
    const name = text(input.name).trim();
    if (!name) return { error: t("w.err.name"), field: "name" };
    if (name.length > MAX_NAME) return { error: t("w.err.tooLong"), field: "name" };
    if (!isDay(text(input.startDate).trim())) return { error: t("w.err.startDate"), field: "startDate" };
    const salary = parseAmount(isStr(input.salary) ? input.salary : input.salary, "salary");
    if (salary.error) return { error: salary.field === "salary" && isBlank(input.salary) ? t("w.err.salaryRequired") : salary.error, field: "salary" };
    for (const key of ["phone", "position", "address", "notes"]) {
      const bad = tooLong(input[key], key);
      if (bad) return bad;
    }
    return {
      value: {
        name, startDate: text(input.startDate).trim(), salary: fromCents(salary.cents),
        phone: text(input.phone).trim(), position: text(input.position).trim(), address: text(input.address).trim(), notes: text(input.notes).trim(),
      },
    };
  }

  function addWorker(d, input, ctx) {
    lists(d);
    const wanted = input && isStr(input.id) && input.id ? input.id : "";
    const twin = wanted && d.workers.find((w) => w.id === wanted);
    if (twin) return { worker: twin, already: true };      // the same form sent twice: the first record is the answer
    const read = readWorkerInput(input || {});
    if (read.error) return read;
    const v = read.value;
    const worker = normalizeWorker({
      id: wanted || uid(), ...v, salaryHistory: [{ from: v.startDate, amount: v.salary }], status: "active",
      statusHistory: [{ day: todayOf(ctx), status: "active" }], createdAt: isoOf(ctx), updatedAt: "",
    });
    d.workers.push(worker);
    return { worker };
  }

  // Edit the profile. The starting date (and with it the payday) only changes when it is changed on purpose, and not at all once the
  // worker has transactions. A new salary is applied from the current or the next period, never to the periods already settled.
  function updateWorker(d, id, input, ctx) {
    lists(d);
    const worker = d.workers.find((w) => w.id === id);
    if (!worker) return { error: t("w.err.noWorker") };
    const read = readWorkerInput(input || {});
    if (read.error) return read;
    const v = read.value;
    const has = d.workerTransactions.some((x) => x.workerId === id);
    const today = todayOf(ctx);

    if (v.startDate !== worker.startDate) {
      if (has) return { error: t("w.err.startLocked"), field: "startDate" };
      worker.startDate = v.startDate;
      worker.salaryHistory = [{ from: v.startDate, amount: worker.salary }];
    }
    if (toCents(v.salary) !== toCents(worker.salary)) {
      const index = periodIndexOf(worker.startDate, today);
      const from = input.salaryFrom === "current" ? periodStart(worker.startDate, index) : periodStart(worker.startDate, index + 1);
      // The new amount replaces anything planned from that day on; periods that already started keep their salary.
      worker.salaryHistory = worker.salaryHistory.filter((h) => h.from < from);
      if (!worker.salaryHistory.length) worker.salaryHistory = [{ from: worker.startDate, amount: v.salary }];
      else if (salaryAt(worker, from) !== v.salary) worker.salaryHistory.push({ from, amount: v.salary });
      worker.salary = worker.salaryHistory[worker.salaryHistory.length - 1].amount;
      worker.salaryHistory[0].from = worker.startDate;
    }
    worker.name = v.name; worker.phone = v.phone; worker.position = v.position; worker.address = v.address; worker.notes = v.notes;
    worker.updatedAt = isoOf(ctx);
    return { worker };
  }

  function setWorkerStatus(d, id, status, ctx) {
    lists(d);
    const worker = d.workers.find((w) => w.id === id);
    if (!worker) return { error: t("w.err.noWorker") };
    if (!STATUSES.includes(status)) return { error: t("w.err.badStatus") };
    if (worker.status === status) return { skip: true, worker };
    worker.status = status;
    worker.statusHistory = [...(worker.statusHistory || []), { day: todayOf(ctx), status }];
    worker.updatedAt = isoOf(ctx);
    return { worker };
  }

  // The figures a new or changed transaction is checked against: the worker's periods as they would be WITHOUT `skipId`.
  function calcWithout(d, worker, skipId, ctx) {
    return compute(worker, d.workerTransactions.filter((x) => x.id !== skipId), todayOf(ctx));
  }

  // Checks one transaction against the worker's other records. Returns { error, field } or { cents }.
  function checkTransaction(d, worker, fields, skipId, ctx) {
    const amount = parseAmount(fields.amount, "amount");
    if (amount.error) return amount;
    if (!isDay(fields.date)) return { error: t("w.err.date"), field: "date" };
    const bad = tooLong(fields.note, "note");
    if (bad) return bad;
    const calc = calcWithout(d, worker, skipId, ctx);

    if (fields.type === "adjustment" && !SIGNS.includes(fields.sign)) return { error: t("w.err.adjSign"), field: "sign" };

    if (fields.type === "payment") {
      const index = fields.periodIndex;
      if (!Number.isInteger(index) || index < 0 || index > calc.currentIndex) return { error: t("w.err.payPeriod"), field: "periodIndex" };
      const period = calc.periods[index];
      if (period._remainingCents <= 0) return { error: t("w.err.payNothing"), field: "amount" };
      if (amount.cents > period._remainingCents) return { error: t("w.err.payTooMuch", { max: showAmount(ctx, fromCents(period._remainingCents)) }), field: "amount", max: fromCents(period._remainingCents) };
    }

    if (fields.type === "recovery") {
      const index = periodIndexOf(worker.startDate, fields.date);
      const period = calc.periods[index] || { _carryCents: 0, _recoveredCents: 0 };
      const owed = Math.max(0, period._carryCents - period._recoveredCents);
      if (owed <= 0) return { error: t("w.err.recNoDebt"), field: "amount" };
      if (amount.cents > owed) return { error: t("w.err.recTooMuch", { max: showAmount(ctx, fromCents(owed)) }), field: "amount", max: fromCents(owed) };
    }
    return { cents: amount.cents };
  }

  function addTransaction(d, input, ctx) {
    lists(d);
    const i = input || {};
    const wanted = isStr(i.id) && i.id ? i.id : "";
    const twin = wanted && d.workerTransactions.find((x) => x.id === wanted);
    if (twin) return { transaction: twin, already: true };   // the same form sent twice: never recorded twice
    const worker = d.workers.find((w) => w.id === i.workerId);
    if (!worker) return { error: t("w.err.noWorker") };
    if (!TYPES.includes(i.type)) return { error: t("w.err.badType") };
    if (worker.status !== "active" && (i.type === "advance" || i.type === "adjustment")) return { error: t("w.err.inactive"), field: "amount" };
    const fields = {
      type: i.type, amount: i.amount, date: text(i.date).trim() || todayOf(ctx), note: text(i.note).trim(),
      sign: i.type === "adjustment" ? (i.sign === "minus" ? "minus" : i.sign === "plus" ? "plus" : "") : undefined,
      periodIndex: i.type === "payment" ? (i.periodIndex === "" || i.periodIndex === undefined || i.periodIndex === null ? undefined : Number(i.periodIndex)) : undefined,
    };
    const checked = checkTransaction(d, worker, fields, null, ctx);
    if (checked.error) return checked;
    const tx = normalizeTransaction({
      id: wanted || uid(), workerId: worker.id, type: fields.type, amount: fromCents(checked.cents), date: fields.date, note: fields.note,
      ...(fields.type === "adjustment" ? { sign: fields.sign } : {}),
      ...(fields.type === "payment" ? { periodIndex: fields.periodIndex } : {}),
      createdAt: isoOf(ctx), updatedAt: "", history: [],
    });
    d.workerTransactions.push(tx);
    return { transaction: tx };
  }

  // Correct a transaction (amount, date, note, the adjustment's direction, the period a payment pays). The type never changes:
  // delete it and record the right one instead. The old values are kept in its history.
  function updateTransaction(d, id, input, ctx) {
    lists(d);
    const tx = d.workerTransactions.find((x) => x.id === id);
    if (!tx) return { error: t("w.err.noTx") };
    const worker = d.workers.find((w) => w.id === tx.workerId);
    if (!worker) return { error: t("w.err.noWorker") };
    const i = input || {};
    const fields = {
      type: tx.type, amount: i.amount !== undefined ? i.amount : tx.amount, date: i.date !== undefined ? text(i.date).trim() : tx.date,
      note: i.note !== undefined ? text(i.note).trim() : tx.note,
      sign: tx.type === "adjustment" ? (i.sign !== undefined ? i.sign : tx.sign) : undefined,
      periodIndex: tx.type === "payment" ? (i.periodIndex !== undefined ? Number(i.periodIndex) : tx.periodIndex) : undefined,
    };
    const checked = checkTransaction(d, worker, fields, tx.id, ctx);
    if (checked.error) return checked;
    const next = fromCents(checked.cents);
    if (toCents(tx.amount) === checked.cents && tx.date === fields.date && tx.note === fields.note && tx.sign === fields.sign && tx.periodIndex === fields.periodIndex) return { skip: true, transaction: tx };
    tx.history = [...(tx.history || []), { at: isoOf(ctx), amount: tx.amount, date: tx.date, note: tx.note, ...(tx.sign ? { sign: tx.sign } : {}), ...(tx.periodIndex !== undefined ? { periodIndex: tx.periodIndex } : {}) }];
    tx.amount = next; tx.date = fields.date; tx.note = fields.note;
    if (tx.type === "adjustment") tx.sign = fields.sign;
    if (tx.type === "payment") tx.periodIndex = fields.periodIndex;
    tx.updatedAt = isoOf(ctx);
    return { transaction: tx };
  }

  // Removes a wrongly recorded transaction. Nothing else has to be reversed: balances are never stored, so every
  // affected period and every later carried debt is worked out again from what remains.
  function deleteTransaction(d, id, ctx) {
    lists(d);
    const index = d.workerTransactions.findIndex((x) => x.id === id);
    if (index < 0) return { error: t("w.err.noTx") };
    const [removed] = d.workerTransactions.splice(index, 1);
    return { removed };
  }

  globalThis.Workers = {
    TYPES, STATUSES, SIGNS, MAX_AMOUNT, MAX_TEXT,
    toCents, fromCents, parseAmount,
    paydayAfter, periodStart, periodEnd, periodPayday, periodIndexOf, salaryAt,
    normalizeWorker, workerProblem, normalizeTransaction, transactionProblem, linkProblems,
    compute, defaultPayPeriod, overview,
    addWorker, updateWorker, setWorkerStatus, addTransaction, updateTransaction, deleteTransaction,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = globalThis.Workers;
})();

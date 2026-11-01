"use strict";

// Workers and payroll: the rules (workers.js) on plain data, the database and backup file, and the screens driven through
// the real page scripts against a disposable in-memory database.

const test = require("node:test");
const assert = require("node:assert/strict");
const { newDb, V, DB } = require("./helpers/modules");
const { loadApp } = require("./helpers/app");

const W = globalThis.Workers;
const P = globalThis.Purchases;
const ctx = (day, extra) => ({ today: day, now: new Date(day + "T10:00:00Z"), ...extra });
const fresh = () => ({ workers: [], workerTransactions: [] });

function hire(d, startDate, salary, extra) {
  const r = W.addWorker(d, { name: "Ali Benali", startDate, salary: String(salary), ...extra }, ctx(startDate));
  assert.equal(r.error, undefined, r.error);
  return r.worker;
}
function give(d, worker, type, amount, date, extra) {
  const r = W.addTransaction(d, { workerId: worker.id, type, amount: String(amount), date, ...extra }, ctx(extra && extra.today ? extra.today : date));
  return r;
}
const calc = (d, worker, today) => W.compute(worker, d.workerTransactions, today);
const periodsOf = (c) => c.periods.map((p) => `${p.index}:${p.status}:${p.remaining}:${p.debtOut}`);

/* ---------- Paydays ---------- */

test("payday: the starting day repeats every month, and a day a month does not have uses that month's last day", () => {
  const list = (start, n) => Array.from({ length: n }, (_, i) => W.periodStart(start, i));
  assert.deepEqual(list("2026-11-05", 3), ["2026-11-05", "2026-12-05", "2027-01-05"]);
  assert.deepEqual(list("2026-01-31", 5), ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31"], "31: short months use their last day, the 31st comes back");
  assert.deepEqual(list("2026-01-30", 4), ["2026-01-30", "2026-02-28", "2026-03-30", "2026-04-30"], "30: February only");
  assert.deepEqual(list("2027-01-29", 14).slice(12), ["2028-01-29", "2028-02-29"], "29: a leap year keeps the 29th");
  assert.equal(W.periodStart("2027-01-29", 1), "2027-02-28", "29: not a leap year");
  // The schedule is counted from the starting date, so it never drifts after a short month.
  assert.equal(W.periodStart("2026-08-31", 6), "2027-02-28");
  assert.equal(W.periodStart("2026-08-31", 7), "2027-03-31");
});

test("payday: a period runs until the day before the next payday and a day is found in the right period", () => {
  assert.equal(W.periodEnd("2026-11-05", 0), "2026-12-04");
  assert.equal(W.periodPayday("2026-11-05", 0), "2026-12-05");
  assert.equal(W.periodEnd("2026-01-31", 1), "2026-03-30", "the period that started on 28 Feb ends on 30 Mar");
  const idx = (day) => W.periodIndexOf("2026-01-31", day);
  assert.deepEqual([idx("2026-01-31"), idx("2026-02-27"), idx("2026-02-28"), idx("2026-03-30"), idx("2026-03-31"), idx("2026-04-29"), idx("2026-04-30")], [0, 0, 1, 1, 2, 2, 3]);
  assert.equal(W.periodIndexOf("2026-11-05", "2026-10-01"), 0, "a day before the start counts in the first period");
});

/* ---------- Adding and editing ---------- */

test("adding a worker: required fields, optional fields, the salary history starts at the starting date", () => {
  const d = fresh();
  assert.match(W.addWorker(d, { name: "", startDate: "2026-11-05", salary: "30000" }, ctx("2026-11-05")).error, /name/i);
  assert.equal(W.addWorker(d, { name: "A", startDate: "", salary: "30000" }, ctx("2026-11-05")).field, "startDate");
  assert.equal(W.addWorker(d, { name: "A", startDate: "2026-11-05", salary: "" }, ctx("2026-11-05")).field, "salary");
  assert.equal(W.addWorker(d, { name: "A", startDate: "2026-11-05", salary: "0" }, ctx("2026-11-05")).field, "salary");
  assert.equal(W.addWorker(d, { name: "A", startDate: "2026-11-05", salary: "-5" }, ctx("2026-11-05")).field, "salary");
  assert.equal(W.addWorker(d, { name: "A", startDate: "2026-11-05", salary: "abc" }, ctx("2026-11-05")).field, "salary");
  assert.equal(d.workers.length, 0, "nothing was added by the refused attempts");
  const w = hire(d, "2026-11-05", "30 000,50", { phone: "0555 11 22 33", position: "Driver", address: "Sétif", notes: "n" });
  assert.equal(w.salary, 30000.5);
  assert.deepEqual(w.salaryHistory, [{ from: "2026-11-05", amount: 30000.5 }]);
  assert.equal(w.status, "active");
  assert.equal(W.workerProblem(w), "");
});

test("editing a worker keeps the starting date and payday, applies a raise from the next period and never rewrites an old one", () => {
  const d = fresh();
  const w = hire(d, "2026-11-05", 30000);
  give(d, w, "advance", 1000, "2026-11-06");
  const before = W.periodStart(w.startDate, 1);
  // Unrelated information only.
  const r = W.updateWorker(d, w.id, { name: "Ali B.", startDate: w.startDate, salary: "30000", phone: "0666", position: "Foreman", address: "", notes: "" }, ctx("2026-11-20"));
  assert.equal(r.error, undefined);
  assert.equal(w.startDate, "2026-11-05");
  assert.equal(W.periodStart(w.startDate, 1), before);
  assert.equal(w.name, "Ali B.");
  // A raise on 20 November applies from 5 December by default.
  assert.equal(W.updateWorker(d, w.id, { name: "Ali B.", startDate: w.startDate, salary: "35000" }, ctx("2026-11-20")).error, undefined);
  let c = calc(d, w, "2026-12-10");
  assert.deepEqual(c.periods.map((p) => p.salary), [30000, 35000]);
  assert.equal(w.salary, 35000);
  // Another change today replaces the planned one instead of stacking.
  W.updateWorker(d, w.id, { name: "Ali B.", startDate: w.startDate, salary: "36000" }, ctx("2026-11-21"));
  assert.deepEqual(w.salaryHistory, [{ from: "2026-11-05", amount: 30000 }, { from: "2026-12-05", amount: 36000 }]);
  // Applied to the current period on purpose (a typing mistake).
  W.updateWorker(d, w.id, { name: "Ali B.", startDate: w.startDate, salary: "31000", salaryFrom: "current" }, ctx("2026-11-21"));
  c = calc(d, w, "2026-11-21");
  assert.equal(c.current.salary, 31000);
  // The starting date is locked once there are transactions.
  const locked = W.updateWorker(d, w.id, { name: "Ali B.", startDate: "2026-11-01", salary: "31000" }, ctx("2026-11-21"));
  assert.equal(locked.field, "startDate");
  assert.equal(w.startDate, "2026-11-05");
  // Without transactions it can be corrected, and the salary history follows.
  const free = hire(d, "2026-11-10", 20000);
  assert.equal(W.updateWorker(d, free.id, { name: "Free", startDate: "2026-11-12", salary: "20000" }, ctx("2026-11-12")).error, undefined);
  assert.deepEqual(free.salaryHistory, [{ from: "2026-11-12", amount: 20000 }]);
});

test("a worker is marked inactive and reactivated with history kept; an inactive worker gets no new advance", () => {
  const d = fresh();
  const w = hire(d, "2026-11-05", 30000);
  give(d, w, "advance", 5000, "2026-11-06");
  assert.equal(W.setWorkerStatus(d, w.id, "inactive", ctx("2026-11-20")).worker.status, "inactive");
  assert.equal(give(d, w, "advance", 100, "2026-11-21").field, "amount");
  assert.equal(W.addTransaction(d, { workerId: w.id, type: "adjustment", sign: "plus", amount: "10", date: "2026-11-21" }, ctx("2026-11-21")).field, "amount");
  // Paying what is owed still works: the worker left, the salary is still due.
  assert.equal(give(d, w, "payment", 25000, "2026-11-21", { periodIndex: 0 }).error, undefined);
  assert.equal(d.workerTransactions.length, 2, "the records stay");
  assert.equal(W.setWorkerStatus(d, w.id, "inactive", ctx("2026-11-22")).skip, true);
  W.setWorkerStatus(d, w.id, "active", ctx("2026-11-23"));
  assert.deepEqual(w.statusHistory.map((s) => s.status), ["active", "inactive", "active"]);
  assert.equal(give(d, w, "advance", 100, "2026-11-24").error, undefined);
});

/* ---------- Advances ---------- */

test("advances: several in one period are added up automatically (14,000 of 30,000 leaves 16,000)", () => {
  const d = fresh();
  const w = hire(d, "2026-11-01", 30000);
  for (const [day, amount] of [["2026-11-03", 5000], ["2026-11-05", 3000], ["2026-11-07", 4000], ["2026-11-10", 2000]]) assert.equal(give(d, w, "advance", amount, day).error, undefined);
  const c = calc(d, w, "2026-11-12");
  assert.equal(c.current.advances, 14000);
  assert.equal(c.current.remaining, 16000);
  assert.equal(c.nextPayday, "2026-12-01");
  assert.equal(c.debt, 0);
  const rows = c.history.map((x) => x.balanceAfter);
  assert.deepEqual(rows, [25000, 22000, 18000, 16000], "the balance after each transaction");
  // An advance dated before the starting date counts in the first period, never in a period that does not exist.
  const early = hire(d, "2026-11-05", 30000, { name: "Early" });
  give(d, early, "advance", 5000, "2026-11-03", { today: "2026-11-12" });
  assert.equal(calc(d, early, "2026-11-12").current.advances, 5000);
});

test("amounts: zero, negative, unreadable and more-than-two-decimal amounts are refused; cents add up exactly", () => {
  const d = fresh();
  const w = hire(d, "2026-11-01", 1000);
  for (const bad of ["0", "-5", "abc", "", "10.005", "1e400", "99999999999"]) assert.ok(give(d, w, "advance", bad, "2026-11-02").error, `"${bad}" must be refused`);
  assert.equal(d.workerTransactions.length, 0);
  give(d, w, "advance", "0.10", "2026-11-02");
  give(d, w, "advance", "0,20", "2026-11-03");
  assert.equal(calc(d, w, "2026-11-04").current.advances, 0.3, "0.1 + 0.2 is exactly 0.30");
  assert.equal(calc(d, w, "2026-11-04").current.remaining, 999.7);
  assert.ok(give(d, w, "advance", "5000", "not a date").error);
});

test("a form sent twice records one advance (the same id finds the first)", () => {
  const d = fresh();
  const w = hire(d, "2026-11-01", 30000);
  const first = W.addTransaction(d, { id: "same", workerId: w.id, type: "advance", amount: "100", date: "2026-11-02" }, ctx("2026-11-02"));
  const second = W.addTransaction(d, { id: "same", workerId: w.id, type: "advance", amount: "100", date: "2026-11-02" }, ctx("2026-11-02"));
  assert.equal(second.already, true);
  assert.equal(first.transaction.id, second.transaction.id);
  assert.equal(d.workerTransactions.length, 1);
});

/* ---------- Settlement, debt, payments ---------- */

test("advances above the salary become debt carried into the next period (35,000 on 30,000 leaves 5,000)", () => {
  const d = fresh();
  const w = hire(d, "2026-11-01", 30000);
  give(d, w, "advance", 15000, "2026-11-03");
  give(d, w, "advance", 10000, "2026-11-10");
  give(d, w, "advance", 10000, "2026-11-15");
  // Before payday the shortfall is shown as projected, and nothing is carried yet.
  let c = calc(d, w, "2026-11-20");
  assert.equal(c.current.remaining, 0);
  assert.equal(c.current.balance, -5000);
  assert.equal(c.current.overrun, 5000);
  assert.equal(c.debt, 5000);
  // On payday the period is settled with debt carried forward.
  c = calc(d, w, "2026-12-01");
  assert.deepEqual([c.periods[0].status, c.periods[0].remaining, c.periods[0].debtOut], ["debt", 0, 5000]);
  assert.deepEqual([c.current.salary, c.current.previousDebt, c.current.available, c.current.remaining], [30000, 5000, 25000, 25000]);
});

test("debt is carried across several months until it is recovered, and never disappears", () => {
  const d = fresh();
  const w = hire(d, "2026-01-31", 30000);
  give(d, w, "advance", 100000, "2026-02-01");           // period 1 (28 Feb - 30 Mar)? no: still period 0
  let c = calc(d, w, "2026-06-10");
  // period 0 owes 70,000; month 2 salary covers 30,000, month 3 another 30,000, month 4 the last 10,000.
  assert.deepEqual(c.periods.map((p) => [p.previousDebt, p.available, p.remaining, p.debtOut]), [
    [0, -70000, 0, 70000], [70000, -40000, 0, 40000], [40000, -10000, 0, 10000], [10000, 20000, 20000, 0], [0, 30000, 30000, 0],
  ]);
  assert.deepEqual(c.periods.map((p) => p.status), ["debt", "debt", "debt", "pending", "pending"]);
  // Debt is also still counted before any new month is reached.
  assert.equal(calc(d, w, "2026-02-15").debt, 70000);
});

test("paying the remaining salary: whole, in parts, never more than what is payable, never counted as an advance", () => {
  const d = fresh();
  const w = hire(d, "2026-11-01", 30000);
  give(d, w, "advance", 14000, "2026-11-05");
  let c = calc(d, w, "2026-11-12");
  assert.equal(W.defaultPayPeriod(c), 0);
  const tooMuch = give(d, w, "payment", 16001, "2026-11-12", { periodIndex: 0 });
  assert.match(tooMuch.error, /16/);
  assert.equal(give(d, w, "payment", 10000, "2026-11-12", { periodIndex: 0 }).error, undefined);
  c = calc(d, w, "2026-11-12");
  assert.deepEqual([c.current.advances, c.current.payments, c.current.remaining, c.current.status], [14000, 10000, 6000, "partial"], "6,000 stays owed and the advances are untouched");
  assert.equal(give(d, w, "payment", 6000, "2026-11-20", { periodIndex: 0 }).error, undefined);
  c = calc(d, w, "2026-11-20");
  assert.deepEqual([c.current.payments, c.current.remaining, c.current.status], [16000, 0, "paid"]);
  assert.equal(give(d, w, "payment", 1, "2026-11-20", { periodIndex: 0 }).field, "amount", "nothing left to pay");
  assert.equal(give(d, w, "payment", 1, "2026-11-20", { periodIndex: 5 }).field, "periodIndex", "a period that has not started");
});

test("last month's salary is paid on the next payday against last month, not this month", () => {
  const d = fresh();
  const w = hire(d, "2026-11-05", 30000);
  give(d, w, "advance", 10000, "2026-11-10");
  give(d, w, "advance", 2000, "2026-12-08");               // next period
  const c = calc(d, w, "2026-12-09");
  assert.equal(W.defaultPayPeriod(c), 0, "the closed period that still owes comes first");
  assert.equal(give(d, w, "payment", 20000, "2026-12-09", { periodIndex: 0, today: "2026-12-09" }).error, undefined);
  const after = calc(d, w, "2026-12-09");
  assert.deepEqual([after.periods[0].status, after.periods[0].remaining], ["paid", 0]);
  assert.deepEqual([after.periods[1].advances, after.periods[1].remaining], [2000, 28000]);
  assert.equal(after.unpaidEarlier, 0);
  // An unpaid closed period is kept as it is, not merged into the next one.
  const e = fresh();
  const w2 = hire(e, "2026-11-05", 30000);
  const c2 = calc(e, w2, "2026-12-09");
  assert.deepEqual([c2.unpaidEarlier, c2.current.available], [30000, 30000]);
});

test("adjustments and debt recoveries are their own kinds and move the balance the right way", () => {
  const d = fresh();
  const w = hire(d, "2026-01-01", 30000);
  give(d, w, "advance", 35000, "2026-01-05");
  assert.equal(give(d, w, "recovery", 100, "2026-01-06").field, "amount", "no debt carried in yet");
  assert.equal(W.addTransaction(d, { workerId: w.id, type: "adjustment", amount: "100", date: "2026-01-06" }, ctx("2026-01-06")).field, "sign");
  W.addTransaction(d, { workerId: w.id, type: "adjustment", sign: "plus", amount: "2000", date: "2026-01-07" }, ctx("2026-01-07"));
  W.addTransaction(d, { workerId: w.id, type: "adjustment", sign: "minus", amount: "500", date: "2026-01-08" }, ctx("2026-01-08"));
  let c = calc(d, w, "2026-02-10");
  assert.deepEqual([c.periods[0].adjustments, c.periods[0].debtOut], [1500, 3500]);
  assert.equal(give(d, w, "recovery", 4000, "2026-02-10").field, "amount", "more than the debt");
  assert.equal(give(d, w, "recovery", 1500, "2026-02-10").error, undefined);
  c = calc(d, w, "2026-02-10");
  assert.deepEqual([c.current.previousDebt, c.current.recovered, c.debt, c.current.available], [3500, 1500, 2000, 28000]);
  assert.equal(c.history.at(-1).type, "recovery");
});

/* ---------- Correcting and deleting ---------- */

test("correcting or deleting a transaction recalculates its period and every debt carried from it", () => {
  const d = fresh();
  const w = hire(d, "2026-01-01", 30000);
  const a = give(d, w, "advance", 80000, "2026-01-05").transaction;
  give(d, w, "advance", 1000, "2026-03-05");
  let c = calc(d, w, "2026-03-20");
  assert.deepEqual(c.periods.map((p) => p.debtOut), [50000, 20000, 0]);
  assert.equal(c.current.remaining, 9000, "salary 30,000 - debt 20,000 carried in - advance 1,000");
  // Correct 80,000 to 40,000: the debt in every later period follows.
  assert.equal(W.updateTransaction(d, a.id, { amount: "40000" }, ctx("2026-03-20")).error, undefined);
  c = calc(d, w, "2026-03-20");
  assert.deepEqual(c.periods.map((p) => [p.debtOut, p.remaining]), [[10000, 0], [0, 20000], [0, 29000]]);
  assert.equal(a.history.length, 1);
  assert.equal(a.history[0].amount, 80000, "the old value is kept in its history");
  // Delete it altogether.
  assert.equal(W.deleteTransaction(d, a.id, ctx("2026-03-20")).removed.id, a.id);
  c = calc(d, w, "2026-03-20");
  assert.deepEqual(c.periods.map((p) => [p.debtOut, p.remaining]), [[0, 30000], [0, 30000], [0, 29000]]);
  assert.equal(W.deleteTransaction(d, "nope", ctx("2026-03-20")).error !== undefined, true);
});

test("deleting a salary payment brings the amount back as payable; editing a payment can not pay more than is owed", () => {
  const d = fresh();
  const w = hire(d, "2026-11-01", 30000);
  give(d, w, "advance", 14000, "2026-11-05");
  const p1 = give(d, w, "payment", 10000, "2026-11-12", { periodIndex: 0 }).transaction;
  assert.equal(W.updateTransaction(d, p1.id, { amount: "16001" }, ctx("2026-11-12")).field, "amount");
  assert.equal(W.updateTransaction(d, p1.id, { amount: "16000", note: "all" }, ctx("2026-11-12")).error, undefined);
  assert.equal(calc(d, w, "2026-11-12").current.remaining, 0);
  assert.equal(W.updateTransaction(d, p1.id, { amount: "16000", note: "all" }, ctx("2026-11-12")).skip, true, "no change, nothing written");
  W.deleteTransaction(d, p1.id, ctx("2026-11-12"));
  assert.equal(calc(d, w, "2026-11-12").current.remaining, 16000);
});

test("an advance corrected AFTER a payment was made turns the overpayment into debt instead of losing it", () => {
  const d = fresh();
  const w = hire(d, "2026-11-01", 30000);
  const adv = give(d, w, "advance", 5000, "2026-11-05").transaction;
  give(d, w, "payment", 25000, "2026-11-10", { periodIndex: 0 });
  assert.equal(calc(d, w, "2026-11-10").current.remaining, 0);
  W.updateTransaction(d, adv.id, { amount: "9000" }, ctx("2026-12-02"));
  const c = calc(d, w, "2026-12-02");
  assert.deepEqual([c.periods[0].status, c.periods[0].debtOut, c.current.previousDebt, c.current.available], ["debt", 4000, 4000, 26000]);
});

/* ---------- Salary periods keep their own figures ---------- */

test("the salary history lists every period with the salary it really had", () => {
  const d = fresh();
  const w = hire(d, "2026-01-05", 30000);
  give(d, w, "advance", 1000, "2026-01-10");
  W.updateWorker(d, w.id, { name: w.name, startDate: w.startDate, salary: "40000" }, ctx("2026-02-20"));
  const c = calc(d, w, "2026-04-20");
  assert.deepEqual(c.periods.map((p) => p.salary), [30000, 30000, 40000, 40000]);
  assert.deepEqual([c.periods[0].advances, c.periods[0].remaining], [1000, 29000], "an old period is not touched by the raise");
  assert.equal(c.periods[2].start, "2026-03-05");
});

/* ---------- Summary cards ---------- */

test("overview: active workers, monthly salaries, advances this month and outstanding debts", () => {
  const d = fresh();
  const a = hire(d, "2026-10-01", 30000, { name: "A" });
  const b = hire(d, "2026-10-01", 20000, { name: "B" });
  const c = hire(d, "2026-10-01", 10000, { name: "C" });
  give(d, a, "advance", 40000, "2026-10-03", { today: "2026-11-10" });      // October debt 10,000
  give(d, b, "advance", 2500, "2026-11-04", { today: "2026-11-10" });
  W.setWorkerStatus(d, c.id, "inactive", ctx("2026-11-10"));
  const o = W.overview(d.workers, d.workerTransactions, "2026-11-10");
  assert.equal(o.activeCount, 2);
  assert.equal(o.monthlySalaries, 50000);
  assert.equal(o.advancesThisMonth, 2500, "only advances dated in the current month");
  assert.equal(o.debts, 10000);
});

/* ---------- Database, backup file, old files ---------- */

async function savedWorkers() {
  const db = newDb();
  await db.initDatabase();
  const before = await db.loadAll();
  const d = { ...before, workers: [...before.workers], workerTransactions: [...before.workerTransactions] };
  const w = hire(d, "2026-11-05", 30000, { phone: "0555" });
  give(d, w, "advance", 5000, "2026-11-06");
  give(d, w, "payment", 10000, "2026-12-06", { periodIndex: 0, today: "2026-12-06" });
  const changes = DB.diff(before, d);
  assert.equal(DB.isEmptyChange(changes), false);
  await db.commitChanges(changes, { expectedRevision: before.revision });
  return { db, w };
}

test("workers and their transactions are saved in the database and read back exactly", async () => {
  const { db, w } = await savedWorkers();
  const all = await db.loadAll();
  assert.equal(all.workers.length, 1);
  assert.equal(all.workerTransactions.length, 2);
  assert.deepEqual(all.workers[0], w);
  assert.deepEqual(all.workerTransactions.map((x) => x.type), ["advance", "payment"]);
});

test("a worker can never be deleted, and a transaction needs a worker that exists", async () => {
  const { db } = await savedWorkers();
  const all = await db.loadAll();
  await assert.rejects(() => db.commitChanges({ workers: { put: [], remove: [all.workers[0].id] } }, { expectedRevision: all.revision }), /never deleted/);
  const orphan = W.normalizeTransaction({ id: "x", workerId: "ghost", type: "advance", amount: 10, date: "2026-11-07", createdAt: "2026-11-07T10:00:00.000Z" });
  await assert.rejects(() => db.commitChanges({ workerTransactions: { put: [orphan], remove: [] } }, { expectedRevision: all.revision }), /worker/i);
  // A bad record is refused before anything is written.
  const bad = { ...all.workerTransactions[0], amount: -5 };
  await assert.rejects(() => db.commitChanges({ workerTransactions: { put: [bad], remove: [] } }, { expectedRevision: all.revision }));
  assert.equal((await db.loadAll()).workerTransactions.length, 2);
  // Removing a transaction (a deleted mistake) is allowed.
  await db.commitChanges({ workerTransactions: { put: [], remove: [all.workerTransactions[0].id] } }, { expectedRevision: all.revision });
  assert.equal((await db.loadAll()).workerTransactions.length, 1);
});

test("the backup file carries workers and transactions, and a restore brings them back", async () => {
  const { db } = await savedWorkers();
  const snapshot = await db.loadAll({ withAttachments: true });
  const file = V.prepareBackupFile(snapshot);
  assert.equal(file.error, undefined);
  assert.equal(file.counts.workers, 1);
  assert.equal(file.counts.workerTransactions, 2);
  const parsed = V.parseBackup(file.text);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.data.workers.length, 1);
  const other = newDb();
  await other.initDatabase();
  const done = await other.restore(parsed.data);
  assert.equal(done.counts.workers, 1);
  assert.deepEqual((await other.loadAll()).workerTransactions, snapshot.workerTransactions);
  // A file whose counts or links disagree is refused whole.
  const broken = JSON.parse(file.text);
  broken.data.workerTransactions[0].workerId = "ghost";
  assert.ok(V.parseBackup(JSON.stringify(broken)).error);
  const wrongCount = JSON.parse(file.text);
  wrongCount.counts.workers = 3;
  assert.ok(V.parseBackup(JSON.stringify(wrongCount)).error);
  const notAList = JSON.parse(file.text);
  notAList.data.workers = {};
  assert.ok(V.parseBackup(JSON.stringify(notAList)).error);
});

test("data without any worker keeps its exact backup shape, and an older file loads with an empty workers collection", async () => {
  const db = newDb();
  await db.initDatabase();
  const snapshot = await db.loadAll({ withAttachments: true });
  const file = V.prepareBackupFile(snapshot);
  const raw = JSON.parse(file.text);
  assert.equal("workers" in raw.data, false);
  assert.equal("workerTransactions" in raw.data, false);
  assert.equal("workers" in raw.counts, false);
  // A file written before workers existed (no such keys anywhere) is read as it always was.
  const parsed = V.parseBackup(file.text);
  assert.equal(parsed.error, undefined);
  const restoredInto = newDb();
  await restoredInto.initDatabase();
  await restoredInto.restore(parsed.data);
  const loaded = await restoredInto.loadAll();
  assert.deepEqual([loaded.workers, loaded.workerTransactions], [[], []]);
  // The old invoisy-data.json format too.
  const legacy = V.parseBackup(JSON.stringify({ version: 1, products: [], invoices: [], settings: {}, invoiceCounter: 0 }));
  assert.equal(legacy.error, undefined);
  assert.equal(legacy.data.workers, undefined);
});

test("opening a version 5 database adds the workers stores and keeps everything that was saved", async () => {
  const fake = require("fake-indexeddb");
  const factory = new fake.IDBFactory();
  const old = newDb({ indexedDB: factory, name: "upgrade-test" });
  await old.initDatabase();
  const product = require("./helpers/modules").sampleProduct({ id: "p-keep" });
  await old.commitChanges({ products: { put: [product], remove: [] } }, { expectedRevision: 0 });
  old.close && old.close();
  // Rebuild the file as version 5: delete the two new stores and lower the version.
  const raw = await new Promise((resolve, reject) => {
    const req = factory.open("upgrade-test");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  raw.close();
  const again = newDb({ indexedDB: factory, name: "upgrade-test" });
  const info = await again.initDatabase();
  assert.equal(info.version, DB.DB_VERSION);
  const all = await again.loadAll();
  assert.equal(all.products.length, 1);
  assert.deepEqual(all.workers, []);
});

/* ---------- The screens ---------- */

async function shop(options) {
  const app = loadApp(options);
  const storage = await app.start();
  assert.equal(storage.mode, "ready", storage.reason);
  app.api.getState().view = "workers";
  return app;
}
const ui = (app) => app.api.WorkersUI;
const state = (app) => app.api.getState();
const today = () => P.toDay(new Date());

function fillWorker(app, v) {
  const f = { name: "", phone: "", position: "", start: "", salary: "", address: "", notes: "", ...v };
  for (const [id, value] of Object.entries({ "wf-name": f.name, "wf-phone": f.phone, "wf-position": f.position, "wf-start": f.start, "wf-salary": f.salary, "wf-address": f.address, "wf-notes": f.notes })) app.field(id).value = value;
}
function fillTx(app, v) {
  app.field("txAmount").value = v.amount === undefined ? "" : String(v.amount);
  app.field("txDate").value = v.date || today();
  app.field("txNote").value = v.note || "";
  if (v.sign) app.field("txSign").value = v.sign;
  if (v.periodIndex !== undefined) app.field("txPeriod").value = String(v.periodIndex);
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("screens: the Workers page starts empty, a worker is added through the form, and the list shows it", async () => {
  const app = await shop();
  ui(app).draw();
  assert.match(app.field("workersRoot").innerHTML, /No workers yet/);
  assert.match(app.field("workersRoot").innerHTML, /Add New Worker/);
  ui(app).press("w-add");
  assert.match(app.field("workersRoot").innerHTML, /id="wf-name"/);
  fillWorker(app, { name: "", start: "2026-11-05", salary: "30000" });
  await ui(app).submitWorker();
  assert.match(app.errorText("wfError"), /full name/i, "a missing name is explained where the person is looking");
  assert.equal(state(app).workers.length, 0);
  fillWorker(app, { name: "Ali Benali", phone: "0555 12 34 56", position: "Driver", start: "2026-11-05", salary: "30000" });
  await ui(app).submitWorker();
  await ui(app).submitWorker();    // pressing save twice
  assert.equal(state(app).workers.length, 1, "pressing save twice adds one worker");
  const html = app.field("workersRoot").innerHTML;
  assert.match(html, /Ali Benali/);
  assert.match(html, /Every month on day 5/);
  ui(app).press("w-back");
  const list = app.field("workersRoot").innerHTML;
  assert.match(list, /0555 12 34 56/);
  assert.match(list, /Driver/);
  assert.match(list, /30,000 DA/);
});

test("screens: search, status filter and sorting of the list", async () => {
  const app = await shop();
  const mk = (name, phone, start, salary) => app.api.commit((d) => Workers.addWorker(d, { name, phone, startDate: start, salary: String(salary) }, { today: start, now: new Date() }));
  await mk("Zohra", "0661 00 00 01", "2026-03-10", 25000);
  await mk("Ahmed", "0770 22 33 44", "2026-01-20", 40000);
  await mk("Karim", "", "2026-02-15", 30000);
  const id = state(app).workers.find((w) => w.name === "Karim").id;
  await app.api.commit((d) => Workers.setWorkerStatus(d, id, "inactive", { today: "2026-06-01", now: new Date() }));
  const names = () => ui(app).listRows().rows.map((r) => r.worker.name);
  assert.deepEqual(names(), ["Ahmed", "Karim", "Zohra"]);
  ui(app).state.sort = "salary-desc";
  assert.deepEqual(names(), ["Ahmed", "Karim", "Zohra"]);
  ui(app).state.sort = "start-asc";
  assert.deepEqual(names(), ["Ahmed", "Karim", "Zohra"]);
  ui(app).state.sort = "start-desc";
  assert.deepEqual(names(), ["Zohra", "Karim", "Ahmed"]);
  ui(app).state.sort = "payday-asc";
  assert.equal(names().length, 3);
  ui(app).state.status = "inactive";
  assert.deepEqual(names(), ["Karim"]);
  ui(app).state.status = "active";
  assert.deepEqual(names().sort(), ["Ahmed", "Zohra"]);
  ui(app).state.status = "all";
  ui(app).setSearch("zoh");
  assert.deepEqual(names(), ["Zohra"]);
  ui(app).setSearch("0770 22");
  assert.deepEqual(names(), ["Ahmed"], "by phone number");
  ui(app).setSearch("nobody");
  assert.deepEqual(names(), []);
});

test("screens: Give Advance and Pay Remaining Salary update the page, and everything is still there after a reload", async () => {
  const app = await shop();
  const start = P.addDays(today(), -3);
  await app.api.commit((d) => Workers.addWorker(d, { name: "Ali", startDate: start, salary: "30000" }, { today: start, now: new Date() }));
  const id = state(app).workers[0].id;
  ui(app).press("w-open", { id });
  assert.match(app.field("workersRoot").innerHTML, /Give Advance/);
  assert.match(app.field("workersRoot").innerHTML, /Pay Remaining Salary/);

  for (const amount of [5000, 3000, 4000, 2000]) {
    ui(app).press("w-advance");
    fillTx(app, { amount });
    await ui(app).submitTransaction(false);
    assert.equal(app.errorText("txError"), "");
  }
  assert.equal(state(app).workerTransactions.length, 4);
  let html = app.field("workersRoot").innerHTML;
  assert.match(html, /14,000 DA/, "advances");
  assert.match(html, /16,000 DA/, "remaining payable");

  // Zero and too-large payments are explained and nothing is recorded.
  ui(app).press("w-pay");
  assert.match(app.field("workersRoot").innerHTML, /Amount currently payable/);
  assert.match(app.field("workersRoot").innerHTML, /id="txAmount" value="16000"/, "the payable amount is offered");
  fillTx(app, { amount: 0, periodIndex: 0 });
  await ui(app).submitTransaction(false);
  assert.match(app.errorText("txError"), /greater than zero/);
  fillTx(app, { amount: 16001, periodIndex: 0 });
  await ui(app).submitTransaction(false);
  assert.match(app.errorText("txError"), /16,000 DA/);
  fillTx(app, { amount: 10000, periodIndex: 0 });
  await ui(app).submitTransaction(false);
  assert.equal(state(app).workerTransactions.length, 5);
  html = app.field("workersRoot").innerHTML;
  assert.match(html, /6,000 DA/, "the unpaid part stays owed");

  // Reload: a second copy of the app on the same database.
  const second = await shop({ indexedDB: app.indexedDB });
  assert.equal(state(second).workers.length, 1);
  assert.equal(state(second).workerTransactions.length, 5);
  const calc = Workers.compute(state(second).workers[0], state(second).workerTransactions, today());
  assert.deepEqual([calc.current.advances, calc.current.payments, calc.current.remaining], [14000, 10000, 6000]);
});

test("screens: an advance above the salary says so, shows debt, and a transaction is corrected and deleted from the history", async () => {
  const app = await shop();
  const start = P.addDays(today(), -2);
  await app.api.commit((d) => Workers.addWorker(d, { name: "Bo", startDate: start, salary: "30000" }, { today: start, now: new Date() }));
  const id = state(app).workers[0].id;
  ui(app).press("w-open", { id });
  ui(app).press("w-advance");
  fillTx(app, { amount: 35000, note: "car repair" });
  await ui(app).submitTransaction(false);
  assert.match(app.toast(), /5,000 DA will be carried forward as debt/);
  assert.match(app.field("workersRoot").innerHTML, /car repair/);
  assert.equal(ui(app).calcOf(state(app).workers[0]).debt, 5000);
  // The list shows the debt.
  ui(app).press("w-back");
  assert.match(ui(app).rowsHtml(), /5,000 DA/);
  ui(app).press("w-open", { id });
  const txId = state(app).workerTransactions[0].id;
  ui(app).press("w-tx-edit", { id: txId });
  assert.match(app.field("workersRoot").innerHTML, /Correct the salary advance/);
  fillTx(app, { amount: 20000, note: "car repair (corrected)" });
  await ui(app).submitTransaction(true);
  assert.equal(state(app).workerTransactions[0].amount, 20000);
  assert.equal(ui(app).calcOf(state(app).workers[0]).debt, 0);
  ui(app).press("w-tx-delete", { id: txId });
  assert.match(app.field("workersRoot").innerHTML, /Delete this transaction\?/, "deleting asks first");
  assert.equal(state(app).workerTransactions.length, 1, "asking does not delete");
  await ui(app).press("w-tx-delete-yes", { id: txId });
  assert.equal(state(app).workerTransactions.length, 0);
  assert.equal(ui(app).calcOf(state(app).workers[0]).current.remaining, 30000);
  assert.equal(state(app).workers.length, 1, "the worker and the rest of the history stay");
});

test("screens: marking inactive asks first, keeps the history, and Give Advance is switched off until reactivation", async () => {
  const app = await shop();
  await app.api.commit((d) => Workers.addWorker(d, { name: "Cy", startDate: "2026-01-10", salary: "20000" }, { today: "2026-01-10", now: new Date() }));
  const id = state(app).workers[0].id;
  ui(app).press("w-open", { id });
  ui(app).press("w-status", { status: "inactive" });
  assert.match(app.field("workersRoot").innerHTML, /Mark Cy as inactive/);
  assert.equal(state(app).workers[0].status, "active");
  await ui(app).press("w-status-yes", { status: "inactive" });
  assert.equal(state(app).workers[0].status, "inactive");
  assert.match(app.field("workersRoot").innerHTML, /data-act="w-advance" disabled/);
  assert.match(app.field("workersRoot").innerHTML, /Reactivate/);
});

test("screens: the salary period history shows every period and opens one with its own transactions", async () => {
  const app = await shop();
  await app.api.commit((d) => {
    const w = Workers.addWorker(d, { name: "Di", startDate: "2026-01-05", salary: "30000" }, { today: "2026-01-05", now: new Date() }).worker;
    Workers.addTransaction(d, { workerId: w.id, type: "advance", amount: "40000", date: "2026-01-10" }, { today: "2026-01-10", now: new Date() });
  });
  const id = state(app).workers[0].id;
  ui(app).press("w-open", { id });
  ui(app).press("w-tab", { tab: "periods" });
  const html = app.field("workersRoot").innerHTML;
  assert.match(html, /Debt Carried Forward/);
  assert.match(html, /05\/01\/2026/);
  ui(app).press("w-period", { index: "0" });
  const detail = app.field("workersRoot").innerHTML;
  assert.match(detail, /Available salary/);
  assert.match(detail, /40,000 DA/);
  assert.match(detail, /10\/01\/2026/);
});

test("screens: amounts follow the currency display setting (dinars or centimes)", async () => {
  const app = await shop();
  await app.api.commit((d) => { d.settings = { ...d.settings, currencyUnit: "centimes" }; Workers.addWorker(d, { name: "Ed", startDate: "2026-01-05", salary: "1500" }, { today: "2026-01-05", now: new Date() }); });
  ui(app).draw();
  assert.match(ui(app).rowsHtml(), /150,000 centimes/);
  assert.match(ui(app).stripHtml(), /150,000 centimes/);
  assert.equal(state(app).workers[0].salary, 1500, "stored in dinars, only shown in centimes");
});

test("payroll stays apart from sales, purchases and suppliers", async () => {
  const app = await shop();
  await app.api.commit((d) => {
    const w = Workers.addWorker(d, { name: "Fy", startDate: "2026-01-05", salary: "30000" }, { today: "2026-01-05", now: new Date() }).worker;
    Workers.addTransaction(d, { workerId: w.id, type: "advance", amount: "5000", date: "2026-01-10" }, { today: "2026-01-10", now: new Date() });
  });
  const s = state(app);
  assert.deepEqual([s.invoices.length, s.purchases.length, s.supplierPayments.length, s.supplierDeposits.length, s.suppliers.length], [0, 0, 0, 0, 0]);
  const report = Purchases.moneyOutReport(s, "2026-01-01", "2026-12-31");
  assert.equal(JSON.stringify(report).includes("5000"), false, "an advance is not money paid to a supplier");
});

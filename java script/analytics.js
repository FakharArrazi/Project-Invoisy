"use strict";

/* ==========================================================================
   ANALYTICS - the figures of the Dashboard.

   Pure functions: they read the saved invoices, products, debt ledger and purchases and return numbers. Nothing here touches the
   screen, the database or any stored record. Every figure is calculated from the saved data each time the Dashboard is drawn,
   so nothing can drift out of date and nothing is ever stored twice.

   THE DEFINITIONS (the Dashboard shows these same words, see dash.* in java script/lang/):

   Sales revenue    The sum of `total` of the invoices dated in the period, by the invoice's own date (its local calendar day).
                    `total` is what the invoice sells: products less the discount, plus tax. It is already the figure AFTER any
                    returned goods (a return is an edit of the invoice, so the invoice keeps one total: there is no earlier
                    "gross" figure stored, and none is invented here). Not subtracted: purchase costs, supplier purchases,
                    expenses, unpaid balances. Old debt carried onto an invoice is not revenue (it is not part of `total`).
                    A cancelled invoice is not a sale. A payment is never revenue.
   Money collected  Customer payments recorded in the period, by the PAYMENT's own date, less refunds paid back to customers in
                    the period (by the refund's date). A payment lives on exactly one invoice, so nothing is counted twice, and a
                    payment that settles old debt carried forward is cash received like any other.
   Outstanding      What can still be collected: for each invoice, the same `remaining` the Invoices page shows (amount due, less
                    payments kept, less balance carried to a newer invoice). Cancelled sales, refunds and debt transfers are
                    handled by Validation.paymentDetail, the one place that knows those rules.
   Quantities       Counted from the invoice lines, in the product's own stock unit when the line was sold in another unit of the
                    same kind (boxes <-> pieces <-> m2 through the product's coverage). Different units are NEVER added together:
                    a quantity ranking is one list per unit.
   ========================================================================== */

(function () {
  const V = globalThis.Validation;
  const Calc = globalThis.Calc;
  const Debt = globalThis.Debt;

  const EPS = 0.005;                    // below half a centime an amount is nothing
  const PERIODS = ["7", "30", "month", "12m"];
  const PRODUCT_PERIODS = ["month", "30", "90", "365"];
  const SLOW_PERIODS = ["30", "90"];

  const round2 = (n) => V.round2(n);
  const num = (n) => V.toNumber(n);
  const pad = (n) => String(n).padStart(2, "0");

  /* ---------- Local calendar days ----------
     A day is "YYYY-MM-DD" in the shop's own (local) calendar. Dates are always built from year/month/day parts, never by adding
     24 hours, so a daylight-saving change can not move a day. */

  function dayOf(value) {
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? "" : d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  function parts(day) { const [y, m, d] = String(day).split("-").map(Number); return { y, m, d }; }
  function addDays(day, n) { const { y, m, d } = parts(day); return dayOf(new Date(y, m - 1, d + n)); }
  function monthOf(day) { return String(day).slice(0, 7); }
  function addMonths(month, n) { const { y, m } = parts(month + "-01"); const d = new Date(y, m - 1 + n, 1); return d.getFullYear() + "-" + pad(d.getMonth() + 1); }
  function daysInMonth(month) { const { y, m } = parts(month + "-01"); return new Date(y, m, 0).getDate(); }
  function daysBetween(a, b) { const x = parts(a); const y = parts(b); return Math.round((Date.UTC(y.y, y.m - 1, y.d) - Date.UTC(x.y, x.m - 1, x.d)) / 86400000); }
  const cmpDay = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

  // Percentage change of `now` against `before`, one decimal. null when there is nothing to compare with (before is 0).
  function pctChange(now, before) {
    if (!(before > EPS)) return null;
    return Math.round(((now - before) / before) * 1000) / 10;
  }

  /* ---------- One pass over the invoices ---------- */

  // Every invoice with its payment detail, its local day and its sale value; plus the payments and refunds by day.
  function scan(data) {
    const invoices = Array.isArray(data.invoices) ? data.invoices : [];
    const transfers = Array.isArray(data.debtTransfers) ? data.debtTransfers : [];
    const rows = [];
    const salesByDay = new Map();      // day -> { total, count }       (valid sales only)
    const payByDay = new Map();        // day -> { paid, refunded }
    for (const inv of invoices) {
      if (!inv || typeof inv !== "object") continue;
      const detail = V.paymentDetail(inv, transfers);
      const day = dayOf(inv.date);
      const cancelled = detail.cls === "cancelled";
      const total = round2(num(inv.total));
      rows.push({ inv, detail, day, cancelled, total });
      if (day && !cancelled) {
        const s = salesByDay.get(day) || { total: 0, count: 0 };
        s.total = round2(s.total + total);
        s.count += 1;
        salesByDay.set(day, s);
      }
      for (const p of Array.isArray(inv.payments) ? inv.payments : []) {
        const pd = dayOf(p && p.timestamp) || day;
        const amount = num(p && p.amount);
        if (!pd || !(amount > 0)) continue;
        const e = payByDay.get(pd) || { paid: 0, refunded: 0 };
        e.paid = round2(e.paid + amount);
        payByDay.set(pd, e);
      }
      for (const r of Array.isArray(inv.refunds) ? inv.refunds : []) {
        const rd = dayOf(r && r.timestamp) || dayOf(inv.cancellation && inv.cancellation.at) || day;
        const amount = num(r && r.amount);
        if (!rd || !(amount > 0)) continue;
        const e = payByDay.get(rd) || { paid: 0, refunded: 0 };
        e.refunded = round2(e.refunded + amount);
        payByDay.set(rd, e);
      }
    }
    return { rows, salesByDay, payByDay };
  }

  // Everything that happened between two days (inclusive).
  function rangeTotals(scanned, from, to) {
    let sales = 0; let count = 0; let paid = 0; let refunded = 0;
    for (let d = from; cmpDay(d, to) <= 0; d = addDays(d, 1)) {
      const s = scanned.salesByDay.get(d);
      if (s) { sales += s.total; count += s.count; }
      const p = scanned.payByDay.get(d);
      if (p) { paid += p.paid; refunded += p.refunded; }
    }
    return { sales: round2(sales), count, collected: round2(paid - refunded), paid: round2(paid), refunded: round2(refunded) };
  }

  /* ---------- Periods for the charts ---------- */

  function periodRange(kind, today) {
    if (kind === "7") return { from: addDays(today, -6), to: today };
    if (kind === "30") return { from: addDays(today, -29), to: today };
    if (kind === "month") return { from: monthOf(today) + "-01", to: today };
    const month = monthOf(today);
    const first = addMonths(month, -11);
    return { from: first + "-01", to: today };
  }

  function buildSeries(scanned, kind, today) {
    const range = periodRange(kind, today);
    const buckets = [];
    if (kind === "12m") {
      for (let i = 11; i >= 0; i--) {
        const month = addMonths(monthOf(today), -i);
        const from = month + "-01";
        const to = month + "-" + pad(daysInMonth(month));
        buckets.push({ key: month, from, to, ...rangeTotals(scanned, from, to) });
      }
    } else {
      for (let d = range.from; cmpDay(d, range.to) <= 0; d = addDays(d, 1)) buckets.push({ key: d, from: d, to: d, ...rangeTotals(scanned, d, d) });
    }
    const sum = (field) => round2(buckets.reduce((s, b) => s + b[field], 0));
    return {
      period: kind, from: range.from, to: range.to, buckets,
      sales: sum("sales"), invoices: buckets.reduce((s, b) => s + b.count, 0), collected: sum("collected"), refunded: sum("refunded"),
      empty: buckets.every((b) => b.count === 0 && Math.abs(b.collected) < EPS && b.refunded < EPS),
    };
  }

  // How the invoices of a period are paid: paid / partial / unpaid (and "transferred": settled by moving the balance to a newer invoice).
  function statusMix(scanned, from, to) {
    const out = { count: { paid: 0, partial: 0, unpaid: 0, transferred: 0 }, value: { paid: 0, partial: 0, unpaid: 0, transferred: 0 }, total: 0, valueTotal: 0 };
    for (const r of scanned.rows) {
      if (r.cancelled || !r.day || cmpDay(r.day, from) < 0 || cmpDay(r.day, to) > 0) continue;
      const cls = out.count[r.detail.cls] === undefined ? "unpaid" : r.detail.cls;
      out.count[cls] += 1;
      out.value[cls] = round2(out.value[cls] + r.total);
      out.total += 1;
      out.valueTotal = round2(out.valueTotal + r.total);
    }
    return out;
  }

  /* ---------- Products: what sold ---------- */

  // A line's quantity in the product's own stock unit when it can be converted reliably, otherwise in the unit it was sold in.
  function lineQuantity(product, item) {
    const qty = num(item.qty);
    const from = item.sellingUnit;
    if (product && Calc.isUnit(product.stockUnit) && Calc.isUnit(from)) {
      const f = Calc.getUnitFactor(product, from, product.stockUnit);
      if (!f.error && f.value > 0) return { unit: product.stockUnit, qty: Calc.cleanNumber(qty * f.value) };
    }
    return { unit: Calc.isUnit(from) ? from : "piece", qty: Calc.cleanNumber(qty) };
  }

  function lineRevenue(item) {
    const total = item && item.total;
    if (total !== "" && total != null && Number.isFinite(Number(total))) return round2(Number(total));
    return round2(num(item && item.qty) * num(item && item.unitPrice));
  }

  // What each product sold between two days: { key, productId, name, manufacturer, tileSize, revenue, units: Map(unit -> qty), exists }.
  function productSales(scanned, products, from, to) {
    const byId = new Map((products || []).map((p) => [p.id, p]));
    const map = new Map();
    for (const r of scanned.rows) {
      if (r.cancelled || !r.day || cmpDay(r.day, from) < 0 || cmpDay(r.day, to) > 0) continue;
      for (const item of Array.isArray(r.inv.items) ? r.inv.items : []) {
        if (!item) continue;
        const product = item.productId ? byId.get(item.productId) : null;
        const key = item.productId ? "id:" + item.productId : "n:" + [item.name, item.tileSize, item.manufacturer].join("|");
        const e = map.get(key) || {
          key, productId: item.productId || "", name: (product && product.name) || item.name || "", manufacturer: (product && product.manufacturer) || item.manufacturer || "",
          tileSize: (product && product.tileSize) || item.tileSize || "", revenue: 0, units: new Map(), exists: Boolean(product),
        };
        const q = lineQuantity(product, item);
        e.units.set(q.unit, Calc.cleanNumber((e.units.get(q.unit) || 0) + q.qty));
        e.revenue = round2(e.revenue + lineRevenue(item));
        map.set(key, e);
      }
    }
    return map;
  }

  const unitsOf = (e) => [...e.units.entries()].map(([unit, qty]) => ({ unit, qty }));
  const publicProduct = (e) => ({ productId: e.productId, name: e.name, manufacturer: e.manufacturer, tileSize: e.tileSize, revenue: e.revenue, quantities: unitsOf(e), exists: e.exists });

  function productPeriodRange(kind, today) {
    if (kind === "month") return { from: monthOf(today) + "-01", to: today };
    return { from: addDays(today, -(Number(kind) - 1)), to: today };
  }

  // Best sellers of a period. By revenue (comparable across all products) or by quantity (one list per unit: units are never mixed).
  function bestSelling(scanned, products, kind, today, topN) {
    const range = productPeriodRange(kind, today);
    const sold = [...productSales(scanned, products, range.from, range.to).values()];
    const byRevenue = sold.filter((e) => e.revenue > EPS || e.units.size).sort((a, b) => b.revenue - a.revenue || a.name.localeCompare(b.name)).slice(0, topN).map(publicProduct);
    const unitList = new Map();
    for (const e of sold) for (const [unit, qty] of e.units) {
      if (!(qty > 0)) continue;
      const list = unitList.get(unit) || [];
      list.push({ ...publicProduct(e), qty, unit, quantities: [{ unit, qty }] });
      unitList.set(unit, list);
    }
    const byUnit = [...unitList.entries()].map(([unit, list]) => ({ unit, items: list.sort((a, b) => b.qty - a.qty || b.revenue - a.revenue || a.name.localeCompare(b.name)).slice(0, topN) }))
      .sort((a, b) => b.items.length - a.items.length || a.unit.localeCompare(b.unit));
    return { period: kind, from: range.from, to: range.to, byRevenue, byUnit, empty: sold.length === 0, maxRevenue: byRevenue.length ? byRevenue[0].revenue : 0 };
  }

  // The first day anything is on record for each product: its first sale or first confirmed purchase. The catalogue does not date a
  // product, so this is the only evidence of how long a product has been around.
  function firstSeen(scanned, purchases) {
    const first = new Map();
    const note = (id, day) => { if (id && day && (!first.has(id) || cmpDay(day, first.get(id)) < 0)) first.set(id, day); };
    for (const r of scanned.rows) for (const item of Array.isArray(r.inv.items) ? r.inv.items : []) note(item && item.productId, r.day);
    for (const p of Array.isArray(purchases) ? purchases : []) {
      if (!p || p.status !== "confirmed") continue;
      for (const line of Array.isArray(p.lines) ? p.lines : []) note(line && line.productId, String(p.invoiceDate || "").slice(0, 10));
    }
    return first;
  }

  // Slow-moving stock: products that are in stock and have been on record for longer than the period, ranked by the least they sold.
  // Never judged: a product with no history yet (it may be new), a product with nothing in stock (that is a stock alert, not slow stock).
  function leastSelling(scanned, products, purchases, kind, today, topN) {
    const days = Number(kind);
    const from = addDays(today, -(days - 1));
    const seen = firstSeen(scanned, purchases);
    let oldest = "";
    for (const r of scanned.rows) if (r.day && (!oldest || cmpDay(r.day, oldest) < 0)) oldest = r.day;
    for (const day of seen.values()) if (!oldest || cmpDay(day, oldest) < 0) oldest = day;
    const enoughHistory = Boolean(oldest) && cmpDay(oldest, from) <= 0;       // the shop itself has been running for the whole period
    const sold = productSales(scanned, products, from, today);
    const list = [];
    let noHistory = 0; let noStock = 0; let tooNew = 0;
    for (const p of Array.isArray(products) ? products : []) {
      if (!(num(p.stock) > 0)) { noStock++; continue; }
      const age = seen.get(p.id);
      if (!age) { noHistory++; continue; }
      if (cmpDay(age, from) > 0) { tooNew++; continue; }                          // first seen inside the period: still new
      const s = sold.get("id:" + p.id);
      list.push({
        productId: p.id, name: p.name, manufacturer: p.manufacturer || "", tileSize: p.tileSize || "", stock: num(p.stock), stockUnit: p.stockUnit,
        revenue: s ? s.revenue : 0, quantities: s ? unitsOf(s) : [], sold: Boolean(s), exists: true,
      });
    }
    list.sort((a, b) => a.revenue - b.revenue || b.stock - a.stock || a.name.localeCompare(b.name));
    return { period: kind, from, to: today, items: enoughHistory ? list.slice(0, topN) : [], judged: list.length, zeroSales: list.filter((x) => !x.sold).length, noHistory, noStock, tooNew, enoughHistory };
  }

  /* ---------- Stock ---------- */

  function stockOverview(products, lowStock) {
    const list = Array.isArray(products) ? products : [];
    const alerts = { negative: [], out: [], low: [] };
    const totals = new Map();
    for (const p of list) {
      const stock = num(p.stock);
      const entry = { productId: p.id, name: p.name, manufacturer: p.manufacturer || "", tileSize: p.tileSize || "", stock, stockUnit: p.stockUnit, exists: true };
      if (stock < 0) alerts.negative.push(entry);
      else if (stock <= 0) alerts.out.push(entry);
      else if (stock <= lowStock) alerts.low.push(entry);
      if (stock > 0 && Calc.isUnit(p.stockUnit)) totals.set(p.stockUnit, Calc.cleanNumber((totals.get(p.stockUnit) || 0) + stock));
    }
    const byName = (a, b) => a.name.localeCompare(b.name);
    alerts.negative.sort((a, b) => a.stock - b.stock || byName(a, b));
    alerts.out.sort(byName);
    alerts.low.sort((a, b) => a.stock - b.stock || byName(a, b));
    return {
      products: list.length, outOfStock: alerts.out.length, low: alerts.low.length, negative: alerts.negative.length,
      totals: [...totals.entries()].map(([unit, qty]) => ({ unit, qty })), alerts, lowStock,
    };
  }

  /* ---------- Customers and balances ---------- */

  function outstanding(scanned, data, topN) {
    const transfers = Array.isArray(data.debtTransfers) ? data.debtTransfers : [];
    let total = 0; let invoices = 0;
    for (const r of scanned.rows) if (r.detail.remaining > EPS) { total = round2(total + r.detail.remaining); invoices++; }
    const groups = Debt.directory(Array.isArray(data.invoices) ? data.invoices : [], transfers).filter((g) => g.debt > EPS);
    groups.sort((a, b) => b.debt - a.debt || a.name.localeCompare(b.name));
    const customers = groups.map((g) => {
      const rows = Debt.outstanding(g, transfers).rows;
      return { name: g.name, phone: g.phone || "", debt: g.debt, invoices: g.unpaid, oldest: rows.length ? dayOf(rows[0].invoice.date) : "" };
    });
    const identified = round2(groups.reduce((s, g) => s + g.debt, 0));
    const identifiedInvoices = groups.reduce((s, g) => s + g.unpaid, 0);
    return {
      total, invoices, customers: groups.length, top: customers.slice(0, topN), more: Math.max(0, customers.length - topN),
      unidentifiedTotal: round2(Math.max(0, total - identified)), unidentifiedInvoices: Math.max(0, invoices - identifiedInvoices),
    };
  }

  function recentSales(scanned, n) {
    return scanned.rows.filter((r) => !r.cancelled && r.day)
      .sort((a, b) => cmpDay(b.day, a.day) || String(b.inv.date).localeCompare(String(a.inv.date)) || String(b.inv.invoiceNumber).localeCompare(String(a.inv.invoiceNumber)))
      .slice(0, n)
      .map((r) => {
        const delivery = V.deliveryDetail(r.inv);
        return {
          id: r.inv.id, invoiceNumber: r.inv.invoiceNumber, customer: (r.inv.customer && r.inv.customer.name) || "", date: r.inv.date,
          due: r.detail.due, paid: r.detail.paid, remaining: r.detail.remaining, status: r.detail.cls,
          delivery: delivery.tracked ? delivery.status : "",
        };
      });
  }

  /* ---------- Everything the Dashboard shows ---------- */

  // data: { invoices, products, debtTransfers, purchases }; options: { today ("YYYY-MM-DD"), now (Date), lowStock, period, productPeriod, slowPeriod, topN }
  function compute(data, options) {
    const o = options || {};
    const d = data || {};
    const today = o.today || dayOf(o.now || new Date());
    const period = PERIODS.includes(o.period) ? o.period : "30";
    const productPeriod = PRODUCT_PERIODS.includes(o.productPeriod) ? o.productPeriod : "month";
    const slowPeriod = SLOW_PERIODS.includes(String(o.slowPeriod)) ? String(o.slowPeriod) : "90";
    const topN = o.topN > 0 ? o.topN : 5;
    const lowStock = o.lowStock >= 0 ? o.lowStock : 5;
    const products = Array.isArray(d.products) ? d.products : [];
    const scanned = scan(d);

    const yesterday = addDays(today, -1);
    const month = monthOf(today);
    const monthStart = month + "-01";
    const prevMonth = addMonths(month, -1);
    const prevMonthStart = prevMonth + "-01";
    const prevMonthEnd = prevMonth + "-" + pad(daysInMonth(prevMonth));
    const elapsed = parts(today).d;                                                       // days of this month so far
    const prevSameDay = prevMonth + "-" + pad(Math.min(elapsed, daysInMonth(prevMonth)));  // the same elapsed days last month

    const todayT = rangeTotals(scanned, today, today);
    const yesterdayT = rangeTotals(scanned, yesterday, yesterday);
    const monthT = rangeTotals(scanned, monthStart, today);
    const mtdPrevT = rangeTotals(scanned, prevMonthStart, prevSameDay);
    const prevMonthT = rangeTotals(scanned, prevMonthStart, prevMonthEnd);
    const out = outstanding(scanned, d, 5);
    const stock = stockOverview(products, lowStock);
    const monthMix = statusMix(scanned, monthStart, today);
    const best = bestSelling(scanned, products, productPeriod, today, topN);
    const monthBest = bestSelling(scanned, products, "month", today, 1);

    return {
      today, month, hasData: scanned.rows.length > 0 || products.length > 0,
      cards: {
        today: { sales: todayT.sales, count: todayT.count, yesterday: yesterdayT.sales, yesterdayCount: yesterdayT.count, pct: pctChange(todayT.sales, yesterdayT.sales) },
        month: {
          sales: monthT.sales, count: monthT.count, elapsedDays: elapsed, previousSameDays: mtdPrevT.sales, previousSameDaysCount: mtdPrevT.count,
          pct: pctChange(monthT.sales, mtdPrevT.sales), previousFull: prevMonthT.sales,
        },
        collected: { today: todayT.collected, month: monthT.collected, refundedToday: todayT.refunded, refundedMonth: monthT.refunded },
        outstanding: out,
        invoices: { today: todayT.count, month: monthT.count, byStatus: monthMix.count },
        inventory: stock,
      },
      series: buildSeries(scanned, period, today),
      status: statusMix(scanned, periodRange(period, today).from, today),
      bestSelling: best,
      leastSelling: leastSelling(scanned, products, d.purchases, slowPeriod, today, topN),
      recent: recentSales(scanned, o.recent > 0 ? o.recent : 8),
      alerts: stock.alerts,
      summary: {
        month, today, elapsedDays: elapsed, daysInMonth: daysInMonth(month), previousMonth: prevMonth,
        sales: monthT.sales, previousSameDays: mtdPrevT.sales, diff: round2(monthT.sales - mtdPrevT.sales), pct: pctChange(monthT.sales, mtdPrevT.sales),
        previousFull: prevMonthT.sales, collected: monthT.collected, outstanding: out.total, invoices: monthT.count, previousInvoices: mtdPrevT.count,
        bestProduct: monthBest.byRevenue[0] || null,
      },
    };
  }

  globalThis.Analytics = {
    compute, scan, rangeTotals, buildSeries, statusMix, productSales, bestSelling, leastSelling, stockOverview, outstanding, recentSales, lineQuantity, pctChange,
    dayOf, addDays, addMonths, daysInMonth, daysBetween, monthOf, periodRange,
    PERIODS, PRODUCT_PERIODS, SLOW_PERIODS,
  };
})();

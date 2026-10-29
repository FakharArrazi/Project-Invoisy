"use strict";

/* ==========================================================================
   DASHBOARD - the page Invoisy opens on.

   This file only DRAWS. Every figure comes from Analytics.compute() (analytics.js), which reads the saved invoices, products,
   debt ledger and purchases and changes nothing. The page calls render() whenever it redraws, so the numbers follow every sale,
   payment, return, purchase and stock change (and a change made in another tab, which redraws the page the same way).

   The charts are small hand-written SVG: no library, no network. A bar can be hovered, tapped or reached with the keyboard to
   read its exact figures. What the person chose on screen (periods, modes) is remembered while the page is open and is not saved.
   ========================================================================== */

(function () {
  const A = globalThis.Analytics;
  const Calc = globalThis.Calc;
  let h = null;

  const ui = {
    period: "30",          // sales charts and payment status: "7" | "30" | "month" | "12m"
    productPeriod: "month",// best sellers: "month" | "30" | "90" | "365"
    productMode: "revenue",// best sellers: "revenue" | "quantity"
    slowPeriod: "90",      // slow-moving stock: "30" | "90"
    statusMode: "count",   // payment status: "count" | "value"
    alertsAll: false,      // every stock alert, not only the first few
    focusId: "",           // the control to give focus back to after a redraw
  };

  const ALERTS_SHOWN = 6;
  const BEST_SHOWN = 5;

  const S = () => h.state;
  const t = (key, params) => h.t(key, params);
  const tn = (key, count, params) => h.tn(key, count, params);
  const esc = (v) => h.esc(v);
  const money = (n) => h.money(n);
  const num = (n) => h.numberFormat.format(n);
  const $ = (id) => h.$(id);

  const unitName = (unit, qty) => (Calc.isUnit(unit) ? Calc.unitLabel(unit, qty) : "");
  const qtyText = (qty, unit) => num(qty) + (unit ? " " + unitName(unit, qty) : "");
  const fmtDay = (day) => (day ? String(day).split("-").reverse().join("/") : "");
  const signed = (pct) => (pct === null ? "" : h.ltr((pct > 0 ? "+" : pct < 0 ? "\u2212" : "") + num(Math.abs(pct)) + "%"));
  const sizeText = (size) => (size ? h.formatTileSize(size) : "");
  const meta = (p) => [sizeText(p.tileSize), p.manufacturer].filter(Boolean).map(esc).join(" · ");
  const customerName = (name) => (h.isWalkIn(name) ? t("sell.walkIn") : name);

  function monthName(month, style) {
    const [y, m] = month.split("-").map(Number);
    return new Intl.DateTimeFormat(h.locale(), { month: style || "long", year: style === "short" ? undefined : "numeric" }).format(new Date(y, m - 1, 1));
  }
  const compact = (n) => new Intl.NumberFormat(h.locale(), { notation: "compact", maximumFractionDigits: 1 }).format(n);

  function focusId(id) {
    const el = id && $(id);
    if (el && el.focus) el.focus();
  }

  /* ---------- Small pieces ---------- */

  function deltaHtml(pct, key, noneKey) {
    if (pct === null) return `<span class="dc-delta dc-flat">${esc(t(noneKey))}</span>`;
    const tone = pct > 0 ? "dc-up" : pct < 0 ? "dc-down" : "dc-flat";
    return `<span class="dc-delta ${tone}">${esc(t(key, { pct: signed(pct) }))}</span>`;
  }

  function card(cls, label, value, lines) {
    return `<article class="dc-card ${cls}"><h3>${esc(label)}</h3><div class="dc-value">${value}</div>${lines.filter(Boolean).map((l) => `<div class="dc-line">${l}</div>`).join("")}</article>`;
  }

  function tabs(name, current, options, labelOf) {
    return `<div class="dc-tabs" role="group" aria-label="${esc(t("dash.period"))}">` + options.map((value) =>
      `<button type="button" class="dc-tab" id="dc-${name}-${value}" data-act="dc-${name}" data-v="${value}" aria-pressed="${value === current}">${esc(labelOf(value))}</button>`).join("") + `</div>`;
  }

  const emptyHtml = (text) => `<p class="dc-empty">${esc(text)}</p>`;
  const productLink = (p) => (p.exists && p.productId ? `<button type="button" class="dc-link" data-act="dc-product" data-id="${esc(p.productId)}" aria-label="${esc(t("pi.openStockAria", { name: h.productName(p.name) }))}">${esc(h.productName(p.name))}</button>` : `<span class="dc-name">${esc(h.productName(p.name))}</span>`);

  /* ---------- Summary cards ---------- */

  function cardsHtml(d) {
    const c = d.cards;
    const inv = c.inventory;
    const today = card("dc-today", t("dash.card.today"), esc(money(c.today.sales)), [
      esc(tn("dash.invoicesN", c.today.count)),
      deltaHtml(c.today.pct, "dash.vsYesterday", "dash.noYesterday"),
    ]);
    const month = card("dc-month", t("dash.card.month"), esc(money(c.month.sales)), [
      esc(tn("dash.invoicesN", c.month.count)),
      deltaHtml(c.month.pct, "dash.vsLastMonth", "dash.noLastMonth"),
    ]);
    const collected = card("dc-collected", t("dash.card.collected"), esc(money(c.collected.today)), [
      `<span class="muted">${esc(t("dash.today"))}</span>`,
      `<strong>${esc(money(c.collected.month))}</strong> <span class="muted">${esc(t("dash.thisMonth"))}</span>`,
      c.collected.refundedMonth > 0 ? `<span class="muted small">${esc(t("dash.afterRefunds", { amount: money(c.collected.refundedMonth) }))}</span>` : "",
    ]);
    const o = c.outstanding;
    const owed = card(o.total > 0 ? "dc-owed dc-warn" : "dc-owed", t("dash.card.outstanding"), esc(money(o.total)), [
      o.total > 0 ? esc([tn("dash.unpaidInvoices", o.invoices), tn("dash.customersN", o.customers)].join(" · ")) : `<span class="muted">${esc(t("dash.noOutstanding"))}</span>`,
      o.unidentifiedInvoices > 0 ? `<span class="muted small">${esc(tn("dash.unidentified", o.unidentifiedInvoices, { amount: money(o.unidentifiedTotal) }))}</span>` : "",
    ]);
    const mix = c.invoices.byStatus;
    const chips = ["paid", "partial", "unpaid"].map((k) => `<span class="dc-chip dc-chip-${k}">${esc(t("badge." + k))} <strong>${num(mix[k])}</strong></span>`).join("");
    const invoices = card("dc-invoices", t("dash.card.invoices"), esc(num(c.invoices.today)), [
      `<span class="muted">${esc(t("dash.today"))}</span>`,
      `<strong>${esc(num(c.invoices.month))}</strong> <span class="muted">${esc(t("dash.thisMonth"))}</span>`,
      `<span class="dc-chips">${chips}</span>`,
    ]);
    const problems = inv.outOfStock + inv.low + inv.negative;
    const stockLines = [];
    if (inv.negative) stockLines.push(`<span class="dc-bad">${esc(tn("dash.inv.negative", inv.negative))}</span>`);
    if (inv.outOfStock) stockLines.push(`<span class="dc-bad">${esc(tn("dash.inv.out", inv.outOfStock))}</span>`);
    if (inv.low) stockLines.push(`<span class="dc-warn-text">${esc(tn("dash.inv.low", inv.low, { limit: num(inv.lowStock) }))}</span>`);
    if (!problems && inv.products) stockLines.push(`<span class="muted">${esc(t("dash.inv.fine"))}</span>`);
    // Quantities are only added up inside one unit: boxes with boxes, m² with m².
    if (inv.totals.length) stockLines.push(`<span class="muted small">${esc(t("dash.inv.onHand"))}: ${inv.totals.map((x) => esc(qtyText(x.qty, x.unit))).join(" · ")}</span>`);
    const inventory = card(problems ? "dc-stock dc-warn" : "dc-stock", t("dash.card.inventory"), esc(tn("dash.productsN", inv.products)), stockLines);
    return `<div class="dc-cards">${today}${month}${collected}${owed}${invoices}${inventory}</div>`;
  }

  /* ---------- Charts ---------- */

  function niceMax(value) {
    if (!(value > 0)) return 1;
    const pow = Math.pow(10, Math.floor(Math.log10(value)));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= value) return m * pow;
    return 10 * pow;
  }

  function bucketLabel(b, kind, index) {
    if (kind === "12m") return monthName(b.key, "short");
    const day = Number(b.key.slice(8));
    const first = index === 0 || day === 1;
    return first ? day + " " + monthName(b.key.slice(0, 7), "short") : String(day);
  }
  const bucketTitle = (b, kind) => (kind === "12m" ? monthName(b.key) : fmtDay(b.key));

  // Bars (one series: sales) or pairs of bars (sales and money collected) over the buckets of a period.
  function chartSvg(series, two) {
    const W = 640; const H = 230; const L = 46; const R = 6; const T = 10; const B = 28;
    const iw = W - L - R; const ih = H - T - B;
    const b = series.buckets;
    const max = niceMax(Math.max(0, ...b.flatMap((x) => (two ? [x.sales, x.collected] : [x.sales]))));
    const y = (v) => T + ih - (Math.max(0, v) / max) * ih;
    const group = iw / b.length;
    const barW = Math.max(2, Math.min(two ? group * 0.36 : group * 0.64, 36));
    const step = Math.ceil(b.length / 8);
    let svg = `<svg class="dc-svg" viewBox="0 0 ${W} ${H}" role="group" aria-label="${esc(t(two ? "dash.vs.title" : "dash.sales.title"))}" preserveAspectRatio="xMidYMid meet">`;
    for (let i = 0; i <= 4; i++) {
      const v = (max / 4) * i; const yy = y(v);
      svg += `<line class="dc-grid" x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}"/><text class="dc-axis" x="${L - 6}" y="${yy + 3.5}" text-anchor="end">${esc(compact(v))}</text>`;
    }
    b.forEach((x, i) => {
      const cx = L + group * i + group / 2;
      const detail = two
        ? t("dash.detail.both", { date: bucketTitle(x, series.period), sales: money(x.sales), collected: money(x.collected) })
        : t("dash.detail.sales", { date: bucketTitle(x, series.period), sales: money(x.sales), invoices: tn("dash.invoicesN", x.count) });
      svg += `<g class="dc-bar" tabindex="0" role="img" aria-label="${esc(detail)}" data-detail="${esc(detail)}">` +
        `<rect class="dc-hit" x="${cx - group / 2}" y="${T}" width="${group}" height="${ih}"/>`;
      if (two) {
        svg += `<rect class="dc-b-sales" x="${cx - barW - 0.5}" y="${y(x.sales)}" width="${barW}" height="${T + ih - y(x.sales)}" rx="2"/>` +
          `<rect class="dc-b-paid" x="${cx + 0.5}" y="${y(x.collected)}" width="${barW}" height="${T + ih - y(x.collected)}" rx="2"/>`;
      } else {
        svg += `<rect class="dc-b-sales" x="${cx - barW / 2}" y="${y(x.sales)}" width="${barW}" height="${T + ih - y(x.sales)}" rx="2"/>`;
      }
      svg += `</g>`;
      if (i % step === 0 || i === b.length - 1 && series.period === "12m") svg += `<text class="dc-axis" x="${cx}" y="${H - 8}" text-anchor="middle">${esc(bucketLabel(x, series.period, i))}</text>`;
    });
    return svg + `</svg>`;
  }

  function periodTabs() {
    return tabs("period", ui.period, A.PERIODS, (v) => t("dash.period." + v));
  }

  function salesPanel(d) {
    const s = d.series;
    const summary = `${esc(money(s.sales))} <span class="muted">· ${esc(tn("dash.invoicesN", s.invoices))} · ${esc(t(s.period === "12m" ? "dash.by.month" : "dash.by.day"))}</span>`;
    return `<section class="panel dc-panel dc-wide" aria-labelledby="dc-sales-title">` +
      `<div class="dc-head"><div><h2 id="dc-sales-title">${esc(t("dash.sales.title"))}</h2><p class="dc-sum">${summary}</p></div>${periodTabs()}</div>` +
      (s.empty
        ? emptyHtml(t("dash.chart.empty"))
        : `<div class="dc-chart">${chartSvg(s, false)}<p class="dc-detail" aria-live="polite">${esc(t("dash.detail.hint"))}</p></div>`) +
      `</section>`;
  }

  function versusPanel(d) {
    const s = d.series;
    const legend = `<span class="dc-key"><i class="dc-swatch dc-s-sales"></i>${esc(t("dash.vs.sales"))} <strong>${esc(money(s.sales))}</strong></span>` +
      `<span class="dc-key"><i class="dc-swatch dc-s-paid"></i>${esc(t("dash.vs.collected"))} <strong>${esc(money(s.collected))}</strong></span>`;
    return `<section class="panel dc-panel dc-wide" aria-labelledby="dc-vs-title">` +
      `<div class="dc-head"><div><h2 id="dc-vs-title">${esc(t("dash.vs.title"))}</h2><p class="dc-sum">${legend}</p></div></div>` +
      (s.empty
        ? emptyHtml(t("dash.chart.empty"))
        : `<div class="dc-chart">${chartSvg(s, true)}<p class="dc-detail" aria-live="polite">${esc(t("dash.detail.hint"))}</p></div>`) +
      `<p class="muted small dc-note">${esc(t("dash.vs.note"))}</p></section>`;
  }

  function statusPanel(d) {
    const st = d.status;
    const mode = ui.statusMode;
    const keys = ["paid", "partial", "unpaid", "transferred"].filter((k) => k !== "transferred" || st.count.transferred > 0);
    const total = mode === "count" ? st.total : st.valueTotal;
    const body = total <= 0
      ? emptyHtml(t("dash.chart.empty"))
      : `<div class="dc-stack" role="img" aria-label="${esc(t("dash.status.title"))}">` + keys.filter((k) => (mode === "count" ? st.count[k] : st.value[k]) > 0).map((k) => {
        const v = mode === "count" ? st.count[k] : st.value[k];
        return `<span class="dc-seg dc-seg-${k}" style="width:${Math.max(1.5, (v / total) * 100)}%"></span>`;
      }).join("") + `</div>` +
      `<ul class="dc-legend">` + keys.map((k) => {
        const v = mode === "count" ? st.count[k] : st.value[k];
        const pct = total > 0 ? Math.round((v / total) * 1000) / 10 : 0;
        return `<li><i class="dc-swatch dc-seg-${k}"></i><span>${esc(t("badge." + k))}</span><strong>${esc(mode === "count" ? num(v) : money(v))}</strong><span class="muted">${esc(num(pct))}%</span></li>`;
      }).join("") + `</ul>`;
    const toggle = `<div class="dc-tabs" role="group" aria-label="${esc(t("dash.status.title"))}">` + ["count", "value"].map((v) =>
      `<button type="button" class="dc-tab" id="dc-status-${v}" data-act="dc-status" data-v="${v}" aria-pressed="${v === mode}">${esc(t("dash.status." + v))}</button>`).join("") + `</div>`;
    return `<section class="panel dc-panel" aria-labelledby="dc-status-title">` +
      `<div class="dc-head"><div><h2 id="dc-status-title">${esc(t("dash.status.title"))}</h2><p class="dc-sum muted">${esc(t(mode === "count" ? "dash.status.noteCount" : "dash.status.noteValue", { period: t("dash.period." + ui.period).toLowerCase() }))}</p></div>${toggle}</div>` +
      body + `</section>`;
  }

  function summaryPanel(d) {
    const s = d.summary;
    const rows = [
      [t("dash.sum.sales"), money(s.sales)],
      [t("dash.sum.prevSame"), money(s.previousSameDays)],
      [t("dash.sum.diff"), (s.diff > 0 ? "+" : s.diff < 0 ? "\u2212" : "") + money(Math.abs(s.diff)) + (s.pct === null ? "" : " (" + signed(s.pct) + ")"), s.diff > 0 ? "dc-up" : s.diff < 0 ? "dc-down" : ""],
      [t("dash.sum.prevFull"), money(s.previousFull)],
      [t("dash.sum.collected"), money(s.collected)],
      [t("dash.sum.outstanding"), money(s.outstanding)],
      [t("dash.sum.invoices"), num(s.invoices)],
    ];
    if (s.bestProduct) rows.push([t("dash.sum.best"), h.productName(s.bestProduct.name)]);
    return `<section class="panel dc-panel" aria-labelledby="dc-sum-title"><div class="dc-head"><div><h2 id="dc-sum-title">${esc(t("dash.sum.title"))}</h2>` +
      `<p class="dc-sum muted">${esc(monthName(s.month))}</p></div></div>` +
      `<dl class="dc-dl">${rows.map(([k, v, cls]) => `<div><dt>${esc(k)}</dt><dd class="${cls || ""}">${esc(v)}</dd></div>`).join("")}</dl>` +
      `<p class="muted small dc-note">${esc(t("dash.sum.note", { days: s.elapsedDays, month: monthName(s.previousMonth) }))}</p></section>`;
  }

  /* ---------- Products ---------- */

  function bestPanel(d) {
    const b = d.bestSelling;
    const tabsHtml = tabs("pperiod", ui.productPeriod, A.PRODUCT_PERIODS, (v) => t("dash.pp." + v));
    const mode = `<div class="dc-tabs" role="group" aria-label="${esc(t("dash.best.title"))}">` + ["revenue", "quantity"].map((v) =>
      `<button type="button" class="dc-tab" id="dc-pmode-${v}" data-act="dc-pmode" data-v="${v}" aria-pressed="${v === ui.productMode}">${esc(t("dash.mode." + v))}</button>`).join("") + `</div>`;
    const bar = (value, max) => `<span class="dc-meter" aria-hidden="true"><i style="width:${max > 0 ? Math.max(3, (value / max) * 100) : 0}%"></i></span>`;
    let body;
    if (b.empty) body = emptyHtml(t("dash.best.empty"));
    else if (ui.productMode === "revenue") {
      body = `<ol class="dc-rank">` + b.byRevenue.slice(0, BEST_SHOWN).map((p, i) =>
        `<li><span class="dc-pos">${i + 1}</span><div class="dc-main">${productLink(p)}<div class="muted small">${meta(p)}</div>${bar(p.revenue, b.maxRevenue)}</div>` +
        `<div class="dc-figs"><strong>${esc(money(p.revenue))}</strong><span class="muted small">${p.quantities.map((q) => esc(qtyText(q.qty, q.unit))).join(" + ")}</span></div></li>`).join("") + `</ol>`;
    } else {
      body = b.byUnit.map((g) => {
        const max = g.items.length ? g.items[0].qty : 0;
        return `<h3 class="dc-unit">${esc(unitName(g.unit, 2))}</h3><ol class="dc-rank">` + g.items.slice(0, BEST_SHOWN).map((p, i) =>
          `<li><span class="dc-pos">${i + 1}</span><div class="dc-main">${productLink(p)}<div class="muted small">${meta(p)}</div>${bar(p.qty, max)}</div>` +
          `<div class="dc-figs"><strong>${esc(qtyText(p.qty, g.unit))}</strong><span class="muted small">${esc(money(p.revenue))}</span></div></li>`).join("") + `</ol>`;
      }).join("") + (b.byUnit.length > 1 ? `<p class="muted small dc-note">${esc(t("dash.best.unitNote"))}</p>` : "");
    }
    return `<section class="panel dc-panel" aria-labelledby="dc-best-title"><div class="dc-head"><div><h2 id="dc-best-title">${esc(t("dash.best.title"))}</h2>` +
      `<p class="dc-sum muted">${esc(fmtDay(b.from))} – ${esc(fmtDay(b.to))}</p></div><div class="dc-controls">${tabsHtml}${mode}</div></div>${body}</section>`;
  }

  function slowPanel(d) {
    const s = d.leastSelling;
    const tabsHtml = tabs("slow", ui.slowPeriod, A.SLOW_PERIODS, (v) => t("dash.slow.period." + v));
    let body;
    if (!s.enoughHistory) body = emptyHtml(t("dash.slow.noHistory", { days: s.period }));
    else if (!s.items.length) body = emptyHtml(t(s.judged ? "dash.slow.allGood" : "dash.slow.none", { days: s.period }));
    else {
      body = `<div class="table-wrap"><table class="table dc-table"><thead><tr><th scope="col">${esc(t("dash.col.product"))}</th><th class="num" scope="col">${esc(t("dash.col.sold"))}</th>` +
        `<th class="num" scope="col">${esc(t("dash.col.revenue"))}</th><th class="num" scope="col">${esc(t("dash.col.stock"))}</th></tr></thead><tbody>` +
        s.items.map((p) => `<tr><td>${productLink(p)}<div class="muted small">${meta(p)}</div></td>` +
          `<td class="num">${p.sold ? p.quantities.map((q) => esc(qtyText(q.qty, q.unit))).join(" + ") : `<span class="dc-zero">${esc(t("dash.slow.zero"))}</span>`}</td>` +
          `<td class="num">${esc(money(p.revenue))}</td><td class="num">${esc(qtyText(p.stock, p.stockUnit))}</td></tr>`).join("") + `</tbody></table></div>`;
    }
    const notes = [];
    if (s.enoughHistory && s.noHistory + s.tooNew > 0) notes.push(tn("dash.slow.notJudged", s.noHistory + s.tooNew));
    if (s.enoughHistory) notes.push(t("dash.slow.noStockNote"));
    return `<section class="panel dc-panel" aria-labelledby="dc-slow-title"><div class="dc-head"><div><h2 id="dc-slow-title">${esc(t("dash.slow.title"))}</h2>` +
      `<p class="dc-sum muted">${esc(t("dash.slow.sub", { days: s.period }))}</p></div>${tabsHtml}</div>${body}` +
      notes.map((n) => `<p class="muted small dc-note">${esc(n)}</p>`).join("") + `</section>`;
  }

  /* ---------- Invoices, customers, stock ---------- */

  function recentPanel(d) {
    const head = `<div class="dc-head"><div><h2 id="dc-recent-title">${esc(t("dash.recent.title"))}</h2></div>` +
      `<button type="button" class="btn small" data-act="dc-invoices">${esc(t("dash.recent.viewAll"))}</button></div>`;
    if (!d.recent.length) return `<section class="panel dc-panel dc-wide" aria-labelledby="dc-recent-title">${head}${emptyHtml(t("dash.recent.empty"))}</section>`;
    const rows = d.recent.map((r) => {
      const label = t({ paid: "badge.paid", partial: "badge.partial", unpaid: "badge.unpaid", transferred: "badge.transferred" }[r.status] || "badge.unpaid");
      const delivery = r.delivery ? `<div class="status-line"><span class="badge ${{ complete: "dl-received", partial: "dl-partial", pending: "dl-pending" }[r.delivery]}">${esc(t("badge.delivery." + r.delivery))}</span></div>` : "";
      return `<tr data-act="dc-invoice" data-id="${esc(r.id)}" class="dc-click"><td><button type="button" class="dc-link" data-act="dc-invoice" data-id="${esc(r.id)}" aria-label="${esc(t("invoices.actionAria", { action: t("invoices.view"), number: r.invoiceNumber }))}">${esc(r.invoiceNumber)}</button></td>` +
        `<td>${esc(customerName(r.customer))}</td><td>${esc(h.formatDateTime(r.date))}</td>` +
        `<td class="num">${esc(money(r.due))}</td><td class="num">${esc(money(r.paid))}</td><td class="num">${esc(money(r.remaining))}</td>` +
        `<td><span class="badge ${r.status}">${esc(label)}</span>${delivery}</td></tr>`;
    }).join("");
    return `<section class="panel dc-panel dc-wide" aria-labelledby="dc-recent-title">${head}<div class="table-wrap"><table class="table dc-table"><thead><tr>` +
      `<th scope="col">${esc(t("dash.col.invoice"))}</th><th scope="col">${esc(t("dash.col.customer"))}</th><th scope="col">${esc(t("dash.col.date"))}</th>` +
      `<th class="num" scope="col">${esc(t("dash.col.total"))}</th><th class="num" scope="col">${esc(t("dash.col.paid"))}</th><th class="num" scope="col">${esc(t("dash.col.remaining"))}</th>` +
      `<th scope="col">${esc(t("dash.col.status"))}</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  }

  function owingPanel(d) {
    const o = d.cards.outstanding;
    const head = `<div class="dc-head"><div><h2 id="dc-owing-title">${esc(t("dash.owing.title"))}</h2>` +
      `<p class="dc-sum">${esc(money(o.total))}</p></div></div>`;
    if (!o.top.length && o.total <= 0) return `<section class="panel dc-panel" aria-labelledby="dc-owing-title">${head}${emptyHtml(t("dash.owing.empty"))}</section>`;
    const rows = o.top.map((c) => `<tr><td>${esc(c.name)}</td><td class="num">${esc(num(c.invoices))}</td><td class="num"><strong>${esc(money(c.debt))}</strong></td>` +
      `<td class="num">${esc(fmtDay(c.oldest))}</td><td class="num"><button type="button" class="btn small" data-act="dc-customer" data-name="${esc(c.name)}" aria-label="${esc(t("dash.owing.openAria", { name: c.name }))}">${esc(t("dash.owing.open"))}</button></td></tr>`).join("");
    return `<section class="panel dc-panel" aria-labelledby="dc-owing-title">${head}` +
      (o.top.length ? `<div class="table-wrap"><table class="table dc-table"><thead><tr><th scope="col">${esc(t("dash.col.customer"))}</th><th class="num" scope="col">${esc(t("dash.col.invoices"))}</th>` +
        `<th class="num" scope="col">${esc(t("dash.col.balance"))}</th><th class="num" scope="col">${esc(t("dash.col.oldest"))}</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : "") +
      (o.more > 0 ? `<p class="muted small dc-note">${esc(tn("dash.owing.more", o.more))}</p>` : "") +
      (o.unidentifiedInvoices > 0 ? `<p class="muted small dc-note">${esc(tn("dash.unidentified", o.unidentifiedInvoices, { amount: money(o.unidentifiedTotal) }))}</p>` : "") +
      `</section>`;
  }

  function alertsPanel(d) {
    const a = d.alerts;
    const all = [
      ...a.negative.map((p) => ({ ...p, kind: "negative" })),
      ...a.out.map((p) => ({ ...p, kind: "out" })),
      ...a.low.map((p) => ({ ...p, kind: "low" })),
    ];
    const shown = ui.alertsAll ? all : all.slice(0, ALERTS_SHOWN);
    const head = `<div class="dc-head"><div><h2 id="dc-alerts-title">${esc(t("dash.alerts.title"))}</h2>` +
      `<p class="dc-sum muted">${esc(t("dash.alerts.sub", { limit: num(d.cards.inventory.lowStock) }))}</p></div>` +
      `<button type="button" class="btn small" data-act="dc-stock">${esc(t("dash.alerts.openStock"))}</button></div>`;
    if (!all.length) return `<section class="panel dc-panel" aria-labelledby="dc-alerts-title">${head}${emptyHtml(t("dash.alerts.empty", { limit: num(d.cards.inventory.lowStock) }))}</section>`;
    const rows = shown.map((p) => `<li class="dc-alert dc-alert-${p.kind}"><div class="dc-main">${productLink(p)}<div class="muted small">${meta(p)}</div></div>` +
      `<div class="dc-figs"><strong>${esc(qtyText(p.stock, p.stockUnit))}</strong><span class="dc-tag dc-tag-${p.kind}">${esc(t("dash.alerts." + p.kind))}</span></div></li>`).join("");
    return `<section class="panel dc-panel" aria-labelledby="dc-alerts-title">${head}<ul class="dc-alerts">${rows}</ul>` +
      (all.length > ALERTS_SHOWN ? `<div class="dc-more"><button type="button" class="btn small" id="dc-alerts-all" data-act="dc-alerts-all" aria-expanded="${ui.alertsAll}">${esc(ui.alertsAll ? t("dash.alerts.showLess") : t("dash.alerts.showAll", { n: all.length }))}</button></div>` : "") +
      `</section>`;
  }

  /* ---------- The page ---------- */

  function render() {
    if (!h || S().view !== "dashboard") return;
    const root = $("analyticsRoot");
    if (!root) return;
    const data = A.compute(
      { invoices: S().invoices, products: S().products, debtTransfers: S().debtTransfers, purchases: S().purchases },
      { now: h.now(), lowStock: h.lowStock, period: ui.period, productPeriod: ui.productPeriod, slowPeriod: ui.slowPeriod, topN: BEST_SHOWN },
    );
    root.innerHTML = cardsHtml(data) +
      `<div class="dc-row dc-row-main">${salesPanel(data)}${statusPanel(data)}</div>` +
      `<div class="dc-row dc-row-main">${versusPanel(data)}${summaryPanel(data)}</div>` +
      `<div class="dc-row dc-row-even">${bestPanel(data)}${slowPanel(data)}</div>` +
      `<div class="dc-row dc-row-one">${recentPanel(data)}</div>` +
      `<div class="dc-row dc-row-even">${owingPanel(data)}${alertsPanel(data)}</div>`;
    focusId(ui.focusId);
    ui.focusId = "";
  }

  /* ---------- Clicks ---------- */

  const actions = {
    "dc-period"(el) { if (A.PERIODS.includes(el.dataset.v)) { ui.period = el.dataset.v; ui.focusId = "dc-period-" + el.dataset.v; } },
    "dc-pperiod"(el) { if (A.PRODUCT_PERIODS.includes(el.dataset.v)) { ui.productPeriod = el.dataset.v; ui.focusId = "dc-pperiod-" + el.dataset.v; } },
    "dc-pmode"(el) { if (["revenue", "quantity"].includes(el.dataset.v)) { ui.productMode = el.dataset.v; ui.focusId = "dc-pmode-" + el.dataset.v; } },
    "dc-slow"(el) { if (A.SLOW_PERIODS.includes(el.dataset.v)) { ui.slowPeriod = el.dataset.v; ui.focusId = "dc-slow-" + el.dataset.v; } },
    "dc-status"(el) { if (["count", "value"].includes(el.dataset.v)) { ui.statusMode = el.dataset.v; ui.focusId = "dc-status-" + el.dataset.v; } },
    "dc-alerts-all"() { ui.alertsAll = !ui.alertsAll; ui.focusId = "dc-alerts-all"; },
    "dc-product"(el) { h.openProductInStock(el.dataset.id); return false; },
    "dc-invoice"(el) { h.viewInvoice(el.dataset.id); return false; },
    "dc-invoices"() { h.showView("invoices"); return false; },
    "dc-stock"() { h.showView("stock"); return false; },
    "dc-customer"(el) { h.showInvoicesFor(el.dataset.name); return false; },
  };

  // Reading the figures of a bar: hover, focus or tap shows them under the chart (nothing is redrawn).
  function showDetail(e) {
    const bar = e.target && e.target.closest && e.target.closest(".dc-bar");
    if (!bar) return;
    const box = bar.closest(".dc-chart");
    const line = box && box.querySelector(".dc-detail");
    if (line) line.textContent = bar.dataset.detail;
    box.querySelectorAll(".dc-bar.is-on").forEach((x) => x.classList.remove("is-on"));
    bar.classList.add("is-on");
  }

  function onClick(e) {
    showDetail(e);
    const el = e.target && e.target.closest && e.target.closest("[data-act]");
    if (!el || !actions[el.dataset.act]) return;
    if (el.tagName === "BUTTON") e.preventDefault();
    if (actions[el.dataset.act](el) !== false) render();
  }

  function init(hooks) { h = hooks; }

  function bind() {
    const root = $("analyticsRoot");
    if (!root) return;
    root.addEventListener("click", onClick);
    root.addEventListener("mouseover", showDetail);
    root.addEventListener("focusin", showDetail);
  }

  globalThis.Dashboard = { init, bind, render, state: ui };
})();

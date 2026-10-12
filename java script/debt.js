"use strict";

/* ==========================================================================
   Debt - recognizing a returning customer, finding what they still owe, and preparing the part of it
   that is carried forward onto a new sale.

   Plain script (no modules, so index.html still works when opened directly). No DOM and no storage: pure
   functions over the invoices and the debt-transfer ledger, so the Sell page, the tests and the database
   rules all share exactly the same arithmetic. Loaded after validation.js (the data rules live there:
   balances, customer identity, the ledger check) and before database.js and script.js.

   How a debt moves (the accounting model, in short)
     - Nothing about an old invoice is ever edited. Its total and its payments stay as issued.
     - Carrying INV-000021's unpaid 1,000 DA onto a new invoice writes ONE ledger record (a "debt transfer") and
       puts a "carried forward" line on the new invoice. From then on the 1,000 DA is collectible on the NEW
       invoice only: the old invoice's collectible balance is   amount due - payments - transferred out.
     - Payments are never split or copied; how a payment on the new invoice is shared between the carried debt
       and the new purchase is calculated (oldest debt first), see Validation.carriedBreakdown.
   ========================================================================== */

(function () {
  const V = globalThis.Validation;
  const t = (key, params) => I18n.t(key, params);

  const MIN_CHARS = 2;            // letters needed before suggestions are offered
  const MAX_SUGGESTIONS = 6;
  const MAX_CANDIDATES = 5;
  const EPS = 0.005;              // half a cent: below this a balance counts as nothing

  /* ---------- What a customer owes ---------- */

  // The unpaid invoices of one customer group (see Validation.customerGroups), oldest first, with what can
  // still be collected on each. Every unpaid amount appears once: money already carried to a newer invoice
  // is collectible there and no longer here.
  function outstanding(group, transfers) {
    const rows = [];
    for (const invoice of group.invoices) {
      const pay = V.paymentDetail(invoice, transfers);
      if (pay.remaining > EPS) {
        rows.push({ invoice, due: pay.due, paid: pay.paid, transferred: pay.transferredOut, available: pay.remaining });
      }
    }
    return { rows, count: rows.length, total: V.round2(rows.reduce((sum, row) => sum + row.available, 0)) };
  }

  // Every known customer with what they owe: the groups of Validation.customerGroups plus { debt, unpaid }.
  function directory(invoices, transfers) {
    return V.customerGroups(invoices).map((group) => {
      const owed = outstanding(group, transfers);
      return { ...group, debt: owed.total, unpaid: owed.count };
    });
  }

  /* ---------- Finding the customer ---------- */

  // Customers whose name (or phone number) matches what is being typed, best first. Used for the suggestion list.
  function suggest(query, dir, limit) {
    const q = V.normalizeName(query);
    const digits = String(query == null ? "" : query).replace(/\D/g, "");
    if (q.length < MIN_CHARS && digits.length < 3) return [];
    const terms = q.split(" ").filter(Boolean);
    const scored = [];
    for (const group of dir) {
      const name = V.normalizeName(group.name);
      const phone = V.phoneDigits(group.phone);
      let score = null;
      if (terms.length && terms.every((term) => name.includes(term))) {
        score = name.startsWith(q) ? 0 : name.split(" ").some((w) => w.startsWith(terms[0])) ? 1 : 2;
      } else if (digits.length >= 3 && phone.includes(digits)) {
        score = 3;
      }
      if (score !== null) scored.push({ group, score });
    }
    scored.sort((a, b) => a.score - b.score || (b.group.debt > 0) - (a.group.debt > 0) || String(b.group.lastDate).localeCompare(String(a.group.lastDate)));
    return scored.slice(0, limit || MAX_SUGGESTIONS).map((s) => s.group);
  }

  // The identity of the customer on the sale. { status, group?, candidates? }
  //   "none"       no name, or the walk-in name: there is no reliable identity, so no debt is ever looked up.
  //   "confirmed"  the person picked this customer from the list (and the name and phone still say the same), or
  //                the name AND phone number are exactly those of one known customer (an id match is the same thing).
  //   "choose"     several or weaker matches (a similar name, the same phone under another name, a name with no
  //                phone). Nothing is assumed: the person has to pick the right one.
  // identity is what was remembered when the person picked: { key, name, phone } (normalized).
  function resolve(customer, dir, identity) {
    const c = customer || {};
    const name = V.normalizeName(c.name);
    const phone = V.phoneDigits(c.phone);
    if (V.isWalkInName(name)) return { status: "none" };

    if (identity && identity.name === name && identity.phone === phone) {
      const picked = V.findGroup(dir, identity.key);
      if (picked) return { status: "confirmed", group: picked, how: "selected" };
    }
    const keys = V.customerKeys(c);
    const exact = keys.find((k) => k.startsWith("np:"));
    if (exact) {
      const group = V.findGroup(dir, exact);
      if (group) return { status: "confirmed", group, how: "exact" };
    }
    if (c.id) {
      const group = V.findGroup(dir, "id:" + c.id);
      if (group) return { status: "confirmed", group, how: "id" };
    }

    const terms = name.split(" ").filter(Boolean);
    const candidates = dir.filter((group) => {
      const groupName = V.normalizeName(group.name);
      const groupPhone = V.phoneDigits(group.phone);
      return groupName === name || (phone && groupPhone === phone) || (name.length >= MIN_CHARS && terms.every((term) => groupName.includes(term)));
    });
    candidates.sort((a, b) => (b.debt > 0) - (a.debt > 0) || String(b.lastDate).localeCompare(String(a.lastDate)));
    return candidates.length ? { status: "choose", candidates: candidates.slice(0, MAX_CANDIDATES) } : { status: "none" };
  }

  // What to remember when the person picks a customer, so the choice holds until they change the name or phone.
  function identityOf(group, customer) {
    return { key: group.keys[0], name: V.normalizeName(customer.name), phone: V.phoneDigits(customer.phone) };
  }

  // The customer id for a new invoice: the id the customer already has, or a new one when a returning customer is
  // confirmed. A brand new customer gets none (nothing to recognize them by yet).
  function customerIdFor(resolved) {
    if (!resolved || resolved.status !== "confirmed") return "";
    return resolved.group.ids[0] || "cust-" + V.uid();
  }

  /* ---------- The debt on the sale being prepared ----------
     A draft is a plain list: [{ sourceInvoiceId, amount }], one entry per older invoice. It lives with the sale on
     screen and is only written to the database, together with the invoice, when the sale is completed.
     ctx is { invoices, transfers, group, money } where group is the confirmed customer's group. */

  const draftTotal = (draft) => V.round2((draft || []).reduce((sum, d) => sum + V.toNumber(d.amount), 0));

  // "" when this amount of this older invoice may be carried onto the sale, otherwise the reason it may not.
  function allocationProblem(allocation, ctx) {
    const invoice = ctx.invoices.find((i) => i.id === allocation.sourceInvoiceId);
    if (!invoice) return t("debt.invoiceGone");
    const number = invoice.invoiceNumber;
    const raw = Number(allocation.amount);
    if (allocation.amount === "" || allocation.amount === null || !Number.isFinite(raw) || V.round2(raw) <= 0) return t("debt.amountPositive", { number });
    if (!ctx.group || !ctx.group.invoices.some((i) => i.id === invoice.id)) return t("debt.otherCustomer", { number });
    const pay = V.paymentSummary(invoice, ctx.transfers);
    if (pay.remaining <= EPS) return t(pay.cls === "transferred" ? "debt.alreadyTransferred" : "debt.alreadyPaid", { number });
    if (V.round2(raw) > pay.remaining + EPS) return t("debt.tooMuch", { number, available: (ctx.money || String)(pay.remaining) });
    return "";
  }

  // Adds amounts to the draft. All or nothing: { draft } or { error }. A balance can only be added once;
  // to change the amount, remove it and add it again.
  function addToDraft(draft, picks, ctx) {
    const next = [...(draft || [])];
    for (const pick of picks) {
      const invoice = ctx.invoices.find((i) => i.id === pick.sourceInvoiceId);
      if (next.some((d) => d.sourceInvoiceId === pick.sourceInvoiceId)) return { error: t("debt.alreadyAdded", { number: invoice ? invoice.invoiceNumber : "?" }) };
      const problem = allocationProblem(pick, ctx);
      if (problem) return { error: problem };
      next.push({ sourceInvoiceId: pick.sourceInvoiceId, amount: V.round2(Number(pick.amount)) });
    }
    return { draft: next };
  }

  const removeFromDraft = (draft, sourceInvoiceId) => (draft || []).filter((d) => d.sourceInvoiceId !== sourceInvoiceId);

  // The draft against the data as it is NOW (a payment may have been recorded, another window may have saved).
  // Amounts that are no longer available are lowered or removed, and each change is reported.
  function syncDraft(draft, ctx) {
    const kept = [];
    const notes = [];
    for (const d of draft || []) {
      const invoice = ctx.invoices.find((i) => i.id === d.sourceInvoiceId);
      if (!invoice || !ctx.group || !ctx.group.invoices.some((i) => i.id === invoice.id)) {
        notes.push(t("debt.noLongerAvailable", { number: invoice ? invoice.invoiceNumber : "?" }));
        continue;
      }
      const available = V.paymentSummary(invoice, ctx.transfers).remaining;
      if (available <= EPS) {
        notes.push(t("debt.noLongerOwed", { number: invoice.invoiceNumber }));
      } else if (V.round2(d.amount) > available + EPS) {
        kept.push({ sourceInvoiceId: d.sourceInvoiceId, amount: available });
        notes.push(t("debt.reduced", { number: invoice.invoiceNumber, amount: (ctx.money || String)(available) }));
      } else {
        kept.push(d);
      }
    }
    return { draft: kept, notes };
  }

  // Every reason the draft can not be saved right now ([] when it can).
  function draftProblems(draft, ctx) {
    const problems = [];
    const seen = new Set();
    for (const d of draft || []) {
      if (seen.has(d.sourceInvoiceId)) {
        const invoice = ctx.invoices.find((i) => i.id === d.sourceInvoiceId);
        problems.push(t("debt.alreadyAdded", { number: invoice ? invoice.invoiceNumber : "?" }));
        continue;
      }
      seen.add(d.sourceInvoiceId);
      const problem = allocationProblem(d, ctx);
      if (problem) problems.push(problem);
    }
    return problems;
  }

  // The invoice's carried-forward lines and the ledger records for them, for a draft that has been checked again
  // against the latest data. { lines, transfers } or { error }. The ledger records hold an audit snapshot of the older
  // invoice at this moment: what it asked, what was paid, and what was collectible before and after.
  function buildTransfers(draft, target, ctx, createdAt) {
    const problems = draftProblems(draft, ctx);
    if (problems.length) return { error: problems[0] };
    const ordered = [...draft].sort((a, b) => {
      const ia = ctx.invoices.find((i) => i.id === a.sourceInvoiceId);
      const ib = ctx.invoices.find((i) => i.id === b.sourceInvoiceId);
      return V.invoiceSequence(ia.invoiceNumber) - V.invoiceSequence(ib.invoiceNumber);
    });
    const lines = [];
    const transfers = [];
    for (const d of ordered) {
      const source = ctx.invoices.find((i) => i.id === d.sourceInvoiceId);
      const pay = V.paymentDetail(source, ctx.transfers);
      const amount = V.round2(Number(d.amount));
      const id = V.uid();
      lines.push({ transferId: id, sourceInvoiceId: source.id, sourceInvoiceNumber: source.invoiceNumber, sourceDate: source.date, amount });
      transfers.push({
        id,
        sourceInvoiceId: source.id,
        sourceInvoiceNumber: source.invoiceNumber,
        targetInvoiceId: target.id,
        targetInvoiceNumber: target.invoiceNumber,
        amount,
        createdAt,
        sourceTotal: pay.due,
        sourcePaid: pay.paid,
        availableBefore: pay.remaining,
        availableAfter: V.round2(pay.remaining - amount),
      });
    }
    return { lines, transfers };
  }

  // Where this invoice's balance went: [{ number, amount }] for the newer invoices that carry it.
  function carriedTo(invoice, transfers) {
    return (transfers || [])
      .filter((tr) => tr.sourceInvoiceId === invoice.id)
      .map((tr) => ({ number: tr.targetInvoiceNumber, amount: tr.amount }));
  }

  globalThis.Debt = {
    outstanding, directory, suggest, resolve, identityOf, customerIdFor,
    draftTotal, allocationProblem, addToDraft, removeFromDraft, syncDraft, draftProblems, buildTransfers, carriedTo,
    MIN_CHARS,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = globalThis.Debt;
})();

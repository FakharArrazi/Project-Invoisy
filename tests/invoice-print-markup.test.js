"use strict";

// What the printed invoice is made of: the financial summary is one block (totals AND payment status), the product rows,
// payment entries and deliveries are separate entries that can be laid out one by one, and the continuation header is built from
// the invoice's own data. The page layout itself is tested in invoice-print.test.js and, in a real browser, in tests/e2e.
const assert = require("node:assert/strict");
const test = require("node:test");
const { loadProductApi } = require("./helpers");

function item(n, extra) {
  return { lineId: "l" + n, productId: "p" + n, name: "Tile " + n, manufacturer: "Garnada", tileSize: "60*120", coveragePerBox: 2.88, sellingUnit: "box", sku: "S" + n,
    qty: n, unitPrice: 1000, total: n * 1000, priceUnit: "box", productPrice: 1000, productType: "Faience", ...extra };
}

function invoice(overrides = {}) {
  const items = overrides.items || [item(1), item(2), item(3)];
  const subtotal = items.reduce((s, i) => s + i.total, 0);
  return {
    id: "i-1", invoiceNumber: "INV-000042", date: "2026-10-17T13:32:00.000Z", customer: { name: "Amine Rahmani", phone: "0555", address: "" },
    items, subtotal, discount: 100, tax: 0, total: subtotal - 100, payments: [], discountPercent: null, taxPercent: null, currency: "DA",
    business: { name: "Zenith Carrelage", address: "", phone: "", email: "" }, ...overrides,
  };
}

function load(language) {
  const { api } = loadProductApi();
  api.applyData({ products: [], invoices: [], settings: { ...api.DEFAULT_SETTINGS, language: language || "en" }, counter: 0, lastSaved: "" });
  return api;
}

const count = (text, re) => (text.match(re) || []).length;

test("the payment status is inside the financial summary block, whatever the payment state", () => {
  const api = load();
  for (const [payments, status] of [[[], "UNPAID"], [[{ amount: 500, timestamp: "2026-10-17T14:00:00.000Z" }], "PARTIALLY PAID"], [[{ amount: 5900, timestamp: "2026-10-17T14:00:00.000Z" }], "PAID"]]) {
    const parts = api.invoiceParts(invoice({ payments }));
    assert.match(parts.summary, /^<div class="inv-summary">/);
    for (const label of ["Subtotal", "Discount", "Tax", "TOTAL", "Total Paid", "Remaining"]) assert.ok(parts.summary.includes(label), `${status}: ${label} is in the summary`);
    assert.ok(parts.summary.includes("STATUS: " + status), `${status}: the status is in the summary`);
    assert.ok(parts.summary.indexOf("inv-totals") < parts.summary.indexOf("inv-status"), "the status follows the totals");
    assert.equal(count(parts.payments ? parts.payments.entries.join("") : "", /STATUS/g), 0, "the payment history does not carry the status");
  }
});

test("the screen preview shows the same invoice as before, in the same order", () => {
  const api = load();
  const inv = invoice({ payments: [{ amount: 500, timestamp: "2026-10-17T14:00:00.000Z" }, { amount: 300, timestamp: "2026-10-18T14:00:00.000Z" }] });
  const html = api.invoiceHtml(inv);
  const order = ["inv-head", "inv-meta", "inv-table", "inv-summary", "inv-totals", "inv-status", "inv-payments", "inv-thanks"].map((c) => html.indexOf(c));
  assert.ok(order.every((n) => n >= 0), "every part is there");
  assert.deepEqual(order, order.slice().sort((a, b) => a - b), "head, customer, products, totals, status, payment history, thank-you");
  assert.equal(count(html, /<tr><td>Tile \d/g), 3, "three product rows");
  assert.equal(count(html, /class="inv-pay"/g), 2, "two payments");
  for (const figure of ["6,000 DA", "100 DA", "5,900 DA", "800 DA", "5,100 DA"]) assert.ok(html.includes(figure), figure);
});

test("an invoice with no payments keeps the existing empty message as a single entry", () => {
  const api = load();
  const parts = api.invoiceParts(invoice());
  assert.equal(parts.payments.entries.length, 1);
  assert.match(parts.payments.entries[0], /No payments yet\./);
  assert.match(api.invoiceHtml(invoice()), /PAYMENT HISTORY<\/h3>/);
});

test("print items: every product, payment and delivery is its own entry, and the summary is a single block", () => {
  const api = load();
  const items = Array.from({ length: 25 }, (_, i) => item(i + 1));
  const payments = Array.from({ length: 12 }, (_, i) => ({ amount: 100 + i, timestamp: new Date(Date.UTC(2026, 9, 1 + i, 9)).toISOString() }));
  const list = api.printItems(invoice({ items, payments }));
  const kinds = [...list.map((x) => x.kind)];   // copied: the app runs in its own vm realm
  assert.deepEqual(kinds, ["block", "flow", "block", "flow", "block"], "header, product rows, summary, payment history, thank-you");
  assert.equal(list[1].entries.length, 25);
  assert.equal(list[3].entries.length, 12);
  assert.ok(list[2].html.includes("STATUS:") && list[2].html.includes("Remaining"), "the summary block holds the totals and the status");
  assert.match(list[4].html, /Thank you for your purchase\./);
  assert.ok(list[1].entries.every((row) => /^<tr>/.test(row)), "one table row per product");
  // a piece of the product table always carries the column headings
  assert.match(list[1].build(list[1].entries.slice(5, 7), true), /<thead>.*<th>Product<\/th>.*<tbody><tr>.*<\/tr><tr>.*<\/tr><\/tbody>/s);
  // a piece of the history that continues says so; the first one does not
  assert.match(list[3].build(list[3].entries.slice(0, 1), false), /<h3>PAYMENT HISTORY<\/h3>/);
  assert.match(list[3].build(list[3].entries.slice(4, 6), true), /<h3>PAYMENT HISTORY \(continued\)<\/h3>/);
});

test("carried-forward debt stays its own block between the products and the summary", () => {
  const api = load();
  const inv = invoice({ carriedForward: [{ transferId: "t-1", sourceInvoiceId: "i-0", sourceInvoiceNumber: "INV-000007", sourceDate: "2026-09-01T10:00:00.000Z", amount: 700 }] });
  const list = api.printItems(inv);
  const blocks = list.filter((x) => x.kind === "block").map((x) => x.html);
  assert.ok(blocks.some((h) => /inv-carried/.test(h) && !/inv-summary/.test(h)), "its own block");
  assert.ok(list.findIndex((x) => /inv-carried/.test(x.html || "")) < list.findIndex((x) => /inv-summary/.test(x.html || "")), "before the summary");
});

test("the continuation header uses the invoice's own company, number, date and customer", () => {
  const api = load();
  const head = api.continuationHeadHtml(invoice());
  for (const text of ["Zenith Carrelage", "INVOICE — CONTINUED", "INV-000042", "17/10/2026", "Amine Rahmani"]) assert.ok(head.includes(text), text);
  assert.ok(!head.includes("Hedjazi") && !head.includes("INV-000018"), "no example value is hard-coded");
  const named = api.continuationHeadHtml(invoice({ secondCustomer: { name: "Builders & Co" }, business: { name: "A <b> Shop", address: "", phone: "", email: "" } }));
  assert.ok(named.includes("Amine Rahmani / Builders &amp; Co"), "both customer names, escaped");
  assert.ok(named.includes("A &lt;b&gt; Shop") && !named.includes("<b>"), "the company name is escaped");
  assert.ok(api.continuationHeadHtml(invoice({ customer: { name: "", phone: "", address: "" } })).includes("Walk-in"), "a sale without a customer reads as the walk-in customer");
});

test("French: continuation header and wording follow the language", () => {
  const api = load("fr");
  assert.ok(api.continuationHeadHtml(invoice()).includes("FACTURE — SUITE"));
  const list = api.printItems(invoice({ payments: [{ amount: 1, timestamp: "2026-10-17T14:00:00.000Z" }] }));
  assert.match(list[3].build(list[3].entries, true), /\(suite\)/);
});

test("delivery history is a flowing section with its status label as the lead", () => {
  const api = load();
  const inv = invoice({
    items: [item(1, { deliveredNow: 0 }), item(2, { deliveredNow: 2 })],
    deliveries: [{ type: "sale", date: "2026-10-17T13:32:00.000Z", note: "", lines: [{ lineId: "l2", qty: 2 }] }],
  });
  const list = api.printItems(inv);
  const delivery = list.find((x) => x.kind === "flow" && /DELIVERY HISTORY/.test(x.build(x.entries, false)));
  assert.ok(delivery, "a partly delivered invoice has a delivery history section");
  assert.match(delivery.lead, /inv-delivery-status/);
  assert.equal(delivery.entries.length, 1);
});

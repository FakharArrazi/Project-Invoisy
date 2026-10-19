"use strict";

// The rules that lay a printed invoice out over pages (java script/invoice-print.js). layout() is pure: it only needs a
// function saying whether some markup fits on a page, so a fake page of a fixed height (each fragment has a height) stands in
// for the browser here. The real thing, in Chrome, is checked by tests/e2e/invoice_pagination_check.py.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const context = { globalThis: null };
context.globalThis = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "java script", "invoice-print.js"), "utf8"), context, { filename: "invoice-print.js" });
// The script runs in its own vm context, so the arrays it returns come from another realm; copy them so deepEqual compares them.
const layout = (items, fits) => JSON.parse(JSON.stringify(context.InvoicePrint.layout(items, fits)));

// A fragment is written "name:height". A built piece such as "[head:5|row1:5,row2:5]" is as tall as everything inside it (every
// ":N" counts: 5 + 5 + 5). A page holds PAGE units; a continuation header (pages 2 and up) takes HEAD of them.
const PAGE = 100;
const HEAD = 10;
const height = (fragment) => [...String(fragment).matchAll(/:(\d+)/g)].reduce((sum, m) => sum + Number(m[1]), 0);
const fits = (fragments, pageIndex) => (pageIndex > 0 ? HEAD : 0) + fragments.reduce((sum, f) => sum + height(f), 0) <= PAGE;

const rows = (n, h) => Array.from({ length: n }, (_, i) => `row${i + 1}:${h}`);
const table = (entries) => `[head:5|${entries.join(",")}]`;                       // the heading repeats in every piece
const section = (title) => (entries, continued) => `<${continued ? title + "(cont)" : title}:6|${entries.join(",")}>`;
const flow = (entries, build, lead) => ({ kind: "flow", lead: lead || "", entries, build });
const block = (name, h) => ({ kind: "block", html: `${name}:${h}` });

// What a piece of markup holds, for the checks: the entries inside [..] or <..>.
const entriesIn = (page) => page.flatMap((f) => (f.match(/row\d+|pay\d+/g) || []));
const pageHeight = (page, index) => (index > 0 ? HEAD : 0) + page.reduce((sum, f) => sum + height(f), 0);

test("a short invoice is one page, in order", () => {
  const pages = layout([block("head", 20), flow(rows(3, 5), table), block("summary", 20), block("thanks", 5)], fits);
  assert.equal(pages.length, 1);
  assert.equal(pages[0][0], "head:20");
  assert.equal(pages[0].at(-1), "thanks:5");
});

test("product rows continue on the next page, each exactly once and in order, and every piece repeats the heading", () => {
  const pages = layout([block("head", 20), flow(rows(30, 5), table), block("summary", 20)], fits);
  assert.ok(pages.length >= 3);
  assert.deepEqual(pages.flatMap(entriesIn).filter((x) => x.startsWith("row")), rows(30, 5).map((r) => r.split(":")[0]));
  for (const page of pages.slice(0, -1)) assert.ok(page.some((f) => f.startsWith("[head:5|")), "a page of products shows the heading");
  pages.forEach((page, i) => assert.ok(pageHeight(page, i) <= PAGE, `page ${i + 1} is within the page`));
});

test("the financial summary is never split: it stays under the products when it fits and moves whole when it does not", () => {
  for (let n = 1; n <= 40; n++) {
    const pages = layout([block("head", 20), flow(rows(n, 5), table), block("summary", 30), block("thanks", 5)], fits);
    const holding = pages.map((p, i) => (p.includes("summary:30") ? i : -1)).filter((i) => i >= 0);
    assert.equal(holding.length, 1, `${n} rows: the summary appears once`);
    const lastRows = Math.max(...pages.map((p, i) => (entriesIn(p).length ? i : -1)));
    const onSamePage = pages[lastRows].includes("summary:30");
    const wouldFit = fits(pages[lastRows].concat("summary:30"), lastRows);
    if (!onSamePage) assert.equal(wouldFit, false, `${n} rows: the summary only moves to a new page when it does not fit under the products`);
  }
});

test("the summary is not forced onto a new page when there is room", () => {
  const pages = layout([block("head", 20), flow(rows(4, 5), table), block("summary", 30)], fits);
  assert.equal(pages.length, 1);
});

test("payment history: its heading never sits alone at the bottom of a page, and its entries flow over pages", () => {
  const pay = Array.from({ length: 60 }, (_, i) => `pay${i + 1}:4`);
  for (let n = 1; n <= 20; n++) {
    const pages = layout([block("head", 20), flow(rows(n, 5), table), block("summary", 30), flow(pay, section("HISTORY"))], fits);
    assert.deepEqual(pages.flatMap(entriesIn).filter((x) => x.startsWith("pay")), pay.map((p) => p.split(":")[0]), `${n} rows: each payment once, in order`);
    pages.forEach((page, i) => {
      assert.ok(pageHeight(page, i) <= PAGE, `${n} rows: page ${i + 1} is within the page`);
      const last = page.at(-1);
      if (last.startsWith("<")) assert.ok(/pay\d+/.test(last), `${n} rows: a history piece always holds at least one payment`);
    });
    const firstPiece = pages.flat().findIndex((f) => f.startsWith("<HISTORY:"));
    assert.ok(firstPiece >= 0 && /pay1\b/.test(pages.flat()[firstPiece]), `${n} rows: the heading is with the first payment`);
    assert.equal(pages.flat().filter((f) => f.startsWith("<HISTORY(cont)")).length > 0, pages.flat().filter((f) => f.startsWith("<HISTORY")).length > 1);
  }
});

test("the lead of a section (the delivery status) stays with the section's first piece", () => {
  for (let n = 1; n <= 25; n++) {
    const pages = layout([flow(rows(n, 5), table), block("summary", 30), flow(["pay1:4", "pay2:4"], section("DELIVERY"), "status:8")], fits);
    const flat = pages.map((p) => p.slice());
    const at = flat.findIndex((p) => p.includes("status:8"));
    assert.ok(at >= 0, `${n} rows: the status is there`);
    assert.ok(flat[at].some((f) => f.startsWith("<DELIVERY:")), `${n} rows: the status is on the same page as the delivery heading`);
    assert.ok(flat[at].indexOf("status:8") < flat[at].findIndex((f) => f.startsWith("<DELIVERY:")), `${n} rows: the status comes first`);
  }
});

test("a section with no entries (nothing to list) still prints its heading and stays together", () => {
  const pages = layout([flow(rows(2, 5), table), block("summary", 30), flow([], (entries) => `<EMPTY:6|${entries.join(",")}>`)], fits);
  assert.equal(pages.length, 1);
  assert.ok(pages[0].includes("<EMPTY:6|>"));
});

test("the thank-you follows the last section and gets a page of its own only when it does not fit", () => {
  const fitting = layout([flow(rows(3, 5), table), block("summary", 30), flow(["pay1:4"], section("HISTORY")), block("thanks", 10)], fits);
  assert.equal(fitting.length, 1);
  assert.equal(fitting[0].at(-1), "thanks:10");
  const tight = layout([flow(rows(3, 5), table), block("summary", 30), flow(["pay1:4"], section("HISTORY")), block("thanks", 40)], fits);
  assert.equal(tight.length, 1);
  const over = layout([flow(rows(3, 5), table), block("summary", 30), flow(["pay1:4"], section("HISTORY")), block("thanks", 60)], fits);
  assert.equal(over.length, 2);
  assert.equal(over[1].join(), "thanks:60");
});

test("something taller than a page is still printed (alone on its page) instead of looping or vanishing", () => {
  const pages = layout([block("head", 20), block("huge", 250), flow(rows(2, 5), table)], fits);
  assert.ok(pages.some((p) => p.includes("huge:250")));
  assert.deepEqual(pages.flatMap(entriesIn), ["row1", "row2"]);
});

test("no page is ever empty", () => {
  for (let n = 0; n <= 60; n++) {
    const pages = layout([block("head", 25), flow(rows(n, 7), table), block("summary", 33), flow(Array.from({ length: n % 9 }, (_, i) => `pay${i}:4`), section("HISTORY")), block("thanks", 9)], fits);
    for (const page of pages) assert.ok(page.length > 0, `${n} rows`);
  }
});

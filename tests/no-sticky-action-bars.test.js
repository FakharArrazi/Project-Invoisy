"use strict";

// Form action bars (Save / Confirm / Cancel ...) are ordinary elements at the end of their form: they scroll with the page and are
// reached by scrolling, they never stay pinned to the top or bottom of the screen. This test reads the style sheets and the scripts,
// so a pinned bar cannot come back unnoticed. The few things that are pinned on purpose are listed below with the reason.

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const ROOT = path.join(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");

const cssFiles = fs.readdirSync(path.join(ROOT, "css")).filter((f) => f.endsWith(".css"));
const scriptFiles = fs.readdirSync(path.join(ROOT, "java script")).filter((f) => f.endsWith(".js"));

// Every rule that sets position: sticky / fixed, as "file: selector" (comments removed, spaces collapsed).
function pinnedRules() {
  const found = [];
  for (const file of cssFiles) {
    const css = read("css", file).replace(/\/\*[^]*?\*\//g, "");
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (/(^|;|\s)position\s*:\s*(-webkit-)?(sticky|fixed)\b/.test(m[2])) found.push(`${file}: ${m[1].trim().replace(/\s+/g, " ")}`);
    }
  }
  return found.sort();
}

// Pinned on purpose. None of these is a form action bar.
const ALLOWED = [
  "invoices.css: .invoice-table th:last-child, .invoice-table td:last-child", // narrow screens: the Actions column stays at the edge of the table's own sideways scroll
  "stock.css: .stock-table thead th",                                           // column headings of the long lists (they hold sort buttons only)
  "style.css: .combo-foot",                                                     // "Add a new product" at the foot of the product dropdown, inside that list's own scroll box
  "style.css: .toast",                                                          // short message that fades away
  "style.css: .topbar",                                                         // the application header
].sort();

test("nothing is pinned to the screen except the listed, deliberate cases", () => {
  assert.deepEqual(pinnedRules(), ALLOWED);
});

test("the Stock product form and the purchase form button rows are in normal document flow", () => {
  const stock = read("css", "stock.css").replace(/\/\*[^]*?\*\//g, "");
  const style = read("css", "style.css").replace(/\/\*[^]*?\*\//g, "");
  const rule = (css, selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return [...css.matchAll(new RegExp(`(?:^|[}\\s])${escaped}\\s*\\{([^{}]*)\\}`, "g"))].map((m) => m[1]);
  };
  const bars = [[stock, ".stock-form-actions"], [style, ".purchase-form-actions"]];
  for (const [css, selector] of bars) {
    const bodies = rule(css, selector);
    assert.ok(bodies.length >= 1, `${selector} is still styled`);
    for (const body of bodies) assert.doesNotMatch(body, /(^|[;\s])(position|top|bottom|z-index)\s*:/, `${selector} is not positioned`);
  }
  assert.match(read("index.html"), /class="actions left stock-form-actions"/);
  assert.match(read("java script", "purchases-ui.js"), /class="actions left purchase-form-actions"/);
});

test("no script pins an element to the screen, and the old pinned-bar class is gone", () => {
  for (const file of scriptFiles) {
    const source = read("java script", file);
    assert.doesNotMatch(source, /position\s*:\s*(-webkit-)?(sticky|fixed)\b/, `${file} has no inline sticky / fixed position`);
    assert.doesNotMatch(source, /style\.position\s*=/, `${file} does not set an element's position`);
    assert.doesNotMatch(source, /sticky-actions/, `${file} does not use the old pinned-bar class`);
  }
  assert.doesNotMatch(read("index.html"), /position\s*:\s*(-webkit-)?(sticky|fixed)\b|sticky-actions/);
  for (const file of cssFiles) assert.doesNotMatch(read("css", file), /sticky-actions/, `${file} has no rule for the old class`);
});

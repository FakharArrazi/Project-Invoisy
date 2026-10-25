"use strict";

// The company header of the printed invoice: business name | logo square | invoice title, then the staff contacts, then the address.
// Everything runs through the application's own functions (script.js) against a disposable in-memory IndexedDB. What a real
// browser prints (the 3 x 3 cm / 2.5 x 2.5 cm square, centring, wrapping) is measured in tests/e2e/invoice_header_check.py.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { V, sampleProduct } = require("./helpers/modules");
const { loadApp } = require("./helpers/app");
const { FakeHandle } = require("./helpers/fake-handle");

const plain = (x) => JSON.parse(JSON.stringify(x));
const same = (actual, expected, message) => assert.deepEqual(plain(actual), plain(expected), message);
const count = (text, re) => (text.match(re) || []).length;
const css = fs.readFileSync(path.join(__dirname, "..", "css", "style.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");   // without comments

async function boot() {
  const handle = new FakeHandle();
  const app = loadApp({ globals: { showSaveFilePicker: async () => handle, window: { print() {}, addEventListener() {} } } });
  const storage = await app.start();
  assert.equal(storage.mode, "ready", storage.reason);
  await app.api.connectBackupFile();
  return { app, api: app.api, handle };
}

async function addTile(ctx) {
  const { id, ...values } = sampleProduct({ name: "Everton Grey", tileSize: "60*60", coveragePerBox: 1.44, sku: "EV-60", sellingPrice: 800, priceUnit: "m2", purchasePrice: 600, stock: 10 });
  const before = ctx.api.getState().products.map((p) => p.id);
  await ctx.api.addProduct(values);
  return ctx.api.getState().products.find((p) => !before.includes(p.id));
}

async function sell(ctx, product) {
  const { api } = ctx;
  assert.equal(api.addToSale(product.id, "2", "box").ok, true);
  api.getSale().customer.name = "Alex";
  await api.completeSale();
  return api.getInvoices()[api.getInvoices().length - 1];
}

const PEOPLE = [
  { name: "Mohamed", phones: ["0550 00 00 00", "0660 00 00 00"] },
  { name: "Ahmed", phones: ["0770 00 00 00", "0790 00 00 00", "021 00 00 00"] },
  { name: "Yacine", phones: ["0560 00 00 00", "0670 00 00 00"] },
];

// A saved invoice carrying the given business details, shown by the app (header only).
const headOf = (api, business, logo) => {
  const inv = { id: "i-1", invoiceNumber: "INV-000042", date: "2026-10-17T13:32:00.000Z", customer: { name: "Amine", phone: "", address: "" }, items: [], subtotal: 0, discount: 0, tax: 0, total: 0, payments: [], currency: "DA", business };
  return api.invoiceHeadHtml(inv.business, logo);
};

/* ---------- Structure ---------- */

test("header: name on the left, a logo square in the centre, the invoice title on the right, in that order", async () => {
  const { api } = await boot();
  const head = headOf(api, { name: "Hedjazi Ceramic", address: "", phone: "", email: "" }, "");
  const order = ["inv-biz-name", "inv-logo-box", "inv-title"].map((c) => head.indexOf(c));
  assert.ok(order.every((n) => n >= 0), "all three are there");
  assert.deepEqual(order, order.slice().sort((a, b) => a - b), "name, logo square, title");
  assert.match(head, /class="inv-biz-name">Hedjazi Ceramic</);
  assert.match(head, /class="inv-title">INVOICE</, "the title keeps its wording");
});

test("header: the logo square is always drawn, empty or not, and a logo only goes inside it", async () => {
  const { api } = await boot();
  const biz = { name: "Shop", address: "", phone: "", email: "" };
  const empty = headOf(api, biz, "");
  assert.match(empty, /<div class="inv-logo-box"><\/div>/, "an empty square is still there");
  assert.equal(count(empty, /<img/g), 0);
  const withLogo = headOf(api, biz, "data:image/png;base64,AAAA");
  assert.match(withLogo, /<div class="inv-logo-box"><img src="data:image\/png;base64,AAAA" alt="[^"]*"><\/div>/);
  assert.doesNotMatch(withLogo, /width=|height=|style=/, "no size is ever taken from the picture");
  assert.doesNotMatch(withLogo, /class="inv-logo"/, "the old unconstrained logo class is not used on the invoice");
});

test("header: the preview and the printed pages are built from the same header", async () => {
  const { api } = await boot();
  const inv = { id: "i-1", invoiceNumber: "INV-000042", date: "2026-10-17T13:32:00.000Z", customer: { name: "Amine", phone: "", address: "" }, items: [], subtotal: 0, discount: 0, tax: 0, total: 0, payments: [], currency: "DA",
    business: { name: "Shop", address: "Rue 1", phone: "", email: "", staff: PEOPLE } };
  const parts = api.invoiceParts(inv);
  assert.ok(api.invoiceHtml(inv).startsWith(parts.head), "preview");
  assert.ok(api.printItems(inv)[0].html.startsWith(parts.head), "print");
  assert.match(parts.head, /inv-logo-box/);
});

/* ---------- Staff contacts ---------- */

test("staff: several people, each with their own number of phones, one person per line, nothing hardcoded", async () => {
  const { api } = await boot();
  const head = headOf(api, { name: "Shop", address: "", phone: "", email: "", staff: PEOPLE }, "");
  assert.equal(count(head, /class="inv-staff-line"/g), 3, "one line per person");
  for (const p of PEOPLE) {
    const line = head.split('<div class="inv-staff-line">').find((l) => l.includes(`>${p.name}:<`));
    assert.ok(line, p.name);
    for (const phone of p.phones) assert.ok(line.includes(phone), `${p.name}: ${phone}`);
    assert.equal(count(line.split("</div>")[0], /inv-sep/g), p.phones.length - 1, `${p.name}: dots between numbers only`);
  }
  assert.ok(head.indexOf("Mohamed") < head.indexOf("Ahmed") && head.indexOf("Ahmed") < head.indexOf("Yacine"), "in the order they were entered");
  // Nothing configured: no example names or numbers anywhere.
  const none = headOf(api, { name: "Shop", address: "", phone: "", email: "" }, "");
  for (const word of ["Mohamed", "Ahmed", "Yacine", "0550"]) assert.ok(!none.includes(word), word);
});

test("staff: no people and no address means no blank section at all", async () => {
  const { api } = await boot();
  const head = headOf(api, { name: "Shop", address: "", phone: "", email: "" }, "");
  assert.doesNotMatch(head, /inv-staff/);
  assert.doesNotMatch(head, /inv-address/);
  const addressOnly = headOf(api, { name: "Shop", address: "Rue 1, Sétif", phone: "", email: "" }, "");
  assert.doesNotMatch(addressOnly, /inv-staff/);
  assert.match(addressOnly, /<div class="inv-address">Rue 1, Sétif<\/div>/);
  const blank = headOf(api, { name: "Shop", address: "   ", phone: "", email: "", staff: [] }, "");
  assert.doesNotMatch(blank, /inv-address|inv-staff/, "a blank address and an empty list print nothing");
});

test("staff: the address is centred under the staff, no longer stacked under the business name", async () => {
  const { api } = await boot();
  const head = headOf(api, { name: "Shop", address: "Rue 1", phone: "0550 11 22 33", email: "a@b.dz", staff: PEOPLE }, "");
  const nameCell = head.slice(head.indexOf('class="inv-head-name"'), head.indexOf('class="inv-logo-box"'));
  assert.ok(!nameCell.includes("Rue 1"), "the address left the name cell");
  assert.ok(nameCell.includes("0550 11 22 33") && nameCell.includes("a@b.dz"), "the phone and email it always had are still under the name");
  assert.ok(head.indexOf("inv-staff") < head.indexOf("inv-address"), "the address comes after the staff");
  assert.ok(head.indexOf("inv-logo-box") < head.indexOf("inv-staff"), "the staff come after the first line");
});

test("staff: a person with no name prints only the numbers; a person with no number is not printed; text is escaped", async () => {
  const { api } = await boot();
  const head = headOf(api, { name: "Shop", address: "", phone: "", email: "", staff: [
    { name: "", phones: ["0550 1"] }, { name: "Nobody", phones: [] }, { name: "<b>Eve</b> & Co", phones: ["0661 2"] }] }, "");
  assert.equal(count(head, /class="inv-staff-line"/g), 2);
  assert.doesNotMatch(head, /Nobody/);
  assert.doesNotMatch(head, /inv-staff-line"><span class="inv-staff-name">:/, "no empty label");
  assert.match(head, /&lt;b&gt;Eve&lt;\/b&gt; &amp; Co:/);
  assert.doesNotMatch(head, /<b>Eve/);
});

test("staff: in Arabic every number keeps its own left-to-right order", async () => {
  const { api } = await boot();
  await api.commit((d) => { d.settings.language = "ar"; });
  const head = headOf(api, { name: "Shop", address: "", phone: "", email: "", staff: PEOPLE }, "");
  assert.ok(head.includes("\u20660550 00 00 00\u2069"), "isolated number");
  assert.match(head, /class="inv-title">/);
});

/* ---------- Settings: saving, persistence, backup ---------- */

test("settings: add and remove people and numbers, save; it persists, survives a reload and reaches the backup file", async () => {
  const ctx = await boot();
  const { api, app } = ctx;
  api.fillSettingsForm();
  same(api.getStaffRows(), [], "no people to start with (and no empty example row)");
  const mohamed = api.addStaffRow();
  api.setStaffName(mohamed.rowId, "Mohamed");
  api.setStaffPhone(mohamed.rowId, mohamed.phones[0].rowId, "0550 00 00 00");
  const second = api.addStaffPhone(mohamed.rowId);
  api.setStaffPhone(mohamed.rowId, second.rowId, "0660 00 00 00");
  const third = api.addStaffPhone(mohamed.rowId);
  api.setStaffPhone(mohamed.rowId, third.rowId, "0770 00 00 00");
  assert.equal(api.removeStaffPhone(mohamed.rowId, third.rowId), true);
  const ahmed = api.addStaffRow();
  api.setStaffName(ahmed.rowId, "Ahmed");
  api.setStaffPhone(ahmed.rowId, ahmed.phones[0].rowId, "021 00 00 00");
  const gone = api.addStaffRow();
  api.setStaffName(gone.rowId, "Temporary");
  assert.equal(api.removeStaffRow(gone.rowId), true);
  app.field("sName").value = "Shop";
  await api.saveBusinessSettings();

  const expected = [{ name: "Mohamed", phones: ["0550 00 00 00", "0660 00 00 00"] }, { name: "Ahmed", phones: ["021 00 00 00"] }];
  same(api.getState().settings.staff, expected);
  same((await api.db.loadAll()).settings.staff, expected, "saved in the database");
  await api.loadFromDatabase();
  same(api.getState().settings.staff, expected, "after a reload");
  api.fillSettingsForm();
  same(api.getStaffRows().map((r) => ({ name: r.name, phones: r.phones.map((p) => p.value) })), expected, "the form shows them again");

  await api.autoBackup.flushNow();
  const parsed = V.parseBackup(ctx.handle.content);
  assert.equal(parsed.error, undefined, parsed.error);
  same(parsed.data.settings.staff, expected, "the backup file holds them too");
});

test("settings: blank boxes, repeated numbers and empty people are dropped; a name with no number is kept in the settings but not printed", async () => {
  const { api, app } = await boot();
  api.fillSettingsForm();
  const a = api.addStaffRow();
  api.setStaffName(a.rowId, "  Sara   B. ");
  api.setStaffPhone(a.rowId, a.phones[0].rowId, " 0550  11 22 ");
  const dup = api.addStaffPhone(a.rowId); api.setStaffPhone(a.rowId, dup.rowId, "0550 11 22");
  const blank = api.addStaffPhone(a.rowId); api.setStaffPhone(a.rowId, blank.rowId, "   ");
  api.addStaffRow();                                   // nothing typed: dropped
  const nameOnly = api.addStaffRow(); api.setStaffName(nameOnly.rowId, "Later");
  app.field("sName").value = "Shop";
  await api.saveBusinessSettings();
  same(api.getState().settings.staff, [{ name: "Sara B.", phones: ["0550 11 22"] }, { name: "Later", phones: [] }]);
  const snapshot = V.businessSnapshot(api.getState().settings);
  same(snapshot.staff, [{ name: "Sara B.", phones: ["0550 11 22"] }], "only people with a number go on the invoice");
});

test("settings: the last number of a person stays (a blank one means none); the limits stop at 10 people and 10 numbers each", async () => {
  const { api } = await boot();
  api.fillSettingsForm();
  const p = api.addStaffRow();
  assert.equal(api.removeStaffPhone(p.rowId, p.phones[0].rowId), false, "a person always keeps one number box");
  for (let i = 1; i < V.MAX_BUSINESS_PHONES; i++) assert.ok(api.addStaffPhone(p.rowId));
  assert.equal(api.addStaffPhone(p.rowId), null, `at most ${V.MAX_BUSINESS_PHONES} numbers`);
  for (let i = 1; i < V.MAX_STAFF; i++) assert.ok(api.addStaffRow());
  assert.equal(api.addStaffRow(), null, `at most ${V.MAX_STAFF} people`);
});

test("settings: a bad staff list is refused with a message, and reading an old or oversized file never fails", () => {
  const base = plain(V.normalizeSettings({}));
  for (const bad of ["Mohamed", [{ name: "A" }], [{ name: 5, phones: [] }], [{ name: "A", phones: "0550" }], [{ name: "A", phones: [1] }],
    new Array(V.MAX_STAFF + 1).fill({ name: "A", phones: ["1"] }), [{ name: "A".repeat(V.MAX_STAFF_NAME_LENGTH + 1), phones: [] }],
    [{ name: "A", phones: new Array(V.MAX_BUSINESS_PHONES + 1).fill("1") }], [{ name: "A", phones: ["1".repeat(V.MAX_PHONE_LENGTH + 1)] }]]) {
    assert.notEqual(V.settingsProblem({ ...base, staff: bad }), "", JSON.stringify(bad).slice(0, 60));
  }
  assert.equal(V.settingsProblem({ ...base, staff: PEOPLE }), "");
  assert.equal(V.settingsProblem(base), "", "no staff at all is fine");
  const read = V.normalizeSettings({ staff: [null, 3, { name: "A".repeat(200), phones: ["1", 2, "1", ""] }, ...new Array(30).fill({ name: "X", phones: ["9"] })] });
  assert.equal(read.staff.length, V.MAX_STAFF, "too many people are cut, not refused");
  assert.equal(read.staff[0].name.length, V.MAX_STAFF_NAME_LENGTH);
  same(read.staff[0].phones, ["1"]);
});

/* ---------- Older data ---------- */

test("legacy: settings and invoices saved before the staff contacts existed keep their exact shape and still print", async () => {
  const ctx = await boot();
  const { api } = ctx;
  await api.commit((d) => { d.settings = { ...d.settings, phone: "0550 00 11 22", address: "Rue 1" }; delete d.settings.phones; delete d.settings.staff; });
  const stored = await api.db.loadAll();
  assert.equal(stored.settings.staff, undefined, "nothing was added to the old settings");
  assert.deepEqual(plain(V.businessSnapshot(stored.settings)), { name: stored.settings.businessName, address: "Rue 1", phone: "0550 00 11 22", email: "" }, "the invoice details keep today's shape");
  api.fillSettingsForm();
  same(api.getStaffRows(), [], "the form starts empty");

  const tile = await addTile(ctx);
  const old = await sell(ctx, tile);
  assert.equal("staff" in old.business, false, "no staff key on an invoice made without staff");
  const html = api.invoiceHtml(old);
  assert.match(html, /inv-logo-box/);
  assert.doesNotMatch(html, /inv-staff/);
  assert.match(html, /<div class="inv-address">Rue 1<\/div>/);
  assert.match(html, /0550 00 11 22/);

  // Staff added later appear on new invoices only: an invoice keeps the letterhead it was made with.
  await api.commit((d) => { d.settings.staff = plain(PEOPLE); });
  const fresh = await sell(ctx, tile);
  same(fresh.business.staff, PEOPLE);
  assert.match(api.invoiceHtml(fresh), /Mohamed:/);
  assert.doesNotMatch(api.invoiceHtml(api.getInvoices().find((i) => i.id === old.id)), /Mohamed/);
});

test("legacy: the collection document and the continuation header are not part of this redesign", async () => {
  const ctx = await boot();
  const { api } = ctx;
  await api.commit((d) => { d.settings.staff = plain(PEOPLE); d.settings.logo = "data:image/png;base64,AAAA"; });
  const tile = await addTile(ctx);
  const inv = await sell(ctx, tile);
  const collection = api.collectionHtml(inv);
  assert.match(collection, /<header class="inv-head">/, "its own, unchanged header");
  assert.match(collection, /class="inv-logo"/);
  assert.doesNotMatch(collection, /inv-logo-box|inv-staff/);
  assert.doesNotMatch(api.continuationHeadHtml(inv), /inv-logo-box|inv-staff/);
});

/* ---------- Print sizes (the css the browser prints with) ---------- */

const rule = (selector) => {
  const found = css.split("}").map((b) => b.trim()).find((b) => b.startsWith(selector + " {") || b.startsWith(selector + "{"));
  assert.ok(found, "css rule " + selector);
  return found;
};

test("print: the logo square is 3 x 3 cm on A4 and 2.5 x 2.5 cm on A5, fixed, with the picture contained inside", () => {
  const box = rule(".inv-logo-box");
  assert.match(box, /width: 3cm/);
  assert.match(box, /height: 3cm/);
  assert.match(box, /box-sizing: border-box/, "the border is part of the size");
  assert.match(box, /overflow: hidden/);
  assert.match(box, /border: 1px solid/, "a visible but subtle border");
  const a5 = rule('html[data-paper="a5"] .inv-logo-box');
  assert.match(a5, /width: 2\.5cm/);
  assert.match(a5, /height: 2\.5cm/);
  const img = rule(".inv-logo-box img");
  assert.match(img, /object-fit: contain/);
  assert.match(img, /max-width: 100%/);
  assert.match(img, /max-height: 100%/);
  assert.doesNotMatch((box + a5).replace(/border: 1px solid[^;]*;/, ""), /\d\s*px/, "no screen pixels in the size or padding");
  // The same rules hold on screen and on paper: no @media print block resizes the square.
  let from = 0;
  while ((from = css.indexOf("@media print", from)) !== -1) {
    let depth = 0, end = css.indexOf("{", from);
    for (let i = end; i < css.length; i++) {
      if (css[i] === "{") depth++;
      if (css[i] === "}" && --depth === 0) { end = i; break; }
    }
    assert.doesNotMatch(css.slice(from, end), /inv-logo-box/, "a print block resizes the logo square");
    from = end;
  }
});

test("print: both paper sizes use the same header markup; only the css sizes differ (the paper setting drives data-paper)", async () => {
  const { api } = await boot();
  const a4 = headOf(api, { name: "Shop", address: "Rue", phone: "", email: "", staff: PEOPLE }, "");
  await api.savePaper("A5");
  assert.equal(headOf(api, { name: "Shop", address: "Rue", phone: "", email: "", staff: PEOPLE }, ""), a4);
  assert.equal(api.getState().settings.paper, "A5");
});

"use strict";

// The Suppliers and Purchases screens for deposits and advances, driven through the real page scripts (script.js and
// purchases-ui.js) against a disposable in-memory database: the form handlers are called the way a click on the button
// would call them, and what is drawn is read back from the page.

const test = require("node:test");
const assert = require("node:assert/strict");
const { sampleProduct } = require("./helpers/modules");
const { loadApp } = require("./helpers/app");

const P = globalThis.Purchases;
const day = (offset) => P.addDays(P.toDay(new Date()), offset || 0);
const tile = () => sampleProduct({
  id: "p-tile", name: "Tile A", tileSize: "60*60", coveragePerBox: 1.44, sellingPrice: 800, priceUnit: "m2", stockUnit: "m2",
  purchasePrice: null, sku: "TA-1", stock: 10,
});

async function shop() {
  const app = loadApp();
  const storage = await app.start();
  assert.equal(storage.mode, "ready", storage.reason);
  assert.equal((await app.api.commit((d) => { d.products.push(tile()); })).error, undefined);
  assert.equal((await app.api.commit((d) => P.saveSupplier(d, { name: "Timgad Ceramic", phone: "0555 12 34 56", paymentTermsDays: "30" }))).error, undefined);
  return app;
}

const state = (app) => app.api.getState();
const ui = (app) => app.api.PurchasesUI;
const sid = (app) => state(app).suppliers[0].id;
const settle = () => new Promise((resolve) => setImmediate(resolve));

function fillDeposit(app, values) {
  const v = { type: "deposit", amount: "", date: day(0), method: "", reference: "", note: "", ...values };
  app.field("dpType").value = v.type;
  app.field("dpAmount").value = v.amount;
  app.field("dpDate").value = v.date;
  app.field("dpMethod").value = v.method;
  app.field("dpRef").value = v.reference;
  app.field("dpNote").value = v.note;
}

async function openTab(app, tab) {
  const s = state(app);
  s.view = "suppliers";
  ui(app).reset();
  ui(app).openSupplier(sid(app), tab);
  app.api.renderAll();
  return app.field("suppliersRoot").innerHTML;
}

const buy = (app, boxes, extra) => app.api.commit((d) => {
  const saved = P.saveDraft(d, { supplierId: d.suppliers[0].id, supplierInvoiceNumber: "FA-" + (d.purchases.length + 1), invoiceDate: day(0), lines: [{ productId: "p-tile", unit: "box", qty: String(boxes), unitPrice: "1000" }], ...extra });
  if (saved.error) return saved;
  return P.confirmPurchase(d, saved.purchase.id);
});

test("the deposit form records a deposit with no invoice, and pressing save twice records it once", async () => {
  const app = await shop();
  await openTab(app, "deposits");
  fillDeposit(app, { amount: "150000", method: "bank", reference: "VIR-9", note: "autumn order" });
  const first = ui(app).forms["sup-deposit"]();
  const second = ui(app).forms["sup-deposit"]();   // a second click while the first is still saving
  await Promise.all([first, second]);
  await settle();
  const deposits = state(app).supplierDeposits;
  assert.equal(deposits.length, 1, "the double click made one deposit");
  assert.deepEqual([deposits[0].amount, deposits[0].method, deposits[0].reference, deposits[0].kind], [150000, "bank", "VIR-9", "deposit"]);
  assert.equal(deposits[0].purchaseId, undefined, "no invoice is involved");
  assert.equal(state(app).purchases.length, 0, "no purchase or invoice was invented");
});

test("a retry of the same form after a hiccup finds the first deposit instead of adding a second", async () => {
  const app = await shop();
  await openTab(app, "deposits");
  fillDeposit(app, { amount: "5000" });
  const nonce = () => ui(app).state.sup.depositNonce;
  await ui(app).forms["sup-deposit"]();
  assert.equal(state(app).supplierDeposits.length, 1);
  // The page forgot that it had finished (as after a crash between the save and the redraw): same form, same id.
  const id = state(app).supplierDeposits[0].id;
  ui(app).state.sup.depositNonce = id;
  fillDeposit(app, { amount: "5000" });
  await ui(app).forms["sup-deposit"]();
  assert.equal(state(app).supplierDeposits.length, 1, "still one deposit");
  assert.ok(nonce() === "" || nonce() === id);
});

test("the form refuses a zero amount and shows why, without saving anything", async () => {
  const app = await shop();
  await openTab(app, "deposits");
  fillDeposit(app, { amount: "0" });
  await ui(app).forms["sup-deposit"]();
  assert.match(app.errorText("dpError"), /amount/i);
  assert.equal(state(app).supplierDeposits.length, 0);
});

test("a deposit larger than all purchases shows owed 0, advance, prepaid and net balance on the supplier screens", async () => {
  const app = await shop();
  assert.equal((await buy(app, 100)).error, undefined);   // 100,000 DA
  await openTab(app, "deposits");
  fillDeposit(app, { amount: "150000" });
  await ui(app).forms["sup-deposit"]();
  await settle();

  const sum = P.supplierPayable(state(app), sid(app), day(0));
  assert.deepEqual([sum.net, sum.owed, sum.advance, sum.unapplied, sum.outstanding], [-50000, 0, 50000, 150000, 100000]);

  const overview = await openTab(app, "overview");
  assert.match(overview, /Net balance/);
  assert.match(overview, /Prepaid/);
  assert.match(overview, /Available advance/);
  assert.match(overview, /50,000/);
  assert.match(overview, /not applied to any invoice yet/, "it says the open invoice still shows unpaid until the advance is applied");

  state(app).view = "suppliers";
  ui(app).reset();
  app.api.renderAll();
  const list = app.field("suppliersRoot").innerHTML;
  assert.match(list, /Owed to suppliers/);
  assert.match(list, /Available advances/);
  assert.match(list, /Prepaid/);
});

test("the statement lists the deposit and the purchase with a running balance, and the Deposits tab lists the deposit", async () => {
  const app = await shop();
  await app.api.commit((d) => P.recordDeposit(d, { supplierId: d.suppliers[0].id, amount: "50000", date: day(-2), method: "cash", reference: "R-1" }));
  assert.equal((await buy(app, 30, { advanceApply: "30000" })).error, undefined);
  const statement = await openTab(app, "statement");
  assert.match(statement, /Deposit \/ advance/);
  assert.match(statement, /Purchase/);
  assert.match(statement, /Advance applied/);
  assert.match(statement, /No change to the balance/);
  assert.match(statement, /R-1/);
  const deposits = await openTab(app, "deposits");
  assert.match(deposits, /Cash/);
  assert.match(deposits, /20,000 DA still unapplied/);
  assert.match(deposits, /Advance applied to invoices/);
});

test("confirming a draft can use part of the advance; the invoice and the supplier then reconcile", async () => {
  const app = await shop();
  await app.api.commit((d) => P.recordDeposit(d, { supplierId: d.suppliers[0].id, amount: "20000", date: day(0) }));
  const drafted = await app.api.commit((d) => P.saveDraft(d, { supplierId: d.suppliers[0].id, supplierInvoiceNumber: "FA-7", invoiceDate: day(0), lines: [{ productId: "p-tile", unit: "box", qty: "35", unitPrice: "1000" }] }));
  const id = drafted.purchase.id;
  state(app).view = "purchases";
  ui(app).openPurchase(id);
  ui(app).state.pur.open = "confirm";
  app.api.renderAll();
  const panel = app.field("purchasesRoot").innerHTML;
  assert.match(panel, /id="dc-advance"/, "the advance is offered because the supplier has unapplied deposits");
  assert.match(panel, /Unapplied deposits with this supplier: 20,000 DA/);

  app.field("dc-receive").checked = true;
  app.field("dc-rdate").value = day(0);
  app.field("dc-pamount").value = "";
  app.field("dc-pdate").value = day(0);
  app.field("dc-pref").value = "";
  app.field("dc-advance").value = "20000";
  await ui(app).forms["pur-confirm"]();
  await settle();
  const sum = P.supplierPayable(state(app), sid(app), day(0));
  assert.deepEqual([sum.total, sum.paid, sum.net, sum.owed, sum.outstanding, sum.unapplied], [35000, 20000, 15000, 15000, 15000, 0]);
  assert.equal(state(app).advanceAllocations.length, 1);
});

test("a normal supplier with no deposits sees no advance control in the confirm panel", async () => {
  const app = await shop();
  const drafted = await app.api.commit((d) => P.saveDraft(d, { supplierId: d.suppliers[0].id, supplierInvoiceNumber: "FA-8", invoiceDate: day(0), lines: [{ productId: "p-tile", unit: "box", qty: "5", unitPrice: "1000" }] }));
  state(app).view = "purchases";
  ui(app).openPurchase(drafted.purchase.id);
  ui(app).state.pur.open = "confirm";
  app.api.renderAll();
  assert.ok(!/dc-advance/.test(app.field("purchasesRoot").innerHTML), "no extra step for the normal workflow");
});

test("an open invoice can be settled from the supplier's deposits, then released again", async () => {
  const app = await shop();
  const bought = await buy(app, 40);
  const id = bought.purchase.id;
  await app.api.commit((d) => P.recordDeposit(d, { supplierId: d.suppliers[0].id, amount: "100000", date: day(0) }));
  state(app).view = "purchases";
  ui(app).openPurchase(id);
  app.api.renderAll();
  assert.match(app.field("purchasesRoot").innerHTML, /Apply advance/);

  ui(app).state.pur.open = "applyAdv";
  app.api.renderAll();
  app.field("da-amount").value = "15000";
  await ui(app).forms["pur-applyadv"]();
  await settle();
  let sum = P.purchaseSummary(state(app).purchases[0], state(app).supplierPayments, day(0), state(app).advanceAllocations);
  assert.deepEqual([sum.paid, sum.outstanding, sum.advanceApplied], [15000, 25000, 15000]);
  assert.match(app.field("purchasesRoot").innerHTML, /15,000 DA from advance/);

  const allocation = state(app).advanceAllocations[0];
  ui(app).state.pur.open = "releaseAdv:" + allocation.id;
  app.api.renderAll();
  app.field("da-reason").value = "wrong invoice";
  await ui(app).forms["pur-releaseadv"]();
  await settle();
  sum = P.purchaseSummary(state(app).purchases[0], state(app).supplierPayments, day(0), state(app).advanceAllocations);
  assert.deepEqual([sum.paid, sum.outstanding], [0, 40000]);
  assert.equal(P.advanceTotals(sid(app), state(app).supplierDeposits, state(app).advanceAllocations).unapplied, 100000);
});

test("a deposit can be corrected and voided from the Deposits tab; the history keeps both", async () => {
  const app = await shop();
  await app.api.commit((d) => P.recordDeposit(d, { id: "dep-1", supplierId: d.suppliers[0].id, amount: "10000", date: day(-1) }));
  await openTab(app, "deposits");
  ui(app).state.sup.editDepositId = "dep-1";
  app.api.renderAll();
  fillDeposit(app, { amount: "12000", date: day(-1), note: "corrected" });
  await ui(app).forms["sup-deposit"]();
  await settle();
  assert.equal(state(app).supplierDeposits[0].amount, 12000);
  assert.equal(state(app).supplierDeposits[0].history.length, 1);

  ui(app).state.sup.voidDepositId = "dep-1";
  app.api.renderAll();
  app.field("dvReason").value = "paid twice";
  await ui(app).forms["sup-dep-void"]();
  await settle();
  assert.equal(state(app).supplierDeposits[0].status, "voided");
  assert.equal(P.supplierPayable(state(app), sid(app), day(0)).paid, 0);
  assert.match(await openTab(app, "deposits"), /paid twice/);
});

test("the purchases page shows the cards, filters by date, and sorts by a column", async () => {
  const app = await shop();
  await app.api.commit((d) => {
    const old = P.saveDraft(d, { supplierId: d.suppliers[0].id, supplierInvoiceNumber: "OLD", invoiceDate: day(-40), lines: [{ productId: "p-tile", unit: "box", qty: "10", unitPrice: "1000" }] });
    P.confirmPurchase(d, old.purchase.id);
    const recent = P.saveDraft(d, { supplierId: d.suppliers[0].id, supplierInvoiceNumber: "NEW", invoiceDate: day(-1), lines: [{ productId: "p-tile", unit: "box", qty: "50", unitPrice: "1000" }] });
    return P.confirmPurchase(d, recent.purchase.id);
  });
  await app.api.commit((d) => P.recordDeposit(d, { supplierId: d.suppliers[0].id, amount: "70000", date: day(0) }));
  state(app).view = "purchases";
  ui(app).reset();
  app.api.renderAll();
  const html = app.field("purchasesRoot").innerHTML;
  for (const label of ["Total purchases", "Paid to suppliers", "Owed to suppliers", "Available advances"]) assert.match(html, new RegExp(label));
  assert.match(html, /60,000/, "all-time purchase value");
  assert.match(html, /70,000/, "the deposit is money paid, not a purchase");

  const f = ui(app).state.pur;
  f.from = day(-10);
  assert.equal(ui(app).filteredPurchases().length, 1, "the date filter keeps only the recent purchase");
  assert.match(ui(app).purchaseSummaryStrip(), /50,000/);
  f.from = "";
  f.sortKey = "total";
  f.sortDir = 1;
  const rows = ui(app).purchaseListHtml();
  assert.ok(rows.indexOf("10,000") < rows.indexOf("50,000"), "ascending by total");
});

test("every new screen is drawn in French and Arabic with no missing text", async () => {
  const app = await shop();
  await app.api.commit((d) => P.recordDeposit(d, { supplierId: d.suppliers[0].id, amount: "50000", date: day(-2), method: "other" }));
  await buy(app, 30, { advanceApply: "30000" });
  for (const language of ["fr", "ar"]) {
    await app.api.commit((d) => { d.settings.language = language; });
    for (const tab of ["overview", "deposits", "statement"]) {
      const html = await openTab(app, tab);
      assert.ok(html.length > 200);
      assert.ok(!/\b(?:fin|dep|adv|led|sup|pur|spay)\.[a-z]+(?:\.[A-Za-z]+)*\b/.test(html.replace(/data-[a-z-]+="[^"]*"/g, "").replace(/id="[^"]*"/g, "")), `${language}/${tab}: a text key was shown instead of text`);
    }
    state(app).view = "purchases";
    ui(app).reset();
    app.api.renderAll();
    const purchases = app.field("purchasesRoot").innerHTML;
    assert.ok(!/\b(?:fin|dep|adv|led)\.[a-z]+(?:\.[A-Za-z]+)*\b/.test(purchases.replace(/data-[a-z-]+="[^"]*"/g, "").replace(/id="[^"]*"/g, "")), `${language}: purchases page shows a text key`);
  }
  assert.match(await openTab(app, "statement"), /[\u0600-\u06FF]/, "Arabic text is on the page");
});

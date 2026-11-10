"use strict";

// Custom invoice items: lines of an invoice that are NOT Stock products (broken tiles, old ceramic, cement, a jacket...).
//   A  the rules for what is typed (validation.js): required fields, decimals, the free unit, the total
//   B  an invoice of custom items only, and of both kinds: totals, discounts, payment states, the stock never moves
//   C  the Sell page: quantity, unit and price of a custom line, remove, the dialog
//   D  editing a saved invoice and returning goods: custom lines stay custom lines, nothing moves in the inventory
//   E  deleting an invoice (the rollback) that has custom lines
//   F  an invoice sold in several deliveries that also has custom lines
//   G  saving: reload, backup export / import, invoices made before custom items existed, what the database refuses
//   H  what is printed and shown, and what the Dashboard counts
// Everything runs through the application's own functions against a disposable in-memory IndexedDB (no real data).

const test = require("node:test");
const assert = require("node:assert/strict");
const { sampleInvoice } = require("./helpers/modules");
const { loadApp } = require("./helpers/app");
const {
  V, plain, boot, addTile, sellLines, stockOf, invoiceById, snapshot, openEdit, typeQty, typePrice, removeLine,
} = require("./helpers/edit");

const A = globalThis.Analytics;

// The three example lines of the feature: 900 + 4,000 + 1,800 = 6,700.
const BROKEN = { name: "Broken Tiles", qty: "3", unit: "Box", unitPrice: "300" };
const JACKET = { name: "Jacket", qty: "1", unit: "Piece", unitPrice: "4000" };
const OLD = { name: "Old Ceramic", qty: "12", unit: "m²", unitPrice: "150" };
const THREE = [BROKEN, JACKET, OLD];

const addCustom = (api, line) => {
  const r = api.addCustomToSale(line);
  assert.equal(r.error, undefined, r.error);
  return r.item;
};

// Puts custom lines (and Stock lines) on the sale and completes it. Returns the saved invoice.
async function sell(ctx, { custom = [], stock = [], name = "Alex", paid = "", discount } = {}) {
  const { api } = ctx;
  for (const l of stock) assert.equal(api.addToSale(l.product.id, l.qty, l.unit || "box").ok, true);
  for (const c of custom) addCustom(api, c);
  const sale = api.getSale();
  sale.customer.name = name;
  sale.paidValue = paid;
  if (discount) { sale.discountType = discount.type; sale.discountValue = discount.value; }
  await api.completeSale();
  assert.equal(ctx.app.errorText("saleError"), "", ctx.app.errorText("saleError"));
  const all = api.getInvoices();
  return all[all.length - 1];
}

// Data made inside the application's own context compares by value: both sides are turned into plain data first.
const same = (actual, expected, message) => assert.deepEqual(actual === undefined ? actual : plain(actual), expected === undefined ? expected : plain(expected), message);

const productsOf = async (ctx) => plain((await ctx.api.db.loadAll()).products);
const logOf = (ctx) => plain(ctx.api.getState().settings.rollbackLog || []);

/* ==========================================================================
   A. What is typed
   ========================================================================== */

test("A: the three examples of the feature: name, quantity, unit and unit price give the total", () => {
  const read = (line) => V.readCustomItemInput(line);
  same(plain(read(BROKEN).item), { itemType: "custom", name: "Broken Tiles", qty: 3, unit: "Box", unitPrice: 300, total: 900 });
  same(plain(read(JACKET).item), { itemType: "custom", name: "Jacket", qty: 1, unit: "Piece", unitPrice: 4000, total: 4000 });
  same(plain(read(OLD).item), { itemType: "custom", name: "Old Ceramic", qty: 12, unit: "m²", unitPrice: 150, total: 1800 });
});

test("A: decimal quantities, free units, an optional note, a price of 0, and text cleaned of extra spaces", () => {
  const ok = (line) => { const r = V.readCustomItemInput(line); assert.equal(r.error, undefined, r.error); return r.item; };
  assert.equal(ok({ ...BROKEN, qty: "2.5", unitPrice: "120" }).total, 300);
  assert.equal(ok({ ...BROKEN, qty: "0.333", unitPrice: "100" }).total, 33.3);
  assert.equal(ok({ ...BROKEN, qty: "2,5".replace(",", ".") }).qty, 2.5);
  assert.equal(ok({ ...BROKEN, unit: "Sac 50 kg" }).unit, "Sac 50 kg", "any unit can be typed");
  assert.equal(ok({ ...BROKEN, unitPrice: "0" }).total, 0, "a free item is allowed");
  assert.equal(ok({ ...BROKEN, unitPrice: "10.456" }).unitPrice, 10.46, "money has 2 decimals everywhere in the app");
  const noted = ok({ ...BROKEN, name: "  Grout   white ", unit: "  Bag ", note: "  2 kg   bags " });
  assert.equal(noted.name, "Grout white");
  assert.equal(noted.unit, "Bag");
  assert.equal(noted.note, "2 kg bags");
  assert.equal("note" in ok(BROKEN), false, "no note, no field");
});

test("A: every required field is refused when it is missing or wrong, naming the field", () => {
  const bad = (change, field) => {
    const r = V.readCustomItemInput({ ...BROKEN, ...change });
    assert.equal(r.item, undefined);
    assert.equal(r.field, field);
    assert.ok(r.error, "a message");
  };
  bad({ name: "" }, "name");
  bad({ name: "   " }, "name");
  bad({ name: "x".repeat(V.CUSTOM_NAME_MAX + 1) }, "name");
  bad({ qty: "" }, "qty");
  bad({ qty: "0" }, "qty");
  bad({ qty: "-2" }, "qty");
  bad({ qty: "abc" }, "qty");
  bad({ unit: "" }, "unit");
  bad({ unit: "u".repeat(V.CUSTOM_UNIT_MAX + 1) }, "unit");
  bad({ unitPrice: "" }, "price");
  bad({ unitPrice: "-1" }, "price");
  bad({ unitPrice: "cheap" }, "price");
  bad({ note: "n".repeat(V.CUSTOM_NOTE_MAX + 1) }, "note");
});

/* ==========================================================================
   B. An invoice of custom items, and of both kinds
   ========================================================================== */

test("B: an invoice with ONLY custom items: saved as custom lines, totals right, the inventory is not touched at all", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 40 });
  const before = await productsOf(ctx);
  const inv = await sell(ctx, { custom: THREE, paid: "6700" });

  assert.equal(inv.items.length, 3);
  same(inv.items.map((i) => i.itemType), ["custom", "custom", "custom"]);
  same(inv.items.map((i) => [i.name, i.qty, i.unit, i.unitPrice, i.total]), [
    ["Broken Tiles", 3, "Box", 300, 900], ["Jacket", 1, "Piece", 4000, 4000], ["Old Ceramic", 12, "m²", 150, 1800],
  ]);
  for (const item of inv.items) {
    for (const key of ["productId", "sellingUnit", "stockUnit", "stockDeducted", "lineId"]) assert.equal(key in item, false, `a custom line has no ${key}`);
  }
  assert.equal(inv.subtotal, 6700);
  assert.equal(inv.total, 6700);
  assert.equal(V.invoiceProblem(inv), "");
  assert.equal(ctx.api.paymentInfo(inv).cls, "paid");
  same(await productsOf(ctx), before, "every product, stock included, is exactly as it was");
  assert.equal(stockOf(ctx.api, tile.id), 40);
  assert.equal((await ctx.api.db.loadAll()).products.length, 1, "no product was created");
  assert.equal(ctx.api.getInvoices().length, 1);
});

test("B: custom items next to Stock products: only the product takes stock, and it behaves exactly as before", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 20 });
  const inv = await sell(ctx, { stock: [{ product: tile, qty: "2" }], custom: THREE, paid: "10700" });

  assert.equal(inv.items.length, 4);
  const [product, ...custom] = inv.items;
  assert.equal(product.itemType, "inventory");
  assert.equal(product.productId, tile.id);
  assert.equal(product.qty, 2);
  assert.equal(product.unitPrice, 2000);
  assert.equal(product.total, 4000);
  assert.equal(product.stockDeducted, 2);
  same(custom.map((i) => i.itemType), ["custom", "custom", "custom"]);
  assert.equal(inv.subtotal, 10700);
  assert.equal(stockOf(ctx.api, tile.id), 18, "2 boxes of the tile, and nothing for the custom lines");
  assert.equal(V.invoiceProblem(inv), "");
});

test("B: the same product, inventory only: nothing changes but the explicit item type", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 20 });
  const inv = await sell(ctx, { stock: [{ product: tile, qty: "3" }], paid: "6000" });
  assert.equal(inv.items.length, 1);
  assert.equal(inv.items[0].itemType, "inventory");
  assert.equal(inv.items[0].productId, tile.id);
  assert.equal(inv.items[0].sellingUnit, "box");
  assert.equal(inv.total, 6000);
  assert.equal(stockOf(ctx.api, tile.id), 17);
});

test("B: decimal quantities and different units on one invoice", async () => {
  const ctx = await boot();
  const inv = await sell(ctx, {
    custom: [
      { name: "Cement", qty: "2.5", unit: "Bag", unitPrice: "900" },
      { name: "Grout", qty: "0.75", unit: "kg", unitPrice: "400" },
      { name: "Skirting", qty: "7.2", unit: "m", unitPrice: "250" },
    ],
  });
  same(inv.items.map((i) => i.total), [2250, 300, 1800]);
  assert.equal(inv.subtotal, 4350);
  same(inv.items.map((i) => i.unit), ["Bag", "kg", "m"], "the unit stays as it was typed");
  assert.equal(ctx.api.paymentInfo(inv).cls, "unpaid");
});

test("B: invoice discounts (amount and percent) apply to custom lines, and every payment state and the balance work", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 20 });

  const percent = await sell(ctx, { custom: THREE, discount: { type: "percent", value: "10" }, paid: "2000" });
  assert.equal(percent.subtotal, 6700);
  assert.equal(percent.discount, 670);
  assert.equal(percent.total, 6030);
  let info = ctx.api.paymentInfo(percent);
  assert.equal(info.cls, "partial");
  assert.equal(info.remaining, 4030);

  const amount = await sell(ctx, { stock: [{ product: tile, qty: "1" }], custom: [BROKEN], discount: { type: "amount", value: "500" }, paid: "" });
  assert.equal(amount.subtotal, 2900);
  assert.equal(amount.total, 2400);
  info = ctx.api.paymentInfo(amount);
  assert.equal(info.cls, "unpaid");
  assert.equal(info.remaining, 2400);

  assert.equal((await ctx.api.addPayment(amount.id, "2400")).error, undefined);
  assert.equal(ctx.api.paymentInfo(invoiceById(ctx.api, amount.id)).cls, "paid");
  assert.equal(ctx.api.paymentInfo(invoiceById(ctx.api, amount.id)).remaining, 0);
  assert.equal(stockOf(ctx.api, tile.id), 19, "one box, nothing for the custom line");
});

test("B: a sale with a custom line that is not valid is refused and nothing is saved", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 20 });
  const line = addCustom(ctx.api, BROKEN);
  line.qty = 0;   // what a stale screen could hold
  await ctx.api.completeSale();
  assert.match(ctx.app.errorText("saleError"), /greater than 0/);
  assert.equal(ctx.api.getInvoices().length, 0);
  assert.equal(stockOf(ctx.api, tile.id), 20);
});

/* ==========================================================================
   C. The Sell page
   ========================================================================== */

test("C: quantity, unit and price of a custom line change the line and the totals; wrong values are refused", async () => {
  const ctx = await boot();
  const line = addCustom(ctx.api, BROKEN);
  const { api } = ctx;
  const totals = () => api.calculateTotals(api.getSale());
  assert.equal(totals().subtotal, 900);

  same(plain(api.updateSaleQuantity(line.lineId, "2.5")), {});
  assert.equal(totals().subtotal, 750);
  assert.match(api.updateSaleQuantity(line.lineId, "0").error, /greater than 0/);
  assert.match(api.updateSaleQuantity(line.lineId, "").error, /greater than 0/);
  assert.equal(line.qty, 2.5, "a refused value leaves the line as it was");

  same(plain(api.updateSalePrice(line.lineId, "400")), {});
  assert.equal(totals().subtotal, 1000);
  assert.equal("priceOverridden" in line, false, "a custom line has no catalogue price to differ from");
  assert.ok(api.updateSalePrice(line.lineId, "-5").error);
  assert.ok(api.updateSalePrice(line.lineId, "").error);

  same(plain(api.updateCustomUnit(line.lineId, "  Pallet ")), {});
  assert.equal(line.unit, "Pallet");
  assert.ok(api.updateCustomUnit(line.lineId, "   ").error);
  assert.equal(line.unit, "Pallet");

  api.removeFromSale(line.lineId);
  assert.equal(api.getSale().items.length, 0);
  assert.equal(totals().subtotal, 0);
});

test("C: the sale table shows a custom line without stock, a unit box and an Edit button; syncing with the products keeps it", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 4 });
  addCustom(ctx.api, { ...BROKEN, note: "white, 60x60" });
  assert.equal(ctx.api.addToSale(tile.id, "1", "box").ok, true);
  ctx.api.renderSale();
  const html = ctx.app.field("saleBody").innerHTML;
  assert.match(html, /data-type="custom"/);
  assert.match(html, /Broken Tiles/);
  assert.match(html, /white, 60x60/);
  assert.match(html, /data-field="cunit"/);
  assert.match(html, /data-action="edit-custom"/);
  assert.match(html, /Custom item · not in stock/);
  assert.equal((html.match(/Available:/g) || []).length, 1, "only the real product shows its stock");

  const notes = ctx.api.syncSaleWithProducts();
  same(notes, []);
  assert.equal(ctx.api.getSale().items.length, 2);
  await ctx.api.deleteProduct(tile.id);
  ctx.api.syncSaleWithProducts();
  same(ctx.api.getSale().items.map((i) => i.itemType), ["custom"], "a deleted product leaves the sale, a custom line stays");
});

test("C: the dialog adds a custom item, keeps itself open with a message when something is wrong, and edits an existing line", async () => {
  const ctx = await boot();
  const { api, app } = ctx;
  const set = (values) => {
    app.field("customName").value = values.name;
    app.field("customQty").value = values.qty;
    app.field("customUnit").value = values.unit;
    app.field("customPrice").value = values.unitPrice;
    app.field("customNote").value = values.note || "";
  };

  assert.equal(api.openCustomDialog(), true);
  assert.equal(app.field("customDialogTitle").textContent, "Add a custom item");
  assert.equal(app.field("customConfirm").textContent, "Add to sale");
  assert.equal(app.field("customQty").value, "1");
  assert.equal(app.field("customName").value, "");

  // the total follows the quantity and the price
  app.field("customQty").value = "3";
  app.field("customPrice").value = "300";
  api.updateCustomTotal();
  assert.equal(app.field("customTotal").textContent, api.money(900));

  set({ name: "", qty: "1", unit: "Box", unitPrice: "100" });
  assert.equal(api.submitCustomDialog().field, "name");
  assert.match(app.errorText("customError"), /product name/);
  set({ name: "Cement", qty: "1", unit: "", unitPrice: "100" });
  assert.equal(api.submitCustomDialog().field, "unit");
  set({ name: "Cement", qty: "1", unit: "Bag", unitPrice: "" });
  assert.equal(api.submitCustomDialog().field, "price");
  assert.equal(api.getSale().items.length, 0, "nothing was added by a refused form");

  set({ name: "Cement", qty: "2.5", unit: "Bag", unitPrice: "900", note: "grey" });
  assert.equal(api.submitCustomDialog().error, undefined);
  assert.equal(app.errorText("customError"), "");
  const [line] = api.getSale().items;
  same([line.name, line.qty, line.unit, line.unitPrice, line.note], ["Cement", 2.5, "Bag", 900, "grey"]);

  // edit the same line
  assert.equal(api.openCustomDialog(line.lineId), true);
  assert.equal(app.field("customDialogTitle").textContent, "Edit custom item");
  assert.equal(app.field("customName").value, "Cement");
  assert.equal(app.field("customQty").value, "2.5");
  assert.equal(app.field("customUnit").value, "Bag");
  assert.equal(app.field("customPrice").value, "900");
  assert.equal(app.field("customNote").value, "grey");
  set({ name: "Cement 50kg", qty: "3", unit: "Sac", unitPrice: "950" });
  assert.equal(api.submitCustomDialog().error, undefined);
  assert.equal(api.getSale().items.length, 1, "edited, not added again");
  same([line.name, line.qty, line.unit, line.unitPrice], ["Cement 50kg", 3, "Sac", 950]);
  assert.equal("note" in line, false, "the note was cleared");

  assert.equal(api.openCustomDialog("no-such-line"), false);
});

/* ==========================================================================
   D. Editing a saved invoice and returning goods
   ========================================================================== */

test("D: editing a saved invoice keeps custom lines custom: name, quantity, unit and price can change, the inventory never does", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 20 });
  const inv = await sell(ctx, { stock: [{ product: tile, qty: "2" }], custom: [BROKEN, JACKET], paid: "1000" });
  const before = await productsOf(ctx);
  const original = plain(inv);

  const sale = openEdit(ctx, inv);
  assert.equal(sale.items.length, 3);
  const [, broken] = sale.items;
  assert.equal(broken.itemType, "custom");
  assert.equal(broken.productId, undefined);
  assert.equal(ctx.api.editDirty(), false);

  assert.equal(ctx.api.updateCustomLine(broken.lineId, { name: "Broken tiles (grey)", qty: "4", unit: "Boxes", unitPrice: "250", note: "grey" }).error, undefined);
  assert.equal(typeQty(ctx.api, 2, "2").error, undefined);
  assert.equal(typePrice(ctx.api, 2, "3500").error, undefined);
  assert.equal(ctx.api.editDirty(), true);
  assert.equal(ctx.api.editPlan().error, undefined);
  await ctx.api.saveInvoiceEdit();

  const saved = invoiceById(ctx.api, inv.id);
  assert.equal(ctx.api.getInvoices().length, 1);
  assert.equal(saved.invoiceNumber, original.invoiceNumber);
  assert.equal(saved.date, original.date);
  same(plain(saved.payments), original.payments, "payments are never edited");
  same(plain(saved.items[1]), { itemType: "custom", name: "Broken tiles (grey)", note: "grey", qty: 4, unit: "Boxes", unitPrice: 250, total: 1000 });
  same(plain(saved.items[2]), { itemType: "custom", name: "Jacket", qty: 2, unit: "Piece", unitPrice: 3500, total: 7000 });
  same(plain(saved.items[0]), original.items[0], "the product line is as it was");
  assert.equal(saved.subtotal, 4000 + 1000 + 7000);
  assert.equal(saved.total, 12000);
  assert.equal(V.invoiceProblem(saved), "");
  same(await productsOf(ctx), before, "no product changed, stock included");
  assert.equal(saved.edits.length, 1);
  assert.equal(saved.edits[0].totalBefore, original.total);
  assert.equal(saved.edits[0].totalAfter, 12000);
  assert.equal(saved.edits[0].stock, undefined, "the edit moved no stock");
});

test("D: adding a custom item to a saved invoice, and removing one from it, never moves stock", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 20 });
  const inv = await sell(ctx, { stock: [{ product: tile, qty: "2" }], custom: [BROKEN], paid: "" });
  const before = await productsOf(ctx);

  openEdit(ctx, inv);
  addCustom(ctx.api, OLD);
  assert.equal(ctx.api.editPlan().error, undefined);
  assert.equal(ctx.api.editPlan().stockChanges.size, 0);
  await ctx.api.saveInvoiceEdit();
  let saved = invoiceById(ctx.api, inv.id);
  same(saved.items.map((i) => i.itemType), ["inventory", "custom", "custom"]);
  assert.equal(saved.total, 4000 + 900 + 1800);
  same(await productsOf(ctx), before);

  openEdit(ctx, saved);
  removeLine(ctx.api, 1);
  assert.equal(ctx.api.editPlan().stockChanges.size, 0);
  await ctx.api.saveInvoiceEdit();
  saved = invoiceById(ctx.api, inv.id);
  same(saved.items.map((i) => i.name === "Old Ceramic" || i.itemType), ["inventory", true]);
  assert.equal(saved.total, 4000 + 1800);
  same(await productsOf(ctx), before, "removing a custom line gave nothing back to stock");
});

test("D: a return: a paid invoice made cheaper by removing a custom line owes a refund, and stock stays put", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 20 });
  const inv = await sell(ctx, { stock: [{ product: tile, qty: "2" }], custom: [JACKET], paid: "8000" });
  assert.equal(ctx.api.paymentInfo(inv).cls, "paid");
  const before = await productsOf(ctx);

  openEdit(ctx, inv);
  removeLine(ctx.api, 1);   // the jacket comes back
  const plan = ctx.api.editPlan();
  assert.equal(plan.error, undefined);
  assert.equal(plan.refundDue, 4000);
  assert.equal(plan.stockChanges.size, 0, "a returned custom item gives nothing back to stock");
  await ctx.api.saveInvoiceEdit();
  assert.equal((await ctx.api.recordRefund(inv.id, "4000")).error, undefined);
  const saved = invoiceById(ctx.api, inv.id);
  assert.equal(saved.items.length, 1);
  assert.equal(V.refundedTotal(saved), 4000);
  same(await productsOf(ctx), before);
});

test("D: returning a Stock product from a mixed invoice gives back that stock only; the custom lines stay as they are", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 20 });
  const inv = await sell(ctx, { stock: [{ product: tile, qty: "5" }], custom: [BROKEN, OLD], paid: "" });
  assert.equal(stockOf(ctx.api, tile.id), 15);

  openEdit(ctx, inv);
  assert.equal(typeQty(ctx.api, 0, 3).error, undefined);   // 2 boxes come back
  await ctx.api.saveInvoiceEdit();
  assert.equal(stockOf(ctx.api, tile.id), 17);
  const saved = invoiceById(ctx.api, inv.id);
  same(plain(saved.items.slice(1)), plain(inv.items.slice(1)), "the custom lines did not change");
  assert.equal(saved.total, 3 * 2000 + 900 + 1800);
});

test("D: removing every line of an invoice that has only custom items deletes it, with nothing to restore", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 20 });
  const inv = await sell(ctx, { custom: THREE, paid: "2000" });
  const before = await productsOf(ctx);

  openEdit(ctx, inv);
  while (ctx.api.getSale().items.length) removeLine(ctx.api, 0);
  const plan = ctx.api.editPlan();
  assert.equal(plan.deleted, true);
  assert.equal(plan.stock.length, 0);
  same(plan.notRestored, [], "a custom line is never reported as 'could not be restored to stock'");
  ctx.app.answer(true);
  await ctx.api.saveInvoiceEdit();

  assert.equal(ctx.api.getInvoices().length, 0);
  same(await productsOf(ctx), before);
  assert.equal(stockOf(ctx.api, tile.id), 20);
  const [entry] = logOf(ctx);
  assert.equal(entry.reason, "edit");
  assert.equal(entry.refund, 2000);
  same(entry.stock, []);
  assert.equal(entry.notRestored, undefined);
  same(entry.items.map((i) => [i.name, i.qty, i.unit, i.custom]), [["Broken Tiles", 3, "Box", true], ["Jacket", 1, "Piece", true], ["Old Ceramic", 12, "m²", true]]);
});

test("D: a custom line can not be turned into a product or the other way round by an edit; a stale edit is refused", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 20 });
  const inv = await sell(ctx, { stock: [{ product: tile, qty: "1" }], custom: [BROKEN] });
  const before = await productsOf(ctx);
  const sale = openEdit(ctx, inv);
  // a custom line that lost its type (what a damaged screen state would look like) is refused, never treated as a product
  sale.items[1].itemType = "inventory";
  assert.ok(ctx.api.editPlan().error);
  sale.items[1].itemType = "custom";
  assert.equal(ctx.api.editPlan().error, undefined);
  // a custom line with a quantity the rules refuse
  sale.items[1].qty = -1;
  assert.match(ctx.api.editPlan().error, /greater than 0/);
  ctx.api.cancelInvoiceEdit();
  same(await productsOf(ctx), before);
});

/* ==========================================================================
   E. Deleting an invoice
   ========================================================================== */

test("E: deleting a mixed invoice puts the product's stock back and reports nothing missing for the custom lines", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 20 });
  const inv = await sell(ctx, { stock: [{ product: tile, qty: "4" }], custom: THREE, paid: "5000" });
  assert.equal(stockOf(ctx.api, tile.id), 16);
  assert.equal(V.invoiceProblem(inv), "");

  await ctx.api.deleteInvoice(inv.id);
  assert.equal(ctx.api.getInvoices().length, 0);
  assert.equal(stockOf(ctx.api, tile.id), 20);
  const [entry] = logOf(ctx);
  same(entry.stock.map((s) => [s.productId, s.qty]), [[tile.id, 4]]);
  assert.equal(entry.notRestored, undefined);
  assert.equal(entry.refund, 5000);
  assert.equal((await ctx.api.db.loadAll()).products.length, 1);
});

test("E: deleting an invoice of custom items only changes no product and leaves no stock record", async () => {
  const ctx = await boot();
  await addTile(ctx, { stock: 7 });
  const before = await productsOf(ctx);
  const inv = await sell(ctx, { custom: THREE });
  await ctx.api.deleteInvoice(inv.id);
  assert.equal(ctx.api.getInvoices().length, 0);
  same(await productsOf(ctx), before);
  same(logOf(ctx)[0].stock, []);
  assert.equal(logOf(ctx)[0].notRestored, undefined);
});

test("E: stockHeld never lists a custom line, even one carrying stray stock fields", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 20 });
  const inv = await sell(ctx, { stock: [{ product: tile, qty: "2" }], custom: [BROKEN] });
  same([...ctx.api.stockHeld(inv).keys()], [tile.id]);
  const stray = plain(inv);
  stray.items[1].productId = tile.id;
  stray.items[1].stockDeducted = 9;
  same([...ctx.api.stockHeld(stray).entries()].map(([id, h]) => [id, h.qty]), [[tile.id, 2]], "a custom line is skipped by its type, whatever else it carries");
});

/* ==========================================================================
   F. An invoice sold in several deliveries
   ========================================================================== */

test("F: custom lines on an invoice delivered in steps: never 'to collect', never collected, and the Stock line works as before", async () => {
  const ctx = await boot();
  const { api } = ctx;
  const tile = await addTile(ctx, { stock: 10 });
  assert.equal(api.addToSale(tile.id, "1", "box").ok, true);
  const line = api.getSale().items[0];
  same(plain(api.setSalePartial(line.lineId, true)), {});
  assert.equal(api.updateSaleQuantity(line.lineId, "15").error, undefined);
  addCustom(api, JACKET);
  api.getSale().paidValue = "34000";
  await api.completeSale();
  assert.equal(ctx.app.errorText("saleError"), "", ctx.app.errorText("saleError"));
  const inv = api.getInvoices()[0];

  assert.equal(V.invoiceProblem(inv), "", "a delivery log next to a custom line is valid");
  assert.equal(inv.items[1].itemType, "custom");
  assert.equal(stockOf(api, tile.id), 0, "the 10 boxes there were left with the sale");
  const detail = V.deliveryDetail(inv);
  assert.equal(detail.tracked, true);
  same(detail.lines.map((l) => [l.qty, l.delivered, l.remaining]), [[15, 10, 5], [1, 1, 0]]);
  assert.equal(detail.toCollect.length, 1);
  assert.equal(detail.status, "partial");

  // the pick-up: the custom line can not be collected, the product can
  const custom = inv.items[1];
  const refused = await api.recordCollection(inv.id, [{ lineId: custom.lineId, qty: "1" }]);
  assert.ok(refused.error);
  await api.addStock(tile.id, 5);
  const done = await api.recordCollection(inv.id, [{ lineId: inv.items[0].lineId, qty: "5" }]);
  assert.equal(done.error, undefined);
  assert.equal(stockOf(api, tile.id), 0);
  assert.equal(V.deliveryDetail(invoiceById(api, inv.id)).status, "complete");

  // the delivery box and the collection document list goods only
  api.viewInvoice(inv.id);
  api.renderDeliveryBox();
  assert.doesNotMatch(ctx.app.field("delBody").innerHTML, /Jacket/);
  assert.match(ctx.app.field("delBody").innerHTML, /Everton Grey/);
});

test("F: on an invoice delivered in steps a custom price can be corrected, but not its quantity, and no custom line can be added", async () => {
  const ctx = await boot();
  const { api } = ctx;
  const tile = await addTile(ctx, { stock: 10 });
  assert.equal(api.addToSale(tile.id, "1", "box").ok, true);
  const line = api.getSale().items[0];
  api.setSalePartial(line.lineId, true);
  api.updateSaleQuantity(line.lineId, "15");
  addCustom(api, JACKET);
  api.getSale().paidValue = "34000";
  await api.completeSale();
  const inv = api.getInvoices()[0];
  const before = await productsOf(ctx);

  openEdit(ctx, inv);
  assert.match(api.addCustomToSale(JACKET).error, /delivery record/);
  assert.equal(api.openCustomDialog(), false);
  typePrice(api, 1, "4500");
  assert.equal(api.editPlan().error, undefined);
  await api.saveInvoiceEdit();
  const saved = invoiceById(api, inv.id);
  assert.equal(saved.items[1].unitPrice, 4500);
  assert.equal(saved.total, 30000 + 4500);
  same(await productsOf(ctx), before);
  assert.equal(V.invoiceProblem(saved), "");

  openEdit(ctx, saved);
  assert.equal(typeQty(api, 1, "2").error, undefined);
  assert.ok(api.editPlan().error, "the quantity of a delivered invoice's line is a record");
  api.cancelInvoiceEdit();
});

/* ==========================================================================
   G. Saving, reloading, backups
   ========================================================================== */

test("G: custom lines survive closing and reopening the application, and the invoice can be shown again", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 20 });
  const inv = await sell(ctx, { stock: [{ product: tile, qty: "2" }], custom: [{ ...BROKEN, note: "grey" }, JACKET], paid: "3000" });
  const saved = plain(inv);

  const again = loadApp({ indexedDB: ctx.app.indexedDB });
  await again.start();
  const [loaded] = again.api.getInvoices();
  same(plain(loaded.items), saved.items);
  assert.equal(loaded.total, saved.total);
  assert.equal(again.api.paymentInfo(loaded).remaining, saved.total - 3000);
  assert.equal(again.api.getProducts()[0].stock, 18);

  again.api.viewInvoice(loaded.id);
  assert.match(again.api.invoiceHtml(loaded), /Jacket/);
  // and it can still be edited after the reload
  const r = again.api.startEditInvoice(loaded.id);
  assert.equal(r.error, undefined);
  assert.equal(again.api.getSale().items[1].itemType, "custom");
  assert.equal(again.api.editDirty(), false);
});

test("G: backup export and import keep custom lines exactly, the products untouched, and the restored invoice behaves", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 20 });
  const inv = await sell(ctx, { stock: [{ product: tile, qty: "2" }], custom: [{ ...BROKEN, note: "grey" }, OLD], paid: "1000" });
  await ctx.api.exportBackup();
  const text = await ctx.app.downloadedText();
  const parsed = V.parseBackup(text);
  assert.equal(parsed.error, undefined, parsed.error);
  same(plain(parsed.data.invoices[0].items), plain(inv.items), "the file holds the custom lines as saved");

  const fresh = loadApp();
  await fresh.start();
  await fresh.api.importBackup(fresh.file(text));
  const [restored] = fresh.api.getInvoices();
  same(plain(restored.items), plain(inv.items));
  assert.equal(restored.total, inv.total);
  assert.equal(fresh.api.getProducts()[0].stock, 18);
  assert.equal(V.invoiceProblem(restored), "");

  // the restored invoice can be rolled back: only the product's stock returns
  await fresh.api.deleteInvoice(restored.id);
  assert.equal(fresh.api.getProducts()[0].stock, 20);
});

test("G: an invoice made before custom items existed (no item type) is an inventory invoice and rolls back as always", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 20 });
  const inv = await sell(ctx, { stock: [{ product: tile, qty: "3" }], paid: "6000" });
  await ctx.api.exportBackup();
  const legacy = JSON.parse(await ctx.app.downloadedText());
  for (const item of legacy.data.invoices[0].items) delete item.itemType;   // what every earlier backup looks like
  assert.equal(JSON.stringify(legacy).includes("itemType"), false);

  const fresh = loadApp();
  await fresh.start();
  await fresh.api.importBackup(fresh.file(JSON.stringify(legacy)));
  const [restored] = fresh.api.getInvoices();
  assert.equal(restored.items[0].itemType, undefined, "an old line is not rewritten");
  assert.equal(V.isCustomItem(restored.items[0]), false);
  assert.equal(V.invoiceProblem(restored), "");
  assert.equal(fresh.api.getProducts()[0].stock, 17);
  same([...fresh.api.stockHeld(restored).keys()], [tile.id]);
  await fresh.api.deleteInvoice(restored.id);
  assert.equal(fresh.api.getProducts()[0].stock, 20, "an old invoice restores its stock exactly as before");
  assert.equal(inv.items[0].stockDeducted, 3);
});

test("G: the rules refuse a custom line tied to the inventory, a bad type, or a bad custom field", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 20 });
  const inv = await sell(ctx, { custom: [BROKEN] });
  const bad = (change) => { const copy = plain(inv); Object.assign(copy.items[0], change); return V.invoiceProblem(copy); };
  assert.equal(bad({}), "");
  assert.ok(bad({ productId: tile.id }), "a custom line has no product");
  assert.ok(bad({ sellingUnit: "box" }), "a custom line has no selling unit");
  assert.ok(bad({ stockUnit: "box" }));
  assert.ok(bad({ stockDeducted: 3 }), "a custom line never takes stock");
  assert.equal(bad({ stockDeducted: 0 }), "");
  assert.ok(bad({ itemType: "service" }), "an unknown item type");
  assert.ok(bad({ name: "" }));
  assert.ok(bad({ unit: "" }));
  assert.ok(bad({ note: 5 }));
  assert.ok(bad({ total: -1 }));
  assert.ok(bad({ qty: 0 }));

  // the database refuses it too: an invoice like that never reaches the disk
  const before = await snapshot(ctx);
  const r = await ctx.api.commit((d) => { d.invoices[0].items[0].productId = tile.id; });
  assert.ok(r.error, "the save was refused");
  same(await snapshot(ctx), before);
});

test("G: a line total that is the typed quantity times the typed price never trips the backup check, even with fractions of a cent", async () => {
  const ctx = await boot();
  const inv = await sell(ctx, { custom: [{ name: "A", qty: "1.005", unit: "m", unitPrice: "1" }, { name: "B", qty: "0.333", unit: "m", unitPrice: "1.01" }, { name: "C", qty: "2.5", unit: "kg", unitPrice: "3.33" }] });
  same(V.invoiceWarnings(inv), []);
});

/* ==========================================================================
   H. What is printed and shown, and what the Dashboard counts
   ========================================================================== */

test("H: the printed invoice and the preview show each custom line: name, note, quantity with its unit, unit price and total", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 20 });
  const inv = await sell(ctx, { stock: [{ product: tile, qty: "1" }], custom: [{ ...BROKEN, note: "white, 60x60" }, JACKET, OLD], paid: "" });
  const parts = ctx.api.invoiceParts(inv);
  assert.equal(parts.rows.length, 4);
  const [product, broken, jacket, old] = parts.rows;
  assert.match(product, /Everton Grey/);
  assert.match(broken, /Broken Tiles/);
  assert.match(broken, /white, 60x60/);
  assert.match(broken, /3 Box/);
  assert.match(broken, /300 <span class="inv-unit">\/ Box<\/span>/);
  assert.match(broken, /<td class="num">900<\/td>/);
  assert.match(jacket, /Jacket/);
  assert.match(jacket, /4,000/);
  assert.match(old, /12 m²/);
  assert.match(old, /\/ m²/);
  assert.match(old, /1,800/);
  for (const row of [broken, jacket, old]) assert.doesNotMatch(row, /deleted product/);

  const html = ctx.api.invoiceHtml(inv);
  assert.match(html, /Old Ceramic/);
  assert.match(html, /Jacket/);
  // a name typed with markup is shown as text
  const hostile = await sell(ctx, { custom: [{ name: "<img src=x onerror=alert(1)>", qty: "1", unit: "<b>Box</b>", unitPrice: "10", note: "<script>x</script>" }] });
  const out = ctx.api.invoiceHtml(hostile);
  assert.doesNotMatch(out, /<img src=x/);
  assert.doesNotMatch(out, /<script>x/);
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.equal(ctx.api.printItems(inv).length > 0, true);
});

test("H: the live preview of a sale on screen, and of an invoice being edited, includes the custom lines", async () => {
  const ctx = await boot();
  addCustom(ctx.api, BROKEN);
  const draft = ctx.api.draftInvoice();
  assert.equal(draft.items[0].itemType, "custom");
  assert.equal(draft.total, 900);
  assert.match(ctx.api.invoiceHtml(draft), /Broken Tiles/);

  ctx.api.clearSale();
  const inv = await sell(ctx, { custom: [BROKEN] });
  openEdit(ctx, inv);
  typeQty(ctx.api, 0, 5);
  const preview = ctx.api.editPreviewInvoice();
  assert.equal(preview.items[0].qty, 5);
  assert.equal(preview.total, 1500);
  assert.equal(invoiceById(ctx.api, inv.id).total, 900, "the saved invoice is untouched until Save");
});

test("H: the Dashboard's product rankings count products only; custom items do not appear in them", async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 20 });
  await sell(ctx, { stock: [{ product: tile, qty: "2" }], custom: [JACKET, BROKEN], paid: "8900" });
  const s = ctx.api.getState();
  const f = A.compute({ invoices: s.invoices, products: s.products, debtTransfers: s.debtTransfers, purchases: s.purchases }, { now: new Date(), lowStock: 5 });
  const names = f.bestSelling.byRevenue.map((p) => p.name);
  same(names, ["Everton Grey"]);
  same(f.bestSelling.byUnit.flatMap((u) => u.items.map((p) => p.name)), ["Everton Grey"]);
});

test("H: invoices of any language show the same custom unit as typed (a free unit is never translated)", async () => {
  const ctx = await boot();
  const inv = await sell(ctx, { custom: [BROKEN] });
  for (const language of ["fr", "ar", "en"]) {
    ctx.api.applyData({ ...(await ctx.api.db.loadAll()), settings: { ...ctx.api.getState().settings, language } });
    const row = ctx.api.invoiceParts(invoiceById(ctx.api, inv.id)).rows[0];
    assert.match(row, /Box/, language);
    assert.match(row, /Broken Tiles/, language);
  }
});

test("H: sample invoices from the shared fixtures (made before this feature) still print and total exactly as before", () => {
  const api = loadApp().api;
  api.applyData({ products: [], invoices: [], settings: { ...api.DEFAULT_SETTINGS }, counter: 0, lastSaved: "" });
  const legacy = sampleInvoice();
  assert.equal(V.invoiceProblem(legacy), "");
  assert.equal(api.invoiceParts(legacy).rows.length, legacy.items.length);
});

"use strict";
// Prints a valid Invoisy backup (JSON) with a small made-up shop for supplier_deposits_check.py: one product and three suppliers
//   Timgad Ceramic   100,000 DA bought, 150,000 DA deposited (net -50,000: prepaid), the invoice not yet settled from the deposit
//   Sétif Carrelage  80,000 + 20,000 DA bought, 30,000 DA paid on an invoice (net 70,000: owed)
//   Hodna Tiles      only a 50,000 DA deposit, 30,000 DA of it applied to a purchase (net -20,000)
// No real data.
const { boot, addTile } = require("../helpers/edit");
require("../helpers/modules");
const P = globalThis.Purchases;
const day = (offset) => P.addDays(P.toDay(new Date()), offset || 0);

(async () => {
  const ctx = await boot();
  await addTile(ctx, { stock: 100 });
  const productId = ctx.api.getState().products[0].id;
  const commit = async (fn) => { const r = await ctx.api.commit(fn); if (r && r.error) throw new Error(r.error); return r; };
  for (const [name, phone] of [["Timgad Ceramic", "0555 12 34 56"], ["Sétif Carrelage", "0661 00 11 22"], ["Hodna Tiles", "0770 98 76 54"]]) {
    await commit((d) => P.saveSupplier(d, { name, phone, paymentTermsDays: "30" }));
  }
  const ids = ctx.api.getState().suppliers.map((s) => s.id);
  const buy = (supplierId, number, boxes, invoiceDate, extra, options) => commit((d) => {
    const saved = P.saveDraft(d, { supplierId, supplierInvoiceNumber: number, invoiceDate, lines: [{ productId, unit: "box", qty: String(boxes), unitPrice: "1000" }], ...(extra || {}) });
    if (saved.error) return saved;
    return P.confirmPurchase(d, saved.purchase.id, options);
  });
  await buy(ids[0], "FA-100", 100, day(-12));
  await commit((d) => P.recordDeposit(d, { supplierId: ids[0], amount: "150000", date: day(-5), method: "bank", reference: "VIR-2026-31", note: "autumn container" }));
  await buy(ids[1], "SC-1", 80, day(-20), null, { initialPayment: { amount: "30000", date: day(-20) } });
  await buy(ids[1], "SC-2", 20, day(-3));
  await commit((d) => P.recordDeposit(d, { supplierId: ids[2], amount: "50000", date: day(-9), method: "cash" }));
  await buy(ids[2], "HT-1", 30, day(-2), { advanceApply: "30000" });
  await ctx.api.autoBackup.flushNow();
  process.stdout.write(ctx.handle.content);
})();

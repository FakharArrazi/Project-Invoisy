"use strict";
// Prints a valid Invoisy backup (JSON) with a small made-up shop: one product and 13 invoices with different customers,
// dates, amounts and payments, the newest one a cancelled sale as an EARLIER version saved it. Used by invoices_page_check.py; no real data.
const { boot, addTile, sellLines } = require("../helpers/edit");

(async () => {
  const ctx = await boot();
  const tile = await addTile(ctx, { stock: 500 });
  const names = ["bravo", "Alpha", "Charlie", "alpha two", "Delta", "A very long customer name that keeps going and going to see how the table copes with it"];
  const qtys = [9, 2, 11, 1, 5, 12, 3, 8, 4, 10, 6, 7, 2];
  for (let i = 0; i < 13; i++) {
    await sellLines(ctx, [{ product: tile, qty: String(qtys[i]) }], {
      name: names[i % names.length],
      paid: i % 3 === 0 ? "1000" : i % 3 === 1 ? "" : String(qtys[i] * 2000),
    });
  }
  // Dates that sort differently as text (dd/mm/yyyy) than as dates.
  const dates = ["2026-01-05", "2025-12-20", "2026-02-28", "2025-11-30", "2026-01-15", "2025-12-31", "2026-03-01", "2025-10-10", "2026-02-02", "2025-12-01", "2026-01-25", "2026-02-14", "2026-03-10"];
  await ctx.api.commit((d) => { d.invoices.forEach((inv, i) => { inv.date = dates[i] + "T09:00:00.000Z"; }); });
  // The newest invoice is a cancelled sale in the shape earlier versions saved (the app no longer makes these): lines and payments kept,
  // one refund of what was collected, the stock already given back. The administrator can now delete it like any other invoice.
  await ctx.api.commit((d) => {
    const inv = d.invoices[12];
    const at = new Date().toISOString();
    const paid = inv.payments.reduce((sum, p) => sum + p.amount, 0);
    inv.cancellation = { at, total: inv.total, paid, refund: paid };
    if (paid > 0) inv.refunds = [{ id: "r-legacy", amount: paid, timestamp: at, reason: "cancellation" }];
    d.products[0].stock += inv.items[0].stockDeducted;
  });
  await ctx.api.autoBackup.flushNow();
  process.stdout.write(ctx.handle.content);
})();

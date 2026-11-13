"use strict";

// The real desktop application: a supplier marked Good standing or Needs attention with the page's own buttons keeps the mark
// after the application is closed and opened again, and a supplier never marked is left exactly as it was.

const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { tempDir, remove, launch, closeAll, goTo, until } = require("./helpers");

afterEach(closeAll);

test("a supplier's Good standing / Needs attention mark survives closing and reopening the application", async () => {
  const userData = tempDir("standing");
  try {
    let run = await launch(userData);
    assert.equal(run.pageErrors.length, 0, run.pageErrors.join("; "));
    await run.page.evaluate(async () => {
      const ok = async (fn) => { const r = await commit(fn); if (r && r.error) throw new Error(r.error); };
      await ok((d) => Purchases.saveSupplier(d, { name: "Bookseram", phone: "0555 12 34 56", paymentTermsDays: "30" }));
      await ok((d) => Purchases.saveSupplier(d, { name: "Timgad Ceramic", phone: "0555 99 88 77", paymentTermsDays: "30" }));
      await ok((d) => Purchases.saveSupplier(d, { name: "Hodna Tiles", phone: "0770 11 22 33", paymentTermsDays: "30" }));
    });
    await goTo(run.page, "suppliers");
    const rowOf = (name) => `#supRows tr:has(button.link:text-is("${name}"))`;
    await until(() => run.page.locator("#supRows tr").count().then((n) => n === 3), 15000, "the three suppliers");

    await run.page.click(`${rowOf("Bookseram")} [data-standing="good"]`);
    await until(() => run.page.locator(`${rowOf("Bookseram")}.standing-good`).count(), 15000, "Bookseram marked Good standing");
    await run.page.click(`${rowOf("Timgad Ceramic")} [data-standing="attention"]`);
    await until(() => run.page.locator(`${rowOf("Timgad Ceramic")}.standing-attention`).count(), 15000, "Timgad marked Needs attention");

    const standings = (page) => page.evaluate(() => Object.fromEntries(state.suppliers.map((s) => [s.name, "standing" in s ? s.standing : null])));
    assert.deepEqual(await standings(run.page), { Bookseram: "good", "Timgad Ceramic": "attention", "Hodna Tiles": null });
    await run.close();

    run = await launch(userData);
    assert.equal(run.pageErrors.length, 0, run.pageErrors.join("; "));
    assert.deepEqual(await standings(run.page), { Bookseram: "good", "Timgad Ceramic": "attention", "Hodna Tiles": null }, "the marks are still there, and the unmarked supplier has no field at all");
    await goTo(run.page, "suppliers");
    await until(() => run.page.locator(`${rowOf("Bookseram")}.standing-good`).count(), 15000, "the green row after the restart");
    assert.equal(await run.page.locator(`${rowOf("Timgad Ceramic")}.standing-attention`).count(), 1, "the red row after the restart");
    assert.equal(await run.page.locator(`${rowOf("Hodna Tiles")}.standing-good, ${rowOf("Hodna Tiles")}.standing-attention`).count(), 0, "the neutral row is untouched");

    // clearing is saved too: press the active mark again, restart, and the supplier is neutral
    await run.page.click(`${rowOf("Bookseram")} [data-standing="good"]`);
    await until(() => run.page.evaluate(() => !("standing" in state.suppliers.find((s) => s.name === "Bookseram"))), 15000, "Bookseram cleared");
    await run.close();

    run = await launch(userData);
    assert.deepEqual(await standings(run.page), { Bookseram: null, "Timgad Ceramic": "attention", "Hodna Tiles": null });
    await run.close();
  } finally {
    remove(userData);
  }
});

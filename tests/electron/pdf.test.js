"use strict";

// Printing and PDF in the real desktop application: "Save as PDF" writes the invoice as the print layout shows it.

const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { tempDir, remove, launch, closeAll, addProduct, stubDialogs, goTo, until } = require("./helpers");

afterEach(closeAll);

test("Save as PDF writes the invoice being shown to the file chosen in the Windows Save dialog, laid out as printed, and Print stays available", async () => {
  const userData = tempDir("pdf");
  const out = tempDir("pdf-out");
  try {
    const run = await launch(userData);
    await addProduct(run.page, "Everton Grey", 20);
    await run.page.evaluate(() => {
      const p = state.products.find((x) => x.name === "Everton Grey");
      addToSale(p.id, "4", "box");
      state.sale.customer.name = "Samira Hamdi";
      state.sale.paidValue = "3000";
      renderAll();
    });
    await goTo(run.page, "sell");
    assert.equal(await run.page.isVisible("#printBtn"), true);
    assert.equal(await run.page.isVisible("#pdfBtn"), true, "the PDF button is there in the desktop application");
    const target = path.join(out, "invoice.pdf");
    await stubDialogs(run.app, { save: target });
    await run.page.click("#pdfBtn");
    await until(() => fs.existsSync(target) && fs.statSync(target).size > 1000, 20000, "the PDF file");
    const bytes = fs.readFileSync(target);
    assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
    const info = spawnSync("pdfinfo", [target], { encoding: "utf8" });
    if (!info.error) {
      assert.match(info.stdout, /Pages:\s+1/);
      assert.match(info.stdout, /Page size:\s+(595|594|210)/, "A4");
      const text = spawnSync("pdftotext", ["-layout", target, "-"], { encoding: "utf8" }).stdout;
      assert.match(text, /Everton Grey/);
      assert.match(text, /Samira Hamdi/);
      assert.match(text, /INV-\d{6}/);
    }
    assert.equal(await run.page.title(), "Invoisy", "the window title is back to normal afterwards");
    // cancelling the dialog writes nothing and says nothing
    await stubDialogs(run.app, { save: null });
    fs.rmSync(target);
    await run.page.click("#pdfBtn");
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(fs.existsSync(target), false);
  } finally { await closeAll(); remove(userData); remove(out); }
});

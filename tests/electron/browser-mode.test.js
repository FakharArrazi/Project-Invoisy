"use strict";

// The browser version must keep working: index.html opened straight from disk (file://), with no desktop bridge, behaves
// as before (file-picker backup, no desktop-only buttons). A plain window inside the test application stands in for a
// browser tab here; it has no preload script, so window.invoisyDesktop does not exist in it.

const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { tempDir, remove, launch, closeAll, until, ROOT } = require("./helpers");

afterEach(closeAll);

test("without the desktop bridge the page starts, stores in IndexedDB and keeps its own browser backup controls", async () => {
  const userData = tempDir("browser");
  try {
    const run = await launch(userData);
    const url = "file://" + path.join(ROOT, "index.html");
    await run.app.evaluate(async ({ BrowserWindow }, url) => {
      const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
      await w.loadURL(url);
    }, url);
    const tab = await until(() => run.app.windows().find((w) => w.url().startsWith("file://")), 15000, "the browser-style window");
    const errors = [];
    tab.on("pageerror", (e) => errors.push(e.message));
    await until(async () => (await tab.textContent("#dataState")).trim() === "Ready", 20000, "the page to be ready");
    const seen = await tab.evaluate(() => ({
      bridge: window.DesktopBridge, desktop: typeof window.invoisyDesktop,
      pdfHidden: document.getElementById("pdfBtn").hidden,
      replaceHidden: document.getElementById("autoReplace").hidden,
    }));
    assert.deepEqual(seen.bridge, { isDesktop: false });
    assert.equal(seen.desktop, "undefined");
    assert.equal(seen.pdfHidden, true);
    assert.equal(seen.replaceHidden, true);
    // the browser's own backup file chooser is still there, with its own wording
    await tab.click('.nav-btn[data-view="settings"]');
    assert.match(await tab.textContent("#autoChoose"), /Choose backup file/i);
    // the database works exactly as before
    await tab.evaluate(async () => {
      const v = Validation.normalizeProduct({ name: "Browser Tile", manufacturer: "X", tileSize: "60*60", coveragePerBox: 1.44, sku: "B-1", category: "Tiles", sellingPrice: 2000, priceUnit: "box", purchasePrice: 1200, stock: 4 });
      delete v.id;
      await addProduct(v);
    });
    assert.equal(await tab.evaluate(async () => (await db.loadAll()).products.length), 1);
    assert.deepEqual(errors, []);
    // and the desktop window's own database is a different one (another origin), untouched
    assert.equal(await run.page.evaluate(async () => (await db.loadAll()).products.length), 0);
  } finally { await closeAll(); remove(userData); }
});

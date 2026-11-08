"use strict";

// Starts the REAL Invoisy desktop application (electron/main.js) with a throw-away user-data folder, and gives the tests
// the window, a way to answer the Windows dialogs, and the files the application writes. Nothing here touches the real
// %APPDATA%\Invoisy folder: INVOISY_USER_DATA points the application at a temporary one.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _electron } = require("playwright-core");

const ROOT = path.join(__dirname, "..", "..");
const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;

const tempDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `invoisy-e2e-${label}-`));
const remove = (dir) => fs.rmSync(dir, { recursive: true, force: true });

const live = new Set();   // every application started by a test, so a failing test can not leave one running

async function launch(userData, options) {
  const opts = options || {};
  const app = await _electron.launch({
    args: [ROOT, ...(runningAsRoot ? ["--no-sandbox"] : [])],   // Chromium refuses to start as root without it (containers only)
    env: { ...process.env, INVOISY_USER_DATA: userData, ELECTRON_ENABLE_LOGGING: "" },
    timeout: 60000,
  });
  const page = await app.firstWindow();
  const dialogs = [];
  let answer = opts.confirm === undefined ? true : opts.confirm;
  page.on("dialog", async (d) => {
    dialogs.push({ type: d.type(), message: d.message() });
    try { if (answer === false) await d.dismiss(); else await d.accept(); } catch { /* the window closed while the dialog was open */ }
  });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.waitForLoadState("domcontentloaded");
  await waitForReady(page);
  const run = {
    app, page, dialogs, pageErrors,
    answerConfirms(value) { answer = value; },
    async close() { live.delete(run); try { await app.close(); } catch { /* already closed */ } },
  };
  live.add(run);
  return run;
}

async function waitForReady(page) {
  await page.waitForFunction(() => typeof getStorage === "function" ? getStorage().mode === "ready" : (document.getElementById("dataState") || {}).textContent === "Ready", null, { timeout: 30000 });
}

async function closeAll() { for (const run of [...live]) await run.close(); }

// The next Open dialog answers with `file`; the next Save dialog with `target` (or is cancelled when target is null).
async function stubDialogs(app, { open, save }) {
  await app.evaluate(({ dialog }, { open, save }) => {
    dialog.showOpenDialog = async () => (open ? { canceled: false, filePaths: [open] } : { canceled: true, filePaths: [] });
    dialog.showSaveDialog = async () => (save ? { canceled: false, filePath: save } : { canceled: true });
  }, { open: open || null, save: save || null });
}

const snapshot = (page) => page.evaluate(async () => JSON.parse(JSON.stringify(await db.loadAll({ withAttachments: true }))));
const addProduct = (page, name, stock) => page.evaluate(async ({ name, stock }) => {
  const v = Validation.normalizeProduct({ name, manufacturer: "Timgad Ceramic", tileSize: "60*60", coveragePerBox: 1.44, sku: "T-" + name, category: "Tiles", sellingPrice: 2000, priceUnit: "box", purchasePrice: 1200, stock: stock || 10 });
  delete v.id;
  return addProduct(v);
}, { name, stock });
const goTo = (page, view) => page.click(`.nav-btn[data-view="${view}"]`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, ms = 15000, label = "condition") {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { try { last = await check(); if (last) return last; } catch (e) { last = e; } await sleep(50); }
  throw new Error(`timed out waiting for ${label}` + (last instanceof Error ? `: ${last.message}` : ""));
}

module.exports = { ROOT, tempDir, remove, launch, closeAll, addProduct, stubDialogs, snapshot, goTo, until, sleep, waitForReady };

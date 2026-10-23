"use strict";

// Stability of the page: what happens when the database connection is lost (reconnect in the same page, no reload), that
// routine operations finish without a message while genuine notices still appear, and that opening the database again
// does not leave a second listener behind. The page behaviours that need a real browser (focus kept through a redraw,
// typed Settings kept, a live-reload server watching the backup file) are in tests/e2e/stability_check.py.

const test = require("node:test");
const assert = require("node:assert/strict");
const { fake, V, DB, sampleProduct } = require("./helpers/modules");
const { loadApp } = require("./helpers/app");

const tileValues = () => {
  const { id, ...values } = sampleProduct({ name: "Everton Grey", tileSize: "60*60", coveragePerBox: 1.44, sku: "EV-60", sellingPrice: 800, priceUnit: "m2", purchasePrice: 600, stock: 10 });
  return values;
};

// A page whose window.location.reload() is counted: it must never be called by the app on its own.
async function startedApp() {
  const counters = { reloads: 0, prints: 0 };
  const app = loadApp({
    globals: {
      window: { location: { reload() { counters.reloads++; } }, print() { counters.prints++; }, addEventListener() {} },
    },
  });
  const storage = await app.start();
  assert.equal(storage.mode, "ready", storage.reason);
  return { app, counters };
}

const rawOpen = (factory, name, version, upgrade) => new Promise((resolve, reject) => {
  const request = factory.open(name, version);
  if (upgrade) request.onupgradeneeded = () => upgrade(request.result, request.transaction);
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const banner = (app) => ({ action: app.field("bannerAction").dataset.action, label: app.field("bannerAction").textContent, hidden: app.field("bannerAction").hidden });

/* ---------- 1. A lost connection is reopened in this page ---------- */

test("storage: a connection that was closed is reopened in the same page, with the screen and the data untouched", async () => {
  const { app, counters } = await startedApp();
  await app.api.addProduct(tileValues());
  const id = app.api.getState().products[0].id;
  assert.equal(app.api.addToSale(id, "2", "box").ok, true);
  app.api.getSale().customer.name = "Karim";

  app.api.db.close();   // the browser closed the connection
  const refused = await app.api.addStock(id, "1");
  assert.ok(refused.error, "the save is refused, not pretended");
  assert.equal(app.api.getStorage().mode, "outdated");
  assert.equal(banner(app).action, "retry", "the banner offers Try again, not Reload");
  assert.match(app.field("bannerText").textContent, /Nothing on screen was lost\. Press Try again|Press Try again at the top of the page/, "the message matches the button");
  assert.doesNotMatch(app.field("bannerText").textContent, /[Rr]eload/, "and does not ask for a reload");
  assert.equal(app.api.getState().products[0].stock, 10, "nothing changed in memory");

  await app.api.startStorage();
  assert.equal(app.api.getStorage().mode, "ready");
  assert.equal(banner(app).hidden, true, "the banner is gone");
  assert.equal(counters.reloads, 0, "the page was never reloaded");
  assert.equal(app.api.getSale().customer.name, "Karim", "the sale being typed is still there");
  assert.equal(app.api.getSale().items.length, 1);

  assert.equal((await app.api.addStock(id, "1")).error, undefined, "saving works again");
  assert.equal(app.api.getState().products[0].stock, 11);
});

test("storage: pressing Try again twice starts the connection once", async () => {
  const { app } = await startedApp();
  app.api.db.close();
  const original = app.api.db.initDatabase;
  let opened = 0;
  app.api.db.initDatabase = (...args) => { opened++; return original.apply(app.api.db, args); };
  await Promise.all([app.api.startStorage(), app.api.startStorage(), app.api.startStorage()]);
  assert.equal(opened, 1, "the second and third press joined the first");
  assert.equal(app.api.getStorage().mode, "ready");
});

test("storage: a failed reconnect keeps the screen and the data and can be tried again", async () => {
  const { app, counters } = await startedApp();
  await app.api.addProduct(tileValues());
  app.api.db.close();
  const original = app.api.db.initDatabase;
  app.api.db.initDatabase = async () => { throw Object.assign(new Error("The browser refused to open the database."), { code: "OPEN" }); };
  await app.api.startStorage();
  assert.equal(app.api.getStorage().mode, "failed");
  assert.equal(banner(app).action, "retry");
  assert.equal(app.api.getState().products.length, 1, "valid data on the screen is not replaced by an empty list");

  app.api.db.initDatabase = original;
  await app.api.startStorage();
  assert.equal(app.api.getStorage().mode, "ready");
  assert.equal(app.api.getState().products.length, 1);
  assert.equal(counters.reloads, 0);
});

/* ---------- 2. Reloading is offered in one situation only ---------- */

test("storage: when another window moved the database to a newer version, Reload is offered (never done by itself) and nothing is lost", async () => {
  const { app, counters } = await startedApp();
  await app.api.addProduct(tileValues());
  app.api.addToSale(app.api.getState().products[0].id, "1", "box");

  const newer = await rawOpen(app.indexedDB, "invoisy", DB.DB_VERSION + 1, () => {});
  newer.close();   // the newer window is done upgrading; this window's connection was closed for it
  assert.equal(app.api.getStorage().mode, "outdated");
  assert.equal(banner(app).action, "retry", "first the page tries to reconnect");

  await app.api.startStorage();   // Try again: the database is now newer than this page's code
  assert.equal(app.api.getStorage().mode, "outdated");
  assert.equal(app.api.getStorage().reloadNeeded, true);
  assert.equal(banner(app).action, "reload", "only now is a reload the remedy");
  assert.equal(counters.reloads, 0, "and it is the person's choice: the page does not reload itself");
  assert.equal(app.api.getState().products.length, 1, "the data on the screen is kept");
  assert.equal(app.api.getSale().items.length, 1, "so is the sale being prepared");
  assert.equal(app.api.hasUnsavedWork(), true, "which the browser still asks about before a reload");
});

test("storage: an old copy of Invoisy opened on newer data is not offered a pointless reload", async () => {
  const factory = new fake.IDBFactory();
  const future = await rawOpen(factory, "invoisy", DB.DB_VERSION + 1, (d) => d.createObjectStore("something"));
  future.close();
  const app = loadApp({ indexedDB: factory, globals: { window: { location: { reload() {} }, addEventListener() {} } } });
  const storage = await app.start();
  assert.equal(storage.mode, "failed");
  assert.equal(storage.reloadNeeded, false);
  assert.equal(banner(app).action, "retry");
});

/* ---------- 3. Opening the database again leaves no second listener ---------- */

test("database: opening again after the connection was lost does not leave the earlier channel listening", async () => {
  const factory = new fake.IDBFactory();
  const channels = new Map();
  const open = (name) => (channels.get(name) || new Set()).size;
  class FakeChannel {
    constructor(name) { this.name = name; (channels.get(name) || channels.set(name, new Set()).get(name)).add(this); }
    postMessage() {}
    close() { channels.get(this.name).delete(this); }
  }
  globalThis.BroadcastChannel = FakeChannel;
  try {
    const db = DB.create({ indexedDB: factory, name: "leak" });
    await db.initDatabase();
    assert.equal(open("leak-changes"), 1);
    await new Promise((resolve) => { const r = factory.deleteDatabase("leak"); r.onsuccess = resolve; r.onerror = resolve; });   // another window removes it: this connection is closed
    await db.initDatabase();
    assert.equal(open("leak-changes"), 1, "one listener, not two");
    db.close();
    assert.equal(open("leak-changes"), 0);
  } finally {
    delete globalThis.BroadcastChannel;
  }
});

/* ---------- 4. Routine operations are quiet; genuine notices are not ---------- */

test("quiet: product, restock, sale, payment, delete and settings finish without a message", async () => {
  const { app, counters } = await startedApp();
  const toast = () => app.toast();
  assert.equal(toast(), "");

  assert.equal((await app.api.addProduct(tileValues())) !== false, true);
  const id = app.api.getState().products[0].id;
  assert.equal(toast(), "", "product added");

  await app.api.addStock(id, "5");
  assert.equal(toast(), "", "restocked");

  app.api.addToSale(id, "2", "box");
  app.api.getSale().customer.name = "Karim";
  app.api.getSale().paidValue = "500";
  await app.api.completeSale();
  assert.ok(app.api.getSaleDone(), "the dialog is the answer to completing a sale");
  assert.equal(toast(), "", "sale completed");

  const invoice = app.api.getInvoices()[0];
  await app.api.saleDoneAction("print");
  assert.equal(counters.prints, 1);
  assert.equal(toast(), "", "printed");

  assert.equal((await app.api.addPayment(invoice.id, "100")).error, undefined);
  assert.equal(toast(), "", "payment recorded");

  app.field("sName").value = "Timgad Ceramic";
  app.api.fillSettingsForm();
  app.field("sName").value = "Timgad Ceramic";
  await app.api.saveBusinessSettings();
  assert.equal(app.api.getState().settings.businessName, "Timgad Ceramic");
  assert.equal(toast(), "", "settings saved");

  await app.api.saveLanguage("fr");
  assert.equal(toast(), "", "language changed");
  await app.api.saveLanguage("en");

  await app.api.savePaper("A5");
  assert.equal(toast(), "", "paper size changed");

  await app.api.deleteInvoice(invoice.id);
  assert.equal(toast(), "", "invoice deleted");
  assert.equal(counters.reloads, 0, "and the page never reloaded");
});

test("quiet: a notice that changes what the person sees is still shown", async () => {
  const { app } = await startedApp();
  app.api.notify("Needs your attention.");
  assert.equal(app.toast(), "Needs your attention.");
  app.api.notify("Something failed.", "error");
  assert.equal(app.toast(), "Something failed.");
});

test("quiet: a failed save is still reported, and the sale on screen is kept", async () => {
  const { app } = await startedApp();
  await app.api.addProduct(tileValues());
  const id = app.api.getState().products[0].id;
  app.api.addToSale(id, "2", "box");
  app.api.getSale().customer.name = "Karim";
  app.api.db.close();
  await app.api.completeSale();
  assert.equal(app.api.getInvoices().length, 0, "no invoice was recorded");
  assert.equal(app.api.getSaleDone(), null, "and no false 'sale saved' dialog");
  assert.equal(app.api.getSale().customer.name, "Karim", "the sale is still on screen");
  assert.equal(app.api.getSale().items.length, 1);
  assert.equal(app.api.getStorage().mode, "outdated");
  assert.match(app.errorText("saleError") + app.toast(), /./, "the person is told");
});


/* ---------- 5. Business details being typed are never overwritten by the page itself ---------- */

test("settings: typed business details survive a redraw, a change from another window and a language change; a restore replaces them", async () => {
  const { app } = await startedApp();
  app.api.fillSettingsForm();
  app.field("sName").value = "Typed by hand";
  app.api.markSettingsTouched();
  assert.equal(app.api.backupShouldWait(), true, "typed details count as work in progress for the backup file");

  app.api.refreshAfterLoad();   // what another window saving does
  assert.equal(app.field("sName").value, "Typed by hand", "another window's change does not overwrite typing");
  app.api.renderAll();
  assert.equal(app.field("sName").value, "Typed by hand", "nor does a redraw");
  await app.api.saveLanguage("fr");
  assert.equal(app.field("sName").value, "Typed by hand", "nor a language change");
  await app.api.saveLanguage("en");

  // a restore replaces everything, including what was being typed
  const stored = await app.api.db.loadAll();
  const backup = V.prepareBackupFile(stored, new Date(), "invoisy-backup");
  assert.equal(backup.error, undefined);
  await app.api.importBackup(app.file(backup.text));
  assert.notEqual(app.field("sName").value, "Typed by hand", "the restored details are shown");
  assert.equal(app.api.backupShouldWait(), false);

  // and saving stores what was typed, then shows the saved values again
  app.field("sName").value = "Saved name";
  app.api.markSettingsTouched();
  await app.api.saveBusinessSettings();
  assert.equal(app.api.getState().settings.businessName, "Saved name");
  assert.equal(app.field("sName").value, "Saved name");
  assert.equal(app.api.backupShouldWait(), false, "nothing is waiting any more");
});

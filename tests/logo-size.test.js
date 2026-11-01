"use strict";

// Configurable logo dimensions (Settings -> Store logo): a width and a height in cm, saved separately for A4 and for A5.
// The pure rules (defaults, parsing, old files) run on validation.js; saving, switching paper size and reloading run through the
// application's own functions (script.js) against a disposable in-memory IndexedDB. What a real browser prints in physical
// centimetres is measured in tests/e2e/logo_size_check.py.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { V } = require("./helpers/modules");
const { loadApp } = require("./helpers/app");

const plain = (x) => JSON.parse(JSON.stringify(x));
const root = path.join(__dirname, "..");
const css = fs.readFileSync(path.join(root, "css", "style.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

// One page load. Pass the previous load's `indexedDB` to reload it (a browser reload keeps the database).
async function load(previous) {
  const opts = { globals: { window: { print() {}, addEventListener() {} } } };
  if (previous) opts.indexedDB = previous.indexedDB;
  const app = loadApp(opts);
  const storage = await app.start();
  assert.equal(storage.mode, "ready", storage.reason);
  return { app, api: app.api, indexedDB: app.indexedDB };
}

const settingsOf = (ctx) => ctx.api.getState().settings;

// Types into the two fields the way a person does, then leaves the field (the "change" event).
async function type(ctx, width, height) {
  ctx.app.field("logoWidth").value = String(width);
  ctx.app.field("logoHeight").value = String(height);
  ctx.api.onLogoSizeInput();
  await ctx.api.onLogoSizeChange();
}

/* ---------- The rules (validation.js) ---------- */

test("defaults: 3 x 3 cm on A4 and 2.5 x 2.5 cm on A5, and the default settings keep their old shape", () => {
  assert.deepEqual(plain(V.LOGO_SIZE_DEFAULTS), { A4: { width: 3, height: 3 }, A5: { width: 2.5, height: 2.5 } });
  assert.equal("logoSize" in V.DEFAULT_SETTINGS, false, "nothing new is written until a size is changed");
  assert.deepEqual(plain(V.logoSizeOf({}, "A4")), { width: 3, height: 3 });
  assert.deepEqual(plain(V.logoSizeOf({}, "A5")), { width: 2.5, height: 2.5 });
  assert.deepEqual(plain(V.logoSizeOf(undefined, "A5")), { width: 2.5, height: 2.5 });
  assert.deepEqual(plain(V.logoSizeOf({}, "B7")), { width: 3, height: 3 }, "an unknown paper size reads as A4");
});

test("decimal and rectangular sizes are accepted: 1x1, 1.5x1.5, 2x2, 2.5x2.5, 3x3, 4x3", () => {
  for (const [w, h] of [[1, 1], [1.5, 1.5], [2, 2], [2.5, 2.5], [3, 3], [4, 3], [3, 4], [2.25, 1.75]]) {
    assert.equal(V.parseLogoLength(w), w);
    assert.equal(V.parseLogoLength(String(w)), w, `"${w}" typed as text`);
    const size = V.logoSizeOf({ logoSize: { A4: { width: w, height: h } } }, "A4");
    assert.deepEqual(plain(size), { width: w, height: h }, `${w} x ${h} is kept as it is, not made square`);
  }
  assert.equal(V.parseLogoLength("1,5"), 1.5, "a decimal comma is read like a point");
  assert.equal(V.parseLogoLength(" 2.5 "), 2.5);
  assert.equal(V.parseLogoLength("1.234"), 1.23, "rounded to 0.01 cm");
});

test("lengths that can not be a logo size are refused", () => {
  for (const bad of ["", " ", "abc", "1.2.3", "-1", "0", 0, -2, "0.49", 0.1, "10.01", 11, "1e1", NaN, Infinity, null, undefined, {}, [], true]) {
    assert.equal(V.parseLogoLength(bad), null, JSON.stringify(bad) + " is not a usable logo length");
  }
  assert.equal(V.parseLogoLength(V.LOGO_SIZE_MIN), V.LOGO_SIZE_MIN, "the limits themselves are allowed");
  assert.equal(V.parseLogoLength(V.LOGO_SIZE_MAX), V.LOGO_SIZE_MAX);
});

test("A4 and A5 are read independently; a missing or unusable part falls back to the default of that paper only", () => {
  const settings = { logoSize: { A5: { width: 2, height: 2 } } };
  assert.deepEqual(plain(V.logoSizeOf(settings, "A4")), { width: 3, height: 3 });
  assert.deepEqual(plain(V.logoSizeOf(settings, "A5")), { width: 2, height: 2 });
  const half = { logoSize: { A4: { width: 4, height: "oops" }, A5: "nope" } };
  assert.deepEqual(plain(V.logoSizeOf(half, "A4")), { width: 4, height: 3 }, "the usable width is kept, the bad height is the default");
  assert.deepEqual(plain(V.logoSizeOf(half, "A5")), { width: 2.5, height: 2.5 });
});

test("older settings without a logo size load unchanged and use the defaults", () => {
  const old = { businessName: "Shop", address: "", phone: "", email: "", currency: "DA", logo: "", paper: "A5", currencyUnit: "dinars", language: "en", sellerName: "" };
  const normalized = V.normalizeSettings(old);
  assert.equal("logoSize" in normalized, false, "no logoSize is invented");
  assert.deepEqual(plain(normalized), plain({ ...V.DEFAULT_SETTINGS, paper: "A5", businessName: "Shop" }));
  assert.equal(V.settingsProblem(old), "");
  assert.deepEqual(plain(V.logoSizeOf(normalized, normalized.paper)), { width: 2.5, height: 2.5 });
});

test("saved sizes survive normalization; unusable values never block a file", () => {
  const saved = V.normalizeSettings({ logoSize: { A4: { width: 4, height: 3 }, A5: { width: 2, height: 2 } } });
  assert.deepEqual(plain(saved.logoSize), { A4: { width: 4, height: 3 }, A5: { width: 2, height: 2 } });
  assert.equal(V.settingsProblem(saved), "");
  const repaired = V.normalizeSettings({ logoSize: { A4: { width: -1, height: "x" }, A5: { width: 99, height: 1.5 } } });
  assert.deepEqual(plain(repaired.logoSize), { A4: { width: 3, height: 3 }, A5: { width: 2.5, height: 1.5 } });
  for (const junk of ["big", 5, true, [], null]) {
    const n = V.normalizeSettings({ logoSize: junk });
    assert.equal("logoSize" in n, false, JSON.stringify(junk) + " is not carried over");
  }
  assert.notEqual(V.settingsProblem({ logoSize: "big" }), "", "a draft with a logo size that is not an object is refused");
  assert.equal(V.settingsProblem({ logoSize: {} }), "");
});

/* ---------- The Settings page: saving, switching paper size, reloading ---------- */

test("the fields show the size of the paper size in use, and a new profile starts at 3 x 3 (A4) and 2.5 x 2.5 (A5)", async () => {
  const ctx = await load();
  const { api, app } = ctx;
  api.fillSettingsForm({ force: true });
  assert.equal(app.field("logoWidth").value, "3");
  assert.equal(app.field("logoHeight").value, "3");
  assert.match(app.field("logoSizeTitle").textContent, /A4/);
  await api.savePaper("A5");
  assert.equal(app.field("logoWidth").value, "2.5");
  assert.equal(app.field("logoHeight").value, "2.5");
  assert.match(app.field("logoSizeTitle").textContent, /A5/);
  assert.equal(settingsOf(ctx).paper, "A5");
});

test("A4 and A5 are independent: changing one never changes the other, and switching paper size applies the right one", async () => {
  const ctx = await load();
  const { api, app } = ctx;
  await type(ctx, 4, 3);                       // A4 is selected: 4 x 3
  assert.deepEqual(plain(settingsOf(ctx).logoSize), { A4: { width: 4, height: 3 }, A5: { width: 2.5, height: 2.5 } }, "A5 keeps its own size");

  await api.savePaper("A5");
  assert.equal(app.field("logoWidth").value, "2.5", "A5 shows its own size, not the A4 one");
  await type(ctx, 2, 2);                       // A5: 2 x 2
  assert.deepEqual(plain(settingsOf(ctx).logoSize), { A4: { width: 4, height: 3 }, A5: { width: 2, height: 2 } }, "A4 is untouched by the A5 change");

  await api.savePaper("A4");
  assert.equal(app.field("logoWidth").value, "4");
  assert.equal(app.field("logoHeight").value, "3");
  assert.deepEqual(plain(api.getState().settings.logoSize.A5), { width: 2, height: 2 }, "switching back changes nothing");
});

test("the invoice takes its size from css variables set for the paper size in use (live preview and print share them)", async () => {
  const ctx = await load();
  const { api } = ctx;
  const vars = () => ctx.app.documentStyle();
  api.applyLogoSize();
  assert.deepEqual([vars()["--logo-w"], vars()["--logo-h"]], ["3cm", "3cm"], "A4 default");
  await type(ctx, 4, 3);
  assert.deepEqual([vars()["--logo-w"], vars()["--logo-h"]], ["4cm", "3cm"], "a rectangle on A4");
  await api.savePaper("A5");
  assert.deepEqual([vars()["--logo-w"], vars()["--logo-h"]], ["2.5cm", "2.5cm"], "A5 default, applied by switching paper size");
  await type(ctx, 1.5, 1.5);
  assert.deepEqual([vars()["--logo-w"], vars()["--logo-h"]], ["1.5cm", "1.5cm"], "a decimal size on A5");
  await api.savePaper("A4");
  assert.deepEqual([vars()["--logo-w"], vars()["--logo-h"]], ["4cm", "3cm"], "back to the A4 size");
});

test("every size of the request is saved exactly: 1x1, 1.5x1.5, 2x2, 2.5x2.5, 3x3, 4x3 on both paper sizes", async () => {
  const ctx = await load();
  for (const paper of ["A4", "A5"]) {
    await ctx.api.savePaper(paper);
    for (const [w, h] of [[1, 1], [1.5, 1.5], [2, 2], [2.5, 2.5], [3, 3], [4, 3]]) {
      await type(ctx, w, h);
      assert.deepEqual(plain(V.logoSizeOf(settingsOf(ctx), paper)), { width: w, height: h }, `${paper} ${w} x ${h}`);
      assert.deepEqual([ctx.app.documentStyle()["--logo-w"], ctx.app.documentStyle()["--logo-h"]], [w + "cm", h + "cm"]);
    }
  }
});

test("the sizes are saved at once and restored after a reload (and the other paper size is still its own)", async () => {
  const first = await load();
  await type(first, 4, 3);
  await first.api.savePaper("A5");
  await type(first, 2, 2);

  const second = await load(first);   // the same database, a fresh page
  assert.deepEqual(plain(settingsOf(second).logoSize), { A4: { width: 4, height: 3 }, A5: { width: 2, height: 2 } });
  assert.equal(settingsOf(second).paper, "A5");
  second.api.applyLogoSize();
  assert.deepEqual([second.app.documentStyle()["--logo-w"], second.app.documentStyle()["--logo-h"]], ["2cm", "2cm"], "the saved A5 size is applied after reopening");
  second.api.fillSettingsForm({ force: true });
  assert.equal(second.app.field("logoWidth").value, "2");
  await second.api.savePaper("A4");
  assert.equal(second.app.field("logoWidth").value, "4");
  assert.equal(second.app.field("logoHeight").value, "3");
});

test("a size typed and then abandoned for another paper size is saved for the paper size it was typed for", async () => {
  const ctx = await load();
  ctx.app.field("logoWidth").value = "4";
  ctx.app.field("logoHeight").value = "3";
  ctx.api.onLogoSizeInput();               // typed, not saved yet (it is saved a moment later)
  await ctx.api.savePaper("A5");           // the paper size is changed before that moment
  assert.deepEqual(plain(settingsOf(ctx).logoSize.A4), { width: 4, height: 3 });
  assert.deepEqual(plain(settingsOf(ctx).logoSize.A5), { width: 2.5, height: 2.5 });
});

test("an unusable size is refused with a message and the saved size comes back; nothing is saved", async () => {
  const ctx = await load();
  const { app, api } = ctx;
  await type(ctx, 4, 3);
  const before = plain(settingsOf(ctx).logoSize);
  const revision = api.getState().revision;
  for (const [w, h] of [["", "3"], ["abc", "3"], ["0", "3"], ["-2", "3"], ["3", "11"], ["3", ""]]) {
    app.field("logoWidth").value = w;
    app.field("logoHeight").value = h;
    api.onLogoSizeInput();
    await api.onLogoSizeChange();
    assert.match(app.errorText("logoError"), /between/, `${w} x ${h} is explained`);
    assert.equal(app.field("logoWidth").value, "4", "the saved width comes back");
    assert.equal(app.field("logoHeight").value, "3", "the saved height comes back");
    assert.deepEqual(plain(settingsOf(ctx).logoSize), before, "nothing was changed");
  }
  assert.equal(api.getState().revision, revision, "nothing was written");
  assert.deepEqual([app.documentStyle()["--logo-w"], app.documentStyle()["--logo-h"]], ["4cm", "3cm"], "the invoice still shows the saved size");
  await type(ctx, 2, 2);
  assert.equal(app.errorText("logoError"), "", "a usable size clears the message");
});

test("typing the size that is already saved does not write anything", async () => {
  const ctx = await load();
  const revision = ctx.api.getState().revision;
  await type(ctx, 3, 3);   // the A4 default
  assert.equal(ctx.api.getState().revision, revision);
  assert.equal("logoSize" in settingsOf(ctx), false);
});

/* ---------- Existing logo features and other settings are untouched ---------- */

test("uploading, replacing and removing the logo works as before and does not touch the sizes", async () => {
  const ctx = await load();
  await type(ctx, 4, 3);
  const png = "data:image/png;base64,AAAA";
  await ctx.api.saveLogo(png);
  assert.equal(settingsOf(ctx).logo, png);
  await ctx.api.saveLogo("data:image/png;base64,BBBB");
  assert.equal(settingsOf(ctx).logo, "data:image/png;base64,BBBB", "replaced");
  assert.deepEqual(plain(settingsOf(ctx).logoSize.A4), { width: 4, height: 3 });
  await ctx.api.saveLogo("");
  assert.equal(settingsOf(ctx).logo, "", "removed");
  assert.deepEqual(plain(settingsOf(ctx).logoSize.A4), { width: 4, height: 3 }, "removing the logo keeps the size of the box");
  const head = ctx.api.invoiceHeadHtml({ name: "Shop" }, "");
  assert.match(head, /<div class="inv-logo-box"><\/div>/, "the box is still drawn when empty");
});

test("business details and the other settings keep their values when a size is saved", async () => {
  const ctx = await load();
  await ctx.api.commit((d) => { d.settings.businessName = "Hedjazi Ceramic"; d.settings.address = "Sétif"; d.settings.staff = [{ name: "Ahmed", phones: ["0770 00 00 00"] }]; });
  await type(ctx, 2, 1.5);
  const s = settingsOf(ctx);
  assert.equal(s.businessName, "Hedjazi Ceramic");
  assert.equal(s.address, "Sétif");
  assert.deepEqual(plain(s.staff), [{ name: "Ahmed", phones: ["0770 00 00 00"] }]);
  assert.equal(s.paper, "A4");
});

/* ---------- Backups ---------- */

test("the sizes are part of the backup file and are restored from it; a backup without them restores with the defaults", async () => {
  const ctx = await load();
  await type(ctx, 4, 3);
  await ctx.api.savePaper("A5");
  await type(ctx, 2, 2);
  await ctx.api.exportBackup();
  const file = V.parseBackup(await ctx.app.downloadedText());
  assert.equal(file.error, undefined, file.error);
  assert.deepEqual(plain(file.data.settings.logoSize), { A4: { width: 4, height: 3 }, A5: { width: 2, height: 2 } });

  // An older backup: the same settings without the new key.
  const exported = JSON.parse(await ctx.app.downloadedText());
  const oldSettings = { ...exported.data.settings };
  delete oldSettings.logoSize;
  const oldText = JSON.stringify({ ...exported, data: { ...exported.data, settings: oldSettings } });
  const old = V.parseBackup(oldText);
  assert.equal(old.error, undefined, old.error);
  assert.equal("logoSize" in old.data.settings, false);
  assert.deepEqual(plain(V.logoSizeOf(old.data.settings, "A4")), { width: 3, height: 3 });
  assert.deepEqual(plain(V.logoSizeOf(old.data.settings, "A5")), { width: 2.5, height: 2.5 });
});

/* ---------- The stylesheet and the markup ---------- */

test("the stylesheet sizes the box only from the variables, in cm, with the old sizes as fallbacks", () => {
  const rule = (selector) => css.split("}").map((b) => b.trim()).find((b) => b.startsWith(selector + " {"));
  const a4 = rule(".inv-logo-box");
  const a5 = rule('html[data-paper="a5"] .inv-logo-box');
  assert.match(a4, /width: var\(--logo-w, 3cm\)/);
  assert.match(a4, /height: var\(--logo-h, 3cm\)/);
  assert.match(a5, /width: var\(--logo-w, 2\.5cm\)/);
  assert.match(a5, /height: var\(--logo-h, 2\.5cm\)/);
  assert.doesNotMatch(a4 + a5, /\bwidth: \d|\bheight: \d/, "no fixed size is left in the rules");
  assert.doesNotMatch((a4 + a5).replace(/border: 1px solid[^;]*;/, ""), /\d\s*px/, "no screen pixels: the size is physical");
  assert.match(a4, /box-sizing: border-box/, "the border is inside the size, so the box measures exactly what is set");
});

test("Settings has the two numeric fields (width, height in cm) beside the logo, and the paper-size panel still exists", () => {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const start = html.indexOf('id="view-settings"');
  const settings = html.slice(start, html.indexOf("</section>", start));
  const logoPanel = settings.slice(settings.indexOf('data-i18n="settings.logo"'), settings.indexOf('<div class="settings-grid">'));
  for (const id of ["logoPreview", "logoFile", "chooseLogo", "removeLogo", "logoWidth", "logoHeight", "logoSizeTitle", "logoError"]) {
    assert.match(logoPanel, new RegExp(`id="${id}"`), `${id} is in the logo panel`);
  }
  assert.match(logoPanel, /<input type="number" id="logoWidth"[^>]*step="0\.1"/, "decimals are allowed");
  assert.match(logoPanel, /<input type="number" id="logoHeight"[^>]*step="0\.1"/);
  assert.equal((settings.match(/<div class="panel settings-panel/g) || []).length, 9, "no panel was added or removed");
});

test("the new texts exist in English, French and Arabic", () => {
  for (const code of ["en", "fr", "ar"]) {
    I18n.setLanguage(code);
    for (const key of ["settings.logoSizeTitle", "settings.logoWidth", "settings.logoHeight", "settings.logoSizeHint", "settings.logoNote", "logo.sizeInvalid", "problem.logoSize"]) {
      const text = I18n.t(key, { paper: "A4", min: 0.5, max: 10 });
      assert.ok(text && text !== key, `${code}: ${key}`);
      assert.doesNotMatch(text, /\{\w+\}/, `${code}: ${key} has all its values filled in`);
    }
    assert.match(I18n.t("settings.logoSizeTitle", { paper: "A5" }), /A5/);
  }
  I18n.setLanguage("en");
});

"use strict";

// Settings -> Business details folds and unfolds like Settings -> Product types (look only):
//   - the title bar is one button; the form, its fields, the phone and staff rows and Save Settings are unchanged and inside the body
//   - folded when Settings is opened; nothing typed, saved or shown on invoices is touched by folding

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadApp } = require("./helpers/app");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const panelHtml = () => html.slice(html.indexOf('id="businessPanel"'), html.indexOf('<div class="panel settings-panel', html.indexOf('id="businessPanel"')));
const plain = (value) => JSON.parse(JSON.stringify(value));

async function startedApp() {
  const app = loadApp();
  const storage = await app.start();
  assert.equal(storage.mode, "ready", storage.reason);
  return app;
}

const isOpen = (app, id) => app.field(id).classList.contains("is-open");

test("the Business details title is one button in the heading, folded to begin with, and it controls the body that holds the whole form", () => {
  const panel = panelHtml();
  assert.match(panel, /<h2 class="accordion-title">\s*<button type="button" class="accordion-head" id="businessToggle" aria-expanded="false" aria-controls="businessBody">/);
  assert.match(panel, /<span data-i18n="settings\.business">Business details<\/span>/, "the title keeps its translation key, on a span so the chevron is not wiped");
  assert.match(panel, /<span class="accordion-icon" aria-hidden="true"><svg [^>]*><polyline points="6 9 12 15 18 9">/, "a chevron that points down");
  assert.doesNotMatch(html.slice(html.indexOf('id="businessPanel"') - 40, html.indexOf('id="businessPanel"') + 40), /is-open/, "folded until the person opens it");
  const bodyStart = panel.indexOf('id="businessBody"');
  assert.ok(bodyStart > 0);
  const outside = panel.slice(0, bodyStart);
  assert.equal(outside.includes("<form") || outside.includes("<input") || outside.includes("settings.save"), false, "nothing but the title bar is outside the body");
  const body = panel.slice(bodyStart);
  for (const id of ["settingsForm", "sName", "sAddress", "sEmail", "sCurrency", "sPhonesLabel", "sPhones", "addPhone", "sStaffLabel", "sStaff", "addStaff"]) {
    assert.ok(body.includes(`id="${id}"`), `${id} is inside the folding body`);
  }
  assert.match(body, /<button type="submit" class="btn primary" data-i18n="settings\.save">Save Settings<\/button>/, "Save Settings is still the form's submit button");
  assert.ok(body.indexOf("</form>") > body.indexOf("settings.save"), "and still inside the form");
});

test("the form stays one form with the same ids, and the Settings page still has nine panels with no id used twice", () => {
  const start = html.indexOf('id="view-settings"');
  const settings = html.slice(start, html.indexOf("</section>", start));
  const ids = [...settings.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal((settings.match(/<form id="settingsForm"/g) || []).length, 1);
  assert.equal((settings.match(/<div class="panel settings-panel/g) || []).length, 9);
  assert.equal((settings.match(/class="panel settings-panel accordion"/g) || []).length, 2, "exactly Business details and Product types fold");
});

test("the title bar opens and closes Business details, and Product types is not affected", async () => {
  const app = await startedApp();
  assert.equal(isOpen(app, "businessPanel"), false, "folded at the start");
  app.api.toggleSettingsPanel("businessPanel");
  assert.equal(isOpen(app, "businessPanel"), true, "one click opens it");
  assert.equal(isOpen(app, "productTypesPanel"), false, "the other panel stays as it was");
  app.api.toggleSettingsPanel("productTypesPanel");
  app.api.toggleSettingsPanel("businessPanel");
  assert.equal(isOpen(app, "businessPanel"), false, "the next click closes it");
  assert.equal(isOpen(app, "productTypesPanel"), true, "and the other one is still open");
});

test("both panels are folded again each time Settings is opened, but not when Settings is already showing", async () => {
  const app = await startedApp();
  app.api.showView("settings");
  assert.equal(isOpen(app, "businessPanel") || isOpen(app, "productTypesPanel"), false, "folded when Settings is opened");
  app.api.toggleSettingsPanel("businessPanel");
  app.api.toggleSettingsPanel("productTypesPanel");
  app.api.showView("settings");
  assert.equal(isOpen(app, "businessPanel") && isOpen(app, "productTypesPanel"), true, "asking for the page already on screen keeps them as they are");
  app.api.showView("sell");
  app.api.showView("settings");
  assert.equal(isOpen(app, "businessPanel") || isOpen(app, "productTypesPanel"), false, "back from another page: both folded again");
});

test("folding hides what was typed but never loses it, and Save Settings still saves it", async () => {
  const app = await startedApp();
  app.api.showView("settings");
  const before = plain(await app.api.db.getSettings());
  app.api.toggleSettingsPanel("businessPanel");
  app.field("sName").value = "Ceram Plus";
  app.field("sAddress").value = "12 rue des Tuiles";
  app.field("sEmail").value = "contact@example.test";
  app.api.addPhoneRow();
  app.api.markSettingsTouched();
  app.api.toggleSettingsPanel("businessPanel");   // folded with unsaved text inside
  app.api.toggleSettingsPanel("businessPanel");
  assert.equal(app.field("sName").value, "Ceram Plus", "the typed name is still in the box");
  assert.equal(app.field("sAddress").value, "12 rue des Tuiles");
  assert.equal(app.field("sEmail").value, "contact@example.test");
  assert.deepEqual(plain(await app.api.db.getSettings()), before, "and nothing was saved by folding");
  await app.api.saveBusinessSettings();
  const saved = plain(await app.api.db.getSettings());
  assert.equal(saved.businessName, "Ceram Plus");
  assert.equal(saved.address, "12 rue des Tuiles");
  assert.equal(saved.email, "contact@example.test");
  assert.equal(isOpen(app, "businessPanel"), true, "saving leaves the panel open");
  assert.equal(app.localStorage.writes.length, 0, "the open/closed state is not kept in the browser");
});

test("folding and unfolding write nothing: the saved settings are exactly as they were", async () => {
  const app = await startedApp();
  app.field("sName").value = "Timgad";
  await app.api.saveBusinessSettings();
  const before = plain(await app.api.db.getSettings());
  for (const id of ["businessPanel", "productTypesPanel", "businessPanel", "productTypesPanel"]) app.api.toggleSettingsPanel(id);
  assert.deepEqual(plain(await app.api.db.getSettings()), before);
  assert.equal(app.localStorage.writes.length, 0);
});

test("the style sheet folds both panels with one set of rules", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "css", "settings.css"), "utf8");
  assert.match(css, /#view-settings \.settings-panel\.accordion\s*\{[^}]*padding:\s*0;/, "any panel with the accordion class loses its own padding");
  assert.doesNotMatch(css, /#productTypesPanel|#businessPanel/, "no rule is tied to one panel's id");
});

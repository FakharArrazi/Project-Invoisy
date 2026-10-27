"use strict";

// The Settings page's markup: the redesign moved the panels around but must not lose or duplicate a single control
// that the application's code looks up by id. The look itself is checked in a real browser: tests/e2e/settings_page_check.py.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const start = html.indexOf('id="view-settings"');
const settings = html.slice(start, html.indexOf("</section>", start));
const idsIn = (text) => [...text.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);

test("every control of the Settings page is there once, with the id the code looks up", () => {
  const ids = idsIn(settings);
  assert.equal(new Set(ids).size, ids.length, "no id is used twice");
  for (const id of [
    "sLanguage", "dataFile", "dataState", "dataSummary", "dataSaved", "dataBackup", "dataQuota", "dataNote", "exportBackup", "importBackup",
    "persistBtn", "importFile", "backupForm", "backupDays", "backupDaysSave", "dataError", "legacyBox", "legacyText", "legacyDownload",
    "legacyRemove", "legacySkip", "autoBackupPanel", "autoNote", "autoInfo", "autoConnection", "autoFile", "autoStatus", "autoLast",
    "autoDbRevision", "autoBackedRevision", "autoError", "autoChoose", "autoGrant", "autoRetry", "settingsForm", "sName", "sAddress",
    "sPhonesLabel", "sPhones", "addPhone", "sStaffLabel", "sStaff", "addStaff", "sEmail", "sCurrency", "paperA4", "paperA5",
    "currencyUnitDinars", "currencyUnitCentimes", "logoPreview", "logoFile", "chooseLogo", "removeLogo", "logoError", "loadDemo",
  ]) {
    assert.ok(ids.includes(id), `${id} is on the Settings page`);
  }
});

test("the page has a visible heading and eight panels in the Stock page's style", () => {
  assert.match(settings, /<header class="stock-header">\s*<h1 class="stock-title" data-i18n="nav\.settings">Settings<\/h1>/);
  assert.doesNotMatch(settings, /sr-only/, "the heading is no longer hidden");
  assert.equal((settings.match(/<div class="panel settings-panel/g) || []).length, 8);
  assert.equal((settings.match(/<div class="panel(?! settings-panel)/g) || []).length, 0, "every panel has the new style");
});

test("the form keeps its fields and its Save button", () => {
  const form = settings.slice(settings.indexOf('<form id="settingsForm"'), settings.indexOf("</form>", settings.indexOf('<form id="settingsForm"')));
  for (const id of ["sName", "sAddress", "sEmail", "sCurrency", "sPhones", "sStaff"]) assert.ok(form.includes(`id="${id}"`), `${id} is in the form`);
  assert.match(form, /<button type="submit" class="btn primary" data-i18n="settings\.save">/);
});

test("the style sheet is linked and exists", () => {
  assert.match(html, /<link rel="stylesheet" href="css\/settings\.css">/);
  assert.ok(fs.existsSync(path.join(root, "css", "settings.css")));
});

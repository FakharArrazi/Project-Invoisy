"use strict";

// Runs the real page scripts (pricing, validation, database, script) in an isolated context with a stand-in
// page, a brand new in-memory IndexedDB, and stand-ins for downloads and confirmation dialogs. Nothing here
// touches a real browser profile or real business data.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const fakeIndexedDB = require("fake-indexeddb");

function loadApp(options) {
  const opts = options || {};
  const fields = new Map();
  const element = (id) => {
    if (!fields.has(id)) fields.set(id, {
      id, value: "", textContent: "", className: "", hidden: false, disabled: false, dataset: {}, style: {},
      offsetHeight: 0, classList: { toggle() {}, add() {}, remove() {} },
      reset() {}, focus() {}, querySelectorAll() { return []; }, setAttribute() {}, removeAttribute() {},
    });
    return fields.get(id);
  };

  const values = new Map(Object.entries(opts.localStorage || {}));
  const localStorage = {
    writes: [],
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem(key, value) { this.writes.push(key); values.set(key, String(value)); },
    removeItem(key) { this.writes.push("remove:" + key); values.delete(key); },
  };

  // Downloads: every file the app hands to the browser, with its text, and every object URL created/revoked.
  const downloads = [];
  const urls = new Map();
  const revoked = [];
  let urlSerial = 0;
  const timers = [];
  const confirms = [];
  const answers = [];
  const control = { failDownload: false };   // makes the browser refuse to start a download

  const exports = {};
  const context = {
    __INVOISY_TEST_EXPORTS__: exports,
    console,
    document: {
      getElementById: element,
      querySelectorAll: () => [],
      documentElement: { style: { setProperty() {} }, dataset: {} },
      body: { appendChild() {} },
      title: "Invoisy",
      createElement: () => ({
        href: "", download: "",
        click() {
          if (control.failDownload) throw new Error("The browser blocked the download.");
          downloads.push({ name: this.download, url: this.href });
        },
        remove() {},
      }),
    },
    window: {},
    localStorage,
    indexedDB: "indexedDB" in opts ? opts.indexedDB : new fakeIndexedDB.IDBFactory(),   // pass null to simulate a browser without IndexedDB
    navigator: {},
    Blob,
    URL: {
      createObjectURL(blob) { const url = "blob:test/" + ++urlSerial; urls.set(url, blob); return url; },
      revokeObjectURL(url) { revoked.push(url); },
    },
    confirm(message) { confirms.push(message); return answers.length ? answers.shift() : true; },
    setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length; },
    clearTimeout() {},
    structuredClone,
  };
  vm.createContext(context);
  for (const file of ["i18n.js", "lang/en.js", "lang/fr.js", "calc.js", "validation.js", "database.js", "script.js"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", "..", "java script", file), "utf8");
    vm.runInContext(source, context, { filename: file });
  }

  return {
    api: exports,
    field: element,
    localStorage,
    control,
    downloads,
    revoked,
    confirms,
    indexedDB: context.indexedDB,
    // The text of the n-th (or last) downloaded file.
    async downloadedText(index) {
      const entry = downloads[index === undefined ? downloads.length - 1 : index];
      return urls.get(entry.url).text();
    },
    // Answers for the next confirmation dialogs: true = OK, false = Cancel (OK when nothing is queued).
    answer(...list) { answers.push(...list); },
    // Runs the delayed jobs the app asked for (such as releasing download addresses).
    flushTimers() { while (timers.length) timers.shift().fn(); },
    // A stand-in for the file the person picks in the "Import" dialog.
    file(text) { return { text: async () => text }; },
    // What the toast shows right now.
    toast() { return element("toast").textContent; },
    errorText(id) { return element(id).textContent; },
    async start() {
      await exports.startStorage();
      return exports.getStorage();
    },
  };
}

module.exports = { loadApp };

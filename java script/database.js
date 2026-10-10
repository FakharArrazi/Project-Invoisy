"use strict";

/* ==========================================================================
   Database - everything Invoisy saves lives in the browser's IndexedDB.

   Plain script (no modules, so index.html still works when opened directly).
   No DOM and no localStorage writes: this file only talks to IndexedDB, and
   to localStorage only to READ data an older version left there (migration).
   Loaded after validation.js and before script.js.

   Stores (database "invoisy", version 2)
     products   one record per product            key: id
     invoices   one record per invoice            key: id   index: invoiceNumber (unique), date
                (customer, items and payments are saved inside the invoice, as before)
     settings   business settings                 key: "app"
     counters   the invoice counter               key: "invoice"
     meta       revision, migration, backup info  key: name
     kv         (version 1 only) the old data-file handle. Left untouched.

   Rules this file enforces
     - A change touching several records is ONE transaction: it is saved completely or not at all.
     - A save is only reported as done after the transaction has committed.
     - Every record is validated here before it is written, not only in the forms.
     - Every write checks a revision number, so a window that is out of date cannot overwrite newer data.
       The invoice number is chosen from that same up-to-date data, and the unique invoiceNumber index
       is the last line of defence against two invoices with the same number.
     - Nothing here ever clears the database as error recovery. The only operations that replace data
       are restore() and the first-run migration, and both verify what they wrote before it commits.
   ========================================================================== */

(function () {
  const V = globalThis.Validation;
  const t = (key, params) => I18n.t(key, params);

  const DB_NAME = "invoisy";
  const DB_VERSION = 2;
  const PRODUCTS = "products";
  const INVOICES = "invoices";
  const SETTINGS = "settings";
  const COUNTERS = "counters";
  const META = "meta";
  const LEGACY_FILE_STORE = "kv";
  const DATA_STORES = [PRODUCTS, INVOICES, SETTINGS, COUNTERS];
  const ALL_STORES = [PRODUCTS, INVOICES, SETTINGS, COUNTERS, META];
  const SETTINGS_KEY = "app";
  const COUNTER_NAME = "invoice";
  const STATE_KEY = "state";
  const MIGRATION_KEY = "migration";
  const BACKUP_KEY = "backup";
  const MIGRATION_VERSION = 1;
  const MAX_REJECTED_KEPT = 200;

  /* ---------- Errors ---------- */

  // Read at the moment an error is made, so the text is in the language of the moment (see lang/*.js).
  const MSG = {
    get UNAVAILABLE() { return t("db.unavailable"); },
    get BLOCKED() { return t("db.blocked"); },
    get VERSION() { return t("db.version"); },
    get QUOTA() { return t("db.quota"); },
    get CONFLICT() { return t("db.conflict"); },
    get CONSTRAINT() { return t("db.constraint"); },
    get CLOSED() { return t("db.closed"); },
    get ABORTED() { return t("db.aborted"); },
    get MIGRATION_UNREADABLE() { return t("db.migrationUnreadable"); },
  };

  class DbError extends Error {
    constructor(code, message, options) {
      super(message);
      this.name = "DbError";
      this.code = code;
      this.cause = options && options.cause;
      this.problems = (options && options.problems) || [];
    }
  }

  // Turns whatever IndexedDB threw into a DbError with a message a person can act on.
  function wrapError(e, phase) {
    if (e instanceof DbError) return e;
    const name = e && e.name;
    const detail = e && e.message ? ` (${e.message})` : "";
    if (name === "QuotaExceededError" || (e && e.code === 22 && name !== "NotFoundError")) return new DbError("QUOTA", MSG.QUOTA, { cause: e });
    if (name === "ConstraintError") return new DbError("CONSTRAINT", MSG.CONSTRAINT, { cause: e });
    if (name === "VersionError") return new DbError("VERSION", MSG.VERSION, { cause: e });
    if (phase === "open" || name === "SecurityError" || name === "NotSupportedError") return new DbError("UNAVAILABLE", MSG.UNAVAILABLE + detail, { cause: e });
    if (name === "InvalidStateError" || name === "TransactionInactiveError") return new DbError("CLOSED", MSG.CLOSED, { cause: e });
    return new DbError("ABORTED", MSG.ABORTED + detail, { cause: e });
  }

  /* ---------- Small IndexedDB helpers ---------- */

  function req(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);   // not handled here, so the transaction still aborts
    });
  }

  // Used when the browser gives no reason for an abort. Plain Error, so it needs no browser-only class.
  function abortedError() {
    const e = new Error("The transaction was aborted.");
    e.name = "AbortError";
    return e;
  }

  function transactionDone(tx) {
    return new Promise((resolve, reject) => {
      // A failed request aborts the transaction. Browsers report why in tx.error; the request's own
      // error is remembered as well so the reason is never lost.
      let requestError = null;
      tx.onerror = (event) => { requestError = (event && event.target && event.target.error) || requestError; };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || requestError || abortedError());
    });
  }

  function upgradeSchema(db, tx, oldVersion) {
    if (oldVersion < 2) {
      // Version 1 only had "kv" (the remembered data-file handle). It is kept as it is.
      const products = db.createObjectStore(PRODUCTS, { keyPath: "id" });
      products.createIndex("sku", "sku");
      products.createIndex("name", "name");
      const invoices = db.createObjectStore(INVOICES, { keyPath: "id" });
      invoices.createIndex("invoiceNumber", "invoiceNumber", { unique: true });
      invoices.createIndex("date", "date");
      db.createObjectStore(SETTINGS, { keyPath: "key" });
      db.createObjectStore(COUNTERS, { keyPath: "name" });
      db.createObjectStore(META, { keyPath: "key" });
    }
    // Later versions: add `if (oldVersion < 3) { ... }` here. Never delete or rewrite existing stores in place.
  }

  /* ---------- Validation of what is about to be written ---------- */

  function validateRecords(products, invoices, settings) {
    const problems = [];
    const label = (r, fallback) => (r && (r.name || r.invoiceNumber || r.id)) || fallback;
    const seenProducts = new Set();
    for (const p of products || []) {
      const why = V.productProblem(p);
      if (why) problems.push(`Product "${label(p, "?")}" ${why}.`);
      else if (seenProducts.has(p.id)) problems.push(`Two products share the id ${p.id}.`);
      else seenProducts.add(p.id);
    }
    const seenInvoices = new Set();
    const seenNumbers = new Set();
    for (const inv of invoices || []) {
      const why = V.invoiceProblem(inv);
      if (why) problems.push(`Invoice "${label(inv, "?")}" ${why}.`);
      else if (seenInvoices.has(inv.id)) problems.push(`Two invoices share the id ${inv.id}.`);
      else if (seenNumbers.has(inv.invoiceNumber)) problems.push(`Two invoices share the number ${inv.invoiceNumber}.`);
      else { seenInvoices.add(inv.id); seenNumbers.add(inv.invoiceNumber); }
    }
    if (settings !== undefined && settings !== null) {
      const why = V.settingsProblem(settings);
      if (why) problems.push(why);
    }
    return problems;
  }

  function validateChanges(changes) {
    const c = changes || {};
    const problems = validateRecords(c.products && c.products.put, c.invoices && c.invoices.put, c.settings);
    if (c.counter && (!Number.isInteger(c.counter.next) || c.counter.next < 0)) problems.push(t("data.badCounter"));
    return problems;
  }

  function invalid(problems) {
    return new DbError("INVALID", t("db.invalid", { problem: problems[0] }), { problems });
  }

  /* ---------- Changes ---------- */

  function diffList(before, after) {
    const old = new Map(before.map((r) => [r.id, r]));
    const seen = new Set();
    const put = [];
    for (const record of after) {
      seen.add(record.id);
      const previous = old.get(record.id);
      if (!previous || !V.sameValue(previous, record)) put.push(record);
    }
    const remove = before.filter((r) => !seen.has(r.id)).map((r) => r.id);
    return { put, remove };
  }

  // What changed between two copies of { products, invoices, settings, counter }. Only this is written.
  function diff(before, after) {
    return {
      products: diffList(before.products, after.products),
      invoices: diffList(before.invoices, after.invoices),
      settings: V.sameValue(before.settings, after.settings) ? null : after.settings,
      counter: after.counter === before.counter ? null : { next: after.counter },
    };
  }

  function isEmptyChange(c) {
    return !c.products.put.length && !c.products.remove.length && !c.invoices.put.length && !c.invoices.remove.length && !c.settings && !c.counter;
  }

  /* ---------- The database ---------- */

  // create() makes one database connection. The app uses one; tests make as many disposable ones as they like.
  //   options.indexedDB : the IndexedDB factory to use (default: the browser's)
  //   options.name      : database name (default "invoisy")
  //   options.channel   : false to turn off messages to other windows
  function create(options) {
    const opts = options || {};
    const name = opts.name || DB_NAME;
    const instanceId = Math.random().toString(36).slice(2);
    const listeners = { versionchange: [], blocked: [], closed: [], change: [] };
    let conn = null;
    let channel = null;

    const emit = (event, payload) => listeners[event].forEach((fn) => { try { fn(payload); } catch { /* a listener must not break the database */ } });
    const nowIso = () => (opts.now ? opts.now() : new Date()).toISOString();

    function factory() {
      if (opts.indexedDB) return opts.indexedDB;
      return typeof indexedDB !== "undefined" ? indexedDB : null;
    }

    function openConnection(idb) {
      return new Promise((resolve, reject) => {
        let request;
        try {
          request = idb.open(name, DB_VERSION);
        } catch (e) {
          reject(e);
          return;
        }
        let upgradeError = null;
        request.onupgradeneeded = (event) => {
          try {
            upgradeSchema(request.result, request.transaction, event.oldVersion);
          } catch (e) {
            upgradeError = e;
            try { request.transaction.abort(); } catch { /* already aborting */ }
          }
        };
        request.onblocked = () => emit("blocked");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(upgradeError || request.error);
      });
    }

    // Opens the database (creating or upgrading it). Safe to call more than once.
    async function initDatabase() {
      if (conn) return { name, version: conn.version };
      const idb = factory();
      if (!idb) throw new DbError("UNAVAILABLE", MSG.UNAVAILABLE);
      try {
        conn = await openConnection(idb);
      } catch (e) {
        conn = null;
        throw wrapError(e, "open");
      }
      conn.onversionchange = () => { try { conn.close(); } catch { /* ignore */ } conn = null; emit("versionchange"); };
      conn.onclose = () => { conn = null; emit("closed"); };
      if (opts.channel !== false && typeof BroadcastChannel === "function") {
        try {
          channel = new BroadcastChannel(name + "-changes");
          channel.onmessage = (event) => {
            const m = event.data;
            if (m && m.type === "changed" && m.origin !== instanceId) emit("change", m);
          };
        } catch { channel = null; }
      }
      return { name, version: conn.version };
    }

    function close() {
      if (channel) { try { channel.close(); } catch { /* ignore */ } channel = null; }
      if (conn) { try { conn.close(); } catch { /* ignore */ } conn = null; }
    }

    function requireConnection() {
      if (!conn) throw new DbError(factory() ? "CLOSED" : "UNAVAILABLE", factory() ? MSG.CLOSED : MSG.UNAVAILABLE);
      return conn;
    }

    // Runs `work` inside one transaction. Resolves only after the transaction has committed.
    // If `work` throws, or any request in it fails, the whole transaction is rolled back.
    async function withTx(storeNames, mode, work) {
      const c = requireConnection();
      let tx;
      try {
        tx = mode === "readwrite" ? c.transaction(storeNames, mode, { durability: "strict" }) : c.transaction(storeNames, mode);
      } catch (e) {
        throw wrapError(e);
      }
      const done = transactionDone(tx);
      done.catch(() => {});   // reported through the await below, never as an unhandled rejection
      let result;
      try {
        result = await work(tx);
      } catch (e) {
        try { tx.abort(); } catch { /* already aborting */ }
        const reason = await done.then(() => null, (err) => err);
        // A failed write aborts the transaction, so the next read in `work` fails with a follow-on
        // AbortError. Report the real reason (for example a duplicate invoice number), not that echo.
        const real = e && e.name === "AbortError" && reason && reason.name !== "AbortError" ? reason : e;
        throw wrapError(real);
      }
      try {
        await done;
      } catch (e) {
        throw wrapError(e);
      }
      return result;
    }

    function announce(revision) {
      if (channel) { try { channel.postMessage({ type: "changed", revision, origin: instanceId }); } catch { /* best effort */ } }
    }

    /* -- Reading -- */

    async function getAll(storeName) {
      return withTx([storeName], "readonly", (tx) => req(tx.objectStore(storeName).getAll()));
    }

    async function getById(storeName, id) {
      return withTx([storeName], "readonly", (tx) => req(tx.objectStore(storeName).get(id)));
    }

    async function count(storeName) {
      return withTx([storeName], "readonly", (tx) => req(tx.objectStore(storeName).count()));
    }

    function assemble(products, invoices, settingsRecord, counterRecord, stateRecord) {
      // Invoices come back in the order they were issued (not in id order), as the screens expect.
      const sorted = [...invoices].sort((a, b) => V.invoiceSequence(a.invoiceNumber) - V.invoiceSequence(b.invoiceNumber) || String(a.date).localeCompare(String(b.date)) || String(a.id).localeCompare(String(b.id)));
      const stored = counterRecord ? counterRecord.value : 0;
      const highest = V.highestInvoiceNumber(sorted);
      const state = (stateRecord && stateRecord.value) || { revision: 0, lastSaved: "" };
      return {
        products,
        invoices: sorted,
        settings: V.normalizeSettings(settingsRecord && settingsRecord.value),
        counter: Math.max(stored, highest),
        revision: state.revision,
        lastSaved: state.lastSaved || "",
      };
    }

    // Everything the application stores, read in ONE transaction so the stores agree with each other.
    // This is what the screens load and what Export Backup writes.
    async function loadAll() {
      return withTx(ALL_STORES, "readonly", async (tx) => {
        const [products, invoices, settingsRecord, counterRecord, stateRecord] = await Promise.all([
          req(tx.objectStore(PRODUCTS).getAll()),
          req(tx.objectStore(INVOICES).getAll()),
          req(tx.objectStore(SETTINGS).get(SETTINGS_KEY)),
          req(tx.objectStore(COUNTERS).get(COUNTER_NAME)),
          req(tx.objectStore(META).get(STATE_KEY)),
        ]);
        return assemble(products, invoices, settingsRecord, counterRecord, stateRecord);
      });
    }

    async function getSettings() {
      const record = await withTx([SETTINGS], "readonly", (tx) => req(tx.objectStore(SETTINGS).get(SETTINGS_KEY)));
      return V.normalizeSettings(record && record.value);
    }

    async function getInvoiceCounter() {
      const record = await withTx([COUNTERS], "readonly", (tx) => req(tx.objectStore(COUNTERS).get(COUNTER_NAME)));
      return record ? record.value : 0;
    }

    // Highest invoice number in use, read from the invoiceNumber index keys only (the invoices are not loaded).
    function highestStoredInvoice(tx) {
      return new Promise((resolve, reject) => {
        let max = 0;
        const cursor = tx.objectStore(INVOICES).index("invoiceNumber").openKeyCursor();
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (!c) { resolve(max); return; }
          max = Math.max(max, V.invoiceSequence(c.key));
          c.continue();
        };
        cursor.onerror = () => reject(cursor.error);
      });
    }

    // The number the next invoice would get. It only LOOKS: it does not reserve the number. The number is
    // really taken when the invoice is saved, in the same transaction (see commitChanges).
    async function getNextInvoiceNumber() {
      return withTx([COUNTERS, INVOICES], "readonly", async (tx) => {
        const [record, highest] = await Promise.all([
          req(tx.objectStore(COUNTERS).get(COUNTER_NAME)),
          highestStoredInvoice(tx),
        ]);
        return V.formatInvoiceNumber(Math.max(record ? record.value : 0, highest) + 1);
      });
    }

    /* -- Writing -- */

    // Runs inside a transaction that already includes every store. Checks the revision, writes the
    // changes, keeps the counter in line with the invoices and moves the revision on.
    async function commitInTx(tx, changes, commitOptions) {
      const meta = tx.objectStore(META);
      const stateRecord = await req(meta.get(STATE_KEY));
      const state = (stateRecord && stateRecord.value) || { revision: 0, lastSaved: "" };
      if (commitOptions.expectedRevision !== undefined && commitOptions.expectedRevision !== state.revision) {
        throw new DbError("CONFLICT", MSG.CONFLICT);
      }

      const productChanges = changes.products || {};
      const invoiceChanges = changes.invoices || {};
      const products = tx.objectStore(PRODUCTS);
      const invoices = tx.objectStore(INVOICES);
      for (const id of productChanges.remove || []) products.delete(id);
      for (const p of productChanges.put || []) products.put(p);
      for (const id of invoiceChanges.remove || []) invoices.delete(id);
      for (const inv of invoiceChanges.put || []) invoices.put(V.stripDerived(inv));
      if (changes.settings) tx.objectStore(SETTINGS).put({ key: SETTINGS_KEY, value: changes.settings });

      const counters = tx.objectStore(COUNTERS);
      const counterRecord = await req(counters.get(COUNTER_NAME));
      const stored = counterRecord ? counterRecord.value : 0;
      let next = stored;
      if (changes.counter) {
        if (changes.counter.next < stored) throw invalid([t("db.counterBackwards")]);
        next = changes.counter.next;
      }
      for (const inv of invoiceChanges.put || []) next = Math.max(next, V.invoiceSequence(inv.invoiceNumber));
      if (next !== stored || !counterRecord) counters.put({ name: COUNTER_NAME, value: next });

      const previous = Date.parse(state.lastSaved);
      const lastSaved = new Date(Math.max(Date.parse(nowIso()), Number.isNaN(previous) ? 0 : previous + 1)).toISOString();
      const revision = state.revision + 1;
      meta.put({ key: STATE_KEY, value: { revision, lastSaved } });
      return { revision, lastSaved, counter: next };
    }

    // Saves a set of changes as ONE transaction (for example a sale: the invoice, the lower stock of
    // every product sold, and the new counter). Either everything is saved or nothing is.
    //   changes: { products: { put: [], remove: [ids] }, invoices: { put: [], remove: [ids] },
    //              settings: object | null, counter: { next } | null }
    //   commitOptions.expectedRevision: the revision the caller last loaded. If another window has saved
    //              since, nothing is written and a CONFLICT error is thrown.
    async function commitChanges(changes, commitOptions) {
      const problems = validateChanges(changes);
      if (problems.length) throw invalid(problems);
      const result = await withTx(ALL_STORES, "readwrite", (tx) => commitInTx(tx, changes || {}, commitOptions || {}));
      announce(result.revision);
      return result;
    }

    function dataStoreCheck(storeName) {
      if (storeName !== PRODUCTS && storeName !== INVOICES) throw new DbError("INVALID", t("db.notStore", { store: storeName }));
    }

    // Adds one record. Fails (and saves nothing) if a record with that id already exists.
    async function add(storeName, record) {
      dataStoreCheck(storeName);
      const problems = validateRecords(storeName === PRODUCTS ? [record] : [], storeName === INVOICES ? [record] : []);
      if (problems.length) throw invalid(problems);
      const result = await withTx(ALL_STORES, "readwrite", async (tx) => {
        const existing = await req(tx.objectStore(storeName).getKey(record.id));
        if (existing !== undefined) throw new DbError("CONSTRAINT", MSG.CONSTRAINT);
        return commitInTx(tx, { [storeName]: { put: [record] } }, {});
      });
      announce(result.revision);
      return result;
    }

    // Replaces one existing record. Fails (and saves nothing) if there is no record with that id.
    async function update(storeName, record) {
      dataStoreCheck(storeName);
      const problems = validateRecords(storeName === PRODUCTS ? [record] : [], storeName === INVOICES ? [record] : []);
      if (problems.length) throw invalid(problems);
      const result = await withTx(ALL_STORES, "readwrite", async (tx) => {
        const existing = await req(tx.objectStore(storeName).getKey(record.id));
        if (existing === undefined) throw new DbError("INVALID", t("db.recordGone"));
        return commitInTx(tx, { [storeName]: { put: [record] } }, {});
      });
      announce(result.revision);
      return result;
    }

    async function remove(storeName, id) {
      dataStoreCheck(storeName);
      const result = await withTx(ALL_STORES, "readwrite", (tx) => commitInTx(tx, { [storeName]: { remove: [id] } }, {}));
      announce(result.revision);
      return result;
    }

    async function saveSettings(settings) {
      return commitChanges({ settings });
    }

    /* -- Replacing the whole dataset: restore and first-run migration -- */

    function writeDataset(tx, data, counter, state) {
      const products = tx.objectStore(PRODUCTS);
      const invoices = tx.objectStore(INVOICES);
      products.clear();
      invoices.clear();
      for (const p of data.products) products.put(p);
      for (const inv of data.invoices) invoices.put(V.stripDerived(inv));
      tx.objectStore(SETTINGS).put({ key: SETTINGS_KEY, value: data.settings });
      tx.objectStore(COUNTERS).put({ name: COUNTER_NAME, value: counter });
      tx.objectStore(META).put({ key: STATE_KEY, value: state });
    }

    // Reads back, inside the same transaction, what was just written. If anything differs the
    // transaction is aborted by the caller, so a bad write never commits.
    async function verifyDataset(tx, data, counter) {
      const [products, invoices, settingsRecord, counterRecord] = await Promise.all([
        req(tx.objectStore(PRODUCTS).getAll()),
        req(tx.objectStore(INVOICES).getAll()),
        req(tx.objectStore(SETTINGS).get(SETTINGS_KEY)),
        req(tx.objectStore(COUNTERS).get(COUNTER_NAME)),
      ]);
      const fail = (what) => new DbError("VERIFY", t("db.verifyFailed", { what: t("db.what." + what) }));
      if (products.length !== data.products.length) throw fail("products");
      if (invoices.length !== data.invoices.length) throw fail("invoices");
      const byId = new Map(products.map((p) => [p.id, p]));
      for (const p of data.products) if (!V.sameValue(byId.get(p.id), p)) throw fail("product");
      const invById = new Map(invoices.map((i) => [i.id, i]));
      for (const inv of data.invoices) if (!V.sameValue(invById.get(inv.id), V.stripDerived(inv))) throw fail("invoice");
      if (!settingsRecord || !V.sameValue(settingsRecord.value, data.settings)) throw fail("settings");
      if (!counterRecord || counterRecord.value !== counter) throw fail("counter");
    }

    // Replaces ALL products, invoices and settings with a validated backup, as ONE transaction.
    // Validation failure, a write error or a verification mismatch all roll back to the data as it was.
    // The invoice counter never goes backwards, so numbers that were already issued are never reused.
    //   data: the `data` from Validation.parseBackup()
    async function restore(data, restoreOptions) {
      const problems = validateRecords(data.products, data.invoices, data.settings);
      if (problems.length) throw invalid(problems);
      const expected = restoreOptions && restoreOptions.expectedRevision;
      const result = await withTx(ALL_STORES, "readwrite", async (tx) => {
        const [stateRecord, counterRecord] = await Promise.all([
          req(tx.objectStore(META).get(STATE_KEY)),
          req(tx.objectStore(COUNTERS).get(COUNTER_NAME)),
        ]);
        const state = (stateRecord && stateRecord.value) || { revision: 0, lastSaved: "" };
        if (expected !== undefined && expected !== state.revision) throw new DbError("CONFLICT", MSG.CONFLICT);
        const counter = Math.max(counterRecord ? counterRecord.value : 0, data.counter || 0, V.highestInvoiceNumber(data.invoices));
        const next = { revision: state.revision + 1, lastSaved: nowIso() };
        writeDataset(tx, data, counter, next);
        await verifyDataset(tx, data, counter);
        return { ...next, counter };
      });
      // After the commit, read it all back once more through a fresh transaction.
      const after = await loadAll();
      const same = after.products.length === data.products.length && after.invoices.length === data.invoices.length && after.counter === result.counter;
      if (!same) throw new DbError("VERIFY", t("db.restoreVerify"));
      announce(result.revision);
      return { ...result, counts: { products: after.products.length, invoices: after.invoices.length } };
    }

    /* -- Small settings kept next to the data (no effect on the business data) -- */

    async function getMeta(key) {
      const record = await withTx([META], "readonly", (tx) => req(tx.objectStore(META).get(key)));
      return record ? record.value : null;
    }

    async function setMeta(key, value) {
      return withTx([META], "readwrite", (tx) => { tx.objectStore(META).put({ key, value }); });
    }

    async function getBackupInfo() {
      const record = (await getMeta(BACKUP_KEY)) || {};
      return {
        lastBackupAt: record.lastBackupAt || null,
        lastBackupFile: record.lastBackupFile || "",
        lastBackupCounts: record.lastBackupCounts || null,
        intervalDays: Number.isInteger(record.intervalDays) ? record.intervalDays : V.DEFAULT_BACKUP_DAYS,
      };
    }

    // Called only after a backup file was successfully prepared and handed to the browser to download.
    async function recordBackup(info) {
      if (!V.isDate(info && info.at)) throw invalid([t("db.badBackupDate")]);
      const current = await getBackupInfo();
      await setMeta(BACKUP_KEY, { ...current, lastBackupAt: info.at, lastBackupFile: String(info.fileName || ""), lastBackupCounts: info.counts || null });
    }

    async function setBackupInterval(days) {
      if (!Number.isInteger(days) || days < 1 || days > 365) throw invalid([t("db.badInterval")]);
      const current = await getBackupInfo();
      await setMeta(BACKUP_KEY, { ...current, intervalDays: days });
    }

    /* -- Migration from the browser storage older versions used -- */

    async function legacyFileName() {
      const c = requireConnection();
      if (!c.objectStoreNames.contains(LEGACY_FILE_STORE)) return "";
      try {
        return await withTx([LEGACY_FILE_STORE], "readonly", async (tx) => {
          const handle = await req(tx.objectStore(LEGACY_FILE_STORE).get("dataFile"));
          return handle && typeof handle.name === "string" ? handle.name : "";
        });
      } catch {
        return "";
      }
    }

    // Entries that could not be used are kept, as they were stored, in the migration record. Very long
    // text is shortened here; the full text is still in the old browser copy, which is never deleted.
    function sanitizeRejected(rejected) {
      const limit = 100000;
      return rejected.slice(0, MAX_REJECTED_KEPT).map((r) => ({
        kind: r.kind,
        index: r.index,
        reason: r.reason,
        raw: typeof r.raw === "string" && r.raw.length > limit ? r.raw.slice(0, limit) + " [shortened: the full text is still in the old browser copy]" : r.raw,
      }));
    }

    // First start after the update: moves what older versions saved in localStorage into this database.
    //   legacyStorage: window.localStorage (only ever READ here)
    // Returns { status, record }. status is one of:
    //   "already"            the migration was done before; nothing happens (so it never runs twice)
    //   "nothing-to-migrate" no older data (or only an empty install); the marker is recorded
    //   "migrated"           the older data was copied, verified, and committed together with the marker
    //   "conflict"           the database already had data AND older data exists. The database wins, the
    //                        older data is left untouched and nothing is merged or guessed.
    // The older data is never deleted here. If it can not be read at all, an error is thrown and no
    // marker is written, so the next start tries again.
    async function migrateLegacy(legacyStorage) {
      requireConnection();
      const existing = await getMeta(MIGRATION_KEY);
      if (existing) return { status: "already", record: existing };

      const legacy = V.readLegacyStorage(legacyStorage);
      if (legacy.unreadable) throw new DbError("MIGRATION", MSG.MIGRATION_UNREADABLE, { problems: legacy.problems });
      const fileName = await legacyFileName();
      const stamp = nowIso();
      const base = {
        version: MIGRATION_VERSION,
        at: stamp,
        source: legacy.source || "none",
        legacyDataFile: fileName,
        legacyRetained: legacy.found,
        rejectedCount: legacy.rejected.length,
        rejected: sanitizeRejected(legacy.rejected),
        problems: legacy.problems.slice(0, 50),
        warnings: legacy.warnings.slice(0, 50),
        notes: legacy.notes.slice(0, 20),
        noticeShown: false,
      };
      const hasLegacyContent = legacy.found && !!legacy.data && (V.hasMeaningfulData(legacy.data) || legacy.rejected.length > 0);

      const result = await withTx(ALL_STORES, "readwrite", async (tx) => {
        // Checked again inside the transaction: another window may have finished the migration meanwhile.
        const marker = await req(tx.objectStore(META).get(MIGRATION_KEY));
        if (marker) return { status: "already", record: marker.value };
        const put = (record) => tx.objectStore(META).put({ key: MIGRATION_KEY, value: record });

        if (!hasLegacyContent) {
          const record = { ...base, status: "nothing-to-migrate", counts: { products: 0, invoices: 0 } };
          put(record);
          return { status: record.status, record };
        }

        const [stateRecord, productCount, invoiceCount, settingsRecord, counterRecord] = await Promise.all([
          req(tx.objectStore(META).get(STATE_KEY)),
          req(tx.objectStore(PRODUCTS).count()),
          req(tx.objectStore(INVOICES).count()),
          req(tx.objectStore(SETTINGS).get(SETTINGS_KEY)),
          req(tx.objectStore(COUNTERS).get(COUNTER_NAME)),
        ]);
        const current = {
          products: new Array(productCount),
          invoices: new Array(invoiceCount),
          settings: settingsRecord ? settingsRecord.value : null,
          counter: counterRecord ? counterRecord.value : 0,
        };
        const legacyCounts = { products: legacy.data.products.length, invoices: legacy.data.invoices.length };

        if (V.hasMeaningfulData(current)) {
          const record = { ...base, status: "conflict", legacyCounts, counts: { products: productCount, invoices: invoiceCount } };
          put(record);
          return { status: "conflict", record };
        }

        const state = (stateRecord && stateRecord.value) || { revision: 0, lastSaved: "" };
        const next = { revision: state.revision + 1, lastSaved: stamp };
        writeDataset(tx, legacy.data, legacy.data.counter, next);
        await verifyDataset(tx, legacy.data, legacy.data.counter);
        const record = { ...base, status: "migrated", legacyCounts, counts: legacyCounts };
        put(record);
        return { status: "migrated", record };
      });

      if (result.status === "migrated") {
        const after = await loadAll();
        if (after.products.length !== result.record.counts.products || after.invoices.length !== result.record.counts.invoices) {
          throw new DbError("VERIFY", t("db.migrationVerify"));
        }
        announce(after.revision);
      }
      return result;
    }

    async function getMigrationRecord() {
      return getMeta(MIGRATION_KEY);
    }

    // Lets the person start with an empty database when their older data can not be read. The older data
    // stays where it is. Only used after an explicit confirmation.
    async function skipMigration(reason) {
      return withTx(ALL_STORES, "readwrite", async (tx) => {
        const marker = await req(tx.objectStore(META).get(MIGRATION_KEY));
        if (marker) return marker.value;
        const record = { version: MIGRATION_VERSION, at: nowIso(), status: "skipped", source: "none", legacyRetained: true, reason: String(reason || ""), rejected: [], rejectedCount: 0, problems: [], warnings: [], notes: [], counts: { products: 0, invoices: 0 }, noticeShown: true };
        tx.objectStore(META).put({ key: MIGRATION_KEY, value: record });
        return record;
      });
    }

    async function updateMigrationRecord(patch) {
      const record = await getMeta(MIGRATION_KEY);
      if (!record) return null;
      const next = { ...record, ...patch };
      await setMeta(MIGRATION_KEY, next);
      return next;
    }

    // Removes the old browser copy (the entries older versions saved in localStorage). Allowed only when
    // that data is safe elsewhere: it was migrated AND a backup file has been exported, or it was
    // not migrated (conflict) AND a copy of it was downloaded.
    async function removeLegacyData(legacyStorage) {
      const record = await getMigrationRecord();
      const backup = await getBackupInfo();
      const safe = record && ((record.status === "migrated" && backup.lastBackupAt) || (record.status === "conflict" && record.legacyCopyDownloadedAt));
      if (!safe) throw invalid([t("db.removeNotAllowed")]);
      for (const key of [V.MIRROR_KEY, ...V.LEGACY_KEYS]) legacyStorage.removeItem(key);
      await updateMigrationRecord({ legacyRetained: false, legacyRemovedAt: nowIso() });
    }

    return {
      name, DbError,
      initDatabase, close,
      on(event, fn) { if (listeners[event]) listeners[event].push(fn); },
      getAll, getById, count, add, update, remove,
      loadAll, getSettings, saveSettings, getInvoiceCounter, getNextInvoiceNumber,
      commitChanges, restore,
      getMeta, setMeta, getBackupInfo, recordBackup, setBackupInterval,
      migrateLegacy, getMigrationRecord, skipMigration, updateMigrationRecord, removeLegacyData,
    };
  }

  globalThis.InvoisyDB = {
    DB_NAME, DB_VERSION, STORES: { PRODUCTS, INVOICES, SETTINGS, COUNTERS, META }, DATA_STORES, ALL_STORES,
    DbError, MSG, create, diff, isEmptyChange, validateChanges,
  };
})();

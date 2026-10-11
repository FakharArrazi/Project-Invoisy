"use strict";

// The automatic backup file (java script/autobackup.js) and the database "commit" event it relies on
// (java script/database.js). Everything runs against a disposable in-memory IndexedDB and a stand-in file handle that
// behaves like a browser FileSystemFileHandle: a write goes to a temporary copy and replaces the file only when it
// is closed. Real handles, real permission prompts and a real browser are covered by tests/e2e/autobackup_check.py.

const test = require("node:test");
const assert = require("node:assert/strict");
const { fake, V, DB, newDb, iso, sampleProduct, sampleInvoice, fakeLocalStorage, dump, failPutWith } = require("./helpers/modules");
const { loadApp } = require("./helpers/app");

const AB = globalThis.AutoBackup;
const plain = (x) => JSON.parse(JSON.stringify(x));

/* ---------- Stand-ins ---------- */

const domError = (name, message) => new DOMException(message || name, name);

class FakeHandle {
  // Only plain data is kept as own properties, so the handle can be stored by the in-memory database.
  constructor(name, content) {
    this.kind = "file";
    this.name = name || "invoisy-data.json";
    this.content = content || "";
    this.permission = "granted";
    this.grantOnRequest = true;
    this.missing = false;
    this.failWrite = null;      // name of the error the next writes fail with
    this.failClose = false;
    this.corrupt = false;       // the file ends up different from what was written
    this.history = [];          // every content that was swapped in
    this.aborts = 0;
    this.permissionRequests = 0;
  }
  async queryPermission() { return this.permission; }
  async requestPermission() {
    this.permissionRequests++;
    if (this.grantOnRequest) this.permission = "granted";
    return this.permission;
  }
  async getFile() {
    if (this.missing) throw domError("NotFoundError");
    const text = this.content;
    return { text: async () => text };
  }
  async createWritable() {
    if (this.missing) throw domError("NotFoundError");
    if (this.permission !== "granted") throw domError("NotAllowedError");
    const self = this;
    let pending = "";
    return {
      async write(chunk) {
        if (self.failWrite) throw domError(self.failWrite, "simulated write failure");
        pending += chunk;
      },
      async close() {
        if (self.gate) await self.gate;
        if (self.failClose) throw domError("NoModificationAllowedError", "simulated close failure");
        self.content = self.corrupt ? pending + " " : pending;
        self.history.push(self.content);
      },
      async abort() { self.aborts++; },
    };
  }
}

function manualTimers() {
  const jobs = new Map();
  let id = 0;
  return {
    jobs,
    set(fn, ms) { jobs.set(++id, { fn, ms }); return id; },
    clear(handle) { jobs.delete(handle); },
    fire() { const all = [...jobs.values()]; jobs.clear(); all.forEach((j) => j.fn()); },
  };
}

const memoryStore = () => ({ handle: null, async get() { return this.handle; }, async set(h) { this.handle = h; } });

// A database plus an automatic backup wired the way script.js wires it.
async function setup(overrides) {
  const db = newDb();
  await db.initDatabase();
  const timers = manualTimers();
  const store = (overrides && overrides.handleStore) || memoryStore();
  const ab = AB.create({ db, supported: true, timers, locks: null, handleStore: store, waitMs: 0, retryMs: [10, 20, 30], ...overrides, handleStore: store });
  db.on("commit", (m) => ab.notifyCommitted(m.revision));
  db.on("change", (m) => ab.notifyCommitted(m.revision));
  await ab.start();
  return { db, ab, timers, store };
}

const product = (n, overrides) => sampleProduct({ id: "p-" + n, name: "Tile " + n, sku: "T" + n, ...overrides });

// What the file holds, read the way a restore reads it.
function fileData(handle) {
  const parsed = V.parseBackup(handle.content);
  assert.equal(parsed.error, undefined, "the file must be a valid backup: " + parsed.error);
  return parsed;
}

// The file holds exactly what the database holds, at the same revision.
async function assertFileMatches(db, handle) {
  const parsed = fileData(handle);
  const all = await db.loadAll();
  assert.equal(parsed.revision, all.revision, "the file carries the database revision");
  assert.deepEqual(plain(parsed.data.products), plain(all.products));
  assert.deepEqual(plain(parsed.data.invoices.map(V.stripDerived)), plain(all.invoices));
  assert.deepEqual(plain(parsed.data.settings), plain(all.settings));
  assert.equal(parsed.data.counter, all.counter);
}

// Connects a new empty file to a database that already has some data.
async function connected(ctx, handle) {
  const h = handle || new FakeHandle();
  const result = await ctx.ab.attach(h);
  assert.equal(result.status.state, "current", result.status.error);
  return h;
}

/* ---------- 1. The commit event (database.js) ---------- */

test("every committed change to business data emits one commit event with its revision", async () => {
  const db = newDb();
  await db.initDatabase();
  const seen = [];
  db.on("commit", (m) => seen.push(m.revision));

  await db.add("products", product(1));
  await db.update("products", product(1, { name: "Renamed" }));
  await db.commitChanges({ products: { put: [product(2)] }, invoices: { put: [sampleInvoice({ number: 1 })] }, counter: { next: 1 } });
  await db.saveSettings({ ...V.DEFAULT_SETTINGS, businessName: "Shop" });
  await db.remove("products", "p-2");
  assert.deepEqual(seen, [1, 2, 3, 4, 5]);

  const before = seen.length;
  const parsed = V.parseBackup(V.prepareBackupFile(await db.loadAll(), new Date()).text);
  await db.restore(parsed.data);
  assert.equal(seen.length, before + 1, "a restore is a change too");
  assert.equal(seen[seen.length - 1], 6);
});

test("the first-run migration emits commit only when it really copied data", async () => {
  const db = newDb();
  await db.initDatabase();
  const seen = [];
  db.on("commit", (m) => seen.push(m.revision));
  assert.equal((await db.migrateLegacy(fakeLocalStorage())).status, "nothing-to-migrate");
  assert.deepEqual(seen, [], "nothing was copied: no commit");

  const db2 = newDb();
  await db2.initDatabase();
  const seen2 = [];
  db2.on("commit", (m) => seen2.push(m.revision));
  const mirror = JSON.stringify({ version: 1, lastSaved: iso(1), products: [{ id: "lp1", name: "Old", description: "", sku: "L1", category: "Old", sellingPrice: 100, priceUnit: "piece", purchasePrice: 60, stock: 10 }], invoices: [], settings: V.DEFAULT_SETTINGS, invoiceCounter: 0 });
  assert.equal((await db2.migrateLegacy(fakeLocalStorage({ "invoisy-data": mirror }))).status, "migrated");
  assert.deepEqual(seen2, [1]);
});

test("no commit event for reads, for bookkeeping in the meta store, or for anything that did not commit", async () => {
  const db = newDb();
  await db.initDatabase();
  await db.add("products", product(1));
  await db.add("invoices", sampleInvoice({ number: 1 }));
  const seen = [];
  db.on("commit", (m) => seen.push(m.revision));

  // reads
  await db.loadAll(); await db.getAll("products"); await db.getById("products", "p-1"); await db.count("invoices");
  await db.getSettings(); await db.getNextInvoiceNumber(); await db.getRevision();
  // bookkeeping that is not business data
  await db.setMeta("anything", { a: 1 });
  await db.setBackupInterval(14);
  await db.recordBackup({ at: iso(1), fileName: "x.json", counts: { products: 1, invoices: 1 } });
  assert.deepEqual(seen, [], "reads and meta writes do not trigger a backup");

  // rejected before anything is written
  await assert.rejects(db.commitChanges({ products: { put: [{ id: "bad" }] } }), (e) => e.code === "INVALID");
  // a stale window: the revision check refuses it
  await assert.rejects(db.commitChanges({ settings: { ...V.DEFAULT_SETTINGS, businessName: "x" } }, { expectedRevision: 0 }), (e) => e.code === "CONFLICT");
  // a duplicate invoice number: the unique index aborts the transaction
  await assert.rejects(db.add("invoices", sampleInvoice({ number: 2, id: "i-dup", invoiceNumber: "INV-000001" })));
  // a full disk: the transaction aborts
  const restore = failPutWith("QuotaExceededError", 1);
  try {
    await assert.rejects(db.commitChanges({ products: { put: [product(9)] } }), (e) => e.code === "QUOTA");
  } finally { restore(); }
  assert.deepEqual(seen, [], "an aborted or refused transaction never produces a backup");
  assert.equal(await db.getRevision(), 2, "and the revision did not move");

  await db.add("products", product(3));
  assert.deepEqual(seen, [3], "the next real change still does");
});

test("a listener that throws can not undo or fail a committed change", async () => {
  const db = newDb();
  await db.initDatabase();
  db.on("commit", () => { throw new Error("listener bug"); });
  const result = await db.add("products", product(1));
  assert.equal(result.revision, 1);
  assert.equal((await db.getAll("products")).length, 1);
});

/* ---------- 2. The file format ---------- */

test("the backup carries the schema version, creation time and database revision, and old files still read", async () => {
  const db = newDb();
  await db.initDatabase();
  await db.add("products", product(1));
  const file = V.prepareBackupFile(await db.loadAll(), new Date(Date.UTC(2026, 9, 10, 8)));
  const raw = JSON.parse(file.text);
  assert.equal(raw.formatVersion, 2);
  assert.equal(raw.exportedAt, "2026-10-10T08:00:00.000Z");
  assert.equal(raw.revision, 1);
  assert.equal(V.parseBackup(file.text).revision, 1);

  delete raw.revision;   // a backup made before this feature
  const old = V.parseBackup(JSON.stringify(raw));
  assert.equal(old.error, undefined);
  assert.equal(old.revision, null);

  const without = V.buildBackup({ products: [], invoices: [], settings: V.DEFAULT_SETTINGS, counter: 0 });
  assert.equal("revision" in without, false, "a snapshot without a revision produces the old shape");
});

/* ---------- 3. Connecting the file ---------- */

test("first launch: not connected, and it says so", async () => {
  const { ab } = await setup();
  const s = ab.getStatus();
  assert.equal(s.state, "not-connected");
  assert.equal(s.connected, false);
  assert.equal(s.attention, false);
});

test("connecting an empty file writes a complete valid backup, remembers the file and records the revision", async () => {
  const ctx = await setup();
  const { db, store } = ctx;
  await db.add("products", product(1));
  await db.add("invoices", sampleInvoice({ number: 1 }));
  await db.saveSettings({ ...V.DEFAULT_SETTINGS, businessName: "Shop" });
  const handle = new FakeHandle();
  const { status, remembered } = await ctx.ab.attach(handle);

  assert.equal(remembered, true);
  assert.equal(store.handle, handle, "the handle was remembered");
  assert.equal(status.state, "current");
  assert.equal(status.connected, true);
  assert.equal(status.fileName, "invoisy-data.json");
  assert.equal(status.lastRevision, 3);
  assert.equal(status.latestRevision, 3);
  assert.ok(status.lastSuccessAt);
  await assertFileMatches(db, handle);
  const info = await db.getMeta("autoBackup");
  assert.deepEqual([info.fileName, info.lastRevision], ["invoisy-data.json", 3]);
});

test("a file chosen at first start is written for the empty database too", async () => {
  const ctx = await setup();
  const handle = await connected(ctx);
  const parsed = fileData(handle);
  assert.deepEqual([parsed.data.products.length, parsed.data.invoices.length, parsed.revision], [0, 0, 0]);
});

test("inspect tells empty, Invoisy, foreign and unreadable files apart", async () => {
  const { db, ab } = await setup();
  await db.add("products", product(1));
  const good = new FakeHandle("a.json", V.prepareBackupFile(await db.loadAll(), new Date()).text);
  assert.equal((await ab.inspect(new FakeHandle())).kind, "empty");
  assert.equal((await ab.inspect(new FakeHandle("w.json", "  \n"))).kind, "empty");
  const seen = await ab.inspect(good);
  assert.equal(seen.kind, "invoisy");
  assert.equal(seen.parsed.data.products.length, 1);
  assert.equal(seen.revision, 1);
  assert.equal((await ab.inspect(new FakeHandle("x.json", "not json {"))).kind, "foreign");
  assert.equal((await ab.inspect(new FakeHandle("x.json", JSON.stringify({ hello: "world" })))).kind, "foreign");
  assert.equal((await ab.inspect(new FakeHandle("x.json", JSON.stringify({ application: "Other", formatVersion: 1, data: {} })))).kind, "foreign");
  const gone = new FakeHandle(); gone.missing = true;
  assert.equal((await ab.inspect(gone)).kind, "unreadable");
});

test("a handle without access is refused when connecting and nothing is remembered", async () => {
  const { ab, store } = await setup();
  const handle = new FakeHandle();
  handle.permission = "prompt";
  handle.grantOnRequest = false;
  await assert.rejects(ab.attach(handle), (e) => e.code === "PERMISSION");
  assert.equal(store.handle, null);
  assert.equal(ab.getStatus().connected, false);
});

test("if the browser can not remember the handle, connecting still works and says it was not remembered", async () => {
  const store = { async get() { return null; }, async set() { throw domError("DataCloneError"); } };
  const { ab } = await setup({ handleStore: store });
  const { status, remembered } = await ab.attach(new FakeHandle());
  assert.equal(remembered, false);
  assert.equal(status.state, "current");
});

/* ---------- 4. Every change updates the file ---------- */

test("adding and editing a product update the file", async () => {
  const ctx = await setup();
  const handle = await connected(ctx);
  await ctx.db.add("products", product(1, { stock: 5 }));
  await ctx.ab.flushNow();
  await assertFileMatches(ctx.db, handle);
  assert.equal(fileData(handle).data.products[0].stock, 5);

  await ctx.db.update("products", product(1, { stock: 9, sellingPrice: 1234 }));
  await ctx.ab.flushNow();
  await assertFileMatches(ctx.db, handle);
  const stored = fileData(handle).data.products[0];
  assert.deepEqual([stored.stock, stored.sellingPrice], [9, 1234]);
  assert.equal(ctx.ab.getStatus().state, "current");
});

test("a sale (invoice, lower stock, new counter) and a later payment update the file", async () => {
  const ctx = await setup();
  const handle = await connected(ctx);
  await ctx.db.add("products", product(1, { stock: 20 }));
  await ctx.ab.flushNow();

  await ctx.db.commitChanges({ invoices: { put: [sampleInvoice({ number: 1 })] }, products: { put: [product(1, { stock: 18 })] }, counter: { next: 1 } });
  await ctx.ab.flushNow();
  await assertFileMatches(ctx.db, handle);
  let data = fileData(handle).data;
  assert.equal(data.products[0].stock, 18);
  assert.equal(data.invoices[0].invoiceNumber, "INV-000001");
  assert.equal(data.invoiceCounter === undefined ? data.counter : data.invoiceCounter, 1);
  assert.equal(data.invoices[0].payments.length, 1);

  const paid = sampleInvoice({ number: 1, payments: [{ amount: 500, timestamp: iso(1) }, { amount: 1400, timestamp: iso(5) }] });
  await ctx.db.update("invoices", paid);
  await ctx.ab.flushNow();
  await assertFileMatches(ctx.db, handle);
  data = fileData(handle).data;
  assert.deepEqual(data.invoices[0].payments.map((p) => p.amount), [500, 1400]);
  assert.equal(JSON.parse(handle.content).data.invoices[0].status, "paid", "the file shows the payment status as Export Backup does");
});

test("changed settings and a raised invoice counter are in the file", async () => {
  const ctx = await setup();
  const handle = await connected(ctx);
  await ctx.db.saveSettings({ ...V.DEFAULT_SETTINGS, businessName: "Timgad Ceramic", currency: "DZD", paper: "A5" });
  await ctx.db.commitChanges({ counter: { next: 41 } });
  await ctx.ab.flushNow();
  await assertFileMatches(ctx.db, handle);
  const data = fileData(handle).data;
  assert.deepEqual([data.settings.businessName, data.settings.currency, data.settings.paper], ["Timgad Ceramic", "DZD", "A5"]);
  assert.equal(data.counter, 41);
});

test("deleting a record and restoring a backup update the file", async () => {
  const ctx = await setup();
  const handle = await connected(ctx);
  await ctx.db.commitChanges({ products: { put: [product(1), product(2)] } });
  await ctx.ab.flushNow();
  await ctx.db.remove("products", "p-1");
  await ctx.ab.flushNow();
  assert.deepEqual(fileData(handle).data.products.map((p) => p.id), ["p-2"]);

  const other = newDb();
  await other.initDatabase();
  await other.commitChanges({ products: { put: [product(7), product(8), product(9)] } });
  const incoming = V.parseBackup(V.prepareBackupFile(await other.loadAll(), new Date()).text);
  await ctx.db.restore(incoming.data);
  await ctx.ab.flushNow();
  await assertFileMatches(ctx.db, handle);
  assert.equal(fileData(handle).data.products.length, 3);
});

test("the file imports through the normal restore into an empty database, with nothing lost", async () => {
  const ctx = await setup();
  const handle = await connected(ctx);
  await ctx.db.commitChanges({ products: { put: [product(1), product(2)] }, invoices: { put: [sampleInvoice({ number: 1 }), sampleInvoice({ number: 2, id: "i-2", payments: [] })] }, counter: { next: 2 }, settings: { ...V.DEFAULT_SETTINGS, businessName: "Shop" } });
  await ctx.ab.flushNow();

  const fresh = newDb();
  await fresh.initDatabase();
  const parsed = V.parseBackup(handle.content);
  assert.equal(parsed.error, undefined);
  await fresh.restore(parsed.data);
  const [a, b] = [await dump(ctx.db), await dump(fresh)];
  assert.deepEqual([b.products, b.invoices, b.settings, b.counter], [a.products, a.invoices, a.settings, a.counter]);
});

/* ---------- 5. Reliable writing ---------- */

test("several rapid transactions are folded into few writes and the final file is current", async () => {
  const ctx = await setup();
  const handle = await connected(ctx);
  const writesBefore = handle.history.length;
  for (let i = 1; i <= 10; i++) await ctx.db.add("products", product(i));
  assert.equal(ctx.timers.jobs.size, 1, "one short wait was scheduled for all of them, not one per change");
  assert.equal(handle.history.length, writesBefore, "nothing is written until the wait is over");
  assert.equal(ctx.ab.getStatus().state, "pending");

  ctx.timers.fire();
  await ctx.ab.flushNow();
  assert.equal(handle.history.length - writesBefore, 1, "ten changes, one write");
  await assertFileMatches(ctx.db, handle);
  assert.equal(ctx.ab.getStatus().state, "current");
  assert.equal(fileData(handle).revision, 10);
});

test("a flush with nothing waiting does not stop later changes from being written", async () => {
  const ctx = await setup();
  const handle = await connected(ctx);
  await ctx.ab.flushNow();   // nothing is waiting
  await ctx.ab.flushNow();
  ctx.timers.fire();         // a wait timer that fires after everything was already written
  await ctx.db.add("products", product(1));
  await ctx.ab.flushNow();
  assert.equal(ctx.ab.getStatus().state, "current");
  await assertFileMatches(ctx.db, handle);
});

test("a change that commits while a write is running is picked up, and revisions only ever go up", async () => {
  const ctx = await setup();
  const handle = await connected(ctx);
  let release;
  handle.gate = new Promise((resolve) => { release = resolve; });

  await ctx.db.add("products", product(1));
  const first = ctx.ab.flushNow();
  await new Promise((r) => setImmediate(r));
  assert.equal(ctx.ab.getStatus().state, "writing", "a started write is not a finished backup");
  assert.notEqual(ctx.ab.getStatus().lastRevision, 1);

  await ctx.db.add("products", product(2));   // commits while the first write is held up
  await ctx.db.add("products", product(3));
  handle.gate = null;
  release();
  await first;
  await ctx.ab.flushNow();

  assert.equal(ctx.ab.getStatus().state, "current");
  await assertFileMatches(ctx.db, handle);
  const revisions = handle.history.map((text) => JSON.parse(text).revision);
  assert.deepEqual([...revisions].sort((a, b) => a - b), revisions, "no older snapshot ever replaced a newer one: " + revisions);
  assert.equal(revisions[revisions.length - 1], 3);
});

test("two windows with the same file never write the same revision twice, and the last write is the newest", async () => {
  const locks = (() => { let tail = Promise.resolve(); return { request: (name, fn) => { const run = tail.then(fn, fn); tail = run.catch(() => {}); return run; } }; })();
  const db = newDb();
  await db.initDatabase();
  const handle = new FakeHandle();
  const store = memoryStore();
  store.handle = handle;
  const make = () => AB.create({ db, supported: true, timers: manualTimers(), locks, handleStore: store, waitMs: 0 });
  const [a, b] = [make(), make()];
  await a.start(); await b.start();
  for (const ab of [a, b]) { db.on("commit", (m) => ab.notifyCommitted(m.revision)); db.on("change", (m) => ab.notifyCommitted(m.revision)); }
  await a.flushNow();   // brings the empty file up to date
  const base = handle.history.length;

  await db.add("products", product(1));
  await Promise.all([a.flushNow(), b.flushNow()]);
  assert.equal(handle.history.length - base, 1, "the second window found the file already current");
  assert.equal(fileData(handle).revision, 1);
  assert.equal(a.getStatus().state, "current");
  assert.equal(b.getStatus().state, "current");
});

test("the file is read back after writing, and a write that did not produce the right content is not counted", async () => {
  const ctx = await setup();
  const handle = await connected(ctx);
  handle.corrupt = true;
  await ctx.db.add("products", product(1));
  await ctx.ab.flushNow();
  const s = ctx.ab.getStatus();
  assert.equal(s.state, "error");
  assert.match(s.error, /reading it back/);
  assert.equal(s.lastRevision, 0, "the old revision stays the last verified one");
});

/* ---------- 6. Failures never touch the database ---------- */

test("a failed write keeps the committed change, stays pending, and is completed when the file works again", async () => {
  const ctx = await setup();
  const handle = await connected(ctx);
  const good = handle.content;
  handle.failWrite = "NoModificationAllowedError";
  const added = await ctx.db.add("products", product(1));   // the business transaction succeeds regardless
  assert.equal(added.revision, 1);
  await ctx.ab.flushNow();

  let s = ctx.ab.getStatus();
  assert.equal(s.state, "error");
  assert.equal(s.lastRevision, 0, "not recorded as backed up");
  assert.equal(s.latestRevision, 1);
  assert.match(s.error, /could not be updated/);
  assert.equal(handle.content, good, "the previous file is exactly as it was");
  assert.ok(handle.aborts >= 1, "the unfinished write was abandoned");
  assert.equal((await ctx.db.getAll("products")).length, 1, "the data is safe in the database");
  assert.equal(ctx.timers.jobs.size, 1, "one retry is scheduled");

  handle.failWrite = null;
  ctx.timers.fire();                // the retry
  await ctx.ab.flushNow();
  s = ctx.ab.getStatus();
  assert.equal(s.state, "current");
  assert.equal(s.error, "");
  await assertFileMatches(ctx.db, handle);
});

test("retries are limited: a file that never works is tried a few times, then it waits", async () => {
  const ctx = await setup();
  const handle = await connected(ctx);
  handle.failWrite = "NoModificationAllowedError";
  let attempts = 0;
  const original = handle.createWritable.bind(handle);
  handle.createWritable = async () => { attempts++; return original(); };

  await ctx.db.add("products", product(1));
  await ctx.ab.flushNow();
  for (let i = 0; i < 20 && ctx.timers.jobs.size; i++) { ctx.timers.fire(); await ctx.ab.flushNow(); }
  assert.equal(attempts, 4, "the first attempt and three retries, then no more");
  assert.equal(ctx.timers.jobs.size, 0, "no timer is left running");
  assert.equal(ctx.ab.getStatus().state, "error");

  await ctx.db.add("products", product(2));   // a new change is a reason to try again
  await ctx.ab.flushNow();
  assert.equal(attempts, 5);

  handle.failWrite = null;
  const status = await ctx.ab.retry();       // and so is the Retry button
  assert.equal(status.state, "current");
  await assertFileMatches(ctx.db, handle);
});

test("a file that was moved or deleted is reported, not retried in a loop, and fixed by choosing it again", async () => {
  const ctx = await setup();
  const handle = await connected(ctx);
  handle.missing = true;
  await ctx.db.add("products", product(1));
  await ctx.ab.flushNow();
  const s = ctx.ab.getStatus();
  assert.equal(s.state, "error");
  assert.match(s.error, /not found/i);
  assert.equal(ctx.timers.jobs.size, 0, "no automatic retry for a missing file");

  const replacement = new FakeHandle("invoisy-data.json");
  const result = await ctx.ab.attach(replacement);
  assert.equal(result.status.state, "current");
  await assertFileMatches(ctx.db, replacement);
});

test("lost permission: the change is saved, no write is attempted, the warning is clear, and granting completes the backup", async () => {
  const ctx = await setup();
  const handle = await connected(ctx);
  handle.permission = "prompt";
  const writesBefore = handle.history.length;
  const added = await ctx.db.add("products", product(1));
  await ctx.ab.flushNow();
  assert.equal(added.revision, 1);
  let s = ctx.ab.getStatus();
  assert.equal(s.state, "needs-permission");
  assert.equal(s.attention, true);
  assert.equal(handle.history.length, writesBefore, "nothing was written");
  assert.equal(handle.permissionRequests, 0, "a prompt is never opened without a click");
  assert.notEqual(s.state, "current");

  s = await ctx.ab.grant();
  assert.equal(s.state, "current");
  await assertFileMatches(ctx.db, handle);
});

test("permission denied again: still needs permission and the database keeps working", async () => {
  const ctx = await setup();
  const handle = await connected(ctx);
  handle.permission = "denied";
  handle.grantOnRequest = false;
  await ctx.db.add("products", product(1));
  await ctx.ab.flushNow();
  const s = await ctx.ab.grant();
  assert.equal(s.state, "needs-permission");
  await ctx.db.add("products", product(2));   // the application carries on
  assert.equal((await ctx.db.getAll("products")).length, 2);
});

test("a file that holds newer data than the database is not overwritten", async () => {
  const ctx = await setup();
  const handle = await connected(ctx);
  await ctx.db.add("products", product(1));
  await ctx.ab.flushNow();
  const newer = JSON.parse(handle.content);
  newer.revision = 99;
  handle.content = JSON.stringify(newer);
  const kept = handle.content;
  const writes = handle.history.length;

  await ctx.db.add("products", product(2));
  await ctx.ab.flushNow();
  const s = ctx.ab.getStatus();
  assert.equal(s.state, "file-newer");
  assert.equal(s.attention, true);
  assert.match(s.error, /newer data/);
  assert.equal(handle.content, kept);
  assert.equal(handle.history.length, writes);
});

/* ---------- 7. Start-up ---------- */

test("on restart the file is reconnected, and a database that moved on while the app was closed is brought up to date", async () => {
  const first = await setup();
  const handle = await connected(first);
  await first.db.add("products", product(1));
  await first.ab.flushNow();

  // The app is closed; another window (or an older Invoisy) changes the database; the app is opened again.
  await first.db.add("products", product(2));
  const second = AB.create({ db: first.db, supported: true, timers: manualTimers(), locks: null, handleStore: first.store, waitMs: 0 });
  assert.equal(JSON.parse(handle.content).revision, 1);
  await second.start();
  assert.equal(second.getStatus().state, "current");
  assert.equal(JSON.parse(handle.content).revision, 2);
  await assertFileMatches(first.db, handle);
});

test("on restart a file that is already current is verified but not rewritten", async () => {
  const first = await setup();
  const handle = await connected(first);
  await first.db.add("products", product(1));
  await first.ab.flushNow();
  const writes = handle.history.length;

  const second = AB.create({ db: first.db, supported: true, timers: manualTimers(), locks: null, handleStore: first.store, waitMs: 0 });
  await second.start();
  assert.equal(second.getStatus().state, "current");
  assert.equal(handle.history.length, writes, "no needless disk write");
});

test("on restart the notes are not trusted: a file that was emptied or replaced is written again", async () => {
  const first = await setup();
  const handle = await connected(first);
  await first.db.add("products", product(1));
  await first.ab.flushNow();
  handle.content = "";   // someone emptied the file

  const second = AB.create({ db: first.db, supported: true, timers: manualTimers(), locks: null, handleStore: first.store, waitMs: 0 });
  await second.start();
  assert.equal(second.getStatus().state, "current");
  await assertFileMatches(first.db, handle);
});

test("on restart without access: permission is requested only by a click, and nothing is restored from the file", async () => {
  const first = await setup();
  const handle = await connected(first);
  await first.db.add("products", product(1));
  await first.ab.flushNow();
  handle.permission = "prompt";

  const second = AB.create({ db: first.db, supported: true, timers: manualTimers(), locks: null, handleStore: first.store, waitMs: 0 });
  await second.start();
  const s = second.getStatus();
  assert.equal(s.state, "needs-permission");
  assert.equal(handle.permissionRequests, 0);
  assert.equal(second.getStatus().connected, true);
  assert.equal((await first.db.getAll("products")).length, 1, "the database was not touched");
  assert.equal((await second.grant()).state, "current");
});

test("an empty database never has data restored into it from the file", async () => {
  const source = await setup();
  const handle = await connected(source);
  await source.db.add("products", product(1));
  await source.ab.flushNow();

  const empty = newDb();
  await empty.initDatabase();
  const store = memoryStore();
  store.handle = handle;
  const ab = AB.create({ db: empty, supported: true, timers: manualTimers(), locks: null, handleStore: store, waitMs: 0 });
  await ab.start();
  assert.equal((await empty.getAll("products")).length, 0, "the file is never loaded back automatically");
  assert.equal(ab.getStatus().state, "file-newer", "and the file's data is not overwritten by the empty database");
  assert.equal(fileData(handle).data.products.length, 1);
});

test("an unsupported browser reports it plainly and does nothing", async () => {
  const { db, ab, timers } = await setup({ supported: false });
  const s = ab.getStatus();
  assert.equal(s.state, "unsupported");
  assert.equal(s.supported, false);
  assert.equal(s.attention, false);
  await db.add("products", product(1));
  assert.equal(timers.jobs.size, 0);
  assert.equal(ab.getStatus().state, "unsupported");
});

/* ---------- 8. Inside the application (script.js) ---------- */

function pickerReturning(handle) {
  return { showSaveFilePicker: async () => handle };
}

async function startedApp(handle, extra) {
  const app = loadApp({ globals: handle ? pickerReturning(handle) : {}, ...extra });
  const storage = await app.start();
  assert.equal(storage.mode, "ready", storage.reason);
  return app;
}

const tileValues = (overrides) => {
  const { id, ...values } = sampleProduct({ name: "Everton Grey", tileSize: "60*60", coveragePerBox: 1.44, sku: "EV-60", sellingPrice: 800, priceUnit: "m2", purchasePrice: 600, stock: 10, ...overrides });
  return values;
};

test("app: with no file API the Settings section explains it and the manual export still works", async () => {
  const app = await startedApp(null);
  assert.equal(app.api.autoBackup.getStatus().state, "unsupported");
  assert.equal(app.field("autoStatus").textContent, "Not enabled");
  assert.equal(app.field("autoConnection").textContent, "Not available in this browser");
  assert.match(app.field("autoNote").textContent, /NOT enabled/);
  assert.equal(app.field("autoChoose").hidden, true);

  await app.api.addProduct(tileValues());
  await app.api.exportBackup();
  const exported = JSON.parse(await app.downloadedText());
  assert.equal(exported.data.products.length, 1);
  assert.equal(exported.formatVersion, 2);
  assert.equal(app.field("backupReminder").dataset.mode, "", "no automatic-backup warning when there is none");
});

test("app: first launch shows the connect action, then connecting writes the first backup", async () => {
  const handle = new FakeHandle();
  const app = await startedApp(handle);
  assert.equal(app.field("autoConnection").textContent, "Not connected");
  assert.equal(app.field("autoStatus").textContent, "Not enabled");
  assert.match(app.field("autoNote").textContent, /not enabled yet/);
  assert.equal(app.field("autoChoose").textContent, "Choose backup file");

  await app.api.addProduct(tileValues());
  await app.api.connectBackupFile();
  assert.equal(app.field("autoConnection").textContent, "Connected");
  assert.equal(app.field("autoFile").textContent, "invoisy-data.json");
  assert.equal(app.field("autoStatus").textContent, "Backup current");
  assert.equal(app.field("autoBackedRevision").textContent, app.field("autoDbRevision").textContent);
  assert.equal(app.field("autoError").textContent, "None");
  assert.equal(app.field("autoChoose").textContent, "Choose a different file");
  assert.match(app.toast(), /Automatic backup is on/);
  assert.equal(fileData(handle).data.products.length, 1);
  assert.equal(app.confirms.length, 0, "an empty file needs no confirmation");
});

test("app: a product, a sale, a payment and a settings change each update the file through the normal screens' code", async () => {
  const handle = new FakeHandle();
  const app = await startedApp(handle);
  await app.api.connectBackupFile();
  const flush = async () => { await app.api.autoBackup.flushNow(); await assertFileMatches(app.api.db, handle); };

  await app.api.addProduct(tileValues());
  await flush();
  const id = app.api.getState().products[0].id;

  await app.api.addStock(id, "5");
  await flush();
  assert.equal(fileData(handle).data.products[0].stock, 15);

  assert.equal(app.api.addToSale(id, "2", "box").ok, true);
  app.api.getSale().paidValue = "1000";
  await app.api.completeSale();
  await flush();
  let data = fileData(handle).data;
  assert.equal(data.invoices.length, 1);
  assert.equal(data.products[0].stock, 13, "the invoice and its stock change are in the same backup");

  assert.equal((await app.api.addPayment(app.api.getState().invoices[0].id, "500")).error, undefined);
  await flush();
  assert.deepEqual(fileData(handle).data.invoices[0].payments.map((p) => p.amount), [1000, 500]);

  assert.equal((await app.api.commit((d) => { d.settings.businessName = "Timgad Ceramic"; })).error, undefined);
  await flush();
  assert.equal(fileData(handle).data.settings.businessName, "Timgad Ceramic");
  assert.equal(app.field("autoStatus").textContent, "Backup current");
});

test("app: a refused change (it does not commit) produces no backup write", async () => {
  const handle = new FakeHandle();
  const app = await startedApp(handle);
  await app.api.connectBackupFile();
  await app.api.addProduct(tileValues());
  await app.api.autoBackup.flushNow();
  const writes = handle.history.length;

  const too = await app.api.addPayment("no-such-invoice", "5");
  assert.ok(too.error);
  await app.api.autoBackup.flushNow();
  assert.equal(handle.history.length, writes);
});

test("app: when the file can not be written the Settings section and the top bar say so, and the sale still completes", async () => {
  const handle = new FakeHandle();
  const app = await startedApp(handle);
  await app.api.connectBackupFile();
  await app.api.addProduct(tileValues());
  await app.api.autoBackup.flushNow();

  handle.failWrite = "NoModificationAllowedError";
  await app.api.addStock(app.api.getState().products[0].id, "5");   // the database change succeeds
  assert.equal(app.api.getState().products[0].stock, 15);
  await app.api.autoBackup.flushNow();

  assert.equal(app.field("autoStatus").textContent, "Backup pending (the last attempt failed)");
  assert.notEqual(app.field("autoBackedRevision").textContent, app.field("autoDbRevision").textContent);
  assert.match(app.field("autoError").textContent, /could not be updated/);
  assert.equal(app.field("autoRetry").hidden, false);
  assert.equal(app.field("backupReminder").hidden, false);
  assert.equal(app.field("backupReminder").dataset.mode, "auto");
  assert.equal(app.field("backupReminder").textContent, "Automatic backup needs attention");

  handle.failWrite = null;
  await app.api.autoBackup.retry();
  assert.equal(app.field("autoStatus").textContent, "Backup current");
  assert.equal(app.field("autoError").textContent, "None");
  assert.equal(app.field("backupReminder").dataset.mode, "", "the warning is gone once the backup is current");
});

test("app: lost permission shows the Grant permission action", async () => {
  const handle = new FakeHandle();
  const app = await startedApp(handle);
  await app.api.connectBackupFile();
  handle.permission = "prompt";
  await app.api.addProduct(tileValues());
  await app.api.autoBackup.flushNow();
  assert.equal(app.field("autoConnection").textContent, "Connected, permission needed");
  assert.equal(app.field("autoStatus").textContent, "Backup pending (permission needed)");
  assert.equal(app.field("autoGrant").hidden, false);
  await app.api.autoBackup.grant();
  assert.equal(app.field("autoStatus").textContent, "Backup current");
  assert.equal(app.field("autoGrant").hidden, true);
});

test("app: the Settings text follows the language", async () => {
  const handle = new FakeHandle();
  const app = await startedApp(handle);
  await app.api.connectBackupFile();
  assert.equal((await app.api.commit((d) => { d.settings.language = "fr"; })).error, undefined);
  await app.api.autoBackup.flushNow();
  app.api.renderAutoBackup();
  assert.equal(app.field("autoStatus").textContent, "Sauvegarde à jour");
  assert.equal(app.field("autoConnection").textContent, "Connecté");
  assert.equal(fileData(handle).data.settings.language, "fr");
});

/* -- choosing a file that already holds something -- */

async function appWithData(handle) {
  const app = await startedApp(handle);
  await app.api.addProduct(tileValues());
  return app;
}

test("app: a file that is not an Invoisy backup is refused and left untouched", async () => {
  const handle = new FakeHandle("notes.json", JSON.stringify({ shopping: ["milk"] }));
  const app = await appWithData(handle);
  await app.api.connectBackupFile();
  assert.match(app.errorText("dataError"), /not an Invoisy backup/);
  assert.equal(handle.content, JSON.stringify({ shopping: ["milk"] }));
  assert.equal(handle.history.length, 0);
  assert.equal(app.api.autoBackup.getStatus().connected, false);
});

test("app: a file with text that is not even JSON is refused and left untouched", async () => {
  const handle = new FakeHandle("diary.txt", "Dear diary, today I sold tiles.");
  const app = await appWithData(handle);
  await app.api.connectBackupFile();
  assert.match(app.errorText("dataError"), /not an Invoisy backup/);
  assert.equal(handle.content, "Dear diary, today I sold tiles.");
  assert.equal(app.api.autoBackup.getStatus().connected, false);
});

test("app: an empty Invoisy never overwrites a file that has data: restore it first", async () => {
  const source = await appWithData(new FakeHandle());
  await source.api.exportBackup();
  const backupText = await source.downloadedText();

  const handle = new FakeHandle("invoisy-data.json", backupText);
  const app = await startedApp(handle);   // a brand new, empty Invoisy
  await app.api.connectBackupFile();
  assert.match(app.errorText("dataError"), /Invoisy has no data/);
  assert.equal(handle.content, backupText);
  assert.equal(app.confirms.length, 0);
  assert.equal(app.api.autoBackup.getStatus().connected, false);
  assert.equal(app.api.getState().products.length, 0, "and nothing was loaded from the file either");
});

test("app: a different backup in the file: the person confirms, a copy is downloaded first, then the file is replaced", async () => {
  const source = await appWithData(new FakeHandle());
  await source.api.exportBackup();
  const oldBackup = await source.downloadedText();

  const handle = new FakeHandle("invoisy-data.json", oldBackup);
  const app = await startedApp(handle);
  await app.api.addProduct(tileValues({ name: "Another tile", sku: "AT-1" }));
  await app.api.addProduct(tileValues({ name: "Third tile", sku: "AT-2" }));
  await app.api.connectBackupFile();

  assert.equal(app.confirms.length, 1);
  assert.match(app.confirms[0], /REPLACE the content of the file/);
  assert.match(app.confirms[0], /In the file: 1 product/);
  assert.match(app.confirms[0], /In Invoisy: 2 products/);
  const safety = app.downloads.find((d) => /invoisy-before-autobackup-\d{4}-\d{2}-\d{2}\.json/.test(d.name));
  assert.ok(safety, "a copy of the old file was downloaded");
  assert.equal(await app.downloadedText(app.downloads.indexOf(safety)), oldBackup, "the copy is the file exactly as it was");
  assert.equal(fileData(handle).data.products.length, 2, "now the file holds Invoisy's data");
  assert.equal(app.api.autoBackup.getStatus().state, "current");
});

test("app: cancelling the replacement changes nothing and does not connect", async () => {
  const source = await appWithData(new FakeHandle());
  await source.api.exportBackup();
  const oldBackup = await source.downloadedText();
  const handle = new FakeHandle("invoisy-data.json", oldBackup);
  const app = await startedApp(handle);
  await app.api.addProduct(tileValues({ name: "Another tile", sku: "AT-1" }));
  app.answer(false);
  await app.api.connectBackupFile();
  assert.equal(handle.content, oldBackup);
  assert.equal(handle.history.length, 0);
  assert.equal(app.downloads.length, 0, "no copy needed when nothing is replaced");
  assert.equal(app.api.autoBackup.getStatus().connected, false);
  assert.match(app.toast(), /Nothing was changed/);
});

test("app: a file that already holds exactly this data is connected without any question", async () => {
  const handle = new FakeHandle();
  const app = await appWithData(handle);
  await app.api.exportBackup();
  handle.content = await app.downloadedText();
  const before = app.downloads.length;
  await app.api.connectBackupFile();
  assert.equal(app.confirms.length, 0);
  assert.equal(app.downloads.length, before, "no safety copy is needed either");
  assert.equal(app.api.autoBackup.getStatus().state, "current");
});

test("app: cancelling the file chooser does nothing", async () => {
  const app = loadApp({ globals: { showSaveFilePicker: async () => { throw domError("AbortError"); } } });
  await app.start();
  await app.api.connectBackupFile();
  assert.equal(app.api.autoBackup.getStatus().connected, false);
  assert.equal(app.errorText("dataError"), "");
});

test("app: the older data file (invoisy-data.json of the previous version) with different data is treated like any other file with data", async () => {
  const legacy = JSON.stringify({ version: 1, lastSaved: iso(1), products: [{ id: "lp1", name: "Old", description: "", sku: "L1", category: "Old", sellingPrice: 100, priceUnit: "piece", purchasePrice: 60, stock: 10 }], invoices: [], settings: V.DEFAULT_SETTINGS, invoiceCounter: 0 });
  const handle = new FakeHandle("invoisy-data.json", legacy);
  const app = await appWithData(handle);
  await app.api.connectBackupFile();
  assert.equal(app.confirms.length, 1, "it asks first");
  assert.equal(await app.downloadedText(app.downloads.length - 1), legacy, "and keeps a copy of the old file");
});

test("the automatic backup file keeps attached supplier invoices, so the file it writes can be restored", async () => {
  const db = newDb();
  await db.initDatabase();
  const P = globalThis.Purchases;
  const before = await db.loadAll();
  const d = structuredClone(before);
  d.attachments = { put: [], remove: [] };
  d.products.push(product(1));
  P.saveSupplier(d, { name: "Timgad Ceramic" });
  const file = { id: "att-1", name: "invoice.pdf", type: "application/pdf", size: 9, addedAt: new Date().toISOString(), dataUrl: "data:application/pdf;base64,JVBERi0=" };
  const drafted = P.saveDraft(d, { supplierId: d.suppliers[0].id, supplierInvoiceNumber: "FA-1", invoiceDate: P.toDay(new Date()), lines: [{ productId: d.products[0].id, unit: d.products[0].stockUnit, qty: "1", unitPrice: "5" }], attachments: [P.attachmentMeta(file)] });
  assert.equal(drafted.error, undefined, drafted.error);
  d.attachments.put.push({ ...file, purchaseId: drafted.purchase.id });
  await db.commitChanges(DB.diff(before, d), { expectedRevision: before.revision });

  const snapshot = await db.loadAll({ withAttachments: true });
  const built = V.prepareBackupFile(snapshot, new Date());
  assert.equal(built.error, undefined, "the file is valid with its attachments");
  const parsed = V.parseBackup(built.text);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.data.attachments.length, 1);
  const withoutFiles = V.prepareBackupFile(await db.loadAll(), new Date());
  assert.match(withoutFiles.error, /missing from the data/, "a snapshot without attachment data is refused instead of written");
});

"use strict";

// AutoBackup.flushNow() is what runs when the desktop window is closing. It must leave nothing waiting, even when an
// automatic pass was already running and then stopped early because the person is in the middle of a task (the "hold").

const test = require("node:test");
const assert = require("node:assert/strict");
const { newDb, sampleProduct } = require("./helpers/modules");
const { FakeHandle } = require("./helpers/fake-handle");

const AB = globalThis.AutoBackup;
const timers = { jobs: [], set(fn) { this.jobs.push(fn); return this.jobs.length; }, clear() {} };

test("flushNow writes the newest change even if an automatic pass was running and the person is mid-task", async () => {
  const db = newDb();
  await db.initDatabase();
  const handle = new FakeHandle();
  const store = { h: handle, async get() { return this.h; }, async set(h) { this.h = h; } };
  let held = false;
  const ab = AB.create({ db, supported: true, timers, locks: null, handleStore: store, waitMs: 0, retryMs: [10], hold: () => held });
  db.on("commit", (m) => ab.notifyCommitted(m.revision));
  await ab.start();

  const add = (name) => db.add("products", sampleProduct({ name }));
  const fileRevision = () => JSON.parse(handle.content).revision;

  // A write is in flight (its file swap is held back), started the automatic way.
  let release;
  handle.gate = new Promise((r) => { release = r; });
  await add("one");
  timers.jobs.splice(0).forEach((fn) => fn());           // the short wait ended: the automatic pass starts and blocks on the gate
  await new Promise((r) => setTimeout(r, 10));
  // The person is now mid-task and another change is committed while that pass is running.
  held = true;
  await add("two");
  const dbRevision = (await db.loadAll()).revision;
  assert.ok(dbRevision >= 2);

  const flushed = ab.flushNow();                          // the window is closing
  release();
  await flushed;
  assert.equal(fileRevision(), dbRevision, "the file holds the newest change, not the one before it");
  assert.equal(JSON.parse(handle.content).counts.products, 2);
  assert.equal(ab.getStatus().state, "current");
});

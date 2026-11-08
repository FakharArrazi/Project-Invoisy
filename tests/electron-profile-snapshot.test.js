"use strict";

// electron/profile-snapshot.js: a copy of the raw IndexedDB folder at start-up, so the original files are never the only
// copy. Plain Node, tested against a temporary folder shaped like Chromium's profile.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { snapshotProfile } = require("../electron/profile-snapshot");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "invoisy-ps-"));
const idb = (userData) => path.join(userData, "IndexedDB", "app_invoisy_0.indexeddb.leveldb");
function makeProfile(userData, files) {
  fs.mkdirSync(idb(userData), { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(idb(userData), name), content);
}
const root = (userData) => path.join(userData, "backups", "profile-snapshots");
const snaps = (userData) => (fs.existsSync(root(userData)) ? fs.readdirSync(root(userData)).sort() : []);
let tick = 0;
const clock = () => new Date(Date.UTC(2026, 10, 1, 10, 0, tick++));

test("nothing to copy before the first database exists", async () => {
  const u = tmp();
  try {
    const r = await snapshotProfile({ userData: u });
    assert.equal(r.copied, false);
    assert.deepEqual(snaps(u), []);
  } finally { fs.rmSync(u, { recursive: true, force: true }); }
});

test("the database folder is copied completely, and a start without changes copies nothing", async () => {
  const u = tmp();
  try {
    makeProfile(u, { "000005.ldb": "x".repeat(500), "000006.log": "y".repeat(80), "MANIFEST-000001": "m", LOCK: "", LOG: "first" });
    const a = await snapshotProfile({ userData: u, now: clock });
    assert.equal(a.copied, true);
    const [name] = snaps(u);
    assert.match(name, /^IndexedDB-/);
    const copy = path.join(root(u), name, "IndexedDB", "app_invoisy_0.indexeddb.leveldb");
    assert.equal(fs.readFileSync(path.join(copy, "000005.ldb"), "utf8"), "x".repeat(500));
    assert.equal(fs.readFileSync(path.join(copy, "000006.log"), "utf8"), "y".repeat(80));
    // Chromium rewrote LOG / MANIFEST at the next start: still "unchanged"
    fs.writeFileSync(path.join(idb(u), "LOG"), "second start, longer log text");
    fs.writeFileSync(path.join(idb(u), "MANIFEST-000007"), "new manifest");
    const b = await snapshotProfile({ userData: u, now: clock });
    assert.equal(b.copied, false);
    assert.equal(b.reason, "unchanged");
    assert.equal(snaps(u).length, 1);
  } finally { fs.rmSync(u, { recursive: true, force: true }); }
});

test("only the newest three copies are kept, and a copy that fails never stops the start-up or removes an older copy", async () => {
  const u = tmp();
  try {
    for (let i = 1; i <= 5; i++) {
      makeProfile(u, { [`00000${i}.ldb`]: "d".repeat(i * 100) });
      assert.equal((await snapshotProfile({ userData: u, now: clock })).copied, true);
    }
    const kept = snaps(u);
    assert.equal(kept.length, 3);
    // a new change, but the copy fails half way: the old copies stay, nothing throws
    makeProfile(u, { "000009.ldb": "z".repeat(900) });
    const failing = { ...fs.promises, cp: async () => { throw new Error("the disk is full"); } };
    const r = await snapshotProfile({ userData: u, now: clock, fs: failing });
    assert.equal(r.copied, false);
    assert.equal(r.reason, "error");
    assert.deepEqual(snaps(u), kept, "the copies that exist are untouched");
  } finally { fs.rmSync(u, { recursive: true, force: true }); }
});

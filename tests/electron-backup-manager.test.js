"use strict";

// electron/backup-manager.js: the files the desktop application keeps next to its database. It is plain Node, so it is
// tested here against a real temporary folder, with faults injected into the file system calls (a failing disk, an
// interrupted write, a corrupted read-back). The rule behind every test: a failed or invalid backup never touches the
// last valid backup, and nothing is deleted except old daily / weekly copies after a successful write.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { BackupManager, inspectBackupText, localDay, weekKey, DAILY_KEEP, WEEKLY_KEEP } = require("../electron/backup-manager");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "invoisy-bm-"));
const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true });

// A minimal file in the shape Validation.prepareBackupFile writes.
function backupText({ revision = 1, exportedAt = "2026-11-01T10:00:00.000Z", products = 1, invoices = 0, marker = "" } = {}) {
  return JSON.stringify({
    application: "Invoisy", formatVersion: 2, exportedAt, revision,
    counts: { products, invoices },
    data: { products: Array.from({ length: products }, (_, i) => ({ id: "p" + i, name: "Tile " + marker })), invoices: Array.from({ length: invoices }, (_, i) => ({ id: "i" + i })), settings: {}, invoiceCounter: invoices },
  }, null, 2);
}

// The real fs.promises with optional faults: failOn = { op, when(args) , error }.
function faultyFs(faults) {
  const real = fs.promises;
  const wrap = {};
  for (const op of ["open", "readFile", "rename", "copyFile", "mkdir", "readdir", "stat", "unlink"]) {
    wrap[op] = async (...args) => {
      for (const f of faults) {
        if (f.op === op && (!f.when || f.when(...args)) && (f.times === undefined || f.times-- > 0)) {
          if (f.after) { const out = await real[op](...args); return f.after(out, args); }
          throw Object.assign(new Error(f.message || "simulated " + op + " failure"), { code: f.code || "EIO" });
        }
      }
      return real[op](...args);
    };
  }
  return wrap;
}

const make = (dir, opts) => new BackupManager({ dir: path.join(dir, "backups"), ...(opts || {}) });
const read = (file) => fs.readFileSync(file, "utf8");
const tempFiles = (m) => fs.readdirSync(m.dirs.tmp);

test("the first backup is written, flushed and verified, and no temporary file is left", async () => {
  const dir = tmp();
  try {
    const m = make(dir);
    const text = backupText({ revision: 3 });
    const r = await m.writeCurrent(text);
    assert.equal(r.revision, 3);
    assert.equal(read(m.currentPath), text);
    assert.deepEqual(tempFiles(m), []);
    assert.equal(fs.existsSync(m.previousPath), false, "nothing to keep as 'previous' yet");
    assert.equal(await m.readCurrent(), text);
  } finally { cleanup(dir); }
});

test("a second backup becomes current and the first one is kept as the previous backup", async () => {
  const dir = tmp();
  try {
    const m = make(dir);
    const a = backupText({ revision: 1, marker: "A" });
    const b = backupText({ revision: 2, marker: "B" });
    await m.writeCurrent(a);
    await m.writeCurrent(b);
    assert.equal(read(m.currentPath), b);
    assert.equal(read(m.previousPath), a);
  } finally { cleanup(dir); }
});

test("writing the same content again changes nothing", async () => {
  const dir = tmp();
  try {
    const m = make(dir);
    const a = backupText({ revision: 1, marker: "A" });
    await m.writeCurrent(a);
    const r = await m.writeCurrent(a);
    assert.equal(r.unchanged, true);
    assert.equal(fs.existsSync(m.previousPath), false);
  } finally { cleanup(dir); }
});

/* ---------- invalid and corrupted backups ---------- */

test("an invalid, empty, foreign or truncated backup is refused and the last valid backup stays exactly as it was", async () => {
  const dir = tmp();
  try {
    const m = make(dir);
    const good = backupText({ revision: 5, marker: "good" });
    await m.writeCurrent(good);
    const before = fs.statSync(m.currentPath);
    const cases = [
      "", "   ", "not json at all", good.slice(0, good.length - 40),
      JSON.stringify({ application: "Something else", formatVersion: 2, data: { products: [], invoices: [] } }),
      JSON.stringify({ application: "Invoisy", formatVersion: 2, data: { products: [] } }),
      JSON.stringify({ application: "Invoisy", data: { products: [], invoices: [] } }),
      JSON.stringify([1, 2, 3]), "null",
    ];
    for (const bad of cases) {
      await assert.rejects(() => m.writeCurrent(bad), (e) => e.code === "INVALID");
      assert.equal(read(m.currentPath), good);
      assert.equal(fs.existsSync(m.previousPath), false, "an invalid backup never rotates anything");
    }
    assert.equal(fs.statSync(m.currentPath).mtimeMs, before.mtimeMs);
    assert.deepEqual(tempFiles(m), []);
    assert.equal(m.lastError.code, "INVALID");
  } finally { cleanup(dir); }
});

test("a file that does not read back the same is refused before anything is replaced", async () => {
  const dir = tmp();
  try {
    const good = backupText({ revision: 1, marker: "good" });
    const m0 = make(dir);
    await m0.writeCurrent(good);
    await m0.writeCurrent(backupText({ revision: 2, marker: "second" }));
    const prev = read(m0.previousPath);
    const cur = read(m0.currentPath);
    // The read-back of the temporary file returns damaged content (a bad sector, a full disk that lied).
    const m = make(dir, { fs: faultyFs([{ op: "readFile", when: (f) => path.basename(String(f)).startsWith("current-"), after: (buf) => Buffer.concat([buf, Buffer.from(" ")]) }]) });
    await assert.rejects(() => m.writeCurrent(backupText({ revision: 3, marker: "third" })), (e) => e.code === "VERIFY");
    assert.equal(read(m0.currentPath), cur);
    assert.equal(read(m0.previousPath), prev);
    assert.deepEqual(tempFiles(m0), [], "the damaged temporary file is removed");
  } finally { cleanup(dir); }
});

/* ---------- interrupted and unavailable ---------- */

test("an interrupted write (the swap fails) leaves the current and the previous backup untouched", async () => {
  const dir = tmp();
  try {
    const m0 = make(dir);
    await m0.writeCurrent(backupText({ revision: 1, marker: "one" }));
    await m0.writeCurrent(backupText({ revision: 2, marker: "two" }));
    const cur = read(m0.currentPath);
    const prev = read(m0.previousPath);
    const m = make(dir, { fs: faultyFs([{ op: "rename", when: (_from, to) => String(to).endsWith("invoisy-data.json"), code: "EIO" }]), renameRetryMs: 0 });
    await assert.rejects(() => m.writeCurrent(backupText({ revision: 3, marker: "three" })), /simulated rename/);
    assert.equal(read(m0.currentPath), cur);
    assert.equal(fs.existsSync(m0.currentPath), true);
    assert.ok([prev, cur].includes(read(m0.previousPath)), "previous is a complete, valid earlier state, never half written");
    assert.equal(inspectBackupText(read(m0.previousPath)).ok, true);
    assert.deepEqual(tempFiles(m0), []);
    assert.equal(m.lastError.code, "WRITE");
  } finally { cleanup(dir); }
});

test("a crash in the middle of a write leaves only a temporary file, removed at the next start, and the backup is intact", async () => {
  const dir = tmp();
  try {
    const m = make(dir);
    await m.writeCurrent(backupText({ revision: 1, marker: "kept" }));
    const cur = read(m.currentPath);
    fs.writeFileSync(path.join(m.dirs.tmp, "current-999-1-abcd.tmp"), '{"application":"Invoisy","half'); // what a killed process leaves behind
    assert.equal(read(m.currentPath), cur);
    const fresh = make(dir);
    await fresh.cleanTemp();
    assert.deepEqual(tempFiles(fresh), []);
    assert.equal(read(fresh.currentPath), cur);
  } finally { cleanup(dir); }
});

test("an unavailable backup location fails with a clear error, retries work once it is back, and nothing else is affected", async () => {
  const dir = tmp();
  try {
    const m = make(dir);
    await m.writeCurrent(backupText({ revision: 1, marker: "before" }));
    const cur = read(m.currentPath);
    // The disk / folder goes away: every file call under the backup folder fails.
    const gone = make(dir, { fs: faultyFs([{ op: "mkdir", code: "ENOENT", message: "the drive is not available" }]) });
    await assert.rejects(() => gone.writeCurrent(backupText({ revision: 2 })), /not available/);
    assert.equal(gone.lastError.code, "WRITE");
    assert.equal(read(m.currentPath), cur);
    // Back again: the next write goes through.
    const r = await m.writeCurrent(backupText({ revision: 2, marker: "after" }));
    assert.equal(r.revision, 2);
    assert.equal(m.lastError, null);
  } finally { cleanup(dir); }
});

test("when the backup folder cannot be created at all (a file is in the way) the error is reported and no data is lost", async () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, "backups"), "I am a file, not a folder");
    const m = make(dir);
    await assert.rejects(() => m.writeCurrent(backupText()), (e) => e.name === "BackupError" && e.code === "WRITE");
    assert.equal(read(path.join(dir, "backups")), "I am a file, not a folder");
  } finally { cleanup(dir); }
});

test("the swap is retried when Windows briefly holds the file (EPERM / EBUSY)", async () => {
  const dir = tmp();
  try {
    const m = make(dir, { fs: faultyFs([{ op: "rename", when: (_f, to) => String(to).endsWith("invoisy-data.json"), code: "EPERM", times: 2 }]), renameRetryMs: 1 });
    await m.writeCurrent(backupText({ revision: 1, marker: "x" }));
    assert.match(read(m.currentPath), /"revision": 1/);
  } finally { cleanup(dir); }
});

/* ---------- queue ---------- */

test("writes are serialized: many at once finish in order and the last one wins, with no overlap", async () => {
  const dir = tmp();
  try {
    let active = 0;
    let overlapped = false;
    const real = fs.promises;
    const spy = { ...faultyFs([]), open: async (...a) => { active++; if (active > 1) overlapped = true; await new Promise((r) => setTimeout(r, 5)); try { return await real.open(...a); } finally { active--; } } };
    const m = make(dir, { fs: spy });
    const writes = [];
    for (let i = 1; i <= 12; i++) writes.push(m.writeCurrent(backupText({ revision: i, marker: "n" + i })));
    await Promise.all(writes);
    assert.equal(overlapped, false);
    assert.match(read(m.currentPath), /"revision": 12/);
    assert.match(read(m.previousPath), /"revision": 11/);
  } finally { cleanup(dir); }
});

/* ---------- rotation ---------- */

test("daily and weekly snapshots keep the last state of each earlier day / week, and old ones are pruned after a good write", async () => {
  const dir = tmp();
  try {
    let now = new Date(2026, 9, 1, 9, 0, 0);   // local time, like the application
    const m = make(dir, { now: () => now });
    // 20 consecutive days with two backups each (the first on the day, the last in the evening).
    for (let d = 0; d < 20; d++) {
      for (const hour of [9, 18]) {
        now = new Date(2026, 9, 1 + d, hour, 0, 0);
        await m.writeCurrent(backupText({ revision: d * 2 + (hour === 9 ? 1 : 2), exportedAt: now.toISOString(), marker: `d${d}h${hour}` }));
      }
    }
    const daily = fs.readdirSync(m.dirs.daily).sort();
    const weekly = fs.readdirSync(m.dirs.weekly).sort();
    assert.equal(daily.length, DAILY_KEEP);
    assert.ok(weekly.length <= WEEKLY_KEEP && weekly.length >= 2, `weekly kept: ${weekly.join(", ")}`);
    // The newest daily file is the state at the END of the previous day (day 18, evening), not a mid-day state.
    const newestDaily = read(path.join(m.dirs.daily, daily[daily.length - 1]));
    assert.match(newestDaily, /d18h18/);
    assert.equal(daily[daily.length - 1], `invoisy-daily-${localDay(new Date(2026, 9, 19))}.json`);
    assert.equal(daily[0], `invoisy-daily-${localDay(new Date(2026, 9, 13))}.json`, "only the newest seven days are kept");
    for (const name of weekly) assert.match(name, /^invoisy-weekly-\d{4}-W\d{2}\.json$/);
    assert.equal(weekKey(new Date(2026, 11, 31)), "2026-W53");
    assert.equal(weekKey(new Date(2027, 0, 3)), "2026-W53");
    assert.equal(weekKey(new Date(2027, 0, 4)), "2027-W01");
  } finally { cleanup(dir); }
});

test("an older revision replacing a newer file archives the newer one instead of losing it", async () => {
  const dir = tmp();
  try {
    const m = make(dir);
    const newer = backupText({ revision: 150, marker: "newer" });
    await m.writeCurrent(newer);
    await m.writeCurrent(backupText({ revision: 4, marker: "older" }));
    const archived = fs.readdirSync(m.dirs.archive);
    assert.equal(archived.length, 1);
    assert.match(archived[0], /^invoisy-newer-r150-/);
    assert.equal(read(path.join(m.dirs.archive, archived[0])), newer);
    assert.match(read(m.currentPath), /older/);
  } finally { cleanup(dir); }
});

test("a damaged current file is archived (not destroyed) and the previous valid backup is not overwritten by it", async () => {
  const dir = tmp();
  try {
    const m = make(dir);
    await m.writeCurrent(backupText({ revision: 1, marker: "one" }));
    await m.writeCurrent(backupText({ revision: 2, marker: "two" }));
    const prev = read(m.previousPath);
    fs.writeFileSync(m.currentPath, '{"application":"Invoisy","formatVersion":2,"data":{"products":[');   // damaged by something outside Invoisy
    await m.writeCurrent(backupText({ revision: 3, marker: "three" }));
    assert.equal(read(m.previousPath), prev, "the damaged file did not become the previous backup");
    const archived = fs.readdirSync(m.dirs.archive);
    assert.equal(archived.length, 1);
    assert.match(archived[0], /^invoisy-damaged-/);
    assert.match(read(m.currentPath), /three/);
  } finally { cleanup(dir); }
});

/* ---------- reading what is there ---------- */

test("latestValid returns the newest valid backup that holds data and skips damaged and empty ones", async () => {
  const dir = tmp();
  try {
    const m = make(dir);
    assert.equal(await m.latestValid(), null);
    await m.writeCurrent(backupText({ revision: 1, exportedAt: "2026-10-01T10:00:00.000Z", marker: "old", products: 2 }));
    await m.writeCurrent(backupText({ revision: 2, exportedAt: "2026-10-02T10:00:00.000Z", marker: "new", products: 3 }));
    let best = await m.latestValid();
    assert.equal(best.kind, "current");
    assert.equal(best.revision, 2);
    // current is damaged: the previous one is offered
    fs.writeFileSync(m.currentPath, "{broken");
    best = await m.latestValid();
    assert.equal(best.kind, "previous");
    assert.equal(best.revision, 1);
    // current is an empty shop: not offered, previous still is
    fs.writeFileSync(m.currentPath, backupText({ revision: 9, products: 0, invoices: 0, exportedAt: "2026-10-05T10:00:00.000Z" }));
    best = await m.latestValid();
    assert.equal(best.kind, "previous");
    const status = await m.status();
    assert.equal(status.files.find((f) => f.kind === "current").valid, true);
    assert.equal(status.files.find((f) => f.kind === "current").meaningful, false);
  } finally { cleanup(dir); }
});

test("safety copies are written into safety/, never overwrite each other and are never pruned", async () => {
  const dir = tmp();
  try {
    let tick = 0;
    const m = make(dir, { now: () => new Date(Date.UTC(2026, 10, 1, 10, 0, tick++)) });
    const a = await m.saveSafety(backupText({ revision: 7, marker: "a" }), "invoisy-before-restore-2026-11-01.json");
    const b = await m.saveSafety(backupText({ revision: 8, marker: "b" }), "../../evil/../invoisy-before-restore-2026-11-01.json");
    assert.notEqual(a.name, b.name);
    const files = fs.readdirSync(m.dirs.safety);
    assert.equal(files.length, 2);
    for (const f of files) assert.match(f, /^invoisy-before-restore-2026-11-01-.*\.json$/);
    await assert.rejects(() => m.saveSafety("nope", "x.json"), (e) => e.code === "INVALID");
    assert.equal(fs.readdirSync(m.dirs.safety).length, 2);
  } finally { cleanup(dir); }
});

test("saveTo (Export Backup to a place the person chose) writes atomically, verifies, and refuses invalid JSON", async () => {
  const dir = tmp();
  try {
    const m = make(dir);
    const target = path.join(dir, "export.json");
    fs.writeFileSync(target, "old content the person is replacing");
    await m.saveTo(target, backupText({ revision: 1 }));
    assert.match(read(target), /"application": "Invoisy"/);
    await assert.rejects(() => m.saveTo(target, "{nope"), (e) => e.code === "INVALID");
    assert.match(read(target), /"application": "Invoisy"/, "a refused save leaves the file alone");
    await m.saveTo(path.join(dir, "suppliers.csv"), "a;b\n1;2\n");
    assert.equal(read(path.join(dir, "suppliers.csv")), "a;b\n1;2\n");
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
  } finally { cleanup(dir); }
});

test("inspectBackupText reads revision, date and counts, and recognises a shop with data", () => {
  const info = inspectBackupText(backupText({ revision: 12, exportedAt: "2026-11-02T08:00:00.000Z", products: 2, invoices: 1 }));
  assert.equal(info.ok, true);
  assert.equal(info.revision, 12);
  assert.equal(info.exportedAt, "2026-11-02T08:00:00.000Z");
  assert.equal(info.meaningful, true);
  const noRevision = JSON.parse(backupText());
  delete noRevision.revision;
  assert.equal(inspectBackupText(JSON.stringify(noRevision)).revision, null, "an older backup without a revision is still valid");
});

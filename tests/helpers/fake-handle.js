"use strict";

// A stand-in for a browser FileSystemFileHandle (shared by the tests that check the automatic backup file).

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

module.exports = { FakeHandle };

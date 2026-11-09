"use strict";

// Typing on the Sell page: the invoice preview (the costly part of a keystroke) is drawn after the browser has shown the typed
// character, once for any number of keys that came in the meantime, and anything that draws it itself settles a waiting drawing.

const assert = require("node:assert/strict");
const test = require("node:test");
const { loadApp } = require("./helpers/app");

async function boot(options) {
  const app = loadApp(options);
  await app.start();
  return app;
}

// A browser that has requestAnimationFrame: frames are run by hand.
async function bootWithFrames() {
  const frames = [];
  const ctx = await boot({
    globals: {
      requestAnimationFrame: (fn) => frames.push(fn),
      cancelAnimationFrame: (id) => { frames[id - 1] = null; },
    },
  });
  ctx.frame = () => { const waiting = frames.splice(0); waiting.forEach((fn) => fn && fn()); };
  // The preview marks its status line each time it is drawn.
  const status = ctx.field("previewStatus");
  let draws = 0;
  Object.defineProperty(status, "textContent", { get: () => `drawn:${draws}`, set: () => { draws++; }, configurable: true });
  ctx.draws = () => draws;
  return ctx;
}

test("the preview is not drawn inside the keystroke; it is drawn after the next frame, once for several keys", async () => {
  const ctx = await bootWithFrames();
  const base = ctx.draws();
  ctx.api.refreshLive();
  ctx.api.refreshLive();
  ctx.api.refreshLive();
  assert.equal(ctx.draws(), base, "nothing is drawn while the keys are being handled");
  ctx.frame();                  // the browser shows the typed characters; the drawing is queued behind them
  ctx.flushTimers();
  assert.equal(ctx.draws(), base + 1, "one drawing for the three keys");
  ctx.frame(); ctx.flushTimers();
  assert.equal(ctx.draws(), base + 1, "and nothing more is waiting");
});

test("drawing the preview directly settles a drawing that was waiting (no second, needless drawing)", async () => {
  const ctx = await bootWithFrames();
  ctx.api.refreshLive();
  const before = ctx.draws();
  ctx.api.renderInvoice();
  assert.equal(ctx.draws(), before + 1);
  ctx.frame(); ctx.flushTimers();
  assert.equal(ctx.draws(), before + 1, "the waiting drawing was cancelled");
});

test("without requestAnimationFrame the preview is drawn at once, as it always was", async () => {
  const ctx = await boot();
  const status = ctx.field("previewStatus");
  let draws = 0;
  Object.defineProperty(status, "textContent", { get: () => "", set: () => { draws++; }, configurable: true });
  ctx.api.refreshLive();
  assert.equal(draws, 1);
});

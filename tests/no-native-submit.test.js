"use strict";

// The safety net in index.html: a form must never be submitted by the browser itself (that navigates and reloads the page,
// throwing away what was typed), even if a script error or a missing script leaves a form without its handler.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

// Runs the inline script against a stand-in document and returns the listener it registered.
function loadGuard() {
  const match = html.match(/<script id="noNativeSubmit">([^]*?)<\/script>/);
  assert.ok(match, "index.html has the inline safety-net script");
  const registered = [];
  vm.runInNewContext(match[1], { document: { addEventListener: (type, fn, capture) => registered.push({ type, fn, capture }) } });
  return registered;
}

const submitEvent = (method) => {
  const event = { target: { getAttribute: (name) => (name === "method" ? method : null) }, prevented: false };
  event.preventDefault = () => { event.prevented = true; };
  return event;
};

test("a submit that has no handler of its own is cancelled, so the page does not navigate or reload", () => {
  const [listener, ...rest] = loadGuard();
  assert.equal(rest.length, 0, "one listener");
  assert.equal(listener.type, "submit");
  assert.equal(listener.capture, true, "registered in the capture phase, so it runs before anything else can fail");
  for (const method of [null, "get", "post"]) {
    const event = submitEvent(method);
    listener.fn(event);
    assert.equal(event.prevented, true, `method=${method}`);
  }
});

test("a dialog form (method=dialog) is left alone so it can still close its dialog", () => {
  const [listener] = loadGuard();
  const event = submitEvent("dialog");
  listener.fn(event);
  assert.equal(event.prevented, false);
});

test("the safety net comes before every other script in index.html", () => {
  const guard = html.indexOf('<script id="noNativeSubmit">');
  const first = html.search(/<script src=/);
  assert.ok(guard > 0 && guard < first, "before the first external script");
  assert.ok(html.indexOf("</head>") > guard, "in the head");
});

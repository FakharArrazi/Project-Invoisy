"use strict";

// electron/app-protocol.js: the app://invoisy origin and what it serves.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { SCHEME, HOST, ORIGIN, isAppUrl, resolveRequest, buildCsp, createHandler } = require("../electron/app-protocol");

const ROOT = path.join(__dirname, "..");

test("the application origin is app://invoisy and never changes (it decides which IndexedDB database the page can open)", () => {
  assert.equal(SCHEME, "app");
  assert.equal(HOST, "invoisy");
  assert.equal(ORIGIN, "app://invoisy");
  assert.equal(isAppUrl("app://invoisy/index.html"), true);
  assert.equal(isAppUrl("app://invoisy"), true);
  assert.equal(isAppUrl("app://other/index.html"), false);
  assert.equal(isAppUrl("https://invoisy/index.html"), false);
  assert.equal(isAppUrl("file:///index.html"), false);
  assert.equal(isAppUrl("not a url"), false);
  // main.js loads exactly this address in development and in the packaged app (no second origin anywhere).
  const main = fs.readFileSync(path.join(ROOT, "electron", "main.js"), "utf8");
  assert.equal((main.match(/loadURL\(/g) || []).length, 1);
  assert.match(main, /loadURL\(`\$\{ORIGIN\}\/index\.html`\)/);
  assert.doesNotMatch(main, /file:\/\//);
  assert.doesNotMatch(main, /localhost|127\.0\.0\.1/);
});

test("only the application's own files can be reached; everything else is refused", () => {
  const ok = (url) => resolveRequest(ROOT, url);
  assert.equal(ok("app://invoisy/").relative, "index.html");
  assert.equal(ok("app://invoisy/index.html").relative, "index.html");
  assert.equal(ok("app://invoisy/java%20script/script.js").relative, "java script/script.js");
  assert.equal(ok("app://invoisy/java%20script/lang/ar.js").relative, "java script/lang/ar.js");
  assert.equal(ok("app://invoisy/css/style.css").relative, "css/style.css");
  for (const url of [
    "app://invoisy/package.json", "app://invoisy/electron/main.js", "app://invoisy/tests/helpers.js", "app://invoisy/node_modules/electron/package.json",
    "app://invoisy/.git/config", "app://invoisy/../package.json", "app://invoisy/css/../../package.json", "app://invoisy/css/..%2f..%2fpackage.json",
    "app://invoisy/%2e%2e/package.json", "app://invoisy/css%5c..%5c..%5cpackage.json", "app://invoisy/java%20script/%00.js",
    "app://otherhost/index.html", "https://invoisy/index.html",
  ]) {
    const r = ok(url);
    assert.equal(r.file, undefined, `${url} must not resolve to a file`);
    assert.ok(r.status >= 400, url);
  }
});

test("the Content-Security-Policy allows only the application's own scripts and the inline scripts index.html itself contains", () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const csp = buildCsp(html);
  const inline = [...html.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  assert.ok(inline.length >= 1, "index.html has an inline script (the no-native-submit safety net)");
  for (const body of inline) assert.ok(csp.includes(`'sha256-${crypto.createHash("sha256").update(body, "utf8").digest("base64")}'`));
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self' 'sha256-/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
  assert.doesNotMatch(csp, /unsafe-eval/);
  assert.match(csp, /connect-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-src 'none'/);
  assert.doesNotMatch(csp, /https?:/, "no remote origin is allowed anywhere");
  // Everything the page loads is local: no remote scripts, styles, fonts or images in index.html.
  assert.doesNotMatch(html, /(?:src|href)\s*=\s*["']https?:\/\//i);
});

test("the handler serves pages with the right type and policy, and refuses other methods and paths", async () => {
  const handle = createHandler({ root: ROOT });
  const index = await handle(new Request("app://invoisy/index.html"));
  assert.equal(index.status, 200);
  assert.match(index.headers.get("content-type"), /^text\/html/);
  assert.match(index.headers.get("content-security-policy"), /script-src 'self'/);
  assert.equal(index.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await index.text(), fs.readFileSync(path.join(ROOT, "index.html"), "utf8"), "the existing page is served unchanged");
  const script = await handle(new Request("app://invoisy/java%20script/database.js"));
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type"), /javascript/);
  assert.equal(await script.text(), fs.readFileSync(path.join(ROOT, "java script", "database.js"), "utf8"));
  assert.equal((await handle(new Request("app://invoisy/css/style.css"))).headers.get("content-type").startsWith("text/css"), true);
  assert.equal((await handle(new Request("app://invoisy/electron/main.js"))).status, 404);
  assert.equal((await handle(new Request("app://invoisy/css/missing.css"))).status, 404);
  assert.equal((await handle(new Request("app://invoisy/index.html", { method: "POST", body: "x" }))).status, 405);
});

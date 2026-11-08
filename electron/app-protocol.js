"use strict";

/* ==========================================================================
   The app:// protocol (main process).

   Invoisy's pages are served as  app://invoisy/...  The web origin of a page decides which IndexedDB database it can
   open, so this origin MUST stay exactly "app://invoisy" in every version, in development and in the packaged app.
   Changing the scheme or the host would make the existing database unreachable (the data would still be on disk, but
   under another origin).

   Only the files the application needs are served: index.html and what is inside css/, "java script/" and assets/.
   Nothing else in the project (electron/, tests/, node_modules, package.json, .git) can be reached, and a path that
   leaves the application folder is refused.
   ========================================================================== */

const nodeFs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const SCHEME = "app";
const HOST = "invoisy";
const ORIGIN = `${SCHEME}://${HOST}`;
const ALLOWED_DIRS = ["css", "java script", "assets"];
const ALLOWED_ROOT_FILES = ["index.html"];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

// True for a URL of the application's own pages. (URL.origin is "null" for a custom scheme, so scheme and host are compared.)
function isAppUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === `${SCHEME}:` && u.host === HOST;
  } catch {
    return false;
  }
}

// Resolves a request URL to a file inside `root`. Returns { file } or { status }.
function resolveRequest(root, requestUrl) {
  let url;
  try { url = new URL(requestUrl); } catch { return { status: 400 }; }
  if (url.protocol !== `${SCHEME}:` || url.host !== HOST) return { status: 404 };
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return { status: 400 }; }
  if (pathname.includes("\0") || pathname.includes("\\")) return { status: 400 };
  if (pathname === "/" || pathname === "") pathname = "/index.html";
  const relative = path.posix.normalize(pathname).replace(/^\/+/, "");
  if (!relative || relative.startsWith("..") || path.posix.isAbsolute(relative)) return { status: 403 };
  const parts = relative.split("/");
  const allowed = (parts.length === 1 && ALLOWED_ROOT_FILES.includes(parts[0])) || (parts.length > 1 && ALLOWED_DIRS.includes(parts[0]));
  if (!allowed) return { status: 404 };
  const file = path.join(root, ...parts);
  const rootWithSep = path.resolve(root) + path.sep;
  if (!path.resolve(file).startsWith(rootWithSep)) return { status: 403 };
  return { file, relative };
}

// The Content-Security-Policy of every page. Scripts: only the application's own files, plus the inline scripts that
// are in index.html itself (allowed by their hash, so nothing injected later can run). No network, no frames, no plugins.
function buildCsp(indexHtml) {
  const hashes = [];
  const pattern = /<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = pattern.exec(indexHtml || "")) !== null) {
    hashes.push(`'sha256-${crypto.createHash("sha256").update(match[1], "utf8").digest("base64")}'`);
  }
  return [
    "default-src 'none'",
    `script-src 'self' ${hashes.join(" ")}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

// Returns an async (Request) => Response for protocol.handle().
function createHandler(options) {
  const root = options.root;
  const fs = options.fs || nodeFs.promises;
  let csp = null;
  const cspFor = async () => {
    if (csp) return csp;
    let html = "";
    try { html = await fs.readFile(path.join(root, "index.html"), "utf8"); } catch { /* the page itself will fail to load */ }
    csp = buildCsp(html);
    return csp;
  };
  return async function handle(request) {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
    const resolved = resolveRequest(root, request.url);
    if (!resolved.file) return new Response("Not found", { status: resolved.status || 404 });
    try {
      const body = await fs.readFile(resolved.file);
      const headers = {
        "Content-Type": MIME[path.extname(resolved.file).toLowerCase()] || "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      };
      if (path.extname(resolved.file).toLowerCase() === ".html") headers["Content-Security-Policy"] = await cspFor();
      return new Response(request.method === "HEAD" ? null : body, { status: 200, headers });
    } catch (e) {
      return new Response("Not found", { status: e && e.code === "ENOENT" ? 404 : 500 });
    }
  };
}

module.exports = { SCHEME, HOST, ORIGIN, isAppUrl, resolveRequest, buildCsp, createHandler, ALLOWED_DIRS };

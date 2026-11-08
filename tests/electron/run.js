"use strict";

// Runs the Electron tests (tests/electron/*.test.js). They start the real application, so they need a display: on Linux
// without one (a server, a container, CI) the run is wrapped in xvfb-run. On Windows and macOS nothing is needed.
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const args = ["--test", "--test-concurrency=1", "--test-timeout=180000", path.join(__dirname, "*.test.js")];
const needsXvfb = process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
const [cmd, cmdArgs] = needsXvfb ? ["xvfb-run", ["-a", process.execPath, ...args]] : [process.execPath, args];
const r = spawnSync(cmd, cmdArgs, { stdio: "inherit", shell: process.platform === "win32" });
if (r.error && r.error.code === "ENOENT") {
  console.error("This test needs a display. Install xvfb (apt install xvfb) or run it on a desktop.");
  process.exit(1);
}
process.exit(r.status === null ? 1 : r.status);

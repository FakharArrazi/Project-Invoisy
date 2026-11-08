# Invoisy desktop (Windows, Electron)

Invoisy runs in two ways from the same files: in a browser (open `index.html`), and as a Windows desktop application
(Electron). The desktop application loads the existing pages unchanged and keeps using the **same IndexedDB database**
(name `invoisy`, same version, same migrations). Nothing about the database, the business logic or the interface was
replaced.

## Commands

```
npm install          install dependencies (Electron, electron-builder, test tools)
npm start            run the desktop application (development; separate data folder, see below)
npm run dev          same, with the developer tools opened
npm run build        build the Windows installer:  release\Invoisy Setup 1.0.0.exe
npm run build:dir    only the unpacked application (release\win-unpacked), no installer
npm test             existing + new unit tests (no window needed)
npm run test:electron   tests that start the real application (needs a display; uses xvfb-run on Linux without one)
```

If `npm run build` stops with a *symbolic link* error while extracting a tool, turn on Windows **Developer Mode**
(Settings > For developers) or run the terminal as administrator once.

## Where things are

| What | Where |
| --- | --- |
| Database (IndexedDB) | `%APPDATA%\Invoisy\IndexedDB\` (installed app) |
| Automatic backups | `%APPDATA%\Invoisy\backups\` |
| Log | `%APPDATA%\Invoisy\logs\invoisy.log` |
| Application files | the installation folder (replaced by updates; never holds data) |

`npm start` / `npm run dev` use `%APPDATA%\Invoisy-Dev\` so trying things out can never touch real business data.
Set `INVOISY_USER_DATA` to an absolute folder to use another location (the tests do).

The installer never removes `%APPDATA%\Invoisy`: not on update, not on uninstall. (electron-builder deletes it only when
the uninstaller is started with the explicit option `--delete-app-data`; `deleteAppDataOnUninstall` is `false`.)

## Architecture

```
electron/main.js            start-up, app:// origin, secure window, single instance, closing after the last backup
electron/preload.js         window.invoisyDesktop: a small frozen list of requests (no Node.js in the page)
electron/ipc-handlers.js    the requests: checks who asks, validates arguments, Windows dialogs, files
electron/backup-manager.js  automatic backup files: queue, temp file, read-back, atomic swap, rotation
electron/profile-snapshot.js copy of the raw database folder at start-up
electron/app-protocol.js    serves app://invoisy/ (only index.html, css/, "java script/") + Content-Security-Policy
java script/desktop-bridge.js  page side: gives autobackup.js a file handle backed by the folder above
```

* **Origin.** The pages are served from `app://invoisy/` in development and in the installed app. The origin decides
  which IndexedDB the page can open, so it must never change (a test guards it).
* **Security.** `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, no developer tools in the installed
  app, one frozen bridge object, every IPC call checked against the page's origin, no navigation away from the app
  (web links open in the default browser), Content-Security-Policy with no remote origin and no `eval`, one running copy
  at a time (two copies on one database could damage it), all permissions refused except the app's own storage.
* **Offline.** No server, account or network request is needed or possible.

## Backups

The existing `AutoBackup` logic is used as it is: after each committed transaction it takes a consistent snapshot,
checks it with the same code a restore uses, writes it, reads it back and compares. In the desktop application its
"file" is `backups\invoisy-data.json`, written by the main process:

1. the text is checked (it must be an Invoisy backup), written to `backups\.tmp\`, flushed to disk and read back;
2. only then are older copies rotated and the temporary file renamed over the current one (atomic);
3. a failure at any step leaves the last valid backup untouched and is shown in Settings and in the top bar; the backup
   stays pending and is retried.

Kept: `invoisy-data.json` (current), `invoisy-data.previous.json`, `daily\` (last 7 days that had changes),
`weekly\` (last 4 weeks that had changes). `safety\` (a copy made before every restore) and `archive\` (a file that was
replaced although it was newer or damaged) are never deleted automatically. When the window closes, a backup that is
still waiting is written first.

The backup format is the existing one (the same file as **Export Backup**), so any backup can be restored in the
browser version and the other way round.

**Export Backup** and **Import / Restore Backup** use the Windows Save / Open dialogs. A restore is checked completely
before anything changes, saves a safety copy of the current data first, and is one IndexedDB transaction: it is applied
entirely or not at all.

**Empty database + backups present.** If at start-up the database holds nothing but `backups\` holds a valid backup,
the application asks whether to restore it. It never restores by itself. If you answer no, the backup file is not
overwritten by the empty database: Settings shows "newer backup" and a **Replace the newer backup** button, which
keeps the old file in `archive\` first.

**Raw copy of the database.** At each start (before the database is opened) the folder `IndexedDB` is copied to
`backups\profile-snapshots\IndexedDB-<time>\` when its data files changed (newest three kept). To use one: close
Invoisy, move the current `IndexedDB` folder away, and copy the `IndexedDB` folder from the chosen snapshot into
`%APPDATA%\Invoisy\`.

## Moving data from the browser version

In the browser version: Settings > **Export Backup**. In the desktop application: Settings > **Import / Restore
Backup** and choose that file. Records, ids, invoice numbers, payments and stock are restored exactly as exported.
(Data stays in the browser too; nothing is removed from it.)

## Printing

**Print / PDF** opens the normal Windows print dialog (it includes *Microsoft Print to PDF*). The desktop application also
shows **Save as PDF**, which writes the invoice with the same print layout directly to a file you choose.

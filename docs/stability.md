# Staying still: reloads, dialogs and typed input

This describes why the page used to refresh or reset under your hands, what it does now, and what is left to do outside
the app.

## What was found

The page itself never reloads during normal work. The only `window.location.reload()` is a button in the storage banner,
and nothing calls it on its own. Every form is handled in JavaScript, a sale is saved in one database transaction before
its dialog opens, and a repeated click or Enter cannot record a second sale.

What interrupted the work came from three places:

1. **The automatic backup file.** About 0.4 s after every saved change the page rewrites `invoisy-data.json`. A tool that
   watches the folder and reloads the page when a file changes (for example the VS Code *Live Server* extension) reloads
   the page at that moment, which is when the Print / New Sale / Later dialog has just opened. If a sale was being typed,
   the reload also asked "Leave site?" or threw the sale away.
2. **Full redraws.** Some screens are redrawn as a whole when data changes (another window saving, a language change, a
   +/− on a stock row). The input that had the keyboard was replaced by a new one, so focus and the caret were lost, and
   half-typed business details in Settings were overwritten with the saved ones.
3. **Routine messages.** Every saved product, restock, payment, language change and so on announced itself.

## What the page does now

**The backup file waits while you are in the middle of something.** It is not written while the sale-completed dialog
(or the debt dialog) is open, while a sale, an invoice edit, a product form or the Settings form has input that is not
saved yet. Nothing is at risk meanwhile: every change is already in the database, the file is only a copy. The file is
written shortly after the moment is over (answering the dialog, finishing or clearing the sale, saving the form), and at
the next start at the latest. While it waits, Settings shows *Backup pending*. Pressing *Try again* or *Allow access*
still writes at once. The rule is `backupShouldWait()` in `script.js`.

**Focus survives a redraw.** `renderAll()` and the tables that are also drawn on their own (stock, invoices, the sale)
put the keyboard focus, and the caret in a text box, back on the replacement of the element that had it. Typed Settings are
kept (`settingsTouched`) until you save or restore a backup. Quantities typed into the delivery box are kept while they
still refer to the same invoice and the same quantity left to collect.

**A lost database connection is reopened in the same page.** The banner offers *Try again*, which reconnects without
touching what is on screen. *Reload* is offered in one situation only: another window moved the database to a newer
version than this page's code, so only a reload can help. It is never done automatically, and the browser still asks first
when there is an unsaved sale or form. Pressing *Try again* several times starts one connection, and opening the database
again no longer leaves a second change listener running.

**Routine operations are quiet.** No message for: saving, editing or deleting a product, restocking, adjusting stock,
completing a sale, printing, recording a payment or a collection, saving settings, changing the
language or the paper size, changing the logo, adding or removing an outstanding debt, loading demo products, and
cancelling a question you were just asked. The screen itself shows the result. Still shown: every error, backup export and
restore results, the short "INV-… deleted." after an invoice is deleted, migration notices, the area-to-boxes conversion, a price reset, "nothing changed", and the Purchases and
Suppliers confirmations (unchanged).

## What has to be fixed outside the app

If a tool reloads the page when files in the project folder change, one reload still happens after you answer the dialog,
because the backup file is written then. Either:

- keep the backup file outside the project folder (Settings → Automatic backup → choose a file in Documents, say), or
- tell the tool to ignore it. For Live Server, add `**/invoisy-data.json` to the `liveServer.settings.ignoreFiles` list in
  your VS Code settings (keep the entries that are already there; check the extension's documentation for your version), or
- open `index.html` directly or serve it with a server that does not reload (`python3 -m http.server`).

A quick way to check whether this is your cause: choose a backup file outside the project folder and use the app for a
while. If the refreshes stop, it was this.

## Testing

- `npm test` includes `tests/stability.test.js` (reconnect, quiet operations, typed Settings, listener leak) and the
  hold/resume tests at the end of `tests/autobackup.test.js`.
- `python3 tests/e2e/stability_check.py` runs the page in a real browser, including a simulated live-reload tool. It needs
  Playwright and Chromium. `window.print` is a stand-in there (a headless browser has no print dialog), so what is checked
  is that the saved invoice is handed to print once.
- The other scripts in `tests/e2e/` that used to wait for the "Sale completed" and "Payment added" messages now wait for the
  invoice or the cleared amount box instead.

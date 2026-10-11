# Invoisy

## Units, prices and stock

All unit conversion and price maths lives in `java script/calc.js` (loaded before `script.js`).
Nothing else converts units. The unit names and the messages it returns are not written in the code:
they come from `java script/lang/` (English and French), so `calc.js` is loaded after `i18n.js` and the
language files.

- A product has a **selling price** and the **unit that price is per** (piece, box, m², kg or meter).
  Selling in another unit works the price out from the tile size and the coverage per box, e.g.
  1,500 DA/m², 60*60 cm tile, 1.44 m² per box: piece = 540 DA, box = 2,160 DA.
- A product also has a **stock unit**: what its stock quantity is counted in. Selling boxes or
  pieces takes stock out converted to that unit (3 pieces from 20 boxes of 4 pieces leaves 19.25 boxes).
- kg and meter products can only be sold by kg / meter.
- **Current Sale unit price.** Each sale line shows its quantity, its selling unit (piece, box, m², kg or
  meter), an editable unit price with the unit it is for next to it (`DA/m²`, `DA/box`, `DA/piece`) and
  the line total. The price is always for ONE selected unit: it starts at the saved price of that unit (or
  the saved price converted with the tile size and coverage per box) and follows the unit when it changes.
  m² is a real selling unit: 10 m² at 1,000 DA/m² is 10,000 DA, and stock is taken out as the equivalent
  fraction of a box.
- **Special price for one sale.** Typing a price on a sale line changes that line only, for this sale only:
  the line total, subtotal, discount, tax, final total and the live invoice follow at once. The price in
  Stock, the customer and the settings are never touched, removing and re-adding the product restores the
  saved price, and the next sale (to the same customer too) starts from the saved prices again. Prices
  are kept to 2 decimals; blank, negative or non-numeric prices are refused. Changing the unit of a line
  with a typed price replaces it with the new unit's price (a price per m² is not a price per box), and a
  price changed in Stock reaches lines at the normal price but never a typed price. Prices never affect stock.
- An invoice line shows the product's own price and the unit it is priced per (1,500 / m²), the
  quantity as it was sold (2 Boxes) and, when that is a different unit, the same quantity in the
  price unit underneath (2.88 m²), then the line total. Selling by the box never turns the price
  into a per-box price on the invoice. A price typed by hand on the Sell page is the exception: the
  line then shows the price actually charged, per unit sold. The product's price is only ever shown when
  it really is what was charged (checked again from the line's own saved details).
- A saved invoice keeps the unit sold, the price charged, the unit that price is for (`unitPriceUnit`) and
  the details it was worked out from.
  It is never recalculated from the product's current data, and a sale never changes the price in Stock.

## Payments

- **Amount Paid left empty means nothing was paid**, exactly like 0. The invoice is saved as unpaid and
  the whole total stays outstanding. Only a typed amount is recorded as a payment.
- Later payments are added to the same invoice from Invoices (Add Payment) and are kept in its payment
  history. Status follows the payments: unpaid (nothing paid), partially paid, paid. Remaining = total - paid,
  and a payment can not be more than what is remaining.
- Products saved before these fields existed keep working: their price is used as typed and their
  stock goes down one-for-one until a price unit and stock unit are set in the Stock form.

## Stock form

Mandatory fields have a small * on their label: product name, selling price, price unit and stock unit
(and coverage per box while the price is per m²). Everything else may be left empty. Products saved
before the Manufacturer / Brand field was removed keep that value (it is still shown on the invoice
and found by search) but it is no longer asked for or editable.

## Tests

Needs Node 20 or newer. The app itself has no dependencies. The tests that save data use a disposable in-memory IndexedDB from the `fake-indexeddb` package (a development-only dependency), so run this once:

    npm install
    npm test

(`node --test` alone also runs, but the persistence tests then stop with a message asking for `npm install`.)

## Where your data lives

Everything (products, stock, invoices, payments, settings, the invoice counter) is saved in the browser's **IndexedDB** database on your computer. It is the only place Invoisy saves data and it is never sent anywhere.

Two things follow from that, and both are worth knowing:

- **The database belongs to one browser and to the exact way Invoisy is opened.** A different browser, a different browser profile, a private window, or the same page opened from a different folder or address will show an empty Invoisy. Always open it the same way. (Opened straight from disk as `file://`, Chromium keeps one database per file location. Only Chromium was tested; a browser that refuses IndexedDB for `file://` pages makes Settings say "Not available", and Invoisy then refuses to save instead of pretending. Serving the folder from a static web server, for example `python3 -m http.server`, also works - tested - and then the address is the key.)
- **Browsers can clear site data** (when the disk is low, or when you clear history). Settings shows whether the browser has agreed to protect the data and has a button to ask it to.

**Make backups.** The backup file is your only copy outside the browser.

## Backup and restore (Settings, Data storage)

- **Export Backup** downloads `invoisy-backup-YYYY-MM-DD.json` with all products, invoices (with customers and payment history), settings and the invoice counter. The file is checked before it is offered, and the "last backup" date is recorded only after the download was started. Keep the file somewhere other than this computer's browser, for example another drive.
- **Import / Restore Backup** reads a backup file, checks all of it, asks for confirmation, downloads a safety copy of what is there now (`invoisy-before-restore-YYYY-MM-DD.json`), and then replaces everything in one step. If anything goes wrong nothing is changed. Invoice numbers never go backwards after a restore.
- A **reminder** in the top bar appears when you have data and no backup for 7 days (the number of days can be changed in Settings). It never opens a dialog and never blocks a sale.

Backups from the previous version (`invoisy-data.json`) can also be restored.

## Automatic backup file (Settings, Automatic backup file)

Invoisy can keep one file, `invoisy-data.json`, up to date by itself: after every saved change (a product, stock, a sale, a payment, settings, the invoice counter) the whole database is written to it. You do not have to press Export Backup. The browser database stays the only place Invoisy reads from; the file is a copy.

- **Turning it on:** Settings, Automatic backup file, **Choose backup file**. You pick (or create) the file in the browser's own Save dialog. The browser remembers your choice; after a restart it may ask you to allow writing again (Settings then shows **Grant permission**).
- **A file that already has something in it is never replaced quietly.** It must be an Invoisy backup (or the previous version's data file). If Invoisy has no data of its own, nothing is written (restore the file first with Import / Restore Backup). If both have data and they differ, you are asked, and a copy of the file as it is now is downloaded first (`invoisy-before-autobackup-YYYY-MM-DD.json`).
- **The file is never loaded back automatically.** Restoring is only ever Import / Restore Backup, which asks first.
- **Settings shows** whether the file is connected, its name, the last successful backup, the latest database revision, the last backed-up revision, whether the backup is current or pending, and the last error. "Backup current" is shown only after the file was written *and read back* with the latest revision.
- **If writing fails** (file moved or deleted, disk full, drive unplugged, access withdrawn) the change you made is still saved in the browser database. The backup stays "pending", is retried three times with growing pauses, and is tried again after the next change, when you come back to the window, or when you press **Retry backup**. A warning also appears in the top bar.
- **Safe writing:** quick changes are folded into one write; one write at a time (across windows too); the browser writes a temporary copy and swaps it in only when it is complete, so a failed write leaves the previous file as it was. A file that holds a *newer* revision than the database is not overwritten.
- **Browsers:** needs the File System Access API (Chrome, Edge, Opera on a computer). Firefox and Safari do not have it: Settings says so, nothing is pretended, and Export Backup is the way to back up.
- The backup file has the same format as Export Backup, plus a `revision` (the database revision it holds). Older Invoisy versions ignore that field.

## Updating from the previous version

The previous version kept its data in a data file plus a copy in the browser's localStorage. On first start the new version copies that localStorage data into IndexedDB, checks the copy, and leaves the old data exactly where it was (nothing is deleted). Settings explains what happened. If you used a data file, load it with Import / Restore Backup if it has newer data than the browser copy. The old copy can be removed from Settings once you have exported a backup.

## For developers

```
index.html
css/style.css, css/pricing.css
java script/i18n.js, lang/    the language layer and the English / French texts
java script/calc.js           unit conversion and price maths
java script/validation.js     the shape and rules of the data; backup file format; reminder rule; old-data reader
java script/database.js       the IndexedDB layer (the only code that touches IndexedDB)
java script/autobackup.js     the automatic backup file (file handle, write queue, status)
java script/script.js         the screens
```

Scripts load in that order (see the end of `index.html`). Every message the persistence code shows or throws comes from `lang/en.js` and `lang/fr.js`.

- Schema version 2, database name `invoisy`. Stores: `products`, `invoices` (unique `invoiceNumber`), `settings`, `counters`, `meta`. Customers and payments are stored inside each invoice.
- A sale (invoice + stock deduction + invoice counter) is one transaction. Every write also checks the database revision it started from, so a second open window can not overwrite a change it has not seen.
- Every committed change to business data moves the revision on in one of two places (`commitInTx`, `writeDataset`); both call `markCommit`, and `withTx` emits a `commit` event only after the transaction has really committed. `autobackup.js` listens to that event, so a new feature that saves through `database.js` is covered without touching the backup code. The file handle and backup notes are kept in the `meta` store (no schema change).
- `tests/autobackup.test.js` covers the commit event and the backup file with a stand-in file handle. `tests/e2e/autobackup_check.py` is an optional real-browser check of it (real IndexedDB and a real `FileSystemFileHandle` from the browser's private file system; only the operating system's Save dialog is replaced).
- `tests/e2e/browser_check.py` is an optional real-browser check (Playwright + Chromium, opened over `file://`, disposable profile).

## Known limits

- Invoisy can not see where a downloaded backup is stored or whether it is kept.
- Two windows can be open at once; if both change data at the same time, the second save is refused with a message to repeat the action, with the latest data already loaded.
- Data entered in an old Invoisy window that is still open after updating is not picked up automatically; close old windows before updating.
- Automatic backup file, not verified in a real browser: the operating system's Save dialog itself, the browser asking again for permission after a restart, and use over `file://` (Chromium does not offer its private file system there, so the real-browser check runs over a local web server). These are covered only by the stand-in tests. Two browsers or profiles pointed at the same file will keep refusing to overwrite each other's newer data; use one.
- There is no button to switch the automatic backup off; choose a different file, or clear the site data.

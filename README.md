# Invoisy

## Units, prices and stock

All unit conversion and price maths lives in `java script/calc.js` (loaded before `script.js`).
Nothing else converts units. The unit names and the messages it returns are not written in the code:
they come from `java script/lang/` (English and French), so `calc.js` is loaded after `i18n.js` and the
language files.

- A product has one or more **selling prices**, each for one unit (piece, box, m², kg or meter) and each
  **independent**: 1,000 DA/m², 300 DA/piece and 1,440 DA/box can all be saved on the same tile, and the piece
  price is not forced to equal the m² price converted. A unit can have only one price per product.
- The price of a unit is decided in one place, `getUnitPrice` in `calc.js`:
  1. a price saved for exactly the unit sold is used as it is;
  2. otherwise the product's **main price** (the first one in its list) is converted with the tile size and the
     coverage per box, e.g. 1,500 DA/m², 60*60 cm tile, 1.44 m² per box: piece = 540 DA, box = 2,160 DA;
  3. a kg price never gives an m² price (and the other way round); a product saved with no price unit keeps its
     price as typed.
  A price worked out in step 2 is only used for that sale. It is never saved to the product.
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
- An invoice line shows the catalogue price it used and the unit that price is per. With a price saved for the
  unit sold, that is simply the price per unit sold (300 / Piece, 1,440 / Box). When the price was worked out from
  another unit, the line shows the main price and its unit (1,500 / m²), the quantity as it was sold (2 Boxes)
  and, when that is a different unit, the same quantity in the price unit underneath (2.88 m²), then the line
  total. A price typed by hand on the Sell page is the exception: the line then shows the price actually charged,
  per unit sold. The product's price is only ever shown when it really is what was charged (checked again from
  the line's own saved details). Saved invoice lines also keep a `priceSource` (`explicit`, `calculated`,
  `legacy` or `custom`).
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

## Outstanding customer debt (Sell page)

When a returning customer is **selected** (suggestion list) or **confirmed** (exact name + phone number, or an
earlier choice), Invoisy looks up their unpaid invoices and shows a card with the invoice numbers, dates, original
totals, amounts paid, outstanding balances and the total debt. Nothing is looked up while the name is being typed,
and never for "Walk-in Customer". A name with no phone number, a similar name or a shared phone number never
matches silently: the card lists those customers and the person chooses.

- **View Invoice** opens the old invoice in the preview; "Back to current sale" returns to the sale, which is untouched.
- **Add Outstanding Debt** opens a confirmation dialog (original invoice number, date, unpaid balance, amount to
  transfer, default = the full balance, partial allowed, the resulting total due). Nothing is saved until the sale is completed.
- **Remind Me Later** hides the card for this sale only (a small reminder stays next to the customer fields); it
  shows again for the next sale.

### Accounting model (why a debt is never counted twice)

- Customers still live inside invoices; a customer is recognized by an optional `customer.id` (added only when a
  returning customer is confirmed) or by normalized name + phone.
- Carrying debt forward writes **one ledger record** in the new `debtTransfers` store (source invoice, target
  invoice, amount, date, and a snapshot of the source's total, payments and balance before/after) and a
  **"carried forward" line** on the new invoice. The line is not a product: no stock, no price or quantity, and
  discount and tax apply to the products only. The invoice `total` stays the figure of the new purchase;
  `amount due = total + carried lines`.
- **Old invoices and their payments are never edited.** Their collectible balance is derived:
  `amount due - payments - transferred out`. A debt is therefore collectible exactly once (on the new invoice) and
  an invoice whose balance moved is shown as "transferred", with a "Carried forward to INV-x" line.
- Payments are not split or copied. A payment on the new invoice settles the carried debts oldest first (calculated,
  not stored). A payment on an old invoice whose collectible balance is zero is refused with a pointer to the new invoice.
- One IndexedDB transaction saves the invoice, the stock, the counter and the ledger records; the rule
  *payments + transferred out <= amount due* for every invoice is re-checked inside that transaction, so two
  windows or a stale screen can never overdraw a balance. Deleting the invoice that carries a debt removes its ledger
  records (the balance is collectible on the old invoice again); an invoice with transfers out can not be deleted.
- If an older invoice is paid while a draft debt is on the screen, the draft amount is lowered or removed and the person is told.

## Stock form

The form has three sections.

- **Product information:** product name, Manufacturer, tile size, SKU, category, description.
- **Selling prices:** one row per price: "Price per m²", "Price per piece", "Price per box", and so on. A new
  product starts with one m² row; **Add price** adds a row for the next unit that has no price; **Remove** takes a
  row away (one always stays). A unit can only be on one row, and all rows must be of one kind (piece, box and m²
  together; kg alone; meter alone). The first row is the product's main price.
- **Stock information:** stock quantity, stock unit (boxes for a new product), coverage per box, purchase price.

Mandatory fields have a small * on their label: product name, the first selling price, stock unit, and coverage
per box while any price is per m². Everything else may be left empty. Coverage per box is never invented: it stays
blank until entered, and a tile's size is never used as its coverage.

**Manufacturer** is an optional free-text brand or manufacturer name such as VEGA or Porcelanosa. It is saved with
the product, can be changed or cleared when editing, is shown next to the product name in Stock and on invoices,
found by search, and included in backups. Products saved without one keep working unchanged.

A box-counted product that has had pieces sold (19.25 boxes) can still be edited; that saved quantity is kept as it
is. A newly typed quantity in a whole unit (boxes, pieces) still has to be a whole number.

## Selling prices in the data (migration)

Products store `sellingPrices: [{ unit, price }, ...]`. `sellingPrice` and `priceUnit` are still saved and always
equal the first entry, so older Invoisy versions and older tools keep reading a price.

- **No migration step runs and no stored record is rewritten.** A product saved before this change has no
  `sellingPrices`; it is read as one price in its own price unit (`sellingPrice: 1000`, `priceUnit: "m2"` is one m²
  price). A product with no price unit is not given one: its price still applies as typed.
- A product is saved with a list the first time it is edited in the Stock form. Restoring an older backup fills the
  list from the old fields in the restored copy; stock, invoices, payments and the invoice counter are untouched.
- The database schema stays at version 2 (no new store or index). Backups keep the same format; the new field is
  validated when present (numbers only, supported units, one price per unit, one kind of unit).
- The main (first) price is read from `sellingPrice` / `priceUnit`, so anything that writes those fields (a product
  created from a purchase, an older version) changes the main price and is never shadowed by the list; the list
  only adds the other units' prices. An older version only sees and edits that main price.

## Suppliers and purchases

Two pages in the main navigation, **Suppliers** and **Purchases**, record what you buy. They are kept
apart from sales: purchases never create customer invoices, and sales never touch purchase records.

- **Suppliers**: searchable, sortable list with total purchased, paid, outstanding, last purchase and
  status. A supplier needs only a name; the rest (contact, phone, email, address, tax ID, website, payment
  terms 15 / 30 / custom days, optional credit limit, notes) is optional. A likely duplicate (same name,
  phone, email or tax ID) shows a warning and is never merged automatically. A supplier with purchase
  history can only be **archived**, never deleted. A credit limit only shows a warning.
- **Supplier profile** has tabs: Overview, Purchases, Payments, Products, Documents & Notes.
- **Purchases**: supplier invoice number (unique per supplier, the same number may be used by another
  supplier), invoice and due dates, internal reference, notes, optional attachment (max 5 MB), several
  lines (existing or new product, quantity, purchase unit, conversion factor, unit price, line discount)
  and invoice-level delivery, discount and tax (added or already included). A purchase can be saved as a
  **draft**; a draft never changes stock and can be deleted.
- **Confirming** a purchase is one all-or-nothing step: it checks everything again, creates new
  products, receives the goods into stock and records the initial payment. Confirming twice (double click,
  retry) does nothing the second time. Example: 200 boxes at 1.44 m² per box adds 288 m² to a product
  whose stock unit is m².
- **Partial deliveries**: goods can be received in several receipts. Each receipt is kept; a receipt can be
  reversed with a reason, which takes the stock out again. A reversal is refused when that stock has
  already been sold (stock never goes negative).
- **Cancelling** needs a reason, is refused while active payments exist (void them first) and reverses
  the stock that was received. A cancelled purchase keeps its record, counts nowhere in the totals, and frees
  its supplier invoice number.
- **Deleting** (Delete button in the Purchases list, and on the purchase page) removes a purchase for good, as if
  it had never been entered, unlike cancelling, which keeps the record. After a confirmation that lists what will go,
  it takes the goods received out of stock, and removes the purchase, all its payments (voided ones too) and its
  attached files in one transaction. Suppliers, products and other purchases are untouched. It is refused, changing
  nothing, when that stock was already sold. Deleting again does nothing, and a window with out-of-date data is
  refused. The internal reference counter never goes backwards, so the deleted number is not reused.
- After confirmation the lines, prices, totals and supplier are locked. Invoice number, dates, reference
  and notes can still be edited.
- **Supplier payments**: any number of separate payments per purchase. Outstanding = total minus
  payments not voided. Status: Unpaid, Partially Paid, Paid. An empty initial payment means 0. Amounts must
  be positive, may not exceed what is outstanding (overpayment is refused) and may not be dated in the
  future. A payment is never deleted on its own: editing keeps its history and voiding keeps the record with a reason.
- **Reports** (Purchases page): purchases in a period, outstanding balances, overdue purchases, totals by
  supplier, purchase history per product and payments made in a period. Cancelled purchases and voided
  payments are excluded, so nothing is counted twice. The totals add amounts as they are, so they assume
  one currency.
- **Costing**: a product's purchase price and cost are **not** updated automatically and there is no stock
  valuation (no average cost, FIFO or similar). The cost of each purchase stays on its purchase line. A
  purchase never changes a product's selling price.

## Tests

Needs Node 20 or newer. The app itself has no dependencies. The tests that save data use a disposable in-memory IndexedDB from the `fake-indexeddb` package (a development-only dependency), so run this once:

    npm install
    npm test

(`node --test` alone also runs, but the persistence tests then stop with a message asking for `npm install`.)

`tests/purchases.test.js` covers the supplier and purchase module: suppliers and duplicates, purchase
validation, stock on confirm, double confirm, partial receipts and reversals, cancel, payments, reports,
the database upgrade from version 2 and backup / restore of the new data.

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

Backups now also contain suppliers, purchases, supplier payments and purchase attachments (embedded in the file, so the file can become large when attachments are used). The backup format is version 2. Backups made by the earlier format (version 1, no supplier data) can still be restored; restoring one replaces everything, so suppliers and purchases that exist now would be replaced as well (the confirmation says so). An older Invoisy that does not know format 2 will refuse a version 2 backup as coming from a newer version. Backups from the previous version (`invoisy-data.json`) can also be restored.

Backups keep the debt ledger in an optional `data.debtTransfers` list (written only when there is one; the backup
format version is not changed by this feature). Restoring checks that the ledger agrees with the invoices and refuses an inconsistent file.
An older Invoisy that opens such a file ignores that list, so use the new version to restore backups that contain transfers.

## Automatic backup file (Settings, Automatic backup file)

Invoisy can keep one file, `invoisy-data.json`, up to date by itself: after every saved change (a product, stock, a sale, a payment, settings, the invoice counter) the whole database is written to it. You do not have to press Export Backup. The browser database stays the only place Invoisy reads from; the file is a copy.

- **Turning it on:** Settings, Automatic backup file, **Choose backup file**. You pick (or create) the file in the browser's own Save dialog. The browser remembers your choice; after a restart it may ask you to allow writing again (Settings then shows **Grant permission**).
- **A file that already has something in it is never replaced quietly.** It must be an Invoisy backup (or the previous version's data file). If Invoisy has no data of its own, nothing is written (restore the file first with Import / Restore Backup). If both have data and they differ, you are asked, and a copy of the file as it is now is downloaded first (`invoisy-before-autobackup-YYYY-MM-DD.json`).
- **The file is never loaded back automatically.** Restoring is only ever Import / Restore Backup, which asks first.
- **Settings shows** whether the file is connected, its name, the last successful backup, the latest database revision, the last backed-up revision, whether the backup is current or pending, and the last error. "Backup current" is shown only after the file was written *and read back* with the latest revision.
- **If writing fails** (file moved or deleted, disk full, drive unplugged, access withdrawn) the change you made is still saved in the browser database. The backup stays "pending", is retried three times with growing pauses, and is tried again after the next change, when you come back to the window, or when you press **Retry backup**. A warning also appears in the top bar.
- **Safe writing:** quick changes are folded into one write; one write at a time (across windows too); the browser writes a temporary copy and swaps it in only when it is complete, so a failed write leaves the previous file as it was. A file that holds a *newer* revision than the database is not overwritten.
- **Browsers:** needs the File System Access API (Chrome, Edge, Opera on a computer). Firefox and Safari do not have it: Settings says so, nothing is pretended, and Export Backup is the way to back up.
- The backup file has the same format as Export Backup (format version 2, including suppliers, purchases, supplier payments and attached files), plus a `revision` (the database revision it holds). Because attached supplier invoices are inside the file, the automatic file grows with them and is rewritten after every change.

## Updating from the previous version

The previous version kept its data in a data file plus a copy in the browser's localStorage. On first start the new version copies that localStorage data into IndexedDB, checks the copy, and leaves the old data exactly where it was (nothing is deleted). Settings explains what happened. If you used a data file, load it with Import / Restore Backup if it has newer data than the browser copy. The old copy can be removed from Settings once you have exported a backup.

## For developers

```
index.html
css/style.css, css/pricing.css
java script/i18n.js, lang/    the language layer and the English / French texts
java script/calc.js           unit conversion and price maths
java script/purchases.js      suppliers, purchases, stock receipts, supplier payments and reports (logic only, no screens)
java script/validation.js     the shape and rules of the data; backup file format; reminder rule; old-data reader
java script/debt.js           customer recognition, outstanding debt and the draft of debt carried onto a sale (pure functions)
java script/database.js       the IndexedDB layer (the only code that touches IndexedDB)
java script/autobackup.js     the automatic backup file (file handle, write queue, status)
java script/purchases-ui.js   the Suppliers and Purchases screens
java script/script.js         the other screens and the wiring
```

Scripts load in the order i18n, lang, calc, purchases, validation, database, autobackup, purchases-ui, script (see the end of `index.html`). Every message the persistence code shows or throws comes from `lang/en.js` and `lang/fr.js`.

- Schema version 4, database name `invoisy`. Stores: `products`, `invoices` (unique `invoiceNumber`), `settings`, `counters`, `meta`, and since version 3 `suppliers`, `purchases`, `supplierPayments`, `attachments`, and since version 4 `debtTransfers` (the customer-debt ledger; indexes `sourceInvoiceId`, `targetInvoiceId`). Customers and payments are stored inside each invoice. The upgrades only add stores (and a purchase counter); existing data is not touched, and version 4 only adds the empty `debtTransfers` store. Unique indexes on purchases (supplier + normalised invoice number, and internal reference) apply to non-cancelled purchases only.
- A sale (invoice + stock deduction + invoice counter) is one transaction, and so is a purchase confirmation (purchase + new products + stock + payment + purchase counter + attachment). Every write also checks the database revision it started from, so a second open window can not overwrite a change it has not seen.
- Every committed change to business data moves the revision on in one of two places (`commitInTx`, `writeDataset`); both call `markCommit`, and `withTx` emits a `commit` event only after the transaction has really committed. `autobackup.js` listens to that event, so a new feature that saves through `database.js` is covered without touching the backup code. The file handle and backup notes are kept in the `meta` store (no schema change).
- `tests/autobackup.test.js` covers the commit event and the backup file with a stand-in file handle. `tests/e2e/autobackup_check.py` is an optional real-browser check of it (real IndexedDB and a real `FileSystemFileHandle` from the browser's private file system; only the operating system's Save dialog is replaced).
- `tests/purchases.test.js` covers the supplier and purchase module; `tests/e2e/purchases_check.py` is an optional real-browser walk through the suppliers / purchases flow (same setup as below; not run by `npm test`).
- `tests/e2e/browser_check.py` is an optional real-browser check (Playwright + Chromium, opened over `file://`, disposable profile).

## Known limits

- Invoisy can not see where a downloaded backup is stored or whether it is kept.
- Purchases: no inventory valuation or costing method, and a product's purchase price field is not updated by purchases. Report totals assume a single currency. Attachments are limited to 5 MB each and are stored inside IndexedDB and in the backup files.
- The version 2 to 3 upgrade and the purchase flows were tested with an in-memory IndexedDB and in Chromium only; the print layout of a purchase was not checked visually.
- Two windows can be open at once; if both change data at the same time, the second save is refused with a message to repeat the action, with the latest data already loaded.
- Data entered in an old Invoisy window that is still open after updating is not picked up automatically; close old windows before updating.
- Automatic backup file, not verified in a real browser: the operating system's Save dialog itself, the browser asking again for permission after a restart, and use over `file://` (Chromium does not offer its private file system there, so the real-browser check runs over a local web server). These are covered only by the stand-in tests. Two browsers or profiles pointed at the same file will keep refusing to overwrite each other's newer data; use one.
- There is no button to switch the automatic backup off; choose a different file, or clear the site data.

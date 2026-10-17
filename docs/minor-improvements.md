# Small improvements

Six additions to the existing app. None of them adds a dependency, a backend or a second database: every business-data
write goes through the existing layer (`commit()` in script.js → `commitChanges()` in database.js), so the revision check,
the single transaction and the automatic backup file keep working for each of them.

## 1. Several business phone numbers

- **Settings → Business details** has a list of phone boxes with **Add phone number** and **Remove** (at least one box
  stays; up to 10 numbers). Blank boxes and repeats of the same number are dropped when saving.
- Stored in the settings as `phones: [...]`. The older single `phone` stays equal to the **first** number, so older readers
  and old backups still see a main number. A business saved before this change is read as a list of one.
- **On the invoice** one number prints exactly as before. Several numbers print on one neat line separated by `·`
  (`.inv-phones`). An invoice keeps the letterhead (`business`) it was saved with, so earlier invoices do not change.

## 2. Several supplier contacts

- The supplier form has a **Contacts** section: one row per contact (name and phone, either may be blank) with
  **Add contact** and **Remove**. Stored as `contacts: [{ name, phone }]`; `contactName` and `phone` follow the first
  contact. A supplier saved with one contact name and one phone is read as one contact and is not rewritten until edited.
- The list, search, supplier profile, statements and the duplicate-supplier warning use every contact.

## 3. "Sale completed" dialog

After a successful save the Sell page opens a dialog: *Sale completed successfully. What would you like to do?* with
**Print Invoice** (focused: Enter prints), **New Sale** and **Later**. The invoice is already committed when the dialog
appears. The pending action is cleared before anything runs, so repeated Enter presses or rapid clicks print once and never
save a second invoice. If the browser refuses or cancels the print, the invoice stays saved and a message says so. Escape
means Later. Nothing navigates away on its own.

## 4. Edit Invoice

**Edit** is on the Invoices list and next to a saved invoice (beside View, Add Payment, Print and Delete).

- **Editable:** customer name, phone, address and second name; products, quantities and units (add or remove lines);
  selling price per line; the invoice discount and tax.
- **Kept:** invoice number, id and date, the customer's identity, the payment history, the delivery log, the letterhead,
  and, for every line that stays, the price, unit, conversion and catalogue price it was sold at (the catalogue is not
  re-read for a line that was already sold). The counter is not touched.
- **One transaction.** The corrected invoice and every stock change (stock given back for a lowered or removed line, extra
  stock taken for a raised or added line) are written together by `commit()`. If anything fails (not enough stock, invalid
  number, a conflicting change from another window) nothing is written and the screen stays open with what was typed.
- **Totals, balance and status** are recalculated. A change that would leave the recorded payments above the new total is
  refused with an explanation: payments are never deleted or changed. Lower the price only as far as the payments allow, or
  deal with the payment first.
- **Invoices that track deliveries** keep their quantities and lines (the delivery log refers to them); customer details and
  prices can still be corrected.
- An edited invoice records `updatedAt` and `edits: [{ at, totalBefore, totalAfter }]`.
- Leaving the screen with typed changes (Cancel, the menu, closing the page) asks first.
- Printing an edited invoice prints the corrected details under the same number.

## 5. Similar products in Stock

While a name is typed in the Stock form (Add or Edit), products that look alike are listed with their full name, tile size,
type and manufacturer. Case, accents, spaces and punctuation are ignored. The list comes from the products already in memory
(no database read per keystroke). **View / edit** opens the product; **Add stock** points the restock box at it.
*No similar products found* is shown when nothing matches. Nothing is merged or deleted, and a new variant with another
size is still allowed (the existing duplicate rule is unchanged).

## 6. Invoice history: search, filter, sort

- **Search** (live, partial, case-insensitive): invoice number, customer name (and second name) and customer phone.
- **Filters:** payment (all, unpaid, partially paid, paid) and delivery (all, delivered, not delivered), independent of each
  other. *Delivered* = every item handed over (an invoice that does not track deliveries handed everything over at the sale);
  *Not delivered* = something is still to collect, partly delivered included.
- **Sort** by clicking a column header (invoice number numerically, date chronologically, customer, total numerically,
  payment status); a second click reverses it, and the header shows ▲ / ▼. **Clear filters** resets everything.
- Search, filters and sort work together. The row actions are unchanged (plus Edit).

## Tests

`tests/minor-improvements.test.js` covers all of the above, including the automatic backup file after each new kind of
change and the reading of older data. `tests/e2e/minor_improvements_check.py` is an optional real-browser check.

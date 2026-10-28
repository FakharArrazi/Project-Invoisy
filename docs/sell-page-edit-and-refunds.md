# Editing an invoice on the Sell page, and refunds

> **Changed:** removing every product no longer *cancels* the sale and keeps the invoice. It now **deletes the invoice and
> reverses the sale**, exactly like the Delete button: see `invoice-rollback.md`. The "Complete cancellation and refund" section
> below describes what earlier versions did; invoices they cancelled are still read, shown and can now be deleted.

This replaces the separate "Edit invoice" screen described in `minor-improvements.md` §4. Everything else in that
section (what is editable, history entries, refund due after a cheaper edit) still applies.

## Edit = the Sell page

**Edit** (Invoices list, or beside a saved invoice) opens the normal Sell page with the invoice loaded as the sale:
search, add and remove products, quantity, unit, unit price, customer name / phone / address / builder group,
discount, tax, live subtotal / discount / tax / total / paid / remaining, and the live preview. **Save changes**
updates the SAME invoice: same id, number, date, payment history and carried-forward debt. No new invoice is made and
the invoice counter does not move. The sale being prepared before the edit waits and comes back afterwards.

- The preview is marked *Preview of your changes (not saved yet)* (dashed outline); nothing is stored and no stock moves
  until Save.
- Leaving with typed changes asks first.
- Invoices with a delivery log keep their products and quantities (prices, customer, discount, tax can change) and can not
  be cancelled here.

## Stock

`planInvoiceEdit` (script.js) works out ONE net change per product: what the invoice originally took (the
`stockDeducted` saved on each line, never recomputed from today's product data) is given back and what the corrected
lines need is taken. 10 → 6 boxes returns exactly 4; a removed line returns all of it; a new line takes its quantity.
Not enough stock refuses the whole edit. Invoice, products and the backup are written in ONE transaction (`commit`).
While editing, the Sell page counts the invoice's own quantity as available (`stockAvail`).

## Complete cancellation and refund

(Earlier versions:) removing **every** product turned Save into **Cancel sale and refund**, behind a confirmation that names the invoice,
the original total, the amount collected and the refund. Declining changes nothing. Confirming:

- gives all the invoice's stock back;
- records ONE refund (`refunds[]`, reason `cancellation`) of the money actually collected for this sale
  (30,000 total / 20,000 paid → 20,000; nothing paid → no refund record). Old debt carried onto the invoice and paid with it is
  not part of the refund;
- keeps the original lines, totals, payments and edit history, and adds `cancellation { at, total, paid, refund }`;
- shows the invoice as **Cancelled** (list badge, pay box, details, print) and excludes it from what is owed;
- can not be repeated: a cancelled invoice can not be edited, cancelled, refunded again or deleted (screen, planner and
  `Validation.cancellationHistoryProblem` in the database layer; only refunds can be appended to a cancellation record).

Limits: an invoice with deliveries, or whose unpaid balance was carried to a newer invoice, is not cancelled here.

## Payments and refunds

Payments are never edited or deleted. Money handed back is a separate `refunds[]` record. Everything is derived from the
two lists (`Validation.paymentDetail`): `netPaid = payments − refunds`, `refundDue = max(0, netPaid − amountDue)`.
After a cheaper edit the refund due is recorded from the pay box (**Record a refund**, never more than is due).

## Prices and units

A saved line keeps the price and unit it was sold with (`unitPrice` per unit sold, `priceUnit`, `productPrice`,
`priceSource`); the edit shows that, not today's catalogue price. A product removed and added again is a new line at
today's catalogue price in the product's configured pricing unit (DA/piece, DA/box or DA/m²), the same as on a new sale.
Changing a line's unit and changing it back restores the saved form.

Old invoices (no `refunds`, no `cancellation`) are read and edited as before.

Tests: `tests/sell-page-edit.test.js`, `tests/invoice-returns.test.js`, `tests/minor-improvements.test.js`;
browser check: `python3 tests/e2e/sell_page_edit_check.py`.

# Deleting an invoice reverses the sale

The administrator can delete **any** invoice (Paid, Partial, Unpaid, Cancelled, delivered in steps). Deleting is a real removal
from the database, not a status change or an archive. It is also what happens when **every product is removed while editing** an
invoice: an invoice with no lines is never kept.

## What a delete does (one transaction: all or nothing)

| What | Result |
| --- | --- |
| The invoice, its payments, delivery log, edit history | Removed. Gone from the list, the count, search, the filters and the customer's debt, and it stays gone after a reload. |
| Debt records that carried an old balance *into* this invoice | Removed: that balance is collectible on the older invoice again (unchanged behaviour). |
| Stock | Everything the invoice still holds out of stock goes back to **its own product** (matched by id), in the product's own stock unit. Several lines of one product add up. |
| Money collected | Recorded as **refunded** in the refund log (below): payments less refunds already handed back. Unpaid: nothing. |
| The invoice counter | **Not** moved back: the number of a deleted invoice is never given out again. |
| Everything else | Untouched: other invoices, products, settings, purchases, suppliers. |

The question before deleting says, with real figures, what will go back to stock and how much will be recorded as refunded. Cancel
or Esc changes nothing.

## Stock rules

Read from the invoice itself, never from today's product data (`stockHeld` in `script.js`):

- Normal invoice: the `stockDeducted` saved on each line (older lines without it are worked out from the line's own unit, as the
  edit always did).
- Invoice sold in several deliveries: only the goods that were really handed over (the sum of its delivery log). What was never
  taken out of stock is never put back.
- A cancelled sale saved by an earlier version: **nothing** (the cancellation already gave the stock back), so it is not restored
  twice.
- A product that no longer exists is never re-created: the rest is restored, and the message and the log name what could not be.
- A product whose stock unit changed since the sale is not guessed at: nothing is deleted and the person is told.

## Money: the refund log

This is a local app, not a payment processor: nothing moves money. To let the shop reconcile its cash, one record per rollback is
added to the settings as `rollbackLog` (a list; absent until the first rollback, so older data keeps exactly its shape). It is
saved in the **same transaction** as the removal, so a record exists if and only if the rollback happened, and it travels in every
backup and restore.

```
{ id, at, reason: "delete" | "edit", invoiceId, invoiceNumber, invoiceDate, customer: { name, phone }, currency, status,
  total, paid, alreadyRefunded, refund, payments: [{ amount, timestamp }], items: [{ name, qty, unit }],
  stock: [{ productId, name, unit, qty }], notRestored?: [name], wasCancelled?: true }
```

`refund` = money still to hand back in cash = payments less refunds already recorded. A cancelled invoice that was fully refunded
has `refund: 0` (no second refund). The app never edits or deletes log records.

## Safe to repeat

The invoice is the record of what to reverse and it disappears in the same transaction, so a second delete (double click, a
second window, a retry after a failed save) finds nothing and changes nothing. A write that fails leaves stock, invoice, payments
and log exactly as they were. A refund shown in the question that changed meanwhile (a payment arrived in another window) refuses
the delete and asks to try again.

## The one invoice that is refused

An invoice whose **unpaid balance was carried forward to a newer invoice** can not be deleted while that newer invoice exists
(the debt would disappear from the invoice that asks for it). The dialog says which invoice to delete first. Deleting the newer
invoice first is allowed (its refund covers everything collected on it, and the old debt becomes collectible on the old invoice again).

## Tests

`npm test` -> `tests/invoice-rollback.test.js` (every status, stock units, atomicity, idempotence, persistence), plus the updated
`tests/sell-page-edit.test.js`, `tests/invoices-page.test.js`, `tests/fulfillment.test.js`. Browser:
`python3 tests/e2e/invoices_page_check.py` and `python3 tests/e2e/sell_page_edit_check.py`.

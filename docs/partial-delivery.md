# Partial delivery (paid now, collected later)

Payment and delivery are two separate things. A customer can pay for 15 boxes while the warehouse has only 10: they take
10 now and collect the other 5 later. The invoice keeps asking for 15 boxes and 15,000 DA, and is paid in full; what is
left to collect is tracked apart from the money.

- **On the Sell page**, a line has a **Deliver only part now** box. Ticking it lets the line be sold beyond the stock: the
  quantity, price and total stay those of the sale, and a **Deliver now** field says how much leaves with the customer
  today (in the unit of the line: boxes, pieces or m²). It starts at everything the stock can deliver and can be lowered.
  Only the quantity delivered now is checked against the stock and taken out of it. A line without the box is held to the
  stock exactly as before (the message now points at the option). Delivering 0 now is allowed.
- **Delivery status** is shown next to the payment status: on the invoice (*Delivered 10 Boxes - To collect 5 Boxes* under
  the line, a *Delivery* status and a delivery history), in the Invoices list (*To collect* / *Delivered* badge, and a
  **Collect** button) and in the box above a saved invoice. Delivered and remaining quantities are always calculated from
  the delivery log, never typed or stored separately.
- **Recording a collection** (box above a saved invoice: quantity per line, optional note such as who collected, **Record
  collection**) is one transaction that takes the delivered quantity out of stock and appends an entry to the delivery
  log. It is refused, changing nothing, when it would deliver more than what is left to collect, when the stock can not
  cover it (stock never goes below zero, also when two lines share one product), or when the product no longer exists.
  Collecting does not require the invoice to be paid and never changes a payment.
- **Collection document** (**Print collection document**): titled *Remaining-quantity collection document*, numbered after
  the invoice (INV-000030 gives COL-000030), with the original invoice number and date, the customer, only the quantities
  still to collect, the deliveries so far and a signature line. It is not an invoice: it has **no prices, no totals and no
  amounts** and says that payment is recorded on the original invoice only, so the goods can not be charged a second time.
  Each recorded pick-up has its own receipt number (COL-000030-1, COL-000030-2, ...) in the delivery history.
- **Audit trail.** The original invoice (items, prices, total, payments) is never edited by a delivery. The delivery log is
  append-only: the database refuses to edit or remove a saved delivery, to change the lines of such an invoice, to make an
  already saved invoice partly delivered, or to delete an invoice that has a delivery log (the app says so before it gets that far).

## Delivery in the data

- An invoice sold with something left to collect has `deliveries: [{ id, type: "sale" | "collection", date, lines: [{ lineId,
  qty, stockDeducted }], note? }]` and a `lineId` on each item. The first entry (`sale`) is what left with the sale; each
  `collection` is a recorded pick-up. `qty` is in the unit the item was sold in, `stockDeducted` in the product's stock unit.
  `items[].stockDeducted` of such an invoice is what the sale itself took out of stock.
- An invoice **without** `deliveries` (every older invoice, and every sale delivered in full) is simply fully delivered, so
  nothing is migrated and nothing in an old data file changes. The schema version (4) and the backup format version (2) are
  unchanged; backups carry the log inside the invoice and add a calculated `deliveryStatus` (`complete`, `partial`,
  `pending`) for people reading the file. Restore checks the log (well formed, never more delivered than sold).
- The rules (`deliveryDetail`, `deliveryProblem`, `deliveryHistoryProblem`, collection numbers) are in `validation.js`; the
  screens and `applyCollection` are in `script.js`.
- An older Invoisy opening a backup that contains delivery logs ignores them and shows those invoices as fully delivered;
  use this version to restore such a backup.

## Tests

- `tests/fulfillment.test.js` (run by `npm test`) covers selling beyond the stock, boxes / pieces / m², collections,
  over-delivery and negative-stock refusals, two windows at once, payment kept apart from delivery, the append-only log,
  the collection document, backup and restore.
- `tests/e2e/partial_delivery_check.py` is an optional real-browser walk through the 15-boxes example, including the print
  layout of the collection document (Playwright + Chromium, same setup as the other `tests/e2e` checks).

## Known limits

- It is decided when the sale is made: a saved invoice can not be turned into a partly delivered one, because its stock was
  taken out in full when it was sold.
- A collection is recorded in the unit the line was sold in. A recorded collection can not be undone or edited (it is an
  audit record), and an invoice that has a delivery log can not be deleted.
- A product counted in boxes is sold in whole boxes (an area typed in m² is turned into boxes when it is added), so a partial
  line of such a product is counted in boxes. Partial lines in m² exist for products whose stock is counted in m².
- On paper-width screens the empty page container can add a blank first page to the purchase documents' print; the collection
  document avoids it.

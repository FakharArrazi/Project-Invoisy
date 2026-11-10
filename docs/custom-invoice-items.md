# Custom invoice items

A **custom item** is a line of an invoice that is not a Stock product: broken tiles, old or discontinued ceramic, cement,
grout, a jacket, anything a customer wants to buy. It is typed on the Sell page and lives on the invoice only. It
**never touches the inventory**.

## Using it

On the Sell page, **+ Custom Item** (next to *Add products*) opens a dialog:

| Field | Rule |
| --- | --- |
| Product name / description | required, up to 120 characters |
| Quantity | required, above 0, decimals allowed (`2.5`, `0.75`) |
| Unit | required, free text (up to 24 characters): Box, m², Piece, Bag, kg, "Sac 50 kg"... A list of common units is offered while typing |
| Price per unit | required, 0 or more (money has 2 decimals, like everywhere in the app) |
| Total | shown, calculated: quantity x price per unit |
| Additional note | optional, up to 300 characters; printed under the name |

The line then sits in the sale next to the Stock products. Its quantity, unit and price can be changed in the table, **Edit**
reopens the dialog (name and note too), **Remove** takes it off. A custom line is marked *Custom item · not in stock* and
shows no stock, no unit list and no "deliver later" box.

An invoice can hold only custom items, only Stock products, or both.

**Discount.** Custom lines take part in the invoice discount (amount or percent), the tax, the amount due, the payments and the
remaining balance like any other line. There is no separate discount per line: Invoisy has one discount per invoice, and a
line discount would have been a second rule that every total, print and report had to learn.

## What a saved line looks like

```js
// Stock product (older invoices have no itemType: they are read as "inventory")
{ itemType: "inventory", productId, name, sellingUnit, qty, unitPrice, total, stockDeducted, ... }

// Custom item: a snapshot of what was typed, nothing about stock
{ itemType: "custom", name: "Broken Tiles", note: "optional", qty: 3, unit: "Box", unitPrice: 300, total: 900 }
```

A custom line has **no** `productId`, `sellingUnit`, `stockUnit` or `stockDeducted`. `validation.js` (`customItemProblem`)
refuses an invoice whose custom line has any of them, in the database and when a backup is restored.

## Why the inventory can not be affected

Every place that moves stock tests `isCustomItem(item)` (`itemType === "custom"`) and skips the line, and none of them has a
product to find anyway:

| Operation | What happens to a custom line |
| --- | --- |
| Sale (`stockNeeds`, `applySale`) | needs no stock; no product is looked up |
| Sell page sync with the Stock page (`syncSaleWithProducts`) | kept (a deleted product removes its own lines, never a custom one) |
| Editing a saved invoice (`planInvoiceEdit`) | stays custom; its name, note, quantity, unit and price can change; no stock change |
| Removing a line / returning goods | a removed custom line gives nothing back to stock |
| Removing every line, or deleting the invoice (`planInvoiceRollback`, `stockHeld`) | nothing to restore, and it is never reported as "could not be restored" |
| Pick-ups of an invoice delivered in steps (`deliveryDetail`, `applyCollection`) | always delivered with the sale, never "to collect"; a pick-up of a custom line is refused |
| Dashboard product rankings (`analytics.js`) | not counted as a product (its money is in the invoice total, so revenue is right) |

On an invoice delivered in steps, a custom line's **price** can still be corrected, but its quantity can not and a custom line
can not be added (the lines of such an invoice are a record, the same rule as for products).

## Database and backups

There is **no schema change and no migration**. Invoices are stored as before; a custom line is just another entry of
`invoice.items`, so existing records, the invoice counter and the backup format (`formatVersion`) are untouched. Older invoices
are not rewritten (no `itemType` means inventory). The JSON export / import carries custom lines unchanged. Backups made before this
feature import exactly as they did (their lines are inventory lines). A backup made with custom items is meant for this
version or a later one.

## Printing

A custom row prints the name (the note under it, in the same small grey type as a product's type), the quantity with its unit as
typed (`3 Box`, `12 m²`), the unit price (`300 / Box`) and the total. Text typed in any field is escaped.

## Tests

`tests/custom-items.test.js` covers the typing rules, custom-only / mixed / inventory-only invoices, decimals and units,
discounts and payment states, the Sell page and its dialog, editing, returns, deleting, invoices delivered in steps, reload,
backup export / import, invoices made before this feature, print markup and the Dashboard.

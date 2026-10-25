# Sell page: look, A4 preview and the seller name

## What changed

**The Sell page looks like the Stock page.** Same title style, 42 px controls, table header, radii and colours, and the
buttons (*Clear*, *Complete Sale*) sit in a bar that stays in view at the bottom of the sale card, as on the Stock form.
Nothing about how a sale works changed: the same functions add lines, price them, take payments and save. The styles are
in `css/sell.css`, loaded after `style.css`.

**The live preview is a small sheet of paper.** It shows the very pages that are printed: `renderPreviewSheets()` in
`script.js` uses the same `printItems`, `InvoicePrint.paginate` and `invoiceFooterHtml` as the print code, so the preview
and the print cannot drift apart (a long invoice shows several sheets, each with its own footer). Each page keeps its real
size (210 × 296.5 mm, or A5) and is shrunk on screen with `transform: scale(var(--sheet-scale))`; the wrapper
`.inv-sheet` is sized to match so nothing overflows. `fitPreviewSheets()` sets the scale from the width of the panel
(a `ResizeObserver`), never above 0.85. The scaling is inside `@media screen`: on paper the pages are untouched, so print
size, pagination and page numbers are exactly what they were.

## The seller name

*Seller name* (*Nom du vendeur*, *اسم البائع*) is a box with a small **Save** button (*Enregistrer*) on the title row of the
Sell page, at the far end.

- **Typing does nothing by itself.** No redraw of the preview, no write, focus stays in the box. Typing only makes the
  button ready (blue, "Save"); after saving, or when the box holds the kept name, it is grey ("Saved"). Press the button, or
  Enter, to keep the name: the preview then shows it. A name typed and not saved is not used on an invoice, and it is not
  lost by starting another sale or by the page being redrawn.
- It is a setting (`settings.sellerName`, default `""`). It stays through completing a sale, *Clear*, a page reload and
  closing the app, until you change it. Saving an empty box clears it.
- Each invoice gets its own copy (`invoice.sellerName`) when it is made. Changing the setting later changes new invoices
  only; saved invoices, and old backups, are not rewritten. An empty name stores no field at all.
- While a saved invoice is being edited the box and button are locked and show that invoice's seller, with a note saying
  why. The setting is not touched during an edit.
- Backups carry both. A backup made before this feature restores with an empty seller.

## The footer

Every page, in the preview and on paper, ends with one row: **invoice number · seller name · page number**. It is a CSS
grid, `1fr minmax(0, 44%) 1fr`, so the middle column is centred on the sheet whatever the two outer texts are. A long
name wraps to two lines and is cut after that (the full name is in the `title`); it cannot overlap or push the other two.
With no seller name the middle stays empty and prints no placeholder. The row mirrors in Arabic (right to left).

## Checks

- `npm test`: `tests/seller-name.test.js` (setting, typing then Save, per-invoice copy, John then Jack, reopen on the same
  database, edit lock, backups, footer markup and escaping).
- `python3 tests/e2e/seller_name_check.py` (optional, needs Playwright and Chromium): real browser and real PDF. A4
  proportions of the preview, footer centred to within a pixel, long names, empty name, a multi-page invoice, A5, Arabic,
  the preview and the print carrying the same text, and that typing letter by letter redraws nothing, the box and button on the title row, and the John / Jack persistence across closing and reopening the browser.

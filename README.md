# Invoisy

A small invoice and point-of-sale app that runs in the browser. Add products, sell them, watch the invoice update live, then print it or save it as a PDF.

## Run it

Open `index.html` in a browser. No installation, no backend.

(Optional) To use a tiny local server instead: `python3 -m http.server`, then open http://localhost:8000.

## Tests

With Node.js 18 or newer installed, run:

```
node --test tests/product-model.test.js
```

## Where data is stored

Invoisy stores its persistent application data in a local `invoisy-data.json` file. The file contains inventory, invoices (with every item and every individual payment), settings, business information, logo data, paper size and invoice numbering. It is plain JSON with a `version` field, so it can be backed up, copied or inspected with any text editor.

Keep `invoisy-data.json` with the Invoisy application folder and back it up regularly. If you move the folder and bring the file with it, you bring your whole business state with you.

The file is intentionally excluded from Git by `.gitignore` because it holds private business data (backup files named `invoisy-backup-*.json` are excluded too). Only those names are ignored; other `.json` files are not.

### Connecting the data file (once)

A web page cannot silently create or find a file on your disk, so you tell Invoisy where the file is. This needs a browser with the File System Access API (Chrome or Edge).

1. Go to **Settings, Data storage**.
2. First time: click **Create Data File** and save `invoisy-data.json` in the Invoisy folder. Anything already in your browser (see Upgrading below) is written into it.
3. Already have a file (for example after moving the folder): click **Choose Data File** and select it.
4. Allow Invoisy to edit the file when the browser asks.

From then on every change (product, stock, sale, payment, settings, logo, paper size) is written to the file straight away, and the app only says "saved" after the file was written and read back successfully. **Save Data Now** forces a save.

The browser remembers the file, but it may ask for permission again after you restart it. When that happens a banner appears: click **Reconnect**. If you move the folder, choose the file again with **Choose Data File**. Until the file is connected, changes made in a browser that supports files are blocked (once a file has been linked) so the file and the browser can never drift apart.

If your browser has no File System Access API (for example Firefox or Safari), or the file is not connected yet, Invoisy still works but keeps the data in the browser only. A banner says so, messages say "Saved in this browser only", and you should use **Export Backup** regularly. If the buttons are disabled when you open `index.html` directly, run `python3 -m http.server` in the folder and open http://localhost:8000 instead.

### Safety

- The data is validated before every write; invalid data is never written.
- A sale is saved as one step: the invoice, the stock decrease and the invoice counter are written together, or not at all. If the save fails you get an error, nothing changes on screen, and the file is left as it was.
- If the file is corrupted, empty or edited into an invalid state, Invoisy shows an error, does not overwrite it and does not replace it with empty data. The last browser copy stays visible for viewing and you can export it.
- If the file was changed by another window or program since Invoisy last saved, the save is refused, the newer file data is loaded and you repeat your action.
- The invoice counter is checked against the existing invoice numbers on every load and raised if it is too low, so numbers are never reused.
- A copy of the data is also kept in the browser's `localStorage` (key `invoisy-data`) as a fallback. The data file always wins: whenever the file is loaded it replaces the browser copy. If the file is older than the browser copy, Invoisy asks before loading it.

### Backup and restore

**Export Backup** downloads the complete data as `invoisy-backup-YYYY-MM-DD.json`. **Import Backup** replaces the current data with a backup after you confirm; the backup is validated first and an invalid file changes nothing. The invoice counter never goes backwards on import.

### Upgrading from the old browser-only version

On the first start after this update Invoisy reads the old `products`, `invoices`, `settings` and `invoiceCounter` entries from `localStorage` and converts them to the new format. The old entries are left untouched and are no longer written to. Then create the data file as described above.

## Add products

1. Go to **Stock**.
2. Fill in the form (name, selling price and stock are the essentials) and click **Add Product**.
3. To add stock to an existing product, use **Add Stock**. Use `-` / `+` in the table for quick changes, or **Edit** / **Delete**.

### Selling price and price unit

The **Selling price** always has a unit next to it: per piece, per box, per m², per kg or per m. It says what the price is for. A tile can be `800 DA per m²`, cement `300 DA per kg`, a chair `500 DA per piece`.

When you sell, you pick the unit next to the quantity (**Quantity: 2 | Unit: Box**) and the app works out the price of one unit of that kind:

| Product | Price | Sold as | Price of 1 unit | 2 units |
| --- | --- | --- | --- | --- |
| Tile 60*60, 1.44 m² per box | 800 DA per m² | Box | 1.44 x 800 = 1,152 DA | 2,304 DA |
| same tile | 800 DA per m² | Piece | 0.36 x 800 = 288 DA | 576 DA |
| Cement | 300 DA per kg | kg | 300 DA | 600 DA |

- Piece, box and m² are linked through the **Tile size** (area of one piece) and **Coverage per box**, so keep those filled in for tiles. A price per m² needs the coverage per box.
- kg and m only match themselves. A product priced per kg can't be sold by the box, and the app says so.
- Typing an area (unit m²) still sells whole boxes, rounded up, at the box price.
- Changing the unit on a sale line replaces the line's price with the price for the new unit. You can still type a different price on the line afterwards.
- Products saved before this field existed have no price unit: they keep working as before (the price is used as typed for any unit). Edit them and choose a unit to switch them over; the field is required when saving.
- Invoices show the price with its unit (`1,152 / Box`).
- Stock quantities are not converted between units: stock is one count per product, as before.

New here? **Settings → Load Demo Data** adds a few sample products.

## Create an invoice

1. Go to **Sell**. Type in the search box (name, SKU or category), press Enter, type a quantity, press Enter.
2. Adjust quantities or unit prices in **Current sale**. Optionally add customer details, a discount and tax (each as an amount or a %).
3. The invoice on the right updates as you type.
4. Enter **Amount Paid** (cash). Leave it empty if the customer pays in full; enter a smaller amount (or 0) for a partial or unpaid sale.
5. Click **Complete Sale**. The invoice gets the next number (INV-000001, INV-000002, ...), is saved, and the stock goes down. Stock is only reduced at this step, never while you are building the sale.

## Payments

An invoice can be paid over time (cash only). In **Invoices** each row shows Total, Paid, Remaining and a status (Paid, Partial, Unpaid). Search by invoice number, customer name or phone.

To record a later payment, click **Add Payment** on the invoice, type the amount under **New payment** and click **Add Payment**. The current date and time are saved with it and every payment stays on the invoice. A payment can't be more than the remaining balance. Once an invoice is fully paid the control is disabled.

The items on a saved invoice are locked. Stock goes down when the sale is completed, not when it is paid, and payments never change stock.

Invoices can also be viewed and printed from **Invoices** (View, Print, Delete). Deleting an invoice does not put items back in stock.

## Print / save as PDF

Click **Print / PDF** next to the invoice (or **Print** in the Invoices list). In the browser's print dialog choose your printer, or **Save as PDF**. Only the invoice is printed, on A4 or A5 (chosen in **Settings**), with its full payment history. If your browser still prints a web address or file path at the top or bottom of the page, untick **Headers and footers** in the print dialog.

## Change business details or currency

**Settings** holds the business name, address, phone, email, currency (default `DA`), the invoice paper size (A4 or A5, default A4) and the store logo (**Choose Logo** / **Remove Logo**, PNG only). The logo is saved in the data file (as a PNG data URL, so it moves with it) and shown above the business name on every invoice. New invoices use the current values; saved invoices keep the ones they were created with. The default currency is also the `CURRENCY` constant at the top of `script.js`.

## Files

- `index.html` - page structure
- `css/style.css` - styles, including the print rules
- `css/pricing.css` - styles for the price unit field and unit labels
- `java script/pricing.js` - price units and the unit price conversions (no DOM, no storage)
- `java script/script.js` - all the logic, including the data file layer
- `invoisy-data.json` - your data (created by you in Settings, not in Git)

# Simple Invoice

A small invoice and point-of-sale app that runs in the browser. Add products, sell them, watch the invoice update live, then print it or save it as a PDF.

## Run it

Open `index.html` in a browser. No installation, no backend.

(Optional) To use a tiny local server instead: `python3 -m http.server`, then open http://localhost:8000.

## Where data is stored

Everything is saved in your browser's `localStorage` (keys: `products`, `invoices`, `settings`, `invoiceCounter`). Data stays on this computer and in this browser, and survives refreshes. Clearing the browser's site data erases it.

## Add products

1. Go to **Stock**.
2. Fill in the form (name, selling price and stock are the essentials) and click **Add Product**.
3. To add stock to an existing product, use **Add Stock**. Use `-` / `+` in the table for quick changes, or **Edit** / **Delete**.

New here? **Settings → Load Demo Data** adds a few sample products.

## Create an invoice

1. Go to **Sell**. Type in the search box (name, SKU or category), press Enter, type a quantity, press Enter.
2. Adjust quantities or unit prices in **Current sale**. Optionally add customer details, a discount and tax (each as an amount or a %).
3. The invoice on the right updates as you type.
4. Click **Complete Sale**. The invoice gets the next number (INV-000001, INV-000002, ...), is saved, and the stock goes down. Stock is only reduced at this step, never while you are building the sale.

Past invoices are in **Invoices** (View, Print, Delete). Deleting an invoice does not put items back in stock.

## Print / save as PDF

Click **Print / PDF** next to the invoice (or **Print** in the Invoices list). In the browser's print dialog choose your printer, or **Save as PDF**. Only the invoice is printed, on A4.

## Change business details or currency

**Settings** holds the business name, address, phone, email and currency (default `DA`). New invoices use the current values; saved invoices keep the ones they were created with. The default currency is also the `CURRENCY` constant at the top of `script.js`.

## Files

- `index.html` - page structure
- `style.css` - styles, including the print rules
- `script.js` - all the logic

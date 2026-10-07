# Invoisy

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

**Settings** holds the business name, address, phone, email, currency (default `DA`), the invoice paper size (A4 or A5, default A4) and the store logo (**Choose Logo** / **Remove Logo**, PNG only). The logo is saved in the browser and shown above the business name on every invoice. New invoices use the current values; saved invoices keep the ones they were created with. The default currency is also the `CURRENCY` constant at the top of `script.js`.

## Files

- `index.html` - page structure
- `style.css` - styles, including the print rules
- `script.js` - all the logic

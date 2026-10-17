"""Real-browser check of partial delivery (file://, disposable profile): a paid invoice whose goods are collected later.

Optional and manual, like browser_check.py:   python3 tests/e2e/partial_delivery_check.py
Walks the example of the feature: 15 boxes sold and paid, 10 in the warehouse, 5 collected later.
"""
import os, sys
from pathlib import Path
from playwright.sync_api import sync_playwright
from e2e_common import SKIP_SALE_DIALOG

URL = os.environ.get("INVOISY_URL") or (Path(__file__).resolve().parents[2] / "index.html").as_uri()
problems = []

def check(cond, label):
    print(("PASS " if cond else "FAIL ") + label)
    if not cond:
        problems.append(label)

def go(page, view):
    page.click(f'.nav-btn[data-view="{view}"]')

def stock_text(page):
    return page.inner_text("#stockBody tr").replace("\n", " ")

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_context().new_page()
    page.add_init_script(SKIP_SALE_DIALOG)
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append("PAGEERROR " + str(e)))
    page.on("dialog", lambda d: d.accept())
    page.goto(URL)
    go(page, "settings")
    page.wait_for_function("document.getElementById('dataState').textContent === 'Ready'", timeout=10000)

    # Product: 1,000 DA per box, 10 boxes in stock
    go(page, "stock")
    page.fill("#pName", "Golden Era")
    page.locator("#priceRows input[data-field='price']").first.fill("1000")
    page.locator("#priceRows select[data-field='unit']").first.select_option("box")
    page.fill("#pStock", "10")
    page.click("#productSubmit")
    page.wait_for_selector("#stockBody tr")

    # Sell 15 boxes: refused beyond the stock, with a pointer to the partial option
    go(page, "sell")
    page.fill("#search", "Golden")
    page.wait_for_selector("#results .result")
    page.click("#results .result")
    page.fill("#addQty", "15")
    page.click('#addForm button[type="submit"]')
    check("Deliver only part now" in page.inner_text("#addError"), "15 boxes with 10 in stock is refused and points at the partial option: " + page.inner_text("#addError")[:80])

    page.fill("#addQty", "10")
    page.click('#addForm button[type="submit"]')
    row = page.locator("#saleBody tr[data-id]").first
    row.locator("input[data-field='partial']").check()
    check(page.locator("#saleBody input[data-field='deliver']").count() == 1, "'Deliver now' control appears when the line is marked partial")
    page.locator("#saleBody input[data-field='qty']").fill("15")
    check(page.locator("#saleBody input[data-field='deliver']").input_value() == "10", "deliver now follows the stock: 10")
    check("5 Boxes to collect later" in page.inner_text("#saleBody"), "line says 5 Boxes to collect later")
    preview = page.inner_text("#invoice")
    check("Delivered 10 Boxes" in preview and "To collect 5 Boxes" in preview and "15,000 DA" in preview, "live invoice shows 15 boxes, 15,000 DA, delivered 10 / to collect 5")

    page.fill("#amountPaid", "15000")
    page.click("#completeSale")
    page.wait_for_function("document.getElementById('toast').textContent.includes('INV-000001')", timeout=10000)
    go(page, "stock")
    check(page.locator("#stockBody tr td").nth(3).inner_text().strip().startswith("0"), "only the 10 delivered boxes left stock (0 left): " + stock_text(page))

    # Invoices list: paid AND awaiting collection, two separate statuses
    go(page, "invoices")
    rows = page.inner_text("#invoiceBody")
    check("Paid" in rows and "To collect" in rows, "list shows Paid and To collect as separate statuses: " + rows.replace("\n", " ")[:140])
    check(page.locator('#invoiceBody [data-action="delete"]').count() == 1, "delete button is there (the app explains the refusal)")
    page.click('#invoiceBody [data-action="delete"]')
    check(page.locator("#invoiceBody tr").count() == 1, "an invoice with delivery records is not deleted")

    # Collect: nothing in stock -> refused, nothing recorded
    page.click('#invoiceBody [data-action="collect"]')
    page.wait_for_selector("#deliveryBox:not([hidden])")
    check(page.is_visible("[data-collect-qty]"), "collection box lists the line to collect")
    page.fill("[data-collect-qty]", "2")
    page.click("#collectBtn")
    check("not enough stock" in page.inner_text("#collectError").lower(), "collecting with an empty warehouse is refused: " + page.inner_text("#collectError")[:80])

    # Restock 3, over-delivery and over-stock are refused, then collect 3
    go(page, "stock")
    page.select_option("#rProduct", index=0)
    page.fill("#rQty", "3")
    page.click('#restockForm button[type="submit"]')
    go(page, "invoices")
    page.click('#invoiceBody [data-action="collect"]')
    page.fill("[data-collect-qty]", "6")
    page.click("#collectBtn")
    check("only 5 Boxes left to collect" in page.inner_text("#collectError"), "more than what is left is refused: " + page.inner_text("#collectError")[:80])
    page.fill("[data-collect-qty]", "5")
    page.click("#collectBtn")
    check("not enough stock" in page.inner_text("#collectError").lower(), "5 with only 3 in stock is refused (stock can not go negative)")
    page.fill("[data-collect-qty]", "3")
    page.fill("#collectNote", "collected by Ali")
    page.click("#collectBtn")
    page.wait_for_function("document.getElementById('toast').textContent.includes('COL-000001-1')", timeout=10000)
    panel = page.inner_text(".preview-panel")
    check("To collect 2 Boxes" in panel and "collected by Ali" in panel and "COL-000001-1" in panel, "outstanding quantity is now 2 and the pick-up is in the history")
    check("15,000 DA" in panel and "PAID" in panel, "invoice total and PAID status are untouched")

    # The collection document: remaining only, linked, no amounts
    page.evaluate("window.print = () => {}")
    page.click("#collectPrint")
    doc = page.evaluate("document.getElementById('collectionPrint').innerText")
    check("REMAINING-QUANTITY COLLECTION DOCUMENT" in doc and "INV-000001" in doc and "COL-000001" in doc, "collection document is identified and linked to the invoice")
    check("2 Boxes" in doc and "DA" not in doc.replace("DATE", "").replace("Date", ""), "it lists the 2 remaining boxes and shows no amounts")
    check(page.evaluate("getComputedStyle(document.getElementById('collectionPrint')).display") == "none", "hidden on screen")
    page.emulate_media(media="print")
    page.evaluate("document.body.dataset.printing = 'collection'")
    shown = page.evaluate("[getComputedStyle(document.getElementById('collectionPrint')).display, getComputedStyle(document.querySelector('.preview-panel')).display]")
    check(shown == ["block", "none"], "when printing, only the collection document is shown: " + str(shown))
    page.evaluate("delete document.body.dataset.printing")
    page.emulate_media(media="screen")

    page.screenshot(path=os.environ.get("INVOISY_SHOT", "/tmp/invoisy-partial.png"), full_page=True)

    # Finish: restock and collect the last 2
    go(page, "stock")
    page.fill("#rQty", "2")
    page.click('#restockForm button[type="submit"]')
    go(page, "invoices")
    page.click('#invoiceBody [data-action="collect"]')
    page.click("#collectAll")
    check(page.input_value("[data-collect-qty]") == "2", "'Fill all remaining' fills the remaining quantity")
    page.click("#collectBtn")
    page.wait_for_function("document.getElementById('toast').textContent.includes('COL-000001-2')", timeout=10000)
    check(page.is_disabled("#collectBtn") and page.is_disabled("#collectPrint"), "nothing left to collect: record and print are disabled")
    check("DELIVERED IN FULL" in page.inner_text("#invoice"), "invoice shows DELIVERED IN FULL")
    go(page, "invoices")
    check("Delivered" in page.inner_text("#invoiceBody") and page.locator('#invoiceBody [data-action="collect"]').count() == 0, "list shows Delivered and no Collect button")

    # Phone width: no horizontal scroll
    go(page, "sell")
    page.set_viewport_size({"width": 390, "height": 800})
    check(page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), "no horizontal scroll at phone width")

    check(not errors, "no console errors: " + "; ".join(errors)[:200])
    browser.close()

print("\n%d problem(s)" % len(problems))
sys.exit(1 if problems else 0)

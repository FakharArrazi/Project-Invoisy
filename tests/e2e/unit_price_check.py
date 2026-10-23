"""Real-browser check of the Current Sale unit price and the one-sale price override.

Optional and manual (NOT part of `npm test`; needs a browser):
    pip install playwright && playwright install chromium
    python3 tests/e2e/unit_price_check.py
Brand new browser profile and disposable IndexedDB: no real business data is touched.
"""
import os, sys
from pathlib import Path
from playwright.sync_api import sync_playwright
from e2e_common import SKIP_SALE_DIALOG, wait_invoice_shown

URL = os.environ.get("INVOISY_URL") or (Path(__file__).resolve().parents[2] / "index.html").as_uri()
problems = []

def check(cond, label):
    print(("PASS " if cond else "FAIL ") + label)
    if not cond:
        problems.append(label)

def text(page, sel):
    return page.inner_text(sel).strip()

def add_line(page, qty, unit):
    page.fill("#search", "Tile")
    page.wait_for_selector("#results .result")
    page.click("#results .result")
    page.fill("#addQty", qty)
    page.select_option("#addUnit", unit)
    page.click('#addForm button[type="submit"]')

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_context().new_page()
    page.add_init_script(SKIP_SALE_DIALOG)
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append("PAGEERROR " + str(e)))
    page.on("dialog", lambda d: d.accept())
    page.goto(URL)
    page.click('.nav-btn[data-view="settings"]')
    page.wait_for_function("document.getElementById('dataState').textContent === 'Ready'", timeout=10000)

    page.click('.nav-btn[data-view="stock"]')
    page.fill("#pName", "Tile A"); page.fill("#pTileSize", "60*60"); page.fill("#pCoveragePerBox", "1.44")
    page.locator("#priceRows input[data-field='price']").first.fill("1000"); page.locator("#priceRows select[data-field='unit']").first.select_option("m2"); page.fill("#pStock", "20")
    page.click("#productSubmit")
    page.wait_for_selector("#stockBody tr")

    page.click('.nav-btn[data-view="sell"]')
    # Tile A is counted in boxes, so an area typed in m² takes whole boxes from stock (10 / 1.44 = 6.94 -> 7) and is billed as typed
    add_line(page, "10", "m2")
    row = "#saleBody tr[data-id]"
    check(page.input_value(f"{row} .qty-input") == "7" and page.input_value(f"{row} .unit-select") == "box", "10 m² became 7 boxes on the sale")
    check("7 boxes" in text(page, "#toast"), "the person is told: " + text(page, "#toast"))
    check(page.input_value(f"{row} .price-input") == "1000", "the price stays the saved 1,000 DA/m²")
    check(text(page, f"{row} [data-price-unit]") == "DA/m²", "price-unit label reads DA/m²")
    check("Billed: 10 m²" in text(page, f"{row} [data-qty-note]"), "the quantity note says what is billed: " + text(page, f"{row} [data-qty-note]"))
    check(text(page, "#tTotal").startswith("10,000"), "total 10,000 DA: the 10 m² typed at 1,000 DA/m² (7 boxes leave the stock)")
    inv = text(page, "#invoice")
    check("7 Boxes" in inv and "10,000" in inv, "live invoice shows 7 Boxes and the total 10,000")
    check(page.locator(f"{row} .unit-select option[value='m2']").is_disabled(), "a box line can't be switched to m²")

    page.fill("#discountValue", "10"); page.select_option("#discountType", "percent")
    page.fill(f"{row} .price-input", "900")
    check(text(page, f"{row} [data-line-total]").startswith("9,000"), "line total follows the typed price: 10 m² x 900 = 9,000")
    check(text(page, "#tSubtotal").startswith("9,000") and text(page, "#tTotal").startswith("8,100"), "subtotal 9,000 and total 8,100 after 10% discount")

    page.fill(f"{row} .price-input", "-5")
    check(text(page, f"{row} [data-row-error]") != "", "negative price is rejected with a message")
    check(text(page, "#tSubtotal").startswith("9,000"), "totals keep the last valid price")
    page.fill(f"{row} .price-input", "900")

    page.select_option(f"{row} .unit-select", "piece")
    check(page.input_value(f"{row} .price-input") == "900" and text(page, f"{row} [data-price-unit]") == "DA/m²", "unit change keeps the price per m²: 900 DA/m²")
    page.select_option(f"{row} .unit-select", "box")
    check(page.input_value(f"{row} .price-input") == "900", "back to box: still 900 DA/m²")

    page.fill(f"{row} .price-input", "1300")
    page.fill("#amountPaid", "0")
    page.click("#completeSale")
    wait_invoice_shown(page, "INV-000001")
    check(True, "sale with the special price saved as INV-000001")

    page.click('.nav-btn[data-view="stock"]')
    check("1,000" in text(page, "#stockBody"), "Stock still shows the saved price 1,000 / m²")
    page.click('.nav-btn[data-view="sell"]')
    add_line(page, "10", "box")
    check(page.input_value(f"{row} .price-input") == "1000", "a new sale starts at the saved price again")

    page.click('.nav-btn[data-view="invoices"]')
    page.click("#invoiceBody tr >> text=View")
    saved = text(page, "#invoice")
    check("13,104" in saved and "1,872" in saved and "/ Box" in saved, "saved invoice shows the total charged: 7 boxes = 10.08 m² x 1,300 = 13,104 (the unit was changed on the line, so the 10 m² typed no longer applies)")
    check(not errors, "no console or page errors: " + "; ".join(errors))
    browser.close()

print("\nALL PASSED" if not problems else "\nFAILED: " + "; ".join(problems))
sys.exit(1 if problems else 0)

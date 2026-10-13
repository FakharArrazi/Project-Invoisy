"""Real-browser check of the Current Sale unit price and the one-sale price override.

Optional and manual (NOT part of `npm test`; needs a browser):
    pip install playwright && playwright install chromium
    python3 tests/e2e/unit_price_check.py
Brand new browser profile and disposable IndexedDB: no real business data is touched.
"""
import os, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

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
    # Tile A is counted in boxes, so an area typed in m² is supplied in whole boxes: 10 / 1.44 = 6.94 -> 7 boxes
    add_line(page, "10", "m2")
    row = "#saleBody tr[data-id]"
    check(page.input_value(f"{row} .qty-input") == "7" and page.input_value(f"{row} .unit-select") == "box", "10 m² became 7 boxes on the sale")
    check("7 boxes" in text(page, "#toast"), "the person is told: " + text(page, "#toast"))
    check(page.input_value(f"{row} .price-input") == "1440", "box price is worked out from the saved 1,000 DA/m²: 1440")
    check(text(page, f"{row} [data-price-unit]") == "DA/box", "price-unit label reads DA/box")
    check(text(page, "#tTotal").startswith("10,080"), "total 10,080 DA for 7 boxes = 10.08 m² at 1,000 DA/m²")
    inv = text(page, "#invoice")
    check("7 Boxes" in inv and "10.08 m²" in inv and "1,000" in inv and "/ m²" in inv and "10 m²" not in inv, "live invoice shows 7 Boxes, 10.08 m² and the price 1,000 / m²")
    check(page.locator(f"{row} .unit-select option[value='m2']").is_disabled(), "a box line can't be switched to m²")

    page.fill("#discountValue", "10"); page.select_option("#discountType", "percent")
    page.fill(f"{row} .price-input", "900")
    check(text(page, f"{row} [data-line-total]").startswith("6,300"), "line total follows the typed price: 7 x 900 = 6,300")
    check(text(page, "#tSubtotal").startswith("6,300") and text(page, "#tTotal").startswith("5,670"), "subtotal 6,300 and total 5,670 after 10% discount")
    inv = text(page, "#invoice")
    check("900" in inv and "/ Box" in inv and "1,000" not in inv, "live invoice shows 900 / Box and not the catalogue price")

    page.fill(f"{row} .price-input", "-5")
    check(text(page, f"{row} [data-row-error]") != "", "negative price is rejected with a message")
    check(text(page, "#tSubtotal").startswith("6,300"), "totals keep the last valid price")
    page.fill(f"{row} .price-input", "900")

    page.select_option(f"{row} .unit-select", "piece")
    check(page.input_value(f"{row} .price-input") == "360" and text(page, f"{row} [data-price-unit]") == "DA/piece", "unit change selects the piece price: 360 DA/piece")
    page.select_option(f"{row} .unit-select", "box")
    check(page.input_value(f"{row} .price-input") == "1440", "unit change selects the box price: 1440")
    check(text(page, f"{row} [data-price-unit]") == "DA/box", "label follows the unit: DA/box")

    page.fill(f"{row} .price-input", "1300")
    page.fill("#amountPaid", "0")
    page.click("#completeSale")
    page.wait_for_function("document.getElementById('toast').textContent.includes('INV-000001')", timeout=10000)
    check(True, "sale with the special price saved as INV-000001")

    page.click('.nav-btn[data-view="stock"]')
    check("1,000" in text(page, "#stockBody"), "Stock still shows the saved price 1,000 / m²")
    page.click('.nav-btn[data-view="sell"]')
    add_line(page, "10", "box")
    check(page.input_value(f"{row} .price-input") == "1440", "a new sale starts at the saved price again")

    page.click('.nav-btn[data-view="invoices"]')
    page.click("#invoiceBody tr >> text=View")
    saved = text(page, "#invoice")
    check("1,300" in saved and "/ Box" in saved and "1,440" not in saved, "saved invoice shows the charged 1,300 / Box")
    check(not errors, "no console or page errors: " + "; ".join(errors))
    browser.close()

print("\nALL PASSED" if not problems else "\nFAILED: " + "; ".join(problems))
sys.exit(1 if problems else 0)

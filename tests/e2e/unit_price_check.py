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
    page.fill("#pPrice", "1000"); page.select_option("#pPriceUnit", "m2"); page.fill("#pStock", "20")
    page.click("#productSubmit")
    page.wait_for_selector("#stockBody tr")

    page.click('.nav-btn[data-view="sell"]')
    add_line(page, "10", "m2")
    row = "#saleBody tr[data-id]"
    check(page.input_value(f"{row} .price-input") == "1000", "default price is the saved price: 1000")
    check(text(page, f"{row} [data-price-unit]") == "DA/m²", "price-unit label reads DA/m²")
    check(text(page, "#tTotal").startswith("10,000"), "total 10,000 DA for 10 m² at 1,000 DA/m²")

    page.fill("#discountValue", "10"); page.select_option("#discountType", "percent")
    page.fill(f"{row} .price-input", "900")
    check(text(page, f"{row} [data-line-total]").startswith("9,000"), "line total follows the typed price: 9,000")
    check(text(page, "#tSubtotal").startswith("9,000") and text(page, "#tTotal").startswith("8,100"), "subtotal 9,000 and total 8,100 after 10% discount")
    inv = text(page, "#invoice")
    check("900" in inv and "/ m²" in inv and "1,000" not in inv, "live invoice shows 900 / m² and not the catalogue price")

    page.fill(f"{row} .price-input", "-5")
    check(text(page, f"{row} [data-row-error]") != "", "negative price is rejected with a message")
    check(text(page, "#tSubtotal").startswith("9,000"), "totals keep the last valid price")
    page.fill(f"{row} .price-input", "900")

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

"""Real-browser check of the small improvements (phones, sale dialog, invoice edit, history filters, stock suggestions).

Optional and manual, like the other checks here (not part of `npm test`):
    python3 tests/e2e/minor_improvements_check.py
Uses a brand new browser profile and a disposable IndexedDB.
"""
import os, sys
from pathlib import Path
from playwright.sync_api import sync_playwright
from e2e_common import wait_idle

URL = os.environ.get("INVOISY_URL") or (Path(__file__).resolve().parents[2] / "index.html").as_uri()
problems = []

def check(cond, label):
    print(("PASS " if cond else "FAIL ") + label)
    if not cond:
        problems.append(label)

def go(page, view):
    page.click(f'.nav-btn[data-view="{view}"]')

def text(page, sel):
    return page.inner_text(sel).strip()

def sell(page, qty, name, paid=""):
    go(page, "sell")
    page.fill("#search", "Tile")
    page.wait_for_selector("#results .result")
    page.click("#results .result")
    page.fill("#addQty", str(qty))
    page.select_option("#addUnit", "box")
    page.click('#addForm button[type="submit"]')
    page.fill("#custName", name)
    page.keyboard.press("Tab")
    if paid:
        page.fill("#amountPaid", paid)
    page.click("#completeSale")
    page.wait_for_selector("#saleDoneDialog[open]", timeout=10000)

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context()
    page = ctx.new_page()
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append("PAGEERROR " + str(e)))
    answer = {"accept": True, "seen": []}
    def on_dialog(d):
        answer["seen"].append(d.message)
        d.accept() if answer["accept"] else d.dismiss()
    page.on("dialog", on_dialog)
    page.add_init_script("window.__prints = 0; window.print = () => { window.__prints++; };")

    page.goto(URL)
    go(page, "settings")
    page.wait_for_function("document.getElementById('dataState').textContent === 'Ready'", timeout=10000)

    # --- 1. several business phone numbers
    page.fill("#sName", "Tile House")
    page.locator("#sPhones input").first.fill("0550 11 22 33")
    page.click("#addPhone")
    page.locator("#sPhones input").nth(1).fill("0661 44 55 66")
    check(page.locator("#sPhones input").count() == 2, "Add phone number adds a second box")
    page.click('#settingsForm button[type="submit"]') if page.locator("#settingsForm").count() else page.keyboard.press("Enter")
    wait_idle(page)
    page.reload()
    go(page, "settings")
    page.wait_for_function("document.getElementById('dataState').textContent === 'Ready'", timeout=10000)
    check(page.locator("#sPhones input").count() == 2 and page.locator("#sPhones input").nth(1).input_value() == "0661 44 55 66", "both numbers are there after a reload")

    # --- stock: a product, then suggestions
    go(page, "stock")
    page.fill("#pName", "Tile A")
    page.fill("#pTileSize", "60*60")
    page.fill("#pCoveragePerBox", "1.44")
    page.locator("#priceRows input[data-field='price']").first.fill("800")
    page.locator("#priceRows select[data-field='unit']").first.select_option("m2")
    page.fill("#pStock", "10")
    page.click("#productSubmit")
    page.wait_for_selector("#stockBody tr")
    page.fill("#pName", "tile-a")
    check("Tile A" in text(page, "#productSimilar") and page.locator("#productSimilar [data-similar='view']").count() == 1, "typing 'tile-a' suggests Tile A")
    page.fill("#pName", "Brand New Thing")
    check("No similar products found" in text(page, "#productSimilar"), "no match says 'No similar products found'")
    page.fill("#pName", "")
    check(page.is_hidden("#productSimilar"), "box hidden when the name is empty")

    # --- 3. the sale dialog; Enter prints once
    sell(page, 2, "Alex Ait", "500")
    check(page.evaluate("document.activeElement.id") == "saleDonePrint", "Print Invoice has the focus")
    check("INV-000001" in text(page, "#saleDoneDialog"), "the dialog names INV-000001")
    page.keyboard.press("Enter")
    page.keyboard.press("Enter")
    page.wait_for_function("!document.getElementById('saleDoneDialog').open")
    check(page.evaluate("window.__prints") == 1, "Enter printed exactly once")
    go(page, "invoices")
    check(page.locator("#invoiceBody tr").count() == 1, "still one invoice")

    # --- 4. edit the invoice (on the Sell page)
    page.click('#invoiceBody button[data-action="edit"]')
    page.wait_for_selector("#editBanner:not([hidden])")
    check(page.is_visible("#view-sell"), "Edit opens the Sell page")
    page.locator("#saleBody input[data-field='qty']").fill("3")
    page.locator("#saleBody input[data-field='qty']").dispatch_event("input")
    page.fill("#custName", "Alexandre Ait")
    page.locator("#custName").dispatch_event("input")
    check("INV-000001" in text(page, "#invoice"), "the preview keeps the invoice number")
    check("Alexandre" in text(page, "#invoice"), "the preview shows the typed customer")
    page.click("#editSave")
    page.wait_for_selector("#editBanner", state="hidden", timeout=10000)
    go(page, "invoices")
    row = text(page, "#invoiceBody tr")
    check("Alexandre" in row and "INV-000001" in row and "3,456" in row, "invoice edited in place: " + row.replace("\n", " ")[:100])
    go(page, "stock")
    check(text(page, "#stockBody tr td:nth-child(4)").startswith("7"), "stock is 7 (10 - 3)")

    # unsaved changes warning
    go(page, "invoices")
    page.click('#invoiceBody button[data-action="edit"]')
    page.wait_for_selector("#editBanner:not([hidden])")
    page.fill("#custName", "Changed")
    page.locator("#custName").dispatch_event("input")
    answer["accept"] = False
    answer["seen"].clear()
    page.click("#editCancel")
    check(len(answer["seen"]) == 1 and page.is_visible("#editBanner") and page.input_value("#custName") == "Changed", "cancelling with changes asks, and Cancel keeps the screen and the typed text")
    answer["accept"] = True
    page.click("#editCancel")
    page.wait_for_selector("#editBanner", state="hidden")
    go(page, "invoices")
    check(text(page, "#invoiceBody tr").count("Changed") == 0, "leaving discarded the typed change")

    # a price cut below payments is allowed: the difference is shown as a refund due, never as a payment
    page.click('#invoiceBody button[data-action="edit"]')
    page.wait_for_selector("#editBanner:not([hidden])")
    page.locator("#saleBody input[data-field='price']").fill("10")
    page.locator("#saleBody input[data-field='price']").dispatch_event("input")
    check(page.is_enabled("#editSave") and "Refund" in text(page, "#tEditRows"), "a price that leaves payments above the total shows the refund due and can be saved")
    page.click("#editCancel")
    page.wait_for_selector("#editBanner", state="hidden")
    answer["accept"] = True

    # --- 6. history
    sell(page, 1, "Bob Dahmani")
    page.keyboard.press("Escape")
    go(page, "invoices")
    check(page.locator("#invoiceBody tr").count() == 2, "two invoices")
    page.select_option("#invoicePayFilter", "unpaid")
    check(page.locator("#invoiceBody tr").count() == 1 and "Bob" in text(page, "#invoiceBody"), "Unpaid filter keeps Bob")
    page.click("#invoiceClear")
    page.fill("#invoiceFilter", "alex")
    check(page.locator("#invoiceBody tr").count() == 1 and "Alexandre" in text(page, "#invoiceBody"), "search by customer name")
    page.fill("#invoiceFilter", "")
    page.click('th[data-sort-th="number"] button')
    check(text(page, "#invoiceBody tr").startswith("INV-000001"), "sorted ascending by number")
    page.click('th[data-sort-th="number"] button')
    check(text(page, "#invoiceBody tr").startswith("INV-000002"), "sorted descending by number")
    check(page.get_attribute('th[data-sort-th="number"]', "aria-sort") == "descending", "header shows the sort direction")

    check(not [e for e in errors if "favicon" not in e], "no console errors: " + "; ".join(errors)[:200])
    browser.close()

print()
print("FAILED: " + "; ".join(problems) if problems else "ALL CHECKS PASSED")
sys.exit(1 if problems else 0)

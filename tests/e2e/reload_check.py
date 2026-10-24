"""Real-browser check: a reload that Invoisy did not ask for (a live-reload development server watching the folder
that holds invoisy-data.json, for example) must not cost the person the Print dialog or what they typed.

Optional and manual, like the other checks here (it needs a browser, so it is not part of `npm test`):
    pip install playwright && playwright install chromium
    python3 tests/e2e/reload_check.py
It opens index.html straight from disk in a brand new browser profile, so no real business data is touched.
"""
import os, sys
from pathlib import Path
from playwright.sync_api import sync_playwright
from e2e_common import open_product_form

URL = os.environ.get("INVOISY_URL") or (Path(__file__).resolve().parents[2] / "index.html").as_uri()
problems = []

def check(cond, label):
    print(("PASS " if cond else "FAIL ") + label)
    if not cond:
        problems.append(label)

def go(page, view):
    page.click(f'.nav-btn[data-view="{view}"]')

def ready(page):
    page.wait_for_function("document.getElementById('dataState') && document.getElementById('dataState').textContent === 'Ready'", timeout=10000)

def outside_reload(page, seen):
    """What a development server does: location.reload() from script, with nobody pressing F5."""
    seen.clear()
    page.evaluate("setTimeout(() => location.reload(), 0)")
    page.wait_for_timeout(1500)

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_context().new_page()
    errors, seen = [], []
    page.on("pageerror", lambda e: errors.append(str(e)))
    cancel_prompt = [True]
    def on_dialog(d):
        seen.append(d.type)
        if d.type == "beforeunload" and cancel_prompt[0]:
            d.dismiss()
        else:
            d.accept()
    page.on("dialog", on_dialog)
    page.add_init_script("window.__prints = 0; window.print = () => { window.__prints++; };")

    page.goto(URL)
    go(page, "settings"); ready(page)

    # --- a product, then a sale: Save Invoice opens the dialog
    go(page, "stock")
    open_product_form(page)
    page.fill("#pName", "Tile A"); page.fill("#pTileSize", "60*60"); page.fill("#pCoveragePerBox", "1.44")
    page.locator("#priceRows input[data-field='price']").first.fill("800")
    page.locator("#priceRows select[data-field='unit']").first.select_option("m2")
    page.fill("#pStock", "10")
    page.click("#productSubmit")
    page.wait_for_selector("#stockBody tr")
    check("Tile A" in page.inner_text("#stockBody"), "product saved and listed")

    go(page, "sell")
    page.fill("#search", "Tile"); page.wait_for_selector("#results .result"); page.click("#results .result")
    page.fill("#addQty", "2"); page.select_option("#addUnit", "box")
    page.click('#addForm button[type="submit"]')
    page.fill("#amountPaid", "1000")
    page.click("#completeSale")
    page.wait_for_selector("#saleDoneDialog[open]", timeout=8000)
    check(True, "Save Invoice opens the Sale completed dialog")

    # --- the page is reloaded behind the person's back while the dialog is waiting
    outside_reload(page, seen)
    ready(page)
    page.wait_for_selector("#saleDoneDialog[open]", timeout=8000)
    check("INV-000001" in page.inner_text("#saleDoneNumber"), "after the reload the dialog is open again for the saved invoice")
    check("reloaded right after your data was saved" not in page.inner_text("#toast"), "no reload message is shown")

    page.click("#saleDonePrint")
    page.wait_for_timeout(300)
    check(page.evaluate("window.__prints") == 1, "Print Invoice prints (once)")
    check(not page.evaluate("document.getElementById('saleDoneDialog').open"), "the dialog closes after printing")

    # --- reloading again does not bring an answered dialog back, and nothing was duplicated
    outside_reload(page, seen)
    ready(page)
    page.wait_for_timeout(300)
    check(not page.evaluate("document.getElementById('saleDoneDialog').open"), "an answered dialog is not asked again after another reload")
    go(page, "invoices")
    check(page.locator("#invoiceBody tr").count() == 1, "exactly one invoice is saved")
    go(page, "stock")
    check(page.inner_text("#stockBody tr td:nth-child(6)").strip().startswith("8"), "stock was deducted once (10 - 2 = 8)")

    # --- typed work: an outside reload asks first, and Cancel keeps everything
    page.evaluate("window.__marker = 'alive'")
    outside_reload(page, seen)
    check("beforeunload" not in seen, "nothing typed: an outside reload is not interrupted")
    ready(page)
    go(page, "stock")
    page.evaluate("window.__marker = 'alive'")
    open_product_form(page)
    page.type("#pName", "Typed by hand", delay=15)
    page.fill("#pStock", "7")
    outside_reload(page, seen)
    check("beforeunload" in seen, "a product being typed: the browser asks before reloading")
    check(page.evaluate("window.__marker") == "alive", "after Cancel it is the same page, not reloaded")
    check(page.input_value("#pName") == "Typed by hand" and page.input_value("#pStock") == "7", "the typed values are still in the fields")

    check(not errors, "no JavaScript errors" + ("" if not errors else ": " + "; ".join(errors)))
    browser.close()

print()
print("%d problem(s)" % len(problems))
sys.exit(1 if problems else 0)

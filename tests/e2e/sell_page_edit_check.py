"""Real-browser check: editing a saved invoice on the Sell page, and cancelling a sale with a refund.

Optional and manual, like the other checks here (not part of `npm test`):
    python3 tests/e2e/sell_page_edit_check.py
Uses a brand new browser profile and a disposable IndexedDB. Writes screenshots next to the script's temp folder when
INVOISY_SHOTS is set to a folder.
"""
import os, sys, re
from pathlib import Path
from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
from e2e_common import SKIP_SALE_DIALOG

URL = os.environ.get("INVOISY_URL") or (Path(__file__).resolve().parents[2] / "index.html").as_uri()
SHOTS = os.environ.get("INVOISY_SHOTS")
problems = []


def check(cond, label):
    print(("PASS " if cond else "FAIL ") + label)
    if not cond:
        problems.append(label)


def go(page, view):
    page.click(f'.nav-btn[data-view="{view}"]')


def text(page, sel):
    return page.inner_text(sel).strip()


def digits(s):
    return re.sub(r"\D", "", s)


def shot(page, name):
    if SHOTS:
        Path(SHOTS).mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(Path(SHOTS) / (name + ".png")), full_page=True)


def add_product(page, name, price, unit, stock, size="60*60", coverage="1.44"):
    go(page, "stock")
    page.fill("#pName", name)
    page.fill("#pTileSize", size)
    page.fill("#pCoveragePerBox", coverage)
    page.locator("#priceRows input[data-field='price']").first.fill(str(price))
    page.locator("#priceRows select[data-field='unit']").first.select_option(unit)
    page.fill("#pStock", str(stock))
    page.click("#productSubmit")
    page.wait_for_function(f"document.getElementById('stockBody').innerText.includes({name!r})")


def add_to_sale(page, query, qty, unit="box"):
    page.fill("#search", query)
    page.wait_for_selector("#results .result")
    page.click("#results .result")
    page.fill("#addQty", str(qty))
    page.select_option("#addUnit", unit)
    page.click('#addForm button[type="submit"]')


def sell(page, query, qty, name, paid="", unit="box"):
    go(page, "sell")
    add_to_sale(page, query, qty, unit)
    page.fill("#custName", name)
    page.keyboard.press("Tab")
    if paid:
        page.fill("#amountPaid", paid)
    page.click("#completeSale")
    page.wait_for_function("document.getElementById('invoiceBody') !== null")
    page.wait_for_timeout(300)


def stock_text(page, name):
    go(page, "stock")
    row = page.locator("#stockBody tr", has_text=name).first
    return row.inner_text()


with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1400, "height": 1000})
    page = ctx.new_page()
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append("PAGEERROR " + str(e)))
    dialogs = {"accept": True, "seen": []}

    def on_dialog(d):
        dialogs["seen"].append(d.message)
        d.accept() if dialogs["accept"] else d.dismiss()

    page.on("dialog", on_dialog)
    page.add_init_script("window.__prints = 0; window.print = () => { window.__prints++; };")
    page.add_init_script(SKIP_SALE_DIALOG)

    page.goto(URL)
    go(page, "settings")
    page.wait_for_function("document.getElementById('dataState').textContent === 'Ready'", timeout=10000)

    add_product(page, "Everton Grey", 2000, "box", 20)
    add_product(page, "Mosaic Piece", 300, "piece", 100, size="30*30", coverage="0.9")
    add_product(page, "Plank M2", 1000, "m2", 100)

    # --- a sale of 15 boxes, 20,000 paid of 30,000
    sell(page, "Everton", 15, "Alex Ait", paid="20000")
    go(page, "invoices")
    check(page.locator("#invoiceBody tr").count() == 1, "one invoice saved")
    check("5 " in stock_text(page, "Everton Grey") or "5" in stock_text(page, "Everton Grey"), "stock after the sale: " + stock_text(page, "Everton Grey").replace("\n", " ")[:60])

    # --- Edit opens the SELL page populated with the invoice
    go(page, "invoices")
    page.click('#invoiceBody button[data-action="edit"]')
    page.wait_for_selector("#view-sell:not([hidden])")
    check(page.is_visible("#editBanner") and "INV-000001" in text(page, "#editHeading"), "Edit opens the Sell page with an edit banner")
    check(page.input_value("#custName") == "Alex Ait", "the customer name is in the Sell page box")
    check(page.locator("#saleBody tr[data-id]").count() == 1, "the invoice's line is in the Sell page table")
    check(page.is_hidden("#completeSale") and page.is_visible("#editSave"), "Complete Sale is replaced by Save changes")
    check("Unsaved" in text(page, "#previewStatus") or "unsaved" in text(page, "#previewStatus").lower() or "preview" in text(page, "#previewStatus").lower(), "the preview is marked: " + text(page, "#previewStatus"))
    check("preview-unsaved" in (page.get_attribute("#previewStatus", "class") or ""), "preview panel has the unsaved style")
    shot(page, "1-edit-opened")

    # --- change the quantity: summary and preview follow live, nothing saved
    page.locator("#saleBody input[data-field='qty']").fill("10")
    page.locator("#saleBody input[data-field='qty']").dispatch_event("input")
    page.wait_for_timeout(200)
    check(digits(text(page, "#tTotal")) == "20000", "live total after 15 -> 10 boxes: " + text(page, "#tTotal"))
    check("20,000" in text(page, "#invoice") and "10" in text(page, "#invoice"), "the preview shows the new quantity and total")
    shot(page, "2-edit-live")
    go(page, "stock")  # leaving asks first
    check(len(dialogs["seen"]) >= 1, "leaving with unsaved changes asked first: " + (dialogs["seen"][-1][:60] if dialogs["seen"] else ""))
    check("Everton Grey" in text(page, "#stockBody"), "left after confirming")
    check("5" in stock_text(page, "Everton Grey"), "no stock was moved by the unsaved edit")

    # --- edit again and save: 10 boxes -> stock 10 (20-15 = 5, +5)
    go(page, "invoices")
    page.click('#invoiceBody button[data-action="edit"]')
    page.wait_for_selector("#editBanner:not([hidden])")
    page.locator("#saleBody input[data-field='qty']").fill("10")
    page.locator("#saleBody input[data-field='qty']").dispatch_event("input")
    page.fill("#custPhone", "0550 12 34 56")
    page.click("#editSave")
    page.wait_for_selector("#editBanner", state="hidden")
    go(page, "invoices")
    row = text(page, "#invoiceBody tr")
    check("INV-000001" in row and "20,000" in row and page.locator("#invoiceBody tr").count() == 1, "same invoice, number kept, new total: " + row.replace("\n", " ")[:90])
    check("10" in stock_text(page, "Everton Grey").replace("\n", " "), "stock after 15 -> 10: " + stock_text(page, "Everton Grey").replace("\n", " ")[:60])

    # --- the units on the Sell page and in the edit match the product configuration (piece / m² / box)
    sell(page, "Mosaic", 2, "Piece Customer", unit="box")
    sell(page, "Plank", 2, "M2 Customer", unit="box")
    go(page, "invoices")
    page.locator("#invoiceBody tr", has_text="Piece Customer").locator('button[data-action="edit"]').click()
    page.wait_for_selector("#editBanner:not([hidden])")
    check("piece" in text(page, "#saleBody").lower(), "per-piece product shows its price per piece in the edit: " + text(page, "#saleBody").replace("\n", " ")[:120])
    page.click("#editCancel")
    go(page, "invoices")
    page.locator("#invoiceBody tr", has_text="M2 Customer").locator('button[data-action="edit"]').click()
    page.wait_for_selector("#editBanner:not([hidden])")
    check("m²" in text(page, "#saleBody") or "m2" in text(page, "#saleBody").lower(), "per-m² product shows its price per m² in the edit: " + text(page, "#saleBody").replace("\n", " ")[:120])
    page.click("#editCancel")

    # --- complete cancellation of INV-000001: remove the only line
    go(page, "invoices")
    page.locator("#invoiceBody tr", has_text="INV-000001").locator('button[data-action="edit"]').click()
    page.wait_for_selector("#editBanner:not([hidden])")
    page.locator("#saleBody button[data-action='remove']").first.click() if page.locator("#saleBody button[data-action='remove']").count() else page.locator("#saleBody button").last.click()
    page.wait_for_timeout(200)
    check(page.locator("#saleBody tr[data-id]").count() == 0, "the line was removed from the edit")
    check("cancel" in text(page, "#editSave").lower(), "Save changes becomes the cancel-and-refund button: " + text(page, "#editSave"))
    check("Refund to record now" in text(page, "#tEditRows"), "the summary shows the refund to be recorded")
    shot(page, "3-cancel-ready")
    if SHOTS:
        page.locator("#view-sell .totals").screenshot(path=str(Path(SHOTS) / "3b-cancel-totals.png"))
    dialogs["accept"] = False
    before = len(dialogs["seen"])
    page.click("#editSave")
    page.wait_for_timeout(300)
    asked = dialogs["seen"][before:]
    check(len(asked) == 1 and asked[0].startswith("You are about to cancel this sale. All original sold quantities will be returned to stock, and the amount actually collected will be recorded as a refund. Continue?"), "the confirmation text is exact")
    check("INV-000001" in asked[0] and "20,000" in asked[0], "and names the invoice, the total and the refund: " + asked[0].replace("\n", " | ")[-120:])
    check(page.is_visible("#editBanner"), "declining leaves the edit open")
    go_stock_text = None
    dialogs["accept"] = True
    page.click("#editSave")
    page.wait_for_selector("#editBanner", state="hidden")
    shot(page, "4-cancelled-details")
    check("SALE CANCELLED" in text(page, "#invoice"), "the saved invoice shows SALE CANCELLED")
    check(page.is_visible("#payCancelRow"), "the pay box says it is cancelled")
    check(page.is_hidden("#refundForm"), "no refund form: the refund is already recorded")
    go(page, "invoices")
    row = text(page, '#invoiceBody tr:has-text("INV-000001")')
    check("Cancelled" in row and "refunded" in row.lower(), "the list labels it cancelled and refunded: " + row.replace("\n", " ")[:140])
    check(page.locator('#invoiceBody tr:has-text("INV-000001") button[data-action="edit"]').is_disabled(), "Edit is disabled on a cancelled invoice")
    shot(page, "5-list")
    check("20" in stock_text(page, "Everton Grey").replace("\n", " "), "all stock came back: " + stock_text(page, "Everton Grey").replace("\n", " ")[:60])

    # --- survives a reload
    page.reload()
    go(page, "invoices")
    page.wait_for_function("document.getElementById('dataState') === null || true")
    page.wait_for_selector("#invoiceBody tr")
    check("Cancelled" in text(page, '#invoiceBody tr:has-text("INV-000001")'), "still cancelled after a reload")

    # --- print markup of the cancelled invoice carries the banner
    page.locator('#invoiceBody tr:has-text("INV-000001") button[data-action="view"]').click()
    page.wait_for_selector("#invoice")
    check("SALE CANCELLED" in text(page, "#invoice") and "REFUND HISTORY" in text(page, "#invoice"), "details/print document shows banner and refund history")

    check(not [e for e in errors if "favicon" not in e], "no console errors: " + "; ".join(errors)[:300])
    browser.close()

print()
print("FAILED: " + "; ".join(problems) if problems else "ALL CHECKS PASSED")
sys.exit(1 if problems else 0)

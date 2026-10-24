"""Real-browser check of the outstanding-debt flow on the Sell page (file://, disposable profile).

Optional and manual, like browser_check.py:   python3 tests/e2e/debt_check.py
"""
import os, sys
from pathlib import Path
from playwright.sync_api import sync_playwright
from e2e_common import SKIP_SALE_DIALOG, wait_invoice_shown, open_product_form

URL = os.environ.get("INVOISY_URL") or (Path(__file__).resolve().parents[2] / "index.html").as_uri()
problems = []

def check(cond, label):
    print(("PASS " if cond else "FAIL ") + label)
    if not cond:
        problems.append(label)

def go(page, view):
    page.click(f'.nav-btn[data-view="{view}"]')

def add_item(page, qty):
    page.fill("#search", "Slab")
    page.wait_for_selector("#results .result")
    page.click("#results .result")
    page.fill("#addQty", str(qty))
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
    go(page, "settings")
    page.wait_for_function("document.getElementById('dataState').textContent === 'Ready'", timeout=10000)

    go(page, "stock")
    open_product_form(page)
    page.fill("#pName", "Slab")
    page.locator("#priceRows input[data-field='price']").first.fill("1000")
    page.locator("#priceRows select[data-field='unit']").first.select_option("piece")
    page.fill("#pStock", "50")
    page.click("#productSubmit")
    page.wait_for_selector("#stockBody tr")

    # INV-000001: Karim buys 3 pieces and pays 1000 -> 2000 unpaid
    go(page, "sell")
    add_item(page, 3)
    page.fill("#custName", "Karim Benali")
    page.fill("#custPhone", "0555 11 22 33")
    page.fill("#amountPaid", "1000")
    page.click("#completeSale")
    wait_invoice_shown(page, "INV-000001")

    # Typing shows nothing; leaving the field shows the card
    add_item(page, 2)
    page.fill("#custName", "Karim")
    check(page.is_hidden("#debtNotice"), "no notification while typing")
    check(page.is_visible("#custSuggest li"), "suggestion list is offered while typing")
    page.keyboard.press("ArrowDown")
    page.keyboard.press("Enter")
    page.wait_for_selector("#debtNotice:not([hidden])")
    notice = page.inner_text("#debtNotice")
    check("Karim Benali" in notice and "INV-000001" in notice and "2,000 DA" in notice and "3,000 DA" in notice, "card shows customer, invoice, outstanding 2,000 and original total 3,000")
    check(page.is_hidden("#custSuggest"), "suggestions closed after choosing")

    # Remind Me Later -> reminder; show again
    page.click('[data-debt-action="later"]')
    check(page.is_hidden("#debtNotice") and page.is_visible("#debtReminder"), "Remind Me Later hides the card and keeps a reminder")
    page.click("#debtReminderShow")
    check(page.is_visible("#debtNotice"), "Show details brings the card back")

    # View Invoice keeps the sale
    page.click('[data-debt-view]')
    check("INV-000001" in page.inner_text(".preview-panel"), "View Invoice shows the old invoice")
    page.click("#backToSale")
    check(page.locator("#saleBody tr[data-id]").count() == 1, "the sale is still there after viewing the old invoice")

    # Add debt through the dialog: partial 500
    page.click('[data-debt-action="add"]')
    check(page.is_visible("#debtDialog"), "confirmation dialog opens")
    dialog = page.inner_text("#debtDialog")
    check("INV-000001" in dialog and "2,000 DA" in dialog, "dialog shows original invoice and balance")
    page.fill("#debtDialogRows [data-debt-amount]", "500")
    check("2,500 DA" in page.inner_text("#debtDialogNew"), "dialog shows the resulting total due (2,000 + 500)")
    page.click("#debtDialogConfirm")
    check(page.is_hidden("#debtDialog"), "dialog closes on confirm")
    check(page.is_visible("#saleDebts") and "INV-000001" in page.inner_text("#saleDebts"), "carried line listed on the sale")
    preview = page.inner_text(".preview-panel")
    check("INV-000001" in preview and "2,500" in preview, "live preview shows the carried line and total due")

    page.click("#completeSale")
    wait_invoice_shown(page, "INV-000002")
    go(page, "invoices")
    rows = page.inner_text("#invoiceBody")
    check("INV-000002" in rows and "2,500" in rows, "new invoice lists total due 2,500: " + rows.replace("\n", " ")[:160])

    # Old invoice: 1,500 still collectible there, 500 moved
    go(page, "sell")
    page.fill("#custName", "Karim Benali")
    page.fill("#custPhone", "0555 11 22 33")
    page.press("#custPhone", "Enter")
    page.wait_for_selector("#debtNotice:not([hidden])")
    notice = page.inner_text("#debtNotice")
    check("2 unpaid invoices" in notice and "1,500 DA" in notice and "4,000 DA" in notice, "two unpaid invoices, total debt 4,000: " + notice.replace("\n", " ")[:200])

    page.screenshot(path=os.environ.get("INVOISY_SHOT", "/tmp/invoisy-debt.png"), full_page=True)

    # Mobile layout: no horizontal scroll
    page.set_viewport_size({"width": 390, "height": 800})
    check(page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), "no horizontal scroll at phone width")

    check(not errors, "no console errors: " + "; ".join(errors)[:200])
    browser.close()

print("\n%d problem(s)" % len(problems))
sys.exit(1 if problems else 0)

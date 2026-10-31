"""Real-browser check: optional delivery information (Delivery Person Name, Phone Number, Delivery Fee).

Optional and manual, like the other checks here (not part of `npm test`):
    python3 tests/e2e/delivery_info_check.py
Needs Playwright with Chromium and pdfplumber. Uses a brand new browser profile and a disposable IndexedDB.
Set INVOISY_PDF_DIR to keep the printed PDFs (A4 and A5) so they can be looked at, INVOISY_SHOTS for screenshots.

What it does: types the three boxes on the real Sell page, checks the live totals and the live preview, saves the sale,
prints the saved invoice to PDF on A4 and on A5 (the way Print / Save as PDF does) and reads the PDF back, reopens the
invoice for editing, and deletes it to see that the refund leaves the delivery fee out.
"""
import os, sys, re, tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright
import pdfplumber

sys.path.insert(0, str(Path(__file__).resolve().parent))
from e2e_common import SKIP_SALE_DIALOG, open_product_form

URL = os.environ.get("INVOISY_URL") or (Path(__file__).resolve().parents[2] / "index.html").as_uri()
OUT = Path(os.environ.get("INVOISY_PDF_DIR") or tempfile.mkdtemp(prefix="invoisy-delivery-"))
OUT.mkdir(parents=True, exist_ok=True)
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


def squash(s):
    return re.sub(r"\s+", " ", s.replace("\u00a0", " ").replace("\u202f", " "))


def shot(page, name):
    if SHOTS:
        Path(SHOTS).mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(Path(SHOTS) / (name + ".png")), full_page=True)


def add_product(page, name, price, unit, stock):
    go(page, "stock")
    open_product_form(page)
    page.fill("#pName", name)
    page.fill("#pTileSize", "60*60")
    page.fill("#pCoveragePerBox", "1.44")
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


def print_pdf(page, name, paper):
    page.evaluate("(p) => { state.settings.paper = p; applyPaperSize(); }", paper)
    page.wait_for_timeout(200)
    path = OUT / f"{name}-{paper}.pdf"
    page.pdf(path=str(path), prefer_css_page_size=True, print_background=True)
    with pdfplumber.open(path) as pdf:
        pages = [(pg.extract_text() or "", float(pg.width), float(pg.height)) for pg in pdf.pages]
    return pages


with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1400, "height": 1000})
    ctx.add_init_script(SKIP_SALE_DIALOG)
    page = ctx.new_page()
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append("PAGEERROR " + str(e)))
    accept_all = lambda d: d.accept()
    page.on("dialog", accept_all)
    page.goto(URL)
    page.wait_for_selector(".nav-btn")

    add_product(page, "Marfil", 2000, "box", 40)
    go(page, "sell")

    # --- the Sell page, live ---
    check(page.is_visible("#deliveryPerson") and page.is_visible("#deliveryPhone") and page.is_visible("#deliveryFee"), "the three delivery boxes are on the Sell page")
    check("Delivery Information" in page.inner_text("fieldset:has(#deliveryFee) legend"), "section is called Delivery Information")
    add_to_sale(page, "Marfil", 5)
    check(page.is_hidden("#tDeliveryRow"), "no fee typed: no delivery line in the totals")
    check("10,000" in text(page, "#tTotal"), "total is the products only: " + text(page, "#tTotal"))
    page.fill("#custName", "Alex")
    page.fill("#deliveryPerson", "Karim Benali")
    page.fill("#deliveryPhone", "0550 12 34 56")
    page.fill("#deliveryFee", "500")
    check(page.is_visible("#tDeliveryRow") and "500" in text(page, "#tDelivery"), "delivery line shows the fee")
    check("10,500" in text(page, "#tTotal"), "final total = products + fee: " + text(page, "#tTotal"))
    check("10,500" in text(page, "#tRemaining"), "remaining = 10,500 (nothing paid yet)")
    live = squash(page.inner_text("#invoice"))
    check("Karim Benali" in live and "0550 12 34 56" in live and "Delivery fee" in live, "live preview shows the delivery section")
    check("10,500" in live, "live preview final total includes the fee")
    shot(page, "sell-live")

    page.fill("#deliveryFee", "-5")
    check("delivery fee must be a number" in page.inner_text("#saleError").lower() or "delivery fee" in page.inner_text("#saleError").lower(), "a negative fee shows an error")
    page.fill("#deliveryFee", "500")
    page.fill("#amountPaid", "10500")
    page.click("#completeSale")
    page.wait_for_function("document.getElementById('invoice').textContent.includes('INV-')", timeout=10000)
    page.wait_for_timeout(300)
    check(page.input_value("#deliveryFee") == "" and page.input_value("#deliveryPerson") == "", "the boxes are cleared after the sale")
    saved = squash(page.inner_text("#invoice"))
    check("Delivery fee" in saved and "10,500" in saved, "saved invoice shows the fee and the final total")
    shot(page, "invoice-saved")

    # --- printing, A4 and A5 ---
    for paper, (w, h) in (("A4", (595, 842)), ("A5", (420, 595))):
        pages = print_pdf(page, "delivery", paper)
        full = squash(" ".join(t for t, _, _ in pages))
        check(abs(pages[0][1] - w) < 3 and abs(pages[0][2] - h) < 3, f"{paper}: page size {pages[0][1]:.0f}x{pages[0][2]:.0f}")
        check(len(pages) == 1, f"{paper}: one page ({len(pages)})")
        check("DELIVERY" in full and "Karim Benali" in full and "0550 12 34 56" in full, f"{paper}: delivery section printed")
        check(re.search(r"Delivery fee\s*500", full) is not None, f"{paper}: delivery fee line in the summary")
        check(re.search(r"TOTAL\s*10,500", full) is not None, f"{paper}: final total 10,500 printed")
        i_tax, i_sec, i_total = full.find("Tax"), full.find("DELIVERY"), full.find("TOTAL")
        check(0 < i_tax and i_sec > 0 and i_total > i_sec, f"{paper}: order is products, delivery section, summary")

    # --- reopen for editing (the saved invoice is on screen: its Edit button opens it on the Sell page) ---
    go(page, "invoices")
    page.locator("#invoiceBody tr", has_text="INV-000001").locator('button[data-action="edit"]').click()
    page.wait_for_selector("#editBanner:not([hidden])")
    check(page.input_value("#deliveryPerson") == "Karim Benali" and page.input_value("#deliveryPhone") == "0550 12 34 56" and page.input_value("#deliveryFee") == "500",
          "reopened invoice shows its delivery information in the boxes")
    shot(page, "edit-open")
    page.fill("#deliveryFee", "800")
    check("10,800" in text(page, "#tTotal"), "editing the fee updates the final total: " + text(page, "#tTotal"))
    page.click("#editSave")
    page.wait_for_selector("#editBanner", state="hidden")
    go(page, "invoices")
    page.wait_for_function("document.querySelector('#invoiceBody').innerText.includes('INV-000001')")
    page.locator("#invoiceBody tr", has_text="INV-000001").first.click()
    page.wait_for_timeout(300)
    after = squash(page.inner_text("#invoice"))
    check("800" in after and "10,800" in after, "after saving, the invoice shows the new fee and total")

    # --- removing every product: the refund leaves the delivery fee out ---
    page.locator("#invoiceBody tr", has_text="INV-000001").locator('button[data-action="edit"]').click()
    page.wait_for_selector("#editBanner:not([hidden])")
    page.locator("#saleBody button[data-action='remove']").first.click() if page.locator("#saleBody button[data-action='remove']").count() else page.locator("#saleBody button").last.click()
    page.wait_for_timeout(200)
    rows = text(page, "#tEditRows")
    # 10,500 was collected and the fee is now 800, so 9,700 is what can go back: the fee is never part of a refund.
    check("Refund to hand back" in rows and "9,700" in rows, "the summary refunds what was collected beyond the 800 fee (9,700): " + rows.replace("\n", " ")[:160])
    shot(page, "delete-ready")
    asked = []
    page.remove_listener("dialog", accept_all)
    page.on("dialog", lambda d: (asked.append(d.message), d.accept()))
    page.click("#editSave")
    page.wait_for_selector("#editBanner", state="hidden")
    check(len(asked) == 1 and "Refund to hand back: 9,700" in asked[0], "confirmation names the 9,700 refund")
    check("Delivery fee kept, never refunded: 800" in asked[0], "and says the 800 delivery fee is kept: " + asked[0].replace("\n", " | ")[-120:])
    check("9,700" in text(page, "#toast") and "10,500" not in text(page, "#toast"), "the message shows the refund without the fee: " + text(page, "#toast"))
    go(page, "stock")
    check("40" in page.locator("#stockBody tr", has_text="Marfil").first.inner_text(), "all stock came back")

    check(not errors, "no console errors: " + "; ".join(errors[:3]))
    browser.close()

print()
print("Printed PDFs in", OUT)
if problems:
    print(f"{len(problems)} problem(s):")
    for item in problems:
        print(" -", item)
    sys.exit(1)
print("All checks passed.")

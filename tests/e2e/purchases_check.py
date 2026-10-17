"""Real-browser check of the Suppliers and Purchases screens, opened straight from disk (file://).

Optional and manual (not part of `npm test`; it needs a browser):
    pip install playwright && playwright install chromium     (or point Playwright at a Chromium you already have)
    python3 tests/e2e/purchases_check.py
It uses a brand new browser profile and a disposable IndexedDB, so no real business data is touched.
Set SHOTS=/some/folder to also save screenshots.
"""
import json, os, sys, tempfile
from datetime import date, timedelta
from pathlib import Path
from playwright.sync_api import sync_playwright

URL = os.environ.get("INVOISY_URL") or (Path(__file__).resolve().parents[2] / "index.html").as_uri()
OUT = tempfile.mkdtemp(prefix="invoisy-purchases-e2e-")
SHOTS = os.environ.get("SHOTS")
problems = []

def check(cond, label):
    print(("PASS " if cond else "FAIL ") + label)
    if not cond:
        problems.append(label)

def text(page, sel):
    return page.inner_text(sel).strip()

def shot(page, name):
    if SHOTS:
        Path(SHOTS).mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(Path(SHOTS) / (name + ".png")), full_page=True)

def go(page, view):
    page.click(f'.nav-btn[data-view="{view}"]')

def home(page, view):
    """Opens a page and then presses its menu button again: that returns to the page's list."""
    go(page, view)
    go(page, view)

def toast(page):
    return text(page, "#toast")

def wait_toast(page, contains):
    page.wait_for_function("(s) => document.getElementById('toast').textContent.includes(s)", arg=contains, timeout=8000)

def pick_product(page, lid, query):
    """Chooses a product on a purchase line the way a person does: type in its search box, then Enter."""
    page.click(f"#pl-{lid}-search")
    page.keyboard.type(query)
    page.keyboard.press("Enter")

def stock_of(page, name):
    go(page, "stock")
    row = page.locator("#stockBody tr", has_text=name).first
    return row.locator("td").nth(3).inner_text().strip()

today = date.today()
iso = lambda d: d.isoformat()

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(accept_downloads=True, viewport={"width": 1400, "height": 900})
    page = ctx.new_page()
    errors = []
    dialogs = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append("PAGEERROR " + str(e)))
    def on_dialog(d):
        dialogs.append(d.message)
        d.accept()
    page.on("dialog", on_dialog)

    page.goto(URL)
    go(page, "settings")
    page.wait_for_function("document.getElementById('dataState').textContent === 'Ready'", timeout=10000)

    # --- a product that sells by m² and is bought by the box
    go(page, "stock")
    page.fill("#pName", "Tile A")
    page.fill("#pTileSize", "60*60")
    page.fill("#pCoveragePerBox", "1.44")
    page.locator("#priceRows input[data-field='price']").first.fill("800")
    page.locator("#priceRows select[data-field='unit']").first.select_option("m2")
    page.select_option("#pStockUnit", "m2")      # counted in m², bought in boxes of 1.44 m²
    page.fill("#pStock", "10")
    page.click("#productSubmit")
    page.wait_for_selector("#stockBody tr")
    stock_before = stock_of(page, "Tile A")
    check(stock_before.startswith("10"), "starting stock is 10 m²")

    # --- 1. suppliers page, add a supplier
    go(page, "suppliers")
    check("No suppliers yet" in text(page, "#supRows"), "empty suppliers list explains what to do")
    page.click('[data-act="sup-add"]')
    page.click("#sf-save")
    check("name" in text(page, "#sf-error").lower(), "a supplier needs a name")
    page.fill("#sf-name", "Timgad Ceramic")
    page.fill("#sf-contactName", "Karim")
    page.fill("#sf-phone", "0555 12 34 56")
    page.fill("#sf-email", "bad-email")
    page.click("#sf-save")
    check("email" in text(page, "#sf-error").lower(), "an invalid email is refused")
    page.fill("#sf-email", "sales@timgad.example")
    page.fill("#sf-taxId", "RC-998877")
    page.select_option("#sf-terms", "30")
    page.fill("#sf-creditLimit", "500000")
    page.fill("#sf-notes", "Pays by transfer.")
    page.click("#sf-save")
    wait_toast(page, "Timgad Ceramic was added")
    check("Timgad Ceramic" in text(page, ".profile-head"), "new supplier opens on its profile")
    shot(page, "01-profile-overview")

    # --- 2. duplicate warning (never merged)
    page.click('[data-act="sup-back"]')
    page.click('[data-act="sup-add"]')
    page.fill("#sf-name", "timgad ceramic")
    page.click("#sf-save")
    page.wait_for_selector("#supDup:not([hidden])")
    check("same name" in text(page, "#supDup"), "duplicate supplier name is warned about")
    page.click('[data-act="sup-cancel"]')
    check(page.locator("#supRows tr[data-id]").count() == 1, "the duplicate was not saved")

    # --- 3. a draft purchase never touches stock
    page.click('[data-act="pur-new"]')
    page.select_option("#pf-supplier", label="Timgad Ceramic")
    check(page.input_value("#pf-due") == iso(today + timedelta(days=30)), "due date follows the 30-day payment terms")
    page.fill("#pf-invoiceNo", "FA-2026-001")
    row = page.locator(".pl-row").first
    lid = row.get_attribute("data-line")
    pick_product(page, lid, "tile a")
    check(page.input_value(f"#pl-{lid}-search").startswith("Tile A"), "typing in the product box and pressing Enter chooses the product")
    check(page.input_value(f"#pl-{lid}-unit") == "m2", "unit defaults from the product")
    page.select_option(f"#pl-{lid}-unit", "box")
    page.fill(f"#pl-{lid}-qty", "200")
    page.fill(f"#pl-{lid}-price", "900")
    conv = text(page, f"#pl-{lid}-conv")
    check("288" in conv, "200 boxes x 1.44 shows 288 m² before saving (" + conv + ")")
    check("180" in text(page, "#pfTotals") and "000" in text(page, "#pfTotals"), "totals show 180 000")
    page.click("#pf-saveDraft")
    wait_toast(page, "saved")
    check("Draft" in text(page, ".profile-head"), "saved as a draft")
    ref = text(page, ".profile-head h2").split()[0]
    check(ref == "PUR-000001", "internal reference PUR-000001 (" + ref + ")")
    check(stock_of(page, "Tile A") == stock_before, "a draft does not change stock")
    shot(page, "02-draft-detail")

    # --- 4. confirm: stock +288 once, initial payment recorded
    home(page, "purchases")
    page.click('#purRows [data-act="pur-open"]')
    page.click('[data-act="pur-panel"][data-panel="confirm"]')
    page.fill("#dc-pamount", "80000")
    page.click('form[data-form="pur-confirm"] button[type="submit"]')
    wait_toast(page, "confirmed")
    check("Confirmed" in text(page, ".profile-head"), "purchase confirmed")
    check(any("Confirm this purchase" in d for d in dialogs), "confirmation asks first")
    after = stock_of(page, "Tile A")
    check(after.startswith("298"), "stock is 10 + 288 = 298 (" + after + ")")
    home(page, "purchases")
    page.click('#purRows [data-act="pur-open"]')
    check("Partially paid" in text(page, ".profile-head"), "80 000 of 180 000 paid shows Partially paid")
    check("100" in text(page, ".stat-strip.small") , "100 000 outstanding")
    shot(page, "03-confirmed-detail")

    # --- 5. second payment, over-payment refused, negative refused
    page.click('[data-act="pur-panel"][data-panel="pay"]')
    page.fill("#dp-amount", "999999")
    page.click('form[data-form="pur-pay"] button[type="submit"]')
    check("at most" in text(page, "#dp-error"), "overpayment is refused")
    page.fill("#dp-amount", "-5")
    page.click('form[data-form="pur-pay"] button[type="submit"]')
    check("negative" in text(page, "#dp-error"), "negative payment is refused")
    page.fill("#dp-amount", "50000")
    page.fill("#dp-ref", "TRF-77")
    page.click('form[data-form="pur-pay"] button[type="submit"]')
    wait_toast(page, "Payment recorded")
    check("50" in text(page, ".stat-strip.small"), "outstanding is now 50 000")

    # --- 6. duplicate supplier invoice number refused, allowed for another supplier
    home(page, "suppliers")
    page.click('[data-act="sup-add"]')
    page.fill("#sf-name", "Sétif Céramique")
    page.click("#sf-save")
    wait_toast(page, "was added")
    page.click('[data-act="pur-new"]')
    page.select_option("#pf-supplier", label="Sétif Céramique")
    page.fill("#pf-invoiceNo", "FA-2026-001")
    lid = page.locator(".pl-row").first.get_attribute("data-line")
    page.click(f'[data-act="pur-product-new"][data-line="{lid}"]')
    # the same product form as the Stock page, in a dialog (ids are the Stock form's, prefixed with pd-)
    page.fill("#pd-Name", "Tile B")
    page.fill("#pd-Manufacturer", "Timgad Ceramic")
    page.fill("#pd-TileSize", "30*30")
    page.fill("#pd-CoveragePerBox", "1.08")
    page.locator("#pd-PriceRows input[data-field=price]").first.fill("700")
    page.select_option("#pd-StockUnit", "m2")
    page.click("#purProductSave")
    wait_toast(page, "Tile B")   # not just "added": the supplier's own "was added" toast may still be showing
    check("Tile B" in page.eval_on_selector(f"#pl-{lid}-product", "s => s.options[s.selectedIndex].text"), "the new product is saved and selected on the line")
    check("Tile B" in page.input_value(f"#pl-{lid}-search"), "the product box shows the new product")
    check(page.input_value("#pf-invoiceNo") == "FA-2026-001", "what was typed in the purchase is kept")
    page.select_option(f"#pl-{lid}-unit", "box")
    page.fill(f"#pl-{lid}-qty", "10")
    page.fill(f"#pl-{lid}-price", "500")
    check("10.8" in text(page, f"#pl-{lid}-conv"), "new product: 10 boxes x 1.08 = 10.8 m²")
    page.click("#pf-confirm")
    wait_toast(page, "confirmed")
    check(stock_of(page, "Tile B").startswith("10.8"), "new product Tile B created with 10.8 m² from the purchase")
    go(page, "stock")
    check("700" in text(page, "#stockBody tr:has-text('Tile B')"), "selling price of the new product is what was typed, not the purchase price")
    check("Timgad Ceramic" in text(page, "#stockBody tr:has-text('Tile B')"), "the manufacturer typed in the purchase is saved with the product")
    # same invoice number, same supplier is refused
    home(page, "suppliers")
    page.click('#supRows tr:has-text("Sétif") [data-act="pur-new"]')
    page.fill("#pf-invoiceNo", "FA-2026-001")
    lid = page.locator(".pl-row").first.get_attribute("data-line")
    pick_product(page, lid, "tile a")
    page.fill(f"#pl-{lid}-qty", "1"); page.fill(f"#pl-{lid}-price", "1")
    page.click("#pf-saveDraft")
    check("already used" in text(page, "#pf-error"), "same supplier + same invoice number is refused")
    page.click('[data-act="pur-back"]')

    # --- 7. an overdue purchase, then reports
    home(page, "suppliers")
    page.click('#supRows tr:has-text("Timgad") [data-act="pur-new"]')
    page.fill("#pf-invoiceNo", "FA-OLD")
    page.fill("#pf-date", iso(today - timedelta(days=60)))
    page.fill("#pf-due", iso(today - timedelta(days=30)))
    lid = page.locator(".pl-row").first.get_attribute("data-line")
    pick_product(page, lid, "tile a")
    page.select_option(f"#pl-{lid}-unit", "box")
    page.fill(f"#pl-{lid}-qty", "5"); page.fill(f"#pl-{lid}-price", "1000")
    page.uncheck("#pf-receive")
    page.click("#pf-confirm")
    wait_toast(page, "confirmed")
    check("Not received" in text(page, ".profile-head"), "goods can be confirmed without being received")
    check("Overdue" in text(page, ".profile-head"), "overdue shows on the purchase")
    # partial delivery
    page.click('[data-act="pur-panel"][data-panel="receive"]')
    q = page.locator('input[data-line]').first
    q.fill("2")
    page.click('form[data-form="pur-receive"] button[type="submit"]')
    wait_toast(page, "Delivery recorded")
    check("Partly received" in text(page, ".profile-head"), "partial delivery")
    check(stock_of(page, "Tile A").startswith("300.88"), "stock grew by 2 boxes = 2.88 m²")
    home(page, "purchases")
    page.click('[data-act="pur-tab"][data-tab="reports"]')
    page.click('[data-act="rep-preset"][data-preset="all"]')
    rep = text(page, "#repBody")
    check("Overdue invoices" in rep and "FA-OLD" in rep, "report lists the overdue invoice")
    check("Outstanding supplier balances" in rep, "report shows outstanding balances")
    shot(page, "04-reports")

    # --- 8. cancel is blocked while payments are active, voiding first allows it and reverses stock
    home(page, "purchases")
    page.click('[data-act="pur-tab"][data-tab="list"]')
    page.click('#purRows tr:has-text("PUR-000001") [data-act="pur-open"]')
    page.click('[data-act="pur-panel"][data-panel="cancel"]')
    check("active payment" in text(page, ".action-panel"), "cancelling is blocked while payments are active")
    shot(page, "05-cancel-blocked")

    # --- 9. supplier profile tabs
    home(page, "suppliers")
    page.click('#supRows tr:has-text("Timgad") [data-act="sup-open"] >> nth=0')
    for tab in ["purchases", "payments", "products", "documents"]:
        page.click(f'[data-act="sup-tab"][data-tab="{tab}"]')
    page.click('[data-act="sup-tab"][data-tab="products"]')
    check("Tile A" in text(page, "main"), "products tab lists what was bought")
    page.click('[data-act="sup-tab"][data-tab="payments"]')
    check("TRF-77" in text(page, "main"), "payments tab lists the payment with its reference")
    shot(page, "06-payments-tab")

    # --- 9b. attach the scanned supplier invoice to a confirmed purchase, then open it again
    home(page, "purchases")
    page.click('#purRows tr:has-text("PUR-000001") [data-act="pur-open"]')
    scan = Path(OUT) / "scan.pdf"
    scan.write_bytes(b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n")
    page.set_input_files("#dtFile", str(scan))
    wait_toast(page, "File attached")
    check("scan.pdf" in text(page, ".att-list"), "the attached supplier invoice is listed on the purchase")
    with page.expect_download() as att:
        page.click('[data-act="att-download"]')
    saved_scan = Path(OUT) / "scan-back.pdf"
    att.value.save_as(str(saved_scan))
    check(saved_scan.read_bytes() == scan.read_bytes(), "the attached file comes back byte for byte")
    bad = Path(OUT) / "notes.txt"
    bad.write_text("not a scan")
    page.set_input_files("#dtFile", str(bad))
    wait_toast(page, "JPG, PNG, WebP or PDF")
    check("notes.txt" not in text(page, ".att-list"), "a text file is refused as an attachment")
    shot(page, "05b-attachment")

    # --- 9c. French, and a narrow screen
    go(page, "settings")
    page.select_option("#sLanguage", "fr")
    home(page, "suppliers")
    check("Ajouter un fournisseur" in text(page, "main"), "the suppliers page is in French")
    page.click('#supRows tr:has-text("Timgad") [data-act="sup-open"] >> nth=0')
    shot(page, "07-profile-fr")
    home(page, "purchases")
    page.click('#purRows tr:has-text("PUR-000001") [data-act="pur-open"]')
    check("Partiellement payé" in text(page, ".profile-head"), "payment status in French")
    shot(page, "08-detail-fr")
    go(page, "settings")
    page.select_option("#sLanguage", "en")
    page.set_viewport_size({"width": 420, "height": 900})
    home(page, "purchases")
    page.click('[data-act="pur-new"]')
    shot(page, "09-form-narrow")
    check(page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 2"), "narrow screen renders (no horizontal overflow)")
    page.set_viewport_size({"width": 1400, "height": 900})
    page.click('[data-act="pur-back"]')

    # --- 10. backup export and restore keep everything
    go(page, "settings")
    with page.expect_download() as dl:
        page.click("#exportBackup")
    path = Path(OUT) / "backup.json"
    dl.value.save_as(str(path))
    data = json.loads(path.read_text())
    check(data["formatVersion"] == 2 and data["counts"]["suppliers"] == 2 and data["counts"]["purchases"] == 3 and data["counts"]["supplierPayments"] == 2 and data["counts"]["attachments"] == 1,
          "backup holds suppliers, purchases and payments: " + json.dumps(data["counts"]))
    page.reload()
    go(page, "settings")
    page.wait_for_function("document.getElementById('dataState').textContent === 'Ready'", timeout=10000)
    check(stock_of(page, "Tile A").startswith("300.88"), "everything survives a reload")
    # a change made after the backup is undone by restoring it
    home(page, "suppliers")
    page.click('[data-act="sup-add"]')
    page.fill("#sf-name", "Temporary Co")
    page.click("#sf-save")
    wait_toast(page, "was added")
    go(page, "settings")
    page.set_input_files("#importFile", str(path))
    page.wait_for_function("document.getElementById('toast').textContent.includes('Restore completed')", timeout=10000)
    home(page, "suppliers")
    check(page.locator("#supRows tr[data-id]").count() == 2 and "Temporary" not in text(page, "#supRows"), "restore brings the backup back (2 suppliers)")
    check(stock_of(page, "Tile A").startswith("300.88"), "restored stock is unchanged")

    check(not errors, "no console errors: " + "; ".join(errors[:3]))
    browser.close()

print()
print("FAILED: " + "; ".join(problems) if problems else "ALL PASSED")
sys.exit(1 if problems else 0)

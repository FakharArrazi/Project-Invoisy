"""Real-browser check of Invoisy, opened the way people open it: index.html straight from disk (file://).

Optional and manual. It is NOT part of `npm test` because it needs a browser:
    pip install playwright && playwright install chromium     (or point Playwright at a Chromium you already have)
    python3 tests/e2e/browser_check.py
It uses a brand new browser profile and a disposable IndexedDB, so no real business data is touched.
"""
import json, os, sys, tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright

URL = os.environ.get("INVOISY_URL") or (Path(__file__).resolve().parents[2] / "index.html").as_uri()   # INVOISY_URL=http://localhost:8000/ to try a web server
OUT = tempfile.mkdtemp(prefix="invoisy-e2e-")
problems = []

def check(cond, label):
    print(("PASS " if cond else "FAIL ") + label)
    if not cond:
        problems.append(label)

def go(page, view):
    page.click(f'.nav-btn[data-view="{view}"]')

def text(page, sel):
    return page.inner_text(sel).strip()

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(accept_downloads=True)
    page = ctx.new_page()
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append("PAGEERROR " + str(e)))
    page.on("dialog", lambda d: d.accept())

    page.goto(URL)
    go(page, "settings")
    page.wait_for_function("document.getElementById('dataState').textContent === 'Ready'", timeout=10000)
    check(text(page, "#dataState") == "Ready", "database opens over file:// and reports Ready")
    check(page.is_hidden("#storageBanner"), "no storage banner when ready")
    check("0 products, 0 invoices" == text(page, "#dataSummary"), "empty summary on a fresh start")
    check(text(page, "#dataBackup") == "Never", "last backup is Never on a fresh start")

    # --- create a product through the real form
    go(page, "stock")
    page.fill("#pName", "Tile A")
    page.fill("#pTileSize", "60*60")
    page.fill("#pCoveragePerBox", "1.44")
    page.fill("#pPrice", "800")
    page.select_option("#pPriceUnit", "m2")
    page.fill("#pStock", "10")
    page.click("#productSubmit")
    page.wait_for_selector("#stockBody tr")
    check("Tile A" in text(page, "#stockBody"), "product saved and listed")

    # --- add stock
    page.fill("#rQty", "5")
    page.click('#restockForm button[type="submit"]')
    page.wait_for_function("document.querySelector('#stockBody tr td:nth-child(4)').textContent.trim().startsWith('15')")
    check(True, "restock 10 + 5 = 15")

    # --- sell 2 boxes, pay 1000 of 2304
    go(page, "sell")
    page.fill("#search", "Tile")
    page.wait_for_selector("#results .result")
    page.click("#results .result")
    page.fill("#addQty", "2")
    page.select_option("#addUnit", "box")
    page.click('#addForm button[type="submit"]')
    page.fill("#amountPaid", "1000")
    page.click("#completeSale")
    page.wait_for_function("document.getElementById('toast').textContent.includes('INV-000001')", timeout=10000)
    check(True, "sale completed as INV-000001")

    go(page, "invoices")
    row = text(page, "#invoiceBody tr")
    check("INV-000001" in row and "2,304" in row and "Partial" in row, "invoice listed with total 2,304 and status Partial: " + row.replace("\n", " ")[:90])

    # --- add the remaining payment
    page.click('#invoiceBody button[data-action="pay"]')
    page.fill("#payAmount", "1304")
    page.click("#payBtn")
    page.wait_for_function("document.getElementById('toast').textContent.includes('Payment added')")
    go(page, "invoices")
    check("Paid" in text(page, "#invoiceBody tr"), "final payment makes the invoice Paid")

    # --- reload: everything comes back from IndexedDB
    page.reload()
    go(page, "settings")
    page.wait_for_function("document.getElementById('dataState').textContent === 'Ready'", timeout=10000)
    check(text(page, "#dataSummary") == "1 product, 1 invoice", "after reload: 1 product, 1 invoice (read from IndexedDB)")
    go(page, "stock")
    check(text(page, "#stockBody tr td:nth-child(4)").startswith("13"), "after reload: stock is 13 (15 - 2 sold)")
    go(page, "invoices")
    check("Paid" in text(page, "#invoiceBody tr"), "after reload: invoice still Paid")

    # --- reminder shows (data exists, never backed up) and is not a dialog
    check(page.is_visible("#backupReminder") and "No backup yet" in text(page, "#backupReminder"), "reminder pill shows 'No backup yet'")

    # --- export a backup
    go(page, "settings")
    with page.expect_download() as dl:
        page.click("#exportBackup")
    d = dl.value
    path = os.path.join(OUT, d.suggested_filename)
    d.save_as(path)
    backup = json.load(open(path))
    check(d.suggested_filename.startswith("invoisy-backup-") and d.suggested_filename.endswith(".json"), "download is named " + d.suggested_filename)
    check(backup["application"] == "Invoisy" and backup["formatVersion"] == 1, "backup has application + formatVersion")
    check(len(backup["data"]["products"]) == 1 and len(backup["data"]["invoices"]) == 1 and backup["data"]["invoiceCounter"] == 1, "backup holds 1 product, 1 invoice, counter 1")
    inv = backup["data"]["invoices"][0]
    check(inv["payments"] and len(inv["payments"]) == 2 and inv["items"][0]["name"] == "Tile A", "backup keeps the payment history and line-item snapshot")
    page.wait_for_function("document.getElementById('dataBackup').textContent !== 'Never'")
    check(page.is_hidden("#backupReminder"), "reminder hides after a successful export")

    # --- make a second sale, then restore the backup over it
    go(page, "sell")
    page.fill("#search", "Tile")
    page.wait_for_selector("#results .result")
    page.click("#results .result")
    page.fill("#addQty", "1")
    page.select_option("#addUnit", "piece")
    page.click('#addForm button[type="submit"]')
    page.click("#completeSale")
    page.wait_for_function("document.getElementById('toast').textContent.includes('INV-000002')", timeout=10000)
    go(page, "settings")
    check(text(page, "#dataSummary") == "1 product, 2 invoices", "second sale saved (2 invoices)")

    with page.expect_download() as safety:
        page.set_input_files("#importFile", path)
    check("invoisy-before-restore-" in safety.value.suggested_filename, "restore first downloads a safety copy: " + safety.value.suggested_filename)
    page.wait_for_function("document.getElementById('toast').textContent.includes('Restore completed')", timeout=10000)
    check(text(page, "#dataSummary") == "1 product, 1 invoice", "restore replaced the data: back to 1 invoice")

    # --- numbering never goes back after a restore
    go(page, "sell")
    page.fill("#search", "Tile")
    page.wait_for_selector("#results .result")
    page.click("#results .result")
    page.fill("#addQty", "1")
    page.click('#addForm button[type="submit"]')
    page.click("#completeSale")
    page.wait_for_function("document.getElementById('toast').textContent.includes('Sale completed')", timeout=10000)
    toast = text(page, "#toast")
    check("INV-000003" in toast, "after restore the next invoice is INV-000003, not a reused number: " + toast)

    # --- a corrupt file is rejected and nothing changes
    bad = os.path.join(OUT, "bad.json")
    open(bad, "w").write("{not json")
    go(page, "settings")
    before = text(page, "#dataSummary")
    page.set_input_files("#importFile", bad)
    page.wait_for_function("document.getElementById('dataError').textContent.length > 0")
    check("not valid JSON" in text(page, "#dataError") and text(page, "#dataSummary") == before, "malformed file is rejected, data unchanged")

    # --- French: the storage and backup controls are translated and the choice is saved in the database
    go(page, "settings")
    page.select_option("#sLanguage", "fr")
    page.wait_for_function("document.getElementById('exportBackup').textContent.trim() === 'Exporter une sauvegarde'", timeout=10000)
    check(text(page, "#dataState") == "Prête", "French: the database status reads 'Prête'")
    check("Importer / Restaurer" in text(page, "#importBackup"), "French: the restore button is translated")
    page.set_input_files("#importFile", bad)
    page.wait_for_function("document.getElementById('dataError').textContent.includes('rien n’a été modifié')")
    check("pas une sauvegarde Invoisy valide" in text(page, "#dataError"), "French: a rejected file is explained in French")
    page.screenshot(path=os.path.join(OUT, "settings-fr.png"), full_page=True)
    page.reload()
    go(page, "settings")
    page.wait_for_function("document.getElementById('dataState').textContent === 'Prête'", timeout=10000)
    check(True, "French is still selected after a reload (saved in IndexedDB)")
    page.select_option("#sLanguage", "en")
    page.wait_for_function("document.getElementById('dataState').textContent === 'Ready'", timeout=10000)

    check(not [e for e in errors if "favicon" not in e], "no console or page errors: " + "; ".join(errors)[:300])

    # --- a second, brand new browser profile that already holds data saved by the previous version in localStorage
    legacy = json.dumps({
        "version": 1, "lastSaved": "2026-09-01T10:00:00.000Z",
        "products": [{"id": "old-1", "name": "Old Tile", "description": "", "sku": "OT-1", "category": "Old", "sellingPrice": 100, "priceUnit": "piece", "purchasePrice": 60, "stock": 12}],
        "invoices": [], "settings": {"businessName": "Old Shop"}, "invoiceCounter": 7,
    })
    ctx2 = browser.new_context(accept_downloads=True)
    ctx2.add_init_script("try { if (!localStorage.getItem('invoisy-data')) localStorage.setItem('invoisy-data', %s); } catch (e) {}" % json.dumps(legacy))
    page2 = ctx2.new_page()
    errors2 = []
    page2.on("console", lambda m: errors2.append(m.text) if m.type == "error" else None)
    page2.on("pageerror", lambda e: errors2.append("PAGEERROR " + str(e)))
    page2.on("dialog", lambda d: d.accept())
    page2.goto(URL)
    go(page2, "settings")
    page2.wait_for_function("document.getElementById('dataState').textContent === 'Ready'", timeout=10000)
    check(text(page2, "#dataSummary") == "1 product, 0 invoices", "older localStorage data was migrated into IndexedDB on first launch")
    check(page2.evaluate("localStorage.getItem('invoisy-data')") == legacy, "the old localStorage copy was left untouched")
    check(page2.is_visible("#legacyBox"), "the Settings page explains what happened to the older data")
    check(page2.is_disabled("#legacyRemove"), "removing the old copy is not allowed before a backup has been exported")
    page2.reload()
    go(page2, "settings")
    page2.wait_for_function("document.getElementById('dataState').textContent === 'Ready'", timeout=10000)
    check(text(page2, "#dataSummary") == "1 product, 0 invoices", "a second launch does not migrate again or duplicate anything")
    check(not [e for e in errors2 if "favicon" not in e], "no console or page errors during migration: " + "; ".join(errors2)[:300])
    browser.close()

print("\nartifacts in", OUT)
print("FAILED:" if problems else "ALL PASSED", problems if problems else "")
sys.exit(1 if problems else 0)

"""Real-browser check of the automatic backup file (Settings, "Automatic backup file").

Optional and manual, like browser_check.py. It is NOT part of `npm test` because it needs a browser:
    pip install playwright && playwright install chromium     (or point Playwright at a Chromium you already have)
    python3 tests/e2e/autobackup_check.py

What is real and what is not:
  - Real: Chromium, IndexedDB, the page scripts, and the FileSystemFileHandle. A headless browser cannot drive the
    operating system's "Save as" dialog, so the only stand-in is window.showSaveFilePicker, which here returns a handle
    from the browser's own private file system (OPFS). It is the same handle class: it is stored in IndexedDB and
    found again after a reload or restart, createWritable() swaps the content in on close(), and so on.
  - NOT covered: the real "Save as" dialog, and the browser asking again for permission (OPFS handles are always
    granted). Those paths are covered by tests/autobackup.test.js with a stand-in handle, and are listed as untested
    in a real browser in the README.
It uses a brand new browser profile and a disposable IndexedDB, so no real business data is touched.
"""
import json, os, subprocess, sys, tempfile, time
from pathlib import Path
from playwright.sync_api import sync_playwright
from e2e_common import SKIP_SALE_DIALOG, wait_invoice_shown, wait_payment_recorded

ROOT = Path(__file__).resolve().parents[2]
PORT = int(os.environ.get("INVOISY_PORT", "8765"))
URL = os.environ.get("INVOISY_URL") or f"http://localhost:{PORT}/index.html"
PROFILE = tempfile.mkdtemp(prefix="invoisy-autobackup-profile-")
OUT = tempfile.mkdtemp(prefix="invoisy-autobackup-out-")
problems = []

def check(cond, label):
    print(("PASS " if cond else "FAIL ") + label)
    if not cond:
        problems.append(label)

# The only stand-in: the "Save as" dialog. It hands back a real handle from the browser's private file system.
INIT = """
window.__pickCount = 0;
window.showSaveFilePicker = async (options) => {
  window.__pickCount++;
  const root = await navigator.storage.getDirectory();
  return root.getFileHandle((options && options.suggestedName) || 'invoisy-data.json', { create: true });
};
"""
NO_API = "delete window.showSaveFilePicker; Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });"

def go(page, view):
    page.click(f'.nav-btn[data-view="{view}"]')

def text(page, sel):
    return page.inner_text(sel).strip()

def read_file(page, name="invoisy-data.json"):
    return page.evaluate("""async (name) => {
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle(name);
      const file = await handle.getFile();
      return { text: await file.text(), modified: file.lastModified };
    }""", name)

def file_json(page):
    return json.loads(read_file(page)["text"])

def wait_until(fn, timeout=8.0):
    """Polls until fn() is true (the file is written a moment after the change, so a check made at once can be early)."""
    end = time.time() + timeout
    while time.time() < end:
        try:
            if fn():
                return True
        except Exception:
            pass
        time.sleep(0.1)
    return False

def wait_status(page, expected, timeout=10000):
    page.wait_for_function("(s) => document.getElementById('autoStatus').textContent === s", arg=expected, timeout=timeout)

def ready(page):
    go(page, "settings")
    page.wait_for_function("document.getElementById('dataState').textContent === 'Ready'", timeout=10000)

def add_product(page, name, price="800", stock="10"):
    go(page, "stock")
    page.fill("#pName", name)
    page.fill("#pTileSize", "60*60")
    page.fill("#pCoveragePerBox", "1.44")
    page.locator("#priceRows input[data-field='price']").first.fill(price)
    page.locator("#priceRows select[data-field='unit']").first.select_option("m2")
    page.fill("#pStock", stock)
    page.click("#productSubmit")
    page.wait_for_function("(n) => document.getElementById('stockBody').textContent.includes(n)", arg=name)

def sell(page, qty, paid=""):
    go(page, "sell")
    page.fill("#search", "Tile")
    page.wait_for_selector("#results .result")
    page.click("#results .result")
    page.fill("#addQty", str(qty))
    page.select_option("#addUnit", "box")
    page.click('#addForm button[type="submit"]')
    if paid:
        page.fill("#amountPaid", paid)
    n = len(file_json(page)["data"]["invoices"]) + 1
    page.click("#completeSale")
    wait_invoice_shown(page, f"INV-{n:06d}")

def revisions_match(page):
    return page.evaluate("document.getElementById('autoDbRevision').textContent === document.getElementById('autoBackedRevision').textContent")

server = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1"], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) if "INVOISY_URL" not in os.environ else None
time.sleep(0.8)
try:
    with sync_playwright() as p:
        errors = []

        def launch():
            ctx = p.chromium.launch_persistent_context(PROFILE, accept_downloads=True)
            ctx.add_init_script(INIT)
            page = ctx.new_page()
            page.add_init_script(SKIP_SALE_DIALOG)
            page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
            page.on("pageerror", lambda e: errors.append("PAGEERROR " + str(e)))
            page.on("dialog", lambda d: d.accept())
            return ctx, page

        ctx, page = launch()
        page.goto(URL)
        ready(page)

        # 1. first launch, nothing connected
        check(text(page, "#autoConnection") == "Not connected" and text(page, "#autoStatus") == "Not enabled", "first launch: Not connected / Not enabled")
        check("not enabled yet" in text(page, "#autoNote"), "first launch: explains automatic backup is not enabled and offers the action")
        check(page.is_visible("#autoChoose") and text(page, "#autoChoose") == "Choose backup file", "first launch: 'Choose backup file' is offered")

        # 2. a product exists first, then the file is chosen
        add_product(page, "Tile A")
        go(page, "settings")
        page.click("#autoChoose")
        wait_status(page, "Backup current")
        check(text(page, "#autoConnection") == "Connected" and text(page, "#autoFile") == "invoisy-data.json", "connected to invoisy-data.json")
        f = file_json(page)
        check(f["application"] == "Invoisy" and f["formatVersion"] == 1 and len(f["data"]["products"]) == 1, "the first backup holds the product and is a normal Invoisy backup")
        check(isinstance(f["revision"], int) and f["revision"] == int(text(page, "#autoBackedRevision")) == int(text(page, "#autoDbRevision")), "file revision = last backed-up revision = database revision (%s)" % f["revision"])
        check(text(page, "#autoLast") != "Never", "last successful backup time is shown")

        # 3. every kind of change updates the file with no button pressed
        go(page, "stock")
        page.fill("#rQty", "5")
        page.click('#restockForm button[type="submit"]')
        page.wait_for_function("document.querySelector('#stockBody tr td:nth-child(4)').textContent.trim().startsWith('15')")
        go(page, "settings")
        wait_status(page, "Backup current")
        check(file_json(page)["data"]["products"][0]["stock"] == 15, "restock 10 + 5 is in the file")

        sell(page, 2, "1000")
        go(page, "settings"); wait_status(page, "Backup current")
        f = file_json(page)
        check(len(f["data"]["invoices"]) == 1 and f["data"]["products"][0]["stock"] == 13 and f["data"]["invoiceCounter"] == 1, "the sale, its stock change and the counter are in the file together")

        go(page, "invoices")
        page.click('#invoiceBody button[data-action="pay"]')
        page.fill("#payAmount", "500")
        page.click("#payBtn")
        wait_payment_recorded(page)
        go(page, "settings"); wait_status(page, "Backup current")
        check([x["amount"] for x in file_json(page)["data"]["invoices"][0]["payments"]] == [1000, 500], "the later payment is in the payment history in the file")

        page.fill("#sName", "Timgad Ceramic")
        page.click('#settingsForm button[type="submit"]')
        check(wait_until(lambda: file_json(page)["data"]["settings"]["businessName"] == "Timgad Ceramic"), "changed business settings are in the file")
        wait_status(page, "Backup current")

        # 4. rapid transactions
        go(page, "stock")
        start_stock = file_json(page)["data"]["products"][0]["stock"]
        for i in range(1, 7):   # one after the other as fast as the screen accepts them, without waiting for the backup
            page.fill("#rQty", "1")
            page.click('#restockForm button[type="submit"]')
            page.wait_for_function("(n) => document.querySelector('#stockBody tr td:nth-child(4)').textContent.trim().startsWith(String(n))", arg=start_stock + i, timeout=10000)
        go(page, "settings")
        check(wait_until(lambda: file_json(page)["data"]["products"][0]["stock"] == start_stock + 6), "six quick restocks: the file ends up with the final stock (%s)" % (start_stock + 6))
        wait_status(page, "Backup current")
        check(revisions_match(page) and file_json(page)["revision"] == int(text(page, "#autoDbRevision")), "six quick restocks: the file carries the final database revision")

        # 5. reload: the handle is remembered by the browser, nothing is rewritten if the file is already current
        before = read_file(page)
        page.reload(); ready(page)
        wait_status(page, "Backup current")
        check(text(page, "#autoConnection") == "Connected" and text(page, "#autoFile") == "invoisy-data.json", "after reload: reconnected to the remembered file")
        after = read_file(page)
        check(after["text"] == before["text"] and after["modified"] == before["modified"], "after reload: a file that is already current was not rewritten")

        # 6. a full restart of the browser
        ctx.close()
        ctx, page = launch()
        page.goto(URL); ready(page)
        wait_status(page, "Backup current")
        check(text(page, "#autoConnection") == "Connected" and revisions_match(page), "after restarting the browser: reconnected and current")

        # 7. the file disappears (moved, deleted): the data is safe, the warning is clear, and choosing it again completes the backup
        page.evaluate("async () => { const root = await navigator.storage.getDirectory(); await root.removeEntry('invoisy-data.json'); }")
        go(page, "stock")
        page.fill("#rQty", "1")
        page.click('#restockForm button[type="submit"]')
        page.wait_for_function("document.querySelector('#stockBody tr td:nth-child(4)').textContent.trim().startsWith(String(%d))" % (start_stock + 7))
        go(page, "settings")
        wait_status(page, "Backup pending (the last attempt failed)")
        check("not found" in text(page, "#autoError").lower(), "missing file: the error says it was not found")
        check(text(page, "#dataSummary") == "1 product, 1 invoice" and page.is_visible("#backupReminder") and "Automatic backup needs attention" in text(page, "#backupReminder"), "missing file: the data is intact and the top bar shows a warning")
        check(page.is_visible("#autoRetry"), "missing file: the Retry button is offered")
        page.click("#autoChoose")
        wait_status(page, "Backup current")
        f = file_json(page)
        check(f["data"]["products"][0]["stock"] == start_stock + 7 and page.is_hidden("#backupReminder"), "choosing the file again completes the pending backup and clears the warning")

        # 8. the file is valid and imports through the normal restore
        text_now = read_file(page)["text"]
        path = os.path.join(OUT, "invoisy-data.json")
        open(path, "w", encoding="utf8").write(text_now)
        go(page, "stock")
        add_product(page, "Tile B")
        go(page, "settings"); wait_status(page, "Backup current")
        check(text(page, "#dataSummary") == "2 products, 1 invoice", "a second product was added")
        page.set_input_files("#importFile", path)
        page.wait_for_function("document.getElementById('toast').textContent.includes('Restore completed')", timeout=10000)
        check(text(page, "#dataSummary") == "1 product, 1 invoice", "the automatic file was imported with the existing restore: back to 1 product")
        wait_status(page, "Backup current")
        check(len(file_json(page)["data"]["products"]) == 1, "and the restore itself was written to the file")

        # 9. connecting a file that already holds a different backup asks first and keeps a copy
        page.evaluate("async () => { const root = await navigator.storage.getDirectory(); const h = await root.getFileHandle('invoisy-data.json'); const w = await h.createWritable(); await w.write(JSON.stringify({ application: 'Invoisy', formatVersion: 1, exportedAt: '2026-01-01T00:00:00.000Z', counts: { products: 0, invoices: 0 }, data: { products: [], invoices: [], settings: {}, invoiceCounter: 0 } })); await w.close(); }")
        with page.expect_download() as safety:
            page.click("#autoChoose")
        check("invoisy-before-autobackup-" in safety.value.suggested_filename, "a different backup in the file: a safety copy is downloaded first (%s)" % safety.value.suggested_filename)
        check(wait_until(lambda: len(file_json(page)["data"]["products"]) == 1), "and then the file holds Invoisy's data")
        wait_status(page, "Backup current")

        # 10. a file that is not an Invoisy backup is refused
        page.evaluate("async () => { const root = await navigator.storage.getDirectory(); const h = await root.getFileHandle('invoisy-data.json'); const w = await h.createWritable(); await w.write('{\"shopping\": [\"milk\"]}'); await w.close(); }")
        go(page, "settings")
        page.click("#autoChoose")
        page.wait_for_function("document.getElementById('dataError').textContent.length > 0")
        check("not an Invoisy backup" in text(page, "#dataError") and read_file(page)["text"] == '{"shopping": ["milk"]}', "a file that is not an Invoisy backup is refused and left untouched")

        check(errors == [], "no console or page errors: " + "; ".join(errors))
        ctx.close()

        # 11. a browser without the File System Access API
        ctx2 = p.chromium.launch_persistent_context(tempfile.mkdtemp(prefix="invoisy-noapi-"), accept_downloads=True)
        ctx2.add_init_script(NO_API)
        page2 = ctx2.new_page()
        errors2 = []
        page2.on("pageerror", lambda e: errors2.append(str(e)))
        page2.on("dialog", lambda d: d.accept())
        page2.goto(URL); ready(page2)
        check(text(page2, "#autoConnection") == "Not available in this browser" and "NOT enabled" in text(page2, "#autoNote") and page2.is_hidden("#autoChoose"), "no API: Settings says automatic backup is not available and does not offer it")
        add_product(page2, "Tile Z")
        go(page2, "settings")
        with page2.expect_download() as dl:
            page2.click("#exportBackup")
        check(dl.value.suggested_filename.startswith("invoisy-backup-"), "no API: the manual export still works")
        check(errors2 == [], "no API: no page errors")
        ctx2.close()
finally:
    if server:
        server.terminate()

print("\nartifacts in", OUT)
if problems:
    print("FAILED:", len(problems))
    for item in problems:
        print(" -", item)
    sys.exit(1)
print("ALL PASSED")

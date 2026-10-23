"""Real-browser check that Invoisy stays still while you work.

Optional and manual (NOT part of `npm test`; needs a browser):
    pip install playwright && playwright install chromium
    python3 tests/e2e/stability_check.py
Brand new browser profile and disposable IndexedDB / private file: no real business data is touched. The script serves the
repository on a free local port by itself (the live-reload simulation needs a secure context, which file:// is not).

What it covers:
  * ordinary operations never reload the document and finish without a message;
  * a live-reload tool watching the backup file (simulated: the page reloads when the file is written) can not interrupt the
    print-choice dialog, a sale being typed, or a payment/restock made while a sale is open;
  * the keyboard focus, caret and typed text survive a full redraw (another window saving, a language change);
  * the print choice prints the saved invoice, once, and the page is usable afterwards (window.print is a stand-in: a
    headless browser has no print dialog);
  * the browser still asks before leaving a page with an unsaved sale, and a deliberate reload keeps all saved data.
"""
import socket, subprocess, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
RES = "#results .result"
problems = []


def check(cond, label):
    print(("PASS " if cond else "FAIL ") + label)
    if not cond:
        problems.append(label)


INIT = """
(() => {
  const n = Number(sessionStorage.getItem('__docLoads') || 0) + 1;
  sessionStorage.setItem('__docLoads', String(n));            // one per real document load: a redraw does not count
  window.__printed = [];
  window.print = function () { window.__printed.push(document.title); };
  window.__toasts = [];
  document.addEventListener('DOMContentLoaded', () => {
    const t = document.getElementById('toast');
    new MutationObserver(() => { if (t.classList.contains('show')) window.__toasts.push(t.textContent); })
      .observe(t, { attributes: true, attributeFilter: ['class'], childList: true, characterData: true, subtree: true });
  });
})();
"""

# A live-reload server (VS Code "Live Server" and the like) reloads the page when a watched file changes. The backup file is
# a real file in the browser's private file system; closing a write to it reloads the page, as such a tool would.
LIVE = """
(() => {
  window.showSaveFilePicker = async () => {
    const root = await navigator.storage.getDirectory();
    return root.getFileHandle('invoisy-data.json', { create: true });
  };
  const proto = window.FileSystemWritableFileStream && FileSystemWritableFileStream.prototype;
  if (!proto) return;
  const close = proto.close;
  proto.close = async function () {
    const r = await close.apply(this, arguments);
    if (sessionStorage.getItem('__live') === '1') {
      const n = Number(sessionStorage.getItem('__liveReloads') || 0);
      if (n < 12) { sessionStorage.setItem('__liveReloads', String(n + 1)); setTimeout(() => location.reload(), 60); }
    }
    return r;
  };
})();
"""

PNG = bytes.fromhex("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f0005fe02fea7d66a8f0000000049454e44ae426082")


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def loads(page):
    return int(page.evaluate("sessionStorage.getItem('__docLoads')") or 0)


def eventually(fn, seconds=10):
    end = time.time() + seconds
    while time.time() < end:
        try:
            if fn():
                return True
        except Exception:
            pass   # the page was navigating
        time.sleep(0.1)
    return False


def ready(page):
    return eventually(lambda: page.evaluate("document.getElementById('dataState').textContent.trim() === 'Ready'"))


def live_reloads(page):
    return int(page.evaluate("sessionStorage.getItem('__liveReloads')") or 0)


def status(page):
    return page.evaluate("document.getElementById('autoStatus').textContent.trim()")


def go(page, view):
    page.click(f'.nav-btn[data-view="{view}"]')


def add_item(page, term, qty):
    page.fill("#search", term)
    page.wait_for_selector(RES)
    page.locator(RES).first.click()
    page.fill("#addQty", str(qty))
    page.click('#addForm button[type="submit"]')


def watch(page, ms):
    """Number of real document loads that happen during ms milliseconds."""
    before = loads(page)
    page.wait_for_timeout(ms)
    return loads(page) - before


def focus_state(page):
    return page.evaluate("(() => { const e = document.activeElement; return { id: e.id || e.dataset.action || e.tagName, value: e.value, s: e.selectionStart }; })()")


def typed_then_redrawn(page, label, selector, text="abc", how="reselect"):
    """Types into a box, forces a full redraw, and checks focus, text and caret are where they were."""
    box = page.locator(selector).first
    box.scroll_into_view_if_needed()
    box.click()
    page.keyboard.type(text)
    page.keyboard.press("ArrowLeft")
    before = focus_state(page)
    page.evaluate("document.querySelector('.nav-btn[aria-current=page]').click()")   # showView(current) -> renderAll()
    page.wait_for_timeout(60)
    after = focus_state(page)
    check(before == after, f"{label}: focus, text and caret survive a full redraw" + ("" if before == after else f" (before {before}, after {after})"))


def other_window_saves(ctx, url):
    other = ctx.new_page()
    other.add_init_script(INIT)
    other.goto(url)
    ready(other)
    go(other, "stock")
    other.select_option("#rProduct", index=1)
    other.fill("#rQty", "1")
    other.click('#restockForm button[type="submit"]')
    other.wait_for_timeout(400)
    other.close()


port = free_port()
server = subprocess.Popen([sys.executable, "-m", "http.server", str(port), "--bind", "127.0.0.1"], cwd=ROOT,
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
URL = f"http://127.0.0.1:{port}/index.html"
time.sleep(1)

try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context()
        page = ctx.new_page()
        errors, prompts = [], []
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append("PAGEERROR " + str(e)))

        def on_dialog(d):
            if d.type == "beforeunload":
                prompts.append(d.message)
            d.accept()

        page.on("dialog", on_dialog)
        ctx.add_init_script(INIT)
        ctx.add_init_script(LIVE)
        page.goto(URL)
        check(ready(page), "the page starts and the database is ready")

        # ---------- 1. ordinary operations: no reload, no message ----------
        go(page, "settings")
        page.click("#loadDemo")
        page.wait_for_timeout(300)
        go(page, "stock")
        page.fill("#pName", "Stability Tile")
        page.fill("#pTileSize", "60*60")
        page.fill("#pManufacturer", "Test Maker")
        page.fill("#pCoveragePerBox", "1.44")
        page.locator("#priceRows input[data-field='price']").first.fill("800")
        page.fill("#pStock", "20")
        page.click("#productSubmit")
        check(eventually(lambda: page.evaluate("document.getElementById('stockBody').textContent.includes('Stability Tile')")), "a product is added and appears in the stock table")
        page.select_option("#rProduct", index=1)
        page.fill("#rQty", "3")
        page.click('#restockForm button[type="submit"]')
        page.wait_for_timeout(200)
        go(page, "sell")
        page.fill("#custName", "Karim")
        page.fill("#custPhone", "0555 11 22 33")
        add_item(page, "choc", 2)
        add_item(page, "water", 1)
        check(page.input_value("#custName") == "Karim" and page.input_value("#custPhone") == "0555 11 22 33", "customer details survive adding products")
        check(page.locator("#saleBody tr").count() == 2, "two lines in the sale")
        page.click("#completeSale")
        check(eventually(lambda: page.evaluate("document.getElementById('saleDoneDialog').open")), "completing a sale opens the print-choice dialog")
        page.click("#saleDoneLater")
        go(page, "invoices")
        page.fill("#invoiceFilter", "karim")
        page.wait_for_timeout(100)
        check(page.locator("#invoiceBody tr").count() == 1, "filtering invoices")
        page.fill("#invoiceFilter", "nobody")
        page.wait_for_timeout(100)
        check(page.locator("#invoiceBody tr").count() == 0, "a filter that matches nothing shows nothing")
        page.fill("#invoiceFilter", "")
        page.locator('#invoiceBody [data-action="view"]').first.click()
        page.fill("#payAmount", "30")
        page.click("#payBtn")
        check(eventually(lambda: page.evaluate("document.getElementById('payAmount').value === ''")), "a partial payment is recorded; the invoice stays open in the preview")
        check(page.is_visible("#payBox"), "and the preview is still open")
        go(page, "settings")
        page.select_option("#sLanguage", "fr")
        page.wait_for_timeout(200)
        page.select_option("#sLanguage", "en")
        page.select_option("#sPaper", index=1) if page.locator("#sPaper").count() else None
        page.set_input_files("#logoFile", files=[{"name": "logo.png", "mimeType": "image/png", "buffer": PNG}])
        page.wait_for_timeout(300)
        check(loads(page) == 1, f"none of the above reloaded the document (document loads: {loads(page)})")
        check(page.evaluate("window.__toasts") == [], "and none of it announced itself with a message: " + repr(page.evaluate("window.__toasts")))

        # ---------- 2. a live-reload tool watching the backup file ----------
        go(page, "settings")
        page.click("#autoChoose")
        check(eventually(lambda: status(page) == "Backup current"), "automatic backup file connected and current")
        page.evaluate("sessionStorage.setItem('__live', '1')")   # from now on, writing the backup file reloads the page
        go(page, "sell")
        page.fill("#custName", "Lina")
        add_item(page, "choc", 2)
        printed_before = len(page.evaluate("window.__printed"))
        page.click("#completeSale")
        page.wait_for_selector("#saleDoneDialog[open]")
        reloads = watch(page, 2500)
        check(reloads == 0, f"the dialog is left alone for 2.5 s: no reload while it waits ({reloads})")
        check(page.evaluate("document.getElementById('saleDoneDialog').open"), "and it is still open")
        check(page.evaluate("document.activeElement.id") == "saleDonePrint", "with the keyboard on Print")
        check(status(page) == "Backup pending", "the backup file is waiting, and says so: " + status(page))
        number = page.inner_text("#saleDoneNumber").split(" ")[0]
        live_before = live_reloads(page)
        page.click("#saleDonePrint")
        page.wait_for_timeout(300)
        printed = page.evaluate("window.__printed")
        check(len(printed) == printed_before + 1 and printed[-1] == number, f"Print prints the saved invoice, once ({number}; printed {printed[printed_before:]})")
        check(not page.evaluate("document.getElementById('saleDoneDialog').open"), "and the dialog is closed")
        # the backup is written after the answer; the simulated live-reload tool then reloads the page (once, at this quiet moment)
        check(eventually(lambda: live_reloads(page) > live_before, 12), "after the answer the backup file is written (and the simulated tool reloads the page once)")
        check(ready(page) and eventually(lambda: status(page) == "Backup current", 12), "the page comes back ready, with the backup current")
        go(page, "invoices")
        check(page.locator("#invoiceBody tr").count() == 2, "both invoices are kept (the print did not duplicate or lose one)")

        # ---------- 3. typing a new sale, and a change made while a sale is open ----------
        go(page, "sell")
        page.fill("#custName", "Lina 2")
        add_item(page, "water", 1)
        page.click("#completeSale")
        page.wait_for_selector("#saleDoneDialog[open]")
        page.click("#saleDoneNew")
        page.fill("#custName", "Next customer")
        prompts_before = len(prompts)
        reloads = watch(page, 2500)
        check(reloads == 0 and len(prompts) == prompts_before, f"typing the next customer: no reload, no 'leave page?' prompt ({reloads} reloads)")
        check(page.input_value("#custName") == "Next customer", "and what was typed is still there")
        add_item(page, "choc", 1)
        go(page, "stock")
        page.select_option("#rProduct", index=1)
        page.fill("#rQty", "2")
        page.click('#restockForm button[type="submit"]')
        reloads = watch(page, 2500)
        check(reloads == 0 and len(prompts) == prompts_before, f"a restock while a sale is open: no reload, no prompt ({reloads} reloads)")
        go(page, "sell")
        check(page.input_value("#custName") == "Next customer" and page.locator("#saleBody tr").count() == 1, "the sale being prepared is intact")

        # ---------- 4. unsaved work is still protected; saved data survives a deliberate reload ----------
        page.evaluate("sessionStorage.setItem('__live', '0')")
        prompts_before = len(prompts)
        invoices_before = None
        page.reload()
        check(len(prompts) == prompts_before + 1, "reloading with an unsaved sale on screen asks first")
        check(ready(page), "after the reload the page is ready")
        go(page, "invoices")
        invoices_before = page.locator("#invoiceBody tr").count()
        check(invoices_before == 3, f"every saved invoice is still there after a deliberate reload ({invoices_before})")
        prompts_before = len(prompts)
        page.reload()
        check(len(prompts) == prompts_before, "reloading with nothing unsaved does not ask")
        ready(page)

        # ---------- 5. rapid clicks and repeated Enter ----------
        go(page, "sell")
        page.fill("#custName", "Rapid")
        add_item(page, "choc", 1)
        printed_before = len(page.evaluate("window.__printed"))
        page.locator("#completeSale").click(click_count=3, delay=10)
        page.wait_for_timeout(500)
        page.keyboard.press("Enter")
        page.keyboard.press("Enter")
        page.wait_for_timeout(300)
        check(page.evaluate("document.getElementById('saleDoneDialog').open"), "three quick clicks and two Enters leave the dialog open")
        check(len(page.evaluate("window.__printed")) == printed_before, "and nothing was printed behind your back")
        page.click("#saleDoneLater")
        go(page, "invoices")
        check(page.locator("#invoiceBody tr").count() == invoices_before + 1, "exactly one invoice was recorded")

        # ---------- 6. a full redraw while typing ----------
        go(page, "sell")
        page.fill("#custName", "")
        add_item(page, "choc", 2)
        typed_then_redrawn(page, "sell: customer name", "#custName")
        typed_then_redrawn(page, "sell: amount paid", "#amountPaid", "5")
        typed_then_redrawn(page, "sell: a quantity in the sale table", "#saleBody input[data-field=qty]", "1")
        go(page, "stock")
        typed_then_redrawn(page, "stock: filter", "#stockFilter")
        typed_then_redrawn(page, "stock: restock quantity", "#rQty", "5")
        page.fill("#stockFilter", "")
        btn = page.locator('#stockBody [data-action="inc"]').first
        btn.focus()
        page.keyboard.press("Enter")
        page.wait_for_timeout(300)
        check(page.evaluate("document.activeElement.dataset.action") == "inc", "stock: after + with the keyboard the focus stays on the button")
        before = page.locator("#stockBody tr").first.inner_text()
        page.keyboard.press("Enter")
        page.wait_for_timeout(300)
        check(page.locator("#stockBody tr").first.inner_text() != before, "so a second Enter adds again")
        go(page, "invoices")
        typed_then_redrawn(page, "invoices: filter", "#invoiceFilter")
        page.fill("#invoiceFilter", "")

        # another window saving redraws this one: Purchases/Suppliers search boxes and typed Settings must survive
        for view, box in (("purchases", "#purSearch"), ("suppliers", "#supSearch")):
            go(page, view)
            page.click(box)
            page.keyboard.type("abc")
            page.keyboard.press("ArrowLeft")
            before = focus_state(page)
            other_window_saves(ctx, URL)
            page.wait_for_timeout(500)
            after = focus_state(page)
            check(before == after, f"{view}: search box keeps focus, text and caret when another window saves" + ("" if before == after else f" ({before} -> {after})"))
        go(page, "settings")
        page.click("#sName")
        page.keyboard.type(" TYPED")
        typed = page.input_value("#sName")
        other_window_saves(ctx, URL)
        page.wait_for_timeout(500)
        check(page.input_value("#sName") == typed, "settings: a business name being typed survives another window saving")
        page.select_option("#sLanguage", "fr")
        page.wait_for_timeout(300)
        check(page.input_value("#sName") == typed, "and a language change")
        page.select_option("#sLanguage", "en")
        page.wait_for_timeout(200)
        page.click('#settingsForm button[type="submit"]')
        page.wait_for_timeout(300)
        go(page, "stock")
        go(page, "settings")
        check(page.input_value("#sName") == typed, "Save Settings stores what was typed")

        check(errors == [], "no console or page errors during the whole run: " + "; ".join(errors[:3]))
        browser.close()
finally:
    server.terminate()

if problems:
    print("\nFAILED:", problems)
    sys.exit(1)
print("\nAll stability checks passed.")

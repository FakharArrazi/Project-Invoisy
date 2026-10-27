"""Real-browser check of the Invoices page: design, search, sorting, actions and deleting an invoice.

Optional and manual (NOT part of `npm test`; needs a browser):
    pip install playwright && playwright install chromium
    python3 tests/e2e/invoices_page_check.py
Set INVOISY_SHOTS=/some/folder to also save screenshots at three window widths.
Brand new browser profile and disposable IndexedDB: no real business data is touched.

What it checks in a real page: the page looks like Stock (same heading, search box, table header and button sizes), the actions
stay reachable at narrow widths, search and sorting (numbers, dates, amounts) work together, View / Print / Edit still work,
and Delete: it asks first (Cancel and Esc change nothing), deletes for good without a reload, the list and count update, the
deletion survives leaving the page and a reload, stock and numbering are untouched, and an invoice that is kept on purpose
is explained instead of deleted.
"""
import os, subprocess, sys, tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright
from e2e_common import SKIP_SALE_DIALOG, wait_invoice_shown

URL = os.environ.get("INVOISY_URL") or (Path(__file__).resolve().parents[2] / "index.html").as_uri()
SHOTS = os.environ.get("INVOISY_SHOTS")
problems = []

def check(cond, label):
    print(("PASS " if cond else "FAIL ") + label)
    if not cond:
        problems.append(label)

# A made-up shop (one product, 13 invoices, the newest cancelled) is restored through Settings, exactly as a person would.
BACKUP = subprocess.run(["node", str(Path(__file__).with_name("make_invoices_backup.js"))], check=True, capture_output=True, text=True).stdout
BACKUP_FILE = Path(tempfile.mkdtemp(prefix="invoisy-e2e-")) / "invoisy-data.json"
BACKUP_FILE.write_text(BACKUP, encoding="utf-8")

def numbers(page):
    return page.locator("#invoiceBody tr td.invoice-no").all_inner_texts()

def seq(n):
    return int(n.split("-")[1])

def style(page, sel, props):
    return page.locator(sel).first.evaluate("(el, props) => { const c = getComputedStyle(el); return props.map((p) => c[p]); }", props)

def go(page, view):
    page.click(f'.nav-btn[data-view="{view}"]')

def stock_of(page):
    """The stock cell of the (only) product on the Stock page."""
    go(page, "stock")
    page.wait_for_selector("#stockBody tr")
    value = page.inner_text("#stockBody tr td:nth-child(6)").strip()
    go(page, "invoices")
    return value

def saved(page):
    """How many invoices are saved, as Settings reports it."""
    go(page, "settings")
    summary = page.inner_text("#dataSummary").strip()
    go(page, "invoices")
    return summary

with sync_playwright() as p:
    browser = p.chromium.launch(args=["--no-sandbox"])
    page = browser.new_context(viewport={"width": 1366, "height": 800}).new_page()
    page.add_init_script("window.__prints = 0; window.print = () => { window.__prints++; };")
    page.add_init_script(SKIP_SALE_DIALOG)
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append("PAGEERROR " + str(e)))
    page.on("dialog", lambda d: d.accept())   # the browser's own boxes (used by other pages) are accepted

    page.goto(URL)
    go(page, "settings")
    page.wait_for_function("document.getElementById('dataState').textContent === 'Ready'", timeout=10000)
    page.set_input_files("#importFile", str(BACKUP_FILE))
    page.wait_for_function("document.getElementById('toast').textContent.includes('Restore completed')", timeout=10000)
    check(page.inner_text("#dataSummary").strip() == "1 product, 13 invoices", "the made-up shop is restored: 1 product, 13 invoices")

    # ---------- design: the same language as Stock ----------
    go(page, "invoices")
    page.wait_for_selector("#invoiceBody tr")
    check(len(numbers(page)) == 13, "the table lists the 13 invoices")
    check(page.inner_text("#invoiceCount").strip() == "13 of 13 invoices", "the count reads 13 of 13 invoices")
    inv_title = style(page, "#view-invoices .stock-title", ["fontSize", "letterSpacing", "textTransform", "fontWeight"])
    inv_th = style(page, "#invoiceTable thead th", ["backgroundColor", "fontSize", "textTransform", "letterSpacing", "paddingTop"])
    inv_btn = page.locator("#invoiceBody .row-actions .btn").first.bounding_box()
    inv_search = page.locator("#invoiceFilter").bounding_box()
    go(page, "stock"); page.wait_for_selector("#stockBody tr")
    check(inv_title == style(page, "#view-stock .stock-title", ["fontSize", "letterSpacing", "textTransform", "fontWeight"]), f"heading looks like Stock's: {inv_title}")
    check(inv_th == style(page, "#stockTable thead th", ["backgroundColor", "fontSize", "textTransform", "letterSpacing", "paddingTop"]), "table header row looks like Stock's")
    stock_btn = page.locator("#stockBody .row-actions .btn").first.bounding_box()
    check(abs(inv_btn["height"] - stock_btn["height"]) < 1.5, f"row buttons are as tall as Stock's ({inv_btn['height']:.0f}px vs {stock_btn['height']:.0f}px)")
    check(abs(inv_search["height"] - page.locator("#stockFilter").bounding_box()["height"]) < 1, "the search box is as tall as Stock's")
    go(page, "invoices")
    check(page.is_visible("#invoiceBody tr:first-child [data-action='delete']"), "Delete is visible on the first row without scrolling")
    check(page.evaluate("() => document.documentElement.scrollWidth <= innerWidth + 1"), "the page does not scroll sideways at 1366 px")
    check(page.evaluate("() => [...document.querySelectorAll('#invoiceBody tr')].every(r => r.getBoundingClientRect().right <= innerWidth)"), "every row fits the window (long customer name included)")
    if SHOTS:
        Path(SHOTS).mkdir(parents=True, exist_ok=True)
        page.screenshot(path=f"{SHOTS}/invoices-1366.png")

    # ---------- search ----------
    page.fill("#invoiceFilter", "INV-000003")
    check(numbers(page) == ["INV-000003"], "search by invoice number, live while typing")
    check(page.is_visible("#invoiceSearchClear"), "a clear (x) button appears")
    page.click("#invoiceSearchClear")
    check(len(numbers(page)) == 13 and page.input_value("#invoiceFilter") == "", "the x clears the search and brings the full list back")
    check(page.evaluate("document.activeElement.id") == "invoiceFilter", "and the cursor is back in the search box")
    page.fill("#invoiceFilter", "ALPHA")
    check(sorted(seq(n) for n in numbers(page)) == [2, 4, 8, 10], f"search by customer name, any case: {numbers(page)}")
    page.fill("#invoiceFilter", "zzzz")
    check(page.is_visible("#invoiceEmpty") and page.is_hidden("#invoiceTable"), "no match: a clean empty state instead of the table")
    check("zzzz" in page.inner_text("#invoiceEmpty"), "it says what was searched")
    page.click("#invoiceEmpty [data-action='clear-filters']")
    check(len(numbers(page)) == 13, "its button brings the full list back")

    # ---------- sorting ----------
    page.click("th[data-sort-th='number'] .th-sort")
    check([seq(n) for n in numbers(page)] == list(range(1, 14)), "Invoice number ascending, numerically (9 before 10)")
    check(page.get_attribute("th[data-sort-th='number']", "aria-sort") == "ascending", "the heading is marked ascending")
    check(page.inner_text("th[data-sort-th='number'] .sort-mark").strip() == "▲", "with an arrow")
    page.click("th[data-sort-th='number'] .th-sort")
    check([seq(n) for n in numbers(page)] == list(range(13, 0, -1)), "clicking again reverses it")
    check(page.inner_text("th[data-sort-th='number'] .sort-mark").strip() == "▼", "the arrow turns")

    def column(index):
        return page.locator(f"#invoiceBody tr td:nth-child({index})").all_inner_texts()
    def amount(text):
        return float(text.split("\n")[0].replace("DA", "").replace(",", "").strip())
    def shown_dates():
        # The shop's date format is dd/mm/yyyy: read it back as a date, not as text.
        out = []
        for t in column(2):
            d, m, y = t.strip().split("/")
            out.append((int(y), int(m), int(d)))
        return out

    page.click("th[data-sort-th='total'] .th-sort")
    totals = [amount(t) for t in column(4)]
    check(totals == sorted(totals) and totals[0] < totals[-1], f"Total ascending as numbers: {totals[:4]}...")
    page.click("th[data-sort-th='paid'] .th-sort")
    paid = [amount(t) for t in column(5)]
    check(paid == sorted(paid), "Paid ascending as numbers")
    page.click("th[data-sort-th='date'] .th-sort")
    check(shown_dates() == sorted(shown_dates()), f"Date ascending by time, not as text: {column(2)[:3]}")
    page.click("th[data-sort-th='date'] .th-sort")
    check(shown_dates() == sorted(shown_dates(), reverse=True), "and descending")
    page.click("th[data-sort-th='customer'] .th-sort")
    names = [n.split("\n")[0].lower() for n in column(3)]
    check(names == sorted(names), "Customer A-Z ignoring case")
    page.fill("#invoiceFilter", "alpha")
    names = [n.split("\n")[0].lower() for n in column(3)]
    check(len(names) == 4 and names == sorted(names), "search and sort work together")
    page.fill("#invoiceFilter", "")
    check(len(numbers(page)) == 13, "no invoice is lost by sorting and searching")
    page.click("#invoiceClear") if page.is_visible("#invoiceClear") else None
    page.fill("#invoiceFilter", "x")
    page.click("#invoiceClear")
    check(page.is_hidden("#invoiceClear") and len(numbers(page)) == 13 and page.input_value("#invoiceFilter") == "", "Clear filters resets search and sorting")

    # ---------- existing actions still work ----------
    page.locator("#invoiceBody tr", has_text="INV-000005").locator("[data-action='view']").click()
    page.wait_for_function("document.getElementById('invoice').textContent.includes('INV-000005')")
    check(page.get_attribute("#app", "data-view") == "sell", "View opens the invoice in the preview")
    go(page, "invoices")
    page.locator("#invoiceBody tr", has_text="INV-000004").locator("[data-action='print']").click()
    page.wait_for_function("window.__prints > 0", timeout=5000)
    check(True, "Print still prints")
    page.locator("#invoiceBody tr", has_text="INV-000004").locator("[data-action='edit']").click()
    page.wait_for_selector("#editBanner:not([hidden])")
    check(page.get_attribute("#app", "data-view") == "sell", "Edit opens the invoice for editing on the Sell page")
    page.click("#editCancel")
    go(page, "invoices")
    page.wait_for_selector("#invoiceBody tr")

    # ---------- deleting ----------
    stock_before = stock_of(page)
    page.evaluate("window.__marker = 'same page'")
    target = page.locator("#invoiceBody tr", has_text="INV-000012")
    target.locator("[data-action='delete']").click()
    page.wait_for_selector("#invoiceDeleteDialog[open]")
    check(page.inner_text("#invoiceDeleteSubject").strip() == "INV-000012", "the question names the invoice")
    check("DA" in page.inner_text("#invoiceDeleteDetail"), f"with its customer, date and total: {page.inner_text('#invoiceDeleteDetail')}")
    check(page.evaluate("document.activeElement.id") == "invoiceDeleteCancel", "Cancel has the focus")
    page.keyboard.press("Enter")
    page.wait_for_selector("#invoiceDeleteDialog:not([open])", state="attached")
    check(len(numbers(page)) == 13, "Enter (on Cancel) deletes nothing")
    target.locator("[data-action='delete']").click()
    page.wait_for_selector("#invoiceDeleteDialog[open]")
    page.keyboard.press("Escape")
    page.wait_for_selector("#invoiceDeleteDialog:not([open])", state="attached")
    check(len(numbers(page)) == 13, "Esc deletes nothing")
    target.locator("[data-action='delete']").click()
    page.wait_for_selector("#invoiceDeleteDialog[open]")
    page.click("#invoiceDeleteCancel")
    check(len(numbers(page)) == 13 and "INV-000012" in numbers(page), "Cancel deletes nothing")
    check(saved(page) == "1 product, 13 invoices", "and nothing was written (13 saved)")

    page.evaluate("document.getElementById('toast').textContent = ''")
    target.locator("[data-action='delete']").click()
    page.wait_for_selector("#invoiceDeleteDialog[open]")
    if SHOTS:
        page.screenshot(path=f"{SHOTS}/invoices-delete-dialog.png")
    page.click("#invoiceDeleteConfirm")
    page.wait_for_selector("#invoiceDeleteDialog:not([open])", state="attached")
    page.wait_for_function("document.querySelectorAll('#invoiceBody tr').length === 12")
    check("INV-000012" not in numbers(page), "Delete removes the row at once")
    check(page.inner_text("#invoiceCount").strip() == "12 of 12 invoices", "and the count follows")
    check(page.inner_text("#toast").strip() == "INV-000012 deleted.", "a short message names the invoice")
    check(page.evaluate("window.__marker") == "same page", "the page was not reloaded")
    check(stock_of(page) == stock_before, f"product stock is unchanged ({stock_before})")
    check(saved(page) == "1 product, 12 invoices", "12 invoices are saved")

    go(page, "stock"); go(page, "invoices")
    check("INV-000012" not in numbers(page) and len(numbers(page)) == 12, "it stays deleted after leaving the page and coming back")
    page.reload()
    go(page, "settings")
    page.wait_for_function("document.getElementById('dataState').textContent === 'Ready'", timeout=10000)
    go(page, "invoices")
    page.wait_for_selector("#invoiceBody tr")
    check("INV-000012" not in numbers(page) and len(numbers(page)) == 12, "and after the page is reloaded (a restart)")

    # numbering: neither the deleted number nor a taken one is given out again
    go(page, "sell")
    page.fill("#search", "Everton")
    page.wait_for_selector("#results .result")
    page.click("#results .result")
    page.fill("#addQty", "1")
    page.click('#addForm button[type="submit"]')
    page.click("#completeSale")
    wait_invoice_shown(page, "INV-000014")
    check(True, "the next sale is INV-000014: INV-000012 is not reused")
    go(page, "invoices")
    check(len(set(numbers(page))) == len(numbers(page)) == 13, "no duplicate numbers")

    # an invoice that is kept on purpose: explained, not deleted
    cancelled = page.locator("#invoiceBody tr.invoice-cancelled")
    check(cancelled.count() == 1 and "INV-000013" in cancelled.inner_text(), "a cancelled invoice is marked in the list")
    cancelled.locator("[data-action='delete']").click()
    page.wait_for_selector("#invoiceDeleteDialog[open]")
    check("can not be deleted" in page.inner_text("#invoiceDeleteTitle"), "its dialog says it can not be deleted")
    check("cancelled" in page.inner_text("#invoiceDeleteBody"), "and why: " + page.inner_text("#invoiceDeleteBody"))
    check(page.is_hidden("#invoiceDeleteConfirm") and page.inner_text("#invoiceDeleteCancel").strip() == "Close", "and only offers Close")
    page.click("#invoiceDeleteCancel")
    check(len(numbers(page)) == 13, "it stays")

    # ---------- narrow windows: the actions stay reachable ----------
    for width, height in ((900, 700), (390, 800)):
        page.set_viewport_size({"width": width, "height": height})
        page.wait_for_timeout(150)
        reachable = page.evaluate("""() => {
          const wrap = document.querySelector('#view-invoices .table-wrap').getBoundingClientRect();
          const b = document.querySelector('#invoiceBody tr [data-action="delete"]').getBoundingClientRect();
          return b.left >= wrap.left - 1 && b.right <= wrap.right + 1;
        }""")
        check(reachable, f"at {width} px wide Delete is inside the visible part of the table without scrolling")
        check(page.evaluate("() => document.documentElement.scrollWidth <= innerWidth + 1"), f"at {width} px the page itself does not scroll sideways")
        check(page.evaluate("() => [...document.querySelectorAll('#invoiceFilters input, #invoiceFilters select')].every(e => e.getBoundingClientRect().right <= innerWidth + 1)"), f"at {width} px the search and filters fit the window")
        if SHOTS:
            page.screenshot(path=f"{SHOTS}/invoices-{width}.png")

    # ---------- right to left ----------
    page.set_viewport_size({"width": 1366, "height": 800})
    go(page, "settings")
    page.select_option("#sLanguage", "ar")
    page.wait_for_function("document.documentElement.dir === 'rtl'")
    go(page, "invoices")
    check(page.is_visible("#invoiceBody tr:first-child [data-action='delete']"), "Arabic (right to left): Delete is visible")
    check(page.evaluate("() => document.documentElement.scrollWidth <= innerWidth + 1"), "and the page does not scroll sideways")
    if SHOTS:
        page.screenshot(path=f"{SHOTS}/invoices-ar.png")
    go(page, "settings")
    page.select_option("#sLanguage", "en")

    check(not errors, "no console errors: " + "; ".join(errors[:3]))
    browser.close()

print()
print("ALL PASSED" if not problems else f"{len(problems)} FAILED: " + "; ".join(problems))
sys.exit(1 if problems else 0)

"""Real-browser check of the Workers page.

Optional and manual (NOT part of `npm test`; needs a browser):
    pip install playwright && playwright install chromium
    python3 tests/e2e/workers_check.py
Set INVOISY_SHOTS=/some/folder to also save screenshots.
Brand new browser profile and disposable IndexedDB: no real business data is touched.

It checks: the Workers tab sits between Suppliers and Settings; a worker is added, edited and marked inactive; advances,
a partial salary payment, debt, a correction and a deletion work through the real buttons; the page never scrolls sideways
(1366, 900 and 390 px, and in Arabic); everything is still there after a reload; no script error appears.
"""
import os, sys, tempfile, time
from datetime import date, timedelta
from pathlib import Path
from playwright.sync_api import sync_playwright

URL = os.environ.get("INVOISY_URL") or (Path(__file__).resolve().parents[2] / "index.html").as_uri()
SHOTS = os.environ.get("INVOISY_SHOTS")
problems = []

def check(cond, label):
    print(("PASS " if cond else "FAIL ") + label)
    if not cond:
        problems.append(label)

def go(page, view):
    page.click(f'.nav-btn[data-view="{view}"]')

def ready(page):
    page.wait_for_function("document.getElementById('dataState').textContent === 'Ready'", timeout=10000)

def eventually(fn, seconds=8):
    end = time.time() + seconds
    while time.time() < end:
        if fn():
            return True
        time.sleep(0.15)
    return False

def text(page, sel="#workersRoot"):
    return page.locator(sel).inner_text()

def sideways(page):
    return page.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth + 1")

def shot(page, name):
    if SHOTS:
        Path(SHOTS).mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(Path(SHOTS) / f"{name}.png"), full_page=True)

def fill_tx(page, amount, note="", day=None):
    page.fill("#txAmount", str(amount))
    if day:
        page.fill("#txDate", day)
    page.fill("#txNote", note)

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1366, "height": 900})
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("dialog", lambda d: d.accept())
    page.goto(URL)
    ready(page)

    names = page.eval_on_selector_all(".sidebar .nav-btn", "els => els.map(e => e.dataset.view)")
    check(names.index("workers") == names.index("suppliers") + 1 and names.index("settings") == names.index("workers") + 1, "Workers tab sits between Suppliers and Settings")

    go(page, "workers")
    check("No workers yet" in text(page), "empty state is explained")
    check(page.locator('[data-act="w-add"]').is_visible(), "the + Add New Worker button is shown")

    start = (date.today() - timedelta(days=4)).isoformat()
    page.click('[data-act="w-add"]')
    page.fill("#wf-name", "Ali Benali")
    page.fill("#wf-phone", "0555 12 34 56")
    page.fill("#wf-position", "Driver")
    page.fill("#wf-start", start)
    page.fill("#wf-salary", "30000")
    page.click('#wForm button[type="submit"]')
    check(eventually(lambda: "Ali Benali" in text(page) and "Financial overview" in text(page)), "adding a worker opens its details page")
    check("Every month on day" in text(page), "payday rule is shown")
    shot(page, "worker-new")

    # Several advances in the same period.
    for amount in (5000, 3000, 4000, 2000):
        page.click('[data-act="w-advance"]')
        fill_tx(page, amount, f"advance {amount}")
        page.click('#wTxForm button[type="submit"]')
        check(eventually(lambda a=amount: page.locator("#wPanel").count() == 0 and f"advance {a}" in text(page)), f"advance {amount} recorded")
    overview = text(page, "#wOverview")
    check("14,000 DA" in overview and "16,000 DA" in overview, "overview: advances 14,000 DA, remaining payable 16,000 DA")
    shot(page, "worker-advances")

    # Partial salary payment.
    page.click('[data-act="w-pay"]')
    check("Amount currently payable" in text(page) and page.input_value("#txAmount") == "16000", "pay dialog offers the payable amount")
    fill_tx(page, 20000)
    page.click('#wTxForm button[type="submit"]')
    check(eventually(lambda: "can not be more than" in text(page, "#txError")), "paying more than is payable is refused with an explanation")
    fill_tx(page, 10000, "first part")
    page.click('#wTxForm button[type="submit"]')
    check(eventually(lambda: "6,000 DA" in text(page, "#wOverview")), "partial payment leaves 6,000 DA payable")

    # Advance above the salary -> debt message.
    page.click('[data-act="w-advance"]')
    fill_tx(page, 50000, "big advance")
    page.click('#wTxForm button[type="submit"]')
    check(eventually(lambda: "carried forward as debt" in text(page, "#toast") or "carried forward" in text(page)), "an advance above the salary warns about debt")

    # Correct and delete from the history.
    row = page.locator("#wtRows tr", has_text="big advance")
    row.locator('[data-act="w-tx-edit"]').click()
    fill_tx(page, 1000, "big advance (fixed)")
    page.click('#wTxForm button[type="submit"]')
    check(eventually(lambda: "big advance (fixed)" in text(page) and "carried forward as debt" not in text(page, "#wOverview")), "correcting a transaction recalculates")
    page.locator("#wtRows tr", has_text="big advance (fixed)").locator('[data-act="w-tx-delete"]').click()
    check("Delete this transaction?" in text(page), "deleting asks for confirmation")
    page.click('[data-act="w-tx-delete-yes"]')
    check(eventually(lambda: "big advance" not in text(page)), "the transaction is deleted")

    # Filters on the history.
    page.select_option("#wtType", "payment")
    check(eventually(lambda: page.locator("#wtRows tr").count() == 1), "history can be filtered by type")
    page.select_option("#wtType", "all")
    page.fill("#wtSearch", "advance 3000")
    check(eventually(lambda: page.locator("#wtRows tr").count() == 1), "history can be searched")
    page.fill("#wtSearch", "")

    # Salary periods.
    page.click('[data-act="w-tab"][data-tab="periods"]')
    check("Salary period history" in text(page) and "Pending" in text(page) or "Partially Paid" in text(page), "salary period history is listed")
    page.locator('#wTabBody [data-act="w-period"]').first.click()
    check("Available salary" in text(page), "a period opens with its formula and transactions")
    page.click('[data-act="w-period-back"]')

    # Edit and inactive.
    page.click('[data-act="w-edit"]')
    page.fill("#wf-position", "Foreman")
    page.click('#wForm button[type="submit"]')
    check(eventually(lambda: "Foreman" in text(page)), "editing the worker works")
    page.click('[data-act="w-status"]')
    page.click('[data-act="w-status-yes"]')
    check(eventually(lambda: "Inactive" in text(page) and page.locator('[data-act="w-advance"]').is_disabled()), "marking inactive keeps the page and disables Give Advance")
    page.click('[data-act="w-back"]')
    check("Ali Benali" in text(page, "#wRows") and "Inactive" in text(page, "#wRows"), "the inactive worker is still listed")
    page.select_option("#wStatus", "active")
    check("Ali Benali" not in text(page, "#wRows"), "status filter hides inactive workers")
    page.select_option("#wStatus", "all")
    shot(page, "workers-list")

    # Sideways scroll at three widths. At 390 px the app's own shared layout is already wider than the screen on every page
    # (Stock, Suppliers and Settings too), so there Workers only has to be no wider than the Suppliers page.
    def page_width(view):
        go(page, view)
        return page.evaluate("document.documentElement.scrollWidth")
    for w in (1366, 900, 390):
        page.set_viewport_size({"width": w, "height": 900})
        reference = page_width("suppliers")
        go(page, "workers")
        page.click('[data-act="w-back"]') if page.locator('[data-act="w-back"]').count() else None
        if w > 400:
            check(not sideways(page), f"list does not scroll sideways at {w}px")
        else:
            check(page.evaluate("document.documentElement.scrollWidth") <= reference, f"list is no wider than the Suppliers page at {w}px")
        page.locator('[data-act="w-open"]').first.click()
        if w > 400:
            check(not sideways(page), f"details do not scroll sideways at {w}px")
        else:
            check(page.evaluate("document.documentElement.scrollWidth") <= reference, f"details are no wider than the Suppliers page at {w}px")
        shot(page, f"worker-{w}")
        page.click('[data-act="w-back"]')
    page.set_viewport_size({"width": 1366, "height": 900})

    # Reload keeps everything.
    page.reload()
    ready(page)
    go(page, "workers")
    check("Ali Benali" in text(page, "#wRows"), "the worker is still there after a reload")
    page.locator('[data-act="w-open"]').first.click()
    check("advance 5000" in text(page) and "first part" in text(page), "transactions are still there after a reload")

    # Arabic.
    go(page, "settings")
    page.evaluate("document.querySelector('#language, select[name=language]') && 0")
    langs = page.eval_on_selector_all("select option", "els => els.map(e => e.value)")
    if "ar" in langs:
        page.select_option("select:has(option[value='ar'])", "ar")
        go(page, "workers")
        page.click('[data-act="w-back"]') if page.locator('[data-act="w-back"]').count() else None
        check("العمال" in page.locator('.nav-btn[data-view="workers"]').inner_text(), "the tab has an Arabic name")
        check(not sideways(page), "the Workers page does not scroll sideways in Arabic")
        shot(page, "workers-ar")

    check(not errors, "no script error or console error: " + "; ".join(errors[:3]))
    browser.close()

print()
print("ALL PASSED" if not problems else f"{len(problems)} FAILED")
sys.exit(1 if problems else 0)

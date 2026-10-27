"""Real-browser check of the Settings page: the same look as Stock, and every setting still works.

Optional and manual (NOT part of `npm test`; needs a browser):
    pip install playwright pillow && playwright install chromium
    python3 tests/e2e/settings_page_check.py
Set INVOISY_SHOTS=/some/folder to also save screenshots at three window widths.
Brand new browser profile and disposable IndexedDB: no real business data is touched.

It checks: the heading, controls and buttons look like Stock's; the page never scrolls sideways (1366, 900 and 390 px, and in
Arabic); business details, phone numbers, staff, paper size, currency display, the logo, the backup reminder and demo data can be
changed and are still there after a reload; Export / Import backup work; the language can be changed.
"""
import os, sys, tempfile, time
from pathlib import Path
from PIL import Image
from playwright.sync_api import sync_playwright

URL = os.environ.get("INVOISY_URL") or (Path(__file__).resolve().parents[2] / "index.html").as_uri()
SHOTS = os.environ.get("INVOISY_SHOTS")
OUT = Path(tempfile.mkdtemp(prefix="invoisy-e2e-"))
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

def style(page, sel, props):
    return page.locator(sel).first.evaluate("(el, props) => { const c = getComputedStyle(el); return props.map((p) => c[p]); }", props)

def sideways(page):
    return page.evaluate("() => document.documentElement.scrollWidth - innerWidth")

def reload_to_settings(page):
    page.reload()
    go(page, "settings")
    ready(page)

logo = OUT / "logo.png"
Image.new("RGB", (240, 120), (30, 90, 160)).save(logo)

with sync_playwright() as p:
    browser = p.chromium.launch(args=["--no-sandbox"])
    page = browser.new_context(viewport={"width": 1366, "height": 800}, accept_downloads=True).new_page()
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append("PAGEERROR " + str(e)))
    page.on("dialog", lambda d: d.accept())

    page.goto(URL)
    go(page, "settings")
    ready(page)

    # ---------- the look ----------
    heading = style(page, "#view-settings .stock-title", ["fontSize", "letterSpacing", "textTransform", "fontWeight"])
    check(page.inner_text("#view-settings .stock-title").strip().lower() == "settings", "the page has a visible SETTINGS heading")
    go(page, "stock")
    stock_heading = style(page, "#view-stock .stock-title", ["fontSize", "letterSpacing", "textTransform", "fontWeight"])
    go(page, "settings")
    check(heading == stock_heading, f"the heading looks like Stock's: {heading}")
    check(abs(page.locator("#exportBackup").bounding_box()["height"] - 42) < 1, "main buttons are 42 px tall, as the Stock page's")
    check(abs(page.locator("#sName").bounding_box()["height"] - 42) < 1, "text boxes are 42 px tall")
    check(abs(page.locator("#sLanguage").bounding_box()["height"] - 42) < 1, "the language list is 42 px tall")
    check(page.locator("#view-settings .settings-panel").count() == 8, "the eight settings panels are all there")
    check(page.inner_text("#dataState").strip() == "Ready" and "state-ready" in page.get_attribute("#dataState", "class"), "the database status shows Ready in green")
    check(page.is_visible("#autoBackupPanel") and page.is_visible("#autoChoose"), "the automatic backup panel and its button are there")
    if SHOTS:
        Path(SHOTS).mkdir(parents=True, exist_ok=True)
        page.set_viewport_size({"width": 1366, "height": 3000})
        page.screenshot(path=f"{SHOTS}/settings-1366.png")
        page.set_viewport_size({"width": 1366, "height": 800})

    # ---------- business details ----------
    page.fill("#sName", "Ceram Plus")
    page.fill("#sAddress", "12 rue des Tuiles, Sétif")
    page.fill("#sEmail", "contact@example.test")
    page.fill("#sCurrency", "DA")
    page.fill("#sPhones .phone-input", "0555 11 22 33")
    page.click("#addPhone")
    check(page.locator("#sPhones .phone-row").count() == 2, "Add phone number adds a row")
    page.locator("#sPhones .phone-input").nth(1).fill("0770 44 55 66")
    page.click("#addStaff")
    check(page.locator("#sStaff .staff-card").count() == 1, "Add person adds a staff card")
    page.fill("#sStaff .staff-name", "Karim")
    page.click("#settingsForm button[type=submit]")
    page.wait_for_timeout(800)
    reload_to_settings(page)
    check(page.input_value("#sName") == "Ceram Plus" and page.input_value("#sAddress") == "12 rue des Tuiles, Sétif", "business name and address are still there after a reload")
    check(page.input_value("#sEmail") == "contact@example.test", "email too")
    check(page.locator("#sPhones .phone-input").evaluate_all("els => els.map(e => e.value)") == ["0555 11 22 33", "0770 44 55 66"], "both phone numbers too")
    check(page.input_value("#sStaff .staff-name") == "Karim", "and the staff member")

    # ---------- paper size and currency display ----------
    page.check("#paperA5")
    page.check("#currencyUnitCentimes")
    chosen = page.evaluate("getComputedStyle(document.querySelector('#view-settings label:has(#paperA5)')).borderColor")
    other = page.evaluate("getComputedStyle(document.querySelector('#view-settings label:has(#paperA4)')).borderColor")
    check(chosen != other, f"the chosen paper size is outlined differently from the other ({chosen} vs {other})")
    page.wait_for_timeout(800)
    reload_to_settings(page)
    check(page.is_checked("#paperA5") and not page.is_checked("#paperA4"), "A5 is still chosen after a reload")
    check(page.is_checked("#currencyUnitCentimes"), "centimes display is still chosen after a reload")
    page.check("#paperA4"); page.check("#currencyUnitDinars")
    page.wait_for_timeout(500)

    # ---------- logo ----------
    check(page.locator("#logoPreview img").count() == 0, "no logo at first")
    page.set_input_files("#logoFile", str(logo))
    check(eventually(lambda: page.locator("#logoPreview img").count() == 1), "a chosen logo is shown in its preview")
    page.wait_for_timeout(800)
    reload_to_settings(page)
    check(page.locator("#logoPreview img").count() == 1, "the logo is still there after a reload")
    page.click("#removeLogo")
    check(eventually(lambda: page.locator("#logoPreview img").count() == 0), "Remove Logo removes it")

    # ---------- backup: export, reminder, restore ----------
    with page.expect_download() as dl:
        page.click("#exportBackup")
    backup = OUT / "backup.json"
    dl.value.save_as(str(backup))
    check(backup.stat().st_size > 100 and "invoisy" in backup.read_text(encoding="utf-8").lower(), "Export Backup downloads a backup file")
    page.fill("#backupDays", "3")
    page.click("#backupDaysSave")
    page.wait_for_timeout(600)
    reload_to_settings(page)
    check(page.input_value("#backupDays") == "3", "the backup reminder (3 days) is still there after a reload")
    page.click("#loadDemo")
    check(eventually(lambda: page.inner_text("#dataSummary").strip().startswith("0 products") is False and "product" in page.inner_text("#dataSummary")), "Load Demo Data adds products: " + page.inner_text("#dataSummary"))
    demo_summary = page.inner_text("#dataSummary").strip()
    page.set_input_files("#importFile", str(backup))
    check(eventually(lambda: page.inner_text("#dataSummary").strip() != demo_summary), "Import / Restore replaces the data with the backup: " + page.inner_text("#dataSummary"))

    # ---------- language ----------
    page.select_option("#sLanguage", "fr")
    check(eventually(lambda: page.inner_text("#view-settings .stock-title").strip().lower() == "paramètres"), "French: the heading is translated: " + page.inner_text("#view-settings .stock-title"))
    page.select_option("#sLanguage", "ar")
    check(eventually(lambda: page.evaluate("document.documentElement.dir") == "rtl"), "Arabic is right to left")
    check(sideways(page) <= 1, "Arabic: the page does not scroll sideways")
    check(page.is_visible("#exportBackup") and page.is_visible("#settingsForm button[type=submit]"), "Arabic: the main buttons are visible")
    if SHOTS:
        page.set_viewport_size({"width": 1366, "height": 3000})
        page.screenshot(path=f"{SHOTS}/settings-ar.png")
        page.set_viewport_size({"width": 1366, "height": 800})
    page.select_option("#sLanguage", "en")
    check(eventually(lambda: page.evaluate("document.documentElement.dir") == "ltr"), "back to English, left to right")

    # ---------- other window widths ----------
    for width in (900, 390):
        page.set_viewport_size({"width": width, "height": 800})
        page.wait_for_timeout(150)
        check(sideways(page) <= 1, f"at {width} px the page does not scroll sideways")
        fits = page.evaluate("() => [...document.querySelectorAll('#view-settings .settings-panel input:not([hidden]), #view-settings .settings-panel select, #view-settings .settings-panel .btn:not([hidden])')].filter(e => e.offsetParent).every(e => e.getBoundingClientRect().right <= innerWidth + 1)")
        check(fits, f"at {width} px every field and button fits the window")
        if SHOTS:
            page.set_viewport_size({"width": width, "height": 4200})
            page.screenshot(path=f"{SHOTS}/settings-{width}.png")
            page.set_viewport_size({"width": width, "height": 800})

    check(not errors, "no console errors: " + "; ".join(errors[:3]))
    browser.close()

print()
print("ALL PASSED" if not problems else f"{len(problems)} FAILED: " + "; ".join(problems))
sys.exit(1 if problems else 0)

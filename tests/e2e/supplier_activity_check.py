"""Real-browser check of the Suppliers table actions, the Good standing / Needs attention marks, the Supplier Activity page
and the shared Back buttons.

Optional and manual (NOT part of `npm test`; needs a browser):
    pip install playwright && playwright install chromium
    python3 tests/e2e/supplier_activity_check.py
Set INVOISY_SHOTS=/some/folder to also save screenshots (desktop and phone; English and Arabic).
Brand new browser profile and disposable IndexedDB: no real business data is touched. The made-up shop comes from
make_deposits_backup.js (three suppliers, purchases, payments and deposits).

What it checks in a real page: the Actions column is made of compact icon buttons that carry tooltips; marking a supplier
Good standing / Needs attention tints its row, only one mark is on at a time, pressing it again clears it, and the mark is
still there after the page is reloaded; the Supplier Activity page lists purchases and payments newest first, filters and
searches them, and a row opens its purchase; the Back buttons are real buttons that return to where the person came from; the
pages do not scroll sideways on a phone; and no script error appears anywhere.
"""
import os, re, subprocess, tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright

URL = os.environ.get("INVOISY_URL") or (Path(__file__).resolve().parents[2] / "index.html").as_uri()
SHOTS = os.environ.get("INVOISY_SHOTS")
problems = []

def check(cond, label):
    print(("PASS " if cond else "FAIL ") + label)
    if not cond:
        problems.append(label)

BACKUP = subprocess.run(["node", str(Path(__file__).with_name("make_deposits_backup.js"))], check=True, capture_output=True, text=True).stdout
BACKUP_FILE = Path(tempfile.mkdtemp(prefix="invoisy-e2e-")) / "invoisy-data.json"
BACKUP_FILE.write_text(BACKUP, encoding="utf-8")

def go(page, view):
    page.click(f'.nav-btn[data-view="{view}"]')

def shot(page, name):
    if SHOTS:
        Path(SHOTS).mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(Path(SHOTS) / (name + ".png")), full_page=True)

def bg(page, sel):
    return page.locator(sel).first.evaluate("(el) => getComputedStyle(el).backgroundColor")

def overflow(page):
    return page.evaluate("document.documentElement.scrollWidth - window.innerWidth")

def row(page, name):
    return page.locator("#supRows tr", has_text=name).first

with sync_playwright() as p:
    browser = p.chromium.launch(args=["--no-sandbox"])
    context = browser.new_context(viewport={"width": 1366, "height": 800})
    page = context.new_page()
    page.add_init_script("window.print = () => {};")
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append("PAGEERROR " + str(e)))
    page.on("dialog", lambda d: d.accept())

    page.goto(URL)
    go(page, "settings")
    page.wait_for_function("document.getElementById('dataState').textContent === 'Ready'", timeout=10000)
    page.set_input_files("#importFile", str(BACKUP_FILE))
    page.wait_for_function("document.getElementById('toast').textContent.includes('Restore completed')", timeout=10000)

    # ---------- the Suppliers table: compact icon actions ----------
    go(page, "suppliers")
    page.wait_for_selector("#supRows tr")
    first = row(page, "Timgad Ceramic")
    icons = first.locator(".icon-actions .icon-btn")
    check(icons.count() == 6, "each supplier row has 4 action icons + 2 standing icons (%d)" % icons.count())
    check(first.locator("button.btn").count() == 0, "no wide text buttons are left in the row")
    titles = [icons.nth(i).get_attribute("title") for i in range(icons.count())]
    check(all(titles) and len(set(titles)) == 6, "every icon has its own tooltip")
    sizes = [icons.nth(i).bounding_box() for i in range(icons.count())]
    check(all(abs(b["width"] - 28) < 1 and abs(b["height"] - 28) < 1 for b in sizes), "the icon buttons are all 28 x 28 px")
    actions_width = page.locator("#supRows tr").first.locator("td.actions-cell").bounding_box()["width"]
    check(actions_width < 260, "the Actions column is compact (%dpx)" % actions_width)
    wrap = page.locator("#supRows").locator("xpath=ancestor::div[contains(@class,'table-wrap')]").first
    check(wrap.evaluate("(el) => el.scrollWidth <= el.clientWidth + 1"), "the table does not overflow its panel (no sideways scroll inside it)")
    shot(page, "1-suppliers-neutral")

    # ---------- standing ----------
    neutral_bg = bg(page, "#supRows tr:nth-child(1) td.num")
    good = first.locator('[data-act="sup-standing"][data-standing="good"]')
    good.click()
    page.wait_for_function("document.querySelector('#supRows tr.standing-good')")
    check(row(page, "Timgad Ceramic").get_attribute("class") == "sup-row standing-good", "Good standing tints the row")
    g_bg = bg(page, "#supRows tr.standing-good td.num")
    check(g_bg != neutral_bg and re.match(r"rgb\(2[0-9]{2}, 2[0-9]{2}, 2[0-9]{2}\)", g_bg) is not None, "the green tint is subtle (%s)" % g_bg)
    check(row(page, "Timgad Ceramic").locator('[data-standing="good"]').get_attribute("aria-pressed") == "true", "the selected button is marked pressed")
    check(row(page, "Timgad Ceramic").locator('[data-standing="attention"]').get_attribute("aria-pressed") == "false", "the other one is not")
    check(page.evaluate("document.activeElement.dataset.standing") == "good", "the keyboard focus stays on the button after the redraw")

    row(page, "Sétif Carrelage").locator('[data-standing="attention"]').click()
    page.wait_for_function("document.querySelector('#supRows tr.standing-attention')")
    r_bg = bg(page, "#supRows tr.standing-attention td.num")
    check(r_bg != g_bg and re.match(r"rgb\(2[0-9]{2}, 2[0-9]{2}, 2[0-9]{2}\)", r_bg) is not None, "the red tint is subtle and different (%s)" % r_bg)
    shot(page, "2-suppliers-marked")

    # one at a time, and pressing the active one clears it
    row(page, "Timgad Ceramic").locator('[data-standing="attention"]').click()
    page.wait_for_function("document.querySelectorAll('#supRows tr.standing-attention').length === 2")
    check(page.locator("#supRows tr", has_text="Timgad Ceramic").locator('[aria-pressed="true"]').count() == 1, "only one mark is on at a time")
    row(page, "Timgad Ceramic").locator('[data-standing="attention"]').click()
    page.wait_for_function("document.querySelectorAll('#supRows tr.standing-attention').length === 1")
    check(row(page, "Timgad Ceramic").get_attribute("class") == "sup-row", "pressing the active mark returns the supplier to neutral")
    row(page, "Timgad Ceramic").locator('[data-standing="good"]').click()
    page.wait_for_function("document.querySelector('#supRows tr.standing-good')")

    # survives a reload of the page (the same stored data), and an unmarked supplier stays as it was
    page.reload()
    go(page, "suppliers")
    page.wait_for_selector("#supRows tr")
    check("standing-good" in (row(page, "Timgad Ceramic").get_attribute("class") or ""), "Good standing is still there after a reload")
    check("standing-attention" in (row(page, "Sétif Carrelage").get_attribute("class") or ""), "Needs attention is still there after a reload")
    check(row(page, "Hodna Tiles").get_attribute("class") == "sup-row", "a supplier never marked is untouched")

    # ---------- Supplier Activity ----------
    page.click('[data-act="sup-activity"]')
    page.wait_for_selector("#actRows tr.clickable")
    check(page.locator("#suppliersRoot h2").inner_text() == "Supplier Activity", "the Supplier Activity page opens from the Suppliers page")
    labels = page.locator("#actRows tr.clickable td:nth-child(1)").all_inner_texts()
    dates = [re.match(r"(\d\d)/(\d\d)/(\d{4})", t.strip()) for t in labels]
    keys = [m.group(3) + m.group(2) + m.group(1) for m in dates]
    check(keys == sorted(keys, reverse=True) and len(keys) >= 6, "newest first (%d rows)" % len(keys))
    types = page.locator("#actRows tr.clickable td:nth-child(2)").all_inner_texts()
    check(any("Purchase" in t for t in types) and any("Payment" in t for t in types), "purchases and payments are listed together")
    strip = page.locator("#actStrip").inner_text()
    check("Purchases listed" in strip and "Payments listed" in strip, "two separate totals are shown")
    shot(page, "3-activity-all")

    page.click('#actTab-payments')
    page.wait_for_function("!document.querySelector('#actRows .badge.act-purchase')")
    check(page.locator("#actRows .badge.act-payment").count() >= 3 and "Purchases listed" not in page.locator("#actStrip").inner_text(), "the Payments view lists only payments and its own total")
    page.click('#actTab-purchases')
    page.wait_for_function("!document.querySelector('#actRows .badge.act-payment')")
    page.click('#actTab-all')
    page.wait_for_selector("#actRows .badge.act-payment")

    total_all = page.locator("#actRows tr.clickable").count()
    page.fill("#actSearch", "SC-2")
    page.wait_for_function("document.querySelectorAll('#actRows tr.clickable').length === 1")
    check("SC-2" in page.locator("#actRows").inner_text(), "search finds a purchase by its invoice number")
    page.fill("#actSearch", "")
    page.wait_for_function("(n) => document.querySelectorAll('#actRows tr.clickable').length === n", arg=total_all)
    page.select_option("#actSupplier", label="Hodna Tiles")
    page.wait_for_function("(n) => document.querySelectorAll('#actRows tr.clickable').length < n", arg=total_all)
    check(all("Hodna Tiles" in t for t in page.locator("#actRows tr.clickable td:nth-child(3)").all_inner_texts()), "the supplier filter shows only that supplier")
    page.select_option("#actSupplier", "")
    page.select_option("#actOrder", "oldest")
    page.wait_for_function("document.querySelector('#actOrder').value === 'oldest'")
    old = page.locator("#actRows tr.clickable td:nth-child(1)").all_inner_texts()
    old_keys = [re.match(r"(\d\d)/(\d\d)/(\d{4})", t.strip()) for t in old]
    old_keys = [m.group(3) + m.group(2) + m.group(1) for m in old_keys]
    check(old_keys == sorted(old_keys), "oldest first")
    page.select_option("#actOrder", "newest")

    # a row opens its purchase; Back returns to the activity list
    page.locator('#actRows tr.clickable', has_text="SC-2").first.click()
    page.wait_for_selector("#purchasesRoot .back-btn")
    back = page.locator("#purchasesRoot .back-btn")
    check(back.inner_text().strip() == "Back to Supplier Activity", "the purchase's Back button names the Supplier Activity page")
    shot(page, "4-purchase-back")
    back.click()
    page.wait_for_selector("#actRows tr.clickable")
    check(page.locator("#suppliersRoot h2").inner_text() == "Supplier Activity", "Back returns to the activity list")

    # supplier profile: back to the activity list, and the profile's own button
    page.locator("#actRows tr.clickable").first.locator('button[data-act="sup-open"]').click()
    page.wait_for_selector("#suppliersRoot .back-btn")
    check(page.locator("#suppliersRoot .back-btn").inner_text().strip() == "Back to Supplier Activity", "a profile opened from the activity list goes back to it")
    page.locator("#suppliersRoot .back-btn").click()
    page.wait_for_selector("#actRows")
    page.click('#suppliersRoot .back-btn')
    page.wait_for_selector("#supRows tr")
    check(page.locator('[data-act="sup-activity"]').count() == 1, "the activity page's Back leads to the Suppliers list")

    # from a profile to its purchase and back
    row(page, "Sétif Carrelage").locator('button[data-act="sup-open"]').first.click()
    page.wait_for_selector("#suppliersRoot .back-btn")
    check(page.locator("#suppliersRoot .back-btn").inner_text().strip() == "Back to Suppliers", "a profile opened from the list goes back to the list")
    shot(page, "5-profile")
    page.click('#suppliersRoot [data-act="sup-tab"][data-tab="purchases"]')
    page.locator('#suppliersRoot [data-act="pur-open"]').first.click()
    page.wait_for_selector("#purchasesRoot .back-btn")
    check(page.locator("#purchasesRoot .back-btn").inner_text().strip() == "Back to Sétif Carrelage", "a purchase opened from a profile names that supplier")
    page.locator("#purchasesRoot .back-btn").click()
    page.wait_for_selector("#suppliersRoot .back-btn")
    check("Sétif Carrelage" in page.locator("#suppliersRoot h2").inner_text(), "and returns to that profile")

    # the back button is a real button, with a visible keyboard focus, that is not an underlined link
    btn = page.locator("#suppliersRoot .back-btn")
    st = btn.evaluate("(el) => { const c = getComputedStyle(el); return [el.tagName, c.textDecorationLine, c.borderTopWidth, c.borderRadius, c.cursor]; }")
    check(st[0] == "BUTTON" and st[1] == "none" and st[2] == "1px" and st[3] != "0px" and st[4] == "pointer", "the back control is a bordered, rounded button, not an underlined link (%s)" % st)

    # ---------- phone ----------
    go(page, "suppliers")
    page.set_viewport_size({"width": 390, "height": 800})
    page.wait_for_selector("#supRows tr")
    base = max(0, *(overflow(page) for v in ("stock", "invoices", "settings") if (go(page, v) or True)))
    go(page, "suppliers")
    check(overflow(page) <= base + 2, "Suppliers list: no more sideways scroll than the existing pages (%dpx vs %dpx)" % (overflow(page), base))
    shot(page, "6-suppliers-phone")
    page.click('[data-act="sup-activity"]')
    page.wait_for_selector("#actRows")
    check(overflow(page) <= base + 2, "Supplier Activity: no more sideways scroll than the existing pages (%dpx)" % overflow(page))
    shot(page, "7-activity-phone")
    page.set_viewport_size({"width": 1366, "height": 800})
    page.locator("#suppliersRoot .back-btn").click()
    page.wait_for_selector("#supRows tr")

    # ---------- Arabic ----------
    go(page, "settings")
    page.select_option("#sLanguage", "ar")
    go(page, "suppliers")
    page.wait_for_selector("#supRows tr")
    check(page.evaluate("document.documentElement.dir") == "rtl", "Arabic is right to left")
    check(re.search(r"[\u0600-\u06FF]", page.locator("#suppliersRoot").inner_text()) is not None, "the Suppliers page is in Arabic")
    shot(page, "8-suppliers-ar")
    page.click('[data-act="sup-activity"]')
    page.wait_for_selector("#actRows")
    shot(page, "9-activity-ar")
    text = page.locator("#suppliersRoot").inner_text()
    check(not re.search(r"\b(?:act|sup|back)\.[a-zA-Z.]+", text), "Arabic: no raw text keys on the Supplier Activity page")
    page.locator("#suppliersRoot .back-btn").click()
    page.wait_for_selector("#supRows tr")
    go(page, "settings")
    page.select_option("#sLanguage", "en")

    check(not errors, "no script or console errors: " + "; ".join(errors[:3]))
    browser.close()

print()
print("%d problem(s)" % len(problems))
raise SystemExit(1 if problems else 0)

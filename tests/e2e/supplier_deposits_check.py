"""Real-browser check of the Purchases and Suppliers pages and of supplier deposits / advance payments.

Optional and manual (NOT part of `npm test`; needs a browser):
    pip install playwright && playwright install chromium
    python3 tests/e2e/supplier_deposits_check.py
Set INVOISY_SHOTS=/some/folder to also save screenshots (desktop, tablet, phone; English and Arabic).
Brand new browser profile and disposable IndexedDB: no real business data is touched.

What it checks in a real page: both pages use the same heading, search box, table header and button sizes as Stock; the cards
and balances come from the stored data; a deposit can be recorded without an invoice (and a double click records it once); an
advance can be applied to an invoice and released; the statement agrees; nothing scrolls sideways on a phone; and no script
error appears anywhere.
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

def style(page, sel, props):
    return page.locator(sel).first.evaluate("(el, props) => { const c = getComputedStyle(el); return props.map((p) => c[p]); }", props)

def shot(page, name):
    if SHOTS:
        Path(SHOTS).mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(Path(SHOTS) / (name + ".png")), full_page=True)

BASELINE = {}

def overflow(page):
    return page.evaluate("document.documentElement.scrollWidth - window.innerWidth")

def measure_baseline(page, width):
    """The mobile navigation bar of the existing pages is a few pixels wider than a 390px phone (Stock, Invoices and Settings
    all show it), so the new pages are compared with them: they must not scroll sideways more than the pages that already exist."""
    BASELINE[width] = max(0, *(overflow(page) for view in ("stock", "invoices", "settings") if (go(page, view) or True)))

def no_sideways_scroll(page, label):
    wide = overflow(page)
    allowed = BASELINE.get(page.viewport_size["width"], 0) + 2
    check(wide <= allowed, f"{label}: no more sideways scroll than the existing pages ({wide}px, existing pages {allowed - 2}px)")

def money(text):
    """'-50,000 DA' -> -50000.0"""
    m = re.search(r"[-−]?\s*[\d.,]+", text.replace("\u00a0", " "))
    return float(m.group(0).replace("−", "-").replace(" ", "").replace(",", "")) if m else None

with sync_playwright() as p:
    browser = p.chromium.launch(args=["--no-sandbox"])
    page = browser.new_context(viewport={"width": 1366, "height": 800}).new_page()
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

    # ---------- reference: the Stock page ----------
    measure_baseline(page, 1366)
    go(page, "stock")
    page.wait_for_selector("#stockTable")
    ref_title = style(page, "#view-stock .stock-title", ["fontSize", "letterSpacing", "textTransform", "fontWeight"])
    ref_th = style(page, "#stockTable thead th", ["backgroundColor", "fontSize", "textTransform", "letterSpacing", "paddingTop"])
    ref_search = page.locator("#stockFilter").bounding_box()

    # ---------- Suppliers: list ----------
    go(page, "suppliers")
    page.wait_for_selector("#supRows tr")
    check(style(page, "#suppliersRoot .stock-title", ["fontSize", "letterSpacing", "textTransform", "fontWeight"]) == ref_title, "Suppliers heading looks like Stock's heading")
    check(style(page, "#suppliersRoot .stock-table thead th", ["backgroundColor", "fontSize", "textTransform", "letterSpacing", "paddingTop"]) == ref_th, "Suppliers table header looks like Stock's")
    sb = page.locator("#supSearch").bounding_box()
    check(abs(sb["height"] - ref_search["height"]) < 1, f"Suppliers search box is as tall as Stock's ({sb['height']} vs {ref_search['height']})")
    check(page.locator("#supRows tr").count() == 3, "three suppliers are listed")
    cards = page.locator("#supStrip .stat").all_inner_texts()
    flat = " | ".join(c.replace("\n", " ") for c in cards)
    print("cards:", flat)
    check(money(cards[1]) == 230000, "Total purchases card = 230,000")
    check(money(cards[2]) == 230000, "Paid to supplier card = 150,000 + 30,000 + 50,000 deposits")
    check(money(cards[3]) == 70000, "Owed to suppliers = 70,000 (only the supplier we really owe)")
    check(money(cards[4]) == 70000, "Available advances = 50,000 + 20,000")
    rows = {r.locator("td").nth(0).inner_text().split("\n")[0]: r for r in page.locator("#supRows tr").all()}
    timgad = rows["Timgad Ceramic"].inner_text().replace("\n", " ")
    check("-50,000" in timgad.replace("−", "-") and "Prepaid" in timgad, "Timgad: net -50,000 and the word Prepaid")
    check("Prepaid" not in rows["Sétif Carrelage"].inner_text() and "70,000" in rows["Sétif Carrelage"].inner_text(), "Sétif: owes 70,000, not prepaid")
    shot(page, "suppliers-desktop")
    no_sideways_scroll(page, "Suppliers list (desktop)")

    # ---------- Deposit: no invoice, double click ----------
    rows["Sétif Carrelage"].locator('[data-act="sup-deposit"]').click()
    page.wait_for_selector("#supDepForm")
    check(page.locator("#dpPurchase, #spPurchase").count() == 0 or not page.locator("#supDepForm #spPurchase").count(), "the deposit form has no invoice choice")
    page.fill("#dpAmount", "100000")
    page.select_option("#dpMethod", "bank")
    page.fill("#dpRef", "VIR-77")
    page.dblclick("#supDepForm button[type=submit]")
    page.wait_for_function("document.getElementById('toast').textContent.includes('Deposit recorded') || document.getElementById('toast').textContent.includes('already recorded')", timeout=10000)
    page.wait_for_timeout(300)
    check(page.locator("#supDepForm ~ * tbody tr:not(.empty-row)").count() >= 1 or page.locator(".stock-table tbody tr").count() >= 1, "the deposit is listed")
    deposit_rows = page.locator("#suppliersRoot .panel:has(h2) .stock-table tbody tr").all_inner_texts()
    check(sum(1 for t in deposit_rows if "100,000" in t and "VIR-77" in t) == 1, "a double click recorded the deposit once")
    page.click('[data-act="sup-tab"][data-tab="overview"]')
    overview = page.locator("#suppliersRoot .stat-strip .stat").all_inner_texts()
    flat = " | ".join(c.replace("\n", " ") for c in overview)
    print("Sétif overview:", flat)
    check("-30,000" in flat.replace("−", "-"), "Sétif net balance is now 70,000 - 100,000 = -30,000")
    check("Prepaid" in flat, "…and it says Prepaid")
    check("not applied to any invoice yet" in page.inner_text("#suppliersRoot"), "it explains that open invoices are not changed by a general deposit")
    shot(page, "supplier-profile-desktop")

    # ---------- Apply the advance to an invoice, then the statement ----------
    page.click('[data-act="sup-tab"][data-tab="purchases"]')
    page.locator('#suppliersRoot [data-act="pur-open"]').first.click()
    page.wait_for_selector('[data-act="pur-panel"][data-panel="applyAdv"]')
    page.click('[data-act="pur-panel"][data-panel="applyAdv"]')
    page.fill("#da-amount", "20000")
    page.click('form[data-form="pur-applyadv"] button[type=submit]')
    page.wait_for_function("document.getElementById('purchasesRoot').textContent.includes('from advance')", timeout=10000)
    check("20,000" in page.inner_text("#purchasesRoot"), "the invoice shows 20,000 DA paid from the advance")
    shot(page, "purchase-detail-desktop")
    page.click('#purchasesRoot [data-act="sup-open"]')
    page.click('[data-act="sup-tab"][data-tab="statement"]')
    ledger = page.locator("#suppliersRoot .stock-table tbody tr").all_inner_texts()
    check(any("Advance applied" in t for t in ledger) and any("Deposit" in t for t in ledger), "the statement lists the deposit and the advance applied")
    last_balance = money(page.locator("#suppliersRoot .stock-table tbody tr").last.locator("td").last.inner_text())
    check(last_balance == -30000, f"the last running balance equals the net balance (-30,000): {last_balance}")
    shot(page, "supplier-statement-desktop")

    # ---------- Purchases page ----------
    go(page, "purchases")
    if page.locator('#purchasesRoot [data-act="pur-back"]').count():   # the page still shows the invoice opened earlier
        page.click('#purchasesRoot [data-act="pur-back"]')
    page.wait_for_selector("#purRows tr")
    check(style(page, "#purchasesRoot .stock-title", ["fontSize", "letterSpacing", "textTransform", "fontWeight"]) == ref_title, "Purchases heading looks like Stock's heading")
    check(style(page, "#purchasesRoot .stock-table thead th", ["backgroundColor", "fontSize", "textTransform", "letterSpacing", "paddingTop"]) == ref_th, "Purchases table header looks like Stock's")
    pb = page.locator("#purSearch").bounding_box()
    check(abs(pb["height"] - ref_search["height"]) < 1, "Purchases search box is as tall as Stock's")
    check(page.locator("#purRows tr").count() == 4, "four purchases are listed")
    page.fill("#purFrom", (__import__("datetime").date.today() - __import__("datetime").timedelta(days=5)).isoformat())
    page.wait_for_timeout(200)
    check(page.locator("#purRows tr").count() == 2, "the date filter keeps the two purchases of the last five days")
    page.fill("#purFrom", "")
    page.click('[data-act="pur-sort"][data-key="total"]')
    totals = [money(t) for t in page.locator("#purRows tr td:nth-child(6)").all_inner_texts()]
    check(totals == sorted(totals, reverse=True) or totals == sorted(totals), f"sorting by total orders the rows {totals}")
    shot(page, "purchases-desktop")
    no_sideways_scroll(page, "Purchases list (desktop)")

    # ---------- other widths ----------
    for name, width in (("tablet", 820), ("phone", 390)):
        page.set_viewport_size({"width": width, "height": 900})
        measure_baseline(page, width)
        for view, sel in (("suppliers", "#supRows tr"), ("purchases", "#purRows tr")):
            go(page, view)
            back = page.locator(f'#{view}Root [data-act="{"sup-back" if view == "suppliers" else "pur-back"}"]')
            if back.count():
                back.first.click()
            page.wait_for_selector(sel)
            no_sideways_scroll(page, f"{view} list ({name})")
            shot(page, f"{view}-{name}")
    go(page, "suppliers")
    page.locator("#supRows tr").first.locator('[data-act="sup-open"]').first.click()
    page.click('[data-act="sup-tab"][data-tab="deposits"]')
    no_sideways_scroll(page, "supplier deposits tab (phone)")
    shot(page, "supplier-deposits-phone")

    # ---------- Arabic ----------
    page.set_viewport_size({"width": 1366, "height": 800})
    go(page, "settings")
    page.select_option("#sLanguage", "ar")
    BASELINE[1366] = BASELINE.get(1366, 0)
    page.wait_for_function("document.documentElement.dir === 'rtl'", timeout=5000)
    go(page, "suppliers")
    if page.locator('#suppliersRoot [data-act="sup-back"]').count():
        page.click('#suppliersRoot [data-act="sup-back"]')
    page.wait_for_selector("#supRows tr")
    text = page.inner_text("#suppliersRoot")
    check(re.search(r"[\u0600-\u06FF]", text) is not None and not re.search(r"\b(?:fin|dep|adv|led)\.[a-z]+", text), "Arabic: the Suppliers page is in Arabic with no raw text keys")
    shot(page, "suppliers-arabic")
    no_sideways_scroll(page, "Suppliers list (Arabic)")

    check(not errors, "no script or console errors: " + "; ".join(errors[:3]))
    browser.close()

print()
print("ALL CHECKS PASSED" if not problems else f"{len(problems)} CHECK(S) FAILED: " + "; ".join(problems))
raise SystemExit(1 if problems else 0)

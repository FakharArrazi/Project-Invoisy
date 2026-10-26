"""Real-browser check of Settings -> Currency display (Dinars / Centimes).

Optional and manual (NOT part of `npm test`; needs a browser):
    pip install playwright && playwright install chromium
    python3 tests/e2e/currency_display_check.py
Brand new browser profile and disposable IndexedDB: no real business data is touched.

What it checks in a real page: the selector, the default, that choosing a unit redraws the invoice WITHOUT a reload, that the
choice survives a reload, that the printed pages (built just before printing) show the same amounts as the live preview on A4
and A5, that a very long amount never runs into the next column, and that the stored amounts are the same in both modes.
"""
import os, re, sys
from pathlib import Path
from playwright.sync_api import sync_playwright
from e2e_common import SKIP_SALE_DIALOG, wait_invoice_shown

URL = os.environ.get("INVOISY_URL") or (Path(__file__).resolve().parents[2] / "index.html").as_uri()
problems = []

def check(cond, label):
    print(("PASS " if cond else "FAIL ") + label)
    if not cond:
        problems.append(label)

def text(page, sel):
    return page.inner_text(sel).strip()

def digits(s):
    """'1,890,000 centimes' -> 1890000.0 (the first number in a text, any grouping)."""
    m = re.search(r"[\d][\d,  ]*(?:\.\d+)?", s)
    return float(re.sub(r"[,  ]", "", m.group(0))) if m else None

def add_line(page, search, qty, unit):
    page.fill("#search", search)
    page.wait_for_selector("#results .result")
    page.click("#results .result")
    page.fill("#addQty", qty)
    page.select_option("#addUnit", unit)
    page.click('#addForm button[type="submit"]')

def sell_preview(page):
    """The live invoice preview as a person sees it. It is shown on the Sell page only, and a saved invoice gets there through
    Invoices -> View (opening the Sell page by itself shows the sale being prepared). Comes back to Settings afterwards."""
    page.click('.nav-btn[data-view="invoices"]')
    page.click("#invoiceBody tr >> text=View")
    page.wait_for_selector("#invoice .grand", state="visible")
    shown = {"text": page.inner_text("#invoice"), "grand": page.inner_text("#invoice .grand td:last-child").strip(), "visible": page.is_visible("#invoice")}
    page.click('.nav-btn[data-view="settings"]')
    return shown

def stored(page):
    """Every stored amount and counter, read straight from the page's data: it must not depend on the display unit."""
    return page.evaluate("""async () => {
      const open = indexedDB.databases ? await indexedDB.databases() : [];
      const name = (open[0] || {}).name;
      const db = await new Promise((res, rej) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      const all = (store) => new Promise((res, rej) => { const r = db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      const out = { products: await all("products"), invoices: await all("invoices"), counter: await all("counters") };
      db.close();
      return JSON.stringify(out);
    }""")

def print_layout(page, paper):
    """Builds the printed pages like the browser does just before printing, then measures them in print layout.
    Returns { text, overlaps, overflow }: the printed text, and the cells that run into a neighbour or out of their own box."""
    page.evaluate("window.dispatchEvent(new Event('beforeprint'))")
    page.emulate_media(media="print")
    result = page.evaluate("""() => {
      const host = document.getElementById('invoicePages');
      const rect = (el) => el.getBoundingClientRect();
      const overlaps = [], overflow = [];
      host.querySelectorAll('.inv-page').forEach((pg, p) => {
        const body = pg.querySelector('.inv-page-body'), b = rect(body);
        pg.querySelectorAll('table').forEach((tb) => {
          const t = rect(tb);
          if (t.right > b.right + 1 || t.left < b.left - 1) overflow.push('page ' + (p + 1) + ': a table is wider than the page body');
          tb.querySelectorAll('tr').forEach((tr) => {
            const cells = [...tr.children];
            cells.forEach((c, i) => {
              if (c.scrollWidth > c.clientWidth + 1) overflow.push('page ' + (p + 1) + ': "' + c.textContent.trim().slice(0, 30) + '" is wider than its cell');
              if (i > 0 && rect(cells[i - 1]).right > rect(c).left + 1) overlaps.push('page ' + (p + 1) + ': "' + cells[i - 1].textContent.trim().slice(0, 20) + '" overlaps "' + c.textContent.trim().slice(0, 20) + '"');
            });
          });
        });
        if (pg.scrollWidth > pg.clientWidth + 1) overflow.push('page ' + (p + 1) + ' scrolls sideways');
      });
      return { text: host.innerText, overlaps, overflow, pages: host.querySelectorAll('.inv-page').length };
    }""")
    page.emulate_media(media="screen")
    return result

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_context().new_page()
    page.add_init_script(SKIP_SALE_DIALOG)
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append("PAGEERROR " + str(e)))
    page.on("dialog", lambda d: d.accept())
    page.goto(URL)
    page.click('.nav-btn[data-view="settings"]')
    page.wait_for_function("document.getElementById('dataState').textContent === 'Ready'", timeout=10000)

    # --- The selector: easy to find, same style as the paper size, Dinars by default ---
    panel = page.locator(".panel", has=page.locator("#currencyUnitDinars"))
    check(panel.locator("h2").inner_text().strip() == "Currency display", "Settings has a 'Currency display' section")
    labels = [l.strip() for l in panel.locator("label").all_inner_texts()]
    check(labels == ["Dinars (DA)", "Centimes (centimes)"], "its two options: " + str(labels))
    check(page.is_checked("#currencyUnitDinars") and not page.is_checked("#currencyUnitCentimes"), "Dinars (DA) is selected by default")
    check(page.locator("#currencyUnitDinars").evaluate("e => e.closest('.radio-row') !== null") and page.locator("#paperA4").evaluate("e => e.closest('.radio-row') !== null"), "it uses the same radio row as A4 / A5")
    check(page.evaluate("document.documentElement.dataset.currencyUnit") == "dinars", "the page knows it is in dinars mode")

    # --- A sale: 10 m² of the demo tile ---
    page.click("#loadDemo")
    page.click('.nav-btn[data-view="stock"]')
    page.wait_for_function("document.querySelectorAll('#stockBody tr').length >= 6", timeout=10000)   # the demo products are in Stock
    page.click('.nav-btn[data-view="sell"]')
    add_line(page, "Demo Floor Tile", "10", "m2")
    page.fill("#amountPaid", "1000")
    page.click("#completeSale")
    wait_invoice_shown(page, "INV-000001")
    inv_dinars = page.inner_text("#invoice")
    total_da = digits(text(page, "#invoice .grand td:last-child"))
    check("DA" in inv_dinars and "centimes" not in inv_dinars, "the invoice shows DA by default")
    check(total_da is not None and total_da > 0, f"the invoice total is {total_da:,.0f} DA")
    data_before = stored(page)

    # --- Choosing Centimes: the invoice redraws at once, the page does not reload ---
    page.evaluate("window.__still_here = 1")
    page.click('.nav-btn[data-view="settings"]')
    page.check("#currencyUnitCentimes")
    page.wait_for_function("document.documentElement.dataset.currencyUnit === 'centimes'", timeout=5000)
    check(page.evaluate("window.__still_here") == 1, "choosing Centimes did not reload the page")
    shown = sell_preview(page)
    check(shown["visible"], "the live preview (on the Sell page) is already up to date, nothing to refresh")
    inv_centimes = shown["text"]
    check(not re.search(r"\bDA\b", inv_centimes), "no dinar label is left on the invoice")
    check(digits(shown["grand"]) == total_da * 100, "the grand total is exactly 100 x the dinar total")
    check("Price (centimes)" in inv_centimes and "Total (centimes)" in inv_centimes, "the column headings say centimes")
    check(page.evaluate("document.documentElement.dataset.currencyUnit") == "centimes", "the page knows it is in centimes mode")
    check("Boxes" in inv_centimes and "10.08" in inv_centimes and "/ m²" in inv_centimes, "quantity, area and the / m² unit are not converted")
    check(stored(page) == data_before, "the stored products, invoices and counter are byte-identical in centimes mode")

    # --- Back to Dinars: the original invoice returns ---
    page.check("#currencyUnitDinars")
    page.wait_for_function("document.documentElement.dataset.currencyUnit === 'dinars'", timeout=5000)
    check(sell_preview(page)["text"] == inv_dinars, "back in dinars the invoice reads exactly as it did")
    check(stored(page) == data_before, "and the stored data is still byte-identical")

    # --- Saved across a reload ---
    page.check("#currencyUnitCentimes")
    page.wait_for_function("document.documentElement.dataset.currencyUnit === 'centimes'", timeout=5000)
    page.wait_for_timeout(300)
    page.reload()
    page.click('.nav-btn[data-view="settings"]')
    page.wait_for_function("document.getElementById('dataState').textContent === 'Ready'", timeout=10000)
    check(page.is_checked("#currencyUnitCentimes"), "after a reload Centimes is still selected")
    page.click('.nav-btn[data-view="invoices"]')
    page.click("#invoiceBody tr >> text=View")
    check("centimes" in text(page, "#invoice") and digits(text(page, "#invoice .grand td:last-child")) == total_da * 100, "and a saved invoice opens in centimes")

    # --- Printed pages, A4 and A5: the same amounts as the preview, nothing overlapping ---
    preview_total = text(page, "#invoice .grand td:last-child")
    for paper in ("A4", "A5"):
        page.click('.nav-btn[data-view="settings"]')
        page.check(f"#paper{paper}")
        page.wait_for_function(f"document.documentElement.dataset.paper === '{paper.lower()}'")
        printed = print_layout(page, paper)
        check(preview_total in printed["text"], f"{paper}: the printed invoice has the same grand total as the preview ({preview_total})")
        check("centimes" in printed["text"] and not re.search(r"\bDA\b", printed["text"]), f"{paper}: the printed invoice is in centimes only")
        check(not printed["overlaps"] and not printed["overflow"], f"{paper}: nothing overlaps or overflows " + "; ".join(printed["overlaps"] + printed["overflow"]))
        pdf = page.pdf(format=paper, print_background=True)
        check(pdf[:4] == b"%PDF", f"{paper}: a PDF can be produced")

    # --- A very long amount (14 digits in centimes) must wrap inside its cell, never run into the next column ---
    page.click('.nav-btn[data-view="sell"]')
    add_line(page, "Coca", "50", "piece")
    row = "#saleBody tr[data-id]"
    page.fill(f"{row} .price-input", "9999999999")
    page.fill("#amountPaid", "0")
    page.click("#completeSale")
    wait_invoice_shown(page, "INV-000002")
    check("49,999,999,995,000 centimes" in text(page, "#invoice"), "a 499,999,999,950 DA invoice reads 49,999,999,995,000 centimes")
    for paper in ("A5", "A4"):
        page.click('.nav-btn[data-view="settings"]')
        page.check(f"#paper{paper}")
        page.wait_for_function(f"document.documentElement.dataset.paper === '{paper.lower()}'")
        printed = print_layout(page, paper)
        check(not printed["overlaps"] and not printed["overflow"], f"{paper}: the very long amounts do not overlap or overflow " + "; ".join(printed["overlaps"] + printed["overflow"]))
    check(not errors, "no console or page errors: " + "; ".join(errors))
    browser.close()

print("\nALL PASSED" if not problems else "\nFAILED: " + "; ".join(problems))
sys.exit(1 if problems else 0)

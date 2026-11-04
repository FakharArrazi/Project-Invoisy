"""Real-browser check of (1) the Purchases page's "Products bought" lines and (2) the purchase price shown on the Sell page,
opened straight from disk (file://).

Optional and manual (not part of `npm test`; it needs a browser):
    pip install playwright && playwright install chromium     (or point Playwright at a Chromium you already have)
    python3 tests/e2e/purchase_lines_sell_price_check.py
It uses a brand new browser profile and a disposable IndexedDB, so no real business data is touched.
Set SHOTS=/some/folder to also save screenshots.

What it proves:
  - "Add a line" sits under the last product line, new lines appear above it, and it keeps working after several additions;
  - every product line is its own light, bordered container that holds its fields AND its Line note; lines never overlap;
  - removing a line (also the first and the last) keeps the others, their notes and the button;
  - the layout does not overflow sideways on a phone-sized window;
  - the Sell page shows the newest real purchase record (its unit, its supplier), never an input, a quiet message when the product was
    never bought, and a product without a purchase record can still be sold at its own selling price.
"""
import os, sys
from pathlib import Path
from playwright.sync_api import sync_playwright
from e2e_common import open_product_form

URL = os.environ.get("INVOISY_URL") or (Path(__file__).resolve().parents[2] / "index.html").as_uri()
SHOTS = os.environ.get("SHOTS")
problems = []


def check(cond, label):
    print(("PASS " if cond else "FAIL ") + label)
    if not cond:
        problems.append(label)


def shot(page, name):
    if SHOTS:
        Path(SHOTS).mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(Path(SHOTS) / (name + ".png")), full_page=True)


def go(page, view):
    page.click(f'.nav-btn[data-view="{view}"]')


def wait_toast(page, contains):
    page.wait_for_function("(s) => document.getElementById('toast').textContent.includes(s)", arg=contains, timeout=8000)


def add_stock_product(page, name, size, coverage, price, stock_unit="m2", stock="10"):
    go(page, "stock")
    open_product_form(page)
    page.fill("#pName", name)
    page.fill("#pTileSize", size)
    page.fill("#pCoveragePerBox", coverage)
    page.locator("#priceRows input[data-field='price']").first.fill(price)
    page.select_option("#pStockUnit", stock_unit)
    page.fill("#pStock", stock)
    page.click("#productSubmit")
    page.wait_for_function("(n) => document.getElementById('stockBody').textContent.includes(n)", arg=name, timeout=8000)


def line_ids(page):
    return [r.get_attribute("data-line") for r in page.locator(".pl-row").all()]


def pick_product(page, lid, query):
    page.click(f"#pl-{lid}-search")
    page.keyboard.type(query)
    page.keyboard.press("Enter")


def fill_line(page, lid, product, unit, qty, price, note=""):
    pick_product(page, lid, product)
    page.select_option(f"#pl-{lid}-unit", unit)
    page.fill(f"#pl-{lid}-qty", qty)
    page.fill(f"#pl-{lid}-price", price)
    if note:
        page.fill(f"#pl-{lid}-notes", note)


def make_purchase(page, supplier, invoice_no, day, lines):
    """New purchase through the real form, then Confirm purchase."""
    go(page, "purchases")
    if page.locator("#purchaseForm").count():
        page.locator('[data-act="pur-back"]').first.click()   # leave a form that is still open (the dialog asks, the check accepts)
    page.locator('[data-act="pur-new"]:visible').first.click()
    page.select_option("#pf-supplier", label=supplier)
    page.fill("#pf-invoiceNo", invoice_no)
    page.fill("#pf-date", day)
    for i, spec in enumerate(lines):
        if i > 0:
            page.click('[data-act="pur-line-add"]')
        fill_line(page, line_ids(page)[i], *spec)
    page.click("#pf-confirm")
    page.wait_for_function("document.querySelector('.profile-head') && document.querySelector('.profile-head').textContent.includes('Confirmed')", timeout=10000)


with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(accept_downloads=True, viewport={"width": 1400, "height": 900})
    page = ctx.new_page()
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append("PAGEERROR " + str(e)))
    page.on("dialog", lambda d: d.accept())

    page.goto(URL)
    go(page, "settings")
    page.wait_for_function("document.getElementById('dataState').textContent === 'Ready'", timeout=10000)

    add_stock_product(page, "Tile A", "60*60", "1.44", "800")
    add_stock_product(page, "Tile B", "30*30", "1.08", "700")
    add_stock_product(page, "Tile C", "40*40", "1.28", "600")
    go(page, "suppliers")
    for name in ("Timgad Ceramic", "Sétif Céram"):
        page.click('[data-act="sup-add"]')
        page.fill("#sf-name", name)
        page.click("#sf-save")
        wait_toast(page, "was added")
        page.click('[data-act="sup-back"]')   # back to the supplier list

    # ---------- 1. the lines of a new purchase ----------
    go(page, "purchases")
    page.click('[data-act="pur-new"]')
    add_btn = page.locator('[data-act="pur-line-add"]')
    check(add_btn.count() == 1, "there is exactly one Add a line button")

    def geometry():
        return page.evaluate("""() => {
          const rows = [...document.querySelectorAll('#pfLines .pl-row')].map((r) => {
            const b = r.getBoundingClientRect(); const n = r.querySelector('.pl-notes'); const nb = n.getBoundingClientRect();
            const cs = getComputedStyle(r);
            return { id: r.dataset.line, top: b.top, bottom: b.bottom, left: b.left, right: b.right, noteInside: r.contains(n),
                     noteTop: nb.top, noteBottom: nb.bottom, bg: cs.backgroundColor, border: cs.borderTopWidth + ' ' + cs.borderTopStyle };
          });
          const btn = document.querySelector('[data-act="pur-line-add"]').getBoundingClientRect();
          const lines = document.getElementById('pfLines').getBoundingClientRect();
          return { rows, btn: { top: btn.top, bottom: btn.bottom, left: btn.left }, linesBottom: lines.bottom, vw: window.innerWidth };
        }""")

    g = geometry()
    check(len(g["rows"]) == 1 and g["btn"]["top"] >= g["rows"][0]["bottom"], "Add a line is below the first (only) line, not in the panel header")
    check(page.locator("#pfLines .pl-row").count() == 1 and page.locator('.panel-head [data-act="pur-line-add"]').count() == 0, "the old header position is gone")

    for _ in range(3):
        page.click('[data-act="pur-line-add"]')
    g = geometry()
    ids = line_ids(page)
    check(len(ids) == 4, "three more lines were added (4 lines)")
    check(all(g["btn"]["top"] >= r["bottom"] for r in g["rows"]), "the button is still below the last line after several additions")
    check(all(g["rows"][i]["bottom"] <= g["rows"][i + 1]["top"] for i in range(3)), "lines are in order and never overlap")
    check(all(g["rows"][i + 1]["top"] - g["rows"][i]["bottom"] >= 6 for i in range(3)), "there is a clear gap between one line and the next")
    check(all(r["noteInside"] and r["noteTop"] >= r["top"] and r["noteBottom"] <= r["bottom"] for r in g["rows"]), "each Line note is inside its own line container")
    check(all(r["bg"] not in ("rgba(0, 0, 0, 0)", "transparent") and r["border"].startswith("1px solid") for r in g["rows"]), "each line has a light background and a thin border")
    check(all(r["bg"] != "rgb(255, 255, 255)" for r in g["rows"]), "the line background is slightly different from the white panel (subtle, not a heavy card)")

    fill_line(page, ids[0], "tile a", "box", "20", "1200", "first note")
    fill_line(page, ids[1], "tile b", "box", "10", "650", "second note")
    fill_line(page, ids[2], "tile c", "box", "5", "500", "third note")
    shot(page, "1-lines-desktop")
    notes = lambda: [page.input_value(f"#pl-{i}-notes") for i in line_ids(page)]
    check(notes() == ["first note", "second note", "third note", ""], "each note stayed with its own product line")

    # removing: middle, then the first, then the last; notes keep their products
    page.click(f'.pl-row[data-line="{ids[1]}"] [data-act="pur-line-remove"]')
    check(line_ids(page) == [ids[0], ids[2], ids[3]] and notes() == ["first note", "third note", ""], "removing a middle line keeps the others and their notes")
    page.click(f'.pl-row[data-line="{ids[0]}"] [data-act="pur-line-remove"]')
    check(line_ids(page) == [ids[2], ids[3]] and notes() == ["third note", ""], "removing the first line works")
    page.click(f'.pl-row[data-line="{ids[3]}"] [data-act="pur-line-remove"]')
    check(line_ids(page) == [ids[2]] and notes() == ["third note"], "removing the last line works")
    g = geometry()
    check(g["btn"]["top"] >= g["rows"][-1]["bottom"], "the button is still below the last line")
    page.click(f'.pl-row[data-line="{ids[2]}"] [data-act="pur-line-remove"]')
    check(len(line_ids(page)) == 1 and notes() == [""], "removing the only line leaves one empty line (as before)")
    page.click('[data-act="pur-line-add"]')
    check(len(line_ids(page)) == 2, "Add a line still works after that")

    for width in (1180, 700, 390):
        page.set_viewport_size({"width": width, "height": 900})
        page.wait_for_timeout(100)
        g = geometry()
        check(all(r["right"] <= g["vw"] + 1 and r["left"] >= -1 for r in g["rows"]), f"the product lines fit inside the window at {width}px")
        check(all(r["noteInside"] for r in g["rows"]) and all(g["btn"]["top"] >= r["bottom"] for r in g["rows"]), f"notes stay inside their lines and the button stays last at {width}px")
        if width == 390:
            shot(page, "1-lines-phone")
    page.set_viewport_size({"width": 1400, "height": 900})

    # ---------- 2. the purchase price on the Sell page ----------
    make_purchase(page, "Timgad Ceramic", "FA-1", "2026-09-01", [("tile a", "m2", "28.8", "450", "older"), ("tile b", "box", "10", "650", "")])
    make_purchase(page, "Sétif Céram", "SC-1", "2026-10-15", [("tile a", "box", "20", "1200", "")])
    shot(page, "2-purchase-confirmed")

    go(page, "sell")
    selling_before = {}

    def select(query):
        page.fill("#search", query)
        page.wait_for_selector("#results .result")
        page.click("#results .result")
        return page.inner_text("#selectedInfo")

    info = select("Tile A")
    selling_before["A"] = [l for l in info.splitlines() if l.startswith("Price")]
    check("Purchase price: 1,200 DA / Box" in info, "Tile A shows the newest purchase (1,200 DA / Box), unit as bought, not converted (" + info.replace("\n", " | ") + ")")
    check("Supplier: Sétif Céram" in info, "…with the supplier of that purchase")
    check("450" not in info, "the older supplier's 450 is not shown")
    check(page.locator("#selectedInfo input, #selectedInfo select, #selectedInfo textarea").count() == 0, "no editable control for the purchase price")
    shot(page, "3-sell-tile-a")

    info = select("Tile B")
    check("Purchase price: 650 DA / Box" in info and "Supplier: Timgad Ceramic" in info, "Tile B shows its only purchase (650 DA / Box, Timgad Ceramic)")
    info = select("Tile C")
    check("No purchase price recorded" in info and "Purchase price:" not in info, "Tile C (never bought) shows 'No purchase price recorded'")
    check(page.locator("#selectedInfo input").count() == 0, "and still no input")
    shot(page, "3-sell-tile-c")

    # a product without a purchase record can be sold, at its own selling price
    page.fill("#addQty", "2")
    page.select_option("#addUnit", "box")
    page.click('#addForm button[type="submit"]')
    page.wait_for_selector("#saleBody tr")
    total_text = page.inner_text("#saleBody")
    check("1,536" in total_text, "2 boxes of Tile C (600 DA/m², 1.28 m² per box) = 1,536 DA, unaffected by purchases (" + total_text.replace("\n", " ") + ")")
    page.click("#completeSale")
    page.wait_for_function("document.getElementById('invoice').textContent.includes('INV-')", timeout=10000)
    check("1,536" in page.inner_text("#invoice"), "the invoice was saved with the same total")
    check("urchase price" not in page.inner_text("#invoice") and "450" not in page.inner_text("#invoice"), "the printed/preview invoice shows no purchase price")

    # the data survives a reload, and the Sell page reads the same record again
    page.reload()
    page.wait_for_function("document.getElementById('dataState') && document.getElementById('dataState').textContent === 'Ready'", timeout=10000) if False else page.wait_for_timeout(500)
    go(page, "sell")
    info = select("Tile A")
    check("Purchase price: 1,200 DA / Box" in info and "Supplier: Sétif Céram" in info, "after a reload the same purchase record is shown")

    check(not [e for e in errors if "favicon" not in e], "no console errors: " + "; ".join(errors[:3]))
    browser.close()

print()
print("FAILED: " + str(len(problems)) if problems else "ALL CHECKS PASSED")
sys.exit(1 if problems else 0)

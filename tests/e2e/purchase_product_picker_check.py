"""Real-browser check of the Purchases page's product selector and its "+ Add new product" dialog, opened straight from disk (file://).

Optional and manual (not part of `npm test`; it needs a browser):
    pip install playwright && playwright install chromium     (or point Playwright at a Chromium you already have)
    python3 tests/e2e/purchase_product_picker_check.py
It uses a brand new browser profile and a disposable IndexedDB, so no real business data is touched.
Set SHOTS=/some/folder to also save screenshots.

What it proves:
  - the layout of a purchase line stays aligned, with the "+ Add new product" button on its own row, at every width;
  - the product box is a search box and a list: click to list, type to filter (case, spacing, tile size spellings), arrows/Enter/Esc/Tab;
  - a product made from the purchase is saved to Stock through the Stock form's rules, selected on the line that asked for it,
    and the purchase (supplier, invoice, other lines) is untouched, with no page reload;
  - a failed save keeps everything and can be retried; a double click adds the product once; a similar product can be used instead;
  - the new product is still there after a reload, and confirming the purchase adds the right stock and totals.
"""
import os, re, sys, tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright

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


def text(page, sel):
    return page.inner_text(sel).strip()


def digits(value):
    """'201,139.2 DA' -> '201139.2': a number as typed, whatever the thousands separator."""
    return re.sub(r"[^\d.]", "", value)


def go(page, view):
    page.click(f'.nav-btn[data-view="{view}"]')


def wait_toast(page, contains):
    page.wait_for_function("(s) => document.getElementById('toast').textContent.includes(s)", arg=contains, timeout=8000)


def dialog_closed(page):
    page.wait_for_function("!document.getElementById('purProductDialog').open", timeout=8000)


def add_stock_product(page, name, size, maker, coverage, price, stock_unit=None, stock=None):
    go(page, "stock")
    page.fill("#pName", name)
    page.fill("#pTileSize", size)
    page.fill("#pManufacturer", maker)
    page.fill("#pCoveragePerBox", coverage)
    page.locator("#priceRows input[data-field='price']").first.fill(price)
    if stock_unit:
        page.select_option("#pStockUnit", stock_unit)
    if stock:
        page.fill("#pStock", stock)
    page.click("#productSubmit")
    wait_toast(page, name)


def stock_row(page, name):
    go(page, "stock")
    return page.locator("#stockBody tr", has_text=name)


def stock_cell(page, name):
    return stock_row(page, name).first.locator("td").nth(3).inner_text().strip()


def line_ids(page):
    return [r.get_attribute("data-line") for r in page.locator(".pl-row").all()]


def pick_product(page, lid, query):
    """Chooses a product on a line the way a person does: type in its search box, then Enter."""
    page.click(f"#pl-{lid}-search")
    page.keyboard.type(query)
    page.keyboard.press("Enter")


def label_of(page, lid):
    return page.input_value(f"#pl-{lid}-search")


def options_of(page, lid):
    return page.locator(f"#pl-{lid}-list .combo-opt").all_inner_texts()


def form_snapshot(page):
    """Every typed value of the purchase form, by id (the hidden product lists included)."""
    return page.evaluate("""() => {
      const out = {};
      document.querySelectorAll('#purchaseForm input, #purchaseForm select').forEach((el) => {
        if (!el.id) return;
        out[el.id] = el.type === 'checkbox' ? String(el.checked) : el.value;
      });
      return out;
    }""")


def changed(before, after):
    return sorted(k for k in set(before) | set(after) if before.get(k) != after.get(k))


with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(accept_downloads=True, viewport={"width": 1400, "height": 900})
    page = ctx.new_page()
    errors = []
    navigations = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append("PAGEERROR " + str(e)))
    page.on("framenavigated", lambda f: navigations.append(f.url) if f == page.main_frame else None)
    page.on("dialog", lambda d: d.accept())

    page.goto(URL)
    go(page, "settings")
    page.wait_for_function("document.getElementById('dataState').textContent === 'Ready'", timeout=10000)

    # ---------- the catalogue and a supplier ----------
    add_stock_product(page, "Tile A", "60*60", "TimgadCeram", "1.44", "800", stock_unit="m2", stock="10")
    add_stock_product(page, "BARCELONA Crema", "60*60", "TimgadCeram", "1.44", "1100")
    add_stock_product(page, "BARCELONA Gris", "60*60", "TimgadCeram", "1.44", "1100")
    add_stock_product(page, "Tile B", "30*30", "Sétif Céram", "1.08", "700")
    go(page, "suppliers")
    page.click('[data-act="sup-add"]')
    page.fill("#sf-name", "Timgad Ceramic")
    page.click("#sf-save")
    wait_toast(page, "was added")

    # ---------- 1. layout ----------
    go(page, "purchases")
    page.click('[data-act="pur-new"]')
    page.click('[data-act="pur-line-add"]')
    first, second = line_ids(page)
    pick_product(page, first, "barcelona crema")

    def geometry(width):
        return page.evaluate("""() => [...document.querySelectorAll('.pl-row')].map((r) => {
          const box = (s) => { const b = r.querySelector(s).getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right }; };
          return { product: box('.combo-input'), qty: box('[id$=-qty]'), unit: box('[id$=-unit]'), price: box('[id$=-price]'),
                   disc: box('[id$=-disc]'), add: box('.pl-add-product') };
        })""")

    g = geometry(1400)
    for i, row in enumerate(g):
        edges = [row[k]["bottom"] for k in ("product", "qty", "unit", "price", "disc")]
        check(max(edges) - min(edges) <= 2, f"line {i + 1}: product, quantity, unit, price and discount line up (bottoms {[round(e) for e in edges]})")
        check(row["add"]["top"] >= row["product"]["bottom"] - 1 and row["add"]["left"] <= row["product"]["left"] + 2,
              f"line {i + 1}: the Add new product button sits below the product box, not inside its cell")
    check(abs((g[0]["qty"]["bottom"] - g[0]["product"]["bottom"]) - (g[1]["qty"]["bottom"] - g[1]["product"]["bottom"])) <= 1,
          "both lines have the same layout (a chosen product changes nothing)")
    check(page.locator(".pl-add-product").first.inner_text().startswith("+ Add new product"), "the control is a button reading + Add new product")
    check(page.locator("button.pl-add-product").count() == 2, "every line has its own Add new product button")
    shot(page, "1-lines-desktop")
    for width in (1180, 1000, 700, 390):
        page.set_viewport_size({"width": width, "height": 900})
        page.wait_for_timeout(100)
        over = page.evaluate("document.documentElement.scrollWidth - window.innerWidth")
        inside = page.evaluate("""() => [...document.querySelectorAll('.pl-row .combo-input, .pl-row .pl-add-product')].every((e) => {
          const b = e.getBoundingClientRect(); return b.left >= 0 && b.right <= window.innerWidth + 1; })""")
        check(over <= 0 and inside, f"{width}px wide: no sideways scrolling, product box and button stay on screen")
        shot(page, f"1-lines-{width}")
    page.set_viewport_size({"width": 1400, "height": 900})

    # ---------- 2. the searchable selector ----------
    page.click(f"#pl-{second}-search")
    listed = options_of(page, second)
    check(len(listed) == 4, "clicking the box lists every product (" + str(len(listed)) + ")")
    check(all("In stock" in o for o in listed), "each product shows its stock")
    check("TimgadCeram" in listed[0] and "60*60" in listed[0], "each product shows its size and manufacturer")
    shot(page, "2-list-open")
    for query, expect in [
        ("barcelona", 2), ("BARCELONA", 2), ("  BaRcElOnA   crema ", 1), ("barcelonacrema", 1), ("crema barc", 1),
        ("60 x 60", 3), ("60X60", 3), ("60 * 60 gris", 1), ("setif", 1), ("tile  b", 1), ("nothing like this", 0),
    ]:
        page.fill(f"#pl-{second}-search", query)
        check(len(options_of(page, second)) == expect, f"typing {query!r} lists {expect} product(s)")
    page.fill(f"#pl-{second}-search", "")
    check(len(options_of(page, second)) == 4, "clearing the text lists everything again")

    # keyboard: arrows move, Enter picks
    page.fill(f"#pl-{second}-search", "barcelona")
    check("Crema" in page.locator(f"#pl-{second}-list .combo-opt.active").inner_text(), "the first match is highlighted as you type")
    page.keyboard.press("ArrowDown")
    check("Gris" in page.locator(f"#pl-{second}-list .combo-opt.active").inner_text(), "ArrowDown moves the highlight to the next match")
    page.keyboard.press("ArrowDown")
    check("Crema" in page.locator(f"#pl-{second}-list .combo-opt.active").inner_text(), "…and wraps around at the end")
    page.keyboard.press("ArrowUp")
    page.keyboard.press("Enter")
    check(label_of(page, second).startswith("BARCELONA Gris"), "Enter chooses the highlighted product")
    check(page.evaluate("document.activeElement.id") == f"pl-{second}-qty", "focus moves on to Quantity")
    check(page.input_value(f"#pl-{second}-unit") == "m2", "the unit starts on the unit the product is priced in")
    check("In stock" in text(page, f"#pl-{second}-hint"), "the product's stock and selling price are shown under the line")
    check(page.locator("#purchaseForm").count() == 1 and "Draft saved" not in text(page, "#toast"), "Enter in the box never saves or submits the purchase")

    # Escape and leaving put back what the line really has
    page.click(f"#pl-{second}-search")
    page.keyboard.type("zzz")
    page.keyboard.press("Escape")
    check(label_of(page, second).startswith("BARCELONA Gris") and page.locator(f"#pl-{second}-list").is_hidden(), "Escape closes the list and keeps the chosen product")
    page.click(f"#pl-{second}-search")
    page.keyboard.type("tile")
    page.click("#pf-notes")
    check(label_of(page, second).startswith("BARCELONA Gris"), "leaving the box after typing without choosing keeps the chosen product")
    page.click(f"#pl-{second}-search")
    page.keyboard.type("tile b")
    page.keyboard.press("Tab")
    check(label_of(page, second).startswith("Tile B"), "Tab after typing a name only one product answers to chooses it")
    page.click(f"#pl-{second}-search")
    page.keyboard.press("Backspace")
    page.click("#pf-notes")
    check(label_of(page, second) == "" and page.input_value(f"#pl-{second}-product") == "", "emptying the box clears the line's product")
    # the mouse
    page.click(f"#pl-{second}-search")
    page.locator(f"#pl-{second}-list .combo-opt", has_text="BARCELONA Gris").click()
    check(label_of(page, second).startswith("BARCELONA Gris"), "clicking a product in the list chooses it")

    # ---------- 3. a normal purchase line keeps its calculations ----------
    page.select_option("#pf-supplier", label="Timgad Ceramic")
    page.fill("#pf-invoiceNo", "FA-77")
    page.fill("#pf-notes", "keep me")
    page.fill(f"#pl-{first}-qty", "207.36")
    page.select_option(f"#pl-{first}-unit", "m2")
    page.fill(f"#pl-{first}-price", "970")
    page.fill(f"#pl-{first}-notes", "first line note")
    conv = text(page, f"#pl-{first}-conv")
    check("144" in conv and "1.44" in conv, "207.36 m² = 144 boxes (1 box = 1.44 m²) (" + conv + ")")
    check(digits(text(page, f"#pl-{first}-total")) == "201139.2", "the line total is 207.36 × 970 = 201,139.2 (" + text(page, f"#pl-{first}-total") + ")")

    # ---------- 4. no match: add the product without leaving the page ----------
    page.click(f"#pl-{second}-search")
    page.keyboard.type("Nova Perla")
    check("No product matches" in text(page, f"#pl-{second}-list"), "a search with no match says so")
    check(page.locator(f"#pl-{second}-list .combo-foot button").is_visible(), "the + Add new product button is right there in the list")
    shot(page, "4-no-match")
    page.fill(f"#pl-{second}-qty", "10")
    page.fill(f"#pl-{second}-price", "1500")
    page.fill(f"#pl-{second}-disc", "0")
    page.fill(f"#pl-{second}-notes", "second line note")
    page.click(f"#pl-{second}-search")
    page.keyboard.type("Nova Perla")
    before = form_snapshot(page)
    page.evaluate("window.__alive = 'yes'")
    navs_before = len(navigations)
    page.locator(f"#pl-{second}-list .combo-foot button").click()
    check(page.evaluate("document.getElementById('purProductDialog').open"), "the product form opens in a dialog")
    check(page.input_value("#pd-Name") == "Nova Perla", "the new product starts with the name that was searched for")
    check(page.locator("#view-purchases").is_visible() and page.locator("#purchaseForm").count() == 1, "the Purchases page stays mounted behind the dialog")
    check(page.locator("#pd-Manufacturer").count() and page.locator("#pd-TileSize").count() and page.locator("#pd-CoveragePerBox").count()
          and page.locator("#pd-Type").count() and page.locator("#pd-PriceRows").count(), "it is the Stock form (name, type, manufacturer, size, prices, coverage ...)")
    shot(page, "4-dialog")
    page.fill("#pd-Manufacturer", "Cevisama")
    page.fill("#pd-TileSize", "45*45")
    page.fill("#pd-CoveragePerBox", "1.62")
    page.fill("#pd-Sku", "NP-45")
    page.locator("#pd-PriceRows input[data-field=price]").first.fill("900")
    page.dblclick("#purProductSave")    # a double click must still add exactly one product
    dialog_closed(page)
    wait_toast(page, "Nova Perla")
    after = form_snapshot(page)
    check(page.evaluate("window.__alive") == "yes" and len(navigations) == navs_before, "no page reload or navigation happened")
    check(page.locator("#view-purchases").is_visible() and page.locator("#view-stock").is_hidden(), "the person is still on the Purchases page, not Stock")
    check(label_of(page, second).startswith("Nova Perla") and "45*45" in label_of(page, second), "the new product is selected on the line that asked for it")
    check(page.input_value(f"#pl-{second}-product") != "", "the line holds the new product's id")
    check(page.evaluate("document.activeElement.id") == f"pl-{second}-qty", "focus is on that line's Quantity, ready to continue")
    moved = changed(before, after)
    expected_moves = {f"pl-{second}-search", f"pl-{second}-product", f"pl-{second}-unit"}
    check(set(moved) <= expected_moves and f"pl-{second}-product" in moved, "only the product (and its default unit) of that line changed (" + ", ".join(moved) + ")")
    check(after["pf-supplier"] == before["pf-supplier"] and after["pf-invoiceNo"] == "FA-77" and after["pf-notes"] == "keep me", "supplier and invoice details are unchanged")
    check(after[f"pl-{first}-qty"] == "207.36" and label_of(page, first).startswith("BARCELONA Crema") and after[f"pl-{first}-notes"] == "first line note",
          "the other purchase line is unchanged")
    check(after[f"pl-{second}-qty"] == "10" and after[f"pl-{second}-price"] == "1500" and after[f"pl-{second}-notes"] == "second line note", "the quantity, price and note typed on that line survived")
    check(len(line_ids(page)) == 2, "no line was added or lost")
    # it is in the list of every line straight away
    page.click(f"#pl-{first}-search")
    page.keyboard.type("nova")
    check(len(options_of(page, first)) == 1, "the new product is searchable on the other line right away")
    page.keyboard.press("Escape")
    check(label_of(page, first).startswith("BARCELONA Crema"), "…without disturbing that line's own choice")

    # the unit it was given is its own price unit; the conversion for the line is shown and the totals are right
    page.select_option(f"#pl-{second}-unit", "box")
    conv2 = text(page, f"#pl-{second}-conv")
    check("10" in conv2, "10 boxes of the new product convert to stock (" + conv2 + ")")
    totals = text(page, "#pfTotals")
    check("216139.2" in digits(totals.replace("\n", " ")), "the purchase total is 201,139.2 + 15,000 = 216,139.2 (" + totals.replace("\n", " | ") + ")")
    shot(page, "4-after-add")

    # ---------- 5. confirm: stock and totals ----------
    page.click("#pf-confirm")
    wait_toast(page, "confirmed")
    detail = text(page, "#purchasesRoot")
    check("216139.2" in digits(detail), "the confirmed purchase shows the total 216,139.2")
    check(stock_row(page, "Nova Perla").count() == 1, "the new product exists once in Stock (not twice from the double click)")
    check(stock_cell(page, "Nova Perla").startswith("10"), "Nova Perla received 10 boxes (" + stock_cell(page, "Nova Perla") + ")")
    check(stock_cell(page, "BARCELONA Crema").startswith("144"), "BARCELONA Crema received 207.36 m² = 144 boxes (" + stock_cell(page, "BARCELONA Crema") + ")")
    check("NP-45" in text(page, "#stockBody tr:has-text('Nova Perla')") and "900" in text(page, "#stockBody tr:has-text('Nova Perla')"),
          "the product kept its SKU and selling price")

    # ---------- 6. it is really saved: reload ----------
    page.reload()
    page.wait_for_function("document.getElementById('stockBody') !== null", timeout=10000)
    go(page, "settings")
    page.wait_for_function("document.getElementById('dataState').textContent === 'Ready'", timeout=10000)
    check(stock_row(page, "Nova Perla").count() == 1 and stock_cell(page, "Nova Perla").startswith("10"), "after a reload the new product and its stock are still there")
    go(page, "purchases")
    check("FA-77" in text(page, "#purchasesRoot"), "…and so is the purchase")

    # ---------- 7. a failed save keeps everything and can be retried ----------
    page.click('[data-act="pur-new"]')
    page.select_option("#pf-supplier", label="Timgad Ceramic")
    page.fill("#pf-invoiceNo", "FA-78")
    ids = line_ids(page)
    first = ids[0]
    pick_product(page, first, "tile a")
    page.fill(f"#pl-{first}-qty", "3")
    page.click(f'.pl-row[data-line="{first}"] .pl-add-product')
    check(page.evaluate("document.getElementById('purProductDialog').open"), "the button below the line opens the same dialog")
    check(page.input_value("#pd-Name") == "", "opened from the button, the name starts empty")
    snap = form_snapshot(page)
    page.click("#purProductSave")
    page.wait_for_timeout(300)
    check(text(page, "#purProductError") != "" and page.evaluate("document.getElementById('purProductDialog').open"), "an incomplete product shows its error and the dialog stays open")
    check(form_snapshot(page) == snap, "the purchase form is exactly as it was")
    check(not page.locator("#purProductSave").is_disabled(), "the Save button can be used again")
    page.fill("#pd-Name", "Retry Tile")
    page.fill("#pd-TileSize", "20*20")
    page.fill("#pd-CoveragePerBox", "1")
    page.locator("#pd-PriceRows input[data-field=price]").first.fill("500")
    page.click("#purProductSave")
    dialog_closed(page)
    wait_toast(page, "Retry Tile")
    check(label_of(page, first).startswith("Retry Tile"), "retrying works: the product is saved and selected")
    check(page.input_value(f"#pl-{first}-qty") == "3" and page.input_value("#pf-invoiceNo") == "FA-78", "…and the purchase is intact")

    # an exact repeat of a product in Stock is refused, and a look-alike is offered instead of being added twice
    page.click(f'.pl-row[data-line="{first}"] .pl-add-product')
    page.fill("#pd-Name", "Tile A")
    page.fill("#pd-TileSize", "60*60")
    page.fill("#pd-Manufacturer", "TimgadCeram")
    page.fill("#pd-CoveragePerBox", "1.44")
    page.locator("#pd-PriceRows input[data-field=price]").first.fill("800")
    page.select_option("#pd-StockUnit", "m2")
    page.click("#purProductSave")
    page.wait_for_timeout(300)
    check("already" in text(page, "#purProductError") and page.evaluate("document.getElementById('purProductDialog').open"),
          "an exact repeat of a product is refused with a message, and the dialog stays open")
    page.fill("#pd-TileSize", "50*50")      # same name, another size: looks alike, so it is offered, not blocked
    page.click("#purProductSave")
    page.wait_for_timeout(300)
    check(page.locator("#purProductSimilar").is_visible() and page.evaluate("document.getElementById('purProductDialog').open"),
          "a look-alike product is flagged instead of being added silently")
    page.locator('#purProductSimilar [data-act="pur-product-use"]').first.click()
    dialog_closed(page)
    check(label_of(page, first).startswith("Tile A") and "60*60" in label_of(page, first), "'Use this product' selects the existing Tile A on the line")
    check(stock_row(page, "Tile A").count() == 1, "Stock still has one Tile A")
    go(page, "purchases")
    check(page.locator("#purchaseForm").count() == 1 and page.input_value("#pf-invoiceNo") == "FA-78", "going to Stock and back keeps the purchase being typed")

    # Escape closes the dialog like Cancel; the next one is blank
    page.click(f'.pl-row[data-line="{first}"] .pl-add-product')
    page.fill("#pd-Name", "half typed")
    page.keyboard.press("Escape")
    check(not page.evaluate("document.getElementById('purProductDialog').open") and page.input_value(f"#pl-{first}-qty") == "3", "Escape closes the dialog and the purchase is untouched")
    page.click(f'.pl-row[data-line="{first}"] .pl-add-product')
    check(page.input_value("#pd-Name") == "", "the next dialog starts blank")
    page.click('[data-act="pur-product-cancel"]')

    # ---------- 8. drafts still hold the chosen product ----------
    page.fill(f"#pl-{first}-price", "400")
    chosen = label_of(page, first)
    page.click("#pf-saveDraft")
    wait_toast(page, "saved")
    page.click('[data-act="pur-edit"]')
    ids = line_ids(page)
    check(label_of(page, ids[0]) == chosen and page.input_value(f"#pl-{ids[0]}-qty") == "3" and page.input_value(f"#pl-{ids[0]}-price") == "400",
          "a saved draft reopens with the product shown in the box (" + label_of(page, ids[0]) + ")")
    check(stock_cell(page, "Tile A").startswith("10"), "saving a draft did not change stock")

    check(not errors, "no console errors: " + "; ".join(errors))
    browser.close()

print()
if problems:
    print("FAILED:", "; ".join(problems))
    sys.exit(1)
print("ALL PASSED")

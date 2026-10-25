"""Real-browser check: the "Nom du vendeur" (seller name) field, the footer it prints, and the live preview that is the scaled-down print.

Optional and manual, like the other checks here (not part of `npm test`):
    pip install playwright pdfplumber && playwright install chromium
    python3 tests/e2e/seller_name_check.py
It uses a brand new browser profile (a temporary folder, kept between the "close the app" and "open it again" steps of the
check, then deleted), so no real business data is touched.

What it does:
  1. John -> save an invoice -> next sale still says John -> reload -> close the browser and open it again -> still John ->
     change to Jack -> later invoices say Jack, the older invoice still says John.
  2. The printed PDF: A4 size, the footer has the invoice number at the left, the seller exactly in the middle of the sheet and the
     page number at the right; an empty or very long name does not move the other two.
  3. The preview is the same pages as the print, scaled down: same text, same number of pages, A4 proportions.
  4. Editing a saved invoice shows its own seller, locked, and leaves the saved name alone.
"""
import os, re, shutil, sys, tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright
import pdfplumber

sys.path.insert(0, str(Path(__file__).resolve().parent))
from e2e_common import SKIP_SALE_DIALOG, open_product_form, wait_invoice_shown

URL = os.environ.get("INVOISY_URL") or (Path(__file__).resolve().parents[2] / "index.html").as_uri()
OUT = Path(os.environ.get("INVOISY_PDF_DIR") or tempfile.mkdtemp(prefix="invoisy-seller-"))
OUT.mkdir(parents=True, exist_ok=True)
MM = 72 / 25.4
problems = []


def check(cond, label):
    print(("PASS " if cond else "FAIL ") + label)
    if not cond:
        problems.append(label)


def go(page, view):
    page.click(f'.nav-btn[data-view="{view}"]')


def ready(page):
    page.wait_for_function("document.getElementById('dataState') && document.getElementById('dataState').textContent === 'Ready'", timeout=10000)


def seller(page):
    return page.input_value("#sellerName")


def stored_seller(page):
    return page.evaluate("state.settings.sellerName")


def invoices(page):
    return page.evaluate("state.invoices.map((i) => ({ id: i.id, number: i.invoiceNumber, seller: i.sellerName === undefined ? null : i.sellerName }))")


def add_product(page, name, price, stock):
    go(page, "stock")
    open_product_form(page)
    page.fill("#pName", name)
    page.fill("#pTileSize", "60*60")
    page.fill("#pCoveragePerBox", "1.44")
    page.locator("#priceRows input[data-field='price']").first.fill(str(price))
    page.locator("#priceRows select[data-field='unit']").first.select_option("m2")
    page.fill("#pStock", str(stock))
    page.click("#productSubmit")
    page.wait_for_function(f"document.getElementById('stockBody').innerText.includes({name!r})")


def sell(page, query, qty, customer):
    """Adds a product and completes the sale; returns the invoice number shown in the preview."""
    go(page, "sell")
    page.fill("#search", query)
    page.wait_for_selector("#results .result")
    page.click("#results .result")
    page.fill("#addQty", str(qty))
    page.select_option("#addUnit", "box")
    page.click('#addForm button[type="submit"]')
    page.fill("#custName", customer)
    page.keyboard.press("Tab")
    before = len(invoices(page))
    page.click("#completeSale")
    page.wait_for_function(f"state.invoices.length === {before + 1}", timeout=10000)
    number = invoices(page)[-1]["number"]
    wait_invoice_shown(page, number)
    return number


def type_seller(page, value):
    page.fill("#sellerName", value)
    page.click("#sellerSave")   # Save keeps the name (typing alone does not)
    page.wait_for_function("(v) => state.settings.sellerName === v.trim().replace(/\\s+/g, ' ')", arg=value, timeout=10000)


def print_pdf(page, name):
    path = OUT / f"{name}.pdf"
    page.pdf(path=str(path), prefer_css_page_size=True, print_background=True)   # fires "beforeprint" like the print dialog
    with pdfplumber.open(path) as pdf:
        return [{"w": float(p.width), "h": float(p.height), "words": p.extract_words(), "text": p.extract_text() or ""} for p in pdf.pages]


def footer_words(pdf_page):
    """The words of the footer line (the last line of the page)."""
    words = pdf_page["words"]
    bottom = max(w["bottom"] for w in words)
    return [w for w in words if abs(w["bottom"] - bottom) < 3]


def build_invoice(page, items, seller_name):
    return page.evaluate("""([n, name]) => {
      const lines = [];
      for (let i = 0; i < n; i++) {
        const qty = 2 + (i % 5), unitPrice = 1500 + i * 10;
        lines.push({ lineId: 'l' + i, productId: 'p' + i, name: 'P' + String(i + 1).padStart(3, '0') + ' Golden Era', manufacturer: 'Garnada', tileSize: '60*120',
          coveragePerBox: 2.88, sellingUnit: 'box', sku: 'S' + i, qty, unitPrice, total: qty * unitPrice, priceUnit: 'box', productPrice: unitPrice });
      }
      const subtotal = lines.reduce((s, i) => s + i.total, 0);
      const inv = { id: 'i-x-' + Math.random().toString(36).slice(2), invoiceNumber: 'INV-000099', date: new Date(2026, 9, 17, 14, 32).toISOString(),
        customer: { name: 'Yacine Benali', phone: '', address: '' }, items: lines, subtotal, discount: 0, tax: 0, total: subtotal, payments: [],
        discountPercent: null, taxPercent: null, currency: 'DA', business: { name: 'Hedjazi Ceramic', address: '', phone: '', email: '' } };
      if (name !== null) inv.sellerName = name;
      state.invoices = [inv]; state.previewInvoice = null; viewInvoice(inv.id);
      return inv.id;
    }""", [items, seller_name])


profile = tempfile.mkdtemp(prefix="invoisy-profile-")
try:
    with sync_playwright() as p:
        def open_app():
            ctx = p.chromium.launch_persistent_context(profile, viewport={"width": 1440, "height": 900}, locale="en-US")
            ctx.add_init_script(SKIP_SALE_DIALOG)
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            page.on("pageerror", lambda e: problems.append("page error: " + str(e)))
            page.goto(URL)
            go(page, "settings"); ready(page); go(page, "sell")
            return ctx, page

        # ------------------------------------------------------------------ 1. the seller is kept
        ctx, page = open_app()
        add_product(page, "Tile A", 800, 200)
        go(page, "sell")
        check(seller(page) == "", "a new installation starts with an empty seller name")
        check(page.is_visible("#sellerName"), "the Nom du vendeur box is on the Sell page")
        label = page.inner_text('label[for="sellerName"]').strip()
        check(label in ("Seller name", "Nom du vendeur", "اسم البائع"), f"the box has its label ({label!r})")

        # The box and its Save button are on the title's row, at the far right
        h = page.evaluate("""() => { const r = (s) => document.querySelector(s).getBoundingClientRect();
            const t = r('.sell-title'), i = r('#sellerName'), b = r('#sellerSave'), hd = r('.sell-header');
            return { titleMid: (t.top + t.bottom) / 2, inputMid: (i.top + i.bottom) / 2, btnMid: (b.top + b.bottom) / 2, titleRight: t.right, inputLeft: i.left, inputRight: i.right, btnLeft: b.left, btnRight: b.right, headerRight: hd.right, btnH: b.height }; }""")
        check(abs(h["titleMid"] - h["inputMid"]) < 12 and abs(h["inputMid"] - h["btnMid"]) < 2, f"the seller box and its button are on the same row as the SELL title ({h['titleMid']:.0f} / {h['inputMid']:.0f} / {h['btnMid']:.0f})")
        check(h["inputLeft"] > h["titleRight"] + 40 and abs(h["btnRight"] - h["headerRight"]) < 2, f"...at the far right of the row (button ends {h['headerRight'] - h['btnRight']:.1f}px from the edge)")
        check(h["btnH"] <= 40, f"the button is small ({h['btnH']:.0f}px high)")
        check(page.is_disabled("#sellerSave") and page.inner_text("#sellerSave").strip() in ("Saved", "Enregistré", "تم الحفظ"), "with nothing to save the button is quiet (Saved)")

        # Typing letter after letter: nothing redraws, focus stays, nothing is written
        page.evaluate("document.querySelector('#invoice .inv-page').dataset.mark = 'same'; window.__w = 0; const o = new MutationObserver(() => window.__w++); o.observe(document.getElementById('invoice'), { childList: true, subtree: true, characterData: true });")
        page.click("#sellerName")
        page.keyboard.type("John", delay=120)
        page.wait_for_timeout(900)   # longer than the old autosave delay
        check(page.evaluate("document.activeElement.id") == "sellerName" and seller(page) == "John", "typing a name letter by letter keeps focus and every letter")
        check(page.evaluate("window.__w") == 0 and page.evaluate("document.querySelector('#invoice .inv-page').dataset.mark") == "same", "...and the preview is not redrawn while typing")
        check(stored_seller(page) == "", "...and nothing is saved while typing")
        check("John" not in page.inner_text("#invoice .inv-page-foot"), "...so the preview does not show it yet")
        check(not page.is_disabled("#sellerSave") and page.inner_text("#sellerSave").strip() in ("Save", "Enregistrer", "حفظ"), "the Save button is ready")
        page.click("#sellerSave")
        page.wait_for_function("state.settings.sellerName === 'John'")
        check("John" in page.inner_text("#invoice .inv-page-foot"), "after Save the live preview shows the name")
        check(page.is_disabled("#sellerSave"), "...and the button is quiet again")
        n1 = sell(page, "Tile A", 2, "Alice")
        check(invoices(page)[-1]["seller"] == "John", "the first invoice is saved with John")
        check(seller(page) == "John", "after saving, the box still says John")
        page.click("#clearSale")
        check(seller(page) == "John", "after Clear (a new sale), the box still says John")
        page.reload(); ready(page); go(page, "sell")
        check(seller(page) == "John", "after a page refresh, the box still says John")
        ctx.close()

        ctx, page = open_app()
        check(seller(page) == "John", "after closing and reopening the browser, the box still says John")
        check(stored_seller(page) == "John", "...because it is a saved setting, not page state")

        # Typing a name and not saving it: it is not used (the invoice has what the preview showed), and Save then uses it.
        page.fill("#sellerName", "Jack")
        check(stored_seller(page) == "John", "a name that is typed and not saved is not kept")
        page.click("#sellerSave")
        page.wait_for_function("state.settings.sellerName === 'Jack'")
        n2 = sell(page, "Tile A", 1, "Bob")
        inv = invoices(page)
        check([i["seller"] for i in inv] == ["John", "Jack"], f"later invoices use Jack, the older one keeps John ({[i['seller'] for i in inv]})")
        check(stored_seller(page) == "Jack", "the setting is Jack now")
        first = inv[0]["id"]
        page.evaluate("(id) => viewInvoice(id)", first)
        check("John" in page.inner_text("#invoice .inv-page-foot") and "Jack" not in page.inner_text("#invoice .inv-page-foot"),
              "reopening the first invoice still shows John: history was not rewritten")
        go(page, "sell")
        check(seller(page) == "Jack", "...and the box (the next sale) says Jack")
        page.fill("#sellerName", "Mary")
        page.keyboard.press("Enter")   # Enter saves too
        page.wait_for_function("state.settings.sellerName === 'Mary'")
        check("Mary" in page.inner_text("#invoice .inv-page-foot"), "Enter in the box saves it too, and the preview shows it")
        type_seller(page, "Jack")

        # An empty name: kept as empty, and nothing is printed
        type_seller(page, "")
        n3 = sell(page, "Tile A", 1, "Carol")
        last = invoices(page)[-1]
        check(last["seller"] is None, "an invoice made with an empty name has no seller at all (older invoices have none either)")
        check(page.inner_text("#invoice .foot-seller").strip() == "", "and its footer's middle is empty: no placeholder")
        type_seller(page, "  Jack   Daniels ")
        check(stored_seller(page) == "Jack Daniels", "extra spaces are tidied")

        # ------------------------------------------------------------------ 4. editing a saved invoice
        type_seller(page, "Jack")
        page.evaluate("(id) => { viewInvoice(id); }", first)
        page.click("#editInvoiceBtn")
        page.wait_for_selector("#editBanner", state="visible")
        check(page.is_disabled("#sellerName") and page.is_disabled("#sellerSave"), "editing a saved invoice: the seller box and its button are locked")
        check(seller(page) == "John", "...and shows the seller that invoice was made with")
        check(page.is_visible("#sellerLocked"), "...with a note saying why")
        check("John" in page.inner_text("#invoice .inv-page-foot"), "...and the edit preview prints John")
        check(stored_seller(page) == "Jack", "...the saved setting is untouched while editing")
        page.click("#editCancel")
        page.wait_for_selector("#editBanner", state="hidden")
        go(page, "sell")
        check(not page.is_disabled("#sellerName") and seller(page) == "Jack", "after the edit, the box is typeable again and says Jack")
        ctx.close()

        # ------------------------------------------------------------------ 2 + 3. print and preview
        browser = p.chromium.launch()
        page = browser.new_context(viewport={"width": 1440, "height": 900}, locale="en-US").new_page()
        page.on("pageerror", lambda e: problems.append("page error: " + str(e)))
        page.goto(URL)
        page.wait_for_selector(".nav-btn")

        build_invoice(page, 3, "John")
        pdf = print_pdf(page, "john")
        pg = pdf[0]
        check(len(pdf) == 1 and abs(pg["w"] - 210 * MM) < 1.5 and abs(pg["h"] - 297 * MM) < 1.5, f"the PDF is one A4 sheet ({pg['w'] / MM:.1f} x {pg['h'] / MM:.1f} mm)")
        foot = footer_words(pg)
        by_text = {w["text"]: w for w in foot}
        check("John" in by_text and "INV-000099" in by_text and "Page" in by_text, "the footer line holds the invoice number, John and the page number: " + " ".join(w["text"] for w in foot))
        if "John" in by_text:
            centre = (by_text["John"]["x0"] + by_text["John"]["x1"]) / 2
            check(abs(centre - pg["w"] / 2) < 1.0, f"John is in the middle of the sheet ({centre:.1f}pt vs {pg['w'] / 2:.1f}pt)")
            check(abs(by_text["INV-000099"]["x0"] - 15 * MM) < 1.5, "the invoice number starts at the left margin")
            check(abs(max(w["x1"] for w in foot) - (pg["w"] - 15 * MM)) < 1.5, "the page number ends at the right margin")
        check("Page 1 of 1" in pg["text"], "page numbering is unchanged ('Page 1 of 1')")

        # preview == print
        preview_pages = page.evaluate("document.querySelectorAll('#invoice .inv-page').length")
        preview_text = page.evaluate("Array.from(document.querySelectorAll('#invoice .inv-page')).map((p) => p.innerText.replace(/\\s+/g, ' ').trim())")
        pdf_text = [re.sub(r"\s+", " ", p["text"]).strip() for p in pdf]
        # The words, not their order: the PDF is read line by line as it looks, the page in the order of its markup.
        words = lambda s: sorted(w for w in re.split(r"\s+", s.lower()) if w)
        check(preview_pages == len(pdf), f"the preview has as many sheets as the print ({preview_pages})")
        check(all(words(a) == words(b) for a, b in zip(preview_text, pdf_text)), "every sheet of the preview has the same words as the matching printed page")
        box = page.evaluate("(() => { const b = document.querySelector('#invoice .inv-page').getBoundingClientRect(); return b.width / b.height; })()")
        check(abs(box - 210 / 297) < 0.004, f"the preview sheet has A4 proportions ({box:.4f} vs {210 / 297:.4f})")
        scale = page.evaluate("parseFloat(getComputedStyle(document.getElementById('invoice')).getPropertyValue('--sheet-scale'))")
        check(0.3 < scale < 0.9, f"the preview is scaled down to fit the panel (x{scale:.2f})")
        # the print is not scaled: the same invoice printed again after the preview was resized is identical
        page.set_viewport_size({"width": 1100, "height": 800})
        page.wait_for_timeout(200)
        again = print_pdf(page, "john-again")
        check([p["text"] for p in again] == [p["text"] for p in pdf] and abs(again[0]["w"] - pdf[0]["w"]) < 0.5,
              "resizing the window (so the preview scale) changes nothing in the print")
        page.set_viewport_size({"width": 1440, "height": 900})

        # empty
        build_invoice(page, 3, None)
        pdf = print_pdf(page, "empty")
        foot = footer_words(pdf[0])
        check(sorted(w["text"] for w in foot) == sorted(["INV-000099", "Page", "1", "of", "1"]), "empty seller: the footer is just the number and the page number: " + " ".join(w["text"] for w in foot))
        check(abs(min(w["x0"] for w in foot) - 15 * MM) < 1.5 and abs(max(w["x1"] for w in foot) - (pdf[0]["w"] - 15 * MM)) < 1.5, "empty seller: the other two stay at the two margins")

        # very long
        for label, name in [("long, with spaces", "Mohamed Abderrahmane Boukhalfa Ben Abdelkader El Hadj Mustapha Ould Sidi Ahmed Zerr"), ("one long word", "W" * 80)]:
            build_invoice(page, 3, name)
            pdf = print_pdf(page, "long-" + label.split(",")[0].replace(" ", "-"))
            pg = pdf[0]
            foot = [w for w in pg["words"] if w["bottom"] > pg["h"] - 17 * MM]
            nums = [w for w in foot if w["text"] == "INV-000099"]
            pages_w = [w for w in foot if w["text"] in ("Page", "1", "of")]
            name_w = [w for w in foot if w not in nums and w not in pages_w]
            check(len(nums) == 1 and nums[0]["x0"] < 15 * MM + 2, f"{label}: the invoice number stays at the left margin")
            check(pages_w and max(w["x1"] for w in pages_w) > pg["w"] - 15 * MM - 2, f"{label}: the page number stays at the right margin")
            check(name_w and min(w["x0"] for w in name_w) > nums[0]["x1"] + 2 and max(w["x1"] for w in name_w) < min(w["x0"] for w in pages_w) - 2, f"{label}: the name sits between them without touching either")
            check(name_w and abs((min(w["x0"] for w in name_w) + max(w["x1"] for w in name_w)) / 2 - pg["w"] / 2) < 6, f"{label}: and stays centred on the sheet")
            check(len({round(w["bottom"]) for w in name_w}) <= 2, f"{label}: at most two lines")

        # several pages: the name and "Page i of N" on every one
        build_invoice(page, 60, "John")
        pdf = print_pdf(page, "many")
        check(len(pdf) >= 3 and all("John" in footer_text and f"Page {i + 1} of {len(pdf)}" in p["text"] for i, (p, footer_text) in enumerate(zip(pdf, [" ".join(w["text"] for w in footer_words(p)) for p in pdf]))),
              f"a {len(pdf)}-page invoice: every page's footer has John and its own 'Page i of {len(pdf)}'")
        check(preview_pages_ok := page.evaluate("document.querySelectorAll('#invoice .inv-page').length") == len(pdf), "...and the preview shows the same number of sheets")
        browser.close()
finally:
    shutil.rmtree(profile, ignore_errors=True)

print()
if problems:
    print("FAILED:")
    for item in problems:
        print(" -", item)
    sys.exit(1)
print("All checks passed.")

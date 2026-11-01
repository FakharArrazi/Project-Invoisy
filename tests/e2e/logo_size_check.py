"""Real-browser check of the configurable logo size (Settings -> Store logo): width and height in cm, separately for A4 and A5.

Optional and manual (NOT part of `npm test`; needs a browser):
    pip install playwright pillow pdfplumber && playwright install chromium
    python3 tests/e2e/logo_size_check.py
Brand new browser profile and disposable IndexedDB: no real business data is touched. The PDFs are kept (INVOISY_PDF_DIR, else a
temporary folder) and INVOISY_SHOTS=/some/folder also saves a screenshot of the logo panel.

The sizes are typed into the real Settings fields. For every size the live preview is measured in the page (layout size of the logo
box against its size in cm) and the invoice is printed to a PDF the way Print / Save as PDF does it, where the bordered box is
measured in points (1 cm = 28.35 pt): decimals, rectangles, A4 and A5 each with their own size, switching paper size, saving,
reloading, an old file without the setting, and the logo upload / replace / remove that was already there.
"""
import os, sys, tempfile, time, json
from pathlib import Path
from PIL import Image
from playwright.sync_api import sync_playwright
import pdfplumber

URL = os.environ.get("INVOISY_URL") or (Path(__file__).resolve().parents[2] / "index.html").as_uri()
SHOTS = os.environ.get("INVOISY_SHOTS")
OUT = Path(os.environ.get("INVOISY_PDF_DIR") or tempfile.mkdtemp(prefix="invoisy-logo-size-"))
OUT.mkdir(parents=True, exist_ok=True)
CM = 72 / 2.54        # points per centimetre
CSS_CM = 96 / 2.54    # css pixels per centimetre
PAGE_PT = {"A4": (595.28, 841.89), "A5": (419.53, 595.28)}
BORDER_PT = 0.75      # the box has a 1 px border; the PDF draws it as a line along the middle of the border, so the drawn rectangle is one border width smaller than the box
PT_TOLERANCE = 1.0    # 1 pt = 0.035 cm (a layout pixel is 0.75 pt, so the printed size can be a pixel off the exact figure)
problems = []

def check(cond, label):
    print(("PASS " if cond else "FAIL ") + label)
    if not cond:
        problems.append(label)

def eventually(fn, seconds=8):
    end = time.time() + seconds
    while time.time() < end:
        if fn():
            return True
        time.sleep(0.1)
    return False

def go(page, view):
    page.click(f'.nav-btn[data-view="{view}"]')

def ready(page):
    page.wait_for_function("document.getElementById('dataState').textContent === 'Ready'", timeout=10000)

def settings_state(page):
    return page.evaluate("JSON.parse(JSON.stringify({ paper: state.settings.paper, logoSize: state.settings.logoSize === undefined ? null : state.settings.logoSize }))")

def choose_paper(page, paper):
    go(page, "settings")
    page.click(f'#view-settings label:has(#paper{paper})')
    page.wait_for_function(f"state.settings.paper === '{paper}' && document.documentElement.dataset.paper === '{paper.lower()}'")

def fields(page):
    return page.input_value("#logoWidth"), page.input_value("#logoHeight")

def type_size(page, w, h):
    """Types into the two fields of the real Settings page and leaves the field (what a person does)."""
    go(page, "settings")
    page.fill("#logoWidth", str(w))
    page.fill("#logoHeight", str(h))
    page.press("#logoHeight", "Tab")
    paper = settings_state(page)["paper"]
    return eventually(lambda: (lambda s: s["logoSize"] is not None and s["logoSize"][paper] == {"width": float(w), "height": float(h)})(settings_state(page)))

PNG_JS = """
([w, h]) => { const c = document.createElement("canvas"); c.width = w; c.height = h; const x = c.getContext("2d");
  x.fillStyle = "#1b6e3c"; x.fillRect(0, 0, w, h); x.strokeStyle = "#e00"; x.lineWidth = 6; x.strokeRect(0, 0, w, h); return c.toDataURL("image/png"); }
"""

# A saved invoice shown in the live preview (the Sell page), like the header check does; the logo and the sizes are the saved ones.
BUILD_JS = """
() => {
  const items = [0, 1].map((i) => ({ lineId: "l" + i, productId: "p" + i, name: "P" + (i + 1) + " Golden Era", manufacturer: "Garnada", tileSize: "60*120",
    coveragePerBox: 2.88, sellingUnit: "box", sku: "S" + i, qty: 2 + i, unitPrice: 1500, total: (2 + i) * 1500, priceUnit: "box", productPrice: 1500, productType: "Faience" }));
  const subtotal = items.reduce((s, i) => s + i.total, 0);
  const inv = { id: "i-test-1", invoiceNumber: "INV-000018", date: new Date(2026, 9, 17, 14, 32).toISOString(),
    customer: { name: "Yacine Benali", phone: "0555 11 22 33", address: "" }, items, subtotal, discount: 0, tax: 0, total: subtotal,
    payments: [], discountPercent: null, taxPercent: null, currency: "DA",
    business: { name: "Hedjazi Ceramic", address: "Zone industrielle, Sétif", phone: "", email: "" } };
  state.invoices = [inv]; state.previewInvoice = null; viewInvoice(inv.id);
}
"""

def show_invoice(page):
    go(page, "sell")
    page.evaluate(BUILD_JS)
    page.wait_for_function("[...document.querySelectorAll('#invoice img')].every((i) => i.complete) && document.querySelector('#invoice .inv-logo-box')")

def preview_box(page):
    """The layout size (css px, before the preview is scaled down) of the logo box in the live preview, and what css says it is."""
    return page.evaluate("""() => { const b = document.querySelector('#invoice .inv-logo-box'); const c = getComputedStyle(b);
      return { w: b.offsetWidth, h: b.offsetHeight, cw: parseFloat(c.width), ch: parseFloat(c.height), box: c.boxSizing }; }""")

def pdf_rects(path):
    with pdfplumber.open(path) as pdf:
        pg = pdf.pages[0]
        return {"w": float(pg.width), "h": float(pg.height), "n": len(pdf.pages), "rects": pg.rects, "images": pg.images,
                "text": " ".join((q.extract_text() or "") for q in pdf.pages)}

def find_box(doc, w_cm, h_cm):
    want_w, want_h = w_cm * CM, h_cm * CM
    best = None
    for r in doc["rects"]:
        if not r.get("stroke") or r.get("fill"):
            continue   # the box is an outlined rectangle (not one of the filled page or rule rectangles)
        dw, dh = (r["x1"] - r["x0"] + BORDER_PT) - want_w, (r["bottom"] - r["top"] + BORDER_PT) - want_h
        if abs(dw) <= PT_TOLERANCE and abs(dh) <= PT_TOLERANCE and r["top"] < 120:
            if best is None or abs(dw) + abs(dh) < best[1]:
                best = (r, abs(dw) + abs(dh))
    return best[0] if best else None

def measure(page, label, paper, w, h, expect_logo=False):
    """Preview in the page + the printed PDF, both against the configured size."""
    show_invoice(page)
    pv = preview_box(page)
    px_w, px_h = w * CSS_CM, h * CSS_CM
    check(abs(pv["cw"] - px_w) < 0.05 and abs(pv["ch"] - px_h) < 0.05 and pv["box"] == "border-box",
          f"{label}: live preview box is {w} x {h} cm (css {pv['cw']:.2f} x {pv['ch']:.2f} px, wanted {px_w:.2f} x {px_h:.2f})")
    check(abs(pv["w"] - px_w) <= 1 and abs(pv["h"] - px_h) <= 1, f"{label}: live preview layout size {pv['w']} x {pv['h']} px")
    path = OUT / (label.replace(" ", "_").replace("×", "x") + ".pdf")
    page.pdf(path=str(path), prefer_css_page_size=True, print_background=True)
    doc = pdf_rects(path)
    check(abs(doc["w"] - PAGE_PT[paper][0]) < 1.5 and abs(doc["h"] - PAGE_PT[paper][1]) < 1.5, f"{label}: the PDF page is {paper} ({doc['w']:.1f} x {doc['h']:.1f} pt)")
    rect = find_box(doc, w, h)
    check(rect is not None, f"{label}: printed box measures {w} x {h} cm (+-{PT_TOLERANCE} pt)"
          + ("" if rect is None else f" -> {(rect['x1'] - rect['x0'] + BORDER_PT) / CM:.3f} x {(rect['bottom'] - rect['top'] + BORDER_PT) / CM:.3f} cm"))
    if rect:
        check((rect["x0"] + rect["x1"]) / 2 > doc["w"] / 2, f"{label}: the box is still on the right side of the header")
        if expect_logo:
            check(len(doc["images"]) >= 1 and all(im["x0"] >= rect["x0"] - .5 and im["x1"] <= rect["x1"] + .5 and im["top"] >= rect["top"] - .5 and im["bottom"] <= rect["bottom"] + .5 for im in doc["images"]),
                  f"{label}: the picture stays inside the box")
    # A taller logo makes the header taller, so a nearly full small page can continue on a second page (the invoice's own pagination does it,
    # with the compact "continued" header); it must never lose anything or need a third page.
    default_h = {"A4": 3, "A5": 2.5}[paper]
    if h <= default_h:
        check(doc["n"] == 1, f"{label}: still one page")
    else:
        check(doc["n"] <= 2, f"{label}: at most one continuation page ({doc['n']} page(s))")
    check("P1 Golden Era" in doc["text"] and "P2 Golden Era" in doc["text"] and "Thank you for your purchase" in doc["text"], f"{label}: nothing of the invoice is lost")
    return doc

errors = []
with sync_playwright() as p:
    browser = p.chromium.launch(args=["--no-sandbox"])
    context = browser.new_context(viewport={"width": 1366, "height": 900}, accept_downloads=True)
    page = context.new_page()
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append("PAGEERROR " + str(e)))
    page.on("dialog", lambda d: d.accept())
    page.goto(URL)
    ready(page)

    print("--- the fields in Settings")
    go(page, "settings")
    check(page.is_visible("#logoWidth") and page.is_visible("#logoHeight"), "Logo width and Logo height fields are visible next to the logo")
    check("Logo width (cm)" in page.inner_text("label[for=logoWidth]") and "Logo height (cm)" in page.inner_text("label[for=logoHeight]"), "they are labelled Logo width (cm) / Logo height (cm)")
    check(page.get_attribute("#logoWidth", "type") == "number" and page.get_attribute("#logoHeight", "type") == "number", "they are numeric fields")
    check(fields(page) == ("3", "3") and "A4" in page.inner_text("#logoSizeTitle"), f"A4 starts at 3 x 3 cm {fields(page)}")
    choose_paper(page, "A5")
    check(fields(page) == ("2.5", "2.5") and "A5" in page.inner_text("#logoSizeTitle"), f"A5 starts at 2.5 x 2.5 cm {fields(page)}")
    check(page.is_visible("#chooseLogo") and page.is_visible("#removeLogo") and "PNG image" in page.inner_text("#view-settings .logo-size + .muted"), "the logo buttons and the PNG note are still there")
    choose_paper(page, "A4")
    if SHOTS:
        Path(SHOTS).mkdir(parents=True, exist_ok=True)
        page.locator("#view-settings .settings-panel:has(#logoWidth)").screenshot(path=f"{SHOTS}/logo-size-panel.png")

    print("--- old data: nothing saved yet, the defaults print")
    check(settings_state(page)["logoSize"] is None, "a profile that never changed the size has no logoSize saved")
    measure(page, "A4 default 3 x 3", "A4", 3, 3)
    choose_paper(page, "A5")
    measure(page, "A5 default 2.5 x 2.5", "A5", 2.5, 2.5)

    print("--- A4 and A5 independent, applied when switching (the example of the request: A4 3 x 3, A5 2 x 2)")
    check(type_size(page, 2, 2), "A5: 2 x 2 typed and saved at once")
    choose_paper(page, "A4")
    check(fields(page) == ("3", "3"), f"back on A4 the fields show A4's own size {fields(page)}")
    check(type_size(page, 3, 3), "A4: 3 x 3 typed")
    choose_paper(page, "A5")
    check(fields(page) == ("2", "2"), f"A5 still shows 2 x 2 {fields(page)}")
    s = settings_state(page)
    check(s["logoSize"] == {"A4": {"width": 3.0, "height": 3.0}, "A5": {"width": 2.0, "height": 2.0}}, f"saved settings: {s['logoSize']}")
    measure(page, "A5 2 x 2", "A5", 2, 2)
    choose_paper(page, "A4")
    measure(page, "A4 3 x 3", "A4", 3, 3)

    print("--- decimal and rectangular sizes, both papers")
    for paper in ("A4", "A5"):
        choose_paper(page, paper)
        for w, h in [(1, 1), (1.5, 1.5), (2, 2), (2.5, 2.5), (3, 3), (4, 3), (3, 4.5), (2.25, 1.75)]:
            ok = type_size(page, w, h)
            check(ok, f"{paper}: {w} x {h} saved")
            measure(page, f"{paper} {w} x {h}", paper, w, h)
    other = settings_state(page)
    # the loop ended with 2.25 x 1.75 on both; set two different sizes and make sure each paper keeps its own
    choose_paper(page, "A4"); type_size(page, 4, 3)
    choose_paper(page, "A5"); type_size(page, 1.5, 1.5)
    choose_paper(page, "A4")
    check(fields(page) == ("4", "3"), f"A4 keeps 4 x 3 after A5 was changed {fields(page)}")
    choose_paper(page, "A5")
    check(fields(page) == ("1.5", "1.5"), f"A5 keeps 1.5 x 1.5 after A4 was changed {fields(page)}")

    print("--- invalid input is refused")
    saved_before = settings_state(page)
    for bad in ["0", "", "11", "0.2"]:
        go(page, "settings")
        page.fill("#logoWidth", bad)
        page.press("#logoWidth", "Tab")
        check(eventually(lambda: "between" in page.inner_text("#logoError")), f"'{bad}' is explained: {page.inner_text('#logoError')!r}")
        check(fields(page) == ("1.5", "1.5") and settings_state(page) == saved_before, f"'{bad}' changes nothing, the saved size is back {fields(page)}")
    check(type_size(page, 2, 3), "a valid size afterwards is saved")
    check(page.inner_text("#logoError").strip() == "", "and the message is gone")

    print("--- saved, and still there after reopening")
    choose_paper(page, "A4"); type_size(page, 4, 3)
    choose_paper(page, "A5"); type_size(page, 1.5, 2)
    page.wait_for_timeout(800)
    page.reload(); ready(page)
    s = settings_state(page)
    check(s["paper"] == "A5" and s["logoSize"] == {"A4": {"width": 4.0, "height": 3.0}, "A5": {"width": 1.5, "height": 2.0}}, f"after a reload: {s}")
    go(page, "settings")
    check(fields(page) == ("1.5", "2"), f"the fields show the saved A5 size {fields(page)}")
    measure(page, "A5 after reload 1.5 x 2", "A5", 1.5, 2)
    choose_paper(page, "A4")
    check(fields(page) == ("4", "3"), f"A4 shows 4 x 3 after the reload {fields(page)}")
    measure(page, "A4 after reload 4 x 3", "A4", 4, 3)

    print("--- the logo: upload, replace, remove (as before), sizes untouched")
    wide = OUT / "wide.png"; Image.new("RGB", (400, 120), (30, 90, 160)).save(wide)
    tall = OUT / "tall.png"; Image.new("RGB", (120, 400), (160, 90, 30)).save(tall)
    go(page, "settings")
    page.set_input_files("#logoFile", str(wide))
    check(eventually(lambda: page.locator("#logoPreview img").count() == 1), "a chosen logo is shown in its preview")
    first = page.evaluate("state.settings.logo")
    measure(page, "A4 4 x 3 with a wide logo", "A4", 4, 3, expect_logo=True)
    go(page, "settings")
    page.set_input_files("#logoFile", str(tall))
    check(eventually(lambda: page.evaluate("state.settings.logo") != first), "a replacement logo is saved")
    check(settings_state(page)["logoSize"]["A4"] == {"width": 4.0, "height": 3.0}, "uploading did not change the sizes")
    measure(page, "A4 4 x 3 with a tall logo", "A4", 4, 3, expect_logo=True)
    go(page, "settings")
    page.click("#removeLogo")
    check(eventually(lambda: page.locator("#logoPreview img").count() == 0 and page.evaluate("state.settings.logo") == ""), "Remove Logo removes it")
    check(settings_state(page)["logoSize"]["A4"] == {"width": 4.0, "height": 3.0}, "removing did not change the sizes")
    doc = measure(page, "A4 4 x 3 without a logo", "A4", 4, 3)
    check(not doc["images"], "the empty box is still drawn, with no picture in it")

    print("--- an older file without the setting")
    go(page, "settings")
    with page.expect_download() as dl:
        page.click("#exportBackup")
    backup = OUT / "backup.json"
    dl.value.save_as(str(backup))
    data = json.loads(backup.read_text(encoding="utf-8"))
    check(data["data"]["settings"].get("logoSize") == {"A4": {"width": 4.0, "height": 3.0}, "A5": {"width": 1.5, "height": 2.0}}, "Export Backup carries both sizes")
    del data["data"]["settings"]["logoSize"]
    old = OUT / "old-backup.json"
    old.write_text(json.dumps(data), encoding="utf-8")
    page.set_input_files("#importFile", str(old))
    check(eventually(lambda: settings_state(page)["logoSize"] is None), "an old backup without logoSize restores and works")
    go(page, "settings")
    paper = settings_state(page)["paper"]
    check(fields(page) == (("3", "3") if paper == "A4" else ("2.5", "2.5")), f"{paper} falls back to its default {fields(page)}")
    measure(page, f"{paper} old file default", paper, 3 if paper == "A4" else 2.5, 3 if paper == "A4" else 2.5)
    # and it can be changed again from there
    check(type_size(page, 2, 1), "a size can be set again after restoring the old file")
    other_paper = "A5" if paper == "A4" else "A4"
    choose_paper(page, other_paper)
    check(fields(page) == (("3", "3") if other_paper == "A4" else ("2.5", "2.5")), f"{other_paper} is still at its default {fields(page)}")

    print("--- languages")
    for lang in ("fr", "ar"):
        go(page, "settings")
        page.select_option("#sLanguage", lang)
        page.wait_for_function(f"document.documentElement.lang === '{lang}'")
        title = page.inner_text("#logoSizeTitle")
        check(title.strip() != "" and "{" not in title and ("A4" in title or "A5" in title), f"{lang}: the title names the paper size: {title!r}")
        check(page.inner_text("label[for=logoWidth]").strip() not in ("", "Logo width (cm)"), f"{lang}: the width label is translated: {page.inner_text('label[for=logoWidth]')!r}")
        w = page.evaluate("document.getElementById('logoWidth').getBoundingClientRect().width")
        check(w > 60, f"{lang}: the number field has room ({w:.0f} px)")
    page.select_option("#sLanguage", "en")

    check(not errors, "no errors in the console: " + "; ".join(errors[:3]))
    browser.close()

print()
if problems:
    print(f"{len(problems)} check(s) failed. PDFs: {OUT}")
    sys.exit(1)
print(f"All logo size checks passed. PDFs: {OUT}")

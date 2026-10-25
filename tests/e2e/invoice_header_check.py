"""Real-browser check of the printed invoice header (file://, disposable profile): logo square, staff contacts, address.

Optional and manual, like invoice_pagination_check.py:   python3 tests/e2e/invoice_header_check.py
Needs Playwright with Chromium and pdfplumber (pip install pdfplumber).

Each invoice is printed to a PDF the way the browser's Print / Save as PDF does (window "beforeprint" included) and the PDF is
measured: the logo square must be 3 x 3 cm on A4 and 2.5 x 2.5 cm on A5, centred, and nothing below the header may move whatever
the logo picture is. The PDFs are kept (INVOISY_PDF_DIR, else a temporary folder) so they can be looked at.
"""
import os, sys, tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright
import pdfplumber

URL = os.environ.get("INVOISY_URL") or (Path(__file__).resolve().parents[2] / "index.html").as_uri()
OUT = Path(os.environ.get("INVOISY_PDF_DIR") or tempfile.mkdtemp(prefix="invoisy-header-"))
OUT.mkdir(parents=True, exist_ok=True)
CM = 72 / 2.54   # points per centimetre
problems = []

def check(cond, label):
    print(("PASS " if cond else "FAIL ") + label)
    if not cond:
        problems.append(label)

# A PNG of the given size (a flat colour with a border, so a stretched or cropped picture is visible), as a data URL.
PNG_JS = """
([w, h]) => { const c = document.createElement("canvas"); c.width = w; c.height = h; const x = c.getContext("2d");
  x.fillStyle = "#1b6e3c"; x.fillRect(0, 0, w, h); x.strokeStyle = "#e00"; x.lineWidth = Math.max(4, Math.min(w, h) / 20); x.strokeRect(0, 0, w, h);
  x.fillStyle = "#fff"; x.font = Math.round(Math.min(w, h) / 6) + "px Arial"; x.fillText("LOGO", w / 10, h / 2); return c.toDataURL("image/png"); }
"""

BUILD_JS = """
(spec) => {
  const items = [];
  for (let i = 0; i < (spec.items || 4); i++) {
    const qty = 2 + i, unitPrice = 1500 + i * 10;
    items.push({ lineId: "l" + i, productId: "p" + i, name: "P" + (i + 1) + " Golden Era", manufacturer: "Garnada", tileSize: "60*120", coveragePerBox: 2.88,
      sellingUnit: "box", sku: "S" + i, qty, unitPrice, total: qty * unitPrice, priceUnit: "box", productPrice: unitPrice, productType: "Faience" });
  }
  const subtotal = items.reduce((s, i) => s + i.total, 0);
  const inv = { id: "i-test-1", invoiceNumber: "INV-000018", date: new Date(2026, 9, 17, 14, 32).toISOString(),
    customer: { name: "Yacine Benali", phone: "0555 11 22 33", address: "" }, items, subtotal, discount: 100, tax: 0, total: subtotal - 100,
    payments: [], discountPercent: null, taxPercent: null, currency: "DA", business: spec.business };
  state.settings.logo = spec.logo || "";
  state.invoices = [inv]; state.previewInvoice = null; viewInvoice(inv.id);
  return inv.id;
}
"""

PEOPLE = [{"name": "Mohamed", "phones": ["0550 00 00 00", "0660 00 00 00"]},
          {"name": "Ahmed", "phones": ["0770 00 00 00", "0790 00 00 00", "021 00 00 00"]},
          {"name": "Yacine", "phones": ["0560 00 00 00", "0670 00 00 00"]}]
BIZ = {"name": "Hedjazi Ceramic", "address": "Zone industrielle, lot 12, Sétif", "phone": "", "email": ""}

def print_pdf(page, name, spec, paper="A4", language="en"):
    spec = {"items": 2, **spec}
    page.evaluate("([p, l]) => { state.settings.paper = p; applyPaperSize(); if (I18n.has(l)) I18n.setLanguage(l); }", [paper, language])
    page.evaluate(BUILD_JS, spec)
    page.wait_for_function("[...document.querySelectorAll('#invoice img')].every((i) => i.complete)")
    path = OUT / f"{name}.pdf"
    page.pdf(path=str(path), prefer_css_page_size=True, print_background=True)
    return path

def read(path):
    with pdfplumber.open(path) as pdf:
        pg = pdf.pages[0]
        return {"w": float(pg.width), "h": float(pg.height), "n": len(pdf.pages), "words": pg.extract_words(), "rects": pg.rects, "lines": pg.lines,
                "images": pg.images, "text": pg.extract_text() or ""}

def logo_box(pdf, side_cm):
    """The bordered square near the top of the page: found as the rectangle (or four lines) of about the expected size."""
    want = side_cm * CM
    for r in pdf["rects"]:
        if abs((r["x1"] - r["x0"]) - want) < 3 and abs((r["bottom"] - r["top"]) - want) < 3:
            return r
    return None

def word_top(pdf, text):
    hits = [w for w in pdf["words"] if w["text"] == text]
    return hits[0]["top"] if hits else None

def run():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.add_init_script("localStorage.clear()")
        page.goto(URL)
        page.wait_for_function("typeof viewInvoice === 'function' && typeof state === 'object'")
        logos = {"none": "", "square": page.evaluate(PNG_JS, [600, 600]), "wide": page.evaluate(PNG_JS, [4000, 300]),
                 "tall": page.evaluate(PNG_JS, [200, 2800]), "huge": page.evaluate(PNG_JS, [5000, 5000]), "tiny": page.evaluate(PNG_JS, [16, 16])}
        full = {**BIZ, "staff": PEOPLE}

        for paper, side in (("A4", 3), ("A5", 2.5)):
            print(f"--- {paper}")
            tops = {}
            for key, logo in logos.items():
                pdf = read(print_pdf(page, f"{paper}-{key}", {"business": full, "logo": logo}, paper))
                box = logo_box(pdf, side)
                check(box is not None, f"{paper} {key}: a {side} x {side} cm square is drawn")
                if box:
                    centre = (box["x0"] + box["x1"]) / 2
                    check(abs(centre - pdf["w"] / 2) < 1.5, f"{paper} {key}: the square is centred on the page (off by {centre - pdf['w'] / 2:.2f} pt)")
                    for im in pdf["images"]:
                        inside = im["x0"] >= box["x0"] - .5 and im["x1"] <= box["x1"] + .5 and im["top"] >= box["top"] - .5 and im["bottom"] <= box["bottom"] + .5
                        check(inside, f"{paper} {key}: the picture stays inside the square")
                        w_, h_ = im["x1"] - im["x0"], im["bottom"] - im["top"]
                        want = {"square": 1, "wide": 4000 / 300, "tall": 200 / 2800, "huge": 1, "tiny": 1}[key]
                        # the long side fills the square; the short side must follow the picture's own proportion (to within a point)
                        long_w = w_ >= h_
                        expect_short = (w_ / want) if long_w else (h_ * want)
                        short = h_ if long_w else w_
                        check(abs(short - expect_short) <= 1.0, f"{paper} {key}: aspect ratio kept ({w_:.1f} x {h_:.1f} pt for a {want:.3f} picture)")
                    if key == "none":
                        check(not pdf["images"], f"{paper} none: no picture, the empty square is still drawn")
                for w in pdf["words"]:
                    if w["x0"] < 0 or w["x1"] > pdf["w"]:
                        check(False, f"{paper} {key}: '{w['text']}' is outside the page"); break
                tops[key] = (word_top(pdf, "Yacine"), word_top(pdf, "Product"))
            check(len(set(tops.values())) == 1, f"{paper}: the rest of the invoice sits at the same height whatever the logo ({set(tops.values())})")

        print("--- layout of the three header parts (A4, square logo)")
        pdf = read(OUT / "A4-square.pdf")
        name = [w for w in pdf["words"] if w["text"].startswith("Hedjazi")][0]
        title = [w for w in pdf["words"] if w["text"] == "INVOICE"][0]
        box = logo_box(pdf, 3)
        check(name["x0"] < box["x0"] and name["x1"] <= box["x0"] and title["x0"] >= box["x1"], "name left of the square, title right of it")
        check(abs(name["top"] - title["top"]) < 6, "name and title share the first line")
        lines = {}
        for w in pdf["words"]:
            if w["top"] > box["top"] + 3 * CM * 0 and w["top"] < pdf["h"]:
                lines.setdefault(round(w["top"]), []).append(w)
        for person in PEOPLE:
            row = [ws for ws in lines.values() if any(w["text"] == person["name"] + ":" for w in ws)]
            check(len(row) == 1, f"{person['name']}: name and all numbers on one line")
            if row:
                ws = row[0]
                check(" ".join(w["text"] for w in ws).count("·") == len(person["phones"]) - 1, f"{person['name']}: {len(person['phones'])} numbers separated by dots")
                centre = (min(w["x0"] for w in ws) + max(w["x1"] for w in ws)) / 2
                check(abs(centre - pdf["w"] / 2) < 3, f"{person['name']}: line centred ({centre - pdf['w'] / 2:.2f} pt)")
        addr = [ws for ws in lines.values() if any(w["text"] == "industrielle," for w in ws)]
        check(len(addr) == 1, "address on its own line")
        if addr:
            centre = (min(w["x0"] for w in addr[0]) + max(w["x1"] for w in addr[0])) / 2
            check(abs(centre - pdf["w"] / 2) < 3, f"address centred ({centre - pdf['w'] / 2:.2f} pt)")
            check(addr[0][0]["top"] > max(w["top"] for w in pdf["words"] if w["text"] == "Yacine:"), "address is under the staff lines")

        print("--- empty and long content")
        empty = read(print_pdf(page, "A4-nothing", {"business": {"name": "Hedjazi Ceramic", "address": "", "phone": "", "email": ""}, "logo": ""}))
        with_staff = read(OUT / "A4-square.pdf")
        check("Mohamed:" not in empty["text"] and "Zone" not in empty["text"], "no staff and no address: nothing is printed for them")
        check(word_top(empty, "Yacine") < word_top(with_staff, "Yacine") - 30, "no staff, no address: the header is shorter (no blank rows)")
        long_biz = {**BIZ, "address": "Cité des 1000 logements, bâtiment B, entrée 4, route nationale numéro 5, zone d'activités commerciales, Sétif, Algérie", "staff": PEOPLE + [
            {"name": "Abderrahmane Bensalem-Bouzid", "phones": ["0550 00 00 01", "0660 00 00 02", "0770 00 00 03", "0790 00 00 04", "021 00 00 05", "036 00 00 06", "0555 00 00 07"]}]}
        for paper in ("A4", "A5"):
            pdf = read(print_pdf(page, f"{paper}-long", {"business": long_biz, "logo": logos["wide"]}, paper))
            check(all(w["x0"] >= 0 and w["x1"] <= pdf["w"] for w in pdf["words"]), f"{paper} long contacts and address: inside the page width")
            ws = sorted(pdf["words"], key=lambda w: (round(w["top"]), w["x0"]))
            overlap = any(a is not b and abs(a["top"] - b["top"]) < 2 and a["x0"] < b["x1"] - 1 and b["x0"] < a["x1"] - 1 for i, a in enumerate(ws) for b in ws[i + 1:i + 4])
            check(not overlap, f"{paper} long contacts and address: no overlapping text")
            check("0555 00 00 07" in pdf["text"] and "Algérie" in pdf["text"], f"{paper} long contacts and address: nothing is cut")

        print("--- Arabic (right to left)")
        pdf = read(print_pdf(page, "A4-ar", {"business": full, "logo": logos["square"]}, "A4", "ar"))
        box = logo_box(pdf, 3)
        check(box is not None and abs((box["x0"] + box["x1"]) / 2 - pdf["w"] / 2) < 1.5, "Arabic: the square is still centred")
        ar_title = [w for w in pdf["words"] if w["top"] < box["bottom"] and w["x1"] <= box["x0"]]
        ar_name = [w for w in pdf["words"] if w["top"] < box["bottom"] and w["x0"] >= box["x1"]]
        check(bool(ar_title) and bool(ar_name), "Arabic: the header text is split around the square (name on the right, title on the left)")
        staff_line = [w for w in pdf["words"] if w["text"] in ("0550", "0660") and w["top"] > box["bottom"]]
        check(len(staff_line) >= 2, "Arabic: the staff numbers are printed")
        browser.close()

run()
print()
print("%d problem(s)" % len(problems) if problems else "All header checks passed. PDFs: %s" % OUT)
sys.exit(1 if problems else 0)

"""Real-browser check of the printed invoice (file://, disposable profile): pages, margins, page numbers, what stays together.

Optional and manual, like browser_check.py:   python3 tests/e2e/invoice_pagination_check.py
Needs Playwright with Chromium and pdfplumber (pip install pdfplumber).

It builds invoices of many shapes in the running app, prints each one to a PDF the way the browser's Print / Save as PDF does
(window "beforeprint" included), and reads the PDFs back. The PDFs are kept (INVOISY_PDF_DIR, else a temporary folder) so they can be looked at.
"""
import os, re, sys, tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright
import pdfplumber

URL = os.environ.get("INVOISY_URL") or (Path(__file__).resolve().parents[2] / "index.html").as_uri()
OUT = Path(os.environ.get("INVOISY_PDF_DIR") or tempfile.mkdtemp(prefix="invoisy-pdfs-"))
OUT.mkdir(parents=True, exist_ok=True)
problems = []
MM = 72 / 25.4   # points per millimetre

def check(cond, label):
    print(("PASS " if cond else "FAIL ") + label)
    if not cond:
        problems.append(label)

# Builds an invoice in the app and shows it in the preview (the same thing the Print button prints).
BUILD_JS = """
(spec) => {
  const items = [];
  const base = spec.longNames ? "Golden Era Super Polished Rectified Glazed Wall And Floor Tile Extra Long Product Name Number" : "Golden Era";
  for (let i = 0; i < spec.items; i++) {
    const qty = 2 + (i % 5), unitPrice = 1500 + i * 10;
    items.push({ lineId: "l" + i, productId: "p" + i, name: "P" + String(i + 1).padStart(3, "0") + " " + base, manufacturer: "Garnada", tileSize: "60*120",
      coveragePerBox: 2.88, sellingUnit: "box", sku: "S" + i, qty, unitPrice, total: qty * unitPrice, priceUnit: "box", productPrice: unitPrice,
      productType: i % 2 ? "Porcelain" : "Faience" });
  }
  const subtotal = items.reduce((s, i) => s + i.total, 0);
  const discount = spec.discount === undefined ? 100 : spec.discount, tax = spec.tax || 0, total = subtotal - discount + tax;
  const payments = [];
  for (let k = 0; k < (spec.payments || 0); k++) payments.push({ amount: 1000 + k, timestamp: new Date(2026, 9, 1 + (k % 28), 9, k % 60).toISOString() });
  const inv = {
    id: "i-test-" + Math.random().toString(36).slice(2), invoiceNumber: "INV-000018", date: new Date(2026, 9, 17, 14, 32).toISOString(),
    customer: { name: spec.customer || "Yacine Benali", phone: "0555 11 22 33", address: "" },
    items, subtotal, discount, tax, total, payments, discountPercent: null, taxPercent: null, currency: "DA",
    business: { name: "Hedjazi Ceramic", address: "Zone industrielle, Sétif", phone: "0555 12 34 56", email: "contact@hedjazi.example" },
  };
  if (spec.secondCustomer) inv.secondCustomer = { name: spec.secondCustomer };
  if (spec.deliveries) {
    inv.items.forEach((it) => { it.deliveredNow = it.qty; });
    inv.deliveries = spec.deliveries.map((d, n) => ({ type: n === 0 ? "sale" : "collection", date: new Date(2026, 9, 17 + n, 10, 0).toISOString(), note: "", lines: [{ lineId: "l0", qty: 1 }] }));
  }
  if (spec.logo) state.settings.logo = spec.logo;
  state.invoices = [inv];
  state.previewInvoice = null;
  viewInvoice(inv.id);
  return inv.id;
}
"""

def read_pdf(path):
    pages = []
    with pdfplumber.open(path) as pdf:
        for pg in pdf.pages:
            words = pg.extract_words()
            pages.append({"w": float(pg.width), "h": float(pg.height), "words": words, "text": pg.extract_text() or ""})
    return pages

def print_invoice(page, name, spec, paper="A4", language="en"):
    page.evaluate("([p, l]) => { state.settings.paper = p; applyPaperSize(); if (I18n.has(l)) { I18n.setLanguage(l); } state.settings.logo = ''; }", [paper, language])
    page.evaluate(BUILD_JS, spec)
    path = OUT / f"{name}.pdf"
    page.pdf(path=str(path), prefer_css_page_size=True, print_background=True)   # fires "beforeprint" like the print dialog
    return read_pdf(path)

SUMMARY = ["Subtotal", "Discount", "Tax", "Total Paid", "Remaining", "STATUS:"]
SUMMARY_FR = ["Sous-total", "Remise", "Taxe", "Total payé", "Reste à payer", "STATUT :"]

def pages_with(pages, needle):
    return [i for i, p in enumerate(pages) if needle in p["text"]]

def summary_together(pages, keys=SUMMARY):
    """The whole financial summary (subtotal, discount, tax, total, paid, remaining, status) is on ONE page."""
    where = {k: pages_with(pages, k) for k in keys}
    total_page = [i for i, p in enumerate(pages) if re.search(r"^TOTAL\b", p["text"], re.M)]
    return all(len(v) == 1 for v in where.values()) and len(total_page) == 1 and len({v[0] for v in where.values()} | {total_page[0]}) == 1

def product_numbers(pages):
    # a product row starts a line with its number (delivery history lines mention products too, in the middle of a line)
    return [[int(n) for n in re.findall(r"^P(\d{3})\b", p["text"], re.M)] for p in pages]

def every_product_once(pages, n):
    flat = [x for page in product_numbers(pages) for x in page]
    return flat == list(range(1, n + 1))

def rows_whole(pages):
    """On every page the products and their type lines match up: no row is cut in two."""
    for p in pages:
        rows = len(re.findall(r"^P\d{3}\b", p["text"], re.M))
        types = len(re.findall(r"\b(?:Faience|Porcelain)\b", p["text"]))
        if rows != types:
            return False
    return True

def continuation_ok(pages, customer="Yacine Benali"):
    if "CONTINUED" in pages[0]["text"]:
        return False
    for p in pages[1:]:
        t = p["text"]
        if not all(s in t for s in ("Hedjazi Ceramic", "INVOICE — CONTINUED", "INV-000018", "17/10/2026", customer)):
            return False
    return True

def numbering_ok(pages):
    total = len(pages)
    return all(f"Page {i + 1} of {total}" in p["text"] for i, p in enumerate(pages))

def headings_repeat(pages):
    """Every page that carries products repeats the column headings."""
    for p in pages:
        if re.search(r"^P\d{3}\b", p["text"], re.M):
            if not all(h in p["text"] for h in ("Product", "Qty", "Price (DA)", "Total (DA)")):
                return False
    return True

def inside_margins(pages, side_mm=14, top_mm=14, bottom_mm=7):
    """No text outside the printable area; the content never reaches the footer zone."""
    for p in pages:
        if not p["words"]:
            return False
        if min(w["x0"] for w in p["words"]) < side_mm * MM or max(w["x1"] for w in p["words"]) > p["w"] - side_mm * MM:
            return False
        if min(w["top"] for w in p["words"]) < top_mm * MM or max(w["bottom"] for w in p["words"]) > p["h"] - bottom_mm * MM:
            return False
    return True

def content_clear_of_footer(pages, footer_top_mm=15.5):
    """Apart from the footer line, nothing is printed in the bottom margin."""
    for p in pages:
        for w in p["words"]:
            if w["bottom"] > p["h"] - footer_top_mm * MM and w["top"] < p["h"] - 8 * MM:
                if not re.match(r"^(Page|\d+|of|sur|INV-\d+)$", w["text"]):
                    return False
    return True

def no_overlap(pages):
    for p in pages:
        ws = p["words"]
        for i in range(len(ws)):
            a = ws[i]
            for j in range(i + 1, len(ws)):
                b = ws[j]
                dx = min(a["x1"], b["x1"]) - max(a["x0"], b["x0"])
                dy = min(a["bottom"], b["bottom"]) - max(a["top"], b["top"])
                if dx > 1 and dy > 1:
                    area = dx * dy
                    small = min((a["x1"] - a["x0"]) * (a["bottom"] - a["top"]), (b["x1"] - b["x0"]) * (b["bottom"] - b["top"]))
                    if small and area / small > 0.2:
                        return False
    return True

def no_blank_page(pages):
    return all(re.search(r"\bP\d{3}\b|STATUS:|PAYMENT|DELIVERY|Thank you|Merci|Paid:|Payé|BALANCE", p["text"]) for p in pages)

LOGO = "data:image/svg+xml;utf8," + "<svg xmlns='http://www.w3.org/2000/svg' width='300' height='200'><rect width='300' height='200' fill='%23446'/></svg>".replace("#", "%23")

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_context().new_page()
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append("PAGEERROR " + str(e)))
    page.goto(URL)
    page.click('.nav-btn[data-view="settings"]')
    page.wait_for_function("document.getElementById('dataState').textContent === 'Ready'", timeout=10000)
    print("PDFs are written to", OUT)

    # 1. Short invoice: one page, nothing blank, numbered, no continuation header.
    pdf = print_invoice(page, "01-short", {"items": 3, "payments": 1})
    check(len(pdf) == 1, "1. short invoice is one page (%d)" % len(pdf))
    check(summary_together(pdf) and every_product_once(pdf, 3) and "Thank you for your purchase." in pdf[0]["text"], "1. short invoice holds everything once")
    check(numbering_ok(pdf) and continuation_ok(pdf), "1. short invoice is numbered 'Page 1 of 1' and has no continuation header")
    check(inside_margins(pdf), "1. short invoice stays inside the margins")

    # 2 + 7. Multi-page and large invoices: products flow, headings repeat, headers and numbers on every later page.
    for n, name in ((28, "02-multipage"), (100, "07-large")):
        pdf = print_invoice(page, name, {"items": n, "payments": 2})
        label = "%d products, %d pages" % (n, len(pdf))
        check(len(pdf) >= (2 if n == 28 else 3), "2/7. %s: expected page count" % label)
        check(every_product_once(pdf, n), "2/7. %s: no product lost or repeated, in order" % label)
        check(rows_whole(pdf) and headings_repeat(pdf), "2/7. %s: rows whole, column headings repeated on every page" % label)
        check(continuation_ok(pdf) and numbering_ok(pdf), "2/7. %s: continuation header and 'Page i of N' on every page" % label)
        check(summary_together(pdf) and inside_margins(pdf) and content_clear_of_footer(pdf) and no_overlap(pdf) and no_blank_page(pdf), "2/7. %s: summary together, margins, no overlap, no blank page" % label)

    # 3. The summary at the page boundary, at EVERY product count: always whole, and only moved when it does not fit.
    moved, stayed = [], []
    for n in range(1, 46):
        pdf = print_invoice(page, "03-sweep-%02d" % n, {"items": n, "payments": 1})
        ok = summary_together(pdf) and every_product_once(pdf, n) and rows_whole(pdf) and numbering_ok(pdf) and continuation_ok(pdf) \
            and inside_margins(pdf) and content_clear_of_footer(pdf) and no_blank_page(pdf) and headings_repeat(pdf)
        check(ok, "3. sweep, %d products (%d page%s): everything whole, numbered, inside the margins" % (n, len(pdf), "" if len(pdf) == 1 else "s"))
        status_page = pages_with(pdf, "STATUS:")[0]
        last_product_page = max(i for i, nums in enumerate(product_numbers(pdf)) if nums)
        (moved if status_page > last_product_page else stayed).append(n)
    check(bool(moved) and bool(stayed), "3. the summary stays under the products when it fits (%s ...) and moves whole when it does not (%s ...)" % (stayed[-3:], moved[:3]))
    print("INFO summary under the last product for %s; moved whole to the next page for %s" % (stayed, moved))

    # 4. Payment history spanning pages: entries continue, the summary is not disturbed.
    pdf = print_invoice(page, "04-payments", {"items": 9, "payments": 70})
    paid = [int(x.replace(",", "")) for pg in pdf for x in re.findall(r"Paid: ([\d,]+) DA", pg["text"])]
    check(len(pdf) >= 3 and paid == list(range(1000, 1070)), "4. 70 payments over %d pages, each exactly once and in order" % len(pdf))
    check(summary_together(pdf) and pages_with(pdf, "STATUS:") == [0] and every_product_once(pdf, 9), "4. summary stays whole on page 1 while the history flows on")
    history_pages = pages_with(pdf, "Paid:")
    first, later = history_pages[0], history_pages[1:]
    check(first >= 1 and "PAYMENT HISTORY\n" in pdf[first]["text"] + "\n" and "(continued)" not in pdf[first]["text"].split("PAYMENT HISTORY")[1].split("\n")[0]
          and bool(later) and all("PAYMENT HISTORY (continued)" in pdf[i]["text"] for i in later) and history_pages == list(range(first, len(pdf))),
          "4. the history starts with its heading and first entry together (page %d) and later pages repeat it as 'continued'" % (first + 1))
    check(numbering_ok(pdf) and continuation_ok(pdf), "4. header and 'Page i of N' present on every page")
    check(inside_margins(pdf) and content_clear_of_footer(pdf) and no_overlap(pdf), "4. payment pages inside the margins, no overlap")

    # 5. No payments: the existing message, cleanly, and no mostly empty extra page.
    pdf = print_invoice(page, "05-no-payments", {"items": 5, "payments": 0})
    check(len(pdf) == 1 and "No payments yet." in pdf[0]["text"] and summary_together(pdf), "5. 'No payments yet.' on a one-page invoice")
    for n in range(8, 36):
        pdf = print_invoice(page, "05-no-payments-%02d" % n, {"items": n, "payments": 0})
        ok = len(pages_with(pdf, "No payments yet.")) == 1 and len(pages_with(pdf, "PAYMENT HISTORY")) == 1 \
            and pages_with(pdf, "No payments yet.") == pages_with(pdf, "PAYMENT HISTORY") and summary_together(pdf) and no_blank_page(pdf)
        if not ok:
            check(False, "5. %d products without payments: heading and message together, summary whole" % n)
    check(not [x for x in problems if x.startswith("5.")], "5. with no payments the heading and message always stay together at 8-35 products")

    # 6. Long product names wrap inside their row; a row's lines are never separated or overlapping.
    for n in (6, 14, 30):
        pdf = print_invoice(page, "06-long-names-%02d" % n, {"items": n, "payments": 1, "longNames": True})
        check(every_product_once(pdf, n) and rows_whole(pdf) and summary_together(pdf) and no_overlap(pdf) and inside_margins(pdf) and content_clear_of_footer(pdf) and numbering_ok(pdf),
              "6. %d products with long names (%d pages): rows whole, no overlap" % (n, len(pdf)))

    # 8. The final page: the thank-you comes last, once, and never on a page of its own when it fits.
    for n in (3, 10, 14, 22, 30, 45):
        pdf = print_invoice(page, "08-final-%02d" % n, {"items": n, "payments": 3})
        thanks = pages_with(pdf, "Thank you for your purchase.")
        body = pdf[-1]["text"]
        after_history = body.index("Thank you") > body.index("Paid:") if "Paid:" in body else True
        check(thanks == [len(pdf) - 1] and after_history, "8. %d products: thank-you is once, last, after the payment history (page %d of %d)" % (n, thanks[0] + 1 if thanks else 0, len(pdf)))
    fits_on_summary_page = print_invoice(page, "08-final-fit", {"items": 12, "payments": 1})
    check(len(fits_on_summary_page) == 1 or "Thank you for your purchase." in fits_on_summary_page[-1]["text"], "8. no extra page just for the thank-you when it fits")

    # 9. Margins on every page, on both paper sizes.
    pdf = print_invoice(page, "09-margins-a4", {"items": 40, "payments": 4})
    check(inside_margins(pdf) and abs(pdf[0]["w"] - 210 * MM) < 2, "9. A4: %d pages, nothing clipped, same spacing on all pages" % len(pdf))
    lefts = {round(min(w["x0"] for w in p["words"])) for p in pdf}
    tops = {round(min(w["top"] for w in p["words"]) / 4) for p in pdf[1:]}
    check(len(lefts) == 1 and len(tops) == 1, "9. A4: identical left margin on every page (%s), identical top on continuation pages" % sorted(lefts))
    pdf = print_invoice(page, "09-margins-a5", {"items": 30, "payments": 4}, paper="A5")
    check(abs(pdf[0]["w"] - 148 * MM) < 2 and inside_margins(pdf, side_mm=9, top_mm=9, bottom_mm=5) and numbering_ok(pdf) and continuation_ok(pdf) and summary_together(pdf) and every_product_once(pdf, 30),
          "9. A5: %d pages, margins, numbering, continuation header, summary whole, all products" % len(pdf))

    # Other shapes: French, delivery history, second customer, a logo (measured while it loads).
    pdf = print_invoice(page, "10-french", {"items": 30, "payments": 2}, language="fr")
    check(len(pdf) >= 2 and all(f"Page {i + 1} sur {len(pdf)}" in p["text"] for i, p in enumerate(pdf)) and all("FACTURE — SUITE" in p["text"] for p in pdf[1:]) and "CONTINUED" not in " ".join(p["text"] for p in pdf),
          "10. French: 'Page i sur N' on every page, 'FACTURE — SUITE' on every later page (%d pages)" % len(pdf))
    check(summary_together(pdf, SUMMARY_FR) and every_product_once(pdf, 30), "10. French: the whole summary is on one page and every product appears once")
    pdf = print_invoice(page, "10-delivery", {"items": 16, "payments": 2, "deliveries": [1] * 30})
    check(len(pdf) >= 2 and every_product_once(pdf, 16) and numbering_ok(pdf) and inside_margins(pdf) and no_overlap(pdf) and "DELIVERY HISTORY" in " ".join(p["text"] for p in pdf),
          "10. delivery history flows with its status label (%d pages)" % len(pdf))
    pdf = print_invoice(page, "10-second-customer", {"items": 28, "payments": 1, "secondCustomer": "Builder Co"})
    check(continuation_ok(pdf, customer="Yacine Benali / Builder Co"), "10. continuation header names both customers")
    page.evaluate("l => { state.settings.logo = l; }", LOGO)
    page.evaluate("() => { state.previewInvoice = null; }")
    spec = {"items": 14, "payments": 1}
    page.evaluate(BUILD_JS, spec)
    page.evaluate("l => { state.settings.logo = l; renderInvoice(); }", LOGO)
    path = OUT / "10-logo.pdf"
    page.pdf(path=str(path), prefer_css_page_size=True, print_background=True)
    pdf = read_pdf(path)
    check(summary_together(pdf) and every_product_once(pdf, 14) and inside_margins(pdf) and content_clear_of_footer(pdf), "10. invoice with a logo (%d pages)" % len(pdf))

    # Stale pages: changing the previewed invoice must not leave old pages behind.
    stale = page.evaluate("() => { renderInvoice(); return [document.getElementById('invoicePages').children.length, document.documentElement.dataset.invoicePages || '']; }")
    check(stale == [0, ""], "no printed pages are left behind once the preview is drawn again")

    # The screen: the invoice preview is the same as before and the built pages never show.
    page.evaluate(BUILD_JS, {"items": 30, "payments": 2})
    shown = page.evaluate("() => getComputedStyle(document.getElementById('invoicePages')).display")
    check(shown == "none", "the printed pages are not visible on screen")
    check(page.locator("#invoice .inv-summary .inv-status").count() == 1 and page.locator("#invoice .inv-table tbody tr").count() == 30, "the preview still shows the whole invoice, with the status inside the summary")

    # Other printed documents are untouched: the collection document printed right after an invoice (whose pages are still built)
    # is that document alone, with no invoice pages, continuation headers or page numbers.
    print_invoice(page, "12-before-collection", {"items": 30, "payments": 2, "deliveries": [1, 1]})
    built = page.evaluate("() => document.getElementById('invoicePages').children.length")
    page.evaluate("() => { const inv = state.invoices[0]; document.getElementById('collectionPrint').innerHTML = collectionHtml(inv); document.body.dataset.printing = 'collection'; }")
    path = OUT / "12-collection.pdf"
    page.pdf(path=str(path), prefer_css_page_size=True, print_background=True)
    page.evaluate("() => { delete document.body.dataset.printing; }")
    pdf = read_pdf(path)
    alltext = " ".join(p["text"] for p in pdf)
    check(built >= 2 and "COL-000018" in alltext and "STATUS:" not in alltext and "Page 1 of" not in alltext and "INVOICE — CONTINUED" not in alltext,
          "the collection document prints alone, even right after an invoice was printed (%d pages built before)" % built)

    # The fall-back: if pages can not be built the browser prints the preview as before.
    page.evaluate("() => { window.__real = InvoicePrint.paginate; InvoicePrint.paginate = () => { throw new Error('boom'); }; }")
    page.evaluate(BUILD_JS, {"items": 5, "payments": 1})
    path = OUT / "11-fallback.pdf"
    page.pdf(path=str(path), prefer_css_page_size=True, print_background=True)
    pdf = read_pdf(path)
    check(len(pdf) == 1 and "STATUS:" in pdf[0]["text"] and "Page 1 of" not in pdf[0]["text"], "if laying out the pages fails, the invoice still prints the old way")
    page.evaluate("() => { InvoicePrint.paginate = window.__real; }")

    check(not errors, "no console errors: %s" % errors[:3])
    browser.close()

print()
print("FAILED: %d" % len(problems) if problems else "All checks passed.")
sys.exit(1 if problems else 0)

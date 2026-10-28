"""Real-browser check of the Dashboard's Supplier Price Insights, opened straight from disk (file://).

Optional and manual (not part of `npm test`; it needs a browser):
    pip install playwright && playwright install chromium     (or point Playwright at a Chromium you already have)
    python3 tests/e2e/price_insights_check.py
It uses a brand new browser profile and a disposable IndexedDB, so no real business data is touched.
Set SHOTS=/some/folder to also save screenshots.
"""
import os, sys
from datetime import date, timedelta
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

def day(offset):
    return (date.today() + timedelta(days=offset)).isoformat()

SEED = """
async (days) => {
  const mk = (id, name, size, maker, cov) => normalizeProduct({ id, name, tileSize: size, manufacturer: maker, coveragePerBox: cov, sku: id.toUpperCase(), category: "Tiles",
    sellingPrice: 1000, priceUnit: "m2", stock: 50, stockUnit: "box" });
  await commit((d) => {
    d.products.push(mk("p1", "Everton Grey", "60*60", "TecnoCeram", 1.44), mk("p2", "Berlin Silver", "30*90", "Ceram Decor", 1.62),
                    mk("p3", "Metro Gray", "45*90", "TecnoCeram", 1.215), mk("p4", "Same Price Tile", "60*60", "TecnoCeram", 1.44));
  });
  const sup = {};
  const names = ["Timgad Distribution", "Ceram Gros", "Sétif Matériaux"];
  for (const [n, name] of names.entries()) {
    const r = await commit((d) => Purchases.saveSupplier(d, { name, phone: "0555 10 20 3" + n }));
    if (!r.supplier) throw new Error(JSON.stringify(r.error || r));
    sup[name] = r.supplier.id;
  }
  const buy = async (supplier, invoiceDate, productId, unit, price, qty) => {
    const r = await commit((d) => {
      const made = Purchases.saveDraft(d, { supplierId: sup[supplier], supplierInvoiceNumber: "F" + Math.random().toString(36).slice(2, 7), invoiceDate,
        lines: [{ productId, unit, qty: String(qty || 10), unitPrice: String(price) }] });
      if (!made.purchase) throw new Error(made.error && made.error.message || JSON.stringify(made));
      return Purchases.confirmPurchase(d, made.purchase.id);
    });
    if (!r.purchase) throw new Error(JSON.stringify(r.error));
  };
  await buy("Timgad Distribution", days[0], "p1", "box", 1200);
  await buy("Ceram Gros", days[1], "p1", "box", 1350);
  await buy("Timgad Distribution", days[2], "p1", "box", 1250);    // Timgad changed its price
  await buy("Sétif Matériaux", days[2], "p1", "box", 1180);        // a third supplier
  await buy("Timgad Distribution", days[0], "p2", "m2", 800, 19.44);  // 800 DA/m2 ...
  await buy("Ceram Gros", days[1], "p2", "box", 1100, 5);          // ... against 1,100 DA/box (= 679 DA/m2)
  await buy("Timgad Distribution", days[0], "p3", "box", 1000);
  await buy("Ceram Gros", days[1], "p3", "box", 1015);             // a 1.5 % gap
  await buy("Timgad Distribution", days[0], "p4", "box", 900);
  await buy("Ceram Gros", days[1], "p4", "box", 900);              // same price
  renderAll();
}
"""

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.goto(URL)
    page.wait_for_selector("#view-dashboard", state="visible")

    check(page.get_attribute('.nav-btn[data-view="dashboard"]', "aria-current") == "page", "Invoisy opens on the Dashboard")
    check(page.is_hidden("#view-sell"), "the Sell page is not the first page")
    check("No supplier price differences" in page.inner_text("#dashboardRoot"), "empty state is calm and explains itself")
    shot(page, "1-empty")

    page.evaluate(SEED, [day(-20), day(-12), day(-2)])
    page.click('.nav-btn[data-view="sell"]')
    page.click("#brand")
    page.wait_for_selector("#view-dashboard", state="visible")
    cards = page.locator(".pi-card")
    check(cards.count() == 2 + 1, f"three products have a difference, the same-price one does not (cards: {cards.count()})")
    text = page.inner_text("#dashboardRoot")
    check("Same Price Tile" not in text, "equal prices are not flagged")
    check("Everton Grey" in text and "Berlin Silver" in text and "Metro Gray" in text, "the three products are listed")
    check("Timgad Distribution" in text and "Ceram Gros" in text and "Sétif Matériaux" in text, "suppliers named (not manufacturers)")
    check("TecnoCeram" not in text, "the manufacturer is not shown as a supplier")
    first = cards.nth(0).inner_text()
    check("Berlin Silver" in first, "the biggest gap (800 DA/m² against ≈679 DA/m²) comes first")
    check("Metro Gray" in cards.nth(2).inner_text(), "the 1.5 % gap comes last")
    shot(page, "2-dashboard")

    # History opens inside the card.
    page.click("#pi-head-p1")
    page.wait_for_selector("#pi-detail-p1")
    detail = page.inner_text("#pi-detail-p1")
    check("Price changes by the same supplier" in detail and "Timgad Distribution went from" in detail, "the same supplier's price change is shown as history")
    check(page.locator("#pi-detail-p1 [data-act=dash-purchase]").count() == 4, "all four purchases of the product are listed")
    shot(page, "3-history-open")

    # A purchase opens on the Purchases page.
    page.locator("#pi-detail-p1 [data-act=dash-purchase]").first.click()
    page.wait_for_selector("#view-purchases", state="visible")
    check("PUR-" in page.inner_text("#purchasesRoot"), "View purchase opens that purchase")
    page.click("#brand")
    page.wait_for_selector("#view-dashboard", state="visible")

    # Open in Stock narrows the Stock page to that product and marks its row.
    page.locator('.pi-card[data-product="p1"] [data-act=dash-stock]').click()
    page.wait_for_selector("#view-stock", state="visible")
    rows = page.locator("#stockBody tr")
    check(rows.count() == 1 and "Everton Grey" in rows.first.inner_text(), "Open in Stock shows only that product")
    check(rows.first.get_attribute("class") == "is-focus", "its row is marked")
    shot(page, "4-stock")
    page.click("#brand")

    # Phone width: nothing scrolls sideways.
    page.set_viewport_size({"width": 390, "height": 800})
    page.wait_for_selector(".pi-card")
    # The app's own side menu already pushes every page a few pixels past a 390 px screen (all pages, even an empty Dashboard);
    # what is checked here is that nothing of the new section reaches beyond the screen.
    beyond = page.evaluate("""() => { const w = document.documentElement.clientWidth;
      return [...document.querySelectorAll('#dashboardRoot *')].filter((e) => !e.closest('.table-wrap') || e.classList.contains('table-wrap')).filter((e) => e.getBoundingClientRect().right > w + 0.5).map((e) => e.className); }""")
    check(not beyond, f"nothing of the Supplier Price Insights section goes past a 390 px screen ({beyond[:3]})")
    shot(page, "5-narrow")
    page.set_viewport_size({"width": 1280, "height": 900})

    # French and Arabic.
    page.evaluate("commit((d) => { d.settings.language = 'fr'; }).then(() => renderAll())")
    page.wait_for_function("document.getElementById('pi-title') && document.getElementById('pi-title').textContent.includes('Écarts')")
    shot(page, "6-french")
    page.evaluate("commit((d) => { d.settings.language = 'ar'; }).then(() => renderAll())")
    page.wait_for_function("document.documentElement.dir === 'rtl' && document.getElementById('pi-title').textContent.includes('فروقات')")
    shot(page, "7-arabic")
    page.evaluate("commit((d) => { d.settings.language = 'en'; }).then(() => renderAll())")

    check(not errors, "no console errors: " + "; ".join(errors[:3]))
    browser.close()

print()
print("ALL CHECKS PASSED" if not problems else f"{len(problems)} CHECK(S) FAILED")
sys.exit(1 if problems else 0)

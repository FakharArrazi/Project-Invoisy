"""Real-browser check of the Dashboard (business analytics), opened straight from disk (file://).

Optional and manual (not part of `npm test`; it needs a browser):
    pip install playwright && playwright install chromium
    python3 tests/e2e/dashboard_check.py
It uses a brand new browser profile and a disposable IndexedDB, so no real business data is touched.
Set SHOTS=/some/folder to also save screenshots.
"""
import os, sys
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
        size = page.viewport_size
        page.set_viewport_size({"width": size["width"], "height": 3200})   # the page scrolls inside itself: make it tall enough to show everything
        page.screenshot(path=str(Path(SHOTS) / (name + ".png")))
        page.set_viewport_size(size)

SEED = """
async () => {
  const mk = (id, name, size, maker, cov, unit, price, stock) => Validation.normalizeProduct({ id, name, tileSize: size, manufacturer: maker, coveragePerBox: cov,
    sku: id.toUpperCase(), category: "Tiles", sellingPrice: price, priceUnit: unit, stock, stockUnit: unit });
  const products = [
    mk("p1", "Everton Grey", "60*60", "Timgad Ceramic", 1.44, "box", 2000, 40),
    mk("p2", "Berlin Silver", "30*90", "Ceram Decor", 1.62, "box", 2600, 3),
    mk("p3", "Metro Gray", "45*90", "TecnoCeram", 1.215, "m2", 1500, 120),
    mk("p4", "Marble White", "60*120", "Timgad Ceramic", 2.88, "box", 4200, 0),
    mk("p5", "Sleepy Beige", "40*40", "Ceram Decor", 1.6, "box", 1700, 25),
    mk("p6", "Oak Wood Look", "20*120", "TecnoCeram", 1.2, "box", 3100, 5),
    mk("p7", "Cement Skirting", "8*60", "TecnoCeram", 0, "piece", 400, 200),
  ];
  const day = (offset, hour) => { const d = new Date(); d.setHours(hour || 11, 20, 0, 0); d.setDate(d.getDate() + offset); return d.toISOString(); };
  let seed = 7; const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
  const names = [["Karim Benali", "0555 11 22 33"], ["Samir Haddad", "0661 44 55 66"], ["Nadia Cherif", "0770 12 34 56"], ["Entreprise Amrani", "0550 98 76 54"], ["Yacine Boudiaf", "0698 22 33 44"], ["", ""]];
  const items = (p, qty, unit) => { const price = p.sellingPrice; return { productId: p.id, name: p.name, manufacturer: p.manufacturer, tileSize: p.tileSize, coveragePerBox: p.coveragePerBox, sellingUnit: unit, qty, unitPrice: price, total: Math.round(price * qty * 100) / 100, priceUnit: unit }; };
  const invoices = [];
  let n = 0;
  for (let ago = 70; ago >= 0; ago--) {
    const count = ago === 0 ? 3 : ago === 1 ? 2 : Math.floor(rnd() * 3);
    for (let k = 0; k < count; k++) {
      n++;
      const p = products[Math.floor(rnd() * 3) + (rnd() > 0.7 ? 3 : 0)] || products[0];
      const unit = p.stockUnit; const qty = unit === "box" ? 2 + Math.floor(rnd() * 18) : unit === "m2" ? 10 + Math.floor(rnd() * 40) : 20 + Math.floor(rnd() * 80);
      const it = items(p, qty, unit);
      const [cname, cphone] = names[Math.floor(rnd() * names.length)];
      const total = it.total;
      const paid = rnd() > 0.55 ? total : rnd() > 0.5 ? Math.round(total * 0.4) : 0;
      invoices.push(Validation.normalizeInvoice({
        id: "inv" + n, invoiceNumber: Validation.formatInvoiceNumber(n), date: day(-ago, 9 + k * 3), customer: { name: cname, phone: cphone, address: "" },
        items: [it], subtotal: total, discount: 0, tax: 0, total, currency: "DA", business: { name: "My Store" },
        payments: paid > 0 ? [{ amount: paid, timestamp: day(-ago, 10 + k * 3) }] : [],
      }));
    }
  }
  await commit((d) => { d.products = products; d.invoices = invoices; d.counter = n; });
  renderAll();
  return invoices.length;
}
"""

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.goto(URL)
    page.wait_for_selector("#analyticsRoot .dc-card", state="attached")

    check(page.locator(".dc-card").count() == 6, "six summary cards")
    check("No invoices yet" in page.inner_text("#analyticsRoot"), "empty shop: calm empty state")
    shot(page, "1-empty")

    count = page.evaluate(SEED)
    page.click('.nav-btn[data-view="sell"]')
    page.click("#brand")
    page.wait_for_selector("#analyticsRoot .dc-bar")
    text = page.inner_text("#analyticsRoot")
    check(count > 40, f"seeded {count} invoices")
    check(page.locator(".dc-card").count() == 6, "six cards with data")
    check("NaN" not in text and "undefined" not in text and "Infinity" not in text, "no NaN / undefined anywhere")
    check(page.locator("#analyticsRoot .dc-rank li").count() >= 3, "best sellers listed")
    check(page.locator("#analyticsRoot .dc-click").count() >= 5, "recent sales rows listed")
    check(page.locator("#analyticsRoot .dc-alert").count() >= 2, "stock alerts listed (out of stock and low stock)")
    shot(page, "2-dashboard-30d")

    # Hovering a bar shows its figures.
    page.locator("#dc-period-7").click()
    bars = page.locator(".dc-chart").first.locator(".dc-bar")
    check(bars.count() == 7, "7 day chart has 7 bars")
    bars.nth(6).hover()
    check(len(page.locator(".dc-detail").first.inner_text()) > 20 and "Hover" not in page.locator(".dc-detail").first.inner_text(), "hovering a bar shows its figures")
    page.locator("#dc-period-12m").click()
    check(page.locator(".dc-chart").first.locator(".dc-bar").count() == 12, "12 month chart has 12 bars")
    shot(page, "3-dashboard-12m")
    page.locator("#dc-period-month").click()
    page.locator("#dc-pmode-quantity").click()
    check(page.locator("#analyticsRoot .dc-unit").count() >= 2, "quantity ranking is split by unit")
    shot(page, "4-quantity-by-unit")
    page.locator("#dc-status-value").click()
    page.locator("#dc-slow-30").click()

    # Navigation.
    page.locator("#analyticsRoot .dc-click").first.click()
    page.wait_for_selector("#view-sell", state="visible")
    check((page.evaluate("state.previewInvoice && state.previewInvoice.invoiceNumber") or "").startswith("INV-"), "a recent sale opens that invoice on the Sell page")
    page.click("#brand")
    page.locator('[data-act="dc-customer"]').first.click()
    page.wait_for_selector("#view-invoices", state="visible")
    check(page.input_value("#invoiceFilter") != "", "a customer opens the Invoices page, searched for them")
    page.click("#brand")
    page.locator('#analyticsRoot [data-act="dc-product"]').first.click()
    page.wait_for_selector("#view-stock", state="visible")
    check(page.locator("#stockBody tr.is-focus").count() == 1, "a product opens the Stock page with its row marked")
    page.click("#brand")
    check(page.locator("#dashboardRoot .panel").count() >= 1, "the supplier price insights section is still on the page")

    # Phone width.
    page.set_viewport_size({"width": 390, "height": 800})
    beyond = page.evaluate("""() => { const w = document.documentElement.clientWidth;
      return [...document.querySelectorAll('#analyticsRoot *')].filter((e) => !e.closest('.table-wrap') || e.classList.contains('table-wrap')).filter((e) => e.getBoundingClientRect().right > w + 0.5).map((e) => e.className); }""")
    check(not beyond, f"nothing of the dashboard goes past a 390 px screen ({beyond[:4]})")
    shot(page, "5-narrow")
    page.set_viewport_size({"width": 820, "height": 900})
    shot(page, "6-tablet")
    page.set_viewport_size({"width": 1280, "height": 900})

    page.evaluate("commit((d) => { d.settings.language = 'fr'; }).then(() => renderAll())")
    page.wait_for_function("document.getElementById('analyticsRoot').textContent.includes('Ventes du jour')")
    shot(page, "7-french")
    page.evaluate("commit((d) => { d.settings.language = 'ar'; }).then(() => renderAll())")
    page.wait_for_function("document.documentElement.dir === 'rtl' && document.getElementById('analyticsRoot').textContent.includes('مبيعات اليوم')")
    shot(page, "8-arabic")
    page.evaluate("commit((d) => { d.settings.language = 'en'; }).then(() => renderAll())")

    check(not errors, "no console errors: " + "; ".join(errors[:3]))
    browser.close()

print()
print("ALL CHECKS PASSED" if not problems else f"{len(problems)} CHECK(S) FAILED")
sys.exit(1 if problems else 0)

"""Real-browser check of Settings -> Product types: add and remove types, and see them in the product form at once.

Optional and manual (NOT part of `npm test`; needs a browser):
    pip install playwright && playwright install chromium
    python3 tests/e2e/product_types_check.py
Set INVOISY_CHROME=/path/to/chrome to use an installed Chrome instead of Playwright's Chromium.
Set INVOISY_SHOTS=/some/folder to also save screenshots.
Brand new browser profile and disposable IndexedDB: no real business data is touched.

It checks, in a real page: the list starts with the built-in types; Add (button and Enter) puts a type in the list and in the Stock
form's Product type list without a reload; empty and repeated types (capitals, accents, spaces, another language's name) are
refused; a type is chosen for a product and kept; everything is still there after a reload; Remove asks first (and says how many
products use the type), Cancel changes nothing; a removed type leaves the list and the Add form but stays on the products that use
it, also when one is edited and saved; French and Arabic; no sideways scrolling on a narrow window; no console errors.
"""
import os, sys, tempfile, time
from pathlib import Path
from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
from e2e_common import open_product_form

URL = os.environ.get("INVOISY_URL") or (Path(__file__).resolve().parents[2] / "index.html").as_uri()
SHOTS = os.environ.get("INVOISY_SHOTS")
CHROME = os.environ.get("INVOISY_CHROME")
problems = []

BUILT_IN_EN = ["Dalle de sol", "Faience", "Porcelain", "Rock", "Évier", "Ciment-colle", "Pâte à joint", "Parquet"]


def check(cond, label):
    print(("PASS " if cond else "FAIL ") + label)
    if not cond:
        problems.append(label)


def go(page, view):
    page.click(f'.nav-btn[data-view="{view}"]')


def ready(page):
    page.wait_for_function("document.getElementById('dataState').textContent === 'Ready'", timeout=10000)


def shot(page, name):
    if SHOTS:
        Path(SHOTS).mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(Path(SHOTS) / f"{name}.png"), full_page=True)


def settings_types(page):
    """The Settings list: the words shown, in order."""
    return page.eval_on_selector_all("#productTypeList .type-name", "els => els.map(e => e.textContent)")


def stored_types(page):
    return page.eval_on_selector_all("#productTypeList .type-row", "els => els.map(e => e.dataset.type)")


def form_choices(page):
    """The Product type list of the Stock form: [value, shown text] without None."""
    return page.eval_on_selector_all("#pType option", "els => els.filter(e => e.value).map(e => [e.value, e.textContent])")


def form_values(page):
    return [v for v, _ in form_choices(page)]


def wait_types(page, count):
    page.wait_for_function("(n) => document.querySelectorAll('#productTypeList .type-row').length === n", arg=count, timeout=8000)


def add_type(page, text, press_enter=False):
    page.fill("#productTypeInput", text)
    if press_enter:
        page.press("#productTypeInput", "Enter")
    else:
        page.click("#addProductType")


def remove_type(page, value):
    page.locator(f'#productTypeList .type-row[data-type="{value}"] [data-action="remove-type"]').click()


def sideways(page):
    return page.evaluate("() => document.documentElement.scrollWidth - innerWidth")


def error_text(page):
    return page.inner_text("#productTypeError").strip()


with sync_playwright() as p:
    browser = p.chromium.launch(args=["--no-sandbox"], **({"executable_path": CHROME} if CHROME else {}))
    page = browser.new_context(viewport={"width": 1366, "height": 900}).new_page()
    errors = []
    dialogs = []
    answer = {"accept": True}
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append("PAGEERROR " + str(e)))

    def on_dialog(d):
        dialogs.append(d.message)
        d.accept() if answer["accept"] else d.dismiss()
    page.on("dialog", on_dialog)

    page.goto(URL)
    go(page, "settings")
    ready(page)

    # ---------- the starting point ----------
    check(page.is_visible("#productTypesPanel"), "the Settings page has a Product types section")
    check(settings_types(page) == BUILT_IN_EN, "it starts with the types the product form always had, nothing missing")
    check(page.locator("#view-settings .settings-panel").count() == 9, "the other eight panels are still all there")
    add_box = page.locator("#addProductType").bounding_box()
    check(add_box["height"] >= 41 and add_box["width"] >= 90, f"the Add button is large and clear ({add_box['width']:.0f} x {add_box['height']:.0f})")
    check("primary" in page.get_attribute("#addProductType", "class"), "and in the main button style")
    check(page.locator("#productTypeList [data-action='remove-type']").count() == 8, "every type has its own Remove button")
    shot(page, "1-settings-start")

    # ---------- adding ----------
    add_type(page, "Électricité")
    wait_types(page, 9)
    check(settings_types(page)[-1] == "Électricité", "Add (the button) puts the new type at the end of the list")
    check(page.input_value("#productTypeInput") == "" and error_text(page) == "", "the box is emptied and no message is shown")
    add_type(page, "  Gaz   naturel ", press_enter=True)
    wait_types(page, 10)
    check(settings_types(page)[-1] == "Gaz naturel", "pressing Enter in the box adds as well, and the spaces are tidied")

    # ---------- refused ----------
    before = settings_types(page)
    for text, why in [("", "empty"), ("    ", "only spaces"), ("électricité", "capitals and accent"), ("ELECTRICITE", "capitals"),
                      ("gaz  NATUREL", "inner spaces"), ("Faïence", "French name of a built-in type"), ("pierre", "French name of Rock"),
                      ("PORCELAINE", "French name of Porcelain")]:
        add_type(page, text)
        page.wait_for_function("document.getElementById('productTypeError').textContent.trim() !== ''", timeout=4000)
        check(settings_types(page) == before, f"refused with a message, list unchanged: {why}")
    add_type(page, "Électricité")
    page.wait_for_function("document.getElementById('productTypeError').textContent.includes('already')", timeout=4000)
    check("already in the list" in error_text(page), "the message for a repeat says so")
    page.fill("#productTypeInput", "x")
    check(error_text(page) == "", "the message goes away as soon as the box is edited")
    page.fill("#productTypeInput", "")
    shot(page, "2-settings-added")

    # ---------- the product form follows at once ----------
    go(page, "stock")
    open_product_form(page)
    choices = form_choices(page)
    check([v for v, _ in choices][-2:] == ["Électricité", "Gaz naturel"], "the Stock form offers the new types straight away, with no reload")
    check(dict(choices)["Électricité"] == "Électricité", "shown as they were typed")
    check(dict(choices)["Rock"] == "Rock", "built-in types are unchanged")

    # a product of the new type
    page.fill("#pName", "Prise double")
    page.fill("#pCoveragePerBox", "1.44")
    page.fill("#pStock", "20")
    page.locator("#priceRows input[data-field='price']").first.fill("1500")
    page.select_option("#pType", "Électricité")
    page.click("#productSubmit")
    page.wait_for_selector("#stockFormPanel", state="hidden")
    check(page.locator("#stockBody tr").count() == 1, "a product can be added with the new type")
    # a second product, of a built-in type
    open_product_form(page)
    page.fill("#pName", "ACRA Beige")
    page.fill("#pCoveragePerBox", "1.44")
    page.fill("#pStock", "5")
    page.locator("#priceRows input[data-field='price']").first.fill("900")
    page.select_option("#pType", "DalleDeSol")
    page.click("#productSubmit")
    page.wait_for_selector("#stockFormPanel", state="hidden")
    check(page.locator("#stockBody tr").count() == 2, "and one with a built-in type")

    # ---------- after a reload ----------
    page.reload()
    ready(page)
    go(page, "settings")
    check(settings_types(page) == BUILT_IN_EN + ["Électricité", "Gaz naturel"], "after a reload the Settings list is the same")
    go(page, "stock")
    open_product_form(page)
    check(form_values(page)[-2:] == ["Électricité", "Gaz naturel"], "and so is the product form's list")
    page.click("#stockAddToggle")   # close it again
    page.locator("#stockBody tr", has_text="Prise double").locator('[data-action="edit"]').click()
    page.wait_for_selector("#stockFormPanel", state="visible")
    check(page.input_value("#pType") == "Électricité", "the product kept its type: the edit form shows it selected")
    page.click("#stockAddToggle")
    page.wait_for_selector("#stockFormPanel", state="hidden")

    # ---------- removing ----------
    go(page, "settings")
    answer["accept"] = False
    dialogs.clear()
    remove_type(page, "Rock")
    page.wait_for_function("(n) => n > 0", arg=len(dialogs), timeout=100) if False else time.sleep(0.4)
    check(len(dialogs) == 1 and "Remove “Rock” from the list?" in dialogs[0], "Remove asks first")
    check("No product is changed" in dialogs[0], "and says that no product is changed")
    check("Rock" in settings_types(page), "Cancel leaves the type where it was")

    answer["accept"] = True
    dialogs.clear()
    remove_type(page, "Rock")
    wait_types(page, 9)
    check("Rock" not in settings_types(page), "after OK the type is gone from the list")
    check(len(dialogs) == 1, "it asked exactly once")

    dialogs.clear()
    remove_type(page, "Électricité")
    wait_types(page, 8)
    check(len(dialogs) == 1 and "used by 1 product" in dialogs[0] and "keeps its type" in dialogs[0],
          "a type that a product uses says how many products use it, and that they keep it")
    check("Électricité" not in settings_types(page), "and it is removed from the list")
    shot(page, "3-settings-removed")

    go(page, "stock")
    open_product_form(page)
    values = form_values(page)
    check("Électricité" not in values and "Rock" not in values, "removed types are no longer offered for a new product, with no reload")
    check("Gaz naturel" in values and "Faience" in values, "the other types still are")
    page.click("#stockAddToggle")
    page.wait_for_selector("#stockFormPanel", state="hidden")

    # the product that has the removed type keeps it
    row = page.locator("#stockBody tr", has_text="Prise double")
    check(row.count() == 1, "the product that used the removed type is still there")
    row.locator('[data-action="edit"]').click()
    page.wait_for_selector("#stockFormPanel", state="visible")
    check(page.input_value("#pType") == "Électricité", "editing it still shows its own type selected")
    own_text = page.eval_on_selector("#pType", "el => el.options[el.selectedIndex].textContent")
    check("no longer in the list" in own_text, "marked as no longer in the list, so it is clear why it is there")
    check(form_values(page).count("Électricité") == 1, "offered once")
    shot(page, "4-edit-removed-type")
    page.fill("#pStock", "18")   # an ordinary edit
    page.click("#productSubmit")
    page.wait_for_selector("#stockFormPanel", state="hidden")
    row = page.locator("#stockBody tr", has_text="Prise double")
    row.locator('[data-action="edit"]').click()
    page.wait_for_selector("#stockFormPanel", state="visible")
    check(page.input_value("#pType") == "Électricité" and page.input_value("#pStock") == "18",
          "saving an edit keeps the removed type, and the edit itself is saved")
    page.click("#stockAddToggle")
    page.wait_for_selector("#stockFormPanel", state="hidden")
    open_product_form(page)
    check("Électricité" not in form_values(page), "closing the edit takes it off the list again: the next new product is not offered it")
    page.click("#stockAddToggle")

    # ---------- after a reload ----------
    page.reload()
    ready(page)
    go(page, "settings")
    after = settings_types(page)
    check("Rock" not in after and "Électricité" not in after and "Gaz naturel" in after and len(after) == 8, "after a reload the removed types are still removed")
    go(page, "stock")
    page.locator("#stockBody tr", has_text="Prise double").locator('[data-action="edit"]').click()
    page.wait_for_selector("#stockFormPanel", state="visible")
    check(page.input_value("#pType") == "Électricité", "and the product still has its type")
    page.click("#stockAddToggle")
    page.wait_for_selector("#stockFormPanel", state="hidden")

    # a removed built-in type can be added back under any of its names
    go(page, "settings")
    add_type(page, "Pierre")
    wait_types(page, 9)
    check(stored_types(page)[-1] == "Rock" and settings_types(page)[-1] == "Rock", "typing Pierre brings the built-in Rock type back (not a second spelling)")

    # ---------- French and Arabic ----------
    page.select_option("#sLanguage", "fr")
    page.wait_for_function("document.documentElement.lang === 'fr'", timeout=8000)
    fr = settings_types(page)
    check(fr[:2] == ["Dalle de sol", "Faïence"] and "Pierre" in fr, f"in French the built-in types are in French ({fr[:4]})")
    check("Gaz naturel" in fr, "and a type that was added stays as typed")
    check(page.inner_text("#addProductType").strip() == "Ajouter le type", "the button is in French")
    go(page, "stock")
    open_product_form(page)
    fr_form = dict(form_choices(page))
    check(fr_form["Faience"] == "Faïence" and fr_form["Gaz naturel"] == "Gaz naturel", "so is the product form")
    page.click("#stockAddToggle")
    go(page, "settings")
    page.select_option("#sLanguage", "ar")
    page.wait_for_function("document.documentElement.dir === 'rtl'", timeout=8000)
    check(page.locator("#productTypeList .type-row").count() == 9, "in Arabic the list is there")
    check(sideways(page) <= 1, f"no sideways scrolling in Arabic ({sideways(page)}px)")
    shot(page, "5-settings-arabic")
    page.select_option("#sLanguage", "en")
    page.wait_for_function("document.documentElement.lang === 'en'", timeout=8000)

    # ---------- narrow windows ----------
    for width in (900, 390):
        page.set_viewport_size({"width": width, "height": 900})
        check(sideways(page) <= 1, f"no sideways scrolling at {width}px ({sideways(page)}px)")
        inside = page.evaluate("""() => [...document.querySelectorAll('#productTypesPanel input, #productTypesPanel .btn')]
            .filter((e) => e.offsetParent).every((e) => e.getBoundingClientRect().right <= innerWidth + 1)""")
        check(inside, f"every control of the section fits the window at {width}px")
    shot(page, "6-settings-narrow")

    check(not errors, "no console errors" + ("" if not errors else ": " + "; ".join(errors[:3])))
    browser.close()

print()
print("ALL CHECKS PASSED" if not problems else f"{len(problems)} CHECK(S) FAILED")
sys.exit(1 if problems else 0)

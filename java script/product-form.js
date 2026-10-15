"use strict";

/* ==========================================================================
   ProductForm - the product form. ONE form, used in two places:
     - the Stock page (Add product / Edit product), and
     - the "+ New product" box of a purchase line (a product made while recording a purchase).

   Both get the same fields (product name, Manufacturer, tile size, SKU, category, description, selling prices, stock
   quantity and unit, coverage per box, purchase price), the same selling price rows, and the same rules, because the
   rules are not in this file: read() hands what was typed to Validation.readProductInput (validation.js).

   Plain script, loaded after validation.js and before purchases-ui.js and script.js. It draws markup and reads it back;
   saving is left to the page (Stock saves the product; a purchase saves it when the purchase is confirmed).

   Every form is an instance made by create() with its own id prefix, so two forms on one page never share ids.
   The Stock form uses prefix "p" and keeps the ids it has always had (pName, pStock, priceRows ...).
   The selling price rows live in the instance (holder.priceRows), as typed: { rowId, unit, price }.
   ========================================================================== */

(function () {
  const t = (key, params) => I18n.t(key, params);
  const $ = (id) => document.getElementById(id);

  function esc(value) {
    const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => map[c]);
  }

  const PRICE_UNIT_ORDER = ["m2", "piece", "box", "kg", "m"];
  const STOCK_UNITS = ["piece", "box", "m2", "kg", "m"];
  // The id of each plain field is the prefix plus this ("p" + "Name" = pName).
  const FIELD_SUFFIX = {
    name: "Name", productType: "Type", manufacturer: "Manufacturer", tileSize: "TileSize", sku: "Sku", category: "Category", description: "Desc",
    stock: "Stock", stockUnit: "StockUnit", coveragePerBox: "CoveragePerBox", purchasePrice: "Cost",
  };

  let rowSerial = 0;                 // price row ids are unique across every form on the page
  const instances = new Map();       // prefix -> the form currently on the page

  function idsFor(prefix) {
    const ids = {};
    for (const [key, suffix] of Object.entries(FIELD_SUFFIX)) ids[key] = prefix + suffix;
    const stock = prefix === "p";    // the Stock form keeps the ids it always had
    ids.priceRows = stock ? "priceRows" : prefix + "PriceRows";
    ids.addPrice = stock ? "addPriceRow" : prefix + "AddPrice";
    ids.coverageReq = stock ? "coverageReq" : prefix + "CoverageReq";
    return ids;
  }

  // What the form shows for a product: the typed shape (text for every box) of a saved product, of a typed form
  // (read back with readRaw) or of nothing (a new, blank product: a price per m², stock counted in boxes).
  function toRaw(source) {
    const text = (v) => (v == null ? "" : String(v));
    if (source == null) {
      return {
        name: "", productType: "", manufacturer: "", tileSize: "", sku: "", category: "", description: "", stock: "0", stockUnit: "box",
        coveragePerBox: "", purchasePrice: "", prices: [{ unit: "m2", price: "" }],
      };
    }
    let prices;
    if (Array.isArray(source.prices)) prices = source.prices;
    else {
      // Each saved price is its own row. A product saved before price units existed has a price but no unit:
      // its row shows the price with the unit left to choose (never guessed).
      const saved = Calc.getSellingPrices(source);
      prices = saved.length ? saved : [{ unit: "", price: source.sellingPrice }];
    }
    return {
      name: text(source.name), productType: Validation.normalizeProductType(text(source.productType)),   // an old spelling (Daldosol, Daltosol) shows as the current type
      manufacturer: text(source.manufacturer), tileSize: text(source.tileSize), sku: text(source.sku),
      category: text(source.category), description: text(source.description), stock: text(source.stock),
      stockUnit: text(source.stockUnit), coveragePerBox: text(source.coveragePerBox), purchasePrice: text(source.purchasePrice),
      prices: prices.map((p) => ({ unit: text(p && p.unit), price: text(p && p.price) })),
    };
  }

  // options: { prefix, holder, products(), editing(), stockFromPurchase, onError(message) }
  //   holder: where the price rows are kept (the Stock page keeps them in its state)
  //   products(): the catalogue the form is checked against; editing(): the product being edited, if any
  //   stockFromPurchase: a product made by a purchase starts at 0, the goods received add to it (so it is not typed)
  //   onError(message): where a message about the form goes ("" clears it)
  function create(options) {
    const prefix = options.prefix;
    const holder = options.holder || {};
    if (!Array.isArray(holder.priceRows)) holder.priceRows = [];
    const ids = idsFor(prefix);
    const el = (key) => $(ids[key]);
    const fromPurchase = Boolean(options.stockFromPurchase);
    const say = (message) => { if (options.onError) options.onError(message || ""); };

    /* ---------- Selling price rows ---------- */

    const rows = () => holder.priceRows;
    const newRow = (unit, price) => ({ rowId: ++rowSerial, unit: unit || "", price: price === undefined || price === null ? "" : String(price) });
    const findRow = (rowId) => rows().find((r) => String(r.rowId) === String(rowId));
    const takenByOthers = (rowId) => rows().filter((r) => r.rowId !== rowId).map((r) => r.unit).filter(Boolean);

    // The kind of unit the prices are in (set by the first row): piece / box / m² together, kg or m alone.
    const family = () => (rows()[0] && rows()[0].unit ? Calc.unitFamily(rows()[0].unit) : null);

    // The unit a new row starts on: the first unit of the same kind that has no price yet (null = none left).
    function nextUnit() {
      const taken = takenByOthers(null);
      const kind = family();
      return PRICE_UNIT_ORDER.find((u) => !taken.includes(u) && (!kind || Calc.unitFamily(u) === kind)) || null;
    }

    function rowsHtml() {
      const kind = family();
      const only = rows().length < 2;
      return rows().map((row, index) => {
        const per = row.unit ? t("price." + row.unit) : "";
        const taken = takenByOthers(row.rowId);
        const unitOptions = (row.unit ? "" : `<option value="" selected>${esc(t("stock.per"))}</option>`) + PRICE_UNIT_ORDER.map((u) => {
          const blocked = u !== row.unit && (taken.includes(u) || (index > 0 && kind && Calc.unitFamily(u) !== kind));
          return `<option value="${u}"${u === row.unit ? " selected" : ""}${blocked ? " disabled" : ""}>${esc(t("price." + u))}</option>`;
        }).join("");
        return `<div class="price-entry" data-row="${row.rowId}">` +
          `<label for="priceValue-${row.rowId}">${esc(row.unit ? t("stock.priceFor", { per }) : t("stock.sellingPrice"))}${index === 0 ? ' <span class="req" aria-hidden="true">*</span>' : ""}</label>` +
          `<div class="price-entry-line">` +
          `<input type="number" id="priceValue-${row.rowId}" data-field="price" min="0" step="any" value="${esc(row.price)}"${index === 0 ? ' aria-required="true"' : ""}>` +
          `<select id="priceUnit-${row.rowId}" data-field="unit" aria-label="${esc(t("stock.sellingUnit"))}">${unitOptions}</select>` +
          `<button type="button" class="btn small" data-action="remove-price" aria-label="${esc(per ? t("stock.removePriceAria", { per }) : t("stock.removePrice"))}"${only ? " disabled" : ""}>${esc(t("stock.removePrice"))}</button>` +
          `</div></div>`;
      }).join("");
    }

    // Coverage per box is mandatory only while one of the prices is per m² (see Validation.readProductInput), so its * follows that.
    const needsCoverage = () => rows().some((r) => r.unit === "m2");

    function syncCoverageMark() {
      el("coverageReq").hidden = !needsCoverage();
      el("coveragePerBox").setAttribute("aria-required", needsCoverage() ? "true" : "false");
    }

    function renderRows() {
      el("priceRows").innerHTML = rowsHtml();
      el("addPrice").disabled = nextUnit() === null;
    }

    function setRows(entries) {
      holder.priceRows = (entries && entries.length ? entries : [{ unit: "m2", price: "" }]).map((e) => newRow(e.unit, e.price));
      renderRows();
      syncCoverageMark();
    }

    function addRow() {
      const unit = nextUnit();
      if (!unit) return null;
      const row = newRow(unit, "");
      rows().push(row);
      renderRows();
      syncCoverageMark();
      const input = $("priceValue-" + row.rowId);
      if (input) input.focus();
      return row;
    }

    // At least one price always stays.
    function removeRow(rowId) {
      if (rows().length < 2) return false;
      holder.priceRows = rows().filter((r) => String(r.rowId) !== String(rowId));
      renderRows();
      syncCoverageMark();
      return true;
    }

    function setRowUnit(rowId, unit) {
      const row = findRow(rowId);
      if (!row) return;
      if (unit && takenByOthers(row.rowId).includes(unit)) {
        say(t("product.priceRowUnitUsed"));
        renderRows();
        return;
      }
      row.unit = unit;
      // The first price decides what a new product is counted in (m² -> boxes), until a stock unit is chosen by hand.
      if (row === rows()[0] && !el("stockUnit").dataset.touched) el("stockUnit").value = Calc.defaultStockUnit(unit) || "";
      renderRows();
      syncCoverageMark();
      const select = $("priceUnit-" + row.rowId);
      if (select) select.focus();
    }

    /* ---------- Markup ---------- */

    // The form's fields, filled with `values` (a saved product, or what readRaw() gave; blank when omitted).
    // The selling price rows are set from them too, so this is the only call needed to start a form.
    function html(values) {
      const given = values !== undefined && values !== null;
      const raw = toRaw(given ? values : null);
      holder.priceRows = raw.prices.map((p) => newRow(p.unit, p.price));
      const attr = (key) => (raw[key] === "" ? "" : ` value="${esc(raw[key])}"`);
      const stockUnits = STOCK_UNITS.map((u) => `<option value="${u}"${raw.stockUnit === u ? " selected" : ""}>${esc(t("stockunit." + u))}</option>`).join("");
      const typeOptions = `<option value=""${raw.productType ? "" : " selected"} data-i18n="stock.productTypeNone">${esc(t("stock.productTypeNone"))}</option>` +
        Validation.PRODUCT_TYPES.map((type) => `<option value="${esc(type)}"${raw.productType === type ? " selected" : ""} data-i18n="productType.${esc(type)}">${esc(t("productType." + type))}</option>`).join("");
      const touched = given && raw.stockUnit ? ' data-touched="1"' : "";   // an edit never changes the unit on its own
      const cover = needsCoverage();
      return `<div class="product-fields" data-product-form="${esc(prefix)}">
            <fieldset class="form-section">
              <legend data-i18n="stock.sectionProduct">${esc(t("stock.sectionProduct"))}</legend>
              <div class="field">
                <label for="${ids.name}"><span data-i18n="stock.productName">${esc(t("stock.productName"))}</span> <span class="req" aria-hidden="true">*</span></label>
                <input type="text" id="${ids.name}" autocomplete="off" aria-required="true"${attr("name")}>
              </div>
              <div class="field">
                <label for="${ids.productType}" data-i18n="stock.productType">${esc(t("stock.productType"))}</label>
                <select id="${ids.productType}">${typeOptions}</select>
              </div>
              <div class="grid-2">
                <div class="field">
                  <label for="${ids.manufacturer}" data-i18n="stock.manufacturer">${esc(t("stock.manufacturer"))}</label>
                  <input type="text" id="${ids.manufacturer}" autocomplete="off"${attr("manufacturer")}>
                </div>
                <div class="field">
                  <label for="${ids.tileSize}" data-i18n="stock.tileSize">${esc(t("stock.tileSize"))}</label>
                  <input type="text" id="${ids.tileSize}" autocomplete="off"${attr("tileSize")}>
                </div>
              </div>
              <div class="grid-2">
                <div class="field">
                  <label for="${ids.sku}" data-i18n="stock.sku">${esc(t("stock.sku"))}</label>
                  <input type="text" id="${ids.sku}" autocomplete="off"${attr("sku")}>
                </div>
                <div class="field">
                  <label for="${ids.category}" data-i18n="stock.category">${esc(t("stock.category"))}</label>
                  <input type="text" id="${ids.category}" list="categoryList" autocomplete="off"${attr("category")}>
                </div>
              </div>
              <div class="field">
                <label for="${ids.description}" data-i18n="stock.description">${esc(t("stock.description"))}</label>
                <input type="text" id="${ids.description}" autocomplete="off"${attr("description")}>
              </div>
            </fieldset>

            <fieldset class="form-section">
              <legend><span data-i18n="stock.sectionPrices">${esc(t("stock.sectionPrices"))}</span> <span class="req" aria-hidden="true">*</span></legend>
              <p class="muted small price-hint" data-i18n="stock.pricesHint">${esc(t("stock.pricesHint"))}</p>
              <div id="${ids.priceRows}">${rowsHtml()}</div>
              <div class="field">
                <button type="button" class="btn small" id="${ids.addPrice}" data-action="add-price" data-i18n="stock.addPrice"${nextUnit() === null ? " disabled" : ""}>${esc(t("stock.addPrice"))}</button>
              </div>
            </fieldset>

            <fieldset class="form-section">
              <legend data-i18n="stock.sectionStock">${esc(t("stock.sectionStock"))}</legend>
              <div class="grid-2 price-row">
                <div class="field">
                  <div class="price-with-unit">
                    <div class="sub-field">
                      <label for="${ids.stock}" data-i18n="stock.stockQty">${esc(t("stock.stockQty"))}</label>
                      <input type="number" id="${ids.stock}" min="0" step="any" value="${esc(fromPurchase ? "0" : raw.stock)}"${fromPurchase ? " disabled" : ""}>
                    </div>
                    <div class="sub-field sub-unit">
                      <label for="${ids.stockUnit}"><span data-i18n="stock.stockUnit">${esc(t("stock.stockUnit"))}</span> <span class="req" aria-hidden="true">*</span></label>
                      <select id="${ids.stockUnit}" aria-required="true"${touched}>
                      <option value=""${raw.stockUnit ? "" : " selected"} data-i18n="stock.countedIn">${esc(t("stock.countedIn"))}</option>
                      ${stockUnits}
                      </select>
                    </div>
                  </div>
                </div>
                <div class="field">
                  <label for="${ids.coveragePerBox}"><span data-i18n="stock.coverage">${esc(t("stock.coverage"))}</span> <span class="req" id="${ids.coverageReq}" aria-hidden="true"${cover ? "" : " hidden"}>*</span></label>
                  <input type="number" id="${ids.coveragePerBox}" min="0" step="any" placeholder="${esc(t("stock.coveragePlaceholder"))}" data-i18n-placeholder="stock.coveragePlaceholder" aria-required="${cover ? "true" : "false"}"${attr("coveragePerBox")}>
                </div>
              </div>
              ${fromPurchase ? `<p class="muted small" data-i18n="pur.newProductStockNote">${esc(t("pur.newProductStockNote"))}</p>` : ""}
              <div class="field">
                <label for="${ids.purchasePrice}" data-i18n="stock.purchasePrice">${esc(t("stock.purchasePrice"))}</label>
                <input type="number" id="${ids.purchasePrice}" min="0" step="any"${attr("purchasePrice")}>
              </div>
            </fieldset>
          </div>`;
    }

    /* ---------- Reading and filling ---------- */

    // What is typed right now, as text (the prices come from the rows, so what is saved never depends on what the page holds).
    function readRaw() {
      const raw = {};
      for (const key of Object.keys(FIELD_SUFFIX)) raw[key] = el(key).value;
      raw.prices = rows().map((r) => ({ unit: r.unit, price: r.price }));
      return raw;
    }

    // Puts a product (or nothing, for a blank form) into the boxes already on the page.
    function fill(values) {
      const given = values !== undefined && values !== null;
      const raw = toRaw(given ? values : null);
      for (const key of Object.keys(FIELD_SUFFIX)) el(key).value = raw[key];
      if (fromPurchase) el("stock").value = "0";
      if (given && raw.stockUnit) el("stockUnit").dataset.touched = "1";   // an edit never changes the unit on its own
      else delete el("stockUnit").dataset.touched;
      setRows(raw.prices);
    }

    function blank() { fill(null); }

    // The id of the box a problem found by Validation.readProductInput belongs to.
    function boxOf(problem) {
      const row = rows()[problem.index];
      if (problem.field === "priceUnit") return row ? "priceUnit-" + row.rowId : ids.addPrice;
      if (problem.field === "priceValue") return row ? "priceValue-" + row.rowId : ids.addPrice;
      if (problem.field === "prices") return ids.addPrice;
      if (problem.field === "duplicate") return ids.name;
      return ids[problem.field] || ids.name;
    }

    // Checks what is typed with the one set of product rules. { values } to save, or { field: id of the box, error }.
    function read() {
      const checked = Validation.readProductInput(readRaw(), {
        products: options.products ? options.products() : [],
        editing: options.editing ? options.editing() : null,
        stockFromPurchase: fromPurchase,
      });
      if (!checked.error) return { values: checked.values };
      return { field: boxOf(checked), error: checked.error };
    }

    // Marks the box a problem belongs to (for a problem found later, such as when a purchase is confirmed).
    function mark(field, index) {
      const box = $(boxOf({ field, index: index === undefined ? -1 : index }));
      if (box && box.setAttribute) box.setAttribute("aria-invalid", "true");
    }

    function clearInvalid(root) {
      const host = root || el("name");
      const scope = host && host.closest ? host.closest("[data-product-form]") : null;
      if (scope) scope.querySelectorAll("[aria-invalid]").forEach((box) => box.removeAttribute("aria-invalid"));
    }

    /* ---------- Events (the page forwards input, change and click events that happened inside the form) ---------- */

    const rowIdOf = (node) => { const row = node.closest("[data-row]"); return row ? row.dataset.row : null; };

    // Returns true when the event was one of the form's own (a price row was typed in, added, changed or removed).
    function handle(e) {
      const target = e && e.target;
      if (!target || !target.closest) return false;
      if (e.type === "input") {
        const input = target.closest("input[data-field='price']");
        const row = input && findRow(rowIdOf(input));
        if (row) row.price = input.value;
        target.removeAttribute("aria-invalid");
        say("");
        return true;
      }
      if (e.type === "change") {
        const select = target.closest("select[data-field='unit']");
        if (select) { setRowUnit(rowIdOf(select), select.value); return true; }
        if (target.id === ids.stockUnit) { target.dataset.touched = "1"; return true; }
        return false;
      }
      if (e.type === "click") {
        const remove = target.closest("[data-action='remove-price']");
        if (remove) { clearInvalid(remove); say(""); removeRow(rowIdOf(remove)); return true; }
        if (target.closest("[data-action='add-price']")) { clearInvalid(target); say(""); addRow(); return true; }
      }
      return false;
    }

    const instance = {
      prefix, ids, html, read, readRaw, fill, blank, mark, clearInvalid, handle,
      get rows() { return rows(); },
      setRows, addRow, removeRow, setRowUnit, renderRows, nextUnit, syncCoverageMark,
    };
    instances.set(prefix, instance);
    return instance;
  }

  const get = (prefix) => instances.get(prefix) || null;
  const drop = (prefix) => { instances.delete(prefix); };

  // For a page that listens once on a big container (the Purchases page): finds the form the event happened in and
  // gives it the event. Returns true when a product form took it.
  function route(e) {
    const target = e && e.target;
    const host = target && target.closest ? target.closest("[data-product-form]") : null;
    const form = host ? get(host.dataset.productForm) : null;
    return form ? form.handle(e) : false;
  }

  globalThis.ProductForm = { create, get, drop, route, toRaw };
})();

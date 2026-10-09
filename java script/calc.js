"use strict";



(function () {
  const UNITS = ["piece", "box", "m2", "kg", "m"];
  const PLURAL_UNITS = ["piece", "box"];         // the only unit names that change with the quantity
  const WHOLE_UNITS = ["piece", "box"];          // can't be sold or counted in fractions
  const AREA_UNITS = ["piece", "box", "m2"];     // convertible with each other

  const PIECES_TOLERANCE = 1e-6;   // how close coverage / piece area must be to a whole number
  const STOCK_EPSILON = 1e-9;      // floating-point slack when comparing stock quantities

  const UNIT_ALIASES = {
    piece: "piece", pieces: "piece", pc: "piece", pcs: "piece",
    box: "box", boxes: "box",
    m2: "m2", "m²": "m2", sqm: "m2", "square meter": "m2", "square meters": "m2", "square metre": "m2", "square metres": "m2",
    kg: "kg", kgs: "kg", kilogram: "kg", kilograms: "kg", kilo: "kg",
    m: "m", meter: "m", meters: "m", metre: "m", metres: "m",
  };

  /* ---------- Numbers ---------- */

  // A money amount to 2 decimals. Used for prices and totals only, never for areas or ratios.
  const roundMoney = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

  // Removes floating-point noise (0.30000000000000004 -> 0.3) without rounding real values.
  const cleanNumber = (n) => Number(Number(n).toPrecision(12));

  const toNumber = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  };

  const isBlank = (v) => v === null || v === undefined || String(v).trim() === "";

  // Text in the current language. I18n is looked up when a message is made, not when this file loads.
  const say = (key, params) => globalThis.I18n.t(key, params);
  const nameOf = (product) => (product && product.name) || say("calc.thisProduct");

  /* ---------- Units ---------- */

  const isUnit = (unit) => UNITS.includes(unit);

  // "Box" / "Boxes" (the plural form follows the language's rule when a quantity is given). "" for an unknown unit.
  function unitLabel(unit, qty) {
    if (!isUnit(unit)) return "";
    if (qty !== undefined && PLURAL_UNITS.includes(unit)) return globalThis.I18n.tn("unit." + unit, Number(qty));
    return say("unit." + unit);
  }

  // The unit name in lower case, for use inside a sentence ("piece", "box", "m²").
  const unitWord = (unit) => unitLabel(unit).toLowerCase();

  // "pieces", "m²", "Square Meter" -> canonical unit, or null when it isn't a supported unit.
  function normalizeUnit(value) {
    if (typeof value !== "string") return null;
    return UNIT_ALIASES[value.trim().toLowerCase()] || null;
  }

  // piece, box and m2 share one family; kg and m are each their own.
  const unitFamily = (unit) => (AREA_UNITS.includes(unit) ? "area" : unit);

  // Whole units (piece, box) can't be fractions. An unknown unit (old products) is treated as whole.
  const isWholeUnit = (unit) => !isUnit(unit) || WHOLE_UNITS.includes(unit);

  // Checks a quantity typed for a unit. { value } or { error }.
  function validateQuantity(rawQty, unit) {
    const qty = Number(rawQty);
    if (isBlank(rawQty) || !Number.isFinite(qty) || qty <= 0) {
      return { error: say(isWholeUnit(unit) ? "calc.qtyWhole" : "calc.qtyPositive") };
    }
    if (isWholeUnit(unit) && !Number.isInteger(qty)) return { error: say("calc.qtyWhole") };
    return { value: qty };
  }

  /* ---------- Tile size ---------- */

  // "60*120", "60 x 60", "60 × 120 cm", "600*1200 mm" -> { width, height } in cm, or null.
  function parseTileSize(text) {
    const m = String(text == null ? "" : text).trim().match(/^(\d+(?:[.,]\d+)?)\s*[*×x]\s*(\d+(?:[.,]\d+)?)\s*(mm|cm|m)?$/i);
    if (!m) return null;
    const scale = { mm: 0.1, cm: 1, m: 100 }[(m[3] || "cm").toLowerCase()];
    const width = Number(m[1].replace(",", ".")) * scale;
    const height = Number(m[2].replace(",", ".")) * scale;
    return width > 0 && height > 0 ? { width, height } : null;
  }

  const isTileSize = (value) => parseTileSize(value) !== null;

  // Stores whatever was typed in one format, in cm: "60*120". Unreadable text is returned trimmed.
  function normalizeTileSize(value) {
    const size = parseTileSize(value);
    if (!size) return String(value == null ? "" : value).trim();
    const fmt = (n) => String(cleanNumber(n));
    return `${fmt(size.width)}*${fmt(size.height)}`;
  }

  /* ---------- Piece, box and area facts of a product ---------- */

  // Area of ONE piece in m². Centimeters are turned into meters first.
  function getPieceArea(product) {
    const raw = product && product.tileSize;
    if (isBlank(raw)) {
      return { error: say("calc.noTileSize", { name: nameOf(product) }) };
    }
    const size = parseTileSize(raw);
    if (!size) return { error: say("calc.badTileSize", { name: nameOf(product), size: raw }) };
    return { value: (size.width / 100) * (size.height / 100) };
  }

  // m² covered by ONE box.
  function getBoxCoverage(product) {
    const raw = product && product.coveragePerBox;
    if (isBlank(raw)) return { error: say("calc.noCoverage", { name: nameOf(product) }) };
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return { error: say("calc.badCoverage", { name: nameOf(product) }) };
    return { value: n };
  }

  // Pieces in ONE box = coverage per box / piece area. It must come out as a whole number:
  // an inconsistent tile size and coverage is reported, never rounded into a guess.
  function getPiecesPerBox(product) {
    const coverage = getBoxCoverage(product);
    if (coverage.error) return coverage;
    const area = getPieceArea(product);
    if (area.error) return area;
    const ratio = coverage.value / area.value;
    const whole = Math.round(ratio);
    const facts = { name: nameOf(product), coverage: cleanNumber(coverage.value), area: cleanNumber(area.value) };
    if (ratio < 1 - PIECES_TOLERANCE) return { error: say("calc.coverageTooSmall", facts) };
    if (Math.abs(ratio - whole) > PIECES_TOLERANCE * whole) return { error: say("calc.coverageNotWhole", facts) };
    return { value: whole };
  }

  // m² covered by ONE of the unit (piece, box or m2).
  function getAreaOf(product, unit) {
    if (unit === "m2") return { value: 1 };
    if (unit === "box") return getBoxCoverage(product);
    if (unit === "piece") return getPieceArea(product);
    return { error: say("calc.notAreaUnit", { name: nameOf(product), unit: isUnit(unit) ? unitWord(unit) : say("calc.thisUnit") }) };
  }

  /* ---------- Converting quantities ---------- */

  // How many `toUnit` are in ONE `fromUnit` for this product: { value } or { error }.
  function getUnitFactor(product, fromUnit, toUnit) {
    if (!isUnit(fromUnit) || !isUnit(toUnit)) return { error: say("calc.unsupportedUnit", { name: nameOf(product) }) };
    if (fromUnit === toUnit) return { value: 1 };
    if (unitFamily(fromUnit) !== unitFamily(toUnit)) {
      return { error: say("calc.differentKinds", { name: nameOf(product), from: unitWord(fromUnit), to: unitWord(toUnit) }) };
    }
    if (fromUnit === "piece" && toUnit === "box") {
      const perBox = getPiecesPerBox(product);
      return perBox.error ? perBox : { value: 1 / perBox.value };
    }
    if (fromUnit === "box" && toUnit === "piece") return getPiecesPerBox(product);
    const from = getAreaOf(product, fromUnit);
    if (from.error) return from;
    const to = getAreaOf(product, toUnit);
    if (to.error) return to;
    return { value: from.value / to.value };
  }

  // 2 boxes -> 8 pieces: { value } or { error }. The result is not rounded (only floating-point noise is removed).
  function convertQuantity(quantity, fromUnit, toUnit, product) {
    const qty = Number(quantity);
    if (isBlank(quantity) || !Number.isFinite(qty)) return { error: say("calc.badQuantity") };
    const factor = getUnitFactor(product, fromUnit, toUnit);
    return factor.error ? factor : { value: cleanNumber(qty * factor.value) };
  }

  // Typed in m²: how many whole boxes cover it (rounded up). { boxes, area, coverage } or { error }.
  function boxesForArea(product, area) {
    const coverage = getBoxCoverage(product);
    if (coverage.error) return coverage;
    const m2 = Number(area);
    if (isBlank(area) || !Number.isFinite(m2) || m2 <= 0) return { error: say("calc.enterArea") };
    const boxes = Math.max(1, Math.ceil(cleanNumber(m2 / coverage.value)));
    return { boxes, area: m2, coverage: coverage.value };
  }

  /* ---------- Prices ---------- */

  // Price of ONE `targetUnit` of the product, from the reference price and its price unit.
  //   { value, basePrice, priceUnit, factor }   factor = how many price-units are in one target unit
  // A product without a price unit (saved before the field existed) keeps its old behavior:
  // the price applies as typed to whatever unit is sold ({ legacy: true }).
  function getUnitPrice(product, targetUnit) {
    if (!isUnit(targetUnit)) return { error: say("calc.unsupportedSellUnit", { name: nameOf(product) }) };
    const base = Number(product && product.sellingPrice);
    if (isBlank(product && product.sellingPrice) || !Number.isFinite(base) || base < 0) {
      return { error: say("calc.noPrice", { name: nameOf(product) }) };
    }
    const priceUnit = product.priceUnit;
    if (!isUnit(priceUnit)) return { value: base, basePrice: base, priceUnit: null, factor: 1, legacy: true };
    if (priceUnit === targetUnit) return { value: base, basePrice: base, priceUnit, factor: 1 };
    if (unitFamily(priceUnit) !== unitFamily(targetUnit)) {
      return { error: say("calc.cannotSell", { name: nameOf(product), from: unitWord(priceUnit), to: unitWord(targetUnit) }) };
    }
    const factor = getUnitFactor(product, targetUnit, priceUnit);
    if (factor.error) return factor;
    return { value: roundMoney(base * factor.value), basePrice: base, priceUnit, factor: factor.value };
  }

  // Quantity x price of one unit, rounded to 2 decimals. Invalid numbers count as 0
  // (the sale is validated separately, so this never hides a bad value from checkout).
  const calculateLineTotal = (quantity, unitPrice) => roundMoney(toNumber(quantity) * toNumber(unitPrice));

  // Sum of the (rounded) line totals, so the subtotal always equals the lines shown.
  const calculateSubtotal = (lines) => roundMoney(lines.reduce((sum, l) => sum + calculateLineTotal(l.qty, l.unitPrice), 0));

  /* ---------- Stock ---------- */

  // The stock unit a new product starts with: the unit its price is per (boxes for a per-m² price).
  function defaultStockUnit(priceUnit) {
    if (priceUnit === "m2") return "box";
    return isUnit(priceUnit) ? priceUnit : null;
  }

  // The unit the stock quantity is counted in, or null when it isn't known (old products
  // saved before price units: their stock is then reduced one-for-one as it always was).
  function inferStockUnit(product) {
    const explicit = normalizeUnit(product && product.stockUnit);
    return explicit || defaultStockUnit(normalizeUnit(product && product.priceUnit));
  }

  // The unit a product is most likely sold in, to preselect on the Sell page.
  function defaultSellingUnit(product) {
    return defaultStockUnit(product && product.priceUnit) || (isUnit(product && product.stockUnit) ? product.stockUnit : "piece");
  }

  // Stock used up by selling `qty` of `sellUnit`, in the product's stock unit.
  function stockDeduction(product, qty, sellUnit) {
    if (!isUnit(product && product.stockUnit)) return { value: Number(qty), legacy: true };
    return convertQuantity(qty, sellUnit, product.stockUnit, product);
  }

  // The product's stock expressed in another unit (for example 20 boxes -> 80 pieces).
  function stockIn(product, unit) {
    if (!isUnit(product && product.stockUnit)) return { value: Number(product.stock), legacy: true };
    return convertQuantity(product.stock, product.stockUnit, unit, product);
  }

  const hasEnoughStock = (available, needed) => needed <= available + STOCK_EPSILON;

  // Can this product be sold in this unit at all? ({} when yes, { error } when the product
  // lacks the data to price it or to take it out of stock in that unit.)
  function checkSellable(product, unit) {
    const price = getUnitPrice(product, unit);
    if (price.error) return { error: price.error };
    const stock = stockDeduction(product, 1, unit);
    if (stock.error) return { error: stock.error };
    return {};
  }

  globalThis.Calc = {
    UNITS, WHOLE_UNITS,
    roundMoney, cleanNumber, toNumber,
    isUnit, unitLabel, normalizeUnit, unitFamily, isWholeUnit, validateQuantity,
    parseTileSize, isTileSize, normalizeTileSize,
    getPieceArea, getBoxCoverage, getPiecesPerBox, getAreaOf,
    getUnitFactor, convertQuantity, boxesForArea,
    getUnitPrice, calculateLineTotal, calculateSubtotal,
    defaultStockUnit, inferStockUnit, defaultSellingUnit,
    stockDeduction, stockIn, hasEnoughStock, checkSellable,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = globalThis.Calc;
})();

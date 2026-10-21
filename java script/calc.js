"use strict";



(function () {
  const UNITS = ["piece", "box", "m2", "kg", "m"];
  const PLURAL_UNITS = ["piece", "box"];         // the only unit names that change with the quantity
  const WHOLE_UNITS = ["piece", "box"];          // can't be sold or counted in fractions
  const AREA_UNITS = ["piece", "box", "m2"];     // convertible with each other

  const PIECES_TOLERANCE = 1e-6;   // how close coverage / piece area must be to a whole number
  const STOCK_EPSILON = 1e-9;      // floating-point slack when comparing stock quantities
  const BOX_SCALE = 1e9;           // box fractions are compared in billionths of a box (see roundBoxes)

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

  // Whole boxes to supply for a calculated number of boxes: the next whole number up, unless it already is one.
  //   7.00 -> 7    7.01 -> 8    7.1 -> 8    7.9 -> 8    6.9444... -> 7
  // This is Math.ceil made safe against floating-point noise, so the fraction is counted in whole billionths of a box
  // (an integer) instead of being compared as a float:
  //   - an exact whole number is never pushed up: 4.32 / 1.44 = 3.0000000000000004 stays 3, and 2.9999999999999996 is 3;
  //   - any real fraction goes up, however small (7.01 -> 8). Noise is about 1e-13 for hundreds of boxes, far below one
  //     billionth, so it can never be mistaken for a fraction.
  function roundBoxes(boxes) {
    const n = Number(boxes);
    const lower = Math.floor(n + 1 / BOX_SCALE);                 // a hair under a whole number is that whole number
    const fraction = Math.round((n - lower) * BOX_SCALE);        // billionths of a box above `lower`
    return fraction <= 0 ? lower : lower + 1;
  }

  // Typed in m²: how many whole boxes to supply for it (roundBoxes, at least 1: nothing is supplied as 0 boxes).
  //   { boxes, exact, area, coverage, suppliedArea } or { error }
  //   exact = the calculated, unrounded number of boxes; suppliedArea = the m² the boxes really cover.
  function boxesForArea(product, area) {
    const coverage = getBoxCoverage(product);
    if (coverage.error) return coverage;
    const m2 = Number(area);
    if (isBlank(area) || !Number.isFinite(m2) || m2 <= 0) return { error: say("calc.enterArea") };
    const exact = cleanNumber(m2 / coverage.value);
    const boxes = Math.max(1, roundBoxes(exact));
    return { boxes, exact, area: m2, coverage: coverage.value, suppliedArea: cleanNumber(boxes * coverage.value) };
  }

  // A product whose stock is counted in boxes is handed over in complete boxes.
  const suppliesInBoxes = (product) => Boolean(product) && product.stockUnit === "box";

  // What is really supplied for a quantity typed in `unit`. This is the one place that turns an area into boxes:
  // for a product supplied in boxes, an area typed in m² becomes a whole number of boxes (boxesForArea), and the price,
  // the stock and the invoice all work from those boxes, so they can't disagree. The price stays the product's own
  // (per m²): a box is priced like any box sale (see getUnitPrice). Anything else is returned as it was typed.
  //   { qty, unit }                                                  nothing to convert
  //   { qty, unit: "box", converted: true, requested, exact, area }   area typed -> boxes; requested = the m² typed,
  //                                                                   exact = the unrounded boxes, area = m² supplied
  //   { error }
  function toSuppliedQuantity(product, qty, unit) {
    if (unit !== "m2" || !suppliesInBoxes(product)) return { qty, unit };
    const result = boxesForArea(product, qty);
    if (result.error) return result;
    return { qty: result.boxes, unit: "box", converted: true, requested: result.area, exact: result.exact, area: result.suppliedArea };
  }

  /* ---------- Prices ---------- */

  // The prices a product is sold at: [{ unit, price }], one entry per unit.
  //   - The main price lives in the product's `sellingPrice` / `priceUnit`, as it always has, and comes first.
  //     Whatever writes those fields (the Stock form, a purchase that creates a product, an older version) changes
  //     the main price, and nothing in the saved list can shadow it.
  //   - `sellingPrices` (the saved list) adds the other units' prices. Its entry for the main unit is only a copy
  //     of the main price (the Stock form keeps the two equal), so it is not used.
  //   - A product saved before the list existed has just its one price, in its own price unit.
  //   - A product with no price unit has no entries (its price applies as typed, see getUnitPrice).
  // Nothing is written anywhere: this only reads, so old data is never rewritten or reinterpreted.
  function getSellingPrices(product) {
    const valid = (unitRaw, raw) => {
      const unit = normalizeUnit(unitRaw);
      const price = Number(raw);
      return unit && !isBlank(raw) && typeof raw !== "boolean" && Number.isFinite(price) && price >= 0 ? { unit, price } : null;
    };
    const out = [];
    const main = valid(product && product.priceUnit, product && product.sellingPrice);
    if (main) out.push(main);
    const saved = product && product.sellingPrices;
    if (Array.isArray(saved)) {
      for (const entry of saved) {
        const item = valid(entry && entry.unit, entry && entry.price);
        if (item && !out.some((e) => e.unit === item.unit)) out.push(item);
      }
    }
    return out;
  }

  // The price saved for exactly this unit, or null when the product has none for it.
  function getExplicitPrice(product, unit) {
    const found = getSellingPrices(product).find((entry) => entry.unit === unit);
    return found ? found.price : null;
  }

  // The fields a product stores for a price list: the list itself plus the older single-price fields,
  // kept equal to the first entry.
  function priceFields(entries) {
    const list = entries.map((e) => ({ unit: e.unit, price: Number(e.price) }));
    return { sellingPrices: list, sellingPrice: list[0].price, priceUnit: list[0].unit };
  }

  const PRICE_ERRORS = {
    none: "calc.pricesNone",
    unit: "calc.priceUnitBad",
    duplicate: "calc.priceUnitDuplicate",
    missing: "calc.priceMissing",
    invalid: "calc.priceInvalid",
    negative: "calc.priceNegative",
    mixed: "calc.pricesMixed",
  };

  // Checks a price list typed or loaded: { value: [{ unit, price }] } or { error, code, index, field }.
  // Every entry needs a supported unit and a finite price of 0 or more; a unit may appear only once; there must
  // be at least one entry; all units must be of one kind (piece / box / m² together, kg alone, m alone).
  // A bad entry is reported, never turned into 0 or repaired.
  function checkSellingPrices(entries) {
    const fail = (code, index, field, params) => ({ error: say(PRICE_ERRORS[code], params), code, index, field });
    if (!Array.isArray(entries) || entries.length === 0) return fail("none", -1, null);
    const seen = new Set();
    const value = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const unit = entry && entry.unit;
      if (!isUnit(unit)) return fail("unit", i, "unit");
      const params = { per: say("price." + unit) };
      if (seen.has(unit)) return fail("duplicate", i, "unit", params);
      const raw = entry.price;
      if (isBlank(raw) || typeof raw === "boolean") return fail("missing", i, "price", params);
      const price = Number(raw);
      if (!Number.isFinite(price)) return fail("invalid", i, "price", params);
      if (price < 0) return fail("negative", i, "price", params);
      seen.add(unit);
      value.push({ unit, price });
    }
    const family = unitFamily(value[0].unit);
    const odd = value.findIndex((e) => unitFamily(e.unit) !== family);
    if (odd >= 0) return fail("mixed", odd, "unit");
    return { value };
  }

  // Price of ONE `targetUnit` of the product. This is the one place that decides a selling price:
  //   1. a price saved for exactly that unit is used as it is (source "explicit"), never recalculated;
  //   2. otherwise the product's main price (its first entry) is converted with the tile size and the coverage
  //      per box (source "calculated"), only when the units belong together; a kg price never gives an m² price;
  //   3. a product with no price unit (saved before the field existed) keeps its old behavior: the price applies
  //      as typed to whatever unit is sold (source "legacy").
  // Nothing is saved: a calculated price is worked out each time and never stored in the catalogue.
  //   { value, basePrice, priceUnit, factor, source }   factor = how many price-units are in one target unit
  function getUnitPrice(product, targetUnit) {
    if (!isUnit(targetUnit)) return { error: say("calc.unsupportedSellUnit", { name: nameOf(product) }) };
    const prices = getSellingPrices(product);
    const explicit = prices.find((entry) => entry.unit === targetUnit);
    if (explicit) return { value: explicit.price, basePrice: explicit.price, priceUnit: targetUnit, factor: 1, source: "explicit" };

    if (prices.length === 0) {
      const base = Number(product && product.sellingPrice);
      if (isBlank(product && product.sellingPrice) || !Number.isFinite(base) || base < 0) {
        return { error: say("calc.noPrice", { name: nameOf(product) }) };
      }
      return { value: base, basePrice: base, priceUnit: null, factor: 1, legacy: true, source: "legacy" };
    }

    const main = prices[0];
    if (unitFamily(main.unit) !== unitFamily(targetUnit)) {
      return { error: say("calc.cannotSell", { name: nameOf(product), from: unitWord(main.unit), to: unitWord(targetUnit) }) };
    }
    const factor = getUnitFactor(product, targetUnit, main.unit);
    if (factor.error) return factor;
    return { value: roundMoney(main.price * factor.value), basePrice: main.price, priceUnit: main.unit, factor: factor.value, source: "calculated" };
  }

  // Quantity x price of one unit, rounded to 2 decimals. Invalid numbers count as 0
  // (the sale is validated separately, so this never hides a bad value from checkout).
  const calculateLineTotal = (quantity, unitPrice) => roundMoney(toNumber(quantity) * toNumber(unitPrice));

  // The quantity a sale line is billed for, counted in the unit its price is set in. A sale line prices its goods in the
  // unit its price is set in (1,400 DA/m²), which is not always the unit it is sold or taken out of stock in (7 boxes):
  // `priceQty` is the quantity in the price unit, and for boxes it is the area the whole boxes really contain
  // (7 boxes x 1.44 m² = 10.08 m²), never the area that was asked for. A line without `priceQty` (a saved invoice line,
  // an older line) is billed for the quantity it sells, exactly as before.
  const lineQuantity = (line) => (line && line.priceQty !== undefined && line.priceQty !== null ? line.priceQty : line && line.qty);

  // Amount of one line, rounded to 2 decimals: the billed quantity x the price of ONE price unit, exactly
  // (10.08 m² x 1,400 DA/m² = 14,112 DA). No price per box (or per piece) is worked out and rounded on the way, so a
  // product priced per m² is always billed per m², whatever unit it is sold or stocked in.
  const calculateLineAmount = (line) => calculateLineTotal(lineQuantity(line), line && line.unitPrice);

  // Sum of the (rounded) line totals, so the subtotal always equals the lines shown.
  const calculateSubtotal = (lines) => roundMoney(lines.reduce((sum, l) => sum + calculateLineAmount(l), 0));

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
    getUnitFactor, convertQuantity, roundBoxes, boxesForArea, suppliesInBoxes, toSuppliedQuantity,
    getSellingPrices, getExplicitPrice, priceFields, checkSellingPrices,
    getUnitPrice, calculateLineTotal, lineQuantity, calculateLineAmount, calculateSubtotal,
    defaultStockUnit, inferStockUnit, defaultSellingUnit,
    stockDeduction, stockIn, hasEnoughStock, checkSellable,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = globalThis.Calc;
})();

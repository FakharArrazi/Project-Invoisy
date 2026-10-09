"use strict";

/* ==========================================================================
   Pricing - what the Selling Price of a product is "per", and how to turn it
   into a price for the unit being sold.

   Plain script (no modules, so index.html still works when opened directly).
   It only does arithmetic and wording: no DOM, no storage. Loaded after i18n.js (for the
   unit names and messages) and before script.js.

   Example: 800 DA per m², tile 60*60 cm, coverage per box 1.44 m²
     price per box   = 800 x 1.44        = 1,152 DA
     price per piece = 800 x 0.36        =   288 DA
     2 boxes         = 2 x 1,152         = 2,304 DA
   ========================================================================== */

(function () {
  // Units a price can be "per". piece, box and m² are linked through the tile size and
  // the box coverage. kg and m (meter) only match themselves.
  const PRICE_UNITS = ["piece", "box", "m2", "kg", "m"];

  const isPriceUnit = (unit) => PRICE_UNITS.includes(unit);
  // Display name of a unit in the current language ("Piece", "Box", "m²"...). "" for an unknown unit.
  const priceUnitLabel = (unit) => (isPriceUnit(unit) ? I18n.t("unit." + unit) : "");
  // The same, lower case, for use inside a sentence.
  const unitWord = (unit) => priceUnitLabel(unit).toLowerCase();

  const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

  // "60*120", "60 x 60", "60 × 120 cm", "600*1200 mm" -> { width, height } in cm, or null.
  function parseTileSize(text) {
    const m = String(text || "").trim().match(/^(\d+(?:[.,]\d+)?)\s*[*×x]\s*(\d+(?:[.,]\d+)?)\s*(mm|cm|m)?$/i);
    if (!m) return null;
    const scale = { mm: 0.1, cm: 1, m: 100 }[(m[3] || "cm").toLowerCase()];
    const width = Number(m[1].replace(",", ".")) * scale;
    const height = Number(m[2].replace(",", ".")) * scale;
    return width > 0 && height > 0 ? { width, height } : null;
  }

  // Area of one piece in m², from its size. null when the size is missing.
  function pieceArea(product) {
    const size = parseTileSize(product && product.tileSize);
    return size ? (size.width * size.height) / 10000 : null;
  }

  // m² covered by one of the unit, for the units that are an area. null when it can't be known.
  function areaOf(product, unit) {
    if (unit === "m2") return 1;
    if (unit === "box") return product && product.coveragePerBox > 0 ? product.coveragePerBox : null;
    if (unit === "piece") return pieceArea(product);
    return null;
  }

  const AREA_UNITS = ["piece", "box", "m2"];

  function missingMessage(product, unit) {
    const name = product.name || I18n.t("pricing.thisProduct");
    if (unit === "box") return I18n.t("pricing.noCoverage", { name });
    if (unit === "piece") return I18n.t("pricing.noTileSize", { name });
    return I18n.t("pricing.cannotConvert", { name, unit: unitWord(unit) });
  }

  // Price of ONE `sellUnit` of the product: { price } or { error }.
  // A product without a price unit (saved before this field existed) keeps its old behavior:
  // the price applies as typed to whatever unit is sold.
  function priceForUnit(product, sellUnit) {
    const base = Number(product.sellingPrice);
    const priceUnit = product.priceUnit;
    if (!isPriceUnit(priceUnit) || priceUnit === sellUnit) return { price: base };

    if (AREA_UNITS.includes(priceUnit) && AREA_UNITS.includes(sellUnit)) {
      const from = areaOf(product, priceUnit);
      const to = areaOf(product, sellUnit);
      if (from == null) return { error: missingMessage(product, priceUnit) };
      if (to == null) return { error: missingMessage(product, sellUnit) };
      return { price: round2((base * to) / from) };
    }
    return {
      error: I18n.t("pricing.cannotSell", {
        name: product.name || I18n.t("pricing.thisProduct"),
        from: unitWord(priceUnit),
        to: unitWord(sellUnit),
      }),
    };
  }

  // Quantity x price of one unit, rounded to 2 decimals.
  function lineTotal(qty, unitPrice) {
    return round2(Number(qty) * Number(unitPrice));
  }

  globalThis.Pricing = {
    PRICE_UNITS, priceUnitLabel, isPriceUnit,
    parseTileSize, pieceArea, areaOf, priceForUnit, lineTotal,
  };
})();

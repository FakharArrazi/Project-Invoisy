"use strict";

/* ==========================================================================
   Pricing - what the Selling Price of a product is "per", and how to turn it
   into a price for the unit being sold.

   Plain script (no modules, so index.html still works when opened directly).
   It only does arithmetic: no DOM, no storage. Loaded before script.js.

   Example: 800 DA per m², tile 60*60 cm, coverage per box 1.44 m²
     price per box   = 800 x 1.44        = 1,152 DA
     price per piece = 800 x 0.36        =   288 DA
     2 boxes         = 2 x 1,152         = 2,304 DA
   ========================================================================== */

(function () {
  // Units a price can be "per". piece, box and m² are linked through the tile size and
  // the box coverage. kg and m (meter) only match themselves.
  const PRICE_UNITS = ["piece", "box", "m2", "kg", "m"];
  const PRICE_UNIT_LABELS = { piece: "Piece", box: "Box", m2: "m²", kg: "kg", m: "m" };

  const priceUnitLabel = (unit) => PRICE_UNIT_LABELS[unit] || "";
  const isPriceUnit = (unit) => PRICE_UNITS.includes(unit);

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
    const name = product.name || "This product";
    if (unit === "box") return `${name} has no coverage per box. Edit the product and set it to convert prices to boxes.`;
    if (unit === "piece") return `${name} has no tile size (like 60*60). Edit the product and set it to convert prices to pieces.`;
    return `${name} can't be converted to ${priceUnitLabel(unit)}.`;
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
      error: `${product.name || "This product"} is priced per ${priceUnitLabel(priceUnit)}, so it can't be sold by ${priceUnitLabel(sellUnit)}.`,
    };
  }

  // Quantity x price of one unit, rounded to 2 decimals.
  function lineTotal(qty, unitPrice) {
    return round2(Number(qty) * Number(unitPrice));
  }

  globalThis.Pricing = {
    PRICE_UNITS, PRICE_UNIT_LABELS, priceUnitLabel, isPriceUnit,
    parseTileSize, pieceArea, areaOf, priceForUnit, lineTotal,
  };
})();

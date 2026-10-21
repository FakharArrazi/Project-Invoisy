"use strict";

// Tests for java script/calc.js (unit conversion and price maths). No browser needed.
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { LANGUAGE_FILES, SCRIPT_DIR } = require("./helpers");

// calc.js words its errors and unit names through I18n, so the language files are loaded first (as in index.html).
for (const file of LANGUAGE_FILES) require(path.join(SCRIPT_DIR, file));
const Calc = require(path.join(SCRIPT_DIR, "calc.js"));

// The mandatory reference product: 1,500 DA / m², 60 x 60 cm pieces, 1.44 m² per box.
const tile = (extra = {}) => ({
  name: "Ceramic Tile", tileSize: "60*60", coveragePerBox: 1.44,
  sellingPrice: 1500, priceUnit: "m2", stock: 20, stockUnit: "box", ...extra,
});
const price = (product, unit) => Calc.getUnitPrice(product, unit);

test("reference case: 60 x 60 cm piece is 0.36 m², 4 pieces per box", () => {
  assert.equal(Calc.getPieceArea(tile()).value, 0.36);
  assert.equal(Calc.getPiecesPerBox(tile()).value, 4);
  assert.equal(Calc.getBoxCoverage(tile()).value, 1.44);
});

test("1. price per m² -> sell by m²: the price is used as entered", () => {
  assert.equal(price(tile(), "m2").value, 1500);
});

test("2. price per m² -> sell by piece: 1,500 x 0.36 = 540", () => {
  assert.equal(price(tile(), "piece").value, 540);
});

test("3. price per m² -> sell by box: 1,500 x 1.44 = 2,160; two boxes = 4,320", () => {
  const box = price(tile(), "box");
  assert.equal(box.value, 2160);
  assert.equal(Calc.calculateLineTotal(2, box.value), 4320);
});

test("4. price per piece -> sell by piece", () => {
  assert.equal(price(tile({ sellingPrice: 250, priceUnit: "piece" }), "piece").value, 250);
});

test("5. price per piece -> sell by box: 250 x 4 = 1,000; three pieces = 750", () => {
  const p = tile({ sellingPrice: 250, priceUnit: "piece" });
  assert.equal(price(p, "box").value, 1000);
  assert.equal(Calc.calculateLineTotal(3, price(p, "piece").value), 750);
});

test("6. price per box -> sell by box: one box 2,000, two boxes 4,000", () => {
  const p = tile({ sellingPrice: 2000, priceUnit: "box" });
  assert.equal(price(p, "box").value, 2000);
  assert.equal(Calc.calculateLineTotal(2, 2000), 4000);
});

test("7. price per box -> sell by piece (500) and by m² (2,000 / 1.44)", () => {
  const p = tile({ sellingPrice: 2000, priceUnit: "box" });
  assert.equal(price(p, "piece").value, 500);
  assert.equal(price(p, "m2").value, Calc.roundMoney(2000 / 1.44));
});

test("8. price per kg -> sell by kg only", () => {
  const p = { name: "Cement", sellingPrice: 300, priceUnit: "kg", stock: 100, stockUnit: "kg" };
  assert.equal(price(p, "kg").value, 300);
  assert.match(price(p, "piece").error, /priced per kg/);
  assert.match(price(p, "box").error, /priced per kg/);
  assert.match(price(p, "m").error, /priced per kg/);
  assert.match(price(p, "m2").error, /priced per kg/);
});

test("9. price per meter -> sell by meter only", () => {
  const p = { name: "Pipe", sellingPrice: 150, priceUnit: "m", stock: 100, stockUnit: "m" };
  assert.equal(price(p, "m").value, 150);
  assert.match(price(p, "kg").error, /priced per m/);
  assert.match(price(p, "m2").error, /priced per m/);
});

test("10. changing the selling unit recalculates the unit price", () => {
  const p = tile();
  const prices = ["m2", "piece", "box"].map((u) => price(p, u).value);
  assert.deepEqual(prices, [1500, 540, 2160]);
  // going back to the first unit gives the original price again: no drift
  assert.equal(price(p, "m2").value, 1500);
});

test("11. changing the quantity recalculates the line total", () => {
  assert.equal(Calc.calculateLineTotal(1, 2160), 2160);
  assert.equal(Calc.calculateLineTotal(2, 2160), 4320);
  assert.equal(Calc.calculateLineTotal(2.5, 300), 750);
  assert.equal(Calc.calculateLineTotal(3, 33.33), 99.99);
  assert.equal(Calc.calculateLineTotal(0.1 + 0.2, 10), 3);   // floating-point noise is removed
});

test("12. selling boxes deducts the right stock", () => {
  // stock counted in pieces: 2 boxes = 8 pieces
  assert.equal(Calc.stockDeduction(tile({ stockUnit: "piece", stock: 80 }), 2, "box").value, 8);
  // stock counted in boxes: 2 boxes = 2 boxes
  assert.equal(Calc.stockDeduction(tile(), 2, "box").value, 2);
  // stock counted in m²: 2 boxes = 2.88 m²
  assert.equal(Calc.stockDeduction(tile({ stockUnit: "m2", stock: 100 }), 2, "box").value, 2.88);
});

test("13. selling pieces deducts the right stock", () => {
  assert.equal(Calc.stockDeduction(tile({ stockUnit: "piece", stock: 80 }), 3, "piece").value, 3);
  assert.equal(Calc.stockDeduction(tile(), 3, "piece").value, 0.75);           // 3 pieces = 0.75 box
  assert.equal(Calc.stockDeduction(tile({ stockUnit: "m2", stock: 100 }), 3, "piece").value, 1.08);
});

test("stock is shown in other units too (20 boxes = 80 pieces = 28.8 m²)", () => {
  assert.equal(Calc.stockIn(tile(), "piece").value, 80);
  assert.equal(Calc.stockIn(tile(), "m2").value, 28.8);
});

test("14. missing or invalid dimensions prevent area-based conversion", () => {
  for (const tileSize of ["", undefined, "abc", "0*60", "60*0", "-60*60", "60"]) {
    const p = tile({ tileSize });
    assert.ok(Calc.getPieceArea(p).error, `tile size ${JSON.stringify(tileSize)}`);
    assert.ok(price(p, "piece").error, `price per piece, tile size ${JSON.stringify(tileSize)}`);
    assert.ok(Calc.convertQuantity(1, "piece", "m2", p).error);
    assert.ok(Calc.getPiecesPerBox(p).error);
    assert.equal(price(p, "box").value, 2160, "the box price does not need the tile size");
  }
  assert.match(Calc.getPieceArea(tile({ tileSize: "" })).error, /tile size/);
  assert.equal(Calc.getPieceArea(tile({ tileSize: "600*600 mm" })).value, 0.36);   // millimeters become meters
  assert.equal(Calc.getPieceArea(tile({ tileSize: "0.6*0.6 m" })).value, 0.36);
});

test("15. invalid coverage and division by zero are handled safely", () => {
  for (const coveragePerBox of [null, undefined, "", 0, -1.44, NaN, "abc", Infinity]) {
    const p = tile({ coveragePerBox });
    assert.ok(Calc.getBoxCoverage(p).error, `coverage ${coveragePerBox}`);
    assert.ok(price(p, "box").error);
    assert.ok(Calc.convertQuantity(1, "box", "piece", p).error);
    assert.ok(Calc.boxesForArea(p, 5).error);
    assert.equal(price(p, "piece").value, 540, "the piece price does not need the coverage");
  }
  assert.match(price(tile({ coveragePerBox: null }), "box").error, /coverage per box/);
  assert.ok(Calc.boxesForArea(tile(), 0).error);
  assert.ok(Calc.boxesForArea(tile(), -2).error);
});

test("coverage that is not a whole number of pieces is reported, never rounded", () => {
  const p = tile({ coveragePerBox: 1.5 });   // 1.5 / 0.36 = 4.1666...
  assert.match(Calc.getPiecesPerBox(p).error, /not a whole number of pieces/);
  assert.ok(Calc.convertQuantity(1, "piece", "box", p).error);
  assert.ok(Calc.stockDeduction(p, 3, "piece").error);                          // box-counted stock needs pieces per box
  assert.equal(price(p, "piece").value, 540);                                   // price per m² -> piece needs only the piece area
  assert.equal(price(p, "box").value, 2250);                                    // ...and per box only the coverage
  assert.match(Calc.getPiecesPerBox(tile({ coveragePerBox: 0.2 })).error, /smaller than one piece/);
});

test("conversions between different kinds of measure are refused", () => {
  const p = { name: "Cement", sellingPrice: 300, priceUnit: "kg", stock: 5, stockUnit: "kg" };
  assert.ok(Calc.convertQuantity(1, "kg", "piece", p).error);
  assert.ok(Calc.convertQuantity(1, "m", "kg", p).error);
  assert.ok(Calc.convertQuantity(1, "m", "m2", p).error);
  assert.equal(Calc.convertQuantity(2, "kg", "kg", p).value, 2);
  assert.ok(Calc.convertQuantity(1, "bogus", "box", tile()).error);
});

test("invalid prices are rejected, not guessed", () => {
  for (const sellingPrice of [undefined, null, "", NaN, -1, "abc"]) {
    assert.ok(price(tile({ sellingPrice }), "box").error, `price ${sellingPrice}`);
  }
  assert.equal(price(tile({ sellingPrice: 0 }), "box").value, 0);   // a free item is a valid price
  assert.ok(price(tile(), "bogus").error);
});

test("quantities: boxes and pieces must be whole, kg and m may be fractions", () => {
  assert.equal(Calc.validateQuantity("2", "box").value, 2);
  assert.ok(Calc.validateQuantity("2.5", "box").error);
  assert.ok(Calc.validateQuantity("1.5", "piece").error);
  assert.equal(Calc.validateQuantity("2.5", "kg").value, 2.5);
  assert.equal(Calc.validateQuantity("0.5", "m").value, 0.5);
  for (const bad of ["", "0", "-1", "abc", NaN, null, undefined]) {
    assert.ok(Calc.validateQuantity(bad, "kg").error, `quantity ${bad}`);
    assert.ok(Calc.validateQuantity(bad, "piece").error);
  }
});

test("box rounding: a whole number is unchanged, any fraction goes up to the next whole box", () => {
  const cases = [[7, 7], [7.0, 7], [7.01, 8], [7.1, 8], [7.9, 8], [6.9444, 7], [17, 17], [17.01, 18], [17.09, 18], [17.1, 18], [17.36, 18], [17.99, 18]];
  for (const [calculated, boxes] of cases) assert.equal(Calc.roundBoxes(calculated), boxes, `${calculated} -> ${boxes}`);
  assert.equal(Calc.roundBoxes(10 / 1.44), 7, "10 m² / 1.44 = 6.9444 -> 7");
  assert.equal(Calc.roundBoxes(25 / 1.44), 18, "25 m² / 1.44 = 17.3611 -> 18");
  assert.equal(Calc.roundBoxes(0), 0);
});

test("box rounding: floating-point noise never turns an exact whole number into an extra box", () => {
  // exact whole numbers that the division leaves a hair above or below
  assert.equal(Calc.roundBoxes(4.32 / 1.44), 3, "3.0000000000000004 is 3, not 4");
  assert.equal(Calc.roundBoxes(2.9999999999999996), 3);
  assert.equal(Calc.roundBoxes(17.000000000000004), 17);
  assert.equal(Calc.roundBoxes(0.1 + 0.2 + 16.7), 17);
  // a real fraction always goes up, however small it is, and whatever the whole part
  for (const whole of [0, 1, 5, 17, 100, 1234]) {
    assert.equal(Calc.roundBoxes(whole), whole, `${whole} stays`);
    assert.equal(Calc.roundBoxes(whole + 0.01), whole + 1, `${whole}.01 goes up`);
    assert.equal(Calc.roundBoxes(whole + 0.1), whole + 1, `${whole}.1 goes up`);
    assert.equal(Calc.roundBoxes(whole + 0.9), whole + 1, `${whole}.9 goes up`);
  }
  // it is a ceiling: it agrees with Math.ceil wherever floating point is not involved
  for (const n of [0.5, 1.2, 2.01, 17.05, 99.99]) assert.equal(Calc.roundBoxes(n), Math.ceil(n), `${n}`);
});

test("an exact whole-box area never adds a box, whatever the coverage; a hundredth of a m² more needs one", () => {
  for (const coverage of [1.215, 1.5, 1.62, 1.44, 2.88]) {
    for (let boxes = 1; boxes <= 500; boxes++) {
      const area = Number((boxes * coverage).toFixed(6));          // the area as it is typed: 7.2, 8.505, ...
      assert.equal(Calc.boxesForArea(tile({ coveragePerBox: coverage }), area).boxes, boxes, `${area} m² at ${coverage} m² per box`);
      assert.equal(Calc.boxesForArea(tile({ coveragePerBox: coverage }), Calc.cleanNumber(area + 0.01)).boxes, boxes + 1, `${area} + 0.01 m²`);
    }
  }
});

test("area typed in m² becomes whole boxes, rounded up", () => {
  assert.equal(Calc.boxesForArea(tile(), 3).boxes, 3);      // 2.08 boxes -> 3
  assert.equal(Calc.boxesForArea(tile(), 3.3).boxes, 3);    // 2.29 boxes -> 3
  assert.equal(Calc.boxesForArea(tile(), 2.88).boxes, 2);   // exact multiple, no extra box
  assert.equal(Calc.boxesForArea(tile(), 4.32).boxes, 3);   // exact multiple that floats as 3.0000000000000004
  assert.equal(Calc.boxesForArea(tile(), 0.5).boxes, 1);
  assert.equal(Calc.boxesForArea(tile(), 0.05).boxes, 1, "never 0 boxes");
  assert.equal(Calc.boxesForArea(tile({ coveragePerBox: 2.88 }), 5.76).boxes, 2);
  const r = Calc.boxesForArea(tile(), 25);
  assert.deepEqual([r.boxes, r.exact, r.area, r.coverage, r.suppliedArea], [18, 17.3611111111, 25, 1.44, 25.92]);
  const gpt = Calc.boxesForArea(tile(), 10);
  assert.deepEqual([gpt.boxes, gpt.exact, gpt.suppliedArea], [7, 6.94444444444, 10.08], "10 m² -> 7 boxes -> 10.08 m²");
  const exact = Calc.boxesForArea(tile(), 7.2);
  assert.deepEqual([exact.boxes, exact.exact, exact.suppliedArea], [5, 5, 7.2], "7.2 m² is exactly 5 boxes");
});

test("Boston Gray: 25 m² at 1,700 DA/m², 1.44 m² per box -> 18 boxes, 25.92 m² supplied, 44,064 DA", () => {
  const boston = tile({ name: "Boston Gray", sellingPrice: 1700 });
  const supplied = Calc.toSuppliedQuantity(boston, 25, "m2");
  assert.deepEqual([supplied.qty, supplied.unit, supplied.converted, supplied.requested, supplied.area], [18, "box", true, 25, 25.92]);
  const boxPrice = price(boston, "box");
  assert.deepEqual([boxPrice.value, boxPrice.basePrice, boxPrice.priceUnit, boxPrice.source], [2448, 1700, "m2", "calculated"]);
  assert.equal(Calc.calculateLineTotal(supplied.qty, boxPrice.value), 44064);
  assert.equal(Calc.roundMoney(supplied.area * 1700), 44064, "the same total from the area supplied x the price per m²");
});

test("only a product supplied in boxes has its area turned into boxes; every other unit is left as typed", () => {
  const boston = tile();
  assert.equal(Calc.suppliesInBoxes(boston), true);
  assert.deepEqual(Calc.toSuppliedQuantity(boston, 5, "box"), { qty: 5, unit: "box" });
  assert.deepEqual(Calc.toSuppliedQuantity(boston, 3, "piece"), { qty: 3, unit: "piece" });
  for (const stockUnit of ["piece", "m2", null, undefined]) {
    const other = tile({ stockUnit });
    assert.equal(Calc.suppliesInBoxes(other), false);
    assert.deepEqual(Calc.toSuppliedQuantity(other, 25, "m2"), { qty: 25, unit: "m2" }, `stock counted in ${stockUnit}`);
  }
  const perKg = { name: "Cement", sellingPrice: 5, priceUnit: "kg", stockUnit: "kg", stock: 100 };
  assert.deepEqual(Calc.toSuppliedQuantity(perKg, 2.5, "kg"), { qty: 2.5, unit: "kg" });
  const perPiece = tile({ sellingPrice: 300, priceUnit: "piece" });
  assert.deepEqual(Calc.toSuppliedQuantity(perPiece, 4, "piece"), { qty: 4, unit: "piece" });
  assert.equal(price(perPiece, "piece").value, 300, "a per-piece price stays per piece");
  // a box product with no coverage can't turn an area into boxes: the reason is reported, nothing is guessed
  assert.match(Calc.toSuppliedQuantity(tile({ coveragePerBox: null }), 25, "m2").error, /coverage per box/);
});

test("full precision inside, rounding only on money", () => {
  const p = tile({ sellingPrice: 2000, priceUnit: "box" });
  assert.equal(Calc.getUnitFactor(p, "m2", "box").value, 1 / 1.44);   // the ratio itself is not rounded
  assert.equal(price(p, "m2").value, 1388.89);                        // the price is
  assert.equal(Calc.calculateSubtotal([{ qty: 3, unitPrice: 33.33 }, { qty: 1, unitPrice: 0.01 }]), 100);
  assert.equal(Calc.roundMoney(1.005), 1.01);
});

test("units: names, plurals and spellings", () => {
  assert.equal(Calc.unitLabel("box", 2), "Boxes");
  assert.equal(Calc.unitLabel("box", 1), "Box");
  assert.equal(Calc.unitLabel("piece", 3), "Pieces");
  assert.equal(Calc.unitLabel("m2", 3), "m²");
  assert.equal(Calc.unitLabel("box"), "Box");
  assert.equal(Calc.unitLabel(undefined, 2), "");
  assert.equal(Calc.normalizeUnit(" M² "), "m2");
  assert.equal(Calc.normalizeUnit("Boxes"), "box");
  assert.equal(Calc.normalizeUnit("furlong"), null);
  assert.equal(Calc.normalizeUnit(null), null);
  assert.equal(Calc.normalizeTileSize("600 x 1200 mm"), "60*120");
  assert.equal(Calc.normalizeTileSize("60 × 120 cm"), "60*120");
});

test("stock units: inferred only from evidence", () => {
  assert.equal(Calc.inferStockUnit({ priceUnit: "m2" }), "box");
  assert.equal(Calc.inferStockUnit({ priceUnit: "kg" }), "kg");
  assert.equal(Calc.inferStockUnit({ priceUnit: "piece" }), "piece");
  assert.equal(Calc.inferStockUnit({ priceUnit: "piece", stockUnit: "box" }), "box");
  assert.equal(Calc.inferStockUnit({ coveragePerBox: 1.44 }), null);   // no price unit: unknown, not guessed
  assert.equal(Calc.inferStockUnit({}), null);
});

test("an old product with no price unit keeps its price as typed, and its stock goes down one-for-one", () => {
  const legacy = { name: "Old", sellingPrice: 100, stock: 10, priceUnit: null, stockUnit: null };
  assert.equal(price(legacy, "box").value, 100);
  assert.equal(price(legacy, "box").legacy, true);
  assert.equal(Calc.stockDeduction(legacy, 3, "box").value, 3);
  assert.equal(Calc.checkSellable(legacy, "kg").error, undefined);
});

test("a product can be sold in a unit only when both price and stock can be converted", () => {
  assert.equal(Calc.checkSellable(tile(), "piece").error, undefined);
  assert.ok(Calc.checkSellable(tile(), "kg").error);
  assert.ok(Calc.checkSellable(tile({ tileSize: "" }), "piece").error);
  assert.equal(Calc.checkSellable(tile({ tileSize: "" }), "box").error, undefined);
});

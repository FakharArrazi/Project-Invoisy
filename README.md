# Invoisy

## Units, prices and stock

All unit conversion and price maths lives in `java script/calc.js` (loaded before `script.js`).
Nothing else converts units. The unit names and the messages it returns are not written in the code:
they come from `java script/lang/` (English and French), so `calc.js` is loaded after `i18n.js` and the
language files.

- A product has a **selling price** and the **unit that price is per** (piece, box, m², kg or meter).
  Selling in another unit works the price out from the tile size and the coverage per box, e.g.
  1,500 DA/m², 60*60 cm tile, 1.44 m² per box: piece = 540 DA, box = 2,160 DA.
- A product also has a **stock unit**: what its stock quantity is counted in. Selling boxes or
  pieces takes stock out converted to that unit (3 pieces from 20 boxes of 4 pieces leaves 19.25 boxes).
- kg and meter products can only be sold by kg / meter.
- A saved invoice keeps the unit sold, the price charged and the details it was worked out from.
  It is never recalculated from the product's current data.
- Products saved before these fields existed keep working: their price is used as typed and their
  stock goes down one-for-one until a price unit and stock unit are set in the Stock form.

## Tests

No dependencies. Needs Node 20 or newer:

    node --test

"use strict";

/* ==========================================================================
   Invoice print - lays a printed invoice out over as many pages as it needs.

   Plain script (no modules, so index.html still works when opened directly). Loaded before script.js.

   Why the app paginates by itself
     The browser prints with `@page { margin: 0 }` (a bigger page margin makes Chrome print its own date / address
     header and footer). With no page margin the browser can not give the second and later pages a margin, a header
     or a "Page 2 of 3" footer, and it knows nothing about which parts of an invoice belong together. So just before
     printing, script.js hands the invoice to this file as a list of items, and this file lays them out on paper-sized
     pages that carry their own margins, continuation header and footer. The number of pages is known before anything
     is printed, so the numbering is always right.

   The items (in printing order)
     { kind: "block", html }
         Stays whole: it is never split between two pages. The financial summary (totals and payment status) is one.
     { kind: "flow", lead, build(entries, continued), entries }
         Many entries that may run over several pages: the product table (rows), the payment history, the delivery
         history. `build` returns the markup of one piece holding the given entries (`continued` is true for a piece
         that does not start the section, so it can repeat the table heading / section title). `lead` is markup that
         goes just before the first piece and stays with it. A piece always holds at least one entry, and the first
         piece (lead, heading and first entry) is never left alone at the bottom of a page.

   layout() is pure: it only needs a function that says whether some markup fits on a page, so the rules can be tested
   without a browser. paginate() supplies that function by measuring a real page in the document.
   ========================================================================== */

(function () {
  // items: see above.  fits(fragments, pageIndex): would a page holding exactly these fragments (after the continuation
  // header when pageIndex > 0) stay inside the printable area?  Returns the pages, each a list of markup fragments.
  function layout(items, fits) {
    const pages = [[]];
    const current = () => pages[pages.length - 1];
    const next = () => { pages.push([]); };
    const fitsHere = (fragments) => fits(current().concat(fragments), pages.length - 1);

    // Fragments that stay together go on the current page when they fit after what is already there, otherwise on a new
    // one. An empty page takes them whatever their size: nothing could do better, and the next one would be no different.
    function together(fragments) {
      if (current().length && !fitsHere(fragments)) next();
      current().push(...fragments);
    }

    for (const item of items) {
      if (item.kind === "block") {
        together([item.html]);
        continue;
      }
      const entries = item.entries;
      if (!entries.length) {
        together((item.lead ? [item.lead] : []).concat(item.build([], false)));
        continue;
      }
      let start = 0;       // the entries of the piece on the current page are entries[start .. k]
      together((item.lead ? [item.lead] : []).concat(item.build(entries.slice(0, 1), false)));
      for (let k = 1; k < entries.length; k++) {
        const grown = item.build(entries.slice(start, k + 1), start > 0);
        if (fits(current().slice(0, -1).concat(grown), pages.length - 1)) {
          current()[current().length - 1] = grown;
        } else {
          next();
          start = k;
          current().push(item.build(entries.slice(k, k + 1), true));
        }
      }
    }
    return pages;
  }

  // Builds the printed pages inside `host` (the element that is shown only when printing). options:
  //   continuation: markup for the top of every page after the first
  //   footer(page, total): markup for the bottom of a page
  // Returns the number of pages.
  function paginate(host, items, options) {
    const probe = document.createElement("section");
    probe.className = "inv-page";
    const probeBody = document.createElement("div");
    probeBody.className = "inv-page-body";
    probe.appendChild(probeBody);
    host.textContent = "";
    host.appendChild(probe);
    host.classList.add("measuring");      // laid out off screen, so it can be measured but never shows
    try {
      const top = (pageIndex) => (pageIndex > 0 ? options.continuation : "");
      const fits = (fragments, pageIndex) => {
        probeBody.innerHTML = top(pageIndex) + fragments.join("");
        return probeBody.scrollHeight <= probeBody.clientHeight + 1;    // + 1: sub-pixel rounding
      };
      const pages = layout(items, fits);
      host.innerHTML = pages.map((fragments, index) =>
        `<section class="inv-page"><div class="inv-page-body">${top(index)}${fragments.join("")}</div>${options.footer(index + 1, pages.length)}</section>`
      ).join("");
      return pages.length;
    } finally {
      host.classList.remove("measuring");
    }
  }

  globalThis.InvoicePrint = { layout, paginate };
  if (typeof module !== "undefined" && module.exports) module.exports = globalThis.InvoicePrint;
})();

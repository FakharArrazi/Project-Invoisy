"use strict";

/* ==========================================================================
   Simple Invoice - products, stock, sales and invoices in the browser.
   Data is kept in localStorage. No backend, no dependencies.
   ========================================================================== */

/* ---------- Configuration ---------- */

const CURRENCY = "DA";            // default currency (can be changed in Settings)
const WALK_IN = "Walk-in Customer";
const LOW_STOCK = 5;              // stock at or below this shows "Low stock"
const LOGO_MAX_W = 320;           // stored logo size (shown at 160x100 max, 2x keeps it sharp)
const LOGO_MAX_H = 200;

const DEFAULT_SETTINGS = {
  businessName: "My Store",
  address: "",
  phone: "",
  email: "",
  currency: CURRENCY,
  logo: "",                         // store logo, stored as a PNG data URL
  paper: "A4",                      // invoice paper size: "A4" or "A5"
};

const DEMO_PRODUCTS = [
  { name: "Coca Cola 33cl", description: "330ml Coca Cola bottle", sku: "COCA33",   category: "Drinks", sellingPrice: 80,  purchasePrice: 60, stock: 50 },
  { name: "Chips",          description: "Salted potato chips",    sku: "CHIPS01",  category: "Snacks", sellingPrice: 120, purchasePrice: 90, stock: 24 },
  { name: "Water 1.5L",     description: "Bottled water 1.5L",     sku: "WATER15",  category: "Drinks", sellingPrice: 50,  purchasePrice: 35, stock: 40 },
  { name: "Coffee",         description: "Ground coffee, 250g",    sku: "COFFEE01", category: "Drinks", sellingPrice: 350, purchasePrice: 280, stock: 15 },
  { name: "Chocolate",      description: "Milk chocolate bar",     sku: "CHOC01",   category: "Snacks", sellingPrice: 100, purchasePrice: 70, stock: 30 },
];

/* ---------- Helpers ---------- */

const $ = (id) => document.getElementById(id);
const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function esc(value) {
  const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => map[c]);
}

function money(amount, currency) {
  return numberFormat.format(amount) + " " + (currency || state.settings.currency);
}

function formatDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return pad(d.getDate()) + "/" + pad(d.getMonth() + 1) + "/" + d.getFullYear();
}

function formatDateTime(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return formatDate(iso) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
}

function formatInvoiceNumber(n) {
  return "INV-" + String(n).padStart(6, "0");
}

let toastTimer = null;
function notify(message, type) {
  const toast = $("toast");
  toast.textContent = message;
  toast.className = "toast show" + (type === "error" ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = "toast"; }, 3500);
}

function showError(id, message) {
  $(id).textContent = message || "";
}

/* ---------- Storage (safe) ---------- */

function readStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const value = JSON.parse(raw);
    return value === null || value === undefined ? fallback : value;
  } catch (e) {
    return fallback;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    notify("Could not save data. Check that browser storage is available.", "error");
    return false;
  }
}

function normalizeProduct(raw) {
  if (!raw || typeof raw !== "object" || !raw.name) return null;
  const price = Number(raw.sellingPrice);
  const stock = Math.floor(Number(raw.stock));
  const hasCost = raw.purchasePrice !== "" && raw.purchasePrice != null && Number.isFinite(Number(raw.purchasePrice)) && Number(raw.purchasePrice) >= 0;
  return {
    id: String(raw.id || uid()),
    name: String(raw.name),
    description: String(raw.description || ""),
    sku: String(raw.sku || ""),
    category: String(raw.category || ""),
    sellingPrice: Number.isFinite(price) && price >= 0 ? price : 0,
    purchasePrice: hasCost ? Number(raw.purchasePrice) : null,
    stock: Number.isFinite(stock) && stock >= 0 ? stock : 0,
  };
}

function loadProducts() {
  const stored = readStorage("products", []);
  return Array.isArray(stored) ? stored.map(normalizeProduct).filter(Boolean) : [];
}

function saveProducts() {
  return writeStorage("products", state.products);
}

// Invoices saved before payments existed are treated as fully paid at their sale date.
function normalizeInvoice(inv) {
  if (!inv || typeof inv !== "object" || !inv.invoiceNumber || !Array.isArray(inv.items)) return null;
  let payments;
  if (Array.isArray(inv.payments)) {
    payments = inv.payments
      .filter((p) => p && Number.isFinite(Number(p.amount)) && Number(p.amount) > 0)
      .map((p) => ({ amount: round2(Number(p.amount)), timestamp: p.timestamp || inv.date }));
  } else {
    const total = toNumber(inv.total);
    payments = total > 0 ? [{ amount: total, timestamp: inv.date }] : [];
  }
  return { ...inv, id: String(inv.id || uid()), payments };
}

function loadInvoices() {
  const stored = readStorage("invoices", []);
  if (!Array.isArray(stored)) return [];
  return stored.map(normalizeInvoice).filter(Boolean);
}

function loadSettings() {
  const stored = readStorage("settings", {});
  const settings = { ...DEFAULT_SETTINGS };
  if (stored && typeof stored === "object") {
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (typeof stored[key] === "string") settings[key] = stored[key];
    }
  }
  if (!settings.currency.trim()) settings.currency = CURRENCY;
  if (!settings.logo.startsWith("data:image/")) settings.logo = "";
  if (!["A4", "A5"].includes(settings.paper)) settings.paper = "A4";
  return settings;
}

function loadCounter(invoices) {
  let counter = Math.floor(Number(readStorage("invoiceCounter", 0)));
  if (!Number.isFinite(counter) || counter < 0) counter = 0;
  for (const inv of invoices) {
    const n = parseInt(String(inv.invoiceNumber).replace(/\D/g, ""), 10);
    if (Number.isFinite(n) && n > counter) counter = n;
  }
  return counter;
}

/* ---------- State ---------- */

function newSale() {
  return {
    items: [],                              // { productId, qty, unitPrice }
    customer: { name: "", phone: "", address: "" },
    discountType: "amount", discountValue: "",
    taxType: "amount", taxValue: "",
    paidValue: "",                          // amount paid now; empty = paid in full
  };
}

const state = {
  products: [],
  invoices: [],
  settings: { ...DEFAULT_SETTINGS },
  counter: 0,
  view: "sell",
  sale: newSale(),
  results: [],            // products currently listed in the picker
  selectedId: null,       // product selected in the picker
  previewInvoice: null,   // saved invoice shown in the preview (null = live sale)
  editingId: null,        // product being edited in the Stock form
};

function loadAll() {
  state.products = loadProducts();
  state.invoices = loadInvoices();
  state.settings = loadSettings();
  state.counter = loadCounter(state.invoices);
}

/* ==========================================================================
   PRODUCTS
   ========================================================================== */

function findProduct(id) {
  return state.products.find((p) => p.id === id);
}

function searchProducts(query) {
  const terms = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  return state.products
    .filter((p) => {
      const haystack = (p.name + " " + p.sku + " " + p.category).toLowerCase();
      return terms.every((t) => haystack.includes(t));
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function readProductForm() {
  const get = (id) => $(id).value.trim();
  const fail = (field, error) => ({ field, error });

  const name = get("pName");
  if (!name) return fail("pName", "Product name is required.");

  const priceRaw = get("pPrice");
  const price = Number(priceRaw);
  if (priceRaw === "" || !Number.isFinite(price)) return fail("pPrice", "Selling price is required.");
  if (price < 0) return fail("pPrice", "Selling price can't be negative.");

  const costRaw = get("pCost");
  const cost = Number(costRaw);
  if (costRaw !== "" && (!Number.isFinite(cost) || cost < 0)) return fail("pCost", "Purchase price can't be negative.");

  const stockRaw = get("pStock");
  const stock = stockRaw === "" ? 0 : Number(stockRaw);
  if (!Number.isInteger(stock) || stock < 0) return fail("pStock", "Stock must be a whole number, 0 or more.");

  const sku = get("pSku");
  if (sku) {
    const clash = state.products.find((p) => p.id !== state.editingId && p.sku.toLowerCase() === sku.toLowerCase());
    if (clash) return fail("pSku", `SKU "${sku}" is already used by ${clash.name}.`);
  }

  return {
    values: {
      name,
      description: get("pDesc"),
      sku,
      category: get("pCategory"),
      sellingPrice: price,
      purchasePrice: costRaw === "" ? null : cost,
      stock,
    },
  };
}

function addProduct(values) {
  state.products.push({ id: uid(), ...values });
  saveProducts();
  resetProductForm();
  renderAll();
  notify(`${values.name} added.`);
  $("pName").focus();
}

function updateProduct(id, values) {
  const product = findProduct(id);
  if (!product) return;
  Object.assign(product, values);
  saveProducts();
  resetProductForm();
  renderAll();
  notify(`${product.name} updated.`);
}

function deleteProduct(id) {
  const product = findProduct(id);
  if (!product) return;
  if (!confirm(`Delete "${product.name}"? This cannot be undone.`)) return;
  state.products = state.products.filter((p) => p.id !== id);
  state.sale.items = state.sale.items.filter((i) => i.productId !== id);
  if (state.selectedId === id) state.selectedId = null;
  if (state.editingId === id) resetProductForm();
  saveProducts();
  renderAll();
  notify(`${product.name} deleted.`);
}

function adjustStock(id, delta) {
  const product = findProduct(id);
  if (!product) return;
  product.stock = Math.max(0, product.stock + delta);
  saveProducts();
  renderStock();
  renderResults();
  renderSelected();
}

function addStock(id, rawQty) {
  const product = findProduct(id);
  if (!product) return { error: "Select a product first." };
  const qty = Number(rawQty);
  if (rawQty === "" || !Number.isInteger(qty) || qty < 1) {
    return { error: "Quantity to add must be a whole number of at least 1." };
  }
  const before = product.stock;
  product.stock = before + qty;
  saveProducts();
  return { ok: true, message: `${product.name}: ${before} + ${qty} = ${product.stock}` };
}

function startEditProduct(id) {
  const p = findProduct(id);
  if (!p) return;
  state.editingId = id;
  $("pName").value = p.name;
  $("pDesc").value = p.description;
  $("pPrice").value = p.sellingPrice;
  $("pCost").value = p.purchasePrice == null ? "" : p.purchasePrice;
  $("pStock").value = p.stock;
  $("pSku").value = p.sku;
  $("pCategory").value = p.category;
  $("productFormTitle").textContent = "Edit product";
  $("productSubmit").textContent = "Save Changes";
  $("productCancel").hidden = false;
  clearProductErrors();
  $("pName").focus();
}

function resetProductForm() {
  state.editingId = null;
  $("productForm").reset();
  $("pStock").value = 0;
  $("productFormTitle").textContent = "Add product";
  $("productSubmit").textContent = "Add Product";
  $("productCancel").hidden = true;
  clearProductErrors();
}

function clearProductErrors() {
  showError("productError", "");
  $("productForm").querySelectorAll("[aria-invalid]").forEach((el) => el.removeAttribute("aria-invalid"));
}

function loadDemoData() {
  const have = new Set(state.products.map((p) => p.sku.toLowerCase()).filter(Boolean));
  let added = 0;
  for (const demo of DEMO_PRODUCTS) {
    if (have.has(demo.sku.toLowerCase())) continue;
    state.products.push({ id: uid(), ...demo });
    added++;
  }
  if (!added) {
    notify("The demo products are already in your stock.");
    return;
  }
  saveProducts();
  renderAll();
  notify(`${added} demo products added.`);
}

/* ==========================================================================
   CURRENT SALE
   ========================================================================== */

function findSaleItem(productId) {
  return state.sale.items.find((i) => i.productId === productId);
}

function stockMessage(available, inSale) {
  return `Not enough stock. Available quantity: ${available}.` + (inSale ? ` ${inSale} already in this sale.` : "");
}

function addToSale(productId, rawQty) {
  const product = findProduct(productId);
  if (!product) return { error: "Select a product first." };
  const qty = Number(rawQty);
  if (rawQty === "" || !Number.isInteger(qty) || qty < 1) {
    return { error: "Quantity must be a whole number of at least 1." };
  }
  const item = findSaleItem(productId);
  const inSale = item ? item.qty : 0;
  if (inSale + qty > product.stock) return { error: stockMessage(product.stock, inSale) };

  if (item) item.qty += qty;
  else state.sale.items.push({ productId, qty, unitPrice: product.sellingPrice });
  return { ok: true };
}

function removeFromSale(productId) {
  state.sale.items = state.sale.items.filter((i) => i.productId !== productId);
}

// Returns { error } when the value is rejected; { error, clamped } when it was capped to stock.
function updateSaleQuantity(productId, rawQty) {
  const item = findSaleItem(productId);
  const product = findProduct(productId);
  if (!item || !product) return { error: "This product is no longer available." };
  const qty = Number(rawQty);
  if (rawQty === "" || !Number.isInteger(qty) || qty < 1) {
    return { error: "Quantity must be a whole number of at least 1." };
  }
  if (qty > product.stock) {
    item.qty = product.stock;
    return { error: stockMessage(product.stock), clamped: true };
  }
  item.qty = qty;
  return {};
}

function updateSalePrice(productId, rawPrice) {
  const item = findSaleItem(productId);
  if (!item) return { error: "This product is no longer in the sale." };
  const price = Number(rawPrice);
  if (rawPrice === "" || !Number.isFinite(price)) return { error: "Enter a price." };
  if (price < 0) return { error: "Price can't be negative." };
  item.unitPrice = price;
  return {};
}

function amountFrom(type, value, base) {
  const v = Number(value);
  if (!Number.isFinite(v) || v < 0) return 0;
  return round2(type === "percent" ? (base * Math.min(v, 100)) / 100 : v);
}

function calculateTotals(sale) {
  const subtotal = round2(sale.items.reduce((sum, i) => sum + toNumber(i.qty) * toNumber(i.unitPrice), 0));
  const discount = Math.min(amountFrom(sale.discountType, sale.discountValue, subtotal), subtotal);
  const tax = amountFrom(sale.taxType, sale.taxValue, subtotal - discount);
  const total = Math.max(0, round2(subtotal - discount + tax));
  return { subtotal, discount, tax, total };
}

// Amount received with the sale. An empty field means paid in full.
function salePaid(sale, total) {
  if (String(sale.paidValue).trim() === "") return total;
  const v = Number(sale.paidValue);
  return Number.isFinite(v) && v > 0 ? Math.min(round2(v), total) : 0;
}

// Total paid, remaining balance and status are always calculated from the payments list.
function paymentInfo(inv) {
  const payments = Array.isArray(inv.payments) ? inv.payments : [];
  const paid = round2(payments.reduce((sum, p) => sum + toNumber(p.amount), 0));
  const remaining = Math.max(0, round2(toNumber(inv.total) - paid));
  const cls = remaining <= 0 ? "paid" : paid > 0 ? "partial" : "unpaid";
  const status = { paid: "PAID", partial: "PARTIALLY PAID", unpaid: "UNPAID" }[cls];
  return { payments, paid, remaining, status, cls };
}

function paidError() {
  const raw = String(state.sale.paidValue).trim();
  if (raw === "") return "";
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0) return "Amount paid can't be negative.";
  if (round2(v) > calculateTotals(state.sale).total) return "Amount paid can't be more than the invoice total.";
  return "";
}

function adjustmentError() {
  const s = state.sale;
  for (const [label, type, value] of [["Discount", s.discountType, s.discountValue], ["Tax", s.taxType, s.taxValue]]) {
    if (value === "") continue;
    const v = Number(value);
    if (!Number.isFinite(v) || v < 0) return `${label} can't be negative.`;
    if (type === "percent" && v > 100) return `${label} percentage can't be more than 100.`;
  }
  return "";
}

function validateSale() {
  const errors = [];
  if (state.sale.items.length === 0) errors.push("Add at least one product to the sale.");
  for (const item of state.sale.items) {
    const p = findProduct(item.productId);
    if (!p) { errors.push("A product in this sale no longer exists."); continue; }
    if (!Number.isInteger(item.qty) || item.qty < 1) errors.push(`${p.name}: quantity must be at least 1.`);
    else if (item.qty > p.stock) errors.push(`${p.name}: ${stockMessage(p.stock)}`);
    if (!Number.isFinite(item.unitPrice) || item.unitPrice < 0) errors.push(`${p.name}: price can't be negative.`);
  }
  const adj = adjustmentError() || paidError();
  if (adj) errors.push(adj);
  if (!Number.isFinite(calculateTotals(state.sale).total)) errors.push("The invoice total is not valid.");
  return errors;
}

// Keeps the sale in line with the inventory (deleted products, stock lowered elsewhere).
function syncSaleWithProducts() {
  const notes = [];
  state.sale.items = state.sale.items.filter((item) => {
    const p = findProduct(item.productId);
    if (!p) { notes.push("A product was removed from the sale because it no longer exists."); return false; }
    if (p.stock < 1) { notes.push(`${p.name} was removed from the sale: out of stock.`); return false; }
    if (item.qty > p.stock) { item.qty = p.stock; notes.push(`${p.name} was reduced to the available stock (${p.stock}).`); }
    return true;
  });
  return notes;
}

function clearSale() {
  state.sale = newSale();
  $("custName").value = "";
  $("custPhone").value = "";
  $("custAddress").value = "";
  $("discountValue").value = "";
  $("taxValue").value = "";
  $("amountPaid").value = "";
  $("discountType").value = "amount";
  $("taxType").value = "amount";
  showError("saleError", "");
  showError("addError", "");
  state.previewInvoice = null;
  renderSale();
  renderInvoice();
}

/* ==========================================================================
   INVOICES
   ========================================================================== */

function buildInvoiceData(sale, invoiceNumber, dateIso) {
  const totals = calculateTotals(sale);
  const paid = salePaid(sale, totals.total);
  const items = sale.items.map((item) => {
    const p = findProduct(item.productId);
    return {
      productId: item.productId,
      name: p ? p.name : "(deleted product)",
      sku: p ? p.sku : "",
      qty: item.qty,
      unitPrice: item.unitPrice,
      total: round2(item.qty * item.unitPrice),
    };
  });
  const s = state.settings;
  return {
    invoiceNumber,
    date: dateIso,
    customer: {
      name: sale.customer.name.trim() || WALK_IN,
      phone: sale.customer.phone.trim(),
      address: sale.customer.address.trim(),
    },
    items,
    subtotal: totals.subtotal,
    discount: totals.discount,
    tax: totals.tax,
    total: totals.total,
    payments: paid > 0 ? [{ amount: paid, timestamp: dateIso }] : [],
    discountPercent: sale.discountType === "percent" ? toNumber(sale.discountValue) : null,
    taxPercent: sale.taxType === "percent" ? toNumber(sale.taxValue) : null,
    currency: s.currency,
    business: { name: s.businessName, address: s.address, phone: s.phone, email: s.email },
  };
}

function draftInvoice() {
  return buildInvoiceData(state.sale, formatInvoiceNumber(state.counter + 1), new Date().toISOString());
}

function saveInvoice(invoice) {
  const invoices = [...state.invoices, invoice];
  if (!writeStorage("invoices", invoices)) return false;
  state.invoices = invoices;
  state.counter = Math.max(state.counter, parseInt(invoice.invoiceNumber.replace(/\D/g, ""), 10));
  writeStorage("invoiceCounter", state.counter);
  return true;
}

function completeSale() {
  // 1-2. Validate the sale and check the stock one final time.
  const errors = validateSale();
  if (errors.length) {
    showError("saleError", errors.join("\n"));
    return;
  }
  showError("saleError", "");

  // 3-4. Calculate totals and generate the invoice number.
  const invoice = { id: uid(), ...buildInvoiceData(state.sale, formatInvoiceNumber(state.counter + 1), new Date().toISOString()) };

  // 5. Save the invoice. If this fails, nothing else changes.
  if (!saveInvoice(invoice)) return;

  // 6. Decrease the stock.
  for (const item of invoice.items) {
    const p = findProduct(item.productId);
    if (p) p.stock -= item.qty;
  }
  saveProducts();

  // 7-10. Clear the sale, show the invoice, refresh the screens.
  clearSale();
  state.previewInvoice = invoice;
  state.selectedId = null;
  $("search").value = "";
  renderAll();
  notify(`Sale completed. ${invoice.invoiceNumber} saved.`);
}

function deleteInvoice(id) {
  const inv = state.invoices.find((i) => i.id === id);
  if (!inv) return;
  if (!confirm(`Delete ${inv.invoiceNumber}? Stock is not changed.`)) return;
  const invoices = state.invoices.filter((i) => i.id !== id);
  if (!writeStorage("invoices", invoices)) return;
  state.invoices = invoices;
  if (state.previewInvoice && state.previewInvoice.id === id) state.previewInvoice = null;
  renderAll();
  notify(`${inv.invoiceNumber} deleted.`);
}

// Adds a cash payment (current date/time) to a saved invoice. Items and stock are never touched.
function addPayment(id, rawAmount) {
  const inv = state.invoices.find((i) => i.id === id);
  if (!inv) return { error: "Invoice not found." };
  const { remaining } = paymentInfo(inv);
  if (remaining <= 0) return { error: "This invoice is already fully paid." };
  const amount = Number(rawAmount);
  if (rawAmount === "" || !Number.isFinite(amount) || amount <= 0) return { error: "Enter a payment amount greater than 0." };
  if (round2(amount) > remaining) return { error: "Payment cannot be greater than the remaining balance." };

  const updated = { ...inv, payments: [...inv.payments, { amount: round2(amount), timestamp: new Date().toISOString() }] };
  const invoices = state.invoices.map((i) => (i.id === id ? updated : i));
  if (!writeStorage("invoices", invoices)) return { error: "The payment could not be saved." };
  state.invoices = invoices;
  if (state.previewInvoice && state.previewInvoice.id === id) state.previewInvoice = updated;
  return { ok: true };
}

function viewInvoice(id) {
  const inv = state.invoices.find((i) => i.id === id);
  if (!inv) return;
  state.previewInvoice = inv;
  $("payAmount").value = "";
  showError("payError", "");
  showView("sell", { keepPreview: true });
}

function printInvoice(invoice) {
  if (invoice) {
    state.previewInvoice = invoice;
    renderInvoice();
  }
  // The document title becomes the suggested file name when saving as PDF.
  const original = document.title;
  document.title = (state.previewInvoice || draftInvoice()).invoiceNumber;
  window.addEventListener("afterprint", () => { document.title = original; }, { once: true });
  window.print();
}

/* ==========================================================================
   RENDERING
   ========================================================================== */

/* ==========================================================================
   STORE LOGO
   ========================================================================== */

function renderLogoSetting() {
  const logo = state.settings.logo;
  $("logoPreview").innerHTML = logo ? `<img src="${esc(logo)}" alt="Store logo">` : '<span class="muted small">No logo</span>';
  $("removeLogo").disabled = !logo;
}

function saveLogo(dataUrl) {
  const previous = state.settings.logo;
  state.settings.logo = dataUrl;
  if (!writeStorage("settings", state.settings)) { state.settings.logo = previous; return; }
  renderLogoSetting();
  renderInvoice();
  notify(dataUrl ? "Logo saved." : "Logo removed.");
}

// Reads a PNG, shrinks it to fit LOGO_MAX_W x LOGO_MAX_H (never enlarges, keeps transparency) and saves it.
function chooseLogo(file) {
  showError("logoError", "");
  if (!file) return;
  if (file.type !== "image/png" && !/\.png$/i.test(file.name)) { showError("logoError", "Please choose a PNG image."); return; }
  const reader = new FileReader();
  reader.onerror = () => showError("logoError", "That file could not be read.");
  reader.onload = () => {
    const img = new Image();
    img.onerror = () => showError("logoError", "That file is not a valid PNG image.");
    img.onload = () => {
      const scale = Math.min(1, LOGO_MAX_W / img.naturalWidth, LOGO_MAX_H / img.naturalHeight);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      saveLogo(canvas.toDataURL("image/png"));
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

function stockBadge(stock) {
  if (stock <= 0) return ' <span class="badge out">Out of stock</span>';
  if (stock <= LOW_STOCK) return ' <span class="badge low">Low stock</span>';
  return "";
}

function renderResults() {
  const box = $("results");
  const query = $("search").value;

  if (state.products.length === 0) {
    state.results = [];
    box.innerHTML =
      '<div class="empty"><p><strong>No products yet.</strong></p>' +
      '<p class="muted">Add your first product to start selling.</p>' +
      '<div class="actions"><button type="button" class="btn primary" data-action="goto-add">Add Product</button>' +
      '<button type="button" class="btn" data-action="demo">Load Demo Data</button></div></div>';
    return;
  }

  state.results = searchProducts(query);
  if (state.results.length === 0) {
    box.innerHTML = `<div class="empty"><p class="muted">No products match "${esc(query)}".</p></div>`;
    return;
  }

  box.innerHTML = state.results.map((p) => {
    const meta = [p.sku, p.category].filter(Boolean).join(", ");
    const stock = p.stock <= 0 ? "Out of stock" : p.stock <= LOW_STOCK ? `Low stock: ${p.stock}` : `Stock: ${p.stock}`;
    return `<div class="result" role="option" data-id="${esc(p.id)}" aria-selected="${p.id === state.selectedId}">` +
      `<div><div>${esc(p.name)}</div>${meta ? `<div class="meta">${esc(meta)}</div>` : ""}</div>` +
      `<div class="price">${esc(money(p.sellingPrice))}</div>` +
      `<div class="stock${p.stock <= 0 ? " out" : p.stock <= LOW_STOCK ? " low" : ""}">${stock}</div></div>`;
  }).join("");

  const selected = box.querySelector('[aria-selected="true"]');
  if (selected) selected.scrollIntoView({ block: "nearest" });
}

function renderSelected() {
  const p = findProduct(state.selectedId);
  $("selectedInfo").innerHTML = p
    ? `<strong>${esc(p.name)}</strong>` +
      (p.stock > 0 ? `<span>Stock: ${p.stock}</span>` : '<span class="out">Out of stock</span>') +
      (p.stock > 0 && p.stock <= LOW_STOCK ? '<span class="low">Low stock</span>' : "") +
      `<span>Price: ${esc(money(p.sellingPrice))}</span>`
    : '<span class="none">Select a product from the list.</span>';
}

function renderSale() {
  const body = $("saleBody");
  if (state.sale.items.length === 0) {
    body.innerHTML = '<tr class="empty-row"><td colspan="5">No items yet. Search for a product above and add it to the sale.</td></tr>';
  } else {
    body.innerHTML = state.sale.items.map((item) => {
      const p = findProduct(item.productId);
      const name = p ? p.name : "(deleted product)";
      return `<tr data-id="${esc(item.productId)}">` +
        `<td><div>${esc(name)}</div><div class="muted small">Available: ${p ? p.stock : 0}</div><div class="error small" data-row-error></div></td>` +
        `<td class="num"><input class="qty-input" type="number" min="1" step="1" value="${item.qty}" data-field="qty" aria-label="Quantity of ${esc(name)}"></td>` +
        `<td class="num"><input class="price-input" type="number" min="0" step="any" value="${item.unitPrice}" data-field="price" aria-label="Unit price of ${esc(name)}"></td>` +
        `<td class="num" data-line-total>${esc(money(item.qty * item.unitPrice))}</td>` +
        `<td class="num"><button type="button" class="btn small danger" data-action="remove" aria-label="Remove ${esc(name)} from sale">Remove</button></td>` +
        `</tr>`;
    }).join("");
  }
  renderTotals();
}

function renderTotals() {
  const t = calculateTotals(state.sale);
  $("tSubtotal").textContent = money(t.subtotal);
  $("tDiscount").textContent = money(t.discount);
  $("tTax").textContent = money(t.tax);
  $("tTotal").textContent = money(t.total);
  $("tRemaining").textContent = money(Math.max(0, round2(t.total - salePaid(state.sale, t.total))));
  $("amountPaid").placeholder = numberFormat.format(t.total);
}

// Updates totals, line totals and the preview without rebuilding the inputs (keeps focus).
function refreshLive() {
  state.previewInvoice = null;
  $("saleBody").querySelectorAll("tr[data-id]").forEach((row) => {
    const item = findSaleItem(row.dataset.id);
    if (item) row.querySelector("[data-line-total]").textContent = money(item.qty * item.unitPrice);
  });
  renderTotals();
  renderInvoice();
}

function invoiceHtml(inv) {
  const cur = inv.currency || state.settings.currency;
  const biz = inv.business || {
    name: state.settings.businessName, address: state.settings.address,
    phone: state.settings.phone, email: state.settings.email,
  };
  const cust = inv.customer || { name: WALK_IN, phone: "", address: "" };
  const num = (n) => numberFormat.format(toNumber(n));
  const pct = (p) => (p ? ` (${numberFormat.format(p)}%)` : "");
  const line = (text) => (text ? `<div>${esc(text)}</div>` : "");
  const logo = state.settings.logo ? `<img class="inv-logo" src="${esc(state.settings.logo)}" alt="Store logo">` : "";

  const rows = inv.items.length
    ? inv.items.map((i) =>
        `<tr><td>${esc(i.name)}</td><td class="num">${num(i.qty)}</td><td class="num">${num(i.unitPrice)}</td><td class="num">${num(i.total != null ? i.total : toNumber(i.qty) * toNumber(i.unitPrice))}</td></tr>`
      ).join("")
    : '<tr><td colspan="4" class="none">No items yet</td></tr>';

  const pay = paymentInfo(inv);
  const hasItems = inv.items.length > 0;
  const paidRows = hasItems
    ? `<tr><td>Total Paid</td><td>${esc(money(pay.paid, cur))}</td></tr><tr class="due"><td>Remaining</td><td>${esc(money(pay.remaining, cur))}</td></tr>`
    : "";
  const history = hasItems
    ? `<div class="inv-status"><span class="${pay.cls}">STATUS: ${pay.status}</span></div>
    <section class="inv-payments"><h3>PAYMENT HISTORY</h3>${
      pay.payments.length
        ? pay.payments.map((p) => `<div class="inv-pay"><span class="when">${esc(formatDateTime(p.timestamp))}</span><span>Paid: ${esc(money(p.amount, cur))}</span></div>`).join("")
        : '<div class="inv-pay"><span class="when">No payments yet.</span></div>'
    }</section>`
    : "";

  return `<header class="inv-head">
      <div>${logo}<div class="inv-biz-name">${esc(biz.name)}</div>${line(biz.address)}${line(biz.phone)}${line(biz.email)}</div>
      <div class="inv-title">INVOICE</div>
    </header>
    <div class="inv-meta">
      <div><div class="label">Customer</div><div class="inv-customer">${esc(cust.name || WALK_IN)}${cust.phone ? "\n" + esc(cust.phone) : ""}${cust.address ? "\n" + esc(cust.address) : ""}</div></div>
      <div class="right"><div><span class="label">Invoice:</span> ${esc(inv.invoiceNumber)}</div><div><span class="label">Date:</span> ${esc(formatDateTime(inv.date))}</div></div>
    </div>
    <table class="inv-table">
      <thead><tr><th>Product</th><th class="num">Qty</th><th class="num">Price (${esc(cur)})</th><th class="num">Total (${esc(cur)})</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <table class="inv-totals">
      <tr><td>Subtotal</td><td>${esc(money(toNumber(inv.subtotal), cur))}</td></tr>
      <tr><td>Discount${pct(inv.discountPercent)}</td><td>${esc(money(toNumber(inv.discount), cur))}</td></tr>
      <tr><td>Tax${pct(inv.taxPercent)}</td><td>${esc(money(toNumber(inv.tax), cur))}</td></tr>
      <tr class="grand"><td>TOTAL</td><td>${esc(money(toNumber(inv.total), cur))}</td></tr>
      ${paidRows}
    </table>
    ${history}
    <p class="inv-thanks">Thank you for your purchase.</p>`;
}

// Payment box above a saved invoice: totals plus the "Add Payment" control.
function renderPayBox() {
  const inv = state.previewInvoice;
  $("payBox").hidden = !inv;
  if (!inv) return;
  const cur = inv.currency || state.settings.currency;
  const info = paymentInfo(inv);
  const full = info.remaining <= 0;
  $("payNumber").textContent = inv.invoiceNumber;
  $("payTotal").textContent = money(toNumber(inv.total), cur);
  $("payPaid").textContent = money(info.paid, cur);
  $("payRemaining").textContent = money(info.remaining, cur);
  $("payAmount").disabled = full;
  $("payBtn").disabled = full;
  $("payAmount").placeholder = full ? "Fully paid" : "Max " + numberFormat.format(info.remaining);
}

function renderInvoice() {
  const saved = state.previewInvoice;
  $("invoice").innerHTML = invoiceHtml(saved || draftInvoice());
  $("previewStatus").textContent = saved ? "Saved invoice" : "Live preview";
  $("backToSale").hidden = !saved;
  renderPayBox();
}

function renderStock() {
  const hasProducts = state.products.length > 0;
  const list = searchProducts($("stockFilter").value);
  const empty = $("stockEmpty");

  $("stockFilter").hidden = !hasProducts;
  $("stockTable").hidden = list.length === 0;
  empty.hidden = list.length > 0;

  if (!hasProducts) {
    empty.innerHTML =
      '<p><strong>No products yet.</strong></p><p class="muted">Add your first product to start selling.</p>' +
      '<div class="actions"><button type="button" class="btn primary" data-action="goto-add">Add Product</button>' +
      '<button type="button" class="btn" data-action="demo">Load Demo Data</button></div>';
  } else if (list.length === 0) {
    empty.innerHTML = `<p class="muted">No products match "${esc($("stockFilter").value)}".</p>`;
  }

  $("stockBody").innerHTML = list.map((p) =>
    `<tr data-id="${esc(p.id)}">` +
    `<td><div>${esc(p.name)}</div>${p.category ? `<div class="muted small">${esc(p.category)}</div>` : ""}</td>` +
    `<td>${p.sku ? esc(p.sku) : '<span class="muted">-</span>'}</td>` +
    `<td class="num">${esc(money(p.sellingPrice))}</td>` +
    `<td class="num">${p.stock}${stockBadge(p.stock)}</td>` +
    `<td class="num"><div class="row-actions">` +
    `<button type="button" class="btn small" data-action="dec" aria-label="Decrease stock of ${esc(p.name)} by 1"${p.stock < 1 ? " disabled" : ""}>-</button>` +
    `<button type="button" class="btn small" data-action="inc" aria-label="Increase stock of ${esc(p.name)} by 1">+</button>` +
    `<button type="button" class="btn small" data-action="edit">Edit</button>` +
    `<button type="button" class="btn small danger" data-action="delete">Delete</button>` +
    `</div></td></tr>`
  ).join("");

  // Restock selector (keep the current choice) and category suggestions.
  const select = $("rProduct");
  const previous = select.value;
  const sorted = [...state.products].sort((a, b) => a.name.localeCompare(b.name));
  select.innerHTML = sorted.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
  if (sorted.some((p) => p.id === previous)) select.value = previous;
  select.disabled = !hasProducts;
  $("categoryList").innerHTML = [...new Set(state.products.map((p) => p.category).filter(Boolean))]
    .map((c) => `<option value="${esc(c)}"></option>`).join("");
  renderRestockInfo();
}

function renderRestockInfo() {
  const p = findProduct($("rProduct").value);
  if (!p) { $("restockInfo").textContent = "Add a product first."; return; }
  const raw = $("rQty").value;
  const qty = Number(raw);
  $("restockInfo").textContent = `Current stock: ${p.stock}.` +
    (raw !== "" && Number.isInteger(qty) && qty > 0 ? ` After adding: ${p.stock + qty}.` : "");
}

function searchInvoices(query) {
  const terms = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  return [...state.invoices].reverse().filter((inv) => {
    const c = inv.customer || {};
    const phone = String(c.phone || "");
    const haystack = (inv.invoiceNumber + " " + (c.name || WALK_IN) + " " + phone + " " + phone.replace(/\s+/g, "")).toLowerCase();
    return terms.every((t) => haystack.includes(t));
  });
}

function renderInvoices() {
  const hasInvoices = state.invoices.length > 0;
  const list = searchInvoices($("invoiceFilter").value);
  $("invoiceFilter").hidden = !hasInvoices;
  $("invoiceTable").hidden = list.length === 0;
  $("invoiceEmpty").hidden = list.length > 0;
  $("invoiceEmpty").innerHTML = hasInvoices
    ? `<p class="muted">No invoices match "${esc($("invoiceFilter").value)}".</p>`
    : '<p><strong>No invoices yet.</strong></p><p class="muted">Completed sales will appear here.</p>';
  $("invoiceBody").innerHTML = list.map((inv) => {
    const pay = paymentInfo(inv);
    const label = { paid: "Paid", partial: "Partial", unpaid: "Unpaid" }[pay.cls];
    return `<tr data-id="${esc(inv.id)}">` +
      `<td>${esc(inv.invoiceNumber)}</td>` +
      `<td>${esc(formatDate(inv.date))}</td>` +
      `<td>${esc((inv.customer && inv.customer.name) || WALK_IN)}</td>` +
      `<td class="num">${esc(money(toNumber(inv.total), inv.currency))}</td>` +
      `<td class="num">${esc(money(pay.paid, inv.currency))}</td>` +
      `<td class="num">${esc(money(pay.remaining, inv.currency))}</td>` +
      `<td><span class="badge ${pay.cls}">${label}</span></td>` +
      `<td class="num"><div class="row-actions">` +
      `<button type="button" class="btn small" data-action="view">View</button>` +
      `<button type="button" class="btn small" data-action="pay"${pay.remaining <= 0 ? " disabled" : ""}>Add Payment</button>` +
      `<button type="button" class="btn small" data-action="print">Print</button>` +
      `<button type="button" class="btn small danger" data-action="delete">Delete</button>` +
      `</div></td></tr>`;
  }).join("");
}

function applyCurrency() {
  document.querySelectorAll("[data-currency]").forEach((el) => { el.textContent = state.settings.currency; });
}

function fillSettingsForm() {
  const s = state.settings;
  $("sName").value = s.businessName;
  $("sAddress").value = s.address;
  $("sPhone").value = s.phone;
  $("sEmail").value = s.email;
  $("sCurrency").value = s.currency;
  renderLogoSetting();
}

function applyPaperSize() {
  const paper = state.settings.paper;
  $("paperStyle").textContent = `@page { size: ${paper}; }`;
  document.documentElement.dataset.paper = paper.toLowerCase();
  $("paper" + paper).checked = true;
}

function savePaper(paper) {
  const previous = state.settings.paper;
  state.settings.paper = paper;
  if (writeStorage("settings", state.settings)) notify("Paper size set to " + paper + ".");
  else state.settings.paper = previous;
  applyPaperSize();
}

function renderAll() {
  applyPaperSize();
  applyCurrency();
  renderResults();
  renderSelected();
  renderSale();
  renderStock();
  renderInvoices();
  renderInvoice();
}

/* ==========================================================================
   NAVIGATION
   ========================================================================== */

function showView(name, options) {
  const keepPreview = options && options.keepPreview;
  const previous = state.view;
  state.view = name;

  document.querySelectorAll(".view").forEach((v) => { v.hidden = v.id !== "view-" + name; });
  document.querySelectorAll(".nav-btn").forEach((b) => {
    if (b.dataset.view === name) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  $("app").dataset.view = name;

  let notes = [];
  if (name === "sell") {
    notes = syncSaleWithProducts();
    if (!keepPreview && previous !== "sell") state.previewInvoice = null;
  }
  if (name === "settings") fillSettingsForm();

  renderAll();
  if (notes.length) notify(notes.join(" "), "error");
}

function goToAddProduct() {
  showView("stock");
  $("pName").focus();
}

/* ==========================================================================
   EVENTS
   ========================================================================== */

function selectProduct(id) {
  state.selectedId = id;
  renderResults();
  renderSelected();
}

function bindEvents() {
  // Navigation and shared buttons
  document.querySelectorAll(".nav-btn").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));
  $("brand").addEventListener("click", () => showView("sell"));
  document.addEventListener("click", (e) => {
    const action = e.target.closest("[data-action='goto-add'], [data-action='demo']");
    if (!action) return;
    if (action.dataset.action === "goto-add") goToAddProduct();
    else loadDemoData();
  });

  // Product picker
  const search = $("search");
  search.addEventListener("input", () => {
    state.results = searchProducts(search.value);
    state.selectedId = state.results.length ? state.results[0].id : null;
    renderResults();
    renderSelected();
  });
  search.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!state.results.length) return;
      const index = state.results.findIndex((p) => p.id === state.selectedId);
      const next = e.key === "ArrowDown" ? Math.min(index + 1, state.results.length - 1) : Math.max(index - 1, 0);
      selectProduct(state.results[next].id);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (!state.selectedId && state.results.length) selectProduct(state.results[0].id);
      if (state.selectedId) { $("addQty").focus(); $("addQty").select(); }
    }
  });
  $("results").addEventListener("click", (e) => {
    const row = e.target.closest(".result");
    if (!row) return;
    selectProduct(row.dataset.id);
    $("addQty").focus();
    $("addQty").select();
  });
  $("addForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const result = addToSale(state.selectedId, $("addQty").value.trim());
    if (result.error) {
      showError("addError", result.error);
      $("addQty").focus();
      return;
    }
    showError("addError", "");
    showError("saleError", "");
    state.selectedId = null;
    state.previewInvoice = null;
    search.value = "";
    $("addQty").value = 1;
    renderResults();
    renderSelected();
    renderSale();
    renderInvoice();
    search.focus();
  });
  $("addQty").addEventListener("input", () => showError("addError", ""));

  // Current sale rows
  const saleBody = $("saleBody");
  saleBody.addEventListener("input", (e) => {
    const input = e.target.closest("input[data-field]");
    if (!input) return;
    const row = input.closest("tr");
    const id = row.dataset.id;
    const result = input.dataset.field === "qty" ? updateSaleQuantity(id, input.value.trim()) : updateSalePrice(id, input.value.trim());
    if (result.clamped) input.value = findSaleItem(id).qty;
    row.querySelector("[data-row-error]").textContent = result.error || "";
    showError("saleError", "");
    refreshLive();
  });
  saleBody.addEventListener("change", (e) => {
    // On leaving a field, show the value that is actually in the sale.
    const input = e.target.closest("input[data-field]");
    if (!input) return;
    const row = input.closest("tr");
    const item = findSaleItem(row.dataset.id);
    if (!item) return;
    input.value = input.dataset.field === "qty" ? item.qty : item.unitPrice;
    row.querySelector("[data-row-error]").textContent = "";
  });
  saleBody.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action='remove']");
    if (!btn) return;
    removeFromSale(btn.closest("tr").dataset.id);
    showError("saleError", "");
    state.previewInvoice = null;
    renderSale();
    renderInvoice();
  });

  // Customer, discount, tax
  const customerFields = { custName: "name", custPhone: "phone", custAddress: "address" };
  for (const [id, key] of Object.entries(customerFields)) {
    $(id).addEventListener("input", () => {
      state.sale.customer[key] = $(id).value;
      refreshLive();
    });
  }
  const adjustFields = { discountValue: "discountValue", discountType: "discountType", taxValue: "taxValue", taxType: "taxType" };
  for (const [id, key] of Object.entries(adjustFields)) {
    $(id).addEventListener("input", () => {
      state.sale[key] = $(id).value;
      showError("saleError", adjustmentError() || paidError());
      refreshLive();
    });
  }

  $("amountPaid").addEventListener("input", () => {
    state.sale.paidValue = $("amountPaid").value;
    showError("saleError", paidError());
    refreshLive();
  });

  $("clearSale").addEventListener("click", clearSale);
  $("completeSale").addEventListener("click", completeSale);

  // Stock: product form
  const productForm = $("productForm");
  productForm.addEventListener("submit", (e) => {
    e.preventDefault();
    clearProductErrors();
    const result = readProductForm();
    if (result.error) {
      showError("productError", result.error);
      $(result.field).setAttribute("aria-invalid", "true");
      $(result.field).focus();
      return;
    }
    if (state.editingId) updateProduct(state.editingId, result.values);
    else addProduct(result.values);
  });
  productForm.addEventListener("input", (e) => {
    e.target.removeAttribute("aria-invalid");
    showError("productError", "");
  });
  $("productCancel").addEventListener("click", resetProductForm);

  // Stock: add stock
  $("restockForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const result = addStock($("rProduct").value, $("rQty").value.trim());
    if (result.error) {
      showError("restockError", result.error);
      $("rQty").focus();
      return;
    }
    showError("restockError", "");
    $("rQty").value = "";
    renderStock();
    renderResults();
    renderSelected();
    notify(result.message);
    $("rQty").focus();
  });
  $("rProduct").addEventListener("change", renderRestockInfo);
  $("rQty").addEventListener("input", () => { showError("restockError", ""); renderRestockInfo(); });

  // Stock: table
  $("stockFilter").addEventListener("input", renderStock);
  $("stockBody").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const id = btn.closest("tr").dataset.id;
    if (btn.dataset.action === "inc") adjustStock(id, 1);
    else if (btn.dataset.action === "dec") adjustStock(id, -1);
    else if (btn.dataset.action === "edit") startEditProduct(id);
    else if (btn.dataset.action === "delete") deleteProduct(id);
  });

  // Invoices
  $("invoiceBody").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const id = btn.closest("tr").dataset.id;
    if (btn.dataset.action === "view") viewInvoice(id);
    else if (btn.dataset.action === "pay") { viewInvoice(id); $("payAmount").focus(); }
    else if (btn.dataset.action === "print") printInvoice(state.invoices.find((i) => i.id === id));
    else if (btn.dataset.action === "delete") deleteInvoice(id);
  });

  $("invoiceFilter").addEventListener("input", renderInvoices);

  // Add a payment to the invoice shown in the preview
  $("payForm").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!state.previewInvoice) return;
    const result = addPayment(state.previewInvoice.id, $("payAmount").value.trim());
    if (result.error) {
      showError("payError", result.error);
      $("payAmount").focus();
      return;
    }
    showError("payError", "");
    $("payAmount").value = "";
    renderInvoices();
    renderInvoice();
    notify("Payment added.");
  });
  $("payAmount").addEventListener("input", () => showError("payError", ""));

  // Preview
  $("printBtn").addEventListener("click", () => printInvoice());
  $("backToSale").addEventListener("click", () => {
    state.previewInvoice = null;
    renderInvoice();
  });

  // Settings
  $("settingsForm").addEventListener("submit", (e) => {
    e.preventDefault();
    state.settings = {
      ...state.settings,
      businessName: $("sName").value.trim(),
      address: $("sAddress").value.trim(),
      phone: $("sPhone").value.trim(),
      email: $("sEmail").value.trim(),
      currency: $("sCurrency").value.trim() || CURRENCY,
    };
    if (writeStorage("settings", state.settings)) notify("Settings saved.");
    fillSettingsForm();
    renderAll();
  });
  $("loadDemo").addEventListener("click", loadDemoData);
  $("chooseLogo").addEventListener("click", () => $("logoFile").click());
  $("logoFile").addEventListener("change", (e) => { chooseLogo(e.target.files[0]); e.target.value = ""; });
  $("removeLogo").addEventListener("click", () => saveLogo(""));
  document.querySelectorAll('input[name="paper"]').forEach((r) => r.addEventListener("change", () => savePaper(r.value)));

  // Another tab changed the data: pick it up.
  window.addEventListener("storage", (e) => {
    if (e.key !== null && !["products", "invoices", "settings", "invoiceCounter"].includes(e.key)) return;
    loadAll();
    if (state.previewInvoice) state.previewInvoice = state.invoices.find((i) => i.id === state.previewInvoice.id) || null;
    showError("saleError", "");
    const notes = syncSaleWithProducts();
    renderAll();
    if (notes.length) notify(notes.join(" "), "error");
  });
}

/* ---------- Start ---------- */

loadAll();
bindEvents();
resetProductForm();
showView("sell");

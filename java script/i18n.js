"use strict";

/* ==========================================================================
   I18n - the language layer. Plain script (no modules, so index.html still
   works when opened directly). No DOM, no storage: it only looks up text.
   Loaded first, then one file per language (lang/*.js), then calc.js and script.js.

   Adding a language:
     1. Copy lang/en.js to lang/<code>.js and translate the values (keep the keys and the {placeholders}).
     2. Add <script src="java script/lang/<code>.js"></script> to index.html, after lang/en.js.
     3. Add the file to LANGUAGE_FILES in tests/helpers.js and tests/i18n.test.js. tests/i18n.test.js then checks
        that no key or placeholder is missing.
   The language picker in Settings lists every registered language automatically.

   A right-to-left language (Arabic) passes { locale: "...", dir: "rtl" } to register(); the page then switches
   to right-to-left when that language is chosen (see dir() and applyLanguage in script.js).

   Text with a count has two keys: "<key>.one" and "<key>.other" (use tn()). A language with more plural forms
   than that (Arabic has "two" and "few") may add "<key>.two", "<key>.few", ... for the forms it needs; any form a
   language does not have falls back to "<key>.other".
   ========================================================================== */

(function () {
  const FALLBACK = "en";          // used for any key a language does not have
  const packs = {};               // code -> { name, locale, messages }
  let current = FALLBACK;

  // name is the language written in itself, so people can find it whatever language the app is in.
  function register(code, name, messages, options) {
    packs[code] = {
      name,
      locale: (options && options.locale) || code,
      dir: options && options.dir === "rtl" ? "rtl" : "ltr",
      messages,
    };
  }

  const has = (code) => Object.prototype.hasOwnProperty.call(packs, code);
  const language = () => current;
  const locale = () => (packs[current] ? packs[current].locale : "en-US");
  // "rtl" for a right-to-left language (Arabic), "ltr" for every other one.
  const dir = () => (packs[current] ? packs[current].dir : "ltr");
  const languages = () => Object.keys(packs).map((code) => ({ code, name: packs[code].name }));

  // Unknown codes (for example from a newer data file) fall back to English.
  function setLanguage(code) {
    current = has(code) ? code : FALLBACK;
    return current;
  }

  function lookup(key) {
    const own = packs[current] && packs[current].messages[key];
    if (own !== undefined) return own;
    const base = packs[FALLBACK] && packs[FALLBACK].messages[key];
    return base !== undefined ? base : key;
  }

  // In a right-to-left language, a value that holds Latin letters or digits (a product name, an amount, an invoice number)
  // (not a plain whole number) is set apart with Unicode isolation marks so it keeps its own order inside the Arabic sentence. Other languages
  // get the value exactly as given.
  const isolate = (value) => (packs[current] && packs[current].dir === "rtl" && /[A-Za-z0-9]/.test(value) && !/^\d+$/.test(value) && value.charAt(0) !== "\u2066" ? "\u2068" + value + "\u2069" : value);

  const fill = (text, params) =>
    text.replace(/\{(\w+)\}/g, (whole, name) => (params && params[name] !== undefined ? isolate(String(params[name])) : whole));

  function t(key, params) {
    return fill(lookup(key), params);
  }

  // Text with a count: picks "<key>.one" or "<key>.other" by the current language's plural rule
  // (English: only 1 is singular. French: 0 and 1 are singular). {n} is the count.
  // A language with more forms (Arabic: "two" for 2, "few" for 3 to 10) can add "<key>.two", "<key>.few", ...;
  // without such a key the form falls back to "<key>.other", so English and French are not affected.
  function tn(key, count, params) {
    const category = new Intl.PluralRules(locale()).select(count);
    const own = packs[current] && packs[current].messages;
    const extra = category !== "one" && category !== "other" && own && own[key + "." + category] !== undefined;
    const form = extra ? category : category === "one" ? "one" : "other";
    return t(key + "." + form, { ...params, n: count });
  }

  // The text of a key in one particular language, whichever language is shown now ("" when that language does not have it).
  // Used to search a stored value by its words in every language (a product type is stored as "PateAJoint" and shown as
  // "Pâte à joint", "Faience" / "Faïence" ...), without storing anything extra.
  function textIn(code, key) {
    const own = packs[code] && packs[code].messages[key];
    return own !== undefined ? own : "";
  }

  globalThis.I18n = { register, has, language, locale, dir, languages, setLanguage, t, tn, textIn };
})();

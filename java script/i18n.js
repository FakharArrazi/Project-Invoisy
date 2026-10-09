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

   Text with a count has two keys: "<key>.one" and "<key>.other" (use tn()).
   ========================================================================== */

(function () {
  const FALLBACK = "en";          // used for any key a language does not have
  const packs = {};               // code -> { name, locale, messages }
  let current = FALLBACK;

  // name is the language written in itself, so people can find it whatever language the app is in.
  function register(code, name, messages, options) {
    packs[code] = { name, locale: (options && options.locale) || code, messages };
  }

  const has = (code) => Object.prototype.hasOwnProperty.call(packs, code);
  const language = () => current;
  const locale = () => (packs[current] ? packs[current].locale : "en-US");
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

  const fill = (text, params) =>
    text.replace(/\{(\w+)\}/g, (whole, name) => (params && params[name] !== undefined ? String(params[name]) : whole));

  function t(key, params) {
    return fill(lookup(key), params);
  }

  // Text with a count: picks "<key>.one" or "<key>.other" by the current language's plural rule
  // (English: only 1 is singular. French: 0 and 1 are singular). {n} is the count.
  function tn(key, count, params) {
    const form = new Intl.PluralRules(locale()).select(count) === "one" ? "one" : "other";
    return t(key + "." + form, { ...params, n: count });
  }

  globalThis.I18n = { register, has, language, locale, languages, setLanguage, t, tn };
})();

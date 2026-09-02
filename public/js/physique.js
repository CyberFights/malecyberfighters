/* ============================================================
   physique.js — shared height / weight rules
   ------------------------------------------------------------
   ONE source of truth, used by both sides of the app:

     • the browser  → <script src="/js/physique.js"></script>
                      exposes window.Physique (+ legacy globals)
                      and fills every
                        <select data-physique-height>
                        <input  data-physique-weight>

     • the server   → require('./public/js/physique.js') in index.js
                      (validation + normalisation for
                       /api/register and /api/update-profile)

   HEIGHT
     Stored (and submitted) as a feet + inches display string,
     e.g. 5'11". The menu runs 3'5" (41 in) up to 8'0" (96 in)
     in one-inch steps, so there are 56 choices.

   WEIGHT
     Always pounds (lbs), stored as a whole number.
     Accepted range: 60 – 700 lbs.
============================================================ */

(function (factory) {
  "use strict";

  var api = factory();

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;              // Node / server (index.js)
  }

  if (typeof window !== "undefined") {
    window.Physique = api;

    // Legacy / convenience globals used by the page scripts
    window.heightOptions = api.heightOptions;
    window.populateHeightSelect = api.populateHeightSelect;
    window.normalizeHeight = api.normalizeHeight;
    window.normalizeWeight = api.normalizeWeight;
    window.isValidHeight = api.isValidHeight;
    window.isValidWeight = api.isValidWeight;
    window.formatHeight = api.formatHeight;
    window.formatWeight = api.formatWeight;
    window.physiqueSummary = api.physiqueSummary;
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", function () { api.populateAll(); });
    } else {
      api.populateAll();
    }
  }
})(function () {
  "use strict";

  var HEIGHT_MIN_INCHES = 41;   // 3'5"
  var HEIGHT_MAX_INCHES = 96;   // 8'0"
  var WEIGHT_MIN_LBS = 60;
  var WEIGHT_MAX_LBS = 700;

  /* ---------- conversions ---------------------------------- */

  // 71 -> 5'11"
  function inchesToHeight(inches) {
    var total = Math.round(Number(inches));
    if (!isFinite(total) || total < HEIGHT_MIN_INCHES || total > HEIGHT_MAX_INCHES) return "";
    var feet = Math.floor(total / 12);
    var rest = total - feet * 12;
    return feet + "'" + rest + '"';
  }

  // 5'11" / 5'11 / 5ft 11in / 71 -> 71 (NaN when it cannot be parsed)
  function heightToInches(value) {
    if (value === undefined || value === null) return NaN;
    var raw = String(value).trim().toLowerCase();
    if (!raw) return NaN;

    var match = raw.match(/^(\d{1,2})\s*(?:'|′|ft|feet)\s*(\d{1,2})?\s*(?:"|″|in|inch|inches)?$/);
    if (match) {
      var feet = Number(match[1]);
      var inches = match[2] === undefined ? 0 : Number(match[2]);
      if (!isFinite(feet) || !isFinite(inches) || inches > 11) return NaN;
      return feet * 12 + inches;
    }

    // A bare number is treated as total inches (and must still be in range).
    if (/^\d{1,3}(\.\d+)?$/.test(raw)) {
      var total = Number(raw);
      return total < HEIGHT_MIN_INCHES || total > HEIGHT_MAX_INCHES ? NaN : total;
    }

    return NaN;
  }

  // Canonical height string (e.g. 5'11") or "" when unset / out of range.
  function normalizeHeight(value) {
    if (value === undefined || value === null) return "";
    if (String(value).trim() === "") return "";
    var inches = heightToInches(value);
    if (!isFinite(inches)) return "";
    return inchesToHeight(inches);
  }

  // Whole pounds, or null when unset / out of range.
  function normalizeWeight(value) {
    if (value === undefined || value === null) return null;
    var raw = String(value).trim();
    if (raw === "") return null;
    var lbs = Number(raw);
    if (!isFinite(lbs)) return null;
    var rounded = Math.round(lbs);
    if (rounded < WEIGHT_MIN_LBS || rounded > WEIGHT_MAX_LBS) return null;
    return rounded;
  }

  function isValidHeight(value) {
    return normalizeHeight(value) !== "";
  }

  function isValidWeight(value) {
    return normalizeWeight(value) !== null;
  }

  /* ---------- menu ----------------------------------------- */

  // ["3'5\"", "3'6\"", ... "8'0\""]
  function heightOptions() {
    var out = [];
    for (var inches = HEIGHT_MIN_INCHES; inches <= HEIGHT_MAX_INCHES; inches++) {
      out.push(inchesToHeight(inches));
    }
    return out;
  }

  function populateHeightSelect(select, selected) {
    if (!select) return;

    var wanted = selected !== undefined && selected !== null ? selected : select.value;
    var normalized = normalizeHeight(wanted);

    // Already built and already showing the right value — nothing to do.
    if (select.dataset && select.dataset.physiqueReady === "1" && select.value === normalized) return;

    var placeholderText = (select.dataset && select.dataset.physiquePlaceholder) || "Select height";

    select.innerHTML = "";

    var placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = placeholderText;
    select.appendChild(placeholder);

    heightOptions().forEach(function (label) {
      var option = document.createElement("option");
      option.value = label;
      option.textContent = label;
      select.appendChild(option);
    });

    select.value = normalized || "";
    if (select.dataset) select.dataset.physiqueReady = "1";
  }

  function initWeightInput(input) {
    if (!input || (input.dataset && input.dataset.physiqueReady === "1")) return;
    input.setAttribute("type", "number");
    input.setAttribute("inputmode", "numeric");
    input.setAttribute("min", String(WEIGHT_MIN_LBS));
    input.setAttribute("max", String(WEIGHT_MAX_LBS));
    input.setAttribute("step", "1");
    if (!input.getAttribute("placeholder")) input.setAttribute("placeholder", "Weight (lbs)");
    if (input.dataset) input.dataset.physiqueReady = "1";
  }

  function populateAll(root) {
    if (typeof document === "undefined") return;

    var scope = root || document;

    var selects = scope.querySelectorAll("[data-physique-height]");
    Array.prototype.forEach.call(selects, function (select) {
      populateHeightSelect(select, select.dataset ? select.dataset.physiqueValue : undefined);
    });

    var weights = scope.querySelectorAll("[data-physique-weight]");
    Array.prototype.forEach.call(weights, function (input) {
      initWeightInput(input);
    });
  }

  /* ---------- display -------------------------------------- */

  function formatHeight(value) {
    return normalizeHeight(value) || "—";
  }

  function formatWeight(value) {
    var lbs = normalizeWeight(value);
    return lbs === null ? "—" : lbs + " lbs";
  }

  // "5'11\" • 185 lbs" — skips whichever half is missing.
  function physiqueSummary(height, weight) {
    var parts = [];
    var h = normalizeHeight(height);
    var w = normalizeWeight(weight);
    if (h) parts.push(h);
    if (w !== null) parts.push(w + " lbs");
    return parts.join(" • ");
  }

  return {
    HEIGHT_MIN_INCHES: HEIGHT_MIN_INCHES,
    HEIGHT_MAX_INCHES: HEIGHT_MAX_INCHES,
    WEIGHT_MIN_LBS: WEIGHT_MIN_LBS,
    WEIGHT_MAX_LBS: WEIGHT_MAX_LBS,
    inchesToHeight: inchesToHeight,
    heightToInches: heightToInches,
    normalizeHeight: normalizeHeight,
    normalizeWeight: normalizeWeight,
    isValidHeight: isValidHeight,
    isValidWeight: isValidWeight,
    heightOptions: heightOptions,
    populateHeightSelect: populateHeightSelect,
    initWeightInput: initWeightInput,
    populateAll: populateAll,
    formatHeight: formatHeight,
    formatWeight: formatWeight,
    physiqueSummary: physiqueSummary
  };
});

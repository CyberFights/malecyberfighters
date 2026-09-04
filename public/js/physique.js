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
    window.inchesToMeters = api.inchesToMeters;
    window.lbsToKg = api.lbsToKg;
    window.combatStats = api.combatStats;
    window.baselineStats = api.baselineStats;
    window.engineAtkMultiplier = api.engineAtkMultiplier;
    window.engineDefMultiplier = api.engineDefMultiplier;
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

  /* ---------- combat stats (dice match) ---------------------
     Each fighter's atk / def is derived from their physique:

       atk = height (m) × √weight (kg)
       def = (weight (kg) / height (m)) / 2

     Height arrives as a feet + inches string and weight as whole
     pounds; both are converted to metric first. The values are
     saved on the user document (userData) and pulled for the dice
     match calculations (see index.js /api/combat-stats and
     public/js/slash-commands.js).
  ------------------------------------------------------------ */

  var INCHES_PER_METER = 100 / 2.54;       // 39.3700787...
  var LBS_PER_KG = 1000 / 453.59237;       // 2.2046226...

  function round2(x) { return Math.round(x * 100) / 100; }
  function round3(x) { return Math.round(x * 1000) / 1000; }

  function inchesToMeters(inches) {
    var n = Number(inches);
    return isFinite(n) ? n / INCHES_PER_METER : NaN;
  }

  function lbsToKg(lbs) {
    var n = Number(lbs);
    return isFinite(n) ? n / LBS_PER_KG : NaN;
  }

  // { heightM, weightKg, atk, def } for the given physique, or null when
  // either half is missing / out of range (stats need both).
  function combatStats(height, weight) {
    var inches = heightToInches(height);
    var lbs = normalizeWeight(weight);
    if (!isFinite(inches) || lbs === null) return null;
    var meters = inchesToMeters(inches);
    var kg = lbsToKg(lbs);
    if (!(meters > 0) || !(kg > 0)) return null;
    return {
      heightM: round3(meters),
      weightKg: round3(kg),
      atk: round2(meters * Math.sqrt(kg)),
      def: round2((kg / meters) / 2)
    };
  }

  // The legacy dice engine runs on small multipliers (2.26 / 1.84). The
  // non-damage engine lines (submission recoil, teasing) scale the saved
  // stats back to that magnitude, using the baseline fighter as the
  // anchor: a 5'11" / 185 lb build maps to exactly the legacy values.
  var ENGINE_ATK_BASE = 2.26;
  var ENGINE_DEF_BASE = 1.84;
  var BASELINE_HEIGHT_INCHES = 71;   // 5'11"
  var BASELINE_WEIGHT_LBS = 185;

  var baselineStats = combatStats(inchesToHeight(BASELINE_HEIGHT_INCHES), BASELINE_WEIGHT_LBS);

  function engineAtkMultiplier(atk) {
    if (!baselineStats || !(atk > 0)) return null;
    return round2((atk / baselineStats.atk) * ENGINE_ATK_BASE);
  }

  function engineDefMultiplier(def) {
    if (!baselineStats || !(def > 0)) return null;
    return round2((def / baselineStats.def) * ENGINE_DEF_BASE);
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
    inchesToMeters: inchesToMeters,
    lbsToKg: lbsToKg,
    combatStats: combatStats,
    baselineStats: baselineStats,
    ENGINE_ATK_BASE: ENGINE_ATK_BASE,
    ENGINE_DEF_BASE: ENGINE_DEF_BASE,
    engineAtkMultiplier: engineAtkMultiplier,
    engineDefMultiplier: engineDefMultiplier,
    heightOptions: heightOptions,
    populateHeightSelect: populateHeightSelect,
    initWeightInput: initWeightInput,
    populateAll: populateAll,
    formatHeight: formatHeight,
    formatWeight: formatWeight,
    physiqueSummary: physiqueSummary
  };
});

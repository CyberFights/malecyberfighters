/* ============================================================
   match-styles.js — the match style catalogue
   ------------------------------------------------------------
   ONE source of truth, used by both sides of the app:

     • the browser  → <script src="/js/match-styles.js"></script>
                      exposes window.MatchStyles, which the
                      LFG board, the challenge form and the match
                      record UI build their pickers from

     • the server   → require('./public/js/match-styles.js')
                      (normalisation + validation for the LFG
                       status, challenge and match-record APIs)

   A "match style" answers "what kind of match are you looking
   for?" — the question the beginner's guide says to settle
   before the first bell. Styles are stored as stable ids
   ('pro', 'submission', ...), never labels, so a label can be
   renamed without rewriting a single stored document.

   Every entry also carries `aliases` — the words members
   actually type ("hp", "dice match", "roleplay") — so a picker
   that offers free-text filtering finds the style anyway.
============================================================ */

(function (factory) {
  "use strict";

  var api = factory();

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;              // Node / server (index.js)
  }

  if (typeof window !== "undefined") {
    window.MatchStyles = api;
  }
})(function () {
  "use strict";

  // ---------- THE CATALOGUE ----------
  // `id`     stable key stored in Mongo (never rename; rename `label` instead)
  // `label`  what the member sees
  // `icon`   emoji chip rendered next to the label
  // `aliases` words the search/filter box should also match
  var CATALOGUE = [
    {
      id: "pro",
      label: "Pro",
      icon: "🤼",
      blurb: "Classic back-and-forth pro match with moves, pins and near-falls.",
      aliases: ["pro wrestling", "prostyle", "pro style"]
    },
    {
      id: "submission",
      label: "Submission",
      icon: "🦵",
      blurb: "Hold-based match fought until somebody taps or gives.",
      aliases: ["sub", "submissions", "holds", "give up"]
    },
    {
      id: "dice",
      label: "Dice / HP",
      icon: "🎲",
      blurb: "A slash-command match on the HP engine (/move, /submit, /escape).",
      aliases: ["hp", "hp match", "dice match", "game", "engine"]
    },
    {
      id: "freeform",
      label: "Freeform",
      icon: "✍️",
      blurb: "No engine, no dice — the match is written out in chat.",
      aliases: ["rp", "roleplay", "role play", "written", "story"]
    },
    {
      id: "erotic",
      label: "Erotic",
      icon: "🔥",
      blurb: "Adult finish / stakes — talk terms first (18+ only).",
      aliases: ["nsfw", "xxx", "erotic wrestling", "stakes"]
    },
    {
      id: "tagteam",
      label: "Tag team",
      icon: "🤝",
      blurb: "Two-on-two — find a partner and another pair.",
      aliases: ["tag", "2v2", "tag team match"]
    }
  ];

  var byId = {};
  CATALOGUE.forEach(function (style) { byId[style.id] = style; });

  var MAX_STYLES = 3;

  /** The whole catalogue, in display order. */
  function catalogue() {
    return CATALOGUE.slice();
  }

  function lookup(id) {
    return byId[String(id || "")] || null;
  }

  function label(id) {
    var style = lookup(id);
    return style ? style.label : String(id || "");
  }

  function icon(id) {
    var style = lookup(id);
    return style ? style.icon : "·";
  }

  /**
   * Normalise a style selection coming off the wire.
   *
   * Unknown ids are dropped rather than rejected (a cached page from before a
   * style was retired must not stop an LFG status or a challenge from saving),
   * duplicates collapse, order is preserved, and the list is capped so a
   * profile cannot claim every style at once.
   *
   * @returns {{ ok: boolean, styles?: string[], error?: string }}
   */
  function normalize(value) {
    if (value == null) return { ok: true, styles: [] };
    if (typeof value === "string") {
      // "pro,dice" — what a compact client (or a URL query) would send.
      value = value.split(",").map(function (part) { return part.trim(); });
    }
    if (!Array.isArray(value)) {
      return { ok: false, error: "invalid_styles" };
    }

    var seen = {};
    var styles = [];
    for (var i = 0; i < value.length; i++) {
      var id = String(value[i] || "").trim().toLowerCase();
      if (!id || !byId[id] || seen[id]) continue;
      seen[id] = true;
      styles.push(id);
      if (styles.length >= MAX_STYLES) break;
    }

    return { ok: true, styles: styles };
  }

  /** Labels for a stored selection, in stored order. */
  function labels(ids) {
    return (Array.isArray(ids) ? ids : []).map(function (id) { return label(id); });
  }

  /** The words a style filter should match (id, label and aliases). */
  function searchText(id) {
    var style = lookup(id);
    if (!style) return String(id || "");
    return [style.id, style.label].concat(style.aliases || []).join(" ").toLowerCase();
  }

  return {
    MAX_STYLES: MAX_STYLES,
    catalogue: catalogue,
    lookup: lookup,
    label: label,
    icon: icon,
    labels: labels,
    normalize: normalize,
    searchText: searchText
  };
});

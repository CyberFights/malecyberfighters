/* ============================================================
   tags.js — the fighter tag catalogue
   ------------------------------------------------------------
   ONE source of truth, used by both sides of the app:

     • the browser  → <script src="/js/tags.js"></script>
                      exposes window.Tags, which the register /
                      edit-profile pickers and the roster search
                      are built from

     • the server   → require('./public/js/tags.js') in index.js
                      (normalisation + validation for
                       /api/register and /api/update-profile,
                       and the tag half of the roster search)

   A member picks tags in four categories:

     style     how the fighter works a match
     fetish    gear and kinks the fighter is into
     role      heel / jobber / face, and where they sit in a match
     position  what they are into between the ropes (or after)

   Storage: every category is a plain array of tag ids, e.g.

     tags: {
       style:    ['pro', 'submission'],
       fetish:   ['singlet', 'boots'],
       role:     ['heel'],
       position: ['top', 'dom']
     }

   Ids are stable strings — '''the label is what gets rendered, so a tag can
   be renamed without touching a single stored document. Unknown ids are
   dropped rather than rejected (a member holding a cached page from before
   a tag was retired must not have their save fail), and a category list is
   capped by `max` so the roster stays readable.

   Every tag also carries `aliases` — the words members actually type into
   the roster search ("vers", "babyface", "submission hold"). Searching
   matches against the id, the label and the aliases, so the search box
   finds people by what they are into, not just by their name.
============================================================ */

(function (factory) {
  "use strict";

  var api = factory();

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;              // Node / server (index.js)
  }

  if (typeof window !== "undefined") {
    window.Tags = api;
  }
})(function () {
  "use strict";

  // ---------- THE CATALOGUE ----------
  // `id`     stable key stored in Mongo (never rename; rename `label` instead)
  // `label`  what the member sees
  // `max`    how many of this category one fighter may carry
  var CATEGORIES = [
    {
      key: "style",
      label: "Wrestling Style",
      hint: "How your fighter works a match",
      max: 6,
      tags: [
        { id: "pro", label: "Pro Style", aliases: ["professional wrestling", "sports entertainment", "kayfabe", "storyline"] },
        { id: "submission", label: "Submission", aliases: ["submission wrestling", "grappling", "locks", "holds", "jiu jitsu", "judo"] },
        { id: "amateur", label: "Amateur", aliases: ["folkstyle", "collegiate", "scholastic", "olympic"] },
        { id: "freestyle", label: "Freestyle", aliases: ["freestyle wrestling", "leg attacks", "takedowns"] },
        { id: "greco-roman", label: "Greco-Roman", aliases: ["greco", "greco roman", "throws", "upper body"] },
        { id: "catch", label: "Catch", aliases: ["catch as catch can", "catch wrestling", "hooker", "shooter", "hooks"] },
        { id: "shoot", label: "Shoot Style", aliases: ["strong style", "stiff", "puroresu", "shoot"] },
        { id: "technical", label: "Technical", aliases: ["chain wrestling", "mat technician", "technician", "scientific"] },
        { id: "brawler", label: "Brawler", aliases: ["brawl", "fists", "strikes", "punches", "roughhouse"] },
        { id: "high-flyer", label: "High-Flyer", aliases: ["aerial", "cruiserweight", "top rope", "diving", "flyer"] },
        { id: "powerhouse", label: "Powerhouse", aliases: ["power", "big man", "hoss", "giant", "strength", "suplex"] },
        { id: "hardcore", label: "Hardcore", aliases: ["no dq", "no holds barred", "extreme", "weapons", "tables"] },
        { id: "tag-team", label: "Tag Team", aliases: ["tag", "duo", "partners", "six man"] },
        { id: "oil-wrestling", label: "Oil Wrestling", aliases: ["oil", "oiled", "greased", "turkish oil", "slippery"] }
      ]
    },
    {
      key: "fetish",
      label: "Gear & Fetish",
      hint: "The gear and the kinks your fighter brings",
      max: 10,
      tags: [
        { id: "singlet", label: "Singlet", aliases: ["singlets", "one piece", "straps"] },
        { id: "trunks", label: "Trunks", aliases: ["wrestling trunks", "short tights", "briefs style"] },
        { id: "speedo", label: "Speedo", aliases: ["briefs", "swim briefs", "posing trunks", "bikini briefs"] },
        { id: "tights", label: "Tights", aliases: ["leggings", "wrestling tights", "long tights", "spandex legs"] },
        { id: "boots", label: "Boots", aliases: ["wrestling boots", "ring boots", "laces", "boot licking"] },
        { id: "gloves", label: "Gloves", aliases: ["hand wraps", "boxing gloves", "fists"] },
        { id: "mask", label: "Mask", aliases: ["masked", "luchador", "hood", "masked wrestler"] },
        { id: "ring-gear", label: "Ring Gear", aliases: ["attire", "outfit", "costume", "gear"] },
        { id: "locker-room", label: "Locker Room", aliases: ["shower", "towel", "backstage", "lockerroom"] },
        { id: "body-oil", label: "Body Oil", aliases: ["oil", "oiled", "greased", "slippery", "shiny"] },
        { id: "sweat", label: "Sweat", aliases: ["perspiration", "sweaty", "wet", "glistening"] },
        { id: "leather", label: "Leather", aliases: ["leather gear", "harness", "chaps"] },
        { id: "lycra", label: "Lycra", aliases: ["spandex", "stretch gear", "shiny gear", "nylon"] },
        { id: "barefoot", label: "Barefoot", aliases: ["bare feet", "no boots", "barefoot wrestling"] },
        { id: "scissors", label: "Body Scissors", aliases: ["headscissors", "scissors", "leg hold", "scissor hold"] },
        { id: "bearhug", label: "Bearhug", aliases: ["bear hug", "crushing", "squeeze", "hug"] },
        { id: "sleepers", label: "Sleepers & Chokes", aliases: ["sleeper", "sleeper hold", "chokehold", "choke", "breath play"] },
        { id: "stomps", label: "Stomps", aliases: ["stomping", "boot stomps", "trampling", "curbstomp"] },
        { id: "gut-punches", label: "Gut Punches", aliases: ["gut punching", "body blows", "ab punches", "body shots"] },
        { id: "taunts", label: "Taunts", aliases: ["trash talk", "mic work", "posing", "flexing", "crowd work"] },
        { id: "humiliation", label: "Humiliation", aliases: ["humiliate", "embarrassment", "humiliation play", "degradation"] },
        { id: "ripped-gear", label: "Ripped Gear", aliases: ["ripping gear", "torn trunks", "shredded gear", "wardrobe"] },
        { id: "tickling", label: "Tickling", aliases: ["tickle", "ticklish", "feet tickling"] },
        { id: "size-difference", label: "Size Difference", aliases: ["height difference", "big vs small", "mismatch", "size kink"] }
      ]
    },
    {
      key: "role",
      label: "Heel / Jobber / Face",
      hint: "Where your fighter sits in the story of a match",
      max: 4,
      tags: [
        { id: "face", label: "Face", aliases: ["babyface", "good guy", "hero", "fan favourite"] },
        { id: "heel", label: "Heel", aliases: ["bad guy", "villain", "rulebreaker", "cheater", "cheating"] },
        { id: "tweener", label: "Tweener", aliases: ["in between", "anti hero", "grey area"] },
        { id: "jobber", label: "Jobber", aliases: ["enhancement talent", "squash jobber", "punchbag", "loser", "local talent"] },
        { id: "heel-jobber", label: "Heel Jobber", aliases: ["cocky jobber", "arrogant jobber", "boastful jobber", "bragging jobber"] },
        { id: "dominant", label: "Dominant", aliases: ["dominates", "in control", "dominance", "alpha"] },
        { id: "submissive", label: "Submissive", aliases: ["submissive wrestler", "sells", "selling", "underdog", "takes a beating"] },
        { id: "squash", label: "Squash Match", aliases: ["squash", "quick loss", "one sided", "destruction", "squashed"] },
        { id: "competitive", label: "Competitive", aliases: ["even match", "back and forth", "close match", "50 50"] },
        { id: "veteran", label: "Veteran", aliases: ["experience", "vet", "legend", "old school"] },
        { id: "rookie", label: "Rookie", aliases: ["new", "newcomer", "green", "debut"] },
        { id: "manager", label: "Manager", aliases: ["second", "valet", "ringside", "corner"] }
      ]
    },
    {
      key: "position",
      label: "Sexual Position",
      hint: "What your fighter is into out of the ring",
      max: 4,
      tags: [
        { id: "top", label: "Top", aliases: ["topping", "tops", "dom top"] },
        { id: "bottom", label: "Bottom", aliases: ["bottoming", "bottoms"] },
        { id: "versatile", label: "Versatile", aliases: ["vers", "verse", "both"] },
        { id: "vers-top", label: "Vers Top", aliases: ["versatile top", "verstop", "vers top"] },
        { id: "vers-bottom", label: "Vers Bottom", aliases: ["versatile bottom", "versbottom", "vers bottom"] },
        { id: "power-top", label: "Power Top", aliases: ["total top", "aggressive top", "alpha top"] },
        { id: "power-bottom", label: "Power Bottom", aliases: ["total bottom", "aggressive bottom"] },
        { id: "service-top", label: "Service Top", aliases: ["giving top", "oral top", "service"] },
        { id: "dom", label: "Dom", aliases: ["dominant", "master", "dom top", "dominance play"] },
        { id: "sub", label: "Sub", aliases: ["submissive", "boy", "slave", "submission play"] },
        { id: "switch", label: "Switch", aliases: ["both roles", "swap", "flip"] },
        { id: "side", label: "Side", aliases: ["no penetration", "oral only", "making out", "kissing", "hands"] }
      ]
    }
  ];

  // ---------- LOOKUPS ----------
  var CATEGORY_KEYS = CATEGORIES.map(function (category) { return category.key; });
  var BY_KEY = {};
  var BY_ID = {};

  CATEGORIES.forEach(function (category) {
    BY_KEY[category.key] = category;
    category.tags.forEach(function (tag) {
      BY_ID[tag.id] = {
        id: tag.id,
        label: tag.label,
        aliases: tag.aliases || [],
        category: category.key,
        categoryLabel: category.label,
        max: category.max
      };
    });
  });

  // The Mongo path of each category's array, for queries built from tag ids.
  function fieldFor(categoryKey) {
    return "tags." + categoryKey;
  }

  /** A selection with every category present, so callers never see undefined. */
  function emptySelection() {
    var selection = {};
    CATEGORY_KEYS.forEach(function (key) { selection[key] = []; });
    return selection;
  }

  /** `input` may be an id, a label, an alias — anything a human typed. */
  function lookup(value) {
    if (value == null) return null;
    var wanted = String(value).trim().toLowerCase();
    if (!wanted) return null;
    if (BY_ID[wanted]) return BY_ID[wanted];

    var found = null;
    Object.keys(BY_ID).some(function (id) {
      var tag = BY_ID[id];
      var words = [tag.label.toLowerCase()].concat(tag.aliases.map(function (alias) {
        return String(alias).toLowerCase();
      }));
      if (words.indexOf(wanted) !== -1) {
        found = tag;
        return true;
      }
      return false;
    });
    return found;
  }

  /**
   * Normalise one category list: drop anything that is not a string, drop
   * ids that are not in the catalogue, move a tag that arrived in the wrong
   * category to the one it belongs to, remove duplicates and cut the list
   * down to the category's `max`.
   *
   * Returns { list, invalid } — `invalid` counts entries that were not a
   * usable id, so a caller that cares can report them.
   */
  function normalizeList(value) {
    if (value == null) return { list: [], invalid: 0 };

    var raw = Array.isArray(value) ? value : [value];
    var chosen = {};
    var invalid = 0;

    raw.forEach(function (entry) {
      if (typeof entry !== "string") {
        invalid += 1;
        return;
      }
      var tag = lookup(entry);
      if (!tag) {
        // Unknown id: a tag that was retired, or a typo. Skipped on purpose.
        if (String(entry).trim()) invalid += 1;
        return;
      }
      chosen[tag.id] = true;
    });

    // Walked in catalogue order (not the order the client sent) so two
    // members who picked the same tags render them the same way, and each
    // category's own `max` is applied as it goes.
    var list = [];
    var used = {};
    CATEGORY_KEYS.forEach(function (key) { used[key] = 0; });

    CATEGORIES.forEach(function (category) {
      category.tags.forEach(function (tag) {
        var entry = BY_ID[tag.id];
        if (!chosen[entry.id]) return;
        if (used[entry.category] >= BY_KEY[entry.category].max) return;
        used[entry.category] += 1;
        list.push(entry.id);
      });
    });

    return { list: list, invalid: invalid };
  }

  /**
   * Normalise a whole selection.
   *
   * Accepts the object shape used on the wire:
   *   { style: ['pro'], fetish: ['singlet'], role: [], position: ['top'] }
   * or a flat array of ids, which is filed into the right categories.
   *
   * Returns { ok: true, tags } — `tags` always has all four categories — or
   * { ok: false, error: 'invalid_tags' } when the shape itself is wrong
   * (a non-object, an unknown category key, a category that is not a list).
   */
  function normalize(input) {
    if (input == null) return { ok: true, tags: emptySelection() };

    var source = input;

    if (Array.isArray(input)) {
      source = {};
      for (var i = 0; i < input.length; i += 1) {
        if (typeof input[i] !== "string") return { ok: false, error: "invalid_tags" };
        var listed = lookup(input[i]);
        if (!listed) continue;   // an unknown id in a flat list is dropped like any other
        source[listed.category] = (source[listed.category] || []).concat([listed.id]);
      }
    }

    if (typeof source !== "object" || Array.isArray(source)) {
      return { ok: false, error: "invalid_tags" };
    }

    var keys = Object.keys(source);
    for (var k = 0; k < keys.length; k += 1) {
      var key = keys[k];
      if (CATEGORY_KEYS.indexOf(key) === -1) return { ok: false, error: "invalid_tags" };

      var value = source[key];
      if (value == null) continue;
      if (!Array.isArray(value) && typeof value !== "string") return { ok: false, error: "invalid_tags" };

      // A list of tag ids is the only thing a client may send. Something that
      // is not even a string is a client bug, not a retired tag, so it is
      // reported rather than quietly dropped.
      var list = Array.isArray(value) ? value : [value];
      for (var j = 0; j < list.length; j += 1) {
        if (typeof list[j] !== "string") return { ok: false, error: "invalid_tags" };
      }
    }

    return { ok: true, tags: selectionFrom(source) };
  }

  /**
   * The tolerant read used for values already stored on a user document: no
   * shape errors are possible, everything unusable is simply dropped.
   */
  function selectionFrom(value) {
    var selection = emptySelection();
    if (!value || typeof value !== "object" || Array.isArray(value)) return selection;

    CATEGORY_KEYS.forEach(function (key) {
      var normalized = normalizeList(value[key]);
      // A tag that arrived in the wrong bucket is filed by where it belongs.
      normalized.list.forEach(function (id) {
        var tag = BY_ID[id];
        if (tag && selection[tag.category].indexOf(id) === -1) selection[tag.category].push(id);
      });
    });

    // The per-category caps are enforced while walking the catalogue, so a
    // hand-edited document cannot exceed them either.
    CATEGORY_KEYS.forEach(function (key) {
      var cap = BY_KEY[key].max;
      if (selection[key].length > cap) selection[key] = selection[key].slice(0, cap);
    });

    return order(selection);
  }

  /** Re-emit a selection with every category present, in catalogue order. */
  function order(selection) {
    var source = selection && typeof selection === "object" ? selection : {};
    var ordered = emptySelection();

    CATEGORIES.forEach(function (category) {
      var chosen = {};
      normalizeList(source[category.key]).list.forEach(function (id) {
        chosen[id] = true;
      });
      category.tags.forEach(function (tag) {
        if (chosen[tag.id] && ordered[category.key].length < category.max) {
          ordered[category.key].push(tag.id);
        }
      });
    });

    return ordered;
  }

  /** Flat list of ids, in catalogue order. */
  function ids(selection) {
    var normalized = order(selection);
    var flat = [];
    CATEGORY_KEYS.forEach(function (key) {
      flat = flat.concat(normalized[key]);
    });
    return flat;
  }

  function count(selection) {
    return ids(selection).length;
  }

  function has(selection, tagId) {
    return ids(selection).indexOf(tagId) !== -1;
  }

  /**
   * Display entries for a selection: [{ id, label, category, categoryLabel }]
   * — unknown ids are dropped, so a retired tag renders as nothing at all.
   */
  function entries(selection) {
    return ids(selection).map(function (id) { return BY_ID[id]; }).filter(Boolean);
  }

  function labels(selection) {
    return entries(selection).map(function (tag) { return tag.label; });
  }

  /**
   * Everything searchable about a selection, as one lower-case string:
   * ids, labels and aliases. Used by the roster search on both sides.
   */
  function searchText(selection) {
    return entries(selection).map(function (tag) {
      return [tag.id, tag.label.toLowerCase()].concat(tag.aliases.map(function (alias) {
        return String(alias).toLowerCase();
      })).join(" ");
    }).join(" ");
  }

  /** Does this selection match a roster search — "heel", "vers", "singlet"? */
  function matches(selection, query) {
    var wanted = String(query == null ? "" : query).trim().toLowerCase();
    if (!wanted) return true;
    return searchText(selection).indexOf(wanted) !== -1;
  }

  /**
   * The tag ids a free-text roster search should match. Both the query and
   * the tag words are matched with `includes`, so "vers" finds Vers, Vers
   * Top and Vers Bottom while "jobber" finds Jobber and Heel Jobber.
   */
  function matchingTagIds(query) {
    var wanted = String(query == null ? "" : query).trim().toLowerCase();
    if (!wanted) return [];

    var found = [];
    Object.keys(BY_ID).forEach(function (id) {
      var tag = BY_ID[id];
      var hit = tag.id.indexOf(wanted) !== -1
        || tag.label.toLowerCase().indexOf(wanted) !== -1
        || tag.aliases.some(function (alias) {
          return String(alias).toLowerCase().indexOf(wanted) !== -1;
        });
      if (hit) found.push(id);
    });
    return found;
  }

  /**
   * A Mongo condition matching members who carry any (or all) of `tagIds`.
   * Returns {} when there is nothing to filter on, so it can be merged into
   * a query unconditionally.
   */
  function mongoFilter(tagIds, mode) {
    var wanted = (Array.isArray(tagIds) ? tagIds : []).filter(function (id) { return !!BY_ID[id]; });
    if (!wanted.length) return {};

    var clauses = wanted.map(function (id) {
      return { [fieldFor(BY_ID[id].category)]: id };
    });

    if (String(mode || "").toLowerCase() === "all") return { $and: clauses };
    return { $or: clauses };
  }

  /** Parse a comma separated tag list from a query string. */
  function parseTagList(value) {
    return String(value == null ? "" : value)
      .split(",")
      .map(function (entry) { return entry.trim().toLowerCase(); })
      .filter(Boolean);
  }

  /** The catalogue as the picker renders it (cloned, so callers cannot mutate it). */
  function catalogue() {
    return CATEGORIES.map(function (category) {
      return {
        key: category.key,
        label: category.label,
        hint: category.hint,
        max: category.max,
        tags: category.tags.map(function (tag) {
          return { id: tag.id, label: tag.label, aliases: tag.aliases.slice() };
        })
      };
    });
  }

  return {
    CATEGORIES: CATEGORIES,
    categoryKeys: CATEGORY_KEYS,
    catalogue: catalogue,
    emptySelection: emptySelection,
    lookup: lookup,
    normalize: normalize,
    selection: selectionFrom,
    order: order,
    ids: ids,
    count: count,
    has: has,
    entries: entries,
    labels: labels,
    searchText: searchText,
    matches: matches,
    matchingTagIds: matchingTagIds,
    mongoFilter: mongoFilter,
    parseTagList: parseTagList,
    fieldFor: fieldFor
  };
});

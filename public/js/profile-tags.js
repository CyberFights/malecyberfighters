/* ============================================================
   profile-tags.js — tag pickers, tag chips and the roster's tag search
   ------------------------------------------------------------
   The catalogue itself lives in /js/tags.js (window.Tags), which is also
   what index.js requires server-side, so a tag only ever has to be added
   in one place.

   This file is the presentation layer:

     ProfileTags.renderPicker(container, { selected, onChange, idPrefix })
        builds the four checkbox groups used by the register and
        edit-profile modals.

     ProfileTags.pickerSelection(container)
        reads the current pick back out — always a normalised
        { style, fetish, role, position } selection.

     ProfileTags.renderChips(container, selection, { empty, categories })
        the read-only chips a roster row / profile shows.

     ProfileTags.tagSummary(selection, max)
        "Heel · Jobber · +3" — the one-line form for tight rows.

     ProfileTags.filterRoster(users, { query, tag })
        the roster search itself: names AND tags, plus an exact tag filter.
        Used by both chat.js (desktop, mobile2) and mobile.js so the two
        clients can never disagree about what "heel" matches.

     ProfileTags.fillTagFilter(select, { keepValue })
        fills a <select> with every tag, grouped by category.
============================================================ */

(function () {
  "use strict";

  var Tags = typeof window !== "undefined" ? window.Tags : null;

  function tagsApi() {
    return Tags || (typeof window !== "undefined" ? window.Tags : null);
  }

  function emptySelection() {
    var api = tagsApi();
    return api ? api.emptySelection() : { style: [], fetish: [], role: [], position: [] };
  }

  /** The selection stored on a user record, in the normalised shape. */
  function selectionOf(user) {
    var api = tagsApi();
    if (!api) return emptySelection();
    return api.selection(user && user.tags);
  }

  function countOf(selection) {
    var api = tagsApi();
    if (!api) return 0;
    return api.count(selection);
  }

  /* ------------------------------------------------------------
     Picker
  ------------------------------------------------------------ */

  /**
   * Build the picker inside `container`.
   *
   * options.selected   current selection (a user record's `tags` shape)
   * options.onChange   called with the normalised selection on every change
   * options.idPrefix   so two modals on one page never share input ids
   */
  function renderPicker(container, options) {
    var opts = options || {};
    var api = tagsApi();
    if (!container) return null;

    container.classList.add("tag-picker");

    if (!api) {
      container.textContent = "Tag list unavailable — reload the page to try again.";
      return null;
    }

    var state = { selected: api.order(opts.selected || {}) };

    function currentSelection() {
      return state.selected || emptySelection();
    }

    function emit() {
      if (typeof opts.onChange === "function") opts.onChange(currentSelection());
    }

    function buildGroup(category) {
      var group = document.createElement("fieldset");
      group.className = "tag-group";
      group.dataset.category = category.key;

      var legend = document.createElement("legend");
      legend.className = "tag-group-label";
      legend.textContent = category.label;

      var count = document.createElement("span");
      count.className = "tag-group-count";

      var head = document.createElement("div");
      head.className = "tag-group-head";
      head.appendChild(legend);
      head.appendChild(count);

      var hint = document.createElement("div");
      hint.className = "tag-group-hint";
      hint.textContent = category.hint;

      var options_ = document.createElement("div");
      options_.className = "tag-options";

      category.tags.forEach(function (tag) {
        var label = document.createElement("label");
        label.className = "tag-chip tag-option";
        label.dataset.tag = tag.id;
        label.dataset.category = category.key;

        var input = document.createElement("input");
        input.type = "checkbox";
        input.value = tag.id;
        input.name = (opts.idPrefix || "tags") + "-" + category.key;
        if (container.id) input.id = container.id + "-" + tag.id;

        label.appendChild(input);

        var text = document.createElement("span");
        text.textContent = tag.label;
        label.appendChild(text);

        input.addEventListener("change", function () {
          var selection = currentSelection();
          var list = selection[category.key].slice();

          if (input.checked) {
            if (list.indexOf(tag.id) === -1 && list.length < category.max) list.push(tag.id);
          } else {
            list = list.filter(function (id) { return id !== tag.id; });
          }

          selection[category.key] = list;
          state.selected = api.order(selection);
          sync();
          emit();
        });

        options_.appendChild(label);
      });

      group.appendChild(head);
      group.appendChild(hint);
      group.appendChild(options_);

      return group;
    }

    /** Reflect the selection: checked boxes, counts, and the caps. */
    function sync() {
      var selection = currentSelection();

      api.CATEGORIES.forEach(function (category) {
        var group = container.querySelector('.tag-group[data-category="' + category.key + '"]');
        if (!group) return;

        var chosen = selection[category.key] || [];
        var count = group.querySelector(".tag-group-count");
        if (count) {
          count.textContent = chosen.length + " / " + category.max;
          count.classList.toggle("is-full", chosen.length >= category.max);
        }

        group.querySelectorAll("input[type=checkbox]").forEach(function (input) {
          var on = chosen.indexOf(input.value) !== -1;
          // Re-render from the state, so a hand-edited checkbox cannot slip
          // past the per-category cap.
          input.checked = on;
          input.disabled = !on && chosen.length >= category.max;
          var chip = input.closest(".tag-chip");
          if (chip) chip.classList.toggle("is-on", on);
        });
      });
    }

    container.replaceChildren();
    api.catalogue().forEach(function (category) {
      container.appendChild(buildGroup(category));
    });
    sync();

    var controller = {
      getSelection: function () { return currentSelection(); },
      setSelection: function (value) {
        state.selected = api.order(value || {});
        sync();
      },
      clear: function () {
        state.selected = emptySelection();
        sync();
        emit();
      }
    };

    container._tagPicker = controller;
    return controller;
  }

  /** The selection currently ticked in `container` (or {} when not built). */
  function pickerSelection(container) {
    if (!container) return emptySelection();
    if (container._tagPicker) return container._tagPicker.getSelection();

    // No controller (the picker was never built, or the page has no script):
    // read whatever is ticked, so a save still sends what the member chose.
    var api = tagsApi();
    var selection = emptySelection();
    if (!api) return selection;

    container.querySelectorAll("input[type=checkbox]:checked").forEach(function (input) {
      var tag = api.lookup(input.value);
      if (tag && selection[tag.category].indexOf(tag.id) === -1) {
        selection[tag.category].push(tag.id);
      }
    });
    return api.order(selection);
  }

  /* ------------------------------------------------------------
     Chips
  ------------------------------------------------------------ */

  /**
   * Read-only chips. `opts.empty` is shown when there is nothing to render;
   * pass null to leave the container empty instead.
   */
  function renderChips(container, selection, opts) {
    var options = opts || {};
    var api = tagsApi();
    if (!container) return 0;

    container.replaceChildren();
    container.classList.add("tag-list");

    var entries = api ? api.entries(selection) : [];
    if (options.categories && options.categories.length) {
      entries = entries.filter(function (tag) {
        return options.categories.indexOf(tag.category) !== -1;
      });
    }

    if (!entries.length) {
      if (options.empty) {
        var note = document.createElement("span");
        note.className = "small muted tag-empty";
        note.textContent = options.empty;
        container.appendChild(note);
      }
      return 0;
    }

    entries.forEach(function (tag) {
      var chip = document.createElement("span");
      chip.className = "tag-chip tag-chip-static";
      chip.dataset.tag = tag.id;
      chip.dataset.category = tag.category;
      chip.title = tag.categoryLabel;
      chip.textContent = tag.label;
      container.appendChild(chip);
    });

    return entries.length;
  }

  /** "Heel · Jobber · +3" for contexts with no room for chips. */
  function tagSummary(selection, max) {
    var api = tagsApi();
    if (!api) return "";
    var labels = api.labels(selection);
    if (!labels.length) return "";

    var limit = max == null ? 3 : max;
    if (labels.length <= limit) return labels.join(" · ");
    return labels.slice(0, limit).join(" · ") + " +" + (labels.length - limit);
  }

  /* ------------------------------------------------------------
     Roster search
  ------------------------------------------------------------ */

  /**
   * Filter the roster by free text and/or one exact tag.
   *
   * `query` matches a username, a display name, or any of the member's tags
   * and their aliases — so "vers" finds both Vers Top and Bottom, and
   * "singlet" finds the members who ticked Singlet. `tag` is an exact tag id,
   * which is what the tag dropdown sends.
   */
  function filterRoster(users, options) {
    var opts = options || {};
    var api = tagsApi();
    var query = String(opts.query == null ? "" : opts.query).trim().toLowerCase();
    var tag = String(opts.tag == null ? "" : opts.tag).trim();

    return (users || []).filter(function (user) {
      if (!user) return false;

      if (tag) {
        var has = api ? api.has(user.tags, tag) : false;
        if (!has) return false;
      }

      if (!query) return true;

      if (String(user.username || "").toLowerCase().indexOf(query) !== -1) return true;
      if (String(user.display || "").toLowerCase().indexOf(query) !== -1) return true;

      return api ? api.matches(user.tags, query) : false;
    });
  }

  /** Every tag, as <optgroup>s, on a "All tags" <select>. */
  function fillTagFilter(select, options) {
    if (!select) return;
    var opts = options || {};
    var api = tagsApi();
    if (!api) return;

    var previous = opts.keepValue ? select.value : "";

    select.replaceChildren();

    var any = document.createElement("option");
    any.value = "";
    any.textContent = opts.anyLabel || "All tags";
    select.appendChild(any);

    api.catalogue().forEach(function (category) {
      var group = document.createElement("optgroup");
      group.label = category.label;

      category.tags.forEach(function (tag) {
        var option = document.createElement("option");
        option.value = tag.id;
        option.textContent = tag.label;
        group.appendChild(option);
      });

      select.appendChild(group);
    });

    if (previous && select.querySelector('option[value="' + previous + '"]')) {
      select.value = previous;
    }
  }

  window.ProfileTags = {
    selectionOf: selectionOf,
    countOf: countOf,
    renderPicker: renderPicker,
    pickerSelection: pickerSelection,
    renderChips: renderChips,
    tagSummary: tagSummary,
    filterRoster: filterRoster,
    fillTagFilter: fillTagFilter
  };
})();

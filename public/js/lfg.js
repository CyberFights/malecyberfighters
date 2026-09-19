/* ============================================================
   lfg.js — the "Find a Match" board (client)
   ------------------------------------------------------------
   A live list of everyone who has flipped their "looking for a
   match" toggle, with the styles they want and a one-line note.
   The server keeps the board in sync (socket event lfgBoard) and
   /api/lfg/status is the toggle itself.

   Depends on features-core.js (window.MCF) and MatchStyles
   (public/js/match-styles.js). Opens the challenge form via
   MCFChallenges when that module is present.
============================================================ */
(function () {
  'use strict';

  if (!window.MCF) return;

  var boardEl = null;        // the list inside the open popup
  var myState = { looking: false, styles: [], note: '' };

  function socket() {
    return window.socket || null;
  }

  /* ---------- my toggle ---------- */

  function styleChips(selected, interactive) {
    var catalogue = (window.MatchStyles ? window.MatchStyles.catalogue() : []);
    return catalogue.map(function (style) {
      var on = selected.indexOf(style.id) !== -1;
      return (
        '<button type="button" class="mcf-chip' + (on ? ' mcf-chip-on' : '') +
        (interactive ? ' mcf-lfg-style' : '') +
        '" data-style="' + style.id + '"' + (interactive ? '' : ' disabled') +
        ' title="' + MCF.escapeHtml(style.blurb) + '">' +
        style.icon + ' ' + MCF.escapeHtml(style.label) +
        '</button>'
      );
    }).join('');
  }

  function renderMine(container) {
    var s = MCF.session();
    if (!s) {
      container.innerHTML = '<p class="small muted">Sign in to say you are looking for a match.</p>';
      return;
    }

    container.innerHTML =
      '<label class="mcf-toggle-row">' +
        '<input type="checkbox" id="mcfLfgToggle"' + (myState.looking ? ' checked' : '') + '>' +
        '<span>I\'m looking for a match right now</span>' +
      '</label>' +
      '<div class="mcf-lfg-styles">' + styleChips(myState.styles, true) + '</div>' +
      '<input type="text" id="mcfLfgNote" class="mcf-input" maxlength="140" ' +
        'placeholder="One line about what you\'re up for (optional)" value="' + MCF.escapeHtml(myState.note) + '">' +
      '<div class="mcf-row-actions">' +
        '<button type="button" class="small-btn" id="mcfLfgSave">Save status</button>' +
        '<span id="mcfLfgStatus" class="small muted"></span>' +
      '</div>';

    container.querySelectorAll('.mcf-lfg-style').forEach(function (chip) {
      chip.addEventListener('click', function () {
        var id = chip.dataset.style;
        var index = myState.styles.indexOf(id);
        if (index === -1) {
          // The catalogue caps a selection server-side; mirror that here so
          // the chips never promise more than the API will store.
          if (myState.styles.length >= (window.MatchStyles ? window.MatchStyles.MAX_STYLES : 3)) {
            MCF.toast('Pick at most ' + (window.MatchStyles ? window.MatchStyles.MAX_STYLES : 3) + ' styles', 'error');
            return;
          }
          myState.styles.push(id);
        } else {
          myState.styles.splice(index, 1);
        }
        container.querySelectorAll('.mcf-lfg-style').forEach(function (c) {
          c.classList.toggle('mcf-chip-on', myState.styles.indexOf(c.dataset.style) !== -1);
        });
      });
    });

    container.querySelector('#mcfLfgToggle').addEventListener('change', function (e) {
      myState.looking = e.target.checked;
    });
    container.querySelector('#mcfLfgNote').addEventListener('input', function (e) {
      myState.note = e.target.value;
    });
    container.querySelector('#mcfLfgSave').addEventListener('click', saveStatus);
  }

  async function saveStatus() {
    var noteEl = document.getElementById('mcfLfgNote');
    var statusEl = document.getElementById('mcfLfgStatus');
    if (noteEl) myState.note = noteEl.value;
    if (statusEl) statusEl.textContent = 'Saving…';

    var data = await MCF.postJSON('/api/lfg/status', {
      looking: myState.looking,
      styles: myState.styles,
      note: myState.note
    });

    if (!data || !data.ok) {
      if (statusEl) statusEl.textContent = 'Could not save.';
      MCF.toast('Could not save your LFG status', 'error');
      return;
    }
    myState = { looking: data.status.looking, styles: data.status.styles, note: data.status.note };
    if (statusEl) statusEl.textContent = myState.looking ? 'You are on the board.' : 'You are off the board.';
    renderBadge();
  }

  /* ---------- the board ---------- */

  function entryRow(entry) {
    var s = MCF.session();
    var mine = s && entry.username === s.username;

    var presence = entry.online
      ? '<span class="mcf-dot mcf-dot-on"></span> online'
      : '<span class="mcf-dot"></span> ' + (entry.lastSeenAt ? 'active ' + MCF.agoLabel(entry.lastSeenAt) : 'offline');

    var row = document.createElement('div');
    row.className = 'mcf-lfg-entry';
    row.innerHTML =
      '<div class="mcf-lfg-avatar">' + avatarHtml(entry) + '</div>' +
      '<div class="mcf-lfg-main">' +
        '<div class="mcf-lfg-name">' + MCF.escapeHtml(entry.display || entry.username) +
          ' <span class="small muted">@' + MCF.escapeHtml(entry.username) + '</span></div>' +
        '<div class="mcf-lfg-presence small">' + presence + '</div>' +
        '<div class="mcf-lfg-chips">' + styleChips(entry.styles || [], false) + '</div>' +
        (entry.note ? '<div class="mcf-lfg-note small">' + MCF.escapeHtml(entry.note) + '</div>' : '') +
      '</div>' +
      '<div class="mcf-lfg-actions">' +
        (mine
          ? '<span class="small muted">This is you</span>'
          : '<button type="button" class="small-btn mcf-lfg-challenge" data-user="' + MCF.escapeHtml(entry.username) + '">Challenge</button>' +
            '<button type="button" class="small-btn ghost mcf-lfg-dm" data-user="' + MCF.escapeHtml(entry.username) + '">Message</button>') +
      '</div>';

    var challengeBtn = row.querySelector('.mcf-lfg-challenge');
    if (challengeBtn) {
      challengeBtn.addEventListener('click', function () {
        if (window.MCFChallenges && window.MCFChallenges.open) {
          window.MCFChallenges.open(entry.username, { styles: entry.styles || [] });
        } else {
          MCF.toast('The challenge form is still loading — try again in a moment');
        }
      });
    }
    var dmBtn = row.querySelector('.mcf-lfg-dm');
    if (dmBtn) {
      dmBtn.addEventListener('click', function () {
        if (typeof window.openPrivateWindow === 'function') window.openPrivateWindow(entry.username);
      });
    }

    return row;
  }

  function avatarHtml(user) {
    if (user.imageUrl) {
      return '<img class="mcf-avatar" src="' + MCF.escapeHtml(user.imageUrl) + '" alt="" loading="lazy">';
    }
    var initials = String(user.display || user.username || '?').split(/\s+/)
      .map(function (part) { return part[0]; }).join('').slice(0, 2).toUpperCase();
    return '<div class="mcf-avatar mcf-avatar-fallback">' + MCF.escapeHtml(initials) + '</div>';
  }

  function renderBoard(entries) {
    if (!boardEl) return;
    boardEl.innerHTML = '';

    if (!entries || !entries.length) {
      boardEl.innerHTML =
        '<p class="small muted mcf-lfg-empty">Nobody is looking right now. Flip your own toggle above — you only have to be first.</p>';
      return;
    }

    entries.forEach(function (entry) {
      boardEl.appendChild(entryRow(entry));
    });
  }

  /* ---------- badge on the button ---------- */

  function renderBadge() {
    var btn = document.getElementById('btnLfg');
    if (!btn) return;
    var badge = btn.querySelector('.mcf-btn-badge');
    if (myState.looking && !badge) {
      var el = document.createElement('span');
      el.className = 'mcf-btn-badge';
      el.textContent = '•';
      btn.appendChild(el);
    } else if (!myState.looking && badge) {
      badge.remove();
    }
  }

  /* ---------- open ---------- */

  async function open() {
    var box = MCF.popup({ title: 'Find a Match', label: 'Looking for a match board', wide: true });
    boardEl = box.body;

    var mine = document.createElement('div');
    mine.className = 'mcf-lfg-mine';
    box.body.appendChild(mine);

    var heading = document.createElement('div');
    heading.className = 'mcf-lfg-board-heading';
    heading.innerHTML = '<h4>Fighters looking right now</h4>';
    var list = document.createElement('div');
    list.className = 'mcf-lfg-board';
    box.body.appendChild(heading);
    box.body.appendChild(list);
    boardEl = list;

    renderMine(mine);

    var data = await MCF.getJSON('/api/lfg/board');
    if (data && data.ok) {
      // Seed my own toggle from the board response when the member is on it.
      var s = MCF.session();
      var mineEntry = s ? (data.entries || []).find(function (e) { return e.username === s.username; }) : null;
      if (mineEntry) {
        myState = { looking: true, styles: mineEntry.styles || [], note: mineEntry.note || '' };
        renderMine(mine);
      }
      renderBoard(data.entries);
    } else {
      renderBoard([]);
    }
    renderBadge();
  }

  /* ---------- wire up ---------- */

  function bind() {
    // The button exists on both pages as #btnLfg (twice on the desktop page —
    // once per layout — and utils.js' getElementById proxy fans listeners out).
    var btn = document.getElementById('btnLfg');
    if (btn) btn.addEventListener('click', open);

    var s = socket();
    if (s) {
      s.on('lfgBoard', function (entries) {
        renderBoard(entries);
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }

  window.MCFLfg = { open: open };
})();

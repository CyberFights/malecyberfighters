/* ============================================================
   preferences.js — theme, text size, language, notification
   switches, quiet hours, room mutes
   ------------------------------------------------------------
   One window for the settings a member actually reaches for:

     • Appearance — dark (the site's default) or light theme, and
       the chat text size (accessibility: not everyone can read
       13px comfortably).
     • Language — the interface translation (i18n.js applies it).
     • Notifications — per-kind push switches (dm, mentions,
       stories, forums, matches, challenges) and a quiet window
       ("nothing between 22:00 and 08:00"), saved server-side via
       /api/notification-prefs.
     • Rooms — mute the rooms that should never badge or beep
       again (kept in localStorage: it is a per-device annoyance
       setting, not a profile fact).

   Depends on features-core.js.
============================================================ */
(function () {
  'use strict';

  if (!window.MCF) return;

  var THEME_KEY = 'mcf_theme';
  var FONT_KEY = 'mcf_font';
  var LANG_KEY = 'mcf_lang';
  var MUTED_ROOMS_KEY = 'mcf_muted_rooms';

  var state = {
    theme: 'dark',
    font: 'md',
    prefs: null,       // notification prefs once loaded
    quietHours: null,
    mutedRooms: []
  };

  function read(key, fallback) {
    try { return localStorage.getItem(key) || fallback; } catch (e) { return fallback; }
  }
  function write(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* private mode etc. */ }
  }

  /* ---------- theme + text size ---------- */

  function applyTheme(theme) {
    state.theme = theme === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.mcfTheme = state.theme;
  }

  function applyFont(scale) {
    state.font = ['sm', 'md', 'lg', 'xl'].indexOf(scale) !== -1 ? scale : 'md';
    document.documentElement.dataset.mcfFont = state.font;
  }

  /* ---------- room mutes ---------- */

  function loadMutedRooms() {
    try {
      var parsed = JSON.parse(localStorage.getItem(MUTED_ROOMS_KEY) || '[]');
      state.mutedRooms = Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      state.mutedRooms = [];
    }
  }

  function saveMutedRooms() {
    write(MUTED_ROOMS_KEY, JSON.stringify(state.mutedRooms));
  }

  function isRoomMuted(roomId) {
    return !!roomId && state.mutedRooms.indexOf(String(roomId)) !== -1;
  }

  function toggleRoomMute(roomId) {
    roomId = String(roomId || '');
    if (!roomId) return;
    var index = state.mutedRooms.indexOf(roomId);
    if (index === -1) state.mutedRooms.push(roomId);
    else state.mutedRooms.splice(index, 1);
    saveMutedRooms();
  }

  /* ---------- the window ---------- */

  var knownRooms = {}; // roomId → name, kept fresh from the socket

  function section(titleText) {
    var heading = document.createElement('h4');
    heading.className = 'mcf-section-heading';
    heading.textContent = titleText;
    return heading;
  }

  async function open() {
    var s = MCF.session();
    if (!s) {
      MCF.toast('Sign in to change your preferences', 'error');
      return;
    }

    var box = MCF.popup({ title: 'Preferences', label: 'Preferences', wide: true });
    box.body.innerHTML = '';

    /* ----- appearance ----- */
    box.body.appendChild(section('Appearance'));

    var themeRow = document.createElement('div');
    themeRow.className = 'mcf-field';
    themeRow.innerHTML =
      '<label>Theme</label>' +
      '<div class="mcf-seg" id="mcfThemeSeg">' +
        '<button type="button" class="mcf-seg-btn' + (state.theme === 'dark' ? ' mcf-seg-on' : '') + '" data-value="dark">🌙 Dark</button>' +
        '<button type="button" class="mcf-seg-btn' + (state.theme === 'light' ? ' mcf-seg-on' : '') + '" data-value="light">☀️ Light</button>' +
      '</div>';
    box.body.appendChild(themeRow);

    themeRow.querySelectorAll('.mcf-seg-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        applyTheme(btn.dataset.value);
        write(THEME_KEY, state.theme);
        themeRow.querySelectorAll('.mcf-seg-btn').forEach(function (b) {
          b.classList.toggle('mcf-seg-on', b.dataset.value === state.theme);
        });
      });
    });

    var fontRow = document.createElement('div');
    fontRow.className = 'mcf-field';
    fontRow.innerHTML =
      '<label>Chat text size</label>' +
      '<div class="mcf-seg" id="mcfFontSeg">' +
        ['sm', 'md', 'lg', 'xl'].map(function (scale) {
          return '<button type="button" class="mcf-seg-btn' + (state.font === scale ? ' mcf-seg-on' : '') +
            '" data-value="' + scale + '">' + ({ sm: 'A', md: 'A', lg: 'A', xl: 'A' })[scale] + '</button>';
        }).join('') +
      '</div>' +
      '<p class="small muted">Applies to message text in the arena, rooms and DMs.</p>';
    box.body.appendChild(fontRow);
    fontRow.querySelectorAll('.mcf-seg-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        applyFont(btn.dataset.value);
        write(FONT_KEY, state.font);
        fontRow.querySelectorAll('.mcf-seg-btn').forEach(function (b) {
          b.classList.toggle('mcf-seg-on', b.dataset.value === state.font);
        });
      });
    });

    /* ----- language ----- */
    var langRow = document.createElement('div');
    langRow.className = 'mcf-field';
    var currentLang = read(LANG_KEY, '');
    langRow.innerHTML =
      '<label>Interface language</label>' +
      '<select id="mcfLangSelect" class="mcf-input">' +
        '<option value="">Browser / profile default</option>' +
        (window.MCFI18n ? window.MCFI18n.languages().map(function (code) {
          return '<option value="' + code + '"' + (currentLang === code ? ' selected' : '') + '>' +
            window.MCFI18n.languageName(code) + '</option>';
        }).join('') : '') +
      '</select>' +
      '<p class="small muted">Messages are always auto-translated to your profile language; this sets the language of the buttons and labels themselves.</p>';
    box.body.appendChild(langRow);
    langRow.querySelector('#mcfLangSelect').addEventListener('change', function (e) {
      write(LANG_KEY, e.target.value);
      if (window.MCFI18n) window.MCFI18n.apply();
      MCF.toast('Language updated');
    });

    /* ----- notifications ----- */
    box.body.appendChild(section('Notifications'));

    var notifWrap = document.createElement('div');
    notifWrap.innerHTML = '<p class="small muted">Loading…</p>';
    box.body.appendChild(notifWrap);

    var data = await MCF.getJSON('/api/notification-prefs');
    if (data && data.ok) {
      state.prefs = data.prefs;
      state.quietHours = data.quietHours;
      renderNotifPrefs(notifWrap);
    } else {
      notifWrap.innerHTML = '<p class="small muted">Push notifications are not configured on this site, so there is nothing to switch off here yet.</p>';
    }

    /* ----- rooms ----- */
    box.body.appendChild(section('Room notifications'));
    var roomsWrap = document.createElement('div');
    box.body.appendChild(roomsWrap);
    renderRoomMutes(roomsWrap);

    box.body.addEventListener('click', function (e) {
      var muteBtn = e.target.closest('.mcf-room-mute-toggle');
      if (muteBtn) {
        toggleRoomMute(muteBtn.dataset.room);
        renderRoomMutes(roomsWrap);
      }
    });
  }

  var KIND_LABELS = {
    dm: 'Direct messages',
    mention: 'Mentions (@name)',
    story: 'Story approvals',
    forum: 'Forum replies',
    match: 'Match turns and records',
    challenge: 'Challenges'
  };

  function renderNotifPrefs(wrap) {
    var kinds = Object.keys(KIND_LABELS).filter(function (kind) { return kind in state.prefs; });

    wrap.innerHTML =
      '<p class="small muted">Pushes are sent only when you have no live session, and never include message text. Each kind can be switched off individually.</p>' +
      kinds.map(function (kind) {
        return '<label class="mcf-toggle-row"><input type="checkbox" class="mcf-notif-kind" data-kind="' + kind + '"' +
          (state.prefs[kind] ? ' checked' : '') + '><span>' + KIND_LABELS[kind] + '</span></label>';
      }).join('') +
      '<div class="mcf-field" style="margin-top:10px"><label>Quiet hours <span class="small muted">(server local time)</span></label>' +
        '<label class="mcf-toggle-row"><input type="checkbox" id="mcfQuietEnabled"' +
          (state.quietHours.enabled ? ' checked' : '') + '><span>Silence pushes in a daily window</span></label>' +
        '<div class="mcf-quiet-times">' +
          '<select id="mcfQuietStart" class="mcf-input">' +
            hourOptions(state.quietHours.start) + '</select>' +
          '<span> to </span>' +
          '<select id="mcfQuietEnd" class="mcf-input">' + hourOptions(state.quietHours.end) + '</select>' +
        '</div>' +
      '</div>' +
      '<div class="mcf-row-actions"><button type="button" class="small-btn" id="mcfNotifSave">Save notification settings</button>' +
      '<span id="mcfNotifStatus" class="small muted"></span></div>';

    wrap.querySelector('#mcfNotifSave').addEventListener('click', saveNotifPrefs);
  }

  function hourOptions(selected) {
    var options = '';
    for (var hour = 0; hour < 24; hour++) {
      var label = (hour < 10 ? '0' + hour : hour) + ':00';
      options += '<option value="' + hour + '"' + (hour === selected ? ' selected' : '') + '>' + label + '</option>';
    }
    return options;
  }

  async function saveNotifPrefs() {
    var prefs = {};
    document.querySelectorAll('.mcf-notif-kind').forEach(function (check) {
      prefs[check.dataset.kind] = check.checked;
    });

    var status = document.getElementById('mcfNotifStatus');
    if (status) status.textContent = 'Saving…';

    var data = await MCF.postJSON('/api/notification-prefs', {
      prefs: prefs,
      quietHours: {
        enabled: !!(document.getElementById('mcfQuietEnabled') || {}).checked,
        start: Number((document.getElementById('mcfQuietStart') || {}).value) || 0,
        end: Number((document.getElementById('mcfQuietEnd') || {}).value) || 0
      }
    });

    if (!data || !data.ok) {
      if (status) status.textContent = 'Could not save.';
      MCF.toast('Could not save notification settings', 'error');
      return;
    }
    state.prefs = data.prefs;
    state.quietHours = data.quietHours;
    if (status) status.textContent = 'Saved.';
    MCF.toast('Notification settings saved', 'success');
  }

  function renderRoomMutes(wrap) {
    var rooms = Object.keys(knownRooms);
    if (!rooms.length) {
      wrap.innerHTML = '<p class="small muted">No rooms yet — once rooms exist, mute the ones that should never badge or beep.</p>';
      return;
    }
    wrap.innerHTML = rooms.map(function (roomId) {
      var muted = isRoomMuted(roomId);
      return '<div class="mcf-room-mute-row">' +
        '<span>' + MCF.escapeHtml(knownRooms[roomId] || 'Room') + '</span>' +
        '<button type="button" class="small-btn ' + (muted ? '' : 'ghost') + ' mcf-room-mute-toggle" data-room="' + MCF.escapeHtml(roomId) + '">' +
          (muted ? '🔇 Muted — tap to unmute' : '🔔 Tap to mute') + '</button>' +
      '</div>';
    }).join('');
  }

  /* ---------- boot ---------- */

  function bind() {
    var btn = document.getElementById('btnPreferences');
    if (btn) btn.addEventListener('click', open);

    applyTheme(read(THEME_KEY, 'dark'));
    applyFont(read(FONT_KEY, 'md'));
    loadMutedRooms();

    var s = window.socket || null;
    if (s) {
      s.on('roomsList', function (rooms) {
        knownRooms = {};
        (rooms || []).forEach(function (room) {
          if (room && room._id) knownRooms[String(room._id)] = room.name || 'Room';
        });
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }

  window.MCFPreferences = {
    open: open,
    isRoomMuted: isRoomMuted,
    toggleRoomMute: toggleRoomMute,
    applyTheme: applyTheme,
    applyFont: applyFont
  };
})();

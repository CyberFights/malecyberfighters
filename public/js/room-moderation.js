/* ============================================================
   room-moderation.js — the room owner's control panel
   ------------------------------------------------------------
   Rooms always had owners but no tools: an owner could invite,
   and that was it. This adds the panel behind a "Moderate"
   button that appears in the room chat header for the owner
   only (the server re-checks ownership on every action — this
   UI is convenience, not authority):

     • kick / un-kick a member (a kick removes them now and
       bars re-entry until reversed)
     • mute for 5m / 1h / 24h (or lift it)
     • slow mode: 0 / 3s / 5s / 10s minimum between messages

   The member list comes from the roomMembers socket event this
   module listens to itself, so it works on the desktop page and
   the mobile page alike.
============================================================ */
(function () {
  'use strict';

  if (!window.MCF) return;

  var roomsById = {};   // roomId → room doc (owner), from roomsList events
  var members = [];     // current room's members, from roomMembers events

  function socket() { return window.socket || null; }
  function me() {
    var s = MCF.session();
    return s ? s.username : '';
  }

  function currentRoom() {
    var popup = document.getElementById('roomChatPopup');
    return popup && popup.dataset.room ? String(popup.dataset.room) : '';
  }

  function isOwner(roomId) {
    var room = roomsById[String(roomId || '')];
    return !!(room && room.owner && room.owner === me());
  }

  /* ---------- the header button ---------- */

  function ensureModerateButton() {
    var popup = document.getElementById('roomChatPopup');
    if (!popup) return;

    var actions = popup.querySelector('.chat-header-actions');
    if (!actions) return;

    var roomId = currentRoom();
    var btn = actions.querySelector('.mcf-room-mod-btn');

    if (!roomId || !isOwner(roomId)) {
      if (btn) btn.remove();
      return;
    }

    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'small-btn secondary mcf-room-mod-btn';
      btn.textContent = '🛡 Moderate';
      btn.title = 'Room owner controls';
      btn.addEventListener('click', openPanel);
      actions.insertBefore(btn, actions.firstChild);
    }
  }

  /* ---------- the panel ---------- */

  function memberRowHtml(member) {
    if (!member || !member.username || member.username === me()) return ''; // the owner does not moderate themselves
    var user = MCF.escapeHtml(member.username);
    return '<div class="mcf-mod-member">' +
      '<span class="mcf-mod-name">@' + user + '</span>' +
      '<span class="mcf-mod-actions">' +
        '<button type="button" class="small-btn ghost mcf-mod-mute" data-user="' + user + '" data-seconds="300">Mute 5m</button>' +
        '<button type="button" class="small-btn ghost mcf-mod-mute" data-user="' + user + '" data-seconds="3600">1h</button>' +
        '<button type="button" class="small-btn ghost mcf-mod-mute" data-user="' + user + '" data-seconds="86400">24h</button>' +
        '<button type="button" class="small-btn ghost mcf-mod-unmute" data-user="' + user + '">Unmute</button>' +
        '<button type="button" class="small-btn mcf-mod-kick" data-user="' + user + '">Kick</button>' +
      '</span></div>';
  }

  function openPanel() {
    var roomId = currentRoom();
    if (!roomId || !isOwner(roomId)) return;

    var box = MCF.popup({ title: 'Room moderation', label: 'Room owner controls' });
    var room = roomsById[String(roomId)] || {};

    var slowMode = room.slowModeMs || 0;
    box.body.innerHTML =
      '<p class="small muted">You own this room. These controls apply to everyone else in it — kicks bar re-entry until you reverse them, and everything is enforced by the server, not just hidden in the UI.</p>' +

      '<h4 class="mcf-section-heading">Slow mode</h4>' +
      '<div class="mcf-seg mcf-mod-slow">' +
        [[0, 'Off'], [3000, '3s'], [5000, '5s'], [10000, '10s']].map(function (option) {
          return '<button type="button" class="mcf-seg-btn' + (slowMode === option[0] ? ' mcf-seg-on' : '') +
            '" data-ms="' + option[0] + '">' + option[1] + '</button>';
        }).join('') +
      '</div>' +

      '<h4 class="mcf-section-heading">Members in the room</h4>' +
      '<div class="mcf-mod-members"></div>' +

      (room.kicked && room.kicked.length
        ? '<h4 class="mcf-section-heading">Kicked (barred from rejoining)</h4>' +
          '<div class="mcf-mod-kicked">' +
          room.kicked.map(function (username) {
            return '<div class="mcf-mod-member"><span class="mcf-mod-name">@' + MCF.escapeHtml(username) + '</span>' +
              '<button type="button" class="small-btn ghost mcf-mod-unkick" data-user="' + MCF.escapeHtml(username) + '">Allow back in</button></div>';
          }).join('') + '</div>'
        : '');

    var membersWrap = box.body.querySelector('.mcf-mod-members');
    if (!members.filter(function (m) { return m.username && m.username !== me(); }).length) {
      membersWrap.innerHTML = '<p class="small muted">Nobody else is here right now.</p>';
    } else {
      members.forEach(function (member) {
        membersWrap.insertAdjacentHTML('beforeend', memberRowHtml(member));
      });
    }

    box.body.querySelectorAll('.mcf-mod-slow .mcf-seg-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        emit({ action: 'slow', slowModeMs: Number(btn.dataset.ms) || 0 });
        box.body.querySelectorAll('.mcf-mod-slow .mcf-seg-btn').forEach(function (b) {
          b.classList.toggle('mcf-seg-on', b === btn);
        });
        MCF.toast('Slow mode ' + (Number(btn.dataset.ms) ? 'set to ' + (Number(btn.dataset.ms) / 1000) + 's' : 'off'));
      });
    });

    box.body.addEventListener('click', function (e) {
      var btn = e.target.closest('button');
      if (!btn) return;
      var user = btn.dataset.user;

      if (btn.classList.contains('mcf-mod-kick')) {
        if (!window.confirm('Kick @' + user + ' from this room? They cannot rejoin until you allow it.')) return;
        emit({ action: 'kick', target: user });
        MCF.toast('@' + user + ' kicked');
      } else if (btn.classList.contains('mcf-mod-unkick')) {
        emit({ action: 'unkick', target: user });
        MCF.toast('@' + user + ' can rejoin');
        btn.closest('.mcf-mod-member').remove();
      } else if (btn.classList.contains('mcf-mod-mute')) {
        emit({ action: 'mute', target: user, seconds: Number(btn.dataset.seconds) || 300 });
        MCF.toast('@' + user + ' muted');
      } else if (btn.classList.contains('mcf-mod-unmute')) {
        emit({ action: 'unmute', target: user });
        MCF.toast('@' + user + ' unmuted');
      }
    });

    function emit(payload) {
      var s = socket();
      if (!s) return;
      s.emit('roomModerate', Object.assign({ room: roomId }, payload));
    }
  }

  /* ---------- boot ---------- */

  function bind() {
    var s = socket();
    if (s) {
      s.on('roomsList', function (rooms) {
        roomsById = {};
        (rooms || []).forEach(function (room) {
          if (room && room._id) roomsById[String(room._id)] = room;
        });
        ensureModerateButton();
      });
      s.on('roomMembers', function (list) {
        members = Array.isArray(list) ? list : [];
      });
      // Joining a room (history arrives right after the join) is the moment
      // the header button may need to appear.
      s.on('roomHistory', function () {
        setTimeout(ensureModerateButton, 0);
      });
      s.on('roomModeration', function (payload) {
        if (!payload) return;
        // The server follows every moderation change with a fresh roomsList
        // broadcast, which updates this module's room cache (owner, slow mode,
        // kicked list) — nothing to do here but let that land.
      });
    }

    // The room popup is shown/hidden by other scripts; watch for that so the
    // button follows the room actually being open.
    var popup = document.getElementById('roomChatPopup');
    if (popup && window.MutationObserver) {
      new MutationObserver(ensureModerateButton).observe(popup, {
        attributes: true,
        attributeFilter: ['data-room', 'style']
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }

  window.MCFRoomModeration = { openPanel: openPanel };
})();

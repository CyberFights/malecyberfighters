/* ============================================================
   achievements.js — badges (client)
   ------------------------------------------------------------
   Shows the catalogue with the member's unlocked set, and pops a
   toast the moment the server says one landed (socket event
   achievementUnlocked). The server decides everything — this file
   only renders it.

   Depends on features-core.js.
============================================================ */
(function () {
  'use strict';

  if (!window.MCF) return;

  function socket() { return window.socket || null; }

  function badgeRow(entry) {
    var el = document.createElement('div');
    el.className = 'mcf-badge' + (entry.unlockedAt ? ' mcf-badge-unlocked' : ' mcf-badge-locked');
    el.title = entry.unlockedAt
      ? 'Unlocked ' + MCF.dateLabel(entry.unlockedAt)
      : 'Locked';
    el.innerHTML =
      '<div class="mcf-badge-icon">' + (entry.icon || '🏅') + '</div>' +
      '<div class="mcf-badge-main">' +
        '<div class="mcf-badge-title">' + MCF.escapeHtml(entry.title || entry.id) + '</div>' +
        '<div class="small muted">' + MCF.escapeHtml(entry.description || '') + '</div>' +
        (entry.unlockedAt ? '<div class="small">' + MCF.dateLabel(entry.unlockedAt) + '</div>' : '') +
      '</div>';
    return el;
  }

  async function open() {
    var s = MCF.session();
    if (!s) {
      MCF.toast('Sign in to see your achievements', 'error');
      return;
    }

    var box = MCF.popup({ title: 'Achievements', label: 'Achievements', wide: true });
    box.body.innerHTML = '<p class="small muted">Loading…</p>';

    var data = await MCF.getJSON('/api/achievements');
    if (!data || !data.ok) {
      box.body.innerHTML = '<p class="small muted">Could not load achievements.</p>';
      return;
    }

    box.body.innerHTML = '';

    var head = document.createElement('div');
    head.className = 'mcf-record-bar';
    head.innerHTML =
      '<span class="mcf-record-stat"><b>' + data.unlocked.length + '</b> / ' + data.total + ' unlocked</span>' +
      '<span class="mcf-record-stat"><b>' + (data.record ? data.record.wins : 0) + '</b> wins</span>' +
      '<span class="mcf-record-stat"><b>' + (data.record ? data.record.losses : 0) + '</b> losses</span>';
    box.body.appendChild(head);

    var unlockedHeading = document.createElement('h4');
    unlockedHeading.className = 'mcf-section-heading';
    unlockedHeading.textContent = 'Unlocked';
    box.body.appendChild(unlockedHeading);

    if (!data.unlocked.length) {
      var empty = document.createElement('p');
      empty.className = 'small muted';
      empty.textContent = 'Nothing yet — finish a match, publish a story, send a challenge.';
      box.body.appendChild(empty);
    } else {
      data.unlocked.forEach(function (entry) { box.body.appendChild(badgeRow(entry)); });
    }

    var lockedHeading = document.createElement('h4');
    lockedHeading.className = 'mcf-section-heading';
    lockedHeading.textContent = 'Still to earn';
    box.body.appendChild(lockedHeading);
    data.locked.forEach(function (entry) { box.body.appendChild(badgeRow(entry)); });
  }

  function bind() {
    var btn = document.getElementById('btnAchievements');
    if (btn) btn.addEventListener('click', open);

    var s = socket();
    if (s) {
      s.on('achievementUnlocked', function (payload) {
        (payload && payload.achievements || []).forEach(function (entry) {
          MCF.toast((entry.icon || '🏅') + ' Achievement unlocked: ' + (entry.title || entry.id), 'success');
        });
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }

  window.MCFAchievements = { open: open };

  // Icon lookup for other UIs (the profile card's title line): id → emoji,
  // mirroring the server catalogue.
  window.MCFAchievementsIcons = {
    first_match: '🥊',
    wins_10: '🏅',
    wins_25: '👑',
    ironman: '🩸',
    first_story: '📖',
    stories_5: '📚',
    challenger: '📮',
    rival: '⚔️',
    allied: '🤝',
    first_post: '📣'
  };
})();

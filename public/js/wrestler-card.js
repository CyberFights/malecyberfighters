/* Build a wrestling profile card element that layers a wrestler's photo,
   name, and stats on top of the trading-card frame image. Returns a
   <div class="wc-card"> that can be dropped into the page. */
(function () {
  'use strict';

  const STAT_LABELS = {
    strength: 'STR',
    agility:  'AGI',
    stamina:  'STA',
    skill:    'SKL',
    charisma: 'CHA'
  };

  function el(tag, cls, html) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* options:
     name        - wrestler name (shown on bottom nameplate)
     image       - photo URL (data URI or http URL)
     nickname    - small title text on the top banner (optional)
     record      - e.g. "12 - 3" shown below the name (optional)
     stats       - { strength, agility, stamina, skill, charisma } 0-100
     hp, maxHp   - if present, render an HP bar under the card
     stamina, maxStamina - stamina bar
     mirrored    - flip horizontally (for opponent facing player)
     frameUrl    - override frame image (defaults to /images/wrestler-card-frame.png)
  */
  function createWrestlerCard(options) {
    const opts = options || {};
    const frame = opts.frameUrl || '/images/wrestler-card-frame.png';
    const stats = opts.stats || {};
    const name = opts.name || 'Wrestler';
    const nickname = opts.nickname || 'WRESTLER';
    const fallbackImg = '/images/mcf-192.png';

    const root = el('div', 'wc-card');
    if (opts.mirrored) root.classList.add('mirrored');

    // Photo layer (under the frame)
    const photoWrap = el('div', 'wc-photo-wrap');
    const photo = el('img', 'wc-photo');
    photo.src = opts.image || fallbackImg;
    photo.alt = escapeHtml(name);
    photo.draggable = false;
    photo.onerror = function () {
      if (photo.src !== (location.origin + fallbackImg)) photo.src = fallbackImg;
    };
    photoWrap.appendChild(photo);
    root.appendChild(photoWrap);

    // Frame (on top, with transparent octagon so the photo shows through)
    const bg = el('img', 'wc-bg');
    bg.src = frame;
    bg.alt = '';
    bg.draggable = false;
    root.appendChild(bg);

    // Top banner nickname
    const top = el('div', 'wc-top-banner');
    top.textContent = nickname;
    root.appendChild(top);

    // Name plate
    const nameEl = el('div', 'wc-name');
    nameEl.textContent = name;
    nameEl.title = name;
    root.appendChild(nameEl);

    // Record
    if (opts.record != null && opts.record !== '') {
      const rec = el('div', 'wc-record');
      rec.textContent = opts.record;
      root.appendChild(rec);
    }

    // Stat blocks stacked on the right side panel (5 slots for 5 stats).
    const statsWrap = el('div', 'wc-stats');
    ['strength','agility','stamina','skill','charisma'].forEach((key, i) => {
      const v = Math.max(0, Math.min(100, Math.round(Number(stats[key]) || 0)));
      const slot = el('div', 'wc-stat');
      slot.title = key + ': ' + v;
      const lab = el('span', 'wc-stat-lab');
      lab.textContent = STAT_LABELS[key] || key.slice(0,3).toUpperCase();
      const val = el('span', 'wc-stat-val');
      val.textContent = v;
      slot.appendChild(lab);
      slot.appendChild(val);
      const bar = el('div', 'wc-stat-bar');
      const fill = document.createElement('i');
      fill.style.width = v + '%';
      bar.appendChild(fill);
      slot.appendChild(bar);
      statsWrap.appendChild(slot);
    });
    root.appendChild(statsWrap);

    // Optional HP/stamina bars under the card
    const container = el('div', 'wc-card-host');
    container.appendChild(root);

    if (opts.maxHp != null || opts.maxStamina != null) {
      const bars = el('div', 'wc-bars');
      if (opts.maxHp != null) {
        const hp = Math.max(0, Math.min(opts.maxHp, Number(opts.hp) || 0));
        const pct = opts.maxHp > 0 ? (hp / opts.maxHp * 100) : 0;
        const row = el('div', 'wc-bar-row hp');
        row.innerHTML =
          '<span class="wc-bar-lab">HP</span>' +
          '<span class="wc-bar"><i style="width:' + pct + '%"></i></span>' +
          '<span class="wc-bar-num">' + hp + '/' + opts.maxHp + '</span>';
        bars.appendChild(row);
      }
      if (opts.maxStamina != null) {
        const s = Math.max(0, Math.min(opts.maxStamina, Number(opts.stamina) || 0));
        const pct = opts.maxStamina > 0 ? (s / opts.maxStamina * 100) : 0;
        const row = el('div', 'wc-bar-row stam');
        row.innerHTML =
          '<span class="wc-bar-lab">STAM</span>' +
          '<span class="wc-bar"><i style="width:' + pct + '%"></i></span>' +
          '<span class="wc-bar-num">' + s + '/' + opts.maxStamina + '</span>';
        bars.appendChild(row);
      }
      container.appendChild(bars);
    }

    // Helper to update the card after creation (for HP/stamina mid-match).
    container.update = function (patch) {
      if (!patch) return;
      if (patch.image && photo.src !== patch.image) photo.src = patch.image;
      if (patch.name) { nameEl.textContent = patch.name; nameEl.title = patch.name; }
      if (patch.nickname != null) top.textContent = patch.nickname;
      if (patch.record != null) {
        let recEl = container.querySelector('.wc-record');
        if (!recEl) {
          recEl = el('div', 'wc-record');
          root.appendChild(recEl);
        }
        recEl.textContent = patch.record;
      }
      if (patch.stats) {
        const slots = statsWrap.querySelectorAll('.wc-stat');
        ['strength','agility','stamina','skill','charisma'].forEach((key, i) => {
          if (patch.stats[key] == null || !slots[i]) return;
          const v = Math.max(0, Math.min(100, Math.round(Number(patch.stats[key]) || 0)));
          const val = slots[i].querySelector('.wc-stat-val');
          if (val) val.textContent = v;
          const fill = slots[i].querySelector('.wc-stat-bar > i');
          if (fill) fill.style.width = v + '%';
        });
      }
      if (opts.maxHp != null || patch.maxHp != null) {
        const maxHp = patch.maxHp != null ? patch.maxHp : opts.maxHp;
        const hp = patch.hp != null ? patch.hp : opts.hp;
        const row = bars.querySelector('.wc-bar-row.hp');
        if (row && maxHp > 0) {
          const fill = row.querySelector('.wc-bar > i');
          const num = row.querySelector('.wc-bar-num');
          if (fill) fill.style.width = Math.max(0, Math.min(100, hp/maxHp*100)) + '%';
          if (num) num.textContent = Math.max(0, hp) + '/' + maxHp;
        }
      }
      if (opts.maxStamina != null || patch.maxStamina != null) {
        const maxS = patch.maxStamina != null ? patch.maxStamina : opts.maxStamina;
        const s = patch.stamina != null ? patch.stamina : opts.stamina;
        const row = bars.querySelector('.wc-bar-row.stam');
        if (row && maxS > 0) {
          const fill = row.querySelector('.wc-bar > i');
          const num = row.querySelector('.wc-bar-num');
          if (fill) fill.style.width = Math.max(0, Math.min(100, s/maxS*100)) + '%';
          if (num) num.textContent = Math.max(0, s) + '/' + maxS;
        }
      }
    };

    return container;
  }

  window.WrestlerCard = { create: createWrestlerCard };
})();

(() => {
  'use strict';
  const WG = window.WrestlingGame;
  const WC = window.WrestlingCareer || window.CareerMode;
  const WCrd = window.WrestlerCard;
  const gate = document.getElementById('gate');
  const app = document.getElementById('app');
  function byId(id) { return document.getElementById(id); }

  let me = null;
  let stats = (WG && WG.defaultStats) ? WG.defaultStats() : {strength:5,agility:5,stamina:5,skill:5,charisma:5};
  let wrestler = null;
  let match = null;
  let career = null;
  let careerMatchNode = null;

  let playerCard = null;
  let opponentCard = null;
  let editCard = null;

  function sessionToken() { try { return localStorage.getItem('cw_token_v1') || null; } catch (e) { return null; } }
  async function api(path, opts) {
    const o = Object.assign({}, opts || {});
    const headers = Object.assign({ 'Content-Type': 'application/json' }, o.headers || {});
    const token = sessionToken();
    if (token && !headers.Authorization) headers.Authorization = 'Bearer ' + token;
    o.headers = headers;
    o.credentials = o.credentials || 'same-origin';
    try {
      const res = await fetch(path, o);
      const j = await res.json().catch(() => ({}));
      return j;
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  }

  function nicknameFor(w) {
    if (!w) return '';
    if (w.nickname && typeof w.nickname === 'string') return w.nickname;
    // Derive a small title from best stat
    const s = (w.stats && typeof w.stats === 'object') ? w.stats : null;
    if (s) {
      let best = 'strength', bestV = -1;
      WG.STATS.forEach(k => { const v = Number(s[k])||0; if (v > bestV) { bestV = v; best = k; } });
      const tags = { strength:'THE POWERHOUSE', agility:'THE HIGH-FLYER', stamina:'THE IRON-MAN', skill:'THE TECHNICIAN', charisma:'THE SHOWMAN' };
      return tags[best] || 'WRESTLER';
    }
    return 'WRESTLER';
  }

  function recordFor(w) {
    if (!w) return '';
    const wins = Number(w.wins)||0;
    const losses = Number(w.losses)||0;
    if (wins || losses) return wins + ' - ' + losses;
    return '';
  }

  function renderEditCard() {
    const wrap = byId('wrestlerCardWrap');
    if (!wrap || !WCrd) return;
    wrap.innerHTML = '';
    const w = wrestler || { name: (me && (me.display || me.username)) || 'Wrestler', image: (me && me.imageUrl) || '/images/mcf-192.png', stats: stats };
    const nickname = (wrestler && wrestler.nickname) || nicknameFor(w);
    editCard = WCrd.create({
      name: w.name || 'Wrestler',
      image: w.image || (me && me.imageUrl) || '/images/mcf-192.png',
      nickname: nickname,
      record: recordFor(wrestler),
      stats: Object.assign({}, WG.defaultStats(), stats || {})
    });
    wrap.appendChild(editCard);

    // Click on the card opens the file picker
    const cardEl = editCard.querySelector('.wc-card');
    if (cardEl) {
      cardEl.addEventListener('click', () => {
        const f = byId('wrestlerFile');
        if (f) f.click();
      });
    }
  }

  function syncEditCard() {
    if (!editCard) return;
    const nEl = byId('wrestlerName');
    const nnEl = byId('wrestlerNickname');
    editCard.update({
      name: nEl ? (nEl.value || (wrestler && wrestler.name) || 'Wrestler') : (wrestler && wrestler.name),
      nickname: nnEl ? (nnEl.value || (wrestler && wrestler.nickname) || nicknameFor(wrestler)) : (wrestler && wrestler.nickname),
      image: wrestler && wrestler.image ? wrestler.image : ((me && me.imageUrl) || '/images/mcf-192.png'),
      stats: Object.assign({}, WG.defaultStats(), stats || {}),
      record: recordFor(wrestler)
    });
  }

  async function init() {
    try {
      const r = await api('/api/me');
      if (!r || !r.ok || !r.user) {
        if (gate) gate.classList.remove('hidden');
        if (app) app.classList.add('hidden');
        const cs = byId('careerStatus');
        if (cs) cs.textContent = 'Sign in to start a career.';
        return;
      }
      me = r.user;
      if (gate) gate.classList.add('hidden');
      if (app) app.classList.remove('hidden');
      try {
        const s = await api('/api/wrestling/stats');
        if (s && s.ok && s.stats) { stats = s.stats; wrestler = s.wrestler || wrestler; }
      } catch (e) {}
      if (wrestler) {
        const n = byId('wrestlerName');
        if (n) n.value = wrestler.name || '';
        const nn = byId('wrestlerNickname');
        if (nn) nn.value = wrestler.nickname || '';
      } else if (me) {
        const n = byId('wrestlerName');
        if (n && !n.value) n.value = me.display || me.username || '';
      }
      renderStats();
      renderEditCard();
      loadCareer();
      renderCareer();

      // Live sync when the user types / picks a photo
      const nEl = byId('wrestlerName');
      if (nEl) nEl.addEventListener('input', syncEditCard);
      const nnEl = byId('wrestlerNickname');
      if (nnEl) nnEl.addEventListener('input', syncEditCard);
      const fEl = byId('wrestlerFile');
      if (fEl) fEl.addEventListener('change', () => {
        const file = fEl.files && fEl.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          if (wrestler) wrestler.image = reader.result;
          syncEditCard();
        };
        reader.readAsDataURL(file);
      });
    } catch (e) {
      console.error('wrestling init failed', e);
      if (gate) gate.classList.remove('hidden');
      if (app) app.classList.add('hidden');
    }
  }

  function renderStats() {
    const list = byId('statsList');
    if (!list) return;
    if (!WG || !WG.STATS) { list.textContent = 'Stats unavailable.'; return; }
    list.innerHTML = '';
    WG.STATS.forEach(st => {
      const row = document.createElement('div');
      row.className = 'stat';
      const val = (stats && stats[st] != null) ? stats[st] : 5;
      const label = st.charAt(0).toUpperCase() + st.slice(1);
      row.innerHTML = '<span>'+label+' — <b>'+val+'</b></span><span><button data-train="'+st+'" type="button">Train</button></span>';
      list.appendChild(row);
    });
    list.querySelectorAll('[data-train]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const st = btn.getAttribute('data-train');
        btn.disabled = true;
        try {
          const r = await api('/api/wrestling/train', { method:'POST', body: JSON.stringify({ stat: st, amount: 1 }) });
          if (r && r.ok && r.stats) {
            stats = r.stats;
            renderStats();
            if (editCard) editCard.update({ stats: stats });
          } else alert((r && r.error) || 'train failed');
        } finally { btn.disabled = false; }
      });
    });
  }

  const saveBtn = byId('saveWrestler');
  if (saveBtn) saveBtn.addEventListener('click', async () => {
    const nameEl = byId('wrestlerName');
    const nnEl = byId('wrestlerNickname');
    const fileEl = byId('wrestlerFile');
    const name = nameEl ? nameEl.value.trim() : '';
    const nickname = nnEl ? nnEl.value.trim() : '';
    const file = fileEl && fileEl.files ? fileEl.files[0] : null;
    let image = wrestler && wrestler.image ? wrestler.image : '';
    if (file) {
      try {
        image = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        });
      } catch (e) { alert('Failed to read image'); return; }
    }
    saveBtn.disabled = true;
    try {
      const payload = { name, image, stats };
      if (nickname) payload.nickname = nickname;
      const r = await api('/api/wrestling/wrestler', { method:'POST', body: JSON.stringify(payload) });
      if (r && r.ok) {
        wrestler = r.wrestler;
        stats = r.stats || stats;
        const st = byId('wrestlerStatus');
        if (st) st.textContent = 'Saved!';
        renderStats();
        renderEditCard();
      } else {
        const st = byId('wrestlerStatus');
        if (st) st.textContent = (r && r.error) || 'save failed';
      }
    } finally { saveBtn.disabled = false; }
  });

  function mountMatchCards() {
    const pWrap = byId('pCard');
    const oWrap = byId('oCard');
    if (!pWrap || !oWrap) return;
    pWrap.innerHTML = '';
    oWrap.innerHTML = '';
    playerCard = WCrd.create({
      name: match.player.name,
      image: match.player.image || '/images/mcf-192.png',
      nickname: nicknameFor(match.player),
      record: recordFor(match.player),
      stats: match.player.stats,
      hp: match.player.hp, maxHp: match.player.maxHp,
      stamina: match.player.stamina, maxStamina: match.player.maxStamina
    });
    opponentCard = WCrd.create({
      name: match.opponent.name,
      image: match.opponent.image || '/images/mcf-192.png',
      nickname: nicknameFor(match.opponent),
      record: recordFor(match.opponent),
      stats: match.opponent.stats,
      hp: match.opponent.hp, maxHp: match.opponent.maxHp,
      stamina: match.opponent.stamina, maxStamina: match.opponent.maxStamina,
      mirrored: true
    });
    pWrap.appendChild(playerCard);
    oWrap.appendChild(opponentCard);
  }

  const findBtn = byId('findOpponent');
  if (findBtn) findBtn.addEventListener('click', async () => {
    const status = byId('oppStatus');
    if (!WG || !WG.pickOpponent) { if (status) status.textContent = 'Game not loaded'; return; }
    findBtn.disabled = true;
    try {
      const r = await api('/api/allUsers');
      if (!r || !r.success) { if (status) status.textContent = 'Failed to load roster'; return; }
      const exclude = me ? me.username : null;
      const oppUser = WG.pickOpponent(r.users, exclude);
      if (!oppUser) { if (status) status.textContent = 'No opponents available'; return; }
      if (status) status.textContent = '';
      const oppW = WG.opponentWrestler(oppUser);
      const myW = wrestler || (WG.fromProfile ? WG.fromProfile(me || { username: 'You', display: 'You' }) : { name: 'You', image: '', stats });
      if (!myW.stats) myW.stats = stats;
      myW.stats = WG.normalizeStats(Object.assign({}, stats, myW.stats));
      if (wrestler && wrestler.nickname) myW.nickname = wrestler.nickname;
      match = WG.newMatch(myW, oppW);
      const ma = byId('matchArea');
      if (ma) ma.classList.remove('hidden');
      const mr = byId('matchResult'); if (mr) mr.textContent = '';
      mountMatchCards();
      renderMatch();
    } finally { findBtn.disabled = false; }
  });

  function renderMatch() {
    if (!match) return;
    if (!WG || !WG.isFinished) return;
    if (playerCard) playerCard.update({
      hp: match.player.hp, maxHp: match.player.maxHp,
      stamina: match.player.stamina, maxStamina: match.player.maxStamina
    });
    if (opponentCard) opponentCard.update({
      hp: match.opponent.hp, maxHp: match.opponent.maxHp,
      stamina: match.opponent.stamina, maxStamina: match.opponent.maxStamina
    });
    const log = byId('matchLog');
    if (log) {
      log.innerHTML = (match.log || []).map(l => '<div>'+String(l).replace(/</g,'&lt;')+'</div>').join('');
      log.scrollTop = log.scrollHeight;
    }
    if (WG.isFinished(match)) {
      const mr = byId('matchResult');
      if (mr) mr.textContent = match.status === 'player_win' ? 'You win!' : (match.status === 'opponent_win' ? 'You lose!' : 'Draw!');
    } else {
      const mr = byId('matchResult');
      if (mr) mr.textContent = '';
    }
  }

  function saveCareer() {
    if (!career || !WC || !WC.serialize) return;
    try { localStorage.setItem('mcf_career_' + (me ? me.username : 'anon'), WC.serialize(career)); } catch (e) {}
  }
  function loadCareer() {
    if (!WC || !WC.deserialize) return null;
    try {
      const raw = localStorage.getItem('mcf_career_' + (me ? me.username : 'anon'));
      if (raw) {
        const parsed = WC.deserialize(raw);
        if (parsed) career = parsed;
      }
    } catch (e) { career = null; }
    return career;
  }

  function renderCareer() {
    const status = byId('careerStatus');
    const area = byId('careerArea');
    if (!status || !area) return;
    if (!WC) { status.textContent = 'Career mode unavailable.'; area.classList.add('hidden'); return; }
    if (!career) { status.textContent = me ? 'No career started.' : 'Sign in to start a career.'; area.classList.add('hidden'); return; }
    status.textContent = 'Career: ' + career.playerName + ' | Record ' + career.wins + '-' + career.losses + ' | Rep ' + career.reputation + (career.title ? ' | ' + career.title : '');
    area.classList.remove('hidden');
    const node = WC.currentNode ? WC.currentNode(career) : null;
    if (!node) { area.classList.add('hidden'); return; }
    const t = byId('careerTitle'); if (t) t.textContent = node.title || '';
    const txt = byId('careerText'); if (txt) txt.textContent = node.text || '';
    const portraitEl = byId('careerPortrait');
    if (portraitEl) {
      const src = node.portrait || (node.opponent && node.opponent.image) || '/images/mcf-192.png';
      portraitEl.src = src;
      portraitEl.alt = node.opponent ? node.opponent.name : (node.title || '');
      portraitEl.style.display = (node.portrait || (node.opponent && node.opponent.image)) ? '' : 'none';
    }
    const cr = byId('careerResult'); if (cr) cr.textContent = '';
    const choicesEl = byId('careerChoices'); if (choicesEl) choicesEl.innerHTML = '';
    const trainEl = byId('careerTraining'); if (trainEl) trainEl.classList.add('hidden');
    const matchEl = byId('careerMatch'); if (matchEl) matchEl.classList.add('hidden');
    const summaryEl = byId('careerSummary'); if (summaryEl) summaryEl.classList.add('hidden');

    if (node.type === 'story') {
      const wrap = byId('careerChoices');
      (node.choices || []).forEach(ch => {
        const btn = document.createElement('button');
        btn.textContent = ch.label;
        btn.type = 'button';
        btn.style.display = 'block';
        btn.style.margin = '6px 0';
        btn.addEventListener('click', () => {
          if (!WC.makeChoice) return;
          const r = WC.makeChoice(career, ch.id);
          if (r && r.ok) { saveCareer(); renderCareer(); }
        });
        if (wrap) wrap.appendChild(btn);
      });
    } else if (node.type === 'training') {
      if (trainEl) trainEl.classList.remove('hidden');
      const wrap = byId('careerTrainButtons');
      if (wrap) wrap.innerHTML = '';
      const opts = node.statOptions || (WC.STATS || ['strength','agility','stamina','skill','charisma']);
      opts.forEach(st => {
        const btn = document.createElement('button');
        btn.textContent = st + ' + ' + (node.amount || 1);
        btn.type = 'button';
        btn.style.margin = '4px';
        btn.addEventListener('click', () => {
          if (!WC.trainStat) return;
          const r = WC.trainStat(career, st);
          if (r && r.ok) { saveCareer(); renderCareer(); }
          else alert((r && r.error) || 'train failed');
        });
        if (wrap) wrap.appendChild(btn);
      });
    } else if (node.type === 'match') {
      if (matchEl) matchEl.classList.remove('hidden');
      careerMatchNode = node;
      startCareerMatch(node);
    } else if (node.type === 'ending') {
      if (cr) cr.textContent = 'ENDING: ' + (node.title || node.ending || '');
      if (WC.summary && summaryEl) {
        const sum = WC.summary(career);
        summaryEl.classList.remove('hidden');
        summaryEl.innerHTML = '<p>Record: ' + sum.record + '</p><p>Reputation: ' + sum.reputation + '</p><p>Title: ' + (sum.title || 'None') + '</p><p>Ending: ' + (sum.ending || node.ending || '') + '</p>';
      }
    }
  }

  function startCareerMatch(node) {
    if (!WG || !WC) return;
    if (!node || !node.opponent) return;
    try {
      const opp = WG.createWrestler ? WG.createWrestler({ name: node.opponent.name, image: node.opponent.image || '', stats: node.opponent.stats }) : { name: node.opponent.name, image: '', stats: node.opponent.stats };
      const baseMe = me || { username: 'You', display: career ? career.playerName : 'You' };
      const myW = WG.fromProfile ? WG.fromProfile(baseMe) : { name: baseMe.display || baseMe.username, image: '', stats };
      myW.stats = WG.normalizeStats ? WG.normalizeStats(Object.assign({}, stats, myW.stats || {})) : Object.assign({}, stats);
      myW.name = career ? career.playerName : myW.name;
      if (wrestler && wrestler.nickname) myW.nickname = wrestler.nickname;
      match = WG.newMatch(myW, opp);
      const ma = byId('matchArea');
      if (ma) ma.classList.remove('hidden');
      const mr = byId('matchResult'); if (mr) mr.textContent = 'Career match in progress...';
      mountMatchCards();
      renderMatch();
    } catch (e) {
      console.error('startCareerMatch failed', e);
      const mr = byId('matchResult'); if (mr) mr.textContent = 'Failed to start career match.';
    }
  }

  (function bindActions(){
    document.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!match || !WG || !WG.isFinished || WG.isFinished(match)) return;
        const action = btn.getAttribute('data-action');
        WG.resolveTurn(match, action);
        renderMatch();
        if (WG.isFinished(match) && career && careerMatchNode && WC && WC.resolveMatch) {
          const won = match.status === 'player_win';
          const r = WC.resolveMatch(career, won);
          if (r && r.ok) {
            careerMatchNode = null;
            const ma = byId('matchArea');
            if (ma) ma.classList.add('hidden');
            match = null;
            saveCareer();
            renderCareer();
            renderEditCard();
          }
        }
      });
    });
  })();

  const startBtn = byId('startCareer');
  if (startBtn) startBtn.addEventListener('click', () => {
    if (!WC || !WC.defaultCareer) { alert('Career mode not loaded'); return; }
    if (!me) {
      const st = byId('careerStatus');
      if (st) st.textContent = 'Sign in to start a career.';
      alert('Sign in to start a career.');
      return;
    }
    const fallbackName = (wrestler && wrestler.name) ? wrestler.name : (me.display || me.username || 'Wrestler');
    try {
      career = WC.defaultCareer(fallbackName, stats);
      careerMatchNode = null;
      match = null;
      const ma = byId('matchArea');
      if (ma) ma.classList.add('hidden');
      saveCareer();
      renderCareer();
    } catch (e) {
      console.error('startCareer failed', e);
      alert('Failed to start career: ' + (e && e.message || e));
    }
  });

  window._wrestlingPage = { get me(){return me;}, get stats(){return stats;}, get career(){return career;}, get match(){return match;}, renderCareer, loadCareer, saveCareer, init };

  init();
})();

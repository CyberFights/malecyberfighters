(() => {
  'use strict';
  const WG = window.WrestlingGame;
  const WC = window.WrestlingCareer || window.CareerMode;
  const gate = document.getElementById('gate');
  const app = document.getElementById('app');
  function byId(id) { return document.getElementById(id); }
  let me = null;
  let stats = (WG && WG.defaultStats) ? WG.defaultStats() : {strength:5,agility:5,stamina:5,skill:5,charisma:5};
  let wrestler = null;
  let match = null;
  let career = null;
  let careerMatchNode = null;

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
        const img = byId('wrestlerImage');
        if (img && wrestler.image) img.src = wrestler.image;
      }
      renderStats();
      loadCareer();
      renderCareer();
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
      row.innerHTML = '<span>'+st+'</span><span>'+val+' <button data-train="'+st+'" type="button">Train</button></span>';
      list.appendChild(row);
    });
    list.querySelectorAll('[data-train]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const st = btn.getAttribute('data-train');
        btn.disabled = true;
        try {
          const r = await api('/api/wrestling/train', { method:'POST', body: JSON.stringify({ stat: st, amount: 1 }) });
          if (r && r.ok && r.stats) { stats = r.stats; renderStats(); }
          else alert((r && r.error) || 'train failed');
        } finally { btn.disabled = false; }
      });
    });
  }

  const saveBtn = byId('saveWrestler');
  if (saveBtn) saveBtn.addEventListener('click', async () => {
    const nameEl = byId('wrestlerName');
    const fileEl = byId('wrestlerFile');
    const name = nameEl ? nameEl.value.trim() : '';
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
      const r = await api('/api/wrestling/wrestler', { method:'POST', body: JSON.stringify({ name, image, stats }) });
      if (r && r.ok) {
        wrestler = r.wrestler; stats = r.stats || stats;
        const img = byId('wrestlerImage');
        if (img && wrestler && wrestler.image) img.src = wrestler.image;
        const st = byId('wrestlerStatus');
        if (st) st.textContent = 'Saved!';
        renderStats();
      } else {
        const st = byId('wrestlerStatus');
        if (st) st.textContent = (r && r.error) || 'save failed';
      }
    } finally { saveBtn.disabled = false; }
  });

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
      match = WG.newMatch(myW, oppW);
      const ma = byId('matchArea');
      if (ma) ma.classList.remove('hidden');
      const pn = byId('pName'); if (pn) pn.textContent = match.player.name;
      const on = byId('oName'); if (on) on.textContent = match.opponent.name;
      const pi = byId('pImg'); if (pi && match.player.image) pi.src = match.player.image;
      const oi = byId('oImg'); if (oi && match.opponent.image) oi.src = match.opponent.image;
      const mr = byId('matchResult'); if (mr) mr.textContent = '';
      renderMatch();
    } finally { findBtn.disabled = false; }
  });

  function renderMatch() {
    if (!match) return;
    if (!WG || !WG.isFinished) return;
    const pHp = byId('pHp'); if (pHp) pHp.textContent = match.player.hp + '/' + match.player.maxHp;
    const oHp = byId('oHp'); if (oHp) oHp.textContent = match.opponent.hp + '/' + match.opponent.maxHp;
    const pStam = byId('pStam'); if (pStam) pStam.textContent = String(match.player.stamina);
    const oStam = byId('oStam'); if (oStam) oStam.textContent = String(match.opponent.stamina);
    const pBar = byId('pHpBar'); if (pBar) pBar.style.width = (match.player.hp/match.player.maxHp*100) + '%';
    const oBar = byId('oHpBar'); if (oBar) oBar.style.width = (match.opponent.hp/match.opponent.maxHp*100) + '%';
    const log = byId('matchLog');
    if (log) {
      log.innerHTML = (match.log || []).map(l => '<div>'+String(l).replace(/</g,'&lt;')+'</div>').join('');
      log.scrollTop = log.scrollHeight;
    }
    if (WG.isFinished(match)) {
      const mr = byId('matchResult');
      if (mr) mr.textContent = match.status === 'player_win' ? 'You win!' : (match.status === 'opponent_win' ? 'You lose!' : 'Draw!');
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
      match = WG.newMatch(myW, opp);
      const ma = byId('matchArea');
      if (ma) ma.classList.remove('hidden');
      const pn = byId('pName'); if (pn) pn.textContent = match.player.name;
      const on = byId('oName'); if (on) on.textContent = match.opponent.name;
      const pi = byId('pImg'); if (pi && match.player.image) pi.src = match.player.image;
      const oi = byId('oImg'); if (oi && match.opponent.image) oi.src = match.opponent.image;
      const mr = byId('matchResult'); if (mr) mr.textContent = 'Career match in progress...';
      renderMatch();
    } catch (e) {
      console.error('startCareerMatch failed', e);
      const mr = byId('matchResult'); if (mr) mr.textContent = 'Failed to start career match.';
    }
  }

  (function bindActions(){
    const btns = document.querySelectorAll('[data-action]');
    if (!btns.length) return;
    btns.forEach(btn => {
      const clone = btn.cloneNode(true);
      btn.parentNode.replaceChild(clone, btn);
    });
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

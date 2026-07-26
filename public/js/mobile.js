/* =========================================================================
   mobile.js — Final integrated client
   - Ensures Register button reliably opens #modalRegister
   - All handlers defined and exposed before DOMContentLoaded
   - Defensive bindings, age gate, auth, roster/profile, sockets, UI helpers
   - Designed to be dropped in as a single file
   ========================================================================= */

/* ---------------------------
   Lightweight DOM helpers
   --------------------------- */
const $ = id => document.getElementById(id);
const show = el => { if (!el) return; el.style.display = el.dataset.display || "flex"; el.style.visibility = 'visible'; el.style.pointerEvents = ''; };
const hide = el => { if (!el) return; el.style.display = "none"; el.style.visibility = 'hidden'; el.style.pointerEvents = 'none'; };
const on = (el, ev, fn) => { if (!el) return; el.addEventListener(ev, fn); };

/* ---------------------------
   Session helpers
   --------------------------- */
const SESSION_KEY = "cw_session_v1";
function getSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}
function setSession(obj) {
  if (!obj) {
    localStorage.removeItem(SESSION_KEY);
    return;
  }
  localStorage.setItem(SESSION_KEY, JSON.stringify(obj));
}

/* ---------------------------
   Small utilities
   --------------------------- */
function escapeHtml(s) {
  if (!s) return "";
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}
function debounce(fn, wait = 250) {
  let t;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), wait);
  };
}
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    if (!file) return resolve(null);
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = err => reject(err);
    reader.readAsDataURL(file);
  });
}

/* ---------------------------
   Modal helper (centralized)
   --------------------------- */
function showModalById(id) {
  const m = document.getElementById(id);
  if (!m) return console.warn('showModalById: not found', id);
  m.dataset.display = m.dataset.display || (getComputedStyle(m).display === 'none' ? 'flex' : getComputedStyle(m).display);
  m.style.display = m.dataset.display;
  m.style.visibility = 'visible';
  m.style.pointerEvents = 'auto';
  m.style.zIndex = 99999;
}
function hideModalById(id) {
  const m = document.getElementById(id);
  if (!m) return;
  m.style.display = 'none';
  m.style.visibility = 'hidden';
  m.style.pointerEvents = 'none';
}

/* ---------------------------
   Support / admin helpers
   --------------------------- */
async function submitSupportReport() {
  const me = getSession();
  if (!me) {
    alert("You must be logged in to submit a report.");
    return;
  }

  const payload = {
    from: me.username,
    type: $("srType")?.value || "general",
    user: $("srUser")?.value || null,
    where: $("srWhere")?.value || null,
    when: $("srWhen")?.value || null,
    info: $("srInfo")?.value || ""
  };

  try {
    const res = await fetch("/api/support", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(()=>({ok:false}));
    if (data && data.ok) {
      alert("Support request submitted.");
      hideModalById("supportPopup");
    } else {
      alert(data.error || "Failed to submit support request.");
    }
  } catch (err) {
    alert("Network error while submitting support request.");
  }
}
window.submitSupportReport = submitSupportReport;

/* ---------------------------
   Auth handlers (exposed)
   --------------------------- */
async function handleLoginClick(e) {
  if (e && e.preventDefault) e.preventDefault();
  const userEl = $("loginUser");
  const passEl = $("loginPass");
  const errEl  = $("loginError");
  if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }

  const username = userEl?.value?.trim();
  const password = passEl?.value?.trim();

  if (!username || !password) {
    if (errEl) { errEl.textContent = 'Enter username and password'; errEl.style.display = 'block'; }
    return;
  }

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json().catch(() => ({ ok: false, error: 'Invalid response' }));
    if (!res.ok || !data.ok) {
      const message = data.error || data.message || 'Login failed';
      if (errEl) { errEl.textContent = message; errEl.style.display = 'block'; }
      return;
    }
    setSession(data.user || data);
    hideModalById('modalLogin');
    updateUIForSession();
  } catch (err) {
    if (errEl) { errEl.textContent = 'Network error during login'; errEl.style.display = 'block'; }
  }
}
window.handleLoginClick = handleLoginClick;

async function handleRegisterClick(e) {
  if (e && e.preventDefault) e.preventDefault();
  const errEl = $("regError");
  if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }

  const payload = {
    username: $("regUser")?.value?.trim(),
    email: $("regEmail")?.value?.trim(),
    display: $("regDisplay")?.value?.trim(),
    password: $("regPass")?.value?.trim(),
    age: Number($("regAge")?.value || 0),
    color: $("regColor")?.value || null,
    language: $("regLanguage")?.value || null,
    wins: Number($("regWins")?.value || 0),
    losses: Number($("regLosses")?.value || 0),
    info: $("regInfo")?.value?.trim() || ''
  };

  if (!payload.username || !payload.password || !payload.email) {
    if (errEl) { errEl.textContent = 'Username, email and password are required'; errEl.style.display = 'block'; }
    return;
  }
  if (payload.age && payload.age < 13) {
    if (errEl) { errEl.textContent = 'You must be at least 13 to register'; errEl.style.display = 'block'; }
    return;
  }

  try {
    const fileInput = $("regImageFile");
    if (fileInput && fileInput.files && fileInput.files.length > 0) {
      try {
        const b64 = await fileToBase64(fileInput.files[0]);
        payload.imageUrl = b64;
        const statusEl = $("uploadStatus");
        if (statusEl) { statusEl.textContent = 'Image attached'; statusEl.dataset.url = 'data:image'; }
      } catch (imgErr) {
        // ignore image conversion error
      }
    }

    const res = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({ ok: false, error: 'Invalid response' }));
    if (!res.ok || !data.ok) {
      const message = data.error || data.message || 'Registration failed';
      if (errEl) { errEl.textContent = message; errEl.style.display = 'block'; }
      return;
    }
    setSession(data.user || data);
    hideModalById('modalRegister');
    updateUIForSession();
  } catch (err) {
    if (errEl) { errEl.textContent = 'Network error during registration'; errEl.style.display = 'block'; }
  }
}
window.handleRegisterClick = handleRegisterClick;

/* ---------------------------
   Optional image upload helper
   --------------------------- */
async function uploadImageFile(file) {
  if (!file) return null;
  try {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch('/api/upload', { method: 'POST', body: form });
    if (!res.ok) return null;
    const data = await res.json().catch(()=>null);
    return data?.url || null;
  } catch (err) {
    return null;
  }
}

/* ---------------------------
   Age gate state flag
   --------------------------- */
window.__ageGatePassed = window.__ageGatePassed || false;

/* ---------------------------
   ensureStartupVisibility
   --------------------------- */
function ensureStartupVisibility() {
  const authScreenFix = document.querySelector('[id="authScreen"]');
  if (authScreenFix && !authScreenFix.hasAttribute('style') && authScreenFix.getAttribute('styl')) {
    authScreenFix.setAttribute('style', authScreenFix.getAttribute('styl'));
    authScreenFix.removeAttribute('styl');
  }

  const ageGate = $("ageGate");
  const auth = $("authScreen");
  const mainUI = $("mainUI");

  if (getSession() && window.__ageGatePassed) {
    if (ageGate) hide(ageGate);
    if (auth) hide(auth);
    if (mainUI) {
      mainUI.style.display = mainUI.dataset.display || 'block';
      mainUI.style.visibility = 'visible';
      mainUI.style.pointerEvents = '';
    }
    document.querySelectorAll('.modal, .popup, .modal-overlay, #introGif').forEach(el => {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.opacity === '0') el.style.pointerEvents = 'none';
    });
    return;
  }

  if (ageGate && !window.__ageGatePassed) {
    ageGate.style.display = 'flex';
    ageGate.style.opacity = '1';
    ageGate.style.pointerEvents = 'auto';
    ageGate.dataset.display = 'flex';
  } else if (ageGate && window.__ageGatePassed) {
    hide(ageGate);
  }

  if (auth) {
    auth.style.display = 'none';
    auth.dataset.display = auth.dataset.display || 'flex';
  }

  if (mainUI) {
    mainUI.style.display = 'none';
    mainUI.dataset.display = mainUI.dataset.display || 'block';
    mainUI.style.visibility = 'hidden';
    mainUI.style.pointerEvents = 'none';
  }

  document.querySelectorAll('.modal, .popup, .modal-overlay, #introGif').forEach(el => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.opacity === '0') el.style.pointerEvents = 'none';
  });
}

/* ---------------------------
   confirmAgeAndProceed (always show auth screen)
   --------------------------- */
function confirmAgeAndProceed() {
  window.__ageGatePassed = true;
  const ageGate = $("ageGate");
  const introGif = $("introGif");
  const authScreen = $("authScreen");
  const mainUI = $("mainUI");

  if (introGif) {
    introGif.style.backgroundImage = "url('/images/intro.gif')";
    introGif.style.opacity = '1';
    introGif.style.display = 'block';
  }

  if (ageGate) {
    ageGate.style.transition = 'opacity 0.6s';
    ageGate.style.opacity = '0';
    setTimeout(() => { ageGate.style.display = 'none'; }, 650);
  }

  setTimeout(() => {
    if (authScreen) {
      authScreen.dataset.display = 'flex';
      authScreen.style.display = 'flex';
      authScreen.style.opacity = '1';
      authScreen.style.visibility = 'visible';
      authScreen.style.pointerEvents = '';
    }
    if (mainUI) {
      mainUI.style.display = 'none';
      mainUI.style.visibility = 'hidden';
      mainUI.style.pointerEvents = 'none';
    }
    if (introGif) setTimeout(() => { introGif.style.opacity = '0'; setTimeout(()=> introGif.style.display='none',600); }, 5000);
  }, 700);
}
window.confirmAgeAndProceed = confirmAgeAndProceed;

/* ---------------------------
   Socket.IO (defensive)
   --------------------------- */
let socket = null;
function initSocket() {
  if (socket) return;
  if (typeof io === "undefined") {
    console.warn('socket.io client not loaded');
    return;
  }
  try {
    socket = io({
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      upgrade: true,
      timeout: 5000
    });

    socket.on('connect', () => {
      const s = getSession();
      if (s) socket.emit('identify', { username: s.username, display: s.display });
    });

    socket.on('connect_error', (err) => {
      fetchInitialData();
    });

    socket.on('presence', users => {
      window.__users = Array.isArray(users) ? users : [];
      renderOnlineList();
    });

    socket.on('publicMessage', msg => {
      const s = getSession();
      if (s && msg.from === s.username) return;
      appendPublicMessage(msg);
    });

    socket.on('roomsList', rooms => {
      window.__rooms = Array.isArray(rooms) ? rooms : [];
      renderRoomsSidebar();
    });

    socket.on('roomMessage', msg => appendRoomMessage(msg));
    socket.on('roomHistory', msgs => {
      const feed = $("roomFeed");
      if (!feed) return;
      feed.innerHTML = "";
      (msgs || []).forEach(m => appendRoomMessage(m));
    });

    socket.on('typingRoom', ({ from, room }) => {
      const currentRoom = $("roomChatPopup")?.dataset?.room;
      if (currentRoom === room) {
        const el = $("roomTyping");
        if (el) { el.textContent = `${from} is typing...`; el.style.display = "block"; }
      }
    });

    socket.on('stopTypingRoom', ({ from, room }) => {
      const currentRoom = $("roomChatPopup")?.dataset?.room;
      if (currentRoom === room) {
        const el = $("roomTyping");
        if (el) el.style.display = "none";
      }
    });

  } catch (e) {
    fetchInitialData();
  }
}

/* ---------------------------
   UI state management
   --------------------------- */
function updateUIForSession() {
  const s = getSession();
  const authScreen = $("authScreen");
  const mainUI = $("mainUI");
  const ageGate = $("ageGate");
  const chatLabel = $("chatUserLabel");

  if (s) {
    if (!window.__ageGatePassed) {
      if (mainUI) {
        mainUI.style.display = 'none';
        mainUI.style.visibility = 'hidden';
        mainUI.style.pointerEvents = 'none';
      }
      if (authScreen) authScreen.style.display = 'none';
      return;
    }

    if (ageGate) hide(ageGate);
    if (authScreen) hide(authScreen);
    if (mainUI) {
      show(mainUI);
      mainUI.style.visibility = 'visible';
      mainUI.style.pointerEvents = '';
    }
    if (chatLabel) chatLabel.textContent = s.display || s.username || "You";
    initSocket();
    requestInitialRealtimeState();
    fetchInitialData();
  } else {
    if (mainUI) {
      mainUI.style.display = 'none';
      mainUI.style.visibility = 'hidden';
      mainUI.style.pointerEvents = 'none';
    }
  }
}

/* ---------------------------
   Public messages
   --------------------------- */
async function loadPublicMessages() {
  try {
    const res = await fetch("/api/public-messages");
    if (!res.ok && res.status !== 304) return;
    const data = await res.json().catch(()=>({messages:[]}));
    const feed = $("publicFeed");
    if (!feed) return;
    feed.innerHTML = "";
    (data.messages || []).forEach(appendPublicMessage);
  } catch (err) {
    // ignore
  }
}
function appendPublicMessage(msg) {
  const feed = $("publicFeed");
  if (!feed) return;
  const s = getSession();
  const isMe = s && msg.from === s.username;
  const row = document.createElement("div");
  row.className = "message-row";
  row.innerHTML = `
    <div class="message-avatar">
      ${msg.imageUrl ? `<img src="${msg.imageUrl}" alt="avatar" style="width:36px;height:36px;border-radius:50%">` : `<div class="avatar-fallback" style="width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center">${(msg.display||msg.from||"U").charAt(0)}</div>`}
    </div>
    <div class="message" ${isMe ? 'style="border-color:rgba(124,58,237,0.5)"' : ""}>
      <div style="font-weight:700;color:${msg.color||'#7fd8ff'}">
        ${escapeHtml(msg.display || msg.from)}
        <span class="small" style="color:#94a3b8">@${escapeHtml(msg.from)} • ${new Date(msg.time).toLocaleTimeString()}</span>
      </div>
      <div>${escapeHtml(msg.text || "")}</div>
    </div>
  `;
  feed.appendChild(row);
  feed.scrollTop = feed.scrollHeight;
}
function sendPublicMessage() {
  const input = $("publicMessage");
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  const s = getSession();
  if (!s) return alert("You must be logged in to send messages.");
  const msg = {
    from: s.username,
    display: s.display || s.username,
    text,
    time: new Date().toISOString(),
    imageUrl: s.imageUrl || null,
    color: s.color || null
  };
  if (socket) socket.emit("publicMessage", msg);
  else fetch("/api/public-messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(msg) });
  appendPublicMessage(msg);
  input.value = "";
}

/* ---------------------------
   Rooms, roster, profile
   --------------------------- */
function renderOnlineList() {
  const el = $("onlineList");
  if (!el) return;
  el.innerHTML = "";
  const users = window.__users || [];
  users.forEach(u => {
    const row = document.createElement("div");
    row.className = "user-row";
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.gap = "10px";
    row.style.padding = "8px 0";
    row.innerHTML = `
      <div style="width:36px;height:36px;border-radius:50%;overflow:hidden">
        ${u.imageUrl ? `<img src="${u.imageUrl}" style="width:36px;height:36px">` : `<div style="width:36px;height:36px;background:#0f172a;display:flex;align-items:center;justify-content:center">${(u.display||u.username||"U").charAt(0)}</div>`}
      </div>
      <div style="flex:1">
        <div style="font-weight:700">${escapeHtml(u.display || u.username)}</div>
        <div class="small" style="color:#94a3b8">@${escapeHtml(u.username)}</div>
      </div>
      <div style="font-size:12px;color:${u.online ? '#34d399' : '#94a3b8'}">${u.online ? 'online' : 'offline'}</div>
    `;
    row.onclick = () => openPrivateWindow(u.username);
    el.appendChild(row);
  });
}

function openPrivateWindow(username) {
  const dmPopup = $("dmPopup");
  if (dmPopup) {
    dmPopup.dataset.partner = username;
    const title = dmPopup.querySelector(".dm-title");
    if (title) title.textContent = `DM • ${username}`;
    loadDMHistory(username).then(() => show(dmPopup));
    return;
  }
  if ($("modalViewProfile")) {
    loadProfile(username);
    return;
  }
  alert("Open DM with " + username);
}

async function loadDMHistory(username) {
  try {
    const res = await fetch(`/api/dm/history/${encodeURIComponent(username)}`);
    if (!res.ok) return;
    const data = await res.json();
    const container = $("dmMessages");
    if (!container) return;
    container.innerHTML = "";
    (data.messages || []).forEach(m => {
      const div = document.createElement("div");
      div.className = "message-row";
      div.innerHTML = `
        <div class="message-avatar">${m.imageUrl ? `<img src="${m.imageUrl}" style="width:36px;height:36px;border-radius:50%">` : `<div class="avatar-fallback" style="width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center">${(m.display||m.from||"U").charAt(0)}</div>`}</div>
        <div class="message"><div style="font-weight:700">${escapeHtml(m.display||m.from)} <span class="small">@${escapeHtml(m.from)}</span></div><div>${escapeHtml(m.text)}</div></div>
      `;
      container.appendChild(div);
    });
    container.scrollTop = container.scrollHeight;
  } catch (err) {
    // ignore
  }
}

function renderRoomsSidebar() {
  const list = $("roomsList");
  if (!list) return;
  list.innerHTML = "";
  const rooms = window.__rooms || [];
  rooms.forEach(r => {
    const div = document.createElement("div");
    div.className = "room-item";
    div.textContent = `${r.private ? "🔒 " : ""}${r.name}`;
    div.onclick = () => openRoomPopup(r._id, r.name);
    list.appendChild(div);
  });
}

function openRoomPopup(roomId, roomName) {
  const popup = $("roomChatPopup");
  if (!popup) return;
  popup.dataset.room = roomId;
  const title = $("roomChatTitle");
  if (title) title.textContent = roomName;
  show(popup);
  if (socket) {
    socket.emit("joinRoom", { room: roomId });
    socket.emit("requestRoomHistory", { room: roomId });
    socket.emit("requestRoomMembers", { room: roomId });
  } else {
    fetch(`/api/rooms/${encodeURIComponent(roomId)}/history`).then(r => r.json()).then(data => {
      const feed = $("roomFeed");
      if (!feed) return;
      feed.innerHTML = "";
      (data.messages || []).forEach(appendRoomMessage);
    }).catch(()=>{});
  }
}

function closeRoomPopup() {
  const popup = $("roomChatPopup");
  if (!popup) return;
  const room = popup.dataset.room;
  if (room && socket) socket.emit("leaveRoom", { room });
  hide(popup);
}

function appendRoomMessage(msg) {
  const feed = $("roomFeed");
  if (!feed) return;
  const div = document.createElement("div");
  div.className = "message-row";
  div.innerHTML = `
    <div class="message-avatar">
      ${msg.imageUrl ? `<img src="${msg.imageUrl}" style="width:36px;height:36px;border-radius:50%">` : `<div class="avatar-fallback" style="width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center">${(msg.display||msg.from||"U").charAt(0)}</div>`}
    </div>
    <div class="message">
      <div style="font-weight:700;color:${msg.color||'#7fd8ff'}">${escapeHtml(msg.display || msg.from)} <span class="small" style="color:#94a3b8">@${escapeHtml(msg.from)}</span></div>
      <div>${escapeHtml(msg.text || "")}</div>
    </div>
  `;
  feed.appendChild(div);
  feed.scrollTop = feed.scrollHeight;
}

/* ---------------------------
   Roster / View Profile (IDs matched to provided markup)
   --------------------------- */
(function bindRosterAndProfile() {
  const rosterModal = $("modalRoster");
  const rosterSearch = $("rosterSearch");
  const rosterPageEl = $("rosterPage");
  const rosterClose = $("rosterClose");
  const rosterPrev = $("rosterPrev");
  const rosterNext = $("rosterNext");
  const rosterPageNumber = $("rosterPageNumber");

  const vpModal = $("modalViewProfile");
  const vpName = $("vpName");
  const vpClose = $("vpClose");
  const vpAvatar = $("vpAvatar");
  const vpUsername = $("vpUsername");
  const vpBio = $("vpBio");
  const vpWins = $("vpWins");
  const vpLosses = $("vpLosses");
  const vpColorBox = $("vpColorBox");
  const vpLang = $("vpLang");
  const vpAge = $("vpAge");
  const vpDMButton = $("vpDMButton");
  const vpBlockButton = $("vpBlockButton");

  if (!rosterPageEl) return;

  let rosterItems = [];
  let rosterPageIndex = 0;
  const PAGE_SIZE = 12;

  function renderRosterPage() {
    rosterPageEl.innerHTML = '';
    const start = rosterPageIndex * PAGE_SIZE;
    const pageItems = rosterItems.slice(start, start + PAGE_SIZE);
    pageItems.forEach(u => {
      const row = document.createElement('div');
      row.className = 'roster-row';
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.justifyContent = 'space-between';
      row.style.padding = '8px';
      row.style.borderBottom = '1px solid rgba(255,255,255,0.03)';
      row.innerHTML = `
        <div style="display:flex;align-items:center;gap:12px;flex:1;min-width:0">
          <div style="width:44px;height:44px;border-radius:8px;overflow:hidden;flex:0 0 44px">
            ${u.imageUrl ? `<img src="${u.imageUrl}" style="width:44px;height:44px;object-fit:cover">` : `<div style="width:44px;height:44px;background:#0f172a;display:flex;align-items:center;justify-content:center;color:#9fb7ff">${(u.display||u.username||'U').charAt(0)}</div>`}
          </div>
          <div style="flex:1;min-width:0">
            <div style="font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(u.display || u.username)}</div>
            <div class="small muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">@${escapeHtml(u.username)}</div>
          </div>
        </div>
        <div style="flex:0 0 auto;margin-left:12px">
          <button class="small-btn roster-view-btn" data-username="${escapeHtml(u.username)}">View</button>
        </div>
      `;
      rosterPageEl.appendChild(row);
    });

    const totalPages = Math.max(1, Math.ceil(rosterItems.length / PAGE_SIZE));
    if (rosterPageNumber) rosterPageNumber.textContent = `${rosterPageIndex + 1} / ${totalPages}`;
    if (rosterPrev) rosterPrev.disabled = rosterPageIndex === 0;
    if (rosterNext) rosterNext.disabled = rosterPageIndex >= totalPages - 1;

    rosterPageEl.querySelectorAll('.roster-view-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const username = btn.dataset.username;
        if (!username) return;
        loadProfile(username);
      });
    });
  }

  async function fetchRoster(query = '') {
    try {
      const url = query ? `/api/roster?search=${encodeURIComponent(query)}` : '/api/roster';
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json().catch(()=>({users:[]}));
      rosterItems = data.users || [];
      rosterPageIndex = 0;
      renderRosterPage();
    } catch (err) {
      // ignore
    }
  }

  const onSearch = debounce(() => {
    const q = rosterSearch?.value?.trim() || '';
    fetchRoster(q);
  }, 300);

  if (rosterPrev) rosterPrev.addEventListener('click', (e) => { e.preventDefault(); if (rosterPageIndex>0) { rosterPageIndex--; renderRosterPage(); } });
  if (rosterNext) rosterNext.addEventListener('click', (e) => { e.preventDefault(); const totalPages = Math.ceil(rosterItems.length / PAGE_SIZE); if (rosterPageIndex < totalPages - 1) { rosterPageIndex++; renderRosterPage(); } });

  if (rosterClose) rosterClose.addEventListener('click', (e) => { e.preventDefault(); if (rosterModal) hide(rosterModal); });

  if (rosterSearch) rosterSearch.addEventListener('input', onSearch);

  window.openRosterModal = function openRosterModal() {
    if (rosterModal) show(rosterModal);
    fetchRoster('');
    if (rosterSearch) rosterSearch.value = '';
  };

  function populateProfileModal(profile = {}) {
    if (vpName) vpName.textContent = profile.display || profile.username || 'Unknown';
    if (vpAvatar) vpAvatar.src = profile.imageUrl || '/images/default-avatar.png';
    if (vpUsername) vpUsername.textContent = profile.username || '';
    if (vpBio) vpBio.textContent = profile.info || '';
    if (vpWins) vpWins.textContent = (profile.wins != null) ? String(profile.wins) : '0';
    if (vpLosses) vpLosses.textContent = (profile.losses != null) ? String(profile.losses) : '0';
    if (vpColorBox) vpColorBox.style.background = profile.color || 'transparent';
    if (vpLang) vpLang.textContent = profile.language || '';
    if (vpAge) vpAge.textContent = profile.age != null ? String(profile.age) : '';
    if (vpModal) vpModal.dataset.username = profile.username || '';
  }

  const originalLoadProfile = window.loadProfile;
  window.loadProfile = async function (username) {
    if (!username) return;
    try {
      if (typeof originalLoadProfile === 'function') {
        await originalLoadProfile(username);
        if (vpModal) show(vpModal);
        return;
      }
      const res = await fetch(`/api/user/${encodeURIComponent(username)}`);
      if (!res.ok) return;
      const data = await res.json();
      if (!data.user) return;
      populateProfileModal(data.user);
      if (vpModal) show(vpModal);
    } catch (err) {
      // ignore
    }
  };

  if (vpClose) vpClose.addEventListener('click', (e) => { e.preventDefault(); if (vpModal) hide(vpModal); });

  if (vpDMButton) vpDMButton.addEventListener('click', (e) => {
    e.preventDefault();
    const username = vpModal?.dataset?.username;
    if (!username) return;
    if (typeof openPrivateWindow === 'function') {
      openPrivateWindow(username);
      if (vpModal) hide(vpModal);
      return;
    }
    const dmPopup = $("dmPopup");
    if (dmPopup) {
      dmPopup.dataset.partner = username;
      show(dmPopup);
      if (vpModal) hide(vpModal);
    }
  });

  if (vpBlockButton) vpBlockButton.addEventListener('click', async (e) => {
    e.preventDefault();
    const username = vpModal?.dataset?.username;
    if (!username) return;
    if (!confirm(`Block ${username}?`)) return;
    try {
      const res = await fetch('/api/block', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ user: username }) });
      if (!res.ok) return alert('Failed to block user');
      alert(`${username} blocked`);
      if (vpModal) hide(vpModal);
    } catch (err) {
      alert('Network error while blocking user');
    }
  });

  window.showRoster = () => { if (rosterModal) show(rosterModal); fetchRoster(''); };

  if (rosterModal && getComputedStyle(rosterModal).display !== 'none') fetchRoster('');
})();

/* ---------------------------
   Fetch initial data after login
   --------------------------- */
async function fetchInitialData() {
  try {
    const [usersRes, roomsRes, messagesRes] = await Promise.allSettled([
      fetch("/api/users"),
      fetch("/api/rooms"),
      fetch("/api/public-messages")
    ]);

    if (usersRes.status === 'fulfilled' && usersRes.value.ok) {
      const usersData = await usersRes.value.json().catch(()=>({users:[]}));
      window.__users = usersData.users || [];
    } else {
      window.__users = window.__users || [];
    }

    if (roomsRes.status === 'fulfilled' && roomsRes.value.ok) {
      const roomsData = await roomsRes.value.json().catch(()=>({rooms:[]}));
      window.__rooms = roomsData.rooms || [];
    } else {
      window.__rooms = window.__rooms || [];
    }

    if (messagesRes.status === 'fulfilled' && messagesRes.value.ok) {
      const messagesData = await messagesRes.value.json().catch(()=>({messages:[]}));
      const feed = $("publicFeed");
      if (feed) {
        feed.innerHTML = "";
        (messagesData.messages || []).forEach(appendPublicMessage);
      }
    }

    renderOnlineList();
    renderRoomsSidebar();
  } catch (err) {
    // ignore
  }
}

/* ---------------------------
   Server session check (OAuth)
   --------------------------- */
async function checkServerSession() {
  try {
    const res = await fetch("/api/session");
    if (!res.ok) return;
    const data = await res.json();
    if (data && data.user) {
      setSession(data.user);
      updateUIForSession();
    }
  } catch (err) {
    // ignore
  }
}

/* ---------------------------
   Logout
   --------------------------- */
async function logout() {
  try {
    await fetch("/api/logout", { method: "POST" });
  } catch (e) {}
  setSession(null);
  hide($("mainUI"));
  if ($("authScreen")) show($("authScreen"));
  if (socket) {
    try { socket.disconnect(); } catch (e) {}
    socket = null;
  }
}

/* ---------------------------
   Defensive bindings and startup
   --------------------------- */
document.addEventListener('DOMContentLoaded', () => {
  ensureStartupVisibility();

  // AgeGate confirm binding
  (function bindAgeGate() {
    const candidates = ['confirmBtn', '[data-age-confirm]', '.age-confirm', '#ageGate button'];
    let btn = null;
    for (const sel of candidates) {
      btn = document.getElementById(sel.replace(/^#/, '')) || document.querySelector(sel);
      if (btn) break;
    }
    if (!btn) return;
    if (btn.tagName.toLowerCase() === 'button') btn.type = 'button';
    const fresh = btn.cloneNode(true);
    btn.parentNode.replaceChild(fresh, btn);
    fresh.addEventListener('click', (e) => {
      e.preventDefault();
      if (typeof confirmAgeAndProceed === 'function') return confirmAgeAndProceed();
      window.__ageGatePassed = true;
      const ageGate = $("ageGate");
      const authScreen = $("authScreen");
      if (ageGate) { ageGate.style.opacity = '0'; setTimeout(()=> ageGate.style.display = 'none', 600); }
      if (authScreen) { authScreen.dataset.display = 'flex'; authScreen.style.display = 'flex'; }
    });
  })();

  // Auth modal openers (defensive)
  (function bindAuthModals() {
    // Register opener (robust)
    (function rebindRegisterOpener() {
      const selectors = ['#btnRegister', '#registerBtn', '.btn-register', '[data-open-register]'];
      let btn = null;
      for (const s of selectors) {
        btn = document.getElementById(s.replace(/^#/, '')) || document.querySelector(s);
        if (btn) { console.log('register selector matched:', s); break; }
      }
      if (!btn) return console.warn('Register open button not found');
      try {
        if (btn.tagName.toLowerCase() === 'button') btn.type = 'button';
        const fresh = btn.cloneNode(true);
        btn.parentNode.replaceChild(fresh, btn);
        fresh.addEventListener('click', (e) => {
          e.preventDefault();
          const auth = document.getElementById('authScreen');
          if (auth && getComputedStyle(auth).display === 'none') {
            auth.style.display = 'flex';
            auth.style.visibility = 'visible';
            auth.style.pointerEvents = 'auto';
          }
          showModalById('modalRegister');
        });
      } catch (err) {
        console.error('Error binding register opener', err);
      }
    })();

    // Login opener
    (function bindLoginOpener() {
      const selectors = ['#btnLogin', '#loginBtn', '.btn-login', '[data-open-login]'];
      let btn = null;
      for (const s of selectors) {
        btn = document.getElementById(s.replace(/^#/, '')) || document.querySelector(s);
        if (btn) break;
      }
      if (!btn) return;
      if (btn.tagName.toLowerCase() === 'button') btn.type = 'button';
      const fresh = btn.cloneNode(true);
      btn.parentNode.replaceChild(fresh, btn);
      fresh.addEventListener('click', (e) => {
        e.preventDefault();
        const auth = document.getElementById('authScreen');
        if (auth && getComputedStyle(auth).display === 'none') {
          auth.style.display = 'flex';
          auth.style.visibility = 'visible';
          auth.style.pointerEvents = 'auto';
        }
        showModalById('modalLogin');
      });
    })();

    // Discord opener
    (function bindDiscordOpener() {
      const selectors = ['#btnDiscordLogin', '.discord-login', '[data-discord-login]'];
      let btn = null;
      for (const s of selectors) {
        btn = document.getElementById(s.replace(/^#/, '')) || document.querySelector(s);
        if (btn) break;
      }
      if (!btn) return;
      if (btn.tagName.toLowerCase() === 'button') btn.type = 'button';
      const fresh = btn.cloneNode(true);
      btn.parentNode.replaceChild(fresh, btn);
      fresh.addEventListener('click', (e) => {
        e.preventDefault();
        window.location.href = '/auth/discord';
      });
    })();

    // Cancel buttons inside modals
    const loginCancel = $("loginCancel");
    if (loginCancel) { loginCancel.type = 'button'; loginCancel.addEventListener('click', (e) => { e.preventDefault(); hideModalById('modalLogin'); }); }
    const regCancel = $("regCancel");
    if (regCancel) { regCancel.type = 'button'; regCancel.addEventListener('click', (e) => { e.preventDefault(); hideModalById('modalRegister'); }); }

    // clicking outside modal content closes it
    document.querySelectorAll('.modal').forEach(modal => {
      modal.addEventListener('click', (ev) => {
        if (ev.target === modal) hideModalById(modal.id);
      });
    });
  })();

  // Helper to find element by id or selector
  const find = (ids) => {
    for (const id of ids) {
      let el = document.getElementById(id);
      if (el) return el;
      el = document.querySelector(id);
      if (el) return el;
    }
    return null;
  };

  // Login submit binding
  (function bindLogin() {
    const loginBtn = find(['loginSubmit', '#loginSubmit', '.login-submit', '[data-login-submit]']);
    if (!loginBtn) return;
    if (loginBtn.tagName.toLowerCase() === 'button') loginBtn.type = 'button';
    const freshLogin = loginBtn.cloneNode(true);
    loginBtn.parentNode.replaceChild(freshLogin, loginBtn);
    freshLogin.addEventListener('click', async (e) => {
      e.preventDefault();
      if (typeof handleLoginClick === 'function') return handleLoginClick(e);
    });
  })();

  // Register submit binding (ensures regSubmit calls handler)
  (function bindRegisterSubmit() {
    const regBtn = find(['regSubmit', '#regSubmit', '.reg-submit', '[data-reg-submit]']);
    if (!regBtn) return;
    if (regBtn.tagName.toLowerCase() === 'button') regBtn.type = 'button';
    const freshReg = regBtn.cloneNode(true);
    regBtn.parentNode.replaceChild(freshReg, regBtn);
    freshReg.addEventListener('click', async (e) => {
      e.preventDefault();
      if (typeof handleRegisterClick === 'function') return handleRegisterClick(e);
      alert('Registration handler missing.');
    });
  })();

  // Defensive binding for support submit
  const srBtn = $("srSubmit");
  if (srBtn) {
    srBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      try {
        if (typeof window.submitSupportReport === 'function') {
          await window.submitSupportReport();
        } else if (typeof submitSupportReport === 'function') {
          await submitSupportReport();
        } else {
          console.warn('submitSupportReport is not defined. Support submit aborted.');
          const err = $("srError");
          if (err) { err.textContent = 'Support feature temporarily unavailable.'; err.style.display = 'block'; }
        }
      } catch (err) {
        console.error('Error running submitSupportReport:', err);
      }
    });
  }

  // Other UI bindings
  on($("btnOpenChat"), "click", () => { show($("chatPopup")); loadPublicMessages(); renderOnlineList(); });
  on($("btnCloseChat"), "click", () => hide($("chatPopup")));
  on($("btnMinimize"), "click", () => {
    const cp = $("chatPopup");
    if (!cp) return;
    cp.style.display = cp.style.display === "none" ? "flex" : "none";
  });
  on($("sendPublic"), "click", sendPublicMessage);
  on($("publicMessage"), "keydown", e => { if (e.key === "Enter") sendPublicMessage(); });

  on($("btnDMs"), "click", () => show($("dmSidebar")));
  on($("btnRoster"), "click", () => {
    show($("modalRoster"));
    try {
      if (typeof window.loadRoster === 'function') window.loadRoster();
      else if (typeof loadRoster === 'function') loadRoster();
    } catch (err) {
      console.error('Error calling loadRoster:', err);
    }
    if (typeof window.openRosterModal === 'function') window.openRosterModal();
  });

  on($("btnRooms"), "click", () => { show($("roomsPanel")); if (socket) socket.emit("requestRooms"); else fetchInitialData(); });

  on($("openSupport"), "click", () => showModalById("supportPopup"));
  on($("closeSupport"), "click", () => hideModalById("supportPopup"));

  on($("roomSendBtn"), "click", () => {
    const text = $("roomMessageInput")?.value?.trim();
    const room = $("roomChatPopup")?.dataset?.room;
    const s = getSession();
    if (!text || !room || !s) return;
    if (socket) socket.emit("roomMessage", { room, from: s.username, text });
    appendRoomMessage({ from: s.username, display: s.display || s.username, text, time: new Date().toISOString() });
    $("roomMessageInput").value = "";
  });

  on($("roomMessageInput"), "input", debounce(() => {
    const room = $("roomChatPopup")?.dataset?.room;
    const s = getSession();
    if (!room || !s || !socket) return;
    socket.emit("typingRoom", { room, from: s.username });
  }, 300));

  on($("roomMessageInput"), "blur", () => {
    const room = $("roomChatPopup")?.dataset?.room;
    const s = getSession();
    if (!room || !s || !socket) return;
    socket.emit("stopTypingRoom", { room, from: s.username });
  });

  on($("closeRoomChat"), "click", closeRoomPopup);

  on($("openProfile"), "click", () => showModalById("modalViewProfile"));
  on($("closeViewProfile"), "click", () => hideModalById("modalViewProfile"));
  on($("openEditProfile"), "click", () => showModalById("modalEditProfile"));
  on($("closeEditProfile"), "click", () => hideModalById("modalEditProfile"));

  on($("btnAdmin"), "click", () => { showModalById("modalAdmin"); loadAdminData(); });
  on($("closeAdmin"), "click", () => hideModalById("modalAdmin"));

  if ($("btnLogout")) on($("btnLogout"), "click", logout);

  checkServerSession();
});

/* ---------------------------
   Utility: request presence/rooms
   --------------------------- */
function requestInitialRealtimeState() {
  if (!socket) return;
  socket.emit("requestPresence");
  socket.emit("requestRooms");
}

/* ---------------------------
   Expose debug API and ensure functions available globally
   --------------------------- */
window.__cw = window.__cw || {};
Object.assign(window.__cw, {
  getSession,
  setSession,
  logout,
  show,
  hide,
  initSocket,
  fetchInitialData,
  loadRoster: window.loadRoster || (typeof loadRoster === 'function' ? loadRoster : undefined),
  loadProfile: window.loadProfile || (typeof loadProfile === 'function' ? loadProfile : undefined),
  openRoomPopup,
  renderOnlineList,
  renderRoomsSidebar
});
if (typeof loadRoster === 'function') window.loadRoster = loadRoster;

/* ---------------------------
   Visibility change handling
   --------------------------- */
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && socket && getSession()) {
    try { socket.emit("userHidden", { username: getSession().username }); } catch (e) {}
  }
});

/* ---------------------------
   If session exists on load, initialize (but respect age gate)
   --------------------------- */
if (getSession() && window.__ageGatePassed) {
  updateUIForSession();
}

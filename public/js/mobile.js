/* =========================================================================
   mobile.js — Patched full client (updated)
   - Fixes authScreen inline-style typo at runtime
   - Ensures Login/Register/Discord buttons open modals reliably
   - Defensive bindings and robust socket init with logging and fallback
   - All UI handlers attached after DOMContentLoaded
   ========================================================================= */

/* ---------------------------
   Lightweight DOM helpers
   --------------------------- */
const $ = id => document.getElementById(id);
const show = el => { if (!el) return; el.style.display = el.dataset.display || "flex"; };
const hide = el => { if (!el) return; el.style.display = "none"; };
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
      console.log('socket connected', socket.id);
      const s = getSession();
      if (s) socket.emit('identify', { username: s.username, display: s.display });
    });

    socket.on('connect_error', (err) => {
      console.error('socket connect_error', err && err.message, err);
      fetchInitialData(); // fallback to REST
    });

    socket.on('error', (err) => {
      console.error('socket error', err);
    });

    socket.on('disconnect', (reason) => {
      console.warn('socket disconnected', reason);
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
    console.error('initSocket exception', e);
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
    if (ageGate) hide(ageGate);
    if (authScreen) hide(authScreen);
    if (mainUI) show(mainUI);
    if (chatLabel) chatLabel.textContent = s.display || s.username || "You";
    initSocket();
    requestInitialRealtimeState();
    fetchInitialData();
  } else {
    if (mainUI) hide(mainUI);
    // authScreen remains controlled by age gate flow
  }
}

/* ---------------------------
   Initial visibility normalization
   --------------------------- */
function ensureStartupVisibility() {
  // If a session exists, do not force the age gate visible
  if (getSession()) {
    // still normalize overlays so hidden ones don't block clicks
    document.querySelectorAll('.modal, .popup, .modal-overlay, #introGif').forEach(el => {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.opacity === '0') el.style.pointerEvents = 'none';
    });
    return;
  }

  // Fix common HTML typo: styl -> style on authScreen
  const authScreen = document.querySelector('[id="authScreen"]');
  if (authScreen && !authScreen.hasAttribute('style') && authScreen.getAttribute('styl')) {
    authScreen.setAttribute('style', authScreen.getAttribute('styl'));
    authScreen.removeAttribute('styl');
  }

  const ageGate = $("ageGate");
  const mainUI = $("mainUI");

  if (ageGate) {
    ageGate.style.display = 'flex';
    ageGate.style.opacity = '1';
    ageGate.style.pointerEvents = 'auto';
    ageGate.dataset.display = 'flex';
  }
  if (authScreen) {
    if (!authScreen.style.display || authScreen.style.display === '') authScreen.style.display = 'none';
    authScreen.dataset.display = authScreen.dataset.display || 'flex';
  }
  if (mainUI) {
    mainUI.style.display = 'none';
    mainUI.dataset.display = 'block';
  }

  document.querySelectorAll('.modal, .popup, .modal-overlay, #introGif').forEach(el => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.opacity === '0') el.style.pointerEvents = 'none';
  });
}

/* ---------------------------
   AgeGate flow
   --------------------------- */
function confirmAgeAndProceed() {
  const ageGate = $("ageGate");
  const introGif = $("introGif");
  const authScreen = $("authScreen");

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
    }
    if (introGif) setTimeout(() => { introGif.style.opacity = '0'; setTimeout(()=> introGif.style.display='none',600); }, 5000);
  }, 700);
}

/* ---------------------------
   Public messages (arena)
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
    console.warn("Failed to load public messages", err);
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
   Online list rendering
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

/* ---------------------------
   DM / Private window (mobile)
   --------------------------- */
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
    console.warn("Failed to load DM history", err);
  }
}

/* ---------------------------
   Rooms: render, open, join, leave
   --------------------------- */
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
   Roster and profile loaders
   --------------------------- */
async function loadRoster() {
  try {
    const res = await fetch("/api/roster");
    if (!res.ok) return;
    const data = await res.json();
    const list = $("rosterList");
    if (!list) return;
    list.innerHTML = "";
    (data.users || []).forEach(u => {
      const div = document.createElement("div");
      div.className = "roster-user";
      div.innerHTML = `
        <div class="roster-avatar">${u.imageUrl ? `<img src="${u.imageUrl}" style="width:44px;height:44px;border-radius:50%">` : `<div style="width:44px;height:44px;background:#0f172a;display:flex;align-items:center;justify-content:center">${(u.display||u.username||"U").charAt(0)}</div>`}</div>
        <div style="flex:1">
          <div style="font-weight:700">${escapeHtml(u.display || u.username)}</div>
          <div class="small" style="color:#94a3b8">@${escapeHtml(u.username)}</div>
        </div>
      `;
      div.onclick = () => loadProfile(u.username);
      list.appendChild(div);
    });
  } catch (err) {
    console.warn("Failed to load roster", err);
  }
}

async function loadProfile(username) {
  try {
    const res = await fetch(`/api/user/${encodeURIComponent(username)}`);
    if (!res.ok) return;
    const data = await res.json();
    if (!data.user) return;
    const profile = data.user;
    if ($("viewProfileName")) $("viewProfileName").textContent = profile.display || profile.username;
    if ($("viewProfileBio")) $("viewProfileBio").textContent = profile.info || "";
    if ($("viewProfileAvatar")) {
      if (profile.imageUrl) $("viewProfileAvatar").src = profile.imageUrl;
      else $("viewProfileAvatar").src = "/images/default-avatar.png";
    }
    show($("modalViewProfile"));
  } catch (err) {
    console.warn("Failed to load profile", err);
  }
}

/* ---------------------------
   Support / admin helpers
   --------------------------- */
async function submitSupportReport() {
  const me = getSession();
  if (!me) return alert("You must be logged in to submit a report.");

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
      hide($("supportPopup"));
    } else {
      alert(data.error || "Failed to submit support request.");
    }
  } catch (err) {
    alert("Network error while submitting support request.");
  }
}

async function loadAdminData() {
  try {
    const res = await fetch("/api/admin/overview");
    if (!res.ok) return;
    const data = await res.json();
    const table = $("adminTableBody");
    if (!table) return;
    table.innerHTML = "";
    (data.rows || []).forEach(r => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${escapeHtml(r.id)}</td><td>${escapeHtml(r.username)}</td><td>${escapeHtml(r.action)}</td>`;
      table.appendChild(tr);
    });
  } catch (err) {
    console.warn("Failed to load admin data", err);
  }
}

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
    console.warn('fetchInitialData error', err);
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
   Modal helpers (show/hide by id)
   --------------------------- */
function showModalById(id) {
  const m = document.getElementById(id);
  if (!m) return console.warn('showModal: not found', id);
  m.dataset.display = m.dataset.display || (getComputedStyle(m).display === 'none' ? 'flex' : getComputedStyle(m).display);
  m.style.display = m.dataset.display;
}
function hideModalById(id) {
  const m = document.getElementById(id);
  if (!m) return;
  m.style.display = 'none';
}

/* ---------------------------
   Defensive bindings (AgeGate, Login, Register, Discord, UI)
   --------------------------- */
document.addEventListener('DOMContentLoaded', () => {
  ensureStartupVisibility();

  // AgeGate confirm binding (defensive)
  (function bindAgeGate() {
    const candidates = ['confirmBtn', '[data-age-confirm]', '.age-confirm', '#ageGate button'];
    let btn = null;
    for (const sel of candidates) {
      btn = document.getElementById(sel) || document.querySelector(sel);
      if (btn) break;
    }
    if (!btn) {
      console.warn('AgeGate confirm button not found');
    } else {
      if (btn.tagName.toLowerCase() === 'button') btn.type = 'button';
      const fresh = btn.cloneNode(true);
      btn.parentNode.replaceChild(fresh, btn);
      fresh.addEventListener('click', (e) => {
        e.preventDefault();
        console.log('AgeGate confirm clicked (defensive)');
        try {
          if (typeof confirmAgeAndProceed === 'function') return confirmAgeAndProceed();
          // fallback
          const ageGate = $("ageGate");
          const authScreen = $("authScreen");
          if (ageGate) { ageGate.style.opacity = '0'; setTimeout(()=> ageGate.style.display = 'none', 600); }
          if (authScreen) { authScreen.dataset.display = 'flex'; authScreen.style.display = 'flex'; }
        } catch (err) {
          console.error('confirm handler error', err);
          alert('Error during age confirmation: ' + (err && err.message ? err.message : 'unknown'));
        }
      });
    }
  })();

  // Wire Login/Register buttons to open modals (explicit)
  (function bindAuthModals() {
    const btnLogin = document.getElementById('btnLogin') || document.querySelector('.btn-login') || document.querySelector('[data-open-login]');
    const btnRegister = document.getElementById('btnRegister') || document.querySelector('.btn-register') || document.querySelector('[data-open-register]');
    const btnDiscord = document.getElementById('btnDiscordLogin') || document.querySelector('.discord-login') || document.querySelector('[data-discord-login]');

    if (btnLogin) {
      btnLogin.type = 'button';
      const fresh = btnLogin.cloneNode(true);
      btnLogin.parentNode.replaceChild(fresh, btnLogin);
      fresh.addEventListener('click', (e) => {
        e.preventDefault();
        showModalById('modalLogin');
      });
      console.log('btnLogin bound to modalLogin');
    } else console.warn('btnLogin not found');

    if (btnRegister) {
      btnRegister.type = 'button';
      const fresh = btnRegister.cloneNode(true);
      btnRegister.parentNode.replaceChild(fresh, btnRegister);
      fresh.addEventListener('click', (e) => {
        e.preventDefault();
        showModalById('modalRegister');
      });
      console.log('btnRegister bound to modalRegister');
    } else console.warn('btnRegister not found');

    if (btnDiscord) {
      btnDiscord.type = 'button';
      const fresh = btnDiscord.cloneNode(true);
      btnDiscord.parentNode.replaceChild(fresh, btnDiscord);
      fresh.addEventListener('click', (e) => {
        e.preventDefault();
        window.location.href = '/auth/discord';
      });
      console.log('btnDiscordLogin bound to /auth/discord');
    } else console.warn('btnDiscordLogin not found');

    // Wire cancel buttons inside modals
    const loginCancel = document.getElementById('loginCancel');
    if (loginCancel) {
      loginCancel.type = 'button';
      loginCancel.addEventListener('click', (e) => { e.preventDefault(); hideModalById('modalLogin'); });
    }
    const regCancel = document.getElementById('regCancel');
    if (regCancel) {
      regCancel.type = 'button';
      regCancel.addEventListener('click', (e) => { e.preventDefault(); hideModalById('modalRegister'); });
    }

    // clicking outside modal content closes it (if modal markup supports it)
    document.querySelectorAll('.modal').forEach(modal => {
      modal.addEventListener('click', (ev) => {
        if (ev.target === modal) hideModalById(modal.id);
      });
    });
  })();

  // Helper to find element by id or selector (used by other bindings)
  const find = (ids) => {
    for (const id of ids) {
      let el = document.getElementById(id);
      if (el) return el;
      el = document.querySelector(id);
      if (el) return el;
    }
    return null;
  };

  // Login binding (submit)
  (function bindLogin() {
    const loginBtn = find(['loginSubmit', '#loginSubmit', '.login-submit', '[data-login-submit]']);
    console.log('login selector matched:', loginBtn ? (loginBtn.id || loginBtn.className || loginBtn.tagName) : null);
    if (!loginBtn) return console.warn('loginSubmit not found');
    if (loginBtn.tagName.toLowerCase() === 'button') loginBtn.type = 'button';
    const freshLogin = loginBtn.cloneNode(true);
    loginBtn.parentNode.replaceChild(freshLogin, loginBtn);
    freshLogin.addEventListener('click', async (e) => {
      e.preventDefault();
      console.log('loginSubmit clicked');
      try {
        if (typeof handleLoginClick === 'function') return handleLoginClick();
        const username = document.getElementById('loginUser')?.value?.trim();
        const password = document.getElementById('loginPass')?.value?.trim();
        if (!username || !password) {
          const errEl = document.getElementById('loginError'); if (errEl) { errEl.textContent = 'Enter username and password'; errEl.style.display='block'; }
          return;
        }
        const res = await fetch('/api/login', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({username,password}) });
        const data = await res.json().catch(()=>({ok:false}));
        if (!data.ok) {
          const errEl = document.getElementById('loginError'); if (errEl) { errEl.textContent = data.error || 'Login failed'; errEl.style.display='block'; }
          return;
        }
        setSession(data.user || data);
        hideModalById('modalLogin');
        updateUIForSession();
      } catch (err) {
        console.error('login handler error', err);
        alert('Login error: ' + (err.message || 'unknown'));
      }
    });
  })();

  // Register binding (submit)
  (function bindRegister() {
    const regBtn = find(['regSubmit', '#regSubmit', '.reg-submit', '[data-reg-submit]']);
    console.log('register selector matched:', regBtn ? (regBtn.id || regBtn.className || regBtn.tagName) : null);
    if (!regBtn) return console.warn('regSubmit not found');
    if (regBtn.tagName.toLowerCase() === 'button') regBtn.type = 'button';
    const freshReg = regBtn.cloneNode(true);
    regBtn.parentNode.replaceChild(freshReg, regBtn);
    freshReg.addEventListener('click', async (e) => {
      e.preventDefault();
      console.log('regSubmit clicked');
      try {
        if (typeof handleRegisterClick === 'function') return handleRegisterClick();
        const payload = {
          username: document.getElementById('regUser')?.value?.trim(),
          email: document.getElementById('regEmail')?.value?.trim(),
          display: document.getElementById('regDisplay')?.value?.trim(),
          password: document.getElementById('regPass')?.value?.trim(),
          age: Number(document.getElementById('regAge')?.value || 0),
          color: document.getElementById('regColor')?.value || null,
          language: document.getElementById('regLanguage')?.value || null,
          wins: Number(document.getElementById('regWins')?.value || 0),
          losses: Number(document.getElementById('regLosses')?.value || 0),
          info: document.getElementById('regInfo')?.value?.trim(),
          imageUrl: document.getElementById('uploadStatus')?.dataset?.url || null
        };
        const res = await fetch('/api/register', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) });
        const data = await res.json().catch(()=>({ok:false}));
        if (!data.ok) {
          const errEl = document.getElementById('regError'); if (errEl) { errEl.textContent = data.error || 'Registration failed'; errEl.style.display='block'; }
          return;
        }
        setSession(data.user || data);
        hideModalById('modalRegister');
        updateUIForSession();
      } catch (err) {
        console.error('register handler error', err);
        alert('Registration error: ' + (err.message || 'unknown'));
      }
    });
  })();

  // Other UI bindings (open/close modals, chat, rooms, support)
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
  on($("btnRoster"), "click", () => { show($("modalRoster")); loadRoster(); });

  on($("btnRooms"), "click", () => { show($("roomsPanel")); if (socket) socket.emit("requestRooms"); else fetchInitialData(); });

  on($("openSupport"), "click", () => show($("supportPopup")));
  on($("closeSupport"), "click", () => hide($("supportPopup")));
  if ($("srSubmit")) on($("srSubmit"), "click", submitSupportReport);

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

  on($("openProfile"), "click", () => show($("modalViewProfile")));
  on($("closeViewProfile"), "click", () => hide($("modalViewProfile")));
  on($("openEditProfile"), "click", () => show($("modalEditProfile")));
  on($("closeEditProfile"), "click", () => hide($("modalEditProfile")));

  on($("btnAdmin"), "click", () => { show($("modalAdmin")); loadAdminData(); });
  on($("closeAdmin"), "click", () => hide($("modalAdmin")));

  if ($("btnLogout")) on($("btnLogout"), "click", logout);

  // Final safety: check server session (OAuth)
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
   Expose debug API
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
  loadRoster,
  loadProfile,
  openRoomPopup,
  renderOnlineList,
  renderRoomsSidebar
});

/* ---------------------------
   Visibility change handling
   --------------------------- */
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && socket && getSession()) {
    try { socket.emit("userHidden", { username: getSession().username }); } catch (e) {}
  }
});

/* ---------------------------
   If session exists on load, initialize
   --------------------------- */
if (getSession()) {
  updateUIForSession();
}

/* mobile.js — Section 1: Initialization and Helpers
   - Lightweight DOM helpers
   - Session storage helpers
   - Small utilities used across the app
   - Preserves all IDs used in your HTML
*/

const $ = id => document.getElementById(id);

const show = el => { if (!el) return; el.style.display = el.dataset.display || "flex"; };
const hide = el => { if (!el) return; el.style.display = "none"; };
const on = (el, ev, fn) => { if (!el) return; el.addEventListener(ev, fn); };

const SESSION_KEY = "cw_session_v1";

/* Session helpers */
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

/* Small utilities */
function escapeHtml(s) {
  if (!s) return "";
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

/* Ensure main UI hidden until login and age gate shown first */
// Ensure AgeGate is visible first and everything else hidden until flow proceeds
document.addEventListener("DOMContentLoaded", () => {
  const ageGate = document.getElementById("ageGate");
  const authScreen = document.getElementById("authScreen");
  const mainUI = document.getElementById("mainUI");

  if (ageGate) {
    ageGate.style.display = "flex";
    ageGate.style.opacity = "1";
    ageGate.style.pointerEvents = "auto";
    ageGate.dataset.display = "flex";
  }

  if (authScreen) {
    authScreen.style.display = "none";
    authScreen.dataset.display = "flex"; // so show() can restore to flex later
  }

  if (mainUI) {
    mainUI.style.display = "none";
    mainUI.dataset.display = "block"; // preserve intended display for later
  }
});
// Defensive AgeGate binding — paste into mobile.js inside DOMContentLoaded or at end of file
document.addEventListener('DOMContentLoaded', () => {
  const selectorCandidates = [
    'confirmBtn',
    '[data-age-confirm]',
    '.age-confirm',
    '#ageGate button'
  ];
  let btn = null;
  for (const sel of selectorCandidates) {
    btn = document.getElementById(sel) || document.querySelector(sel);
    if (btn) break;
  }
  if (!btn) return console.warn('AgeGate confirm button not found');

  // Ensure it's a button and not a submit that reloads the page
  if (btn.tagName.toLowerCase() === 'button') btn.type = 'button';

  // Replace node with clone to remove stale listeners, then attach fresh handler
  const fresh = btn.cloneNode(true);
  btn.parentNode.replaceChild(fresh, btn);

  fresh.addEventListener('click', (e) => {
    e.preventDefault();
    console.log('AgeGate confirm clicked (defensive)');
    try {
      if (typeof confirmAgeAndProceed === 'function') {
        return confirmAgeAndProceed();
      }
      // Fallback: hide age gate, show auth screen
      const ageGate = document.getElementById('ageGate');
      const authScreen = document.getElementById('authScreen');
      if (ageGate) { ageGate.style.opacity = '0'; setTimeout(()=> ageGate.style.display = 'none', 600); }
      if (authScreen) { authScreen.dataset.display = 'flex'; authScreen.style.display = 'flex'; }
    } catch (err) {
      console.error('confirm handler error', err);
      alert('Error during age confirmation: ' + (err && err.message ? err.message : 'unknown'));
    }
  });
});
function confirmAgeAndProceed() {
  console.log('confirmAgeAndProceed running');
  const ageGate = document.getElementById('ageGate');
  const introGif = document.getElementById('introGif');
  const authScreen = document.getElementById('authScreen');

  // show intro GIF briefly
  if (introGif) {
    introGif.style.backgroundImage = "url('/images/intro.gif')";
    introGif.style.opacity = '1';
    introGif.style.display = 'block';
  }

  // hide age gate with fade
  if (ageGate) {
    ageGate.style.transition = 'opacity 0.6s';
    ageGate.style.opacity = '0';
    setTimeout(() => { ageGate.style.display = 'none'; }, 650);
  }

  // show auth screen after short delay
  setTimeout(() => {
    if (authScreen) {
      authScreen.dataset.display = 'flex';
      authScreen.style.display = 'flex';
      authScreen.style.opacity = '1';
    }
    // hide introGif after a few seconds
    if (introGif) setTimeout(() => { introGif.style.opacity = '0'; setTimeout(()=> introGif.style.display='none',600); }, 5000);
  }, 700);
}

function normalizeHiddenOverlays() {
  document.querySelectorAll('.modal, .popup, .modal-overlay, #introGif').forEach(el => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.opacity === '0') {
      el.style.pointerEvents = 'none';
    } else {
      el.style.pointerEvents = '';
    }
  });
}
document.addEventListener('DOMContentLoaded', normalizeHiddenOverlays);
document.addEventListener('visibilitychange', normalizeHiddenOverlays);

/* mobile.js — Section 2: Socket.IO Initialization and Presence
   - Initializes socket connection
   - Handles connect/identify, presence updates, and core realtime events
   - Keeps a global users list in window.__users for other sections to use
*/

let socket = null;

function initSocket() {
  if (socket) return;
  if (typeof io === "undefined") return; // socket.io client not loaded

  socket = io();

  socket.on("connect", () => {
    const s = getSession();
    if (s) socket.emit("identify", { username: s.username, display: s.display });
  });

  // Presence: full user list (online/offline)
  socket.on("presence", users => {
    // normalize and store globally
    window.__users = Array.isArray(users) ? users : [];
    renderOnlineList(); // UI update (defined in later section)
  });

  // Public messages (arena)
  socket.on("publicMessage", msg => {
    // Avoid duplicating messages sent by this client if appended locally
    const s = getSession();
    if (s && msg.from === s.username) return;
    appendPublicMessage(msg); // defined in messages section
  });

  // Rooms list update
  socket.on("roomsList", rooms => {
    window.__rooms = Array.isArray(rooms) ? rooms : [];
    renderRoomsSidebar(); // defined in rooms section
  });

  // Room-specific events
  socket.on("roomMessage", msg => {
    // Append to room feed if open
    appendRoomMessage(msg); // defined in rooms/room chat section
  });

  socket.on("roomHistory", msgs => {
    // Replace room feed with history
    const feed = $("roomFeed");
    if (!feed) return;
    feed.innerHTML = "";
    (msgs || []).forEach(m => appendRoomMessage(m));
  });

  socket.on("typingRoom", ({ from, room }) => {
    const currentRoom = $("roomChatPopup")?.dataset?.room;
    if (currentRoom === room) {
      const el = $("roomTyping");
      if (el) { el.textContent = `${from} is typing...`; el.style.display = "block"; }
    }
  });

  socket.on("stopTypingRoom", ({ from, room }) => {
    const currentRoom = $("roomChatPopup")?.dataset?.room;
    if (currentRoom === room) {
      const el = $("roomTyping");
      if (el) el.style.display = "none";
    }
  });

  // Generic error / disconnect handling
  socket.on("disconnect", () => {
    // Optionally mark users offline locally; server will push presence soon
  });

  socket.on("error", err => {
    console.warn("Socket error:", err);
  });
}

/* Helper: request presence/rooms from server (call after login) */
function requestInitialRealtimeState() {
  if (!socket) return;
  socket.emit("requestPresence");
  socket.emit("requestRooms");
}
/* mobile.js — Section 3: Authentication and Registration
   - Login / Register handlers
   - Discord OAuth redirect
   - Image upload for registration
   - Server session check (useful after OAuth redirect)
   - fetchInitialData to populate UI after login
*/

/* Update UI after session changes (called elsewhere too) */
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

/* Login flow */
on($("btnLogin"), "click", () => show($("modalLogin")));
on($("loginCancel"), "click", () => hide($("modalLogin")));

on($("loginSubmit"), "click", async () => {
  const username = $("loginUser")?.value?.trim();
  const password = $("loginPass")?.value?.trim();
  if (!username || !password) {
    if ($("loginError")) { $("loginError").textContent = "Please enter username and password"; show($("loginError")); }
    return;
  }

  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!data.ok) {
      if ($("loginError")) { $("loginError").textContent = data.error || "Login failed"; show($("loginError")); }
      return;
    }

    setSession(data.user);
    hide($("modalLogin"));
    updateUIForSession();
  } catch (err) {
    if ($("loginError")) { $("loginError").textContent = "Network error"; show($("loginError")); }
  }
});

/* Register flow */
on($("btnRegister"), "click", () => show($("modalRegister")));
on($("regCancel"), "click", () => hide($("modalRegister")));

on($("regSubmit"), "click", async () => {
  const payload = {
    username: $("regUser")?.value?.trim(),
    email: $("regEmail")?.value?.trim(),
    display: $("regDisplay")?.value?.trim(),
    age: Number($("regAge")?.value || 0),
    password: $("regPass")?.value?.trim(),
    color: $("regColor")?.value,
    language: $("regLanguage")?.value,
    wins: Number($("regWins")?.value || 0),
    losses: Number($("regLosses")?.value || 0),
    info: $("regInfo")?.value?.trim(),
    imageUrl: $("uploadStatus")?.dataset?.url || null
  };

  try {
    const res = await fetch("/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!data.ok) {
      if ($("regError")) { $("regError").textContent = data.error || "Registration failed"; show($("regError")); }
      return;
    }

    setSession(data.user);
    hide($("modalRegister"));
    updateUIForSession();
  } catch (err) {
    if ($("regError")) { $("regError").textContent = "Network error"; show($("regError")); }
  }
});

/* Image upload helper for registration */
on($("btnUploadImage"), "click", async () => {
  const file = $("regImageFile")?.files?.[0];
  if (!file) return alert("Select an image first");
  try {
    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = reader.result;
      const res = await fetch("/api/upload-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: base64 })
      });
      const data = await res.json();
      if (data.ok) {
        $("uploadStatus").textContent = "Uploaded";
        $("uploadStatus").dataset.url = data.imageUrl;
      } else {
        alert(data.error || "Upload failed");
      }
    };
    reader.readAsDataURL(file);
  } catch (err) {
    alert("Upload error");
  }
});

/* Discord OAuth button */
on($("btnDiscordLogin"), "click", () => {
  // Redirect to backend OAuth route; backend should handle callback and session creation
  window.location.href = "/auth/discord";
});

/* Check server session (useful after OAuth redirect) */
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
    // ignore network errors silently
  }
}

/* Fetch initial data after login to populate UI */
async function fetchInitialData() {
  try {
    const [usersRes, roomsRes, messagesRes] = await Promise.all([
      fetch("/api/users"),
      fetch("/api/rooms"),
      fetch("/api/public-messages")
    ]);
    const usersData = await usersRes.json();
    const roomsData = await roomsRes.json();
    const messagesData = await messagesRes.json();

    window.__users = usersData.users || [];
    window.__rooms = roomsData.rooms || [];

    renderOnlineList();
    renderRoomsSidebar();

    const feed = $("publicFeed");
    if (feed && messagesData.messages) {
      feed.innerHTML = "";
      messagesData.messages.forEach(appendPublicMessage);
    }
  } catch (err) {
    // ignore errors; UI will update as realtime events arrive
  }
}

/* Run a quick server session check on load to catch OAuth redirects */
checkServerSession();
/* mobile.js — Section 4: Public chat, DMs, Rooms, and Modals
   - Public arena messages (load, append, send)
   - Online list rendering
   - DM sidebar behavior and placeholder DM popup
   - Rooms sidebar, room popup, room history and typing indicators
   - Roster, profile loaders, and simple admin hooks
*/

/* ---------------------------
   Public messages (arena)
   --------------------------- */
async function loadPublicMessages() {
  try {
    const res = await fetch("/api/public-messages");
    if (!res.ok) return;
    const data = await res.json();
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
      ${msg.imageUrl ? `<img src="${msg.imageUrl}" alt="avatar" style="width:36px;height:36px;border-radius:50%">`
                   : `<div class="avatar-fallback" style="width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center">${(msg.display||msg.from||"U").charAt(0)}</div>`}
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

/* ---------------------------
   Send public message
   --------------------------- */
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

  // Emit via socket if available, otherwise POST to API
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
  // If a DM popup element exists, populate and show it; otherwise fallback to alert
  const dmPopup = $("dmPopup");
  if (dmPopup) {
    dmPopup.dataset.partner = username;
    const title = dmPopup.querySelector(".dm-title");
    if (title) title.textContent = `DM • ${username}`;
    // load DM history via API
    loadDMHistory(username).then(() => show(dmPopup));
    return;
  }
  // Fallback: open roster/profile or alert
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
    // fallback: fetch history via API
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

/* ---------------------------
   Room message append
   --------------------------- */
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
   Admin hooks (lightweight)
   --------------------------- */
async function loadAdminData() {
  try {
    const res = await fetch("/api/admin/overview");
    if (!res.ok) return;
    const data = await res.json();
    // populate admin table if present
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
/* mobile.js — Section 5: Utilities, Support Actions, Logout, and Exports
   - Generic helpers (debounce, fileToBase64)
   - Support form submit (SR)
   - Logout / session expiration handling
   - Small UI helpers for showing/hiding modals consistently
   - Expose a debug API on window.__cw
*/

/* ---------------------------
   Generic utilities
   --------------------------- */
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
   Support / Report submission
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
    const data = await res.json();
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

/* Wire support submit button if present */
if ($("srSubmit")) on($("srSubmit"), "click", submitSupportReport);

/* ---------------------------
   Logout and session expiration
   --------------------------- */
async function logout() {
  try {
    await fetch("/api/logout", { method: "POST" });
  } catch (e) {
    // ignore network errors on logout
  }
  setSession(null);
  // hide everything sensitive
  hide($("mainUI"));
  // show auth screen (age gate flow should be respected)
  if ($("authScreen")) show($("authScreen"));
  if (socket) {
    try { socket.disconnect(); } catch (e) {}
    socket = null;
  }
}

/* Wire logout button if present */
if ($("btnLogout")) on($("btnLogout"), "click", logout);

/* ---------------------------
   Modal show/hide helpers (consistent)
   --------------------------- */
function showModal(id) {
  const el = $(id);
  if (!el) return;
  el.dataset.display = "flex";
  show(el);
}

function hideModal(id) {
  const el = $(id);
  if (!el) return;
  hide(el);
}

/* ---------------------------
   Lightweight accessibility helpers
   --------------------------- */
function trapFocus(modalEl) {
  if (!modalEl) return;
  const focusable = modalEl.querySelectorAll('a[href], button, textarea, input, select, [tabindex]:not([tabindex="-1"])');
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  modalEl.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
  first.focus();
}

/* ---------------------------
   Expose debug / integration API
   --------------------------- */
window.__cw = window.__cw || {};
Object.assign(window.__cw, {
  getSession,
  setSession,
  logout,
  showModal,
  hideModal,
  initSocket,
  fetchInitialData,
  loadRoster,
  loadProfile,
  openRoomPopup,
  renderOnlineList,
  renderRoomsSidebar
});

/* ---------------------------
   Final initialization (safety)
   --------------------------- */
document.addEventListener("visibilitychange", () => {
  // If user navigates away, optionally notify server
  if (document.visibilityState === "hidden" && socket && getSession()) {
    try { socket.emit("userHidden", { username: getSession().username }); } catch (e) {}
  }
});

/* If session already exists on load, ensure socket and UI are initialized */
if (getSession()) {
  updateUIForSession();
}

// mobile.js
// Full rewrite mobile client for MCF mobile.html
// Assumes socket.io client is loaded and `io()` is available

// GLOBAL SAFE SELECTOR
window.$ = window.$ || function(id) { return document.getElementById(id); };

// SOCKET
const socket = window.socket || io();

// -----------------------------
// HELPERS
// -----------------------------
const REL_COLORS = {
  rival: "rel-rival",
  friend: "rel-friend",
  opponent: "rel-opponent",
  tagteam: "rel-tagteam",
  dating: "rel-dating",
  married: "rel-married",
  sibling: "rel-sibling",
  parent: "rel-parent",
  owner: "rel-owner"
};

function show(el) { if (!el) return; el.style.display = 'flex'; }
function hide(el) { if (!el) return; el.style.display = 'none'; }
function toggle(el) { if (!el) return; el.style.display = (el.style.display === 'none' || !el.style.display) ? 'flex' : 'none'; }
function escapeHtml(str) { if (!str) return ""; return String(str).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;' }[c])); }

function getSession() {
  try { const raw = localStorage.getItem('cw_session_v1'); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function setSession(obj) {
  try { localStorage.setItem('cw_session_v1', JSON.stringify(obj)); } catch {}
}
function clearSession() {
  localStorage.removeItem('cw_session_v1');
  localStorage.removeItem('currentUser');
}

// file to base64
function fileToBase64(file) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(",")[1];
      resolve(base64);
    };
    reader.readAsDataURL(file);
  });
}

async function uploadImageToServer(file) {
  try {
    const base64 = await fileToBase64(file);
    const res = await fetch("/api/upload-image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: base64 })
    });
    return await res.json();
  } catch (err) {
    return { ok: false, error: err.message || "upload failed" };
  }
}

// -----------------------------
// AVATAR RENDERING
// -----------------------------
function renderMessageAvatar(username, display, imageUrl, size = 36) {
  const initials = (display || username || '?').split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
  if (imageUrl) {
    return `<img src="${imageUrl}" class="avatar-img" style="width:${size}px;height:${size}px;border-radius:8px">`;
  }
  return `<div class="avatar-fallback" style="width:${size}px;height:${size}px;border-radius:8px;background:#0a84ff;display:flex;align-items:center;justify-content:center;font-weight:700">${initials}</div>`;
}

// -----------------------------
// RENDERING HELPERS
// -----------------------------
function renderQuickRoster() {
  const el = $('quickRoster');
  if (!el) return;
  el.innerHTML = "";
  (window.users || []).slice(0, 6).forEach(u => {
    const avatar = renderMessageAvatar(u.username, u.display, u.imageUrl, 40);
    const div = document.createElement('div');
    div.className = 'user-row';
    div.style.display = 'flex';
    div.style.gap = '10px';
    div.style.alignItems = 'center';
    div.innerHTML = `
      <div class="avatar-wrapper">${avatar}</div>
      <div style="flex:1">
        <div style="font-weight:700">${escapeHtml(u.display)}</div>
        <div class="small">@${escapeHtml(u.username)}</div>
      </div>
      <div class="status ${u.online ? 'online' : 'offline'}"></div>
    `;
    el.appendChild(div);
  });
}

function renderOnlineList() {
  const el = $('onlineList');
  if (!el) return;
  el.innerHTML = "";
  (window.users || []).forEach(u => {
    const avatar = renderMessageAvatar(u.username, u.display, u.imageUrl, 36);
    const row = document.createElement('div');
    row.className = 'online-row';
    row.style.display = 'flex';
    row.style.gap = '10px';
    row.style.alignItems = 'center';
    row.style.marginBottom = '8px';
    row.innerHTML = `
      <div>${avatar}</div>
      <div style="flex:1">
        <div style="font-weight:700">${escapeHtml(u.display)}</div>
        <div class="small">@${escapeHtml(u.username)}</div>
      </div>
    `;
    row.addEventListener('click', () => openPrivateWindow(u.username));
    el.appendChild(row);
  });
}

// -----------------------------
// ROSTER POPUP
// -----------------------------
let rosterPage = 1;
const rosterPerPage = 12;

async function openRosterPopup() {
  $('#modalRoster').style.display = 'flex';
  // fetch all users if not present
  if (!window.allUsers || !window.allUsers.length) {
    const res = await fetch('/api/allUsers');
    const data = await res.json();
    if (data.success) window.allUsers = data.users;
  }
  rosterPage = 1;
  renderRosterPopup();
}

function renderRosterPopup() {
  const list = $('rosterPage');
  if (!list) return;
  const search = ($('rosterSearch')?.value || '').toLowerCase();
  list.innerHTML = '';
  let sorted = [...(window.allUsers || [])];
  sorted.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  sorted = sorted.filter(u => (u.username || '').toLowerCase().includes(search) || (u.display || '').toLowerCase().includes(search));
  const total = sorted.length;
  const totalPages = Math.max(1, Math.ceil(total / rosterPerPage));
  if (rosterPage > totalPages) rosterPage = totalPages;
  const start = (rosterPage - 1) * rosterPerPage;
  const pageItems = sorted.slice(start, start + rosterPerPage);
  pageItems.forEach(u => {
    const avatar = renderMessageAvatar(u.username, u.display, u.imageUrl, 44);
    const row = document.createElement('div');
    row.className = 'roster-user';
    row.style.display = 'flex';
    row.style.alignItems = 'center';
    row.style.gap = '12px';
    row.style.padding = '8px 0';
    row.innerHTML = `
      <div>${avatar}</div>
      <div style="flex:1">
        <div style="font-weight:700">${escapeHtml(u.display)}</div>
        <div class="small">@${escapeHtml(u.username)}</div>
      </div>
      <button class="small-btn" data-user="${escapeHtml(u.username)}">Message</button>
    `;
    row.querySelector('.small-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      openPrivateWindow(u.username);
    });
    row.addEventListener('click', () => openUserProfile(u.username));
    list.appendChild(row);
  });
  $('rosterPageNumber').textContent = `Page ${rosterPage} / ${totalPages}`;
}

// -----------------------------
// ROOMS SIDEBAR
// -----------------------------
function renderRoomsSidebar() {
  const list = $('roomsList');
  if (!list) return;
  const sort = $('roomSort')?.value || 'newest';
  const s = getSession();
  list.innerHTML = '';
  let rooms = [...(window.rooms || [])];
  rooms = rooms.filter(r => {
    if (!r.private) return true;
    if (r.owner?.toLowerCase() === s?.username?.toLowerCase()) return true;
    if (r.invitedUsers?.includes(s?.username)) return true;
    return false;
  });
  if (sort === "newest") rooms.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  if (sort === "oldest") rooms.sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt));
  if (sort === "az") rooms.sort((a,b)=>a.name.localeCompare(b.name));
  if (sort === "za") rooms.sort((a,b)=>b.name.localeCompare(a.name));
  rooms.forEach(room => {
    const div = document.createElement("div");
    div.className = "room-item";
    div.style.display = 'flex';
    div.style.justifyContent = 'space-between';
    div.style.alignItems = 'center';
    div.style.padding = '8px 0';
    div.innerHTML = `<div>${room.private ? "🔒 " : ""}${escapeHtml(room.name)}</div>`;
    div.addEventListener("click", () => openRoomPopup(room._id, room.name));
    if (room.owner?.toLowerCase() === s?.username?.toLowerCase()) {
      const inviteBtn = document.createElement("button");
      inviteBtn.className = "ghost small-btn";
      inviteBtn.textContent = "Invite";
      inviteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const username = prompt("Enter username to invite:");
        if (!username) return;
        socket.emit("inviteToRoom", { roomId: room._id, username });
      });
      div.appendChild(inviteBtn);
    }
    list.appendChild(div);
  });
}

// -----------------------------
// ROOM CHAT
// -----------------------------
function openRoomPopup(roomId, roomName) {
  const popup = $('roomChatPopup');
  if (!popup) return;
  popup.dataset.room = roomId;
  $('roomChatTitle').textContent = roomName;
  show(popup);
  socket.emit('joinRoom', { room: roomId });
  // request history
  socket.emit('requestRoomHistory', { room: roomId });
}

function appendRoomMessage(msg) {
  const feed = $('roomFeed');
  if (!feed) return;
  const user = (window.users || []).find(u => u.username === msg.from);
  const avatar = renderMessageAvatar(msg.from, msg.display, user?.imageUrl);
  const div = document.createElement('div');
  div.className = 'message-row';
  div.style.display = 'flex';
  div.style.gap = '10px';
  div.style.marginBottom = '8px';
  div.innerHTML = `
    <div class="message-avatar">${avatar}</div>
    <div class="message">
      <div style="font-weight:700;color:${user?.color || '#7fd8ff'}">
        ${escapeHtml(msg.display)} <span class="small" style="color:${user?.color || '#7fd8ff'}">@${escapeHtml(msg.from)} • ${new Date(msg.time).toLocaleTimeString()}</span>
      </div>
      <div>${msg.text ? escapeHtml(msg.text) : ''}${msg.imageUrl ? `<div style="margin-top:8px"><img src="${msg.imageUrl}" style="max-width:100%;border-radius:8px"></div>` : ''}</div>
    </div>
  `;
  feed.appendChild(div);
  feed.scrollTop = feed.scrollHeight;
}

function sendRoomMessage() {
  const input = $('roomMessageInput');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  const s = getSession();
  if (!s) return alert("You must be logged in to send messages.");
  const room = $('roomChatPopup')?.dataset.room;
  if (!room) return;
  const payload = { room, from: s.username, display: s.display || s.username, text, time: new Date().toISOString() };
  socket.emit('roomMessage', payload);
  appendRoomMessage(payload);
  input.value = '';
}

// room image upload
async function uploadRoomImage(file) {
  const data = await uploadImageToServer(file);
  if (!data.ok) return alert("Image upload failed");
  const room = $('roomChatPopup')?.dataset.room;
  const s = getSession();
  if (!room || !s) return;
  socket.emit("roomMessage", { room, from: s.username, display: s.display || s.username, imageUrl: data.imageUrl, time: new Date().toISOString() });
}

// -----------------------------
// PUBLIC CHAT
// -----------------------------
async function loadPublicMessages() {
  const feed = $('publicFeed');
  if (!feed) return;
  feed.innerHTML = '';
  try {
    const res = await fetch('/api/public-messages');
    const data = await res.json();
    if (!data.ok) return;
    data.messages.forEach(m => appendPublicMessage(m));
  } catch (err) {
    console.warn("Failed to load public messages", err);
  }
}

function appendPublicMessage(msg) {
  const feed = $('publicFeed');
  if (!feed) return;
  const s = getSession();
  if (s && msg.from === s.username) return; // prevent double render if already appended locally
  const user = (window.users || []).find(u => u.username === msg.from);
  const avatar = renderMessageAvatar(msg.from, msg.display, user?.imageUrl);
  const div = document.createElement('div');
  div.className = 'message-row ' + (s && msg.from === s.username ? 'me' : '');
  div.style.display = 'flex';
  div.style.gap = '10px';
  div.style.marginBottom = '8px';
  div.innerHTML = `
    <div class="message-avatar">${avatar}</div>
    <div class="message">
      <div style="font-weight:700;color:${user?.color || '#7fd8ff'}">
        ${escapeHtml(msg.display)} <span class="small" style="color:${user?.color || '#7fd8ff'}">@${escapeHtml(msg.from)} • ${new Date(msg.time).toLocaleTimeString()}</span>
      </div>
      <div>${escapeHtml(msg.text)}</div>
    </div>
  `;
  feed.appendChild(div);
  feed.scrollTop = feed.scrollHeight;
}

function sendPublicMessage() {
  const input = $('publicMessage');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  const s = getSession();
  if (!s) return alert("You must be logged in to send messages.");
  const msg = { from: s.username, display: s.display || s.username, text, time: new Date().toISOString() };
  socket.emit('publicMessage', msg);
  appendPublicMessage(msg);
  input.value = '';
}

// -----------------------------
// PRIVATE MESSAGING (stub)
// -----------------------------
function openPrivateWindow(username) {
  // Minimal mobile-friendly PM opener: open DM sidebar and focus search
  show($('dmSidebar'));
  // Optionally highlight or open conversation
  if (window.updateDMListSidebar) updateDMListSidebar();
  // If you have a dedicated PM popup, implement here
  console.log("Open PM with", username);
}

// -----------------------------
// PROFILE VIEW / RELATIONSHIPS / STORIES
// -----------------------------
async function loadStories(username) {
  try {
    const res = await fetch("/api/story/list?username=" + encodeURIComponent(username));
    const data = await res.json();
    const box = $('profileStories');
    if (!box) return;
    box.innerHTML = "<h3>Stories</h3>";
    if (!data.stories || !data.stories.length) {
      box.innerHTML += "<div class='small muted'>No approved stories</div>";
      return;
    }
    data.stories.forEach(s => {
      const div = document.createElement("div");
      div.className = "story-item";
      div.textContent = `${s.partner} — ${new Date(s.createdAt).toLocaleDateString()}`;
      div.onclick = () => alert(s.story);
      box.appendChild(div);
    });
  } catch (err) {
    console.warn("loadStories error", err);
  }
}

async function loadRelationships(username) {
  try {
    const res = await fetch("/api/relationship/list?username=" + encodeURIComponent(username));
    const data = await res.json();
    const box = $('profileRelationships');
    if (!box) return;
    box.innerHTML = "<h3>Relationships</h3>";
    if (!data.relationships || !data.relationships.length) {
      box.innerHTML += "<div class='small muted'>No relationships</div>";
      return;
    }
    data.relationships.forEach(r => {
      const other = r.requester === username ? r.target : r.requester;
      const div = document.createElement("div");
      div.className = "relationship-item";
      div.innerHTML = `<strong>${escapeHtml(r.type)}</strong> with ${escapeHtml(other)}`;
      box.appendChild(div);
    });
  } catch (err) {
    console.warn("loadRelationships error", err);
  }
}

async function loadRelationshipTimeline(username) {
  try {
    const res = await fetch("/api/relationship/timeline?username=" + encodeURIComponent(username));
    const data = await res.json();
    const box = $('profileTimeline');
    if (!box) return;
    box.innerHTML = "<h3>Relationship Timeline</h3>";
    const events = data.timeline || [];
    if (!events.length) {
      box.innerHTML += "<div class='small muted'>No relationship history</div>";
      return;
    }
    events.forEach(e => {
      const div = document.createElement("div");
      const cls = REL_COLORS[e.type] || "rel-friend";
      div.className = `timeline-item ${cls}`;
      div.innerHTML = `<div class="timeline-date">${new Date(e.approvedAt).toLocaleString()}</div>
                       <div class="timeline-desc">${escapeHtml(e.type)} with <strong>${escapeHtml(e.with)}</strong></div>`;
      box.appendChild(div);
    });
  } catch (err) {
    console.warn("loadRelationshipTimeline error", err);
  }
}

// open user profile and populate modal
function openUserProfile(username) {
  const user = (window.allUsers || []).find(u => u.username === username) || (window.users || []).find(u => u.username === username);
  if (!user) return;
  // populate fields (IDs assumed present in modal)
  const vp = $('modalViewProfile');
  if (!vp) return;
  // example fields (create them in HTML if needed)
  if ($('vpName')) $('vpName').textContent = user.display || user.username;
  if ($('vpUsername')) $('vpUsername').textContent = user.username;
  if ($('vpBio')) $('vpBio').textContent = user.info || "No bio provided";
  if ($('vpWins')) $('vpWins').textContent = user.wins ?? 0;
  if ($('vpLosses')) $('vpLosses').textContent = user.losses ?? 0;
  if ($('vpLang')) $('vpLang').textContent = user.language || "Unknown";
  if ($('vpAge')) $('vpAge').textContent = user.age || "Unknown";
  if ($('vpColorBox')) $('vpColorBox').style.background = user.color || "#7fd8ff";
  if ($('vpAvatar')) $('vpAvatar').src = user.imageUrl || "https://via.placeholder.com/120?text=No+Image";

  // block button
  const blockBtn = $('vpBlockButton');
  if (blockBtn) {
    blockBtn.onclick = async () => {
      const me = getSession();
      if (!me) return alert("You must be logged in.");
      if (!confirm("Block this user? They will not be able to DM you.")) return;
      const res = await fetch("/api/block-user", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: me.username, target: username })
      });
      const data = await res.json();
      if (data.ok) alert("User blocked."); else alert("Failed to block user.");
    };
  }

  // load stories and relationships
  loadStories(username);
  loadRelationships(username);
  loadRelationshipTimeline(username);

  // relationship send
  if ($('vpRelationshipSend')) {
    $('vpRelationshipSend').onclick = async () => {
      const type = $('vpRelationshipSelect').value;
      if (!type) return alert("Select a relationship first");
      const requester = getSession()?.username;
      if (!requester) return alert("You must be logged in.");
      const res = await fetch("/api/relationship/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requester, target: username, type })
      });
      const data = await res.json();
      if (!data.ok) return alert("Failed to send request");
      alert("Relationship request sent!");
    };
  }

  // DM button
  if ($('vpDMButton')) {
    $('vpDMButton').onclick = () => openPrivateWindow(username);
  }

  show($('modalViewProfile'));
}

// -----------------------------
// SUPPORT REPORT
// -----------------------------
document.getElementById("srSubmit")?.addEventListener("click", async () => {
  const me = getSession();
  if (!me) return alert("You must be logged in.");
  const type = $('srType')?.value || 'user';
  const user = $('srUser')?.value || '';
  const where = $('srWhere')?.value || '';
  const when = $('srWhen')?.value || '';
  const info = $('srInfo')?.value || '';
  const payload = {
    from: me.username,
    to: "Administrator",
    text: `Support Report Type: ${type} User: ${user || "N/A"} Where: ${where} When: ${when} Info: ${info}`.trim()
  };
  await fetch("/api/send-dm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  alert("Report submitted.");
  const popup = $('supportPopup'); if (popup) popup.style.display = 'none';
});

// -----------------------------
// PRESENCE, SOCKET EVENTS, TYPING
// -----------------------------
socket.on('presence', users => {
  window.users = users;
  renderQuickRoster();
  renderRosterPopup();
  renderOnlineList();
  if (window.updateDMListSidebar) updateDMListSidebar();
});

socket.on('publicMessage', msg => {
  const s = getSession();
  if (s && msg.from === s.username) return;
  appendPublicMessage(msg);
});

socket.on('externalPublicMessage', msg => {
  appendPublicMessage(msg);
});

socket.on('roomHistory', ({ room, messages }) => {
  const popup = $('roomChatPopup');
  if (!popup || popup.dataset.room !== room) return;
  $('roomFeed').innerHTML = '';
  messages.forEach(m => appendRoomMessage(m));
});

socket.on('roomMessage', msg => {
  const popup = $('roomChatPopup');
  if (popup && popup.dataset.room === msg.room) {
    appendRoomMessage(msg);
  } else {
    // increment unread badge
    // implement getRoomUnread() in your app if needed
    updateRoomsSidebarBadges();
  }
});

socket.on('typingRoom', ({ from, room }) => {
  const roomChat = $('roomChatPopup');
  const current = roomChat?.dataset.room;
  if (current !== room) return;
  const el = $('roomTyping');
  if (el) { el.textContent = `${from} is typing...`; el.style.display = "block"; }
});

socket.on('stopTypingRoom', ({ from, room }) => {
  const roomChat = $('roomChatPopup');
  const current = roomChat?.dataset.room;
  if (current !== room) return;
  const el = $('roomTyping');
  if (el) el.style.display = "none";
});

socket.on('roomsList', rooms => {
  window.rooms = rooms;
  renderRoomsSidebar();
});

socket.on('roomInvited', ({ roomId, roomName }) => {
  alert(`You have been invited to join the private room: ${roomName}`);
});

socket.on('roomMembers', members => {
  renderRoomMembers(members);
});

// -----------------------------
// ROOM MEMBERS RENDER
// -----------------------------
function renderRoomMembers(members) {
  const list = $('roomMembersList');
  if (!list) return;
  list.innerHTML = '';
  members.forEach(m => {
    const div = document.createElement("div");
    div.className = "room-member";
    div.style.display = 'flex';
    div.style.alignItems = 'center';
    div.style.gap = '8px';
    div.style.padding = '6px 0';
    const avatar = m.imageUrl ? `<img src="${m.imageUrl}" style="width:32px;height:32px;border-radius:50%">` : `<div class="avatar-fallback" style="width:32px;height:32px">${escapeHtml((m.display||'')[0]||'?')}</div>`;
    div.innerHTML = `${avatar} <div style="flex:1"><div style="font-weight:700">${escapeHtml(m.display)}</div><div class="small">@${escapeHtml(m.username)}</div></div><div class="room-member-status">${m.online ? "online" : "offline"}</div>`;
    list.appendChild(div);
  });
}

// -----------------------------
// UI BINDINGS
// -----------------------------
function bindUI() {
  // header / nav
  $('btnOpenChat')?.addEventListener('click', () => {
    show($('chatPopup'));
    loadPublicMessages();
    renderOnlineList();
  });
  $('btnCloseChat')?.addEventListener('click', () => {
    const s = getSession();
    if (s) socket.emit("chatClosed", { username: s.username });
    hide($('chatPopup'));
  });
  $('btnMinimize')?.addEventListener('click', () => {
    const c = $('chatPopup');
    if (!c) return;
    c.classList.toggle('minimized');
  });

  // public send
  $('sendPublic')?.addEventListener('click', sendPublicMessage);
  $('publicMessage')?.addEventListener('keydown', e => { if (e.key === 'Enter') sendPublicMessage(); });

  // room send
  $('roomSendBtn')?.addEventListener('click', sendRoomMessage);
  $('roomMessageInput')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') sendRoomMessage();
    else {
      const room = $('roomChatPopup')?.dataset.room;
      if (room) socket.emit('typingRoom', { from: getSession()?.username, room });
      setTimeout(() => socket.emit('stopTypingRoom', { from: getSession()?.username, room }), 1500);
    }
  });

  // room image
  $('roomImageBtn')?.addEventListener('click', () => $('roomImageInput')?.click());
  $('roomImageInput')?.addEventListener('change', e => {
    const file = e.target.files[0];
    if (file) uploadRoomImage(file);
  });

  // roster
  $('btnRoster')?.addEventListener('click', openRosterPopup);
  $('rosterClose')?.addEventListener('click', () => hide($('modalRoster')));
  $('rosterSearch')?.addEventListener('input', () => { rosterPage = 1; renderRosterPopup(); });
  $('rosterPrev')?.addEventListener('click', () => { if (rosterPage > 1) { rosterPage--; renderRosterPopup(); } });
  $('rosterNext')?.addEventListener('click', () => { rosterPage++; renderRosterPopup(); });

  // dm sidebar
  $('btnDMs')?.addEventListener('click', () => show($('dmSidebar')));
  $('closeDmSidebar')?.addEventListener('click', () => hide($('dmSidebar')));
  $('dmSearch')?.addEventListener('input', () => { if (window.updateDMListSidebar) updateDMListSidebar(); });

  // rooms sidebar
  $('btnRooms')?.addEventListener('click', () => show($('roomsPanel')));
  $('closeRoomsSidebar')?.addEventListener('click', () => hide($('roomsPanel')));
  $('roomSort')?.addEventListener('change', renderRoomsSidebar);
  $('createRoomBtn')?.addEventListener('click', () => {
    const name = prompt("Enter room name:");
    if (!name) return;
    const isPrivate = confirm("Make this a PRIVATE room?");
    socket.emit("createRoom", { name, private: isPrivate });
  });

  // legal / support
  $('btnTOS')?.addEventListener('click', () => show($('modalTOS')));
  $('closeTOS')?.addEventListener('click', () => hide($('modalTOS')));
  $('btnRules')?.addEventListener('click', () => show($('modalRules')));
  $('closeRules')?.addEventListener('click', () => hide($('modalRules')));
  $('openSupport')?.addEventListener('click', () => show($('supportPopup')));
  $('closeSupport')?.addEventListener('click', () => hide($('supportPopup')));
  $('btnPrivacy')?.addEventListener('click', () => show($('modalPrivacy')));
  $('closePrivacy')?.addEventListener('click', () => hide($('modalPrivacy')));

  // login/register/edit profile
  $('btnLogin')?.addEventListener('click', () => show($('modalLogin')));
  $('loginCancel')?.addEventListener('click', () => hide($('modalLogin')));
  $('loginSubmit')?.addEventListener('click', async () => {
    const user = $('loginUser')?.value?.trim();
    const pass = $('loginPass')?.value?.trim();
    if (!user || !pass) return alert("Enter username and password");
    const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user, password: pass }) });
    const data = await res.json();
    if (data.ok) {
      setSession(data.session);
      hide($('modalLogin'));
      updateUIForSession();
    } else {
      $('loginError').style.display = 'block';
      $('loginError').textContent = data.error || "Login failed";
    }
  });

  $('btnRegister')?.addEventListener('click', () => show($('modalRegister')));
  $('regCancel')?.addEventListener('click', () => hide($('modalRegister')));
  $('regSubmit')?.addEventListener('click', async () => {
    const payload = {
      username: $('regUser')?.value,
      email: $('regEmail')?.value,
      display: $('regDisplay')?.value,
      age: $('regAge')?.value,
      password: $('regPass')?.value,
      color: $('regColor')?.value,
      language: $('regLanguage')?.value,
      wins: $('regWins')?.value,
      losses: $('regLosses')?.value,
      info: $('regInfo')?.value
    };
    const res = await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await res.json();
    if (data.ok) {
      setSession(data.session);
      hide($('modalRegister'));
      updateUIForSession();
    } else {
      $('regError').style.display = 'block';
      $('regError').textContent = data.error || "Registration failed";
    }
  });

  // edit profile
  $('btnEditProfile')?.addEventListener('click', async () => {
    const s = getSession();
    if (!s) return show($('modalLogin'));
    // populate fields from session or fetch profile
    $('editDisplay').value = s.display || '';
    $('editAge').value = s.age || '';
    $('editInfo').value = s.info || '';
    $('editColor').value = s.color || '#7fd8ff';
    $('editLanguage').value = s.language || 'en';
    $('editWins').value = s.wins || 0;
    $('editLosses').value = s.losses || 0;
    show($('modalEditProfile'));
  });
  $('editCancel')?.addEventListener('click', () => hide($('modalEditProfile')));
  $('editSubmit')?.addEventListener('click', async () => {
    const s = getSession();
    if (!s) return alert("Not logged in");
    const payload = {
      username: s.username,
      display: $('editDisplay')?.value,
      age: $('editAge')?.value,
      info: $('editInfo')?.value,
      color: $('editColor')?.value,
      language: $('editLanguage')?.value,
      wins: $('editWins')?.value,
      losses: $('editLosses')?.value
    };
    const res = await fetch('/api/profile/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await res.json();
    if (data.ok) {
      setSession(data.session || { ...s, ...payload });
      hide($('modalEditProfile'));
      updateUIForSession();
    } else {
      $('editError').style.display = 'block';
      $('editError').textContent = data.error || "Update failed";
    }
  });

  // image uploads in register/edit
  $('btnUploadImage')?.addEventListener('click', () => $('regImageFile')?.click());
  $('regImageFile')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    $('uploadStatus').textContent = "Uploading...";
    const data = await uploadImageToServer(file);
    if (data.ok) {
      $('uploadStatus').textContent = "Uploaded";
      // store url in a hidden field or session
      window.lastUploadedImage = data.imageUrl;
    } else {
      $('uploadStatus').textContent = "Upload failed";
    }
  });

  $('btnEditUploadImage')?.addEventListener('click', () => $('editImageFile')?.click());
  $('editImageFile')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    $('editUploadStatus').textContent = "Uploading...";
    const data = await uploadImageToServer(file);
    if (data.ok) {
      $('editUploadStatus').textContent = "Uploaded";
      window.lastUploadedImage = data.imageUrl;
    } else {
      $('editUploadStatus').textContent = "Upload failed";
    }
  });

  // story popup
  $('storyLoadBtn')?.addEventListener('click', async () => {
    const date = $('storyDate')?.value;
    if (!date) return alert("Select a date");
    const res = await fetch(`/api/messages?since=${encodeURIComponent(date)}`);
    const data = await res.json();
    if (data.ok) {
      $('storyEditor').value = data.messages.map(m => `${m.display || m.from}: ${m.text}`).join("\n\n");
    } else {
      alert("Failed to load messages");
    }
  });
  $('storySaveBtn')?.addEventListener('click', async () => {
    const content = $('storyEditor')?.value || '';
    const res = await fetch('/api/story/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) });
    const data = await res.json();
    if (data.ok) alert("Story saved"); else alert("Save failed");
  });
  $('storyCloseBtn')?.addEventListener('click', () => hide($('storyPopup')));

  // admin password modal
  $('adminPasswordSubmit')?.addEventListener('click', async () => {
    const pass = $('adminPasswordInput')?.value;
    const res = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pass }) });
    const data = await res.json();
    if (data.ok) {
      hide($('modalAdminPassword'));
      show($('modalAdmin'));
    } else {
      $('adminPasswordError').style.display = 'block';
      $('adminPasswordError').textContent = data.error || "Invalid password";
    }
  });
  $('adminPasswordCancel')?.addEventListener('click', () => hide($('modalAdminPassword')));
}

// -----------------------------
// UI STATE UPDATES
// -----------------------------
function updateUIForSession() {
  const s = getSession();
  if (s) {
    if ($('chatUserLabel')) $('chatUserLabel').textContent = s.display || s.username;
    if ($('userProfileCard')) {
      // update profile card
      const card = $('userProfileCard');
      card.innerHTML = `<button id="btnEditProfile" class="ghost">Edit Profile</button><div>${escapeHtml(s.display || s.username)}</div><p class="small">Logged in</p>`;
      // rebind edit button
      document.getElementById('btnEditProfile')?.addEventListener('click', () => show($('modalEditProfile')));
    }
  } else {
    if ($('chatUserLabel')) $('chatUserLabel').textContent = 'Not signed in';
    if ($('userProfileCard')) {
      $('userProfileCard').innerHTML = `<button id="btnEditProfile" class="ghost">Edit Profile</button><div>🔒 Not logged in</div><p>Login or register to see your profile</p>`;
    }
  }
}

// -----------------------------
// DRAG / SWIPE / GESTURES
// -----------------------------
function makeDraggable(el) {
  if (!el) return;
  let offsetX = 0, offsetY = 0, isDown = false;
  el.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.message') || e.target.closest('input') || e.target.closest('textarea')) return;
    isDown = true;
    offsetX = e.clientX - (el.offsetLeft || 0);
    offsetY = e.clientY - (el.offsetTop || 0);
    el.style.transition = "none";
  });
  document.addEventListener('pointerup', () => { isDown = false; el.style.transition = ""; });
  document.addEventListener('pointermove', (e) => {
    if (!isDown) return;
    el.style.left = (e.clientX - offsetX) + "px";
    el.style.top = (e.clientY - offsetY) + "px";
  });
}

// swipe to open/close side panels (basic)
function bindSwipeGestures() {
  let startX = 0, startY = 0, tracking = false;
  document.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    startX = t.clientX; startY = t.clientY; tracking = true;
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!tracking) return;
    const t = e.touches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    if (Math.abs(dx) > 60 && Math.abs(dy) < 40) {
      if (dx > 0) { // swipe right
        // open DMs if from left edge
        if (startX < 40) show($('dmSidebar'));
      } else { // swipe left
        // open rooms if from right edge
        if (startX > window.innerWidth - 40) show($('roomsPanel'));
      }
      tracking = false;
    }
  }, { passive: true });
  document.addEventListener('touchend', () => { tracking = false; });
}

// -----------------------------
// INIT
// -----------------------------
function init() {
  bindUI();
  bindSwipeGestures();
  makeDraggable($('chatPopup'));
  // age gate intro
  document.addEventListener("DOMContentLoaded", () => {
    const gate = $('ageGate'), gif = $('introGif'), btn = $('confirmBtn');
    if (!gate || !gif || !btn) return;
    btn.addEventListener("click", () => {
      gif.style.backgroundImage = "url('/images/intro.gif')";
      gif.style.opacity = "1";
      gate.style.opacity = "0";
      setTimeout(() => { gif.style.opacity = "0"; }, 8000);
      setTimeout(() => { gate.style.display = "none"; gif.style.display = "none"; }, 8800);
    });
  });

  // presence request
  socket.emit('requestPresence');

  // restore session UI
  updateUIForSession();

  // initial loads
  loadPublicMessages();
  renderQuickRoster();
  renderRoomsSidebar();
}

// run init
init();

// LOGOUT on close
window.addEventListener("beforeunload", () => {
  const s = getSession();
  if (!s) return;
  socket.emit("forceLogout", { username: s.username });
  clearSession();
});

// Expose some helpers for debugging
window.MCF = {
  appendPublicMessage,
  appendRoomMessage,
  openRoomPopup,
  openPrivateWindow,
  renderRoomsSidebar,
  renderRosterPopup
};

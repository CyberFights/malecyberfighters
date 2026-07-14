/* ============================================================
   GLOBAL SAFE SELECTOR (works with utils.js)
============================================================ */
window.$ = window.$ || function(id) {
  return document.getElementById(id);
};
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

/* ============================================================
   HELPERS
============================================================ */
function show(el){ if (el) el.style.display = 'flex'; }
function hide(el){ if (el) el.style.display = 'none'; }

function escapeHtml(str){
  if (!str) return '';
  return str.replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

function getSession(){
  try {
    const raw = localStorage.getItem('cw_session_v1');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function fileToBase64(file) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(",")[1]; // remove data:image/... prefix
      resolve(base64);
    };
    reader.readAsDataURL(file);
  });
}

async function uploadImageToServer(file) {
  const base64 = await fileToBase64(file);

  const res = await fetch("/api/upload-image", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: base64 })
  });

  return await res.json(); // { success: true, url: "https://..." }
}

/* ============================================================
   AVATAR RENDERING
============================================================ */
function renderMessageAvatar(username, display, imageUrl, size = 36){
  const initials = (display || username || '?')
    .split(' ')
    .map(n => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  if (imageUrl){
    return `<img src="${imageUrl}" class="avatar-img" style="width:${size}px;height:${size}px">`;
  }

  return `<div class="avatar-fallback" style="width:${size}px;height:${size}px">${initials}</div>`;
}

/* ============================================================
   QUICK ROSTER
============================================================ */
function renderQuickRoster(){
  const el = $('quickRoster');
  if (!el) return;

  el.innerHTML = '';

  (window.users || []).slice(0, 6).forEach(u => {
    const avatar = renderMessageAvatar(u.username, u.display, u.imageUrl, 40);

    const div = document.createElement('div');
    div.className = 'user-row';
    div.innerHTML = `
      <div class="avatar-wrapper">${avatar}</div>
      <div style="flex:1">
        <div style="font-weight:700">${u.display}</div>
        <div class="small">@${u.username}</div>
      </div>
      <div class="status online"></div>
    `;

    el.appendChild(div);
  });
}

/* ============================================================
   FULL ROSTER PAGE
============================================================ */
function renderRosterPage(){
  const el = $('rosterPage');
  if (!el) return;

  el.innerHTML = '';

  (window.users || []).forEach(u => {
    const avatar = renderMessageAvatar(u.username, u.display, u.imageUrl, 44);

    const row = document.createElement('div');
    row.className = 'user-row';
    row.innerHTML = `
      ${avatar}
      <div style="flex:1">
        <div style="font-weight:700">${u.display}</div>
        <div class="small">@${u.username}</div>
      </div>
      <button class="small-btn" data-user="${u.username}">Message</button>
    `;

    el.appendChild(row);
  });

  el.querySelectorAll('.small-btn').forEach(btn => {
    btn.addEventListener('click', e => openPrivateWindow(e.target.dataset.user));
  });
}
// OPEN ROSTER POPUP
$('btnRoster')?.addEventListener('click', async () => {
  $('modalRoster').style.display = 'flex';

  // Fetch ALL users from MongoDB
  const res = await fetch("/api/allUsers");
  const data = await res.json();

  if (data.success) {
    window.allUsers = data.users;
    rosterPage = 1;
    renderRosterPopup();
  }
});


// CLOSE ROSTER POPUP
$('rosterClose')?.addEventListener('click', () => {
  $('modalRoster').style.display = 'none';
});

// SEARCH FILTER
$('rosterSearch')?.addEventListener('input', () => {
  renderRosterPopup();
});

// RENDER ROSTER POPUP
function renderRosterPopup() {
  const list = $('rosterPage');
  const search = $('rosterSearch').value.toLowerCase();
  const pageLabel = $('rosterPageNumber');

  list.innerHTML = '';

  let sorted = [...(window.allUsers || [])];

  // SORT NEWEST FIRST
  sorted.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  // SEARCH FILTER
  sorted = sorted.filter(u =>
    u.username.toLowerCase().includes(search) ||
    u.display.toLowerCase().includes(search)
  );

  // PAGINATION
  const total = sorted.length;
  const totalPages = Math.max(1, Math.ceil(total / rosterPerPage));

  if (rosterPage > totalPages) rosterPage = totalPages;

  const start = (rosterPage - 1) * rosterPerPage;
  const end = start + rosterPerPage;

  const pageItems = sorted.slice(start, end);

  // RENDER USERS
  pageItems.forEach(u => {
    const div = document.createElement('div');
    div.className = 'roster-user';

    const avatar = u.imageUrl
      ? `<img src="${u.imageUrl}" class="roster-avatar">`
      : `<div class="avatar-fallback roster-avatar">${u.display[0]}</div>`;

    div.innerHTML = `
      ${avatar}
      <div>
        <div class="roster-name">${u.display}</div>
        <div class="roster-username">@${u.username}</div>
      </div>
    `;

    div.addEventListener('click', () => openUserProfile(u.username));
    list.appendChild(div);
  });

  pageLabel.textContent = `Page ${rosterPage} / ${totalPages}`;
}


// OPEN PROFILE (hook into your existing profile modal)
function openUserProfile(username) {
  const user = (window.allUsers || []).find(u => u.username === username);
  if (!user) return;

  // Existing profile fields...
  $('vpName').textContent = user.display;
  $('vpUsername').textContent = user.username;
  $('vpBio').textContent = user.info || "No bio provided";
  $('vpWins').textContent = user.wins ?? 0;
  $('vpLosses').textContent = user.losses ?? 0;
  $('vpLang').textContent = user.language || "Unknown";
  $('vpAge').textContent = user.age || "Unknown";
  $('vpColorBox').style.background = user.color || "#7fd8ff";
  $('vpAvatar').src = user.imageUrl || "https://via.placeholder.com/120?text=No+Image";

document.getElementById("vpBlockButton").onclick = async () => {
  const me = getSession();
  if (!me) return;

  if (!confirm("Block this user? They will not be able to DM you.")) return;

  const res = await fetch("/api/block-user", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: me.username,
      target: username
    })
  });

  const data = await res.json();

  if (data.ok) {
    alert("User blocked.");
  } else {
    alert("Failed to block user.");
  }
};

  // Load stories + relationships + timeline
  loadStories(username);
  
  loadRelationships(username);
  
  loadRelationshipTimeline(username);

  // Reset dropdown
  $('vpRelationshipSelect').value = "";

  // Attach relationship request handler
  $('vpRelationshipSend').onclick = async () => {
    const type = $('vpRelationshipSelect').value;
    if (!type) return alert("Select a relationship first");

    const requester = getSession().username;
    const target = user.username;

    const res = await fetch("/api/relationship/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requester, target, type })
    });

    const data = await res.json();
    if (!data.ok) return alert("Failed to send request");

    alert("Relationship request sent!");
  };

  $('modalViewProfile').style.display = "flex";
   document.getElementById("vpDMButton").onclick = () => {
  openPrivateWindow(username);
};

}

$('vpClose').addEventListener('click', () => {
  $('modalViewProfile').style.display = "none";
});

// PAGINATION SETTINGS
let rosterPage = 1;
const rosterPerPage = 12;

// OPEN ROSTER POPUP
$('btnRoster')?.addEventListener('click', () => {
  rosterPage = 1;
  $('modalRoster').style.display = 'flex';
  renderRosterPopup();
});

// CLOSE ROSTER POPUP
$('rosterClose')?.addEventListener('click', () => {
  $('modalRoster').style.display = 'none';
});

// SEARCH FILTER
$('rosterSearch')?.addEventListener('input', () => {
  rosterPage = 1;
  renderRosterPopup();
});

// PAGINATION BUTTONS
$('rosterPrev')?.addEventListener('click', () => {
  if (rosterPage > 1) {
    rosterPage--;
    renderRosterPopup();
  }
});

$('rosterNext')?.addEventListener('click', () => {
  rosterPage++;
  renderRosterPopup();
});

async function loadStories(username) {
  const res = await fetch("/api/story/list?username=" + username);
  const data = await res.json();

  const box = document.getElementById("profileStories");
  box.innerHTML = "<h3>Stories</h3>";

  if (!data.stories.length) {
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
}

async function loadRelationships(username) {
  const res = await fetch("/api/relationship/list?username=" + username);
  const data = await res.json();

  const box = document.getElementById("profileRelationships");
  box.innerHTML = "<h3>Relationships</h3>";

  if (!data.relationships.length) {
    box.innerHTML += "<div class='small muted'>No relationships</div>";
    return;
  }

  data.relationships.forEach(r => {
    const other = r.requester === username ? r.target : r.requester;

    const div = document.createElement("div");
    div.className = "relationship-item";
    div.innerHTML = `
      <strong>${r.type}</strong> with ${other}
    `;
    box.appendChild(div);
  });
}
async function loadRelationshipTimeline(username) {
  const res = await fetch("/api/relationship/timeline?username=" + username);
  const data = await res.json();

  const box = document.getElementById("profileTimeline");
  box.innerHTML = "<h3>Relationship Timeline</h3>";

  // FIX: use data.timeline instead of data.events
  const events = data.timeline || [];

  if (!events.length) {
    box.innerHTML += "<div class='small muted'>No relationship history</div>";
    return;
  }

  events.forEach(e => {
  const div = document.createElement("div");

  const cls = REL_COLORS[e.type] || "rel-friend"; // fallback

  div.className = `timeline-item ${cls}`;

  div.innerHTML = `
    <div class="timeline-date">${new Date(e.approvedAt).toLocaleString()}</div>
    <div class="timeline-desc">
      ${e.type} with <strong>${e.with}</strong>
    </div>
  `;

  box.appendChild(div);
});

}



/* ============================================================
   ONLINE LIST
============================================================ */
function renderOnlineList(){
  const el = $('onlineList');
  if (!el) return;

  el.innerHTML = '';

  (window.users || []).forEach(u => {
    const avatar = renderMessageAvatar(u.username, u.display, u.imageUrl, 36);

    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.justifyContent = 'space-between';

    row.innerHTML = `
      <div class="holo-avatar" style="display:flex;gap:8px;align-items:center">
        ${avatar}
        <div>
          <div style="font-weight:700">${u.display}</div>
          <div class="small">@${u.username}</div>
        </div>
      </div>
      <button class="small-btn" data-user="${u.username}">PM</button>
    `;

    el.appendChild(row);
  });

  el.querySelectorAll('.small-btn').forEach(btn => {
    btn.addEventListener('click', e => openPrivateWindow(e.target.dataset.user));
  });
}

/* ============================================================
   DM SIDEBAR (optional)
============================================================ */
function updateDMListSidebar(){
  const sidebar = $('dmSidebar');
  if (!sidebar) return;

  const list = sidebar.querySelector('.dm-list');
  if (!list) return;

  list.innerHTML = '';

  (window.users || []).forEach(u => {
    const avatar = renderMessageAvatar(u.username, u.display, u.imageUrl, 32);

    const div = document.createElement('div');
    div.className = 'dm-sidebar-item';
    div.innerHTML = `
      <div class="holo-avatar" style="display:flex;gap:8px;align-items:center">
        ${avatar}
        <div>
          <div style="font-weight:700">${u.display}</div>
          <div class="small">@${u.username}</div>
        </div>
      </div>
    `;

    div.addEventListener('click', () => openPrivateWindow(u.username));
    list.appendChild(div);
  });
}


/* ============================================================
   PRESENCE UPDATES
============================================================ */
socket.on('presence', users => {
  window.users = users;
  renderQuickRoster();
  renderRosterPage();
  renderOnlineList();
  if (window.updateDMListSidebar) updateDMListSidebar();
});

/* ============================================================
   CHAT POPUP
============================================================ */
$('btnOpenChat')?.addEventListener('click', () => {
  show($('chatPopup'));
  if (window.updateUIForSession) updateUIForSession();
  loadPublicMessages();
  renderOnlineList();
});
/* CLOSE CHATROOM → disconnect from online (but stay logged in) */
$('btnCloseChat')?.addEventListener('click', () => {
  const s = getSession();
  if (s) socket.emit("chatClosed", { username: s.username });
  hide($('chatPopup'));
});

$('btnMinimize')?.addEventListener('click', () => {
  const c = $('chatPopup');
  c.style.display = c.style.display === 'none' ? 'flex' : 'none';
});

/* ============================================================
   LOGOUT ON BROWSER CLOSE / REFRESH
============================================================ */
window.addEventListener("beforeunload", () => {
  const s = getSession();
  if (!s) return;

  socket.emit("forceLogout", { username: s.username });

  localStorage.removeItem("cw_session_v1");
  localStorage.removeItem("currentUser");
});

/* ============================================================
   PUBLIC CHAT — HISTORY
============================================================ */
async function loadPublicMessages(){
  const feed = $('publicFeed');
  if (!feed) return;

  feed.innerHTML = '';

  const res = await fetch('/api/public-messages');
  const data = await res.json();
  if (!data.ok) return;

  data.messages.forEach(m => appendPublicMessage(m));
}

/* ============================================================
   PUBLIC CHAT — SEND
============================================================ */
$('sendPublic')?.addEventListener('click', sendPublicMessage);
$('publicMessage')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') sendPublicMessage();
});

function sendPublicMessage(){
  const input = $('publicMessage');
  if (!input) return;

  const text = input.value.trim();
  if (!text) return;

  const s = getSession();
  if (!s) return;

  const msg = {
    from: s.username,
    display: s.display || s.username,
    text,
    time: new Date().toISOString()
  };

  socket.emit('publicMessage', msg);

  // Instant local render
  appendPublicMessage(msg);

  input.value = '';
}

/* ============================================================
   PUBLIC CHAT — RECEIVE
============================================================ */
socket.on('publicMessage', msg => {
  const s = getSession();
  if (msg.from === s.username) return; // prevent double render
  appendPublicMessage(msg);
});

socket.on("externalPublicMessage", msg => {
  appendPublicMessage(msg);
});

/* ============================================================
   PUBLIC CHAT — RENDER MESSAGE
============================================================ */
function appendPublicMessage(msg){
  const feed = $('publicFeed');
  if (!feed) return;

  const s = getSession();
  const user = (window.users || []).find(u => u.username === msg.from);
  const avatar = renderMessageAvatar(msg.from, msg.display, user?.imageUrl);

  const div = document.createElement('div');
  div.className = 'message-row ' + (s && msg.from === s.username ? 'me' : '');

  div.innerHTML = `
    <div class="message-avatar">${avatar}</div>
    <div class="message">
     <div style="font-weight:700; color:${user?.color || '#7fd8ff'}">
  ${msg.display}
  <span class="small" style="color:${user?.color || '#7fd8ff'}">
    @${msg.from} • ${new Date(msg.time).toLocaleTimeString()}
  </span>
</div>
      <div>${escapeHtml(msg.text)}</div>
    </div>
  `;

  feed.appendChild(div);
  feed.scrollTop = feed.scrollHeight;
}

/* ============================================================
   ROOMS — JOIN / SEND / RECEIVE
============================================================ */
function joinRoom(room){
  socket.emit('joinRoom', { room });
}

function sendRoomMessage(room, text){
  const s = getSession();
  if (!s) return;

  socket.emit('roomMessage', {
    room,
    from: s.username,
    display: s.display || s.username,
    text,
    time: new Date().toISOString()
  });
}

socket.on('roomHistory', ({ room, history }) => {
  const feed = $('roomFeed');
  if (!feed) return;

  feed.innerHTML = '';
  history.forEach(m => appendRoomMessage(m));
});

socket.on('roomMessage', msg => {
  const currentRoom = $('roomChatPopup').dataset.room;

  if (msg.room !== currentRoom) {
    incrementRoomUnread(msg.room);
    updateRoomsSidebarBadges();
    return;
  }

  appendRoomMessage(msg);
});


function appendRoomMessage(msg){
  const feed = $('roomFeed');
  if (!feed) return;

  const user = (window.users || []).find(u => u.username === msg.from);
  const avatar = renderMessageAvatar(msg.from, msg.display, user?.imageUrl);

  const div = document.createElement('div');
  div.className = 'message-row';

  div.innerHTML = `
    <div class="message-avatar">${avatar}</div>
    <div class="message">
      <div style="font-weight:700; color:${user?.color || '#7fd8ff'}">
  ${msg.display}
  <span class="small" style="color:${user?.color || '#7fd8ff'}">
    @${msg.from} • ${new Date(msg.time).toLocaleTimeString()}
  </span>
</div>
      <div>${escapeHtml(msg.text)}</div>
    </div>
  `;
if (msg.imageUrl) {
  html += `
    <img src="${msg.imageUrl}" class="chat-image" onclick="window.open('${msg.imageUrl}', '_blank')">
  `;
}

  feed.appendChild(div);
  feed.scrollTop = feed.scrollHeight;
}

document.getElementById("roomImageBtn").addEventListener("click", () => {
  document.getElementById("roomImageInput").click();
});

document.getElementById("roomImageInput").addEventListener("change", e => {
  const file = e.target.files[0];
  if (file) uploadRoomImage(file);
});

async function uploadRoomImage(file) {
  const data = await uploadImageToServer(file);

  if (!data.ok) {
    alert("Image upload failed");
    return;
  }

  socket.emit("roomMessage", {
    room: document.getElementById("roomChatPopup").dataset.room,
    from: getSession().username,
    imageUrl: data.imageUrl
  });
}

/* ============================================================
   PRIVATE MESSAGING HOOK
============================================================ */
function openPrivateWindow(username){
  console.log("PM:", username);
}

makeDraggable($('chatPopup'));

function makeDraggable(el) {
  let offsetX = 0, offsetY = 0, isDown = false;

  el.addEventListener('mousedown', (e) => {
    if (e.target.closest('.message') || e.target.closest('input') || e.target.closest('textarea')) return;

    isDown = true;
    offsetX = e.clientX - el.offsetLeft;
    offsetY = e.clientY - el.offsetTop;
    el.style.transition = "none";
  });

  document.addEventListener('mouseup', () => {
    isDown = false;
    el.style.transition = "";
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDown) return;
    el.style.left = (e.clientX - offsetX) + "px";
    el.style.top = (e.clientY - offsetY) + "px";
  });
}

$('createRoomBtn')?.addEventListener('click', () => {
  const name = prompt("Enter room name:");
  if (!name) return;

  const isPrivate = confirm("Make this a PRIVATE room?");

  socket.emit("createRoom", {
    name,
    private: isPrivate
  });
});

socket.on("roomsList", rooms => {
  window.rooms = rooms;
  renderRoomsSidebar();
});


function renderRoomsSidebar() {
  const list = $('roomsList');
  const sort = $('roomSort').value;
  const s = getSession();
  list.innerHTML = "";

  let rooms = [...(window.rooms || [])];

  // FILTER PRIVATE ROOMS
  rooms = rooms.filter(r => {
    if (!r.private) return true;
    if (r.owner?.toLowerCase() === s?.username?.toLowerCase()) return true;
    if (r.invitedUsers?.includes(s?.username)) return true;
    return false;
  });

  // SORTING
  if (sort === "newest") rooms.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  if (sort === "oldest") rooms.sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt));
  if (sort === "az") rooms.sort((a,b)=>a.name.localeCompare(b.name));
  if (sort === "za") rooms.sort((a,b)=>b.name.localeCompare(a.name));

  // RENDER ROOMS
  rooms.forEach(room => {
    const div = document.createElement("div");
    div.className = "room-item";

    div.innerHTML = `
      ${room.private ? "🔒 " : ""}${room.name}
    `;

    // CLICK TO OPEN ROOM CHAT
    div.addEventListener("click", () => {
      openRoomPopup(room._id, room.name);
    });

    // ⭐ INVITE BUTTON FOR OWNER ONLY
    if (room.owner?.toLowerCase() === s?.username?.toLowerCase()) {
      const inviteBtn = document.createElement("button");
      inviteBtn.className = "ghost small-btn";
      inviteBtn.textContent = "Invite";

      inviteBtn.addEventListener("click", (e) => {
        e.stopPropagation(); // prevent joinRoom()
        const username = prompt("Enter username to invite:");
        if (!username) return;

        socket.emit("inviteToRoom", {
          roomId: room._id,
          username
        });
      });

      div.appendChild(inviteBtn);
    }

    list.appendChild(div);
  });
}

$('roomSort')?.addEventListener('change', renderRoomsSidebar);
socket.on("roomInvited", ({ roomId, roomName }) => {
  alert(`You have been invited to join the private room: ${roomName}`);
});
// OPEN TOS
$('btnTOS')?.addEventListener('click', () => {
  $('modalTOS').style.display = 'flex';
});

// CLOSE TOS
$('closeTOS')?.addEventListener('click', () => {
  $('modalTOS').style.display = 'none';
});

// open rules
$('btnRules')?.addEventListener('click', () => {
  $('modalRules').style.display = 'flex';
});

// CLOSE rules
$('closeRules')?.addEventListener('click', () => {
  $('modalRules').style.display = 'none';
});
$('openSupport')?.addEventListener('click', () => {
  $('supportPopup').style.display = 'flex';
});

// CLOSE rules
$('closeSupport')?.addEventListener('click', () => {
  $('supportPopup').style.display = 'none';
});
// OPEN PRIVACY
$('btnPrivacy')?.addEventListener('click', () => {
  $('modalPrivacy').style.display = 'flex';
});
function updateRoomsSidebarBadges() {
  const unread = getRoomUnread();

  Object.keys(unread).forEach(roomId => {
    const badge = $('roomBadge_' + roomId);
    if (badge) {
      badge.textContent = unread[roomId];
      badge.style.display = 'inline-block';
    }
  });

  // hide badges for cleared rooms
  (window.rooms || []).forEach(r => {
    if (!unread[r._id]) {
      const badge = $('roomBadge_' + r._id);
      if (badge) badge.style.display = 'none';
    }
  });
}


// CLOSE PRIVACY
$('closePrivacy')?.addEventListener('click', () => {
  $('modalPrivacy').style.display = 'none';
});
function openRoomPopup(roomId, roomName) {
  const popup = $('roomChatPopup');
  $('roomChatTitle').textContent = roomName;

  popup.dataset.room = roomId;
  popup.style.display = 'flex';

  clearRoomUnread(roomId);
  updateRoomsSidebarBadges();

 socket.emit("joinRoom", { room: roomId });

// Request member list refresh
setTimeout(() => {
  socket.emit("requestRoomMembers", { room: roomId });
}, 200);
socket.on("requestRoomMembers", ({ room }) => {
  updateRoomMembers(room);
});

}


$('roomSendBtn').addEventListener('click', () => {
  const room = $('roomChatPopup').dataset.room;
  const text = $('roomMessageInput').value.trim();
  if (!text) return;

  sendRoomMessage(room, text);
  $('roomMessageInput').value = '';
});
$('closeRoomChat').addEventListener('click', () => {
  $('roomChatPopup').style.display = 'none';
});


let roomTypingTimeout;

$('roomMessageInput').addEventListener("input", () => {
  const room = $('roomChatPopup').dataset.room;
  const s = getSession();

  socket.emit("typingRoom", { room, from: s.username });

  clearTimeout(roomTypingTimeout);
  roomTypingTimeout = setTimeout(() => {
    socket.emit("stopTypingRoom", { room, from: s.username });
  }, 1200);
});
socket.on("typingRoom", ({ from, room }) => {
  const current = $('roomChatPopup').dataset.room;
  if (current !== room) return;

  const el = $('roomTyping');
  el.textContent = `${from} is typing...`;
  el.style.display = "block";
});

socket.on("stopTypingRoom", ({ from, room }) => {
  const current = $('roomChatPopup').dataset.room;
  if (current !== room) return;

  $('roomTyping').style.display = "none";
});
function renderRoomMembers(members) {
  const list = $('roomMembersList');
  if (!list) return;

  list.innerHTML = "";

  members.forEach(m => {
    const div = document.createElement("div");
    div.className = "room-member";

    const avatar = m.imageUrl
      ? `<img src="${m.imageUrl}" style="width:32px;height:32px;border-radius:50%">`
      : `<div class="avatar-fallback" style="width:32px;height:32px">${m.display[0]}</div>`;

    div.innerHTML = `
      ${avatar}
      <div style="flex:1">
        <div style="font-weight:700">${m.display}</div>
        <div class="small">@${m.username}</div>
      </div>
      <div class="room-member-status ${m.online ? "online" : "offline"}"></div>
    `;

    list.appendChild(div);
  });
}

socket.on("roomMembers", members => {
  renderRoomMembers(members);
});

document.getElementById("srType").addEventListener("change", () => {
  const type = document.getElementById("srType").value;
  document.getElementById("srUserSection").style.display =
    type === "user" ? "block" : "none";
});
document.getElementById("srSubmit").onclick = async () => {
  const me = getSession();
  if (!me) return alert("You must be logged in.");

  const type = document.getElementById("srType").value;
  const user = document.getElementById("srUser").value;
  const where = document.getElementById("srWhere").value;
  const when = document.getElementById("srWhen").value;
  const info = document.getElementById("srInfo").value;

  const payload = {
    from: me.username,
    to: "Administrator",
    text: `
Support Report
Type: ${type}
User: ${user || "N/A"}
Where: ${where}
When: ${when}
Info: ${info}
    `.trim()
  };

  await fetch("/api/send-dm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  alert("Report submitted.");
  closePopup("supportPopup");
};


/* ============================================================
   GLOBAL SAFE SELECTOR (works with utils.js)
============================================================ */
window.$ = window.$ || function(id) {
  return document.getElementById(id);
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
$('btnRoster')?.addEventListener('click', () => {
  $('modalRoster').style.display = 'flex';
  renderRosterPopup();
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

  list.innerHTML = '';

  (window.users || [])
    .filter(u =>
      u.username.toLowerCase().includes(search) ||
      u.display.toLowerCase().includes(search)
    )
    .forEach(u => {
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

      // CLICK → OPEN PROFILE
      div.addEventListener('click', () => openUserProfile(u.username));

      list.appendChild(div);
    });
}

// OPEN PROFILE (hook into your existing profile modal)
function openUserProfile(username) {
  const user = (window.users || []).find(u => u.username === username);
  if (!user) return;

  $('vpName').textContent = user.display;
  $('vpUsername').textContent = user.username;
  $('vpBio').textContent = user.info || "No bio provided";
  $('vpWins').textContent = user.wins ?? 0;
  $('vpLosses').textContent = user.losses ?? 0;
  $('vpLang').textContent = user.language || "Unknown";
  $('vpAge').textContent = user.age || "Unknown";

  $('vpColorBox').style.background = user.color || "#7fd8ff";

  if (user.imageUrl) {
    $('vpAvatar').src = user.imageUrl;
  } else {
    $('vpAvatar').src = "https://via.placeholder.com/120?text=No+Image";
  }

  $('modalViewProfile').style.display = "flex";
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

// MAIN ROSTER RENDERER
function renderRosterPopup() {
  const list = $('rosterPage');
  const search = $('rosterSearch').value.toLowerCase();
  const pageLabel = $('rosterPageNumber');

  list.innerHTML = '';

  // SORT NEWEST FIRST (based on MongoDB _id timestamp)
  let sorted = [...(window.users || [])].sort((a, b) => {
    return new Date(b.createdAt || b._id?.toString().slice(0, 8) * 1000) -
           new Date(a.createdAt || a._id?.toString().slice(0, 8) * 1000);
  });

  // FILTER BY SEARCH
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

  // UPDATE PAGE LABEL
  pageLabel.textContent = `Page ${rosterPage} / ${totalPages}`;

  // ENABLE/DISABLE BUTTONS
  $('rosterPrev').disabled = rosterPage <= 1;
  $('rosterNext').disabled = rosterPage >= totalPages;
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
      <div style="display:flex;gap:8px;align-items:center">
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
      <div style="display:flex;gap:8px;align-items:center">
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

  feed.appendChild(div);
  feed.scrollTop = feed.scrollHeight;
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
  list.innerHTML = "";

  (window.rooms || []).forEach(room => {
    const div = document.createElement("div");
    div.className = "room-item";
    div.textContent = room.name;

    div.addEventListener("click", () => {
      joinRoom(room._id);
    });

    list.appendChild(div);
  });
}

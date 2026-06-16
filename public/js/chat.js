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

$('btnCloseChat')?.addEventListener('click', () => hide($('chatPopup')));
$('btnMinimize')?.addEventListener('click', () => {
  const c = $('chatPopup');
  c.style.display = c.style.display === 'none' ? 'flex' : 'none';
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
      <div style="font-weight:700">
        ${msg.display}
        <span class="small">@${msg.from} • ${new Date(msg.time).toLocaleTimeString()}</span>
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
      <div style="font-weight:700">
        ${msg.display}
        <span class="small">@${msg.from} • ${new Date(msg.time).toLocaleTimeString()}</span>
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

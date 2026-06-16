// -------------------------------------------------------------
// ELEMENT HELPERS
// -------------------------------------------------------------
function $(id) {
  return document.getElementById(id);
}

function show(el) {
  if (el) el.style.display = 'flex';
}

function hide(el) {
  if (el) el.style.display = 'none';
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// -------------------------------------------------------------
// AVATAR RENDERING
// -------------------------------------------------------------
function renderMessageAvatar(username, display, imageUrl, size = 36) {
  const initials = display
    ? display.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
    : (username || '?')[0].toUpperCase();

  if (imageUrl) {
    return `<img src="${imageUrl}" class="avatar-img" style="width:${size}px;height:${size}px" alt="avatar">`;
  }

  return `<div class="avatar-fallback" style="width:${size}px;height:${size}px">${initials}</div>`;
}

// -------------------------------------------------------------
// SESSION HELPER (ASSUMES YOU ALREADY HAVE THIS GLOBALLY)
// -------------------------------------------------------------
function getSession() {
  try {
    const raw = localStorage.getItem('session');
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// -------------------------------------------------------------
// QUICK ROSTER (TOP USERS PREVIEW)
// -------------------------------------------------------------
function renderQuickRoster() {
  const el = $('quickRoster');
  if (!el) return;

  el.innerHTML = '';

  (window.users || []).slice(0, 6).forEach(u => {
    const avatarHtml = renderMessageAvatar(
      u.username,
      u.display,
      u.imageUrl,
      40
    );

    const div = document.createElement('div');
    div.className = 'user-row';
    div.innerHTML = `
      <div class="avatar-wrapper">${avatarHtml}</div>
      <div style="flex:1">
        <div style="font-weight:700">${u.display}</div>
        <div class="small">${u.username}</div>
      </div>
      <div class="status online"></div>
    `;

    el.appendChild(div);
  });
}

// -------------------------------------------------------------
// FULL ROSTER PAGE
// -------------------------------------------------------------
function renderRosterPage() {
  const el = $('rosterPage');
  if (!el) return;

  el.innerHTML = '';

  (window.users || []).forEach(u => {
    const avatarHtml = renderMessageAvatar(
      u.username,
      u.display,
      u.imageUrl,
      44
    );

    const row = document.createElement('div');
    row.className = 'user-row';
    row.innerHTML = `
      ${avatarHtml}
      <div style="flex:1">
        <div style="font-weight:700">${u.display}</div>
        <div class="small">${u.username}</div>
      </div>
      <button class="small-btn" data-user="${u.username}">Message</button>
    `;

    el.appendChild(row);
  });

  el.querySelectorAll('.small-btn').forEach(b => {
    b.addEventListener('click', e => openPrivateWindow(e.target.dataset.user));
  });
}

// -------------------------------------------------------------
// ONLINE LIST (RIGHT SIDEBAR IN CHAT)
// -------------------------------------------------------------
function renderOnlineList() {
  const el = $('onlineList');
  if (!el) return;
  el.innerHTML = '';

  (window.users || []).forEach(u => {
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.justifyContent = 'space-between';

    row.innerHTML = `
      <div style="display:flex;gap:8px;align-items:center">
        ${renderMessageAvatar(u.username, u.display, u.imageUrl, 36)}
        <div>
          <div style="font-weight:700">${u.display}</div>
          <div class="small">${u.username}</div>
        </div>
      </div>
      <button class="small-btn" data-user="${u.username}">PM</button>
    `;

    el.appendChild(row);
  });

  el.querySelectorAll('.small-btn').forEach(b => {
    b.addEventListener('click', e => openPrivateWindow(e.target.dataset.user));
  });
}

// -------------------------------------------------------------
// OPTIONAL: DM SIDEBAR LIST UPDATER HOOK
// -------------------------------------------------------------
function updateDMListSidebar() {
  const sidebar = $('dmSidebar');
  if (!sidebar) return;

  const list = sidebar.querySelector('.dm-list');
  if (!list) return;

  list.innerHTML = '';

  (window.users || []).forEach(u => {
    const avatarHtml = renderMessageAvatar(
      u.username,
      u.display,
      u.imageUrl,
      32
    );

    const div = document.createElement('div');
    div.className = 'dm-sidebar-item';
    div.innerHTML = `
      <div style="display:flex;gap:8px;align-items:center">
        ${avatarHtml}
        <div>
          <div style="font-weight:700">${u.display}</div>
          <div class="small">${u.username}</div>
        </div>
      </div>
    `;

    div.addEventListener('click', () => openPrivateWindow(u.username));
    list.appendChild(div);
  });
}

// -------------------------------------------------------------
// SOCKET.IO PRESENCE HANDLER
// -------------------------------------------------------------
socket.on('presence', onlineUsers => {
  window.users = onlineUsers;
  renderQuickRoster();
  renderRosterPage();
  renderOnlineList();
  if (window.updateDMListSidebar) updateDMListSidebar();
});

// -------------------------------------------------------------
// CHAT POPUP OPEN/CLOSE
// -------------------------------------------------------------
$('btnOpenChat')?.addEventListener('click', openChat);
$('btnCloseChat')?.addEventListener('click', () => hide($('chatPopup')));
$('btnMinimize')?.addEventListener('click', () => {
  const c = $('chatPopup');
  if (!c) return;
  c.style.display = c.style.display === 'none' ? 'flex' : 'none';
});

function openChat() {
  show($('chatPopup'));
  if (window.updateUIForSession) updateUIForSession();
  loadPublicMessages();
  renderOnlineList();
}

// -------------------------------------------------------------
// PUBLIC CHAT — LOAD HISTORY FROM SERVER
// -------------------------------------------------------------
async function loadPublicMessages() {
  const feed = $('publicFeed');
  if (!feed) return;

  feed.innerHTML = '';

  try {
    const res = await fetch('/api/public-messages');
    const data = await res.json();
    if (!data.ok) return;

    const messages = data.messages;
    const s = getSession();

    messages.forEach(m => {
      const user = (window.users || []).find(u => u.username === m.from);
      const avatarHtml = renderMessageAvatar(
        m.from,
        m.display,
        user?.imageUrl
      );

      const div = document.createElement('div');
      div.className = 'message-row ' + (s && m.from === s.username ? 'me' : '');

      div.innerHTML = `
        <div class="message-avatar">${avatarHtml}</div>
        <div class="message">
          <div style="font-size:13px;font-weight:700">
            ${m.display}
            <span class="small">@${m.from} • ${new Date(m.time).toLocaleTimeString()}</span>
          </div>
          <div style="margin-top:6px">${escapeHtml(m.text)}</div>
        </div>
      `;

      feed.appendChild(div);
    });

    feed.scrollTop = feed.scrollHeight;
  } catch (e) {
    console.error('loadPublicMessages error', e);
  }
}

// -------------------------------------------------------------
// PUBLIC CHAT — SEND MESSAGE
// -------------------------------------------------------------
$('sendPublic')?.addEventListener('click', sendPublicMessage);
$('publicMessage')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') sendPublicMessage();
});

function sendPublicMessage() {
  const input = $('publicMessage');
  if (!input) return;

  const txt = input.value.trim();
  if (!txt) return;

  const s = getSession();
  if (!s) return;

  const msg = {
    from: s.username,
    display: s.display || s.username,
    text: txt
  };

  socket.emit('publicMessage', msg);
  input.value = '';
}

// -------------------------------------------------------------
// SOCKET — RECEIVE PUBLIC MESSAGE
// -------------------------------------------------------------
socket.on('publicMessage', msg => {
  const feed = $('publicFeed');
  if (!feed) return;

  const s = getSession();
  const user = (window.users || []).find(u => u.username === msg.from);
  const avatarHtml = renderMessageAvatar(
    msg.from,
    msg.display,
    user?.imageUrl
  );

  const div = document.createElement('div');
  div.className = 'message-row ' + (s && msg.from === s.username ? 'me' : '');

  div.innerHTML = `
    <div class="message-avatar">${avatarHtml}</div>
    <div class="message">
      <div style="font-size:13px;font-weight:700">
        ${msg.display}
        <span class="small">@${msg.from} • ${new Date(msg.time).toLocaleTimeString()}</span>
      </div>
      <div style="margin-top:6px">${escapeHtml(msg.text)}</div>
    </div>
  `;

  feed.appendChild(div);
  feed.scrollTop = feed.scrollHeight;
});

// -------------------------------------------------------------
// ROOMS — JOIN / SEND / RECEIVE
// -------------------------------------------------------------
function joinRoom(roomName) {
  socket.emit('joinRoom', { room: roomName });
}

function sendRoomMessage(room, text) {
  const s = getSession();
  if (!s) return;

  socket.emit('roomMessage', {
    room,
    from: s.username,
    display: s.display || s.username,
    text
  });
}

// ROOM HISTORY
socket.on('roomHistory', ({ room, history }) => {
  const feed = $('roomFeed');
  if (!feed) return;

  feed.innerHTML = '';

  history.forEach(m => {
    const user = (window.users || []).find(u => u.username === m.from);
    const avatarHtml = renderMessageAvatar(
      m.from,
      m.display,
      user?.imageUrl
    );

    const div = document.createElement('div');
    div.className = 'message-row';

    div.innerHTML = `
      <div class="message-avatar">${avatarHtml}</div>
      <div class="message">
        <div style="font-weight:700">
          ${m.display}
          <span class="small">@${m.from} • ${new Date(m.time).toLocaleTimeString()}</span>
        </div>
        <div>${escapeHtml(m.text)}</div>
      </div>
    `;

    feed.appendChild(div);
  });

  feed.scrollTop = feed.scrollHeight;
});

// NEW ROOM MESSAGE
socket.on('roomMessage', msg => {
  const feed = $('roomFeed');
  if (!feed) return;

  const user = (window.users || []).find(u => u.username === msg.from);
  const avatarHtml = renderMessageAvatar(
    msg.from,
    msg.display,
    user?.imageUrl
  );

  const div = document.createElement('div');
  div.className = 'message-row';

  div.innerHTML = `
    <div class="message-avatar">${avatarHtml}</div>
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
});

// -------------------------------------------------------------
// PLACEHOLDER: PRIVATE MESSAGING WINDOW (IF YOU ALREADY HAVE IT)
// -------------------------------------------------------------
function openPrivateWindow(username) {
  // Hook into your existing PM window logic
  console.log('Open PM with', username);
}

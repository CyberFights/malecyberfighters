// -------------------------------------------------------------
// ELEMENT HELPERS
// -------------------------------------------------------------
function $(id) {
  return document.getElementById(id);
}

// -------------------------------------------------------------
// AVATAR RENDERING (CSP-SAFE)
// -------------------------------------------------------------
function renderMessageAvatar(username, display, imageUrl, size = 36) {
  const initials = display
    ? display.split(" ").map(n => n[0]).join("").toUpperCase().slice(0, 2)
    : username[0].toUpperCase();

  if (imageUrl) {
    return `<img src="${imageUrl}" class="avatar-img" style="width:${size}px;height:${size}px" alt="avatar">`;
  }

  return `<div class="avatar-fallback" style="width:${size}px;height:${size}px">${initials}</div>`;
}

// -------------------------------------------------------------
// CHAT OPEN
// -------------------------------------------------------------
$('btnOpenChat').addEventListener('click', openChat);
$('btnCloseChat').addEventListener('click', () => hide($('chatPopup')));
$('btnMinimize').addEventListener('click', () => {
  const c = $('chatPopup');
  c.style.display = c.style.display === 'none' ? 'flex' : 'none';
});

$('sendPublic').addEventListener('click', sendPublicMessage);
$('publicMessage').addEventListener('keydown', e => {
  if (e.key === 'Enter') sendPublicMessage();
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

  const res = await fetch("/api/public-messages");
  const data = await res.json();
  if (!data.ok) return;

  const messages = data.messages;
  const s = getSession();

  messages.forEach(m => {
    const user = window.users?.find(u => u.username === m.from);
    const avatarHtml = renderMessageAvatar(m.from, m.display, user?.imageUrl);

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
}

// -------------------------------------------------------------
// PUBLIC CHAT — SEND MESSAGE
// -------------------------------------------------------------
function sendPublicMessage() {
  const txt = $('publicMessage').value.trim();
  if (!txt) return;

  const s = getSession();
  const msg = {
    from: s.username,
    display: s.display || s.username,
    text: txt
  };

  socket.emit('publicMessage', msg);
  $('publicMessage').value = '';
}

// -------------------------------------------------------------
// SOCKET — RECEIVE PUBLIC MESSAGE
// -------------------------------------------------------------
socket.on("publicMessage", (msg) => {
  const feed = $('publicFeed');
  if (!feed) return;

  const s = getSession();
  const user = window.users?.find(u => u.username === msg.from);
  const avatarHtml = renderMessageAvatar(msg.from, msg.display, user?.imageUrl);

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
// ONLINE LIST
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
// ROOMS — JOIN ROOM
// -------------------------------------------------------------
function joinRoom(roomName) {
  socket.emit("joinRoom", { room: roomName });
}

// -------------------------------------------------------------
// ROOMS — SEND MESSAGE
// -------------------------------------------------------------
function sendRoomMessage(room, text) {
  const s = getSession();
  socket.emit("roomMessage", {
    room,
    from: s.username,
    display: s.display || s.username,
    text
  });
}

// -------------------------------------------------------------
// ROOMS — RECEIVE HISTORY
// -------------------------------------------------------------
socket.on("roomHistory", ({ room, history }) => {
  const feed = $('roomFeed');
  if (!feed) return;

  feed.innerHTML = "";

  history.forEach(m => {
    const user = window.users?.find(u => u.username === m.from);
    const avatarHtml = renderMessageAvatar(m.from, m.display, user?.imageUrl);

    const div = document.createElement("div");
    div.className = "message-row";

    div.innerHTML = `
      <div class="message-avatar">${avatarHtml}</div>
      <div class="message">
        <div style="font-weight:700">${m.display}
          <span class="small">@${m.from} • ${new Date(m.time).toLocaleTimeString()}</span>
        </div>
        <div>${escapeHtml(m.text)}</div>
      </div>
    `;

    feed.appendChild(div);
  });

  feed.scrollTop = feed.scrollHeight;
});

// -------------------------------------------------------------
// ROOMS — RECEIVE NEW MESSAGE
// -------------------------------------------------------------
socket.on("roomMessage", (msg) => {
  const feed = $('roomFeed');
  if (!feed) return;

  const user = window.users?.find(u => u.username === msg.from);
  const avatarHtml = renderMessageAvatar(msg.from, msg.display, user?.imageUrl);

  const div = document.createElement("div");
  div.className = "message-row";

  div.innerHTML = `
    <div class="message-avatar">${avatarHtml}</div>
    <div class="message">
      <div style="font-weight:700">${msg.display}
        <span class="small">@${msg.from} • ${new Date(msg.time).toLocaleTimeString()}</span>
      </div>
      <div>${escapeHtml(msg.text)}</div>
    </div>
  `;

  feed.appendChild(div);
  feed.scrollTop = feed.scrollHeight;
});

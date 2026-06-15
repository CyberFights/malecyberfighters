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

/* -----------------------------------------------------------
   AVATAR RENDERING (CSP-SAFE)
----------------------------------------------------------- */
function renderAvatar(u, size = 36) {
  const initials = u.display
    ? u.display.split(" ").map(n => n[0]).join("").toUpperCase().slice(0, 2)
    : u.username[0].toUpperCase();

  if (u.imageUrl) {
    return `<img src="${u.imageUrl}" class="avatar-img" style="width:${size}px;height:${size}px" alt="avatar">`;
  }

  return `<div class="avatar-fallback" style="width:${size}px;height:${size}px">${initials}</div>`;
}

/* -----------------------------------------------------------
   CHAT OPEN
----------------------------------------------------------- */
function openChat() {
  show($('chatPopup'));
  if (window.updateUIForSession) updateUIForSession();
  renderPublicFeed();
  renderOnlineList();
}

/* -----------------------------------------------------------
   PUBLIC MESSAGES
----------------------------------------------------------- */
function sendPublicMessage() {
  const txt = $('publicMessage').value.trim();
  if (!txt) return;

  const s = getSession();
  const msg = {
    from: s ? s.username : 'guest',
    display: s ? (s.display || s.displayName || s.username) : 'Guest',
    text: txt
  };

  socket.emit('publicMessage', msg);
  $('publicMessage').value = '';
}

function renderPublicFeed() {
  const feed = $('publicFeed');
  if (!feed) return;
  feed.innerHTML = '';

  const messages = loadPublic();
  const s = getSession();

  messages.forEach(m => {
    const div = document.createElement('div');
    div.className = 'message' + (s && m.from === s.username ? ' me' : '');
    div.innerHTML = `
      <div style="font-size:13px;font-weight:700">
        ${m.display}
        <span class="small">@${m.from} • ${new Date(m.time || Date.now()).toLocaleTimeString()}</span>
      </div>
      <div style="margin-top:6px">${escapeHtml(m.text)}</div>
    `;
    feed.appendChild(div);
  });

  feed.scrollTop = feed.scrollHeight;
}

/* -----------------------------------------------------------
   QUICK ROSTER
----------------------------------------------------------- */
function renderQuickRoster() {
  const el = $('quickRoster');
  if (!el) return;
  el.innerHTML = '';

  (window.users || []).slice(0, 6).forEach(u => {
    const div = document.createElement('div');
    div.className = 'user-row';
    div.innerHTML = `
      ${renderAvatar(u, 36)}
      <div style="flex:1">
        <div style="font-weight:700">${u.display}</div>
        <div class="small">${u.username}</div>
      </div>
      <div class="status online"></div>
    `;
    el.appendChild(div);
  });
}

/* -----------------------------------------------------------
   FULL ROSTER PAGE
----------------------------------------------------------- */
function renderRosterPage() {
  const el = $('rosterPage');
  if (!el) return;
  el.innerHTML = '';

  (window.users || []).forEach(u => {
    const row = document.createElement('div');
    row.className = 'user-row';
    row.innerHTML = `
      ${renderAvatar(u, 40)}
      <div style="flex:1">
        <div style="font-weight:700">${u.display}</div>
        <div class="small">${u.username}</div>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end">
        <div class="status online"></div>
        <button class="small-btn" data-user="${u.username}">Message</button>
      </div>
    `;
    el.appendChild(row);
  });

  el.querySelectorAll('.small-btn').forEach(b => {
    b.addEventListener('click', e => openPrivateWindow(e.target.dataset.user));
  });
}

/* -----------------------------------------------------------
   ONLINE LIST (CHAT SIDEBAR)
----------------------------------------------------------- */
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
        ${renderAvatar(u, 36)}
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

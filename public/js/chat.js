$('btnOpenChat').addEventListener('click', openChat);
$('btnCloseChat').addEventListener('click', () => hide($('chatPopup')));
$('btnMinimize').addEventListener('click', () => {
  const c = $('chatPopup');
  c.style.display = c.style.display === 'none' ? 'flex' : 'none';
});

$('sendPublic').addEventListener('click', sendPublicMessage);
$('publicMessage').addEventListener('keydown', e => { if(e.key === 'Enter') sendPublicMessage(); });

function openChat(){
  show($('chatPopup'));
  updateUIForSession();
  renderPublicFeed();
  renderOnlineList();
}

function sendPublicMessage(){
  const txt = $('publicMessage').value.trim();
  if(!txt) return;

  const s = getSession();
  const msg = {
    from: s ? s.username : 'guest',
    display: s ? s.display : 'Guest',
    text: txt
  };

  socket.emit('publicMessage', msg);
  $('publicMessage').value = '';
}

function renderPublicFeed(){
  const feed = $('publicFeed');
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

function renderQuickRoster(){
  const el = $('quickRoster');
  el.innerHTML = '';
  (window.users || []).slice(0,6).forEach(u => {
    const div = document.createElement('div');
    div.className = 'user-row';
    div.innerHTML = `
      <div class="avatar">${u.display[0]}</div>
      <div style="flex:1">
        <div style="font-weight:700">${u.display}</div>
        <div class="small">${u.username}</div>
      </div>
      <div class="status online"></div>
    `;
    el.appendChild(div);
  });
}

function renderRosterPage(){
  const el = $('rosterPage');
  el.innerHTML = '';
  (window.users || []).forEach(u => {
    const row = document.createElement('div');
    row.className = 'user-row';
    row.innerHTML = `
      <div class="avatar">${u.display[0]}</div>
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

function renderOnlineList(){
  const el = $('onlineList');
  el.innerHTML = '';
  (window.users || []).forEach(u => {
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.justifyContent = 'space-between';
    row.innerHTML = `
      <div style="display:flex;gap:8px;align-items:center">
        <div class="avatar" style="width:36px;height:36px">${u.display[0]}</div>
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

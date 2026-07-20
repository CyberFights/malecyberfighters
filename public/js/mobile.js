
// Normalize messages to match index.js (username, avatar, message, image, timestamp)
function normalizeMessage(msg) {
  return {
    username: msg.username || msg.user || msg.name || "Unknown",
    avatar: msg.avatar || "/img/default-avatar.png",
    message: msg.message || msg.text || msg.msg || "",
    image: msg.image || null,
    timestamp: msg.timestamp || msg.time || msg.createdAt || null
  };
}

function formatTimestamp(ts) {
  if (!ts) return "";
  try {
    const d = new Date(ts);
    // Short time on right side
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return "";
  }
}

// Session helpers (assumes setSession/getSession exist elsewhere)
function setSession(user) {
  window.currentUser = user;
}
function getSession() {
  return window.currentUser || null;
}
function clearSession() {
  window.currentUser = null;
}

// LOGIN
document.addEventListener('DOMContentLoaded', () => {
  const stored = localStorage.getItem('currentUser');
  if (stored) {
    const user = JSON.parse(stored);
    setSession(user);
    $('loginScreen').style.display = 'none';
    $('app').style.display = 'block';
    if (window.socket) socket.emit('login', user);
    if (window.updateUIForSession) updateUIForSession();
    if (window.updateProfileCard) updateProfileCard(user);
    if (window.updateDMListSidebar) updateDMListSidebar();
    bindSidebar();
    bindChat();
    bindDMDrawer();
    if (window.socket) socket.emit('getChatHistory');
  } else {
    bindLogin();
  }
});

function bindLogin() {
  $('loginSubmit').addEventListener('click', doLogin);
  $('loginPass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
}

async function doLogin() {
  const username = $('loginUser').value.trim();
  const password = $('loginPass').value;
  const err = $('loginError');
  err.style.display = 'none';
  if (!username || !password) {
    err.textContent = "Enter username and password";
    err.style.display = 'block';
    return;
  }
  try {
    const resp = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await resp.json();
    if (!data.ok) {
      err.textContent = data.error === 'banned' ? 'You are banned.' : 'Invalid credentials';
      err.style.display = 'block';
      return;
    }
    $('loginScreen').style.display = 'none';
    $('app').style.display = 'block';
    setSession(data.user);
    localStorage.setItem('currentUser', JSON.stringify(data.user));
    if (window.socket) socket.emit('login', data.user);
    if (window.updateUIForSession) updateUIForSession();
    if (window.updateProfileCard) updateProfileCard(data.user);
    if (window.updateDMListSidebar) updateDMListSidebar();
    $('loginUser').value = '';
    $('loginPass').value = '';
    bindSidebar();
    bindChat();
    bindDMDrawer();
    if (window.socket) socket.emit('getChatHistory');
  } catch (e) {
    err.textContent = "Network error";
    err.style.display = 'block';
  }
}

function logout() {
  clearSession();
  localStorage.removeItem('currentUser');
  location.reload();
}

// Sidebar
function bindSidebar() {
  document.querySelectorAll('.sidebar-item').forEach(item => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      const section = item.dataset.section;
      if (section === 'logout') { logout(); return; }
      if (section === 'chat') { showView('viewChat'); if (window.socket) socket.emit('getChatHistory'); return; }
      if (section === 'roster') { showView('viewRoster'); return; }
      if (section === 'messages') { showView('viewMessages'); return; }
      if (section === 'rooms') { showView('viewRooms'); return; }
      if (section === 'profile') { showView('viewProfile'); return; }
      if (section === 'admin') { showView('viewAdmin'); if (window.loadAdminPanel) loadAdminPanel(); return; }
      if (section === 'dms') { openDMDrawer(); return; }
    });
  });
}

function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

// Chat
function bindChat() {
  // Ensure socket exists
  if (typeof socket === 'undefined') return;

  const onlineToggle = $('onlineToggle');
  if (onlineToggle) onlineToggle.addEventListener('click', () => {
    const drawer = $('onlineDrawer');
    if (drawer) drawer.classList.toggle('open');
  });

  const sendBtn = $('chatSend');
  if (sendBtn) sendBtn.addEventListener('click', () => {
    const text = $('chatInput').value.trim();
    if (!text) return;
    socket.emit('publicMessage', { message: text });
    $('chatInput').value = '';
  });

  const input = $('chatInput');
  if (input) input.addEventListener('keydown', e => { if (e.key === 'Enter') $('chatSend').click(); });

  const uploadBtn = $('chatUpload');
  if (uploadBtn) uploadBtn.addEventListener('click', () => { const f = $('chatImageFile'); if (f) f.click(); });

  const fileInput = $('chatImageFile');
  if (fileInput) fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    const form = new FormData();
    form.append('image', file);
    $('chatInput').value = "Uploading image…";
    try {
      const resp = await fetch('/api/upload-image', { method: 'POST', body: form });
      const data = await resp.json();
      if (!data.ok) { $('chatInput').value = ""; alert("Image upload failed"); return; }
      socket.emit('publicMessage', { message: "", image: data.url });
      $('chatInput').value = "";
    } catch (e) {
      $('chatInput').value = "";
      alert("Network error");
    }
  });

  // Chat history
  socket.on('chatHistory', history => {
    const container = $('chatMessages');
    if (!container) return;
    container.innerHTML = '';
    history.forEach(raw => {
      renderChatMessage(normalizeMessage(raw));
    });
  });

  // Live messages
  socket.on('publicMessage', raw => {
    renderChatMessage(normalizeMessage(raw));
  });

  // Online users
  socket.on('onlineUsers', list => {
    const box = $('onlineList');
    if (!box) return;
    box.innerHTML = '';
    list.forEach(u => {
      const avatar = u.avatar || "/img/default-avatar.png";
      const div = document.createElement('div');
      div.className = "onlineUser";
      div.innerHTML = `<img src="${avatar}" alt="avatar"><div><div style="font-weight:700">${u.username}</div><div style="color:var(--muted);font-size:12px">@${u.username}</div></div>`;
      box.appendChild(div);
    });
  });
}

function renderChatMessage(msg) {
  const container = $('chatMessages');
  if (!container) return;
  const me = getSession();
  const box = document.createElement('div');
  box.className = "chatMessage" + (me && msg.username === me.username ? " me" : "");
  const avatarHtml = `<img class="avatar" src="${msg.avatar}" alt="avatar">`;
  const timestampHtml = `<div class="timestamp">${formatTimestamp(msg.timestamp)}</div>`;
  const authorRow = `<div class="author-row"><div class="author">${msg.username}</div>${timestampHtml}</div>`;
  const textHtml = msg.message ? `<div class="text">${escapeHtml(msg.message)}</div>` : '';
  const imageHtml = msg.image ? `<img src="${msg.image}" class="chatImage" alt="image">` : '';
  box.innerHTML = `${avatarHtml}<div class="msgBody">${authorRow}${textHtml}${imageHtml}</div>`;
  container.appendChild(box);
  container.scrollTop = container.scrollHeight;
}

// DM Drawer
function bindDMDrawer() {
  const dmClose = $('dmClose');
  if (dmClose) dmClose.addEventListener('click', closeDMDrawer);
  const dmSend = $('dmSend');
  if (dmSend) dmSend.addEventListener('click', sendDM);
  const dmInput = $('dmInput');
  if (dmInput) dmInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendDM(); });

  if (typeof socket !== 'undefined') {
    socket.on('dmMessage', raw => {
      const msg = normalizeMessage(raw);
      renderDMMessage(msg);
    });
  }
}

function openDMDrawer() { const d = $('dmDrawer'); if (d) d.classList.add('open'); }
function closeDMDrawer() { const d = $('dmDrawer'); if (d) d.classList.remove('open'); }

function sendDM() {
  const text = $('dmInput').value.trim();
  if (!text || !window.currentDMTarget) return;
  if (typeof socket !== 'undefined') {
    socket.emit('dmMessage', { to: window.currentDMTarget, message: text });
    $('dmInput').value = '';
  }
}

function renderDMMessage(msg) {
  const box = document.createElement('div');
  box.className = "chatMessage";
  box.innerHTML = `<div class="msgBody"><div class="author-row"><div class="author">${msg.username}</div><div class="timestamp">${formatTimestamp(msg.timestamp)}</div></div><div class="text">${escapeHtml(msg.message)}</div></div>`;
  const container = $('dmMessages');
  if (container) { container.appendChild(box); container.scrollTop = container.scrollHeight; }
}

// Utility: simple HTML escape
function escapeHtml(s) {
  if (!s) return '';
  return s.replace(/[&<>"']/g, function (m) {
    return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[m];
  });
}


// Normalize messages to match index.js + MongoDB + desktop chat.js
function normalizeMessage(msg) {
  return {
    username: msg.username || msg.user || msg.name || "Unknown",
    avatar: msg.avatar || "/img/default-avatar.png",
    message: msg.message || msg.text || msg.msg || "",
    image: msg.image || null,
    timestamp: msg.timestamp || msg.time || null
  };
}

// Format timestamp for mobile display
function formatTimestamp(ts) {
  if (!ts) return "";
  try {
    const d = new Date(ts);
    return d.toLocaleString(); // mobile-friendly
  } catch {
    return "";
  }
}

// LOGIN
$('loginSubmit').addEventListener('click', doLogin);
$('loginPass').addEventListener('keydown', e => {
  if (e.key === 'Enter') doLogin();
});

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
      err.textContent = data.error === 'banned'
        ? 'You are banned.'
        : 'Invalid credentials';
      err.style.display = 'block';
      return;
    }

    $('loginScreen').style.display = 'none';
    $('app').style.display = 'block';

    setSession(data.user);
    localStorage.setItem('currentUser', JSON.stringify(data.user));
    socket.emit('login', data.user);

    if (window.updateUIForSession) updateUIForSession();
    if (window.updateProfileCard) updateProfileCard(data.user);
    if (window.updateDMListSidebar) updateDMListSidebar();

    $('loginUser').value = '';
    $('loginPass').value = '';

    bindSidebar();
    bindChat();
    bindDMDrawer();

    socket.emit('getChatHistory');

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

// SIDEBAR
function bindSidebar() {
  document.querySelectorAll('.sidebar-item').forEach(item => {
    item.addEventListener('click', () => {

      document.querySelectorAll('.sidebar-item')
        .forEach(i => i.classList.remove('active'));
      item.classList.add('active');

      const section = item.dataset.section;

      if (section === 'logout') {
        logout();
        return;
      }

      if (section === 'chat') {
        showView('viewChat');
        socket.emit('getChatHistory');
        return;
      }

      if (section === 'roster') {
        showView('viewRoster');
        return;
      }

      if (section === 'messages') {
        showView('viewMessages');
        return;
      }

      if (section === 'rooms') {
        showView('viewRooms');
        return;
      }

      if (section === 'profile') {
        showView('viewProfile');
        return;
      }

      if (section === 'admin') {
        showView('viewAdmin');
        if (window.loadAdminPanel) loadAdminPanel();
        return;
      }

      if (section === 'dms') {
        openDMDrawer();
        return;
      }
    });
  });
}

function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $(id).classList.add('active');
}

// CHAT
function bindChat() {

  $('onlineToggle').addEventListener('click', () => {
    $('onlineDrawer').classList.toggle('open');
  });

  // Send message
  $('chatSend').addEventListener('click', () => {
    const text = $('chatInput').value.trim();
    if (!text) return;

    socket.emit('publicMessage', { message: text });
    $('chatInput').value = '';
  });

  $('chatInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') $('chatSend').click();
  });

  // Image upload
  $('chatUpload').addEventListener('click', () => {
    $('chatImageFile').click();
  });

  $('chatImageFile').addEventListener('change', async () => {
    const file = $('chatImageFile').files[0];
    if (!file) return;

    const form = new FormData();
    form.append('image', file);

    $('chatInput').value = "Uploading image…";

    try {
      const resp = await fetch('/api/upload-image', {
        method: 'POST',
        body: form
      });

      const data = await resp.json();

      if (!data.ok) {
        $('chatInput').value = "";
        alert("Image upload failed");
        return;
      }

      socket.emit('publicMessage', {
        message: "",
        image: data.url
      });

      $('chatInput').value = "";

    } catch (e) {
      $('chatInput').value = "";
      alert("Network error");
    }
  });

  // Load chat history
  socket.on('chatHistory', history => {
    $('chatBox').innerHTML = "";
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
    box.innerHTML = '';

    list.forEach(u => {
      const avatar = u.avatar || "/img/default-avatar.png";
      const div = document.createElement('div');
      div.className = "onlineUser";
      div.innerHTML = `
        <img src="${avatar}">
        <span>${u.username}</span>
      `;
      box.appendChild(div);
    });
  });
}

function renderChatMessage(msg) {
  const me = getSession();

  const box = document.createElement("div");
  box.className = "chatMessage" + (me && msg.username === me.username ? " me" : "");

  let body = `
    <img src="${msg.avatar}">
    <div class="msgBody">
      <div class="author">${msg.username}</div>
      <div class="timestamp">${formatTimestamp(msg.timestamp)}</div>
  `;

  if (msg.message) {
    body += `<div class="text">${msg.message}</div>`;
  }

  if (msg.image) {
    body += `<img src="${msg.image}" class="chatImage">`;
  }

  body += `</div>`;

  box.innerHTML = body;

  $('chatBox').appendChild(box);
  $('chatBox').scrollTop = $('chatBox').scrollHeight;
}

// DM DRAWER
function bindDMDrawer() {
  $('dmClose').addEventListener('click', closeDMDrawer);

  $('dmSend').addEventListener('click', sendDM);

  $('dmInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') sendDM();
  });

  if (window.updateDMListSidebar) {
    updateDMListSidebar();
  }

  socket.on('dmMessage', raw => {
    const msg = normalizeMessage(raw);
    renderDMMessage(msg);
  });
}

function openDMDrawer() {
  $('dmDrawer').classList.add('open');
}

function closeDMDrawer() {
  $('dmDrawer').classList.remove('open');
}

function sendDM() {
  const text = $('dmInput').value.trim();
  if (!text || !window.currentDMTarget) return;

  socket.emit('dmMessage', {
    to: window.currentDMTarget,
    message: text
  });

  $('dmInput').value = '';
}

function renderDMMessage(msg) {
  const div = document.createElement('div');
  div.className = "chatMessage";
  div.innerHTML = `
    <div class="msgBody">
      <div class="author">${msg.username}</div>
      <div class="timestamp">${formatTimestamp(msg.timestamp)}</div>
      <div class="text">${msg.message}</div>
    </div>
  `;
  $('dmMessages').appendChild(div);
  $('dmMessages').scrollTop = $('dmMessages').scrollHeight;
}

// POPUPS
function openPopup(id) {
  document.querySelectorAll('.popup').forEach(p => p.classList.remove('active'));
  $(id).classList.add('active');
}

function closePopup(id) {
  $(id).classList.remove('active');
}

// AUTO-LOGIN IF SESSION EXISTS
document.addEventListener('DOMContentLoaded', () => {
  const stored = localStorage.getItem('currentUser');
  if (stored) {
    const user = JSON.parse(stored);
    setSession(user);

    $('loginScreen').style.display = 'none';
    $('app').style.display = 'block';

    socket.emit('login', user);

    if (window.updateUIForSession) updateUIForSession();
    if (window.updateProfileCard) updateProfileCard(user);
    if (window.updateDMListSidebar) updateDMListSidebar();

    bindSidebar();
    bindChat();
    bindDMDrawer();

    socket.emit('getChatHistory');
  }
});

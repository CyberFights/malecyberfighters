
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

    // SUCCESS
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

  // Toggle online drawer
  $('onlineToggle').addEventListener('click', () => {
    $('onlineDrawer').classList.toggle('open');
  });

  // Send message
  $('chatSend').addEventListener('click', () => {
    const text = $('chatInput').value.trim();
    if (!text) return;
    socket.emit('publicMessage', { text });
    $('chatInput').value = '';
  });

  // Enter key
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

      socket.emit('publicMessage', { text: "", image: data.url });
      $('chatInput').value = "";

    } catch(e){
      $('chatInput').value = "";
      alert("Network error");
    }
  });

  // Load chat history
  socket.emit('getChatHistory');

  socket.on('chatHistory', history => {
    history.forEach(msg => renderChatMessage(msg));
  });

  // Live messages
  socket.on('publicMessage', msg => {
    renderChatMessage(msg);
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

  const avatar = msg.avatar || "/img/default-avatar.png";

  let body = `
    <img src="${avatar}">
    <div class="msgBody">
      <div class="author">${msg.username}</div>
  `;

  const text = msg.text || msg.message || msg.msg || "";

if (text) {
    body += `<div class="text">${text}</div>`;
}


  if (msg.image) {
    body += `<img src="${msg.image}" class="chatImage">`;
  }

  body += `</div>`;

  box.innerHTML = body;

  $('chatMessages').appendChild(box);
  $('chatMessages').scrollTop = $('chatMessages').scrollHeight;
}

// DM DRAWER
function bindDMDrawer() {
  $('dmClose').addEventListener('click', closeDMDrawer);

  $('dmSend').addEventListener('click', sendDM);

  $('dmInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') sendDM();
  });

  // DM list is populated by pm.js
  if (window.updateDMListSidebar) {
    updateDMListSidebar();
  }

  socket.on('dmMessage', msg => {
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
    text
  });

  $('dmInput').value = '';
}

function renderDMMessage(msg) {
  const div = document.createElement('div');
  div.className = "chatMessage";
  div.innerHTML = `
    <div class="msgBody">
      <div class="author">${msg.from}</div>
      <div class="text">${msg.text}</div>
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
  }
});

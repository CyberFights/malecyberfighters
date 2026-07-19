
$('loginSubmit').addEventListener('click', doLogin);
$('loginPass').addEventListener('keydown', e => { if(e.key === 'Enter') doLogin(); });

async function doLogin(){
  const username = $('loginUser').value.trim();
  const password = $('loginPass').value;
  const err = $('loginError');
  err.style.display = 'none';

  if(!username || !password){
    err.textContent = "Enter username and password";
    err.style.display = 'block';
    return;
  }

  try {
    const resp = await fetch('/api/login', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({username,password})
    });
    const data = await resp.json();

    if(!data.ok){
      err.textContent = data.error === 'banned' ? 'You are banned.' : 'Invalid credentials';
      err.style.display = 'block';
      return;
    }
document.getElementById("loginScreen").style.display = "none";
  document.getElementById("app").style.display = "block";
  
    setSession(data.user);
    localStorage.setItem('currentUser', JSON.stringify(data.user));
    socket.emit('login', data.user);
    
    if (window.updateUIForSession) updateUIForSession();
    if (window.updateProfileCard) updateProfileCard(data.user);

    $('loginUser').value = '';
    $('loginPass').value = '';

    if (window.updateDMListSidebar) updateDMListSidebar();

  } catch(e){
    err.textContent = "Network error";
    err.style.display = 'block';
  }
}

function logout(){
  clearSession();
  localStorage.removeItem('currentUser');
  if (window.updateUIForSession) updateUIForSession();
  if (window.updateProfileCard) updateProfileCard(null);
  if (window.updateDMListSidebar) updateDMListSidebar();
}
function renderChatMessage(msg) {
  const me = getSession();
  const box = document.createElement("div");
  box.className = "chatMessage" + (msg.username === me.username ? " me" : "");

  const avatar = msg.avatar || "/img/default-avatar.png";

  let body = `
    <img src="${avatar}">
    <div class="msgBody">
      <div class="author">${msg.username}</div>
  `;

  if (msg.text) {
    body += `<div class="text">${msg.text}</div>`;
  }

  if (msg.image) {
    body += `<img src="${msg.image}" class="chatImage">`;
  }

  body += `</div>`;

  box.innerHTML = body;

  $('chatMessages').appendChild(box);
  $('chatMessages').scrollTop = $('chatMessages').scrollHeight;
}

$('onlineToggle').addEventListener('click', () => {
  $('onlineDrawer').classList.toggle('open');
});

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

$('chatSend').addEventListener('click', () => {
  const text = $('chatInput').value.trim();
  if (!text) return;

  socket.emit('publicMessage', { text });
  $('chatInput').value = '';
});

socket.on('publicMessage', msg => {
  renderChatMessage(msg);
});

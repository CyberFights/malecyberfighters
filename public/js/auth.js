$('btnLogin').addEventListener('click', () => show($('modalLogin')));

$('loginCancel').addEventListener('click', () => hide($('modalLogin')));
$('loginSubmit').addEventListener('click', doLogin);
$('loginPass').addEventListener('keydown', e => { if(e.key === 'Enter') doLogin(); });

// Login with Discord (popup)
if ($('loginDiscord')) {
  $('loginDiscord').addEventListener('click', () => {
    // Redirect-based OAuth flow
    window.location.href = '/auth/discord';
  });
}

// Fetch authoritative session from server (session cookie-based)
async function fetchSessionFromServer() {
  try {
    const resp = await fetch('/api/session');
    const data = await resp.json();
    if (!data.ok || !data.user) return;

    setSession(data.user);
    localStorage.setItem('currentUser', JSON.stringify(data.user));
    if (typeof socket !== 'undefined' && socket) socket.emit('login', data.user);
    hide($('modalLogin'));
    if (window.updateUIForSession) updateUIForSession();
    if (window.updateProfileCard) updateProfileCard(data.user);
    if (window.updateDMListSidebar) updateDMListSidebar();
  } catch (e) {
    console.error('fetchSessionFromServer failed', e);
  }
}

fetchSessionFromServer();

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

    setSession(data.user);
    localStorage.setItem('currentUser', JSON.stringify(data.user));
    socket.emit('login', data.user);
    hide($('modalLogin'));
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

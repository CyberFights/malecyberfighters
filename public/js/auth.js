$('btnLogin').addEventListener('click', () => show($('modalLogin')));
$('loginCancel').addEventListener('click', () => hide($('modalLogin')));
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
  const s = typeof getSession === 'function' ? getSession() : null;
  if (s && typeof socket !== 'undefined') {
    socket.emit('forceLogout', { username: s.username });
  }
  clearSession();
  localStorage.removeItem('currentUser');
  if (window.updateUIForSession) updateUIForSession();
  if (window.updateProfileCard) updateProfileCard(null);
  if (window.updateDMListSidebar) updateDMListSidebar();
  if (window.updateDMBadge) updateDMBadge();
}

window.logout = logout;

// Restore session on page load and re-join presence
window.addEventListener('load', () => {
  const user = typeof getSession === 'function' ? getSession() : null;
  if (user && typeof socket !== 'undefined') {
    socket.emit('login', user);
    if (window.updateUIForSession) updateUIForSession();
    if (window.updateProfileCard) updateProfileCard(user);
    if (window.updateDMListSidebar) updateDMListSidebar();
  }
});

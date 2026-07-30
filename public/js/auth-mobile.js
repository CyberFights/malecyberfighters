/* ============================================================
   auth-mobile.js — Mobile version of auth.js
   Adapted from ./public/js/auth.js for ./public/mobile.html

   ID conversions:
     None — all IDs (btnLogin, modalLogin, loginCancel, loginSubmit,
     loginUser, loginPass, loginError) exist in mobile.html.

   Session flow differences:
     - After login, show mainUI and hide authScreen
     - After logout, show authScreen and hide mainUI + all panels
     - updateProfileCard → updates meCard (meAvatar, meName, meHandle)
============================================================ */

$('btnLogin').addEventListener('click', () => {
  show($('modalLogin'));
});
$('loginCancel').addEventListener('click', () => {
  hide($('modalLogin'));
});
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

    // MOBILE: show mainUI, hide authScreen
    const authScreen = $('authScreen');
    const mainUI = $('mainUI');
    if (authScreen) authScreen.style.display = 'none';
    if (mainUI) mainUI.style.display = 'block';

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

  // MOBILE: hide mainUI and all panels, show authScreen
  const mainUI = $('mainUI');
  const chatPopup = $('chatPopup');
  const dmPopup = $('dmPopup');
  const dmSidebar = $('dmSidebar');
  const roomsSidebar = $('roomsSidebar');
  const roomChatPopup = $('roomChatPopup');

  if (mainUI) mainUI.style.display = 'none';
  if (chatPopup) chatPopup.style.display = 'none';
  if (dmPopup) dmPopup.style.display = 'none';
  if (dmSidebar) dmSidebar.style.display = 'none';
  if (roomsSidebar) roomsSidebar.style.display = 'none';
  if (roomChatPopup) roomChatPopup.style.display = 'none';

  const authScreen = $('authScreen');
  if (authScreen) {
    authScreen.style.display = 'flex';
    authScreen.style.alignItems = 'center';
    authScreen.style.justifyContent = 'center';
  }

  if (window.updateUIForSession) updateUIForSession();
  if (window.updateProfileCard) updateProfileCard(null);
  if (window.updateDMListSidebar) updateDMListSidebar();
}

window.logout = logout;

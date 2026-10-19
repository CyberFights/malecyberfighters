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

let loginRequestPending = false;

async function doLogin(){
  if (loginRequestPending) return;

  const username = $('loginUser').value.trim();
  const password = $('loginPass').value;
  const err = $('loginError');
  const submit = $('loginSubmit');
  err.style.display = 'none';

  if(!username || !password){
    err.textContent = "Enter username and password";
    err.style.display = 'block';
    return;
  }

  loginRequestPending = true;
  if (submit) submit.disabled = true;

  let resp;
  try {
    resp = await fetch('/api/login', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({username,password})
    });
  } catch(e){
    console.error('Login request failed before receiving a response:', e);
    err.textContent = 'Network error. Check your connection and try again.';
    err.style.display = 'block';
    loginRequestPending = false;
    if (submit) submit.disabled = false;
    return;
  }

  let data;
  try {
    data = await resp.json();
  } catch(e){
    console.error('Login response could not be parsed:', e);
    err.textContent = resp.ok
      ? 'The login service returned an unreadable response. Please reload and try again.'
      : window.MCFAuthErrors.loginFailureMessage(resp, null);
    err.style.display = 'block';
    loginRequestPending = false;
    if (submit) submit.disabled = false;
    return;
  }

  if (!resp.ok || !data || !data.ok) {
    err.textContent = window.MCFAuthErrors.loginFailureMessage(resp, data);
    err.style.display = 'block';
    loginRequestPending = false;
    if (submit) submit.disabled = false;
    return;
  }
  if (!data.token || !data.user) {
    console.error('Login succeeded without the expected session token/user payload.');
    err.textContent = 'The login response was incomplete. Please reload and try again.';
    err.style.display = 'block';
    loginRequestPending = false;
    if (submit) submit.disabled = false;
    return;
  }

  try {
    if (typeof setSessionToken === 'function') setSessionToken(data.token);
    if (typeof setSession === 'function') setSession(data.user);
    if (typeof safeStorageSet === 'function') {
      safeStorageSet('currentUser', JSON.stringify(data.user));
    } else {
      try { localStorage.setItem('currentUser', JSON.stringify(data.user)); } catch (e) {}
    }
  } catch(e){
    console.warn('Session could not be persisted to primary storage, continuing with session:', e);
  }

  // From here the server accepted the login. Keep socket/UI initialization
  // problems separate from fetch and response-parsing errors.
  try {
    if (window.socket && typeof window.socket.emit === 'function') {
      window.socket.emit('login', { token: data.token });
    }

    const authScreen = $('authScreen');
    const mainUI = $('mainUI');
    if (authScreen) authScreen.style.display = 'none';
    if (mainUI) mainUI.style.display = 'block';

    if (window.updateUIForSession) updateUIForSession();
    if (window.updateProfileCard) updateProfileCard(data.user);

    $('loginUser').value = '';
    $('loginPass').value = '';

    if (window.updateDMListSidebar) updateDMListSidebar();
    hide($('modalLogin'));
  } catch(e){
    console.error('Login succeeded, but mobile app initialization failed:', e);
    err.textContent = 'Login succeeded, but the app could not finish loading. Please reload the page.';
    err.style.display = 'block';
  } finally {
    loginRequestPending = false;
    if (submit) submit.disabled = false;
  }
}

function logout(){
  // End the session server-side too, so the token stops working everywhere.
  try { authFetch('/api/logout', { method: 'POST' }); } catch(e){ /* ignore */ }
  try { if (window.socket && window.socket.connected) window.socket.emit('logout'); } catch(e){ /* ignore */ }

  clearSession();
  if (typeof safeStorageRemove === 'function') {
    safeStorageRemove('currentUser');
  } else {
    try { localStorage.removeItem('currentUser'); } catch (e) {}
    try { sessionStorage.removeItem('currentUser'); } catch (e) {}
  }

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

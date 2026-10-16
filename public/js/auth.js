$('btnLogin').addEventListener('click', () => show($('modalLogin')));

$('loginCancel').addEventListener('click', () => hide($('modalLogin')));
$('loginSubmit').addEventListener('click', doLogin);
$('loginPass').addEventListener('keydown', e => { if(e.key === 'Enter') doLogin(); });

// ---------- FORGOT PASSWORD ----------
// Remembers the last email used so the "Resend email" button can re-send
// without the user retyping it, even if they clear the field.
let lastForgotEmail = '';

if ($('forgotLink')) {
  $('forgotLink').addEventListener('click', e => {
    e.preventDefault();
    if ($('forgotError')) $('forgotError').style.display = 'none';
    if ($('forgotSuccess')) $('forgotSuccess').style.display = 'none';
    hide($('modalLogin'));
    show($('modalForgot'));
  });
}

if ($('forgotCancel')) {
  $('forgotCancel').addEventListener('click', () => {
    hide($('modalForgot'));
    show($('modalLogin'));
  });
}

if ($('forgotSubmit')) {
  $('forgotSubmit').addEventListener('click', doForgotPassword);
  $('forgotEmail').addEventListener('keydown', e => { if(e.key === 'Enter') doForgotPassword(); });
}

if ($('forgotResend')) {
  $('forgotResend').addEventListener('click', () => {
    // Reuse the last email if the field was cleared.
    if (!$('forgotEmail').value.trim() && lastForgotEmail) {
      $('forgotEmail').value = lastForgotEmail;
    }
    doForgotPassword(true);
  });
}

async function doForgotPassword(isResend){
  const email = $('forgotEmail').value.trim() || lastForgotEmail;
  const err = $('forgotError');
  const ok = $('forgotSuccess');
  const resendBtn = $('forgotResend');
  err.style.display = 'none';
  ok.style.display = 'none';

  if(!email){
    err.textContent = "Enter your email";
    err.style.display = 'block';
    return;
  }

  try {
    const resp = await fetch('/api/forgot-password', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({email})
    });
    const data = await resp.json();

    if(!data.ok){
      err.textContent = data.error === 'missing_email' ? 'Enter your email' : 'Something went wrong. Try again.';
      err.style.display = 'block';
      return;
    }

    // Always show the same success message (even when the email doesn't exist)
    // so we don't leak which addresses are registered.
    lastForgotEmail = email;
    ok.textContent = isResend
      ? "Reset email sent again to " + email + ". Check your inbox and spam folder."
      : "If that email is registered, a password reset link is on its way. Check your inbox and spam folder.";
    ok.style.display = 'block';
    if (resendBtn) resendBtn.style.display = 'inline-block';
  } catch(e){
    err.textContent = "Network error";
    err.style.display = 'block';
  }
}

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

  try {
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
      return;
    }

    if (!resp.ok || !data || !data.ok) {
      err.textContent = window.MCFAuthErrors.loginFailureMessage(resp, data);
      err.style.display = 'block';
      return;
    }

    if (!data.token || !data.user) {
      console.error('Login succeeded without the expected session token/user payload.');
      err.textContent = 'The login response was incomplete. Please reload and try again.';
      err.style.display = 'block';
      return;
    }

    try {
      // The token is the credential; the user record is only what the UI shows.
      // Store the token first so the socket upgrade below can carry it.
      setSessionToken(data.token);
      setSession(data.user);
      localStorage.setItem('currentUser', JSON.stringify(data.user));
    } catch(e){
      console.error('Login succeeded, but the session could not be saved in this browser:', e);
      err.textContent = 'Login succeeded, but this browser could not save your session. Check storage settings and try again.';
      err.style.display = 'block';
      return;
    }

    // The server has accepted the login and the session is stored. Socket/UI
    // failures after this point must not be mislabeled as a network failure.
    try {
      if (window.socket && typeof window.socket.emit === 'function') {
        window.socket.emit('login', { token: data.token });
      }
    } catch(e){ console.error('Login succeeded, but socket sign-in failed:', e); }

    $('loginUser').value = '';
    $('loginPass').value = '';
    try { hide($('modalLogin')); } catch(e){ console.error('Could not close the login dialog:', e); }

    if (window.updateUIForSession) {
      try { updateUIForSession(); } catch(e){ console.error('Login UI refresh failed:', e); }
    }
    if (window.updateProfileCard) {
      try { updateProfileCard(data.user); } catch(e){ console.error('Profile refresh after login failed:', e); }
    }
    if (window.updateDMListSidebar) {
      try { updateDMListSidebar(); } catch(e){ console.error('DM sidebar refresh after login failed:', e); }
    }
  } finally {
    loginRequestPending = false;
    if (submit) submit.disabled = false;
  }
}

function logout(){
  // Tell the server to end the session, so the token stops working everywhere
  // rather than staying valid until it expires. Best effort: the local sign-out
  // below happens either way.
  try { authFetch('/api/logout', { method: 'POST' }); } catch(e){ /* ignore */ }
  try { if (window.socket && window.socket.connected) window.socket.emit('logout'); } catch(e){ /* ignore */ }

  clearSession();
  localStorage.removeItem('currentUser');
  // The unread badge lives in localStorage, which is per browser rather than
  // per account. Drop it so the next person to sign in here does not inherit
  // somebody else's DM count.
  if (typeof saveUnreadMap === 'function') saveUnreadMap({});
  if (window.updateDMBadge) window.updateDMBadge();
  if (window.updateUIForSession) updateUIForSession();
  if (window.updateProfileCard) updateProfileCard(null);
  if (window.updateDMListSidebar) updateDMListSidebar();
}

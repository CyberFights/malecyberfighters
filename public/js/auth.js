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

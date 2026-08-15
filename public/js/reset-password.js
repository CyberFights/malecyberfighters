/* ============================================================
   reset-password.js — drives /reset-password.html

   Reads the one-time token from the query string, validates it with
   the server, then submits the chosen password to /api/reset-password.
============================================================ */

(function () {
  const byId = (id) => document.getElementById(id);

  const pass1 = byId('resetPass');
  const pass2 = byId('resetPass2');
  const submitBtn = byId('resetSubmit');
  const errEl = byId('resetError');
  const okEl = byId('resetSuccess');
  const intro = byId('resetIntro');

  const token = new URLSearchParams(window.location.search).get('token') || '';

  function showError(msg) {
    if (!errEl) return;
    errEl.textContent = msg;
    errEl.style.display = 'block';
  }

  function showSuccess(msg) {
    if (!okEl) return;
    okEl.textContent = msg;
    okEl.style.display = 'block';
  }

  function clearMessages() {
    if (errEl) { errEl.textContent = ''; errEl.style.display = 'none'; }
    if (okEl) { okEl.textContent = ''; okEl.style.display = 'none'; }
  }

  const tokenErrors = {
    invalid_token: 'This reset link is invalid. Request a new one from the login popup.',
    expired_token: 'This reset link has expired. Request a new one from the login popup.',
    used_token: 'This reset link has already been used. Request a new one from the login popup.'
  };

  async function verifyToken() {
    if (!token) {
      showError('Missing reset token. Open the link exactly as it appears in your email.');
      if (submitBtn) submitBtn.disabled = true;
      return;
    }

    try {
      const resp = await fetch('/api/reset-password/verify?token=' + encodeURIComponent(token));
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.ok) {
        showError(tokenErrors[data.error] || 'This reset link is no longer valid.');
        if (submitBtn) submitBtn.disabled = true;
        return;
      }
      if (data.username) {
        const h1 = document.querySelector('.reset-card h1');
        if (h1) h1.textContent = 'New Password for ' + data.username;
      }
    } catch (e) {
      showError('Network error while checking your reset link. Please refresh the page.');
      if (submitBtn) submitBtn.disabled = true;
    }
  }

  async function submitReset() {
    clearMessages();

    const password = pass1?.value || '';
    const confirm = pass2?.value || '';

    if (password.length < 8) {
      showError('Password must be at least 8 characters long.');
      return;
    }
    if (password !== confirm) {
      showError('The two passwords do not match.');
      return;
    }

    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Updating...'; }

    try {
      const resp = await fetch('/api/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password })
      });
      const data = await resp.json().catch(() => ({}));

      if (!resp.ok || !data.ok) {
        const messages = Object.assign({
          weak_password: 'Password must be at least 8 characters long.',
          missing_fields: 'Please fill in both password fields.'
        }, tokenErrors);
        showError(messages[data.error] || 'Could not update your password. Please try again.');
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Update Password'; }
        return;
      }

      if (intro) {
        intro.innerHTML =
          '<p class="forgot-help">Your password has been updated. You can now log in with your new password.</p>' +
          '<div class="forgot-actions"><a class="ghost-link" href="/">Back to site</a></div>';
      }
      showSuccess('Password updated.');
    } catch (e) {
      showError('Network error. Please try again.');
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Update Password'; }
    }
  }

  if (submitBtn) submitBtn.addEventListener('click', submitReset);
  [pass1, pass2].forEach((el) => {
    if (el) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitReset(); });
  });

  verifyToken();
})();

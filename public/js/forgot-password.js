/* ============================================================
   forgot-password.js
   Shared by the desktop (.container) and mobile (#mainUI) views of
   ./public/index.html — both render the same #modalLogin / #modalForgot
   markup, so a single handler covers both.

   Flow:
     1. "Forgot password?" in the login popup opens #modalForgot
     2. User enters the email they signed up with
     3. POST /api/forgot-password → server emails a one-time reset link
     4. The link lands on /reset-password.html where the new password is set
============================================================ */

(function () {
  const byId = (id) => document.getElementById(id);

  const openBtn = byId('btnForgotPassword');
  const modal = byId('modalForgot');
  const cancelBtn = byId('forgotCancel');
  const submitBtn = byId('forgotSubmit');
  const emailInput = byId('forgotEmail');
  const errEl = byId('forgotError');
  const okEl = byId('forgotSuccess');

  if (!openBtn || !modal) return;

  function clearMessages() {
    if (errEl) { errEl.textContent = ''; errEl.style.display = 'none'; }
    if (okEl) { okEl.textContent = ''; okEl.style.display = 'none'; }
  }

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

  function openModal() {
    clearMessages();
    if (emailInput) emailInput.value = '';
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Send Reset Link'; }

    // Close the login popup so only one modal is on screen
    const login = byId('modalLogin');
    if (login) login.style.display = 'none';

    modal.style.display = 'flex';
    if (emailInput) setTimeout(() => emailInput.focus(), 0);
  }

  function closeModal() {
    modal.style.display = 'none';
    clearMessages();
  }

  async function submitRequest() {
    const email = (emailInput?.value || '').trim();
    clearMessages();

    if (!email) {
      showError('Enter the email address you signed up with.');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showError('That does not look like a valid email address.');
      return;
    }

    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Sending...'; }

    try {
      const resp = await fetch('/api/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });

      let data = {};
      try { data = await resp.json(); } catch (_) { /* non-JSON response */ }

      if (!resp.ok || !data.ok) {
        const messages = {
          not_found: 'No account is registered with that email address.',
          invalid_email: 'That does not look like a valid email address.',
          rate_limited: 'Too many reset requests. Please wait a few minutes and try again.',
          email_not_configured: 'Password reset email is not configured on the server yet.',
          email_failed: 'We could not send the email right now. Please try again later.'
        };
        showError(messages[data.error] || 'Something went wrong. Please try again later.');
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Send Reset Link'; }
        return;
      }

      showSuccess('Reset link sent. Check your inbox (and spam folder) — the link expires in 60 minutes.');
      if (emailInput) emailInput.value = '';
      if (submitBtn) submitBtn.textContent = 'Sent';
    } catch (e) {
      showError('Network error. Please try again.');
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Send Reset Link'; }
    }
  }

  openBtn.addEventListener('click', openModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeModal);
  if (submitBtn) submitBtn.addEventListener('click', submitRequest);
  if (emailInput) {
    emailInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitRequest();
    });
  }

  // Click on the dark backdrop closes the popup
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });
})();

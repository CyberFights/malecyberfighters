// Reset-password page logic. Reads the one-time token from the URL, validates
// the new password on the client, then submits it to /api/reset-password.
(function () {
  "use strict";

  var params = new URLSearchParams(window.location.search);
  var token = params.get('token') || '';
  var form = document.getElementById('resetForm');
  var status = document.getElementById('status');
  var submitBtn = document.getElementById('submitBtn');

  function showError(msg) {
    status.className = 'msg error';
    status.textContent = msg;
    status.style.display = 'block';
  }
  function showSuccess(msg) {
    status.className = 'msg success';
    status.textContent = msg;
    status.style.display = 'block';
  }

  if (!token) {
    showError('This reset link is missing its token. Ask for a new reset email and use the fresh link.');
    form.style.display = 'none';
    return;
  }

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    var p1 = document.getElementById('newPass').value;
    var p2 = document.getElementById('newPass2').value;

    status.style.display = 'none';

    if (!p1) { showError('Enter a new password.'); return; }
    if (p1.length < 6) { showError('Password must be at least 6 characters.'); return; }
    if (p1 !== p2) { showError('Passwords do not match.'); return; }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Resetting…';

    try {
      var resp = await fetch('/api/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token, newPassword: p1 })
      });
      var data = await resp.json();

      if (!data.ok) {
        if (data.error === 'invalid_or_expired_token') {
          showError('This reset link is invalid or has expired. Request a new reset email and use the fresh link.');
        } else if (data.error === 'weak_password') {
          showError('Password must be at least 6 characters.');
        } else {
          showError('Something went wrong. Please try again.');
        }
        submitBtn.disabled = false;
        submitBtn.textContent = 'Reset password';
        return;
      }

      showSuccess('Your password has been reset. Redirecting to login…');
      setTimeout(function () { window.location.href = '/'; }, 1800);
    } catch (err) {
      showError('Network error. Please try again.');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Reset password';
    }
  });
})();

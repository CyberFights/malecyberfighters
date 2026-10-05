/* -----------------------------------------------------------
   ACCOUNT SETTINGS LOGIC
   Handles:
   - Open/close Account Settings modal (mobile + desktop)
   - Change password (current + new + confirm)
   - Delete account (password confirm + double confirm)
----------------------------------------------------------- */

// Fallback visibility handler if utils.js didn't define it (e.g., mobile version)
if (typeof window.updateAccountSettingsButtonVisibility !== 'function') {
  window.updateAccountSettingsButtonVisibility = function(user) {
    try {
      if (typeof user === 'undefined') {
        user = typeof getSession === 'function' ? getSession() : null;
      }
    } catch (_) { user = null; }
    const visible = !!user;
    document.querySelectorAll('[id="btnAccountSettings"]').forEach(btn => {
      try {
        btn.style.display = visible ? '' : 'none';
        btn.hidden = !visible;
      } catch (_) {}
    });
  };
}


// --- In-app notification sound preferences --------------------------
// These are device preferences: they apply immediately to message alerts
// without changing server-side push notification subscriptions.
const MCF_SOUND_ENABLED_KEY = 'mcf_notification_sounds_enabled';
const MCF_SOUND_VOLUME_KEY = 'mcf_notification_sounds_volume';

window.getNotificationSoundSettings = function() {
  let enabled = true;
  let volume = 1;
  try {
    const storedEnabled = localStorage.getItem(MCF_SOUND_ENABLED_KEY);
    if (storedEnabled !== null) enabled = storedEnabled !== 'false';
    const storedVolume = Number(localStorage.getItem(MCF_SOUND_VOLUME_KEY));
    if (Number.isFinite(storedVolume)) volume = Math.max(0, Math.min(1, storedVolume));
  } catch (_) {}
  return { enabled, volume };
};

window.setNotificationSoundSettings = function(enabled, volume) {
  const nextVolume = Math.max(0, Math.min(1, Number(volume)));
  try {
    localStorage.setItem(MCF_SOUND_ENABLED_KEY, enabled ? 'true' : 'false');
    localStorage.setItem(MCF_SOUND_VOLUME_KEY, String(nextVolume));
  } catch (_) {}
};

function syncNotificationSoundControls() {
  const settings = window.getNotificationSoundSettings();
  const enabled = document.getElementById('accountNotificationSoundsEnabled');
  const volume = document.getElementById('accountNotificationSoundVolume');
  const label = document.getElementById('accountNotificationSoundVolumeLabel');
  if (enabled) enabled.checked = settings.enabled;
  if (volume) volume.value = String(Math.round(settings.volume * 100));
  if (label) label.textContent = Math.round(settings.volume * 100) + '%';
}

// --- Modal open/close helpers --------------------------------------
window.openAccountSettingsModal = function() {
  const modal = document.getElementById('modalAccountSettings');
  if (!modal) return;
  // reset fields
  const err1 = document.getElementById('changePasswordError');
  const succ1 = document.getElementById('changePasswordSuccess');
  const err2 = document.getElementById('deleteAccountError');
  if (err1) { err1.style.display = 'none'; err1.textContent = ''; }
  if (succ1) { succ1.style.display = 'none'; succ1.textContent = ''; }
  if (err2) { err2.style.display = 'none'; err2.textContent = ''; }
  const cpCurr = document.getElementById('changeCurrentPassword');
  const cpNew = document.getElementById('changeNewPassword');
  const cpConf = document.getElementById('changeConfirmPassword');
  const delPw = document.getElementById('deleteAccountPassword');
  if (cpCurr) cpCurr.value = '';
  if (cpNew) cpNew.value = '';
  if (cpConf) cpConf.value = '';
  if (delPw) delPw.value = '';
  syncNotificationSoundControls();

  if (typeof show === 'function') show(modal);
  else modal.style.display = 'flex';
};

window.closeAccountSettingsModal = function() {
  const modal = document.getElementById('modalAccountSettings');
  if (!modal) return;
  if (typeof hide === 'function') hide(modal);
  else modal.style.display = 'none';
};

// Bind open buttons (both mobile and desktop share same ID via proxy, but also querySelectorAll for safety)
function bindAccountSettingsButtons() {
  document.querySelectorAll('[id="btnAccountSettings"]').forEach(btn => {
    if (btn._acctBound) return;
    btn._acctBound = true;
    btn.addEventListener('click', () => {
      const u = typeof getSession === 'function' ? getSession() : null;
      if (!u) {
        alert('You must be logged in to access account settings.');
        return;
      }
      window.openAccountSettingsModal();
    });
  });

  const closeBtn = document.getElementById('accountSettingsClose');
  if (closeBtn && !closeBtn._acctBound) {
    closeBtn._acctBound = true;
    closeBtn.addEventListener('click', () => window.closeAccountSettingsModal());
  }

  const soundToggle = document.getElementById('accountNotificationSoundsEnabled');
  if (soundToggle && !soundToggle._acctBound) {
    soundToggle._acctBound = true;
    soundToggle.addEventListener('change', () => {
      const settings = window.getNotificationSoundSettings();
      window.setNotificationSoundSettings(soundToggle.checked, settings.volume);
    });
  }
  const soundVolume = document.getElementById('accountNotificationSoundVolume');
  if (soundVolume && !soundVolume._acctBound) {
    soundVolume._acctBound = true;
    soundVolume.addEventListener('input', () => {
      const settings = window.getNotificationSoundSettings();
      const volume = Number(soundVolume.value) / 100;
      window.setNotificationSoundSettings(settings.enabled, volume);
      const label = document.getElementById('accountNotificationSoundVolumeLabel');
      if (label) label.textContent = Math.round(volume * 100) + '%';
    });
  }

  const modal = document.getElementById('modalAccountSettings');
  if (modal && !modal._acctBound) {
    modal._acctBound = true;
    modal.addEventListener('click', (e) => {
      if (e.target === modal) window.closeAccountSettingsModal();
    });
  }

  // ESC key to close
  if (!window._acctEscBound) {
    window._acctEscBound = true;
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const m = document.getElementById('modalAccountSettings');
        if (m && (m.style.display === 'flex' || window.getComputedStyle(m).display !== 'none')) {
          window.closeAccountSettingsModal();
        }
      }
    });
  }
}

// Initial bind + re-bind on load
document.addEventListener('DOMContentLoaded', bindAccountSettingsButtons);
window.addEventListener('load', bindAccountSettingsButtons);

function wrapUpdateUIForSession() {
  if (window._acctWrapped) return;
  if (typeof window.updateUIForSession !== 'function') return;
  if (window.updateUIForSession._isAcctWrapped) return;
  const orig = window.updateUIForSession;
  const wrapped = function() {
    try { orig.apply(this, arguments); } catch (e) { console.error(e); }
    try { bindAccountSettingsButtons(); } catch (e) {}
    try {
      if (typeof window.updateAccountSettingsButtonVisibility === 'function') {
        window.updateAccountSettingsButtonVisibility();
      } else {
        // fallback visibility
        const u = typeof getSession === 'function' ? getSession() : null;
        document.querySelectorAll('[id="btnAccountSettings"]').forEach(btn => {
          btn.style.display = u ? '' : 'none';
          btn.hidden = !u;
        });
      }
    } catch (e) {}
  };
  wrapped._isAcctWrapped = true;
  window.updateUIForSession = wrapped;
  window._acctWrapped = true;
}

// Try to wrap immediately and also on intervals until it exists
wrapUpdateUIForSession();
setTimeout(wrapUpdateUIForSession, 500);
setTimeout(wrapUpdateUIForSession, 1500);
setInterval(() => {
  wrapUpdateUIForSession();
  bindAccountSettingsButtons();
  // keep visibility in sync
  if (typeof window.updateAccountSettingsButtonVisibility === 'function') {
    try { window.updateAccountSettingsButtonVisibility(); } catch (e) {}
  }
}, 1500);


// --- Change Password --------------------------------------------------
async function doChangePassword() {
  const user = typeof getSession === 'function' ? getSession() : null;
  const errEl = document.getElementById('changePasswordError');
  const succEl = document.getElementById('changePasswordSuccess');
  const currInput = document.getElementById('changeCurrentPassword');
  const newInput = document.getElementById('changeNewPassword');
  const confInput = document.getElementById('changeConfirmPassword');
  const btn = document.getElementById('changePasswordSubmit');

  if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
  if (succEl) { succEl.style.display = 'none'; succEl.textContent = ''; }

  if (!user) {
    if (errEl) { errEl.textContent = 'Not logged in.'; errEl.style.display = 'block'; }
    return;
  }

  const currentPassword = currInput ? currInput.value.trim() : '';
  const newPassword = newInput ? newInput.value.trim() : '';
  const confirmPassword = confInput ? confInput.value.trim() : '';

  if (!currentPassword || !newPassword || !confirmPassword) {
    if (errEl) { errEl.textContent = 'Please fill in all password fields.'; errEl.style.display = 'block'; }
    return;
  }
  if (newPassword.length < 6) {
    if (errEl) { errEl.textContent = 'New password must be at least 6 characters.'; errEl.style.display = 'block'; }
    return;
  }
  if (newPassword !== confirmPassword) {
    if (errEl) { errEl.textContent = 'New passwords do not match.'; errEl.style.display = 'block'; }
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = 'Changing...'; }

  try {
    const resp = await fetch('/api/account/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: user.username,
        currentPassword,
        newPassword
      })
    });
    const data = await resp.json();

    if (!resp.ok || !data.ok) {
      let msg = 'Failed to change password.';
      if (data.error === 'invalid_current') msg = 'Current password is incorrect.';
      else if (data.error === 'weak_password') msg = 'New password is too weak (min 6 characters).';
      else if (data.error === 'missing_fields') msg = 'Missing fields.';
      else if (data.error === 'not_found') msg = 'User not found.';
      else if (data.error) msg = data.error;
      if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
      return;
    }

    if (succEl) { succEl.textContent = 'Password changed successfully!'; succEl.style.display = 'block'; }
    if (currInput) currInput.value = '';
    if (newInput) newInput.value = '';
    if (confInput) confInput.value = '';

  } catch (e) {
    console.error('change password error', e);
    if (errEl) { errEl.textContent = 'Network error. Try again.'; errEl.style.display = 'block'; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Change Password'; }
  }
}

// --- Delete Account ---------------------------------------------------
async function doDeleteAccount() {
  const user = typeof getSession === 'function' ? getSession() : null;
  const errEl = document.getElementById('deleteAccountError');
  const pwInput = document.getElementById('deleteAccountPassword');
  const btn = document.getElementById('deleteAccountSubmit');

  if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }

  if (!user) {
    if (errEl) { errEl.textContent = 'Not logged in.'; errEl.style.display = 'block'; }
    return;
  }

  const password = pwInput ? pwInput.value.trim() : '';
  if (!password) {
    if (errEl) { errEl.textContent = 'Please enter your password to confirm deletion.'; errEl.style.display = 'block'; }
    return;
  }

  const firstConfirm = confirm('Are you sure you want to DELETE your account? This cannot be undone.');
  if (!firstConfirm) return;

  const secondConfirm = confirm(`Final confirmation: Delete account "${user.username}" permanently?`);
  if (!secondConfirm) return;

  if (btn) { btn.disabled = true; btn.textContent = 'Deleting...'; }

  try {
    const resp = await fetch('/api/account/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: user.username,
        password
      })
    });
    const data = await resp.json();

    if (!resp.ok || !data.ok) {
      let msg = 'Failed to delete account.';
      if (data.error === 'invalid_credentials' || data.error === 'invalid_password') msg = 'Password is incorrect.';
      else if (data.error === 'not_found') msg = 'User not found.';
      else if (data.error === 'missing_fields') msg = 'Missing fields.';
      else if (data.error) msg = data.error;
      if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
      return;
    }

    alert('Your account has been deleted.');
    window.closeAccountSettingsModal();

    // Clear local session and logout
    if (typeof clearSession === 'function') clearSession();
    localStorage.removeItem('currentUser');
    // Notify server to go offline if socket exists
    try {
      if (window.socket && user.username) {
        window.socket.emit('forceLogout', { username: user.username });
      }
    } catch (_) {}

    if (typeof updateUIForSession === 'function') updateUIForSession();
    if (window.updateProfileCard) window.updateProfileCard(null);
    if (window.updateDMListSidebar) window.updateDMListSidebar();

    // Optional reload to reset UI
    // location.reload();

  } catch (e) {
    console.error('delete account error', e);
    if (errEl) { errEl.textContent = 'Network error. Try again.'; errEl.style.display = 'block'; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Delete My Account'; }
  }
}

// Bind action buttons
function bindAccountActions() {
  const changeBtn = document.getElementById('changePasswordSubmit');
  if (changeBtn && !changeBtn._bound) {
    changeBtn._bound = true;
    changeBtn.addEventListener('click', doChangePassword);
  }
  const delBtn = document.getElementById('deleteAccountSubmit');
  if (delBtn && !delBtn._bound) {
    delBtn._bound = true;
    delBtn.addEventListener('click', doDeleteAccount);
  }

  // Enter key handling for change password
  ['changeCurrentPassword', 'changeNewPassword', 'changeConfirmPassword'].forEach(id => {
    const el = document.getElementById(id);
    if (el && !el._boundEnter) {
      el._boundEnter = true;
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doChangePassword();
      });
    }
  });
  const delPw = document.getElementById('deleteAccountPassword');
  if (delPw && !delPw._boundEnter) {
    delPw._boundEnter = true;
    delPw.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doDeleteAccount();
    });
  }
}

document.addEventListener('DOMContentLoaded', bindAccountActions);
window.addEventListener('load', bindAccountActions);

// Ensure re-bind after dynamic DOM changes
setTimeout(bindAccountActions, 1000);
setInterval(bindAccountActions, 2000);

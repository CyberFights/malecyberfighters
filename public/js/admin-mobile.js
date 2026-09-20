/* ============================================================
   admin-mobile.js — Mobile version of admin.js
   Adapted from ./public/js/admin.js for ./public/mobile.html

   ID conversions:
     None — all IDs (adminTable, adminUsersView, adminAnalyticsView,
     modalAdmin, tabUsers, tabAnalytics, adminSearch, adminClose)
     exist in mobile.html.

   Note:
     - statsSummary and topIpsList don't exist in mobile.html
       (analytics section is disabled in mobile admin panel)
     - The analytics tab shows a placeholder message instead
============================================================ */

/* -----------------------------------------------------------
   ADMIN PANEL (CSP-SAFE VERSION — MOBILE)
----------------------------------------------------------- */

/* The roles the Administrator account can hand out — mirrors roles.js on
   the server. The Administrator account itself sits outside the ladder:
   it is the one assigning roles, so its row shows a fixed badge. */
const ADMIN_ROLE_OPTIONS = ['user', 'moderator', 'admin'];

function adminRoleLabel(role) {
  const labels = { user: 'Member', moderator: 'Moderator', admin: 'Admin' };
  return labels[String(role || 'user').toLowerCase()] || 'Member';
}

function isRootAdminAccount(username) {
  return String(username || '').trim().toLowerCase() === 'administrator';
}

/* The Role cell: a picker for ordinary members, a fixed badge for the
   Administrator account (its role cannot be changed). */
function adminRoleCellHtml(u) {
  if (isRootAdminAccount(u && u.username)) {
    return '<span class="role-badge role-administrator">Administrator</span>';
  }
  const role = String((u && u.role) || 'user').toLowerCase();
  const options = ADMIN_ROLE_OPTIONS.map(id =>
    `<option value="${id}"${id === role ? ' selected' : ''}>${adminRoleLabel(id)}</option>`
  ).join('');
  return `<select class="admin-role" aria-label="Role for ${escapeHtml((u && u.username) || '')}">${options}</select>`;
}

window.loadAdminPanel = async function loadAdminPanel() {
  try {
    const res = await fetch('/api/admin/users', {
      headers: { 'x-admin-key': window.adminSessionKey }
    });

    const data = await res.json();
    if (!data.ok) {
      alert('Admin access denied');
      return;
    }

    const tbody = document.querySelector('#adminTable tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    (data.users || []).forEach(u => {
      const row = document.createElement('tr');
      row.dataset.username = u.username;

      row.innerHTML = `
        <td>${escapeHtml(u.username || '')}</td>
        <td>${escapeHtml(u.email || '')}</td>
        <td>${adminRoleCellHtml(u)}</td>
        <td>${escapeHtml(u.height || '—')}</td>
        <td>${u.weight != null && u.weight !== '' ? escapeHtml(String(u.weight) + ' lbs') : '—'}</td>
        <td>${u.online ? '🟢' : '⚪'}</td>
        <td>${u.banned ? '🚫' : '✔'}</td>
        <td>
          <button class="small-btn admin-ban">${u.banned ? 'Unban' : 'Ban'}</button>
          <button class="small-btn admin-reset">Reset PW</button>
          <button class="small-btn admin-delete">Delete</button>
        </td>
      `;

      tbody.appendChild(row);
    });

    // Default to users tab
    showAdminTab('users');

    const modal = document.getElementById('modalAdmin');
    if (modal) {
      modal.style.display = 'flex';
      modal.style.alignItems = 'center';
      modal.style.justifyContent = 'center';
    }
  } catch (err) {
    console.error('loadAdminPanel error', err);
    alert('Failed to load admin panel');
  }
};

function showAdminTab(tab) {
  const usersView = document.getElementById('adminUsersView');
  const analyticsView = document.getElementById('adminAnalyticsView');
  const staleImagesView = document.getElementById('adminStaleImagesView');
  if (!usersView || !analyticsView || !staleImagesView) return;

  if (tab === 'analytics') {
    usersView.style.display = 'none';
    analyticsView.style.display = 'block';
    staleImagesView.style.display = 'none';
    // MOBILE: analytics are only available in desktop panel
    // loadAnalytics is not called since statsSummary/topIpsList don't exist
    // if (window.loadAnalytics) window.loadAnalytics();
  } else if (tab === 'stale-images') {
    usersView.style.display = 'none';
    analyticsView.style.display = 'none';
    staleImagesView.style.display = 'block';
  } else {
    usersView.style.display = 'block';
    analyticsView.style.display = 'none';
    staleImagesView.style.display = 'none';
  }
}

/* EVENT DELEGATION (CSP-SAFE) */
document.addEventListener('click', async (e) => {
  if (e.target.id === 'tabUsers') {
    showAdminTab('users');
    return;
  }
  if (e.target.id === 'tabAnalytics') {
    showAdminTab('analytics');
    return;
  }
  if (e.target.id === 'tabStaleImages') {
    showAdminTab('stale-images');
    return;
  }

  if (e.target.id === 'staleImagesPreview' || e.target.id === 'staleImagesRun') {
    const dryRun = e.target.id === 'staleImagesPreview';
    if (!window.adminSessionKey) return;
    const summaryEl = document.getElementById('staleImagesSummary');
    if (summaryEl) summaryEl.textContent = 'Scanning…';

    try {
      const res = await fetch(`/api/admin/sweep-stale-images?dryRun=${dryRun ? 1 : 0}`, {
        method: 'POST',
        headers: { 'x-admin-key': window.adminSessionKey }
      });
      const data = await res.json();
      if (!data.ok) {
        if (summaryEl) summaryEl.textContent = 'Sweep failed: ' + (data.error || 'unknown error');
        return;
      }
      const lines = [
        `${data.dryRun ? 'DRY RUN — ' : ''}Scanned ${data.scanned}, re-hosted ${data.rehosted}, cleared ${data.cleared}, skipped ${data.skipped}, errors ${data.errors}`
      ];
      (data.items || []).slice(0, 200).forEach(it => {
        lines.push(`${it.action}\t${it.collection}/${it.id}\t${it.reason || ''}\t${it.to || ''}`);
      });
      if ((data.items || []).length > 200) lines.push(`… and ${data.items.length - 200} more`);
      if (summaryEl) summaryEl.textContent = lines.join('\n');
    } catch (err) {
      console.error('stale images sweep error', err);
      if (summaryEl) summaryEl.textContent = 'Sweep request failed: ' + (err && err.message ? err.message : err);
    }
    return;
  }

  const row = e.target.closest('#adminTable tr');
  if (!row || !row.dataset.username) return;

  const username = row.dataset.username;
  if (!window.adminSessionKey) return;

  /* BAN / UNBAN */
  if (e.target.classList.contains('admin-ban')) {
    const banned = e.target.textContent.trim() === 'Ban';

    await fetch('/api/admin/ban', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-key': window.adminSessionKey
      },
      body: JSON.stringify({ username, banned })
    });

    window.loadAdminPanel();
  }

  /* RESET PASSWORD */
  if (e.target.classList.contains('admin-reset')) {
    const newPass = prompt('Enter new password:');
    if (!newPass) return;

    const res = await fetch('/api/admin/reset-password', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-key': window.adminSessionKey
      },
      body: JSON.stringify({ username, newPassword: newPass })
    });

    const data = await res.json();
    alert(data.ok ? 'Password reset' : 'Failed to reset password');
  }

  /* DELETE USER */
  if (e.target.classList.contains('admin-delete')) {
    if (!confirm('Delete this user?')) return;

    await fetch('/api/admin/delete-user', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-key': window.adminSessionKey
      },
      body: JSON.stringify({ username })
    });

    window.loadAdminPanel();
  }
});

/* ASSIGN / REVOKE ROLE
   The select in each member's row posts to /api/admin/set-role, which the
   server only honours for the signed-in Administrator account presenting
   the admin key — the same two credentials that opened this panel. */
document.addEventListener('change', async (e) => {
  if (!e.target.classList || !e.target.classList.contains('admin-role')) return;

  const row = e.target.closest('#adminTable tr');
  if (!row || !row.dataset.username) return;
  if (!window.adminSessionKey) return;

  const username = row.dataset.username;
  const role = e.target.value;

  try {
    const res = await fetch('/api/admin/set-role', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-key': window.adminSessionKey
      },
      body: JSON.stringify({ username, role })
    });

    const data = await res.json();
    if (!data.ok) {
      alert(data.error === 'cannot_modify_administrator'
        ? 'The Administrator account cannot be re-roled.'
        : `Failed to update role${data.error ? ` (${data.error})` : ''}`);
      if (window.loadAdminPanel) window.loadAdminPanel();
      return;
    }

    alert(`${username} is now ${adminRoleLabel(role)}.`);
  } catch (err) {
    console.error('set role error', err);
    alert('Failed to update role');
    if (window.loadAdminPanel) window.loadAdminPanel();
  }
});

/* SEARCH FILTER */
document.getElementById('adminSearch')?.addEventListener('input', (e) => {
  const q = e.target.value.toLowerCase();
  document.querySelectorAll('#adminTable tbody tr').forEach(row => {
    const text = row.textContent.toLowerCase();
    row.style.display = text.includes(q) ? '' : 'none';
  });
});

/* CLOSE BUTTON */
document.getElementById('adminClose')?.addEventListener('click', () => {
  const modal = document.getElementById('modalAdmin');
  if (modal) modal.style.display = 'none';
});

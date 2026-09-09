/* -----------------------------------------------------------
   ADMIN PANEL (CSP-SAFE VERSION)
----------------------------------------------------------- */

window.loadAdminPanel = async function loadAdminPanel() {
  try {
    const res = await fetch('/api/admin/users', {
      headers: { 'x-admin-key': window.adminSessionKey }
    });

    const data = await res.json();
    if (!data.ok) {
      window.adminSessionKey = null;
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
        <td>${escapeHtml(u.role || 'user')}</td>
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
    if (window.loadAnalytics) window.loadAnalytics();
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

    const res = await fetch('/api/admin/ban', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-key': window.adminSessionKey
      },
      body: JSON.stringify({ username, banned })
    });

    const data = await res.json();
    if (!data.ok) {
      alert('Failed to update ban status');
      return;
    }

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

    const res = await fetch('/api/admin/delete-user', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-key': window.adminSessionKey
      },
      body: JSON.stringify({ username })
    });

    const data = await res.json();
    if (!data.ok) {
      alert('Failed to delete user');
      return;
    }

    window.loadAdminPanel();
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

/* ============================================================
   analytics-mobile.js — Mobile version of analytics.js
   Adapted from ./public/js/analytics.js for ./public/mobile.html

   ID conversions:
     Desktop ID        →  Mobile ID
     -------------------------------------------------------
     statsSummary      →  (not in mobile — analytics disabled)
     topIpsList        →  (not in mobile — analytics disabled)
     adminStatsSummary →  (not in mobile — analytics disabled)
     adminTopIps       →  (not in mobile — analytics disabled)

   Mobile admin panel shows a placeholder message:
   "Analytics are only available in the desktop admin panel."
   The loadAnalytics function is preserved as a no-op for
   API compatibility with index.js.
============================================================ */

window.loadAnalytics = async function loadAnalytics() {
  const usersView = document.getElementById('adminUsersView');
  const analyticsView = document.getElementById('adminAnalyticsView');
  if (usersView) usersView.style.display = 'none';
  if (analyticsView) analyticsView.style.display = 'block';

  // MOBILE: statsSummary and topIpsList don't exist in mobile.html
  // The analytics view in mobile.html shows a placeholder message:
  // "Analytics are only available in the desktop admin panel."
  // No data fetching is attempted since there's no DOM to render into.

  try {
    const [statsRes, ipsRes] = await Promise.all([
      fetch('/api/admin/stats', { headers: { 'x-admin-key': window.adminSessionKey } }),
      fetch('/api/admin/top-ips', { headers: { 'x-admin-key': window.adminSessionKey } })
    ]);

    const stats = await statsRes.json();
    const ips = await ipsRes.json();

    if (!stats.ok || !ips.ok) {
      console.error('Analytics error', stats, ips);
      return;
    }

    // Try to find statsSummary (desktop) or adminStatsSummary (fallback)
    const statsBox = document.getElementById('statsSummary') || document.getElementById('adminStatsSummary');
    if (statsBox) {
      statsBox.innerHTML = `
        <div>Total users: ${stats.totalUsers}</div>
        <div>Online users: ${stats.onlineUsers}</div>
        <div>Banned users: ${stats.bannedUsers}</div>
        <div>Total logs: ${stats.totalLogs}</div>
        <div>Last 24h: logins ${stats.last24h?.logins24h ?? 0}, fails ${stats.last24h?.fails24h ?? 0}, regs ${stats.last24h?.regs24h ?? 0}</div>
      `;
    }

    // Try to find topIpsList (desktop) or adminTopIps (fallback)
    const ipsList = document.getElementById('topIpsList') || document.getElementById('adminTopIps');
    if (ipsList) {
      if (ipsList.tagName === 'UL') {
        ipsList.innerHTML = '';
        (ips.ips || []).forEach(row => {
          const li = document.createElement('li');
          li.textContent = `${row._id || 'unknown'} — ${row.count}`;
          ipsList.appendChild(li);
        });
        if (!(ips.ips || []).length) {
          ipsList.innerHTML = '<li class="small muted">No IP activity in the last 24h</li>';
        }
      } else {
        const tbody = ipsList.querySelector('tbody');
        if (tbody) {
          tbody.innerHTML = '';
          (ips.ips || []).forEach(row => {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td>${row._id || ''}</td><td>${row.count}</td>`;
            tbody.appendChild(tr);
          });
        }
      }
    }
  } catch (err) {
    console.error('loadAnalytics error', err);
  }
};

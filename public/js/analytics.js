window.loadAnalytics = async function loadAnalytics() {
  const usersView = document.getElementById('adminUsersView');
  const analyticsView = document.getElementById('adminAnalyticsView');
  if (usersView) usersView.style.display = 'none';
  if (analyticsView) analyticsView.style.display = 'block';

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

    // HTML uses statsSummary / topIpsList
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

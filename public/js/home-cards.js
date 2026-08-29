(function () {
  'use strict';

  function formatDate(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString([], {
      year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    });
  }

  async function loadNewMembers() {
    const container = document.getElementById('newMembersList');
    if (!container) return;
    try {
      const res = await fetch('/api/allUsers');
      const data = await res.json();
      if (!res.ok || !data.success || !Array.isArray(data.users)) {
        container.innerHTML = '<div class="small muted">Unable to load members.</div>';
        return;
      }
      const users = data.users
        .filter(u => u && (u.username || u.display))
        .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
        .slice(0, 10);
      if (!users.length) {
        container.innerHTML = '<div class="small muted">No members yet.</div>';
        return;
      }
      container.innerHTML = users.map(u => {
        const name = u.display || u.username || 'Unknown';
        const handle = u.username ? `@${u.username}` : '';
        const img = u.imageUrl ? `<img src="/img?url=${encodeURIComponent(u.imageUrl)}" alt="" style="width:32px;height:32px;border-radius:8px;object-fit:cover;border:1px solid rgba(160,200,255,0.25);flex-shrink:0;">` : `<div style="width:32px;height:32px;border-radius:8px;background:rgba(127,216,255,0.15);border:1px solid rgba(160,200,255,0.25);display:flex;align-items:center;justify-content:center;font-weight:700;color:#7fd8ff;font-size:13px;flex-shrink:0;">${String(name || '?').charAt(0).toUpperCase()}</div>`;
        return `<div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid rgba(160,200,255,0.08);">${img}<div style="min-width:0;"><div style="font-weight:600;color:#e9f6ff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${name}</div><div class="small muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${handle}</div></div></div>`;
      }).join('');
    } catch (e) {
      container.innerHTML = '<div class="small muted">Unable to load members.</div>';
      console.error('new members load error', e);
    }
  }

  async function loadRecentForums() {
    const container = document.getElementById('recentForumsList');
    if (!container) return;
    try {
      const res = await fetch('/api/forums');
      const data = await res.json();
      if (!res.ok || !data.ok || !Array.isArray(data.forums)) {
        container.innerHTML = '<div class="small muted">Unable to load forums.</div>';
        return;
      }
      const forums = data.forums.slice(0, 10);
      if (!forums.length) {
        container.innerHTML = '<div class="small muted">No forums yet.</div>';
        return;
      }
      container.innerHTML = forums.map(f => {
        const title = f.title || 'Untitled';
        const author = f.authorDisplay || f.author || 'Unknown';
        const dateStr = formatDate(f.createdAt);
        return `<a href="#" onclick="(function(e){e.preventDefault();if(typeof openForumThread==='function')openForumThread('${f._id}');else if(typeof openForumsPopup==='function')openForumsPopup();})(event)" style="display:block;padding:6px 0;border-bottom:1px solid rgba(160,200,255,0.08);text-decoration:none;color:inherit;"><div style="font-weight:600;color:#e9f6ff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${title}</div><div class="small muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${author}${dateStr ? ' · ' + dateStr : ''}</div></a>`;
      }).join('');
    } catch (e) {
      container.innerHTML = '<div class="small muted">Unable to load forums.</div>';
      console.error('recent forums load error', e);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { loadNewMembers(); loadRecentForums(); }, { once: true });
  } else {
    loadNewMembers(); loadRecentForums();
  }
})();

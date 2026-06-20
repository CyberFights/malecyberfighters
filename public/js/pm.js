window._pmStore = window._pmStore || {};

function openPrivateWindow(targetUsername) {
  const s = getSession();
  if (!s) {
    alert("Please login");
    return;
  }
  if (targetUsername === s.username) {
    alert("You cannot message yourself");
    return;
  }

  if (document.getElementById("pmWindow_" + targetUsername)) {
    clearUnread(targetUsername);
    if (window.updateDMListSidebar) updateDMListSidebar();
    return;
  }

  const target = (window.users || []).find(u => u.username === targetUsername) || {
    username: targetUsername,
    display: targetUsername
  };

  const pm = document.createElement("div");
  pm.className = "pm-window";
  pm.id = "pmWindow_" + target.username;

  pm.innerHTML = `
    <div class="pm-header">
      <div style="display:flex;gap:8px;align-items:center">
        <div class="avatar" style="width:36px;height:36px">${target.display[0]}</div>
        <div>
          <div style="font-weight:700">${target.display}</div>
          <div class="small">@${target.username}</div>
        </div>
      </div>
      <div style="display:flex;gap:6px;align-items:center">
        <button class="small-btn pm-clear">Clear</button>
        <button class="small-btn pm-close">X</button>
      </div>
    </div>

    <div class="pm-body" id="pmBody_${target.username}"></div>

    <div class="pm-input">
      <input id="pmInput_${target.username}" type="text" placeholder="Message ${target.display}">
      <button class="small-btn" id="pmSend_${target.username}">Send</button>
    </div>
  `;

  document.body.appendChild(pm);

  pm.querySelector(".pm-close").addEventListener("click", () => {
    pm.remove();
  });

  pm.querySelector(".pm-clear").addEventListener("click", () => {
    if (!confirm("Clear this DM history?")) return;
    const key = pmKey(s.username, target.username);
    localStorage.removeItem(STORAGE_DM_PREFIX + key);
    clearUnread(target.username);
    window._pmStore[key] = [];
    renderPM(target.username);
    if (window.updateDMListSidebar) updateDMListSidebar();
  });

  document
    .getElementById("pmSend_" + target.username)
    .addEventListener("click", () => sendPM(target.username));

  document
    .getElementById("pmInput_" + target.username)
    .addEventListener("keydown", e => {
      if (e.key === "Enter") sendPM(target.username);
    });

  const key = pmKey(s.username, target.username);
  window._pmStore[key] = loadDM(s.username, target.username);

  clearUnread(target.username);
  if (window.updateDMListSidebar) updateDMListSidebar();

  renderPM(target.username);
}

function sendPM(targetUsername) {
  const s = getSession();
  if (!s) return;

  const input = document.getElementById("pmInput_" + targetUsername);
  const text = input.value.trim();
  if (!text) return;

  const message = {
    from: s.username,
    to: targetUsername,
    display: s.display || s.displayName || s.username,
    text
  };

  const key = pmKey(s.username, targetUsername);
  let arr = loadDM(s.username, targetUsername);
  arr.push(message);
  saveDM(s.username, targetUsername, arr);

  window._pmStore[key] = arr;

  socket.emit("privateMessage", message);

  input.value = "";
  renderPM(targetUsername);
}

function renderPM(targetUsername) {
  const s = getSession();
  if (!s) return;

  const body = document.getElementById("pmBody_" + targetUsername);
  if (!body) return;

  const msgs = loadDM(s.username, targetUsername);
  body.innerHTML = "";

  msgs.forEach(m => {
    const div = document.createElement("div");
    div.className = "message " + (m.from === s.username ? "me" : "");
    div.innerHTML = `
      <div style="font-size:13px;font-weight:700">${m.display}</div>
      <div style="margin-top:6px">${escapeHtml(m.text)}</div>
    `;
    body.appendChild(div);
  });

  body.scrollTop = body.scrollHeight;
}

// DM sidebar + search

function updateDMListSidebar() {
  const sidebar = document.getElementById("dmSidebar");
  if (!sidebar) return;

  const user = getSession();
  if (!user) {
    sidebar.innerHTML = '<div class="small" style="color:var(--muted)">Login to see DMs</div>';
    return;
  }
const unread = getUnreadMap();
const total = Object.values(unread).reduce((a,b) => a + b, 0);

const badge = $('dmBadge');
if (badge) {
  if (total > 0) {
    badge.textContent = total;
    badge.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
  }
}
  const keys = Object.keys(localStorage)
    .filter(k => k.startsWith(STORAGE_DM_PREFIX))
    .map(k => k.replace(STORAGE_DM_PREFIX, ''));

  sidebar.innerHTML = '';

  const search = document.createElement('input');
  search.id = 'dmSearch';
  search.className = 'dm-search';
  search.placeholder = 'Search DMs';
  sidebar.appendChild(search);

  const listContainer = document.createElement('div');
  listContainer.id = 'dmSidebarList';
  sidebar.appendChild(listContainer);

  const renderList = (filterTerm = '') => {
    listContainer.innerHTML = '';
    keys.forEach(key => {
      const [a, b] = key.split('::');
      const me = user.username;
      const other = a === me ? b : a;
      if (!other) return;

      if (filterTerm && !other.toLowerCase().includes(filterTerm.toLowerCase())) return;

      const item = document.createElement('div');
      item.className = 'dm-sidebar-item';
      item.innerHTML = `
        <span>@${other}</span>
        ${unread[other] ? `<span class="dm-unread-badge">${unread[other]}</span>` : ''}
      `;
      item.addEventListener('click', () => openPrivateWindow(other));
      listContainer.appendChild(item);
    });

    if (!listContainer.innerHTML) {
      listContainer.innerHTML = '<div class="small" style="color:var(--muted)">No DMs yet</div>';
    }
  };

  renderList();

  search.addEventListener('input', e => {
    renderList(e.target.value.trim());
  });
}

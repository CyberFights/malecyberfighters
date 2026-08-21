/* ============================================================
   chat-mobile.js — Mobile version of chat.js
   Adapted from ./public/js/chat.js for ./public/mobile.html

   Retains the same paths, ids (where they match), and functions
   used by ./index.js.  Element IDs that differ in mobile.html
   are converted as follows:

     Desktop ID        →  Mobile ID
     -------------------------------------------
     rosterPage        →  rosterList
     quickRoster       →  (skipped — not in mobile)
     vpAvatar (.src)   →  vpAvatar (.innerHTML — div, not img)
     makeDraggable()   →  (skipped — not needed on mobile)
     minimize toggle   →  toggle collapsed class on chatBody
     dmSidebar .dm-list →  dmSidebarList (direct id)

   All API paths, socket events, and function names are preserved
   from the original chat.js so that index.js and other modules
   (pm.js, profile.js, etc.) work unchanged.
============================================================ */

/* ============================================================
   GLOBAL SAFE SELECTOR (works with utils.js)
============================================================ */
window.$ = window.$ || function(id) {
  return document.getElementById(id);
};
const REL_COLORS = {
  rival: "rel-rival",
  friend: "rel-friend",
  opponent: "rel-opponent",
  tagteam: "rel-tagteam",
  dating: "rel-dating",
  married: "rel-married",
  sibling: "rel-sibling",
  parent: "rel-parent",
  owner: "rel-owner"
};

/* ============================================================
   HELPERS
============================================================ */
function show(el){ if (el) el.style.display = 'flex'; }
function hide(el){ if (el) el.style.display = 'none'; }

function escapeHtml(str){
  if (!str) return '';
  return str.replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

function getSession(){
  try {
    const raw = localStorage.getItem('cw_session_v1');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// A message is "mine" (eligible for editing) only when it was sent by the
// current session user. Compared case-insensitively so a username case
// mismatch can never cause someone else's message to appear editable.
function isOwnMessage(msg){
  const s = getSession();
  if (!s || !msg) return false;
  const from = String(msg.from || '').toLowerCase();
  const me = String(s.username || '').toLowerCase();
  return from.length > 0 && from === me;
}

function fileToBase64(file) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(",")[1]; // remove data:image/... prefix
      resolve(base64);
    };
    reader.readAsDataURL(file);
  });
}

async function uploadImageToServer(file) {
  const form = new FormData();
  form.append("image", file);

  const res = await fetch("/api/upload-image", {
    method: "POST",
    body: form
  });

  return await res.json(); // { ok: true, imageUrl: "https://..." }
}

/* ============================================================
   AVATAR RENDERING
============================================================ */
function renderMessageAvatar(username, display, imageUrl, size = 36){
  const initials = (display || username || '?')
    .split(' ')
    .map(n => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  if (imageUrl){
    return `<img src="${imageUrl}" class="avatar-img" style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover">`;
  }

  return `<div class="avatar-fallback" style="width:${size}px;height:${size}px;border-radius:50%">${initials}</div>`;
}

/* ============================================================
   QUICK ROSTER
   (skipped on mobile — no #quickRoster element in mobile.html)
============================================================ */
function renderQuickRoster(){
  // No quick roster section in mobile.html — intentionally left empty
  // to preserve the function name used by index.js presence handler
}

/* ============================================================
   FULL ROSTER PAGE
============================================================ */
function renderRosterPage(){
  const el = $('rosterList'); // MOBILE: rosterList instead of rosterPage
  if (!el) return;

  el.innerHTML = '';

  (window.users || []).forEach(u => {
    const avatar = renderMessageAvatar(u.username, u.display, u.imageUrl, 44);

    const row = document.createElement('div');
    row.className = 'user-row';
    row.innerHTML = `
      ${avatar}
      <div style="flex:1">
        <div style="font-weight:700">${u.display}</div>
        <div class="small">@${u.username}</div>
      </div>
      <button class="small-btn" data-user="${u.username}">Message</button>
    `;

    el.appendChild(row);
  });

  el.querySelectorAll('.small-btn').forEach(btn => {
    btn.addEventListener('click', e => openPrivateWindow(e.target.dataset.user));
  });
}

// PAGINATION SETTINGS (declared early so handlers can use them)
let rosterPage = 1;
const rosterPerPage = 12;

// RENDER ROSTER POPUP
function renderRosterPopup() {
  const list = $('rosterList'); // MOBILE: rosterList instead of rosterPage
  if (!list) return;

  const searchEl = $('rosterSearch');
  const search = (searchEl?.value || '').toLowerCase();
  const pageLabel = $('rosterPageNumber');

  list.innerHTML = '';

  let sorted = [...(window.allUsers || [])];

  // SORT NEWEST FIRST
  sorted.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

  // SEARCH FILTER
  sorted = sorted.filter(u => {
    const name = (u.username || '').toLowerCase();
    const display = (u.display || '').toLowerCase();
    return name.includes(search) || display.includes(search);
  });

  // PAGINATION
  const total = sorted.length;
  const totalPages = Math.max(1, Math.ceil(total / rosterPerPage));

  if (rosterPage > totalPages) rosterPage = totalPages;

  const start = (rosterPage - 1) * rosterPerPage;
  const end = start + rosterPerPage;

  const pageItems = sorted.slice(start, end);

  // RENDER USERS
  pageItems.forEach(u => {
    const div = document.createElement('div');
    div.className = 'roster-user user-row';

    const display = u.display || u.username || '?';
    const avatar = u.imageUrl
      ? `<img src="${u.imageUrl}" class="roster-avatar" style="width:44px;height:44px;border-radius:8px;object-fit:cover">`
      : `<div class="avatar-fallback roster-avatar" style="width:44px;height:44px;display:flex;align-items:center;justify-content:center">${display[0]}</div>`;

    div.innerHTML = `
      ${avatar}
      <div style="flex:1">
        <div class="roster-name" style="font-weight:700">${escapeHtml(display)}</div>
        <div class="roster-username small">@${escapeHtml(u.username || '')}</div>
      </div>
    `;

    div.addEventListener('click', () => openUserProfile(u.username));
    list.appendChild(div);
  });

  if (pageLabel) pageLabel.textContent = `Page ${rosterPage} / ${totalPages}`;
}

async function openRosterModal() {
  const modal = $('modalRoster');
  if (modal) modal.style.display = 'flex';

  try {
    const res = await fetch('/api/allUsers');
    const data = await res.json();
    if (data.success) {
      window.allUsers = data.users;
      rosterPage = 1;
      renderRosterPopup();
    }
  } catch (err) {
    console.error('Failed to load roster', err);
  }
}


// OPEN PROFILE (hook into your existing profile modal)
function openUserProfile(username) {
  const user = (window.allUsers || []).find(u => u.username === username);
  if (!user) return;

  // Existing profile fields
  if ($('vpName')) $('vpName').textContent = user.display || user.username;
  if ($('vpUsername')) $('vpUsername').textContent = user.username;
  if ($('vpBio')) $('vpBio').textContent = user.info || "No bio provided";
  if ($('vpWins')) $('vpWins').textContent = user.wins ?? user.stats?.wins ?? 0;
  if ($('vpLosses')) $('vpLosses').textContent = user.losses ?? user.stats?.losses ?? 0;
  if ($('vpLang')) $('vpLang').textContent = user.language || "Unknown";
  if ($('vpAge')) $('vpAge').textContent = user.age || "Unknown";
  if ($('vpColorBox')) $('vpColorBox').style.background = user.color || "#7fd8ff";

  // MOBILE: vpAvatar is a <div> not an <img>, use innerHTML
  if ($('vpAvatar')) {
    const avatarHtml = renderMessageAvatar(user.username, user.display, user.imageUrl, 96);
    $('vpAvatar').innerHTML = avatarHtml;
  }

  document.getElementById("vpBlockButton").onclick = async () => {
    const me = getSession();
    if (!me) return;

    if (!confirm("Block this user? They will not be able to DM you.")) return;

    const res = await fetch("/api/block-user", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: me.username,
        target: username
      })
    });

    const data = await res.json();

    if (data.ok) {
      alert("User blocked.");
    } else {
      alert("Failed to block user.");
    }
  };

  // Load stories + relationships + timeline
  loadStories(username);
  
  loadRelationships(username);
  
  loadRelationshipTimeline(username);

  // Reset dropdown
  $('vpRelationshipSelect').value = "";

  // Attach relationship request handler
  $('vpRelationshipSend').onclick = async () => {
    const type = $('vpRelationshipSelect').value;
    if (!type) return alert("Select a relationship first");

    const requester = getSession().username;
    const target = user.username;

    const res = await fetch("/api/relationship/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requester, target, type })
    });

    const data = await res.json();
    if (!data.ok) return alert("Failed to send request");

    alert("Relationship request sent!");
  };

  $('modalViewProfile').style.display = "flex";
  document.getElementById("vpDMButton").onclick = () => {
    openPrivateWindow(username);
  };
}

$('vpClose')?.addEventListener('click', () => {
  if ($('modalViewProfile')) $('modalViewProfile').style.display = "none";
});

// OPEN ROSTER POPUP
$('btnRoster')?.addEventListener('click', openRosterModal);

// CLOSE ROSTER POPUP
$('rosterClose')?.addEventListener('click', () => {
  if ($('modalRoster')) $('modalRoster').style.display = 'none';
});

// SEARCH FILTER
$('rosterSearch')?.addEventListener('input', () => {
  rosterPage = 1;
  renderRosterPopup();
});

// PAGINATION BUTTONS
$('rosterPrev')?.addEventListener('click', () => {
  if (rosterPage > 1) {
    rosterPage--;
    renderRosterPopup();
  }
});

$('rosterNext')?.addEventListener('click', () => {
  rosterPage++;
  renderRosterPopup();
});

async function loadStories(username) {
  const res = await fetch("/api/story/list?username=" + encodeURIComponent(username));
  const data = await res.json();

  const box = document.getElementById("profileStories");
  if (!box) return;
  box.innerHTML = "<h3>Stories</h3>";

  if (!data.stories || !data.stories.length) {
    box.innerHTML += "<div class='small muted'>No approved stories</div>";
    return;
  }

  data.stories.forEach(s => {
    // Stories are saved to both the owner's and the partner's profile
    const other = s.owner === username ? s.partner : s.owner;
    const title = s.title || `Story with ${other}`;
    const div = document.createElement("div");
    div.className = "story-item";
    div.innerHTML = `
      <div><strong>${escapeHtml(title)}</strong></div>
      <div class="small">${escapeHtml(other)} — ${new Date(s.createdAt).toLocaleDateString()}</div>
    `;
    div.onclick = () => openStoryViewer(title, s.story);
    box.appendChild(div);
  });
}

async function loadRelationships(username) {
  const res = await fetch("/api/relationship/list?username=" + encodeURIComponent(username));
  const data = await res.json();

  const box = document.getElementById("profileRelationships");
  if (!box) return;
  box.innerHTML = "<h3>Relationships</h3>";

  if (!data.relationships || !data.relationships.length) {
    box.innerHTML += "<div class='small muted'>No relationships</div>";
    return;
  }

  data.relationships.forEach(r => {
    const other = r.requester === username ? r.target : r.requester;
    const cls = REL_COLORS[r.type] || "rel-friend";

    const div = document.createElement("div");
    div.className = `relationship-item ${cls}`;
    div.innerHTML = `
      <strong>${escapeHtml(r.type)}</strong> with ${escapeHtml(other)}
    `;
    box.appendChild(div);
  });
}

async function loadRelationshipTimeline(username) {
  const res = await fetch("/api/relationship/timeline?username=" + encodeURIComponent(username));
  const data = await res.json();

  const box = document.getElementById("profileTimeline");
  if (!box) return;
  box.innerHTML = "<h3>Relationship Timeline</h3>";

  const events = data.timeline || [];

  if (!events.length) {
    box.innerHTML += "<div class='small muted'>No relationship history</div>";
    return;
  }

  events.forEach(e => {
    const div = document.createElement("div");
    const cls = REL_COLORS[e.type] || "rel-friend";
    div.className = `timeline-item ${cls}`;

    div.innerHTML = `
      <div class="timeline-date">${new Date(e.approvedAt).toLocaleString()}</div>
      <div class="timeline-desc">
        ${escapeHtml(e.type)} with <strong>${escapeHtml(e.with)}</strong>
      </div>
    `;

    box.appendChild(div);
  });
}

// Expose for other modules
window.loadStories = loadStories;
window.loadRelationships = loadRelationships;
window.loadRelationshipTimeline = loadRelationshipTimeline;
window.openUserProfile = openUserProfile;
window.openRosterModal = openRosterModal;



/* ============================================================
   ONLINE LIST
============================================================ */
function renderOnlineList(){
  const el = $('onlineList');
  if (!el) return;

  el.innerHTML = '';

  (window.users || []).forEach(u => {
    const avatar = renderMessageAvatar(u.username, u.display, u.imageUrl, 36);

    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.justifyContent = 'space-between';

    row.innerHTML = `
      <div class="holo-avatar" style="display:flex;gap:8px;align-items:center">
        ${avatar}
        <div>
          <div style="font-weight:700">${u.display}</div>
          <div class="small">@${u.username}</div>
        </div>
      </div>
      <button class="small-btn" data-user="${u.username}">PM</button>
    `;

    el.appendChild(row);
  });

  el.querySelectorAll('.small-btn').forEach(btn => {
    btn.addEventListener('click', e => openPrivateWindow(e.target.dataset.user));
  });
}

/* ============================================================
   DM SIDEBAR (optional)
============================================================ */
/* DM sidebar provided by utils.js */


/* ============================================================
   PRESENCE UPDATES
============================================================ */
socket.on('presence', users => {
  window.users = users;
  renderQuickRoster();
  renderRosterPage();
  renderOnlineList();
  if (window.updateDMListSidebar) updateDMListSidebar();
});

/* ============================================================
   CHAT POPUP
============================================================ */
$('btnOpenChat')?.addEventListener('click', () => {
  const s = getSession();
  show($('chatPopup'));

  // Re-announce presence after a previous close marked this user offline.
  if (s) socket.emit("login", s);
  if (window.updateUIForSession) updateUIForSession();
  loadPublicMessages();
  renderOnlineList();
});
/* CLOSE CHATROOM → disconnect from online (but stay logged in) */
$('btnCloseChat')?.addEventListener('click', () => {
  const s = getSession();
  if (s) {
    socket.emit("chatClosed", { username: s.username });
    window.users = (window.users || []).filter(u => u.username !== s.username);
  }
  const onlineList = $('onlineList');
  if (onlineList) onlineList.innerHTML = '';
  hide($('chatPopup'));
});

// MOBILE: minimize toggles collapsed class on chatBody instead of hiding chatPopup
$('btnMinimize')?.addEventListener('click', () => {
  const body = $('chatBody');
  if (body) body.classList.toggle('collapsed');
});

/* ============================================================
   MARK OFFLINE ON TAB CLOSE (keep session for refresh)
============================================================ */
window.addEventListener("beforeunload", () => {
  const s = getSession();
  if (!s) return;
  // Mark offline but keep login session so refresh stays signed in
  socket.emit("chatClosed", { username: s.username });
});

/* ============================================================
   MESSAGE EDIT + REPLY (public chat & rooms)
============================================================ */
let publicReplyTo = null;
let roomReplyTo = null;

function setPublicReply(msg){
  if (!msg) return;
  publicReplyTo = {
    id: msg._id || msg.id || null,
    from: msg.from,
    display: msg.display || msg.from,
    text: msg.text || ""
  };
  const bar = $('publicReplyBar');
  if (bar) {
    const snippet = (publicReplyTo.text || "").slice(0, 80);
    bar.innerHTML = `↩ Replying to <b>@${escapeHtml(publicReplyTo.from)}</b>: ${escapeHtml(snippet)} <button type="button" class="reply-cancel" aria-label="Cancel reply">✕</button>`;
    bar.style.display = 'flex';
    bar.querySelector('.reply-cancel').onclick = clearPublicReply;
  }
  const input = $('publicMessage');
  if (input) input.focus();
}

function clearPublicReply(){
  publicReplyTo = null;
  const bar = $('publicReplyBar');
  if (bar) { bar.style.display = 'none'; bar.innerHTML = ''; }
}

function setRoomReply(msg){
  if (!msg) return;
  roomReplyTo = {
    id: msg._id || msg.id || null,
    from: msg.from,
    display: msg.display || msg.from,
    text: msg.text || ""
  };
  const bar = $('roomReplyBar');
  if (bar) {
    const snippet = (roomReplyTo.text || "").slice(0, 80);
    bar.innerHTML = `↩ Replying to <b>@${escapeHtml(roomReplyTo.from)}</b>: ${escapeHtml(snippet)} <button type="button" class="reply-cancel" aria-label="Cancel reply">✕</button>`;
    bar.style.display = 'flex';
    bar.querySelector('.reply-cancel').onclick = clearRoomReply;
  }
  const input = $('roomMessageInput');
  if (input) input.focus();
}

function clearRoomReply(){
  roomReplyTo = null;
  const bar = $('roomReplyBar');
  if (bar) { bar.style.display = 'none'; bar.innerHTML = ''; }
}

function markEdited(div){
  if (!div) return;
  const small = div.querySelector('.small');
  if (!small || small.querySelector('.edited-marker')) return;
  const marker = document.createElement('span');
  marker.className = 'edited-marker';
  marker.textContent = ' (edited)';
  small.appendChild(marker);
}

function startPublicEdit(div, msg){
  if (!isOwnMessage(msg)) return; // only the sender may edit
  const textEl = div.querySelector('.message-text');
  if (!textEl) return;
  const current = msg.text || '';

  const editor = document.createElement('div');
  editor.className = 'edit-box';
  editor.innerHTML = `
    <input type="text" class="edit-input" maxlength="500" value="${escapeHtml(current)}">
    <div class="edit-buttons">
      <button type="button" class="msg-action edit-save">Save</button>
      <button type="button" class="msg-action edit-cancel">Cancel</button>
    </div>
  `;
  textEl.style.display = 'none';
  textEl.insertAdjacentElement('afterend', editor);

  const input = editor.querySelector('.edit-input');
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);

  const save = () => {
    const newText = input.value.trim();
    if (!newText || newText === current) { cancel(); return; }
    const s = getSession();
    if (!s) { cancel(); return; }
    socket.emit('editPublicMessage', { id: div.dataset.id, from: s.username, text: newText });
    msg.text = newText;
    msg.edited = true;
    textEl.textContent = newText;
    markEdited(div);
    cancel();
  };
  const cancel = () => {
    editor.remove();
    textEl.style.display = '';
  };
  editor.querySelector('.edit-save').onclick = save;
  editor.querySelector('.edit-cancel').onclick = cancel;
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') save();
    if (e.key === 'Escape') cancel();
  });
}

function startRoomEdit(div, msg){
  if (!isOwnMessage(msg)) return; // only the sender may edit
  const textEl = div.querySelector('.message-text');
  if (!textEl) return;
  const current = msg.text || '';

  const editor = document.createElement('div');
  editor.className = 'edit-box';
  editor.innerHTML = `
    <input type="text" class="edit-input" maxlength="500" value="${escapeHtml(current)}">
    <div class="edit-buttons">
      <button type="button" class="msg-action edit-save">Save</button>
      <button type="button" class="msg-action edit-cancel">Cancel</button>
    </div>
  `;
  textEl.style.display = 'none';
  textEl.insertAdjacentElement('afterend', editor);

  const input = editor.querySelector('.edit-input');
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);

  const save = () => {
    const newText = input.value.trim();
    if (!newText || newText === current) { cancel(); return; }
    const s = getSession();
    if (!s) { cancel(); return; }
    socket.emit('editRoomMessage', { id: div.dataset.id, from: s.username, text: newText });
    msg.text = newText;
    msg.edited = true;
    textEl.textContent = newText;
    markEdited(div);
    cancel();
  };
  const cancel = () => {
    editor.remove();
    textEl.style.display = '';
  };
  editor.querySelector('.edit-save').onclick = save;
  editor.querySelector('.edit-cancel').onclick = cancel;
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') save();
    if (e.key === 'Escape') cancel();
  });
}

/* ============================================================
   PUBLIC CHAT — HISTORY
============================================================ */
async function loadPublicMessages(){
  const feed = $('publicFeed');
  if (!feed) return;

  feed.innerHTML = '';

  const res = await fetch('/api/public-messages');
  const data = await res.json();
  if (!data.ok) return;

  data.messages.forEach(m => appendPublicMessage(m));
}

/* ============================================================
   PUBLIC CHAT — SEND
============================================================ */
$('sendPublic')?.addEventListener('click', sendPublicMessage);
$('publicMessage')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') sendPublicMessage();
});

function sendPublicMessage(){
  const input = $('publicMessage');
  if (!input) return;

  const text = input.value.trim();
  if (!text) return;

  const s = getSession();
  if (!s) return;

  const msg = {
    from: s.username,
    display: s.display || s.username,
    text,
    time: new Date().toISOString(),
    replyTo: publicReplyTo
  };

  socket.emit('publicMessage', msg);

  // Instant local render
  appendPublicMessage(msg);

  input.value = '';
  clearPublicReply();
}

/* ============================================================
   PUBLIC CHAT — RECEIVE
============================================================ */
socket.on('publicMessage', msg => {
  const s = getSession();
  if (s && msg.from === s.username) {
    updateOwnPublicMessage(msg);
    return;
  }
  appendPublicMessage(msg);
});

function updateOwnPublicMessage(msg){
  const feed = $('publicFeed');
  if (!feed || !msg) return;
  const rows = feed.querySelectorAll('.message-row.me');
  for (let i = rows.length - 1; i >= 0; i--) {
    if (!rows[i].dataset.id) {
      rows[i].dataset.id = msg._id;
      return;
    }
  }
}

socket.on('publicMessageEdited', data => {
  const feed = $('publicFeed');
  if (!feed || !data) return;
  const rows = feed.querySelectorAll('.message-row');
  for (const r of rows) {
    if (r.dataset.id === String(data._id)) {
      const textEl = r.querySelector('.message-text');
      if (textEl) textEl.textContent = data.text;
      markEdited(r);
      break;
    }
  }
});

socket.on("externalPublicMessage", msg => {
  appendPublicMessage(msg);
});

/* ============================================================
   PUBLIC CHAT — RENDER MESSAGE
============================================================ */
function appendPublicMessage(msg){
  const feed = $('publicFeed');
  if (!feed) return;

  const s = getSession();
  const isMine = isOwnMessage(msg);
  const user = (window.users || []).find(u => u.username === msg.from);
  const avatar = renderMessageAvatar(
    msg.from,
    msg.display,
    msg.avatar || user?.imageUrl
  );

  const div = document.createElement('div');
  div.className = 'message-row ' + (isMine ? 'me' : '');
  if (msg._id) div.dataset.id = msg._id;

  const imageHtml = msg.imageUrl
    ? `<img src="${escapeHtml(msg.imageUrl)}" class="chat-image" style="max-width:220px;border-radius:8px;margin-top:6px;cursor:pointer" data-url="${escapeHtml(msg.imageUrl)}">`
    : '';

  const replyHtml = msg.replyTo
    ? `<div class="reply-preview">↩ <b>@${escapeHtml(msg.replyTo.display || msg.replyTo.from || '')}</b> — ${escapeHtml((msg.replyTo.text || '').slice(0, 80))}</div>`
    : '';

  const editedHtml = msg.edited ? `<span class="edited-marker"> (edited)</span>` : '';

  div.innerHTML = `
    <div class="message-avatar">${avatar}</div>
    <div class="message">
      <div style="font-weight:700; color:${user?.color || '#7fd8ff'}">
        ${escapeHtml(msg.display || msg.from || '')}
        <span class="small" style="color:${user?.color || '#7fd8ff'}">
          @${escapeHtml(msg.from || '')} • ${new Date(msg.time).toLocaleTimeString()}${editedHtml}
        </span>
      </div>
      ${replyHtml}
      ${msg.text ? `<div class="message-text">${escapeHtml(msg.text)}</div>` : ''}
      ${imageHtml}
      <div class="message-actions">
        <button type="button" class="msg-action action-reply">Reply</button>
        ${isMine && msg.text ? `<button type="button" class="msg-action action-edit">Edit</button>` : ''}
      </div>
    </div>
  `;

  div.querySelectorAll('.chat-image').forEach(img => {
    img.addEventListener('click', () => window.open(img.dataset.url, '_blank'));
  });

  div.querySelector('.action-reply')?.addEventListener('click', () => setPublicReply(msg));
  div.querySelector('.action-edit')?.addEventListener('click', () => {
    if (!isOwnMessage(msg)) return; // only the sender may edit
    if (!div.dataset.id) return;
    startPublicEdit(div, msg);
  });

  feed.appendChild(div);
  feed.scrollTop = feed.scrollHeight;
}

/* ============================================================
   ROOMS — JOIN / SEND / RECEIVE
============================================================ */
function joinRoom(room){
  socket.emit('joinRoom', { room });
}

function sendRoomMessage(room, text){
  const s = getSession();
  if (!s) return;

  socket.emit('roomMessage', {
    room,
    from: s.username,
    display: s.display || s.username,
    text,
    time: new Date().toISOString(),
    replyTo: roomReplyTo
  });
  // Server will broadcast back (including to sender) after translate/save
  clearRoomReply();
}

socket.on('roomHistory', ({ room, history }) => {
  const feed = $('roomFeed');
  if (!feed) return;

  feed.innerHTML = '';
  history.forEach(m => appendRoomMessage(m));
});

socket.on('roomMessage', msg => {
  const roomChat = $('roomChatPopup');
  const currentRoom = roomChat?.dataset.room;
  const s = getSession();

  if (msg.room !== currentRoom) {
    // Don't badge our own outbound messages when room isn't focused
    if (!s || msg.from !== s.username) {
      if (typeof incrementRoomUnread === 'function') incrementRoomUnread(msg.room);
      if (typeof updateRoomsSidebarBadges === 'function') updateRoomsSidebarBadges();
    }
    return;
  }

  appendRoomMessage(msg);
});


function appendRoomMessage(msg){
  const feed = $('roomFeed');
  if (!feed) return;

  const s = getSession();
  const isMine = isOwnMessage(msg);
  const user = (window.users || []).find(u => u.username === msg.from);
  const avatar = renderMessageAvatar(msg.from, msg.display, user?.imageUrl || msg.avatar);

  const div = document.createElement('div');
  div.className = 'message-row';
  if (msg._id) div.dataset.id = msg._id;

  const textHtml = msg.text ? `<div class="message-text">${escapeHtml(msg.text)}</div>` : '';
  const imageHtml = msg.imageUrl
    ? `<img src="${msg.imageUrl}" class="chat-image" style="max-width:220px;border-radius:8px;margin-top:6px;cursor:pointer" data-url="${msg.imageUrl}">`
    : '';

  const replyHtml = msg.replyTo
    ? `<div class="reply-preview">↩ <b>@${escapeHtml(msg.replyTo.display || msg.replyTo.from || '')}</b> — ${escapeHtml((msg.replyTo.text || '').slice(0, 80))}</div>`
    : '';

  const editedHtml = msg.edited ? `<span class="edited-marker"> (edited)</span>` : '';

  div.innerHTML = `
    <div class="message-avatar">${avatar}</div>
    <div class="message">
      <div style="font-weight:700; color:${user?.color || '#7fd8ff'}">
        ${escapeHtml(msg.display || msg.from || '')}
        <span class="small" style="color:${user?.color || '#7fd8ff'}">
          @${escapeHtml(msg.from || '')} • ${new Date(msg.time).toLocaleTimeString()}${editedHtml}
        </span>
      </div>
      ${replyHtml}
      ${textHtml}
      ${imageHtml}
      <div class="message-actions">
        <button type="button" class="msg-action action-reply">Reply</button>
        ${isMine && msg.text ? `<button type="button" class="msg-action action-edit">Edit</button>` : ''}
      </div>
    </div>
  `;

  div.querySelectorAll('.chat-image').forEach(img => {
    img.addEventListener('click', () => window.open(img.dataset.url, '_blank'));
  });

  div.querySelector('.action-reply')?.addEventListener('click', () => setRoomReply(msg));
  div.querySelector('.action-edit')?.addEventListener('click', () => {
    if (!isOwnMessage(msg)) return; // only the sender may edit
    if (!div.dataset.id) return;
    startRoomEdit(div, msg);
  });

  feed.appendChild(div);
  feed.scrollTop = feed.scrollHeight;
}

// A room message was edited — update it in place on every client.
socket.on('roomMessageEdited', data => {
  const feed = $('roomFeed');
  if (!feed || !data) return;
  const rows = feed.querySelectorAll('.message-row');
  for (const r of rows) {
    if (r.dataset.id === String(data._id)) {
      const textEl = r.querySelector('.message-text');
      if (textEl) textEl.textContent = data.text;
      markEdited(r);
      break;
    }
  }
});

document.getElementById("roomImageBtn")?.addEventListener("click", () => {
  document.getElementById("roomImageInput").click();
});

document.getElementById("roomImageInput")?.addEventListener("change", e => {
  const file = e.target.files[0];
  if (file) uploadRoomImage(file);
});

async function uploadRoomImage(file) {
  const data = await uploadImageToServer(file);

  if (!data.ok) {
    alert("Image upload failed");
    return;
  }

  const s = getSession();
  const room = document.getElementById("roomChatPopup")?.dataset.room;
  if (!s || !room) return;

  socket.emit("roomMessage", {
    room,
    from: s.username,
    display: s.display || s.username,
    imageUrl: data.imageUrl
  });
}

/* ============================================================
   PRIVATE MESSAGING HOOK
   (pm.js provides the real openPrivateWindow implementation)
============================================================ */
if (typeof window.openPrivateWindow !== 'function') {
  window.openPrivateWindow = function(username) {
    console.warn('PM module not loaded; cannot open chat with', username);
  };
}
// Local alias so roster/online list handlers work either way
function openPrivateWindow(username) {
  return window.openPrivateWindow(username);
}

// MOBILE: makeDraggable not needed — mobile uses full-screen popups
// makeDraggable($('chatPopup'));  ← skipped

function makeDraggable(el) {
  // No-op on mobile — full-screen popups are not draggable
  // Function preserved for compatibility with index.js / other modules
}

$('createRoomBtn')?.addEventListener('click', () => {
  const name = prompt("Enter room name:");
  if (!name) return;

  const isPrivate = confirm("Make this a PRIVATE room?");

  socket.emit("createRoom", {
    name,
    private: isPrivate
  });
});

socket.on("roomsList", rooms => {
  window.rooms = rooms;
  renderRoomsSidebar();
});


function renderRoomsSidebar() {
  const list = $('roomsList');
  const sort = $('roomSort')?.value || 'newest';
  const s = getSession();
  if (!list) return;
  list.innerHTML = "";

  let rooms = [...(window.rooms || [])];

  // FILTER PRIVATE ROOMS
  rooms = rooms.filter(r => {
    if (!r.private) return true;
    if (r.owner?.toLowerCase() === s?.username?.toLowerCase()) return true;
    if (r.invitedUsers?.includes(s?.username)) return true;
    return false;
  });

  // SORTING
  if (sort === "newest") rooms.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  if (sort === "oldest") rooms.sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt));
  if (sort === "az") rooms.sort((a,b)=>a.name.localeCompare(b.name));
  if (sort === "za") rooms.sort((a,b)=>b.name.localeCompare(a.name));

  // RENDER ROOMS
  rooms.forEach(room => {
    const div = document.createElement("div");
    div.className = "room-item";

    div.innerHTML = `
      ${room.private ? "🔒 " : ""}${room.name}
    `;

    // CLICK TO OPEN ROOM CHAT
    div.addEventListener("click", () => {
      openRoomPopup(room._id, room.name);
    });

    // ⭐ INVITE BUTTON FOR OWNER ONLY
    if (room.owner?.toLowerCase() === s?.username?.toLowerCase()) {
      const inviteBtn = document.createElement("button");
      inviteBtn.className = "ghost small-btn";
      inviteBtn.textContent = "Invite";

      inviteBtn.addEventListener("click", (e) => {
        e.stopPropagation(); // prevent joinRoom()
        const username = prompt("Enter username to invite:");
        if (!username) return;

        socket.emit("inviteToRoom", {
          roomId: room._id,
          username
        });
      });

      div.appendChild(inviteBtn);
    }

    list.appendChild(div);
  });
}

$('roomSort')?.addEventListener('change', renderRoomsSidebar);
socket.on("roomJoinDenied", ({ room, reason } = {}) => {
  const popup = $('roomChatPopup');
  if (popup && String(popup.dataset.room) === String(room)) {
    popup.dataset.room = '';
    popup.style.display = 'none';
    renderRoomMembers([]);
  }
  alert(reason === 'room_not_found'
    ? 'This room is no longer available.'
    : 'You are not invited to this private room.');
});

socket.on("roomInvited", ({ roomId, roomName }) => {
  alert(`You have been invited to join the private room: ${roomName}`);
});
// OPEN TOS
$('btnTOS')?.addEventListener('click', () => {
  $('modalTOS').style.display = 'flex';
});

// CLOSE TOS
$('closeTOS')?.addEventListener('click', () => {
  $('modalTOS').style.display = 'none';
});

// open rules
$('btnRules')?.addEventListener('click', () => {
  $('modalRules').style.display = 'flex';
});

// CLOSE rules
$('closeRules')?.addEventListener('click', () => {
  $('modalRules').style.display = 'none';
});
$('openSupport')?.addEventListener('click', () => {
  $('supportPopup').style.display = 'flex';
});

// CLOSE rules
$('closeSupport')?.addEventListener('click', () => {
  $('supportPopup').style.display = 'none';
});
// OPEN PRIVACY
$('btnPrivacy')?.addEventListener('click', () => {
  $('modalPrivacy').style.display = 'flex';
});

function updateRoomsSidebarBadges() {
  const unread = getRoomUnread();

  Object.keys(unread).forEach(roomId => {
    const badge = $('roomBadge_' + roomId);
    if (badge) {
      badge.textContent = unread[roomId];
      badge.style.display = 'inline-block';
    }
  });

  // hide badges for cleared rooms
  (window.rooms || []).forEach(r => {
    if (!unread[r._id]) {
      const badge = $('roomBadge_' + r._id);
      if (badge) badge.style.display = 'none';
    }
  });
}


// CLOSE PRIVACY
$('closePrivacy')?.addEventListener('click', () => {
  $('modalPrivacy').style.display = 'none';
});

function openRoomPopup(roomId, roomName) {
  const popup = $('roomChatPopup');
  const title = $('roomChatTitle');
  if (!popup || !title) return;

  const roomsPopup = $('roomsSidebar');
  if (roomsPopup) roomsPopup.style.display = 'none';
  
  title.textContent = roomName;

  // Never carry members from a previously open room into this one.
  renderRoomMembers([]);
  popup.dataset.room = roomId;
  popup.style.display = 'flex';

  clearRoomUnread(roomId);
  updateRoomsSidebarBadges();

  socket.emit("joinRoom", { room: roomId });

  // Request member list refresh after the join has reached the server.
  setTimeout(() => {
    const currentRoom = $('roomChatPopup')?.dataset.room;
    if (String(currentRoom) !== String(roomId)) return;
    socket.emit("requestRoomMembers", { room: roomId });
  }, 200);
}

socket.on("requestRoomMembers", ({ room }) => {
  updateRoomMembers(room);
});


$('roomSendBtn')?.addEventListener('click', () => {
  const room = $('roomChatPopup')?.dataset.room;
  const input = $('roomMessageInput');
  if (!input || !room) return;
  
  const text = input.value.trim();
  if (!text) return;

  sendRoomMessage(room, text);
  input.value = '';
});

$('closeRoomChat')?.addEventListener('click', () => {
  const popup = $('roomChatPopup');
  const room = popup?.dataset.room;

  if (room) socket.emit("leaveRoom", { room });
  if (popup) {
    popup.dataset.room = '';
    popup.style.display = 'none';
  }
  renderRoomMembers([]);
});


let roomTypingTimeout;

$('roomMessageInput')?.addEventListener("input", () => {
  const room = $('roomChatPopup')?.dataset.room;
  const s = getSession();
  if (!room || !s) return;

  socket.emit("typingRoom", { room, from: s.username });

  clearTimeout(roomTypingTimeout);
  roomTypingTimeout = setTimeout(() => {
    socket.emit("stopTypingRoom", { room, from: s.username });
  }, 1200);
});

socket.on("typingRoom", ({ from, room }) => {
  const roomChat = $('roomChatPopup');
  const current = roomChat?.dataset.room;
  if (current !== room) return;

  const el = $('roomTyping');
  if (el) {
    el.textContent = `${from} is typing...`;
    el.style.display = "block";
  }
});

socket.on("stopTypingRoom", ({ from, room }) => {
  const roomChat = $('roomChatPopup');
  const current = roomChat?.dataset.room;
  if (current !== room) return;

  const el = $('roomTyping');
  if (el) el.style.display = "none";
});

function renderRoomMembers(members) {
  const list = $('roomMembersList');
  if (!list) return;

  list.innerHTML = "";

  members.forEach(m => {
    const div = document.createElement("div");
    div.className = "room-member";

    const avatar = m.imageUrl
      ? `<img src="${m.imageUrl}" style="width:32px;height:32px;border-radius:50%">`
      : `<div class="avatar-fallback" style="width:32px;height:32px">${m.display[0]}</div>`;

    div.innerHTML = `
      ${avatar}
      <div style="flex:1">
        <div style="font-weight:700">${m.display}</div>
        <div class="small">@${m.username}</div>
      </div>
      <div class="room-member-status ${m.online ? "online" : "offline"}"></div>
    `;

    list.appendChild(div);
  });
}

socket.on("roomMembers", members => {
  renderRoomMembers(members);
});

document.getElementById("srType")?.addEventListener("change", () => {
  const type = document.getElementById("srType").value;
  const section = document.getElementById("srUserSection");
  if (section) {
    section.style.display = type === "user" ? "block" : "none";
  }
});

document.getElementById("srSubmit")?.addEventListener("click", async () => {
  const me = getSession();
  if (!me) return alert("You must be logged in.");

  const type = document.getElementById("srType").value;
  const user = document.getElementById("srUser").value;
  const where = document.getElementById("srWhere").value;
  const when = document.getElementById("srWhen").value;
  const info = document.getElementById("srInfo").value;

  const payload = {
    from: me.username,
    to: "Administrator",
    text: `
Support Report
Type: ${type}
User: ${user || "N/A"}
Where: ${where}
When: ${when}
Info: ${info}
    `.trim()
  };

  await fetch("/api/send-dm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  alert("Report submitted.");
  const popup = $('supportPopup');
  if (popup) popup.style.display = 'none';
});

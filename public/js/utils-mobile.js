/* ============================================================
   utils-mobile.js — Mobile version of utils.js
   Adapted from ./public/js/utils.js for ./public/mobile.html

   ID conversions:
     Desktop ID              →  Mobile ID
     -------------------------------------------------------
     userProfileCard         →  meCard (meAvatar, meName, meHandle)
     logoutBtn (dynamic)     →  btnLogout (static in mobile.html)
     btnEditProfile (dynamic)→  btnEditProfile (static in mobile.html)
     selfProfileStories      →  (skipped — not in mobile)
     selfProfilePendingStories → (skipped — not in mobile)
     vpPendingRelationships  →  (skipped — not in mobile)
     vpRelationships         →  (skipped — not in mobile)
     vpTimeline              →  (skipped — not in mobile)

   All API paths, storage keys, and function names are preserved.
============================================================ */

// utils-mobile.js (top) — define $ only if not already defined
if (typeof window.$ === 'undefined') {
  window.$ = function(id) {
    return document.getElementById(id);
  };
}


function show(el){ if (el) el.style.display = 'flex'; }
function hide(el){ if (el) el.style.display = 'none'; }

function escapeHtml(s){
  if (!s) return '';
  return s.replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

const STORAGE_SESSION = 'cw_session_v1';
const STORAGE_PUBLIC  = 'cw_public_v1';
const STORAGE_DM_PREFIX = 'cw_dm_';
const STORAGE_DM_UNREAD = 'cw_dm_unread';

/* SESSION ------------------------------------------------------------ */
function setSession(user){ localStorage.setItem(STORAGE_SESSION, JSON.stringify(user)); }
function getSession(){ return JSON.parse(localStorage.getItem(STORAGE_SESSION) || 'null'); }
function clearSession(){ localStorage.removeItem(STORAGE_SESSION); }

/* PUBLIC CHAT -------------------------------------------------------- */
function loadPublic(){ return JSON.parse(localStorage.getItem(STORAGE_PUBLIC) || '[]'); }
function savePublic(arr){ localStorage.setItem(STORAGE_PUBLIC, JSON.stringify(arr)); }

/* DM STORAGE --------------------------------------------------------- */
function pmKey(a, b) {
  return [a, b].sort().join('::');
}

function loadDM(a, b) {
  const key = pmKey(a, b);
  return JSON.parse(localStorage.getItem(STORAGE_DM_PREFIX + key) || '[]');
}

function saveDM(a, b, arr) {
  const key = pmKey(a, b);
  localStorage.setItem(STORAGE_DM_PREFIX + key, JSON.stringify(arr));
}

/* DM UNREAD ---------------------------------------------------------- */
function getUnreadMap() {
  return JSON.parse(localStorage.getItem(STORAGE_DM_UNREAD) || '{}');
}

function saveUnreadMap(map) {
  localStorage.setItem(STORAGE_DM_UNREAD, JSON.stringify(map));
}

function incrementUnread(fromUser) {
  const map = getUnreadMap();
  map[fromUser] = (map[fromUser] || 0) + 1;
  saveUnreadMap(map);
}

function clearUnread(user) {
  const map = getUnreadMap();
  delete map[user];
  saveUnreadMap(map);
}

/* ============================================================
   PROFILE CARD (MOBILE)
   Desktop uses #userProfileCard; mobile uses #meCard area
   with #meAvatar, #meName, #meHandle
============================================================ */
window.updateProfileCard = function(user) {
  // MOBILE: update the meCard section instead of userProfileCard
  const meAvatar = document.getElementById('meAvatar');
  const meName = document.getElementById('meName');
  const meHandle = document.getElementById('meHandle');
  const chatUserLabel = document.getElementById('chatUserLabel');

  if (!user) {
    // Logged out state
    if (meAvatar) meAvatar.innerHTML = '';
    if (meName) meName.textContent = 'Fighter';
    if (meHandle) meHandle.textContent = '@';
    if (chatUserLabel) chatUserLabel.textContent = 'Not signed in';
    return;
  }

  // Logged in state
  const displayName = user.display || user.displayName || user.username;
  const initials = displayName.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);

  if (meAvatar) {
    if (user.imageUrl) {
      meAvatar.innerHTML = `<img src="${escapeHtml(user.imageUrl)}" alt="avatar" style="width:48px;height:48px;border-radius:50%;object-fit:cover">`;
    } else {
      meAvatar.innerHTML = `<div class="avatar-fallback" style="width:48px;height:48px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;color:#bae6fd;background:#1e3a5f">${escapeHtml(initials)}</div>`;
    }
  }

  if (meName) meName.textContent = displayName;
  if (meHandle) meHandle.textContent = '@' + user.username;
  if (chatUserLabel) chatUserLabel.textContent = displayName;

  // MOBILE: btnEditProfile and btnLogout are static in mobile.html
  // No need to dynamically create them like the desktop version does
};

/* Story viewer popup -----------------------------------------------------
   Replaces the old alert(s.story): shows the story title in an elegant
   script font and the story text in a regular font, with a close button.
------------------------------------------------------------------------ */
function openStoryViewer(title, storyText) {
  // Load the elegant script font once (falls back to system script fonts)
  if (!document.getElementById("storyViewerFont")) {
    const link = document.createElement("link");
    link.id = "storyViewerFont";
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Great+Vibes&display=swap";
    document.head.appendChild(link);
  }

  // Only one viewer at a time
  document.getElementById("storyViewerPopup")?.remove();

  const overlay = document.createElement("div");
  overlay.id = "storyViewerPopup";
  overlay.style.cssText =
    "position:fixed;inset:0;background:rgba(0,0,0,0.85);display:flex;" +
    "align-items:center;justify-content:center;z-index:10000;padding:20px;" +
    "box-sizing:border-box;backdrop-filter:blur(4px);";

  const box = document.createElement("div");
  box.style.cssText =
    "background:#111;border:1px solid rgba(0,150,255,0.4);border-radius:12px;" +
    "box-shadow:0 0 25px rgba(0,150,255,0.4);color:#fff;padding:34px 30px;" +
    "width:640px;max-width:95%;max-height:85vh;overflow-y:hidden;" +
    "display:flex;flex-direction:column;text-align:center;";

  const titleEl = document.createElement("div");
  titleEl.textContent = title || "Untitled story";
  titleEl.style.cssText =
    'font-family:"Great Vibes","Brush Script MT","Segoe Script","Lucida Handwriting",cursive;' +
    "font-size:44px;line-height:1.25;color:#00aaff;margin-bottom:20px;word-break:break-word;";

  const textEl = document.createElement("div");
  textEl.textContent = storyText || "";
  textEl.style.cssText =
    "font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.7;" +
    "color:#f5f5f5;white-space:pre-wrap;word-break:break-word;text-align:left;";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "small-btn ghost";
  closeBtn.textContent = "Close";
  closeBtn.style.cssText = "margin:24px auto 0;";

  box.appendChild(titleEl);
  box.appendChild(textEl);
  box.appendChild(closeBtn);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  const close = () => {
    document.removeEventListener("keydown", onKey);
    overlay.remove();
  };
  const onKey = e => { if (e.key === "Escape") close(); };

  closeBtn.onclick = close;
  overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", onKey);
}

// View-profile helpers (used by chat-mobile.js openUserProfile)
async function loadStories(username) {
  const res = await fetch("/api/story/list?username=" + encodeURIComponent(username));
  const data = await res.json();

  const box = document.getElementById("profileStories");
  if (!box) return;

  box.innerHTML = "";

  if (!data.stories || !data.stories.length) {
    box.innerHTML = "<div class='small muted'>No approved stories yet</div>";
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

async function loadPendingStories(username) {
  // MOBILE: no dedicated pending stories section in mobile.html
  // Function preserved for API compatibility with index.js
  const res = await fetch("/api/story/pending?username=" + encodeURIComponent(username));
  const data = await res.json();
  return (data.stories || []);
}

async function loadRelationships(username) {
  const res = await fetch("/api/relationship/list?username=" + encodeURIComponent(username));
  const data = await res.json();

  const box = document.getElementById("profileRelationships");
  if (!box) return;

  box.innerHTML = "";

  if (!data.relationships || !data.relationships.length) {
    box.innerHTML = '<div class="small muted">No relationships</div>';
    return;
  }

  data.relationships.forEach(r => {
    const other = r.requester === username ? r.target : r.requester;

    const div = document.createElement("div");
    div.className = "relationship-item";
    div.innerHTML = `
      <strong>${escapeHtml(r.type)}</strong> with ${escapeHtml(other)}
    `;
    box.appendChild(div);
  });
}

async function loadPendingRelationships(username) {
  // MOBILE: no dedicated pending relationships section in mobile.html
  // Function preserved for API compatibility with index.js
  const res = await fetch("/api/relationship/pending?username=" + encodeURIComponent(username));
  const data = await res.json();
  return (data.relationships || []);
}

async function loadRelationshipTimeline(username) {
  const res = await fetch("/api/relationship/timeline?username=" + encodeURIComponent(username));
  const data = await res.json();

  const box = document.getElementById("profileTimeline");
  if (!box) return;

  box.innerHTML = "";

  if (!data.timeline || !data.timeline.length) {
    box.innerHTML = '<div class="small muted">No timeline events</div>';
    return;
  }

  data.timeline.forEach(event => {
    const div = document.createElement("div");
    div.className = "timeline-item";
    const when = event.approvedAt || event.createdAt;
    div.innerHTML = `
      <div class="tiny muted">${when ? new Date(when).toLocaleDateString() : ''}</div>
      <div>${escapeHtml(event.type || '')}${event.with ? ' with ' + escapeHtml(event.with) : ''}</div>
    `;
    box.appendChild(div);
  });
}

// Expose helpers globally
window.loadStories = loadStories;
window.loadPendingStories = loadPendingStories;
window.loadRelationships = loadRelationships;
window.loadPendingRelationships = loadPendingRelationships;
window.loadRelationshipTimeline = loadRelationshipTimeline;


function updateAccountSettingsButtonVisibility(user) {
  try {
    if (typeof user === 'undefined') user = getSession();
  } catch (e) { user = null; }
  const visible = !!user;
  document.querySelectorAll('[id="btnAccountSettings"]').forEach(btn => {
    try {
      btn.style.display = visible ? '' : 'none';
      btn.hidden = !visible;
    } catch (_) {}
  });
}
window.updateAccountSettingsButtonVisibility = updateAccountSettingsButtonVisibility;


/* SESSION UI SYNC ---------------------------------------------------- */
window.updateUIForSession = function() {
  const user = getSession();
  updateProfileCard(user);
  try { updateAccountSettingsButtonVisibility(user); } catch (e) {}
};

/* LOAD PROFILE ON PAGE LOAD ------------------------------------------ */
window.addEventListener('load', () => {
  // Prefer session storage; fall back to currentUser for legacy sessions
  const sessionUser = getSession();
  const legacyUser = JSON.parse(localStorage.getItem('currentUser') || 'null');
  const user = sessionUser || legacyUser;
  if (user && !sessionUser) setSession(user);
  updateProfileCard(user);
  try { updateAccountSettingsButtonVisibility(user); } catch (e) {}
});

const STORAGE_ROOM_UNREAD = 'cw_room_unread';

function getRoomUnread() {
  return JSON.parse(localStorage.getItem(STORAGE_ROOM_UNREAD) || '{}');
}

function saveRoomUnread(map) {
  localStorage.setItem(STORAGE_ROOM_UNREAD, JSON.stringify(map));
}

function incrementRoomUnread(roomId) {
  const map = getRoomUnread();
  map[roomId] = (map[roomId] || 0) + 1;
  saveRoomUnread(map);
}

function clearRoomUnread(roomId) {
  const map = getRoomUnread();
  delete map[roomId];
  saveRoomUnread(map);
}

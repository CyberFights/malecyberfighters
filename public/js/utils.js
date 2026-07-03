const $ = id => document.getElementById(id);

function show(el){ el.style.display = 'flex'; }
function hide(el){ el.style.display = 'none'; }

function escapeHtml(s){
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

/* PROFILE CARD ------------------------------------------------------- */
window.updateProfileCard = function(user) {
  const card = document.getElementById('userProfileCard');
  
  if (!card) return;

  /* Logged out ------------------------------------------------------ */
  if (!user) {
    card.innerHTML = `
      <div style="font-size:14px;color:var(--muted)">🔒 Not logged in</div>
      <p style="margin:8px 0 0 0;color:var(--muted);font-size:12px">
        Login or register to see your profile
      </p>
    `;
    card.classList.remove('logged-in');
    return;
  }

  /* Logged in ------------------------------------------------------- */
  const displayName = user.display || user.displayName || user.username;
  const initials = displayName.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);

  const wins = user.stats?.wins || 0;
  const losses = user.stats?.losses || 0;
  const winRate = (wins + losses) > 0 ? ((wins / (wins + losses)) * 100).toFixed(0) : '0';

  const age = user.age ? `${user.age} years old` : 'Age not set';
  const bio = user.info || 'No bio';

loadStories(user.username);
loadPendingStories(user.username);

const avatarHtml = user.imageUrl
  ? `<img src="${user.imageUrl}" alt="avatar" class="profile-avatar-img">`
  : initials;

card.innerHTML = `
  <div class="profile-avatar">${avatarHtml}</div>

  <div class="profile-info">
    <div class="profile-name">${displayName}</div>
    <div class="profile-status">@${user.username}</div>

    <div class="profile-details">
      <div class="profile-age">${age}</div>
      <div class="profile-bio">${bio}</div>
    </div>

    <div class="profile-stats">
      <div class="profile-stat">
        <div class="profile-stat-value">${wins}</div>
        <div class="profile-stat-label">Wins</div>
      </div>
      <div class="profile-stat">
        <div class="profile-stat-value">${losses}</div>
        <div class="profile-stat-label">Losses</div>
      </div>
      <div class="profile-stat">
        <div class="profile-stat-value">${winRate}%</div>
        <div class="profile-stat-label">Win Rate</div>
      </div>
    </div>
  </div>
<div id="profileStories"></div>
<div id="profilePendingStories"></div>

  <button id="btnEditProfile" class="ghost">Edit Profile</button>
  <button id="logoutBtn" class="profile-logout ghost">Logout</button>
`;

  card.classList.add('logged-in');

  /* Attach Logout Listener ------------------------------------------ */
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      if (window.logout) window.logout();
    });
  }

  /* Attach Edit Profile Listener ------------------------------------ */
  const editBtn = document.getElementById('btnEditProfile');
  if (editBtn) {
    editBtn.addEventListener('click', () => {
      const u = getSession();
      if (!u) return;

      // Pre-fill modal fields (handled in profile.js)
      if (window.openEditProfileModal) {
        window.openEditProfileModal(u);
      } else {
        // Fallback: show modal directly
        const modal = document.getElementById('modalEditProfile');
        if (modal) show(modal);
      }
    });
  }

  document.querySelectorAll(".resendApproval").forEach(btn => {
  btn.onclick = async () => {
    const storyId = btn.dataset.id;

    const res = await fetch("/api/story/resend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ storyId })
    });

    const data = await res.json();
    if (data.ok) alert("Approval request resent");
  };
});

};

async function loadStories(username) {
  const res = await fetch("/api/story/list?username=" + username);
  const data = await res.json();

  const box = document.getElementById("profileStories");
  if (!box) return;
  
  box.innerHTML = "<h3>Stories</h3>";

  if (!data.stories || !data.stories.length) {
    box.innerHTML += "<div class='small muted'>No approved stories yet</div>";
    return;
  }

  data.stories.forEach(s => {
    const div = document.createElement("div");
    div.className = "story-item";
    div.textContent = `${s.partner} — ${new Date(s.createdAt).toLocaleDateString()}`;
    div.onclick = () => alert(s.story);
    box.appendChild(div);
  });
}

async function loadPendingStories(username) {
  const res = await fetch("/api/story/pending?username=" + username);
  const data = await res.json();

  const box = document.getElementById("profilePendingStories");
  if (!box) return;
  
  box.innerHTML = "<h3>Pending Approval</h3>";

  if (!data.stories || !data.stories.length) {
    box.innerHTML += "<div class='small muted'>No pending stories</div>";
    return;
  }

  data.stories.forEach(s => {
    const div = document.createElement("div");
    div.className = "story-item pending";
    div.innerHTML = `
      <div><strong>${s.partner}</strong></div>
      <div class="small">${new Date(s.createdAt).toLocaleDateString()}</div>
      <div class="tiny muted">Waiting for ${s.partner} to approve…</div>
      <button class="small-btn resendApproval" data-id="${s._id}">
    Resend Request
  </button>
    `;
    box.appendChild(div);
  });
}

async function loadRelationships(username) {
  const res = await fetch("/api/relationship/list?username=" + username);
  const data = await res.json();

  const box = document.getElementById("vpRelationships");
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
      <strong>${r.type}</strong> with ${other}
    `;
    box.appendChild(div);
  });
}

async function loadPendingRelationships(username) {
  const res = await fetch("/api/relationship/pending?username=" + username);
  const data = await res.json();

  const box = document.getElementById("vpPendingRelationships");
  if (!box) return;
  
  box.innerHTML = "";

  if (!data.relationships || !data.relationships.length) {
    box.innerHTML = '<div class="small muted">None pending</div>';
    return;
  }

  data.relationships.forEach(r => {
    const div = document.createElement("div");
    div.className = "relationship-item pending";
    div.innerHTML = `
      <strong>${r.type}</strong> with ${r.target}
      <div class="tiny muted">Waiting for ${r.target} to approve…</div>
    `;
    box.appendChild(div);
  });
}

async function loadRelationshipTimeline(username) {
  const res = await fetch("/api/relationship/timeline?username=" + username);
  const data = await res.json();

  const box = document.getElementById("vpTimeline");
  if (!box) return;
  
  box.innerHTML = "";

  if (!data.timeline || !data.timeline.length) {
    box.innerHTML = '<div class="small muted">No timeline events</div>';
    return;
  }

  data.timeline.forEach(event => {
    const div = document.createElement("div");
    div.className = "timeline-item";
    div.innerHTML = `
      <div class="tiny muted">${new Date(event.createdAt).toLocaleDateString()}</div>
      <div>${event.description || event.type}</div>
    `;
    box.appendChild(div);
  });
}

/* SESSION UI SYNC ---------------------------------------------------- */
window.updateUIForSession = function() {
  const user = getSession();
  updateProfileCard(user);
};

/* LOAD PROFILE ON PAGE LOAD ------------------------------------------ */
window.addEventListener('load', () => {
  const currentUser = JSON.parse(localStorage.getItem('currentUser') || 'null');
  updateProfileCard(currentUser);
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


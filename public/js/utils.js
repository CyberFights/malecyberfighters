// Overwrite document.getElementById to handle duplicate IDs between mobile (#mainUI) and desktop (.container) layouts
(function() {
  const originalGetElementById = document.getElementById;
  document.getElementById = function(id) {
      if (!id && id !== 0) return originalGetElementById.call(document, id);
      const escapedId = String(id).replace(/"/g, '\\"');
      const elements = document.querySelectorAll('[id="' + escapedId + '"]');
      if (elements.length > 1) {
      // Find the currently active element as the primary target
      const getActiveElement = () => {
        const mainUI = originalGetElementById.call(document, 'mainUI');
        if (mainUI) {
          const isMobile = window.getComputedStyle(mainUI).display !== 'none';
          for (let el of elements) {
            const insideMainUI = mainUI.contains(el);
            if (isMobile && insideMainUI) return el;
            if (!isMobile && !insideMainUI) return el;
          }
        }
        return elements[0];
      };

      const primary = getActiveElement();

      return new Proxy(primary, {
        get(target, prop, receiver) {
          // 1. If adding event listeners, bind to ALL matching elements so both desktop & mobile work seamlessly
          if (prop === 'addEventListener') {
            return function(...args) {
              elements.forEach(el => el.addEventListener(...args));
            };
          }
          if (prop === 'removeEventListener') {
            return function(...args) {
              elements.forEach(el => el.removeEventListener(...args));
            };
          }

          const activeEl = getActiveElement();

          // 2. If accessing style, return a proxy to keep style properties in sync across all elements
          if (prop === 'style') {
            return new Proxy(activeEl.style, {
              set(styleTarget, styleProp, styleValue) {
                elements.forEach(el => {
                  el.style[styleProp] = styleValue;
                });
                return true;
              },
              get(styleTarget, styleProp) {
                return activeEl.style[styleProp];
              }
            });
          }

          // 3. If accessing classList, proxy common mutation methods so class changes sync across both
          if (prop === 'classList') {
            const classListMethods = ['add', 'remove', 'toggle', 'replace'];
            return new Proxy(activeEl.classList, {
              get(classListTarget, classListProp) {
                if (classListMethods.includes(classListProp)) {
                  return function(...args) {
                    elements.forEach(el => el.classList[classListProp](...args));
                  };
                }
                const val = Reflect.get(activeEl.classList, classListProp);
                if (typeof val === 'function') {
                  return val.bind(activeEl.classList);
                }
                return val;
              }
            });
          }

          // 4. If accessing dataset, sync dataset assignments
          if (prop === 'dataset') {
            return new Proxy(activeEl.dataset, {
              set(datasetTarget, datasetProp, datasetValue) {
                elements.forEach(el => {
                  el.dataset[datasetProp] = datasetValue;
                });
                return true;
              },
              get(datasetTarget, datasetProp) {
                return activeEl.dataset[datasetProp];
              }
            });
          }

          // Default fallback
          const value = Reflect.get(activeEl, prop);
          if (typeof value === 'function') {
            return value.bind(activeEl);
          }
          return value;
        },

        set(target, prop, value, receiver) {
          // Keep common values, states, and inline HTML in sync
          elements.forEach(el => {
            Reflect.set(el, prop, value);
          });
          return true;
        }
      });
    }
    return originalGetElementById.call(document, id);
  };
})();

// utils.js (top) — define $ only if not already defined
if (typeof window.$ === 'undefined') {
  window.$ = function(id) {
    return document.getElementById(id);
  };
}


function show(el){ if (!el) return; el.style.display = 'flex'; }
function hide(el){ if (!el) return; el.style.display = 'none'; }

function escapeHtml(s){
  s = s == null ? '' : String(s);
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

/* DM SIDEBAR (shared) -------------------------------------------------
   Canonical implementation for updating the DM partners sidebar. Placed
   in utils.js so all client scripts can call window.updateDMListSidebar()
   instead of implementing duplicate logic. Detects mobile vs desktop via
   the existing document.getElementById proxy and binds search input once.
--------------------------------------------------------------- */

async function updateDMListSidebar() {
  const sidebar = $("dmSidebar");
  if (!sidebar) return;

  const user = getSession();
  const listContainer = $("dmSidebarList") || sidebar.querySelector('.dm-list');
  const searchInput = $("dmSearch");

  if (!user) {
    if (listContainer) {
      listContainer.innerHTML = '<div class="small muted">Login to see DMs</div>';
    }
    if (typeof updateDMBadge === 'function') updateDMBadge();
    return;
  }

  const unread = getUnreadMap();

  try {
    const res = await fetch('/api/dm/partners', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user.username })
    });
    const data = await res.json();
    const partners = (data.partners || []).filter(p => p && p !== user.username);

    const target = listContainer || (() => { const el = document.createElement('div'); el.id = 'dmSidebarList'; sidebar.appendChild(el); return el; })();

    const renderList = (filterTerm = '') => {
      target.innerHTML = '';
      const q = filterTerm.trim().toLowerCase();

      partners.forEach(other => {
        if (q && !other.toLowerCase().includes(q)) return;

        const item = document.createElement('div');
        item.className = 'dm-sidebar-item';

        if (other === 'SYSTEM') {
          item.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center">
              <div style="flex:1;min-width:0">🔔 System</div>
              ${unread[other] ? `<span class="dm-unread-badge">${unread[other]}</span>` : ''}
            </div>
          `;
        } else {
          item.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center">
              <div style="flex:1;min-width:0"><span style="font-weight:700">@${escapeHtml(other)}</span></div>
              ${unread[other] ? `<span class="dm-unread-badge">${unread[other]}</span>` : ''}
            </div>
          `;
        }

        item.addEventListener('click', () => { if (typeof openPrivateWindow === 'function') openPrivateWindow(other); if (sidebar && sidebar.style) sidebar.style.display = 'none'; });
        target.appendChild(item);
      });

      if (!target.innerHTML) target.innerHTML = '<div class="small muted">No DMs yet</div>';
    };

    renderList(searchInput?.value?.trim() || '');

    if (searchInput && !searchInput._dmBound) {
      searchInput._dmBound = true;
      searchInput.addEventListener('input', e => renderList(e.target.value || ''));
    }

    if (typeof updateDMBadge === 'function') updateDMBadge();
  } catch (err) {
    console.error('updateDMListSidebar error', err);
  }
}

window.updateDMListSidebar = updateDMListSidebar;

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

const avatarHtml = user.imageUrl
  ? `<img src="${escapeHtml(user.imageUrl)}" alt="avatar" class="profile-avatar-img">`
  : escapeHtml(initials);

card.innerHTML = `
  <div class="profile-avatar">${avatarHtml}</div>

  <div class="profile-info">
    <div class="profile-name">${escapeHtml(displayName)}</div>
    <div class="profile-status">@${escapeHtml(user.username)}</div>

    <div class="profile-details">
      <div class="profile-age">${escapeHtml(age)}</div>
      <div class="profile-bio">${escapeHtml(bio)}</div>
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
  <div id="selfProfileStories"></div>
  <div id="selfProfilePendingStories"></div>

  <button id="btnEditProfile" class="ghost">Edit Profile</button>
  <button id="logoutBtn" class="profile-logout ghost">Logout</button>
`;

  card.classList.add('logged-in');

  // Load stories after containers exist in the DOM
  loadSelfStories(user.username);
  loadSelfPendingStories(user.username);

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

async function loadSelfStories(username) {
  const res = await fetch("/api/story/list?username=" + encodeURIComponent(username));
  const data = await res.json();

  const box = document.getElementById("selfProfileStories");
  if (!box) return;

  box.innerHTML = "<h3>Stories</h3>";

  if (!data.stories || !data.stories.length) {
    box.innerHTML += "<div class='small muted'>No approved stories yet</div>";
    return;
  }

  data.stories.forEach(s => {
    // Approved stories are saved to both profiles (owner and partner)
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

async function loadSelfPendingStories(username) {
  const res = await fetch("/api/story/pending?username=" + encodeURIComponent(username));
  const data = await res.json();

  const box = document.getElementById("selfProfilePendingStories");
  if (!box) return;

  box.innerHTML = "<h3>Pending Approval</h3>";

  if (!data.stories || !data.stories.length) {
    box.innerHTML += "<div class='small muted'>No pending stories</div>";
    return;
  }

  data.stories.forEach(s => {
    // Pending stories appear on both profiles: the owner (approvalOwner)
    // can resend the request, the partner (approvalPartner) can approve it.
    const isOwner = s.owner === username;
    const other = isOwner ? s.partner : s.owner;
    const title = s.title || `Story with ${other}`;
    const div = document.createElement("div");
    div.className = "story-item pending";
    div.innerHTML = `
      <div><strong>${escapeHtml(title)}</strong></div>
      <div class="small">${escapeHtml(other)} — ${new Date(s.createdAt).toLocaleDateString()}</div>
      ${isOwner
        ? `<div class="tiny muted">Waiting for ${escapeHtml(s.partner)} to approve…</div>
           <button class="small-btn resendApproval" data-id="${s._id}">Resend Request</button>`
        : `<div class="tiny muted">${escapeHtml(s.owner)} is waiting for your approval…</div>
           <button class="small-btn approvePendingStory" data-id="${s._id}" data-title="${escapeHtml(title)}">Approve</button>`}
    `;
    box.appendChild(div);
  });

  box.querySelectorAll(".resendApproval").forEach(btn => {
    btn.onclick = async () => {
      const storyId = btn.dataset.id;
      const res = await fetch("/api/story/resend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storyId })
      });
      const result = await res.json();
      if (result.ok) alert("Approval request resent");
    };
  });

  box.querySelectorAll(".approvePendingStory").forEach(btn => {
    btn.onclick = async () => {
      const storyId = btn.dataset.id;
      const title = btn.dataset.title;
      const res = await fetch("/api/story/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storyId })
      });
      const result = await res.json();
      if (result.ok) {
        alert(`Story${title ? ` "${title}"` : ""} approved. It is now saved on both profiles.`);
        loadSelfPendingStories(username);
        loadSelfStories(username);
      } else {
        alert("Could not approve the story");
      }
    };
  });
}

// View-profile helpers (used by chat.js openUserProfile)
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
  return loadSelfPendingStories(username);
}

async function loadRelationships(username) {
  const res = await fetch("/api/relationship/list?username=" + encodeURIComponent(username));
  const data = await res.json();

  // Prefer view-profile container, fall back to self-profile card
  const box =
    document.getElementById("profileRelationships") ||
    document.getElementById("vpRelationships");
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
  const res = await fetch("/api/relationship/pending?username=" + encodeURIComponent(username));
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
      <strong>${escapeHtml(r.type)}</strong> with ${escapeHtml(r.target)}
      <div class="tiny muted">Waiting for ${escapeHtml(r.target)} to approve…</div>
    `;
    box.appendChild(div);
  });
}

async function loadRelationshipTimeline(username) {
  const res = await fetch("/api/relationship/timeline?username=" + encodeURIComponent(username));
  const data = await res.json();

  const box =
    document.getElementById("profileTimeline") ||
    document.getElementById("vpTimeline");
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

/* SESSION UI SYNC ---------------------------------------------------- */
window.updateUIForSession = function() {
  const user = getSession();
  updateProfileCard(user);
};

/* LOAD PROFILE ON PAGE LOAD ------------------------------------------ */
window.addEventListener('load', () => {
  // Prefer session storage; fall back to currentUser for legacy sessions
  const sessionUser = getSession();
  const legacyUser = JSON.parse(localStorage.getItem('currentUser') || 'null');
  const user = sessionUser || legacyUser;
  if (user && !sessionUser) setSession(user);
  updateProfileCard(user);
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


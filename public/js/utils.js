/* Use the shared direct-first image loader. If a browser blocks an ImgBB /
 * Discord image, image-proxy.js retries it once through the same-origin proxy.
 * Falls back to the raw URL if that helper has not loaded. */
function utilsImgSrc(value) {
  if (typeof window !== 'undefined' && typeof window.imgSrc === 'function') return window.imgSrc(value);
  return value == null ? '' : String(value);
}

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

function normalizeProfilePhotos(photos) {
  if (!Array.isArray(photos)) return [];

  const safeUrls = photos.map(photo => {
    try {
      const url = new URL(String(photo || '').trim());
      const isImgBB = url.hostname === 'ibb.co' || url.hostname.endsWith('.ibb.co');
      return url.protocol === 'https:' && isImgBB ? url.href : '';
    } catch (_) {
      return '';
    }
  }).filter(Boolean);

  return [...new Set(safeUrls)];
}

/*
 * Extra profile photos open in their own popup window instead of a new
 * browser tab. Passing window features (width/height) is what makes browsers
 * open a real popup window — window.open without features behaves exactly
 * like a target="_blank" link and opens a tab.
 */
function openProfilePhotoPopup(url) {
  const screen = window.screen || {};
  const width  = Math.max(320, Math.min(760, Math.round((screen.width  || 1024) * 0.6)));
  const height = Math.max(400, Math.min(960, Math.round((screen.height || 800) * 0.8)));
  const left   = Math.max(0, Math.round(((screen.width  || width)  - width)  / 2));
  const top    = Math.max(0, Math.round(((screen.height || height) - height) / 4));

  window.open(url, '_blank', [
    'popup=yes',
    `width=${width}`,
    `height=${height}`,
    `left=${left}`,
    `top=${top}`,
    'noopener',
    'noreferrer'
  ].join(','));
}

function renderProfilePhotoGallery(container, photos, emptyText = 'No extra photos yet') {
  if (!container) return;
  container.replaceChildren();

  const urls = normalizeProfilePhotos(photos);
  if (!urls.length) {
    const empty = document.createElement('div');
    empty.className = 'small muted profile-photo-empty';
    empty.textContent = emptyText;
    container.appendChild(empty);
    return;
  }

  urls.forEach((url, index) => {
    const link = document.createElement('a');
    link.className = 'profile-photo-tile';
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.setAttribute('aria-label', `Open profile photo ${index + 1}`);

    /* A plain click opens the photo in its own popup window. The tile stays
       a real link so middle-click, modified clicks and the context menu keep
       the browser's normal open-in-new-tab behaviour. */
    link.addEventListener('click', event => {
      if (event.defaultPrevented) return;
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      openProfilePhotoPopup(url);
    });

    const image = document.createElement('img');
    image.src = utilsImgSrc(url);
    image.alt = `Profile photo ${index + 1}`;
    image.loading = 'lazy';
    image.referrerPolicy = 'no-referrer';

    link.appendChild(image);
    container.appendChild(link);
  });
}

/*
 * Opening a DM should leave the user looking at the conversation, not at the
 * profile card or roster they launched it from. Those overlays sit at
 * z-index 9999 (above the DM window's 9500) and cover the whole screen on
 * mobile, so leaving them open makes it look like nothing happened.
 */
function closeUserBrowsingPopups() {
  ['modalViewProfile', 'modalRoster', 'dmSidebar', 'roomsSidebar'].forEach(id => {
    document.querySelectorAll(`[id="${id}"]`).forEach(el => {
      el.style.display = 'none';
    });
  });
}

window.closeUserBrowsingPopups = closeUserBrowsingPopups;

window.normalizeProfilePhotos = normalizeProfilePhotos;
window.renderProfilePhotoGallery = renderProfilePhotoGallery;
window.openProfilePhotoPopup = openProfilePhotoPopup;

const STORAGE_SESSION = 'cw_session_v1';
const STORAGE_PUBLIC  = 'cw_public_v1';
const STORAGE_DM_PREFIX = 'cw_dm_';
const STORAGE_DM_UNREAD = 'cw_dm_unread';

/* SESSION ------------------------------------------------------------ */
function setSession(user){ localStorage.setItem(STORAGE_SESSION, JSON.stringify(user)); }
function getSession(){ return JSON.parse(localStorage.getItem(STORAGE_SESSION) || 'null'); }
function clearSession(){ localStorage.removeItem(STORAGE_SESSION); }

function isAdministratorUser(user){
  return !!user && String(user.username || '').trim() === 'Administrator';
}

function updateAdminButtonVisibility(user = getSession()){
  const isAdmin = isAdministratorUser(user);
  document.querySelectorAll('[id="btnAdmin"]').forEach(btn => {
    btn.hidden = !isAdmin;
  });
  if (!isAdmin && typeof window !== 'undefined') window.adminSessionKey = null;
}

window.updateAdminButtonVisibility = updateAdminButtonVisibility;

function updateAccountSettingsButtonVisibility(user = getSession()){
  const visible = !!user;
  document.querySelectorAll('[id="btnAccountSettings"]').forEach(btn => {
    btn.style.display = visible ? '' : 'none';
    btn.hidden = !visible;
  });
}
window.updateAccountSettingsButtonVisibility = updateAccountSettingsButtonVisibility;

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
  // Fighter physique (height 3'5"–8'0" menu / weight in lbs) — only render
  // the parts the fighter has actually filled in.
  const physique = (window.physiqueSummary
    ? window.physiqueSummary(user.height, user.weight)
    : [user.height, user.weight ? user.weight + ' lbs' : ''].filter(Boolean).join(' • '));

const avatarHtml = user.imageUrl
  ? `<img src="${escapeHtml(utilsImgSrc(user.imageUrl))}" alt="avatar" class="profile-avatar-img">`
  : escapeHtml(initials);

card.innerHTML = `
  <div class="profile-avatar">${avatarHtml}</div>

  <div class="profile-info">
    <div class="profile-name">${escapeHtml(displayName)}</div>
    <div class="profile-status">@${escapeHtml(user.username)}</div>

    <div class="profile-details">
      <div class="profile-age">${escapeHtml(age)}</div>
      ${physique ? `<div class="profile-physique">${escapeHtml(physique)}</div>` : ''}
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
  <section class="self-profile-photos">
    <h3>Photos</h3>
    <div id="selfProfilePhotos" class="profile-photo-grid"></div>
  </section>
  <div id="selfProfileStories"></div>
  <div id="selfProfilePendingStories"></div>

  <button id="btnEditProfile" class="ghost">Edit Profile</button>
  <button id="btnAccountSettings" class="ghost">⚙️ Account Settings</button>
  <button id="logoutBtn" class="profile-logout ghost">Logout</button>
`;

  card.classList.add('logged-in');

  renderProfilePhotoGallery(
    document.getElementById('selfProfilePhotos'),
    user.extraPhotos,
    'Upload extra photos from Edit Profile'
  );

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

  /* Attach Account Settings Listener -------------------------------- */
  const acctBtn = document.getElementById('btnAccountSettings');
  if (acctBtn) {
    acctBtn.addEventListener('click', () => {
      const u = getSession();
      if (!u) return;
      if (window.openAccountSettingsModal) {
        window.openAccountSettingsModal();
      } else {
        const modal = document.getElementById('modalAccountSettings');
        if (modal) show(modal);
      }
    });
  }

};

/* Clip (GIF / short video) helpers ----------------------------------------
   Shared by chat.js (rooms), pm.js (DMs + story popup) and the story viewer.
   Clips are uploaded to /api/upload-clip, stored on the server and served
   back from the same-origin /clips route, so no proxy rewriting is needed.
------------------------------------------------------------------------ */
const CLIP_MIME_TYPES = new Set(["image/gif", "video/mp4", "video/webm"]);
window.CLIP_MIME_TYPES = CLIP_MIME_TYPES;

function isClipFile(file) {
  return !!file && (CLIP_MIME_TYPES.has(file.type) || /\.gif$/i.test(file.name || ""));
}
window.isClipFile = isClipFile;

async function uploadClipToServer(file) {
  const form = new FormData();
  form.append("clip", file); // MUST be "clip" to match multer on the server

  const res = await fetch("/api/upload-clip", {
    method: "POST",
    body: form
  });

  return await res.json(); // { ok, clipUrl, clipType, size } | { ok: false, error }
}
window.uploadClipToServer = uploadClipToServer;

// Build the DOM node for a stored clip: <img> for GIFs, <video> for clips.
function createClipElement(clipUrl, clipType) {
  const isGif = clipType === "gif";
  const el = isGif ? document.createElement("img") : document.createElement("video");
  el.src = clipUrl;
  el.className = "chat-clip";
  if (isGif) {
    el.alt = "GIF clip";
  } else {
    el.controls = true;
    el.playsInline = true;
    el.preload = "metadata";
  }
  return el;
}
window.createClipElement = createClipElement;

/* Story viewer popup -----------------------------------------------------
   The viewer itself lives in public/js/story-ui.js, which every client loads:
   it renders the light story markup, scrolls long stories (the old box had
   overflow-y:hidden, so anything longer than the screen was unreachable),
   pages between stories, and can copy a permalink or export the text.
------------------------------------------------------------------------ */
function openStoryViewer(title, storyText, clipUrl, clipType) {
  if (window.StoryUI) return window.StoryUI.openViewer(title, storyText, clipUrl, clipType);

  // Last-resort fallback if story-ui.js did not load.
  alert(`${title || "Story"}\n\n${storyText || ""}`);
}
window.openStoryViewer = openStoryViewer;

async function loadSelfStories(username) {
  const res = await fetch("/api/story/list?username=" + encodeURIComponent(username));
  const data = await res.json();

  const box = document.getElementById("selfProfileStories");
  if (!box) return;

  box.innerHTML = "<h3>Stories</h3>";

  const stories = (data && data.stories) || [];
  const holder = document.createElement("div");
  box.appendChild(holder);

  if (!window.StoryUI) {
    holder.innerHTML = stories.length
      ? stories.map(s => `<div class="small">${escapeHtml(s.title || "Untitled story")}</div>`).join("")
      : "<div class='small muted'>No approved stories yet</div>";
    return;
  }

  // Rows carry the actions the viewer is allowed: your own stories can be
  // opened, linked, edited (which re-opens approval) or deleted.
  window.StoryUI.setReadingList(stories);
  window.StoryUI.renderStoryList(holder, stories, {
    username,
    emptyText: "No approved stories yet",
    onChange: () => loadSelfStories(username)
  });
}

async function loadSelfPendingStories(username) {
  const res = await fetch("/api/story/pending?username=" + encodeURIComponent(username));
  const data = await res.json();

  const box = document.getElementById("selfProfilePendingStories");
  if (!box) return;

  box.innerHTML = "<h3>Pending Approval</h3>";

  const stories = (data && data.stories) || [];
  const declined = (data && data.declined) || [];
  const holder = document.createElement("div");
  box.appendChild(holder);

  if (!window.StoryUI) {
    holder.innerHTML = stories.length
      ? stories.map(s => `<div class="small">${escapeHtml(s.title || "Untitled story")}</div>`).join("")
      : "<div class='small muted'>No pending stories</div>";
    return;
  }

  // Waiting stories offer Approve / Decline to the partner and Resend / Edit /
  // Withdraw to the author; refused stories stay visible to their author with
  // the reason and a "Revise & resubmit" button.
  window.StoryUI.renderPendingList(holder, {
    username,
    stories,
    declined,
    onChange: () => {
      loadSelfPendingStories(username);
      loadSelfStories(username);
    }
  });
}

// View-profile helpers (used by chat.js openUserProfile)
async function loadStories(username) {
  const res = await fetch("/api/story/list?username=" + encodeURIComponent(username));
  const data = await res.json();

  const box = document.getElementById("profileStories");
  if (!box) return;

  box.innerHTML = "";

  const stories = (data && data.stories) || [];
  const holder = document.createElement("div");
  box.appendChild(holder);

  if (!window.StoryUI) {
    holder.innerHTML = stories.length
      ? stories.map(s => `<div class="small">${escapeHtml(s.title || "Untitled story")}</div>`).join("")
      : "<div class='small muted'>No approved stories yet</div>";
    return;
  }

  window.StoryUI.setReadingList(stories);
  window.StoryUI.renderStoryList(holder, stories, {
    username,
    emptyText: "No approved stories yet",
    onChange: () => loadStories(username)
  });
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
// Kept for callers written against the old profile API.
window.loadPendingStories = loadSelfPendingStories;
window.loadRelationships = loadRelationships;
window.loadPendingRelationships = loadPendingRelationships;
window.loadRelationshipTimeline = loadRelationshipTimeline;

/* SESSION UI SYNC ---------------------------------------------------- */
window.updateUIForSession = function() {
  const user = getSession();
  updateProfileCard(user);
  updateAdminButtonVisibility(user);
  if (typeof updateAccountSettingsButtonVisibility === 'function') updateAccountSettingsButtonVisibility(user);
};

/* LOAD PROFILE ON PAGE LOAD ------------------------------------------ */
window.addEventListener('load', () => {
  // Prefer session storage; fall back to currentUser for legacy sessions
  const sessionUser = getSession();
  const legacyUser = JSON.parse(localStorage.getItem('currentUser') || 'null');
  const user = sessionUser || legacyUser;
  if (user && !sessionUser) setSession(user);
  updateProfileCard(user);
  updateAdminButtonVisibility(user);
  if (typeof updateAccountSettingsButtonVisibility === 'function') updateAccountSettingsButtonVisibility(user);
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


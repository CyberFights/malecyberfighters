/* =========================================================================
   mobile.js — client for /public/mobile.html
   Everything is scoped inside one IIFE in strict mode so typos surface
   instead of silently creating globals.

   Endpoints used (all of them exist in index.js):
     POST /api/login                POST /api/register
     POST /api/check-availability   POST /api/upload-image
     POST /api/update-profile       GET  /api/public-messages
     GET  /api/allUsers             GET  /api/admin/users
     POST /api/dm/history           POST /api/dm/partners
     POST /api/dm/clear             POST /api/send-dm
     POST /api/block-user           POST /api/unblock-user
     GET  /api/story/list           POST /api/story/load
     POST /api/story/save           POST /api/story/approve
     GET  /api/relationship/list    GET  /api/relationship/timeline
     POST /api/relationship/request POST /api/relationship/approve
   ========================================================================= */

(function () {
  "use strict";

  /* ---------------------------------------------------------------------
     DOM helpers
     --------------------------------------------------------------------- */
  const $ = id => document.getElementById(id);

  function show(el) {
    if (!el) return;
    el.style.display = el.dataset.display || "flex";
    el.style.visibility = "visible";
    el.style.pointerEvents = "auto";
  }

  function hide(el) {
    if (!el) return;
    el.style.display = "none";
    el.style.visibility = "hidden";
    el.style.pointerEvents = "none";
  }

  function on(el, ev, fn) {
    if (!el) return;
    el.addEventListener(ev, fn);
  }

  function showId(id) { show($(id)); }
  function hideId(id) { hide($(id)); }

  function escapeHtml(value) {
    if (value === null || value === undefined) return "";
    return String(value).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[c]);
  }

  function debounce(fn, wait = 250) {
    let t;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), wait);
    };
  }

  function timeLabel(value) {
    const d = value ? new Date(value) : new Date();
    return isNaN(d.getTime()) ? "" : d.toLocaleTimeString();
  }

  function initials(name) {
    return String(name || "U").trim().charAt(0).toUpperCase() || "U";
  }

  function avatarHtml(user, size = 36) {
    const name = user && (user.display || user.username || user.from);
    if (user && user.imageUrl) {
      return `<img src="${escapeHtml(user.imageUrl)}" alt="${escapeHtml(name)}"
              style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover">`;
    }
    return `<div class="avatar-fallback" style="width:${size}px;height:${size}px;border-radius:50%">${escapeHtml(initials(name))}</div>`;
  }

  /* ---------------------------------------------------------------------
     Network helpers
     --------------------------------------------------------------------- */
  async function getJSON(url) {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    const data = await res.json().catch(() => null);
    if (!data) throw new Error("bad_response");
    return data;
  }

  async function postJSON(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    });
    const data = await res.json().catch(() => null);
    if (!data) throw new Error("bad_response");
    return data;
  }

  async function uploadImage(file) {
    if (!file) return null;
    const form = new FormData();
    // must be "image": server uses multer.single('image')
    form.append("image", file);
    const res = await fetch("/api/upload-image", { method: "POST", body: form });
    const data = await res.json().catch(() => null);
    if (!data || !data.ok) return null;
    return data.imageUrl || null;
  }

  /* ---------------------------------------------------------------------
     Session
     --------------------------------------------------------------------- */
  const SESSION_KEY = "cw_session_v1";

  function getSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function setSession(user) {
    if (!user) {
      localStorage.removeItem(SESSION_KEY);
      localStorage.removeItem("currentUser");
      return;
    }
    localStorage.setItem(SESSION_KEY, JSON.stringify(user));
    localStorage.setItem("currentUser", JSON.stringify(user));
  }

  function statOf(user, key) {
    if (!user) return 0;
    if (user.stats && user.stats[key] != null) return Number(user.stats[key]) || 0;
    if (user[key] != null) return Number(user[key]) || 0;
    return 0;
  }

  /* ---------------------------------------------------------------------
     Shared state
     --------------------------------------------------------------------- */
  const state = {
    ageGatePassed: false,
    socket: null,
    onlineUsers: [],      // presence feed (online only)
    allUsers: [],         // /api/allUsers cache
    rooms: [],
    rosterPage: 1,
    rosterPerPage: 10,
    dmPartner: null,
    dmUnread: {},         // username -> count
    legalLoaded: {}
  };

  const ROSTER_ENDPOINT = "/api/allUsers";

  function directoryUser(username) {
    if (!username) return null;
    return state.allUsers.find(u => u.username === username) ||
           state.onlineUsers.find(u => u.username === username) ||
           null;
  }

  function isOnline(username) {
    return state.onlineUsers.some(u => u.username === username);
  }

  /* ---------------------------------------------------------------------
     Screen / visibility management
     --------------------------------------------------------------------- */
  function showAuthScreen() {
    const auth = $("authScreen");
    if (auth) {
      auth.dataset.display = "flex";
      show(auth);
    }
    hide($("mainUI"));
  }

  function showMainUI() {
    hide($("ageGate"));
    hide($("authScreen"));
    const main = $("mainUI");
    if (main) {
      main.dataset.display = "block";
      show(main);
    }
  }

  function ensureStartupVisibility() {
    const ageGate = $("ageGate");
    const auth = $("authScreen");
    const main = $("mainUI");

    if (auth) auth.dataset.display = "flex";
    if (main) main.dataset.display = "block";

    if (state.ageGatePassed) {
      hide(ageGate);
      if (getSession()) showMainUI();
      else showAuthScreen();
      return;
    }

    if (ageGate) {
      ageGate.dataset.display = "flex";
      show(ageGate);
    }
    hide(auth);
    hide(main);
  }

  function confirmAgeAndProceed() {
    state.ageGatePassed = true;

    const ageGate = $("ageGate");
    const introGif = $("introGif");

    if (ageGate) {
      ageGate.style.transition = "opacity .4s";
      ageGate.style.opacity = "0";
      setTimeout(() => hide(ageGate), 420);
    }

    if (introGif) {
      introGif.style.display = "block";
      introGif.style.opacity = "1";
      setTimeout(() => {
        introGif.style.opacity = "0";
        setTimeout(() => { introGif.style.display = "none"; }, 700);
      }, 2500);
    }

    setTimeout(() => {
      if (getSession()) enterApp();
      else showAuthScreen();
    }, 450);
  }

  function enterApp() {
    const s = getSession();
    if (!s) {
      showAuthScreen();
      return;
    }
    showMainUI();

    const label = $("chatUserLabel");
    if (label) label.textContent = s.display || s.username;

    const nameEl = $("meName");
    if (nameEl) nameEl.textContent = s.display || s.username;
    const handleEl = $("meHandle");
    if (handleEl) handleEl.textContent = "@" + s.username;
    const meAvatar = $("meAvatar");
    if (meAvatar) meAvatar.innerHTML = avatarHtml(s, 48);

    initSocket();
    loadAllUsers();
    loadPublicMessages();
    updateDmSidebar();
  }

  /* ---------------------------------------------------------------------
     Socket.IO
     --------------------------------------------------------------------- */
  function initSocket() {
    if (state.socket) {
      socketLogin();
      return;
    }
    if (typeof io === "undefined") {
      console.warn("socket.io client not loaded — realtime features disabled");
      return;
    }

    const socket = io({ path: "/socket.io", transports: ["websocket", "polling"] });
    state.socket = socket;

    socket.on("connect", socketLogin);

    socket.on("connect_error", err => {
      console.warn("socket connect_error:", err && err.message);
    });

    /* presence -------------------------------------------------------- */
    socket.on("presence", users => {
      state.onlineUsers = Array.isArray(users) ? users : [];
      mergeIntoDirectory(state.onlineUsers);
      renderOnlineList();
      renderRoster();
    });

    /* public chat ----------------------------------------------------- */
    socket.on("publicMessage", msg => {
      const s = getSession();
      if (s && msg && msg.from === s.username) return; // already rendered locally
      appendPublicMessage(msg);
    });
    socket.on("externalPublicMessage", msg => appendPublicMessage(msg));

    /* direct messages -------------------------------------------------- */
    socket.on("privateMessage", pm => {
      const s = getSession();
      if (!s || !pm) return;
      const other = pm.from === s.username ? pm.to : pm.from;
      if (state.dmPartner && other === state.dmPartner) {
        appendDmMessage(pm);
      } else if (pm.from !== s.username) {
        state.dmUnread[pm.from] = (state.dmUnread[pm.from] || 0) + 1;
        renderDmBadge();
        updateDmSidebar();
      }
    });

    socket.on("typingDM", ({ from }) => {
      if (state.dmPartner && from === state.dmPartner) {
        const el = $("dmTyping");
        if (el) { el.textContent = `${from} is typing...`; el.style.display = "block"; }
      }
    });

    socket.on("stopTypingDM", ({ from }) => {
      if (state.dmPartner && from === state.dmPartner) {
        const el = $("dmTyping");
        if (el) el.style.display = "none";
      }
    });

    /* rooms ------------------------------------------------------------ */
    socket.on("roomsList", rooms => {
      state.rooms = Array.isArray(rooms) ? rooms : [];
      renderRoomsSidebar();
    });

    // server emits { room, history }
    socket.on("roomHistory", payload => {
      const feed = $("roomFeed");
      if (!feed) return;
      const current = $("roomChatPopup") ? $("roomChatPopup").dataset.room : null;
      const room = payload && payload.room;
      if (room && current && String(room) !== String(current)) return;
      feed.innerHTML = "";
      const history = (payload && payload.history) || [];
      history.forEach(appendRoomMessage);
    });

    socket.on("roomMessage", msg => {
      const popup = $("roomChatPopup");
      const current = popup ? popup.dataset.room : null;
      if (!msg || (msg.room && current && String(msg.room) !== String(current))) return;
      appendRoomMessage(msg);
    });

    socket.on("roomMembers", members => renderRoomMembers(members));

    socket.on("roomInvited", ({ roomName }) => {
      alert(`You have been invited to the private room: ${roomName}`);
    });

    socket.on("typingRoom", ({ from, room }) => {
      const popup = $("roomChatPopup");
      if (!popup || String(popup.dataset.room) !== String(room)) return;
      const el = $("roomTyping");
      if (el) { el.textContent = `${from} is typing...`; el.style.display = "block"; }
    });

    socket.on("stopTypingRoom", ({ room }) => {
      const popup = $("roomChatPopup");
      if (!popup || String(popup.dataset.room) !== String(room)) return;
      const el = $("roomTyping");
      if (el) el.style.display = "none";
    });

    /* approvals -------------------------------------------------------- */
    socket.on("storyApprovalRequest", async ({ storyId, from }) => {
      if (!storyId) return;
      if (!confirm(`${from} created a story involving your messages. Approve it?`)) return;
      try {
        await postJSON("/api/story/approve", { storyId });
        alert("Story approved.");
      } catch (e) {
        alert("Could not approve the story right now.");
      }
    });

    socket.on("relationshipApprovalRequest", async ({ relationshipId, from, type }) => {
      if (!relationshipId) return;
      if (!confirm(`${from} wants to add a relationship: ${type}. Approve?`)) return;
      try {
        await postJSON("/api/relationship/approve", { relationshipId });
        alert("Relationship approved.");
      } catch (e) {
        alert("Could not approve the relationship right now.");
      }
    });
  }

  function socketLogin() {
    const s = getSession();
    if (state.socket && s) state.socket.emit("login", s);
  }

  function mergeIntoDirectory(users) {
    (users || []).forEach(u => {
      if (!u || !u.username) return;
      const idx = state.allUsers.findIndex(x => x.username === u.username);
      if (idx === -1) state.allUsers.push(u);
      else state.allUsers[idx] = Object.assign({}, state.allUsers[idx], u);
    });
  }

  /* ---------------------------------------------------------------------
     Auth: login / register / logout
     --------------------------------------------------------------------- */
  function setError(el, message) {
    if (!el) return;
    if (!message) {
      el.textContent = "";
      el.style.display = "none";
      return;
    }
    el.textContent = message;
    el.style.display = "block";
  }

  async function handleLogin() {
    const errEl = $("loginError");
    setError(errEl, "");

    const username = ($("loginUser") && $("loginUser").value || "").trim();
    const password = ($("loginPass") && $("loginPass").value) || "";

    if (!username || !password) {
      setError(errEl, "Enter username and password");
      return;
    }

    try {
      const data = await postJSON("/api/login", { username, password });
      if (!data.ok) {
        setError(errEl, data.error === "banned" ? "You are banned." : "Invalid credentials");
        return;
      }

      setSession(data.user);
      hideId("modalLogin");
      $("loginUser").value = "";
      $("loginPass").value = "";
      enterApp();
    } catch (e) {
      setError(errEl, "Network error during login");
    }
  }

  async function handleRegister() {
    const errEl = $("regError");
    setError(errEl, "");

    const username = ($("regUser") && $("regUser").value || "").trim();
    const email = ($("regEmail") && $("regEmail").value || "").trim();
    const password = ($("regPass") && $("regPass").value) || "";
    const display = ($("regDisplay") && $("regDisplay").value || "").trim() || username;
    const age = Number(($("regAge") && $("regAge").value) || 0);

    if (!username || !email || !password) {
      setError(errEl, "Username, email and password are required");
      return;
    }
    if (age && age < 13) {
      setError(errEl, "You must be at least 13 to register");
      return;
    }

    const submitBtn = $("regSubmit");
    if (submitBtn) submitBtn.disabled = true;

    try {
      const avail = await postJSON("/api/check-availability", { username, email });
      if (!avail.ok) {
        const msgs = [];
        if (avail.conflict && avail.conflict.username) msgs.push("username taken");
        if (avail.conflict && avail.conflict.email) msgs.push("email in use");
        setError(errEl, msgs.join(", ") || "Username or email unavailable");
        return;
      }

      // upload the picked image if the user did not press "Upload Image"
      const fileInput = $("regImageFile");
      if (!registerImageUrl && fileInput && fileInput.files && fileInput.files[0]) {
        const status = $("uploadStatus");
        if (status) status.textContent = "Uploading image...";
        registerImageUrl = await uploadImage(fileInput.files[0]) || "";
        if (status) status.textContent = registerImageUrl ? "Uploaded" : "Upload failed";
      }

      const payload = {
        username,
        email,
        password,
        display,
        age: age || undefined,
        stats: {
          wins: Number(($("regWins") && $("regWins").value) || 0),
          losses: Number(($("regLosses") && $("regLosses").value) || 0)
        },
        info: ($("regInfo") && $("regInfo").value || "").trim(),
        color: ($("regColor") && $("regColor").value) || "",
        language: ($("regLanguage") && $("regLanguage").value) || "en",
        imageUrl: registerImageUrl || ""
      };

      const data = await postJSON("/api/register", payload);

      if (!data.ok) {
        if (data.conflict) {
          const msgs = [];
          if (data.conflict.username) msgs.push("username taken");
          if (data.conflict.email) msgs.push("email in use");
          setError(errEl, msgs.join(", ") || "Registration failed");
        } else {
          setError(errEl, data.error || "Registration failed");
        }
        return;
      }

      registerImageUrl = "";
      hideId("modalRegister");
      alert("Account created. Please log in.");
      showId("modalLogin");
    } catch (e) {
      setError(errEl, "Network error during registration");
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  }

  let registerImageUrl = "";

  function logout() {
    const s = getSession();
    if (state.socket && s) {
      try { state.socket.emit("forceLogout", { username: s.username }); } catch (e) {}
    }
    setSession(null);
    state.dmPartner = null;
    state.dmUnread = {};
    hide($("mainUI"));
    hide($("chatPopup"));
    hide($("dmPopup"));
    hide($("dmSidebar"));
    hide($("roomsSidebar"));
    hide($("roomChatPopup"));
    showAuthScreen();
  }

  /* ---------------------------------------------------------------------
     Public (arena) chat
     --------------------------------------------------------------------- */
  async function loadPublicMessages() {
    const feed = $("publicFeed");
    if (!feed) return;
    try {
      const data = await getJSON("/api/public-messages");
      if (!data.ok) return;
      feed.innerHTML = "";
      (data.messages || []).forEach(appendPublicMessage);
    } catch (e) {
      // keep whatever is on screen
    }
  }

  function appendPublicMessage(msg) {
    const feed = $("publicFeed");
    if (!feed || !msg) return;

    const s = getSession();
    const author = directoryUser(msg.from) || {};
    const isMe = !!(s && msg.from === s.username);
    const avatarSource = msg.avatar || msg.imageUrl
      ? { imageUrl: msg.avatar || msg.imageUrl, display: msg.display || msg.from }
      : { imageUrl: author.imageUrl, display: msg.display || msg.from };

    const row = document.createElement("div");
    row.className = "message-row" + (isMe ? " me" : "");
    row.innerHTML = `
      <div class="message-avatar">${avatarHtml(avatarSource)}</div>
      <div class="message">
        <div class="message-meta" style="color:${escapeHtml(msg.color || author.color || "#7fd8ff")}">
          ${escapeHtml(msg.display || msg.from)}
          <span class="small muted">@${escapeHtml(msg.from)} • ${escapeHtml(timeLabel(msg.time))}</span>
        </div>
        <div>${escapeHtml(msg.text || "")}</div>
      </div>
    `;
    feed.appendChild(row);
    feed.scrollTop = feed.scrollHeight;
  }

  function sendPublicMessage() {
    const input = $("publicMessage");
    if (!input) return;

    const text = input.value.trim();
    if (!text) return;

    const s = getSession();
    if (!s) {
      alert("You must be logged in to send messages.");
      return;
    }

    const msg = {
      from: s.username,
      display: s.display || s.username,
      text,
      time: new Date().toISOString()
    };

    if (state.socket) {
      state.socket.emit("publicMessage", msg);
      appendPublicMessage(msg); // instant local echo
    } else {
      alert("Not connected to the arena. Please reload the page.");
      return;
    }

    input.value = "";
  }

  function openArenaChat() {
    const s = getSession();
    if (!s) return;
    showId("chatPopup");
    socketLogin();          // re-announce presence (chat may have been closed before)
    loadPublicMessages();
    renderOnlineList();
  }

  function closeArenaChat() {
    const s = getSession();
    if (state.socket && s) state.socket.emit("chatClosed", { username: s.username });
    hideId("chatPopup");
  }

  /* ---------------------------------------------------------------------
     Online list
     --------------------------------------------------------------------- */
  function renderOnlineList() {
    const el = $("onlineList");
    if (!el) return;

    el.innerHTML = "";
    if (!state.onlineUsers.length) {
      el.innerHTML = '<div class="small muted">Nobody else is online.</div>';
      return;
    }

    state.onlineUsers.forEach(u => {
      const row = document.createElement("div");
      row.className = "user-row";
      row.innerHTML = `
        ${avatarHtml(u)}
        <div style="flex:1;min-width:0">
          <div class="ellipsis" style="font-weight:700">${escapeHtml(u.display || u.username)}</div>
          <div class="small muted ellipsis">@${escapeHtml(u.username)}</div>
        </div>
        <span class="status-dot online" title="online"></span>
      `;
      row.addEventListener("click", () => openProfile(u.username));
      el.appendChild(row);
    });
  }

  /* ---------------------------------------------------------------------
     Roster
     --------------------------------------------------------------------- */
  async function loadAllUsers() {
    try {
      const data = await getJSON(ROSTER_ENDPOINT);
      if (data && (data.success || data.ok) && Array.isArray(data.users)) {
        state.allUsers = data.users;
        mergeIntoDirectory(state.onlineUsers);
      }
    } catch (e) {
      // keep cache
    }
    renderRoster();
  }

  function filteredRoster() {
    const search = (($("rosterSearch") && $("rosterSearch").value) || "").trim().toLowerCase();

    const users = [...state.allUsers].sort((a, b) => {
      const ta = a && a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b && b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return tb - ta;
    });

    if (!search) return users;
    return users.filter(u =>
      String(u.username || "").toLowerCase().includes(search) ||
      String(u.display || "").toLowerCase().includes(search)
    );
  }

  function renderRoster() {
    const list = $("rosterList");
    if (!list) return;

    const filtered = filteredRoster();
    const totalPages = Math.max(1, Math.ceil(filtered.length / state.rosterPerPage));

    if (state.rosterPage < 1) state.rosterPage = 1;
    if (state.rosterPage > totalPages) state.rosterPage = totalPages;

    const start = (state.rosterPage - 1) * state.rosterPerPage;
    const pageItems = filtered.slice(start, start + state.rosterPerPage);

    list.innerHTML = "";

    if (!pageItems.length) {
      list.innerHTML = '<div class="small muted" style="padding:12px">No users found.</div>';
    }

    pageItems.forEach(u => {
      const row = document.createElement("div");
      row.className = "roster-user";
      row.dataset.username = u.username || "";
      row.innerHTML = `
        ${avatarHtml(u, 48)}
        <div style="flex:1;min-width:0">
          <div class="roster-name ellipsis">${escapeHtml(u.display || u.username)}</div>
          <div class="roster-username ellipsis">@${escapeHtml(u.username)}</div>
        </div>
        <div class="roster-actions">
          <button type="button" class="small-btn roster-msg-btn" data-user="${escapeHtml(u.username)}">Message</button>
          <button type="button" class="small-btn secondary roster-view-btn" data-user="${escapeHtml(u.username)}">View</button>
        </div>
      `;
      list.appendChild(row);
    });

    const label = $("rosterPageNumber");
    if (label) label.textContent = `Page ${state.rosterPage} / ${totalPages}`;

    const prev = $("rosterPrev");
    if (prev) prev.disabled = state.rosterPage <= 1;
    const next = $("rosterNext");
    if (next) next.disabled = state.rosterPage >= totalPages;
  }

  function bindRosterDelegation() {
    const list = $("rosterList");
    if (!list) return;

    list.addEventListener("click", e => {
      const btn = e.target.closest("button[data-user]");
      if (btn) {
        const username = btn.dataset.user;
        if (!username) return;
        if (btn.classList.contains("roster-msg-btn")) openDm(username);
        else openProfile(username);
        return;
      }

      const row = e.target.closest(".roster-user");
      if (row && row.dataset.username) openProfile(row.dataset.username);
    });
  }

  function openRoster() {
    showId("modalRoster");
    state.rosterPage = 1;
    const search = $("rosterSearch");
    if (search) search.value = "";
    loadAllUsers();
  }

  /* ---------------------------------------------------------------------
     View profile
     --------------------------------------------------------------------- */
  async function openProfile(username) {
    if (!username) return;

    let user = directoryUser(username);
    if (!user) {
      await loadAllUsers();
      user = directoryUser(username);
    }
    if (!user) {
      alert("Profile not found.");
      return;
    }

    const modal = $("modalViewProfile");
    if (modal) modal.dataset.username = user.username;

    const set = (id, value) => { const el = $(id); if (el) el.textContent = value; };

    set("vpName", user.display || user.username);
    set("vpUsername", user.username);
    set("vpBio", user.info || "No bio yet.");
    set("vpWins", String(statOf(user, "wins")));
    set("vpLosses", String(statOf(user, "losses")));
    set("vpLang", user.language || "—");
    set("vpAge", user.age != null ? String(user.age) : "—");

    const vpAvatar = $("vpAvatar");
    if (vpAvatar) vpAvatar.innerHTML = avatarHtml(user, 96);

    const colorBox = $("vpColorBox");
    if (colorBox) colorBox.style.background = user.color || "transparent";

    const me = getSession();
    const isSelf = !!(me && me.username === user.username);
    const dmBtn = $("vpDMButton");
    if (dmBtn) dmBtn.style.display = isSelf ? "none" : "";
    const blockBtn = $("vpBlockButton");
    if (blockBtn) blockBtn.style.display = isSelf ? "none" : "";
    const relSection = $("vpRelationshipSection");
    if (relSection) relSection.style.display = isSelf ? "none" : "";

    showId("modalViewProfile");

    loadProfileStories(user.username);
    loadProfileRelationships(user.username);
    loadProfileTimeline(user.username);
  }

  async function loadProfileStories(username) {
    const el = $("profileStories");
    if (!el) return;
    el.innerHTML = '<div class="small muted">Loading…</div>';
    try {
      const data = await getJSON("/api/story/list?username=" + encodeURIComponent(username));
      const stories = (data && data.stories) || [];
      if (!stories.length) {
        el.innerHTML = '<div class="small muted">No stories yet.</div>';
        return;
      }
      el.innerHTML = stories.map(s => `
        <div class="timeline-item">
          <div class="timeline-date">${escapeHtml(new Date(s.createdAt).toLocaleDateString())} • with @${escapeHtml(s.partner)}</div>
          <div class="timeline-desc">${escapeHtml(String(s.story).slice(0, 400))}</div>
        </div>
      `).join("");
    } catch (e) {
      el.innerHTML = '<div class="small muted">Could not load stories.</div>';
    }
  }

  async function loadProfileRelationships(username) {
    const el = $("profileRelationships");
    if (!el) return;
    el.innerHTML = '<div class="small muted">Loading…</div>';
    try {
      const data = await getJSON("/api/relationship/list?username=" + encodeURIComponent(username));
      const rels = (data && data.relationships) || [];
      if (!rels.length) {
        el.innerHTML = '<div class="small muted">No relationships yet.</div>';
        return;
      }
      el.innerHTML = rels.map(r => {
        const other = r.requester === username ? r.target : r.requester;
        return `<div class="timeline-item rel-${escapeHtml(r.type)}">
                  <div class="timeline-desc">${escapeHtml(r.type)} — @${escapeHtml(other)}</div>
                </div>`;
      }).join("");
    } catch (e) {
      el.innerHTML = '<div class="small muted">Could not load relationships.</div>';
    }
  }

  async function loadProfileTimeline(username) {
    const el = $("profileTimeline");
    if (!el) return;
    el.innerHTML = '<div class="small muted">Loading…</div>';
    try {
      const data = await getJSON("/api/relationship/timeline?username=" + encodeURIComponent(username));
      const timeline = (data && data.timeline) || [];
      if (!timeline.length) {
        el.innerHTML = '<div class="small muted">Nothing on the timeline yet.</div>';
        return;
      }
      el.innerHTML = timeline.map(t => `
        <div class="timeline-item rel-${escapeHtml(t.type)}">
          <div class="timeline-date">${escapeHtml(new Date(t.approvedAt).toLocaleDateString())}</div>
          <div class="timeline-desc">${escapeHtml(t.type)} with @${escapeHtml(t.with)}</div>
        </div>
      `).join("");
    } catch (e) {
      el.innerHTML = '<div class="small muted">Could not load the timeline.</div>';
    }
  }

  async function blockCurrentProfile() {
    const me = getSession();
    const modal = $("modalViewProfile");
    const target = modal && modal.dataset.username;
    if (!me) return alert("Please log in first.");
    if (!target) return;
    if (!confirm(`Block ${target}? They will no longer be able to DM you.`)) return;

    try {
      const data = await postJSON("/api/block-user", { username: me.username, target });
      if (!data.ok) return alert("Failed to block user.");
      alert(`${target} blocked.`);
      hideId("modalViewProfile");
    } catch (e) {
      alert("Network error while blocking user.");
    }
  }

  async function sendRelationshipRequest() {
    const me = getSession();
    const modal = $("modalViewProfile");
    const target = modal && modal.dataset.username;
    const select = $("vpRelationshipSelect");
    const type = select && select.value;

    if (!me) return alert("Please log in first.");
    if (!target || !type) return alert("Pick a relationship type first.");

    try {
      const data = await postJSON("/api/relationship/request", {
        requester: me.username, target, type
      });
      if (!data.ok) return alert("Could not send the request.");
      alert("Relationship request sent.");
      select.value = "";
    } catch (e) {
      alert("Network error while sending the request.");
    }
  }

  /* ---------------------------------------------------------------------
     Edit profile
     --------------------------------------------------------------------- */
  let editImageUrl = "";

  function openEditProfile() {
    const s = getSession();
    if (!s) return alert("Please log in first.");

    const user = directoryUser(s.username) || s;

    const setVal = (id, value) => { const el = $(id); if (el) el.value = value; };
    setVal("editDisplay", user.display || user.username);
    setVal("editAge", user.age || "");
    setVal("editInfo", user.info || "");
    setVal("editColor", user.color || "#38bdf8");
    setVal("editLanguage", user.language || "en");
    setVal("editWins", statOf(user, "wins"));
    setVal("editLosses", statOf(user, "losses"));

    editImageUrl = user.imageUrl || "";
    const status = $("editUploadStatus");
    if (status) status.textContent = editImageUrl ? "Current image kept" : "No image uploaded";

    setError($("editError"), "");
    showId("modalEditProfile");
  }

  async function saveProfile() {
    const s = getSession();
    if (!s) return;

    const errEl = $("editError");
    setError(errEl, "");

    const updates = {
      display: ($("editDisplay") && $("editDisplay").value || "").trim(),
      age: Number(($("editAge") && $("editAge").value) || 0) || undefined,
      info: ($("editInfo") && $("editInfo").value || "").trim(),
      color: ($("editColor") && $("editColor").value) || "",
      language: ($("editLanguage") && $("editLanguage").value) || "en",
      stats: {
        wins: Number(($("editWins") && $("editWins").value) || 0),
        losses: Number(($("editLosses") && $("editLosses").value) || 0)
      },
      imageUrl: editImageUrl
    };

    try {
      const data = await postJSON("/api/update-profile", { username: s.username, updates });
      if (!data.ok) {
        setError(errEl, data.error || "Update failed");
        return;
      }
      setSession(data.user);
      mergeIntoDirectory([data.user]);
      hideId("modalEditProfile");
      enterApp();
    } catch (e) {
      setError(errEl, "Server error while saving your profile");
    }
  }

  /* ---------------------------------------------------------------------
     Direct messages
     --------------------------------------------------------------------- */
  function renderDmBadge() {
    const badge = $("dmBadge");
    if (!badge) return;
    const total = Object.values(state.dmUnread).reduce((a, b) => a + b, 0);
    if (total > 0) {
      badge.textContent = String(total);
      badge.style.display = "inline-block";
    } else {
      badge.style.display = "none";
    }
  }

  async function updateDmSidebar() {
    const list = $("dmSidebarList");
    if (!list) return;

    const s = getSession();
    if (!s) {
      list.innerHTML = '<div class="small muted">Log in to see your DMs.</div>';
      return;
    }

    try {
      const data = await postJSON("/api/dm/partners", { username: s.username });
      const filter = (($("dmSearch") && $("dmSearch").value) || "").trim().toLowerCase();
      const partners = (data.partners || []).filter(p => !filter || p.toLowerCase().includes(filter));

      list.innerHTML = "";
      if (!partners.length) {
        list.innerHTML = '<div class="small muted">No conversations yet. Open the roster to start one.</div>';
        return;
      }

      partners.forEach(other => {
        const item = document.createElement("div");
        item.className = "dm-row";
        const unread = state.dmUnread[other];
        item.innerHTML = `
          <span class="ellipsis">@${escapeHtml(other)}</span>
          ${unread ? `<span class="badge">${unread}</span>` : ""}
        `;
        item.addEventListener("click", () => openDm(other));
        list.appendChild(item);
      });
    } catch (e) {
      list.innerHTML = '<div class="small muted">Could not load conversations.</div>';
    }
  }

  async function openDm(username) {
    const s = getSession();
    if (!s) return alert("Please log in first.");
    if (username === s.username) return alert("You cannot message yourself.");

    state.dmPartner = username;
    delete state.dmUnread[username];
    renderDmBadge();

    const popup = $("dmPopup");
    if (!popup) return;
    popup.dataset.partner = username;

    const title = $("dmTitle");
    if (title) title.textContent = "@" + username;

    const typing = $("dmTyping");
    if (typing) typing.style.display = "none";

    hideId("modalRoster");
    hideId("modalViewProfile");
    hideId("dmSidebar");
    showId("dmPopup");

    const body = $("dmMessages");
    if (body) body.innerHTML = '<div class="small muted">Loading…</div>';

    try {
      const data = await postJSON("/api/dm/history", { a: s.username, b: username });
      if (body) body.innerHTML = "";
      (data.messages || []).forEach(appendDmMessage);
    } catch (e) {
      if (body) body.innerHTML = '<div class="small muted">Could not load this conversation.</div>';
    }
  }

  function closeDm() {
    state.dmPartner = null;
    hideId("dmPopup");
  }

  function appendDmMessage(msg) {
    const body = $("dmMessages");
    if (!body || !msg) return;

    const s = getSession();
    const isMe = !!(s && msg.from === s.username);
    const author = directoryUser(msg.from) || { username: msg.from, display: msg.from };

    const row = document.createElement("div");
    row.className = "message-row" + (isMe ? " me" : "");

    const content = msg.imageUrl
      ? `<img src="${escapeHtml(msg.imageUrl)}" class="chat-image" alt="attachment">`
      : `<div>${escapeHtml(msg.text || "")}</div>`;

    row.innerHTML = `
      <div class="message-avatar">${avatarHtml(author)}</div>
      <div class="message">
        <div class="message-meta">${escapeHtml(author.display || msg.from)}
          <span class="small muted">${escapeHtml(timeLabel(msg.time))}</span>
        </div>
        ${content}
      </div>
    `;
    body.appendChild(row);
    body.scrollTop = body.scrollHeight;
  }

  function sendDm() {
    const s = getSession();
    const input = $("dmInput");
    if (!s || !input || !state.dmPartner) return;

    const text = input.value.trim();
    if (!text) return;

    const payload = { from: s.username, to: state.dmPartner, text };

    if (state.socket) {
      // the server echoes the message back to the sender, so do not append here
      state.socket.emit("privateMessage", payload);
    } else {
      postJSON("/api/send-dm", payload).catch(() => {});
      appendDmMessage(Object.assign({ time: new Date().toISOString() }, payload));
    }

    input.value = "";
  }

  async function sendDmImage(file) {
    const s = getSession();
    if (!s || !state.dmPartner || !file) return;

    const url = await uploadImage(file);
    if (!url) return alert("Image upload failed.");

    if (state.socket) {
      state.socket.emit("privateMessage", { from: s.username, to: state.dmPartner, imageUrl: url });
    }
  }

  async function clearDm() {
    const s = getSession();
    if (!s || !state.dmPartner) return;
    if (!confirm("Clear this conversation?")) return;

    try {
      await postJSON("/api/dm/clear", { a: s.username, b: state.dmPartner });
      const body = $("dmMessages");
      if (body) body.innerHTML = "";
    } catch (e) {
      alert("Could not clear this conversation.");
    }
  }

  /* ---------------------------------------------------------------------
     Story builder (opened from a DM)
     --------------------------------------------------------------------- */
  function openStoryPopup(partner) {
    const s = getSession();
    if (!s || !partner) return;

    const editor = $("storyEditor");
    const dateInput = $("storyDate");
    if (editor) editor.value = "";
    if (dateInput) dateInput.value = "";

    showId("storyPopup");

    const loadBtn = $("storyLoadBtn");
    if (loadBtn) loadBtn.onclick = async () => {
      const fromDate = dateInput && dateInput.value;
      if (!fromDate) return alert("Choose a start date first.");
      try {
        const data = await postJSON("/api/story/load", { a: s.username, b: partner, fromDate });
        if (!data.ok) return alert("Failed to load messages.");
        editor.value = (data.messages || [])
          .map(m => `[${new Date(m.time).toLocaleString()}] ${m.from}: ${m.text || "(image)"}`)
          .join("\n");
      } catch (e) {
        alert("Failed to load messages.");
      }
    };

    const saveBtn = $("storySaveBtn");
    if (saveBtn) saveBtn.onclick = async () => {
      const story = (editor && editor.value || "").trim();
      if (!story) return alert("The story is empty.");
      try {
        const data = await postJSON("/api/story/save", { owner: s.username, partner, story });
        if (!data.ok) return alert("Failed to save the story.");
        alert("Story saved. Waiting for approval.");
        hideId("storyPopup");
      } catch (e) {
        alert("Failed to save the story.");
      }
    };
  }

  /* ---------------------------------------------------------------------
     Rooms
     --------------------------------------------------------------------- */
  function openRoomsSidebar() {
    showId("roomsSidebar");
    renderRoomsSidebar();
  }

  function renderRoomsSidebar() {
    const list = $("roomsList");
    if (!list) return;

    const s = getSession();
    const sort = ($("roomSort") && $("roomSort").value) || "newest";

    let rooms = [...state.rooms].filter(r => {
      if (!r.private) return true;
      if (!s) return false;
      if (r.owner && r.owner.toLowerCase() === s.username.toLowerCase()) return true;
      return Array.isArray(r.invitedUsers) && r.invitedUsers.includes(s.username);
    });

    if (sort === "newest") rooms.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    if (sort === "oldest") rooms.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    if (sort === "az") rooms.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    if (sort === "za") rooms.sort((a, b) => String(b.name).localeCompare(String(a.name)));

    list.innerHTML = "";

    if (!rooms.length) {
      list.innerHTML = '<div class="small muted" style="padding:12px">No rooms yet. Create one below.</div>';
      return;
    }

    rooms.forEach(room => {
      const div = document.createElement("div");
      div.className = "room-item";
      div.innerHTML = `<span class="ellipsis">${room.private ? "🔒 " : ""}${escapeHtml(room.name)}</span>`;
      div.addEventListener("click", () => openRoomPopup(room._id, room.name));

      if (s && room.owner && room.owner.toLowerCase() === s.username.toLowerCase()) {
        const invite = document.createElement("button");
        invite.type = "button";
        invite.className = "small-btn secondary";
        invite.textContent = "Invite";
        invite.addEventListener("click", e => {
          e.stopPropagation();
          const username = prompt("Username to invite:");
          if (!username || !state.socket) return;
          state.socket.emit("inviteToRoom", { roomId: room._id, username: username.trim() });
        });
        div.appendChild(invite);
      }

      list.appendChild(div);
    });
  }

  function openRoomPopup(roomId, roomName) {
    const popup = $("roomChatPopup");
    if (!popup || !roomId) return;

    popup.dataset.room = roomId;

    const title = $("roomChatTitle");
    if (title) title.textContent = roomName || "Room";

    const feed = $("roomFeed");
    if (feed) feed.innerHTML = "";

    const typing = $("roomTyping");
    if (typing) typing.style.display = "none";

    hideId("roomsSidebar");
    showId("roomChatPopup");

    if (state.socket) {
      state.socket.emit("joinRoom", { room: String(roomId) });
      setTimeout(() => state.socket.emit("requestRoomMembers", { room: String(roomId) }), 250);
    }
  }

  function closeRoomPopup() {
    const popup = $("roomChatPopup");
    if (popup) popup.dataset.room = "";
    hideId("roomChatPopup");
  }

  function appendRoomMessage(msg) {
    const feed = $("roomFeed");
    if (!feed || !msg) return;

    const author = directoryUser(msg.from) || { username: msg.from, display: msg.display || msg.from };

    const content = msg.imageUrl
      ? `<img src="${escapeHtml(msg.imageUrl)}" class="chat-image" alt="attachment">`
      : `<div>${escapeHtml(msg.text || "")}</div>`;

    const div = document.createElement("div");
    div.className = "message-row";
    div.innerHTML = `
      <div class="message-avatar">${avatarHtml(author)}</div>
      <div class="message">
        <div class="message-meta" style="color:${escapeHtml(author.color || "#7fd8ff")}">
          ${escapeHtml(msg.display || msg.from)}
          <span class="small muted">@${escapeHtml(msg.from)} • ${escapeHtml(timeLabel(msg.time))}</span>
        </div>
        ${content}
      </div>
    `;
    feed.appendChild(div);
    feed.scrollTop = feed.scrollHeight;
  }

  function renderRoomMembers(members) {
    const list = $("roomMembersList");
    if (!list) return;

    list.innerHTML = "";
    (members || []).forEach(m => {
      const div = document.createElement("div");
      div.className = "room-member";
      div.innerHTML = `
        ${avatarHtml(m, 28)}
        <div style="flex:1;min-width:0">
          <div class="ellipsis small" style="font-weight:700">${escapeHtml(m.display || m.username)}</div>
        </div>
        <span class="status-dot ${m.online ? "online" : "offline"}"></span>
      `;
      list.appendChild(div);
    });
  }

  function sendRoomMessage() {
    const s = getSession();
    const input = $("roomMessageInput");
    const popup = $("roomChatPopup");
    const room = popup && popup.dataset.room;

    if (!s || !input || !room || !state.socket) return;

    const text = input.value.trim();
    if (!text) return;

    state.socket.emit("roomMessage", {
      room,
      from: s.username,
      display: s.display || s.username,
      text,
      time: new Date().toISOString()
    });

    input.value = "";
  }

  async function sendRoomImage(file) {
    const s = getSession();
    const popup = $("roomChatPopup");
    const room = popup && popup.dataset.room;
    if (!s || !room || !file || !state.socket) return;

    const url = await uploadImage(file);
    if (!url) return alert("Image upload failed.");

    state.socket.emit("roomMessage", {
      room,
      from: s.username,
      display: s.display || s.username,
      imageUrl: url,
      time: new Date().toISOString()
    });
  }

  function createRoom() {
    if (!state.socket) return alert("Not connected.");
    const name = prompt("Room name:");
    if (!name || !name.trim()) return;
    const isPrivate = confirm("Make this a PRIVATE room?");
    state.socket.emit("createRoom", { name: name.trim(), private: isPrivate });
  }

  /* ---------------------------------------------------------------------
     Support report  (sent as a DM to the Administrator, like the desktop UI)
     --------------------------------------------------------------------- */
  async function submitSupportReport() {
    const me = getSession();
    if (!me) return alert("You must be logged in to submit a report.");

    const type = ($("srType") && $("srType").value) || "issue";
    const user = ($("srUser") && $("srUser").value || "").trim();
    const where = ($("srWhere") && $("srWhere").value || "").trim();
    const when = ($("srWhen") && $("srWhen").value) || "";
    const info = ($("srInfo") && $("srInfo").value || "").trim();

    if (!info) return alert("Please describe what happened.");

    const payload = {
      from: me.username,
      to: "Administrator",
      text: [
        "Support Report",
        `Type: ${type}`,
        `User: ${user || "N/A"}`,
        `Where: ${where || "N/A"}`,
        `When: ${when || "N/A"}`,
        `Info: ${info}`
      ].join("\n")
    };

    const btn = $("srSubmit");
    if (btn) btn.disabled = true;

    try {
      const data = await postJSON("/api/send-dm", payload);
      if (!data.ok) {
        alert("Failed to submit the report.");
        return;
      }
      alert("Report submitted. Thank you.");
      if ($("srInfo")) $("srInfo").value = "";
      if ($("srUser")) $("srUser").value = "";
      if ($("srWhere")) $("srWhere").value = "";
      hideId("supportPopup");
    } catch (e) {
      alert("Network error while submitting the report.");
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /* ---------------------------------------------------------------------
     Legal modals (TOS / Privacy are loaded from /legal/*.html on demand)
     --------------------------------------------------------------------- */
  async function openLegal(modalId, contentId, url) {
    showId(modalId);
    if (!url || state.legalLoaded[contentId]) return;

    const target = $(contentId);
    if (!target) return;

    target.innerHTML = '<p class="small muted">Loading…</p>';
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error("not_found");
      target.innerHTML = await res.text();
      state.legalLoaded[contentId] = true;
    } catch (e) {
      target.innerHTML = '<p class="small muted">This document could not be loaded right now.</p>';
    }
  }

  /* ---------------------------------------------------------------------
     Admin panel (only /api/admin/users exists server side)
     --------------------------------------------------------------------- */
  let adminUsers = [];

  async function loadAdminData() {
    const tbody = document.querySelector("#adminTable tbody");
    if (tbody) tbody.innerHTML = '<tr><td colspan="5" class="small muted">Loading…</td></tr>';

    try {
      const data = await getJSON("/api/admin/users");
      adminUsers = (data && data.users) || [];
      renderAdminUsers();
    } catch (e) {
      if (tbody) tbody.innerHTML = '<tr><td colspan="5" class="small muted">Could not load users.</td></tr>';
    }
  }

  function renderAdminUsers() {
    const tbody = document.querySelector("#adminTable tbody");
    if (!tbody) return;

    const filter = (($("adminSearch") && $("adminSearch").value) || "").trim().toLowerCase();
    const rows = adminUsers.filter(u =>
      !filter ||
      String(u.username || "").toLowerCase().includes(filter) ||
      String(u.email || "").toLowerCase().includes(filter)
    );

    tbody.innerHTML = "";

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="small muted">No users found.</td></tr>';
      return;
    }

    rows.forEach(u => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(u.username)}</td>
        <td class="ellipsis">${escapeHtml(u.email || "")}</td>
        <td>${escapeHtml(u.role || "user")}</td>
        <td>${isOnline(u.username) ? "yes" : "no"}</td>
        <td>${u.banned ? "yes" : "no"}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  function showAdminTab(tab) {
    const usersView = $("adminUsersView");
    const analyticsView = $("adminAnalyticsView");
    if (usersView) usersView.style.display = tab === "users" ? "block" : "none";
    if (analyticsView) analyticsView.style.display = tab === "analytics" ? "block" : "none";
    if (tab === "users") renderAdminUsers();
  }

  /* ---------------------------------------------------------------------
     Bindings
     --------------------------------------------------------------------- */
  function bindEverything() {
    /* age gate */
    on($("confirmBtn"), "click", e => { e.preventDefault(); confirmAgeAndProceed(); });

    /* auth screen */
    on($("btnLogin"), "click", e => { e.preventDefault(); showId("modalLogin"); });
    on($("btnRegister"), "click", e => { e.preventDefault(); showId("modalRegister"); });
    on($("btnDiscordLogin"), "click", e => {
      e.preventDefault();
      alert("Discord login is not available yet. Please use a username and password.");
    });

    /* login modal */
    on($("loginSubmit"), "click", e => { e.preventDefault(); handleLogin(); });
    on($("loginCancel"), "click", e => { e.preventDefault(); hideId("modalLogin"); });
    on($("loginPass"), "keydown", e => { if (e.key === "Enter") handleLogin(); });

    /* register modal */
    on($("regSubmit"), "click", e => { e.preventDefault(); handleRegister(); });
    on($("regCancel"), "click", e => { e.preventDefault(); hideId("modalRegister"); });
    on($("btnUploadImage"), "click", async e => {
      e.preventDefault();
      const input = $("regImageFile");
      const status = $("uploadStatus");
      const file = input && input.files && input.files[0];
      if (!file) { if (status) status.textContent = "Select a file first"; return; }
      if (status) status.textContent = "Uploading...";
      registerImageUrl = await uploadImage(file) || "";
      if (status) status.textContent = registerImageUrl ? "Uploaded" : "Upload failed";
    });

    /* main menu */
    on($("btnOpenChat"), "click", openArenaChat);
    on($("btnCloseChat"), "click", closeArenaChat);
    on($("btnMinimize"), "click", () => {
      const body = $("chatBody");
      if (!body) return;
      body.classList.toggle("collapsed");
    });
    on($("sendPublic"), "click", sendPublicMessage);
    on($("publicMessage"), "keydown", e => { if (e.key === "Enter") sendPublicMessage(); });

    on($("btnRoster"), "click", openRoster);
    on($("rosterClose"), "click", () => hideId("modalRoster"));
    on($("rosterSearch"), "input", debounce(() => { state.rosterPage = 1; renderRoster(); }, 200));
    on($("rosterPrev"), "click", () => { state.rosterPage--; renderRoster(); });
    on($("rosterNext"), "click", () => { state.rosterPage++; renderRoster(); });
    bindRosterDelegation();

    /* DMs */
    on($("btnDMs"), "click", () => { showId("dmSidebar"); updateDmSidebar(); });
    on($("closeDmSidebar"), "click", () => hideId("dmSidebar"));
    on($("dmSearch"), "input", debounce(updateDmSidebar, 200));
    on($("dmClose"), "click", closeDm);
    on($("dmSend"), "click", sendDm);
    on($("dmClear"), "click", clearDm);
    on($("dmStory"), "click", () => { if (state.dmPartner) openStoryPopup(state.dmPartner); });
    on($("dmImageBtn"), "click", () => { const i = $("dmImageInput"); if (i) i.click(); });
    on($("dmImageInput"), "change", e => {
      const file = e.target.files && e.target.files[0];
      if (file) sendDmImage(file);
      e.target.value = "";
    });
    on($("dmInput"), "keydown", e => { if (e.key === "Enter") sendDm(); });

    let dmTypingTimer;
    on($("dmInput"), "input", () => {
      const s = getSession();
      if (!s || !state.socket || !state.dmPartner) return;
      state.socket.emit("typingDM", { from: s.username, to: state.dmPartner });
      clearTimeout(dmTypingTimer);
      dmTypingTimer = setTimeout(() => {
        state.socket.emit("stopTypingDM", { from: s.username, to: state.dmPartner });
      }, 1200);
    });

    /* rooms */
    on($("btnRooms"), "click", openRoomsSidebar);
    on($("closeRoomsSidebar"), "click", () => hideId("roomsSidebar"));
    on($("roomSort"), "change", renderRoomsSidebar);
    on($("createRoomBtn"), "click", createRoom);
    on($("closeRoomChat"), "click", closeRoomPopup);
    on($("roomSendBtn"), "click", sendRoomMessage);
    on($("roomMessageInput"), "keydown", e => { if (e.key === "Enter") sendRoomMessage(); });
    on($("roomImageBtn"), "click", () => { const i = $("roomImageInput"); if (i) i.click(); });
    on($("roomImageInput"), "change", e => {
      const file = e.target.files && e.target.files[0];
      if (file) sendRoomImage(file);
      e.target.value = "";
    });

    let roomTypingTimer;
    on($("roomMessageInput"), "input", () => {
      const s = getSession();
      const popup = $("roomChatPopup");
      const room = popup && popup.dataset.room;
      if (!s || !room || !state.socket) return;
      state.socket.emit("typingRoom", { room, from: s.username });
      clearTimeout(roomTypingTimer);
      roomTypingTimer = setTimeout(() => {
        state.socket.emit("stopTypingRoom", { room, from: s.username });
      }, 1200);
    });

    /* profile */
    on($("btnEditProfile"), "click", openEditProfile);
    on($("editCancel"), "click", () => hideId("modalEditProfile"));
    on($("editSubmit"), "click", saveProfile);
    on($("btnEditUploadImage"), "click", async e => {
      e.preventDefault();
      const input = $("editImageFile");
      const status = $("editUploadStatus");
      const file = input && input.files && input.files[0];
      if (!file) { if (status) status.textContent = "Select a file first"; return; }
      if (status) status.textContent = "Uploading...";
      const url = await uploadImage(file);
      if (url) { editImageUrl = url; status.textContent = "Uploaded"; }
      else if (status) status.textContent = "Upload failed";
    });

    on($("btnMyProfile"), "click", () => {
      const s = getSession();
      if (s) openProfile(s.username);
    });
    on($("vpClose"), "click", () => hideId("modalViewProfile"));
    on($("vpDMButton"), "click", () => {
      const modal = $("modalViewProfile");
      if (modal && modal.dataset.username) openDm(modal.dataset.username);
    });
    on($("vpBlockButton"), "click", blockCurrentProfile);
    on($("vpRelationshipSend"), "click", sendRelationshipRequest);

    /* support */
    on($("openSupport"), "click", () => showId("supportPopup"));
    on($("closeSupport"), "click", () => hideId("supportPopup"));
    on($("srSubmit"), "click", e => { e.preventDefault(); submitSupportReport(); });
    on($("srType"), "change", () => {
      const section = $("srUserSection");
      if (section) section.style.display = $("srType").value === "user" ? "block" : "none";
    });

    /* legal */
    on($("btnTOS"), "click", () => openLegal("modalTOS", "tosContent", "/legal/tos.html"));
    on($("closeTOS"), "click", () => hideId("modalTOS"));
    on($("btnPrivacy"), "click", () => openLegal("modalPrivacy", "privacyContent", "/legal/privacy.html"));
    on($("closePrivacy"), "click", () => hideId("modalPrivacy"));
    on($("btnRules"), "click", () => openLegal("modalRules", "rulesContent", null));
    on($("closeRules"), "click", () => hideId("modalRules"));

    /* story popup */
    on($("storyCloseBtn"), "click", () => hideId("storyPopup"));

    /* admin */
    on($("btnAdmin"), "click", () => { showId("modalAdmin"); showAdminTab("users"); loadAdminData(); });
    on($("adminClose"), "click", () => hideId("modalAdmin"));
    on($("tabUsers"), "click", () => showAdminTab("users"));
    on($("tabAnalytics"), "click", () => showAdminTab("analytics"));
    on($("adminSearch"), "input", debounce(renderAdminUsers, 200));

    /* logout */
    on($("btnLogout"), "click", logout);

    /* tapping the dark backdrop closes a modal */
    document.querySelectorAll(".modal, .modal-overlay, .popup").forEach(modal => {
      modal.addEventListener("click", ev => { if (ev.target === modal) hide(modal); });
    });
  }

  /* ---------------------------------------------------------------------
     Startup
     --------------------------------------------------------------------- */
  let started = false;

  function start() {
    if (started) return;          // never bind the same handler twice
    started = true;

    ensureStartupVisibility();
    bindEverything();
    renderDmBadge();

    const srSection = $("srUserSection");
    if (srSection && $("srType")) {
      srSection.style.display = $("srType").value === "user" ? "block" : "none";
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();                      // script executed after the DOM was ready
  }

  window.addEventListener("beforeunload", () => {
    const s = getSession();
    if (state.socket && s) {
      try { state.socket.emit("forceLogout", { username: s.username }); } catch (e) {}
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && getSession() && state.socket) socketLogin();
  });

  /* small debug surface */
  window.__cw = {
    state,
    getSession,
    setSession,
    logout,
    openProfile,
    openDm,
    openRoster,
    loadAllUsers
  };
})();

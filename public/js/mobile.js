/* =========================================================================
   mobile.js — CLEAN single-file client for /public/mobile.html

   ONE consolidated, strict-mode IIFE containing:
     - the original/orphan mobile.js (the complete client: shared DOM
       helpers, socket orchestration, profile/story/relationship/admin
       flows, lifecycle + window debug surface) as the canonical base, and
     - the 12 per-feature *-mobile.js modules (DM/PM, rooms, availability,
       image upload, admin auth, roster rendering, ...) merged in.

   To keep one coherent scope, any module top-level declaration whose name is
   already defined (by the orphan or an earlier module) is dropped, so each
   identifier is declared exactly once. Shared helpers ($, show, hide,
   getSession, escapeHtml, logout, setSession, openPrivateWindow,
   updateDMListSidebar, ...) resolve to the orphan's canonical versions.
   ========================================================================= */

(function () {
  "use strict";

  /* ===================== ORIGINAL mobile.js (canonical base) ===================== */

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
    roomUnread: {},       // roomId -> count
    legalLoaded: {}
  };

  const ROSTER_ENDPOINT = "/api/allUsers";

  function directoryUser(username) {
    if (!username) return null;
    if (state.session && state.session.username === username) {
      const found = state.allUsers.find(u => u.username === username) ||
                    state.onlineUsers.find(u => u.username === username);
      return Object.assign({}, state.session, found || {});
    }
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

    socket.on("pmError", ({ reason } = {}) => {
      alert(reason || "User not found");
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
      if (!current || !msg || String(msg.room) !== String(current)) {
        const s = getSession();
        if (msg && msg.room && (!s || msg.from !== s.username)) {
          state.roomUnread[msg.room] = (state.roomUnread[msg.room] || 0) + 1;
          renderRoomsSidebar();
        }
        return;
      }
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

    let data;
    try {
      data = await postJSON("/api/login", { username, password });
    } catch (e) {
      setError(errEl, "Network error during login");
      return;
    }

    if (!data.ok) {
      setError(errEl, data.error === "banned" ? "You are banned." : "Invalid credentials");
      return;
    }

    setSession(data.user);
    hideId("modalLogin");
    const loginUser = $("loginUser");
    if (loginUser) loginUser.value = "";
    const loginPass = $("loginPass");
    if (loginPass) loginPass.value = "";
    enterApp();
  }

  async function handleRegister() {
    const errEl = $("regError");
    setError(errEl, "");

    const username = ($("regUser") && $("regUser").value || "").trim().toLowerCase();
    const email = ($("regEmail") && $("regEmail").value || "").trim().toLowerCase();
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
      if (!state.allUsers || !state.allUsers.length) {
        try {
          const resUsers = await getJSON("/api/allUsers");
          if (resUsers && resUsers.success && Array.isArray(resUsers.users)) {
            state.allUsers = resUsers.users;
          }
        } catch (err) {}
      }
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
    const display = msg.display || author.display || msg.from || "";
    const avatarSource = msg.avatar || msg.imageUrl || author.imageUrl
      ? { imageUrl: msg.avatar || msg.imageUrl || author.imageUrl, display }
      : { imageUrl: author.imageUrl, display };

    const row = document.createElement("div");
    row.className = "message-row" + (isMe ? " me" : "");
    row.innerHTML = `
      <div class="message-avatar">${avatarHtml(avatarSource)}</div>
      <div class="message">
        <div class="message-meta" style="color:${escapeHtml(msg.color || author.color || "#7fd8ff")}">
          ${escapeHtml(display)}
          <span class="small muted">@${escapeHtml(msg.from || "")} • ${escapeHtml(timeLabel(msg.time))}</span>
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
      avatar: s.imageUrl || null,
      color: s.color || null,
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

  // Desktop-compatible pending-data loaders.  The mobile document does not
  // render dedicated pending sections, but keeping these functions and paths
  // aligned lets callers use the same API contract on either client.
  async function loadPendingStories(username) {
    const data = await getJSON("/api/story/pending?username=" + encodeURIComponent(username));
    return (data && data.stories) || [];
  }

  async function resendStoryApproval(storyId) {
    return postJSON("/api/story/resend", { storyId });
  }

  async function loadPendingRelationships(username) {
    const data = await getJSON("/api/relationship/pending?username=" + encodeURIComponent(username));
    return (data && data.relationships) || [];
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
        const user = directoryUser(other) || { username: other, display: other };
        item.innerHTML = `
          <div style="display:flex;align-items:center;gap:8px;min-width:0;flex:1">
            ${avatarHtml(user, 32)}
            <div style="min-width:0">
              <div class="ellipsis" style="font-weight:700">${escapeHtml(user.display || other)}</div>
              <div class="ellipsis small muted">@${escapeHtml(other)}</div>
            </div>
          </div>
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
    const author = directoryUser(msg.from) || { username: msg.from, display: msg.display || msg.from };

    const row = document.createElement("div");
    row.className = "message-row" + (isMe ? " me" : "") + ((msg.type === "storyApproval" || msg.type === "relationshipApproval") ? " system" : "");

    let content = "";
    if (msg.type === "storyApproval") {
      const sid = msg.storyId || msg._id || "";
      content = `
        <div class="system-msg">
          <div>${escapeHtml(msg.text || "")}</div>
          <button type="button" class="small-btn approveStoryBtn" data-id="${escapeHtml(sid)}">Approve</button>
        </div>
      `;
    } else if (msg.type === "relationshipApproval") {
      const rid = msg.relationshipId || msg._id || "";
      content = `
        <div class="system-msg">
          <div>${escapeHtml(msg.text || "")}</div>
          <button type="button" class="small-btn approveRelBtn" data-id="${escapeHtml(rid)}">Approve</button>
        </div>
      `;
    } else if (msg.imageUrl) {
      content = `<img src="${escapeHtml(msg.imageUrl)}" class="chat-image" alt="attachment">`;
    } else {
      content = `<div>${escapeHtml(msg.text || "")}</div>`;
    }

    row.innerHTML = `
      <div class="message-avatar">${avatarHtml(author)}</div>
      <div class="message">
        <div class="message-meta">${escapeHtml(author.display || msg.from)}
          <span class="small muted">${escapeHtml(timeLabel(msg.time))}</span>
        </div>
        ${content}
      </div>
    `;

    const storyBtn = row.querySelector(".approveStoryBtn");
    if (storyBtn) {
      storyBtn.addEventListener("click", async () => {
        const storyId = storyBtn.dataset.id;
        if (!storyId) return;
        try {
          const res = await postJSON("/api/story/approve", { storyId });
          if (res && res.ok) {
            storyBtn.parentElement.innerHTML = '<div class="tiny muted">Story approved</div>';
          } else {
            alert("Could not approve story.");
          }
        } catch (e) {
          alert("Could not approve story.");
        }
      });
    }

    const relBtn = row.querySelector(".approveRelBtn");
    if (relBtn) {
      relBtn.addEventListener("click", async () => {
        const relationshipId = relBtn.dataset.id;
        if (!relationshipId) return;
        try {
          const res = await postJSON("/api/relationship/approve", { relationshipId });
          if (res && res.ok) {
            relBtn.parentElement.innerHTML = '<div class="tiny muted">Relationship approved</div>';
          } else {
            alert("Could not approve relationship.");
          }
        } catch (e) {
          alert("Could not approve relationship.");
        }
      });
    }

    const imgEl = row.querySelector(".chat-image");
    if (imgEl) {
      imgEl.style.cursor = "pointer";
      imgEl.addEventListener("click", () => window.open(msg.imageUrl, "_blank"));
    }

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
      alert("Not connected to the arena. Please reload the page.");
      return;
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
    } else {
      alert("Not connected to the arena. Please reload the page.");
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
      return Array.isArray(r.invitedUsers) && r.invitedUsers.some(u => u && u.toLowerCase() === s.username.toLowerCase());
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
      const unread = state.roomUnread[room._id];
      div.innerHTML = `
        <span class="ellipsis">${room.private ? "🔒 " : ""}${escapeHtml(room.name)}</span>
        ${unread ? `<span class="badge">${unread}</span>` : ""}
      `;
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
    delete state.roomUnread[roomId];
    renderRoomsSidebar();

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

    const s = getSession();
    const isMe = !!(s && msg.from === s.username);
    const author = directoryUser(msg.from) || { username: msg.from, display: msg.display || msg.from };
    const display = msg.display || author.display || msg.from || "";

    const content = msg.imageUrl
      ? `<img src="${escapeHtml(msg.imageUrl)}" class="chat-image" alt="attachment">`
      : `<div>${escapeHtml(msg.text || "")}</div>`;

    const div = document.createElement("div");
    div.className = "message-row" + (isMe ? " me" : "");
    div.innerHTML = `
      <div class="message-avatar">${avatarHtml(author)}</div>
      <div class="message">
        <div class="message-meta" style="color:${escapeHtml(author.color || "#7fd8ff")}">
          ${escapeHtml(display)}
          <span class="small muted">@${escapeHtml(msg.from || "")} • ${escapeHtml(timeLabel(msg.time))}</span>
        </div>
        ${content}
      </div>
    `;

    const imgEl = div.querySelector(".chat-image");
    if (imgEl) {
      imgEl.style.cursor = "pointer";
      imgEl.addEventListener("click", () => window.open(msg.imageUrl, "_blank"));
    }

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
     Admin panel (requires x-admin-key = ADMIN_KEY)
     --------------------------------------------------------------------- */
  let adminUsers = [];
  let adminKey = null;

  async function adminFetch(url, options = {}) {
    const headers = Object.assign(
      { Accept: "application/json", "x-admin-key": adminKey || "" },
      options.headers || {}
    );
    const res = await fetch(url, Object.assign({}, options, { headers }));
    const data = await res.json().catch(() => null);
    if (!data) throw new Error("bad_response");
    return data;
  }

  async function promptAdminKey() {
    if (adminKey) return true;
    const key = prompt("Enter admin password:");
    if (!key) return false;
    try {
      const data = await fetch("/api/admin/users", {
        headers: { "x-admin-key": key, Accept: "application/json" }
      }).then(r => r.json());
      if (!data.ok) {
        alert("Incorrect admin password.");
        return false;
      }
      adminKey = key;
      adminUsers = data.users || [];
      return true;
    } catch (e) {
      alert("Could not verify admin password.");
      return false;
    }
  }

  async function openAdminPanel() {
    const ok = await promptAdminKey();
    if (!ok) return;
    showId("modalAdmin");
    showAdminTab("users");
    renderAdminUsers();
  }

  async function loadAdminData() {
    const tbody = document.querySelector("#adminTable tbody");
    if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="small muted">Loading…</td></tr>';

    try {
      const data = await adminFetch("/api/admin/users");
      if (!data.ok) throw new Error("denied");
      adminUsers = data.users || [];
      renderAdminUsers();
    } catch (e) {
      if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="small muted">Could not load users.</td></tr>';
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
      tbody.innerHTML = '<tr><td colspan="6" class="small muted">No users found.</td></tr>';
      return;
    }

    rows.forEach(u => {
      const tr = document.createElement("tr");
      tr.dataset.username = u.username || "";
      tr.innerHTML = `
        <td>${escapeHtml(u.username)}</td>
        <td class="ellipsis">${escapeHtml(u.email || "")}</td>
        <td>${escapeHtml(u.role || "user")}</td>
        <td>${u.online || isOnline(u.username) ? "yes" : "no"}</td>
        <td>${u.banned ? "yes" : "no"}</td>
        <td>
          <button type="button" class="small-btn admin-ban">${u.banned ? "Unban" : "Ban"}</button>
          <button type="button" class="small-btn admin-reset">Reset PW</button>
          <button type="button" class="small-btn admin-delete">Delete</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  }

  async function loadAdminAnalytics() {
    const box = $("statsSummary");
    const list = $("topIpsList");
    if (box) box.innerHTML = '<div class="small muted">Loading…</div>';

    try {
      const [stats, ips] = await Promise.all([
        adminFetch("/api/admin/stats"),
        adminFetch("/api/admin/top-ips")
      ]);

      if (box && stats.ok) {
        box.innerHTML = `
          <div>Total users: ${stats.totalUsers}</div>
          <div>Online users: ${stats.onlineUsers}</div>
          <div>Banned users: ${stats.bannedUsers}</div>
          <div>Total logs: ${stats.totalLogs}</div>
          <div>Last 24h: logins ${stats.last24h?.logins24h ?? 0}, fails ${stats.last24h?.fails24h ?? 0}, regs ${stats.last24h?.regs24h ?? 0}</div>
        `;
      }

      if (list && ips.ok) {
        list.innerHTML = "";
        (ips.ips || []).forEach(row => {
          const li = document.createElement("li");
          li.textContent = `${row._id || "unknown"} — ${row.count}`;
          list.appendChild(li);
        });
        if (!(ips.ips || []).length) {
          list.innerHTML = '<li class="small muted">No IP activity in the last 24h</li>';
        }
      }
    } catch (e) {
      if (box) box.innerHTML = '<div class="small muted">Could not load analytics.</div>';
    }
  }

  function showAdminTab(tab) {
    const usersView = $("adminUsersView");
    const analyticsView = $("adminAnalyticsView");
    if (usersView) usersView.style.display = tab === "users" ? "block" : "none";
    if (analyticsView) analyticsView.style.display = tab === "analytics" ? "block" : "none";
    if (tab === "users") renderAdminUsers();
    if (tab === "analytics") loadAdminAnalytics();
  }

  async function handleAdminAction(e) {
    const btn = e.target.closest("button");
    if (!btn) return;
    const row = btn.closest("tr");
    const username = row && row.dataset.username;
    if (!username || !adminKey) return;

    try {
      if (btn.classList.contains("admin-ban")) {
        const banned = btn.textContent.trim() === "Ban";
        await adminFetch("/api/admin/ban", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, banned })
        });
        await loadAdminData();
      } else if (btn.classList.contains("admin-reset")) {
        const newPassword = prompt("Enter new password:");
        if (!newPassword) return;
        const data = await adminFetch("/api/admin/reset-password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, newPassword })
        });
        alert(data.ok ? "Password reset" : "Failed to reset password");
      } else if (btn.classList.contains("admin-delete")) {
        if (!confirm("Delete this user?")) return;
        await adminFetch("/api/admin/delete-user", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username })
        });
        await loadAdminData();
      }
    } catch (err) {
      alert("Admin action failed");
    }
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
    on($("btnAdmin"), "click", openAdminPanel);
    on($("adminClose"), "click", () => hideId("modalAdmin"));
    on($("tabUsers"), "click", () => showAdminTab("users"));
    on($("tabAnalytics"), "click", () => showAdminTab("analytics"));
    on($("adminSearch"), "input", debounce(renderAdminUsers, 200));
    const adminTable = document.querySelector("#adminTable tbody");
    if (adminTable) adminTable.addEventListener("click", handleAdminAction);

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
    // Mark offline but keep session so refresh stays signed in
    if (state.socket && s) {
      try { state.socket.emit("chatClosed", { username: s.username }); } catch (e) {}
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && getSession() && state.socket) socketLogin();
  });

  /* small debug surface */
  // Keep the public function names used by the desktop scripts available to
  // mobile callers.  Each alias uses mobile.html's existing elements and the
  // same API paths rather than duplicating a second implementation.
  Object.assign(window, {
    getSession,
    setSession,
    logout,
    openEditProfileModal: openEditProfile,
    openRosterModal: openRoster,
    openUserProfile: openProfile,
    openPrivateWindow: openDm,
    loadPublicMessages,
    sendPublicMessage,
    loadStories: loadProfileStories,
    loadPendingStories,
    loadRelationships: loadProfileRelationships,
    loadPendingRelationships,
    loadRelationshipTimeline: loadProfileTimeline,
    resendStoryApproval
  });

  window.__cw = {
    state,
    getSession,
    setSession,
    logout,
    openProfile,
    openDm,
    openRoster,
    loadAllUsers,
    loadPendingStories,
    loadPendingRelationships,
    resendStoryApproval
  };


/* ===================== utils-mobile.js (unique contributions) ===================== */
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




/* ===================== socket-mobile.js (unique contributions) ===================== */
/* ============================================================
   socket-mobile.js — Mobile version of socket.js
   Adapted from ./public/js/socket.js for ./public/mobile.html

   ID conversions:
     None — all IDs used by socket.js are function references
     that are already compatible with mobile.html.

   However, the mobile session flow differs:
     - updateProfileCard → updates meCard (meAvatar, meName, meHandle)
     - updateUIForSession → handled by mobile.js enterApp()
============================================================ */

const socket = io();

// Keep a single presence handler here; chat-mobile.js also listens and re-renders.
// Avoid duplicate relationship-approval popups (pm-mobile.js owns those handlers).

socket.on("connect", () => {
  const user = typeof getSession === "function" ? getSession() : null;
  if (user) {
    socket.emit("login", user);
  }
});

socket.on("forceLogout", ({ reason } = {}) => {
  if (typeof clearSession === "function") clearSession();
  localStorage.removeItem("currentUser");

  // MOBILE: update mobile UI elements instead of desktop profile card
  if (window.updateUIForSession) updateUIForSession();
  if (window.updateProfileCard) updateProfileCard(null);

  // MOBILE: hide all open panels and show auth screen
  const mainUI = document.getElementById('mainUI');
  const chatPopup = document.getElementById('chatPopup');
  const dmPopup = document.getElementById('dmPopup');
  const dmSidebar = document.getElementById('dmSidebar');
  const roomsSidebar = document.getElementById('roomsSidebar');
  const roomChatPopup = document.getElementById('roomChatPopup');

  if (mainUI) mainUI.style.display = 'none';
  if (chatPopup) chatPopup.style.display = 'none';
  if (dmPopup) dmPopup.style.display = 'none';
  if (dmSidebar) dmSidebar.style.display = 'none';
  if (roomsSidebar) roomsSidebar.style.display = 'none';
  if (roomChatPopup) roomChatPopup.style.display = 'none';

  // MOBILE: show auth screen
  const authScreen = document.getElementById('authScreen');
  if (authScreen) {
    authScreen.style.display = 'flex';
    authScreen.style.alignItems = 'center';
    authScreen.style.justifyContent = 'center';
  }

  if (reason === "banned") {
    alert("Your account has been banned.");
  }
});

// Re-export for modules that expect a global
window.socket = socket;


/* ===================== auth-mobile.js (unique contributions) ===================== */
/* ============================================================
   auth-mobile.js — Mobile version of auth.js
   Adapted from ./public/js/auth.js for ./public/mobile.html

   ID conversions:
     None — all IDs (btnLogin, modalLogin, loginCancel, loginSubmit,
     loginUser, loginPass, loginError) exist in mobile.html.

   Session flow differences:
     - After login, show mainUI and hide authScreen
     - After logout, show authScreen and hide mainUI + all panels
     - updateProfileCard → updates meCard (meAvatar, meName, meHandle)
============================================================ */

$('btnLogin').addEventListener('click', () => {
  show($('modalLogin'));
});
$('loginCancel').addEventListener('click', () => {
  hide($('modalLogin'));
});
$('loginSubmit').addEventListener('click', doLogin);
$('loginPass').addEventListener('keydown', e => { if(e.key === 'Enter') doLogin(); });

async function doLogin(){
  const username = $('loginUser').value.trim();
  const password = $('loginPass').value;
  const err = $('loginError');
  err.style.display = 'none';

  if(!username || !password){
    err.textContent = "Enter username and password";
    err.style.display = 'block';
    return;
  }

  try {
    const resp = await fetch('/api/login', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({username,password})
    });
    const data = await resp.json();

    if(!data.ok){
      err.textContent = data.error === 'banned' ? 'You are banned.' : 'Invalid credentials';
      err.style.display = 'block';
      return;
    }

    setSession(data.user);
    localStorage.setItem('currentUser', JSON.stringify(data.user));
    socket.emit('login', data.user);
    hide($('modalLogin'));

    // MOBILE: show mainUI, hide authScreen
    const authScreen = $('authScreen');
    const mainUI = $('mainUI');
    if (authScreen) authScreen.style.display = 'none';
    if (mainUI) mainUI.style.display = 'block';

    if (window.updateUIForSession) updateUIForSession();
    if (window.updateProfileCard) updateProfileCard(data.user);

    $('loginUser').value = '';
    $('loginPass').value = '';

    if (window.updateDMListSidebar) updateDMListSidebar();

  } catch(e){
    err.textContent = "Network error";
    err.style.display = 'block';
  }
}


window.logout = logout;


/* ===================== register-mobile.js (unique contributions) ===================== */
/* ============================================================
   register-mobile.js — Mobile version of register.js
   Adapted from ./public/js/register.js for ./public/mobile.html

   ID conversions:
     None — all IDs (btnRegister, modalRegister, regCancel,
     btnUploadImage, regImageFile, uploadStatus, regSubmit,
     regUser, regEmail, regPass, regDisplay, regAge, regWins,
     regLosses, regInfo, regColor, regLanguage, regError)
     exist in mobile.html.

   All API paths preserved.
============================================================ */

$('btnRegister').addEventListener('click', () => show($('modalRegister')));
$('regCancel').addEventListener('click', () => hide($('modalRegister')));

let uploadedImageUrl = '';

async function checkAvailability(username, email){
  const params = new URLSearchParams();
  if(username) params.append('username', username);
  if(email) params.append('email', email);
const res = await fetch("/api/check-availability", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username, email })
});
  return res.json();
}



$('btnUploadImage').addEventListener('click', async () => {
  const file = $('regImageFile').files[0];
  const status = $('uploadStatus');
  if(!file){ status.textContent = 'Select a file first'; return; }

  const form = new FormData();
  form.append('image', file);
  status.textContent = 'Uploading...';

  const resp = await fetch('/api/upload-image', { method:'POST', body:form });
  const data = await resp.json();

  if(data.ok){
  uploadedImageUrl = data.imageUrl;
  status.textContent = 'Uploaded';
} else {
    status.textContent = 'Upload failed';
  }
});

$('regSubmit').addEventListener('click', async () => {
  const username = $('regUser').value.trim().toLowerCase();
  const email = $('regEmail').value.trim().toLowerCase();
  const password = $('regPass').value;
  const display = $('regDisplay').value.trim() || username;
  const age = $('regAge').value;
  const wins = Number($('regWins').value || 0);
  const losses = Number($('regLosses').value || 0);
  const info = $('regInfo').value.trim();
  const color = $('regColor').value;
  const language = $('regLanguage').value;
  const err = $('regError');

  err.style.display = 'none';

  if(!username || !email || !password){
    err.textContent = 'Username, email, password required';
    err.style.display = 'block';
    return;
  }

  const avail = await checkAvailability(username, email);
  if(!avail.ok){
    const msgs = [];
    if(avail.conflict.username) msgs.push('username taken');
    if(avail.conflict.email) msgs.push('email in use');
    err.textContent = msgs.join(', ');
    err.style.display = 'block';
    return;
  }

  const payload = {
    username, email, password, display, age,
    stats:{wins,losses},
    info, color, language,
    imageUrl: uploadedImageUrl
  };

  const resp = await fetch('/api/register', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify(payload)
  });

  const data = await resp.json();

  if(data.ok){
    hide($('modalRegister'));
    // MOBILE: show login modal after registration
    show($('modalLogin'));
    alert('Account created. Please login.');
  } else {
    err.textContent = data.error || 'Registration failed';
    err.style.display = 'block';
  }
});


/* ===================== chat-mobile.js (unique contributions) ===================== */
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


/* ===================== pm-mobile.js (unique contributions) ===================== */
/* ============================================================
   pm-mobile.js — Mobile version of pm.js
   Adapted from ./public/js/pm.js for ./public/mobile.html

   ID conversions:
     Desktop (floating windows)    →  Mobile (full-screen popup)
     -------------------------------------------------------
     pmWindow_<user> (created)     →  dmPopup (existing)
     pmBody_<user> (created)       →  dmMessages (existing)
     pmInput_<user> (created)      →  dmInput (existing)
     pmSend_<user> (created)       →  dmSend (existing)
     pmImageBtn_<user> (created)   →  dmImageBtn (existing)
     pmImage_<user> (created)      →  dmImageInput (existing)
     pmTyping_<user> (created)     →  dmTyping (existing)
     .pm-close (created)           →  dmClose (existing)
     .pm-clear (created)           →  dmClear (existing)
     .pm-story (created)           →  dmStory (existing)
     dmSidebar .dm-list            →  dmSidebarList (direct id)

   All API paths, socket events, and function names are preserved.
============================================================ */

/* ============================================================
   SERVER-SYNCED DM SYSTEM (MongoDB + Translation + Images)
   — Mobile version using dmPopup full-screen overlay
============================================================ */

// Track the current DM partner
let currentDmPartner = null;

async function loadDMHistory(a, b) {
  const res = await fetch("/api/dm/history", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ a, b })
  });

  const data = await res.json();
  return data.messages || [];
}

/* ---------- Upload Image Using FormData (matches your server) ---------- */

async function uploadImageToServer(file) {
  const form = new FormData();
  form.append("image", file); // MUST be "image" to match multer.single('image')

  const res = await fetch("/api/upload-image", {
    method: "POST",
    body: form
  });

  return await res.json(); // { ok:true, imageUrl:"..." }
}

async function uploadDMImage(targetUsername, file) {
  const data = await uploadImageToServer(file);

  if (!data.ok) {
    alert("Image upload failed");
    return;
  }

  socket.emit("privateMessage", {
    from: getSession().username,
    to: targetUsername,
    imageUrl: data.imageUrl
  });
}

/* ---------- Open DM Window (MOBILE: uses dmPopup) ---------- */

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

  // MOBILE: use the existing dmPopup full-screen overlay
  const popup = document.getElementById("dmPopup");
  const title = document.getElementById("dmTitle");
  const body = document.getElementById("dmMessages");
  const typing = document.getElementById("dmTyping");

  if (!popup || !body) return;

  // Set current partner
  currentDmPartner = targetUsername;
  popup.dataset.partner = targetUsername;

  // Set title
  if (title) title.textContent = "@" + targetUsername;

  // Hide typing indicator
  if (typing) typing.style.display = "none";

  // Clear unread
  clearUnread(targetUsername);
  if (window.updateDMListSidebar) updateDMListSidebar();
  updateDMBadge();

  // Show the popup
  popup.style.display = "flex";

  // Load history
  body.innerHTML = '<div class="small muted">Loading…</div>';

  loadDMHistory(s.username, targetUsername).then(history => {
    body.innerHTML = "";
    renderDMMessages(targetUsername, history);
  });

  // Close any open modals
  const modalRoster = document.getElementById("modalRoster");
  const modalViewProfile = document.getElementById("modalViewProfile");
  if (modalRoster) modalRoster.style.display = "none";
  if (modalViewProfile) modalViewProfile.style.display = "none";
}

// Expose globally so chat-mobile.js / roster / profile can open DMs
window.openPrivateWindow = openPrivateWindow;

/* ---------- Send DM (MOBILE: uses dmInput / dmSend) ---------- */

function sendPM(targetUsername) {
  const s = getSession();
  if (!s) return;

  // MOBILE: use dmInput instead of pmInput_<user>
  const input = document.getElementById("dmInput");
  if (!input) return;

  const text = input.value.trim();
  if (!text) return;

  const message = {
    from: s.username,
    to: targetUsername,
    text
  };

  socket.emit("privateMessage", message);
  input.value = "";
}

/* ---------- Render DM Messages (MOBILE: uses dmMessages) ---------- */

function renderDMMessages(targetUsername, messages) {
  const s = getSession();
  const body = document.getElementById("dmMessages");
  if (!body) return;

  // Preserve typing indicator
  const typingEl = document.getElementById("dmTyping");

  // Don't clear the whole body — just append or re-render
  body.innerHTML = "";

  messages.forEach(m => {
    // Skip SYSTEM messages that aren't for this conversation partner
    if (m.from === "SYSTEM" && m.to !== s.username) return;

    const div = document.createElement("div");
    div.className = "message-row " + (m.from === s.username ? "me" : "");

    const avatarHtml = renderMessageAvatar
      ? renderMessageAvatar(m.from, m.display || m.from, m.imageUrl, 36)
      : `<div class="avatar-fallback" style="width:36px;height:36px">${(m.from || '?')[0].toUpperCase()}</div>`;

    let contentHtml = '';

    if (m.type === "storyApproval") {
      div.className = "message-row system";
      contentHtml = `
        <div class="system-msg">
          ${escapeHtml(m.text || "")}
          <button class="small-btn approveStoryBtn" data-id="${m.storyId || ""}">Approve</button>
        </div>
      `;
    } else if (m.type === "relationshipApproval") {
      div.className = "message-row system";
      contentHtml = `
        <div class="system-msg">
          ${escapeHtml(m.text || "")}
          <button class="small-btn approveRelBtn" data-rel-id="${m.relationshipId || ""}">Approve</button>
        </div>
      `;
    } else if (m.imageUrl) {
      contentHtml = `<img src="${m.imageUrl}" class="chat-image" style="max-width:220px;border-radius:8px;margin-top:6px;cursor:pointer" data-url="${m.imageUrl}">`;
    } else {
      contentHtml = `<div>${escapeHtml(m.text || "")}</div>`;
    }

    div.innerHTML = `
      <div class="message-avatar">${avatarHtml}</div>
      <div class="message">
        <div style="font-weight:700">${escapeHtml(m.from || "")}</div>
        ${contentHtml}
      </div>
    `;

    // Clickable images
    div.querySelectorAll('.chat-image').forEach(img => {
      img.addEventListener('click', () => window.open(img.dataset.url, '_blank'));
    });

    body.appendChild(div);
  });

  // Re-append typing indicator
  if (typingEl) body.appendChild(typingEl);
  body.scrollTop = body.scrollHeight;
}

/* ---------- Click handlers for approval buttons ---------- */

document.addEventListener("click", async (e) => {
  if (e.target.classList.contains("approveRelBtn")) {
    const relationshipId = e.target.dataset.relId;

    if (!relationshipId) {
      console.error("Missing relationshipId");
      return;
    }

    const res = await fetch("/api/relationship/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ relationshipId })
    });

    const data = await res.json();
    if (data.ok) {
      e.target.parentElement.innerHTML = `
        <div class="tiny">Relationship approved</div>
      `;
    }
  }
});

document.addEventListener("click", async (e) => {
  if (e.target.classList.contains("approveStoryBtn")) {
    const storyId = e.target.dataset.id;

    const res = await fetch("/api/story/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ storyId })
    });

    const data = await res.json();
    if (data.ok) {
      alert("Story approved");
      e.target.parentElement.innerHTML = "Approved";
    }
  }
});

/* ---------- Story Popup ---------- */


/* ============================================================
   RECEIVE DM FROM SERVER
============================================================ */

socket.on("privateMessage", pm => {
  const me = getSession();
  if (!me) return;

  // Don't count our own echo as unread
  const other = pm.from === me.username ? pm.to : pm.from;
  if (!other || other === me.username) return;

  // MOBILE: if the dmPopup is open and showing this partner, append message
  const popup = document.getElementById("dmPopup");
  const body = document.getElementById("dmMessages");
  const isOpen = popup && popup.style.display !== "none" && currentDmPartner === other;

  if (isOpen && body) {
    // Append the new message to the current view
    renderDMMessages(other, [pm]); // append single message
    // Actually, we need to maintain history. Let's just append directly.
    // We'll re-render by appending the message element
    appendSingleDMMessage(pm, me);
    body.scrollTop = body.scrollHeight;
  } else if (pm.from !== me.username) {
    incrementUnread(other);
    if (window.updateDMListSidebar) updateDMListSidebar();
    updateDMBadge();
  }
});

/* ---------- Append a single DM message without clearing ---------- */
function appendSingleDMMessage(pm, me) {
  const body = document.getElementById("dmMessages");
  if (!body) return;

  const typingEl = document.getElementById("dmTyping");

  const div = document.createElement("div");
  div.className = "message-row " + (pm.from === me.username ? "me" : "");

  const avatarHtml = typeof renderMessageAvatar === 'function'
    ? renderMessageAvatar(pm.from, pm.display || pm.from, pm.imageUrl, 36)
    : `<div class="avatar-fallback" style="width:36px;height:36px">${(pm.from || '?')[0].toUpperCase()}</div>`;

  let contentHtml = '';

  if (pm.type === "storyApproval") {
    div.className = "message-row system";
    contentHtml = `
      <div class="system-msg">
        ${escapeHtml(pm.text || "")}
        <button class="small-btn approveStoryBtn" data-id="${pm.storyId || ""}">Approve</button>
      </div>
    `;
  } else if (pm.type === "relationshipApproval") {
    div.className = "message-row system";
    contentHtml = `
      <div class="system-msg">
        ${escapeHtml(pm.text || "")}
        <button class="small-btn approveRelBtn" data-rel-id="${pm.relationshipId || ""}">Approve</button>
      </div>
    `;
  } else if (pm.imageUrl) {
    contentHtml = `<img src="${pm.imageUrl}" class="chat-image" style="max-width:220px;border-radius:8px;margin-top:6px;cursor:pointer" data-url="${pm.imageUrl}">`;
  } else {
    contentHtml = `<div>${escapeHtml(pm.text || "")}</div>`;
  }

  div.innerHTML = `
    <div class="message-avatar">${avatarHtml}</div>
    <div class="message">
      <div style="font-weight:700">${escapeHtml(pm.from || "")}</div>
      ${contentHtml}
    </div>
  `;

  div.querySelectorAll('.chat-image').forEach(img => {
    img.addEventListener('click', () => window.open(img.dataset.url, '_blank'));
  });

  // Insert before typing indicator if present
  if (typingEl && typingEl.parentNode === body) {
    body.insertBefore(div, typingEl);
  } else {
    body.appendChild(div);
  }
}

function updateDMBadge() {
  const badge = document.getElementById("dmBadge");
  if (!badge) return;

  const map = typeof getUnreadMap === "function" ? getUnreadMap() : {};
  const total = Object.values(map).reduce((sum, n) => sum + (Number(n) || 0), 0);

  if (total > 0) {
    badge.textContent = total > 99 ? "99+" : String(total);
    badge.style.display = "inline-block";
  } else {
    badge.textContent = "";
    badge.style.display = "none";
  }
}

window.updateDMBadge = updateDMBadge;

// Refresh badge on load
document.addEventListener("DOMContentLoaded", updateDMBadge);

/* ---------- Typing Indicator Receive ---------- */

socket.on("typingDM", ({ from }) => {
  // MOBILE: only show if dmPopup is open and showing this partner
  if (currentDmPartner === from) {
    const el = document.getElementById("dmTyping");
    if (el) {
      el.textContent = `${from} is typing...`;
      el.style.display = "block";
    }
  }
});

socket.on("stopTypingDM", ({ from }) => {
  if (currentDmPartner === from) {
    const el = document.getElementById("dmTyping");
    if (el) el.style.display = "none";
  }
});

/* ============================================================
   DM SIDEBAR (MOBILE: uses dmSidebarList directly)
============================================================ */

function updateDMListSidebar() {
  const sidebar = document.getElementById("dmSidebar");
  if (!sidebar) return;

  const user = getSession();
  // MOBILE: use dmSidebarList directly instead of querySelector('.dm-list')
  const listContainer = document.getElementById("dmSidebarList");
  const searchInput = document.getElementById("dmSearch");

  if (!user) {
    if (listContainer) {
      listContainer.innerHTML = '<div class="small muted">Login to see DMs</div>';
    }
    updateDMBadge();
    return;
  }

  const unread = getUnreadMap();

  fetch("/api/dm/partners", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: user.username })
  })
    .then(res => res.json())
    .then(data => {
      let partners = (data.partners || []).filter(p => p && p !== "SYSTEM" && p !== user.username);

      const target = listContainer || (() => {
        const el = document.createElement("div");
        el.id = "dmSidebarList";
        sidebar.appendChild(el);
        return el;
      })();

      const renderList = (filterTerm = "") => {
        target.innerHTML = "";

        partners.forEach(other => {
          if (filterTerm && !other.toLowerCase().includes(filterTerm.toLowerCase())) return;

          const item = document.createElement("div");
          item.className = "dm-sidebar-item";
          item.innerHTML = `
            <span>@${escapeHtml(other)}</span>
            ${unread[other] ? `<span class="badge">${unread[other]}</span>` : ""}
          `;
          item.addEventListener("click", () => {
            openPrivateWindow(other);
            sidebar.style.display = "none";
          });
          target.appendChild(item);
        });

        if (!target.innerHTML) {
          target.innerHTML = '<div class="small muted">No DMs yet</div>';
        }
      };

      renderList(searchInput?.value?.trim() || "");

      if (searchInput && !searchInput._dmBound) {
        searchInput._dmBound = true;
        searchInput.addEventListener("input", e => {
          renderList(e.target.value.trim());
        });
      }

      updateDMBadge();
    })
    .catch(err => console.error("DM partners error", err));
}

window.updateDMListSidebar = updateDMListSidebar;

/* ============================================================
   DM POPUP BUTTON HANDLERS (MOBILE: static buttons in HTML)
============================================================ */

// Close DM popup
document.getElementById("dmClose")?.addEventListener("click", () => {
  const popup = document.getElementById("dmPopup");
  if (popup) popup.style.display = "none";
  currentDmPartner = null;
});

// Send DM
document.getElementById("dmSend")?.addEventListener("click", () => {
  if (currentDmPartner) sendPM(currentDmPartner);
});

// Enter key to send
document.getElementById("dmInput")?.addEventListener("keydown", e => {
  if (e.key === "Enter" && currentDmPartner) sendPM(currentDmPartner);
});

// DM typing indicator
let dmTypingTimer;
document.getElementById("dmInput")?.addEventListener("input", () => {
  const s = getSession();
  if (!s || !currentDmPartner) return;

  socket.emit("typingDM", { from: s.username, to: currentDmPartner });

  clearTimeout(dmTypingTimer);
  dmTypingTimer = setTimeout(() => {
    socket.emit("stopTypingDM", { from: s.username, to: currentDmPartner });
  }, 1200);
});

// Clear DM history
document.getElementById("dmClear")?.addEventListener("click", async () => {
  const s = getSession();
  if (!s || !currentDmPartner) return;
  if (!confirm("Clear this DM history?")) return;

  await fetch("/api/dm/clear", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ a: s.username, b: currentDmPartner })
  });

  clearUnread(currentDmPartner);
  const body = document.getElementById("dmMessages");
  if (body) body.innerHTML = "";
  if (window.updateDMListSidebar) updateDMListSidebar();
});

// Story popup
document.getElementById("dmStory")?.addEventListener("click", () => {
  if (currentDmPartner) openStoryPopup(currentDmPartner);
});

// DM image upload
document.getElementById("dmImageBtn")?.addEventListener("click", () => {
  const input = document.getElementById("dmImageInput");
  if (input) input.click();
});

document.getElementById("dmImageInput")?.addEventListener("change", e => {
  const file = e.target.files[0];
  if (file && currentDmPartner) uploadDMImage(currentDmPartner, file);
  e.target.value = "";
});

/* ============================================================
   STORY / RELATIONSHIP APPROVAL POPUPS
============================================================ */

socket.on("storyApprovalRequest", data => {
  const { storyId, from } = data;

  const popup = document.createElement("div");
  popup.className = "modal";
  popup.innerHTML = `
    <div class="modal-box">
      <div class="modal-header">
        <h3>Story Approval Request</h3>
      </div>
      <p>${from} created a story involving your messages.</p>
      <div class="modal-buttons">
        <button id="approveStoryBtn" class="small-btn" type="button">Approve</button>
        <button id="denyStoryBtn" class="ghost small-btn" type="button">Deny</button>
      </div>
    </div>
  `;
  document.body.appendChild(popup);

  document.getElementById("approveStoryBtn").onclick = async () => {
    await fetch("/api/story/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ storyId })
    });
    popup.remove();
  };

  document.getElementById("denyStoryBtn").onclick = () => {
    popup.remove();
  };
});

socket.on("relationshipApprovalRequest", data => {
  const { relationshipId, from, type } = data;

  const popup = document.createElement("div");
  popup.className = "modal";
  popup.innerHTML = `
    <div class="modal-box">
      <div class="modal-header">
        <h3>Relationship Request</h3>
      </div>
      <p>${from} wants to add: <strong>${type}</strong></p>
      <div class="modal-buttons">
        <button id="approveRelBtn" class="small-btn" type="button">Approve</button>
        <button id="denyRelBtn" class="ghost small-btn" type="button">Deny</button>
      </div>
    </div>
  `;
  document.body.appendChild(popup);

  document.getElementById("approveRelBtn").onclick = async () => {
    await fetch("/api/relationship/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ relationshipId })
    });
    popup.remove();
  };

  document.getElementById("denyRelBtn").onclick = () => popup.remove();
});


/* ===================== admin-mobile.js (unique contributions) ===================== */
/* ============================================================
   admin-mobile.js — Mobile version of admin.js
   Adapted from ./public/js/admin.js for ./public/mobile.html

   ID conversions:
     None — all IDs (adminTable, adminUsersView, adminAnalyticsView,
     modalAdmin, tabUsers, tabAnalytics, adminSearch, adminClose)
     exist in mobile.html.

   Note:
     - statsSummary and topIpsList don't exist in mobile.html
       (analytics section is disabled in mobile admin panel)
     - The analytics tab shows a placeholder message instead
============================================================ */

/* -----------------------------------------------------------
   ADMIN PANEL (CSP-SAFE VERSION — MOBILE)
----------------------------------------------------------- */

window.loadAdminPanel = async function loadAdminPanel() {
  try {
    const res = await fetch('/api/admin/users', {
      headers: { 'x-admin-key': window.adminSessionKey }
    });

    const data = await res.json();
    if (!data.ok) {
      alert('Admin access denied');
      return;
    }

    const tbody = document.querySelector('#adminTable tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    (data.users || []).forEach(u => {
      const row = document.createElement('tr');
      row.dataset.username = u.username;

      row.innerHTML = `
        <td>${escapeHtml(u.username || '')}</td>
        <td>${escapeHtml(u.email || '')}</td>
        <td>${escapeHtml(u.role || 'user')}</td>
        <td>${u.online ? '🟢' : '⚪'}</td>
        <td>${u.banned ? '🚫' : '✔'}</td>
        <td>
          <button class="small-btn admin-ban">${u.banned ? 'Unban' : 'Ban'}</button>
          <button class="small-btn admin-reset">Reset PW</button>
          <button class="small-btn admin-delete">Delete</button>
        </td>
      `;

      tbody.appendChild(row);
    });

    // Default to users tab
    showAdminTab('users');

    const modal = document.getElementById('modalAdmin');
    if (modal) {
      modal.style.display = 'flex';
      modal.style.alignItems = 'center';
      modal.style.justifyContent = 'center';
    }
  } catch (err) {
    console.error('loadAdminPanel error', err);
    alert('Failed to load admin panel');
  }
};


/* ===================== admin-auth-mobile.js (unique contributions) ===================== */
/* ============================================================
   admin-auth-mobile.js — Mobile version of admin-auth.js
   Adapted from ./public/js/admin-auth.js for ./public/mobile.html

   ID conversions:
     Desktop ID                →  Mobile ID
     -------------------------------------------------------
     btnAdmin                  →  (not in mobile — use prompt-based auth)
     modalAdminPassword        →  (not in mobile — use prompt() instead)
     adminPasswordCancel       →  (not in mobile)
     adminPasswordSubmit       →  (not in mobile)
     adminPasswordInput        →  (not in mobile)
     adminPasswordError        →  (not in mobile)

   Mobile uses prompt()-based admin auth instead of a modal,
   since mobile.html doesn't have a dedicated admin password modal.
   This matches the approach used by mobile.js's promptAdminKey().
============================================================ */

window.adminSessionKey = null;

/* Open Admin — Mobile uses prompt() instead of modalAdminPassword */
function openAdminAuth() {
  if (window.adminSessionKey) {
    if (window.loadAdminPanel) window.loadAdminPanel();
    return;
  }

  const input = prompt("Enter admin password:");
  if (!input) return;

  verifyAdminKey(input);
}

async function verifyAdminKey(input) {
  try {
    const resp = await fetch("/api/admin/users", {
      headers: { "x-admin-key": input }
    });

    const data = await resp.json();

    if (!data.ok) {
      alert("Incorrect admin password.");
      return;
    }

    window.adminSessionKey = input;

    if (window.loadAdminPanel) window.loadAdminPanel();
  } catch (err) {
    alert("Network error while verifying admin password.");
  }
}

// MOBILE: listen for clicks on any element that should open admin
// Since mobile.html doesn't have a dedicated #btnAdmin, we check
// for the admin panel trigger from mobile.js or other sources
document.addEventListener("click", (e) => {
  // Support both a dedicated btnAdmin and the mobile.js admin trigger
  if (e.target.id === "btnAdmin" || e.target.classList.contains("admin-trigger")) {
    e.preventDefault();
    openAdminAuth();
  }
});

// Expose for mobile.js to call directly
window.openAdminAuth = openAdminAuth;


/* ===================== analytics-mobile.js (unique contributions) ===================== */
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


/* ===================== dm-toggle-mobile.js (unique contributions) ===================== */
/* ============================================================
   dm-toggle-mobile.js — Mobile version of dm-toggle.js
   Adapted from ./public/js/dm-toggle.js for ./public/mobile.html

   ID conversions:
     None — all IDs (btnDMs, dmSidebar, closeDmSidebar,
     btnRooms, roomsSidebar, closeRoomsSidebar) exist in mobile.html.

   All API paths and function names preserved.
============================================================ */

document.getElementById("btnDMs")?.addEventListener("click", () => {
  const panel = document.getElementById("dmSidebar");
  if (!panel) return;
  panel.style.display = "flex";
  if (window.updateDMListSidebar) window.updateDMListSidebar();
  if (window.updateDMBadge) window.updateDMBadge();
});

document.getElementById("btnRooms")?.addEventListener("click", () => {
  const panel = document.getElementById("roomsSidebar");
  if (!panel) return;
  panel.style.display = "flex";
  if (typeof renderRoomsSidebar === "function") renderRoomsSidebar();
});

document.getElementById("closeDmSidebar")?.addEventListener("click", () => {
  const panel = document.getElementById("dmSidebar");
  if (panel) panel.style.display = "none";
});

document.getElementById("closeRoomsSidebar")?.addEventListener("click", () => {
  const panel = document.getElementById("roomsSidebar");
  if (panel) panel.style.display = "none";
});


/* ===================== profile-mobile.js (unique contributions) ===================== */
/* ============================================================
   profile-mobile.js — Mobile version of profile.js
   Adapted from ./public/js/profile.js for ./public/mobile.html

   ID conversions:
     None — all IDs (editDisplay, editAge, editInfo, editColor,
     editLanguage, editWins, editLosses, editImageFile,
     editUploadStatus, btnEditUploadImage, modalEditProfile,
     editCancel, editSubmit, editError) exist in mobile.html.

   Session flow differences:
     - After saving profile, update meCard (meAvatar, meName, meHandle)
       instead of desktop userProfileCard
============================================================ */

/* -----------------------------------------------------------
   PROFILE EDIT LOGIC
----------------------------------------------------------- */


/* Called by utils-mobile.js when user clicks Edit Profile */
window.openEditProfileModal = function(user) {
  if (!user) return;

  // Pre-fill modal fields
  $("editDisplay").value = user.display || user.displayName || user.username;
  $("editAge").value = user.age || "";
  $("editInfo").value = user.info || "";
  $("editColor").value = user.color || "#ffffff";
  $("editLanguage").value = user.language || "en";
  $("editWins").value = user.stats?.wins || 0;
  $("editLosses").value = user.stats?.losses || 0;

  editImageUrl = user.imageUrl || "";

  const status = $("editUploadStatus");
  if (status) status.textContent = editImageUrl ? "Current image kept" : "No image uploaded";

  show($("modalEditProfile"));
};

/* Cancel button */
$("editCancel").addEventListener("click", () => {
  hide($("modalEditProfile"));
});

/* Upload new profile image */
$("btnEditUploadImage").addEventListener("click", async () => {
  const file = $("editImageFile").files[0];
  const status = $("editUploadStatus");

  if (!file) {
    status.textContent = "Select a file first";
    return;
  }

  const form = new FormData();
  form.append("image", file);

  status.textContent = "Uploading...";

  try {
    const resp = await fetch("/api/upload-image", {
      method: "POST",
      body: form
    });

    const data = await resp.json();

    if (data.ok) {
      editImageUrl = data.imageUrl;
      status.textContent = "Uploaded";
    } else {
      status.textContent = "Upload failed";
    }
  } catch (e) {
    console.error("Upload error", e);
    status.textContent = "Upload error";
  }
});

/* Save profile changes */
$("editSubmit").addEventListener("click", async () => {
  const user = getSession();
  if (!user) return;

  const updates = {
    display: $("editDisplay").value.trim(),
    age: Number($("editAge").value),
    info: $("editInfo").value.trim(),
    color: $("editColor").value,
    language: $("editLanguage").value,
    stats: {
      wins: Number($("editWins").value),
      losses: Number($("editLosses").value)
    },
    imageUrl: editImageUrl
  };

  try {
    const resp = await fetch("/api/update-profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: user.username,
        updates
      })
    });

    const data = await resp.json();

    if (!data.ok) {
      $("editError").textContent = data.error || "Update failed";
      $("editError").style.display = "block";
      return;
    }

    // Update session + localStorage
    setSession(data.user);
    localStorage.setItem("currentUser", JSON.stringify(data.user));

    // MOBILE: update meCard instead of desktop userProfileCard
    if (window.updateProfileCard) updateProfileCard(data.user);

    hide($("modalEditProfile"));

  } catch (e) {
    console.error("Profile update error", e);
    $("editError").textContent = "Server error";
    $("editError").style.display = "block";
  }
});


/* ===================== landing-mobile.js (unique contributions) ===================== */
/* ============================================================
   landing-mobile.js — Mobile version of landing.js
   Adapted from ./public/js/landing.js for ./public/mobile.html

   ID conversions:
     None — all IDs (ageGate, introGif, confirmBtn) exist in mobile.html.

   Timing differences:
     - Desktop uses 8s GIF display; mobile uses faster fade (2.5s)
       matching mobile.css and mobile.js conventions
============================================================ */

document.addEventListener("DOMContentLoaded", () => {
  const gate = document.getElementById("ageGate");
  const gif = document.getElementById("introGif");
  const btn = document.getElementById("confirmBtn");

  if (!gate || !gif || !btn) return;

  btn.addEventListener("click", () => {
    gif.style.backgroundImage = "url('./images/intro.gif')";
    gif.style.display = "block";
    gif.style.opacity = "1";
    gate.style.transition = "opacity .4s";
    gate.style.opacity = "0";

    // MOBILE: faster fade than desktop (2.5s vs 8s)
    setTimeout(() => {
      gif.style.opacity = "0";
    }, 2500);

    setTimeout(() => {
      gate.style.display = "none";
      gif.style.display = "none";

      // MOBILE: show auth screen after age gate
      const authScreen = document.getElementById('authScreen');
      const session = typeof getSession === 'function' ? getSession() : null;

      if (session) {
        // Already logged in — show main UI
        const mainUI = document.getElementById('mainUI');
        if (mainUI) mainUI.style.display = 'block';
        if (window.updateUIForSession) updateUIForSession();
        if (window.updateProfileCard) updateProfileCard(session);
      } else if (authScreen) {
        authScreen.style.display = 'flex';
        authScreen.style.alignItems = 'center';
        authScreen.style.justifyContent = 'center';
      }
    }, 3200);
  });
});


  /* ===================== END ORIGINAL mobile.js ===================== */
})();

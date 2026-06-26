/* ============================================================
   SERVER-SYNCED DM SYSTEM (MongoDB + Translation)
============================================================ */

async function loadDMHistory(a, b) {
  const res = await fetch("/api/dm/history", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ a, b })
  });

  const data = await res.json();
  return data.messages || [];
}

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

  // If window already exists → bring it forward + clear unread
  const existing = document.getElementById("pmWindow_" + targetUsername);
  if (existing) {
    clearUnread(targetUsername);
    if (window.updateDMListSidebar) updateDMListSidebar();
    return;
  }

  // CREATE WINDOW
  const pmWindow = document.createElement("div");
  pmWindow.className = "pm-window";
  pmWindow.id = "pmWindow_" + targetUsername;

  pmWindow.innerHTML = `
    <div class="pm-header">
      <div style="display:flex;gap:8px;align-items:center">
        <div class="avatar" style="width:36px;height:36px">${targetUsername[0].toUpperCase()}</div>
        <div>
          <div style="font-weight:700">${targetUsername}</div>
          <div class="small">@${targetUsername}</div>
        </div>
      </div>
      <div style="display:flex;gap:6px;align-items:center">
        <button class="small-btn pm-clear">Clear</button>
        <button class="small-btn pm-close">X</button>
      </div>
    </div>

    <div class="pm-body" id="pmBody_${targetUsername}"></div>

    <div class="pm-input">
      <input id="pmInput_${targetUsername}" type="text" placeholder="Message ${targetUsername}">
      <button class="small-btn" id="pmSend_${targetUsername}">Send</button>
    </div>
  `;

  document.body.appendChild(pmWindow);

  // TYPING INDICATOR
  const typing = document.createElement("div");
  typing.id = "pmTyping_" + targetUsername;
  typing.className = "small muted";
  typing.style.display = "none";
  typing.textContent = `${targetUsername} is typing...`;
  pmWindow.querySelector(".pm-body").appendChild(typing);

  // CLOSE WINDOW
  pmWindow.querySelector(".pm-close").addEventListener("click", () => {
    pmWindow.remove();
  });

  // CLEAR HISTORY (server + UI)
  pmWindow.querySelector(".pm-clear").addEventListener("click", async () => {
    if (!confirm("Clear this DM history?")) return;

    await fetch("/api/dm/clear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ a: s.username, b: targetUsername })
    });

    clearUnread(targetUsername);
    renderPMHistory(targetUsername, []);
    const body = document.getElementById("pmBody_" + targetUsername);
    if (body) body._history = [];
    if (window.updateDMListSidebar) updateDMListSidebar();
  });

  // TYPING EVENTS
  let typingTimeout;

  document
    .getElementById("pmInput_" + targetUsername)
    .addEventListener("input", () => {
      socket.emit("typingDM", {
        from: s.username,
        to: targetUsername
      });

      clearTimeout(typingTimeout);
      typingTimeout = setTimeout(() => {
        socket.emit("stopTypingDM", {
          from: s.username,
          to: targetUsername
        });
      }, 1200);
    });

  // SEND MESSAGE
  document
    .getElementById("pmSend_" + targetUsername)
    .addEventListener("click", () => sendPM(targetUsername));

  document
    .getElementById("pmInput_" + targetUsername)
    .addEventListener("keydown", e => {
      if (e.key === "Enter") sendPM(targetUsername);
    });

  // LOAD HISTORY FROM SERVER
  loadDMHistory(s.username, targetUsername).then(history => {
    const body = document.getElementById("pmBody_" + targetUsername);
    if (body) body._history = history;
    renderPMHistory(targetUsername, history);
  });

  clearUnread(targetUsername);
  if (window.updateDMListSidebar) updateDMListSidebar();
}

function sendPM(targetUsername) {
  const s = getSession();
  if (!s) return;

  const input = document.getElementById("pmInput_" + targetUsername);
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

function renderPMHistory(targetUsername, messages) {
  const s = getSession();
  const body = document.getElementById("pmBody_" + targetUsername);
  if (!body) return;

  body.innerHTML = "";

  messages.forEach(m => {
    const div = document.createElement("div");
    div.className = "message " + (m.from === s.username ? "me" : "");
    div.innerHTML = `
      <div style="font-size:13px;font-weight:700">${m.from}</div>
      <div style="margin-top:6px">${escapeHtml(m.text)}</div>
    `;
    body.appendChild(div);
  });

  body.scrollTop = body.scrollHeight;
}

/* ============================================================
   RECEIVE DM FROM SERVER
============================================================ */
socket.on("privateMessage", pm => {
  const me = getSession();
  if (!me) return;

  const other = pm.from === me.username ? pm.to : pm.from;
  const body = document.getElementById("pmBody_" + other);

  if (body) {
    const existing = body._history || [];
    const updated = [...existing, pm];
    body._history = updated;
    renderPMHistory(other, updated);
  } else {
    incrementUnread(other);
    if (window.updateDMListSidebar) updateDMListSidebar();
  }
});

/* TYPING INDICATOR RECEIVE */
socket.on("typingDM", ({ from }) => {
  const el = document.getElementById("pmTyping_" + from);
  if (el) el.style.display = "block";
});

socket.on("stopTypingDM", ({ from }) => {
  const el = document.getElementById("pmTyping_" + from);
  if (el) el.style.display = "none";
});

/* ============================================================
   DM SIDEBAR
============================================================ */
function updateDMListSidebar() {
  const sidebar = document.getElementById("dmSidebar");
  if (!sidebar) return;

  const user = getSession();
  if (!user) {
    sidebar.innerHTML = '<div class="small" style="color:var(--muted)">Login to see DMs</div>';
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
      const partners = data.partners || [];

      sidebar.innerHTML = "";

      const search = document.createElement("input");
      search.id = "dmSearch";
      search.className = "dm-search";
      search.placeholder = "Search DMs";
      sidebar.appendChild(search);

      const listContainer = document.createElement("div");
      listContainer.id = "dmSidebarList";
      sidebar.appendChild(listContainer);

      const renderList = (filterTerm = "") => {
        listContainer.innerHTML = "";

        partners.forEach(other => {
          if (filterTerm && !other.toLowerCase().includes(filterTerm.toLowerCase())) return;

          const item = document.createElement("div");
          item.className = "dm-sidebar-item";
          item.innerHTML = `
            <span>@${other}</span>
            ${unread[other] ? `<span class="dm-unread-badge">${unread[other]}</span>` : ""}
          `;
          item.addEventListener("click", () => openPrivateWindow(other));
          listContainer.appendChild(item);
        });

        if (!listContainer.innerHTML) {
          listContainer.innerHTML = '<div class="small" style="color:var(--muted)">No DMs yet</div>';
        }
      };

      renderList();

      search.addEventListener("input", e => {
        renderList(e.target.value.trim());
      });
    });
}

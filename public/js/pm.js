/* ============================================================
   SERVER-SYNCED DM SYSTEM (MongoDB + Translation + Images)
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

/* ---------- Upload Image Using FormData (matches your server) ---------- */

async function uploadImageToServer(file) {
  const form = new FormData();
  form.append("image", file); // MUST be "image" to match multer.single('image')

  const res = await fetch("/api/upload-image", {
    method: "POST",
    body: form
  });

  return await res.json(); // { ok:true, url:"..." }
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

/* ---------- Open DM Window ---------- */

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

  const existing = document.getElementById("pmWindow_" + targetUsername);
  if (existing) {
    clearUnread(targetUsername);
    if (window.updateDMListSidebar) updateDMListSidebar();
    return;
  }

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
  <button class="small-btn pm-story">Story</button>
  <button class="small-btn pm-clear">Clear</button>
  <button class="small-btn pm-close">X</button>
</div>
    </div>

    <div class="pm-body" id="pmBody_${targetUsername}"></div>

    <div class="pm-input">
      <input id="pmInput_${targetUsername}" type="text" placeholder="Message ${targetUsername}">
      <input type="file" id="pmImage_${targetUsername}" accept="image/*" style="display:none">
      <button class="small-btn" id="pmImageBtn_${targetUsername}">📷</button>
      <button class="small-btn" id="pmSend_${targetUsername}">Send</button>
    </div>
  `;

  document.body.appendChild(pmWindow);

  const typing = document.createElement("div");
  typing.id = "pmTyping_" + targetUsername;
  typing.className = "small muted";
  typing.style.display = "none";
  typing.textContent = `${targetUsername} is typing...`;
  pmWindow.querySelector(".pm-body").appendChild(typing);

  pmWindow.querySelector(".pm-close").addEventListener("click", () => {
    pmWindow.remove();
  });

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

  document
    .getElementById("pmSend_" + targetUsername)
    .addEventListener("click", () => sendPM(targetUsername));

  document
    .getElementById("pmInput_" + targetUsername)
    .addEventListener("keydown", e => {
      if (e.key === "Enter") sendPM(targetUsername);
    });
pmWindow.querySelector(".pm-story").addEventListener("click", () => {
  openStoryPopup(targetUsername);
});

  /* ---------- DM Image Upload Buttons (now correct) ---------- */

  document
    .getElementById("pmImageBtn_" + targetUsername)
    .addEventListener("click", () => {
      document.getElementById("pmImage_" + targetUsername).click();
    });

  document
    .getElementById("pmImage_" + targetUsername)
    .addEventListener("change", e => {
      const file = e.target.files[0];
      if (file) uploadDMImage(targetUsername, file);
    });

  loadDMHistory(s.username, targetUsername).then(history => {
    const body = document.getElementById("pmBody_" + targetUsername);
    if (body) body._history = history;
    renderPMHistory(targetUsername, history);
  });

  clearUnread(targetUsername);
  if (window.updateDMListSidebar) updateDMListSidebar();
}

/* ---------- Send DM ---------- */

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

/* ---------- Render DM History ---------- */

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
      <div style="margin-top:6px">${escapeHtml(m.text || "")}</div>
    `;

    if (m.imageUrl) {
      div.innerHTML += `
        <img src="${m.imageUrl}" class="chat-image" onclick="window.open('${m.imageUrl}', '_blank')">
      `;
    }

    body.appendChild(div);
  });

  body.scrollTop = body.scrollHeight;
}

function openStoryPopup(targetUsername) {
  const popup = document.getElementById("storyPopup");
  popup.style.display = "flex";

  document.getElementById("storyEditor").value = "";
  document.getElementById("storyDate").value = "";

  document.getElementById("storyLoadBtn").onclick = async () => {
    const date = document.getElementById("storyDate").value;
    if (!date) return alert("Choose a date first");

    const res = await fetch("/api/story/load", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        a: getSession().username,
        b: targetUsername,
        fromDate: date
      })
    });

    const data = await res.json();
    if (!data.ok) return alert("Failed to load messages");

    const text = data.messages
      .map(m => `[${new Date(m.time).toLocaleString()}] ${m.from}: ${m.text || "(image)"}`)
      .join("\n");

    document.getElementById("storyEditor").value = text;
  };

  document.getElementById("storySaveBtn").onclick = async () => {
    const storyText = document.getElementById("storyEditor").value.trim();
    if (!storyText) return alert("Story is empty");

    const res = await fetch("/api/story/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        owner: getSession().username,
        partner: targetUsername,
        story: storyText
      })
    });

    const data = await res.json();
    if (!data.ok) return alert("Failed to save story");

    alert("Story saved!");
    popup.style.display = "none";
  };

  document.getElementById("storyCloseBtn").onclick = () => {
    popup.style.display = "none";
  };
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

/* ---------- Typing Indicator Receive ---------- */

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

/* ============================================================
   IMAGE CSS (add to your stylesheet)
============================================================ */
/*
.chat-image {
  max-width: 220px;
  border-radius: 8px;
  margin-top: 6px;
  cursor: pointer;
}
*/

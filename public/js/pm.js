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
    existing.style.display = "flex";
    clearUnread(targetUsername);
    if (window.updateDMListSidebar) updateDMListSidebar();
    updateDMBadge();
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
  updateDMBadge();
}

// Expose globally so chat.js / roster / profile can open DMs
window.openPrivateWindow = openPrivateWindow;

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

  // Preserve typing indicator if present
  const typingEl = document.getElementById("pmTyping_" + targetUsername);
  body.innerHTML = "";

  messages.forEach(m => {
    // Skip SYSTEM messages that aren't for this conversation partner
    if (m.from === "SYSTEM") {
      // only show system messages addressed to this user
      if (m.to !== s.username) return;
      // if the current open DM is with another user, only show the system message
      // when it appears to relate to that partner (text includes their username)
      if (targetUsername !== "SYSTEM" && !(String(m.text || "").includes(targetUsername))) return;
    }

    const div = document.createElement("div");
    div.className = "message " + (m.from === s.username ? "me" : "");
    div.innerHTML = `
      <div style="font-size:13px;font-weight:700">${escapeHtml(m.from || "")}</div>
      <div style="margin-top:6px">${escapeHtml(m.text || "")}</div>
    `;

    if (m.type === "storyApproval") {
      div.className = "message system";
      div.innerHTML = `
        <div class="system-msg">
          ${escapeHtml(m.text || "")}
          <button class="small-btn approveStoryBtn" data-id="${m.storyId || ""}">
            Approve
          </button>
        </div>
      `;
    }

    if (m.type === "relationshipApproval") {
      div.className = "message system";
      div.innerHTML = `
        <div class="system-msg">
          ${escapeHtml(m.text || "")}
          <button class="small-btn approveRelBtn" data-rel-id="${m.relationshipId || ""}">
            Approve
          </button>
        </div>
      `;
    }

    if (m.imageUrl) {
      const img = document.createElement("img");
      img.src = m.imageUrl;
      img.className = "chat-image";
      img.style.cssText = "max-width:220px;border-radius:8px;margin-top:6px;cursor:pointer";
      img.addEventListener("click", () => window.open(m.imageUrl, "_blank"));
      div.appendChild(img);
    }

    body.appendChild(div);
  });

  if (typingEl) body.appendChild(typingEl);
  body.scrollTop = body.scrollHeight;
}
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

function openStoryPopup(targetUsername) {
  const popup = document.getElementById("storyPopup");
  popup.style.display = "flex";

  document.getElementById("storyEditor").value = "";
  document.getElementById("storyDate").value = "";
  const titleInput = document.getElementById("storyTitle");
  if (titleInput) titleInput.value = "";

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
    const title = titleInput ? titleInput.value.trim() : "";
    if (!title) return alert("Please enter a story title");

    const storyText = document.getElementById("storyEditor").value.trim();
    if (!storyText) return alert("Story is empty");

    const res = await fetch("/api/story/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        owner: getSession().username,
        partner: targetUsername,
        title,
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

let dmAlertSound = null;

function playDMAlertSound(){
  try {
    if (!dmAlertSound){
      dmAlertSound = new Audio('/sounds/ui-alert.mp3');
      dmAlertSound.preload = 'auto';
    }
    dmAlertSound.currentTime = 0;
    const p = dmAlertSound.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (e) {
    // Ignore audio errors (e.g., browser autoplay policy).
  }
}

/* ============================================================
   DM NOTIFICATION POPUP
============================================================ */
let dmNotifTimer = null;

function showDMNotification(username){
  const notif = document.getElementById('dmNotification');
  if (!notif) return;

  const userEl = document.getElementById('dmNotificationUser');
  if (userEl) userEl.textContent = username ? '@' + username : '';

  notif.style.display = 'flex';

  // Restart the slide-in animation even if the popup is already visible
  notif.style.animation = 'none';
  void notif.offsetWidth;
  notif.style.animation = '';

  // Auto-hide after 8 seconds
  clearTimeout(dmNotifTimer);
  dmNotifTimer = setTimeout(() => {
    notif.style.display = 'none';
  }, 8000);

  // Clicking the popup dismisses it and opens the DM window
  notif.onclick = () => {
    clearTimeout(dmNotifTimer);
    notif.style.display = 'none';
    if (username && typeof openPrivateWindow === 'function'){
      openPrivateWindow(username);
    }
  };
}

socket.on("privateMessage", pm => {
  const me = getSession();
  if (!me) return;

  // Don't count our own echo as unread
  const other = pm.from === me.username ? pm.to : pm.from;
  if (!other || other === me.username) return;

  // Play an alert for every incoming DM from another user
  // (whether the DM window is open or not).
  playDMAlertSound();

  // Show the popup notification at the top of the screen.
  showDMNotification(other);

  const body = document.getElementById("pmBody_" + other);
  const windowOpen = !!document.getElementById("pmWindow_" + other);

  if (body && windowOpen) {
    const existing = body._history || [];
    const updated = [...existing, pm];
    body._history = updated;
    renderPMHistory(other, updated);
  } else if (pm.from !== me.username) {
    incrementUnread(other);
    if (window.updateDMListSidebar) updateDMListSidebar();
    updateDMBadge();
  }
});

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
  const el = document.getElementById("pmTyping_" + from);
  if (el) el.style.display = "block";
});

socket.on("stopTypingDM", ({ from }) => {
  const el = document.getElementById("pmTyping_" + from);
  if (el) el.style.display = "none";
});

/* DM sidebar provided by utils.js */

socket.on("storyApprovalRequest", data => {
  const { storyId, from, title } = data;
  const safeTitle = title ? escapeHtml(title) : "";

  const popup = document.createElement("div");
  popup.className = "modal";
  popup.innerHTML = `
    <div class="modal-content">
      <h2>Story Approval Request</h2>
      <p>${from} created a story involving your messages${title ? `: <strong>"${safeTitle}"</strong>` : ""}.</p>
      <button id="approveStoryBtn">Approve</button>
      <button id="denyStoryBtn">Deny</button>
    </div>
  `;
  document.body.appendChild(popup);

  document.getElementById("approveStoryBtn").onclick = async () => {
    await fetch("/api/story/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ storyId })
    });
    alert(`Story${title ? ` "${title}"` : ""} approved. It is now saved on both profiles.`);
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
    <div class="modal-content">
      <h2>Relationship Request</h2>
      <p>${from} wants to add: <strong>${type}</strong></p>
      <button id="approveRelBtn">Approve</button>
      <button id="denyRelBtn">Deny</button>
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

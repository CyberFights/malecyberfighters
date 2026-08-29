/* Use the shared direct-first image loader. If a browser blocks an ImgBB /
 * Discord image, image-proxy.js retries it once through the same-origin proxy.
 * Falls back to the raw URL if that helper has not loaded. */
function pmImgSrc(value) {
  if (typeof window !== 'undefined' && typeof window.imgSrc === 'function') return window.imgSrc(value);
  return value == null ? '' : String(value);
}

/* ============================================================
   MOVABLE DM POPUPS (desktop only) + Z-INDEX stacking
============================================================ */
let pmZIndexCounter = 1050;

function bringPmToFront(win) {
  if (!win) return;
  pmZIndexCounter += 1;
  win.style.zIndex = String(pmZIndexCounter);
}

function makePmWindowDraggable(pmWindow) {
  if (!pmWindow) return;
  const header = pmWindow.querySelector('.pm-header');
  if (!header) return;

  let isDragging = false;
  let startX = 0, startY = 0;
  let initialLeft = 0, initialTop = 0;

  // Bring to front when clicking anywhere in the window
  pmWindow.addEventListener('mousedown', () => bringPmToFront(pmWindow));

  header.addEventListener('mousedown', (e) => {
    // Desktop only
    if (window.matchMedia && window.matchMedia('(max-width: 768px)').matches) return;
    if (e.target.closest('button')) return;

    isDragging = true;
    bringPmToFront(pmWindow);

    const rect = pmWindow.getBoundingClientRect();

    // Convert from right/bottom anchored to left/top so dragging works
    if (!pmWindow.style.left || pmWindow.style.left === 'auto' || pmWindow.style.left === '') {
      pmWindow.style.left = rect.left + 'px';
      pmWindow.style.top = rect.top + 'px';
      pmWindow.style.right = 'auto';
      pmWindow.style.bottom = 'auto';
    }

    initialLeft = rect.left;
    initialTop = rect.top;
    startX = e.clientX;
    startY = e.clientY;

    pmWindow.classList.add('pm-dragging');
    pmWindow.style.transition = 'none';
    e.preventDefault();
  });

  const onMouseMove = (e) => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    let newLeft = initialLeft + dx;
    let newTop = initialTop + dy;

    const maxLeft = window.innerWidth - pmWindow.offsetWidth;
    const maxTop = window.innerHeight - pmWindow.offsetHeight;

    newLeft = Math.max(0, Math.min(newLeft, Math.max(0, maxLeft)));
    newTop = Math.max(0, Math.min(newTop, Math.max(0, maxTop)));

    pmWindow.style.left = newLeft + 'px';
    pmWindow.style.top = newTop + 'px';
  };

  const onMouseUp = () => {
    if (!isDragging) return;
    isDragging = false;
    pmWindow.classList.remove('pm-dragging');
    pmWindow.style.transition = '';
  };

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
}

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

// Upload a GIF / short video and send it as a DM clip message.
async function uploadDMClip(targetUsername, file) {
  if (!isClipFile(file)) {
    alert("Only GIF, MP4 and WebM clips are supported");
    return;
  }

  const s = getSession();
  if (!s) return;

  const btn = document.getElementById("pmClipBtn_" + targetUsername);
  if (btn) { btn.disabled = true; btn.textContent = "…"; }
  try {
    const data = await uploadClipToServer(file);

    if (!data.ok) {
      alert(data.error === "file_too_large"
        ? "Clip is too large (max 25 MB for GIFs, 50 MB for videos)"
        : "Clip upload failed");
      return;
    }

    socket.emit("privateMessage", {
      from: s.username,
      to: targetUsername,
      clipUrl: data.clipUrl,
      clipType: data.clipType
    });
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "🎬"; }
  }
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

  // Get the profile card / roster / DM list out of the way — they overlay the
  // DM window on mobile, so the conversation would open behind them.
  if (typeof window.closeUserBrowsingPopups === "function") window.closeUserBrowsingPopups();

  const existing = document.getElementById("pmWindow_" + targetUsername);
  if (existing) {
    existing.style.display = "flex";
    bringPmToFront(existing);
    clearUnread(targetUsername);
    if (window.updateDMListSidebar) updateDMListSidebar();
    updateDMBadge();
    return;
  }

  const pmWindow = document.createElement("div");
  pmWindow.className = "pm-window";
  pmWindow.id = "pmWindow_" + targetUsername;

  // Cascade offset when multiple DM popups are open (desktop only)
  const openCount = document.querySelectorAll('.pm-window').length;
  if (openCount > 0 && window.innerWidth > 768) {
    const offset = (openCount % 6) * 28;
    pmWindow.dataset.cascadeOffset = String(offset);
  }

  pmWindow.innerHTML = `
    <div class="pm-header">
      <div class="pm-header-main">
        <div class="pm-header-user">
          <div class="avatar" style="width:36px;height:36px">${targetUsername[0].toUpperCase()}</div>
          <div class="pm-header-id">
            <div class="pm-header-name">${targetUsername}</div>
            <div class="small">@${targetUsername}</div>
          </div>
        </div>
        <button class="small-btn pm-close" type="button" aria-label="Close">X</button>
      </div>
      <div class="pm-header-actions">
        <button class="small-btn pm-call" type="button" title="Audio call" aria-label="Audio call">☎ Call</button>
        <button class="small-btn pm-story" type="button">Story</button>
        <button class="small-btn pm-clear" type="button">Clear</button>
      </div>
    </div>

    <div class="pm-body" id="pmBody_${targetUsername}"></div>

    <div class="pm-input">
      <button class="small-btn pm-call" type="button" title="Audio call" aria-label="Audio call">☎</button>
      <input id="pmInput_${targetUsername}" type="text" placeholder="Message ${targetUsername}">
      <input type="file" id="pmImage_${targetUsername}" accept="image/*" style="display:none">
      <button class="small-btn" id="pmImageBtn_${targetUsername}" type="button" title="Send image">📷</button>
      <input type="file" id="pmClip_${targetUsername}" accept="image/gif,video/mp4,video/webm" style="display:none">
      <button class="small-btn" id="pmClipBtn_${targetUsername}" type="button" title="Send GIF or short video">🎬</button>
      <button class="small-btn emoji-btn" id="pmEmojiBtn_${targetUsername}" type="button" data-emoji-btn title="Insert emoji" aria-label="Insert emoji">😊</button>
      <button class="small-btn" id="pmSend_${targetUsername}" type="button">Send</button>
    </div>
  `;

  document.body.appendChild(pmWindow);

  // Make movable (desktop only) and bring to front
  bringPmToFront(pmWindow);
  makePmWindowDraggable(pmWindow);

  // Apply cascade offset visually after first layout (desktop only)
  if (pmWindow.dataset.cascadeOffset && window.innerWidth > 768) {
    const offset = parseInt(pmWindow.dataset.cascadeOffset, 10) || 0;
    // Convert right/bottom to left/top for offset handling
    requestAnimationFrame(() => {
      const rect = pmWindow.getBoundingClientRect();
      // Only apply if still anchored to right/bottom (not yet dragged)
      if (pmWindow.style.right !== 'auto') {
        const newLeft = Math.max(0, rect.left - offset);
        const newTop = Math.max(0, rect.top - offset);
        pmWindow.style.left = newLeft + 'px';
        pmWindow.style.top = newTop + 'px';
        pmWindow.style.right = 'auto';
        pmWindow.style.bottom = 'auto';
        pmWindow.style.transform = '';
      }
    });
  }

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
  pmWindow.querySelectorAll(".pm-call").forEach(btn => {
    btn.addEventListener("click", () => {
      if (typeof window.startAudioCall === "function") window.startAudioCall(targetUsername);
    });
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
      e.target.value = "";
      if (file) uploadDMImage(targetUsername, file);
    });

  /* ---------- DM Clip Upload (GIF / short video) ---------- */

  document
    .getElementById("pmClipBtn_" + targetUsername)
    .addEventListener("click", () => {
      document.getElementById("pmClip_" + targetUsername).click();
    });

  document
    .getElementById("pmClip_" + targetUsername)
    .addEventListener("change", e => {
      const file = e.target.files[0];
      e.target.value = "";
      if (file) uploadDMClip(targetUsername, file);
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
      img.src = pmImgSrc(m.imageUrl);
      img.referrerPolicy = "no-referrer";
      img.className = "chat-image";
      img.style.cssText = "max-width:220px;border-radius:8px;margin-top:6px;cursor:pointer";
      img.addEventListener("click", () => window.open(m.imageUrl, "_blank"));
      div.appendChild(img);
    }

    // GIF / short video clips (served from our /clips route)
    if (m.clipUrl) {
      const clipEl = createClipElement(m.clipUrl, m.clipType);
      if (m.clipType === "gif") {
        clipEl.addEventListener("click", () => window.open(m.clipUrl, "_blank"));
      }
      div.appendChild(clipEl);
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

  /* ---------- Optional clip attached to the story ---------- */
  let storyClip = null; // { url, type, name }

  const storyClipInput = document.getElementById("storyClipInput");
  const storyClipBtn = document.getElementById("storyClipBtn");
  const storyClipClearBtn = document.getElementById("storyClipClearBtn");
  const storyClipStatus = document.getElementById("storyClipStatus");
  const storyClipPreview = document.getElementById("storyClipPreview");

  const resetStoryClip = () => {
    storyClip = null;
    if (storyClipPreview) storyClipPreview.innerHTML = "";
    if (storyClipStatus) storyClipStatus.textContent = "";
    if (storyClipClearBtn) storyClipClearBtn.style.display = "none";
    if (storyClipInput) storyClipInput.value = "";
  };
  resetStoryClip();

  if (storyClipBtn) storyClipBtn.onclick = () => storyClipInput?.click();

  if (storyClipInput) storyClipInput.onchange = async e => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;

    if (!isClipFile(file)) {
      if (storyClipStatus) storyClipStatus.textContent = "Unsupported file — use a GIF, MP4 or WebM";
      return;
    }

    if (storyClipStatus) storyClipStatus.textContent = "Uploading clip…";
    if (storyClipBtn) storyClipBtn.disabled = true;

    const data = await uploadClipToServer(file);
    if (storyClipBtn) storyClipBtn.disabled = false;

    if (!data.ok) {
      if (storyClipStatus) storyClipStatus.textContent = data.error === "file_too_large"
        ? "Clip is too large (max 25 MB for GIFs, 50 MB for videos)"
        : "Clip upload failed";
      return;
    }

    storyClip = { url: data.clipUrl, type: data.clipType, name: file.name };
    if (storyClipStatus) storyClipStatus.textContent = `✓ ${file.name}`;
    if (storyClipClearBtn) storyClipClearBtn.style.display = "inline-block";
    if (storyClipPreview) {
      storyClipPreview.innerHTML = "";
      storyClipPreview.appendChild(createClipElement(data.clipUrl, data.clipType));
    }
  };

  if (storyClipClearBtn) storyClipClearBtn.onclick = resetStoryClip;

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
      .map(m => `[${new Date(m.time).toLocaleString()}] ${m.from}: ${m.text || (m.clipUrl ? "(clip)" : "(image)")}`)
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
        story: storyText,
        clipUrl: storyClip ? storyClip.url : null,
        clipType: storyClip ? storyClip.type : null
      })
    });

    const data = await res.json();
    if (!data.ok) return alert("Failed to save story");

    alert("Story saved!");
    popup.style.display = "none";
    resetStoryClip();
  };

  document.getElementById("storyCloseBtn").onclick = () => {
    popup.style.display = "none";
    resetStoryClip();
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

  const isIncoming = pm.from !== me.username;

  // Sound + toast only for messages we received, not ones we sent
  if (isIncoming) {
    playDMAlertSound();
    showDMNotification(other);
  }

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

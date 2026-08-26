/* Route remote (ImgBB / Discord CDN) images through our same-origin /img
 * proxy so Firefox's OpaqueResponseBlocking cannot drop them. Falls back to the
 * raw URL if image-proxy.js has not loaded. */
function pmImgSrc(value) {
  if (typeof window !== 'undefined' && typeof window.imgSrc === 'function') return window.imgSrc(value);
  return value == null ? '' : String(value);
}

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
  if (m.from === "SYSTEM") {
    if (m.to !== s.username) return;
    // only show system messages in this DM if they seem related to the partner
    if (targetUsername !== "SYSTEM" && !(String(m.text || "").includes(targetUsername))) return;
  }

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
      contentHtml = `<img src="${pmImgSrc(m.imageUrl)}" class="chat-image" style="max-width:220px;border-radius:8px;margin-top:6px;cursor:pointer" data-url="${m.imageUrl}">`;
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

function openStoryPopup(targetUsername) {
  const popup = document.getElementById("storyPopup");
  if (!popup) return;
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
    // Append the new message to the current view without re-rendering history
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
    contentHtml = `<img src="${pmImgSrc(pm.imageUrl)}" class="chat-image" style="max-width:220px;border-radius:8px;margin-top:6px;cursor:pointer" data-url="${pm.imageUrl}">`;
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

/* DM sidebar provided by utils.js */

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

// Call DM
document.getElementById("dmCall")?.addEventListener("click", () => {
  const partner = currentDmPartner || document.getElementById("dmPopup")?.dataset.partner;
  if (partner && typeof window.startAudioCall === "function") {
    window.startAudioCall(partner);
  }
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
  const { storyId, from, title } = data;
  const safeTitle = title ? escapeHtml(title) : "";

  const popup = document.createElement("div");
  popup.className = "modal";
  popup.innerHTML = `
    <div class="modal-box">
      <div class="modal-header">
        <h3>Story Approval Request</h3>
      </div>
      <p>${from} created a story involving your messages${title ? `: <strong>"${safeTitle}"</strong>` : ""}.</p>
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

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

/**
 * Identity is established in the handshake: the server resolves the session
 * token to a member, and no event carries a username. Read on every
 * (re)connection so signing in on an open page upgrades the socket.
 */
const socket = io({
  auth: (cb) => {
    const token = typeof getSessionToken === 'function' ? getSessionToken() : null;
    cb(token ? { token } : {});
  }
});

// Keep a single presence handler here; chat-mobile.js also listens and re-renders.
// Avoid duplicate relationship-approval popups (pm-mobile.js owns those handlers).

socket.on("connect", () => {
  const token = typeof getSessionToken === "function" ? getSessionToken() : null;
  if (token) socket.emit("login", { token });
});

/** The server rejected our token: expired, or the account was banned/deleted. */
function dropRejectedSession() {
  if (typeof clearSession === "function") clearSession();
  localStorage.removeItem("currentUser");
  if (window.updateUIForSession) updateUIForSession();
  if (window.updateProfileCard) updateProfileCard(null);
  if (window.updateDMListSidebar) updateDMListSidebar();
  if (window.updateDMBadge) updateDMBadge();
}

socket.on("auth:invalid", dropRejectedSession);

socket.on("actionRejected", ({ reason } = {}) => {
  if (reason !== "auth_required") return;
  if (typeof getSession === "function" && getSession()) dropRejectedSession();
  const authScreen = document.getElementById("authScreen");
  const mainUI = document.getElementById("mainUI");
  if (authScreen) authScreen.style.display = "flex";
  if (mainUI) mainUI.style.display = "none";
});

socket.on("forceLogout", ({ reason } = {}) => {
  dropRejectedSession();

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

/* The Administrator account changed this member's tier of trust: refresh the
   locally cached session record so the UI shows the new role without a
   re-login. The member list itself updates through the presence rebroadcast
   that accompanies the change. */
socket.on("roleUpdated", ({ role } = {}) => {
  const session = typeof getSession === "function" ? getSession() : null;
  if (!session) return;
  session.role = role;
  if (typeof setSession === "function") setSession(session);
});

// Re-export for modules that expect a global
window.socket = socket;

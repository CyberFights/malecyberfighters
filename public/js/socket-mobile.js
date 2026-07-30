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

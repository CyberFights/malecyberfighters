const socket = io();

// Keep a single presence handler here; chat.js also listens and re-renders.
// Avoid duplicate relationship-approval popups (pm.js owns those handlers).

socket.on("connect", () => {
  const user = typeof getSession === "function" ? getSession() : null;
  if (user) {
    socket.emit("login", user);
  }
});

socket.on("forceLogout", ({ reason } = {}) => {
  if (typeof clearSession === "function") clearSession();
  localStorage.removeItem("currentUser");
  if (window.updateUIForSession) updateUIForSession();
  if (window.updateProfileCard) updateProfileCard(null);
  if (reason === "banned") {
    alert("Your account has been banned.");
  }
});

// Re-export for modules that expect a global
window.socket = socket;

/**
 * The realtime connection.
 *
 * Identity is established once, in the handshake: the server resolves the
 * session token to a member and every event that follows is attributed to that
 * member. Nothing here sends a username, because a name in a payload is data a
 * client can choose — the handshake is what the server trusts.
 *
 * The token is read on every (re)connection rather than once at construction,
 * so signing in on an already-open page upgrades the socket without a reload,
 * and signing out leaves it connected but anonymous.
 */
const socket = io({
  auth: (cb) => {
    const token = typeof getSessionToken === 'function' ? getSessionToken() : null;
    cb(token ? { token } : {});
  }
});

// Keep a single presence handler here; chat.js also listens and re-renders.
// Avoid duplicate relationship-approval popups (pm.js owns those handlers).

socket.on("connect", () => {
  const token = typeof getSessionToken === "function" ? getSessionToken() : null;
  // The handshake already carried the token when there was one; this covers the
  // member who signed in after the page was open, and asks the server to replay
  // anything that arrived while no session of theirs was connected.
  if (token) socket.emit("login", { token });
});

/**
 * The server rejected the token we were holding: expired, signed out elsewhere,
 * or the account was banned or deleted. Drop the local session so the UI stops
 * claiming to be signed in.
 */
function dropRejectedSession() {
  if (typeof clearSession === "function") clearSession();
  localStorage.removeItem("currentUser");
  if (window.updateUIForSession) updateUIForSession();
  if (window.updateProfileCard) updateProfileCard(null);
  if (window.updateDMListSidebar) updateDMListSidebar();
  if (window.updateDMBadge) updateDMBadge();
}

socket.on("auth:invalid", dropRejectedSession);

// An action was refused because this socket has no verified session — normally
// only reachable by posting after the session expired in another tab.
socket.on("actionRejected", ({ reason } = {}) => {
  if (reason !== "auth_required") return;
  if (typeof getSession === "function" && getSession()) dropRejectedSession();
  const modal = document.getElementById("modalLogin");
  if (modal && typeof show === "function") show(modal);
});

socket.on("forceLogout", ({ reason } = {}) => {
  dropRejectedSession();
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

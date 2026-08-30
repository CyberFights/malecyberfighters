/* ============================================================
   AUTO LOGOUT
   1) Idle timeout  — logs the user out after 1 hour with no
      mouse / keyboard / touch / scroll activity.
   2) Close logout  — if the tab/app was fully closed (not just
      refreshed), the saved session is discarded so the next
      visit starts logged out.

   This file must load BEFORE the other app scripts so the
   "closed page" check clears the session before anything
   reads it.
============================================================ */
(function () {
  var SESSION_KEY = "cw_session_v1";
  var LAST_ACTIVITY_KEY = "cw_last_activity_v1";
  var HEARTBEAT_KEY = "cw_tab_heartbeat_v1";
  var TAB_FLAG = "cw_tab_open_v1";

  var IDLE_LIMIT_MS = 60 * 60 * 1000;   // 1 hour of no activity
  var HEARTBEAT_MS = 5 * 1000;          // open tabs ping every 5s
  var HEARTBEAT_GRACE_MS = 15 * 1000;   // heartbeat older than this = app was closed
  var CHECK_INTERVAL_MS = 60 * 1000;    // idle check once per minute

  function safeGet(store, key) {
    try { return store.getItem(key); } catch (e) { return null; }
  }
  function safeSet(store, key, value) {
    try { store.setItem(key, value); } catch (e) {}
  }
  function safeRemove(store, key) {
    try { store.removeItem(key); } catch (e) {}
  }

  function hasSession() {
    var raw = safeGet(localStorage, SESSION_KEY);
    return !!raw && raw !== "null";
  }

  function clearStoredSession() {
    safeRemove(localStorage, SESSION_KEY);
    safeRemove(localStorage, "currentUser");
    safeRemove(localStorage, LAST_ACTIVITY_KEY);
  }

  /* ----------------------------------------------------------
     CLOSE-THE-PAGE LOGOUT
     A refresh keeps sessionStorage and the heartbeat stays
     fresh, so refreshes stay signed in. A real close loses the
     per-tab flag AND lets the heartbeat go stale — in that case
     the saved session is dropped before the app scripts load.
  ---------------------------------------------------------- */
  var sameTab = !!safeGet(sessionStorage, TAB_FLAG);
  var lastBeat = parseInt(safeGet(localStorage, HEARTBEAT_KEY) || "0", 10);
  var beatFresh = lastBeat && (Date.now() - lastBeat) < HEARTBEAT_GRACE_MS;

  if (hasSession() && !sameTab && !beatFresh) {
    // The app was closed (not refreshed) — end the previous session.
    clearStoredSession();
  }

  /* Also honor the idle limit across restarts: if they walked away,
     the device slept, or the app was killed for over an hour,
     start logged out. */
  if (hasSession()) {
    var lastActivity = parseInt(safeGet(localStorage, LAST_ACTIVITY_KEY) || "0", 10);
    if (lastActivity && (Date.now() - lastActivity) > IDLE_LIMIT_MS) {
      clearStoredSession();
    }
  }

  safeSet(sessionStorage, TAB_FLAG, "1");
  safeSet(localStorage, HEARTBEAT_KEY, String(Date.now()));
  setInterval(function () {
    safeSet(localStorage, HEARTBEAT_KEY, String(Date.now()));
  }, HEARTBEAT_MS);

  /* ----------------------------------------------------------
     IDLE TIMEOUT (1 hour)
  ---------------------------------------------------------- */
  var lastActive = Date.now();
  safeSet(localStorage, LAST_ACTIVITY_KEY, String(lastActive));

  var lastPersist = 0;
  function markActivity() {
    lastActive = Date.now();
    // Throttle localStorage writes to once every 15s.
    if (lastActive - lastPersist > 15 * 1000) {
      lastPersist = lastActive;
      safeSet(localStorage, LAST_ACTIVITY_KEY, String(lastActive));
    }
  }

  ["mousemove", "mousedown", "click", "keydown", "wheel", "scroll", "touchstart", "pointerdown"]
    .forEach(function (ev) {
      window.addEventListener(ev, markActivity, { passive: true, capture: true });
    });

  function performIdleLogout() {
    if (!hasSession()) return;

    // Let the server mark the user offline right away.
    var sock = window.socket || (window.__cw && window.__cw.state && window.__cw.state.socket);
    try {
      var raw = safeGet(localStorage, SESSION_KEY);
      var s = raw ? JSON.parse(raw) : null;
      if (sock && s && s.username) sock.emit("chatClosed", { username: s.username });
    } catch (e) {}

    if (typeof window.logout === "function") {
      try { window.logout(); } catch (e) { clearStoredSession(); }
    } else {
      clearStoredSession();
    }

    alert("You have been logged out after 1 hour of inactivity.");
  }

  function checkIdle() {
    if (!hasSession()) return;
    if (Date.now() - lastActive >= IDLE_LIMIT_MS) performIdleLogout();
  }

  setInterval(checkIdle, CHECK_INTERVAL_MS);

  // Run a check the moment the tab becomes visible again (covers
  // laptops waking from sleep / phones returning from background,
  // where timers were paused past the deadline).
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") checkIdle();
  });
})();

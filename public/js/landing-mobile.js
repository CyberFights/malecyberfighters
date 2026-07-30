/* ============================================================
   landing-mobile.js — Mobile version of landing.js
   Adapted from ./public/js/landing.js for ./public/mobile.html

   ID conversions:
     None — all IDs (ageGate, introGif, confirmBtn) exist in mobile.html.

   Timing differences:
     - Desktop uses 8s GIF display; mobile uses faster fade (2.5s)
       matching mobile.css and mobile.js conventions
============================================================ */

document.addEventListener("DOMContentLoaded", () => {
  const gate = document.getElementById("ageGate");
  const gif = document.getElementById("introGif");
  const btn = document.getElementById("confirmBtn");

  if (!gate || !gif || !btn) return;

  btn.addEventListener("click", () => {
    gif.style.backgroundImage = "url('./images/intro.gif')";
    gif.style.display = "block";
    gif.style.opacity = "1";
    gate.style.transition = "opacity .4s";
    gate.style.opacity = "0";

    // MOBILE: faster fade than desktop (2.5s vs 8s)
    setTimeout(() => {
      gif.style.opacity = "0";
    }, 2500);

    setTimeout(() => {
      gate.style.display = "none";
      gif.style.display = "none";

      // MOBILE: show auth screen after age gate
      const authScreen = document.getElementById('authScreen');
      const session = typeof getSession === 'function' ? getSession() : null;

      if (session) {
        // Already logged in — show main UI
        const mainUI = document.getElementById('mainUI');
        if (mainUI) mainUI.style.display = 'block';
        if (window.updateUIForSession) updateUIForSession();
        if (window.updateProfileCard) updateProfileCard(session);
      } else if (authScreen) {
        authScreen.style.display = 'flex';
        authScreen.style.alignItems = 'center';
        authScreen.style.justifyContent = 'center';
      }
    }, 3200);
  });
});

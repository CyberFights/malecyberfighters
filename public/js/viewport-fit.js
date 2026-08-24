/* viewport-fit.js -----------------------------------------------------------
 * Keeps full-screen chat surfaces sized to the *visual* viewport on mobile.
 *
 * Problem: `position: fixed; inset: 0` sizes an element to the layout viewport,
 * which on iOS Safari / Chrome Android sits *underneath* the collapsible
 * browser toolbar and the on-screen keyboard. The composer ("text bar") pinned
 * to the bottom of a chat or DM window therefore ends up hidden behind the
 * browser bar.
 *
 * Fix: publish the live visual-viewport geometry as CSS custom properties that
 * mobile.css consumes:
 *
 *   --app-height    height of the area actually visible to the user
 *   --app-top       offset of that area from the top of the layout viewport
 *
 * These update as the browser chrome collapses/expands and as the on-screen
 * keyboard opens, so the composer always stays above both. Browsers without
 * window.visualViewport fall back to the CSS `100dvh` / `100vh` chain.
 * ---------------------------------------------------------------------------
 */
(function () {
  'use strict';

  var root = document.documentElement;
  var vv = window.visualViewport || null;
  var frame = null;
  var lastKeyboardOpen = false;

  function apply() {
    frame = null;

    var height = vv ? vv.height : window.innerHeight;
    var top = vv ? vv.offsetTop : 0;

    if (!height || !isFinite(height)) return;

    root.style.setProperty('--app-height', Math.round(height) + 'px');
    root.style.setProperty('--app-top', Math.round(top) + 'px');

    // Height of whatever is covering the bottom of the layout viewport
    // (on-screen keyboard and/or browser toolbar). Exposed so individual
    // components can add breathing room if they need it.
    var covered = Math.max(0, Math.round(window.innerHeight - height - top));
    root.style.setProperty('--bottom-inset', covered + 'px');

    var keyboardOpen = covered > 120;
    if (keyboardOpen !== lastKeyboardOpen) {
      lastKeyboardOpen = keyboardOpen;
      root.classList.toggle('keyboard-open', keyboardOpen);
      pinFeedsToBottom();
    }
  }

  /* The visible area shrinks when the keyboard opens; keep the newest message
     next to the composer instead of leaving it scrolled off-screen. */
  function pinFeedsToBottom() {
    var feeds = document.querySelectorAll('.chat-popup .public-feed, .pm-window .pm-body');
    Array.prototype.forEach.call(feeds, function (feed) {
      if (!feed.offsetParent) return;
      feed.scrollTop = feed.scrollHeight;
    });
  }

  function schedule() {
    if (frame !== null) return;
    frame = window.requestAnimationFrame(apply);
  }

  apply();

  if (vv) {
    vv.addEventListener('resize', schedule);
    vv.addEventListener('scroll', schedule);
  }
  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', function () {
    schedule();
    // iOS reports stale geometry immediately after a rotation.
    window.setTimeout(apply, 300);
  });
  document.addEventListener('visibilitychange', schedule);

  /*
   * When a composer input gains focus the keyboard animates in; re-measure a
   * couple of times so the chat window snaps above it without waiting for the
   * next resize event, and keep the focused field in view.
   */
  document.addEventListener(
    'focusin',
    function (event) {
      var el = event.target;
      if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA')) return;

      schedule();
      window.setTimeout(apply, 150);
      window.setTimeout(function () {
        apply();
        if (typeof el.scrollIntoView === 'function') {
          el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
      }, 350);
    },
    true
  );

  document.addEventListener('focusout', function () {
    window.setTimeout(apply, 250);
  });
})();

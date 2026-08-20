/* ============================================================
   POPUP GROW / SHRINK
   Adds a grow-from-button animation when a popup opens and a
   shrink-into-button animation when it closes.

   It works without touching any of the existing open/close code:
   a MutationObserver watches the popup containers for the
   style/class changes the app already makes, and layers the
   animation on top of them.

   The most recent click / tap is treated as the origin button so
   the popup expands out of that control and collapses back into
   it. Coordinates are stored on the popup as --popup-origin-x/y
   and consumed by the CSS transform-origin.

   Closing is normally instant (display:none), so the element is
   held visible for the length of the out-animation through the
   .popup-dissolve-out helper class, which re-applies the display
   value the popup had while it was open via the --popup-dissolve-display
   custom property. Once the animation finishes the class is removed
   and the popup is hidden exactly as the app intended.
   ============================================================ */
(function () {
  'use strict';

  if (window.__popupDissolveReady) return;
  window.__popupDissolveReady = true;

  var IN_CLASS = 'popup-dissolve-in';
  var OUT_CLASS = 'popup-dissolve-out';
  var DISPLAY_VAR = '--popup-dissolve-display';
  var ORIGIN_X_VAR = '--popup-origin-x';
  var ORIGIN_Y_VAR = '--popup-origin-y';
  var IN_MS = 280;
  var OUT_MS = 240;
  var TRIGGER_MS = 1200;
  var TRIGGER_SELECTOR = [
    'button',
    '[role="button"]',
    'a',
    'input[type="button"]',
    'input[type="submit"]',
    '.dm-sidebar-item',
    '.dm-row',
    '.room-item',
    '.roster-user',
    '.forum-list-item',
    '.user-row',
    '.profile-photo-tile'
  ].join(',');

  /* Containers that behave as popups. Anything matched here must also be
     position:fixed at runtime, which keeps inner helpers (lists, headers,
     scroll areas) out of the way. */
  var SELECTOR = [
    '.modal',
    '.modal-overlay',
    '.list-popup-overlay',
    '.forum-overlay',
    '.popup',
    '.chat-popup',
    '.side-panel',
    '#ageGate',
    '#dmSidebar',
    '#roomsSidebar',
    '[id^="modal"]',
    '[id$="Modal"]',
    '[id$="Popup"]',
    '[id$="popup"]'
  ].join(',');

  var reduceMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduceMotion) return;

  var states = new WeakMap();
  var lastTrigger = null;
  var lastPoint = null;
  var lastTriggerAt = 0;

  function getState(el) {
    var state = states.get(el);
    if (!state) {
      state = {
        open: false,
        display: '',
        internal: 0,
        inTimer: 0,
        outTimer: 0,
        trigger: null,
        point: null
      };
      states.set(el, state);
    }
    return state;
  }

  function rememberTrigger(event) {
    if (!event) return;
    var target = event.target;
    if (target && target.nodeType === 3) target = target.parentElement;
    if (!target || target.nodeType !== 1) return;

    var trigger = typeof target.closest === 'function'
      ? target.closest(TRIGGER_SELECTOR)
      : null;
    lastTrigger = trigger || target;
    lastPoint = {
      x: event.clientX,
      y: event.clientY
    };
    lastTriggerAt = Date.now();
  }

  function takeTrigger() {
    if (!lastTrigger && !lastPoint) return { trigger: null, point: null };
    if (Date.now() - lastTriggerAt > TRIGGER_MS) {
      return { trigger: null, point: null };
    }
    return { trigger: lastTrigger, point: lastPoint };
  }

  function applyOrigin(el, trigger, point) {
    var ox = '50%';
    var oy = '50%';
    var popupRect = el.getBoundingClientRect();
    var used = false;

    if (trigger && trigger.isConnected && typeof trigger.getBoundingClientRect === 'function') {
      var btnRect = trigger.getBoundingClientRect();
      if (btnRect.width || btnRect.height || btnRect.left || btnRect.top) {
        ox = (btnRect.left + btnRect.width / 2 - popupRect.left) + 'px';
        oy = (btnRect.top + btnRect.height / 2 - popupRect.top) + 'px';
        used = true;
      }
    }

    if (!used && point && typeof point.x === 'number' && typeof point.y === 'number') {
      ox = (point.x - popupRect.left) + 'px';
      oy = (point.y - popupRect.top) + 'px';
    }

    el.style.setProperty(ORIGIN_X_VAR, ox);
    el.style.setProperty(ORIGIN_Y_VAR, oy);
  }

  function clearOrigin(el) {
    el.style.removeProperty(ORIGIN_X_VAR);
    el.style.removeProperty(ORIGIN_Y_VAR);
  }

  function isPopup(el) {
    if (!el || el.nodeType !== 1 || typeof el.matches !== 'function') return false;
    if (!el.isConnected) return false;
    if (!el.matches(SELECTOR)) return false;
    var computed = window.getComputedStyle(el);
    return computed && computed.position === 'fixed';
  }

  function isShown(el) {
    if (!el.isConnected) return false;
    var computed = window.getComputedStyle(el);
    if (!computed) return false;
    return computed.display !== 'none' && computed.visibility !== 'hidden';
  }

  function currentOpacity(el) {
    var computed = window.getComputedStyle(el);
    var value = computed ? parseFloat(computed.opacity) : NaN;
    return isNaN(value) ? 1 : value;
  }

  /* Wrap our own DOM writes so the observer can tell them apart from the
     app's own show/hide calls. */
  function internalWrite(el, fn) {
    var state = getState(el);
    state.internal++;
    try {
      fn();
    } finally {
      setTimeout(function () {
        if (state.internal > 0) state.internal--;
      }, 0);
    }
  }

  function stopOut(el, state) {
    if (state.outTimer) {
      clearTimeout(state.outTimer);
      state.outTimer = 0;
    }
    if (el.classList.contains(OUT_CLASS) || el.style.getPropertyValue(DISPLAY_VAR)) {
      internalWrite(el, function () {
        el.classList.remove(OUT_CLASS);
        el.style.removeProperty(DISPLAY_VAR);
      });
    }
  }

  function stopIn(el, state) {
    if (state.inTimer) {
      clearTimeout(state.inTimer);
      state.inTimer = 0;
    }
    if (el.classList.contains(IN_CLASS)) {
      internalWrite(el, function () {
        el.classList.remove(IN_CLASS);
      });
    }
  }

  function playIn(el) {
    var state = getState(el);
    stopOut(el, state);
    stopIn(el, state);

    var remembered = takeTrigger();
    if (remembered.trigger || remembered.point) {
      state.trigger = remembered.trigger;
      state.point = remembered.point;
    }

    internalWrite(el, function () {
      applyOrigin(el, state.trigger, state.point);
      el.classList.add(IN_CLASS);
    });

    state.inTimer = setTimeout(function () {
      state.inTimer = 0;
      internalWrite(el, function () {
        el.classList.remove(IN_CLASS);
      });
    }, IN_MS);
  }

  function playOut(el, display) {
    var state = getState(el);
    stopIn(el, state);
    stopOut(el, state);

    internalWrite(el, function () {
      el.style.setProperty(DISPLAY_VAR, display || 'flex');
      /* Restore layout before measuring so the origin is relative to the
         popup's on-screen box, not a display:none 0×0 rect. */
      el.getBoundingClientRect();
      applyOrigin(el, state.trigger, state.point);
      el.classList.add(OUT_CLASS);
    });

    state.outTimer = setTimeout(function () {
      state.outTimer = 0;
      internalWrite(el, function () {
        el.classList.remove(OUT_CLASS);
        el.style.removeProperty(DISPLAY_VAR);
        clearOrigin(el);
      });
    }, OUT_MS);
  }

  function evaluate(el) {
    if (!isPopup(el)) return;

    var state = getState(el);
    if (state.internal > 0) return;

    var shown = isShown(el);

    if (shown && !state.open) {
      state.open = true;
      state.display = window.getComputedStyle(el).display;
      playIn(el);
    } else if (!shown && state.open) {
      state.open = false;
      /* Some popups (the mobile age gate) already fade themselves out with
         their own opacity transition before being hidden. Re-animating them
         from a full-size frame would make them flash back, so leave those alone. */
      if (currentOpacity(el) > 0.05) {
        playOut(el, state.display);
      }
    } else if (shown) {
      state.display = window.getComputedStyle(el).display;
    }
  }

  var pending = null;
  var scheduled = false;

  function flush() {
    scheduled = false;
    var queue = pending;
    pending = null;
    if (!queue) return;
    queue.forEach(function (el) {
      evaluate(el);
    });
  }

  function scheduleFlush() {
    if (scheduled) return;
    scheduled = true;
    /* Microtask (not rAF) so the start frame is applied before the browser
       paints the newly shown / hidden popup. rAF runs after paint and is
       what made the old dissolve flash a full-size frame first. */
    if (typeof queueMicrotask === 'function') {
      queueMicrotask(flush);
    } else {
      Promise.resolve().then(flush);
    }
  }

  function queue(el) {
    if (!el || el.nodeType !== 1) return;
    if (!pending) pending = new Set();
    pending.add(el);
    scheduleFlush();
  }

  function queueTree(root) {
    if (!root || root.nodeType !== 1) return;
    queue(root);
    if (typeof root.querySelectorAll === 'function') {
      var found = root.querySelectorAll(SELECTOR);
      for (var i = 0; i < found.length; i++) queue(found[i]);
    }
  }

  function observe() {
    var observer = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var record = records[i];

        if (record.type === 'attributes') {
          queue(record.target);
          continue;
        }

        for (var j = 0; j < record.addedNodes.length; j++) {
          queueTree(record.addedNodes[j]);
        }
      }
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style', 'class', 'hidden', 'open'],
      childList: true,
      subtree: true
    });
  }

  function init() {
    document.addEventListener('pointerdown', rememberTrigger, true);
    document.addEventListener('click', rememberTrigger, true);

    var popups = document.querySelectorAll(SELECTOR);
    for (var i = 0; i < popups.length; i++) {
      var el = popups[i];
      if (!isPopup(el)) continue;
      var state = getState(el);
      state.open = isShown(el);
      if (state.open) {
        state.display = window.getComputedStyle(el).display;
        playIn(el);
      }
    }
    observe();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

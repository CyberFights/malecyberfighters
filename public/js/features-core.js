/* ============================================================
   features-core.js — the shared base for the feature modules
   ------------------------------------------------------------
   The site's pages are hand-written classic scripts that share one
   global scope, but the desktop page and the mobile page each keep
   their own session/socket helpers (utils.js vs the mobile IIFE).
   The feature modules added alongside them (LFG, challenges, match
   record, achievements, preferences, message extras, room
   moderation) need the same three things on both pages:

     • who is signed in   — read from the same localStorage keys
                            every existing script already uses
     • an authenticated
       fetch              — cookie or bearer token, exactly like
                            utils.js authFetch
     • a popup + toast
       scaffold           — one markup/CSS vocabulary
                            (features.css) shared by all of them

   Everything lives under window.MCF and degrades to a no-op when
   a page does not carry the matching markup, so a script can be
   included anywhere without breaking it.
============================================================ */
(function () {
  'use strict';

  if (window.MCF) return;

  var SESSION_KEYS = ['cw_session_v1', 'currentUser'];

  function session() {
    for (var i = 0; i < SESSION_KEYS.length; i++) {
      try {
        var raw = localStorage.getItem(SESSION_KEYS[i]);
        var parsed = raw ? JSON.parse(raw) : null;
        if (parsed && parsed.username) return parsed;
      } catch (e) { /* keep looking */ }
    }
    return null;
  }

  function sessionToken() {
    try { return localStorage.getItem('cw_token_v1') || null; } catch (e) { return null; }
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /** fetch() with the session token attached (cookie already rides along). */
  function authFetch(url, options) {
    options = options || {};
    var headers = Object.assign({}, options.headers || {});
    var token = sessionToken();
    if (token && !headers.Authorization) headers.Authorization = 'Bearer ' + token;
    if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    options.headers = headers;
    options.credentials = options.credentials || 'same-origin';
    return fetch(url, options);
  }

  function getJSON(url) {
    return authFetch(url).then(function (res) { return res.json(); }).catch(function () { return null; });
  }

  function postJSON(url, body, method) {
    return authFetch(url, {
      method: method || 'POST',
      body: JSON.stringify(body || {})
    }).then(function (res) { return res.json(); }).catch(function () { return null; });
  }

  /* ---------- popup scaffold ---------- */

  var openPopups = [];

  /**
   * Build a modal popup. Returns { el, body, close, setTitle }.
   *
   * The caller owns the body's markup; the scaffold owns the chrome (title,
   * close button, overlay, Escape handling) so every feature popup behaves
   * the same way.
   */
  function popup(opts) {
    opts = opts || {};
    var overlay = document.createElement('div');
    overlay.className = 'mcf-modal' + (opts.wide ? ' mcf-modal-wide' : '');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    if (opts.label) overlay.setAttribute('aria-label', opts.label);

    var panel = document.createElement('div');
    panel.className = 'mcf-modal-panel';

    var header = document.createElement('div');
    header.className = 'mcf-modal-header';
    header.innerHTML =
      '<h3 class="mcf-modal-title"></h3>' +
      '<button type="button" class="mcf-modal-close" aria-label="Close">✕</button>';
    panel.appendChild(header);

    var body = document.createElement('div');
    body.className = 'mcf-modal-body';
    panel.appendChild(body);

    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    var titleEl = header.querySelector('.mcf-modal-title');
    if (opts.title) titleEl.textContent = opts.title;

    function close() {
      overlay.classList.remove('mcf-open');
      document.removeEventListener('keydown', overlay._mcfKeydown);
      var index = openPopups.indexOf(api);
      if (index !== -1) openPopups.splice(index, 1);
      // Let the fade-out finish before the node goes away.
      setTimeout(function () { overlay.remove(); }, 180);
      if (typeof opts.onClose === 'function') opts.onClose();
    }

    var api = {
      el: overlay,
      body: body,
      close: close,
      setTitle: function (text) { titleEl.textContent = text; }
    };

    header.querySelector('.mcf-modal-close').addEventListener('click', close);
    overlay.addEventListener('mousedown', function (e) {
      if (e.target === overlay) close();
    });
    overlay._mcfKeydown = function (e) {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', overlay._mcfKeydown);

    openPopups.push(api);
    requestAnimationFrame(function () { overlay.classList.add('mcf-open'); });

    return api;
  }

  /* ---------- toasts ---------- */

  var toastRoot = null;

  function toast(message, kind) {
    try {
      if (!toastRoot) {
        toastRoot = document.createElement('div');
        toastRoot.className = 'mcf-toast-root';
        document.body.appendChild(toastRoot);
      }
      var el = document.createElement('div');
      el.className = 'mcf-toast' + (kind ? ' mcf-toast-' + kind : '');
      el.textContent = String(message);
      toastRoot.appendChild(el);
      requestAnimationFrame(function () { el.classList.add('mcf-toast-in'); });
      setTimeout(function () {
        el.classList.remove('mcf-toast-in');
        setTimeout(function () { el.remove(); }, 300);
      }, 4200);
    } catch (e) { /* toasts are decoration; never fatal */ }
  }

  /* ---------- misc helpers ---------- */

  function timeLabel(value) {
    try {
      var date = value ? new Date(value) : null;
      if (!date || isNaN(date.getTime())) return '';
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      return '';
    }
  }

  function dateLabel(value) {
    try {
      var date = value ? new Date(value) : null;
      if (!date || isNaN(date.getTime())) return '';
      return date.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
    } catch (e) {
      return '';
    }
  }

  /** "2h ago" style relative label, used by presence + boards. */
  function agoLabel(value) {
    try {
      var date = value ? new Date(value) : null;
      if (!date || isNaN(date.getTime())) return '';
      var seconds = Math.floor((Date.now() - date.getTime()) / 1000);
      if (seconds < 45) return 'just now';
      var minutes = Math.floor(seconds / 60);
      if (minutes < 60) return minutes + 'm ago';
      var hours = Math.floor(minutes / 60);
      if (hours < 24) return hours + 'h ago';
      var days = Math.floor(hours / 24);
      if (days < 30) return days + 'd ago';
      return dateLabel(date);
    } catch (e) {
      return '';
    }
  }

  window.MCF = {
    session: session,
    sessionToken: sessionToken,
    authFetch: authFetch,
    getJSON: getJSON,
    postJSON: postJSON,
    popup: popup,
    toast: toast,
    escapeHtml: escapeHtml,
    timeLabel: timeLabel,
    dateLabel: dateLabel,
    agoLabel: agoLabel
  };
})();

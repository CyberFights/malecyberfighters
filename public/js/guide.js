/* ============================================================
   BEGINNER'S GUIDE — in-app modal for the how-to-cyber-wrestle
   guide (public/guide.html)

   index.html carries a "Beginner's Guide" button in both action
   rows (the hidden mobile block and the desktop header) plus an
   empty #modalGuide. This script wires every copy of the button
   — index.html deliberately keeps duplicated ids for the two
   UIs, and getElementById only reaches the first copy — and
   opens the modal.

   The guide content is fetched once from /guide (the public,
   indexable page) and only the #guideBody markup is injected
   into #guideContent, so the page and the modal share a single
   copy of the text. The markup stays plain semantic HTML so it
   reads correctly inside .modal-scroll too; desktop.css and
   mobile.css add the accent styles for .guide-callout,
   .guide-example and code chips under #guideContent.

   Integration points: Assistance has a "how to cyber wrestle"
   topic whose action clicks #btnGuide, so this module must be
   loaded (and must expose open()) for that answer to work.
   ============================================================ */
(function () {
  'use strict';

  if (window.__guideReady) return;
  window.__guideReady = true;

  var POPUP_ID = 'modalGuide';
  var CONTENT_ID = 'guideContent';
  var CLOSE_ID = 'closeGuide';
  var BUTTON_ID = 'btnGuide';
  var PAGE_URL = '/guide';
  var BODY_SELECTOR = '#guideBody';

  function byId(id) {
    return document.getElementById(id);
  }

  // index.html keeps a hidden mobile block alongside the desktop markup, so
  // ids like btnGuide exist twice. Bind every copy, like assistance.js does.
  function controlsFor(id) {
    if (!id) return [];
    return Array.prototype.slice.call(document.querySelectorAll('[id="' + id + '"]'));
  }

  function isOpen() {
    var popup = byId(POPUP_ID);
    return !!popup && popup.style.display && popup.style.display !== 'none';
  }

  /* ---------------------------------------------------------
     CONTENT — fetched from /guide once, then reused
  --------------------------------------------------------- */
  var loadState = 'idle'; // idle | loading | ready | failed

  function renderContent(html) {
    var target = byId(CONTENT_ID);
    if (!target) return;

    try {
      var parsed = new DOMParser().parseFromString(html, 'text/html');
      var body = parsed.querySelector(BODY_SELECTOR);
      target.innerHTML = body ? body.innerHTML : html;
      loadState = 'ready';
    } catch (e) {
      loadState = 'failed';
      target.innerHTML = '<p class="small muted">The guide could not be opened in this window. ' +
        'You can read it at ' + PAGE_URL + ' instead.</p>';
    }
  }

  function renderError() {
    loadState = 'failed';
    var target = byId(CONTENT_ID);
    if (target) {
      target.innerHTML = '<p class="small muted">The guide could not be loaded right now. ' +
        'Check your connection and try again, or read it at ' + PAGE_URL + '.</p>';
    }
  }

  function loadContent() {
    if (loadState === 'ready') return;
    if (loadState === 'loading') return;

    var target = byId(CONTENT_ID);
    if (!target) return;

    if (typeof window.fetch !== 'function') {
      renderError();
      return;
    }

    loadState = 'loading';
    target.innerHTML = '<p class="small muted">Loading…</p>';

    window.fetch(PAGE_URL).then(function (res) {
      if (!res.ok) throw new Error('http_' + res.status);
      return res.text();
    }).then(function (html) {
      renderContent(html);
    }).catch(function () {
      renderError();
    });
  }

  /* ---------------------------------------------------------
     OPEN / CLOSE
  --------------------------------------------------------- */
  function open() {
    var popup = byId(POPUP_ID);
    if (!popup) return false;
    popup.style.display = 'flex';
    popup.setAttribute('aria-hidden', 'false');
    loadContent();
    return true;
  }

  function close() {
    var popup = byId(POPUP_ID);
    if (!popup) return;
    popup.style.display = 'none';
    popup.setAttribute('aria-hidden', 'true');
  }

  /* ---------------------------------------------------------
     WIRING
  --------------------------------------------------------- */
  controlsFor(BUTTON_ID).forEach(function (button) {
    button.addEventListener('click', function () {
      open();
    });
  });

  controlsFor(CLOSE_ID).forEach(function (button) {
    button.addEventListener('click', function () {
      close();
    });
  });

  // Backdrop click closes (clicks inside .modal-box stop at the box).
  var popup = byId(POPUP_ID);
  if (popup) {
    popup.addEventListener('click', function (event) {
      if (event.target === popup) close();
    });
  }

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && isOpen()) close();
  });

  /* Public API — Assistance's guide topic and tests drive the modal
     through these instead of poking the DOM directly. */
  window.Guide = {
    open: open,
    close: close,
    isOpen: isOpen,
    loadContent: loadContent,
    PAGE_URL: PAGE_URL,
    BUTTON_ID: BUTTON_ID,
    POPUP_ID: POPUP_ID
  };
})();

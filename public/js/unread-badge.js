/*
 * Unread badge — put the count where a member will actually see it.
 *
 * The site already tracks unread DMs and unread room messages in localStorage,
 * but that number only appears inside the page: on a tab in a strip of forty,
 * or on a phone's home screen, nothing says "someone wrote to you". This reads
 * the same two counters and surfaces the total three ways, cheapest first:
 *
 *   1. document.title            "(3) Male Cyber Fighters"  — every browser
 *   2. a drawn favicon           the logo with a count bubble — every browser
 *   3. navigator.setAppBadge     the OS dock/taskbar icon    — where supported
 *
 * It owns no state of its own. The counts live in the maps the chat code
 * already maintains, so reading them back keeps this honest: refresh() after
 * any change, and the badge is right. A `storage` listener means a message
 * read in one tab also clears the badge in every other tab of the same browser.
 */
(function () {
  'use strict';

  var DM_KEY = 'cw_dm_unread';
  var ROOM_KEY = 'cw_room_unread';
  var MAX_SHOWN = 99;

  var baseTitle = null;
  var iconLink = null;
  var baseIconHref = null;
  var baseIcon = null;
  var baseIconReady = false;
  var lastTotal = -1;
  var lastDrawnHref = null;

  function sumMap(raw) {
    if (!raw) return 0;
    var map;
    try {
      map = JSON.parse(raw);
    } catch (e) {
      return 0;
    }
    if (!map || typeof map !== 'object') return 0;
    var total = 0;
    for (var key in map) {
      if (!Object.prototype.hasOwnProperty.call(map, key)) continue;
      var n = Number(map[key]);
      if (isFinite(n) && n > 0) total += n;
    }
    return total;
  }

  /* A page may count something it does not persist — the mobile client keeps
     unread rooms in memory only. Registering a source keeps the badge complete
     without this module having to know any page's internals. */
  var sources = [];

  function addSource(fn) {
    if (typeof fn === 'function' && sources.indexOf(fn) === -1) {
      sources.push(fn);
      refresh();
    }
  }

  function totalUnread() {
    var dm = 0, room = 0;
    try {
      dm = sumMap(localStorage.getItem(DM_KEY));
      room = sumMap(localStorage.getItem(ROOM_KEY));
    } catch (e) {
      // localStorage can throw in private mode; a missing badge beats a crash.
      dm = 0; room = 0;
    }
    var total = dm + room;
    for (var i = 0; i < sources.length; i++) {
      var extra = 0;
      try {
        extra = Number(sources[i]()) || 0;
      } catch (e) {
        extra = 0;
      }
      if (extra > 0) total += extra;
    }
    return total;
  }

  /* TITLE ------------------------------------------------------------ */

  function captureBaseTitle() {
    if (baseTitle !== null) return baseTitle;
    var current = document.title || 'Male Cyber Fighters';
    // Strip a count this module (or a previous load) already put there.
    baseTitle = current.replace(/^\(\d+\)\s*/, '');
    return baseTitle;
  }

  function renderTitle(total) {
    var base = captureBaseTitle();
    document.title = total > 0 ? '(' + total + ') ' + base : base;
  }

  /* FAVICON ---------------------------------------------------------- */

  function findIconLink() {
    if (iconLink) return iconLink;
    iconLink = document.querySelector('link[rel="icon"], link[rel~="icon"]');
    if (!iconLink) {
      // No icon in the markup: make one so the badge still has somewhere to go.
      iconLink = document.createElement('link');
      iconLink.rel = 'icon';
      iconLink.type = 'image/png';
      iconLink.href = '/images/mcf-192.png';
      document.head.appendChild(iconLink);
    }
    baseIconHref = iconLink.getAttribute('href');
    return iconLink;
  }

  function loadBaseIcon() {
    if (baseIcon || !baseIconHref) return;
    baseIcon = new Image();
    baseIcon.onload = function () {
      baseIconReady = true;
      // A count may have arrived before the logo did; draw it now.
      if (lastTotal > 0) drawFavicon(lastTotal);
    };
    baseIcon.onerror = function () { baseIconReady = false; };
    baseIcon.src = baseIconHref;
  }

  function drawFavicon(total) {
    var link = findIconLink();

    if (total <= 0) {
      if (lastDrawnHref && baseIconHref && link.getAttribute('href') !== baseIconHref) {
        link.setAttribute('href', baseIconHref);
        lastDrawnHref = null;
      }
      return;
    }

    if (!baseIconReady || !baseIcon) return; // drawn on load instead

    var SIZE = 64;
    var canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    var ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.drawImage(baseIcon, 0, 0, SIZE, SIZE);

    var label = total > MAX_SHOWN ? MAX_SHOWN + '+' : String(total);
    var radius = label.length > 1 ? SIZE * 0.34 : SIZE * 0.28;
    var cx = SIZE - radius * 0.82;
    var cy = radius * 0.82;

    // A light ring keeps the bubble readable over any part of the artwork.
    ctx.beginPath();
    ctx.arc(cx, cy, radius + 2, 0, Math.PI * 2);
    ctx.fillStyle = '#05070d';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = '#ff2d55';
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.font = '700 ' + Math.round(radius * (label.length > 2 ? 0.85 : 1.05)) + 'px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, cx, cy + 1);

    try {
      var href = canvas.toDataURL('image/png');
      link.setAttribute('href', href);
      lastDrawnHref = href;
    } catch (e) {
      // A tainted canvas or a blocked data: URL is not worth breaking over.
    }
  }

  /* APP BADGE -------------------------------------------------------- */

  /* Whether we currently hold an OS badge. Clearing one we never set would mean
     calling into the platform on every page load that happens to have nothing
     unread. */
  var appBadgeSet = false;

  function renderAppBadge(total) {
    try {
      if (total > 0) {
        if (navigator.setAppBadge) {
          appBadgeSet = true;
          navigator.setAppBadge(total).catch(function () {});
        }
      } else if (appBadgeSet && navigator.clearAppBadge) {
        appBadgeSet = false;
        navigator.clearAppBadge().catch(function () {});
      }
    } catch (e) { /* not supported everywhere; the title still carries it */ }
  }

  /* PUBLIC API ------------------------------------------------------- */

  function refresh() {
    var total = totalUnread();
    if (total === lastTotal) return;
    lastTotal = total;
    renderTitle(total);
    drawFavicon(total);
    renderAppBadge(total);
  }

  findIconLink();
  loadBaseIcon();
  refresh();

  // Another tab of the same browser read (or received) something.
  window.addEventListener('storage', function (event) {
    if (!event.key || event.key === DM_KEY || event.key === ROOM_KEY) refresh();
  });

  // Coming back to a tab is when a stale badge is most likely.
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) refresh();
  });

  window.MCFUnreadBadge = {
    refresh: refresh,
    total: totalUnread,
    addSource: addSource
  };
})();

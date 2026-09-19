/* ============================================================
   nav-groups.js — category menus for the action buttons
   ------------------------------------------------------------
   The action row used to be one long column of buttons. index.html
   now groups them by category: each `.nav-group` is a toggle button
   (Account, Chatrooms, Community, Matches, Help) plus a
   `.nav-group-menu` holding the original buttons — same ids, same
   handlers. auth.js, dm-toggle.js, forums.js and the rest bind to
   those buttons exactly as before; this module never touches them.

   What it does
     • press a category → its menu opens and any other open menu
       closes; press it again → it closes
     • press a button inside a menu → that button does its job, then
       the menu closes. The close is deferred a tick so
       popup-dissolve.js can still measure the button the new window
       should grow out of.
     • click / tap anywhere else, or Escape → every menu closes
       (Escape hands focus back to the toggle that owned it)
     • ArrowDown / ArrowUp / Home / End step through a menu's
       buttons; ArrowDown or ArrowUp on a toggle opens its menu and
       lands on the first / last button
     • a category shows a small count or dot when a button inside it
       carries one (#dmBadge's unread count, the "•" the LFG and
       Challenges boards append), so an unread DM is never hidden by
       a closed menu

   Layout — the flyout on desktop, the drop-down on phones — is all
   CSS: see the .nav-group rules in desktop.css and mobile.css.

   The page carries two copies of the action row (the mobile block and
   the desktop block) so everything here works per `.nav-group`, never
   by id.
============================================================ */
(function () {
  'use strict';

  if (window.MCFNav) return;

  var GROUP = '.nav-group';
  var TOGGLE = '.nav-group-toggle';
  var MENU = '.nav-group-menu';
  var BADGE = '.nav-group-badge';
  var ITEM = 'button, a[href]';
  var OPEN_CLASS = 'nav-group-open';

  var slice = Array.prototype.slice;

  function allGroups() {
    return slice.call(document.querySelectorAll(GROUP));
  }

  /** The group's own toggle / menu: its direct children, not a nested one. */
  function childMatching(group, selector) {
    var kids = group.children;
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].matches && kids[i].matches(selector)) return kids[i];
    }
    return null;
  }
  function toggleOf(group) { return childMatching(group, TOGGLE); }
  function menuOf(group) { return childMatching(group, MENU); }

  function isOpen(group) {
    return group.classList.contains(OPEN_CLASS);
  }

  function setOpen(group, open) {
    var toggle = toggleOf(group);
    var menu = menuOf(group);
    if (!toggle || !menu) return;
    group.classList.toggle(OPEN_CLASS, open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    menu.hidden = !open;
  }

  function closeAll(except) {
    allGroups().forEach(function (group) {
      if (group !== except && isOpen(group)) setOpen(group, false);
    });
  }

  /** Opens one group and closes the rest — one menu at a time. */
  function openGroup(group) {
    closeAll(group);
    setOpen(group, true);
  }

  /** The buttons a menu currently offers (hidden / disabled ones skipped). */
  function itemsOf(menu) {
    return slice.call(menu.querySelectorAll(ITEM)).filter(function (el) {
      if (el.disabled || el.hidden) return false;
      if (el.style && el.style.display === 'none') return false;
      return true;
    });
  }

  function elementFrom(event) {
    var target = event.target;
    if (target && target.nodeType === 3) target = target.parentElement;
    if (!target || target.nodeType !== 1 || typeof target.closest !== 'function') return null;
    return target;
  }

  /* ---------------------------------------------------------
     BADGES
     Mirrors what the buttons inside a menu show: the DMs unread
     count (#dmBadge, a .badge toggled through style.display) and
     the "•" .mcf-btn-badge that lfg.js / challenges.js append.
  --------------------------------------------------------- */
  function badgeState(menu) {
    var total = 0;
    var overflow = false;
    var dot = false;

    slice.call(menu.querySelectorAll('.badge, .dm-unread-badge, .mcf-btn-badge')).forEach(function (el) {
      if (el.hidden || (el.style && el.style.display === 'none')) return;
      if (el.classList.contains('mcf-btn-badge')) { dot = true; return; }
      var text = String(el.textContent || '').trim();
      if (!text) return;
      var n = parseInt(text, 10);
      if (isNaN(n)) { dot = true; return; }
      total += n;
      if (/\+$/.test(text)) overflow = true;
    });

    if (total > 0) return { kind: 'count', label: overflow || total > 99 ? '99+' : String(total) };
    if (dot) return { kind: 'dot', label: '' };
    return null;
  }

  function badgeOf(toggle) {
    var badge = toggle.querySelector(BADGE);
    if (badge) return badge;
    badge = document.createElement('span');
    badge.className = 'nav-group-badge';
    badge.hidden = true;
    var caret = toggle.querySelector('.nav-caret');
    if (caret) toggle.insertBefore(badge, caret);
    else toggle.appendChild(badge);
    return badge;
  }

  function renderBadge(group) {
    var toggle = toggleOf(group);
    var menu = menuOf(group);
    if (!toggle || !menu) return;

    var badge = badgeOf(toggle);
    var state = badgeState(menu);

    if (!state) {
      badge.hidden = true;
      badge.textContent = '';
      badge.classList.remove('nav-group-badge-dot');
      badge.removeAttribute('aria-label');
      return;
    }

    badge.hidden = false;
    badge.textContent = state.label;
    badge.classList.toggle('nav-group-badge-dot', state.kind === 'dot');
    badge.setAttribute('aria-label', state.kind === 'count' ? state.label + ' unread' : 'new activity');
  }

  function refreshBadges() {
    allGroups().forEach(renderBadge);
  }

  function watchBadges(group) {
    var menu = menuOf(group);
    if (!menu || typeof MutationObserver !== 'function') return;
    var queued = false;
    var observer = new MutationObserver(function () {
      if (queued) return;
      queued = true;
      // One redraw per burst of changes, after the app's own writes land.
      setTimeout(function () {
        queued = false;
        renderBadge(group);
      }, 0);
    });
    observer.observe(menu, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['style', 'hidden', 'class']
    });
  }

  /* ---------------------------------------------------------
     EVENTS
  --------------------------------------------------------- */
  function onClick(event) {
    var el = elementFrom(event);
    if (!el) return;

    var toggle = el.closest(TOGGLE);
    if (toggle) {
      var group = toggle.closest(GROUP);
      if (!group) return;
      if (isOpen(group)) setOpen(group, false);
      else openGroup(group);
      return;
    }

    var menu = el.closest(MENU);
    if (!menu) return;
    var item = el.closest(ITEM);
    if (!item || !menu.contains(item)) return;

    var owner = menu.closest(GROUP);
    if (!owner) return;
    // Close on the next tick, not now: the button's own handler (bound on the
    // button itself) runs after this capture-phase listener, and
    // popup-dissolve.js then measures the pressed button in a microtask so
    // the new window can grow out of it. Both need the button still laid out.
    setTimeout(function () { setOpen(owner, false); }, 0);
  }

  /** A press outside every group closes whatever is open. */
  function onPointerDown(event) {
    var el = elementFrom(event);
    if (el && el.closest(GROUP)) return;
    closeAll();
  }

  function onKeydown(event) {
    var key = event.key;

    if (key === 'Escape' || key === 'Esc') {
      var open = allGroups().filter(isOpen);
      if (!open.length) return;
      var active = document.activeElement;
      var owner = active && typeof active.closest === 'function' ? active.closest(GROUP) : null;
      open.forEach(function (group) { setOpen(group, false); });
      if (owner && open.indexOf(owner) !== -1) {
        var t = toggleOf(owner);
        if (t) t.focus();
      }
      return;
    }

    if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'Home' && key !== 'End') return;

    var el = elementFrom(event);
    if (!el) return;
    var group = el.closest(GROUP);
    if (!group) return;
    var toggle = toggleOf(group);
    var menu = menuOf(group);
    if (!toggle || !menu) return;

    var items;
    if (toggle.contains(el)) {
      if (key !== 'ArrowDown' && key !== 'ArrowUp') return;
      event.preventDefault();
      if (!isOpen(group)) openGroup(group);
      items = itemsOf(menu);
      if (items.length) (key === 'ArrowDown' ? items[0] : items[items.length - 1]).focus();
      return;
    }

    if (!menu.contains(el)) return;
    items = itemsOf(menu);
    if (!items.length) return;
    event.preventDefault();

    var current = items.indexOf(el.closest(ITEM));
    var next;
    if (key === 'Home') next = items[0];
    else if (key === 'End') next = items[items.length - 1];
    else if (key === 'ArrowDown') next = items[(current + 1) % items.length];
    else next = items[(current - 1 + items.length) % items.length];
    next.focus();
  }

  /** Tabbing out of an open menu closes it, so it does not linger. */
  function onFocusOut(event) {
    var el = elementFrom(event);
    var group = el ? el.closest(GROUP) : null;
    if (!group || !isOpen(group)) return;
    var next = event.relatedTarget;
    // No relatedTarget means focus went to the page body (a click on empty
    // space, or a window that opened); the pointer / item handlers own those.
    if (!next || typeof next.closest !== 'function') return;
    if (next.closest(GROUP) === group) return;
    // Deferred for the same reason as the item click: a window that takes
    // focus as it opens must not hide the button it is growing out of.
    setTimeout(function () { setOpen(group, false); }, 0);
  }

  /* ---------------------------------------------------------
     BOOT
  --------------------------------------------------------- */
  var counter = 0;

  function initGroup(group) {
    if (group.dataset.navReady) return;
    var toggle = toggleOf(group);
    var menu = menuOf(group);
    if (!toggle || !menu) return;
    group.dataset.navReady = '1';

    counter += 1;
    // aria-controls needs a unique id; the row exists twice on the page, so
    // the ids are minted here rather than written in the markup.
    if (!menu.id) menu.id = 'navGroupMenu' + counter;
    toggle.setAttribute('aria-controls', menu.id);
    toggle.setAttribute('aria-expanded', isOpen(group) ? 'true' : 'false');
    menu.hidden = !isOpen(group);

    badgeOf(toggle);
    renderBadge(group);
    watchBadges(group);
  }

  function init() {
    allGroups().forEach(initGroup);

    // Capture phase: a button handler that stops propagation can still not
    // leave its menu hanging open behind the window it just opened.
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeydown);
    document.addEventListener('focusout', onFocusOut);
    if (window.PointerEvent) {
      document.addEventListener('pointerdown', onPointerDown, true);
    } else {
      document.addEventListener('mousedown', onPointerDown, true);
      document.addEventListener('touchstart', onPointerDown, true);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /** Small public surface: open a category by its data-nav-group key. */
  window.MCFNav = {
    open: function (key) {
      var groups = allGroups().filter(function (group) {
        return group.getAttribute('data-nav-group') === key;
      });
      if (!groups.length) return false;
      closeAll();
      groups.forEach(function (group) { setOpen(group, true); });
      return true;
    },
    closeAll: function () { closeAll(); },
    isOpen: function (key) {
      return allGroups().some(function (group) {
        return group.getAttribute('data-nav-group') === key && isOpen(group);
      });
    },
    refreshBadges: refreshBadges
  };
})();

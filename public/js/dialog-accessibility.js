/* Small focus-management helper for the static legal and support dialogs.
   These stay as existing overlay markup so legacy event handlers keep working,
   but keyboard users get a labelled modal, an initial focus target, a Tab trap,
   Escape-to-close, and focus restored to the control that opened it. */
(function () {
  'use strict';

  var FOCUSABLE = 'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  var states = new WeakMap();
  var openDialogs = [];
  var lastReturnFocus = null;

  function resolve(dialogOrId) {
    return typeof dialogOrId === 'string'
      ? document.getElementById(dialogOrId)
      : dialogOrId;
  }

  function isOpen(dialog) {
    return !!dialog
      && dialog.getAttribute('aria-hidden') !== 'true'
      && dialog.style.display !== 'none';
  }

  function focusableElements(dialog) {
    return Array.prototype.slice.call(dialog.querySelectorAll(FOCUSABLE)).filter(function (element) {
      return !element.hidden
        && element.getAttribute('aria-hidden') !== 'true'
        && element.getClientRects().length > 0;
    });
  }

  function isVisible(element) {
    return !!element
      && element.isConnected
      && !element.hidden
      && element.getAttribute('aria-hidden') !== 'true'
      && element.getClientRects().length > 0;
  }

  function focus(element) {
    if (!isVisible(element)) return;
    try {
      element.focus({ preventScroll: true });
    } catch (error) {
      element.focus();
    }
  }

  function topOpenDialog() {
    for (var i = openDialogs.length - 1; i >= 0; i -= 1) {
      if (isOpen(openDialogs[i])) return openDialogs[i];
    }
    return null;
  }

  function open(dialogOrId) {
    var dialog = resolve(dialogOrId);
    if (!dialog) return false;

    if (!states.has(dialog)) {
      var returnFocus = document.activeElement;
      if (!isVisible(returnFocus) && isVisible(lastReturnFocus)) returnFocus = lastReturnFocus;
      states.set(dialog, { returnFocus: returnFocus });
    }
    var existingIndex = openDialogs.indexOf(dialog);
    if (existingIndex !== -1) openDialogs.splice(existingIndex, 1);
    openDialogs.push(dialog);

    dialog.style.display = 'flex';
    dialog.style.visibility = 'visible';
    dialog.style.pointerEvents = 'auto';
    dialog.setAttribute('aria-hidden', 'false');

    var target = dialog.querySelector('[data-dialog-initial-focus]')
      || focusableElements(dialog)[0]
      || dialog.querySelector('.modal-box, .support-mobile')
      || dialog;
    if (target === dialog && !dialog.hasAttribute('tabindex')) {
      dialog.setAttribute('tabindex', '-1');
    }

    window.requestAnimationFrame(function () {
      if (isOpen(dialog)) focus(target);
    });
    return true;
  }

  function close(dialogOrId) {
    var dialog = resolve(dialogOrId);
    if (!dialog) return false;

    dialog.style.display = 'none';
    dialog.style.visibility = 'hidden';
    dialog.style.pointerEvents = 'none';
    dialog.setAttribute('aria-hidden', 'true');

    var index = openDialogs.indexOf(dialog);
    if (index !== -1) openDialogs.splice(index, 1);
    var state = states.get(dialog);
    states.delete(dialog);

    var restoreFocus = state && isVisible(state.returnFocus) ? state.returnFocus : null;
    if (restoreFocus) lastReturnFocus = restoreFocus;
    else if (isVisible(lastReturnFocus)) restoreFocus = lastReturnFocus;

    var nextDialog = topOpenDialog();
    if (nextDialog) {
      var nextTarget = nextDialog.querySelector('[data-dialog-initial-focus]')
        || focusableElements(nextDialog)[0];
      if (nextTarget) focus(nextTarget);
    } else if (restoreFocus) {
      window.requestAnimationFrame(function () { focus(restoreFocus); });
    }
    return true;
  }

  document.addEventListener('keydown', function (event) {
    var dialog = topOpenDialog();
    if (!dialog) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      close(dialog);
      return;
    }
    if (event.key !== 'Tab') return;

    var elements = focusableElements(dialog);
    if (!elements.length) {
      event.preventDefault();
      focus(dialog);
      return;
    }

    var first = elements[0];
    var last = elements[elements.length - 1];
    var active = document.activeElement;
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault();
      focus(last);
    } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
      event.preventDefault();
      focus(first);
    }
  }, true);

  window.MCFDialogAccessibility = { open: open, close: close, isOpen: isOpen };
})();

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HELPER = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'dialog-accessibility.js'),
  'utf8'
);

function mockDialogEnvironment() {
  const document = {
    activeElement: null,
    elements: {},
    listeners: {},
    getElementById(id) { return this.elements[id] || null; },
    addEventListener(type, listener) { this.listeners[type] = listener; },
    contains(element) { return !!element && element.isConnected; }
  };
  const window = { requestAnimationFrame(callback) { callback(); } };

  function element(id, attributes = {}) {
    const instance = {
      id,
      attributes: { ...attributes },
      style: { display: '' },
      hidden: false,
      isConnected: true,
      ownerDialog: null,
      getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attributes, name)
          ? this.attributes[name]
          : null;
      },
      hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name); },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      getClientRects() {
        return this.hidden || (this.ownerDialog && this.ownerDialog.style.display === 'none') ? [] : [{}];
      },
      focus() { document.activeElement = this; }
    };
    return instance;
  }

  const opener = element('opener');
  const secondOpener = element('second-opener');
  const closeButton = element('close', { 'data-dialog-initial-focus': '' });
  const actionButton = element('action');
  const panel = element('panel');
  const dialog = element('dialog', { 'aria-hidden': 'true' });
  dialog.style.display = 'none';
  dialog.focusables = [closeButton, actionButton];
  dialog.panel = panel;
  dialog.querySelector = function (selector) {
    if (selector === '[data-dialog-initial-focus]') {
      return this.focusables.find(candidate => candidate.hasAttribute('data-dialog-initial-focus')) || null;
    }
    if (selector === '.modal-box, .support-mobile') return this.panel;
    return null;
  };
  dialog.querySelectorAll = function () { return this.focusables; };
  dialog.contains = function (candidate) {
    return candidate === this || candidate === this.panel || this.focusables.includes(candidate);
  };
  for (const child of [...dialog.focusables, panel]) child.ownerDialog = dialog;

  document.elements.dialog = dialog;
  document.activeElement = opener;
  vm.runInNewContext(HELPER, { document, window });

  return { document, window, dialog, opener, secondOpener, closeButton, actionButton };
}

test('dialog helper traps Tab, closes on Escape, and restores the opener focus', () => {
  const { document, window, dialog, opener, secondOpener, closeButton, actionButton } = mockDialogEnvironment();
  const dialogs = window.MCFDialogAccessibility;

  assert.equal(dialogs.open('dialog'), true);
  assert.equal(dialog.getAttribute('aria-hidden'), 'false');
  assert.equal(dialog.style.display, 'flex');
  assert.equal(document.activeElement, closeButton, 'opening focuses the marked initial target');

  let prevented = false;
  document.listeners.keydown({
    key: 'Tab', shiftKey: false, preventDefault() { prevented = true; }
  });
  assert.equal(prevented, false, 'Tab from the first item is left to the browser');

  actionButton.focus();
  document.listeners.keydown({
    key: 'Tab', shiftKey: false, preventDefault() { prevented = true; }
  });
  assert.equal(prevented, true, 'Tab from the last item is trapped');
  assert.equal(document.activeElement, closeButton);

  closeButton.focus();
  prevented = false;
  document.listeners.keydown({
    key: 'Tab', shiftKey: true, preventDefault() { prevented = true; }
  });
  assert.equal(prevented, true, 'Shift+Tab from the first item is trapped');
  assert.equal(document.activeElement, actionButton);

  dialogs.close('dialog');
  assert.equal(dialog.getAttribute('aria-hidden'), 'true');
  assert.equal(dialog.style.display, 'none');
  assert.equal(document.activeElement, opener, 'closing restores focus to the original opener');

  document.activeElement = closeButton; // a stale active element inside the now-hidden dialog
  dialogs.open(dialog);
  dialogs.close(dialog);
  assert.equal(document.activeElement, opener, 'reopening from a hidden element keeps a visible restoration target');

  document.activeElement = secondOpener;
  dialogs.open(dialog);
  let escapePrevented = false;
  document.listeners.keydown({
    key: 'Escape', preventDefault() { escapePrevented = true; }
  });
  assert.equal(escapePrevented, true);
  assert.equal(dialog.getAttribute('aria-hidden'), 'true');
  assert.equal(document.activeElement, secondOpener, 'Escape closes and restores the latest opener');
});

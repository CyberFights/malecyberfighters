/**
 * Tests for the extra profile photo gallery (public/js/utils.js and the
 * mobile copy in public/js/mobile.js).
 *
 * Clicking an extra photo on a profile must open the image in a popup
 * window — window.open() called with sizing features — instead of a plain
 * new tab. Modified clicks (ctrl/cmd-click, middle-click) must keep the
 * browser's default link behaviour so "open in new tab" still works.
 *
 * utils.js is loaded standalone; the mobile gallery is exercised through the
 * real mobile.html page booted the same way mobile-client.test.js boots it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const UTILS_SOURCE = fs.readFileSync(path.join(ROOT, 'public', 'js', 'utils.js'), 'utf8');
const MOBILE_PAGE = fs.readFileSync(path.join(ROOT, 'public', 'mobile.html'), 'utf8');
const MOBILE_SOURCE = fs.readFileSync(path.join(ROOT, 'public', 'js', 'mobile.js'), 'utf8');

const PHOTO_URLS = [
  'https://i.ibb.co/abc123/first.jpg',
  'https://i.ibb.co/def456/second.jpg'
];

const tick = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await tick(25);
  }
  return predicate();
}

/** Replace window.open with a recorder so tests can assert the popup call. */
function stubWindowOpen(win) {
  const opened = [];
  win.open = (...args) => {
    opened.push(args);
    return null;
  };
  return opened;
}

/** Dispatch a click and report whether the page let the default action run. */
function click(win, target, overrides = {}) {
  const event = new win.MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    button: 0,
    ...overrides
  });
  // dispatchEvent returns false once a handler calls preventDefault().
  return target.dispatchEvent(event);
}

function assertPopupCall(call, expectedUrl) {
  assert.ok(call, 'window.open should have been called');
  const [url, target, features] = call;
  assert.equal(url, expectedUrl);
  assert.equal(target, '_blank');
  const featureList = String(features || '');
  // Sizing features are what make a browser open a popup window rather than a tab.
  assert.match(featureList, /(^|,)width=\d+/);
  assert.match(featureList, /(^|,)height=\d+/);
  assert.match(featureList, /(^|,)noopener/);
}

/* --------------------------------------------------------------------- */
/* Shared gallery (public/js/utils.js — desktop + own profile)            */
/* --------------------------------------------------------------------- */

function loadUtilsPage() {
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="vpExtraPhotos" class="profile-photo-grid"></div></body></html>',
    { url: 'http://127.0.0.1/', pretendToBeVisual: true, runScripts: 'dangerously' }
  );
  const win = dom.window;
  const opened = stubWindowOpen(win);
  win.eval(UTILS_SOURCE);
  return { dom, win, opened };
}

test('clicking an extra profile photo opens a popup window, not a tab', () => {
  const { dom, win, opened } = loadUtilsPage();

  win.renderProfilePhotoGallery(win.document.getElementById('vpExtraPhotos'), PHOTO_URLS);

  const tiles = win.document.querySelectorAll('.profile-photo-tile');
  assert.equal(tiles.length, PHOTO_URLS.length, 'every extra photo should render a tile');

  const defaultAllowed = click(win, tiles[0]);
  assert.equal(defaultAllowed, false, 'the click must not fall through to the new-tab link');
  assert.equal(opened.length, 1, 'exactly one popup should open');
  assertPopupCall(opened[0], PHOTO_URLS[0]);
});

test('each photo click opens its own popup with that photo', () => {
  const { dom, win, opened } = loadUtilsPage();

  win.renderProfilePhotoGallery(win.document.getElementById('vpExtraPhotos'), PHOTO_URLS);

  const tiles = win.document.querySelectorAll('.profile-photo-tile');
  click(win, tiles[1]);
  click(win, tiles[0]);

  assert.equal(opened.length, 2);
  assertPopupCall(opened[0], PHOTO_URLS[1]);
  assertPopupCall(opened[1], PHOTO_URLS[0]);
});

test('modified and middle clicks keep the browser default behaviour', () => {
  const { dom, win, opened } = loadUtilsPage();

  win.renderProfilePhotoGallery(win.document.getElementById('vpExtraPhotos'), PHOTO_URLS);
  const tile = win.document.querySelector('.profile-photo-tile');

  const ctrlClick = click(win, tile, { ctrlKey: true });
  assert.equal(ctrlClick, true, 'ctrl-click must keep the default link action');
  assert.equal(opened.length, 0, 'ctrl-click should not open a popup');

  const middleClick = click(win, tile, { button: 1 });
  assert.equal(middleClick, true, 'middle-click must keep the default link action');
  assert.equal(opened.length, 0, 'middle-click should not open a popup');
});

test('tiles stay real links so the context menu and middle-click still work', () => {
  const { dom, win } = loadUtilsPage();

  win.renderProfilePhotoGallery(win.document.getElementById('vpExtraPhotos'), PHOTO_URLS);

  const tile = win.document.querySelector('.profile-photo-tile');
  assert.equal(tile.tagName, 'A');
  assert.equal(tile.getAttribute('href'), PHOTO_URLS[0]);
  assert.equal(tile.getAttribute('target'), '_blank');
  assert.match(tile.getAttribute('rel') || '', /noopener/);
});

/* --------------------------------------------------------------------- */
/* Mobile gallery (public/js/mobile.js through the real mobile page)      */
/* --------------------------------------------------------------------- */

/** Boots mobile.html as "bob", past the age gate, with a directory user
    "carol" carrying the extra photos under test. */
async function startMobilePage() {
  const dom = new JSDOM(MOBILE_PAGE, {
    url: 'http://127.0.0.1/',
    pretendToBeVisual: true,
    runScripts: 'dangerously'
  });
  const win = dom.window;

  const sockets = [];
  win.io = () => {
    const handlers = {};
    const sock = {
      on: (event, fn) => { (handlers[event] = handlers[event] || []).push(fn); },
      emit: (event, data) => sock.emitted.push({ event, data }),
      emitted: [],
      fire: (event, data) => (handlers[event] || []).slice().forEach(fn => fn(data)),
      handlers
    };
    sockets.push(sock);
    return sock;
  };

  win.fetch = async input => {
    const url = String(input && input.url ? input.url : input);
    const payload = url.includes('/api/allUsers')
      ? { ok: true, users: [{ username: 'carol', display: 'Carol', extraPhotos: PHOTO_URLS }] }
      : { ok: true, messages: [], partners: [], users: [], stories: [] };
    return { json: async () => payload };
  };

  const opened = stubWindowOpen(win);
  win.localStorage.setItem('cw_session_v1', JSON.stringify({ username: 'bob', display: 'bob' }));

  win.eval(MOBILE_SOURCE);

  await new Promise(resolve => {
    if (win.document.readyState !== 'loading') return resolve();
    win.document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
  });

  win.document.getElementById('confirmBtn').click();
  await waitFor(() => sockets.length >= 2, 2000);

  return {
    win,
    sockets,
    opened,
    async close() {
      await tick(200);
      win.close();
    }
  };
}

test('mobile: tapping an extra photo on a profile opens a popup window', async () => {
  const page = await startMobilePage();
  try {
    await page.win.__cw.openProfile('carol');

    const tiles = page.win.document.querySelectorAll('#vpExtraPhotos .profile-photo-tile');
    assert.equal(tiles.length, PHOTO_URLS.length, 'the profile modal should show the extra photos');

    const defaultAllowed = click(page.win, tiles[0]);
    assert.equal(defaultAllowed, false, 'the tap must not fall through to the new-tab link');
    assert.equal(page.opened.length, 1, 'exactly one popup should open');
    assertPopupCall(page.opened[0], PHOTO_URLS[0]);
  } finally {
    await page.close();
  }
});

test('mobile: ctrl-clicking a photo still uses the default new-tab link', async () => {
  const page = await startMobilePage();
  try {
    await page.win.__cw.openProfile('carol');

    const tile = page.win.document.querySelector('#vpExtraPhotos .profile-photo-tile');
    const ctrlClick = click(page.win, tile, { ctrlKey: true });
    assert.equal(ctrlClick, true, 'ctrl-click must keep the default link action');
    assert.equal(page.opened.length, 0, 'ctrl-click should not open a popup');
  } finally {
    await page.close();
  }
});

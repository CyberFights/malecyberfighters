/**
 * Tests for the unread badge (public/js/unread-badge.js), loaded into jsdom.
 *
 * The badge owns no counters — it reads the two maps the chat code already
 * keeps — so what is worth pinning down is the arithmetic (both maps, corrupt
 * data, extra sources), the three surfaces it renders to, and that reading a
 * message anywhere clears it everywhere.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { JSDOM } = require('jsdom');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'unread-badge.js'), 'utf8');

const DM_KEY = 'cw_dm_unread';
const ROOM_KEY = 'cw_room_unread';
const BASE_TITLE = 'Male Cyber Fighters';
const ICON_HREF = '/images/mcf-192.png';

/**
 * A page with the icon link the real markup carries, an Image that "loads"
 * synchronously, and a canvas that records what it was asked to draw instead of
 * needing the native canvas package.
 */
function startPage() {
  const dom = new JSDOM(`<!doctype html><html><head>
      <title>${BASE_TITLE}</title>
      <link rel="icon" type="image/png" sizes="192x192" href="${ICON_HREF}">
    </head><body></body></html>`,
    { url: 'https://male-cyber-fighters.com/', pretendToBeVisual: true, runScripts: 'dangerously' });

  const win = dom.window;
  const drawn = [];
  const badges = [];
  const iconRequests = [];

  class FakeImage {
    constructor() { this.onload = null; this.onerror = null; this._src = ''; }
    get src() { return this._src; }
    set src(value) {
      this._src = value;
      iconRequests.push(value);
      if (this.onload) this.onload();
    }
  }
  win.Image = FakeImage;

  win.HTMLCanvasElement.prototype.getContext = function () {
    return {
      drawImage: () => drawn.push('logo'),
      beginPath() {}, arc() {}, fill() {},
      fillText: text => drawn.push(String(text)),
      fillStyle: '', font: '', textAlign: '', textBaseline: ''
    };
  };
  win.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,BADGE';

  Object.defineProperty(win.navigator, 'setAppBadge', {
    value: async n => { badges.push(n); },
    configurable: true
  });
  Object.defineProperty(win.navigator, 'clearAppBadge', {
    value: async () => { badges.push(0); },
    configurable: true
  });

  win.eval(SOURCE);

  const icon = () => win.document.querySelector('link[rel="icon"]');

  return {
    win,
    drawn,
    badges,
    iconRequests,
    title: () => win.document.title,
    iconHref: () => icon().getAttribute('href'),
    badge: () => win.MCFUnreadBadge,
    setDm: map => win.localStorage.setItem(DM_KEY, JSON.stringify(map)),
    setRoom: map => win.localStorage.setItem(ROOM_KEY, JSON.stringify(map)),
    setRaw: (key, value) => win.localStorage.setItem(key, value),
    refresh: () => win.MCFUnreadBadge.refresh(),
    /** Another tab of the same browser changing a counter. */
    storageFromOtherTab: key => win.dispatchEvent(new win.StorageEvent('storage', { key })),
    close: () => win.close()
  };
}

test('nothing unread means no badge anywhere', () => {
  const page = startPage();
  try {
    assert.equal(page.title(), BASE_TITLE);
    assert.equal(page.iconHref(), ICON_HREF, 'the real favicon is untouched');
    assert.deepEqual(page.badges, []);
    assert.equal(page.badge().total(), 0);
  } finally {
    page.close();
  }
});

test('unread DMs put the count in the tab title and on the app icon', () => {
  const page = startPage();
  try {
    page.setDm({ alice: 2, bruno: 1 });
    page.refresh();

    assert.equal(page.badge().total(), 3);
    assert.equal(page.title(), `(3) ${BASE_TITLE}`);
    assert.deepEqual(page.badges, [3]);
  } finally {
    page.close();
  }
});

test('unread rooms count towards the same badge', () => {
  const page = startPage();
  try {
    page.setDm({ alice: 2 });
    page.setRoom({ 'room-1': 4, 'room-2': 1 });
    page.refresh();

    assert.equal(page.badge().total(), 7);
    assert.equal(page.title(), `(7) ${BASE_TITLE}`);
  } finally {
    page.close();
  }
});

test('a corrupt counter reads as zero instead of throwing', () => {
  const page = startPage();
  try {
    page.setRaw(DM_KEY, '{not json');
    page.setRaw(ROOM_KEY, 'null');
    page.refresh();

    assert.equal(page.badge().total(), 0);
    assert.equal(page.title(), BASE_TITLE);

    // Negative and non-numeric entries are ignored rather than subtracted.
    page.setDm({ alice: -5, bruno: 'lots', chris: 2 });
    page.refresh();
    assert.equal(page.badge().total(), 2);
  } finally {
    page.close();
  }
});

test('reading everything clears the title, the favicon and the app badge', () => {
  const page = startPage();
  try {
    page.setDm({ alice: 3 });
    page.refresh();
    assert.equal(page.title(), `(3) ${BASE_TITLE}`);

    page.setDm({});
    page.refresh();

    assert.equal(page.title(), BASE_TITLE);
    assert.equal(page.iconHref(), ICON_HREF, 'the drawn favicon is swapped back');
    assert.deepEqual(page.badges, [3, 0], 'the OS badge is cleared too');
  } finally {
    page.close();
  }
});

test('the favicon is redrawn with the count, capped at 99+', () => {
  const page = startPage();
  try {
    page.setDm({ alice: 3 });
    page.refresh();

    assert.ok(page.iconHref().startsWith('data:image/png'), 'a drawn icon replaces the file');
    assert.ok(page.drawn.includes('logo'), 'the site logo is still underneath');
    assert.ok(page.drawn.includes('3'), 'the count is on it');

    page.setDm({ alice: 400 });
    page.refresh();
    assert.ok(page.drawn.includes('99+'), 'a huge count is capped rather than overflowing');
  } finally {
    page.close();
  }
});

test('an unchanged count does not redraw or re-badge', () => {
  const page = startPage();
  try {
    page.setDm({ alice: 2 });
    page.refresh();
    const drawnAfterFirst = page.drawn.length;
    const badgesAfterFirst = page.badges.length;

    // A different split of the same total is still the same badge.
    page.setDm({ alice: 1, bruno: 1 });
    page.refresh();
    page.refresh();

    assert.equal(page.drawn.length, drawnAfterFirst);
    assert.equal(page.badges.length, badgesAfterFirst);
    assert.equal(page.title(), `(2) ${BASE_TITLE}`);
  } finally {
    page.close();
  }
});

test('a page can add counts it keeps in memory', () => {
  const page = startPage();
  try {
    let inMemoryRooms = 5;
    page.badge().addSource(() => inMemoryRooms);

    // addSource refreshes on registration.
    assert.equal(page.badge().total(), 5);
    assert.equal(page.title(), `(5) ${BASE_TITLE}`);

    page.setDm({ alice: 2 });
    page.refresh();
    assert.equal(page.badge().total(), 7);

    inMemoryRooms = 0;
    page.refresh();
    assert.equal(page.badge().total(), 2);

    // Registering the same source twice must not count it twice.
    const source = () => 1;
    page.badge().addSource(source);
    page.badge().addSource(source);
    assert.equal(page.badge().total(), 3);
  } finally {
    page.close();
  }
});

test('a source that throws is ignored rather than fatal', () => {
  const page = startPage();
  try {
    page.setDm({ alice: 1 });
    page.badge().addSource(() => { throw new Error('state not ready'); });
    page.refresh();

    assert.equal(page.badge().total(), 1);
    assert.equal(page.title(), `(1) ${BASE_TITLE}`);
  } finally {
    page.close();
  }
});

test('a message read in another tab clears this one', () => {
  const page = startPage();
  try {
    page.setDm({ alice: 4 });
    page.refresh();
    assert.equal(page.title(), `(4) ${BASE_TITLE}`);

    // The other tab wrote the same key; localStorage in this window already
    // reflects it, and the storage event is what tells this tab to look.
    page.setDm({});
    page.storageFromOtherTab(DM_KEY);

    assert.equal(page.title(), BASE_TITLE);
  } finally {
    page.close();
  }
});

test('unrelated storage writes do not trigger a redraw', () => {
  const page = startPage();
  try {
    page.setDm({ alice: 2 });
    page.refresh();
    const drawnBefore = page.drawn.length;

    page.storageFromOtherTab('cw_theme');
    assert.equal(page.drawn.length, drawnBefore);
  } finally {
    page.close();
  }
});

test('a browser with no app-badge API still gets the title and favicon', () => {
  const dom = new JSDOM(`<!doctype html><html><head>
      <title>${BASE_TITLE}</title>
      <link rel="icon" href="${ICON_HREF}">
    </head><body></body></html>`,
    { url: 'https://male-cyber-fighters.com/', pretendToBeVisual: true, runScripts: 'dangerously' });
  const win = dom.window;

  class FakeImage {
    constructor() { this.onload = null; this._src = ''; }
    get src() { return this._src; }
    set src(value) { this._src = value; if (this.onload) this.onload(); }
  }
  win.Image = FakeImage;
  win.HTMLCanvasElement.prototype.getContext = function () {
    return { drawImage() {}, beginPath() {}, arc() {}, fill() {}, fillText() {}, fillStyle: '', font: '', textAlign: '', textBaseline: '' };
  };
  win.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,BADGE';
  delete win.navigator.setAppBadge;
  delete win.navigator.clearAppBadge;

  try {
    win.eval(SOURCE);
    win.localStorage.setItem(DM_KEY, JSON.stringify({ alice: 2 }));
    win.MCFUnreadBadge.refresh();

    assert.equal(win.document.title, `(2) ${BASE_TITLE}`);
    assert.ok(win.document.querySelector('link[rel="icon"]').getAttribute('href').startsWith('data:'));
  } finally {
    win.close();
  }
});

test('a page with no icon link still gets one to draw on', () => {
  const dom = new JSDOM(`<!doctype html><html><head><title>${BASE_TITLE}</title></head><body></body></html>`,
    { url: 'https://male-cyber-fighters.com/', pretendToBeVisual: true, runScripts: 'dangerously' });
  const win = dom.window;

  const iconRequests = [];
  class FakeImage {
    constructor() { this.onload = null; this._src = ''; }
    get src() { return this._src; }
    set src(value) { this._src = value; iconRequests.push(value); if (this.onload) this.onload(); }
  }
  win.Image = FakeImage;
  win.HTMLCanvasElement.prototype.getContext = function () {
    return { drawImage() {}, beginPath() {}, arc() {}, fill() {}, fillText() {}, fillStyle: '', font: '', textAlign: '', textBaseline: '' };
  };
  win.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,BADGE';

  try {
    win.eval(SOURCE);
    const created = win.document.querySelector('link[rel="icon"]');
    assert.ok(created, 'an icon link was created');
    assert.ok(iconRequests.length >= 1, 'and a logo was fetched to draw on');

    win.localStorage.setItem(DM_KEY, JSON.stringify({ alice: 1 }));
    win.MCFUnreadBadge.refresh();
    assert.equal(win.document.title, `(1) ${BASE_TITLE}`);
  } finally {
    win.close();
  }
});

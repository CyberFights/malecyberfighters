/**
 * Tests for the mobile client (public/mobile.html + public/js/mobile.js),
 * loaded into jsdom and driven through the page's fake sockets.
 *
 * mobile.html opens two socket.io connections and registers two separate DM
 * handlers, so these tests drive both and assert the message is still counted
 * and rendered exactly once.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'mobile.html'), 'utf8');
const SOURCE = fs.readFileSync(path.join(ROOT, 'public', 'js', 'mobile.js'), 'utf8');

const tick = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await tick(25);
  }
  return predicate();
}

/** Boots the mobile page as "username", past the age gate, sockets connected. */
async function startMobilePage(username = 'bob') {
  const dom = new JSDOM(PAGE, {
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
      emit: (event, data) => { sock.emitted.push({ event, data }); },
      emitted: [],
      fire: (event, data) => (handlers[event] || []).slice().forEach(fn => fn(data)),
      handlers
    };
    sockets.push(sock);
    return sock;
  };

  win.fetch = async () => ({
    json: async () => ({ ok: true, messages: [], partners: [], users: [], stories: [] })
  });
  win.localStorage.setItem('cw_session_v1', JSON.stringify({ username, display: username }));

  win.eval(SOURCE);

  // mobile.js defers start() to DOMContentLoaded when it is evaluated while
  // the document is still parsing.
  await new Promise(resolve => {
    if (win.document.readyState !== 'loading') return resolve();
    win.document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
  });

  // The age gate stands between the page load and enterApp()/initSocket().
  win.document.getElementById('confirmBtn').click();
  await waitFor(() => sockets.length >= 2, 2000);
  assert.equal(sockets.length, 2, 'the page should hold both of its sockets');

  const badge = () => win.document.getElementById('dmBadge');
  const dmReads = () => sockets.flatMap(s => s.emitted).filter(e => e.event === 'dmRead');

  return {
    win,
    sockets,
    badge,
    badgeText: () => badge().textContent,
    unreadMap: () => JSON.parse(win.localStorage.getItem('cw_dm_unread') || '{}'),
    dmReads,
    /** Deliver a DM to every socket the page holds, like the server's room does. */
    deliverEverywhere(pm) {
      sockets.forEach(s => s.fire('privateMessage', pm));
    },
    deliverUnread(counts) {
      sockets.forEach(s => s.fire('dmUnread', { counts }));
    },
    async close() {
      // Let any in-flight sidebar/history render finish before tearing the
      // document down, or it lands on a closed window.
      await tick(200);
      win.close();
    }
  };
}

test('a DM badges once even though the page holds two sockets', async () => {
  const page = await startMobilePage();
  try {
    assert.equal(page.badgeText(), '');

    page.deliverEverywhere({ id: 'dm1', from: 'alice', to: 'bob', text: 'hello from discord', time: new Date() });

    assert.ok(await waitFor(() => page.badgeText() === '1'), `badge was "${page.badgeText()}"`);
    assert.equal(page.badge().style.display, 'inline-block');
    assert.deepEqual(page.unreadMap(), { alice: 1 });

    page.deliverEverywhere({ id: 'dm2', from: 'alice', to: 'bob', text: 'again', time: new Date() });
    assert.ok(await waitFor(() => page.badgeText() === '2'));
  } finally {
    await page.close();
  }
});

test('the server’s unread catch-up badges DMs that arrived while offline', async () => {
  const page = await startMobilePage();
  try {
    page.deliverUnread({ alice: 2, carol: 1 });

    assert.ok(await waitFor(() => page.badgeText() === '3'), `badge was "${page.badgeText()}"`);
    assert.deepEqual(page.unreadMap(), { alice: 2, carol: 1 });
  } finally {
    await page.close();
  }
});

test('opening a conversation clears its unread, keeps the rest, and tells the server', async () => {
  const page = await startMobilePage();
  try {
    page.deliverUnread({ alice: 2, carol: 1 });
    assert.ok(await waitFor(() => page.badgeText() === '3'));

    page.win.openPrivateWindow('alice');

    assert.ok(await waitFor(() => page.badgeText() === '1'), `badge was "${page.badgeText()}"`);
    assert.deepEqual(page.unreadMap(), { carol: 1 });
    assert.equal(page.win.document.getElementById('dmPopup').style.display, 'flex');
    assert.ok(page.dmReads().some(r => r.data.partner === 'alice'), 'server told alice is read');
  } finally {
    await page.close();
  }
});

test('a DM for the open conversation renders once and does not badge', async () => {
  const page = await startMobilePage();
  try {
    page.win.openPrivateWindow('alice');
    assert.ok(await waitFor(() =>
      page.win.document.getElementById('dmPopup').style.display === 'flex'));

    page.deliverEverywhere({ id: 'dm1', from: 'alice', to: 'bob', text: 'are you there', time: new Date() });

    const body = () => page.win.document.getElementById('dmMessages');
    assert.ok(await waitFor(() => body().textContent.includes('are you there')));
    assert.equal(body().querySelectorAll('.message-row').length, 1, 'message rendered exactly once');
    assert.equal(page.badgeText(), '', 'an open conversation must not badge');
  } finally {
    await page.close();
  }
});

test('our own echoed message is not badged', async () => {
  const page = await startMobilePage();
  try {
    page.deliverEverywhere({ id: 'dm1', from: 'bob', to: 'alice', text: 'my own', time: new Date() });
    await tick(150);

    assert.equal(page.badgeText(), '');
    assert.deepEqual(page.unreadMap(), {});
  } finally {
    await page.close();
  }
});

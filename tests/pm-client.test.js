/**
 * Tests for the desktop DM client (public/js/pm.js), loaded into jsdom and
 * driven by a real socket.io server so the handlers run exactly as they do in
 * the browser.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { Server } = require('socket.io');
const { io: connectClient } = require('socket.io-client');
const { JSDOM } = require('jsdom');

const PM_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'pm.js'), 'utf8');
// pm.js pages history through the shared controller, so the real one is loaded
// alongside it rather than stubbed.
const SCROLL_BACK_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'scroll-back.js'), 'utf8'
);

const tick = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await tick(20);
  }
  return predicate();
}

/**
 * Loads the real pm.js as user "username", with an optional open DM window.
 *
 * `dmHistory` scripts the pages /api/dm/history returns, oldest-last; each
 * request is recorded so a test can assert on the cursor the client sent.
 */
async function startClient(username, { openWindowFor = null, dmHistory = null } = {}) {
  const httpServer = http.createServer();
  const io = new Server(httpServer);

  let serverSocket = null;
  const dmReads = [];
  io.on('connection', socket => {
    serverSocket = socket;
    socket.on('dmRead', payload => dmReads.push(payload));
  });

  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${httpServer.address().port}`;

  const dom = new JSDOM(`<!doctype html><html><body>
      <div id="dmBadge" class="badge" style="display:none"></div>
      <div id="dmNotification"><span id="dmNotificationUser"></span></div>
    </body></html>`, { url: 'http://127.0.0.1/', pretendToBeVisual: true, runScripts: 'dangerously' });

  const win = dom.window;
  win.getSession = () => ({ username, display: username });
  win.escapeHtml = value => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // The DM unread counter pm.js expects from utils.js.
  const KEY = 'cw_dm_unread';
  win.getUnreadMap = () => JSON.parse(win.localStorage.getItem(KEY) || '{}');
  win.saveUnreadMap = map => win.localStorage.setItem(KEY, JSON.stringify(map));
  win.incrementUnread = from => {
    const map = win.getUnreadMap();
    map[from] = (Number(map[from]) || 0) + 1;
    win.saveUnreadMap(map);
  };
  win.clearUnread = user => {
    const map = win.getUnreadMap();
    delete map[user];
    win.saveUnreadMap(map);
  };

  // pm.js fetches DM history when a window opens. It goes through authFetch,
  // which utils.js provides on a real page; the harness stubs it exactly as it
  // stubs the other utils.js globals pm.js expects.
  const dmRequests = [];
  const pages = dmHistory ? [...dmHistory] : [];
  win.fetch = async (url, options) => {
    if (String(url).includes('/api/dm/history')) {
      const body = JSON.parse((options && options.body) || '{}');
      dmRequests.push({ url: String(url), body });
      const page = pages.length ? pages.shift() : { ok: true, messages: [] };
      return { ok: true, json: async () => page };
    }
    return { ok: true, json: async () => ({ ok: true, messages: [] }) };
  };
  win.authFetch = (url, options) => win.fetch(url, options);

  const socket = connectClient(url, { transports: ['websocket'] });
  await new Promise(resolve => socket.on('connect', resolve));
  await tick();

  win.socket = socket;
  win.eval(SCROLL_BACK_SOURCE);
  win.eval(PM_SOURCE);

  if (openWindowFor) {
    const pmWindow = win.document.createElement('div');
    pmWindow.id = 'pmWindow_' + openWindowFor;
    // The scroll-back bar is a sibling of the body, not a child: renderPMHistory
    // clears the body, which would take the controls with it.
    pmWindow.innerHTML = `
      <div class="history-bar" id="pmHistoryBar_${openWindowFor}" hidden>
        <button type="button" id="pmOlder_${openWindowFor}">Load earlier messages</button>
        <span class="history-status" id="pmHistoryStatus_${openWindowFor}"></span>
      </div>
      <div class="pm-body" id="pmBody_${openWindowFor}"></div>`;
    win.document.body.appendChild(pmWindow);
  }

  const badge = () => win.document.getElementById('dmBadge');

  return {
    win,
    dmReads,
    dmRequests,
    historyBar: partner => win.document.getElementById('pmHistoryBar_' + partner),
    historyStatus: partner => win.document.getElementById('pmHistoryStatus_' + partner),
    olderButton: partner => win.document.getElementById('pmOlder_' + partner),
    badge,
    badgeText: () => badge().textContent,
    unreadMap: () => JSON.parse(win.localStorage.getItem(KEY) || '{}'),
    /** Deliver a DM the way the server does. */
    deliver: pm => serverSocket.emit('privateMessage', pm),
    /** Deliver the server-computed unread counts sent on connect. */
    deliverUnread: counts => serverSocket.emit('dmUnread', { counts }),
    async close() {
      socket.close();
      io.close();
      await new Promise(resolve => httpServer.close(resolve));
      win.close();
    }
  };
}

test('a DM that arrives with no window open increments the badge', async () => {
  const client = await startClient('bob');
  try {
    client.deliver({ id: 'dm1', from: 'alice', to: 'bob', text: 'hello from discord', time: new Date() });

    assert.ok(await waitFor(() => client.badgeText() === '1'), 'badge should show 1');
    assert.equal(client.badge().style.display, 'inline-block');
    assert.deepEqual(client.unreadMap(), { alice: 1 });

    client.deliver({ id: 'dm2', from: 'alice', to: 'bob', text: 'and again', time: new Date() });
    assert.ok(await waitFor(() => client.badgeText() === '2'));
  } finally {
    await client.close();
  }
});

test('a DM that arrives with the conversation open renders live and is marked read', async () => {
  const client = await startClient('bob', { openWindowFor: 'alice' });
  try {
    client.deliver({ id: 'dm1', from: 'alice', to: 'bob', text: 'are you there', time: new Date() });

    const body = () => client.win.document.getElementById('pmBody_alice');
    assert.ok(await waitFor(() => body().children.length === 1), 'message should render live');
    assert.match(body().textContent, /are you there/);
    assert.match(body().textContent, /alice/);

    // On screen means read, or the server would badge it again on reconnect.
    assert.ok(await waitFor(() => client.dmReads.length === 1));
    assert.deepEqual(client.dmReads[0], { username: 'bob', partner: 'alice' });

    assert.equal(client.badgeText(), '', 'an open conversation must not badge');
  } finally {
    await client.close();
  }
});

test('the server’s unread catch-up badges DMs that arrived while offline', async () => {
  const client = await startClient('bob');
  try {
    assert.equal(client.badgeText(), '');

    // A message bridged in from Discord while bob had no socket at all.
    client.deliverUnread({ alice: 3 });

    assert.ok(await waitFor(() => client.badgeText() === '3'));
    assert.deepEqual(client.unreadMap(), { alice: 3 });
  } finally {
    await client.close();
  }
});

test('the unread catch-up never lowers a count the client already has', async () => {
  const client = await startClient('bob');
  try {
    client.deliver({ id: 'dm1', from: 'alice', to: 'bob', text: 'live one', time: new Date() });
    await waitFor(() => client.badgeText() === '1');

    // Server knows about the same message; the total must not double, and a
    // staler server count must not erase the live one.
    client.deliverUnread({ alice: 1 });
    await tick();
    assert.equal(client.badgeText(), '1');

    client.deliverUnread({ alice: 4, carol: 2 });
    assert.ok(await waitFor(() => client.badgeText() === '6'));
    assert.deepEqual(client.unreadMap(), { alice: 4, carol: 2 });
  } finally {
    await client.close();
  }
});

test('opening a DM window clears the badge and tells the server', async () => {
  const client = await startClient('bob');
  try {
    client.deliverUnread({ alice: 2 });
    assert.ok(await waitFor(() => client.badgeText() === '2'));

    client.win.openPrivateWindow('alice');
    await tick();

    assert.equal(client.badgeText(), '');
    assert.deepEqual(client.unreadMap(), {});
    assert.ok(client.dmReads.some(r => r.partner === 'alice'), 'server told the conversation is read');
    assert.ok(client.win.document.getElementById('pmBody_alice'), 'DM window opened');
  } finally {
    await client.close();
  }
});

test('our own echoed message is neither badged nor treated as incoming', async () => {
  const client = await startClient('bob', { openWindowFor: 'alice' });
  try {
    client.deliver({ id: 'dm1', from: 'bob', to: 'alice', text: 'my own message', time: new Date() });

    const body = () => client.win.document.getElementById('pmBody_alice');
    assert.ok(await waitFor(() => body().children.length === 1));
    assert.equal(client.badgeText(), '');
  } finally {
    await client.close();
  }
});

/* ---------- SCROLL-BACK ----------
   A DM window opens on the newest page. These drive the real pm.js against the
   real scroll-back controller to prove the older page lands *above* the newer
   one, that the request carries the cursor, and that the offer disappears at
   the beginning of the conversation. */

const dm = (text, from = 'alice') => ({
  id: text, from, to: 'bob', text, time: new Date('2026-09-10T00:00:00.000Z')
});

const renderedTexts = body => [...body.querySelectorAll('.message')]
  .map(row => row.lastElementChild.textContent.trim());

test('a DM window opens on the newest page and offers the one behind it', async () => {
  const client = await startClient('bob', {
    dmHistory: [{
      ok: true,
      messages: [dm('new-1'), dm('new-2')],
      oldest: '2026-09-10T00:00:00.000Z',
      hasMore: true
    }]
  });
  try {
    client.win.openPrivateWindow('alice');
    const body = () => client.win.document.getElementById('pmBody_alice');
    assert.ok(await waitFor(() => body().querySelectorAll('.message').length === 2));

    // No cursor on the first request: a window opens on the newest page.
    assert.equal(client.dmRequests.length, 1);
    assert.equal(client.dmRequests[0].body.before, undefined);

    const bar = client.historyBar('alice');
    assert.ok(bar, 'the window carries a scroll-back control');
    assert.equal(bar.hidden, false, 'offered, because the server says there is more');
    assert.match(client.olderButton('alice').textContent, /earlier/i);
  } finally {
    await client.close();
  }
});

test('scrolling to the top loads the older page above the newer one', async () => {
  const client = await startClient('bob', {
    dmHistory: [
      { ok: true, messages: [dm('new-1'), dm('new-2')], oldest: 'cursor-new', hasMore: true },
      { ok: true, messages: [dm('old-1'), dm('old-2')], oldest: 'cursor-old', hasMore: false }
    ]
  });
  try {
    client.win.openPrivateWindow('alice');
    const body = () => client.win.document.getElementById('pmBody_alice');
    assert.ok(await waitFor(() => body().querySelectorAll('.message').length === 2));

    body().scrollTop = 0;
    body().dispatchEvent(new client.win.Event('scroll'));

    assert.ok(await waitFor(() => body().querySelectorAll('.message').length === 4),
      'the older page was rendered');

    // Chronological: what happened earlier is above what happened later.
    assert.deepEqual(renderedTexts(body()), ['old-1', 'old-2', 'new-1', 'new-2']);

    // The cursor is the oldest message already on screen, so the page continues
    // the conversation instead of repeating it.
    assert.equal(client.dmRequests.length, 2);
    assert.equal(client.dmRequests[1].body.before, 'cursor-new');
    assert.equal(client.dmRequests[1].body.limit, 100);

    // The beginning of the conversation says so and stops offering.
    assert.ok(await waitFor(() => client.historyBar('alice').hidden === true));
    assert.match(client.historyStatus('alice').textContent, /beginning/i);

    body().dispatchEvent(new client.win.Event('scroll'));
    await tick(60);
    assert.equal(client.dmRequests.length, 2, 'no further request past the beginning');
  } finally {
    await client.close();
  }
});

test('a short conversation offers no scroll-back at all', async () => {
  const client = await startClient('bob', {
    dmHistory: [{ ok: true, messages: [dm('only-one')], oldest: 'only-one', hasMore: false }]
  });
  try {
    client.win.openPrivateWindow('alice');
    const body = () => client.win.document.getElementById('pmBody_alice');
    assert.ok(await waitFor(() => body().querySelectorAll('.message').length === 1));

    assert.equal(client.historyBar('alice').hidden, true);

    body().dispatchEvent(new client.win.Event('scroll'));
    await tick(60);
    assert.equal(client.dmRequests.length, 1);
  } finally {
    await client.close();
  }
});

test('a retired window stops asking for history', async () => {
  const client = await startClient('bob', {
    dmHistory: [
      { ok: true, messages: [dm('new-1')], oldest: 'cursor-new', hasMore: true },
      { ok: true, messages: [dm('old-1')], oldest: 'cursor-old', hasMore: false }
    ]
  });
  try {
    client.win.openPrivateWindow('alice');
    const body = () => client.win.document.getElementById('pmBody_alice');
    assert.ok(await waitFor(() => body().querySelectorAll('.message').length === 1));

    // Closing (or clearing) the conversation retires its controller; a scroll
    // event afterwards must not reach the network.
    client.win.destroyPmScrollBack('alice');
    assert.equal(client.historyBar('alice').hidden, true);

    body().scrollTop = 0;
    body().dispatchEvent(new client.win.Event('scroll'));
    await tick(60);

    assert.equal(client.dmRequests.length, 1);
  } finally {
    await client.close();
  }
});

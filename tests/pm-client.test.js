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

const tick = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await tick(20);
  }
  return predicate();
}

/** Loads the real pm.js as user "username", with an optional open DM window. */
async function startClient(username, { openWindowFor = null } = {}) {
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

  // pm.js fetches DM history when a window opens.
  win.fetch = async () => ({ json: async () => ({ ok: true, messages: [] }) });

  const socket = connectClient(url, { transports: ['websocket'] });
  await new Promise(resolve => socket.on('connect', resolve));
  await tick();

  win.socket = socket;
  win.eval(PM_SOURCE);

  if (openWindowFor) {
    const pmWindow = win.document.createElement('div');
    pmWindow.id = 'pmWindow_' + openWindowFor;
    pmWindow.innerHTML = `<div class="pm-body" id="pmBody_${openWindowFor}"></div>`;
    win.document.body.appendChild(pmWindow);
  }

  const badge = () => win.document.getElementById('dmBadge');

  return {
    win,
    dmReads,
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

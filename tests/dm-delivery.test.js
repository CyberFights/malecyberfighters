/**
 * Tests for the Discord -> website DM bridge and the delivery rules behind it.
 *
 * Runs the shipped modules (dmDelivery.js, setupDiscordListener.js) against a
 * real socket.io server and real socket.io clients, with only the Mongo models
 * and the two external calls (Google Translate, the Discord bot) stubbed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');

const { Server } = require('socket.io');
const { io: connectClient } = require('socket.io-client');

const { createDmDelivery } = require('../dmDelivery');
const setupDiscordListener = require('../setupDiscordListener');
const { makeDb } = require('./helpers/fakeDb');

const tick = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await tick(20);
  }
  return predicate();
}

/** Boots the bridge: real socket.io, real listener, in-memory models. */
async function startBridge() {
  const db = makeDb();
  const httpServer = http.createServer();
  const io = new Server(httpServer);
  const delivery = createDmDelivery({ User: db.User, DM: db.DM, io });

  // Mirrors the `login` handler in index.js: a socket joins its owner's room
  // so DMs reach every session of that user, not just the remembered socketId.
  io.on('connection', socket => {
    socket.on('login', ({ username } = {}) => {
      if (!username) return;
      socket.username = username;
      socket.join(delivery.userRoom(username));
    });
  });

  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${httpServer.address().port}`;

  const discordReplies = [];
  const discordEvents = new EventEmitter();
  setupDiscordListener(
    db.User,
    db.DM,
    async text => text,                                   // translateText
    delivery.emitToUser,
    async (discordId, message) => { discordReplies.push({ discordId, message }); },
    discordEvents
  );

  const clients = [];

  return {
    db,
    io,
    delivery,
    discordEvents,
    discordReplies,
    fireDiscordDM(discordId, text) {
      discordEvents.emit('dm', { discordId, text });
    },
    async connect(username) {
      const socket = connectClient(url, { transports: ['websocket'] });
      const received = [];
      socket.on('privateMessage', pm => received.push(pm));
      await new Promise(resolve => socket.on('connect', resolve));
      socket.emit('login', { username });
      await tick();                                        // let the room join land
      clients.push(socket);
      return { socket, received };
    },
    async close() {
      clients.forEach(socket => socket.close());
      clients.length = 0;
      io.close();
      await new Promise(resolve => httpServer.close(resolve));
    }
  };
}

test('a Discord DM reaches a recipient whose stored socketId is stale', async () => {
  const bridge = await startBridge();
  try {
    bridge.db.addUser({ username: 'alice', discordId: '111' });
    // The bug this guards: socketId points at a socket that is long gone, so
    // `io.to(socketId)` delivered nothing at all.
    bridge.db.addUser({ username: 'bob', socketId: 'socket-of-a-closed-tab' });

    const bob = await bridge.connect('bob');
    bridge.fireDiscordDM('111', '@bob hello from discord');

    assert.ok(await waitFor(() => bob.received.length === 1), 'recipient got no live DM');
    assert.equal(bob.received[0].from, 'alice');
    assert.equal(bob.received[0].to, 'bob');
    assert.equal(bob.received[0].text, 'hello from discord');
    assert.ok(bob.received[0].id, 'payload carries the DM id');
    assert.equal(bridge.db.dms.length, 1);
    assert.match(bridge.discordReplies[0].message, /Message sent to \*\*bob\*\*/);
  } finally {
    await bridge.close();
  }
});

test('a Discord DM reaches every session the recipient has open', async () => {
  const bridge = await startBridge();
  try {
    bridge.db.addUser({ username: 'alice', discordId: '111' });
    bridge.db.addUser({ username: 'bob' });

    const browser = await bridge.connect('bob');
    const desktopApp = await bridge.connect('bob');

    bridge.fireDiscordDM('111', '@bob are you there');

    assert.ok(await waitFor(() => browser.received.length === 1 && desktopApp.received.length === 1),
      'both sessions should get the DM');
  } finally {
    await bridge.close();
  }
});

test('a Discord DM is echoed back to the sender’s own website session', async () => {
  const bridge = await startBridge();
  try {
    bridge.db.addUser({ username: 'alice', discordId: '111' });
    bridge.db.addUser({ username: 'bob' });

    const aliceOnWeb = await bridge.connect('alice');
    await bridge.connect('bob');

    bridge.fireDiscordDM('111', '@bob sent from my phone');

    assert.ok(await waitFor(() => aliceOnWeb.received.length === 1));
    assert.equal(aliceOnWeb.received[0].text, 'sent from my phone');
  } finally {
    await bridge.close();
  }
});

test('an offline recipient gets no live DM but the message is counted as unread', async () => {
  const bridge = await startBridge();
  try {
    bridge.db.addUser({ username: 'alice', discordId: '111' });
    bridge.db.addUser({ username: 'bob' });

    // Bob signs in once (which stamps when unread counting starts), then goes
    // away before alice writes to him for the first time.
    const bob = await bridge.connect('bob');
    assert.deepEqual(await bridge.delivery.getUnreadDMCounts(bridge.db.users.get('bob')), {});
    bob.socket.close();
    await tick();

    assert.equal(bridge.delivery.liveSocketCount('bob'), 0);
    bridge.fireDiscordDM('111', '@bob missed this');
    assert.ok(await waitFor(() => bridge.db.dms.length === 1));

    const stored = bridge.db.dms[0];
    assert.equal(stored.text, 'missed this');
    assert.equal(stored.from, 'alice');

    // Nothing was delivered live ...
    assert.equal(bob.received.length, 0);

    // ... but the server can now tell bob's next session about it, even though
    // this conversation has never been opened.
    assert.deepEqual(
      await bridge.delivery.getUnreadDMCounts(bridge.db.users.get('bob')),
      { alice: 1 }
    );
  } finally {
    await bridge.close();
  }
});

test('marking a conversation read clears its unread count', async () => {
  const bridge = await startBridge();
  try {
    bridge.db.addUser({ username: 'alice', discordId: '111' });
    bridge.db.addUser({ username: 'bob' });

    const bob = await bridge.connect('bob');
    await bridge.delivery.getUnreadDMCounts(bridge.db.users.get('bob'));   // start counting
    bridge.fireDiscordDM('111', '@bob one');
    assert.ok(await waitFor(() => bridge.db.dms.length === 1));
    assert.ok(await waitFor(() => bob.received.length === 1), 'online recipient gets it live');

    const unread = () => bridge.delivery.getUnreadDMCounts(bridge.db.users.get('bob'));

    assert.deepEqual(await unread(), { alice: 1 });

    await bridge.delivery.markDMRead('bob', 'alice');
    assert.deepEqual(await unread(), {});
  } finally {
    await bridge.close();
  }
});

test('existing history is not badged the first time it is counted', async () => {
  const bridge = await startBridge();
  try {
    bridge.db.addUser({ username: 'bob' });
    const old = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    bridge.db.addDM('alice', 'bob', 'a week ago', old);
    bridge.db.addDM('carol', 'bob', 'also old', old);

    // First connect backfills the "count from here" stamp instead of badging
    // a week of history ...
    assert.deepEqual(await bridge.delivery.getUnreadDMCounts(bridge.db.users.get('bob')), {});
    assert.ok(bridge.db.users.get('bob').dmUnreadSince, 'counting stamp backfilled');

    // ... but a message that arrives from now on is counted.
    bridge.db.addDM('alice', 'bob', 'new one');
    assert.deepEqual(
      await bridge.delivery.getUnreadDMCounts(bridge.db.users.get('bob')),
      { alice: 1 }
    );
  } finally {
    await bridge.close();
  }
});

test('a DM landing in the same millisecond as the counting stamp still counts', async () => {
  const bridge = await startBridge();
  try {
    bridge.db.addUser({ username: 'bob' });
    const stamp = new Date();
    bridge.db.users.get('bob').dmUnreadSince = stamp.toISOString();
    bridge.db.addDM('alice', 'bob', 'arrived at the stamp', stamp);

    assert.deepEqual(
      await bridge.delivery.getUnreadDMCounts(bridge.db.users.get('bob')),
      { alice: 1 }
    );
  } finally {
    await bridge.close();
  }
});

test('system DMs are never counted as unread', async () => {
  const bridge = await startBridge();
  try {
    bridge.db.addUser({ username: 'bob' });
    const seen = new Date(Date.now() - 60 * 1000).toISOString();
    bridge.db.users.get('bob').dmSeen = { alice: seen, SYSTEM: seen };
    bridge.db.users.get('bob').dmUnreadSince = seen;

    bridge.db.addDM('SYSTEM', 'bob', 'your story was approved');
    bridge.db.addDM('alice', 'bob', 'a real message');

    assert.deepEqual(
      await bridge.delivery.getUnreadDMCounts(bridge.db.users.get('bob')),
      { alice: 1 }
    );
  } finally {
    await bridge.close();
  }
});

test('usernames with dots still get a usable read marker', async () => {
  const bridge = await startBridge();
  try {
    bridge.db.addUser({ username: 'bob' });
    await bridge.delivery.markDMRead('bob', 'first.last');
    assert.ok(bridge.db.users.get('bob').dmSeen.first_last);
  } finally {
    await bridge.close();
  }
});

test('the bot answers the cases it cannot deliver', async () => {
  const bridge = await startBridge();
  try {
    bridge.db.addUser({ username: 'alice', discordId: '111' });
    bridge.db.addUser({ username: 'bob', blockedUsers: ['alice'] });

    // Unlinked Discord account
    bridge.fireDiscordDM('999', '@bob hi');
    assert.ok(await waitFor(() => bridge.discordReplies.length === 1));
    assert.match(bridge.discordReplies[0].message, /link your Discord account/);

    // No recipient named
    bridge.fireDiscordDM('111', 'just chatting');
    await waitFor(() => bridge.discordReplies.length === 2);
    assert.match(bridge.discordReplies[1].message, /@username message/);

    // Unknown website user
    bridge.fireDiscordDM('111', '@nobody hi');
    await waitFor(() => bridge.discordReplies.length === 3);
    assert.match(bridge.discordReplies[2].message, /not found/);

    // Blocked by the recipient
    bridge.fireDiscordDM('111', '@bob hi');
    await waitFor(() => bridge.discordReplies.length === 4);
    assert.match(bridge.discordReplies[3].message, /has blocked you/);

    // Self-DM: the website refuses these, so the bot must not pretend it worked
    bridge.fireDiscordDM('111', '@alice hi');
    await waitFor(() => bridge.discordReplies.length === 5);
    assert.match(bridge.discordReplies[4].message, /can't DM yourself/);

    assert.equal(bridge.db.dms.length, 0, 'none of these should be stored');
  } finally {
    await bridge.close();
  }
});

test('emitToUser reports how many sessions it reached', async () => {
  const bridge = await startBridge();
  try {
    bridge.db.addUser({ username: 'bob' });
    assert.equal(bridge.delivery.emitToUser('bob', 'privateMessage', {}), 0);

    const first = await bridge.connect('bob');
    assert.equal(bridge.delivery.emitToUser('bob', 'privateMessage', { text: 'hi' }), 1);

    await bridge.connect('bob');
    assert.equal(bridge.delivery.emitToUser('bob', 'privateMessage', { text: 'hi' }), 2);
    assert.ok(await waitFor(() => first.received.length === 2));
  } finally {
    await bridge.close();
  }
});

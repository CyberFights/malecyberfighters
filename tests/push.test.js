/**
 * Tests for web push delivery (pushNotifications.js).
 *
 * The push service and the subscription collection are both injected, so these
 * cover the rules that matter: what a payload is allowed to contain, whose
 * devices get notified, and when a dead endpoint is dropped versus retried.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPushNotifier, GONE_STATUSES } = require('../pushNotifications');

const KEYS = { publicKey: 'vapid-public-key', privateKey: 'vapid-private-key' };

/** In-memory stand-in for the PushSubscription model. */
function fakeSubscriptionModel(rows = []) {
  const calls = { updateOne: [], deleteOne: [], deleteMany: [], find: [] };

  const matches = (row, filter) => Object.keys(filter).every(key => row[key] === filter[key]);

  return {
    calls,
    rows,
    async updateOne(filter, update, options) {
      calls.updateOne.push({ filter, update, options });
      const existing = rows.find(row => matches(row, filter));
      if (existing) {
        Object.assign(existing, update.$set);
        return { acknowledged: true, upsertedCount: 0, modifiedCount: 1 };
      }
      rows.push({ ...(update.$setOnInsert || {}), ...update.$set });
      return { acknowledged: true, upsertedCount: 1 };
    },
    async deleteOne(filter) {
      calls.deleteOne.push(filter);
      const index = rows.findIndex(row => matches(row, filter));
      if (index === -1) return { deletedCount: 0 };
      rows.splice(index, 1);
      return { deletedCount: 1 };
    },
    async deleteMany(filter) {
      calls.deleteMany.push(filter);
      const doomed = rows.filter(row => matches(row, filter));
      doomed.forEach(row => rows.splice(rows.indexOf(row), 1));
      return { deletedCount: doomed.length };
    },
    find(filter) {
      calls.find.push(filter);
      return { lean: async () => rows.filter(row => matches(row, filter)) };
    }
  };
}

/** In-memory stand-in for the web-push library. */
function fakeWebPush(failWith = null) {
  const sent = [];
  return {
    sent,
    vapid: null,
    setVapidDetails(subject, publicKey, privateKey) {
      this.vapid = { subject, publicKey, privateKey };
    },
    async sendNotification(subscription, payload) {
      sent.push({ subscription, payload });
      if (failWith) {
        const statusCode = failWith(subscription, sent.length);
        if (statusCode) {
          const err = new Error(`push rejected (${statusCode})`);
          err.statusCode = statusCode;
          throw err;
        }
      }
      return { statusCode: 201 };
    }
  };
}

const sub = (endpoint, username = 'bob') => ({
  username,
  endpoint,
  p256dh: `pub-${endpoint}`,
  auth: `auth-${endpoint}`,
  createdAt: new Date(),
  lastSeenAt: new Date()
});

/** The shape a browser's PushSubscription.toJSON() produces. */
const browserSub = endpoint => ({
  endpoint,
  keys: { p256dh: `pub-${endpoint}`, auth: `auth-${endpoint}` }
});

test('without VAPID keys push reports itself unavailable and sends nothing', async () => {
  const model = fakeSubscriptionModel([sub('https://push.example/bob')]);
  const webpush = fakeWebPush();

  const push = createPushNotifier({ PushSubscription: model, webpush });

  assert.equal(push.configured, false);
  assert.deepEqual(push.clientConfig(), { enabled: false, publicKey: null });

  // Nothing is armed, so a DM must not even look up subscriptions.
  assert.equal(await push.notify({ to: 'bob', from: 'alice' }), 0);
  assert.equal(model.calls.find.length, 0);
  assert.equal(webpush.sent.length, 0);
});

test('the public key is served to the browser, the private key never is', () => {
  const push = createPushNotifier({
    PushSubscription: fakeSubscriptionModel(),
    webpush: fakeWebPush(),
    ...KEYS
  });

  assert.equal(push.configured, true);
  assert.deepEqual(push.clientConfig(), { enabled: true, publicKey: KEYS.publicKey });
  assert.ok(!JSON.stringify(push.clientConfig()).includes(KEYS.privateKey));
});

test('VAPID details are handed to the library, with a contact fallback', () => {
  const withSubject = fakeWebPush();
  createPushNotifier({
    PushSubscription: fakeSubscriptionModel(),
    webpush: withSubject,
    ...KEYS,
    subject: 'mailto:admin@male-cyber-fighters.com'
  });
  assert.deepEqual(withSubject.vapid, {
    subject: 'mailto:admin@male-cyber-fighters.com',
    publicKey: KEYS.publicKey,
    privateKey: KEYS.privateKey
  });

  const withoutSubject = fakeWebPush();
  createPushNotifier({ PushSubscription: fakeSubscriptionModel(), webpush: withoutSubject, ...KEYS });
  assert.match(withoutSubject.vapid.subject, /^https?:\/\//);
});

test('a browser registers once per endpoint, however often it re-subscribes', async () => {
  const model = fakeSubscriptionModel();
  const push = createPushNotifier({ PushSubscription: model, webpush: fakeWebPush(), ...KEYS });

  assert.deepEqual(await push.subscribe('bob', browserSub('https://push.example/1')), { ok: true });
  assert.deepEqual(await push.subscribe('bob', browserSub('https://push.example/1')), { ok: true });

  // Re-subscribing refreshes the record instead of adding a second one, which
  // would notify the same browser twice per message.
  assert.equal(model.rows.length, 1);
  assert.equal(model.calls.updateOne[0].options.upsert, true);
  assert.equal(model.calls.updateOne[0].filter.endpoint, 'https://push.example/1');
  assert.equal(model.rows[0].p256dh, 'pub-https://push.example/1');

  // A second device is a second row.
  await push.subscribe('bob', browserSub('https://push.example/phone'));
  assert.equal(model.rows.length, 2);
});

test('an incomplete subscription is refused rather than stored', async () => {
  const model = fakeSubscriptionModel();
  const push = createPushNotifier({ PushSubscription: model, webpush: fakeWebPush(), ...KEYS });

  assert.deepEqual(await push.subscribe('bob', { endpoint: 'https://push.example/1', keys: {} }),
    { ok: false, error: 'invalid_subscription' });
  assert.deepEqual(await push.subscribe('bob', null), { ok: false, error: 'invalid_subscription' });
  assert.deepEqual(await push.subscribe('', browserSub('https://push.example/1')),
    { ok: false, error: 'auth_required' });
  assert.equal(model.rows.length, 0);
});

test('a member can only unregister their own device', async () => {
  const model = fakeSubscriptionModel([
    sub('https://push.example/bob', 'bob'),
    sub('https://push.example/alice', 'alice')
  ]);
  const push = createPushNotifier({ PushSubscription: model, webpush: fakeWebPush(), ...KEYS });

  // Deleting on {username, endpoint} means a guessed endpoint cannot silence
  // somebody else's phone.
  assert.deepEqual(await push.unsubscribe('bob', 'https://push.example/alice'), { ok: true, removed: 0 });
  assert.equal(model.rows.length, 2);

  assert.deepEqual(await push.unsubscribe('bob', 'https://push.example/bob'), { ok: true, removed: 1 });
  assert.deepEqual(model.rows.map(row => row.username), ['alice']);

  assert.deepEqual(await push.unsubscribe('bob', ''), { ok: false, error: 'missing_endpoint' });
});

test('deleting an account forgets every device it ever registered', async () => {
  const model = fakeSubscriptionModel([
    sub('https://push.example/1', 'bob'),
    sub('https://push.example/2', 'bob'),
    sub('https://push.example/3', 'alice')
  ]);
  const push = createPushNotifier({ PushSubscription: model, webpush: fakeWebPush(), ...KEYS });

  assert.equal(await push.unsubscribeAll('bob'), 2);
  assert.deepEqual(model.rows.map(row => row.username), ['alice']);
  assert.equal(await push.unsubscribeAll(''), 0);
});

test('a DM notifies every device the recipient has, and nobody else', async () => {
  const model = fakeSubscriptionModel([
    sub('https://push.example/1', 'bob'),
    sub('https://push.example/2', 'bob'),
    sub('https://push.example/3', 'alice')
  ]);
  const webpush = fakeWebPush();
  const logged = [];
  const push = createPushNotifier({
    PushSubscription: model,
    webpush,
    ...KEYS,
    log: line => logged.push(line)
  });

  const sent = await push.notify({ to: 'bob', from: 'Alice', url: '/' });

  assert.equal(sent, 2);
  assert.deepEqual(webpush.sent.map(s => s.subscription.endpoint), [
    'https://push.example/1',
    'https://push.example/2'
  ]);
  assert.equal(model.calls.find[0].username, 'bob');
  assert.match(logged[0], /2 notification\(s\) to bob/);
});

test('the payload says who wrote and nothing about what they wrote', () => {
  const push = createPushNotifier({
    PushSubscription: fakeSubscriptionModel(),
    webpush: fakeWebPush(),
    ...KEYS
  });

  const payload = push.buildPayload({ from: 'Alice', url: '/' });

  // A notification body can land on a lock screen and travels through a third
  // party's push service, so on an 18+ site the message text must not be in it.
  assert.equal(payload.title, 'Male Cyber Fighters');
  assert.equal(payload.body, 'New direct message from Alice.');
  assert.deepEqual(Object.keys(payload).sort(), ['body', 'data', 'renotify', 'tag', 'title']);
  assert.deepEqual(Object.keys(payload.data).sort(), ['kind', 'url']);
  assert.equal(payload.data.kind, 'dm');
  assert.equal(payload.renotify, false);

  const wire = JSON.stringify(payload);
  assert.ok(!wire.includes('text'), 'no message field on the wire');
});

test('a system notice names no sender', () => {
  const push = createPushNotifier({
    PushSubscription: fakeSubscriptionModel(),
    webpush: fakeWebPush(),
    ...KEYS
  });

  const system = push.buildPayload({ kind: 'system' });
  assert.equal(system.body, 'You have a new notification.');
  assert.equal(system.data.kind, 'system');
  assert.equal(system.tag, 'mcf-system');

  // A Discord bridge message arrives with no usable sender at all.
  const nameless = push.buildPayload({ from: '' });
  assert.equal(nameless.body, 'You have a new notification.');
  assert.equal(nameless.data.kind, 'system');

  const bridged = push.buildPayload({ from: 'SYSTEM' });
  assert.equal(bridged.data.kind, 'system');
});

test('one sender replaces their own unread notification instead of stacking', () => {
  const push = createPushNotifier({
    PushSubscription: fakeSubscriptionModel(),
    webpush: fakeWebPush(),
    ...KEYS
  });

  assert.equal(push.buildPayload({ from: 'Alice' }).tag, 'mcf-dm-Alice');
  assert.equal(push.buildPayload({ from: 'Alice' }).tag, 'mcf-dm-Alice');
  assert.notEqual(push.buildPayload({ from: 'Alice' }).tag, push.buildPayload({ from: 'Bruno' }).tag);
});

test('a dead endpoint is deleted on the spot; a transient failure is retried later', async () => {
  const model = fakeSubscriptionModel([
    sub('https://push.example/gone', 'bob'),
    sub('https://push.example/busy', 'bob'),
    sub('https://push.example/fine', 'bob')
  ]);
  const webpush = fakeWebPush(subscription => {
    if (subscription.endpoint === 'https://push.example/gone') return 410;
    if (subscription.endpoint === 'https://push.example/busy') return 503;
    return null;
  });
  const push = createPushNotifier({
    PushSubscription: model,
    webpush,
    ...KEYS,
    log: () => {}
  });

  const sent = await push.notify({ to: 'bob', from: 'Alice' });

  assert.equal(sent, 1, 'only the healthy device counted');
  // 410 means this endpoint will never work again, so the next DM should not
  // pay for it; 503 means "ask me later" and the subscription stays.
  assert.deepEqual(model.rows.map(row => row.endpoint).sort(), [
    'https://push.example/busy',
    'https://push.example/fine'
  ]);
  assert.deepEqual(model.calls.deleteOne, [{ endpoint: 'https://push.example/gone' }]);
});

test('404 counts as gone too', () => {
  assert.ok(GONE_STATUSES.has(404));
  assert.ok(GONE_STATUSES.has(410));
  assert.ok(!GONE_STATUSES.has(429));
  assert.ok(!GONE_STATUSES.has(500));
});

test('a member with no registered device is simply not pushed', async () => {
  const model = fakeSubscriptionModel([]);
  const webpush = fakeWebPush();
  const push = createPushNotifier({ PushSubscription: model, webpush, ...KEYS });

  assert.equal(await push.notify({ to: 'bob', from: 'Alice' }), 0);
  assert.equal(webpush.sent.length, 0);
  assert.equal(await push.notify({ from: 'Alice' }), 0, 'no recipient, nothing sent');
});

test('a broken push service never takes the message delivery down with it', async () => {
  const model = fakeSubscriptionModel([sub('https://push.example/1', 'bob')]);
  const webpush = {
    setVapidDetails() {},
    async sendNotification() { throw new Error('network unreachable'); }
  };
  const push = createPushNotifier({ PushSubscription: model, webpush, ...KEYS, log: () => {} });

  // The DM was already stored and emitted; a push failure is reported as zero
  // delivered rather than thrown at the caller.
  assert.equal(await push.notify({ to: 'bob', from: 'Alice' }), 0);
  assert.equal(model.rows.length, 1, 'the subscription survives a network blip');
});

test('a lookup failure is contained', async () => {
  const push = createPushNotifier({
    PushSubscription: {
      find() { throw new Error('mongo went away'); },
      async deleteOne() { return { deletedCount: 0 }; }
    },
    webpush: fakeWebPush(),
    ...KEYS
  });

  assert.equal(await push.notify({ to: 'bob', from: 'Alice' }), 0);
});

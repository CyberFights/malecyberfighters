/**
 * Tests for sessions.js — the module that decides who is asking.
 *
 * Before it existed, a request named its own author: `{ username }` in a body,
 * `msg.from` on a socket event. Nothing checked, so any visitor could read two
 * other members' DMs or post as one of them. These tests pin the replacement
 * down from both ends: the token rules (issue, verify, expire, revoke) and the
 * HTTP surface a handler sees (`req.username` derived, never claimed, and a
 * cookie-authenticated cross-site write refused).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const {
  createSessionManager,
  tokenFromRequest,
  sameSiteRequest,
  issueToken,
  sha256,
  safeEqual,
  cookieOptions,
  COOKIE_NAME,
  TOKEN_PREFIX,
  IDLE_TTL_MS,
  TOUCH_AFTER_MS
} = require('../sessions');

/* ---------------------------------------------------------------
   In-memory stand-ins with the exact query surface sessions.js uses
--------------------------------------------------------------- */

/**
 * A query result that is thenable and also exposes `.lean()` / `.select()`.
 * `.select('-field')` actually strips the field, so a test can assert that
 * sessions.js asks for the projection rather than trusting it to.
 */
function chain(value) {
  const thenable = {
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
    lean: () => chain(value),
    select: projection => {
      if (!value || typeof value !== 'object') return chain(value);
      const excluded = String(projection || '')
        .split(/\s+/)
        .filter(part => part.startsWith('-'))
        .map(part => part.slice(1));
      if (!excluded.length) return chain(value);
      const copy = { ...value };
      excluded.forEach(field => delete copy[field]);
      return chain(copy);
    }
  };
  return thenable;
}

function makeStore() {
  const sessions = [];
  const users = [];

  const matches = (doc, query) => Object.entries(query).every(([key, expected]) => {
    if (expected && typeof expected === 'object' && '$ne' in expected) return doc[key] !== expected.$ne;
    return doc[key] === expected;
  });

  let nextId = 0;

  const Session = {
    create: async fields => {
      const doc = { _id: `s${++nextId}`, ...fields };
      sessions.push(doc);
      return doc;
    },
    findOne: query => chain(sessions.find(doc => matches(doc, query)) || null),
    updateOne: async (query, update) => {
      const doc = sessions.find(d => matches(d, query));
      if (doc && update.$set) Object.assign(doc, update.$set);
      return { modifiedCount: doc ? 1 : 0 };
    },
    deleteOne: async query => {
      const index = sessions.findIndex(doc => matches(doc, query));
      if (index === -1) return { deletedCount: 0 };
      sessions.splice(index, 1);
      return { deletedCount: 1 };
    },
    deleteMany: async query => {
      const keep = sessions.filter(doc => !matches(doc, query));
      const deletedCount = sessions.length - keep.length;
      sessions.length = 0;
      sessions.push(...keep);
      return { deletedCount };
    },
    _all: () => sessions
  };

  const User = {
    findOne: query => chain(users.find(doc => matches(doc, query)) || null),
    _add: fields => { users.push(fields); return fields; }
  };

  return { Session, User, sessions, users };
}

function makeManager(opts = {}) {
  const store = makeStore();
  store.User._add({ username: 'alice', display: 'Alice', passwordHash: 'x' });
  store.User._add({ username: 'bob', display: 'Bob', passwordHash: 'x' });
  const manager = createSessionManager({
    Session: store.Session,
    User: store.User,
    appBaseUrl: 'https://male-cyber-fighters.com',
    ...opts
  });
  return { ...store, manager };
}

/** A minimal req/res pair for the middleware, no HTTP server needed. */
function fakeReq({ method = 'GET', headers = {}, origin = null, host = 'male-cyber-fighters.com' } = {}) {
  const all = { ...headers, host };
  if (origin) all.origin = origin;
  return {
    method,
    headers: all,
    get: name => all[String(name).toLowerCase()]
  };
}

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = code => { res.statusCode = code; return res; };
  res.json = payload => { res.body = payload; return res; };
  return res;
}

const runMiddleware = (fn, req) => new Promise(resolve => {
  const res = fakeRes();
  fn(req, res, () => resolve({ req, res, called: true }));
  setTimeout(() => resolve({ req, res, called: false }), 50);
});

/* ---------------------------------------------------------------
   Tokens
--------------------------------------------------------------- */

test('a token is random, prefixed, and never stored in the clear', async () => {
  const { manager, sessions } = makeManager();

  const first = issueToken();
  const second = issueToken();
  assert.ok(first.startsWith(TOKEN_PREFIX));
  assert.notEqual(first, second);
  assert.ok(first.length > 40, 'a token should carry enough entropy to guess at');

  const token = await manager.createSession('alice', { userAgent: 'test', ip: '1.2.3.4' });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].tokenHash, sha256(token));
  assert.equal(sessions[0].username, 'alice');
  assert.ok(
    !JSON.stringify(sessions[0]).includes(token),
    'the raw token must not be recoverable from a database dump'
  );
});

test('a token resolves to its member', async () => {
  const { manager } = makeManager();
  const token = await manager.createSession('alice');

  const found = await manager.verifyToken(token);
  assert.equal(found.username, 'alice');
  assert.equal(found.user.display, 'Alice');
  assert.equal(found.user.passwordHash, undefined, 'the hash is never handed back');
});

test('an unknown, malformed or empty token resolves to nothing', async () => {
  const { manager } = makeManager();
  await manager.createSession('alice');

  assert.equal(await manager.verifyToken('mcf_not-a-real-token'), null);
  assert.equal(await manager.verifyToken(''), null);
  assert.equal(await manager.verifyToken(null), null);
  assert.equal(await manager.verifyToken(undefined), null);
});

test('an expired or long-idle session stops working', async () => {
  const { manager, sessions } = makeManager();
  const token = await manager.createSession('alice');
  assert.ok(await manager.verifyToken(token));

  sessions[0].expiresAt = new Date(Date.now() - 1000);
  assert.equal(await manager.verifyToken(token), null, 'past expiresAt');

  sessions[0].expiresAt = new Date(Date.now() + 60_000);
  sessions[0].lastSeenAt = new Date(Date.now() - IDLE_TTL_MS - 1000);
  assert.equal(await manager.verifyToken(token), null, 'idle longer than the limit');
});

test('a banned or deleted member loses every session at once', async () => {
  const { manager, users } = makeManager();
  const token = await manager.createSession('alice');
  assert.ok(await manager.verifyToken(token));

  users.find(u => u.username === 'alice').banned = true;
  assert.equal(await manager.verifyToken(token), null, 'banned');

  users.find(u => u.username === 'alice').banned = false;
  users.splice(users.findIndex(u => u.username === 'alice'), 1);
  assert.equal(await manager.verifyToken(token), null, 'account deleted');
});

test('signing out ends that session only', async () => {
  const { manager } = makeManager();
  const first = await manager.createSession('alice');
  const second = await manager.createSession('alice');

  assert.equal(await manager.destroyToken(first), 1);
  assert.equal(await manager.verifyToken(first), null);
  assert.ok(await manager.verifyToken(second), 'the other device stays signed in');
  assert.equal(await manager.destroyToken(first), 0, 'revoking twice is harmless');
});

test('revoking every session can spare the one in use', async () => {
  const { manager } = makeManager();
  const kept = await manager.createSession('alice');
  const dropped = await manager.createSession('alice');
  await manager.createSession('bob');

  assert.equal(await manager.destroyUserSessions('alice', { exceptToken: kept }), 1);
  assert.ok(await manager.verifyToken(kept), 'a password change should not sign out this device');
  assert.equal(await manager.verifyToken(dropped), null);

  assert.equal(await manager.destroyUserSessions('alice'), 1);
  assert.equal(await manager.verifyToken(kept), null);
});

test('a busy session is touched, but not on every request', async () => {
  const { manager, sessions } = makeManager();
  const token = await manager.createSession('alice');
  const issued = sessions[0].lastSeenAt.getTime();

  await manager.verifyToken(token);
  assert.equal(sessions[0].lastSeenAt.getTime(), issued, 'a fresh session is not rewritten');

  sessions[0].lastSeenAt = new Date(Date.now() - TOUCH_AFTER_MS - 1000);
  await manager.verifyToken(token);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(sessions[0].lastSeenAt.getTime() > Date.now() - TOUCH_AFTER_MS, 'an old one is renewed');
});

test('safeEqual compares without leaking length or content', () => {
  assert.ok(safeEqual('secret', 'secret'));
  assert.ok(!safeEqual('secret', 'secretx'));
  assert.ok(!safeEqual('secret', 'secre'));
  assert.ok(!safeEqual('secret', ''));
  assert.ok(!safeEqual('', 'secret'));
  assert.ok(safeEqual('', ''));
});

/* ---------------------------------------------------------------
   Where a token may come from
--------------------------------------------------------------- */

test('a token is read from the bearer header or the cookie', () => {
  assert.equal(tokenFromRequest(fakeReq({ headers: { authorization: 'Bearer abc123' } })), 'abc123');
  assert.equal(tokenFromRequest(fakeReq({ headers: { authorization: 'bearer abc123' } })), 'abc123');
  assert.equal(tokenFromRequest(fakeReq({ headers: { authorization: '  Bearer   abc123  ' } })), 'abc123');
  assert.equal(tokenFromRequest(fakeReq({ headers: { cookie: `other=1; ${COOKIE_NAME}=abc123; more=2` } })), 'abc123');
  assert.equal(tokenFromRequest(fakeReq({ headers: { cookie: `${COOKIE_NAME}=abc%5F123` } })), 'abc_123', 'url-decoded');
  assert.equal(tokenFromRequest(fakeReq()), null);
  assert.equal(tokenFromRequest(fakeReq({ headers: { authorization: 'Basic abc' } })), null);
});

test('the bearer header wins over the cookie', () => {
  const req = fakeReq({ headers: { authorization: 'Bearer fromHeader', cookie: `${COOKIE_NAME}=fromCookie` } });
  assert.equal(tokenFromRequest(req), 'fromHeader');
});

test('the cookie is httpOnly, lax, and only secure in production', () => {
  const prod = cookieOptions({ secure: true });
  assert.equal(prod.httpOnly, true, 'JavaScript must not be able to read the session');
  assert.equal(prod.sameSite, 'lax');
  assert.equal(prod.secure, true);
  assert.equal(prod.path, '/');

  assert.equal(cookieOptions({ secure: false }).secure, false, 'a plain-http preview still has to sign in');
});

/* ---------------------------------------------------------------
   CSRF: a cookie is enough to authenticate, so origin is checked
--------------------------------------------------------------- */

test('a safe method from anywhere is allowed', () => {
  const req = fakeReq({ method: 'GET', origin: 'https://evil.example' });
  assert.ok(sameSiteRequest(req, 'https://male-cyber-fighters.com'));
});

test('a write from another site carrying the cookie is refused', () => {
  const req = fakeReq({ method: 'POST', origin: 'https://evil.example' });
  assert.ok(!sameSiteRequest(req, 'https://male-cyber-fighters.com'));
});

test('a write from this site is allowed', () => {
  for (const origin of ['https://male-cyber-fighters.com']) {
    assert.ok(sameSiteRequest(fakeReq({ method: 'POST', origin }), 'https://male-cyber-fighters.com'), origin);
  }
  // A deployment reached through several names: the host the request was
  // addressed to counts as this site too.
  assert.ok(sameSiteRequest(
    fakeReq({ method: 'POST', origin: 'https://app.example.com', host: 'app.example.com' }),
    'https://male-cyber-fighters.com'
  ));
  // Browsers omit Origin on some same-origin requests and non-browser clients
  // omit it entirely; refusing those would break the API.
  assert.ok(sameSiteRequest(fakeReq({ method: 'POST' }), 'https://male-cyber-fighters.com'));
});

/* ---------------------------------------------------------------
   The middleware a handler actually sees
--------------------------------------------------------------- */

test('requireUser rejects a request with no session', async () => {
  const { manager } = makeManager();
  const { res, called } = await runMiddleware(manager.requireUser, fakeReq({ method: 'POST' }));

  assert.equal(called, false, 'the handler must not run');
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, 'auth_required');
});

test('requireUser derives the username from the token, not the body', async () => {
  const { manager } = makeManager();
  const token = await manager.createSession('alice');

  const req = fakeReq({ method: 'POST', headers: { authorization: `Bearer ${token}` } });
  req.body = { username: 'bob', a: 'bob', b: 'alice' }; // a forged claim

  const { res, called } = await runMiddleware(manager.requireUser, req);
  assert.equal(called, true);
  assert.equal(res.statusCode, 200);
  assert.equal(req.username, 'alice', 'the session decides, whatever the body says');
  assert.equal(req.user.display, 'Alice');
});

test('requireUser accepts the cookie on a same-site write', async () => {
  const { manager } = makeManager();
  const token = await manager.createSession('alice');

  const req = fakeReq({
    method: 'POST',
    origin: 'https://male-cyber-fighters.com',
    headers: { cookie: `${COOKIE_NAME}=${token}` }
  });
  const { called } = await runMiddleware(manager.requireUser, req);
  assert.equal(called, true);
  assert.equal(req.username, 'alice');
});

test('requireUser refuses a cross-site write that relies on the cookie', async () => {
  const { manager } = makeManager();
  const token = await manager.createSession('alice');

  const req = fakeReq({
    method: 'POST',
    origin: 'https://evil.example',
    headers: { cookie: `${COOKIE_NAME}=${token}` }
  });
  const { res, called } = await runMiddleware(manager.requireUser, req);
  assert.equal(called, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'cross_site_request');
});

test('a bearer token is not subject to the origin check', async () => {
  // The desktop and mobile wrappers are not same-origin with the API. They
  // cannot be driven by a CSRF attack either: a foreign page has no way to read
  // the token out of another origin's storage to attach it.
  const { manager } = makeManager();
  const token = await manager.createSession('alice');

  const req = fakeReq({
    method: 'POST',
    origin: 'capacitor://localhost',
    headers: { authorization: `Bearer ${token}` }
  });
  const { called } = await runMiddleware(manager.requireUser, req);
  assert.equal(called, true);
  assert.equal(req.username, 'alice');
});

test('authenticate never blocks, it only annotates', async () => {
  const { manager } = makeManager();
  const token = await manager.createSession('alice');

  const anonymous = await runMiddleware(manager.authenticate, fakeReq());
  assert.equal(anonymous.called, true, 'a signed-out visitor still reaches the route');
  assert.equal(anonymous.req.session, undefined);

  const signedIn = await runMiddleware(
    manager.authenticate,
    fakeReq({ headers: { authorization: `Bearer ${token}` } })
  );
  assert.equal(signedIn.called, true);
  assert.equal(signedIn.req.session.username, 'alice');
});

test('a revoked token stops working on the next request', async () => {
  const { manager } = makeManager();
  const token = await manager.createSession('alice');

  const before = await runMiddleware(manager.requireUser, fakeReq({ headers: { authorization: `Bearer ${token}` } }));
  assert.equal(before.called, true);

  await manager.destroyToken(token);

  const after = await runMiddleware(manager.requireUser, fakeReq({ headers: { authorization: `Bearer ${token}` } }));
  assert.equal(after.called, false);
  assert.equal(after.res.statusCode, 401);
});

/* ---------------------------------------------------------------
   Over real HTTP, the way index.js mounts it
--------------------------------------------------------------- */

test('a route mounted with requireUser reads no identity from the body', async () => {
  const { manager } = makeManager();
  const token = await manager.createSession('alice');

  const app = express();
  app.use(express.json());

  // The shape of the endpoints that used to take `{ a, b }` or `{ username }`:
  // the handler now only ever sees req.username.
  app.post('/api/dm/history', manager.requireUser, (req, res) => {
    res.json({ ok: true, me: req.username, claimed: req.body.username || null });
  });

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const anonymous = await fetch(`${base}/api/dm/history`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'bob' })
    });
    assert.equal(anonymous.status, 401);

    const signedIn = await fetch(`${base}/api/dm/history`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ username: 'bob' })
    });
    const body = await signedIn.json();
    assert.equal(signedIn.status, 200);
    assert.equal(body.me, 'alice');
    assert.equal(body.claimed, 'bob', 'the claim still arrives, it is simply not used');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

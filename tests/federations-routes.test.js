/**
 * Federations — the routes, exercised over real HTTP.
 *
 * Create is the rule with teeth ("if you don't run a federation already"), and
 * it spans two collections: the Federation row and the member's own
 * user.federation pointer. So instead of trusting the route by inspection, the
 * router is mounted on a throwaway express app with a tiny in-memory stand-in
 * for the two mongoose models, and driven with fetch().
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { createFederationRouter } = require('../federations.js');

/* ---------------------------------------------------------------
   In-memory mongoose stand-in — only the calls the router makes
--------------------------------------------------------------- */

const clone = value => (value == null ? value : JSON.parse(JSON.stringify(value)));

function query(value) {
  const api = {
    select: () => api,
    sort: () => api,
    limit: () => api,
    lean: () => Promise.resolve(clone(value))
  };
  return api;
}

function createStore() {
  const state = { federations: [], users: new Map(), nextId: 1 };

  function memberMatches(doc, entry) {
    if (!entry || !entry.$ne) return true;
    return !(doc.members || []).some(member => member.username === entry.$ne);
  }

  const Federation = {
    create: async body => {
      const doc = Object.assign(
        { _id: 'fed' + state.nextId++, createdAt: new Date(), updatedAt: new Date(), messages: [] },
        clone(body)
      );
      state.federations.push(doc);
      return clone({ ...doc, _id: doc._id });
    },

    findOne: filter => {
      const found = state.federations.find(doc =>
        Object.entries(filter || {}).every(([key, value]) => doc[key] === value)
      );
      return query(found || null);
    },

    find: () => query(state.federations),

    findById: id => query(state.federations.find(doc => String(doc._id) === String(id)) || null),

    findOneAndUpdate: async (filter, update) => {
      const doc = state.federations.find(candidate =>
        String(candidate._id) === String(filter._id) && memberMatches(candidate, filter['members.username'])
      );
      if (!doc) return null;
      (update.$push ? Object.entries(update.$push) : []).forEach(([key, value]) => {
        doc[key] = (doc[key] || []).concat([clone(value)]);
      });
      return clone(doc);
    },

    findByIdAndUpdate: (id, update) => {
      const doc = state.federations.find(candidate => String(candidate._id) === String(id));
      if (!doc) return query(null);
      if (update.$push && update.$push.messages) {
        const push = update.$push.messages;
        const items = Array.isArray(push.$each) ? push.$each : [push];
        doc.messages = (doc.messages || []).concat(clone(items));
        if (typeof push.$slice === 'number' && push.$slice < 0) {
          doc.messages = doc.messages.slice(push.$slice);
        }
      }
      return query(doc);
    },

    updateOne: async (filter, update) => {
      const doc = state.federations.find(candidate => String(candidate._id) === String(filter._id));
      if (!doc) return { matchedCount: 0 };
      if (update.$pull && update.$pull.members) {
        doc.members = (doc.members || []).filter(
          member => member.username !== update.$pull.members.username
        );
      }
      return { matchedCount: 1 };
    },

    deleteOne: async filter => {
      const index = state.federations.findIndex(doc => String(doc._id) === String(filter._id));
      if (index !== -1) state.federations.splice(index, 1);
      return { deletedCount: index === -1 ? 0 : 1 };
    }
  };

  const User = {
    findOne: filter => query(state.users.get(filter.username) || null),
    updateOne: async (filter, update) => {
      const user = state.users.get(filter.username);
      if (!user) return { matchedCount: 0 };
      if (update.$set) Object.assign(user, clone(update.$set));
      return { matchedCount: 1 };
    }
  };

  return { state, Federation, User };
}

/* ---------------------------------------------------------------
   A throwaway app
--------------------------------------------------------------- */

async function startApi(store) {
  const app = express();
  app.use(express.json());

  // Stands in for sessions.requireUser: the test names the signed-in member.
  const requireUser = (req, res, next) => {
    const username = req.get('x-test-user');
    if (!username) return res.status(401).json({ ok: false, error: 'auth_required' });
    req.username = username;
    next();
  };

  app.use('/api/federations', createFederationRouter({
    Federation: store.Federation,
    User: store.User,
    requireUser
  }).router);

  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, path, { user, body } = {}) {
    const headers = {};
    if (user) headers['x-test-user'] = user;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: res.status, body: await res.json() };
  }

  return { call, close: () => new Promise(resolve => server.close(resolve)) };
}

function addUser(store, username, extra = {}) {
  store.state.users.set(username, {
    username,
    display: username.toUpperCase(),
    federation: null,
    banned: false,
    ...extra
  });
}

function registration(overrides = {}) {
  return {
    name: 'Iron Ring Federation',
    description: 'A heavyweight promotion for men who like their matches long and loud.',
    rules: 'Titles are won by pinfall or submission.',
    roles: [{ name: 'Commissioner', description: 'Books the cards' }],
    imageUrl: 'https://i.ibb.co/abc123/ring.png',
    ...overrides
  };
}

/* ---------------------------------------------------------------
   Create
--------------------------------------------------------------- */

test('creating a federation needs a signed-in member', async () => {
  const store = createStore();
  const api = await startApi(store);
  try {
    const res = await api.call('POST', '/api/federations', { body: registration() });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'auth_required');
  } finally {
    await api.close();
  }
});

test('create stores the federation and points the owner at it', async () => {
  const store = createStore();
  addUser(store, 'boss');
  const api = await startApi(store);
  try {
    const res = await api.call('POST', '/api/federations', { user: 'boss', body: registration() });
    assert.equal(res.status, 201);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.federation.name, 'Iron Ring Federation');
    assert.equal(res.body.federation.owner, 'boss');
    assert.equal(res.body.federation.isOwner, true);
    assert.equal(res.body.federation.memberCount, 1);
    assert.deepEqual(
      res.body.federation.roles.map(role => role.id),
      ['owner', 'member', 'commissioner']
    );

    // The federation itself is in Mongo…
    assert.equal(store.state.federations.length, 1);
    const stored = store.state.federations[0];
    assert.equal(stored.owner, 'boss');
    assert.equal(stored.nameKey, 'iron ring federation');
    assert.equal(stored.members[0].roleId, 'owner');

    // …and the owner's own record carries the pointer.
    const owner = store.state.users.get('boss');
    assert.equal(String(owner.federation.id), String(stored._id));
    assert.equal(owner.federation.name, 'Iron Ring Federation');
    assert.equal(owner.federation.role, 'owner');
  } finally {
    await api.close();
  }
});

test('a member who already runs one cannot register a second', async () => {
  const store = createStore();
  addUser(store, 'boss');
  const api = await startApi(store);
  try {
    const first = await api.call('POST', '/api/federations', { user: 'boss', body: registration() });
    assert.equal(first.status, 201);

    const second = await api.call('POST', '/api/federations', {
      user: 'boss',
      body: registration({ name: 'Second Ring', description: 'A completely different federation.' })
    });
    assert.equal(second.status, 409);
    assert.equal(second.body.error, 'already_in_federation');
    assert.equal(second.body.membership.name, 'Iron Ring Federation');
    assert.equal(store.state.federations.length, 1);
  } finally {
    await api.close();
  }
});

test('a member of someone else’s federation cannot create one either', async () => {
  const store = createStore();
  addUser(store, 'boss');
  addUser(store, 'rookie');
  const api = await startApi(store);
  try {
    const created = await api.call('POST', '/api/federations', { user: 'boss', body: registration() });
    const id = created.body.federation.id;
    store.state.users.get('rookie').federation = {
      id, name: 'Iron Ring Federation', role: 'member', joinedAt: new Date()
    };

    const res = await api.call('POST', '/api/federations', { user: 'rookie', body: registration() });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'already_in_federation');
    assert.equal(res.body.membership.name, 'Iron Ring Federation');
  } finally {
    await api.close();
  }
});

test('a federation that exists but lost its owner pointer still blocks Create', async () => {
  const store = createStore();
  addUser(store, 'boss');
  store.state.federations.push({
    _id: 'fed9',
    name: 'Old Ring',
    nameKey: 'old ring',
    owner: 'boss',
    members: [],
    roles: [],
    messages: []
  });
  const api = await startApi(store);
  try {
    const res = await api.call('POST', '/api/federations', { user: 'boss', body: registration() });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'already_run_federation');
  } finally {
    await api.close();
  }
});

test('a membership pointing at a deleted federation does not block Create', async () => {
  const store = createStore();
  addUser(store, 'boss', {
    federation: { id: 'gone', name: 'Vanished Ring', role: 'owner', joinedAt: new Date() }
  });
  const api = await startApi(store);
  try {
    const res = await api.call('POST', '/api/federations', { user: 'boss', body: registration() });
    assert.equal(res.status, 201, 'the stale pointer was cleared instead of blocking the form');
    const owner = store.state.users.get('boss');
    assert.equal(owner.federation.name, 'Iron Ring Federation');
  } finally {
    await api.close();
  }
});

test('federation names are unique across owners, ignoring case', async () => {
  const store = createStore();
  addUser(store, 'boss');
  addUser(store, 'rival');
  const api = await startApi(store);
  try {
    await api.call('POST', '/api/federations', { user: 'boss', body: registration() });
    const res = await api.call('POST', '/api/federations', {
      user: 'rival',
      body: registration({ name: 'iron ring federation' })
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'name_taken');
  } finally {
    await api.close();
  }
});

test('the registration form is validated server-side', async () => {
  const store = createStore();
  addUser(store, 'boss');
  const api = await startApi(store);
  try {
    const res = await api.call('POST', '/api/federations', {
      user: 'boss',
      body: registration({ name: 'No', roles: [{ name: 'Owner' }] })
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'name_short');

    const badImage = await api.call('POST', '/api/federations', {
      user: 'boss',
      body: registration({ imageUrl: 'javascript:alert(1)' })
    });
    assert.equal(badImage.status, 400);
    assert.equal(badImage.body.error, 'image_invalid');
    assert.equal(store.state.federations.length, 0);
  } finally {
    await api.close();
  }
});

/* ---------------------------------------------------------------
   List / mine / join / chatroom
--------------------------------------------------------------- */

test('the Join list shows every federation and your own membership', async () => {
  const store = createStore();
  addUser(store, 'boss');
  addUser(store, 'scout');
  const api = await startApi(store);
  try {
    await api.call('POST', '/api/federations', { user: 'boss', body: registration() });

    const res = await api.call('GET', '/api/federations', { user: 'scout' });
    assert.equal(res.status, 200);
    assert.equal(res.body.membership, null);
    assert.equal(res.body.federations.length, 1);
    assert.equal(res.body.federations[0].name, 'Iron Ring Federation');
    assert.equal(res.body.federations[0].memberCount, 1);
    assert.ok(!('members' in res.body.federations[0]), 'the join list never carries the roster');
  } finally {
    await api.close();
  }
});

test('joining adds the member to the roster and to their own record', async () => {
  const store = createStore();
  addUser(store, 'boss');
  addUser(store, 'rookie');
  const api = await startApi(store);
  try {
    const created = await api.call('POST', '/api/federations', { user: 'boss', body: registration() });
    const id = created.body.federation.id;

    const joined = await api.call('POST', `/api/federations/${id}/join`, { user: 'rookie', body: {} });
    assert.equal(joined.status, 200);
    assert.equal(joined.body.federation.memberCount, 2);
    assert.deepEqual(
      joined.body.federation.members.map(member => member.username).sort(),
      ['boss', 'rookie']
    );

    const rookie = store.state.users.get('rookie');
    assert.equal(String(rookie.federation.id), String(id));
    assert.equal(rookie.federation.role, 'member');

    // A second tap is refused rather than adding a duplicate row.
    const again = await api.call('POST', `/api/federations/${id}/join`, { user: 'rookie', body: {} });
    assert.equal(again.status, 409);
    assert.equal(again.body.error, 'already_member');
  } finally {
    await api.close();
  }
});

test('joining a federation that does not exist is a 404', async () => {
  const store = createStore();
  addUser(store, 'rookie');
  const api = await startApi(store);
  try {
    const res = await api.call('POST', '/api/federations/missing/join', { user: 'rookie', body: {} });
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'not_found');
  } finally {
    await api.close();
  }
});

test('mine returns the owner’s federation with its bylaws and roster', async () => {
  const store = createStore();
  addUser(store, 'boss');
  const api = await startApi(store);
  try {
    await api.call('POST', '/api/federations', { user: 'boss', body: registration() });
    const res = await api.call('GET', '/api/federations/mine', { user: 'boss' });
    assert.equal(res.status, 200);
    assert.equal(res.body.federation.isOwner, true);
    assert.equal(res.body.federation.rules, 'Titles are won by pinfall or submission.');
    assert.equal(res.body.federation.members.length, 1);
    assert.equal(res.body.membership.role, 'owner');
  } finally {
    await api.close();
  }
});

test('mine clears a membership pointer when the federation is gone', async () => {
  const store = createStore();
  addUser(store, 'rookie', {
    federation: { id: 'gone', name: 'Vanished Ring', role: 'member', joinedAt: new Date() }
  });
  const api = await startApi(store);
  try {
    const res = await api.call('GET', '/api/federations/mine', { user: 'rookie' });
    assert.equal(res.status, 200);
    assert.equal(res.body.federation, null);
    assert.equal(res.body.membership, null);
    assert.equal(store.state.users.get('rookie').federation, null);
  } finally {
    await api.close();
  }
});

test('the chatroom is members only, and messages come back newest-last', async () => {
  const store = createStore();
  addUser(store, 'boss');
  addUser(store, 'rookie');
  addUser(store, 'outsider');
  const api = await startApi(store);
  try {
    const created = await api.call('POST', '/api/federations', { user: 'boss', body: registration() });
    const id = created.body.federation.id;
    await api.call('POST', `/api/federations/${id}/join`, { user: 'rookie', body: {} });

    const denied = await api.call('GET', `/api/federations/${id}/messages`, { user: 'outsider' });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, 'not_a_member');

    const posted = await api.call('POST', `/api/federations/${id}/messages`, {
      user: 'rookie',
      body: { text: '  First blood.  ' }
    });
    assert.equal(posted.status, 201);
    assert.equal(posted.body.messages[0].from, 'rookie');
    assert.equal(posted.body.messages[0].text, 'First blood.');

    const listed = await api.call('GET', `/api/federations/${id}/messages`, { user: 'boss' });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.messages.length, 1);

    const empty = await api.call('POST', `/api/federations/${id}/messages`, {
      user: 'rookie',
      body: { text: '   ' }
    });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.error, 'message_required');
  } finally {
    await api.close();
  }
});

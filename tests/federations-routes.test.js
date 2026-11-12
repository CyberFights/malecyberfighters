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

      if (update.$push && update.$push.roles) {
        doc.roles = (doc.roles || []).concat([clone(update.$push.roles)]);
      }

      if (update.$pull && update.$pull.members) {
        doc.members = (doc.members || []).filter(
          member => member.username !== update.$pull.members.username
        );
      }

      if (update.$pull && update.$pull.roles) {
        doc.roles = (doc.roles || []).filter(role => role.id !== update.$pull.roles.id);
      }

      if (update.$set) {
        Object.entries(update.$set).forEach(([key, value]) => {
          if (key.indexOf('members.$.') === 0) {
            const field = key.slice('members.$.'.length);
            const member = (doc.members || [])
              .find(entry => entry.username === filter['members.username']);
            if (member) member[field] = clone(value);
            return;
          }
          if (key.indexOf('roles.$.') === 0) {
            const field = key.slice('roles.$.'.length);
            const role = (doc.roles || []).find(entry => entry.id === filter['roles.id']);
            if (role) role[field] = clone(value);
            return;
          }
          doc[key] = clone(value);
        });
      }
      return { matchedCount: 1 };
    },

    deleteOne: async filter => {
      const index = state.federations.findIndex(doc => String(doc._id) === String(filter._id));
      if (index !== -1) state.federations.splice(index, 1);
      return { deletedCount: index === -1 ? 0 : 1 };
    }
  };

  function applySet(target, set) {
    Object.entries(set || {}).forEach(([key, value]) => {
      if (key.indexOf('.') === -1) {
        target[key] = clone(value);
        return;
      }
      const parts = key.split('.');
      let cursor = target;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!cursor[parts[i]] || typeof cursor[parts[i]] !== 'object') cursor[parts[i]] = {};
        cursor = cursor[parts[i]];
      }
      cursor[parts[parts.length - 1]] = clone(value);
    });
  }

  const User = {
    findOne: filter => query(state.users.get(filter.username) || null),

    find: filter => {
      const names = filter && filter.username && filter.username.$in;
      const users = Array.from(state.users.values())
        .filter(user => !names || names.indexOf(user.username) !== -1);
      return query(users);
    },

    updateOne: async (filter, update) => {
      const user = state.users.get(filter.username);
      if (!user) return { matchedCount: 0 };
      applySet(user, update.$set);
      return { matchedCount: 1 };
    },

    updateMany: async (filter, update) => {
      const id = filter && filter['federation.id'];
      let matched = 0;
      state.users.forEach(user => {
        if (!user.federation || !user.federation.id) return;
        if (id != null && String(user.federation.id) !== String(id)) return;
        matched += 1;
        applySet(user, update.$set);
      });
      return { matchedCount: matched };
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
      ['owner', 'co-owner', 'member', 'commissioner']
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

/* ---------------------------------------------------------------
   Manage: who may, and what each tab does
--------------------------------------------------------------- */

/** Owner "boss", promoted co-owner "co", plain member "rookie". */
async function setupManagedFederation() {
  const store = createStore();
  addUser(store, 'boss');
  addUser(store, 'co', { online: true });
  addUser(store, 'rookie', { lastSeenAt: new Date('2026-01-02T10:00:00Z') });
  addUser(store, 'stranger');
  const api = await startApi(store);

  const created = await api.call('POST', '/api/federations', { user: 'boss', body: registration() });
  const id = created.body.federation.id;

  await api.call('POST', `/api/federations/${id}/join`, { user: 'co', body: {} });
  await api.call('POST', `/api/federations/${id}/join`, { user: 'rookie', body: {} });
  await api.call('POST', `/api/federations/${id}/members/co/role`, {
    user: 'boss',
    body: { roleId: 'co-owner' }
  });

  return { store, api, id };
}

test('only the owner and admins may open Manage — /mine says who can', async () => {
  const { api, id } = await setupManagedFederation();
  try {
    const owner = await api.call('GET', '/api/federations/mine', { user: 'boss' });
    assert.equal(owner.body.federation.canManage, true);
    assert.equal(owner.body.federation.viewerRole, 'owner');

    const coOwner = await api.call('GET', '/api/federations/mine', { user: 'co' });
    assert.equal(coOwner.body.federation.canManage, true);
    assert.equal(coOwner.body.federation.viewerRole, 'co-owner');

    const member = await api.call('GET', '/api/federations/mine', { user: 'rookie' });
    assert.equal(member.body.federation.canManage, false);
    assert.equal(member.body.federation.viewerRole, 'member');

    // Logged-in outsider: no membership, no management.
    const outsider = await api.call('GET', '/api/federations/mine', { user: 'stranger' });
    assert.equal(outsider.body.federation, null);
    assert.equal(outsider.body.membership, null);

    assert.ok(id);
  } finally {
    await api.close();
  }
});

test('the roster carries each member’s last-online presence', async () => {
  const { api } = await setupManagedFederation();
  try {
    const res = await api.call('GET', '/api/federations/mine', { user: 'boss' });
    const byName = {};
    res.body.federation.members.forEach(member => { byName[member.username] = member; });

    assert.equal(byName.co.online, true, 'a live socket shows online');
    assert.equal(byName.rookie.online, false);
    assert.equal(byName.rookie.lastSeenAt, '2026-01-02T10:00:00.000Z');
  } finally {
    await api.close();
  }
});

test('a plain member cannot edit the details or the roster', async () => {
  const { api, id } = await setupManagedFederation();
  try {
    const edit = await api.call('PATCH', `/api/federations/${id}`, {
      user: 'rookie',
      body: { name: 'Hijacked Ring', description: 'A takeover attempt that should fail.' }
    });
    assert.equal(edit.status, 403);
    assert.equal(edit.body.error, 'not_a_manager');

    const role = await api.call('POST', `/api/federations/${id}/members/boss/role`, {
      user: 'rookie',
      body: { roleId: 'member' }
    });
    assert.equal(role.status, 403);
    assert.equal(role.body.error, 'not_a_manager');

    const remove = await api.call('DELETE', `/api/federations/${id}/members/co`, { user: 'rookie' });
    assert.equal(remove.status, 403);
    assert.equal(remove.body.error, 'not_a_manager');
  } finally {
    await api.close();
  }
});

test('the details tab saves name, description, rules and image', async () => {
  const { store, api, id } = await setupManagedFederation();
  try {
    const res = await api.call('PATCH', `/api/federations/${id}`, {
      user: 'co',
      body: {
        name: 'Iron Ring Wrestling',
        description: 'The same federation, with a sharper name.',
        rules: 'Pinfall, submission or KO.',
        imageUrl: 'https://i.ibb.co/new/ring.png'
      }
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.federation.name, 'Iron Ring Wrestling');
    assert.equal(res.body.federation.rules, 'Pinfall, submission or KO.');

    // A rename reaches every member's own pointer, not just the document.
    ['boss', 'co', 'rookie'].forEach(username => {
      assert.equal(store.state.users.get(username).federation.name, 'Iron Ring Wrestling', username);
    });

    const sameName = await api.call('PATCH', `/api/federations/${id}`, {
      user: 'boss',
      body: { name: 'Iron Ring Wrestling', description: 'Saving the same name again is fine.' }
    });
    assert.equal(sameName.status, 200, 'a rename to its own name is not a duplicate');

    const bad = await api.call('PATCH', `/api/federations/${id}`, {
      user: 'boss',
      body: { name: 'No', description: 'Too short a name for the form.' }
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'name_short');
  } finally {
    await api.close();
  }
});

test('a rename cannot steal another federation’s name', async () => {
  const store = createStore();
  addUser(store, 'boss');
  addUser(store, 'rival');
  const api = await startApi(store);
  try {
    const first = await api.call('POST', '/api/federations', { user: 'boss', body: registration() });
    await api.call('POST', '/api/federations', {
      user: 'rival',
      body: registration({ name: 'Rival Ring', description: 'A different federation entirely.' })
    });

    const res = await api.call('PATCH', `/api/federations/${first.body.federation.id}`, {
      user: 'boss',
      body: { name: 'rival ring', description: 'Trying to take the other name.' }
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'name_taken');
  } finally {
    await api.close();
  }
});

test('the owner hands out roles; the pointer follows the member', async () => {
  const { store, api, id } = await setupManagedFederation();
  try {
    const res = await api.call('POST', `/api/federations/${id}/members/rookie/role`, {
      user: 'boss',
      body: { roleId: 'commissioner' }
    });
    assert.equal(res.status, 200);
    const rookie = store.state.users.get('rookie');
    assert.equal(rookie.federation.role, 'commissioner');

    const memberRow = res.body.federation.members.find(member => member.username === 'rookie');
    assert.equal(memberRow.roleId, 'commissioner');

    const badRole = await api.call('POST', `/api/federations/${id}/members/rookie/role`, {
      user: 'boss',
      body: { roleId: 'emperor' }
    });
    assert.equal(badRole.status, 400);
    assert.equal(badRole.body.error, 'invalid_role');

    const ownerRole = await api.call('POST', `/api/federations/${id}/members/rookie/role`, {
      user: 'boss',
      body: { roleId: 'owner' }
    });
    assert.equal(ownerRole.status, 400, 'ownership is not a role the form can hand out');
  } finally {
    await api.close();
  }
});

test('admins cannot mint admins, touch peers, or edit their own row', async () => {
  const { api, id } = await setupManagedFederation();
  try {
    // Admin → another member as a *plain* role: allowed.
    const ok = await api.call('POST', `/api/federations/${id}/members/rookie/role`, {
      user: 'co',
      body: { roleId: 'commissioner' }
    });
    assert.equal(ok.status, 200);

    // Admin → admin role: only the owner may promote.
    const promote = await api.call('POST', `/api/federations/${id}/members/rookie/role`, {
      user: 'co',
      body: { roleId: 'co-owner' }
    });
    assert.equal(promote.status, 403);
    assert.equal(promote.body.error, 'insufficient_privileges');

    // Admin → another admin's row: out of their league.
    const peer = await api.call('POST', `/api/federations/${id}/members/boss/role`, {
      user: 'co',
      body: { roleId: 'member' }
    });
    assert.equal(peer.status, 409, 'the owner row is immutable');

    // Admin → their own row: a mis-tap should not demote them.
    const self = await api.call('POST', `/api/federations/${id}/members/co/role`, {
      user: 'co',
      body: { roleId: 'member' }
    });
    assert.equal(self.status, 409);
    assert.equal(self.body.error, 'cannot_change_own_role');
  } finally {
    await api.close();
  }
});

test('the owner can promote a member to co-owner and remove them again', async () => {
  const { store, api, id } = await setupManagedFederation();
  try {
    const promoted = await api.call('POST', `/api/federations/${id}/members/rookie/role`, {
      user: 'boss',
      body: { roleId: 'co-owner' }
    });
    assert.equal(promoted.status, 200);
    assert.equal(store.state.users.get('rookie').federation.role, 'co-owner');

    // Now only the owner outranks rookie.
    const adminVsAdmin = await api.call('DELETE', `/api/federations/${id}/members/rookie`, { user: 'co' });
    assert.equal(adminVsAdmin.status, 403);
    assert.equal(adminVsAdmin.body.error, 'insufficient_privileges');

    const removed = await api.call('DELETE', `/api/federations/${id}/members/rookie`, { user: 'boss' });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.removed, 'rookie');
    assert.equal(store.state.users.get('rookie').federation, null, 'their own record is cleared');
    assert.equal(removed.body.federation.memberCount, 2);
  } finally {
    await api.close();
  }
});

test('the owner cannot be removed, and a member can leave on their own', async () => {
  const { store, api, id } = await setupManagedFederation();
  try {
    const ownerGone = await api.call('DELETE', `/api/federations/${id}/members/boss`, { user: 'boss' });
    assert.equal(ownerGone.status, 409);
    assert.equal(ownerGone.body.error, 'cannot_remove_owner');

    const leaving = await api.call('DELETE', `/api/federations/${id}/members/rookie`, { user: 'rookie' });
    assert.equal(leaving.status, 200);
    assert.equal(leaving.body.selfRemoved, true);
    assert.equal(store.state.users.get('rookie').federation, null);
  } finally {
    await api.close();
  }
});

/* ---------------------------------------------------------------
   Manage → Roles: create, rename, delete
--------------------------------------------------------------- */

async function roleByName(api, id, user, name) {
  const mine = await api.call('GET', '/api/federations/mine', { user });
  return mine.body.federation.roles.find(role => role.name === name);
}

test('the owner can invent a role and hand it to a member', async () => {
  const { api, id } = await setupManagedFederation();
  try {
    const created = await api.call('POST', `/api/federations/${id}/roles`, {
      user: 'boss',
      body: { name: 'Ring Announcer', description: 'Calls the matches', admin: false }
    });
    assert.equal(created.status, 201);
    const role = created.body.federation.roles.find(entry => entry.name === 'Ring Announcer');
    assert.ok(role, 'the new role is in the payload');
    assert.equal(role.id, 'ring-announcer');
    assert.equal(role.admin, false);
    assert.equal(role.builtIn, false);
    assert.equal(created.body.federation.canManage, true);

    // A role that is merely created changes nothing for the roster…
    assert.equal(created.body.federation.memberCount, 3);

    const assigned = await api.call('POST', `/api/federations/${id}/members/rookie/role`, {
      user: 'boss',
      body: { roleId: 'ring-announcer' }
    });
    assert.equal(assigned.status, 200);
    const rookie = assigned.body.federation.members.find(member => member.username === 'rookie');
    assert.equal(rookie.roleId, 'ring-announcer');
    assert.equal(
      assigned.body.federation.roles.find(entry => entry.id === rookie.roleId).name,
      'Ring Announcer'
    );
  } finally {
    await api.close();
  }
});

test('a role in use cannot be deleted until its holder is moved', async () => {
  const { api, id } = await setupManagedFederation();
  try {
    await api.call('POST', `/api/federations/${id}/roles`, {
      user: 'boss',
      body: { name: 'Referee', description: '' }
    });
    await api.call('POST', `/api/federations/${id}/members/rookie/role`, {
      user: 'boss',
      body: { roleId: 'referee' }
    });

    const blocked = await api.call('DELETE', `/api/federations/${id}/roles/referee`, { user: 'boss' });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, 'role_in_use');
    assert.deepEqual(blocked.body.holders, ['rookie']);

    await api.call('POST', `/api/federations/${id}/members/rookie/role`, {
      user: 'boss',
      body: { roleId: 'member' }
    });

    const removed = await api.call('DELETE', `/api/federations/${id}/roles/referee`, { user: 'boss' });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.ok, true);
    assert.equal(removed.body.federation.roles.some(role => role.id === 'referee'), false);
  } finally {
    await api.close();
  }
});

test('renaming a role keeps its id, so members keep it', async () => {
  const { api, id } = await setupManagedFederation();
  try {
    const original = await roleByName(api, id, 'boss', 'Commissioner');
    await api.call('POST', `/api/federations/${id}/members/rookie/role`, {
      user: 'boss',
      body: { roleId: original.id }
    });

    const renamed = await api.call('PATCH', `/api/federations/${id}/roles/${original.id}`, {
      user: 'boss',
      body: { name: 'Head Booker', description: 'Writes the cards', admin: false }
    });
    assert.equal(renamed.status, 200);

    const after = renamed.body.federation.roles.find(role => role.id === original.id);
    assert.equal(after.name, 'Head Booker');
    assert.equal(after.description, 'Writes the cards');
    assert.equal(after.id, original.id, 'the id survives the rename');

    const rookie = renamed.body.federation.members.find(member => member.username === 'rookie');
    assert.equal(rookie.roleId, original.id, 'the member still points at the same role');
    assert.equal(
      renamed.body.federation.roles.find(role => role.id === rookie.roleId).name,
      'Head Booker'
    );

    // Renaming onto an existing name (built in or custom) is a duplicate.
    const clash = await api.call('PATCH', `/api/federations/${id}/roles/${original.id}`, {
      user: 'boss',
      body: { name: 'Member' }
    });
    assert.equal(clash.status, 400);
    assert.equal(clash.body.error, 'role_duplicate');
  } finally {
    await api.close();
  }
});

test('built-in roles are read-only, and unknown role ids are 404s', async () => {
  const { api, id } = await setupManagedFederation();
  try {
    const editOwner = await api.call('PATCH', `/api/federations/${id}/roles/owner`, {
      user: 'boss',
      body: { name: 'Big Boss' }
    });
    assert.equal(editOwner.status, 400);
    assert.equal(editOwner.body.error, 'built_in_role');

    const deleteMember = await api.call('DELETE', `/api/federations/${id}/roles/member`, { user: 'boss' });
    assert.equal(deleteMember.status, 400);
    assert.equal(deleteMember.body.error, 'built_in_role');

    const ghost = await api.call('PATCH', `/api/federations/${id}/roles/ghost`, {
      user: 'boss',
      body: { name: 'Casper' }
    });
    assert.equal(ghost.status, 404);
    assert.equal(ghost.body.error, 'role_not_found');

    const noDescription = await api.call('POST', `/api/federations/${id}/roles`, {
      user: 'boss',
      body: { name: '  ' }
    });
    assert.equal(noDescription.status, 400);
    assert.equal(noDescription.body.error, 'role_name_required');
  } finally {
    await api.close();
  }
});

test('an admin may add a plain role but cannot mint or edit an admin one', async () => {
  const { api, id } = await setupManagedFederation();
  try {
    const plain = await api.call('POST', `/api/federations/${id}/roles`, {
      user: 'co',
      body: { name: 'Timekeeper', description: '' }
    });
    assert.equal(plain.status, 201);

    const powerGrab = await api.call('POST', `/api/federations/${id}/roles`, {
      user: 'co',
      body: { name: 'Shadow Boss', admin: true }
    });
    assert.equal(powerGrab.status, 403);
    assert.equal(powerGrab.body.error, 'insufficient_privileges');

    // Promoting their own role to admin is also refused.
    const promote = await api.call('PATCH', `/api/federations/${id}/roles/timekeeper`, {
      user: 'co',
      body: { name: 'Timekeeper', admin: true }
    });
    assert.equal(promote.status, 403);
    assert.equal(promote.body.error, 'insufficient_privileges');

    // An existing admin role is the owner's to touch.
    const coOwnerRole = (await api.call('GET', '/api/federations/mine', { user: 'boss' }))
      .body.federation.roles.find(role => role.id === 'co-owner');
    assert.equal(coOwnerRole.admin, true);
    const editAdmin = await api.call('PATCH', `/api/federations/${id}/roles/co-owner`, {
      user: 'co',
      body: { name: 'Second Boss' }
    });
    assert.equal(editAdmin.status, 400);
    assert.equal(editAdmin.body.error, 'built_in_role');

    // The owner may make a custom role an admin one…
    const promoted = await api.call('PATCH', `/api/federations/${id}/roles/timekeeper`, {
      user: 'boss',
      body: { name: 'Timekeeper', admin: true }
    });
    assert.equal(promoted.status, 200);
    const timekeeper = promoted.body.federation.roles.find(role => role.id === 'timekeeper');
    assert.equal(timekeeper.admin, true);

    // …and only the owner may remove it again.
    const coDelete = await api.call('DELETE', `/api/federations/${id}/roles/timekeeper`, { user: 'co' });
    assert.equal(coDelete.status, 403);
    assert.equal(coDelete.body.error, 'insufficient_privileges');
  } finally {
    await api.close();
  }
});

test('a plain member or an outsider cannot create roles at all', async () => {
  const { api, id } = await setupManagedFederation();
  try {
    const member = await api.call('POST', `/api/federations/${id}/roles`, {
      user: 'rookie',
      body: { name: 'Sneaky Role' }
    });
    assert.equal(member.status, 403);
    assert.equal(member.body.error, 'not_a_manager');

    const outsider = await api.call('POST', `/api/federations/${id}/roles`, {
      user: 'stranger',
      body: { name: 'Outside Role' }
    });
    assert.equal(outsider.status, 403);

    const anonymous = await api.call('POST', `/api/federations/${id}/roles`, {
      body: { name: 'Anon Role' }
    });
    assert.equal(anonymous.status, 401);
  } finally {
    await api.close();
  }
});

test('the role list is capped', async () => {
  const { api, id } = await setupManagedFederation();
  try {
    const names = ['Scout', 'Trainer', 'Medic', 'Agent', 'Cameraman'];
    for (const name of names) {
      const res = await api.call('POST', `/api/federations/${id}/roles`, {
        user: 'boss',
        body: { name, description: '' }
      });
      assert.equal(res.status, 201, `${name} should fit`);
    }

    const overflow = await api.call('POST', `/api/federations/${id}/roles`, {
      user: 'boss',
      body: { name: 'Extra' }
    });
    assert.equal(overflow.status, 400);
    assert.equal(overflow.body.error, 'roles_too_many');
  } finally {
    await api.close();
  }
});

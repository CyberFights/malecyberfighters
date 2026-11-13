/**
 * Federation tournaments — the bracket maths and the routes, over real HTTP.
 *
 * The interesting rules are all cross-collection: only a manager enters a
 * lineup, only members of the federation can be entered, a lineup locks when
 * its owner says so, and the draw only happens once both sides are locked. So
 * the router is mounted on a throwaway express app with in-memory stand-ins
 * for the three models it touches, and driven with fetch().
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const {
  MAX_ENTRANTS,
  STATUS,
  normalizeTitle,
  roundLabel,
  buildFirstRound,
  buildNextRound,
  isRoundComplete,
  survivorsOf,
  championOf,
  advance,
  serializeTournament,
  createTournamentRouter
} = require('../federationTournaments.js');

/* ---------------------------------------------------------------
   In-memory mongoose stand-in — only the calls the router makes
--------------------------------------------------------------- */

const clone = value => (value == null ? value : JSON.parse(JSON.stringify(value)));

function matches(doc, filter) {
  return Object.entries(filter || {}).every(([key, expected]) => {
    const actual = doc[key];
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      if ('$in' in expected) return expected.$in.map(String).indexOf(String(actual)) !== -1;
      if ('$ne' in expected) return String(actual) !== String(expected.$ne);
    }
    return String(actual) === String(expected);
  });
}

function query(value) {
  let current = value;
  const api = {
    select: () => api,
    sort: spec => {
      if (Array.isArray(current) && spec && spec.createdAt === -1) {
        current = current.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      }
      return api;
    },
    limit: count => {
      if (Array.isArray(current) && count) current = current.slice(0, count);
      return api;
    },
    lean: () => Promise.resolve(clone(current))
  };
  return api;
}

function applySet(target, set) {
  Object.entries(set || {}).forEach(([key, value]) => {
    target[key] = clone(value);
  });
}

function createStore() {
  const state = {
    tournaments: [],
    federations: [],
    users: new Map(),
    dms: [],
    nextId: 1
  };

  const Tournament = {
    create: async body => {
      const doc = {
        _id: 'tourn' + state.nextId++,
        createdAt: new Date(Date.now() - state.tournaments.length * 1000),
        updatedAt: new Date(),
        rounds: [],
        champion: null,
        ...clone(body)
      };
      state.tournaments.push(doc);
      return clone(doc);
    },

    find: filter => query(state.tournaments.filter(doc => matches(doc, filter))),

    findById: id => query(state.tournaments.find(doc => String(doc._id) === String(id)) || null),

    updateOne: async (filter, update) => {
      const doc = state.tournaments.find(candidate => matches(candidate, filter));
      if (!doc) return { matchedCount: 0 };
      applySet(doc, update.$set);
      doc.updatedAt = new Date();
      return { matchedCount: 1 };
    }
  };

  const Federation = {
    add: doc => {
      state.federations.push(doc);
      return doc;
    },
    find: filter => query(state.federations.filter(doc => matches(doc, filter))),
    findById: id => query(state.federations.find(doc => String(doc._id) === String(id)) || null)
  };

  function userQuery(value) {
    return {
      select: () => userQuery(value),
      lean: () => Promise.resolve(clone(value))
    };
  }

  const User = {
    findOne: filter => userQuery(state.users.get(filter.username) || null),
    find: filter => {
      const names = filter && filter.username && filter.username.$in;
      const found = Array.from(state.users.values())
        .filter(user => !names || names.map(String).indexOf(user.username) !== -1);
      return userQuery(found);
    }
  };

  const DM = {
    create: async body => {
      const dm = { _id: 'dm' + state.nextId++, ...clone(body) };
      state.dms.push(dm);
      return clone(dm);
    }
  };

  return { state, Tournament, Federation, User, DM };
}

/* ---------------------------------------------------------------
   Fixtures
--------------------------------------------------------------- */

function addUser(store, username, extra = {}) {
  store.state.users.set(username, {
    username,
    display: username.toUpperCase(),
    federation: null,
    banned: false,
    ...extra
  });
  return store.state.users.get(username);
}

function addFederation(store, id, owner, members) {
  const doc = {
    _id: id,
    name: id === 'fedA' ? 'Iron Ring Federation' : 'Steel Cage Collective',
    owner,
    imageUrl: id === 'fedA' ? 'https://cdn.example/iron.png' : '',
    roles: [],
    members: members.map(username => ({ username, roleId: 'member' }))
  };
  store.state.federations.push(doc);
  return doc;
}

/**
 * Two federations, each with a manager and a roster, plus one member with no
 * federation at all. `boss` runs Iron Ring with `plain` (a member) and sixteen
 * wrestlers available; `rival` runs Steel Cage.
 */
function seed(overrides = {}) {
  const store = createStore();

  const ironMembers = ['boss', 'plain', 'co'];
  for (let i = 1; i <= MAX_ENTRANTS; i++) ironMembers.push('iron' + i);
  const cageMembers = ['rival'];
  for (let i = 1; i <= MAX_ENTRANTS; i++) cageMembers.push('cage' + i);

  const iron = addFederation(store, 'fedA', 'boss', ironMembers);
  const cage = addFederation(store, 'fedB', 'rival', cageMembers);

  addUser(store, 'boss', { display: 'The Boss', federation: { id: 'fedA', name: iron.name, role: 'owner' } });
  addUser(store, 'plain', { display: 'Plain Member', federation: { id: 'fedA', name: iron.name, role: 'member' } });
  addUser(store, 'co', { display: 'Co Owner', federation: { id: 'fedA', name: iron.name, role: 'co-owner' } });
  addUser(store, 'rival', { display: 'The Rival', federation: { id: 'fedB', name: cage.name, role: 'owner' } });
  addUser(store, 'stranger', { display: 'Stranger' });

  for (let i = 1; i <= MAX_ENTRANTS; i++) {
    addUser(store, 'iron' + i, { display: 'Iron ' + i, federation: { id: 'fedA', name: iron.name, role: 'member' } });
    addUser(store, 'cage' + i, { display: 'Cage ' + i, federation: { id: 'fedB', name: cage.name, role: 'member' } });
  }

  Object.entries(overrides).forEach(([username, extra]) => {
    if (store.state.users.has(username)) Object.assign(store.state.users.get(username), extra);
  });

  // Give the co-owner role its admin flag the way a real federation has it.
  iron.members.find(member => member.username === 'co').roleId = 'co-owner';

  return { store, iron, cage };
}

async function startApi(store) {
  const app = express();
  app.use(express.json());

  const requireUser = (req, res, next) => {
    const username = req.get('x-test-user');
    if (!username) return res.status(401).json({ ok: false, error: 'auth_required' });
    req.username = username;
    next();
  };

  app.use('/api/federations/tournaments', createTournamentRouter({
    Tournament: store.Tournament,
    Federation: store.Federation,
    User: store.User,
    requireUser,
    DM: store.DM,
    deliverToUser: () => {}
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

const ROSTER_IRON = Array.from({ length: MAX_ENTRANTS }, (unused, i) => 'iron' + (i + 1));
const ROSTER_CAGE = Array.from({ length: MAX_ENTRANTS }, (unused, i) => 'cage' + (i + 1));

/** Create a tournament and walk it to a locked, live bracket. */
async function startTournament(api, { iron = ROSTER_IRON, cage = ROSTER_CAGE } = {}) {
  const created = await api.call('POST', '/api/federations/tournaments', {
    user: 'boss',
    body: { opponentId: 'fedB' }
  });
  assert.equal(created.status, 201, 'the challenge was created');
  const id = created.body.tournament.id;

  const accepted = await api.call('POST', `/api/federations/tournaments/${id}/accept`, { user: 'rival' });
  assert.equal(accepted.status, 200, 'the opponent accepted');

  const mine = await api.call('PUT', `/api/federations/tournaments/${id}/roster`, {
    user: 'boss',
    body: { entrants: iron }
  });
  assert.equal(mine.status, 200);
  const theirs = await api.call('PUT', `/api/federations/tournaments/${id}/roster`, {
    user: 'rival',
    body: { entrants: cage }
  });
  assert.equal(theirs.status, 200);

  const lockedMine = await api.call('POST', `/api/federations/tournaments/${id}/ready`, {
    user: 'boss',
    body: { ready: true }
  });
  assert.equal(lockedMine.status, 200);
  assert.equal(lockedMine.body.tournament.status, 'draft', 'one locked lineup does not start it');

  const lockedTheirs = await api.call('POST', `/api/federations/tournaments/${id}/ready`, {
    user: 'rival',
    body: { ready: true }
  });
  assert.equal(lockedTheirs.status, 200);
  assert.equal(lockedTheirs.body.tournament.status, 'active', 'both locked lineups draw the bracket');

  return { id, tournament: lockedTheirs.body.tournament };
}

/* ---------------------------------------------------------------
   The bracket maths (no HTTP)
--------------------------------------------------------------- */

test('a full 16-a-side bracket is thirty-two wrestlers in five rounds', () => {
  const first = buildFirstRound(
    ROSTER_IRON.map(username => ({ username })),
    ROSTER_CAGE.map(username => ({ username }))
  );

  assert.equal(first.index, 1);
  assert.equal(first.label, 'Round of 32');
  assert.equal(first.matches.length, MAX_ENTRANTS);

  // Round one is the crossover: seed i of one side meets seed i of the other.
  first.matches.forEach((match, i) => {
    assert.equal(match.home.username, ROSTER_IRON[i]);
    assert.equal(match.home.side, 'home');
    assert.equal(match.away.username, ROSTER_CAGE[i]);
    assert.equal(match.away.side, 'away');
    assert.equal(match.winner, null);
    assert.equal(match.bye, false);
  });

  // Home wrestlers take every first-round match, then alternate so the
  // bracket shrinks one round at a time.
  let round = first;
  round.matches.forEach(match => { match.winner = 'home'; });
  const labels = [round.label];
  while (!championOf(round)) {
    round = buildNextRound(survivorsOf(round), round.index + 1);
    labels.push(round.label);
    round.matches.forEach(match => { match.winner = 'home'; });
  }

  assert.deepEqual(labels, ['Round of 32', 'Round of 16', 'Quarterfinals', 'Semifinals', 'Final']);
  assert.equal(championOf(round).username, 'iron1');
});

test('an uneven lineup gives the longer side byes into round two', () => {
  const first = buildFirstRound(
    [{ username: 'iron1' }, { username: 'iron2' }, { username: 'iron3' }],
    [{ username: 'cage1' }, { username: 'cage2' }]
  );

  assert.equal(first.matches.length, 3, 'two crossovers and one bye');
  assert.equal(first.matches[0].away.username, 'cage1');
  assert.equal(first.matches[2].bye, true);
  assert.equal(first.matches[2].home.username, 'iron3');
  assert.equal(first.matches[2].winner, 'home', 'a bye is decided when it is drawn');

  assert.equal(isRoundComplete(first), false, 'the crossovers still need results');
  first.matches[0].winner = 'home';
  first.matches[1].winner = 'away';
  assert.equal(isRoundComplete(first), true);

  assert.deepEqual(
    survivorsOf(first).map(entry => entry.username + ':' + entry.side),
    ['iron1:home', 'cage2:away', 'iron3:home']
  );

  // Three survivors: a four-slot round — one real match and one bye.
  const second = buildNextRound(survivorsOf(first), 2);
  assert.equal(second.matches.length, 2);
  assert.equal(second.matches[1].bye, true);
  assert.equal(second.label, 'Semifinals');
  assert.deepEqual(
    survivorsOf({ matches: [
      { home: second.matches[0].home, away: second.matches[0].away, winner: 'away' },
      second.matches[1]
    ] }).map(entry => entry.username),
    ['cage2', 'iron3']
  );
});

test('a finished final names the champion, and a bye can end a bracket', () => {
  const solo = { index: 1, label: 'Final', matches: [
    { id: 'r1m1', home: { username: 'iron1', side: 'home' }, away: null, winner: 'home', bye: true }
  ] };
  assert.deepEqual(championOf(solo), { username: 'iron1', side: 'home' });

  const doc = {
    status: STATUS.ACTIVE,
    rounds: [{
      index: 1,
      label: 'Final',
      matches: [
        { id: 'r1m1', home: { username: 'iron1', side: 'home' }, away: { username: 'cage1', side: 'away' }, winner: 'away' }
      ]
    }]
  };
  advance(doc);
  assert.equal(doc.status, STATUS.COMPLETE);
  assert.deepEqual(doc.champion, { username: 'cage1', side: 'away' });
  assert.ok(doc.finishedAt, 'the finish is stamped');
});

test('round labels are the standard bracket names', () => {
  assert.equal(roundLabel(1), 'Final');
  assert.equal(roundLabel(2), 'Semifinals');
  assert.equal(roundLabel(4), 'Quarterfinals');
  assert.equal(roundLabel(8), 'Round of 16');
  assert.equal(roundLabel(16), 'Round of 32');
  assert.equal(normalizeTitle('  Iron   Ring vs Steel Cage  '), 'Iron Ring vs Steel Cage');
  assert.equal(normalizeTitle('x'.repeat(200)).length, 60);
});

/* ---------------------------------------------------------------
   Creating a challenge
--------------------------------------------------------------- */

test('a tournament needs a signed-in manager with a federation', async () => {
  const { store } = seed();
  const api = await startApi(store);
  try {
    const anonymous = await api.call('POST', '/api/federations/tournaments', { body: { opponentId: 'fedB' } });
    assert.equal(anonymous.status, 401);

    const stranger = await api.call('POST', '/api/federations/tournaments', {
      user: 'stranger',
      body: { opponentId: 'fedB' }
    });
    assert.equal(stranger.status, 400);
    assert.equal(stranger.body.error, 'not_in_federation');

    const plain = await api.call('POST', '/api/federations/tournaments', {
      user: 'plain',
      body: { opponentId: 'fedB' }
    });
    assert.equal(plain.status, 403);
    assert.equal(plain.body.error, 'not_a_manager');

    const noOpponent = await api.call('POST', '/api/federations/tournaments', { user: 'boss', body: {} });
    assert.equal(noOpponent.status, 400);
    assert.equal(noOpponent.body.error, 'opponent_required');

    const self = await api.call('POST', '/api/federations/tournaments', {
      user: 'boss',
      body: { opponentId: 'fedA' }
    });
    assert.equal(self.status, 400);
    assert.equal(self.body.error, 'cannot_challenge_self');

    const ghost = await api.call('POST', '/api/federations/tournaments', {
      user: 'boss',
      body: { opponentId: 'fedZ' }
    });
    assert.equal(ghost.status, 404);
    assert.equal(ghost.body.error, 'opponent_not_found');

    assert.equal(store.state.tournaments.length, 0, 'nothing was stored');
  } finally {
    await api.close();
  }
});

test('a challenge is created pending, and the opponent owner is messaged', async () => {
  const { store } = seed();
  const api = await startApi(store);
  try {
    const res = await api.call('POST', '/api/federations/tournaments', {
      user: 'boss',
      body: { opponentId: 'fedB', title: 'Iron Ring vs Steel Cage' }
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.tournament.status, 'pending');
    assert.equal(res.body.tournament.title, 'Iron Ring vs Steel Cage');
    assert.equal(res.body.tournament.home.name, 'Iron Ring Federation');
    assert.equal(res.body.tournament.away.name, 'Steel Cage Collective');
    assert.equal(res.body.tournament.home.canManage, true, 'the challenger manages their side');
    assert.equal(res.body.tournament.away.canManage, false);
    assert.equal(res.body.tournament.viewerSide, 'home');
    assert.deepEqual(res.body.tournament.rounds, [], 'no bracket until both lineups are in');

    const stored = store.state.tournaments[0];
    assert.equal(stored.createdBy, 'boss');
    assert.equal(stored.home.federationId, 'fedA');

    const notice = store.state.dms.find(dm => dm.to === 'rival');
    assert.ok(notice, 'the challenged owner gets a direct message');
    assert.match(notice.text, /Iron Ring Federation challenged Steel Cage Collective/);
  } finally {
    await api.close();
  }
});

test('the same pair cannot start two tournaments at once, and the opponent answers once', async () => {
  const { store } = seed();
  const api = await startApi(store);
  try {
    const first = await api.call('POST', '/api/federations/tournaments', {
      user: 'boss',
      body: { opponentId: 'fedB' }
    });
    assert.equal(first.status, 201);

    const again = await api.call('POST', '/api/federations/tournaments', {
      user: 'rival',
      body: { opponentId: 'fedA' }
    });
    assert.equal(again.status, 409);
    assert.equal(again.body.error, 'tournament_exists');

    const id = first.body.tournament.id;

    // Only the challenged side answers, and only its managers.
    const home = await api.call('POST', `/api/federations/tournaments/${id}/accept`, { user: 'boss' });
    assert.equal(home.status, 403);
    assert.equal(home.body.error, 'not_the_opponent');

    const plain = await api.call('POST', `/api/federations/tournaments/${id}/accept`, { user: 'plain' });
    assert.equal(plain.status, 403);

    const accepted = await api.call('POST', `/api/federations/tournaments/${id}/accept`, { user: 'rival' });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.tournament.status, 'draft');

    const twice = await api.call('POST', `/api/federations/tournaments/${id}/accept`, { user: 'rival' });
    assert.equal(twice.status, 409);
    assert.equal(twice.body.error, 'already_answered');

    assert.ok(store.state.dms.some(dm => dm.to === 'boss' && /accepted your tournament/.test(dm.text)));
  } finally {
    await api.close();
  }
});

test('a declined challenge is closed, and nobody can revive it', async () => {
  const { store } = seed();
  const api = await startApi(store);
  try {
    const created = await api.call('POST', '/api/federations/tournaments', {
      user: 'boss',
      body: { opponentId: 'fedB' }
    });
    const id = created.body.tournament.id;

    const declined = await api.call('POST', `/api/federations/tournaments/${id}/decline`, { user: 'rival' });
    assert.equal(declined.status, 200);
    assert.equal(declined.body.tournament.status, 'declined');

    const again = await api.call('POST', `/api/federations/tournaments/${id}/accept`, { user: 'rival' });
    assert.equal(again.status, 409);

    // Declined tournaments are not "open", so the pair may try again.
    const retry = await api.call('POST', '/api/federations/tournaments', {
      user: 'boss',
      body: { opponentId: 'fedB' }
    });
    assert.equal(retry.status, 201);
  } finally {
    await api.close();
  }
});

/* ---------------------------------------------------------------
   Lineups
--------------------------------------------------------------- */

test('a lineup holds up to sixteen members of that federation, in order', async () => {
  const { store } = seed();
  const api = await startApi(store);
  try {
    const created = await api.call('POST', '/api/federations/tournaments', {
      user: 'boss',
      body: { opponentId: 'fedB' }
    });
    const id = created.body.tournament.id;

    const early = await api.call('PUT', `/api/federations/tournaments/${id}/roster`, {
      user: 'boss',
      body: { entrants: ['iron1'] }
    });
    assert.equal(early.status, 409);
    assert.equal(early.body.error, 'tournament_not_draft', 'no lineups until the challenge is accepted');

    await api.call('POST', `/api/federations/tournaments/${id}/accept`, { user: 'rival' });

    const tooMany = await api.call('PUT', `/api/federations/tournaments/${id}/roster`, {
      user: 'boss',
      body: { entrants: ROSTER_IRON.concat(['plain']) }
    });
    assert.equal(tooMany.status, 400);
    assert.equal(tooMany.body.error, 'too_many_entrants');
    assert.equal(tooMany.body.max, MAX_ENTRANTS);

    const outsider = await api.call('PUT', `/api/federations/tournaments/${id}/roster`, {
      user: 'boss',
      body: { entrants: ['iron1', 'cage1'] }
    });
    assert.equal(outsider.status, 400);
    assert.equal(outsider.body.error, 'not_a_member');
    assert.equal(outsider.body.username, 'cage1');

    const notMine = await api.call('PUT', `/api/federations/tournaments/${id}/roster`, {
      user: 'plain',
      body: { entrants: ['iron1'] }
    });
    assert.equal(notMine.status, 403);
    assert.equal(notMine.body.error, 'not_a_manager');

    const wrongSide = await api.call('PUT', `/api/federations/tournaments/${id}/roster`, {
      user: 'boss',
      body: { entrants: ['cage1'] }
    });
    assert.equal(wrongSide.status, 400);
    assert.equal(wrongSide.body.error, 'not_a_member', 'you cannot enter the other side’s wrestlers');

    const invalid = await api.call('PUT', `/api/federations/tournaments/${id}/roster`, {
      user: 'boss',
      body: { entrants: 'iron1' }
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error, 'entrants_invalid');

    // Order is the seed order, and duplicates collapse to one.
    const saved = await api.call('PUT', `/api/federations/tournaments/${id}/roster`, {
      user: 'boss',
      body: { entrants: ['iron9', 'iron2', 'iron9', { username: 'iron4' }] }
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(
      saved.body.tournament.home.entrants.map(entrant => entrant.username),
      ['iron9', 'iron2', 'iron4']
    );
    assert.deepEqual(
      saved.body.tournament.home.entrants.map(entrant => entrant.display),
      ['Iron 9', 'Iron 2', 'Iron 4'],
      'the bracket shows display names'
    );
    assert.equal(saved.body.tournament.home.count, 3);
  } finally {
    await api.close();
  }
});

test('a locked lineup is frozen, and both locks draw the bracket and start it', async () => {
  const { store } = seed();
  const api = await startApi(store);
  try {
    const created = await api.call('POST', '/api/federations/tournaments', {
      user: 'boss',
      body: { opponentId: 'fedB' }
    });
    const id = created.body.tournament.id;
    await api.call('POST', `/api/federations/tournaments/${id}/accept`, { user: 'rival' });

    const empty = await api.call('POST', `/api/federations/tournaments/${id}/ready`, {
      user: 'boss',
      body: { ready: true }
    });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.error, 'roster_empty');

    await api.call('PUT', `/api/federations/tournaments/${id}/roster`, {
      user: 'boss',
      body: { entrants: ROSTER_IRON }
    });
    const beforeAccept = await api.call('POST', `/api/federations/tournaments/${id}/ready`, {
      user: 'rival',
      body: { ready: true }
    });
    assert.equal(beforeAccept.status, 400, 'an empty lineup cannot lock in');

    const lockedMine = await api.call('POST', `/api/federations/tournaments/${id}/ready`, {
      user: 'boss',
      body: { ready: true }
    });
    assert.equal(lockedMine.status, 200);
    assert.equal(lockedMine.body.tournament.home.ready, true);

    const frozen = await api.call('PUT', `/api/federations/tournaments/${id}/roster`, {
      user: 'boss',
      body: { entrants: ['iron1'] }
    });
    assert.equal(frozen.status, 409);
    assert.equal(frozen.body.error, 'roster_locked');

    // Unlocking is allowed while the bracket has not been drawn.
    const unlocked = await api.call('POST', `/api/federations/tournaments/${id}/ready`, {
      user: 'boss',
      body: { ready: false }
    });
    assert.equal(unlocked.body.tournament.home.ready, false);
    await api.call('POST', `/api/federations/tournaments/${id}/ready`, { user: 'boss', body: { ready: true } });

    await api.call('PUT', `/api/federations/tournaments/${id}/roster`, {
      user: 'rival',
      body: { entrants: ROSTER_CAGE }
    });
    const live = await api.call('POST', `/api/federations/tournaments/${id}/ready`, {
      user: 'rival',
      body: { ready: true }
    });

    assert.equal(live.status, 200);
    assert.equal(live.body.tournament.status, 'active');
    assert.ok(live.body.tournament.startedAt);
    assert.equal(live.body.tournament.rounds.length, 1);
    assert.equal(live.body.tournament.rounds[0].matches.length, MAX_ENTRANTS);
    assert.equal(live.body.tournament.rounds[0].label, 'Round of 32');

    const first = live.body.tournament.rounds[0].matches[0];
    assert.equal(first.home.username, 'iron1');
    assert.equal(first.home.display, 'Iron 1');
    assert.equal(first.away.username, 'cage1');
    assert.equal(first.home.federationName, 'Iron Ring Federation');
    assert.equal(first.away.federationName, 'Steel Cage Collective');

    // Starts are announced to both owners.
    assert.ok(store.state.dms.filter(dm => /bracket is live/.test(dm.text)).length >= 2);
  } finally {
    await api.close();
  }
});

/* ---------------------------------------------------------------
   Reporting results
--------------------------------------------------------------- */

test('results are reported by a manager, advance the bracket, and freeze the round', async () => {
  const { store } = seed();
  const api = await startApi(store);
  try {
    const { id } = await startTournament(api, { iron: ['iron1', 'iron2'], cage: ['cage1', 'cage2'] });

    const plain = await api.call('POST', `/api/federations/tournaments/${id}/matches/r1m1`, {
      user: 'plain',
      body: { winner: 'home' }
    });
    assert.equal(plain.status, 403);
    assert.equal(plain.body.error, 'not_a_manager');

    const stranger = await api.call('POST', `/api/federations/tournaments/${id}/matches/r1m1`, {
      user: 'stranger',
      body: { winner: 'home' }
    });
    assert.equal(stranger.status, 403);

    const badWinner = await api.call('POST', `/api/federations/tournaments/${id}/matches/r1m1`, {
      user: 'boss',
      body: { winner: 'sideways' }
    });
    assert.equal(badWinner.status, 400);
    assert.equal(badWinner.body.error, 'bad_winner');

    const missing = await api.call('POST', `/api/federations/tournaments/${id}/matches/r9m9`, {
      user: 'boss',
      body: { winner: 'home' }
    });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, 'match_not_found');

    const one = await api.call('POST', `/api/federations/tournaments/${id}/matches/r1m1`, {
      user: 'boss',
      body: { winner: 'home' }
    });
    assert.equal(one.status, 200);
    assert.equal(one.body.tournament.rounds.length, 1, 'the next round waits for the whole round');
    assert.equal(one.body.tournament.rounds[0].matches[0].winner, 'home');

    const two = await api.call('POST', `/api/federations/tournaments/${id}/matches/r1m2`, {
      user: 'rival',
      body: { winner: 'away' }
    });
    assert.equal(two.body.tournament.rounds.length, 2, 'a finished round draws the next one');
    const second = two.body.tournament.rounds[1];
    assert.equal(second.label, 'Final');
    assert.equal(second.matches[0].home.username, 'iron1');
    assert.equal(second.matches[0].away.username, 'cage2');

    const frozen = await api.call('POST', `/api/federations/tournaments/${id}/matches/r1m1`, {
      user: 'boss',
      body: { winner: 'away' }
    });
    assert.equal(frozen.status, 409);
    assert.equal(frozen.body.error, 'round_locked');

    const final = await api.call('POST', `/api/federations/tournaments/${id}/matches/${second.matches[0].id}`, {
      user: 'rival',
      body: { winner: 'away' }
    });
    assert.equal(final.status, 200);
    assert.equal(final.body.tournament.status, 'complete');
    assert.equal(final.body.tournament.champion.username, 'cage2');
    assert.equal(final.body.tournament.champion.federationName, 'Steel Cage Collective');
    assert.ok(final.body.tournament.finishedAt);

    const afterwards = await api.call('POST', `/api/federations/tournaments/${id}/matches/${second.matches[0].id}`, {
      user: 'boss',
      body: { winner: 'home' }
    });
    assert.equal(afterwards.status, 409);
    assert.equal(afterwards.body.error, 'tournament_not_active');

    assert.ok(store.state.dms.some(dm => /won the Iron Ring Federation vs Steel Cage Collective/.test(dm.text)));
  } finally {
    await api.close();
  }
});

test('a bye is not a match anybody can report', async () => {
  const { store } = seed();
  const api = await startApi(store);
  try {
    const { id, tournament } = await startTournament(api, {
      iron: ['iron1', 'iron2', 'iron3'],
      cage: ['cage1']
    });

    const bye = tournament.rounds[0].matches.find(match => match.bye);
    assert.ok(bye, 'the spare wrestler got a bye');
    assert.equal(bye.winner, 'home');
    assert.equal(bye.away, null);

    const res = await api.call('POST', `/api/federations/tournaments/${id}/matches/${bye.id}`, {
      user: 'boss',
      body: { winner: 'home' }
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'match_has_no_opponent');
  } finally {
    await api.close();
  }
});

test('calling a tournament off works until the bracket starts', async () => {
  const { store } = seed();
  const api = await startApi(store);
  try {
    const created = await api.call('POST', '/api/federations/tournaments', {
      user: 'boss',
      body: { opponentId: 'fedB' }
    });
    const id = created.body.tournament.id;

    const stranger = await api.call('DELETE', `/api/federations/tournaments/${id}`, { user: 'stranger' });
    assert.equal(stranger.status, 403);

    const cancelled = await api.call('DELETE', `/api/federations/tournaments/${id}`, { user: 'boss' });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.tournament.status, 'cancelled');

    const { id: live } = await startTournament(api);
    const tooLate = await api.call('DELETE', `/api/federations/tournaments/${live}`, { user: 'boss' });
    assert.equal(tooLate.status, 409);
    assert.equal(tooLate.body.error, 'tournament_started');
  } finally {
    await api.close();
  }
});

/* ---------------------------------------------------------------
   Reading
--------------------------------------------------------------- */

test('the hub lists your federation’s tournaments and what is running elsewhere', async () => {
  const { store } = seed();
  const api = await startApi(store);
  try {
    const empty = await api.call('GET', '/api/federations/tournaments', { user: 'boss' });
    assert.equal(empty.status, 200);
    assert.equal(empty.body.federation.canManage, true);
    assert.deepEqual(empty.body.mine, []);

    const { id } = await startTournament(api);

    const asBoss = await api.call('GET', '/api/federations/tournaments', { user: 'boss' });
    assert.equal(asBoss.body.mine.length, 1);
    assert.equal(asBoss.body.mine[0].id, id);
    assert.equal(asBoss.body.mine[0].status, 'active');
    assert.deepEqual(asBoss.body.recent, [], 'your own tournament is not listed twice');

    const asOutside = await api.call('GET', '/api/federations/tournaments', { user: 'stranger' });
    assert.deepEqual(asOutside.body.mine, []);
    assert.equal(asOutside.body.federation, null);
    assert.equal(asOutside.body.recent.length, 1, 'running tournaments are public');
    assert.equal(asOutside.body.recent[0].canManage, false);
    assert.equal(asOutside.body.recent[0].canDecide, false);

    const anonymous = await api.call('GET', '/api/federations/tournaments');
    assert.equal(anonymous.status, 401);
  } finally {
    await api.close();
  }
});

test('one bracket can be opened by anybody signed in, and only exists if it exists', async () => {
  const { store } = seed();
  const api = await startApi(store);
  try {
    const { id } = await startTournament(api, { iron: ['iron1'], cage: ['cage1'] });

    const watched = await api.call('GET', `/api/federations/tournaments/${id}`, { user: 'stranger' });
    assert.equal(watched.status, 200);
    assert.equal(watched.body.tournament.home.entrants.length, 1);
    assert.equal(watched.body.tournament.viewerSide, null);

    const absent = await api.call('GET', '/api/federations/tournaments/nope', { user: 'boss' });
    assert.equal(absent.status, 404);
    assert.equal(absent.body.error, 'tournament_not_found');

    const anonymous = await api.call('GET', `/api/federations/tournaments/${id}`);
    assert.equal(anonymous.status, 401);
  } finally {
    await api.close();
  }
});

test('the serialised bracket never carries a roster it should not', () => {
  const doc = {
    _id: 'tourn1',
    status: 'draft',
    home: {
      federationId: 'fedA',
      name: 'Iron Ring Federation',
      owner: 'boss',
      entrants: [{ username: 'iron1' }],
      ready: false
    },
    away: {
      federationId: 'fedB',
      name: 'Steel Cage Collective',
      owner: 'rival',
      entrants: [],
      ready: false
    },
    rounds: [],
    champion: null
  };

  const view = serializeTournament(doc, 'boss', {
    federations: {
      fedA: { _id: 'fedA', owner: 'boss', members: [{ username: 'boss', roleId: 'owner' }], roles: [] },
      fedB: { _id: 'fedB', owner: 'rival', members: [{ username: 'rival', roleId: 'owner' }], roles: [] }
    },
    people: { iron1: { display: 'Iron 1' } },
    viewerFederationId: 'fedA'
  });

  assert.equal(view.viewerSide, 'home');
  assert.equal(view.editableSide, 'home');
  assert.equal(view.canManage, true);
  assert.equal(view.canDecide, false);
  assert.deepEqual(view.home.entrants, [{ username: 'iron1', display: 'Iron 1' }]);
  assert.equal(view.home.members, undefined, 'no member roster');
  assert.equal(view.away.canManage, false);

  // A viewer with no federation gets a read-only bracket.
  const outside = serializeTournament(doc, 'stranger', { federations: {}, people: {} });
  assert.equal(outside.viewerSide, null);
  assert.equal(outside.canManage, false);
  assert.equal(outside.editableSide, null);
});

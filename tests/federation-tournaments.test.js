/**
 * Federation tournaments — the client module, driven through a real page.
 *
 * The bracket maths is the server's job (tests/federation-tournaments-routes
 * .test.js); what is tested here is that the windows draw what the API hands
 * them, that the picker sends the lineup the owner ticked, and that pressing a
 * wrestler reports the result the manager meant.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
const PAGE = read('public', 'index.html');
const MOBILE = read('public', 'mobile.html');
const CLIENT = read('public', 'js', 'federation-tournaments.js');
const CORE = read('public', 'js', 'features-core.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Load the desktop page and the two scripts the feature needs (features-core
 * then the tournament module), signed in as `boss`. `routes` answers GETs by
 * URL and `posts` answers writes; both record what the module asked for.
 */
function startClient({ routes = {}, posts } = {}) {
  const dom = new JSDOM(PAGE, {
    url: 'https://male-cyber-fighters.test/',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const { window } = dom;
  window.localStorage.setItem('cw_session_v1', JSON.stringify({ username: 'boss', display: 'BOSS' }));
  window.eval(CORE);
  window.eval(CLIENT);

  const calls = [];
  window.MCF.getJSON = url => {
    calls.push({ method: 'GET', url });
    const answer = typeof routes === 'function' ? routes(url, calls) : routes[url];
    return Promise.resolve(answer || { ok: false, error: 'server_error' });
  };
  window.MCF.postJSON = (url, body, method) => {
    calls.push({ method: method || 'POST', url, body });
    const answer = typeof posts === 'function' ? posts(url, body, method) : { ok: true };
    return Promise.resolve(answer || { ok: false, error: 'server_error' });
  };
  return { dom, window, document: window.document, calls };
}

function entrant(username, display, side, federationName) {
  return {
    username,
    display,
    side,
    federationName: federationName || (side === 'home' ? 'Iron Ring Federation' : 'Steel Cage Collective')
  };
}

function side(key, overrides = {}) {
  const home = key === 'home';
  return {
    key,
    federationId: home ? 'fedA' : 'fedB',
    name: home ? 'Iron Ring Federation' : 'Steel Cage Collective',
    owner: home ? 'boss' : 'rival',
    imageUrl: '',
    ready: false,
    entrants: home
      ? [{ username: 'iron1', display: 'Iron 1' }, { username: 'iron2', display: 'Iron 2' }]
      : [{ username: 'cage1', display: 'Cage 1' }, { username: 'cage2', display: 'Cage 2' }],
    count: 2,
    isViewerFederation: home,
    canManage: home,
    ...overrides
  };
}

function tournamentFixture(overrides = {}) {
  return {
    id: 'tourn1',
    title: '',
    status: 'draft',
    home: side('home'),
    away: side('away'),
    rounds: [],
    roundCount: 0,
    currentRound: 0,
    champion: null,
    viewerSide: 'home',
    canManage: true,
    editableSide: 'home',
    canDecide: false,
    createdBy: 'boss',
    createdAt: '2026-02-01T00:00:00Z',
    startedAt: null,
    finishedAt: null,
    ...overrides
  };
}

const MINE = {
  ok: true,
  federation: {
    id: 'fedA',
    name: 'Iron Ring Federation',
    members: [
      { username: 'boss', display: 'The Boss' },
      { username: 'iron1', display: 'Iron 1' },
      { username: 'iron2', display: 'Iron 2' }
    ]
  }
};

/* --------------------------------------------------------------- */

test('the client module speaks the tournament API', () => {
  assert.match(CLIENT, /window\.MCFFederationTournaments/);
  assert.match(CLIENT, /MAX_ENTRANTS\s*=\s*16/);
  assert.match(CLIENT, /\/api\/federations\/tournaments/);
  assert.match(CLIENT, /\/roster/);
  assert.match(CLIENT, /\/ready/);
  assert.match(CLIENT, /\/matches\//);
  assert.match(CLIENT, /\/accept/);
  assert.match(CLIENT, /\/decline/);
});

test('both pages ship the Tournaments button and the module that binds it', () => {
  assert.equal(PAGE.match(/id="btnFederationTournaments"/g).length, 2, 'both nav copies on the desktop page');
  assert.match(PAGE, /\/js\/federation-tournaments\.js/);
  assert.match(PAGE, />Tournaments</);
  assert.match(MOBILE, /id="btnFederationTournaments"/);
  assert.match(MOBILE, /\/js\/federation-tournaments\.js/);
});

test('the hub lists your invitations, your tournaments and the challenge button', async () => {
  const invitation = tournamentFixture({
    id: 'tourn9',
    status: 'pending',
    editableSide: null,
    home: side('home', { isViewerFederation: false, canManage: false }),
    away: side('away', { isViewerFederation: true, canManage: true })
  });
  const running = tournamentFixture({
    id: 'tourn1',
    status: 'active',
    editableSide: null,
    canDecide: true,
    rounds: [{
      index: 1,
      label: 'Final',
      current: true,
      matches: [{
        id: 'r1m1',
        bye: false,
        winner: null,
        home: entrant('iron1', 'Iron 1', 'home'),
        away: entrant('cage1', 'Cage 1', 'away')
      }]
    }],
    roundCount: 1,
    currentRound: 1
  });

  const client = startClient({
    routes: () => ({
      ok: true,
      federation: { id: 'fedA', name: 'Iron Ring Federation', canManage: true },
      mine: [invitation, running],
      recent: []
    })
  });

  try {
    client.window.MCFFederationTournaments.open();
    await sleep(40);

    const body = client.document.querySelector('.mcf-modal-body');
    assert.match(body.textContent, /Iron Ring Federation/);
    assert.ok(body.querySelector('[data-tourn-challenge]'), 'a manager can challenge somebody');

    const rows = body.querySelectorAll('.mcf-tourn-row');
    assert.equal(rows.length, 2);

    const invitationRow = body.querySelector('[data-tourn-id="tourn9"]');
    assert.match(invitationRow.textContent, /Awaiting answer/);
    assert.ok(invitationRow.querySelector('[data-tourn-accept]'), 'the invitation can be accepted');
    assert.ok(invitationRow.querySelector('[data-tourn-decline]'));

    const runningRow = body.querySelector('[data-tourn-id="tourn1"]');
    assert.match(runningRow.textContent, /Bracket running/);
    assert.match(runningRow.textContent, /Final — 1 match to report/);
  } finally {
    client.dom.window.close();
  }
});

test('without a federation the hub points at Create and Join instead', async () => {
  const client = startClient({
    routes: () => ({ ok: true, federation: null, mine: [], recent: [] })
  });

  try {
    client.window.MCFFederationTournaments.open();
    await sleep(40);

    const body = client.document.querySelector('.mcf-modal-body');
    assert.match(body.textContent, /You need to run/);
    assert.ok(body.querySelector('[data-tourn-create-federation]'));
    assert.ok(body.querySelector('[data-tourn-join-federation]'));
    assert.equal(body.querySelector('[data-tourn-challenge]'), null, 'no challenge without a federation');
  } finally {
    client.dom.window.close();
  }
});

test('accepting an invitation posts to the accept endpoint and redraws the hub', async () => {
  const invitation = tournamentFixture({
    id: 'tourn9',
    status: 'pending',
    editableSide: null,
    home: side('home', { isViewerFederation: false, canManage: false }),
    away: side('away', { isViewerFederation: true, canManage: true })
  });
  let answered = false;

  const client = startClient({
    routes: () => ({
      ok: true,
      federation: { id: 'fedA', name: 'Iron Ring Federation', canManage: true },
      mine: answered ? [] : [invitation],
      recent: []
    }),
    posts: url => {
      assert.equal(url, '/api/federations/tournaments/tourn9/accept');
      answered = true;
      return { ok: true, tournament: tournamentFixture({ status: 'draft' }) };
    }
  });

  try {
    client.window.MCFFederationTournaments.open();
    await sleep(40);

    client.document.querySelector('[data-tourn-accept="tourn9"]').click();
    await sleep(60);

    assert.ok(answered, 'the invitation was accepted');
    assert.equal(client.document.querySelectorAll('.mcf-tourn-row').length, 0, 'the hub redrew');
  } finally {
    client.dom.window.close();
  }
});

test('the challenge form lists the other federations and sends the choice', async () => {
  const client = startClient({
    routes: url => (url === '/api/federations'
      ? {
        ok: true,
        membership: { id: 'fedA' },
        federations: [
          { id: 'fedA', name: 'Iron Ring Federation', owner: 'boss', memberCount: 4 },
          { id: 'fedB', name: 'Steel Cage Collective', owner: 'rival', memberCount: 2 },
          { id: 'fedC', name: '<b>Apex</b> Club', owner: 'third', memberCount: 1 }
        ]
      }
      : null),
    posts: (url, body) => {
      assert.equal(url, '/api/federations/tournaments');
      assert.equal(body.opponentId, 'fedB');
      assert.equal(body.title, 'Ring vs Cage');
      return { ok: true, tournament: tournamentFixture({ status: 'pending', editableSide: null }) };
    }
  });

  // The bracket the challenge opens needs its own GET.
  client.window.MCF.getJSON = url => {
    client.calls.push({ method: 'GET', url });
    if (url === '/api/federations') {
      return Promise.resolve({
        ok: true,
        membership: { id: 'fedA' },
        federations: [
          { id: 'fedA', name: 'Iron Ring Federation', owner: 'boss', memberCount: 4 },
          { id: 'fedB', name: 'Steel Cage Collective', owner: 'rival', memberCount: 2 },
          { id: 'fedC', name: '<b>Apex</b> Club', owner: 'third', memberCount: 1 }
        ]
      });
    }
    return Promise.resolve({ ok: true, tournament: tournamentFixture({ status: 'pending', editableSide: null }) });
  };

  try {
    client.window.MCFFederationTournaments.openChallenge();
    await sleep(40);

    const body = client.document.querySelector('.mcf-modal-body');
    const opponents = body.querySelectorAll('.mcf-tourn-opponent');
    assert.equal(opponents.length, 2, 'your own federation is not an opponent');
    assert.match(body.textContent, /Steel Cage Collective/);
    assert.match(body.textContent, /<b>Apex<\/b> Club/, 'a hostile name is escaped');
    assert.equal(body.querySelector('b'), null, 'no markup gets through');

    body.querySelector('input[value="fedB"]').checked = true;
    body.querySelector('#mcfTournTitle').value = 'Ring vs Cage';
    body.querySelector('#mcfTournSend').click();
    await sleep(60);

    assert.ok(client.calls.some(call => call.method === 'POST' && call.url === '/api/federations/tournaments'));
  } finally {
    client.dom.window.close();
  }
});

test('the draft bracket offers your own members and saves the lineup you pick', async () => {
  const picked = [];

  const client = startClient({
    routes: url => {
      if (url === '/api/federations/mine') return MINE;
      if (url.indexOf('/api/federations/tournaments/') === 0) {
        return { ok: true, tournament: tournamentFixture() };
      }
      return null;
    },
    posts: (url, body, method) => {
      picked.push({ url, body, method });
      const updated = tournamentFixture({
        home: side('home', { entrants: [{ username: 'iron1', display: 'Iron 1' }], count: 1 }),
        editableSide: null
      });
      return { ok: true, tournament: updated };
    }
  });

  try {
    client.window.MCFFederationTournaments.openBracket('tourn1');
    await sleep(60);

    const body = client.document.querySelector('.mcf-modal-body');
    assert.equal(client.document.querySelector('.mcf-modal-title').textContent, 'Iron Ring Federation vs Steel Cage Collective');

    const boxes = body.querySelectorAll('.mcf-tourn-pick input');
    assert.equal(boxes.length, 3, 'every member can be entered');
    assert.equal(body.querySelectorAll('.mcf-tourn-pick input:checked').length, 2, 'the saved lineup is already ticked');
    assert.match(body.textContent, /2 \/ 16 picked/);

    // Untick one and tick another: the picker tracks what is left.
    body.querySelector('.mcf-tourn-pick input[value="iron2"]').checked = false;
    body.querySelector('.mcf-tourn-pick input[value="iron2"]').dispatchEvent(new client.window.Event('change', { bubbles: true }));
    assert.match(body.textContent, /1 \/ 16 picked/);

    body.querySelector('[data-tourn-save]').click();
    await sleep(60);

    const save = picked.find(call => call.url.endsWith('/roster'));
    assert.ok(save, 'the lineup was saved');
    assert.equal(save.method, 'PUT');
    assert.deepEqual(JSON.parse(JSON.stringify(save.body.entrants)), ['iron1']);
  } finally {
    client.dom.window.close();
  }
});

test('locking a lineup saves it and then locks it in', async () => {
  const calls = [];

  const client = startClient({
    routes: url => {
      if (url === '/api/federations/mine') return MINE;
      return { ok: true, tournament: tournamentFixture() };
    },
    posts: (url, body, method) => {
      calls.push({ url, body, method });
      if (url.endsWith('/roster')) return { ok: true, tournament: tournamentFixture() };
      assert.ok(url.endsWith('/ready'), 'the lock follows the save');
      assert.equal(body.ready, true);
      return {
        ok: true,
        tournament: tournamentFixture({
          status: 'active',
          editableSide: null,
          canDecide: true,
          home: side('home', { ready: true }),
          away: side('away', { ready: true }),
          rounds: [{ index: 1, label: 'Final', current: true, matches: [] }]
        })
      };
    }
  });

  try {
    client.window.MCFFederationTournaments.openBracket('tourn1');
    await sleep(60);

    client.document.querySelector('[data-tourn-lock]').click();
    await sleep(80);

    assert.equal(calls.length, 2);
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0].body.entrants)), ['iron1', 'iron2']);
    assert.ok(client.document.querySelector('.mcf-tourn-bracket'), 'the bracket appeared');
  } finally {
    client.dom.window.close();
  }
});

test('a running bracket shows every round, marks winners and reports a result', async () => {
  const posted = [];
  const active = tournamentFixture({
    status: 'active',
    editableSide: null,
    canDecide: true,
    home: side('home', { ready: true }),
    away: side('away', { ready: true }),
    rounds: [
      {
        index: 1,
        label: 'Semifinals',
        current: false,
        matches: [
          {
            id: 'r1m1',
            bye: false,
            winner: 'home',
            home: entrant('iron1', 'Iron 1', 'home'),
            away: entrant('cage1', 'Cage 1', 'away')
          },
          {
            id: 'r1m2',
            bye: false,
            winner: 'away',
            home: entrant('iron2', 'Iron 2', 'home'),
            away: entrant('cage2', 'Cage 2', 'away')
          }
        ]
      },
      {
        index: 2,
        label: 'Final',
        current: true,
        matches: [
          {
            id: 'r2m1',
            bye: false,
            winner: null,
            home: entrant('iron1', 'Iron 1', 'home'),
            away: entrant('cage2', 'Cage 2', 'away')
          }
        ]
      }
    ],
    roundCount: 2,
    currentRound: 2
  });

  const client = startClient({
    routes: () => ({ ok: true, tournament: active }),
    posts: (url, body) => {
      posted.push({ url, body });
      return {
        ok: true,
        tournament: tournamentFixture({
          ...active,
          status: 'complete',
          canDecide: false,
          rounds: [active.rounds[0], {
            index: 2,
            label: 'Final',
            current: true,
            matches: [{
              id: 'r2m1',
              bye: false,
              winner: 'home',
              home: entrant('iron1', 'Iron 1', 'home'),
              away: entrant('cage2', 'Cage 2', 'away')
            }]
          }],
          champion: entrant('iron1', 'Iron 1', 'home')
        })
      };
    }
  });

  try {
    client.window.MCFFederationTournaments.openBracket('tourn1');
    await sleep(60);

    const body = client.document.querySelector('.mcf-modal-body');
    assert.equal(body.querySelectorAll('.mcf-tourn-round').length, 2);
    assert.match(body.textContent, /Semifinals/);
    assert.match(body.textContent, /Final/);

    // Results already in the books are marked and cannot be pressed again.
    const firstMatch = body.querySelector('.mcf-tourn-round .mcf-tourn-match');
    assert.ok(firstMatch.classList.contains('mcf-tourn-match-done'));
    assert.equal(firstMatch.querySelectorAll('.mcf-tourn-slot-pick').length, 0, 'an earlier round is locked');

    // The final is still open, so both wrestlers are pressable.
    const picks = body.querySelectorAll('.mcf-tourn-slot-pick');
    assert.equal(picks.length, 2);

    picks[0].click();
    await sleep(60);

    assert.equal(posted.length, 1);
    assert.equal(posted[0].url, '/api/federations/tournaments/tourn1/matches/r2m1');
    assert.deepEqual(JSON.parse(JSON.stringify(posted[0].body)), { winner: 'home' });
    assert.match(client.document.querySelector('.mcf-modal-body').textContent, /wins the tournament/);
  } finally {
    client.dom.window.close();
  }
});

test('a finished bracket names the champion and escapes a hostile name', async () => {
  const done = tournamentFixture({
    status: 'complete',
    editableSide: null,
    canDecide: false,
    champion: {
      username: 'cage1',
      display: '<img src=x onerror="alert(1)">',
      side: 'away',
      federationName: 'Steel Cage Collective'
    },
    rounds: [{
      index: 1,
      label: 'Final',
      current: true,
      matches: [{
        id: 'r1m1',
        bye: false,
        winner: 'away',
        home: entrant('iron1', 'Iron 1', 'home'),
        away: entrant('<img src=x onerror="alert(1)">', '<img src=x onerror="alert(1)">', 'away')
      }]
    }],
    roundCount: 1,
    currentRound: 1
  });

  const client = startClient({ routes: () => ({ ok: true, tournament: done }) });

  try {
    client.window.MCFFederationTournaments.openBracket('tourn1');
    await sleep(60);

    const body = client.document.querySelector('.mcf-modal-body');
    assert.equal(body.querySelector('img[src="x"]'), null, 'no markup is injected');
    assert.match(body.textContent, /<img src=x onerror=/);
    assert.ok(body.querySelector('.mcf-tourn-champion'));
    assert.match(body.textContent, /wins the tournament/);
    assert.ok(body.querySelector('.mcf-tourn-slot-win'), 'the winner is marked in the final');

    // Nothing to press once the tournament is over.
    assert.equal(body.querySelectorAll('[data-tourn-pick]').length, 0);
    assert.equal(body.querySelectorAll('.mcf-tourn-pick input').length, 0, 'no picker after the bracket');
  } finally {
    client.dom.window.close();
  }
});

test('a pending bracket offers the challenged owner an answer', async () => {
  const pending = tournamentFixture({
    status: 'pending',
    editableSide: null,
    away: side('away', { canManage: true })
  });

  const client = startClient({
    routes: () => ({ ok: true, tournament: pending }),
    posts: url => {
      assert.equal(url, '/api/federations/tournaments/tourn1/accept');
      return {
        ok: true,
        tournament: tournamentFixture({ status: 'draft' })
      };
    }
  });

  try {
    client.window.MCFFederationTournaments.openBracket('tourn1');
    await sleep(60);

    const body = client.document.querySelector('.mcf-modal-body');
    assert.match(body.textContent, /Waiting for/);
    assert.ok(body.querySelector('[data-tourn-accept]'), 'the challenged owner can accept');
    assert.ok(body.querySelector('[data-tourn-decline]'));

    body.querySelector('[data-tourn-accept]').click();
    await sleep(60);

    assert.match(client.document.querySelector('.mcf-modal-body').textContent, /Picking lineups/);
  } finally {
    client.dom.window.close();
  }
});

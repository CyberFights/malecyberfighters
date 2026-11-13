/**
 * Federation vs federation tournaments — two promotions, one bracket.
 *
 * A tournament is a challenge between two federations: the owner of one picks
 * an opponent, that opponent's owner accepts or declines it, and then each
 * owner enters up to sixteen of their own members (MAX_ENTRANTS). When both
 * lineups are locked in, the bracket builds itself and the two federations
 * fight it out round by round until one wrestler is left standing.
 *
 * The shape of a single-elimination bracket is the only rule here that is not
 * obvious, so it is spelled out:
 *
 *   • Round one is the crossover — home seed i meets away seed i, so every
 *     first-round match is one federation's wrestler against the other's. If
 *     the lineups are different sizes (5 against 3, say) the longer side's
 *     spare wrestlers get a bye and start in round two.
 *   • Every later round pairs whoever is left, in bracket order, two by two
 *     (an odd wrestler out gets a bye). Two members of the same federation
 *     can therefore meet late in the bracket — that is what elimination
 *     looks like when one side is winning.
 *   • A round's result is its matches' winners in order; when every match in
 *     a round has a winner the next round is built, and when a round leaves
 *     exactly one wrestler alive that wrestler is the champion.
 *
 * Only a manager of the federation (owner, or a role marked admin) may change
 * that side's lineup, lock it in, accept an invitation or report a result —
 * the same rule Manage uses. Results are reported by a manager of either
 * federation, because the two promotions are the only referees this site has.
 *
 * Storage is one collection, `FederationTournament`, holding both sides as
 * snapshots ({ federationId, name, owner, imageUrl, entrants }) plus the
 * rounds. Snapshots are copied at creation time so a rename mid-tournament
 * never rewrites a bracket that already happened; the display names of the
 * wrestlers themselves are looked up when the bracket is serialised, so they
 * are always current.
 *
 * Split out of federations.js like the other route modules so the bracket
 * maths can be exercised without a database — see
 * tests/federation-tournaments.test.js.
 */
'use strict';

const { canManageFederation, membershipOf } = require('./federations.js');

/** Sixteen a side: a 32-wrestler bracket, which is five rounds of fun. */
const MAX_ENTRANTS = 16;

const LIMITS = Object.freeze({
  title: 60,
  mineListed: 40,
  recentListed: 20
});

/** pending → draft → active → complete. The rest are ways out of the way. */
const STATUS = Object.freeze({
  PENDING: 'pending', // waiting for the challenged federation to answer
  DRAFT: 'draft', // accepted; both owners are picking their lineups
  ACTIVE: 'active', // both lineups locked in; the bracket is running
  COMPLETE: 'complete', // somebody won
  DECLINED: 'declined',
  CANCELLED: 'cancelled'
});

/** A tournament in one of these is still "on", so a pair cannot start twice. */
const OPEN_STATUSES = Object.freeze([STATUS.PENDING, STATUS.DRAFT, STATUS.ACTIVE]);

/* ---------------------------------------------------------------
   Cleaning
--------------------------------------------------------------- */

function cleanInline(value, max) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, max);
}

/** The optional name of the event ("Iron Ring vs Steel Cage"). */
function normalizeTitle(value) {
  return cleanInline(value, LIMITS.title);
}

/* ---------------------------------------------------------------
   The bracket
--------------------------------------------------------------- */

/** A wrestler in the bracket: who, and which federation they wrestle for. */
function entrant(username, side) {
  const name = String(username || '').trim();
  return name ? { username: name, side } : null;
}

/**
 * What a round is called, given how many matches share it:
 * one match is the final, two the semifinals, four the quarterfinals, and
 * anything else is named for the wrestlers still standing ("Round of 32").
 */
function roundLabel(matchCount) {
  const matches = Math.max(1, Number(matchCount) || 0);
  if (matches === 1) return 'Final';
  if (matches === 2) return 'Semifinals';
  if (matches === 4) return 'Quarterfinals';
  return 'Round of ' + (matches * 2);
}

/**
 * Round one: the crossovers. Home seed i wrestles away seed i; the longer
 * side's spare wrestlers get a bye so nobody is left without a match.
 *
 * `home` and `away` are the two lineups in seed order (arrays of { username }).
 */
function buildFirstRound(home, away) {
  const left = Array.isArray(home) ? home : [];
  const right = Array.isArray(away) ? away : [];
  const crossovers = Math.min(left.length, right.length);
  const matches = [];

  for (let i = 0; i < crossovers; i++) {
    matches.push({
      id: 'r1m' + (i + 1),
      home: entrant(left[i] && left[i].username, 'home'),
      away: entrant(right[i] && right[i].username, 'away'),
      winner: null,
      bye: false,
      decidedAt: null
    });
  }

  // Uneven lineups: the extra wrestlers walk into round two unopposed.
  const spare = left.length > right.length
    ? left.slice(crossovers).map(entry => entrant(entry && entry.username, 'home'))
    : right.slice(crossovers).map(entry => entrant(entry && entry.username, 'away'));

  spare.filter(Boolean).forEach((walker, index) => {
    matches.push({
      id: 'r1m' + (crossovers + index + 1),
      home: walker,
      away: null,
      winner: 'home', // a bye is decided the moment it is drawn
      bye: true,
      decidedAt: null
    });
  });

  return { index: 1, label: roundLabel(matches.length), matches };
}

/** Has every match in this round got a winner (a bye always has one)? */
function isRoundComplete(round) {
  const matches = Array.isArray(round && round.matches) ? round.matches : [];
  return matches.length > 0 && matches.every(match => !!match.winner);
}

/** Who came out of this round, in bracket order. */
function survivorsOf(round) {
  const matches = Array.isArray(round && round.matches) ? round.matches : [];
  return matches
    .map(match => {
      if (match.bye || !match.away) return match.home || null;
      if (match.winner === 'home') return match.home;
      if (match.winner === 'away') return match.away;
      return null;
    })
    .filter(Boolean);
}

/**
 * The next round: consecutive survivors meet, and an odd wrestler out gets a
 * bye. Each survivor already carries the side it wrestles for, so a late
 * match between two members of the same federation draws correctly.
 */
function buildNextRound(survivors, index) {
  const list = (Array.isArray(survivors) ? survivors : []).filter(Boolean);
  const matches = [];

  for (let i = 0; i < list.length; i += 2) {
    const home = list[i];
    const away = list[i + 1] || null;
    matches.push({
      id: 'r' + index + 'm' + (matches.length + 1),
      home,
      away,
      winner: away ? null : 'home',
      bye: !away,
      decidedAt: null
    });
  }

  return { index, label: roundLabel(matches.length), matches };
}

/** The wrestler left standing, or null while the bracket is still running. */
function championOf(round) {
  if (!isRoundComplete(round)) return null;
  const survivors = survivorsOf(round);
  return survivors.length === 1 ? survivors[0] : null;
}

/**
 * Move a tournament along after a result: a finished round grows the next
 * one, and the last wrestler standing wins. Mutates `doc`; the caller saves.
 */
function advance(doc) {
  const rounds = Array.isArray(doc.rounds) ? doc.rounds : [];
  const last = rounds[rounds.length - 1];
  if (!last || !isRoundComplete(last)) return doc;

  const survivors = survivorsOf(last);

  if (survivors.length <= 1) {
    doc.status = STATUS.COMPLETE;
    doc.champion = survivors[0] || null;
    doc.finishedAt = doc.finishedAt || new Date();
    return doc;
  }

  rounds.push(buildNextRound(survivors, rounds.length + 1));
  return doc;
}

/* ---------------------------------------------------------------
   Serialising
--------------------------------------------------------------- */

/**
 * The view of a tournament. `viewer` is the username asking (or null) and
 * `context` carries the lookups the view needs:
 *
 *   federations          id → Federation doc, so a side's managers are known
 *   people               username → { display }, so names are current
 *   viewerFederationId   the federation the viewer belongs to, if any
 *
 * Nothing here leaks a roster: the entrants are public (they are the bracket),
 * but the member lists they were picked from are not.
 */
function serializeTournament(doc, viewer, context) {
  if (!doc) return null;
  const federations = (context && context.federations) || {};
  const people = (context && context.people) || {};
  const viewerFederationId = context && context.viewerFederationId
    ? String(context.viewerFederationId)
    : '';

  const displayOf = username => {
    const person = people[String(username || '')];
    return String((person && person.display) || username || '');
  };

  const sideName = key => String((doc[key] && doc[key].name) || '');

  const entrantOut = entry => {
    if (!entry || !entry.username) return null;
    return {
      username: String(entry.username),
      display: displayOf(entry.username),
      side: entry.side === 'away' ? 'away' : 'home',
      federationName: sideName(entry.side === 'away' ? 'away' : 'home')
    };
  };

  const sideOut = key => {
    const side = doc[key] || {};
    const federationId = String(side.federationId || '');
    const federation = federations[federationId] || null;
    const entrants = (Array.isArray(side.entrants) ? side.entrants : [])
      .map(entry => ({
        username: String(entry && entry.username ? entry.username : ''),
        display: displayOf(entry && entry.username)
      }))
      .filter(entry => entry.username);

    return {
      key,
      federationId,
      name: String(side.name || ''),
      owner: String(side.owner || ''),
      imageUrl: String(side.imageUrl || ''),
      ready: !!side.ready,
      entrants,
      count: entrants.length,
      // Your side of the table, and whether you may move pieces on it.
      isViewerFederation: !!viewerFederationId && federationId === viewerFederationId,
      canManage: !!viewer && canManageFederation(federation, viewer)
    };
  };

  const home = sideOut('home');
  const away = sideOut('away');
  const viewerSide = home.isViewerFederation ? 'home' : (away.isViewerFederation ? 'away' : null);
  const canManage = home.canManage || away.canManage;
  const rounds = (Array.isArray(doc.rounds) ? doc.rounds : []).map((round, index) => ({
    index: Number(round.index) || index + 1,
    label: round.label || roundLabel((round.matches || []).length),
    current: index === (doc.rounds || []).length - 1,
    matches: (Array.isArray(round.matches) ? round.matches : []).map(match => ({
      id: String(match.id || ''),
      bye: !!match.bye,
      winner: match.winner === 'home' || match.winner === 'away' ? match.winner : null,
      decidedAt: match.decidedAt || null,
      home: entrantOut(match.home),
      away: entrantOut(match.away)
    }))
  }));

  // Which side the viewer may edit right now: theirs, while the lineups are
  // still open and they have not locked it in yet.
  let editableSide = null;
  if (doc.status === STATUS.DRAFT) {
    [home, away].forEach(side => {
      if (side.canManage && !side.ready) editableSide = side.key;
    });
  }

  const champion = doc.champion && doc.champion.username
    ? {
      username: String(doc.champion.username),
      display: displayOf(doc.champion.username),
      side: doc.champion.side === 'away' ? 'away' : 'home',
      federationName: sideName(doc.champion.side === 'away' ? 'away' : 'home')
    }
    : null;

  return {
    id: String(doc._id || doc.id),
    title: String(doc.title || ''),
    status: String(doc.status || STATUS.PENDING),
    home,
    away,
    rounds,
    roundCount: rounds.length,
    currentRound: rounds.length,
    champion,
    viewerSide,
    canManage,
    editableSide,
    canDecide: canManage && doc.status === STATUS.ACTIVE,
    createdBy: String(doc.createdBy || ''),
    createdAt: doc.createdAt || null,
    startedAt: doc.startedAt || null,
    finishedAt: doc.finishedAt || null,
    updatedAt: doc.updatedAt || null
  };
}

/* ---------------------------------------------------------------
   Routes
--------------------------------------------------------------- */

function createTournamentRouter({
  Tournament,
  Federation,
  User,
  requireUser,
  DM,
  deliverToUser
}) {
  const express = require('express');
  const router = express.Router();

  /** The signed-in member, or null. Banned accounts cannot play. */
  async function loadMember(username) {
    const user = await User.findOne({ username })
      .select('username display federation banned')
      .lean();
    if (!user || user.banned) return null;
    return user;
  }

  const loadFederation = id => (id
    ? Federation.findById(String(id)).lean()
    : Promise.resolve(null));

  /**
   * A notice to a federation's owner, sent from the other side's owner so the
   * conversation belongs to two real members (DMs are username to username,
   * never federation to federation). A notice to yourself is pointless.
   */
  async function notifyOwner(doc, toKey, fromKey, text) {
    const to = doc[toKey] && doc[toKey].owner;
    const from = doc[fromKey] && doc[fromKey].owner;
    if (!to || !from || to === from) return null;
    return deliverDM({ from, to, text, type: 'system' });
  }

  /** Save a system notice into someone's DMs. Never load-bearing. */
  async function deliverDM(fields) {
    if (!DM || typeof DM.create !== 'function') return null;
    try {
      const dm = await DM.create({ ...fields, time: new Date() });
      const payload = {
        ...(typeof dm.toObject === 'function' ? dm.toObject() : dm),
        id: String(dm._id)
      };
      if (deliverToUser) deliverToUser(fields.to, 'privateMessage', payload);
      return payload;
    } catch (err) {
      console.error('tournament dm error:', err?.message || err);
      return null;
    }
  }

  /** Which side of the table a federation sits on, or null. */
  function sideKeyFor(doc, federationId) {
    const id = String(federationId || '');
    if (!id) return null;
    if (String((doc.home && doc.home.federationId) || '') === id) return 'home';
    if (String((doc.away && doc.away.federationId) || '') === id) return 'away';
    return null;
  }

  /** The federation the member belongs to, or null. */
  async function membershipFederation(user) {
    const membership = membershipOf(user);
    if (!membership) return null;
    const doc = await loadFederation(membership.id);
    return doc ? { membership, federation: doc } : null;
  }

  /** Every federation a set of tournaments mentions, by id. */
  async function federationMap(docs) {
    const ids = [];
    docs.forEach(doc => {
      [doc.home, doc.away].forEach(side => {
        const id = side && side.federationId ? String(side.federationId) : '';
        if (id && ids.indexOf(id) === -1) ids.push(id);
      });
    });
    const map = {};
    if (!ids.length) return map;
    const found = await Federation.find({ _id: { $in: ids } })
      .select('name owner members roles imageUrl')
      .lean();
    (Array.isArray(found) ? found : []).forEach(doc => {
      map[String(doc._id)] = doc;
    });
    return map;
  }

  /** Display names for everybody the bracket mentions, in one query. */
  async function peopleMap(docs) {
    const names = [];
    const add = username => {
      const name = String(username || '');
      if (name && names.indexOf(name) === -1) names.push(name);
    };
    docs.forEach(doc => {
      [doc.home, doc.away].forEach(side => {
        (side && Array.isArray(side.entrants) ? side.entrants : []).forEach(entry => add(entry && entry.username));
      });
      (Array.isArray(doc.rounds) ? doc.rounds : []).forEach(round => {
        (round.matches || []).forEach(match => {
          add(match.home && match.home.username);
          add(match.away && match.away.username);
        });
      });
      add(doc.champion && doc.champion.username);
    });
    const map = {};
    if (!names.length) return map;
    const found = await User.find({ username: { $in: names } })
      .select('username display')
      .lean();
    (Array.isArray(found) ? found : []).forEach(person => {
      map[String(person.username)] = { display: person.display || person.username };
    });
    return map;
  }

  /** Serialise one or many tournaments with a single pair of lookups. */
  async function viewAll(docs, user) {
    const list = (Array.isArray(docs) ? docs : [docs]).filter(Boolean);
    if (!list.length) return [];
    const [federations, people] = await Promise.all([federationMap(list), peopleMap(list)]);
    const membership = user ? membershipOf(user) : null;
    const context = {
      federations,
      people,
      viewerFederationId: membership ? membership.id : ''
    };
    const viewer = user ? user.username : null;
    return list.map(doc => serializeTournament(doc, viewer, context));
  }

  async function viewOne(doc, user) {
    const [view] = await viewAll(doc, user);
    return view;
  }

  /** Write the mutable half of a tournament back. */
  async function persist(doc) {
    await Tournament.updateOne({ _id: doc._id }, {
      $set: {
        title: doc.title || '',
        status: doc.status,
        home: doc.home,
        away: doc.away,
        rounds: Array.isArray(doc.rounds) ? doc.rounds : [],
        champion: doc.champion || null,
        startedAt: doc.startedAt || null,
        finishedAt: doc.finishedAt || null,
        declinedBy: doc.declinedBy || null
      }
    });
    return doc;
  }

  /** Load a tournament and the viewer's membership in one go. */
  async function open(req) {
    const user = await loadMember(req.username);
    if (!user) return { error: { status: 403, code: 'not_allowed' } };

    const doc = await Tournament.findById(String(req.params.id)).lean().catch(() => null);
    if (!doc) return { error: { status: 404, code: 'tournament_not_found' } };

    const mine = await membershipFederation(user);
    return { user, doc, mine };
  }

  // ---------- create ----------
  // POST /api/federations/tournaments — { opponentId, title? }
  router.post('/', requireUser, async (req, res) => {
    try {
      const user = await loadMember(req.username);
      if (!user) return res.status(403).json({ ok: false, error: 'not_allowed' });

      const mine = await membershipFederation(user);
      if (!mine) return res.status(400).json({ ok: false, error: 'not_in_federation' });
      if (!canManageFederation(mine.federation, req.username)) {
        return res.status(403).json({ ok: false, error: 'not_a_manager' });
      }

      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const opponentId = String(body.opponentId || '').trim();
      if (!opponentId) return res.status(400).json({ ok: false, error: 'opponent_required' });
      if (opponentId === String(mine.federation._id)) {
        return res.status(400).json({ ok: false, error: 'cannot_challenge_self' });
      }

      const opponent = await loadFederation(opponentId);
      if (!opponent) return res.status(404).json({ ok: false, error: 'opponent_not_found' });

      // One open tournament per pair: enough to keep the bracket honest
      // without stopping a federation from challenging elsewhere.
      const open = await Tournament.find({ status: { $in: OPEN_STATUSES.slice() } })
        .select('home away status')
        .lean();
      const pair = new Set([String(mine.federation._id), String(opponent._id)]);
      const clash = (Array.isArray(open) ? open : []).find(doc => {
        const ids = new Set([
          String((doc.home && doc.home.federationId) || ''),
          String((doc.away && doc.away.federationId) || '')
        ]);
        if (ids.size !== 2) return false;
        let same = true;
        ids.forEach(id => { if (!pair.has(id)) same = false; });
        return same;
      });
      if (clash) {
        return res.status(409).json({
          ok: false,
          error: 'tournament_exists',
          tournamentId: String(clash._id)
        });
      }

      const doc = await Tournament.create({
        title: normalizeTitle(body.title),
        status: STATUS.PENDING,
        home: {
          federationId: String(mine.federation._id),
          name: mine.federation.name || '',
          owner: mine.federation.owner || '',
          imageUrl: mine.federation.imageUrl || '',
          entrants: [],
          ready: false
        },
        away: {
          federationId: String(opponent._id),
          name: opponent.name || '',
          owner: opponent.owner || '',
          imageUrl: opponent.imageUrl || '',
          entrants: [],
          ready: false
        },
        createdBy: req.username,
        rounds: [],
        champion: null
      });

      await deliverDM({
        from: req.username,
        to: opponent.owner,
        text: mine.federation.name + ' challenged ' + opponent.name +
          ' to a federation tournament. Open Federations → Tournaments to accept or decline.',
        type: 'system'
      });

      return res.status(201).json({ ok: true, tournament: await viewOne(doc, user) });
    } catch (err) {
      console.error('tournament create error:', err?.message || err);
      return res.status(500).json({ ok: false, error: 'server_error' });
    }
  });

  // ---------- the hub ----------
  // GET /api/federations/tournaments — mine, plus what is running elsewhere.
  router.get('/', requireUser, async (req, res) => {
    try {
      const user = await loadMember(req.username);
      if (!user) return res.status(403).json({ ok: false, error: 'not_allowed' });

      const mine = await membershipFederation(user);
      const myId = mine ? String(mine.federation._id) : '';

      const docs = await Tournament.find({}).sort({ createdAt: -1 }).limit(200).lean();
      const list = Array.isArray(docs) ? docs : [];

      const belongs = doc => myId && sideKeyFor(doc, myId) !== null;
      const myDocs = myId ? list.filter(belongs) : [];
      const seen = new Set(myDocs.map(doc => String(doc._id)));
      const recentDocs = list
        .filter(doc => !seen.has(String(doc._id)))
        .filter(doc => doc.status === STATUS.ACTIVE || doc.status === STATUS.COMPLETE)
        .slice(0, LIMITS.recentListed);

      const [myViews, recentViews] = await Promise.all([
        viewAll(myDocs.slice(0, LIMITS.mineListed), user),
        viewAll(recentDocs, user)
      ]);

      return res.json({
        ok: true,
        federation: mine
          ? {
            id: String(mine.federation._id),
            name: mine.federation.name || '',
            owner: mine.federation.owner || '',
            canManage: canManageFederation(mine.federation, req.username)
          }
          : null,
        mine: myViews,
        recent: recentViews
      });
    } catch (err) {
      console.error('tournament list error:', err?.message || err);
      return res.status(500).json({ ok: false, error: 'server_error', mine: [], recent: [] });
    }
  });

  // ---------- one bracket ----------
  router.get('/:id', requireUser, async (req, res) => {
    try {
      const opened = await open(req);
      if (opened.error) {
        return res.status(opened.error.status).json({ ok: false, error: opened.error.code });
      }
      return res.json({ ok: true, tournament: await viewOne(opened.doc, opened.user) });
    } catch (err) {
      console.error('tournament read error:', err?.message || err);
      return res.status(500).json({ ok: false, error: 'server_error' });
    }
  });

  // ---------- answer an invitation ----------
  router.post('/:id/accept', requireUser, async (req, res) => {
    try {
      const opened = await open(req);
      if (opened.error) {
        return res.status(opened.error.status).json({ ok: false, error: opened.error.code });
      }
      const { doc, user, mine } = opened;

      if (doc.status !== STATUS.PENDING) {
        return res.status(409).json({ ok: false, error: 'already_answered' });
      }
      if (!mine || sideKeyFor(doc, mine.federation._id) !== 'away') {
        return res.status(403).json({ ok: false, error: 'not_the_opponent' });
      }
      if (!canManageFederation(mine.federation, req.username)) {
        return res.status(403).json({ ok: false, error: 'not_a_manager' });
      }

      doc.status = STATUS.DRAFT;
      await persist(doc);

      await deliverDM({
        from: req.username,
        to: doc.home.owner,
        text: doc.away.name + ' accepted your tournament challenge. Pick up to ' +
          MAX_ENTRANTS + ' wrestlers and lock them in.',
        type: 'system'
      });

      return res.json({ ok: true, tournament: await viewOne(doc, user) });
    } catch (err) {
      console.error('tournament accept error:', err?.message || err);
      return res.status(500).json({ ok: false, error: 'server_error' });
    }
  });

  router.post('/:id/decline', requireUser, async (req, res) => {
    try {
      const opened = await open(req);
      if (opened.error) {
        return res.status(opened.error.status).json({ ok: false, error: opened.error.code });
      }
      const { doc, user, mine } = opened;

      if (doc.status !== STATUS.PENDING) {
        return res.status(409).json({ ok: false, error: 'already_answered' });
      }
      if (!mine || sideKeyFor(doc, mine.federation._id) !== 'away') {
        return res.status(403).json({ ok: false, error: 'not_the_opponent' });
      }
      if (!canManageFederation(mine.federation, req.username)) {
        return res.status(403).json({ ok: false, error: 'not_a_manager' });
      }

      doc.status = STATUS.DECLINED;
      doc.declinedBy = req.username;
      await persist(doc);

      return res.json({ ok: true, tournament: await viewOne(doc, user) });
    } catch (err) {
      console.error('tournament decline error:', err?.message || err);
      return res.status(500).json({ ok: false, error: 'server_error' });
    }
  });

  // ---------- call it off ----------
  // Only before anybody has wrestled: a running bracket is a record.
  router.delete('/:id', requireUser, async (req, res) => {
    try {
      const opened = await open(req);
      if (opened.error) {
        return res.status(opened.error.status).json({ ok: false, error: opened.error.code });
      }
      const { doc, user, mine } = opened;

      if (!mine || sideKeyFor(doc, mine.federation._id) === null) {
        return res.status(403).json({ ok: false, error: 'not_in_tournament' });
      }
      if (!canManageFederation(mine.federation, req.username)) {
        return res.status(403).json({ ok: false, error: 'not_a_manager' });
      }
      if (doc.status !== STATUS.PENDING && doc.status !== STATUS.DRAFT) {
        return res.status(409).json({ ok: false, error: 'tournament_started' });
      }

      doc.status = STATUS.CANCELLED;
      await persist(doc);
      return res.json({ ok: true, tournament: await viewOne(doc, user) });
    } catch (err) {
      console.error('tournament cancel error:', err?.message || err);
      return res.status(500).json({ ok: false, error: 'server_error' });
    }
  });

  // ---------- pick a lineup ----------
  // PUT /api/federations/tournaments/:id/roster — { entrants: [usernames] }
  router.put('/:id/roster', requireUser, async (req, res) => {
    try {
      const opened = await open(req);
      if (opened.error) {
        return res.status(opened.error.status).json({ ok: false, error: opened.error.code });
      }
      const { doc, user, mine } = opened;

      if (!mine) return res.status(403).json({ ok: false, error: 'not_in_federation' });
      const sideKey = sideKeyFor(doc, mine.federation._id);
      if (!sideKey) return res.status(403).json({ ok: false, error: 'not_in_tournament' });
      if (!canManageFederation(mine.federation, req.username)) {
        return res.status(403).json({ ok: false, error: 'not_a_manager' });
      }
      if (doc.status !== STATUS.DRAFT) {
        return res.status(409).json({ ok: false, error: 'tournament_not_draft' });
      }
      if (doc[sideKey].ready) {
        return res.status(409).json({ ok: false, error: 'roster_locked' });
      }

      const body = req.body && typeof req.body === 'object' ? req.body : {};
      if (!Array.isArray(body.entrants)) {
        return res.status(400).json({ ok: false, error: 'entrants_invalid' });
      }

      // Usernames, in the order the owner listed them (that order is the seed
      // order, so it decides who meets whom in round one).
      const wanted = [];
      body.entrants.forEach(entry => {
        const username = String(
          entry && typeof entry === 'object' ? entry.username || '' : entry || ''
        ).trim();
        if (username && wanted.indexOf(username) === -1) wanted.push(username);
      });

      if (wanted.length > MAX_ENTRANTS) {
        return res.status(400).json({ ok: false, error: 'too_many_entrants', max: MAX_ENTRANTS });
      }

      const members = new Set(
        (Array.isArray(mine.federation.members) ? mine.federation.members : [])
          .map(member => String(member && member.username || ''))
      );
      const outsider = wanted.find(username => !members.has(username));
      if (outsider) {
        return res.status(400).json({ ok: false, error: 'not_a_member', username: outsider });
      }

      doc[sideKey].entrants = wanted.map(username => ({ username }));
      await persist(doc);

      return res.json({ ok: true, tournament: await viewOne(doc, user) });
    } catch (err) {
      console.error('tournament roster error:', err?.message || err);
      return res.status(500).json({ ok: false, error: 'server_error' });
    }
  });

  // ---------- lock the lineup in ----------
  // POST /api/federations/tournaments/:id/ready — { ready: true|false }
  router.post('/:id/ready', requireUser, async (req, res) => {
    try {
      const opened = await open(req);
      if (opened.error) {
        return res.status(opened.error.status).json({ ok: false, error: opened.error.code });
      }
      const { doc, user, mine } = opened;

      if (!mine) return res.status(403).json({ ok: false, error: 'not_in_federation' });
      const sideKey = sideKeyFor(doc, mine.federation._id);
      if (!sideKey) return res.status(403).json({ ok: false, error: 'not_in_tournament' });
      if (!canManageFederation(mine.federation, req.username)) {
        return res.status(403).json({ ok: false, error: 'not_a_manager' });
      }
      if (doc.status !== STATUS.DRAFT) {
        return res.status(409).json({ ok: false, error: 'tournament_not_draft' });
      }

      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const ready = body.ready !== false;

      if (ready && !(doc[sideKey].entrants || []).length) {
        return res.status(400).json({ ok: false, error: 'roster_empty' });
      }

      doc[sideKey].ready = ready;

      // Both lineups in: draw the bracket and start the tournament.
      if (doc.home.ready && doc.away.ready) {
        if (!(doc.home.entrants || []).length || !(doc.away.entrants || []).length) {
          return res.status(400).json({ ok: false, error: 'roster_empty' });
        }
        doc.rounds = [buildFirstRound(doc.home.entrants, doc.away.entrants)];
        doc.status = STATUS.ACTIVE;
        doc.startedAt = new Date();
      }

      await persist(doc);

      if (doc.status === STATUS.ACTIVE) {
        const live = 'The bracket is live: ' + doc.home.name + ' vs ' + doc.away.name + ' — ' +
          doc.rounds[0].matches.length + ' first-round matches. Report each result from Federations → Tournaments.';
        await notifyOwner(doc, 'home', 'away', live);
        await notifyOwner(doc, 'away', 'home', live);
      }

      return res.json({ ok: true, tournament: await viewOne(doc, user) });
    } catch (err) {
      console.error('tournament ready error:', err?.message || err);
      return res.status(500).json({ ok: false, error: 'server_error' });
    }
  });

  // ---------- report a result ----------
  // POST /api/federations/tournaments/:id/matches/:matchId — { winner }
  router.post('/:id/matches/:matchId', requireUser, async (req, res) => {
    try {
      const opened = await open(req);
      if (opened.error) {
        return res.status(opened.error.status).json({ ok: false, error: opened.error.code });
      }
      const { doc, user, mine } = opened;

      if (!mine) return res.status(403).json({ ok: false, error: 'not_in_federation' });
      if (sideKeyFor(doc, mine.federation._id) === null) {
        return res.status(403).json({ ok: false, error: 'not_in_tournament' });
      }
      if (!canManageFederation(mine.federation, req.username)) {
        return res.status(403).json({ ok: false, error: 'not_a_manager' });
      }
      if (doc.status !== STATUS.ACTIVE) {
        return res.status(409).json({ ok: false, error: 'tournament_not_active' });
      }

      const rounds = Array.isArray(doc.rounds) ? doc.rounds : [];
      const current = rounds[rounds.length - 1];
      const match = current && (current.matches || [])
        .find(candidate => String(candidate.id) === String(req.params.matchId));
      if (!match) {
        // Earlier rounds are a record: their matches are already decided and
        // their winners are in the next round, so they cannot be re-run.
        const earlier = rounds.some(round => (round.matches || [])
          .some(candidate => String(candidate.id) === String(req.params.matchId)));
        return res.status(earlier ? 409 : 404).json({
          ok: false,
          error: earlier ? 'round_locked' : 'match_not_found'
        });
      }
      if (!match.away || match.bye) {
        return res.status(400).json({ ok: false, error: 'match_has_no_opponent' });
      }

      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const winner = String(body.winner || '');
      if (winner !== 'home' && winner !== 'away') {
        return res.status(400).json({ ok: false, error: 'bad_winner' });
      }

      match.winner = winner;
      match.decidedAt = new Date();

      const wasComplete = doc.status === STATUS.COMPLETE;
      advance(doc);
      await persist(doc);

      const newlyWon = !wasComplete && doc.status === STATUS.COMPLETE && doc.champion;
      if (newlyWon) {
        const winnerSide = doc.champion.side === 'away' ? 'away' : 'home';
        const loserSide = winnerSide === 'home' ? 'away' : 'home';
        await notifyOwner(
          doc,
          winnerSide,
          loserSide,
          (doc.champion.username || 'A wrestler') + ' won the ' + doc.home.name + ' vs ' +
            doc.away.name + ' tournament for ' + doc[winnerSide].name + '.'
        );
      }

      return res.json({ ok: true, tournament: await viewOne(doc, user) });
    } catch (err) {
      console.error('tournament result error:', err?.message || err);
      return res.status(500).json({ ok: false, error: 'server_error' });
    }
  });

  return { router };
}

module.exports = {
  MAX_ENTRANTS,
  LIMITS,
  STATUS,
  OPEN_STATUSES,
  normalizeTitle,
  roundLabel,
  entrant,
  buildFirstRound,
  buildNextRound,
  isRoundComplete,
  survivorsOf,
  championOf,
  advance,
  serializeTournament,
  createTournamentRouter
};

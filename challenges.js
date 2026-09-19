/**
 * Challenges — a formal "you, me, the ring, tonight" offer.
 *
 * The beginner's guide's most emphasised two minutes are the ones *before* a
 * match: agree the style, the stakes, the intensity and how it ends. Cyber
 * matches that skip that step are the ones that end in a report. A challenge
 * makes the site enforce that conversation:
 *
 *   • the challenger fills in a checklist (style, limits, stakes, finish,
 *     safeword) that must be complete before the offer can even be sent;
 *   • the opponent accepts or declines from their own DMs;
 *   • accepting creates a private room for the match and drops both fighters
 *     into it with the agreed terms pinned in the room's opening system line.
 *
 * A rematch is just a challenge pre-filled from a past match record, so
 * rivalries are one click deep.
 *
 * Split out of index.js like the other route modules — see
 * tests/challenges.test.js.
 */
'use strict';

/** Every item must be ticked before the challenge can be sent. */
const TERMS = [
  { id: 'style', label: 'Match style / length agreed' },
  { id: 'limits', label: 'Boundaries and intensity agreed' },
  { id: 'stakes', label: 'Stakes (or "no stakes") agreed' },
  { id: 'finish', label: 'How the match ends agreed' },
  { id: 'safeword', label: 'A stop signal agreed' }
];

const STATUS_VALUES = new Set(['pending', 'accepted', 'declined', 'cancelled']);

const CHALLENGE_LIMITS = {
  stakes: 200,
  note: 300
};

/**
 * Validate a new challenge.
 *
 * @returns {{ ok: boolean, challenge?: object, error?: string }}
 */
function validateChallenge(payload, matchStyles) {
  const body = payload || {};

  const styles = matchStyles.normalize(body.styles);
  if (!styles.ok) return { ok: false, error: styles.error };
  if (!styles.styles.length) {
    // "What kind of match?" is the one question a challenge exists to answer.
    return { ok: false, error: 'missing_styles' };
  }

  // The checklist. Unknown ids are dropped; every catalogue id must remain.
  const ticked = new Set(
    (Array.isArray(body.terms) ? body.terms : [])
      .map(id => String(id || '').trim())
      .filter(id => TERMS.some(term => term.id === id))
  );
  const missing = TERMS.filter(term => !ticked.has(term.id)).map(term => term.id);
  if (missing.length) {
    return { ok: false, error: 'terms_not_agreed', missing };
  }

  const bestOf = [1, 3, 5].includes(Number(body.bestOf)) ? Number(body.bestOf) : 1;

  const clean = value => String(value == null ? '' : value)
    .replace(/[\r\n\t\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return {
    ok: true,
    challenge: {
      styles: styles.styles,
      terms: TERMS.map(term => term.id),
      bestOf,
      stakes: clean(body.stakes).slice(0, CHALLENGE_LIMITS.stakes),
      note: clean(body.note).slice(0, CHALLENGE_LIMITS.note)
    }
  };
}

/** The view of a challenge a participant (or the UI) is allowed to hold. */
function serializeChallenge(challenge) {
  if (!challenge) return null;
  return {
    _id: String(challenge._id),
    from: challenge.from,
    to: challenge.to,
    status: challenge.status,
    styles: Array.isArray(challenge.styles) ? challenge.styles : [],
    terms: Array.isArray(challenge.terms) ? challenge.terms : [],
    bestOf: challenge.bestOf || 1,
    stakes: challenge.stakes || '',
    note: challenge.note || '',
    room: challenge.room ? String(challenge.room) : null,
    rematchOf: challenge.rematchOf ? String(challenge.rematchOf) : null,
    createdAt: challenge.createdAt || null,
    respondedAt: challenge.respondedAt || null
  };
}

function createChallengeRouter({
  Challenge,
  User,
  Room,
  DM,
  mongoose,
  matchStyles,
  requireUser,
  emitToUser,
  deliverToUser,
  forwardDMToDiscord,
  io,
  onAchievement
}) {
  const express = require('express');
  const router = express.Router();

  /** A system DM + a live socket event + (when offline) a push. */
  async function notify(challenge, to, text) {
    try {
      const dm = await DM.create({
        from: 'SYSTEM',
        to,
        text,
        type: 'challenge',
        challengeId: String(challenge._id),
        time: new Date()
      });
      deliverToUser(to, 'privateMessage', {
        ...dm.toObject(),
        id: String(dm._id)
      });
      const user = await User.findOne({ username: to }).lean();
      await forwardDMToDiscord('SYSTEM', user, text);
    } catch (err) {
      // A notification failure must not make an already-saved challenge fail.
      console.error('challenge notify error:', err?.message || err);
    }
  }

  const styleList = challenge =>
    (challenge.styles || []).map(id => matchStyles.label(id)).join(', ');

  // ---------- send ----------
  router.post('/', requireUser, async (req, res) => {
    const from = req.username;
    const to = String(req.body?.to || '').trim();

    if (!to || to === from) {
      return res.status(400).json({ ok: false, error: 'invalid_target' });
    }

    const validated = validateChallenge(req.body, matchStyles);
    if (!validated.ok) {
      return res.status(400).json({ ok: false, error: validated.error, ...(validated.missing ? { missing: validated.missing } : {}) });
    }

    try {
      const [fromUser, toUser] = await Promise.all([
        User.findOne({ username: from }).select('username display blockedUsers banned').lean(),
        User.findOne({ username: to }).select('username display blockedUsers banned').lean()
      ]);
      if (!toUser || toUser.banned) {
        return res.status(404).json({ ok: false, error: 'not_found' });
      }
      // A challenge across a block would just be a DM the recipient refused.
      if ((toUser.blockedUsers || []).includes(from) || (fromUser?.blockedUsers || []).includes(to)) {
        return res.status(403).json({ ok: false, error: 'blocked' });
      }

      // One live offer per direction at a time: resending replaces the old
      // one instead of stacking duplicates in the opponent's DMs.
      await Challenge.updateOne(
        { from, to, status: 'pending' },
        { $set: { status: 'cancelled', respondedAt: new Date() } }
      );

      const challenge = await Challenge.create({
        from,
        to,
        status: 'pending',
        ...validated.challenge
      });

      emitToUser(to, 'challengeReceived', serializeChallenge(challenge));
      await notify(
        challenge,
        to,
        `${from} sent you a match challenge (${styleList(challenge)}${challenge.bestOf > 1 ? `, best of ${challenge.bestOf}` : ''}). Open Challenges to respond.`
      );
      if (onAchievement) onAchievement(from, 'challenge_sent');

      return res.status(201).json({ ok: true, challenge: serializeChallenge(challenge) });
    } catch (err) {
      console.error('challenge create error:', err?.message || err);
      return res.status(500).json({ ok: false, error: 'server_error' });
    }
  });

  // ---------- respond (accept / decline) or cancel ----------
  router.post('/:id/respond', requireUser, async (req, res) => {
    const action = req.body?.action;

    try {
      const challenge = await Challenge.findById(req.params.id);
      if (!challenge) {
        return res.status(404).json({ ok: false, error: 'not_found' });
      }
      if (challenge.status !== 'pending') {
        return res.status(400).json({ ok: false, error: 'not_pending' });
      }

      if (action === 'cancel') {
        // Only the sender can withdraw their own offer.
        if (challenge.from !== req.username) {
          return res.status(403).json({ ok: false, error: 'not_your_challenge' });
        }
        challenge.status = 'cancelled';
        challenge.respondedAt = new Date();
        await challenge.save();
        emitToUser(challenge.to, 'challengeStatus', serializeChallenge(challenge));
        return res.json({ ok: true, challenge: serializeChallenge(challenge) });
      }

      // Only the member the challenge was sent to may accept or decline it.
      if (challenge.to !== req.username) {
        return res.status(403).json({ ok: false, error: 'not_your_challenge' });
      }

      if (action === 'decline') {
        challenge.status = 'declined';
        challenge.respondedAt = new Date();
        await challenge.save();
        emitToUser(challenge.from, 'challengeStatus', serializeChallenge(challenge));
        await notify(challenge, challenge.from, `${req.username} declined your match challenge.`);
        return res.json({ ok: true, challenge: serializeChallenge(challenge) });
      }

      if (action !== 'accept') {
        return res.status(400).json({ ok: false, error: 'invalid_action' });
      }

      const [fromUser, toUser] = await Promise.all([
        User.findOne({ username: challenge.from }).select('username display blockedUsers banned').lean(),
        User.findOne({ username: req.username }).select('username display blockedUsers banned').lean()
      ]);
      if (!fromUser || fromUser.banned) {
        return res.status(404).json({ ok: false, error: 'opponent_gone' });
      }
      if ((fromUser.blockedUsers || []).includes(req.username) || (toUser?.blockedUsers || []).includes(challenge.from)) {
        return res.status(403).json({ ok: false, error: 'blocked' });
      }

      // Accepting creates the match room: private, both fighters invited,
      // nobody else. The room is the arena's designated place for live
      // matches (see the site rules), so it is made for them.
      const room = await Room.create({
        name: `${fromUser.display || challenge.from} vs ${toUser.display || req.username}`,
        private: true,
        owner: challenge.from,
        invitedUsers: [challenge.from, challenge.to],
        createdAt: new Date()
      });

      challenge.status = 'accepted';
      challenge.room = room._id;
      challenge.respondedAt = new Date();
      await challenge.save();

      const termsLine =
        `Match agreed: ${styleList(challenge)}` +
        (challenge.bestOf > 1 ? `, best of ${challenge.bestOf}` : '') +
        (challenge.stakes ? `. Stakes: ${challenge.stakes}` : '') +
        (challenge.note ? `. ${challenge.note}` : '');

      const payload = {
        challenge: serializeChallenge(challenge),
        roomId: String(room._id),
        roomName: room.name,
        terms: termsLine
      };
      emitToUser(challenge.from, 'challengeAccepted', payload);
      emitToUser(challenge.to, 'challengeAccepted', payload);

      await notify(challenge, challenge.from, `${req.username} accepted your challenge. ${termsLine}`);
      await notify(challenge, challenge.to, `You accepted ${challenge.from}'s challenge. ${termsLine}`);

      try {
        io.emit('roomsList', await Room.find().lean());
      } catch (err) {
        console.error('challenge rooms broadcast error:', err?.message || err);
      }

      return res.json({
        ok: true,
        challenge: serializeChallenge(challenge),
        roomId: String(room._id),
        roomName: room.name,
        terms: termsLine
      });
    } catch (err) {
      console.error('challenge respond error:', err?.message || err);
      return res.status(500).json({ ok: false, error: 'server_error' });
    }
  });

  // ---------- my challenges ----------
  router.get('/list', requireUser, async (req, res) => {
    try {
      const challenges = await Challenge.find({
        $or: [{ from: req.username }, { to: req.username }],
        status: 'pending'
      }).sort({ createdAt: -1 }).limit(50).lean();

      const recent = await Challenge.find({
        $or: [{ from: req.username }, { to: req.username }],
        status: { $ne: 'pending' }
      }).sort({ respondedAt: -1, createdAt: -1 }).limit(20).lean();

      res.json({
        ok: true,
        incoming: challenges.filter(c => c.to === req.username).map(serializeChallenge),
        outgoing: challenges.filter(c => c.from === req.username).map(serializeChallenge),
        recent: recent.map(serializeChallenge)
      });
    } catch (err) {
      console.error('challenge list error:', err?.message || err);
      res.status(500).json({ ok: false, error: 'server_error' });
    }
  });

  return { router, validateChallenge, serializeChallenge, TERMS };
}

module.exports = {
  createChallengeRouter,
  validateChallenge,
  serializeChallenge,
  TERMS,
  STATUS_VALUES,
  CHALLENGE_LIMITS
};

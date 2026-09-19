/**
 * Match history — the record of who fought whom, when, and how it ended.
 *
 * Wins and losses used to be two numbers a member typed into their own
 * profile — no opponent, no date, no style, and no way to check any of it.
 * This module gives a match a row of its own:
 *
 *   • engine matches (the embedded HP dice engine) are recorded server-side
 *     the moment the game finishes — nothing to claim, nothing to confirm;
 *   • a member can also log a match they played outside the engine
 *     (freeform, Discord, anywhere). A logged match is *pending* until the
 *     named opponent approves it from their DMs — the same two-sided rule
 *     stories already use — and only a confirmed record moves the W/L
 *     counters;
 *   • head-to-head views fall out of the same rows, which is what makes
 *     rivalries and rematches one click instead of an archaeology dig.
 *
 * Split out of index.js like the other route modules — see
 * tests/match-history.test.js.
 */
'use strict';

const MATCH_LIMITS = {
  notes: 500
};

const RIVAL_THRESHOLD = 3; // matches against the same opponent before "rivalry"

/** Validate a member-logged match. */
function validateLoggedMatch(payload, matchStyles) {
  const body = payload || {};

  const styles = matchStyles.normalize(body.styles);
  if (!styles.ok) return { ok: false, error: styles.error };
  if (!styles.styles.length) return { ok: false, error: 'missing_styles' };

  if (body.won !== true && body.won !== false) {
    return { ok: false, error: 'missing_outcome' };
  }

  const bestOf = [1, 3, 5].includes(Number(body.bestOf)) ? Number(body.bestOf) : 1;

  const notes = String(body.notes || '')
    .replace(/[\r\n\t\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, MATCH_LIMITS.notes);

  return {
    ok: true,
    match: { styles: styles.styles, won: body.won === true, bestOf, notes }
  };
}

/** The participant-facing view of one match. */
function serializeMatch(match, viewer) {
  if (!match) return null;
  const viewerName = viewer || null;
  const isParticipant = viewerName === match.winner || viewerName === match.loser;
  const outcome = !viewerName
    ? (match.draw ? 'draw' : 'win')
    : match.draw
      ? 'draw'
      : (viewerName === match.winner ? 'win' : 'loss');

  return {
    _id: String(match._id),
    winner: match.winner || null,
    loser: match.loser || null,
    draw: !!match.draw,
    // From the viewer's seat: 'win' | 'loss' | 'draw' (null outcome only for
    // anonymous listing, which the routes never actually do).
    outcome,
    opponent: isParticipant
      ? (viewerName === match.winner ? match.loser : match.winner)
      : null,
    styles: Array.isArray(match.styles) ? match.styles : [],
    bestOf: match.bestOf || 1,
    source: match.source || 'engine',
    status: match.status || 'confirmed',
    reporter: match.reporter || null,
    room: match.room ? String(match.room) : null,
    notes: match.notes || '',
    createdAt: match.createdAt || null,
    confirmedAt: match.confirmedAt || null
  };
}

/**
 * A member's record from the rows: wins / losses / draws, plus the opponents
 * with RIVAL_THRESHOLD+ matches between them (the rivalry list).
 */
function summarize(matches, username) {
  const summary = { wins: 0, losses: 0, draws: 0, matches: 0, rivals: [] };
  const perOpponent = new Map();

  (matches || []).forEach(match => {
    if (match.status && match.status !== 'confirmed') return;
    const isWinner = match.winner === username;
    const isLoser = match.loser === username;
    if (!isWinner && !isLoser && !match.draw) return;
    if (match.draw && !(match.winner === username || match.loser === username)) return;

    summary.matches += 1;
    if (match.draw) {
      summary.draws += 1;
    } else if (isWinner) {
      summary.wins += 1;
    } else {
      summary.losses += 1;
    }

    const opponent = isWinner ? match.loser : match.winner;
    if (opponent) {
      const row = perOpponent.get(opponent) || { opponent, matches: 0, wins: 0, losses: 0 };
      row.matches += 1;
      if (match.draw) { /* draws do not feed the rivalry W/L */ }
      else if (isWinner) row.wins += 1;
      else row.losses += 1;
      perOpponent.set(opponent, row);
    }
  });

  summary.rivals = [...perOpponent.values()]
    .filter(row => row.matches >= RIVAL_THRESHOLD)
    .sort((a, b) => b.matches - a.matches)
    .slice(0, 5);

  return summary;
}

function createMatchHistoryRouter({
  MatchRecord,
  User,
  DM,
  matchStyles,
  requireUser,
  emitToUser,
  deliverToUser,
  onAchievement
}) {
  const express = require('express');
  const router = express.Router();

  /**
   * Persist a confirmed match and move both fighters' counters.
   * Shared by the engine hook (index.js) and the approval flow below, so the
   * counters can never drift from the rows.
   */
  async function recordConfirmedMatch(fields) {
    const match = await MatchRecord.create({
      ...fields,
      status: 'confirmed',
      confirmedAt: new Date()
    });

    // Draws are recorded but move no counter — there is nothing to increment.
    if (!match.draw && match.winner && match.loser) {
      await User.updateOne({ username: match.winner }, { $inc: { wins: 1 } });
      await User.updateOne({ username: match.loser }, { $inc: { losses: 1 } });
    }

    if (onAchievement) {
      onAchievement(match.winner, 'match_recorded', { match });
      onAchievement(match.loser, 'match_recorded', { match });
    }

    return match;
  }

  /** The system DM an opponent approves / declines a logged match from. */
  async function notifyOpponent(match, opponent, by) {
    try {
      const dm = await DM.create({
        from: 'SYSTEM',
        to: opponent,
        text: `${by} logged a match between you two (${(match.styles || []).map(id => matchStyles.label(id)).join(', ')} — ${match.winner === opponent ? 'you won' : 'you lost'}). Approve it to make it count.`,
        type: 'matchApproval',
        matchId: String(match._id),
        time: new Date()
      });
      deliverToUser(opponent, 'privateMessage', { ...dm.toObject(), id: String(dm._id) });
    } catch (err) {
      console.error('match notify error:', err?.message || err);
    }
  }

  // ---------- my record ----------
  router.get('/mine', requireUser, async (req, res) => {
    try {
      const matches = await MatchRecord.find({
        $or: [{ winner: req.username }, { loser: req.username }]
      }).sort({ createdAt: -1 }).limit(100).lean();

      res.json({
        ok: true,
        matches: matches.map(match => serializeMatch(match, req.username)),
        summary: summarize(matches, req.username)
      });
    } catch (err) {
      console.error('match list error:', err?.message || err);
      res.status(500).json({ ok: false, error: 'server_error' });
    }
  });

  // ---------- a member's public record ----------
  router.get('/user/:username', requireUser, async (req, res) => {
    const username = String(req.params.username || '').trim();
    try {
      const [user, matches] = await Promise.all([
        User.findOne({ username }).select('username display wins losses').lean(),
        MatchRecord.find({
          status: 'confirmed',
          $or: [{ winner: username }, { loser: username }]
        }).sort({ createdAt: -1 }).limit(50).lean()
      ]);
      if (!user) return res.status(404).json({ ok: false, error: 'not_found' });

      res.json({
        ok: true,
        user: { username: user.username, display: user.display, wins: user.wins || 0, losses: user.losses || 0 },
        matches: matches.map(match => serializeMatch(match, req.username)),
        summary: summarize(matches, username)
      });
    } catch (err) {
      console.error('match user record error:', err?.message || err);
      res.status(500).json({ ok: false, error: 'server_error' });
    }
  });

  // ---------- head-to-head ----------
  router.get('/head-to-head', requireUser, async (req, res) => {
    const other = String(req.query.with || '').trim();
    if (!other || other === req.username) {
      return res.status(400).json({ ok: false, error: 'invalid_opponent' });
    }

    try {
      const me = req.username;
      const matches = await MatchRecord.find({
        status: 'confirmed',
        $or: [
          { winner: me, loser: other },
          { winner: other, loser: me }
        ]
      }).sort({ createdAt: -1 }).limit(100).lean();

      res.json({
        ok: true,
        matches: matches.map(match => serializeMatch(match, me)),
        summary: summarize(matches, me)
      });
    } catch (err) {
      console.error('head-to-head error:', err?.message || err);
      res.status(500).json({ ok: false, error: 'server_error' });
    }
  });

  // ---------- log a match (opponent confirms) ----------
  router.post('/log', requireUser, async (req, res) => {
    const me = req.username;
    const opponent = String(req.body?.opponent || '').trim();

    if (!opponent || opponent === me) {
      return res.status(400).json({ ok: false, error: 'invalid_opponent' });
    }

    const validated = validateLoggedMatch(req.body, matchStyles);
    if (!validated.ok) {
      return res.status(400).json({ ok: false, error: validated.error });
    }

    try {
      const opponentUser = await User.findOne({ username: opponent }).select('username banned blockedUsers').lean();
      if (!opponentUser || opponentUser.banned) {
        return res.status(404).json({ ok: false, error: 'not_found' });
      }
      if ((opponentUser.blockedUsers || []).includes(me)) {
        return res.status(403).json({ ok: false, error: 'blocked' });
      }

      const match = await MatchRecord.create({
        // The reporter's claim: `won` says who the reporter thinks won, so the
        // named winner/loser follow from their seat.
        winner: validated.match.won ? me : opponent,
        loser: validated.match.won ? opponent : me,
        draw: false,
        styles: validated.match.styles,
        bestOf: validated.match.bestOf,
        notes: validated.match.notes,
        source: 'logged',
        status: 'pending',
        reporter: me,
        room: null
      });

      emitToUser(opponent, 'matchLogged', serializeMatch(match, opponent));
      await notifyOpponent(match, opponent, me);

      return res.status(201).json({ ok: true, match: serializeMatch(match, me) });
    } catch (err) {
      console.error('match log error:', err?.message || err);
      return res.status(500).json({ ok: false, error: 'server_error' });
    }
  });

  // ---------- approve / decline a logged match ----------
  router.post('/:id/respond', requireUser, async (req, res) => {
    const action = req.body?.action;

    try {
      const match = await MatchRecord.findById(req.params.id);
      if (!match) return res.status(404).json({ ok: false, error: 'not_found' });
      if (match.status !== 'pending') {
        return res.status(400).json({ ok: false, error: 'not_pending' });
      }

      // Only the member the record names as an opponent — and not the member
      // who logged it — may confirm it.
      const isOpponent = req.username === match.winner || req.username === match.loser;
      if (!isOpponent || req.username === match.reporter) {
        return res.status(403).json({ ok: false, error: 'not_your_match' });
      }
      if (action !== 'approve' && action !== 'decline') {
        return res.status(400).json({ ok: false, error: 'invalid_action' });
      }

      if (action === 'decline') {
        match.status = 'declined';
        await match.save();
        emitToUser(match.reporter, 'matchStatus', serializeMatch(match, match.reporter));
        return res.json({ ok: true, match: serializeMatch(match, req.username) });
      }

      match.status = 'confirmed';
      match.confirmedAt = new Date();
      await match.save();

      // Counters move only now — a declined claim never touched them.
      if (match.winner && match.loser) {
        await User.updateOne({ username: match.winner }, { $inc: { wins: 1 } });
        await User.updateOne({ username: match.loser }, { $inc: { losses: 1 } });
      }
      if (onAchievement) {
        onAchievement(match.winner, 'match_recorded', { match });
        onAchievement(match.loser, 'match_recorded', { match });
      }

      emitToUser(match.reporter, 'matchStatus', serializeMatch(match, match.reporter));
      return res.json({ ok: true, match: serializeMatch(match, req.username) });
    } catch (err) {
      console.error('match respond error:', err?.message || err);
      return res.status(500).json({ ok: false, error: 'server_error' });
    }
  });

  return {
    router,
    recordConfirmedMatch,
    validateLoggedMatch,
    serializeMatch,
    summarize
  };
}

module.exports = {
  createMatchHistoryRouter,
  validateLoggedMatch,
  serializeMatch,
  summarize,
  MATCH_LIMITS,
  RIVAL_THRESHOLD
};

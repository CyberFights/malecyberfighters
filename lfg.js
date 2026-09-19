/**
 * LFG — "looking for a match".
 *
 * The beginner's guide spends a whole section on *finding* an opponent, but
 * the site's only answer to it used to be "idle in the arena and hope". This
 * is the tool for it: a member flips a toggle saying they are looking, picks
 * the styles they want (pro / submission / dice / freeform / …) and shows up
 * on a live board everyone can scan — instead of both members staring at an
 * online list, each assuming the other is mid-match.
 *
 * Storage is a small sub-document on the member's own user record:
 *
 *   lfg: { looking: Boolean, styles: [id], note: String, updatedAt: Date }
 *
 * so nothing new is written when the toggle is off, and the board is one
 * indexed query rather than a scan of every member.
 *
 * Split out of index.js like the other route modules so the rules can be
 * exercised without a database — see tests/lfg.test.js.
 */
'use strict';

/**
 * Normalise an LFG status the client wants to save.
 *
 * `note` is a one-line "what I'm up for" that shows on the board; it is
 * capped (a board is for scanning, not essays) and stripped of control
 * characters, but NOT html-escaped here — the client escapes on render and
 * the server escapes again when the note is relayed anywhere.
 *
 * @returns {{ ok: boolean, status?: object, error?: string }}
 */
function normalizeStatus(payload, matchStyles) {
  const body = payload || {};

  const looking = body.looking === true || body.looking === 'true';

  const styles = matchStyles.normalize(body.styles);
  if (!styles.ok) return { ok: false, error: styles.error };

  let note = '';
  if (typeof body.note === 'string') {
    note = body.note
      // strip control characters (newlines would break the one-line board row)
      .replace(/[\r\n\t\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, 140);
  }

  return {
    ok: true,
    status: {
      looking,
      styles: looking ? styles.styles : [],
      // A note with nobody looking is a stale note — drop it with the toggle.
      note: looking ? note : '',
      updatedAt: new Date()
    }
  };
}

/**
 * The board view of one member's LFG status. Only the fields a public board
 * row needs — never the whole user document.
 */
function boardEntry(user) {
  const lfg = user && user.lfg;
  if (!lfg || !lfg.looking) return null;
  return {
    username: user.username,
    display: user.display || user.username,
    imageUrl: user.imageUrl || null,
    color: user.color || null,
    online: !!user.online,
    lastSeenAt: user.lastSeenAt || null,
    styles: Array.isArray(lfg.styles) ? lfg.styles : [],
    note: typeof lfg.note === 'string' ? lfg.note : '',
    updatedAt: lfg.updatedAt || null,
    height: user.height || null,
    weight: user.weight ?? null
  };
}

/**
 * Build the LFG router.
 *
 * @param {object} deps
 * @param {object} deps.User        mongoose model
 * @param {object} deps.matchStyles the shared catalogue (public/js/match-styles.js)
 * @param {function} deps.requireUser session middleware
 * @param {function} deps.broadcast  re-announce the board to every live client
 */
function createLfgRouter({ User, matchStyles, requireUser, broadcast }) {
  const express = require('express');
  const router = express.Router();

  /** Everyone currently looking, newest status first. */
  async function board() {
    const users = await User.find({ 'lfg.looking': true })
      .select('username display imageUrl color online lastSeenAt lfg height weight')
      .sort({ 'lfg.updatedAt': -1 })
      .lean();
    return users.map(boardEntry).filter(Boolean);
  }

  async function broadcastBoard() {
    try {
      const entries = await board();
      broadcast(entries);
      return entries;
    } catch (err) {
      // A board refresh failure must not fail the save it accompanies.
      console.error('lfg board broadcast error:', err?.message || err);
      return null;
    }
  }

  // The board itself. Public to signed-in members (it is the roster's
  // "who wants to fight right now" companion, and names no private data),
  // but not to anonymous visitors — it is a member-facing tool.
  router.get('/board', requireUser, async (req, res) => {
    try {
      res.json({ ok: true, entries: await board() });
    } catch (err) {
      console.error('lfg board error:', err?.message || err);
      res.status(500).json({ ok: false, error: 'server_error' });
    }
  });

  // Flip (or clear) the caller's own status. Whose status this sets comes
  // from the session — a body-supplied username would let anyone toggle
  // anyone else's flag.
  router.post('/status', requireUser, async (req, res) => {
    const normalized = normalizeStatus(req.body, matchStyles);
    if (!normalized.ok) {
      return res.status(400).json({ ok: false, error: normalized.error });
    }

    try {
      // upsert-style write: first query, then updateOne (User model may have
      // validators that make findOneAndUpdate + setOnInsert awkward).
      const user = await User.findOne({ username: req.username }).select('username lfg');
      if (!user) {
        return res.status(404).json({ ok: false, error: 'not_found' });
      }

      const update = {};
      for (const [key, value] of Object.entries(normalized.status)) {
        update[`lfg.${key}`] = value;
      }
      await User.updateOne({ username: req.username }, { $set: update });

      await broadcastBoard();
      return res.json({ ok: true, status: normalized.status });
    } catch (err) {
      console.error('lfg status error:', err?.message || err);
      res.status(500).json({ ok: false, error: 'server_error' });
    }
  });

  return { router, board, broadcastBoard, normalizeStatus, boardEntry };
}

module.exports = { createLfgRouter, normalizeStatus, boardEntry };

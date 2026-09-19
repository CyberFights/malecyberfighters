/**
 * Reactions — emoji under a chat message.
 *
 * One reaction per member per message: setting a new emoji replaces the old
 * one, setting the same one again removes it (a toggle, like every chat app
 * members already know). The toggle is resolved server-side so two tabs of
 * the same member can never stack two reactions, and the broadcast carries
 * the *resulting* counts plus the actor's own emoji so every client renders
 * the same state without re-fetching.
 *
 * Reactions are ephemeral metadata, not content: they ride on message ids
 * and are swept by the same retention windows as the messages they belong
 * to (see retention wiring in index.js).
 */
'use strict';

/**
 * The allowed emoji. A closed set, not a free string: a reaction is stored
 * per-emoji and rendered as a count next to the glyph, so an arbitrary
 * string would be an XSS-shaped hole and an unbounded aggregation key.
 */
const ALLOWED_EMOJI = ['👍', '❤️', '😂', '😮', '😢', '🔥', '💪', '😡'];

const isAllowedEmoji = emoji =>
  typeof emoji === 'string' && ALLOWED_EMOJI.includes(emoji);

/**
 * Resolve a setReaction request into the database operation to perform.
 *
 * @param {object} args
 * @param {string} args.current  the emoji the actor already has on this message ('' if none)
 * @param {string} args.emoji    the emoji being set ('' / null removes)
 * @returns {{ op: 'remove' } | { op: 'set', emoji: string } | { op: 'none' } | { op: 'invalid' }}
 *          'none' = clicking the emoji you already had = remove is NOT needed
 *          when the client already treats it as a toggle... no: clicking your
 *          own reaction removes it, so same-emoji → remove. 'none' is only the
 *          no-op when there is nothing to remove.
 */
function resolveToggle({ current, emoji }) {
  if (emoji == null || emoji === '') {
    return current ? { op: 'remove' } : { op: 'none' };
  }
  if (!isAllowedEmoji(emoji)) return { op: 'invalid' };
  if (current === emoji) return { op: 'remove' };
  return { op: 'set', emoji };
}

/**
 * Aggregate raw reaction rows into the broadcast shape.
 *
 * @param {Array<{emoji: string, username: string}>} rows
 * @returns {{ counts: Object<string, number>, byUser: Object<string, string> }}
 */
function aggregate(rows) {
  const counts = {};
  const byUser = {};
  (rows || []).forEach(row => {
    if (!row || !isAllowedEmoji(row.emoji)) return;
    counts[row.emoji] = (counts[row.emoji] || 0) + 1;
    byUser[row.username] = row.emoji;
  });
  return { counts, byUser };
}

/** The scope of a message: 'public' (arena) or 'room' (custom rooms). */
const SCOPES = new Set(['public', 'room']);

/** Validate the addressing parts of a reaction request. */
function validTarget({ scope, room, messageId }) {
  if (!SCOPES.has(scope)) return false;
  if (scope === 'room' && !room) return false;
  return !!messageId;
}

function createReactionsRouter({ Reaction, requireUser, io }) {
  const express = require('express');
  const router = express.Router();

  /**
   * Counts for a page of already-rendered messages. The client loads history
   * first, then asks for the reactions of everything on screen in one call —
   * one request per feed, not one per message.
   */
  router.get('/', requireUser, async (req, res) => {
    const scope = String(req.query.scope || '');
    const room = String(req.query.room || '');
    const ids = String(req.query.ids || '')
      .split(',')
      .map(id => id.trim())
      .filter(Boolean)
      .slice(0, 250);

    if (!SCOPES.has(scope) || (scope === 'room' && !room) || !ids.length) {
      return res.json({ ok: true, reactions: {} });
    }

    try {
      const filter = { scope, messageId: { $in: ids } };
      if (scope === 'room') filter.room = String(room);
      const rows = await Reaction.find(filter).select('messageId emoji username').lean();

      const reactions = {};
      rows.forEach(row => {
        const key = row.messageId;
        if (!reactions[key]) reactions[key] = { counts: {}, byUser: {} };
        reactions[key].counts[row.emoji] = (reactions[key].counts[row.emoji] || 0) + 1;
        reactions[key].byUser[row.username] = row.emoji;
      });

      res.json({ ok: true, reactions });
    } catch (err) {
      console.error('reactions list error:', err?.message || err);
      res.status(500).json({ ok: false, error: 'server_error' });
    }
  });

  return { router };
}

module.exports = {
  ALLOWED_EMOJI,
  SCOPES,
  isAllowedEmoji,
  resolveToggle,
  aggregate,
  validTarget,
  createReactionsRouter
};

/**
 * Mentions — @name in a chat message that actually pings.
 *
 * Extraction is deliberately cheap and conservative:
 *
 *   • a mention is an @ followed by the username character set the register
 *     route already allows (letters, digits, `_`, `.`, `-`) — no spaces, no
 *     unicode, because usernames themselves allow none of those;
 *   • the token is matched against the database case-insensitively, so
 *     @Jax pings jax;
 *   • a sender never mentions themselves, and a member who has blocked the
 *     sender is never pinged by them — a mention is a notification, and a
 *     blocked member must not be able to notify.
 *
 * Split out so the parser is testable on its own — see tests/mentions.test.js.
 */
'use strict';

const MENTION_RE = /@([A-Za-z0-9._-]{2,32})/g;

/**
 * Pull candidate usernames out of a message text.
 * @returns {string[]} unique tokens, lowercased, in order of first appearance
 */
function extractMentionTokens(text) {
  const raw = String(text || '');
  const seen = new Set();
  const tokens = [];

  let match;
  MENTION_RE.lastIndex = 0;
  while ((match = MENTION_RE.exec(raw)) !== null) {
    const token = match[1].toLowerCase();
    if (!seen.has(token)) {
      seen.add(token);
      tokens.push(token);
    }
  }

  return tokens;
}

/**
 * Resolve which members a message actually mentions.
 *
 * @param {object} args
 * @param {string} args.text  the message text
 * @param {string} args.from  the sender's username (never mentioned)
 * @param {object} args.User  mongoose model (username, blockedUsers)
 * @returns {Promise<string[]>} usernames that should be pinged
 */
async function resolveMentions({ text, from, User }) {
  const tokens = extractMentionTokens(text);
  if (!tokens.length) return [];

  const loweredFrom = String(from || '').toLowerCase();

  try {
    // One query for every candidate in the message — a message naming six
    // members is still one database round-trip.
    const users = await User.find({ username: { $in: tokens } })
      .select('username blockedUsers')
      .lean();

    return users
      .filter(user => {
        if (!user || !user.username) return false;
        if (user.username.toLowerCase() === loweredFrom) return false; // self
        // A member who blocked the sender must not be pinged by them — a
        // mention is a notification, and the block exists to stop those.
        if ((user.blockedUsers || []).includes(from)) return false;
        return true;
      })
      .map(user => user.username);
  } catch (err) {
    console.error('mention resolve error:', err?.message || err);
    return [];
  }
}

module.exports = { extractMentionTokens, resolveMentions, MENTION_RE };

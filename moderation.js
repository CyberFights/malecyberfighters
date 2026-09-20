/**
 * Moderation — the rules behind the staff tools.
 *
 * Members holding the `moderator` or `admin` role (see roles.js), and the
 * Administrator account, can delete messages, warn members and time members
 * out of sending messages. The authority ladder and the "who may act on
 * whom" rule live in roles.js; this module owns the shape of each action:
 * what a valid warning looks like, and how a timeout duration is parsed and
 * clamped. Split out so the rules run under tests without a server, the same
 * way roles.js and reports.js do — the socket handlers in index.js stay thin.
 */
'use strict';

const roles = require('./roles');

/** Shortest timeout the tools allow: one minute. */
const TIMEOUT_MIN_SECONDS = 60;

/** Longest timeout: thirty days. Anything longer is a ban, and bans exist. */
const TIMEOUT_MAX_SECONDS = 30 * 24 * 60 * 60;

/** The preset durations offered by the timeout dialog, in seconds. */
const TIMEOUT_PRESETS = [
  { id: '5m', seconds: 5 * 60 },
  { id: '30m', seconds: 30 * 60 },
  { id: '1h', seconds: 60 * 60 },
  { id: '24h', seconds: 24 * 60 * 60 },
  { id: '7d', seconds: 7 * 24 * 60 * 60 }
];

/** A member's warning record is capped so it cannot grow without bound. */
const MAX_STORED_WARNINGS = 100;

/** Free-text reason cap — long enough to explain, short enough to stay a note. */
const MAX_WARNING_REASON_LENGTH = 500;

/**
 * Parse a requested timeout duration into whole seconds.
 *
 * Accepts numbers, numeric strings and preset ids ("5m", "1h", …). Returns:
 *   - `0`  when the value asks to lift a timeout (0, "0", "lift", empty);
 *   - the clamped positive seconds otherwise;
 *   - `null` when the value is not a duration at all.
 */
function normalizeTimeoutSeconds(value) {
  if (value === undefined || value === null || value === '') return 0;

  if (typeof value === 'string') {
    const word = value.trim().toLowerCase();
    if (word === 'lift' || word === 'none' || word === 'clear') return 0;
    const preset = TIMEOUT_PRESETS.find(p => p.id === word);
    if (preset) return preset.seconds;
    if (!/^-?\d+(\.\d+)?$/.test(word)) return null;
    value = Number(word);
  }

  if (typeof value !== 'number' || !isFinite(value)) return null;

  if (value <= 0) return 0; // lift
  return Math.min(Math.max(Math.round(value), TIMEOUT_MIN_SECONDS), TIMEOUT_MAX_SECONDS);
}

/**
 * Decide whether one warning may be recorded.
 *
 * @param {object} params
 * @param {object|string} params.actor  `{ username, role }` of the staff member
 * @param {object|string} params.target `{ username, role }` of the member warned
 * @param {string} params.reason        free-text reason (may be empty)
 * @returns {{ ok: true, targetUsername: string, reason: string } |
 *           { ok: false, error: string }}
 */
function validateWarning({ actor, target, reason } = {}) {
  const actorUser = typeof actor === 'string' ? { username: actor } : actor;
  const targetUser = typeof target === 'string' ? { username: target } : target;

  const targetUsername = String((targetUser && targetUser.username) || '').trim();
  if (!targetUsername) {
    return { ok: false, error: 'missing_target' };
  }

  if (!roles.canModerateUser(actorUser, targetUser)) {
    return { ok: false, error: 'not_allowed' };
  }

  const cleanedReason = String(reason == null ? '' : reason).trim().slice(0, MAX_WARNING_REASON_LENGTH);

  return { ok: true, targetUsername, reason: cleanedReason };
}

/**
 * Decide whether a timeout may be applied (or lifted).
 *
 * @param {object} params
 * @param {object|string} params.actor   `{ username, role }` of the staff member
 * @param {object|string} params.target  `{ username, role }` of the member timed out
 * @param {number|string} params.seconds duration, preset id, or 0/"lift" to clear
 * @returns {{ ok: true, targetUsername: string, seconds: number } |
 *           { ok: false, error: string }}
 */
function validateTimeout({ actor, target, seconds } = {}) {
  const actorUser = typeof actor === 'string' ? { username: actor } : actor;
  const targetUser = typeof target === 'string' ? { username: target } : target;

  const targetUsername = String((targetUser && targetUser.username) || '').trim();
  if (!targetUsername) {
    return { ok: false, error: 'missing_target' };
  }

  // Lifting a timeout is a kindness, but it is still a moderation power:
  // the same authority rules apply.
  if (!roles.canModerateUser(actorUser, targetUser)) {
    return { ok: false, error: 'not_allowed' };
  }

  const normalized = normalizeTimeoutSeconds(seconds);
  if (normalized === null) {
    return { ok: false, error: 'invalid_duration' };
  }

  return { ok: true, targetUsername, seconds: normalized };
}

module.exports = {
  TIMEOUT_MIN_SECONDS,
  TIMEOUT_MAX_SECONDS,
  TIMEOUT_PRESETS,
  MAX_STORED_WARNINGS,
  MAX_WARNING_REASON_LENGTH,
  normalizeTimeoutSeconds,
  validateWarning,
  validateTimeout
};

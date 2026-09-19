/**
 * Notification preferences + quiet hours.
 *
 * Push used to be all-or-nothing and DM-shaped: the only notification the
 * site sent was "new direct message", to every device, at any hour. Now the
 * server can ping for mentions, story approvals, forum replies, match turns
 * and challenges too — which is exactly why each of those needs its own
 * off-switch, and why there needs to be a "not at 3am" switch.
 *
 * The rules live here (not in pushNotifications.js) so they can be exercised
 * without any push plumbing — see tests/notification-prefs.test.js.
 */
'use strict';

/** The notification kinds a member can switch off, with their defaults. */
const KINDS = {
  dm: true,
  system: true,
  mention: true,
  story: true,
  forum: true,
  match: true,
  challenge: true
};

/**
 * Normalise a preferences payload off the wire.
 *
 * Unknown keys are dropped (a cached page from before a kind existed must
 * not fail the save); a missing key keeps its default rather than silently
 * switching everything off.
 *
 * @returns {{ ok: boolean, prefs?: object, error?: string }}
 */
function normalizePrefs(payload) {
  const body = payload || {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'invalid_prefs' };
  }

  const prefs = {};
  for (const [kind, defaultValue] of Object.entries(KINDS)) {
    if (body[kind] === undefined) {
      prefs[kind] = defaultValue;
      continue;
    }
    if (typeof body[kind] !== 'boolean') {
      return { ok: false, error: 'invalid_prefs' };
    }
    prefs[kind] = body[kind];
  }

  return { ok: true, prefs };
}

/**
 * Normalise quiet hours. Hours are whole numbers 0–23 in the *server's*
 * local timezone (documented in the UI); `start` may be after `end`, which
 * means the quiet window crosses midnight (22 → 8).
 *
 * @returns {{ ok: boolean, quiet?: { enabled: boolean, start: number, end: number }, error?: string }}
 */
function normalizeQuietHours(payload) {
  const body = payload || {};

  if (body.enabled === undefined && body.start === undefined && body.end === undefined) {
    return { ok: true, quiet: { enabled: false, start: 22, end: 8 } };
  }

  const enabled = body.enabled === true || body.enabled === 'true';
  const start = Number(body.start);
  const end = Number(body.end);

  if (!Number.isInteger(start) || !Number.isInteger(end) ||
      start < 0 || start > 23 || end < 0 || end > 23) {
    return { ok: false, error: 'invalid_quiet_hours' };
  }

  return { ok: true, quiet: { enabled, start, end } };
}

/** Read a member's stored prefs with defaults for anything missing. */
function effectivePrefs(user) {
  const stored = (user && user.notificationPrefs) || {};
  const prefs = {};
  for (const [kind, defaultValue] of Object.entries(KINDS)) {
    prefs[kind] = typeof stored[kind] === 'boolean' ? stored[kind] : defaultValue;
  }
  return prefs;
}

/** Read a member's stored quiet hours with defaults for anything missing. */
function effectiveQuietHours(user) {
  const stored = (user && user.quietHours) || {};
  const start = Number.isInteger(stored.start) && stored.start >= 0 && stored.start <= 23
    ? stored.start : 22;
  const end = Number.isInteger(stored.end) && stored.end >= 0 && stored.end <= 23
    ? stored.end : 8;
  return { enabled: stored.enabled === true, start, end };
}

/**
 * Whether an hour of the day falls inside a quiet window. A window that
 * crosses midnight (22 → 8) covers 22, 23, 0, … 8; the endpoints count as
 * inside (22:00 to 08:00 means the push at 22:00 stays silent).
 */
function hourIsQuiet(hour, { start, end }) {
  if (start === end) return true; // degenerate window = always quiet? No —
  // a member who sets 22→22 means "22:00 to 22:00", i.e. the whole day, and
  // the UI says so; treating it as "never" would be the surprising read.
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

/**
 * The gate every push passes through.
 *
 * @param {object} args
 * @param {string} args.kind      notification kind (dm / mention / …)
 * @param {object} args.user      the recipient's document
 * @param {Date}   [args.now]     injectable clock
 * @returns {boolean} false = do not send this push
 */
function shouldPush({ kind, user, now = new Date() }) {
  const prefs = effectivePrefs(user);
  // An unknown kind defaults to allowed — new notification types should not
  // be silently swallowed by older stored prefs.
  if (prefs[kind] === false) return false;

  const quiet = effectiveQuietHours(user);
  if (quiet.enabled && hourIsQuiet(now.getHours(), quiet)) return false;

  return true;
}

module.exports = {
  KINDS,
  normalizePrefs,
  normalizeQuietHours,
  effectivePrefs,
  effectiveQuietHours,
  hourIsQuiet,
  shouldPush
};

/**
 * Roles — the tiers of trust a member account can hold.
 *
 * Every account starts as a plain `user`. The Administrator account — the
 * site's root account, username `Administrator` — can promote other members
 * to `moderator` or `admin` (and demote them back to `user`) through
 * POST /api/admin/set-role. The rules for that change live here so they can
 * run under tests without a server, the same way reports.js and lfg.js do.
 *
 * The `Administrator` account itself sits outside the ladder: it is the only
 * account allowed to hand roles out, and it can never be re-roled, demoted
 * or locked out of its own power by a role change.
 */
'use strict';

/** The root account. Role assignment is its prerogative; it is never the target. */
const ADMIN_USERNAME = 'Administrator';

/** The tiers of trust, lowest first. `user` is what every registration gets. */
const ROLES = [
  { id: 'user', label: 'Member' },
  { id: 'moderator', label: 'Moderator' },
  { id: 'admin', label: 'Admin' }
];

const ROLE_IDS = ROLES.map(role => role.id);

/** What the schema defaults to and what an unknown value falls back to in display. */
const DEFAULT_ROLE = 'user';

/**
 * Normalise a raw role value to one of the catalogue ids. Accepts any case
 * and surrounding whitespace (so "Admin" or " moderator " both work) and
 * returns null for anything the catalogue does not know.
 */
function normalizeRole(value) {
  const role = String(value == null ? '' : value).trim().toLowerCase();
  return ROLE_IDS.includes(role) ? role : null;
}

function isKnownRole(value) {
  return normalizeRole(value) !== null;
}

/**
 * The moderation tiers: members holding one of these roles may delete
 * messages, warn members and time members out (see moderation.js). The
 * `Administrator` account counts even without a role value.
 */
function isStaffRole(value) {
  const id = normalizeRole(value);
  return id === 'moderator' || id === 'admin';
}

/**
 * Moderation authority decides who may act on whom. The ladder:
 *
 *   4  the Administrator account (root — never a moderation target)
 *   3  role `admin`
 *   2  role `moderator`
 *   1  plain member
 *   0  anything unrecognised
 *
 * A moderation action is allowed only when the actor outranks the target
 * strictly, so moderators cannot discipline admins, admins cannot discipline
 * the Administrator account, and nobody moderates themselves.
 */
function moderationAuthority(user) {
  if (!user || typeof user !== 'object' || !user.username) return 0;
  if (isAdministratorAccount(user.username)) return 4;
  const id = normalizeRole(user.role);
  if (id === 'admin') return 3;
  if (id === 'moderator') return 2;
  // A named account with a missing or unrecognised role value is still a
  // plain member — the schema defaults everyone to `user`.
  return 1;
}

/**
 * Whether `actor` may moderate `target` at all. Both are `{ username, role }`
 * shapes (a bare username string is accepted for either side, treated as a
 * plain member).
 */
function canModerateUser(actor, target) {
  const actorUser = typeof actor === 'string' ? { username: actor } : actor;
  const targetUser = typeof target === 'string' ? { username: target } : target;
  const actorAuthority = moderationAuthority(actorUser);
  // Only moderators and up hold the tools, and the target must exist below
  // the actor on the ladder.
  return actorAuthority >= 2 && actorAuthority > moderationAuthority(targetUser);
}

/** Display label for a role; unknown and empty values read as the default. */
function roleLabel(value) {
  const id = normalizeRole(value) || DEFAULT_ROLE;
  return ROLES.find(role => role.id === id).label;
}

/**
 * The Administrator account is matched case-insensitively and trimmed, the
 * same way the client-side `isAdministratorUser` helper matches it, so the
 * server and the UI agree on who holds the root account.
 */
function isAdministratorAccount(username) {
  return String(username || '').trim().toLowerCase() === ADMIN_USERNAME.toLowerCase();
}

/**
 * Decide whether one role change may happen.
 *
 * @param {object} params
 * @param {string} params.actorUsername  signed-in account asking for the change
 * @param {string} params.targetUsername member whose role would change
 * @param {string} params.role           requested new role
 * @returns {{ ok: true, targetUsername: string, role: string } |
 *           { ok: false, error: string }}
 */
function validateRoleChange({ actorUsername, targetUsername, role } = {}) {
  // Only the Administrator account hands roles out. Holding the `admin` role
  // is a badge of trust, not a key to this endpoint.
  if (!isAdministratorAccount(actorUsername)) {
    return { ok: false, error: 'admin_account_required' };
  }

  const target = String(targetUsername || '').trim();
  if (!target) {
    return { ok: false, error: 'missing_username' };
  }

  // The root account cannot be re-roled — demoting it would strand the only
  // account that can assign roles at all.
  if (isAdministratorAccount(target)) {
    return { ok: false, error: 'cannot_modify_administrator' };
  }

  const normalized = normalizeRole(role);
  if (!normalized) {
    return { ok: false, error: 'invalid_role' };
  }

  return { ok: true, targetUsername: target, role: normalized };
}

module.exports = {
  ADMIN_USERNAME,
  ROLES,
  ROLE_IDS,
  DEFAULT_ROLE,
  normalizeRole,
  isKnownRole,
  isStaffRole,
  roleLabel,
  isAdministratorAccount,
  moderationAuthority,
  canModerateUser,
  validateRoleChange
};

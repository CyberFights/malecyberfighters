/**
 * Roles — the tiers of trust the Administrator account assigns to members
 * through POST /api/admin/set-role. The endpoint itself is thin; the rules
 * it enforces live in roles.js and are exercised here without a server.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
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
} = require('../roles.js');

test('the catalogue carries the member tiers, lowest trust first', () => {
  assert.equal(ADMIN_USERNAME, 'Administrator');
  assert.deepEqual(ROLE_IDS, ['user', 'moderator', 'admin']);
  assert.equal(DEFAULT_ROLE, 'user');
  assert.deepEqual(ROLES.map(r => r.label), ['Member', 'Moderator', 'Admin']);
});

test('normalizeRole accepts case and whitespace variants, rejects strangers', () => {
  assert.equal(normalizeRole('Moderator'), 'moderator');
  assert.equal(normalizeRole('  admin '), 'admin');
  assert.equal(normalizeRole('USER'), 'user');
  assert.equal(normalizeRole('superuser'), null);
  assert.equal(normalizeRole(''), null);
  assert.equal(normalizeRole(null), null);
  assert.equal(normalizeRole(undefined), null);
});

test('isKnownRole agrees with the catalogue', () => {
  assert.equal(isKnownRole('moderator'), true);
  assert.equal(isKnownRole('ADMIN'), true);
  assert.equal(isKnownRole('warlord'), false);
});

test('roleLabel falls back to the default tier for unknown values', () => {
  assert.equal(roleLabel('moderator'), 'Moderator');
  assert.equal(roleLabel('ADMIN'), 'Admin');
  assert.equal(roleLabel(undefined), 'Member');
  assert.equal(roleLabel('warlord'), 'Member');
});

test('the Administrator account is matched the way the client matches it', () => {
  assert.equal(isAdministratorAccount('Administrator'), true);
  assert.equal(isAdministratorAccount(' administrator '), true);
  assert.equal(isAdministratorAccount('ADMINISTRATOR'), true);
  assert.equal(isAdministratorAccount('admin'), false);
  assert.equal(isAdministratorAccount('steve'), false);
  assert.equal(isAdministratorAccount(''), false);
});

test('isStaffRole accepts only the moderation tiers', () => {
  assert.equal(isStaffRole('moderator'), true);
  assert.equal(isStaffRole('admin'), true);
  assert.equal(isStaffRole('  Moderator '), true);
  assert.equal(isStaffRole('user'), false);
  assert.equal(isStaffRole(''), false);
  assert.equal(isStaffRole(null), false);
  assert.equal(isStaffRole('warlord'), false);
});

test('moderationAuthority ranks the ladder correctly', () => {
  assert.equal(moderationAuthority({ username: 'Administrator', role: 'user' }), 4);
  assert.equal(moderationAuthority({ username: 'rex', role: 'admin' }), 3);
  assert.equal(moderationAuthority({ username: 'rex', role: 'moderator' }), 2);
  assert.equal(moderationAuthority({ username: 'rex', role: 'user' }), 1);
  assert.equal(moderationAuthority({ username: 'rex' }), 1);
  assert.equal(moderationAuthority(null), 0);
});

test('canModerateUser enforces rank and no self-moderation', () => {
  const mod = { username: 'mod', role: 'moderator' };
  const admin = { username: 'boss', role: 'admin' };
  const member = { username: 'joe', role: 'user' };
  const root = { username: 'Administrator', role: 'user' };

  // Moderators act on plain members, not on staff peers or themselves.
  assert.equal(canModerateUser(mod, member), true);
  assert.equal(canModerateUser(mod, mod), false);
  assert.equal(canModerateUser(mod, { username: 'othermod', role: 'moderator' }), false);
  assert.equal(canModerateUser(mod, admin), false);
  assert.equal(canModerateUser(mod, root), false);

  // Admins act on members and moderators, not on other admins or the root.
  assert.equal(canModerateUser(admin, member), true);
  assert.equal(canModerateUser(admin, mod), true);
  assert.equal(canModerateUser(admin, admin), false);
  assert.equal(canModerateUser(admin, { username: 'boss2', role: 'admin' }), false);
  assert.equal(canModerateUser(admin, root), false);

  // The root account outranks everyone; nobody outranks it.
  assert.equal(canModerateUser(root, member), true);
  assert.equal(canModerateUser(root, admin), true);
  assert.equal(canModerateUser(root, root), false);

  // Plain members hold no moderation power at all.
  assert.equal(canModerateUser(member, member), false);
  assert.equal(canModerateUser(member, mod), false);
});

test('canModerateUser accepts bare username strings as plain members', () => {
  assert.equal(canModerateUser({ username: 'mod', role: 'moderator' }, 'joe'), true);
  assert.equal(canModerateUser('joe', 'jane'), false);
});

test('the Administrator account can promote a member to moderator', () => {
  const result = validateRoleChange({
    actorUsername: 'Administrator',
    targetUsername: 'jax',
    role: 'moderator'
  });
  assert.deepEqual(result, { ok: true, targetUsername: 'jax', role: 'moderator' });
});

test('the Administrator account can promote a member to admin', () => {
  const result = validateRoleChange({
    actorUsername: 'Administrator',
    targetUsername: 'jax',
    role: 'admin'
  });
  assert.equal(result.ok, true);
  assert.equal(result.role, 'admin');
});

test('roles are normalised before they are stored', () => {
  const result = validateRoleChange({
    actorUsername: 'Administrator',
    targetUsername: 'jax',
    role: ' MODERATOR '
  });
  assert.equal(result.ok, true);
  assert.equal(result.role, 'moderator');
});

test('demotion back to plain member is an assignment like any other', () => {
  const result = validateRoleChange({
    actorUsername: 'Administrator',
    targetUsername: 'jax',
    role: 'user'
  });
  assert.equal(result.ok, true);
  assert.equal(result.role, 'user');
});

test('nobody but the Administrator account hands out roles', () => {
  const result = validateRoleChange({
    actorUsername: 'randomfan',
    targetUsername: 'jax',
    role: 'admin'
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'admin_account_required');
});

test('a missing actor cannot hand out roles either', () => {
  const result = validateRoleChange({ targetUsername: 'jax', role: 'admin' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'admin_account_required');
});

test('the Administrator account itself cannot be re-roled', () => {
  const result = validateRoleChange({
    actorUsername: 'Administrator',
    targetUsername: 'Administrator',
    role: 'user'
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'cannot_modify_administrator');
});

test('roles outside the catalogue are rejected', () => {
  const result = validateRoleChange({
    actorUsername: 'Administrator',
    targetUsername: 'jax',
    role: 'superuser'
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_role');
});

test('a missing role is rejected, not defaulted', () => {
  const result = validateRoleChange({
    actorUsername: 'Administrator',
    targetUsername: 'jax'
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_role');
});

test('a nameless target is rejected before the role is even looked at', () => {
  const result = validateRoleChange({
    actorUsername: 'Administrator',
    targetUsername: '   ',
    role: 'admin'
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'missing_username');
});

test('target usernames are trimmed in the accepted change', () => {
  const result = validateRoleChange({
    actorUsername: 'Administrator',
    targetUsername: '  jax  ',
    role: 'moderator'
  });
  assert.equal(result.ok, true);
  assert.equal(result.targetUsername, 'jax');
});

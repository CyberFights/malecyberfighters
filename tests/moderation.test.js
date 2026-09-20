/**
 * Moderation — the rules behind the staff tools (warn / timeout / delete).
 * The socket handlers in index.js stay thin; everything testable lives in
 * moderation.js and roles.js, exercised here without a server.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TIMEOUT_MIN_SECONDS,
  TIMEOUT_MAX_SECONDS,
  TIMEOUT_PRESETS,
  MAX_STORED_WARNINGS,
  MAX_WARNING_REASON_LENGTH,
  normalizeTimeoutSeconds,
  validateWarning,
  validateTimeout
} = require('../moderation.js');

const MOD = { username: 'mod', role: 'moderator' };
const ADMIN = { username: 'boss', role: 'admin' };
const MEMBER = { username: 'joe', role: 'user' };

test('the preset ladder matches what the dialog offers', () => {
  assert.deepEqual(TIMEOUT_PRESETS.map(p => p.id), ['5m', '30m', '1h', '24h', '7d']);
  assert.deepEqual(
    TIMEOUT_PRESETS.map(p => p.seconds),
    [300, 1800, 3600, 86400, 604800]
  );
  assert.equal(TIMEOUT_MIN_SECONDS, 60);
  assert.equal(TIMEOUT_MAX_SECONDS, 30 * 24 * 60 * 60);
  assert.ok(MAX_STORED_WARNINGS >= 1);
  assert.ok(MAX_WARNING_REASON_LENGTH >= 50);
});

test('normalizeTimeoutSeconds parses numbers, strings and presets', () => {
  assert.equal(normalizeTimeoutSeconds(300), 300);
  assert.equal(normalizeTimeoutSeconds('600'), 600);
  assert.equal(normalizeTimeoutSeconds('1h'), 3600);
  assert.equal(normalizeTimeoutSeconds('7d'), 604800);
  assert.equal(normalizeTimeoutSeconds(90.6), 91);
});

test('normalizeTimeoutSeconds clamps to the allowed window', () => {
  assert.equal(normalizeTimeoutSeconds(5), TIMEOUT_MIN_SECONDS);          // under a minute
  assert.equal(normalizeTimeoutSeconds(10 ** 9), TIMEOUT_MAX_SECONDS);    // absurd
  assert.equal(normalizeTimeoutSeconds(TIMEOUT_MAX_SECONDS), TIMEOUT_MAX_SECONDS);
});

test('normalizeTimeoutSeconds treats 0 / lift / empty as lifting', () => {
  assert.equal(normalizeTimeoutSeconds(0), 0);
  assert.equal(normalizeTimeoutSeconds('0'), 0);
  assert.equal(normalizeTimeoutSeconds('lift'), 0);
  assert.equal(normalizeTimeoutSeconds(''), 0);
  assert.equal(normalizeTimeoutSeconds(null), 0);
  assert.equal(normalizeTimeoutSeconds(undefined), 0);
  assert.equal(normalizeTimeoutSeconds(-60), 0);
});

test('normalizeTimeoutSeconds rejects non-durations', () => {
  assert.equal(normalizeTimeoutSeconds('banana'), null);
  assert.equal(normalizeTimeoutSeconds('99x'), null);
  assert.equal(normalizeTimeoutSeconds({}), null);
  assert.equal(normalizeTimeoutSeconds(NaN), null);
  assert.equal(normalizeTimeoutSeconds(Infinity), null);
});

test('a moderator can warn a plain member', () => {
  const result = validateWarning({ actor: MOD, target: MEMBER, reason: 'keep it civil' });
  assert.deepEqual(result, { ok: true, targetUsername: 'joe', reason: 'keep it civil' });
});

test('warning reasons are optional, trimmed and capped', () => {
  assert.equal(validateWarning({ actor: MOD, target: MEMBER }).ok, true);
  assert.equal(validateWarning({ actor: MOD, target: MEMBER, reason: null }).reason, '');
  const padded = validateWarning({ actor: MOD, target: MEMBER, reason: '  spaced  ' });
  assert.equal(padded.reason, 'spaced');
  const long = validateWarning({ actor: MOD, target: MEMBER, reason: 'x'.repeat(5000) });
  assert.equal(long.reason.length, MAX_WARNING_REASON_LENGTH);
});

test('members without a staff role cannot warn anyone', () => {
  const result = validateWarning({ actor: MEMBER, target: { username: 'jane', role: 'user' }, reason: 'r' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'not_allowed');
});

test('moderators cannot warn peers, admins or the Administrator account', () => {
  assert.equal(validateWarning({ actor: MOD, target: { username: 'm2', role: 'moderator' } }).error, 'not_allowed');
  assert.equal(validateWarning({ actor: MOD, target: ADMIN }).error, 'not_allowed');
  assert.equal(validateWarning({ actor: MOD, target: { username: 'Administrator', role: 'user' } }).error, 'not_allowed');
});

test('a moderator cannot warn themselves', () => {
  const result = validateWarning({ actor: MOD, target: MOD, reason: 'r' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'not_allowed');
});

test('a nameless warning target is rejected', () => {
  const result = validateWarning({ actor: MOD, target: '   ', reason: 'r' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'missing_target');
});

test('a moderator can time out a plain member', () => {
  const result = validateTimeout({ actor: MOD, target: MEMBER, seconds: 3600 });
  assert.deepEqual(result, { ok: true, targetUsername: 'joe', seconds: 3600 });
});

test('timeouts accept presets and clamp odd values', () => {
  assert.equal(validateTimeout({ actor: MOD, target: MEMBER, seconds: '1h' }).seconds, 3600);
  assert.equal(validateTimeout({ actor: MOD, target: MEMBER, seconds: 5 }).seconds, TIMEOUT_MIN_SECONDS);
  assert.equal(validateTimeout({ actor: MOD, target: MEMBER, seconds: 10 ** 9 }).seconds, TIMEOUT_MAX_SECONDS);
});

test('lifting a timeout is a valid moderation action with the same authority rules', () => {
  const lifted = validateTimeout({ actor: MOD, target: MEMBER, seconds: 0 });
  assert.deepEqual(lifted, { ok: true, targetUsername: 'joe', seconds: 0 });
  assert.equal(validateTimeout({ actor: MEMBER, target: MEMBER, seconds: 0 }).error, 'not_allowed');
});

test('timeouts respect the authority ladder', () => {
  assert.equal(validateTimeout({ actor: MOD, target: ADMIN, seconds: 60 }).error, 'not_allowed');
  assert.equal(validateTimeout({ actor: MOD, target: { username: 'Administrator' }, seconds: 60 }).error, 'not_allowed');
  assert.equal(validateTimeout({ actor: ADMIN, target: MOD, seconds: 60 }).ok, true);
  assert.equal(validateTimeout({ actor: ADMIN, target: { username: 'Administrator' }, seconds: 60 }).error, 'not_allowed');
});

test('a non-duration timeout is rejected', () => {
  const result = validateTimeout({ actor: MOD, target: MEMBER, seconds: 'whenever' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_duration');
});

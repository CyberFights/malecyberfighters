/**
 * Notification preferences + quiet hours — the gate every push passes
 * through. A kind switched off stops that kind; a quiet window stops
 * everything inside it; both are answered without touching push plumbing.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  KINDS, normalizePrefs, normalizeQuietHours, effectivePrefs,
  effectiveQuietHours, hourIsQuiet, shouldPush
} = require('../notificationPrefs.js');

test('normalizePrefs keeps only the known kinds, missing ones keep defaults', () => {
  const result = normalizePrefs({ dm: false, mention: true, nonsense: true });
  assert.equal(result.ok, true);
  assert.deepEqual(result.prefs, { ...KINDS, dm: false });
});

test('normalizePrefs rejects non-boolean values', () => {
  assert.equal(normalizePrefs({ dm: 'nope' }).error, 'invalid_prefs');
  assert.equal(normalizePrefs('everything').error, 'invalid_prefs');
});

test('quiet hours normalize whole hours 0–23', () => {
  const result = normalizeQuietHours({ enabled: true, start: 22, end: 8 });
  assert.deepEqual(result.quiet, { enabled: true, start: 22, end: 8 });

  assert.equal(normalizeQuietHours({ enabled: true, start: 24, end: 8 }).error, 'invalid_quiet_hours');
  assert.equal(normalizeQuietHours({ enabled: true, start: 'nine', end: 8 }).error, 'invalid_quiet_hours');
  assert.equal(normalizeQuietHours({ enabled: true, start: 9.5, end: 8 }).error, 'invalid_quiet_hours');
});

test('an absent quiet-hours payload means "no quiet window"', () => {
  const result = normalizeQuietHours({});
  assert.deepEqual(result.quiet, { enabled: false, start: 22, end: 8 });
});

test('effectivePrefs / effectiveQuietHours fill defaults for missing storage', () => {
  assert.deepEqual(effectivePrefs({}), { ...KINDS });
  assert.deepEqual(effectiveQuietHours({}), { enabled: false, start: 22, end: 8 });
});

test('a quiet window that crosses midnight covers 22:00 through 07:59', () => {
  const window = { start: 22, end: 8 };
  [22, 23, 0, 5, 7].forEach(hour => assert.equal(hourIsQuiet(hour, window), true, `${hour}:00 quiet`));
  [8, 12, 21].forEach(hour => assert.equal(hourIsQuiet(hour, window), false, `${hour}:00 not quiet`));
});

test('a same-day window covers its start but not its end', () => {
  const window = { start: 1, end: 5 };
  [1, 2, 4].forEach(hour => assert.equal(hourIsQuiet(hour, window), true));
  [0, 5, 6].forEach(hour => assert.equal(hourIsQuiet(hour, window), false));
});

test('shouldPush passes a plain notification outside quiet hours', () => {
  assert.equal(shouldPush({ kind: 'dm', user: {}, now: new Date('2026-09-19T14:00:00') }), true);
});

test('a kind switched off stops that kind only', () => {
  const user = { notificationPrefs: { ...KINDS, mention: false } };
  assert.equal(shouldPush({ kind: 'mention', user, now: new Date('2026-09-19T14:00:00') }), false);
  assert.equal(shouldPush({ kind: 'dm', user, now: new Date('2026-09-19T14:00:00') }), true);
});

test('quiet hours stop every kind inside the window', () => {
  const user = { quietHours: { enabled: true, start: 22, end: 8 } };
  ['dm', 'mention', 'match', 'challenge'].forEach(kind => {
    assert.equal(shouldPush({ kind, user, now: new Date('2026-09-19T23:30:00') }), false, kind);
  });
  assert.equal(shouldPush({ kind: 'dm', user, now: new Date('2026-09-19T12:00:00') }), true);
});

test('an unknown kind defaults to allowed — new pushes must not be swallowed', () => {
  assert.equal(shouldPush({ kind: 'future_kind', user: {}, now: new Date('2026-09-19T14:00:00') }), true);
});
